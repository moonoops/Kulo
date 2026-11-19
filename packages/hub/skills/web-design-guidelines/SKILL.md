---
name: web-design-guidelines
description: Audit React web UI accessibility, keyboard focus, forms, motion, typography, and interactive states against interface guidelines and project rules.
metadata:
  kulo-audiences: worker
---

# Web Interface Guidelines

Read `upstream/SKILL.md` and bundled `references/web-interface-guidelines.md` via `kulo_skill_read` on demand (use the pinned local copy by default without fetching external rules unless explicitly asked to check upstream updates).

- Ground findings in exact source files and observable UI behavior while honoring project constraints over generic advice (Kulo uses React + Vite + HeroUI v3 standard controls, themes, and React Aria interactions—never introduce Next.js/Vercel or competing UI kits).
- Keep audit tasks read-only and modify code only when requested. Pinned upstream content and hashes are recorded in `PROVENANCE.json` and `LICENSE`.
