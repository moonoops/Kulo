import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import {
  isAssistantDecisionItem,
  isAssistantItemExpired,
  type AssistantDismissTarget,
  type AssistantItemAction,
  type AssistantItemKind,
  type AssistantItemView,
  type AssistantPendingAction,
  type AssistantWatchRule,
  type ChatAttachment,
  type TopicSummary,
} from "@kulo/protocol";
import type { AmbientModelService } from "./ambient-model-service.js";
import type { AssistantLedger, StoredAssistantDigest, StoredAssistantEvent } from "./assistant-ledger.js";
import {
  buildCoordinatorPromptPayload,
  COORDINATOR_SYSTEM_PROMPT,
  fallbackCoordinatorDecision,
  isSameAssistantAppFamily,
  parseCoordinatorDecision,
  situationIdFromKey,
  type CoordinatorDecision,
} from "./assistant-card-policy.js";
import {
  AssistantDoc,
  dismissAssistantItemsInDoc,
  ensureAssistantState,
  findSituationByKey,
  isAssistantSourceEnabled,
  pruneExpiredAssistantItemsInDoc,
  reconcileDispatchedActionsInDoc,
  resolveAssistantItemInDoc,
  selectActiveAssistantItems,
  upsertAssistantCardInDoc,
} from "./assistant-state.js";
import { executeAssistantItemAction } from "./assistant-item-actions.js";
import { isCriticalSafetyAlert } from "./assistant-proactive-guard.js";
import type {
  ExecuteProactiveWakeInput,
  ExecuteProactiveWakeOutcome,
} from "./assistant-proactive-wake.js";
import type { AssistantEscalationPayload } from "./assistant-sorter.js";
import { formatWatchRulesForPrompt, isWatchRuleActiveAt, isWithinQuietHours } from "./assistant-watch-rules.js";
import type { DeliveryAck, DeliveryIntent } from "./delivery-receipts.js";

export { parseCoordinatorDecision, situationIdFromKey, type CoordinatorDecision };

export interface AssistantCoordinatorHost {
  harness: Harness;
  ledger: AssistantLedger;
  ambientModel: AmbientModelService;
  agentName(): string;
  envDisplayName(envId: string): string | undefined;
  isForegroundBusy(): boolean;
  canMutateState?(): boolean;
  shouldSkipCloudModel?(): Promise<boolean>;
  redact(text: string): string;
  createDetachedOrchestratorConversation(context: Context): Promise<{ id: ConversationId }>;
  onItemsChanged(revision: number, items: AssistantItemView[]): void;
  onTopicsChanged(topics: TopicSummary[]): void;
  onTopicContentChanged?(topicId: string): void;
  onMutedAppsChanged?(mutedApps: string[]): void;
  materializeSnapshot?(snapshotRef: string, conversationId: number): Promise<ChatAttachment | undefined>;
  executeProactiveWake?(input: ExecuteProactiveWakeInput): Promise<ExecuteProactiveWakeOutcome>;
  onCardAlertNotification?(input: {
    situationId: string;
    topicId?: string;
    title: string;
    summary: string;
    isCritical?: boolean;
  }): void;
  onAlertSurfaced?(event: {
    situationId: string;
    kind: AssistantItemKind;
    sourceApp: string;
    sourceLabel: string;
    title: string;
    summary: string;
    urgency: "low" | "normal" | "high";
  }): void;
  executePendingAction?(
    action: AssistantPendingAction,
  ): Promise<{ ok: boolean; preDispatch?: boolean; error?: string }>;
}

const RECENT_DIGEST_WINDOW_MS = 8 * 60 * 60 * 1_000;
const RECENT_DIGEST_LIMIT = 60;
const FOREGROUND_DEFER_MS = 4_000;
const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;
const CLOSE_DRAIN_TIMEOUT_MS = 2_000;

function mergeEscalations(
  prev: AssistantEscalationPayload | undefined,
  next: AssistantEscalationPayload,
): AssistantEscalationPayload {
  if (!prev) return next;
  const matchedRuleIds = [...new Set([...(prev.matchedRuleIds ?? []), ...(next.matchedRuleIds ?? [])])];
  const deterministicRuleIds = [...new Set([...(prev.deterministicRuleIds ?? []), ...(next.deterministicRuleIds ?? [])])];
  const seenEvents = new Set<string>();
  const mergedEvents: StoredAssistantEvent[] = [];
  for (const ev of [...prev.events, ...next.events]) {
    if (seenEvents.has(ev.id)) continue;
    seenEvents.add(ev.id);
    mergedEvents.push(ev);
  }
  return {
    digest: next.digest,
    events: mergedEvents.slice(-16),
    ...(matchedRuleIds.length ? { matchedRuleIds } : {}),
    ...(deterministicRuleIds.length ? { deterministicRuleIds } : {}),
  };
}

export class AssistantCoordinator {
  readonly #host: AssistantCoordinatorHost;
  readonly #inFlight = new Set<string>();
  readonly #inFlightPromises = new Set<Promise<void>>();
  readonly #pending = new Map<string, AssistantEscalationPayload>();
  readonly #controllers = new Set<AbortController>();
  readonly #deferTimers = new Map<string, NodeJS.Timeout>();
  #expiryTimer: NodeJS.Timeout | null = null;
  #pruneInFlight: Promise<number> | null = null;
  #closed = false;

  constructor(host: AssistantCoordinatorHost) {
    this.#host = host;
  }

  async start(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.#closed) return;
    await this.reconcileDispatchedActions(context);
    await this.pruneExpiredItems(context, { ignoreGate: true });
    if (this.#closed || this.#expiryTimer) return;
    this.#expiryTimer = setInterval(() => {
      void this.pruneExpiredItems(BACKGROUND_CONTEXT).catch(() => {});
    }, EXPIRY_SWEEP_INTERVAL_MS);
    this.#expiryTimer.unref();
  }

  enqueueEscalation(input: AssistantEscalationPayload): void {
    if (this.#closed) return;
    const sitKey = input.digest.situationKey;
    if (this.#inFlight.has(sitKey)) {
      this.#pending.set(sitKey, mergeEscalations(this.#pending.get(sitKey), input));
      return;
    }
    const gated = this.#host.canMutateState?.() === false;
    const urgent = input.digest.urgency === "high" || Boolean(input.matchedRuleIds?.length);
    if (gated || (!urgent && this.#host.isForegroundBusy())) {
      this.#pending.set(sitKey, mergeEscalations(this.#pending.get(sitKey), input));
      this.#scheduleDeferred(sitKey);
      return;
    }
    this.#startSituation(sitKey, input);
  }

  async waitIdle(): Promise<void> {
    while (this.#inFlight.size > 0 || this.#pending.size > 0 || this.#pruneInFlight !== null) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#expiryTimer) {
      clearInterval(this.#expiryTimer);
      this.#expiryTimer = null;
    }
    this.#pending.clear();
    for (const timer of this.#deferTimers.values()) clearTimeout(timer);
    this.#deferTimers.clear();
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    const active: Array<Promise<unknown>> = [...this.#inFlightPromises];
    if (this.#pruneInFlight) active.push(this.#pruneInFlight);
    if (active.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(active),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_DRAIN_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }

  #scheduleDeferred(sitKey: string): void {
    if (this.#closed || this.#deferTimers.has(sitKey)) return;
    const timer = setTimeout(() => {
      this.#deferTimers.delete(sitKey);
      const queued = this.#pending.get(sitKey);
      if (!queued || this.#closed || this.#inFlight.has(sitKey)) return;
      if (this.#host.canMutateState?.() === false) {
        this.#scheduleDeferred(sitKey);
        return;
      }
      this.#pending.delete(sitKey);
      this.#startSituation(sitKey, queued);
    }, FOREGROUND_DEFER_MS);
    timer.unref();
    this.#deferTimers.set(sitKey, timer);
  }

  #startSituation(sitKey: string, input: AssistantEscalationPayload): void {
    if (this.#closed || this.#inFlight.has(sitKey)) return;
    this.#inFlight.add(sitKey);
    const run = this.#evaluateEscalation(sitKey, input)
      .catch(() => {})
      .finally(() => {
        this.#inFlight.delete(sitKey);
        this.#inFlightPromises.delete(run);
        const followUp = this.#pending.get(sitKey);
        if (followUp && !this.#closed) {
          if (this.#host.canMutateState?.() === false) {
            this.#scheduleDeferred(sitKey);
          } else {
            this.#pending.delete(sitKey);
            this.#startSituation(sitKey, followUp);
          }
        }
      });
    this.#inFlightPromises.add(run);
  }

  async #evaluateEscalation(sitKey: string, input: AssistantEscalationPayload): Promise<void> {
    if (this.#closed) return;
    if (this.#host.canMutateState?.() === false) {
      this.#pending.set(sitKey, mergeEscalations(this.#pending.get(sitKey), input));
      this.#scheduleDeferred(sitKey);
      return;
    }
    const now = Date.now();
    const cleanSitKey = this.#host.redact(sitKey).slice(0, 160);
    const sitId = situationIdFromKey(cleanSitKey);
    const snap = await this.#host.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT);
    if (!snap || !isAssistantSourceEnabled(snap, input.digest.appId)) return;
    if (snap.mutedApps?.includes(input.digest.appId)) return;

    const priorSituation = snap.situations?.[sitId] ?? findSituationByKey(snap, cleanSitKey);
    const priorUpdatedAt = priorSituation?.updatedAt ?? 0;
    const priorStatus = priorSituation?.status;
    const activeItems = selectActiveAssistantItems(snap.items, now);
    const priorItemsById = new Map(activeItems.map((item) => [item.id, item]));

    const activeWatchRules = (snap.watchRules ?? []).filter((r) => isWatchRuleActiveAt(r, now));
    const activeRuleById = new Map(activeWatchRules.map((r) => [r.id, r]));
    const activeRuleIdSet = new Set(activeRuleById.keys());
    const preMatchedIds = (input.matchedRuleIds ?? []).filter((id) => activeRuleById.has(id));
    const deterministicIds = (input.deterministicRuleIds ?? []).filter((id) => activeRuleById.has(id));
    const hasDeterministicMatch = deterministicIds.length > 0;

    const { items: recentDigests, truncated } = await this.#host.ledger.recentDigests({
      sinceMs: now - RECENT_DIGEST_WINDOW_MS,
      limit: RECENT_DIGEST_LIMIT,
    });

    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 25_000);
    timer.unref();

    let decision: CoordinatorDecision;
    if (await this.#host.shouldSkipCloudModel?.()) {
      if (input.digest.appId !== "home-assistant" && input.digest.category !== "security" && preMatchedIds.length === 0) {
        clearTimeout(timer);
        this.#controllers.delete(controller);
        return;
      }
      decision = {
        action: preMatchedIds.length > 0 || input.digest.appId === "home-assistant" || input.digest.category === "security"
          ? "wake_chat"
          : "upsert_card",
        kind: "alert",
        title: input.digest.appLabel,
        summary: input.digest.digest,
      };
    } else try {
      const watchRulesPrompt = formatWatchRulesForPrompt(activeWatchRules);
      const promptPayload = buildCoordinatorPromptPayload({
        digest: input.digest,
        events: input.events,
        recentDigests,
        truncated,
        activeItems,
        ...(watchRulesPrompt ? { watchRulesPrompt } : {}),
        ...(preMatchedIds.length ? { matchedRuleIds: preMatchedIds } : {}),
      });
      const raw = await this.#host.ambientModel.completeZeroToolJson({
        systemPrompt: COORDINATOR_SYSTEM_PROMPT,
        userContent: promptPayload,
        maxTokens: 900,
        signal: controller.signal,
        preferMainModel: true,
      });
      decision = parseCoordinatorDecision(raw, activeRuleIdSet);
    } catch {
      decision = fallbackCoordinatorDecision(input.digest, { hasMatchedRule: preMatchedIds.length > 0 });
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }

    if (this.#closed) return;
    const allMatchedIds = [...new Set([...preMatchedIds, ...(decision.matchedRuleIds ?? [])])].filter((id) =>
      activeRuleById.has(id),
    );
    const matchedRules: AssistantWatchRule[] = allMatchedIds
      .map((id) => activeRuleById.get(id))
      .filter((r): r is AssistantWatchRule => Boolean(r));

    // Deterministic user watch rules may only be resolved if the user already replied, never silently ignored/downgraded to fyi.
    if (hasDeterministicMatch && decision.action !== "resolve_item") {
      decision = {
        ...decision,
        action: "wake_chat",
        kind: "alert",
      };
    }

    if (decision.action === "ignore") return;
    if (this.#host.canMutateState?.() === false) {
      this.#pending.set(sitKey, mergeEscalations(this.#pending.get(sitKey), input));
      this.#scheduleDeferred(sitKey);
      return;
    }

    const sampleEvent = input.events[input.events.length - 1];
    const snapshotRef = [...input.events].reverse().find((ev) => ev.snapshotRef)?.snapshotRef;
    const envName = sampleEvent ? this.#host.envDisplayName(sampleEvent.envId) : undefined;
    const cleanTitle = this.#host.redact(decision.title || input.digest.appLabel).slice(0, 80);
    const cleanSummary = this.#host.redact(decision.summary || input.digest.digest).slice(0, 300);
    const isCritical = isCriticalSafetyAlert({
      sourceApp: input.digest.appId,
      title: cleanTitle,
      summary: cleanSummary,
    });

    if (decision.action === "resolve_item") {
      const targetId = decision.itemId ?? `asst-${sitId}`;
      const result = await this.#host.harness.commit(async (tx) => {
        const doc = await tx.doc(AssistantDoc);
        const ts = Date.now();
        const removed = resolveAssistantItemInDoc(
          doc,
          (item) =>
            (item.id === targetId || item.situationId === sitId) &&
            isSameAssistantAppFamily(item.sourceApp, input.digest.appId),
          ts,
        );
        if (!removed) return null;
        return { revision: doc.assistantRevision, items: selectActiveAssistantItems(doc.items, ts) };
      }, BACKGROUND_CONTEXT);
      if (result) this.#host.onItemsChanged(result.revision, result.items);
      return;
    }

    // Quiet hours: non-critical events (unless allowed watch rule) silently land as right-rail cards without waking/popping/burning once rules.
    const inQuietHours = isWithinQuietHours(snap.quietHours, now);
    const suppressedByQuietHours =
      inQuietHours &&
      !isCritical &&
      !(matchedRules.length > 0 && snap.quietHours?.allowWatchRules === true);

    if (decision.action === "wake_chat" && !suppressedByQuietHours && this.#host.executeProactiveWake) {
      const wakeOutcome = await this.#host.executeProactiveWake({
        situationId: sitId,
        situationKey: cleanSitKey,
        digest: input.digest,
        events: input.events,
        title: cleanTitle,
        summary: cleanSummary,
        ...(envName ? { envName } : {}),
        ...(snapshotRef ? { snapshotRef } : {}),
        matchedRules,
        isCritical,
        ...(priorStatus ? { priorStatus } : {}),
        priorUpdatedAt,
      });
      if (wakeOutcome.status === "deferred_by_gate") {
        this.#pending.set(sitKey, mergeEscalations(this.#pending.get(sitKey), input));
        this.#scheduleDeferred(sitKey);
        return;
      }
      if (wakeOutcome.status === "woken" || wakeOutcome.status === "fallback_notified" || (wakeOutcome.status === "deferred_by_voice" && isCritical)) {
        this.#host.onAlertSurfaced?.({
          situationId: sitId,
          kind: "alert",
          sourceApp: input.digest.appId,
          sourceLabel: input.digest.appLabel,
          title: cleanTitle,
          summary: cleanSummary,
          urgency: input.digest.urgency,
        });
      }
      return;
    }

    // `upsert_card` (or `wake_chat` downgraded by quietHours / missing wake host)
    const resolvedKind: AssistantItemKind =
      decision.action === "wake_chat"
        ? "alert"
        : decision.kind ?? (input.digest.urgency === "high" ? "alert" : "fyi");
    const priorTarget = decision.itemId ? priorItemsById.get(decision.itemId) : undefined;
    // Never merge across Home Assistant entities (protects 5-min speaker cooldown and per-entity recovery) or L2 decision cards.
    const allowMergeById =
      priorTarget !== undefined &&
      !isAssistantDecisionItem(priorTarget) &&
      input.digest.appId !== "home-assistant" &&
      priorTarget.sourceApp !== "home-assistant" &&
      isSameAssistantAppFamily(priorTarget.sourceApp, input.digest.appId);

    const committed = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(AssistantDoc);
      ensureAssistantState(doc);
      if (!isAssistantSourceEnabled(doc, input.digest.appId) || doc.mutedApps.includes(input.digest.appId)) return null;
      const ts = Date.now();

      if (allowMergeById && priorTarget) {
        const liveTarget = doc.items.find((item) => item.id === priorTarget.id);
        if (!liveTarget) {
          if (doc.situations[priorTarget.situationId]?.status === "dismissed") return null;
        } else {
          if (isAssistantDecisionItem(liveTarget) || !isSameAssistantAppFamily(liveTarget.sourceApp, input.digest.appId)) return null;
          const mergedKind: AssistantItemKind = liveTarget.kind === "alert" ? "alert" : resolvedKind;
          const mergedSitKey = this.#host.redact(doc.situations[liveTarget.situationId]?.key ?? cleanSitKey).slice(0, 160);
          upsertAssistantCardInDoc(doc, {
            situationId: liveTarget.situationId,
            situationKey: mergedSitKey,
            kind: mergedKind,
            sourceApp: input.digest.appId,
            sourceLabel: input.digest.appLabel,
            ...(envName ? { envName } : {}),
            title: cleanTitle,
            summary: cleanSummary,
            ...(snapshotRef ? { snapshotRef } : {}),
            now: ts,
          });
          return {
            revision: doc.assistantRevision,
            items: selectActiveAssistantItems(doc.items, ts),
            effectiveSitId: liveTarget.situationId,
            effectiveKind: mergedKind,
            linkedTopicId: doc.situations[liveTarget.situationId]?.linkedTopicId,
          };
        }
      }

      const currentSit = doc.situations[sitId];
      if (currentSit?.status === "dismissed" && (priorStatus !== "dismissed" || currentSit.updatedAt > priorUpdatedAt)) {
        return null;
      }
      const existingAtSit = doc.items.find((item) => item.situationId === sitId);
      if (existingAtSit && isAssistantDecisionItem(existingAtSit)) return null;

      upsertAssistantCardInDoc(doc, {
        situationId: sitId,
        situationKey: cleanSitKey,
        kind: resolvedKind,
        sourceApp: input.digest.appId,
        sourceLabel: input.digest.appLabel,
        ...(envName ? { envName } : {}),
        title: cleanTitle,
        summary: cleanSummary,
        ...(snapshotRef ? { snapshotRef } : {}),
        now: ts,
      });
      return {
        revision: doc.assistantRevision,
        items: selectActiveAssistantItems(doc.items, ts),
        effectiveSitId: sitId,
        effectiveKind: resolvedKind,
        linkedTopicId: doc.situations[sitId]?.linkedTopicId,
      };
    }, BACKGROUND_CONTEXT);
    if (committed) {
      this.#host.onItemsChanged(committed.revision, committed.items);
      if (!suppressedByQuietHours) {
        if (committed.effectiveKind === "alert") {
          this.#host.onCardAlertNotification?.({
            situationId: committed.effectiveSitId,
            ...(committed.linkedTopicId ? { topicId: committed.linkedTopicId } : {}),
            title: cleanTitle,
            summary: cleanSummary,
            isCritical,
          });
        }
        this.#host.onAlertSurfaced?.({
          situationId: committed.effectiveSitId,
          kind: committed.effectiveKind,
          sourceApp: input.digest.appId,
          sourceLabel: input.digest.appLabel,
          title: cleanTitle,
          summary: cleanSummary,
          urgency: input.digest.urgency,
        });
      }
    }
  }

  /**
   * Surfaces an L2 confirmation card (`kind: "decision"`) in the pinned right rail.
   * No external action runs until the user explicitly triggers `confirm_action`.
   */
  async proposeDecisionCard(
    input: {
      situationKey: string;
      sourceApp: string;
      sourceLabel: string;
      envName?: string;
      title: string;
      summary: string;
      pendingAction: AssistantPendingAction;
      suppressAlertNotification?: boolean;
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<AssistantItemView> {
    const cleanSitKey = this.#host.redact(input.situationKey).slice(0, 160);
    const sitId = situationIdFromKey(cleanSitKey);
    const committed = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(AssistantDoc);
      const ts = Date.now();
      const card = upsertAssistantCardInDoc(doc, {
        situationId: sitId,
        situationKey: cleanSitKey,
        kind: "decision",
        sourceApp: input.sourceApp,
        sourceLabel: input.sourceLabel,
        ...(input.envName ? { envName: input.envName } : {}),
        title: this.#host.redact(input.title).slice(0, 80),
        summary: this.#host.redact(input.summary).slice(0, 300),
        primaryActionLabel: input.pendingAction.label.slice(0, 40),
        pendingAction: {
          ...input.pendingAction,
          previewText: this.#host.redact(input.pendingAction.previewText).slice(0, 400),
        },
        now: ts,
      });
      return {
        card: JSON.parse(JSON.stringify(card)) as AssistantItemView,
        revision: doc.assistantRevision,
        items: selectActiveAssistantItems(doc.items, ts),
      };
    }, context);
    this.#host.onItemsChanged(committed.revision, committed.items);
    if (!input.suppressAlertNotification) {
      this.#host.onCardAlertNotification?.({
        situationId: sitId,
        title: committed.card.title,
        summary: committed.card.summary,
        isCritical: false,
      });
    }
    return committed.card;
  }

  /**
   * Silently clears an active non-decision right-rail card when the underlying situation resolves on its own
   * (e.g., an offline Home Assistant device comes back online).
   */
  async resolveSituationByKey(situationKey: string, context: Context = BACKGROUND_CONTEXT): Promise<boolean> {
    if (this.#closed) return false;
    const sitId = situationIdFromKey(this.#host.redact(situationKey).slice(0, 160));
    const result = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(AssistantDoc);
      const ts = Date.now();
      const removed = resolveAssistantItemInDoc(doc, (item) => item.situationId === sitId, ts);
      if (!removed) return null;
      return { revision: doc.assistantRevision, items: selectActiveAssistantItems(doc.items, ts) };
    }, context);
    if (!result) return false;
    this.#host.onItemsChanged(result.revision, result.items);
    return true;
  }

  /**
   * Zero-LLM deterministic resolution of passive right-rail cards when the user's own
   * verified outgoing Lark reply arrives for the same P2P chat or explicit group reply/thread.
   * Never touches L2 `decision` cards or unrelated conversations.
   */
  async resolvePassiveCardsForOutgoingReply(
    events: readonly StoredAssistantEvent[],
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<number> {
    if (this.#closed || this.#host.canMutateState?.() === false) return 0;
    const outgoing = events.filter(
      (ev) => ev.direction === "outgoing" && ev.driverId === "lark-cli" && !ev.messageMeta?.deleted,
    );
    if (outgoing.length === 0) return 0;

    const snap = await this.#host.harness.snapshot(AssistantDoc, context);
    if (!snap || snap.items.length === 0) return 0;
    const candidateIds = new Set<string>();
    for (const item of snap.items) {
      const sit = snap.situations?.[item.situationId];
      if (outgoing.some((ev) => matchesOutgoingPassiveCard(item, sit?.key, sit?.title, ev))) {
        candidateIds.add(item.id);
      }
    }
    if (candidateIds.size === 0 || this.#closed || this.#host.canMutateState?.() === false) return 0;

    const committed = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(AssistantDoc);
      const ts = Date.now();
      let resolved = 0;
      for (const id of candidateIds) {
        const live = doc.items.find((item) => item.id === id);
        if (!live) continue;
        const sit = doc.situations?.[live.situationId];
        if (!outgoing.some((ev) => matchesOutgoingPassiveCard(live, sit?.key, sit?.title, ev))) continue;
        if (resolveAssistantItemInDoc(doc, (item) => item.id === id, ts)) {
          resolved += 1;
        }
      }
      if (resolved === 0) return null;
      return {
        resolved,
        revision: doc.assistantRevision,
        items: selectActiveAssistantItems(doc.items, ts),
      };
    }, context);
    if (!committed) return 0;
    this.#host.onItemsChanged(committed.revision, committed.items);
    return committed.resolved;
  }

  /**
   * Prunes expired passive reminder cards. Uses a cheap read-only snapshot probe first so idle
   * sweeps incur zero write transactions or revision bumps.
   */
  async pruneExpiredItems(
    context: Context = BACKGROUND_CONTEXT,
    options: { ignoreGate?: boolean } = {},
  ): Promise<number> {
    if (this.#closed || (!options.ignoreGate && this.#host.canMutateState?.() === false)) return 0;
    if (this.#pruneInFlight) return this.#pruneInFlight;
    const run = (async () => {
      const snap = await this.#host.harness.snapshot(AssistantDoc, context);
      const now = Date.now();
      if (!(snap?.items ?? []).some((item) => isAssistantItemExpired(item, now))) return 0;
      if (this.#closed || (!options.ignoreGate && this.#host.canMutateState?.() === false)) return 0;
      const pruned = await this.#host.harness.commit(async (tx) => {
        const doc = await tx.doc(AssistantDoc);
        const ts = Date.now();
        const removed = pruneExpiredAssistantItemsInDoc(doc, ts);
        if (removed === 0) return null;
        return { removed, revision: doc.assistantRevision, items: selectActiveAssistantItems(doc.items, ts) };
      }, context);
      if (!pruned) return 0;
      this.#host.onItemsChanged(pruned.revision, pruned.items);
      return pruned.removed;
    })().finally(() => {
      if (this.#pruneInFlight === run) this.#pruneInFlight = null;
    });
    this.#pruneInFlight = run;
    return run;
  }

  /**
   * Snapshot-isolated bulk dismissal of passive reminder cards. Never dismisses L2 `decision` cards
   * or cards whose `(revision, updatedAt)` changed after the caller observed them.
   */
  async dismissItems(
    targets: readonly AssistantDismissTarget[],
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{
    dismissedIds: string[];
    skippedIds: string[];
    assistantRevision: number;
    items: AssistantItemView[];
  }> {
    const outcome = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(AssistantDoc);
      const ts = Date.now();
      const res = dismissAssistantItemsInDoc(doc, targets, ts);
      return {
        dismissedIds: res.dismissedIds,
        skippedIds: res.skippedIds,
        changed: res.changed,
        assistantRevision: doc.assistantRevision,
        items: selectActiveAssistantItems(doc.items, ts),
      };
    }, context);
    if (outcome.changed) {
      this.#host.onItemsChanged(outcome.assistantRevision, outcome.items);
    }
    return {
      dismissedIds: outcome.dismissedIds,
      skippedIds: outcome.skippedIds,
      assistantRevision: outcome.assistantRevision,
      items: outcome.items,
    };
  }

  async performItemAction(input: {
    itemId: string;
    expectedRevision: number;
    action: AssistantItemAction;
    intent?: DeliveryIntent;
    context?: Context;
  }): Promise<{ ack: DeliveryAck & { itemId?: string }; deduplicated?: boolean }> {
    return executeAssistantItemAction(this.#host, input);
  }

  async reconcileDispatchedActions(context: Context = BACKGROUND_CONTEXT): Promise<number> {
    const recovered = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(AssistantDoc);
      const now = Date.now();
      const count = reconcileDispatchedActionsInDoc(doc, now);
      if (count === 0) return null;
      return {
        count,
        revision: doc.assistantRevision,
        items: selectActiveAssistantItems(doc.items, now),
      };
    }, context);
    if (!recovered) return 0;
    this.#host.onItemsChanged(recovered.revision, recovered.items);
    return recovered.count;
  }
}

const GENERIC_OUTGOING_MATCH_TITLES = new Set<string>([
  "飞书",
  "飞书私聊",
  "飞书群聊",
  "私聊",
  "群聊",
  "lark",
  "feishu",
]);

function matchesOutgoingPassiveCard(
  item: AssistantItemView,
  situationKey: string | undefined,
  situationTitle: string | undefined,
  ev: StoredAssistantEvent,
): boolean {
  if (isAssistantDecisionItem(item)) return false;
  if (item.sourceApp === "home-assistant") return false;
  if (!isSameAssistantAppFamily(item.sourceApp, ev.appId)) return false;
  if (ev.occurredAt < item.updatedAt - 60_000) return false;

  const meta = ev.messageMeta;
  const chatId = (meta?.chatId || ev.threadHint || "").trim().toLowerCase();
  const titleNorm = ev.title.trim().toLowerCase();
  const sitKey = (situationKey ?? "").toLowerCase();
  const cardTitle = item.title.toLowerCase();
  const sitTitle = (situationTitle ?? "").toLowerCase();

  const matchesChatId = Boolean(chatId && sitKey.includes(chatId));
  const matchesTitle = Boolean(
    titleNorm.length >= 2 &&
      !GENERIC_OUTGOING_MATCH_TITLES.has(titleNorm) &&
      (cardTitle.includes(titleNorm) || sitTitle.includes(titleNorm) || sitKey.includes(titleNorm)),
  );
  if (!matchesChatId && !matchesTitle) return false;

  if (meta?.chatType === "p2p") return true;
  return Boolean(meta?.replyToMessageId || meta?.threadId);
}
