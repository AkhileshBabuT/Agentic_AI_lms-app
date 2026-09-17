import express from 'express';
import type { Server } from 'http';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  query: vi.fn(), answer: vi.fn(), persist: vi.fn(), access: vi.fn(),
  sources: vi.fn(), record: vi.fn(), savedRecord: vi.fn(), usage: vi.fn(),
}));
vi.mock('../../config/database', () => ({ pool: { query: stubs.query } }));
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
vi.mock('../../services/rag/access', () => ({ assertCourseAccess: stubs.access }));
vi.mock('../../services/rag/CitationService', () => ({
  getAuthorizedAnswerSources: stubs.sources, getAuthorizedAnswerRecord: stubs.record,
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
    stubs.record.mockResolvedValueOnce({ sources: [], restricted: true });
    const response = await fetch(base + '/sessions/2/messages');
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(JSON.stringify(body)).not.toContain('Removed confidential text');
    expect(body.messages[0].message_metadata.confidence).toBeUndefined();
    expect(body.messages[0].message_metadata.answerStatus).toBe('source_unavailable');
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
