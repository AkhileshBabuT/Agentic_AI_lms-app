import { OCR_CONFIG } from '../config/constants';

export interface OcrPage {
  page_number: number;
  markdown: string;
}

/**
 * Send a document to the OCR sidecar. Throws on any failure —
 * callers fall back to text-layer extraction and flag the doc degraded.
 */
export async function ocrDocument(fileBuffer: Buffer, mimeType: string): Promise<OcrPage[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OCR_CONFIG.TIMEOUT_MS);
  try {
    const res = await fetch(`${OCR_CONFIG.SIDECAR_URL}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_b64: fileBuffer.toString('base64'), mime_type: mimeType }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OCR sidecar returned ${res.status}`);
    const data = (await res.json()) as { pages?: OcrPage[] };
    if (!Array.isArray(data.pages) || data.pages.length === 0) {
      throw new Error('OCR sidecar returned no pages');
    }
    return data.pages;
  } finally {
    clearTimeout(timer);
  }
}
