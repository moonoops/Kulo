---
name: interactive-html
description: Design and deliver self-contained offline interactive HTML deliverables (visualizations, diagrams, dashboards, prototypes) that render cleanly in Kulo's sandboxed preview.
metadata:
  kulo-audiences: chat, worker
---

# Standalone Offline Interactive HTML

Use standalone `.html` files when the user asks for an interactive visual, diagram, data dashboard, calculator, or prototype that goes beyond a compact `kulo_ui_show` card.

- **Strictly Self-Contained Offline Bundle**: Inline all CSS, JavaScript, SVG icons, and data directly inside the single `.html` file. Never reference external CDNs (`unpkg`, `jsdelivr`, `cdnjs`, Google Fonts, remote CSS/JS) or unbundled relative assets—Kulo renders HTML previews inside an offline sandboxed frame where external requests fail.
- **Visual Craft & Theme Adaptation**: Support both light and dark modes via CSS custom properties and `@media (prefers-color-scheme: dark)` (plus an optional clean view toggle when helpful). Maintain legible contrast, clear visual hierarchy, responsive layout down to narrow mobile widths (`360px+`), and uncluttered typography without decorative filler. For multi-section reports or embedded diagrams, read `diagram-design` (`references/report-layout.md` & `references/style-guide.md`) so embedded SVGs share the same restrained hairline style, `--d-*` tokens, and `@media print` hygiene.
- **Interactive Reliability**: Build diagrams and charts with native inline SVG or Canvas; handle empty states, resize/responsive redraws, keyboard focus, and reduced-motion (`prefers-reduced-motion: reduce`). Avoid unescaped `innerHTML` with dynamic strings, broken event listeners, or silent runtime errors.
- **Verification & Delivery**: Write the file to the ticket `scratchDir` (or authorized output path), verify valid HTML/JS syntax with no syntax or runtime errors (when embedding SVG diagrams, materialize `diagram-design` and run `node <skill-dir>/scripts/check-diagram.mjs --strict <report.html>`), and stage it for preview via `kulo_report` `files` (or `kulo_publish_asset`). Keep the accompanying summary concise—let the interactive artifact carry the visual detail.
