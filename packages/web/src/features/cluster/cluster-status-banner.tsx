import { Alert, Button } from "@heroui/react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { useI18n } from "../../kulo-i18n";
import type { ClusterFailoverController } from "./use-cluster-failover";

export function ClusterStatusBanner({ controller }: { controller: ClusterFailoverController }) {
  const { t } = useI18n();
  const {
    status,
    busy,
    hasFailoverOffer,
    hasFailbackOffer,
    hasConflictNotice,
    confirm,
    confirmError,
    requestPromote,
    requestHandover,
    executeConfirm,
    cancelConfirm,
    dismissFailback,
    dismissConflictNotice,
  } = controller;

  const failoverOffer = status?.failoverOffer;
  const promotable = (failoverOffer?.candidates ?? []).filter((c) => c.reachable && c.canPromote);
  const failbackOffer = status?.failbackOffer;

  return (
    <>
      {hasFailoverOffer && failoverOffer && promotable.length > 0 ? (
        <div className="shrink-0 px-4 pt-3">
          <Alert status="warning" className="flex items-center gap-3 rounded-2xl p-3">
            <Alert.Indicator className="shrink-0" />
            <Alert.Content className="min-w-0 flex-1">
              <Alert.Title className="text-sm font-semibold">
                {t(`主机「${failoverOffer.offlinePrimaryName}」暂时失联`, `Host “${failoverOffer.offlinePrimaryName}” is unreachable`)}
              </Alert.Title>
            </Alert.Content>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {promotable.map((candidate) => (
                <Button
                  key={candidate.nodeId}
                  size="sm"
                  variant="primary"
                  isDisabled={busy}
                  onPress={() => requestPromote(candidate)}
                >
                  {promotable.length === 1
                    ? t("切至备用主机", "Switch to standby")
                    : t(`切至 ${candidate.name}`, `Switch to ${candidate.name}`)}
                </Button>
              ))}
            </div>
          </Alert>
        </div>
      ) : hasFailbackOffer && failbackOffer ? (
        <div className="shrink-0 px-4 pt-3">
          <Alert status="default" className="flex items-center gap-3 rounded-2xl p-3">
            <Alert.Indicator className="shrink-0" />
            <Alert.Content className="min-w-0 flex-1">
              <Alert.Title className="text-sm font-semibold">
                {t(`原主机「${failbackOffer.preferredPrimaryName}」已恢复并同步完成`, `Primary host “${failbackOffer.preferredPrimaryName}” is back and synced`)}
              </Alert.Title>
            </Alert.Content>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="tertiary" isDisabled={busy} onPress={dismissFailback}>
                {t("暂不", "Later")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                isDisabled={busy}
                onPress={() => requestHandover(failbackOffer.preferredPrimaryNodeId, failbackOffer.preferredPrimaryName)}
              >
                {t("切回主机", "Switch back")}
              </Button>
            </div>
          </Alert>
        </div>
      ) : hasConflictNotice ? (
        <div className="shrink-0 px-4 pt-3">
          <Alert status="default" className="flex items-center gap-3 rounded-2xl p-3">
            <Alert.Indicator className="shrink-0" />
            <Alert.Content className="min-w-0 flex-1">
              <Alert.Title className="text-sm font-semibold">
                {t("原本地状态已备份并自动同步为最新主机数据", "Previous local state was archived and synced with the active host")}
              </Alert.Title>
            </Alert.Content>
            <Button size="sm" variant="tertiary" onPress={() => void dismissConflictNotice()}>
              {t("知道了", "Dismiss")}
            </Button>
          </Alert>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(confirm)}
        status="warning"
        title={
          confirm?.kind === "failover"
            ? t(`切换至「${confirm.candidate.name}」为主机？`, `Promote “${confirm.candidate.name}” to host?`)
            : confirm?.force
              ? t(`停止当前任务并切换至「${confirm.targetName}」？`, `Stop active work and switch to “${confirm.targetName}”?`)
              : t(`切换主机至「${confirm?.targetName ?? ""}」？`, `Switch host to “${confirm?.targetName ?? ""}”?`)
        }
        description={
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {confirm?.kind === "failover"
                ? t("其他已连接设备将自动接入该主机继续工作。", "Connected devices will reconnect to this host automatically.")
                : confirm?.force
                  ? t("当前进行的对话或后台任务将停止，随后无损切换至目标主机。", "Active chats or background tasks will stop before switching hosts.")
                  : t("将同步最新状态并切换全部设备至该主机。", "Latest state will sync before switching all devices to this host.")}
            </p>
            {confirmError && <p role="alert" className="text-sm text-danger">{confirmError}</p>}
          </div>
        }
        confirmLabel={
          confirm?.kind === "failover"
            ? t("切换为主机", "Switch to host")
            : confirm?.force
              ? t("停止并切换", "Stop and switch")
              : t("确认切换", "Switch host")
        }
        isPending={busy}
        onCancel={cancelConfirm}
        onConfirm={() => void executeConfirm()}
      />
    </>
  );
}
