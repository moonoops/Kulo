# Grok Build Local Integration

Verified: 2026-11-21. Connects to xAI Grok Build CLI (`grok agent stdio`) over native ACP JSON-RPC stdio (distinct from the personal `Grok Bot` desktop app).

- Auto-discovery checks `PATH` and `~/.grok/bin/grok`. Sign-in stays native (`grok login` or ambient `XAI_API_KEY`); Kulo checks `grok models` without launching a browser or workspace MCP servers.
- Uses `initialize._meta.clientType = "extension"`, reads model catalogs and per-model `reasoningEfforts` from `initialize._meta.modelState`, selects model/effort via `session/set_model`, and passes `--permission-mode default` on read-only tasks.
- Preserves native tools, MCP, plugins, hooks, network, approvals, and internal subagents. Never collect credentials in chat.

T3 reference: https://github.com/pingdotgg/t3code/tree/main/packages/provider-grok
