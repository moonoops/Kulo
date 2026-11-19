---
name: agent-configuration
description: Connect local external Agent clients on the Agents Settings page through guided multi-turn setup and save outsourced dispatch and session configuration.
metadata:
  moco-audiences: settings
---

# External Agent Configuration

Only for the active Settings -> Agents assistant (not exposed to main chat or Workers). Setup tools manage public connection and dispatch metadata only—they grant no arbitrary shell, installation, debug-port, or credential-reading access.

## Delegation Boundary

- Moco delegates tasks to complete native clients: Moco manages default dispatch scopes, `whenToUse`, task instructions, workspace/resource handoff, session tracking, optional model/thinking overrides, and result review, while the external client retains its own native tools, MCP servers, plugins, hooks, network, permissions, accounts, and internal subagents.
- `allow_subagents` (default `false`) controls only whether the external Agent may request cross-Agent collaboration via the Moco Hub—never its internal subagents. Legacy `readOnly` is an instruction-level request ("do not modify files"), not a host-enforced native sandbox. Native sign-in happens on the target device inside the client itself—never collect credentials in chat or replace native accounts with Moco API keys.

## Conversation & Default Dispatch Scope

- Confirm client kind, target computer (auto-select if only one computer is connected), intended responsibilities, and specific Bot when applicable. Leave `model_id` empty and `thinking_level` empty/`auto` to use the client's native defaults (never Moco's Pi catalog) unless the user requests a supported public override.
- Confirm whether the Agent runs **on explicit naming only** (`default_for: []`, default) or serves as the default handler for specific task kinds (`coding`, `debugging`, `review`, `architecture`, `design`, `research`, `writing`), optionally scoped to specific projects on the bound device (`project_ids: []` covers all projects and ungrouped tasks on that device). Project-scoped defaults override device-wide defaults; resolve any duplicate scope conflict explicitly with the user rather than silently overwriting an existing default.
- Explicit user naming always overrides default policies; if a named or matched default Agent is disabled, unverified, offline, or unavailable, state the exact reason and wait—never silently substitute another Agent or built-in Worker.

## Ordered Setup Workflow

1. `moco_agent_configuration_read`: load current draft, devices, projects, and saved external Agents (pass `client_kind` to also read the bundled local guide and distinguish Grok Bot vs. Grok Build or personal Muse vs. Muse Code).
2. `prepare`: create or resume a draft with `client_kind`, `env_id`, and optional `agent_id`.
3. `update`: set `label`, `when_to_use`, `prompt`, `default_for`, `project_ids`, and optional `model_id` / `thinking_level` / `executable` (public fields and absolute executable path only).
4. `detect`: check installation, version, and observable auth status (`authenticated: null` means unknown).
5. `authenticate`: return device-side native sign-in guidance for the user to complete on the target machine, then re-check.
6. `probe`: initialize the protocol and read declared capabilities without sending a generation prompt (protocol readiness does not prove roundtrip generation works).
7. `verify(run_test: true)`: **only with explicit user consent** on supported drivers, run one minimal nonce roundtrip check (may consume client quota; proves message I/O only, not individual native tools; unsupported on experimental Grok Bot).
8. `save`: report left-hand list updates only after `save` succeeds. Supported drivers enable auto-dispatch after `roundtrip` verification; protocol-only or experimental Grok Bot configs save disabled, and Dots/Muse remain reserved guides.

Always pass the latest `expected_revision`. Changing client, device, executable, model, or thinking invalidates prior verification evidence, whereas editing labels, prompts, dispatch scopes, or `allow_subagents` preserves it. Distinguish installation, protocol handshake, single roundtrip check, and saved state—never replay uncertain verification runs with a new request ID before checking the existing run.
