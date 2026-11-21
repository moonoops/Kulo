# Standalone Offline HTML Report Layout (Editorial Standard)

Use this layout when a Worker delivers a full standalone `.html` report via `interactive-html` + `kulo_publish_asset`.

## Core Design Discipline

- **100% offline**: Zero Google Fonts, zero external CDN CSS/JS/images. Inline all styles, SVGs, and scripts.
- **Calm editorial hierarchy**: Neutral surfaces (`--d-paper`, `--d-paper-2`), 1px hairline borders (`--d-rule-solid`), zero heavy drop shadows, zero neon gradients, restrained single accent (`--d-accent`).
- **Automatic Light/Dark + Print Support**:
  - Define `:root` light tokens + `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }` + `:root[data-theme="dark"] { ... }`.
  - Optionally include a single quiet light/dark toggle button in the report header (no multi-theme switches).
  - Always include `@media print` rules: hide interactive controls, prevent page splits inside `<figure>` (`break-inside: avoid`), and let SVGs scale to paper width.

## Recommended Document Skeleton

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>报告标题</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      --d-paper: #ffffff;
      --d-paper-2: #f4f4f5;
      --d-ink: #18181b;
      --d-muted: #52525b;
      --d-soft: #71717a;
      --d-rule: rgba(24, 24, 27, 0.14);
      --d-rule-solid: #d4d4d8;
      --d-accent: #2563eb;
      --d-accent-tint: rgba(37, 99, 235, 0.09);
      --d-link: #1d4ed8;
      --d-success: #15803d;
      --d-warning: #b45309;
      --d-danger: #b91c1c;
      --d-font-sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
      --d-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --d-paper: #18181b;
        --d-paper-2: #27272a;
        --d-ink: #f4f4f5;
        --d-muted: #a1a1aa;
        --d-soft: #8f8f99;
        --d-rule: rgba(244, 244, 245, 0.15);
        --d-rule-solid: #3f3f46;
        --d-accent: #60a5fa;
        --d-accent-tint: rgba(96, 165, 250, 0.14);
        --d-link: #93c5fd;
        --d-success: #4ade80;
        --d-warning: #fbbf24;
        --d-danger: #f87171;
      }
    }
    :root[data-theme="dark"] {
      --d-paper: #18181b; --d-paper-2: #27272a; --d-ink: #f4f4f5; --d-muted: #a1a1aa;
      --d-soft: #8f8f99; --d-rule: rgba(244, 244, 245, 0.15); --d-rule-solid: #3f3f46;
      --d-accent: #60a5fa; --d-accent-tint: rgba(96, 165, 250, 0.14);
      --d-link: #93c5fd; --d-success: #4ade80; --d-warning: #fbbf24; --d-danger: #f87171;
      color-scheme: dark;
    }
    body { margin: 0; background: var(--d-paper); color: var(--d-ink); font: 400 15px/1.68 var(--d-font-sans); }
    .report { max-width: 920px; margin: 0 auto; padding: 36px 24px 64px; }
    .report-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 20px; border-bottom: 1px solid var(--d-rule-solid); margin-bottom: 28px; }
    .report-header h1 { margin: 0 0 6px; font-size: 26px; line-height: 1.25; font-weight: 600; letter-spacing: -0.02em; }
    .report-meta { margin: 0; font-size: 13px; color: var(--d-muted); }
    .kpi-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 0 0 32px; }
    .kpi { padding: 14px 16px; border: 1px solid var(--d-rule-solid); border-radius: 12px; background: var(--d-paper-2); }
    .kpi-label { font-size: 12px; color: var(--d-muted); margin-bottom: 4px; }
    .kpi-value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
    section { margin-bottom: 36px; }
    section h2 { margin: 0 0 12px; font-size: 18px; line-height: 1.4; font-weight: 600; }
    figure.diagram-figure { margin: 16px 0; padding: 16px; border: 1px solid var(--d-rule-solid); border-radius: 14px; background: var(--d-paper); break-inside: avoid; }
    figure.diagram-figure svg { width: 100%; height: auto; display: block; }
    figure.diagram-figure figcaption { margin-top: 10px; font-size: 13px; color: var(--d-muted); }
    table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px; }
    th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--d-rule); vertical-align: top; }
    th { font-weight: 600; background: var(--d-paper-2); }
    @media (max-width: 600px) { .report { padding: 20px 14px 40px; } }
    @media print { .no-print { display: none !important; } .report { max-width: none; padding: 0; } }
  </style>
</head>
<body>
  <main class="report">
    <!-- Header, KPI strip (only when numbers exist), concise sections with embedded SVGs + clean tables -->
  </main>
</body>
</html>
```

## Pre-Delivery Report Check

Run `node <skill-dir>/scripts/check-diagram.mjs --strict <report.html>` to verify every embedded `<svg>` passes security, offline safety, viewBox bounds, and geometry checks before calling `kulo_report` / `kulo_publish_asset`.
