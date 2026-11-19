import { Card } from "@heroui/react";
import type { CapabilitiesWorkspaceSnapshot, ConnectionWorkspaceSnapshot, EnvNodeDescriptor, KuloSettingsView, SettingsAssistantSnapshot, SetupInputRequest, TicketCardView } from "@kulo/protocol";
import type { SettingsModuleId } from "./settings-helpers";
import { SettingsAssistantPanel } from "./settings-assistant-panel";
import type { SettingsAssistantControls } from "./use-settings-assistant";
import type { ConnectionPrepare } from "./connections-module";
import type { CapabilityView, ImageAssistantRequest } from "./capability-views";

export function KuloSettingsRail({
  module, agentName, settings, envs, tickets, onProjectTicket, assistant, assistantLoaded, assistantError, connected, assistantControls, capabilitiesWorkspace, capabilityInputs, capabilityView, onCapabilityInputsChanged, imageRequest, onImageRequestHandled,
  connections, connectionPreparing, onConnectionPrepare, onConnectionsRefresh,
}: {
  module: SettingsModuleId;
  agentName: string;
  settings: KuloSettingsView | null;
  envs: EnvNodeDescriptor[];
  tickets?: TicketCardView[];
  onProjectTicket?: (ticketId: string, title?: string) => void;
  assistant: SettingsAssistantSnapshot;
  assistantLoaded: boolean;
  assistantError: string | null;
  connected: boolean;
  assistantControls: SettingsAssistantControls;
  capabilitiesWorkspace?: CapabilitiesWorkspaceSnapshot | null;
  capabilityInputs?: SetupInputRequest[];
  capabilityView?: CapabilityView;
  imageRequest?: ImageAssistantRequest;
  onImageRequestHandled?: (id: ImageAssistantRequest["id"]) => void;
  onCapabilityInputsChanged?: () => void;
  connections?: ConnectionWorkspaceSnapshot | null;
  connectionPreparing?: boolean;
  onConnectionPrepare?: ConnectionPrepare;
  onConnectionsRefresh?: () => void;
}) {
  return (
    <Card className="kulo-settings-rail gap-0 rounded-3xl bg-surface p-0">
      <Card.Content className="flex min-h-0 flex-1 flex-col p-0">
        <SettingsAssistantPanel
          module={module}
          agentName={agentName}
          settings={settings}
          envs={envs}
          tickets={tickets}
          onProjectTicket={onProjectTicket}
          snapshot={assistant}
          loaded={assistantLoaded}
          error={assistantError}
          connected={connected}
          controls={assistantControls}
          capabilitiesWorkspace={capabilitiesWorkspace}
          capabilityInputs={capabilityInputs}
          capabilityView={capabilityView}
          imageRequest={imageRequest}
          onImageRequestHandled={onImageRequestHandled}
          onCapabilityInputsChanged={onCapabilityInputsChanged}
          connections={connections}
          connectionPreparing={connectionPreparing}
          onConnectionPrepare={onConnectionPrepare}
          onConnectionsRefresh={onConnectionsRefresh}
        />
      </Card.Content>
    </Card>
  );
}
