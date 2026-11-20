import { isOneTimeCodeText } from "./assistant.js";

export interface AndroidNotificationDecision {
  action: "retain" | "clear" | "collect" | "notify";
  title?: string;
  text?: string;
  groupKey?: string;
  important?: boolean;
  advertisement?: boolean;
  repeatMinutes?: number;
  clearAfterHours?: number;
}

export interface AndroidNotificationClassification {
  version: 1;
  requestId: string;
  bindingId: string;
  hubId: string;
  deviceId: string;
  ruleRevision: number;
  notificationId: string;
  notificationVersion: string;
  ruleText: string;
  defaultRule: boolean;
  notification: {
    packageName: string; appName: string; title: string; text: string; subtext: string;
    postedAtMs: number; channelId: string; category: string;
    ongoing: boolean; clearable: boolean; groupSummary: boolean;
  };
}

export interface AndroidNotificationClassificationResult {
  version: 1;
  requestId: string;
  bindingId: string;
  hubId: string;
  deviceId: string;
  ruleRevision: number;
  notificationId: string;
  notificationVersion: string;
  decisionId: string;
  decision?: AndroidNotificationDecision;
  error?: string;
}

const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum && !value.includes("\0");
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const identityKeys = ["version", "requestId", "bindingId", "hubId", "deviceId", "ruleRevision", "notificationId", "notificationVersion"];
function identity(value: Record<string, unknown>): boolean {
  return value.version === 1 && id(value.requestId) && id(value.bindingId) && id(value.hubId) && id(value.deviceId)
    && integer(value.ruleRevision) && hash(value.notificationId) && hash(value.notificationVersion);
}

export function isAndroidNotificationDecision(value: unknown): value is AndroidNotificationDecision {
  if (!object(value) || !only(value, ["action", "title", "text", "groupKey", "important", "advertisement", "repeatMinutes", "clearAfterHours"]) ||
      !["retain", "clear", "collect", "notify"].includes(String(value.action))) return false;
  for (const key of ["title", "text", "groupKey"]) if (value[key] !== undefined && !text(value[key], key === "text" ? 1000 : 160)) return false;
  for (const key of ["important", "advertisement"]) if (value[key] !== undefined && (typeof value[key] !== "boolean" ||
    value[key] === true && value.action !== (key === "important" ? "retain" : "clear"))) return false;
  return (value.repeatMinutes === undefined || integer(value.repeatMinutes) && value.repeatMinutes <= 1440) &&
    (value.clearAfterHours === undefined || integer(value.clearAfterHours) && value.clearAfterHours <= 720);
}

export function isAndroidNotificationClassification(value: unknown): value is AndroidNotificationClassification {
  if (!object(value) || !only(value, [...identityKeys, "ruleText", "defaultRule", "notification"]) || !identity(value) ||
    !text(value.ruleText, 24_000) || !value.ruleText.trim() || typeof value.defaultRule !== "boolean" || !object(value.notification)) return false;
  const item = value.notification;
  if (!only(item, ["packageName", "appName", "title", "text", "subtext", "postedAtMs", "channelId", "category", "ongoing", "clearable", "groupSummary"]) ||
    !text(item.packageName, 255) || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(item.packageName) ||
    !text(item.appName, 255) || !text(item.title, 1000) || !text(item.text, 4000) || !text(item.subtext, 1000) ||
    !integer(item.postedAtMs) || !text(item.channelId, 255) || !text(item.category, 80) ||
    typeof item.ongoing !== "boolean" || typeof item.clearable !== "boolean" || typeof item.groupSummary !== "boolean") return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= 128 * 1024; } catch { return false; }
}

export function isProtectedAndroidNotification(item: AndroidNotificationClassification["notification"]): boolean {
  return item.ongoing || !item.clearable || item.groupSummary ||
    ["call", "alarm", "service", "sys", "navigation", "transport", "emergency"].includes(item.category) ||
    /^(?:android|com\.android\.(?:systemui|phone|server\.telecom|permissioncontroller|settings)|com\.google\.android\.permissioncontroller|com\.miui\.securitycenter|io\.kulo\.app(?:\.dev)?)$/.test(item.packageName) ||
    isOneTimeCodeText(`${item.title}\n${item.text}\n${item.subtext}`);
}

export function isAndroidNotificationClassificationResult(value: unknown, request?: AndroidNotificationClassification): value is AndroidNotificationClassificationResult {
  if (!object(value) || !only(value, [...identityKeys, "decisionId", "decision", "error"]) || !identity(value) || !id(value.decisionId) ||
    (value.decision === undefined) === (value.error === undefined) ||
    value.decision !== undefined && !isAndroidNotificationDecision(value.decision) || value.error !== undefined && !id(value.error)) return false;
  return !request || identityKeys.every(key => value[key] === (request as unknown as Record<string, unknown>)[key]);
}
