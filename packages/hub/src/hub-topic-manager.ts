import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  CompactionEntry, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID,
  type Conversation, type ConversationId, type ConversationView, type ConversationWatch,
  type EntryId, type EntryRecord, type Extension, type Harness, type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import type {
  BuiltinThinkingEffort, ChatDisplayItem, ConversationSearchInput,
  LiveStreamState, MainSessionNotificationEvent, TicketRecord, TopicSummary,
} from "@kulo/protocol";
import { repairHistoricalChatAttachments } from "./chat-attachment-deliveries.js";
import { chatReceiptData, queuedChatEntries } from "./chat-submissions.js";
import { abortConversationSafely } from "./conversation-abort.js";
import type { KuloConnections } from "./connections.js";
import { ConversationQueries } from "./conversation-query.js";
import { redactCredentialData } from "./credential-redaction.js";
import { entryTimestamp } from "./hub-display-projection.js";
import type { HubRuntimeGates, LiveSettingsStore } from "./hub-kernel-ports.js";
import { KuloProjects, KuloProjectsDoc, ProjectError, assertProjectBinding } from "./projects.js";
import {
  createTopicNotificationBaseline, detectMainSessionNotification, type TopicNotificationBaseline,
} from "./session-notifications.js";
import { KuloSettingsDoc } from "./settings.js";
import {
  KuloStateDoc, applyTopicPreview, closeSettledTicketsForDeletedTopic,
  discardPendingTopicStagedTickets, ensureDefaultRootTopic, findBlockingTopicTickets,
  hasPendingWorkspaceApply, isOrchestratorConversation, isTicketUnfinished,
  listSortedTopics, summarizeTopicPreview, transitionTicketStatus, type KuloDurableState,
} from "./state.js";
import { KuloTopicTitles } from "./topic-titles.js";
import type { KuloUploadStore } from "./uploads.js";
import type { KuloVoiceCalls } from "./voice-calls.js";

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export interface WatchedTopicCache {
  topicId: string;
  conversation: Conversation;
  watch: ConversationWatch;
  messages: ChatDisplayItem[];
  live: LiveStreamState;
  notificationBaseline: TopicNotificationBaseline;
}

export type TopicView = Pick<WatchedTopicCache, "topicId" | "messages" | "live"> & {
  conversationId: number;
  historyBefore?: number;
};

export function requireTopic(state: Readonly<KuloDurableState> | undefined, topicId: string) {
  const topic = state?.topics && Object.hasOwn(state.topics, topicId) ? state.topics[topicId] : undefined;
  if (topic?.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
  if (!topic) throw new ProjectError(404, "topic_not_found", "会话不存在。");
  return topic;
}

export interface TopicEventListener {
  onTopicView?: (topicId: string, messages: ChatDisplayItem[], live: LiveStreamState, conversationId?: number) => void;
  onRootView?: (messages: ChatDisplayItem[], live: LiveStreamState) => void;
  onTopics?: (topics: TopicSummary[]) => void;
  onNotification?: (event: MainSessionNotificationEvent) => void;
}

export interface HubTopicManagerDeps {
  harness: Harness;
  settingsStore: LiveSettingsStore;
  runtimeGates: Pick<HubRuntimeGates, "isClosed" | "isRecovering" | "isHandoverBarrierActive" | "resumeIfNotRecovering" | "broadcastTickets">;
  envManager: Pick<EnvManager, "getEnvDescriptor">;
  uploads: KuloUploadStore;
  projects: KuloProjects;
  connectionManager: Pick<KuloConnections, "redact" | "redactionRevision">;
  listeners: ReadonlySet<TopicEventListener>;
  voiceCalls: Pick<KuloVoiceCalls, "topicUpdated">;
  contextCompaction: {
    align: (conversationId: ConversationId, context: Context) => Promise<void>;
    pruneCommittedBaseline: (conversationId: ConversationId, context: Context, force: boolean) => Promise<unknown>;
  };
  onTopicIdle?: (topicId: string, conversationId: number, live: LiveStreamState, value: ConversationView) => void;
  hasPendingMediaRelay?: (conversationId: number) => boolean;
  orchestrator: {
    resolveAgent: () => { model: { provider: string; modelId: string }; thinkingLevel: BuiltinThinkingEffort };
    extensions: (isRoot: boolean) => Extension[];
    tools: (isRoot: boolean) => ToolRegistration[];
    redactionExt: Extension;
    mainWorkspaceDir: string;
  };
  projection: {
    hydrateMessages: (entries: readonly EntryRecord[], conversationId: number, context?: Context) => Promise<ChatDisplayItem[]>;
    projectTopicMessages: (value: ConversationView, conversationId: number) => ChatDisplayItem[];
    projectTopicLiveState: (value: ConversationView, conversationId: number, conversation?: Conversation) => LiveStreamState;
  };
  cleanup: {
    closeOrchestratorBrowserSession: (topicId: string) => Promise<void>;
    discardTicketStagedWorkspace: (ticket: TicketRecord) => Promise<unknown>;
    onTopicDeleted?: (topicId: string, conversationId: number, context: Context) => Promise<void>;
  };
}

export class HubTopicManager {
  readonly #deps: HubTopicManagerDeps;
  readonly #topicCaches = new Map<string, WatchedTopicCache>();
  readonly #topicTitleCache = new Map<string, string>();
  readonly #topicPreviewCache = new Map<string, { preview: string; at?: number }>();
  readonly #topicActivityUpdates = new Map<string, Promise<void>>();
  readonly #topicTitles: KuloTopicTitles;
  #queryService?: ConversationQueries;
  #topicAutoArchiveTimer: ReturnType<typeof setInterval> | null = null;
  #topicAutoArchiveRun: Promise<TopicSummary[]> | null = null;

  constructor(deps: HubTopicManagerDeps) {
    this.#deps = deps;
    this.#topicTitles = new KuloTopicTitles({
      harness: deps.harness,
      agent: () => deps.orchestrator.resolveAgent(),
      publish: (topics) => this.emitTopics(topics),
      extensions: () => [deps.orchestrator.redactionExt],
      redact: (text) => deps.connectionManager.redact(text),
    });
  }

  getCache(topicId: string): WatchedTopicCache | undefined { return this.#topicCaches.get(topicId); }
  hasCache(topicId: string): boolean { return this.#topicCaches.has(topicId); }
  listWatchedCaches(): WatchedTopicCache[] { return [...this.#topicCaches.values()]; }
  setCachedTitle(topicId: string, title: string): void { this.#topicTitleCache.set(topicId, title); }
  trackTitle(topicId: string): void { this.#topicTitles.track(topicId); }

  async startTitles(context: Context): Promise<void> {
    for (const topicId of await this.#topicTitles.start()) {
      try {
        const cache = await this.resolveWatchedTopic(topicId, context);
        this.#topicTitles.observe(topicId, cache.messages, cache.live.busy || Boolean(cache.live.runFailure));
      } catch (error) {
        // A pending project binding may temporarily block its source view, not the Hub itself.
        console.warn("[KuloTopicTitle] Source unavailable during recovery", topicId,
          error instanceof ProjectError ? error.code : error instanceof Error ? error.name : "error");
      }
    }
  }

  startAutoArchive(): void {
    if (this.#topicAutoArchiveTimer || this.#deps.runtimeGates.isClosed()) return;
    this.#topicAutoArchiveTimer = setInterval(() => {
      if (this.#deps.runtimeGates.isHandoverBarrierActive()) return;
      void this.archiveInactiveTopics().catch((error) => {
        console.warn("[KuloTopicArchive] Automatic archive check failed", error);
      });
    }, 60_000);
    this.#topicAutoArchiveTimer.unref?.();
  }

  stopAutoArchiveTimer(): void {
    if (this.#topicAutoArchiveTimer) {
      clearInterval(this.#topicAutoArchiveTimer);
      this.#topicAutoArchiveTimer = null;
    }
  }

  async closeTitles(): Promise<void> { await this.#topicTitles.close(); }

  async drainTopicActivity(topicId: string): Promise<void> {
    await this.#topicActivityUpdates.get(topicId);
  }

  async drainPendingActivity(): Promise<void> {
    await this.#topicAutoArchiveRun;
    await Promise.all(this.#topicActivityUpdates.values());
  }

  async stopAllWatches(finish: (work: () => unknown) => Promise<void>): Promise<void> {
    for (const cache of this.listWatchedCaches()) {
      await finish(() => cache.watch.stop());
    }
    this.#topicCaches.clear();
  }

  inspectBusyTopics(): string[] {
    const busy: string[] = [];
    for (const [topicId, cache] of this.#topicCaches) {
      if (cache.live.busy) busy.push(topicId);
    }
    return busy;
  }

  refreshTopic(topicId: string): void {
    const cache = this.#topicCaches.get(topicId);
    if (cache) this.refreshContent(cache);
  }

  refreshByConversation(conversationId: number): void {
    for (const cache of this.#topicCaches.values()) {
      if (Number(cache.conversation.id) === conversationId) this.refreshContent(cache);
    }
  }

  refreshAll(): void {
    for (const cache of this.#topicCaches.values()) this.refreshContent(cache);
  }

  async unwatchTopic(topicId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    const cache = this.#topicCaches.get(topicId);
    if (!cache) return;
    await abortConversationSafely(this.#deps.harness, cache.conversation, context);
    await cache.watch.stop();
    this.#topicCaches.delete(topicId);
  }

  async unwatchDeletedTopics(state: Readonly<KuloDurableState> | undefined, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    for (const [id, cache] of this.#topicCaches) {
      if (!state?.topics?.[id]?.deletedAt) continue;
      await this.#deps.cleanup.closeOrchestratorBrowserSession(id);
      await abortConversationSafely(this.#deps.harness, cache.conversation, context);
      await cache.watch.stop();
      this.#topicCaches.delete(id);
    }
  }

  /**
   * Swaps the watched conversation for an existing topic (e.g. after rotating `"root"`),
   * stopping the previous watch without aborting background tasks on the old conversation,
   * clearing stale preview cache, attaching the new watch, and broadcasting the live snapshot.
   */
  async replaceWatchedTopic(topicId: string, conversation: Conversation, context: Context = BACKGROUND_CONTEXT): Promise<WatchedTopicCache> {
    const previous = this.#topicCaches.get(topicId);
    if (previous && Number(previous.conversation.id) !== Number(conversation.id)) {
      this.#topicCaches.delete(topicId);
      await previous.watch.stop().catch(() => {});
    }
    this.#topicPreviewCache.delete(topicId);
    const cache = await this.ensureTopicWatched(topicId, conversation, context);
    const topics = await this.listTopics(context);
    this.emitTopics(topics);
    this.refreshContent(cache);
    return cache;
  }

  async listTopics(context: Context = BACKGROUND_CONTEXT): Promise<TopicSummary[]> {
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    if (!state) return [];
    return this.#enrichTopicsWithPreviews(listSortedTopics(state));
  }

  async archiveInactiveTopics(context: Context = BACKGROUND_CONTEXT): Promise<TopicSummary[]> {
    if (this.#deps.runtimeGates.isClosed()) return [];
    if (this.#topicAutoArchiveRun) return this.#topicAutoArchiveRun;
    const run = this.#archiveInactiveTopics(context);
    this.#topicAutoArchiveRun = run;
    try { return await run; }
    finally { if (this.#topicAutoArchiveRun === run) this.#topicAutoArchiveRun = null; }
  }

  async #archiveInactiveTopics(context: Context): Promise<TopicSummary[]> {
    const { archived, allTopics } = await this.#deps.harness.commit(async (tx) => {
      const settings = await tx.doc(KuloSettingsDoc);
      if (this.#deps.runtimeGates.isClosed() || settings.executor.autoArchiveEnabled === false) return { archived: [], allTopics: [] };
      const state = await tx.doc(KuloStateDoc);
      const cutoff = Date.now() - (settings.executor.autoArchiveDays ?? 7) * 86_400_000;
      const archived: TopicSummary[] = [];
      const protectedTopics = new Set<string>();
      const protectedConversations = new Set<number>();
      for (const ticket of Object.values(state.tickets)) {
        if (!isTicketUnfinished(ticket) && !ticket.cleanupPending && !hasPendingWorkspaceApply(ticket) && ticket.updatedAt < cutoff) continue;
        if (ticket.originTopicId) protectedTopics.add(ticket.originTopicId);
        if (ticket.originConversationId !== undefined) protectedConversations.add(ticket.originConversationId);
      }
      for (const topic of Object.values(state.topics ?? {})) {
        // Only the live master/root topic is exempt from auto-archive; archived former-root snapshots behave as normal topics.
        if (topic.id === "root" || topic.master ||
          topic.deletedAt || topic.archived || topic.updatedAt >= cutoff || this.#topicActivityUpdates.has(topic.id) ||
          this.#topicCaches.get(topic.id)?.live.busy || protectedTopics.has(topic.id) || protectedConversations.has(topic.conversationId)) continue;
        const conversationId = topic.conversationId as ConversationId;
        const live = await tx.doc(LiveDoc, conversationId);
        const inbox = await tx.doc(InboxDoc, conversationId);
        if (live.run || inbox.items.length || state.pausedChats?.[String(conversationId)]?.length) continue;
        const recent = await tx.scanEntries({ conversationId }, 32);
        const timestamps = recent.items.flatMap((entry) => {
          const at = entryTimestamp(entry) ?? chatReceiptData(entry.data).createdAt;
          return at === undefined ? [] : [at];
        });
        // Do not guess at an undated tail that may hide recent automatic activity.
        if (timestamps.some((at) => at >= cutoff) || (recent.next && timestamps.length === 0)) continue;
        topic.archived = true;
        archived.push(cloneJson(topic));
      }
      return { archived, allTopics: archived.length ? listSortedTopics(state) : [] };
    }, context);
    if (archived.length) {
      for (const topic of archived) await this.#deps.cleanup.closeOrchestratorBrowserSession(topic.id);
      this.emitTopics(allTopics);
    }
    return archived;
  }

  async createTopic(title?: string, context: Context = BACKGROUND_CONTEXT, projectId?: string | null): Promise<TopicSummary> {
    const project = projectId ? await this.#deps.projects.get(projectId, context) : undefined;
    const orchestratorAgent = this.#deps.orchestrator.resolveAgent();
    const conv = await this.#deps.harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: {
        model: orchestratorAgent.model,
        thinkingLevel: orchestratorAgent.thinkingLevel,
        extensions: this.#deps.orchestrator.extensions(false),
        tools: this.#deps.orchestrator.tools(false),
        cwd: project?.workspaceDir ?? this.#deps.orchestrator.mainWorkspaceDir,
        maxTurns: 25,
      },
    }, context);

    const cleanTitle = title?.trim();
    const topicId = `topic-${conv.id as number}`;
    const now = Date.now();
    const { topic, allTopics } = await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      ensureDefaultRootTopic(state, this.#deps.settingsStore.getAgentName());
      const projectsDoc = await tx.doc(KuloProjectsDoc);
      if (project) assertProjectBinding(projectsDoc, project.id, project.revision);
      const record: TopicSummary = {
        id: topicId,
        conversationId: conv.id as number,
        title: cleanTitle || "新对话",
        ...(cleanTitle ? {} : { draft: true }),
        createdAt: now,
        updatedAt: now,
        ...(project ? { projectId: project.id } : {}),
      };
      state.topics![topicId] = record;
      state.conversationToTopic![String(conv.id)] = topicId;
      return { topic: cloneJson(record), allTopics: listSortedTopics(state) };
    }, context);

    await this.#deps.contextCompaction.align(conv.id, context);
    await this.ensureTopicWatched(topicId, conv, context);
    this.emitTopics(allTopics);
    return topic;
  }

  async patchTopic(
    topicId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; targetDeviceId?: string | null },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<TopicSummary> {
    if (
      patch.targetDeviceId !== undefined &&
      patch.targetDeviceId !== null &&
      (typeof patch.targetDeviceId !== "string" ||
        patch.targetDeviceId.length > 256 ||
        /[\u0000-\u001f]/.test(patch.targetDeviceId))
    ) {
      throw new ProjectError(400, "invalid_target_device", "目标设备标识无效。");
    }
    const stagedToDiscard: TicketRecord[] = [];
    const { updated, allTopics } = await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      ensureDefaultRootTopic(state, this.#deps.settingsStore.getAgentName());
      const t = state.topics?.[topicId];
      if (!t || t.deletedAt) throw new ProjectError(404, "topic_not_found", "会话不存在或已删除。");
      if (patch.title !== undefined && patch.title.trim()) {
        t.title = patch.title.trim().slice(0, 120);
        delete t.draft;
        const titleJob = state.topicTitles?.[topicId];
        if (titleJob?.status === "pending" || titleJob?.status === "failed") titleJob.status = "cancelled";
      }
      if (patch.pinned !== undefined) t.pinned = Boolean(patch.pinned);
      if (patch.archived !== undefined) {
        if ((t.master || t.id === "root") && patch.archived) {
          throw new Error("默认主对话不可归档");
        }
        t.archived = Boolean(patch.archived);
        if (t.archived) stagedToDiscard.push(...discardPendingTopicStagedTickets(state, topicId, Date.now()));
      }
      if (patch.targetDeviceId !== undefined) {
        const target = (patch.targetDeviceId ?? "").trim();
        const changed = target !== (t.targetDeviceId ?? "");
        if (t.projectId) {
          if (target || changed) {
            throw new ProjectError(409, "project_topic_device_locked", "项目会话已绑定项目所在设备，不能单独修改目标设备。");
          }
        } else if (changed) {
          if (target && !this.#deps.envManager.getEnvDescriptor(target)?.online) {
            throw new ProjectError(409, "target_device_unavailable", "目标设备尚未连接。");
          }
          const convId = t.conversationId as ConversationId;
          const [live, inbox] = await Promise.all([
            tx.doc(LiveDoc, convId),
            tx.doc(InboxDoc, convId),
          ]);
          if (live.run || inbox.items.length) {
            throw new ProjectError(409, "target_device_busy", "请等待当前回复结束，再切换目标设备。");
          }
          if (target) t.targetDeviceId = target;
          else delete t.targetDeviceId;
        }
      }
      t.updatedAt = Date.now();
      return { updated: cloneJson(t), allTopics: listSortedTopics(state) };
    }, context);

    if (stagedToDiscard.length > 0) {
      await Promise.allSettled(stagedToDiscard.map((ticket) => this.#deps.cleanup.discardTicketStagedWorkspace(ticket)));
      this.#deps.runtimeGates.resumeIfNotRecovering();
      await this.#deps.runtimeGates.broadcastTickets(context);
    }
    this.emitTopics(allTopics);
    return updated;
  }

  async deleteTopic(
    topicId: string,
    context: Context = BACKGROUND_CONTEXT,
    options: { stopTasks?: boolean } = {},
  ): Promise<{ deleted: string; topics: TopicSummary[] }> {
    if (topicId === "root") throw new ProjectError(400, "default_topic", "默认主对话不可删除。");
    const snap = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const topic = snap?.topics?.[topicId];
    if (!topic || topic.deletedAt) throw new ProjectError(404, "topic_not_found", "会话不存在或已删除。");
    const active = snap ? findBlockingTopicTickets(snap, topicId, topic.conversationId) : [];
    if (active.length && !options.stopTasks) {
      throw new ProjectError(409, "topic_tasks_running", "会话仍有进行中或待合入的任务，请停止或合并相关任务后删除。",
        { activeTickets: active.map((t) => t.id) });
    }
    const stagedToDiscard: TicketRecord[] = [];
    let ticketsChanged = false, hadUnfinished = false, targetConversationId: number | undefined;
    // The tombstone and cancel intents commit together before any asynchronous cleanup.
    await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const target = state.topics?.[topicId];
      if (!target || target.master) throw new ProjectError(400, "default_topic", "默认主对话不可删除。");
      const unfinished = findBlockingTopicTickets(state, topicId, target.conversationId);
      if (unfinished.length && !options.stopTasks) throw new ProjectError(409, "topic_tasks_running", "会话仍有进行中或待合入的任务，请停止或合并相关任务后删除。");
      target.deletedAt = Date.now();
      target.deletionId = randomUUID();
      target.updatedAt = target.deletedAt;
      targetConversationId = target.conversationId;
      const titleJob = state.topicTitles?.[topicId];
      if (titleJob?.status === "pending" || titleJob?.status === "failed") titleJob.status = "cancelled";
      const projects = await tx.doc(KuloProjectsDoc);
      projects.cancellations ??= {};
      for (const ticket of unfinished) {
        transitionTicketStatus(ticket, "stopped", target.deletedAt);
        ticket.stoppedReason = "会话已删除"; ticket.updatedAt = target.deletedAt; ticket.cleanupPending = true;
        projects.cancellations[ticket.id] = { ...(ticket.projectId ? { projectId: ticket.projectId } : {}), reason: "会话已删除", requestedAt: target.deletedAt };
      }
      const settled = closeSettledTicketsForDeletedTopic(state, topicId, target.deletedAt, target.conversationId);
      stagedToDiscard.push(...settled.stagedToDiscard);
      hadUnfinished = unfinished.length > 0;
      if (hadUnfinished || settled.closedCount > 0) ticketsChanged = true;
    }, context);
    await this.#deps.projects.reconcileCancellations(context);
    if (hadUnfinished) {
      await this.#deps.harness.commit(async (tx) => {
        const settled = closeSettledTicketsForDeletedTopic(await tx.doc(KuloStateDoc), topicId, Date.now(), targetConversationId);
        stagedToDiscard.push(...settled.stagedToDiscard);
        if (settled.closedCount > 0) ticketsChanged = true;
      }, context);
    }
    if (stagedToDiscard.length > 0) await Promise.allSettled(stagedToDiscard.map((ticket) => this.#deps.cleanup.discardTicketStagedWorkspace(ticket)));
    await this.#deps.cleanup.closeOrchestratorBrowserSession(topicId);
    const wasWatched = this.#topicCaches.has(topicId);
    await this.unwatchTopic(topicId, context);
    // Also abort background tasks on uncached deleted topic conversations (protecting root system tasks).
    if (!wasWatched && targetConversationId !== undefined) {
      const conv = await this.#deps.harness.conversation(targetConversationId as ConversationId, context).catch(() => undefined);
      if (conv) await abortConversationSafely(this.#deps.harness, conv, context).catch(() => {});
    }
    if (targetConversationId !== undefined) {
      await this.#deps.cleanup.onTopicDeleted?.(topicId, targetConversationId, context).catch(() => {});
    }
    if (ticketsChanged) await this.#deps.runtimeGates.broadcastTickets(context);
    const topics = await this.listTopics(context);
    this.emitTopics(topics);
    return { deleted: topicId, topics };
  }

  async getTopicView(topicId = "root", context: Context = BACKGROUND_CONTEXT): Promise<TopicView> {
    return this.#readTopicView(await this.resolveWatchedTopic(topicId, context));
  }

  async publishCurrentTopicView(topicId: string, publish: (view: TopicView) => void, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    const [state, projects] = await Promise.all([
      this.#deps.harness.snapshot(KuloStateDoc, context),
      this.#deps.harness.snapshot(KuloProjectsDoc, context),
    ]);
    if (this.#deps.runtimeGates.isClosed()) throw new Error("Hub is closed");
    const topic = requireTopic(state, topicId);
    if (topic.projectId) assertProjectBinding(projects, topic.projectId);
    const cache = this.#topicCaches.get(topicId);
    if (!cache || Number(cache.conversation.id) !== topic.conversationId) throw new ProjectError(404, "topic_not_found", "会话不存在。");
    publish(this.#readTopicView(cache));
  }

  #readTopicView(cache: WatchedTopicCache): TopicView {
    return {
      topicId: cache.topicId,
      conversationId: Number(cache.conversation.id),
      messages: cache.messages,
      historyBefore: this.getTopicHistoryBefore(cache.topicId),
      live: cache.live,
    };
  }

  getTopicHistoryBefore(topicId: string): number | undefined {
    const view = this.#topicCaches.get(topicId)?.watch.value;
    return view?.before !== undefined && view.entries[0] ? Number(view.entries[0].id) : undefined;
  }

  async getTopicHistory(topicId: string, before: number, context: Context = BACKGROUND_CONTEXT) {
    if (!Number.isSafeInteger(before) || before < 1) throw Object.assign(new Error("历史位置无效。"), { status: 400 });
    const cache = await this.resolveWatchedTopic(topicId, context);
    const page = await cache.conversation.entries({ maxEntryId: (before - 1) as EntryId }, 120, undefined, context);
    const entries = [...page.items].reverse();
    return {
      conversationId: Number(cache.conversation.id),
      messages: await this.#deps.projection.hydrateMessages(entries, Number(cache.conversation.id)),
      ...(page.next && entries[0] ? { beforeEntryId: Number(entries[0].id) } : {}),
      hasMore: Boolean(page.next),
    };
  }

  #conversationQueries(): ConversationQueries {
    return (this.#queryService ??= new ConversationQueries({
      redactionRevision: () => this.#deps.connectionManager.redactionRevision,
      topics: async (context) => {
        const [state, projects] = await Promise.all([
          this.#deps.harness.snapshot(KuloStateDoc, context),
          this.#deps.harness.snapshot(KuloProjectsDoc, context),
        ]);
        if (!state) return [];
        return listSortedTopics(state).filter((topic) => {
          if (!isOrchestratorConversation(topic.conversationId, state) || state.conversationToTopic?.[String(topic.conversationId)] !== topic.id) return false;
          if (!topic.projectId) return true;
          const project = projects?.projects && Object.hasOwn(projects.projects, topic.projectId) ? projects.projects[topic.projectId] : undefined;
          return project !== undefined && project.deletedAt === undefined;
        }).map((topic) => ({ ...topic, title: this.#deps.connectionManager.redact(topic.title) }));
      },
      conversation: (id, context) => this.#deps.harness.conversation(id as ConversationId, context),
      project: (entries, id, context) => this.#deps.projection.hydrateMessages(entries, id, context),
      attachment: (assetId, conversationId) => {
        const loaded = this.#deps.uploads.getUpload(assetId);
        if (!loaded || (loaded.record.ownerId !== undefined && !loaded.record.referenceScopes?.includes(`conversation:${conversationId}`))) return undefined;
        return redactCredentialData(this.#deps.uploads.toChatAttachment(loaded.record), (text) => this.#deps.connectionManager.redact(text));
      },
    }));
  }

  searchConversations(input: ConversationSearchInput, context: Context = BACKGROUND_CONTEXT) {
    return this.#conversationQueries().search(input, context);
  }

  getTopicMessageWindow(topicId: string, messageId: number, context: Context = BACKGROUND_CONTEXT) {
    return this.#conversationQueries().messageWindow(topicId, messageId, context);
  }

  listTopicFiles(topicId: string, input: { cursor?: string; limit?: number } = {}, context: Context = BACKGROUND_CONTEXT) {
    return this.#conversationQueries().files(topicId, input, context);
  }

  async resolveWatchedTopic(topicId: string, context: Context): Promise<WatchedTopicCache> {
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const topic = requireTopic(state, topicId);
    const existing = this.#topicCaches.get(topicId);
    if (existing && Number(existing.conversation.id) === topic.conversationId) {
      await this.#deps.contextCompaction.align(existing.conversation.id, context);
      return existing;
    }
    if (existing) {
      this.#topicCaches.delete(topicId);
      await existing.watch.stop().catch(() => {});
    }
    const conv = await this.#deps.harness.conversation(topic.conversationId as ConversationId, context);
    if (!conv) throw new ProjectError(500, "conversation_missing", "会话引用的对话记录不存在。");

    const isRoot = topicId === "root";
    const orchestratorAgent = this.#deps.orchestrator.resolveAgent();
    await conv.configure({
      model: orchestratorAgent.model,
      thinkingLevel: orchestratorAgent.thinkingLevel,
      extensions: this.#deps.orchestrator.extensions(isRoot),
      tools: this.#deps.orchestrator.tools(isRoot),
      cwd: topic.projectId ? (await this.#deps.projects.get(topic.projectId, context)).workspaceDir : this.#deps.orchestrator.mainWorkspaceDir,
      maxTurns: 25,
    }, context);

    await this.#deps.contextCompaction.align(conv.id, context);
    return this.ensureTopicWatched(topicId, conv, context);
  }

  async ensureTopicWatched(topicId: string, conversation: Conversation, context: Context): Promise<WatchedTopicCache> {
    const existing = this.#topicCaches.get(topicId);
    if (existing && Number(existing.conversation.id) === Number(conversation.id)) return existing;
    if (existing) {
      this.#topicCaches.delete(topicId);
      await existing.watch.stop().catch(() => {});
    }

    const watch = await conversation.watch(context, { min: 80, max: 160 });
    try {
      await repairHistoricalChatAttachments(this.#deps.harness, this.#deps.uploads, queuedChatEntries(watch.value).entries, Number(conversation.id), context);
      await this.#deps.projection.hydrateMessages(watch.value.entries, Number(conversation.id));
      if (this.#deps.runtimeGates.isClosed()) throw new Error("Hub is closed");
    } catch (error) {
      await watch.stop();
      throw error;
    }
    // Another selection of this cold topic may have attached its watch during hydration.
    const attached = this.#topicCaches.get(topicId);
    if (attached && Number(attached.conversation.id) === Number(conversation.id)) { await watch.stop(); return attached; }
    if (attached) {
      this.#topicCaches.delete(topicId);
      await attached.watch.stop().catch(() => {});
    }
    const initialMessages = this.#deps.projection.projectTopicMessages(watch.value, Number(conversation.id));
    const initialLive = redactCredentialData(this.#deps.projection.projectTopicLiveState(watch.value, Number(conversation.id), conversation), (text) => this.#deps.connectionManager.redact(text));
    const cache: WatchedTopicCache = {
      topicId, conversation, watch, messages: initialMessages, live: initialLive,
      notificationBaseline: createTopicNotificationBaseline(initialMessages, initialLive),
    };
    this.#topicCaches.set(topicId, cache);

    watch.start(async (call) => {
      if (call.kind !== "value") return;
      this.refreshContent(cache, call.value);
    });
    return cache;
  }

  async ensureTopicWatchedByConversation(conversationId: number, context: Context): Promise<void> {
    if (this.#deps.runtimeGates.isClosed()) return;
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const topicId = state?.conversationToTopic?.[String(conversationId)];
    if (!topicId) return;
    const topic = state?.topics?.[topicId];
    if (!topic || topic.deletedAt) return;
    if (topic.title) this.#topicTitleCache.set(topicId, topic.title);
    const existing = this.#topicCaches.get(topicId);
    if (existing && Number(existing.conversation.id) === conversationId) return;
    const conversation = await this.#deps.harness.conversation(conversationId as ConversationId, context);
    if (conversation) await this.ensureTopicWatched(topicId, conversation, context);
  }

  refreshContent(cache: WatchedTopicCache, value = cache.watch.value): void {
    if (this.#deps.runtimeGates.isClosed() || this.#topicCaches.get(cache.topicId) !== cache) return;
    const convId = Number(cache.conversation.id);
    const messages = this.#deps.projection.projectTopicMessages(value, convId);
    cache.messages = messages;
    const latestPreview = summarizeTopicPreview(messages);
    if (latestPreview) this.#topicPreviewCache.set(cache.topicId, latestPreview);
    const wasBusy = cache.live.busy;
    cache.live = redactCredentialData(this.#deps.projection.projectTopicLiveState(value, convId, cache.conversation), (text) => this.#deps.connectionManager.redact(text));
    if (wasBusy && !cache.live.busy) {
      this.recordTopicActivity(cache.topicId, latestPreview, convId);
      this.#deps.onTopicIdle?.(cache.topicId, convId, cache.live, value);
    }
    if (!cache.live.busy && value.entries.some((entry) => CompactionEntry.is(entry))) {
      void this.#deps.contextCompaction.pruneCommittedBaseline(cache.conversation.id, BACKGROUND_CONTEXT, false).catch(() => {});
    }
    const notification = detectMainSessionNotification({
      topicId: cache.topicId,
      topicTitle: cache.topicId === "root" ? undefined : this.#topicTitleCache.get(cache.topicId),
      previous: cache.notificationBaseline,
      messages,
      live: cache.live,
      deferReplyNotification: this.#deps.hasPendingMediaRelay?.(convId) ?? false,
      redact: (text) => this.#deps.connectionManager.redact(text),
    });
    cache.notificationBaseline = notification.next;
    this.#deps.voiceCalls.topicUpdated(cache.topicId, messages, cache.live);
    this.#topicTitles.observe(cache.topicId, messages, cache.live.busy || Boolean(cache.live.runFailure));
    const recovering = this.#deps.runtimeGates.isRecovering();
    for (const listener of this.#deps.listeners) {
      listener.onTopicView?.(cache.topicId, messages, cache.live, convId);
      if (cache.topicId === "root") listener.onRootView?.(messages, cache.live);
      if (notification.event && !recovering) listener.onNotification?.(notification.event);
    }
  }

  recordTopicActivity(topicId: string, latestPreview?: { preview: string; at?: number }, expectedConversationId?: number): void {
    const at = Date.now();
    const previous = this.#topicActivityUpdates.get(topicId);
    const update = (async () => {
      await previous;
      const topics = await this.#deps.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const topic = state.topics?.[topicId];
        if (!topic || topic.deletedAt) return undefined;
        if (expectedConversationId !== undefined && topic.conversationId !== expectedConversationId) return undefined;
        let changed = false;
        if (!topic.master && topic.id !== "root") {
          const nextUpdatedAt = Math.max(topic.updatedAt, at);
          if (nextUpdatedAt !== topic.updatedAt) { topic.updatedAt = nextUpdatedAt; changed = true; }
        }
        if (applyTopicPreview(topic, latestPreview, at)) changed = true;
        return changed ? listSortedTopics(state) : undefined;
      }, BACKGROUND_CONTEXT);
      if (topics) this.emitTopics(topics);
    })().catch((error) => {
      console.warn("[KuloTopicArchive] Could not record completed conversation activity", topicId, error);
    }).finally(() => {
      if (this.#topicActivityUpdates.get(topicId) === update) this.#topicActivityUpdates.delete(topicId);
    });
    this.#topicActivityUpdates.set(topicId, update);
  }

  #enrichTopicsWithPreviews(topics: TopicSummary[]): TopicSummary[] {
    return topics.map((topic) => {
      const cached = this.#topicPreviewCache.get(topic.id);
      if (!cached) return topic;
      if (topic.lastMessagePreview && (topic.lastMessageAt ?? 0) >= (cached.at ?? 0)) return topic;
      return { ...topic, lastMessagePreview: cached.preview, ...(cached.at ? { lastMessageAt: cached.at } : {}) };
    });
  }

  emitTopics(topics: TopicSummary[]): void {
    const enriched = this.#enrichTopicsWithPreviews(topics);
    this.#topicTitleCache.clear();
    for (const topic of enriched) {
      if (!topic.deletedAt && topic.title) this.#topicTitleCache.set(topic.id, topic.title);
    }
    for (const listener of this.#deps.listeners) listener.onTopics?.(enriched);
  }
}
