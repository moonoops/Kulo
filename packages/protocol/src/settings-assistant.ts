import type { ChatDisplayItem, LiveStreamState } from "./domain.js";
import type { AppearanceCustomization } from "./appearance.js";

export type SettingsAssistantModule = "models" | "workers" | "identity" | "machines" | "appearance" | "capabilities" | "connections" | "permissions" | "schedules" | "archives";
export type SettingsAssistantAppearance = "system" | "light" | "dark";

export interface SettingsAssistantContext {
  module: SettingsAssistantModule;
  active?: boolean;
  pageGeneration?: number;
  hasUnsavedChanges: boolean;
  appearance: SettingsAssistantAppearance;
  appearanceCustomization?: AppearanceCustomization | null;
  clientId: string;
  target?: { kind: "capability" | "skill" | "connection" | "extension" | "external-agent"; id: string };
}

export type SettingsAssistantIntent = "add-api" | "add-oauth" | "edit-identity" | "configure-memory" | "add-connection" | "add-ssh-credential" | "add-device" | "join-device";

export interface SettingsAssistantAction {
  id: string;
  kind: "settings" | "appearance" | "appearance-customization" | "navigate";
  title: string;
  description?: string;
  changes: string[];
  status: "pending" | "submitted" | "applied" | "rejected" | "undone" | "failed";
  requiresConfirmation: boolean;
  canUndo: boolean;
  error?: string;
  historical?: boolean;
  clientId?: string;
  appearance?: SettingsAssistantAppearance;
  previousAppearance?: SettingsAssistantAppearance;
  customization?: AppearanceCustomization;
  previousCustomization?: AppearanceCustomization | null;
  module?: SettingsAssistantModule;
  intent?: SettingsAssistantIntent;
  clientOperation?: "leave-device" | "join-device";
}

export interface SettingsAssistantConversation {
  topicId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  module?: SettingsAssistantModule;
}

export interface SettingsAssistantSnapshot {
  topicId: string | null;
  messages: ChatDisplayItem[];
  live: LiveStreamState;
  actions: SettingsAssistantAction[];
  conversations: SettingsAssistantConversation[];
}

export type SettingsAssistantDecision = "confirm" | "reject" | "undo" | "client-applied" | "client-failed";
