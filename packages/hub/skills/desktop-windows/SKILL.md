---
name: desktop-windows
description: Windows UI Automation, interactive desktop session, and integrity-level constraints for moco_desktop when target device platform is win32.
metadata:
  moco-audiences: chat, worker
---

# Windows Desktop

Read `desktop-automation` first. Applies only when `moco_desktop` reports `platform: "win32"` on the target execution device.

- Desktop access requires an interactive user session and exposed UI Automation tree; service accounts, locked/disconnected sessions, or higher-integrity (UAC/elevated) windows cannot be inspected or controlled—never attempt privilege escalation, UAC bypass, user switching, or physical input simulation.
- Always target exact full refs from the latest `snapshot` rather than duplicate control labels, and re-observe after dialogs, window changes, or updates before assuming input took effect.
- Consult `upstream/SKILL.md` and `upstream/references/{permissions-and-elevation,troubleshooting}.md` via `moco_skill_read` as needed; execute strictly via `moco_desktop` rather than PowerShell/CLI snippets.
