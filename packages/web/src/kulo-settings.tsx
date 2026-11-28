/** Kulo Settings Board & Right Settings Assistant Rail (HeroUI v3). */
import { Alert, Button } from "@heroui/react";
import type {
  ClusterFailoverCandidate,
  ClusterLocalStatusView,
  EnvNodeDescriptor,
  KuloSettingsView,
  SlotSummary,
  CapabilitiesWorkspaceSnapshot,
  ConnectionWorkspaceSnapshot,
  TicketCardView,
  TopicSummary,
  ProjectView,
} from "@kulo/protocol";
import { translate as t, useI18n } from "./kulo-i18n";
import { AppearanceModule } from "./features/settings/appearance-module";
import { ArchivedConversationsModule } from "./features/settings/archived-conversations-module";
import { AgentsModule } from "./features/settings/agents-module";
import { IdentityModule } from "./features/settings/identity-module";
import { MachinesModule } from "./features/settings/machines-module";
import { SystemPermissionsModule } from "./features/settings/system-permissions-module";
import type { SystemPermissionEntry } from "./features/system-permissions/system-permissions";
import { ScheduledTasksModule, type ScheduledTaskActions } from "./features/settings/scheduled-tasks-module";
import { ModelsModule } from "./features/settings/models-module";
import { CapabilitiesModule, type CapabilityAssistantRequest, type CapabilityTarget } from "./features/settings/capabilities-module";
import type { CapabilityView } from "./features/settings/capability-views";
import {
  SETTINGS_MODULES,
  type SettingsModuleId,
} from "./features/settings/settings-helpers";
import { KuloSettingsRail } from "./features/settings/settings-rail";
import type { SettingsAssistantEntryIntent } from "./features/settings/settings-assistant-actions";
import { ConnectionsModule, type ConnectionPrepare } from "./features/settings/connections-module";
import type { AssistantWorkspaceView } from "./kulo-api";
import type { RecentWorkSource } from "./features/settings/recent-work-updates";

export { KuloSettingsRail, SETTINGS_MODULES, type SettingsModuleId };

export function KuloSettingsBoard({
  module,
  settings,
  envs,
  slots,
  tickets = [],
  ticketsLoaded = false,
  scheduledTaskActions,
  topics = [],
  projects = [],
  topicsLoaded = false,
  snapshotError = null,
  onSnapshotRefresh,
  onTopicRestored,
  onSettingsUpdated,
  onDirtyChange,
  entryIntent,
  onIntentHandled,
  capabilities,
  clientId,
  capabilitiesLoading = false,
  capabilitiesError = null,
  connected = true,
  capabilityRequestsDisabled = false,
  capabilityTarget,
  capabilityView,
  onCapabilityViewChange,
  voiceSettingsRequested = false,
  onCapabilityRequest,
  onCapabilitiesRefresh,
  topicId,
  recentWorkSource,
  connections,
  connectionsLoading = false,
  connectionsError = null,
  connectionPreparing = false,
  onConnectionPrepare,
  onConnectionsRefresh,
  assistantWorkspace,
  onAssistantWorkspaceUpdated,
  assistantBusy = false,
  onRequestAssistantPrompt,
  permissionEntry,
  onPermissionEntryHandled,
  onOpenModels,
  onNavigateSettings,
  clusterStatus,
  suppressHubOfflineAlert = false,
  onPromoteCandidate,
  onRequestHandover,
}: {
  module: SettingsModuleId;
  settings: KuloSettingsView | null;
  envs: EnvNodeDescriptor[];
  slots?: SlotSummary;
  tickets?: TicketCardView[];
  ticketsLoaded?: boolean;
  scheduledTaskActions?: ScheduledTaskActions;
  topics?: TopicSummary[];
  projects?: Pick<ProjectView, "id" | "name">[];
  topicsLoaded?: boolean;
  snapshotError?: string | null;
  onSnapshotRefresh?: () => Promise<void> | void;
  onTopicRestored?: (topic: TopicSummary) => void;
  onSettingsUpdated: (next: KuloSettingsView) => void;
  onDirtyChange?: (dirty: boolean) => void;
  entryIntent?: SettingsAssistantEntryIntent | null;
  onIntentHandled?: (id: string) => void;
  capabilities?: CapabilitiesWorkspaceSnapshot | null;
  clientId?: string;
  capabilitiesLoading?: boolean;
  capabilitiesError?: string | null;
  connected?: boolean;
  capabilityRequestsDisabled?: boolean;
  capabilityTarget?: CapabilityTarget;
  capabilityView?: CapabilityView;
  onCapabilityViewChange?: (view: CapabilityView) => void;
  voiceSettingsRequested?: boolean;
  onCapabilityRequest?: CapabilityAssistantRequest;
  onCapabilitiesRefresh?: () => void;
  topicId?: string;
  recentWorkSource?: RecentWorkSource;
  connections?: ConnectionWorkspaceSnapshot | null;
  connectionsLoading?: boolean;
  connectionsError?: string | null;
  connectionPreparing?: boolean;
  onConnectionPrepare?: ConnectionPrepare;
  onConnectionsRefresh?: () => void;
  assistantWorkspace?: AssistantWorkspaceView | null;
  onAssistantWorkspaceUpdated?: (next: AssistantWorkspaceView) => void;
  assistantBusy?: boolean;
  onRequestAssistantPrompt?: (prompt: string) => void;
  permissionEntry?: SystemPermissionEntry | null;
  onPermissionEntryHandled?: (id: string) => void;
  onOpenModels?: () => void;
  onNavigateSettings?: (entry: SettingsAssistantEntryIntent) => Promise<void>;
  clusterStatus?: ClusterLocalStatusView | null;
  suppressHubOfflineAlert?: boolean;
  onPromoteCandidate?: (candidate: ClusterFailoverCandidate) => void;
  onRequestHandover?: (targetNodeId: string, targetName: string) => void;
}) {
  useI18n();
  const needsHubSettings = module === "models" || module === "workers" || module === "identity";
  const localEnvId = envs.find((device) => device.kind === "local")?.id;
  const openModels = onOpenModels ?? (onNavigateSettings ? () => { void onNavigateSettings({ id: crypto.randomUUID(), module: "models" }).catch(() => {}); } : undefined);
  const openSshCredentials = onNavigateSettings
    ? (action: "create" | "verify") => {
        void onNavigateSettings({
          id: crypto.randomUUID(),
          module: "connections",
          tab: "credential",
          ...(action === "create" ? { intent: "add-ssh-credential" as const } : {}),
        }).catch(() => {});
      }
    : undefined;
  return (
    <div className="kulo-settings-board" data-settings-module={module} data-kulo-navigation-key={`settings:${module}`} data-kulo-navigation="content">
      <div key={module} className="kulo-settings-page">
        {needsHubSettings && !settings && !(suppressHubOfflineAlert && !connected) && (
          <div className="kulo-settings-form">
            <Alert status={connected ? "default" : "warning"}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{connected ? t("正在读取设置…", "Loading settings…") : t("与主机连接已断开，可在「设备互联」检查连接或断开主机。", "Disconnected from host. Check Device Connections to reconnect or leave.")}</Alert.Title>
              </Alert.Content>
              {onSnapshotRefresh && (
                <Button size="sm" variant="tertiary" onPress={() => void onSnapshotRefresh()}>{t("重试", "Retry")}</Button>
              )}
            </Alert>
          </div>
        )}
        {module === "connections" && <ConnectionsModule clientId={clientId} snapshot={connections ?? null} loading={connectionsLoading} error={connectionsError} connected={connected} localEnvId={localEnvId} preparing={connectionPreparing} onPrepare={onConnectionPrepare ?? (async () => {})} onRefresh={onConnectionsRefresh ?? (() => {})} entryIntent={entryIntent} onIntentHandled={onIntentHandled} assistant={assistantWorkspace} onAssistantUpdated={onAssistantWorkspaceUpdated} onRequestAssistantPrompt={onRequestAssistantPrompt} />}
        {module === "capabilities" && <CapabilitiesModule clientId={clientId} snapshot={capabilities ?? null} settings={settings} loading={capabilitiesLoading} error={capabilitiesError} connected={connected} requestsDisabled={capabilityRequestsDisabled} localHost={Boolean(connections?.localHost)} envs={envs} target={capabilityTarget} view={capabilityView} onViewChange={onCapabilityViewChange} voiceSettingsRequested={voiceSettingsRequested} onRequest={onCapabilityRequest ?? (() => {})} onRefresh={onCapabilitiesRefresh ?? (() => {})} onDirtyChange={onDirtyChange} onOpenModels={openModels} />}
        {module === "models" && settings && (
          <ModelsModule settings={settings} connected={connected} assistantBusy={assistantBusy} onSettingsUpdated={onSettingsUpdated} onDirtyChange={onDirtyChange} entryIntent={entryIntent} onIntentHandled={onIntentHandled} />
        )}
        {module === "workers" && settings && (
          <AgentsModule
            settings={settings}
            slots={slots}
            envs={envs}
            projects={projects}
            onSettingsUpdated={onSettingsUpdated}
            onDirtyChange={onDirtyChange}
          />
        )}
        {module === "identity" && settings && (
          <IdentityModule
            connected={connected}
            topicId={topicId}
            recentWorkSource={recentWorkSource}
            settings={settings}
            onSettingsUpdated={onSettingsUpdated}
            onDirtyChange={onDirtyChange}
            entryIntent={entryIntent}
            onIntentHandled={onIntentHandled}
          />
        )}
        {module === "machines" && (
          <MachinesModule
            envs={envs}
            entryIntent={entryIntent}
            onIntentHandled={onIntentHandled}
            onRoleChanged={onSnapshotRefresh}
            clusterStatus={clusterStatus}
            suppressHubOfflineAlert={suppressHubOfflineAlert}
            onPromoteCandidate={onPromoteCandidate}
            onRequestHandover={onRequestHandover}
            connections={connections ?? null}
            connectionsLoading={connectionsLoading}
            onOpenSshCredentials={openSshCredentials}
          />
        )}
        {module === "permissions" && <SystemPermissionsModule envs={envs} connected={connected} entry={permissionEntry} onEntryHandled={onPermissionEntryHandled} />}
        {module === "schedules" && <ScheduledTasksModule tickets={tickets} loaded={ticketsLoaded} connected={connected} loadError={snapshotError} onRefresh={onSnapshotRefresh} actions={scheduledTaskActions} />}
        {module === "archives" && <ArchivedConversationsModule topics={topics} projects={projects} loaded={topicsLoaded} connected={connected} loadError={snapshotError} onRefresh={onSnapshotRefresh} onRestored={onTopicRestored} />}
        {module === "appearance" && <AppearanceModule settings={settings} connected={connected} onSettingsUpdated={onSettingsUpdated} />}
      </div>
    </div>
  );
}
