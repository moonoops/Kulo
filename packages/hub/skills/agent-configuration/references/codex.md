# Codex Local Integration

Verified: 2026-11-17. Connects to OpenAI Codex CLI / App Server (`codex app-server`), distinct from GPT API or ChatGPT Dots.

- Native entrypoint: `codex app-server` over JSON-RPC stdio (`initialize` / `initialized`, then owned `thread` + `turn` IDs without hijacking unrelated threads or injecting Moco permission profiles).
- Preserves native sign-in (`auth.json` is never read or copied), tools, MCP, plugins, hooks, network, approvals, and internal subagents; models come from native `model/list` (empty/`auto` uses client defaults).
- Native approval prompts are relayed verbatim without auto-approving. `probe` sends no prompt; `verify` requires explicit user consent, and `interrupt` completion is tracked separately from turn finality.

Docs: https://learn.chatgpt.com/docs/app-server
T3 reference: https://github.com/pingdotgg/t3code/tree/main/apps/server/src/orchestration-v2/Adapters
