import { randomUUID } from 'crypto';
import { AutoTokenizer } from '@xenova/transformers';
import { pool } from '../../config/database';
import { EMBEDDING_CONFIG } from '../../config/constants';
import { MATERIAL_INGESTION as config } from '../../config/materialIngestion';
import { downloadImmutableFile } from '../../config/storage';
import { extractTextFromFile, ProcessedDocument, DocumentChunk } from '../documentProcessor';
import { generateEmbeddings, embeddingToPostgresVector } from '../embeddingService';
import { hashAttachment, reconcileUploadIntents } from './ingestion';
import { getEmbeddingSpaceId, MATERIAL_PIPELINE_VERSION } from './embeddingSpace';
import { validateMaterialFile } from './fileValidation';

export interface IngestionJob { id: string; run_id: string; lease_token: string; attempts: number; max_attempts: number; }
export class LeaseLostError extends Error { constructor() { super('Ingestion lease lost'); } }
export class ReviewRequiredError extends Error {}

export function validateExtraction(document: ProcessedDocument): void {
  const partialNativePdf = document.metadata.extraction_method === 'pdf-parse' &&
    document.metadata.text_coverage === 'partial' && Boolean(document.metadata.review_pages?.length);
  if (document.metadata.error || (document.metadata.extraction_degraded && !partialNativePdf) || !document.content_text.trim() || !document.content_chunks.length) {
    throw new ReviewRequiredError('Native text extraction is incomplete or unreadable; OCR is disabled');
  }
  if (document.content_chunks.length > config.maxChunks) throw new ReviewRequiredError('Material exceeds the chunk limit');
}

let tokenizerPromise: ReturnType<typeof AutoTokenizer.from_pretrained> | undefined;
async function tokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = AutoTokenizer.from_pretrained(EMBEDDING_CONFIG.MODEL_ID, { revision: EMBEDDING_CONFIG.MODEL_REVISION });
    tokenizerPromise.catch(() => { tokenizerPromise = undefined; });
  }
  return tokenizerPromise;
}

/** Hard tokenizer budget, exact text slices, preserving native page/section offsets. */
export async function boundChunks(chunks: DocumentChunk[], countTokens?: (text: string) => number): Promise<Array<{text: string; locator: Record<string, unknown>; tokenCount: number}>> {
  const model = countTokens ? null : await tokenizer();
  const count = countTokens ?? ((text: string) => model!.encode(text, null, {add_special_tokens: false}).length);
  const result: Array<{text: string; locator: Record<string, unknown>; tokenCount: number}> = [];
  for (const chunk of chunks) {
    let start = 0;
    while (start < chunk.text.length) {
      let end = chunk.text.length;
      if (count(chunk.text.slice(start, end)) > config.maxChunkTokens) {
        let low = start + 1, high = end;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (count(chunk.text.slice(start, middle)) <= config.maxChunkTokens) low = middle;
          else high = middle - 1;
        }
        end = low;
        const boundary = chunk.text.lastIndexOf(' ', end);
        if (boundary > start + (end - start) / 2) end = boundary;
      }
      const text = chunk.text.slice(start, end);
      const tokenCount = count(text);
      if (!text.trim() || tokenCount > config.maxChunkTokens) throw new ReviewRequiredError('Cannot establish a bounded text passage');
      result.push({text, tokenCount, locator: {
        ...(typeof chunk.metadata.page_number === 'number' ? {page: chunk.metadata.page_number} : {}),
        ...(chunk.metadata.section ? {section: chunk.metadata.section} : {}),
        kind: typeof chunk.metadata.page_number === 'number' ? 'pdf_page' : chunk.metadata.locator_kind ?? 'extracted_text',
        start: (chunk.metadata.start_char ?? 0) + start, end: (chunk.metadata.start_char ?? 0) + end,
      }});
      if (result.length > config.maxChunks) throw new ReviewRequiredError('Material exceeds the chunk limit');
      if (end === chunk.text.length) break;
      // The extraction already overlaps adjacent chunks. Subdivision overlaps by
      // a tokenizer-limited suffix and always makes progress.
      let overlapStart = end;
      while (overlapStart > start && count(chunk.text.slice(overlapStart - 1, end)) <= config.chunkOverlapTokens) overlapStart--;
      start = Math.max(start + 1, overlapStart);
    }
  }
  return result;
}

export const CLAIM_JOB_SQL = `WITH candidate AS (
 SELECT j.id FROM ingestion_jobs j JOIN material_index_runs r ON r.id=j.run_id
 JOIN material_versions v ON v.id=r.version_id JOIN course_materials m ON m.id=v.material_id
 WHERE m.deleted_at IS NULL AND r.status IN ('queued','processing') AND j.attempts<j.max_attempts
 AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='processing' AND j.lease_until<now()))
 ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1
) UPDATE ingestion_jobs j SET status='processing',attempts=j.attempts+1,lease_owner=$1,
 lease_token=$2,lease_until=now()+$3*interval '1 second',updated_at=now()
 FROM candidate WHERE j.id=candidate.id RETURNING j.*`;

export async function claimJob(owner: string): Promise<IngestionJob | null> {
  // A crash on the last attempt still reaches a terminal state on restart.
  const expired = await pool.query(`UPDATE ingestion_jobs SET status='failed',error='Retry limit reached after worker interruption',updated_at=now()
    WHERE status='processing' AND lease_until<now() AND attempts>=max_attempts RETURNING run_id`);
  for (const job of expired.rows) {
    await pool.query(`UPDATE material_index_runs SET status='failed',error='Retry limit reached after worker interruption',completed_at=now() WHERE id=$1 AND status!='published'`, [job.run_id]);
    await pool.query(`UPDATE course_materials m SET ingestion_status='failed',ingestion_error='Retry limit reached after worker interruption'
      WHERE id=(SELECT v.material_id FROM material_versions v JOIN material_index_runs r ON r.version_id=v.id WHERE r.id=$1) AND deleted_at IS NULL
      AND $1=(SELECT r.id FROM material_index_runs r JOIN material_versions v ON v.id=r.version_id WHERE v.material_id=m.id ORDER BY v.created_at DESC,v.id DESC,r.created_at DESC,r.id DESC LIMIT 1)`, [job.run_id]);
  }
  const result = await pool.query(CLAIM_JOB_SQL, [owner, randomUUID(), config.leaseSeconds]);
  return result.rows[0] ?? null;
}

export async function heartbeat(job: IngestionJob): Promise<boolean> {
  const result = await pool.query(`UPDATE ingestion_jobs SET lease_until=now()+$3*interval '1 second',updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>now()`, [job.id, job.lease_token, config.leaseSeconds]);
  return Boolean(result.rowCount);
}

export async function processJob(job: IngestionJob): Promise<void> {
  let lost = false, heartbeatRunning = false;
  const timer = setInterval(async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try { if (!await heartbeat(job)) lost = true; } catch { lost = true; }
    finally { heartbeatRunning = false; }
  }, config.heartbeatSeconds * 1000);
  timer.unref();
  const assertLease = () => { if (lost) throw new LeaseLostError(); };
  try {
    const versionResult = await pool.query(`SELECT v.*,m.course_id,m.deleted_at,r.embedding_space_id,r.pipeline_version
      FROM material_index_runs r JOIN material_versions v ON v.id=r.version_id
      JOIN course_materials m ON m.id=v.material_id WHERE r.id=$1`, [job.run_id]);
    const version = versionResult.rows[0];
    if (!version || version.deleted_at) throw new ReviewRequiredError('Material was deleted');
    if (version.embedding_space_id !== getEmbeddingSpaceId()) throw new ReviewRequiredError('Embedding configuration changed; enqueue a new space before indexing');
    if (version.pipeline_version !== MATERIAL_PIPELINE_VERSION) throw new ReviewRequiredError('Native extraction configuration changed; enqueue the current pipeline before indexing');
    await pool.query(`UPDATE material_index_runs SET status='processing' WHERE id=$1 AND status='queued'
      AND EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=$2 AND lease_token=$3 AND status='processing' AND lease_until>now())`, [job.run_id,job.id,job.lease_token]);
    await pool.query(`UPDATE course_materials SET ingestion_status='processing',ingestion_error=NULL WHERE id=$1 AND deleted_at IS NULL
      AND $2=(SELECT id FROM material_versions WHERE material_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1)
      AND $5=(SELECT r.id FROM material_index_runs r WHERE r.version_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 1)
      AND EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=$3 AND lease_token=$4 AND status='processing' AND lease_until>now())`, [version.material_id,version.id,job.id,job.lease_token,job.run_id]);
    const buffer = await downloadImmutableFile(version.object_name, version.object_generation, config.maxBytes);
    if (hashAttachment(buffer) !== version.sha256) throw new ReviewRequiredError('Attachment integrity mismatch');
    try { validateMaterialFile(buffer, version.original_filename, version.mime_type); }
    catch { throw new ReviewRequiredError('Attachment format validation failed'); }
    assertLease();
    const document = await extractTextFromFile(buffer, version.original_filename, version.mime_type);
    validateExtraction(document);
    const chunks = await boundChunks(document.content_chunks);
    const vectors: number[][] = [];
    for (let first = 0; first < chunks.length; first += config.embeddingBatch) {
      assertLease();
      vectors.push(...await generateEmbeddings(chunks.slice(first, first + config.embeddingBatch).map(c => c.text), config.embeddingBatch));
    }
    if (vectors.length !== chunks.length || vectors.some(v => v.length !== 768 || v.some(n => !Number.isFinite(n)))) {
      throw new ReviewRequiredError('Embedding validation failed');
    }
    assertLease();
    await publishJob(job, version, document, chunks, vectors);
  } catch (error) {
    if (!(error instanceof LeaseLostError)) await failJob(job, error instanceof ReviewRequiredError);
  } finally { clearInterval(timer); }
}

/** Fencing and publication are one transaction; stale workers cannot modify chunks. */
export async function publishJob(job: IngestionJob, version: any, document: ProcessedDocument,
  chunks: Array<{text: string; locator: Record<string, unknown>; tokenCount: number}>, vectors: number[][]): Promise<void> {
  validateExtraction(document);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lease = await client.query(`SELECT id FROM ingestion_jobs WHERE id=$1 AND lease_token=$2
      AND status='processing' AND lease_until>now() FOR UPDATE`, [job.id, job.lease_token]);
    if (!lease.rowCount) throw new LeaseLostError();
    const material = await client.query('SELECT id,deleted_at,published_run_id FROM course_materials WHERE id=$1 FOR UPDATE', [version.material_id]);
    if (!material.rowCount || material.rows[0].deleted_at) throw new ReviewRequiredError('Material was deleted');
    if (!chunks.length || vectors.length !== chunks.length || vectors.some(v => v.length !== 768 || v.some(n => !Number.isFinite(n)))) {
      throw new ReviewRequiredError('Candidate index is incomplete');
    }
    await client.query('DELETE FROM material_pages WHERE run_id=$1', [job.run_id]);
    // There should be no staged rows in this implementation; never destroy an old published run.
    const prior = await client.query('SELECT status FROM material_index_runs WHERE id=$1 FOR UPDATE', [job.run_id]);
    if (prior.rows[0]?.status === 'published') throw new LeaseLostError();
    for (const [index, page] of (document.metadata.pages ?? [{text: document.content_text, locator: {kind: 'extracted_text'}}]).entries()) {
      await client.query('INSERT INTO material_pages(run_id,ordinal,text,locator) VALUES($1,$2,$3,$4)', [job.run_id, index + 1, page.text, JSON.stringify(page.locator)]);
    }
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index], id = randomUUID();
      await client.query(`INSERT INTO material_chunks(id,run_id,material_id,course_id,text,locator,token_count)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, job.run_id, version.material_id, version.course_id, chunk.text, JSON.stringify(chunk.locator), chunk.tokenCount]);
      await client.query('INSERT INTO chunk_embeddings(chunk_id,embedding_space_id,embedding) VALUES($1,$2,$3::vector)', [id, version.embedding_space_id, embeddingToPostgresVector(vectors[index])]);
    }
    const warning = document.metadata.text_coverage === 'partial'
      ? `Extracted text is indexed. Image content or unreadable text may be missing on pages ${document.metadata.review_pages!.join(', ')}. OCR is disabled.` : null;
    const metadata = {...document.metadata, pages: undefined, coverage_warning: warning};
    await client.query(`UPDATE material_index_runs SET status='published',metadata=$2,error=NULL,completed_at=now() WHERE id=$1`, [job.run_id, JSON.stringify(metadata)]);
    // A newer version must never be replaced by a slow older version's worker.
    const latest = await client.query(`SELECT id FROM material_versions WHERE material_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [version.material_id]);
    const latestRun = await client.query('SELECT id FROM material_index_runs WHERE version_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [version.id]);
    if (latest.rows[0]?.id === version.id && latestRun.rows[0]?.id === job.run_id) {
      await client.query(`UPDATE course_materials SET published_run_id=$2,ingestion_status='ready',ingestion_error=NULL,ingestion_warning=$3 WHERE id=$1`, [version.material_id, job.run_id, warning]);
    }
    await client.query(`UPDATE ingestion_jobs SET status='complete',lease_until=NULL,error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function failJob(job: IngestionJob, needsReview: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lease = await client.query(`SELECT id FROM ingestion_jobs WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>now() FOR UPDATE`, [job.id, job.lease_token]);
    if (!lease.rowCount) { await client.query('ROLLBACK'); return; }
    const status = needsReview ? 'needs_review' : job.attempts >= job.max_attempts ? 'failed' : 'queued';
    const message = needsReview ? 'Native extraction requires review; OCR is disabled' : status === 'failed' ? 'Indexing failed after bounded retries' : 'Indexing interrupted; retry scheduled';
    await client.query(`UPDATE ingestion_jobs SET status=$3,error=$4,lease_until=NULL,available_at=now()+$5*interval '1 second',updated_at=now() WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, status, message, Math.min(60, 2 ** job.attempts)]);
    await client.query('UPDATE material_index_runs SET status=$2,error=$3 WHERE id=$1 AND status!=\'published\'', [job.run_id, status, message]);
    await client.query(`UPDATE course_materials m SET ingestion_status=$2,ingestion_error=$3
      WHERE id=(SELECT v.material_id FROM material_versions v JOIN material_index_runs r ON r.version_id=v.id WHERE r.id=$1) AND deleted_at IS NULL
      AND $1=(SELECT r.id FROM material_index_runs r JOIN material_versions v ON v.id=r.version_id WHERE v.material_id=m.id ORDER BY v.created_at DESC,v.id DESC,r.created_at DESC,r.id DESC LIMIT 1)`, [job.run_id, status, message]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function runIngestionWorker(signal: AbortSignal): Promise<void> {
  const owner = `${process.pid}-${randomUUID()}`;
  let lastReconciliation = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() - lastReconciliation > 60000) { await reconcileUploadIntents(); lastReconciliation = Date.now(); }
      const job = await claimJob(owner);
      if (job) { await processJob(job); continue; }
    } catch { console.error('Material worker iteration failed; retrying without attachment details'); }
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, config.pollMs);
      signal.addEventListener('abort', finish, {once: true});
    });
  }
}
