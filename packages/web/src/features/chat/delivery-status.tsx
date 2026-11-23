import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { translate as t } from "../../kulo-i18n";
import {
  chatDeliveryLabel,
  type ChatViewItem,
  type PendingSubmissionBackup,
  type SubmissionState,
} from "./chat-submissions";
import { legacyInvitationCode } from "./device-invitation-outbox";

/** Keep normal connected sends visually quiet unless delivery stalls beyond this threshold. */
export const TRANSIENT_DELIVERY_DELAY_MS = 2000;

export function isTransientDeliveryState(state: SubmissionState | undefined, connected: boolean): boolean {
  return connected && (state === "queued" || state === "sending");
}

export function visibleChatDeliveryLabel(
  item: ChatViewItem,
  connected: boolean,
  now: number,
): string | undefined {
  const label = chatDeliveryLabel(item);
  if (!label) return undefined;
  if (isTransientDeliveryState(item.clientSubmission?.state, connected)) {
    const elapsed = item.createdAt !== undefined ? now - item.createdAt : 0;
    if (elapsed < TRANSIENT_DELIVERY_DELAY_MS) return undefined;
  }
  return label;
}

export function visibleTaskSubmissionStatus(
  submission: PendingSubmissionBackup | undefined,
  connected: boolean,
  now: number,
): string | undefined {
  if (!submission) return undefined;
  if (isTransientDeliveryState(submission.state, connected) && now - submission.createdAt < TRANSIENT_DELIVERY_DELAY_MS) {
    return undefined;
  }
  return submission.state === "sending"
    ? t("发送中", "Sending")
    : submission.state === "queued"
      ? t("待发送", "Queued")
      : t("待确认", "Awaiting confirmation");
}

export function nextTransientDeliveryRevealMs(
  entries: readonly { state?: SubmissionState; createdAt?: number }[],
  connected: boolean,
  now: number,
): number | undefined {
  if (!connected) return undefined;
  let soonest: number | undefined;
  for (const entry of entries) {
    if (!isTransientDeliveryState(entry.state, connected) || entry.createdAt === undefined) continue;
    const remaining = entry.createdAt + TRANSIENT_DELIVERY_DELAY_MS - now;
    if (remaining <= 0) continue;
    soonest = soonest === undefined ? remaining : Math.min(soonest, remaining);
  }
  return soonest;
}

export function useDeliveryStatusClock(
  entries: readonly { state?: SubmissionState; createdAt?: number }[],
  connected: boolean,
): number {
  const [, setTick] = useState(0);
  const now = Date.now();
  const delay = nextTransientDeliveryRevealMs(entries, connected, now);
  useEffect(() => {
    if (delay === undefined) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [delay]);
  return now;
}

export function UserDeliveryStatus({
  item,
  status,
  backup,
  outboxReady,
  editing,
  isLastPaused,
  resumingPaused,
  liveBusy,
  onRetry,
  onEdit,
  onResumePaused,
}: {
  item: ChatViewItem;
  status: string | undefined;
  backup: PendingSubmissionBackup | undefined;
  outboxReady: boolean;
  editing: boolean;
  isLastPaused: boolean;
  resumingPaused: boolean;
  liveBusy: boolean;
  onRetry: (backup: PendingSubmissionBackup) => void;
  onEdit: (backup: PendingSubmissionBackup) => void;
  onResumePaused: () => void;
}) {
  if (!status) return null;
  const state = item.clientSubmission?.state;
  const name = item.text.trim().slice(0, 24) || item.attachments?.[0]?.name || t("附件消息", "Attachment message");
  const canRetry = Boolean(
    backup &&
    state === "failed" &&
    item.clientSubmission?.errorCode !== "request_intent_conflict" &&
    item.clientSubmission?.errorCode !== legacyInvitationCode,
  );
  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5 text-xs text-muted">
      <span className={state === "failed" ? "min-w-0 max-w-full break-words text-danger" : undefined} role={state === "failed" ? "alert" : "status"}>
        {status}
      </span>
      {canRetry && backup && (
        <Button size="sm" variant="ghost" isDisabled={!outboxReady || editing} aria-label={t(`重试发送：${name}`, `Retry sending: ${name}`)} onPress={() => onRetry(backup)}>
          {t("重试发送", "Retry sending")}
        </Button>
      )}
      {backup && state === "failed" && (
        <Button size="sm" variant="ghost" aria-label={t(`编辑未发送的消息：${name}`, `Edit unsent message: ${name}`)} onPress={() => onEdit(backup)}>
          {t("编辑", "Edit")}
        </Button>
      )}
      {item.delivery === "paused" && isLastPaused && (
        <Button size="sm" variant="secondary" isPending={resumingPaused} isDisabled={!outboxReady || liveBusy || resumingPaused} onPress={onResumePaused}>
          {t("继续处理", "Resume")}
        </Button>
      )}
    </div>
  );
}
