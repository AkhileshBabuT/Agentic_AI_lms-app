import { createHmac, timingSafeEqual } from 'crypto';

export interface PageCursor { at: string; id: number }

function signature(payload: string): string {
  return createHmac('sha256', process.env.JWT_SECRET || 'local-development-cursor-key')
    .update(payload).digest('base64url');
}

/** Cursors carry the complete stable sort tuple and are scoped to one list/filter. */
export function encodeCursor(cursor: PageCursor, scope: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, s: scope, t: cursor.at, i: cursor.id }), 'utf8').toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function decodeCursor(value: unknown, scope: string): PageCursor | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Invalid cursor');
  try {
    const [payload, suppliedSignature] = value.split('.');
    const expectedSignature = Buffer.from(signature(payload));
    const receivedSignature = Buffer.from(suppliedSignature);
    if (receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)) throw new Error('Invalid cursor');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.v !== 1 || parsed.s !== scope || typeof parsed.t !== 'string' ||
      parsed.t.length === 0 || parsed.t.length > 255 || /[\x00-\x1f]/.test(parsed.t) ||
      !Number.isSafeInteger(parsed.i) || parsed.i < 1 ||
      encodeCursor({ at: parsed.t, id: parsed.i }, scope) !== value) throw new Error('Invalid cursor');
    return { at: parsed.t, id: parsed.i };
  } catch { throw new Error('Invalid cursor'); }
}

export function parseLimit(value: unknown, fallback = 20): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > 100)
    throw new Error('Invalid limit');
  return Number(value);
}

export function cursorFromRow(row: { id: number; [key: string]: unknown }, timestampKey: string): PageCursor {
  const timestamp = row[timestampKey];
  if (typeof timestamp !== 'string') throw new Error('Missing cursor timestamp');
  return { at: timestamp, id: Number(row.id) };
}
