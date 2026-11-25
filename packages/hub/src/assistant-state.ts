import { randomUUID } from "node:crypto";
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import {
  compareAssistantItems,
  defaultAssistantItemTtlMs,
  isAssistantDecisionItem,
  isAssistantItemExpired,
  MAX_ASSISTANT_WATCH_RULES,
  type AmbientLocalEngine,
  type AssistantDismissTarget,
  type AssistantItemKind,
  type AssistantItemView,
  type AssistantPendingAction,
  type AssistantQuietHours,
  type AssistantWatchRule,
  type AssistantWatchRuleStatus,
  type HomeAssistantAnnounceConfig,
  type HomeAssistantSentinelConfig,
} from "@kulo/protocol";

export type AssistantSituationRecord = {
  id: string;
  key: string;
  title: string;
  sourceApp: string;
  sourceLabel: string;
  status: "open" | "resolved" | "dismissed";
  linkedTopicId?: string;
  snapshotRef?: string;
  lastEscalatedAt?: number;
  lastWokenAt?: number;
  updatedAt: number;
};

export type AssistantBackgroundModelPersisted = {
  mode: "auto" | "local-managed" | "kulo-provider";
  engine?: AmbientLocalEngine;
  modelId?: string;
  providerId?: string;
  port?: number;
  revision: number;
};

export type AssistantDurableState = {
  revision: number;
  enabled: boolean;
  mutedApps: string[];
  backgroundModel: AssistantBackgroundModelPersisted;
  spark?: { enabled: boolean };
  homeAssistant?: {
    enabled: boolean;
    baseUrl?: string;
    sentinel?: HomeAssistantSentinelConfig;
    announce?: HomeAssistantAnnounceConfig;
  };
  lark?: { enabled: boolean; selectedProfiles: string[] };
  watchRules?: AssistantWatchRule[];
  quietHours?: AssistantQuietHours;
  assistantRevision: number;
  situations: Record<string, AssistantSituationRecord>;
  items: AssistantItemView[];
};

/**
 * Checks whether the specific source app/connector is enabled in AssistantDoc so Home Assistant
 * and Lark alerts still work when macOS Notification Center capture (`doc.enabled`) is off.
 */
export function isAssistantSourceEnabled(
  doc: Readonly<AssistantDurableState> | undefined,
  appId: string,
): boolean {
  if (!doc) return false;
  if (appId === "home-assistant") return Boolean(doc.homeAssistant?.enabled);
  if (appId.startsWith("lark:")) return Boolean(doc.lark?.enabled);
  const norm = appId.trim().toLowerCase();
  if (norm === "com.readdle.sparkdesktop" || norm === "com.readdle.sparkdesktop.appstore") {
    return Boolean(doc.spark?.enabled || doc.enabled);
  }
  return Boolean(doc.enabled);
}

export const MAX_ACTIVE_ITEMS = 12;
export const MAX_ACTIVE_FYI_ITEMS = 4;
export const MAX_FYI_PER_APP = 2;
const MAX_SITUATIONS = 200;

export const AssistantDoc = defineDoc<AssistantDurableState & JsonObject>({
  kind: "kulo.assistant",
  version: 1,
  scope: "session",
  initial: (): AssistantDurableState & JsonObject =>
    ({
      revision: 1,
      enabled: false,
      mutedApps: [],
      backgroundModel: {
        mode: "auto",
        revision: 1,
      },
      assistantRevision: 1,
      situations: {},
      items: [],
    }) as unknown as AssistantDurableState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

export function ensureAssistantState(doc: AssistantDurableState): void {
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) doc.revision = 1;
  if (typeof doc.enabled !== "boolean") doc.enabled = false;
  if (!Array.isArray(doc.mutedApps)) doc.mutedApps = [];
  if (!doc.backgroundModel || typeof doc.backgroundModel !== "object") {
    doc.backgroundModel = { mode: "auto", revision: 1 };
  }
  if (!Number.isSafeInteger(doc.backgroundModel.revision) || doc.backgroundModel.revision < 1) {
    doc.backgroundModel.revision = 1;
  }
  if (!Number.isSafeInteger(doc.assistantRevision) || doc.assistantRevision < 1) doc.assistantRevision = 1;
  if (!doc.situations || typeof doc.situations !== "object") doc.situations = {};
  if (!Array.isArray(doc.items)) doc.items = [];
}

export function selectActiveAssistantItems(
  items: readonly AssistantItemView[] | undefined,
  now = Date.now(),
): AssistantItemView[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const active = items.filter((item) => !isAssistantItemExpired(item, now)).sort(compareAssistantItems);
  return JSON.parse(JSON.stringify(active)) as AssistantItemView[];
}

export function findSituationByKey(
  doc: Readonly<AssistantDurableState>,
  key: string,
): AssistantSituationRecord | undefined {
  for (const situation of Object.values(doc.situations)) {
    if (situation.key === key) return situation;
  }
  return undefined;
}

export function pruneAssistantSituations(doc: AssistantDurableState): void {
  const entries = Object.values(doc.situations);
  if (entries.length <= MAX_SITUATIONS) return;
  const activeSituationIds = new Set(doc.items.map((item) => item.situationId));
  entries
    .filter((entry) => !activeSituationIds.has(entry.id))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, entries.length - MAX_SITUATIONS)
    .forEach((entry) => {
      delete doc.situations[entry.id];
    });
}

function markOpenSituationResolved(doc: AssistantDurableState, situationId: string, now: number): void {
  const sit = doc.situations[situationId];
  if (sit && sit.status === "open") {
    sit.status = "resolved";
    sit.updatedAt = now;
  }
}

/**
 * Strips expired non-decision items without bumping `assistantRevision` so callers can combine
 * expiry cleanup with a card mutation in a single revision increment.
 */
export function stripExpiredAssistantItemsInDoc(
  doc: AssistantDurableState,
  now: number,
  options: { excludeSituationId?: string } = {},
): number {
  ensureAssistantState(doc);
  if (doc.items.length === 0) return 0;
  let removed = 0;
  const kept: AssistantItemView[] = [];
  for (const item of doc.items) {
    if (item.situationId !== options.excludeSituationId && isAssistantItemExpired(item, now)) {
      removed += 1;
      markOpenSituationResolved(doc, item.situationId, now);
      continue;
    }
    kept.push(item);
  }
  if (removed > 0) doc.items = kept;
  return removed;
}

export function pruneExpiredAssistantItemsInDoc(doc: AssistantDurableState, now: number): number {
  const removed = stripExpiredAssistantItemsInDoc(doc, now);
  if (removed > 0) {
    doc.assistantRevision += 1;
    pruneAssistantSituations(doc);
  }
  return removed;
}

function evictOldestCandidate(
  doc: AssistantDurableState,
  predicate: (item: AssistantItemView) => boolean,
  now: number,
): boolean {
  let oldestIdx = -1;
  for (let i = 0; i < doc.items.length; i += 1) {
    const candidate = doc.items[i]!;
    if (!predicate(candidate)) continue;
    if (
      oldestIdx < 0 ||
      candidate.updatedAt < doc.items[oldestIdx]!.updatedAt ||
      (candidate.updatedAt === doc.items[oldestIdx]!.updatedAt && candidate.id.localeCompare(doc.items[oldestIdx]!.id) > 0)
    ) {
      oldestIdx = i;
    }
  }
  if (oldestIdx < 0) return false;
  const [evicted] = doc.items.splice(oldestIdx, 1);
  if (evicted) markOpenSituationResolved(doc, evicted.situationId, now);
  return true;
}

export function upsertAssistantCardInDoc(
  doc: AssistantDurableState,
  input: {
    situationId: string;
    situationKey: string;
    kind: AssistantItemKind;
    sourceApp: string;
    sourceLabel: string;
    envName?: string;
    title: string;
    summary: string;
    primaryActionLabel?: string;
    pendingAction?: AssistantPendingAction;
    linkedTopicId?: string;
    snapshotRef?: string;
    lastWokenAt?: number;
    expiresAt?: number;
    now: number;
  },
): AssistantItemView {
  ensureAssistantState(doc);
  const incomingIsDecision = input.kind === "decision" || Boolean(input.pendingAction);
  const preExisting = doc.items.find((item) => item.situationId === input.situationId);
  // Hard L2 invariant: passive background events may never overwrite or mutate an active decision card.
  if (preExisting && isAssistantDecisionItem(preExisting) && !incomingIsDecision) {
    return preExisting;
  }

  stripExpiredAssistantItemsInDoc(doc, input.now, { excludeSituationId: input.situationId });

  const existingSituation = doc.situations[input.situationId];
  const resolvedLinkedTopicId = input.linkedTopicId ?? existingSituation?.linkedTopicId;
  const resolvedSnapshotRef = input.snapshotRef ?? existingSituation?.snapshotRef;
  const resolvedLastWokenAt = input.lastWokenAt ?? existingSituation?.lastWokenAt;
  doc.situations[input.situationId] = {
    id: input.situationId,
    key: input.situationKey,
    title: input.title.slice(0, 120),
    sourceApp: input.sourceApp,
    sourceLabel: input.sourceLabel,
    status: "open",
    ...(resolvedLinkedTopicId ? { linkedTopicId: resolvedLinkedTopicId } : {}),
    ...(resolvedSnapshotRef ? { snapshotRef: resolvedSnapshotRef } : {}),
    lastEscalatedAt: input.now,
    ...(resolvedLastWokenAt !== undefined ? { lastWokenAt: resolvedLastWokenAt } : {}),
    updatedAt: input.now,
  };

  const cleanPending = input.pendingAction
    ? (JSON.parse(JSON.stringify(input.pendingAction)) as AssistantPendingAction)
    : undefined;
  const existingIdx = doc.items.findIndex((item) => item.situationId === input.situationId);
  const ttlMs = incomingIsDecision ? undefined : defaultAssistantItemTtlMs(input.kind, input.sourceApp);
  const resolvedExpiresAt = incomingIsDecision
    ? undefined
    : (input.expiresAt !== undefined ? input.expiresAt : (ttlMs !== undefined ? input.now + ttlMs : undefined));

  let card: AssistantItemView;
  if (existingIdx >= 0) {
    const prev = doc.items[existingIdx]!;
    const { expiresAt: _oldExp, ...prevBase } = prev;
    const prevLocked =
      prev.pendingAction?.executionState === "dispatched" ||
      prev.pendingAction?.executionState === "unknown";
    const nextPending = prevLocked ? prev.pendingAction : (cleanPending ?? prev.pendingAction);
    const nextIsDecision = input.kind === "decision" || Boolean(nextPending);
    card = {
      ...prevBase,
      revision: prev.revision + 1,
      kind: nextIsDecision ? "decision" : input.kind,
      sourceApp: input.sourceApp,
      sourceLabel: input.sourceLabel,
      ...(input.envName ? { envName: input.envName } : {}),
      title: input.title.slice(0, 120),
      summary: input.summary.slice(0, 400),
      ...(input.primaryActionLabel ? { primaryActionLabel: input.primaryActionLabel.slice(0, 40) } : {}),
      ...(nextPending ? { pendingAction: nextPending } : {}),
      ...(input.linkedTopicId ?? prev.linkedTopicId ? { linkedTopicId: input.linkedTopicId ?? prev.linkedTopicId } : {}),
      updatedAt: input.now,
      ...(!nextIsDecision && resolvedExpiresAt !== undefined ? { expiresAt: resolvedExpiresAt } : {}),
    };
    doc.items.splice(existingIdx, 1);
    doc.items.unshift(card);
  } else {
    card = {
      id: `asst-${input.situationId}`,
      revision: 1,
      situationId: input.situationId,
      kind: incomingIsDecision ? "decision" : input.kind,
      sourceApp: input.sourceApp,
      sourceLabel: input.sourceLabel,
      ...(input.envName ? { envName: input.envName } : {}),
      title: input.title.slice(0, 120),
      summary: input.summary.slice(0, 400),
      ...(input.primaryActionLabel ? { primaryActionLabel: input.primaryActionLabel.slice(0, 40) } : {}),
      ...(cleanPending ? { pendingAction: cleanPending } : {}),
      ...(input.linkedTopicId ? { linkedTopicId: input.linkedTopicId } : {}),
      createdAt: input.now,
      updatedAt: input.now,
      ...(!incomingIsDecision && resolvedExpiresAt !== undefined ? { expiresAt: resolvedExpiresAt } : {}),
    };
    doc.items.unshift(card);
  }

  // Enforce per-app and global FYI budgets for non-HA passive cards without evicting the freshly written card.
  const isPassiveFyi = (item: AssistantItemView) =>
    !isAssistantDecisionItem(item) && item.kind === "fyi" && item.sourceApp !== "home-assistant";
  if (isPassiveFyi(card)) {
    while (doc.items.filter((item) => isPassiveFyi(item) && item.sourceApp === card.sourceApp).length > MAX_FYI_PER_APP) {
      if (!evictOldestCandidate(doc, (item) => isPassiveFyi(item) && item.sourceApp === card.sourceApp && item.id !== card.id, input.now)) {
        break;
      }
    }
    while (doc.items.filter(isPassiveFyi).length > MAX_ACTIVE_FYI_ITEMS) {
      if (!evictOldestCandidate(doc, (item) => isPassiveFyi(item) && item.id !== card.id, input.now)) {
        break;
      }
    }
  }

  doc.items.sort(compareAssistantItems);

  // Global cap preserves ALL L2 decision cards and trims lowest-priority passive items from the tail.
  while (doc.items.length > MAX_ACTIVE_ITEMS) {
    let evictIdx = -1;
    for (let i = doc.items.length - 1; i >= 0; i -= 1) {
      const candidate = doc.items[i]!;
      if (!isAssistantDecisionItem(candidate) && candidate.id !== card.id) {
        evictIdx = i;
        break;
      }
    }
    if (evictIdx < 0) {
      for (let i = doc.items.length - 1; i >= 0; i -= 1) {
        if (!isAssistantDecisionItem(doc.items[i]!)) {
          evictIdx = i;
          break;
        }
      }
    }
    if (evictIdx < 0) break;
    const [evicted] = doc.items.splice(evictIdx, 1);
    if (evicted) markOpenSituationResolved(doc, evicted.situationId, input.now);
  }

  doc.assistantRevision += 1;
  pruneAssistantSituations(doc);
  return card;
}

export function muteAssistantAppInDoc(
  doc: AssistantDurableState,
  mutedApp: string,
  now: number,
  options: { skipAssistantRevisionBump?: boolean } = {},
): { mutedAdded: boolean; removedCount: number } {
  ensureAssistantState(doc);
  const clean = mutedApp.trim();
  if (!clean || clean.length > 255) return { mutedAdded: false, removedCount: 0 };
  let mutedAdded = false;
  if (!doc.mutedApps.includes(clean)) {
    doc.mutedApps = [...doc.mutedApps, clean].slice(0, 256);
    doc.revision += 1;
    mutedAdded = true;
  }
  let removedCount = 0;
  doc.items = doc.items.filter((item) => {
    if (item.sourceApp !== clean || isAssistantDecisionItem(item)) return true;
    removedCount += 1;
    const sit = doc.situations[item.situationId];
    if (sit) {
      sit.status = "dismissed";
      sit.updatedAt = now;
    }
    return false;
  });
  if (removedCount > 0 && !options.skipAssistantRevisionBump) {
    doc.assistantRevision += 1;
  }
  return { mutedAdded, removedCount };
}

export function dismissAssistantItemInDoc(
  doc: AssistantDurableState,
  itemId: string,
  expectedRevision: number,
  options: { muteApp?: boolean; now: number },
): { removed: AssistantItemView; mutedApp?: string } | { conflict: true } | { missing: true } {
  ensureAssistantState(doc);
  const idx = doc.items.findIndex((item) => item.id === itemId);
  if (idx < 0) return { missing: true };
  const target = doc.items[idx]!;
  if (target.revision !== expectedRevision) return { conflict: true };
  doc.items.splice(idx, 1);
  const sit = doc.situations[target.situationId];
  if (sit) {
    sit.status = "dismissed";
    sit.updatedAt = options.now;
  }
  let mutedApp: string | undefined;
  if (options.muteApp && target.sourceApp) {
    mutedApp = target.sourceApp;
    muteAssistantAppInDoc(doc, mutedApp, options.now, { skipAssistantRevisionBump: true });
  }
  doc.assistantRevision += 1;
  return { removed: target, ...(mutedApp ? { mutedApp } : {}) };
}

export function dismissAssistantItemsInDoc(
  doc: AssistantDurableState,
  targets: readonly AssistantDismissTarget[],
  now: number,
): { dismissedIds: string[]; skippedIds: string[]; expiredCount: number; changed: boolean } {
  ensureAssistantState(doc);
  const expiredCount = stripExpiredAssistantItemsInDoc(doc, now);
  const dismissedIds: string[] = [];
  const skippedIds: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    const idx = doc.items.findIndex((item) => item.id === target.id);
    if (idx < 0) continue;
    const item = doc.items[idx]!;
    if (
      isAssistantDecisionItem(item) ||
      item.revision !== target.expectedRevision ||
      item.updatedAt !== target.expectedUpdatedAt
    ) {
      skippedIds.push(target.id);
      continue;
    }
    doc.items.splice(idx, 1);
    const sit = doc.situations[item.situationId];
    if (sit) {
      sit.status = "dismissed";
      sit.updatedAt = now;
    }
    dismissedIds.push(item.id);
  }
  const changed = dismissedIds.length > 0 || expiredCount > 0;
  if (changed) {
    doc.assistantRevision += 1;
    pruneAssistantSituations(doc);
  }
  return { dismissedIds, skippedIds, expiredCount, changed };
}

export function resolveAssistantItemInDoc(
  doc: AssistantDurableState,
  predicate: (item: AssistantItemView) => boolean,
  now: number,
): AssistantItemView | null {
  ensureAssistantState(doc);
  const idx = doc.items.findIndex(predicate);
  if (idx < 0) return null;
  const match = doc.items[idx]!;
  if (isAssistantDecisionItem(match)) return null;
  doc.items.splice(idx, 1);
  const sit = doc.situations[match.situationId];
  if (sit) {
    sit.status = "resolved";
    sit.updatedAt = now;
  }
  doc.assistantRevision += 1;
  return match;
}

export function reconcileDispatchedActionsInDoc(doc: AssistantDurableState, now: number): number {
  ensureAssistantState(doc);
  let count = 0;
  for (const item of doc.items) {
    if (item.pendingAction?.executionState !== "dispatched") continue;
    item.pendingAction.executionState = "unknown";
    item.pendingAction.lastError = "服务重启或切换期间操作状态未决，请先在目标应用核对实际结果后再收起。";
    item.revision += 1;
    item.updatedAt = now;
    count += 1;
  }
  if (count > 0) doc.assistantRevision += 1;
  return count;
}

export function claimPendingActionInDoc(
  doc: AssistantDurableState,
  itemId: string,
  expectedRevision: number,
  now: number,
): AssistantPendingAction {
  ensureAssistantState(doc);
  const item = doc.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw Object.assign(new Error("待确认事项已不存在或已处理。"), { code: "assistant_item_not_found", status: 404 });
  }
  if (item.revision !== expectedRevision) {
    throw Object.assign(new Error("提醒卡片已更新，请刷新后重试。"), { code: "assistant_item_conflict", status: 409 });
  }
  if (!item.pendingAction) {
    throw Object.assign(new Error("此卡片没有可执行的一键确认动作。"), { code: "assistant_action_missing", status: 400 });
  }
  if (item.pendingAction.executionState === "dispatched") {
    throw Object.assign(new Error("该动作正在执行中，请稍候。"), { code: "action_in_flight", status: 409 });
  }
  if (item.pendingAction.executionState === "unknown") {
    throw Object.assign(
      new Error("该动作已发出但未确认结果，请核对目标应用后点击收起，不可重复执行。"),
      { code: "action_outcome_unknown", status: 409 },
    );
  }
  item.pendingAction.executionState = "dispatched";
  item.pendingAction.dispatchedAt = now;
  delete item.pendingAction.lastError;
  item.revision += 1;
  item.updatedAt = now;
  doc.assistantRevision += 1;
  return JSON.parse(JSON.stringify(item.pendingAction)) as AssistantPendingAction;
}

export function updatePendingActionFailureInDoc(
  doc: AssistantDurableState,
  itemId: string,
  nextState: "none" | "unknown",
  safeError: string,
  now: number,
): void {
  ensureAssistantState(doc);
  const item = doc.items.find((candidate) => candidate.id === itemId);
  if (!item?.pendingAction) return;
  item.pendingAction.executionState = nextState;
  if (nextState === "none") delete item.pendingAction.dispatchedAt;
  item.pendingAction.lastError = safeError;
  item.revision += 1;
  item.updatedAt = now;
  doc.assistantRevision += 1;
}

export function finalizePendingActionInDoc(doc: AssistantDurableState, itemId: string, now: number): void {
  ensureAssistantState(doc);
  const idx = doc.items.findIndex((candidate) => candidate.id === itemId);
  if (idx < 0) return;
  const removed = doc.items[idx]!;
  doc.items.splice(idx, 1);
  const sit = doc.situations[removed.situationId];
  if (sit) {
    sit.status = "resolved";
    sit.updatedAt = now;
  }
  doc.assistantRevision += 1;
}

export function listEffectiveWatchRules(
  rules: readonly AssistantWatchRule[] | undefined,
  now = Date.now(),
): AssistantWatchRule[] {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  return rules.map((rule) => {
    const expired = rule.status === "active" && rule.expiresAt !== undefined && now >= rule.expiresAt;
    return JSON.parse(JSON.stringify(expired ? { ...rule, status: "expired" as AssistantWatchRuleStatus } : rule)) as AssistantWatchRule;
  });
}

export function createWatchRuleInDoc(
  doc: AssistantDurableState,
  draft: Omit<AssistantWatchRule, "id" | "status" | "createdAt" | "updatedAt">,
  now: number,
): AssistantWatchRule {
  ensureAssistantState(doc);
  const rules = Array.isArray(doc.watchRules) ? [...doc.watchRules] : [];
  for (const r of rules) {
    if (r.status === "active" && r.expiresAt !== undefined && now >= r.expiresAt) {
      r.status = "expired";
      r.updatedAt = now;
    }
  }
  const activeCount = rules.filter((r) => r.status === "active" || r.status === "paused").length;
  if (activeCount >= MAX_ASSISTANT_WATCH_RULES) {
    throw new Error(`关注规则已达上限（${MAX_ASSISTANT_WATCH_RULES} 条），请先删除或清理不再需要的规则。`);
  }
  // Evict oldest terminal (triggered/expired) rules if total exceeds cap.
  while (rules.length >= MAX_ASSISTANT_WATCH_RULES) {
    const idx = rules.findIndex((r) => r.status === "triggered" || r.status === "expired");
    if (idx < 0) break;
    rules.splice(idx, 1);
  }
  const rule: AssistantWatchRule = {
    id: `watch-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    ...draft,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  rules.unshift(rule);
  doc.watchRules = rules;
  doc.revision += 1;
  return JSON.parse(JSON.stringify(rule)) as AssistantWatchRule;
}

export function updateWatchRuleInDoc(
  doc: AssistantDurableState,
  ruleId: string,
  patch: Partial<Pick<AssistantWatchRule, "label" | "mode" | "status" | "apps" | "senders" | "keywords" | "chatIds" | "condition" | "targetTopicId" | "expiresAt">>,
  now: number,
): AssistantWatchRule | null {
  ensureAssistantState(doc);
  if (!Array.isArray(doc.watchRules)) return null;
  const target = doc.watchRules.find((r) => r.id === ruleId);
  if (!target) return null;
  if (patch.label !== undefined) target.label = patch.label;
  if (patch.mode !== undefined) target.mode = patch.mode;
  if (patch.status !== undefined) target.status = patch.status;
  if ("apps" in patch) {
    if (patch.apps?.length) target.apps = [...patch.apps];
    else delete target.apps;
  }
  if ("senders" in patch) {
    if (patch.senders?.length) target.senders = [...patch.senders];
    else delete target.senders;
  }
  if ("keywords" in patch) {
    if (patch.keywords?.length) target.keywords = [...patch.keywords];
    else delete target.keywords;
  }
  if ("chatIds" in patch) {
    if (patch.chatIds?.length) target.chatIds = [...patch.chatIds];
    else delete target.chatIds;
  }
  if ("condition" in patch) {
    if (patch.condition) target.condition = patch.condition;
    else delete target.condition;
  }
  if ("targetTopicId" in patch) {
    if (patch.targetTopicId && patch.targetTopicId !== "root") target.targetTopicId = patch.targetTopicId;
    else delete target.targetTopicId;
  }
  if ("expiresAt" in patch) {
    if (patch.expiresAt !== undefined) target.expiresAt = patch.expiresAt;
    else delete target.expiresAt;
  }
  target.updatedAt = now;
  doc.revision += 1;
  return JSON.parse(JSON.stringify(target)) as AssistantWatchRule;
}

export function deleteWatchRuleInDoc(doc: AssistantDurableState, ruleId: string): boolean {
  ensureAssistantState(doc);
  if (!Array.isArray(doc.watchRules)) return false;
  const idx = doc.watchRules.findIndex((r) => r.id === ruleId);
  if (idx < 0) return false;
  doc.watchRules.splice(idx, 1);
  doc.revision += 1;
  return true;
}

export function setQuietHoursInDoc(doc: AssistantDurableState, quietHours: AssistantQuietHours): AssistantQuietHours {
  ensureAssistantState(doc);
  doc.quietHours = JSON.parse(JSON.stringify(quietHours)) as AssistantQuietHours;
  doc.revision += 1;
  return JSON.parse(JSON.stringify(doc.quietHours)) as AssistantQuietHours;
}

/**
 * Atomically marks matched watch rules as triggered (only called when the alert actually surfaced
 * to the user via proactive chat wake or immediate system notification fallback).
 * `mode === "once"` rules transition to `status = "triggered"`.
 */
export function recordWatchRulesTriggeredInDoc(
  doc: AssistantDurableState,
  ruleIds: readonly string[],
  now: number,
): string[] {
  ensureAssistantState(doc);
  if (!Array.isArray(doc.watchRules) || ruleIds.length === 0) return [];
  const idSet = new Set(ruleIds);
  const updated: string[] = [];
  for (const rule of doc.watchRules) {
    if (!idSet.has(rule.id) || rule.status !== "active") continue;
    rule.lastTriggeredAt = now;
    rule.triggerCount = (rule.triggerCount ?? 0) + 1;
    rule.updatedAt = now;
    if (rule.mode === "once") {
      rule.status = "triggered";
    }
    updated.push(rule.id);
  }
  if (updated.length > 0) doc.revision += 1;
  return updated;
}

export function recordSituationWokenInDoc(
  doc: AssistantDurableState,
  situationId: string,
  now: number,
  linkedTopicId?: string,
): void {
  ensureAssistantState(doc);
  const sit = doc.situations[situationId];
  if (!sit) return;
  sit.lastWokenAt = now;
  if (linkedTopicId && linkedTopicId !== "root") {
    sit.linkedTopicId = linkedTopicId;
  }
  sit.updatedAt = now;
}
