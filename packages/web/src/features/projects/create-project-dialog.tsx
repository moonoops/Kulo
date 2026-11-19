import { useI18n } from "../../moco-i18n";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Label, ListBox, Modal, Radio, RadioGroup, Select, Spinner, TextField } from "@heroui/react";
import type { ProjectDirectoryListing, ProjectView } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { MocoIcon } from "../../moco-icon";
import { joinProjectDirectory, type ProjectDevice } from "./project-model";

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
          onPress={(event) => { if (listing.parentPath) navigate(listing.parentPath, event.pointerType); }}><MocoIcon name="arrow-left" size={16} /></Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={listing.path}>{listing.path}</span>
        {browsing && <Spinner size="sm" className="shrink-0" aria-label={t("读取目录", "Loading directory")} />}
      </div>
      <div ref={entriesRef} className="scrollbar flex max-h-56 min-w-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto pt-1 [--scrollbar-gutter:stable]">
        {entries.length ? entries.map((entry) => (
          <Button key={entry.path} variant="ghost" size="sm" className="moco-directory-entry w-full min-w-0 justify-start px-2"
            aria-label={entry.name} isDisabled={browsing || creating} onPress={(event) => navigate(entry.path, event.pointerType)}>
            <MocoIcon name="folder" size={16} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-left" title={entry.path}>{entry.name}</span>
            <MocoIcon name="chevron-right" size={14} className="shrink-0 text-muted" />
          </Button>
        )) : <span className="p-3 text-sm text-muted">{t("没有可见子目录", "No visible subdirectories")}</span>}
      </div>
    </section>
  );
}

export function CreateProjectDialog({ devices, initialDeviceId, onCreated, onClose }: {
  devices: readonly ProjectDevice[];
  initialDeviceId?: string;
  onCreated: (project: ProjectView) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [deviceId, setDeviceId] = useState(initialDeviceId ?? "");
  const [name, setName] = useState("");
  const [mode, setMode] = useState("existing");
  const [directory, setDirectory] = useState("");
  const [folderName, setFolderName] = useState("");
  const [listing, setListing] = useState<ProjectDirectoryListing>();
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const browseRequest = useRef<AbortController | undefined>(undefined);
  const device = devices.find((candidate) => candidate.id === deviceId);

  useEffect(() => () => browseRequest.current?.abort(), []);

  const change = (setter: (value: string) => void, value: string) => {
    setter(value);
    setError(undefined);
    setCommandId(crypto.randomUUID());
  };

  const browse = async (path?: string) => {
    if (!deviceId || !device?.online || creating) return;
    browseRequest.current?.abort();
    const request = new AbortController();
    browseRequest.current = request;
    setBrowsing(true);
    setError(undefined);
    try {
      const result = await mocoRest.listProjectDirectories(deviceId, path, request.signal);
      if (request.signal.aborted) return;
      setListing(result);
      change(setDirectory, result.path);
    } catch (err) {
      if (!request.signal.aborted) setError(err instanceof Error ? err.message : t("读取目录失败", "Failed to read directory"));
    } finally {
      if (browseRequest.current === request) setBrowsing(false);
    }
  };

  const create = async () => {
    if (creating || !device?.online || !name.trim() || !directory.trim()) return;
    setCreating(true);
    setError(undefined);
    try {
      const workspaceDir = mode === "new" ? joinProjectDirectory(directory.trim(), folderName.trim() || name.trim()) : directory.trim();
      const result = await mocoRest.createProject({ commandId, name: name.trim(), deviceId, workspaceDir, createDirectory: mode === "new" });
      onCreated(result.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("创建项目失败", "Failed to create project"));
    } finally { setCreating(false); }
  };

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open && !creating) onClose(); }}>
      <Modal.Backdrop isDismissable={!creating} isKeyboardDismissDisabled={creating}>
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog className="min-w-0" aria-label={t("新建项目", "New project")}>
            <Modal.Header className="flex-row items-center justify-between">
              <Modal.Heading>{t("新建项目", "New project")}</Modal.Heading>
              <Modal.CloseTrigger aria-label={t("关闭新建项目", "Close new project")} isDisabled={creating} />
            </Modal.Header>
            <Modal.Body className="moco-form-stack">
              {error && <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content></Alert>}
              <Select className="moco-form-field" variant="secondary" fullWidth value={deviceId || null} isDisabled={creating} placeholder={t("选择设备", "Select device")}
                disabledKeys={devices.filter((candidate) => !candidate.online).map((candidate) => candidate.id)}
                onChange={(value) => {
                  browseRequest.current?.abort(); setBrowsing(false); setListing(undefined); setDirectory("");
                  change(setDeviceId, String(value ?? ""));
                }}>
                <Label>{t("设备", "Device")}</Label>
                <Select.Trigger className="min-w-0"><Select.Value className="min-w-0 truncate" /><Select.Indicator /></Select.Trigger>
                <Select.Popover><ListBox aria-label={t("项目所在设备", "Project device")}>
                  {devices.map((candidate) => <ListBox.Item key={candidate.id} id={candidate.id} textValue={candidate.name}>
                    <Label className="min-w-0 flex-1 truncate">{candidate.name}{candidate.online ? "" : t(" · 离线", " · Offline")}</Label><ListBox.ItemIndicator />
                  </ListBox.Item>)}
                </ListBox></Select.Popover>
              </Select>
              <TextField className="moco-form-field" variant="secondary" fullWidth value={name} onChange={(value) => change(setName, value)} isDisabled={creating} isRequired>
                <Label>{t("项目名称", "Project name")}</Label><Input autoFocus maxLength={120} autoComplete="off" />
              </TextField>
              <RadioGroup aria-label={t("项目目录方式", "Project directory mode")} orientation="horizontal" value={mode} onChange={(value) => change(setMode, value)} isDisabled={creating}>
                <Radio value="existing"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>{t("已有目录", "Existing directory")}</Radio.Content></Radio>
                <Radio value="new"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>{t("新建目录", "New directory")}</Radio.Content></Radio>
              </RadioGroup>
              <div className="moco-field-action-row">
                <TextField variant="secondary" fullWidth className="moco-form-field min-w-0 flex-1" value={directory} onChange={(value) => { browseRequest.current?.abort(); setBrowsing(false); setListing(undefined); change(setDirectory, value); }} isDisabled={creating} isRequired>
                  <Label>{mode === "new" ? t("父目录", "Parent directory") : t("项目目录", "Project directory")}</Label>
                  <Input className="moco-field-action-input min-w-0 font-mono text-sm" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void browse(directory.trim() || undefined); } }} />
                </TextField>
                <Button variant="secondary" className="moco-field-action-button shrink-0" isPending={browsing} isDisabled={!device?.online || creating} onPress={() => void browse(directory.trim() || undefined)}>{t("浏览", "Browse")}</Button>
              </div>
              {mode === "new" && <TextField className="moco-form-field" variant="secondary" fullWidth value={folderName} onChange={(value) => change(setFolderName, value)} isDisabled={creating}>
                <Label>{t("目录名称", "Directory name")}</Label><Input placeholder={name || t("项目名称", "Project name")} autoComplete="off" />
              </TextField>}
              {listing && <ProjectDirectoryBrowser listing={listing} browsing={browsing} creating={creating} onBrowse={(path) => void browse(path)} />}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={creating} onPress={onClose}>{t("取消", "Cancel")}</Button>
              <Button isPending={creating} isDisabled={!device?.online || !name.trim() || !directory.trim() || browsing} onPress={() => void create()}>{t("授权并创建", "Authorize and create")}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
