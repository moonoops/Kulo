import { createHash } from "node:crypto";

export const ECHO_MIN_NORMALIZED_CHARS = 12;
export const ECHO_DEFAULT_TTL_MS = 15_000;
const ECHO_MAX_TOKENS = 128;
const SELF_NOTIFICATION_TTL_MS = 30_000;
const SELF_NOTIFICATION_MAX_TOKENS = 64;

const BROWSER_OR_ELECTRON_APP_RE =
  /^(?:com\.google\.chrome|com\.apple\.safari|company\.thebrowser\.browser|com\.microsoft\.edgemac|org\.mozilla\.firefox|com\.brave\.browser|com\.operasoftware\.opera|com\.vivaldi\.vivaldi|com\.github\.electron)(?:\.|$)/i;

const SECURITY_EXEMPT_RE = /(?:门锁|安防|告警|报警|烟雾|燃气|漏水|入侵|alarm|security|lock|smoke|gas|leak)/i;

export function normalizeEchoText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function hashNormalizedText(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

function isSecurityExempt(appId: string, title?: string, body?: string): boolean {
  if (appId.trim().toLowerCase() === "home-assistant") return true;
  return SECURITY_EXEMPT_RE.test(`${title ?? ""} ${body ?? ""}`);
}

interface EchoToken {
  appId: string;
  bodyHash: string;
  selfSenders: Set<string>;
  requireSenderMatch: boolean;
  expiresAt: number;
}

export interface RecordOutgoingEchoInput {
  appId: string;
  body: string;
  selfSenders?: readonly string[];
  requireSenderMatch?: boolean;
  ttlMs?: number;
  now?: number;
}

export interface IncomingEchoCandidate {
  appId: string;
  driverId?: string;
  sender?: string;
  title?: string;
  body: string;
  now?: number;
}

/**
 * Five-guard memory echo suppressor preventing Kulo's own outgoing connector actions
 * from re-triggering background sorting or waking the main brain:
 * 1. Minimum normalized body length >= 12 characters (never swallows "好的"/"收到"/"OK").
 * 2. Exact full normalized body SHA-256 hash match (never loose thread/title prefix matching).
 * 3. Sender exclusion (distinct human senders are never suppressed).
 * 4. Short 15s TTL + single-use token burn (`consumeOnce`).
 * 5. Permanent hard exemption for Home Assistant and physical security alerts.
 */
export class AssistantEchoSuppressor {
  readonly #tokens: EchoToken[] = [];
  readonly #selfNotifications: Array<{ normalized: string; expiresAt: number }> = [];

  recordSelfNotification(body: string | undefined, now = Date.now()): void {
    const normalized = normalizeEchoText(body ?? "");
    if (!normalized) return;
    this.#pruneSelfNotifications(now);
    this.#selfNotifications.push({ normalized, expiresAt: now + SELF_NOTIFICATION_TTL_MS });
    if (this.#selfNotifications.length > SELF_NOTIFICATION_MAX_TOKENS) {
      this.#selfNotifications.splice(0, this.#selfNotifications.length - SELF_NOTIFICATION_MAX_TOKENS);
    }
  }

  isSelfNotificationEcho(candidate: IncomingEchoCandidate): boolean {
    const appId = candidate.appId.trim().toLowerCase();
    if (!BROWSER_OR_ELECTRON_APP_RE.test(appId)) return false;
    const titleNorm = (candidate.title ?? "").trim().toLowerCase();
    if (titleNorm !== "kulo") return false;
    const now = candidate.now ?? Date.now();
    this.#pruneSelfNotifications(now);
    if (this.#selfNotifications.length === 0) return false;
    const bodyNorm = normalizeEchoText(candidate.body);
    if (!bodyNorm) return false;
    for (const token of this.#selfNotifications) {
      if (bodyNorm === token.normalized || bodyNorm.includes(token.normalized) || token.normalized.includes(bodyNorm)) {
        return true;
      }
    }
    return false;
  }

  recordOutgoing(input: RecordOutgoingEchoInput): boolean {
    const appId = input.appId.trim().toLowerCase();
    if (!appId || isSecurityExempt(appId, undefined, input.body)) return false;

    const normalized = normalizeEchoText(input.body);
    if (Array.from(normalized).length < ECHO_MIN_NORMALIZED_CHARS) return false;

    const now = input.now ?? Date.now();
    this.#pruneExpired(now);

    const ttlMs = Math.max(1_000, Math.min(input.ttlMs ?? ECHO_DEFAULT_TTL_MS, 30_000));
    const selfSenders = new Set(
      (input.selfSenders ?? [])
        .map((sender) => normalizeEchoText(sender))
        .filter(Boolean),
    );

    this.#tokens.push({
      appId,
      bodyHash: hashNormalizedText(normalized),
      selfSenders,
      requireSenderMatch: Boolean(input.requireSenderMatch),
      expiresAt: now + ttlMs,
    });
    if (this.#tokens.length > ECHO_MAX_TOKENS) {
      this.#tokens.splice(0, this.#tokens.length - ECHO_MAX_TOKENS);
    }
    return true;
  }

  consumeIfEcho(candidate: IncomingEchoCandidate): boolean {
    const appId = candidate.appId.trim().toLowerCase();
    if (!appId || isSecurityExempt(appId, candidate.title, candidate.body)) return false;

    const now = candidate.now ?? Date.now();
    this.#pruneExpired(now);
    if (this.#tokens.length === 0) return false;

    const normalized = normalizeEchoText(candidate.body);
    if (Array.from(normalized).length < ECHO_MIN_NORMALIZED_CHARS) return false;

    const incomingHash = hashNormalizedText(normalized);
    const incomingSender = candidate.sender ? normalizeEchoText(candidate.sender) : "";

    for (let i = 0; i < this.#tokens.length; i++) {
      const token = this.#tokens[i]!;
      if (token.appId !== appId || token.bodyHash !== incomingHash) continue;

      // Sender exclusion: if an explicit sender is present, verify it is not a different human sender.
      if (incomingSender) {
        if (token.selfSenders.size > 0) {
          if (!token.selfSenders.has(incomingSender)) continue;
        } else if (token.requireSenderMatch || candidate.driverId === "lark-cli") {
          // Structured IM feeds populate `sender` with the real author; without a known selfSender,
          // conservatively refuse suppression so a reply from another person is never swallowed.
          continue;
        }
      }

      // Single-use burn (`consumeOnce`).
      this.#tokens.splice(i, 1);
      return true;
    }

    return false;
  }

  get activeCount(): number {
    this.#pruneExpired(Date.now());
    return this.#tokens.length;
  }

  clear(): void {
    this.#tokens.length = 0;
    this.#selfNotifications.length = 0;
  }

  #pruneExpired(now: number): void {
    for (let i = this.#tokens.length - 1; i >= 0; i--) {
      if (this.#tokens[i]!.expiresAt <= now) {
        this.#tokens.splice(i, 1);
      }
    }
  }

  #pruneSelfNotifications(now: number): void {
    for (let i = this.#selfNotifications.length - 1; i >= 0; i--) {
      if (this.#selfNotifications[i]!.expiresAt <= now) {
        this.#selfNotifications.splice(i, 1);
      }
    }
  }
}
