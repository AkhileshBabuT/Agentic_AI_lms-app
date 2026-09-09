# Agentic AI LMS — Project Knowledge

Durable architecture and conventions for this repo. (Not a changelog — no task/PR history here.)

## Stack & layout

- **backend/** — Node/Express + TypeScript, PostgreSQL with the **pgvector** extension. Tests: **vitest** (`npm test` = `vitest run`) from `backend/`. Typecheck: `npx tsc --noEmit`.
- **frontend/** — React + TypeScript + Vite. Build/typecheck: `npm run build` (`tsc -b && vite build`). No unit-test suite; the build is the gate.
- **ocr-sidecar/** — standalone Python FastAPI service wrapping a local vLLM server for OCR. Not part of the Node build; runs as a separate process (needs a CUDA GPU). The backend calls it over HTTP at `OCR_SIDECAR_URL`.
- **docs/** — specs and implementation plans.

## Core domain

An LMS where professors upload course materials and students chat with an AI tutor grounded in those materials (RAG). Roles: `student`, `professor`, `root` (admin). Auth is JWT (`middleware/auth.ts`): `authenticate` sets `req.user`, `authorize(...roles)` gates by role. The `root` router (`routes/root.ts`) applies `authorize('root')` globally.

## Ingestion → retrieval → answer pipeline

1. **Extraction** (`services/documentProcessor.ts`): `extractTextFromFile(buffer, name, mime)` dispatches by MIME to per-format extractors and returns `{ content_text, content_chunks, metadata }`. Scanned PDFs / images route to the OCR sidecar (`services/ocrClient.ts`); PDFs with a healthy text layer use `pdf-parse`. Chunking is **per-page** (`chunkPages` → `chunkTextSemantic`) so chunk metadata carries real page numbers. `metadata.extraction_degraded = true` marks a doc whose extraction is known-bad (sidecar down on a scanned doc, etc.).
2. **Embedding** (`services/embeddingService.ts`): local transformers.js model via `@xenova/transformers`, config-driven through `EMBEDDING_CONFIG` (model id, dimension, query prefix — all env-overridable). Queries use `embedQuery` (applies the asymmetric prefix); documents are embedded raw. A dimension guard throws if model output length ≠ configured dimension. Vectors stored in pgvector.
3. **Retrieval** (`services/vectorSearch.ts`): pgvector cosine search (`searchCourseMaterials`), then an optional **cross-encoder reranker** (`services/rerankerService.ts`) re-scores the recall set. The reranker **fails open** — any load/scoring error degrades to vector order.
4. **Answer** (`services/agents/SubjectChatbotAgent.ts`): builds a grounded prompt from the reranked chunks. Distinguish `relevantMaterials` (full recall set — used for the web-search decision and stats) from the reranked subset used for the prompt/sources.

## Source-of-truth mode (strict vs external)

- One global setting in `app_settings` (single locked row), read via `services/settingsService.ts` `getSourceOfTruthMode()` — **fail-closed**: any DB error, missing row, or invalid value returns `'strict'`. 60s cache; `setSourceOfTruthMode` writes an `app_settings_audit` row and busts the cache. Managed via root API (`/api/root/settings/source-of-truth`) and a toggle on the root dashboard.
- **Strict** = course materials only: web search is skipped in the chatbot, and the fact-checker (`services/factcheck/GroqFactCheckService.ts`) uses `SYSTEM_PROMPT_STRICT` so uncovered claims are `unverifiable` (never verified from model knowledge). **External** = today's behavior (web grounding + own-knowledge fallback allowed). Each answer records the mode it was produced under in `message_metadata.sourceOfTruthMode`.

## Trust / Validation / Fact-check scoring

Three independent signals surfaced per answer (see `TRUST_SCORE_LOGIC.md`, `services/scoring/`, frontend `MessageMetadata.tsx` + `ScoreExplainer.tsx`): **Trust** (two-model Groq jury, `juryReconciliation.ts`), **Validation** (response↔docs cosine faithfulness, `validationScore.ts` + `cosineCalibration.ts`), **Fact-check** (independent Groq accuracy). Flags: `verifiers_disagree`, `low_validation_warning`.

## AI providers

`services/ai/AIServiceFactory.ts` selects a provider (`providers/GeminiAIService.ts`, `GroqAIService.ts`, `MockAIService.ts`). Groq is shared across fact-check, the trust jury, the emotional filter, and image-OCR fallback — mind the shared rate limit (`GroqRateLimitManager.ts`). Model ids and thresholds live in `config/constants.ts` (env-overridable); verify Groq/embedding/OCR model ids against the providers before relying on defaults.

## Conventions

- **Config over magic numbers**: tunables live in `config/constants.ts` as env-overridable constants (`EMBEDDING_CONFIG`, `RERANKER_CONFIG`, `OCR_CONFIG`, `FACT_CHECK_CONFIG`, `SCORING`, etc.). Add new tunables there, not inline.
- **Migrations** run on every boot, in order, registered in `db/migrations/runMigrations.ts` (raw SQL files in `db/migrations/`). They **must be idempotent** (`CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`). Append the next sequential `Migration N` before the `catch`.
- **Fail-safe defaults at trust boundaries**: settings fail closed to strict; the reranker and OCR fail open to prior behavior; never return a silent empty document for a scanned upload.
- Embedding-model changes require a full re-index (`scripts/reindexEmbeddings.ts --all`) and, if the dimension changes, a pgvector column migration.
