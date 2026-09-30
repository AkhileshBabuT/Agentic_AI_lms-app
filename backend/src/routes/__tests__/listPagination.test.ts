import express from 'express';
import type { Server } from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../config/database', () => ({ pool: { query } }));
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => { req.user = { userId: 7, role: 'root', status: 'active' }; next(); },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../config/storage', () => ({ generateSignedUrl: vi.fn() }));
vi.mock('../../services/materials/deleteCourseIndex', () => ({ purgeCourseIndex: vi.fn() }));
vi.mock('../../services/settingsService', () => ({ getSourceOfTruthMode: vi.fn(), setSourceOfTruthMode: vi.fn() }));
import rootRouter from '../root';

describe('root cursor list contracts', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express(); app.use('/root', rootRouter);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/root`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  beforeEach(() => query.mockReset());

  it('bounds users and pages repeated timestamps by ID', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 12, cursor_time: '2026-09-30 10:00:00.123456' },
      { id: 11, cursor_time: '2026-09-30 10:00:00.123456' },
    ] }).mockResolvedValueOnce({ rows: [{ id: 11, cursor_time: '2026-09-30 10:00:00.123456' }] });
    const first = await fetch(base + '/users?limit=1');
    const firstBody = await first.json() as any;
    expect(firstBody.users).toEqual(firstBody.items);
    expect(firstBody.page.hasMore).toBe(true);
    const second = await fetch(base + `/users?limit=1&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`);
    expect((await second.json() as any).users[0].id).toBe(11);
    expect(query.mock.calls[1][0]).toContain('(created_at,id) <');
    expect(query.mock.calls[1][1]).toContain(12);
  });
  it('rejects a malformed or tampered cursor before querying', async () => {
    const response = await fetch(base + '/users?cursor=bad');
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
