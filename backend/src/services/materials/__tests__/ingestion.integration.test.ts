import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';

const state = vi.hoisted(() => ({pool: undefined as any, downloaded: Buffer.from('%PDF-1.4\nCourse title'),healthy: false}));
vi.mock('../../../config/database', () => ({pool: new Proxy({}, {get: (_target, property) => {
  const value = state.pool[property]; return typeof value === 'function' ? value.bind(state.pool) : value;
}})}));
vi.mock('../../../config/storage', () => ({downloadImmutableFile: vi.fn(async () => state.downloaded),
  uploadImmutableFile: vi.fn(async () => {throw new Error('Interrupted upload response');}),
  getFileMetadata: vi.fn(async () => ({generation: '42',size: state.downloaded.length}))}));
vi.mock('@xenova/transformers', () => ({AutoTokenizer: {from_pretrained: vi.fn(async () => ({encode: (text: string) => text.split(/\s+/).filter(Boolean)}))}}));
vi.mock('../../embeddingService', () => ({generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.01))),
  embeddingToPostgresVector: (vector: number[]) => JSON.stringify(vector)}));
vi.mock('../../documentProcessor', () => ({extractTextFromFile: vi.fn(async () => state.healthy ? {
  content_text: 'Course title',content_chunks: [{chunk_id: 'a',text: 'Course title',metadata: {chunk_index: 0,page_number: 1,start_char: 0,end_char: 12}}],
  metadata: {extraction_method: 'pdf-parse',extraction_date: new Date().toISOString()},
} : ({content_text: 'partial',content_chunks: [], metadata: {extraction_method: 'pdf-parse',extraction_degraded: true,extraction_date: new Date().toISOString()}}))}));
import { claimJob, heartbeat, publishJob, processJob, LeaseLostError, ReviewRequiredError } from '../ingestionWorker';
import { getEmbeddingSpaceId, MATERIAL_PIPELINE_VERSION } from '../embeddingSpace';
import { hashAttachment, queueMaterialUpload, reconcileUploadIntents } from '../ingestion';
import { retryMaterialIngestion } from '../retryIngestion';

const testUrl = process.env.RAG_TEST_DATABASE_URL;
const schema = `rag_ingestion_test_${process.pid}`;
const suite = testUrl ? describe : describe.skip;
suite('material ingestion with PostgreSQL/pgvector', () => {
  let admin: Pool;
  const migration = readFileSync(path.resolve(__dirname, '../../../db/migrations/material-ingestion-schema.sql'), 'utf8');
  beforeAll(async () => {
    if (!testUrl || !/^postgresql:\/\/rag_test@127\.0\.0\.1:55432\/rag_test$/.test(testUrl)) throw new Error('Use the isolated local RAG test database only');
    admin = new Pool({connectionString: testUrl});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    state.pool = new Pool({connectionString: testUrl, options: `-c search_path=${schema},public`});
    await state.pool.query(`CREATE TABLE courses(id INTEGER PRIMARY KEY);
      CREATE TABLE users(id INTEGER PRIMARY KEY);
      CREATE TABLE material_folders(id INTEGER PRIMARY KEY,course_id INTEGER REFERENCES courses(id));
      CREATE TABLE course_instructors(user_id INTEGER REFERENCES users(id),course_id INTEGER REFERENCES courses(id));
      CREATE TABLE course_materials(id SERIAL PRIMARY KEY,course_id INTEGER REFERENCES courses(id),file_name TEXT,file_path TEXT,file_size BIGINT,file_type TEXT,uploaded_by INTEGER,folder_id INTEGER);
      INSERT INTO courses VALUES(1); INSERT INTO users VALUES(1); INSERT INTO course_instructors VALUES(1,1);`);
    await state.pool.query(migration);
  });
  afterAll(async () => {
    await state.pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    state.healthy = false;
    state.downloaded = Buffer.from('%PDF-1.4\nCourse title');
    await state.pool.query(`TRUNCATE material_upload_intents,ingestion_jobs,chunk_embeddings,material_chunks,material_pages,
      material_index_runs,material_versions,course_materials CASCADE`);
    await state.pool.query("INSERT INTO course_materials(id,course_id) VALUES(1,1); SELECT setval(pg_get_serial_sequence('course_materials','id'),1)");
  });
  async function seed(status = 'queued', leaseToken = randomUUID(), attempts = 0, leaseExpired = false) {
    const versionId = randomUUID(), runId = randomUUID(), jobId = randomUUID();
    await state.pool.query(`INSERT INTO material_versions(id,material_id,object_name,object_generation,sha256,mime_type,byte_count,original_filename)
      VALUES($1,1,$2,'42',$3,'application/pdf',12,'title.pdf')`, [versionId, versionId, hashAttachment(state.downloaded)]);
    await state.pool.query(`INSERT INTO material_index_runs(id,version_id,embedding_space_id,pipeline_version,status)
      VALUES($1,$2,$3,$4,$5)`, [runId, versionId, getEmbeddingSpaceId(), MATERIAL_PIPELINE_VERSION, status]);
    await state.pool.query(`INSERT INTO ingestion_jobs(id,run_id,status,lease_token,lease_until,attempts)
      VALUES($1,$2,$3,$4,now()+$5*interval '1 second',$6)`, [jobId,runId,status,leaseToken,leaseExpired ? -10 : 120,attempts]);
    return {job: {id: jobId,run_id: runId,lease_token: leaseToken,attempts,max_attempts: 3},
      version: {id: versionId,material_id: 1,course_id: 1,embedding_space_id: getEmbeddingSpaceId()}};
  }
  const document = {content_text: 'Native title',content_chunks: [{chunk_id: 'a',text: 'Native title',metadata: {chunk_index: 0,page_number: 1}}],
    metadata: {extraction_method: 'pdf-parse' as const,extraction_date: new Date().toISOString(),pages: [{text: 'Native title',locator: {page: 1}}]}};
  const chunks = [{text: 'Native title',locator: {page: 1,kind: 'pdf_page',start: 0,end: 12},tokenCount: 2}];
  const vectors = [Array(768).fill(0.01)];

  it('applies the additive migration twice without dropping legacy/material data', async () => {
    await state.pool.query(migration);
    expect((await state.pool.query('SELECT count(*)::integer AS count FROM course_materials')).rows[0].count).toBe(1);
  });
  it('claims exactly once and recovers an expired lease with a new fencing token', async () => {
    const seeded = await seed();
    const claims = await Promise.all([claimJob('worker-a'),claimJob('worker-b')]);
    const job = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(job.attempts).toBe(1);
    await state.pool.query("UPDATE ingestion_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [seeded.job.id]);
    expect(await heartbeat(job)).toBe(false);
    const recovered = await claimJob('worker-c');
    expect(recovered?.attempts).toBe(2);
    expect(recovered?.lease_token).not.toBe(job.lease_token);
  });
  it('makes an interrupted final attempt terminal on restart', async () => {
    const seeded = await seed('processing',randomUUID(),3,true);
    expect(await claimJob('worker-a')).toBeNull();
    expect((await state.pool.query('SELECT status FROM ingestion_jobs WHERE id=$1', [seeded.job.id])).rows[0].status).toBe('failed');
    expect((await state.pool.query('SELECT ingestion_status FROM course_materials WHERE id=1')).rows[0].ingestion_status).toBe('failed');
  });
  it('rejects stale publication without writing any evidence', async () => {
    const {job,version} = await seed('processing');
    await state.pool.query('UPDATE ingestion_jobs SET lease_token=$2 WHERE id=$1', [job.id,randomUUID()]);
    await expect(publishJob(job,version,document,chunks,vectors)).rejects.toThrow(LeaseLostError);
    expect((await state.pool.query('SELECT count(*)::integer AS count FROM material_chunks')).rows[0].count).toBe(0);
  });
  it('validates embeddings before switching publication and commits provenance together', async () => {
    const {job,version} = await seed('processing');
    await expect(publishJob(job,version,document,chunks,[[0.1]])).rejects.toThrow(ReviewRequiredError);
    expect((await state.pool.query('SELECT published_run_id FROM course_materials')).rows[0].published_run_id).toBeNull();
    await publishJob(job,version,document,chunks,vectors);
    const material = (await state.pool.query('SELECT * FROM course_materials')).rows[0];
    expect(material.published_run_id).toBe(job.run_id);
    expect(material.ingestion_status).toBe('ready');
    const evidence = (await state.pool.query('SELECT c.*,v.object_generation FROM material_chunks c JOIN material_index_runs r ON r.id=c.run_id JOIN material_versions v ON v.id=r.version_id')).rows[0];
    expect(evidence.locator.page).toBe(1);
    expect(evidence.text).toBe('Native title');
    expect(evidence.object_generation).toBe('42');
    expect((await state.pool.query('SELECT count(*)::integer AS count FROM chunk_embeddings')).rows[0].count).toBe(1);
  });
  it('retains the previous published version when OCR-disabled extraction requires review', async () => {
    const old = await seed('processing');
    await publishJob(old.job,old.version,document,chunks,vectors);
    const next = await seed('processing',randomUUID(),1);
    await processJob(next.job);
    const material = (await state.pool.query('SELECT * FROM course_materials')).rows[0];
    expect(material.published_run_id).toBe(old.job.run_id);
    expect(material.ingestion_status).toBe('needs_review');
    expect((await state.pool.query('SELECT count(*)::integer AS count FROM material_chunks')).rows[0].count).toBe(1);
  });
  it('publishes usable native PDF text atomically with explicit coverage warnings', async () => {
    const {job,version} = await seed('processing');
    const partial = {...document,metadata: {...document.metadata,text_coverage: 'partial' as const,
      extraction_degraded: true,review_pages: [2],page_count: 2}};
    await publishJob(job,version,partial,chunks,vectors);
    const material = (await state.pool.query('SELECT * FROM course_materials WHERE id=1')).rows[0];
    expect(material.ingestion_status).toBe('ready');
    expect(material.published_run_id).toBe(job.run_id);
    expect(material.ingestion_warning).toContain('pages 2');
    const run = (await state.pool.query('SELECT metadata FROM material_index_runs WHERE id=$1', [job.run_id])).rows[0];
    expect(run.metadata.text_coverage).toBe('partial');
    expect(run.metadata.coverage_warning).toBe(material.ingestion_warning);
    expect((await state.pool.query('SELECT count(*)::int AS count FROM chunk_embeddings')).rows[0].count).toBe(1);
  });
  it('cannot publish a material deleted during extraction', async () => {
    const {job,version} = await seed('processing');
    await state.pool.query('UPDATE course_materials SET deleted_at=now() WHERE id=1');
    await expect(publishJob(job,version,document,chunks,vectors)).rejects.toThrow(ReviewRequiredError);
    expect((await state.pool.query('SELECT count(*)::integer AS count FROM material_chunks')).rows[0].count).toBe(0);
  });
  it('processes a claimed native job into one published index', async () => {
    state.healthy = true;
    const seeded = await seed();
    const job = await claimJob('native-worker');
    await processJob(job!);
    const material = (await state.pool.query('SELECT * FROM course_materials WHERE id=1')).rows[0];
    expect(material.ingestion_status).toBe('ready');
    expect(material.published_run_id).toBe(seeded.job.run_id);
    expect((await state.pool.query('SELECT status FROM ingestion_jobs')).rows[0].status).toBe('complete');
  });
  it('reconciles an ambiguous upload from its durable intent without duplicating jobs', async () => {
    state.downloaded = Buffer.from('Readable course attachment');
    const material = await queueMaterialUpload({courseId: 1,userId: 1,folderId: null,file: {
      buffer: state.downloaded,size: state.downloaded.length,originalname: 'course.txt',mimetype: 'text/plain',
    } as Express.Multer.File});
    expect(material.ingestion_status).toBe('upload_failed');
    expect((await state.pool.query('SELECT count(*)::integer AS count FROM material_upload_intents')).rows[0].count).toBe(1);
    await state.pool.query("UPDATE material_upload_intents SET updated_at=now()-interval '3 minutes'");
    expect(await reconcileUploadIntents()).toBe(1);
    expect(await reconcileUploadIntents()).toBe(0);
    expect((await state.pool.query('SELECT status FROM material_upload_intents')).rows[0].status).toBe('complete');
    expect((await state.pool.query('SELECT count(*)::integer AS count FROM ingestion_jobs')).rows[0].count).toBe(1);
    expect((await state.pool.query('SELECT ingestion_status FROM course_materials WHERE id=$1', [material.id])).rows[0].ingestion_status).toBe('queued');
  });
  it('allows an explicit authorized retry without resetting an active worker', async () => {
    const {job} = await seed('needs_review',randomUUID(),1);
    expect(await retryMaterialIngestion(1,1)).toBe('queued');
    const claimed = await claimJob('retry-worker');
    expect(claimed?.attempts).toBe(1);
    expect(await retryMaterialIngestion(1,1)).toBe('processing');
    expect((await state.pool.query('SELECT attempts FROM ingestion_jobs WHERE id=$1', [job.id])).rows[0].attempts).toBe(1);
    await expect(retryMaterialIngestion(1,2)).rejects.toThrow('Material not found');
  });
});
