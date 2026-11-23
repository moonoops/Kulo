import { getLanguage, translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Disclosure, FieldError, Input, Label, ListBox, Modal, Select, Spinner, Tabs, TextField, toast } from "@heroui/react";
import type { ConnectionRecordView, ConnectionWorkspaceSnapshot, DeviceInterconnectionView, DeviceInvitation } from "@kulo/protocol";
import { KuloApiError } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { buildDeviceSshAddRequest, deviceApi, isShareableHubUrl } from "./device-api";
import { copyDeviceText } from "./device-clipboard";
import { MobilePairingPanel } from "./mobile-pairing-panel";
import "./add-device-modal.css";

function formatSshEndpoint(connection: ConnectionRecordView): string {
  if (!connection.host) return "";
  const userPart = connection.username ? `${connection.username}@` : "";
  const portPart = connection.port && connection.port !== 22 ? `:${connection.port}` : "";
  return `${userPart}${connection.host}${portPart}`;
}

function formatSshLabel(connection: ConnectionRecordView): string {
  const endpoint = formatSshEndpoint(connection);
  return endpoint ? `${connection.name} (${endpoint})` : connection.name;
}

export function classifySshCredentialsForDevice(
  connections: readonly ConnectionRecordView[],
  boundConnectionIds: ReadonlySet<string>,
) {
  const all = connections.filter((item) => item.kind === "ssh");
  const isEligible = (item: ConnectionRecordView) =>
    item.status === "verified" &&
    item.hasCredential &&
    Boolean(item.host && item.username) &&
    Boolean(item.hostFingerprint) &&
    !boundConnectionIds.has(item.id);
  const eligible = all.filter(isEligible);
  const disabledKeys = all.filter((item) => !isEligible(item)).map((item) => item.id);
  const unverifiedCount = all.filter((item) => !boundConnectionIds.has(item.id) && !isEligible(item)).length;
  return { all, eligible, disabledKeys, unverifiedCount };
}

function sshDisabledTag(item: ConnectionRecordView, boundIds: ReadonlySet<string>): string | null {
  if (boundIds.has(item.id)) return t("已接入", "Added");
  if (item.status === "error") return t("需要处理", "Needs attention");
  if (item.status !== "verified" || !item.hasCredential || !item.host || !item.username || !item.hostFingerprint) {
    return t("待验证", "Unverified");
  }
  return null;
}

export function AddDeviceModal({
  open,
  view,
  pollError,
  connections,
  connectionsLoading = false,
  onOpenSshCredentials,
  onClose,
  onRefresh,
}: {
  open: boolean;
  view: DeviceInterconnectionView;
  pollError?: string;
  connections?: ConnectionWorkspaceSnapshot | null;
  connectionsLoading?: boolean;
  onOpenSshCredentials?: (action: "create" | "verify") => void;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  useI18n();
  const [mode, setMode] = useState("command");
  const [platform, setPlatform] = useState("posix");
  const [hubUrl, setHubUrl] = useState("");
  const [customAddress, setCustomAddress] = useState(false);
  const [name, setName] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [rootDir, setRootDir] = useState("");
  const [invitation, setInvitation] = useState<DeviceInvitation>();
  const [sshDeviceId, setSshDeviceId] = useState<string>();
  const [mobileDeviceId, setMobileDeviceId] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const inviteRef = useRef<DeviceInvitation | undefined>(undefined);
  const requestRef = useRef<AbortController | null>(null);
  const addresses = view.hubUrls.filter(isShareableHubUrl);
  const targetId = mode === "command" ? invitation?.deviceId : mode === "mobile" ? mobileDeviceId : sshDeviceId;
  const target = view.devices.find((device) => device.id === targetId);
  const connected = target?.status === "online";
  const expired = !!invitation && now >= invitation.expiresAt && !connected;
  const addressValid = isShareableHubUrl(hubUrl.trim());

  const boundSshIds = useMemo(
    () => new Set(view.devices.map((device) => device.sshConnectionId).filter((id): id is string => Boolean(id))),
    [view.devices],
  );
  const sshState = useMemo(
    () => classifySshCredentialsForDevice(connections?.connections ?? [], boundSshIds),
    [connections?.connections, boundSshIds],
  );
  const selectedSsh = sshState.eligible.find((item) => item.id === selectedConnectionId);
  const vaultUnavailable = Boolean(connections && !connections.vault.available);

  const cancelInvitation = async () => {
    const current = inviteRef.current;
    if (!current) return;
    try {
      await deviceApi.cancelInvite(current.id);
    } catch (err) {
      if (!(err instanceof KuloApiError && (err.status === 404 || err.status === 410))) throw err;
    }
    if (inviteRef.current?.id === current.id) inviteRef.current = undefined;
  };

  useEffect(() => {
    if (!open) return;
    const initial = view.hubUrls.find(isShareableHubUrl) ?? "";
    setHubUrl(initial);
    setCustomAddress(!initial);
    setName("");
    setSelectedConnectionId(sshState.eligible[0]?.id ?? "");
    setRootDir("");
    setMode("command");
    setPlatform("posix");
    setInvitation(undefined);
    setSshDeviceId(undefined);
    setMobileDeviceId(undefined);
    setBusy(undefined);
    setError(undefined);
    setNow(Date.now());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!selectedConnectionId || !sshState.eligible.some((item) => item.id === selectedConnectionId)) {
      setSelectedConnectionId(sshState.eligible[0]?.id ?? "");
    }
  }, [open, selectedConnectionId, sshState.eligible]);

  useEffect(() => {
    if (!open || !invitation || connected) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, invitation, connected]);

  useEffect(() => () => {
    requestRef.current?.abort();
    const current = inviteRef.current;
    inviteRef.current = undefined;
    if (current) void deviceApi.cancelInvite(current.id).catch((err: unknown) => {
      if (!(err instanceof KuloApiError && (err.status === 404 || err.status === 410))) {
        toast.danger(err instanceof Error ? err.message : t("取消配对失败", "Failed to cancel pairing"));
      }
    });
  }, []);

  const close = async () => {
    if (busy) return;
    setBusy("close");
    try {
      await cancelInvitation();
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : t("取消配对失败", "Failed to cancel pairing"));
    } finally {
      requestRef.current?.abort();
      setBusy(undefined);
      onClose();
      void onRefresh();
    }
  };

  const openSshCredentials = async (action: "create" | "verify") => {
    if (busy || !onOpenSshCredentials) return;
    await close();
    onOpenSshCredentials(action);
  };

  const validateAddress = () => {
    if (addressValid) return true;
    setError(t("请输入其他设备可访问的主机地址，不能使用 localhost 或回环地址。", "Enter a host URL reachable by other devices. Do not use localhost or a loopback address."));
    return false;
  };

  const generate = async () => {
    if (busy || !validateAddress()) return;
    setBusy("invite");
    setError(undefined);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      await cancelInvitation();
      setInvitation(undefined);
      const next = await deviceApi.invite(hubUrl.trim(), name.trim() || undefined, controller.signal);
      if (controller.signal.aborted) return;
      inviteRef.current = next;
      setInvitation(next);
      setNow(Date.now());
      await onRefresh();
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : t("生成接入命令失败", "Failed to generate connection command"));
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
    }
  };

  const addSsh = async () => {
    if (busy || !selectedSsh) return;
    setBusy("ssh");
    setError(undefined);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const request = buildDeviceSshAddRequest({ connectionId: selectedSsh.id, name, rootDir });
      const device = await deviceApi.addSsh(request, controller.signal);
      if (!controller.signal.aborted) {
        setSshDeviceId(device.id);
        await onRefresh();
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : t("添加 SSH 设备失败", "Failed to add SSH device"));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
    }
  };

  const copy = async (value: string) => {
    setError(undefined);
    try {
      await copyDeviceText(value);
      toast.success(t("已复制", "Copied"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("复制失败", "Failed to copy"));
    }
  };

  const changeTarget = (set: (value: string) => void, value: string) => {
    set(value);
    setError(undefined);
  };

  const command = platform === "windows" ? invitation?.windowsCommand : invitation?.command;
  const waiting = !!targetId && !connected && !expired && !target?.error;
  const fieldsDisabled = !!busy || !!invitation || !!sshDeviceId;
  const expiryLabel = invitation ? new Date(invitation.expiresAt).toLocaleTimeString(getLanguage(), { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) void close(); }}>
      <Modal.Backdrop isDismissable={!busy} isKeyboardDismissDisabled={!!busy}>
        <Modal.Container placement="center" size="lg" scroll="inside">
          <Modal.Dialog aria-label={t("添加设备", "Add device")} className="kulo-add-device-dialog">
            <Modal.Header className="kulo-add-device-header">
              <Modal.Heading>{t("添加设备", "Add device")}</Modal.Heading>
              <Modal.CloseTrigger aria-label={t("关闭添加设备", "Close add device")} className="kulo-add-device-close" isDisabled={!!busy} />
            </Modal.Header>
            <Modal.Body className="kulo-add-device-body">
              {connected ? (
                <Alert status="success"><Alert.Indicator /><Alert.Content><Alert.Title>{target.name} {t(" 已连接", " Connected")}</Alert.Title></Alert.Content></Alert>
              ) : (
                <Tabs className="kulo-add-device-tabs" selectedKey={mode} onSelectionChange={(key) => { setMode(String(key)); setError(undefined); }}>
                  <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0"><Tabs.List aria-label={t("设备接入方式", "Device connection method")} className="w-max">
                    <Tabs.Tab id="command" className="w-auto shrink-0 whitespace-nowrap" isDisabled={!!busy || !!sshDeviceId}>{t("运行命令", "Run command")}<Tabs.Indicator /></Tabs.Tab>
                    <Tabs.Tab id="mobile" className="w-auto shrink-0 whitespace-nowrap" isDisabled={!!busy || !!invitation || !!sshDeviceId}>{t("安卓扫码", "Scan with Android")}<Tabs.Indicator /></Tabs.Tab>
                    <Tabs.Tab id="ssh" className="w-auto shrink-0 whitespace-nowrap" isDisabled={!!busy || !!invitation}>{t("SSH 连接", "SSH connection")}<Tabs.Indicator /></Tabs.Tab>
                  </Tabs.List></Tabs.ListContainer>
                  {(error || pollError) && <Alert status="danger" className="kulo-add-device-alert"><Alert.Indicator /><Alert.Content><Alert.Title>{error ?? pollError}</Alert.Title></Alert.Content>
                    {!error && <Button variant="tertiary" size="sm" onPress={() => void onRefresh()}>{t("刷新", "Refresh")}</Button>}
                  </Alert>}
                  <Tabs.Panel id="command" className="kulo-add-device-panel kulo-form-stack">
                    <div className="kulo-form-grid">
                      {addresses.length > 0 && !customAddress ? (
                        <Select className="kulo-form-field" variant="secondary" fullWidth value={hubUrl} isDisabled={fieldsDisabled} onChange={(value) => {
                          if (value === "custom") { setCustomAddress(true); changeTarget(setHubUrl, ""); }
                          else if (value) changeTarget(setHubUrl, String(value));
                        }}>
                          <Label>{t("主机地址", "Host URL")}</Label>
                          <Select.Trigger><Select.Value className="kulo-add-device-address-value" /><Select.Indicator /></Select.Trigger>
                          <Select.Popover><ListBox aria-label={t("主机地址", "Host URL")}>
                            {addresses.map((address) => <ListBox.Item key={address} id={address} textValue={address}>{address}<ListBox.ItemIndicator /></ListBox.Item>)}
                            <ListBox.Item id="custom" textValue={t("自定义地址", "Custom URL")}>{t("自定义地址", "Custom URL")}</ListBox.Item>
                          </ListBox></Select.Popover>
                        </Select>
                      ) : (
                        <TextField className="kulo-form-field" variant="secondary" fullWidth value={hubUrl} onChange={(value) => changeTarget(setHubUrl, value)} isDisabled={fieldsDisabled} isInvalid={!!hubUrl && !addressValid}>
                          <Label>{t("主机地址", "Host URL")}</Label><Input placeholder="http://192.168.1.10:7788" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                          <FieldError>{t("请使用其他设备可访问的 HTTP 地址", "Use an HTTP URL reachable by other devices")}</FieldError>
                        </TextField>
                      )}
                      <Select className="kulo-form-field" variant="secondary" fullWidth value={platform} isDisabled={!!busy} onChange={(value) => value && setPlatform(String(value))}>
                        <Label>{t("目标系统", "Target system")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover><ListBox aria-label={t("目标系统", "Target system")}>
                          <ListBox.Item id="posix" textValue="macOS / Linux">macOS / Linux<ListBox.ItemIndicator /></ListBox.Item>
                          <ListBox.Item id="windows" textValue="Windows PowerShell">Windows PowerShell<ListBox.ItemIndicator /></ListBox.Item>
                        </ListBox></Select.Popover>
                      </Select>
                    </div>
                    <Disclosure className="kulo-add-device-options">
                      <Disclosure.Heading><Disclosure.Trigger className="kulo-add-device-options-trigger">{t("更多选项", "More options")}<Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
                      <Disclosure.Content><Disclosure.Body className="kulo-form-stack kulo-add-device-option-fields">
                        <TextField className="kulo-form-field" variant="secondary" fullWidth value={name} onChange={(value) => changeTarget(setName, value)} isDisabled={fieldsDisabled} maxLength={100}>
                          <Label>{t("设备名称", "Device name")}</Label><Input placeholder={t("自动识别", "Detect automatically")} />
                        </TextField>
                      </Disclosure.Body></Disclosure.Content>
                    </Disclosure>
                    {invitation && <div className="kulo-add-device-command-box">
                      <div className="kulo-add-device-command-heading">
                        <span>{t("接入命令", "Connection command")}</span>
                        {!expired && <Button variant="ghost" size="sm" isPending={busy === "invite"} isDisabled={!!busy} onPress={() => void generate()}><KuloIcon name="refresh" size={14} />{t("重新生成", "Regenerate")}</Button>}
                      </div>
                      <pre className="kulo-add-device-command" tabIndex={0} aria-label={t("设备接入命令", "Device connection command")}>{command}</pre>
                    </div>}
                    {expired && <Alert status="warning"><Alert.Indicator /><Alert.Content><Alert.Title>{t("接入命令已过期", "Connection command expired")}</Alert.Title></Alert.Content></Alert>}
                    {waiting && !pollError && <div className="kulo-add-device-status" role="status"><span className="kulo-add-device-status-label"><Spinner size="sm" />{t("等待设备接入", "Waiting for device")}</span><span className="kulo-add-device-expiry">{t(`${expiryLabel} 前有效`, `Valid until ${expiryLabel}`)}</span></div>}
                  </Tabs.Panel>
                  <Tabs.Panel id="mobile" className="kulo-add-device-panel kulo-form-stack">
                    {open && mode === "mobile" && <MobilePairingPanel view={view} onInvitation={setMobileDeviceId} onRefresh={onRefresh} />}
                  </Tabs.Panel>
                  <Tabs.Panel id="ssh" className="kulo-add-device-panel kulo-form-stack">
                    {connectionsLoading && !connections ? (
                      <div className="kulo-add-device-status" role="status">
                        <span className="kulo-add-device-status-label"><Spinner size="sm" />{t("正在读取 SSH 凭据…", "Loading SSH credentials…")}</span>
                      </div>
                    ) : vaultUnavailable ? (
                      <Alert status="warning">
                        <Alert.Indicator />
                        <Alert.Content><Alert.Title>{t("本地凭据库不可用", "Local credential vault unavailable")}</Alert.Title></Alert.Content>
                      </Alert>
                    ) : sshState.eligible.length > 0 ? (
                      <form id="kulo-device-ssh" className="kulo-form-stack" onSubmit={(event) => { event.preventDefault(); void addSsh(); }}>
                        <Select
                          className="kulo-form-field"
                          variant="secondary"
                          fullWidth
                          isRequired
                          value={selectedConnectionId || null}
                          disabledKeys={sshState.disabledKeys}
                          isDisabled={!!busy || !!sshDeviceId}
                          onChange={(value) => { setSelectedConnectionId(value ? String(value) : ""); setError(undefined); }}
                        >
                          <Label>{t("SSH 凭据", "SSH credential")}</Label>
                          <Select.Trigger>
                            <Select.Value className="kulo-add-device-address-value">
                              {() => selectedSsh ? formatSshLabel(selectedSsh) : t("选择已验证的 SSH 凭据", "Select a verified SSH credential")}
                            </Select.Value>
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox aria-label={t("SSH 凭据", "SSH credential")}>
                              {sshState.all.map((item) => {
                                const endpoint = formatSshEndpoint(item);
                                const tag = sshDisabledTag(item, boundSshIds);
                                return (
                                  <ListBox.Item key={item.id} id={item.id} textValue={formatSshLabel(item)}>
                                    <div className="kulo-add-device-ssh-option">
                                      <span className="kulo-add-device-ssh-option-name">{item.name}</span>
                                      {(endpoint || tag) && (
                                        <span className="kulo-add-device-ssh-option-meta">
                                          {endpoint}{endpoint && tag ? " · " : ""}{tag ?? ""}
                                        </span>
                                      )}
                                    </div>
                                    <ListBox.ItemIndicator />
                                  </ListBox.Item>
                                );
                              })}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                        {onOpenSshCredentials && !sshDeviceId && (
                          <div className="kulo-add-device-ssh-links">
                            <Button size="sm" variant="ghost" isDisabled={!!busy} onPress={() => void openSshCredentials("create")}>
                              <KuloIcon name="add" size={14} />
                              {t("添加 SSH 凭据", "Add SSH credential")}
                            </Button>
                            {sshState.unverifiedCount > 0 && (
                              <Button size="sm" variant="ghost" isDisabled={!!busy} onPress={() => void openSshCredentials("verify")}>
                                {t("前往验证", "Verify credentials")}
                              </Button>
                            )}
                          </div>
                        )}
                        <Disclosure className="kulo-add-device-options">
                          <Disclosure.Heading><Disclosure.Trigger className="kulo-add-device-options-trigger">{t("更多选项", "More options")}<Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
                          <Disclosure.Content><Disclosure.Body className="kulo-form-stack kulo-add-device-option-fields">
                            <TextField className="kulo-form-field" variant="secondary" fullWidth value={rootDir} onChange={(value) => changeTarget(setRootDir, value)} isDisabled={!!busy || !!sshDeviceId}>
                              <Label>{t("工作目录", "Working directory")}</Label><Input placeholder={t("使用默认目录", "Use default directory")} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                            </TextField>
                            <TextField className="kulo-form-field" variant="secondary" fullWidth value={name} onChange={(value) => changeTarget(setName, value)} isDisabled={!!busy || !!sshDeviceId} maxLength={100}>
                              <Label>{t("设备名称", "Device name")}</Label><Input placeholder={selectedSsh?.name ?? t("自动识别", "Detect automatically")} />
                            </TextField>
                          </Disclosure.Body></Disclosure.Content>
                        </Disclosure>
                      </form>
                    ) : (
                      <div className="kulo-add-device-ssh-empty">
                        <span className="kulo-add-device-ssh-empty-title">
                          {sshState.all.length === 0
                            ? t("尚未添加 SSH 凭据", "No SSH credentials added")
                            : sshState.unverifiedCount > 0
                              ? t("暂无已验证的 SSH 凭据", "No verified SSH credentials")
                              : t("已有 SSH 凭据均已接入", "All SSH credentials are already added")}
                        </span>
                        {onOpenSshCredentials && (
                          <div className="kulo-add-device-ssh-empty-actions">
                            {sshState.unverifiedCount > 0 && (
                              <Button size="sm" variant="secondary" isDisabled={!!busy} onPress={() => void openSshCredentials("verify")}>
                                {t("前往验证", "Verify credentials")}
                              </Button>
                            )}
                            <Button size="sm" variant="secondary" isDisabled={!!busy} onPress={() => void openSshCredentials("create")}>
                              <KuloIcon name="add" size={14} />
                              {t("添加 SSH 凭据", "Add SSH credential")}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                    {waiting && !pollError && <div className="kulo-add-device-status" role="status"><span className="kulo-add-device-status-label"><Spinner size="sm" />{t("等待设备上线", "Waiting for device to come online")}</span></div>}
                  </Tabs.Panel>
                  {target?.error && <Alert status="danger" className="kulo-add-device-alert"><Alert.Indicator /><Alert.Content><Alert.Title>{target.error}</Alert.Title></Alert.Content></Alert>}
                </Tabs>
              )}
            </Modal.Body>
            <Modal.Footer className="kulo-add-device-footer">
              <Button variant={connected ? "primary" : "tertiary"} isDisabled={!!busy} onPress={() => void close()}>{connected ? t("完成", "Done") : t("取消", "Cancel")}</Button>
              {!connected && mode === "command" && (invitation && !expired ? <>
                <Button variant="secondary" isDisabled={!!busy} onPress={() => void copy(invitation.agentInstructions)}>{t("复制给 Agent", "Copy for agent")}</Button>
                <Button variant="primary" isDisabled={!!busy} onPress={() => command && void copy(command)}><KuloIcon name="copy" size={16} />{t("复制命令", "Copy command")}</Button>
              </> : <Button variant="primary" isPending={busy === "invite"} isDisabled={!!busy || !addressValid} onPress={() => void generate()}>{expired ? t("重新生成", "Regenerate") : t("生成接入命令", "Generate connection command")}</Button>)}
              {!connected && mode === "ssh" && !sshDeviceId && sshState.eligible.length > 0 && (
                <Button type="submit" form="kulo-device-ssh" variant="primary" isPending={busy === "ssh"} isDisabled={!!busy || !selectedSsh}>
                  {t("添加设备", "Add device")}
                </Button>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
