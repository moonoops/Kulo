# ChatGPT Dots (Reserved Guide)

Verified: 2026-11-17. Kulo does not yet ship a verified local Dots control driver—never treat Codex App Server as a Dots controller.

- Dots being able to call local tools does not expose a public local API for Kulo to create, drive, or cancel Dots sessions; official MCP Events are outbound subscriptions, and community cloud bridges (`chatgpt-dots`) rely on private cloud protocols rather than local desktop control.
- Keep as guidance/draft only: never request ChatGPT cookies, install unverified bridges, switch to cloud APIs silently, or save as an active Agent.

Docs: https://learn.chatgpt.com/docs/dots/computers-and-apps
MCP Events: https://developers.openai.com/plugins/build/mcp-events
Community bridge: https://github.com/beeper/chatgpt-dots
