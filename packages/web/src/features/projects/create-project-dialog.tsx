import { useI18n } from "../../kulo-i18n";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Label, ListBox, Modal, Radio, RadioGroup, Select, Spinner, TextField } from "@heroui/react";
import type { DeviceInterconnectionView, ProjectDirectoryListing, ProjectView } from "@kulo/protocol";
import { DeviceName, DevicePresence, formatDeviceLabel, orderDevices } from "../../components/device-identity";
import { kuloRest } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { desktopFileBridge, type DesktopFileBridge } from "../chat/file-actions";
import { deviceApi } from "../settings/device-api";
import { joinProjectDirectory, projectDirectoryBasename, type ProjectDevice } from "./project-model";

export function ProjectDirectoryBrowser({ listing, browsing, creating, onBrowse }: {
  listing: ProjectDirectoryListing;
  browsing: boolean;
  creating: boolean;
  onBrowse: (path: string) => void;
}) {
  const { t } = useI18n();
  const browserRef = useRef<HTMLElement>(null);
  const entriesRef = useRef<HTMLDivElement>(null);
  const restoreBrowserFocus = useRef(false);
  const entries = listing.entries.filter((entry) => !entry.name.startsWith("."));
  useEffect(() => {
    if (entriesRef.current) entriesRef.current.scrollTop = 0;
  }, [listing.path]);

  useEffect(() => {
    if (browsing || !restoreBrowserFocus.current) return;
    restoreBrowserFocus.current = false;
    browserRef.current?.focus({ preventScroll: true });
  }, [browsing, listing]);

  const navigate = (path: string, pointerType: string) => {
    restoreBrowserFocus.current = pointerType === "keyboard" || pointerType === "virtual";
    onBrowse(path);
  };

  return (
    <section ref={browserRef} tabIndex={-1} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border p-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" aria-label={t("目标设备目录", "Directories on target device")}>
      <div className="flex min-w-0 items-center gap-2 border-b border-border pb-2">
        <Button size="sm" variant="ghost" isIconOnly className="shrink-0" aria-label={t("上一级目录", "Parent directory")} isDisabled={!listing.parentPath || browsing || creating}
          onPress={(event) => { if (listing.parentPath) navigate(listing.parentPath, event.pointerType); }}><KuloIcon name="arrow-left" size={16} /></Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={listing.path}>{listing.path}</span>
        {browsing && <Spinner size="sm" className="shrink-0" aria-label={t("读取目录", "Loading directory")} />}
      </div>
      <div ref={entriesRef} className="scrollbar flex max-h-56 min-w-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto pt-1 [--scrollbar-gutter:stable]">
        {entries.length ? entries.map((entry) => (
          <Button key={entry.path} variant="ghost" size="sm" className="kulo-directory-entry w-full min-w-0 justify-start px-2"
            aria-label={entry.name} isDisabled={browsing || creating} onPress={(event) => navigate(entry.path, event.pointerType)}>
            <KuloIcon name="folder" size={16} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-left" title={entry.path}>{entry.name}</span>
            <KuloIcon name="chevron-right" size={14} className="shrink-0 text-muted" />
          </Button>
        )) : <span className="p-3 text-sm text-muted">{t("没有可见子目录", "No visible subdirectories")}</span>}
      </div>
    </section>
  );
}

async function fetchKnownCurrentDeviceId(signal: AbortSignal): Promise<string | undefined> {
  const view = await deviceApi.get(signal) as DeviceInterconnectionView & { currentDeviceKnown?: boolean };
  return view.currentDeviceKnown === true ? view.currentDeviceId : undefined;
}

export interface UseCreateProjectDialogOptions {
  devices: readonly ProjectDevice[];
  currentDeviceId?: string;
  initialDeviceId?: string;
  onCreated: (project: ProjectView) => void;
  desktop?: Pick<DesktopFileBridge, "pickDirectory">;
  resolveCurrentDeviceId?: (signal: AbortSignal) => Promise<string | undefined>;
  listDirectories?: typeof kuloRest.listProjectDirectories;
  createProject?: typeof kuloRest.createProject;
  onNativePickFinished?: () => void;
}

export function useCreateProjectDialog({
  devices,
  currentDeviceId,
  initialDeviceId,
  onCreated,
  desktop = desktopFileBridge(),
  resolveCurrentDeviceId = fetchKnownCurrentDeviceId,
  listDirectories = kuloRest.listProjectDirectories,
  createProject = kuloRest.createProject,
  onNativePickFinished,
}: UseCreateProjectDialogOptions) {
  const { t } = useI18n();
  const [fetchedCurrentDeviceId, setFetchedCurrentDeviceId] = useState<string>();
  const effectiveCurrentDeviceId = currentDeviceId ?? fetchedCurrentDeviceId;
  const orderedDevices = orderDevices(devices, { currentDeviceId: effectiveCurrentDeviceId });
  const [deviceId, setDeviceId] = useState(initialDeviceId ?? "");
  const [name, setName] = useState("");
  const [mode, setMode] = useState("existing");
  const [directory, setDirectory] = useState("");
  const [folderName, setFolderName] = useState("");
  const [listing, setListing] = useState<ProjectDirectoryListing>();
  const [browsing, setBrowsing] = useState(false);
  const [pickingNative, setPickingNative] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());

  const mountedRef = useRef(true);
  const browseSeqRef = useRef(0);
  const browseRequest = useRef<AbortController | undefined>(undefined);
  const pickingNativeRef = useRef(false);
  const nameAutoFilledRef = useRef(false);

  const isCurrent = (id: string) => Boolean(effectiveCurrentDeviceId && id === effectiveCurrentDeviceId);
  const device = orderedDevices.find((candidate) => candidate.id === deviceId);
  const hasNativePicker = typeof desktop?.pickDirectory === "function";
  const canPickNativeDirectory = Boolean(device && isCurrent(device.id) && hasNativePicker);
  const locked = creating || pickingNative;

  useEffect(() => {
    setFetchedCurrentDeviceId(undefined);
  }, [currentDeviceId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      browseSeqRef.current += 1;
      browseRequest.current?.abort();
    };
  }, []);

  const change = (setter: (value: string) => void, value: string) => {
    setter(value);
    setError(undefined);
    setCommandId(crypto.randomUUID());
  };

  const setNameValue = (value: string) => {
    nameAutoFilledRef.current = false;
    change(setName, value);
  };

  const setModeValue = (value: string) => {
    change(setMode, value);
  };

  const setFolderNameValue = (value: string) => {
    change(setFolderName, value);
  };

  const selectDevice = (value: string) => {
    if (creating || pickingNativeRef.current) return;
    browseSeqRef.current += 1;
    browseRequest.current?.abort();
    browseRequest.current = undefined;
    setBrowsing(false);
    setListing(undefined);
    setDirectory("");
    change(setDeviceId, value);
  };

  const setDirectoryValue = (value: string) => {
    if (creating || pickingNativeRef.current) return;
    browseSeqRef.current += 1;
    browseRequest.current?.abort();
    browseRequest.current = undefined;
    setBrowsing(false);
    setListing(undefined);
    change(setDirectory, value);
  };

  const browse = async (path?: string) => {
    if (!deviceId || !device?.online || creating || pickingNativeRef.current) return;
    const seq = ++browseSeqRef.current;
    browseRequest.current?.abort();
    browseRequest.current = undefined;
    setError(undefined);

    let resolvedCurrentId = effectiveCurrentDeviceId;
    const pickDirectory = desktop?.pickDirectory;
    const nativeAvailable = typeof pickDirectory === "function";

    if (nativeAvailable && !resolvedCurrentId) {
      const resolveRequest = new AbortController();
      browseRequest.current = resolveRequest;
      setBrowsing(true);
      try {
        const discovered = await resolveCurrentDeviceId(resolveRequest.signal);
        if (resolveRequest.signal.aborted || !mountedRef.current || browseSeqRef.current !== seq) return;
        resolvedCurrentId = discovered;
        if (discovered) setFetchedCurrentDeviceId(discovered);
      } catch {
        if (resolveRequest.signal.aborted || !mountedRef.current || browseSeqRef.current !== seq) return;
        // Fail closed: keep remote browsing if current device identity cannot be confirmed.
        resolvedCurrentId = undefined;
      } finally {
        if (browseRequest.current === resolveRequest) browseRequest.current = undefined;
      }
    }

    const useNative = Boolean(nativeAvailable && resolvedCurrentId && resolvedCurrentId === deviceId);
    if (useNative) {
      pickingNativeRef.current = true;
      setPickingNative(true);
      setBrowsing(true);
      setListing(undefined);
      const targetMode = mode;
      const defaultPath = (path ?? directory).trim() || undefined;
      try {
        const selected = await pickDirectory!(defaultPath ? { defaultPath } : undefined);
        if (!mountedRef.current || browseSeqRef.current !== seq) return;
        if (selected) {
          change(setDirectory, selected);
          if (targetMode === "existing") {
            const suggested = projectDirectoryBasename(selected);
            if (suggested) {
              setName((current) => {
                if (!current.trim() || nameAutoFilledRef.current) {
                  nameAutoFilledRef.current = true;
                  return suggested;
                }
                return current;
              });
            }
          }
        }
      } catch (err) {
        if (mountedRef.current && browseSeqRef.current === seq) {
          setError(err instanceof Error ? err.message : t("选择目录失败", "Failed to select directory"));
        }
      } finally {
        pickingNativeRef.current = false;
        if (mountedRef.current && browseSeqRef.current === seq) {
          setPickingNative(false);
          setBrowsing(false);
          onNativePickFinished?.();
        }
      }
      return;
    }

    const request = new AbortController();
    browseRequest.current = request;
    setBrowsing(true);
    try {
      const result = await listDirectories(deviceId, path, request.signal);
      if (request.signal.aborted || !mountedRef.current || browseSeqRef.current !== seq) return;
      setListing(result);
      change(setDirectory, result.path);
    } catch (err) {
      if (!request.signal.aborted && mountedRef.current && browseSeqRef.current === seq) {
        setError(err instanceof Error ? err.message : t("读取目录失败", "Failed to read directory"));
      }
    } finally {
      if (browseRequest.current === request) {
        browseRequest.current = undefined;
        if (mountedRef.current && browseSeqRef.current === seq) setBrowsing(false);
      }
    }
  };

  const create = async () => {
    if (creating || pickingNativeRef.current || browsing || !device?.online || !name.trim() || !directory.trim()) return;
    setCreating(true);
    setError(undefined);
    try {
      const workspaceDir = mode === "new" ? joinProjectDirectory(directory.trim(), folderName.trim() || name.trim()) : directory.trim();
      const result = await createProject({ commandId, name: name.trim(), deviceId, workspaceDir, createDirectory: mode === "new" });
      if (mountedRef.current) onCreated(result.project);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : t("创建项目失败", "Failed to create project"));
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  };

  return {
    orderedDevices,
    deviceId,
    device,
    effectiveCurrentDeviceId,
    isCurrent,
    canPickNativeDirectory,
    hasNativePicker,
    name,
    mode,
    directory,
    folderName,
    listing,
    browsing,
    pickingNative,
    creating,
    locked,
    error,
    commandId,
    selectDevice,
    setNameValue,
    setModeValue,
    setDirectoryValue,
    setFolderNameValue,
    browse,
    create,
  };
}

export function CreateProjectDialog({ devices, currentDeviceId, initialDeviceId, onCreated, onClose }: {
  devices: readonly ProjectDevice[];
  currentDeviceId?: string;
  initialDeviceId?: string;
  onCreated: (project: ProjectView) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const browseButtonRef = useRef<HTMLButtonElement>(null);
  const focusFrameRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (focusFrameRef.current !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(focusFrameRef.current);
    }
  }, []);

  const restoreBrowseFocus = () => {
    if (typeof requestAnimationFrame !== "function") return;
    if (focusFrameRef.current !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(focusFrameRef.current);
    }
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = undefined;
      browseButtonRef.current?.focus({ preventScroll: true });
    });
  };

  const state = useCreateProjectDialog({
    devices,
    currentDeviceId,
    initialDeviceId,
    onCreated,
    onNativePickFinished: restoreBrowseFocus,
  });

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open && !state.locked) onClose(); }}>
      <Modal.Backdrop isDismissable={!state.locked} isKeyboardDismissDisabled={state.locked}>
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog className="min-w-0" aria-label={t("新建项目", "New project")}>
            <Modal.Header className="flex-row items-center justify-between">
              <Modal.Heading>{t("新建项目", "New project")}</Modal.Heading>
              <Modal.CloseTrigger aria-label={t("关闭新建项目", "Close new project")} isDisabled={state.locked} />
            </Modal.Header>
            <Modal.Body className="kulo-form-stack">
              {state.error && <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>{state.error}</Alert.Title></Alert.Content></Alert>}
              <Select className="kulo-form-field" variant="secondary" fullWidth value={state.deviceId || null} isDisabled={state.locked} placeholder={t("选择设备", "Select device")}
                disabledKeys={state.orderedDevices.filter((candidate) => !candidate.online).map((candidate) => candidate.id)}
                onChange={(value) => state.selectDevice(String(value ?? ""))}>
                <Label>{t("设备", "Device")}</Label>
                <Select.Trigger className="min-w-0">
                  <Select.Value className="min-w-0 flex-1">
                    {state.device ? (
                      <span className="flex min-w-0 items-center justify-between gap-2">
                        <DeviceName name={state.device.name} isCurrent={state.isCurrent(state.device.id)} singleLine />
                        <DevicePresence online={state.device.online} showOnlineText={false} />
                      </span>
                    ) : undefined}
                  </Select.Value>
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover><ListBox aria-label={t("项目所在设备", "Project device")}>
                  {state.orderedDevices.map((candidate) => <ListBox.Item key={candidate.id} id={candidate.id} textValue={formatDeviceLabel(candidate.name, state.isCurrent(candidate.id))}>
                    <Label className="min-w-0 flex-1 whitespace-normal break-words"><DeviceName name={candidate.name} isCurrent={state.isCurrent(candidate.id)} /></Label>
                    <DevicePresence online={candidate.online} className="ml-auto" />
                    <ListBox.ItemIndicator />
                  </ListBox.Item>)}
                </ListBox></Select.Popover>
              </Select>
              <TextField className="kulo-form-field" variant="secondary" fullWidth value={state.name} onChange={state.setNameValue} isDisabled={state.locked} isRequired>
                <Label>{t("项目名称", "Project name")}</Label><Input autoFocus maxLength={120} autoComplete="off" />
              </TextField>
              <RadioGroup aria-label={t("项目目录方式", "Project directory mode")} orientation="horizontal" value={state.mode} onChange={state.setModeValue} isDisabled={state.locked}>
                <Radio value="existing"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>{t("已有目录", "Existing directory")}</Radio.Content></Radio>
                <Radio value="new"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>{t("新建目录", "New directory")}</Radio.Content></Radio>
              </RadioGroup>
              <div className="kulo-field-action-row">
                <TextField variant="secondary" fullWidth className="kulo-form-field min-w-0 flex-1" value={state.directory} onChange={state.setDirectoryValue} isDisabled={state.locked} isRequired>
                  <Label>{state.mode === "new" ? t("父目录", "Parent directory") : t("项目目录", "Project directory")}</Label>
                  <Input className="kulo-field-action-input min-w-0 font-mono text-sm" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if (state.canPickNativeDirectory) void state.create();
                        else void state.browse(state.directory.trim() || undefined);
                      }
                    }} />
                </TextField>
                <Button ref={browseButtonRef} variant="secondary" className="kulo-field-action-button shrink-0" isPending={state.browsing} isDisabled={!state.device?.online || state.creating} onPress={() => void state.browse(state.directory.trim() || undefined)}>{t("浏览", "Browse")}</Button>
              </div>
              {state.mode === "new" && <TextField className="kulo-form-field" variant="secondary" fullWidth value={state.folderName} onChange={state.setFolderNameValue} isDisabled={state.locked}>
                <Label>{t("目录名称", "Directory name")}</Label><Input placeholder={state.name || t("项目名称", "Project name")} autoComplete="off" />
              </TextField>}
              {!state.canPickNativeDirectory && state.listing && <ProjectDirectoryBrowser listing={state.listing} browsing={state.browsing} creating={state.creating} onBrowse={(path) => void state.browse(path)} />}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={state.locked} onPress={onClose}>{t("取消", "Cancel")}</Button>
              <Button isPending={state.creating} isDisabled={!state.device?.online || !state.name.trim() || !state.directory.trim() || state.browsing || state.pickingNative} onPress={() => void state.create()}>{t("授权并创建", "Authorize and create")}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
