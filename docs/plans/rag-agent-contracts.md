# RAG implementation contracts

Working branch: `dev`. Primary agent owns chat routes, app wiring, shared constants, and final integration. Agents must not commit, switch branches, read secrets into output, or run live database migrations/backfills.

## Ingestion/schema contract (Agent A owns)

New tables use the unprefixed names from the plan. Integer material/course/message IDs and UUID version/run/chunk/job IDs generated in Node via crypto.randomUUID().

- `course_materials`: add `published_run_id UUID`, `ingestion_status TEXT`, `visibility TEXT DEFAULT 'published'`, `deleted_at TIMESTAMPTZ`.
- `material_versions`: `id`, `material_id`, `object_name`, `object_generation`, `sha256`, `mime_type`, `byte_count`, `original_filename`, `created_at`.
- `material_index_runs`: `id`, `version_id`, `embedding_space_id TEXT`, `pipeline_version TEXT`, `status TEXT`, `created_at`.
- `material_chunks`: `id`, `run_id`, `material_id`, `course_id`, `text`, `locator JSONB`, `token_count`, `search_vector TSVECTOR` (stored/generated indexed GIN).
- `chunk_embeddings`: `chunk_id`, `embedding_space_id TEXT`, `embedding vector(768)`.
- Locator shape: `{page?: number, section?: string, kind?: string, start?: number, end?: number}`. Page is physical PDF page, never model-generated.
- Shared embedding space helper: `services/materials/embeddingSpace.ts` exports `getEmbeddingSpaceId(): string`.
- Agent A communicates additions/refinements before deviating from these columns. Agent B owns answer_runs/answer_citations schema in separate `rag-answers-schema.sql`; primary registers that migration.
- Agent A may edit professor.ts material upload/list/delete endpoints, storage helpers, documentProcessor, migrations runner, backend package scripts. Primary will avoid these sections. OCR constants change goes through primary: ENABLED hard-disabled.

## Retrieval/answer contract (Agent B owns)

`services/rag/CourseAnswerService.ts` exports `answerCourseQuestion({courseId,userId,role,question,signal?})` and `persistCourseAnswer({sessionId,courseId,userId,role,answer,regeneratedFrom?})` returning assistant message row; optionally context/history via safe verified history. Persist ownership and access again in transaction.

Answer result: `{content: string, status: 'answered'|'partial'|'insufficient_evidence', sources: SourceReference[], metadata: Record<string,unknown>, evidence?: ...}`. SourceReference contains `citationNumber`, `evidenceId`, `chunkId`, `materialId`, `materialName`, `versionId`, `runId`, `excerpt`, `locator`, `sourceType: 'course_material'`; compatible fields `pageNumber?`, `section?`, `url: null`, `relevance: null` allowed for existing frontend (no similarity display).

`routes/materialSources.ts` default exports router mounted at `/api/material-sources`. Endpoints GET `/:chunkId` return `{source: SourceReference, url: string}` after rechecking current material/course access and resolving immutable GCS generation. Also GET `/answers/:messageId` returns currently authorized citations (session owner, course access), for history refresh/revocation. Do not rely solely on old JSON citations on historical messages.

Use GenerationProvider interface in `services/ai/generation.ts`, import `getGenerationProvider` from `services/ai/generationFactory.ts` (Agent C owns). Inject dependencies for meaningful tests if useful.

## Provider contract (Agent C owns)

Own `services/ai/providers/VtArcGenerationProvider.ts`, `generationFactory.ts`, dedicated `config/rag.ts` (other agents read, not edit), tests, probe script. Default generation provider explicitly vt_arc. Keep current grading factory untouched. RAG configuration includes retrieval counts/budget/rerank, ingest bounds as needed; coordinate additions.

Expose `getGenerationProvider(): GenerationProvider`. No mock default. Provider failure should propagate sanitized typed error/status to root route integration. Key stays server-side; do not alter .env. Probe only synthetic content and safe metadata. Verify official Open WebUI versus inference endpoint details with browsing.

## Frontend contract (later agent)

Sources are above; metadata `answerStatus` mirrors answer status, `sourceOfTruthMode: 'strict'`, `ragPipelineVersion`. Index status exposed on existing materials entries. Primary sends final endpoint details before frontend work. Remove chat score UI/polling, preserve grades. Source fetch must use app auth through existing api client.
