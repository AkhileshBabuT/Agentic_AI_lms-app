# Ingestion + Retrieval + Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lossless OCR ingestion layer (Unlimited-OCR sidecar), two-stage retrieval (bge-m3 upgrade gated by an eval harness + local cross-encoder reranker), a global strict/external source-of-truth mode, and a score-explainer popover.

**Architecture:** The Node/Express backend keeps all orchestration; a new Python FastAPI sidecar (vLLM + Unlimited-OCR) handles OCR over HTTP. Retrieval stays pgvector cosine (stage 1) with an in-process transformers.js cross-encoder (stage 2). Settings are a single-row Postgres table read through a fail-closed cached service.

**Tech Stack:** TypeScript/Express/pg/pgvector, @xenova/transformers (transformers.js), vitest, React frontend; Python 3.10+/FastAPI/PyMuPDF/vLLM (sidecar, WSL2 or Docker on Windows).

**Spec:** `docs/specs/2026-07-24-ingestion-retrieval-trust.md`

## Global Constraints

- Repo root for all paths: `Agentic_AI_lms-app/`. Backend commands run from `backend/`, frontend from `frontend/`.
- Backend tests: **vitest** (`npx vitest run <path>`). No new test frameworks.
- Node `fetch` is global (Node ≥ 18) — do not add axios/node-fetch to the backend.
- No new backend npm dependencies in this plan. Sidecar Python deps live only in `ocr-sidecar/requirements.txt`.
- Migrations are forward-only, idempotent, and registered in `backend/src/db/migrations/runMigrations.ts` (they run on every boot — guard destructive statements).
- Default/failure mode for source-of-truth is `'strict'` — fail closed, never fail open.
- Env vars introduced: `OCR_SIDECAR_URL`, `OCR_ENABLED`, `VLLM_URL`, `OCR_MODEL_ID`, `EMBEDDING_MODEL_ID`, `EMBEDDING_DIMENSION`, `EMBEDDING_QUERY_PREFIX`, `RERANKER_ENABLED`, `RERANKER_MODEL_ID`.
- Commit after every task (working tree green: `npx tsc --noEmit` passes in backend, touched tests pass).
- Two model IDs must be verified against live registries before use (steps included): the Unlimited-OCR HF id, and the Groq vision model id. Do not trust the values written here without that check.

---

## Phase 0 — OCR ingestion

### Task 1: OCR sidecar service

**Files:**
- Create: `ocr-sidecar/server.py`
- Create: `ocr-sidecar/requirements.txt`
- Create: `ocr-sidecar/README.md`

**Interfaces:**
- Produces: `POST /ocr` body `{"file_b64": string, "mime_type": string}` → `200 {"pages": [{"page_number": int, "markdown": string}], "model": string}`; `GET /health` → `{"status": "ok"}`. Consumed by Task 2's `ocrClient.ts`.

- [ ] **Step 1: Verify the model exists and fits**

Run (any shell):
```bash
# Find the exact HF repo id — search "Unlimited-OCR" on huggingface.co.
# Expected: an official Baidu repo (e.g. baidu/Unlimited-OCR). Record the exact id.
# Also record its VRAM guidance from the model card.
```
Decision rule: if the model card's minimum VRAM exceeds the local GPU, use `PaddlePaddle/PaddleOCR-VL` as `OCR_MODEL_ID` instead — everything below is model-id-agnostic. Write the chosen id into `ocr-sidecar/README.md`.

- [ ] **Step 2: Write requirements.txt**

```
fastapi==0.115.*
uvicorn==0.30.*
pymupdf==1.24.*
openai==1.*
```
(vLLM is installed separately in WSL2/Docker per README — it is the model server, not a wrapper dep.)

- [ ] **Step 3: Write server.py**

```python
"""OCR sidecar: rasterizes documents and OCRs pages via a local vLLM server.

Env:
  VLLM_URL      OpenAI-compatible base URL of the vLLM server (default http://localhost:8000/v1)
  OCR_MODEL_ID  model id served by vLLM (must match `vllm serve <id>`)
"""
import base64
import os

import fitz  # PyMuPDF
from fastapi import FastAPI, HTTPException
from openai import OpenAI
from pydantic import BaseModel

app = FastAPI()
client = OpenAI(base_url=os.environ.get("VLLM_URL", "http://localhost:8000/v1"), api_key="unused")
MODEL_ID = os.environ.get("OCR_MODEL_ID", "baidu/Unlimited-OCR")  # verified in Task 1 Step 1

PAGE_PROMPT = (
    "Convert this document page to clean Markdown. Preserve all text, headings, "
    "reading order, tables (as Markdown tables), and formulas (as LaTeX). "
    "Output ONLY the Markdown, no commentary."
)


class OcrRequest(BaseModel):
    file_b64: str
    mime_type: str


def _rasterize(data: bytes, mime_type: str) -> list[bytes]:
    """Return one PNG per page."""
    if mime_type == "application/pdf":
        doc = fitz.open(stream=data, filetype="pdf")
        # 2x zoom ~ 144 dpi: enough for print text without exploding VRAM
        return [page.get_pixmap(matrix=fitz.Matrix(2, 2)).tobytes("png") for page in doc]
    return [data]  # already an image


def _ocr_page(png: bytes) -> str:
    result = client.chat.completions.create(
        model=MODEL_ID,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": PAGE_PROMPT},
                {"type": "image_url", "image_url": {
                    "url": f"data:image/png;base64,{base64.b64encode(png).decode()}"}},
            ],
        }],
        temperature=0.0,
        max_tokens=8192,
    )
    return (result.choices[0].message.content or "").strip()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ocr")
def ocr(req: OcrRequest):
    try:
        data = base64.b64decode(req.file_b64)
        pngs = _rasterize(data, req.mime_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read document: {e}")
    if not pngs:
        raise HTTPException(status_code=400, detail="Document has no pages")
    # ponytail: sequential per-page calls; batch pages per request if throughput matters
    pages = [{"page_number": i + 1, "markdown": _ocr_page(png)} for i, png in enumerate(pngs)]
    return {"pages": pages, "model": MODEL_ID}
```

- [ ] **Step 4: Write README.md**

```markdown
# OCR sidecar

Two processes:

1. **vLLM model server** (WSL2 or Docker — vLLM needs Linux + CUDA):
   pip install vllm && vllm serve <OCR_MODEL_ID> --port 8000
   Model id: <fill from Task 1 Step 1>. Fallback if VRAM-constrained: PaddlePaddle/PaddleOCR-VL.
2. **This wrapper** (any OS):
   pip install -r requirements.txt
   uvicorn server:app --port 8100

Backend env: OCR_SIDECAR_URL=http://localhost:8100
Contract: POST /ocr {file_b64, mime_type} -> {pages: [{page_number, markdown}], model}
```

- [ ] **Step 5: Smoke test**

With vLLM serving the model and `uvicorn server:app --port 8100` running:
```bash
python - <<'EOF'
import base64, json, urllib.request
pdf = open("any-scanned-test.pdf", "rb").read()
body = json.dumps({"file_b64": base64.b64encode(pdf).decode(), "mime_type": "application/pdf"}).encode()
req = urllib.request.Request("http://localhost:8100/ocr", body, {"Content-Type": "application/json"})
out = json.load(urllib.request.urlopen(req, timeout=600))
print(out["model"], len(out["pages"]), out["pages"][0]["markdown"][:200])
EOF
```
Expected: model id, page count, readable Markdown of page 1. If the vLLM chat template rejects image content, consult the model card's serving instructions (some OCR models need `--chat-template` flags) and record the fix in README.md.

- [ ] **Step 6: Commit**

```bash
git add ocr-sidecar/
git commit -m "feat: Unlimited-OCR sidecar (FastAPI wrapper over local vLLM)"
```

---

### Task 2: OCR config + Node client

**Files:**
- Modify: `backend/src/config/constants.ts` (append new block after `DOCUMENT_PROCESSING`)
- Create: `backend/src/services/ocrClient.ts`
- Test: `backend/src/services/__tests__/ocrClient.test.ts`

**Interfaces:**
- Produces: `OCR_CONFIG` constant; `ocrDocument(fileBuffer: Buffer, mimeType: string): Promise<OcrPage[]>` where `OcrPage = { page_number: number; markdown: string }`. Throws on any failure (caller decides fallback). Consumed by Task 3 and Task 4.

- [ ] **Step 1: Add OCR_CONFIG to constants.ts**

Insert after the `DOCUMENT_PROCESSING` block:
```typescript
// =====================================================
// OCR SIDECAR CONFIGURATION (Unlimited-OCR)
// =====================================================
export const OCR_CONFIG = {
  /** OCR is used only when a sidecar URL is configured (and not force-disabled) */
  ENABLED: !!process.env.OCR_SIDECAR_URL && process.env.OCR_ENABLED !== 'false',

  /** Base URL of the FastAPI OCR sidecar */
  SIDECAR_URL: process.env.OCR_SIDECAR_URL || 'http://localhost:8100',

  /** PDFs averaging fewer words per page than this are treated as scanned -> OCR */
  MIN_WORDS_PER_PAGE: 40,

  /** Whole-document OCR timeout (large scanned decks are slow) */
  TIMEOUT_MS: 300_000,
} as const;
```

- [ ] **Step 2: Write the failing test**

`backend/src/services/__tests__/ocrClient.test.ts`:
```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `backend/`): `npx vitest run src/services/__tests__/ocrClient.test.ts`
Expected: FAIL — `Cannot find module '../ocrClient'`.

- [ ] **Step 4: Write ocrClient.ts**

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/ocrClient.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/constants.ts backend/src/services/ocrClient.ts backend/src/services/__tests__/ocrClient.test.ts
git commit -m "feat: OCR sidecar client + config"
```

---

### Task 3: PDF routing, per-page extraction, page-number fix

**Files:**
- Modify: `backend/src/services/documentProcessor.ts`
- Test: `backend/src/services/__tests__/documentProcessor.test.ts`

**Interfaces:**
- Consumes: `ocrDocument`, `OcrPage` (Task 2); `OCR_CONFIG` (Task 2).
- Produces: exported helpers `needsOcr(pageTexts: string[]): boolean` and `chunkPages(pages: Array<{ page_number: number; text: string }>): DocumentChunk[]`; `ProcessedDocument.metadata` gains `extraction_degraded?: boolean`; `extraction_method` union gains `'unlimited-ocr' | 'groq-vision'`. Task 5's upload flow and existing callers are unchanged (same `extractTextFromFile` signature).

- [ ] **Step 1: Write the failing tests**

`backend/src/services/__tests__/documentProcessor.test.ts`:
```typescript
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/documentProcessor.test.ts`
Expected: FAIL — `needsOcr`/`chunkPages` are not exported.

- [ ] **Step 3: Implement in documentProcessor.ts**

3a. Add imports at the top:
```typescript
import { DOCUMENT_PROCESSING, OCR_CONFIG } from '../config/constants';
import { ocrDocument } from './ocrClient';
```
(replacing the existing `import { DOCUMENT_PROCESSING } ...` line).

3b. Widen the metadata type — in `ProcessedDocument`, replace the `extraction_method` line and add the degraded flag:
```typescript
    extraction_method: 'pdf-parse' | 'mammoth' | 'text' | 'officeparser-pptx' | 'xlsx'
      | 'gemini-ocr' | 'unlimited-ocr' | 'groq-vision' | 'unsupported';
    extraction_degraded?: boolean;
```

3c. Add the two helpers (place directly above `chunkTextSemantic`):
```typescript
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
```

3d. Replace the entire body of `extractFromPDF` (lines 41–123 of the current file) with:
```typescript
async function extractFromPDF(fileBuffer: Buffer): Promise<ProcessedDocument> {
  // Pass 1: text layer, collected per page so chunks get real page numbers.
  let pageTexts: string[] = [];
  let textLayerError: string | undefined;
  try {
    const collected: string[] = [];
    await pdfParse(fileBuffer, {
      pagerender: async (pageData: any) => {
        const tc = await pageData.getTextContent();
        const text = tc.items.map((it: any) => it.str).join(' ');
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/services/__tests__/documentProcessor.test.ts && npx tsc --noEmit`
Expected: 5 passed; tsc clean.

- [ ] **Step 5: Manual verification with a real scanned PDF**

With the sidecar up and `OCR_SIDECAR_URL` set, upload a scanned PDF via the professor UI (or re-run any existing upload flow) and confirm the console logs show chunks > 0 and the stored `metadata.extraction_method` is `unlimited-ocr`:
```sql
SELECT metadata->>'extraction_method', jsonb_array_length(content_chunks::jsonb)
FROM course_material_content ORDER BY last_indexed_at DESC LIMIT 1;
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/documentProcessor.ts backend/src/services/__tests__/documentProcessor.test.ts
git commit -m "feat: OCR routing for scanned PDFs + real page numbers in chunks"
```

---

### Task 4: Image extraction via sidecar, fix dead Groq vision model

**Files:**
- Modify: `backend/src/services/documentProcessor.ts` (function `extractFromImage`)
- Modify: `backend/src/config/constants.ts` (append to `OCR_CONFIG`)

**Interfaces:**
- Consumes: `ocrDocument` (Task 2), `chunkPages` (Task 3).
- Produces: images extract via `'unlimited-ocr'` (sidecar) or `'groq-vision'` (fallback). Same `ProcessedDocument` contract.

- [ ] **Step 1: Verify the current Groq vision model id**

Check https://console.groq.com/docs/models for the current production vision model. As of writing this plan the expected id is `meta-llama/llama-4-scout-17b-16e-instruct`. Use whatever the docs list today.

- [ ] **Step 2: Add the fallback model to OCR_CONFIG**

Append inside the `OCR_CONFIG` object:
```typescript
  /** Groq vision model used for images when the sidecar is down (verify against console.groq.com/docs/models) */
  GROQ_VISION_FALLBACK_MODEL: process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
```

- [ ] **Step 3: Rewrite extractFromImage**

Replace the whole function with (the Groq prompt/plumbing is the existing code, only the model id, method label, and sidecar-first routing change):
```typescript
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
```

- [ ] **Step 4: Typecheck + existing tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; all tests pass.

- [ ] **Step 5: Manual check**

Upload a PNG with text via the professor UI. Expected: extraction succeeds (either method); with the sidecar stopped, the Groq fallback path succeeds (it was 100% broken before this task).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/documentProcessor.ts backend/src/config/constants.ts
git commit -m "fix: image OCR via sidecar with current Groq vision fallback (old model was decommissioned)"
```

---

## Phase 1 — Retrieval accuracy

### Task 5: Config-driven embedding model (no behavior change)

**Files:**
- Modify: `backend/src/config/constants.ts` (`EMBEDDING_CONFIG`, `SCORING`)
- Modify: `backend/src/services/embeddingService.ts`
- Test: `backend/src/services/__tests__/embeddingConfig.test.ts`

**Interfaces:**
- Produces: `EMBEDDING_CONFIG.MODEL_ID`, `EMBEDDING_CONFIG.QUERY_PREFIX`, `EMBEDDING_CONFIG.EMBEDDING_DIMENSION` (all env-overridable). `generateEmbedding` now throws on dimension mismatch (the half-migrated-DB guard). `SCORING.BGE_QUERY_PREFIX` is removed — `embeddingService.ts` was its only consumer (verify: `grep -r BGE_QUERY_PREFIX backend/src`).

- [ ] **Step 1: Update EMBEDDING_CONFIG in constants.ts**

Replace the `EMBEDDING_CONFIG` block with:
```typescript
export const EMBEDDING_CONFIG = {
  /** Local transformers.js embedding model (a change requires a full reindex — see reindexEmbeddings.ts) */
  MODEL_ID: process.env.EMBEDDING_MODEL_ID || 'Xenova/bge-base-en-v1.5',

  /** Asymmetric query prefix. bge-base-en-v1.5 requires it; bge-m3 uses '' (set via env on migration). */
  QUERY_PREFIX: process.env.EMBEDDING_QUERY_PREFIX
    ?? 'Represent this sentence for searching relevant passages: ',

  /** Must match both the model output and the pgvector column dimension */
  EMBEDDING_DIMENSION: parseInt(process.env.EMBEDDING_DIMENSION || '768', 10),

  /** Batch size for embedding generation */
  BATCH_SIZE: 5,

  /** Delay between batches in milliseconds */
  BATCH_DELAY_MS: 500,

  /** Maximum cache size for in-memory embedding cache */
  CACHE_MAX_SIZE: 1000,
} as const;
```
Delete the `BGE_QUERY_PREFIX` line (and its comment) from `SCORING`.

- [ ] **Step 2: Write the failing test**

`backend/src/services/__tests__/embeddingConfig.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { EMBEDDING_CONFIG } from '../../config/constants';

describe('EMBEDDING_CONFIG', () => {
  it('defaults to bge-base with its asymmetric prefix and 768 dims', () => {
    expect(EMBEDDING_CONFIG.MODEL_ID).toBe('Xenova/bge-base-en-v1.5');
    expect(EMBEDDING_CONFIG.QUERY_PREFIX).toContain('Represent this sentence');
    expect(EMBEDDING_CONFIG.EMBEDDING_DIMENSION).toBe(768);
  });
});
```
(Guard behavior is exercised implicitly: after the Task 9 migration, a wrong `EMBEDDING_DIMENSION` fails every embed loudly instead of silently serving garbage.)

- [ ] **Step 3: Run test — expect FAIL** (config fields don't exist yet if Step 1 skipped; if Step 1 done, expect PASS — order Steps 1→2 as written and this is a plain regression test).

Run: `npx vitest run src/services/__tests__/embeddingConfig.test.ts`

- [ ] **Step 4: Update embeddingService.ts**

- Change the import to `import { EMBEDDING_CONFIG } from '../config/constants';`
- In `getPipeline`, replace the hardcoded model string:
```typescript
    logToFile(`Initializing Xenova local embedding model: ${EMBEDDING_CONFIG.MODEL_ID}`);
    embeddingPipeline = await pipeline('feature-extraction', EMBEDDING_CONFIG.MODEL_ID, {
      quantized: true,
    });
```
- In `generateEmbedding`, after `const embedding = Array.from(result.data) as number[];` (introduce that local), add the guard before returning:
```typescript
    if (embedding.length !== EMBEDDING_CONFIG.EMBEDDING_DIMENSION) {
      throw new Error(
        `Embedding dimension mismatch: model produced ${embedding.length}, ` +
        `config expects ${EMBEDDING_CONFIG.EMBEDDING_DIMENSION}. ` +
        `Check EMBEDDING_MODEL_ID/EMBEDDING_DIMENSION and reindex.`
      );
    }
    return embedding;
```
- In `embedQuery`, replace `SCORING.BGE_QUERY_PREFIX` with `EMBEDDING_CONFIG.QUERY_PREFIX` and drop the now-unused `SCORING` import.

- [ ] **Step 5: Typecheck + full test run**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean. Behavior is identical to before (same model, same prefix, same dims).

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/constants.ts backend/src/services/embeddingService.ts backend/src/services/__tests__/embeddingConfig.test.ts
git commit -m "refactor: config-driven embedding model with dimension guard"
```

---

### Task 6: Retrieval eval harness

**Files:**
- Create: `backend/eval/retrieval-eval.json`
- Create: `backend/src/scripts/evalRetrieval.ts`

**Interfaces:**
- Consumes: `searchCourseMaterials` (`vectorSearch.ts`), `rerank` (Task 7 — the `rerank` pipeline mode errors helpfully until Task 7 lands), `@xenova/transformers` directly for candidate models.
- Produces: console report of Recall@5 and MRR per pipeline. This is the **gate** for Task 9.

- [ ] **Step 1: Create the eval set template**

`backend/eval/retrieval-eval.json`:
```json
{
  "_instructions": "Fill with >=10 real course questions. Each case: question, course_id, and ONE of expect_material_id (the material that answers it) or expect_substring (text that must appear in a correct chunk). The harness refuses to run with fewer than 10 cases.",
  "cases": [
    {
      "question": "EXAMPLE — What is the time complexity of binary search?",
      "course_id": 1,
      "expect_substring": "O(log n)"
    },
    {
      "question": "EXAMPLE — Which chapter covers normalization?",
      "course_id": 1,
      "expect_material_id": 12
    }
  ]
}
```
Then **populate it with real questions** against real uploaded course materials (ask the course owner / use materials already in the dev DB). Delete the EXAMPLE entries.

- [ ] **Step 2: Write evalRetrieval.ts**

```typescript
/**
 * Retrieval eval harness — the gate for embedding-model migration.
 *
 * Usage (from backend/):
 *   npx ts-node src/scripts/evalRetrieval.ts --pipeline baseline
 *   npx ts-node src/scripts/evalRetrieval.ts --pipeline rerank
 *   npx ts-node src/scripts/evalRetrieval.ts --pipeline candidate --model Xenova/bge-m3
 *
 * Reports Recall@5 and MRR@5. "candidate" embeds the course's chunks in memory
 * with the given model (no DB migration needed to evaluate a new model).
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { pool } from '../config/database';
import { searchCourseMaterials } from '../services/vectorSearch';

interface EvalCase {
  question: string;
  course_id: number;
  expect_material_id?: number;
  expect_substring?: string;
}

interface RankedChunk {
  material_id: number;
  chunk_text: string;
}

const TOP_K = 5;

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isHit(c: EvalCase, chunk: RankedChunk): boolean {
  if (c.expect_material_id != null) return chunk.material_id === c.expect_material_id;
  if (c.expect_substring) return chunk.chunk_text.toLowerCase().includes(c.expect_substring.toLowerCase());
  return false;
}

async function baselineTop(c: EvalCase, k: number): Promise<RankedChunk[]> {
  const results = await searchCourseMaterials(c.course_id, c.question, { topK: k, minSimilarity: 0 });
  return results.map(r => ({ material_id: r.material_id, chunk_text: r.chunk_text }));
}

async function rerankTop(c: EvalCase): Promise<RankedChunk[]> {
  const { rerank } = await import('../services/rerankerService');
  const stage1 = await baselineTop(c, 30);
  return rerank(c.question, stage1, x => x.chunk_text, TOP_K);
}

async function candidateTop(c: EvalCase, modelId: string, cache: Map<number, any>): Promise<RankedChunk[]> {
  const { pipeline } = await import('@xenova/transformers');
  if (!cache.has(-1)) cache.set(-1, await pipeline('feature-extraction', modelId, { quantized: true }));
  const embed = cache.get(-1);
  const toVec = async (text: string): Promise<number[]> => {
    const out = await embed(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data) as number[];
  };

  if (!cache.has(c.course_id)) {
    const rows = await pool.query(
      `SELECT cme.material_id, cme.chunk_text
       FROM course_material_embeddings cme
       JOIN course_materials cm ON cme.material_id = cm.id
       WHERE cm.course_id = $1`,
      [c.course_id]
    );
    const chunks: Array<RankedChunk & { vec: number[] }> = [];
    for (const row of rows.rows) {
      chunks.push({ material_id: row.material_id, chunk_text: row.chunk_text, vec: await toVec(row.chunk_text) });
    }
    cache.set(c.course_id, chunks);
    console.log(`  (embedded ${chunks.length} chunks for course ${c.course_id} with ${modelId})`);
  }

  const qv = await toVec(c.question); // bge-m3 needs no query prefix; if evaluating a prefix model, prepend it here
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0); // vectors are normalized
  return (cache.get(c.course_id) as Array<RankedChunk & { vec: number[] }>)
    .map(ch => ({ ...ch, score: dot(qv, ch.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map(({ material_id, chunk_text }) => ({ material_id, chunk_text }));
}

async function main() {
  const pipelineName = argOf('--pipeline') || 'baseline';
  const modelId = argOf('--model') || 'Xenova/bge-m3';

  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../eval/retrieval-eval.json'), 'utf8'));
  const cases: EvalCase[] = (raw.cases || []).filter((c: EvalCase) => !c.question.startsWith('EXAMPLE'));
  if (cases.length < 10) {
    console.error(`Need >=10 real eval cases, found ${cases.length}. Populate backend/eval/retrieval-eval.json first.`);
    process.exit(1);
  }

  const candidateCache = new Map<number, any>();
  let hits = 0;
  let mrrSum = 0;

  for (const c of cases) {
    const top =
      pipelineName === 'rerank' ? await rerankTop(c)
      : pipelineName === 'candidate' ? await candidateTop(c, modelId, candidateCache)
      : await baselineTop(c, TOP_K);

    const rank = top.findIndex(ch => isHit(c, ch));
    if (rank >= 0) { hits++; mrrSum += 1 / (rank + 1); }
    console.log(`${rank >= 0 ? 'HIT ' : 'MISS'} rank=${rank >= 0 ? rank + 1 : '-'}  ${c.question.slice(0, 70)}`);
  }

  console.log('\n================ RESULTS ================');
  console.log(`pipeline:  ${pipelineName}${pipelineName === 'candidate' ? ` (${modelId})` : ''}`);
  console.log(`cases:     ${cases.length}`);
  console.log(`Recall@5:  ${(hits / cases.length).toFixed(3)}`);
  console.log(`MRR@5:     ${(mrrSum / cases.length).toFixed(3)}`);
  await pool.end();
}

main();
```

- [ ] **Step 3: Run the baseline**

Run: `npx ts-node src/scripts/evalRetrieval.ts --pipeline baseline`
Expected: per-case HIT/MISS lines and a results block. **Record Recall@5 and MRR@5** in the commit message — they're the baseline every later stage must beat.

- [ ] **Step 4: Commit**

```bash
git add backend/eval/retrieval-eval.json backend/src/scripts/evalRetrieval.ts
git commit -m "feat: retrieval eval harness (baseline Recall@5=<X> MRR@5=<Y>)"
```

---

### Task 7: Cross-encoder reranker

**Files:**
- Modify: `backend/src/config/constants.ts` (new `RERANKER_CONFIG`)
- Create: `backend/src/services/rerankerService.ts`
- Test: `backend/src/services/__tests__/rerankerService.test.ts`
- Modify: `backend/src/services/agents/SubjectChatbotAgent.ts`

**Interfaces:**
- Produces: `rerank<T>(query: string, items: T[], getText: (item: T) => string, topN: number): Promise<T[]>` — never throws; on model failure returns `items.slice(0, topN)` (stage-1 vector order). Consumed by Task 6's `rerank` pipeline and the chatbot agent.

- [ ] **Step 1: Verify the reranker model id**

Check huggingface.co for a transformers.js-compatible (ONNX) build of `bge-reranker-v2-m3` (e.g. `Xenova/bge-reranker-v2-m3`). If none exists, the default stays `Xenova/bge-reranker-base` (known-good ONNX); v2-m3 becomes an env override later.

- [ ] **Step 2: Add RERANKER_CONFIG to constants.ts**

Insert after `EMBEDDING_CONFIG`:
```typescript
// =====================================================
// RERANKER CONFIGURATION (stage-2 retrieval precision)
// =====================================================
export const RERANKER_CONFIG = {
  ENABLED: process.env.RERANKER_ENABLED !== 'false',

  /** Local transformers.js cross-encoder (ponytail: base model; set RERANKER_MODEL_ID to a v2-m3 ONNX build when available) */
  MODEL_ID: process.env.RERANKER_MODEL_ID || 'Xenova/bge-reranker-base',

  /** Truncate each document to this many chars before scoring (cross-encoders are O(pair)) */
  MAX_DOC_CHARS: 2000,
} as const;
```

- [ ] **Step 3: Write the failing test**

`backend/src/services/__tests__/rerankerService.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';

// Force model load to fail so we exercise the fail-open path deterministically.
vi.mock('@xenova/transformers', () => ({
  AutoTokenizer: { from_pretrained: vi.fn().mockRejectedValue(new Error('no model')) },
  AutoModelForSequenceClassification: { from_pretrained: vi.fn().mockRejectedValue(new Error('no model')) },
}));

import { rerank } from '../rerankerService';

describe('rerank', () => {
  it('returns items unchanged when already <= topN', async () => {
    const items = [{ t: 'a' }, { t: 'b' }];
    expect(await rerank('q', items, x => x.t, 5)).toEqual(items);
  });

  it('falls back to stage-1 order when the model fails', async () => {
    const items = [{ t: 'first' }, { t: 'second' }, { t: 'third' }];
    expect(await rerank('q', items, x => x.t, 2)).toEqual([{ t: 'first' }, { t: 'second' }]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/services/__tests__/rerankerService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Write rerankerService.ts**

```typescript
import { AutoTokenizer, AutoModelForSequenceClassification } from '@xenova/transformers';
import { RERANKER_CONFIG } from '../config/constants';

let loaded: Promise<{ tokenizer: any; model: any }> | null = null;

function load() {
  if (!loaded) {
    loaded = (async () => {
      const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_CONFIG.MODEL_ID);
      const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_CONFIG.MODEL_ID, {
        quantized: true,
      });
      return { tokenizer, model };
    })();
    // A failed load must not poison every later call into the fallback forever.
    loaded.catch(() => { loaded = null; });
  }
  return loaded;
}

/**
 * Stage-2 precision: cross-encoder re-scores stage-1 vector hits.
 * Never throws — any failure degrades to the stage-1 (vector similarity) order.
 */
export async function rerank<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  topN: number
): Promise<T[]> {
  if (items.length <= topN) return items;
  try {
    const { tokenizer, model } = await load();
    const scored: Array<{ item: T; score: number }> = [];
    for (const item of items) {
      const inputs = tokenizer(query, {
        text_pair: getText(item).slice(0, RERANKER_CONFIG.MAX_DOC_CHARS),
        truncation: true,
      });
      const { logits } = await model(inputs);
      scored.push({ item, score: logits.data[0] as number });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topN).map(s => s.item);
  } catch (error) {
    console.error('Reranker failed, using vector order:', error);
    return items.slice(0, topN);
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/rerankerService.test.ts`
Expected: 2 passed.

- [ ] **Step 7: Wire into SubjectChatbotAgent**

In `backend/src/services/agents/SubjectChatbotAgent.ts`:

7a. Add imports:
```typescript
import { rerank } from '../rerankerService';
import { RERANKER_CONFIG } from '../../config/constants';
```
(merge the second into the existing `AGENT_CONFIG, VECTOR_SEARCH, EMOTIONAL_FILTER_CONFIG` import.)

7b. Directly after the `const relevantMaterials = await this.searchCourseMaterials(...)` call (~line 213), add:
```typescript
      // Stage 2: cross-encoder precision over the vector recall set.
      const rankedMaterials = RERANKER_CONFIG.ENABLED
        ? await rerank(
            message.content,
            relevantMaterials,
            m => m.content_text || '',
            AGENT_CONFIG.CHATBOT_PROMPT_MAX_CHUNKS
          )
        : relevantMaterials;
```

7c. In the rest of `processMessage`, replace uses of `relevantMaterials` with `rankedMaterials` in exactly these places: the `enhancedContext.relevantMaterials` assignment, the `buildGroundedQuestion(...)` call, and the `extractSources(...)` call. **Keep** `relevantMaterials` (full recall set) in `WebSearchService.shouldSearchWeb(relevantMaterials, ...)` and in the `materialsSearched` metadata count.

- [ ] **Step 8: Typecheck, run all tests, then eval**

Run: `npx tsc --noEmit && npx vitest run`
Then: `npx ts-node src/scripts/evalRetrieval.ts --pipeline rerank`
Expected: Recall@5 / MRR@5 ≥ baseline (literature says +10pp typical; first run also downloads the ONNX model). If it's *worse* on your in-domain set, set `RERANKER_ENABLED=false` in `.env` and flag it in the commit message — the wiring stays, the switch decides.

- [ ] **Step 9: Commit**

```bash
git add backend/src/config/constants.ts backend/src/services/rerankerService.ts backend/src/services/__tests__/rerankerService.test.ts backend/src/services/agents/SubjectChatbotAgent.ts
git commit -m "feat: cross-encoder reranker stage over pgvector recall (rerank Recall@5=<X> MRR@5=<Y>)"
```

---

### Task 8: Candidate-model eval (the migration gate)

**Files:** none created — this task runs the harness and records a decision.

- [ ] **Step 1: Run the candidate eval**

Run: `npx ts-node src/scripts/evalRetrieval.ts --pipeline candidate --model Xenova/bge-m3`
(First run downloads bge-m3 ONNX — ~400MB quantized; embedding the corpus in memory takes minutes, that's fine.)

- [ ] **Step 2: Decide**

**Gate rule:** proceed to Task 9 only if the candidate's Recall@5 **and** MRR@5 are ≥ the Task 6 baseline. Otherwise **skip Task 9 entirely** (reranker-only ships; the DB stays 768d) and record the numbers in `docs/specs/2026-07-24-ingestion-retrieval-trust.md` under a new "## Eval results" heading.

- [ ] **Step 3: Record results**

Append to the spec file:
```markdown
## Eval results (2026-XX-XX)

| pipeline | Recall@5 | MRR@5 |
|---|---|---|
| baseline (bge-base 768d) | X | Y |
| baseline + reranker | X | Y |
| candidate bge-m3 (in-memory) | X | Y |

Decision: <migrate to bge-m3 | stay on bge-base, reranker-only>
```

```bash
git add docs/specs/2026-07-24-ingestion-retrieval-trust.md
git commit -m "docs: retrieval eval results + migration decision"
```

---

### Task 9: bge-m3 migration + full reindex (ONLY if Task 8 gate passed)

**Files:**
- Create: `backend/src/db/migrations/vector-1024-migration.sql`
- Modify: `backend/src/db/migrations/runMigrations.ts`
- Modify: `backend/src/scripts/reindexEmbeddings.ts`
- Modify: `backend/.env` (and `.env.example` if present)

**Interfaces:**
- Consumes: `EMBEDDING_CONFIG` env overrides (Task 5).
- Produces: `course_material_embeddings.embedding` is `vector(1024)`; all chunks re-embedded; `reindexEmbeddings.ts` gains an `--all` flag (re-embed everything, not just missing).

- [ ] **Step 1: Write the migration**

`backend/src/db/migrations/vector-1024-migration.sql`:
```sql
-- Forward-only: 768d (bge-base-en-v1.5) -> 1024d (bge-m3).
-- Idempotent: runs on every boot; the DO-block only acts when the column is not yet 1024d.
-- Destructive by design: old-dimension embeddings are useless, so they are deleted;
-- reindexEmbeddings.ts --all rebuilds them from course_material_content.
DO $$
DECLARE
  current_dim int;
BEGIN
  SELECT atttypmod INTO current_dim
  FROM pg_attribute
  WHERE attrelid = 'course_material_embeddings'::regclass
    AND attname = 'embedding';

  IF current_dim IS DISTINCT FROM 1024 THEN
    DELETE FROM course_material_embeddings;
    DROP INDEX IF EXISTS idx_embeddings_vector_cosine;
    ALTER TABLE course_material_embeddings
      ALTER COLUMN embedding TYPE vector(1024);
    CREATE INDEX idx_embeddings_vector_cosine
      ON course_material_embeddings
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  END IF;
END $$;
```
Note: pgvector stores the dimension as the column's `atttypmod`. Verify on your DB before first run:
`SELECT atttypmod FROM pg_attribute WHERE attrelid='course_material_embeddings'::regclass AND attname='embedding';` — expected `768` pre-migration. If it returns anything else (e.g. `772`), adjust the `1024` comparison to match the same offset convention (`1028`).

- [ ] **Step 2: Register it in runMigrations.ts**

Append before the `catch`:
```typescript
    // Migration 7: 1024-dim embeddings (bge-m3). Idempotent; destructive only on first run.
    const vector1024Path = path.join(__dirname, 'vector-1024-migration.sql');
    await client.query(fs.readFileSync(vector1024Path, 'utf8'));
    console.log('✓ Vector 1024 migration completed successfully');
```

- [ ] **Step 3: Add --all to reindexEmbeddings.ts**

Replace the SELECT in Step 1 of that script with:
```typescript
    const reindexAll = process.argv.includes('--all');
    const result = await pool.query(`
      SELECT
        cmc.material_id,
        cm.file_name,
        cmc.content_chunks
      FROM course_material_content cmc
      JOIN course_materials cm ON cmc.material_id = cm.id
      LEFT JOIN course_material_embeddings cme ON cmc.material_id = cme.material_id
      WHERE cmc.content_text IS NOT NULL
        AND cmc.content_text != ''
        AND cmc.content_chunks IS NOT NULL
      GROUP BY cmc.material_id, cm.file_name, cmc.content_chunks
      ${reindexAll ? '' : 'HAVING COUNT(cme.id) = 0'}
    `);
```
And update the usage comment at the top: `Usage: npx ts-node src/scripts/reindexEmbeddings.ts [--all]`.

- [ ] **Step 4: Flip the env config**

In `backend/.env` add:
```
EMBEDDING_MODEL_ID=Xenova/bge-m3
EMBEDDING_DIMENSION=1024
EMBEDDING_QUERY_PREFIX=
```
(bge-m3 is symmetric — empty prefix. The `??` in Task 5's config makes the empty string stick.)

- [ ] **Step 5: Run migration + reindex**

```bash
npm run dev   # boots, runs migrations; watch for "✓ Vector 1024 migration" — then stop it
npx ts-node src/scripts/reindexEmbeddings.ts --all
```
Expected: every material re-embedded; final count equals total chunk count.

- [ ] **Step 6: Re-run the eval against the migrated DB**

```bash
npx ts-node src/scripts/evalRetrieval.ts --pipeline baseline   # now = bge-m3 through pgvector
npx ts-node src/scripts/evalRetrieval.ts --pipeline rerank
```
Expected: matches (±noise) the in-memory candidate numbers from Task 8. If dramatically worse, the query prefix env is the first suspect.

- [ ] **Step 7: Commit**

```bash
git add backend/src/db/migrations/vector-1024-migration.sql backend/src/db/migrations/runMigrations.ts backend/src/scripts/reindexEmbeddings.ts
git commit -m "feat: migrate embeddings to bge-m3 1024d + full reindex (post-migration Recall@5=<X>)"
```

---

## Phase 2 — Source-of-truth mode

### Task 10: app_settings storage + fail-closed settings service

**Files:**
- Create: `backend/src/db/migrations/app-settings-schema.sql`
- Modify: `backend/src/db/migrations/runMigrations.ts`
- Create: `backend/src/services/settingsService.ts`
- Test: `backend/src/services/__tests__/settingsService.test.ts`

**Interfaces:**
- Produces: `type SourceOfTruthMode = 'strict' | 'external'`; `getSourceOfTruthMode(): Promise<SourceOfTruthMode>` (60s cache, `'strict'` on ANY error); `setSourceOfTruthMode(mode: SourceOfTruthMode, userId: number): Promise<void>` (updates + audit row + cache bust); `clearSettingsCache(): void` (tests). Consumed by Tasks 11, 12, 13.

- [ ] **Step 1: Write the migration**

`backend/src/db/migrations/app-settings-schema.sql`:
```sql
-- Global application settings: single row, id locked to 1.
CREATE TABLE IF NOT EXISTS app_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source_of_truth_mode TEXT NOT NULL DEFAULT 'strict'
    CHECK (source_of_truth_mode IN ('strict', 'external')),
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Audit trail: who flipped what, when.
CREATE TABLE IF NOT EXISTS app_settings_audit (
  id SERIAL PRIMARY KEY,
  setting_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  changed_by INT REFERENCES users(id),
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```
Register in `runMigrations.ts` (same pattern as Task 9 Step 2, label "Migration 8: App settings").

- [ ] **Step 2: Write the failing tests**

`backend/src/services/__tests__/settingsService.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../../config/database', () => ({ pool: { query: (...a: any[]) => queryMock(...a) } }));

import { getSourceOfTruthMode, setSourceOfTruthMode, clearSettingsCache } from '../settingsService';

beforeEach(() => {
  queryMock.mockReset();
  clearSettingsCache();
});

describe('getSourceOfTruthMode', () => {
  it('returns the stored mode', async () => {
    queryMock.mockResolvedValue({ rows: [{ source_of_truth_mode: 'external' }] });
    expect(await getSourceOfTruthMode()).toBe('external');
  });

  it('fails CLOSED to strict when the DB errors', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    expect(await getSourceOfTruthMode()).toBe('strict');
  });

  it('fails CLOSED to strict when the row is missing', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await getSourceOfTruthMode()).toBe('strict');
  });

  it('caches reads', async () => {
    queryMock.mockResolvedValue({ rows: [{ source_of_truth_mode: 'strict' }] });
    await getSourceOfTruthMode();
    await getSourceOfTruthMode();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('setSourceOfTruthMode', () => {
  it('updates, audits, and busts the cache', async () => {
    queryMock.mockResolvedValue({ rows: [{ source_of_truth_mode: 'strict' }] });
    await setSourceOfTruthMode('external', 42);
    const sqls = queryMock.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => s.includes('UPDATE app_settings'))).toBe(true);
    expect(sqls.some(s => s.includes('app_settings_audit'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL** (module missing)

Run: `npx vitest run src/services/__tests__/settingsService.test.ts`

- [ ] **Step 4: Write settingsService.ts**

```typescript
import { pool } from '../config/database';

export type SourceOfTruthMode = 'strict' | 'external';

const CACHE_TTL_MS = 60_000;
let cached: { mode: SourceOfTruthMode; at: number } | null = null;

/**
 * Global source-of-truth mode. FAIL-CLOSED: any read problem returns 'strict'
 * (course materials only) — external knowledge must never leak in by accident.
 */
export async function getSourceOfTruthMode(): Promise<SourceOfTruthMode> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.mode;
  try {
    const result = await pool.query('SELECT source_of_truth_mode FROM app_settings WHERE id = 1');
    const mode: SourceOfTruthMode =
      result.rows[0]?.source_of_truth_mode === 'external' ? 'external' : 'strict';
    cached = { mode, at: Date.now() };
    return mode;
  } catch (error) {
    console.error('Settings read failed — failing closed to strict mode:', error);
    return 'strict';
  }
}

export async function setSourceOfTruthMode(mode: SourceOfTruthMode, userId: number): Promise<void> {
  const previous = await getSourceOfTruthMode();
  await pool.query(
    'UPDATE app_settings SET source_of_truth_mode = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [mode, userId]
  );
  await pool.query(
    'INSERT INTO app_settings_audit (setting_key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4)',
    ['source_of_truth_mode', previous, mode, userId]
  );
  cached = null;
}

/** Test hook. */
export function clearSettingsCache(): void {
  cached = null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/settingsService.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/migrations/app-settings-schema.sql backend/src/db/migrations/runMigrations.ts backend/src/services/settingsService.ts backend/src/services/__tests__/settingsService.test.ts
git commit -m "feat: global source-of-truth setting, fail-closed to strict"
```

---

### Task 11: Root admin endpoints

**Files:**
- Modify: `backend/src/routes/root.ts`

**Interfaces:**
- Consumes: `getSourceOfTruthMode`, `setSourceOfTruthMode` (Task 10). The root router already applies `authenticate` + `authorize('root')` globally (`root.ts:10`) — no extra guards needed.
- Produces: `GET /api/root/settings/source-of-truth` → `{mode}`; `PUT /api/root/settings/source-of-truth` body `{mode: 'strict'|'external'}` → `{mode}` (400 on anything else). Consumed by Task 14's UI.

- [ ] **Step 1: Add the routes**

In `backend/src/routes/root.ts`, add the import and, near the other routes:
```typescript
import { getSourceOfTruthMode, setSourceOfTruthMode } from '../services/settingsService';
```
```typescript
// ---- Global settings: source-of-truth mode ----
router.get('/settings/source-of-truth', async (_req, res) => {
  res.json({ mode: await getSourceOfTruthMode() });
});

router.put('/settings/source-of-truth', async (req, res) => {
  const { mode } = req.body;
  if (mode !== 'strict' && mode !== 'external') {
    return res.status(400).json({ error: "mode must be 'strict' or 'external'" });
  }
  await setSourceOfTruthMode(mode, req.user!.userId);
  res.json({ mode });
});
```

- [ ] **Step 2: Verify by hand**

Boot the backend, log in as root, then:
```bash
curl -H "Authorization: Bearer <root-token>" http://localhost:5000/api/root/settings/source-of-truth
# -> {"mode":"strict"}
curl -X PUT -H "Authorization: Bearer <root-token>" -H "Content-Type: application/json" \
  -d '{"mode":"external"}' http://localhost:5000/api/root/settings/source-of-truth
# -> {"mode":"external"}   (and a new app_settings_audit row)
```
Also confirm a professor/student token gets 403 (the router-level `authorize('root')` handles it).

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/root.ts
git commit -m "feat: root-only endpoints for source-of-truth mode (audited)"
```

---

### Task 12: Strict enforcement in the chatbot + mode in metadata

**Files:**
- Modify: `backend/src/services/agents/SubjectChatbotAgent.ts`

**Interfaces:**
- Consumes: `getSourceOfTruthMode` (Task 10).
- Produces: in strict mode `webSearchResults` is always empty (no web call is even made); response `metadata.sourceOfTruthMode: 'strict' | 'external'`. Consumed by Task 15's UI label.

- [ ] **Step 1: Gate the web search**

In `SubjectChatbotAgent.ts` add:
```typescript
import { getSourceOfTruthMode } from '../settingsService';
```
Replace the `shouldSearchWeb` line (~line 221):
```typescript
      const sourceOfTruthMode = await getSourceOfTruthMode();
      // Strict mode: course materials are the only source — web search is never consulted.
      const shouldSearchWeb =
        sourceOfTruthMode === 'external' &&
        WebSearchService.shouldSearchWeb(relevantMaterials, message.content);
```

- [ ] **Step 2: Record the mode in response metadata**

In the returned `metadata` object (~line 336), add:
```typescript
          sourceOfTruthMode,
```

- [ ] **Step 3: Verify**

`npx tsc --noEmit && npx vitest run` — clean.
Manual: with mode strict, ask the chatbot something not covered by course materials. Expected log: no `📡 ... searching the web` line; response metadata contains `sourceOfTruthMode: 'strict'`. Flip to external via the Task 11 endpoint (wait ≤60s for cache) and confirm the web path returns.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/agents/SubjectChatbotAgent.ts
git commit -m "feat: strict mode blocks web search; answers record their mode"
```

---

### Task 13: Strict fact-check prompt

**Files:**
- Modify: `backend/src/services/factcheck/GroqFactCheckService.ts`
- Modify: `backend/src/routes/chat.ts` (the `factChecker.factCheck(...)` call at ~line 594)
- Test: `backend/src/services/factcheck/__tests__/strictPrompt.test.ts`

**Interfaces:**
- Consumes: `SourceOfTruthMode`, `getSourceOfTruthMode` (Task 10).
- Produces: `factCheck(...)` gains a final optional param `mode: SourceOfTruthMode = 'external'`. Strict mode swaps the system prompt so uncovered claims are `unverifiable`, never verified from model knowledge.

- [ ] **Step 1: Write the failing test**

`backend/src/services/factcheck/__tests__/strictPrompt.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { GroqFactCheckService } from '../GroqFactCheckService';

describe('strict fact-check prompt', () => {
  it('strict prompt forbids own-knowledge verification', () => {
    const strict = (GroqFactCheckService as any).SYSTEM_PROMPT_STRICT as string;
    expect(strict).toContain('ONLY source of truth');
    expect(strict).toContain('unverifiable');
    expect(strict).not.toContain('evaluate using your own knowledge');
  });

  it('external prompt still allows own-knowledge fallback', () => {
    const external = (GroqFactCheckService as any).SYSTEM_PROMPT as string;
    expect(external).toContain('evaluate using your own knowledge');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`SYSTEM_PROMPT_STRICT` undefined).

- [ ] **Step 3: Implement**

3a. In `GroqFactCheckService.ts`, add alongside `SYSTEM_PROMPT` (duplicate it wholesale, then apply exactly these rule changes — rules 3 and 8 differ, the JSON format/scoring sections are identical):
```typescript
  private static readonly SYSTEM_PROMPT_STRICT =
    `You are an independent fact-checker for an educational AI chatbot. Your job is to verify the FACTUAL ACCURACY of a response that was generated by a DIFFERENT AI system (Gemini).

CRITICAL RULES:
1. You are INDEPENDENT. The response you are checking was NOT generated by you.
2. The provided SOURCE DOCUMENTS (course materials) are the ONLY source of truth.
3. For claims not covered by the source documents, the verdict MUST be "unverifiable". Do NOT use your own knowledge to verify or refute them.
4. Focus on verifiable factual claims (dates, statistics, definitions, processes, scientific facts).
5. Skip opinion-based or subjective statements.
6. Be fair but rigorous. Educational accuracy matters.
7. If the response cites sources, verify that the claims match what the provided source content contains.
8. CRITICAL: "inaccurate" means the claim is CONTRADICTED by the source documents. A claim that is simply NOT FOUND in the provided sources is "unverifiable", NOT "inaccurate" — the snippet may be truncated or incomplete. Only "inaccurate" claims should lower the accuracy score; "unverifiable" claims must not be penalized.

For each factual claim you identify:
- State the claim clearly
- Give a verdict: accurate, inaccurate, partially_accurate, or unverifiable
- Explain your reasoning briefly, citing which source document supports or contradicts the claim

Respond with ONLY valid JSON in this format:
{
  "overall_accuracy_score": <0-100>,
  "accuracy_level": "<highly_accurate|mostly_accurate|partially_accurate|inaccurate>",
  "summary": "<2-3 sentence summary of findings>",
  "claims_checked": [
    {
      "claim": "<the specific factual claim>",
      "verdict": "<accurate|inaccurate|partially_accurate|unverifiable>",
      "explanation": "<brief reasoning, cite source document if applicable>",
      "confidence": <0.0-1.0>
    }
  ]
}

Scoring guide:
- 90-100 (highly_accurate): All or nearly all claims verified accurate against sources
- 70-89 (mostly_accurate): Most claims accurate, minor issues
- 50-69 (partially_accurate): Mix of accurate and inaccurate claims
- 0-49 (inaccurate): Significant factual errors detected`;
```

3b. Change the `factCheck` signature — add the final param:
```typescript
    sourceContent?: Array<{ fileName: string; content: string }>,
    mode: 'strict' | 'external' = 'external'
```
and in the completion call select the prompt:
```typescript
              { role: 'system', content: mode === 'strict'
                  ? GroqFactCheckService.SYSTEM_PROMPT_STRICT
                  : GroqFactCheckService.SYSTEM_PROMPT },
```
Also in `buildFactCheckPrompt`'s closing instruction, thread the mode through (add `mode` as a last param the same way) and use:
```typescript
    return `... ${sourceContent && sourceContent.length > 0
        ? (mode === 'strict'
            ? ' Verify each claim ONLY against the SOURCE DOCUMENTS above; claims they do not cover are unverifiable.'
            : ' Verify each claim against the SOURCE DOCUMENTS provided above first, then use your own knowledge for claims not covered by the sources.')
        : ' Check each verifiable claim independently.'}`;
```

3c. In `backend/src/routes/chat.ts` at the `factChecker.factCheck(...)` call (~line 594): add the import `import { getSourceOfTruthMode } from '../services/settingsService';` and pass the mode:
```typescript
            await factChecker.factCheck(
              savedAgentMessageId,
              agentResponse.content,
              sanitizedContent,
              conversationHistory,
              { title: course.title, description: course.description },
              sourceContent,
              await getSourceOfTruthMode()
            );
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/services/factcheck && npx tsc --noEmit`
Expected: all pass (including the pre-existing `parseVerdict.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/factcheck/ backend/src/routes/chat.ts
git commit -m "feat: strict mode closes fact-check own-knowledge fallback"
```

---

### Task 14: Root dashboard toggle

**Files:**
- Modify: `frontend/src/services/api.ts` (inside `rootAPI`, ~line 20)
- Modify: `frontend/src/pages/RootDashboard.tsx`

**Interfaces:**
- Consumes: Task 11's endpoints.
- Produces: a visible, working strict/external toggle for root users.

- [ ] **Step 1: Add API methods**

Inside the `rootAPI` object in `frontend/src/services/api.ts` (match its existing method style — same client instance the other methods use):
```typescript
  getSourceOfTruth: () => api.get('/root/settings/source-of-truth'),
  setSourceOfTruth: (mode: 'strict' | 'external') =>
    api.put('/root/settings/source-of-truth', { mode }),
```

- [ ] **Step 2: Add the toggle to RootDashboard.tsx**

Add state + effect near the top of the component:
```tsx
  const [sourceMode, setSourceMode] = useState<'strict' | 'external' | null>(null);

  useEffect(() => {
    rootAPI.getSourceOfTruth()
      .then(res => setSourceMode(res.data.mode))
      .catch(() => setSourceMode('strict')); // display fail-closed default
  }, []);

  const toggleSourceMode = async () => {
    if (!sourceMode) return;
    const next = sourceMode === 'strict' ? 'external' : 'strict';
    const prev = sourceMode;
    setSourceMode(next);
    try {
      await rootAPI.setSourceOfTruth(next);
    } catch {
      setSourceMode(prev);
      alert('Failed to update setting');
    }
  };
```
And render (place it as its own card/section following the page's existing card markup style):
```tsx
      <div className="settings-card">
        <h3>AI Source of Truth</h3>
        <p>
          <strong>Strict:</strong> answers and fact-checks use uploaded course materials only.{' '}
          <strong>External:</strong> web search and general model knowledge are allowed as labeled secondary sources.
        </p>
        <button onClick={toggleSourceMode} disabled={sourceMode === null}>
          {sourceMode === null ? 'Loading…'
            : sourceMode === 'strict' ? 'Strict — course materials only (click to allow external)'
            : 'External — web + model knowledge allowed (click to restrict)'}
        </button>
      </div>
```
(Import `rootAPI` and `useEffect`/`useState` if not already imported.)

- [ ] **Step 3: Verify in the browser**

Log in as root → dashboard shows the card with the current mode → click toggles it → reload persists it → `app_settings_audit` has a row.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/api.ts frontend/src/pages/RootDashboard.tsx
git commit -m "feat: root dashboard toggle for source-of-truth mode"
```

---

## Phase 3 — Score explainer

### Task 15: ScoreExplainer popover + mode label

**Files:**
- Create: `frontend/src/components/ScoreExplainer.tsx`
- Create: `frontend/src/components/ScoreExplainer.css`
- Modify: `frontend/src/components/MessageMetadata.tsx`

**Interfaces:**
- Consumes: nothing new from the backend. `metadata.sourceOfTruthMode` (Task 12) when present.
- Produces: an ⓘ affordance in the badge row; a small mode label. (The `verifiers_disagree` / `low_validation_warning` alert boxes already exist at `MessageMetadata.tsx:221-235` — do not duplicate them.)

- [ ] **Step 1: Write ScoreExplainer.tsx**

```tsx
import React, { useState, useRef, useEffect } from 'react';
import './ScoreExplainer.css';

const ROWS = [
  {
    name: 'Trust',
    what: 'Two independent AI verifiers (a Groq model jury) each judge whether the answer is well-supported; the score reconciles their verdicts.',
  },
  {
    name: 'Validation',
    what: 'Measures how closely the answer’s sentences match the actual course materials (semantic similarity). Low = the answer may not come from your documents.',
  },
  {
    name: 'Fact Check',
    what: 'A separate AI independently verifies each factual claim in the answer and reports accurate / inaccurate / unverifiable per claim.',
  },
];

const ScoreExplainer: React.FC = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="score-explainer" ref={ref}>
      <button
        className="score-explainer-btn"
        onClick={() => setOpen(!open)}
        aria-label="What do these scores mean?"
        title="What do these scores mean?"
      >
        i
      </button>
      {open && (
        <div className="score-explainer-popover" role="dialog" aria-label="Score explanations">
          <h4>What these scores mean</h4>
          {ROWS.map(r => (
            <div key={r.name} className="score-explainer-row">
              <strong>{r.name}</strong>
              <p>{r.what}</p>
            </div>
          ))}
          <div className="score-explainer-bands">
            <span className="band good">70–100 good</span>
            <span className="band warn">50–69 caution</span>
            <span className="band bad">0–49 unreliable</span>
          </div>
          <p className="score-explainer-flags">
            ⚠ warnings appear when the verifiers disagree with each other, or when the answer is
            weakly grounded in the course materials.
          </p>
        </div>
      )}
    </div>
  );
};

export default ScoreExplainer;
```

- [ ] **Step 2: Write ScoreExplainer.css**

```css
.score-explainer { position: relative; display: inline-block; }

.score-explainer-btn {
  width: 18px; height: 18px; border-radius: 50%;
  border: 1px solid #94a3b8; background: transparent; color: #94a3b8;
  font-size: 11px; font-style: italic; font-weight: 700;
  cursor: pointer; line-height: 1;
}
.score-explainer-btn:hover { border-color: #475569; color: #475569; }

.score-explainer-popover {
  position: absolute; z-index: 30; top: 24px; left: 0;
  width: 300px; padding: 12px; border-radius: 8px;
  background: #fff; border: 1px solid #e2e8f0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  font-size: 12px; text-align: left;
}
.score-explainer-popover h4 { margin: 0 0 8px; font-size: 13px; }
.score-explainer-row { margin-bottom: 8px; }
.score-explainer-row p { margin: 2px 0 0; color: #475569; }

.score-explainer-bands { display: flex; gap: 6px; margin: 8px 0; }
.band { padding: 1px 6px; border-radius: 10px; font-size: 11px; }
.band.good { background: #dcfce7; color: #166534; }
.band.warn { background: #fef9c3; color: #854d0e; }
.band.bad  { background: #fee2e2; color: #991b1b; }

.score-explainer-flags { margin: 0; color: #64748b; }
```

- [ ] **Step 3: Mount in MessageMetadata.tsx**

Add the import:
```tsx
import ScoreExplainer from './ScoreExplainer';
```
Inside `<div className="metadata-quick-stats">`, as the LAST child (after the fact-check badge block), add:
```tsx
        <ScoreExplainer />

        {metadata?.sourceOfTruthMode && (
          <span
            className="metadata-badge"
            title={metadata.sourceOfTruthMode === 'strict'
              ? 'Answered using course materials only'
              : 'External sources (web / general knowledge) were allowed'}
          >
            {metadata.sourceOfTruthMode === 'strict' ? '📚 Course materials only' : '🌐 External allowed'}
          </span>
        )}
```

- [ ] **Step 4: Verify in the browser**

Ask the chatbot a question. Expected: ⓘ button next to the badges opens the popover; clicking outside closes it; the mode label matches the current global setting. Frontend builds clean (`npm run build` in `frontend/`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ScoreExplainer.tsx frontend/src/components/ScoreExplainer.css frontend/src/components/MessageMetadata.tsx
git commit -m "feat: score explainer popover + source-of-truth label on answers"
```

---

## Execution order & independence

- Tasks 1–4 (Phase 0) are sequential.
- Task 5 → 6 → 7 → 8 → (9 if gate passes) are sequential; Phase 1 may start any time after Task 4 (OCR must land before the Task 9 reindex so the corpus is re-embedded once).
- Tasks 10 → 11 → 12 → 13 → 14 are sequential but the whole of Phase 2 is independent of Phases 0–1.
- Task 15 is independent of everything except the small mode label (needs Task 12; if executed early, skip the label and add it after Task 12).
