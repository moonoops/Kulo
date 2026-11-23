import { defineDoc, type ConversationId, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type {
  CapabilityRecord,
  SettingsAssistantAction,
  SettingsAssistantContext,
  SettingsAssistantConversation,
  SettingsBlockName,
  SkillAudience,
} from "@kulo/protocol";
import type { CapabilityPreferenceValues, RestoreCapabilityPreferencesInput } from "./capabilities.js";
import { KuloStateDoc, isOrchestratorConversation, type KuloDurableState, type TopicTitleJob } from "./state.js";

export type WorkspaceUndoOperation =
  | ({ kind: "capability-restore" } & RestoreCapabilityPreferencesInput)
  | { kind: "skill-enabled"; id: string; enabled: boolean; expectedRevision: number; commandId: string };

export type WorkspaceOperation =
  | { kind: "capability-remove" | "skill-remove" | "extension-remove"; id: string; expectedRevision: number; commandId: string }
  | WorkspaceUndoOperation;

export type DeviceAssistantOperation =
  | { kind: "device-disable" }
  | { kind: "device-remove"; deviceId: string }
  | { kind: "device-ssh-add"; connectionId?: string; name?: string; rootDir?: string; scanId?: string }
  | { kind: "device-join"; hubUrl: string; joinRef: string; force?: boolean }
  | { kind: "device-leave" };

export type WorkspaceUndoBefore =
  | { kind: "capability"; capability: Pick<CapabilityRecord, "id" | "revision" | "connectionId" | "modelId" | "kind" | "isDefault"> & CapabilityPreferenceValues; defaults: Record<string, boolean> }
  | { kind: "skill"; id: string; version: string; enabled: boolean; audiences: SkillAudience[]; catalogRevision: number };

export interface WorkspaceUndoSupport {
  before: WorkspaceUndoBefore;
  complete: (before: WorkspaceUndoBefore, result: unknown) => Promise<WorkspaceUndoOperation | undefined>;
}

export interface StoredSettingsAction {
  view: SettingsAssistantAction;
  block?: SettingsBlockName;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  revision?: number;
  removedProviderId?: string;
  cleanupPending?: boolean;
  workspaceOperation?: WorkspaceOperation;
  workspaceResult?: unknown;
  workspaceUndoOperation?: WorkspaceUndoOperation;
  workspaceUndoBefore?: WorkspaceUndoBefore;
  workspaceRunPending?: boolean;
  deviceOperation?: DeviceAssistantOperation;
}

export interface StoredSettingsConversation {
  view: SettingsAssistantConversation;
  actions: StoredSettingsAction[];
  turnContext: SettingsAssistantContext | null;
  observedRevisions: Partial<Record<SettingsBlockName, number>>;
  observedWorkspace?: SettingsAssistantState["observedWorkspace"];
}

export interface SettingsSessionCommand {
  requestId: string;
  kind: "new" | "select" | "delete";
  expectedTopicId: string | null;
  topicId: string;
}

export type SettingsTitleJob = Omit<TopicTitleJob, "status"> & { status: TopicTitleJob["status"] | "skipped" };

export interface SettingsAssistantState {
  conversationId: number | null;
  actions: StoredSettingsAction[];
  submitted: string[];
  turnContext: SettingsAssistantContext | null;
  observedRevisions: Partial<Record<SettingsBlockName, number>>;
  archivedConversationIds: number[];
  conversations?: Record<string, StoredSettingsConversation>;
  sessionCommands?: SettingsSessionCommand[];
  deletedConversationIds?: number[];
  titleJobs?: Record<string, SettingsTitleJob>;
  observedWorkspace?: { capabilityRevision: number; skillRevision: number; capabilities: Record<string, number>; imageDraftRevision?: number };
  mainObservedRevisions?: Record<string, Partial<Record<SettingsBlockName, number>>>;
  mainActions?: Record<string, SettingsAssistantAction>;
}

export const SettingsAssistantDoc = defineDoc<SettingsAssistantState & JsonObject>({
  kind: "kulo.settings-assistant",
  version: 1,
  scope: "session",
  initial: () => ({
    conversationId: null,
    actions: [],
    submitted: [],
    turnContext: null,
    observedRevisions: {},
    archivedConversationIds: [],
  }) as SettingsAssistantState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export function settingsTopicId(conversationId: number): string {
  return `settings-${conversationId}`;
}

export function parseSettingsTopicConversationId(topicId: string | undefined | null): number | null {
  if (typeof topicId !== "string" || !/^settings-[1-9]\d*$/.test(topicId)) return null;
  const id = Number(topicId.slice("settings-".length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function isActiveSettingsConversation(
  conversationId: unknown,
  doc: Readonly<SettingsAssistantState> | undefined,
): boolean {
  const id = Number(conversationId);
  if (!Number.isSafeInteger(id) || id <= 0 || !doc) return false;
  if (doc.deletedConversationIds?.includes(id)) return false;
  return doc.conversationId === id || Boolean(doc.conversations?.[String(id)]) || Boolean(doc.archivedConversationIds?.includes(id));
}

export function isSettingsTopicDeleted(
  topicId: string | undefined,
  doc: Readonly<SettingsAssistantState> | undefined,
): boolean {
  const id = parseSettingsTopicConversationId(topicId);
  if (id === null) return false;
  return !isActiveSettingsConversation(id, doc);
}

export function isMainOrchestratorConversation(
  conversationId: unknown,
  state: Readonly<KuloDurableState> | undefined,
  settingsDoc?: Readonly<SettingsAssistantState> | undefined,
): boolean {
  return isOrchestratorConversation(conversationId, state) || isActiveSettingsConversation(conversationId, settingsDoc);
}

export async function isMainOrchestratorApi(
  api: { conversationId: ConversationId | number; snapshot: Harness["snapshot"] },
  context: Context,
): Promise<{ allowed: boolean; state: Readonly<KuloDurableState> | undefined; settings: Readonly<SettingsAssistantState> | undefined; isSettings: boolean }> {
  const state = await api.snapshot(KuloStateDoc, context);
  if (isOrchestratorConversation(api.conversationId, state)) {
    return { allowed: true, state, settings: undefined, isSettings: false };
  }
  const settings = await api.snapshot(SettingsAssistantDoc, context);
  const isSettings = isActiveSettingsConversation(api.conversationId, settings);
  return { allowed: isSettings, state, settings, isSettings };
}
