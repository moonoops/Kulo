# Custom ACP Client Integration

Verified: 2026-11-21. Connects to any user-installed local Agent Client Protocol (ACP) executable over JSON-RPC stdio.

- Custom ACP clients are configured exclusively in the Agents Settings UI (never via assistant chat tools) with an explicit absolute executable path, unique `agentRef`, and optional argument list (`acpArgs`).
- Generic shells, script interpreters, and package runners (`sh`, `bash`, `node`, `python`, `npx`, `uvx`, etc.) are blocked; Kulo never downloads remote archives or runs remote packages automatically.
- Requires both a live ACP handshake (`initialize` + `session/new`) and roundtrip verification before auto-dispatch can be enabled.

Spec: https://agentclientprotocol.com
