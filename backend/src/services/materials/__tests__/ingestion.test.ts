import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../config/database', () => ({pool: {}}));
vi.mock('../../../config/storage', () => ({}));
vi.mock('../../embeddingService', () => ({embeddingToPostgresVector: (vector: number[]) => JSON.stringify(vector)}));
import { boundChunks, validateExtraction, ReviewRequiredError } from '../ingestionWorker';
import { parseBackfillArgs } from '../../../scripts/backfillMaterialIndex';

describe('native ingestion validation and budgets', () => {
  it('rejects incomplete extraction and accepts short readable native material', () => {
    const document = {content_text: 'Course title', content_chunks: [{chunk_id: 'a',text: 'Course title',metadata: {chunk_index: 0}}],
      metadata: {extraction_method: 'text' as const,extraction_date: new Date().toISOString()}};
    expect(() => validateExtraction(document)).not.toThrow();
    expect(() => validateExtraction({...document,metadata: {...document.metadata,extraction_degraded: true}})).toThrow(ReviewRequiredError);
  });
  it('preserves exact text, physical page, offsets, and hard token bounds on subdivision', async () => {
    const text = Array.from({length: 600}, (_, i) => `token${i}`).join('  \n');
    const chunks = await boundChunks([{chunk_id: 'a',text,metadata: {chunk_index: 0,page_number: 7,start_char: 10}}], value => value.length);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.locator.page).toBe(7);
      expect(chunk.tokenCount).toBeLessThanOrEqual(450);
      expect(chunk.text).toBe(text.slice(Number(chunk.locator.start) - 10, Number(chunk.locator.end) - 10));
    }
    expect(chunks[chunks.length - 1]?.locator.end).toBe(10 + text.length);
  });
  it('accepts explicitly partial native PDF text while rejecting empty or fatal extraction', () => {
    const partial = {content_text: 'Usable native course text', content_chunks: [{chunk_id: 'a',text: 'Usable native course text',metadata: {chunk_index: 0,page_number: 1}}],
      metadata: {extraction_method: 'pdf-parse' as const,extraction_date: new Date().toISOString(),text_coverage: 'partial' as const,
        extraction_degraded: true,review_pages: [2]}};
    expect(() => validateExtraction(partial)).not.toThrow();
    expect(() => validateExtraction({...partial,content_text: '',content_chunks: []})).toThrow(ReviewRequiredError);
    expect(() => validateExtraction({...partial,metadata: {...partial.metadata,error: 'Page limit exceeded'}})).toThrow(ReviewRequiredError);
  });
  it('requires explicit bounded backfill arguments', () => {
    expect(parseBackfillArgs(['--dry-run','--course-id','12','--limit','10'])).toEqual({dryRun: true,courseId: 12,limit: 10,resume: false,afterId: 0,checkStorage: false});
    expect(() => parseBackfillArgs(['--limit','0'])).toThrow();
    expect(() => parseBackfillArgs(['--course-id','--resume'])).toThrow();
    expect(() => parseBackfillArgs(['--all'])).toThrow();
    expect(() => parseBackfillArgs(['--course-id'])).toThrow();
    expect(() => parseBackfillArgs(['--limit'])).toThrow();
    expect(() => parseBackfillArgs(['--dry-run','--dry-run'])).toThrow();
    expect(() => parseBackfillArgs(['unexpected'])).toThrow();
  });
});
