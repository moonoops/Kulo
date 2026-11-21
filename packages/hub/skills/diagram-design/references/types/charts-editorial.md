# Editorial Charts: Waterfall, Dumbbell/Bar, Slopegraph, Radar & Heatmap

Use these when **annotated quantitative storytelling** matters more than interactive table filtering (`kulo_ui_show`).

## Waterfall (Running Total Bridge)
- Start & End total bars anchored at baseline `0` (`fill="var(--d-ink)"`); intermediate positive deltas in `var(--d-success)`, negative deltas in `var(--d-danger)`, bridged by thin horizontal dashed connector lines (`stroke="var(--d-rule-solid)" stroke-dasharray="3,2"`). Direct value labels (`+12%`, `-4%`) directly above/below every bar.

## Horizontal Bar / Dumbbell Comparison
- Prefer **horizontal bars** when category names are Chinese or multi-word (zero rotated x-axis labels!). Direct data labels at bar ends (`font-variant-numeric: tabular-nums`), faint baseline only, no heavy chart junk.
- **Dumbbell**: Two connected dots (Before in `var(--d-muted)` hollow/soft, After in `var(--d-accent)` filled) along a clean horizontal track showing magnitude & direction of shift.

## Line / Slopegraph / Radar / Heatmap
- **Slopegraph**: Two vertical axes comparing exact Before/After rank or value (use `data-radial="true"` on diagonal connecting lines).
- **Radar (3–5 axes, ≤ 3 series)**: Concentric faint polygon grid (`var(--d-rule)`), translucent polygon fills (`opacity="0.14"`), crisp strokes (`1.5px`).
- **Heatmap**: Rectangular cells with step-quantized opacity of `var(--d-accent)` or semantic color + direct numeric value inside each cell for accessibility.
