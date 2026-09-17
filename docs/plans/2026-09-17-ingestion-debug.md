# Local upload and PDF worker diagnosis

Changes remain on `dev`; no commits or deployment were made.

## Confirmed PDF worker crash and fix

The user reported `ReferenceError: document is not defined` while indexing `ch01.pdf`. Replaying native extraction against the generation-bound original downloaded from GCS reproduced the exact delayed font-loader crash. Disabling browser font loading exposed a second delayed crash, `Image is not defined`, from JPEG loading.

Image detection calls PDF.js's operator-list API. The bundled `pdf-parse` wrapper does not forward native image-decoder settings, so parsing now uses its same bundled PDF.js runtime directly, disables browser font faces and dynamic evaluation, selects the non-browser image decoder, and destroys the loading task in a finally block. Physical page numbers, bounded page processing and source text extraction are preserved. OCR remains disabled.

The initial parser fix made all 58 pages parse without either crash. Native extraction flagged 14 pages containing images with little text, and the then-current completeness policy still withheld the whole index. The temporary local copy was removed. The subsequent indexing-policy fix and actual publication are documented below.

Restart the ingestion worker with `npm run rag:worker`. It can recover interrupted jobs after their leases expire, subject to the configured attempt limit. Restart both processes after changing code; the backend does not reload modules under `npm start`.

## Upload error handling and confirmed legacy PowerPoint diagnosis

A synthetic PPTX archive passes the actual multipart upload, validation and queue-registration path with fixture database/storage dependencies. The subsequently provided failing file, `ch01.ppt`, is actually a valid legacy PowerPoint OLE container.

The validator mistakenly used `d0cf11e0a1b11e1`, an odd-length hex string that decodes to only seven bytes. It compared this against an eight-byte prefix, rejecting every legitimate legacy PPT/DOC/XLS container. Corrected the full OLE signature to `d0cf11e0a1b11ae1`. Regression checks using independently generated CFB containers reproduced the rejection for all three formats and the multipart PPT upload; all four pass after the correction.

The user's original file now passes native validation and local extraction: 3,291 words and 21 chunks, with no extraction error or degraded flag. Its contents were not uploaded by this diagnostic or sent to VT ARC. Restart both the backend and any already-running worker before retrying its upload so both load the corrected validator.

A reproduced error-reporting defect converted invalid Office packages into generic HTTP 500 responses. Native validation now throws a dedicated error type and returns HTTP 400 with a fixed, safe reason. Unexpected failures log the upload stage and a validated PostgreSQL error code, retaining generic responses for private upstream/database details.

## Verification

- Embedded open-source Liberation font and JPEG fixtures reproduce both browser-runtime failures in separate Node processes; both now pass. Font license accompanies the synthetic fixtures.
- Actual `ch01.pdf` native extraction exits successfully without printing its text.
- All **120 backend tests in 22 files passed**, including isolated PostgreSQL/pgvector integration suites for lease recovery and publication.
- Backend build passed. No frontend code was changed in this diagnosis.
- After the OLE signature correction, all 10 targeted validation/multipart upload tests and the backend build passed; the user's actual PPT validation/extraction also passed.

The missing embedded-font/JPEG process-level coverage allowed the regression through the previous native PDF fixtures. The new checks detect delayed parser rejections that could escape a normal extraction promise and terminate a worker.

## Confirmed empty corpus and partial-text publication fix

The user's two supported course questions returned abstentions. Database inspection established zero published chunks: the only active PDF had `needs_review` and a null publication pointer. Recent answer metadata recorded zero evidence and no generation model, so no ARC request was made. The all-or-nothing ingestion gate was the cause.

`native-v2-partial-text` publishes usable native PDF text even when some pages/images need review, with explicit run-level coverage warnings. All selected chunks and embeddings still publish atomically. Entirely unreadable/image-only documents, unclassified degraded extraction and fatal errors remain blocked. OCR remains disabled. An additive `ingestion_warning` column distinguishes this limitation from ingestion errors, and fresh references and source views expose immutable coverage warnings. Evidence/persistence validation rejects changed warning provenance.

For this local repair, only the identified `ch01.pdf` (material 2, course 1) was queued and claimed atomically under the new pipeline; the additive warning column was applied. Its original was read with the stored GCS generation. The actual tokenizer and embedding model produced **58 chunks and 58 embeddings**, published with a partial-coverage warning. Old runs and citations were retained; other course materials were not backfilled.

Actual authorized retrieval and VT ARC generation answered the computer-system question with a page **5** reference. The answer included hardware, operating system, application programs and users, which were checked against the source passage. A second operating-system-components request also passed structural generation/citation validation; this is not an independent semantic evaluation of that response. No test answers were added to the user's chat history. Real evidence excerpts were sent to ARC as required by the requested course-answer test.

All **126 backend tests in 22 files**, backend/frontend builds and browser checks passed. Browser fixtures also checked partial-coverage warnings in chat references, source navigation and material status. The local test database and browser server were stopped afterward. Structural validation is not a substitute for instructor-reviewed citation entailment evaluation.
