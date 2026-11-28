import {
  detectOutwardShellCommandsFromToolText,
  type ExternalAgentRun,
  type ExternalAgentRuntimeEvent,
  type TicketRecord,
  type WorkerExecutionPhase,
  type WorkerReportRecord,
} from "@kulo/protocol";
import { spillOversizedReport } from "./report-overflow.js";
import { appendTicketOutwardAction } from "./task-recovery.js";
import type { KuloUploadStore } from "./uploads.js";

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
  ext.sessionId = run.sessionId;
  ext.lastSequence = Math.max(0, run.nextSequence - 1);
  ext.pendingPermissions = run.permissions;
  if (run.stagedCwd) ext.stagedCwd = run.stagedCwd;
  if (run.stagedDiff) ext.stagedDiff = run.stagedDiff;
  if (run.phase) ext.phase = run.phase;
  if (run.touchedFiles?.length) ext.touchedFiles = [...run.touchedFiles];
  if (run.uncertainReason) ext.uncertainReason = run.uncertainReason;
  if (run.readOnlyViolation) ext.readOnlyViolation = run.readOnlyViolation;
  if (run.events.length > 0) {
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
