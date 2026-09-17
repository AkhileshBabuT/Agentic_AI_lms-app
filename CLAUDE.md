# Agentic AI LMS — Project Knowledge

Durable architecture and conventions for this repository.

## Stack and layout

- `backend/`: Express/TypeScript, PostgreSQL/pgvector. `npm test` runs Vitest; `npx tsc --noEmit` checks types; `npm run build` copies SQL migrations into the compiled output.
- `frontend/`: React/TypeScript/Vite. `npm run build` is the production build/typecheck gate.
- `ocr-sidecar/`: retained Python service; dormant. No active native-ingestion or image-extraction path calls OCR or a vision fallback. `OCR_CONFIG.ENABLED` is hard-disabled for the current scope.
- `docs/production-rag.md`: configuration, worker/backfill, lifecycle, validation and rollout instructions.

## Domain and authorization

Professors upload course materials; enrolled students use a tutor grounded in authorized published materials. Roles are student, professor and root. JWT middleware reads current account role/status from PostgreSQL. `services/rag/access.ts` rechecks account, course membership and owner access; this policy also filters both retrieval branches and source resolution.

Student submissions and private grading rubrics are outside the course-material retrieval corpus. Assignment grading/review retains its existing Gemini/Groq provider factory and numerical grades.

## Ingestion and immutable publication

`services/materials/` owns durable upload intents, versioned GCS attachments, leased jobs, native extraction validation, tokenizer-bounded chunks, retry and atomic publication. `services/documentProcessor.ts` preserves PDF physical pages and honest extracted-text/section locators for other formats. Empty, unsupported or fatal extraction becomes needs_review. Mixed PDFs with usable native text publish that text with explicit partial coverage, affected pages and an ingestion_warning; source APIs derive warnings from immutable run metadata. Sparse cover/diagram pages must not block all usable text. Current pipeline: native-v2-partial-text; pipeline mismatches are rejected and retries enqueue new runs.

PDF extraction uses pdf-parse's bundled PDF.js directly with browser font loading disabled and a non-browser image decoder. Operator-list inspection must not invoke DOM font/JPEG loaders in Node. Keep the embedded-font/JPEG subprocess regression fixtures. Native validation errors return safe HTTP 400 reasons; unexpected upload failures log only stage and validated database codes.

New uploads return accepted indexing state after storage/queue finalization; extraction and embeddings run in a separate process. Worker entry: `scripts/materialIngestionWorker.ts`. Backfill entry: `scripts/backfillMaterialIndex.ts` with dry-run, course/limit/cursor and resume options. Do not backfill at application boot or silently request professors to upload available originals again.

`course_materials.published_run_id` selects a complete immutable run. Candidate failures retain the old pointer. Jobs use heartbeat, fencing and bounded retries. Native ingestion limits and supported signatures live in `config/materialIngestion.ts` and `services/materials/fileValidation.ts`. GCS originals use private immutable object paths and generation-aware reads; storage and PostgreSQL are separate operations reconciled through intents.

Local embeddings stay 768-dimensional BGE, mean pooled, normalized, with the query prefix. Weights/tokenizer are commit-pinned; `getEmbeddingSpaceId()` fingerprints the representation. A changed model, revision, tokenizer, pooling or prefix needs a separate index/backfill. Dimension changes need explicit schema migration. The legacy reindexEmbeddings script only fills missing legacy embeddings and does not implement --all; use the new backfill for provenance/publication.

## Course answers and sources

`services/rag/CourseAnswerService.ts` is the shared normal/regenerated answer path. Retrieval combines exact filtered pgvector cosine ordering and PostgreSQL full-text search, RRF fusion, optional bounded reranking and conservative context packing. Local query embedding/reranking runs in isolated bounded worker threads with cancellation, deadlines and warmup/readiness.

Course chat is always source-only. Web search, general-knowledge fallback, confidence percentages, jury/fact-check calls and post-validation emotional rewriting are retired from this path. Legacy settings/scoring/agent modules remain for compatibility but cannot enable external course-chat answers. The source-mode toggle is removed from the current UI.

Generation returns structured blocks referencing server-owned evidence IDs. Unknown IDs or missing citation coverage trigger at most one repair, then abstention. Structural validation does not establish semantic entailment; instructor evaluation is required. Assistant messages, evidence manifests and citations persist in one transaction after permission/publication rechecks. Regeneration is rejected when a newer question arrived and replaces the old answer only after successful persistence.

`routes/materialSources.ts` is mounted under `/api/material-sources`; source and answer/saved-reference endpoints recheck current access. Exact excerpts and locators come from immutable passages. Signed original links are generation-bound and created on demand with five-minute expiry; issued bearer links can remain usable until expiry. Material/folder deletion is soft; historical answers and linked saved copies with revoked evidence are withheld. Owned saved answers survive regeneration. Permanent root course deletion explicitly purges dependent database evidence in its existing transaction.

## Generation configuration

`services/ai/generation.ts` defines a generation-only contract, separate from grading APIs. `generationFactory.ts` explicitly selects VT ARC without mock or cross-provider fallback. The adapter pins the documented HTTPS inference gateway, denies redirects/upstream tools, bounds response size and retries, and uses cancellation/timeouts plus PostgreSQL advisory slots shared across replicas. Keep identical limits and spare pool capacity on replicas.

`VT_ARC_API_KEY` is server-only; `VT_ARC_MODEL` must be a verified accessible model ID. Missing/invalid configuration fails clearly; a configured key/model does not prove upstream authentication. `scripts/probeVtArc.ts` checks synthetic content without opening the database or transmitting course documents. Access results are documented separately.

`RAG_ENABLED=false` pauses new answers while preserving sources and grading. `RAG_ENABLED_COURSES` optionally limits canary courses; unset or * allows all authorized courses, empty allows none. API restart applies changes. `/api/ready` checks local dependencies/configuration and explicitly does not authenticate upstream. `/api/health` is liveness. Diagnostic routes require explicit non-production enablement and are blocked in production.

## Conventions and verification

Keep tunables in the relevant configuration module, not scattered magic numbers. Read dotenv before configuration modules; never log secrets or complete student prompts/answers in the new pipeline.

Migrations run in order through `db/migrations/runMigrations.ts` and must be additive/idempotent. Material ingestion and answer schemas follow the existing migrations. Long backfills and coordinated index builds are explicit deployment tasks, not boot operations. Retain immutable runs needed by historical citations; do not use the legacy general-knowledge path for rollback.

Database integration suites are opt-in through `RAG_TEST_DATABASE_URL` and temporary schemas. Use only the isolated test database described in the runbook. Model/provider fixtures do not establish real answer quality. Real ARC access, GCS backfill, instructor-reviewed support/abstention evaluation and department load tests remain rollout gates.
