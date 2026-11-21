# Kiro CLI Local Integration

Verified: 2026-11-21. Connects to Kiro CLI V3 engine (`kiro-cli acp --agent-engine=v3 --auth-method=cli`) over native ACP JSON-RPC stdio.

- Auto-discovery checks `PATH` and `~/.kiro/bin/kiro-cli`. Native sign-in is completed via `kiro-cli login`.
- Keeps access tokens inside Kiro (`--auth-method=cli`) and relays native approvals verbatim without persisting global grants.

T3 reference: https://github.com/pingdotgg/t3code/tree/main/packages/provider-kiro
