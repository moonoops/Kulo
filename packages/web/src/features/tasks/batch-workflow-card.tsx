import { useState } from "react";
import { Button, Card, Chip, Disclosure, ProgressBar, Spinner } from "@heroui/react";
import type { BatchWorkflowCardView, BatchWorkflowItemCardView } from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";

export type BatchWorkflowRetryHandler = (
  batchId: string,
  itemIds?: string[],
) => Promise<void> | void;

export type BatchWorkflowStopHandler = (batchId: string) => Promise<void> | void;

function batchStatusMeta(
  status: BatchWorkflowCardView["status"],
  t: (zh: string, en: string) => string,
): { color: "accent" | "success" | "warning" | "danger" | "default"; label: string } {
  switch (status) {
    case "awaiting_confirmation":
      return { color: "warning", label: t("待人工批准", "Awaiting approval") };
    case "queued":
      return { color: "default", label: t("排队中", "Queued") };
    case "running":
      return { color: "accent", label: t("运行中", "Running") };
    case "completed":
      return { color: "success", label: t("已完成", "Completed") };
    case "partial":
      return { color: "warning", label: t("部分完成", "Partial") };
    case "failed":
      return { color: "danger", label: t("失败", "Failed") };
    case "stopped":
      return { color: "default", label: t("已停止", "Stopped") };
    case "denied":
      return { color: "default", label: t("已拒绝", "Denied") };
  }
}

function itemStatusMeta(
  status: BatchWorkflowItemCardView["status"],
  t: (zh: string, en: string) => string,
): { color: "accent" | "success" | "danger" | "default"; label: string } {
  switch (status) {
    case "running":
      return { color: "accent", label: t("运行中", "Running") };
    case "completed":
      return { color: "success", label: t("已完成", "Done") };
    case "failed":
      return { color: "danger", label: t("失败", "Failed") };
    case "stopped":
      return { color: "default", label: t("已停止", "Stopped") };
    case "pending":
      return { color: "default", label: t("待执行", "Pending") };
  }
}

function previewStructuredOutput(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 220 ? `${text.slice(0, 219)}…` : text;
  } catch {
    return undefined;
  }
}

export function BatchWorkflowCard({
  batch,
  defaultExpanded = false,
  canQueueActions = true,
  onRetryFailed,
  onStop,
}: {
  batch: BatchWorkflowCardView;
  defaultExpanded?: boolean;
  canQueueActions?: boolean;
  onRetryFailed?: BatchWorkflowRetryHandler;
  onStop?: BatchWorkflowStopHandler;
}) {
  const { t } = useI18n();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const statusMeta = batchStatusMeta(batch.status, t);
  const isActive = batch.status === "running" || batch.status === "queued";
  const canStop = (isActive || batch.status === "awaiting_confirmation") && Boolean(onStop);
  const retryableCount =
    batch.counts.failed > 0
      ? batch.counts.failed
      : batch.budgetCapped && batch.counts.pending > 0
        ? batch.counts.pending
        : 0;
  const canRetryAll =
    !isActive &&
    batch.status !== "awaiting_confirmation" &&
    batch.status !== "denied" &&
    retryableCount > 0 &&
    Boolean(onRetryFailed);
  const pendingDisplayCount = batch.counts.pending + batch.counts.running;
  const settledCount = batch.counts.completed + batch.counts.failed + batch.counts.stopped;
  const progressPercent =
    batch.counts.total > 0 ? Math.round((settledCount / batch.counts.total) * 100) : 0;

  const triggerAction = async (key: string, work: () => Promise<void> | void) => {
    if (!canQueueActions || busyKey) return;
    setBusyKey(key);
    setErrorText(null);
    try {
      await work();
    } catch (error) {
      setErrorText(
        error instanceof Error ? error.message : t("批处理操作失败，请重试。", "Batch action failed. Try again."),
      );
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Card
      variant="secondary"
      className="kulo-batch-card"
      data-batch-id={batch.id}
      data-batch-status={batch.status}
    >
      <Card.Content className="flex flex-col gap-2 p-3">
        <Disclosure defaultExpanded={defaultExpanded} className="w-full">
          <Disclosure.Heading level={3}>
            <Disclosure.Trigger className="flex w-full items-start justify-between gap-2 text-left">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <strong className="truncate text-sm font-semibold text-foreground" title={batch.title}>
                    {batch.title}
                  </strong>
                  <Chip size="sm" variant="soft" color="default" className="shrink-0">
                    <span>{t("纯只读", "Read-only")}</span>
                  </Chip>
                  <Chip size="sm" variant="soft" color={statusMeta.color} className="inline-flex shrink-0 items-center gap-1">
                    {batch.status === "running" ? (
                      <Spinner size="sm" color="current" aria-label={statusMeta.label} className="h-3.5 w-3.5" />
                    ) : (
                      <KuloIcon
                        size={13}
                        filled
                        name={
                          batch.status === "completed"
                            ? "check-circle"
                            : batch.status === "failed"
                              ? "error"
                              : batch.status === "awaiting_confirmation" || batch.status === "partial"
                                ? "help"
                                : "schedule"
                        }
                      />
                    )}
                    <span>{statusMeta.label}</span>
                  </Chip>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>{t(`共 ${batch.counts.total} 项`, `${batch.counts.total} total`)}</span>
                  <span>·</span>
                  <span>{t(`已完成 ${batch.counts.completed}`, `${batch.counts.completed} done`)}</span>
                  <span>·</span>
                  <span>{t(`失败 ${batch.counts.failed}`, `${batch.counts.failed} failed`)}</span>
                  <span>·</span>
                  <span>{t(`待执行 ${pendingDisplayCount}`, `${pendingDisplayCount} pending`)}</span>
                  {batch.totalWaves > 1 && (
                    <>
                      <span>·</span>
                      <span>
                        {t(
                          `波次 ${Math.min(batch.currentWave + 1, batch.totalWaves)}/${batch.totalWaves}`,
                          `Wave ${Math.min(batch.currentWave + 1, batch.totalWaves)}/${batch.totalWaves}`,
                        )}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>

          {isActive && (
            <div className="pt-1.5">
              <ProgressBar
                aria-label={t(`批处理进度：${batch.title}`, `Batch progress: ${batch.title}`)}
                value={progressPercent}
                isIndeterminate={batch.counts.running > 0 && settledCount === 0}
                size="sm"
                className="w-full"
              >
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
            </div>
          )}

          {batch.budgetCapped && (
            <p className="pt-1 text-xs text-muted" role="status">
              {batch.budgetCapReason ??
                t(
                  "用量上限已触顶：已停止派发新子项，在途子项单独结算，当前显示部分结果。",
                  "Budget limit reached: stopped dispatching new items; in-flight items settled individually.",
                )}
            </p>
          )}

          {batch.status === "awaiting_confirmation" && (
            <p className="pt-1 text-xs text-muted" role="status">
              {t(
                "超过 6 项，等待你在对话确认卡片中点击批准后启动扇出。",
                "Exceeds 6 items. Approve in the chat confirmation card to start fan-out.",
              )}
            </p>
          )}

          <Disclosure.Content>
            <Disclosure.Body className="flex flex-col gap-2 pt-2">
              <div
                className="flex flex-col gap-1.5"
                role="list"
                aria-label={t(`批处理子项列表：${batch.title}`, `Batch items: ${batch.title}`)}
              >
                {batch.items.map((item) => {
                  const meta = itemStatusMeta(item.status, t);
                  const preview = item.status === "completed" ? previewStructuredOutput(item.validatedOutput) : undefined;
                  const canRetryItem =
                    !isActive &&
                    batch.status !== "awaiting_confirmation" &&
                    batch.status !== "denied" &&
                    (item.status === "failed" || item.status === "stopped" || (batch.budgetCapped && item.status === "pending")) &&
                    Boolean(onRetryFailed);
                  const retryKey = `item:${item.itemId}`;
                  return (
                    <div
                      key={item.itemId}
                      role="listitem"
                      data-batch-item-id={item.itemId}
                      data-batch-item-status={item.status}
                      className="flex flex-col gap-1 rounded-xl border border-border/60 bg-background/60 p-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-foreground" title={item.label}>
                            {item.label}
                          </span>
                          {item.attempts > 1 && (
                            <span className="shrink-0 text-xs text-muted">×{item.attempts}</span>
                          )}
                          {batch.totalWaves > 1 && item.waveIndex !== undefined && (
                            <span className="shrink-0 text-xs text-muted">
                              W{item.waveIndex + 1}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Chip size="sm" variant="soft" color={meta.color}>
                            <span>{meta.label}</span>
                          </Chip>
                          {canRetryItem && (
                            <Button
                              size="sm"
                              variant="secondary"
                              isDisabled={!canQueueActions || Boolean(busyKey)}
                              isPending={busyKey === retryKey}
                              aria-label={t(`重试子项：${item.label}`, `Retry item: ${item.label}`)}
                              onPress={() => void triggerAction(retryKey, () => onRetryFailed!(batch.id, [item.itemId]))}
                            >
                              {t("重试", "Retry")}
                            </Button>
                          )}
                        </div>
                      </div>
                      {item.error && (
                        <p className="break-words text-xs text-muted">{item.error}</p>
                      )}
                      {preview && (
                        <p className="break-words font-mono text-xs text-muted">{preview}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>

        {(canRetryAll || canStop) && (
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {canRetryAll && (
              <Button
                size="sm"
                variant="secondary"
                isDisabled={!canQueueActions || Boolean(busyKey)}
                isPending={busyKey === "retry-all"}
                aria-label={t(`重试失败项：${batch.title}`, `Retry failed items: ${batch.title}`)}
                onPress={() => void triggerAction("retry-all", () => onRetryFailed!(batch.id))}
              >
                {batch.counts.failed > 0
                  ? t(`重试失败项 (${batch.counts.failed})`, `Retry failed (${batch.counts.failed})`)
                  : t(`继续剩余项 (${batch.counts.pending})`, `Resume pending (${batch.counts.pending})`)}
              </Button>
            )}
            {canStop && (
              <Button
                size="sm"
                variant="ghost"
                isDisabled={!canQueueActions || Boolean(busyKey)}
                isPending={busyKey === "stop"}
                aria-label={t(`停止批处理：${batch.title}`, `Stop batch: ${batch.title}`)}
                onPress={() => void triggerAction("stop", () => onStop!(batch.id))}
              >
                {t("停止", "Stop")}
              </Button>
            )}
          </div>
        )}

        {errorText && (
          <p className="text-xs text-danger" role="alert">
            {errorText}
          </p>
        )}
      </Card.Content>
    </Card>
  );
}

export function BatchWorkflowSection({
  batches,
  canQueueActions = true,
  defaultExpanded = false,
  onRetryFailed,
  onStop,
}: {
  batches?: readonly BatchWorkflowCardView[];
  canQueueActions?: boolean;
  defaultExpanded?: boolean;
  onRetryFailed?: BatchWorkflowRetryHandler;
  onStop?: BatchWorkflowStopHandler;
}) {
  const { t } = useI18n();
  if (!batches || batches.length === 0) return null;

  return (
    <section
      className="flex flex-col gap-2 pb-3"
      aria-label={t("只读批处理进度", "Read-only batch workflows")}
    >
      {batches.map((batch) => (
        <BatchWorkflowCard
          key={batch.id}
          batch={batch}
          defaultExpanded={defaultExpanded}
          canQueueActions={canQueueActions}
          onRetryFailed={onRetryFailed}
          onStop={onStop}
        />
      ))}
    </section>
  );
}
