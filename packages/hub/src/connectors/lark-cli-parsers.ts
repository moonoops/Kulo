import { createHash } from "node:crypto";
import type {
  AssistantMessageDirection,
  AssistantMessageMeta,
  LarkProfileView,
  RawConnectorEvent,
} from "@kulo/protocol";
import { isSensitiveNotificationPayload } from "@kulo/protocol";

export const SAFE_PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SAFE_CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,120}$/;

export type LarkExecResult = { ok: boolean; stdout: string; stderr: string; code?: string; exitCode?: number };

export type LarkCliErrorKind =
  | "missing_scope"
  | "keychain_unavailable"
  | "auth_expired"
  | "rate_limited"
  | "invalid_json"
  | "cli_error";

export interface LarkCliParsedError {
  kind: LarkCliErrorKind;
  code?: number | string;
  missingScopes: string[];
  message: string;
  hint?: string;
}

export type LarkCliEnvelopeResult<T = unknown> =
  | { ok: true; data: T; identity?: string; meta?: Record<string, unknown> }
  | { ok: false; error: LarkCliParsedError };

export interface ParsedLarkAuthStatus {
  view: LarkProfileView;
  appId?: string;
  openId?: string;
  userName?: string;
  scopes: string[];
  grantedAt?: string;
  tokenStatus?: string;
  dpopKeyStatus?: string;
}

export interface LarkChatSummary {
  chatId: string;
  name: string;
  chatMode: "group" | "topic" | "p2p";
  p2pTargetId?: string;
  p2pTargetType?: string;
  external?: boolean;
  muted?: boolean;
}

export interface LarkMessageMention {
  id?: string;
  key?: string;
  name?: string;
}

export interface LarkImMessage {
  messageId: string;
  chatId: string;
  chatType?: "p2p" | "group" | "topic";
  chatName?: string;
  chatPartnerId?: string;
  chatPartnerName?: string;
  senderId?: string;
  senderName?: string;
  senderType?: string;
  msgType: string;
  content: string;
  createTimeRaw?: string | number;
  updateTimeRaw?: string | number;
  occurredAt?: number;
  deleted: boolean;
  updated: boolean;
  replyTo?: string;
  threadId?: string;
  messagePosition?: string;
  mentions: LarkMessageMention[];
}

export interface ParsedImMessagesPage {
  messages: LarkImMessage[];
  hasMore: boolean;
  pageToken?: string;
  pendingMessageIds: string[];
  pendingThreadIds: string[];
  note?: string;
  notice?: string;
  partial: boolean;
}

export function classifyOrganizationKind(name: string, brand?: string): "personal" | "enterprise" | "unknown" {
  const lower = `${name} ${brand ?? ""}`.toLowerCase();
  if (/(?:personal|home|private|个人|私有)/i.test(lower)) return "personal";
  if (/(?:corp|work|ent|company|org|team|企业|公司|工作)/i.test(lower)) return "enterprise";
  return "unknown";
}

export function parseLarkProfileList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return ["default"];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { profiles?: unknown[] }).profiles)
          ? (parsed as { profiles: unknown[] }).profiles
          : parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown[] }).data)
            ? (parsed as { data: unknown[] }).data
            : [];
      const names = list
        .map((item) =>
          typeof item === "string"
            ? item
            : item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
              ? (item as { name: string }).name
              : "",
        )
        .map((name) => name.trim())
        .filter((name) => SAFE_PROFILE_RE.test(name));
      return names.length > 0 ? [...new Set(names)] : ["default"];
    } catch {
      // fall through to line parser
    }
  }
  const names = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[*•\-\s]+/, "").split(/\s+/)[0]?.trim() ?? "")
    .filter(
      (name) =>
        name && SAFE_PROFILE_RE.test(name) && !["name", "profile", "profiles"].includes(name.toLowerCase()),
    );
  return names.length > 0 ? [...new Set(names)] : ["default"];
}

function tryParseJson(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function classifyErrorText(
  text: string,
  subtype?: string,
  type?: string,
  code?: number | string,
  missingScopes: readonly string[] = [],
): LarkCliErrorKind {
  const lower = `${type ?? ""} ${subtype ?? ""} ${text}`.toLowerCase();
  if (
    missingScopes.length > 0 ||
    subtype === "missing_scope" ||
    code === 99991679 ||
    code === 99991672 ||
    /missing required scope|missing_scope|permission denied|insufficient scope/i.test(lower)
  ) {
    return "missing_scope";
  }
  if (/keychain|dpop|seckey|secitem|user interaction is not allowed|errsec/i.test(lower)) {
    return "keychain_unavailable";
  }
  if (
    type === "authentication" ||
    code === 99991677 ||
    code === 99991668 ||
    /token.*expired|not logged in|unauthorized|auth login|invalid.*token|no refresh token/i.test(lower)
  ) {
    return "auth_expired";
  }
  if (code === 99991400 || code === 429 || /rate.?limit|too many requests|frequency limit/i.test(lower)) {
    return "rate_limited";
  }
  return "cli_error";
}

function extractStructuredError(
  parsed: unknown,
  fallbackText: string,
  redact: (s: string) => string,
  exitCode?: number,
): LarkCliParsedError {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const errObj =
      obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)
        ? (obj.error as Record<string, unknown>)
        : undefined;
    const rawMsg =
      typeof errObj?.message === "string"
        ? errObj.message
        : typeof obj.message === "string"
          ? obj.message
          : typeof obj.error === "string"
            ? obj.error
            : fallbackText;
    const subtype = typeof errObj?.subtype === "string" ? errObj.subtype : undefined;
    const type = typeof errObj?.type === "string" ? errObj.type : undefined;
    const code =
      typeof errObj?.code === "number" || typeof errObj?.code === "string"
        ? errObj.code
        : typeof obj.code === "number" || typeof obj.code === "string"
          ? obj.code
          : exitCode;
    const missingScopes = Array.isArray(errObj?.missing_scopes)
      ? errObj.missing_scopes.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const hint = typeof errObj?.hint === "string" ? redact(errObj.hint).slice(0, 240) : undefined;
    const message = redact(rawMsg || "lark-cli 调用失败").slice(0, 260);
    const kind = classifyErrorText(`${rawMsg} ${hint ?? ""}`, subtype, type, code, missingScopes);
    return {
      kind,
      ...(code !== undefined ? { code } : {}),
      missingScopes,
      message,
      ...(hint ? { hint } : {}),
    };
  }
  const message = redact(fallbackText.trim() || "lark-cli 调用失败").slice(0, 260);
  return {
    kind: classifyErrorText(message, undefined, undefined, exitCode),
    ...(exitCode !== undefined ? { code: exitCode } : {}),
    missingScopes: [],
    message,
  };
}

export function parseLarkCliEnvelope<T = unknown>(
  res: LarkExecResult,
  redact: (s: string) => string,
): LarkCliEnvelopeResult<T> {
  if (!res.ok) {
    // lark-cli v1.0.100 writes structured JSON error envelopes to stderr on non-zero exit.
    const parsedErr = tryParseJson(res.stderr) ?? tryParseJson(res.stdout);
    const fallback = res.stderr.trim() || res.stdout.trim() || (res.code ? `执行失败 (${res.code})` : "lark-cli 执行失败");
    return { ok: false, error: extractStructuredError(parsedErr, fallback, redact, res.exitCode) };
  }
  const trimmed = res.stdout.trim();
  if (!trimmed) {
    return { ok: false, error: { kind: "invalid_json", missingScopes: [], message: "lark-cli 返回空输出" } };
  }
  const parsed = tryParseJson(trimmed);
  if (parsed === undefined) {
    return {
      ok: false,
      error: {
        kind: "invalid_json",
        missingScopes: [],
        message: redact(`lark-cli 返回非 JSON 输出：${trimmed.slice(0, 120)}`).slice(0, 200),
      },
    };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.ok === false) {
      return { ok: false, error: extractStructuredError(obj, trimmed, redact, res.exitCode) };
    }
    if (obj.ok === true && "data" in obj) {
      return {
        ok: true,
        data: obj.data as T,
        ...(typeof obj.identity === "string" ? { identity: obj.identity } : {}),
        ...(obj.meta && typeof obj.meta === "object" && !Array.isArray(obj.meta)
          ? { meta: obj.meta as Record<string, unknown> }
          : {}),
      };
    }
  }
  return { ok: true, data: parsed as T };
}

export function parseLarkAuthStatus(
  res: LarkExecResult,
  profileName: string,
  redact: (s: string) => string,
): ParsedLarkAuthStatus {
  if (!res.ok) {
    const err = extractStructuredError(
      tryParseJson(res.stderr) ?? tryParseJson(res.stdout),
      res.stderr || res.stdout || "未授权",
      redact,
      res.exitCode,
    );
    const authState =
      err.kind === "keychain_unavailable" || err.kind === "auth_expired" ? "keychain_or_token_error" : "cli_error";
    return {
      view: {
        name: profileName,
        ready: false,
        authState,
        organizationKind: classifyOrganizationKind(profileName),
        error: err.message.slice(0, 200),
      },
      scopes: [],
    };
  }
  const parsed = tryParseJson(res.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      view: {
        name: profileName,
        ready: false,
        authState: "cli_error",
        organizationKind: classifyOrganizationKind(profileName),
        error: "auth status 输出格式无效，无法确认登录状态",
      },
      scopes: [],
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.ok === false) {
    const err = extractStructuredError(obj, res.stdout, redact, res.exitCode);
    return {
      view: {
        name: profileName,
        ready: false,
        authState: err.kind === "keychain_unavailable" || err.kind === "auth_expired" ? "keychain_or_token_error" : "cli_error",
        organizationKind: classifyOrganizationKind(profileName),
        error: err.message.slice(0, 200),
      },
      scopes: [],
    };
  }
  const root = obj.ok === true && obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
    ? (obj.data as Record<string, unknown>)
    : obj;
  const brand = typeof root.brand === "string" ? root.brand : undefined;
  const appId = typeof root.appId === "string" ? root.appId : undefined;
  const dpopKeyStatus = typeof root.dpopKeyStatus === "string" ? root.dpopKeyStatus : undefined;
  const identities =
    root.identities && typeof root.identities === "object" && !Array.isArray(root.identities)
      ? (root.identities as Record<string, unknown>)
      : undefined;
  const userObj =
    identities?.user && typeof identities.user === "object" && !Array.isArray(identities.user)
      ? (identities.user as Record<string, unknown>)
      : undefined;
  const botObj =
    identities?.bot && typeof identities.bot === "object" && !Array.isArray(identities.bot)
      ? (identities.bot as Record<string, unknown>)
      : undefined;

  const userAvail = Boolean(userObj?.available);
  const botAvail = Boolean(botObj?.available);
  const userName = typeof userObj?.userName === "string" ? userObj.userName : undefined;
  const openId = typeof userObj?.openId === "string" ? userObj.openId : undefined;
  const tokenStatus = typeof userObj?.tokenStatus === "string" ? userObj.tokenStatus : undefined;
  const grantedAt = typeof userObj?.grantedAt === "string" ? userObj.grantedAt : undefined;
  const rawScope = typeof userObj?.scope === "string" ? userObj.scope : "";
  const scopes = rawScope
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const tokenBad =
    tokenStatus !== undefined && /^(?:expired|invalid|missing|revoked|error|unavailable)$/i.test(tokenStatus.trim());
  const dpopBad =
    dpopKeyStatus !== undefined && /^(?:unavailable|locked|error|missing)$/i.test(dpopKeyStatus.trim());

  let ready = false;
  let authState: LarkProfileView["authState"] = "cli_error";
  let error: string | undefined;

  if (userAvail && !tokenBad && !dpopBad) {
    ready = true;
    authState = "user_ready";
  } else if (userAvail && (tokenBad || dpopBad)) {
    ready = false;
    authState = "keychain_or_token_error";
    error = dpopBad
      ? `钥匙串 DPoP 凭据不可用（${dpopKeyStatus}）`
      : `飞书用户登录凭据状态异常（${tokenStatus}），需重新登录授权`;
  } else if (!userAvail && botAvail) {
    ready = false;
    authState = "bot_only";
    error = "当前仅机器人身份可用，缺少个人用户登录授权";
  } else {
    ready = false;
    authState = "keychain_or_token_error";
    const userMsg = typeof userObj?.message === "string" ? redact(userObj.message).slice(0, 180) : undefined;
    error = userMsg || "尚未完成飞书个人用户登录授权";
  }

  return {
    view: {
      name: profileName,
      ...(appId ? { appId } : {}),
      ...(brand ? { brand } : {}),
      ...(userName ? { userName } : {}),
      ...(openId ? { openId } : {}),
      ready,
      authState,
      organizationKind: classifyOrganizationKind(profileName, brand),
      ...(error ? { error } : {}),
    },
    ...(appId ? { appId } : {}),
    ...(openId ? { openId } : {}),
    ...(userName ? { userName } : {}),
    scopes,
    ...(grantedAt ? { grantedAt } : {}),
    ...(tokenStatus ? { tokenStatus } : {}),
    ...(dpopKeyStatus ? { dpopKeyStatus } : {}),
  };
}

export function formatLarkLocalIso(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const tzOffsetMin = -date.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(tzOffsetMin);
  const tzH = pad(Math.floor(absMin / 60));
  const tzM = pad(absMin % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${tzH}:${tzM}`;
}

export function parseLarkTimestampMs(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return Math.floor(raw < 1e12 ? raw * 1000 : raw);
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return (
      parseLarkTimestampMs(obj.datetime) ??
      parseLarkTimestampMs(obj.date) ??
      parseLarkTimestampMs(obj.timestamp) ??
      parseLarkTimestampMs(obj.time)
    );
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d{10,13}$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isFinite(num) ? Math.floor(num < 1e12 ? num * 1000 : num) : undefined;
  }
  // Local minute/second format returned by lark-cli v1.0.100 IM shortcuts: "2026-11-24 17:06"
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (localMatch) {
    const [, y, m, d, hh, mm, ss] = localMatch;
    const ms = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), ss ? Number(ss) : 0).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  // Date-only all-day calendar format: "2026-11-24"
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const ms = new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  // RFC 3339 / ISO-8601 with explicit timezone
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed);
  }
  return undefined;
}

export function extractCalendarEventsFromData(
  profile: string,
  data: unknown,
  redact: (s: string) => string,
): { events: RawConnectorEvent[]; fetchedCount: number; skippedUnparseable: number } {
  const items = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as { events?: unknown[]; items?: unknown[] }).events ??
        (data as { items?: unknown[] }).items ??
        [])
      : [];
  const out: RawConnectorEvent[] = [];
  let skippedUnparseable = 0;

  for (const entry of items.slice(0, 50)) {
    if (!entry || typeof entry !== "object") {
      skippedUnparseable += 1;
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const id = String(obj.event_id ?? obj.id ?? "").trim();
    const title = String(obj.summary ?? obj.title ?? "").trim();
    const occurredAt = parseLarkTimestampMs(obj.start_time ?? obj.start ?? obj.startTime);
    if (!id || !title || occurredAt === undefined) {
      skippedUnparseable += 1;
      continue;
    }
    const description = typeof obj.description === "string" && obj.description.trim() ? obj.description : title;
    const versionSeed = obj.updated_at ?? obj.update_time ?? `${occurredAt}:${title}`;
    out.push({
      nativeEventId: `lark:cal:${id}`,
      eventVersion: String(versionSeed).slice(0, 80),
      appId: `lark:${profile}`,
      appLabel: profile === "default" ? "飞书" : `飞书 (${profile})`,
      threadHint: id,
      sender: "飞书日历",
      title: redact(title).slice(0, 200),
      body: redact(description).slice(0, 800),
      occurredAt: Math.max(0, occurredAt),
      fidelity: "structured",
    });
  }
  return { events: out, fetchedCount: items.length, skippedUnparseable };
}

export function extractChatDirectoryFromData(
  data: unknown,
): { chats: LarkChatSummary[]; hasMore: boolean; pageToken?: string } {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  const rawList = Array.isArray(data)
    ? data
    : Array.isArray(obj?.chats)
      ? obj.chats
      : Array.isArray(obj?.items)
        ? obj.items
        : [];
  const chats: LarkChatSummary[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const chatId = String(rec.chat_id ?? rec.id ?? "").trim();
    if (!chatId || !SAFE_CHAT_ID_RE.test(chatId)) continue;
    const rawMode = String(rec.chat_mode ?? rec.chat_type ?? "group").trim().toLowerCase();
    const chatMode: "group" | "topic" | "p2p" =
      rawMode === "p2p" ? "p2p" : rawMode === "topic" ? "topic" : "group";
    const name = String(rec.name ?? rec.chat_name ?? "").trim() || (chatMode === "p2p" ? "私聊" : chatId);
    chats.push({
      chatId,
      name,
      chatMode,
      ...(typeof rec.p2p_target_id === "string" && rec.p2p_target_id.trim()
        ? { p2pTargetId: rec.p2p_target_id.trim() }
        : {}),
      ...(typeof rec.p2p_target_type === "string" && rec.p2p_target_type.trim()
        ? { p2pTargetType: rec.p2p_target_type.trim() }
        : {}),
      ...(typeof rec.external === "boolean" ? { external: rec.external } : {}),
    });
  }
  const hasMore = Boolean(obj?.has_more);
  const pageToken = typeof obj?.page_token === "string" && obj.page_token.trim() ? obj.page_token.trim() : undefined;
  return { chats, hasMore, ...(pageToken ? { pageToken } : {}) };
}

function parseSingleImMessage(
  entry: unknown,
  defaults?: { chatId?: string; chatName?: string; chatType?: "p2p" | "group" | "topic"; threadId?: string },
): { message?: LarkImMessage; replies: LarkImMessage[]; pendingThreadId?: string } {
  if (!entry || typeof entry !== "object") return { replies: [] };
  const rec = entry as Record<string, unknown>;
  const messageId = String(rec.message_id ?? rec.id ?? "").trim();
  const chatId = String(rec.chat_id ?? defaults?.chatId ?? "").trim();
  if (!messageId || !chatId) return { replies: [] };

  const senderObj =
    rec.sender && typeof rec.sender === "object" && !Array.isArray(rec.sender)
      ? (rec.sender as Record<string, unknown>)
      : undefined;
  const partnerObj =
    rec.chat_partner && typeof rec.chat_partner === "object" && !Array.isArray(rec.chat_partner)
      ? (rec.chat_partner as Record<string, unknown>)
      : undefined;

  const rawChatType = String(rec.chat_type ?? defaults?.chatType ?? "").trim().toLowerCase();
  const chatType: "p2p" | "group" | "topic" | undefined =
    rawChatType === "p2p" ? "p2p" : rawChatType === "topic" ? "topic" : rawChatType === "group" ? "group" : undefined;

  const mentions: LarkMessageMention[] = Array.isArray(rec.mentions)
    ? rec.mentions
        .filter((m): m is Record<string, unknown> => Boolean(m && typeof m === "object"))
        .map((m) => ({
          ...(typeof m.id === "string" ? { id: m.id } : {}),
          ...(typeof m.key === "string" ? { key: m.key } : {}),
          ...(typeof m.name === "string" ? { name: m.name } : {}),
        }))
    : [];

  const createTimeRaw =
    typeof rec.create_time === "string" || typeof rec.create_time === "number" ? rec.create_time : undefined;
  const updateTimeRaw =
    typeof rec.update_time === "string" || typeof rec.update_time === "number" ? rec.update_time : undefined;
  const occurredAt = parseLarkTimestampMs(createTimeRaw);
  const threadId = typeof rec.thread_id === "string" && rec.thread_id.trim() ? rec.thread_id.trim() : defaults?.threadId;
  const replyTo =
    typeof rec.reply_to === "string" && rec.reply_to.trim()
      ? rec.reply_to.trim()
      : typeof rec.parent_id === "string" && rec.parent_id.trim()
        ? rec.parent_id.trim()
        : undefined;
  const messagePosition =
    typeof rec.message_position === "string" || typeof rec.message_position === "number"
      ? String(rec.message_position)
      : undefined;

  const rawContent = typeof rec.content === "string" ? rec.content : rec.content !== undefined ? JSON.stringify(rec.content) : "";
  const message: LarkImMessage = {
    messageId,
    chatId,
    ...(chatType ? { chatType } : {}),
    ...(typeof rec.chat_name === "string" && rec.chat_name.trim()
      ? { chatName: rec.chat_name.trim() }
      : defaults?.chatName
        ? { chatName: defaults.chatName }
        : {}),
    ...(typeof partnerObj?.open_id === "string" ? { chatPartnerId: partnerObj.open_id } : {}),
    ...(typeof partnerObj?.name === "string" ? { chatPartnerName: partnerObj.name } : {}),
    ...(typeof senderObj?.id === "string" ? { senderId: senderObj.id } : {}),
    ...(typeof senderObj?.name === "string" && senderObj.name.trim() ? { senderName: senderObj.name.trim() } : {}),
    ...(typeof senderObj?.sender_type === "string" ? { senderType: senderObj.sender_type } : {}),
    msgType: typeof rec.msg_type === "string" ? rec.msg_type : "text",
    content: rawContent,
    ...(createTimeRaw !== undefined ? { createTimeRaw } : {}),
    ...(updateTimeRaw !== undefined ? { updateTimeRaw } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    deleted: Boolean(rec.deleted),
    updated: Boolean(rec.updated),
    ...(replyTo ? { replyTo } : {}),
    ...(threadId ? { threadId } : {}),
    ...(messagePosition ? { messagePosition } : {}),
    mentions,
  };

  const replies: LarkImMessage[] = [];
  if (Array.isArray(rec.thread_replies)) {
    for (const replyEntry of rec.thread_replies) {
      const parsedReply = parseSingleImMessage(replyEntry, {
        chatId,
        chatName: message.chatName,
        chatType: message.chatType,
        threadId: threadId ?? messageId,
      });
      if (parsedReply.message && parsedReply.message.messageId !== messageId) {
        replies.push(parsedReply.message);
      }
    }
  }
  const pendingThreadId =
    (Boolean(rec.thread_has_more) || Boolean(rec.thread_replies_error)) && threadId ? threadId : undefined;
  return { message, replies, ...(pendingThreadId ? { pendingThreadId } : {}) };
}

export function extractImMessagesFromData(
  data: unknown,
  defaults?: { chatId?: string; chatName?: string; chatType?: "p2p" | "group" | "topic" },
): ParsedImMessagesPage {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  const rawList = Array.isArray(data)
    ? data
    : Array.isArray(obj?.messages)
      ? obj.messages
      : Array.isArray(obj?.items)
        ? obj.items
        : [];
  const messages: LarkImMessage[] = [];
  const seenIds = new Set<string>();
  const pendingThreadIds: string[] = [];

  for (const entry of rawList) {
    const parsed = parseSingleImMessage(entry, defaults);
    if (parsed.message && !seenIds.has(parsed.message.messageId)) {
      seenIds.add(parsed.message.messageId);
      messages.push(parsed.message);
    }
    for (const reply of parsed.replies) {
      if (!seenIds.has(reply.messageId)) {
        seenIds.add(reply.messageId);
        messages.push(reply);
      }
    }
    if (parsed.pendingThreadId && !pendingThreadIds.includes(parsed.pendingThreadId)) {
      pendingThreadIds.push(parsed.pendingThreadId);
    }
  }

  const rawMessageIds = Array.isArray(obj?.message_ids)
    ? obj.message_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const pendingMessageIds = messages.length === 0 && rawMessageIds.length > 0 ? rawMessageIds : [];
  const note = typeof obj?.note === "string" && obj.note.trim() ? obj.note.trim() : undefined;
  const notice = typeof obj?.notice === "string" && obj.notice.trim() ? obj.notice.trim() : undefined;
  const hasMore = Boolean(obj?.has_more);
  const pageToken = typeof obj?.page_token === "string" && obj.page_token.trim() ? obj.page_token.trim() : undefined;
  const partial = pendingMessageIds.length > 0 || pendingThreadIds.length > 0 || Boolean(note) || Boolean(notice);

  return {
    messages,
    hasMore,
    ...(pageToken ? { pageToken } : {}),
    pendingMessageIds,
    pendingThreadIds,
    ...(note ? { note } : {}),
    ...(notice ? { notice } : {}),
    partial,
  };
}

export function buildImConnectorEvent(input: {
  profile: string;
  message: LarkImMessage;
  selfOpenId?: string;
  selfUserName?: string;
  chatDirectory?: ReadonlyMap<string, LarkChatSummary>;
  mutedChatIds?: ReadonlySet<string>;
  backfill?: boolean;
  redact: (s: string) => string;
}): RawConnectorEvent | null {
  const { profile, message, selfOpenId, selfUserName, chatDirectory, mutedChatIds, backfill, redact } = input;
  if (message.msgType === "system") return null;
  if (message.occurredAt === undefined) return null;

  const dirEntry = chatDirectory?.get(message.chatId);
  const chatType = message.chatType ?? dirEntry?.chatMode;
  const direction: AssistantMessageDirection =
    selfOpenId && message.senderId
      ? message.senderId === selfOpenId
        ? "outgoing"
        : "incoming"
      : "unknown";

  const isBotSender = message.senderType === "app" || message.senderType === "bot";
  const mentionsMe = Boolean(
    selfOpenId && message.mentions.some((m) => m.id === selfOpenId),
  );
  const mentionsAll = message.mentions.some(
    (m) => m.id === "all" || m.key === "@_all" || m.name === "所有人" || m.name?.toLowerCase() === "all",
  );
  const mutedChat = Boolean(mutedChatIds?.has(message.chatId) || dirEntry?.muted);

  const chatName =
    message.chatName ||
    dirEntry?.name ||
    message.chatPartnerName ||
    (chatType === "p2p" && direction === "incoming" && message.senderName ? message.senderName : undefined) ||
    (chatType === "p2p" ? "飞书私聊" : message.chatId);

  const senderLabel =
    direction === "outgoing"
      ? `我 (${selfUserName || message.senderName || "本人"})`
      : message.senderName || message.senderId || chatName;

  const subtitle =
    direction === "outgoing"
      ? "本人已回复"
      : isBotSender
        ? "机器人通知"
        : chatType === "p2p"
          ? "私聊"
          : mentionsMe
            ? "群聊 · @你"
            : mentionsAll
              ? "群聊 · @所有人"
              : "群聊";

  const cleanBody = message.deleted ? "" : redact(message.content).trim().slice(0, 1_500);
  const contentHash = createHash("sha256")
    .update(cleanBody.replace(/\s+/g, " ").toLowerCase())
    .digest("hex")
    .slice(0, 12);
  const eventVersion = `v:${message.deleted ? 1 : 0}:${contentHash}`;

  const messageMeta: AssistantMessageMeta = {
    chatId: message.chatId,
    ...(chatType ? { chatType } : {}),
    messageId: message.messageId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.replyTo ? { replyToMessageId: message.replyTo } : {}),
    ...(message.messagePosition ? { messagePosition: message.messagePosition } : {}),
    ...(message.deleted ? { deleted: true } : {}),
    ...(mentionsMe ? { mentionsMe: true } : {}),
    ...(mentionsAll ? { mentionsAll: true } : {}),
    ...(mutedChat ? { mutedChat: true } : {}),
    ...(backfill ? { backfill: true } : {}),
  };

  const event: RawConnectorEvent = {
    nativeEventId: `lark:im:${message.messageId}`,
    eventVersion,
    appId: `lark:${profile}`,
    appLabel: profile === "default" ? "飞书" : `飞书 (${profile})`,
    threadHint: message.chatId,
    sender: redact(senderLabel).slice(0, 200),
    title: redact(chatName).slice(0, 200),
    subtitle,
    body: message.deleted ? "[消息已撤回]" : cleanBody || `[${message.msgType}]`,
    occurredAt: Math.max(0, Math.floor(message.occurredAt)),
    fidelity: "structured",
    direction,
    messageMeta,
  };

  if (!message.deleted && isSensitiveNotificationPayload(event)) return null;
  return event;
}

export function extractSentMessageId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const obj = data as Record<string, unknown>;
  const id = obj.message_id ?? obj.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}
