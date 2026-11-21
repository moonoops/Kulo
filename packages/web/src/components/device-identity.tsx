import { translate as translateText, useI18n } from "../kulo-i18n";

export interface OrderableDevice {
  id: string;
  name: string;
  online: boolean;
  kind?: string;
  clusterRole?: string;
}

export function orderDevices<T extends OrderableDevice>(
  devices: readonly T[],
  options?: {
    currentDeviceId?: string;
    preferHub?: boolean;
    sortByName?: boolean;
  },
): T[] {
  const currentDeviceId = options?.currentDeviceId;
  const preferHub = options?.preferHub ?? false;
  const sortByName = options?.sortByName ?? false;
  return devices
    .map((device, index) => ({ device, index }))
    .sort((a, b) => {
      const aCurrent = Boolean(currentDeviceId && a.device.id === currentDeviceId);
      const bCurrent = Boolean(currentDeviceId && b.device.id === currentDeviceId);
      if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      if (a.device.online !== b.device.online) return a.device.online ? -1 : 1;
      if (preferHub) {
        const aHub = a.device.kind === "local" || a.device.clusterRole === "primary" || a.device.id === "local";
        const bHub = b.device.kind === "local" || b.device.clusterRole === "primary" || b.device.id === "local";
        if (aHub !== bHub) return aHub ? -1 : 1;
      }
      if (sortByName) {
        const byName = a.device.name.localeCompare(b.device.name);
        if (byName !== 0) return byName;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.device);
}

export function formatDeviceLabel(name: string, isCurrent: boolean): string {
  return isCurrent ? translateText(`本机 · ${name}`, `This device · ${name}`) : name;
}

export function DeviceStatusDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-online={online}
      className={className ? `kulo-device-presence-dot ${className}` : "kulo-device-presence-dot"}
    />
  );
}

export function DevicePresence({ online, showOnlineText = true, className }: {
  online: boolean;
  showOnlineText?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const label = online ? t("在线", "Online") : t("离线", "Offline");
  return (
    <span className={className ? `kulo-device-presence ${className}` : "kulo-device-presence"}>
      <DeviceStatusDot online={online} />
      {showOnlineText || !online ? <span>{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}

export function DeviceName({ name, isCurrent = false, singleLine = false, className }: {
  name: string;
  isCurrent?: boolean;
  singleLine?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  if (singleLine) {
    return (
      <span className={className ? `kulo-device-name kulo-device-name--single ${className}` : "kulo-device-name kulo-device-name--single"}>
        {isCurrent && <span className="kulo-device-local-tag">{t("本机", "This device")}</span>}
        <span className="min-w-0 truncate">{name}</span>
      </span>
    );
  }
  return (
    <span className={className ? `kulo-device-name ${className}` : "kulo-device-name"}>
      {isCurrent && <span className="kulo-device-local-tag">{t("本机", "This device")}</span>}
      <span>{name}</span>
    </span>
  );
}
