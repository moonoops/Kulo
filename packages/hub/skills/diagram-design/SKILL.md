---
name: diagram-design
description: Proactive inline SVG charts/trends/diagrams, --d-* tokens, HTML report layout.
metadata:
  kulo-audiences: chat, worker
  kulo-dependencies: node
---

# Diagram & Chart Design (Kulo Editorial System)

Create crisp, publication-grade inline SVG charts and diagrams for two contexts:
1. **Inline chat visuals (`kulo_ui_diagram`, Main Chat only)** — calm, frameless charts and illustrations embedded directly inside Kulo's reply. Never use `kulo_ui_diagram` in Settings Assistant (use `kulo_ui_show` instead).
2. **Standalone offline HTML reports (`interactive-html` + `kulo_publish_asset`, Workers)** — multi-section editorial reports embedding multiple clean SVG figures.

---

## 1. Proactive Visual Utility & Restraint (When to Draw vs. Skip)

Use contextual utility to decide automatically—do **not** wait for the user to explicitly ask for a chart when a visual materially cuts cognitive load, and do **not** draw decorative visuals for plain prose.

**Proactively draw (1 visual per reply, after a 1–2 sentence text takeaway):**
- **Trends, price trajectories, or phase shifts** (market/price changes over time, before/after evolution, milestone-annotated curves, benchmark deltas) → see `references/types/charts-editorial.md`.
- **Multi-item quantitative comparisons or breakdowns** (tiered pricing/specs comparison bars, dumbbell shifts, waterfalls, composition/flow splits).
- **Structures, mechanics, flows, timelines, or trade-offs** (system architectures, workflows, sequence diagrams, state machines, hierarchies, timelines/Gantt, 2×2 quadrants).

**Honest Data Fidelity (Sparse or Qualitative Sources):**
- **Exact numeric series available** → plot exact verified data points with direct value labels and units.
- **Only milestone dates, ranges, or relative deltas available** (e.g. "pre-order high premium → launch MSRP → 2 days later -200 below MSRP") → draw a **benchmark-relative phase trajectory / schematic chart** anchored to the verified baseline (e.g. official MSRP reference line) and explicitly note `"示意 · 基于公开报道阶段/区间"` in the chart footnote or caption. **Never fabricate unobserved intermediate daily values, and never omit the visual purely because daily ticks are missing.**

**Do NOT draw here:**
- Simple factual lookups, single values, short definitions, or brief ≤ 3-column static comparisons → **plain text or Markdown table**.
- Decisions, parameter forms, sliders, or filterable/selectable tables → **`kulo_ui_show`** (`genui-cards`).
- Multi-section reports or interactive simulators/calculators → delegate offline `.html` (`interactive-html` + `diagram-design`).

---

## 2. Complexity Budget & Kulo Aesthetic Rules

| Metric | Target Budget | Rule |
| --- | --- | --- |
| Nodes | ≤ 9 | Merge nodes that always travel together; split overview + detail if > 9 |
| Connectors | ≤ 12 | Remove arrows whose relationship is already obvious from layout |
| Accent (`--d-accent`) | ≤ 2 elements | Reserve for the 1–2 focal items; everything else stays neutral (`--d-ink` / `--d-muted`) |
| Grid | 4px | Node `x`, `y`, `width`, `height`, and gaps divide cleanly by 4 |
| Corners | `rx="6"` (nodes), `rx="2"` (badges) | Never bubbly `rx="20"` boxes; **no drop shadows**, use 1px hairline borders |

**Strict Anti-Patterns (Never Emit):**
- **No blog chrome inside inline SVGs**: never emit uppercase eyebrows (`ARCHITECTURE · DIAGRAM DESIGN`), dot-pattern paper backgrounds, or duplicate giant `<h1>` titles inside the SVG.
- **No hardcoded web fonts or external URLs**: 100% offline system fonts (`var(--d-font-sans)` / `var(--d-font-mono)`).
- **No hardcoded light-only colors**: always use semantic CSS tokens (`var(--d-paper)`, `var(--d-paper-2)`, `var(--d-ink)`, `var(--d-muted)`, `var(--d-soft)`, `var(--d-rule)`, `var(--d-rule-solid)`, `var(--d-accent)`, `var(--d-accent-tint)`, `var(--d-link)`, `var(--d-success)`, `var(--d-warning)`, `var(--d-danger)`) so Light, Dark, and custom Kulo appearances stay native.
- **No diagonal arrows** between off-axis boxes (use orthogonal elbows with `Q` radius `6–8px`; radial/curve exceptions mark `data-radial="true"`).
- **No raw arrow labels sitting directly on strokes**: draw arrows **before** boxes, and place every arrow label over an opaque `<rect fill="var(--d-paper)">` mask that does not collide with later nodes.
- **No vertical `writing-mode` text** on connectors.

---

## 3. Visual Type Routing (Load Reference Only When Needed)

Simple 3–6 node architectures or linear flows can be emitted directly in 1 hop. For richer layouts, load the matching reference via `kulo_skill_read`:

| Showing… | Reference |
| --- | --- |
| System components, trust boundaries, Before/After topology delta | `references/types/architecture.md` |
| Decision branches, state machines, lifecycle phases | `references/types/flowchart.md` |
| Time-ordered actor messages, cross-functional swimlanes/processes | `references/types/sequence.md` |
| Entities, relationships, physical SQL tables & foreign keys | `references/types/data-model.md` |
| Chronological milestones, Gantt tasks & phases | `references/types/timeline-gantt.md` |
| 2×2 prioritization quadrants, role/permission/comparison matrices | `references/types/quadrant-matrix.md` |
| Trees, org charts, stacked architecture layers, nested scopes | `references/types/hierarchy.md` |
| Splitting/merging quantities (Sankey), data pipelines, medallion tiers | `references/types/flow-quantitative.md` |
| Trend lines, annotated price/metric trajectories, phase schematics, waterfall/bar/dumbbell/radar/heatmap | `references/types/charts-editorial.md` |
| Reinforcing flywheels/loops, conversion funnels/pyramids, Venn overlaps | `references/types/loop-funnel.md` |
| Core tokens, contrast, CJK typography | `references/style-guide.md` |
| Reusable SVG markers, node boxes, 6 connector rules | `references/primitives-core.md` |
| Optional step-by-step reveal playback (`reveal` / `step`) | `references/animation.md` |
| Multi-section standalone offline HTML report layout | `references/report-layout.md` |

---

## 4. SVG Security & Geometry Contract

- Emit a single strict XML `<svg viewBox="0 0 W H">` (recommended width `640–840` for chat readability; height matching content cleanly).
- Keep `<title>` and `<desc>` plain text only (no child tags); never include `<script>`, `<foreignObject>`, `<a>`, `<image>`, SMIL `<animate*>`, `on*` attributes, external URLs, or `xlink:href` (use SVG 2 `href="#id"`).
- **CJK width budget**: Chinese characters are ~`1.0em` wide (`font-size="13"` → ~13px per char). Always leave ≥ 16px horizontal padding inside node `<rect>` boxes, or wrap long labels into two `<tspan x="..." dy="16">` lines.
- **Static by default**: use `motion="none"` for 95% of diagrams. Enable `motion="step"` or `motion="reveal"` only when ordered progression genuinely clarifies a trace or user asks for step-by-step playback.

---

## 5. Worker Verification for Standalone HTML Reports

When building a standalone `.html` report containing one or more inline SVGs:
1. Read `references/report-layout.md` and `references/style-guide.md`.
2. Materialize this skill into `scratchDir` via `kulo_skill_materialize(id="diagram-design")` and run:
   ```bash
   node <skill-dir>/scripts/check-diagram.mjs --strict <report.html>
   ```
3. Fix any reported L1/L2 clipping, mask-overlap, or text-overflow issues before delivering via `kulo_report` / `kulo_publish_asset`.
