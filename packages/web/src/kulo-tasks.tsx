import { translate, getLanguage, useI18n } from "./kulo-i18n";
/** Kulo Task Projections: Inline Dispatch Card, Center Task Projection & Right TaskRail (HeroUI v3). */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Disclosure,
  ProgressBar,
  Spinner,
  TextArea,
} from "@heroui/react";
import type {
  ChatReplyReference,
  DispatchCardMeta,
  TicketCardView,
  TicketWaitOption,
} from "@kulo/protocol";
import { ConfirmDialog } from "./components/confirm-dialog";
import type { TicketDetailSnapshot } from "./kulo-api";
import { type PreviewableImage } from "./kulo-composer";
import { KuloIcon } from "./kulo-icon";
import { KuloMarkdown } from "./kulo-markdown";
import { TaskTimeline } from "./features/tasks/task-timeline";
import { TaskDeliverables } from "./features/tasks/task-deliverables";
import { TaskSubagents } from "./features/tasks/task-subagents";

import { compactTaskPaths, ticketHasPendingWorkspaceApply, ticketTone, taskIsRecovering, taskStatusLabel, taskTimeLabel, type TaskTone } from "./features/tasks/task-model";
import { TaskFailureActions, type TicketAction } from "./features/tasks/task-failure-actions";
import { newDeliveryId } from "./features/chat/reliable-intents";
import "./features/tasks/task-detail.css";
import { useTaskClock } from "./features/tasks/use-task-clock";
export { ticketTone, ticketStatusLabel, ticketWaitLabel, scopeTickets, type TaskTone } from "./features/tasks/task-model";
export { KuloTaskRail } from "./features/tasks/task-rail";

function toneToChipColor(
  tone: TaskTone,
): "accent" | "warning" | "danger" | "success" | "default" {
  switch (tone) {
    case "run":
      return "accent";
    case "ask":
      return "warning";
    case "fail":
      return "danger";
    case "done":
      return "success";
    default:
      return "default";
  }
}

export function relativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 30) return translate("刚刚", "Just now");
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return translate(`${mins} 分钟前`, `${mins} min ago`);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return translate(`${hrs} 小时前`, `${hrs} hr ago`);
  return new Date(ts).toLocaleDateString(getLanguage(), {
    month: "numeric",
    day: "numeric",
  });
}

export function TaskStatus({ status, waiting, cleanupPending, recovery, externalAgentKind, pendingWorkspaceApply }: Pick<TicketCardView, "status" | "waiting" | "cleanupPending" | "recovery" | "externalAgentKind" | "pendingWorkspaceApply">) {
  const { t } = useI18n();
  const recovering = taskIsRecovering({ status, recovery });
  const tone = cleanupPending || pendingWorkspaceApply || status === "waiting" && waiting?.reason === "user" ? "ask" : recovering ? "run" : ticketTone(status);
  return (
    <Chip
      size="sm"
      variant="soft"
      color={toneToChipColor(tone)}
      className="inline-flex shrink-0 items-center gap-1.5 font-medium"
    >
      {tone === "run" ? (
        <Spinner size="sm" color="current" aria-label={recovering ? t("正在恢复", "Recovering") : status === "pausing" ? t("正在暂停", "Pausing") : t("运行中", "Running")} className="h-3.5 w-3.5" />
      ) : (
        <KuloIcon
          size={14}
          filled
          name={
            tone === "ask"
              ? "help"
              : tone === "fail"
                ? "error"
                : tone === "done"
                  ? "check-circle"
                  : "schedule"
          }
        />
      )}
      <span>{taskStatusLabel({ status, waiting, cleanupPending, recovery, externalAgentKind, pendingWorkspaceApply })}</span>
    </Chip>
  );
}

/** Inline Task Dispatch / Action Card rendered directly inside conversation flow. */
export function TaskDispatchCard({
  dispatch,
  liveTicket,
  onProject,
}: {
  dispatch: DispatchCardMeta;
  liveTicket?: TicketCardView;
  onProject: (ticketId: string, title?: string) => void;
}) {
  const { t } = useI18n();
  const title = liveTicket?.title ?? dispatch.title;
  const summary = liveTicket?.userSummary ?? dispatch.userSummary;

  return (
    <Card variant="secondary" className="kulo-dispatch-card">
      <Card.Content className="flex flex-row items-center gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <KuloIcon name="task-alt" filled size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-muted">{dispatch.actionLabel}</span>
        <strong className="truncate text-sm font-semibold text-foreground">{title}</strong>
        {summary && (
          <span className="line-clamp-2 text-xs text-muted">{summary}</span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-2">
        {liveTicket && <TaskStatus status={liveTicket.status} waiting={liveTicket.waiting} cleanupPending={liveTicket.cleanupPending} recovery={liveTicket.recovery} externalAgentKind={liveTicket.externalAgentKind} pendingWorkspaceApply={liveTicket.pendingWorkspaceApply} />}
        <Button size="sm" variant="secondary" onPress={() => onProject(dispatch.ticketId, title)} aria-label={t(`查看任务：${title}`, `View task: ${title}`)}>{t("查看", "View")}<KuloIcon name="chevron-right" size={16} /></Button>
      </span>
      </Card.Content>
    </Card>
  );
}

/** Center-Stage Task Detail Projection (composer stays live below). */
export function KuloTaskProjection({
  detail,
  detailLoading = false,
  detailError = null,
  onRetryInspect,
  connected = true,
  canQueueActions = connected,
  pendingAnswer,
  pendingStop = false,
  roleLabel,
  onAnswerBlocker,
  onStop,
  onRetry,
  onArchiveClose,
  onDefer,
  onOpenOrigin,
  onOpenProject,
  projectName,
  onPreviewImage,
  onReply,
}: {
  detail: TicketDetailSnapshot;
  detailLoading?: boolean;
  detailError?: string | null;
  onRetryInspect?: () => void;
  connected?: boolean;
  canQueueActions?: boolean;
  pendingAnswer?: { text: string; commandId: string };
  pendingStop?: boolean;
  roleLabel: string;
  onAnswerBlocker: (ticketId: string, answer: string, commandId: string, decisionOptionId?: string) => Promise<void>;
  onStop: (ticketId: string, reason?: string) => Promise<void> | void;
  onRetry: TicketAction;
  onArchiveClose: TicketAction;
  onDefer: () => void;
  onOpenOrigin?: () => void;
  onOpenProject?: () => void;
  projectName?: string;
  onPreviewImage?: (image: PreviewableImage) => void;
  onReply?: (reply: ChatReplyReference) => void;
}) {
  const { t } = useI18n();
  const { ticket, transcript, live } = detail;
  const [answer, setAnswer] = useState("");
  const [pendingAnswers, setPendingAnswers] = useState<Partial<Record<string, true>>>({});
  const answerFlightsRef = useRef(new Set<string>());
  const answerCmdIdRef = useRef<{ ticketId: string; text: string; commandId: string } | null>(null);
  const activeTicketIdRef = useRef(ticket.id);
  activeTicketIdRef.current = ticket.id;
  const submittingAnswer = Boolean(pendingAnswers[ticket.id] || pendingAnswer);
  const overviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const [submittedAnswer, setSubmittedAnswer] = useState<{
    text: string;
    atUpdatedAt: number;
  } | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [confirmStopOpen, setConfirmStopOpen] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const controlFlightsRef = useRef(new Set<string>());
  const [controlPending, setControlPending] = useState<Partial<Record<string, "retry" | "close" | "stop">>>({});
  const [pendingStopOptions, setPendingStopOptions] = useState<Partial<Record<string, string>>>({});
  const pendingControl = controlPending[ticket.id] ?? (pendingStop ? "stop" : undefined);
  const pendingStopOptionId = pendingStopOptions[ticket.id];

  useEffect(() => {
    setAnswer("");
    answerCmdIdRef.current = null;
    setSubmittedAnswer(null);
    setAnswerError(null);
    setControlError(null);
    setConfirmStopOpen(false);
    setConfirmDiscardOpen(false);
  }, [ticket.id]);

  useEffect(() => {
    if (submittedAnswer && ticket.updatedAt !== submittedAnswer.atUpdatedAt) {
      setSubmittedAnswer(null);
    }
  }, [ticket.updatedAt, submittedAnswer]);

  const now = useTaskClock();

  const reportSummary =
    ticket.latestReport?.summary ?? ticket.userSummary ?? ticket.goal;
  const rawStoppedReason = ticket.stoppedReason?.trim();
  const stoppedSummary = ticket.status === "stopped" && rawStoppedReason
    ? rawStoppedReason === "Stopped by user"
      ? t("已由用户停止", "Stopped by user")
      : rawStoppedReason
    : undefined;
  const summary = stoppedSummary || reportSummary;
  const question = ticket.waiting?.detail ?? ticket.latestReport?.question ?? reportSummary;
  const decisionOptions: readonly TicketWaitOption[] = ticket.waiting?.options ?? [];
  const recovering = taskIsRecovering(ticket);
  const pendingWorkspaceApply = ticketHasPendingWorkspaceApply(ticket);
  const failed = ticket.status === "failed";
  const deliverable = ticket.latestReport?.deliverable;
  const needsAnswer = ticket.status === "blocked" || ticket.status === "waiting" && ticket.waiting?.reason === "user";
  const completed = ticket.status === "ready" || ticket.status === "closed";
  const detailedFileReport = completed && Boolean(deliverable && compactTaskPaths(deliverable, ticket) !== deliverable);
  const trimmedDeliverable = deliverable?.trim();
  const result = completed
    ? detailedFileReport ? reportSummary : trimmedDeliverable || reportSummary
    : trimmedDeliverable && trimmedDeliverable !== summary.trim() && trimmedDeliverable !== reportSummary.trim()
      ? deliverable
      : undefined;
  const displayResult = result ? compactTaskPaths(result, ticket) : undefined;
  const fullReport = detailedFileReport ? deliverable : displayResult !== result ? result : undefined;

  const submitDecision = async (rawText: string, optionId?: string) => {
    const clean = rawText.trim();
    if (!clean || !canQueueActions || submittingAnswer || Boolean(pendingControl) || answerFlightsRef.current.has(ticket.id)) return;
    const ticketId = ticket.id;
    answerFlightsRef.current.add(ticketId);
    setAnswerError(null);
    setPendingAnswers(current => ({ ...current, [ticketId]: true }));
    const dedupKey = optionId ? `${optionId}:${clean}` : clean;
    const cmdId =
      (answerCmdIdRef.current?.ticketId === ticketId && answerCmdIdRef.current.text === dedupKey ? answerCmdIdRef.current.commandId : undefined) ??
      newDeliveryId(`ans:${ticket.id}`);
    answerCmdIdRef.current = { ticketId, text: dedupKey, commandId: cmdId };
    try {
      await onAnswerBlocker(ticketId, clean, cmdId, optionId);
      if (activeTicketIdRef.current === ticketId) {
        answerCmdIdRef.current = null;
        setSubmittedAnswer({ text: clean, atUpdatedAt: ticket.updatedAt });
        if (!optionId) setAnswer("");
      }
    } catch (err) {
      if (activeTicketIdRef.current === ticketId) {
        setAnswerError(err instanceof Error ? err.message : t("提交回复失败，输入内容已保留。", "Failed to submit your reply. Your input has been kept."));
      }
    } finally {
      answerFlightsRef.current.delete(ticketId);
      setPendingAnswers(current => { const next = { ...current }; delete next[ticketId]; return next; });
    }
  };

  const submitAnswer = async (e: FormEvent) => {
    e.preventDefault();
    await submitDecision(answer);
  };

  const runControl = async (action: "retry" | "close" | "stop", handler: TicketAction, stopOptionId?: string) => {
    const ticketId = ticket.id;
    if (!canQueueActions || submittingAnswer || Boolean(pendingControl) || controlFlightsRef.current.has(ticketId)) return;
    controlFlightsRef.current.add(ticketId);
    setControlPending(current => ({ ...current, [ticketId]: action }));
    if (stopOptionId) {
      setPendingStopOptions(current => ({ ...current, [ticketId]: stopOptionId }));
    }
    setControlError(null);
    try {
      await handler(ticketId);
    } catch (error) {
      if (activeTicketIdRef.current === ticketId) {
        setControlError(error instanceof Error ? error.message : action === "stop" ? t("停止任务失败，请重试。", "Failed to stop task. Try again.") : action === "close" ? t("关闭任务失败，请重试。", "Failed to close task. Try again.") : t("重试失败，请重试。", "Retry failed. Try again."));
      }
    } finally {
      controlFlightsRef.current.delete(ticketId);
      setControlPending(current => { const next = { ...current }; delete next[ticketId]; return next; });
      if (stopOptionId) {
        setPendingStopOptions(current => { const next = { ...current }; delete next[ticketId]; return next; });
      }
    }
  };

  const isActiveProgress = ticket.status === "running" || ticket.status === "pausing";

  return (
    <div className="mc-projection-scroll" data-kulo-navigation-key={`task:${ticket.id}`} data-kulo-navigation="content">
      <div className="kulo-task-detail">
        <section className="kulo-task-overview" aria-label={t("任务概况", "Task overview")}>
          <dl className="kulo-task-detail-metrics">
            <div><dt className="sr-only">{t("任务编号", "Task ID")}</dt><dd>{ticket.id}</dd></div>
            <div><dt className="sr-only">{t("执行角色", "Execution role")}</dt><dd>{roleLabel}</dd></div>
            <div><dt className="sr-only">{t("耗时", "Duration")}</dt><dd>{taskTimeLabel(ticket, now)}</dd></div>
            <div><dt className="sr-only">{t("轮次", "Run")}</dt><dd>{t(`第 ${ticket.runEpoch} 轮`, `Run ${ticket.runEpoch}`)}</dd></div>
          </dl>
          <div className="kulo-task-detail-controls">
            <div className="kulo-task-detail-links">
              {onOpenOrigin && <Button size="sm" variant="ghost" onPress={onOpenOrigin}><KuloIcon name="forum" size={15} />{t("原会话", "Original conversation")}</Button>}
              {onOpenProject && <Button size="sm" variant="ghost" onPress={onOpenProject}><KuloIcon name="folder" size={15} /><span className="truncate">{projectName || t("目标项目", "Target project")}</span></Button>}
            </div>
            {failed ? <TaskFailureActions key={ticket.id} ticket={ticket} connected={connected} canQueueActions={canQueueActions} onRetry={async id => {
              await onRetry(id);
              requestAnimationFrame(() => overviewHeadingRef.current?.focus({ preventScroll: true }));
            }} onIgnore={onArchiveClose} /> :
              <div className="kulo-task-action-buttons">
                {["running", "queued", "pausing", "waiting", "blocked"].includes(ticket.status) && <Button size="sm" variant="tertiary" aria-label={t(`停止任务：${ticket.title}`, `Stop task: ${ticket.title}`)} isDisabled={!canQueueActions || Boolean(pendingControl) || submittingAnswer} isPending={pendingControl === "stop" && !pendingStopOptionId} onPress={() => setConfirmStopOpen(true)}>{pendingControl === "stop" && !pendingStopOptionId && <Spinner size="sm" color="current" />}{t("停止任务", "Stop task")}</Button>}
                {ticket.status === "blocked" && <Button size="sm" variant="secondary" aria-label={t(`重试任务：${ticket.title}`, `Retry task: ${ticket.title}`)} isDisabled={!canQueueActions || Boolean(pendingControl) || submittingAnswer} isPending={pendingControl === "retry"} onPress={() => void runControl("retry", onRetry)}>{pendingControl === "retry" && <Spinner size="sm" color="current" />}{t("重试", "Retry")}</Button>}
                {(ticket.status === "ready" || ticket.status === "stopped") && (
                  <Button
                    size="sm"
                    variant="tertiary"
                    aria-label={pendingWorkspaceApply ? t(`丢弃并关闭任务：${ticket.title}`, `Discard and close task: ${ticket.title}`) : t(`关闭任务：${ticket.title}`, `Close task: ${ticket.title}`)}
                    isDisabled={!canQueueActions || Boolean(pendingControl) || submittingAnswer}
                    isPending={pendingControl === "close"}
                    onPress={() => {
                      if (pendingWorkspaceApply) setConfirmDiscardOpen(true);
                      else void runControl("close", onArchiveClose);
                    }}
                  >
                    {pendingControl === "close" ? <Spinner size="sm" color="current" /> : <KuloIcon name="archive" size={15} />}
                    {pendingWorkspaceApply ? t("丢弃并关闭", "Discard & close") : t("关闭任务", "Close task")}
                  </Button>
                )}
              </div>}
          </div>
          {controlError && <p className="kulo-task-action-error" role="alert">{controlError}</p>}
        </section>

        {!completed && !needsAnswer && <section className="kulo-task-progress" aria-labelledby="task-overview-heading">
          <div className="kulo-task-overview-heading">
            <KuloIcon name={recovering ? "refresh" : failed ? "error" : "task-alt"} size={18} />
            <h2 id="task-overview-heading" className="kulo-group-title" ref={overviewHeadingRef} tabIndex={-1}>
              {recovering ? t("正在尝试其他方案", "Trying another approach") : failed ? t("失败原因", "Failure reason") : (ticket.status === "waiting" || ticket.status === "stopped") ? taskStatusLabel(ticket) : t("最新进展", "Latest progress")}
            </h2>
          </div>
          <p className="kulo-task-detail-summary">{summary}</p>
          {(isActiveProgress || recovering) && <ProgressBar aria-label={recovering ? t("正在恢复任务", "Recovering task") : t("任务执行中", "Task running")} isIndeterminate size="sm" className="w-full">
            <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
          </ProgressBar>}
        </section>}

        {needsAnswer && (
          <section className="flex flex-col gap-3 rounded-2xl border border-warning/40 bg-warning-soft/30 p-4">
            <div className="flex items-center gap-2">
              <Chip size="sm" variant="soft" color="warning">
                <KuloIcon name="help" filled size={14} />
                <span>{t("问题待确认", "Needs your decision")}</span>
              </Chip>
            </div>
            <blockquote className="text-sm font-medium text-foreground">
              {question}
            </blockquote>
            {submittedAnswer ? (
              <p className="text-xs text-muted">
                {t(`已接收回复（等待任务继续推进）：${submittedAnswer.text}`, `Reply received (waiting for task to continue): ${submittedAnswer.text}`)}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {decisionOptions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("快捷选项", "Quick choices")}>
                    {decisionOptions.map((option, index) => {
                      const isStopOption = option.action === "stop";
                      const isOptionPending = isStopOption && pendingControl === "stop" && pendingStopOptionId === option.id;
                      return (
                        <Button
                          key={option.id}
                          size="sm"
                          variant={option.tone ?? (index === 0 ? "primary" : "secondary")}
                          isPending={isOptionPending}
                          isDisabled={!canQueueActions || submittingAnswer || Boolean(pendingControl)}
                          onPress={() => {
                            if (isStopOption) {
                              void runControl("stop", (id) => onStop(id, option.value ?? option.label), option.id);
                            } else {
                              void submitDecision(option.value ?? option.label, option.id);
                            }
                          }}
                        >
                          {isOptionPending && <Spinner size="sm" color="current" />}
                          {option.label}
                        </Button>
                      );
                    })}
                  </div>
                )}
                <form className="flex flex-col gap-2.5" onSubmit={(e) => void submitAnswer(e)}>
                  <TextArea
                    variant="secondary"
                    className="scrollbar"
                    aria-label={t("回答待确认问题", "Answer the pending question")}
                    placeholder={decisionOptions.length > 0 ? t("或手动输入补充说明、替代方案…", "Or enter custom instructions…") : t("输入你的决定…", "Enter your decision…")}
                    rows={decisionOptions.length > 0 ? 2 : 3}
                    disabled={submittingAnswer || Boolean(pendingControl)}
                    value={pendingAnswer?.text ?? answer}
                    onChange={(e) => {
                      setAnswer(e.target.value);
                      answerCmdIdRef.current = null;
                    }}
                    fullWidth
                  />
                  {answerError && <p className="kulo-task-action-error" role="alert">{answerError}</p>}
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      isDisabled={submittingAnswer || Boolean(pendingControl)}
                      onPress={onDefer}
                    >
                      {t("稍后", "Later")}
                    </Button>
                    <Button
                      type="submit"
                      variant={decisionOptions.length > 0 ? "secondary" : "primary"}
                      size="sm"
                      isPending={submittingAnswer}
                      isDisabled={!answer.trim() || !canQueueActions || submittingAnswer || Boolean(pendingControl)}
                    >
                      {submittingAnswer ? t("提交中…", "Submitting…") : decisionOptions.length > 0 ? t("按说明提交", "Submit note") : t("确认提交", "Submit")}
                    </Button>
                  </div>
                </form>
              </div>
            )}
          </section>
        )}

        {result && (
          <section className="kulo-task-detail-result" aria-labelledby="task-result-heading">
            <h2 id="task-result-heading" className="kulo-group-title">{completed ? t("交付结果", "Deliverables") : t("执行结果", "Execution result")}</h2>
            {completed && <TaskDeliverables ticket={ticket} connected={connected} />}
            <article className="kulo-task-result-content">
              <KuloMarkdown text={displayResult!} />
            </article>
            {fullReport && fullReport !== displayResult && <Disclosure>
              <Disclosure.Heading level={3}><Disclosure.Trigger className="kulo-task-detail-trigger"><span>{t("交付说明", "Delivery notes")}</span><Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
              <Disclosure.Content><Disclosure.Body className="kulo-task-result-content"><KuloMarkdown text={fullReport} /></Disclosure.Body></Disclosure.Content>
            </Disclosure>}
          </section>
        )}

        <TaskSubagents subagents={detail.subagents} />

        <Disclosure className="kulo-task-detail-disclosure">
          <Disclosure.Heading level={2}>
            <Disclosure.Trigger className="kulo-task-detail-trigger"><span>{t("任务信息", "Task information")}</span><Disclosure.Indicator /></Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="kulo-task-detail-info">
              <dl>
                <div><dt>{t("任务目标", "Goal")}</dt><dd>{ticket.goal}</dd></div>
                {ticket.scope && <div><dt>{t("范围", "Scope")}</dt><dd>{ticket.scope}</dd></div>}
                {ticket.acceptance && <div><dt>{t("验收要求", "Acceptance criteria")}</dt><dd>{ticket.acceptance}</dd></div>}
                <div><dt>{t("设备", "Device")}</dt><dd>{ticket.envId}</dd></div>
                <div><dt>{t("工作目录", "Working directory")}</dt><dd className="kulo-task-workspace">{ticket.workspaceDir}</dd></div>
                {ticket.scratchDir && <div><dt>{t("草稿目录", "Scratch directory")}</dt><dd className="kulo-task-workspace">{ticket.scratchDir}</dd></div>}
              </dl>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>

        <Disclosure
          defaultExpanded={false}
          className="kulo-task-detail-disclosure"
        >
          <Disclosure.Heading level={2}>
            <Disclosure.Trigger className="kulo-task-detail-trigger">
              <span className="flex items-center gap-2">
                <span>

                  {t("执行过程记录", "Execution history")}
                  {!detailLoading ? ` (${transcript.length})` : ""}
                </span>
              </span>
              {(detailLoading || live.busy) && <Spinner size="sm" />}
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="kulo-task-transcript">
              {detailError ? (
                <Alert status="danger" className="flex items-center justify-between gap-3 rounded-xl p-3">
                  <div className="flex items-center gap-2">
                    <Alert.Indicator />
                    <Alert.Content className="text-xs">{detailError}</Alert.Content>
                  </div>
                  {onRetryInspect && (
                    <Button size="sm" variant="secondary" isDisabled={!connected} onPress={onRetryInspect}>

                      {t("重试加载", "Retry loading")}
                    </Button>
                  )}
                </Alert>
              ) : detailLoading && transcript.length === 0 ? (
                <div className="flex items-center gap-2 py-4 text-xs text-muted">
                  <Spinner size="sm" />
                  <span>{t("正在加载执行过程记录…", "Loading execution history…")}</span>
                </div>
              ) : transcript.length === 0 && !live.busy ? (
                <p className="py-3 text-xs text-muted">{t("暂无执行过程记录", "No execution history yet")}</p>
              ) : <TaskTimeline transcript={transcript} live={live} ticketId={ticket.id} roleLabel={roleLabel} onPreviewImage={onPreviewImage} onReply={onReply} />}
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>

        <ConfirmDialog
          open={confirmStopOpen}
          title={t("停止当前任务？", "Stop current task?")}
          description={t(`停止「${ticket.title}」，并取消后续执行。${ticket.waiting?.reason === "env" || ticket.cleanupPending ? "设备重新连接后清理旧执行。" : ""}`, `Stop “${ticket.title}” and cancel subsequent execution.${ticket.waiting?.reason === "env" || ticket.cleanupPending ? " Previous execution will be cleaned up when the device reconnects." : ""}`)}
          confirmLabel={t("停止任务", "Stop task")}
          status="danger"
          isConfirmDisabled={!canQueueActions || Boolean(pendingControl) || submittingAnswer}
          onCancel={() => setConfirmStopOpen(false)}
          onConfirm={() => {
            if (!canQueueActions || submittingAnswer || Boolean(pendingControl) || controlFlightsRef.current.has(ticket.id)) return;
            setConfirmStopOpen(false);
            void runControl("stop", (id) => onStop(id));
          }}
        />
        <ConfirmDialog
          open={confirmDiscardOpen}
          title={t("丢弃未合入改动并关闭？", "Discard unmerged changes and close?")}
          description={t(`关闭「${ticket.title}」将丢弃隔离副本中尚未合入的改动并释放项目写锁。`, `Closing “${ticket.title}” will discard unmerged staged changes and release the project write lock.`)}
          confirmLabel={t("丢弃并关闭", "Discard & close")}
          status="danger"
          isConfirmDisabled={!canQueueActions || Boolean(pendingControl) || submittingAnswer}
          onCancel={() => setConfirmDiscardOpen(false)}
          onConfirm={() => {
            if (!canQueueActions || submittingAnswer || Boolean(pendingControl) || controlFlightsRef.current.has(ticket.id)) return;
            setConfirmDiscardOpen(false);
            void runControl("close", onArchiveClose);
          }}
        />
      </div>
    </div>
  );
}
