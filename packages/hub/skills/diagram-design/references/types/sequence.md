# Sequence & Swimlane / Process

## Sequence Diagram
- **ViewBox**: `0 0 760 440` (3–5 actors, 5–10 messages).
- **Actors**: Top row boxes (`120–144 × 40px`, `rx="6"`), evenly spaced horizontally. Vertical dashed lifelines (`stroke="var(--d-rule-solid)" stroke-dasharray="4,4"`) drawn FIRST.
- **Activation bars**: Narrow `8px`-wide vertical `<rect rx="2" fill="var(--d-paper-2)" stroke="var(--d-rule-solid)"/>` centered on active lifelines.
- **Messages**: Strict horizontal arrows (`y` spaced `40–48px` apart). Solid for synchronous call, dashed (`5,4`) for return/async. Label sits `8px` above the horizontal arrow (`text-anchor="middle"`), never colliding with lifelines.
- **Alt / Loop frame**: Light bordered `<rect fill="none" stroke="var(--d-rule-solid)"/>` with small top-left tag (`rx="2"`).

## Swimlane / Cross-Functional Process
- **Lanes**: 2–4 horizontal bands (`fill="var(--d-paper-2)"` alternating with `var(--d-paper)`) separated by `1px` `var(--d-rule-solid)` rules; left header column `96–112px` wide.
- **Handoffs**: Horizontal steps inside lanes, clean vertical elbows crossing lane boundaries with opaque label masks.
