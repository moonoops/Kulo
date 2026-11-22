import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  defineDoc,
  type ConversationId,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import type { ChatAttachment, MediaJob, MediaJobSource } from "@kulo/protocol";
import { submitAutomaticChatInput } from "./chat-control.js";
import type { HubRuntimeGates } from "./hub-kernel-ports.js";
import type { HubTopicManager } from "./hub-topic-manager.js";
import { imageSetupIdentifier } from "./image-configuration.js";
import type { KuloMediaJobs } from "./media-jobs.js";
import type { KuloProjects } from "./projects.js";
import {
  SettingsAssistantDoc,
  isActiveSettingsConversation,
  parseSettingsTopicConversationId,
  settingsTopicId,
  type SettingsAssistant,
} from "./settings-assistant.js";
import {
  KuloStateDoc,
  WorkerRelayEntry,
  applyTopicPreview,
  isOrchestratorConversation,
  isTicketUnfinished,
  resolveTicketExecutionScope,
  summarizeTopicPreview,
} from "./state.js";
import { injectEventToolsInTx } from "./tool-surface.js";
import {
  ContentPublicationEntry,
  UiCardError,
  type ContentPublicationData,
  type KuloUiCards,
} from "./ui-cards.js";
import type { KuloUploadStore } from "./uploads.js";

export const MediaNoticesDoc = defineDoc<{ notices: Record<string, boolean> } & JsonObject>({
  kind: "kulo.media-notices",
  version: 1,
  scope: "session",
  initial: () => ({ notices: {} }) as { notices: Record<string, boolean> } & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export interface HubMediaDeliveryDeps {
  harness: Harness;
  rootConversationId: number;
  uploads: KuloUploadStore;
  uiCards: KuloUiCards;
  mediaJobs: () => KuloMediaJobs;
  projects: Pick<KuloProjects, "get">;
  settingsAssistant: Pick<SettingsAssistant, "refreshIfConversation">;
  topics: Pick<HubTopicManager, "refreshTopic">;
  runtimeGates: Pick<HubRuntimeGates, "isRecovering" | "broadcastTickets">;
  ticketWaitPort: {
    queueWaitReconcile: () => Promise<void>;
    resumeWaitingTicket: (ticketId: string, context: Context) => Promise<void>;
  };
}

export class HubMediaDelivery {
  readonly #deps: HubMediaDeliveryDeps;

  constructor(deps: HubMediaDeliveryDeps) {
    this.#deps = deps;
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
    if (loaded?.record.internalOnly) {
      throw new Error("内部溢出资产不可作为媒体参考素材。");
    }
    if (!this.#deps.uploads.canReadUpload(assetId, `agent:${source.conversationId}`, (scope) => scopes.has(scope))) {
      throw new Error("无权使用此参考素材。");
    }
  }

  async validateMediaSource(source: MediaJobSource, job?: MediaJob): Promise<void> {
    if (source.setupClientId) {
      imageSetupIdentifier(source.setupClientId, "窗口标识");
      if (source.conversationId !== this.#deps.rootConversationId || source.topicId !== "root" || source.ticketId) {
        throw new Error("图像测试来源无效。");
      }
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
      if (project.grantRevision !== ticket.grantRevision) {
        throw new Error("项目授权已变化，请重新确认任务。");
      }
    }
  }

  async onMediaSettled(job: MediaJob): Promise<void> {
    if (job.source.setupClientId) return;
    const needsUser = job.status === "needs_user" || job.status === "needs_reconciliation";
    const message = `媒体作业${needsUser ? "需要处理" : job.status === "stopped" ? "已停止跟踪" : "失败"}：${job.error ?? job.id}`;
    const noticeKey = `${job.id}:${job.status}:${job.updatedAt}`;
    let wakeTicket: string | undefined;
    const snapshot = await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const settingsSnapshot = await this.#deps.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const settingsConvId = parseSettingsTopicConversationId(job.source.topicId);
    const recipientId = settingsConvId ?? snapshot?.topics?.[job.source.topicId]?.conversationId;
    const recipient =
      job.source.ticketId && recipientId !== undefined
        ? await this.#deps.harness.conversation(recipientId as ConversationId, BACKGROUND_CONTEXT)
        : undefined;
    await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const settingsDoc = await tx.doc(SettingsAssistantDoc);
      const notices = await tx.doc(MediaNoticesDoc);
      if (notices.notices[noticeKey]) return;
      const topic = state.topics?.[job.source.topicId];
      const targetConvId =
        settingsConvId !== null
          ? isActiveSettingsConversation(settingsConvId, settingsDoc)
            ? settingsConvId
            : undefined
          : !topic || topic.deletedAt
            ? undefined
            : Number(topic.conversationId);
      const ticket = job.source.ticketId ? state.tickets[job.source.ticketId] : undefined;
      notices.notices[noticeKey] = true;
      if (targetConvId === undefined || (job.source.ticketId && (!ticket || ["stopped", "closed"].includes(ticket.status)))) {
        return;
      }
      if (!ticket) {
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
      } else if (needsUser && recipient?.id === targetConvId) {
        await submitAutomaticChatInput(tx, recipient, {
          type: "input",
          whenBusy: "followUp",
          requestId: `kulo:media-review:${noticeKey}`,
          content: `[KULO_WORKER_RELAY]\nBackground media job requires coordinator attention: ${message}\nVerify the actual issue first before deciding whether to inform the user; this notice grants no extra execution permissions.`,
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
    this.#deps.topics.refreshTopic(job.source.topicId);
    if (settingsConvId !== null && isActiveSettingsConversation(settingsConvId, settingsSnapshot)) {
      await this.#deps.settingsAssistant.refreshIfConversation(settingsConvId);
    }
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
    const state = await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const settingsDoc = await this.#deps.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const settingsConvId = parseSettingsTopicConversationId(job.source.topicId);
    const topic = state?.topics?.[job.source.topicId];
    const targetConvId =
      settingsConvId !== null
        ? isActiveSettingsConversation(settingsConvId, settingsDoc)
          ? settingsConvId
          : undefined
        : !topic || topic.deletedAt
          ? undefined
          : Number(topic.conversationId);
    const ticket = job.source.ticketId ? state?.tickets[job.source.ticketId] : undefined;
    if (targetConvId === undefined || (job.source.ticketId && (!ticket || ["stopped", "closed"].includes(ticket.status)))) {
      await this.#deps.mediaJobs().markDelivered(job.id);
      return;
    }
    const conversationId = targetConvId;
    for (const asset of job.assets) {
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
      await this.#deps.uiCards.publishAsset(
        { path: `media-job:${job.id}:${asset.id}`, name: asset.name },
        { conversationId, callId: `media-result:${job.id}:${asset.id}`, topicId: job.source.topicId },
        async () => asset,
      );
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
  }

  async stageWorkerArtifact(asset: ChatAttachment, source: MediaJobSource, callId: string): Promise<void> {
    if (!source.ticketId) throw new UiCardError("content_scope_denied", "产物缺少 Worker 任务归属。", 403);
    const snapshot = await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const settingsSnapshot = await this.#deps.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
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
