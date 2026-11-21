# 2×2 Quadrant & Comparison / Security Matrix

## 2×2 Prioritization Quadrant
- **ViewBox**: `0 0 680 460` (balanced square plot area `440×340` with generous axis margin).
- **Axes**: Crosshair centered cleanly (`stroke="var(--d-rule-solid)" stroke-width="1"`), subtle quadrant corner captions (`11px var(--d-soft)`). Top-right focal quadrant may carry a gentle `var(--d-accent-tint)` wash.
- **Points (5–10 max)**: Crisp circles (`r="5–6"`), non-overlapping horizontal labels (`12px var(--d-ink)`). Reserve `var(--d-accent)` for the 1–2 highest-priority items.

## Role / Permission / Comparison Matrix
- **Use only when spatial/visual status glyphs beat a Markdown table** (e.g. security control matrices, capability coverage).
- **Grid**: Clean 1px `var(--d-rule)` grid lines; column headers horizontal (never vertical rotated text); cell values encoded with clear visual glyphs + text/symbol (`●` / `◐` / `○` or `允许` / `受限` / `禁止`), never color alone.
