# Timeline & Gantt Schedule

## Timeline (Milestones on an Axis)
- **Horizontal axis**: Single `1.5px` baseline (`var(--d-rule-solid)`) at vertical center (`y="170"` in `760×340`).
- **Events (4–7 max)**: Alternating above and below the axis with crisp vertical stems (`stroke="var(--d-rule-solid)"`), small circular nodes (`r="5"`), date/phase in `11px mono var(--d-muted)`, milestone title (`13px 600`) and 1-line note (`11px muted`). Highlight current/key milestone with `var(--d-accent)`.

## Gantt / Phase Schedule
- **Grid**: Left task column (`160–190px`), right time columns (`4–8` equal periods) separated by faint vertical hairlines (`stroke="var(--d-rule)"`).
- **Bars**: `height="20"`, `rx="4"`; standard tasks in `var(--d-paper-2)` with `var(--d-ink)` stroke, critical path or current phase in `var(--d-accent-tint)` with `var(--d-accent)` stroke.
- **Today / Cut line**: Optional vertical dashed line (`stroke="var(--d-accent)" stroke-dasharray="4,3"`) with top label.
- **Dependencies**: Short orthogonal elbows only where precedence genuinely matters (≤ 6 arrows).
