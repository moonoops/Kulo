import { Button, Input } from "@heroui/react";
import type { DeviceInterconnectionView } from "@moco/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { apiRequest } from "../../moco-api";
import { useI18n } from "../../moco-i18n";
import { MocoIcon } from "../../moco-icon";
import { deviceApi } from "../settings/device-api";
import { deviceInvitationCopies, type IssuedInvitation } from "./device-invitation-copies";

export function DeviceInvitationCopy({ hubId, hubName, connected, deliveryScope, partId }: {
  hubId: string; hubName: string; connected: boolean; deliveryScope?: string; partId: string;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<DeviceInterconnectionView>();
  const [attempt, setAttempt] = useState(0);
  const [viewError, setViewError] = useState("");
  const snapshot = () => deviceInvitationCopies.get(deliveryScope, partId);
  const copy = useSyncExternalStore(deviceInvitationCopies.subscribe, snapshot, snapshot);
  const busy = copy.status === "copying";
  const copied = copy.status === "copied";
  const manual = copy.status === "manual" ? copy.invitation : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setViewError("");
    void deviceApi.get(controller.signal).then((next) => {
      if (!controller.signal.aborted) setView(next);
    }, (cause: unknown) => {
      if (!controller.signal.aborted) setViewError(cause instanceof Error ? cause.message : t("无法读取设备状态。", "Could not read device status."));
    });
    return () => { controller.abort(); };
  }, [hubId, attempt, t]);

  useEffect(() => {
    if (copy.status === "failed") setAttempt((current) => current + 1);
    if (copy.status === "copied" || copy.status === "manual") setView((current) => current ? { ...current, enabled: true } : current);
  }, [copy]);

  const local = view?.hubId === hubId && view.role === "hub" && view.currentDeviceId === "local" && view.currentDeviceKnown === true;
  function issue() {
    if (connected && local && view && deliveryScope) {
      void deviceInvitationCopies.copy(deliveryScope, partId, (signal) => apiRequest<IssuedInvitation>("/api/devices/chat-invitations", {
        method: "POST", body: { hubId, enable: !view.enabled }, signal,
      }));
    }
  }

  if (view && !local) return <span className="text-sm text-muted">{t(`请在主脑「${hubName}」上复制接入指令。`, `Copy this instruction on the Hub “${hubName}”.`)}</span>;
  if (!connected && !busy && !copied && !manual) return <span className="text-sm text-muted">{t("连接主脑后可复制接入指令。", "Reconnect to the Hub to copy the instruction.")}</span>;
  const retry = !view && Boolean(viewError);
  const error = viewError || (copy.status === "failed" ? copy.message : "");
  return <div className="flex flex-col items-start gap-2">
    <Button size="sm" variant="secondary" isDisabled={!connected || !deliveryScope || (!view && !retry) || busy} isPending={busy} onPress={() => {
      if (retry) setAttempt((current) => current + 1);
      else issue();
    }}>
      <MocoIcon name="copy" size={16} />
      {retry ? t("重试", "Retry") : view && !view.enabled ? t("开启互联并复制", "Enable connections and copy") : t("复制接入指令", "Copy connection instruction")}
    </Button>
    {error && <span role="alert" className="text-sm">{error}</span>}
    <span role="status" className={copied || manual ? "text-sm text-muted" : "sr-only"}>{copied
      ? t("已复制，粘贴到另一台 Moco 的主会话即可。", "Copied. Paste it into the other Moco’s main chat.")
      : manual ? t("浏览器未允许自动复制，请选中下方指令复制。", "Select and copy the instruction below. The browser blocked automatic copying.") : ""}</span>
    {manual && <Input variant="secondary" fullWidth className="moco-context-field" readOnly autoFocus autoComplete="off"
      aria-label={t("接入指令", "Connection instruction")} value={manual.instruction} onFocus={(event) => event.currentTarget.select()} />}
  </div>;
}
