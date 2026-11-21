# ER Diagram & Physical Database Schema

## Layout Grammar
- **Budget**: ≤ 6 entities/tables, ≤ 6 key columns per table (elide boilerplate `updated_at` unless central to the point).
- **ViewBox**: `0 0 760 420` (2×2 or 3-column aligned grid).
- **Entity / Table Card**:
  - Outer `<rect rx="6" fill="var(--d-paper)" stroke="var(--d-ink)" stroke-width="1"/>`
  - Header strip (`height="32"`, `fill="var(--d-paper-2)"`) with table name (`13px 600`) and bottom `1px` hairline.
  - Rows (`height="24"` each): column name left-aligned (`11px mono var(--d-ink)`), SQL type / constraint (`PK`, `FK`, `UQ`) right-aligned (`10px mono var(--d-muted)`). Highlight PK/FK tags with `var(--d-accent)` or `var(--d-link)`.
- **Relationships**: Orthogonal connectors exiting row level (for column-level FKs) or table mid-edge; label cardinality (`1:N`, `1:1`, `N:M`) cleanly on opaque `var(--d-paper)` masks at endpoints.
