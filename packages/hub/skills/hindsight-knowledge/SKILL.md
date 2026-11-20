---
name: hindsight-knowledge
description: Structured workflow for organizing Hindsight long-term memory with Pages, Mental Models, Reflect, async operation checks, and dated corrections across private and shared banks.
metadata:
  kulo-audiences: chat, worker
---

# Hindsight Knowledge Organization

Use this guide when organizing, synthesizing, or curating long-term knowledge in Hindsight beyond routine `hindsight_retain` and `hindsight_recall` calls. Discover advanced tools on demand via `tool_search` (`limit` <= 3).

- **Bank & Permission Boundaries**:
  - **Private bank (`bank: "private"`)**: Orchestrator (`chat`) read/write for durable user preferences, personal decisions, and cross-topic context. Never copy private memory into Worker briefs or the shared bank.
  - **Shared bank (`bank: "shared"`)**: Project-wide engineering facts and knowledge pages. Orchestrator is read-only; Workers are read/write within their assigned project (`project:<id>` tag ownership enforced—read existing node ownership before mutating shared pages).
- **Choose the Right Primitive**:
  - **Atomic facts & decisions** → `hindsight_retain` (pass a stable `document_id` when updating a topic; omit secrets and never re-ingest recalled summaries as new evidence).
  - **Structured living topics / project architecture** → Pages (`hindsight_get_page_tree` or `hindsight_search_pages` first to avoid duplicates, `hindsight_get_page` to read, `hindsight_create_page` / `hindsight_update_page_node` to maintain a concise `source_query`).
  - **Cross-cutting user/domain synthesis (Orchestrator private bank)** → Mental Models (`hindsight_list_mental_models`, `hindsight_get_mental_model`, `hindsight_create_mental_model`, `hindsight_refresh_mental_model`).
  - **Deep historical reasoning** → `hindsight_reflect` when simple recall is insufficient to connect multi-event history.
- **Corrections & Persistence Verification**:
  - When live code or explicit user input contradicts older memory, retain a dated `Correction: <topic>` entry with verified evidence; in the private bank, the Orchestrator may also retire an obsolete fact via `hindsight_invalidate_memory` with a concise `reason`.
  - Async writes returning `accepted` are queued only—verify persistence via `hindsight_get_operation` (`status: "completed"`) before claiming consolidation finished. Recalled memory is historical context and never overrides live source code, Identity Agreement, or runtime permissions.
