import {
  compareAssistantItems,
  isAssistantDecisionItem,
  isAssistantItemExpired,
  type AssistantItemView,
} from "@kulo/protocol";

export const DEFAULT_VISIBLE_ASSISTANT_ITEMS = 3;

export function assistantItemAgeLabel(
  timestamp: number,
  now: number,
  t: (zh: string, en: string) => string,
): string {
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 60) return t("刚刚", "Just now");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t(`${diffMin} 分钟前`, `${diffMin}m ago`);
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return t(`${diffHours} 小时前`, `${diffHours}h ago`);
  const diffDays = Math.floor(diffHours / 24);
  return t(`${diffDays} 天前`, `${diffDays}d ago`);
}

export function visibleAssistantItems(
  items: readonly AssistantItemView[],
  now: number,
  protectedIds: ReadonlySet<string> = new Set(),
  optimisticDismissed: ReadonlyMap<string, number> = new Map(),
): AssistantItemView[] {
  return items
    .filter((item) => {
      if (optimisticDismissed.get(item.id) === item.revision) return false;
      if (isAssistantItemExpired(item, now) && !protectedIds.has(item.id)) return false;
      return true;
    })
    .sort(compareAssistantItems);
}

export interface PartitionedAssistantItems {
  displayed: AssistantItemView[];
  hiddenCount: number;
  overflowCount: number;
  dismissibleItems: AssistantItemView[];
}

export function partitionAssistantItems(
  sortedVisible: readonly AssistantItemView[],
  expanded: boolean,
  busyIds: ReadonlySet<string> = new Set(),
): PartitionedAssistantItems {
  const decisionCount = sortedVisible.filter(isAssistantDecisionItem).length;
  const collapseLimit = Math.max(DEFAULT_VISIBLE_ASSISTANT_ITEMS, decisionCount);
  const overflowCount = Math.max(0, sortedVisible.length - collapseLimit);
  const displayed = expanded ? [...sortedVisible] : sortedVisible.slice(0, collapseLimit);
  const hiddenCount = Math.max(0, sortedVisible.length - displayed.length);
  const dismissibleItems = sortedVisible.filter(
    (item) => !isAssistantDecisionItem(item) && !busyIds.has(item.id),
  );
  return { displayed, hiddenCount, overflowCount, dismissibleItems };
}
