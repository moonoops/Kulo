---
name: vercel-react-best-practices
description: React performance and data-fetching review rules covering concurrency, bundle size, rendering, and state management tailored to the project stack.
metadata:
  kulo-audiences: worker
---

# React Performance Best Practices

Use on demand in React projects: read `upstream/SKILL.md` and relevant `upstream/rules/` files via `kulo_skill_read` (consolidated reference in `upstream/AGENTS.md`) rather than preloading every rule.

- Apply only rules matching the repository's actual stack and installed versions: React + Vite projects use general React, browser, and bundle rules, while Next.js RSC/router/cache or Vercel deployment rules apply only when those frameworks are actually used. In Kulo's frontend, preserve HeroUI v3 standard controls and React Aria interactions without introducing competing UI libraries or frameworks.
- Focus on observable bottlenecks and keep audit tasks strictly read-only. Pinned upstream content and hashes are recorded in `PROVENANCE.json` and `LICENSE`.
