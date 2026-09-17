import mammoth from 'mammoth';
import { OfficeParser } from 'officeparser';
import * as XLSX from 'xlsx';
import * as CFB from 'cfb';
import { DOCUMENT_PROCESSING, OCR_CONFIG } from '../config/constants';
import { MATERIAL_INGESTION } from '../config/materialIngestion';
const PDF_JS = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
// Use pdf-parse's bundled PDF.js with explicit Node settings. The wrapper does
// not forward native image-decoder settings to getDocument.
PDF_JS.PDFJS.disableFontFace = true;
PDF_JS.PDFJS.isEvalSupported = false;
const PDF_OPS = PDF_JS.OPS;

/**
 * Interface for processed document chunks
 */
export interface DocumentChunk {
  chunk_id: string;
  text: string;
  metadata: {
    page_number?: number | string;
    start_char?: number;
    end_char?: number;
    chunk_index: number;
    section?: string;
    locator_kind?: string;
  };
}

/**
 * Interface for complete processed document
 */
export interface ProcessedDocument {
  content_text: string;
  content_chunks: DocumentChunk[];
  metadata: {
    page_count?: number;
    word_count?: number;
    extraction_method: 'pdf-parse' | 'mammoth' | 'text' | 'officeparser-pptx' | 'xlsx'
      | 'gemini-ocr' | 'unlimited-ocr' | 'groq-vision' | 'unsupported';
    extraction_degraded?: boolean;
    text_coverage?: 'complete' | 'partial';
    review_pages?: number[];
    pages?: Array<{ text: string; locator: {page?: number; section?: string; kind?: string} }>;
    extraction_date: string;
    error?: string;
  };
}

/**
 * Extract text from a PDF file
 */
async function extractFromPDF(fileBuffer: Buffer): Promise<ProcessedDocument> {
  // Pass 1: text layer, collected per page so chunks get real page numbers.
  let pageTexts: string[] = [];
  const suspectPages = new Set<number>();
  let textLayerError: string | undefined;
  let loadingTask: any;
  try {
    const collected: string[] = [];
    loadingTask = PDF_JS.getDocument({ data: new Uint8Array(fileBuffer),
      nativeImageDecoderSupport: PDF_JS.NativeImageDecoding.NONE });
    const pdf = await loadingTask.promise;
    const pageCount = Math.min(pdf.numPages, MATERIAL_INGESTION.maxPages);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        let text = '';
        try {
          const pageData = await pdf.getPage(pageNumber);
          const tc = await pageData.getTextContent();
          // Preserve line breaks (hasEOL) so chunking sees structure, not one blob.
          text = tc.items.map((it: any) => it.str + (it.hasEOL ? '\n' : ' ')).join('').trim();
          const operators = await pageData.getOperatorList();
          const hasImage = operators.fnArray.some((op: number) => [PDF_OPS.paintJpegXObject, PDF_OPS.paintImageXObject,
            PDF_OPS.paintInlineImageXObject, PDF_OPS.paintInlineImageXObjectGroup,
            PDF_OPS.paintImageXObjectRepeat, PDF_OPS.paintImageMaskXObjectRepeat].includes(op));
          if (hasImage && text.split(/\s+/).filter(Boolean).length < OCR_CONFIG.MIN_WORDS_PER_PAGE) {
            suspectPages.add(pageNumber);
          }
        } catch {
          // A single page's failure must NOT drop it from `collected` — that would
          // misalign every later page number. Keep a placeholder to preserve order.
          text = '';
        }
        collected[pageNumber - 1] = text;
    }
    pageTexts = collected;
    if (pdf.numPages > MATERIAL_INGESTION.maxPages) textLayerError = 'PDF exceeds the native page limit';
  } catch (error) {
    textLayerError = error instanceof Error ? error.message : 'Unknown error';
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => { /* Already closed after a parser failure. */ });
  }

  // OCR is intentionally deferred: never call the sidecar or a vision model.
  // A short title page alone does not imply a scanned document. A blank/error
  // page requires review because native extraction cannot establish completeness.
  const reviewPages = pageTexts.map((text, i) => text.trim() && !suspectPages.has(i + 1) ? 0 : i + 1).filter(Boolean);
  const scanned = pageTexts.length === 0 || reviewPages.length > 0 || Boolean(textLayerError);

  const content_text = pageTexts.join('\n\n');
  const pages = pageTexts.map((text, i) => ({ page_number: i + 1, text }));
  return {
    content_text,
    content_chunks: chunkPages(pages),
    metadata: {
      page_count: pageTexts.length,
      review_pages: reviewPages,
      text_coverage: scanned ? 'partial' : 'complete',
      pages: pageTexts.map((text, i) => ({text, locator: {page: i + 1, kind: 'pdf_page'}})),
      word_count: content_text.split(/\s+/).filter(w => w.length > 0).length,
      extraction_method: 'pdf-parse',
      extraction_date: new Date().toISOString(),
      // Scanned doc without a working OCR path = we KNOW this extraction is bad.
      ...(scanned ? { extraction_degraded: true } : {}),
      ...(textLayerError ? { error: `PDF extraction failed: ${textLayerError}` } : {}),
    },
  };
}

/**
 * Extract text from a Word document (.docx)
 */
async function extractFromWord(fileBuffer: Buffer): Promise<ProcessedDocument> {
  try {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    const content_text = result.value;
    const word_count = content_text.split(/\s+/).filter((w: string) => w.length > 0).length;

    // Chunk using configured values with semantic awareness
    const chunks = chunkTextSemantic(content_text);

    return {
      content_text,
      content_chunks: chunks,
      metadata: {
        word_count,
        extraction_method: 'mammoth',
        extraction_date: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error('Error extracting text from Word document:', error);
    return {
      content_text: '',
      content_chunks: [],
      metadata: {
        extraction_method: 'mammoth',
        extraction_date: new Date().toISOString(),
        error: `Word extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    };
  }
}

/**
 * Extract text from text-based files
 */
async function extractFromText(fileBuffer: Buffer, fileName: string): Promise<ProcessedDocument> {
  try {
    const content_text = fileBuffer.toString('utf-8');
    const word_count = content_text.split(/\s+/).filter((w: string) => w.length > 0).length;

    // Chunk using configured values with semantic awareness
    const chunks = chunkTextSemantic(content_text);

    return {
      content_text,
      content_chunks: chunks,
      metadata: {
        word_count,
        extraction_method: 'text',
        extraction_date: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error('Error extracting text from file:', error);
    return {
      content_text: '',
      content_chunks: [],
      metadata: {
        extraction_method: 'text',
        extraction_date: new Date().toISOString(),
        error: `Text extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    };
  }
}

/**
 * Extract text from a legacy .ppt file using the CFB (OLE2 Compound Binary) parser.
 * Reads the "PowerPoint Document" binary stream and extracts text from
 * TextBytesAtom (0x0FA8) and TextCharsAtom (0x0FA0) record types.
 */
function extractTextFromLegacyPpt(fileBuffer: Buffer): string {
  const cfb = CFB.read(fileBuffer, { type: 'buffer' });

  // Find the PowerPoint Document stream
  const entry = CFB.find(cfb, '/PowerPoint Document') || CFB.find(cfb, 'PowerPoint Document');
  if (!entry || !entry.content) {
    throw new Error('Could not find PowerPoint Document stream in .ppt file');
  }

  const data = Buffer.from(entry.content);
  const texts: string[] = [];
  let offset = 0;

  while (offset + 8 <= data.length) {
    const recVerInstance = data.readUInt16LE(offset);
    const recVer = recVerInstance & 0xF;
    const recType = data.readUInt16LE(offset + 2);
    const recLen = data.readUInt32LE(offset + 4);

    // Container records (recVer == 0xF) hold child records as their payload.
    // Skip just the 8-byte header so we descend into the children.
    if (recVer === 0xF) {
      offset += 8;
      continue;
    }

    // Atom record — validate bounds
    if (offset + 8 + recLen > data.length) break;

    if (recType === 0x0FA8 && recLen > 0) {
      // TextBytesAtom: ASCII text, 1 byte per character
      const text = data.subarray(offset + 8, offset + 8 + recLen).toString('latin1');
      if (text.trim().length > 0) {
        texts.push(text.trim());
      }
    } else if (recType === 0x0FA0 && recLen > 1) {
      // TextCharsAtom: UTF-16LE text, 2 bytes per character
      const text = data.subarray(offset + 8, offset + 8 + recLen).toString('utf16le');
      if (text.trim().length > 0) {
        texts.push(text.trim());
      }
    }

    offset += 8 + recLen;
  }

  return texts.join('\n\n');
}

/**
 * Extract text from a PowerPoint presentation (.pptx or .ppt)
 * Uses OfficeParser for modern .pptx, CFB binary parsing for legacy .ppt
 */
async function extractFromPowerPoint(fileBuffer: Buffer, mimeType: string): Promise<ProcessedDocument> {
  const isLegacyPpt = mimeType === 'application/vnd.ms-powerpoint';

  if (isLegacyPpt) {
    try {
      console.log('Legacy .ppt detected, using CFB binary parser for text extraction...');
      const content_text = extractTextFromLegacyPpt(fileBuffer);

      if (!content_text || content_text.trim().length === 0) {
        return {
          content_text: '',
          content_chunks: [],
          metadata: {
            extraction_method: 'officeparser-pptx',
            extraction_date: new Date().toISOString(),
            error: 'Legacy PowerPoint file contained no extractable text'
          }
        };
      }

      const word_count = content_text.split(/\s+/).filter((w: string) => w.length > 0).length;
      const chunks = chunkTextSemantic(content_text);
      console.log(`✓ Extracted ${word_count} words from legacy .ppt file`);

      return {
        content_text,
        content_chunks: chunks,
        metadata: {
          word_count,
          extraction_method: 'officeparser-pptx',
          extraction_date: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Error extracting text from legacy PowerPoint:', error);
      return {
        content_text: '',
        content_chunks: [],
        metadata: {
          extraction_method: 'officeparser-pptx',
          extraction_date: new Date().toISOString(),
          error: `Legacy PowerPoint extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      };
    }
  }

  // Modern .pptx format: use OfficeParser
  try {
    const ast = await OfficeParser.parseOffice(fileBuffer);
    const content_text = ast.toText();

    if (!content_text || content_text.trim().length === 0) {
      return {
        content_text: '',
        content_chunks: [],
        metadata: {
          extraction_method: 'officeparser-pptx',
          extraction_date: new Date().toISOString(),
          error: 'PowerPoint file contained no extractable text'
        }
      };
    }

    const word_count = content_text.split(/\s+/).filter((w: string) => w.length > 0).length;
    const chunks = chunkTextSemantic(content_text);

    return {
      content_text,
      content_chunks: chunks,
      metadata: {
        word_count,
        extraction_method: 'officeparser-pptx',
        extraction_date: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error('Error extracting text from PowerPoint:', error);
    return {
      content_text: '',
      content_chunks: [],
      metadata: {
        extraction_method: 'officeparser-pptx',
        extraction_date: new Date().toISOString(),
        error: `PowerPoint extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    };
  }
}

/**
 * Extract text from an Excel spreadsheet (.xlsx, .xls)
 */
async function extractFromExcel(fileBuffer: Buffer): Promise<ProcessedDocument> {
  try {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return {
        content_text: '',
        content_chunks: [],
        metadata: {
          extraction_method: 'xlsx',
          extraction_date: new Date().toISOString(),
          error: 'Excel file contained no sheets'
        }
      };
    }

    const textParts: string[] = [];
    const sheetChunks: DocumentChunk[] = [];
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet?.['!ref']) continue;
      const range = XLSX.utils.decode_range(worksheet['!ref']);
      for (let row = range.s.r; row <= range.e.r; row++) {
        const cells: string[] = [];
        for (let col = range.s.c; col <= range.e.c; col++) {
          const address = XLSX.utils.encode_cell({r: row, c: col});
          const cell = worksheet[address];
          if (cell && cell.v !== undefined && cell.v !== null) cells.push(`${address}: ${XLSX.utils.format_cell(cell)}`);
        }
        if (!cells.length) continue;
        const text = cells.join(' | ');
        textParts.push(`${sheetName}, row ${row + 1}: ${text}`);
        for (const chunk of chunkTextSemantic(text)) {
          const index = sheetChunks.length;
          sheetChunks.push({...chunk, chunk_id: `chunk_${index}`, metadata: {...chunk.metadata,
            chunk_index: index, section: `${sheetName}, row ${row + 1}`, locator_kind: 'sheet_row'}});
        }
      }
    }

    const content_text = textParts.join('\n').trim();

    if (content_text.length === 0) {
      return {
        content_text: '',
        content_chunks: [],
        metadata: {
          extraction_method: 'xlsx',
          extraction_date: new Date().toISOString(),
          error: 'Excel file contained no extractable text'
        }
      };
    }

    const word_count = content_text.split(/\s+/).filter((w: string) => w.length > 0).length;
    const page_count = workbook.SheetNames.length;
    const chunks = sheetChunks;

    return {
      content_text,
      content_chunks: chunks,
      metadata: {

        word_count,
        extraction_method: 'xlsx',
        extraction_date: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error('Error extracting text from Excel:', error);
    return {
      content_text: '',
      content_chunks: [],
      metadata: {
        extraction_method: 'xlsx',
        extraction_date: new Date().toISOString(),
        error: `Excel extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    };
  }
}

/** Image extraction is deferred until OCR is explicitly implemented. */
async function extractFromImage(_fileBuffer: Buffer, _mimeType: string): Promise<ProcessedDocument> {
  return {content_text: '', content_chunks: [], metadata: {
    extraction_method: 'unsupported', extraction_degraded: true,
    extraction_date: new Date().toISOString(), error: 'Image-only materials require review; OCR is disabled',
  }};
}

/** A PDF whose text layer averages fewer words/page than the threshold is treated as scanned. */
export function needsOcr(pageTexts: string[]): boolean {
  if (pageTexts.length === 0) return true;
  const totalWords = pageTexts
    .join(' ')
    .split(/\s+/)
    .filter(w => w.length > 0).length;
  return totalWords / pageTexts.length < OCR_CONFIG.MIN_WORDS_PER_PAGE;
}

/** Chunk page-by-page so every chunk carries its real page number. */
export function chunkPages(pages: Array<{ page_number: number; text: string }>): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  for (const page of pages) {
    if (page.text.trim().length === 0) continue;
    for (const chunk of chunkTextSemantic(page.text)) {
      const index = chunks.length;
      chunks.push({
        chunk_id: `chunk_${index}`,
        text: chunk.text,
        metadata: { ...chunk.metadata, page_number: page.page_number, chunk_index: index },
      });
    }
  }
  return chunks;
}

/**
 * Semantic-aware text chunking - preserves paragraph and sentence boundaries
 * @param text - The text to chunk
 * @returns Array of document chunks
 */
function chunkTextSemantic(text: string): DocumentChunk[] {
  // Slice the original extraction rather than reconstructing words: evidence
  // excerpts and offsets remain exact even with repeated spaces/newlines.
  const words = [...text.matchAll(/\S+/g)];
  const target = DOCUMENT_PROCESSING.CHUNK_SIZE_WORDS;
  const overlap = Math.min(DOCUMENT_PROCESSING.CHUNK_OVERLAP_WORDS, target - 1);
  const chunks: DocumentChunk[] = [];
  for (let first = 0; first < words.length; first += target - overlap) {
    const last = Math.min(first + target, words.length) - 1;
    const start = words[first].index!;
    const end = words[last].index! + words[last][0].length;
    const index = chunks.length;
    chunks.push({ chunk_id: `chunk_${index}`, text: text.slice(start, end),
      metadata: {start_char: start, end_char: end, chunk_index: index, locator_kind: 'extracted_text'} });
    if (last === words.length - 1) break;
  }
  return chunks;
}

/**
 * Legacy chunking function (kept for backward compatibility)
 * @deprecated Use chunkTextSemantic instead
 */
function chunkText(text: string, targetWords: number = 300, overlapWords: number = 150): DocumentChunk[] {
  const words = text.split(/\s+/).filter((w: string) => w.length > 0);
  const chunks: DocumentChunk[] = [];
  let chunkIndex = 0;
  let startChar = 0;

  for (let i = 0; i < words.length; i += (targetWords - overlapWords)) {
    const chunkWords = words.slice(i, i + targetWords);
    const chunkText = chunkWords.join(' ');
    const endChar = startChar + chunkText.length;

    chunks.push({
      chunk_id: `chunk_${chunkIndex}`,
      text: chunkText,
      metadata: {
        start_char: startChar,
        end_char: endChar,
        chunk_index: chunkIndex
      }
    });

    chunkIndex++;
    startChar = endChar + 1;
  }

  if (chunks.length === 0 && text.trim().length > 0) {
    chunks.push({
      chunk_id: 'chunk_0',
      text: text.trim(),
      metadata: {
        start_char: 0,
        end_char: text.length,
        chunk_index: 0
      }
    });
  }

  return chunks;
}

/**
 * Main function to extract text from any supported file type
 * @param fileBuffer - The file buffer
 * @param fileName - The original file name
 * @param mimeType - The MIME type of the file
 * @returns ProcessedDocument with text, chunks, and metadata
 */
export async function extractTextFromFile(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<ProcessedDocument> {
  console.log(`Processing file: ${fileName} (${mimeType})`);

  // Determine file type and extract accordingly
  if (mimeType === 'application/pdf') {
    return extractFromPDF(fileBuffer);
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    return extractFromWord(fileBuffer);
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mimeType === 'application/vnd.ms-powerpoint'
  ) {
    return extractFromPowerPoint(fileBuffer, mimeType);
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    return extractFromExcel(fileBuffer);
  } else if (
    mimeType === 'image/jpeg' ||
    mimeType === 'image/png' ||
    mimeType === 'image/gif' ||
    mimeType === 'image/webp'
  ) {
    return extractFromImage(fileBuffer, mimeType);
  } else if (
    mimeType.startsWith('text/') ||
    fileName.endsWith('.txt') ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.json') ||
    fileName.endsWith('.js') ||
    fileName.endsWith('.py') ||
    fileName.endsWith('.java') ||
    fileName.endsWith('.c') ||
    fileName.endsWith('.cpp') ||
    fileName.endsWith('.ts') ||
    fileName.endsWith('.html') ||
    fileName.endsWith('.css') ||
    fileName.endsWith('.xml')
  ) {
    return extractFromText(fileBuffer, fileName);
  } else {
    // Unsupported file type
    console.warn(`Unsupported file type: ${mimeType} for file ${fileName}`);
    return {
      content_text: '',
      content_chunks: [],
      metadata: {
        extraction_method: 'unsupported',
        extraction_date: new Date().toISOString(),
        error: `Unsupported file type: ${mimeType}`
      }
    };
  }
}

/**
 * Process multiple files in batch
 */
export async function extractTextFromFiles(
  files: Array<{ buffer: Buffer; fileName: string; mimeType: string }>
): Promise<ProcessedDocument[]> {
  return Promise.all(
    files.map(file => extractTextFromFile(file.buffer, file.fileName, file.mimeType))
  );
}
