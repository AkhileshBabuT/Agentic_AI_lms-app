import express from 'express';
import type { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => vi.fn());
vi.mock('../../config/logger', () => ({ logger: { info: log } }));
vi.mock('../../middleware/auth', () => ({ authenticate: (_req: unknown, _res: unknown, next: () => void) => next() }));
import telemetry from '../telemetry';

describe('web vital telemetry', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use('/telemetry', telemetry);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  it('records only allowlisted metric fields', async () => {
    const response = await fetch(`${base}/telemetry/vitals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'LCP', value: 1200, rating: 'good', id: 'v4-123', token: 'private-token', prompt: 'private-prompt' }) });
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledWith({ event: 'web_vital', name: 'LCP', value: 1200, rating: 'good', id: 'v4-123' });
  });
  it('rejects arbitrary event names and content', async () => {
    const response = await fetch(`${base}/telemetry/vitals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'prompt', value: 1 }) });
    expect(response.status).toBe(400);
  });
});
