import {
  detectOutwardShellCommandsFromToolText,
  normalizeExternalContextUsage,
  redactSensitiveText,
  type ExternalAgentContextUsage,
  type ExternalAgentRun,
  type ExternalAgentRuntimeEvent,
  type TicketRecord,
  type WorkerExecutionPhase,
  type WorkerReportRecord,
} from "@kulo/protocol";
import { spillOversizedReport } from "./report-overflow.js";
import { appendTicketOutwardAction } from "./task-recovery.js";
import type { KuloUploadStore } from "./uploads.js";

export interface ExternalTicketTelemetry {
  ticketId: string;
  envId: string;
  runEpoch: number;
  sessionId?: string;
  contextUsage?: ExternalAgentContextUsage;
  activeSessionMode?: string;
}

export function sanitizeExternalSessionMode(
  rawMode: string | undefined,
  redact?: (value: string) => string,
): string | undefined {
  if (typeof rawMode !== "string") return undefined;
  const once = redact ? redact(rawMode) : rawMode;
  const clean = redactSensitiveText(once).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 128);
  return clean || undefined;
}

function sameContextUsage(
  a: ExternalAgentContextUsage | undefined,
  b: ExternalAgentContextUsage | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.usedTokens === b.usedTokens &&
    a.contextWindow === b.contextWindow &&
    a.percent === b.percent &&
    a.updatedAt === b.updatedAt
  );
}

/**
 * In-memory Hub telemetry projection for active external agent runs.
 * Keeps high-frequency `contextUsage` / `activeSessionMode` out of KuloStateDoc while
 * enforcing strict `(envId, sessionId, runEpoch)` anti-stale filtering.
 */
export class ExternalTelemetryCache {
  readonly #entries = new Map<string, ExternalTicketTelemetry>();

  update(
    incoming: ExternalTicketTelemetry,
    redact?: (value: string) => string,
  ): { changed: boolean; current?: ExternalTicketTelemetry } {
    const normalizedUsage = incoming.contextUsage
      ? normalizeExternalContextUsage(incoming.contextUsage)
      : undefined;
    const sanitizedMode = sanitizeExternalSessionMode(incoming.activeSessionMode, redact);
    if (!normalizedUsage && !sanitizedMode) {
      return { changed: false, current: this.#entries.get(incoming.ticketId) };
    }

    const prev = this.#entries.get(incoming.ticketId);
    if (prev) {
      if (incoming.runEpoch < prev.runEpoch) {
        return { changed: false, current: prev };
      }
      if (incoming.runEpoch === prev.runEpoch) {
        if (incoming.envId !== prev.envId) {
          return { changed: false, current: prev };
        }
        if (prev.sessionId && incoming.sessionId && incoming.sessionId !== prev.sessionId) {
          return { changed: false, current: prev };
        }
      }
    }

    const sameEpoch = Boolean(prev && prev.runEpoch === incoming.runEpoch);
    const prevUsage = sameEpoch ? prev?.contextUsage : undefined;
    const nextUsage =
      normalizedUsage && (!prevUsage || normalizedUsage.updatedAt >= prevUsage.updatedAt)
        ? normalizedUsage
        : prevUsage;
    const nextMode = sanitizedMode ?? (sameEpoch ? prev?.activeSessionMode : undefined);
    const nextSessionId = incoming.sessionId ?? (sameEpoch ? prev?.sessionId : undefined);
    const next: ExternalTicketTelemetry = {
      ticketId: incoming.ticketId,
      envId: incoming.envId,
      runEpoch: incoming.runEpoch,
      ...(nextSessionId ? { sessionId: nextSessionId } : {}),
      ...(nextUsage ? { contextUsage: nextUsage } : {}),
      ...(nextMode ? { activeSessionMode: nextMode } : {}),
    };
    const changed =
      !prev ||
      prev.runEpoch !== next.runEpoch ||
      prev.envId !== next.envId ||
      prev.sessionId !== next.sessionId ||
      !sameContextUsage(prev.contextUsage, next.contextUsage) ||
      prev.activeSessionMode !== next.activeSessionMode;
    if (changed) this.#entries.set(incoming.ticketId, next);
    return { changed, current: changed ? next : prev };
  }

  get(
    ticketId: string,
    expected: { envId: string; runEpoch: number; sessionId?: string },
  ): Pick<ExternalTicketTelemetry, "contextUsage" | "activeSessionMode"> | undefined {
    const entry = this.#entries.get(ticketId);
    if (!entry) return undefined;
    if (entry.envId !== expected.envId || entry.runEpoch !== expected.runEpoch) return undefined;
    if (expected.sessionId && entry.sessionId && entry.sessionId !== expected.sessionId) return undefined;
    if (!entry.contextUsage && !entry.activeSessionMode) return undefined;
    return {
      ...(entry.contextUsage ? { contextUsage: { ...entry.contextUsage } } : {}),
      ...(entry.activeSessionMode ? { activeSessionMode: entry.activeSessionMode } : {}),
    };
  }

  clear(ticketId: string): void {
    this.#entries.delete(ticketId);
  }
}

function externalPhaseLabel(phase?: WorkerExecutionPhase): string {
  switch (phase) {
    case "investigating":
      return "正在排查分析…";
    case "editing":
      return "正在编辑修改…";
    case "verifying":
      return "正在运行验证…";
    case "responding":
      return "正在整理回复…";
    case "waiting_permission":
      return "等待客户端授权…";
    default:
      return "客户端正在执行。";
  }
}

function isHeartbeatStateEvent(ev: ExternalAgentRuntimeEvent): boolean {
  return ev.type === "state" && /^(?:Thinking|Reasoning|Executing|Working|Running tool)\.\.\.$/.test(ev.text);
}

export function prepareCompletedExternalReports(input: {
  ticket: Readonly<TicketRecord>;
  runEpoch: number;
  run: Readonly<ExternalAgentRun>;
  uploads: KuloUploadStore;
  redact: (value: string) => string;
  now: number;
}): {
  fallbackNaturalReport?: WorkerReportRecord;
  backfilledExplicitReady?: WorkerReportRecord;
} {
  const { ticket, runEpoch, run, uploads, redact, now } = input;
  const activeExplicitReady =
    ticket.externalExecution?.explicitReadyReport?.runEpoch === runEpoch
      ? ticket.externalExecution.explicitReadyReport
      : undefined;
  const fallbackNaturalReport =
    run.state === "completed" && !activeExplicitReady
      ? spillOversizedReport({
          uploads,
          ticketId: ticket.id,
          runEpoch,
          version: 0,
          ownerConversationId: ticket.workerConversationId,
          originConversationId: ticket.originConversationId,
          report: {
            state: "ready",
            summary: redact(run.text.slice(0, 1200) || "客户端已结束执行，等待主 Agent 验收。"),
            ...(run.text ? { deliverable: redact(run.text) } : {}),
            at: now,
          },
        })
      : undefined;
  const backfilledExplicitReady =
    run.state === "completed" &&
    activeExplicitReady &&
    !activeExplicitReady.deliverable &&
    !activeExplicitReady.overflowAsset &&
    run.text.trim().length > 0
      ? spillOversizedReport({
          uploads,
          ticketId: ticket.id,
          runEpoch,
          version: activeExplicitReady.version,
          ownerConversationId: ticket.workerConversationId,
          originConversationId: ticket.originConversationId,
          report: {
            state: activeExplicitReady.state,
            summary: activeExplicitReady.summary,
            deliverable: redact(run.text),
            ...(activeExplicitReady.attachments ? { attachments: activeExplicitReady.attachments } : {}),
            at: activeExplicitReady.at,
          },
        })
      : undefined;
  return { fallbackNaturalReport, backfilledExplicitReady };
}

export function applyExternalRunSnapshotToTicket(
  live: TicketRecord,
  run: Readonly<ExternalAgentRun>,
  runEpoch: number,
  redact: (value: string) => string,
): void {
  const ext = live.externalExecution!;
  if (run.taskId !== live.id || run.runEpoch !== live.runEpoch || run.runEpoch !== runEpoch) return;
  if (ext.sessionId && run.sessionId && run.sessionId !== ext.sessionId) return;

  const isTerminal = ["completed", "failed", "cancelled", "uncertain"].includes(run.state);
  const nextLastSequence = Math.max(0, run.nextSequence - 1);
  let hasDurableWrite = isTerminal;

  if (ext.sessionId !== run.sessionId) {
    ext.sessionId = run.sessionId;
    hasDurableWrite = true;
  }
  if (ext.lastSequence !== nextLastSequence) {
    ext.lastSequence = nextLastSequence;
    hasDurableWrite = true;
  }
  if (JSON.stringify(ext.pendingPermissions ?? []) !== JSON.stringify(run.permissions)) {
    ext.pendingPermissions = run.permissions;
    hasDurableWrite = true;
  }
  if (run.stagedCwd && ext.stagedCwd !== run.stagedCwd) {
    ext.stagedCwd = run.stagedCwd;
    hasDurableWrite = true;
  }
  if (run.stagedDiff && JSON.stringify(ext.stagedDiff) !== JSON.stringify(run.stagedDiff)) {
    ext.stagedDiff = run.stagedDiff;
    hasDurableWrite = true;
  }
  if (run.phase && ext.phase !== run.phase) {
    ext.phase = run.phase;
    hasDurableWrite = true;
  }
  if (run.touchedFiles?.length && JSON.stringify(ext.touchedFiles ?? []) !== JSON.stringify(run.touchedFiles)) {
    ext.touchedFiles = [...run.touchedFiles];
    hasDurableWrite = true;
  }
  if (run.uncertainReason && ext.uncertainReason !== run.uncertainReason) {
    ext.uncertainReason = run.uncertainReason;
    hasDurableWrite = true;
  }
  if (run.readOnlyViolation && JSON.stringify(ext.readOnlyViolation) !== JSON.stringify(run.readOnlyViolation)) {
    ext.readOnlyViolation = run.readOnlyViolation;
    hasDurableWrite = true;
  }
  if (run.events.length > 0) {
    hasDurableWrite = true;
    ext.lastActivityAt = Math.max(
      ext.lastActivityAt ?? 0,
      ...run.events.map((event) => event.at),
    );
    const nonMessage = run.events.filter((ev) => ev.type !== "message");
    if (nonMessage.length > 0) {
      const merged = [...(ext.recentEvents ?? [])];
      const seenSeq = new Set(merged.map((ev) => ev.sequence));
      for (const ev of nonMessage) {
        if (seenSeq.has(ev.sequence)) continue;
        if (ev.type === "tool") {
          for (const label of detectOutwardShellCommandsFromToolText(ev.text)) {
            appendTicketOutwardAction(live, {
              runEpoch,
              kind: "external_bash",
              label,
              at: ev.at,
            });
          }
        }
        const last = merged.at(-1);
        if (last && isHeartbeatStateEvent(ev) && isHeartbeatStateEvent(last) && last.text === ev.text) {
          merged[merged.length - 1] = {
            sequence: ev.sequence,
            at: ev.at,
            type: ev.type,
            text: redact(ev.text).slice(0, 500),
          };
        } else {
          merged.push({
            sequence: ev.sequence,
            at: ev.at,
            type: ev.type,
            text: redact(ev.text).slice(0, 500),
          });
        }
        seenSeq.add(ev.sequence);
      }
      ext.recentEvents = merged.slice(-30);
    }
  }
  // Zero write amplification: piggyback read-only telemetry into KuloStateDoc ONLY during an existing receipt merge or terminal settlement.
  if (hasDurableWrite) {
    if (run.contextUsage) {
      const normalized = normalizeExternalContextUsage(run.contextUsage);
      if (normalized && (!ext.contextUsage || normalized.updatedAt >= ext.contextUsage.updatedAt)) {
        ext.contextUsage = normalized;
      }
    }
    const sanitizedMode = sanitizeExternalSessionMode(run.activeSessionMode, redact);
    if (sanitizedMode) {
      ext.activeSessionMode = sanitizedMode;
    }
  }
}

export function updateExternalProgressReport(
  live: TicketRecord,
  run: Readonly<ExternalAgentRun>,
  runEpoch: number,
  redact: (value: string) => string,
  now: number,
): void {
  const explicitReady =
    live.externalExecution?.explicitReadyReport?.runEpoch === runEpoch
      ? live.externalExecution.explicitReadyReport
      : undefined;
  if (
    (run.events.length || run.permissions.length) &&
    !explicitReady &&
    (!live.latestReport || live.latestReport.state === "progress")
  ) {
    const latestTool = [...(live.externalExecution!.recentEvents ?? [])]
      .reverse()
      .find((ev) => ev.type === "tool");
    live.updatedAt = now;
    live.latestReport = {
      state: "progress",
      summary: redact(
        run.permissions[0]?.title ??
          (run.text.trim()
            ? run.text.slice(-1200)
            : latestTool?.text ?? externalPhaseLabel(run.phase ?? live.externalExecution!.phase)),
      ),
      at: now,
    };
  }
}

export function settleTerminalExternalRun(input: {
  live: TicketRecord;
  run: Readonly<ExternalAgentRun>;
  runEpoch: number;
  fallbackNaturalReport?: WorkerReportRecord;
  backfilledExplicitReady?: WorkerReportRecord;
  redact: (value: string) => string;
  now: number;
}): boolean {
  const { live, run, runEpoch, fallbackNaturalReport, backfilledExplicitReady, redact, now } = input;
  if (!["completed", "failed", "cancelled", "uncertain"].includes(run.state)) return false;

  if (live.externalExecution!.interruptPending && live.wakePending && live.resumePrompt) {
    live.latestReport = { state: "progress", summary: "已中断上一轮执行，正在继续新指令。", at: now };
    return true;
  }

  const explicitReady =
    live.externalExecution?.explicitReadyReport?.runEpoch === runEpoch
      ? live.externalExecution.explicitReadyReport
      : undefined;
  const readOnlyViolation = run.readOnlyViolation ?? live.externalExecution?.readOnlyViolation;
  const withViolation = (base: WorkerReportRecord): WorkerReportRecord =>
    readOnlyViolation ? { ...base, readOnlyViolation } : base;
  const autoRecoverableFailure = run.state === "failed" && live.agentAssignment?.source === "orchestrator";
  const resumableTimeout =
    run.state === "uncertain" &&
    run.uncertainReason === "timeout" &&
    Boolean(run.sessionId);

  if (run.state === "completed") {
    if (live.latestReport && ["blocked", "failed"].includes(live.latestReport.state)) {
      live.latestReport = withViolation(live.latestReport);
    } else if (explicitReady) {
      const { runEpoch: _re, version: _ver, ...preserved } = explicitReady;
      const resolved =
        !preserved.deliverable && !preserved.overflowAsset && backfilledExplicitReady
          ? {
              ...preserved,
              ...(backfilledExplicitReady.deliverable ? { deliverable: backfilledExplicitReady.deliverable } : {}),
              ...(backfilledExplicitReady.overflowAsset ? { overflowAsset: backfilledExplicitReady.overflowAsset } : {}),
            }
          : preserved;
      live.latestReport = withViolation(resolved);
    } else {
      live.latestReport = withViolation(
        fallbackNaturalReport ?? {
          state: "ready",
          summary: redact(run.text.slice(0, 1200) || "客户端已结束执行，等待主 Agent 验收。"),
          ...(run.text ? { deliverable: redact(run.text) } : {}),
          at: now,
        },
      );
    }
  } else if (resumableTimeout) {
    const elapsedSec = Math.max(1, Math.round((now - (live.startedRunningAt ?? live.createdAt)) / 1000));
    const diff = run.stagedDiff ?? live.externalExecution?.stagedDiff;
    const stagedCounts = diff?.hasChanges
      ? `+${diff.added.length} 新增 / ~${diff.modified.length} 修改 / -${diff.deleted.length} 删除`
      : undefined;
    live.latestReport = withViolation({
      state: "blocked",
      summary: `外部智能体已运行约 ${elapsedSec} 秒并触发单次超时上限，原会话存档点（sessionId）已完整保留${stagedCounts ? `（暂存区已有部分改动：${stagedCounts}）` : ""}。`,
      question: `该任务已运行约 ${elapsedSec} 秒达到单次超时上限，但原生会话进度${stagedCounts ? `与暂存区部分改动（${stagedCounts}）` : ""}均已保留。是否基于原会话继续加时执行，或先审阅当前进度？`,
      at: now,
    });
  } else if (autoRecoverableFailure) {
    live.latestReport = withViolation({
      state: "failed",
      summary: redact(run.error || "外部智能体执行失败。"),
      at: now,
    });
  } else {
    const question =
      run.state === "failed"
        ? `具体原因：${redact(run.error || "客户端未返回失败原因")}\n请按错误原因恢复指定客户端后，再决定是否重试；不会自动改派其他智能体。`
        : "请检查原会话后决定是否继续；未自动重发任务。";
    live.latestReport = withViolation({
      state: "blocked",
      summary: redact(run.error || `客户端状态：${run.state}`),
      question,
      at: now,
    });
    live.waiting = { reason: "user", since: now, detail: question };
  }
  return true;
}

export function settleExternalPollFailure(input: {
  live: TicketRecord;
  runEpoch: number;
  failures: number;
  message: string;
  now: number;
}): "sleep" | "deliver_report" {
  const { live, runEpoch, failures, message, now } = input;
  const hasExplicitReady = live.externalExecution?.explicitReadyReport?.runEpoch === runEpoch;
  if (failures < 6 && !/not found|归属不匹配|状态无效/i.test(message)) {
    if (!hasExplicitReady && (!live.latestReport || live.latestReport.state === "progress")) {
      live.latestReport = { state: "progress", summary: message, at: now };
    }
    return "sleep";
  }
  if (hasExplicitReady) {
    const { runEpoch: _re, version: _ver, ...preserved } = live.externalExecution!.explicitReadyReport!;
    live.latestReport = preserved;
  } else {
    const question = "原执行接收状态不明确，请核对客户端后继续；未自动重发。";
    live.latestReport = { state: "blocked", summary: message, question, at: now };
    live.waiting = { reason: "user", since: now, detail: question };
  }
  return "deliver_report";
}
