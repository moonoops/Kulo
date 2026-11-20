# Windows Desktop (`win32`)

Applies only when `kulo_desktop` reports `platform: "win32"` on the target execution device.

- **Interactive Session & UI Automation**: Desktop control requires an active, unlocked interactive user session with exposed Windows UI Automation (UIA) trees. Service accounts, locked/disconnected sessions, or UAC/higher-integrity (Administrator) windows cannot be inspected or controlled—never attempt privilege escalation, UAC bypass, user switching, or physical input simulation.
- **Exact Refs**: Always target exact full refs (`@s...:e...`) from the latest `snapshot` rather than ambiguous control labels, and re-snapshot after dialogs, tab switches, or window updates before assuming input took effect.
- **Strict Boundaries**: Execute strictly via `kulo_desktop` (`status` / `snapshot` / `click` / `type` / `set-value` / `scroll` / `wait` / `close`). Never fall back to PowerShell UI automation, raw CLI commands, or synthetic keystrokes; hand elevated or inaccessible steps back to the user.
