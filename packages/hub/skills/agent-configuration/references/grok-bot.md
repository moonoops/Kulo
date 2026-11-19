# Grok Bot Experimental Integration

Verified: 2026-11-17. Personal Grok Bot desktop app (distinct from the `grok` Grok Build coding CLI).

- Uses an experimental local Electron CDP bridge relying on private client internals that may break across app updates; confirm running client, version, and dedicated Bot first without auto-restarting the app or opening debug ports without explicit user consent.
- Accepts only an explicit user-provided HTTP loopback debug root (`http://127.0.0.1:9333/` or `http://[::1]:9333/`, no `localhost`, WebSocket URLs, paths, credentials, or query strings) and correlates turns via client nonces (`sendJournal.sendPrompt`).
- Supports experimental `detect` / `probe` only (`verify(run_test: true)` is unsupported and returns an error; official deep links only prefill up to 1,000 chars without sending). Experimental configs always save disabled and cannot auto-dispatch.

Deep links: https://docs.x.ai/grok-bot/deep-links
Reference bridge: https://github.com/TheSethRose/grokbot-bridge/tree/b905584ee625d46581cd501845ce2c5dd9ee40b3
