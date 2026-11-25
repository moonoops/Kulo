/**
 * Shared model-facing tool descriptions for Kulo Orchestrator, Content, and Worker tools.
 * Following the tool-local rule placement pattern, parameter- and tool-specific constraints live
 * directly alongside the tool declarations so the model sees them at call time.
 */

export const KULO_DISPATCH_DESCRIPTION =
  "Run work as a durable background Worker ticket that reports back when it settles. Use it for multi-step coding, long builds/tests, browser/desktop/Android workflows, external Agents, or standalone .html reports (load interactive-html + diagram-design); do quick reads and small edits yourself. Routing: project_id already pins device and directory—don't also pass env_id/workspace_dir. For ungrouped work set target_scope ('hub_local' for research/attachments, 'sender_device' for the sender's files/ports/GUI); phone work uses execution_domain='android'. Pass attachment_ids, board_id, or review_ticket_id instead of copying prose; reuse command_id on retry.";

export const KULO_DISPATCH_GOAL_DESCRIPTION =
  "The complete, self-contained task for the Worker. It does not see this chat, Identity files, or private memory, so include every fact it needs—and no secrets.";

export const KULO_DISPATCH_EXECUTE_AT_DESCRIPTION =
  "ISO 8601 timestamp with timezone for scheduled execution; call kulo_status first to verify current time and timezone.";

export const KULO_DISPATCH_REPEAT_EVERY_DESCRIPTION =
  "Positive integer interval in seconds (requires execute_at). To watch incoming messages or notifications, use kulo_assistant_watch via tool_search instead of a polling schedule.";

export const KULO_STOP_DESCRIPTION =
  "Immediately stop a Ticket when the user cancels, declines required permissions, or asks to end it. Never auto-resumes. On a card action already carrying systemEffect: ticket_stopped, summarize the stop briefly without calling kulo_stop or kulo_steer again.";

export const KULO_REPORT_DESCRIPTION =
  'Report progress, a blocker, completion, or failure to the main Agent. Files are privately staged for the main Agent to inspect; only the main Agent may approve and publish them to the user. A ready report never means approved or sent. The main Agent does not receive your transcript, tool output, or reasoning, so a closing remark like "done" gives it nothing to use: include the result and the evidence. Report earlier when a partial finding changes what it should do next.';

export const KULO_UI_SHOW_DESCRIPTION =
  'Publish an interactive HeroUI v3 card (choices, forms, selectable tables; read `genui-cards` for multi-element/tabbed/chart cards). Example: `{"root":"main","elements":{"main":{"type":"Stack","props":{"gap":"md"},"children":["q","go"]},"q":{"type":"Choice","props":{"field":"choice","options":[{"value":"a","label":"Option A"}],"required":true}},"go":{"type":"Button","props":{"actionId":"ok","label":"Confirm","variant":"primary"}}},"state":{"values":{}}}` + `actions:[{"id":"ok","label":"Confirm","kind":"submit"}]` (<=80 elements, depth 8; no JS/style/class/URLs).';

export const KULO_UI_DIAGRAM_DESCRIPTION =
  "Proactively embed an inline SVG chart or diagram in Main Chat when a visual beats prose for trends, comparisons, timelines, flows, or architectures (takeaway first; `--d-*` tokens; load `diagram-design`; label phase schematics; never invent points).";
