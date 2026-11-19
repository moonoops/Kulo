import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import {
  CompactionTask, GenerationTask, UsageDoc, defineDoc, defineEntry, defineExtension, defineTask, hook,
  type CompactionHooks, type ConversationId, type EntryId, type EntryRecord, type Harness, type HookApi,
  type JsonObject, type SubmissionId, type TaskId, type TaskRuntime, type Tx,
} from "@earendil-works/pi-durable";
import type { CompressionBlock, CompressionCore, CompressionState, Config, CoreMessage } from "acp-kernel";
import { BILLION_SUMMARY_SYSTEM } from "./prompts.js";

/** Only the reviewed library surface is passed through the managed extension boundary. */
export interface BillionKernel {
  createCore: (ports?: { countTokens?: (text: string) => number }) => CompressionCore;
  createInitialState: () => CompressionState;
  defaultConfig: (limit: number, overrides?: Partial<Config>) => Config;
  assignRefs: (messages: CoreMessage[], options: {
    existing: CompressionState["messageRefs"]; nextIndex: number;
  }) => { map: CompressionState["messageRefs"]; nextIndex: number; newlyAssigned: number };
  prune: (messages: CoreMessage[], state: CompressionState) => CoreMessage[];
}
export interface BillionKernelRuntime { version: string; kernel: BillionKernel }

export function validateBillionKernel(value: Record<string, unknown>): BillionKernel {
  for (const key of ["createCore", "createInitialState", "defaultConfig", "assignRefs", "prune"]) {
    if (typeof value[key] !== "function") throw new Error(`上下文压缩内核缺少 ${key}。`);
  }
  return value as unknown as BillionKernel;
}

interface SourceChunk { messages: CoreMessage[]; entryIds: number[] }
interface SummaryInput {
  parentTaskId: number; epoch: number; firstKept: number; sourceHash: string; kernelVersion: string;
  model: { provider: string; modelId: string }; contextWindow: number; reserveTokens: number;
  chunks: SourceChunk[]; instructions: string; sourceChars: number; summaryChars: number; cached: Array<{ index: number; summary: string }>;
}
interface SummaryResult {
  summary: string; blocks: CompressionBlock[]; sourceChunks: Array<{ entryIds: number[]; messageIds: string[] }>;
}
type SummaryCheckpoint = {
  summaries: string[]; levels: string[][]; next: string[]; attempt: number;
} & ({ phase: "summarize" } | { phase: "reduce" } | { phase: "fold" }
  | { phase: "retry"; until: number; retryPhase: "summarize" | "reduce" });
interface CompactionJob {
  taskId: number; compactionTaskId: number; epoch: number; firstKept: number; sourceHash: string; kernelVersion: string;
  status: "pending" | "committed" | "superseded" | "failed";
  checkpointEntryId?: number; archiveEntryId?: number; error?: string;
}
interface ContextCompactionState {
  enabled: boolean; epoch: number; kernelVersion: string | null; lastError: string | null;
  jobs: Record<string, CompactionJob>;
  active: { epoch: number; checkpointEntryId: number; blockCount: number; kernelVersion: string } | null;
}
export const ContextCompactionDoc = defineDoc<ContextCompactionState & JsonObject>({
  kind: "kulo.context-compaction", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ enabled: false, epoch: 0, kernelVersion: null, lastError: null, jobs: {}, active: null }) as ContextCompactionState & JsonObject,
  checkpointWhen: () => true,
});
export const ContextBlocksEntry = defineEntry<JsonObject>("kulo.context-blocks");

export interface ContextCompactionOptions {
  getHarness: () => Harness;
  getKernel: () => Promise<BillionKernelRuntime | null>;
  isActive?: () => boolean;
  getReserveTokens?: (conversationId: ConversationId) => number;
  /** Invoked when compaction selects a checkpoint boundary so idle deferred/event tools can be pruned cleanly. */
  onCompactionBaseline?: (conversationId: ConversationId, firstKept: number, context: Context) => Promise<void>;
  /** A small source budget is useful for exercising multi-block checkpoints without a paid model. */
  maxSourceChars?: number;
}

const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const textContent = (message: Message): string => {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "toolCall") return [`[tool call ${part.name} ${part.id}] ${JSON.stringify(part.arguments)}`];
    if (part.type === "image") return ["[image attachment; original retained in conversation]"];
    return [];
  }).join("\n");
};

function sourceChunks(entries: readonly EntryRecord[], messages: readonly Message[], maxChars: number): SourceChunk[] {
  // Native range selection already protects the recent tail and tool-call/result boundary. These are textual
  // source records for the summarizer, never provider protocol messages or executable historical tool calls.
  const cores: Array<{ core: CoreMessage; entryIds: number[] }> = [];
  const owners = new Map<string, { ids: number[]; cursor: number }>();
  const selectedIds = entries.map((entry) => Number(entry.id));
  for (const entry of entries) for (const message of entry.model ?? []) {
    const key = JSON.stringify(message);
    const owner = owners.get(key) ?? { ids: [], cursor: 0 }; owner.ids.push(Number(entry.id)); owners.set(key, owner);
  }
  for (const [index, message] of messages.entries()) {
    if (message.role === "system") continue;
    const text = `[${message.role}] ${textContent(message)}`;
    if (!text.trim()) continue;
    const encoded = JSON.stringify(message);
    const match = owners.get(encoded);
    const owner = match ? match.ids[match.cursor++] : undefined;
    // An edit may replace a message without changing the original entry. Keep the selected range as provenance,
    // and summarize the edited contribution supplied by Durable, never the entry's stale original model payload.
    const entryIds = owner === undefined ? selectedIds : [owner];
    for (let offset = 0, part = 0; offset < text.length; offset += maxChars, part++) {
      cores.push({ entryIds, core: {
        id: `entry-${entryIds[0]}.message-${index}.part-${part}`, role: message.role === "assistant" ? "assistant" : "user",
        contentType: "text", text: text.slice(offset, offset + maxChars),
      } });
    }
  }
  const chunks: SourceChunk[] = [];
  let size = 0;
  for (const { core, entryIds } of cores) {
    if (!chunks.length || size + (core.text?.length ?? 0) > maxChars) {
      chunks.push({ messages: [], entryIds: [] }); size = 0;
    }
    const chunk = chunks[chunks.length - 1]!;
    chunk.messages.push(core);
    for (const entryId of entryIds) if (!chunk.entryIds.includes(entryId)) chunk.entryIds.push(entryId);
    size += core.text?.length ?? 0;
  }
  return chunks;
}

const SUMMARY_SYSTEM = BILLION_SUMMARY_SYSTEM;
function reduceGroups(summaries: string[], maxChars: number): string[][] {
  const groups: string[][] = [];
  let size = 0;
  for (const summary of summaries) {
    if (!groups.length || size + summary.length + 32 > maxChars) { groups.push([]); size = 0; }
    groups[groups.length - 1]!.push(summary); size += summary.length + 32;
  }
  return groups;
}
function prompt(input: SummaryInput, phase: "summarize" | "reduce", point: SummaryCheckpoint): string {
  const layer = point.levels[point.levels.length - 1] ?? point.summaries;
  const source = phase === "reduce" ? reduceGroups(layer, input.sourceChars)[point.next.length]!.map((summary, i) => `[Block ${i + 1}]\n${summary}`).join("\n\n")
    : input.chunks[point.summaries.length]!.messages.map((message) => `[${message.id}]\n${message.text}`).join("\n\n");
  const topLevelHint = (phase === "reduce" || input.chunks.length === 1) && input.summaryChars >= 240 && !input.instructions
    ? "Keep active/waiting ticket IDs and published vs. pending-review asset_ids verbatim when present."
    : input.instructions;
  return `Summarize this ${phase === "reduce" ? "set of block summaries into one layered checkpoint" : "historical block"}. Preserve earlier summary information and newer corrections. Use at most ${input.summaryChars} characters.${topLevelHint ? `\n${topLevelHint}` : ""}\n<records>\n${source}\n</records>`;
}

function folded(kernel: BillionKernel, input: SummaryInput, summaries: string[], reduced?: string): SummaryResult {
  const messages = input.chunks.flatMap((chunk) => chunk.messages);
  let state = kernel.createInitialState();
  state.messageRefs = kernel.assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const config = kernel.defaultConfig(input.contextWindow, { compress: { minCompressRange: 0, minSummaryLength: 1, maxSummaryLength: 0 } });
  const core = kernel.createCore();
  const ranges = input.chunks.map((chunk, i) => ({
    startRef: state.messageRefs.byRaw[chunk.messages[0]!.id]!,
    endRef: state.messageRefs.byRaw[chunk.messages[chunk.messages.length - 1]!.id]!,
    summary: summaries[i]!, topic: `Durable entries ${chunk.entryIds[0]}–${chunk.entryIds[chunk.entryIds.length - 1]}`,
  }));
  const first = core.applyCompression({ ranges, messages, state, config, protectedMessageIds: new Set() });
  if (first.result.errors.length || first.result.blocksCreated !== ranges.length) {
    throw new Error(`上下文分块压缩失败：${first.result.errors.join("；") || "内核未生成预期块"}`);
  }
  state = first.state;
  if (reduced) {
    const active = state.blocks.filter((block) => block.active);
    const second = core.applyCompression({ messages: kernel.prune(messages, state), state, config,
      ranges: [{ startRef: active[0]!.blockId, endRef: active[active.length - 1]!.blockId, summary: reduced, topic: "Durable continuation checkpoint" }], protectedMessageIds: new Set() });
    if (second.result.errors.length || second.result.blocksCreated !== 1) throw new Error(`上下文分层压缩失败：${second.result.errors.join("；")}`);
    state = second.state;
  }
  const active = state.blocks.filter((block) => block.active);
  const summary = `[KULO_CONTEXT_CHECKPOINT ${input.epoch} ${input.sourceHash}]\n` + active.map((block) => `[历史块 ${input.epoch}:${block.blockId}]\n${block.summary}`).join("\n\n");
  return { summary, blocks: clean(state.blocks), sourceChunks: input.chunks.map((chunk) => ({ entryIds: chunk.entryIds, messageIds: chunk.messages.map((message) => message.id) })) };
}

// The custom summarizer bypasses CompactionTask's model phase. Account for each returned attempt in the same
// commit as its checkpoint, so reopening cannot charge an already committed response a second time.
async function recordUsage(tx: Tx, conversationId: ConversationId, key: string, usage: Usage): Promise<void> {
  const doc = await tx.doc(UsageDoc, conversationId);
  const total = Object.hasOwn(doc.models, key) ? doc.models[key] : undefined;
  if (!total) { doc.models[key] = clean(usage); return; }
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += usage[field];
  for (const field of ["cacheWrite1h", "reasoning"] as const) if (usage[field] !== undefined) total[field] = (total[field] ?? 0) + usage[field]!;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += usage.cost[field];
}

export function createContextCompactionController(options: ContextCompactionOptions) {
  const summaryTask = defineTask<SummaryInput, SummaryCheckpoint, SummaryResult>({
    name: "kulo.context-summary", version: 1,
    initial: () => ({ phase: "summarize", summaries: [], levels: [], next: [], attempt: 1 }),
    phases: {
      retry: async (task, runtime, context) => {
        const point = task.state.checkpoint;
        if ((point.until ?? 0) > runtime.now()) return runtime.sleepUntil(point.until!, point, context);
        await runtime.commit(() => ({ status: "running", checkpoint: { ...point, phase: point.retryPhase!, attempt: point.attempt + 1 } }), context);
      },
      summarize: async (task, runtime, context) => summarize(task.input, task.state.checkpoint, runtime, context, "summarize"),
      reduce: async (task, runtime, context) => summarize(task.input, task.state.checkpoint, runtime, context, "reduce"),
      fold: async (task, runtime, context) => {
        const loaded = await options.getKernel();
        if (!loaded || loaded.version !== task.input.kernelVersion) throw new Error("上下文压缩内核版本已改变。");
        const summaries = task.state.checkpoint.summaries;
        const result = folded(loaded.kernel, task.input, summaries, task.state.checkpoint.levels.at(-1)?.[0]);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
      },
    },
    abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
  });

  async function summarize(input: SummaryInput, point: SummaryCheckpoint,
    runtime: TaskRuntime<SummaryInput, SummaryCheckpoint, SummaryResult, object>, context: Context, phase: "summarize" | "reduce"): Promise<void> {
    const cached = phase === "summarize" ? input.cached.find((item) => item.index === point.summaries.length) : undefined;
    if (cached) {
      const summaries = [...point.summaries, cached.summary];
      await runtime.commit(() => ({ status: "running", checkpoint: {
        phase: input.chunks.length === 1 ? "fold" : summaries.length < input.chunks.length ? "summarize" : "reduce",
        summaries, levels: point.levels, next: [], attempt: 1,
      } }), context);
      return;
    }
    const model = runtime.models.getModel(input.model.provider, input.model.modelId);
    if (!model) throw new Error("上下文摘要模型不可用。");
    const maxTokens = Math.max(1, Math.min(model.maxTokens || Number.MAX_SAFE_INTEGER, Math.floor(input.reserveTokens * 0.6), input.summaryChars));
    const { deferred: _deferred, ...stream } = runtime.settings.stream;
    const message = await runtime.models.completeSimple(model, { messages: [
      { role: "system", content: SUMMARY_SYSTEM, timestamp: runtime.now() },
      { role: "user", content: prompt(input, phase, point), timestamp: runtime.now() },
    ] }, { ...stream, signal: runtime.signal, maxTokens, cacheRetention: "none", telemetry: context.telemetry });
    runtime.signal.throwIfAborted();
    const rawText = summaryText(message);
    const text = rawText && rawText.length <= input.summaryChars ? rawText : undefined;
    const retry = !text && message.stopReason === "error" && isRetryableAssistantError(message) && runtime.settings.retry.enabled && point.attempt <= runtime.settings.retry.maxRetries;
    await runtime.commit(async (tx) => {
      await recordUsage(tx, runtime.conversationId, `${input.model.provider}/${input.model.modelId}`, message.usage);
      if (!text) {
        if (retry) {
          const until = runtime.now() + retryDelayMs(runtime.settings.retry, point.attempt);
          return { status: "sleeping", until, checkpoint: { ...point, phase: "retry", retryPhase: phase, until } };
        }
        return { status: "terminal", outcome: { status: "failed", error: { message: rawText && rawText.length > input.summaryChars ? "上下文摘要超出交接预算。" : message.errorMessage || `上下文摘要未完成（${message.stopReason}）。` } } };
      }
      if (phase === "summarize") {
        const summaries = [...point.summaries, text];
        const nextPhase = input.chunks.length === 1 ? "fold" : summaries.length < input.chunks.length ? "summarize" : "reduce";
        return { status: "running", checkpoint: { phase: nextPhase, summaries, levels: point.levels, next: [], attempt: 1 } };
      }
      const current = point.levels.at(-1) ?? point.summaries;
      const next = [...point.next, text];
      const complete = next.length === reduceGroups(current, input.sourceChars).length;
      return { status: "running", checkpoint: { phase: complete && next.length === 1 ? "fold" : "reduce",
        summaries: point.summaries, levels: complete ? [...point.levels, next] : point.levels, next: complete ? [] : next, attempt: 1 } };
    }, context);
  }

  async function beforeCompact(input: Parameters<CompactionHooks["beforeCompact"]>[0], api: HookApi, context: Context) {
    if (options.onCompactionBaseline) {
      await options.onCompactionBaseline(api.conversationId, Number(input.firstKept), context);
    }
    const harness = options.getHarness();
    const config = await api.snapshot(ContextCompactionDoc, api.conversationId, context);
    if (!config?.enabled || options.isActive?.() === false) return;
    const loaded = await options.getKernel();
    const agent = await (await harness.conversation(api.conversationId, context))!.agent(context);
    if (!loaded || !agent.model) return;
    const model = api.models.getModel(agent.model.provider, agent.model.modelId);
    if (!model) return;
    const reserveTokens = agent.compaction?.modelOverrides?.[`${agent.model.provider}/${agent.model.modelId}`]?.reserveTokens
      ?? agent.compaction?.reserveTokens ?? options.getReserveTokens?.(api.conversationId) ?? 16_384;
    const maxChars = Math.max(256, Math.min(options.maxSourceChars ?? 48_000, Math.floor(Math.max(256, model.contextWindow - reserveTokens - 768))));
    const chunks = sourceChunks(input.entries, input.messages, maxChars);
    if (!chunks.length) return;
    const sourceHash = createHash("sha256").update(JSON.stringify([input.firstKept, chunks])).digest("hex");
    const key = `${api.taskId}:${sourceHash}`;
    const summaryChars = Math.max(48, Math.min(Math.floor(maxChars / 4), Math.floor(reserveTokens * 0.8)));
    const instructions = (input.instructions ?? "").slice(0, 2000);
    const selected = await harness.commit(async (tx) => {
      const doc = await tx.doc(ContextCompactionDoc, api.conversationId);
      if (!doc.enabled || options.isActive?.() === false) return undefined;
      const prior = doc.jobs[key];
      if (prior) return { taskId: prior.taskId as TaskId<SummaryResult>, obsolete: [] as number[] };
      const old = Object.values(doc.jobs).filter((job) => job.compactionTaskId === Number(api.taskId) && job.status === "pending");
      const reusable = new Map<string, string>();
      for (const job of old) {
        const task = await tx.task(job.taskId as TaskId);
        if (task?.state.status !== "running" && task?.state.status !== "pending" && task?.state.status !== "sleeping") continue;
        const oldInput = task.input as unknown as SummaryInput;
        const point = task.state.checkpoint as unknown as SummaryCheckpoint;
        if (oldInput.model.provider !== agent.model!.provider || oldInput.model.modelId !== agent.model!.modelId
          || oldInput.summaryChars !== summaryChars || oldInput.instructions !== instructions) continue;
        for (const [i, summary] of point.summaries.entries()) reusable.set(JSON.stringify(oldInput.chunks[i]), summary);
      }
      const epoch = ++doc.epoch;
      const taskId = await tx.createTask(summaryTask, { parentTaskId: Number(api.taskId), epoch, firstKept: Number(input.firstKept), sourceHash,
        kernelVersion: loaded.version, model: agent.model!, contextWindow: model.contextWindow, reserveTokens, chunks,
        sourceChars: maxChars, summaryChars, instructions,
        cached: chunks.flatMap((chunk, index) => { const summary = reusable.get(JSON.stringify(chunk)); return summary ? [{ index, summary }] : []; }),
      },
      { ownership: { kind: "task", taskId: api.taskId }, conversationId: api.conversationId });
      for (const job of old) job.status = "superseded";
      doc.jobs[key] = { taskId: Number(taskId), compactionTaskId: Number(api.taskId), epoch, firstKept: Number(input.firstKept), sourceHash, kernelVersion: loaded.version, status: "pending" };
      doc.kernelVersion = loaded.version;
      const terminal = Object.keys(doc.jobs).filter((id) => doc.jobs[id]!.status !== "pending");
      for (const id of terminal.slice(0, Math.max(0, terminal.length - 16))) delete doc.jobs[id];
      return { taskId, obsolete: old.map((job) => job.taskId) };
    }, context);
    if (selected === undefined) return;
    for (const taskId of selected.obsolete) await harness.abortTask(taskId as TaskId, context);
    const done = await harness.waitForTask(selected.taskId, context);
    if (done.state.outcome.status === "completed") return { summary: done.state.outcome.result.summary };
    const error = "error" in done.state.outcome ? done.state.outcome.error?.message : "上下文摘要已中断。";
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ContextCompactionDoc, api.conversationId);
      const job = doc.jobs[key]; if (job) { job.status = "failed"; job.error = error || "上下文摘要失败。"; }
      doc.lastError = error || "上下文摘要失败。";
    }, context);
    // No request-only rewriting exists here: fallback uses the official selected prefix, without expanding a
    // hidden full transcript. Preserve its failure/retry path instead of declining overflow with an empty result.
    return undefined;
  }

  async function reconcile(conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT) {
    const harness = options.getHarness();
    const snapshot = await harness.snapshot(ContextCompactionDoc, conversationId, context);
    if (!snapshot) return;
    const conversation = await harness.conversation(conversationId, context);
    if (!conversation) return;
    for (const [key, job] of Object.entries(snapshot.jobs)) {
      if (job.status !== "pending") continue;
      const parent = await harness.getTask(job.compactionTaskId as TaskId, context);
      const child = await harness.getTask(job.taskId as TaskId<SummaryResult>, context);
      if (parent?.state.status !== "terminal") continue;
      let checkpointEntryId: number | undefined;
      const outcome = parent.state.outcome;
      if (outcome.status === "completed") {
        const result = outcome.result as { entryId?: number; submissionId?: number };
        checkpointEntryId = result.entryId;
        if (result.submissionId !== undefined) {
          const placed = await (await harness.submission(result.submissionId as SubmissionId, context))?.status(context);
          if (placed?.status === "queued") continue;
          if (placed?.status === "done" && placed.type === "write") checkpointEntryId = Number(placed.entry);
        }
      }
      await harness.commit(async (tx) => {
        const latestHead = await tx.latestHeadMarker(conversationId);
        const placed = checkpointEntryId === undefined ? undefined : await tx.entry(checkpointEntryId as EntryId);
        const doc = await tx.doc(ContextCompactionDoc, conversationId);
        const current = doc.jobs[key];
        if (!current || current.status !== "pending" || current.sourceHash !== job.sourceHash) return;
        const marker = `[KULO_CONTEXT_CHECKPOINT ${job.epoch} ${job.sourceHash}]`;
        const placedText = placed?.model?.map((message) => textContent(message)).join("\n") ?? "";
        if (checkpointEntryId !== undefined && placed?.kind === "pi.compaction" && Number(placed.head) === current.firstKept && placedText.includes(marker)
          && child?.state.status === "terminal" && child.state.outcome.status === "completed") {
          const result = child.state.outcome.result;
          const archive = await tx.appendEntry(ContextBlocksEntry, conversationId, { data: clean({
            epoch: job.epoch, kernelVersion: job.kernelVersion, sourceHash: job.sourceHash,
            compactionTaskId: job.compactionTaskId, checkpointEntryId, firstKept: job.firstKept,
            blocks: result.blocks, sourceChunks: result.sourceChunks,
          }) as unknown as JsonObject });
          current.checkpointEntryId = checkpointEntryId; current.archiveEntryId = Number(archive.id);
          current.status = latestHead?.id === checkpointEntryId ? "committed" : "superseded";
          if (current.status === "committed" && (doc.active?.epoch ?? 0) <= current.epoch) {
            doc.active = { epoch: current.epoch, checkpointEntryId, blockCount: result.blocks.length, kernelVersion: current.kernelVersion };
            doc.lastError = null;
          }
        } else current.status = "superseded";
      }, context);
    }
  }

  const extension = defineExtension({ name: "kulo-context-compaction", tasks: [summaryTask], hooks: [
    hook(CompactionTask, { beforeCompact }),
    hook(GenerationTask, { beforeRequest: async (_request, api, context) => { await reconcile(api.conversationId, context); return undefined; } }),
  ] });
  return {
    extension, reconcile,
    async setEnabled(conversationId: ConversationId, enabled: boolean, context: Context = BACKGROUND_CONTEXT) {
      const loaded = enabled ? await options.getKernel() : null;
      if (enabled && !loaded) throw new Error("请先安装 Billion Context 上下文压缩。");
      const harness = options.getHarness();
      const pending = await harness.commit(async (tx) => {
        const doc = await tx.doc(ContextCompactionDoc, conversationId);
        doc.enabled = enabled; doc.kernelVersion = loaded?.version ?? doc.kernelVersion;
        return [...new Set(Object.values(doc.jobs).filter((job) => job.status === "pending").map((job) => job.compactionTaskId))];
      }, context);
      // Already selected work owns a versioned source and produces a native-readable checkpoint. Drain its
      // placement before the manager unloads the kernel; a flag change must not strand a half-finished handoff.
      if (!enabled) for (const task of pending) {
        const done = await harness.waitForTask(task as TaskId, context);
        if (done.state.outcome.status === "completed") {
          const result = done.state.outcome.result as { submissionId?: number };
          if (result.submissionId !== undefined) await (await harness.submission(result.submissionId as SubmissionId, context))?.wait(context);
        }
      }
      await reconcile(conversationId, context);
    },
    async snapshot(conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT) {
      await reconcile(conversationId, context);
      return options.getHarness().snapshot(ContextCompactionDoc, conversationId, context);
    },
  };
}

function summaryText(message: AssistantMessage): string | undefined {
  if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) return;
  const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
  return text || undefined;
}
