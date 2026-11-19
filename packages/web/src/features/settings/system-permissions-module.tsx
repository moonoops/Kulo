import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, Button, Checkbox, Chip, Label, ListBox, Modal, Select, Table } from "@heroui/react";
import { TableStateContext, type Key } from "react-aria-components/Table";
import type { DeviceInterconnectionView, EnvNodeDescriptor, SystemPermissionKind, SystemPermissionState, SystemPermissionStatus } from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { deviceApi } from "./device-api";
import { SettingsList, SettingsSection } from "./settings-layout";
import { authorizeMicrophone, desktopSystemPermissionBridge, guideDesktopPermissions, type SystemPermissionEntry } from "../system-permissions/system-permissions";
import { PermissionStatusLoader, type PermissionStatusSnapshot } from "../system-permissions/permission-status-loader";

const KINDS: readonly SystemPermissionKind[] = ["microphone", "accessibility", "screen"];
type GuideStep = "choose" | "microphone" | "desktop" | "summary";
type GuideState = { selected: SystemPermissionKind[]; step: GuideStep };

function PermissionAction({ cellId, label, disabled, onPress, children }: {
  cellId: Key;
  label: string;
  disabled: boolean;
  onPress: (trigger: Element) => void;
  children: ReactNode;
}) {
  const table = useContext(TableStateContext);
  // Keep the table's keyboard focus on the action cell when a dialog restores its button.
  const rememberCell = () => table?.selectionManager.setFocusedKey(cellId);
  return <Button size="sm" variant="secondary" aria-label={label} isDisabled={disabled} onFocus={rememberCell} onPressStart={rememberCell} onPress={(event) => onPress(event.target)}>{children}</Button>;
}

export function permissionCanBeRequested(state: SystemPermissionState | undefined): boolean {
  return state !== undefined && state !== "granted" && state !== "restricted" && state !== "unsupported";
}

export function SystemPermissionsModule({ envs, connected = true, currentDeviceId, entry, onEntryHandled }: {
  envs: EnvNodeDescriptor[];
  connected?: boolean;
  currentDeviceId?: string;
  entry?: SystemPermissionEntry | null;
  onEntryHandled?: (id: string) => void;
}) {
  const { t } = useI18n();
  const [envId, setEnvId] = useState(() => entry?.envId ?? (currentDeviceId && envs.find((env) => env.id === currentDeviceId)?.id) ?? envs.find((env) => env.kind === "local")?.id ?? envs[0]?.id ?? "");
  const [deviceView, setDeviceView] = useState<DeviceInterconnectionView>();
  const [loader] = useState(() => new PermissionStatusLoader());
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  const [guide, setGuide] = useState<GuideState | null>(null);
  const [busy, setBusy] = useState<"microphone" | "desktop" | "check" | null>(null);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [desktopGuideStarted, setDesktopGuideStarted] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const handledEntry = useRef<string | null>(null);
  const userSelectedEnv = useRef(false);
  const env = envs.find((device) => device.id === envId);
  const resolvedCurrentDeviceId = currentDeviceId
    ?? (deviceView ? (deviceView.currentDeviceKnown === true ? deviceView.currentDeviceId : undefined)
      : desktopSystemPermissionBridge() ? "local" : undefined);
  const envKey = envs.map((device) => `${device.id}:${device.name}:${device.online}`).join("|");
  const desktopError = !env ? t("暂无执行设备", "No execution device")
    : !connected ? t("与中枢连接已断开", "Disconnected from the hub")
      : !env.online ? t("设备离线", "Device is offline")
        : env.platform !== "darwin" ? t("此设备不支持 macOS 系统权限检查", "This device does not support macOS permission checks")
          : !env.capabilities.includes("agent-desktop") ? t("此设备未启用桌面操作", "Desktop control is not enabled on this device") : null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loader.dispose(); }; }, [loader]);
  useEffect(() => {
    if (!connected || currentDeviceId !== undefined) return;
    const controller = new AbortController();
    void deviceApi.get(controller.signal).then((view) => { if (!controller.signal.aborted) setDeviceView(view); }).catch(() => {});
    return () => controller.abort();
  }, [connected, currentDeviceId, envKey]);
  useEffect(() => {
    if (entry?.envId || userSelectedEnv.current || !resolvedCurrentDeviceId) return;
    if (envs.some((device) => device.id === resolvedCurrentDeviceId) && envId !== resolvedCurrentDeviceId) setEnvId(resolvedCurrentDeviceId);
  }, [entry?.envId, resolvedCurrentDeviceId, envs, envId]);
  useEffect(() => { loader.configure(envId, !desktopError, desktopError); }, [loader, envId, desktopError]);
  useEffect(() => {
    const check = () => { if (document.visibilityState !== "hidden") void loader.refresh(); };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [loader]);

  const rawDeviceName = (id: string, fallback: string) => deviceView?.devices.find((device) => device.id === id)?.name ?? fallback;
  const formatDevice = (id: string, name: string) => resolvedCurrentDeviceId && id === resolvedCurrentDeviceId ? t(`${name}（本机）`, `${name} (this device)`) : name;
  const currentClientDevice = resolvedCurrentDeviceId
    ? (deviceView?.devices.find((device) => device.id === resolvedCurrentDeviceId) ?? envs.find((device) => device.id === resolvedCurrentDeviceId))
    : undefined;
  const envDisplayName = env ? formatDevice(env.id, rawDeviceName(env.id, env.name)) : undefined;
  const permission = (kind: SystemPermissionKind, snapshot: PermissionStatusSnapshot = state): SystemPermissionStatus | undefined =>
    kind === "microphone" ? snapshot.microphone ?? undefined : snapshot.desktop?.permissions.find((item) => item.kind === kind);
  const label = (kind: SystemPermissionKind) => kind === "microphone" ? t("麦克风", "Microphone") : kind === "accessibility" ? t("辅助功能", "Accessibility") : t("屏幕录制", "Screen recording");
  const statusLabel = (status: SystemPermissionState | undefined) => ({ granted: t("已授权", "Allowed"), "not-determined": t("未申请", "Not requested"), denied: t("未授权", "Not allowed"), restricted: t("受系统限制", "Restricted"), unknown: t("待确认", "Unknown"), unsupported: t("不支持", "Unsupported") })[status ?? "unknown"];
  const scope = (kind: SystemPermissionKind) => kind === "microphone"
    ? (currentClientDevice ? formatDevice(currentClientDevice.id, currentClientDevice.name) : t("当前客户端", "This client"))
    : (envDisplayName ?? t("未选择设备", "No device selected"));
  const canRequest = (kind: SystemPermissionKind) => permissionCanBeRequested(permission(kind)?.state) && (kind === "microphone" ? !state.microphoneError : !state.desktopError && !desktopError);
  const statusChip = (status: SystemPermissionState | undefined) => <Chip size="sm" variant="soft" color={status === "granted" ? "success" : status === "restricted" || status === "denied" ? "warning" : "default"}><Chip.Label>{statusLabel(status)}</Chip.Label></Chip>;

  const openGuide = useCallback((selected?: SystemPermissionKind[], trigger?: Element) => {
    opener.current = trigger instanceof HTMLElement ? trigger : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setGuideError(null);
    setDesktopGuideStarted(false);
    setGuide({ selected: selected ?? KINDS.filter((kind) => {
      const current = kind === "microphone" ? state.microphone : state.desktop?.permissions.find((item) => item.kind === kind);
      return permissionCanBeRequested(current?.state) && (kind === "microphone" ? !state.microphoneError : !state.desktopError && !desktopError);
    }), step: "choose" });
  }, [state, desktopError]);

  useEffect(() => {
    if (!entry || handledEntry.current === entry.id) return;
    if (entry.envId && envId !== entry.envId) { setEnvId(entry.envId); return; }
    if (state.microphoneChecking || !state.microphone && !state.microphoneError) return;
    if (entry.kind !== "microphone" && state.desktopChecking) return;
    if (entry.kind !== "microphone" && !state.desktop && !state.desktopError) return;
    handledEntry.current = entry.id;
    openGuide([entry.kind]);
    onEntryHandled?.(entry.id);
  }, [entry, envId, state, openGuide, onEntryHandled]);

  const closeGuide = () => {
    setGuide(null);
    setGuideError(null);
    requestAnimationFrame(() => {
      if (!mounted.current) return;
      const target = opener.current;
      if (target?.isConnected && !target.matches(":disabled, [aria-disabled='true']")) target.focus();
      else checkButton.current?.focus();
    });
  };
  const nextStep = (current: GuideState): GuideState => ({ ...current, step: current.step === "choose" && current.selected.includes("microphone") ? "microphone"
    : current.step !== "desktop" && current.selected.some((kind) => kind !== "microphone") ? "desktop" : "summary" });

  useEffect(() => {
    if (!guide || busy || guide.step === "microphone" && state.microphoneChecking || guide.step === "desktop" && state.desktopChecking) return;
    const currentKinds = guide.step === "microphone" ? ["microphone"] : guide.step === "desktop" ? guide.selected.filter((kind) => kind !== "microphone") : [];
    if (currentKinds.length && currentKinds.every((kind) => permission(kind as SystemPermissionKind)?.state === "granted")) {
      setGuide(nextStep(guide));
      setGuideError(null);
    }
  }, [guide, state, busy]);

  const run = async (kind: "microphone" | "desktop") => {
    if (busy || !guide) return;
    setBusy(kind);
    setGuideError(null);
    try {
      if (kind === "microphone") await authorizeMicrophone();
      else {
        if (desktopError) throw new Error(desktopError);
        await guideDesktopPermissions(envId, guide.selected.includes("accessibility") ? "accessibility" : "screen");
        if (mounted.current) setDesktopGuideStarted(true);
      }
      if (kind === "microphone") await loader.refreshMicrophone(); else await loader.refresh();
    } catch (cause) {
      if (mounted.current) setGuideError(cause instanceof Error ? cause.message : t("授权未完成，请重试", "Authorization did not complete. Try again"));
      if (kind === "microphone") await loader.refreshMicrophone(); else await loader.refresh();
    } finally { if (mounted.current) setBusy(null); }
  };
  const checkGuide = async () => {
    if (busy) return;
    setBusy("check");
    setGuideError(null);
    try { if (guide?.step === "microphone") await loader.refreshMicrophone(); else await loader.refresh(); } finally { if (mounted.current) setBusy(null); }
  };

  const micDeniedInBrowser = state.microphone?.state === "denied" && !desktopSystemPermissionBridge();
  const guideKinds = guide?.step === "microphone" ? ["microphone" as const] : guide?.step === "desktop" ? guide.selected.filter((kind) => kind !== "microphone") : guide?.selected ?? [];
  const guideChecking = guide?.step === "microphone" ? state.microphoneChecking : guide?.step === "desktop" ? state.desktopChecking : state.checking;
  const complete = Boolean(guide?.selected.length && guide.selected.every((kind) => permission(kind)?.state === "granted"));

  return <section className="flex min-w-0 flex-col gap-6" aria-label={t("系统权限", "System permissions")}>
    <SettingsSection title={t("权限状态", "Permission status")} action={<div className="kulo-settings-actions">
      <Button ref={checkButton} variant="secondary" isPending={state.checking} onPress={() => void loader.refresh()}>{t("检查权限", "Check permissions")}</Button>
      <Button variant="primary" isDisabled={!KINDS.some(canRequest)} onPress={(event) => openGuide(undefined, event.target)}>{t("开始授权", "Set up permissions")}</Button>
    </div>}>
      {envs.length > 0 && <SettingsList label={t("执行设备", "Execution device")}><Select variant="secondary" className="kulo-settings-row" value={envId || null} onChange={(value) => { if (typeof value === "string") { userSelectedEnv.current = true; setEnvId(value); } }} isDisabled={Boolean(guide)}>
        <Label>{t("桌面执行设备", "Desktop execution device")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover><ListBox>{envs.map((device) => { const itemLabel = formatDevice(device.id, rawDeviceName(device.id, device.name)); return <ListBox.Item key={device.id} id={device.id} textValue={itemLabel}>{itemLabel}{!device.online ? t(" · 离线", " · Offline") : ""}<ListBox.ItemIndicator /></ListBox.Item>; })}</ListBox></Select.Popover>
      </Select></SettingsList>}
      {state.microphoneError && <Alert status="danger" role="alert"><Alert.Content>{state.microphoneError}</Alert.Content></Alert>}
      {state.desktopError && <Alert status={desktopError ? "warning" : "danger"} role={desktopError ? "status" : "alert"}><Alert.Content>{state.desktopError}</Alert.Content></Alert>}
      <Table variant="secondary" className="kulo-settings-table">
        <Table.ScrollContainer className="kulo-settings-table-scroll">
          <Table.Content aria-label={t("系统权限列表", "System permission list")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content">
            <Table.Header>
              <Table.Column id="permission" isRowHeader className="kulo-settings-table-column">{t("权限", "Permission")}</Table.Column>
              <Table.Column id="device" className="kulo-settings-table-column">{t("设备", "Device")}</Table.Column>
              <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-meta">{t("状态", "Status")}</Table.Column>
              <Table.Column id="action" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column>
            </Table.Header>
            <Table.Body>{KINDS.map((kind) => {
              const current = permission(kind);
              const displayState = current?.state ?? (kind !== "microphone" && env && env.platform !== "darwin" ? "unsupported" : undefined);
              return <Table.Row key={kind} id={kind}>
                <Table.Cell className="kulo-settings-table-cell whitespace-nowrap"><span className="kulo-item-title">{label(kind)}</span><div className="kulo-item-description">{kind === "microphone" ? t("语音输入、通话", "Voice input and calls") : kind === "accessibility" ? t("读取和操作应用", "Read and control apps") : t("桌面窗口预览", "Desktop window previews")}</div></Table.Cell>
                <Table.Cell className="kulo-settings-table-cell break-words">{scope(kind)}</Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">{statusChip(displayState)}{current?.detail && <div className="kulo-item-description mt-2 max-w-56 whitespace-normal">{current.detail}</div>}</Table.Cell>
                <Table.Cell focusMode="child" className="kulo-settings-table-cell kulo-settings-table-actions">{({ id }) => <PermissionAction cellId={id!} label={t(`设置${label(kind)}权限`, `Set up ${label(kind)} permission`)} disabled={!canRequest(kind) || (kind === "microphone" ? state.microphoneChecking : state.desktopChecking)} onPress={(trigger) => openGuide([kind], trigger)}>{current?.state === "granted" ? t("已授权", "Allowed") : current?.state === "denied" ? t("前往设置", "Open settings") : t("授权", "Allow")}</PermissionAction>}</Table.Cell>
              </Table.Row>;
            })}</Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </SettingsSection>
    <Modal isOpen={Boolean(guide)} onOpenChange={(open) => { if (!open && !busy) closeGuide(); }}>
      <Modal.Backdrop isDismissable={!busy} isKeyboardDismissDisabled={Boolean(busy)}>
        <Modal.Container placement="center" size="sm" scroll="inside"><Modal.Dialog aria-label={t("权限授权引导", "Permission setup")}>
          <Modal.Header><Modal.Heading>{guide?.step === "choose" ? t("选择权限", "Choose permissions") : guide?.step === "microphone" ? t("麦克风", "Microphone") : guide?.step === "desktop" ? t("桌面权限", "Desktop permissions") : t("授权结果", "Permission results")}</Modal.Heading><Modal.CloseTrigger aria-label={t("关闭", "Close")} isDisabled={Boolean(busy)} /></Modal.Header>
          <Modal.Body className="flex min-w-0 flex-col gap-4">
            {guide?.step === "choose" ? KINDS.map((kind) => <Checkbox key={kind} variant="secondary" isSelected={guide.selected.includes(kind)} isDisabled={!canRequest(kind)} onChange={(checked) => setGuide({ ...guide, selected: checked ? [...guide.selected, kind] : guide.selected.filter((item) => item !== kind) })}>
              <Checkbox.Content className="gap-2"><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span>{label(kind)}<span className="ml-2 text-xs text-muted">{scope(kind)}</span></span></Checkbox.Content>
            </Checkbox>) : <>
              {guide?.step === "microphone" && <p className="text-sm text-muted">{micDeniedInBrowser ? t("在浏览器的网站设置中允许麦克风，然后返回检查。", "Allow the microphone in your browser's site settings, then return to check.") : state.microphone?.state === "denied" ? t("在系统设置中允许麦克风；如系统要求，重启 Kulo 后再检查。", "Allow the microphone in System Settings. Restart Kulo if requested, then check again.") : t("用于当前客户端的语音输入和通话。", "For voice input and calls on this client.")}</p>}
              {guide?.step === "desktop" && <p className="text-sm text-muted">{desktopGuideStarted ? t(`在「${envDisplayName ?? ""}」完成系统授权后，返回检查。`, `Complete authorization on “${envDisplayName ?? ""}”, then return to check.`) : t(`在「${envDisplayName ?? ""}」引导辅助功能与屏幕录制授权。`, `Set up Accessibility and Screen Recording on “${envDisplayName ?? ""}”.`)}</p>}
              {guide?.step === "summary" && <p className="text-sm" role="status">{complete ? t("所选权限已就绪", "Selected permissions are ready") : t("部分权限尚未授权", "Some permissions are still not allowed")}</p>}
              <div className="flex flex-col gap-3">{guideKinds.map((kind) => <div key={kind} className="flex items-center justify-between gap-4"><span className="text-sm">{label(kind)}</span>{statusChip(permission(kind)?.state)}</div>)}</div>
            </>}
            {guideError && <Alert status="danger" role="alert"><Alert.Content>{guideError}</Alert.Content></Alert>}
            {guide?.step !== "choose" && state.microphoneError && guide?.selected.includes("microphone") && <Alert status="danger" role="alert"><Alert.Content>{state.microphoneError}</Alert.Content></Alert>}
            {guide?.step === "desktop" && state.desktopError && <Alert status="danger" role="alert"><Alert.Content>{state.desktopError}</Alert.Content></Alert>}
          </Modal.Body>
          <Modal.Footer>
            {guide?.step === "choose" ? <><Button variant="tertiary" onPress={closeGuide}>{t("取消", "Cancel")}</Button><Button variant="primary" isDisabled={!guide.selected.length} onPress={() => { setGuide(nextStep(guide)); setGuideError(null); }}>{t("继续", "Continue")}</Button></>
              : guide?.step === "summary" ? <><Button variant="secondary" isPending={busy === "check" || state.checking} isDisabled={Boolean(busy && busy !== "check")} onPress={() => void checkGuide()}>{t("重新检查", "Check again")}</Button><Button variant="primary" isDisabled={Boolean(busy)} onPress={closeGuide}>{t("完成", "Done")}</Button></>
                : <><Button variant="tertiary" isDisabled={Boolean(busy)} onPress={() => { if (guide) setGuide(nextStep(guide)); setGuideError(null); }}>{t("跳过", "Skip")}</Button>
                  <Button variant="secondary" isPending={busy === "check" || guideChecking} isDisabled={Boolean(busy && busy !== "check")} onPress={() => void checkGuide()}>{t("重新检查", "Check again")}</Button>
                  {!(guide?.step === "microphone" && micDeniedInBrowser) && <Button variant="primary" isPending={busy === guide?.step} isDisabled={Boolean(busy) || guideChecking || (guide?.step === "microphone" ? !canRequest("microphone") : Boolean(desktopError))} onPress={() => void run(guide?.step === "microphone" ? "microphone" : "desktop")}>{guide?.step === "microphone" ? state.microphone?.state === "denied" ? t("打开系统设置", "Open System Settings") : t("授权麦克风", "Allow microphone") : desktopGuideStarted ? t("打开授权引导", "Open setup guide") : t("开始桌面授权", "Set up desktop permissions")}</Button>}</>}
          </Modal.Footer>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop>
    </Modal>
  </section>;
}
