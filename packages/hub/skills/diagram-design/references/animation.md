# Optional Step / Reveal Animation

Animation explains ordered progression on top of a **complete static diagram**; it never hides essential meaning. Use `motion="none"` by default for 95% of chat diagrams.

## When to Enable Motion

- `motion="step"`: User explicitly asks for step-by-step walkthroughs, protocol handshakes, policy traces, or state transitions where stepping through 3–8 stages adds clear value.
- `motion="reveal"`: One-shot progressive reveal for short ordered sequences (never auto-loops).
- `motion="none"` (default): Everything else — users should grasp the whole figure in a glance.

## Markup Contract

1. Mark participating elements or `<g>` groups with `data-motion-item="true"` and integer `data-step="1"` through `data-step="8"`.
2. Budget: max **8 steps**, max **16 marked items**, at most 2–3 items introduced per step.
3. Never write `<script>` inside your SVG — Kulo's sandboxed wrapper provides the audited, localized (Chinese/English) playback controller automatically.
4. Keep the static SVG 100% readable when all items are visible (under `prefers-reduced-motion: reduce`, print, or SVG/PNG export, all items show at full opacity and controls stay hidden).
