# Course RAG implementation result

Implemented September 16, 2026 on local `dev`, created from `dev1`. `main` was not changed. Changes are uncommitted; no deployment or live course backfill was performed.

## Delivered

- Private GCS originals with generation-bound immutable versions; durable PostgreSQL ingestion jobs, fenced leases, atomic publication, retry and bounded legacy-material backfill.
- Native text extraction with physical PDF pages and honest section locators. OCR and vision extraction are disabled; incomplete and image-only material requires review.
- Authorized pgvector and PostgreSQL full-text retrieval, rank fusion, bounded local model workers, pinned embedding revisions, and optional reranking disabled initially.
- Strict course-source generation through a dedicated VT ARC adapter, validated citation IDs, transactional evidence records, and fresh source authorization.
- Protected source viewer, exact excerpts, multiple references from one document, saved-answer citations, and professor indexing status/retry controls.
- Chat confidence/trust/fact-check percentages removed. Assignment grades remain intact.
- Safe regeneration, course/membership revocation checks, production diagnostic-route restrictions, local readiness, rollout controls and operations documentation.

## Verification

- Backend: 115 tests in 21 files passed. This includes actual PostgreSQL/pgvector retrieval and ingestion integration suites against an isolated local test database.
- Backend TypeScript build and frontend TypeScript/Vite production build passed.
- Compiled, pinned embedding worker: 768 finite dimensions, normalized vector, successful local readiness.
- Headless Chrome with synthetic intercepted API fixtures: 11 browser checks passed, covering references, multiple passages, excerpts, PDF page navigation, native sections, access denial, partial/insufficient evidence, saved references, index status, assignment preservation and absence of score polling.
- Git whitespace check passed. The frontend retains a Vite bundle-size advisory.

## Remaining deployment gates

The latest September 17 ARC recheck succeeded after the network restriction was resolved: discovery returned HTTP 200 and actual `gpt-oss-120b` generation with synthetic evidence passed the JSON evidence-format check. The current key works for that model on the current network path. Configure `VT_ARC_MODEL=gpt-oss-120b` explicitly and retain the permitted VPN/network path; the probe did not edit `.env`. There is no silent provider fallback.

Real GCS uploads/backfill, instructor-reviewed citation entailment and department load/latency evaluation remain unverified. Structural citation validation alone does not establish that a claim is semantically supported. Existing course materials need the documented bounded backfill before participating in the new retrieval index.

See [setup and operations](../production-rag.md), [ARC access findings](2026-09-16-vt-arc-access-check.md), and [the original production plan](2026-09-14-production-course-rag.md).
