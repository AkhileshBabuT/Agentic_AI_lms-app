import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { abortableDelay, GenerationAdmission, GenerationLease, GenerationProviderError,
  LocalGenerationAdmission } from './VtArcGenerationProvider';

/**
 * Dedicated PostgreSQL session advisory locks coordinate provider concurrency across
 * replicas. No boot migration is needed. Connection loss releases the lock and cancels
 * its request. All replicas must use the same concurrency limit and database.
 * Keep a pool connection available per active generation, in addition to normal queries.
 */
export class PostgresGenerationAdmission implements GenerationAdmission {
  private readonly local: LocalGenerationAdmission;
  private readonly keys: string[];

  constructor(private readonly pool: Pool, apiKey: string, model: string,
    concurrency: number, maxQueue: number) {
    this.local = new LocalGenerationAdmission(concurrency, maxQueue);
    this.keys = Array.from({ length: concurrency }, (_, slot) =>
      createHash('sha256').update(`course-rag-v1\0${apiKey}\0${model}\0${slot}`).digest().readBigInt64BE().toString());
  }

  async acquire(signal: AbortSignal): Promise<GenerationLease> {
    const localLease = await this.local.acquire(signal);
    let client: PoolClient | undefined;
    let key: string | undefined;
    const lost = new AbortController();
    const onError = () => lost.abort();
    try {
      client = await this.connect(signal);
      client.on('error', onError);
      while (!key) {
        if (lost.signal.aborted) throw new GenerationProviderError('unavailable');
        if (signal.aborted) throw new GenerationProviderError('cancelled');
        for (const candidate of this.keys) {
          // node-postgres supports per-query timeout; its QueryConfig typings omit it.
          const lockQuery = {
            text: 'SELECT pg_try_advisory_lock($1::bigint) AS acquired', values: [candidate], query_timeout: 1000,
          };
          const result = await client.query(lockQuery);
          if (result.rows[0]?.acquired === true) { key = candidate; break; }
        }
        if (!key) await abortableDelay(250, signal);
      }
      let released = false;
      return { signal: lost.signal, release: async () => {
        if (released) return;
        released = true;
        let destroy = lost.signal.aborted;
        try {
          if (!destroy) {
            const unlockQuery = { text: 'SELECT pg_advisory_unlock($1::bigint)', values: [key], query_timeout: 1000 };
            await client!.query(unlockQuery);
          }
        } catch { destroy = true; }
        finally {
          client!.removeListener('error', onError);
          client!.release(destroy);
          localLease.release();
        }
      } };
    } catch {
      if (client) { client.removeListener('error', onError); client.release(true); }
      localLease.release();
      throw new GenerationProviderError(signal.aborted ? 'cancelled' : 'unavailable');
    }
  }

  private connect(signal: AbortSignal): Promise<PoolClient> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new GenerationProviderError('cancelled')); return; }
      let cancelled = false;
      const onAbort = () => { cancelled = true; reject(new GenerationProviderError('cancelled')); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pool.connect().then(client => {
        signal.removeEventListener('abort', onAbort);
        if (cancelled) client.release(); else resolve(client);
      }, () => {
        signal.removeEventListener('abort', onAbort);
        reject(new GenerationProviderError('unavailable'));
      });
    });
  }
}
