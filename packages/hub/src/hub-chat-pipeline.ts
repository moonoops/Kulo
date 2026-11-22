import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  InboxDoc, LiveDoc, UserEntry,
  type Conversation, type ConversationId, type Harness, type JsonObject,
} from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import type {
  AgentDispatchIntent, ChatAttachment, ChatReplyReference,
} from "@kulo/protocol";
import { extractAgentDispatchIntent } from "./agent-routing.js";
import {
  PendingChatAttachmentsDoc, assertChatDestination, bindChatAttachments,
  chatRequestTargetKey, removePendingChatAttachments, snapshotChatUploadScope,
  stageChatAttachments, type ChatDeliveryDraft,
} from "./chat-attachment-deliveries.js";
import type { ChatMessageSource } from "./chat-submissions.js";
import type { KuloConnections } from "./connections.js";
import {
  assertValidReplyReference, clientDeliveryIntent, legacyDeliveryConflict,
  sameDeliveryValue, writeDeliveryReceipt,
  type DeliveryAck, type DeliveryIntent, type DeliveryReceipt,
} from "./delivery-receipts.js";
import type { HubDeliveryCoordinator } from "./hub-delivery-coordinator.js";
import type { HubRuntimeGates, LiveSettingsStore } from "./hub-kernel-ports.js";
import type { HubTopicManager, WatchedTopicCache } from "./hub-topic-manager.js";
import { KuloProjectsDoc, ProjectError } from "./projects.js";
import { SettingsAssistantDoc } from "./settings-assistant.js";
import {
  KuloStateDoc, applyTopicPreview, ensureDefaultRootTopic, listSortedTopics,
  recordProcessedCommand, summarizeTopicPreview,
} from "./state.js";
import { resolveReplyTaskAnchor } from "./task-boards.js";
import { createTopicTitleJob } from "./topic-titles.js";
import { KuloUserEntry } from "./ui-cards.js";
import { parseUserEntryContent, type KuloUploadStore } from "./uploads.js";

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export type MessageSubmissionOptions = {
  topicId?: string;
  requestId?: string;
  whenBusy?: "steer" | "followUp";
  attachments?: ChatAttachment[];
  replyTo?: ChatReplyReference;
  principalId?: string;
  source?: ChatMessageSource;
  voiceDelegation?: boolean;
  targetDeviceId?: string;
  deliveryIntent?: DeliveryIntent;
};

export function userDisplayEntry(
  text: string,
  attachments: ChatAttachment[],
  receipt?: {
    requestId?: string;
    createdAt: number;
    agentDispatchIntent?: AgentDispatchIntent;
    source?: ChatMessageSource;
    targetDeviceId?: string;
  },
  replyTo?: ChatReplyReference,
) {
  return {
    kind: KuloUserEntry.kind,
    data: {
      kuloContentVersion: 1,
      text,
      attachments: cloneJson(attachments),
      ...(replyTo ? { replyTo: cloneJson(replyTo) } : {}),
      ...receipt,
    } as unknown as JsonObject,
  };
}

export function replyContext(text: string, replyTo?: ChatReplyReference): string {
  if (!replyTo) return text;
  const heading = replyTo.excerpt
    ? `【引用消息片段：${replyTo.role} #${replyTo.messageId}】`
    : `【回复消息：${replyTo.role} #${replyTo.messageId}】`;
  return `${heading}\n${replyTo.text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${text}`;
}

function agentIntentContext(intent: AgentDispatchIntent): string {
  return `[KULO_AGENT_ASSIGNMENT]\n${JSON.stringify(intent)}\nAuthoritative Agent assignment constraint parsed from this user message (takes precedence over default dispatch policies; validated by kulo_dispatch). If a named Agent is unconfigured, disabled, unverified, offline, or conflicts with the bound project device, state the exact reason and wait for the user's decision—never substitute a built-in Worker or another Agent. Ask to disambiguate multiple matching candidates, and pass exact role IDs when dispatching to multiple named Agents.`;
}

function legacyUserPayload(
  kind: string,
  data: unknown,
  content?: Parameters<typeof parseUserEntryContent>[0],
): { text: string; attachments: ChatAttachment[]; replyTo?: ChatReplyReference } | undefined {
  if (kind !== KuloUserEntry.kind && kind !== UserEntry.kind) return undefined;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.kuloContentVersion === 1 && typeof record.text === "string" && Array.isArray(record.attachments)) {
      return {
        text: record.text,
        attachments: record.attachments as ChatAttachment[],
        ...(record.replyTo ? { replyTo: record.replyTo as ChatReplyReference } : {}),
      };
    }
  }
  return content === undefined ? undefined : parseUserEntryContent(content);
}

function assertLegacyChatPayload(
  stored: { text: string; attachments: ChatAttachment[]; replyTo?: ChatReplyReference } | undefined,
  text: string,
  attachments: ChatAttachment[],
  replyTo?: ChatReplyReference,
): void {
  if (!stored || stored.text !== text || stored.attachments.length !== attachments.length || !sameDeliveryValue(stored.replyTo, replyTo)) {
    legacyDeliveryConflict();
  }
  for (const [index, attachment] of attachments.entries()) {
    const previous = stored.attachments[index];
    if (!previous || typeof previous !== "object" || !attachment || typeof attachment !== "object") legacyDeliveryConflict();
    const old = previous as unknown as Record<string, unknown>;
    const next = attachment as unknown as Record<string, unknown>;
    for (const key of ["id", "name", "kind", "mimeType", "size", "url"]) {
      if (!sameDeliveryValue(next[key], old[key])) legacyDeliveryConflict();
    }
    // The server may have added probe/transcript fields after upload; every field supplied by this retry must still match.
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined && !sameDeliveryValue(value, old[key])) legacyDeliveryConflict();
    }
  }
}

function deriveAutoTopicTitle(rawText: string, attachmentNames: readonly string[] = []): string {
  const stripped = rawText
    .replace(/^@ticket:[A-Za-z0-9_-]+\s*/i, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  const candidate = stripped || attachmentNames.find((n) => n.trim().length > 0)?.trim();
  if (!candidate) return "新对话";
  const chars = Array.from(candidate);
  return chars.length > 18 ? `${chars.slice(0, 18).join("")}…` : candidate;
}

export interface HubChatPipelineDeps {
  harness: Harness;
  settingsStore: LiveSettingsStore;
  runtimeGates: Pick<HubRuntimeGates, "resumeIfNotRecovering">;
  delivery: HubDeliveryCoordinator;
  topics: Pick<HubTopicManager, "resolveWatchedTopic" | "refreshTopic" | "refreshContent" | "trackTitle" | "emitTopics">;
  uploads: KuloUploadStore;
  envManager: Pick<EnvManager, "localEnvId" | "getEnvDescriptor" | "listEnvs">;
  connectionManager: Pick<KuloConnections, "processText" | "redact">;
  transcribeVoiceAsset: (
    assetId: string,
    options: { topicId?: string; principalId: string },
    context: Context,
  ) => Promise<ChatAttachment>;
  pruneCompactionBaseline: (
    conversationId: ConversationId,
    context: Context,
    force: boolean,
  ) => Promise<unknown>;
}

export class HubChatPipeline {
  readonly #deps: HubChatPipelineDeps;

  constructor(deps: HubChatPipelineDeps) {
    this.#deps = deps;
  }

  async hasSubmittedRequest(
    topicId = "root",
    requestId?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<boolean> {
    const clean = requestId?.trim();
    if (!clean) return false;
    const cache = await this.#deps.topics.resolveWatchedTopic(topicId, context);
    if (await this.#deps.harness.commit((tx) => tx.submissionByRequest(cache.conversation.id, clean), context)) {
      return true;
    }
    const snap = await this.#deps.harness.snapshot(KuloStateDoc, context);
    return Boolean(snap?.processedCommands?.[`req:${cache.topicId}:${clean}`]);
  }

  async #bindChatTarget(
    topicId: string,
    conversationId: number,
    requested: string | undefined,
    requestKey: string | undefined,
    context: Context,
  ): Promise<string> {
    if (requested !== undefined && (typeof requested !== "string" || requested.length > 256 || /[\u0000-\u001f]/.test(requested))) {
      throw new ProjectError(400, "invalid_target_device", "目标设备标识无效。");
    }
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const topic = state?.topics?.[topicId];
    if (!topic || topic.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
    const key = requestKey ? chatRequestTargetKey(conversationId, requestKey) : undefined;
    const recorded = key === undefined ? undefined : state?.chatRequestTargets?.[key];
    const clean = requested?.trim();
    if (recorded !== undefined && clean !== undefined && clean !== recorded) {
      throw new ProjectError(409, "request_intent_conflict", "已提交消息的目标设备不能更改。");
    }
    const target = recorded ?? clean ?? topic.targetDeviceId ?? "";
    const changed = target !== (topic.targetDeviceId ?? "");
    if (recorded !== undefined && !changed) return target;
    if (changed) {
      if (target && !this.#deps.envManager.getEnvDescriptor(target)?.online) {
        throw new ProjectError(409, "target_device_unavailable", "目标设备尚未连接。");
      }
      const [live, inbox] = await Promise.all([
        this.#deps.harness.snapshot(LiveDoc, conversationId as ConversationId, context),
        this.#deps.harness.snapshot(InboxDoc, conversationId as ConversationId, context),
      ]);
      if (live?.run || inbox?.items.length) {
        throw new ProjectError(409, "target_device_busy", "请等待当前回复结束，再切换目标设备。");
      }
    }
    await this.#deps.harness.commit(async (tx) => {
      const next = await tx.doc(KuloStateDoc);
      const current = next.topics?.[topicId];
      if (!current || current.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
      if (key) {
        next.chatRequestTargets ??= {};
        const prior = next.chatRequestTargets[key];
        if (prior !== undefined && prior !== target) {
          throw new ProjectError(409, "request_intent_conflict", "已提交消息的目标设备不能更改。");
        }
        next.chatRequestTargets[key] = target;
      }
      if (target) current.targetDeviceId = target;
      else delete current.targetDeviceId;
    }, context);
    return target;
  }

  async sendUserMessage(
    content: string,
    options: MessageSubmissionOptions = {},
    context: Context = BACKGROUND_CONTEXT,
  ) {
    assertValidReplyReference(options.replyTo);
    const key = options.topicId || "root";
    const principalId = options.principalId ?? this.#deps.envManager.localEnvId;
    const receivedAt = Date.now();
    const intent = options.deliveryIntent ?? clientDeliveryIntent({
      type: "chat.send",
      topicId: key,
      requestId: options.requestId,
      content,
      attachments: options.attachments,
      replyTo: options.replyTo,
      whenBusy: options.whenBusy,
      targetDeviceId: options.targetDeviceId,
      ...(options.voiceDelegation ? { voiceDelegation: true } : {}),
    }, principalId);

    return this.#deps.delivery.withDelivery(
      intent,
      context,
      (receipt) => this.#deps.delivery.queueChat(key, async () => {
        if (receipt?.phase === "admitted" && intent) {
          if (receipt.continuation.error === "topic_deleted") throw new ProjectError(404, "topic_deleted", "会话已删除。");
          if (receipt.continuation.error === "attachment_forbidden") throw new ProjectError(403, "attachment_forbidden", "无权引用此附件。");
          const pending = (await this.#deps.harness.snapshot(PendingChatAttachmentsDoc, context))?.messages[intent.key];
          if (!pending) throw new Error("Missing admitted chat attachment delivery");
          return this.#replayChatDraft(pending, intent.key, context);
        }
        return this.#sendUserMessage(content, { ...options, principalId }, context, receivedAt, intent);
      }),
      async (receipt) => {
        const submission = await this.#deps.harness.submission(Number(receipt.ack.submissionId) as never, context);
        if (!submission) throw new Error("Stored delivery refers to a missing submission");
        // Older senders could commit a complete receipt before adding the upload scope.
        const attachments = options.attachments;
        if (attachments?.length && !receipt.continuation.attachmentsBound) {
          const record = await submission.status(context);
          if (record.type !== "input" || record.requestId !== intent?.id || receipt.ack.topicId !== key) {
            legacyDeliveryConflict();
          }
          await this.#deps.harness.commit(async (tx) => {
            await bindChatAttachments(tx, this.#deps.uploads, { topicId: key, conversationId: Number(record.conversationId) }, attachments, principalId);
            await writeDeliveryReceipt(tx, intent, receipt.ack as DeliveryAck, "complete", { attachmentsBound: true });
          }, context);
          this.#deps.topics.refreshTopic(key);
        }
        return submission;
      },
    );
  }

  async #sendUserMessage(
    content: string,
    options: MessageSubmissionOptions & { principalId: string },
    context: Context,
    receivedAt: number,
    intent?: DeliveryIntent,
  ) {
    const targetTopicId = options.topicId || "root";
    const cache = await this.#deps.topics.resolveWatchedTopic(targetTopicId, context);
    const cleanReqId = options.requestId?.trim();
    const repeated = cleanReqId
      ? await this.#deps.harness.commit((tx) => tx.submissionByRequest(cache.conversation.id, cleanReqId), context)
      : undefined;
    if (repeated) {
      if (repeated.type !== "input") {
        throw Object.assign(new Error("消息标识已用于另一项操作。"), { code: "request_intent_conflict", status: 409 });
      }
      await this.#deps.harness.commit(async (tx) => {
        const current = await tx.submissionByRequest(cache.conversation.id, cleanReqId!);
        if (!current || current.type !== "input" || options.voiceDelegation) legacyDeliveryConflict();
        let stored: { text: string; attachments: ChatAttachment[]; replyTo?: ChatReplyReference } | undefined;
        let queueMode: "steer" | "followUp" | undefined;
        if (current.entry !== undefined) {
          const entry = await tx.entry(current.entry);
          const model = entry?.model?.[0];
          if (entry) stored = legacyUserPayload(entry.kind, entry.data, model?.role === "user" ? model.content : undefined);
        } else {
          const inbox = await tx.doc(InboxDoc, cache.conversation.id);
          const pending = inbox.items.find((item) => item.id === current.id);
          if (pending && pending.mode !== "write") {
            queueMode = pending.mode;
            stored = legacyUserPayload(pending.entry?.kind ?? UserEntry.kind, pending.entry?.data,
              pending.content as Parameters<typeof parseUserEntryContent>[0]);
          }
        }
        assertLegacyChatPayload(stored, content, options.attachments ?? [], options.replyTo);
        if ((options.whenBusy ?? "steer") !== (queueMode ?? "steer")) legacyDeliveryConflict();
        if (options.targetDeviceId !== undefined) {
          const state = await tx.doc(KuloStateDoc);
          const targetKey = chatRequestTargetKey(Number(cache.conversation.id), `req:${cache.topicId}:${cleanReqId}`);
          const target = state.chatRequestTargets?.[targetKey];
          if (target === undefined || target !== options.targetDeviceId.trim()) legacyDeliveryConflict();
        }
        if (options.attachments?.length) {
          await bindChatAttachments(tx, this.#deps.uploads, { topicId: cache.topicId, conversationId: Number(cache.conversation.id) }, options.attachments, options.principalId);
        }
        await writeDeliveryReceipt(tx, intent, {
          topicId: cache.topicId,
          submissionId: Number(current.id),
          delivery: current.status === "queued" ? "queued" : "accepted",
        }, "complete", options.attachments?.length ? { attachmentsBound: true } : {});
      }, context);
      if (intent) intent.replayed = true;
      const submission = await this.#deps.harness.submission(repeated.id, context);
      if (!submission) throw new Error("Stored request refers to a missing submission");
      return submission;
    }

    const liveSettings = this.#deps.settingsStore.get();
    if (!liveSettings.model.defaultModel.trim()) {
      throw Object.assign(new Error("请先选择供应商和模型，再发送消息。"), { code: "model_not_selected" });
    }
    if (Array.isArray(options.attachments) && options.attachments.length > 0) {
      for (const att of options.attachments) {
        if (!att?.id || !this.#deps.uploads.getUpload(att.id)) {
          throw Object.assign(
            new Error(`附件 '${att?.name || att?.id || "unknown"}' 不存在或已失效，请重新上传后再发送。`),
            { code: "attachment_not_found" },
          );
        }
      }
    }
    if (options.attachments?.length) {
      const canReadScope = await snapshotChatUploadScope(this.#deps.harness, context);
      if (options.attachments.some((asset) => !this.#deps.uploads.canReadUpload(asset.id, options.principalId, canReadScope))) {
        throw Object.assign(new Error("无权引用此附件。"), { code: "attachment_forbidden", status: 403 });
      }
    }
    const reqKey = cleanReqId ? `req:${cache.topicId}:${cleanReqId}` : undefined;
    const targetDeviceId = await this.#bindChatTarget(cache.topicId, Number(cache.conversation.id), options.targetDeviceId, reqKey, context);
    content = (await this.#deps.connectionManager.processText(content, {
      requestId: cleanReqId ? `chat:${cache.topicId}:${cleanReqId}` : undefined,
      replyText: options.replyTo?.text,
    })).text;
    // Pi's current message contract accepts text and images; an audio modality label alone does not add an audio transport.
    for (const { record } of this.#deps.uploads.resolveAttachments(options.attachments)) {
      if (record.kind === "audio") {
        await this.#deps.transcribeVoiceAsset(record.id, { topicId: targetTopicId, principalId: options.principalId || this.#deps.envManager.localEnvId }, context);
      }
    }
    const replyTo = options.replyTo ? {
      messageId: options.replyTo.messageId,
      role: options.replyTo.role,
      text: this.#deps.connectionManager.redact(options.replyTo.text),
      ...(options.replyTo.excerpt ? { excerpt: true } : {}),
    } : undefined;
    const agentDispatchIntent = extractAgentDispatchIntent(content, liveSettings.roles, this.#deps.envManager.listEnvs(), liveSettings.externalClients);
    const draft: ChatDeliveryDraft = {
      topicId: cache.topicId,
      conversationId: Number(cache.conversation.id),
      targetDeviceId,
      content,
      receivedAt,
      replyTo,
      principalId: options.principalId,
      requestId: cleanReqId,
      whenBusy: options.whenBusy ?? "steer",
      ...(options.source ? { source: { ...options.source, name: this.#deps.connectionManager.redact(options.source.name) } } : {}),
      attachmentIds: (options.attachments ?? []).map((asset) => asset.id),
      agentDispatchIntent,
      voiceDelegation: options.voiceDelegation,
      receipt: intent && { key: intent.key, fingerprint: intent.fingerprint, action: intent.action },
    };
    const pendingKey = draft.attachmentIds.length ? draft.receipt?.key : undefined;
    const admitted = pendingKey ? await stageChatAttachments(this.#deps.harness, this.#deps.uploads, pendingKey, draft, context) : draft;
    return this.#submitChatDraft(cache, admitted, context, pendingKey);
  }

  async recoverChatAttachments(context: Context): Promise<void> {
    const pending = await this.#deps.harness.snapshot(PendingChatAttachmentsDoc, context);
    for (const [key, draft] of Object.entries(pending?.messages ?? {}).sort(([, a], [, b]) => a.receivedAt - b.receivedAt)) {
      try {
        await this.#replayChatDraft(draft, key, context);
      } catch (error) {
        if (error instanceof ProjectError && ["topic_deleted", "topic_not_found", "attachment_forbidden"].includes(error.code)) {
          await this.#deps.harness.commit(async (tx) => {
            await removePendingChatAttachments(tx, key);
            await writeDeliveryReceipt(tx, draft.receipt, { topicId: draft.topicId }, "admitted", {
              error: error.code === "attachment_forbidden" ? error.code : "topic_deleted",
            });
          }, context);
          continue;
        }
        context.abortSignal?.throwIfAborted();
        if (error instanceof Error && error.name === "SessionFailed") throw error;
        // Keep the verified input for the sender's retry even if its upload is temporarily unavailable.
        console.warn("[KuloChat] Attachment delivery pending", draft.topicId,
          this.#deps.connectionManager.redact(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  async #replayChatDraft(draft: ChatDeliveryDraft, key: string, context: Context) {
    const cache = await this.#deps.topics.resolveWatchedTopic(draft.topicId, context);
    if (Number(cache.conversation.id) !== draft.conversationId) legacyDeliveryConflict();
    if (draft.requestId) {
      await this.#bindChatTarget(draft.topicId, draft.conversationId, draft.targetDeviceId, `req:${draft.topicId}:${draft.requestId}`, context);
    }
    return this.#submitChatDraft(cache, draft, context, key);
  }

  async #submitChatDraft(cache: WatchedTopicCache, draft: ChatDeliveryDraft, context: Context, pendingKey?: string) {
    const { content, replyTo, agentDispatchIntent } = draft;
    if (Number(cache.conversation.id) !== draft.conversationId) legacyDeliveryConflict();
    await this.#deps.pruneCompactionBaseline(cache.conversation.id, context, false).catch(() => {});
    const messageContext = {
      ...(draft.source ? { source: draft.source } : {}),
      ...(draft.requestId ? { requestId: draft.requestId } : {}),
      targetDeviceId: draft.targetDeviceId,
    };
    const sourceContext = draft.source || draft.targetDeviceId ? `[KULO_MESSAGE_SOURCE]\n${JSON.stringify(messageContext)}` : "";
    let replyAnchor: string | undefined;
    if (replyTo?.messageId !== undefined) {
      const [anchorState, anchorProjects, anchorSettings] = await Promise.all([
        this.#deps.harness.snapshot(KuloStateDoc, context),
        this.#deps.harness.snapshot(KuloProjectsDoc, context),
        this.#deps.harness.snapshot(SettingsAssistantDoc, context),
      ]);
      replyAnchor = resolveReplyTaskAnchor(
        cache.watch.value.entries,
        replyTo.messageId,
        anchorState,
        anchorProjects,
        anchorSettings,
        Number(cache.conversation.id),
      );
    }
    const modelContent = [replyContext(content, replyTo), replyAnchor, sourceContext, agentDispatchIntent ? agentIntentContext(agentDispatchIntent) : ""].filter(Boolean).join("\n\n");
    const prepared = this.#deps.uploads.buildMultimodalContent(modelContent, draft.attachmentIds);
    const capturedIntent: AgentDispatchIntent = agentDispatchIntent ?? { version: 1, targets: [] };
    const displayEntry = draft.voiceDelegation
      ? { kind: "kulo.voice.delegation", data: { ...messageContext, agentDispatchIntent: cloneJson(capturedIntent) } as unknown as JsonObject }
      : userDisplayEntry(content, prepared.attachments, { ...messageContext, createdAt: draft.receivedAt, agentDispatchIntent: capturedIntent }, replyTo);

    const userPreview = draft.voiceDelegation
      ? undefined
      : summarizeTopicPreview([{ role: "user", text: this.#deps.connectionManager.redact(content), createdAt: draft.receivedAt }]);

    // Keep an immediate fallback while the first completed reply supplies context for a generated title.
    const { allTopics, pendingTitle, submissionId } = await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      assertChatDestination(state, draft);
      const live = await tx.doc(LiveDoc, cache.conversation.id);
      const inbox = await tx.doc(InboxDoc, cache.conversation.id);
      const queued = Boolean(live.run || inbox.items.length);
      if (draft.requestId) {
        recordProcessedCommand(state, `req:${cache.topicId}:${draft.requestId}`, cache.topicId, "chat.send");
      }
      ensureDefaultRootTopic(state, this.#deps.settingsStore.getAgentName());
      const t = state.topics?.[cache.topicId];
      if (t) {
        const now = Date.now();
        t.updatedAt = now;
        applyTopicPreview(t, userPreview, now);
        if (t.draft) {
          t.title = deriveAutoTopicTitle(content, prepared.attachments.map((a) => a.name));
          delete t.draft;
          const titleJob = createTopicTitleJob(content, prepared.attachments.map((attachment) => attachment.name), t.title);
          if (titleJob) {
            state.topicTitles ??= {};
            state.topicTitles[cache.topicId] = titleJob;
          }
        }
      }
      if (draft.attachmentIds.length) {
        if ((t?.targetDeviceId ?? "") !== draft.targetDeviceId) {
          throw new ProjectError(409, "target_device_busy", "目标设备已变更，请重试发送。");
        }
        await bindChatAttachments(tx, this.#deps.uploads, draft, draft.attachmentIds, draft.principalId, draft.sourceScopes);
        if (pendingKey) await removePendingChatAttachments(tx, pendingKey);
      }
      const submissionId = await cache.conversation.submit(tx, {
        type: "input",
        content: prepared.content,
        entry: displayEntry,
        whenBusy: draft.whenBusy,
        ...(draft.requestId ? { requestId: draft.requestId } : {}),
      });
      await writeDeliveryReceipt(tx, draft.receipt, {
        topicId: cache.topicId,
        submissionId: Number(submissionId),
        delivery: queued ? "queued" : "accepted",
      }, "complete", draft.attachmentIds.length ? { attachmentsBound: true } : {});
      return { allTopics: listSortedTopics(state), pendingTitle: state.topicTitles?.[cache.topicId]?.status === "pending", submissionId };
    }, context);
    this.#deps.topics.emitTopics(allTopics);

    if (pendingTitle) this.#deps.topics.trackTitle(cache.topicId);
    this.#deps.runtimeGates.resumeIfNotRecovering();
    const submission = await this.#deps.harness.submission(submissionId, context);
    if (!submission) throw new Error("Admitted request has no submission");
    await this.#resumePausedChat(cache.conversation, context);
    this.#deps.topics.refreshContent(cache);
    return submission;
  }

  async abortForegroundTurn(
    topicId = "root",
    context: Context = BACKGROUND_CONTEXT,
    intent?: DeliveryIntent,
  ): Promise<void> {
    return this.#deps.delivery.withDelivery(
      intent,
      context,
      (receipt) => this.#deps.delivery.queueChat(topicId, () => this.#abortForegroundTurn(topicId, context, intent, receipt)),
      async () => {},
    );
  }

  async #abortForegroundTurn(topicId: string, context: Context, intent?: DeliveryIntent, prior?: Readonly<DeliveryReceipt>): Promise<void> {
    const cache = await this.#deps.topics.resolveWatchedTopic(topicId, context);
    const taskId = prior?.phase === "admitted" ? prior.continuation.taskId : await this.#deps.harness.commit(async (tx) => {
      if (intent && await tx.submissionByRequest(cache.conversation.id, intent.id)) legacyDeliveryConflict();
      const state = await tx.doc(KuloStateDoc);
      const live = await tx.doc(LiveDoc, cache.conversation.id);
      state.pausedChats ??= {};
      state.pausedChats[String(cache.conversation.id)] ??= [];
      const taskId = live.run?.taskId;
      await writeDeliveryReceipt(tx, intent, { topicId }, taskId === undefined ? "complete" : "admitted",
        taskId === undefined ? {} : { taskId: Number(taskId) });
      return taskId;
    }, context);
    const current = await this.#deps.harness.snapshot(LiveDoc, cache.conversation.id, context);
    // A replay may finish an interrupted stop, but must never stop a later run in this conversation.
    if (typeof taskId === "number" && current?.run?.taskId === taskId) {
      await this.#deps.harness.abortTask(taskId as never, context);
      await this.#deps.harness.waitForTask(taskId as never, context);
    }
    await this.#deps.harness.commit((tx) => writeDeliveryReceipt(tx, intent, { topicId }), context);
    this.#deps.topics.refreshContent(cache);
  }

  async retryTurn(
    topicId = "root",
    requestId?: string,
    context: Context = BACKGROUND_CONTEXT,
    suppliedIntent?: DeliveryIntent,
  ): Promise<{ retried: boolean }> {
    const intent = suppliedIntent ?? clientDeliveryIntent({ type: "chat.retry", topicId, requestId });
    return this.#deps.delivery.withDelivery(
      intent,
      context,
      () => this.#deps.delivery.queueChat(topicId, () => this.#retryTurn(topicId, requestId, context, intent)),
      async (receipt) => ({ retried: receipt.continuation.retried === true }),
    );
  }

  async #retryTurn(topicId: string, requestId: string | undefined, context: Context, intent?: DeliveryIntent): Promise<{ retried: boolean }> {
    const cache = await this.#deps.topics.resolveWatchedTopic(topicId, context);
    const retried = await this.#deps.harness.commit(async (tx) => {
      const prior = requestId ? await tx.submissionByRequest(cache.conversation.id, requestId) : undefined;
      if (prior && prior.type !== "continue") {
        throw Object.assign(new Error("消息标识已用于另一项操作。"), { code: "request_intent_conflict", status: 409 });
      }
      const live = await tx.doc(LiveDoc, cache.conversation.id);
      if (!prior && live.run) {
        await writeDeliveryReceipt(tx, intent, { topicId }, "complete", { retried: false });
        return false;
      }
      if (!prior) await cache.conversation.submit(tx, { type: "continue", ...(requestId ? { requestId } : {}) });
      await writeDeliveryReceipt(tx, intent, { topicId }, "complete", { retried: true });
      return true;
    }, context);
    if (retried) {
      // Unconditional resume preserved explicitly for foreground retry.
      this.#deps.harness.resume();
      await this.#resumePausedChat(cache.conversation, context);
    }
    return { retried };
  }

  async #resumePausedChat(conversation: Conversation, context: Context): Promise<void> {
    for (;;) {
      const admitted = await this.#deps.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const key = String(conversation.id);
        const deferred = state.pausedChats?.[key];
        if (!deferred) return false;
        const draft = deferred[0];
        if (!draft) { delete state.pausedChats![key]; return false; }
        // Each native admission and removal share a commit, so recovery cannot lose or repeat a report.
        await conversation.submit(tx, draft);
        deferred.shift();
        return true;
      }, context);
      if (!admitted) return;
    }
  }
}
