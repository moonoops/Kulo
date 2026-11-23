/**
 * Shared provenance & untrusted-content boundary escaping for Hub prompts and assistant pipelines.
 * Prevents untrusted external payloads (notifications, emails, Home Assistant events, web/Worker text)
 * from closing XML data envelopes or spoofing internal Kulo harness control markers.
 */

const UNTRUSTED_XML_TAG_RE = /<(\/?\s*untrusted_[a-z0-9_-]*)/gi;

const HARNESS_ENVELOPE_MARKER_RE =
  /\[(KULO_(?:WORKER_RELAY|WORKER_RECOVERY|WORKER_WATCHDOG|MEDIA_RELAY|EXTERNAL_PERMISSION|HOST_ACTION_REQUEST|HOST_ACTION_RESULT|CONNECTION_REQUEST|AGENT_ASSIGNMENT|MESSAGE_SOURCE|VOICE_CONTEXT|MEMORY_CONTEXT)[^\]]*|COORDINATOR_OK|RECOVERY_OK|WATCHDOG_OK|READ-ONLY VIOLATION WARNING|HIGH-SENSITIVITY PATHS)\]/gi;

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
