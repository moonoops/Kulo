# Antigravity Local Integration

Verified: 2026-11-21. Requires the Antigravity CLI `agy` (on macOS, Kulo auto-discovers `agy` on `PATH` as well as `/Applications/Gemini.app/Contents/Helpers/agy`, `/Applications/Antigravity.app/Contents/Resources/app/bin/agy`, and `~/.gemini/antigravity/bin/agy`).

- Native protocol entrypoint: `agy acp --process-per-session` over JSON-RPC stdio—do not guess deprecated experimental flags or inject Kulo-specific sandboxes.
- Reuses the client's existing account, native auth (`agy acp --login`), `HOME`, tools, MCP, plugins, network, permissions, and internal subagents on the bound device—never request credentials in chat or force a Gemini API key.
- After standard ACP `initialize`, Kulo creates/resumes its own delegated sessions and passes optional public `configOptions` model/thinking overrides (omitted values use native defaults). `allow_subagents` governs Hub collaboration only; `authenticated: null` means unknown, and live `verify` requires explicit user consent.

Docs: https://antigravity.google/docs
T3 reference: https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-antigravity.md
