---
name: genui-cards
description: Component specification and layout rules for kulo_ui_show / kulo_ui_update interactive and structured HeroUI v3 cards. Read before composing multi-element, table-selection, chart, or tabbed card specs.
metadata:
  kulo-audiences: chat, settings
---

# Generative UI Cards (`kulo_ui_show` / `kulo_ui_update`)

Publish durable, schema-validated HeroUI v3 cards in the active conversation. Each card should serve a single interactive decision, parameter group, selectable/exportable table, or compact data-toggle chart—never wrap ordinary prose answers in a large console or nested cards. For non-interactive editorial charts, annotated trends/price trajectories, or inline diagrams without card chrome, prefer `kulo_ui_diagram` (`diagram-design`).

## Layout & Restraint
- Prefer `Stack` as the root container: use `gap: "sm"` for compact display groups, and omit `gap` (or use `gap: "md"`) for multi-field forms to preserve standard 16px field spacing.
- The outer card shell already renders `title` and status—avoid duplicate inner headings, nested `Card`/`Disclosure` wrappers, decorative filler text, or unrelated metrics.
- Use `Grid`, `Tabs`, or `Disclosure` only when grouping or switching genuinely related views.

## Flat `json-render` Spec Structure
- `spec` format: `{ root: string, elements: Record<string, { type: string, props: object, children?: string[] }>, state?: { values?: Record<string, unknown> } }`.
- Limits: `schemaVersion`/`catalogVersion` = `1`, max `80` elements, max depth `8`.
- Forbidden in `spec`: event handlers (`on*`), inline JS, `style`, `class`, raw URLs, or tool names.

## Component Catalog
- **Containers** (reference child IDs via `children`):
  - `Card(title?, description?)`
  - `Stack(gap?: "sm" | "md" | "lg")`
  - `Grid(columns?: 1 | 2 | 3)`
  - `Tabs(tabs: [{ id, label }])` — `children` must have exactly one child ID per tab in matching order.
  - `Disclosure(title, defaultExpanded?)`
- **Display**:
  - `Text(text?, field?, tone?: "default" | "muted", size?: "sm" | "md" | "lg")`
  - `Metric(label, value?, field?, unit?)`
  - `Chip(text, variant?: "secondary" | "soft" | "primary", tone?)`
  - `Table(columns: [{ key, label }], rows, caption?, field?, selectionMode?: "single" | "multiple", rowKey?)` — omit `field` for read-only tables; when `field` is set, `rows` must be non-empty (`rowKey` names a unique string/number row ID, defaulting to 0-based row index string).
  - `Chart(type: "bar" | "line", data: [{ label, value }], label?)`
  - `Media(assetId, alt?)` — must reference an authorized `assetId` in the current conversation.
  - `Code(code, language?, fileName?)`
- **Inputs** (`field` must be a plain key without `/` or `.`; initial values go in `spec.state.values`):
  - `TextField(field, label, placeholder?, multiline?, required?, maxLength?)`
  - `NumberField(field, label, min?, max?, step?, required?)`
  - `Select(field, label, options: [{ value, label }], required?)`
  - `Choice(field, label?, options: [{ value, label, description? }], multiple?, required?)`
  - `Slider(field, label, min?, max?, step?, unit?)`
  - `Switch(field, label)`
  - `Checkbox(field, label)`
- **Actions**:
  - `Button(actionId, label?, variant?: "primary" | "secondary" | "danger")` — `actionId` must match an entry `id` in top-level `actions: [{ id, label, kind: "submit" | "cancel", fields? }]`.
  - Submitting a card sends structured user input back to the conversation (`submitted` does not mean external work is finished). Submitted or cancelled cards cannot be updated via `kulo_ui_update`.
