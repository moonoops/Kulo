---
name: agent-configuration
description: Connect local external Agent clients on the Agents Settings page through guided multi-turn setup and save outsourced dispatch and session configuration.
metadata:
  kulo-audiences: settings
---

# External Agent Configuration

Only for the active Settings -> Agents assistant (not exposed to main chat or Workers). Setup tools manage public connection and dispatch metadata only—they grant no arbitrary shell, installation, debug-port, or credential-reading access.

## Delegation Boundary

- Kulo delegates tasks to complete native clients: Kulo manages default dispatch scopes, `whenToUse`, task instructions, workspace/resource handoff, session tracking, optional model/thinking overrides, and result review, while the external client retains its own native tools, MCP servers, plugins, hooks, network, permissions, accounts, and internal subagents.
- `allow_subagents` (default `false`) controls only whether the external Agent may request cross-Agent collaboration via the Kulo Hub—never its internal subagents. Legacy `readOnly` is an instruction-level request ("do not modify files"), not a host-enforced native sandbox. Native sign-in happens on the target device inside the client itself—never collect credentials in chat or replace native accounts with Kulo API keys.

## Fast Path: Scan First, Confirm Once, Connect Directly

1. **Always scan before asking**: Call `kulo_agent_configuration_scan` FIRST to detect which supported local CLI clients (`codex`, `claude-code`, `antigravity`, `dsh`) are actually installed across online computers and which are already connected. Never throw a multi-field `kulo_ui_show` form card asking the user to pick a client, pick a device, write responsibilities, or pick default dispatch scopes before scanning.
2. **Present a concise list & single confirmation**: Report the detected connectable clients concisely (client name, version, and device name when multiple devices are online; note already-connected ones briefly). Ask one direct yes/no question: whether to connect them now with client-native defaults (default model/effort, explicit-naming-only dispatch, editable anytime on the left) and run the minimal roundtrip verification check (which may consume minimal client quota).
3. **One-step connect**: As soon as the user says yes (or confirms specific clients), call `kulo_agent_configuration_connect(client_kind, env_id, run_test: true)` directly for each confirmed client—no need to ask for responsibilities or step through `prepare`/`update`/`detect`/`probe`/`verify`/`save`. If the user wants protocol-only without a live test, pass `run_test: false` (saves disabled). If authentication is missing, call `authenticate` or give the native client sign-in instruction and retry once signed in.
4. **Only ask optional extras when requested**: Leave `model_id` empty, `thinking_level` empty/`auto`, and `default_for: []` (explicit naming only) unless the user specifically asks for overrides or default task-kind/project routing (`coding`, `debugging`, `review`, `architecture`, `design`, `research`, `writing`). Project-scoped defaults override device-wide defaults; resolve any duplicate scope conflict explicitly rather than silently overwriting.
5. **Explicit naming invariant**: Explicit user naming always overrides default policies; if a named or matched default Agent is disabled, unverified, offline, or unavailable, state the exact reason and wait—never silently substitute another Agent or built-in Worker.

## Detailed Step-by-Step Tools (Editing, Troubleshooting, or Experimental Clients)

Use the granular draft tools when editing an existing external Agent, reading a client-specific guide (`kulo_agent_configuration_read(client_kind=...)`, e.g. to distinguish Grok Bot vs. Grok Build or personal Muse vs. Muse Code), or troubleshooting step-by-step:

1. `kulo_agent_configuration_read`: load current draft, devices, projects, saved external Agents, and optional bundled local guide.
2. `prepare` -> `update` -> `detect` -> `authenticate` -> `probe` -> `verify(run_test: true)` (only with explicit user consent; unsupported on experimental Grok Bot) -> `save`.
3. `remove` / `cancel`: remove a saved external Agent or discard an active draft.

Always pass the latest `expected_revision` on draft tools. Changing client, device, executable, model, or thinking invalidates prior verification evidence, whereas editing labels, prompts, dispatch scopes, or `allow_subagents` preserves it. Supported drivers enable auto-dispatch only after `roundtrip` verification; protocol-only or experimental Grok Bot configs save disabled, and Dots/Muse remain reserved guides. Distinguish installation, protocol handshake, single roundtrip check, and saved state—never replay uncertain verification runs with a new request ID before checking the existing run.
