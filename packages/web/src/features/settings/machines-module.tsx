import { translate as t, useI18n } from "../../kulo-i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Chip, Dropdown, Input, Label, Modal, Popover, Skeleton, Switch, TextField, toast } from "@heroui/react";
import type { DeviceInterconnectionView, EnvNodeDescriptor, InterconnectedDevice } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { KuloApiError } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { AddDeviceModal } from "./add-device-modal";
import { JoinDeviceModal } from "./join-device-modal";
import { deviceApi } from "./device-api";
import { deviceAddresses } from "./device-addresses";
import { copyDeviceText } from "./device-clipboard";
import type { SettingsAssistantEntryIntent } from "./settings-assistant-actions";
import { SettingsSection } from "./settings-layout";
import "./device-interconnection.css";

const statusLabels = () => ({ online: t("在线", "Online"), offline: t("离线", "Offline"), pending: t("等待接入", "Awaiting connection") });

function deviceSystem(device: InterconnectedDevice): string {
  if (!device.info) return "";
  const names: Record<string, string> = { darwin: "macOS", macos: "macOS", win32: "Windows", windows: "Windows", linux: "Linux", android: "Android" };
  return [names[device.info.platform] ?? device.info.platform, device.info.arch].filter(Boolean).join(" · ");
}

function deviceMemory(device: InterconnectedDevice): string {
  return device.info && device.info.memoryBytes > 0 ? `${Math.round(device.info.memoryBytes / 1024 ** 3 * 10) / 10} GB` : "";
}

function DeviceStatus({ status }: { status: InterconnectedDevice["status"] }) {
  useI18n();
  return <Chip className="kulo-device-status" size="sm" variant="soft" color={status === "online" ? "success" : status === "pending" ? "warning" : "default"}>
    <span className="kulo-device-status-dot" aria-hidden="true" /><Chip.Label>{statusLabels()[status]}</Chip.Label>
  </Chip>;
}

function DeviceAddresses({ device }: { device: InterconnectedDevice }) {
  useI18n();
  const addresses = deviceAddresses(device.info?.ips ?? []);
  const copy = async (address: string) => {
    try {
      await copyDeviceText(address);
      toast.success(t("IP 地址已复制", "IP address copied"));
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : t("复制失败", "Failed to copy"));
    }
  };
  if (!addresses.all.length) return null;
  return <div className="kulo-device-network">
    <div className="kulo-device-address-preview" aria-label={t("常用 IP 地址", "Common IP addresses")}>
      {addresses.preview.map((address) => <code className="kulo-device-ip" key={address}>{address}</code>)}
    </div>
    <Popover>
      <Button size="sm" variant="ghost" className="kulo-device-address-trigger" aria-label={t(`查看${device.name}的全部 ${addresses.all.length} 个 IP 地址`, `View all ${addresses.all.length} IP addresses for ${device.name}`)}>
        {addresses.all.length > 2 ? t(`全部 ${addresses.all.length} 个`, `All ${addresses.all.length}`) : t("查看地址", "View addresses")}<KuloIcon name="chevron-down" size={14} />
      </Button>
      <Popover.Content placement="bottom end" className="kulo-device-address-popover">
        <Popover.Dialog className="kulo-device-address-dialog">
          <div className="kulo-device-address-heading"><Popover.Heading>{t("IP 地址", "IP addresses")}</Popover.Heading><span className="text-xs text-muted">{t(`${addresses.all.length} 个`, `${addresses.all.length} addresses`)}</span></div>
          <div className="kulo-device-address-scroll">
            {[{ label: "IPv4", ips: addresses.ipv4 }, { label: "IPv6", ips: addresses.ipv6 }, { label: t("其他", "Other"), ips: addresses.other }].map(({ label, ips }) => {
              return ips.length > 0 && <section key={label} className="kulo-device-address-group" aria-label={label}>
                <h4 className="text-xs font-medium text-muted">{label}</h4>
                {ips.map((address) => <div className="kulo-device-address-item" key={address}>
                  <code>{address}</code>
                  <Button size="sm" variant="ghost" isIconOnly aria-label={t(`复制 ${address}`, `Copy ${address}`)} onPress={() => void copy(address)}><KuloIcon name="copy" size={15} /></Button>
                </div>)}
              </section>;
            })}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  </div>;
}

function DeviceCard({ device, view, disabled, onRename, onRemove }: {
  device: InterconnectedDevice;
  view: DeviceInterconnectionView;
  disabled?: boolean;
  onRename: () => void;
  onRemove: () => void;
}) {
  useI18n();
  const isHub = device.kind === "local";
  const isCurrent = device.id === view.currentDeviceId;
  const role = t(`${isHub ? "主机" : "设备"}${isCurrent ? " · 本机" : ""}`, `${isHub ? "Host" : "Device"}${isCurrent ? " · This device" : ""}`);
  return <Card className="kulo-device-card" variant="default" role="listitem" aria-label={device.name}>
    <Card.Header className="kulo-device-card-header">
      <div className="kulo-device-card-role"><span>{role}</span><DeviceStatus status={device.status} /></div>
      <div className="kulo-device-card-identity">
        <div className="kulo-device-icon"><KuloIcon name="devices" size={22} /></div>
        <Card.Title className="kulo-device-card-name" title={device.name}>{device.name}</Card.Title>
        <div className="kulo-device-actions">
          <Button size="sm" isIconOnly variant="ghost" isDisabled={disabled} aria-label={t(`修改${device.name}的${isHub ? "主机" : "设备"}名称`, `Rename ${isHub ? "host" : "device"} ${device.name}`)} onPress={onRename}><KuloIcon name="edit" size={16} /></Button>
          {!isHub && <Dropdown>
            <Button size="sm" isIconOnly variant="ghost" isDisabled={disabled} aria-label={t(`${device.name}操作`, `Actions for ${device.name}`)}><KuloIcon name="more" size={18} /></Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu aria-label={t(`${device.name}操作`, `Actions for ${device.name}`)} onAction={(key) => key === "rename" ? onRename() : onRemove()}>
                <Dropdown.Item id="rename" textValue={t("重命名", "Rename")}><Label>{t("重命名", "Rename")}</Label></Dropdown.Item>
                <Dropdown.Item id="remove" textValue={t("移除设备", "Remove device")} variant="danger"><Label>{t("移除设备", "Remove device")}</Label></Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>}
        </div>
      </div>
    </Card.Header>
    <Card.Content>
      {device.info ? <dl className="kulo-device-specs">
        <div><dt>{t("系统", "System")}</dt><dd>{deviceSystem(device)}</dd></div>
        {device.info.cpu && <div><dt>{t("处理器", "Processor")}</dt><dd>{device.info.cpu}</dd></div>}
        {deviceMemory(device) && <div><dt>{t("内存", "Memory")}</dt><dd>{deviceMemory(device)}</dd></div>}
      </dl> : <p className="text-sm text-muted">{t("等待设备信息", "Waiting for device information")}</p>}
      {device.error && <p role="alert" className="break-words text-xs text-danger">{device.error}</p>}
    </Card.Content>
    {!!device.info?.ips.length && <Card.Footer className="kulo-device-card-network"><DeviceAddresses device={device} /></Card.Footer>}
  </Card>;
}

export function MachinesModule({
  envs,
  entryIntent,
  onIntentHandled,
  onRoleChanged,
}: {
  envs: EnvNodeDescriptor[];
  entryIntent?: SettingsAssistantEntryIntent | null;
  onIntentHandled?: (id: string) => void;
  onRoleChanged?: () => Promise<void> | void;
}) {
  useI18n();
  const [view, setView] = useState<DeviceInterconnectionView>();
  const [loadingError, setLoadingError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [rename, setRename] = useState<InterconnectedDevice>();
  const [name, setName] = useState("");
  const [renameError, setRenameError] = useState<string>();
  const [confirm, setConfirm] = useState<{ kind: "disable" } | { kind: "leave" } | { kind: "remove"; device: InterconnectedDevice; force?: boolean }>();
  const [confirmError, setConfirmError] = useState<string>();
  const requestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (requestRef.current && !requestRef.current.signal.aborted) return;
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const next = await deviceApi.get(controller.signal);
      if (!controller.signal.aborted) {
        setView(next);
        setLoadingError(undefined);
      }
    } catch (err) {
      if (!controller.signal.aborted) setLoadingError(err instanceof Error ? err.message : t("读取设备失败", "Failed to load devices"));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (joinOpen || (busy && confirm?.kind === "leave")) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      window.clearInterval(timer);
      requestRef.current?.abort();
    };
  }, [refresh, envs, joinOpen, busy, confirm?.kind]);

  const setEnabled = async (enabled: boolean, force = false): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setActionError(undefined);
    setConfirmError(undefined);
    try {
      requestRef.current?.abort();
      const next = await deviceApi.setEnabled(enabled, force);
      requestRef.current?.abort();
      setView(next);
      setConfirm(undefined);
      return true;
    } catch (err) {
      if (!enabled && !force && err instanceof KuloApiError && err.code === "remote_tasks_running") {
        setConfirm({ kind: "disable" });
      } else if (force) {
        setConfirmError(err instanceof Error ? err.message : t("关闭设备互联失败", "Failed to turn off device connections"));
      } else setActionError(err instanceof Error ? err.message : t("更改设备互联失败", "Failed to update device connections"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!entryIntent || entryIntent.module !== "machines" || !view) return;
    onIntentHandled?.(entryIntent.id);
    if (entryIntent.intent === "join-device" && view.role === "hub" && view.canSwitchRole) {
      setJoinOpen(true);
    } else if (entryIntent.intent === "add-device" && view.role === "hub") {
      if (view.enabled) setAddOpen(true);
      else void setEnabled(true).then((ok) => { if (ok) setAddOpen(true); });
    }
  }, [entryIntent, view, onIntentHandled]);

  const leaveHost = async () => {
    if (busy || confirm?.kind !== "leave") return;
    setBusy(true);
    setConfirmError(undefined);
    try {
      await deviceApi.leave();
      setConfirm(undefined);
      requestRef.current?.abort();
      await refresh();
      await onRoleChanged?.();
      toast.success(t("已切换回独立模式", "Switched to standalone mode"));
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : t("断开连接失败", "Failed to disconnect"));
    } finally {
      setBusy(false);
    }
  };

  const handleJoined = async () => {
    setJoinOpen(false);
    requestRef.current?.abort();
    await refresh();
    await onRoleChanged?.();
  };

  const removeDevice = async () => {
    if (busy || confirm?.kind !== "remove") return;
    setBusy(true);
    setConfirmError(undefined);
    try {
      await deviceApi.remove(confirm.device.id, confirm.force);
      setConfirm(undefined);
      requestRef.current?.abort();
      await refresh();
      toast.success(t("设备已移除", "Device removed"));
    } catch (err) {
      if (!confirm.force && err instanceof KuloApiError && err.code === "remote_tasks_running") {
        setConfirm({ ...confirm, force: true });
      } else setConfirmError(err instanceof Error ? err.message : t("移除设备失败", "Failed to remove device"));
    } finally {
      setBusy(false);
    }
  };

  const renameDevice = async () => {
    if (busy || !rename || !name.trim()) return;
    setBusy(true);
    setRenameError(undefined);
    try {
      const next = await deviceApi.rename(rename.id, name.trim());
      requestRef.current?.abort();
      setView(next);
      setRename(undefined);
      toast.success(t(`${rename.kind === "local" ? "主机" : "设备"}已重命名`, `${rename.kind === "local" ? "Host" : "Device"} renamed`));
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : t("重命名失败", "Failed to rename"));
    } finally {
      setBusy(false);
    }
  };

  const hostDevices = view?.devices.filter((device) => device.kind === "local") ?? [];
  const remoteDevices = view?.devices.filter((device) => device.kind !== "local") ?? [];
  const mode = !view?.enabled ? t("单机模式", "Standalone mode") : view.role === "joined" ? t(`已连接主机 ${view.hubName}`, `Connected to host ${view.hubName}`) : t("本机作为主机", "This device is the host");
  const renameKind = rename?.kind === "local" ? t("主机", "Host") : t("设备", "Device");
  const error = actionError ?? loadingError;
  const renderDevice = (device: InterconnectedDevice) => <DeviceCard key={device.id} device={device} view={view!} disabled={busy || Boolean(view?.hubError)}
    onRename={() => { setRename(device); setName(device.name); setRenameError(undefined); }}
    onRemove={() => { setConfirm({ kind: "remove", device }); setConfirmError(undefined); }} />;

  return (
    <div className="kulo-settings-form kulo-device-root">
      {error && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
          <Button size="sm" variant="tertiary" onPress={() => { setActionError(undefined); void refresh(); }}>{t("重试", "Retry")}</Button>
        </Alert>
      )}
      {!view ? (
        !loadingError && <div className="kulo-device-loading" role="status" aria-label={t("正在读取设备", "Loading devices")}>
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-52 w-full rounded-2xl" />
        </div>
      ) : (
        <>
          {view.hubError && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{view.hubError}</Alert.Title></Alert.Content>
            </Alert>
          )}
          <div className="kulo-device-toggle">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-sm font-semibold">{view.role === "joined" ? t("设备互联", "Device connections") : t("启用设备互联", "Enable device connections")}</span>
              <span className="break-words text-xs text-muted" aria-live="polite">{mode}</span>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {view.role === "hub" && view.canSwitchRole && (
                <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => setJoinOpen(true)}>
                  {t("接入现有主机", "Join host")}
                </Button>
              )}
              {view.role === "joined" && view.canSwitchRole ? (
                <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => { setConfirm({ kind: "leave" }); setConfirmError(undefined); }}>
                  {t("断开连接", "Disconnect")}
                </Button>
              ) : (
                <Switch aria-label={t("启用设备互联", "Enable device connections")} isSelected={view.enabled} isDisabled={busy || view.role === "joined"} onChange={(enabled) => void setEnabled(enabled)}>
                  <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
                </Switch>
              )}
            </div>
          </div>
          <SettingsSection title={t("主机", "Host")}>
            <div className="kulo-device-grid kulo-device-host" role="list" aria-label={t("主机列表", "Hosts")}>
              {hostDevices.map(renderDevice)}
            </div>
          </SettingsSection>
          {view.enabled && <SettingsSection title={t("设备", "Device")}>
            <div className="kulo-device-grid" role="list" aria-label={t("设备列表", "Devices")}>
              {remoteDevices.map(renderDevice)}
              {!view.hubError && <Card className="kulo-device-add-card" variant="transparent" role="listitem" aria-label={t("添加设备", "Add device")}>
                <Card.Content className="kulo-device-add-content">
                  <div className="kulo-device-empty-icon"><KuloIcon name="devices" size={26} /></div>
                  {remoteDevices.length === 0 && <p className="text-sm text-muted">{t("尚未添加设备", "No devices added")}</p>}
                  <Button size="sm" variant="primary" isDisabled={busy} onPress={() => setAddOpen(true)}><KuloIcon name="add" size={17} />{t("添加设备", "Add device")}</Button>
                </Card.Content>
              </Card>}
            </div>
          </SettingsSection>}
          <AddDeviceModal open={addOpen} view={view} pollError={loadingError} onClose={() => setAddOpen(false)} onRefresh={refresh} />
          <JoinDeviceModal open={joinOpen} onClose={() => setJoinOpen(false)} onJoined={handleJoined} />
        </>
      )}
      <Modal isOpen={!!rename} onOpenChange={(open) => { if (!open && !busy) setRename(undefined); }}>
        <Modal.Backdrop isDismissable={!busy}>
          <Modal.Container placement="center" size="sm">
            <Modal.Dialog aria-label={t(`重命名${renameKind}`, `Rename ${renameKind}`)}>
              <Modal.Header><Modal.Heading>{t("重命名", "Rename ")}{renameKind}</Modal.Heading><Modal.CloseTrigger aria-label={t(`关闭重命名${renameKind}`, `Close rename ${renameKind}`)} isDisabled={busy} /></Modal.Header>
              <Modal.Body>
                <form id="kulo-device-rename" onSubmit={(event) => { event.preventDefault(); void renameDevice(); }} className="kulo-form-stack">
                  <TextField className="kulo-form-field" variant="secondary" value={name} onChange={setName} isDisabled={busy} isRequired maxLength={100} fullWidth>
                    <Label>{t(`${renameKind}名称`, `${renameKind} name`)}</Label><Input autoFocus />
                  </TextField>
                  {renameError && <Alert status="danger"><Alert.Content><Alert.Title>{renameError}</Alert.Title></Alert.Content></Alert>}
                </form>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" isDisabled={busy} onPress={() => setRename(undefined)}>{t("取消", "Cancel")}</Button>
                <Button type="submit" form="kulo-device-rename" isPending={busy} isDisabled={!name.trim() || busy}>{t("保存", "Save")}</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      <ConfirmDialog open={!!confirm} title={confirm?.kind === "leave" ? t("断开与主机的连接？", "Disconnect from host?") : confirm?.kind === "disable" ? t("关闭设备互联？", "Turn off device connections?") : t(`${confirm?.kind === "remove" && confirm.force ? "中断任务并移除" : "移除"} ${confirm?.kind === "remove" ? confirm.device.name : "设备"}？`, `${confirm?.kind === "remove" && confirm.force ? "Interrupt tasks and remove" : "Remove"} ${confirm?.kind === "remove" ? confirm.device.name : "device"}?`)}
        description={<div className="flex flex-col gap-3">
          <p>{confirm?.kind === "leave" ? t("断开后将切换回本机独立运行模式。", "This device will return to standalone mode.") : confirm?.kind === "disable" ? t("正在执行的远程任务将被中断，已添加的设备会保留。", "Running remote tasks will be interrupted. Added devices will be kept.") : confirm?.kind === "remove" && confirm.force ? t("这台设备上正在执行的任务将被中断，执行连接和界面访问将被撤销。", "Running tasks on this device will be interrupted. Execution connections and interface access will be revoked.") : t("这台设备的执行连接和界面访问将被撤销。", "Execution connections and interface access for this device will be revoked.")}</p>
          {confirmError && <p role="alert" className="text-danger">{confirmError}</p>}
        </div>}
        confirmLabel={confirm?.kind === "leave" ? t("断开连接", "Disconnect") : confirm?.kind === "disable" ? t("中断任务并关闭", "Interrupt tasks and turn off") : confirm?.kind === "remove" && confirm.force ? t("中断任务并移除", "Interrupt tasks and remove") : t("移除设备", "Remove device")} isPending={busy}
        onCancel={() => { setConfirm(undefined); setConfirmError(undefined); }}
        onConfirm={() => confirm?.kind === "leave" ? void leaveHost() : confirm?.kind === "disable" ? void setEnabled(false, true) : void removeDevice()} />
    </div>
  );
}
