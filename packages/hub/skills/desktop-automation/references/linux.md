# Linux Desktop (`linux`)

Applies only when `kulo_desktop` reports `platform: "linux"` on the target execution device.

- **Graphical Session & AT-SPI**: Desktop inspection requires an active user graphical session (`DISPLAY` or `WAYLAND_DISPLAY`), session D-Bus (`DBUS_SESSION_BUS_ADDRESS`), and AT-SPI accessibility bus. SSH or container connectivity alone does not guarantee desktop access—check `status` first and ask the user to prepare the graphical session if unavailable.
- **Exposed Accessibility Tree Only**: Only widgets exposed over AT-SPI can be inspected or controlled. Custom-drawn canvases or toolkits without accessibility enabled may return sparse or empty trees.
- **Observe-Verify Discipline**: Re-run `snapshot` after each action to confirm actual UI state changes, and refresh refs after dialog transitions, window changes, or list updates.
- **Strict Boundaries**: Use `kulo_desktop` semantic actions exclusively (`status` / `snapshot` / `click` / `type` / `set-value` / `scroll` / `wait` / `close`). Never fall back to coordinate clicks, `xdotool`/`ydotool`, clipboard injection, shell scripts, or elevated permissions.
