import { describe, it, expect } from 'vitest';
import { needsOcr, chunkPages } from '../documentProcessor';

describe('needsOcr', () => {
  it('flags a scanned PDF (near-empty text layer)', () => {
    expect(needsOcr(['', '  ', 'a b'])).toBe(true);
  });
  it('passes a healthy text-layer PDF', () => {
    const page = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    expect(needsOcr([page, page])).toBe(false);
  });
  it('flags an empty document', () => {
    expect(needsOcr([])).toBe(true);
  });
});

describe('chunkPages', () => {
  it('stamps real page numbers and global chunk indexes', () => {
    const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkPages([
      { page_number: 1, text: long },
      { page_number: 2, text: 'short page two' },
    ]);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].metadata.page_number).toBe(1);
    expect(chunks[chunks.length - 1].metadata.page_number).toBe(2);
    // chunk ids/indexes are globally unique and sequential
    chunks.forEach((c, i) => {
      expect(c.chunk_id).toBe(`chunk_${i}`);
      expect(c.metadata.chunk_index).toBe(i);
    });
  });
  it('skips blank pages', () => {
    const chunks = chunkPages([{ page_number: 1, text: '   ' }, { page_number: 2, text: 'content here' }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.page_number).toBe(2);
  });
  it('splits a single oversized newline-free page into multiple chunks', () => {
    // 900 words, no paragraph breaks — the exact shape a PDF page renders as.
    const bigPage = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkPages([{ page_number: 1, text: bigPage }]);
    expect(chunks.length).toBeGreaterThan(1); // was 1 before the oversized-paragraph fix
    chunks.forEach(c => expect(c.metadata.page_number).toBe(1));
  });
});
