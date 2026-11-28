import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  LiveDoc,
  ToolResultEntry,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type LiveState,
} from "@earendil-works/pi-durable";
import {
  redactSecrets,
  type TicketRecord,
  type TicketWaitOption,
} from "@kulo/protocol";
import {
  PROTECTED_ROOT_SYSTEM_TASK_KINDS,
  abortConversationSafely,
} from "./conversation-abort.js";
import { isOrchestratorConversation, type KuloDurableState } from "./state.js";
import { epochOutwardActions } from "./task-recovery.js";

export const BOOT_GATE_FILENAME = "boot-gate.json";
export const CRASH_LOOP_WINDOW_MS = 5 * 60_000;
export const CRASH_LOOP_THRESHOLD = 2;
export const RESTART_GATE_WAIT_TOKEN_PREFIX = "restart-gate:";
export const RESTART_GATE_CONTINUE_OPTION_ID = "restart-continue";
export const RESTART_GATE_STOP_OPTION_ID = "restart-stop";

const MAX_RECENT_UNEXPECTED_BOOTS = 16;
const MAX_RESTART_GATE_DETAIL_CHARS = 280;
const MAX_INSPECT_ENTRY_PAGES = 20;
const INSPECT_ENTRY_PAGE_SIZE = 200;

/**
 * Strict positive whitelist of built-in Worker tools proven to be unconditionally
 * read-only and side-effect-free across all argument combinations.
 *
 * Explicitly excludes: file writes (`write`, `edit`, `kulo_publish_asset`, `kulo_skill_materialize`,
 * `kulo_media_export`), shell (`bash`, `kulo_host_action`), interactive GUI/browser (`kulo_browser`,
 * `kulo_desktop`, `kulo_computer_handoff`), external connections/billing (`kulo_connection_use`,
 * `kulo_connection_request`, `kulo_generate_*`, `kulo_media_job`, `kulo_synthesize_speech`),
 * subagent spawning (`kulo_subagent`), memory writes (`*_retain`, `hindsight_create_*`, etc.),
 * and all Android device tools (`android_*`).
 */
export const DECLARED_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "tool_search",
  "web_fetch",
  "web_search",
  "kulo_skill_read",
  "kulo_connections",
  "kulo_media_capabilities",
  "kulo_memory_recall",
  "hindsight_recall",
  "hindsight_list_mental_models",
  "hindsight_get_mental_model",
  "hindsight_get_page_tree",
  "hindsight_search_pages",
  "hindsight_get_page",
  "hindsight_search_knowledge_pages",
  "hindsight_list_knowledge_pages",
  "hindsight_read_knowledge_page",
  "hindsight_get_operation",
]);

export function isDeclaredReadOnlyTool(toolName: string): boolean {
  return DECLARED_READ_ONLY_TOOLS.has(toolName);
}

export interface BootGateDiskState {
  version: 1;
  kind: "running" | "graceful";
  localNodeId: string;
  bootId: string;
  startedAt: number;
  at: number;
  recentUnexpectedBoots: number[];
}

export interface BootGateStartResult {
  localNodeId: string;
  bootId: string;
  startedAt: number;
  wasGracefulRestart: boolean;
  crashLoopTripped: boolean;
  recentUnexpectedBoots: number[];
}

export type RestartGateBlockReason =
  | "failover"
  | "crash_loop"
  | "unexpected_restart"
  | "not_read_only"
  | "device_state_touched"
  | "outward_actions"
  | "non_read_only_tools"
  | "unverified_history"
  | "active_subagents";

export interface TicketRestartAutoResumeInput {
  ticket: Pick<
    TicketRecord,
    | "id"
    | "readOnly"
    | "deviceStateTouched"
    | "inheritedBrowserSession"
    | "executionDomain"
    | "androidDeviceIds"
    | "outwardActions"
    | "workspaceStaging"
  >;
  /** Must be captured BEFORE incrementing `ticket.runEpoch`. */
  oldEpoch: number;
  wasGracefulRestart: boolean;
  bootWasFailover: boolean;
  crashLoopTripped: boolean;
  /** Tools observed in `oldEpoch`; `undefined` fails closed to `require_user_review`. */
  executedTools: readonly string[] | undefined;
  historyVerified?: boolean;
  hasActiveSubagents?: boolean;
  /** Optional secret redactor (e.g. `connectionManager.redact`) layered with `redactSecrets`. */
  redact?: (text: string) => string;
}

export type TicketRestartDecision =
  | {
      action: "auto_resume";
      reasons: [];
      waitingDetail: string;
    }
  | {
      action: "require_user_review";
      reasons: RestartGateBlockReason[];
      waitingDetail: string;
      waitingOptions: TicketWaitOption[];
      waitToken: string;
    };

export interface WorkerEpochInspection {
  executedTools: string[] | undefined;
  historyVerified: boolean;
  hasActiveSubagents: boolean;
  liveRunTaskId?: number;
}

function writeJsonAtomicFsync(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Best-effort permission hardening.
      }
      try {
        const dirFd = fs.openSync(dir, "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // Directory fsync is best-effort on platforms/filesystems that reject it.
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readBootGateDiskState(filePath: string): { exists: boolean; state?: Partial<BootGateDiskState> } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { exists: false };
    }
    return { exists: true };
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    return { exists: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { exists: true };
    }
    return { exists: true, state: raw as Partial<BootGateDiskState> };
  } catch {
    return { exists: true };
  }
}

/**
 * Resolves the local host's node identifier for `<stateDir>/boot-gate.json` binding
 * before `Harness.open()` and `DeviceInterconnectionManager` initialize.
 */
export function resolveBootGateLocalNodeId(stateDir: string, explicitLocalEnvId?: string): string {
  const trimmedExplicit = explicitLocalEnvId?.trim();
  if (trimmedExplicit && trimmedExplicit !== "local") {
    return trimmedExplicit;
  }
  const devicesPath = path.join(stateDir, "devices.json");
  try {
    const st = fs.lstatSync(devicesPath);
    if (st.isFile() && !st.isSymbolicLink()) {
      const parsed = JSON.parse(fs.readFileSync(devicesPath, "utf8")) as { localNodeId?: unknown };
      if (typeof parsed?.localNodeId === "string") {
        const trimmed = parsed.localNodeId.trim();
        if (trimmed && trimmed !== "local") return trimmed;
      }
    }
  } catch {
    // Missing or unreadable devices.json falls back to standalone "local".
  }
  return "local";
}

/**
 * Runs at the earliest point in `KuloHub.open()` (strictly before `Harness.open()`).
 * Verifies any unconsumed graceful-shutdown marker bound to `localNodeId`, updates the
 * 5-minute unexpected-boot crash-loop counter, and atomically fsyncs a fresh `running`
 * boot record to consume the prior graceful marker immediately.
 */
export function recordBootStart(
  stateDir: string,
  localNodeId: string,
  now = Date.now(),
): BootGateStartResult {
  const normalizedNodeId = localNodeId.trim() || "local";
  const filePath = path.join(stateDir, BOOT_GATE_FILENAME);
  const { exists, state: prev } = readBootGateDiskState(filePath);

  const isValidGraceful = Boolean(
    prev &&
      prev.kind === "graceful" &&
      prev.localNodeId === normalizedNodeId &&
      typeof prev.bootId === "string" &&
      prev.bootId.trim().length > 0 &&
      typeof prev.at === "number" &&
      Number.isFinite(prev.at),
  );

  let wasGracefulRestart = false;
  let recentUnexpectedBoots: number[] = [];

  if (isValidGraceful) {
    wasGracefulRestart = true;
    recentUnexpectedBoots = [];
  } else if (exists) {
    const priorSameNode =
      prev &&
      prev.localNodeId === normalizedNodeId &&
      Array.isArray(prev.recentUnexpectedBoots)
        ? prev.recentUnexpectedBoots.filter(
            (ts): ts is number =>
              typeof ts === "number" &&
              Number.isFinite(ts) &&
              ts <= now &&
              now - ts <= CRASH_LOOP_WINDOW_MS,
          )
        : [];
    recentUnexpectedBoots = [...priorSameNode, now].slice(-MAX_RECENT_UNEXPECTED_BOOTS);
  } else if (fs.existsSync(path.join(stateDir, "kulo.sqlite"))) {
    // Existing Hub state without boot-gate.json (unclean shutdown / legacy / removed marker).
    recentUnexpectedBoots = [now];
  }

  const crashLoopTripped = recentUnexpectedBoots.length >= CRASH_LOOP_THRESHOLD;
  const bootId = randomUUID();
  const nextDiskState: BootGateDiskState = {
    version: 1,
    kind: "running",
    localNodeId: normalizedNodeId,
    bootId,
    startedAt: now,
    at: now,
    recentUnexpectedBoots,
  };
  writeJsonAtomicFsync(filePath, nextDiskState);

  return {
    localNodeId: normalizedNodeId,
    bootId,
    startedAt: now,
    wasGracefulRestart,
    crashLoopTripped,
    recentUnexpectedBoots,
  };
}

/**
 * Persists and fsyncs the graceful-shutdown marker at the tail of `KuloHub.close()`.
 */
export function recordGracefulShutdown(
  stateDir: string,
  localNodeId: string,
  bootId: string,
  now = Date.now(),
): void {
  const normalizedNodeId = localNodeId.trim() || "local";
  const filePath = path.join(stateDir, BOOT_GATE_FILENAME);
  const { state: prev } = readBootGateDiskState(filePath);
  const startedAt =
    prev && prev.bootId === bootId && typeof prev.startedAt === "number" && Number.isFinite(prev.startedAt)
      ? prev.startedAt
      : now;
  const payload: BootGateDiskState = {
    version: 1,
    kind: "graceful",
    localNodeId: normalizedNodeId,
    bootId,
    startedAt,
    at: now,
    recentUnexpectedBoots: [],
  };
  writeJsonAtomicFsync(filePath, payload);
}

function sanitizeRestartDetail(raw: string, redact?: (text: string) => string): string {
  const firstPass = redactSecrets(raw);
  const secondPass = redact ? redact(firstPass) : firstPass;
  const finalPass = redactSecrets(secondPass).replace(/\s+/g, " ").trim();
  return finalPass.slice(0, MAX_RESTART_GATE_DETAIL_CHARS);
}

function buildRestartReviewOptions(): TicketWaitOption[] {
  return [
    {
      id: RESTART_GATE_CONTINUE_OPTION_ID,
      label: "继续执行",
      tone: "primary",
      action: "reply",
      value: "已核实状态，请先检查当前工作区与外部状态后继续原任务，不要重复已完成的副作用。",
    },
    {
      id: RESTART_GATE_STOP_OPTION_ID,
      label: "停止任务",
      tone: "secondary",
      action: "stop",
      value: "重启后由用户取消继续执行",
    },
  ];
}

/**
 * Pure positive read-only whitelist adjudicator for built-in tickets interrupted by restart.
 * Only allows `auto_resume` when EVERY safety precondition holds simultaneously; any missing
 * proof or unsafe condition fails closed to `require_user_review`.
 */
export function evaluateTicketRestartAutoResume(
  input: TicketRestartAutoResumeInput,
): TicketRestartDecision {
  const { ticket, oldEpoch, wasGracefulRestart, bootWasFailover, crashLoopTripped, executedTools } = input;
  const reasons: RestartGateBlockReason[] = [];
  const outward = epochOutwardActions(ticket, oldEpoch);
  const disallowedTools = Array.isArray(executedTools)
    ? [...new Set(executedTools.filter((name) => !isDeclaredReadOnlyTool(name)))]
    : [];

  if (bootWasFailover) reasons.push("failover");
  if (crashLoopTripped) reasons.push("crash_loop");
  if (!wasGracefulRestart) reasons.push("unexpected_restart");
  if (outward.length > 0) reasons.push("outward_actions");
  if (ticket.readOnly !== true || ticket.workspaceStaging?.stagedDiff?.hasChanges) {
    reasons.push("not_read_only");
  }
  if (
    ticket.deviceStateTouched === true ||
    Boolean(ticket.inheritedBrowserSession) ||
    ticket.executionDomain === "android" ||
    Boolean(ticket.androidDeviceIds?.length)
  ) {
    reasons.push("device_state_touched");
  }
  if (executedTools === undefined || input.historyVerified === false) {
    reasons.push("unverified_history");
  } else if (disallowedTools.length > 0) {
    reasons.push("non_read_only_tools");
  }
  if (input.hasActiveSubagents) {
    reasons.push("active_subagents");
  }

  if (reasons.length === 0) {
    return {
      action: "auto_resume",
      reasons: [],
      waitingDetail: "优雅重启后核对并恢复只读任务",
    };
  }

  let rawDetail: string;
  if (reasons.includes("failover")) {
    rawDetail = "发生主备故障接管，系统已暂停自动续跑。请先核实当前设备与外部状态，再决定继续或停止。";
  } else if (reasons.includes("crash_loop")) {
    rawDetail = "检测到 5 分钟内多次异常重启，已触发安全熔断并暂停自动续跑。请排查原因后决定继续或停止。";
  } else if (reasons.includes("outward_actions")) {
    const labels = [...new Set(outward.map((item) => item.label))].slice(0, 4).join("、");
    rawDetail = `中断前本轮已发起外部动作（${labels}），系统已阻止重启自动续跑。请先核实外部实际状态，再决定继续或停止。`;
  } else if (reasons.includes("unexpected_restart")) {
    rawDetail = "上次退出非优雅重启或本机重启标记无效，系统已暂停自动续跑。请核实任务状态后决定继续或停止。";
  } else if (reasons.includes("device_state_touched")) {
    rawDetail = "该任务已触碰浏览器或桌面交互状态，重启后不会自动续跑。请核实页面与应用状态后决定继续或停止。";
  } else if (reasons.includes("non_read_only_tools")) {
    const toolList = disallowedTools.slice(0, 4).join("、");
    rawDetail = `本轮已调用非只读工具（${toolList}），重启后不会自动续跑。请核实执行状态后决定继续或停止。`;
  } else if (reasons.includes("not_read_only")) {
    rawDetail = "该任务包含写入或执行权限，重启后不会自动续跑。请核实工作区状态后决定继续或停止。";
  } else if (reasons.includes("active_subagents")) {
    rawDetail = "该任务包含子任务协作执行，重启后不会自动续跑。请核实进度后决定继续或停止。";
  } else {
    rawDetail = "无法完整核验本轮工具执行记录，按安全默认暂停自动续跑。请核实状态后决定继续或停止。";
  }

  return {
    action: "require_user_review",
    reasons,
    waitingDetail: sanitizeRestartDetail(rawDetail, input.redact),
    waitingOptions: buildRestartReviewOptions(),
    waitToken: `${RESTART_GATE_WAIT_TOKEN_PREFIX}${oldEpoch}`,
  };
}

/**
 * Applies a restart-gate decision onto a fenced built-in ticket inside the boot commit.
 */
export function applyTicketRestartDecision(
  ticket: TicketRecord,
  decision: TicketRestartDecision,
  now: number,
  redact?: (text: string) => string,
): void {
  if (decision.action === "auto_resume") {
    ticket.waiting ??= { reason: "env", since: now, detail: decision.waitingDetail };
    return;
  }
  ticket.wakePending = undefined;
  if (ticket.waiting?.reason === "user") {
    if (ticket.waiting.detail) {
      ticket.waiting.detail = sanitizeRestartDetail(ticket.waiting.detail, redact);
    }
    return;
  }
  ticket.waiting = {
    reason: "user",
    since: now,
    detail: decision.waitingDetail,
    waitToken: decision.waitToken,
    options: decision.waitingOptions,
  };
}

function collectToolsFromEntry(entry: EntryRecord, target: Set<string>): void {
  if (AssistantEntry.is(entry)) {
    for (const message of entry.model ?? []) {
      if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block && typeof block === "object" && block.type === "toolCall" && typeof block.name === "string") {
          target.add(block.name);
        }
      }
    }
    return;
  }
  if (ToolResultEntry.is(entry)) {
    for (const message of entry.model ?? []) {
      if (message && message.role === "toolResult" && typeof message.toolName === "string") {
        target.add(message.toolName);
      }
    }
  }
}

function collectToolsFromLiveState(live: Readonly<LiveState> | undefined, target: Set<string>): void {
  if (!live) return;
  for (const slot of live.tools ?? []) {
    if (typeof slot.name === "string") target.add(slot.name);
  }
  for (const slot of live.nestedTools ?? []) {
    if (typeof slot.name === "string") target.add(slot.name);
  }
  const genContent = live.generation?.message?.content;
  if (Array.isArray(genContent)) {
    for (const block of genContent) {
      if (block && typeof block === "object" && block.type === "toolCall" && typeof block.name === "string") {
        target.add(block.name);
      }
    }
  }
}

/**
 * Inspects every built-in `running`/`pausing` ticket BEFORE `ticket.runEpoch++` (while
 * Durable is still paused) to gather `oldEpoch`'s executed tools and live run metadata.
 */
export async function inspectBuiltInTicketsForRestartGate(
  harness: Harness,
  state: Readonly<KuloDurableState> | undefined,
  context: Context,
): Promise<Map<string, WorkerEpochInspection>> {
  const results = new Map<string, WorkerEpochInspection>();
  if (!state) return results;

  for (const ticket of Object.values(state.tickets)) {
    if ((ticket.status !== "running" && ticket.status !== "pausing") || ticket.externalExecution) {
      continue;
    }
    const oldEpoch = ticket.runEpoch;
    const hasActiveSubagents = Object.values(state.subagents ?? {}).some(
      (sub) => sub.ticketId === ticket.id && !["ready", "failed", "stopped"].includes(sub.state ?? ""),
    );
    const workerConvId = ticket.workerConversationId as ConversationId;
    const workerConv = await harness.conversation(workerConvId, context);
    if (!workerConv) {
      results.set(ticket.id, { executedTools: undefined, historyVerified: false, hasActiveSubagents });
      continue;
    }
    const live = await harness.snapshot(LiveDoc, workerConvId, context);
    const requestId = `kulo:worker-run:${ticket.id}:${oldEpoch}`;
    const submission = await harness.commit(
      (tx) => tx.submissionByRequest(workerConvId, requestId),
      context,
    );

    const tools = new Set<string>();
    collectToolsFromLiveState(live, tools);

    let historyVerified = true;
    if (submission && submission.type === "input" && submission.status === "queued") {
      // Epoch input was not placed yet; only live state (already collected above) could have tools.
    } else {
      const minEntryId: EntryId | undefined =
        submission && submission.type === "input" && "entry" in submission && submission.entry !== undefined
          ? submission.entry
          : live?.run?.first;
      let cursor: Cursor | undefined;
      let pages = 0;
      let truncated = false;
      for (;;) {
        const page = await workerConv.entries(
          { order: "ascending", ...(minEntryId !== undefined ? { minEntryId } : {}) },
          INSPECT_ENTRY_PAGE_SIZE,
          cursor,
          context,
        );
        for (const entry of page.items) {
          collectToolsFromEntry(entry, tools);
        }
        if (!page.next) break;
        pages++;
        if (pages >= MAX_INSPECT_ENTRY_PAGES) {
          truncated = true;
          break;
        }
        cursor = page.next;
      }
      if (truncated) historyVerified = false;
    }

    results.set(ticket.id, {
      executedTools: historyVerified ? [...tools] : undefined,
      historyVerified,
      hasActiveSubagents,
      ...(live?.run?.taskId !== undefined ? { liveRunTaskId: Number(live.run.taskId) } : {}),
    });
  }

  return results;
}

/**
 * Marks live tasks on fenced built-in worker and subagent conversations as aborted while Durable
 * is still paused, preventing any old worker or subagent `GenerationTask` from firing when the
 * first `conversation.abort()` resumes the task scheduler.
 */
export async function preAbortFencedWorkerTasks(
  harness: Harness,
  state: Readonly<KuloDurableState> | undefined,
  unfinished: Awaited<ReturnType<Harness["inspect"]>>,
  inspections: ReadonlyMap<string, WorkerEpochInspection>,
  context: Context,
): Promise<void> {
  if (inspections.size === 0) return;
  const fencedConvIds = new Set<number>();
  const taskIdsToMark = new Set<number>();
  for (const [ticketId, inspection] of inspections) {
    if (inspection.liveRunTaskId !== undefined) taskIdsToMark.add(inspection.liveRunTaskId);
    const ticket = state?.tickets[ticketId];
    if (!ticket) continue;
    fencedConvIds.add(ticket.workerConversationId);
    if (ticket.activeTaskId !== undefined) taskIdsToMark.add(ticket.activeTaskId);
  }
  for (const sub of Object.values(state?.subagents ?? {})) {
    if (inspections.has(sub.ticketId)) {
      fencedConvIds.add(sub.conversationId);
    }
  }
  for (const task of unfinished.tasks) {
    if (fencedConvIds.has(Number(task.record.conversationId))) {
      taskIdsToMark.add(Number(task.record.id));
    }
  }
  for (const taskId of taskIdsToMark) {
    await harness.abortTask(taskId as never, context).catch(() => undefined);
  }
}

/**
 * When `bootWasFailover || crashLoopTripped`, scans active main/topic conversations before
 * `harness.resume()`, pre-marks their live foreground tasks while Durable is paused, and calls
 * `abortConversationSafely` so no automatic reconnect/re-generation fires without user review.
 */
export async function abortActiveOrchestratorConversationsBeforeResume(
  harness: Harness,
  state: Readonly<KuloDurableState> | undefined,
  unfinished: Awaited<ReturnType<Harness["inspect"]>>,
  activeRootConvId: number,
  context: Context,
): Promise<number[]> {
  const candidates = new Set<number>([activeRootConvId]);
  for (const topic of Object.values(state?.topics ?? {})) {
    if (!topic.deletedAt) candidates.add(topic.conversationId);
  }
  for (const sub of unfinished.submissions) {
    const convId = Number(sub.conversationId);
    if (isOrchestratorConversation(convId, state)) candidates.add(convId);
  }
  for (const task of unfinished.tasks) {
    const convId = Number(task.record.conversationId);
    if (isOrchestratorConversation(convId, state)) candidates.add(convId);
  }

  const activeConvIds: number[] = [];
  const taskIdsToMark = new Set<number>();

  for (const convId of candidates) {
    const live = await harness.snapshot(LiveDoc, convId as ConversationId, context);
    const hasSubmission = unfinished.submissions.some((sub) => Number(sub.conversationId) === convId);
    const fgTasks = unfinished.tasks.filter(
      (task) =>
        Number(task.record.conversationId) === convId &&
        !task.record.background &&
        !PROTECTED_ROOT_SYSTEM_TASK_KINDS.has(task.record.kind),
    );
    if (!live?.run && !hasSubmission && fgTasks.length === 0) continue;
    activeConvIds.push(convId);
    if (live?.run?.taskId !== undefined) taskIdsToMark.add(Number(live.run.taskId));
    for (const task of fgTasks) taskIdsToMark.add(Number(task.record.id));
  }

  // Phase 1: mark every active foreground task aborted while Durable is still paused.
  for (const taskId of taskIdsToMark) {
    await harness.abortTask(taskId as never, context).catch(() => undefined);
  }

  // Phase 2: settle aborted runs safely via abortConversationSafely (preserves root system tasks).
  for (const convId of activeConvIds) {
    const conversation = await harness.conversation(convId as ConversationId, context);
    if (conversation) {
      await abortConversationSafely(harness, conversation, context);
    }
  }

  return activeConvIds;
}
