# OpenCode Local Integration

Verified: 2026-11-21. Connects to OpenCode CLI (`opencode acp`) over native ACP JSON-RPC stdio.

- Auto-discovery checks `PATH` and `~/.opencode/bin/opencode`. Native sign-in is completed via `opencode auth login`.
- Waits briefly after `session/new` for asynchronous `config_option_update` model advertisements when needed.

Docs: https://opencode.ai/docs
