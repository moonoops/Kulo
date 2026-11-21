# Quantitative Flow: Sankey, Pipeline & Medallion

## Sankey Diagram (Splitting & Merging Quantities)
- **Stages**: 2–4 vertical columns (`x` evenly spaced), thin vertical node bars (`width="12–16"`, `rx="3"`), heights strictly proportional to values.
- **Flow ribbons**: Smooth cubic Bézier bands (`C` commands with horizontal tangents at endpoints, `fill="var(--d-muted)" opacity="0.22"`, focal flow in `var(--d-accent)` `opacity="0.32"`). Never use sharp straight polygons.
- **Labels**: Outside left/right columns with exact numeric value + percentage (`12px mono var(--d-muted)`).

## Data Flow / Pipeline / Medallion Tiers
- **Pipeline stages**: Left-to-right 3–5 stages (e.g. Ingest → Bronze → Silver → Gold → Serving), each stage framed in a subtle column header with explicit quality/governance badge and orthogonal handoff arrows.
- **Bottleneck / Fan-in**: Show finite queue slots as small equal-width tick bars (`rect`) inside the queue box so capacity is visible at a glance.
