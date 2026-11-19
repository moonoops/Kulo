---
name: desktop-linux
description: Linux AT-SPI, graphical session bus, and X11/Wayland semantic action constraints for moco_desktop when target device platform is linux.
metadata:
  moco-audiences: chat, worker
---

# Linux Desktop

Read `desktop-automation` first. Applies only when `moco_desktop` reports `platform: "linux"` on the target execution device.

- Desktop inspection requires an active user graphical session, session D-Bus, and AT-SPI (SSH/Env connectivity or containers do not guarantee desktop access). Check `status` first and ask the user to prepare the session if unavailable.
- Only exposed accessibility elements can be inspected or acted upon. Moco uses background semantic actions exclusively—never fall back to coordinate clicks, clipboard injection, external scripts, or elevated device permissions; re-snapshot after every step to verify.
- Consult `upstream/SKILL.md` and `upstream/references/` via `moco_skill_read` as needed while staying within `moco_desktop` actions.
