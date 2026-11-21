# Flowchart & State Machine

## Flowchart / Decision Logic
- **Direction**: Top-to-bottom or left-to-right. Budget: ≤ 9 steps, ≤ 3 decision diamonds.
- **Decision nodes**: Diamond `<polygon>` or chamfered box with concise question (`≤ 10` CJK / `≤ 18` Latin chars).
- **Branch labels**: Always place `是 / 否` (or `Yes / No`) on opaque `fill="var(--d-paper)"` mask rects near the outgoing branch, never touching the stroke.
- **Happy path**: Straight main axis in `var(--d-ink)` or `var(--d-accent)`; error/fallback branches offset cleanly to the side with `var(--d-muted)` or `var(--d-danger)`.

## State Machine / Lifecycle Phase Map
- **States**: Rounded boxes (`rx="12"`) with state name (`13px 600`) and optional short invariant (`11px muted`).
- **Initial / Terminal markers**: Filled dot (`r="5" fill="var(--d-ink)"`) for start; double circle (`r="7"` outer + `r="4"` inner) for terminal state.
- **Transitions**: Orthogonal or clean arched return paths (mark intentional feedback loops with `Q`/`C` curves) labeled with `event [guard]` on opaque masks.
- **Containment**: Group sub-states in a `var(--d-paper-2)` container when sharing an exit/cancellation transition.
