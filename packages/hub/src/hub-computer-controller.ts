import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, JsonObject } from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import {
  resolveEffectiveExecutionMode,
  type ComputerPreviewInputEvent,
  type ComputerPreviewSessionView,
  type ComputerPreviewUpdate,
  type ComputerUseConfigurationInput,
  type ComputerUseSettings,
} from "@kulo/protocol";
import type { KuloActionConfirmations } from "./action-confirmations.js";
import type { KuloCapabilities } from "./capabilities.js";
import { submitAutomaticChatInput } from "./chat-control.js";
import {
  ActiveComputerHandoffTracker,
  COMPUTER_HANDOFF_TTL_MS,
  buildComputerHandoffCard,
  computerHandoffFingerprint,
  formatComputerHandoffResumePrompt,
} from "./computer-handoff.js";
import type { KuloConnections } from "./connections.js";
import type { HubRuntimeGates } from "./hub-kernel-ports.js";
import type { HubMediaDelivery } from "./hub-media-delivery.js";
import {
  CoordinatorEventEntry,
  KuloStateDoc,
  isOrchestratorConversation,
  resolveTicketExecutionScope,
} from "./state.js";
import { canDirectStopTicket } from "./ticket-stop.js";
import { createComputerUseExtension } from "./tools-computer-use.js";

interface TrackedComputerSession {
  ticketId: string;
  envId: string;
  tool: "browser" | "desktop";
  sessionId: string;
  conversationId: number;
  runEpoch: number;
  app?: string;
}

interface OrchestratorComputerSession {
  topicId: string;
  conversationId: number;
  envId: string;
  tool: "browser" | "desktop";
  sessionId: string;
  app?: string;
  idleTimer: ReturnType<typeof setTimeout>;
}

export interface HubComputerShellOptions {
  envManager: Pick<
    EnvManager,
    "getEnvDescriptor" | "getExecutionTrustMode" | "requestComputerUse" | "subscribeComputerPreview" | "sendComputerPreviewInput"
  >;
  orchestratorBrowserIdleMs: number;
}

export interface HubComputerRuntimeDeps {
  harness: Harness;
  getRootConversationId: () => number;
  capabilities: Pick<KuloCapabilities, "configureComputerUse">;
  actionConfirmations: KuloActionConfirmations;
  connectionManager: Pick<KuloConnections, "redact">;
  runtimeGates: Pick<HubRuntimeGates, "isClosed" | "broadcastTickets" | "resumeIfNotRecovering">;
  mediaDelivery: Pick<HubMediaDelivery, "mediaSource" | "validateMediaSource">;
  resolveOrchestratorTargetEnvId: (
    conversationId: number,
    toolTaskId: number | undefined,
    context: Context,
  ) => Promise<{ topicId: string; envId: string }>;
  reconfigureConversations: (context: Context) => Promise<void>;
  stopTicket: (ticketId: string, reason: string, context: Context, commandId: string) => Promise<unknown>;
  steerTicket: (
    params: { ticketId: string; commandId: string; text: string },
    context: Context,
  ) => Promise<unknown>;
}

/**
 * Owns browser/desktop computer-use sessions, human handoff cards, live previews,
 * and idle orchestrator browser sessions via explicit two-phase binding:
 *   1. HubComputerController.createShell(...) before Harness.open()
 *   2. controller.attachRuntime(deps) once KuloHub runtime dependencies exist.
 */
export class HubComputerController {
  readonly #envManager: HubComputerShellOptions["envManager"];
  readonly #orchestratorBrowserIdleMs: number;
  readonly #computerSessions = new Map<string, TrackedComputerSession>();
  readonly #computerHandoffs = new ActiveComputerHandoffTracker();
  readonly #orchestratorSessions = new Map<string, OrchestratorComputerSession>();
  #computerUseSettings: ComputerUseSettings = { browserEnabled: true, desktopEnabled: true };
  #runtime: HubComputerRuntimeDeps | null = null;

  private constructor(options: HubComputerShellOptions) {
    this.#envManager = options.envManager;
    this.#orchestratorBrowserIdleMs = options.orchestratorBrowserIdleMs;
  }

  static createShell(options: HubComputerShellOptions): {
    controller: HubComputerController;
    extension: ReturnType<typeof createComputerUseExtension>;
  } {
    const controller = new HubComputerController(options);
    const extension = createComputerUseExtension({
      scope: (api, tool) => controller.#resolveExtensionScope(api, tool ?? "browser"),
      execute: (envId, request, signal) => {
        if (request.tool === "browser" && !controller.#computerUseSettings.browserEnabled) {
          throw new Error("浏览器操控已关闭，请在「工具与技能 → 电脑操控」中开启。");
        }
        if (request.tool === "desktop" && !controller.#computerUseSettings.desktopEnabled) {
          throw new Error("桌面操控已关闭，请在「工具与技能 → 电脑操控」中开启。");
        }
        return controller.#envManager.requestComputerUse(envId, request, signal);
      },
      sessionOpened: (scope, tool, sessionId) => controller.#onSessionOpened(scope, tool, sessionId),
      sessionObserved: (scope, tool, sessionId, app) => {
        if (scope.ticketId.startsWith("chat:")) {
          const topicId = scope.ticketId.split(":")[1] ?? "root";
          const existing = controller.#orchestratorSessions.get(`${topicId}:${tool}`);
          if (existing && existing.sessionId === sessionId) existing.app = app;
          return;
        }
        const session = controller.#computerSessions.get(`${scope.ticketId}:${tool}:${sessionId}`);
        if (session) session.app = app;
      },
      sessionClosed: (scope, tool, sessionId) => {
        if (scope.ticketId.startsWith("chat:")) {
          const topicId = scope.ticketId.split(":")[1] ?? "root";
          controller.#forgetOrchestratorSession(topicId, tool, sessionId);
          return;
        }
        controller.#computerSessions.delete(`${scope.ticketId}:${tool}:${sessionId}`);
      },
      requestHandoff: (scope, input, api, ctx) => controller.#requestComputerHandoff(scope, input, api, ctx),
    });
    return { controller, extension };
  }

  attachRuntime(deps: HubComputerRuntimeDeps): void {
    this.#runtime = deps;
  }

  #requireRuntime(): HubComputerRuntimeDeps {
    if (!this.#runtime) throw new Error("HubComputerController runtime not attached.");
    return this.#runtime;
  }

  get settings(): Readonly<ComputerUseSettings> {
    return this.#computerUseSettings;
  }

  setInitialSettings(settings: ComputerUseSettings): void {
    this.#computerUseSettings = { ...settings };
  }

  clearHandoff(ticketId: string) {
    return this.#computerHandoffs.clear(ticketId);
  }

  activeOrchestratorBrowserEnvId(topicId: string): string | undefined {
    return this.#orchestratorSessions.get(`${topicId}:browser`)?.envId;
  }

  async configureComputerUse(
    input: ComputerUseConfigurationInput,
  ): Promise<{ computerUse: ComputerUseSettings; revision: number }> {
    const rt = this.#requireRuntime();
    const result = await rt.capabilities.configureComputerUse(input);
    const previous = this.#computerUseSettings;
    this.#computerUseSettings = { ...result.computerUse };
    if (previous.browserEnabled && !result.computerUse.browserEnabled) {
      for (const entry of [...this.#orchestratorSessions.values()]) {
        if (entry.tool === "browser") await this.#closeOrchestratorEntry(entry, false);
      }
    }
    if (previous.desktopEnabled && !result.computerUse.desktopEnabled) {
      for (const entry of [...this.#orchestratorSessions.values()]) {
        if (entry.tool === "desktop") await this.#closeOrchestratorEntry(entry, false);
      }
    }
    await rt.reconfigureConversations(BACKGROUND_CONTEXT);
    return result;
  }

  async #resolveExtensionScope(
    api: { conversationId: ConversationId; taskId: unknown },
    tool: "browser" | "desktop" = "browser",
  ) {
    const rt = this.#requireRuntime();
    const state = await rt.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    if (isOrchestratorConversation(api.conversationId, state)) {
      const resolved = await rt.resolveOrchestratorTargetEnvId(
        Number(api.conversationId),
        Number(api.taskId),
        BACKGROUND_CONTEXT,
      );
      const orchKey = `${resolved.topicId}:${tool}`;
      const existing = this.#orchestratorSessions.get(orchKey);
      if (existing && existing.envId !== resolved.envId) {
        await this.#closeOrchestratorEntry(existing, false);
      } else if (existing) {
        this.#touchOrchestratorSession(
          resolved.topicId,
          tool,
          Number(api.conversationId),
          resolved.envId,
          existing.sessionId,
          existing.app,
        );
      }
      const envDescriptor = this.#envManager.getEnvDescriptor(resolved.envId);
      const effectiveMode = resolveEffectiveExecutionMode({
        hubTrustMode: this.#envManager.getExecutionTrustMode(),
        descriptor: envDescriptor,
        isLocal: envDescriptor?.kind === "local",
      });
      const assertActive = async () => {
        if (rt.runtimeGates.isClosed()) throw new Error("Hub 已关闭。");
        const latestState = await rt.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const topic = latestState?.topics?.[resolved.topicId];
        if (!topic || topic.deletedAt) throw new Error("会话已删除。");
        const envDesc = this.#envManager.getEnvDescriptor(resolved.envId);
        if (!envDesc?.online) throw new Error("目标电脑已离线，操作会话已停止。");
      };
      return {
        ticketId: `chat:${resolved.topicId}:${tool}:${resolved.envId}`,
        conversationId: Number(api.conversationId),
        runEpoch: 1,
        envId: resolved.envId,
        readOnly: effectiveMode === "sandboxed",
        executionMode: effectiveMode,
        ...(existing && existing.envId === resolved.envId ? { preservedSessionId: existing.sessionId } : {}),
        assertActive,
      };
    }

    const source = await rt.mediaDelivery.mediaSource(Number(api.conversationId));
    if (!source.ticketId || !source.envId || source.runEpoch === undefined) {
      throw new Error("电脑操作需要有效的执行任务及目标设备。");
    }
    const assertActive = async () => {
      const current = await rt.mediaDelivery.mediaSource(Number(api.conversationId));
      if (current.ticketId !== source.ticketId || current.envId !== source.envId || current.runEpoch !== source.runEpoch) {
        throw new Error("电脑操作的任务执行资格已失效。");
      }
      const currentState = await rt.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const scope = resolveTicketExecutionScope(currentState, api.conversationId);
      if (scope?.subagent && scope.subagent.state !== "running") {
        throw new Error("子任务已停止，不能继续操作设备。");
      }
      await rt.mediaDelivery.validateMediaSource(source);
    };
    const retainedSession = [...this.#computerSessions.values()].find(
      (entry) => entry.ticketId === source.ticketId && entry.conversationId === Number(api.conversationId) && entry.envId === source.envId,
    );
    if (retainedSession && retainedSession.runEpoch !== source.runEpoch) {
      retainedSession.runEpoch = source.runEpoch;
    }
    const currentState = await rt.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const execScope = resolveTicketExecutionScope(currentState, api.conversationId);
    const frozenMode = currentState?.ticketExecutionModes?.[source.ticketId];
    const baseTrustMode = frozenMode?.runEpoch === source.runEpoch
      ? frozenMode.mode
      : this.#envManager.getExecutionTrustMode();
    const envDesc = this.#envManager.getEnvDescriptor(source.envId);
    const workerEffectiveMode = resolveEffectiveExecutionMode({
      hubTrustMode: baseTrustMode,
      descriptor: envDesc,
      isLocal: envDesc?.kind === "local",
    });
    return {
      ticketId: source.ticketId,
      conversationId: Number(api.conversationId),
      runEpoch: source.runEpoch,
      envId: source.envId,
      readOnly: Boolean(source.readOnly),
      executionMode: workerEffectiveMode,
      ...(execScope?.isSubagent ? { isSubagent: true } : {}),
      ...(retainedSession ? { preservedSessionId: retainedSession.sessionId } : {}),
      assertActive,
    };
  }

  async #onSessionOpened(
    scope: { ticketId: string; conversationId: number; runEpoch: number; envId: string },
    tool: "browser" | "desktop",
    sessionId: string,
  ): Promise<void> {
    const rt = this.#requireRuntime();
    if (scope.ticketId.startsWith("chat:")) {
      const topicId = scope.ticketId.split(":")[1] ?? "root";
      this.#touchOrchestratorSession(topicId, tool, scope.conversationId, scope.envId, sessionId);
      return;
    }
    if (!this.#envManager.getEnvDescriptor(scope.envId)?.capabilities.includes(`agent-${tool}`)) return;
    const key = `${scope.ticketId}:${tool}:${sessionId}`;
    if (!this.#computerSessions.has(key)) {
      this.#computerSessions.set(key, {
        ticketId: scope.ticketId,
        envId: scope.envId,
        tool,
        sessionId,
        conversationId: scope.conversationId,
        runEpoch: scope.runEpoch,
      });
    }
    await rt.harness.commit(async (tx) => {
      const ticket = (await tx.doc(KuloStateDoc)).tickets[scope.ticketId];
      if (ticket && ticket.runEpoch === scope.runEpoch && !ticket.deviceStateTouched) {
        ticket.deviceStateTouched = true;
      }
    }, BACKGROUND_CONTEXT);
  }

  async listComputerPreviews(topicId: string): Promise<ComputerPreviewSessionView[]> {
    const rt = this.#requireRuntime();
    if (rt.runtimeGates.isClosed() || !topicId || topicId.length > 256) return [];
    const state = await rt.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const allTopics = topicId === "*";
    if (!allTopics) {
      const topic = state?.topics?.[topicId];
      if (!topic || topic.deletedAt) return [];
    }
    const sessions: ComputerPreviewSessionView[] = [];
    for (const [key, session] of this.#computerSessions) {
      const scope = resolveTicketExecutionScope(state, session.conversationId as ConversationId);
      const ticket = scope?.ticket;
      const env = this.#envManager.getEnvDescriptor(session.envId);
      const originTopicId = ticket ? (ticket.originTopicId ?? "root") : undefined;
      const originTopic = originTopicId ? state?.topics?.[originTopicId] : undefined;
      const activeHandoff = this.#computerHandoffs.get(session.ticketId);
      const handoffActiveForSession = Boolean(
        activeHandoff &&
          activeHandoff.sessionId === session.sessionId &&
          ticket?.status === "waiting" &&
          ticket.waiting?.reason === "user",
      );
      if (
        !ticket ||
        ticket.id !== session.ticketId ||
        (!handoffActiveForSession && (ticket.status !== "running" || ticket.runEpoch !== session.runEpoch)) ||
        ticket.envId !== session.envId ||
        !originTopic ||
        originTopic.deletedAt ||
        (!allTopics && originTopicId !== topicId) ||
        (!handoffActiveForSession && scope?.subagent && scope.subagent.state !== "running") ||
        !env?.online ||
        !env.capabilities.includes(`agent-${session.tool}`)
      ) {
        continue;
      }
      sessions.push({
        id: createHash("sha256").update(key).digest("hex"),
        ticketId: ticket.id,
        tool: session.tool,
        envId: env.id,
        deviceName: env.name,
        title: ticket.title,
        ...(session.app ? { app: session.app } : {}),
        ...(handoffActiveForSession && activeHandoff
          ? {
              handoff: {
                requestId: activeHandoff.requestId,
                ...(activeHandoff.cardId ? { cardId: activeHandoff.cardId } : {}),
                reason: activeHandoff.reason,
                target: activeHandoff.tool,
                expiresAt: activeHandoff.expiresAt,
                ...(activeHandoff.url ? { url: activeHandoff.url } : {}),
                ...(activeHandoff.app ? { app: activeHandoff.app } : {}),
                interactive: session.tool === "browser",
              },
            }
          : {}),
      });
    }
    for (const entry of this.#orchestratorSessions.values()) {
      const topic = state?.topics?.[entry.topicId];
      const env = this.#envManager.getEnvDescriptor(entry.envId);
      if (
        !topic ||
        topic.deletedAt ||
        (!allTopics && entry.topicId !== topicId) ||
        !env?.online ||
        !env.capabilities.includes(`agent-${entry.tool}`)
      ) {
        continue;
      }
      const previewKey = `chat:${entry.topicId}:${entry.tool}:${entry.sessionId}`;
      const handoffKey = `chat:${entry.topicId}:${entry.tool}:${entry.envId}`;
      const activeHandoff = this.#computerHandoffs.get(handoffKey);
      const handoffActiveForSession = Boolean(activeHandoff && activeHandoff.sessionId === entry.sessionId);
      sessions.push({
        id: createHash("sha256").update(previewKey).digest("hex"),
        ticketId: handoffKey,
        tool: entry.tool,
        envId: env.id,
        deviceName: env.name,
        title: topic.title?.trim() || (entry.tool === "browser" ? "主对话浏览器" : "主对话桌面"),
        ...(entry.app ? { app: entry.app } : {}),
        ...(handoffActiveForSession && activeHandoff
          ? {
              handoff: {
                requestId: activeHandoff.requestId,
                ...(activeHandoff.cardId ? { cardId: activeHandoff.cardId } : {}),
                reason: activeHandoff.reason,
                target: activeHandoff.tool,
                expiresAt: activeHandoff.expiresAt,
                ...(activeHandoff.url ? { url: activeHandoff.url } : {}),
                ...(activeHandoff.app ? { app: activeHandoff.app } : {}),
                interactive: entry.tool === "browser",
              },
            }
          : {}),
      });
    }
    return sessions.slice(0, 16);
  }

  #findPreviewTarget(id: string): { handoffKey: string; envId: string; tool: "browser" | "desktop"; sessionId: string } | undefined {
    for (const [key, session] of this.#computerSessions) {
      if (createHash("sha256").update(key).digest("hex") === id) {
        return { handoffKey: session.ticketId, envId: session.envId, tool: session.tool, sessionId: session.sessionId };
      }
    }
    for (const entry of this.#orchestratorSessions.values()) {
      const previewKey = `chat:${entry.topicId}:${entry.tool}:${entry.sessionId}`;
      if (createHash("sha256").update(previewKey).digest("hex") === id) {
        return {
          handoffKey: `chat:${entry.topicId}:${entry.tool}:${entry.envId}`,
          envId: entry.envId,
          tool: entry.tool,
          sessionId: entry.sessionId,
        };
      }
    }
    return undefined;
  }

  async subscribeComputerPreview(
    id: string,
    topicId: string,
    listener: (update: ComputerPreviewUpdate) => void,
  ): Promise<() => void> {
    if (!(await this.listComputerPreviews(topicId)).some((session) => session.id === id)) {
      throw new Error("操作预览已失效。");
    }
    const session = this.#findPreviewTarget(id);
    if (!session) throw new Error("操作预览已失效。");
    let closed = false;
    let unsubscribe = () => {};
    let latest: ComputerPreviewUpdate | undefined;
    let checking = false;
    const dispose = () => { if (!closed) { closed = true; latest = undefined; unsubscribe(); } };
    // Authorize each delivered frame against the current epoch, including subagent and task stops.
    const flush = async () => {
      checking = true;
      try {
        while (!closed && latest) {
          const authorized = (await this.listComputerPreviews(topicId)).some((view) => view.id === id);
          if (closed) break;
          if (!authorized) { listener({ state: "closed" }); dispose(); break; }
          const update = latest;
          latest = undefined;
          listener(update);
        }
      } catch {
        if (!closed) listener({ state: "unavailable", message: "操作预览暂不可用。" });
        dispose();
      } finally { checking = false; }
    };
    unsubscribe = this.#envManager.subscribeComputerPreview(
      session.envId,
      { tool: session.tool, sessionId: session.sessionId },
      (update) => {
        if (closed) return;
        latest = update;
        if (!checking) void flush();
      },
    );
    if (closed) unsubscribe();
    return dispose;
  }

  async sendComputerPreviewInput(
    id: string,
    topicId: string,
    event: ComputerPreviewInputEvent,
  ): Promise<boolean> {
    const rt = this.#requireRuntime();
    if (rt.runtimeGates.isClosed()) return false;
    const previews = await this.listComputerPreviews(topicId);
    const view = previews.find((item) => item.id === id);
    if (!view?.handoff?.interactive || view.tool !== "browser") return false;
    const session = this.#findPreviewTarget(id);
    if (!session || !this.#computerHandoffs.hasActiveHandoff(session.handoffKey, session.sessionId)) return false;
    return this.#envManager.sendComputerPreviewInput(
      session.envId,
      { tool: "browser", sessionId: session.sessionId },
      event,
    );
  }

  async #requestComputerHandoff(
    scope: { ticketId: string; conversationId: number; runEpoch: number; envId: string },
    input: { target: "browser" | "desktop"; sessionId: string; reason: string; url?: string; app?: string },
    api: { callId: string },
    context: Context,
  ): Promise<{ requestId: string; cardId?: string; expiresAt: number }> {
    const rt = this.#requireRuntime();
    const state = await rt.harness.snapshot(KuloStateDoc, context);
    if (scope.ticketId.startsWith("chat:")) {
      if (input.target !== "browser") {
        throw new Error("主对话桌面预览目前仅支持只读观看，不能发起交互式接管。");
      }
      const topicId = scope.ticketId.split(":")[1] ?? "root";
      const topic = state?.topics?.[topicId];
      if (!topic || topic.deletedAt) throw new Error("当前会话已失效，无法发起人工接管。");
      const envDesc = this.#envManager.getEnvDescriptor(scope.envId);
      if (!envDesc?.online || !envDesc.capabilities.includes("agent-browser")) {
        throw new Error("目标设备离线或未开启浏览器操控能力。");
      }
      const now = Date.now();
      const expiresAt = now + COMPUTER_HANDOFF_TTL_MS;
      this.#touchOrchestratorSession(
        topicId,
        "browser",
        scope.conversationId,
        scope.envId,
        input.sessionId,
        undefined,
        Math.max(this.#orchestratorBrowserIdleMs, COMPUTER_HANDOFF_TTL_MS + 30_000),
      );
      const safeReason = rt.connectionManager.redact(input.reason);
      const built = buildComputerHandoffCard({
        target: "browser", deviceName: envDesc.name, reason: safeReason, url: input.url,
      });
      const fingerprint = computerHandoffFingerprint({
        ticketId: scope.ticketId, runEpoch: scope.runEpoch, target: "browser", sessionId: input.sessionId, reason: safeReason,
      });
      const { confirmation } = await rt.actionConfirmations.ensurePendingCard({
        conversationId: scope.conversationId, topicId, ticketId: scope.ticketId,
        callId: api.callId, kind: "computer_handoff", fingerprint, cardInput: built.input, logicalIds: built.logicalIds,
        payload: {
          kind: "computer_handoff", ticketId: scope.ticketId, runEpoch: scope.runEpoch, envId: scope.envId,
          target: "browser", sessionId: input.sessionId, reason: safeReason,
          ...(input.url ? { url: input.url } : {}), expiresAt,
        },
      }, context);
      this.#computerHandoffs.register({
        requestId: confirmation.id, ...(confirmation.cardId ? { cardId: confirmation.cardId } : {}),
        ticketId: scope.ticketId, runEpoch: scope.runEpoch, envId: scope.envId, tool: "browser",
        sessionId: input.sessionId, conversationId: scope.conversationId, originConversationId: scope.conversationId,
        reason: safeReason, ...(input.url ? { url: input.url } : {}), expiresAt,
      }, async () => { await this.resolveComputerHandoff(scope.ticketId, "expired"); });
      return { requestId: confirmation.id, ...(confirmation.cardId ? { cardId: confirmation.cardId } : {}), expiresAt };
    }
    const ticket = state?.tickets[scope.ticketId];
    if (!ticket || ticket.status !== "running" || ticket.runEpoch !== scope.runEpoch) {
      throw new Error("当前任务已不在运行中，无法发起人工接管。");
    }
    const envDesc = this.#envManager.getEnvDescriptor(scope.envId);
    if (!envDesc?.online || !envDesc.capabilities.includes(`agent-${input.target}`)) {
      throw new Error("目标设备离线或未开启对应电脑操控能力。");
    }
    const now = Date.now();
    const expiresAt = now + COMPUTER_HANDOFF_TTL_MS;
    const originConversationId = ticket.originConversationId ?? rt.getRootConversationId();
    const key = `${scope.ticketId}:${input.target}:${input.sessionId}`;
    if (!this.#computerSessions.has(key)) {
      this.#computerSessions.set(key, {
        ticketId: scope.ticketId, envId: scope.envId, tool: input.target, sessionId: input.sessionId,
        conversationId: scope.conversationId, runEpoch: scope.runEpoch, ...(input.app ? { app: input.app } : {}),
      });
    }
    const safeReason = rt.connectionManager.redact(input.reason);
    const built = buildComputerHandoffCard({
      target: input.target, deviceName: envDesc.name, reason: safeReason, url: input.url, app: input.app,
    });
    const fingerprint = computerHandoffFingerprint({
      ticketId: scope.ticketId, runEpoch: scope.runEpoch, target: input.target, sessionId: input.sessionId, reason: safeReason,
    });
    const { confirmation } = await rt.actionConfirmations.ensurePendingCard({
      conversationId: originConversationId, topicId: ticket.originTopicId ?? "root", ticketId: scope.ticketId,
      callId: api.callId, kind: "computer_handoff", fingerprint, cardInput: built.input, logicalIds: built.logicalIds,
      payload: {
        kind: "computer_handoff", ticketId: scope.ticketId, runEpoch: scope.runEpoch, envId: scope.envId,
        target: input.target, sessionId: input.sessionId, reason: safeReason,
        ...(input.url ? { url: input.url } : {}), ...(input.app ? { app: input.app } : {}), expiresAt,
      },
    }, context);
    this.#computerHandoffs.register({
      requestId: confirmation.id, ...(confirmation.cardId ? { cardId: confirmation.cardId } : {}),
      ticketId: scope.ticketId, runEpoch: scope.runEpoch, envId: scope.envId, tool: input.target,
      sessionId: input.sessionId, conversationId: scope.conversationId, originConversationId,
      reason: safeReason, ...(input.url ? { url: input.url } : {}), ...(input.app ? { app: input.app } : {}), expiresAt,
    }, async () => { await this.resolveComputerHandoff(scope.ticketId, "expired"); });
    // Silent park (`waiting.reason = "user"` WITHOUT `latestReport.state = "blocked"`) avoids duplicate coordinator card
    await rt.harness.commit(async (tx) => {
      const live = (await tx.doc(KuloStateDoc)).tickets[scope.ticketId];
      if (!live || live.status !== "running" || live.runEpoch !== scope.runEpoch) return;
      live.waiting = {
        reason: "user", since: now, detail: safeReason,
        waitToken: `computer-handoff:${confirmation.cardId ?? confirmation.id}`,
        ...(confirmation.cardId ? { cardId: confirmation.cardId } : {}),
        requestId: confirmation.id,
        options: [
          { id: "confirm", label: "已完成，请继续", tone: "primary" },
          { id: "cancel", label: "跳过并停止", tone: "secondary", action: "stop" },
        ],
      };
      live.updatedAt = now;
    }, context);
    await rt.runtimeGates.broadcastTickets(context);
    return { requestId: confirmation.id, ...(confirmation.cardId ? { cardId: confirmation.cardId } : {}), expiresAt };
  }

  async resolveComputerHandoff(
    ticketId: string,
    action: "done" | "cancel" | "expired",
    manualInstruction?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ ok: boolean; status: string }> {
    const rt = this.#requireRuntime();
    const active = this.#computerHandoffs.clear(ticketId);
    if (ticketId.startsWith("chat:")) {
      const parts = ticketId.split(":");
      const topicId = parts[1] ?? "root";
      const tool: "browser" | "desktop" = parts[2] === "desktop" ? "desktop" : "browser";
      const requestId = active?.requestId;
      const pending = requestId ? await rt.actionConfirmations.getById(requestId, context) : undefined;
      const wasPending = Boolean(pending && (pending.status === "pending" || pending.status === "pending_orchestrator"));
      if (wasPending && pending) {
        await rt.actionConfirmations.resolveProgrammatically(pending.id, {
          status: action === "done" ? "approved" : "denied",
          selectedChoiceId: action === "done" ? "confirm" : "cancel",
          resultSummary: action === "done" ? "已完成人工接管" : action === "cancel" ? "已跳过人工接管" : "人工接管已超时",
          markExecuted: true,
        }, context);
      }
      const existing = this.#orchestratorSessions.get(`${topicId}:${tool}`);
      if (action === "done" && existing) {
        this.#touchOrchestratorSession(topicId, tool, existing.conversationId, existing.envId, existing.sessionId, existing.app);
      } else if (action !== "done" && existing) {
        await this.#closeOrchestratorEntry(existing, false);
      }
      // Wake Main Chat when settled via Preview Modal HTTP API or timeout (chat-card path already delivers its own wakeup).
      const wakeConvId = active?.conversationId ?? pending?.conversationId ?? existing?.conversationId;
      if (wasPending && pending && wakeConvId !== undefined) {
        const conv = await rt.harness.conversation(wakeConvId as ConversationId, context);
        if (conv) {
          const safeNote = manualInstruction?.trim() ? rt.connectionManager.redact(manualInstruction.trim()) : undefined;
          const resumeText = formatComputerHandoffResumePrompt({
            action,
            target: tool,
            reason: active?.reason ?? "人工接管操作",
            manualInstruction: safeNote,
          });
          await rt.harness.commit(
            (tx) =>
              submitAutomaticChatInput(tx, conv, {
                type: "input",
                requestId: `computer-handoff:${pending.id}:${action}`,
                content: resumeText,
                entry: {
                  kind: CoordinatorEventEntry.kind,
                  data: { eventKind: "user_task_instruction", createdAt: Date.now() } as unknown as JsonObject,
                },
              }),
            context,
          );
          rt.runtimeGates.resumeIfNotRecovering();
        }
      }
      return { ok: true, status: action };
    }
    const state = await rt.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    const requestId = active?.requestId ?? ticket?.waiting?.requestId;
    if (action === "cancel") {
      const stopReason = "用户跳过人工接管并停止任务";
      if (ticket && canDirectStopTicket(ticket)) {
        await rt.stopTicket(ticketId, stopReason, context, `computer-handoff:${requestId ?? ticketId}:cancel`);
      } else {
        await rt.actionConfirmations.settlePendingForTicket(ticketId, "已跳过人工接管", undefined, context);
        await this.#forceCloseTicketSessions(ticketId);
      }
      return { ok: true, status: action };
    }
    const pending = requestId ? await rt.actionConfirmations.getById(requestId, context) : undefined;
    const payload = pending?.payload.kind === "computer_handoff" ? pending.payload : undefined;
    const target = active?.tool ?? payload?.target ?? "browser";
    const reason = active?.reason ?? payload?.reason ?? "人工接管操作";
    if (pending && (pending.status === "pending" || pending.status === "pending_orchestrator")) {
      await rt.actionConfirmations.resolveProgrammatically(pending.id, {
        status: action === "done" ? "approved" : "denied",
        selectedChoiceId: action === "done" ? "confirm" : "cancel",
        resultSummary: action === "done" ? "已完成人工接管" : "人工接管已超时",
        markExecuted: true,
      }, context);
    }
    if (action !== "done") {
      // Immediately close preserved session to release MAX_BROWSER_SESSIONS slot
      await this.#forceCloseTicketSessions(ticketId);
    }
    if (ticket && ticket.status === "waiting") {
      const prompt = formatComputerHandoffResumePrompt({ action, target, reason, manualInstruction });
      await rt.steerTicket({
        ticketId,
        commandId: `computer-handoff:${requestId ?? ticketId}:${action}`,
        text: prompt,
      }, context).catch(() => {});
    }
    return { ok: true, status: action };
  }

  async #forceCloseTicketSessions(ticketId: string): Promise<void> {
    const sessions = [...this.#computerSessions].filter(([, s]) => s.ticketId === ticketId);
    for (const [key, session] of sessions) {
      this.#computerSessions.delete(key);
      await this.#envManager
        .requestComputerUse(session.envId, { tool: session.tool, action: "close", sessionId: session.sessionId })
        .catch(() => {});
    }
  }

  buildTicketSessionCleanupTasks(ticketId: string, options: { park?: boolean } = {}): Array<Promise<void>> {
    if (!options.park) this.#computerHandoffs.clear(ticketId);
    const sessions = [...this.#computerSessions].filter(
      ([, session]) =>
        session.ticketId === ticketId &&
        !(options.park && this.#computerHandoffs.hasActiveHandoff(ticketId, session.sessionId)),
    );
    return sessions.map(async ([key, session]) => {
      const result = await this.#envManager.requestComputerUse(session.envId, {
        tool: session.tool,
        action: "close",
        sessionId: session.sessionId,
      });
      if (!result.ok) throw new Error("任务的电脑操作会话尚未关闭。");
      this.#computerSessions.delete(key);
    });
  }

  #touchOrchestratorSession(
    topicId: string,
    tool: "browser" | "desktop",
    conversationId: number,
    envId: string,
    sessionId: string,
    app?: string,
    idleMs = this.#orchestratorBrowserIdleMs,
  ): void {
    const key = `${topicId}:${tool}`;
    const prev = this.#orchestratorSessions.get(key);
    if (prev) clearTimeout(prev.idleTimer);
    const handoffKey = `chat:${topicId}:${tool}:${envId}`;
    const idleTimer = setTimeout(() => {
      if (this.#runtime?.runtimeGates.isClosed()) return;
      if (this.#computerHandoffs.hasActiveHandoff(handoffKey, sessionId)) return;
      const live = this.#orchestratorSessions.get(key);
      if (live && live.sessionId === sessionId) void this.#closeOrchestratorEntry(live, false);
    }, idleMs);
    idleTimer.unref?.();
    this.#orchestratorSessions.set(key, {
      topicId,
      conversationId,
      envId,
      tool,
      sessionId,
      ...(app ?? prev?.app ? { app: app ?? prev?.app } : {}),
      idleTimer,
    });
  }

  #forgetOrchestratorSession(topicId: string, tool: "browser" | "desktop", sessionId?: string): void {
    const key = `${topicId}:${tool}`;
    const existing = this.#orchestratorSessions.get(key);
    if (!existing) return;
    if (sessionId && existing.sessionId !== sessionId) return;
    clearTimeout(existing.idleTimer);
    this.#orchestratorSessions.delete(key);
    this.#computerHandoffs.clear(`chat:${topicId}:${tool}:${existing.envId}`);
  }

  async closeOrchestratorBrowserSession(topicId: string, allowDuringClose = false): Promise<void> {
    for (const tool of ["browser", "desktop"] as const) {
      const existing = this.#orchestratorSessions.get(`${topicId}:${tool}`);
      if (existing) await this.#closeOrchestratorEntry(existing, allowDuringClose);
    }
  }

  async closeOrchestratorBrowserSessionByConversation(conversationId: number, allowDuringClose = false): Promise<void> {
    const matching = [...this.#orchestratorSessions.values()].filter((s) => s.conversationId === conversationId);
    for (const entry of matching) await this.#closeOrchestratorEntry(entry, allowDuringClose);
  }

  async #closeOrchestratorEntry(existing: OrchestratorComputerSession, allowDuringClose: boolean): Promise<void> {
    const key = `${existing.topicId}:${existing.tool}`;
    if (this.#orchestratorSessions.get(key) === existing) {
      this.#orchestratorSessions.delete(key);
    }
    clearTimeout(existing.idleTimer);
    this.#computerHandoffs.clear(`chat:${existing.topicId}:${existing.tool}:${existing.envId}`);
    const isClosed = this.#runtime?.runtimeGates.isClosed() ?? false;
    if ((!isClosed || allowDuringClose) && this.#envManager.getEnvDescriptor(existing.envId)?.online) {
      await this.#envManager
        .requestComputerUse(existing.envId, { tool: existing.tool, action: "close", sessionId: existing.sessionId })
        .catch(() => {});
    }
  }

  async closeOrchestratorBrowserSessionsForEnv(envId: string, sendClose = true): Promise<void> {
    const matching = [...this.#orchestratorSessions.values()].filter((s) => s.envId === envId);
    const isClosed = this.#runtime?.runtimeGates.isClosed() ?? false;
    for (const entry of matching) {
      clearTimeout(entry.idleTimer);
      this.#orchestratorSessions.delete(`${entry.topicId}:${entry.tool}`);
      this.#computerHandoffs.clear(`chat:${entry.topicId}:${entry.tool}:${entry.envId}`);
      if (sendClose && !isClosed && this.#envManager.getEnvDescriptor(envId)?.online) {
        await this.#envManager
          .requestComputerUse(envId, { tool: entry.tool, action: "close", sessionId: entry.sessionId })
          .catch(() => {});
      }
    }
  }

  async closeAllOrchestratorBrowserSessions(): Promise<void> {
    for (const entry of [...this.#orchestratorSessions.values()]) {
      await this.#closeOrchestratorEntry(entry, true);
    }
  }

  closeAllHandoffs(): void {
    this.#computerHandoffs.closeAll();
  }
}
