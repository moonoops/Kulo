import { BACKGROUND_CONTEXT, withCancel, type Context } from "@earendil-works/chord/context";
import {
  AgentDoc, defineExtension, defineTool, section, UserEntry, ToolResultEntry, AssistantEntry,
  type Conversation, type ConversationId, type ConversationWatch,
  type Harness, type JsonObject, type ConversationView, type EntryRecord, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
  BuiltinThinkingEffort, CustomModelConfig, CustomProviderApi, EnvNodeDescriptor, ModelCalibrationProviderUpdate,
  KuloSettingsView, ProviderCatalogItem, ResolveModelMetadataRequest, ResolveModelMetadataResponse, SettingsBlockName,
  SettingsAssistantAction, SettingsAssistantContext, SettingsAssistantDecision,
  SettingsAssistantModule, SettingsAssistantSnapshot, SettingsAssistantConversation,
  ConnectionDescribeRequest, ConnectionPrepareRequest,
  TicketCardView, ChatAttachment, AppearanceCustomization, TopicSummary,
} from "@kulo/protocol";
import { DEFAULT_APPEARANCE_CUSTOMIZATION, isConversationModel, redactSensitiveText, validateAppearanceCustomization } from "@kulo/protocol";
import type { KuloConnections } from "./connections.js";
import { validateConfigurationModel } from "./model-configuration.js";
import { supportsNativeWebSearch } from "./model-native-tools.js";
import { KuloSettingsDoc, applySettingsBlockUpdate, sanitizeCustomModelList, type KuloDurableSettings } from "./settings.js";
import { KuloStateDoc, isOrchestratorConversation, type TopicTitleJob } from "./state.js";
import { completedTopicTitle, createTopicTitleJob, parseTopicTitle, retryFailedTopicTitle, titleGenerationFailure } from "./topic-titles.js";
import { SETTINGS_TITLE_INSTRUCTIONS, buildSettingsAssistantPrompt } from "./prompts.js";
import {
  SettingsAssistantDoc,
  isActiveSettingsConversation,
  isMainOrchestratorConversation,
  isSettingsTopicDeleted,
  parseSettingsTopicConversationId,
  settingsTopicId,
  type DeviceAssistantOperation,
  type SettingsAssistantState,
  type SettingsSessionCommand as SessionCommand,
  type SettingsTitleJob,
  type StoredSettingsAction as StoredAction,
  type StoredSettingsConversation as StoredConversation,
  type WorkspaceOperation,
  type WorkspaceUndoBefore,
  type WorkspaceUndoOperation,
  type WorkspaceUndoSupport,
} from "./settings-doc.js";
import type { DeviceAssistantHost, DeviceJoinStaging, HubDeviceController } from "./tools-devices.js";
import { resolveDeferredAddTools } from "./tool-surface.js";
import type { PreparedDeviceRoleChange } from "@kulo/env";

export {
  SettingsAssistantDoc,
  isActiveSettingsConversation,
  isMainOrchestratorConversation,
  isSettingsTopicDeleted,
  parseSettingsTopicConversationId,
  settingsTopicId,
  type DeviceAssistantOperation,
  type SettingsAssistantState,
  type WorkspaceOperation,
  type WorkspaceUndoBefore,
  type WorkspaceUndoOperation,
  type WorkspaceUndoSupport,
};

const MODULES = ["models", "workers", "identity", "machines", "appearance", "capabilities", "connections", "permissions", "schedules", "archives"] as const;
const INTENTS = ["add-api", "add-oauth", "edit-identity", "configure-memory", "add-connection", "add-device", "join-device"] as const;
const BLOCK_MODULE: Record<SettingsBlockName, SettingsAssistantModule> = {
  model: "models", executor: "workers", roles: "workers", presentation: "identity",
  memory: "identity", identity: "identity",
};
const FIELDS: Partial<Record<SettingsBlockName, readonly string[]>> = {
  model: ["defaultProvider", "defaultModel", "thinkingLevel"],
  executor: ["maxConcurrentWorkers", "maxSubagentsPerTicket", "watchdogMinutes", "paused", "completedTaskDisplayHours", "autoArchiveEnabled", "autoArchiveDays"],
  presentation: ["agentName"],
};
const FIELD_LABELS: Record<string, string> = {
  defaultProvider: "默认供应商", defaultModel: "默认模型", thinkingLevel: "思考强度",
  maxConcurrentWorkers: "并发上限", maxSubagentsPerTicket: "子智能体上限", watchdogMinutes: "巡检超时", paused: "暂停新任务",
  completedTaskDisplayHours: "已完成任务显示时长",
  autoArchiveEnabled: "自动归档", autoArchiveDays: "未活动天数",
  agentName: "智能体名称", enabled: "启用", label: "名称", whenToUse: "适用任务", prompt: "角色指令",
  readOnly: "只读", allowSubagents: "允许子智能体", provider: "供应商", modelId: "模型",
};
function displayValue(value: unknown, name?: string): string {
  if (name === "completedTaskDisplayHours") return value === null ? "一直显示" : String(value === undefined ? 3 : value) + " 小时";
  if (name === "autoArchiveDays") return String(value === undefined ? 7 : value) + " 天";
  return value == null || value === "" ? "未设置" : typeof value === "boolean" ? value ? "开启" : "关闭" : String(value);
}

function publicConnectionArguments(args: object, allowed: readonly string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("连接工具不接收凭据明文或未定义字段。");
}

// Durable transaction values are draft proxies, so clone their JSON representation.
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function topicId(conversationId: number | null | undefined): string | null { return conversationId == null ? null : `settings-${conversationId}`; }
function parseTopicId(value: unknown, nullable = true): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !/^settings-[1-9]\d*$/.test(value)) throw new Error("无效的设置对话标识。");
  const id = Number(value.slice("settings-".length));
  if (!Number.isSafeInteger(id)) throw new Error("无效的设置对话标识。");
  return id;
}
function assertExpected(state: Readonly<SettingsAssistantState> | undefined, expectedTopicId: string | null): void {
  parseTopicId(expectedTopicId);
  if (topicId(state?.conversationId) !== expectedTopicId) throw new Error("设置对话已更新，请重试当前操作。");
}
function saveConversation(state: SettingsAssistantState, view: SettingsAssistantConversation): StoredConversation {
  return {
    view: clone(view), actions: clone(state.actions), turnContext: clone(state.turnContext),
    observedRevisions: clone(state.observedRevisions),
    ...(state.observedWorkspace ? { observedWorkspace: clone(state.observedWorkspace) } : {}),
  };
}
function conversationTitle(text: string, redact: (text: string) => string): string {
  // Import receipts are appended on a separate line; truncating them changes redaction semantics.
  const firstLine = redact(text).trim().split(/\r?\n/, 1)[0] ?? "";
  return redact(firstLine.replace(/\s+/g, " ").slice(0, 80));
}
function historicAction(value: unknown, redact: (text: string) => string): StoredAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = "action" in value ? value.action : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
  const record = candidate as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.title !== "string" ||
    !["settings", "appearance", "appearance-customization", "navigate"].includes(String(record.kind)) ||
    !["pending", "submitted", "applied", "rejected", "undone", "failed"].includes(String(record.status)) ||
    !Array.isArray(record.changes) || record.changes.some((change) => typeof change !== "string")) return;
  // Tool receipts establish what was returned then, not a later confirmation or undo.
  return { view: {
    id: record.id, title: redact(record.title), kind: record.kind as SettingsAssistantAction["kind"],
    status: record.status as SettingsAssistantAction["status"], changes: record.changes.map((change) => redact(change as string)),
    canUndo: false, requiresConfirmation: false, historical: true,
    ...(typeof record.description === "string" ? { description: redact(record.description) } : {}),
    ...(record.kind === "appearance-customization" && record.customization ? { customization: validateAppearanceCustomization(record.customization) } : {}),
  } };
}
function field(object: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, object);
}
function assignField(object: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let target = object;
  for (const part of parts.slice(0, -1)) {
    const next = target[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("设置字段不存在。");
    target = next as Record<string, unknown>;
  }
  if (value === undefined) delete target[parts.at(-1)!];
  else target[parts.at(-1)!] = clone(value);
}

export function validateSettingsAssistantContext(raw: SettingsAssistantContext): SettingsAssistantContext {
  if (!raw || !MODULES.some((module) => module === raw.module) || typeof raw.hasUnsavedChanges !== "boolean" ||
    !["system", "light", "dark"].includes(raw.appearance) ||
    typeof raw.clientId !== "string" || !raw.clientId.trim() || raw.clientId.length > 120) {
    throw new Error("无效的设置助手页面上下文。");
  }
  if (raw.active !== undefined && typeof raw.active !== "boolean" || raw.pageGeneration !== undefined && (!Number.isSafeInteger(raw.pageGeneration) || raw.pageGeneration < 1)) throw new Error("无效的设置页面状态。");
  if (raw.target && (!["capability", "skill", "connection", "extension", "external-agent"].includes(raw.target.kind) || typeof raw.target.id !== "string" || !raw.target.id.trim() || raw.target.id.length > 200)) throw new Error("无效的配置目标。");
  return { module: raw.module, hasUnsavedChanges: raw.hasUnsavedChanges, appearance: raw.appearance, clientId: raw.clientId,
    ...(raw.active !== undefined ? { active: raw.active } : {}), ...(raw.pageGeneration !== undefined ? { pageGeneration: raw.pageGeneration } : {}),
    ...(raw.appearanceCustomization !== undefined ? { appearanceCustomization: raw.appearanceCustomization === null ? null : validateAppearanceCustomization(raw.appearanceCustomization) } : {}),
    ...(raw.target ? { target: { ...raw.target } } : {}) };
}

interface AssistantHost {
  harness: Harness;
  extension: ReturnType<typeof createSettingsAssistantExtension>;
  globalExtension?: ReturnType<typeof createGlobalSettingsToolsExtension>;
  agent: () => { model: { provider: string; modelId: string }; thinkingLevel: BuiltinThinkingEffort };
  tools?: (context?: SettingsAssistantContext, extensions?: readonly ReturnType<typeof defineExtension>[]) => readonly ToolRegistration[] | null;
  preloadedToolNames?: (context?: SettingsAssistantContext) => readonly string[];
  settingsTierExtension?: ReturnType<typeof defineExtension>;
  settings: () => KuloSettingsView;
  providers: () => Promise<ProviderCatalogItem[]>;
  envs: () => EnvNodeDescriptor[];
  display: (view: ConversationView, conversationId?: number) => Pick<SettingsAssistantSnapshot, "messages" | "live">;
  hydrateConversation?: (conversationId: number) => Promise<void>;
  applied: (settings: KuloDurableSettings) => Promise<void>;
  removeProviderAuth: (providerId: string) => Promise<void>;
  emit: (snapshot: SettingsAssistantSnapshot) => void;
  cwd?: string;
  orchestratorExtensions?: ReturnType<typeof defineExtension>[];
  capabilityExtensions?: ReturnType<typeof defineExtension>[];
  memoryExtensions?: ReturnType<typeof defineExtension>[];
  appearanceExtensions?: ReturnType<typeof defineExtension>[];
  modelExtensions?: ReturnType<typeof defineExtension>[];
  agentConfigurationExtensions?: ReturnType<typeof defineExtension>[];
  deviceExtensions?: ReturnType<typeof defineExtension>[];
  securityExtensions?: ReturnType<typeof defineExtension>[];
  customizationExtensions?: ReturnType<typeof defineExtension>[];
  processText?: (content: string, requestId?: string) => Promise<{ text: string }>;
  prepareInput: (content: string, attachments: ChatAttachment[], principalId: string) => { content: UserMessage["content"]; attachments: ChatAttachment[] };
  bindAttachments: (attachments: ChatAttachment[], conversationId: number, principalId: string) => void;
  connections?: KuloConnections;
  workspaceRead?: (clientId: string) => Promise<unknown>;
  extensionsRead?: (clientId?: string) => Promise<unknown>;
  scheduledTasks?: () => Promise<TicketCardView[]>;
  applyWorkspaceOperation?: (operation: WorkspaceOperation) => Promise<unknown>;
  deviceController?: () => HubDeviceController | undefined;
  joinStaging?: DeviceJoinStaging;
  hasRunningLocalTasks?: () => Promise<boolean>;
  resolveModelMetadata?: (req: ResolveModelMetadataRequest) => Promise<ResolveModelMetadataResponse>;
  refreshModelMetadata?: (force?: boolean) => Promise<{ updated: boolean; fromCache: boolean; source: string; fetchedAt?: number; error?: string }>;
  isOfficialNativeSearchAllowed?: (providerId: string) => boolean;
}

export class SettingsAssistant implements DeviceAssistantHost {
  readonly #host: AssistantHost;
  readonly #contexts = new Map<string, SettingsAssistantContext>();
  #conversation: Conversation | null = null;
  #watch: ConversationWatch | null = null;
  #restore: Promise<Conversation | null> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #titleWork = new Map<number, Promise<void>>();
  readonly #titleStops = new Map<number, Promise<void>>();
  readonly #titleCancels = new Map<number, ReturnType<typeof withCancel>>();
  readonly #finishedTitles = new Set<number>();
  readonly #titleLifetime = withCancel(BACKGROUND_CONTEXT);
  #started = false;
  #closed = false;

  constructor(host: AssistantHost) { this.#host = host; }

  #redact(text: string): string { return this.#host.connections?.redact(text) ?? redactSensitiveText(text); }

  #titleText(text: string, limit: number): string {
    const safe = this.#redact(text)
      .replace(/\n\[(?:连接|信息)已安全保存：[^\r\n]*\]$/u, "")
      .replace(/\n\[设备接入配对已安全暂存：[^\r\n]*\]$/u, "")
      .replace(/\n\[Device join staged:[^\r\n]*\]$/u, "");
    return this.#redact(Array.from(safe).slice(0, limit).join(""));
  }

  #titleJob(text: string, attachmentNames: string[], fallbackTitle: string): SettingsTitleJob {
    const userText = this.#titleText(text, 4000);
    const names = attachmentNames.slice(0, 20).map((name) => this.#titleText(name, 240));
    const job = createTopicTitleJob(userText, names, fallbackTitle);
    return job ? { ...job, userText: this.#titleText(job.userText, 4000), attachmentNames: job.attachmentNames.map((name) => this.#titleText(name, 240)) }
      : { status: "skipped", fallbackTitle, userText, attachmentNames: names };
  }

  #titleFallback(text: string): string {
    return this.#redact(Array.from(conversationTitle(text, (value) => this.#redact(value))).slice(0, 24).join(""));
  }

  async start(): Promise<void> {
    this.#started = true;
    await this.#host.harness.commit(async (tx) => {
      const state = await tx.doc(SettingsAssistantDoc);
      for (const [id, job] of Object.entries(state.titleJobs ?? {})) {
        const session = state.conversations?.[id];
        if (session && !state.deletedConversationIds?.includes(Number(id)) && session.view.title === job.fallbackTitle) retryFailedTopicTitle(job);
      }
    }, BACKGROUND_CONTEXT);
    const state = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    for (const [id, job] of Object.entries(state?.titleJobs ?? {})) {
      if (job.status !== "pending") this.#finishedTitles.add(Number(id));
      else this.#queueTitle(Number(id));
    }
    if (state?.conversationId != null && state.titleJobs?.[String(state.conversationId)]?.status === "pending") {
      await this.#ensureHistory();
      await this.#ensureConversation(false);
      this.#observeTitle(await this.#snapshot());
    }
  }

  #titleEligible(state: Readonly<SettingsAssistantState> | undefined, id: number): boolean {
    const session = state?.conversations?.[String(id)];
    const job = state?.titleJobs?.[String(id)];
    return Boolean(session && !state?.deletedConversationIds?.includes(id) && job?.status === "pending" && session.view.title === job.fallbackTitle);
  }

  #observeTitle(snapshot: SettingsAssistantSnapshot): void {
    if (!this.#started || this.#closed || snapshot.topicId === null || snapshot.live.busy || snapshot.live.runFailure) return;
    if (!snapshot.messages.some((message) => message.role === "assistant" && message.text.trim())) return;
    this.#queueTitle(Number(snapshot.topicId.slice("settings-".length)));
  }

  #queueTitle(id: number): void {
    if (!this.#started || this.#closed || this.#finishedTitles.has(id) || this.#titleWork.has(id)) return;
    const lifetime = withCancel(this.#titleLifetime.context);
    this.#titleCancels.set(id, lifetime);
    const work = this.#generateTitle(id, lifetime.context).catch(async (error: unknown) => {
      if (this.#closed || lifetime.context.abortSignal?.aborted) return;
      const failure = titleGenerationFailure(error);
      await this.#finishTitle(id, "failed", undefined, failure);
      console.warn("[KuloSettingsTitle]", id, failure.code, failure.message);
    }).catch((error: unknown) => {
      if (!this.#closed) console.error("[KuloSettingsTitle] Could not persist generation outcome", id, error instanceof Error ? error.name : "error");
    }).finally(() => { this.#titleWork.delete(id); this.#titleCancels.delete(id); });
    this.#titleWork.set(id, work);
  }

  #stopTitleConversation(id: number): void {
    if (this.#titleStops.has(id) || this.#closed) return;
    const context = this.#titleLifetime.context;
    const stopped = (async () => {
      const conversation = await this.#host.harness.conversation(id as ConversationId, context);
      if (conversation) await conversation.abort(context, { background: true });
    })().catch((error: unknown) => {
      if (!this.#closed && !context.abortSignal?.aborted) console.error("[KuloSettingsTitle] Could not stop deleted title", id, error instanceof Error ? error.name : "error");
    }).finally(() => this.#titleStops.delete(id));
    this.#titleStops.set(id, stopped);
  }

  async #firstExchange(id: number, context: Context): Promise<{ userText: string; attachmentNames: string[]; assistantText?: string; complete: boolean }> {
    const conversation = await this.#host.harness.conversation(id as ConversationId, context);
    if (!conversation) throw new Error("设置历史对话不存在。");
    let userText = "";
    let attachmentNames: string[] = [];
    let foundUser = false;
    const replies: string[] = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
      for (const entry of page.items) {
        if (!foundUser && entry.kind === "kulo.user" && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) && Array.isArray(entry.data.attachments)) {
          attachmentNames = entry.data.attachments.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.name === "string" ? [item.name] : []);
        }
        if (UserEntry.is(entry)) {
          if (foundUser) return { userText, attachmentNames, complete: true };
          const message = entry.model?.[0];
          if (message?.role !== "user") continue;
          foundUser = true;
          userText = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        } else if (foundUser && AssistantEntry.is(entry)) {
          const message = entry.model?.[0];
          if (message?.role !== "assistant") continue;
          if (message.stopReason === "error" || message.stopReason === "aborted") return { userText, attachmentNames, complete: true };
          const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
          if (text.trim()) replies.push(text);
          if (message.stopReason === "stop") return { userText, attachmentNames, assistantText: replies.join("\n"), complete: true };
        }
      }
      cursor = page.next;
    } while (cursor);
    return { userText, attachmentNames, complete: false };
  }

  async #generateTitle(id: number, context: Context): Promise<void> {
    const state = await this.#host.harness.snapshot(SettingsAssistantDoc, context);
    if (!state?.conversations?.[String(id)] || state.deletedConversationIds?.includes(id)) { this.#finishedTitles.add(id); return; }
    let job = state.titleJobs?.[String(id)] ? clone(state.titleJobs[String(id)]!) : undefined;
    if (job && job.status !== "pending") { this.#finishedTitles.add(id); return; }
    if (!job || job.assistantText === undefined) {
      const exchange = await this.#firstExchange(id, context);
      if (!exchange.complete) return;
      let fallbackChanged = false;
      job = await this.#host.harness.commit(async (tx) => {
        const current = await tx.doc(SettingsAssistantDoc);
        const session = current.conversations?.[String(id)];
        if (!session || current.deletedConversationIds?.includes(id)) return undefined;
        current.titleJobs ??= {};
        if (!current.titleJobs[String(id)]) {
          const fallback = this.#titleFallback(exchange.userText || exchange.attachmentNames.join("、"));
          current.titleJobs[String(id)] = this.#titleJob(exchange.userText, exchange.attachmentNames, fallback);
          fallbackChanged = session.view.title !== fallback;
          session.view.title = fallback;
        }
        const pending = current.titleJobs[String(id)]!;
        if (pending.status === "pending" && pending.assistantText === undefined) {
          if (!exchange.assistantText?.trim()) pending.status = "skipped";
          else pending.assistantText = this.#titleText(exchange.assistantText, 4000);
        }
        return clone(pending);
      }, context);
      if (fallbackChanged) await this.#emit();
    }
    if (!job || job.status !== "pending") { this.#finishedTitles.add(id); return; }
    const eligible = await this.#host.harness.snapshot(SettingsAssistantDoc, context);
    if (!this.#titleEligible(eligible, id)) { await this.#finishTitle(id, "cancelled"); return; }
    let conversation = job.conversationId === undefined ? undefined : await this.#host.harness.conversation(job.conversationId as ConversationId, context);
    if (!conversation) {
      const selection = this.#host.agent();
      if (!selection.model.modelId.trim()) { await this.#finishTitle(id, "failed"); return; }
      conversation = await this.#host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
        model: selection.model, thinkingLevel: selection.thinkingLevel, extensions: [...(this.#host.securityExtensions ?? [])], tools: [], modelTools: [], maxTurns: 1,
        instructions: SETTINGS_TITLE_INSTRUCTIONS,
      } }, context);
      const titleConversationId = Number(conversation.id);
      const claimed = await this.#host.harness.commit(async (tx) => {
        const current = await tx.doc(SettingsAssistantDoc);
        const pending = current.titleJobs?.[String(id)];
        if (pending && pending.conversationId === undefined) pending.conversationId = titleConversationId;
        return this.#titleEligible(current, id);
      }, context);
      if (!claimed) return;
    }
    const submission = await conversation.submit({ type: "input", whenBusy: "reject", requestId: `kulo:settings-title:${id}`,
      content: JSON.stringify({ user: this.#titleText(job.userText, 4000), attachments: job.attachmentNames.map((name) => this.#titleText(name, 240)), assistant: this.#titleText(job.assistantText ?? "", 4000) }) }, context);
    const settled = await submission.wait(context);
    const page = await conversation.entries({}, 8, undefined, context);
    const entry = page.items.find(AssistantEntry.is);
    const message = entry?.model?.[0];
    const parsed = completedTopicTitle(settled.status, message?.role === "assistant" ? message : undefined);
    const title = parsed === null ? null : parseTopicTitle(JSON.stringify({ title: this.#redact(parsed) }));
    await this.#finishTitle(id, "done", title);
  }

  async #finishTitle(id: number, status: SettingsTitleJob["status"], title?: string | null, failure?: TopicTitleJob["failure"]): Promise<void> {
    const changed = await this.#host.harness.commit(async (tx) => {
      const state = await tx.doc(SettingsAssistantDoc);
      const job = state.titleJobs?.[String(id)];
      if (!job || job.status !== "pending") return false;
      if (!this.#titleEligible(state, id)) { job.status = "cancelled"; return false; }
      job.status = status;
      if (failure) job.failure = failure;
      if (!title) return false;
      state.conversations![String(id)]!.view.title = title;
      return true;
    }, this.#titleLifetime.context);
    this.#finishedTitles.add(id);
    if (changed) await this.#emit();
  }

  updateContext(context: SettingsAssistantContext): void {
    const next = validateSettingsAssistantContext(context);
    this.#contexts.set(next.clientId, next);
  }

  forgetContext(clientId: string): void { this.#contexts.delete(clientId); }

  async getSnapshot(): Promise<SettingsAssistantSnapshot> {
    // Reconnects and stop controls must remain usable while a tool awaits external I/O.
    const snapshot = this.#conversation && this.#watch ? await this.#snapshot() : await this.#serialize(async () => {
      await this.#ensureHistory();
      await this.#ensureConversation(false);
      return this.#snapshot();
    });
    this.#observeTitle(snapshot);
    return snapshot;
  }

  async conversationIds(): Promise<number[]> {
    const doc = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    return [...new Set([...(doc?.archivedConversationIds ?? []), ...(doc?.deletedConversationIds ?? []), ...Object.keys(doc?.conversations ?? {}).map(Number), ...(doc?.conversationId == null ? [] : [doc.conversationId]), ...Object.values(doc?.titleJobs ?? {}).flatMap((job) => job.conversationId === undefined ? [] : [job.conversationId])])];
  }

  async #ensureHistory(): Promise<void> {
    const state = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const ids = [...new Set([...(state?.archivedConversationIds ?? []), ...(state?.conversationId == null ? [] : [state.conversationId])])]
      .filter((id) => !state?.conversations?.[String(id)] && !state?.deletedConversationIds?.includes(id));
    if (!ids.length) return;
    const restored = new Map<number, StoredConversation>();
    for (const id of ids) {
      const conversation = await this.#host.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
      if (!conversation) throw new Error("历史设置对话不存在。");
      const entries: EntryRecord[] = [];
      let cursor: Parameters<Conversation["entries"]>[2];
      do {
        const page = await conversation.entries({ order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
        entries.push(...page.items);
        cursor = page.next;
      } while (cursor);
      const user = entries.find(UserEntry.is)?.model?.find((message) => message.role === "user");
      const title = user?.role === "user" ? typeof user.content === "string" ? user.content : user.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ") : "";
      const timestamps = entries.flatMap((entry) => entry.model?.map((message) => message.timestamp).filter((time) => Number.isFinite(time) && time > 0) ?? []);
      const view: SettingsAssistantConversation = {
        topicId: topicId(id)!, title: this.#titleFallback(title),
        createdAt: timestamps.length ? Math.min(...timestamps) : 0, updatedAt: timestamps.length ? Math.max(...timestamps) : 0,
        ...(state?.conversationId === id && state.turnContext ? { module: state.turnContext.module } : {}),
      };
      if (state?.conversationId === id) {
        restored.set(id, saveConversation(state as SettingsAssistantState, view));
      } else {
        const actions = new Map<string, StoredAction>();
        for (const entry of entries.filter(ToolResultEntry.is)) {
          const message = entry.model?.[0];
          if (message?.role !== "toolResult" || message.isError) continue;
          for (const part of message.content) {
            if (part.type !== "text") continue;
            let value: unknown;
            try { value = JSON.parse(part.text); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
            const action = historicAction(value, (text) => this.#redact(text));
            if (action) actions.set(action.view.id, action);
          }
        }
        restored.set(id, { view, actions: [...actions.values()], turnContext: null, observedRevisions: {} });
      }
    }
    await this.#host.harness.commit(async (tx) => {
      const current = await tx.doc(SettingsAssistantDoc);
      current.conversations ??= {};
      for (const [id, stored] of restored) if (!current.deletedConversationIds?.includes(id)) current.conversations[String(id)] ??= stored;
    }, BACKGROUND_CONTEXT);
  }

  async #snapshot(): Promise<SettingsAssistantSnapshot> {
    const doc = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const convId = doc?.conversationId ?? undefined;
    const watch = Number(this.#conversation?.id) === convId ? this.#watch : null;
    if (watch && convId !== undefined) await this.#host.hydrateConversation?.(convId);
    return {
      topicId: topicId(doc?.conversationId),
      ...(watch ? this.#host.display(watch.value, convId) : { messages: [], live: { busy: false, activeTools: [], queuedCount: 0 } }),
      actions: clone(doc?.actions.map((action) => this.#deviceActionView(action)) ?? []),
      conversations: clone(Object.values(doc?.conversations ?? {}).filter((item) => !doc?.deletedConversationIds?.includes(Number(item.view.topicId.slice(9)))).map((item) => item.view).sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || Number(right.topicId.slice(9)) - Number(left.topicId.slice(9)))),
    };
  }

  #deviceActionView({ view, deviceOperation }: StoredAction): SettingsAssistantAction {
    if (view.status !== "submitted" || deviceOperation?.kind !== "device-join") return view;
    const controller = this.#host.deviceController?.();
    const state = controller?.roleStatus?.(view.id);
    if (state?.status === "ready") return { ...view, status: "applied" };
    if (state?.status === "failed" || (!state && controller?.canResumeJoin?.(view.id, deviceOperation.hubUrl))) {
      return { ...view, status: "pending", error: state?.error ?? "接入已中断，可重新确认后继续。" };
    }
    return view;
  }

  async refreshIfConversation(conversationId: number): Promise<void> {
    if (this.#closed || Number(this.#conversation?.id) !== conversationId) return;
    await this.#emit();
  }

  async renameConversation(targetTopicId: string, rawTitle: string): Promise<TopicSummary> {
    const id = parseTopicId(targetTopicId, false)!;
    const title = this.#redact(rawTitle.trim()).slice(0, 80);
    if (!title) throw new Error("会话名称无效。");
    const updated = await this.#host.harness.commit(async (tx) => {
      const state = await tx.doc(SettingsAssistantDoc);
      const session = state.conversations?.[String(id)];
      if (!session || state.deletedConversationIds?.includes(id)) throw new Error("设置对话不存在。");
      session.view.title = title;
      session.view.updatedAt = Date.now();
      const job = state.titleJobs?.[String(id)];
      if (job?.status === "pending") job.status = "cancelled";
      return clone(session.view);
    }, BACKGROUND_CONTEXT);
    this.#finishedTitles.add(id);
    this.#titleCancels.get(id)?.cancel();
    await this.#emit();
    return { id: updated.topicId, conversationId: id, title: updated.title, createdAt: updated.createdAt, updatedAt: updated.updatedAt };
  }

  async #emit(source?: ConversationWatch): Promise<void> {
    const snapshot = await this.#snapshot();
    if (!this.#closed && (!source || this.#watch === source)) this.#host.emit(snapshot);
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #ensureConversation(create: boolean): Promise<Conversation | null> {
    if (this.#conversation) return this.#conversation;
    if (this.#restore) { await this.#restore; return this.#conversation || (create ? this.#ensureConversation(true) : null); }
    this.#restore = this.#restoreConversation(create);
    try { return await this.#restore; } finally { this.#restore = null; }
  }

  async #restoreConversation(create: boolean): Promise<Conversation | null> {
    const doc = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const agent = this.#agent(doc?.turnContext ?? undefined);
    let conversation: Conversation | null = null;
    if (doc?.conversationId != null) {
      conversation = await this.#host.harness.conversation(doc.conversationId as ConversationId, BACKGROUND_CONTEXT) ?? null;
      if (!conversation) throw new Error("设置助手对话不存在。");
    } else if (create) {
      conversation = await this.#host.harness.createConversation({ ownership: { kind: "ownerless" }, agent }, BACKGROUND_CONTEXT);
      await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        state.conversationId = Number(conversation!.id);
        state.conversations ??= {};
        const now = Date.now();
        state.conversations[String(conversation!.id)] = saveConversation(state, { topicId: topicId(Number(conversation!.id))!, title: "", createdAt: now, updatedAt: now });
      }, BACKGROUND_CONTEXT);
    }
    if (!conversation) return null;
    const convNum = Number(conversation.id);
    await this.#host.hydrateConversation?.(convNum);
    const watch = await conversation.watch(BACKGROUND_CONTEXT, { min: 80, max: 160 });
    if (!this.#host.display(watch.value, convNum).live.busy) {
      await this.#configureConversation(conversation, doc?.turnContext ?? undefined, false, BACKGROUND_CONTEXT);
    }
    this.#conversation = conversation;
    this.#watch = watch;
    watch.start(async (call) => {
      if (call.kind !== "value" || this.#watch !== watch) return;
      await this.#emit(watch);
      if (this.#watch === watch) this.#observeTitle({ topicId: topicId(convNum), ...this.#host.display(watch.value, convNum), actions: [], conversations: [] });
    });
    return conversation;
  }

  async send(content: string, context: SettingsAssistantContext, requestId?: string, attachments: ChatAttachment[] = [], principalId = "local", expectedTopicId?: string | null): Promise<void> {
    context = validateSettingsAssistantContext(context);
    // Retries carry the original semantic page; only context messages refresh draft state.
    if (!this.#contexts.has(context.clientId)) this.updateContext(context);
    if (!Array.isArray(attachments)) throw new Error("无效的设置附件列表。");
    if (typeof content !== "string" || (!content.trim() && attachments.length === 0) || content.length > 32_000) throw new Error("请输入设置需求或添加附件（文字最多 32000 字）。");
    await this.#serialize(async () => {
      const doc = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (requestId && doc?.submitted.includes(requestId)) return;
      if (expectedTopicId !== undefined) assertExpected(doc, expectedTopicId);
      if (!this.#host.settings().blocks.model.value.defaultModel.trim()) {
        throw Object.assign(new Error("请先连接并选择一个模型。"), { code: "model_not_selected" });
      }
      await this.#ensureHistory();
      const conversation = (await this.#ensureConversation(true))!;
      // Read a fresh durable view; the streamed watch can still lag the last admission.
      const current = await conversation.watch(BACKGROUND_CONTEXT, { min: 1, max: 1 });
      const busy = this.#host.display(current.value).live.busy;
      await current.stop();
      if (busy) throw new Error("设置助手正在处理上一条请求。");
      const text = this.#host.processText ? (await this.#host.processText(content, requestId ? `settings:${context.clientId}:${requestId}` : undefined)).text : content;
      const prepared = this.#host.prepareInput(text.trim(), attachments, principalId);
      await this.#configureConversation(conversation, context, false, BACKGROUND_CONTEXT);
      await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        const settings = await tx.doc(KuloSettingsDoc);
        await conversation.submit(tx, { type: "input", content: prepared.content, whenBusy: "reject", ...(requestId ? { requestId } : {}) });
        state.turnContext = clone(context);
        state.observedRevisions = clone(settings.revisions);
        delete state.observedWorkspace;
        const history = state.conversations![String(conversation.id)]!;
        if (!history.view.title) history.view.title = this.#titleFallback(text.trim() || prepared.attachments.map((attachment) => attachment.name).join("、"));
        state.titleJobs ??= {};
        state.titleJobs[String(conversation.id)] ??= this.#titleJob(text, prepared.attachments.map((attachment) => attachment.name), history.view.title);
        history.view.module ??= context.module;
        history.view.updatedAt = Date.now();
        if (requestId) state.submitted = [...state.submitted, requestId].slice(-256);
      }, BACKGROUND_CONTEXT);
      this.#host.bindAttachments(prepared.attachments, Number(conversation.id), principalId);
      await this.#emit();
    });
  }

  async abort(expectedTopicId?: string | null): Promise<void> {
    const state = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    if (expectedTopicId !== undefined) assertExpected(state, expectedTopicId);
    if (state?.conversationId == null) return;
    // Stop must bypass tool I/O in the operation queue and retain its captured target.
    const conversation = await this.#host.harness.conversation(state.conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error("设置助手对话不存在。");
    await conversation.abort(BACKGROUND_CONTEXT);
  }

  async #assertIdle(conversation: Conversation | null): Promise<void> {
    if (!conversation) return;
    const current = await conversation.watch(BACKGROUND_CONTEXT, { min: 1, max: 1 });
    const busy = this.#host.display(current.value).live.busy;
    await current.stop();
    if (busy) throw new Error("请先停止当前请求，再切换设置对话。");
  }

  #sessionReplay(state: Readonly<SettingsAssistantState> | undefined, kind: SessionCommand["kind"], expectedTopicId: string | null, requestId?: string, targetTopicId?: string): boolean {
    if (!requestId) return false;
    const previous = state?.sessionCommands?.find((command) => command.requestId === requestId);
    if (!previous) return false;
    if (previous.kind !== kind || previous.expectedTopicId !== expectedTopicId || targetTopicId !== undefined && previous.topicId !== targetTopicId) throw new Error("设置对话请求标识已被使用。");
    return true;
  }

  #leaveConversation(state: SettingsAssistantState): void {
    if (state.conversationId === null) return;
    const stored = state.conversations![String(state.conversationId)]!;
    for (const action of state.actions) {
      if (action.view.kind !== "settings" && action.view.status === "pending") {
        action.view.status = "failed";
        action.view.canUndo = false;
        action.view.error = "已切换设置对话，请重新发起操作。";
      }
    }
    state.conversations![String(state.conversationId)] = saveConversation(state, stored.view);
  }

  async #watchSelected(): Promise<void> {
    const watch = this.#watch;
    this.#watch = null;
    this.#conversation = null;
    if (watch) await watch.stop();
    await this.#ensureConversation(false);
    await this.#emit();
    this.#observeTitle(await this.#snapshot());
  }

  async newConversation(expectedTopicId: string | null, requestId?: string): Promise<void> {
    parseTopicId(expectedTopicId);
    await this.#serialize(async () => {
      const before = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (this.#sessionReplay(before, "new", expectedTopicId, requestId)) { await this.#emit(); return; }
      assertExpected(before, expectedTopicId);
      await this.#ensureHistory();
      await this.#assertIdle(await this.#ensureConversation(false));
      const conversation = await this.#host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: this.#agent() }, BACKGROUND_CONTEXT);
      const id = Number(conversation.id);
      await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        this.#leaveConversation(state);
        state.archivedConversationIds = [...new Set([...state.archivedConversationIds, ...(state.conversationId === null ? [] : [state.conversationId])])];
        state.conversationId = id;
        state.actions = [];
        state.turnContext = null;
        state.observedRevisions = {};
        delete state.observedWorkspace;
        state.conversations ??= {};
        const now = Date.now();
        state.conversations[String(id)] = saveConversation(state, { topicId: topicId(id)!, title: "", createdAt: now, updatedAt: now });
        if (requestId) state.sessionCommands = [...(state.sessionCommands ?? []), { requestId, kind: "new" as const, expectedTopicId, topicId: topicId(id)! }].slice(-256);
      }, BACKGROUND_CONTEXT);
      await this.#watchSelected();
    });
  }

  async selectConversation(selectedTopicId: string, expectedTopicId: string | null, requestId?: string): Promise<void> {
    const id = parseTopicId(selectedTopicId, false)!;
    parseTopicId(expectedTopicId);
    await this.#serialize(async () => {
      const before = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (this.#sessionReplay(before, "select", expectedTopicId, requestId, selectedTopicId)) { await this.#emit(); return; }
      assertExpected(before, expectedTopicId);
      await this.#ensureHistory();
      const current = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (!current?.conversations?.[String(id)] || current.deletedConversationIds?.includes(id)) throw new Error("设置历史对话不存在。");
      await this.#assertIdle(await this.#ensureConversation(false));
      if (current.conversationId !== id) {
        const target = await this.#host.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
        if (!target) throw new Error("设置历史对话不存在。");
        await this.#assertIdle(target);
      }
      await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        if (state.conversationId !== id) {
          this.#leaveConversation(state);
          const saved = clone(state.conversations![String(id)]!);
          state.archivedConversationIds = [...new Set([...state.archivedConversationIds, ...(state.conversationId === null ? [] : [state.conversationId])])].filter((candidate) => candidate !== id);
          state.conversationId = id;
          state.actions = saved.actions;
          state.turnContext = saved.turnContext;
          state.observedRevisions = saved.observedRevisions;
          if (saved.observedWorkspace) state.observedWorkspace = saved.observedWorkspace;
          else delete state.observedWorkspace;
        }
        if (requestId) state.sessionCommands = [...(state.sessionCommands ?? []), { requestId, kind: "select" as const, expectedTopicId, topicId: selectedTopicId }].slice(-256);
      }, BACKGROUND_CONTEXT);
      await this.#watchSelected();
    });
  }

  async deleteConversation(selectedTopicId: string, expectedTopicId: string | null, requestId?: string): Promise<void> {
    const id = parseTopicId(selectedTopicId, false)!;
    parseTopicId(expectedTopicId);
    await this.#serialize(async () => {
      const before = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (this.#sessionReplay(before, "delete", expectedTopicId, requestId, selectedTopicId) || before?.deletedConversationIds?.includes(id)) { await this.#emit(); return; }
      assertExpected(before, expectedTopicId);
      await this.#ensureHistory();
      const current = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (!current?.conversations?.[String(id)]) throw new Error("设置历史对话不存在。");
      const deletingActive = current.conversationId === id;
      if (deletingActive) await this.#assertIdle(await this.#ensureConversation(false));
      const titleConversationId = await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        state.deletedConversationIds = [...new Set([...(state.deletedConversationIds ?? []), id])];
        delete state.conversations![String(id)];
        state.archivedConversationIds = state.archivedConversationIds.filter((candidate) => candidate !== id);
        const title = state.titleJobs?.[String(id)];
        if (title) title.status = "cancelled";
        if (state.conversationId === id) {
          state.conversationId = null;
          state.actions = [];
          state.turnContext = null;
          state.observedRevisions = {};
          delete state.observedWorkspace;
        }
        if (requestId) state.sessionCommands = [...(state.sessionCommands ?? []), { requestId, kind: "delete" as const, expectedTopicId, topicId: selectedTopicId }].slice(-256);
        return title?.conversationId;
      }, BACKGROUND_CONTEXT);
      this.#finishedTitles.add(id);
      this.#titleCancels.get(id)?.cancel();
      // The deletion fence is durable; a slow provider must not delay history removal.
      if (titleConversationId !== undefined) this.#stopTitleConversation(titleConversationId);
      if (deletingActive) await this.#watchSelected();
      else await this.#emit();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#titleLifetime.cancel();
    if (this.#watch) await this.#watch.stop();
    await Promise.allSettled([...this.#titleWork.values(), ...this.#titleStops.values()]);
    this.#contexts.clear();
  }

  async reconfigureActiveConversation(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.#closed) return;
    const doc = await this.#host.harness.snapshot(SettingsAssistantDoc, context);
    if (doc?.conversationId == null || doc.deletedConversationIds?.includes(doc.conversationId)) return;
    const conv = this.#conversation && Number(this.#conversation.id) === doc.conversationId
      ? this.#conversation
      : await this.#host.harness.conversation(doc.conversationId as ConversationId, context);
    if (!conv) return;
    const probe = await conv.watch(context, { min: 1, max: 1 });
    const busy = this.#host.display(probe.value, doc.conversationId).live.busy;
    await probe.stop();
    await this.#configureConversation(conv, doc.turnContext ?? undefined, busy, context);
  }

  async #configureConversation(
    conv: Conversation,
    settingsCtx: SettingsAssistantContext | undefined,
    preserveBusyModel: boolean,
    context: Context,
  ): Promise<void> {
    const nextAgent = this.#agent(settingsCtx);
    const availableByName = new Map((nextAgent.tools ?? []).map((t) => [t.name, t]));
    const modulePool = new Set([
      "kulo_settings_update",
      "kulo_settings_remove_connection",
      "kulo_identity_read",
      "kulo_identity_propose",
      "kulo_relationship_update",
      "kulo_settings_appearance",
      "kulo_connections",
      "kulo_connection_describe",
      "kulo_connection_prepare",
      "kulo_assistant_read",
      "kulo_assistant_configure",
      "kulo_spark_mail",
      "kulo_home_assistant",
      "kulo_lark_bridge",
      "kulo_status",
      "kulo_stop",
      "web_fetch",
    ]);
    const agentSnap = await this.#host.harness.snapshot(AgentDoc, conv.id, context);
    const priorAdd = agentSnap?.modelTools && !Array.isArray(agentSnap.modelTools) ? agentSnap.modelTools.add ?? [] : [];
    const desiredNames = [
      ...priorAdd.filter((name) => !modulePool.has(name)),
      ...(this.#host.preloadedToolNames?.(settingsCtx) ?? []),
    ];
    const add = [...new Set(desiredNames)]
      .map((name) => availableByName.get(name))
      .filter((t): t is ToolRegistration => Boolean(t));
    const modelTools = add.length ? { add } : null;
    if (preserveBusyModel) {
      const current = await conv.agent(context);
      await conv.configure({ ...nextAgent, modelTools, model: current.model, thinkingLevel: current.thinkingLevel }, context);
      return;
    }
    await conv.configure({ ...nextAgent, modelTools }, context);
  }

  async #turn(): Promise<SettingsAssistantContext> {
    const doc = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    if (!doc?.turnContext) throw new Error("没有正在进行的设置请求。");
    return clone(doc.turnContext);
  }

  #agent(context?: SettingsAssistantContext) {
    const includeDevices = context?.module === "machines" || Boolean(this.#host.joinStaging?.hasActive);
    const extensions = Array.from(new Set([
      ...(this.#host.securityExtensions ?? []),
      ...(this.#host.orchestratorExtensions ?? []),
      ...(this.#host.globalExtension ? [this.#host.globalExtension] : []),
      this.#host.extension,
      ...(this.#host.customizationExtensions ?? []),
      ...(context?.module === "capabilities" ? this.#host.capabilityExtensions ?? [] : []),
      ...(context?.module === "identity" ? this.#host.memoryExtensions ?? [] : []),
      ...(context?.module === "appearance" ? this.#host.appearanceExtensions ?? [] : []),
      ...(context?.module === "models" ? this.#host.modelExtensions ?? [] : []),
      ...(context?.module === "workers" && context.active === true ? this.#host.agentConfigurationExtensions ?? [] : []),
      ...(includeDevices ? this.#host.deviceExtensions ?? [] : []),
      ...(this.#host.settingsTierExtension ? [this.#host.settingsTierExtension] : []),
    ]));
    const tools = this.#host.tools ? this.#host.tools(context, extensions) : undefined;
    return {
      ...this.#host.agent(),
      extensions,
      ...(tools ? { tools: [...tools] } : {}),
      ...(this.#host.cwd ? { cwd: this.#host.cwd } : {}),
      maxTurns: 25,
    };
  }

  async readDevices(): Promise<import("@kulo/protocol").DeviceInterconnectionView | { unavailable: true }> {
    const context = await this.#turn();
    const controller = this.#host.deviceController?.();
    if (!controller) return { unavailable: true };
    return controller.view(context.clientId);
  }

  resolveStagedJoin(joinRef: string): { hubUrl: string } {
    if (!this.#host.joinStaging) throw new Error("当前环境不支持设备接入配对。");
    const resolved = this.#host.joinStaging.resolve(joinRef);
    return { hubUrl: resolved.hubUrl };
  }

  async hasRunningLocalTasks(): Promise<boolean> {
    return (await this.#host.hasRunningLocalTasks?.()) ?? false;
  }

  async openDeviceDialog(intent: "add-device" | "join-device", commandId: string): Promise<SettingsAssistantAction> {
    return this.clientAction("navigate", { module: "machines", intent }, commandId);
  }

  async proposeDeviceOperation(input: {
    commandId: string;
    title: string;
    description?: string;
    changes: string[];
    operation: DeviceAssistantOperation;
    clientOperation?: SettingsAssistantAction["clientOperation"];
    autoNavigateMachines?: boolean;
  }): Promise<SettingsAssistantAction> {
    const existing = await this.#existingAction(input.commandId);
    if (existing) return existing;
    const context = await this.#turn();
    const current = this.#contexts.get(context.clientId);
    if (!current) throw new Error("设置窗口已断开。");
    if (current.hasUnsavedChanges) throw new Error("请先保存或放弃页面中的未保存修改。");
    if (input.operation.kind === "device-join") {
      const controller = this.#host.deviceController?.();
      if (!controller?.canSwitchRole() || !controller.joinPeer || !controller.view(context.clientId).canSwitchRole) {
        throw new Error("当前运行模式不支持直接切换接入其他主机。");
      }
    }
    if (input.autoNavigateMachines && current.module !== "machines") {
      await this.clientAction("navigate", { module: "machines" }, `device-page:${input.commandId}`);
    }
    return this.#serialize(async () => {
      const view = await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        const prior = state.actions.find((item) => item.view.id === input.commandId);
        if (prior) return clone(prior.view);
        const action: SettingsAssistantAction = {
          id: input.commandId,
          kind: "settings",
          title: input.title.slice(0, 100),
          ...(input.description ? { description: input.description.slice(0, 300) } : {}),
          changes: input.changes.map((entry) => entry.slice(0, 300)),
          status: "pending",
          requiresConfirmation: true,
          canUndo: false,
          clientId: context.clientId,
          ...(input.clientOperation ? { clientOperation: input.clientOperation } : {}),
        };
        state.actions.push({ view: action, deviceOperation: clone(input.operation) });
        return clone(action);
      }, BACKGROUND_CONTEXT);
      await this.#emit();
      return view;
    });
  }

  async applyImmediateDeviceChange(
    commandId: string,
    run: (controller: HubDeviceController) => Promise<{
      title: string;
      changes: string[];
      result: unknown;
      pendingOperation?: { description?: string; operation: DeviceAssistantOperation };
    }>,
  ): Promise<{ action: SettingsAssistantAction; result?: unknown }> {
    const context = await this.#turn();
    const current = this.#contexts.get(context.clientId);
    if (!current) throw new Error("设置窗口已断开。");
    if (current.hasUnsavedChanges) throw new Error("请先保存或放弃页面中的未保存修改。");
    const controller = this.#host.deviceController?.();
    if (!controller) throw new Error("当前环境不支持设备互联管理。");
    if (current.module !== "machines") {
      await this.clientAction("navigate", { module: "machines" }, `device-page:${commandId}`);
    }
    return this.#serialize(async () => {
      const snapshot = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      const prior = snapshot?.actions.find((item) => item.view.id === commandId);
      if (prior) return { action: clone(prior.view), ...(prior.workspaceResult !== undefined ? { result: clone(prior.workspaceResult) } : {}) };
      const outcome = await run(controller);
      const pending = outcome.pendingOperation;
      const committed = await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        const existing = state.actions.find((item) => item.view.id === commandId);
        if (existing) return { action: clone(existing.view), ...(existing.workspaceResult !== undefined ? { result: clone(existing.workspaceResult) } : {}) };
        const action: SettingsAssistantAction = {
          id: commandId,
          kind: "settings",
          title: outcome.title.slice(0, 100),
          ...(pending?.description ? { description: pending.description.slice(0, 300) } : {}),
          changes: outcome.changes.map((entry) => entry.slice(0, 300)),
          status: pending ? "pending" : "applied",
          requiresConfirmation: Boolean(pending),
          canUndo: false,
          clientId: context.clientId,
        };
        state.actions.push({
          view: action,
          ...(outcome.result !== undefined ? { workspaceResult: clone(outcome.result) } : {}),
          ...(pending ? { deviceOperation: clone(pending.operation) } : {}),
        });
        return { action: clone(action), ...(outcome.result !== undefined ? { result: clone(outcome.result) } : {}) };
      }, BACKGROUND_CONTEXT);
      await this.#emit();
      return committed;
    });
  }

  async configurationContext(module: "appearance" | "models" | "workers", expectedConversationId?: number): Promise<SettingsAssistantContext> {
    const turn = await this.#turn();
    const current = this.#contexts.get(turn.clientId);
    if (turn.module !== module || !current || current.module !== module) throw new Error("请回到发起配置的设置页面继续。");
    if (module === "workers") {
      const state = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (turn.active !== true || current.active !== true || !Number.isSafeInteger(turn.pageGeneration) || turn.pageGeneration! < 1 || turn.pageGeneration !== current.pageGeneration || turn.target?.kind !== current.target?.kind || turn.target?.id !== current.target?.id || expectedConversationId !== undefined && state?.conversationId !== expectedConversationId) throw new Error("智能体设置页面或对话已切换，请重新发起配置。");
    }
    if (current.hasUnsavedChanges) throw new Error("请先保存或放弃页面中的未保存修改。");
    return clone(current);
  }

  async readAppearanceCustomization(): Promise<AppearanceCustomization | null> {
    return (await this.configurationContext("appearance")).appearanceCustomization ?? null;
  }

  async proposeAppearanceCustomization(input: AppearanceCustomization, commandId: string): Promise<SettingsAssistantAction> {
    const existing = await this.#existingAction(commandId);
    if (existing) return existing;
    const customization = validateAppearanceCustomization(input);
    const context = await this.configurationContext("appearance");
    return this.#serialize(async () => {
      const view = await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        const repeated = state.actions.find((item) => item.view.id === commandId);
        if (repeated) return clone(repeated.view);
        const action: SettingsAssistantAction = { id: commandId, kind: "appearance-customization", title: customization.name,
          changes: ["个人配色与字体"], status: "pending", requiresConfirmation: true, canUndo: false,
          clientId: context.clientId, customization, previousCustomization: context.appearanceCustomization ?? null };
        state.actions.push({ view: action });
        return clone(action);
      }, BACKGROUND_CONTEXT);
      await this.#emit();
      return view;
    });
  }

  async memoryContext(): Promise<SettingsAssistantContext> {
    const turn = await this.#turn();
    const current = this.#contexts.get(turn.clientId);
    if (turn.module !== "identity" || !current || current.module !== "identity") throw new Error("请在个性与记忆页面继续配置。");
    if (current.hasUnsavedChanges) throw new Error("请先保存或放弃页面中的未保存修改。");
    return turn;
  }

  async capabilityContext(): Promise<SettingsAssistantContext> {
    const turn = await this.#turn();
    const current = this.#contexts.get(turn.clientId);
    if (turn.module !== "capabilities" || !current || current.module !== "capabilities") throw new Error("请在能力与技能页面继续配置。");
    return turn;
  }

  async prepareConnection(input: Omit<ConnectionPrepareRequest, "clientId">, commandId: string) {
    const context = await this.#turn();
    if (!this.#host.connections) throw new Error("连接授权不可用。");
    const current = this.#contexts.get(context.clientId);
    if (!current) throw new Error("设置窗口已断开。");
    if (current.hasUnsavedChanges) throw new Error("请先保存或放弃页面中的未保存修改。");
    if (current.module !== "connections") await this.clientAction("navigate", { module: "connections" }, `connection-page:${commandId}`);
    return this.#host.connections.prepare({ ...input, clientId: context.clientId });
  }

  async describeConnection(input: ConnectionDescribeRequest) {
    const context = await this.#turn();
    if (!this.#host.connections) throw new Error("连接授权不可用。");
    const current = this.#contexts.get(context.clientId);
    if (!current) throw new Error("设置窗口已断开。");
    if (current.hasUnsavedChanges) throw new Error("请先保存或放弃页面中的未保存修改。");
    return this.#host.connections.describe(input);
  }

  async workspaceAction(commandId: string, title: string, changes: string[], run: () => Promise<unknown>, operation?: WorkspaceOperation, undo?: WorkspaceUndoSupport): Promise<{ action: SettingsAssistantAction; result?: unknown }> {
    const context = await this.capabilityContext();
    return this.#serialize(async () => {
      const before = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      const prior = before?.actions.find((item) => item.view.id === commandId);
      if (prior && prior.view.clientId !== context.clientId) throw new Error("此操作属于另一台浏览器。");
      if (prior && !prior.workspaceRunPending) return { action: clone(prior.view), ...(prior.workspaceResult === undefined ? {} : { result: clone(prior.workspaceResult) }) };
      let action: SettingsAssistantAction = prior ? clone(prior.view) : { id: commandId, kind: "settings", title: title.slice(0, 100), changes: changes.map((v) => v.slice(0, 300)),
        status: "pending", requiresConfirmation: !!operation, canUndo: false, clientId: context.clientId };
      const undoBefore = prior?.workspaceUndoBefore ?? undo?.before;
      if (!prior) {
        // Reserve the client and original values before the idempotent resource operation can commit.
        await this.#host.harness.commit(async (tx) => {
          const state = await tx.doc(SettingsAssistantDoc);
          const existing = state.actions.find((item) => item.view.id === commandId);
          if (existing && existing.view.clientId !== context.clientId) throw new Error("此操作属于另一台浏览器。");
          if (!existing) state.actions.push({ view: action, ...(operation ? { workspaceOperation: clone(operation) } : { workspaceRunPending: true }), ...(undoBefore ? { workspaceUndoBefore: clone(undoBefore) } : {}) });
        }, BACKGROUND_CONTEXT);
        await this.#emit();
      }
      if (operation) return { action };
      let value: unknown;
      let inverse: WorkspaceUndoOperation | undefined;
      try {
        value = await run();
        inverse = undo && undoBefore ? await undo.complete(clone(undoBefore), value) : undefined;
        if (inverse) inverse.commandId = `undo:${commandId}`;
      } catch (error) {
        await this.#host.harness.commit(async (tx) => {
          const item = (await tx.doc(SettingsAssistantDoc)).actions.find((entry) => entry.view.id === commandId);
          if (item?.workspaceRunPending) { item.view.status = "failed"; item.view.canUndo = false; item.view.error = "操作未完成，可重试原请求。"; }
        }, BACKGROUND_CONTEXT);
        await this.#emit();
        throw error;
      }
      action = { ...action, status: "applied", canUndo: Boolean(inverse) };
      delete action.error;
      const committed = await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        const existing = state.actions.find((item) => item.view.id === commandId);
        if (existing && existing.view.clientId !== context.clientId) throw new Error("此操作属于另一台浏览器。");
        if (existing && !existing.workspaceRunPending) return { action: clone(existing.view), ...(existing.workspaceResult === undefined ? {} : { result: clone(existing.workspaceResult) }) };
        const item: StoredAction = { view: action,
          ...(value === undefined ? {} : { workspaceResult: clone(value) }), workspaceRunPending: false,
          ...(inverse ? { workspaceUndoOperation: clone(inverse) } : {}), ...(undoBefore ? { workspaceUndoBefore: clone(undoBefore) } : {}) };
        if (existing) Object.assign(existing, item); else state.actions.push(item);
        return { action: clone(action), ...(value === undefined ? {} : { result: clone(value) }) };
      }, BACKGROUND_CONTEXT);
      await this.#emit();
      return committed;
    });
  }

  async #existingAction(commandId: string): Promise<SettingsAssistantAction | undefined> {
    const doc = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const existing = doc?.actions.find((action) => action.view.id === commandId);
    return existing ? clone(existing.view) : undefined;
  }

  #assertWritable(block: SettingsBlockName, clientId: string): void {
    const current = this.#contexts.get(clientId);
    if (!current) throw new Error("请重新打开设置页面后重试。");
    if (current.hasUnsavedChanges && current.module === BLOCK_MODULE[block]) {
      throw new Error("当前页面有尚未保存的修改，请先保存或放弃修改。");
    }
  }

  async #isMainChatCaller(callerConversationId?: number): Promise<boolean> {
    if (callerConversationId === undefined) return false;
    const settingsDoc = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    if (isActiveSettingsConversation(callerConversationId, settingsDoc)) return false;
    const state = await this.#host.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    if (!isOrchestratorConversation(callerConversationId as ConversationId, state)) {
      throw new Error("只有主模型或设置会话可以访问全局设置。");
    }
    const topicId = state?.conversationToTopic?.[String(callerConversationId)] ?? "root";
    if (state?.topics?.[topicId]?.deletedAt) throw new Error("会话已删除。");
    return true;
  }

  async read(sectionName = "current", callerConversationId?: number): Promise<unknown> {
    const fromMainChat = await this.#isMainChatCaller(callerConversationId);
    const context = fromMainChat ? undefined : await this.#turn();
    const selected = sectionName === "current" ? (context ? context.module : "current") : sectionName;
    const settings = this.#host.settings();
    const observedBlocks: SettingsBlockName[] =
      selected === "current"
        ? ["model", "executor", "roles", "memory", "identity", "presentation"]
        : selected === "models"
          ? ["model"]
          : selected === "workers"
            ? ["executor", "roles"]
            : selected === "identity"
              ? ["memory", "identity", "presentation"]
              : [];
    if (observedBlocks.length > 0) {
      await this.#host.harness.commit(async (tx) => {
        const doc = await tx.doc(SettingsAssistantDoc);
        if (fromMainChat) {
          const convKey = String(callerConversationId);
          doc.mainObservedRevisions = {
            ...doc.mainObservedRevisions,
            [convKey]: {
              ...doc.mainObservedRevisions?.[convKey],
              ...Object.fromEntries(observedBlocks.map((block) => [block, settings.blocks[block].revision])),
            },
          };
        } else {
          for (const block of observedBlocks) doc.observedRevisions[block] = settings.blocks[block].revision;
        }
      }, BACKGROUND_CONTEXT);
    }
    const clientId = context?.clientId;
    switch (selected) {
      case "current": {
        const controller = this.#host.deviceController?.();
        return {
          models: { settings: settings.blocks.model, providers: await this.#host.providers() },
          workers: { executor: settings.blocks.executor, roles: settings.blocks.roles },
          identity: { presentation: settings.blocks.presentation, memory: settings.blocks.memory, identity: settings.blocks.identity },
          machines: controller ? { ...controller.view(), machines: this.#host.envs() } : { machines: this.#host.envs() },
        };
      }
      case "models": return { settings: settings.blocks.model, providers: await this.#host.providers() };
      case "workers": return { executor: settings.blocks.executor, roles: settings.blocks.roles };
      case "identity": return { presentation: settings.blocks.presentation, memory: settings.blocks.memory, identity: settings.blocks.identity, note: "身份文件修改必须在身份编辑器确认；本机 Hindsight 的状态查看、部署、模型配置、卸载，以及带健康检查的长期记忆启用/停用开关均可通过 kulo_memory_service_read 与 kulo_memory_service_prepare 直接办理（外部 Hindsight 连接地址与密钥录入仍通过设置页保密表单完成）。" };
      case "machines": {
        const controller = this.#host.deviceController?.();
        return controller ? { ...controller.view(clientId), machines: this.#host.envs() } : { machines: this.#host.envs() };
      }
      case "permissions": return { note: "OS permissions are checked and granted via the left-hand System Permissions controls (microphone applies to the current client; accessibility/screen recording apply to the selected execution device). Never infer granted permissions from device connectivity; OS prompts must be confirmed directly by the user, and the Settings assistant cannot request or confirm them on the user's behalf." };
      case "appearance": {
        if (!context) {
          const single = this.#contexts.size === 1 ? [...this.#contexts.values()][0] : undefined;
          return {
            appearance: single?.appearance ?? "system",
            customization: single?.appearanceCustomization ?? null,
            defaults: DEFAULT_APPEARANCE_CUSTOMIZATION,
          };
        }
        return {
          appearance: this.#contexts.get(context.clientId)?.appearance ?? context.appearance,
          customization: this.#contexts.get(context.clientId)?.appearanceCustomization ?? context.appearanceCustomization ?? null,
          defaults: DEFAULT_APPEARANCE_CUSTOMIZATION,
        };
      }
      case "capabilities": return clientId ? (this.#host.workspaceRead?.(clientId) ?? { unavailable: true }) : (this.#host.workspaceRead?.("main-chat") ?? { unavailable: true });
      case "extensions": {
        if (!fromMainChat) await this.capabilityContext();
        return this.#host.extensionsRead?.(clientId) ?? { unavailable: true };
      }
      case "connections": return this.#host.connections?.snapshot(clientId) ?? { unavailable: true };
      case "schedules": return this.#host.scheduledTasks
        ? { tasks: await this.#host.scheduledTasks(), note: "Scheduled tasks are created from main chat conversations and can be inspected, stopped, or removed on the Scheduled Tasks page." }
        : { unavailable: true };
      case "archives": {
        const state = await this.#host.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        return { conversations: Object.values(state?.topics ?? {}).filter((topic) => topic.archived && !topic.deletedAt && !topic.master && topic.id !== "root") };
      }
      default: throw new Error("未知的设置页面。");
    }
  }

  async promptContext(): Promise<string> {
    const context = await this.#turn();
    return JSON.stringify({ module: context.module, ...(context.target ? { target: context.target } : {}), appearance: this.#contexts.get(context.clientId)?.appearance ?? context.appearance });
  }

  async promptTurn(): Promise<{ promptContext: string; module: SettingsAssistantModule }> {
    const context = await this.#turn();
    return {
      promptContext: JSON.stringify({ module: context.module, ...(context.target ? { target: context.target } : {}), appearance: this.#contexts.get(context.clientId)?.appearance ?? context.appearance }),
      module: context.module,
    };
  }

  async update(block: SettingsBlockName, rawChanges: string, title: string, commandId: string, callerConversationId?: number): Promise<SettingsAssistantAction> {
    const fromMainChat = await this.#isMainChatCaller(callerConversationId);
    if (fromMainChat) {
      const priorDoc = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (priorDoc?.mainActions?.[commandId]) return clone(priorDoc.mainActions[commandId]!);
    } else {
      const existing = await this.#existingAction(commandId);
      if (existing) return existing;
    }
    if (rawChanges.length > 8000) throw new Error("设置变更过长。");
    const changes = JSON.parse(rawChanges) as Record<string, unknown>;
    if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length) throw new Error("无效的设置变更。");
    for (const [key, value] of Object.entries(changes)) {
      const allowed = block === "roles"
        ? /^[a-zA-Z0-9_-]+\.(?:label|whenToUse|prompt|enabled|readOnly|allowSubagents|provider|modelId|thinkingLevel)$/.test(key)
        : FIELDS[block]?.includes(key);
      if (!allowed || key.split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part))) throw new Error("该设置请通过页面中的专用操作修改。");
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("设置值必须为文本、数字或开关。");
      const name = key.split(".").at(-1)!;
      if (value === null) {
        if (block === "executor" && name === "completedTaskDisplayHours") continue;
        throw new Error("设置值不能为空。");
      }
      const expectedType = ["enabled", "readOnly", "allowSubagents", "paused", "autoArchiveEnabled"].includes(name) ? "boolean"
        : ["maxConcurrentWorkers", "maxSubagentsPerTicket", "watchdogMinutes", "completedTaskDisplayHours", "autoArchiveDays"].includes(name) ? "number" : "string";
      if (typeof value !== expectedType || (typeof value === "number" && !Number.isFinite(value))) throw new Error(`设置字段 ${FIELD_LABELS[name] ?? name} 的类型无效。`);
    }
    if (block === "roles" && Object.keys(changes).some((key) => this.#host.settings().blocks.roles.value[key.split(".")[0]!]?.external)) throw new Error("外部智能体请使用当前智能体页面的专用接入工具修改。");
    const context = fromMainChat ? undefined : await this.#turn();
    if (context) {
      this.#assertWritable(block, context.clientId);
    } else {
      for (const openCtx of this.#contexts.values()) {
        if (openCtx.hasUnsavedChanges && openCtx.module === BLOCK_MODULE[block]) {
          throw new Error("当前设置页面有尚未保存的修改，请先保存或放弃修改。");
        }
      }
    }
    return this.#serialize(async () => {
      const modelSettings = this.#host.settings().blocks.model;
      if (block === "model" || block === "roles") {
        const providers = await this.#host.providers();
        const validateModel = (providerId: string | undefined, modelId: string, thinking?: string) => {
          if (!modelId) {
            if (thinking && thinking !== "auto") throw new Error("请先选择模型再调整思考强度。");
            if (providerId && !providers.some((entry) => entry.id === providerId)) throw new Error("供应商不存在。");
            return;
          }
          const effectiveProviderId = providerId || (!defaults.gatewayDisabled ? "kulo-gateway" : "");
          const provider = effectiveProviderId ? providers.find((entry) => entry.id === effectiveProviderId) : undefined;
          const model = provider?.models.find((entry) => entry.id === modelId);
          if (!provider || !model) throw new Error("请选择已有连接中的有效模型；新模型请先通过模型配置卡片添加并保存。");
          if (!provider.authenticated) throw new Error("请先在模型连接中完成认证。");
          if (thinking && thinking !== "auto" && !model.supportedThinkingLevels.includes(thinking)) throw new Error("所选模型不支持这个思考强度。");
        };
        const defaults = modelSettings.value;
        if (block === "model") {
          validateModel((changes.defaultProvider ?? defaults.defaultProvider) as string | undefined, (changes.defaultModel ?? defaults.defaultModel) as string, changes.thinkingLevel as string | undefined);
        } else {
          const roles = this.#host.settings().blocks.roles.value;
          for (const roleId of new Set(Object.keys(changes).filter((key) => /\.(?:provider|modelId|thinkingLevel)$/.test(key)).map((key) => key.split(".")[0]!))) {
            const role = roles[roleId];
            if (!role) throw new Error("角色不存在。");
            const provider = (changes[`${roleId}.provider`] ?? role.provider) as string | undefined;
            const model = (changes[`${roleId}.modelId`] ?? role.modelId) as string | undefined;
            validateModel(provider || defaults.defaultProvider, model || defaults.defaultModel, changes[`${roleId}.thinkingLevel`] as string | undefined);
          }
        }
      }
      let applied: KuloDurableSettings | undefined;
      const view = await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        if (fromMainChat) {
          if (state.mainActions?.[commandId]) return clone(state.mainActions[commandId]!);
        } else {
          const existing = state.actions.find((a) => a.view.id === commandId);
          if (existing) return clone(existing.view);
          this.#assertWritable(block, context!.clientId);
        }
        const doc = await tx.doc(KuloSettingsDoc);
        if (block === "roles" && doc.revisions.model !== modelSettings.revision) throw new Error("模型配置已发生变化，请重新读取设置后重试。");
        const before = Object.fromEntries(Object.keys(changes).map((key) => [key, field(doc[block], key) ?? null]));
        const next = clone(doc[block]) as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(changes)) assignField(next, key, value);
        const expectedRevision = fromMainChat
          ? state.mainObservedRevisions?.[String(callerConversationId)]?.[block]
          : state.observedRevisions[block];
        if (expectedRevision === undefined) throw new Error("请先读取相关设置再修改。");
        applySettingsBlockUpdate(doc, block, expectedRevision, next);
        if (fromMainChat) {
          const convKey = String(callerConversationId);
          state.mainObservedRevisions = {
            ...state.mainObservedRevisions,
            [convKey]: {
              ...state.mainObservedRevisions?.[convKey],
              [block]: doc.revisions[block],
            },
          };
        } else {
          state.observedRevisions[block] = doc.revisions[block];
        }
        const after = Object.fromEntries(Object.keys(changes).map((key) => [key, field(doc[block], key) ?? null]));
        const actionView: SettingsAssistantAction = {
          id: commandId,
          kind: "settings",
          title: title.slice(0, 100),
          changes: Object.keys(changes).map((key) => `${block === "roles" ? `${doc.roles[key.split(".")[0]!]?.label ?? "角色"} · ` : ""}${FIELD_LABELS[key.split(".").at(-1)!] ?? key}：${displayValue(before[key], key.split(".").at(-1))} → ${displayValue(after[key], key.split(".").at(-1))}`),
          status: "applied",
          requiresConfirmation: false,
          canUndo: !fromMainChat,
        };
        if (fromMainChat) {
          state.mainActions = { ...state.mainActions, [commandId]: actionView };
        } else {
          state.actions.push({ view: actionView, block, before, after, revision: doc.revisions[block] });
        }
        applied = clone(doc) as KuloDurableSettings;
        return clone(actionView);
      }, BACKGROUND_CONTEXT);
      if (applied) await this.#host.applied(applied);
      if (!fromMainChat) await this.#emit();
      return view;
    });
  }

  async removeConnection(providerId: string, commandId: string): Promise<SettingsAssistantAction> {
    const existing = await this.#existingAction(commandId);
    if (existing) return existing;
    const context = await this.#turn();
    this.#assertWritable("model", context.clientId);
    return this.#serialize(async () => {
      const view = await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        const existing = state.actions.find((a) => a.view.id === commandId);
        if (existing) return clone(existing.view);
        this.#assertWritable("model", context.clientId);
        const doc = await tx.doc(KuloSettingsDoc);
        const provider = doc.model.customProviders?.find((entry) => entry.id === providerId);
        if (!provider) throw new Error("只能移除已添加的自定义连接；订阅与凭证请在原设置页管理。");
        const before: Record<string, unknown> = { customProviders: clone(doc.model.customProviders) };
        const after: Record<string, unknown> = { customProviders: doc.model.customProviders!.filter((entry) => entry.id !== providerId) };
        if (doc.model.defaultProvider === providerId) {
          before.defaultProvider = doc.model.defaultProvider;
          before.defaultModel = doc.model.defaultModel;
          after.defaultProvider = "";
          after.defaultModel = "";
        }
        const action: StoredAction = {
          view: { id: commandId, kind: "settings", title: `移除 ${provider.name}`, changes: [`移除连接 ${provider.name} 及其保存的认证`, ...(doc.model.defaultProvider === providerId ? ["同时清除默认模型选择"] : [])], status: "pending", requiresConfirmation: true, canUndo: false },
          block: "model", before, after, revision: doc.revisions.model,
          removedProviderId: providerId,
        };
        state.actions.push(action);
        return clone(action.view);
      }, BACKGROUND_CONTEXT);
      await this.#emit();
      return view;
    });
  }

  async lookupModelMetadata(input: {
    providerId?: string;
    preset?: string;
    api?: CustomProviderApi;
    modelIds?: string[];
    forceRefresh?: boolean;
  }): Promise<unknown> {
    await this.#turn();
    if (!this.#host.resolveModelMetadata) {
      throw new Error("模型元数据目录当前不可用。");
    }
    const refresh = await this.#host.refreshModelMetadata?.(input.forceRefresh === true).catch((err) => ({
      updated: false,
      fromCache: true,
      source: "bundled",
      error: err instanceof Error ? err.message : String(err),
    }));
    const settingsView = this.#host.settings().blocks.model;
    await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(SettingsAssistantDoc);
      doc.observedRevisions.model = settingsView.revision;
    }, BACKGROUND_CONTEXT);

    const modelBlock = settingsView.value;
    const providersCatalog = await this.#host.providers();
    const resolveForConnection = async (params: {
      providerId: string;
      name: string;
      api: CustomProviderApi;
      preset?: string;
      baseUrl?: string;
      configuredModels: CustomModelConfig[];
      requestedIds?: string[];
    }) => {
      const targetIds = params.requestedIds?.length
        ? params.requestedIds
        : params.configuredModels.map((item) => item.id);
      const configuredById = new Map(params.configuredModels.map((item) => [item.id, item]));
      const entries = await Promise.all(
        targetIds.slice(0, 64).map(async (modelId) => {
          const resolved = await this.#host.resolveModelMetadata!({
            modelId,
            api: params.api,
            providerId: params.providerId,
            ...(params.preset ? { preset: params.preset } : {}),
            ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
          });
          const current = configuredById.get(modelId);
          return {
            id: modelId,
            ...(current ? { current } : {}),
            recommended: resolved.model,
            ...(resolved.allowedThinkingWireValues ? { allowedThinkingWireValues: resolved.allowedThinkingWireValues } : {}),
            nativeSearchAllowed: resolved.nativeSearchAllowed,
          };
        }),
      );
      return {
        providerId: params.providerId,
        name: this.#redact(params.name),
        api: params.api,
        ...(params.preset ? { preset: params.preset } : {}),
        models: entries,
      };
    };

    if (input.providerId) {
      const pid = input.providerId.trim();
      if (pid === "kulo-gateway") {
        const result = await resolveForConnection({
          providerId: pid,
          name: modelBlock.gatewayName?.trim() || "默认兼容网关",
          api: modelBlock.apiMode,
          baseUrl: modelBlock.baseUrl,
          configuredModels: modelBlock.gatewayModels ?? [],
          requestedIds: input.modelIds,
        });
        return { ...(refresh ? { registry: refresh } : {}), connections: [result] };
      }
      const custom = modelBlock.customProviders?.find((item) => item.id === pid);
      if (custom) {
        const result = await resolveForConnection({
          providerId: custom.id,
          name: custom.name,
          api: custom.api,
          preset: custom.preset,
          baseUrl: custom.baseUrl,
          configuredModels: custom.models,
          requestedIds: input.modelIds,
        });
        return { ...(refresh ? { registry: refresh } : {}), connections: [result] };
      }
      const subModels = modelBlock.subscriptionModels?.[pid];
      const subProvider = providersCatalog.find((item) => item.id === pid);
      if (subModels || subProvider) {
        const api = (subProvider?.models[0]?.api ?? input.api ?? "openai-responses") as CustomProviderApi;
        const result = await resolveForConnection({
          providerId: pid,
          name: subProvider?.name ?? pid,
          api,
          preset: pid,
          baseUrl: subProvider?.baseUrl,
          configuredModels: subModels ?? [],
          requestedIds: input.modelIds,
        });
        return { ...(refresh ? { registry: refresh } : {}), connections: [result] };
      }
      throw new Error(`未找到模型连接「${pid}」。`);
    }

    if (input.modelIds?.length) {
      const api = input.api ?? "openai-responses";
      const entries = await Promise.all(
        input.modelIds.slice(0, 64).map(async (modelId) => {
          const resolved = await this.#host.resolveModelMetadata!({
            modelId,
            api,
            ...(input.preset ? { preset: input.preset } : {}),
          });
          return {
            id: modelId,
            recommended: resolved.model,
            ...(resolved.allowedThinkingWireValues ? { allowedThinkingWireValues: resolved.allowedThinkingWireValues } : {}),
            nativeSearchAllowed: resolved.nativeSearchAllowed,
          };
        }),
      );
      return { ...(refresh ? { registry: refresh } : {}), api, ...(input.preset ? { preset: input.preset } : {}), models: entries };
    }

    // No providerId & no modelIds: inspect ALL configured connections in a single round-trip.
    const connections = [];
    for (const custom of modelBlock.customProviders ?? []) {
      connections.push(await resolveForConnection({
        providerId: custom.id,
        name: custom.name,
        api: custom.api,
        preset: custom.preset,
        baseUrl: custom.baseUrl,
        configuredModels: custom.models,
      }));
    }
    if (!modelBlock.gatewayDisabled && (modelBlock.gatewayModels?.length ?? 0) > 0) {
      connections.push(await resolveForConnection({
        providerId: "kulo-gateway",
        name: modelBlock.gatewayName?.trim() || "默认兼容网关",
        api: modelBlock.apiMode,
        baseUrl: modelBlock.baseUrl,
        configuredModels: modelBlock.gatewayModels ?? [],
      }));
    }
    for (const [pid, models] of Object.entries(modelBlock.subscriptionModels ?? {})) {
      if (!models.length) continue;
      const subProvider = providersCatalog.find((item) => item.id === pid);
      const api = (subProvider?.models[0]?.api ?? "openai-responses") as CustomProviderApi;
      connections.push(await resolveForConnection({
        providerId: pid,
        name: subProvider?.name ?? pid,
        api,
        preset: pid,
        baseUrl: subProvider?.baseUrl,
        configuredModels: models,
      }));
    }
    return { ...(refresh ? { registry: refresh } : {}), connections };
  }

  async calibrateModels(
    rawUpdates: string,
    title: string | undefined,
    commandId: string,
  ): Promise<SettingsAssistantAction> {
    const existing = await this.#existingAction(commandId);
    if (existing) return existing;
    const context = await this.#turn();
    this.#assertWritable("model", context.clientId);
    if (typeof rawUpdates !== "string" || rawUpdates.length > 64_000) {
      throw new Error("模型校准参数无效或过长。");
    }
    if (this.#redact(rawUpdates) !== rawUpdates) {
      throw new Error("模型校准参数包含受保护内容，已拒绝写入；密钥请通过专用保密输入提供。");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(rawUpdates); }
    catch { throw new Error("模型校准参数必须为有效的 JSON 数组。"); }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
      throw new Error("请提供至少 1 个（最多 32 个）需要校准的连接。");
    }

    const ALLOWED_PATCH_FIELDS = new Set([
      "name", "purpose", "protocolAdapter", "voices", "imageProfile", "imageDefaults",
      "customImageAdapter", "outputModalities", "contextWindow", "maxTokens", "reasoning",
      "thinkingEnabled", "vision", "modalities", "thinkingLevelMap", "thinkingLevels", "nativeTools",
    ]);

    const updates: ModelCalibrationProviderUpdate[] = [];
    const seenProviders = new Set<string>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("每个连接的校准项必须为对象。");
      }
      const rec = entry as Record<string, unknown>;
      const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
      if (!providerId || seenProviders.has(providerId)) {
        throw new Error("连接标识无效或存在重复连接。");
      }
      seenProviders.add(providerId);
      if (!Array.isArray(rec.models) || rec.models.length === 0 || rec.models.length > 128) {
        throw new Error(`连接「${providerId}」缺少有效的模型更新列表。`);
      }
      const seenModels = new Set<string>();
      const models: ModelCalibrationProviderUpdate["models"] = [];
      for (const m of rec.models) {
        if (!m || typeof m !== "object" || Array.isArray(m)) {
          throw new Error("每个模型的校准项必须为对象。");
        }
        const mRec = m as Record<string, unknown>;
        const id = typeof mRec.id === "string" ? mRec.id.trim() : "";
        if (!id || seenModels.has(id)) {
          throw new Error(`连接「${providerId}」中存在无效或重复的模型 ID。`);
        }
        seenModels.add(id);
        const patch = mRec.patch;
        if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
          throw new Error(`模型「${id}」缺少有效的参数修改项。`);
        }
        const invalidKeys = Object.keys(patch).filter((key) => !ALLOWED_PATCH_FIELDS.has(key));
        if (invalidKeys.length > 0) {
          throw new Error(`模型校准仅允许修改已有模型的公开参数，不允许修改字段：${invalidKeys.join("、")}。连接地址、协议与密钥请使用模型配置卡片。`);
        }
        models.push({ id, patch: clone(patch as ModelCalibrationProviderUpdate["models"][number]["patch"]) });
      }
      updates.push({ providerId, models });
    }

    const formatK = (n: number | undefined) => n === undefined ? "默认" : n >= 1000 ? `${Math.round(n / 1000).toLocaleString("en-US")}K` : String(n);
    const describeThinking = (m: CustomModelConfig) => {
      if (m.reasoning === false || m.thinkingEnabled === false) return "关闭";
      if (m.thinkingLevels?.length) return m.thinkingLevels.map((level) => level.value).join("/");
      if (m.thinkingLevelMap) {
        const active = Object.entries(m.thinkingLevelMap).filter(([, value]) => typeof value === "string").map(([key]) => key);
        if (active.length) return active.join("/");
      }
      return m.reasoning ? "开启" : "默认";
    };
    const describeModelDiff = (providerName: string, beforeModel: CustomModelConfig, afterModel: CustomModelConfig): string | null => {
      const parts: string[] = [];
      if (beforeModel.contextWindow !== afterModel.contextWindow) {
        parts.push(`上下文 ${formatK(beforeModel.contextWindow)} → ${formatK(afterModel.contextWindow)}`);
      }
      if (beforeModel.maxTokens !== afterModel.maxTokens) {
        parts.push(`最大输出 ${formatK(beforeModel.maxTokens)} → ${formatK(afterModel.maxTokens)}`);
      }
      const beforeMods = (beforeModel.modalities ?? (beforeModel.vision ? ["text", "image"] : ["text"])).join("/");
      const afterMods = (afterModel.modalities ?? (afterModel.vision ? ["text", "image"] : ["text"])).join("/");
      if (beforeMods !== afterMods) {
        parts.push(`模态 ${beforeMods} → ${afterMods}`);
      }
      const beforeThink = describeThinking(beforeModel);
      const afterThink = describeThinking(afterModel);
      if (beforeThink !== afterThink) {
        parts.push(`思考档位 ${beforeThink} → ${afterThink}`);
      }
      const beforeSearch = beforeModel.nativeTools?.webSearch === true;
      const afterSearch = afterModel.nativeTools?.webSearch === true;
      if (beforeSearch !== afterSearch) {
        parts.push(`原生搜索 ${beforeSearch ? "开启" : "关闭"} → ${afterSearch ? "开启" : "关闭"}`);
      }
      if (beforeModel.purpose !== afterModel.purpose) {
        parts.push(`类型 ${beforeModel.purpose ?? "chat"} → ${afterModel.purpose ?? "chat"}`);
      }
      if (beforeModel.name !== afterModel.name && afterModel.name) {
        parts.push(`名称 ${beforeModel.name ?? beforeModel.id} → ${afterModel.name}`);
      }
      if (parts.length === 0) {
        if (same(beforeModel, afterModel)) return null;
        parts.push("已更新模型参数");
      }
      return `${providerName} · ${afterModel.id}：${parts.join("；")}`;
    };

    const providersCatalog = await this.#host.providers();

    return this.#serialize(async () => {
      let applied: KuloDurableSettings | undefined;
      const view = await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        const repeated = state.actions.find((a) => a.view.id === commandId);
        if (repeated) return clone(repeated.view);
        this.#assertWritable("model", context.clientId);
        const doc = await tx.doc(KuloSettingsDoc);
        const expectedRevision = state.observedRevisions.model;
        if (expectedRevision === undefined) {
          throw new Error("请先读取模型配置或查询模型目录后再执行校准。");
        }
        if (doc.revisions.model !== expectedRevision) {
          throw new Error("模型设置已被其他操作修改，请重新读取后再校准。");
        }

        const next = clone(doc.model);
        const touchedKeys = new Set<string>();
        const changes: string[] = [];
        const changedProviders = new Set<string>();
        let changedModels = 0;

        for (const update of updates) {
          const { providerId, models } = update;
          let targetList: CustomModelConfig[] | undefined;
          let targetApi: CustomProviderApi;
          let targetBaseUrl = "";
          let targetLabel = providerId;
          let targetKey: "customProviders" | "gatewayModels" | "subscriptionModels";
          let officialSearchAllowed = false;

          if (providerId === "kulo-gateway") {
            targetList = next.gatewayModels ?? [];
            targetApi = next.apiMode;
            targetBaseUrl = next.baseUrl;
            targetLabel = next.gatewayName?.trim() || "默认兼容网关";
            targetKey = "gatewayModels";
            officialSearchAllowed = false;
          } else {
            const custom = next.customProviders?.find((entry) => entry.id === providerId);
            if (custom) {
              targetList = custom.models;
              targetApi = custom.api;
              targetBaseUrl = custom.baseUrl;
              targetLabel = custom.name;
              targetKey = "customProviders";
              officialSearchAllowed =
                Boolean(this.#host.isOfficialNativeSearchAllowed?.(providerId)) &&
                supportsNativeWebSearch(custom.api, { baseUrl: custom.baseUrl, provider: custom.id });
            } else if (next.subscriptionModels && Object.hasOwn(next.subscriptionModels, providerId)) {
              const subProvider = providersCatalog.find((entry) => entry.id === providerId);
              targetList = next.subscriptionModels[providerId]!;
              targetApi = (subProvider?.models[0]?.api ?? "openai-responses") as CustomProviderApi;
              targetBaseUrl = subProvider?.baseUrl ?? "";
              targetLabel = subProvider?.name ?? providerId;
              targetKey = "subscriptionModels";
              officialSearchAllowed =
                Boolean(this.#host.isOfficialNativeSearchAllowed?.(providerId)) &&
                supportsNativeWebSearch(targetApi, { baseUrl: targetBaseUrl, provider: providerId });
            } else {
              throw new Error(`未找到可校准的连接「${providerId}」；新增连接请使用模型配置卡片。`);
            }
          }

          for (const { id: modelId, patch } of models) {
            const idx = targetList.findIndex((item) => item.id === modelId);
            if (idx < 0) {
              throw new Error(`连接「${targetLabel}」中不存在已添加的模型「${modelId}」；添加新模型请使用模型配置卡片。`);
            }
            const beforeModel = clone(targetList[idx]!);
            const merged: CustomModelConfig = { ...beforeModel, ...patch, id: beforeModel.id };

            // Keep vision aligned when modalities are updated without explicit vision flag.
            if (patch.modalities !== undefined && patch.vision === undefined) {
              merged.vision = patch.modalities.includes("image");
            }
            // Keep thinkingEnabled aligned when reasoning is toggled off without explicit thinkingEnabled.
            if (patch.reasoning === false && patch.thinkingEnabled === undefined) {
              merged.thinkingEnabled = false;
              if (patch.thinkingLevels === undefined) delete merged.thinkingLevels;
              if (patch.thinkingLevelMap === undefined) delete merged.thinkingLevelMap;
            }
            // If nativeTools.webSearch is explicitly enabled, enforce API and official-source guards.
            if (patch.nativeTools?.webSearch === true) {
              if (targetApi === "google-generative-ai" || targetApi === "google-vertex") {
                throw new Error(`Google API 不支持将原生联网搜索与智能体函数工具同时使用，请保持「${modelId}」的联网搜索关闭。`);
              }
              if (!officialSearchAllowed) {
                throw new Error(`连接「${targetLabel}」当前不支持开启「${modelId}」的原生联网搜索（仅支持原厂官方接口及 OpenRouter 官方接入）。`);
              }
            }
            if (isConversationModel(merged) && typeof merged.contextWindow === "number" && typeof merged.maxTokens === "number" && merged.maxTokens > merged.contextWindow) {
              throw new Error(`模型「${modelId}」的最大输出 (${merged.maxTokens}) 不能超过上下文窗口 (${merged.contextWindow})。`);
            }

            // Single-source validation identical to ModelConfiguration and Settings save.
            validateConfigurationModel(merged, targetApi);
            const [sanitized] = sanitizeCustomModelList([merged], targetApi);
            if (!sanitized) {
              throw new Error(`模型「${modelId}」的校准参数无效。`);
            }

            const diffLine = describeModelDiff(targetLabel, beforeModel, sanitized);
            if (diffLine) {
              targetList[idx] = sanitized;
              touchedKeys.add(targetKey);
              changedProviders.add(providerId);
              changedModels += 1;
              changes.push(diffLine);

              // Keep active default thinking level valid if the calibrated model is the current default.
              if (
                (next.defaultProvider === providerId || (!next.defaultProvider && providerId === "kulo-gateway")) &&
                next.defaultModel === modelId &&
                isConversationModel(sanitized)
              ) {
                const allowedEfforts = sanitized.reasoning === false || sanitized.thinkingEnabled === false
                  ? ["off"]
                  : sanitized.thinkingLevels?.map((level) => level.id);
                if (allowedEfforts?.length && !allowedEfforts.includes(next.thinkingLevel)) {
                  next.thinkingLevel = allowedEfforts.includes("medium") ? "medium" : allowedEfforts[0]!;
                  touchedKeys.add("thinkingLevel");
                }
              }
            }
          }
        }

        if (changes.length === 0) {
          return {
            id: commandId,
            kind: "settings" as const,
            title: (title?.trim() || "模型配置无需调整").slice(0, 100),
            changes: ["所选模型的当前参数已与目标配置一致，无需修改。"],
            status: "applied" as const,
            requiresConfirmation: false,
            canUndo: false,
          };
        }

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const key of touchedKeys) {
          before[key] = field(doc.model, key) ?? null;
        }
        applySettingsBlockUpdate(doc, "model", expectedRevision, next);
        state.observedRevisions.model = doc.revisions.model;
        for (const key of touchedKeys) {
          after[key] = field(doc.model, key) ?? null;
        }

        const defaultTitle = `已校准模型配置（${changedProviders.size} 个连接 · ${changedModels} 个模型）`;
        const actionView: SettingsAssistantAction = {
          id: commandId,
          kind: "settings",
          title: (title?.trim() || defaultTitle).slice(0, 100),
          changes: changes.map((line) => this.#redact(line).slice(0, 300)),
          status: "applied",
          requiresConfirmation: false,
          canUndo: true,
        };
        state.actions.push({
          view: actionView,
          block: "model",
          before,
          after,
          revision: doc.revisions.model,
        });
        applied = clone(doc) as KuloDurableSettings;
        return clone(actionView);
      }, BACKGROUND_CONTEXT);

      if (applied) await this.#host.applied(applied);
      await this.#emit();
      return view;
    });
  }

  async clientAction(kind: "appearance" | "navigate", values: Pick<SettingsAssistantAction, "appearance" | "module" | "intent">, commandId: string, callerConversationId?: number): Promise<SettingsAssistantAction> {
    const fromMainChat = await this.#isMainChatCaller(callerConversationId);
    const existing = await this.#existingAction(commandId);
    if (existing) return existing;
    if (kind === "navigate" && values.intent) {
      const expectedModule = values.intent === "add-connection"
        ? "connections"
        : values.intent === "add-api" || values.intent === "add-oauth"
          ? "models"
          : values.intent === "add-device" || values.intent === "join-device"
            ? "machines"
            : "identity";
      if (values.module !== expectedModule) throw new Error("该操作与目标设置页不匹配。");
    }
    if (fromMainChat) {
      const single = this.#contexts.size === 1 ? [...this.#contexts.values()][0] : undefined;
      if (!single) {
        return {
          id: commandId,
          kind,
          title: kind === "appearance" ? `切换为${values.appearance === "dark" ? "深色" : values.appearance === "light" ? "浅色" : "跟随系统"}` : "打开设置",
          changes: [],
          status: "pending",
          requiresConfirmation: false,
          canUndo: false,
          ...(kind === "appearance" ? { appearance: values.appearance } : { module: values.module, ...(values.intent ? { intent: values.intent } : {}) }),
        };
      }
      return this.#serialize(async () => {
        const view = await this.#host.harness.commit(async (tx) => {
          const state = await tx.doc(SettingsAssistantDoc);
          const repeated = state.actions.find((a) => a.view.id === commandId);
          if (repeated) return clone(repeated.view);
          const action: SettingsAssistantAction = {
            id: commandId,
            kind,
            title: kind === "appearance" ? `切换为${values.appearance === "dark" ? "深色" : values.appearance === "light" ? "浅色" : "跟随系统"}` : "打开设置",
            changes: [],
            status: "pending",
            requiresConfirmation: false,
            canUndo: false,
            clientId: single.clientId,
            ...(kind === "appearance" ? { appearance: values.appearance, previousAppearance: single.appearance } : { module: values.module, ...(values.intent ? { intent: values.intent } : {}) }),
          };
          state.actions.push({ view: action });
          return clone(action);
        }, BACKGROUND_CONTEXT);
        await this.#emit();
        return view;
      });
    }
    const context = await this.#turn();
    return this.#serialize(async () => {
      const view = await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        const existing = state.actions.find((a) => a.view.id === commandId);
        if (existing) return clone(existing.view);
        if (kind === "navigate" && values.module && values.module !== "workers") {
          const live = this.#contexts.get(context.clientId);
          if (live && !live.hasUnsavedChanges) this.#contexts.set(context.clientId, { ...live, module: values.module });
          if (state.turnContext && !state.turnContext.hasUnsavedChanges) state.turnContext.module = values.module;
        }
        const action: SettingsAssistantAction = {
          id: commandId, kind, title: kind === "appearance" ? `切换为${values.appearance === "dark" ? "深色" : values.appearance === "light" ? "浅色" : "跟随系统"}` : "打开设置", changes: [],
          status: "pending", requiresConfirmation: false, canUndo: false,
          clientId: context.clientId,
          ...(kind === "appearance" ? { appearance: values.appearance, previousAppearance: this.#contexts.get(context.clientId)?.appearance ?? context.appearance } : { module: values.module, ...(values.intent ? { intent: values.intent } : {}) }),
        };
        state.actions.push({ view: action });
        return clone(action);
      }, BACKGROUND_CONTEXT);
      await this.#emit();
      return view;
    });
  }

  async decide(actionId: string, decision: SettingsAssistantDecision, clientId: string, error?: string, expectedTopicId?: string | null): Promise<void> {
    if (!["confirm", "reject", "undo", "client-applied", "client-failed"].includes(decision)) throw new Error("无效的操作决定。");
    await this.#serialize(async () => {
      const snapshot = await this.#host.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (expectedTopicId !== undefined) assertExpected(snapshot, expectedTopicId);
      const workspace = snapshot?.actions.find((item) => item.view.id === actionId);
      if (workspace?.view.historical) throw new Error("历史回执仅供查看，请重新发起设置操作。");
      if (workspace?.deviceOperation) {
        if (workspace.view.clientId && workspace.view.clientId !== clientId) throw new Error("此操作属于另一台浏览器。");
        const view = this.#deviceActionView(workspace);
        if (view.status !== "pending") return;
        if (decision === "reject") {
          await this.#host.harness.commit(async (tx) => {
            const found = (await tx.doc(SettingsAssistantDoc)).actions.find((item) => item.view.id === actionId);
            if (found) found.view.status = "rejected";
          }, BACKGROUND_CONTEXT);
          await this.#emit();
          return;
        }
        if (decision !== "confirm") return;
        const current = this.#contexts.get(clientId);
        if (current?.hasUnsavedChanges) throw new Error("当前页面有尚未保存的修改，请先保存或放弃修改。");
        const op = workspace.deviceOperation;
        let result: unknown;
        let change: PreparedDeviceRoleChange | undefined;
        if (op.kind === "device-leave") {
          result = { targetRole: "hub" };
        } else {
          const controller = this.#host.deviceController?.();
          if (!controller) throw new Error("当前环境不支持设备互联管理。");
          if (op.kind === "device-disable") {
            result = await controller.setEnabled(false, true);
          } else if (op.kind === "device-remove") {
            await controller.removeDevice(op.deviceId, true);
            result = { removed: op.deviceId };
          } else if (op.kind === "device-ssh-add") {
            result = await controller.addSsh(op.scanId);
          } else if (op.kind === "device-join") {
            if (!controller.canSwitchRole() || !controller.view(clientId).canSwitchRole || !controller.joinPeer || !this.#host.joinStaging) {
              throw new Error("当前运行模式不支持直接切换接入其他主机。");
            }
            const force = op.force === true || controller.roleStatus?.(actionId)?.code === "local_tasks_running";
            try {
              if (workspace.view.status === "submitted") change = await controller.resumeJoin?.(actionId, op.hubUrl, force);
              if (!change) {
                const staged = this.#host.joinStaging.resolve(op.joinRef);
                change = await controller.joinPeer({ hubUrl: staged.hubUrl, inviteToken: staged.inviteToken }, force, actionId);
              }
            } catch (error) {
              if (error && typeof error === "object" && "code" in error && error.code === "local_tasks_running") {
                await this.#host.harness.commit(async (tx) => {
                  const found = (await tx.doc(SettingsAssistantDoc)).actions.find((item) => item.view.id === actionId);
                  if (found?.deviceOperation?.kind === "device-join") {
                    found.deviceOperation.force = true;
                    found.view.description = "本机当前有未结束的任务。继续接入将停止这些任务并保留本地历史。";
                  }
                }, BACKGROUND_CONTEXT);
                await this.#emit();
              }
              throw error;
            }
            result = change.receipt;
          }
        }
        try {
          await this.#host.harness.commit(async (tx) => {
            const found = (await tx.doc(SettingsAssistantDoc)).actions.find((item) => item.view.id === actionId);
            if (found) {
              found.view.status = op.kind === "device-join" || op.kind === "device-leave" ? "submitted" : "applied";
              delete found.view.error;
              if (result !== undefined) found.workspaceResult = clone(result);
            }
          }, BACKGROUND_CONTEXT);
        } catch (error) {
          change?.cancel();
          throw error;
        }
        try { await this.#emit(); }
        finally {
          if (change && op.kind === "device-join") {
            const prepared = change;
            setImmediate(() => void prepared.start().then(async () => {
              if (prepared.receipt.status === "ready") this.#host.joinStaging?.consume(op.joinRef);
              if (!this.#closed) await this.#emit();
            }).catch(() => { if (!this.#closed) console.error("设备切换回执未能同步至设置对话。"); }));
          }
        }
        return;
      }
      if (workspace?.workspaceUndoOperation) {
        if (workspace.view.clientId !== clientId || !this.#contexts.has(clientId)) throw new Error("此操作属于另一台浏览器。");
        if (decision !== "undo" || workspace.view.status !== "applied" || !workspace.view.canUndo) return;
        if (!this.#host.applyWorkspaceOperation) throw new Error("能力管理不可用。");
        await this.#host.applyWorkspaceOperation(workspace.workspaceUndoOperation);
        await this.#host.harness.commit(async (tx) => {
          const item = (await tx.doc(SettingsAssistantDoc)).actions.find((entry) => entry.view.id === actionId);
          if (item?.view.status === "applied") { item.view.status = "undone"; item.view.canUndo = false; }
        }, BACKGROUND_CONTEXT);
        await this.#emit();
        return;
      }
      if (workspace?.workspaceOperation) {
        if (workspace.view.clientId !== clientId || !this.#contexts.has(clientId)) throw new Error("此操作属于另一台浏览器。");
        if (workspace.view.status !== "pending") return;
        if (decision === "reject") {
          await this.#host.harness.commit(async (tx) => { const found = (await tx.doc(SettingsAssistantDoc)).actions.find((item) => item.view.id === actionId); if (found?.view.status === "pending") found.view.status = "rejected"; }, BACKGROUND_CONTEXT);
        } else if (decision === "confirm") {
          if (!this.#host.applyWorkspaceOperation) throw new Error("能力管理不可用。");
          const result = await this.#host.applyWorkspaceOperation(workspace.workspaceOperation);
          await this.#host.harness.commit(async (tx) => { const found = (await tx.doc(SettingsAssistantDoc)).actions.find((item) => item.view.id === actionId); if (found) { found.view.status = "applied"; found.workspaceResult = clone(result); } }, BACKGROUND_CONTEXT);
        }
        await this.#emit();
        return;
      }
      let applied: KuloDurableSettings | undefined;
      let cleanupProviderId: string | undefined;
      await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(SettingsAssistantDoc);
        const action = state.actions.find((item) => item.view.id === actionId);
        if (!action) throw new Error("操作不存在。");
        const view = action.view;
        if (view.kind !== "settings" && view.clientId && view.clientId !== clientId) throw new Error("此操作属于另一台浏览器。");
        if (decision === "confirm" && action.cleanupPending && action.removedProviderId) {
          cleanupProviderId = action.removedProviderId;
          return;
        }
        if (decision === "reject" && action.cleanupPending) throw new Error("连接已移除，请重试确认以完成认证清理。");
        if (view.kind !== "settings") {
          if (view.kind === "appearance-customization" && !this.#contexts.has(clientId)) throw new Error("原窗口尚未连接，请重新加载后继续。");
          if (decision === "reject" && view.status === "pending") { view.status = "rejected"; return; }
          if (decision === "undo" && (view.kind === "appearance" || view.kind === "appearance-customization") && view.status === "applied" && view.canUndo) {
            view.status = "undone";
            view.canUndo = false;
          } else if (view.status === "pending" && decision === "client-applied") {
            view.status = "applied";
            view.canUndo = view.kind === "appearance" || view.kind === "appearance-customization";
          } else if (view.status === "pending" && decision === "client-failed") {
            view.status = "failed";
            view.error = error?.slice(0, 300) || "操作未完成";
          }
          return;
        }
        if (decision === "reject" && view.status === "pending") { view.status = "rejected"; return; }
        const undo = decision === "undo" && view.status === "applied" && view.canUndo;
        const confirm = decision === "confirm" && view.status === "pending" && view.requiresConfirmation;
        if (!undo && !confirm) return;
        this.#assertWritable(action.block!, clientId);
        const doc = await tx.doc(KuloSettingsDoc);
        const block = action.block!;
        if (confirm && doc.revisions[block] !== action.revision) throw new Error("设置已发生变化，请重新发起操作。");
        const expected = undo ? action.after! : action.before!;
        const changes = undo ? action.before! : action.after!;
        for (const [key, value] of Object.entries(expected)) {
          if (!same(field(doc[block], key) ?? null, value)) throw new Error("相关设置已被修改，无法覆盖；请重新发起操作。");
        }
        const next = clone(doc[block]) as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(changes)) assignField(next, key, value === null ? undefined : value);
        applySettingsBlockUpdate(doc, block, doc.revisions[block], next);
        view.status = undo ? "undone" : "applied";
        view.canUndo = !undo && !action.removedProviderId;
        if (action.removedProviderId && !undo) {
          action.cleanupPending = true;
          cleanupProviderId = action.removedProviderId;
        }
        applied = clone(doc) as KuloDurableSettings;
      }, BACKGROUND_CONTEXT);
      if (applied) await this.#host.applied(applied);
      if (cleanupProviderId) {
        try {
          await this.#host.removeProviderAuth(cleanupProviderId);
          await this.#host.harness.commit(async (tx) => {
            const action = (await tx.doc(SettingsAssistantDoc)).actions.find((item) => item.view.id === actionId)!;
            action.cleanupPending = false;
            action.view.status = "applied";
            delete action.view.error;
          }, BACKGROUND_CONTEXT);
        } catch (cause) {
          await this.#host.harness.commit(async (tx) => {
            const action = (await tx.doc(SettingsAssistantDoc)).actions.find((item) => item.view.id === actionId)!;
            action.view.status = "pending";
            action.view.error = "连接已移除，认证清理失败。请重试确认。";
          }, BACKGROUND_CONTEXT);
          await this.#emit();
          throw new Error("连接已移除，认证清理失败。请重试确认。", { cause });
        }
      }
      await this.#emit();
    });
  }
}

export function createGlobalSettingsToolsExtension(get: () => SettingsAssistant) {
  const result = (value: unknown, addTools: string[] = []) => ({
    output: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(addTools.length ? { control: { addTools } } : {}),
  });
  return defineExtension({
    name: "kulo-global-settings",
    tools: [
      defineTool({
        name: "kulo_settings_read",
        description: "Read current or specified settings section (`current`, `models`, `workers`, `identity`, `machines`, `appearance`, `capabilities`, `extensions`, `connections`, `permissions`, `schedules`, `archives`) without secrets. 关键词：读取设置 查看配置 模型并发设备外观权限定时归档扩展",
        parameters: obj({ section: opt(oneOf(["current", ...MODULES, "extensions"] as const)) }),
        deferred: true,
        replay: "safe",
        execute: async (args, api, context) => {
          const value = await get().read(args.section, Number(api.conversationId));
          const section = args.section ?? "current";
          const followUps: string[] = [];
          if (["current", "models", "workers", "identity"].includes(section)) followUps.push("kulo_settings_update");
          if (["current", "identity"].includes(section)) followUps.push("kulo_memory_service_read");
          if (section === "appearance") followUps.push("kulo_settings_appearance");
          if (section === "extensions") followUps.push("kulo_extension_manage");
          if (section === "capabilities") followUps.push("kulo_capability_manage", "kulo_skill_manage");
          const addTools = followUps.length
            ? await resolveDeferredAddTools(api, context, followUps)
            : [];
          return result(value, addTools);
        },
      }),
      defineTool({
        name: "kulo_settings_update",
        description: "Apply allowlisted settings changes immediately (`block` in `model`/`executor`/`presentation`/`roles`; `changes` JSON object using `roleId.field` for `roles`; read settings first; excludes credentials, URLs, and Identity files—use `kulo_memory_service_read` / `kulo_memory_service_prepare` for Hindsight setup and memory enable/disable toggles). 关键词：修改设置 调整并发子智能体上限 切换默认模型 改名 角色配置 自动归档",
        parameters: obj({ block: oneOf(["model", "executor", "presentation", "roles"]), changes: str(), title: str() }),
        deferred: true,
        execute: async (args, api) => result(await get().update(args.block, args.changes, args.title, api.callId, Number(api.conversationId))),
      }),
      defineTool({
        name: "kulo_settings_appearance",
        description: "Switch display mode (`system`/`light`/`dark`) on the connected browser immediately. 关键词：切换外观 深色模式 浅色模式 夜间主题 暗黑明暗跟随系统",
        parameters: obj({ mode: oneOf(["system", "light", "dark"]) }),
        deferred: true,
        execute: async (args, api) => result(await get().clientAction("appearance", { appearance: args.mode }, api.callId, Number(api.conversationId))),
      }),
      defineTool({
        name: "kulo_settings_navigate",
        description: "Navigate to a target settings page or open its add-connection, subscription sign-in, Identity editor, device join, or memory setup flow (secrets are entered only in dedicated UI forms). 关键词：打开设置页面 跳转配置 添加API密钥 登录订阅 配置记忆 接入设备",
        parameters: obj({ module: oneOf(MODULES), intent: opt(oneOf(INTENTS)) }),
        deferred: true,
        execute: async (args, api) => result(await get().clientAction("navigate", { module: args.module, intent: args.intent }, api.callId, Number(api.conversationId))),
      }),
    ],
  });
}

export function createSettingsAssistantExtension(get: () => SettingsAssistant) {
  const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  return defineExtension({
    name: "kulo-settings-assistant",
    sections: [section("kulo_settings", async () => buildSettingsAssistantPrompt(await get().promptTurn()), { tag: false })],
    tools: [
      defineTool({ name: "kulo_connection_prepare", description: "Open a secret/authorization form in the right-hand Settings chat for preset apps (`category='app'`, `app_id`), website/server logins (`category='credential'`), or user notes (`category='information'`). Accepts public metadata and field labels only—never secret values. 关键词：准备连接表单 录入密码密钥 新增SSH服务器账号", parameters: obj({ kind: opt(oneOf(["ssh", "account", "api-key", "custom", "app"])), category: opt(oneOf(["app", "credential", "information"])), app_id: opt(oneOf(["messages", "mail", "github", "figma"])), connection_id: opt(str()), name: opt(str()), host: opt(str()), port: opt(num()), username: opt(str()), url: opt(str()), auth_type: opt(oneOf(["bearer", "basic", "header"])), header_name: opt(str()), type_label: opt(str()), instructions: opt(str()), credential_fields: opt(arr(obj({ key: str(), label: str() }))) }), deferred: true, replay: "safe", execute: async (args, api) => {
        publicConnectionArguments(args, ["kind", "category", "app_id", "connection_id", "name", "host", "port", "username", "url", "auth_type", "header_name", "type_label", "instructions", "credential_fields"]);
        return result(await get().prepareConnection({ kind: args.kind, category: args.category, appId: args.app_id, connectionId: args.connection_id, name: args.name, host: args.host, port: args.port, username: args.username, url: args.url, authType: args.auth_type, headerName: args.header_name, typeLabel: args.type_label, instructions: args.instructions, credentialFields: args.credential_fields }, api.callId));
      } }),
      defineTool({ name: "kulo_settings_remove_connection", description: "Propose removing a custom model connection via a user confirmation card (not applied until confirmed). 关键词：移除模型连接 删除自定义供应商连接", parameters: obj({ provider_id: str() }), deferred: true, execute: async (args, api) => result(await get().removeConnection(args.provider_id, api.callId)) }),
    ],
  });
}
