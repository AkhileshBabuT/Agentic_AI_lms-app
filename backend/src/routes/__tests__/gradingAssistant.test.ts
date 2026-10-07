import express from 'express';
import type { Server } from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, connect, clientQuery, release, generateTentativeGrade } = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), clientQuery: vi.fn(), release: vi.fn(), generateTentativeGrade: vi.fn(),
}));
vi.mock('../../config/database', () => ({ pool: { query, connect } }));
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: Number(req.headers['x-user-id'] || 2), role: req.headers['x-role'] || 'professor' };
    next();
  },
}));
vi.mock('../../services/agents/GradingAssistantAgent', () => ({ GradingAssistantAgent: class { generateTentativeGrade = generateTentativeGrade; } }));
vi.mock('../../utils/usageLogger', () => ({ logUsage: vi.fn() }));
import router from '../gradingAssistant';

describe('grading assistant course authorization', () => {
  let server: Server;
  let base: string;
  const request = (path: string, userId = 2, role = 'professor', body?: unknown) => fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-user-id': String(userId), 'x-role': role, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use('/grading', router);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/grading`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => {
    vi.resetAllMocks();
    generateTentativeGrade.mockResolvedValue({ id: 4 });
    connect.mockResolvedValue({ query: clientQuery, release });
    clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT tg.id')) return { rows: params?.[1] === 2 ? [] : [{ submission_id: 8, points: 100 }] };
      return { rows: [] };
    });
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT sub.*, a.id')) return { rows: params?.[1] === 3 ? [{ id: 8, assignment_id: 7, title: 'Essay', file_name: null }] : [] };
      if (sql.includes('FROM grading_rubrics WHERE')) return { rows: [{ id: 9, assignment_id: 7, rubric_name: 'Essay', criteria: [], total_points: 100 }] };
      if (sql.includes('SELECT sub.id')) return { rows: params?.[1] === 2 ? [] : [{ id: 8 }] };
      if (sql.includes('FROM tentative_grades WHERE')) return { rows: [{ id: 4, submission_id: 8 }] };
      if (sql.includes('SELECT r.*')) return { rows: params?.[1] === 2 ? [] : [{ id: 9 }] };
      return { rows: [] };
    });
  });

  it('generates tentative grades only for the submitting student using authenticated userId', async () => {
    expect((await request('/generate-tentative-grade', 2, 'student', { submissionId: 8 })).status).toBe(404);
    expect((await request('/generate-tentative-grade', 3, 'student', { submissionId: 8 })).status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([8, 3]);
    expect(generateTentativeGrade.mock.calls[0].slice(0, 3)).toEqual([8, 7, 3]);
  });
  it('denies a professor from another course tentative grade before reading the record', async () => {
    expect((await request('/tentative-grade/8')).status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('course_instructors');
    const own = await request('/tentative-grade/8', 3);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { tentativeGrade: { id: number } }).tentativeGrade.id).toBe(4);
  });
  it('allows only the student who submitted to view their tentative grade', async () => {
    expect((await request('/tentative-grade/8', 2, 'student')).status).toBe(403);
    expect((await request('/tentative-grade/8', 3, 'student')).status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([8, 3, 'student']);
  });
  it('keeps rubrics private to assigned instructors', async () => {
    expect((await request('/rubric/7', 3, 'student')).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
    expect((await request('/rubric/7')).status).toBe(404);
    expect((await request('/rubric/7', 3)).status).toBe(200);
    expect(query.mock.calls[0][0]).toContain('course_instructors');
  });
  it('denies cross-course finalization without updating either grade', async () => {
    expect((await request('/finalize-grade/4', 2, 'professor', { finalGrade: 80, feedback: 'OK' })).status).toBe(404);
    expect(clientQuery.mock.calls.map(call => call[0])).toEqual(['BEGIN', expect.stringContaining('FOR UPDATE OF tg, sub'), 'ROLLBACK']);
    expect(clientQuery.mock.calls[1][1]).toEqual([4, 2]);
    expect(release).toHaveBeenCalledOnce();
  });
  it('commits both grade writes for an assigned instructor and rolls back on write failure', async () => {
    const payload = { finalGrade: 80, feedback: 'OK' };
    expect((await request('/finalize-grade/4', 3, 'professor', payload)).status).toBe(200);
    expect(clientQuery.mock.calls.map(call => call[0])).toEqual([
      'BEGIN', expect.stringContaining('FOR UPDATE OF tg, sub'),
      expect.stringContaining('UPDATE assignment_submissions'), expect.stringContaining('UPDATE tentative_grades'), 'COMMIT',
    ]);
    expect(clientQuery.mock.calls[3][1]).toEqual([3, 4]);
    clientQuery.mockClear();
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT tg.id')) return { rows: [{ submission_id: 8, points: 100 }] };
      if (sql.includes('UPDATE tentative_grades')) throw new Error('write failed');
      return { rows: [] };
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await request('/finalize-grade/4', 3, 'professor', payload)).status).toBe(500); }
    finally { spy.mockRestore(); }
    expect(clientQuery.mock.calls[clientQuery.mock.calls.length - 1][0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid IDs and grades before writing', async () => {
    expect((await request('/finalize-grade/not-id', 3, 'professor', { finalGrade: 80, feedback: '' })).status).toBe(400);
    expect((await request('/finalize-grade/4', 3, 'professor', { finalGrade: -1, feedback: '' })).status).toBe(400);
    expect((await request('/rubric/not-id', 3)).status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });
});
