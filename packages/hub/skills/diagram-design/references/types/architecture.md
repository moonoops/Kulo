# Architecture & Architecture Delta

## Layout Grammar
- **Direction**: Left-to-right (request flow) or top-to-bottom (client → edge → services → storage). Pick one primary axis.
- **ViewBox**: `0 0 760 400` (compact) or `0 0 840 460` (with zones).
- **Zones / Trust Boundaries**: Draw zone `<rect rx="8" fill="var(--d-paper-2)" stroke="var(--d-rule-solid)" stroke-dasharray="4,3"/>` FIRST, with an `11px` soft header label at top-left (`x+12, y+20`).
- **Nodes**: `136–164 × 56–64px`, `rx="6"`, on 4px grid. Reserve `--d-accent` for the 1–2 central components.
- **Edges**: Draw before nodes; orthogonal elbows (`Q` radius `8px`); external HTTP/RPC calls in `var(--d-link)`, async/optional in `stroke-dasharray="5,4"`.

## Architecture Delta (Before / After Topology)
- Use two aligned panels (`Before` left, `After` right) with identical component coordinates so topology diffs jump out visually.
- Highlight added components/edges with `var(--d-success)` (solid), removed components/edges with `var(--d-danger)` (`stroke-dasharray="4,3"`, subtle `opacity="0.65"`), and changed paths with `var(--d-accent)`.
- If only attributes changed without topology change, use a Markdown table instead.
