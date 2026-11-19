---
name: image-generation
description: Generate or edit images, project assets, and supported GIFs with Kulo's configured image capabilities, handling reference images, iterative edits, and workspace export.
metadata:
  kulo-audiences: chat,worker
---

# Image Generation

Call `kulo_media_capabilities` first to check enabled capabilities and supported parameters/formats. Honor explicit user model selections; otherwise filter by required operation (generation, reference-guided edit, or supported GIF) and apply saved routing preferences. Never invent model capabilities or present static images as animated GIFs.

- **Prompting & Edits**: Distinguish fresh generation, reference-guided generation, and targeted editing before calling `kulo_generate_image`. State subject, purpose, composition, style, and constraints clearly while preserving detailed user prompts verbatim. For edits, specify both what changes and what stays unchanged, focusing each iteration on one clear adjustment.
- **Reference Assets**: Pass managed `assetId` values accessible to the current conversation or ticket—never treat a filename as having inspected the image, and never pass raw paths from another device. Default to static images unless animated GIF is requested and supported; use video capabilities for audio or narrative motion.
- **Job Idempotency & Delivery**: Generate only within explicit user requests or authorized `allowTaskGeneration` task scope, using one distinct intent per asset. After resume or reconnect, check existing jobs via `kulo_media_job` instead of resubmitting or switching billing sources. Report queued/running status accurately and claim completion only after managed assets are saved; Workers with write access export project assets via `kulo_media_export` (overwriting existing files only when explicitly authorized).
