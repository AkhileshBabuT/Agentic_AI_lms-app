import { describe, it, expect, vi, afterEach } from 'vitest';
import { ocrDocument } from '../ocrClient';

afterEach(() => vi.unstubAllGlobals());

describe('ocrDocument', () => {
  it('posts the file and returns pages', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pages: [{ page_number: 1, markdown: '# Hi' }], model: 'm' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const pages = await ocrDocument(Buffer.from('pdfbytes'), 'application/pdf');

    expect(pages).toEqual([{ page_number: 1, markdown: '# Hi' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/ocr');
    expect(JSON.parse(init.body).mime_type).toBe('application/pdf');
  });

  it('throws on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(ocrDocument(Buffer.from('x'), 'image/png')).rejects.toThrow('500');
  });

  it('throws when response has no pages array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(ocrDocument(Buffer.from('x'), 'image/png')).rejects.toThrow('pages');
  });
});
