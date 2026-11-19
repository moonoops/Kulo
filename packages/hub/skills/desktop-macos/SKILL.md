---
name: desktop-macos
description: macOS AX accessibility permissions, native app refs, and semantic action constraints for kulo_desktop when target device platform is darwin.
metadata:
  kulo-audiences: chat, worker
---

# macOS Desktop

Read `desktop-automation` first. Applies only when `kulo_desktop` reports `platform: "darwin"` on the target execution device.

- macOS Accessibility (AX) permission belongs to the specific app/process launching `agent-desktop`—report any missing permission from `status` so the user can grant it on the target Mac (never open OS permission prompts automatically, and never request Screen Recording for semantic AX operations).
- An AX action return does not guarantee UI state changed; re-snapshot the same `app` after each action and refresh refs after app restarts, list reorders, or dialogs—never fall back to physical input or AppleScript when semantic actions are unavailable.
- Consult `upstream/SKILL.md` and `upstream/references/troubleshooting.md` via `kulo_skill_read` as needed while staying within `kulo_desktop` actions.
