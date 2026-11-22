import { useI18n } from "../../kulo-i18n";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, Card, Dropdown, Label, Spinner, Tooltip } from "@heroui/react";
import type { AssistantItemAction, AssistantItemView, ComputerPreviewSessionView, TicketCardView } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { KuloIcon } from "../../kulo-icon";
import { ContentPresence, useReducedContentMotion } from "../chat/use-content-motion";
import {
  OrphanComputerPreviewCard,
  resolveCardPreviewSession,
  TaskCardComputerPreview,
  TaskCardPreviewControls,
  type ComputerPreviewBinding,
} from "../computer-preview/computer-preview";
import {
  isTaskUnfinished, reconcileTaskRows, taskCompletedAt, taskDurationLabel, taskIsRecovering, taskNeedsAttention, taskStatusLabel,
  visibleTaskCards, type TaskRow,
} from "./task-model";
import { TaskFailureActions, type TicketAction } from "./task-failure-actions";
import "./task-rail.css";
import { useTaskClock } from "./use-task-clock";

function RailStatus({ ticket }: { ticket: TicketCardView }) {
  const { t } = useI18n();
  const attention = taskNeedsAttention(ticket);
  const label = ticket.status === "blocked" || ticket.status === "waiting" && ticket.waiting?.reason === "user" ? t("待确认", "Needs confirmation") : taskStatusLabel(ticket);
  const tone = ticket.cleanupPending || ticket.pendingWorkspaceApply ? "ask" : taskIsRecovering(ticket) ? "run" : ticket.status === "failed" ? "fail" : attention ? "ask" : ticket.status === "ready" ? "done" :
    ticket.status === "running" || ticket.status === "pausing" ? "run" : "wait";
  return <span className="kulo-task-status" data-tone={tone} title={label}>
    {tone === "run" ? <span className="kulo-task-run-dot" aria-hidden="true" /> :
      <KuloIcon name={tone === "fail" ? "error" : tone === "ask" ? "help" : tone === "done" ? "check" : "schedule"} size={13} />}
    <span className="kulo-task-status-label">{label}</span>
  </span>;
}

function assistantItemAgeLabel(timestamp: number, now: number, t: (zh: string, en: string) => string): string {
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 60) return t("刚刚", "Just now");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t(`${diffMin} 分钟前`, `${diffMin}m ago`);
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return t(`${diffHours} 小时前`, `${diffHours}h ago`);
  const diffDays = Math.floor(diffHours / 24);
  return t(`${diffDays} 天前`, `${diffDays}d ago`);
}

export function KuloTaskRail({
  tickets, assistantItems = [], onAssistantItemAction, projectedTicketId, onProject, onRetry, onIgnore, onArchive, onArchiveAll, completedTaskDisplayHours = 3, connected = true, canQueueActions = connected, loaded = true, snapshotVersion = 0, computerPreview,
}: {
  tickets: TicketCardView[];
  assistantItems?: AssistantItemView[];
  onAssistantItemAction?: (item: AssistantItemView, action: AssistantItemAction) => Promise<void> | void;
  projectedTicketId?: string;
  onProject: (ticketId: string, title?: string) => void;
  onRetry?: TicketAction;
  onIgnore?: TicketAction;
  onArchive?: TicketAction;
  onArchiveAll?: (ticketIds: readonly string[]) => Promise<void> | void;
  completedTaskDisplayHours?: 1 | 3 | 6 | null;
  connected?: boolean;
  canQueueActions?: boolean;
  loaded?: boolean;
  snapshotVersion?: number;
  computerPreview?: ComputerPreviewBinding;
}) {
  const { t } = useI18n();
  const railId = useId();
  const now = useTaskClock();
  const [hoveredId, setHoveredId] = useState<string>();
  const [focusedId, setFocusedId] = useState<string>();
  const [discardTarget, setDiscardTarget] = useState<TicketCardView | null>(null);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const [archiveActiveTarget, setArchiveActiveTarget] = useState<TicketCardView | null>(null);
  const [archivingIds, setArchivingIds] = useState<ReadonlySet<string>>(new Set());
  const [busyAssistantIds, setBusyAssistantIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const protectedIds = useMemo(() => new Set([hoveredId, focusedId, projectedTicketId].filter((id): id is string => Boolean(id))), [hoveredId, focusedId, projectedTicketId]);
  const desired = useMemo(() => visibleTaskCards(tickets, now, completedTaskDisplayHours, protectedIds), [tickets, now, completedTaskDisplayHours, protectedIds]);
  const [rows, setRows] = useState<TaskRow[]>(() => desired.map(ticket => ({ ticket, present: true, enter: false })));
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousPositions = useRef(new Map<string, number>());
  const movements = useRef(new Map<string, Animation>());
  const knownIds = useRef(new Set(tickets.map(ticket => ticket.id)));
  const baseline = useRef(snapshotVersion);
  const pendingSnapshotLayout = useRef<string | undefined>(undefined);
  const previousTickets = useRef(new Map(tickets.map(ticket => [ticket.id, ticket])));
  const completionTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const anchor = useRef<{ id: string; top: number } | undefined>(undefined);
  const reduced = useReducedContentMotion();

  const capturePositions = () => {
    previousPositions.current = new Map(Array.from(listRef.current?.children ?? []).map(node => {
      const element = node as HTMLElement;
      return [element.dataset.ticketId!, element.offsetTop];
    }));
  };
  const captureAnchor = () => {
    const scroll = scrollRef.current;
    if (!scroll || scroll.scrollTop < 4) { anchor.current = undefined; return; }
    const top = scroll.getBoundingClientRect().top;
    const first = Array.from(listRef.current?.children ?? []).find(node => node.getBoundingClientRect().bottom > top) as HTMLElement | undefined;
    anchor.current = first ? { id: first.dataset.ticketId!, top: first.getBoundingClientRect().top - top } : undefined;
  };

  useLayoutEffect(() => {
    const reset = baseline.current !== snapshotVersion || !loaded || !connected || document.hidden;
    baseline.current = snapshotVersion;
    const fresh = reset ? new Set<string>() : new Set(tickets.filter(ticket => !knownIds.current.has(ticket.id)).map(ticket => ticket.id));
    for (const ticket of tickets) knownIds.current.add(ticket.id);
    const held = new Set<string>();
    if (!reset && !reduced) {
      for (const ticket of tickets) {
        const previous = previousTickets.current.get(ticket.id);
        if (ticket.status === "ready" && previous && previous.status !== "ready" && !completionTimers.current.has(ticket.id)) {
          held.add(ticket.id);
          completionTimers.current.set(ticket.id, setTimeout(() => {
            completionTimers.current.delete(ticket.id);
            setSettling(current => { const next = new Set(current); next.delete(ticket.id); return next; });
          }, 450));
        }
      }
    }
    for (const [id, timer] of completionTimers.current) {
      if (reset || reduced || tickets.find(ticket => ticket.id === id)?.status !== "ready") {
        clearTimeout(timer); completionTimers.current.delete(id);
      } else held.add(id);
    }
    previousTickets.current = new Map(tickets.map(ticket => [ticket.id, ticket]));
    if (held.size !== settling.size || [...held].some(id => !settling.has(id))) setSettling(held);
    const ordered = [...desired];
    const pinned = new Set([hoveredId, focusedId, ...held].filter((id): id is string => Boolean(id)));
    for (const [index, row] of rowsRef.current.entries()) {
      const currentIndex = ordered.findIndex(ticket => ticket.id === row.ticket.id);
      if (currentIndex < 0 || !pinned.has(row.ticket.id)) continue;
      const [ticket] = ordered.splice(currentIndex, 1);
      ordered.splice(Math.min(index, ordered.length), 0, ticket!);
    }
    if (reset || pendingSnapshotLayout.current !== undefined) pendingSnapshotLayout.current = ordered.map(ticket => ticket.id).join("|");
    const scroll = scrollRef.current;
    const viewportTop = scroll?.getBoundingClientRect().top ?? 0;
    const offscreen = new Set(Array.from(listRef.current?.children ?? [])
      .filter(node => scroll && scroll.scrollTop > 4 && node.getBoundingClientRect().bottom <= viewportTop)
      .map(node => (node as HTMLElement).dataset.ticketId));
    setRows(previous => {
      const next = reconcileTaskRows(previous, ordered, fresh).map(row => ({ ...row, instantExit: !row.present && (reset || offscreen.has(row.ticket.id)) }));
      if (next.length === previous.length && next.every((row, index) => row.ticket === previous[index]?.ticket && row.present === previous[index]?.present && row.enter === previous[index]?.enter && row.instantExit === previous[index]?.instantExit)) return previous;
      return next;
    });
  }, [tickets, desired, loaded, connected, snapshotVersion, reduced, hoveredId, focusedId, settling]);

  const layoutKey = rows.map(row => row.ticket.id + ":" + row.present).join("|");
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroll = scrollRef.current;
    if (!list || !scroll) return;
    const activeAnchor = anchor.current;
    if (scroll.scrollTop > 4 && activeAnchor) {
      const element = Array.from(list.children).find(node => (node as HTMLElement).dataset.ticketId === activeAnchor.id);
      if (element) scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - activeAnchor.top;
    }
    const canMove = pendingSnapshotLayout.current === undefined && !reduced && !document.hidden && connected && loaded && scroll.scrollTop < 4;
    for (const node of Array.from(list.children) as HTMLElement[]) {
      const id = node.dataset.ticketId!;
      const previousTop = previousPositions.current.get(id);
      const transform = getComputedStyle(node).transform;
      const translate = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
      movements.current.get(id)?.cancel(); movements.current.delete(id);
      if (canMove && previousTop !== undefined && typeof node.animate === "function") {
        const delta = previousTop + translate - node.offsetTop;
        if (Math.abs(delta) > 0.5) {
          const animation = node.animate([{ transform: "translateY(" + delta + "px)" }, { transform: "translateY(0)" }],
            { duration: 260, easing: "cubic-bezier(.25,.46,.45,.94)" });
          movements.current.set(id, animation);
          animation.finished.then(() => { if (movements.current.get(id) === animation) movements.current.delete(id); }, () => {});
        }
      }
    }
    capturePositions(); captureAnchor();
    if (rows.every(row => row.present) && rows.map(row => row.ticket.id).join("|") === pendingSnapshotLayout.current) pendingSnapshotLayout.current = undefined;
  }, [layoutKey, reduced, loaded, connected, snapshotVersion]);

  useEffect(() => () => {
    for (const timer of completionTimers.current.values()) clearTimeout(timer);
    for (const animation of movements.current.values()) animation.cancel();
  }, []);

  useEffect(() => {
    if (discardTarget && !desired.some(ticket => ticket.id === discardTarget.id)) {
      setDiscardTarget(null);
    }
  }, [discardTarget, desired]);

  useEffect(() => {
    if (archiveActiveTarget && !desired.some(ticket => ticket.id === archiveActiveTarget.id)) {
      setArchiveActiveTarget(null);
    }
  }, [archiveActiveTarget, desired]);

  useEffect(() => {
    if (desired.length === 0 && !clearingAll) {
      setConfirmClearAllOpen(false);
      setActionError(null);
    }
  }, [desired.length, clearingAll]);

  const runAction = async (ticketId: string, action: TicketAction, removing: boolean) => {
    const index = rowsRef.current.findIndex(row => row.ticket.id === ticketId);
    await action(ticketId);
    requestAnimationFrame(() => {
      const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
      const remaining = rows.filter(row => !row.querySelector('[inert]'));
      const row = removing ? remaining[Math.min(Math.max(0, index), remaining.length - 1)] : rows.find(row => row.dataset.ticketId === ticketId);
      const target = row?.querySelector<HTMLButtonElement>(".kulo-task-card-button") ?? scrollRef.current;
      target?.focus({ preventScroll: true });
    });
  };

  const runArchive = async (ticketId: string, handler: TicketAction) => {
    if (!canQueueActions || clearingAll || archivingIds.has(ticketId)) return;
    setActionError(null);
    setArchivingIds(current => {
      const next = new Set(current);
      next.add(ticketId);
      return next;
    });
    try {
      await runAction(ticketId, handler, true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("归档任务失败，请重试。", "Failed to archive task. Try again."));
    } finally {
      setArchivingIds(current => {
        if (!current.has(ticketId)) return current;
        const next = new Set(current);
        next.delete(ticketId);
        return next;
      });
    }
  };

  const runAssistantAction = async (item: AssistantItemView, action: AssistantItemAction) => {
    if (!onAssistantItemAction || !connected || busyAssistantIds.has(item.id)) return;
    const index = assistantItems.findIndex((entry) => entry.id === item.id);
    setActionError(null);
    setBusyAssistantIds((current) => {
      const next = new Set(current);
      next.add(item.id);
      return next;
    });
    try {
      await onAssistantItemAction(item, action);
      if (action === "acknowledge" || action === "mute_app" || action === "confirm_action") {
        requestAnimationFrame(() => {
          const cards = Array.from(scrollRef.current?.querySelectorAll<HTMLButtonElement>('[data-assistant-open="true"]') ?? []);
          const nextButton = cards[Math.min(Math.max(0, index), Math.max(0, cards.length - 1))]
            ?? listRef.current?.querySelector<HTMLButtonElement>(".kulo-task-card-button")
            ?? scrollRef.current;
          nextButton?.focus({ preventScroll: true });
        });
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("处理事项失败，请重试。", "Failed to update item. Try again."));
    } finally {
      setBusyAssistantIds((current) => {
        if (!current.has(item.id)) return current;
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handleArchivePress = (ticket: TicketCardView) => {
    if (!onArchive || !canQueueActions || clearingAll || archivingIds.has(ticket.id) || discardingId === ticket.id) return;
    if (ticket.status === "ready" && ticket.pendingWorkspaceApply) {
      setDiscardTarget(ticket);
    } else if (isTaskUnfinished(ticket)) {
      setArchiveActiveTarget(ticket);
    } else {
      void runArchive(ticket.id, onArchive);
    }
  };

  const liveDiscardTarget = discardTarget ? desired.find(ticket => ticket.id === discardTarget.id) ?? null : null;
  const liveActiveTarget = archiveActiveTarget ? desired.find(ticket => ticket.id === archiveActiveTarget.id) ?? null : null;
  const activeCount = desired.filter(isTaskUnfinished).length;
  const pendingMergeCount = desired.filter(ticket => ticket.status === "ready" && ticket.pendingWorkspaceApply).length;
  const clearAllParts = [
    activeCount > 0 ? t(`${activeCount} 项进行中任务将被停止`, `${activeCount} active task${activeCount === 1 ? "" : "s"} will be stopped`) : undefined,
    pendingMergeCount > 0 ? t(`${pendingMergeCount} 项未合入改动将被丢弃`, `${pendingMergeCount} unmerged staged change${pendingMergeCount === 1 ? "" : "s"} will be discarded`) : undefined,
  ].filter(Boolean);
  const clearAllDescription = clearAllParts.length > 0
    ? t(
        `将删除右侧全部 ${desired.length} 张任务卡片（${clearAllParts.join("，")}）。`,
        `Delete all ${desired.length} task cards (${clearAllParts.join(", ")}).`,
      )
    : t(`将删除右侧全部 ${desired.length} 张任务卡片。`, `Delete all ${desired.length} task cards.`);

  const previewsByTicket = useMemo(() => {
    const map = new Map<string, ComputerPreviewSessionView[]>();
    for (const session of computerPreview?.state.sessions ?? []) {
      const list = map.get(session.ticketId);
      if (list) list.push(session);
      else map.set(session.ticketId, [session]);
    }
    return map;
  }, [computerPreview?.state.sessions]);
  const rowTicketIds = useMemo(() => new Set(rows.map((row) => row.ticket.id)), [rows]);
  const orphanPreviews = useMemo(
    () => [...previewsByTicket.entries()].filter(([ticketId]) => !rowTicketIds.has(ticketId)),
    [previewsByTicket, rowTicketIds],
  );

  return <div className="kulo-task-rail" data-reduced={reduced || undefined}>
    {desired.length > 0 && onArchiveAll && (
      <div className="kulo-task-rail-toolbar">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="kulo-task-clear-all"
          aria-label={t("一键全删所有任务卡片", "Delete all task cards")}
          isDisabled={!canQueueActions || clearingAll}
          isPending={clearingAll}
          onPress={() => setConfirmClearAllOpen(true)}
        >
          {clearingAll ? <Spinner size="sm" color="current" /> : <KuloIcon name="delete" size={16} />}
          {t("一键全删", "Delete all")}
        </Button>
      </div>
    )}
    {actionError && <p className="kulo-task-rail-error" role="alert">{actionError}</p>}
    {computerPreview && orphanPreviews.length > 0 && (
      <div className="kulo-task-preview-orphans">
        {orphanPreviews.map(([ticketId, sessions]) => (
          <OrphanComputerPreviewCard
            key={ticketId}
            ticketId={ticketId}
            sessions={sessions}
            state={computerPreview.state}
            client={computerPreview.client}
            connected={connected}
            onStop={computerPreview.onStop}
          />
        ))}
      </div>
    )}
    <div className="kulo-task-rail-scroll" ref={scrollRef} tabIndex={-1} onScroll={captureAnchor}>
      {assistantItems.length > 0 && (
        <section
          className="kulo-assistant-rail-section"
          aria-label={t("待关注事项", "Items to review")}
          data-has-tasks={rows.length > 0 || undefined}
        >
          {assistantItems.map((item) => {
            const pendingState = item.pendingAction?.executionState ?? "none";
            const isDispatched = pendingState === "dispatched";
            const isUnknown = pendingState === "unknown";
            const itemBusy = busyAssistantIds.has(item.id) || isDispatched;
            const sourceText = item.envName ? `${item.sourceLabel} · ${item.envName}` : item.sourceLabel;
            const timeText = assistantItemAgeLabel(item.updatedAt, now, t);
            const actionStatusNotice = isUnknown
              ? (item.pendingAction?.lastError || t("操作已发出但未确认结果，请核对目标应用后再收起。", "Action was sent without confirmation. Verify in the target app before dismissing."))
              : item.pendingAction?.lastError;
            return (
              <div className="kulo-task-space" key={item.id} data-assistant-item-id={item.id}>
                <Card variant="secondary" className="kulo-task-card kulo-assistant-card" data-kind={item.kind}>
                  <Card.Content className="kulo-task-card-content">
                    <div className="kulo-task-card-main">
                      <Button
                        type="button"
                        variant="ghost"
                        className="kulo-task-card-button"
                        data-assistant-open="true"
                        isDisabled={!connected || !onAssistantItemAction || itemBusy}
                        aria-label={t(`展开讨论：${item.title}`, `Open in topic: ${item.title}`)}
                        onPress={() => void runAssistantAction(item, "promote_to_topic")}
                      >
                        <strong className="kulo-task-title" title={item.title}>{item.title}</strong>
                        {item.summary && <span className="kulo-assistant-summary">{item.summary}</span>}
                        {item.pendingAction?.previewText && (
                          <span className="kulo-assistant-preview" title={item.pendingAction.previewText}>{item.pendingAction.previewText}</span>
                        )}
                        {actionStatusNotice && (
                          <span className="kulo-assistant-preview" role="status" title={actionStatusNotice}>{actionStatusNotice}</span>
                        )}
                        <span className="kulo-task-card-foot">
                          <span className="kulo-assistant-source" title={sourceText}>
                            <KuloIcon name={item.kind === "alert" || isUnknown ? "error" : item.kind === "decision" ? "help" : "bulb"} size={13} />
                            <span className="kulo-task-status-label">{sourceText}</span>
                          </span>
                          <span className="kulo-task-time">{timeText}</span>
                        </span>
                      </Button>
                      {onAssistantItemAction && (
                        <div className="kulo-assistant-card-controls">
                          <Tooltip delay={350}>
                            <Button
                              type="button"
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t(`知道了：${item.title}`, `Dismiss: ${item.title}`)}
                              isDisabled={!connected || itemBusy}
                              isPending={itemBusy}
                              onPress={() => void runAssistantAction(item, "acknowledge")}
                            >
                              {itemBusy ? <Spinner size="sm" color="current" /> : <KuloIcon name="check" size={16} />}
                            </Button>
                            <Tooltip.Content placement="top">{t("知道了", "Got it")}</Tooltip.Content>
                          </Tooltip>
                          <Dropdown>
                            <Button
                              type="button"
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t(`更多操作：${item.title}`, `More actions: ${item.title}`)}
                              isDisabled={!connected || itemBusy}
                            >
                              <KuloIcon name="more" size={16} />
                            </Button>
                            <Dropdown.Popover placement="bottom end">
                              <Dropdown.Menu
                                aria-label={t("事项操作", "Item actions")}
                                onAction={(key) => {
                                  if (key === "promote") void runAssistantAction(item, "promote_to_topic");
                                  else if (key === "mute") void runAssistantAction(item, "mute_app");
                                }}
                              >
                                <Dropdown.Item id="promote" textValue={t("在话题中展开", "Open in topic")}>
                                  <Label>{t("在话题中展开", "Open in topic")}</Label>
                                </Dropdown.Item>
                                <Dropdown.Item id="mute" textValue={t(`不再提醒「${item.sourceLabel}」`, `Mute ${item.sourceLabel}`)}>
                                  <Label>{t(`不再提醒「${item.sourceLabel}」`, `Mute ${item.sourceLabel}`)}</Label>
                                </Dropdown.Item>
                              </Dropdown.Menu>
                            </Dropdown.Popover>
                          </Dropdown>
                        </div>
                      )}
                    </div>
                    {(item.pendingAction || item.primaryActionLabel) && onAssistantItemAction && (
                      <div className="kulo-task-card-actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={!connected || itemBusy}
                          isPending={itemBusy}
                          onPress={() => {
                            if (isUnknown) {
                              void runAssistantAction(item, "acknowledge");
                            } else if (!isDispatched) {
                              void runAssistantAction(item, item.pendingAction ? "confirm_action" : "promote_to_topic");
                            }
                          }}
                        >
                          {isDispatched
                            ? t("执行中…", "Running…")
                            : isUnknown
                              ? t("已核对，收起", "Verified, dismiss")
                              : item.pendingAction
                                ? item.pendingAction.label
                                : item.primaryActionLabel}
                        </Button>
                      </div>
                    )}
                  </Card.Content>
                </Card>
              </div>
            );
          })}
        </section>
      )}
      <div className="kulo-task-list" ref={listRef}>
        {rows.map(row => {
          const ticket = row.ticket;
          const completed = taskCompletedAt(ticket);
          const durationLabel = taskDurationLabel(ticket, now);
          const age = ticket.status === "ready" && !ticket.pendingWorkspaceApply && completed !== undefined && completedTaskDisplayHours !== null ?
            Math.min(1, Math.max(0, (now - completed) / (completedTaskDisplayHours * 3_600_000))) : 0;
          const cardBusy = clearingAll || archivingIds.has(ticket.id) || discardingId === ticket.id;
          const ticketPreviews = computerPreview ? previewsByTicket.get(ticket.id) : undefined;
          const activePreview = Boolean(computerPreview && ticketPreviews && ticketPreviews.length > 0);
          const selectedPreview = activePreview && computerPreview
            ? resolveCardPreviewSession(computerPreview.state, ticket.id, ticketPreviews!)
            : undefined;
          const previewBodyId = `${railId}-preview-${ticket.id}`;
          return <div className="kulo-task-row" data-ticket-id={ticket.id} key={ticket.id}
            onPointerEnter={event => { if (event.pointerType !== "touch") setHoveredId(ticket.id); }}
            onPointerLeave={() => setHoveredId(current => current === ticket.id ? undefined : current)}
            onFocusCapture={() => setFocusedId(ticket.id)}
            onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(current => current === ticket.id ? undefined : current); }}>
            <ContentPresence present={row.present} animateEntry={row.enter && loaded && connected} animateExit={!row.instantExit} onExited={() => {
              capturePositions();
              setRows(current => current.filter(item => item.ticket.id !== ticket.id || item.present));
            }}>
              <div className="kulo-task-space">
                <Card variant="secondary" className={"kulo-task-card" + (row.enter ? " kulo-task-enter" : "")}
                  data-state={taskIsRecovering(ticket) ? "recovering" : ticket.status} data-attention={taskNeedsAttention(ticket) || undefined} data-selected={projectedTicketId === ticket.id || undefined}
                  data-has-preview={activePreview || undefined}
                  style={{ "--task-age": age } as CSSProperties}>
                  <Card.Content className="kulo-task-card-content">
                    {activePreview && computerPreview && ticketPreviews ? (
                      <>
                        <div className="kulo-task-card-head">
                          <Button type="button" variant="ghost" className="kulo-task-card-button"
                            aria-label={ticket.title + t("，查看任务详情", ", view task details")} aria-current={projectedTicketId === ticket.id ? "true" : undefined}
                            onPress={() => onProject(ticket.id, ticket.title)}>
                            <strong className="kulo-task-title" title={ticket.title}>{ticket.title}</strong>
                          </Button>
                          <TaskCardPreviewControls
                            ticketId={ticket.id}
                            ticketTitle={ticket.title}
                            bodyId={previewBodyId}
                            state={computerPreview.state}
                            client={computerPreview.client}
                            connected={connected}
                            onStop={computerPreview.onStop}
                          />
                        </div>
                        <TaskCardComputerPreview
                          ticketId={ticket.id}
                          ticketTitle={ticket.title}
                          bodyId={previewBodyId}
                          sessions={ticketPreviews}
                          state={computerPreview.state}
                          client={computerPreview.client}
                          connected={connected}
                          onStop={computerPreview.onStop}
                        />
                        <div className="kulo-task-card-foot kulo-task-card-preview-foot">
                          <span className="kulo-task-card-status-group">
                            <RailStatus ticket={ticket} />
                            {ticket.subagentSummary && ticket.subagentSummary.running > 0 && (
                              <>
                                <span className="kulo-task-device-sep" aria-hidden="true">·</span>
                                <span className="kulo-task-device-name">{t(`${ticket.subagentSummary.running} 队友运行中`, `${ticket.subagentSummary.running} teammates active`)}</span>
                              </>
                            )}
                            {selectedPreview?.deviceName && (
                              <>
                                <span className="kulo-task-device-sep" aria-hidden="true">·</span>
                                <span className="kulo-task-device-name" title={selectedPreview.deviceName}>{selectedPreview.deviceName}</span>
                              </>
                            )}
                          </span>
                          {durationLabel && <span className="kulo-task-time">{durationLabel}</span>}
                        </div>
                      </>
                    ) : (
                      <div className="kulo-task-card-main">
                        <Button type="button" variant="ghost" className="kulo-task-card-button"
                          aria-label={ticket.title + t("，查看任务详情", ", view task details")} aria-current={projectedTicketId === ticket.id ? "true" : undefined}
                          onPress={() => onProject(ticket.id, ticket.title)}>
                          <strong className="kulo-task-title" title={ticket.title}>{ticket.title}</strong>
                          <span className="kulo-task-card-foot">
                            <span className="kulo-task-card-status-group">
                              <RailStatus ticket={ticket} />
                              {ticket.subagentSummary && ticket.subagentSummary.running > 0 && (
                                <>
                                  <span className="kulo-task-device-sep" aria-hidden="true">·</span>
                                  <span className="kulo-task-device-name">{t(`${ticket.subagentSummary.running} 队友运行中`, `${ticket.subagentSummary.running} teammates active`)}</span>
                                </>
                              )}
                            </span>
                            {durationLabel && <span className="kulo-task-time">{durationLabel}</span>}
                          </span>
                        </Button>
                        {onArchive && (
                          <Tooltip delay={350}>
                            <Button
                              type="button"
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              className="kulo-task-archive-button"
                              aria-label={t(`归档任务：${ticket.title}`, `Archive task: ${ticket.title}`)}
                              isDisabled={!canQueueActions || cardBusy}
                              isPending={archivingIds.has(ticket.id)}
                              onPress={() => handleArchivePress(ticket)}
                            >
                              {archivingIds.has(ticket.id) ? <Spinner size="sm" color="current" /> : <KuloIcon name="archive" size={16} />}
                            </Button>
                            <Tooltip.Content placement="top">{t("归档", "Archive")}</Tooltip.Content>
                          </Tooltip>
                        )}
                      </div>
                    )}
                    {ticket.status === "failed" && onRetry && onIgnore && <div className="kulo-task-card-actions">
                      <TaskFailureActions ticket={ticket} connected={connected} canQueueActions={canQueueActions && !cardBusy}
                        onRetry={id => runAction(id, onRetry, false)} onIgnore={id => runAction(id, onIgnore, true)} />
                    </div>}
                    {ticket.status === "ready" && ticket.pendingWorkspaceApply && onIgnore && <div className="kulo-task-card-actions">
                      <Button
                        size="sm"
                        variant="tertiary"
                        isDisabled={!canQueueActions || cardBusy}
                        isPending={discardingId === ticket.id}
                        aria-label={t(`丢弃并关闭任务：${ticket.title}`, `Discard and close task: ${ticket.title}`)}
                        onPress={() => setDiscardTarget(ticket)}
                      >
                        {t("丢弃并关闭", "Discard & close")}
                      </Button>
                    </div>}
                  </Card.Content>
                </Card>
              </div>
            </ContentPresence>
          </div>;
        })}
      </div>
      {!loaded && rows.length === 0 && orphanPreviews.length === 0 && assistantItems.length === 0 && <div className="kulo-task-empty" role="status"><Spinner size="sm" aria-label={t("加载任务", "Loading tasks")} /></div>}
      {loaded && rows.length === 0 && orphanPreviews.length === 0 && assistantItems.length === 0 && <div className="kulo-task-empty"><KuloIcon name="check" size={20} /><span>{t("暂无后台任务", "No background tasks")}</span></div>}
    </div>
    <ConfirmDialog
      open={Boolean(liveDiscardTarget)}
      title={t("丢弃未合入改动并关闭？", "Discard unmerged changes and close?")}
      description={liveDiscardTarget ? t(`关闭「${liveDiscardTarget.title}」将丢弃隔离副本中尚未合入的改动并释放项目写锁。`, `Closing “${liveDiscardTarget.title}” will discard unmerged staged changes and release the project write lock.`) : undefined}
      confirmLabel={t("丢弃并关闭", "Discard & close")}
      status="danger"
      isPending={Boolean(liveDiscardTarget && discardingId === liveDiscardTarget.id)}
      isConfirmDisabled={!canQueueActions || clearingAll || Boolean(discardingId)}
      onCancel={() => setDiscardTarget(null)}
      onConfirm={() => {
        const discardHandler = onArchive ?? onIgnore;
        if (!liveDiscardTarget || !discardHandler || discardingId) return;
        const target = liveDiscardTarget;
        setDiscardTarget(null);
        setActionError(null);
        setDiscardingId(target.id);
        void runAction(target.id, discardHandler, true)
          .catch((error: unknown) => {
            setActionError(error instanceof Error ? error.message : t("关闭任务失败，请重试。", "Failed to close task. Try again."));
          })
          .finally(() => {
            setDiscardingId((current) => (current === target.id ? null : current));
          });
      }}
    />
    <ConfirmDialog
      open={Boolean(liveActiveTarget)}
      title={t("停止并归档此任务？", "Stop and archive this task?")}
      description={liveActiveTarget ? t(`「${liveActiveTarget.title}」仍在进行中，归档将先停止任务并删除该卡片。`, `“${liveActiveTarget.title}” is still active. Archiving will stop it and delete this card.`) : undefined}
      confirmLabel={t("停止并归档", "Stop & archive")}
      status="danger"
      isPending={Boolean(liveActiveTarget && archivingIds.has(liveActiveTarget.id))}
      isConfirmDisabled={!canQueueActions || clearingAll || Boolean(liveActiveTarget && archivingIds.has(liveActiveTarget.id))}
      onCancel={() => setArchiveActiveTarget(null)}
      onConfirm={() => {
        if (!liveActiveTarget || !onArchive) return;
        const target = liveActiveTarget;
        setArchiveActiveTarget(null);
        void runArchive(target.id, onArchive);
      }}
    />
    <ConfirmDialog
      open={confirmClearAllOpen}
      title={t("清空全部任务卡片？", "Delete all task cards?")}
      description={clearAllDescription}
      confirmLabel={t("全部删除", "Delete all")}
      status="danger"
      isPending={clearingAll}
      isConfirmDisabled={!canQueueActions || clearingAll || desired.length === 0}
      onCancel={() => setConfirmClearAllOpen(false)}
      onConfirm={() => {
        if (!onArchiveAll || !canQueueActions || clearingAll || desired.length === 0) return;
        const ids = desired.map(ticket => ticket.id);
        setConfirmClearAllOpen(false);
        setActionError(null);
        setClearingAll(true);
        void Promise.resolve(onArchiveAll(ids))
          .then(() => {
            requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }));
          })
          .catch((error: unknown) => {
            setActionError(error instanceof Error ? error.message : t("清空任务失败，请重试。", "Failed to delete all tasks. Try again."));
          })
          .finally(() => {
            setClearingAll(false);
          });
      }}
    />
  </div>;
}
