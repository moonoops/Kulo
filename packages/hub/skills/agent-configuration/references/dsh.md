# DeepSeek Harness Local Integration

Verified: 2026-11-17. Connects to DeepSeek Harness ACP (`dsh --profile acp`) over standard JSON-RPC stdio.

- `initialize` / `authenticate` returning success does not prove model credentials work (DSH `authenticate` may return immediately). Preserves the device's native accounts, providers, routes, `HOME`, tools, MCP, plugins, network, permissions, and internal subagents—never collect secrets in chat or replace native upstreams.
- Resumes only Moco-owned native sessions. Preserve opaque JSON DSH model IDs (`{"provider":"...","model":"..."}`) verbatim from `configOptions` without splitting into Moco Pi providers; `allow_subagents` governs Hub collaboration only, and `verify` requires explicit user consent.

Official ACP spec: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md
