# Gemini CLI Local Integration

Verified: 2026-11-21. Connects to Google Gemini CLI (`gemini --acp`) over native ACP JSON-RPC stdio (distinct from Antigravity `agy`).

- Auto-discovery checks `PATH` for `gemini`. Complete native sign-in directly inside `gemini`.
- Preserves native accounts, tools, skills, MCP, and approvals on the bound device.

ACP Registry: https://agentclientprotocol.com
