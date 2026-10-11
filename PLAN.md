# agentic LMS interface redesign

## Goal and boundaries

Replace the generic visual treatment with a distinctive, coherent academic workspace for the Virginia Tech demo. Students, professors, and administrators receive equal priority. Preserve routes, permissions, data fetching, submissions, grading, source citations, and existing action handlers.

The user approved the visual direction: Virginia Tech website references, maroon red, burnt orange, and creamy white. Implementation follows the plan below while preserving existing functionality.

## Design discovery

Inspected the current tokens, app shell, navigation, and recorded role workflows. The existing interface relies on uniform cards, rounded containers, and repeated dashboard structures. Review the running pages before finalizing the visual diagnosis; source inspection alone is incomplete visual evidence.

## Approved visual direction

- Use Virginia Tech websites as references for color, typography, hierarchy, and navigation treatment. Inspect official sources before selecting exact tokens; reference research remains to be done.
- Maroon red anchors navigation, primary actions, and identity. Burnt orange provides restrained emphasis. Creamy white supplies the main background and reading surfaces.
- Use readable, deliberate typography, clear section hierarchy, and purposeful spacing instead of repeating identical rounded cards throughout every workflow.
- Retain precise academic information structure and evidence accents from the proposed direction, translated into the approved palette. Maroon replaces the proposed midnight blue.
- Keep familiar web controls and task-oriented layouts. Apply the system consistently to students, professors, and administrators with equal attention.
- Preserve existing functional labels and content. The product remains agentic LMS, a Virginia Tech demo; official logos and institutional endorsement are not implied by visual references.
- Verify text, controls, focus indicators, selection, and semantic status colors against accessibility requirements. Burnt orange must not carry meaning through color alone.

The user's explicit direction supersedes Impeccable's earlier generated options. Code-first implementation remains confirmed.

## Implementation and checks

1. Inspect official Virginia Tech website and brand references and record the approved system in DESIGN.md. Check: cited references, maroon/burnt-orange/creamy-white tokens, and a reusable hierarchy suitable for all three roles.
2. Read Impeccable craft-floor and applicable typeset/layout/colorize/adapt guidance. Inspect incumbent pages at desktop and mobile widths. Check: recorded visual evidence or an explicit tooling limitation.
3. Redesign shared tokens, shell, navigation, and reusable components. Check: existing routes and handlers preserved; readable controls, focus states, contrast, and mobile navigation.
4. Carry the approved system across all three dashboards, chat, course materials, assignments, and grading. Check: existing labels, data, actions, forms, loading/error/empty states, and role permissions preserved.
5. Run frontend lint, tests, and production build. Run relevant existing browser workflow checks when executable. Check: inspect actual outputs and distinguish unavailable checks from passing checks.
6. Use one batched desktop/mobile audit, correct defects together, then one confirmation pass. Check: no clipped content, inaccessible interactions, regressions in submission/grading/chat, or reduced-motion violations observed.

## Current status

Implemented on the local dev branch. The source-write restriction was resolved by the session's unrestricted permission profile; no ACL changes were needed.

- Shared tokens now use creamy canvas/paper surfaces, maroon actions, and burnt-orange emphasis. DESIGN.md records the approved direction.
- The app shell has a maroon navigation rail, light account bar, agentic LMS identity, and an SVG mobile menu icon.
- All three dashboards use clearer task hierarchy, serif content headings, grouped summary bands, and lighter list sections. Decorative eyebrow labels were removed.
- Login, course headers, chat reading/composer surfaces, assignment submissions, and professor grading pages inherit the palette and typography. Existing routes, API calls, role filtering, action handlers, and form behavior were preserved.
- Selection, caret, tabular numerals, and responsive layouts were refined. No dependencies, API changes, or backend changes were introduced.

## Verification

- Frontend lint passed without findings.
- All 7 unit/integration tests passed.
- All 37 existing Playwright tests passed, including accessible role workspaces, responsive navigation, upload/indexing, assignment submission, grading dialogs, source permissions, and streamed chat.
- Production TypeScript/Vite build passed. Entry JavaScript remains about 317.92 kB (102.54 kB gzip).
- Synthetic screenshots captured all three dashboards at 1440px and 390px; final captures report no horizontal overflow. Screenshots live under .impeccable/screenshots/verified-*.png.
- Impeccable detector ran on the shared shell and dashboard sources. Its border-accent warning concerns the product mark, which has square corners in the effective CSS; this is not evidence of an inaccessible card. The detector is not a substitute for rendered checks.
- Git whitespace check passed.

Browser checks use intercepted synthetic APIs, not live Virginia Tech users or production data. Live backend/provider behavior, manual assistive-technology review, and production deployment were not tested. The initial screenshot fixture omitted course-detail data and showed an error boundary; the fixture was corrected and successful final captures replaced that evidence. The temporary capture script was removed.

No commit, push, or deployment was performed. Existing untracked .codex and Impeccable files were preserved.

## Full-window workspace follow-up

Implemented full-width shell and workspace containers with a desktop hamburger toggle that collapses/restores the navigation rail. Mobile retains the existing drawer and Escape dismissal. Labels and aria-expanded reflect the current desktop state. Verification: existing 37 browser checks passed; 3 additional role-specific tests passed for 1920px expansion, collapse/restore, and mobile drawer operation; lint and production build passed. Changes remain local and uncommitted.

Backend verification follow-up: npm test (Vitest) passed: 28 test files and 140 tests. Two database integration files (19 tests) were skipped because the isolated integration database was not configured. Frontend verification remains 7 Vitest tests and 40 Playwright checks passed. Git diff --check passed.
