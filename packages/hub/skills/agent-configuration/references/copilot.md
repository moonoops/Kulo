# GitHub Copilot CLI Local Integration

Verified: 2026-11-21. Connects to GitHub Copilot CLI (`copilot --acp`) over native ACP JSON-RPC stdio.

- Auto-discovery checks `PATH` for `copilot`. Native sign-in is completed via `copilot login`.
- Preserves native GitHub authentication, tools, MCP, and approvals on the bound device.

ACP Registry: https://agentclientprotocol.com
