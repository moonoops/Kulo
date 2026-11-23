import { useEffect, useState } from "react";
import { Alert, toast } from "@heroui/react";
import type { ArchiveMainConversationResult } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { kuloRest } from "../../kulo-api";
import { useI18n } from "../../kulo-i18n";
import { builtinMemoryApi } from "../settings/builtin-memory-api";

export interface ArchiveMainDialogProps {
  open: boolean;
  frozenConversationId?: number;
  liveConversationId?: number;
  connected: boolean;
  longTermMemoryActive?: boolean;
  onArchiveMain?: (expectedConversationId: number) => Promise<ArchiveMainConversationResult>;
  onArchived?: (result: ArchiveMainConversationResult) => void;
  onClose: () => void;
  onCloseComplete?: () => void;
}

export function ArchiveMainDialog({
  open,
  frozenConversationId,
  liveConversationId,
  connected,
  longTermMemoryActive,
  onArchiveMain = (expectedConversationId) => kuloRest.archiveMainConversation(expectedConversationId),
  onArchived,
  onClose,
  onCloseComplete,
}: ArchiveMainDialogProps) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probedLongTerm, setProbedLongTerm] = useState(false);

  useEffect(() => {
    if (!open || !connected || longTermMemoryActive !== undefined) return;
    const controller = new AbortController();
    void builtinMemoryApi
      .getState(controller.signal)
      .then((state) => {
        if (!controller.signal.aborted) {
          setProbedLongTerm(Boolean(state.supersededByHindsight || (state.enabled && !state.blocked)));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setProbedLongTerm(false);
        }
      });
    return () => controller.abort();
  }, [open, connected, longTermMemoryActive]);

  const effectiveLongTermMemory = longTermMemoryActive ?? probedLongTerm;

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setError(null);
      setProbedLongTerm(false);
      return;
    }
    // Auto-close if another tab or client rotated the main conversation while this dialog was open.
    if (
      !submitting &&
      frozenConversationId !== undefined &&
      liveConversationId !== undefined &&
      liveConversationId !== frozenConversationId
    ) {
      onClose();
    }
  }, [open, submitting, frozenConversationId, liveConversationId, onClose]);

  const handleConfirm = async () => {
    if (!connected || submitting || frozenConversationId === undefined) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onArchiveMain(frozenConversationId);
      onArchived?.(result);
      onClose();
      if (result.archived) {
        toast.success(
          result.memoryFlush === "scheduled" || result.memoryFlush === "merged_pending"
            ? t("已归档主对话，后台正在整理记忆", "Main chat archived; extracting notes in the background")
            : t("已归档主对话并开始新对话", "Main chat archived and started fresh"),
        );
      } else {
        toast(t("当前主对话暂无可归档内容", "Nothing to archive in the main chat yet"));
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("归档主对话失败，请稍后重试。", "Could not archive the main conversation. Try again."),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      status="warning"
      title={t("归档并开始新对话", "Archive & start fresh")}
      confirmLabel={t("归档并开始新对话", "Archive & start fresh")}
      cancelLabel={t("取消", "Cancel")}
      isPending={submitting}
      isConfirmDisabled={!connected || frozenConversationId === undefined}
      isKeyboardDismissDisabled={submitting}
      onConfirm={() => void handleConfirm()}
      onCancel={onClose}
      onCloseComplete={onCloseComplete}
      description={
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            {effectiveLongTermMemory
              ? t(
                  "当前主对话将移入「已归档会话」，后台自动整理未提取内容到记忆，随后开始空白主对话。",
                  "Moves this main chat to Archived Conversations, extracts remaining notes to memory in the background, and starts a blank main chat.",
                )
              : t(
                  "当前主对话将移入「已归档会话」，本地工作记忆保留关键结论，随后开始空白主对话。",
                  "Moves this main chat to Archived Conversations, keeps key local working-memory notes, and starts a blank main chat.",
                )}
          </p>
          {error && (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description className="text-xs">{error}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}
        </div>
      }
    />
  );
}
