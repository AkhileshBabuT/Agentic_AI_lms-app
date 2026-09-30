import express from 'express';
import type { Server } from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../config/database', () => ({ pool: { query } }));
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => { req.user = { userId: 7, role: 'student' }; next(); },
  authorize: () => (_req: any, _res: any, next: any) => next(),
  requireActiveStatus: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../config/storage', () => ({ uploadFile: vi.fn(), generateSignedUrl: vi.fn() }));
vi.mock('../../utils/usageLogger', () => ({ logUsage: vi.fn() }));
import router from '../student';

describe('student course collection pages', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express(); app.use('/student', router);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/student`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => query.mockReset());

  it('returns a bounded assignment page only after enrollment', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [
      { id: 11, cursor_time: '2026-10-01 12:00:00' },
      { id: 10, cursor_time: '2026-10-01 12:00:00' },
    ] });
    const response = await fetch(base + '/courses/5/assignments?limit=1');
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.assignments).toEqual(body.items);
    expect(body.items).toHaveLength(1);
    expect(body.page.hasMore).toBe(true);
    expect(query.mock.calls[1][0]).toContain('ORDER BY COALESCE(due_date');
    expect(query.mock.calls[1][1]).toEqual([ '5', 2 ]);
  });
  it('rejects invalid cursors before looking up private course data', async () => {
    expect((await fetch(base + '/courses/5/assignments?cursor=bad')).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('does not expose course assignments to an unenrolled student', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await fetch(base + '/courses/5/assignments')).status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
