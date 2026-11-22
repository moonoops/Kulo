import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import type {
  AgentExpressionState,
  HindsightMemoryConfig,
  KuloLanguage,
  ModelGatewayConfig,
  RolePreset,
  TicketOutwardAction,
} from "@kulo/protocol";
import { chatRoutingData } from "./chat-submissions.js";
import { DEFAULT_COMPACTION_CONFIG, type KuloHubConfig } from "./config.js";
import type { PriorUserDeviceTurn } from "./env-routing-policy.js";
import { resolveEffectiveIdentityDir, type KuloDurableSettings } from "./settings.js";
import {
  WorkerRecoveryEntry,
  WorkerRelayEntry,
  WorkerWatchdogEntry,
  isRecoveryInputBoundary,
  type WorkerRecoveryEntryData,
} from "./state.js";
import { KuloUserEntry } from "./ui-cards.js";

export interface LiveSettingsReplaceResult {
  applied: boolean;
  oldIdentityDir: string;
  newIdentityDir: string;
  oldAuthFile?: string;
  newAuthFile?: string;
  protectedPathsChanged: boolean;
}

/**
 * Single source of truth for live Hub settings across both pre-hydration
 * bootstrap hooks (before Harness.open) and post-hydration runtime updates.
 */
export class LiveSettingsStore {
  readonly #config: KuloHubConfig;
  readonly #defaultIdentityDir: string;
  #current: KuloDurableSettings | null = null;

  constructor(config: KuloHubConfig, defaultIdentityDir: string) {
    this.#config = config;
    this.#defaultIdentityDir = defaultIdentityDir;
  }

  get defaultIdentityDir(): string {
    return this.#defaultIdentityDir;
  }

  peek(): KuloDurableSettings | null {
    return this.#current;
  }

  get(): KuloDurableSettings {
    if (!this.#current) {
      throw new Error("LiveSettingsStore accessed before settings hydration.");
    }
    return this.#current;
  }

  hydrate(doc: KuloDurableSettings): KuloDurableSettings {
    this.#current = doc;
    return this.#current;
  }

  replace(nextDoc: KuloDurableSettings): LiveSettingsReplaceResult {
    const oldIdentityDir = this.getIdentityDir();
    const oldAuthFile = this.#current?.memory.authFile;
    if (this.#current && nextDoc.globalRevision < this.#current.globalRevision) {
      return {
        applied: false,
        oldIdentityDir,
        newIdentityDir: oldIdentityDir,
        oldAuthFile,
        newAuthFile: oldAuthFile,
        protectedPathsChanged: false,
      };
    }
    if (!this.#current) {
      this.#current = nextDoc;
    } else {
      for (const key of Object.keys(this.#current)) {
        if (!Object.hasOwn(nextDoc, key)) {
          delete (this.#current as unknown as Record<string, unknown>)[key];
        }
      }
      Object.assign(this.#current, nextDoc);
    }
    const newIdentityDir = this.getIdentityDir();
    const newAuthFile = this.#current.memory.authFile;
    return {
      applied: true,
      oldIdentityDir,
      newIdentityDir,
      oldAuthFile,
      newAuthFile,
      protectedPathsChanged:
        oldIdentityDir !== newIdentityDir || oldAuthFile !== newAuthFile,
    };
  }

  setExpression(expression: AgentExpressionState | null): void {
    if (this.#current) {
      this.#current.expression = expression;
    }
  }

  getModel(): ModelGatewayConfig {
    return this.#current?.model ?? this.#config.model;
  }

  getCompactionConfig(): NonNullable<ModelGatewayConfig["compaction"]> {
    return (
      this.#current?.model.compaction ??
      this.#config.model.compaction ??
      DEFAULT_COMPACTION_CONFIG
    );
  }

  getRoles(): Record<string, RolePreset> {
    return this.#current?.roles ?? this.#config.roles;
  }

  getMemory(): HindsightMemoryConfig {
    return this.#current?.memory ?? this.#config.memory;
  }

  getIdentityDir(): string {
    return this.#current
      ? resolveEffectiveIdentityDir(this.#current, this.#defaultIdentityDir)
      : this.#defaultIdentityDir;
  }

  getIdentityDirectoryRevision(): number {
    return this.#current?.identity.directoryRevision ?? 1;
  }

  getMaxConcurrentWorkers(): number {
    return (
      this.#current?.executor.maxConcurrentWorkers ??
      this.#config.maxConcurrentWorkers
    );
  }

  getMaxSubagentsPerTicket(): number {
    return (
      this.#current?.executor.maxSubagentsPerTicket ??
      this.#config.maxSubagentsPerTicket
    );
  }

  getAgentName(): string {
    return (
      this.#current?.presentation.agentName ??
      this.#config.presentation.agentName
    );
  }

  getLanguage(): KuloLanguage | undefined {
    return (
      this.#current?.presentation.language ??
      this.#config.presentation.language
    );
  }

  getExternalClients(): NonNullable<KuloDurableSettings["externalClients"]> {
    return this.#current?.externalClients ?? {};
  }

  getProtectedSettingsPaths(): string[] {
    const out: string[] = [];
    if (this.#current?.identity.directory) {
      out.push(this.#current.identity.directory);
    }
    if (this.#current?.memory.authFile) {
      out.push(path.resolve(this.#current.memory.authFile));
    }
    return out;
  }
}

/**
 * Shared wakeup registry for inline dispatch waiters (used across ticket
 * dispatch, host actions, scheduler hooks, and shutdown teardown).
 */
export class InlineDispatchWaiters {
  readonly #waiters = new Map<string, Set<() => void>>();

  notify(ticketId: string): void {
    const waiters = this.#waiters.get(ticketId);
    if (!waiters) return;
    this.#waiters.delete(ticketId);
    for (const wake of waiters) {
      try {
        wake();
      } catch {
        // Ignore individual listener errors
      }
    }
  }

  notifyAll(): void {
    for (const id of [...this.#waiters.keys()]) {
      this.notify(id);
    }
  }

  wait(params: {
    ticketId: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    isClosed: () => boolean;
    shouldWakeImmediately: () => Promise<boolean>;
  }): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        params.abortSignal?.removeEventListener("abort", finish);
        const set = this.#waiters.get(params.ticketId);
        if (set) {
          set.delete(finish);
          if (set.size === 0) this.#waiters.delete(params.ticketId);
        }
        resolve();
      };
      const timer = setTimeout(finish, params.timeoutMs);
      timer.unref?.();
      let set = this.#waiters.get(params.ticketId);
      if (!set) {
        set = new Set();
        this.#waiters.set(params.ticketId, set);
      }
      set.add(finish);
      if (params.abortSignal?.aborted || params.isClosed()) {
        finish();
        return;
      }
      params.abortSignal?.addEventListener("abort", finish, { once: true });
      // Re-check snapshot after registering waiter so we cannot miss an immediate completion.
      void params
        .shouldWakeImmediately()
        .then((wakeNow) => {
          if (wakeNow) finish();
        })
        .catch(() => finish());
    });
  }
}

/**
 * Read-only helper for inspecting the orchestrator's current control input,
 * recovery guard, and prior user device turns at the exact tool-task boundary.
 */
export class TurnContextReader {
  readonly #harness: Harness;

  constructor(harness: Harness) {
    this.#harness = harness;
  }

  async currentControlInputs(
    conversationId: number | undefined,
    context: Context,
    toolTaskId?: number,
  ): Promise<EntryRecord[]> {
    if (conversationId === undefined) return [];
    const conversation = await this.#harness.conversation(
      conversationId as ConversationId,
      context,
    );
    let assistant: EntryId | undefined;
    if (toolTaskId !== undefined) {
      let next = toolTaskId;
      for (let depth = 0; depth < 16; depth++) {
        const task = await this.#harness.commit(
          (tx) => tx.task(next as never),
          context,
        );
        const input = task?.input as
          | { kind?: string; assistant?: number; parent?: number }
          | undefined;
        if (input?.kind === "model" && input.assistant !== undefined) {
          assistant = input.assistant as EntryId;
          break;
        }
        if (input?.kind !== "nested" || input.parent === undefined) {
          throw new Error("无法核对主脑工具的任务上下文。");
        }
        next = input.parent;
      }
      if (assistant === undefined) {
        throw new Error("主脑工具嵌套层级超出上下文核对范围。");
      }
    }
    const entries = conversation
      ? (
          await conversation.context(
            context,
            assistant === undefined ? undefined : { at: assistant },
          )
        ).entries
      : [];
    const inputs: EntryRecord[] = [];
    for (const entry of [...entries].reverse()) {
      if (inputs.length && AssistantEntry.is(entry)) break;
      if (!isRecoveryInputBoundary(entry)) continue;
      if (
        WorkerRelayEntry.is(entry) ||
        WorkerRecoveryEntry.is(entry) ||
        WorkerWatchdogEntry.is(entry)
      ) {
        return inputs.length ? inputs : [entry];
      }
      inputs.push(entry);
    }
    return inputs;
  }

  async currentControlInput(
    conversationId: number | undefined,
    context: Context,
    toolTaskId?: number,
  ): Promise<EntryRecord | undefined> {
    return (
      await this.currentControlInputs(conversationId, context, toolTaskId)
    )[0];
  }

  async currentRecoveryGuard(
    conversationId: number | undefined,
    context: Context,
    toolTaskId?: number,
  ): Promise<WorkerRecoveryEntryData | undefined> {
    const input = await this.currentControlInput(
      conversationId,
      context,
      toolTaskId,
    );
    return input && WorkerRecoveryEntry.is(input) ? input.data : undefined;
  }

  async recentPriorUserTurns(
    conversationId: number | undefined,
    context: Context,
    toolTaskId: number | undefined,
    excludeIds: ReadonlySet<EntryId>,
    limit = 12,
  ): Promise<PriorUserDeviceTurn[]> {
    if (conversationId === undefined) return [];
    const conversation = await this.#harness.conversation(
      conversationId as ConversationId,
      context,
    );
    if (!conversation) return [];
    let assistant: EntryId | undefined;
    if (toolTaskId !== undefined) {
      let next = toolTaskId;
      for (let depth = 0; depth < 16; depth++) {
        const task = await this.#harness.commit(
          (tx) => tx.task(next as never),
          context,
        );
        const input = task?.input as
          | { kind?: string; assistant?: number; parent?: number }
          | undefined;
        if (input?.kind === "model" && input.assistant !== undefined) {
          assistant = input.assistant as EntryId;
          break;
        }
        if (input?.kind !== "nested" || input.parent === undefined) break;
        next = input.parent;
      }
    }
    const entries = (
      await conversation.context(
        context,
        assistant === undefined ? undefined : { at: assistant },
      )
    ).entries;
    const turns: PriorUserDeviceTurn[] = [];
    for (const entry of [...entries].reverse()) {
      if (excludeIds.has(entry.id)) continue;
      if (!KuloUserEntry.is(entry)) continue;
      const routing = chatRoutingData(entry);
      turns.push({
        text: routing.text,
        targetDeviceId: routing.targetDeviceId || undefined,
        sourceDeviceId: routing.source?.deviceId,
      });
      if (turns.length >= limit) break;
    }
    return turns;
  }
}

/**
 * Shared narrow runtime gates passed into outer subdomain coordinators so
 * every coordinator observes unified lifecycle/handover/resume semantics
 * without holding back-references to KuloHub.
 */
export interface HubRuntimeGates {
  isClosed: () => boolean;
  isRecovering: () => boolean;
  isHandoverBarrierActive: () => boolean;
  resumeIfNotRecovering: () => void;
  broadcastTickets: (context: Context) => Promise<void>;
  recordTicketOutwardAction: (
    ticketId: string,
    runEpoch: number | undefined,
    kind: TicketOutwardAction["kind"],
    label: string,
    context?: Context,
  ) => Promise<void>;
}
