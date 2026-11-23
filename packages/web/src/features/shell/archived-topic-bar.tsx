import { useState } from "react";
import { Button } from "@heroui/react";
import { useI18n } from "../../kulo-i18n";

export function ArchivedTopicBar({
  topicTitle,
  connected,
  onRestore,
}: {
  topicTitle: string;
  connected: boolean;
  onRestore: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [restoring, setRestoring] = useState(false);

  const handleRestore = async () => {
    if (!connected || restoring) return;
    setRestoring(true);
    try {
      await onRestore();
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
      <span role="status" className="text-sm text-muted">
        {t("此会话已归档，当前为只读", "This conversation is archived and read-only")}
      </span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        isDisabled={!connected || restoring}
        isPending={restoring}
        aria-label={t(`还原“${topicTitle}”`, `Restore “${topicTitle}”`)}
        onPress={() => void handleRestore()}
      >
        {t("还原会话", "Restore")}
      </Button>
    </div>
  );
}
