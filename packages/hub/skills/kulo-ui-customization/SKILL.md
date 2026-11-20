---
name: kulo-ui-customization
description: Safe workflow and HeroUI v3 design invariants for modifying Kulo's own Web UI source via kulo_customization when explicitly requested by the user.
metadata:
  kulo-audiences: chat, settings
---

# Kulo Web UI Self-Customization (`kulo_customization`)

Use `kulo_customization` only when the user explicitly asks to modify Kulo's own Web UI source code (use ordinary settings/appearance tools for theme colors, fonts, or standard preferences). Never mutate runtime state, credentials, or recovery paths via shell.

- **Managed Session Workflow**: Check `status` (`currentReleaseId`, `applicationState`) first, `prepare` a candidate session with a concise summary, `read` target files under `packages/web/{src,public,test}` before editing, apply minimal changes via `write` with the latest `expected_revision`, and run `validate` (which stages the build for the next launch after user confirmation). Use `cancel` to discard an unwanted candidate.
- **HeroUI v3 & Tailwind v4 Baseline**: Use `@heroui/react` v3 compound components (`Card.Header`, `Modal.Dialog`, `Switch.Content`, `Tabs.Tab`) and React Aria `onPress` handlers. Never introduce HeroUI v2 / NextUI flat props, `HeroUIProvider`, `@heroui/theme`, `framer-motion`, or legacy `--md-sys-*` / `--md-ref-*` Material tokens.
- **Shared Theme, Controls & Layout Contracts**:
  - Rely on built-in default light/dark semantic tokens (`--background`, `--foreground`, `--surface`, `--overlay`, `--accent`, `--muted`, `--border`) without adding custom brand axes or per-page color overrides.
  - Keep standard control appearance in `kulo-controls.css` (`.kulo-ui`), field layouts in `kulo-forms.css` (`SettingsList`, `kulo-settings-row`, `kulo-form-field`), and the 4-tier typography scale in `kulo-typography.css` (`text-xs` 12/18, `text-sm` 14/20, `text-lg` 18/26, `text-2xl` 24/32—never literal font sizes or `text-base`/`text-xl`).
  - Specify explicit `variant` (`secondary` on `surface`/`overlay`, `primary` on contrasting secondary cards) on every visible input, apply HeroUI's `scrollbar` utility on custom overflow containers, keep tab bars content-sized (`w-fit max-w-full min-w-0 shrink-0` on `Tabs.ListContainer`, `w-max` on `Tabs.List`, `w-auto shrink-0 whitespace-nowrap` on `Tabs.Tab`), and use `AlertDialog` for destructive confirmations.
- **Product Restraint**: Keep interfaces uncluttered—avoid explanatory subtitles or helper paragraphs; rely on concise labels, clear states, accessible names, and IME-safe Enter handlers.
