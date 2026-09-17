import { EventEmitter } from 'events';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresGenerationAdmission } from '../PostgresGenerationAdmission';

class FakeClient extends EventEmitter {
  query = vi.fn().mockResolvedValue({ rows: [{ acquired: true }] });
  release = vi.fn();
}
const key = 'fixture-key';
const model = 'fixture-model';

function fixture(client = new FakeClient()) {
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  // Only the connect method is consumed; this is a fixture, never an application DB.
  return { client, pool, admission: new PostgresGenerationAdmission(pool as unknown as Pool, key, model, 1, 1) };
}

describe('PostgreSQL generation admission', () => {
  it('coordinates identical account/model slots across instances and never sends the key as a SQL argument', async () => {
    const first = fixture(); const second = fixture();
    const a = await first.admission.acquire(new AbortController().signal);
    const b = await second.admission.acquire(new AbortController().signal);
    expect(first.client.query.mock.calls[0][0]).toEqual(second.client.query.mock.calls[0][0]);
    const lock = first.client.query.mock.calls[0][0];
    expect(lock.text).toContain('pg_try_advisory_lock');
    expect(lock.values[0]).toMatch(/^-?\d+$/);
    expect(JSON.stringify(lock)).not.toContain(key);
    await a.release(); await a.release(); await b.release();
    expect(first.client.query).toHaveBeenCalledTimes(2);
    expect(first.client.query.mock.calls[1][0].text).toContain('pg_advisory_unlock');
    expect(first.client.release).toHaveBeenCalledOnce();
    expect(first.client.release).toHaveBeenCalledWith(false);
  });

  it('destroys an uncertain connection when unlock fails', async () => {
    const { client, admission } = fixture();
    const lease = await admission.acquire(new AbortController().signal);
    client.query.mockRejectedValueOnce(new Error('private database details'));
    await lease.release();
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('signals connection loss to cancel its model request', async () => {
    const { client, admission } = fixture();
    const lease = await admission.acquire(new AbortController().signal);
    client.emit('error', new Error('connection failed'));
    expect(lease.signal?.aborted).toBe(true);
    await lease.release();
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('releases a connection arriving after cancellation without taking a lock', async () => {
    const client = new FakeClient();
    let finish!: (client: FakeClient) => void;
    const pool = { connect: () => new Promise<FakeClient>(resolve => { finish = resolve; }) };
    const admission = new PostgresGenerationAdmission(pool as unknown as Pool, key, model, 1, 1);
    const controller = new AbortController();
    const pending = admission.acquire(controller.signal);
    // acquire first yields to local admission before it requests a pool connection.
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    finish(client);
    await Promise.resolve();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('waits without spinning when another instance owns the slot, then honors cancellation', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient(); client.query.mockResolvedValue({ rows: [{ acquired: false }] });
      const { admission } = fixture(client);
      const controller = new AbortController();
      const pending = admission.acquire(controller.signal);
      const check = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      await vi.advanceTimersByTimeAsync(500);
      expect(client.query.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(client.query.mock.calls.length).toBeLessThanOrEqual(3);
      controller.abort(); await check;
      expect(client.release).toHaveBeenCalledOnce();
      expect(client.release).toHaveBeenCalledWith(true);
    } finally { vi.useRealTimers(); }
  });

  it('sanitizes database failures and releases its local slot for retry', async () => {
    const { client, admission } = fixture();
    client.query.mockRejectedValueOnce(new Error('private database details'));
    await expect(admission.acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' });
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    const next = await admission.acquire(new AbortController().signal);
    await next.release();
  });
});
