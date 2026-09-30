import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';
import { logger } from '../config/logger';

const validRequestId = /^[A-Za-z0-9_-]{8,64}$/;

export const requestLogger: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const requestId = incoming && validRequestId.test(incoming) ? incoming : randomUUID();
  const started = process.hrtime.bigint();
  res.setHeader('X-Request-Id', requestId);
  const originalWriteHead = res.writeHead;
  res.writeHead = function (this: typeof res, ...args: unknown[]) {
    if (!res.headersSent) {
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
      res.setHeader('Server-Timing', `total;dur=${elapsed.toFixed(2)}`);
    }
    return Reflect.apply(originalWriteHead, this, args);
  } as typeof res.writeHead;
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const route = req.route?.path;
    const normalizedRoute = route ? `${req.baseUrl}${String(route)}` : 'unmatched';
    logger.info({
      event: 'http_request', requestId, method: req.method,
      route: normalizedRoute, status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      responseBytes: Number(res.getHeader('content-length')) || undefined,
    });
  });
  next();
};
