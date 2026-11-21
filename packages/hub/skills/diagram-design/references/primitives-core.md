# Core SVG Primitives & Connector Rules

## Required Paint Order

Always structure the SVG DOM from back to front:
1. `<title>` & `<desc>` (plain text only)
2. `<defs>` (markers, gradients, patterns)
3. Grouping zones / swimlane bands (`<g id="zones">`)
4. Connectors / arrows (`<g id="edges">`)
5. Arrow label masks + text (`<g id="edge-labels">`) — never overlapping nodes painted after them
6. Nodes (`<g id="nodes">`)
7. Optional bottom legend strip (`<g id="legend">`)

## Standard Arrow Markers

```xml
<defs>
  <marker id="arrow" viewBox="0 0 8 6" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="var(--d-muted)"/>
  </marker>
  <marker id="arrow-accent" viewBox="0 0 8 6" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="var(--d-accent)"/>
  </marker>
  <marker id="arrow-link" viewBox="0 0 8 6" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="var(--d-link)"/>
  </marker>
</defs>
```

## Standard Node Box (4px Grid, No Shadow)

```xml
<g>
  <rect x="48" y="64" width="152" height="60" rx="6" fill="var(--d-paper)" stroke="var(--d-ink)" stroke-width="1"/>
  <text x="124" y="88" text-anchor="middle" font-family="var(--d-font-sans)" font-size="13" font-weight="600" fill="var(--d-ink)">API 网关</text>
  <text x="124" y="108" text-anchor="middle" font-family="var(--d-font-mono)" font-size="11" fill="var(--d-muted)">:443 / TLS</text>
</g>
```

Focal node (max 1–2 per diagram): use `fill="var(--d-accent-tint)" stroke="var(--d-accent)" stroke-width="1.5"`.

## Arrow Label Mask Pattern

Every connector label sits on an opaque `fill="var(--d-paper)"` rect so strokes never bleed through text:

```xml
<path d="M 200 94 L 296 94" fill="none" stroke="var(--d-muted)" stroke-width="1.25" marker-end="url(#arrow)"/>
<rect x="220" y="74" width="56" height="16" rx="2" fill="var(--d-paper)"/>
<text x="248" y="85" text-anchor="middle" font-family="var(--d-font-mono)" font-size="10" fill="var(--d-muted)">JSON</text>
```

## Six Mandatory Connector Rules

1. **Orthogonal only**: Use straight horizontal/vertical `<line>` when aligned, or rounded right-angle elbows (`Q` corner radius `6–8px`) when off-axis. Diagonal connectors fail (only cyclic/radial/curve diagrams use `data-radial="true"` or cubic `C` curves).
2. **Label clarity**: Keep edge labels short (≤ 14 chars / ≤ 6 CJK chars) on an opaque `var(--d-paper)` mask with ≥ 6px clearance from the stroke; never stack text sideways with `writing-mode`.
3. **No overlapping trunks**: Offset parallel edges by ≥ 12px.
4. **Distributed attach points**: When `N` edges connect to the same box edge of length `L`, space ports at `L * k / (N + 1)`, at least `12px` apart and `>= 8px` away from corners.
5. **No transit through boxes**: Reroute connectors around intermediate nodes. If geometrically unavoidable, use dashed stroke (`stroke-dasharray="4,3"`).
6. **Mask paint order**: Ensure no arrow label mask rect overlaps a node `<rect>` declared later in the SVG.
