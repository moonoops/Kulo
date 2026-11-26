import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  UserEntry,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import {
  resolveRolePresetFromPool,
  type RolePreset,
  type SubagentCardView,
  type SubagentRecord,
  type ThinkingEffort,
  type TicketRecord,
  type TicketSubagentSummary,
} from "@kulo/protocol";
import type { EnvManager } from "@kulo/env";
import { redactCredentialData } from "./credential-redaction.js";
import { ProjectError } from "./projects.js";
import { SUBAGENT_MAX_TURNS } from "./run-health-policy.js";
import {
  KuloStateDoc,
  getActiveStagedCwd,
  getEffectiveWorkspaceDir,
  type KuloDurableState,
} from "./state.js";
import type { RunSubagentsRequest, SubagentTaskOutcome } from "./tools-worker.js";

export const DEFAULT_READONLY_SUBAGENT_TIMEOUT_SECONDS = 180;
export const DEFAULT_WRITABLE_SUBAGENT_TIMEOUT_SECONDS = 300;
export const MIN_SUBAGENT_TIMEOUT_SECONDS = 30;
export const MAX_SUBAGENT_TIMEOUT_SECONDS = 900;
export const SUBAGENT_TIMEOUT_DRAIN_MS = 5_000;
export const SUBAGENT_CARD_SUMMARY_MAX_CHARS = 400;
export const MAX_RETAINED_CLOSED_SUBAGENTS = 512;

const PARTIAL_WRITE_WARNING =
  "[PARTIAL WRITE WARNING] This writable teammate did not finish cleanly; the ticket staged workspace may contain partial edits. Inspect actual files / git diff before continuing or reporting ready.";

const STATE_RANK: Record<NonNullable<SubagentRecord["state"]>, number> = {
  running: 0,
  queued: 1,
  waiting: 2,
  failed: 3,
  ready: 4,
  stopped: 5,
};

export function clampSubagentTimeoutSeconds(
  requested: number | undefined,
  readOnly: boolean,
): number {
  const fallback = readOnly
    ? DEFAULT_READONLY_SUBAGENT_TIMEOUT_SECONDS
    : DEFAULT_WRITABLE_SUBAGENT_TIMEOUT_SECONDS;
  if (typeof requested !== "number" || !Number.isFinite(requested)) return fallback;
  return Math.max(
    MIN_SUBAGENT_TIMEOUT_SECONDS,
    Math.min(MAX_SUBAGENT_TIMEOUT_SECONDS, Math.floor(requested)),
  );
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function aggregateTicketSubagentSummaries(
  state: Readonly<KuloDurableState> | undefined,
): Map<string, TicketSubagentSummary> {
  const grouped = new Map<string, SubagentRecord[]>();
  for (const sub of Object.values(state?.subagents ?? {})) {
    let list = grouped.get(sub.ticketId);
    if (!list) {
      list = [];
      grouped.set(sub.ticketId, list);
    }
    list.push(sub);
  }

  const summaries = new Map<string, TicketSubagentSummary>();
  for (const [ticketId, list] of grouped) {
    const parent = state?.tickets?.[ticketId];
    const parentActive = Boolean(
      parent && (parent.status === "running" || parent.status === "pausing"),
    );
    list.sort((a, b) => a.id.localeCompare(b.id));
    let running = 0;
    const parts: string[] = [];
    for (const sub of list) {
      const effectiveState = sub.state ?? "ready";
      if (parentActive && effectiveState === "running") running += 1;
      parts.push(`${sub.id}:${effectiveState}:${sub.runs}:${sub.updatedAt}:${sub.lastSummary?.length ?? 0}`);
    }
    summaries.set(ticketId, {
      running,
      total: list.length,
      revision: fnv1a32(`${parentActive ? 1 : 0}|${parts.join("|")}`),
    });
  }
  return summaries;
}

export function buildTicketSubagentViews(
  state: Readonly<KuloDurableState> | undefined,
  ticketId: string,
  redact: (text: string) => string,
): SubagentCardView[] {
  const list = Object.values(state?.subagents ?? {}).filter((s) => s.ticketId === ticketId);
  if (list.length === 0) return [];
  list.sort((a, b) => {
    const ra = STATE_RANK[a.state ?? "ready"];
    const rb = STATE_RANK[b.state ?? "ready"];
    return ra - rb || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
  });
  return list.map((sub) => {
    const rawSummary = sub.lastSummary?.trim();
    const clampedSummary = rawSummary
      ? rawSummary.length > SUBAGENT_CARD_SUMMARY_MAX_CHARS
        ? `${rawSummary.slice(0, SUBAGENT_CARD_SUMMARY_MAX_CHARS - 1)}…`
        : rawSummary
      : undefined;
    const view: SubagentCardView = {
      id: sub.id,
      name: sub.name,
      role: sub.role,
      roleLabel: sub.roleLabel,
      readOnly: sub.readOnly,
      runs: sub.runs,
      state: sub.state ?? "ready",
      ...(clampedSummary ? { lastSummary: clampedSummary } : {}),
      updatedAt: sub.updatedAt,
    };
    return redactCredentialData(view, redact);
  });
}

export function settlePendingSubagentsInTx(
  state: KuloDurableState,
  ticketId: string,
  now: number,
): void {
  for (const sub of Object.values(state.subagents ?? {})) {
    if (sub.ticketId !== ticketId) continue;
    if (sub.state === "queued" || sub.state === "waiting") {
      sub.state = "stopped";
      sub.updatedAt = now;
    }
  }
}

export function pruneClosedSubagentsInTx(
  state: KuloDurableState,
  maxRetainedClosed = MAX_RETAINED_CLOSED_SUBAGENTS,
): void {
  const all = Object.values(state.subagents ?? {});
  if (all.length <= maxRetainedClosed) return;
  const closedByParent = new Map<string, { sortAt: number; items: SubagentRecord[] }>();
  let totalClosed = 0;
  for (const sub of all) {
    const parent = state.tickets?.[sub.ticketId];
    if (parent && parent.status !== "closed") continue;
    totalClosed += 1;
    let bucket = closedByParent.get(sub.ticketId);
    if (!bucket) {
      bucket = { sortAt: parent?.updatedAt ?? sub.updatedAt, items: [] };
      closedByParent.set(sub.ticketId, bucket);
    }
    bucket.sortAt = Math.max(bucket.sortAt, sub.updatedAt);
    bucket.items.push(sub);
  }
  if (totalClosed <= maxRetainedClosed) return;

  const sortedBuckets = [...closedByParent.values()].sort((a, b) => a.sortAt - b.sortAt);
  let remaining = totalClosed;
  for (const bucket of sortedBuckets) {
    if (remaining <= maxRetainedClosed) break;
    for (const sub of bucket.items) {
      delete state.subagents?.[sub.id];
      delete state.conversationToSubagent?.[String(sub.conversationId)];
      remaining -= 1;
    }
  }
}

export function extractCurrentTurnAssistantText(entries: readonly unknown[]): string {
  for (const entry of entries) {
    if (UserEntry.is(entry as never)) break;
    if (AssistantEntry.is(entry as never)) {
      const msg = (entry as { model?: ReadonlyArray<{ role?: string; content?: unknown[] }> }).model?.[0];
      if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
        const texts = msg.content
          .filter(
            (b): b is { type: "text"; text: string } =>
              Boolean(b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string"),
          )
          .map((b) => b.text.trim())
          .filter(Boolean);
        if (texts.length > 0) return texts.join("\n");
      }
    }
  }
  return "";
}

export interface SubagentRunnerHost {
  harness: Harness;
  envManager: EnvManager;
  isClosed: () => boolean;
  getRoles: () => Record<string, RolePreset>;
  getMaxSubagentsPerTicket: () => number;
  getDefaultTimeoutOverrideMs?: () => number | undefined;
  resolveSubagentAgent: (
    subPreset: RolePreset | undefined,
    requestedThinking: ThinkingEffort | undefined,
  ) => { model: NonNullable<AgentChange["model"]>; thinkingLevel: NonNullable<AgentChange["thinkingLevel"]> };
  buildSubagentTools: (
    ticket: Readonly<TicketRecord>,
    readOnly: boolean,
  ) => Pick<AgentChange, "extensions" | "tools">;
  syncSubagentConversation: (
    conv: Conversation,
    ticket: Readonly<TicketRecord>,
    sub: Readonly<SubagentRecord>,
    context: Context,
  ) => Promise<void>;
  touchParentActivity: (ticketId: string) => void;
}

interface PreparedSubagentJob {
  record: SubagentRecord;
  conv: Conversation;
  reused: boolean;
  runNumber: number;
  promptText: string;
  timeoutMs: number;
}

export class KuloSubagentRunner {
  readonly #host: SubagentRunnerHost;
  readonly #subagentBatches = new Map<number, Promise<void>>();
  readonly #drainingSubagentIds = new Set<string>();

  constructor(host: SubagentRunnerHost) {
    this.#host = host;
  }

  isDraining(subagentId: string): boolean {
    return this.#drainingSubagentIds.has(subagentId);
  }

  async runSubagents(
    req: RunSubagentsRequest,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<SubagentTaskOutcome[]> {
    const key = req.callerConversationId;
    const previous = this.#subagentBatches.get(key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous ? previous.then(() => gate) : gate;
    this.#subagentBatches.set(key, tail);
    if (previous) await previous;
    try {
      return await this.#runSubagentBatch(req, context);
    } finally {
      release();
      if (this.#subagentBatches.get(key) === tail) this.#subagentBatches.delete(key);
    }
  }

  async #runSubagentBatch(
    req: RunSubagentsRequest,
    context: Context,
  ): Promise<SubagentTaskOutcome[]> {
    const snap = await this.#host.harness.snapshot(KuloStateDoc, context);
    const callerKey = String(req.callerConversationId);
    if (snap?.conversationToSubagent?.[callerKey]) {
      throw new Error("Forbidden: Subagents cannot spawn nested subagents (max depth = 1).");
    }

    const ticketId = snap?.conversationToTicket[callerKey];
    const ticket = ticketId ? snap?.tickets[ticketId] : undefined;
    if (!ticket) {
      throw new Error(
        "kulo_subagent can only be called inside an active Worker Ticket conversation.",
      );
    }
    if (ticket.status !== "running") {
      throw new ProjectError(409, "worker_not_running", "所属工单尚未取得执行资格。");
    }

    const activeRoles = this.#host.getRoles();
    const parentPreset = resolveRolePresetFromPool(activeRoles, ticket.role).preset;
    if (!parentPreset?.allowSubagents) {
      throw new Error(
        `Role '${ticket.role}' is not authorized to spawn subagents (allowSubagents=false).`,
      );
    }

    const maxBatch = Math.max(1, Math.min(8, this.#host.getMaxSubagentsPerTicket()));
    if (req.tasks.length > maxBatch) {
      throw new Error(
        `Subagent batch size (${req.tasks.length}) exceeds maxSubagentsPerTicket (${maxBatch}). Split into batches of at most ${maxBatch}.`,
      );
    }

    const existingForTicket = Object.values(snap?.subagents ?? {}).filter(
      (s) => s.ticketId === ticket.id,
    );
    const totalUsedRuns = existingForTicket.reduce((sum, s) => sum + s.runs, 0);
    const maxTotalRuns = Math.max(16, maxBatch * 4);
    const newRuns = req.tasks.filter(
      (_, index) =>
        !req.invocationId ||
        !existingForTicket.some((sub) => sub.invocationId === `${req.invocationId}:${index}`),
    ).length;
    if (totalUsedRuns + newRuns > maxTotalRuns) {
      throw new Error(
        `Ticket '${ticket.id}' reached its subagent invocation limit (${maxTotalRuns} runs). Please synthesize existing findings and report.`,
      );
    }

    const jobs: PreparedSubagentJob[] = [];
    const seenTargetsInBatch = new Set<string>();
    let nextSeq = existingForTicket.length + 1;

    for (const [taskIndex, taskReq] of req.tasks.entries()) {
      const invocationId = req.invocationId ? `${req.invocationId}:${taskIndex}` : undefined;
      if (!taskReq.goal) {
        throw new Error("Each subagent task must include a non-empty `goal`.");
      }

      const matchedExisting = existingForTicket.find(
        (s) =>
          (invocationId && s.invocationId === invocationId) ||
          (taskReq.agentId && s.id === taskReq.agentId) ||
          (!taskReq.agentId &&
            taskReq.name &&
            s.name.toLowerCase() === taskReq.name.toLowerCase()),
      );

      if (matchedExisting) {
        if (this.#drainingSubagentIds.has(matchedExisting.id)) {
          throw new Error(
            `Teammate '${matchedExisting.name}' (${matchedExisting.id}) is still draining after an earlier timeout. Wait briefly or spawn a new teammate instead of reusing its agent_id.`,
          );
        }
        if (seenTargetsInBatch.has(matchedExisting.id)) {
          throw new Error(
            `Cannot invoke the same teammate '${matchedExisting.name}' (${matchedExisting.id}) twice in one parallel batch. Combine the instructions or invoke sequentially.`,
          );
        }
        seenTargetsInBatch.add(matchedExisting.id);

        const conv = await this.#host.harness.conversation(
          matchedExisting.conversationId as ConversationId,
          context,
        );
        if (!conv) {
          throw new Error(`Subagent conversation for '${matchedExisting.id}' was not found.`);
        }

        const updatedRecord = await this.#host.harness.commit(async (tx) => {
          const state = await tx.doc(KuloStateDoc);
          if (
            state.tickets[ticket.id]?.status !== "running" ||
            state.tickets[ticket.id]?.runEpoch !== ticket.runEpoch
          ) {
            throw new ProjectError(409, "worker_not_running", "所属工单尚未取得执行资格。");
          }
          state.subagents ??= {};
          const cur = state.subagents[matchedExisting.id];
          if (!cur) throw new Error(`Subagent '${matchedExisting.id}' missing in state.`);
          if (!invocationId || cur.invocationId !== invocationId) cur.runs += 1;
          cur.invocationId = invocationId;
          if (taskReq.scope?.trim()) cur.narrowedScope = taskReq.scope.trim();
          cur.state = "queued";
          cur.updatedAt = Date.now();
          return JSON.parse(JSON.stringify(cur)) as SubagentRecord;
        }, context);

        await this.#host.syncSubagentConversation(conv, ticket, updatedRecord, context);

        const promptParts = [
          `[Parent Worker Follow-Up — Round ${updatedRecord.runs}]`,
          taskReq.goal,
          ...(taskReq.scope ? ["", `[Updated Narrowed Scope]\n${taskReq.scope}`] : []),
        ];
        const timeoutMs = this.#resolveTimeoutMs(taskReq.timeoutSeconds, updatedRecord.readOnly);
        jobs.push({
          record: updatedRecord,
          conv,
          reused: true,
          runNumber: updatedRecord.runs,
          promptText: promptParts.join("\n"),
          timeoutMs,
        });
        continue;
      }

      if (taskReq.agentId) {
        throw new Error(
          `Subagent '${taskReq.agentId}' does not exist on ticket '${ticket.id}'. Omit agent_id to create a new subagent.`,
        );
      }

      const { roleId, preset: subPreset } = resolveRolePresetFromPool(
        activeRoles,
        taskReq.role,
        "scout",
      );
      if (subPreset && subPreset.enabled === false) {
        throw new Error(
          `子智能体角色 '${subPreset.label} (${roleId})' 当前已被停用，请改选其他启用中的角色。`,
        );
      }
      if (subPreset?.external) {
        throw new Error(
          "外部 Agent 通过 Hub 独立工单执行，请把协作需求交回主 Agent 使用 kulo_dispatch。",
        );
      }

      const seq = nextSeq++;
      const subagentId = `${ticket.id}:S-${String(seq).padStart(2, "0")}`;
      const subagentName = taskReq.name || `${roleId}-${seq}`;
      if (seenTargetsInBatch.has(`name:${subagentName.toLowerCase()}`)) {
        throw new Error(
          `Duplicate teammate name '${subagentName}' in the same parallel batch. Use distinct names.`,
        );
      }
      seenTargetsInBatch.add(`name:${subagentName.toLowerCase()}`);

      const effectiveReadOnly = Boolean(ticket.readOnly || subPreset?.readOnly);
      const subAgent = this.#host.resolveSubagentAgent(subPreset, taskReq.thinkingLevel);
      const effectiveWorkspaceDir = getEffectiveWorkspaceDir(ticket);
      const subConv = await this.#host.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: subAgent.model,
            thinkingLevel: subAgent.thinkingLevel,
            ...this.#host.buildSubagentTools(ticket, effectiveReadOnly),
            ...(ticket.executionDomain !== "android" ? { cwd: effectiveWorkspaceDir } : {}),
            maxTurns: SUBAGENT_MAX_TURNS,
          },
        },
        context,
      );

      const now = Date.now();
      const record: SubagentRecord = {
        id: subagentId,
        state: "queued",
        ...(invocationId ? { invocationId } : {}),
        name: subagentName,
        role: roleId,
        roleLabel: subPreset?.label ?? roleId,
        ...(taskReq.scope?.trim() ? { narrowedScope: taskReq.scope.trim() } : {}),
        ticketId: ticket.id,
        parentConversationId: req.callerConversationId,
        conversationId: subConv.id as number,
        readOnly: effectiveReadOnly,
        runs: 1,
        createdAt: now,
        updatedAt: now,
      };

      await this.#host.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        if (
          state.tickets[ticket.id]?.status !== "running" ||
          state.tickets[ticket.id]?.runEpoch !== ticket.runEpoch
        ) {
          throw new ProjectError(409, "worker_not_running", "所属工单尚未取得执行资格。");
        }
        state.subagents ??= {};
        state.conversationToSubagent ??= {};
        state.subagents[record.id] = record;
        state.conversationToSubagent[String(subConv.id)] = record.id;
      }, context);

      const promptParts = [
        `Execute sub-task (${subagentName}):`,
        "",
        `[Sub-task Goal]\n${taskReq.goal}`,
        ...(taskReq.scope ? ["", `[Narrowed Scope]\n${taskReq.scope}`] : []),
        "",
        "Return concise findings, exact file/line references, and real command verification results directly in your response.",
      ];
      const timeoutMs = this.#resolveTimeoutMs(taskReq.timeoutSeconds, effectiveReadOnly);
      jobs.push({
        record,
        conv: subConv,
        reused: false,
        runNumber: 1,
        promptText: promptParts.join("\n"),
        timeoutMs,
      });
    }

    if (ticket.executionDomain !== "android" && ticket.scratchDir) {
      const activeStagedCwd = getActiveStagedCwd(ticket);
      const frozenMode = (await this.#host.harness.snapshot(KuloStateDoc, context))?.ticketExecutionModes?.[ticket.id];
      const execEnv = this.#host.envManager.createWorkerExecutionEnv(
        ticket.envId,
        activeStagedCwd ?? ticket.workspaceDir,
        {
          scratchDir: ticket.scratchDir,
          projectId: ticket.projectId,
          grantRevision: ticket.grantRevision,
          readOnly: ticket.readOnly,
          executionKey: ticket.id,
          ...(frozenMode?.runEpoch === ticket.runEpoch ? { executionMode: frozenMode.mode } : {}),
          ...(activeStagedCwd && !ticket.externalExecution ? { stagedTaskId: ticket.id } : {}),
        },
      );
      const result = await execEnv.createDir(ticket.scratchDir, { recursive: true }, context);
      if (!result.ok) throw new Error(result.error.message);
    }

    const touchParentActivity = () => this.#host.touchParentActivity(ticket.id);
    const onParentAbort = () => {
      if (this.#host.isClosed()) return;
      for (const job of jobs) {
        void job.conv.abort(BACKGROUND_CONTEXT, { background: true }).catch((error) => {
          console.error(`[KuloSubagent:abort:${job.record.id}]`, error);
        });
      }
    };
    context.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      touchParentActivity();
      const runJob = async (job: PreparedSubagentJob): Promise<SubagentTaskOutcome> => {
        req.onProgress?.(
          `[子智能体启动] ${job.record.name} (${job.record.roleLabel}/${job.record.role}${job.reused ? " · 续接" : ""})`,
        );
        let subObs: { detach(): void } | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await this.#host.harness.commit(async (tx) => {
            const state = await tx.doc(KuloStateDoc);
            const parent = state.tickets[ticket.id];
            const subagent = state.subagents?.[job.record.id];
            if (
              !parent ||
              parent.status !== "running" ||
              parent.runEpoch !== ticket.runEpoch ||
              !state.slots.holders.includes(ticket.id)
            ) {
              throw new ProjectError(409, "worker_not_running", "所属工单尚未取得执行资格。");
            }
            if (subagent) {
              subagent.state = "running";
              subagent.updatedAt = Date.now();
            }
          }, context);

          subObs = await this.#host.harness
            .observeConversation(
              job.conv.id,
              {
                advance: () => touchParentActivity(),
                end: () => {},
              },
              context,
              { min: 1, max: 1 },
            )
            .catch(() => undefined);

          const sub = await job.conv.submit(
            {
              type: "input",
              content: job.promptText,
              requestId: `kulo:subagent:${job.record.id}:${job.runNumber}`,
            },
            context,
          );

          const timeoutSentinel = Symbol("subagent_timeout");
          const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
            timer = setTimeout(() => resolve(timeoutSentinel), job.timeoutMs);
          });
          const raced = await Promise.race([sub.wait(context), timeoutPromise]);
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }

          if (raced === timeoutSentinel && !context.abortSignal?.aborted) {
            const drainController = new AbortController();
            const onOuterAbort = () => drainController.abort();
            context.abortSignal?.addEventListener("abort", onOuterAbort, { once: true });
            const drainTimer = setTimeout(() => drainController.abort(), SUBAGENT_TIMEOUT_DRAIN_MS);
            let drained = false;
            try {
              const drainCtx = withAbortSignal(drainController.signal, context);
              drained = await job.conv
                .abort(drainCtx, { background: true })
                .then(() => true, () => false);
            } finally {
              clearTimeout(drainTimer);
              context.abortSignal?.removeEventListener("abort", onOuterAbort);
            }

            if (!drained) {
              this.#drainingSubagentIds.add(job.record.id);
              void job.conv
                .waitForIdle(BACKGROUND_CONTEXT)
                .catch(() => undefined)
                .finally(() => {
                  this.#drainingSubagentIds.delete(job.record.id);
                });
            }

            touchParentActivity();
            let partial = "";
            if (drained) {
              try {
                const page = await job.conv.entries({}, 12, undefined, context);
                partial = extractCurrentTurnAssistantText(page.items);
              } catch {
                partial = "";
              }
            }
            const timeoutSec = Math.max(1, Math.round(job.timeoutMs / 1000));
            const guidance = drained
              ? `Timed out after ${timeoutSec}s. You may synthesize completed teammates' findings, narrow the scope, or resume this teammate via agent_id="${job.record.id}".`
              : `Timed out after ${timeoutSec}s and background teardown is still draining; do NOT reuse agent_id="${job.record.id}" immediately.`;
            const summaryParts = [
              ...(!job.record.readOnly ? [PARTIAL_WRITE_WARNING] : []),
              `[TIMEOUT] ${guidance}`,
              ...(partial ? [`Partial output from this round:\n${partial.slice(0, 1200)}`] : []),
            ];
            const summary = summaryParts.join("\n\n");

            await this.#host.harness.commit(async (tx) => {
              const state = await tx.doc(KuloStateDoc);
              const cur = state.subagents?.[job.record.id];
              if (cur && state.tickets[ticket.id]?.runEpoch === ticket.runEpoch) {
                cur.state = "failed";
                cur.lastSummary = summary.slice(0, 1000);
                cur.updatedAt = Date.now();
              }
            }, context);

            req.onProgress?.(`[子智能体超时] ${job.record.name} (${timeoutSec}s)`);
            return {
              agentId: job.record.id,
              name: job.record.name,
              role: job.record.role,
              roleLabel: job.record.roleLabel,
              readOnly: job.record.readOnly,
              reused: job.reused,
              status: "timeout",
              summary,
            };
          }

          const settled = raced === timeoutSentinel ? await sub.wait(context) : raced;
          await job.conv.waitForIdle(context);
          touchParentActivity();

          let summary = "";
          let status: "done" | "error" = "done";

          if (settled.status === "unanswered") {
            status = "error";
            const detailStr =
              settled.detail === undefined
                ? ""
                : typeof settled.detail === "string"
                  ? `: ${settled.detail}`
                  : `: ${JSON.stringify(settled.detail)}`;
            summary = `子智能体未完成（${settled.reason}${detailStr}）`;
          } else {
            const page = await job.conv.entries({}, 12, undefined, context);
            summary =
              extractCurrentTurnAssistantText(page.items) ||
              "（子智能体已执行完毕，未输出文本正文）";
          }

          if (status === "error" && !job.record.readOnly) {
            summary = `${PARTIAL_WRITE_WARNING}\n\n${summary}`;
          }

          await this.#host.harness.commit(async (tx) => {
            const state = await tx.doc(KuloStateDoc);
            const cur = state.subagents?.[job.record.id];
            if (cur && state.tickets[ticket.id]?.runEpoch === ticket.runEpoch) {
              cur.state = status === "done" ? "ready" : "failed";
              cur.lastSummary = summary.slice(0, 1000);
              cur.updatedAt = Date.now();
            }
          }, context);

          req.onProgress?.(`[子智能体${status === "done" ? "完成" : "异常"}] ${job.record.name}`);

          return {
            agentId: job.record.id,
            name: job.record.name,
            role: job.record.role,
            roleLabel: job.record.roleLabel,
            readOnly: job.record.readOnly,
            reused: job.reused,
            status,
            summary,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const summary = !job.record.readOnly
            ? `${PARTIAL_WRITE_WARNING}\n\n执行异常：${msg}`
            : `执行异常：${msg}`;
          await this.#host.harness.commit(async (tx) => {
            const state = await tx.doc(KuloStateDoc);
            const subagent = state.subagents?.[job.record.id];
            if (subagent && state.tickets[ticket.id]?.runEpoch === ticket.runEpoch) {
              subagent.state = "failed";
              subagent.lastSummary = summary.slice(0, 1000);
              subagent.updatedAt = Date.now();
            }
          }, BACKGROUND_CONTEXT);
          req.onProgress?.(`[子智能体异常] ${job.record.name}: ${msg}`);
          return {
            agentId: job.record.id,
            name: job.record.name,
            role: job.record.role,
            roleLabel: job.record.roleLabel,
            readOnly: job.record.readOnly,
            reused: job.reused,
            status: "error",
            summary,
          };
        } finally {
          if (timer) clearTimeout(timer);
          subObs?.detach();
        }
      };

      // Natural-language scopes cannot establish disjoint file ownership.
      let writes: Promise<unknown> = Promise.resolve();
      let writeChainBroken = false;
      const outcomes = await Promise.all(
        jobs.map((job) => {
          if (job.record.readOnly) return runJob(job);
          const outcome = writes.then(async (): Promise<SubagentTaskOutcome> => {
            if (writeChainBroken) {
              const skippedSummary =
                "Skipped because an earlier writable teammate timed out or aborted in the shared workspace.";
              await this.#host.harness.commit(async (tx) => {
                const state = await tx.doc(KuloStateDoc);
                const cur = state.subagents?.[job.record.id];
                if (cur && state.tickets[ticket.id]?.runEpoch === ticket.runEpoch) {
                  cur.state = "stopped";
                  if (job.reused && cur.runs > 1) cur.runs -= 1;
                  cur.lastSummary = "前序可写队友未正常完成，已熔断跳过";
                  cur.updatedAt = Date.now();
                }
              }, BACKGROUND_CONTEXT);
              req.onProgress?.(`[子智能体跳过] ${job.record.name}: 前序可写队友未正常完成`);
              return {
                agentId: job.record.id,
                name: job.record.name,
                role: job.record.role,
                roleLabel: job.record.roleLabel,
                readOnly: job.record.readOnly,
                reused: job.reused,
                status: "error",
                summary: skippedSummary,
              };
            }
            const res = await runJob(job);
            if (res.status !== "done") writeChainBroken = true;
            return res;
          });
          writes = outcome.then(() => undefined, () => undefined);
          return outcome;
        }),
      );

      return outcomes;
    } finally {
      context.abortSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  #resolveTimeoutMs(requestedSeconds: number | undefined, readOnly: boolean): number {
    const override = this.#host.getDefaultTimeoutOverrideMs?.();
    if (override !== undefined && requestedSeconds === undefined) return override;
    return clampSubagentTimeoutSeconds(requestedSeconds, readOnly) * 1000;
  }
}
