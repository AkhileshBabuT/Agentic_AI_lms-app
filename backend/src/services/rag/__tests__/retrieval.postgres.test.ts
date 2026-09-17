import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const testUrl = process.env.RAG_TEST_DATABASE_URL;
const state = vi.hoisted(() => ({ pool: undefined as any }));
vi.mock('../../../config/database', () => ({ pool: { query: (...args: any[]) => state.pool.query(...args), connect: () => state.pool.connect() } }));
vi.mock('../../../config/storage', () => ({ generateSignedUrl: vi.fn().mockResolvedValue('https://storage.test/immutable?generation=123') }));
vi.mock('../modelInference', () => ({ embedRagQuery: vi.fn().mockResolvedValue([1, ...Array(767).fill(0)]), rerankRagTexts: vi.fn() }));
import { retrieveCourseEvidence, verifyEvidence } from '../retrieval';
import { persistCourseAnswer } from '../CourseAnswerService';
import { getAuthorizedAnswerRecord, getAuthorizedSavedAnswerRecord, getAuthorizedSavedContentSources, resolveMaterialSource } from '../CitationService';
import { renderAnswer } from '../evidence';
import { getEmbeddingSpaceId } from '../../materials/embeddingSpace';
import { purgeCourseIndex } from '../../materials/deleteCourseIndex';

describe.skipIf(!testUrl)('real PostgreSQL vector/lexical authorization and citation lifecycle', () => {
  const schema = `rag_retrieval_test_${Date.now()}`;
  const version = randomUUID(), run = randomUUID(), chunk = randomUUID();
  const otherVersion = randomUUID(), otherRun = randomUUID(), otherChunk = randomUUID();
  const identity = { courseId: 1, userId: 1, role: 'student' };
  let administrator: Pool;
  beforeAll(async () => {
    administrator = new Pool({ connectionString: testUrl });
    await administrator.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    await administrator.query(`CREATE SCHEMA ${schema}`);
    state.pool = new Pool({ connectionString: testUrl, options: `-c search_path=${schema},public`, max: 1 });
    await state.pool.query(`
      CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,status TEXT);
      CREATE TABLE courses(id INTEGER PRIMARY KEY,instructor_id INTEGER);
      CREATE TABLE enrollments(id SERIAL PRIMARY KEY,user_id INTEGER,course_id INTEGER);
      CREATE TABLE course_instructors(id SERIAL PRIMARY KEY,user_id INTEGER,course_id INTEGER);
      CREATE TABLE course_materials(id INTEGER PRIMARY KEY,course_id INTEGER,published_run_id UUID,deleted_at TIMESTAMPTZ,visibility TEXT);
      CREATE TABLE material_versions(id UUID PRIMARY KEY,material_id INTEGER,original_filename TEXT,object_name TEXT,object_generation TEXT);
      CREATE TABLE material_index_runs(id UUID PRIMARY KEY,version_id UUID,embedding_space_id TEXT,status TEXT);
      CREATE TABLE material_chunks(id UUID PRIMARY KEY,run_id UUID,material_id INTEGER,course_id INTEGER,text TEXT,locator JSONB,token_count INTEGER,search_vector TSVECTOR GENERATED ALWAYS AS(to_tsvector('english',text)) STORED);
      CREATE TABLE chunk_embeddings(chunk_id UUID,embedding_space_id TEXT,embedding vector(768));
      CREATE TABLE chat_sessions(id INTEGER PRIMARY KEY,student_id INTEGER,course_id INTEGER,status TEXT,last_activity_at TIMESTAMPTZ);
      CREATE TABLE chat_messages(id SERIAL PRIMARY KEY,session_id INTEGER REFERENCES chat_sessions(id),sender_type TEXT,content TEXT,message_metadata JSONB,is_deleted BOOLEAN DEFAULT FALSE,updated_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE agent_generated_content(id INTEGER PRIMARY KEY,student_id INTEGER,course_id INTEGER,content_metadata JSONB,is_saved BOOLEAN);
      INSERT INTO users VALUES(1,'student','active'),(2,'student','active'),(3,'professor','approved');
      INSERT INTO courses VALUES(1,3),(2,3);
      INSERT INTO enrollments(user_id,course_id) VALUES(1,1),(2,2);
      INSERT INTO chat_sessions VALUES(1,1,1,'active',NOW()),(2,2,2,'active',NOW());
    `);
    await state.pool.query(fs.readFileSync(path.join(__dirname, '../../../db/migrations/rag-answers-schema.sql'), 'utf8'));
    for (const [id, courseId, v, r, c, text] of [
      [1, 1, version, run, chunk, 'Photosynthesis converts sunlight into chemical energy.'],
      [2, 2, otherVersion, otherRun, otherChunk, 'Private-course photosynthesis secrets must not be exposed.']
    ] as const) {
      await state.pool.query('INSERT INTO course_materials VALUES($1,$2,$3,NULL,\'published\')', [id, courseId, r]);
      await state.pool.query('INSERT INTO material_versions VALUES($1,$2,$3,$4,$5)', [v, id, `Course ${id}.pdf`, `immutable/${v}.pdf`, '123']);
      await state.pool.query('INSERT INTO material_index_runs VALUES($1,$2,$3,\'published\')', [r, v, getEmbeddingSpaceId()]);
      await state.pool.query('INSERT INTO material_chunks(id,run_id,material_id,course_id,text,locator,token_count) VALUES($1,$2,$3,$4,$5,$6,100)', [c, r, id, courseId, text, JSON.stringify({ page: id })]);
      await state.pool.query('INSERT INTO chunk_embeddings VALUES($1,$2,$3)', [c, getEmbeddingSpaceId(), `[1,${Array(767).fill(0).join(',')}]`]);
    }
    await state.pool.query("ALTER TABLE material_index_runs ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'");
    await state.pool.query(`UPDATE material_index_runs SET metadata=$2::jsonb WHERE id=$1`, [run, JSON.stringify({text_coverage: 'partial',coverage_warning: 'Only extracted text is indexed; page 2 image content is unavailable.'})]);
  }, 30000);
  afterAll(async () => { await state.pool?.end(); if (administrator) { await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await administrator.end(); } });
  it('retrieves exactly authorized publication from real vector and FTS queries', async () => {
    const evidence = await retrieveCourseEvidence(identity, 'photosynthesis');
    expect(evidence.map(p => p.chunkId)).toEqual([chunk]);
    expect(evidence[0].coverageWarning).toContain('page 2');
    await expect(retrieveCourseEvidence({ ...identity, courseId: 2 }, 'photosynthesis')).rejects.toMatchObject({ status: 403 });
    expect(await verifyEvidence(identity, evidence)).toBe(true);
    expect(await verifyEvidence(identity, [{...evidence[0],coverageWarning: 'Invented complete coverage'}])).toBe(false);
  });
  it('allows course owner access without an assignment junction row', async () => {
    const evidence = await retrieveCourseEvidence({ courseId: 1, userId: 3, role: 'professor' }, 'photosynthesis');
    expect(evidence.map(p => p.chunkId)).toEqual([chunk]);
  });
  it('rechecks membership on persistence and rolls back before inserting an answer', async () => {
    const evidence = await retrieveCourseEvidence(identity, 'photosynthesis');
    const answer = renderAnswer({ status: 'answered', blocks: [{ text: 'Sunlight becomes energy.', evidenceIds: ['E1'] }] }, evidence);
    await state.pool.query('DELETE FROM enrollments WHERE user_id=1');
    await expect(persistCourseAnswer({ ...identity, sessionId: 1, answer })).rejects.toMatchObject({ status: 403 });
    expect((await state.pool.query('SELECT COUNT(*)::int AS n FROM chat_messages')).rows[0].n).toBe(0);
    await state.pool.query('INSERT INTO enrollments(user_id,course_id) VALUES(1,1)');
  });
  it('rejects a switched publication and fabricated source locators before inserting an answer', async () => {
    const evidence = await retrieveCourseEvidence(identity, 'photosynthesis');
    const answer = renderAnswer({ status: 'answered', blocks: [{ text: 'Sunlight becomes energy.', evidenceIds: ['E1'] }] }, evidence);
    await state.pool.query('UPDATE course_materials SET published_run_id=NULL WHERE id=1');
    await expect(persistCourseAnswer({ ...identity, sessionId: 1, answer })).rejects.toMatchObject({ status: 409 });
    await state.pool.query('UPDATE course_materials SET published_run_id=$1 WHERE id=1', [run]);
    answer.evidence[0].locator.page = 999;
    await expect(persistCourseAnswer({ ...identity, sessionId: 1, answer })).rejects.toMatchObject({ status: 409 });
    expect((await state.pool.query('SELECT COUNT(*)::int AS n FROM chat_messages')).rows[0].n).toBe(0);
  });
  it('holds a membership lock through persistence verification to serialize concurrent revocation', async () => {
    const evidence = await retrieveCourseEvidence(identity, 'photosynthesis');
    const client = await state.pool.connect();
    await client.query('BEGIN');
    try {
      expect(await verifyEvidence(identity, evidence, client, true)).toBe(true);
      let revoked = false;
      const revocation = administrator.query(`DELETE FROM ${schema}.enrollments WHERE user_id=1`).then(() => { revoked = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(revoked).toBe(false);
      await client.query('COMMIT');
      await revocation;
      expect(revoked).toBe(true);
    } finally { await client.query('ROLLBACK'); client.release(); }
    await state.pool.query('INSERT INTO enrollments(user_id,course_id) VALUES(1,1)');
  });
  it('rejects regeneration after a newer question and records the question association', async () => {
    const evidence = await retrieveCourseEvidence(identity, 'photosynthesis');
    const answer = renderAnswer({ status: 'answered', blocks: [{ text: 'Sunlight becomes energy.', evidenceIds: ['E1'] }] }, evidence);
    const first = (await state.pool.query(`INSERT INTO chat_messages(session_id,sender_type,content)
      VALUES(1,'student','First question') RETURNING id`)).rows[0].id;
    const second = (await state.pool.query(`INSERT INTO chat_messages(session_id,sender_type,content)
      VALUES(1,'student','Newer question') RETURNING id`)).rows[0].id;
    await expect(persistCourseAnswer({ ...identity, sessionId: 1, answer,
      questionMessageId: first, isRegeneration: true })).rejects.toMatchObject({ status: 409 });
    expect((await state.pool.query("SELECT COUNT(*)::int AS n FROM chat_messages WHERE sender_type='agent'")).rows[0].n).toBe(0);
    const committed = await persistCourseAnswer({ ...identity, sessionId: 1, answer,
      questionMessageId: second, isRegeneration: true });
    expect(committed.message_metadata.questionMessageId).toBe(second);
    await state.pool.query('DELETE FROM chat_messages');
  });
  it('persists assistant/citations atomically and revokes source/history after deletion', async () => {
    const evidence = await retrieveCourseEvidence(identity, 'photosynthesis');
    const answer = renderAnswer({ status: 'answered', blocks: [{ text: 'Sunlight becomes chemical energy.', evidenceIds: ['E1'] }] }, evidence);
    const original = await persistCourseAnswer({ ...identity, sessionId: 1, answer });
    const message = await persistCourseAnswer({ ...identity, sessionId: 1, answer, regeneratedFrom: original.id });
    await expect(getAuthorizedAnswerRecord(original.id, 1, 'student')).rejects.toMatchObject({ status: 403 });
    expect((await getAuthorizedSavedAnswerRecord(original.id, 1, 'student')).sources[0].excerpt).toBe(evidence[0].text);
    await state.pool.query('INSERT INTO agent_generated_content VALUES(22,1,1,$1,TRUE)', [JSON.stringify({ originalMessageId: original.id })]);
    expect((await getAuthorizedSavedContentSources(22, 1, 'student')).sources[0].excerpt).toBe(evidence[0].text);
    await expect(getAuthorizedSavedContentSources(22, 2, 'student')).rejects.toMatchObject({ status: 403 });
    await expect(getAuthorizedSavedAnswerRecord(original.id, 2, 'student')).rejects.toMatchObject({ status: 403 });
    expect((await getAuthorizedAnswerRecord(message.id, 1, 'student')).sources[0].excerpt).toBe(evidence[0].text);
    expect((await getAuthorizedAnswerRecord(message.id, 1, 'student')).sources[0].coverageWarning).toBe(evidence[0].coverageWarning);
    expect((await resolveMaterialSource(chunk, 1, 'student')).url).toContain('generation=123');
    await expect(getAuthorizedAnswerRecord(message.id, 2, 'student')).rejects.toMatchObject({ status: 403 });
    await state.pool.query('UPDATE course_materials SET deleted_at=NOW() WHERE id=1');
    expect(await retrieveCourseEvidence(identity, 'photosynthesis')).toEqual([]);
    expect(await getAuthorizedAnswerRecord(message.id, 1, 'student')).toEqual({ sources: [], restricted: true });
    expect(await getAuthorizedSavedAnswerRecord(original.id, 1, 'student')).toEqual({ sources: [], restricted: true });
    expect(await getAuthorizedSavedContentSources(22, 1, 'student')).toEqual({ sources: [], restricted: true });
    await expect(resolveMaterialSource(chunk, 1, 'student')).rejects.toMatchObject({ status: 403 });
    await expect(persistCourseAnswer({ ...identity, sessionId: 1, answer })).rejects.toMatchObject({ status: 409 });
    const count = await state.pool.query('SELECT COUNT(*)::int AS n FROM chat_messages');
    expect(count.rows[0].n).toBe(2);
  });
  it('permits the existing permanent course deletion without leaving blocking evidence references', async () => {
    await state.pool.query(`CREATE TABLE material_pages(run_id UUID REFERENCES material_index_runs(id),ordinal INTEGER,text TEXT,locator JSONB);
      CREATE TABLE ingestion_jobs(id UUID PRIMARY KEY,run_id UUID REFERENCES material_index_runs(id));
      CREATE TABLE material_upload_intents(id UUID PRIMARY KEY,material_id INTEGER REFERENCES course_materials(id));`);
    await state.pool.query('INSERT INTO ingestion_jobs VALUES($1,$2)', [randomUUID(), run]);
    await state.pool.query('INSERT INTO material_upload_intents VALUES($1,1)', [randomUUID()]);
    await purgeCourseIndex(state.pool, 1);
    await state.pool.query('DELETE FROM course_materials WHERE course_id=1');
    await state.pool.query('DELETE FROM courses WHERE id=1');
    expect((await state.pool.query('SELECT COUNT(*)::int AS n FROM answer_citations')).rows[0].n).toBe(0);
    expect((await state.pool.query('SELECT COUNT(*)::int AS n FROM material_chunks WHERE course_id=2')).rows[0].n).toBe(1);
  });
});
