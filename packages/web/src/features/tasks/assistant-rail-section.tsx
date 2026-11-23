import { useEffect, useMemo, useState, type RefObject } from "react";
import { Button, Card, Dropdown, Label, Spinner, Tooltip } from "@heroui/react";
import { isAssistantDecisionItem, type AssistantItemAction, type AssistantItemView } from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { dismissAssistantItems, type DismissAssistantItemsResult } from "./assistant-rail-api";
import {
  assistantItemAgeLabel,
  partitionAssistantItems,
  visibleAssistantItems,
} from "./assistant-rail-model";

export type AssistantDismissAllHandler = (
  items: readonly AssistantItemView[],
) => Promise<Pick<DismissAssistantItemsResult, "dismissedIds"> | void> | Pick<DismissAssistantItemsResult, "dismissedIds"> | void;

export interface AssistantRailState {
  visibleItems: AssistantItemView[];
  busyIds: ReadonlySet<string>;
  setBusyIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  hoveredId: string | undefined;
  setHoveredId: React.Dispatch<React.SetStateAction<string | undefined>>;
  focusedId: string | undefined;
  setFocusedId: React.Dispatch<React.SetStateAction<string | undefined>>;
  openMenuId: string | undefined;
  setOpenMenuId: React.Dispatch<React.SetStateAction<string | undefined>>;
  optimisticDismissed: ReadonlyMap<string, number>;
  setOptimisticDismissed: React.Dispatch<React.SetStateAction<ReadonlyMap<string, number>>>;
}

export function useAssistantRailState(
  assistantItems: readonly AssistantItemView[],
  now: number,
): AssistantRailState {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string>();
  const [focusedId, setFocusedId] = useState<string>();
  const [openMenuId, setOpenMenuId] = useState<string>();
  const [optimisticDismissed, setOptimisticDismissed] = useState<ReadonlyMap<string, number>>(new Map());

  useEffect(() => {
    setOptimisticDismissed((current) => {
      if (current.size === 0) return current;
      const liveById = new Map(assistantItems.map((item) => [item.id, item.revision]));
      let changed = false;
      const next = new Map<string, number>();
      for (const [id, dismissedRev] of current) {
        const liveRev = liveById.get(id);
        if (liveRev === undefined || liveRev > dismissedRev) {
          changed = true;
        } else {
          next.set(id, dismissedRev);
        }
      }
      return changed ? next : current;
    });
  }, [assistantItems]);

  const protectedIds = useMemo(
    () => new Set([hoveredId, focusedId, openMenuId, ...busyIds].filter((id): id is string => Boolean(id))),
    [hoveredId, focusedId, openMenuId, busyIds],
  );

  const visibleItems = useMemo(
    () => visibleAssistantItems(assistantItems, now, protectedIds, optimisticDismissed),
    [assistantItems, now, protectedIds, optimisticDismissed],
  );

  return {
    visibleItems,
    busyIds,
    setBusyIds,
    hoveredId,
    setHoveredId,
    focusedId,
    setFocusedId,
    openMenuId,
    setOpenMenuId,
    optimisticDismissed,
    setOptimisticDismissed,
  };
}

export function AssistantRailSection({
  state,
  now,
  hasTasks,
  connected,
  onAssistantItemAction,
  onAssistantDismissAll,
  onActionError,
  scrollRef,
  listRef,
}: {
  state: AssistantRailState;
  now: number;
  hasTasks: boolean;
  connected: boolean;
  onAssistantItemAction?: (item: AssistantItemView, action: AssistantItemAction) => Promise<void> | void;
  onAssistantDismissAll?: AssistantDismissAllHandler;
  onActionError: (message: string | null) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);

  const { displayed, hiddenCount, overflowCount, dismissibleItems } = useMemo(
    () => partitionAssistantItems(state.visibleItems, expanded, state.busyIds),
    [state.visibleItems, expanded, state.busyIds],
  );

  useEffect(() => {
    if (overflowCount === 0 && expanded) setExpanded(false);
  }, [overflowCount, expanded]);

  if (state.visibleItems.length === 0) return null;

  const focusAfterRemoval = (preferredIndex: number) => {
    requestAnimationFrame(() => {
      const cards = Array.from(scrollRef.current?.querySelectorAll<HTMLButtonElement>('[data-assistant-open="true"]') ?? []);
      const nextButton = cards[Math.min(Math.max(0, preferredIndex), Math.max(0, cards.length - 1))]
        ?? listRef.current?.querySelector<HTMLButtonElement>(".kulo-task-card-button")
        ?? scrollRef.current;
      nextButton?.focus({ preventScroll: true });
    });
  };

  const runAssistantAction = async (item: AssistantItemView, action: AssistantItemAction) => {
    if (!onAssistantItemAction || !connected || clearingAll || state.busyIds.has(item.id)) return;
    const index = displayed.findIndex((entry) => entry.id === item.id);
    onActionError(null);
    state.setBusyIds((current) => {
      const next = new Set(current);
      next.add(item.id);
      return next;
    });
    try {
      await onAssistantItemAction(item, action);
      if (action === "acknowledge" || action === "mute_app" || action === "confirm_action") {
        focusAfterRemoval(index < 0 ? 0 : index);
      }
    } catch (error) {
      onActionError(error instanceof Error ? error.message : t("处理事项失败，请重试。", "Failed to update item. Try again."));
    } finally {
      state.setBusyIds((current) => {
        if (!current.has(item.id)) return current;
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  const runDismissAll = async () => {
    if (!onAssistantItemAction || !connected || clearingAll || state.busyIds.size > 0 || dismissibleItems.length === 0) return;
    const targets = [...dismissibleItems];
    onActionError(null);
    setClearingAll(true);
    try {
      const result = onAssistantDismissAll
        ? await onAssistantDismissAll(targets)
        : await dismissAssistantItems(targets);
      const dismissedSet = result && Array.isArray(result.dismissedIds)
        ? new Set(result.dismissedIds)
        : new Set(targets.map((item) => item.id));
      state.setOptimisticDismissed((current) => {
        const next = new Map(current);
        for (const item of targets) {
          if (dismissedSet.has(item.id)) next.set(item.id, item.revision);
        }
        return next;
      });
      focusAfterRemoval(0);
    } catch (error) {
      onActionError(error instanceof Error ? error.message : t("清空提醒失败，请重试。", "Failed to dismiss reminders. Try again."));
    } finally {
      setClearingAll(false);
    }
  };

  const showDismissAll = Boolean(onAssistantItemAction && dismissibleItems.length >= 2);
  const showFooter = overflowCount > 0 || showDismissAll;

  return (
    <section
      className="kulo-assistant-rail-section"
      aria-label={t("待关注事项", "Items to review")}
      data-has-tasks={hasTasks || undefined}
    >
      {displayed.map((item) => {
        const pendingState = item.pendingAction?.executionState ?? "none";
        const isDispatched = pendingState === "dispatched";
        const isUnknown = pendingState === "unknown";
        const itemBusy = (clearingAll && !isAssistantDecisionItem(item)) || state.busyIds.has(item.id) || isDispatched;
        const sourceText = item.envName ? `${item.sourceLabel} · ${item.envName}` : item.sourceLabel;
        const timeText = assistantItemAgeLabel(item.updatedAt, now, t);
        const actionStatusNotice = isUnknown
          ? (item.pendingAction?.lastError || t("操作已发出但未确认结果，请核对目标应用后再收起。", "Action was sent without confirmation. Verify in the target app before dismissing."))
          : item.pendingAction?.lastError;
        return (
          <div
            className="kulo-task-space"
            key={item.id}
            data-assistant-item-id={item.id}
            onPointerEnter={(event) => { if (event.pointerType !== "touch") state.setHoveredId(item.id); }}
            onPointerLeave={() => state.setHoveredId((current) => current === item.id ? undefined : current)}
            onFocusCapture={() => state.setFocusedId(item.id)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                state.setFocusedId((current) => current === item.id ? undefined : current);
              }
            }}
          >
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
                      <Dropdown
                        onOpenChange={(open) => {
                          state.setOpenMenuId((current) => open ? item.id : (current === item.id ? undefined : current));
                        }}
                      >
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
      {showFooter && (
        <div className="kulo-assistant-rail-footer">
          {overflowCount > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="kulo-task-clear-all"
              aria-expanded={expanded}
              onPress={() => setExpanded((current) => !current)}
            >
              <KuloIcon name={expanded ? "chevron-up" : "chevron-down"} size={16} />
              {expanded
                ? t("收起", "Show less")
                : t(`还有 ${hiddenCount} 条提醒`, `${hiddenCount} more`)}
            </Button>
          )}
          {showDismissAll && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="kulo-task-clear-all"
              style={{ marginInlineStart: "auto" }}
              aria-label={t("全部知道了", "Dismiss all reminders")}
              isDisabled={!connected || clearingAll || state.busyIds.size > 0}
              isPending={clearingAll}
              onPress={() => void runDismissAll()}
            >
              {clearingAll ? <Spinner size="sm" color="current" /> : <KuloIcon name="check" size={16} />}
              {t("全部知道了", "Dismiss all")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
