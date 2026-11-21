# Style Guide & Semantic Tokens (Kulo Native)

Every diagram uses Kulo semantic CSS variables (`--d-*`) so one SVG adapts natively to Light mode, Dark mode, custom Kulo appearances, and standalone HTML reports.

## Semantic Color Roles

| Token | Role | Usage |
| --- | --- | --- |
| `var(--d-paper)` | Canvas & opaque mask fill | Default node background, arrow label masks |
| `var(--d-paper-2)` | Subtle container tint | Grouping zones, secondary nodes, table/legend strips |
| `var(--d-ink)` | Primary text & crisp stroke | Node titles, primary structural borders |
| `var(--d-muted)` | Secondary text & default arrows | Sublabels, default connector strokes, axis ticks |
| `var(--d-soft)` | Quiet annotations | Boundary captions, gridlines, tertiary labels |
| `var(--d-rule)` | Hairline dividers | Soft container borders, chart gridlines |
| `var(--d-rule-solid)` | Crisp borders & baselines | Node strokes (`stroke-width="1"`), axis baselines |
| `var(--d-accent)` | Focal emphasis (**max 1–2 elements**) | Headline path, primary focal node border & marker |
| `var(--d-accent-tint)` | Focal fill | Soft fill inside the 1–2 focal nodes |
| `var(--d-link)` | External / network call | HTTP/RPC/API call arrows |
| `var(--d-success)` | Positive / allowed | Passing gates, healthy targets, positive deltas |
| `var(--d-warning)` | Caution / throttled | Queues, retries, pending gates |
| `var(--d-danger)` | Error / blocked | Denied paths, failure states, negative deltas |

## Node Treatments

| Node Role | Fill | Stroke | Notes |
| --- | --- | --- | --- |
| **Focal (1–2 max)** | `var(--d-accent-tint)` | `var(--d-accent)` (`1.5px`) | Reserve for the core point of the diagram |
| **Primary / Service** | `var(--d-paper)` | `var(--d-ink)` (`1px`) | Core actors or modules |
| **Secondary / Support** | `var(--d-paper-2)` | `var(--d-rule-solid)` (`1px`) | Supporting services, caches, helpers |
| **Container / Zone** | `var(--d-paper-2)` | `var(--d-rule-solid)` (`1px`, optional `stroke-dasharray="4,3"`) | Draw zones first, before arrows and nodes |
| **External / Optional** | `var(--d-paper)` | `var(--d-muted)` (`1px`, `stroke-dasharray="5,4"`) | Third-party APIs, async/optional components |

## Offline Typography & CJK Rules

- **Sans (names & labels)**: `font-family="var(--d-font-sans)"` — resolves offline to `-apple-system, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif`.
- **Mono (technical IDs, ports, URLs, methods, short badges)**: `font-family="var(--d-font-mono)"` — never use mono as a blanket body font.
- **Type ramp**:
  - Node title: `13px–14px`, `font-weight="600"`, `fill="var(--d-ink)"`
  - Node sublabel / detail: `11px–12px`, `font-weight="400"`, `fill="var(--d-muted)"`
  - Arrow label / badge tag: `10px–11px`, `font-weight="500"`, `fill="var(--d-muted)"`
  - Zone header: `11px`, `font-weight="600"`, `fill="var(--d-soft)"`
- **CJK width budgeting**: Chinese/Japanese/Korean glyphs occupy ~`1.0em` each. For `font-size="13"`, 8 Chinese characters need ~104px + 24px horizontal padding → box width ≥ `132px` (rounded to 4px grid). Wrap longer descriptions across 2 `<tspan>` lines rather than cramping text against borders.
