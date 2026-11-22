import { useI18n } from "../../kulo-i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Popover,
  SearchField,
  Tabs,
} from "@heroui/react";
import type {
  EnvNodeDescriptor,
  LiveStreamState,
  KuloSettingsView,
  ProjectView,
  TicketCardView,
  TopicSummary,
} from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { AgentTerminal } from "./agent-terminal";
import type { AgentTerminalEntry } from "./agent-terminal-state";
import { useVoiceWorkspace } from "../voice/voice-context";
import { hasSidebarVoiceCall } from "../voice/voice-call-panel";
import { KuloApiError } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { SETTINGS_MODULES, type SettingsModuleId } from "../../kulo-settings";
import { settingsModuleTitle } from "../settings/settings-helpers";
import { ConversationModelSettings } from "./conversation-model-settings";
import { UsageStatsPopover } from "./usage-stats-popover";
import { TopicRow, type TopicRowActivity } from "./topic-row";
import { topicNotifications } from "./topic-activity";
import { ProjectsSidebar } from "../projects/projects-sidebar";
import { ordinaryTopics, unfinishedTicket, type ProjectNavigationRequest, type UpdateProjectCollection } from "../projects/project-model";

const projectSearchKey = "kulo:projects:search";

function savedProjectSearch(): string {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(projectSearchKey) ?? "null");
    return saved && typeof saved === "object" && "query" in saved && typeof saved.query === "string" ? saved.query : "";
  } catch {
    return "";
  }
}

export function TopicsSidebar({
  agentName,
  connected,
  terminalEntries,
  agentLive,
  onAgentClick,
  settingsMode,
  settingsModule,
  onSelectSettingsModule,
  onEnterSettings,
  onExitSettings,
  topics,
  projects,
  onProjectsChange,
  onTopicsChange,
  activeTopicId,
  activeProjectId: currentProjectId,
  projectedTicketId,
  projectNavigation,
  onProjectNavigationHandled,
  tickets,
  topicActivity = {},
  envs,
  settings,
  showProcess,
  onShowProcessChange,
  onSettingsUpdated,
  onCreateTopic,
  onSelectTopic,
  onPatchTopic,
  onDeleteTopic,
  searchFocusRequest,
  searchQuery,
  onSearchQueryChange,
  onSearchConversations,
  messagesCount,
}: {
  agentName: string;
  connected: boolean;
  terminalEntries: readonly AgentTerminalEntry[];
  agentLive?: LiveStreamState;
  onAgentClick: () => void;
  settingsMode: boolean;
  settingsModule: SettingsModuleId;
  onSelectSettingsModule: (id: SettingsModuleId) => void;
  onEnterSettings: () => void;
  onExitSettings: () => void;
  topics: TopicSummary[];
  projects: ProjectView[];
  onProjectsChange: UpdateProjectCollection<ProjectView>;
  onTopicsChange: UpdateProjectCollection<TopicSummary>;
  activeTopicId: string;
  activeProjectId?: string;
  projectedTicketId?: string;
  projectNavigation?: ProjectNavigationRequest;
  onProjectNavigationHandled?: () => void;
  tickets: TicketCardView[];
  topicActivity?: Record<string, TopicRowActivity>;
  envs: EnvNodeDescriptor[];
  settings: KuloSettingsView | null;
  showProcess: boolean;
  onShowProcessChange: (next: boolean) => void;
  onSettingsUpdated: (settings: KuloSettingsView) => void;
  onCreateTopic: (projectId?: string) => Promise<void>;
  onSelectTopic: (topicId: string) => void;
  onPatchTopic: (
    topicId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => Promise<void>;
  onDeleteTopic: (topicId: string, stopTasks?: boolean) => Promise<void>;
  searchFocusRequest: number;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onSearchConversations?: () => void;
  messagesCount: number;
}) {
  const { t, language } = useI18n();
  const voice = useVoiceWorkspace();
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeProjectId = currentProjectId ?? topics.find((topic) => topic.id === activeTopicId)?.projectId;
  const [sideTab, setSideTab] = useState<"topics" | "projects">(() => activeProjectId || projectNavigation ? "projects" : "topics");
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(() => projectNavigation?.projectId ?? activeProjectId ?? undefined);
  const selectedProject = projects.find((project) => project.id === selectedProjectId && !project.deletedAt);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectQuery, setProjectQuery] = useState(savedProjectSearch);
  const [searchOpen, setSearchOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TopicSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [deleteNeedsStop, setDeleteNeedsStop] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const handledSearchFocus = useRef(0);
  const restoreTopicFocus = useRef<string | null | undefined>(undefined);

  const focusSurvivingTopic = (targetId: string | null) => {
    requestAnimationFrame(() => {
      if (!sidebarRef.current) return;
      if (document.activeElement && document.activeElement !== document.body && sidebarRef.current.contains(document.activeElement)) return;
      const target = targetId
        ? [...sidebarRef.current.querySelectorAll<HTMLElement>("[data-topic-id]")].find((row) => row.dataset.topicId === targetId)?.querySelector<HTMLButtonElement>(".kulo-topic-select")
        : null;
      (target ?? sidebarRef.current.querySelector<HTMLButtonElement>(".kulo-navigation-create"))?.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    try { localStorage.setItem(projectSearchKey, JSON.stringify({ query: projectQuery })); }
    catch { /* Search preferences remain local to this window if storage is unavailable. */ }
  }, [projectQuery]);

  useEffect(() => {
    if (searchFocusRequest !== handledSearchFocus.current && !settingsMode) setSearchOpen(true);
  }, [searchFocusRequest, settingsMode]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => {
      if (!searchInputRef.current) return;
      searchInputRef.current.focus();
      handledSearchFocus.current = searchFocusRequest;
    });
    return () => cancelAnimationFrame(frame);
  }, [searchOpen, searchFocusRequest, sideTab]);

  const filteredTopics = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return ordinaryTopics(topics).filter((t) => {
      if (t.archived) return false;
      if (!q) return true;
      return t.title.toLowerCase().includes(q);
    }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  }, [topics, searchQuery]);

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    const index = filteredTopics.findIndex((topic) => topic.id === deleteTarget.id);
    const nextTopicId = index >= 0 ? (filteredTopics[index + 1]?.id ?? filteredTopics[index - 1]?.id ?? null) : undefined;
    setDeleting(true);
    try {
      setDeleteError(undefined);
      await onDeleteTopic(deleteTarget.id, deleteNeedsStop || tickets.some((ticket) => (ticket.originTopicId ?? "root") === deleteTarget.id && unfinishedTicket(ticket)));
      restoreTopicFocus.current = nextTopicId;
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t("删除会话失败", "Failed to delete conversation"));
      if (error instanceof KuloApiError && error.code === "topic_tasks_running") setDeleteNeedsStop(true);
    } finally {
      setDeleting(false);
    }
  };

  const patchTopicFromList = (topic: TopicSummary, patch: { title?: string; pinned?: boolean; archived?: boolean }) => {
    const activeRow = document.activeElement instanceof Element ? document.activeElement.closest<HTMLElement>("[data-topic-id]") : null;
    const restoreAfterArchive = Boolean(patch.archived) && activeRow?.dataset.topicId === topic.id;
    const index = restoreAfterArchive ? filteredTopics.findIndex((item) => item.id === topic.id) : -1;
    const nextTopicId = index >= 0 ? (filteredTopics[index + 1]?.id ?? filteredTopics[index - 1]?.id ?? null) : null;
    void onPatchTopic(topic.id, patch).then(() => {
      if (restoreAfterArchive) focusSurvivingTopic(nextTopicId);
    });
  };

  useEffect(() => {
    if (!activeProjectId) return;
    setSideTab("projects");
    setSelectedProjectId(activeProjectId);
  }, [activeTopicId, activeProjectId]);
  useEffect(() => {
    if (!projectNavigation) return;
    setSideTab("projects");
    setSelectedProjectId(projectNavigation.projectId);
  }, [projectNavigation]);

  const createTopic = () => {
    if (!connected || sideTab === "projects" && !selectedProject) return;
    setSearchOpen(false);
    if (sideTab === "projects") setProjectQuery("");
    else onSearchQueryChange("");
    void onCreateTopic(sideTab === "projects" ? selectedProject!.id : undefined);
  };


  return (
    <div ref={sidebarRef} className="kulo-sidebar flex h-full min-h-0 flex-col gap-2">
      {(!settingsMode || hasSidebarVoiceCall(voice?.call.call)) && (
        <div className="shrink-0">
          <AgentTerminal
            agentName={agentName}
            connected={connected}
            entries={terminalEntries}
            live={agentLive}
            activityScope={activeTopicId}
            tickets={tickets}
            mainChatSelected={!settingsMode && !projectedTicketId && Boolean(topics.find((topic) => topic.id === activeTopicId)?.master)}
            onAgentClick={onAgentClick}
            onOpenCallTopic={onSelectTopic}
            onCallClosed={settingsMode ? () => {
              requestAnimationFrame(() => sidebarRef.current?.querySelector<HTMLButtonElement>('nav button[aria-current="page"]')?.focus({ preventScroll: true }));
            } : undefined}
          />
        </div>
      )}

      {settingsMode ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <Button
            variant="ghost"
            className="mb-3 justify-start gap-2 px-3 py-2 text-sm font-medium"
            onPress={onExitSettings}
          >
            <KuloIcon name="arrow-left" size={18} />

            {t("设置", "Settings")}
          </Button>
          <nav className="scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label={t("设置模块", "Settings sections")}>
            {SETTINGS_MODULES.map((item) => {
              const sel = settingsModule === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`kulo-settings-navigation-item flex w-full cursor-pointer items-center gap-3 rounded-xl border-0 px-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                    sel
                      ? "bg-default font-medium text-default-foreground"
                      : "bg-transparent text-foreground hover:bg-surface-secondary"
                  }`}
                  aria-current={sel ? "page" : undefined}
                  onClick={() => onSelectSettingsModule(item.id)}
                >
                  <KuloIcon name={item.icon} filled={sel} size={20} />
                  <span>{settingsModuleTitle(item.id, language)}</span>
                </button>
              );
            })}
          </nav>
        </div>
      ) : (
        <>
          <Tabs
            data-kulo-sidebar-tabs
            variant="secondary"
            selectedKey={sideTab}
            onSelectionChange={(key) => setSideTab(key as "topics" | "projects")}
            className="flex min-h-0 flex-1 flex-col gap-2"
          >
            <Tabs.ListContainer className="kulo-navigation-tabs-container w-full max-w-full min-w-0 shrink-0">
              <Tabs.List aria-label={t("导航", "Navigation")} className="kulo-navigation-tabs w-full">
                <Tabs.Tab id="topics" className="kulo-navigation-tab w-0 min-w-0 flex-1 whitespace-nowrap gap-2">
                  <KuloIcon name="forum" size={16} />

                  {t("话题", "Topics")}
                  <Tabs.Indicator className="kulo-navigation-tab-indicator" />
                </Tabs.Tab>
                <Tabs.Tab id="projects" className="kulo-navigation-tab w-0 min-w-0 flex-1 whitespace-nowrap gap-2">
                  <KuloIcon name="folder" size={16} />

                  {t("项目", "Projects")}
                  <Tabs.Indicator className="kulo-navigation-tab-indicator" />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>

            <Tabs.Panel id="topics" className="mt-0 flex min-h-0 flex-1 flex-col gap-2 p-0">
              <nav
                className="kulo-navigation-list scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto"
                aria-label={t("话题列表", "Topics")}
              >
                {filteredTopics.map((topic) => {
                  return (
                    <TopicRow
                      key={topic.id}
                      topic={topic}
                      selected={topic.id === activeTopicId && !projectedTicketId}
                      {...topicNotifications(tickets, topic.id)}
                      activity={topicActivity[topic.id]}
                      onSelect={() => onSelectTopic(topic.id)}
                      onPatch={(patch) => patchTopicFromList(topic, patch)}
                      onRequestDelete={() => { setDeleteError(undefined); setDeleteNeedsStop(false); setDeleteTarget(topic); }}
                    />
                  );
                })}

                {filteredTopics.length === 0 && (
                  <p className="px-2 py-6 text-center text-sm text-muted">
                    {searchQuery.trim() ? t("没有匹配的话题", "No matching topics") : t("暂无话题", "No topics yet")}
                  </p>
                )}
              </nav>
            </Tabs.Panel>

            <Tabs.Panel id="projects" shouldForceMount className="mt-0 flex min-h-0 flex-1 flex-col gap-2 p-0 data-[inert=true]:hidden">
              <ProjectsSidebar projects={projects} topics={topics} tickets={tickets} topicActivity={topicActivity} envs={envs} connected={connected}
                creating={creatingProject} onCreatingChange={setCreatingProject}
                selectedProjectId={selectedProjectId} onSelectedProjectChange={setSelectedProjectId} query={projectQuery} onQueryChange={setProjectQuery}
                activeTopicId={activeTopicId} projectedTicketId={projectedTicketId} onCreateTopic={onCreateTopic} onSelectTopic={onSelectTopic}
                projectNavigation={projectNavigation} onProjectNavigationHandled={onProjectNavigationHandled} onPatchTopic={onPatchTopic} onRequestDeleteTopic={(topic) => { setDeleteError(undefined); setDeleteNeedsStop(false); setDeleteTarget(topic); }}
                onProjectsChange={onProjectsChange} onTopicsChange={onTopicsChange} onManageDevices={() => { onSelectSettingsModule("machines"); onEnterSettings(); }} />
            </Tabs.Panel>
          </Tabs>

          <footer className="kulo-navigation-footer flex shrink-0 flex-col gap-2 pt-2">
            <div className="flex min-w-0 items-center gap-2">
              <Button size="sm" variant="ghost" className="kulo-navigation-footer-action kulo-navigation-create min-w-0 flex-1 justify-start gap-2 px-3"
                aria-label={sideTab === "projects" && selectedProject ? t(`在 ${selectedProject.name} 新建话题`, `New topic in ${selectedProject.name}`) : t("新建话题", "New topic")}
                isDisabled={!connected || sideTab === "projects" && !selectedProject} onPress={createTopic}>
                <KuloIcon name="add" size={16} />
                {t("新建话题", "New topic")}
              </Button>
              {sideTab === "topics" && onSearchConversations ? <Button size="sm" isIconOnly variant="ghost" className="kulo-navigation-search-trigger shrink-0" aria-label={t("搜索对话正文", "Search conversation messages")} onPress={onSearchConversations}><KuloIcon name="search" size={16} /></Button> : <Popover isOpen={searchOpen} onOpenChange={setSearchOpen}>
                <Button size="sm" isIconOnly variant={(sideTab === "topics" ? searchQuery : projectQuery).trim() ? "secondary" : "ghost"}
                  className="kulo-navigation-search-trigger shrink-0"
                  aria-label={sideTab === "topics" ? t("搜索话题", "Search topics") : t("搜索项目和会话", "Search projects and conversations")}>
                  <KuloIcon name="search" size={16} />
                </Button>
                <Popover.Content placement="top end" className="w-72 max-w-[calc(100vw-2rem)]">
                  <Popover.Dialog aria-label={sideTab === "topics" ? t("搜索话题", "Search topics") : t("搜索项目和会话", "Search projects and conversations")}>
                    <SearchField key={sideTab} variant="secondary" className="kulo-navigation-search"
                      aria-label={sideTab === "topics" ? t("搜索话题", "Search topics") : t("搜索项目和会话", "Search projects and conversations")}
                      value={sideTab === "topics" ? searchQuery : projectQuery} onChange={sideTab === "topics" ? onSearchQueryChange : setProjectQuery} fullWidth>
                      <SearchField.Group>
                        <SearchField.SearchIcon />
                        <SearchField.Input ref={searchInputRef} autoFocus placeholder={sideTab === "topics" ? t("搜索话题…", "Search topics…") : t("搜索项目和会话…", "Search projects and conversations…")} />
                        <SearchField.ClearButton aria-label={sideTab === "topics" ? t("清空话题搜索", "Clear topic search") : t("清空项目搜索", "Clear project search")} />
                      </SearchField.Group>
                    </SearchField>
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="ghost" className="kulo-navigation-footer-action min-w-0 justify-start gap-2 px-3" onPress={onEnterSettings}>
                <KuloIcon name="settings" size={16} />

                {t("设置", "Settings")}
              </Button>

              <div className="flex items-center gap-1">
                <ConversationModelSettings
                  settings={settings}
                  onSettingsUpdated={onSettingsUpdated}
                  showProcess={showProcess}
                  onShowProcessChange={onShowProcessChange}
                />

                <UsageStatsPopover
                  settings={settings}
                  envs={envs}
                  messagesCount={messagesCount}
                />
              </div>
            </div>
          </footer>
        </>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={t("删除会话？", "Delete conversation?")}
        description={
          deleteTarget
            ? <div className="flex flex-col gap-2"><span>{t(`删除「${deleteTarget.title || "新对话"}」。`, `Delete “${deleteTarget.title || "New conversation"}”. `)}{deleteNeedsStop || tickets.some((ticket) => (ticket.originTopicId ?? "root") === deleteTarget.id && unfinishedTicket(ticket)) ? t("关联的未结束任务将取消。", "Unfinished tasks will be cancelled.") : ""}</span>{deleteError && <span role="alert" className="text-danger">{deleteError}</span>}</div>
            : undefined
        }
        confirmLabel={deleteNeedsStop || deleteTarget && tickets.some((ticket) => (ticket.originTopicId ?? "root") === deleteTarget.id && unfinishedTicket(ticket)) ? t("停止任务并删除", "Stop tasks and delete") : t("删除会话", "Delete conversation")}
        status="danger"
        isPending={deleting}
        onCancel={() => { restoreTopicFocus.current = undefined; setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
        onCloseComplete={() => {
          const targetId = restoreTopicFocus.current;
          restoreTopicFocus.current = undefined;
          if (targetId !== undefined) focusSurvivingTopic(targetId);
        }}
      />
    </div>
  );
}
