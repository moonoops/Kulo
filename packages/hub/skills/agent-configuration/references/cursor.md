# Cursor Agent Local Integration

Verified: 2026-11-21. Connects to Cursor Agent CLI (`cursor-agent acp`) over native ACP JSON-RPC stdio.

- Auto-discovery checks `PATH` and `~/.cursor/bin/cursor-agent`. Native sign-in is completed via `cursor-agent login`.
- Preserves native tools, rules, skills, MCP, and permissions on the bound device.

ACP Registry: https://agentclientprotocol.com
