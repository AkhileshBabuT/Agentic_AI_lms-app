# Local performance comparison — 2026-09-30

Both builds ran on the same local Windows machine with `frontend/npm run build` and Vite 4.5.14. The original build used a single eager JavaScript chunk.

| Metric | Baseline | Current build | Change |
| --- | ---: | ---: | ---: |
| Eager JavaScript | 511.34 kB | 317.73 kB | 37.9% smaller |
| Eager JavaScript gzip | 151.31 kB | 102.47 kB | 32.3% smaller |
| Eager CSS | 72.97 kB | 19.71 kB | 73.0% smaller |

Current figures reflect the latest recorded build on 2026-10-02, before the final mobile styling adjustment. Student, professor, root, chat, source viewer, and assignment pages have lazy chunks. The largest deferred JavaScript chunk is ChatInterface at 128.84 kB. These are bundle output sizes, not measured download or interaction times. Browser request deduplication is covered by query-module tests, but real navigation-to-usable timing, Core Web Vitals, backend p95 under pilot load, database query plans, and answer quality have no comparable local baseline. The browser suite uses synthetic fixtures; it is not a department load test. See [current progress](2026-10-03-progress.md) for verification limits and remaining work.
