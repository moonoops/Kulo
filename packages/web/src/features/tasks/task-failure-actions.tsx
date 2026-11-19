import { useI18n } from "../../moco-i18n";
import { useRef, useState } from "react";
import { Button, Spinner } from "@heroui/react";
import type { TicketCardView } from "@moco/protocol";
import { MocoIcon } from "../../moco-icon";

export type TicketAction = (ticketId: string) => Promise<void> | void;

export function TaskFailureActions({ ticket, connected = true, canQueueActions = connected, onRetry, onIgnore }: {
  ticket: Pick<TicketCardView, "id" | "title" | "cleanupPending">;
  connected?: boolean;
  canQueueActions?: boolean;
  onRetry: TicketAction;
  onIgnore: TicketAction;
}) {
  const { t } = useI18n();
  const busy = useRef(false);
  const [pending, setPending] = useState<"retry" | "ignore">();
  const [error, setError] = useState<string>();

  const run = async (action: "retry" | "ignore") => {
    if (busy.current || !canQueueActions || action === "retry" && ticket.cleanupPending) return;
    busy.current = true;
    setPending(action);
    setError(undefined);
    try {
      await (action === "retry" ? onRetry : onIgnore)(ticket.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : action === "retry" ? t("重试失败，请再试一次。", "Retry failed. Try again.") : t("忽略失败，请再试一次。", "Failed to dismiss. Try again."));
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  };

  return <div className="moco-task-failure-actions">
    <div className="moco-task-action-buttons">
      <Button size="sm" variant="secondary" aria-label={t(`重试任务：${ticket.title}`, `Retry task: ${ticket.title}`)}
        isDisabled={!canQueueActions || Boolean(pending) || ticket.cleanupPending} isPending={pending === "retry"}
        onPress={() => void run("retry")}>
        {pending === "retry" ? <Spinner size="sm" color="current" /> : <MocoIcon name="refresh" size={15} />}

        {t("重试", "Retry")}
      </Button>
      <Button size="sm" variant="ghost" aria-label={t(`忽略任务：${ticket.title}`, `Dismiss task: ${ticket.title}`)}
        isDisabled={!canQueueActions || Boolean(pending)} isPending={pending === "ignore"}
        onPress={() => void run("ignore")}>
        {pending === "ignore" ? <Spinner size="sm" color="current" /> : <MocoIcon name="close" size={15} />}

        {t("忽略", "Dismiss")}
      </Button>
    </div>
    {error && <p className="moco-task-action-error" role="alert">{error}</p>}
  </div>;
}
