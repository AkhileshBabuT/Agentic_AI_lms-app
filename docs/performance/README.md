# Performance measurements

Use a seeded **non-production** database and synthetic users/course content. Record the Git commit, CPU, RAM, browser version, network throttling, viewport, fixture counts, and database version for every run. Do not put tokens, prompts, answers, filenames, signed URLs, or student data in this report.

## Baseline: 2026-09-30

On the local Windows development machine, `cd frontend; npm run build` completed successfully with Vite 4.5.14. The build reported one eager JavaScript file of **511.34 kB** (151.31 kB gzip) and one CSS file of **72.97 kB** (12.87 kB gzip). This is the pre-splitting baseline. No authenticated seeded database or real browser measurements were supplied, so route latency, Web Vitals, pool wait, query plans, and p95 request latency have no defensible baseline yet.

## Repeat a comparison

1. Use the same seeded fixture (record number of users, courses, sessions, messages, materials, submissions), hardware and build mode for both revisions.
2. Run `cd frontend; npm run build`. Record the `dist/assets/index-*.js` size and list emitted lazy chunks. Avoid committing `dist/`.
3. Start the backend API and ingestion worker separately. From `backend`, run:

   ```powershell
   npm run benchmark:routes -- --base-url http://127.0.0.1:5000 --bearer-token <synthetic-token> --concurrency 8 --duration-seconds 60 --message-session-id <synthetic-session-id>
   ```

   Keep the bearer token out of shared logs or screenshots. This read-only probe reports counts and p50/p95 for health, student courses, chat sessions, and messages. Run three times per revision and compare medians. A 401/403/404 contributes to the error count and invalidates the intended route measurement.
4. Use browser Performance and Network panels with the same viewport and cache state. Capture LCP, INP, CLS, navigation-to-usable time, duplicate GET count, and transfer size for login, student dashboard, professor dashboard, chat, and source viewing. Compare cold and warm navigation separately.
5. For representative synthetic list and chat queries, use `EXPLAIN (ANALYZE, BUFFERS)` on the isolated fixture database. Record query count and elapsed time. Do not run `EXPLAIN ANALYZE` against production student data.
6. Record server request completion logs by normalized route and request ID. The `Server-Timing` header exposes time through first response headers; completion logs expose full response duration.

Relative comparisons only are valid until the same environment can run both revisions. Real VT ARC generation and answer quality require the separately documented instructor evaluation and network access.

## Database deployment order

Run `cd backend; npm run db:migrate` against the intended database before starting a production API replica. The command applies the idempotent base-table migration and the ordered additive SQL migrations, records schema version 9, then exits. Production API startup checks core tables and that version; it does not apply DDL. Local development retains automatic migration unless `DB_AUTO_MIGRATE=false`. Set bounded pool options with `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS`, and `DB_STATEMENT_TIMEOUT_MS` when deployment capacity differs from defaults. Start the material worker as a separate process after migration. Re-run the migration command only during a controlled deployment window; do not rely on API startup for schema changes.
