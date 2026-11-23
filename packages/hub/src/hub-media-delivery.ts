import { BACKGROUND_CONTEXT, withCancel, type Context } from "@earendil-works/chord/context";
import {
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  defineDoc,
  type ConversationId,
  type Harness,
  type JsonObject,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { escapeUntrustedText, type ChatAttachment, type MediaJob, type MediaJobSource } from "@kulo/protocol";
import type { KuloCapabilities } from "./capabilities.js";
import { submitAutomaticChatInput } from "./chat-control.js";
import type { HubRuntimeGates, LiveSettingsStore } from "./hub-kernel-ports.js";
import type { HubTopicManager } from "./hub-topic-manager.js";
import { imageSetupIdentifier } from "./image-configuration.js";
import { KuloMediaJobsDoc, type KuloMediaJobs } from "./media-jobs.js";
import {
  BUSY_RECHECK_FALLBACK_MS,
  DEFAULT_BATCH_COALESCE_MAX_MS,
  buildMediaRelayBatch,
  collectActiveDirectSiblings,
  enqueuePendingMediaRelay,
  formatMediaFallbackNotice,
  hasDifferentCapabilitySibling,
  pruneMediaNotices,
  sanitizeMediaError,
  type MediaNoticesState,
  type MediaRelayStatus,
  type PendingMediaRelayRef,
} from "./media-relay-policy.js";
import type { KuloProjects } from "./projects.js";
import type { SettingsAssistant } from "./settings-assistant.js";
import {
  SettingsAssistantDoc,
  isActiveSettingsConversation,
  parseSettingsTopicConversationId,
  settingsTopicId,
} from "./settings-doc.js";
import {
  KuloStateDoc,
  MediaRelayEntry,
  WorkerRelayEntry,
  applyTopicPreview,
  isOrchestratorConversation,
  isTicketUnfinished,
  resolveTicketExecutionScope,
  summarizeTopicPreview,
  type MediaRelayJobSummary,
} from "./state.js";
import { injectEventToolsInTx } from "./tool-surface.js";
import {
  ContentPublicationEntry,
  UiCardError,
  type ContentPublicationData,
  type KuloUiCards,
} from "./ui-cards.js";
import type { KuloUploadStore } from "./uploads.js";

export type { MediaNoticesState, MediaRelayStatus, PendingMediaRelayRef };

export const MediaNoticesDoc = defineDoc<MediaNoticesState & JsonObject>({
  kind: "kulo.media-notices",
  version: 1,
  scope: "session",
  initial: () => ({ notices: {} }) as MediaNoticesState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export interface HubMediaDeliveryDeps {
  harness: Harness;
  getRootConversationId: () => number;
  uploads: KuloUploadStore;
  uiCards: KuloUiCards;
  mediaJobs: () => KuloMediaJobs;
  capabilities: Pick<KuloCapabilities, "snapshot">;
  liveSettings: Pick<LiveSettingsStore, "getModel">;
  redact: (text: string) => string;
  projects: Pick<KuloProjects, "get">;
  settingsAssistant: Pick<SettingsAssistant, "refreshIfConversation">;
  topics: Pick<HubTopicManager, "refreshTopic" | "ensureTopicWatchedByConversation">;
  runtimeGates: Pick<
    HubRuntimeGates,
    "isClosed" | "isRecovering" | "isHandoverBarrierActive" | "resumeIfNotRecovering" | "broadcastTickets"
  >;
  ticketWaitPort: {
    queueWaitReconcile: () => Promise<void>;
    resumeWaitingTicket: (ticketId: string, context: Context) => Promise<void>;
  };
}

export class HubMediaDelivery {
  readonly #deps: HubMediaDeliveryDeps;
  readonly #lifetime = withCancel(BACKGROUND_CONTEXT);
  readonly #flushChains = new Map<string, Promise<void>>();
  readonly #flushTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number }>();
  readonly #pendingRelayCounts = new Map<number, number>();
  readonly #fallbackWaiters = new Set<Promise<void>>();
  #batchCoalesceMaxMs = DEFAULT_BATCH_COALESCE_MAX_MS;
  #busyRecheckMs = BUSY_RECHECK_FALLBACK_MS;
  #closed = false;

  constructor(deps: HubMediaDeliveryDeps) {
    this.#deps = deps;
  }

  /** Internal test hook to exercise soft-timeout and busy-recheck paths without slow sleeps. */
  setRelayTimingForTest(options: { batchCoalesceMaxMs?: number; busyRecheckMs?: number }): void {
    if (options.batchCoalesceMaxMs !== undefined) this.#batchCoalesceMaxMs = options.batchCoalesceMaxMs;
    if (options.busyRecheckMs !== undefined) this.#busyRecheckMs = options.busyRecheckMs;
  }

  hasPendingRelay(conversationId: number): boolean {
    return (this.#pendingRelayCounts.get(conversationId) ?? 0) > 0;
  }

  pendingRelayCount(): number {
    let total = 0;
    for (const count of this.#pendingRelayCounts.values()) total += count;
    return total;
  }

  onConversationIdle(conversationId: number): void {
    if (!this.hasPendingRelay(conversationId)) return;
    void this.#reconcileConversationRelay(conversationId).catch(() => {});
  }

  async onConversationDeleted(conversationId: number): Promise<void> {
    const convKey = String(conversationId);
    this.#clearTimer(convKey);
    this.#pendingRelayCounts.delete(conversationId);
    if (this.#closed || this.#deps.runtimeGates.isClosed()) return;
    await this.#deps.harness.commit(async (tx) => {
      const notices = await tx.doc(MediaNoticesDoc);
      if (notices.pendingRelays && Object.hasOwn(notices.pendingRelays, convKey)) {
        delete notices.pendingRelays[convKey];
      }
    }, BACKGROUND_CONTEXT).catch(() => {});
  }

  async reconcilePendingRelays(): Promise<void> {
    if (this.#isStopped()) return;
    const doc = await this.#deps.harness.snapshot(MediaNoticesDoc, BACKGROUND_CONTEXT);
    for (const [convKey, items] of Object.entries(doc?.pendingRelays ?? {})) {
      const convId = Number(convKey);
      if (!Number.isSafeInteger(convId) || convId <= 0 || !items.length) continue;
      this.#pendingRelayCounts.set(convId, items.length);
      await this.#reconcileConversationRelay(convId);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#lifetime.cancel();
    for (const entry of this.#flushTimers.values()) clearTimeout(entry.timer);
    this.#flushTimers.clear();
    await Promise.allSettled([...this.#flushChains.values(), ...this.#fallbackWaiters]);
  }

  #isStopped(): boolean {
    return (
      this.#closed ||
      this.#deps.runtimeGates.isClosed() ||
      this.#deps.runtimeGates.isRecovering() ||
      this.#deps.runtimeGates.isHandoverBarrierActive()
    );
  }

  #clearTimer(convKey: string): void {
    const existing = this.#flushTimers.get(convKey);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.#flushTimers.delete(convKey);
  }

  #scheduleFlush(convKey: string, conversationId: number, delayMs: number): void {
    if (this.#closed || this.#deps.runtimeGates.isClosed()) return;
    const bounded = Math.max(20, Math.round(delayMs));
    const nextDueAt = Date.now() + bounded;
    const existing = this.#flushTimers.get(convKey);
    if (existing && existing.dueAt <= nextDueAt) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.#flushTimers.delete(convKey);
      void this.#reconcileConversationRelay(conversationId).catch(() => {});
    }, bounded);
    timer.unref?.();
    this.#flushTimers.set(convKey, { timer, dueAt: nextDueAt });
  }

  #setPendingCount(conversationId: number, count: number): void {
    if (count > 0) this.#pendingRelayCounts.set(conversationId, count);
    else this.#pendingRelayCounts.delete(conversationId);
  }

  async mediaSource(conversationId: number): Promise<MediaJobSource> {
    const state = await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    if (isOrchestratorConversation(conversationId as ConversationId, state)) {
      const topicId = state?.conversationToTopic?.[String(conversationId)] ?? "root";
      const topic = state?.topics?.[topicId];
      if (!topic || topic.deletedAt) throw new Error("会话已删除。");
      return { conversationId, topicId, ...(topic.projectId ? { projectId: topic.projectId } : {}) };
    }
    const settings = await this.#deps.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    if (isActiveSettingsConversation(conversationId, settings)) {
      return { conversationId, topicId: settingsTopicId(conversationId) };
    }
    const scope = resolveTicketExecutionScope(state, conversationId as ConversationId);
    if (!scope || scope.ticket.status !== "running") throw new Error("当前任务没有有效执行资格。");
    return {
      conversationId,
      topicId: scope.ticket.originTopicId ?? "root",
      ticketId: scope.ticket.id,
      ...(scope.ticket.projectId ? { projectId: scope.ticket.projectId } : {}),
      envId: scope.ticket.envId,
      runEpoch: scope.ticket.runEpoch,
      readOnly: scope.readOnly,
    };
  }

  async validateMediaInput(assetId: string, source: MediaJobSource): Promise<void> {
    const state = await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const scopes = new Set([`conversation:${source.conversationId}`]);
    if (source.ticketId) {
      const ticket = state?.tickets[source.ticketId];
      if (!ticket || ["stopped", "closed"].includes(ticket.status)) throw new Error("任务执行资格已失效。");
      scopes.add(`conversation:${ticket.workerConversationId}`);
      if (ticket.originConversationId !== undefined) scopes.add(`conversation:${ticket.originConversationId}`);
    }
    const loaded = this.#deps.uploads.getUpload(assetId);
    if (loaded?.record.internalOnly) throw new Error("内部溢出资产不可作为媒体参考素材。");
    if (!this.#deps.uploads.canReadUpload(assetId, `agent:${source.conversationId}`, (scope) => scopes.has(scope))) {
      throw new Error("无权使用此参考素材。");
    }
  }

  async validateMediaSource(source: MediaJobSource, job?: MediaJob): Promise<void> {
    if (source.setupClientId) {
      imageSetupIdentifier(source.setupClientId, "窗口标识");
      if (source.topicId !== "root" || source.ticketId) {
        throw new Error("图像测试来源无效。");
      }
      // Setup image test jobs stay valid across main-conversation rotations.
      return;
    }
    const state = await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const settingsConvId = parseSettingsTopicConversationId(source.topicId);
    if (settingsConvId !== null) {
      const settings = await this.#deps.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (!isActiveSettingsConversation(settingsConvId, settings)) throw new Error("生成来源会话已删除。");
      if (!source.ticketId) {
        if (settingsConvId !== source.conversationId) throw new Error("生成来源无效。");
        return;
      }
    } else {
      const topic = state?.topics?.[source.topicId];
      if (!topic || topic.deletedAt) throw new Error("生成来源会话已删除。");
      if (!source.ticketId) {
        if (Number(topic.conversationId) !== source.conversationId) throw new Error("生成来源无效。");
        return;
      }
    }
    const ticket = state?.tickets[source.ticketId];
    if (!ticket || !isTicketUnfinished(ticket) || (ticket.originTopicId ?? "root") !== source.topicId) {
      throw new Error("生成所属任务已停止或关闭。");
    }
    const live = ticket.status === "running" && ticket.runEpoch === source.runEpoch;
    // Login or review changes the wait reason, while the original media association remains valid.
    const waiting =
      !!job &&
      ["running", "pausing", "waiting"].includes(ticket.status) &&
      (ticket.waiting?.reason === "external" || ticket.waiting?.reason === "user") &&
      ticket.waiting.externalJobIds?.includes(job.id);
    if (!live && !waiting) throw new Error("生成所属任务的执行资格已失效。");
    if (ticket.projectId) {
      const project = await this.#deps.projects.get(ticket.projectId);
      if (project.grantRevision !== ticket.grantRevision) throw new Error("项目授权已变化，请重新确认任务。");
    }
  }

  async onMediaSettled(job: MediaJob): Promise<void> {
    if (job.source.setupClientId) return;
    const needsUser = job.status === "needs_user" || job.status === "needs_reconciliation";
    const safeDetail = sanitizeMediaError(job.error, this.#deps.redact) ?? job.id;
    const message = `媒体作业${needsUser ? "需要处理" : job.status === "stopped" ? "已停止跟踪" : "失败"}：${safeDetail}`;
    const noticeKey = `${job.id}:${job.status}:${job.updatedAt}`;
    let wakeTicket: string | undefined;
    let reconcileConvId: number | undefined;
    let updatedPendingCount: number | undefined;
    const [snapshot, settingsSnapshot] = await Promise.all([
      this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT),
      this.#deps.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT),
    ]);
    const settingsConvId = parseSettingsTopicConversationId(job.source.topicId);
    const recipientId = settingsConvId ?? snapshot?.topics?.[job.source.topicId]?.conversationId;
    const recipient =
      job.source.ticketId && recipientId !== undefined
        ? await this.#deps.harness.conversation(recipientId as ConversationId, BACKGROUND_CONTEXT)
        : undefined;
    const hasDefaultModel = Boolean(this.#deps.liveSettings.getModel().defaultModel?.trim());
    await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const settingsDoc = await tx.doc(SettingsAssistantDoc);
      const notices = await tx.doc(MediaNoticesDoc);
      if (notices.notices[noticeKey]) return;
      const ticket = job.source.ticketId ? state.tickets[job.source.ticketId] : undefined;
      const directTopicId = !ticket && settingsConvId === null ? state.conversationToTopic?.[String(job.source.conversationId)] : undefined;
      const topic = ticket
        ? state.topics?.[ticket.originTopicId ?? job.source.topicId]
        : directTopicId
          ? state.topics?.[directTopicId]
          : state.topics?.[job.source.topicId];
      const targetConvId =
        settingsConvId !== null
          ? isActiveSettingsConversation(settingsConvId, settingsDoc)
            ? settingsConvId
            : undefined
          : ticket
            ? !topic || topic.deletedAt || topic.archived || (ticket.originConversationId !== undefined && Number(topic.conversationId) !== ticket.originConversationId)
              ? undefined
              : Number(topic.conversationId)
            : !topic || topic.deletedAt || topic.archived || Number(topic.conversationId) !== job.source.conversationId
              ? undefined
              : Number(topic.conversationId);
      if (targetConvId === undefined || (job.source.ticketId && (!ticket || ["stopped", "closed"].includes(ticket.status)))) {
        notices.notices[noticeKey] = true;
        pruneMediaNotices(notices);
        return;
      }
      if (!ticket) {
        if (settingsConvId === null && job.status === "stopped") {
          notices.notices[noticeKey] = true;
          pruneMediaNotices(notices);
          reconcileConvId = targetConvId;
          return;
        }
        if (settingsConvId !== null || !hasDefaultModel) {
          notices.notices[noticeKey] = true;
          pruneMediaNotices(notices);
          const now = Date.now();
          await tx.appendEntry(ContentPublicationEntry, targetConvId as ConversationId, {
            data: {
              parts: [{ partId: `media-notice:${noticeKey}`, type: "markdown", text: message }],
              fallbackText: message,
              createdAt: now,
            } as unknown as ContentPublicationData & JsonObject,
          });
          if (settingsConvId === null && topic && !topic.deletedAt) {
            applyTopicPreview(topic, summarizeTopicPreview([{ role: "assistant", text: message, createdAt: now }]), now);
          }
          return;
        }
        updatedPendingCount = enqueuePendingMediaRelay(notices, String(targetConvId), {
          eventKey: noticeKey,
          jobId: job.id,
          topicId: job.source.topicId,
          status: job.status as MediaRelayStatus,
          settledAt: Date.now(),
        });
        reconcileConvId = targetConvId;
        return;
      }
      notices.notices[noticeKey] = true;
      pruneMediaNotices(notices);
      if (needsUser && recipient?.id === targetConvId) {
        await submitAutomaticChatInput(tx, recipient, {
          type: "input",
          whenBusy: "followUp",
          requestId: `kulo:media-review:${noticeKey}`,
          content: `[KULO_WORKER_RELAY]\nBackground media job requires coordinator attention: ${escapeUntrustedText(message)}\nVerify the actual issue first before deciding whether to inform the user; this notice grants no extra execution permissions.`,
          entry: {
            kind: WorkerRelayEntry.kind,
            data: {
              ticketId: ticket.id,
              title: ticket.title,
              role: ticket.role,
              state: "blocked",
              summary: message,
              deliverable: null,
              question: message,
            },
          },
        });
      }
      if ((ticket?.waiting?.reason === "external" || ticket?.waiting?.reason === "user") && ticket.waiting.externalJobIds?.includes(job.id)) {
        if (needsUser) {
          ticket.waiting.reason = "user";
          ticket.waiting.detail = message;
          ticket.latestReport = { state: "blocked", summary: message, question: message, at: Date.now() };
        } else {
          ticket.waiting.externalJobIds = ticket.waiting.externalJobIds.filter((id) => id !== job.id);
          ticket.wakePending = true;
          ticket.resumePrompt = [
            ticket.resumePrompt,
            message,
            "Inspect the original job via kulo_media_job rather than resubmitting a paid generation.",
          ].filter(Boolean).join("\n");
          wakeTicket = ticket.id;
        }
      }
    }, BACKGROUND_CONTEXT);
    if (reconcileConvId !== undefined && updatedPendingCount !== undefined) {
      this.#setPendingCount(reconcileConvId, updatedPendingCount);
    }
    this.#deps.topics.refreshTopic(job.source.topicId);
    if (settingsConvId !== null && isActiveSettingsConversation(settingsConvId, settingsSnapshot)) {
      await this.#deps.settingsAssistant.refreshIfConversation(settingsConvId);
    }
    if (reconcileConvId !== undefined) void this.#reconcileConversationRelay(reconcileConvId).catch(() => {});
    if (wakeTicket && !this.#deps.runtimeGates.isRecovering()) {
      await this.#deps.ticketWaitPort.queueWaitReconcile();
      await this.#deps.ticketWaitPort.resumeWaitingTicket(wakeTicket, BACKGROUND_CONTEXT);
    }
    await this.#deps.runtimeGates.broadcastTickets(BACKGROUND_CONTEXT);
  }

  async onMediaCompleted(job: MediaJob): Promise<void> {
    if (job.source.setupClientId) {
      await this.#deps.mediaJobs().markDelivered(job.id);
      return;
    }
    const [state, settingsDoc] = await Promise.all([
      this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT),
      this.#deps.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT),
    ]);
    const settingsConvId = parseSettingsTopicConversationId(job.source.topicId);
    const ticket = job.source.ticketId ? state?.tickets[job.source.ticketId] : undefined;
    const directTopicId = !ticket && settingsConvId === null ? state?.conversationToTopic?.[String(job.source.conversationId)] : undefined;
    const topic = ticket
      ? state?.topics?.[ticket.originTopicId ?? job.source.topicId]
      : directTopicId
        ? state?.topics?.[directTopicId]
        : state?.topics?.[job.source.topicId];
    const targetConvId =
      settingsConvId !== null
        ? isActiveSettingsConversation(settingsConvId, settingsDoc)
          ? settingsConvId
          : undefined
        : ticket
          ? !topic || topic.deletedAt || topic.archived || (ticket.originConversationId !== undefined && Number(topic.conversationId) !== ticket.originConversationId)
            ? undefined
            : Number(topic.conversationId)
          : !topic || topic.deletedAt || topic.archived || Number(topic.conversationId) !== job.source.conversationId
            ? undefined
            : Number(topic.conversationId);
    if (targetConvId === undefined || (job.source.ticketId && (!ticket || ["stopped", "closed"].includes(ticket.status)))) {
      await this.#deps.mediaJobs().markDelivered(job.id);
      return;
    }
    const conversationId = targetConvId;
    const isMainDirectChat = !ticket && settingsConvId === null;
    const multiCapCaption = isMainDirectChat ? await this.#resolveMultiCapabilityCaption(job, conversationId) : undefined;
    for (const [index, asset] of job.assets.entries()) {
      if (ticket) {
        await this.stageWorkerArtifact(asset, job.source, `media-result:${job.id}:${asset.id}`);
        continue;
      }
      this.#deps.uploads.bindAttachments(
        [asset],
        `conversation:${conversationId}`,
        `agent:${job.source.conversationId}`,
        (scope) => scope === `conversation:${job.source.conversationId}`,
      );
      const publishSource = {
        conversationId,
        callId: `media-result:${job.id}:${asset.id}`,
        topicId: job.source.topicId,
      };
      if (await this.#deps.uiCards.hasPublishedOperation(publishSource)) continue;
      const caption = index === 0 ? multiCapCaption : undefined;
      await this.#deps.uiCards.publishAsset(
        { path: `media-job:${job.id}:${asset.id}`, name: asset.name, ...(caption ? { caption } : {}) },
        publishSource,
        async () => asset,
      );
    }
    let queuedCount: number | undefined;
    if (isMainDirectChat && Boolean(this.#deps.liveSettings.getModel().defaultModel?.trim())) {
      const eventKey = `${job.id}:completed`;
      queuedCount = await this.#deps.harness.commit(async (tx) => {
        const currentState = await tx.doc(KuloStateDoc);
        const currentTopic = currentState.topics?.[job.source.topicId];
        if (!currentTopic || currentTopic.deletedAt || Number(currentTopic.conversationId) !== conversationId) {
          return undefined;
        }
        const notices = await tx.doc(MediaNoticesDoc);
        return enqueuePendingMediaRelay(notices, String(conversationId), {
          eventKey,
          jobId: job.id,
          topicId: job.source.topicId,
          status: "completed",
          settledAt: Date.now(),
        });
      }, BACKGROUND_CONTEXT);
      if (queuedCount !== undefined) this.#setPendingCount(conversationId, queuedCount);
    }
    this.#deps.topics.refreshTopic(job.source.topicId);
    if (settingsConvId !== null) await this.#deps.settingsAssistant.refreshIfConversation(settingsConvId);
    if (ticket) {
      await this.#deps.harness.commit(async (tx) => {
        const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
        if (
          !current ||
          ["stopped", "closed"].includes(current.status) ||
          !(current.waiting?.reason === "external" || current.waiting?.reason === "user") ||
          !current.waiting.externalJobIds?.includes(job.id)
        ) {
          return;
        }
        current.waiting.externalJobIds = current.waiting.externalJobIds.filter((id) => id !== job.id);
        current.wakePending = true;
        current.resumeAttachmentIds = [
          ...new Set([...(current.resumeAttachmentIds ?? []), ...job.assets.map((asset) => asset.id)]),
        ];
        current.resumePrompt = [
          current.resumePrompt,
          `Media job ${job.id} completed with asset(s): ${job.assets.map((asset) => asset.id).join(", ")}. Assets are staged privately (not yet published to the user)—reuse them and submit via kulo_report for coordinator review (use kulo_media_export to write into the project workspace; do not regenerate).`,
        ].filter(Boolean).join("\n");
        await injectEventToolsInTx(
          tx,
          current.workerConversationId,
          current.readOnly ? ["kulo_publish_asset"] : ["kulo_media_export", "kulo_publish_asset"],
        );
      }, BACKGROUND_CONTEXT);
      if (!this.#deps.runtimeGates.isRecovering()) {
        await this.#deps.ticketWaitPort.queueWaitReconcile();
        await this.#deps.ticketWaitPort.resumeWaitingTicket(ticket.id, BACKGROUND_CONTEXT);
      }
    }
    await this.#deps.mediaJobs().markDelivered(job.id);
    if (isMainDirectChat && queuedCount !== undefined) {
      void this.#reconcileConversationRelay(conversationId).catch(() => {});
    }
  }

  async #resolveMultiCapabilityCaption(job: MediaJob, conversationId: number): Promise<string | undefined> {
    const [jobsDoc, noticesDoc, capSnapshot] = await Promise.all([
      this.#deps.harness.snapshot(KuloMediaJobsDoc, BACKGROUND_CONTEXT),
      this.#deps.harness.snapshot(MediaNoticesDoc, BACKGROUND_CONTEXT),
      this.#deps.capabilities.snapshot().catch(() => undefined),
    ]);
    const isMulti = hasDifferentCapabilitySibling(
      job,
      conversationId,
      Object.values(jobsDoc?.jobs ?? {}),
      noticesDoc?.pendingRelays?.[String(conversationId)] ?? [],
    );
    if (!isMulti) return undefined;
    return capSnapshot?.capabilities.find((c) => c.id === job.capabilityId)?.name?.trim() || job.modelId;
  }

  async #reconcileConversationRelay(conversationId: number): Promise<void> {
    const convKey = String(conversationId);
    const previous = this.#flushChains.get(convKey) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#flushConversationRelay(conversationId));
    this.#flushChains.set(convKey, current);
    void current.finally(() => {
      if (this.#flushChains.get(convKey) === current) this.#flushChains.delete(convKey);
    });
    return current;
  }

  async #flushConversationRelay(conversationId: number): Promise<void> {
    if (this.#isStopped()) return;
    const convKey = String(conversationId);
    const [capSnapshot, recipient] = await Promise.all([
      this.#deps.capabilities.snapshot().catch(() => undefined),
      this.#deps.harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT),
    ]);
    if (this.#isStopped()) return;
    if (recipient) {
      await this.#deps.topics.ensureTopicWatchedByConversation(conversationId, BACKGROUND_CONTEXT).catch(() => {});
    }
    const capabilityNames = new Map((capSnapshot?.capabilities ?? []).map((item) => [item.id, item.name.trim()] as const));
    type FlushOutcome =
      | { action: "idle" | "discarded" }
      | { action: "defer"; delayMs: number; count: number }
      | { action: "flushed"; topicId: string; batchKey: string; submissionId?: SubmissionId; failedSummaries: MediaRelayJobSummary[] };
    const outcome = await this.#deps.harness.commit<FlushOutcome>(async (tx) => {
      const notices = await tx.doc(MediaNoticesDoc);
      const rawQueue = notices.pendingRelays?.[convKey];
      if (!rawQueue?.length) {
        if (notices.pendingRelays) delete notices.pendingRelays[convKey];
        return { action: "idle" };
      }
      const state = await tx.doc(KuloStateDoc);
      const topicId = state.conversationToTopic?.[convKey] ?? rawQueue[0]!.topicId;
      const topic = state.topics?.[topicId];
      if (!recipient || !topic || topic.deletedAt || Number(topic.conversationId) !== conversationId) {
        delete notices.pendingRelays![convKey];
        return { action: "discarded" };
      }
      const queue = rawQueue.filter((item) => !notices.notices[item.eventKey]);
      if (!queue.length) {
        delete notices.pendingRelays![convKey];
        return { action: "idle" };
      }
      const isPaused = Boolean(state.pausedChats?.[convKey]);
      if (!isPaused) {
        const live = await tx.doc(LiveDoc, conversationId as ConversationId);
        const inbox = await tx.doc(InboxDoc, conversationId as ConversationId);
        if (live.run !== undefined || inbox.items.length > 0) {
          return { action: "defer", delayMs: this.#busyRecheckMs, count: queue.length };
        }
      }
      const jobsDoc = await tx.doc(KuloMediaJobsDoc);
      const queuedIds = new Set(queue.map((item) => item.jobId));
      const queuedKinds = new Set<"image" | "video">(queue.map((item) => jobsDoc.jobs[item.jobId]?.kind ?? "image"));
      const activeSiblings = collectActiveDirectSiblings(Object.values(jobsDoc.jobs), conversationId, queuedIds);
      const blockingSiblings = activeSiblings.filter((candidate) => queuedKinds.has(candidate.kind));
      const now = Date.now();
      const oldestSettledAt = Math.min(...queue.map((item) => item.settledAt));
      if (blockingSiblings.length > 0 && now - oldestSettledAt < this.#batchCoalesceMaxMs) {
        return { action: "defer", delayMs: Math.max(50, this.#batchCoalesceMaxMs - (now - oldestSettledAt)), count: queue.length };
      }
      const batch = buildMediaRelayBatch({
        convKey,
        queue,
        jobsById: jobsDoc.jobs,
        activeSiblings,
        capabilityNames,
        redact: this.#deps.redact,
      });
      await injectEventToolsInTx(tx, conversationId as ConversationId, ["kulo_inspect_asset", "kulo_media_job"]);
      const submissionId = await submitAutomaticChatInput(tx, recipient, {
        type: "input",
        whenBusy: "followUp",
        requestId: batch.requestId,
        content: batch.content,
        entry: { kind: MediaRelayEntry.kind, data: { batchKey: batch.batchKey, jobs: batch.summaries, createdAt: now } },
      });
      for (const item of batch.sorted) notices.notices[item.eventKey] = true;
      delete notices.pendingRelays![convKey];
      pruneMediaNotices(notices);
      return { action: "flushed", topicId, batchKey: batch.batchKey, submissionId, failedSummaries: batch.failedSummaries };
    }, BACKGROUND_CONTEXT);

    if (outcome.action === "defer") {
      this.#setPendingCount(conversationId, outcome.count);
      this.#scheduleFlush(convKey, conversationId, outcome.delayMs);
      return;
    }
    this.#clearTimer(convKey);
    this.#setPendingCount(conversationId, 0);
    if (outcome.action === "flushed") {
      this.#deps.runtimeGates.resumeIfNotRecovering();
      this.#deps.topics.refreshTopic(outcome.topicId);
      if (outcome.submissionId !== undefined && outcome.failedSummaries.length > 0) {
        this.#watchRelayFallback(conversationId, outcome.topicId, outcome.batchKey, outcome.submissionId, outcome.failedSummaries);
      }
    }
  }

  #watchRelayFallback(
    conversationId: number,
    topicId: string,
    batchKey: string,
    submissionId: SubmissionId,
    failedSummaries: readonly MediaRelayJobSummary[],
  ): void {
    const task = (async () => {
      try {
        const sub = await this.#deps.harness.submission(submissionId, this.#lifetime.context);
        if (!sub) return;
        const settled = await sub.wait(this.#lifetime.context);
        if (this.#closed || this.#deps.runtimeGates.isClosed()) return;
        if (settled.status !== "unanswered" || settled.reason === "aborted") return;
        const fallbackKey = `fallback:${batchKey}`;
        const message = formatMediaFallbackNotice(failedSummaries);
        await this.#deps.harness.commit(async (tx) => {
          const notices = await tx.doc(MediaNoticesDoc);
          if (notices.notices[fallbackKey]) return;
          const state = await tx.doc(KuloStateDoc);
          const topic = state.topics?.[topicId];
          if (!topic || topic.deletedAt || Number(topic.conversationId) !== conversationId) return;
          notices.notices[fallbackKey] = true;
          pruneMediaNotices(notices);
          const now = Date.now();
          await tx.appendEntry(ContentPublicationEntry, conversationId as ConversationId, {
            data: {
              parts: [{ partId: `media-fallback:${batchKey}`, type: "markdown", text: message }],
              fallbackText: message,
              createdAt: now,
            } as unknown as ContentPublicationData & JsonObject,
          });
          applyTopicPreview(topic, summarizeTopicPreview([{ role: "assistant", text: message, createdAt: now }]), now);
        }, BACKGROUND_CONTEXT);
        this.#deps.topics.refreshTopic(topicId);
      } catch {
        /* Cancelled during close or transient teardown. */
      }
    })();
    this.#fallbackWaiters.add(task);
    void task.finally(() => {
      this.#fallbackWaiters.delete(task);
    });
  }

  async stageWorkerArtifact(asset: ChatAttachment, source: MediaJobSource, callId: string): Promise<void> {
    if (!source.ticketId) throw new UiCardError("content_scope_denied", "产物缺少 Worker 任务归属。", 403);
    const [snapshot, settingsSnapshot] = await Promise.all([
      this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT),
      this.#deps.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT),
    ]);
    const ticket = snapshot?.tickets[source.ticketId];
    const settingsConvId = parseSettingsTopicConversationId(source.topicId);
    const topicValid =
      settingsConvId !== null
        ? isActiveSettingsConversation(settingsConvId, settingsSnapshot)
        : Boolean(snapshot?.topics?.[source.topicId] && !snapshot.topics[source.topicId]!.deletedAt);
    if (!ticket || ["stopped", "closed"].includes(ticket.status) || !topicValid || (ticket.originTopicId ?? "root") !== source.topicId) {
      throw new UiCardError("content_scope_denied", "产物所属任务或聊天已失效。", 403);
    }
    await this.#deps.uiCards.stageAsset(
      { path: `worker-asset:${asset.id}`, name: asset.name },
      { conversationId: ticket.workerConversationId, callId, ticketId: ticket.id, topicId: source.topicId },
      async () => asset,
      async (tx, staged) => {
        const state = await tx.doc(KuloStateDoc);
        const settingsDoc = await tx.doc(SettingsAssistantDoc);
        const current = state.tickets[ticket.id];
        const originValid =
          settingsConvId !== null
            ? isActiveSettingsConversation(settingsConvId, settingsDoc)
            : Boolean(state.topics?.[source.topicId] && !state.topics[source.topicId]!.deletedAt);
        if (
          !current ||
          ["stopped", "closed"].includes(current.status) ||
          !originValid ||
          current.workerConversationId !== ticket.workerConversationId ||
          current.runEpoch !== ticket.runEpoch ||
          (current.originTopicId ?? "root") !== source.topicId
        ) {
          throw new UiCardError("content_scope_denied", "产物所属任务已变更。", 403);
        }
        this.#deps.uploads.bindAttachments(
          [staged],
          `conversation:${current.workerConversationId}`,
          `agent:${source.conversationId}`,
          (scope) => scope === `conversation:${source.conversationId}`,
        );
        this.#deps.uploads.bindAttachments(
          [staged],
          `ticket:${current.id}`,
          `agent:${source.conversationId}`,
          (scope) => scope === `conversation:${source.conversationId}`,
        );
        state.workerArtifacts ??= {};
        const artifacts = state.workerArtifacts[current.id] ?? [];
        if (!artifacts.some((entry) => entry.id === staged.id)) {
          state.workerArtifacts[current.id] = [...artifacts, staged];
        }
        const originConvId = settingsConvId ?? state.topics?.[source.topicId]?.conversationId ?? Number(ROOT_CONVERSATION_ID);
        await injectEventToolsInTx(tx, originConvId, ["kulo_inspect_asset", "kulo_publish_asset"]);
      },
    );
  }
}
