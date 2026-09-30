import express from 'express';
import type { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestLogger } from '../requestLogger';
import { safeError } from '../../config/logger';

describe('request logging public response', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(requestLogger);
    app.get('/test/:id', (_req, res) => res.json({ ok: true }));
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  it('preserves safe request IDs and returns timing', async () => {
    const response = await fetch(`${base}/test/secret`, { headers: { 'x-request-id': 'test-id-123' } });
    expect(response.headers.get('x-request-id')).toBe('test-id-123');
    expect(response.headers.get('server-timing')).toMatch(/^total;dur=\d+\.\d{2}$/);
  });
  it('replaces unsafe request IDs and serializes errors without content', async () => {
    const response = await fetch(`${base}/test/secret`, { headers: { 'x-request-id': 'Bearer secret' } });
    expect(response.headers.get('x-request-id')).not.toBe('Bearer secret');
    expect(safeError(Object.assign(new Error('prompt and token'), { code: 'UPSTREAM_ERROR', status: 503 })))
      .toEqual({ type: 'Error', code: 'UPSTREAM_ERROR', upstreamStatus: 503 });
  });
});
