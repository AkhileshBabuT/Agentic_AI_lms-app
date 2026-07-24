# Spec: Ingestion Quality, Retrieval Accuracy, Source-of-Truth Mode, Score Explainer

**Date:** 2026-07-24
**Status:** Approved (design reviewed in conversation; all forks decided by owner)

## Decisions locked

1. **Feature 0 — OCR ingestion:** Tier 3, self-hosted **Baidu Unlimited-OCR** (MIT) as a Python/vLLM sidecar, with a router so the backend degrades gracefully when the sidecar is down. Fallback model if it doesn't fit local VRAM: PaddleOCR-VL.
2. **Feature 1 — Retrieval:** both a cross-encoder **reranker** and an embedding-model **upgrade to bge-m3 (1024d)**, gated by an in-domain eval harness. If bge-m3 loses the eval, ship reranker-only and keep 768d.
3. **Feature 2 — Source-of-truth mode:** one **global admin (root) setting**, server-enforced, gating **both** answer generation (web search) and fact-check (own-knowledge fallback). Default and failure mode: **strict** (course docs only, fail closed).
4. **Feature 3 — Score explainer:** frontend-only popover explaining Trust / Validation / Fact-check badges. (The flag alert boxes already exist in `MessageMetadata.tsx`.)

## Feature 0 — OCR ingestion layer

Current defects this fixes:
- `pdf-parse` reads only the embedded text layer → scanned PDFs silently produce zero chunks.
- `extractFromImage` calls Groq model `llama-3.2-11b-vision-preview`, which Groq has decommissioned → image uploads fail today.
- `extractFromPDF` never increments `currentPage` → every chunk claims page 1, so citations are wrong.

Design:
- **Sidecar:** Python FastAPI service (`ocr-sidecar/`) that rasterizes PDF pages (PyMuPDF) and sends them to a local vLLM OpenAI-compatible server running Unlimited-OCR. One endpoint: `POST /ocr {file_b64, mime_type}` → `{pages: [{page_number, markdown}]}`. Runs under WSL2/Docker on Windows (vLLM requirement).
- **Router in `documentProcessor.ts`:** PDFs try `pdf-parse` per-page first. If average words/page < threshold (scanned doc), route the file to the sidecar. Images always go to the sidecar, with the current Groq vision model (`meta-llama/llama-4-scout-17b-16e-instruct`) as fallback.
- **Page fix:** per-page extraction (both paths) stamps real page numbers into chunk metadata.
- **Fail-safe:** sidecar unreachable → keep the degraded text-layer result and set `metadata.extraction_degraded: true`. Never a silent empty document.

## Feature 1 — Retrieval accuracy

- **Config-driven embeddings:** model id, dimension, and query prefix move to `EMBEDDING_CONFIG` (env-overridable). bge-m3 uses no query prefix; bge-base-en-v1.5 keeps its prefix. A dimension assert in `generateEmbedding` guards against a half-migrated DB.
- **Eval harness:** `src/scripts/evalRetrieval.ts` + `eval/retrieval-eval.json` (≥10 real course questions with expected material/substring). Reports Recall@5 and MRR for: baseline, baseline+reranker, candidate model (in-memory, no DB migration needed).
- **Reranker:** local cross-encoder (`Xenova/bge-reranker-base` by default, env-overridable) re-scores the existing top-30 vector hits; top 6 go into the prompt. Failure → fall back to vector order.
- **Migration (only if candidate wins eval):** idempotent SQL migration `vector(768)` → `vector(1024)` (deletes embeddings, rebuilds ivfflat index), then full re-embed via `reindexEmbeddings.ts --all`.

## Feature 2 — Source-of-truth mode

- **Storage:** single-row `app_settings` table (`source_of_truth_mode: 'strict' | 'external'`, default `'strict'`), plus `app_settings_audit` (who/when/old→new).
- **Read path:** `settingsService.getSourceOfTruthMode()`, 60s cache, returns `'strict'` on any error (fail closed).
- **Strict enforcement:**
  - `SubjectChatbotAgent`: web search is skipped entirely; Gemini gets no web context.
  - `GroqFactCheckService`: strict system prompt — claims not covered by course docs are `unverifiable`, never verified from model knowledge.
- **External mode** = today's behavior, now explicit.
- **API:** `GET/PUT /api/root/settings/source-of-truth` (root-only; root router already gates with `authorize('root')`).
- **Honesty:** each answer's metadata records the mode it was produced under; frontend shows a small label.
- **UI:** toggle on `RootDashboard.tsx`.

## Feature 3 — Score explainer

- `ScoreExplainer.tsx`: an ⓘ button beside the score badges opening a popover with one-line explanations of Trust (two-model Groq jury), Validation (response↔docs grounding), Fact-check (independent Groq accuracy), the color bands, and the two warning flags. No backend changes.

## Sequencing

Feature 0 → eval harness → (migration + single reindex, if model wins) → reranker → Feature 2 → Feature 3. OCR must precede the reindex so the corpus is only re-embedded once. Features 2 and 3 are independent of 0/1.

## Out of scope (explicitly)

- Per-course override of source-of-truth mode (global row is shaped so adding a per-course table later is additive, not a rewrite).
- Hybrid BM25 search, multi-vector/ColBERT retrieval.
- Batch multi-page OCR inference optimization (per-page calls first; Unlimited-OCR's 40-page mode is a later perf knob).
