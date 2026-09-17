# Production RAG implementation tasks — OCR deferred

This task breakdown updates the September 14 production-course-RAG plan following the owner's September 16 instructions. Target: a department pilot, using the existing Express/React application, PostgreSQL/pgvector, private Google Cloud Storage, and VT ARC generation access. The owner reviewed this breakdown before authorizing subagents and implementation on `dev`. See [setup and operations](../production-rag.md) for delivered behavior and remaining live-validation gates.

## Current scope

- Course-only answers supported by authorized, published course materials already stored in the LMS.
- Preserve the existing 768-dimensional embedding configuration and GCS storage.
- Implement recoverable background ingestion, hybrid search, immutable evidence, and citations opening supporting source passages.
- Remove course-chat Trust, Validation, Fact-check, and confidence percentages and their model calls; preserve assignment grades and grading review.
- Add VT ARC generation transport using the server-side credential. Verify the actual key's API endpoint and accessible models rather than assuming a browser model name is an API identifier.
- Disable/comment out both OCR-sidecar invocation and vision-model extraction fallback. Retain dormant OCR modules for future work; do not provision, benchmark, or integrate OCR now.
- Handle image-only, unreadable, and partially extractable files explicitly. Do not publish silently incomplete indexes; surface review/failure states and retain any previous published version.

This is application implementation authorization, not a request to deploy or launch a bulk migration against live course documents. Prepare a dry-run backfill and rollout commands; validate locally. A minimal synthetic provider request may verify the supplied model-access credential without transmitting course content.

## Task ownership and deliverables

| Task | Owner | Deliverables | Depends on |
|---|---|---|---|
| 0. Establish shared contracts and baseline | Primary agent | Review current schema/auth; record baseline checks; define ingestion states, embedding-space identity, evidence/citation types, generation contract, and API response shapes | None |
| 1. Versioned ingestion and OCR disablement | Subagent A | Additive idempotent schema; immutable GCS versions; short upload transactions; durable jobs with leases/retries; native extraction with trustworthy locators; publication validation; worker entry point; resumable backfill with dry-run | Task 0 |
| 2. Authorized hybrid retrieval and cited answers | Subagent B | Shared access checks; pgvector + PostgreSQL full-text search; rank fusion; bounded reranking and context budgets; server-owned evidence manifest; source-only answer/abstention rules; citation validation and transactional persistence | Task 0; integrate with Task 1 schema |
| 3. VT ARC generation adapter | Subagent C | Confirm official endpoint/auth requirements for this key; explicit provider/model configuration; transport adapter; cancellation/timeouts; bounded admission/retries; sanitized errors; provider fixtures and synthetic access check | Task 0 |
| 4. Citation interface and indexing status | Subagent after first wave | Source references, exact extracted excerpts, authorized page/section navigation, course-material indexing states, visible insufficient-evidence responses; remove chat score badges/polling | Agreed Task 0 contracts; Tasks 1–2 endpoints |
| 5. Integration and removal of chat scoring | Primary agent | Wire normal chat and regeneration through one answer service; register source routes/worker/config; remove jury/fact-check/emotional-rewrite calls from course chat; preserve grading; reconcile all subagent changes | Tasks 1–3; coordinate with Task 4 |
| 6. Verification and rollout preparation | Primary agent | Backend tests/typecheck, frontend build, database integration checks where available, authorization/citation/worker recovery cases, real-provider smoke result, dry-run backfill instructions, rollback documentation, updated project knowledge | Tasks 1–5 |

## Task details

### 0. Contracts and baseline

Establish one owner for schema and shared configuration edits. Define stable request/response interfaces before parallel work. Confirm course membership, professor ownership, material deletion/visibility, and session ownership checks. Record existing failures separately from newly introduced failures. Do not expose `.env` values in output or documents.

### 1. Ingestion

Own material tables/migrations, ingestion modules, worker/backfill scripts, GCS version helpers, and native document extraction. Route and configuration edits are coordinated through the primary agent where shared with other tasks.

Use upload intents and generation-aware object operations because storage and database changes are separate operations. Jobs must survive restart, prevent stale lease holders publishing, and retry idempotently. A fully validated candidate index becomes visible atomically; an unsuccessful candidate preserves the old published run.

Disable all active OCR calls, including image vision fallback. Native extraction should preserve PDF physical pages and honest non-PDF locators. Where a parser cannot establish slide/cell/paragraph locations, expose a supported section/text locator instead of inventing one. Blank or suspect pages require an explicit review state rather than automatic publication. Avoid treating a short title page alone as proof that an entire PDF is unreadable.

Prepare `--dry-run`, `--course-id`, and resumable backfill behavior using existing original attachments; no professor re-upload requirement. Backfill does not run automatically at server boot.

Acceptance: upload state is durable; worker restart/retry does not duplicate publication; failed processing is visible; OCR endpoints and vision extraction are never called; published chunks retain correct provenance.

### 2. Retrieval and evidence

Own new RAG services and source-resolution handlers; expose interfaces to the primary agent for chat-route integration.

Apply identical authorization/publication/embedding-space restrictions to lexical and vector search, neighbor expansion, and source viewing. Start with exact filtered vector retrieval suitable for the pilot and tune from measurements. Fuse rankings, optionally rerank within a bounded execution budget, and pack passages by tokens.

Build the prompt from numbered server-owned evidence IDs. Require structured answered/partial/insufficient-evidence output with evidence IDs on supported answer blocks. Validate unknown references and missing coverage; allow at most one repair before abstaining. Reference validation does not prove entailment, so include representative human-review evaluation cases.

Store the assistant answer, run manifest, and citations together under the assistant message ID. References retain immutable source versions and source excerpts. Recheck permission when resolving source access; create temporary links on demand rather than saving signed URLs as durable evidence.

Acceptance: a real existing material can support an answer whose citation opens the correct document version and location; unsupported questions abstain; cross-course, deleted-material, and inaccessible-session cases cannot leak content.

### 3. VT ARC

Own the new generation adapter and its tests. Coordinate shared config registration with the primary agent. Keep generation distinct from existing grading provider contracts that require confidence or review methods.

The key came from VT ARC Open WebUI. Check whether it authenticates against the documented shared inference API or the Open WebUI API, and configure the matching transport. Do not infer that a key's presence establishes compatibility with a particular URL. Verify available model IDs through supported discovery or a documented minimal probe; report any unresolved access issue precisely.

Use explicit selection, secure server-side credential handling, host validation, bounded request concurrency, timeouts/cancellation, and limited retries for transient failures. No silent mock or cross-provider fallback. Buffer and validate final answers before displaying final citations. Live verification uses synthetic content only.

Acceptance: contract fixtures cover success, auth failure, rate limiting, malformed output, and cancellation; actual access/model result is recorded when reachable; missing or invalid configuration fails clearly.

### 4. Interface

Own frontend changes. Support multiple citations to one document, exact extracted excerpts, physical PDF page navigation, and supported non-PDF locators. Explain unindexed/review-required materials and insufficient evidence in ordinary language. Historical messages may lack new citations; render them honestly without fabricated references or residual percentages.

Acceptance: frontend builds; source navigation and unauthorized-source failures are verified; assignment grades remain visible and functional.

### 5–6. Integration and verification

The primary agent owns shared application wiring, chat/regeneration integration, and final reconciliation. Remove course-chat scoring calls and UI polling, including saved/history paths where applicable. Ensure postprocessing cannot rewrite an answer after its citations are validated.

Run meaningful backend regression tests and typechecking plus the frontend production build. Add real PostgreSQL/pgvector integration coverage if a test database is available; otherwise document exactly which checks could not run rather than claiming production validation. Verify job recovery, publication switching, permission boundaries, citation identities, provider error handling, and grading compatibility. Do not invent instructor-reviewed evaluation results.

Provide rollout instructions for environment variables, migrations, worker launch, dry-run/backfill, canary activation, and rollback. Keep existing data and source versions intact during additive migration. Production readiness remains contingent on measured course evaluation and deployment checks.

## Execution order

1. Present this breakdown to the owner before spawning subagents.
2. Primary agent establishes Task 0 contracts and bounded file ownership.
3. Spawn A, B, and C for Tasks 1–3. The primary agent coordinates interfaces and performs useful integration work. Maximum: three subagents alongside the primary agent.
4. When a slot is free and frontend contracts are stable, assign Task 4. Integrate Tasks 1–3 sequentially where schema/API changes depend on one another.
5. Finish Tasks 5–6, report verified behavior and remaining deployment gates, and provide the implementation for review.

OCR development, OCR GPU hosting, OCR benchmarks, ARC embedding migration, external web research inside course answers, and autonomous agent orchestration are deferred.
