import { useEffect, useRef, useState } from "react";
import { Alert, Button, Popover, Separator, Spinner } from "@heroui/react";
import type { ArchiveMainConversationResult, LiveContextState, TopicCompactResult } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { ArchiveMainDialog } from "./archive-main-dialog";

export function formatContextTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return "";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(Math.round(tokens));
}

export interface TopicContextMenuProps {
  topicId: string;
  conversationId?: number;
  isMasterTopic?: boolean;
  isArchivedTopic?: boolean;
  isLocalTopic: boolean;
  connected: boolean;
  liveBusy: boolean;
  hasMessages?: boolean;
  hasPendingOutbox?: boolean;
  longTermMemoryActive?: boolean;
  context?: LiveContextState;
  onCompact?: (topicId: string) => Promise<TopicCompactResult>;
  onArchiveMain?: (expectedConversationId: number) => Promise<ArchiveMainConversationResult>;
  onMainArchived?: (result: ArchiveMainConversationResult) => void;
}

export function TopicContextMenu({
  topicId,
  conversationId,
  isMasterTopic = false,
  isArchivedTopic = false,
  isLocalTopic,
  connected,
  liveBusy,
  hasMessages = true,
  hasPendingOutbox = false,
  longTermMemoryActive,
  context,
  onCompact = (id) => kuloRest.compactTopic(id),
  onArchiveMain = (expectedConversationId) => kuloRest.archiveMainConversation(expectedConversationId),
  onMainArchived,
}: TopicContextMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [frozenConversationId, setFrozenConversationId] = useState<number | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const activeKey = `${topicId}:${conversationId ?? ""}`;
  const activeKeyRef = useRef(activeKey);
  const dialogRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const isCompacting = Boolean(context?.compacting);

  useEffect(() => {
    activeKeyRef.current = activeKey;
    setSubmitting(false);
    setFeedback(null);
  }, [activeKey]);

  useEffect(() => {
    if (!open || !isCompacting) return;
    const active = document.activeElement;
    if (!active || active === document.body) {
      dialogRef.current?.focus();
    }
  }, [open, isCompacting]);

  if (isLocalTopic) return null;

  const hasError = Boolean(context?.compactionError);
  const isWarning =
    !hasError &&
    context?.tokens !== undefined &&
    context.warnLimit > 0 &&
    context.tokens >= context.warnLimit;

  const tokensLabel =
    context?.tokens !== undefined
      ? t(`约 ${formatContextTokens(context.tokens)}`, `~${formatContextTokens(context.tokens)}`)
      : t("未知", "Unknown");
  const softLimitLabel = context ? formatContextTokens(context.softLimit) : "";
  const windowLabel = context ? formatContextTokens(context.window) : "";

  const triggerAriaLabel = hasError
    ? t("上下文整理异常", "Context compaction issue")
    : context
      ? t(
          `上下文 ${tokensLabel} · 整理阈值 ${softLimitLabel}`,
          `Context ${tokensLabel} · compact threshold ${softLimitLabel}`,
        )
      : t("上下文", "Context");

  const handleCompact = async () => {
    const targetTopicId = topicId;
    const targetKey = activeKey;
    if (!connected || isLocalTopic || isArchivedTopic || submitting || liveBusy || isCompacting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const result = await onCompact(targetTopicId);
      if (activeKeyRef.current !== targetKey) return;
      if (result.compacted) {
        setFeedback({ tone: "info", text: t("已开始整理上下文", "Compacting context") });
      } else {
        setFeedback({ tone: "info", text: t("当前暂无可整理的历史内容", "Nothing to compact yet") });
      }
    } catch (error) {
      if (activeKeyRef.current !== targetKey) return;
      setFeedback({
        tone: "danger",
        text: error instanceof Error ? error.message : t("整理上下文失败", "Could not compact context"),
      });
    } finally {
      if (activeKeyRef.current === targetKey) {
        setSubmitting(false);
      }
    }
  };

  const canArchiveMain =
    isMasterTopic &&
    connected &&
    !liveBusy &&
    !isCompacting &&
    hasMessages &&
    !hasPendingOutbox &&
    conversationId !== undefined;

  return (
    <>
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Button
          ref={triggerRef}
          size="sm"
          isIconOnly
          variant="ghost"
          className="kulo-window-control relative"
          aria-label={triggerAriaLabel}
          isDisabled={!connected}
        >
          {isCompacting ? (
            <Spinner size="sm" aria-label={t("正在整理上下文", "Compacting context")} />
          ) : (
            <KuloIcon
              name="history"
              size={18}
              className={hasError ? "text-danger" : isWarning ? "text-warning" : undefined}
            />
          )}
        </Button>
        <Popover.Content placement="bottom end" className="w-[280px] max-w-[calc(100vw-24px)] motion-reduce:animate-none">
          <Popover.Dialog ref={dialogRef} className="flex flex-col gap-3 outline-none">
            <div className="flex items-center justify-between gap-2">
              <Popover.Heading className="text-sm font-semibold text-foreground">
                {t("上下文", "Context")}
              </Popover.Heading>
              {isCompacting && (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                  <Spinner size="sm" aria-label={t("整理中", "Compacting")} />
                  {t("整理中", "Compacting")}
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-muted">{t("当前占用", "Active")}</span>
                <span className="font-medium text-foreground">
                  {context
                    ? t(`${tokensLabel} · 整理阈值 ${softLimitLabel}`, `${tokensLabel} · target ${softLimitLabel}`)
                    : tokensLabel}
                </span>
              </div>
              {context && (
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-muted">{t("模型窗口", "Model window")}</span>
                  <span className="text-muted">{windowLabel}</span>
                </div>
              )}
            </div>

            {context?.compactionError && (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description className="text-xs">{context.compactionError}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}

            {feedback && (
              feedback.tone === "danger" ? (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description className="text-xs">{feedback.text}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : (
                <p className="text-xs text-muted">{feedback.text}</p>
              )
            )}

            <Separator />

            <div className="flex flex-col gap-2">
              <Button
                size="sm"
                variant="secondary"
                className="w-full"
                isDisabled={!connected || liveBusy || isCompacting || isArchivedTopic}
                isPending={submitting}
                onPress={() => void handleCompact()}
              >
                {t("整理上下文", "Compact context")}
              </Button>
              {isMasterTopic && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
                  isDisabled={!canArchiveMain}
                  onPress={() => {
                    setFrozenConversationId(conversationId);
                    setOpen(false);
                    setArchiveOpen(true);
                  }}
                >
                  {t("归档并开始新对话", "Archive & start fresh")}
                </Button>
              )}
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>

      {isMasterTopic && (
        <ArchiveMainDialog
          open={archiveOpen}
          frozenConversationId={frozenConversationId}
          liveConversationId={conversationId}
          connected={connected}
          longTermMemoryActive={longTermMemoryActive}
          onArchiveMain={onArchiveMain}
          onArchived={onMainArchived}
          onClose={() => setArchiveOpen(false)}
          onCloseComplete={() => {
            setFrozenConversationId(undefined);
            requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
          }}
        />
      )}
    </>
  );
}
