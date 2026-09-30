import pino from 'pino';

// Operational logs carry only fields explicitly supplied by callers. Never pass
// request objects, URLs, provider errors, prompts, or response bodies to pino.
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  redact: {
    paths: [
      'authorization', 'cookie', 'password', 'token', 'apiKey',
      'req.headers.authorization', 'req.headers.cookie',
      'request.headers.authorization', 'request.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
});

export function safeError(error: unknown): { type: string; code?: string; upstreamStatus?: number } {
  if (!error || typeof error !== 'object') return { type: 'UnknownError' };
  const value = error as { name?: unknown; code?: unknown; status?: unknown };
  const type = typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.name)
    ? value.name : 'Error';
  const code = typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
    ? value.code : undefined;
  const upstreamStatus = typeof value.status === 'number' && value.status >= 400 && value.status <= 599
    ? value.status : undefined;
  return { type, ...(code ? { code } : {}), ...(upstreamStatus ? { upstreamStatus } : {}) };
}
