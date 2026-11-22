import { useI18n } from "../../kulo-i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Disclosure, Dropdown, Input, Label, Modal, Separator, Spinner, TextField } from "@heroui/react";
import type { DeviceInterconnectionView, EnvNodeDescriptor, ProjectView, TicketCardView, TopicSummary } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { DeviceName, DevicePresence, formatDeviceLabel } from "../../components/device-identity";
import { KuloApiError, kuloRest } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { deviceApi } from "../settings/device-api";
import { TopicRow, type TopicRowActivity } from "../topics/topic-row";
import { topicNotifications } from "../topics/topic-activity";
import { CreateProjectDialog } from "./create-project-dialog";
import { ALL_PROJECT_DEVICES, initialProjectDevice, projectDevices, projectTickets, topicsForProject, unfinishedTicket, type ProjectNavigationRequest, type UpdateProjectCollection } from "./project-model";

const filterKey = "kulo:projects:device";
const expandedKey = "kulo:projects:expanded";

function savedPreference<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
}

function savePreference(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Browsing preferences are optional when storage is unavailable. */ }
}

function savedDeviceFilter(): string | null {
  const saved = savedPreference<unknown>(filterKey, null);
  return typeof saved === "string" ? saved : null;
}

function savedExpandedProjects(): Record<string, boolean> {
  const saved = savedPreference<unknown>(expandedKey, {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}


export function ProjectsSidebar({ projects, topics, tickets, topicActivity = {}, envs, connected, currentDeviceId, activeTopicId, projectedTicketId, projectNavigation, onProjectNavigationHandled,
  creating, onCreatingChange, selectedProjectId, onSelectedProjectChange, query, onQueryChange, onCreateTopic, onSelectTopic, onPatchTopic, onRequestDeleteTopic, onProjectsChange, onTopicsChange, onManageDevices }: {
  projects: ProjectView[];
  topics: TopicSummary[];
  tickets: TicketCardView[];
  topicActivity?: Record<string, TopicRowActivity>;
  envs: EnvNodeDescriptor[];
  connected: boolean;
  currentDeviceId?: string;
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  selectedProjectId?: string;
  onSelectedProjectChange: (projectId: string | undefined) => void;
  query: string;
  onQueryChange: (query: string) => void;
  activeTopicId: string;
  projectedTicketId?: string;
  projectNavigation?: ProjectNavigationRequest;
  onProjectNavigationHandled?: () => void;
  onCreateTopic: (projectId?: string) => Promise<void>;
  onSelectTopic: (topicId: string) => void;
  onPatchTopic: (topicId: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) => Promise<void>;
  onRequestDeleteTopic: (topic: TopicSummary) => void;
  onProjectsChange: UpdateProjectCollection<ProjectView>;
  onTopicsChange: UpdateProjectCollection<TopicSummary>;
  onManageDevices: () => void;
}) {
  const { t } = useI18n();
  const activeProjectId = topics.find((topic) => topic.id === activeTopicId)?.projectId;
  const [deviceView, setDeviceView] = useState<(DeviceInterconnectionView & { currentDeviceKnown?: boolean })>();
  const [deviceFilter, setDeviceFilter] = useState<string | undefined>(() => savedDeviceFilter() ?? projects.find((project) => project.id === activeProjectId)?.deviceId);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const saved = savedExpandedProjects();
    return activeProjectId && !(activeProjectId in saved) ? { ...saved, [activeProjectId]: true } : saved;
  });
  const [deviceError, setDeviceError] = useState<string>();
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [renameTarget, setRenameTarget] = useState<ProjectView>();
  const [renameText, setRenameText] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<ProjectView>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleteNeedsStop, setDeleteNeedsStop] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
  const previousTopic = useRef<string | undefined>(activeProjectId ? `${activeTopicId}:${activeProjectId}` : undefined);
  const listRef = useRef<HTMLElement | null>(null);
  const deviceButtonRef = useRef<HTMLButtonElement>(null);
  const wasCreating = useRef(creating);

  useEffect(() => {
    const restore = wasCreating.current && !creating;
    wasCreating.current = creating;
    if (!restore) return;
    const frame = requestAnimationFrame(() => deviceButtonRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [creating]);

  const envKey = envs.map((env) => `${env.id}:${env.name}:${env.online}`).join("|");
  useEffect(() => {
    if (!connected) {
      setDeviceView(undefined);
      setDeviceLoading(false);
      return;
    }
    const request = new AbortController();
    setDeviceLoading(true);
    void deviceApi.get(request.signal).then((view) => {
      if (request.signal.aborted) return;
      const knownView = view as DeviceInterconnectionView & { currentDeviceKnown?: boolean };
      setDeviceView(knownView);
      setDeviceError(undefined);
      const knownCurrentId = currentDeviceId ?? (knownView.currentDeviceKnown === true ? knownView.currentDeviceId : undefined);
      const devices = projectDevices(envs, projects, knownView.devices.map((device) => ({ ...device, online: device.status === "online" })), knownCurrentId);
      setDeviceFilter((current) => initialProjectDevice(current ?? savedDeviceFilter(), knownCurrentId, Boolean(knownCurrentId), devices));
    }).catch((err: unknown) => {
      if (!request.signal.aborted) {
        setDeviceView(undefined);
        setDeviceError(err instanceof Error ? err.message : t("读取设备失败", "Failed to load devices"));
        setDeviceFilter((current) => current ?? ALL_PROJECT_DEVICES);
      }
    }).finally(() => { if (!request.signal.aborted) setDeviceLoading(false); });
    return () => request.abort();
  }, [connected, currentDeviceId, envKey, refresh]);

  const resolvedCurrentDeviceId = currentDeviceId ?? (deviceView?.currentDeviceKnown === true ? deviceView.currentDeviceId : undefined);
  const devices = useMemo(() => projectDevices(envs, projects, deviceView?.devices.map((device) => ({
    id: device.id, name: device.name, rootDir: device.rootDir, online: device.status === "online",
  })), resolvedCurrentDeviceId), [envs, projects, deviceView, resolvedCurrentDeviceId]);
  useEffect(() => {
    const key = `${activeTopicId}:${activeProjectId ?? ""}`;
    if (previousTopic.current === key) return;
    const project = projects.find((candidate) => candidate.id === activeProjectId);
    if (activeProjectId && !project) return;
    previousTopic.current = key;
    if (!activeProjectId) return;
    setExpanded((current) => { const next = { ...current, [activeProjectId]: true }; savePreference(expandedKey, next); return next; });
    if (project) setDeviceFilter((current) => current === ALL_PROJECT_DEVICES ? current : project.deviceId);
  }, [activeTopicId, activeProjectId, projects]);
  useEffect(() => { if (deviceFilter !== undefined) savePreference(filterKey, deviceFilter); }, [deviceFilter]);
  useEffect(() => {
    if (!projectNavigation) return;
    const project = projects.find((candidate) => candidate.id === projectNavigation.projectId);
    if (!project) return;
    onQueryChange("");
    setDeviceFilter((current) => current === ALL_PROJECT_DEVICES ? current : project.deviceId);
    setExpanded((current) => { const next = { ...current, [project.id]: true }; savePreference(expandedKey, next); return next; });
    const frame = requestAnimationFrame(() => {
      const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-project-id]") ?? [])].find((element) => element.dataset.projectId === project.id);
      row?.scrollIntoView({ block: "nearest" });
      row?.querySelector<HTMLButtonElement>("[data-project-trigger]")?.focus({ preventScroll: true });
      onProjectNavigationHandled?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [projectNavigation]);

  const selectedDevice = devices.find((device) => device.id === deviceFilter);
  const isCurrentDevice = (id: string) => Boolean(resolvedCurrentDeviceId && id === resolvedCurrentDeviceId);
  const label = (id: string, name: string) => formatDeviceLabel(name, isCurrentDevice(id));
  const selectedDeviceLabel = selectedDevice
    ? label(selectedDevice.id, selectedDevice.name)
    : deviceLoading && deviceFilter === undefined ? t("读取设备…", "Loading devices…") : t("全部设备", "All devices");
  const selectedDeviceTitle = selectedDevice
    ? `${selectedDeviceLabel} · ${selectedDevice.online ? t("在线", "Online") : t("离线", "Offline")}`
    : selectedDeviceLabel;
  const matchingProjects = projects.filter((project) => !project.deletedAt && (deviceFilter === undefined || deviceFilter === ALL_PROJECT_DEVICES || project.deviceId === deviceFilter))
    .filter((project) => !query.trim() || project.name.toLowerCase().includes(query.trim().toLowerCase()) || topicsForProject(topics, project.id).some((topic) => topic.title.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const visibleProjectIds = matchingProjects.map((project) => project.id).join("\0");
  useEffect(() => {
    if (matchingProjects.some((project) => project.id === selectedProjectId)) return;
    onSelectedProjectChange(matchingProjects.find((project) => project.id === activeProjectId)?.id ?? matchingProjects[0]?.id);
  }, [visibleProjectIds, selectedProjectId, activeProjectId, onSelectedProjectChange]);

  const groups = deviceFilter === ALL_PROJECT_DEVICES || deviceFilter === undefined
    ? devices.map((device) => ({ device, projects: matchingProjects.filter((project) => project.deviceId === device.id) })).filter((group) => group.projects.length)
    : [{ device: selectedDevice, projects: matchingProjects }];
  const unfinished = deleteTarget ? projectTickets(deleteTarget.id, topics, tickets).filter(unfinishedTicket) : [];
  const mustStop = unfinished.length > 0 || deleteNeedsStop;

  const remove = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true); setDeleteError(undefined);
    try {
      const result = await kuloRest.deleteProject(deleteTarget.id, mustStop);
      onProjectsChange((current) => current.filter((project) => project.id !== result.deleted));
      onTopicsChange((current) => current.filter((topic) => topic.projectId !== result.deleted));
      setDeleteTarget(undefined);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("删除项目失败", "Failed to delete project"));
      if (err instanceof KuloApiError && err.code === "project_tasks_running") setDeleteNeedsStop(true);
    } finally { setDeleting(false); }
  };

  const rename = async () => {
    if (!renameTarget || renaming || !renameText.trim()) return;
    setRenaming(true); setRenameError(undefined);
    try {
      const result = await kuloRest.patchProject(renameTarget.id, { name: renameText.trim(), expectedRevision: renameTarget.revision });
      onProjectsChange((current) => current.map((project) => project.id === result.project.id ? result.project : project)); setRenameTarget(undefined);
    } catch (err) { setRenameError(err instanceof Error ? err.message : t("重命名失败", "Failed to rename")); }
    finally { setRenaming(false); }
  };

  return <>
    <div className="flex shrink-0 flex-col gap-2">
      <Dropdown>
        <Button ref={deviceButtonRef} size="sm" variant="ghost" fullWidth className="kulo-navigation-control kulo-navigation-surface min-w-0 justify-start gap-2 px-2" aria-label={t("选择项目设备", "Select project device")}>
          <KuloIcon name="devices" size={17} className="shrink-0 text-muted" />
          {selectedDevice ? <>
            <span className="flex min-w-0 flex-1 items-center text-left" title={selectedDeviceTitle}>
              <DeviceName name={selectedDevice.name} isCurrent={isCurrentDevice(selectedDevice.id)} singleLine />
            </span>
            <DevicePresence online={selectedDevice.online} showOnlineText={false} />
          </> : (
            <span className="min-w-0 flex-1 truncate text-left" title={selectedDeviceTitle}>{selectedDeviceLabel}</span>
          )}
          <KuloIcon name="chevron-down" size={15} className="shrink-0 text-muted" />
        </Button>
        <Dropdown.Popover placement="bottom start" className="w-72 max-w-[calc(100vw-2rem)]">
          <Dropdown.Menu className="kulo-navigation-menu" aria-label={t("项目设备", "Project devices")} selectionMode="single" selectedKeys={new Set([deviceFilter && deviceFilter !== ALL_PROJECT_DEVICES ? `device:${deviceFilter}` : ALL_PROJECT_DEVICES])}
            disabledKeys={connected ? [] : ["create"]}
            onAction={(key) => { if (key === "manage") onManageDevices(); else if (key === "create") onCreatingChange(true); else setDeviceFilter(String(key) === ALL_PROJECT_DEVICES ? ALL_PROJECT_DEVICES : String(key).slice(7)); }}>
            <Dropdown.Item id={ALL_PROJECT_DEVICES} textValue={t("全部设备", "All devices")} className="kulo-navigation-menu-item"><Dropdown.ItemIndicator /><Label className="kulo-navigation-menu-label">{t("全部设备", "All devices")}</Label></Dropdown.Item>
            <Separator />
            {devices.map((device) => <Dropdown.Item key={device.id} id={`device:${device.id}`} textValue={label(device.id, device.name)} className="kulo-navigation-menu-item">
              <Dropdown.ItemIndicator /><Label className="kulo-navigation-menu-label min-w-0 flex-1 whitespace-normal break-words"><DeviceName name={device.name} isCurrent={isCurrentDevice(device.id)} /></Label><DevicePresence online={device.online} className="ml-auto" />
            </Dropdown.Item>)}
            <Separator />
            <Dropdown.Item id="create" textValue={t("新建项目", "New project")} className="kulo-navigation-menu-item"><KuloIcon name="add" size={16} /><Label className="kulo-navigation-menu-label">{t("新建项目", "New project")}</Label></Dropdown.Item>
            <Dropdown.Item id="manage" textValue={t("管理设备", "Manage devices")} className="kulo-navigation-menu-item"><KuloIcon name="devices" size={16} /><Label className="kulo-navigation-menu-label">{t("管理设备", "Manage devices")}</Label></Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
    {deviceError && <Alert status="danger" className="shrink-0"><Alert.Content><Alert.Title>{deviceError}</Alert.Title></Alert.Content><Button size="sm" variant="tertiary" onPress={() => setRefresh((n) => n + 1)}>{t("重试", "Retry")}</Button></Alert>}
    <nav ref={listRef} className="kulo-navigation-list scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto" aria-label={t("项目列表", "Projects")}>
      {groups.map((group, index) => <div key={group.device?.id ?? index} role="group" aria-label={group.device ? t(`${label(group.device.id, group.device.name)}的项目`, `Projects on ${label(group.device.id, group.device.name)}`) : undefined} className="flex min-w-0 flex-col">
        {(deviceFilter === ALL_PROJECT_DEVICES || deviceFilter === undefined) && group.device && <div className="flex h-8 min-w-0 items-center gap-2 px-2 text-xs text-muted">
          <KuloIcon name="devices" size={14} className="shrink-0" />
          <span className="flex min-w-0 flex-1 items-center font-medium" title={label(group.device.id, group.device.name)}>
            <DeviceName name={group.device.name} isCurrent={isCurrentDevice(group.device.id)} singleLine />
          </span>
          <DevicePresence online={group.device.online} showOnlineText={false} />
        </div>}
        {group.projects.map((project) => {
          const projectTopics = topicsForProject(topics, project.id);
          const archived = Boolean(showArchived[project.id]);
          const visible = projectTopics.filter((topic) => Boolean(topic.archived) === archived && (!query.trim() || project.name.toLowerCase().includes(query.trim().toLowerCase()) || topic.title.toLowerCase().includes(query.trim().toLowerCase())));
          const isOpen = Boolean(expanded[project.id]) || Boolean(query.trim());
          return <Disclosure key={project.id} data-project-id={project.id} isExpanded={isOpen} onExpandedChange={(open) => setExpanded((current) => { const next = { ...current, [project.id]: open }; savePreference(expandedKey, next); return next; })} className="flex min-w-0 flex-col">
            <div className="kulo-navigation-row kulo-project-row" data-selected={project.id === selectedProjectId || undefined}>
              <Disclosure.Heading className="min-w-0">
                <Disclosure.Trigger data-project-trigger className="kulo-project-trigger" onPress={() => onSelectedProjectChange(project.id)} aria-current={project.id === selectedProjectId ? "true" : undefined} aria-label={t(`${isOpen ? "收起" : "展开"}项目 ${project.name}`, `${isOpen ? "Collapse" : "Expand"} project ${project.name}`)}>
                  <Disclosure.Indicator className="ms-0 size-3.5 -rotate-90 text-muted data-[expanded=true]:rotate-0" />
                  <KuloIcon name="folder" size={18} className="shrink-0 text-muted" />
                  <span className="truncate" title={`${project.name}\n${project.workspaceDir}`}>{project.name}</span>
                  {project.availability !== "ready" && <span className="shrink-0 text-xs font-normal text-muted" title={project.error}>{project.availability === "offline" ? t("离线", "Offline") : t("不可用", "Unavailable")}</span>}
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Button size="sm" variant="ghost" isIconOnly className="kulo-project-action" aria-label={t(`在 ${project.name} 新建会话`, `New conversation in ${project.name}`)} isDisabled={!connected} onPress={() => void onCreateTopic(project.id)}><KuloIcon name="add" size={16} /></Button>
              <Dropdown><Button size="sm" variant="ghost" isIconOnly className="kulo-project-action" aria-label={t(`${project.name} 项目操作`, `${project.name} project actions`)}><KuloIcon name="more" size={16} /></Button>
                <Dropdown.Popover placement="bottom end"><Dropdown.Menu className="kulo-navigation-menu" aria-label={t(`${project.name} 项目操作`, `${project.name} project actions`)} onAction={(key) => {
                  if (key === "rename") { setRenameTarget(project); setRenameText(project.name); setRenameError(undefined); }
                  if (key === "delete") { setDeleteTarget(project); setDeleteError(undefined); setDeleteNeedsStop(false); }
                }} disabledKeys={connected ? [] : ["rename", "delete"]}>
                  <Dropdown.Item id="rename" textValue={t("重命名项目", "Rename project")} className="kulo-navigation-menu-item"><KuloIcon name="edit" size={16} /><Label className="kulo-navigation-menu-label">{t("重命名", "Rename")}</Label></Dropdown.Item>
                  <Dropdown.Item id="delete" textValue={t("删除项目", "Delete project")} variant="danger" className="kulo-navigation-menu-item"><KuloIcon name="cancel" size={16} /><Label className="kulo-navigation-menu-label">{t("删除项目", "Delete project")}</Label></Dropdown.Item>
                </Dropdown.Menu></Dropdown.Popover>
              </Dropdown>
            </div>
            <Disclosure.Content className="kulo-project-content"><Disclosure.Body className="kulo-project-topic-list flex min-w-0 flex-col gap-0 p-0">
              {visible.map((topic) => <TopicRow key={topic.id} layout="project" topic={topic} selected={topic.id === activeTopicId && !projectedTicketId}
                activity={topicActivity[topic.id]}
                {...topicNotifications(tickets, topic.id)}
                onSelect={() => onSelectTopic(topic.id)} onPatch={(patch) => void onPatchTopic(topic.id, patch)} onRequestDelete={() => onRequestDeleteTopic(topic)} />)}
              {visible.length === 0 && <Button variant="ghost" size="sm" className="min-w-0 justify-start gap-2 px-2 font-normal" isDisabled={!connected} onPress={() => void onCreateTopic(project.id)}><KuloIcon name="chat-add" size={16} className="shrink-0" />{t("新建会话", "New conversation")}</Button>}
              {(projectTopics.some((topic) => topic.archived) || archived) && <Button variant="ghost" size="sm" className="self-start px-2 font-normal" onPress={() => setShowArchived((current) => ({ ...current, [project.id]: !archived }))}>{archived ? t("返回活跃会话", "Back to active conversations") : t("已归档会话", "Archived conversations")}</Button>}
            </Disclosure.Body></Disclosure.Content>
          </Disclosure>;
        })}
      </div>)}
      {!matchingProjects.length && <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted">{deviceLoading ? <Spinner size="sm" /> : <KuloIcon name="folder" size={22} />}<span>{query.trim() ? t("没有匹配的项目", "No matching projects") : t("暂无项目", "No projects yet")}</span></div>}
    </nav>
    {creating && <CreateProjectDialog devices={devices} currentDeviceId={resolvedCurrentDeviceId} initialDeviceId={deviceFilter !== ALL_PROJECT_DEVICES ? deviceFilter : undefined} onClose={() => onCreatingChange(false)} onCreated={(project) => {
      onProjectsChange((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
      onQueryChange("");
      setDeviceFilter((current) => current === ALL_PROJECT_DEVICES ? current : project.deviceId);
      setExpanded((current) => { const next = { ...current, [project.id]: true }; savePreference(expandedKey, next); return next; });
      onSelectedProjectChange(project.id);
      onCreatingChange(false);
    }} />}
    <Modal isOpen={Boolean(renameTarget)} onOpenChange={(open) => { if (!open && !renaming) setRenameTarget(undefined); }}><Modal.Backdrop isDismissable={!renaming} isKeyboardDismissDisabled={renaming}><Modal.Container size="sm"><Modal.Dialog aria-label={t("重命名项目", "Rename project")}><Modal.Header><Modal.Heading>{t("重命名项目", "Rename project")}</Modal.Heading></Modal.Header><Modal.Body className="kulo-form-stack">
      {renameError && <Alert status="danger"><Alert.Content><Alert.Title>{renameError}</Alert.Title></Alert.Content></Alert>}
      <TextField className="kulo-form-field" variant="secondary" fullWidth value={renameText} onChange={setRenameText} isDisabled={renaming}><Label>{t("项目名称", "Project name")}</Label><Input autoFocus maxLength={120} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void rename(); }} /></TextField>
    </Modal.Body><Modal.Footer><Button variant="tertiary" isDisabled={renaming} onPress={() => setRenameTarget(undefined)}>{t("取消", "Cancel")}</Button><Button isPending={renaming} isDisabled={!renameText.trim()} onPress={() => void rename()}>{t("保存", "Save")}</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
    <ConfirmDialog open={Boolean(deleteTarget)} title={t("删除项目？", "Delete project?")} description={<div className="flex flex-col gap-2"><span>{deleteTarget ? t(`删除「${deleteTarget.name}」及其会话，保留磁盘文件。`, `Delete “${deleteTarget.name}” and its conversations. Files on disk will be kept.`) : ""}{mustStop ? t("关联的未结束任务将取消。", "Unfinished tasks will be cancelled.") : ""}</span>{deleteError && <span className="text-danger" role="alert">{deleteError}</span>}</div>}
      confirmLabel={mustStop ? t("停止任务并删除", "Stop tasks and delete") : t("删除项目", "Delete project")} isPending={deleting} onCancel={() => setDeleteTarget(undefined)} onConfirm={() => void remove()} />
  </>;
}
