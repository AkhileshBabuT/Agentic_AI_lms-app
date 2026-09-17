# Course RAG setup and operations

Implementation is on local branch `dev`, created from the existing `dev1` development branch. PostgreSQL/pgvector and private Google Cloud Storage remain the storage systems. OCR is disabled, including the vision fallback. This document describes runnable application code, not a completed department deployment or a measured quality guarantee.

## Configuration

Keep `VT_ARC_API_KEY` on the backend only. Set the following in the deployment environment after resolving ARC access; the implementation did not modify `.env`.

```dotenv
RAG_GENERATION_PROVIDER=vt_arc
VT_ARC_BASE_URL=https://llm-api.arc.vt.edu/api/v1
VT_ARC_MODEL=<verified-accessible-chat-model-id>
VT_ARC_TIMEOUT_MS=45000
VT_ARC_CONCURRENCY=2
VT_ARC_MAX_QUEUE=20
RAG_ENABLED=true
RAG_ENABLED_COURSES=1,2
RAG_RERANK_ENABLED=false
```

Replace course IDs with actual canary courses. An unset allowlist or `*` allows all authorized courses; an empty allowlist allows none. `RAG_ENABLED=false` pauses new answers while retaining authorized historical references and grading. Restart the API when changing these settings. There is no silent provider fallback.

The latest September 17 recheck succeeded: discovery returned HTTP 200 and synthetic generation with `gpt-oss-120b` passed the JSON evidence-format check. This model is a verified option for `VT_ARC_MODEL`; the probe did not change `.env`. Earlier HTTP 403 responses explicitly required the **VT Campus VPN**, so retain the working VPN/network path for the backend. See [the access report](plans/2026-09-16-vt-arc-access-check.md) for the check history. Synthetic success does not establish live course answer quality or department capacity.

Keep identical ARC concurrency settings on every replica. Active generation uses a PostgreSQL connection for a session advisory lock; leave pool capacity for ordinary queries. Local query embeddings and optional reranking use bounded worker threads. Ingestion runs in its own process. Reranking is disabled initially; enable it only after model warmup and quality/latency evaluation.

The default embedding model stays `Xenova/bge-base-en-v1.5`, mean pooled, normalized, with its query prefix and 768 dimensions. Weights and tokenizer are pinned to commit `4d6cd88e18e51a5e020c2c305726d76ada9c03cf`, verified through the [model's official metadata endpoint](https://huggingface.co/api/models/Xenova/bge-base-en-v1.5). A custom model requires `EMBEDDING_MODEL_REVISION=<immutable 40-character commit>`. Model/revision/tokenizer/pooling/normalization/prefix changes produce a distinct embedding space; do not mix spaces. Dimension changes require an explicit schema migration. The native pipeline version is recorded with index runs and must change when incompatible extraction/chunking behavior changes.

## Build and worker

From `backend/`:

```powershell
npm run build
npm start
```

The normal API bootstrap runs the additive material-ingestion and answer migrations after the existing migrations. These migrations create schema only; they do not backfill materials. Apply them before launching workers. Retain normal database backups and GCS originals/generations. Unique object paths use create-only uploads; citations resolve generation-bound originals with fresh five-minute signed links.

Run the ingestion worker separately with the same database, GCS credentials, and embedding configuration:

```powershell
# Development
npm run rag:worker
# Compiled deployment
node dist/scripts/materialIngestionWorker.js
```

Jobs use leases, heartbeat, fenced publication, bounded retries, and explicit terminal states. Upload intents reconcile interruptions between storage and database operations. Only a validated candidate with all selected text chunks and embeddings becomes the material's published index; failed/review-required candidates retain the previous published version. Native PDFs with usable text can publish with partial coverage and explicit missing-page/image warnings. This does not imply that image content was extracted. Model-space and pipeline mismatches are rejected. File-size, page, ZIP expansion, chunk, and tokenizer limits are configurable in `src/config/materialIngestion.ts`.

`GET /api/health` is liveness. `GET /api/ready` checks local database reachability, local model warmup, and generation configuration; it explicitly reports upstream access as `not_checked` and makes no billable model call. API startup warms local models with synthetic text. Retry local warmup via a normal request after correcting assets/configuration, or restart. Use the standalone synthetic ARC probe to verify upstream credentials separately.

Development diagnostic endpoints are disabled by default. They require `ENABLE_DEBUG_ROUTES=true` and a non-production environment. They cannot be enabled in production.

## Existing attachments

No professor re-upload is required for an available original. Inventory and enqueue bounded batches explicitly:

```powershell
npm run rag:backfill -- --dry-run --course-id 1 --limit 50
npm run rag:backfill -- --dry-run --check-storage --course-id 1 --limit 50
npm run rag:backfill -- --resume --course-id 1 --limit 50
```

If a shell/npm version fails to forward options correctly, call the script directly:

```powershell
npx ts-node src/scripts/backfillMaterialIndex.ts --dry-run --check-storage --course-id 1 --limit 50
# Compiled equivalent
node dist/scripts/backfillMaterialIndex.js --resume --course-id 1 --limit 50
```

Default dry-run reads database state only. `--check-storage` additionally reads object metadata without downloading files or writing data. `--resume` pins the current GCS generation, hashes the original, and queues a new native index. Already-accounted-for versions/spaces/pipelines are skipped. Use the emitted `--after-id` cursor to advance past unavailable originals; report and resolve skipped failures rather than claiming complete coverage. Concurrency is sequential and batches are bounded.

Professors can explicitly retry indexing with `POST /api/professor/materials/:id/reindex`. Unindexed legacy attachments need backfill first. Image-only PDFs with no usable native text, image attachments, fatal extraction errors and exceeded limits require review because OCR is disabled. Mixed PDFs index their usable native text and publish an explicit coverage warning with affected physical page numbers, shown in materials, fresh answer references and the source viewer. A sparse cover or diagram slide no longer blocks the entire document. Answers still need support from actual extracted passages; missing image content cannot be inferred. Non-PDF locators describe extracted sections/paragraphs/sheets rather than fabricated original page numbers.

The current pipeline is `native-v2-partial-text`. Retry a previously blocked mixed PDF after restarting the backend and worker to enqueue this new immutable run; do not edit its old run or citations. September 17 verification rebuilt the user's `ch01.pdf` into 58 actual chunks and embeddings and answered the computer-system question through live ARC with a page 5 reference. Other course originals still require their own indexing/evaluation; no general course backfill was performed.

## Citations and lifecycle

Normal answers and regeneration share one strict service. Unknown IDs, missing block references, malformed output, and altered provenance fail validation; one repair is allowed before abstention. The service persists the assistant message, evidence manifest, and citations together. It rechecks membership, publication, and source versions before persistence. Each answer records its triggering question; regeneration is rejected if a newer question appeared while generating.

Source panels use fresh authorized citation rows, not old percentages or model-generated excerpts. Multiple passages from one document stay distinct. PDF references open physical page numbers; other formats expose exact excerpts and available section locators. Signed links are temporary bearer links, so already-issued links can survive revocation until expiry. The server denies issuing new links once access is revoked.

Material/folder deletion is soft and preserves immutable evidence. New retrieval excludes deleted/inaccessible materials; historical answers and linked saved copies are withheld if supporting evidence becomes inaccessible. Regeneration hides the replaced answer from chat while allowing an owned saved copy to retain its valid citations. Historical content without new provenance cannot be retroactively verified; it has no invented citations. Permanent root-authorized course deletion purges dependent database evidence in the existing deletion transaction; GCS retention remains an operational responsibility.

## Verification and rollout

Run `npm test` and `npx tsc --noEmit` from `backend/`, and `npm run build` from `frontend/`. Database suites are opt-in through `RAG_TEST_DATABASE_URL`. The ingestion suite intentionally accepts only the isolated local URL `postgresql://rag_test@127.0.0.1:55432/rag_test`; install the pgvector extension in `public`. It creates/drops only its temporary test schema. Do not point tests at the LMS database.

Implemented checks cover ingestion recovery/fencing, migration idempotence, atomic publication, permission revocation, real vector/lexical SQL, immutable citation identity, provider fixtures, worker deadlines, and chat integration. Browser checks used synthetic intercepted API responses; the real embedding worker was checked separately. Actual ARC generation with synthetic evidence passed on September 17. Real GCS upload/backfill, instructor-reviewed citation entailment, and department load tests remain deployment gates. Structural citation validation does not prove semantic support.

Start with allowlisted courses, run a read-only original inventory, backfill, then inspect representative references with instructors. Build the instructor-reviewed held-out evaluation set and measure the quality/latency targets in the original plan before expanding. Review model-access terms and deployment authentication before serving multiple users.

To roll back processing, stop the worker and restore a material's pointer to a retained published run in the same embedding space after verifying its material/version ownership. Keep all immutable runs needed by existing citations. To pause answers, set `RAG_ENABLED=false` and restart; do not restore the legacy general-knowledge path. Schema changes are additive, so there is no automatic destructive down migration.
