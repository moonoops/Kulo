import { useRef, useState } from "react";
import { Alert, Button, Chip, Spinner, Table } from "@heroui/react";
import { redactSensitiveText, type TicketCardView } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { translate as t, useI18n } from "../../kulo-i18n";

export interface ScheduledTaskActions {
  canQueue: boolean;
  stop: (ticketId: string) => Promise<void>;
  delete: (ticketId: string) => Promise<void>;
}

export function scheduledTaskFrequency(seconds?: number): string {
  if (seconds === undefined) return t("单次", "Once");
  for (const [unit, label, single, english] of [[604800, "周", "每周", "week"], [86400, "天", "每天", "day"], [3600, "小时", "每小时", "hour"], [60, "分钟", "每分钟", "minute"], [1, "秒", "每秒", "second"]] as const) {
    if (seconds % unit === 0) {
      const count = seconds / unit;
      return t(seconds === unit ? single : `每 ${count} ${label}`, count === 1 ? `Every ${english}` : `Every ${count} ${english}s`);
    }
  }
  return t(`每 ${seconds} 秒`, `Every ${seconds} seconds`);
}

export function scheduledTaskStatus(task: TicketCardView): string {
  if (task.status === "waiting") {
    switch (task.waiting?.reason) {
      case "time": return t("待执行", "Scheduled");
      case "env": return t("等待设备", "Waiting for device");
      case "user": return t("待确认", "Awaiting confirmation");
      case "external": return t("等待结果", "Waiting for result");
      case "connection": return t("等待授权", "Waiting for access");
      case "project": return t("等待项目", "Waiting for project");
      default: return t("等待中", "Waiting");
    }
  }
  return {
    queued: t("排队中", "Queued"), running: t("执行中", "Running"), pausing: t("正在暂停", "Pausing"), blocked: t("待确认", "Awaiting confirmation"),
    ready: t("已完成", "Completed"), failed: t("执行失败", "Failed"), stopped: t("已停止", "Stopped"), closed: t("已结束", "Closed"),
  }[task.status];
}

export function ScheduledTasksModule({ tickets, loaded, connected, loadError, onRefresh, actions }: {
  tickets: TicketCardView[];
  loaded: boolean;
  connected: boolean;
  loadError?: string | null;
  onRefresh?: () => Promise<void> | void;
  actions?: ScheduledTaskActions;
}) {
  const { locale } = useI18n();
  const timeFormat = new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZoneName: "short",
  });
  const tasks = tickets.filter((task) => task.schedule && task.schedule.deletedAt === undefined)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const [confirmation, setConfirmation] = useState<{ task: TicketCardView; action: "stop" | "delete" } | null>(null);
  const [pending, setPending] = useState<Partial<Record<string, "stop" | "delete">>>({});
  const [refreshing, setRefreshing] = useState(false);
  const flightsRef = useRef(new Set<string>());
  const refreshFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const actionButtons = useRef(new Map<string, HTMLButtonElement>());

  const retryLoad = async () => {
    if (!connected || !onRefresh || refreshFlight.current) return;
    refreshFlight.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      refreshFlight.current = false;
      setRefreshing(false);
    }
  };

  // A table may restore row focus when a dialog closes; return to the specific action.
  const restoreFocus = (id?: string, action: "stop" | "delete" = "delete") => requestAnimationFrame(() => {
    const button = id ? actionButtons.current.get(`${action}:${id}`) : undefined;
    if (button && !button.disabled) button.focus(); else listRef.current?.focus();
  });

  const confirm = async () => {
    if (!confirmation || !actions?.canQueue || flightsRef.current.has(confirmation.task.id)) return;
    const { task, action } = confirmation;
    flightsRef.current.add(task.id);
    setPending(current => ({ ...current, [task.id]: action }));
    setConfirmation(null);
    setError(null);
    restoreFocus(task.id, action);
    try {
      await actions[action](task.id);
      const focusId = action === "stop" ? task.id : tasks.find((item) => item.id !== task.id)?.id;
      if (document.activeElement === listRef.current) restoreFocus(focusId, action);
    } catch (cause) {
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("操作未完成，请重试。", "The operation did not finish. Try again.")));
    } finally {
      flightsRef.current.delete(task.id);
      setPending(current => { const next = { ...current }; delete next[task.id]; return next; });
    }
  };

  return <section ref={listRef} tabIndex={-1} className="flex min-w-0 flex-col gap-4" aria-label={t("定时任务", "Scheduled tasks")}>
    {!connected && <Alert status="warning"><Alert.Content>{t("与中枢连接已断开", "Disconnected from the hub")}</Alert.Content></Alert>}
    {!loaded && loadError && <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Description>{redactSensitiveText(loadError)}</Alert.Description></Alert.Content>{onRefresh && <Button type="button" size="sm" variant="secondary" isDisabled={!connected || refreshing} isPending={refreshing} onPress={() => void retryLoad()}>{t("重试", "Retry")}</Button>}</Alert>}
    {!loaded && connected && !loadError && <div role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner size="sm" />{t("加载中…", "Loading…")}</div>}
    {loaded && <Table variant="secondary" className="kulo-settings-table">
      <Table.ScrollContainer className="kulo-settings-table-scroll">
        <Table.Content aria-label={t("定时任务列表", "Scheduled task list")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content">
          <Table.Header>
            <Table.Column id="task" isRowHeader className="kulo-settings-table-column">{t("任务", "Task")}</Table.Column>
            <Table.Column id="time" className="kulo-settings-table-column kulo-settings-table-meta">{t("执行时间", "Run time")}</Table.Column>
            <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-meta">{t("状态", "Status")}</Table.Column>
            <Table.Column id="actions" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column>
          </Table.Header>
          <Table.Body renderEmptyState={() => <div className="kulo-table-empty-state">{t("暂无定时任务", "No scheduled tasks")}</div>}>
            {tasks.map((task) => {
              const schedule = task.schedule!;
              const at = schedule.nextRunAt ?? (schedule.repeatEverySeconds === undefined ? schedule.executeAt : null);
              const canStop = !["ready", "stopped", "closed"].includes(task.status);
              return <Table.Row key={task.id} id={task.id} textValue={task.title}>
                <Table.Cell className="kulo-settings-table-cell">
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <span className="kulo-item-title break-words">{task.title}</span>
                    {task.userSummary && <span className="kulo-item-description whitespace-pre-wrap break-words">{task.userSummary}</span>}
                  </div>
                </Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">
                  <div className="flex flex-col gap-1">
                    {at === null ? <span>—</span> : <time dateTime={new Date(at).toISOString()}>{timeFormat.format(at)}</time>}
                    <span className="kulo-item-description">{scheduledTaskFrequency(schedule.repeatEverySeconds)}</span>
                  </div>
                </Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta"><Chip size="sm" variant="soft" color={task.status === "failed" ? "danger" : task.status === "ready" ? "success" : task.status === "running" ? "accent" : "default"}>{scheduledTaskStatus(task)}</Chip></Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-actions">
                  <div className="kulo-settings-table-action-group">
                    <Button size="sm" variant="ghost" aria-label={t(`停止「${task.title}」`, `Stop “${task.title}”`)} ref={(button) => { if (button) actionButtons.current.set(`stop:${task.id}`, button); else actionButtons.current.delete(`stop:${task.id}`); }} isDisabled={!actions?.canQueue || Boolean(pending[task.id]) || !canStop} isPending={pending[task.id] === "stop"} onPress={() => { setError(null); setConfirmation({ task, action: "stop" }); }}>{pending[task.id] === "stop" && <Spinner size="sm" color="current" />}{t("停止", "Stop")}</Button>
                    <Button size="sm" variant="ghost" aria-label={t(`删除「${task.title}」`, `Delete “${task.title}”`)} ref={(button) => { if (button) actionButtons.current.set(`delete:${task.id}`, button); else actionButtons.current.delete(`delete:${task.id}`); }} isDisabled={!actions?.canQueue || Boolean(pending[task.id])} isPending={pending[task.id] === "delete"} onPress={() => { setError(null); setConfirmation({ task, action: "delete" }); }}>{pending[task.id] === "delete" && <Spinner size="sm" color="current" />}{t("删除", "Delete")}</Button>
                  </div>
                </Table.Cell>
              </Table.Row>;
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>}
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
    {confirmation && <ConfirmDialog open title={t(`${confirmation.action === "stop" ? "停止" : "删除"}「${confirmation.task.title}」？`, `${confirmation.action === "stop" ? "Stop" : "Delete"} “${confirmation.task.title}”?`)}
      description={<p>{confirmation.action === "stop" ? t("将停止当前执行及后续定时。", "The current execution and future scheduled runs will stop.") : t("将停止任务并从定时任务列表移除。", "The task will stop and be removed from scheduled tasks.")}</p>}
      confirmLabel={confirmation.action === "stop" ? t("停止", "Stop") : t("删除", "Delete")} isConfirmDisabled={!actions?.canQueue || flightsRef.current.has(confirmation.task.id)}
      onConfirm={() => void confirm()} onCancel={() => { restoreFocus(confirmation.task.id, confirmation.action); setConfirmation(null); setError(null); }} />}
  </section>;
}
