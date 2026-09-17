import { describe, it, expect, vi } from 'vitest';
import {readFileSync} from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
const ocrSpy = vi.hoisted(() => vi.fn());
vi.mock('../ocrClient', () => ({ocrDocument: ocrSpy}));
import { needsOcr, chunkPages, extractTextFromFile } from '../documentProcessor';

describe('OCR is deferred', () => {
  it.each(['embedded-font.pdf', 'embedded-font-jpeg.pdf'])('extracts %s in Node without delayed browser font/image-loader crashes', async fixture => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '-r', 'ts-node/register/transpile-only', path.join(__dirname, 'fixtures/extract-pdf.cjs'),
      path.join(__dirname, 'fixtures', fixture),
    ], { cwd: path.resolve(__dirname, '../../..'), timeout: 15000 });
    const result = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(result.text).toContain('Embedded font regression fixture.');
    expect(result.pages).toBe(1);
    expect(result.pageNumbers).toEqual([1]);
    expect(result.degraded).toBe(false);
  }, 20000);
  it('never calls OCR or vision extraction for image attachments', async () => {
    const result = await extractTextFromFile(Buffer.from('image'), 'scan.png', 'image/png');
    expect(result.metadata.extraction_degraded).toBe(true);
    expect(result.content_chunks).toEqual([]);
    expect(ocrSpy).not.toHaveBeenCalled();
  });
  it('keeps exact whitespace and character offsets for native evidence', async () => {
    const text = 'Course   title\n\n  Exact text with repeated  spaces.';
    const result = await extractTextFromFile(Buffer.from(text), 'title.txt', 'text/plain');
    for (const chunk of result.content_chunks) {
      expect(chunk.text).toBe(text.slice(chunk.metadata.start_char, chunk.metadata.end_char));
    }
  });
  it('accepts a short PDF title page alongside healthy pages with real physical locators', async () => {
    const result = await extractTextFromFile(readFileSync(path.join(__dirname,'fixtures/native.pdf')), 'native.pdf','application/pdf');
    expect(result.metadata.extraction_degraded).not.toBe(true);
    expect(result.metadata.page_count).toBe(2);
    expect(result.content_chunks.map(chunk => chunk.metadata.page_number)).toEqual([1,2]);
    expect(ocrSpy).not.toHaveBeenCalled();
  });
  it('marks a mixed PDF with an unextractable page for review while preserving page numbers', async () => {
    const result = await extractTextFromFile(readFileSync(path.join(__dirname,'fixtures/mixed.pdf')), 'mixed.pdf','application/pdf');
    expect(result.metadata.extraction_degraded).toBe(true);
    expect(result.metadata.review_pages).toEqual([2]);
    expect(result.metadata.text_coverage).toBe('partial');
    expect(result.content_chunks.map(chunk => chunk.metadata.page_number)).toEqual([1,3]);
    expect(ocrSpy).not.toHaveBeenCalled();
  });
});

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
