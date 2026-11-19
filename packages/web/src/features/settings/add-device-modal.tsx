import { getLanguage, translate as t, useI18n } from "../../moco-i18n";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Disclosure, FieldError, Input, Label, ListBox, Modal, Select, Spinner, Tabs, TextField, toast } from "@heroui/react";
import type { DeviceInterconnectionView, DeviceInvitation, DeviceSshScan } from "@moco/protocol";
import { MocoApiError } from "../../moco-api";
import { MocoIcon } from "../../moco-icon";
import { buildDeviceSshRequest, deviceApi, isShareableHubUrl } from "./device-api";
import { copyDeviceText } from "./device-clipboard";
import { MobilePairingPanel } from "./mobile-pairing-panel";
import "./add-device-modal.css";

export function AddDeviceModal({ open, view, pollError, onClose, onRefresh }: {
  open: boolean;
  view: DeviceInterconnectionView;
  pollError?: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  useI18n();
  const [mode, setMode] = useState("command");
  const [platform, setPlatform] = useState("posix");
  const [hubUrl, setHubUrl] = useState("");
  const [customAddress, setCustomAddress] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("22");
  const [rootDir, setRootDir] = useState("");
  const [invitation, setInvitation] = useState<DeviceInvitation>();
  const [scan, setScan] = useState<DeviceSshScan>();
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

  const cancelInvitation = async () => {
    const current = inviteRef.current;
    if (!current) return;
    try {
      await deviceApi.cancelInvite(current.id);
    } catch (err) {
      if (!(err instanceof MocoApiError && (err.status === 404 || err.status === 410))) throw err;
    }
    if (inviteRef.current?.id === current.id) inviteRef.current = undefined;
  };

  useEffect(() => {
    if (!open) return;
    const initial = view.hubUrls.find(isShareableHubUrl) ?? "";
    setHubUrl(initial);
    setCustomAddress(!initial);
    setName("");
    setHost("");
    setUser("");
    setPort("22");
    setRootDir("");
    setMode("command");
    setPlatform("posix");
    setInvitation(undefined);
    setScan(undefined);
    setSshDeviceId(undefined);
    setMobileDeviceId(undefined);
    setBusy(undefined);
    setError(undefined);
    setNow(Date.now());
  }, [open]);

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
      if (!(err instanceof MocoApiError && (err.status === 404 || err.status === 410))) {
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

  const scanSsh = async () => {
    if (busy) return;
    setBusy("scan");
    setError(undefined);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const request = buildDeviceSshRequest({ host, port, user, name, rootDir }, window.location.origin);
      const next = await deviceApi.scanSsh(request, controller.signal);
      if (!controller.signal.aborted) setScan(next);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : t("SSH 连接失败", "SSH connection failed"));
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
    }
  };

  const addSsh = async () => {
    if (busy || !scan) return;
    setBusy("ssh");
    setError(undefined);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const device = await deviceApi.addSsh(scan.scanId, controller.signal);
      if (!controller.signal.aborted) {
        setSshDeviceId(device.id);
        setScan(undefined);
        await onRefresh();
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setScan(undefined);
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
    setScan(undefined);
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
          <Modal.Dialog aria-label={t("添加设备", "Add device")} className="moco-add-device-dialog">
            <Modal.Header className="moco-add-device-header">
              <Modal.Heading>{t("添加设备", "Add device")}</Modal.Heading>
              <Modal.CloseTrigger aria-label={t("关闭添加设备", "Close add device")} className="moco-add-device-close" isDisabled={!!busy} />
            </Modal.Header>
            <Modal.Body className="moco-add-device-body">
              {connected ? (
                <Alert status="success"><Alert.Indicator /><Alert.Content><Alert.Title>{target.name} {t(" 已连接", " Connected")}</Alert.Title></Alert.Content></Alert>
              ) : (
                <Tabs className="moco-add-device-tabs" selectedKey={mode} onSelectionChange={(key) => { setMode(String(key)); setError(undefined); }}>
                  <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0"><Tabs.List aria-label={t("设备接入方式", "Device connection method")} className="w-max">
                    <Tabs.Tab id="command" className="w-auto shrink-0 whitespace-nowrap" isDisabled={!!busy || !!sshDeviceId}>{t("运行命令", "Run command")}<Tabs.Indicator /></Tabs.Tab>
                    <Tabs.Tab id="mobile" className="w-auto shrink-0 whitespace-nowrap" isDisabled={!!busy || !!invitation || !!sshDeviceId}>{t("安卓扫码", "Scan with Android")}<Tabs.Indicator /></Tabs.Tab>
                    <Tabs.Tab id="ssh" className="w-auto shrink-0 whitespace-nowrap" isDisabled={!!busy || !!invitation}>{t("SSH 连接", "SSH connection")}<Tabs.Indicator /></Tabs.Tab>
                  </Tabs.List></Tabs.ListContainer>
                  {(error || pollError) && <Alert status="danger" className="moco-add-device-alert"><Alert.Indicator /><Alert.Content><Alert.Title>{error ?? pollError}</Alert.Title></Alert.Content>
                    {!error && <Button variant="tertiary" size="sm" onPress={() => void onRefresh()}>{t("刷新", "Refresh")}</Button>}
                  </Alert>}
                  <Tabs.Panel id="command" className="moco-add-device-panel moco-form-stack">
                    <div className="moco-form-grid">
                      {addresses.length > 0 && !customAddress ? (
                        <Select className="moco-form-field" variant="secondary" fullWidth value={hubUrl} isDisabled={fieldsDisabled} onChange={(value) => {
                          if (value === "custom") { setCustomAddress(true); changeTarget(setHubUrl, ""); }
                          else if (value) changeTarget(setHubUrl, String(value));
                        }}>
                          <Label>{t("主机地址", "Host URL")}</Label>
                          <Select.Trigger><Select.Value className="moco-add-device-address-value" /><Select.Indicator /></Select.Trigger>
                          <Select.Popover><ListBox aria-label={t("主机地址", "Host URL")}>
                            {addresses.map((address) => <ListBox.Item key={address} id={address} textValue={address}>{address}<ListBox.ItemIndicator /></ListBox.Item>)}
                            <ListBox.Item id="custom" textValue={t("自定义地址", "Custom URL")}>{t("自定义地址", "Custom URL")}</ListBox.Item>
                          </ListBox></Select.Popover>
                        </Select>
                      ) : (
                        <TextField className="moco-form-field" variant="secondary" fullWidth value={hubUrl} onChange={(value) => changeTarget(setHubUrl, value)} isDisabled={fieldsDisabled} isInvalid={!!hubUrl && !addressValid}>
                          <Label>{t("主机地址", "Host URL")}</Label><Input placeholder="http://192.168.1.10:7788" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                          <FieldError>{t("请使用其他设备可访问的 HTTP 地址", "Use an HTTP URL reachable by other devices")}</FieldError>
                        </TextField>
                      )}
                      <Select className="moco-form-field" variant="secondary" fullWidth value={platform} isDisabled={!!busy} onChange={(value) => value && setPlatform(String(value))}>
                        <Label>{t("目标系统", "Target system")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover><ListBox aria-label={t("目标系统", "Target system")}>
                          <ListBox.Item id="posix" textValue="macOS / Linux">macOS / Linux<ListBox.ItemIndicator /></ListBox.Item>
                          <ListBox.Item id="windows" textValue="Windows PowerShell">Windows PowerShell<ListBox.ItemIndicator /></ListBox.Item>
                        </ListBox></Select.Popover>
                      </Select>
                    </div>
                    <Disclosure className="moco-add-device-options">
                      <Disclosure.Heading><Disclosure.Trigger className="moco-add-device-options-trigger">{t("更多选项", "More options")}<Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
                      <Disclosure.Content><Disclosure.Body className="moco-form-stack moco-add-device-option-fields">
                        <TextField className="moco-form-field" variant="secondary" fullWidth value={name} onChange={(value) => changeTarget(setName, value)} isDisabled={fieldsDisabled} maxLength={100}>
                          <Label>{t("设备名称", "Device name")}</Label><Input placeholder={t("自动识别", "Detect automatically")} />
                        </TextField>
                      </Disclosure.Body></Disclosure.Content>
                    </Disclosure>
                    {invitation && <div className="moco-add-device-command-box">
                      <div className="moco-add-device-command-heading">
                        <span>{t("接入命令", "Connection command")}</span>
                        {!expired && <Button variant="ghost" size="sm" isPending={busy === "invite"} isDisabled={!!busy} onPress={() => void generate()}><MocoIcon name="refresh" size={14} />{t("重新生成", "Regenerate")}</Button>}
                      </div>
                      <pre className="moco-add-device-command" tabIndex={0} aria-label={t("设备接入命令", "Device connection command")}>{command}</pre>
                    </div>}
                    {expired && <Alert status="warning"><Alert.Indicator /><Alert.Content><Alert.Title>{t("接入命令已过期", "Connection command expired")}</Alert.Title></Alert.Content></Alert>}
                    {waiting && !pollError && <div className="moco-add-device-status" role="status"><span className="moco-add-device-status-label"><Spinner size="sm" />{t("等待设备接入", "Waiting for device")}</span><span className="moco-add-device-expiry">{t(`${expiryLabel} 前有效`, `Valid until ${expiryLabel}`)}</span></div>}
                  </Tabs.Panel>
                  <Tabs.Panel id="mobile" className="moco-add-device-panel moco-form-stack">
                    {open && mode === "mobile" && <MobilePairingPanel view={view} onInvitation={setMobileDeviceId} onRefresh={onRefresh} />}
                  </Tabs.Panel>
                  <Tabs.Panel id="ssh" className="moco-add-device-panel moco-form-stack">
                    <form id="moco-device-ssh" className="moco-form-stack" onSubmit={(event) => { event.preventDefault(); if (scan) void addSsh(); else void scanSsh(); }}>
                      <div className="moco-form-grid moco-form-grid--port">
                        <TextField className="moco-form-field" variant="secondary" fullWidth value={host} onChange={(value) => changeTarget(setHost, value)} isRequired isDisabled={!!busy || !!sshDeviceId}>
                          <Label>{t("SSH 主机", "SSH host")}</Label><Input placeholder={t("IP、域名或 SSH 别名", "IP, domain, or SSH alias")} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                        </TextField>
                        <TextField className="moco-form-field" variant="secondary" fullWidth value={port} onChange={(value) => changeTarget(setPort, value)} isRequired isDisabled={!!busy || !!sshDeviceId}>
                          <Label>{t("端口", "Port")}</Label><Input inputMode="numeric" pattern="[0-9]+" />
                        </TextField>
                      </div>
                      <Disclosure className="moco-add-device-options">
                        <Disclosure.Heading><Disclosure.Trigger className="moco-add-device-options-trigger">{t("更多选项", "More options")}<Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
                        <Disclosure.Content><Disclosure.Body className="moco-form-stack moco-add-device-option-fields">
                          <TextField className="moco-form-field" variant="secondary" fullWidth value={user} onChange={(value) => changeTarget(setUser, value)} isDisabled={!!busy || !!sshDeviceId}>
                            <Label>{t("用户名", "Username")}</Label><Input placeholder={t("使用 SSH 配置", "Use SSH config")} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                          </TextField>
                          <TextField className="moco-form-field" variant="secondary" fullWidth value={rootDir} onChange={(value) => changeTarget(setRootDir, value)} isDisabled={!!busy || !!sshDeviceId}>
                            <Label>{t("工作目录", "Working directory")}</Label><Input placeholder={t("使用默认目录", "Use default directory")} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                          </TextField>
                          <TextField className="moco-form-field" variant="secondary" fullWidth value={name} onChange={(value) => changeTarget(setName, value)} isDisabled={!!busy || !!sshDeviceId} maxLength={100}>
                            <Label>{t("设备名称", "Device name")}</Label><Input placeholder={t("自动识别", "Detect automatically")} />
                          </TextField>
                        </Disclosure.Body></Disclosure.Content>
                      </Disclosure>
                    </form>
                    {scan && <div className="moco-add-device-fingerprints">
                      <span className="moco-add-device-fingerprint-title"><MocoIcon name="shield" size={16} />{t("核对主机指纹", "Verify host fingerprint")}</span>
                      {scan.fingerprints.map((fingerprint) => <code className="moco-add-device-fingerprint" key={fingerprint}>{fingerprint}</code>)}
                    </div>}
                    {waiting && !pollError && <div className="moco-add-device-status" role="status"><span className="moco-add-device-status-label"><Spinner size="sm" />{t("等待设备上线", "Waiting for device to come online")}</span></div>}
                  </Tabs.Panel>
                  {target?.error && <Alert status="danger" className="moco-add-device-alert"><Alert.Indicator /><Alert.Content><Alert.Title>{target.error}</Alert.Title></Alert.Content></Alert>}
                </Tabs>
              )}
            </Modal.Body>
            <Modal.Footer className="moco-add-device-footer">
              <Button variant={connected ? "primary" : "tertiary"} isDisabled={!!busy} onPress={() => void close()}>{connected ? t("完成", "Done") : t("取消", "Cancel")}</Button>
              {!connected && mode === "command" && (invitation && !expired ? <>
                <Button variant="secondary" isDisabled={!!busy} onPress={() => void copy(invitation.agentInstructions)}>{t("复制给 Agent", "Copy for agent")}</Button>
                <Button variant="primary" isDisabled={!!busy} onPress={() => command && void copy(command)}><MocoIcon name="copy" size={16} />{t("复制命令", "Copy command")}</Button>
              </> : <Button variant="primary" isPending={busy === "invite"} isDisabled={!!busy || !addressValid} onPress={() => void generate()}>{expired ? t("重新生成", "Regenerate") : t("生成接入命令", "Generate connection command")}</Button>)}
              {!connected && mode === "ssh" && !sshDeviceId && <Button type="submit" form="moco-device-ssh" variant="primary" isPending={busy === "scan" || busy === "ssh"} isDisabled={!!busy || !host.trim()}>{scan ? t("信任并添加", "Trust and add") : t("测试连接", "Test connection")}</Button>}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
