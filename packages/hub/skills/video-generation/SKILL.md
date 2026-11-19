---
name: video-generation
description: Plan prompts/storyboards, reference assets, Flow membership generation, long-running job tracking, and delivery with Moco's configured video capabilities.
metadata:
  moco-audiences: chat,worker
---

# Video Generation

Call `moco_media_capabilities` first to inspect enabled video capabilities and connection sources. When the user specifies Flow membership credits, use the matching `flow-browser` capability—never silently switch to a paid API, purchase credits, or change billing sources.

- **Prompting & References**: Keep simple video prompts concise; organize script, shot sequence, duration, aspect ratio, character consistency, and style only for narrative requests, asking solely when a missing detail would materially alter the output. Pass managed `assetId` references within catalog limits (current Flow automation supports text-to-video; hand reference-upload flows back to the user in browser rather than dropping their reference requirement).
- **Execution, Human Handoff & Delivery**: Submit once via `moco_generate_video` and track/resume via `moco_media_job`—never double-submit when Flow state is uncertain or keep automating a browser tab during user sign-in/credit handoff. Top-level Workers park long jobs via `moco_wait` instead of polling in model turns (subagents return long waits to their parent Worker). Claim completion only after the resulting video is downloaded into managed assets, and use `moco_media_export` when saving into an authorized writable project workspace.
