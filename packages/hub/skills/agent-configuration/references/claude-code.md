# Claude Code Local Integration

Verified: 2026-11-17. Connects via the official Claude Agent SDK (`0.3.326`) and compatible native CLI.

- Uses the SDK-compatible CLI on the bound device; native sign-in is completed by the user (`claude auth login`; `claude auth status --json` checks public status without reading or copying credential files).
- Preserves native accounts, settings, file/Bash tools, MCP, plugins, hooks, network, permissions, and internal Agent/Task subagents—Moco manages explicit `cwd`, task brief, and owned native session IDs (`resume`) without hijacking unrelated recent sessions.
- Empty/`auto` model and `thinking_level` use native defaults (never Moco's Pi catalog). `allow_subagents` governs Hub collaboration only; `probe` sends no generation prompt, and `verify` requires explicit user consent.

Official SDK: https://code.claude.com/docs/en/agent-sdk/overview
Permissions: https://code.claude.com/docs/en/agent-sdk/permissions
