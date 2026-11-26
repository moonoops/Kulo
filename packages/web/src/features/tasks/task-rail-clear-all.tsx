import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, Spinner, Tooltip } from "@heroui/react";
import type { TicketCardView, TopicSummary } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import {
  buildTopicTitleMap,
  expandClearAllTicketIds,
  groupVisibleTaskCards,
  isTaskUnfinished,
  visibleTaskCards,
} from "./task-model";
import { useTaskClock } from "./use-task-clock";

export type ArchiveAllTicketsHandler = (ticketIds: readonly string[]) => Promise<void> | void;
export type ArchiveSingleTicketHandler = (ticketId: string) => Promise<void> | void;

export async function archiveTicketsBatch(
  ticketIds: readonly string[],
  archiveTicket: ArchiveSingleTicketHandler,
  fallbackError: string,
): Promise<void> {
  const uniqueIds = Array.from(new Set(ticketIds));
  if (!uniqueIds.length) return;
  const results = await Promise.allSettled(uniqueIds.map((ticketId) => archiveTicket(ticketId)));
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed.length > 0) {
    const first = failed[0]!.reason;
    throw first instanceof Error ? first : new Error(fallbackError);
  }
}

export function buildClearAllDescription(
  tickets: readonly TicketCardView[],
  t: (zh: string, en: string) => string,
  activeTopicId?: string,
): string {
  const grouped = activeTopicId !== undefined ? groupVisibleTaskCards(tickets, activeTopicId) : undefined;
  const topicBreakdown =
    grouped && grouped.other.length > 0
      ? t(
          `含当前话题 ${grouped.current.length} 张、其他话题 ${grouped.other.length} 张`,
          `including ${grouped.current.length} in current topic and ${grouped.other.length} in other topics`,
        )
      : undefined;
  const activeCount = tickets.filter(isTaskUnfinished).length;
  const pendingMergeCount = tickets.filter(
    (ticket) => ticket.status === "ready" && ticket.pendingWorkspaceApply,
  ).length;
  const parts = [
    topicBreakdown,
    activeCount > 0
      ? t(
          `${activeCount} 项进行中任务将被停止`,
          `${activeCount} active task${activeCount === 1 ? "" : "s"} will be stopped`,
        )
      : undefined,
    pendingMergeCount > 0
      ? t(
          `${pendingMergeCount} 项未合入改动将被丢弃`,
          `${pendingMergeCount} unmerged staged change${pendingMergeCount === 1 ? "" : "s"} will be discarded`,
        )
      : undefined,
  ].filter(Boolean);
  return parts.length > 0
    ? t(
        `将删除右侧全部 ${tickets.length} 张任务卡片（${parts.join("，")}）。`,
        `Delete all ${tickets.length} task cards (${parts.join(", ")}).`,
      )
    : t(`将删除右侧全部 ${tickets.length} 张任务卡片。`, `Delete all ${tickets.length} task cards.`);
}

export interface TaskRailClearAllActionProps {
  tickets: readonly TicketCardView[];
  activeTopicId?: string;
  completedTaskDisplayHours?: 1 | 3 | 6 | null;
  projectedTicketId?: string;
  canQueueActions?: boolean;
  clearingAll?: boolean;
  onClearingAllChange?: (clearing: boolean) => void;
  onArchiveAll?: ArchiveAllTicketsHandler;
  onCleared?: () => void;
  onError?: (message: string | null) => void;
}

export function TaskRailClearAllAction({
  tickets,
  activeTopicId,
  completedTaskDisplayHours = 3,
  projectedTicketId,
  canQueueActions = true,
  clearingAll: controlledClearingAll,
  onClearingAllChange,
  onArchiveAll,
  onCleared,
  onError,
}: TaskRailClearAllActionProps) {
  const { t } = useI18n();
  const now = useTaskClock();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uncontrolledClearingAll, setUncontrolledClearingAll] = useState(false);
  const clearingAll = controlledClearingAll ?? uncontrolledClearingAll;
  const setClearingAll = onClearingAllChange ?? setUncontrolledClearingAll;

  const protectedIds = useMemo(
    () => (projectedTicketId ? new Set([projectedTicketId]) : new Set<string>()),
    [projectedTicketId],
  );
  const visibleTickets = useMemo(
    () => visibleTaskCards(tickets, now, completedTaskDisplayHours, protectedIds),
    [tickets, now, completedTaskDisplayHours, protectedIds],
  );

  useEffect(() => {
    if (visibleTickets.length === 0 && !clearingAll) {
      setConfirmOpen(false);
      onError?.(null);
    }
  }, [visibleTickets.length, clearingAll, onError]);

  if (!onArchiveAll || visibleTickets.length === 0) {
    return null;
  }

  const clearAllDescription = buildClearAllDescription(visibleTickets, t, activeTopicId);

  return (
    <>
      <Tooltip delay={350}>
        <Button
          type="button"
          size="sm"
          isIconOnly
          variant="ghost"
          className="kulo-window-control"
          aria-label={t("一键全删所有任务卡片", "Delete all task cards")}
          isDisabled={!canQueueActions || clearingAll}
          isPending={clearingAll}
          onPress={() => setConfirmOpen(true)}
        >
          {clearingAll ? <Spinner size="sm" color="current" /> : <KuloIcon name="delete" size={18} />}
        </Button>
        <Tooltip.Content placement="bottom">
          {t(`一键全删 (${visibleTickets.length})`, `Delete all (${visibleTickets.length})`)}
        </Tooltip.Content>
      </Tooltip>
      <ConfirmDialog
        open={confirmOpen}
        title={t("清空全部任务卡片？", "Delete all task cards?")}
        description={clearAllDescription}
        confirmLabel={t("全部删除", "Delete all")}
        status="danger"
        isPending={clearingAll}
        isConfirmDisabled={!canQueueActions || clearingAll || visibleTickets.length === 0}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          if (!onArchiveAll || !canQueueActions || clearingAll || visibleTickets.length === 0) return;
          const ids = expandClearAllTicketIds(tickets, visibleTickets);
          setConfirmOpen(false);
          onError?.(null);
          setClearingAll(true);
          void Promise.resolve(onArchiveAll(ids))
            .then(() => {
              onCleared?.();
            })
            .catch((error: unknown) => {
              onError?.(
                error instanceof Error
                  ? error.message
                  : t("清空任务失败，请重试。", "Failed to delete all tasks. Try again."),
              );
            })
            .finally(() => {
              setClearingAll(false);
            });
        }}
      />
    </>
  );
}

export interface TaskRailClearAllHostResult {
  headerAction: ReactNode;
  railProps: {
    activeTopicId?: string;
    topicTitles?: ReadonlyMap<string, string>;
    clearingAll: boolean;
    clearAllError: string | null;
    onClearAllError: () => void;
    scrollContainerRef: RefObject<HTMLDivElement | null>;
  };
}

export function useTaskRailClearAllHost({
  tickets,
  activeTopicId,
  topics,
  mainChatTitle,
  completedTaskDisplayHours = 3,
  projectedTicketId,
  canQueueActions = true,
  onArchiveTicket,
  onArchiveAll,
}: {
  tickets: readonly TicketCardView[];
  activeTopicId?: string;
  topics?: readonly TopicSummary[];
  mainChatTitle?: string;
  completedTaskDisplayHours?: 1 | 3 | 6 | null;
  projectedTicketId?: string;
  canQueueActions?: boolean;
  onArchiveTicket?: ArchiveSingleTicketHandler;
  onArchiveAll?: ArchiveAllTicketsHandler;
}): TaskRailClearAllHostResult {
  const { t } = useI18n();
  const [clearingAll, setClearingAll] = useState(false);
  const [clearAllError, setClearAllError] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const topicTitles = useMemo(() => buildTopicTitleMap(topics, mainChatTitle), [topics, mainChatTitle]);
  const clearError = useCallback(() => setClearAllError(null), []);
  const handleCleared = useCallback(() => {
    requestAnimationFrame(() => scrollContainerRef.current?.focus({ preventScroll: true }));
  }, []);
  const archiveAllHandler = useMemo<ArchiveAllTicketsHandler | undefined>(() => {
    if (onArchiveAll) return onArchiveAll;
    if (!onArchiveTicket) return undefined;
    return (ids) =>
      archiveTicketsBatch(
        ids,
        onArchiveTicket,
        t("部分任务删除失败，请重试。", "Some tasks could not be deleted. Try again."),
      );
  }, [onArchiveAll, onArchiveTicket, t]);

  const headerAction = (
    <TaskRailClearAllAction
      tickets={tickets}
      activeTopicId={activeTopicId}
      completedTaskDisplayHours={completedTaskDisplayHours}
      projectedTicketId={projectedTicketId}
      canQueueActions={canQueueActions}
      clearingAll={clearingAll}
      onClearingAllChange={setClearingAll}
      onArchiveAll={archiveAllHandler}
      onCleared={handleCleared}
      onError={setClearAllError}
    />
  );

  return {
    headerAction,
    railProps: {
      ...(activeTopicId !== undefined ? { activeTopicId } : {}),
      ...(topicTitles ? { topicTitles } : {}),
      clearingAll,
      clearAllError,
      onClearAllError: clearError,
      scrollContainerRef,
    },
  };
}
