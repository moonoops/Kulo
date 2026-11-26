import { AssistantEntry, type EntryRecord } from "@earendil-works/pi-durable";

/**
 * Pure extraction of the absolute paths the coordinator already read or edited in the current turn,
 * so a dispatched Worker starts from the same evidence instead of rediscovering it. Only paths are
 * handed over (never file contents), and only for the Env the coordinator's tools ran on.
 */
export const MAX_EVIDENCE_PATHS = 40;
const MAX_MANIFEST_CHARS = 2_000;
const EVIDENCE_TOOLS = new Set(["read", "edit"]);
const KULO_PRIVATE_SEGMENT = /(?:^|[\\/])(?:\.kulo-state|\.kulo-env|\.secure)(?:[\\/]|$)/i;

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function collectCoordinatorEvidencePaths(
  entries: readonly EntryRecord[],
  options: { redact?: (text: string) => string; limit?: number } = {},
): string[] {
  const limit = Math.max(0, Math.min(options.limit ?? MAX_EVIDENCE_PATHS, MAX_EVIDENCE_PATHS));
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of entries) {
    if (paths.length >= limit) break;
    if (!AssistantEntry.is(entry)) continue;
    const message = entry.model?.[0];
    if (!message || message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || !EVIDENCE_TOOLS.has(block.name)) continue;
      const raw = (block.arguments as { path?: unknown } | undefined)?.path;
      if (typeof raw !== "string") continue;
      const candidate = raw.trim().replace(/^@/, "");
      if (!candidate || candidate.length > 1_024 || !isAbsolutePath(candidate) || /[\u0000-\u001f]/.test(candidate)) continue;
      if (KULO_PRIVATE_SEGMENT.test(candidate)) continue;
      const safe = options.redact ? options.redact(candidate) : candidate;
      // A redacted path no longer names a real file; drop it rather than mislead the Worker.
      if (safe !== candidate || seen.has(safe)) continue;
      seen.add(safe);
      paths.push(safe);
      if (paths.length >= limit) break;
    }
  }
  return paths;
}

/** One concise line appended to the Worker's additional instructions; empty when nothing was inspected. */
export function formatEvidenceManifest(paths: readonly string[]): string {
  if (!paths.length) return "";
  const prefix = "Coordinator already inspected these paths on this Env (paths only; re-read only what you need): ";
  let line = prefix;
  for (const [index, entry] of paths.entries()) {
    const next = `${index ? ", " : ""}${entry}`;
    if (line.length + next.length > MAX_MANIFEST_CHARS) {
      line += ", …";
      break;
    }
    line += next;
  }
  return line;
}
