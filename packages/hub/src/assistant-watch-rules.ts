import {
  MAX_ASSISTANT_WATCH_RULES,
  safeJsonForXmlTag,
  type AssistantQuietHours,
  type AssistantWatchRule,
  type AssistantWatchRuleMode,
} from "@kulo/protocol";
import { isSameAssistantAppFamily } from "./assistant-card-policy.js";
import type { StoredAssistantEvent } from "./assistant-ledger.js";

const MAX_LIST_ITEMS = 12;
const MAX_ITEM_CHARS = 80;
const MAX_LABEL_CHARS = 60;
const MAX_CONDITION_CHARS = 200;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const APP_ALIAS_GROUPS: ReadonlyArray<{ aliases: readonly string[]; canonical: string; bundles: readonly string[] }> = [
  {
    aliases: ["lark", "feishu", "飞书"],
    canonical: "lark:default",
    bundles: ["com.electron.lark", "com.bytedance.feishu", "com.bytedance.lark"],
  },
  {
    aliases: ["spark", "spark mail", "sparkmail", "邮件", "mail"],
    canonical: "com.readdle.SparkDesktop",
    bundles: ["com.readdle.SparkDesktop", "com.readdle.SparkDesktop.appstore", "com.apple.mail"],
  },
  {
    aliases: ["wechat", "weixin", "微信"],
    canonical: "com.tencent.xinWeChat",
    bundles: ["com.tencent.xinWeChat"],
  },
  {
    aliases: ["qq"],
    canonical: "com.tencent.qq",
    bundles: ["com.tencent.qq"],
  },
  {
    aliases: ["ha", "home-assistant", "homeassistant", "智能家居", "米家"],
    canonical: "home-assistant",
    bundles: ["home-assistant"],
  },
  {
    aliases: ["slack"],
    canonical: "com.tinyspeck.slackmacgap",
    bundles: ["com.tinyspeck.slackmacgap"],
  },
  {
    aliases: ["dingtalk", "钉钉"],
    canonical: "com.alibaba.DingTalkMac",
    bundles: ["com.alibaba.DingTalkMac"],
  },
  {
    aliases: ["wecom", "wxwork", "企业微信"],
    canonical: "com.tencent.WeWorkMac",
    bundles: ["com.tencent.WeWorkMac"],
  },
];

function cleanSingleLine(value: string, maxLen: number): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function isAsciiWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isPureAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * Pure character-scan match (zero dynamic RegExp, zero ReDoS):
 * - Short pure-ASCII tokens (< 4 chars) require ASCII word boundaries so "Li" never matches "Client".
 * - Longer tokens and non-ASCII (e.g. Chinese) tokens use case-insensitive substring matching.
 */
export function matchesRuleToken(haystack: string, rawToken: string): boolean {
  const token = rawToken.trim().toLowerCase();
  if (!token) return false;
  const hay = haystack.toLowerCase();
  if (!isPureAscii(token) || token.length >= 4) {
    return hay.includes(token);
  }
  if (token.length < 2) return false;
  let from = 0;
  while (from <= hay.length - token.length) {
    const idx = hay.indexOf(token, from);
    if (idx < 0) return false;
    const before = idx > 0 ? hay[idx - 1] : undefined;
    const after = idx + token.length < hay.length ? hay[idx + token.length] : undefined;
    if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) return true;
    from = idx + 1;
  }
  return false;
}

export function matchesWatchRuleApp(ruleApp: string, eventAppId: string, eventAppLabel?: string): boolean {
  const normRule = ruleApp.trim().toLowerCase();
  const normId = eventAppId.trim().toLowerCase();
  const normLabel = (eventAppLabel ?? "").trim().toLowerCase();
  if (!normRule || !normId) return false;
  if (normRule === normId || isSameAssistantAppFamily(normRule, normId)) return true;
  for (const group of APP_ALIAS_GROUPS) {
    const ruleInGroup =
      group.aliases.includes(normRule) ||
      group.bundles.some((b) => b.toLowerCase() === normRule) ||
      isSameAssistantAppFamily(normRule, group.canonical);
    if (!ruleInGroup) continue;
    if (
      isSameAssistantAppFamily(group.canonical, normId) ||
      group.bundles.some((b) => b.toLowerCase() === normId) ||
      (normLabel && group.aliases.some((alias) => normLabel.includes(alias)))
    ) {
      return true;
    }
  }
  return Boolean(normLabel && matchesRuleToken(normLabel, normRule));
}

export function findMutedAppsConflict(
  ruleApps: readonly string[] | undefined,
  mutedApps: readonly string[] | undefined,
): string[] {
  if (!ruleApps?.length || !mutedApps?.length) return [];
  const conflicts: string[] = [];
  for (const muted of mutedApps) {
    if (ruleApps.some((app) => matchesWatchRuleApp(app, muted, muted))) {
      conflicts.push(muted);
    }
  }
  return [...new Set(conflicts)];
}

export interface WatchRuleEvaluation {
  deterministicMatches: AssistantWatchRule[];
  semanticCandidates: AssistantWatchRule[];
}

export function isWatchRuleActiveAt(rule: AssistantWatchRule, now: number): boolean {
  if (rule.status !== "active") return false;
  if (rule.expiresAt !== undefined && now >= rule.expiresAt) return false;
  return true;
}

function eventMatchesStructuredRuleDimensions(rule: AssistantWatchRule, ev: StoredAssistantEvent): boolean {
  if (rule.apps?.length) {
    if (!rule.apps.some((app) => matchesWatchRuleApp(app, ev.appId, ev.appLabel))) return false;
  }
  if (rule.chatIds?.length) {
    const evChat = (ev.messageMeta?.chatId ?? "").trim().toLowerCase();
    const evThread = (ev.threadHint ?? "").trim().toLowerCase();
    const matchedChat = rule.chatIds.some((id) => {
      const target = id.trim().toLowerCase();
      return Boolean(target && (evChat === target || evThread === target));
    });
    if (!matchedChat) return false;
  }
  if (rule.senders?.length) {
    const senderHaystack = [ev.sender, ev.title, ev.subtitle, ev.threadHint].filter(Boolean).join(" ");
    if (!rule.senders.some((s) => matchesRuleToken(senderHaystack, s))) return false;
  }
  if (rule.keywords?.length) {
    const bodyHaystack = [ev.title, ev.subtitle, ev.body].filter(Boolean).join(" ");
    if (!rule.keywords.some((kw) => matchesRuleToken(bodyHaystack, kw))) return false;
  }
  return true;
}

function hasAnyStructuredDimension(rule: AssistantWatchRule): boolean {
  return Boolean(rule.apps?.length || rule.chatIds?.length || rule.senders?.length || rule.keywords?.length);
}

/**
 * Evaluates active watch rules against incoming events in a coalesced batch.
 * - Ignores user's own outgoing replies, recalled messages, and historical backfill syncs.
 * - Pure structured rules (no `condition`) match deterministically with zero LLM latency.
 * - Hybrid rules (structured filters + `condition`) pre-filter deterministically before injecting as semantic candidates.
 */
export function evaluateWatchRulesForEvents(
  rules: readonly AssistantWatchRule[] | undefined,
  events: readonly StoredAssistantEvent[],
  now = Date.now(),
): WatchRuleEvaluation {
  if (!rules?.length || events.length === 0) {
    return { deterministicMatches: [], semanticCandidates: [] };
  }
  const eligibleEvents = events.filter(
    (ev) => ev.direction !== "outgoing" && !ev.messageMeta?.deleted && !ev.messageMeta?.backfill,
  );
  if (eligibleEvents.length === 0) {
    return { deterministicMatches: [], semanticCandidates: [] };
  }

  const deterministicMatches: AssistantWatchRule[] = [];
  const semanticCandidates: AssistantWatchRule[] = [];

  for (const rule of rules) {
    if (!isWatchRuleActiveAt(rule, now)) continue;
    const hasCondition = Boolean(rule.condition?.trim());
    const hasStructured = hasAnyStructuredDimension(rule);
    if (!hasCondition && !hasStructured) continue;

    if (hasStructured) {
      const matched = eligibleEvents.some((ev) => eventMatchesStructuredRuleDimensions(rule, ev));
      if (!matched) continue;
      if (hasCondition) semanticCandidates.push(rule);
      else deterministicMatches.push(rule);
    } else if (hasCondition) {
      semanticCandidates.push(rule);
    }
  }
  return { deterministicMatches, semanticCandidates };
}

export function formatWatchRulesForPrompt(rules: readonly AssistantWatchRule[]): string {
  if (rules.length === 0) return "";
  const compact = rules.slice(0, MAX_ASSISTANT_WATCH_RULES).map((r) => ({
    id: r.id,
    label: r.label,
    ...(r.apps?.length ? { apps: r.apps } : {}),
    ...(r.senders?.length ? { senders: r.senders } : {}),
    ...(r.keywords?.length ? { keywords: r.keywords } : {}),
    ...(r.condition ? { condition: r.condition } : {}),
  }));
  return [
    "<user_watch_rules>",
    safeJsonForXmlTag(compact),
    "</user_watch_rules>",
  ].join("\n");
}

function parseHhMmToMinutes(raw: string): number | null {
  const m = HHMM_RE.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function resolveLocalMinutes(now: number, timezone?: string): number {
  const format = (tz?: string) =>
    new Intl.DateTimeFormat("en-GB", {
      ...(tz ? { timeZone: tz } : {}),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(now));

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timezone?.trim() || undefined);
  } catch {
    parts = format(undefined);
  }
  const rawHour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const rawMinute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const hour = Number.isFinite(rawHour) ? (rawHour === 24 ? 0 : Math.max(0, Math.min(23, rawHour))) : 0;
  const minute = Number.isFinite(rawMinute) ? Math.max(0, Math.min(59, rawMinute)) : 0;
  return hour * 60 + minute;
}

export function isWithinQuietHours(quietHours: AssistantQuietHours | undefined, now = Date.now()): boolean {
  if (!quietHours?.enabled) return false;
  const startMin = parseHhMmToMinutes(quietHours.start);
  const endMin = parseHhMmToMinutes(quietHours.end);
  if (startMin === null || endMin === null || startMin === endMin) return false;
  const current = resolveLocalMinutes(now, quietHours.timezone);
  if (startMin < endMin) {
    return current >= startMin && current < endMin;
  }
  // Overnight span (e.g. 23:00 -> 08:00)
  return current >= startMin || current < endMin;
}

function sanitizeTokenList(
  raw: readonly string[] | undefined,
  redact: (text: string) => string,
  options: { requireMinAsciiLen?: boolean } = {},
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = cleanSingleLine(redact(item), MAX_ITEM_CHARS);
    if (!cleaned) continue;
    if (options.requireMinAsciiLen && isPureAscii(cleaned) && cleaned.length < 2) {
      throw new Error(`匹配词「${cleaned}」过短（英文/数字至少 2 个字符），请使用更具体的名称或关键词。`);
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out.length > 0 ? out : undefined;
}

export interface SanitizedWatchRuleDraft {
  label: string;
  mode: AssistantWatchRuleMode;
  apps?: string[];
  senders?: string[];
  keywords?: string[];
  chatIds?: string[];
  condition?: string;
  targetTopicId?: string;
  expiresAt?: number;
}

export function sanitizeWatchRuleInput(
  input: {
    label?: string;
    mode?: string;
    apps?: readonly string[];
    senders?: readonly string[];
    keywords?: readonly string[];
    chatIds?: readonly string[];
    condition?: string;
    targetTopicId?: string;
    expiresInHours?: number;
    expiresAt?: number;
  },
  redact: (text: string) => string,
  now = Date.now(),
): SanitizedWatchRuleDraft {
  const label = cleanSingleLine(redact(input.label ?? ""), MAX_LABEL_CHARS);
  if (!label) throw new Error("关注规则需要提供简明名称 label。");
  const mode: AssistantWatchRuleMode = input.mode === "continuous" ? "continuous" : "once";
  const apps = sanitizeTokenList(input.apps, redact);
  const senders = sanitizeTokenList(input.senders, redact, { requireMinAsciiLen: true });
  const keywords = sanitizeTokenList(input.keywords, redact, { requireMinAsciiLen: true });
  const chatIds = sanitizeTokenList(input.chatIds, redact);
  const condition = typeof input.condition === "string"
    ? cleanSingleLine(redact(input.condition), MAX_CONDITION_CHARS) || undefined
    : undefined;
  if (!apps?.length && !senders?.length && !keywords?.length && !chatIds?.length && !condition) {
    throw new Error("关注规则至少需要指定应用、发送人、关键词、会话 ID 或语义条件中的一项。");
  }
  let expiresAt: number | undefined;
  if (typeof input.expiresInHours === "number" && Number.isFinite(input.expiresInHours)) {
    if (input.expiresInHours <= 0 || input.expiresInHours > 24 * 90) {
      throw new Error("有效期 expires_in_hours 需在 0 至 2160 小时（90 天）之间。");
    }
    expiresAt = now + Math.round(input.expiresInHours * 3_600_000);
  } else if (typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt) && input.expiresAt > now) {
    expiresAt = Math.round(input.expiresAt);
  }
  const targetTopicId = typeof input.targetTopicId === "string" && input.targetTopicId.trim() && input.targetTopicId.trim() !== "root"
    ? input.targetTopicId.trim().slice(0, 120)
    : undefined;
  return {
    label,
    mode,
    ...(apps ? { apps } : {}),
    ...(senders ? { senders } : {}),
    ...(keywords ? { keywords } : {}),
    ...(chatIds ? { chatIds } : {}),
    ...(condition ? { condition } : {}),
    ...(targetTopicId ? { targetTopicId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export function sanitizeQuietHoursInput(input: {
  enabled: boolean;
  start?: string;
  end?: string;
  timezone?: string;
  allowWatchRules?: boolean;
}): AssistantQuietHours {
  if (!input.enabled) {
    return {
      enabled: false,
      start: input.start && HHMM_RE.test(input.start.trim()) ? input.start.trim() : "23:00",
      end: input.end && HHMM_RE.test(input.end.trim()) ? input.end.trim() : "08:00",
      ...(input.timezone?.trim() ? { timezone: input.timezone.trim().slice(0, 80) } : {}),
      ...(input.allowWatchRules !== undefined ? { allowWatchRules: Boolean(input.allowWatchRules) } : {}),
    };
  }
  const start = (input.start ?? "").trim();
  const end = (input.end ?? "").trim();
  if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
    throw new Error("安静时段 start 与 end 必须使用 24 小时制 HH:MM 格式（例如 23:00 与 08:00）。");
  }
  if (start === end) {
    throw new Error("安静时段开始时间与结束时间不能相同。");
  }
  let timezone: string | undefined;
  if (typeof input.timezone === "string" && input.timezone.trim()) {
    const candidate = input.timezone.trim().slice(0, 80);
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: candidate });
      timezone = candidate;
    } catch {
      throw new Error(`无效的 IANA 时区名称：${candidate}`);
    }
  }
  return {
    enabled: true,
    start,
    end,
    ...(timezone ? { timezone } : {}),
    allowWatchRules: input.allowWatchRules === true,
  };
}
