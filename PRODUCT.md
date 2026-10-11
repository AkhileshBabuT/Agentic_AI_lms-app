# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Students, professors, and root administrators have equal priority. Design decisions must account for each role's workflows rather than treating one role as secondary.

- Students access enrolled courses, study materials, submit assignments, view feedback, and ask course questions.
- Professors manage course materials, assignments, rubrics, announcements, and grading.
- Root administrators manage users, approvals, courses, and course assignments.

## Product Purpose

An AI-assisted learning management system that brings course administration, teaching, and learning into one web application. Success means each role can complete its work clearly and reliably, with inspectable evidence for AI-assisted course answers and human control over final grades.

## Operating Context

agentic LMS is a demo intended for use by Virginia Tech. Keep its positioning and scope as a demo; do not present it as a production deployment or imply institutional endorsement.

Course enrollment and role permissions determine access. Professors upload course materials; background indexing makes supported text available to the course tutor. Students use course resources and submit coursework. Professors review tentative AI grades before finalizing grades.

## Brand Commitments

The product name is **agentic LMS**. Virginia Tech is the intended institution; official logos and other institutional brand assets have not been authorized or specified.

## Capabilities and Constraints

The following implementation facts are supported by current source and CLAUDE.md:

- Course chat answers from authorized course materials with citations and exact source excerpts. Insufficient evidence and inaccessible sources have explicit states.
- Course chat uses VT ARC generation; deployment access and provider configuration affect availability.
- Material ingestion is asynchronous, with status, retries, and partial-text coverage warnings. OCR is disabled in the current course ingestion flow.
- AI-generated tentative grades are distinct from professor-finalized grades.
- Permissions must remain enforced across fresh answers, historical answers, saved content, and source views.
- The existing application uses React/TypeScript, an Express backend, PostgreSQL/pgvector, and private Google Cloud Storage.

## Evidence on Hand

- Current application routes and components under frontend/src and backend/src.
- Current operational and provenance constraints in CLAUDE.md and docs/production-rag.md.
- Recorded implementation checks and remaining acceptance gates in docs/performance/2026-10-03-progress.md.

Recorded checks are historical evidence, not proof of current deployment or a measured learning outcome. Older README descriptions of chat trust percentages, external fallbacks, and OCR do not override the current implementation.

## Product Principles

- Give all three roles equal attention while showing each role the tasks it can perform.
- Make course-answer evidence inspectable and uncertainty explicit.
- Preserve professor authority over final grades.
- Make upload, indexing, submission, and retry states understandable.
- Preserve access boundaries throughout each workflow.

## Open Decisions

- Demo hosting details, participant scope, and success metrics are not confirmed.
- Product-specific accessibility requirements beyond existing implementation have not been confirmed.
