const pdfParse = require('pdf-parse');
import mammoth from 'mammoth';
import { OfficeParser } from 'officeparser';
import * as XLSX from 'xlsx';
import * as CFB from 'cfb';
import { Groq } from 'groq-sdk';
import { DOCUMENT_PROCESSING, OCR_CONFIG } from '../config/constants';
import { ocrDocument } from './ocrClient';

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
  let textLayerError: string | undefined;
  try {
    const collected: string[] = [];
    await pdfParse(fileBuffer, {
      pagerender: async (pageData: any) => {
        let text = '';
        try {
          const tc = await pageData.getTextContent();
          // Preserve line breaks (hasEOL) so chunking sees structure, not one blob.
          text = tc.items.map((it: any) => it.str + (it.hasEOL ? '\n' : ' ')).join('').trim();
        } catch {
          // A single page's failure must NOT drop it from `collected` — that would
          // misalign every later page number. Keep a placeholder to preserve order.
          text = '';
        }
        collected.push(text);
        return text;
      },
    });
    pageTexts = collected;
  } catch (error) {
    textLayerError = error instanceof Error ? error.message : 'Unknown error';
  }

  const scanned = needsOcr(pageTexts);

  // Pass 2: scanned or unreadable PDFs go to the OCR sidecar.
  if (scanned && OCR_CONFIG.ENABLED) {
    try {
      const ocrPages = await ocrDocument(fileBuffer, 'application/pdf');
      const pages = ocrPages.map(p => ({ page_number: p.page_number, text: p.markdown }));
      const content_text = pages.map(p => p.text).join('\n\n');
      if (content_text.trim().length === 0) {
        // Non-empty pages array but all blank markdown — treat as failure so we fall
        // through to the degraded text-layer branch (which flags extraction_degraded).
        throw new Error('OCR sidecar returned only blank pages');
      }
      return {
        content_text,
        content_chunks: chunkPages(pages),
        metadata: {
          page_count: pages.length,
          word_count: content_text.split(/\s+/).filter(w => w.length > 0).length,
          extraction_method: 'unlimited-ocr',
          extraction_date: new Date().toISOString(),
        },
      };
    } catch (ocrError) {
      console.error('OCR sidecar failed, falling back to text layer:', ocrError);
      // fall through to degraded text-layer result below
    }
  }

  const content_text = pageTexts.join('\n\n');
  const pages = pageTexts.map((text, i) => ({ page_number: i + 1, text }));
  return {
    content_text,
    content_chunks: chunkPages(pages),
    metadata: {
      page_count: pageTexts.length,
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

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) continue;

      const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: '',
        blankrows: false
      });

      if (rows.length === 0) continue;

      textParts.push(`\n--- Sheet: ${sheetName} ---\n`);

      // First row as headers
      if (rows.length > 0) {
        const headers = rows[0].map((cell: any) => String(cell || '').trim());
        textParts.push(`Headers: ${headers.join(' | ')}`);
      }

      // Data rows
      for (let i = 1; i < rows.length; i++) {
        const rowValues = rows[i]
          .map((cell: any) => String(cell || '').trim())
          .filter((val: string) => val.length > 0);

        if (rowValues.length > 0) {
          textParts.push(`Row ${i}: ${rowValues.join(' | ')}`);
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
    const chunks = chunkTextSemantic(content_text);

    return {
      content_text,
      content_chunks: chunks,
      metadata: {
        page_count,
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

/**
 * Extract text from an image: OCR sidecar first, Groq vision model as fallback.
 */
async function extractFromImage(fileBuffer: Buffer, mimeType: string): Promise<ProcessedDocument> {
  // Preferred path: local OCR sidecar.
  if (OCR_CONFIG.ENABLED) {
    try {
      const ocrPages = await ocrDocument(fileBuffer, mimeType);
      const content_text = ocrPages.map(p => p.markdown).join('\n\n').trim();
      if (content_text.length > 0) {
        return {
          content_text,
          content_chunks: chunkPages(ocrPages.map(p => ({ page_number: p.page_number, text: p.markdown }))),
          metadata: {
            word_count: content_text.split(/\s+/).filter(w => w.length > 0).length,
            extraction_method: 'unlimited-ocr',
            extraction_date: new Date().toISOString(),
          },
        };
      }
    } catch (error) {
      console.error('OCR sidecar failed for image, falling back to Groq vision:', error);
    }
  }

  // Fallback: Groq vision model.
  try {
    const apiKey = process.env.GROQ_API_KEY || process.env.AI_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY environment variable is not set');
    }

    const base64Data = fileBuffer.toString('base64');
    const groq = new Groq({ apiKey });

    const result = await groq.chat.completions.create({
      model: OCR_CONFIG.GROQ_VISION_FALLBACK_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Extract ALL text visible in this image. Include:
- All printed or typed text
- All handwritten text (if any)
- Text in tables, charts, or diagrams
- Labels, captions, headers, and footers

Return ONLY the extracted text, preserving the original structure and formatting as much as possible.
If the image contains a table, format it with pipe (|) delimiters.
If there is no readable text in the image, respond with exactly: "NO_TEXT_FOUND"`
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Data}` }
            }
          ]
        }
      ]
    });

    const content_text = result.choices[0]?.message?.content?.trim() || '';

    if (content_text === 'NO_TEXT_FOUND' || content_text.length === 0) {
      return {
        content_text: '',
        content_chunks: [],
        metadata: {
          extraction_method: 'groq-vision',
          extraction_date: new Date().toISOString(),
          error: 'Image contained no extractable text'
        }
      };
    }

    return {
      content_text,
      content_chunks: chunkTextSemantic(content_text),
      metadata: {
        word_count: content_text.split(/\s+/).filter(w => w.length > 0).length,
        extraction_method: 'groq-vision',
        extraction_date: new Date().toISOString(),
        extraction_degraded: OCR_CONFIG.ENABLED ? true : undefined,
      }
    };
  } catch (error) {
    console.error('Error extracting text from image:', error);
    return {
      content_text: '',
      content_chunks: [],
      metadata: {
        extraction_method: 'groq-vision',
        extraction_date: new Date().toISOString(),
        extraction_degraded: true,
        error: `Image OCR extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    };
  }
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
  const targetWords = DOCUMENT_PROCESSING.CHUNK_SIZE_WORDS;
  const overlapWords = DOCUMENT_PROCESSING.CHUNK_OVERLAP_WORDS;

  // Split into paragraphs first (preserve natural document structure)
  const rawParagraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  // Break any single paragraph longer than the target into word-sized sub-blocks,
  // so a newline-free page (e.g. a PDF page rendered as one blob) can't collapse
  // into a single oversized chunk.
  const paragraphs: string[] = [];
  for (const p of rawParagraphs) {
    const words = p.split(/\s+/).filter(w => w.length > 0);
    if (words.length <= targetWords) {
      paragraphs.push(p);
    } else {
      for (let i = 0; i < words.length; i += targetWords) {
        paragraphs.push(words.slice(i, i + targetWords).join(' '));
      }
    }
  }

  const chunks: DocumentChunk[] = [];
  let currentChunk = '';
  let chunkIndex = 0;
  let charOffset = 0;

  for (const paragraph of paragraphs) {
    const paragraphWords = paragraph.split(/\s+/).filter(w => w.length > 0);
    const currentWords = currentChunk.split(/\s+/).filter(w => w.length > 0);

    // If adding this paragraph exceeds target, save current chunk
    if (currentWords.length > 0 && currentWords.length + paragraphWords.length > targetWords) {
      chunks.push({
        chunk_id: `chunk_${chunkIndex}`,
        text: currentChunk.trim(),
        metadata: {
          start_char: charOffset,
          end_char: charOffset + currentChunk.length,
          chunk_index: chunkIndex
        }
      });

      chunkIndex++;
      charOffset += currentChunk.length;

      // Keep overlap from previous chunk (last N words)
      const overlapText = currentWords.slice(-overlapWords).join(' ');
      currentChunk = overlapText + '\n\n' + paragraph;
    } else {
      // Add paragraph to current chunk
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  // Add final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      chunk_id: `chunk_${chunkIndex}`,
      text: currentChunk.trim(),
      metadata: {
        start_char: charOffset,
        end_char: charOffset + currentChunk.length,
        chunk_index: chunkIndex
      }
    });
  }

  // Ensure at least one chunk exists
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
