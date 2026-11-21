# Hierarchy: Tree, Org Chart, Layer Stack & Nested Scope

## Tree / Org Chart
- **Orientation**: Top-down (≤ 3 levels, ≤ 9 leaves) or left-to-right (deep/long labels).
- **Orthogonal bus routing**: One horizontal/vertical trunk line branching into children with rounded elbows (`r="6"`), never diagonal fan lines.

## Layer Stack (Abstraction / Governance Layers)
- **Structure**: 3–5 full-width horizontal bands stacked vertically (`gap="12px"`), `rx="8"`.
- **Internal columns**: Inside each band, subdivide into 2–4 peer modules (`rx="6"`, `fill="var(--d-paper)"`) aligned across layers so vertical alignment conveys ownership without needing cluttered arrows.
- **Side rail (optional)**: A narrow vertical bar on the left or right for cross-cutting concerns (Security, Observability, Auth).

## Nested Containment
- Concentric rounded containers (`rx="10"` outer → `rx="8"` middle → `rx="6"` inner) showing isolation scopes (e.g. Host → Sandbox → Process) with top-left scope labels and `16px` padding per level.
