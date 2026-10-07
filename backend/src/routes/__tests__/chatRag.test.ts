import express from 'express';
import type { Server } from 'http';
import { createHash } from 'crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), answer: vi.fn(), persist: vi.fn(), access: vi.fn(),
  sources: vi.fn(), record: vi.fn(), records: vi.fn(), savedRecord: vi.fn(), usage: vi.fn(),
}));
vi.mock('../../config/database', () => ({ pool: { query: stubs.query, connect: stubs.connect } }));
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 7, role: req.headers['x-test-role'] || 'student', status: 'active' }; next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
  requireActiveStatus: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../utils/rateLimiter', () => ({
  createRateLimitMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../services/rag/CourseAnswerService', () => ({
  answerCourseQuestion: stubs.answer, persistCourseAnswer: stubs.persist,
}));
vi.mock('../../services/rag/access', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/rag/access')>()), assertCourseAccess: stubs.access,
}));
vi.mock('../../services/rag/CitationService', () => ({
  getAuthorizedAnswerSources: stubs.sources, getAuthorizedAnswerRecord: stubs.record,
  getAuthorizedAnswerRecords: stubs.records,
  getAuthorizedSavedAnswerRecord: stubs.savedRecord,
}));
vi.mock('../../utils/usageLogger', () => ({ logUsage: stubs.usage }));
import router from '../chat';

describe('course chat RAG integration', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use('/chat', router);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/chat`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  beforeEach(() => {
    vi.resetAllMocks();
    stubs.access.mockResolvedValue(undefined);
    stubs.answer.mockResolvedValue({ content: 'A supported answer [1]', status: 'answered',
      sources: [{ citationNumber: 1, chunkId: 'source' }], metadata: {} });
    stubs.persist.mockResolvedValue({ id: 12, sender_type: 'agent', content: 'A supported answer [1]' });
    stubs.sources.mockResolvedValue([]);
    stubs.record.mockResolvedValue({ sources: [], restricted: false });
    stubs.records.mockResolvedValue(new Map());
    stubs.savedRecord.mockResolvedValue({ sources: [], restricted: false });
  });
  const post = (path: string, body = {}, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  it('uses the actual requesting role and persists citations through the common answer service', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [{ course_id: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 11, content: 'Explain indexes' }] });
    const response = await post('/sessions/2/messages', { content: 'Explain indexes' }, { 'x-test-role': 'professor' });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(stubs.answer).toHaveBeenCalledWith(expect.objectContaining({ courseId: 3, userId: 7,
      role: 'professor', question: 'Explain indexes', signal: expect.any(AbortSignal) }));
    expect(stubs.persist).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 2, role: 'professor' }));
    expect(body.agentMessage.sources).toHaveLength(1);
    expect(body.agentMessage.confidence).toBeUndefined();
  });
  it('rejects a foreign or inactive session before saving content or generating', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [] });
    const response = await post('/sessions/2/messages', { content: 'Explain indexes' });
    expect(response.status).toBe(403);
    expect(stubs.query).toHaveBeenCalledTimes(1);
    expect(stubs.answer).not.toHaveBeenCalled();
  });
  it('rejects revoked course access before saving the question', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [{ course_id: 3 }] });
    stubs.access.mockRejectedValueOnce({ status: 403 });
    const response = await post('/sessions/2/messages', { content: 'Explain indexes' });
    expect(response.status).toBe(403);
    expect(stubs.query).toHaveBeenCalledTimes(1);
    expect(stubs.answer).not.toHaveBeenCalled();
  });
  it('leaves the previous answer intact when regeneration fails and hides provider details', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [{ course_id: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 11, content: 'Explain indexes' }] })
      .mockResolvedValueOnce({ rows: [{ id: 12 }] });
    stubs.answer.mockRejectedValueOnce(new Error('sensitive provider response'));
    const response = await post('/sessions/2/regenerate');
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('sensitive');
    expect(stubs.persist).not.toHaveBeenCalled();
    expect(stubs.query.mock.calls.some(call => /UPDATE chat_messages/.test(call[0]))).toBe(false);
  });
  it('passes the replacement ID into transactional persistence on regeneration', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [{ course_id: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 11, content: 'Explain indexes' }] })
      .mockResolvedValueOnce({ rows: [{ id: 12 }] });
    const response = await post('/sessions/2/regenerate');
    expect(response.status).toBe(200);
    expect(stubs.persist).toHaveBeenCalledWith(expect.objectContaining({ regeneratedFrom: 12 }));
  });
  it('redacts answers whose evidence was revoked and removes historical scores from metadata', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [{ id: 2, course_id: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 12, sender_type: 'agent', content: 'Removed confidential text',
        message_metadata: { confidence: 0.9, trustScore: 0.8, sources: [{ excerpt: 'Removed confidential text' }] } }] });
    stubs.records.mockResolvedValueOnce(new Map([[12, { sources: [], restricted: true }]]));
    const response = await fetch(base + '/sessions/2/messages');
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(JSON.stringify(body)).not.toContain('Removed confidential text');
    expect(body.messages[0].message_metadata.confidence).toBeUndefined();
    expect(body.messages[0].message_metadata.answerStatus).toBe('source_unavailable');
    expect(stubs.record).not.toHaveBeenCalled();
    expect(stubs.records).toHaveBeenCalledTimes(1);
  });
  it('lists authorized sessions with one bounded query and a stable cursor', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [
      { id: 4, course_id: 3, cursor_time: '2026-09-30 10:00:00.123456' },
      { id: 3, course_id: 3, cursor_time: '2026-09-30 10:00:00.123456' },
    ] });
    const response = await fetch(base + '/sessions?limit=1');
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.page.hasMore).toBe(true);
    expect(body.page.nextCursor).toEqual(expect.any(String));
    expect(stubs.query).toHaveBeenCalledTimes(1);
    expect(stubs.query.mock.calls[0][0]).toContain('access_enrollment');
    expect(stubs.access).not.toHaveBeenCalled();
    expect((await fetch(base + '/sessions?cursor=invalid!')).status).toBe(400);
  });
  it('bounds course selection and generated content collections', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [
      { id: 3, cursor_time: '2026-09-30 10:00:00' },
      { id: 2, cursor_time: '2026-09-30 09:00:00' },
    ] }).mockResolvedValueOnce({ rows: [
      { id: 41, course_id: 3, cursor_time: '2026-09-30 10:00:00', content_metadata: {} },
      { id: 40, course_id: 3, cursor_time: '2026-09-30 09:00:00', content_metadata: {} },
    ] });
    const courses = await fetch(base + '/courses?limit=1');
    expect(courses.status).toBe(200);
    expect((await courses.json() as any).page.hasMore).toBe(true);
    expect(stubs.query.mock.calls[0][0]).toContain('LIMIT $2');
    const content = await fetch(base + '/generated-content?limit=1');
    expect(content.status).toBe(200);
    const body = await content.json() as any;
    expect(body.content).toEqual(body.items);
    expect(body.page.hasMore).toBe(true);
    expect(stubs.query).toHaveBeenCalledTimes(2);
    expect(stubs.query.mock.calls[1][0]).toContain('access_enrollment');
  });
  it('opens an authorized session directly without listing previous pages', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [{ id: 42, course_id: 3, course_name: 'Databases' }] });
    const response = await fetch(base + '/sessions/42');
    expect(response.status).toBe(200);
    expect((await response.json() as any).session.id).toBe(42);
    expect(stubs.query).toHaveBeenCalledTimes(1);
    expect(stubs.query.mock.calls[0][0]).toContain('access_enrollment');
    expect(stubs.access).not.toHaveBeenCalled();
  });
  it('batches citation reads for a message page and rejects offset pagination', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [{ id: 2, course_id: 3 }] })
      .mockResolvedValueOnce({ rows: [
        { id: 13, sender_type: 'agent', content: 'New', cursor_time: '2026-09-30 10:00:00.123456', message_metadata: {} },
        { id: 12, sender_type: 'agent', content: 'Old', cursor_time: '2026-09-30 10:00:00.123456', message_metadata: {} },
      ] });
    stubs.records.mockResolvedValueOnce(new Map([[13, { sources: [], restricted: false }]]));
    const response = await fetch(base + '/sessions/2/messages?limit=1');
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.messages).toHaveLength(1);
    expect(body.page.hasMore).toBe(true);
    expect(stubs.query).toHaveBeenCalledTimes(2);
    expect(stubs.records).toHaveBeenCalledWith([13], 7, 'student');
    expect((await fetch(base + '/sessions/2/messages?offset=1')).status).toBe(400);
  });
  it('streams stage labels and emits answer text only after persistence', async () => {
    const student = { id: 21, sender_type: 'student', content: 'Explain indexes' };
    const clientQuery = vi.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ student_message_id: null }] })
      .mockResolvedValueOnce({ rows: [student] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    stubs.connect.mockResolvedValueOnce({ query: clientQuery, release: vi.fn() });
    stubs.query.mockResolvedValueOnce({ rows: [{ course_id: 3 }] })
      .mockResolvedValueOnce({ rows: [{ student_message_id: null }] })
      .mockResolvedValueOnce({ rows: [] });
    stubs.answer.mockImplementationOnce(async (input: any) => {
      input.onStage('searching_materials'); input.onStage('validating_citations');
      return { content: 'Verified answer', status: 'answered', sources: [], metadata: {} };
    });
    let finishPersistence!: (value: unknown) => void;
    stubs.persist.mockReturnValueOnce(new Promise(resolve => { finishPersistence = resolve; }));
    const response = await fetch(base + '/sessions/2/messages/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'abcdefghijklmnop' },
      body: JSON.stringify({ content: 'Explain indexes' }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const beforePersistence = decoder.decode(first.value, { stream: true });
    finishPersistence({ id: 22, sender_type: 'agent', content: 'Verified answer' });
    let text = beforePersistence;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(response.status).toBe(200);
    expect(text).toContain('event: accepted');
    expect(text).toContain('event: stage');
    expect(text).toContain('event: complete');
    expect(beforePersistence).not.toContain('Verified answer');
    expect(beforePersistence).not.toContain('event: complete');
    expect(text.indexOf('event: complete')).toBeGreaterThan(text.indexOf('validating_citations'));
    expect(text.indexOf('Verified answer')).toBeGreaterThan(text.indexOf('event: complete'));
    expect(stubs.persist).toHaveBeenCalledWith(expect.objectContaining({ questionMessageId: 21,
      idempotencyKey: 'abcdefghijklmnop' }));
    expect(stubs.query).toHaveBeenCalledTimes(3);
  });
  it('replays a completed stream key without inserting or generating again', async () => {
    const hash = createHash('sha256').update('Explain indexes').digest('hex');
    stubs.query.mockResolvedValueOnce({ rows: [{ course_id: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ question_hash: hash, status: 'complete',
        student_message_id: 21, agent_message_id: 22 }] })
      .mockResolvedValueOnce({ rows: [{ id: 22, content: 'Verified answer', message_metadata: {} }] })
      .mockResolvedValueOnce({ rows: [{ id: 21, content: 'Explain indexes' }] });
    const response = await fetch(base + '/sessions/2/messages/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'abcdefghijklmnop' },
      body: JSON.stringify({ content: 'Explain indexes' }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"replayed":true');
    expect(stubs.answer).not.toHaveBeenCalled();
    expect(stubs.persist).not.toHaveBeenCalled();
    expect(stubs.connect).not.toHaveBeenCalled();
  });
  it('withholds a replayed answer after its cited source is revoked', async () => {
    const hash = createHash('sha256').update('Explain indexes').digest('hex');
    stubs.query.mockResolvedValueOnce({ rows: [{ course_id: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ question_hash: hash, status: 'complete', student_message_id: 21, agent_message_id: 22 }] })
      .mockResolvedValueOnce({ rows: [{ id: 22, content: 'Private source excerpt', message_metadata: {} }] })
      .mockResolvedValueOnce({ rows: [{ id: 21, content: 'Explain indexes' }] });
    stubs.record.mockResolvedValueOnce({ sources: [], restricted: true });
    const response = await fetch(base + '/sessions/2/messages/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'abcdefghijklmnop' },
      body: JSON.stringify({ content: 'Explain indexes' }),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('source_unavailable');
    expect(body).not.toContain('Private source excerpt');
    expect(stubs.answer).not.toHaveBeenCalled();
  });
  it('rejects reuse of an idempotency key for a different question', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [{ course_id: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ question_hash: '0'.repeat(64), status: 'failed', student_message_id: 21 }] });
    const response = await fetch(base + '/sessions/2/messages/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'abcdefghijklmnop' },
      body: JSON.stringify({ content: 'Explain indexes' }),
    });
    expect(response.status).toBe(409);
    expect(stubs.answer).not.toHaveBeenCalled();
    expect(stubs.connect).not.toHaveBeenCalled();
  });
  it('rejects a concurrent retry and marks a disconnected stream retryable without a duplicate question', async () => {
    const hash = createHash('sha256').update('Explain indexes').digest('hex');
    let claims = 0;
    stubs.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT course_id FROM chat_sessions')) return { rows: [{ course_id: 3 }] };
      if (sql.includes('INSERT INTO chat_stream_requests'))
        return { rows: ++claims === 1 ? [{ student_message_id: null }] : [] };
      if (sql.includes('SELECT question_hash,status,student_message_id'))
        return { rows: [{ question_hash: hash, status: 'processing', student_message_id: 21 }] };
      if (sql.includes("message_metadata->>'idempotencyKey'")) return { rows: [] };
      if (sql.includes("SET status='processing'")) return { rows: [] };
      if (sql.includes("SET status='failed'")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT student_message_id')) return { rows: [{ student_message_id: null }] };
      if (sql.includes('INSERT INTO chat_messages')) return { rows: [{ id: 21, content: 'Explain indexes' }] };
      return { rows: [] };
    });
    stubs.connect.mockResolvedValueOnce({ query: clientQuery, release: vi.fn() });
    stubs.answer.mockImplementationOnce((input: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      if (input.signal.aborted) reject(new Error('cancelled'));
      else input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const controller = new AbortController();
    const request = () => fetch(base + '/sessions/2/messages/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'abcdefghijklmnop' },
      body: JSON.stringify({ content: 'Explain indexes' }),
    });
    const first = await fetch(base + '/sessions/2/messages/stream', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'abcdefghijklmnop' },
      body: JSON.stringify({ content: 'Explain indexes' }),
    });
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: accepted');
    const second = await request();
    expect(second.status).toBe(409);
    expect(stubs.answer).toHaveBeenCalledTimes(1);
    expect(stubs.persist).not.toHaveBeenCalled();
    controller.abort();
    await vi.waitFor(() => expect(stubs.query.mock.calls.some(call =>
      String(call[0]).includes("SET status='failed'"))).toBe(true));
    expect(clientQuery.mock.calls.filter(call => String(call[0]).includes('INSERT INTO chat_messages'))).toHaveLength(1);
  });
  it('rejects invalid IDs without querying and retires score endpoints without database work', async () => {
    expect((await post('/sessions/2bad/messages', { content: 'Explain indexes' })).status).toBe(400);
    expect((await fetch(base + '/messages/12/trust-score')).status).toBe(410);
    expect((await fetch(base + '/messages/12/fact-check')).status).toBe(410);
    expect(stubs.query).not.toHaveBeenCalled();
  });
  it('rejects oversized questions before saving them into history', async () => {
    expect((await post('/sessions/2/messages', { content: 'a'.repeat(8001) })).status).toBe(400);
    expect(stubs.query).not.toHaveBeenCalled();
    expect(stubs.answer).not.toHaveBeenCalled();
  });
  it('reauthorizes supporting evidence in saved content and withholds revoked excerpts', async () => {
    stubs.query.mockResolvedValueOnce({ rows: [{ id: 22, course_id: 3, content: 'Revoked source detail',
      content_metadata: { originalMessageId: 12, confidence: 0.9, sources: [{ excerpt: 'Revoked source detail' }] } }] });
    stubs.savedRecord.mockResolvedValueOnce({ sources: [], restricted: true });
    const response = await fetch(base + '/generated-content');
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('Revoked source detail');
    expect(stubs.savedRecord).toHaveBeenCalledWith(12, 7, 'student');
  });
});
