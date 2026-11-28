/**
 * Pure leaf classifier & redacted summary projector for chat tool execution steps.
 * Classifies actions strictly by (tool name + actual sub-action parameters) and never
 * folds mutating, shell, host-action, confirmation, or unknown operations as read-only.
 */
import {
  redactSensitiveText,
  type ToolActionCategory,
  type ToolActionMeta,
  type ToolActionStatus,
} from "@kulo/protocol";

const MAX_TARGET_LABEL_CHARS = 60;
const MAX_ERROR_BRIEF_CHARS = 96;

const LARK_READ_ACTIONS = new Set(["list_chats", "read_chat", "search_messages"]);
const BROWSER_READ_ACTIONS = new Set([
  "snapshot",
  "screenshot",
  "get-url",
  "get_url",
  "get-text",
  "get_text",
  "read",
  "status",
]);
const BROWSER_BATCH_READ_ACTIONS = new Set([
  "snapshot",
  "screenshot",
  "get-url",
  "get_url",
  "get-text",
  "get_text",
  "read",
]);
const BROWSER_WRITE_ACTIONS = new Set([
  "click",
  "fill",
  "type",
  "press",
  "navigate",
  "open",
  "scroll",
  "back",
  "forward",
  "close",
]);

const SPARK_MAIL_READ_ACTIONS = new Set(["status", "emails", "search", "thread", "events"]);
const HOME_ASSISTANT_READ_ACTIONS = new Set([
  "status",
  "entities",
  "migration_guide",
  "list_automations",
  "get_automation",
  "get_traces",
  "get_history",
]);
const HOME_ASSISTANT_CONFIRM_ACTIONS = new Set([
  "propose_action",
  "propose_automation",
  "propose_delete_automation",
]);

const MEMORY_REDACTED_TOOLS = new Set([
  "kulo_memory_recall",
  "kulo_memory_retain",
  "hindsight_recall",
  "hindsight_retain",
]);

const MEMORY_READ_TOOLS = new Set([
  "kulo_memory_recall",
  "hindsight_recall",
  "hindsight_reflect",
  "hindsight_search_pages",
  "hindsight_get_page_tree",
  "hindsight_get_page",
  "hindsight_list_mental_models",
  "hindsight_get_mental_model",
  "hindsight_search_knowledge_pages",
  "hindsight_list_knowledge_pages",
  "hindsight_read_knowledge_page",
  "hindsight_get_operation",
]);

const MEMORY_WRITE_TOOLS = new Set([
  "kulo_memory_retain",
  "hindsight_retain",
  "hindsight_create_page",
  "hindsight_update_page_node",
  "hindsight_ingest_document",
  "hindsight_capture_initiative",
  "hindsight_create_mental_model",
  "hindsight_refresh_mental_model",
]);

const MEMORY_FORGET_TOOLS = new Set(["kulo_memory_forget", "hindsight_invalidate_memory"]);

const SETTINGS_READ_TOOLS = new Set([
  "kulo_settings_read",
  "kulo_capabilities_read",
  "kulo_media_capabilities",
  "kulo_memory_service_read",
  "kulo_model_metadata_lookup",
  "kulo_model_configuration_read",
  "kulo_agent_configuration_read",
]);

const SETTINGS_WRITE_TOOLS = new Set([
  "kulo_settings_update",
  "kulo_settings_appearance",
  "kulo_local_model_register",
  "kulo_capability_configure",
  "kulo_capability_manage",
  "kulo_skill_manage",
  "kulo_extension_manage",
  "kulo_model_configuration_update",
  "kulo_agent_configuration_save",
  "kulo_agent_configuration_remove",
]);

const PROJECT_READ_TOOLS = new Set([
  "kulo_projects",
  "kulo_project_conversations",
  "kulo_project_history",
]);

const PROJECT_WRITE_TOOLS = new Set([
  "kulo_project_create",
  "kulo_project_update",
  "kulo_project_delete",
  "kulo_project_restore",
  "kulo_conversation_rename",
  "kulo_conversation_move",
  "kulo_conversation_restore",
]);

const AWAITING_CONFIRM_STATUSES = new Set([
  "awaiting_user_confirmation",
  "awaiting_orchestrator_decision",
  "awaiting_user_handoff",
  "awaiting_confirm",
  "pending_confirmation",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function redactAndTruncate(
  raw: string | undefined,
  redactText: (text: string) => string,
  maxChars: number,
): string | undefined {
  if (!raw) return undefined;
  // Redact before truncation so cutting across a secret value can never leak a prefix.
  const redacted = redactSensitiveText(redactText(raw));
  const singleLine = redacted.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function extractSafeHostname(
  rawUrl: unknown,
  redactText: (text: string) => string = redactSensitiveText,
): string | undefined {
  const value = asNonEmptyString(rawUrl);
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const host = parsed.hostname.trim().toLowerCase();
    if (!host) return undefined;
    return redactAndTruncate(host, redactText, MAX_TARGET_LABEL_CHARS);
  } catch {
    return undefined;
  }
}

function extractSafeBasename(
  rawPath: unknown,
  redactText: (text: string) => string,
): string | undefined {
  const value = asNonEmptyString(rawPath);
  if (!value) return undefined;
  const redacted = redactSensitiveText(redactText(value));
  const segments = redacted.split(/[\\/]/).filter(Boolean);
  const tail = segments.at(-1) ?? redacted;
  return redactAndTruncate(tail, redactText, MAX_TARGET_LABEL_CHARS);
}

function isReadOnlyBrowserBatch(steps: unknown): boolean {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps.every(
    (step) =>
      isRecord(step) &&
      typeof step.action === "string" &&
      BROWSER_BATCH_READ_ACTIONS.has(step.action),
  );
}

export interface ClassifyToolActionInput {
  name: string;
  args?: Record<string, unknown>;
  status?: ToolActionStatus;
  redactText?: (text: string) => string;
  resolveConnectionLabel?: (connectionId: string) => string | undefined;
}

interface ClassificationCore {
  category: ToolActionCategory;
  labelKey: string;
  targetLabel?: string;
}

function classifyCore(
  name: string,
  args: Record<string, unknown> | undefined,
  redactText: (text: string) => string,
  resolveConnectionLabel?: (connectionId: string) => string | undefined,
): ClassificationCore {
  const safeTarget = (value: unknown) => redactAndTruncate(asNonEmptyString(value), redactText, MAX_TARGET_LABEL_CHARS);
  const hasArgs = Boolean(args);
  const action = hasArgs ? asNonEmptyString(args?.action) : undefined;

  // 1. Ironclad non-read-only execution & file-mutation tools.
  if (name === "bash") return { category: "write", labelKey: "bash" };
  if (name === "write") {
    return {
      category: "write",
      labelKey: "write",
      targetLabel: hasArgs ? extractSafeBasename(args?.path ?? args?.file_path ?? args?.target_path, redactText) : undefined,
    };
  }
  if (name === "edit") {
    return {
      category: "write",
      labelKey: "edit",
      targetLabel: hasArgs ? extractSafeBasename(args?.path ?? args?.file_path ?? args?.target_path, redactText) : undefined,
    };
  }
  if (name === "kulo_host_action") {
    if (action === "inspect") {
      // Never classify host diagnostics as foldable read-only per P2-3 policy.
      return { category: "other", labelKey: "kulo_host_action_inspect" };
    }
    return {
      category: "write",
      labelKey: "kulo_host_action",
      targetLabel: hasArgs ? safeTarget(args?.summary) : undefined,
    };
  }

  // 2. Multi-action bridge & computer-use tools (strictly classified by sub-action).
  if (name === "kulo_lark_bridge") {
    if (!hasArgs) return { category: "other", labelKey: "kulo_lark_bridge" };
    const profileRaw = asNonEmptyString(args?.profile);
    const targetLabel = profileRaw && profileRaw !== "default" ? safeTarget(profileRaw) : undefined;
    if (action && LARK_READ_ACTIONS.has(action)) {
      return { category: "read", labelKey: `lark_${action}`, targetLabel };
    }
    if (action === "propose_reply") {
      return { category: "confirm", labelKey: "lark_propose_reply", targetLabel };
    }
    if (action === "configure") return { category: "write", labelKey: "lark_configure" };
    if (action === "sync_now") return { category: "write", labelKey: "lark_sync_now" };
    return { category: "write", labelKey: "kulo_lark_bridge", targetLabel };
  }

  if (name === "kulo_browser") {
    if (!hasArgs) return { category: "other", labelKey: "kulo_browser" };
    const host = extractSafeHostname(args?.url, redactText);
    if (action && BROWSER_READ_ACTIONS.has(action)) {
      return { category: "read", labelKey: "browser_observe", targetLabel: host };
    }
    if (action === "batch") {
      return isReadOnlyBrowserBatch(args?.steps)
        ? { category: "read", labelKey: "browser_observe" }
        : { category: "write", labelKey: "browser_interact" };
    }
    if (action && BROWSER_WRITE_ACTIONS.has(action)) {
      return { category: "write", labelKey: "browser_interact", targetLabel: host };
    }
    return { category: "write", labelKey: "kulo_browser", targetLabel: host };
  }

  if (name === "kulo_desktop") {
    if (!hasArgs) return { category: "other", labelKey: "kulo_desktop" };
    const appLabel = safeTarget(args?.app);
    if (action === "snapshot" || action === "status") {
      return { category: "read", labelKey: "desktop_observe", targetLabel: appLabel };
    }
    return { category: "write", labelKey: "kulo_desktop", targetLabel: appLabel };
  }

  if (name === "kulo_connection_use") {
    if (!hasArgs) return { category: "other", labelKey: "connection_use" };
    const connectionId = asNonEmptyString(args?.connection_id);
    const targetLabel = connectionId ? safeTarget(resolveConnectionLabel?.(connectionId)) : undefined;
    const op = asNonEmptyString(args?.operation);
    const method = asNonEmptyString(args?.method)?.toUpperCase();
    const isRead =
      (op === "information" && action === "read") ||
      (op === "mcp" && action === "list_tools") ||
      (op === "http" && (!method || method === "GET" || method === "HEAD"));
    return isRead
      ? { category: "read", labelKey: "connection_read", targetLabel }
      : { category: "write", labelKey: "connection_use", targetLabel };
  }

  if (name === "kulo_spark_mail") {
    if (!hasArgs) return { category: "other", labelKey: "kulo_spark_mail" };
    if (action && SPARK_MAIL_READ_ACTIONS.has(action)) {
      return { category: "read", labelKey: "spark_mail_read" };
    }
    if (action === "propose_draft") {
      return { category: "confirm", labelKey: "spark_mail_propose_draft" };
    }
    return { category: "write", labelKey: "kulo_spark_mail" };
  }

  if (name === "kulo_home_assistant") {
    if (!hasArgs) return { category: "other", labelKey: "kulo_home_assistant" };
    if (action && HOME_ASSISTANT_READ_ACTIONS.has(action)) {
      return {
        category: "read",
        labelKey: "home_assistant_read",
        targetLabel: safeTarget(args?.area ?? args?.domain),
      };
    }
    if (action && HOME_ASSISTANT_CONFIRM_ACTIONS.has(action)) {
      return {
        category: "confirm",
        labelKey: "home_assistant_confirm",
        targetLabel: safeTarget(args?.title ?? args?.domain),
      };
    }
    return {
      category: "write",
      labelKey: "home_assistant_write",
      targetLabel: safeTarget(args?.domain),
    };
  }

  if (name === "kulo_assistant_watch") {
    if (!hasArgs) return { category: "other", labelKey: "assistant_watch_write" };
    return action === "list"
      ? { category: "read", labelKey: "assistant_watch_read" }
      : { category: "write", labelKey: "assistant_watch_write" };
  }

  if (name === "kulo_media_job") {
    if (hasArgs && (action === "list" || action === "status" || action === "inspect")) {
      return { category: "read", labelKey: "kulo_inspect_asset" };
    }
    return { category: "write", labelKey: "generic_action" };
  }

  // 3. Pure read-only tools.
  if (name === "read") {
    return {
      category: "read",
      labelKey: "read",
      targetLabel: hasArgs ? extractSafeBasename(args?.path ?? args?.file_path ?? args?.target_path, redactText) : undefined,
    };
  }
  if (name === "web_search") {
    return {
      category: "read",
      labelKey: "web_search",
      targetLabel: hasArgs ? safeTarget(args?.query) : undefined,
    };
  }
  if (name === "web_fetch") {
    return {
      category: "read",
      labelKey: "web_fetch",
      targetLabel: hasArgs ? extractSafeHostname(args?.url, redactText) : undefined,
    };
  }
  if (name === "kulo_history_search") {
    return {
      category: "read",
      labelKey: "kulo_history_search",
      targetLabel: hasArgs ? safeTarget(args?.query) : undefined,
    };
  }
  if (name === "kulo_history_read") return { category: "read", labelKey: "kulo_history_read" };
  if (MEMORY_READ_TOOLS.has(name)) {
    // Never leak memory queries or private bank contents into targetLabel.
    return { category: "read", labelKey: "memory_recall" };
  }
  if (name === "tool_search") return { category: "read", labelKey: "tool_search" };
  if (name === "kulo_skill_read") {
    return {
      category: "read",
      labelKey: "kulo_skill_read",
      targetLabel: hasArgs ? safeTarget(args?.id) : undefined,
    };
  }
  if (name === "kulo_inspect_staged_diff") return { category: "read", labelKey: "kulo_inspect_staged_diff" };
  if (name === "kulo_inspect_asset") return { category: "read", labelKey: "kulo_inspect_asset" };
  if (name === "kulo_connections") return { category: "read", labelKey: "kulo_connections" };
  if (name === "kulo_identity_read") return { category: "read", labelKey: "kulo_identity_read" };
  if (name === "kulo_assistant_digests") return { category: "read", labelKey: "kulo_assistant_digests" };
  if (name === "kulo_assistant_event_read") return { category: "read", labelKey: "kulo_assistant_event_read" };
  if (name === "kulo_assistant_read") return { category: "read", labelKey: "kulo_assistant_read" };
  if (PROJECT_READ_TOOLS.has(name)) return { category: "read", labelKey: "kulo_projects_read" };
  if (SETTINGS_READ_TOOLS.has(name)) return { category: "read", labelKey: "kulo_settings_read" };
  if (name === "kulo_status" || name === "kulo_inspect" || name === "kulo_task_board") {
    return { category: "read", labelKey: name };
  }

  // 4. Confirmation & human-decision tools.
  if (name === "kulo_computer_handoff") return { category: "confirm", labelKey: "kulo_computer_handoff" };
  if (name === "kulo_host_action_decide") return { category: "confirm", labelKey: "kulo_host_action_decide" };
  if (name === "kulo_ticket_ask_user") return { category: "confirm", labelKey: "kulo_ticket_ask_user" };
  if (name === "kulo_external_permission") return { category: "confirm", labelKey: "kulo_external_permission" };
  if (name === "kulo_connection_request") {
    const connectionId = hasArgs ? asNonEmptyString(args?.connection_id) : undefined;
    return {
      category: "confirm",
      labelKey: "kulo_connection_request",
      targetLabel: connectionId ? safeTarget(resolveConnectionLabel?.(connectionId)) : undefined,
    };
  }
  if (name === "kulo_connection_decide") return { category: "confirm", labelKey: "kulo_connection_decide" };
  if (name === "kulo_identity_propose") return { category: "confirm", labelKey: "kulo_identity_propose" };
  if (name === "kulo_appearance_propose" || name === "kulo_customization" || name === "kulo_official_update") {
    return { category: "confirm", labelKey: "kulo_settings_update" };
  }

  // 5. Explicit write / generation / publication tools.
  if (MEMORY_WRITE_TOOLS.has(name)) return { category: "write", labelKey: "memory_retain" };
  if (MEMORY_FORGET_TOOLS.has(name)) return { category: "write", labelKey: "memory_forget" };
  if (name === "kulo_apply_staged_changes") return { category: "write", labelKey: "kulo_apply_staged_changes" };
  if (name === "kulo_generate_image") return { category: "write", labelKey: "kulo_generate_image" };
  if (name === "kulo_generate_video") return { category: "write", labelKey: "kulo_generate_video" };
  if (name === "kulo_synthesize_speech") return { category: "write", labelKey: "kulo_synthesize_speech" };
  if (name === "kulo_publish_asset") {
    return {
      category: "write",
      labelKey: "kulo_publish_asset",
      targetLabel: hasArgs ? extractSafeBasename(args?.path ?? args?.file_path, redactText) : undefined,
    };
  }
  if (name === "kulo_ui_show") return { category: "write", labelKey: "kulo_ui_show" };
  if (name === "kulo_ui_update") return { category: "write", labelKey: "kulo_ui_update" };
  if (name === "kulo_ui_diagram") return { category: "write", labelKey: "kulo_ui_diagram" };
  if (name === "kulo_assistant_configure") return { category: "write", labelKey: "kulo_assistant_configure" };
  if (PROJECT_WRITE_TOOLS.has(name)) return { category: "write", labelKey: "kulo_projects_write" };
  if (SETTINGS_WRITE_TOOLS.has(name)) return { category: "write", labelKey: "kulo_settings_update" };
  if (name === "kulo_dispatch" || name === "kulo_steer" || name === "kulo_stop" || name === "kulo_close") {
    return { category: "write", labelKey: name };
  }

  // 6. Fail closed: unrecognized tools are never classified as foldable read-only.
  return { category: "other", labelKey: "generic_action" };
}

export function classifyToolAction(input: ClassifyToolActionInput): ToolActionMeta {
  const redactText = input.redactText ?? redactSensitiveText;
  const core = classifyCore(input.name, input.args, redactText, input.resolveConnectionLabel);
  return {
    category: core.category,
    labelKey: core.labelKey,
    ...(core.targetLabel ? { targetLabel: core.targetLabel } : {}),
    status: input.status ?? "running",
  };
}

/**
 * Streaming-safe projection for `live.tools` entries where `arguments` are not yet available.
 * Multi-action tools degrade safely to non-read-only tool-level phrases without targetLabel.
 */
export function buildLiveToolActionMeta(name: string): ToolActionMeta {
  return classifyToolAction({ name, status: "running" });
}

function parseJsonObjectFromText(
  content: ReadonlyArray<{ type?: string; text?: string }> | undefined,
): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  const firstText = content.find((part) => part?.type === "text" && typeof part.text === "string")?.text;
  if (!firstText) return undefined;
  const trimmed = firstText.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function payloadIndicatesAwaitingConfirm(name: string, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (typeof payload.status === "string" && AWAITING_CONFIRM_STATUSES.has(payload.status)) return true;
  if (payload.requiresConfirmation === true || payload.proposed === true) return true;
  if (name === "kulo_connection_request" && payload.status === "pending") return true;
  return false;
}

function extractSanitizedErrorBrief(
  name: string,
  content: ReadonlyArray<{ type?: string; text?: string }> | undefined,
  redactText: (text: string) => string,
): string | undefined {
  if (MEMORY_REDACTED_TOOLS.has(name) || !Array.isArray(content)) return undefined;
  const rawJoined = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n")
    .trim();
  if (!rawJoined) return undefined;

  let candidate = rawJoined;
  const parsed = parseJsonObjectFromText(content);
  if (parsed) {
    if (isRecord(parsed.error) && typeof parsed.error.message === "string" && parsed.error.message.trim()) {
      candidate = parsed.error.message;
    } else if (typeof parsed.error === "string" && parsed.error.trim()) {
      candidate = parsed.error;
    } else if (typeof parsed.message === "string" && parsed.message.trim()) {
      candidate = parsed.message;
    }
  }

  // Redact full error text before taking the first line or truncating so secrets never leak.
  const redacted = redactSensitiveText(redactText(candidate));
  const firstLine = redacted.split(/[\r\n]/, 1)[0] ?? "";
  return redactAndTruncate(firstLine, redactText, MAX_ERROR_BRIEF_CHARS);
}

export interface FinalizeToolActionMetaInput {
  name: string;
  isError: boolean;
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  details?: unknown;
  redactText?: (text: string) => string;
}

export function finalizeToolActionMeta(
  current: ToolActionMeta,
  input: FinalizeToolActionMetaInput,
): ToolActionMeta {
  const redactText = input.redactText ?? redactSensitiveText;
  if (input.isError) {
    const errorBrief = extractSanitizedErrorBrief(input.name, input.content, redactText);
    return {
      category: current.category,
      labelKey: current.labelKey,
      ...(current.targetLabel ? { targetLabel: current.targetLabel } : {}),
      status: "error",
      ...(errorBrief ? { errorBrief } : {}),
    };
  }

  const awaitingConfirm =
    payloadIndicatesAwaitingConfirm(input.name, input.details) ||
    payloadIndicatesAwaitingConfirm(input.name, parseJsonObjectFromText(input.content));

  return {
    category: current.category,
    labelKey: current.labelKey,
    ...(current.targetLabel ? { targetLabel: current.targetLabel } : {}),
    status: awaitingConfirm ? "awaiting_confirm" : "ok",
  };
}
