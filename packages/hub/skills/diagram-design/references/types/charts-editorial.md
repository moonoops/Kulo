# Editorial Charts: Trends, Trajectories, Waterfall, Bar/Dumbbell, Slopegraph, Radar & Heatmap

Use these when **annotated quantitative or phase storytelling** beats plain prose or an interactive table (`kulo_ui_show`).

## Trend Line & Annotated Trajectory (Exact Series)
- **Canvas**: `viewBox="0 0 720 320"` (or `680×300`), generous margins (`left: 64`, `right: 32`, `top: 28`, `bottom: 48`) so axis ticks and milestone notes never clip.
- **Grid & axes**: 3–5 faint horizontal gridlines (`stroke="var(--d-rule)" stroke-width="1"`), solid baseline (`var(--d-rule-solid)`), tabular numeric y-axis labels (`11px var(--d-muted)`), x-axis date/stage labels cleanly spaced without rotation.
- **Series & focal emphasis**: Primary trend `<path>` or `<polyline>` (`fill="none" stroke="var(--d-accent)" stroke-width="2.25"`), optional soft area wash underneath (`fill="var(--d-accent-tint)" opacity="0.45"`), secondary comparison series in `var(--d-muted)` (`stroke-width="1.5"`).
- **Direct labels & event callouts**: Mark turning points with small dots (`r="4" fill="var(--d-accent)" stroke="var(--d-paper)" stroke-width="1.5"`) and place direct values right above/below key points. For turning-point events (e.g. launch date, price break, policy change), draw a vertical dashed guide (`stroke="var(--d-rule-solid)" stroke-dasharray="3,3"`) with a crisp 1-line annotation badge.

## Benchmark-Relative Phase / Range Trajectory (Sparse or Qualitative Sources)
- Use when verified sources report **stages, ranges, or relative deltas** rather than daily exact ticks (e.g. pre-order premium → official MSRP launch → channel drop `-200`).
- **Anchor to a verified benchmark**: Draw a full-width horizontal dashed reference line (`stroke="var(--d-ink)" stroke-dasharray="4,3"`) labeled with the verified baseline (e.g. `官网基准价 15,999 元`).
- **Phase zones & honest curves**: Divide the x-axis into 3–4 clearly labeled time/stage bands (`var(--d-paper-2)` alternating softly or separated by faint vertical hairlines). Use a smooth cubic curve (`C`) or soft range band (`fill="var(--d-accent-tint)" opacity="0.55"`) to show direction & relative magnitude, with **qualitative or verified delta callouts** (`高溢价数万元`、`约 -200 元`)—never invent fake intermediate numeric ticks.
- **Mandatory honesty note**: Place a quiet footnote at bottom-right (`10px var(--d-soft)`): e.g. `示意 · 基于公开报道阶段与区间，非逐日成交价`.

## Waterfall (Running Total Bridge)
- Start & End total bars anchored at baseline `0` (`fill="var(--d-ink)"`); intermediate positive deltas in `var(--d-success)`, negative deltas in `var(--d-danger)`, bridged by thin horizontal dashed connector lines (`stroke="var(--d-rule-solid)" stroke-dasharray="3,2"`). Direct value labels (`+12%`, `-4%`) directly above/below every bar.

## Horizontal Bar / Dumbbell Comparison
- Prefer **horizontal bars** when category names are Chinese or multi-word (zero rotated x-axis labels!). Direct data labels at bar ends (`font-variant-numeric: tabular-nums`), faint baseline only, no heavy chart junk.
- **Dumbbell**: Two connected dots (Before in `var(--d-muted)` hollow/soft, After in `var(--d-accent)` filled) along a clean horizontal track showing magnitude & direction of shift.

## Slopegraph / Radar / Heatmap
- **Slopegraph**: Two vertical axes comparing exact Before/After rank or value (use `data-radial="true"` on diagonal connecting lines).
- **Radar (3–5 axes, ≤ 3 series)**: Concentric faint polygon grid (`var(--d-rule)`), translucent polygon fills (`opacity="0.14"`), crisp strokes (`1.5px`).
- **Heatmap**: Rectangular cells with step-quantized opacity of `var(--d-accent)` or semantic color + direct numeric value inside each cell for accessibility.
