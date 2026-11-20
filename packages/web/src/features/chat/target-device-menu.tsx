import { Button, Dropdown, Label, Separator } from "@heroui/react";
import type { EnvNodeDescriptor } from "@kulo/protocol";
import { KuloIcon } from "../../kulo-icon";
import { useI18n } from "../../kulo-i18n";

const AUTO_DEVICE_KEY = "auto";

export function sortTargetDevices(envs: readonly EnvNodeDescriptor[]): EnvNodeDescriptor[] {
  return [...envs].sort((a, b) => {
    if (a.id === "local" && b.id !== "local") return -1;
    if (b.id === "local" && a.id !== "local") return 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function ChatTargetDeviceMenu({
  envs,
  selectedDeviceId,
  disabled = false,
  onSelect,
}: {
  envs: readonly EnvNodeDescriptor[];
  selectedDeviceId: string;
  disabled?: boolean;
  onSelect: (deviceId: string) => void;
}) {
  const { t } = useI18n();
  const sorted = sortTargetDevices(envs);
  const selectedDevice = selectedDeviceId ? sorted.find((env) => env.id === selectedDeviceId) : undefined;
  if (sorted.length <= 1 && !selectedDeviceId) return null;

  const triggerLabel = selectedDeviceId
    ? selectedDevice?.name ?? selectedDeviceId
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
        className="min-w-0 max-w-44 shrink-0 gap-1.5 px-2"
        aria-label={t("执行设备", "Target device")}
      >
        <KuloIcon name="devices" size={16} className="shrink-0 text-muted" />
        <span className="min-w-0 truncate" title={triggerLabel}>{triggerLabel}</span>
        {selectedDeviceId && selectedDevice && !selectedDevice.online && (
          <span className="shrink-0 text-xs text-muted">{t("离线", "Offline")}</span>
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
              <span className="ml-auto shrink-0 text-xs text-muted">{t("离线", "Offline")}</span>
            </Dropdown.Item>
          )}
          {sorted.map((device) => (
            <Dropdown.Item
              key={device.id}
              id={`device:${device.id}`}
              textValue={device.name}
              className="kulo-navigation-menu-item"
            >
              <Dropdown.ItemIndicator />
              <Label className="kulo-navigation-menu-label min-w-0 flex-1 whitespace-normal break-words">
                {device.name}
              </Label>
              <span className="ml-auto shrink-0 text-xs text-muted">
                {device.online ? t("在线", "Online") : t("离线", "Offline")}
              </span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
