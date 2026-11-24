import type { AssistantMessageDirection, AssistantMessageMeta } from "@kulo/protocol";

export interface StoredAssistantEvent {
  id: string;
  envId: string;
  driverId: string;
  streamId: string;
  sourceEpoch: string;
  nativeEventId: string;
  eventVersion: string;
  appId: string;
  appLabel: string;
  threadHint?: string;
  sender?: string;
  title: string;
  subtitle?: string;
  body: string;
  occurredAt: number;
  receivedAt: number;
  snapshotRef?: string;
  direction?: AssistantMessageDirection;
  messageMeta?: AssistantMessageMeta;
}

export interface HaSentinelStateRow {
  entityId: string;
  unavailableSince?: number;
  offlineAlertedAt?: number;
  lowBatteryAlertedAt?: number;
  doorOpenSince?: number;
  lastCameraTriageAt?: number;
  updatedAt: number;
}

export interface HaAutomationBackupRow {
  id: string;
  automationId: string;
  alias: string;
  previousConfigJson?: string;
  appliedConfigJson: string;
  createdAt: number;
}

export interface StoredAssistantDigest {
  id: string;
  createdAt: number;
  appId: string;
  appLabel: string;
  threadHint?: string;
  category: string;
  disposition: "noise" | "archive" | "notify_brain";
  urgency: "low" | "normal" | "high";
  digest: string;
  eventIds: string[];
  situationKey: string;
  driverId?: string;
  direction?: AssistantMessageDirection;
}

export const LARK_NOTIFICATION_APP_IDS = [
  "com.electron.lark",
  "com.bytedance.feishu",
  "com.bytedance.lark",
] as const;

const LARK_NOTIFICATION_APP_SET = new Set<string>(LARK_NOTIFICATION_APP_IDS);

const LARK_FAMILY_QUERY_ALIASES = new Set<string>([
  "飞书",
  "lark",
  "feishu",
  ...LARK_NOTIFICATION_APP_IDS,
]);

const GENERIC_LARK_TOKENS = new Set<string>([
  "飞书",
  "飞书私聊",
  "飞书群聊",
  "飞书日历",
  "lark",
  "feishu",
  "私聊",
  "群聊",
  "消息",
  "通知",
]);

const FOLD_WINDOW_MS = 3 * 60 * 1_000;

export interface FoldableDigestLike {
  createdAt: number;
  appId: string;
  appLabel: string;
  threadHint?: string;
  driverId?: string;
  digest: string;
  situationKey: string;
}

export function isLarkFamilyQueryFilter(appFilter: string): boolean {
  return LARK_FAMILY_QUERY_ALIASES.has(appFilter.trim().toLowerCase());
}

export function buildDigestAppFilterSql(
  appFilter: string,
  tableAlias?: string,
): { clause: string; params: string[] } {
  const trimmed = appFilter.trim();
  const lower = trimmed.toLowerCase();
  const col = (name: string) => (tableAlias ? `${tableAlias}.${name}` : name);

  if (LARK_FAMILY_QUERY_ALIASES.has(lower)) {
    return {
      clause: `(${col("app_id")} LIKE 'lark:%' OR lower(${col("app_id")}) IN ('com.electron.lark', 'com.bytedance.feishu', 'com.bytedance.lark') OR ${col("app_label")} LIKE '飞书%')`,
      params: [],
    };
  }
  if (lower.startsWith("lark:")) {
    return {
      clause: `${col("app_id")} = ?`,
      params: [trimmed],
    };
  }
  return {
    clause: `(${col("app_id")} = ? OR ${col("app_label")} = ?)`,
    params: [trimmed, trimmed],
  };
}

function isLarkCliDigest(item: FoldableDigestLike): boolean {
  return item.driverId === "lark-cli" || item.appId.trim().toLowerCase().startsWith("lark:");
}

function isLarkNotificationDigest(item: FoldableDigestLike): boolean {
  if (isLarkCliDigest(item)) return false;
  const appId = item.appId.trim().toLowerCase();
  if (LARK_NOTIFICATION_APP_SET.has(appId)) return true;
  return item.driverId === "macos-notifications" && item.appLabel.trim().startsWith("飞书");
}

function normalizeDigestText(raw: string): string {
  return raw
    .replace(/^\[[^\]]+\]\s*/u, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function extractMatchTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  const cleaned = raw
    .replace(/^\[[^\]]+\]\s*/u, "")
    .trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/[\s:：·•/|,，。！？!?\-—()（）「」【】[\]]+/u)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 2 && !GENERIC_LARK_TOKENS.has(part));
  return [...new Set(parts)];
}

function hasSharedContentSubstring(a: string, b: string, minLen = 6): boolean {
  if (a.length < minLen || b.length < minLen) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const step = Math.max(1, Math.min(2, Math.floor(minLen / 3)));
  for (let i = 0; i <= shorter.length - minLen; i += step) {
    const slice = shorter.slice(i, i + minLen);
    if (longer.includes(slice)) return true;
  }
  return false;
}

function isShadowedByLarkCli(notif: FoldableDigestLike, structured: readonly FoldableDigestLike[]): boolean {
  const notifThread = notif.threadHint?.trim().toLowerCase() ?? "";
  const notifNorm = normalizeDigestText(notif.digest);
  const notifHeaderTokens = extractMatchTokens(notif.threadHint);

  for (const lark of structured) {
    if (Math.abs(lark.createdAt - notif.createdAt) > FOLD_WINDOW_MS) continue;

    const larkThread = lark.threadHint?.trim().toLowerCase() ?? "";
    if (notifThread.length >= 2 && larkThread === notifThread) return true;

    const larkHaystack = `${lark.digest} ${lark.situationKey} ${lark.threadHint ?? ""}`.toLowerCase();
    if (notifThread.length >= 2 && !GENERIC_LARK_TOKENS.has(notifThread) && larkHaystack.includes(notifThread)) {
      return true;
    }
    if (notifHeaderTokens.some((tok) => tok.length >= 2 && larkHaystack.includes(tok))) {
      const larkNorm = normalizeDigestText(lark.digest);
      if (hasSharedContentSubstring(notifNorm, larkNorm, 4) || notifNorm.length <= 12) {
        return true;
      }
    }

    const larkNorm = normalizeDigestText(lark.digest);
    if (hasSharedContentSubstring(notifNorm, larkNorm, 6)) {
      return true;
    }
  }
  return false;
}

/**
 * Non-destructive read-time folding for search/patrol digest lists:
 * keeps all rows intact in SQLite, but suppresses macOS Feishu notification digests
 * when a structured `lark-cli` digest covers the same conversation/content within +/-3 minutes.
 */
export function foldShadowedAssistantDigests<T extends FoldableDigestLike>(
  items: readonly T[],
  limit: number,
): T[] {
  const structuredLark = items.filter(isLarkCliDigest);
  if (structuredLark.length === 0) return items.slice(0, limit);

  const kept: T[] = [];
  for (const item of items) {
    if (isLarkNotificationDigest(item) && isShadowedByLarkCli(item, structuredLark)) {
      continue;
    }
    kept.push(item);
    if (kept.length >= limit) break;
  }
  return kept;
}

export function parseAssistantDirection(raw: unknown): AssistantMessageDirection | undefined {
  return raw === "incoming" || raw === "outgoing" || raw === "unknown" ? raw : undefined;
}

export function sanitizeAssistantMessageMeta(meta: AssistantMessageMeta): AssistantMessageMeta | undefined {
  const out: AssistantMessageMeta = {};
  if (typeof meta.chatId === "string" && meta.chatId.trim()) out.chatId = meta.chatId.trim().slice(0, 128);
  if (meta.chatType === "p2p" || meta.chatType === "group" || meta.chatType === "topic") out.chatType = meta.chatType;
  if (typeof meta.messageId === "string" && meta.messageId.trim()) out.messageId = meta.messageId.trim().slice(0, 128);
  if (typeof meta.threadId === "string" && meta.threadId.trim()) out.threadId = meta.threadId.trim().slice(0, 128);
  if (typeof meta.replyToMessageId === "string" && meta.replyToMessageId.trim()) out.replyToMessageId = meta.replyToMessageId.trim().slice(0, 128);
  if (typeof meta.messagePosition === "string" && meta.messagePosition.trim()) out.messagePosition = meta.messagePosition.trim().slice(0, 32);
  if (meta.deleted === true) out.deleted = true;
  if (meta.mentionsMe === true) out.mentionsMe = true;
  if (meta.mentionsAll === true) out.mentionsAll = true;
  if (meta.mutedChat === true) out.mutedChat = true;
  if (meta.backfill === true) out.backfill = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseAssistantMessageMeta(raw: unknown): AssistantMessageMeta | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return sanitizeAssistantMessageMeta(parsed as AssistantMessageMeta);
  } catch {
    return undefined;
  }
}

export function buildFtsTrigramQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/"/g, "").trim())
    .filter((part) => part.length >= 3);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token}"`).join(" AND ");
}

export function mapHaSentinelStateRow(row: Record<string, unknown>): HaSentinelStateRow {
  return {
    entityId: String(row.entity_id),
    ...(typeof row.unavailable_since === "number" ? { unavailableSince: row.unavailable_since } : {}),
    ...(typeof row.offline_alerted_at === "number" ? { offlineAlertedAt: row.offline_alerted_at } : {}),
    ...(typeof row.low_battery_alerted_at === "number" ? { lowBatteryAlertedAt: row.low_battery_alerted_at } : {}),
    ...(typeof row.door_open_since === "number" ? { doorOpenSince: row.door_open_since } : {}),
    ...(typeof row.last_camera_triage_at === "number" ? { lastCameraTriageAt: row.last_camera_triage_at } : {}),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export function mapHaAutomationBackupRow(row: Record<string, unknown>): HaAutomationBackupRow {
  return {
    id: String(row.id),
    automationId: String(row.automation_id),
    alias: String(row.alias ?? ""),
    ...(typeof row.previous_config_json === "string" ? { previousConfigJson: row.previous_config_json } : {}),
    appliedConfigJson: String(row.applied_config_json ?? "{}"),
    createdAt: Number(row.created_at ?? 0),
  };
}

export function mapEventRow(row: Record<string, unknown>, redact: (value: string) => string): StoredAssistantEvent {
  const direction = parseAssistantDirection(row.direction);
  const messageMeta = parseAssistantMessageMeta(row.message_meta_json);
  return {
    id: String(row.id),
    envId: String(row.env_id),
    driverId: String(row.driver_id),
    streamId: String(row.stream_id),
    sourceEpoch: String(row.source_epoch),
    nativeEventId: String(row.native_event_id),
    eventVersion: String(row.event_version),
    appId: String(row.app_id),
    appLabel: String(row.app_label),
    ...(typeof row.thread_hint === "string" ? { threadHint: redact(row.thread_hint) } : {}),
    ...(typeof row.sender === "string" ? { sender: redact(row.sender) } : {}),
    title: redact(String(row.title ?? "")),
    ...(typeof row.subtitle === "string" ? { subtitle: redact(row.subtitle) } : {}),
    body: redact(String(row.body ?? "")),
    occurredAt: Number(row.occurred_at),
    receivedAt: Number(row.received_at),
    ...(typeof row.snapshot_ref === "string" && row.snapshot_ref ? { snapshotRef: row.snapshot_ref } : {}),
    ...(direction ? { direction } : {}),
    ...(messageMeta ? { messageMeta } : {}),
  };
}

export function mapDigestRow(row: Record<string, unknown>): StoredAssistantDigest {
  let eventIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.event_ids_json ?? "[]")) as unknown;
    if (Array.isArray(parsed)) eventIds = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    eventIds = [];
  }
  const disp = String(row.disposition ?? "archive");
  const urgency = String(row.urgency ?? "low");
  const direction = parseAssistantDirection(row.direction);
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    appId: String(row.app_id),
    appLabel: String(row.app_label),
    ...(typeof row.thread_hint === "string" ? { threadHint: row.thread_hint } : {}),
    category: String(row.category ?? "general"),
    disposition: disp === "noise" || disp === "notify_brain" ? disp : "archive",
    urgency: urgency === "high" || urgency === "normal" ? urgency : "low",
    digest: String(row.digest ?? ""),
    eventIds,
    situationKey: String(row.situation_key ?? ""),
    ...(typeof row.driver_id === "string" && row.driver_id ? { driverId: row.driver_id } : {}),
    ...(direction ? { direction } : {}),
  };
}
