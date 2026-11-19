import { useI18n } from "../../moco-i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, Card, Spinner } from "@heroui/react";
import type { TicketCardView } from "@moco/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { MocoIcon } from "../../moco-icon";
import { ContentPresence, useReducedContentMotion } from "../chat/use-content-motion";
import {
  reconcileTaskRows, taskCompletedAt, taskIsRecovering, taskNeedsAttention, taskStatusLabel, taskSummary, taskTimeLabel,
  visibleTaskCards, type TaskRow,
} from "./task-model";
import { TaskFailureActions, type TicketAction } from "./task-failure-actions";
import "./task-rail.css";
import { useTaskClock } from "./use-task-clock";

function RailStatus({ ticket }: { ticket: TicketCardView }) {
  const { t } = useI18n();
  const attention = taskNeedsAttention(ticket);
  const label = ticket.status === "blocked" || ticket.status === "waiting" && ticket.waiting?.reason === "user" ? t("待确认", "Needs confirmation") : taskStatusLabel(ticket);
  const tone = ticket.cleanupPending || ticket.pendingWorkspaceApply ? "ask" : taskIsRecovering(ticket) ? "run" : ticket.status === "failed" ? "fail" : attention ? "ask" : ticket.status === "ready" ? ticket.externalAgentKind ? "wait" : "done" :
    ticket.status === "running" || ticket.status === "pausing" ? "run" : "wait";
  return <span className="moco-task-status" data-tone={tone}>
    {tone === "run" ? <span className="moco-task-run-dot" aria-hidden="true" /> :
      <MocoIcon name={tone === "fail" ? "error" : tone === "ask" ? "help" : tone === "done" ? "check" : "schedule"} size={13} />}
    <span>{label}</span>
  </span>;
}

export function MocoTaskRail({
  tickets, projectedTicketId, onProject, onRetry, onIgnore, completedTaskDisplayHours = 3, connected = true, canQueueActions = connected, loaded = true, snapshotVersion = 0,
}: {
  tickets: TicketCardView[];
  projectedTicketId?: string;
  onProject: (ticketId: string, title?: string) => void;
  onRetry?: TicketAction;
  onIgnore?: TicketAction;
  completedTaskDisplayHours?: 1 | 3 | 6 | null;
  connected?: boolean;
  canQueueActions?: boolean;
  loaded?: boolean;
  snapshotVersion?: number;
}) {
  const { t } = useI18n();
  const now = useTaskClock();
  const [hoveredId, setHoveredId] = useState<string>();
  const [focusedId, setFocusedId] = useState<string>();
  const [discardTarget, setDiscardTarget] = useState<TicketCardView | null>(null);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
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

  const runAction = async (ticketId: string, action: TicketAction, removing: boolean) => {
    const index = rowsRef.current.findIndex(row => row.ticket.id === ticketId);
    await action(ticketId);
    requestAnimationFrame(() => {
      const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
      const remaining = rows.filter(row => !row.querySelector('[inert]'));
      const row = removing ? remaining[Math.min(Math.max(0, index), remaining.length - 1)] : rows.find(row => row.dataset.ticketId === ticketId);
      const target = row?.querySelector<HTMLButtonElement>(".moco-task-card-button") ?? scrollRef.current;
      target?.focus({ preventScroll: true });
    });
  };

  return <div className="moco-task-rail" ref={scrollRef} tabIndex={-1} onScroll={captureAnchor} data-reduced={reduced || undefined}>
    <div className="moco-task-list" ref={listRef}>
      {rows.map(row => {
        const ticket = row.ticket;
        const completed = taskCompletedAt(ticket);
        const age = ticket.status === "ready" && !ticket.pendingWorkspaceApply && completed !== undefined && completedTaskDisplayHours !== null ?
          Math.min(1, Math.max(0, (now - completed) / (completedTaskDisplayHours * 3_600_000))) : 0;
        return <div className="moco-task-row" data-ticket-id={ticket.id} key={ticket.id}
          onPointerEnter={event => { if (event.pointerType !== "touch") setHoveredId(ticket.id); }}
          onPointerLeave={() => setHoveredId(current => current === ticket.id ? undefined : current)}
          onFocusCapture={() => setFocusedId(ticket.id)}
          onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(current => current === ticket.id ? undefined : current); }}>
          <ContentPresence present={row.present} animateEntry={row.enter && loaded && connected} animateExit={!row.instantExit} onExited={() => {
            capturePositions();
            setRows(current => current.filter(item => item.ticket.id !== ticket.id || item.present));
          }}>
            <div className="moco-task-space">
              <Card variant="secondary" className={"moco-task-card" + (row.enter ? " moco-task-enter" : "")}
                data-state={taskIsRecovering(ticket) ? "recovering" : ticket.status} data-attention={taskNeedsAttention(ticket) || undefined} data-selected={projectedTicketId === ticket.id || undefined}
                style={{ "--task-age": age } as CSSProperties}>
                <Card.Content className="moco-task-card-content">
                  <Button type="button" variant="ghost" fullWidth className="moco-task-card-button"
                    aria-label={ticket.title + t("，查看任务详情", ", view task details")} aria-current={projectedTicketId === ticket.id ? "true" : undefined}
                    onPress={() => onProject(ticket.id, ticket.title)}>
                    <span className="moco-task-card-top">
                      <strong className="moco-task-title" title={ticket.title}>{ticket.title}</strong>
                      <RailStatus ticket={ticket} />
                    </span>
                    <span className="moco-task-summary" title={taskSummary(ticket)}>{taskSummary(ticket)}</span>
                    <span className="moco-task-card-foot">
                      <span className="moco-task-agent" title={ticket.roleLabel}>{ticket.roleLabel}</span>
                      <span className="moco-task-time">{taskTimeLabel(ticket, now)}</span>
                    </span>
                  </Button>
                  {ticket.status === "failed" && onRetry && onIgnore && <div className="moco-task-card-actions">
                    <TaskFailureActions ticket={ticket} connected={connected} canQueueActions={canQueueActions}
                      onRetry={id => runAction(id, onRetry, false)} onIgnore={id => runAction(id, onIgnore, true)} />
                  </div>}
                  {ticket.status === "ready" && ticket.pendingWorkspaceApply && onIgnore && <div className="moco-task-card-actions">
                    <Button
                      size="sm"
                      variant="tertiary"
                      isDisabled={!canQueueActions || discardingId === ticket.id}
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
    <ConfirmDialog
      open={Boolean(discardTarget)}
      title={t("丢弃未合入改动并关闭？", "Discard unmerged changes and close?")}
      description={discardTarget ? t(`关闭「${discardTarget.title}」将丢弃隔离副本中尚未合入的改动并释放项目写锁。`, `Closing “${discardTarget.title}” will discard unmerged staged changes and release the project write lock.`) : undefined}
      confirmLabel={t("丢弃并关闭", "Discard & close")}
      status="danger"
      isPending={Boolean(discardTarget && discardingId === discardTarget.id)}
      isConfirmDisabled={!canQueueActions || Boolean(discardingId)}
      onCancel={() => setDiscardTarget(null)}
      onConfirm={() => {
        if (!discardTarget || !onIgnore || discardingId) return;
        const target = discardTarget;
        setDiscardTarget(null);
        setDiscardingId(target.id);
        void runAction(target.id, onIgnore, true).finally(() => {
          setDiscardingId((current) => (current === target.id ? null : current));
        });
      }}
    />
    {!loaded && rows.length === 0 && <div className="moco-task-empty" role="status"><Spinner size="sm" aria-label={t("加载任务", "Loading tasks")} /></div>}
    {loaded && rows.length === 0 && <div className="moco-task-empty"><MocoIcon name="check" size={20} /><span>{t("暂无后台任务", "No background tasks")}</span></div>}
  </div>;
}
