/**
 * Shared provenance & untrusted-content boundary escaping for Hub prompts and assistant pipelines.
 * Prevents untrusted external payloads (notifications, emails, Home Assistant events, web/Worker text)
 * from closing XML data envelopes or spoofing internal Kulo harness control markers.
 */

const UNTRUSTED_XML_TAG_RE = /<(\/?\s*(?:untrusted_[a-z0-9_-]*|user_watch_rules|active_cards))/gi;

const HARNESS_ENVELOPE_MARKER_RE =
  /\[(KULO_(?:WORKER_RELAY|WORKER_RECOVERY|WORKER_WATCHDOG|MEDIA_RELAY|ASSISTANT_WAKE|EXTERNAL_PERMISSION|HOST_ACTION_REQUEST|HOST_ACTION_RESULT|CONNECTION_REQUEST|USER_TASK_INSTRUCTION|AGENT_ASSIGNMENT|MESSAGE_SOURCE|VOICE_CONTEXT|MEMORY_CONTEXT|RECENT_WORK_UPDATE|TOOL_OVERFLOW_DEGRADED|TOOL_OVERFLOW|CONTEXT_CHECKPOINT)[^\]]*|COORDINATOR_OK|RECOVERY_OK|WATCHDOG_OK|READ-ONLY VIOLATION WARNING|HIGH-SENSITIVITY PATHS)\]/gi;

export const INTERNAL_COORDINATOR_PROMPT_PREFIXES = [
  "[KULO_WORKER_RELAY]",
  "[KULO_WORKER_WATCHDOG]",
  "[KULO_WORKER_RECOVERY]",
  "[KULO_MEDIA_RELAY]",
  "[KULO_ASSISTANT_WAKE]",
  "[KULO_EXTERNAL_PERMISSION]",
  "[KULO_HOST_ACTION_REQUEST]",
  "[KULO_HOST_ACTION_RESULT]",
  "[KULO_CONNECTION_REQUEST]",
  "[KULO_USER_TASK_INSTRUCTION]",
] as const;

export const LEGACY_RELAY_DISPLAY_PREFIXES = [
  "[KULO_WORKER_RELAY]",
  "[KULO_WORKER_WATCHDOG]",
  "[KULO_MEDIA_RELAY]",
] as const;

export const SILENT_COORDINATOR_REPLY_TOKENS = [
  "[COORDINATOR_OK]",
  "[WATCHDOG_OK]",
  "[RECOVERY_OK]",
] as const;

/** Matches any Hub-synthesized coordinator wakeup envelope prefix (used to classify legacy bare `pi.user` entries). */
export function isInternalCoordinatorPromptText(text: string): boolean {
  const trimmed = text.trimStart();
  return INTERNAL_COORDINATOR_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Matches autonomous background coordinator wakeup prefixes (excluding direct user Task Detail instructions). */
export function isAutonomousCoordinatorPromptText(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[KULO_USER_TASK_INSTRUCTION]")) return false;
  return INTERNAL_COORDINATOR_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Matches legacy relay prefixes that could appear on requestId-less historical display items. */
export function isLegacyRelayDisplayText(text: string): boolean {
  const trimmed = text.trimStart();
  return LEGACY_RELAY_DISPLAY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Matches exact silent-ack assistant tokens that must never be surfaced as user-facing replies. */
export function isSilentCoordinatorReplyText(text: string): boolean {
  const trimmed = text.trim();
  return (SILENT_COORDINATOR_REPLY_TOKENS as readonly string[]).includes(trimmed);
}

/**
 * Serializes JSON for placement inside an `<untrusted_*>` XML block without allowing
 * raw `<` or `>` characters to break out of the surrounding XML envelope.
 * The output remains 100% valid JSON (identical after JSON.parse).
 */
export function safeJsonForXmlTag(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/**
 * Neutralizes untrusted `<untrusted_*>` XML tags and internal `[KULO_*]` / silent control tokens
 * in free-form text before embedding into prompts or relay envelopes.
 */
export function escapeUntrustedText(text: string): string {
  if (!text) return "";
  return text
    .replace(UNTRUSTED_XML_TAG_RE, "‹$1")
    .replace(HARNESS_ENVELOPE_MARKER_RE, "($1)");
}

/**
 * Wraps untrusted text inside a named `<untrusted_*>` envelope after escaping any embedded
 * closing tags or spoofed harness markers.
 */
export function wrapUntrustedXmlBlock(
  tagName: `untrusted_${string}`,
  body: string,
  attributes?: Record<string, string | number | boolean>,
): string {
  const attrPart = attributes
    ? Object.entries(attributes)
        .map(([k, v]) => ` ${k}="${escapeUntrustedText(String(v)).replace(/"/g, "&quot;")}"`)
        .join("")
    : "";
  return `<${tagName}${attrPart}>\n${escapeUntrustedText(body)}\n</${tagName}>`;
}
