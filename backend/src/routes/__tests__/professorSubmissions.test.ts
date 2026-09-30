import express from 'express';
import type { Server } from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../config/database', () => ({ pool: { query } }));
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => { req.user = { userId: 3, role: 'professor' }; next(); },
  authorize: () => (_req: any, _res: any, next: any) => next(),
  requireApprovedProfessor: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../utils/usageLogger', () => ({ logUsage: vi.fn() }));
import router from '../professor';

describe('professor submission list', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express(); app.use('/professor', router);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/professor`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => {
    vi.resetAllMocks();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT course_id FROM course_instructors')) return { rows: [{ course_id: 5 }] };
      if (sql.includes('SELECT id FROM assignments')) return { rows: [{ id: 8 }] };
      if (sql.includes('FROM assignment_submissions asub')) return { rows: [
        { id: 2, cursor_time: '2026-09-30 12:00:00', tentative_grade: { id: 12, tentative_grade: 8 } },
        { id: 1, cursor_time: '2026-09-30 11:00:00', tentative_grade: null },
      ] };
      throw new Error('Unexpected query');
    });
  });
  it('returns bounded submissions and tentative grades in a constant number of queries', async () => {
    const response = await fetch(`${base}/assignments/8/submissions?limit=1`);
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ tentative_grade: unknown }>; page: { hasMore: boolean; nextCursor: string | null } };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].tentative_grade).toEqual({ id: 12, tentative_grade: 8 });
    expect(body.page.hasMore).toBe(true);
    expect(body.page.nextCursor).toEqual(expect.any(String));
    expect(query).toHaveBeenCalledTimes(3);
  });
  it('applies validated grade, student and sort filters to a scoped cursor', async () => {
    const params = 'limit=1&gradeState=ungraded&student=Lee&sort=student_asc';
    const first = await fetch(`${base}/assignments/8/submissions?${params}`);
    const firstBody = await first.json() as { page: { nextCursor: string } };
    expect(first.status).toBe(200);
    const firstSql = query.mock.calls[2][0] as string;
    expect(firstSql).toContain('asub.grade IS NULL');
    expect(firstSql).toContain('u.full_name ILIKE');
    expect(firstSql).toContain('ORDER BY u.full_name ASC,asub.id ASC');
    expect(query.mock.calls[2][1]).toContain('%Lee%');

    const second = await fetch(`${base}/assignments/8/submissions?${params}&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`);
    expect(second.status).toBe(200);
    expect(query.mock.calls[5][0]).toContain('(u.full_name,asub.id) >');
    expect(query.mock.calls[5][1]).toContain(2);
    expect((await fetch(`${base}/assignments/8/submissions?sort=grade_desc`)).status).toBe(400);
    expect(query).toHaveBeenCalledTimes(6);
  });
  it('reads an authorized assignment directly when it is beyond the first list page', async () => {
    query.mockReset().mockResolvedValueOnce({ rows: [{ id: 81, title: 'Later assignment' }] });
    const response = await fetch(`${base}/assignments/81`);
    expect(response.status).toBe(200);
    expect((await response.json() as any).assignment.id).toBe(81);
    expect(query.mock.calls[0][0]).toContain('JOIN course_instructors ci');
    expect(query.mock.calls[0][1]).toEqual([81, 3]);
    expect((await fetch(`${base}/assignments/not-an-id`)).status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
