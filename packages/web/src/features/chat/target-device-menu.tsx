import { useEffect, useState } from "react";
import { Button, Dropdown, Label, Separator } from "@heroui/react";
import type { DeviceInterconnectionView, EnvNodeDescriptor } from "@kulo/protocol";
import { DeviceName, DevicePresence, formatDeviceLabel, orderDevices } from "../../components/device-identity";
import { KuloIcon } from "../../kulo-icon";
import { useI18n } from "../../kulo-i18n";
import { deviceApi } from "../settings/device-api";

const AUTO_DEVICE_KEY = "auto";

export function sortTargetDevices(envs: readonly EnvNodeDescriptor[], currentDeviceId?: string): EnvNodeDescriptor[] {
  return orderDevices(envs, { currentDeviceId, preferHub: true, sortByName: true });
}

export function ChatTargetDeviceMenu({
  envs,
  selectedDeviceId,
  connected = false,
  currentDeviceId,
  disabled = false,
  onSelect,
}: {
  envs: readonly EnvNodeDescriptor[];
  selectedDeviceId: string;
  connected?: boolean;
  currentDeviceId?: string;
  disabled?: boolean;
  onSelect: (deviceId: string) => void;
}) {
  const { t } = useI18n();
  const [deviceView, setDeviceView] = useState<DeviceInterconnectionView>();
  const envKey = envs.map((env) => `${env.id}:${env.name}:${env.online}`).join("|");
  const shouldResolveDevice = connected && currentDeviceId === undefined && (envs.length > 1 || Boolean(selectedDeviceId));

  useEffect(() => {
    if (!shouldResolveDevice) return;
    const controller = new AbortController();
    void deviceApi.get(controller.signal).then((view) => {
      if (!controller.signal.aborted) setDeviceView(view);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) console.warn("[KuloTargetDevice] Failed to resolve current device identity", error);
    });
    return () => controller.abort();
  }, [shouldResolveDevice, envKey]);

  const resolvedCurrentDeviceId = currentDeviceId ?? (deviceView?.currentDeviceKnown === true ? deviceView.currentDeviceId : undefined);
  const knownNames = new Map(deviceView?.devices.map((device) => [device.id, device.name]) ?? []);
  const displayEnvs = envs.map((env) => ({ ...env, name: knownNames.get(env.id) ?? env.name }));
  const sorted = sortTargetDevices(displayEnvs, resolvedCurrentDeviceId);
  const selectedDevice = selectedDeviceId ? sorted.find((env) => env.id === selectedDeviceId) : undefined;
  if (sorted.length <= 1 && !selectedDeviceId) return null;

  const isCurrent = (id: string) => Boolean(resolvedCurrentDeviceId && id === resolvedCurrentDeviceId);
  const selectedLabel = selectedDevice
    ? formatDeviceLabel(selectedDevice.name, isCurrent(selectedDevice.id))
    : selectedDeviceId || t("自动", "Auto");
  const triggerTitle = selectedDevice
    ? `${selectedLabel} · ${selectedDevice.online ? t("在线", "Online") : t("离线", "Offline")}`
    : selectedDeviceId
      ? `${selectedDeviceId} · ${t("离线", "Offline")}`
      : t("自动", "Auto");
  const selectedKey = selectedDeviceId ? `device:${selectedDeviceId}` : AUTO_DEVICE_KEY;
  const disabledKeys = sorted
    .filter((env) => !env.online && env.id !== selectedDeviceId)
    .map((env) => `device:${env.id}`);

  return (
    <Dropdown>
      <Button
        size="sm"
        variant={selectedDeviceId ? "secondary" : "ghost"}
        isDisabled={disabled}
        className="min-w-0 max-w-36 sm:max-w-56 shrink-0 gap-1.5 px-2"
        aria-label={t("执行设备", "Target device")}
      >
        <KuloIcon name="devices" size={16} className="shrink-0 text-muted" />
        {selectedDevice ? <>
          <span className="flex min-w-0 items-center" title={triggerTitle}>
            <DeviceName name={selectedDevice.name} isCurrent={isCurrent(selectedDevice.id)} singleLine />
          </span>
          <DevicePresence online={selectedDevice.online} showOnlineText={false} />
        </> : selectedDeviceId ? <>
          <span className="min-w-0 truncate" title={triggerTitle}>{selectedDeviceId}</span>
          <DevicePresence online={false} showOnlineText={false} />
        </> : (
          <span className="min-w-0 truncate" title={triggerTitle}>{t("自动", "Auto")}</span>
        )}
        <KuloIcon name="chevron-down" size={14} className="shrink-0 text-muted" />
      </Button>
      <Dropdown.Popover placement="bottom end" className="w-72 max-w-[calc(100vw-2rem)]">
        <Dropdown.Menu
          className="kulo-navigation-menu"
          aria-label={t("执行设备", "Target device")}
          selectionMode="single"
          selectedKeys={new Set([selectedKey])}
          disabledKeys={disabledKeys}
          onAction={(key) => {
            const value = String(key);
            onSelect(value === AUTO_DEVICE_KEY ? "" : value.slice("device:".length));
          }}
        >
          <Dropdown.Item id={AUTO_DEVICE_KEY} textValue={t("自动", "Auto")} className="kulo-navigation-menu-item">
            <Dropdown.ItemIndicator />
            <Label className="kulo-navigation-menu-label">{t("自动", "Auto")}</Label>
          </Dropdown.Item>
          <Separator />
          {selectedDeviceId && !selectedDevice && (
            <Dropdown.Item
              id={`device:${selectedDeviceId}`}
              textValue={selectedDeviceId}
              className="kulo-navigation-menu-item"
            >
              <Dropdown.ItemIndicator />
              <Label className="kulo-navigation-menu-label min-w-0 flex-1 whitespace-normal break-words">
                {selectedDeviceId}
              </Label>
              <DevicePresence online={false} className="ml-auto" />
            </Dropdown.Item>
          )}
          {sorted.map((device) => {
            const current = isCurrent(device.id);
            return (
              <Dropdown.Item
                key={device.id}
                id={`device:${device.id}`}
                textValue={formatDeviceLabel(device.name, current)}
                className="kulo-navigation-menu-item"
              >
                <Dropdown.ItemIndicator />
                <Label className="kulo-navigation-menu-label min-w-0 flex-1 whitespace-normal break-words">
                  <DeviceName name={device.name} isCurrent={current} />
                </Label>
                <DevicePresence online={device.online} className="ml-auto" />
              </Dropdown.Item>
            );
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
