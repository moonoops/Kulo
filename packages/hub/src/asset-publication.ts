import path from "node:path";
import { createHash } from "node:crypto";
import { ROOT_CONVERSATION_ID, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { EnvManager } from "@kulo/env";
import type { ChatAttachment, TicketRecord } from "@kulo/protocol";
import { KuloStateDoc, getActiveStagedCwd, getEffectiveWorkspaceDir, isOrchestratorConversation, resolveTicketExecutionScope, type KuloDurableState } from "./state.js";
import { SettingsAssistantDoc, isActiveSettingsConversation, parseSettingsTopicConversationId, settingsTopicId, type SettingsAssistantState } from "./settings-doc.js";
import { KuloProjectsDoc, assertProjectBinding, type KuloProjects } from "./projects.js";
import type { KuloUploadStore } from "./uploads.js";
import { publishExecutionAsset } from "./content-assets.js";
import { UiCardError, type KuloUiCards, type UiAssetPublicationInput, type UiCardSource } from "./ui-cards.js";
import { inspectAssetContent } from "./asset-inspection.js";

interface AssetPublisherOptions {
  cards: () => KuloUiCards;
  projects: () => KuloProjects;
  envManager: EnvManager;
  uploads: KuloUploadStore;
  mainWorkspaceDir: string;
  protectedPaths: () => string[];
  redact: (text: string) => string;
}

function inside(value: string, root: string, implementation: typeof path.posix): boolean {
  const relative = implementation.relative(root, value);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${implementation.sep}`) && !implementation.isAbsolute(relative);
}

function escapedText(value: string): string {
  return value.replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, "\\$&");
}

function callerSource(
  state: KuloDurableState | undefined,
  settings: Readonly<SettingsAssistantState> | undefined,
  api: ToolExecutionApi,
): { source: UiCardSource; ticket?: TicketRecord; originConversationId: number } {
  const actor = Number(api.conversationId);
  let ticket: TicketRecord | undefined;
  let topicId: string;
  if (isOrchestratorConversation(api.conversationId, state)) {
    topicId = state?.conversationToTopic?.[String(actor)] ?? "root";
  } else if (isActiveSettingsConversation(api.conversationId, settings)) {
    topicId = settingsTopicId(actor);
  } else {
    const scope = resolveTicketExecutionScope(state, api.conversationId);
    if (!scope || scope.ticket.status !== "running" || scope.subagent && scope.subagent.state !== "running") throw new UiCardError("content_scope_denied", "当前任务无法发送文件。", 403);
    ticket = scope.ticket;
    topicId = ticket.originTopicId ?? "root";
  }
  const conversationId = ticket?.originConversationId ?? (ticket ? Number(ROOT_CONVERSATION_ID) : actor);
  const settingsConvId = parseSettingsTopicConversationId(topicId);
  if (settingsConvId !== null) {
    if (settingsConvId !== conversationId || !isActiveSettingsConversation(settingsConvId, settings)) {
      throw new UiCardError("content_scope_denied", "发起任务的聊天已删除或不可用。", 403);
    }
  } else {
    const topic = state?.topics?.[topicId];
    if (!topic || topic.deletedAt || Number(topic.conversationId) !== conversationId) throw new UiCardError("content_scope_denied", "发起任务的聊天已删除或不可用。", 403);
  }
  // Model call IDs are only unique inside the executing conversation, even when files share a destination.
  const callId = `asset:${createHash("sha256").update(JSON.stringify([actor, api.callId])).digest("hex")}`;
  return { source: { conversationId: actor, callId, toolCallId: api.callId, topicId, ...(ticket ? { ticketId: ticket.id } : {}) }, ...(ticket ? { ticket } : {}), originConversationId: conversationId };
}

export function createAssetPublisher(options: AssetPublisherOptions) {
  const stage = (state: KuloDurableState, ticket: TicketRecord | undefined, asset: ChatAttachment) => {
    if (!ticket) return;
    state.workerArtifacts ??= {};
    const artifacts = state.workerArtifacts[ticket.id] ?? [];
    if (!artifacts.some((entry) => entry.id === asset.id)) state.workerArtifacts[ticket.id] = [...artifacts, asset];
  };
  const markPublished = (state: KuloDurableState, conversationId: number, assetId: string) => {
    for (const [ticketId, artifacts] of Object.entries(state.workerArtifacts ?? {})) {
      const ticket = state.tickets[ticketId];
      if (ticket && (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === conversationId) state.workerArtifacts![ticketId] = artifacts.filter((asset) => asset.id !== assetId);
    }
  };
  const implementationFor = (envId: string) => options.envManager.getEnvDescriptor(envId)?.platform === "win32" ? path.win32 : path.posix;
  const deliveryKey = (ticket: TicketRecord, input: UiAssetPublicationInput) => createHash("sha256").update(input.assetId ? `asset:${input.assetId}` : implementationFor(ticket.envId).resolve(getEffectiveWorkspaceDir(ticket), input.path)).digest("hex");
  const clearFailure = (state: KuloDurableState, ticket: TicketRecord | undefined, input: UiAssetPublicationInput) => {
    if (!ticket) return;
    const prior = state.fileDeliveryFailures?.[ticket.id];
    if (prior?.runEpoch !== ticket.runEpoch) return;
    delete prior.errors[deliveryKey(ticket, input)];
    if (!Object.keys(prior.errors).length) delete state.fileDeliveryFailures![ticket.id];
  };
  const ticketRoot = (ticket: TicketRecord, input: UiAssetPublicationInput) => {
    const implementation = implementationFor(ticket.envId);
    const stagedCwd = getActiveStagedCwd(ticket);
    if (stagedCwd && (!implementation.isAbsolute(input.path) || inside(input.path, stagedCwd, implementation))) return stagedCwd;
    return ticket.scratchDir && implementation.isAbsolute(input.path) && inside(input.path, ticket.scratchDir, implementation) ? ticket.scratchDir : ticket.workspaceDir;
  };
  const recordFailure = async (api: ToolExecutionApi, ticket: TicketRecord | undefined, input: UiAssetPublicationInput, context: Context, error: string) => {
    if (!ticket) return;
    const key = deliveryKey(ticket, input);
    await api.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const current = state.tickets[ticket.id];
      if (!current || current.runEpoch !== ticket.runEpoch) return;
      const prior = state.fileDeliveryFailures?.[ticket.id];
      state.fileDeliveryFailures ??= {};
      const failure = prior?.runEpoch === ticket.runEpoch ? prior : { runEpoch: ticket.runEpoch, errors: {} };
      failure.errors[key] = error;
      state.fileDeliveryFailures[ticket.id] = failure;
    }, context);
  };

  const receivedAsset = (
    state: KuloDurableState | undefined,
    settings: Readonly<SettingsAssistantState> | undefined,
    api: ToolExecutionApi,
    input: UiAssetPublicationInput,
  ) => {
    const caller = callerSource(state, settings, api);
    if (input.ticketId) {
      const requested = state && Object.hasOwn(state.tickets, input.ticketId) ? state.tickets[input.ticketId] : undefined;
      if (!requested || caller.ticket && caller.ticket.id !== requested.id || (requested.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== caller.originConversationId || (requested.originTopicId ?? "root") !== caller.source.topicId) throw new UiCardError("content_scope_denied", "任务不属于当前聊天。", 403);
    }
    const scopes = new Set([`conversation:${Number(api.conversationId)}`]);
    const tickets = caller.ticket ? [caller.ticket] : Object.values(state?.tickets ?? {}).filter((ticket) =>
      (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === caller.originConversationId && (ticket.originTopicId ?? "root") === caller.source.topicId);
    for (const ticket of tickets) {
      scopes.add(`ticket:${ticket.id}`);
      scopes.add(`conversation:${ticket.workerConversationId}`);
      scopes.add(`conversation:${ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)}`);
    }
    const ticketIds = new Set(tickets.map((ticket) => ticket.id));
    for (const child of Object.values(state?.subagents ?? {})) if (ticketIds.has(child.ticketId)) scopes.add(`conversation:${child.conversationId}`);
    const loaded = options.uploads.getUpload(input.assetId!);
    const canReadScope = (scope: string) => scopes.has(scope);
    if (!loaded || !options.uploads.canReadUpload(loaded.record.id, `agent:${Number(api.conversationId)}`, canReadScope)) throw new UiCardError("asset_reference_denied", "当前聊天或任务尚未收到这份附件，无法发送。", 403);
    const isInternalOverflow = Boolean(
      loaded.record.internalOnly ||
      Object.values(state?.tickets ?? {}).some(
        (ticket) =>
          ticket.latestReport?.overflowAsset?.id === loaded.record.id ||
          ticket.externalExecution?.explicitReadyReport?.overflowAsset?.id === loaded.record.id,
      ),
    );
    if (isInternalOverflow && caller.ticket) {
      throw new UiCardError("internal_overflow_asset_not_publishable", "内部溢出资产仅供所属会话主 Agent 审阅，后台任务不可访问或转发。", 403);
    }
    if (loaded.record.internalKind === "tool-overflow" && loaded.record.ownerId !== `agent:${Number(api.conversationId)}`) {
      throw new UiCardError("asset_reference_denied", "当前聊天无权读取其他会话的内部工具溢出资产。", 403);
    }
    return { ...caller, asset: options.uploads.toChatAttachment(loaded.record), canReadScope, isInternalOverflow };
  };

  const resolve = async (input: UiAssetPublicationInput, api: ToolExecutionApi, context: Context) => {
    const state = await api.snapshot(KuloStateDoc, context);
    const settings = await api.snapshot(SettingsAssistantDoc, context);
    const caller = callerSource(state, settings, api);
    let ticket = caller.ticket;
    if (ticket && input.ticketId && input.ticketId !== ticket.id) throw new UiCardError("content_scope_denied", "只能发送当前任务的文件。", 403);
    if (!ticket && input.ticketId) {
      const requested = state && Object.hasOwn(state.tickets, input.ticketId) ? state.tickets[input.ticketId] : undefined;
      if (!requested || (requested.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== caller.originConversationId || (requested.originTopicId ?? "root") !== caller.source.topicId) throw new UiCardError("content_scope_denied", "任务不属于当前聊天。", 403);
      ticket = requested;
    }
    if (!ticket && !input.ticketId) {
      const matches = Object.values(state?.tickets ?? {}).filter((entry) => {
        const implementation = implementationFor(entry.envId);
        const absolute = implementation.resolve(api.env?.cwd ?? options.mainWorkspaceDir, input.path);
        return entry.executionDomain !== "android" && inside(absolute, ticketRoot(entry, { ...input, path: absolute }), implementation);
      });
      if (matches.length) {
        const own = matches.filter((entry) => (entry.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === caller.originConversationId && (entry.originTopicId ?? "root") === caller.source.topicId);
        if (!own.length) throw new UiCardError("content_scope_denied", "任务文件不属于当前聊天。", 403);
        if (own.length !== 1) throw new UiCardError("asset_ticket_required", "请用 ticket_id 指定要发送文件的原任务。", 400);
        ticket = own[0];
      }
    }
    if (ticket && (["stopped", "closed"].includes(ticket.status) || ticket.cleanupPending || ticket.executionDomain === "android")) throw new UiCardError("content_scope_denied", "任务已停止、关闭或仍在清理，无法发送文件。", 403);
    const topic = state?.topics?.[caller.source.topicId!];
    const projectId = ticket?.projectId ?? (!caller.ticket ? topic?.projectId : undefined);
    const project = projectId ? await options.projects().get(projectId, context) : undefined;
    if (ticket && project && (project.grantRevision !== ticket.grantRevision || project.directoryId !== ticket.directoryId || project.deviceId !== ticket.envId || project.workspaceDir !== ticket.workspaceDir)) throw new UiCardError("content_scope_denied", "原任务的项目授权已变化，无法发送旧任务文件。", 403);
    const allowedRoot = ticket ? ticketRoot(ticket, input) : project?.workspaceDir ?? options.mainWorkspaceDir;
    const activeStagedCwd = ticket ? getActiveStagedCwd(ticket) : undefined;
    const env = caller.ticket ? api.env : project && !ticket ? api.env : options.envManager.createWorkerExecutionEnv(ticket?.envId ?? options.envManager.pickDefaultEnvId(), ticket ? getEffectiveWorkspaceDir(ticket) : allowedRoot, {
      readOnly: true,
      ...(ticket?.scratchDir ? { scratchDir: ticket.scratchDir } : {}),
      ...(ticket?.projectId ? { projectId: ticket.projectId, grantRevision: ticket.grantRevision } : {}),
      ...(ticket && activeStagedCwd && !ticket.externalExecution ? { stagedTaskId: ticket.id } : {}),
    });
    const source = { ...caller.source, ...(ticket ? { ticketId: ticket.id } : {}) };
    return { source, ticket, project, allowedRoot, env, worker: Boolean(caller.ticket) };
  };

  const publish = async (input: UiAssetPublicationInput, api: ToolExecutionApi, context: Context, reviewOnly = false): Promise<ChatAttachment> => {
    let target: Awaited<ReturnType<typeof resolve>> | undefined;
    try {
      if (input.assetId) {
        if (input.path !== `asset:${input.assetId}`) throw new UiCardError("invalid_asset_publication", "path 和 asset_id 只能选择一个。", 400);
        const initial = receivedAsset(await api.snapshot(KuloStateDoc, context), await api.snapshot(SettingsAssistantDoc, context), api, input);
        if (!reviewOnly && initial.isInternalOverflow) {
          throw new UiCardError("internal_overflow_asset_not_publishable", "该资产属于内部超长汇报溢出文本，仅供主 Agent 使用 kulo_inspect_asset 分页审阅，不可直接发布给用户。", 403);
        }
        // Managed bytes were received already; forwarding them must not reopen the source device or project.
        const cards = options.cards();
        const store = initial.ticket || reviewOnly ? cards.stageAsset.bind(cards) : cards.publishAsset.bind(cards);
        return await store(input, initial.source, async () => initial.asset, async (tx, asset) => {
          const state = await tx.doc(KuloStateDoc);
          const settings = await tx.doc(SettingsAssistantDoc);
          const current = receivedAsset(state, settings, api, input);
          if (current.source.conversationId !== initial.source.conversationId || current.ticket?.runEpoch !== initial.ticket?.runEpoch) throw new UiCardError("content_scope_denied", "附件发送期间任务归属或执行资格已变化。", 403);
          if (!reviewOnly || current.ticket) options.uploads.bindAttachments([asset], `conversation:${current.source.conversationId}`, `agent:${Number(api.conversationId)}`, current.canReadScope);
          if (current.ticket) {
            options.uploads.bindAttachments([asset], `ticket:${current.ticket.id}`, `agent:${Number(api.conversationId)}`, current.canReadScope);
            stage(state, current.ticket, asset);
          } else if (!reviewOnly) {
            markPublished(state, current.source.conversationId, asset.id);
          }
          clearFailure(state, current.ticket, input);
        });
      }
      if (!input.path.trim()) throw new UiCardError("invalid_asset_publication", "请提供 path 或已收到附件的 asset_id。", 400);
      target = await resolve(input, api, context);
      const initial = target;
      const cards = options.cards();
      const store = initial.worker || reviewOnly ? cards.stageAsset.bind(cards) : cards.publishAsset.bind(cards);
      const attachment = await store(input, initial.source, async () => {
        const resolvedInput = initial.ticket && !implementationFor(initial.ticket.envId).isAbsolute(input.path)
          ? { ...input, path: implementationFor(initial.ticket.envId).resolve(initial.allowedRoot, input.path) }
          : input;
        const asset = await publishExecutionAsset(resolvedInput, { env: initial.env, conversationId: api.conversationId, callId: api.callId }, context, options.uploads, {
          allowedRoot: initial.allowedRoot,
          protectedPaths: options.protectedPaths().filter((entry) => {
            const relative = path.relative(entry, initial.allowedRoot);
            return !(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
          }),
          trustedSandbox: true,
          ownerId: `agent:${Number(api.conversationId)}`,
        });
        // A transfer can outlive task cancellation, deletion, or a project grant change.
        const current = await resolve(input, api, context);
        if (current.source.conversationId !== initial.source.conversationId || current.ticket?.runEpoch !== initial.ticket?.runEpoch) throw new UiCardError("content_scope_denied", "文件发送期间任务归属或执行资格已变化。", 403);
        return asset;
      }, async (tx, asset) => {
        const state = await tx.doc(KuloStateDoc);
        const settings = await tx.doc(SettingsAssistantDoc);
        const current = callerSource(state, settings, api);
        const ticket = initial.ticket ? state.tickets[initial.ticket.id] : undefined;
        if (current.source.conversationId !== initial.source.conversationId || initial.ticket && (!ticket || ticket.runEpoch !== initial.ticket.runEpoch || ["stopped", "closed"].includes(ticket.status) || ticket.cleanupPending)) throw new UiCardError("content_scope_denied", "文件发送期间任务归属或执行资格已变化。", 403);
        if (initial.project) {
          const project = assertProjectBinding(await tx.doc(KuloProjectsDoc), initial.project.id);
          if (project.grantRevision !== initial.project.grantRevision || project.directoryId !== initial.project.directoryId || project.workspaceDir !== initial.project.workspaceDir || project.deviceId !== initial.project.deviceId) throw new UiCardError("content_scope_denied", "文件发送期间项目授权已变化。", 403);
        }
        if (!reviewOnly || initial.worker) options.uploads.bindAttachments([asset], `conversation:${initial.source.conversationId}`, `agent:${Number(api.conversationId)}`);
        if (initial.worker && ticket) {
          options.uploads.bindAttachments([asset], `ticket:${ticket.id}`, `agent:${Number(api.conversationId)}`);
          stage(state, ticket, asset);
        } else if (reviewOnly && ticket) {
          stage(state, ticket, asset);
        } else if (!reviewOnly) {
          markPublished(state, initial.source.conversationId, asset.id);
        }
        clearFailure(state, ticket, input);
      });
      return attachment;
    } catch (error) {
      if (context.abortSignal?.aborted) throw error;
      const reason = options.redact(error instanceof Error ? error.message : "无法读取或发送文件。").replace(/\s+/g, " ").slice(0, 900);
      const name = options.redact(input.name || (input.assetId ? "图片或附件" : input.path.replace(/\\/g, "/").split("/").at(-1)) || "文件").replace(/\s+/g, " ").slice(0, 120);
      const state = await api.snapshot(KuloStateDoc, context);
      const settings = await api.snapshot(SettingsAssistantDoc, context);
      // Do not redirect a failed delivery into root when its original chat is gone.
      let source: UiCardSource | undefined;
      try { source = callerSource(state, settings, api).source; }
      catch (scopeError) { if (!(scopeError instanceof UiCardError)) throw scopeError; }
      const preparing = reviewOnly || Boolean(source?.ticketId);
      const prefix = preparing ? "产物提交审核失败" : "文件发送失败";
      const message = `${prefix}（${name}）：${reason}`;
      if (source) {
        const ticket = target?.ticket ?? (source.ticketId ? state?.tickets[source.ticketId] : undefined);
        if (source.ticketId) await recordFailure(api, ticket, input, context, message);
        if (!reviewOnly) await options.cards().publishAssetFailure(source, message, `${prefix}（${escapedText(name)}）：${escapedText(reason)}`);
      }
      throw new UiCardError("asset_publication_failed", message, error instanceof UiCardError ? error.status : 500);
    }
  };
  const inspectAsset = async (input: UiAssetPublicationInput & { offset?: number; limit?: number }, api: ToolExecutionApi, context: Context) => {
    const state = await api.snapshot(KuloStateDoc, context);
    const settings = await api.snapshot(SettingsAssistantDoc, context);
    if (!isOrchestratorConversation(api.conversationId, state) && !isActiveSettingsConversation(api.conversationId, settings)) {
      throw new UiCardError("asset_review_denied", "只有主 Agent 可以审核待交付产物。", 403);
    }
    const asset = input.assetId ? receivedAsset(state, settings, api, input).asset : await publish(input, api, context, true);
    if (asset.kind === "image") {
      const agent = await api.agent(context);
      const model = agent.model && api.models.getModel(agent.model.provider, agent.model.modelId);
      if (!model?.input.includes("image")) throw new UiCardError("asset_review_vision_required", "当前主模型不支持图片审阅；如为用户明确请求的手机原图截图，可直接调用 kulo_publish_asset 发布，无需先审阅。", 409);
    }
    return inspectAssetContent({ assetId: asset.id, offset: input.offset, limit: input.limit }, options.uploads);
  };
  return Object.assign(publish, { inspectAsset });
}
