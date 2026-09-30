import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination';

describe('cursor pagination', () => {
  it('round trips a stable timestamp and ID tuple scoped to a list', () => {
    const cursor = encodeCursor({ at: '2026-09-30 10:00:00.123456', id: 17 }, 'messages:7:2');
    expect(decodeCursor(cursor, 'messages:7:2')).toEqual({ at: '2026-09-30 10:00:00.123456', id: 17 });
    expect(() => decodeCursor(cursor, 'messages:7:3')).toThrow('Invalid cursor');
    expect(() => decodeCursor(cursor + 'x', 'messages:7:2')).toThrow('Invalid cursor');
  });
  it('bounds limits and rejects malformed values', () => {
    expect(parseLimit(undefined)).toBe(20);
    expect(parseLimit('100')).toBe(100);
    for (const value of ['0', '101', '1x', '-1', '1.5', ['5']])
      expect(() => parseLimit(value)).toThrow('Invalid limit');
  });
});
