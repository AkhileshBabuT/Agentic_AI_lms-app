# agentic LMS design system

## Direction

A contemporary academic workspace inspired by Virginia Tech: maroon navigation, creamy reading surfaces, burnt-orange emphasis, and a clear typographic hierarchy. This is a demo, with equal design attention for students, professors, and administrators.

## References

- https://brand.vt.edu/identity/color.html — maroon/orange hierarchy and digital contrast guidance.
- https://www.vt.edu — institutional navigation and editorial hierarchy reference; live retrieval was unavailable during implementation.

## Palette and type

Maroon #861f41 anchors the shell and primary actions; deep maroon #541328 provides contrast. Burnt orange #e87722 is an accent; darker orange #a83c00 is available for text. Cream #f8f4ec and paper #fffdf8 are app-specific neutrals, not claimed official brand colors. Semantic success, warning, and error remain distinct and labeled.

Readable sans-serif controls pair with a serif heading voice. Use locally available font stacks to avoid external runtime dependencies in the demo. Display headings use a restrained responsive scale; tables use tabular numerals, and reading surfaces retain comfortable line measures.

## Composition

The maroon navigation rail provides orientation beside a light account bar. A small orange rule distinguishes the product mark. Dashboard introductions are open typographic areas rather than colored hero cards. Summary counts share one horizontal band, and task lists have deliberate reading hierarchy instead of identical floating cards. No decorative section numbering or invented metrics.

## Interaction and resilience

Preserve route destinations, role filtering, labels, handlers, and data contracts. Mobile navigation remains a labeled drawer. Controls retain visible focus, hover, disabled, loading, empty, and error states. Motion is confined to a subtle active-navigation underline and honors reduced motion. All styling follows content order, wraps long labels, and avoids fixed content heights.

## Reuse

Tokens: frontend/src/styles/tokens.css. Shell: frontend/src/layout/shell.css. Shared controls: frontend/src/components/ui/ui.css. Dashboard composition: frontend/src/features/dashboard/dashboard.css. Workflow styles stay beside their pages.
