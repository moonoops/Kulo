import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chatReceiptData, chatRoutingData, queuedChatEntries, type ChatMessageSource } from "./chat-submissions.js";
import { PendingChatAttachmentsDoc, assertChatDestination, bindChatAttachments, chatRequestTargetKey, observeChatAttachmentGrants, removePendingChatAttachments, repairHistoricalChatAttachments,
  snapshotChatUploadScope, stageChatAttachments, type ChatDeliveryDraft } from "./chat-attachment-deliveries.js";
import { submitAutomaticChatInput } from "./chat-control.js";
import { DeliveryReceiptDoc, assertDeliveryIntent, assertValidReplyReference, clientDeliveryIntent, deliveryReceiptKey, legacyDeliveryConflict, sameDeliveryValue, validateReliableClientMessage, writeDeliveryReceipt,
  type DeliveryAck, type DeliveryIntent, type DeliveryReceipt, type ReliableClientMessage } from "./delivery-receipts.js";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import type { Credential, CredentialStore, Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionEntry,
  Harness,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  ToolResultEntry,
  ToolTask,
  UserEntry,
  createRegistry,
  defineDoc,
  defineExtension,
  hook,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  type EntryRecord,
  type EntryId,
  type JsonObject,
  type LiveState,
  type Observation,
  type Storage,
  type TaskId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createCodingTools,
  createReadTool,
} from "@earendil-works/pi-durable/tools";
import { EnvManager, canonicalExecutionPath, isApplicationPrivatePath, validateHostMaintenanceCommands } from "@kulo/env";
import { lazyProjectEnvironment } from "./project-env.js";
import { createAndroidToolsExtension, type AndroidToolScope } from "./tools-android.js";
import { KuloAndroidNotifications } from "./android-notifications.js";
import { appendTicketOutwardAction, beginTicketRecovery, createFailureRecoveryTask, recoveryLeaf, sameRecoveryScope,
  recoveryWaitSummary, isSilentRecoveryFailure, resolveSupersededTickets, assertRecoveryGuard, MAX_RECOVERY_ATTEMPTS, RECOVERY_REVIEW_INTERVAL_MS } from "./task-recovery.js";
import { prepareStateStorage } from "./state-storage.js";
import { HubStateOwner } from "./state-owner.js";
import { KuloConnections } from "./connections.js";
import { LocalConnectionVault } from "./connection-vault.js";
import { SecureCredentialStore } from "./secure-provider-credentials.js";
import { createCredentialRedactionExtension, redactCredentialData, scrubStoredConversationSecrets, wrapRedactedStorage } from "./credential-redaction.js";
import type { ConnectionCaller, ConnectionToolController } from "./tools-connections.js";
import { KuloSkills } from "./skills.js";
import { KuloCapabilities, type SyncedProviderImageSource } from "./capabilities.js";
import { KuloSearch } from "./search.js";
import { proxyFetch, retainEnvironmentProxy } from "./http-transport.js";
import { withNativeToolsModels } from "./model-native-tools.js";
import { LocalVoiceAsr } from "./voice-asr.js";
import { KuloVoiceService, VoiceError, type SyncedVoiceModelCandidate, type VoiceAsrEngine } from "./voice-service.js";
import { KuloVoiceCalls, type KuloVoiceCallsOptions } from "./voice-calls.js";
import { TicketBoardProjection } from "./ticket-board.js";
import { VoiceTranscriptEntry } from "./voice-transcripts.js";
import { createVoiceContext } from "./voice-context.js";
import { createVoiceToolsExtension } from "./tools-voice.js";
import { nativeSearchEvidence, sanitizeSearchSources, selectCitedSources } from "./search-sources.js";
import { loadSearchEvidencePrefix, SearchEvidenceHistory } from "./search-history.js";
import { resolveResponseContext } from "./response-context.js";
import { KuloMediaJobs } from "./media-jobs.js";
import { createSkillToolsExtension } from "./tools-skills.js";
import { detectReactWorkspace, SkillRuntimeError } from "./skill-runtime.js";
import { FileError, getOrThrow } from "@earendil-works/pi-durable/env";
import { createCapabilitySetupExtension } from "./tools-capability-setup.js";
import { createMediaToolsExtension } from "./tools-media.js";
import { createMediaExportExtension } from "./tools-media-export.js";
import { createMemoryLifecycleExtension } from "./memory-lifecycle.js";
import { executeMemoryForget, validateRelationshipReviewDecision } from "./memory-forget.js";
import { computeCapDeferredDueAt, KuloUsageCaps, withUsageMeterModels } from "./usage-caps.js";
import {
  ActiveComputerHandoffTracker,
  buildComputerHandoffCard,
  COMPUTER_HANDOFF_TTL_MS,
  computerHandoffFingerprint,
  formatComputerHandoffResumePrompt,
} from "./computer-handoff.js";
import { HindsightLocalService } from "./hindsight-service.js";
import { MemoryLlmBridge } from "./memory-llm-bridge.js";
import { KuloMemoryService, MemoryServiceDoc, createMemoryServiceExtension } from "./memory-service.js";
import { createMemorySetupExtension } from "./tools-memory-setup.js";
import { KuloExtensions, createExtensionsExtension, type ExtensionPackageExecutor } from "./extensions.js";
import { createExtensionSetupExtension } from "./tools-extensions.js";
import { KuloConversationHistory } from "./conversation-history.js";
import { ConversationQueries } from "./conversation-query.js";
import { deriveConnectedExternalClients, type ConversationSearchInput, type MainSessionNotificationEvent, type MemoryServiceJob } from "@kulo/protocol";
import { ExternalAgentQuotaService } from "./external-agent-quotas.js";
import { topicActivity } from "./topic-activity.js";
import { createTopicNotificationBaseline, detectMainSessionNotification, type TopicNotificationBaseline } from "./session-notifications.js";
import { listTaskDeliverables, readTaskDeliverable, reportFileReferences, taskDeliverableError, TaskDeliverableError, type TaskDeliverableOptions } from "./task-deliverables.js";
import { createHistoryToolsExtension } from "./tools-history.js";
import { AssistantDoc, ensureAssistantState } from "./assistant-state.js";
import { AssistantLedger } from "./assistant-ledger.js";
import { AmbientModelService } from "./ambient-model-service.js";
import { AssistantSorter } from "./assistant-sorter.js";
import { AssistantEchoSuppressor } from "./assistant-echo.js";
import { AssistantCoordinator } from "./assistant-coordinator.js";
import { createAssistantToolsExtension } from "./tools-assistant.js";
import { SparkMailService } from "./connectors/spark-mail-service.js";
import { HomeAssistantService, isHomeAssistantPreDispatchError, sanitizeServiceData } from "./connectors/home-assistant.js";
import { HaLanAudioRelay } from "./connectors/ha-lan-audio.js";
import { LarkConnectorService } from "./connectors/lark-connector.js";
import { ContextCompactionDoc, createContextCompactionController, validateBillionKernel, type BillionKernelRuntime } from "./context-compaction.js";
import { type LoadedBillionContextPackage } from "./extension-packages.js";
import { stageProjectSkillSource } from "./skill-source-env.js";
import {
  classifyShellSafetyFloor,
  DEFAULT_IMAGE_TEST_PROMPT,
  defaultProtocolAdapterForModel,
  inferModelPurpose,
  resolveRolePresetFromPool,
  EXTERNAL_AGENT_KINDS,
  isPersonalExternalAgentKind,
  isSupportedExternalAgentKind,
  getMessageParts,
  getUiSpecFields,
  redactSensitiveText,
  type TicketOutwardAction,
  type AmbientLocalEngine,
  type AssistantItemView,
  type AssistantWorkspaceSnapshot,
  type ConnectorBatchAck,
  type ConnectorEventBatch,
  type AgentExpressionState,
  type AgentFace,
  type ChatAttachment,
  type ChatDisplayItem,
  type ChatReplyReference,
  type CustomModelConfig,
  type CustomProviderApi,
  type WebSource,
  type CapabilitiesWorkspaceSnapshot,
  type ComputerUseConfigurationInput,
  type ComputerUseSettings,
  type MediaJob,
  type MediaJobSource,
  type MediaKind,
  type SkillAudience,
  type VoiceSnapshot,
  type VoiceCallEvent,
  type UiActionInput,
  type UiActionReceipt,
  type UiCardSnapshot,
  type IdentityFile,
  type IdentityList,
  type IdentityRead,
  type KuloLanguage,
  type DiscoverModelsRequest,
  type DiscoverModelsResponse,
  type EnvNodeDescriptor,
  type HindsightProbeResult,
  type HindsightMemoryConfig,
  type LiveStreamState,
  type ModelProbeRequest,
  type ModelProbeResult,
  type ModelGatewayConfig,
  type KuloSettingsView,
  type RecentWorkSnapshot,
  type OAuthSessionView,
  type ProviderCatalogItem,
  type ProjectView,
  type CreateProjectInput,
  type RolePreset,
  type SettingsBlockName,
  type SettingsAssistantSnapshot,
  type SlotSummary,
  type SubagentRecord,
  type ThinkingEffort,
  type BuiltinThinkingEffort,
  type TicketCardView,
  type TicketBoardDelta,
  type TicketEnvBinding,
  type WorkerReportRecord,
  type ExternalAgentPendingReport,
  type TicketRecord,
  type TopicSummary,
  type UsageModelItem,
  type UsageStatsView,
  type WorkerInspectEntrySummary,
  type WorkerInspectResult,
  type ConnectionUseOperation,
  type ConnectionDescribeRequest,
  type ComputerPreviewSessionView,
  type ComputerPreviewInputEvent,
  type ComputerPreviewUpdate,
} from "@kulo/protocol";
import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_CONTEXT_WINDOW,
  buildAdaptiveCompactionPolicy,
  resolveHubConfig,
  type KuloHubConfig,
  type KuloHubConfigOverrides,
  type KuloModelConfig,
} from "./config.js";
import { KuloIdentityFiles } from "./identity-files.js";
import { KuloPersonality } from "./personality.js";
import { KuloTopicTitles, createTopicTitleJob } from "./topic-titles.js";
import { buildRecentWorkSnapshot } from "./recent-work.js";
import {
  SettingsAssistant,
  SettingsAssistantDoc,
  createGlobalSettingsToolsExtension,
  createSettingsAssistantExtension,
  isActiveSettingsConversation,
  isSettingsTopicDeleted,
  parseSettingsTopicConversationId,
  settingsTopicId,
  type SettingsAssistantState,
} from "./settings-assistant.js";
import {
  assertUniqueExtensionTools,
  createComputerMixedAndroidTierExtension,
  createSettingsTierExtension,
  injectEventToolsInTx,
  pruneIdleDeferredToolsInTx,
  resolveSettingsPreloadedTools,
  resolveSurfaceTools,
  type ToolSurfaceAudience,
  type ToolSurfaceRuntimeState,
} from "./tool-surface.js";
import { DeviceJoinStaging, createDeviceToolsExtension, type HubDeviceController } from "./tools-devices.js";
import { KuloImageConfiguration, imageSetupIdentifier } from "./image-configuration.js";
import { KuloModelConfiguration, ModelConfigurationDoc } from "./model-configuration.js";
import { createModelConfigurationToolsExtension } from "./tools-model-configuration.js";
import { KuloAgentConfiguration, AgentConfigurationDoc } from "./agent-configuration.js";
import { createAgentConfigurationToolsExtension } from "./tools-agent-configuration.js";
import { createExternalAgentToolHandler, type ExternalAgentReportFile, type ExternalAgentToolScope } from "./external-agent-tools.js";
import { directExternalClientRoleId, externalClientConnectionId, type AgentAssignment, type AgentConfigurationDraft, type AgentDispatchIntent, type ExternalAgentRun, type ExternalWorkspaceMode, type StagedWorkspaceApplyResult, type StagedWorkspaceDiffDetail, type StagedWorkspaceDiffSummary } from "@kulo/protocol";
import { extractAgentDispatchIntent, namedDispatchDevices, resolveAgentDispatch, assertAgentDispatchAvailable, resolveRoleOrDirectClient } from "./agent-routing.js";
import { createAppearanceCustomizationToolsExtension } from "./tools-appearance-customization.js";
import { createCustomizationToolsExtension } from "./tools-customization.js";
import { createDesktopCustomizationService } from "./customization-host.js";
import type { CustomizationCaller, KuloCustomizationService } from "./customization.js";
import {
  KuloActionConfirmations,
  buildCustomizationConfirmCard,
  buildExternalPermissionCard,
  buildHostActionConfirmCard,
  buildMemoryServiceConfirmCard,
  buildStagedApplyConfirmCard,
  buildTicketDecisionCard,
  customizationValidateFingerprint,
  effectiveConfirmationEffect,
  externalPermissionFingerprint,
  hostActionFingerprint,
  memoryServiceOperationFingerprint,
  stagedApplyFingerprint,
  ticketDecisionFingerprint,
  type PendingActionConfirmation,
} from "./action-confirmations.js";
import type { HostActionCaller, HostActionController, HostActionDecideOutcome, HostActionRunOutcome } from "./tools-host-action.js";
import type { AskUserForTicketParams } from "./tools-router.js";
import { API_KEY_ORIGIN_ENV } from "./providers.js";
import { executeHindsightTool, isSafeMemoryText, probeHindsightConnection, resolveHindsightToken, resolveHindsightSharedReadToken } from "./hindsight.js";
import {
  KULO_GATEWAY_PROVIDER_ID,
  KULO_PROVIDER_ID,
  resolveModelThinkingSelection,
  withThinkingLevelModels,
  probeOpenAICompatibleGateway,
} from "./models.js";
import { FileCredentialStore, KuloProviderManager, serializeProviderCatalogItem } from "./providers.js";
import {
  DEFAULT_COMPACTION_FOCUS_INSTRUCTIONS,
  RELATIONSHIP_REVIEW_INSTRUCTIONS,
  createOrchestratorSections,
  formatConnectionRequestMessage,
  formatHostActionRequestMessage,
  formatRecoveryExhaustedRelayMessage,
  formatWorkerInitialPrompt,
  formatWorkerRecoveryMessage,
  formatWorkerRelayMessage,
  formatWorkerWatchdogMessage,
} from "./prompts.js";
import { createWorkerTicketTask } from "./scheduler.js";
import { bindDispatchedAttachments, createDispatchedTicket, type TicketDispatchDraft } from "./ticket-dispatch.js";
import {
  KuloSettingsDoc,
  SettingsUpdateError,
  applySettingsBlockUpdate,
  bindingFromExternalClient,
  hydrateSettingsFromConfig,
  resolveEffectiveIdentityDir,
  rollbackSettingsToSnapshot,
  syncExternalClientsInSettings,
  toPublicSettingsView,
  type KuloDurableSettings,
} from "./settings.js";
import { isLoopbackHost } from "./mcp-presets.js";

function isLoopbackEndpointUrl(rawUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}


import {
  KuloStateDoc,
  WorkerRelayEntry,
  WorkerWatchdogEntry,
  WorkerRecoveryEntry,
  isRecoveryInputBoundary,
  type WorkerRecoveryEntryData,
  recordProcessedCommand,
  ensureDefaultRootTopic,
  isOrchestratorConversation,
  listSortedTopics,
  releaseProjectWrite,
  releaseSlot,
  getActiveStagedCwd,
  getEffectiveWorkspaceDir,
  hasActiveSubagents,
  hasPendingWorkspaceApply,
  isTicketUnfinished,
  ticketsShareWriteScope,
  resolveTicketExecutionScope,
  toTicketCardView,
  transitionTicketStatus,
  applyTopicPreview,
  summarizeTopicPreview,
  type KuloDurableState,
} from "./state.js";
import {
  createOrchestratorToolsExtension,
  type ApplyStagedChangesParams,
  type CloseTicketParams,
  type DispatchTicketModelOutcome,
  type DispatchTicketParams,
  type OrchestratorController,
  type SteerTicketParams,
} from "./tools-router.js";
import {
  createWorkerExtension,
  type RunSubagentsRequest,
  type SubagentTaskOutcome,
} from "./tools-worker.js";
import { createComputerUseExtension } from "./tools-computer-use.js";
import { KuloUploadStore, parseUserEntryContent, sanitizeDiskFilename } from "./uploads.js";
import { EXECUTION_FILE_CHUNK_BYTES, writeExecutionFile } from "./execution-files.js";
import { ContentPublicationEntry, UiActionEntry, KuloUserEntry, KuloUiCards, UiCardError, type ContentPublicationData } from "./ui-cards.js";
import { createContentToolsExtension } from "./tools-content.js";
import { createAssetPublisher } from "./asset-publication.js";
import { createDiagramPublisher } from "./diagram-publication.js";
import { publishExecutionAsset } from "./content-assets.js";
import { KuloProjects, KuloProjectsDoc, ProjectError, assertProjectBinding } from "./projects.js";
import { createProjectToolsExtension, type ProjectController } from "./tools-projects.js";
import {
  boundInspectResult,
  inferBuiltInWorkerPhaseAndFiles,
  spillOversizedReport,
} from "./report-overflow.js";
import {
  canSwitchEnvDuringRecovery,
  detectSenderLocalSignals,
  hasExplicitSenderReference,
  hasWorkerIsolation,
  resolveComputerEnvBinding,
  resolveNamedOrContextualEnv,
  type PriorUserDeviceTurn,
} from "./env-routing-policy.js";

type MessageSubmissionOptions = {
  topicId?: string;
  requestId?: string;
  whenBusy?: "steer" | "followUp";
  attachments?: ChatAttachment[];
  replyTo?: ChatReplyReference;
  principalId?: string;
  source?: ChatMessageSource;
  voiceDelegation?: boolean;
  targetDeviceId?: string;
  deliveryIntent?: DeliveryIntent;
};

function assertMemoryIdentitySeparation(memory: HindsightMemoryConfig, config: KuloHubConfig, envManager?: EnvManager): void {
  const reserved = new Set([config.authToken, ...Object.values(config.envTokens ?? {})].filter(Boolean));
  const router = resolveHindsightToken(memory, "router");
  const worker = resolveHindsightToken(memory, "worker");
  const sharedRead = resolveHindsightSharedReadToken(memory);
  const keys = [router, worker, sharedRead].filter((key): key is string => Boolean(key));
  if (new Set(keys).size !== keys.length ||
      keys.some((key) => reserved.has(key) || envManager?.isNodeCredential(key))) {
    throw new SettingsUpdateError(400, "主脑、Worker、Hub 管理和执行节点必须使用独立密钥。");
  }
}

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

function userDisplayEntry(text: string, attachments: ChatAttachment[], receipt?: {
  requestId?: string; createdAt: number; agentDispatchIntent?: AgentDispatchIntent; source?: ChatMessageSource; targetDeviceId?: string;
}, replyTo?: ChatReplyReference) {
  return { kind: KuloUserEntry.kind, data: { kuloContentVersion: 1, text, attachments: cloneJson(attachments),
    ...(replyTo ? { replyTo: cloneJson(replyTo) } : {}), ...receipt } as unknown as JsonObject };
}

function capturedAgentIntent(value: unknown): AgentDispatchIntent | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectError(409, "agent_assignment_invalid", "无法核对原消息中的 Agent 指派，请重新说明要使用的智能体。");
  const intent = value as Record<string, unknown>;
  if (intent.version !== 1 || !Array.isArray(intent.targets) || intent.targets.length > 16 || intent.targets.some((target: unknown) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return true;
    const item = target as Record<string, unknown>;
    return typeof item.name !== "string" || !item.name.trim() || item.name.length > 200 ||
      item.agentId !== undefined && (typeof item.agentId !== "string" || !item.agentId.trim() || item.agentId.length > 200) ||
      item.kind !== undefined && !(EXTERNAL_AGENT_KINDS as readonly unknown[]).includes(item.kind) ||
      item.envId !== undefined && (typeof item.envId !== "string" || !item.envId.trim() || item.envId.length > 256);
  })) throw new ProjectError(409, "agent_assignment_invalid", "原消息的 Agent 指派记录无效，请重新说明要使用的智能体。");
  return intent.targets.length ? cloneJson(intent) as unknown as AgentDispatchIntent : undefined;
}

function agentIntentContext(intent: AgentDispatchIntent): string {
  return `[KULO_AGENT_ASSIGNMENT]\n${JSON.stringify(intent)}\nAuthoritative Agent assignment constraint parsed from this user message (takes precedence over default dispatch policies; validated by kulo_dispatch). If a named Agent is unconfigured, disabled, unverified, offline, or conflicts with the bound project device, state the exact reason and wait for the user's decision—never substitute a built-in Worker or another Agent. Ask to disambiguate multiple matching candidates, and pass exact role IDs when dispatching to multiple named Agents.`;
}

function withKuloCompactionFocus(models: Models): Models {
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === "completeSimple") {
        return (
          model: Parameters<Models["completeSimple"]>[0],
          context: Parameters<Models["completeSimple"]>[1],
          options?: Parameters<Models["completeSimple"]>[2],
        ) => {
          const [sys, user] = context.messages;
          if (
            context.messages.length === 2 &&
            sys?.role === "system" &&
            typeof sys.content === "string" &&
            sys.content.startsWith("You are a context summarization assistant.") &&
            user?.role === "user" &&
            Array.isArray(user.content) &&
            user.content.length === 1 &&
            user.content[0]?.type === "text" &&
            !user.content[0].text.includes("Additional focus:")
          ) {
            return target.completeSimple(
              model,
              {
                ...context,
                messages: [
                  sys,
                  {
                    ...user,
                    content: [
                      {
                        type: "text",
                        text: `${user.content[0].text}\n\nAdditional focus: ${DEFAULT_COMPACTION_FOCUS_INSTRUCTIONS}`,
                      },
                    ],
                  },
                ],
              },
              options,
            );
          }
          return target.completeSimple(model, context, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function replyContext(text: string, replyTo?: ChatReplyReference): string {
  if (!replyTo) return text;
  const heading = replyTo.excerpt
    ? `【引用消息片段：${replyTo.role} #${replyTo.messageId}】`
    : `【回复消息：${replyTo.role} #${replyTo.messageId}】`;
  return `${heading}\n${replyTo.text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${text}`;
}

function legacyUserPayload(kind: string, data: unknown, content?: Parameters<typeof parseUserEntryContent>[0]): { text: string; attachments: ChatAttachment[]; replyTo?: ChatReplyReference } | undefined {
  if (kind !== KuloUserEntry.kind && kind !== UserEntry.kind) return undefined;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.kuloContentVersion === 1 && typeof record.text === "string" && Array.isArray(record.attachments)) {
      return { text: record.text, attachments: record.attachments as ChatAttachment[], ...(record.replyTo ? { replyTo: record.replyTo as ChatReplyReference } : {}) };
    }
  }
  return content === undefined ? undefined : parseUserEntryContent(content);
}

function assertLegacyChatPayload(stored: { text: string; attachments: ChatAttachment[]; replyTo?: ChatReplyReference } | undefined, text: string, attachments: ChatAttachment[], replyTo?: ChatReplyReference): void {
  if (!stored || stored.text !== text || stored.attachments.length !== attachments.length || !sameDeliveryValue(stored.replyTo, replyTo)) legacyDeliveryConflict();
  for (const [index, attachment] of attachments.entries()) {
    const previous = stored.attachments[index];
    if (!previous || typeof previous !== "object" || !attachment || typeof attachment !== "object") legacyDeliveryConflict();
    const old = previous as unknown as Record<string, unknown>;
    const next = attachment as unknown as Record<string, unknown>;
    for (const key of ["id", "name", "kind", "mimeType", "size", "url"]) if (!sameDeliveryValue(next[key], old[key])) legacyDeliveryConflict();
    // The server may have added probe/transcript fields after upload; every field supplied by this retry must still match.
    for (const [key, value] of Object.entries(next)) if (value !== undefined && !sameDeliveryValue(value, old[key])) legacyDeliveryConflict();
  }
}

function slugifyTitle(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return ascii || "task";
}

function deriveAutoTopicTitle(
  rawText: string,
  attachmentNames: readonly string[] = [],
): string {
  const stripped = rawText
    .replace(/^@ticket:[A-Za-z0-9_-]+\s*/i, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  const candidate = stripped || attachmentNames.find((n) => n.trim().length > 0)?.trim();
  if (!candidate) return "新对话";
  const chars = Array.from(candidate);
  return chars.length > 18 ? `${chars.slice(0, 18).join("")}…` : candidate;
}

const DISPATCH_TOOL_LABELS: Readonly<Record<string, string>> = {
  kulo_dispatch: "派发任务",
  kulo_steer: "推进任务",
  kulo_stop: "停止任务",
  kulo_close: "收口任务",
};

const SILENT_UI_TOOLS = new Set([
  "kulo_dispatch",
  "kulo_steer",
  "kulo_stop",
  "kulo_close",
  "kulo_status",
  "kulo_inspect",
  "kulo_expression",
]);

function entryTimestamp(entry: EntryRecord): number | undefined {
  const rec = entry as unknown as { createdAt?: unknown; at?: unknown };
  if (typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt)) return rec.createdAt;
  if (typeof rec.at === "number" && Number.isFinite(rec.at)) return rec.at;
  const message = entry.model?.[0] as { timestamp?: unknown } | undefined;
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  if (ContentPublicationEntry.is(entry) && typeof entry.data.createdAt === "number" && Number.isFinite(entry.data.createdAt)) return entry.data.createdAt;
  return undefined;
}

function normalizeModelConfig(m: ModelGatewayConfig): KuloModelConfig {
  return {
    ...m,
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    compaction: m.compaction ?? { ...DEFAULT_COMPACTION_CONFIG },
    customProviders: m.customProviders ?? [],
  };
}

function resolveAgentModelAndThinking(
  models: Models,
  fallbackProviderId: string,
  providerOpt: string | undefined,
  modelId: string,
  requestedThinking: ThinkingEffort,
  config: ModelGatewayConfig,
): { model: { provider: string; modelId: string }; thinkingLevel: BuiltinThinkingEffort } {
  const provider = providerOpt?.trim() || fallbackProviderId;
  return resolveModelThinkingSelection(models, provider, modelId, requestedThinking, normalizeModelConfig(config));
}

function summarizeEntryForInspect(entry: EntryRecord): WorkerInspectEntrySummary {
  const id = Number(entry.id);
  const createdAt = entryTimestamp(entry);

  if (UserEntry.is(entry) || KuloUserEntry.is(entry)) {
    const raw = entry.model?.[0] as { content?: unknown } | undefined;
    const text =
      typeof raw?.content === "string"
        ? raw.content
        : Array.isArray(raw?.content)
          ? raw.content
              .map((b) =>
                b && typeof b === "object" && "text" in b && typeof b.text === "string"
                  ? b.text
                  : "",
              )
              .filter(Boolean)
              .join(" ")
          : "";
    const trimmed = text.replace(/\s+/g, " ").trim();
    return {
      id,
      kind: "user",
      summary: trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed || "(用户消息)",
      ...(createdAt ? { createdAt } : {}),
    };
  }

  if (AssistantEntry.is(entry)) {
    const raw = entry.model?.[0] as
      | { content?: Array<{ type?: string; text?: string; name?: string }> }
      | undefined;
    const texts: string[] = [];
    const calls: string[] = [];
    for (const block of raw?.content ?? []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        texts.push(block.text.trim());
      } else if (block.type === "toolCall" && typeof block.name === "string") {
        calls.push(block.name);
      }
    }
    const parts: string[] = [];
    if (calls.length > 0) parts.push(`[调用: ${calls.join(", ")}]`);
    if (texts.length > 0) parts.push(texts.join(" ").replace(/\s+/g, " "));
    const summary = parts.join(" ").trim() || "(助手响应)";
    return {
      id,
      kind: "assistant",
      summary: summary.length > 240 ? `${summary.slice(0, 240)}...` : summary,
      ...(createdAt ? { createdAt } : {}),
    };
  }

  if (ToolResultEntry.is(entry)) {
    const raw = entry.model?.[0] as
      | { toolName?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const name = raw?.toolName ?? "tool";
    const errTag = raw?.isError ? " (ERROR)" : "";
    const snippet = Array.isArray(raw?.content)
      ? raw.content
          .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
    const combined = snippet ? `${name}${errTag}: ${snippet}` : `${name}${errTag}`;
    return {
      id,
      kind: "tool_result",
      summary: combined.length > 220 ? `${combined.slice(0, 220)}...` : combined,
      ...(createdAt ? { createdAt } : {}),
    };
  }

  if (CompactionEntry.is(entry)) {
    return {
      id,
      kind: "compaction",
      summary: "已压缩早期上下文",
      ...(createdAt ? { createdAt } : {}),
    };
  }

  const kindTag = (entry as { kind?: unknown }).kind;
  return {
    id,
    kind: "other",
    summary: typeof kindTag === "string" ? kindTag : "entry",
    ...(createdAt ? { createdAt } : {}),
  };
}

interface DisplayMessageOptions {
  includeToolResults?: boolean;
  redactToolText?: (text: string) => string;
}

export function extractDisplayMessages(entries: readonly EntryRecord[], options: DisplayMessageOptions = {}): ChatDisplayItem[] {
  const items: ChatDisplayItem[] = [];
  const pendingToolCalls = new Map<string, NonNullable<ChatDisplayItem["toolCalls"]>[number]>();
  const redactToolText = options.redactToolText ?? redactSensitiveText;
  let toolOutputRemaining = 32_768;
  let pendingSources: WebSource[] = [];
  let pendingSearchSuggestions: string[] = [];
  let recoveryTurn = false;
  const uiCommands = new Map(entries.filter(UiActionEntry.is).map((entry) => [String(entry.data.commandId), entry.data.receipt as unknown as UiActionReceipt]));

  for (const entry of entries) {
    if (WorkerRecoveryEntry.is(entry)) { recoveryTurn = true; continue; }
    if (isRecoveryInputBoundary(entry)) recoveryTurn = false;
    if (recoveryTurn && (AssistantEntry.is(entry) || ToolResultEntry.is(entry))) continue;
    if (entry.kind === "kulo.memory-context") continue;
    const createdAt = entryTimestamp(entry);

    if (VoiceTranscriptEntry.is(entry)) continue;

    if (ContentPublicationEntry.is(entry)) {
      const sources = selectCitedSources(entry.data.parts.filter((part) => part.type === "markdown").map((part) => part.text).join("\n") || entry.data.fallbackText, pendingSources);
      items.push({ id: Number(entry.id), role: "assistant", text: entry.data.fallbackText,
        parts: entry.data.parts, ...(sources.length ? { sources, ...(pendingSearchSuggestions.length ? { searchSuggestions: pendingSearchSuggestions } : {}) } : {}),
        ...(createdAt ? { createdAt } : {}) });
      continue;
    }

    if (WorkerWatchdogEntry.is(entry)) {
      continue;
    }

    if (WorkerRelayEntry.is(entry)) {
      const d = entry.data;
      pendingSources = sanitizeSearchSources([...pendingSources, ...sanitizeSearchSources(d.sources)]);
      if (d.searchSuggestions) pendingSearchSuggestions = [...new Set([...pendingSearchSuggestions, ...d.searchSuggestions.filter((value) => typeof value === "string" && value.length <= 24_000)])].slice(-4);
      continue;
    }

    if (CompactionEntry.is(entry)) {
      items.push({
        id: entry.id as number,
        role: "system_note",
        text: "已压缩早期上下文",
        ...(createdAt ? { createdAt } : {}),
      });
      continue;
    }

    if (ToolResultEntry.is(entry)) {
      const msg = entry.model?.[0] as
        | {
            role?: string;
            toolCallId?: string;
            toolName?: string;
            isError?: boolean;
            details?: { sources?: unknown; searchSuggestions?: unknown };
            content?: Array<{ type?: string; text?: string }>;
          }
        | undefined;
      if (options.includeToolResults && msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
        const call = pendingToolCalls.get(msg.toolCallId);
        if (call && call.name === msg.toolName) {
          const output = Array.isArray(msg.content) ? msg.content.filter((part) => part.type === "text" && typeof part.text === "string") : [];
          const limit = Math.min(4096, toolOutputRemaining);
          let text = "";
          let truncated = false;
          for (const [index, part] of output.entries()) {
            // Redact before truncation so cutting through a credential cannot defeat exact-value filtering.
            const safe = redactToolText(`${index ? "\n" : ""}${part.text!}`);
            const remaining = limit - text.length;
            text += safe.slice(0, remaining);
            if (safe.length > remaining) { truncated = true; break; }
          }
          toolOutputRemaining -= text.length;
          call.result = { text, isError: Boolean(msg.isError), ...(createdAt ? { createdAt } : {}), ...(truncated ? { truncated: true } : {}) };
          pendingToolCalls.delete(msg.toolCallId);
        }
      }
      if (msg && msg.role === "toolResult" && !msg.isError && msg.toolName) {
        if (msg.toolName === "web_search" || msg.toolName === "web_fetch") {
          pendingSources = sanitizeSearchSources([...pendingSources, ...sanitizeSearchSources(msg.details?.sources)]);
          if (typeof msg.details?.searchSuggestions === "string" && msg.details.searchSuggestions.length <= 64_000) {
            pendingSearchSuggestions = [...new Set([...pendingSearchSuggestions, msg.details.searchSuggestions])].slice(-4);
          }
        }
        const actionLabel = DISPATCH_TOOL_LABELS[msg.toolName];
        if (actionLabel && Array.isArray(msg.content)) {
          const textPart = msg.content.find((c) => c.type === "text" && typeof c.text === "string");
          if (textPart?.text) {
            try {
              const parsed = JSON.parse(textPart.text) as {
                ticket?: { id?: string; title?: string; userSummary?: string };
                inline_delivery?: { sources?: WebSource[] };
              };
              if (parsed.inline_delivery) {
                if (parsed.inline_delivery.sources?.length) {
                  pendingSources = sanitizeSearchSources([...pendingSources, ...sanitizeSearchSources(parsed.inline_delivery.sources)]);
                }
              } else if (parsed.ticket?.id && parsed.ticket.title) {
                items.push({
                  id: entry.id as number,
                  role: "dispatch",
                  text: parsed.ticket.title,
                  ...(createdAt ? { createdAt } : {}),
                  dispatch: {
                    actionLabel,
                    ticketId: parsed.ticket.id,
                    title: parsed.ticket.title,
                    ...(parsed.ticket.userSummary
                      ? { userSummary: parsed.ticket.userSummary }
                      : {}),
                  },
                });
              }
            } catch {
              // ignore non-JSON diagnostics block
            }
          }
        }
      }
      continue;
    }

    if (UserEntry.is(entry) || KuloUserEntry.is(entry)) {
      pendingSources = [];
      pendingSearchSuggestions = [];
      const msg = entry.model?.[0];
      const data = (entry.data ?? {}) as unknown as { kuloContentVersion?: unknown; text?: unknown; attachments?: unknown; replyTo?: ChatReplyReference };
      if (msg?.role === "user" || KuloUserEntry.is(entry) && data.kuloContentVersion === 1 && typeof data.text === "string" && Array.isArray(data.attachments)) {
        const parsed = data.kuloContentVersion === 1 && typeof data.text === "string" && Array.isArray(data.attachments)
          ? { text: data.text, attachments: data.attachments as ChatAttachment[] }
          : parseUserEntryContent(msg?.role === "user" ? msg.content : "");
        if (parsed.text.trimStart().startsWith("[KULO_WORKER_WATCHDOG]")) {
          continue;
        }
        let displayText = parsed.text;
        if (displayText.startsWith('{"type":"kulo.ui.action"')) {
          try {
            const action = JSON.parse(displayText) as { commandId: string; title: string; action: { label: string }; values: Record<string, unknown> };
            const card = uiCommands.get(action.commandId)?.card;
            if (card) {
              const fields = getUiSpecFields(card.spec);
              const lines = Object.entries(action.values).map(([key, value]) => {
                const element = Object.values(card.spec.elements).find((item) => item.props.field === key);
                const options = element && Array.isArray(element.props.options) ? element.props.options as Array<{ value: string; label: string }> : [];
                const format = (item: unknown) => typeof item === "boolean" ? item ? "开启" : "关闭" : options.find((option) => option.value === item)?.label ?? String(item);
                return `${fields.find((field) => field.name === key)?.label ?? key}：${Array.isArray(value) ? value.map(format).join("、") : format(value)}`;
              });
              displayText = `${action.title} · ${action.action.label}${lines.length ? `\n${lines.join("\n")}` : ""}`;
            }
          } catch { /* Ordinary user text retains its original display. */ }
        }
        items.push({
          id: entry.id as number,
          role: "user",
          text: displayText,
          ...(data.replyTo ? { replyTo: cloneJson(data.replyTo) } : {}),
          ...(parsed.attachments.length > 0 ? { attachments: parsed.attachments } : {}),
          ...(createdAt ? { createdAt } : {}),
          ...chatReceiptData(entry.data),
        });
      }
      continue;
    }

    if (AssistantEntry.is(entry)) {
      const msg = entry.model?.[0];
      if (msg && msg.role === "assistant") {
        const native = nativeSearchEvidence(msg);
        pendingSources = sanitizeSearchSources([...pendingSources, ...native.sources]);
        pendingSearchSuggestions = [...new Set([...pendingSearchSuggestions, ...native.searchSuggestions])].slice(-4);
        const textBlocks: string[] = [];
        const thinkingBlocks: string[] = [];
        const toolCalls: NonNullable<ChatDisplayItem["toolCalls"]> = [];

        for (const block of msg.content) {
          if (block.type === "text" && block.text.trim()) {
            textBlocks.push(block.text);
          } else if (block.type === "thinking" && block.thinking.trim()) {
            thinkingBlocks.push(block.thinking);
          } else if (block.type === "toolCall") {
            if (SILENT_UI_TOOLS.has(block.name)) continue;
            const rawArgs = JSON.stringify(options.includeToolResults ? redactCredentialData(block.arguments ?? {}, redactToolText) : block.arguments ?? {});
            const summaryValue = options.includeToolResults ? ["command", "path", "file_path", "target_path", "query", "url", "action", "summary", "title"]
              .map((key) => block.arguments?.[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0) : undefined;
            const actionSummary = summaryValue === undefined ? undefined : redactToolText(summaryValue).trim().split(/[\r\n]/, 1)[0]!.slice(0, 140);
            const call = {
              id: block.id,
              name: block.name,
              argsSummary: rawArgs.length > 140 ? `${rawArgs.slice(0, 140)}...` : rawArgs,
              ...(actionSummary ? { actionSummary } : {}),
            };
            toolCalls.push(call);
            if (options.includeToolResults) pendingToolCalls.set(call.id, call);
          }
        }

        const joinedText = textBlocks.join("\n").trim();
        const sources = joinedText ? sanitizeSearchSources([...native.sources, ...selectCitedSources(joinedText, pendingSources)]) : [];
        if ((joinedText === "[WATCHDOG_OK]" || joinedText === "[RECOVERY_OK]" || joinedText === "[COORDINATOR_OK]") && toolCalls.length === 0) {
          continue;
        }

        if (textBlocks.length > 0 || toolCalls.length > 0 || thinkingBlocks.length > 0) {
          items.push({
            id: entry.id as number,
            role: "assistant",
            text: textBlocks.join("\n"),
            ...(sources.length ? { sources, ...(pendingSearchSuggestions.length ? { searchSuggestions: pendingSearchSuggestions } : {}) } : {}),
            ...(createdAt ? { createdAt } : {}),
            ...(thinkingBlocks.length > 0 ? { thinking: thinkingBlocks.join("\n") } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          });
        }
      }
    }
  }

  const { responseIds } = resolveResponseContext(entries);
  return items.map((item) => {
    const responseId = responseIds.get(item.id);
    return responseId === undefined ? item : { ...item, responseId };
  });
}

export function extractLiveState(view: ConversationView, responseEntries: readonly EntryRecord[] = view.entries): LiveStreamState {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
  const lastInput = [...responseEntries].reverse().find(isRecoveryInputBoundary);
  if (lastInput && WorkerRecoveryEntry.is(lastInput)) {
    return { busy: Boolean(live?.run), activeTools: [], queuedCount: Array.isArray(inbox?.items) ? inbox.items.length : 0 };
  }

  let rawStreamingText: string | undefined;
  let streamingText: string | undefined;
  let streamingThinking: string | undefined;

  const partialContent = live?.generation?.message?.content;
  if (Array.isArray(partialContent)) {
    const texts: string[] = [];
    const thoughts: string[] = [];
    for (const block of partialContent) {
      if (block && typeof block === "object") {
        if ("type" in block && block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          "type" in block &&
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          thoughts.push(block.thinking);
        }
      }
    }
    if (texts.length > 0) rawStreamingText = texts.join("");
    if (thoughts.length > 0) streamingThinking = thoughts.join("");
  }

  const activeTools = (live?.tools ?? [])
    .filter((t) => t.status !== "done" && !SILENT_UI_TOOLS.has(t.name))
    .map((t) => ({
      callId: t.callId,
      name: t.name,
      ...(t.output ? { outputTail: t.output.slice(-400) } : {}),
    }));

  const trimmedStreaming = rawStreamingText?.trim() ?? "";
  if (
    rawStreamingText &&
    !(
      activeTools.length === 0 &&
      (
        (trimmedStreaming.startsWith("[W") && "[WATCHDOG_OK]".startsWith(trimmedStreaming)) ||
        (trimmedStreaming.startsWith("[C") && "[COORDINATOR_OK]".startsWith(trimmedStreaming)) ||
        (trimmedStreaming.startsWith("[R") && "[RECOVERY_OK]".startsWith(trimmedStreaming))
      )
    )
  ) {
    streamingText = rawStreamingText;
  }

  const { currentResponseId } = resolveResponseContext(responseEntries);
  return {
    busy: Boolean(live?.run),
    ...(live?.run && currentResponseId !== undefined ? { responseId: currentResponseId } : {}),
    ...(streamingText ? { streamingText } : {}),
    ...(streamingThinking ? { streamingThinking } : {}),
    activeTools,
    queuedCount: Array.isArray(inbox?.items) ? inbox.items.length : 0,
    ...(Boolean(live?.run) && live?.generation?.retry
      ? {
          retrying: {
            attempt: live.generation.attempt,
            at: live.generation.retry.at,
          },
        }
      : {}),
    ...(live?.runFailure
      ? {
          runFailure: {
            ...(typeof live.runFailure.taskId === "number"
              ? { taskId: Number(live.runFailure.taskId) }
              : {}),
            reason: live.runFailure.reason,
            ...(live.runFailure.detail !== undefined
              ? { detail: live.runFailure.detail }
              : {}),
          },
        }
      : {}),
  };
}

export interface KuloHubInitOptions {
  voiceAsr?: VoiceAsrEngine;
  voiceOpenLive?: KuloVoiceCallsOptions["openLive"];
  config?: KuloHubConfigOverrides;
  storage?: Storage;
  models?: Models;
  providerId?: string;
  watchdogCheckIntervalMs?: number;
  watchdogStallMsOverride?: number;
  orchestratorBrowserIdleMs?: number;
  connectionManager?: KuloConnections;
  connectionVault?: LocalConnectionVault;
  credentialStore?: CredentialStore;
  extensionPackages?: ExtensionPackageExecutor;
}

export interface HubEventListener {
  onVoice?: (snapshot: VoiceSnapshot) => void;
  onCapabilities?: (snapshot: CapabilitiesWorkspaceSnapshot) => void;
  onTopicView?: (topicId: string, messages: ChatDisplayItem[], live: LiveStreamState) => void;
  onRootView?: (messages: ChatDisplayItem[], live: LiveStreamState) => void;
  onTopics?: (topics: TopicSummary[]) => void;
  onProjects?: (projects: ProjectView[]) => void;
  onTickets?: (tickets: TicketCardView[], slots: SlotSummary) => void;
  onTicketDelta?: (delta: TicketBoardDelta, snapshot: () => ReturnType<TicketBoardProjection["snapshot"]>) => void;
  onAssistantItems?: (assistantRevision: number, items: AssistantItemView[]) => void;
  onEnvs?: (envs: EnvNodeDescriptor[]) => void;
  onExpression?: (expression: AgentExpressionState | null) => void;
  onSettings?: (settings: KuloSettingsView) => void;
  onSettingsAssistant?: (snapshot: SettingsAssistantSnapshot) => void;
  onUiCard?: (card: UiCardSnapshot) => void;
  onNotification?: (event: MainSessionNotificationEvent) => void;
}

interface WatchedTopicCache {
  topicId: string;
  conversation: Conversation;
  watch: ConversationWatch;
  messages: ChatDisplayItem[];
  live: LiveStreamState;
  notificationBaseline: TopicNotificationBaseline;
}

type TopicView = Pick<WatchedTopicCache, "topicId" | "messages" | "live"> & { historyBefore?: number };

function requireTopic(state: Readonly<KuloDurableState> | undefined, topicId: string) {
  const topic = state?.topics && Object.hasOwn(state.topics, topicId) ? state.topics[topicId] : undefined;
  if (topic?.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
  if (!topic) throw new ProjectError(404, "topic_not_found", "会话不存在。");
  return topic;
}

const MediaNoticesDoc = defineDoc<{ notices: Record<string, boolean> } & JsonObject>({
  kind: "kulo.media-notices", version: 1, scope: "session", initial: () => ({ notices: {} }) as { notices: Record<string, boolean> } & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

const RelationshipReviewsDoc = defineDoc<{ conversationIds: number[] } & JsonObject>({
  kind: "kulo.relationship-reviews", version: 1, scope: "session",
  initial: () => ({ conversationIds: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

interface RelationshipEvidenceProgress {
  cursor: number;
  entries: Record<string, number>;
  reports: Record<string, string>;
}
const RelationshipEvidenceDoc = defineDoc<(RelationshipEvidenceProgress & {
  pending: RelationshipEvidenceProgress | null;
}) & JsonObject>({
  kind: "kulo.relationship-evidence", version: 1, scope: "session",
  initial: () => ({ cursor: 0, entries: {}, reports: {}, pending: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

interface TrackedWorkerRuntime {
  ticketId: string;
  workerConversationId: number;
  runEpoch: number;
  lastActivityAt: number;
  detachObserver?: () => void;
}

/**
 * KuloHub: Durable SuperAgent Engine combining Pi Durable (SQLite) + Pi Env + Identity Documents + Hindsight.
 */
export class KuloHub implements OrchestratorController {
  readonly #ticketBoard = new TicketBoardProjection();
  readonly config: KuloHubConfig;
  readonly envManager: EnvManager;
  readonly harness: Harness;
  readonly rootConversation: Conversation;
  readonly identityFiles: KuloIdentityFiles;
  readonly personality: KuloPersonality;
  readonly uploads: KuloUploadStore;
  readonly settingsAssistant: SettingsAssistant;
  readonly uiCards: KuloUiCards;
  readonly actionConfirmations: KuloActionConfirmations;
  readonly projects: KuloProjects;
  readonly skills: KuloSkills;
  readonly capabilities: KuloCapabilities;
  readonly imageConfiguration: KuloImageConfiguration;
  readonly modelConfiguration: KuloModelConfiguration;
  readonly agentConfiguration: KuloAgentConfiguration;
  readonly externalClientQuotas: ExternalAgentQuotaService;
  readonly usageCaps: KuloUsageCaps;
  readonly search: KuloSearch;
  readonly voice: KuloVoiceService;
  readonly voiceCalls: KuloVoiceCalls;
  readonly #voiceTranscriptions = new Map<string, Promise<ChatAttachment>>();
  readonly mediaJobs: KuloMediaJobs;
  readonly memoryLlmBridge: MemoryLlmBridge;
  readonly memoryService: KuloMemoryService;
  readonly extensions: KuloExtensions;
  readonly history: KuloConversationHistory;
  readonly assistantLedger: AssistantLedger;
  readonly ambientModel: AmbientModelService;
  readonly assistantSorter: AssistantSorter;
  readonly assistantCoordinator: AssistantCoordinator;
  readonly sparkMail: SparkMailService;
  readonly haLanAudio: HaLanAudioRelay;
  readonly homeAssistant: HomeAssistantService;
  readonly larkConnector: LarkConnectorService;
  #lanHttpEndpointProvider?: () => { lanReachable: boolean; port: number } | undefined;
  readonly connectionManager: KuloConnections;
  readonly connections: ConnectionToolController;

  readonly #providerId: string;
  readonly #models: Models;
  readonly #releaseProxy: () => Promise<void>;
  readonly #stateOwner: HubStateOwner;
  get localInstance(): Pick<HubStateOwner, "publish" | "proveLocalIdentity"> { return this.#stateOwner; }
  readonly #providerManager: KuloProviderManager | null;
  readonly #defaultIdentityDir: string;
  readonly #mainWorkspaceDir: string;
  readonly #workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
  readonly #failureRecoveryTask: ReturnType<typeof createFailureRecoveryTask>;
  readonly #codingToolsExt: ReturnType<typeof createCodingTools>;
  readonly #androidExt: ReturnType<typeof createAndroidToolsExtension>;
  readonly #androidNotifications: KuloAndroidNotifications;
  readonly #toolSearchExt: ReturnType<typeof createToolSearchExtension>;
  readonly #settingsTierExt: ReturnType<typeof createSettingsTierExtension>;
  readonly #computerMixedAndroidTierExt: ReturnType<typeof createComputerMixedAndroidTierExtension>;
  readonly #orchestratorGuardExt: ReturnType<typeof defineExtension>;
  readonly #computerUseExt: ReturnType<typeof createComputerUseExtension>;
  readonly #routerReadExt: ReturnType<typeof defineExtension>;
  readonly #workerExt: ReturnType<typeof createWorkerExtension>;
  readonly #orchestratorExt: ReturnType<typeof createOrchestratorToolsExtension>;
  readonly #orchestratorTailExt: ReturnType<typeof defineExtension>;
  readonly #globalSettingsExt: ReturnType<typeof createGlobalSettingsToolsExtension>;
  readonly #contentExt: ReturnType<typeof createContentToolsExtension>;
  readonly #projectExt: ReturnType<typeof createProjectToolsExtension>;
  readonly #skillExt: ReturnType<typeof createSkillToolsExtension>;
  readonly #mediaExt: ReturnType<typeof createMediaToolsExtension>;
  readonly #voiceExt: ReturnType<typeof createVoiceToolsExtension>;
  readonly #mediaExportExt: ReturnType<typeof createMediaExportExtension>;
  readonly #memoryLifecycleExt: ReturnType<typeof createMemoryLifecycleExtension>;
  readonly #memoryServiceExt: ReturnType<typeof createMemoryServiceExtension>;
  readonly #memorySetupExt: ReturnType<typeof createMemorySetupExtension>;
  readonly #redactionExt: ReturnType<typeof createCredentialRedactionExtension>;
  readonly #historyExt: ReturnType<typeof createHistoryToolsExtension>;
  readonly #assistantToolsExt: ReturnType<typeof createAssistantToolsExtension>;
  readonly #customizationExtensions: ReturnType<typeof createCustomizationToolsExtension>[];
  #customizationService: Promise<KuloCustomizationService> | undefined;
  #customizationInstance: KuloCustomizationService | undefined;
  readonly #contextCompaction: ReturnType<typeof createContextCompactionController>;
  #contextPackage: LoadedBillionContextPackage | null = null;
  #contextPackageLoad: Promise<LoadedBillionContextPackage | null> | null = null;
  #contextEnabled = false;
  #ttsEnabled = false;
  #webSearchAvailable = true;
  #assistantActive = false;
  #computerUseSettings: ComputerUseSettings = { browserEnabled: true, desktopEnabled: true };
  readonly #contextPreferenceUpdates = new Set<Promise<void>>();
  #envTransition: Promise<void> = Promise.resolve();
  #waitTransition: Promise<void> = Promise.resolve();
  readonly #parkingTickets = new Map<string, Promise<void>>();
  readonly #subagentBatches = new Map<number, Promise<void>>();
  readonly #listeners = new Set<HubEventListener>();
  readonly #topicCaches = new Map<string, WatchedTopicCache>();
  readonly #topicTitleCache = new Map<string, string>();
  readonly #topicPreviewCache = new Map<string, { preview: string; at?: number }>();
  #queryService?: ConversationQueries;
  readonly #chatAdmissions = new Map<string, Promise<unknown>>();
  readonly #deliveryAdmissions = new Map<string, Promise<unknown>>();
  readonly #ticketAdmissions = new Map<string, Promise<unknown>>();
  readonly #inlineDispatchWaiters = new Map<string, Set<() => void>>();
  readonly #topicTitles: KuloTopicTitles;
  readonly #cardSnapshots = new Map<string, UiCardSnapshot>();
  readonly #searchHistories = new Map<number, SearchEvidenceHistory>();
  readonly #trackedWorkers = new Map<string, TrackedWorkerRuntime>();
  readonly #computerSessions = new Map<string, { ticketId: string; envId: string; tool: "browser" | "desktop"; sessionId: string; conversationId: number; runEpoch: number; app?: string }>();
  readonly #computerHandoffs = new ActiveComputerHandoffTracker();
  readonly #orchestratorBrowserSessions = new Map<string, { topicId: string; conversationId: number; envId: string; sessionId: string; idleTimer: ReturnType<typeof setTimeout> }>();
  readonly #orchestratorBrowserIdleMs: number;
  readonly #lastWatchdogAlertAt = new Map<string, number>();
  readonly #watchdogCheckIntervalMs: number;
  readonly #verifyClientReceipts = new Map<string, import("@kulo/protocol").ExternalAgentVerifyClientResult>();
  readonly #watchdogStallMsOverride?: number;
  readonly deviceJoinStaging: DeviceJoinStaging;
  readonly assistantEchoSuppressor = new AssistantEchoSuppressor();
  #deviceController: HubDeviceController | undefined;

  #watchdogTimer: ReturnType<typeof setInterval> | null = null;
  #topicAutoArchiveTimer: ReturnType<typeof setInterval> | null = null;
  #uploadCleanupTimer: ReturnType<typeof setInterval> | null = null;
  #topicAutoArchiveRun: Promise<TopicSummary[]> | null = null;
  readonly #topicActivityUpdates = new Map<string, Promise<void>>();
  #cleanupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #cleanupRetryDelayMs = 500;
  #watchdogTickInFlight = false;
  #liveSettings: KuloDurableSettings;
  #recovering = true;
  #closed = false;
  #closing?: Promise<void>;
  #androidHubId = "";
  #onClusterDirty?: (kind: "sqlite" | "assistant" | "vault" | "files" | "uploads") => void;
  #clusterCloseHook?: () => Promise<void>;
  #clusterHostContext?: { localNodeId: string; legacyLocalNodeId?: string };
  #handoverBarrierActive = false;
  #handoverBarrierTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(params: {
    releaseProxy: () => Promise<void>;
    stateOwner: HubStateOwner;
    config: KuloHubConfig;
    envManager: EnvManager;
    harness: Harness;
    rootConversation: Conversation;
    identityFiles: KuloIdentityFiles;
    uploads: KuloUploadStore;
    providerId: string;
    models: Models;
    providerManager: KuloProviderManager | null;
    defaultIdentityDir: string;
    mainWorkspaceDir: string;
    liveSettings: KuloDurableSettings;
    workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
    failureRecoveryTask: ReturnType<typeof createFailureRecoveryTask>;
    codingToolsExt: ReturnType<typeof createCodingTools>;
    androidExt: ReturnType<typeof createAndroidToolsExtension>;
    toolSearchExt: ReturnType<typeof createToolSearchExtension>;
    settingsTierExt: ReturnType<typeof createSettingsTierExtension>;
    computerMixedAndroidTierExt: ReturnType<typeof createComputerMixedAndroidTierExtension>;
    orchestratorGuardExt: ReturnType<typeof defineExtension>;
    computerUseExt: ReturnType<typeof createComputerUseExtension>;
    routerReadExt: ReturnType<typeof defineExtension>;
    workerExt: ReturnType<typeof createWorkerExtension>;
    orchestratorExt: ReturnType<typeof createOrchestratorToolsExtension>;
    orchestratorTailExt: ReturnType<typeof defineExtension>;
    globalSettingsExt: ReturnType<typeof createGlobalSettingsToolsExtension>;
    settingsAssistantExt: ReturnType<typeof createSettingsAssistantExtension>;
    customizationExt?: ReturnType<typeof createCustomizationToolsExtension>;
    appearanceCustomizationExt: ReturnType<typeof createAppearanceCustomizationToolsExtension>;
    modelConfigurationExt: ReturnType<typeof createModelConfigurationToolsExtension>;
    agentConfigurationExt: ReturnType<typeof createAgentConfigurationToolsExtension>;
    deviceToolsExt: ReturnType<typeof createDeviceToolsExtension>;
    deviceJoinStaging: DeviceJoinStaging;
    contentExt: ReturnType<typeof createContentToolsExtension>;
    projectExt: ReturnType<typeof createProjectToolsExtension>;
    skillExt: ReturnType<typeof createSkillToolsExtension>;
    mediaExt: ReturnType<typeof createMediaToolsExtension>;
    voiceExt: ReturnType<typeof createVoiceToolsExtension>;
    capabilitySetupExt: ReturnType<typeof createCapabilitySetupExtension>;
    mediaExportExt: ReturnType<typeof createMediaExportExtension>;
    memoryLifecycleExt: ReturnType<typeof createMemoryLifecycleExtension>;
    memoryServiceExt: ReturnType<typeof createMemoryServiceExtension>;
    memorySetupExt: ReturnType<typeof createMemorySetupExtension>;
    extensionsExt: ReturnType<typeof createExtensionsExtension>;
    extensionSetupExt: ReturnType<typeof createExtensionSetupExtension>;
    historyExt: ReturnType<typeof createHistoryToolsExtension>;
    assistantToolsExt: ReturnType<typeof createAssistantToolsExtension>;
    contextCompaction: ReturnType<typeof createContextCompactionController>;
    extensionPackages?: ExtensionPackageExecutor;
    connectionManager: KuloConnections;
    connections: ConnectionToolController;
    redactionExt: ReturnType<typeof createCredentialRedactionExtension>;
    credentialStore: CredentialStore;
    voiceAsr?: VoiceAsrEngine;
    voiceOpenLive?: KuloVoiceCallsOptions["openLive"];
    watchdogCheckIntervalMs: number;
    watchdogStallMsOverride?: number;
    orchestratorBrowserIdleMs: number;
  }) {
    this.#releaseProxy = params.releaseProxy;
    this.#stateOwner = params.stateOwner;
    this.config = params.config;
    this.envManager = params.envManager;
    this.harness = params.harness;
    this.connectionManager = params.connectionManager;
    this.connections = params.connections;
    this.#redactionExt = params.redactionExt;
    this.rootConversation = params.rootConversation;
    this.identityFiles = params.identityFiles;
    this.usageCaps = new KuloUsageCaps({ harness: params.harness });
    this.personality = new KuloPersonality({
      harness: params.harness,
      identityFiles: params.identityFiles,
      collectRelationshipInput: (since) => this.#collectRelationshipInput(since),
      canReviewRelationship: () => this.#canReviewRelationship(),
      isUsageCapped: () => this.usageCaps.isCappedFor("personality").capped,
      reviewRelationship: (input) => this.#reviewRelationship(input),
      onError: (error) => console.error("[KuloPersonality]", error),
    });
    this.uploads = params.uploads;
    this.#providerId = params.providerId;
    this.#models = params.models;
    this.#providerManager = params.providerManager;
    this.#defaultIdentityDir = params.defaultIdentityDir;
    this.#mainWorkspaceDir = params.mainWorkspaceDir;
    this.#liveSettings = params.liveSettings;
    this.#androidNotifications = new KuloAndroidNotifications({ stateDir: this.config.stateDir, models: this.#models,
      agent: () => this.#resolveOrchestratorAgent(), hubId: () => this.#androidHubId,
      redact: text => this.connectionManager.redact(text) });
    this.#androidNotifications.setOnWrite(() => this.#notifyClusterDirty("files"));
    this.uploads.setOnWrite(() => this.#notifyClusterDirty("uploads"));
    this.identityFiles.setOnWrite(() => this.#notifyClusterDirty("files"));
    this.connectionManager.setOnPersist(() => this.#notifyClusterDirty("files"));
    this.connectionManager.localVault?.setOnChange(() => this.#notifyClusterDirty("vault"));
    this.envManager.setAndroidNotificationClassifier((request, signal) => this.#androidNotifications.classify(request, signal));
    this.#topicTitles = new KuloTopicTitles({
      harness: this.harness,
      agent: () => this.#resolveOrchestratorAgent(),
      publish: (topics) => this.#emitTopics(topics),
      extensions: () => [this.#redactionExt],
      redact: (text) => this.connectionManager.redact(text),
    });
    this.#workerTicketTask = params.workerTicketTask;
    this.#failureRecoveryTask = params.failureRecoveryTask;
    this.#codingToolsExt = params.codingToolsExt;
    this.#androidExt = params.androidExt;
    this.#toolSearchExt = params.toolSearchExt;
    this.#settingsTierExt = params.settingsTierExt;
    this.#computerMixedAndroidTierExt = params.computerMixedAndroidTierExt;
    this.#orchestratorGuardExt = params.orchestratorGuardExt;
    this.#computerUseExt = params.computerUseExt;
    this.#routerReadExt = params.routerReadExt;
    this.#workerExt = params.workerExt;
    this.#orchestratorExt = params.orchestratorExt;
    this.#orchestratorTailExt = params.orchestratorTailExt;
    this.#globalSettingsExt = params.globalSettingsExt;
    this.#contentExt = params.contentExt;
    this.#projectExt = params.projectExt;
    this.#skillExt = params.skillExt;
    this.#mediaExt = params.mediaExt;
    this.#voiceExt = params.voiceExt;
    this.#mediaExportExt = params.mediaExportExt;
    this.#memoryServiceExt = params.memoryServiceExt;
    this.#memorySetupExt = params.memorySetupExt;
    this.#memoryLifecycleExt = params.memoryLifecycleExt;
    this.#historyExt = params.historyExt;
    this.#assistantToolsExt = params.assistantToolsExt;
    this.#customizationExtensions = params.customizationExt ? [params.customizationExt] : [];
    this.#contextCompaction = params.contextCompaction;
    this.history = new KuloConversationHistory({ harness: this.harness, stateDir: this.config.stateDir });
    this.assistantLedger = new AssistantLedger({ stateDir: this.config.stateDir });
    this.assistantLedger.setOnWrite(() => this.#notifyClusterDirty("assistant"));
    const redactAssistantText = (text: string): string =>
      this.connectionManager.redact(redactSensitiveText(text));
    this.ambientModel = new AmbientModelService({
      stateDir: this.config.stateDir,
      models: this.#models,
      defaultModel: () => this.#resolveOrchestratorAgent().model,
      persistedConfig: async () => {
        const snap = await this.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT);
        return snap?.backgroundModel ?? { mode: "auto", revision: 1 };
      },
      saveConfig: async (next) => {
        await this.harness.commit(async (tx) => {
          const doc = await tx.doc(AssistantDoc);
          ensureAssistantState(doc);
          doc.backgroundModel = next;
          doc.revision += 1;
        }, BACKGROUND_CONTEXT);
      },
      redact: redactAssistantText,
    });
    this.sparkMail = new SparkMailService({
      listOnlineEnvs: () => this.envManager.listEnvs(),
      callConnector: (envId, request, timeoutMs) => this.envManager.callConnector(envId, request, timeoutMs),
      isEnabled: async () => {
        const snap = await this.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT);
        return Boolean(snap?.spark?.enabled);
      },
      redact: redactAssistantText,
    });
    this.haLanAudio = new HaLanAudioRelay();
    this.homeAssistant = new HomeAssistantService({
      vault: this.connectionManager.localVault,
      ledger: this.assistantLedger,
      stateDir: this.config.stateDir,
      lanAudioRelay: this.haLanAudio,
      persistedConfig: async () => {
        const snap = await this.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT);
        const raw = snap?.homeAssistant ?? { enabled: false };
        if (
          raw.enabled &&
          raw.baseUrl &&
          isLoopbackEndpointUrl(raw.baseUrl) &&
          this.#isLoopbackServicePausedForForeignHost((raw as { boundNodeId?: string }).boundNodeId)
        ) {
          return { ...raw, enabled: false };
        }
        return raw;
      },
      saveConfig: async (next) => {
        await this.harness.commit(async (tx) => {
          const doc = await tx.doc(AssistantDoc);
          ensureAssistantState(doc);
          const isLoopback = Boolean(next.baseUrl && isLoopbackEndpointUrl(next.baseUrl));
          const boundNodeId = isLoopback && this.#clusterHostContext && this.#clusterHostContext.localNodeId !== "local"
            ? this.#clusterHostContext.localNodeId
            : undefined;
          doc.homeAssistant = {
            enabled: next.enabled,
            ...(next.baseUrl ? { baseUrl: next.baseUrl } : {}),
            ...(next.sentinel ? { sentinel: next.sentinel } : {}),
            ...(next.announce ? { announce: next.announce } : {}),
            ...(boundNodeId ? { boundNodeId } : {}),
          } as typeof doc.homeAssistant;
          doc.revision += 1;
        }, BACKGROUND_CONTEXT);
      },
      redact: redactAssistantText,
      onAlertEvent: (event) => {
        void this.#ingestInternalAssistantEvents("home-assistant", [event]).catch(() => {});
      },
      onSituationResolved: (situationKey) => {
        void this.assistantCoordinator.resolveSituationByKey(situationKey).catch(() => {});
      },
      synthesizeTts: async (text) => {
        try {
          const out = await this.voice.synthesize(text);
          return { bytes: out.bytes, mimeType: out.mimeType };
        } catch {
          return undefined;
        }
      },
      lanHttpEndpoint: () => this.#lanHttpEndpointProvider?.(),
      completeVisionJson: (input) => this.ambientModel.completeZeroToolVisionJson(input),
    });
    if (this.homeAssistant.sentinel) {
      this.envManager.protectPaths([this.homeAssistant.sentinel.snapshotDir]);
    }
    this.larkConnector = new LarkConnectorService({
      persistedConfig: async () => {
        const snap = await this.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT);
        return snap?.lark ?? { enabled: false, selectedProfiles: [] };
      },
      saveConfig: async (next) => {
        await this.harness.commit(async (tx) => {
          const doc = await tx.doc(AssistantDoc);
          ensureAssistantState(doc);
          doc.lark = { enabled: next.enabled, selectedProfiles: [...next.selectedProfiles] };
          doc.revision += 1;
        }, BACKGROUND_CONTEXT);
      },
      redact: redactAssistantText,
      onEvents: async (profile, events) => {
        await this.#ingestInternalAssistantEvents("lark-cli", events, `lark:${profile}`);
      },
    });
    this.assistantCoordinator = new AssistantCoordinator({
      harness: this.harness,
      ledger: this.assistantLedger,
      ambientModel: this.ambientModel,
      agentName: () => this.#liveSettings.presentation.agentName,
      envDisplayName: (envId) => this.envManager.getEnvDescriptor(envId)?.name,
      isForegroundBusy: () => {
        if (this.voiceCalls.hasActiveCalls()) return true;
        for (const cache of this.#topicCaches.values()) {
          if (cache.live.busy) return true;
        }
        return false;
      },
      shouldSkipCloudModel: async () => this.usageCaps.isCappedFor("assistant").capped && (await this.ambientModel.willUseCloudModel(true)),
      redact: redactAssistantText,
      createDetachedOrchestratorConversation: async (ctx) => {
        const orchestratorAgent = this.#resolveOrchestratorAgent();
        const conv = await this.harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: {
              model: orchestratorAgent.model,
              thinkingLevel: orchestratorAgent.thinkingLevel,
              extensions: this.#orchestratorExtensions(false),
              tools: this.#orchestratorTools(false),
              cwd: this.#mainWorkspaceDir,
              maxTurns: 25,
            },
          },
          ctx,
        );
        return { id: conv.id };
      },
      onItemsChanged: (revision, items) => this.#emitAssistantItems(revision, items),
      onTopicsChanged: (topics) => this.#emitTopics(topics),
      onTopicContentChanged: (topicId) => {
        const cache = this.#topicCaches.get(topicId);
        if (cache) this.#refreshTopicContent(cache);
      },
      materializeSnapshot: async (snapshotRef, conversationId) => {
        const snap = this.homeAssistant.sentinel?.readTemporarySnapshot(snapshotRef);
        if (!snap) return undefined;
        const asset = this.uploads.saveUpload({
          name: snap.fileName,
          mimeType: snap.mimeType,
          bytes: snap.bytes,
          ownerId: "assistant:home-assistant",
          idempotencyKey: `ha-snapshot:${snapshotRef}`,
        });
        this.uploads.bindAttachments([asset], `conversation:${conversationId}`, "assistant:home-assistant");
        return asset;
      },
      onAlertSurfaced: (ev) => {
        const critical = ev.sourceApp === "home-assistant" && /(?:告警|烟雾|燃气|漏水|报警|异常)/.test(`${ev.title} ${ev.summary}`);
        const spokenText = ev.summary.includes(ev.title) ? ev.summary : `${ev.title}：${ev.summary}`;
        void this.homeAssistant.announce({
          text: spokenText,
          urgency: ev.urgency,
          critical,
          situationId: ev.situationId,
        }).catch(() => {});
      },
      onMutedAppsChanged: (mutedApps) => {
        void this.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT).then((snap) => {
          this.envManager.setConnectorConfig({
            driverId: "macos-notifications",
            enabled: Boolean(snap?.enabled),
            mutedApps,
          });
        }).catch(() => {});
      },
      executePendingAction: async (action) => {
        if (action.kind === "spark_create_draft") {
          const body = typeof action.params.body === "string" ? action.params.body : "";
          const res = await this.sparkMail.executeConfirmedDraft(
            {
              ...(typeof action.params.replyToThreadId === "string" ? { replyToThreadId: action.params.replyToThreadId } : {}),
              ...(typeof action.params.to === "string" ? { to: action.params.to } : {}),
              ...(typeof action.params.subject === "string" ? { subject: action.params.subject } : {}),
              body,
            },
            action.envId,
          );
          return {
            ok: res.ok,
            ...(res.preDispatch !== undefined ? { preDispatch: res.preDispatch } : {}),
            ...(res.error ? { error: res.error } : {}),
          };
        }
        if (action.kind === "ha_call_service") {
          const domain = typeof action.params.domain === "string" ? action.params.domain : "";
          const service = typeof action.params.service === "string" ? action.params.service : "";
          const entityId = typeof action.params.entityId === "string" ? action.params.entityId : undefined;
          const serviceData = action.params.serviceData !== undefined ? sanitizeServiceData(action.params.serviceData) : undefined;
          try {
            await this.homeAssistant.callService({
              domain,
              service,
              ...(entityId ? { entityId } : {}),
              ...(serviceData ? { serviceData } : {}),
              triggerSource: "user_confirmed_l2",
            });
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              preDispatch: isHomeAssistantPreDispatchError(error),
              error: error instanceof Error ? error.message : "Home Assistant 服务调用失败。",
            };
          }
        }
        if (action.kind === "ha_upsert_automation") {
          const configId = typeof action.params.configId === "string" ? action.params.configId : "";
          const config = action.params.config && typeof action.params.config === "object" && !Array.isArray(action.params.config)
            ? (action.params.config as Record<string, unknown>)
            : null;
          if (!configId || !config) return { ok: false, preDispatch: true, error: "自动化配置参数缺失。" };
          try {
            await this.homeAssistant.upsertAutomation({ configId, config });
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              preDispatch: isHomeAssistantPreDispatchError(error),
              error: error instanceof Error ? error.message : "写入 Home Assistant 自动化失败。",
            };
          }
        }
        if (action.kind === "ha_delete_automation") {
          const configId = typeof action.params.configId === "string" ? action.params.configId : "";
          if (!configId) return { ok: false, preDispatch: true, error: "缺少待删除的自动化 ID。" };
          try {
            await this.homeAssistant.deleteAutomation(configId);
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              preDispatch: isHomeAssistantPreDispatchError(error),
              error: error instanceof Error ? error.message : "删除 Home Assistant 自动化失败。",
            };
          }
        }
        if (action.kind === "lark_send_reply") {
          const profile = typeof action.params.profile === "string" && action.params.profile.trim()
            ? action.params.profile.trim()
            : "default";
          const text = typeof action.params.text === "string" ? action.params.text : "";
          const res = await this.larkConnector.executeConfirmedReply({
            ...(typeof action.params.profile === "string" ? { profile: action.params.profile } : {}),
            chatId: typeof action.params.chatId === "string" ? action.params.chatId : "",
            text,
          });
          if (res.ok) {
            this.assistantEchoSuppressor.recordOutgoing({
              appId: `lark:${profile}`,
              body: text,
              requireSenderMatch: true,
            });
            for (const macBundle of ["com.electron.lark", "com.bytedance.lark"]) {
              this.assistantEchoSuppressor.recordOutgoing({
                appId: macBundle,
                body: text,
              });
            }
          }
          return res;
        }
        return { ok: false, preDispatch: true, error: "不支持的待确认动作类型。" };
      },
    });
    this.assistantSorter = new AssistantSorter({
      ledger: this.assistantLedger,
      ambientModel: this.ambientModel,
      redact: redactAssistantText,
      echoSuppressor: this.assistantEchoSuppressor,
      shouldSkipCloudModel: async () => this.usageCaps.isCappedFor("assistant").capped && (await this.ambientModel.willUseCloudModel(false)),
      onNotifyBrain: (payload) => this.assistantCoordinator.enqueueEscalation(payload),
    });
    this.envManager.setConnectorHandlers({
      onEvents: (envId, batch) => this.#ingestConnectorBatch(envId, batch),
    });
    this.extensions = new KuloExtensions({
      harness: this.harness, stateDir: this.config.stateDir, operationTask: params.extensionsExt.operationTask,
      packages: params.extensionPackages,
      compaction: { enable: () => this.#enableContextExtension(), stop: () => this.#stopContextExtension() },
      onChange: () => { void this.#broadcastCapabilities().catch((error: unknown) => console.error("[KuloExtensions]", this.connectionManager.redact(error instanceof Error ? error.message : String(error)))); },
    });
    this.memoryLlmBridge = new MemoryLlmBridge({
      stateDir: this.config.stateDir,
      models: this.#models,
      redact: (value) => this.connectionManager.redact(value),
    });
    this.memoryService = new KuloMemoryService({
      harness: this.harness, operationTask: params.memoryServiceExt.operationTask,
      local: new HindsightLocalService({ stateDir: this.config.stateDir, bridgeFile: this.memoryLlmBridge.descriptorPath }),
      credentials: params.credentialStore,
      settings: () => this.getSettingsView(), memory: () => this.#liveSettings.memory,
      validateMemory: (memory) => assertMemoryIdentitySeparation(memory, this.config, this.envManager),
      applied: async (doc) => { await this.#applyLiveSettings(doc, BACKGROUND_CONTEXT); this.#emitSettings(this.getSettingsView()); },
      validateKuloModel: async (connectionId, modelId) => {
        const providers = await this.listProviders();
        const provider = providers.find((item) => item.id === connectionId);
        if (!provider) return { ok: false, error: `未找到模型连接 ${connectionId}，请先在「模型」设置添加。` };
        if (!provider.authenticated) return { ok: false, error: `模型连接「${provider.name}」尚未配置凭据或未登录，请先在「模型」设置完成授权。` };
        if (!this.#models.getModel(connectionId, modelId)) return { ok: false, error: `模型连接「${provider.name}」下未找到对话模型 ${modelId}。` };
        return { ok: true };
      },
      resolveModelCredential: async (model) => {
        if (model.provider === "kulo") return undefined;
        const defaults = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com", gemini: "https://generativelanguage.googleapis.com", groq: "https://api.groq.com/openai/v1", ollama: "http://127.0.0.1:11434" };
        return model.connectionId ? this.#providerManager?.resolveServiceApiKey(model.connectionId, model.model, model.baseUrl ?? defaults[model.provider]) : undefined;
      },
      resolveServiceCredential: async (connectionId, modelId, baseUrl) => {
        return this.#providerManager?.resolveProbeApiKey(connectionId, baseUrl) ?? this.#providerManager?.resolveServiceApiKey(connectionId, modelId, baseUrl);
      },
    });
    this.skills = new KuloSkills({ harness: this.harness, stateDir: this.config.stateDir, onChanged: () => { this.#notifyClusterDirty("files"); return this.#broadcastCapabilities(); },
      resolveLocalSource: (source) => stageProjectSkillSource({ stateDir: this.config.stateDir, projects: this.projects, envManager: this.envManager }, source) });
    this.capabilities = new KuloCapabilities({ harness: this.harness, credentials: params.credentialStore,
      resolveProviderApiKey: (providerId, baseUrl) => this.#providerManager?.resolveProbeApiKey(providerId, baseUrl) ?? Promise.resolve(undefined),
      envs: () => this.envManager.listEnvs(), browser: (id, request) => this.envManager.requestBrowser(id, request), onChanged: () => this.#broadcastCapabilities() });
    this.imageConfiguration = new KuloImageConfiguration({ harness: this.harness, capabilities: this.capabilities,
      providers: () => this.listProviders(), discover: (request) => this.discoverProviderModels(request), onChanged: () => this.#broadcastCapabilities() });
    this.modelConfiguration = new KuloModelConfiguration({ harness: this.harness,
      settings: () => this.getSettingsView(), providers: () => this.listProviders(),
      redact: (value) => this.connectionManager.redact(value), rememberSecrets: (values) => this.connectionManager.rememberSecrets(values),
      discover: (request) => this.discoverProviderModels(request), probe: (request, signal) => this.probeModel(request, signal),
      saveProvider: async ({ provider, expectedSettingsRevision, defaultModelId, apiKey, operationKey, fingerprint, commit }) => {
        let previousCredential: Credential | undefined;
        let wroteCredential = false;
        const origin = new URL(provider.baseUrl).origin;
        const nextDoc = await this.harness.commit(async (tx) => {
          const doc = await tx.doc(KuloSettingsDoc);
          const operations = await tx.doc(ModelConfigurationDoc);
          const committed = operations.commits?.[operationKey];
          if (committed) {
            if (committed.fingerprint !== fingerprint) throw new SettingsUpdateError(409, "此模型保存标识已用于另一份配置。");
            return cloneJson(doc) as KuloDurableSettings;
          }
          const model = { ...cloneJson(doc.model), customProviders: [...(doc.model.customProviders ?? []).filter((item) => item.id !== provider.id), provider],
            ...(defaultModelId ? { defaultProvider: provider.id, defaultModel: defaultModelId } : {}) };
          // Validate the version and full configuration before touching credentials.
          applySettingsBlockUpdate(doc, "model", expectedSettingsRevision, model);
          if (apiKey) await params.credentialStore.modify(provider.id, async (current) => {
            previousCredential = current;
            wroteCredential = true;
            return { type: "api_key", key: apiKey, env: { ...(current?.type === "api_key" ? current.env : undefined), [API_KEY_ORIGIN_ENV]: origin } };
          });
          operations.commits ??= {};
          operations.commits[operationKey] = cloneJson(commit);
          return cloneJson(doc) as KuloDurableSettings;
        }, BACKGROUND_CONTEXT).catch(async (cause: unknown) => {
          if (wroteCredential) await params.credentialStore.modify(provider.id, async (current) =>
            current?.type === "api_key" && current.key === apiKey && current.env?.[API_KEY_ORIGIN_ENV] === origin ? previousCredential : current);
          throw cause;
        });
        await this.#applyLiveSettings(nextDoc, BACKGROUND_CONTEXT);
        const view = this.getSettingsView();
        this.#emitSettings(view);
        return view;
      },
      onChanged: () => this.#broadcastCapabilities(),
    });
    this.externalClientQuotas = new ExternalAgentQuotaService({
      getClients: () => deriveConnectedExternalClients(this.#liveSettings.roles, this.#liveSettings.externalClients),
      getEnvDescriptor: (envId) => this.envManager.getEnvDescriptor(envId),
      getEnvConnectionState: (envId) => this.envManager.getConnectionState(envId),
      requestQuota: (envId, binding, signal) => this.envManager.requestExternalAgent(envId, { operation: "quota", binding }, signal),
      redact: (value) => this.connectionManager.redact(value),
    });
    this.agentConfiguration = new KuloAgentConfiguration({ harness: this.harness,
      settings: () => this.getSettingsView(), envs: () => this.envManager.listEnvs(),
      projects: async () => (await this.projects.list(BACKGROUND_CONTEXT)).map((project) => ({ id: project.id, name: project.name, envId: project.deviceId })),
      request: (envId, request) => this.envManager.requestExternalAgent(envId, request),
      redact: (value) => this.connectionManager.redact(value),
      verifyRoundtrip: (draft, nonce) => this.#verifyExternalAgent(draft, nonce),
      saveRole: async ({ role, models, expectedRevision, operationKey, fingerprint, commit }) => {
        const next = await this.harness.commit(async (tx) => {
          const doc = await tx.doc(KuloSettingsDoc);
          const operations = await tx.doc(AgentConfigurationDoc);
          const prior = operations.commits[operationKey];
          if (prior) {
            if (prior.fingerprint !== fingerprint) throw new SettingsUpdateError(409, "此保存标识已用于其他智能体配置。");
            return cloneJson(doc) as KuloDurableSettings;
          }
          const cid = role.externalClientId;
          const priorRole = doc.roles[role.id];
          const oldClientId = priorRole?.external
            ? priorRole.externalClientId?.trim() || externalClientConnectionId(priorRole.external)
            : undefined;
          const nextRoles = { ...cloneJson(doc.roles), [role.id]: role };
          const stillHasOldClient = oldClientId && oldClientId !== cid
            ? Object.values(nextRoles).some((item) => item.external && (item.externalClientId?.trim() || externalClientConnectionId(item.external)) === oldClientId)
            : true;
          applySettingsBlockUpdate(doc, "roles", expectedRevision, nextRoles, {
            externalAgents: true,
            ...(cid && models ? { clientModels: { [cid]: models } } : {}),
            ...(!stillHasOldClient && oldClientId ? { removeClientIds: [oldClientId] } : {}),
          });
          operations.commits[operationKey] = cloneJson(commit);
          return cloneJson(doc) as KuloDurableSettings;
        }, BACKGROUND_CONTEXT);
        await this.#applyLiveSettings(next, BACKGROUND_CONTEXT);
        const view = this.getSettingsView(); this.#emitSettings(view); return view;
      },
      saveClient: async ({ client, expectedRevision, operationKey, fingerprint, commit }) => {
        const next = await this.harness.commit(async (tx) => {
          const doc = await tx.doc(KuloSettingsDoc);
          const operations = await tx.doc(AgentConfigurationDoc);
          const prior = operations.clientCommits?.[operationKey];
          if (prior) {
            if (prior.fingerprint !== fingerprint) throw new SettingsUpdateError(409, "此保存标识已用于另一份客户端连接配置。");
            return cloneJson(doc) as KuloDurableSettings;
          }
          syncExternalClientsInSettings(doc);
          const previousClient = doc.externalClients?.[client.id];
          const wasVerified = Boolean(previousClient?.verifiedAt);
          const nextRoles = cloneJson(doc.roles);
          const binding = bindingFromExternalClient(client);
          for (const role of Object.values(nextRoles)) {
            if (!role.external) continue;
            const roleClientId = role.externalClientId?.trim() || externalClientConnectionId(role.external);
            if (roleClientId === client.id) {
              role.externalClientId = client.id;
              role.external = cloneJson(binding);
              if (!wasVerified && client.verifiedAt && isSupportedExternalAgentKind(client.kind) && role.enabled === false) {
                role.enabled = true;
              } else if (!client.verifiedAt || !isSupportedExternalAgentKind(client.kind)) {
                role.enabled = false;
              }
            }
          }
          applySettingsBlockUpdate(doc, "roles", expectedRevision, nextRoles, {
            externalAgents: true,
            upsertClients: { [client.id]: cloneJson(client) },
            summaryOverride: `连接外部客户端（${client.kind}）`,
          });
          operations.clientCommits ??= {};
          operations.clientCommits[operationKey] = cloneJson(commit);
          return cloneJson(doc) as KuloDurableSettings;
        }, BACKGROUND_CONTEXT);
        await this.#applyLiveSettings(next, BACKGROUND_CONTEXT);
        const view = this.getSettingsView(); this.#emitSettings(view); return view;
      },
      removeRole: async ({ agentId, expectedRevision, operationKey, fingerprint, commit }) => {
        const next = await this.harness.commit(async (tx) => {
          const doc = await tx.doc(KuloSettingsDoc);
          const operations = await tx.doc(AgentConfigurationDoc);
          const previous = operations.removals[operationKey];
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw new SettingsUpdateError(409, "此移除标识已用于另一项操作。");
            return cloneJson(doc) as KuloDurableSettings;
          }
          const targetRole = doc.roles[agentId];
          if (!targetRole?.external) throw new SettingsUpdateError(400, "外部智能体不存在。");
          const oldClientId = targetRole.externalClientId?.trim() || externalClientConnectionId(targetRole.external);
          const tasks = await tx.doc(KuloStateDoc);
          if (Object.values(tasks.tickets).some((ticket) => ticket.role === agentId && isTicketUnfinished(ticket))) throw new SettingsUpdateError(409, "请先停止或完成该智能体的未结束任务。");
          const roles = { ...cloneJson(doc.roles) }; delete roles[agentId];
          const stillHasClient = Object.values(roles).some((item) => item.external && (item.externalClientId?.trim() || externalClientConnectionId(item.external)) === oldClientId);
          applySettingsBlockUpdate(doc, "roles", expectedRevision, roles, {
            externalAgents: true,
            ...(!stillHasClient ? { removeClientIds: [oldClientId] } : {}),
          });
          operations.removals[operationKey] = cloneJson(commit);
          return cloneJson(doc) as KuloDurableSettings;
        }, BACKGROUND_CONTEXT);
        await this.#applyLiveSettings(next, BACKGROUND_CONTEXT);
        const view = this.getSettingsView(); this.#emitSettings(view); return view;
      },
    });
    this.envManager.setExternalAgentToolHandler(createExternalAgentToolHandler({
      read: async (scope) => {
        const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const ticket = this.#externalAgentScope(scope, state);
        const role = resolveRoleOrDirectClient(ticket.role, this.#liveSettings.roles, this.#liveSettings.externalClients, this.#liveSettings.presentation.language);
        return { ticket: cloneJson(ticket), role: role ? { ...cloneJson(role), allowSubagents: Boolean(role.allowSubagents && ticket.externalExecution?.allowSubagents) } : undefined,
          maxSubagents: this.#liveSettings.executor.maxSubagentsPerTicket, children: cloneJson(ticket.externalExecution!.children ?? {}) };
      },
      agents: async (scope) => {
        const ticket = this.#externalAgentScope(scope, await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT));
        return Object.values(this.#liveSettings.roles).filter((role) => role.enabled !== false && role.id !== ticket.role).map((role) => ({
          id: role.id, label: role.label, whenToUse: role.whenToUse, readOnly: !role.external && Boolean(role.readOnly),
          ...(role.external ? { envId: role.external.envId } : {}),
          available: !role.external || Boolean(role.external.verifiedAt && isSupportedExternalAgentKind(role.external.kind)),
        }));
      },
      report: async (scope, report, files) => {
        const snap = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const snapTicket = this.#externalAgentScope(scope, snap);
        const nextVersion = (snapTicket.externalExecution!.explicitReportVersion ?? 0) + 1;
        const stagedAttachments = files?.length ? await this.#stageExternalReportFiles(scope, files) : undefined;
        const spilled = spillOversizedReport({
          uploads: this.uploads,
          ticketId: snapTicket.id,
          runEpoch: snapTicket.runEpoch,
          version: nextVersion,
          ownerConversationId: snapTicket.workerConversationId,
          originConversationId: snapTicket.originConversationId,
          report,
        });
        const finalizedReport: WorkerReportRecord = {
          ...spilled,
          ...(stagedAttachments?.length ? { attachments: stagedAttachments } : {}),
        };
        await this.harness.commit(async (tx) => {
          const ticket = this.#externalAgentScope(scope, await tx.doc(KuloStateDoc));
          const committedVersion = Math.max(nextVersion, (ticket.externalExecution!.explicitReportVersion ?? 0) + 1);
          ticket.externalExecution!.explicitReportVersion = committedVersion;
          ticket.latestReport = cloneJson(finalizedReport);
          if (finalizedReport.state === "ready") {
            ticket.externalExecution!.explicitReadyReport = {
              ...cloneJson(finalizedReport),
              runEpoch: ticket.runEpoch,
              version: committedVersion,
            };
          } else if (finalizedReport.state === "blocked" || finalizedReport.state === "failed") {
            delete ticket.externalExecution!.explicitReadyReport;
          }
          ticket.externalExecution!.lastActivityAt = Date.now();
          ticket.updatedAt = Date.now();
        }, BACKGROUND_CONTEXT);
        await this.#broadcastTickets(BACKGROUND_CONTEXT);
        return {
          recorded: true,
          pendingNativeCompletion: true,
          ...(stagedAttachments?.length ? { stagedAssets: stagedAttachments.map((a) => ({ id: a.id, name: a.name })) } : {}),
          ...(finalizedReport.overflowAsset ? { overflowAssetId: finalizedReport.overflowAsset.id } : {}),
        };
      },
      memory: async (scope, toolName, args) => {
        const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const ticket = this.#externalAgentScope(scope, state);
        if (!this.#liveSettings.memory.enabled || this.#liveSettings.memory.accessMode === "private-only") {
          throw new Error("Hindsight 共享记忆库当前未开启。");
        }
        const res = await executeHindsightTool({
          config: this.#liveSettings.memory,
          bank: "shared",
          caller: {
            role: "worker",
            conversationId: String(ticket.workerConversationId),
            ticketId: ticket.id,
            runEpoch: ticket.runEpoch,
            ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
            workerRole: ticket.role,
            sourceId: `external-mcp:${scope.runId}:${Date.now()}`,
          },
          toolName,
          args,
        });
        if (res.isError) throw new Error(res.text);
        try { return JSON.parse(res.text); } catch { return { text: res.text }; }
      },
      connectionsList: async (scope) => {
        const ticket = this.#externalAgentScope(scope, await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT));
        const list = await this.#connectionList({
          kind: "worker",
          conversationId: ticket.workerConversationId,
          ticketId: ticket.id,
          runEpoch: ticket.runEpoch,
          readOnly: Boolean(ticket.readOnly || ticket.externalExecution?.workspaceMode === "read_only"),
          isSubagent: false,
        }, BACKGROUND_CONTEXT);
        const granted = new Set(list.grantedConnectionIds);
        const grantedEntries = list.connections.filter((entry) => granted.has(entry.id)).map((entry) => {
          const { mcpArgs: _args, mcpCwd: _cwd, instructions, ...rest } = entry;
          return { ...rest, ...(instructions ? { instructions: instructions.slice(0, 1_000) } : {}) };
        });
        const grantedApps = new Set(grantedEntries.filter((entry) => entry.kind === "app" && entry.appId).map((entry) => entry.appId!));
        return {
          ...list,
          connections: grantedEntries,
          applications: (list.applications ?? []).filter((app) => grantedApps.has(app.id)),
          requests: [],
        };
      },
      connectionUse: async (scope, input) => {
        const ticket = this.#externalAgentScope(scope, await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT));
        return this.#connectionUse({
          kind: "worker",
          conversationId: ticket.workerConversationId,
          ticketId: ticket.id,
          runEpoch: ticket.runEpoch,
          readOnly: Boolean(ticket.readOnly || ticket.externalExecution?.workspaceMode === "read_only"),
          isSubagent: false,
        }, input, BACKGROUND_CONTEXT);
      },
      delegate: (scope, request) => this.#queueTicketOperation(scope.taskId, async () => {
        const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const parent = this.#externalAgentScope(scope, state);
        const role = this.#liveSettings.roles[parent.role];
        if (!parent.externalExecution!.allowSubagents || !role?.allowSubagents || role.enabled === false) throw new Error("该智能体未开启 Hub 协作。");
        let depth = 0;
        for (let cursor: Readonly<TicketRecord> | undefined = parent; cursor?.parentTicketId; cursor = state?.tickets[cursor.parentTicketId]) {
          if (++depth >= 3) throw new Error("协作层级已达到上限，请交回主 Agent 调度。");
        }
        const commandId = `external-child:${createHash("sha256").update(`${parent.id}:${scope.runEpoch}:${request.requestId}`).digest("hex")}`;
        const child = await this.dispatchTicket({ commandId, title: request.goal.slice(0, 40), goal: request.goal,
          scope: parent.scope, acceptance: request.acceptance ?? parent.acceptance, role: request.agentId,
          envId: parent.envId, projectId: parent.projectId, workspaceDir: parent.workspaceDir, connectionIds: parent.connectionIds,
          originConversationId: parent.originConversationId, parentTicketId: parent.id,
          parentExternalRequest: { runId: scope.runId, runEpoch: scope.runEpoch, requestId: request.requestId, fingerprint: request.fingerprint } }, BACKGROUND_CONTEXT);
        const childRole = this.#liveSettings.roles[request.agentId];
        const requiresParentYield = !parent.readOnly && (Boolean(childRole?.external) || !childRole?.readOnly) ||
          (state?.slots.holders.length ?? 0) >= this.#liveSettings.executor.maxConcurrentWorkers;
        return { ...child, requiresParentYield, ...(requiresParentYield ? { instruction: "协作任务正在等待可用执行名额或项目写入占用。请先结束当前轮并把协作安排交回主 Agent，释放后子任务会继续执行。" } : {}) };
      }),
      inspect: async (scope, childTaskId) => {
        const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const parent = this.#externalAgentScope(scope, state);
        const child = state?.tickets[childTaskId];
        if (!child || child.parentTicketId !== parent.id || !Object.values(parent.externalExecution!.children ?? {}).some((entry) => entry.taskId === child.id)) throw new Error("只能读取当前任务创建的协作任务。");
        return { taskId: child.id, title: child.title, status: child.status, report: child.latestReport };
      },
      redact: (value) => this.connectionManager.redact(value),
    }));
    this.search = new KuloSearch({ harness: this.harness, stateDir: this.config.stateDir,
      credentials: params.credentialStore,
      migrateNativePlan: (plan) => this.#migrateNativeSearchPlan(plan),
      onChanged: () => this.#broadcastCapabilities() });
    this.voice = new KuloVoiceService({ harness: this.harness, credentials: params.credentialStore,
      resolveModel: (providerId, modelId) => this.#providerManager?.resolveConfiguredModel(providerId, modelId) ?? Promise.resolve(undefined),
      asr: params.voiceAsr ?? new LocalVoiceAsr({ stateDir: this.config.stateDir,
        onStatus: () => { void this.#broadcastVoice().catch((error: unknown) => console.error("[KuloVoice]", this.connectionManager.redact(error instanceof Error ? error.message : String(error)))); } }),
      onChanged: () => this.#broadcastVoice() });
    this.voiceCalls = new KuloVoiceCalls({ voice: this.voice, openLive: params.voiceOpenLive,
      context: async (topicId, principalId) => {
        const cache = await this.#voiceTopic(topicId);
        const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        for (const ticket of Object.values(state?.tickets ?? {})) {
          if (ticket.originTopicId === topicId && ticket.latestReport?.summary &&
              !isSilentRecoveryFailure(state!, ticket)) this.voiceCalls.taskUpdated(topicId, ticket.id,
            this.connectionManager.redact(ticket.latestReport.summary), ticket.status);
        }
        const voiceContext = await createVoiceContext({ conversation: cache.conversation, harness: this.harness, state,
          memory: this.#liveSettings.memory, agentName: this.#liveSettings.presentation.agentName,
          redact: (text) => this.connectionManager.redact(text) }, BACKGROUND_CONTEXT);
        return { ...voiceContext, ...(cache.live.runFailure ? { priorFailureTaskId: cache.live.runFailure.taskId ?? "router" } : {}) };
      },
      transcript: (topicId, event, callId) => this.#recordVoiceTranscript(topicId, event, callId),
      delegate: async ({ topicId, principalId, callId, delegationId, text }) => {
        await this.#voiceTopic(topicId);
        await this.sendUserMessage(`[Voice Call Request]\n${text}\nFulfill this spoken request in the active conversation context (delegate complex work via kulo_dispatch, or update existing work via kulo_steer). Publish full deliverables to this chat and reply with concise, verified facts and status suitable for spoken summary.`,
          { topicId, principalId, requestId: `voice:${callId}:${delegationId}`, voiceDelegation: true });
      } });
    this.mediaJobs = new KuloMediaJobs({ harness: this.harness, capabilities: this.capabilities, uploads: this.uploads,
      browser: (id, request) => this.envManager.requestBrowser(id, request),
      validateSource: (source, job) => this.#validateMediaSource(source, job),
      validateInput: (id, source) => this.#validateMediaInput(id, source),
      onChanged: () => this.#broadcastCapabilities(),
      onCreated: (job) => job.source.ticketId ? this.#recordTicketOutwardAction(job.source.ticketId, undefined, "media", `media:${job.kind}:${job.modelId}`) : undefined,
      onCompleted: (job) => this.#mediaCompleted(job), onSettled: (job) => this.#mediaSettled(job) });
    this.projects = new KuloProjects({
      harness: this.harness,
      envManager: this.envManager,
      stopTicket: (id, reason) => this.stopTicket(id, reason),
      onChanged: () => {
        void this.#broadcastProjects().catch((error) => console.error("[KuloProjects]", error));
      },
    });
    this.uiCards = new KuloUiCards({ harness: this.harness, validateAssetReferences: (spec) => {
      for (const element of Object.values(spec.elements)) {
        if (element.type !== "Media") continue;
        const loaded = this.uploads.getUpload(String(element.props.assetId));
        if (!loaded || loaded.record.ownerId !== undefined && !loaded.record.referenceScopes?.length) {
          throw new UiCardError("asset_reference_forbidden", "卡片只能引用已经发布的资源。", 403);
        }
      }
    }, onChange: (card) => {
      this.#cardSnapshots.set(card.cardId, card);
      for (const listener of this.#listeners) listener.onUiCard?.(card);
      for (const cache of this.#topicCaches.values()) {
        if (Number(cache.conversation.id) === card.originConversationId) this.#refreshTopicContent(cache);
      }
      void this.settingsAssistant.refreshIfConversation(card.originConversationId);
    } });
    this.actionConfirmations = new KuloActionConfirmations({ harness: this.harness, uiCards: this.uiCards });
    this.deviceJoinStaging = params.deviceJoinStaging;
    this.settingsAssistant = new SettingsAssistant({
      harness: this.harness,
      extension: params.settingsAssistantExt,
      globalExtension: params.globalSettingsExt,
      cwd: this.#mainWorkspaceDir,
      orchestratorExtensions: [
        params.orchestratorExt,
        params.routerReadExt,
        params.orchestratorGuardExt,
        params.toolSearchExt,
        params.contentExt,
        params.projectExt,
        params.skillExt,
        params.orchestratorTailExt,
        params.mediaExt,
        params.voiceExt,
        params.memoryServiceExt,
        params.historyExt,
        params.assistantToolsExt,
        params.contextCompaction.extension,
      ],
      settingsTierExtension: params.settingsTierExt,
      capabilityExtensions: [params.capabilitySetupExt, params.extensionSetupExt],
      memoryExtensions: [params.memorySetupExt],
      appearanceExtensions: [params.appearanceCustomizationExt],
      modelExtensions: [params.modelConfigurationExt],
      agentConfigurationExtensions: [params.agentConfigurationExt],
      deviceExtensions: [params.deviceToolsExt],
      securityExtensions: [params.redactionExt],
      customizationExtensions: this.#customizationExtensions,
      processText: async (text, requestId) => {
        const sealed = this.deviceJoinStaging.sealText(text, (values) => this.connectionManager.rememberSecrets(values));
        return this.connectionManager.processText(sealed.text, { requestId });
      },
      prepareInput: (text, attachments, principalId) => {
        for (const attachment of attachments) {
          if (typeof attachment?.id !== "string" || !this.uploads.getUpload(attachment.id)) {
            throw Object.assign(new Error("附件不存在或已失效，请重新上传后再发送。"), { code: "attachment_not_found" });
          }
          if (!this.uploads.canReadUpload(attachment.id, principalId)) {
            throw Object.assign(new Error("无权引用此附件。"), { code: "attachment_forbidden", status: 403 });
          }
        }
        return this.uploads.buildMultimodalContent(text, attachments);
      },
      bindAttachments: (attachments, conversationId, principalId) => this.uploads.bindAttachments(attachments, `conversation:${conversationId}`, principalId),
      connections: this.connectionManager,
      workspaceRead: (clientId) => this.getCapabilitiesSnapshot(clientId),
      extensionsRead: (clientId) => this.extensions.snapshot(clientId),
      scheduledTasks: () => this.listScheduledTasks(),
      applyWorkspaceOperation: async (operation) => {
        if (operation.kind === "extension-remove") return this.extensions.request({ id: operation.id, operation: "remove", expectedRevision: operation.expectedRevision, commandId: operation.commandId });
        if (operation.kind === "capability-remove") return this.capabilities.remove(operation.id, operation.expectedRevision, operation.commandId);
        if (operation.kind === "capability-restore") return this.capabilities.restorePreferences(operation);
        return this.skills.manage({ action: operation.kind === "skill-enabled" ? operation.enabled ? "enable" : "disable" : "remove",
          id: operation.id, expectedRevision: operation.expectedRevision, commandId: operation.commandId });
      },
      deviceController: () => this.#deviceController,
      joinStaging: this.deviceJoinStaging,
      hasRunningLocalTasks: async () => {
        const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        return Object.values(state?.tickets ?? {}).some((ticket) => isTicketUnfinished(ticket));
      },
      resolveModelMetadata: (req) => this.resolveModelMetadata(req),
      refreshModelMetadata: async (force) => {
        if (!this.#providerManager) return { updated: false, fromCache: true, source: "bundled" };
        return this.#providerManager.metadataRegistry.refresh({ force });
      },
      isOfficialNativeSearchAllowed: (providerId) => this.#providerManager?.isOfficialNativeSearchAllowed(providerId) ?? false,
      agent: () => this.#resolveOrchestratorAgent(),
      tools: (context, extensions) => this.#resolveExtensionsTools(
        extensions ?? [],
        this.#surfaceRuntimeState("settings", {
          settingsModule: context?.module,
          settingsActive: context?.active,
        }),
      ),
      preloadedToolNames: (context) => resolveSettingsPreloadedTools(
        this.#surfaceRuntimeState("settings", {
          settingsModule: context?.module,
          settingsActive: context?.active,
        }),
      ),
      settings: () => this.getSettingsView(),
      providers: () => this.listProviders(),
      removeProviderAuth: async (providerId) => {
        if (this.#providerManager) await this.#providerManager.logout(providerId);
        else await this.#models.logout(providerId);
      },
      envs: () => this.envManager.listEnvs(),
      hydrateConversation: async (conversationId) => {
        for (const card of await this.uiCards.snapshot(conversationId)) {
          if ((this.#cardSnapshots.get(card.cardId)?.revision ?? 0) <= card.revision) this.#cardSnapshots.set(card.cardId, card);
        }
      },
      display: (view, conversationId) => redactCredentialData({
        messages: conversationId !== undefined ? this.#projectMessages(view.entries, conversationId) : extractDisplayMessages(view.entries),
        live: extractLiveState(view),
      }, (text) => this.connectionManager.redact(text)),
      applied: async (doc) => {
        await this.#applyLiveSettings(doc, BACKGROUND_CONTEXT);
        this.#emitSettings(this.getSettingsView());
        await this.#broadcastTickets(BACKGROUND_CONTEXT);
      },
      emit: (snapshot) => { for (const listener of this.#listeners) listener.onSettingsAssistant?.(snapshot); },
    });
    this.#watchdogCheckIntervalMs = params.watchdogCheckIntervalMs;
    this.#watchdogStallMsOverride = params.watchdogStallMsOverride;
    this.#orchestratorBrowserIdleMs = params.orchestratorBrowserIdleMs;
  }

  bindDeviceController(controller: HubDeviceController | undefined): void {
    this.#deviceController = controller;
    if (!this.#closed && !this.#recovering) {
      void this.#reconfigureOrchestratorConversations(BACKGROUND_CONTEXT).catch(() => {});
    }
  }

  static async open(
    init: KuloHubInitOptions = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<KuloHub> {
    const releaseProxy = retainEnvironmentProxy();
    let stateOwner: HubStateOwner | undefined;
    let hubRef: KuloHub | null = null;
    let partialEnv: EnvManager | undefined;
    let partialConnections: KuloConnections | undefined;
    let closePartialStorage: (() => Promise<void>) | undefined;
    try {
    const config = resolveHubConfig(init.config);
    stateOwner = HubStateOwner.acquire(config.stateDir);
    if (!init.storage) await prepareStateStorage(config.stateDir);
    const connectionVault = init.connectionVault ?? init.connectionManager?.localVault ?? new LocalConnectionVault({ stateDir: config.stateDir });
    const connectionManager = init.connectionManager ?? new KuloConnections({ stateDir: config.stateDir, vault: connectionVault });
    partialConnections = connectionManager;
    await connectionManager.initialize();
    const credentialStore = init.credentialStore ?? new SecureCredentialStore({ vault: connectionVault,
      legacyPath: path.join(config.stateDir, "credentials.json"), onSecrets: (values) => connectionManager.rememberSecrets(values) });
    if (credentialStore instanceof SecureCredentialStore) await credentialStore.initialize();
    const deviceJoinStaging = new DeviceJoinStaging();
    const redact = (text: string) => connectionManager.redact(text);
    const isKnownSecret = (text: string) => connectionManager.containsKnownSecret(text);
    const sealing = { vault: connectionVault, rememberSecrets: (values: readonly string[]) => connectionManager.rememberSecrets(values), isKnownSecret };
    if (!init.storage) await scrubStoredConversationSecrets(config.stateDir, redact, {
      ...sealing,
      processUserText: (text, requestId) => connectionManager.processText(text, { requestId }),
    });
    const redactionExt = createCredentialRedactionExtension(redact, { isKnownSecret });
    const mainWorkspaceDir = path.resolve(
      config.localEnvRoot ?? path.join(config.stateDir, "workspace"),
    );
    const defaultIdentityDir = path.resolve(config.identityDir);
    const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
    const runtimeRoot = path.resolve(runtimeDir, "../../..");
    const runtimeKind = path.basename(runtimeDir);
    const protectedRuntime = [
      path.join(runtimeRoot, "node_modules"),
      ...["hub", "env", "cli", "protocol"].flatMap((name) => [
        path.join(runtimeRoot, "packages", name, runtimeKind),
        path.join(runtimeRoot, "packages", name, "node_modules"),
      ]),
      path.join(runtimeRoot, "packages/hub/native"),
      path.join(runtimeRoot, "packages/env/native"),
      path.join(runtimeRoot, "packages/hub/scripts"),
      path.join(runtimeRoot, "packages/env/scripts"),
      path.join(runtimeRoot, "packages/hub/dist/kulo-native-applications"),
    ];
    const uploads = new KuloUploadStore(path.join(config.stateDir, "uploads"));
    uploads.cleanupIncompleteUploads();
    uploads.cleanupDrafts();

    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.mkdirSync(mainWorkspaceDir, { recursive: true });
    fs.mkdirSync(defaultIdentityDir, { recursive: true, mode: 0o700 });

    let bootSettings: KuloDurableSettings | null = null;

    const envManager = new EnvManager({
      enableLocal: config.enableLocalEnv,
      ...(config.localEnvId ? { localEnvId: config.localEnvId } : {}),
      localRootDir: mainWorkspaceDir,
      localName: config.localEnvName,
      authToken: config.authToken,
      envTokens: config.envTokens,
      workerEnvIds: config.workerEnvIds,
      getProtectedPaths: () => [
        config.stateDir,
        config.identityDir,
        ...(config.extraProtectedPaths ?? []),
        ...protectedRuntime,
        ...(bootSettings?.identity.directory ? [bootSettings.identity.directory] : []),
        path.resolve(".env"),
        ...(bootSettings?.memory.authFile ? [path.resolve(bootSettings.memory.authFile)] : []),
        ...(config.memory.authFile ? [path.resolve(config.memory.authFile)] : []),
      ],
      onChange: (envs) => {
        if (hubRef) {
          for (const env of envs) {
            if (!env.online) {
              void hubRef.#closeOrchestratorBrowserSessionsForEnv(env.id, false);
            }
          }
          hubRef.#emitEnvs(envs);
          hubRef.#queueEnvReconcile();
        }
      },
    });
    partialEnv = envManager;
    await envManager.start();

    const providerManager = init.models
      ? null
      : new KuloProviderManager({ stateDir: config.stateDir, credentials: credentialStore });
    if (providerManager) {
      await providerManager.restoreOfflineCache();
    }
    const providerId =
      init.providerId ?? (init.models ? KULO_PROVIDER_ID : KULO_GATEWAY_PROVIDER_ID);
    const models: Models = withNativeToolsModels(
      withUsageMeterModels(withThinkingLevelModels(init.models ?? providerManager!.models), () => hubRef?.usageCaps),
      {
      fetch: proxyFetch,
      getNativeTools: (provider, id) => {
        if (providerManager && !providerManager.isOfficialNativeSearchAllowed(provider)) return undefined;
        const modelConfig = hubRef ? hubRef.#liveSettings.model : bootSettings?.model ?? config.model;
        return (provider === KULO_GATEWAY_PROVIDER_ID ? modelConfig.gatewayModels?.find((model) => model.id === id) :
          modelConfig.subscriptionModels?.[provider]?.find((model) => model.id === id) ??
          modelConfig.customProviders?.find((item) => item.id === provider)?.models.find((model) => model.id === id))?.nativeTools;
      },
    });

    const getLiveRoles = () => bootSettings?.roles ?? config.roles;
    const getLiveMemory = () => {
      const mem = bootSettings?.memory ?? config.memory;
      return hubRef ? hubRef.#effectiveMemoryConfig(mem) : mem;
    };
    const getLiveIdentityDir = () =>
      bootSettings ? resolveEffectiveIdentityDir(bootSettings, defaultIdentityDir) : defaultIdentityDir;
    const getLiveIdentityState = () => ({
      directory: getLiveIdentityDir(),
      directoryRevision: bootSettings?.identity.directoryRevision ?? 1,
    });
    const getMaxConcurrentWorkers = () =>
      bootSettings?.executor.maxConcurrentWorkers ?? config.maxConcurrentWorkers;
    const getAgentName = () =>
      bootSettings?.presentation.agentName ?? config.presentation.agentName;
    const getLiveLanguage = (): KuloLanguage | undefined =>
      bootSettings?.presentation.language ?? config.presentation.language;

    if (providerManager) {
      providerManager.syncProviders(config.model, config.roles);
    }

    const rawStorage =
      init.storage ??
      (await openNodeSqliteStorage(path.join(config.stateDir, "kulo.sqlite")));
    closePartialStorage = () => rawStorage.close(BACKGROUND_CONTEXT);
    const storage = wrapRedactedStorage(rawStorage, redact, {
      ...sealing,
      onCommit: () => { if (hubRef) hubRef.#notifyClusterDirty("sqlite"); },
    });

    const images = await createNodePhotonImages();
    const codingToolsExt = createCodingTools({ images });
    const routerReadTool = createReadTool({ images });
    const routerReadExt = defineExtension({
      name: "kulo-router-read",
      tools: [routerReadTool],
    });

    const ORCHESTRATOR_DEFAULT_BASH_TIMEOUT_SECONDS = 60;
    const ORCHESTRATOR_MAX_BASH_TIMEOUT_SECONDS = 300;
    const isInsideLocalOrPosix = (candidatePath: string, dirPath: string): boolean => {
      if (!dirPath) return false;
      const resolvedDir = path.resolve(dirPath);
      const resolvedTarget = path.resolve(candidatePath);
      const rel = path.relative(resolvedDir, resolvedTarget);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    const safeCanonical = (value: string): string => {
      try {
        return canonicalExecutionPath(value);
      } catch {
        return path.resolve(value);
      }
    };
    const resolvedStateDir = safeCanonical(config.stateDir);
    const resolvedMainWorkspace = safeCanonical(mainWorkspaceDir);
    const homeDir = os.homedir();
    const homeSensitiveDirs = [".ssh", ".gnupg", ".kube", ".aws", ".claude", ".codex", ".gemini", ".antigravity", ".grok", ".cursor", ".opencode", ".kiro", ".copilot", ".dsh"].map((name) =>
      safeCanonical(path.join(homeDir, name)),
    );
    const extraProtectedCanonical = (config.extraProtectedPaths ?? []).map((entry) => safeCanonical(path.resolve(entry)));
    const isProtectedOrchestratorPath = (candidatePath: string): string | undefined => {
      const canonicalCandidate = safeCanonical(candidatePath);
      if (isApplicationPrivatePath(candidatePath) || isApplicationPrivatePath(canonicalCandidate)) {
        return "请通过已授权的消息或邮件应用读取内容。";
      }
      const liveIdentityDir = safeCanonical(getLiveIdentityDir());
      const defaultIdentityCanonical = safeCanonical(config.identityDir);
      const liveAuthFile = getLiveMemory().authFile ? safeCanonical(path.resolve(getLiveMemory().authFile!)) : undefined;
      const defaultAuthFile = config.memory.authFile ? safeCanonical(path.resolve(config.memory.authFile)) : undefined;
      const dotEnvPath = safeCanonical(path.resolve(".env"));
      if (isInsideLocalOrPosix(canonicalCandidate, liveIdentityDir) || isInsideLocalOrPosix(canonicalCandidate, defaultIdentityCanonical)) {
        return "主脑沙箱禁止直接读写私有身份目录；请使用 kulo_identity_read、kulo_identity_propose 或 kulo_relationship_update。";
      }
      if (
        (isInsideLocalOrPosix(canonicalCandidate, resolvedStateDir) &&
        !(
          resolvedMainWorkspace !== resolvedStateDir &&
          isInsideLocalOrPosix(resolvedMainWorkspace, resolvedStateDir) &&
          isInsideLocalOrPosix(canonicalCandidate, resolvedMainWorkspace)
        )) ||
        extraProtectedCanonical.some((dir) => isInsideLocalOrPosix(canonicalCandidate, dir))
      ) {
        return "主脑沙箱禁止直接访问 Kulo 状态库或凭据目录。";
      }
      if (
        canonicalCandidate === dotEnvPath ||
        (liveAuthFile && canonicalCandidate === liveAuthFile) ||
        (defaultAuthFile && canonicalCandidate === defaultAuthFile) ||
        homeSensitiveDirs.some((dir) => isInsideLocalOrPosix(canonicalCandidate, dir))
      ) {
        return "主脑沙箱禁止直接访问敏感密钥或凭据路径。";
      }
      return undefined;
    };

    const wrapOrchestratorCodingTool = (toolName: "read" | "write" | "edit" | "bash") => ({
      tool: toolName,
      wrap: (tool: ToolRegistration): ToolRegistration => ({
        ...tool,
        execute: async (args, api, context) => {
          const state = await api.snapshot(KuloStateDoc, context);
          const settingsDoc = await api.snapshot(SettingsAssistantDoc, context);
          const activeSettings = isActiveSettingsConversation(api.conversationId, settingsDoc);
          const isOrchestrator = isOrchestratorConversation(api.conversationId, state);
          if (!isOrchestrator && !activeSettings) {
            return tool.execute(args, api, context);
          }
          const blockResult = (message: string) => ({
            isError: true as const,
            output: [{ type: "text" as const, text: message }],
          });
          if (activeSettings && toolName !== "read") {
            return blockResult("设置助手仅支持只读读取操作。");
          }
          try {
            await hubRef!.#assertChatReadTarget(Number(api.conversationId), Number(api.taskId), api.env?.id, context);
          } catch (error) {
            return blockResult(redact(error instanceof Error ? error.message : String(error)));
          }

          const topicId = activeSettings ? undefined : (state?.conversationToTopic?.[String(api.conversationId)] ?? "root");
          const topic = topicId ? state?.topics?.[topicId] : undefined;
          if (topic?.deletedAt) {
            return blockResult("会话已删除。");
          }
          let authorizedProject: Awaited<ReturnType<KuloProjects["get"]>> | undefined;
          if (topic?.projectId) {
            try {
              authorizedProject = await hubRef!.projects.get(topic.projectId, context);
            } catch (error) {
              return blockResult(redact(error instanceof Error ? error.message : String(error)));
            }
          }
          const authorizedWorkspaceDir = authorizedProject?.workspaceDir ?? api.env?.cwd ?? mainWorkspaceDir;
          const localHostId = envManager.localEnvId;
          const targetEnvId = authorizedProject?.deviceId
            ?? (api.env?.id === "node:local"
              ? localHostId
              : api.env?.id?.startsWith("pi-env:")
                ? api.env.id.slice("pi-env:".length)
                : localHostId);
          const targetIsLocalHost = api.env?.id === "node:local" || envManager.isLocalEnv(targetEnvId);

          const checkActiveWriteLock = async (targetPath: string): Promise<string | undefined> => {
            const normalizedScopePath = targetIsLocalHost ? safeCanonical(targetPath) : targetPath;
            const writeProbe = {
              envId: targetEnvId,
              workspaceDir: normalizedScopePath,
              readOnly: false,
            } as TicketRecord;
            const conflictingTicket = Object.values(state?.tickets ?? {}).find(
              (t) =>
                (t.status === "running" || t.status === "pausing") &&
                !t.readOnly &&
                ticketsShareWriteScope(
                  writeProbe,
                  targetIsLocalHost && envManager.isLocalEnv(t.envId) && t.workspaceDir
                    ? { ...t, workspaceDir: safeCanonical(t.workspaceDir) }
                    : t,
                ),
            );
            if (conflictingTicket) {
              return `当前工作区正在由活跃工单 ${conflictingTicket.id}（${conflictingTicket.title}）写入中；请勿在主脑争抢同一目录写锁，改用 kulo_steer('${conflictingTicket.id}') 或等待该工单完成。`;
            }
            return undefined;
          };

          if (toolName === "read" || toolName === "write" || toolName === "edit") {
            const rawPath = String((args as { path?: unknown })?.path ?? "")
              .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ")
              .replace(/^@/u, "");
            let absolute: string;
            if (api.env) {
              try {
                absolute = getOrThrow(await api.env.absolutePath(rawPath, context));
              } catch (error) {
                return blockResult(redact(error instanceof Error ? error.message : String(error)));
              }
            } else {
              absolute = path.resolve(authorizedWorkspaceDir, rawPath);
            }

            if (targetIsLocalHost) {
              const blockedReason = isProtectedOrchestratorPath(absolute);
              if (blockedReason) {
                return blockResult(blockedReason);
              }
            } else if (isApplicationPrivatePath(absolute)) {
              return blockResult("请通过已授权的消息或邮件应用读取内容。");
            }

            if (toolName === "write" || toolName === "edit") {
              const conflictReason = await checkActiveWriteLock(absolute);
              if (conflictReason) {
                return blockResult(conflictReason);
              }
            }
            return tool.execute(args, api, context);
          }

          // toolName === "bash"
          const cmd = String((args as { command?: unknown })?.command ?? "");
          const floor = classifyShellSafetyFloor(cmd);
          if (floor.verdict === "block") {
            return blockResult(`主脑安全护栏拦截了毁灭性 Shell 命令（${floor.reason ?? "catastrophic"}）："${cmd.slice(0, 120)}"。`);
          }
          const liveIdentityDir = getLiveIdentityDir();
          if (
            (liveIdentityDir && cmd.includes(liveIdentityDir)) ||
            (config.identityDir && cmd.includes(config.identityDir)) ||
            cmd.includes(path.join(config.stateDir, "kulo.sqlite")) ||
            cmd.includes(path.join(config.stateDir, "credentials.json"))
          ) {
            return blockResult("主脑沙箱禁止通过 bash 访问私有身份目录或 Kulo 状态凭据文件。");
          }
          const conflictReason = await checkActiveWriteLock(authorizedWorkspaceDir);
          if (conflictReason) {
            return blockResult(conflictReason);
          }
          const rawTimeout = (args as { timeout?: unknown })?.timeout;
          const clampedTimeout =
            typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
              ? Math.min(rawTimeout, ORCHESTRATOR_MAX_BASH_TIMEOUT_SECONDS)
              : ORCHESTRATOR_DEFAULT_BASH_TIMEOUT_SECONDS;
          const nextArgs =
            rawTimeout !== clampedTimeout
              ? { ...(args as Record<string, unknown>), timeout: clampedTimeout }
              : args;
          return tool.execute(nextArgs as never, api, context);
        },
      }),
    });
    const orchestratorGuardExt = defineExtension({
      name: "kulo-orchestrator-guard",
      wraps: [
        wrapOrchestratorCodingTool("read"),
        wrapOrchestratorCodingTool("write"),
        wrapOrchestratorCodingTool("edit"),
        wrapOrchestratorCodingTool("bash"),
      ],
    });

    const notifyTicketsChanged = () => {
      if (hubRef) {
        void hubRef.#broadcastTickets(BACKGROUND_CONTEXT).catch((error) => console.error("[KuloTickets]", error));
        hubRef.#queueWaitReconcile();
      }
    };

    const identityFiles = new KuloIdentityFiles(getLiveIdentityState, {
      getLanguage: getLiveLanguage,
      managedDirectory: defaultIdentityDir,
    });

    const connections: ConnectionToolController = {
      list: (caller, ctx) => hubRef!.#connectionList(caller, ctx),
      describe: (caller, input, ctx) => hubRef!.#connectionDescribe(caller, input, ctx),
      request: (caller, input, ctx) => hubRef!.#connectionRequest(caller, input, ctx),
      decide: (caller, input, ctx) => hubRef!.#connectionDecide(caller, input, ctx),
      grant: (caller, input, ctx) => hubRef!.#connectionGrant(caller, input, ctx),
      use: (caller, input, ctx) => hubRef!.#connectionUse(caller, input, ctx),
    };
    const computerUseExt = createComputerUseExtension({
      scope: async (api) => {
        const state = await hubRef!.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        if (isOrchestratorConversation(api.conversationId, state)) {
          const resolved = await hubRef!.#resolveOrchestratorTargetEnvId(
            Number(api.conversationId),
            Number(api.taskId),
            BACKGROUND_CONTEXT,
          );
          const existing = hubRef!.#orchestratorBrowserSessions.get(resolved.topicId);
          if (existing && existing.envId !== resolved.envId) {
            await hubRef!.#closeOrchestratorBrowserSession(resolved.topicId);
          } else if (existing) {
            hubRef!.#touchOrchestratorBrowserSession(
              resolved.topicId,
              Number(api.conversationId),
              resolved.envId,
              existing.sessionId,
            );
          }
          const assertActive = async () => {
            if (hubRef!.#closed) throw new Error("Hub 已关闭。");
            const latestState = await hubRef!.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
            const topic = latestState?.topics?.[resolved.topicId];
            if (!topic || topic.deletedAt) throw new Error("会话已删除。");
            const envDesc = envManager.getEnvDescriptor(resolved.envId);
            if (!envDesc?.online) throw new Error("目标电脑已离线，浏览器会话已停止。");
          };
          return {
            ticketId: `chat:${resolved.topicId}:${resolved.envId}`,
            conversationId: Number(api.conversationId),
            runEpoch: 1,
            envId: resolved.envId,
            readOnly: true,
            assertActive,
          };
        }

        const source = await hubRef!.mediaSource(Number(api.conversationId));
        if (!source.ticketId || !source.envId || source.runEpoch === undefined) {
          throw new Error("电脑操作需要有效的执行任务及目标设备。");
        }
        const assertActive = async () => {
          const current = await hubRef!.mediaSource(Number(api.conversationId));
          if (current.ticketId !== source.ticketId || current.envId !== source.envId || current.runEpoch !== source.runEpoch) {
            throw new Error("电脑操作的任务执行资格已失效。");
          }
          const currentState = await hubRef!.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
          const scope = resolveTicketExecutionScope(currentState, api.conversationId);
          if (scope?.subagent && scope.subagent.state !== "running") {
            throw new Error("子任务已停止，不能继续操作设备。");
          }
          await hubRef!.#validateMediaSource(source);
        };
        const retainedSession = [...hubRef!.#computerSessions.values()].find(
          (entry) => entry.ticketId === source.ticketId && entry.conversationId === Number(api.conversationId) && entry.envId === source.envId,
        );
        if (retainedSession && retainedSession.runEpoch !== source.runEpoch) {
          retainedSession.runEpoch = source.runEpoch;
        }
        return {
          ticketId: source.ticketId,
          conversationId: Number(api.conversationId),
          runEpoch: source.runEpoch,
          envId: source.envId,
          readOnly: Boolean(source.readOnly),
          ...(retainedSession ? { preservedSessionId: retainedSession.sessionId } : {}),
          assertActive,
        };
      },
      execute: (envId, request, signal) => {
        if (request.tool === "browser" && !hubRef!.#computerUseSettings.browserEnabled) {
          throw new Error("浏览器操控已关闭，请在「工具与技能 → 电脑操控」中开启。");
        }
        if (request.tool === "desktop" && !hubRef!.#computerUseSettings.desktopEnabled) {
          throw new Error("桌面操控已关闭，请在「工具与技能 → 电脑操控」中开启。");
        }
        return envManager.requestComputerUse(envId, request, signal);
      },
      sessionOpened: async (scope, tool, sessionId) => {
        if (scope.ticketId.startsWith("chat:")) {
          if (tool === "browser") {
            const topicId = scope.ticketId.split(":")[1] ?? "root";
            hubRef!.#touchOrchestratorBrowserSession(topicId, scope.conversationId, scope.envId, sessionId);
          }
          return;
        }
        if (tool === "browser") {
          await hubRef!.#closeOrchestratorBrowserSessionsForEnv(scope.envId, true);
        }
        if (!envManager.getEnvDescriptor(scope.envId)?.capabilities.includes(`agent-${tool}`)) return;
        const key = `${scope.ticketId}:${tool}:${sessionId}`;
        if (!hubRef!.#computerSessions.has(key)) {
          hubRef!.#computerSessions.set(key, {
            ticketId: scope.ticketId,
            envId: scope.envId,
            tool,
            sessionId,
            conversationId: scope.conversationId,
            runEpoch: scope.runEpoch,
          });
        }
        await hubRef!.harness.commit(async (tx) => {
          const ticket = (await tx.doc(KuloStateDoc)).tickets[scope.ticketId];
          if (ticket && ticket.runEpoch === scope.runEpoch && !ticket.deviceStateTouched) {
            ticket.deviceStateTouched = true;
          }
        }, BACKGROUND_CONTEXT);
      },
      sessionObserved: (scope, tool, sessionId, app) => {
        if (scope.ticketId.startsWith("chat:")) return;
        const session = hubRef!.#computerSessions.get(`${scope.ticketId}:${tool}:${sessionId}`);
        if (session) session.app = app;
      },
      sessionClosed: (scope, tool, sessionId) => {
        if (scope.ticketId.startsWith("chat:")) {
          const topicId = scope.ticketId.split(":")[1] ?? "root";
          hubRef!.#forgetOrchestratorBrowserSession(topicId, sessionId);
          return;
        }
        hubRef!.#computerSessions.delete(`${scope.ticketId}:${tool}:${sessionId}`);
      },
      requestHandoff: (scope, input, api, ctx) => hubRef!.#requestComputerHandoff(scope, input, api, ctx),
    });
    const hostActions: HostActionController = {
      inspect: (caller, input, ctx) => hubRef!.#hostActionInspect(caller, input, ctx),
      run: (caller, input, ctx) => hubRef!.#hostActionRun(caller, input, ctx),
      decide: (caller, input, ctx) => hubRef!.#hostActionDecide(caller, input, ctx),
    };
    const workerExt = createWorkerExtension({
      connections,
      hostActions,
      uploads,
      search: () => hubRef!.search,
      getLocalEnvId: () => envManager.localEnvId,
      publishAsset: (input, api, context) => contentExt.publishAsset(input, api, context),
      onStateChanged: notifyTicketsChanged,
      onOutwardAction: (ticketId, runEpoch, label) => hubRef ? hubRef.#recordTicketOutwardAction(ticketId, runEpoch, "shell", label) : undefined,
      getIdentityDir: getLiveIdentityDir,
      getMemoryConfig: getLiveMemory,
      getRoles: getLiveRoles,
      getLanguage: getLiveLanguage,
      getMaxSubagentsPerTicket: () =>
        (hubRef ? hubRef.#liveSettings.executor.maxSubagentsPerTicket : bootSettings?.executor.maxSubagentsPerTicket) ??
        config.maxSubagentsPerTicket,
      getMediaCapabilities: () =>
        hubRef
          ? hubRef.capabilities.snapshot()
          : Promise.resolve({
              revision: 1,
              connections: [],
              capabilities: [],
              imageRouting: { mode: "auto", preference: "balanced", rules: [], instructions: "" },
            }),
      runSubagents: (req, ctx) => hubRef!.#runSubagents(req, ctx),
      mediaJob: async (id, conversationId) => {
        const source = await hubRef!.mediaSource(conversationId);
        const job = await hubRef!.mediaJobs.get(id);
        if (!source.ticketId || job.source.ticketId !== source.ticketId) throw new Error("不能等待其他任务的媒体作业。");
        return job;
      },
    });

    const memoryLifecycleExt = createMemoryLifecycleExtension({ getHarness: () => hubRef!.harness, getMemoryConfig: getLiveMemory });
    const failureRecoveryTask = createFailureRecoveryTask({
      review: (ticketId, startedAt, ctx) => hubRef!.#reviewTicketRecovery(ticketId, startedAt, ctx),
      onChanged: ctx => hubRef!.#broadcastTickets(ctx),
    });
    const workerTicketTask = createWorkerTicketTask({
      recoveryTask: failureRecoveryTask,
      envManager,
      uploads,
      redact,
      getMaxConcurrentWorkers,
      isTicketRunnable: (ticket) => Boolean(hubRef && !hubRef.#recovering && !hubRef.#closed && hubRef.#ticketDevicesOnline(ticket)),
      onTicketWaiting: (id, reason) => {
        if (hubRef && reason !== "user" && reason !== "coordinator") hubRef.#notifyInlineWaiters(id);
        if (hubRef && reason === "env") hubRef.#queueEnvReconcile();
        if (hubRef && reason === "connection") void hubRef.#relayConnectionRequest(id).catch((error) => console.error("[KuloConnectionRequest]", redact(error instanceof Error ? error.message : "连接申请转交失败")));
        if (hubRef && reason === "coordinator") void hubRef.#relayHostActionRequest(id).catch((error) => console.error("[KuloHostActionRequest]", redact(error instanceof Error ? error.message : "本机操作审批转交失败")));
      },
      resumeWaitingTicket: async (id, ctx) => { if (hubRef) await hubRef.#resumeWaitingTicket(id, ctx); },
      scheduledWakeDeferUntil: (ticket, now) => hubRef ? hubRef.#scheduledWakeDeferUntil(ticket, now) : null,
      prepareTicketRelease: (ticket) => hubRef!.#releaseTicketExecution(ticket, { park: Boolean(ticket.waiting) && isTicketUnfinished(ticket) }),
      ticketAgentBlock: (ticket) => hubRef ? hubRef.#ticketAgentBlock(ticket) : undefined,
      getProjectMeta: async (projectId, ctx) => hubRef ? hubRef.projects.get(projectId, ctx).then((p) => ({ id: p.id, name: p.name, workspaceDir: p.workspaceDir }), () => undefined) : undefined,
      materializeExternalAttachments: (ticket, attachmentIds, ctx) => hubRef ? hubRef.#materializeExternalAttachments(ticket, attachmentIds, ctx) : Promise.resolve([]),
      recallExternalMemory: (ticket, ctx) => memoryLifecycleExt.recallTicketMemory(ticket, ctx),
      retainExternalMemory: (ticket, report, ctx) => memoryLifecycleExt.retainExternalTicketReport(ticket, report, ctx),
      consumeExternalPendingReports: (ticket, reports, ctx) => hubRef ? hubRef.#consumeExternalPendingReports(ticket, reports, ctx) : Promise.resolve([]),
      hasTicketConnections: (ticket) => Boolean(ticket.connectionIds?.length),
      isExternalMemoryEnabled: () => { const m = getLiveMemory(); return Boolean(m.enabled && m.accessMode !== "private-only"); },
      syncWorkerConversation: async (ticket, ctx) => { if (hubRef) await hubRef.#syncSingleWorkerConversation(ticket, ctx); },
      prepareBuiltInStagedWorkspace: (ticket, ctx) => hubRef!.#prepareBuiltInStagedWorkspace(ticket, ctx),
      inspectBuiltInStagedDiff: (ticket) => hubRef!.#inspectBuiltInStagedDiffSummary(ticket),
      discardBuiltInStagedWorkspace: (ticket) => hubRef!.#discardTicketStagedWorkspace(ticket).then(() => undefined),
      onTicketsChanged: notifyTicketsChanged,
      onTicketRunning: (ticketId, workerConversationId, runEpoch) => {
        if (hubRef) void hubRef.#trackWorkerRunning(ticketId, workerConversationId, runEpoch).catch((error) => {
          if (hubRef && !hubRef.#closed) console.error("[KuloWorkerTracking]", redact(error instanceof Error ? error.message : String(error)));
        });
      },
      onTicketSettled: (ticketId) => {
        if (hubRef) {
          hubRef.#untrackWorker(ticketId);
        }
      },
      onInlineCandidateSettled: (ticketId) => {
        if (hubRef) hubRef.#notifyInlineWaiters(ticketId);
      },
      onOriginConversationRelayed: async (originConvId, ctx) => {
        if (hubRef) await hubRef.#ensureTopicWatchedByConversation(originConvId, ctx);
      },
      onExternalAgentQuota: (binding, quota) => {
        hubRef?.externalClientQuotas.ingestPassiveQuota(binding, quota);
      },
    });

    const schedulerExt = defineExtension({
      name: "kulo-scheduler",
      tasks: [workerTicketTask, failureRecoveryTask],
    });

    const controllerProxy: OrchestratorController = {
      connections,
      hostActions,
      showDeviceInvitation: async (conversationId, callId) => {
        const hub = hubRef!;
        const device = hub.#deviceController?.view();
        if (!device || device.role !== "hub") throw new Error("本机主脑的设备互联服务暂不可用。");
        await hub.uiCards.showDeviceInvitation(device.hubId, hub.connectionManager.redact(device.hubName), { conversationId, callId, toolCallId: callId });
      },
      dispatchTicket: (p, ctx) => hubRef!.dispatchTicket(p, ctx),
      dispatchTicketForModel: (p, ctx) => hubRef!.dispatchTicketForModel(p, ctx),
      steerTicket: (p, ctx) => hubRef!.steerTicket(p, ctx),
      stopTicket: (id, r, ctx, commandId, origin) => hubRef!.stopTicket(id, r, ctx, commandId, origin),
      closeTicket: (p, ctx) => hubRef!.closeTicket(p, ctx),
      inspectWorker: (id, ctx) => hubRef!.inspectWorker(id, ctx),
      respondExternalAgentPermission: (id, permissionId, choiceId, epoch, ctx) => hubRef!.respondExternalAgentPermission(id, permissionId, choiceId, epoch, ctx),
      handleExternalAgentPermission: (input, source, ctx) => hubRef!.#handleExternalAgentPermission(input, source, ctx),
      askUserForTicket: (params, source, ctx) => hubRef!.#askUserForTicket(params, source, ctx),
      inspectStagedDiff: (id, filePath, ctx) => hubRef!.inspectStagedDiff(id, filePath, ctx),
      applyStagedChanges: (p, ctx) => hubRef!.applyStagedChanges(p, ctx),
      applyStagedChangesFromTool: (p, source, ctx) => hubRef!.#applyStagedChangesFromTool(p, source, ctx),
      getBoardSnapshot: (ctx) => hubRef!.getBoardSnapshot(ctx),
      readIdentityFiles: (f) => hubRef!.readIdentityFiles(f),
      proposeIdentity: (content, summary) => hubRef!.personality.proposeIdentity(content, summary),
      updateRelationship: (request) => hubRef!.personality.saveRelationship(request),
      getForgottenTerms: () => hubRef!.personality.getForgottenTerms(),
      forgetMemory: (term, reason, caller, signal) => executeMemoryForget({ term, reason, caller, signal, host: { addForgottenTerm: (t, r) => hubRef!.personality.addForgottenTerm(t, r), forgetFromRelationship: (t, r) => hubRef!.personality.forgetFromRelationship(t, r), getMemoryConfig: getLiveMemory } }),
      setAgentExpression: (face, cue, ctx) => hubRef!.setAgentExpression(face, cue, ctx),
    };

    const allOrchestratorSections = createOrchestratorSections({
      getAgentName,
      getLanguage: getLiveLanguage,
      getRoles: getLiveRoles,
      getExternalClients: () => (hubRef ? hubRef.#liveSettings.externalClients : undefined) ?? {},
      getEnvs: () => envManager.listEnvs(),
      getIdentityDir: getLiveIdentityDir,
      getMemoryConfig: getLiveMemory,
      getMediaCapabilities: () =>
        hubRef
          ? hubRef.capabilities.snapshot()
          : Promise.resolve({
              revision: 1,
              connections: [],
              capabilities: [],
              imageRouting: { mode: "auto", preference: "balanced", rules: [], instructions: "" },
            }),
      getPersonalityContext: () => hubRef!.personality.context(),
    });
    const tailKeys = new Set(["kulo_envs", "kulo_projects", "kulo_recent_work"]);
    const headSections = allOrchestratorSections.filter((sec) => !tailKeys.has(sec.key));
    const tailSections = allOrchestratorSections.filter((sec) => tailKeys.has(sec.key));

    const orchestratorExt = createOrchestratorToolsExtension(
      controllerProxy,
      headSections,
      getLiveMemory,
      () => hubRef!.search,
    );
    const orchestratorTailExt = defineExtension({
      name: "kulo-orchestrator-tail",
      sections: tailSections,
    });
    const projectController: ProjectController = {
      listProjects: (ctx, includeDeleted) => hubRef!.projects.list(ctx, includeDeleted),
      listProjectTopics: (projectId, ctx, includeDeleted) => hubRef!.projects.listTopics(projectId, ctx, includeDeleted),
      createProject: (input, ctx) => hubRef!.projects.create(input, ctx),
      patchProject: (id, input, ctx) => hubRef!.projects.patch(id, input, ctx),
      deleteProject: (id, input, ctx) => hubRef!.projects.remove(id, input, ctx),
      restoreProject: (id, ctx) => hubRef!.projects.restore(id, ctx),
      moveProjectTopic: (id, projectId, ctx) => hubRef!.projects.moveTopic(id, projectId, ctx),
      restoreProjectTopic: (id, ctx) => hubRef!.projects.restoreTopic(id, ctx),
      renameProjectTopic: (id, title, ctx) => parseSettingsTopicConversationId(id) !== null
        ? hubRef!.settingsAssistant.renameConversation(id, title)
        : hubRef!.patchTopic(id, { title }, ctx),
      searchProjectHistory: (id, query, ctx) => hubRef!.projects.searchHistory(id, query, ctx),
    };
    const projectExt = createProjectToolsExtension(projectController);
    const globalSettingsExt = createGlobalSettingsToolsExtension(() => hubRef!.settingsAssistant);
    const settingsAssistantExt = createSettingsAssistantExtension(() => hubRef!.settingsAssistant);
    const deviceToolsExt = createDeviceToolsExtension(() => hubRef!.settingsAssistant);
    const customizationExt = config.customization ? createCustomizationToolsExtension({
      service: () => hubRef!.customizationService(),
      caller: (api) => hubRef!.#customizationCaller(api.conversationId),
      confirmValidate: (sessionId, api, caller, service) => hubRef!.#confirmCustomizationValidate(sessionId, api, caller, service),
    }) : undefined;
    const appearanceCustomizationExt = createAppearanceCustomizationToolsExtension({ read: () => hubRef!.settingsAssistant.readAppearanceCustomization(),
      propose: (customization, commandId) => hubRef!.settingsAssistant.proposeAppearanceCustomization(customization, commandId) });
    const modelConfigurationExt = createModelConfigurationToolsExtension({
      service: {
        workspace: (...args) => hubRef!.modelConfiguration.workspace(...args),
        prepare: (...args) => hubRef!.modelConfiguration.prepare(...args),
        discover: (...args) => hubRef!.modelConfiguration.discover(...args),
        updateDraft: (...args) => hubRef!.modelConfiguration.updateDraft(...args),
      },
      lookupMetadata: (input) => hubRef!.settingsAssistant.lookupModelMetadata(input),
      calibrate: (rawUpdates, title, commandId) => hubRef!.settingsAssistant.calibrateModels(rawUpdates, title, commandId),
      context: () => hubRef!.settingsAssistant.configurationContext("models"),
    });
    const agentConfigurationExt = createAgentConfigurationToolsExtension({ service: {
      workspace: (...args) => hubRef!.agentConfiguration.workspace(...args),
      scan: (...args) => hubRef!.agentConfiguration.scan(...args),
      quickConnect: (...args) => hubRef!.agentConfiguration.quickConnect(...args),
      prepare: (...args) => hubRef!.agentConfiguration.prepare(...args),
      updateDraft: (...args) => hubRef!.agentConfiguration.updateDraft(...args),
      detect: (...args) => hubRef!.agentConfiguration.detect(...args),
      probe: (...args) => hubRef!.agentConfiguration.probe(...args),
      authenticate: (...args) => hubRef!.agentConfiguration.authenticate(...args),
      verify: (...args) => hubRef!.agentConfiguration.verify(...args),
      save: (...args) => hubRef!.agentConfiguration.save(...args),
      remove: (...args) => hubRef!.agentConfiguration.remove(...args),
      discard: (...args) => hubRef!.agentConfiguration.discard(...args),
      readGuide: (...args) => hubRef!.agentConfiguration.readGuide(...args),
    }, context: (conversationId) => hubRef!.settingsAssistant.configurationContext("workers", conversationId) });

    const publishAsset = createAssetPublisher({
      cards: () => hubRef!.uiCards,
      projects: () => hubRef!.projects,
      envManager, uploads, mainWorkspaceDir,
      protectedPaths: () => [config.stateDir, getLiveIdentityDir()],
      redact,
    });
    const publishDiagram = createDiagramPublisher({
      cards: () => hubRef!.uiCards,
      uploads,
      redact,
    });
    const contentExt = createContentToolsExtension({
      get: () => hubRef!.uiCards,
      scope: async (api) => {
        const state = await api.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const conversationId = Number(api.conversationId);
        if (isOrchestratorConversation(api.conversationId, state)) {
          const topicId = state?.conversationToTopic?.[String(conversationId)] ?? "root";
          if (state?.topics?.[topicId]?.deletedAt) throw new UiCardError("content_scope_denied", "当前对话已删除。", 403);
          return { conversationId, callId: api.callId, toolCallId: api.callId, topicId };
        }
        const settings = await api.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
        if (isActiveSettingsConversation(conversationId, settings)) {
          return { conversationId, callId: api.callId, toolCallId: api.callId, topicId: settingsTopicId(conversationId) };
        }
        throw new UiCardError("content_scope_denied", "请由主对话发布交互卡片。", 403);
      },
      publishAsset,
      publishDiagram,
      inspectAsset: publishAsset.inspectAsset,
    });

    const skillExt = createSkillToolsExtension({ get: () => hubRef!.skills, audience: (api) => hubRef!.skillAudience(Number(api.conversationId)),
      runtimeContext: async (api, context, requirements) => {
        const state = await harness.snapshot(KuloStateDoc, context);
        const filterComputerCaps = (caps: readonly string[]) =>
          caps.filter((cap) =>
            (cap !== "agent-browser" || hubRef!.#computerUseSettings.browserEnabled)
            && (cap !== "agent-desktop" || hubRef!.#computerUseSettings.desktopEnabled),
          );
        const resolveMediaKinds = async (isWorker: boolean): Promise<MediaKind[]> => {
          if (!requirements.media) return [];
          const snap = await hubRef!.capabilities.snapshot();
          const kinds = new Set<MediaKind>();
          for (const cap of snap.capabilities) {
            if (!cap.enabled) continue;
            if (isWorker && cap.allowTaskGeneration === false) continue;
            kinds.add(cap.kind);
          }
          return [...kinds];
        };
        const hasOnlineAndroid = () =>
          envManager.listEnvs().some(
            (env) => env.online && env.executionKind === "native-device" && env.android?.enabled !== false && !env.android?.paused,
          );
        const memoryKnowledgeForChat =
          hubRef!.#liveSettings.memory.enabled && Boolean(hubRef!.#liveSettings.memory.knowledgeGuidanceEnabled);
        const memoryKnowledgeForWorker =
          memoryKnowledgeForChat && hubRef!.#liveSettings.memory.accessMode !== "private-only";

        if (isOrchestratorConversation(api.conversationId, state)) {
          let platform: string | undefined;
          let capabilities: string[] = [];
          if (requirements.targetDevice) {
            const target = await hubRef!.#resolveOrchestratorSkillTarget(
              Number(api.conversationId),
              api.taskId !== undefined ? Number(api.taskId) : undefined,
              context,
            );
            platform = target.platform;
            capabilities = filterComputerCaps(target.capabilities);
          }
          return {
            ...(platform ? { platform } : {}),
            capabilities,
            reactWorkspace: false,
            mediaKinds: await resolveMediaKinds(false),
            androidAvailable: requirements.android ? hasOnlineAndroid() : false,
            customizationEnabled: Boolean(hubRef!.config.customization),
            memoryKnowledgeEnabled: memoryKnowledgeForChat,
          };
        }
        const settingsDoc = await harness.snapshot(SettingsAssistantDoc, context);
        if (isActiveSettingsConversation(Number(api.conversationId), settingsDoc)) {
          return {
            capabilities: [],
            reactWorkspace: false,
            mediaKinds: await resolveMediaKinds(false),
            androidAvailable: requirements.android ? hasOnlineAndroid() : false,
            customizationEnabled: Boolean(hubRef!.config.customization),
            memoryKnowledgeEnabled: memoryKnowledgeForChat,
          };
        }
        const scope = resolveTicketExecutionScope(state, api.conversationId);
        if (!scope || scope.ticket.status !== "running" || scope.subagent && scope.subagent.state !== "running") return undefined;
        if (scope.ticket.executionDomain === "android") {
          return {
            capabilities: [],
            reactWorkspace: false,
            executionDomain: "android",
            androidAvailable: true,
          };
        }
        const source = await hubRef!.mediaSource(Number(api.conversationId));
        await hubRef!.#validateMediaSource(source);
        const device = envManager.getEnvDescriptor(scope.ticket.envId);
        const target = device?.online
          ? { platform: device.platform, capabilities: filterComputerCaps(device.capabilities) }
          : { capabilities: [] as string[] };
        const mediaKinds = await resolveMediaKinds(true);
        const androidAvailable = Boolean(scope.ticket.androidDeviceIds?.length);
        if (!requirements.reactWorkspace || !device?.online) {
          return {
            ...target,
            reactWorkspace: false,
            executionDomain: "computer",
            mediaKinds,
            androidAvailable,
            memoryKnowledgeEnabled: memoryKnowledgeForWorker,
          };
        }
        try {
          return {
            ...target,
            reactWorkspace: await detectReactWorkspace(api.env, context),
            executionDomain: "computer",
            mediaKinds,
            androidAvailable,
            memoryKnowledgeEnabled: memoryKnowledgeForWorker,
          };
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          if (!(error instanceof FileError) && !(error instanceof SkillRuntimeError)) throw error;
          return {
            ...target,
            reactWorkspace: false,
            executionDomain: "computer",
            mediaKinds,
            androidAvailable,
            memoryKnowledgeEnabled: memoryKnowledgeForWorker,
            diagnostics: [`React 项目检测失败（${error.code}），前端预置 Skill 暂不可用。`],
          };
        }
      },
      executionScope: async (api) => {
        const source = await hubRef!.mediaSource(Number(api.conversationId));
        const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const ticket = source.ticketId ? state?.tickets[source.ticketId] : undefined;
        if (!ticket?.scratchDir) throw new Error("当前任务没有可用的临时目录。");
        return { scratchDir: ticket.scratchDir, assertActive: () => hubRef!.#validateMediaSource(source) };
      } });
    const capabilitySetupExt = createCapabilitySetupExtension(() => hubRef!);
    const mediaExt = createMediaToolsExtension({ get: () => hubRef!.mediaJobs, capabilities: () => hubRef!.capabilities.snapshot(), scope: (api) => hubRef!.mediaSource(Number(api.conversationId)) });
    const voiceExt = createVoiceToolsExtension({ service: () => hubRef!.voice, uploads: () => hubRef!.uploads,
      scope: (api) => hubRef!.mediaSource(Number(api.conversationId)), assertActive: (source) => hubRef!.#validateMediaSource(source),
      onOutwardAction: (source, label) => source.ticketId ? hubRef!.#recordTicketOutwardAction(source.ticketId, undefined, "voice", label) : undefined,
      publish: async (asset, source, callId) => {
        await hubRef!.#validateMediaSource(source);
        if (source.ticketId) {
          await hubRef!.#stageWorkerArtifact(asset, source, `speech:${asset.id}`);
          return;
        }
        const settingsConvId = parseSettingsTopicConversationId(source.topicId);
        if (settingsConvId !== null) {
          const settings = await harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
          if (!isActiveSettingsConversation(settingsConvId, settings)) throw new VoiceError(404, "voice_topic_not_found", "语音所属会话不可用。");
          uploads.bindAttachments([asset], `conversation:${settingsConvId}`, `agent:${source.conversationId}`);
          await harness.commit(async (tx) => {
            const currentSettings = await tx.doc(SettingsAssistantDoc);
            if (!isActiveSettingsConversation(settingsConvId, currentSettings)) throw new VoiceError(409, "voice_speech_scope_changed", "语音所属会话已变更。");
            const notices = await tx.doc(MediaNoticesDoc);
            const key = `speech:${asset.id}`;
            if (notices.notices[key]) return;
            await tx.appendEntry(ContentPublicationEntry, settingsConvId as ConversationId, { data: { parts: [{ partId: key, type: "audio", assetId: asset.id, asset }], fallbackText: "", createdAt: Date.now(), source: { conversationId: source.conversationId, callId } } as unknown as ContentPublicationData & JsonObject });
            notices.notices[key] = true;
          }, BACKGROUND_CONTEXT);
          await hubRef!.settingsAssistant.refreshIfConversation(settingsConvId);
          return;
        }
        const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const topic = state?.topics?.[source.topicId];
        if (!topic || topic.deletedAt) throw new VoiceError(404, "voice_topic_not_found", "语音所属会话不可用。");
        uploads.bindAttachments([asset], `conversation:${topic.conversationId}`, `agent:${source.conversationId}`);
        await harness.commit(async (tx) => {
          const current = await tx.doc(KuloStateDoc);
          const target = current.topics?.[source.topicId];
          if (!target || target.deletedAt || target.conversationId !== topic.conversationId) throw new VoiceError(409, "voice_speech_scope_changed", "语音所属会话已变更。");
          if (source.ticketId) {
            const ticket = current.tickets[source.ticketId];
            if (!ticket || ticket.status !== "running" || ticket.runEpoch !== source.runEpoch) throw new VoiceError(409, "voice_speech_scope_changed", "语音任务已停止。");
          }
          const notices = await tx.doc(MediaNoticesDoc);
          const key = `speech:${asset.id}`;
          if (notices.notices[key]) return;
          await tx.appendEntry(ContentPublicationEntry, topic.conversationId as ConversationId, { data: { parts: [{ partId: key, type: "audio", assetId: asset.id, asset }], fallbackText: "", createdAt: Date.now(), source: { conversationId: source.conversationId, callId } } as unknown as ContentPublicationData & JsonObject });
          notices.notices[key] = true;
        }, BACKGROUND_CONTEXT);
        const cache = hubRef!.#topicCaches.get(source.topicId);
        if (cache) hubRef!.#refreshTopicContent(cache);
      } });
    const mediaExportExt = createMediaExportExtension({ harness: () => hubRef!.harness, uploads: () => hubRef!.uploads,
      scope: (api) => hubRef!.mediaSource(Number(api.conversationId)), validateInput: (id, source) => hubRef!.#validateMediaInput(id, source),
      assertActive: (source) => hubRef!.#validateMediaSource(source) });
    const memoryServiceExt = createMemoryServiceExtension(() => hubRef!.memoryService);
    const memorySetupExt = createMemorySetupExtension(() => hubRef!);
    const extensionsExt = createExtensionsExtension(() => hubRef!.extensions);
    const extensionSetupExt = createExtensionSetupExtension(() => hubRef!);
    const historyExt = createHistoryToolsExtension(() => hubRef!.history);
    const assistantToolsExt = createAssistantToolsExtension(() => ({
      ledger: hubRef!.assistantLedger,
      sparkMail: hubRef!.sparkMail,
      homeAssistant: hubRef!.homeAssistant,
      larkConnector: hubRef!.larkConnector,
      redact: (text) => hubRef!.connectionManager.redact(redactSensitiveText(text)),
      workspaceSnapshot: () => hubRef!.getAssistantWorkspace(),
      configureNotifications: (input) => hubRef!.configureAssistantNotifications(input),
      configureSpark: (input) => hubRef!.configureAssistantSpark(input),
      configureHomeAssistant: (input) => hubRef!.configureAssistantHomeAssistant(input),
      configureLark: (input) => hubRef!.configureAssistantLark(input),
      proposeDecisionCard: (input) => hubRef!.assistantCoordinator.proposeDecisionCard(input),
      configureBackgroundModel: (input) => hubRef!.configureAssistantBackgroundModel(input),
    }));
    const toolSearchExt = createToolSearchExtension();
    const androidExt = createAndroidToolsExtension({
      hubId: () => {
        if (!hubRef!.#androidHubId) throw new Error("手机执行入口尚未绑定主脑身份。");
        return hubRef!.#androidHubId;
      },
      scope: async (api) => {
        const state = await hubRef!.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const execution = resolveTicketExecutionScope(state, api.conversationId);
        if (!execution || execution.ticket.status !== "running" || execution.subagent && execution.subagent.state !== "running") {
          throw new Error("手机操作需要有效的运行中任务。");
        }
        const ticket = execution.ticket;
        const deviceIds = [...(ticket.androidDeviceIds ?? (ticket.executionDomain === "android" ? [ticket.envId] : []))];
        if (!deviceIds.length) throw new Error("此任务未获准操作手机。");
        const assertActive = async () => {
          const current = await hubRef!.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
          const active = resolveTicketExecutionScope(current, api.conversationId);
          if (!active || active.ticket.id !== ticket.id || active.ticket.runEpoch !== ticket.runEpoch || active.ticket.status !== "running" ||
              active.subagent && active.subagent.state !== "running" ||
              deviceIds.some(id => !active.ticket.androidDeviceIds?.includes(id) && !(active.ticket.executionDomain === "android" && active.ticket.envId === id))) {
            throw new Error("手机操作的任务范围已失效。");
          }
        };
        return { ticketId: ticket.id, conversationId: Number(api.conversationId), runEpoch: ticket.runEpoch,
          deviceIds, readOnly: execution.readOnly, assertActive };
      },
      execute: (envId, request, signal) => envManager.requestAndroid(envId, request, signal),
      resolveInput: (scope, action, args) => hubRef!.#resolveAndroidInput(scope, action, args),
      resolveAssets: (scope, result) => hubRef!.#resolveAndroidAssets(scope, result),
    });
    const settingsTierExt = createSettingsTierExtension();
    const computerMixedAndroidTierExt = createComputerMixedAndroidTierExtension();
    const contextCompaction = createContextCompactionController({
      getHarness: () => hubRef!.harness,
      getKernel: () => hubRef!.#getContextKernel(),
      isActive: () => hubRef ? hubRef.#contextEnabled : false,
      getReserveTokens: () => ((hubRef ? hubRef.#liveSettings.model.compaction : undefined) ?? bootSettings?.model.compaction ?? config.model.compaction ?? DEFAULT_COMPACTION_CONFIG).reserveTokens,
      onCompactionBaseline: async (conversationId, firstKept, ctx) => {
        if (hubRef) await hubRef.#pruneCompactedConversationTools(conversationId, firstKept, ctx);
      },
    });

    const registry = createRegistry();
    registry.install(redactionExt);
    registry.install(schedulerExt);
    registry.install(codingToolsExt);
    registry.install(androidExt);
    registry.install(toolSearchExt);
    registry.install(settingsTierExt);
    registry.install(computerMixedAndroidTierExt);
    registry.install(orchestratorGuardExt);
    registry.install(computerUseExt);
    registry.install(routerReadExt);
    registry.install(workerExt);
    registry.install(orchestratorExt);
    registry.install(orchestratorTailExt);
    registry.install(globalSettingsExt);
    registry.install(settingsAssistantExt);
    registry.install(deviceToolsExt);
    if (customizationExt) registry.install(customizationExt);
    registry.install(appearanceCustomizationExt);
    registry.install(modelConfigurationExt);
    registry.install(agentConfigurationExt);
    registry.install(contentExt);
    registry.install(projectExt);
    registry.install(skillExt);
    registry.install(capabilitySetupExt);
    registry.install(mediaExt);
    registry.install(voiceExt);
    registry.install(mediaExportExt);
    registry.install(memoryLifecycleExt);
    registry.install(memoryServiceExt);
    registry.install(memorySetupExt);
    registry.install(extensionsExt);
    registry.install(extensionSetupExt);
    registry.install(historyExt);
    registry.install(assistantToolsExt);
    registry.install(contextCompaction.extension);

    const harness = await Harness.open(
      storage,
      {
        models: withKuloCompactionFocus(models),
        registry,
        identity: { attribution: null },
        settings: () => {
          const liveComp =
            (hubRef ? hubRef.#liveSettings.model.compaction : undefined) ??
            bootSettings?.model.compaction ??
            config.model.compaction ??
            DEFAULT_COMPACTION_CONFIG;
          return {
            toolExecution: "parallel",
            steeringMode: "all",
            followUpMode: "all",
            compaction: buildAdaptiveCompactionPolicy(liveComp, models.getModels()),
            progress: {
              partialIntervalMs: 80,
              outputIntervalMs: 120,
              persistWithinMs: 1_000,
            },
          };
        },
        env: async (target, ctx) => {
          const settingsAssistant = await target.read.snapshot(SettingsAssistantDoc, ctx);
          const state = await target.read.snapshot(KuloStateDoc, ctx);
          const activeSettings = isActiveSettingsConversation(target.conversationId, settingsAssistant);
          if (isOrchestratorConversation(target.conversationId, state) || activeSettings) {
            const topicId = activeSettings ? undefined : state?.conversationToTopic?.[String(target.conversationId)];
            const topic = topicId ? state?.topics?.[topicId] : undefined;
            if (topic?.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
            if (topic?.projectId) {
              const project = await hubRef!.projects.get(topic.projectId, ctx);
              return lazyProjectEnvironment(`kulo-project:${project.id}`, project.workspaceDir, async () => {
                const authorized = await hubRef!.projects.ensureAuthorized(project.id, ctx);
                const envInfo = envManager.getEnvDescriptor(authorized.deviceId);
                const implementation = authorized.platform === "win32" ? path.win32 : path.posix;
                const scratchDir = implementation.join(authorized.scratchRoot ?? implementation.join(envInfo?.rootDir ?? implementation.dirname(authorized.workspaceDir), "scratch"), `reader-${Number(target.conversationId)}`);
                return envManager.createWorkerExecutionEnv(authorized.deviceId, authorized.workspaceDir, {
                  scratchDir,
                  projectId: authorized.id,
                  grantRevision: authorized.grantRevision,
                  readOnly: activeSettings,
                });
              });
            }
            // Hub-hosted tools such as search and settings remain available without an online execution node.
            const candidateEnv = envManager.listEnvs().find((env) => env.executionKind !== "native-device");
            if (!candidateEnv) return undefined;
            let defaultEnvId: string | undefined;
            try { defaultEnvId = envManager.pickDefaultEnvId(); }
            catch { defaultEnvId = undefined; }
            const envInfo = defaultEnvId ? envManager.getEnvDescriptor(defaultEnvId) : candidateEnv;
            const cwd = target.cwd ?? envInfo?.rootDir ?? mainWorkspaceDir;
            const execOptions = { sandboxed: true, offline: false, readOnly: activeSettings };
            if (defaultEnvId) return envManager.createExecutionEnv(defaultEnvId, cwd, execOptions);
            return lazyProjectEnvironment(`kulo-env:${candidateEnv.id}`, cwd, async () => {
              const resolvedId = envManager.pickDefaultEnvId();
              const resolvedInfo = envManager.getEnvDescriptor(resolvedId);
              return envManager.createExecutionEnv(resolvedId, target.cwd ?? resolvedInfo?.rootDir ?? mainWorkspaceDir, execOptions);
            });
          }

          const execScope = resolveTicketExecutionScope(state, target.conversationId);
          const ticket = execScope?.ticket;
          if (!ticket || ticket.status !== "running") {
            return undefined;
          }
          if (ticket.executionDomain === "android") return undefined;
          const activeStagedCwd = getActiveStagedCwd(ticket);
          if (!ticket.externalExecution && ticket.workspaceStaging?.mode === "staged" && !activeStagedCwd) {
            throw new Error(`Isolated staged workspace for ticket '${ticket.id}' is not prepared yet.`);
          }
          const effectiveWorkspaceDir = activeStagedCwd ?? ticket.workspaceDir;
          return envManager.createWorkerExecutionEnv(
            ticket.envId,
            activeStagedCwd ? effectiveWorkspaceDir : (target.cwd ?? effectiveWorkspaceDir),
            {
              scratchDir: ticket.scratchDir,
              projectId: ticket.projectId,
              grantRevision: ticket.grantRevision,
              readOnly: execScope?.readOnly,
              ...(activeStagedCwd && !ticket.externalExecution ? { stagedTaskId: ticket.id } : {}),
            },
          );
        },
        onReport: (report) => {
          if (
            report.kind === "storage_failed" ||
            report.kind === "task_faulted" ||
            report.kind === "extension_error" ||
            report.kind === "host_error"
          ) {
            console.error(`[KuloHub:${report.kind}]`, redact(report.error instanceof Error ? report.error.message : String(report.error)));
          }
        },
      },
      context,
    );

    closePartialStorage = () => harness.close(BACKGROUND_CONTEXT);
    const hasGatewayCredential = Boolean(await credentialStore.read(KULO_GATEWAY_PROVIDER_ID));
    const hydratedSettings = await harness.commit(async (tx) => {
      const stateDoc = await tx.doc(KuloStateDoc);
      const settingsDoc = await tx.doc(KuloSettingsDoc);
      hydrateSettingsFromConfig(settingsDoc, config, { hasGatewayCredential });
      assertMemoryIdentitySeparation(settingsDoc.memory, config, envManager);
      ensureDefaultRootTopic(stateDoc, settingsDoc.presentation.agentName);
      return cloneJson(settingsDoc) as KuloDurableSettings;
    }, context);

    bootSettings = hydratedSettings;
    const effectiveIdentityDir = resolveEffectiveIdentityDir(hydratedSettings, defaultIdentityDir);
    try {
      fs.mkdirSync(effectiveIdentityDir, { recursive: true, mode: 0o700 });
    } catch {
      // Optional external identityDir
    }

    if (providerManager) {
      await providerManager.bindLegacyApiKeyOrigins(normalizeModelConfig(hydratedSettings.model));
      providerManager.syncProviders(
        normalizeModelConfig(hydratedSettings.model),
        hydratedSettings.roles,
      );
    }

    const activeModel = hydratedSettings.model;
    const orchestratorAgent = resolveAgentModelAndThinking(
      models,
      providerId,
      activeModel.defaultProvider,
      activeModel.defaultModel,
      activeModel.thinkingLevel,
      activeModel,
    );
    const rootConversation = await harness.root(context, {
      agent: {
        model: orchestratorAgent.model,
        thinkingLevel: orchestratorAgent.thinkingLevel,
        extensions: [redactionExt, orchestratorExt, codingToolsExt, orchestratorGuardExt, computerUseExt, toolSearchExt, contentExt, projectExt, skillExt, orchestratorTailExt, mediaExt, voiceExt, memoryServiceExt, memorySetupExt, historyExt, assistantToolsExt, globalSettingsExt, ...(customizationExt ? [customizationExt] : []), contextCompaction.extension],
        cwd: mainWorkspaceDir,
        maxTurns: 25,
      },
    });

    await rootConversation.configure(
      {
        model: orchestratorAgent.model,
        thinkingLevel: orchestratorAgent.thinkingLevel,
        extensions: [redactionExt, orchestratorExt, codingToolsExt, orchestratorGuardExt, computerUseExt, toolSearchExt, contentExt, projectExt, skillExt, orchestratorTailExt, mediaExt, voiceExt, memoryServiceExt, memorySetupExt, historyExt, assistantToolsExt, globalSettingsExt, ...(customizationExt ? [customizationExt] : []), contextCompaction.extension],
        cwd: mainWorkspaceDir,
        maxTurns: 25,
      },
      context,
    );

    const hub = new KuloHub({
      releaseProxy,
      stateOwner,
      config,
      envManager,
      harness,
      rootConversation,
      identityFiles,
      uploads,
      providerId,
      models,
      providerManager,
      defaultIdentityDir,
      mainWorkspaceDir,
      liveSettings: hydratedSettings,
      workerTicketTask,
      failureRecoveryTask,
      codingToolsExt,
      androidExt,
      toolSearchExt,
      settingsTierExt,
      computerMixedAndroidTierExt,
      orchestratorGuardExt,
      computerUseExt,
      routerReadExt,
      workerExt,
      orchestratorExt,
      orchestratorTailExt,
      globalSettingsExt,
      settingsAssistantExt,
      customizationExt,
      appearanceCustomizationExt,
      modelConfigurationExt,
      agentConfigurationExt,
      deviceToolsExt,
      deviceJoinStaging,
      contentExt,
      projectExt,
      skillExt,
      mediaExt,
      voiceExt,
      capabilitySetupExt,
      mediaExportExt,
      memoryLifecycleExt,
      memoryServiceExt,
      memorySetupExt,
      extensionsExt,
      extensionPackages: init.extensionPackages,
      extensionSetupExt,
      historyExt,
      assistantToolsExt,
      contextCompaction,
      connectionManager,
      connections,
      redactionExt,
      credentialStore,
      voiceAsr: init.voiceAsr,
      voiceOpenLive: init.voiceOpenLive,
      watchdogCheckIntervalMs: init.watchdogCheckIntervalMs ?? 30_000,
      ...(init.watchdogStallMsOverride !== undefined
        ? { watchdogStallMsOverride: init.watchdogStallMsOverride }
        : {}),
      orchestratorBrowserIdleMs: init.orchestratorBrowserIdleMs ?? 60_000,
    });
    hubRef = hub;
    await observeChatAttachmentGrants(harness, uploads, context);
    await hub.#ticketBoard.open(harness, () => {
      if (hub.#closed) return;
      try { hub.#refreshTicketState(); }
      catch (error) { console.error("[KuloTickets]", redact(error instanceof Error ? error.message : String(error))); }
    }, context);
    await hub.skills.initialize();
    await hub.capabilities.initialize();
    hub.#computerUseSettings = (await hub.capabilities.computerUseSettings()).computerUse;
    await hub.#syncProviderImageCapabilities();
    await hub.search.initialize();
    hub.#webSearchAvailable = (await hub.search.snapshot()).plans.some((plan) => plan.enabled && plan.status !== "needs_auth");
    await hub.voice.initialize({ prepareAsr: false });
    await hub.#syncProviderVoiceModels();
    hub.#ttsEnabled = (await hub.voice.snapshot()).tts.enabled;
    const assistantSnap = await harness.snapshot(AssistantDoc, context);
    hub.#assistantActive = Boolean(
      assistantSnap?.enabled ||
        assistantSnap?.spark?.enabled ||
        assistantSnap?.homeAssistant?.enabled ||
        assistantSnap?.lark?.enabled ||
        (await hub.assistantLedger.hasAnyRecords()),
    );
    await hub.ambientModel.start();
    await hub.homeAssistant.start().catch(() => {});
    await hub.larkConnector.start().catch(() => {});
    if (assistantSnap?.enabled) {
      envManager.setConnectorConfig({
        driverId: "macos-notifications",
        enabled: true,
        mutedApps: assistantSnap.mutedApps ?? [],
      });
    }
    void hub.assistantLedger.pruneExpiredBodies().catch(() => {});
    bootSettings = hub.#liveSettings;

    await hub.#ensureTopicWatched("root", rootConversation, context);

    // Reattach only unfinished topic sources before Durable resumes them; idle histories stay unloaded.
    const [unfinished, topicState] = await Promise.all([
      harness.inspect(context), harness.snapshot(KuloStateDoc, context),
    ]);
    const activeConversations = new Set(unfinished.submissions.map((submission) => Number(submission.conversationId)));
    for (const topic of Object.values(topicState?.topics ?? {})) {
      if (!topic.deletedAt && topic.title) hub.#topicTitleCache.set(topic.id, topic.title);
      if (topic.deletedAt || !activeConversations.has(topic.conversationId) || hub.#topicCaches.has(topic.id)) continue;
      const conversation = await harness.conversation(topic.conversationId as ConversationId, context);
      if (conversation) await hub.#ensureTopicWatched(topic.id, conversation, context);
    }
    await hub.#reconfigureOrchestratorConversations(context);

    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.deliveryClaim === "inline_waiting") {
          ticket.deliveryClaim = "escalated";
        }
        if (ticket.status !== "running" && ticket.status !== "pausing") continue;
        if (ticket.externalExecution) {
          // Env owns the native process; its durable run receipt is reconciled without submitting another prompt.
          if (!state.slots.holders.includes(ticket.id)) state.slots.holders.push(ticket.id);
          continue;
        }
        // abortConversation resumes Durable's driver, so fence every old run before the first abort.
        ticket.runEpoch++;
        transitionTicketStatus(ticket, "pausing", Date.now());
        ticket.waiting ??= { reason: "env", since: Date.now(), detail: "重启后核对旧执行与项目目录" };
        ticket.cleanupPending = true;
        if (!state.slots.holders.includes(ticket.id)) state.slots.holders.push(ticket.id);
      }
    }, context);
    await hub.projects.reconcileCancellations(context);
    await hub.#queueWaitReconcile();
    await hub.#queueEnvReconcile();
    await hub.extensions.initialize();
    await hub.#recoverChatAttachments(context);
    await hub.assistantCoordinator.reconcileDispatchedActions(context);
    hub.#recovering = false;
    await hub.#reconcileDispatchedConfirmations(context);
    await hub.#startLegacyFailureRecovery(context);
    await hub.mediaJobs.start();
    await hub.usageCaps.start();
    await hub.personality.start();
    hub.#startWatchdog();
    harness.resume();
    for (const topicId of await hub.#topicTitles.start()) {
      try {
        const cache = await hub.#resolveWatchedTopic(topicId, context);
        hub.#topicTitles.observe(topicId, cache.messages, cache.live.busy || Boolean(cache.live.runFailure));
      } catch (error) {
        // A pending project binding may temporarily block its source view, not the Hub itself.
        console.warn("[KuloTopicTitle] Source unavailable during recovery", topicId, error instanceof ProjectError ? error.code : error instanceof Error ? error.name : "error");
      }
    }
    await hub.settingsAssistant.start();

    await hub.archiveInactiveTopics(context);
    hub.#startTopicAutoArchive();
    hub.#startUploadCleanup();
    return hub;
    } catch (error) {
      const cleanup = hubRef ? [() => hubRef!.close(BACKGROUND_CONTEXT)] :
        [closePartialStorage, () => partialEnv?.close(), () => partialConnections?.close(), releaseProxy, () => stateOwner?.close()];
      const failures = [error];
      for (const action of cleanup) {
        try { await action?.(); } catch (failure) { failures.push(failure); }
      }
      if (failures.length > 1) throw new AggregateError(failures, "Kulo 启动失败，关闭部分资源时也遇到了错误。", { cause: error });
      throw error;
    }
  }

  subscribe(listener: HubEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async listComputerPreviews(topicId: string): Promise<ComputerPreviewSessionView[]> {
    if (this.#closed || !topicId || topicId.length > 256) return [];
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const allTopics = topicId === "*";
    if (!allTopics) {
      const topic = state?.topics?.[topicId];
      if (!topic || topic.deletedAt) return [];
    }
    const sessions: ComputerPreviewSessionView[] = [];
    for (const [key, session] of this.#computerSessions) {
      const scope = resolveTicketExecutionScope(state, session.conversationId as ConversationId);
      const ticket = scope?.ticket;
      const env = this.envManager.getEnvDescriptor(session.envId);
      const originTopicId = ticket ? (ticket.originTopicId ?? "root") : undefined;
      const originTopic = originTopicId ? state?.topics?.[originTopicId] : undefined;
      const activeHandoff = this.#computerHandoffs.get(session.ticketId);
      const handoffActiveForSession = Boolean(activeHandoff && activeHandoff.sessionId === session.sessionId && ticket?.status === "waiting" && ticket.waiting?.reason === "user");
      if (!ticket || ticket.id !== session.ticketId || (!handoffActiveForSession && (ticket.status !== "running" || ticket.runEpoch !== session.runEpoch))
        || ticket.envId !== session.envId || !originTopic || originTopic.deletedAt
        || (!allTopics && originTopicId !== topicId)
        || (!handoffActiveForSession && scope?.subagent && scope.subagent.state !== "running") || !env?.online
        || !env.capabilities.includes(`agent-${session.tool}`)) continue;
      sessions.push({
        id: createHash("sha256").update(key).digest("hex"),
        ticketId: ticket.id,
        tool: session.tool,
        envId: env.id,
        deviceName: env.name,
        title: ticket.title,
        ...(session.app ? { app: session.app } : {}),
        ...(handoffActiveForSession && activeHandoff
          ? {
              handoff: {
                requestId: activeHandoff.requestId,
                ...(activeHandoff.cardId ? { cardId: activeHandoff.cardId } : {}),
                reason: activeHandoff.reason,
                target: activeHandoff.tool,
                expiresAt: activeHandoff.expiresAt,
                ...(activeHandoff.url ? { url: activeHandoff.url } : {}),
                ...(activeHandoff.app ? { app: activeHandoff.app } : {}),
                interactive: session.tool === "browser",
              },
            }
          : {}),
      });
    }
    return sessions.slice(0, 16);
  }

  async subscribeComputerPreview(id: string, topicId: string, listener: (update: ComputerPreviewUpdate) => void): Promise<() => void> {
    if (!(await this.listComputerPreviews(topicId)).some((session) => session.id === id)) throw new Error("操作预览已失效。");
    const session = [...this.#computerSessions].find(([key]) => createHash("sha256").update(key).digest("hex") === id)?.[1];
    if (!session) throw new Error("操作预览已失效。");
    let closed = false;
    let unsubscribe = () => {};
    let latest: ComputerPreviewUpdate | undefined;
    let checking = false;
    const dispose = () => { if (!closed) { closed = true; latest = undefined; unsubscribe(); } };
    // Authorize each delivered frame against the current epoch, including subagent and task stops.
    const flush = async () => {
      checking = true;
      try {
        while (!closed && latest) {
          const authorized = (await this.listComputerPreviews(topicId)).some((view) => view.id === id);
          if (closed) break;
          if (!authorized) { listener({ state: "closed" }); dispose(); break; }
          const update = latest;
          latest = undefined;
          listener(update);
        }
      } catch {
        if (!closed) listener({ state: "unavailable", message: "操作预览暂不可用。" });
        dispose();
      } finally { checking = false; }
    };
    unsubscribe = this.envManager.subscribeComputerPreview(session.envId, { tool: session.tool, sessionId: session.sessionId }, (update) => {
      if (closed) return;
      latest = update;
      if (!checking) void flush();
    });
    if (closed) unsubscribe();
    return dispose;
  }

  async sendComputerPreviewInput(id: string, topicId: string, event: ComputerPreviewInputEvent): Promise<boolean> {
    if (this.#closed) return false;
    const previews = await this.listComputerPreviews(topicId);
    const view = previews.find((item) => item.id === id);
    if (!view?.handoff?.interactive || view.tool !== "browser") return false;
    const session = [...this.#computerSessions].find(([key]) => createHash("sha256").update(key).digest("hex") === id)?.[1];
    if (!session || !this.#computerHandoffs.hasActiveHandoff(session.ticketId, session.sessionId)) return false;
    return this.envManager.sendComputerPreviewInput(session.envId, { tool: "browser", sessionId: session.sessionId }, event);
  }

  async #requestComputerHandoff(
    scope: { ticketId: string; conversationId: number; runEpoch: number; envId: string },
    input: { target: "browser" | "desktop"; sessionId: string; reason: string; url?: string; app?: string },
    api: { callId: string },
    context: Context,
  ): Promise<{ requestId: string; cardId?: string; expiresAt: number }> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[scope.ticketId];
    if (!ticket || ticket.status !== "running" || ticket.runEpoch !== scope.runEpoch) {
      throw new Error("当前任务已不在运行中，无法发起人工接管。");
    }
    const envDesc = this.envManager.getEnvDescriptor(scope.envId);
    if (!envDesc?.online || !envDesc.capabilities.includes(`agent-${input.target}`)) {
      throw new Error("目标设备离线或未开启对应电脑操控能力。");
    }
    const now = Date.now();
    const expiresAt = now + COMPUTER_HANDOFF_TTL_MS;
    const originConversationId = ticket.originConversationId ?? Number(this.rootConversation.id);
    const key = `${scope.ticketId}:${input.target}:${input.sessionId}`;
    if (!this.#computerSessions.has(key)) {
      this.#computerSessions.set(key, {
        ticketId: scope.ticketId, envId: scope.envId, tool: input.target, sessionId: input.sessionId,
        conversationId: scope.conversationId, runEpoch: scope.runEpoch, ...(input.app ? { app: input.app } : {}),
      });
    }
    const safeReason = this.connectionManager.redact(input.reason);
    const built = buildComputerHandoffCard({
      target: input.target, deviceName: envDesc.name, reason: safeReason, url: input.url, app: input.app,
    });
    const fingerprint = computerHandoffFingerprint({
      ticketId: scope.ticketId, runEpoch: scope.runEpoch, target: input.target, sessionId: input.sessionId, reason: safeReason,
    });
    const { confirmation } = await this.actionConfirmations.ensurePendingCard({
      conversationId: originConversationId, topicId: ticket.originTopicId ?? "root", ticketId: scope.ticketId,
      callId: api.callId, kind: "computer_handoff", fingerprint, cardInput: built.input, logicalIds: built.logicalIds,
      payload: {
        kind: "computer_handoff", ticketId: scope.ticketId, runEpoch: scope.runEpoch, envId: scope.envId,
        target: input.target, sessionId: input.sessionId, reason: safeReason,
        ...(input.url ? { url: input.url } : {}), ...(input.app ? { app: input.app } : {}), expiresAt,
      },
    }, context);
    this.#computerHandoffs.register({
      requestId: confirmation.id, ...(confirmation.cardId ? { cardId: confirmation.cardId } : {}),
      ticketId: scope.ticketId, runEpoch: scope.runEpoch, envId: scope.envId, tool: input.target,
      sessionId: input.sessionId, conversationId: scope.conversationId, originConversationId,
      reason: safeReason, ...(input.url ? { url: input.url } : {}), ...(input.app ? { app: input.app } : {}), expiresAt,
    }, async () => { await this.resolveComputerHandoff(scope.ticketId, "expired"); });
    // Silent park (`waiting.reason = "user"` WITHOUT `latestReport.state = "blocked"`) avoids duplicate coordinator card
    await this.harness.commit(async (tx) => {
      const live = (await tx.doc(KuloStateDoc)).tickets[scope.ticketId];
      if (!live || live.status !== "running" || live.runEpoch !== scope.runEpoch) return;
      live.waiting = {
        reason: "user", since: now, detail: safeReason,
        waitToken: `computer-handoff:${confirmation.cardId ?? confirmation.id}`,
        ...(confirmation.cardId ? { cardId: confirmation.cardId } : {}),
        requestId: confirmation.id,
        options: [
          { id: "confirm", label: "已完成，请继续", tone: "primary" },
          { id: "cancel", label: "跳过并停止", tone: "secondary" },
        ],
      };
      live.updatedAt = now;
    }, context);
    await this.#broadcastTickets(context);
    return { requestId: confirmation.id, ...(confirmation.cardId ? { cardId: confirmation.cardId } : {}), expiresAt };
  }

  async resolveComputerHandoff(
    ticketId: string,
    action: "done" | "cancel" | "expired",
    manualInstruction?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ ok: boolean; status: string }> {
    const active = this.#computerHandoffs.clear(ticketId);
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    const requestId = active?.requestId ?? ticket?.waiting?.requestId;
    const pending = requestId ? await this.actionConfirmations.getById(requestId, context) : undefined;
    const payload = pending?.payload.kind === "computer_handoff" ? pending.payload : undefined;
    const target = active?.tool ?? payload?.target ?? "browser";
    const reason = active?.reason ?? payload?.reason ?? "人工接管操作";
    if (pending && (pending.status === "pending" || pending.status === "pending_orchestrator")) {
      await this.actionConfirmations.resolveProgrammatically(pending.id, {
        status: action === "done" ? "approved" : "denied",
        selectedChoiceId: action === "done" ? "confirm" : "cancel",
        resultSummary: action === "done" ? "已完成人工接管" : action === "expired" ? "人工接管已超时" : "已跳过人工接管",
        markExecuted: true,
      }, context);
    }
    if (action !== "done") {
      // Immediately close preserved session to release MAX_BROWSER_SESSIONS slot
      const sessions = [...this.#computerSessions].filter(([, s]) => s.ticketId === ticketId);
      for (const [key, session] of sessions) {
        this.#computerSessions.delete(key);
        await this.envManager.requestComputerUse(session.envId, { tool: session.tool, action: "close", sessionId: session.sessionId }).catch(() => {});
      }
    }
    if (ticket && ticket.status === "waiting") {
      const prompt = formatComputerHandoffResumePrompt({ action, target, reason, manualInstruction });
      await this.steerTicket({
        ticketId,
        commandId: `computer-handoff:${requestId ?? ticketId}:${action}`,
        text: prompt,
      }, context).catch(() => {});
    }
    return { ok: true, status: action };
  }

  async #assertConnectionCaller(caller: ConnectionCaller, context: Context) {
    if (this.#closed) throw new Error("Kulo 正在关闭，连接授权已停止。");
    const state = await this.harness.snapshot(KuloStateDoc, context);
    if (caller.kind === "orchestrator") {
      if (isOrchestratorConversation(caller.conversationId as ConversationId, state)) {
        const topicId = state?.conversationToTopic?.[String(caller.conversationId)];
        if (topicId && state?.topics?.[topicId]?.deletedAt) throw new Error("会话已删除。");
        return { state, scope: undefined, isSettings: false };
      }
      const settings = await this.harness.snapshot(SettingsAssistantDoc, context);
      if (isActiveSettingsConversation(caller.conversationId, settings)) {
        return { state, scope: undefined, isSettings: true };
      }
      throw new Error("只有主模型可以管理连接权限。");
    }
    const scope = resolveTicketExecutionScope(state, caller.conversationId as ConversationId);
    if (!scope || scope.ticket.id !== caller.ticketId || scope.ticket.runEpoch !== caller.runEpoch ||
      scope.ticket.status !== "running" || scope.subagent && scope.subagent.state !== "running") throw new Error("任务的连接使用资格已失效。");
    if (!this.envManager.getEnvDescriptor(scope.ticket.envId)?.online) throw new Error("任务执行设备已离线。");
    if (scope.ticket.projectId && (await this.projects.get(scope.ticket.projectId, context)).grantRevision !== scope.ticket.grantRevision) throw new Error("项目授权已变化。");
    return { state, scope, isSettings: false };
  }

  async #connectionList(caller: ConnectionCaller, context: Context) {
    const { state, scope } = await this.#assertConnectionCaller(caller, context);
    const snapshot = await this.connectionManager.snapshot();
    const connections = snapshot.connections.map((entry) => {
      if (entry.kind !== "mcp") return entry;
      const { mcpTools, ...rest } = entry;
      const tools = mcpTools ?? [];
      return {
        ...rest,
        toolCount: tools.length,
        sampleTools: tools.slice(0, 12).map((t) => ({ name: t.name, readOnly: t.readOnly })),
      };
    });
    return {
      connections,
      applications: snapshot.applications,
      grantedConnectionIds: scope?.ticket.connectionIds ?? [],
      requests: snapshot.requests.filter((request) => caller.kind === "worker" ? request.ticketId === caller.ticketId :
        (state?.tickets[request.ticketId]?.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === caller.conversationId),
      vault: snapshot.vault,
    };
  }

  async #connectionDescribe(caller: ConnectionCaller, input: ConnectionDescribeRequest, context: Context) {
    const verified = await this.#assertConnectionCaller(caller, context);
    if (caller.kind !== "orchestrator") throw new Error("只有主模型可以整理连接卡片。");
    context.abortSignal?.throwIfAborted();
    if (verified.isSettings) {
      return this.settingsAssistant.describeConnection(input);
    }
    return this.connectionManager.describe(input);
  }

  async removeConnection(id: string): Promise<void> {
    const pending = (await this.connectionManager.snapshot()).requests.filter((request) => request.connectionId === id && request.status === "pending");
    await this.connectionManager.remove(id);
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      for (const ticket of Object.values(state.tickets)) if (ticket.connectionIds?.includes(id)) {
        ticket.connectionIds = ticket.connectionIds.filter((value) => value !== id);
        if (ticket.connectionRevisions) delete ticket.connectionRevisions[id];
      }
    }, BACKGROUND_CONTEXT);
    for (const request of pending) await this.#resumeConnectionDecision(request.id, false, BACKGROUND_CONTEXT);
  }

  async #recordTicketOutwardAction(
    ticketId: string,
    runEpoch: number | undefined,
    kind: TicketOutwardAction["kind"],
    label: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    await this.harness.commit(async (tx) => {
      const live = (await tx.doc(KuloStateDoc)).tickets[ticketId];
      if (!live || live.status === "closed" || live.status === "stopped") return;
      const targetEpoch = runEpoch ?? live.runEpoch;
      if (live.runEpoch !== targetEpoch) return;
      appendTicketOutwardAction(live, { runEpoch: targetEpoch, kind, label, at: Date.now() });
    }, withoutAbortSignal(context));
  }

  async #connectionUse(caller: ConnectionCaller, input: { connectionId: string; operation: ConnectionUseOperation }, context: Context) {
    const { scope } = await this.#assertConnectionCaller(caller, context);
    context.abortSignal?.throwIfAborted();
    if (caller.kind === "orchestrator") {
      const identity = `conversation:${caller.conversationId}`;
      await this.connectionManager.grant(identity, 0, [input.connectionId]);
      return this.connectionManager.use(identity, 0, input.connectionId, input.operation, { signal: context.abortSignal });
    }
    if (!scope!.ticket.connectionIds?.includes(input.connectionId)) throw new Error("尚未获得这个连接的使用权限，请向主模型申请。");
    const connection = (await this.connectionManager.snapshot()).connections.find((entry) => entry.id === input.connectionId);
    if (!connection || scope!.ticket.connectionRevisions?.[input.connectionId] !== connection.revision) throw new Error("连接已修改，请重新向主模型申请授权。");
    await this.#assertConnectionCaller(caller, context);
    if (!this.connectionManager.hasGrant(caller.ticketId, caller.runEpoch, input.connectionId)) {
      await this.connectionManager.grant(caller.ticketId, caller.runEpoch, [input.connectionId], scope!.ticket.connectionRevisions);
    }
    const result = await this.connectionManager.use(caller.ticketId, caller.runEpoch, input.connectionId, input.operation, {
      readOnly: scope!.readOnly,
      signal: context.abortSignal,
      assertActive: async () => { await this.#assertConnectionCaller(caller, context); },
      onOutwardAction: (label) => this.#recordTicketOutwardAction(caller.ticketId, caller.runEpoch, "connection", label, context),
    });
    await this.#assertConnectionCaller(caller, context);
    return result;
  }

  async #connectionRequest(caller: ConnectionCaller, input: { connectionId: string; reason: string; requestId: string }, context: Context) {
    if (caller.kind !== "worker") throw new Error("连接权限申请只能由 Worker 发起。");
    const { scope } = await this.#assertConnectionCaller(caller, context);
    const connection = (await this.connectionManager.snapshot()).connections.find((entry) => entry.id === input.connectionId);
    if (connection && scope!.ticket.connectionIds?.includes(input.connectionId) && scope!.ticket.connectionRevisions?.[input.connectionId] === connection.revision) return { status: "approved", connectionId: input.connectionId };
    const request = await this.connectionManager.requestAccess({ ticketId: caller.ticketId, conversationId: caller.conversationId,
      runEpoch: caller.runEpoch, connectionId: input.connectionId, reason: this.connectionManager.redact(input.reason),
      requestId: `${caller.ticketId}:${caller.runEpoch}:${input.requestId}` });
    if (request.status !== "pending") return request;
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const ticket = state.tickets[caller.ticketId];
      if (!ticket || ticket.runEpoch !== caller.runEpoch || ticket.status !== "running") throw new Error("任务已停止。");
      if (ticket.waiting && ticket.waiting.waitToken !== request.id) throw new Error("任务已有待处理事项。");
      ticket.waiting = { reason: "connection", since: Date.now(), detail: "等待主模型分配连接权限", waitToken: request.id };
      ticket.latestReport = { state: "progress", summary: "正在向主模型申请连接权限。", at: Date.now() };
      ticket.updatedAt = Date.now();
    }, context);
    return request;
  }

  async #relayConnectionRequest(ticketId: string): Promise<void> {
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const ticket = state?.tickets[ticketId];
    if (!ticket || ticket.status !== "waiting" || ticket.waiting?.reason !== "connection" || !ticket.waiting.waitToken) return;
    const request = await this.connectionManager.getRequest(ticket.waiting.waitToken);
    if (!request) return;
    if (request.status !== "pending") {
      await this.#resumeConnectionDecision(request.id, request.status === "approved", BACKGROUND_CONTEXT);
      return;
    }
    const origin = await this.harness.conversation((ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, BACKGROUND_CONTEXT);
    if (!origin) return;
    await this.harness.commit(async (tx) => {
      await injectEventToolsInTx(tx, origin.id, ["kulo_connections", "kulo_connection_decide", "kulo_connection_grant"]);
      return submitAutomaticChatInput(tx, origin, { type: "input", content: this.connectionManager.redact(formatConnectionRequestMessage(JSON.stringify({ requestId: request.id, ticketId, connectionId: request.connectionId, reason: request.reason }))),
        whenBusy: "followUp", requestId: `kulo:connection-request:${request.id}` });
    }, BACKGROUND_CONTEXT);
    await this.#broadcastTickets(BACKGROUND_CONTEXT);
  }

  async #resumeConnectionDecision(requestId: string, approved: boolean, context: Context) {
    const request = await this.connectionManager.getRequest(requestId);
    if (!request) throw new Error("连接权限申请不存在。");
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[request.ticketId];
    if (!ticket || !isTicketUnfinished(ticket) || ticket.waiting?.reason !== "connection" || ticket.waiting.waitToken !== request.id) return;
    await this.harness.commit(async (tx) => {
      const current = (await tx.doc(KuloStateDoc)).tickets[request.ticketId];
      if (current && isTicketUnfinished(current) && current.waiting?.waitToken === request.id) {
        if (approved) {
          current.connectionIds = [...new Set([...(current.connectionIds ?? []), request.connectionId])];
          const connection = (await this.connectionManager.snapshot()).connections.find((item) => item.id === request.connectionId);
          if (!connection) throw new Error("连接已取消。");
          current.connectionRevisions = { ...(current.connectionRevisions ?? {}), [request.connectionId]: connection.revision };
        }
        if (current.workerConversationId) {
          await injectEventToolsInTx(tx, current.workerConversationId, ["kulo_connections", "kulo_connection_use"]);
        }
      }
    }, context);
    return this.steerTicket({ ticketId: ticket.id, commandId: `connection-decision:${request.id}:${approved ? "approved" : "rejected"}`,
      text: approved ? `Connection access approved for ${request.connectionId}. Continue via kulo_connection_use; credentials remain handled by the execution layer.` :
        `Connection access denied for ${request.connectionId}. Continue within existing permissions or report what cannot be completed.` }, context);
  }

  async #connectionDecide(caller: ConnectionCaller, input: { requestId: string; decision: "approve" | "reject" }, context: Context) {
    if (caller.kind !== "orchestrator") throw new Error("只有主模型可以处理权限申请。");
    const { state } = await this.#assertConnectionCaller(caller, context);
    const request = await this.connectionManager.getRequest(input.requestId);
    const ticket = request ? state?.tickets[request.ticketId] : undefined;
    if (!request || !ticket || (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== caller.conversationId || !isTicketUnfinished(ticket)) throw new Error("这个权限申请不属于当前会话或任务已结束。");
    if (ticket.waiting?.waitToken !== request.id || ticket.waiting.reason !== "connection") {
      if (request.status !== "pending") return request;
      throw new Error("权限申请已失效。");
    }
    const result = await this.connectionManager.decide(request.id, input.decision === "approve");
    await this.#resumeConnectionDecision(request.id, result.status === "approved", context);
    return result;
  }

  async #connectionGrant(caller: ConnectionCaller, input: { ticketId: string; connectionIds: string[] }, context: Context) {
    if (caller.kind !== "orchestrator") throw new Error("只有主模型可以分配权限。");
    const { state } = await this.#assertConnectionCaller(caller, context);
    const ticket = state?.tickets[input.ticketId];
    if (!ticket || !isTicketUnfinished(ticket) || (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== caller.conversationId) throw new Error("任务不属于当前会话或已经结束。");
    await this.connectionManager.grant(ticket.id, ticket.runEpoch, input.connectionIds);
    const revisions = Object.fromEntries((await this.connectionManager.snapshot()).connections.filter((item) => input.connectionIds.includes(item.id)).map((item) => [item.id, item.revision]));
    await this.harness.commit(async (tx) => {
      const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
      if (!current || !isTicketUnfinished(current)) throw new Error("任务已结束。");
      current.connectionIds = [...new Set([...(current.connectionIds ?? []), ...input.connectionIds])];
      current.connectionRevisions = { ...(current.connectionRevisions ?? {}), ...revisions };
    }, context);
    const request = ticket.waiting?.reason === "connection" && ticket.waiting.waitToken ? await this.connectionManager.getRequest(ticket.waiting.waitToken) : undefined;
    if (request?.status === "pending" && input.connectionIds.includes(request.connectionId)) return this.#connectionDecide(caller, { requestId: request.id, decision: "approve" }, context);
    return { ticketId: ticket.id, connectionIds: [...new Set([...(ticket.connectionIds ?? []), ...input.connectionIds])] };
  }

  async getCapabilitiesSnapshot(clientId?: string): Promise<CapabilitiesWorkspaceSnapshot> {
    const [capabilities, skills, jobs, inputs, search, extensions, imageSetup] = await Promise.all([
      this.capabilities.snapshot(), this.skills.snapshot(), this.mediaJobs.list(), this.capabilities.listInputs(clientId), this.search.snapshot(),
      this.extensions.snapshot(clientId), this.imageConfiguration.workspace(clientId),
    ]);
    return { ...capabilities, skills: skills.skills, skillRevision: skills.revision, jobs, inputs, search, extensions, imageSetup };
  }

  async configureComputerUse(input: ComputerUseConfigurationInput): Promise<{ computerUse: ComputerUseSettings; revision: number }> {
    const result = await this.capabilities.configureComputerUse(input);
    const previous = this.#computerUseSettings;
    this.#computerUseSettings = { ...result.computerUse };
    if (previous.browserEnabled && !result.computerUse.browserEnabled) {
      for (const topicId of [...this.#orchestratorBrowserSessions.keys()]) {
        await this.#closeOrchestratorBrowserSession(topicId);
      }
    }
    await this.#reconfigureOrchestratorConversations(BACKGROUND_CONTEXT);
    await this.settingsAssistant.reconfigureActiveConversation(BACKGROUND_CONTEXT);
    await this.#reconfigureWorkerConversations(BACKGROUND_CONTEXT);
    return result;
  }

  async testImageCapability(id: string, input: { clientId: string; commandId: string; prompt?: string }): Promise<MediaJob> {
    const clientId = imageSetupIdentifier(input.clientId, "窗口标识");
    const commandId = imageSetupIdentifier(input.commandId, "操作标识");
    const source = await this.mediaSource(Number(this.rootConversation.id));
    return this.mediaJobs.create({ operationId: `image-test:${createHash("sha256").update(JSON.stringify([clientId, commandId])).digest("hex")}`, capabilityId: id,
      kind: "image", prompt: input.prompt?.trim() || DEFAULT_IMAGE_TEST_PROMPT, count: 1,
      source: { ...source, setupClientId: clientId } });
  }

  async #getContextKernel(): Promise<BillionKernelRuntime | null> {
    if (!this.#contextPackage) {
      this.#contextPackageLoad ??= this.extensions.loadPackage();
      try { this.#contextPackage = await this.#contextPackageLoad; }
      finally { this.#contextPackageLoad = null; }
    }
    return this.#contextPackage ? { version: this.#contextPackage.info.version, kernel: validateBillionKernel(this.#contextPackage.kernel) } : null;
  }

  async #mainConversationIds(includeDeleted = false): Promise<ConversationId[]> {
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    return [...new Set([Number(this.rootConversation.id), ...Object.values(state?.topics ?? {})
      .filter((topic) => includeDeleted || topic.deletedAt === undefined).map((topic) => topic.conversationId)])] as ConversationId[];
  }

  #alignContextCompaction(conversationId: ConversationId, context: Context): Promise<void> {
    if (!this.#contextEnabled) return Promise.resolve();
    const update: Promise<void> = (async () => {
      const current = await this.harness.snapshot(ContextCompactionDoc, conversationId, context);
      if (!this.#contextEnabled || current?.enabled) return;
      await this.#contextCompaction.setEnabled(conversationId, true, context);
      if (!this.#contextEnabled) await this.#contextCompaction.setEnabled(conversationId, false, context);
    })().finally(() => this.#contextPreferenceUpdates.delete(update));
    this.#contextPreferenceUpdates.add(update);
    return update;
  }

  async #enableContextExtension(): Promise<void> {
    try {
      if (!await this.#getContextKernel()) throw new Error("请先安装 Billion Context 上下文压缩。");
      this.#contextEnabled = true;
      for (const id of await this.#mainConversationIds()) await this.#contextCompaction.setEnabled(id, true);
    } catch (error) {
      await this.#stopContextExtension();
      throw error;
    }
  }

  async #stopContextExtension(): Promise<void> {
    this.#contextEnabled = false;
    // Each caller owns its update failure. Even a cancelled topic request must finish before the
    // independent stop below reconciles every preference and releases the shared kernel.
    await Promise.allSettled(this.#contextPreferenceUpdates);
    // A running compaction keeps its reviewed kernel until the native-readable checkpoint is placed.
    // Deleted topics retain their transcript and can still own a checkpoint that is finishing placement.
    for (const id of await this.#mainConversationIds(true)) await this.#contextCompaction.setEnabled(id, false);
    const loaded = this.#contextPackage;
    this.#contextPackage = null;
    if (loaded) await loaded.close();
  }

  async #broadcastCapabilities(): Promise<void> {
    if (this.#closed) return;
    const snapshot = await this.getCapabilitiesSnapshot();
    const nextSearchAvailable = Boolean(snapshot.search?.plans.some((plan) => plan.enabled && plan.status !== "needs_auth"));
    if (nextSearchAvailable !== this.#webSearchAvailable) {
      this.#webSearchAvailable = nextSearchAvailable;
      await this.#reconfigureOrchestratorConversations(BACKGROUND_CONTEXT);
      await this.settingsAssistant.reconfigureActiveConversation(BACKGROUND_CONTEXT);
      await this.#reconfigureWorkerConversations(BACKGROUND_CONTEXT);
    }
    for (const listener of this.#listeners) listener.onCapabilities?.(snapshot);
  }

  async #broadcastVoice(): Promise<void> {
    if (this.#closed) return;
    const snapshot = await this.voice.snapshot();
    if (snapshot.tts.enabled !== this.#ttsEnabled) {
      this.#ttsEnabled = snapshot.tts.enabled;
      await this.#reconfigureOrchestratorConversations(BACKGROUND_CONTEXT);
      await this.settingsAssistant.reconfigureActiveConversation(BACKGROUND_CONTEXT);
      await this.#reconfigureWorkerConversations(BACKGROUND_CONTEXT);
    }
    for (const listener of this.#listeners) listener.onVoice?.(snapshot);
  }

  async #voiceTopic(topicId: string) {
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const topic = state?.topics && Object.hasOwn(state.topics, topicId) ? state.topics[topicId] : undefined;
    if (!topic || topic.deletedAt) throw new VoiceError(404, "voice_topic_not_found", "通话所属会话不存在或已删除。");
    if (topic.projectId) await this.projects.ensureAuthorized(topic.projectId, BACKGROUND_CONTEXT);
    return this.#resolveWatchedTopic(topicId, BACKGROUND_CONTEXT);
  }

  async #recordVoiceTranscript(topicId: string, event: Extract<VoiceCallEvent, { type: "transcript" }>, callId: string): Promise<void> {
    if (!event.final || !event.text.trim() || this.#closed) return;
    const cache = await this.#voiceTopic(topicId);
    const text = event.role === "user" ? (await this.connectionManager.processText(event.text)).text : this.connectionManager.redact(event.text);
    const createdAt = Date.now();
    await cache.conversation.submit({ type: "write", entry: { kind: VoiceTranscriptEntry.kind,
      data: { callId, role: event.role, text, createdAt },
      model: [{ role: "user", content: `[KULO_VOICE_CONTEXT: ${event.role === "user" ? "用户" : "Kulo"}在通话中说]\n${text}`, timestamp: createdAt }] },
      ...(event.id ? { requestId: `voice-transcript:${callId}:${event.role}:${event.id}` } : {}) }, BACKGROUND_CONTEXT);
    this.#refreshTopicContent(cache);
    const preview = summarizeTopicPreview([{ role: event.role, text, createdAt }]);
    if (preview) this.#recordTopicActivity(cache.topicId, preview);
  }

  async transcribeVoiceAsset(assetId: string, options: { topicId?: string; principalId: string }, context: Context = BACKGROUND_CONTEXT): Promise<ChatAttachment> {
    const cache = await this.#voiceTopic(options.topicId || "root");
    const loaded = this.uploads.getUpload(assetId);
    if (!loaded || loaded.record.kind !== "audio") throw new VoiceError(404, "voice_asset_not_found", "语音资源不存在。");
    if (!this.uploads.canReadUpload(assetId, options.principalId, (scope) => scope === `conversation:${Number(cache.conversation.id)}`)) throw new VoiceError(403, "voice_asset_forbidden", "无权读取这段语音。");
    if (loaded.record.transcript?.text && loaded.record.transcript.status !== "failed") return this.uploads.toChatAttachment(loaded.record);
    if (!(await this.voice.snapshot()).asr.enabled) throw new VoiceError(409, "voice_asr_disabled", "请先开启语音转文本。");
    const existing = this.#voiceTranscriptions.get(assetId);
    if (existing) return existing;
    const job = (async () => {
      context.abortSignal?.throwIfAborted();
      const recognized = await this.voice.transcribe(loaded.filePath, context.abortSignal);
      const text = (await this.connectionManager.processText(recognized)).text;
      const attachment = this.uploads.saveTranscript(assetId, { text, status: "ready" });
      for (const current of this.#topicCaches.values()) this.#refreshTopicContent(current);
      return attachment;
    })();
    this.#voiceTranscriptions.set(assetId, job);
    try { return await job; } finally { this.#voiceTranscriptions.delete(assetId); }
  }

  async skillAudience(conversationId: number): Promise<SkillAudience> {
    const assistant = await this.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    if (isActiveSettingsConversation(conversationId, assistant)) return "settings";
    const source = await this.mediaSource(conversationId);
    return source.ticketId ? "worker" : "chat";
  }

  async mediaSource(conversationId: number): Promise<MediaJobSource> {
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    if (isOrchestratorConversation(conversationId as ConversationId, state)) {
      const topicId = state?.conversationToTopic?.[String(conversationId)] ?? "root";
      const topic = state?.topics?.[topicId];
      if (!topic || topic.deletedAt) throw new Error("会话已删除。");
      return { conversationId, topicId, ...(topic.projectId ? { projectId: topic.projectId } : {}) };
    }
    const settings = await this.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    if (isActiveSettingsConversation(conversationId, settings)) {
      return { conversationId, topicId: settingsTopicId(conversationId) };
    }
    const scope = resolveTicketExecutionScope(state, conversationId as ConversationId);
    if (!scope || scope.ticket.status !== "running") throw new Error("当前任务没有有效执行资格。");
    return { conversationId, topicId: scope.ticket.originTopicId ?? "root", ticketId: scope.ticket.id,
      ...(scope.ticket.projectId ? { projectId: scope.ticket.projectId } : {}), envId: scope.ticket.envId,
      runEpoch: scope.ticket.runEpoch, readOnly: scope.readOnly };
  }

  async #resolveAndroidInput(scope: AndroidToolScope & { deviceId: string }, action: import("@kulo/protocol").AndroidAction, args: Record<string, unknown>) {
    if (action !== "audio_transcribe" || args.audioRef === undefined && args.filePath === undefined) return args;
    if (args.captureId !== undefined) throw new Error("文件转写和实时录音引用不能同时提供。");
    const ids = new Set<string>();
    const reference = (value: unknown) => {
      if (typeof value !== "string") throw new Error("音频附件引用无效。");
      const id = value.startsWith("kulo-asset:") ? value.slice("kulo-asset:".length)
        : value.startsWith("/api/uploads/") ? value.slice("/api/uploads/".length) : value;
      if (!/^att_[a-z0-9_]{6,48}$/.test(id)) throw new Error("只能使用当前任务的Hub音频附件，不能访问文件路径或外部URL。");
      ids.add(id);
    };
    const ref = args.audioRef as Record<string, unknown> | undefined;
    for (const item of [ref, ref?.asset as Record<string, unknown> | undefined]) {
      if (!item) continue;
      for (const key of ["id", "resourceId", "attachmentId", "uri", "url"]) if (item[key] !== undefined) reference(item[key]);
    }
    if (args.filePath !== undefined) reference(args.filePath);
    if (ids.size !== 1) throw new Error("需要一个明确且一致的音频附件引用。");
    const id = [...ids][0]!;
    await scope.assertActive();
    const source = await this.mediaSource(scope.conversationId);
    if (source.ticketId !== scope.ticketId || source.runEpoch !== scope.runEpoch) throw new Error("音频附件所属任务已失效。");
    await this.#validateMediaInput(id, source);
    const loaded = this.uploads.getUpload(id);
    if (!loaded || loaded.record.kind !== "audio") throw new Error("只能转写当前任务有权访问的音频附件。");
    const record = loaded.record;
    const uri = `/api/uploads/${id}`;
    const sha256 = record.sha256 ?? createHash("sha256").update(this.uploads.readUploadBytes(loaded)).digest("hex");
    const { filePath: _path, audioRef: _ref, ...rest } = args;
    await scope.assertActive();
    return { ...rest, audioRef: { id, resourceId: id, uri, url: uri, name: record.name, mimeType: record.mimeType,
      bytes: record.size, size: record.size, kind: record.kind, sha256 } };
  }

  async #resolveAndroidAssets(scope: AndroidToolScope & { deviceId: string; supportsImages: boolean }, result: import("@kulo/protocol").AndroidResult) {
    const output: Array<import("@earendil-works/pi-ai").ImageContent> = [];
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) return output;
    const data = result.data as Record<string, unknown>;
    const assets = [...(data.attachment ? [data.attachment] : []), ...(Array.isArray(data.attachments) ? data.attachments : [])];
    if (assets.length > 8) throw new Error("手机返回的资源数量过多。");
    await scope.assertActive();
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const ticket = state?.tickets[scope.ticketId];
    if (!ticket || ticket.runEpoch !== scope.runEpoch) throw new Error("手机资源所属任务已失效。");
    for (const asset of assets) {
      if (!asset || typeof asset !== "object" || !("id" in asset) || typeof asset.id !== "string") throw new Error("手机资源引用无效。");
      const loaded = this.uploads.getUpload(asset.id);
      if (!loaded || loaded.record.ownerId !== scope.deviceId) throw new Error("手机资源不属于本次操作的目标设备。");
      for (const id of new Set([scope.conversationId, ticket.workerConversationId])) {
        this.uploads.bindAttachments([asset.id], `conversation:${id}`, loaded.record.ownerId);
      }
      this.uploads.bindAttachments([asset.id], `ticket:${ticket.id}`, loaded.record.ownerId);
      if (data.ephemeralObservation !== true) {
        await this.#stageWorkerArtifact(this.uploads.toChatAttachment(loaded.record), {
          conversationId: scope.conversationId, topicId: ticket.originTopicId ?? "root", ticketId: ticket.id, runEpoch: ticket.runEpoch, envId: scope.deviceId,
        }, `android-result:${asset.id}`);
      }
      if (loaded.record.kind === "image" && scope.supportsImages) {
        if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(loaded.record.mimeType)) throw new Error("手机图片格式不受支持。");
        output.push({ type: "image", mimeType: loaded.record.mimeType, data: fs.readFileSync(loaded.filePath).toString("base64") });
      }
    }
    await scope.assertActive();
    return output;
  }

  #androidTargets(ticket: Readonly<TicketRecord>): string[] {
    return ticket.androidDeviceIds ?? (ticket.executionDomain === "android" ? [ticket.envId] : []);
  }

  #ticketDevicesOnline(ticket: Readonly<TicketRecord>): boolean {
    return Boolean(this.envManager.getEnvDescriptor(ticket.envId)?.online) &&
      this.#androidTargets(ticket).every((id) => {
        const device = this.envManager.getEnvDescriptor(id);
        return device?.online && device.executionKind === "native-device" && device.android?.enabled && !device.android.paused;
      });
  }

  #surfaceRuntimeState(
    audience: ToolSurfaceAudience,
    extra: Partial<Omit<ToolSurfaceRuntimeState, "audience">> = {},
  ): ToolSurfaceRuntimeState {
    const sharedMemoryEnabled =
      this.#liveSettings.memory.enabled && this.#liveSettings.memory.accessMode !== "private-only";
    const deviceView = this.#deviceController?.view();
    return {
      audience,
      memoryEnabled: this.#liveSettings.memory.enabled,
      sharedMemoryEnabled,
      ttsEnabled: this.#ttsEnabled,
      webSearchAvailable: this.#webSearchAvailable,
      customizationEnabled: Boolean(this.config.customization),
      deviceInviteAvailable: deviceView?.role === "hub",
      computerUseBrowserEnabled: this.#computerUseSettings.browserEnabled,
      computerUseDesktopEnabled: this.#computerUseSettings.desktopEnabled,
      hasStagedDeviceJoin: Boolean(this.deviceJoinStaging.hasActive),
      assistantActive: this.#assistantActive,
      ...extra,
    };
  }

  #resolveExtensionsTools(
    extensions: readonly ReturnType<typeof defineExtension>[],
    state: ToolSurfaceRuntimeState,
  ): ToolRegistration[] {
    assertUniqueExtensionTools(extensions);
    const available = extensions.flatMap((ext) => ext.tools ?? []);
    return resolveSurfaceTools(available, state);
  }

  #orchestratorExtensions(isRoot: boolean): ReturnType<typeof defineExtension>[] {
    return [
      this.#redactionExt,
      this.#orchestratorExt,
      this.#codingToolsExt,
      this.#orchestratorGuardExt,
      this.#computerUseExt,
      this.#toolSearchExt,
      this.#contentExt,
      this.#projectExt,
      this.#skillExt,
      this.#orchestratorTailExt,
      this.#mediaExt,
      this.#voiceExt,
      ...(isRoot ? [this.#memoryServiceExt] : []),
      this.#memorySetupExt,
      this.#historyExt,
      this.#assistantToolsExt,
      this.#globalSettingsExt,
      ...this.#customizationExtensions,
      this.#contextCompaction.extension,
    ];
  }

  #orchestratorTools(isRoot: boolean): ToolRegistration[] {
    const extensions = this.#orchestratorExtensions(isRoot);
    return this.#resolveExtensionsTools(extensions, this.#surfaceRuntimeState("chat", { isRootTopic: isRoot }));
  }

  #workerExtensions(
    executionDomain: "computer" | "android" | undefined,
    androidTargetIds: readonly string[],
  ): ReturnType<typeof defineExtension>[] {
    if (executionDomain === "android") {
      return [this.#redactionExt, this.#androidExt, this.#toolSearchExt, this.#workerExt, this.#contentExt, this.#skillExt, this.#contextCompaction.extension];
    }
    return [
      this.#redactionExt,
      this.#codingToolsExt,
      this.#computerUseExt,
      this.#toolSearchExt,
      this.#workerExt,
      this.#contentExt,
      this.#skillExt,
      this.#mediaExt,
      this.#voiceExt,
      this.#mediaExportExt,
      this.#memoryLifecycleExt,
      ...(androidTargetIds.length ? [this.#androidExt, this.#computerMixedAndroidTierExt] : []),
      this.#contextCompaction.extension,
    ];
  }

  #workerTools(options: {
    executionDomain: "computer" | "android" | undefined;
    androidTargetIds: readonly string[];
    allowSubagents: boolean;
    isSubagent?: boolean;
    readOnly?: boolean;
  }): { extensions: ReturnType<typeof defineExtension>[]; tools: ToolRegistration[] } {
    const extensions = this.#workerExtensions(options.executionDomain, options.androidTargetIds);
    const audience: ToolSurfaceAudience =
      options.executionDomain === "android"
        ? options.isSubagent
          ? "android-subagent"
          : "android-worker"
        : options.isSubagent
          ? "computer-subagent"
          : "computer-worker";
    const androidTargets = options.androidTargetIds
      .map((id) => this.envManager.getEnvDescriptor(id))
      .filter((desc): desc is EnvNodeDescriptor => Boolean(desc));
    const tools = this.#resolveExtensionsTools(
      extensions,
      this.#surfaceRuntimeState(audience, {
        allowSubagents: options.allowSubagents,
        readOnly: options.readOnly,
        androidTargets,
      }),
    );
    return { extensions, tools };
  }

  setAndroidHubIdentity(hubId: string): void {
    if (!hubId || hubId.length > 256 || /[\u0000-\u001f]/.test(hubId) || this.#androidHubId && this.#androidHubId !== hubId) {
      throw new Error("手机执行入口的主脑身份无效或已变化。");
    }
    this.#androidHubId = hubId;
    this.envManager.setHubId(hubId);
  }

  async #validateMediaInput(assetId: string, source: MediaJobSource): Promise<void> {
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const scopes = new Set([`conversation:${source.conversationId}`]);
    if (source.ticketId) {
      const ticket = state?.tickets[source.ticketId];
      if (!ticket || ["stopped", "closed"].includes(ticket.status)) throw new Error("任务执行资格已失效。");
      scopes.add(`conversation:${ticket.workerConversationId}`);
      if (ticket.originConversationId !== undefined) scopes.add(`conversation:${ticket.originConversationId}`);
    }
    if (!this.uploads.canReadUpload(assetId, `agent:${source.conversationId}`, (scope) => scopes.has(scope))) throw new Error("无权使用此参考素材。");
  }

  async #validateMediaSource(source: MediaJobSource, job?: MediaJob): Promise<void> {
    if (source.setupClientId) {
      imageSetupIdentifier(source.setupClientId, "窗口标识");
      if (source.conversationId !== Number(this.rootConversation.id) || source.topicId !== "root" || source.ticketId) throw new Error("图像测试来源无效。");
    }
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const settingsConvId = parseSettingsTopicConversationId(source.topicId);
    if (settingsConvId !== null) {
      const settings = await this.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (!isActiveSettingsConversation(settingsConvId, settings)) throw new Error("生成来源会话已删除。");
      if (!source.ticketId) {
        if (settingsConvId !== source.conversationId) throw new Error("生成来源无效。");
        return;
      }
    } else {
      const topic = state?.topics?.[source.topicId];
      if (!topic || topic.deletedAt) throw new Error("生成来源会话已删除。");
      if (!source.ticketId) {
        if (Number(topic.conversationId) !== source.conversationId) throw new Error("生成来源无效。");
        return;
      }
    }
    const ticket = state?.tickets[source.ticketId];
    if (!ticket || !isTicketUnfinished(ticket) || (ticket.originTopicId ?? "root") !== source.topicId) throw new Error("生成所属任务已停止或关闭。");
    const live = ticket.status === "running" && ticket.runEpoch === source.runEpoch;
    // Login or review changes the wait reason, while the original media association remains valid.
    const waiting = !!job && ["running", "pausing", "waiting"].includes(ticket.status) &&
      (ticket.waiting?.reason === "external" || ticket.waiting?.reason === "user") && ticket.waiting.externalJobIds?.includes(job.id);
    if (!live && !waiting) throw new Error("生成所属任务的执行资格已失效。");
    if (ticket.projectId) {
      const project = await this.projects.get(ticket.projectId);
      if (project.grantRevision !== ticket.grantRevision) throw new Error("项目授权已变化，请重新确认任务。");
    }
  }

  async #mediaSettled(job: MediaJob): Promise<void> {
    if (job.source.setupClientId) return;
    const needsUser = job.status === "needs_user" || job.status === "needs_reconciliation";
    const message = `媒体作业${needsUser ? "需要处理" : job.status === "stopped" ? "已停止跟踪" : "失败"}：${job.error ?? job.id}`;
    const noticeKey = `${job.id}:${job.status}:${job.updatedAt}`;
    let wakeTicket: string | undefined;
    const snapshot = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const settingsSnapshot = await this.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const settingsConvId = parseSettingsTopicConversationId(job.source.topicId);
    const recipientId = settingsConvId ?? snapshot?.topics?.[job.source.topicId]?.conversationId;
    const recipient = job.source.ticketId && recipientId !== undefined ? await this.harness.conversation(recipientId as ConversationId, BACKGROUND_CONTEXT) : undefined;
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const settingsDoc = await tx.doc(SettingsAssistantDoc);
      const notices = await tx.doc(MediaNoticesDoc);
      if (notices.notices[noticeKey]) return;
      const topic = state.topics?.[job.source.topicId];
      const targetConvId = settingsConvId !== null
        ? (isActiveSettingsConversation(settingsConvId, settingsDoc) ? settingsConvId : undefined)
        : (!topic || topic.deletedAt ? undefined : Number(topic.conversationId));
      const ticket = job.source.ticketId ? state.tickets[job.source.ticketId] : undefined;
      notices.notices[noticeKey] = true;
      if (targetConvId === undefined || job.source.ticketId && (!ticket || ["stopped", "closed"].includes(ticket.status))) return;
      if (!ticket) {
        const now = Date.now();
        await tx.appendEntry(ContentPublicationEntry, targetConvId as ConversationId, { data: { parts: [{ partId: `media-notice:${noticeKey}`, type: "markdown", text: message }], fallbackText: message, createdAt: now } as unknown as ContentPublicationData & JsonObject });
        if (settingsConvId === null && topic && !topic.deletedAt) {
          applyTopicPreview(topic, summarizeTopicPreview([{ role: "assistant", text: message, createdAt: now }]), now);
        }
      } else if (needsUser && recipient?.id === targetConvId) {
        await submitAutomaticChatInput(tx, recipient, { type: "input", whenBusy: "followUp", requestId: `kulo:media-review:${noticeKey}`,
          content: `[KULO_WORKER_RELAY]\nBackground media job requires coordinator attention: ${message}\nVerify the actual issue first before deciding whether to inform the user; this notice grants no extra execution permissions.`,
          entry: { kind: WorkerRelayEntry.kind, data: { ticketId: ticket.id, title: ticket.title, role: ticket.role, state: "blocked", summary: message, deliverable: null, question: message } },
        });
      }
      if ((ticket?.waiting?.reason === "external" || ticket?.waiting?.reason === "user") && ticket.waiting.externalJobIds?.includes(job.id)) {
        if (needsUser) {
          ticket.waiting.reason = "user";
          ticket.waiting.detail = message;
          ticket.latestReport = { state: "blocked", summary: message, question: message, at: Date.now() };
        } else {
          ticket.waiting.externalJobIds = ticket.waiting.externalJobIds.filter((id) => id !== job.id);
          ticket.wakePending = true;
          ticket.resumePrompt = [ticket.resumePrompt, message, "Inspect the original job via kulo_media_job rather than resubmitting a paid generation."].filter(Boolean).join("\n");
          wakeTicket = ticket.id;
        }
      }
    }, BACKGROUND_CONTEXT);
    const cache = this.#topicCaches.get(job.source.topicId);
    if (cache) await this.#refreshTopicContent(cache);
    if (settingsConvId !== null && isActiveSettingsConversation(settingsConvId, settingsSnapshot)) {
      await this.settingsAssistant.refreshIfConversation(settingsConvId);
    }
    if (wakeTicket && !this.#recovering) { await this.#queueWaitReconcile(); await this.#resumeWaitingTicket(wakeTicket, BACKGROUND_CONTEXT); }
    await this.#broadcastTickets(BACKGROUND_CONTEXT);
  }

  async #mediaCompleted(job: MediaJob): Promise<void> {
    if (job.source.setupClientId) { await this.mediaJobs.markDelivered(job.id); return; }
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const settingsDoc = await this.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const settingsConvId = parseSettingsTopicConversationId(job.source.topicId);
    const topic = state?.topics?.[job.source.topicId];
    const targetConvId = settingsConvId !== null
      ? (isActiveSettingsConversation(settingsConvId, settingsDoc) ? settingsConvId : undefined)
      : (!topic || topic.deletedAt ? undefined : Number(topic.conversationId));
    const ticket = job.source.ticketId ? state?.tickets[job.source.ticketId] : undefined;
    if (targetConvId === undefined || (job.source.ticketId && (!ticket || ["stopped", "closed"].includes(ticket.status)))) {
      await this.mediaJobs.markDelivered(job.id);
      return;
    }
    const conversationId = targetConvId;
    for (const asset of job.assets) {
      if (ticket) {
        await this.#stageWorkerArtifact(asset, job.source, `media-result:${job.id}:${asset.id}`);
        continue;
      }
      this.uploads.bindAttachments([asset], `conversation:${conversationId}`, `agent:${job.source.conversationId}`,
        (scope) => scope === `conversation:${job.source.conversationId}`);
      await this.uiCards.publishAsset({ path: `media-job:${job.id}:${asset.id}`, name: asset.name },
        { conversationId, callId: `media-result:${job.id}:${asset.id}`, topicId: job.source.topicId }, async () => asset);
    }
    const cache = this.#topicCaches.get(job.source.topicId);
    if (cache) await this.#refreshTopicContent(cache);
    if (settingsConvId !== null) await this.settingsAssistant.refreshIfConversation(settingsConvId);
    if (ticket) {
      await this.harness.commit(async (tx) => {
        const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
        if (!current || ["stopped", "closed"].includes(current.status) ||
          !(current.waiting?.reason === "external" || current.waiting?.reason === "user") || !current.waiting.externalJobIds?.includes(job.id)) return;
        current.waiting.externalJobIds = current.waiting.externalJobIds.filter((id) => id !== job.id);
        current.wakePending = true;
        current.resumeAttachmentIds = [...new Set([...(current.resumeAttachmentIds ?? []), ...job.assets.map((asset) => asset.id)])];
        current.resumePrompt = [current.resumePrompt, `Media job ${job.id} completed with asset(s): ${job.assets.map((asset) => asset.id).join(", ")}. Assets are staged privately (not yet published to the user)—reuse them and submit via kulo_report for coordinator review (use kulo_media_export to write into the project workspace; do not regenerate).`].filter(Boolean).join("\n");
        await injectEventToolsInTx(
          tx,
          current.workerConversationId,
          current.readOnly ? ["kulo_publish_asset"] : ["kulo_media_export", "kulo_publish_asset"],
        );
      }, BACKGROUND_CONTEXT);
      if (!this.#recovering) { await this.#queueWaitReconcile(); await this.#resumeWaitingTicket(ticket.id, BACKGROUND_CONTEXT); }
    }
    await this.mediaJobs.markDelivered(job.id);
  }

  async #stageWorkerArtifact(asset: ChatAttachment, source: MediaJobSource, callId: string): Promise<void> {
    if (!source.ticketId) throw new UiCardError("content_scope_denied", "产物缺少 Worker 任务归属。", 403);
    const snapshot = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const settingsSnapshot = await this.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const ticket = snapshot?.tickets[source.ticketId];
    const settingsConvId = parseSettingsTopicConversationId(source.topicId);
    const topicValid = settingsConvId !== null
      ? isActiveSettingsConversation(settingsConvId, settingsSnapshot)
      : Boolean(snapshot?.topics?.[source.topicId] && !snapshot.topics[source.topicId]!.deletedAt);
    if (!ticket || ["stopped", "closed"].includes(ticket.status) || !topicValid || (ticket.originTopicId ?? "root") !== source.topicId) throw new UiCardError("content_scope_denied", "产物所属任务或聊天已失效。", 403);
    await this.uiCards.stageAsset({ path: `worker-asset:${asset.id}`, name: asset.name },
      { conversationId: ticket.workerConversationId, callId, ticketId: ticket.id, topicId: source.topicId }, async () => asset,
      async (tx, staged) => {
        const state = await tx.doc(KuloStateDoc);
        const settingsDoc = await tx.doc(SettingsAssistantDoc);
        const current = state.tickets[ticket.id];
        const originValid = settingsConvId !== null
          ? isActiveSettingsConversation(settingsConvId, settingsDoc)
          : Boolean(state.topics?.[source.topicId] && !state.topics[source.topicId]!.deletedAt);
        if (!current || ["stopped", "closed"].includes(current.status) || !originValid || current.workerConversationId !== ticket.workerConversationId || current.runEpoch !== ticket.runEpoch || (current.originTopicId ?? "root") !== source.topicId) throw new UiCardError("content_scope_denied", "产物所属任务已变更。", 403);
        this.uploads.bindAttachments([staged], `conversation:${current.workerConversationId}`, `agent:${source.conversationId}`, (scope) => scope === `conversation:${source.conversationId}`);
        this.uploads.bindAttachments([staged], `ticket:${current.id}`, `agent:${source.conversationId}`, (scope) => scope === `conversation:${source.conversationId}`);
        state.workerArtifacts ??= {};
        const artifacts = state.workerArtifacts[current.id] ?? [];
        if (!artifacts.some((entry) => entry.id === staged.id)) state.workerArtifacts[current.id] = [...artifacts, staged];
        const originConvId = settingsConvId ?? state.topics?.[source.topicId]?.conversationId ?? Number(ROOT_CONVERSATION_ID);
        await injectEventToolsInTx(tx, originConvId, ["kulo_inspect_asset", "kulo_publish_asset"]);
      });
  }

  getSettingsView(): KuloSettingsView {
    return toPublicSettingsView(this.#liveSettings, this.#defaultIdentityDir);
  }

  async #broadcastProjects(): Promise<void> {
    if (this.#closed) return;
    const [projects, topics] = await Promise.all([this.projects.list(), this.listTopics()]);
    for (const listener of this.#listeners) listener.onProjects?.(projects);
    this.#emitTopics(topics);
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    for (const [id, cache] of this.#topicCaches) {
      if (!state?.topics?.[id]?.deletedAt) continue;
      await this.#closeOrchestratorBrowserSession(id);
      await cache.conversation.abort(BACKGROUND_CONTEXT, { background: true });
      await cache.watch.stop();
      this.#topicCaches.delete(id);
    }
  }

  #queueWaitReconcile(): Promise<void> {
    this.#waitTransition = this.#waitTransition.then(async () => {
      if (this.#closed) return;
      let state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      // A result can arrive before the Worker commits its wait; recover that edge from durable job state.
      for (const ticket of Object.values(state?.tickets ?? {})) {
        if (!(ticket.waiting?.reason === "external" || ticket.waiting?.reason === "user") || !isTicketUnfinished(ticket)) continue;
        for (const id of ticket.waiting.externalJobIds ?? []) {
          const job = await this.mediaJobs.get(id);
          if (!["completed", "failed", "stopped", "needs_user", "needs_reconciliation"].includes(job.status)) continue;
          await this.harness.commit(async (tx) => {
            const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
            if (!current || !isTicketUnfinished(current) ||
              !(current.waiting?.reason === "external" || current.waiting?.reason === "user") || !current.waiting.externalJobIds?.includes(id)) return;
            if (["needs_user", "needs_reconciliation"].includes(job.status)) {
              current.waiting.reason = "user";
              current.waiting.detail = job.error ?? "媒体作业需要处理。";
              current.latestReport = { state: "blocked", summary: current.waiting.detail, question: current.waiting.detail, at: Date.now() };
            } else {
              current.waiting.externalJobIds = current.waiting.externalJobIds.filter((item) => item !== id);
              current.wakePending = true;
              current.resumePrompt = [current.resumePrompt, `媒体作业 ${id} 的状态为 ${job.status}，使用原作业结果，不要重新提交。`].filter(Boolean).join("\n");
              current.resumeAttachmentIds = [...new Set([...(current.resumeAttachmentIds ?? []), ...job.assets.map((asset) => asset.id)])];
            }
          }, BACKGROUND_CONTEXT);
        }
      }
      state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      for (const ticket of Object.values(state?.tickets ?? {})) {
        if (ticket.status !== "running" && ticket.status !== "pausing") continue;
        const waiting = ticket.waiting ?? (ticket.latestReport?.state === "blocked"
          ? { reason: "coordinator" as const, since: Date.now(), detail: ticket.latestReport.question ?? ticket.latestReport.summary } : undefined);
        if (waiting) await this.#parkTicket(ticket.id, waiting);
      }
      if (!this.#recovering) {
        const after = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        for (const ticket of Object.values(after?.tickets ?? {})) if (ticket.status === "waiting" && ticket.wakePending) await this.#resumeWaitingTicket(ticket.id, BACKGROUND_CONTEXT);
      }
      const connections = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      for (const ticket of Object.values(connections?.tickets ?? {})) {
        if (ticket.status === "waiting" && ticket.waiting?.reason === "connection") await this.#relayConnectionRequest(ticket.id);
        if (ticket.status === "waiting" && ticket.waiting?.reason === "coordinator" && ticket.waiting.waitToken?.startsWith("host-action-req:")) {
          await this.#relayHostActionRequest(ticket.id);
        }
      }
    }).catch((error) => { console.error("[KuloWaitReconcile]", error); });
    return this.#waitTransition;
  }

  #queueEnvReconcile(): Promise<void> {
    this.#envTransition = this.#envTransition.then(async () => {
      if (this.#closed) return;
      const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      for (const ticket of Object.values(state?.tickets ?? {})) {
        if (!isTicketUnfinished(ticket)) continue;
        const online = this.#ticketDevicesOnline(ticket);
        if (ticket.externalExecution && ticket.status === "running") continue;
        if (!online && ["running", "queued", "pausing"].includes(ticket.status)) {
          await this.#parkTicket(ticket.id, { reason: "env", since: Date.now(), detail: "等待执行设备上线" });
        }
      }
      for (const env of this.envManager.listEnvs()) {
        if (!env.online) continue;
        try { if (env.executionKind !== "native-device") await this.projects.reconcileDevice(env.id); }
        catch (error) { console.error(`[KuloProjects:reconcile:${env.id}]`, error); }
        const current = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        for (const ticket of Object.values(current?.tickets ?? {})) {
          if ((ticket.envId !== env.id && !this.#androidTargets(ticket).includes(env.id)) || !ticket.cleanupPending || current?.slots.holders.includes(ticket.id)) continue;
          const cleanup = await this.#releaseTicketExecution(ticket, { park: Boolean(ticket.waiting) && isTicketUnfinished(ticket) });
          await this.harness.commit(async (tx) => {
            const next = await tx.doc(KuloStateDoc);
            const t = next.tickets[ticket.id];
            if (!t || t.runEpoch !== ticket.runEpoch) return;
            t.cleanupPending = cleanup.cleanupPending;
            if (
              !cleanup.cleanupPending &&
              (t.status === "stopped" || t.status === "closed" || (t.status === "ready" && !hasPendingWorkspaceApply(t)))
            ) {
              if (t.workspaceStaging && !t.workspaceStaging.appliedAt && !t.workspaceStaging.discardedAt) {
                t.workspaceStaging.discardedAt = Date.now();
                delete t.workspaceStaging.stagedCwd;
                delete t.workspaceStaging.stagedDiff;
              }
              if ((t.status === "stopped" || t.status === "closed") && t.externalExecution && !t.externalExecution.stagedAppliedAt) {
                delete t.externalExecution.stagedCwd;
                delete t.externalExecution.stagedDiff;
              }
            }
            if (!cleanup.cleanupPending && !["running", "pausing"].includes(t.status)) releaseSlot(next, t.id);
          }, BACKGROUND_CONTEXT);
        }
        const waiting = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        for (const ticket of Object.values(waiting?.tickets ?? {})) {
          if ((ticket.envId === env.id || this.#androidTargets(ticket).includes(env.id)) && this.#ticketDevicesOnline(ticket) && ticket.status === "waiting" && !ticket.cleanupPending &&
            (ticket.wakePending || ticket.waiting?.reason === "env" || (ticket.waiting?.reason === "time" && (ticket.waiting.until ?? 0) <= Date.now()))) {
            await this.#resumeWaitingTicket(ticket.id, BACKGROUND_CONTEXT);
          }
        }
      }
      await this.#broadcastProjects();
      await this.#broadcastTickets(BACKGROUND_CONTEXT);
    }).catch((error) => { console.error("[KuloEnvReconcile]", error); });
    return this.#envTransition;
  }

  async #prepareBuiltInStagedWorkspace(
    ticket: Readonly<TicketRecord>,
    context: Context,
  ): Promise<{ stagedCwd: string; reused: boolean; warnings?: string[] }> {
    if (!ticket.projectId) throw new Error("Staged workspace requires a bound project");
    const project = await this.projects.ensureAuthorized(ticket.projectId, context);
    if (
      project.grantRevision !== ticket.grantRevision ||
      project.directoryId !== ticket.directoryId ||
      project.deviceId !== ticket.envId ||
      project.workspaceDir !== ticket.workspaceDir
    ) {
      throw new ProjectError(409, "project_binding_changed", "项目目录或授权版本已变化，请创建新任务。");
    }
    const fresh = Boolean(ticket.workspaceStaging?.appliedAt || ticket.workspaceStaging?.discardedAt);
    return this.envManager.prepareStagedWorkspace(ticket.envId, {
      taskId: ticket.id,
      projectId: project.id,
      sourceDir: project.workspaceDir,
      directoryId: project.directoryId,
      grantRevision: project.grantRevision,
      ...(fresh ? { fresh: true } : {}),
    });
  }

  async #inspectBuiltInStagedDiffSummary(
    ticket: Readonly<TicketRecord>,
  ): Promise<StagedWorkspaceDiffSummary | undefined> {
    if (ticket.externalExecution || ticket.workspaceStaging?.mode !== "staged") return undefined;
    if (ticket.workspaceStaging.appliedAt || ticket.workspaceStaging.discardedAt || !ticket.workspaceStaging.stagedCwd) {
      return undefined;
    }
    if (!this.envManager.getEnvDescriptor(ticket.envId)?.online) return undefined;
    const detail = await this.envManager.inspectStagedWorkspaceDiff(ticket.envId, ticket.id);
    const redacted = redactCredentialData(detail, (value) => this.connectionManager.redact(value));
    return {
      hasChanges: redacted.hasChanges,
      added: redacted.added,
      modified: redacted.modified,
      deleted: redacted.deleted,
      ...(redacted.emptyDirsAdded?.length ? { emptyDirsAdded: redacted.emptyDirsAdded } : {}),
      ...(redacted.emptyDirsDeleted?.length ? { emptyDirsDeleted: redacted.emptyDirsDeleted } : {}),
      ...(redacted.modeChanged?.length ? { modeChanged: redacted.modeChanged } : {}),
      ...(redacted.sensitivePaths?.length ? { sensitivePaths: redacted.sensitivePaths } : {}),
      conflictFiles: redacted.conflictFiles,
      unifiedPreview: redacted.unifiedPreview.slice(0, 24 * 1024),
      truncated: redacted.truncated,
    };
  }

  async #discardTicketStagedWorkspace(ticket: Readonly<TicketRecord>): Promise<boolean> {
    if (ticket.externalExecution) {
      const runId = ticket.externalExecution.runId;
      if (!runId || !ticket.externalExecution.stagedCwd || ticket.externalExecution.stagedAppliedAt) return false;
      if (!this.envManager.getEnvDescriptor(ticket.envId)?.online) return true;
      try {
        await this.envManager.requestExternalAgent(ticket.envId, { operation: "close", runId, discardStaged: true });
        return false;
      } catch {
        return true;
      }
    }
    if (ticket.workspaceStaging?.mode !== "staged" || ticket.workspaceStaging.appliedAt || ticket.workspaceStaging.discardedAt) {
      return false;
    }
    if (!ticket.workspaceStaging.stagedCwd) return false;
    if (!this.envManager.getEnvDescriptor(ticket.envId)?.online) return true;
    try {
      await this.envManager.discardStagedWorkspace(ticket.envId, ticket.id, ticket.projectId);
      return false;
    } catch {
      return true;
    }
  }

  async #releaseTicketExecution(ticket: Readonly<TicketRecord>, options: { park?: boolean } = {}): Promise<{ cleanupPending: boolean }> {
    try {
      let externalCleanupPending = false;
      const runId = ticket.externalExecution?.runId;
      if (runId) {
        // Close must still be attempted if startup has not reached a cancellable native session.
        await Promise.allSettled([this.envManager.requestExternalAgent(ticket.envId, { operation: "cancel", runId })]);
        const discardStaged = Boolean(["stopped", "closed"].includes(ticket.status) && ticket.externalExecution?.stagedCwd && !ticket.externalExecution.stagedAppliedAt);
        const [closed] = await Promise.allSettled([this.envManager.requestExternalAgent(ticket.envId, { operation: "close", runId, ...(discardStaged ? { discardStaged: true } : {}) })]);
        externalCleanupPending = closed!.status !== "fulfilled" || closed.value.type !== "run" ||
          closed.value.run.id !== runId || closed.value.run.taskId !== ticket.id ||
          closed.value.run.quiescent !== true;
      }
      if (ticket.externalExecution) {
        const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        externalCleanupPending ||= Object.values(state?.tickets ?? {}).some(child => child.parentTicketId === ticket.id &&
          (child.cleanupPending || ["stopped", "closed", "pausing"].includes(ticket.status) && isTicketUnfinished(child)));
      }
      const effectiveWorkspaceDir = getEffectiveWorkspaceDir(ticket);
      const shouldDiscardBuiltInStaged = Boolean(
        !ticket.externalExecution &&
          (["stopped", "closed"].includes(ticket.status) ||
            (ticket.status === "ready" && !hasPendingWorkspaceApply(ticket))) &&
          ticket.workspaceStaging?.mode === "staged" &&
          !ticket.workspaceStaging.appliedAt &&
          !ticket.workspaceStaging.discardedAt &&
          ticket.workspaceStaging.stagedCwd,
      );
      if (!options.park) this.#computerHandoffs.clear(ticket.id);
      const sessions = [...this.#computerSessions].filter(([, session]) =>
        session.ticketId === ticket.id && !(options.park && this.#computerHandoffs.hasActiveHandoff(ticket.id, session.sessionId)),
      );
      const [connection, worker, ...computer] = await Promise.allSettled([
        this.connectionManager.revoke(ticket.id),
        ticket.externalExecution || ticket.executionDomain === "android"
          ? Promise.resolve({ cleanupPending: externalCleanupPending })
          : (async () => {
              const envRelease = await this.envManager.releaseWorkerExecutionEnv(
                ticket.envId,
                effectiveWorkspaceDir,
                { scratchDir: ticket.scratchDir },
              );
              const stagedPending = !envRelease.cleanupPending && shouldDiscardBuiltInStaged
                ? await this.#discardTicketStagedWorkspace(ticket)
                : false;
              return { cleanupPending: envRelease.cleanupPending || stagedPending };
            })(),
        ...this.#androidTargets(ticket).map(async (deviceId) => {
          const result = await this.envManager.cancelAndroid(deviceId, { version: 1,
            controlId: `retire-${createHash("sha256").update(`${ticket.id}:${ticket.runEpoch}:${deviceId}:${options.park ? "park" : "stop"}`).digest("hex")}`,
            ticketId: ticket.id, runEpoch: ticket.runEpoch, reason: options.park ? "task_epoch_parked" : "task_epoch_retired" });
          if (!result.quiescent && !(options.park && result.epochQuiescent === true && result.resourcesRetained === true)) throw new Error("手机任务尚未确认静止。");
        }),
        ...sessions.map(async ([key, session]) => {
          const result = await this.envManager.requestComputerUse(session.envId, { tool: session.tool, action: "close", sessionId: session.sessionId });
          if (!result.ok) throw new Error("任务的电脑操作会话尚未关闭。");
          this.#computerSessions.delete(key);
        }),
      ]);
      if (worker!.status === "rejected") throw worker!.reason;
      return { cleanupPending: connection!.status === "rejected" || worker!.value.cleanupPending || computer.some((result) => result.status === "rejected") };
    } catch (error) {
      console.error(`[KuloCleanup:${ticket.id}]`, error);
      return { cleanupPending: true };
    }
  }

  #parkTicket(ticketId: string, waiting: NonNullable<TicketRecord["waiting"]>): Promise<void> {
    const existing = this.#parkingTickets.get(ticketId);
    if (existing) return existing;
    const transition = this.#parkTicketNow(ticketId, waiting);
    this.#parkingTickets.set(ticketId, transition);
    void transition.finally(() => {
      if (this.#parkingTickets.get(ticketId) === transition) this.#parkingTickets.delete(ticketId);
    }).catch((error) => console.error(`[KuloPause:${ticketId}]`, error));
    return transition;
  }

  async #parkTicketNow(ticketId: string, waiting: NonNullable<TicketRecord["waiting"]>): Promise<void> {
    const context = BACKGROUND_CONTEXT;
    const snapshot = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[ticketId];
    if (!ticket || !isTicketUnfinished(ticket) || ["waiting", "blocked"].includes(ticket.status)) return;
    const epoch = ticket.runEpoch + 1;
    const preservedWait = ticket.waiting && ticket.waiting.reason !== "project" ? ticket.waiting : waiting;
    const admitted = await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[ticketId];
      if (!t || t.runEpoch !== ticket.runEpoch || !isTicketUnfinished(t) || t.status === "waiting" || t.status === "blocked") return false;
      t.runEpoch = epoch;
      transitionTicketStatus(t, "pausing", Date.now());
      t.waiting = t.waiting && t.waiting.reason !== "project" ? t.waiting : preservedWait;
      t.updatedAt = Date.now();
      return true;
    }, context);
    if (!admitted) return;
    const conversations = [ticket.workerConversationId, ...Object.values(snapshot?.subagents ?? {}).filter((s) => s.ticketId === ticketId).map((s) => s.conversationId)];
    await Promise.all(conversations.map(async (id) => {
      const conversation = await this.harness.conversation(id as ConversationId, context);
      if (conversation) await conversation.abort(context, { background: true });
    }));
    if (ticket.activeTaskId !== undefined) await this.harness.abortTask(ticket.activeTaskId as never, context);
    const cleanup = await this.#releaseTicketExecution(ticket, { park: true });
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[ticketId];
      if (!t || t.runEpoch !== epoch || t.status !== "pausing") return;
      for (const sub of Object.values(state.subagents ?? {})) {
        if (sub.ticketId === ticketId && !["ready", "failed", "stopped"].includes(sub.state ?? "")) sub.state = "waiting";
      }
      transitionTicketStatus(t, "waiting", Date.now());
      if (t.deliveryClaim === "inline_waiting") {
        t.deliveryClaim = "escalated";
      }
      t.activeTaskId = undefined;
      t.cleanupPending = cleanup.cleanupPending;
      t.updatedAt = Date.now();
      releaseSlot(state, ticketId);
      if (t.waiting?.reason === "time") {
        const id = await tx.createTask(this.#workerTicketTask, { ticketId, runEpoch: t.runEpoch, promptOverride: null }, {
          ownership: { kind: "conversation" }, conversationId: (t.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, background: true,
        });
        t.activeTaskId = Number(id);
      }
    }, context);
    this.#parkingTickets.delete(ticketId);
    this.#untrackWorker(ticketId, ticket.runEpoch);
    const parked = await this.harness.snapshot(KuloStateDoc, context);
    if (parked?.tickets[ticketId]?.wakePending) await this.#resumeWaitingTicket(ticketId, context);
    const isBlockedCoordinatorWait =
      preservedWait.reason === "coordinator" && !preservedWait.waitToken?.startsWith("host-action-req:");
    if ((preservedWait.reason === "user" && !preservedWait.waitToken?.startsWith("host-action:")) || isBlockedCoordinatorWait) {
      const latest = await this.harness.snapshot(KuloStateDoc, context);
      const settingsLatest = await this.harness.snapshot(SettingsAssistantDoc, context);
      const originTopic = latest?.topics?.[ticket.originTopicId ?? "root"];
      const originDeleted = isSettingsTopicDeleted(ticket.originTopicId, settingsLatest) || Boolean(originTopic?.deletedAt);
      if (latest?.tickets[ticketId]?.runEpoch === epoch && !latest.tickets[ticketId]?.wakePending && !originDeleted) {
        const current = latest.tickets[ticketId]!;
        const report = current.latestReport?.state === "blocked" ? current.latestReport : undefined;
        const question = report?.question ?? preservedWait.detail ?? "请确认下一步";
        const origin = await this.harness.conversation((ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, context);
        if (origin) {
          await this.#ensureTopicWatchedByConversation(Number(origin.id), context);
          await this.harness.commit(async (tx) => {
          if (isBlockedCoordinatorWait) {
            await injectEventToolsInTx(tx, origin.id, ["kulo_inspect", "kulo_ticket_ask_user"]);
          }
          return submitAutomaticChatInput(tx, origin, {
            type: "input",
            content: isBlockedCoordinatorWait
              ? formatWorkerRelayMessage({
                  ticketId,
                  title: current.title,
                  role: current.role,
                  report: report ?? { state: "blocked", summary: question, question, at: Date.now() },
                })
              : `[KULO_WORKER_RELAY]\nTicket ${ticket.title} is waiting on user confirmation: ${question}\nRelay this single question concisely in the active conversation language without exposing internal IDs.`,
            whenBusy: "followUp",
            requestId: isBlockedCoordinatorWait ? `kulo:relay:${ticketId}:${epoch}` : `kulo:wait-user:${ticketId}:${epoch}`,
            entry: { kind: WorkerRelayEntry.kind, data: {
              ticketId, title: current.title, role: current.role, state: "blocked",
              summary: report?.summary ?? question, question, deliverable: report?.deliverable ?? null,
            } },
          });
        }, context);
        }
        if (!this.#recovering) this.harness.resume();
      }
    }
    if (preservedWait.reason === "connection") await this.#relayConnectionRequest(ticketId);
    if (preservedWait.reason === "coordinator" && preservedWait.waitToken?.startsWith("host-action-req:")) {
      await this.#relayHostActionRequest(ticketId);
    }
    this.#notifyInlineWaiters(ticketId);
    await this.#broadcastTickets(context);
  }

  #scheduledWakeDeferUntil(ticket: Readonly<TicketRecord>, now: number): number | null {
    if (!ticket.schedule) return null;
    const status = this.usageCaps.isCappedFor("schedule");
    if (!status.capped || status.resetAt == null) return null;
    return computeCapDeferredDueAt(ticket, status.resetAt, now);
  }

  async #resumeWaitingTicket(ticketId: string, context: Context): Promise<void> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket || ticket.status !== "waiting" || ((ticket.waiting?.reason === "user" || ticket.waiting?.reason === "connection" || ticket.waiting?.reason === "coordinator") && !ticket.wakePending) || ticket.cleanupPending) return;
    if (!ticket.wakePending && ticket.schedule?.nextRunAt != null && hasPendingWorkspaceApply(ticket)) return;
    if (ticket.schedule?.nextRunAt != null && ticket.schedule.nextRunAt > Date.now()) return;
    if (!ticket.wakePending && ticket.waiting?.until !== undefined && ticket.waiting.until > Date.now()) return;
    if (!ticket.wakePending && ticket.schedule) {
      const deferUntil = this.#scheduledWakeDeferUntil(ticket, Date.now());
      if (deferUntil != null && deferUntil > Date.now()) {
        await this.harness.commit(async (tx) => {
          const live = (await tx.doc(KuloStateDoc)).tickets[ticketId];
          if (!live || live.runEpoch !== ticket.runEpoch || live.status !== "waiting" || !live.schedule) return;
          live.schedule.nextRunAt = deferUntil;
          live.waiting = { reason: "time", since: Date.now(), until: deferUntil, detail: "已达后台用量上限，推迟至额度重置后继续" };
          live.updatedAt = Date.now();
        }, context);
        await this.#broadcastTickets(context);
        return;
      }
    }
    if (!this.#ticketDevicesOnline(ticket)) {
      if (ticket.waiting?.reason === "time") await this.harness.commit(async (tx) => {
        const next = await tx.doc(KuloStateDoc);
        const t = next.tickets[ticketId];
        if (t?.runEpoch === ticket.runEpoch && t.status === "waiting") {
          t.waiting = { reason: "env", since: Date.now(), detail: "定时已到，等待执行设备上线" };
          t.activeTaskId = undefined;
        }
      }, context);
      return;
    }
    try {
      await this.steerTicket({ ticketId, commandId: `wake:${ticketId}:${ticket.runEpoch}`, text: ticket.schedule?.nextRunAt != null
        ? `Scheduled execution time reached. Execute this run within the authorized goal and scope below—inspect current state and any unconfirmed side-effect results first so prior side effects are not repeated.\n\n${formatWorkerInitialPrompt(ticket)}`
        : ticket.executionDomain === "android"
        ? "Wait condition satisfied. Re-observe the target Android phone first and verify prior action receipts and current screen state before continuing; never replay completed or uncertain side effects."
        : "Wait condition satisfied. Incorporate any follow-up instructions, inspect workspace file changes and unconfirmed tool results first, and continue without repeating completed side effects." }, context);
    } catch (error) {
      await this.harness.commit(async (tx) => {
        const next = await tx.doc(KuloStateDoc);
        const current = next.tickets[ticketId];
        if (current?.runEpoch === ticket.runEpoch && current.status === "waiting" && current.waiting) {
          current.waiting.detail = `恢复失败：${error instanceof Error ? error.message : String(error)}`;
          current.updatedAt = Date.now();
        }
      }, context);
      if (!(error instanceof ProjectError)) console.error(`[KuloResume:${ticketId}]`, error);
    }
  }

  async customizationService(): Promise<KuloCustomizationService> {
    if (this.#closed) throw new Error("Kulo 正在退出，暂时无法修改程序。");
    const pending = this.#customizationService ??= createDesktopCustomizationService(this.config, (text) => this.connectionManager.redact(text));
    let service: KuloCustomizationService;
    try { service = await pending; }
    catch (error) {
      if (this.#customizationService === pending) this.#customizationService = undefined;
      throw error;
    }
    if (this.#closed) { await service.close(); throw new Error("Kulo 正在退出，暂时无法修改程序。"); }
    this.#customizationInstance = service;
    return service;
  }

  async #customizationCaller(conversationId: unknown): Promise<{ id: string; canModify: boolean }> {
    const id = Number(conversationId);
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("无法确认当前定制请求的会话。");
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const topicId = state?.conversationToTopic?.[String(id)];
    const topic = topicId ? state?.topics?.[topicId] : undefined;
    const main = isOrchestratorConversation(id, state) && (!topic || !topic.deletedAt && !topic.archived);
    const settings = main ? undefined : await this.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const activeSettings = settings?.conversationId === id && !settings.deletedConversationIds?.includes(id);
    return { id: `conversation:${id}`, canModify: Boolean(this.config.customization && (main || activeSettings)) };
  }

  getActiveExpression(): AgentExpressionState | null {
    const expr = this.#liveSettings.expression;
    if (!expr) return null;
    if (expr.expiresAt <= Date.now()) return null;
    return expr;
  }

  async listTopics(context: Context = BACKGROUND_CONTEXT): Promise<TopicSummary[]> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    if (!state) return [];
    return this.#enrichTopicsWithPreviews(listSortedTopics(state));
  }

  async archiveInactiveTopics(context: Context = BACKGROUND_CONTEXT): Promise<TopicSummary[]> {
    if (this.#closed) return [];
    if (this.#topicAutoArchiveRun) return this.#topicAutoArchiveRun;
    const run = this.#archiveInactiveTopics(context);
    this.#topicAutoArchiveRun = run;
    try { return await run; }
    finally { if (this.#topicAutoArchiveRun === run) this.#topicAutoArchiveRun = null; }
  }

  async #archiveInactiveTopics(context: Context): Promise<TopicSummary[]> {
    const { archived, allTopics } = await this.harness.commit(async (tx) => {
      const settings = await tx.doc(KuloSettingsDoc);
      if (this.#closed || settings.executor.autoArchiveEnabled === false) return { archived: [], allTopics: [] };
      const state = await tx.doc(KuloStateDoc);
      const cutoff = Date.now() - (settings.executor.autoArchiveDays ?? 7) * 86_400_000;
      const archived: TopicSummary[] = [];
      const protectedTopics = new Set<string>();
      const protectedConversations = new Set<number>();
      for (const ticket of Object.values(state.tickets)) {
        if (!isTicketUnfinished(ticket) && !ticket.cleanupPending && !hasPendingWorkspaceApply(ticket) && ticket.updatedAt < cutoff) continue;
        if (ticket.originTopicId) protectedTopics.add(ticket.originTopicId);
        if (ticket.originConversationId !== undefined) protectedConversations.add(ticket.originConversationId);
      }
      for (const topic of Object.values(state.topics ?? {})) {
        // The reserved identity remains protected even if an older record lost its master flag.
        if (topic.id === "root" || topic.master || topic.conversationId === Number(ROOT_CONVERSATION_ID) ||
          topic.deletedAt || topic.archived || topic.updatedAt >= cutoff || this.#topicActivityUpdates.has(topic.id) ||
          this.#topicCaches.get(topic.id)?.live.busy || protectedTopics.has(topic.id) || protectedConversations.has(topic.conversationId)) continue;
        const conversationId = topic.conversationId as ConversationId;
        const live = await tx.doc(LiveDoc, conversationId);
        const inbox = await tx.doc(InboxDoc, conversationId);
        if (live.run || inbox.items.length || state.pausedChats?.[String(conversationId)]?.length) continue;
        const recent = await tx.scanEntries({ conversationId }, 32);
        const timestamps = recent.items.flatMap((entry) => {
          const at = entryTimestamp(entry) ?? chatReceiptData(entry.data).createdAt;
          return at === undefined ? [] : [at];
        });
        // Do not guess at an undated tail that may hide recent automatic activity.
        if (timestamps.some((at) => at >= cutoff) || recent.next && timestamps.length === 0) continue;
        topic.archived = true;
        archived.push(cloneJson(topic));
      }
      return { archived, allTopics: archived.length ? listSortedTopics(state) : [] };
    }, context);
    if (archived.length) {
      for (const topic of archived) {
        await this.#closeOrchestratorBrowserSession(topic.id);
      }
      this.#emitTopics(allTopics);
    }
    return archived;
  }

  async createTopic(
    title?: string,
    context: Context = BACKGROUND_CONTEXT,
    projectId?: string | null,
  ): Promise<TopicSummary> {
    const project = projectId ? await this.projects.get(projectId, context) : undefined;
    const orchestratorAgent = this.#resolveOrchestratorAgent();
    const conv = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: orchestratorAgent.model,
          thinkingLevel: orchestratorAgent.thinkingLevel,
          extensions: this.#orchestratorExtensions(false),
          tools: this.#orchestratorTools(false),
          cwd: project?.workspaceDir ?? this.#mainWorkspaceDir,
          maxTurns: 25,
        },
      },
      context,
    );

    const cleanTitle = title?.trim();
    const topicId = `topic-${conv.id as number}`;
    const now = Date.now();

    const { topic, allTopics } = await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      ensureDefaultRootTopic(state, this.#liveSettings.presentation.agentName);
      if (project) assertProjectBinding(await tx.doc(KuloProjectsDoc), project.id, project.revision);
      const record: TopicSummary = {
        id: topicId,
        conversationId: conv.id as number,
        title: cleanTitle || "新对话",
        ...(cleanTitle ? {} : { draft: true }),
        createdAt: now,
        updatedAt: now,
        ...(project ? { projectId: project.id } : {}),
      };
      state.topics![topicId] = record;
      state.conversationToTopic![String(conv.id)] = topicId;
      return { topic: cloneJson(record), allTopics: listSortedTopics(state) };
    }, context);

    await this.#alignContextCompaction(conv.id, context);
    await this.#ensureTopicWatched(topicId, conv, context);
    this.#emitTopics(allTopics);
    return topic;
  }

  async patchTopic(
    topicId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<TopicSummary> {
    const stagedToDiscard: TicketRecord[] = [];
    const { updated, allTopics } = await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      ensureDefaultRootTopic(state, this.#liveSettings.presentation.agentName);
      const t = state.topics?.[topicId];
      if (!t || t.deletedAt) throw new ProjectError(404, "topic_not_found", "会话不存在或已删除。");

      if (patch.title !== undefined && patch.title.trim()) {
        t.title = patch.title.trim().slice(0, 120);
        delete t.draft;
        const titleJob = state.topicTitles?.[topicId];
        if (titleJob?.status === "pending" || titleJob?.status === "failed") titleJob.status = "cancelled";
      }
      if (patch.pinned !== undefined) {
        t.pinned = Boolean(patch.pinned);
      }
      if (patch.archived !== undefined) {
        if ((t.master || t.id === "root" || t.conversationId === Number(ROOT_CONVERSATION_ID)) && patch.archived) {
          throw new Error("默认主对话不可归档");
        }
        t.archived = Boolean(patch.archived);
        if (t.archived) {
          const now = Date.now();
          for (const ticket of Object.values(state.tickets)) {
            if ((ticket.originTopicId ?? "root") !== topicId) continue;
            if (!hasPendingWorkspaceApply(ticket)) continue;
            stagedToDiscard.push(cloneJson(ticket));
            if (ticket.workspaceStaging && !ticket.workspaceStaging.appliedAt) {
              ticket.workspaceStaging.discardedAt = now;
              delete ticket.workspaceStaging.stagedCwd;
              delete ticket.workspaceStaging.stagedDiff;
            }
            if (ticket.externalExecution && !ticket.externalExecution.stagedAppliedAt) {
              delete ticket.externalExecution.stagedCwd;
              delete ticket.externalExecution.stagedDiff;
            }
            releaseProjectWrite(state, ticket.id, { force: true });
            ticket.updatedAt = now;
          }
        }
      }
      t.updatedAt = Date.now();
      return { updated: cloneJson(t), allTopics: listSortedTopics(state) };
    }, context);

    if (stagedToDiscard.length > 0) {
      await Promise.allSettled(stagedToDiscard.map((ticket) => this.#discardTicketStagedWorkspace(ticket)));
      if (!this.#recovering) this.harness.resume();
      await this.#broadcastTickets(context);
    }
    this.#emitTopics(allTopics);
    return updated;
  }

  async deleteTopic(
    topicId: string,
    context: Context = BACKGROUND_CONTEXT,
    options: { stopTasks?: boolean } = {},
  ): Promise<{ deleted: string; topics: TopicSummary[] }> {
    if (topicId === "root") throw new ProjectError(400, "default_topic", "默认主对话不可删除。");
    const snap = await this.harness.snapshot(KuloStateDoc, context);
    const topic = snap?.topics?.[topicId];
    if (!topic || topic.deletedAt) throw new ProjectError(404, "topic_not_found", "会话不存在或已删除。");
    const active = Object.values(snap?.tickets ?? {}).filter((t) => t.originTopicId === topicId &&
      (isTicketUnfinished(t) || hasPendingWorkspaceApply(t)));
    if (active.length && !options.stopTasks) {
      throw new ProjectError(409, "topic_tasks_running", "会话仍有进行中或待合入的任务，请停止或合并相关任务后删除。", { activeTickets: active.map((t) => t.id) });
    }
    // The tombstone and cancel intents commit together before any asynchronous cleanup.
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const target = state.topics?.[topicId];
      if (!target || target.master) throw new ProjectError(400, "default_topic", "默认主对话不可删除。");
      const unfinished = Object.values(state.tickets).filter((t) => t.originTopicId === topicId &&
        (isTicketUnfinished(t) || hasPendingWorkspaceApply(t)));
      if (unfinished.length && !options.stopTasks) throw new ProjectError(409, "topic_tasks_running", "会话仍有进行中或待合入的任务，请停止或合并相关任务后删除。");
      target.deletedAt = Date.now();
      target.deletionId = randomUUID();
      target.updatedAt = target.deletedAt;
      const titleJob = state.topicTitles?.[topicId];
      if (titleJob?.status === "pending" || titleJob?.status === "failed") titleJob.status = "cancelled";
      const projects = await tx.doc(KuloProjectsDoc);
      projects.cancellations ??= {};
      for (const ticket of unfinished) {
        transitionTicketStatus(ticket, "stopped", target.deletedAt);
        ticket.stoppedReason = "会话已删除";
        ticket.updatedAt = target.deletedAt;
        ticket.cleanupPending = true;
        projects.cancellations[ticket.id] = { ...(ticket.projectId ? { projectId: ticket.projectId } : {}), reason: "会话已删除", requestedAt: target.deletedAt };
      }
    }, context);
    await this.projects.reconcileCancellations(context);
    await this.#closeOrchestratorBrowserSession(topicId);
    const cache = this.#topicCaches.get(topicId);
    if (cache) { await cache.conversation.abort(context, { background: true }); await cache.watch.stop(); this.#topicCaches.delete(topicId); }
    const topics = await this.listTopics(context);
    this.#emitTopics(topics);
    return { deleted: topicId, topics };
  }

  async getTopicView(
    topicId = "root",
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<TopicView> {
    const cache = await this.#resolveWatchedTopic(topicId, context);
    return this.#readTopicView(cache);
  }

  // A full snapshot can spend time loading other domains after it has read this conversation.
  // Check the current scope, then publish from the live watch without yielding to newer messages.
  async publishCurrentTopicView(topicId: string, publish: (view: TopicView) => void, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    const [state, projects] = await Promise.all([
      this.harness.snapshot(KuloStateDoc, context),
      this.harness.snapshot(KuloProjectsDoc, context),
    ]);
    if (this.#closed) throw new Error("Hub is closed");
    const topic = requireTopic(state, topicId);
    if (topic.projectId) assertProjectBinding(projects, topic.projectId);
    const cache = this.#topicCaches.get(topicId);
    if (!cache || Number(cache.conversation.id) !== topic.conversationId) throw new ProjectError(404, "topic_not_found", "会话不存在。");
    publish(this.#readTopicView(cache));
  }

  #readTopicView(cache: WatchedTopicCache): TopicView {
    return { topicId: cache.topicId, messages: cache.messages, historyBefore: this.getTopicHistoryBefore(cache.topicId), live: cache.live };
  }

  getTopicHistoryBefore(topicId: string): number | undefined {
    const view = this.#topicCaches.get(topicId)?.watch.value;
    return view?.before !== undefined && view.entries[0] ? Number(view.entries[0].id) : undefined;
  }

  async getTopicHistory(topicId: string, before: number, context: Context = BACKGROUND_CONTEXT) {
    if (!Number.isSafeInteger(before) || before < 1) throw Object.assign(new Error("历史位置无效。"), { status: 400 });
    const cache = await this.#resolveWatchedTopic(topicId, context);
    const page = await cache.conversation.entries({ maxEntryId: (before - 1) as EntryId }, 120, undefined, context);
    const entries = [...page.items].reverse();
    return { messages: await this.#hydrateMessages(entries, Number(cache.conversation.id)),
      ...(page.next && entries[0] ? { beforeEntryId: Number(entries[0].id) } : {}), hasMore: Boolean(page.next) };
  }

  #conversationQueries(): ConversationQueries {
    return this.#queryService ??= new ConversationQueries({
      redactionRevision: () => this.connectionManager.redactionRevision,
      topics: async (context) => {
        const [state, projects] = await Promise.all([
          this.harness.snapshot(KuloStateDoc, context), this.harness.snapshot(KuloProjectsDoc, context),
        ]);
        if (!state) return [];
        return listSortedTopics(state).filter((topic) => {
          if (!isOrchestratorConversation(topic.conversationId, state) || state.conversationToTopic?.[String(topic.conversationId)] !== topic.id) return false;
          if (!topic.projectId) return true;
          const project = projects?.projects && Object.hasOwn(projects.projects, topic.projectId) ? projects.projects[topic.projectId] : undefined;
          return project !== undefined && project.deletedAt === undefined;
        }).map((topic) => ({ ...topic, title: this.connectionManager.redact(topic.title) }));
      },
      conversation: (id, context) => this.harness.conversation(id as ConversationId, context),
      project: (entries, id, context) => this.#hydrateMessages(entries, id, undefined, context),
      attachment: (assetId, conversationId) => {
        const loaded = this.uploads.getUpload(assetId);
        if (!loaded || loaded.record.ownerId !== undefined && !loaded.record.referenceScopes?.includes(`conversation:${conversationId}`)) return undefined;
        return redactCredentialData(this.uploads.toChatAttachment(loaded.record), (text) => this.connectionManager.redact(text));
      },
    });
  }

  searchConversations(input: ConversationSearchInput, context: Context = BACKGROUND_CONTEXT) {
    return this.#conversationQueries().search(input, context);
  }

  getTopicMessageWindow(topicId: string, messageId: number, context: Context = BACKGROUND_CONTEXT) {
    return this.#conversationQueries().messageWindow(topicId, messageId, context);
  }

  listTopicFiles(topicId: string, input: { cursor?: string; limit?: number } = {}, context: Context = BACKGROUND_CONTEXT) {
    return this.#conversationQueries().files(topicId, input, context);
  }

  async updateSettingsBlock(
    block: SettingsBlockName,
    expectedRevision: number,
    value: unknown,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ settings: KuloSettingsView; summary: string }> {
    const { nextDoc, summary } = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      const draft = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const changedPrivatePath = block === "identity"
        ? String(draft.directory ?? "").trim() !== doc.identity.directory
        : block === "memory" && String(draft.authFile ?? "").trim() !== doc.memory.authFile;
      if (changedPrivatePath) {
        const state = await tx.doc(KuloStateDoc);
        if (Object.values(state.tickets).some((ticket) => ticket.status === "running")) {
          throw new SettingsUpdateError(400, "请先停止正在运行的后台任务，再切换私有文件路径。");
        }
        const privatePath = String(block === "identity" ? draft.directory ?? "" : draft.authFile ?? "").trim();
        if (privatePath) {
          const target = canonicalExecutionPath(privatePath);
          for (const ticket of Object.values(state.tickets)) {
            for (const workspace of [ticket.workspaceDir, ticket.scratchDir]) {
              if (!workspace) continue;
              const relative = path.relative(canonicalExecutionPath(workspace), target);
              if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
                throw new SettingsUpdateError(400, "私有文件不能存放在后台任务的工作目录或暂存目录中。");
              }
            }
          }
        }
      }
      const msg = applySettingsBlockUpdate(doc, block, expectedRevision, value);
      if (block === "memory") assertMemoryIdentitySeparation(doc.memory, this.config, this.envManager);
      return {
        nextDoc: cloneJson(doc) as KuloDurableSettings,
        summary: msg,
      };
    }, context);

    await this.#applyLiveSettings(nextDoc, context);
    if (block === "executor") await this.archiveInactiveTopics(context);
    const view = this.getSettingsView();
    this.#emitSettings(view);
    await this.#broadcastTickets(context);
    return { settings: view, summary };
  }

  async refreshExternalClientModels(
    clientId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ settings: KuloSettingsView; client: import("@kulo/protocol").ExternalClientConnection }> {
    const cleanId = typeof clientId === "string" ? clientId.trim() : "";
    if (!cleanId || cleanId.length > 200) throw new SettingsUpdateError(400, "外部客户端标识无效。");
    const snapshot = await this.harness.snapshot(KuloSettingsDoc, context);
    const existing = snapshot?.externalClients?.[cleanId];
    if (!existing) throw new SettingsUpdateError(400, "外部客户端尚未连接。");
    const env = this.envManager.getEnvDescriptor(existing.envId);
    if (!env?.online) throw new SettingsUpdateError(409, "客户端绑定的设备当前离线，请连接设备后刷新。");
    const response = await this.envManager.requestExternalAgent(existing.envId, {
      operation: "probe",
      binding: bindingFromExternalClient(existing),
    });
    if (response.type !== "detection" || response.detection.kind !== existing.kind) {
      throw new SettingsUpdateError(409, "设备返回的客户端协议检测结果无效。");
    }
    if (!response.detection.installed || response.detection.error) {
      throw new SettingsUpdateError(409, this.connectionManager.redact(response.detection.error || "未能读取客户端原生模型列表。"));
    }
    const now = Date.now();
    const { nextDoc, updated } = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      syncExternalClientsInSettings(doc);
      const current = doc.externalClients?.[cleanId];
      if (!current) throw new SettingsUpdateError(400, "外部客户端已移除。");
      if (
        current.kind !== existing.kind ||
        current.envId !== existing.envId ||
        current.executable !== existing.executable ||
        JSON.stringify(current.acpArgs ?? []) !== JSON.stringify(existing.acpArgs ?? []) ||
        current.agentRef !== existing.agentRef ||
        current.cdpUrl !== existing.cdpUrl
      ) {
        throw new SettingsUpdateError(409, "外部客户端配置在刷新期间已变动，请重试。");
      }
      const patch: Partial<import("@kulo/protocol").ExternalClientConnection> = {
        ...(response.detection.version ? { version: response.detection.version } : {}),
        capabilities: cloneJson(response.detection.capabilities),
        models: cloneJson(response.detection.models),
        updatedAt: now,
      };
      const refreshed: import("@kulo/protocol").ExternalClientConnection = {
        ...current,
        ...patch,
      };
      const nextRoles = cloneJson(doc.roles);
      for (const role of Object.values(nextRoles)) {
        if (!role.external) continue;
        const roleClientId = role.externalClientId?.trim() || externalClientConnectionId(role.external);
        if (roleClientId === cleanId) {
          role.externalClientId = cleanId;
          role.external = bindingFromExternalClient(refreshed);
        }
      }
      applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, nextRoles, {
        externalAgents: true,
        clientModels: { [cleanId]: cloneJson(response.detection.models) },
        clientPatches: { [cleanId]: patch },
        summaryOverride: `刷新外部客户端模型列表（${refreshed.kind}）`,
      });
      return {
        nextDoc: cloneJson(doc) as KuloDurableSettings,
        updated: cloneJson(doc.externalClients?.[cleanId] ?? refreshed),
      };
    }, context);
    await this.#applyLiveSettings(nextDoc, context);
    const view = this.getSettingsView();
    this.#emitSettings(view);
    return { settings: view, client: updated };
  }

  async verifyExternalClient(
    clientId: string,
    options: { commandId?: string; expectedRevision?: number } = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<import("@kulo/protocol").ExternalAgentVerifyClientResult> {
    const cleanId = typeof clientId === "string" ? clientId.trim() : "";
    if (!cleanId || cleanId.length > 200) throw new SettingsUpdateError(400, "外部客户端标识无效。");
    const commandId = typeof options.commandId === "string" && options.commandId.trim()
      ? options.commandId.trim().slice(0, 180)
      : `verify-client-${randomUUID()}`;
    const receiptKey = `${cleanId}:${commandId}`;
    const cached = this.#verifyClientReceipts.get(receiptKey);
    if (cached) return cloneJson(cached);

    const snapshot = await this.harness.snapshot(KuloSettingsDoc, context);
    const existing = snapshot?.externalClients?.[cleanId];
    if (!existing) throw new SettingsUpdateError(400, "外部客户端尚未连接。");
    if (!isSupportedExternalAgentKind(existing.kind)) {
      throw new SettingsUpdateError(409, "当前客户端类型尚不支持稳定收发通信验证。");
    }
    if (options.expectedRevision !== undefined && snapshot && snapshot.revisions.roles !== options.expectedRevision) {
      throw new SettingsUpdateError(409, "智能体配置已变动，请刷新后重试验证。");
    }
    const env = this.envManager.getEnvDescriptor(existing.envId);
    if (!env?.online) throw new SettingsUpdateError(409, "客户端绑定的设备当前离线，请连接设备后验证。");

    const binding = bindingFromExternalClient(existing);
    const probeResponse = await this.envManager.requestExternalAgent(existing.envId, {
      operation: "probe",
      binding,
    });
    if (probeResponse.type !== "detection" || probeResponse.detection.kind !== existing.kind) {
      throw new SettingsUpdateError(409, "设备返回的客户端协议检测结果无效。");
    }
    const detection = cloneJson(probeResponse.detection);
    if (!detection.installed || detection.error) {
      throw new SettingsUpdateError(409, this.connectionManager.redact(detection.error || "客户端协议检测未通过。"));
    }
    if (detection.authenticated === false) {
      throw new SettingsUpdateError(409, "本地客户端尚未完成登录，请先在原客户端登录后再验证连接。");
    }

    const nonce = `KULO_AGENT_VERIFY_${createHash("sha256").update(`verify-client:${cleanId}:${commandId}`).digest("hex").slice(0, 24)}`;
    const tempDraft: AgentConfigurationDraft = {
      id: `agent-client-verify-${createHash("sha256").update(cleanId).digest("hex").slice(0, 16)}`,
      revision: Math.max(1, snapshot?.revisions.roles ?? 1),
      clientId: "external-client-verify",
      settingsRevision: snapshot?.revisions.roles ?? 1,
      binding: {
        ...binding,
        ...(detection.version ? { version: detection.version } : {}),
        capabilities: detection.capabilities,
      },
      label: existing.label ?? existing.kind,
      whenToUse: "Verification roundtrip",
      prompt: "Verification roundtrip",
      readOnly: false,
      allowSubagents: false,
      detection,
      updatedAt: Date.now(),
    };
    const evidence = await this.#verifyExternalAgent(tempDraft, nonce);
    const verifiedAt = Date.now();
    const { nextDoc, enabledRoleIds } = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      syncExternalClientsInSettings(doc);
      const current = doc.externalClients?.[cleanId];
      if (!current) throw new SettingsUpdateError(400, "外部客户端已移除。");
      if (
        current.kind !== existing.kind ||
        current.envId !== existing.envId ||
        current.executable !== existing.executable ||
        JSON.stringify(current.acpArgs ?? []) !== JSON.stringify(existing.acpArgs ?? []) ||
        current.agentRef !== existing.agentRef ||
        current.cdpUrl !== existing.cdpUrl
      ) {
        throw new SettingsUpdateError(409, "外部客户端配置在验证期间已变动，请重试。");
      }
      const wasVerified = Boolean(current.verifiedAt);
      const version = evidence.version ?? detection.version ?? current.version;
      const patch: Partial<import("@kulo/protocol").ExternalClientConnection> = {
        ...(version ? { version } : {}),
        verifiedAt,
        capabilities: cloneJson(detection.capabilities),
        models: cloneJson(detection.models),
        updatedAt: verifiedAt,
      };
      const verifiedClient: import("@kulo/protocol").ExternalClientConnection = {
        ...current,
        ...patch,
      };
      const nextRoles = cloneJson(doc.roles);
      const enabledIds: string[] = [];
      for (const role of Object.values(nextRoles)) {
        if (!role.external) continue;
        const roleClientId = role.externalClientId?.trim() || externalClientConnectionId(role.external);
        if (roleClientId === cleanId) {
          role.externalClientId = cleanId;
          role.external = bindingFromExternalClient(verifiedClient);
          if (!wasVerified && role.enabled === false) {
            role.enabled = true;
            enabledIds.push(role.id);
          }
        }
      }
      applySettingsBlockUpdate(
        doc,
        "roles",
        options.expectedRevision ?? doc.revisions.roles,
        nextRoles,
        {
          externalAgents: true,
          clientModels: { [cleanId]: cloneJson(detection.models) },
          clientPatches: { [cleanId]: patch },
          summaryOverride: `完成外部客户端连接验证（${verifiedClient.kind}）`,
        },
      );
      return { nextDoc: cloneJson(doc) as KuloDurableSettings, enabledRoleIds: enabledIds };
    }, context);
    await this.#applyLiveSettings(nextDoc, context);
    const view = this.getSettingsView();
    this.#emitSettings(view);
    const result: import("@kulo/protocol").ExternalAgentVerifyClientResult = {
      clientId: cleanId,
      verifiedAt,
      verificationLevel: "roundtrip",
      ...(evidence.version ?? detection.version ? { version: evidence.version ?? detection.version } : {}),
      modelsCount: detection.models.length,
      enabledRoleIds,
      settings: view,
    };
    this.#verifyClientReceipts.set(receiptKey, cloneJson(result));
    if (this.#verifyClientReceipts.size > 128) {
      const firstKey = this.#verifyClientReceipts.keys().next().value;
      if (firstKey !== undefined) this.#verifyClientReceipts.delete(firstKey);
    }
    return result;
  }

  async removeExternalClient(
    clientId: string,
    expectedRevision?: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ settings: KuloSettingsView }> {
    const cleanId = typeof clientId === "string" ? clientId.trim() : "";
    if (!cleanId || cleanId.length > 200) throw new SettingsUpdateError(400, "外部客户端标识无效。");
    const nextDoc = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      syncExternalClientsInSettings(doc);
      const boundRoleIds = Object.entries(doc.roles)
        .filter(([, role]) => role.external && (role.externalClientId?.trim() || externalClientConnectionId(role.external)) === cleanId)
        .map(([id]) => id);
      if (!doc.externalClients?.[cleanId] && boundRoleIds.length === 0) {
        throw new SettingsUpdateError(400, "外部客户端尚未连接。");
      }
      const directRoleId = directExternalClientRoleId(cleanId);
      const tasks = await tx.doc(KuloStateDoc);
      const hasActiveTask = Object.values(tasks.tickets).some((ticket) => {
        if (!isTicketUnfinished(ticket)) return false;
        if (boundRoleIds.includes(ticket.role) || ticket.role === directRoleId) return true;
        if (ticket.externalExecution && externalClientConnectionId(ticket.externalExecution.binding) === cleanId) return true;
        return false;
      });
      if (hasActiveTask) {
        throw new SettingsUpdateError(409, "请先停止或完成该客户端下智能体的未结束任务。");
      }
      const nextRoles = cloneJson(doc.roles);
      for (const id of boundRoleIds) {
        const role = nextRoles[id];
        if (!role) continue;
        delete role.external;
        delete role.externalClientId;
        delete role.dispatchPolicy;
        delete role.modelId;
        delete role.provider;
        delete role.serviceTier;
        role.thinkingLevel = "auto";
      }
      applySettingsBlockUpdate(doc, "roles", expectedRevision ?? doc.revisions.roles, nextRoles, {
        externalAgents: true,
        removeClientIds: [cleanId],
        summaryOverride: `移除外部客户端连接（${cleanId}）`,
      });
      return cloneJson(doc) as KuloDurableSettings;
    }, context);
    await this.#applyLiveSettings(nextDoc, context);
    const view = this.getSettingsView();
    this.#emitSettings(view);
    return { settings: view };
  }

  async rollbackSettings(
    toRevision: number,
    expectedGlobalRevision: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ settings: KuloSettingsView; summary: string }> {
    const { nextDoc, summary } = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      const state = await tx.doc(KuloStateDoc);
      if (Object.values(state.tickets).some((ticket) => ticket.status === "running")) {
        throw new SettingsUpdateError(400, "请先停止正在运行的后台任务，再恢复历史设置。");
      }
      const msg = rollbackSettingsToSnapshot(doc, toRevision, expectedGlobalRevision, this.config.memory);
      assertMemoryIdentitySeparation(doc.memory, this.config, this.envManager);
      return {
        nextDoc: cloneJson(doc) as KuloDurableSettings,
        summary: msg,
      };
    }, context);

    await this.#applyLiveSettings(nextDoc, context);
    await this.archiveInactiveTopics(context);
    const view = this.getSettingsView();
    this.#emitSettings(view);
    await this.#broadcastTickets(context);
    return { settings: view, summary };
  }

  async probeMemory(signal?: AbortSignal): Promise<HindsightProbeResult> {
    return probeHindsightConnection(this.#liveSettings.memory, signal);
  }

  async probeModel(
    draft?: ModelProbeRequest,
    signal?: AbortSignal,
  ): Promise<ModelProbeResult> {
    const saved = normalizeModelConfig(this.#liveSettings.model);
    const providerId = draft?.providerId?.trim();
    if (providerId) {
      const custom = saved.customProviders.find((provider) => provider.id === providerId);
      const gateway = providerId === KULO_GATEWAY_PROVIDER_ID;
      if (!gateway && !custom) throw new SettingsUpdateError(400, "未找到要检测的 API 连接。");
      const connection = custom ?? { baseUrl: saved.baseUrl, api: saved.apiMode, vertexProject: saved.vertexProject, vertexLocation: saved.vertexLocation };
      const baseUrl = draft?.baseUrl?.trim() || connection.baseUrl;
      const apiKey = draft?.apiKey?.trim() ? undefined : await this.#providerManager?.resolveProbeApiKey(providerId, baseUrl);
      return probeOpenAICompatibleGateway(saved, draft, signal, {
        baseUrl: connection.baseUrl, api: connection.api, apiKey,
        model: gateway ? saved.defaultModel : custom?.models[0]?.id || (saved.defaultProvider === providerId ? saved.defaultModel : ""),
        vertexProject: connection.vertexProject, vertexLocation: connection.vertexLocation,
      });
    }
    return probeOpenAICompatibleGateway(
      saved,
      draft,
      signal,
    );
  }

  async computeUsageStats(
    range: "today" | "7" | "30" = "today",
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<UsageStatsView> {
    const now = Date.now();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (range !== "today") {
      start.setDate(start.getDate() - (Number(range) - 1));
    }
    const fromMs = start.getTime();

    const state = await this.harness.snapshot(KuloStateDoc, context);
    const convIds = new Set<number>([Number(ROOT_CONVERSATION_ID)]);
    for (const t of Object.values(state?.topics ?? {})) {
      convIds.add(t.conversationId);
    }
    for (const tk of Object.values(state?.tickets ?? {})) {
      convIds.add(tk.workerConversationId);
    }
    for (const sub of Object.values(state?.subagents ?? {})) {
      convIds.add(sub.conversationId);
    }
    for (const conversationId of await this.settingsAssistant.conversationIds()) convIds.add(conversationId);
    for (const conversationId of (await this.harness.snapshot(RelationshipReviewsDoc, context))?.conversationIds ?? []) convIds.add(conversationId);
    for (const job of Object.values(state?.topicTitles ?? {})) {
      if (job.conversationId !== undefined) convIds.add(job.conversationId);
    }

    let totalTokens = 0;
    let totalInput = 0;
    let totalCacheRead = 0;
    let turns = 0;
    const byModel = new Map<string, UsageModelItem>();

    for (const cid of convIds) {
      try {
        const conv = await this.harness.conversation(cid as ConversationId, context);
        if (!conv) continue;
        const watch = await conv.watch(context, { min: 100, max: 200 });
        const entries = watch.value.entries;
        await watch.stop();

        for (const entry of entries) {
          if (!AssistantEntry.is(entry)) continue;
          const ts = entryTimestamp(entry);
          if (ts !== undefined && ts < fromMs) continue;

          const msg = entry.model?.[0] as
            | {
                model?: string;
                provider?: string;
                usage?: {
                  input?: number;
                  output?: number;
                  cacheRead?: number;
                  cacheWrite?: number;
                  totalTokens?: number;
                };
              }
            | undefined;
          if (!msg) continue;

          turns += 1;
          const u = msg.usage;
          const input = Number(u?.input ?? 0) || 0;
          const output = Number(u?.output ?? 0) || 0;
          const cacheRead = Number(u?.cacheRead ?? 0) || 0;
          const cacheWrite = Number(u?.cacheWrite ?? 0) || 0;
          const tok =
            typeof u?.totalTokens === "number" && u.totalTokens > 0
              ? u.totalTokens
              : input + output + cacheRead + cacheWrite;

          totalTokens += tok;
          totalInput += input + cacheRead + cacheWrite;
          totalCacheRead += cacheRead;

          const modelId = msg.model || this.#liveSettings.model.defaultModel;
          const provider = msg.provider || this.#providerId;
          const key = `${provider}/${modelId}`;
          const cur = byModel.get(key) ?? { model: modelId, provider, totalTokens: 0, turns: 0 };
          cur.totalTokens += tok;
          cur.turns += 1;
          cur.inputTokens = (cur.inputTokens ?? 0) + input + cacheRead + cacheWrite;
          cur.cacheReadTokens = (cur.cacheReadTokens ?? 0) + cacheRead;
          cur.cacheWriteTokens = (cur.cacheWriteTokens ?? 0) + cacheWrite;
          if (cur.inputTokens > 0) cur.cacheHitRate = cur.cacheReadTokens / cur.inputTokens;
          byModel.set(key, cur);
        }
      } catch {
        // Ignore missing conversation
      }
    }

    const models = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    return {
      range,
      totalTokens,
      turns,
      ...(totalInput > 0 ? { cacheHitRate: totalCacheRead / totalInput } : {}),
      models,
    };
  }

  async readIdentityFiles(file?: IdentityFile): Promise<IdentityList | IdentityRead> {
    if (file === "identity-agreement.md") return this.personality.readIdentity();
    if (file) return this.identityFiles.read(file);
    return this.identityFiles.list();
  }

  async proposeIdentity(content: string, summary: string) {
    return this.personality.proposeIdentity(content, summary);
  }

  async updateRelationship(request: import("@kulo/protocol").RelationshipWriteRequest) {
    return this.personality.saveRelationship(request);
  }

  async getRecentWork(topicId = "root", context: Context = BACKGROUND_CONTEXT): Promise<RecentWorkSnapshot> {
    const [state, projects, personality] = await Promise.all([
      this.harness.snapshot(KuloStateDoc, context),
      this.harness.snapshot(KuloProjectsDoc, context),
      this.personality.snapshot(),
    ]);
    const topic = state?.topics?.[topicId];
    if (!topic || topic.deletedAt) throw new ProjectError(404, "topic_not_found", "会话不存在。");
    return buildRecentWorkSnapshot({ state, projects, conversationId: topic.conversationId,
      enabled: personality.settings.recentWorkEnabled });
  }

  async #collectRelationshipInput(since: number): Promise<{ cursor: number; content: string }> {
    const progress = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(RelationshipEvidenceDoc);
      if (doc.pending?.cursor === since) {
        doc.cursor = since;
        doc.entries = doc.pending.entries;
        doc.reports = doc.pending.reports;
        doc.pending = null;
      }
      if (doc.cursor !== since) throw new Error("协作关系的来源进度不一致，请重新检查。");
      return { cursor: doc.cursor, entries: { ...doc.entries }, reports: { ...doc.reports } };
    }, BACKGROUND_CONTEXT);
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const candidates: Array<{ at: number; text: string; conversationId?: string; entryId?: number; ticketId?: string; reportKey?: string }> = [];
    for (const topic of Object.values(state?.topics ?? {}).filter((item) => !item.deletedAt && !item.archived)) {
      const conversation = await this.harness.conversation(topic.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (!conversation) continue;
      const conversationId = String(topic.conversationId);
      let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
      let scanned = 0;
      do {
        const page = await conversation.entries({ minEntryId: ((progress.entries[conversationId] ?? 0) + 1) as EntryId, order: "ascending" }, 100, cursor, BACKGROUND_CONTEXT);
        for (const entry of page.items) {
          const relevant = UserEntry.is(entry) || KuloUserEntry.is(entry) || AssistantEntry.is(entry) || WorkerRelayEntry.is(entry);
          const evidence = VoiceTranscriptEntry.is(entry) ? [{ role: entry.data.role, text: entry.data.text }]
            : relevant ? extractDisplayMessages([entry]) : [];
          const messages = evidence.filter((item) =>
            ["user", "assistant", "relay"].includes(item.role) && item.text.trim() && isSafeMemoryText(item.text));
          const at = entryTimestamp(entry) ?? 0;
          candidates.push({ at, conversationId, entryId: Number(entry.id), text: messages.map((item) =>
            `[${topic.title} / ${item.role}${at ? ` / ${new Date(at).toISOString()}` : ""}]\n${item.text.slice(0, 2500)}`).join("\n\n") });
        }
        scanned += page.items.length;
        cursor = page.next;
      } while (cursor && scanned < 2000);
    }
    for (const ticket of Object.values(state?.tickets ?? {})) {
      const report = ticket.latestReport;
      const topic = ticket.originTopicId ? state?.topics?.[ticket.originTopicId] : undefined;
      if (topic?.deletedAt || topic?.archived || !report) continue;
      const reportKey = createHash("sha256").update(JSON.stringify([report.at, report.state, report.summary])).digest("hex");
      if (progress.reports[ticket.id] === reportKey) continue;
      candidates.push({ at: report.at, ticketId: ticket.id, reportKey, text: isSafeMemoryText(report.summary)
        ? `[任务 ${ticket.title} / ${report.state}]\n${report.summary.slice(0, 1200)}` : "" });
    }
    // Each conversation advances in committed-entry order. Generation-start timestamps
    // cannot be a completion cursor: an answer can commit after an earlier review.
    candidates.sort((a, b) => (a.conversationId ?? `~${a.ticketId}`).localeCompare(b.conversationId ?? `~${b.ticketId}`) ||
      (a.entryId ?? 0) - (b.entryId ?? 0));
    const selected: string[] = [];
    let size = 0;
    for (const candidate of candidates) {
      if (size + candidate.text.length > 48_000 && selected.length) break;
      if (candidate.conversationId && candidate.entryId !== undefined) progress.entries[candidate.conversationId] = candidate.entryId;
      if (candidate.ticketId && candidate.reportKey) progress.reports[candidate.ticketId] = candidate.reportKey;
      if (candidate.text) { selected.push(candidate.text); size += candidate.text.length; }
    }
    const nextCursor = Math.max(Date.now(), since + 1);
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(RelationshipEvidenceDoc);
      doc.pending = { cursor: nextCursor, entries: progress.entries, reports: progress.reports };
    }, BACKGROUND_CONTEXT);
    return { cursor: nextCursor, content: selected.join("\n\n") };
  }

  async #canReviewRelationship(): Promise<boolean> {
    if (this.#closed || this.#recovering) return false;
    const [state, settingsAssistant] = await Promise.all([
      this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT),
      this.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT),
    ]);
    const conversationIds = new Set([
      Number(this.rootConversation.id),
      ...Object.values(state?.topics ?? {}).filter((topic) => !topic.deletedAt).map((topic) => topic.conversationId),
      ...(settingsAssistant?.conversationId == null ? [] : [settingsAssistant.conversationId]),
    ]);
    const activity = await Promise.all([...conversationIds].map(async (id) => {
      const [live, inbox] = await Promise.all([
        this.harness.snapshot(LiveDoc, id as ConversationId, BACKGROUND_CONTEXT),
        this.harness.snapshot(InboxDoc, id as ConversationId, BACKGROUND_CONTEXT),
      ]);
      return Boolean(live?.run || inbox?.items.length || live?.compactions?.some((item) => item.blocking));
    }));
    return !activity.some(Boolean);
  }

  async #reviewRelationship(input: { current: string; updates: string; signal: AbortSignal }): Promise<{ content: string | null; summary?: string; defer?: boolean; skipReason?: string }> {
    if (input.signal.aborted) throw new Error("协作关系更新已取消。");
    if (!await this.#canReviewRelationship()) return { content: null, defer: true };
    if (!this.#liveSettings.model.defaultModel.trim()) throw new Error("请先配置主模型，再更新协作关系。");
    const [state, projects, forgottenTerms] = await Promise.all([
      this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT),
      this.harness.snapshot(KuloProjectsDoc, BACKGROUND_CONTEXT),
      this.personality.getForgottenTerms(),
    ]);
    const currentActivity = {
      foregroundBusy: false,
      work: buildRecentWorkSnapshot({ state, projects, conversationId: Number(this.rootConversation.id) }).content,
    };
    const agent = this.#resolveOrchestratorAgent();
    const conversation = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
      ...agent, extensions: [this.#redactionExt], maxTurns: 1,
      instructions: RELATIONSHIP_REVIEW_INSTRUCTIONS,
    } }, BACKGROUND_CONTEXT);
    await this.harness.commit(async (tx) => {
      const reviews = await tx.doc(RelationshipReviewsDoc);
      reviews.conversationIds = [...reviews.conversationIds, Number(conversation.id)].slice(-128);
    }, BACKGROUND_CONTEXT);
    const abort = () => { void conversation.abort(BACKGROUND_CONTEXT).catch((error) => console.error("[KuloRelationshipAbort]", error)); };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal.aborted) throw new Error("协作关系更新已取消。");
      const submission = await conversation.submit({ type: "input", whenBusy: "reject",
        content: JSON.stringify({
          current: input.current,
          newConversationEvidence: input.updates,
          currentActivity,
          ...(forgottenTerms.length ? { forgottenTerms: forgottenTerms.map((item) => item.term) } : {}),
        }) }, BACKGROUND_CONTEXT);
      await submission.wait(BACKGROUND_CONTEXT);
      if (input.signal.aborted) throw new Error("协作关系更新已取消。");
      const page = await conversation.entries({}, 10, undefined, BACKGROUND_CONTEXT);
      const entry = page.items.find((item) => AssistantEntry.is(item));
      if (!entry || !AssistantEntry.is(entry)) throw new Error("主模型未返回协作关系检查结果。");
      const message = entry.model?.[0];
      if (!message || message.role !== "assistant") throw new Error("主模型未返回有效的协作关系检查结果。");
      if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") throw new Error("主模型未完整完成协作关系检查。");
      const raw = message.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
      return validateRelationshipReviewDecision(raw, input.current, forgottenTerms);
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  }

  async setAgentExpression(
    face: AgentFace | "auto",
    cue: string | undefined,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<AgentExpressionState | null> {
    const now = Date.now();
    const cleanCue = cue?.trim() ? cue.trim().slice(0, 24) : undefined;
    const nextExpr: AgentExpressionState | null =
      face === "auto"
        ? null
        : {
            face,
            ...(cleanCue ? { cue: cleanCue } : {}),
            updatedAt: now,
            expiresAt: now + (face === "thinking" || face === "working" ? 60_000 : 20_000),
          };

    const nextDoc = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      doc.expression = nextExpr;
      return cloneJson(doc) as KuloDurableSettings;
    }, context);

    this.#liveSettings.expression = nextDoc.expression;
    for (const listener of this.#listeners) {
      listener.onExpression?.(nextExpr);
    }
    return nextExpr;
  }

  async hasSubmittedRequest(
    topicId = "root",
    requestId?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<boolean> {
    const clean = requestId?.trim();
    if (!clean) return false;
    const cache = await this.#resolveWatchedTopic(topicId, context);
    if (await this.harness.commit((tx) => tx.submissionByRequest(cache.conversation.id, clean), context)) return true;
    const snap = await this.harness.snapshot(KuloStateDoc, context);
    return Boolean(snap?.processedCommands?.[`req:${cache.topicId}:${clean}`]);
  }

  async #deliveryReceipt(intent: DeliveryIntent, context: Context): Promise<Readonly<DeliveryReceipt> | undefined> {
    const receipt = await this.harness.snapshot(DeliveryReceiptDoc, intent.key, context);
    assertDeliveryIntent(receipt, intent);
    if (receipt) return receipt;
    const legacy = await this.harness.snapshot(DeliveryReceiptDoc, intent.legacyKey, context);
    if (!legacy) return undefined;
    assertDeliveryIntent(legacy, { ...intent, fingerprint: intent.legacyFingerprint });
    if (legacy.phase === "empty") return undefined;
    const phase = legacy.phase;
    await this.harness.commit((tx) => writeDeliveryReceipt(tx, intent, legacy.ack as DeliveryAck, phase, legacy.continuation), context);
    return { ...legacy, fingerprint: intent.fingerprint };
  }

  async #withDelivery<T>(intent: DeliveryIntent | undefined, context: Context,
    operation: (receipt?: Readonly<DeliveryReceipt>) => Promise<T>, replay: (receipt: Readonly<DeliveryReceipt>) => Promise<T>): Promise<T> {
    if (!intent) return operation();
    const previous = this.#deliveryAdmissions.get(intent.key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const receipt = await this.#deliveryReceipt(intent, context);
      if (receipt && receipt.phase !== "empty") intent.replayed = true;
      if (receipt?.phase === "complete") {
        return replay(receipt);
      }
      if (!receipt || receipt.phase === "empty") {
        const state = await this.harness.snapshot(KuloStateDoc, context);
        if (state?.processedCommands?.[intent.id] || state?.commandIndex[intent.id]) legacyDeliveryConflict();
        for (const [key, command] of Object.entries(state?.processedCommands ?? {})) {
          if (command.action === "chat.send" && key === `req:${command.ticketId}:${intent.id}` &&
            (intent.action !== "chat.send" || intent.topicId !== command.ticketId)) legacyDeliveryConflict();
        }
      }
      return operation(receipt);
    });
    this.#deliveryAdmissions.set(intent.key, current);
    void current.then(() => { if (this.#deliveryAdmissions.get(intent.key) === current) this.#deliveryAdmissions.delete(intent.key); },
      () => { if (this.#deliveryAdmissions.get(intent.key) === current) this.#deliveryAdmissions.delete(intent.key); });
    return current;
  }

  async #receiptTicket(receipt: Readonly<DeliveryReceipt>, context: Context): Promise<TicketCardView> {
    const ticketId = String(receipt.ack.ticketId);
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) throw new Error(`Stored delivery refers to a missing ticket '${ticketId}'`);
    return toTicketCardView(ticket, this.#liveSettings.roles);
  }

  async deliverClientMessage(message: ReliableClientMessage, principalId = this.envManager.localEnvId, context: Context = BACKGROUND_CONTEXT,
    source?: ChatMessageSource): Promise<DeliveryAck & { deduplicated?: boolean }> {
    if (this.#handoverBarrierActive && message.type !== "chat.abort") {
      throw new ProjectError(503, "cluster_handover_in_progress", "主机正在切换，请稍候。");
    }
    validateReliableClientMessage(message);
    const intent = clientDeliveryIntent(message, principalId);
    let fallback: DeliveryAck;
    switch (message.type) {
      case "chat.send": {
        const submission = await this.sendUserMessage(message.content, { topicId: message.topicId || "root", requestId: message.requestId,
          attachments: message.attachments, replyTo: message.replyTo, whenBusy: message.whenBusy, targetDeviceId: message.targetDeviceId, principalId, source, deliveryIntent: intent }, context);
        const status = await submission.status(context);
        fallback = { topicId: message.topicId || "root", submissionId: Number(status.id), delivery: status.status === "queued" ? "queued" : "accepted" };
        break;
      }
      case "chat.abort":
        await this.abortForegroundTurn(message.topicId || "root", context, intent);
        fallback = { topicId: message.topicId || "root" }; break;
      case "chat.retry":
        await this.retryTurn(message.topicId || "root", message.requestId, context, intent);
        fallback = { topicId: message.topicId || "root" }; break;
      case "ticket.steer":
        await this.steerTicket({ ticketId: message.ticketId, text: message.text, attachments: message.attachments,
          replyTo: message.replyTo, decisionOptionId: message.decisionOptionId, commandId: message.commandId ?? `steer-${randomUUID()}`, principalId }, context, intent);
        fallback = { ticketId: message.ticketId }; break;
      case "ticket.retry":
        await this.retryTicket(message.ticketId, context, message.commandId, intent);
        fallback = { ticketId: message.ticketId }; break;
      case "ticket.stop":
        await this.stopTicket(message.ticketId, message.reason, context, message.commandId, undefined, intent);
        fallback = { ticketId: message.ticketId }; break;
      case "ticket.close":
        await this.closeTicket({ ticketId: message.ticketId, commandId: message.commandId ?? `close-${randomUUID()}`,
          reason: message.reason, kind: message.kind, replacementTicketId: message.replacementTicketId }, context, intent);
        fallback = { ticketId: message.ticketId }; break;
      case "schedule.stop":
        await this.stopScheduledTask(message.ticketId, context, intent);
        fallback = { ticketId: message.ticketId }; break;
      case "schedule.delete":
        await this.deleteScheduledTask(message.ticketId, context, intent);
        fallback = { ticketId: message.ticketId }; break;
      case "assistant.item_action": {
        const res = await this.assistantCoordinator.performItemAction({
          itemId: message.itemId,
          expectedRevision: message.expectedRevision,
          action: message.action,
          intent,
          context,
        });
        return { ...res.ack, ...(res.deduplicated ? { deduplicated: true } : {}) };
      }
    }
    const receipt = intent ? await this.#deliveryReceipt(intent, context) : undefined;
    return { ...(receipt?.phase === "complete" ? receipt.ack as DeliveryAck : fallback), ...(intent?.replayed ? { deduplicated: true } : {}) };
  }

  async hasProcessedCommand(
    commandId?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<boolean> {
    const clean = commandId?.trim();
    if (!clean) return false;
    const receipt = await this.harness.snapshot(DeliveryReceiptDoc, deliveryReceiptKey(clean), context);
    if (receipt && receipt.phase !== "empty") return true;
    const snap = await this.harness.snapshot(KuloStateDoc, context);
    return Boolean(snap?.processedCommands?.[clean] || snap?.commandIndex[clean]);
  }

  async #bindChatTarget(topicId: string, conversationId: number, requested: string | undefined, requestKey: string | undefined, context: Context): Promise<string> {
    if (requested !== undefined && (typeof requested !== "string" || requested.length > 256 || /[\u0000-\u001f]/.test(requested))) {
      throw new ProjectError(400, "invalid_target_device", "目标设备标识无效。");
    }
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const topic = state?.topics?.[topicId];
    if (!topic || topic.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
    const key = requestKey ? chatRequestTargetKey(conversationId, requestKey) : undefined;
    const recorded = key === undefined ? undefined : state?.chatRequestTargets?.[key];
    const clean = requested?.trim();
    if (recorded !== undefined && clean !== undefined && clean !== recorded) throw new ProjectError(409, "request_intent_conflict", "已提交消息的目标设备不能更改。");
    const target = recorded ?? clean ?? topic.targetDeviceId ?? "";
    const changed = target !== (topic.targetDeviceId ?? "");
    if (recorded !== undefined && !changed) return target;
    if (changed) {
      if (target && !this.envManager.getEnvDescriptor(target)?.online) throw new ProjectError(409, "target_device_unavailable", "目标设备尚未连接。");
      const [live, inbox] = await Promise.all([
        this.harness.snapshot(LiveDoc, conversationId as ConversationId, context),
        this.harness.snapshot(InboxDoc, conversationId as ConversationId, context),
      ]);
      if (live?.run || inbox?.items.length) throw new ProjectError(409, "target_device_busy", "请等待当前回复结束，再切换目标设备。");
    }
    await this.harness.commit(async (tx) => {
      const next = await tx.doc(KuloStateDoc);
      const current = next.topics?.[topicId];
      if (!current || current.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
      if (key) {
        next.chatRequestTargets ??= {};
        const prior = next.chatRequestTargets[key];
        if (prior !== undefined && prior !== target) throw new ProjectError(409, "request_intent_conflict", "已提交消息的目标设备不能更改。");
        next.chatRequestTargets[key] = target;
      }
      if (target) current.targetDeviceId = target;
      else delete current.targetDeviceId;
    }, context);
    return target;
  }

  /** Submit a user message to the selected topic conversation (defaults to `"root"`). */
  async sendUserMessage(
    content: string,
    options: MessageSubmissionOptions = {},
    context: Context = BACKGROUND_CONTEXT,
  ) {
    assertValidReplyReference(options.replyTo);
    const key = options.topicId || "root";
    const principalId = options.principalId ?? this.envManager.localEnvId;
    const receivedAt = Date.now();
    const intent = options.deliveryIntent ?? clientDeliveryIntent({ type: "chat.send", topicId: key, requestId: options.requestId,
      content, attachments: options.attachments, replyTo: options.replyTo, whenBusy: options.whenBusy, targetDeviceId: options.targetDeviceId,
      ...(options.voiceDelegation ? { voiceDelegation: true } : {}) }, principalId);
    return this.#withDelivery(intent, context,
      (receipt) => this.#queueChatOperation(key, async () => {
        if (receipt?.phase === "admitted" && intent) {
          if (receipt.continuation.error === "topic_deleted") throw new ProjectError(404, "topic_deleted", "会话已删除。");
          if (receipt.continuation.error === "attachment_forbidden") throw new ProjectError(403, "attachment_forbidden", "无权引用此附件。");
          const pending = (await this.harness.snapshot(PendingChatAttachmentsDoc, context))?.messages[intent.key];
          if (!pending) throw new Error("Missing admitted chat attachment delivery");
          return this.#replayChatDraft(pending, intent.key, context);
        }
        return this.#sendUserMessage(content, { ...options, principalId }, context, receivedAt, intent);
      }),
      async (receipt) => {
        const submission = await this.harness.submission(Number(receipt.ack.submissionId) as never, context);
        if (!submission) throw new Error("Stored delivery refers to a missing submission");
        // Older senders could commit a complete receipt before adding the upload scope.
        const attachments = options.attachments;
        if (attachments?.length && !receipt.continuation.attachmentsBound) {
          const record = await submission.status(context);
          if (record.type !== "input" || record.requestId !== intent?.id || receipt.ack.topicId !== key) legacyDeliveryConflict();
          await this.harness.commit(async tx => {
            await bindChatAttachments(tx, this.uploads, { topicId: key, conversationId: Number(record.conversationId) }, attachments, principalId);
            await writeDeliveryReceipt(tx, intent, receipt.ack as DeliveryAck, "complete", { attachmentsBound: true });
          }, context);
          const cache = this.#topicCaches.get(key);
          if (cache) this.#refreshTopicContent(cache);
        }
        return submission;
      });
  }

  #queueChatOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#chatAdmissions.get(key) ?? Promise.resolve();
    const submission = previous.catch(() => {}).then(operation);
    this.#chatAdmissions.set(key, submission);
    void submission.then(() => { if (this.#chatAdmissions.get(key) === submission) this.#chatAdmissions.delete(key); },
      () => { if (this.#chatAdmissions.get(key) === submission) this.#chatAdmissions.delete(key); });
    return submission;
  }

  #queueTicketOperation<T>(ticketId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#ticketAdmissions.get(ticketId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#ticketAdmissions.set(ticketId, current);
    void current.then(() => { if (this.#ticketAdmissions.get(ticketId) === current) this.#ticketAdmissions.delete(ticketId); },
      () => { if (this.#ticketAdmissions.get(ticketId) === current) this.#ticketAdmissions.delete(ticketId); });
    return current;
  }

  async #sendUserMessage(content: string, options: MessageSubmissionOptions & { principalId: string }, context: Context, receivedAt: number, intent?: DeliveryIntent) {
    const targetTopicId = options.topicId || "root";
    const cache = await this.#resolveWatchedTopic(targetTopicId, context);
    const cleanReqId = options.requestId?.trim();
    const repeated = cleanReqId ? await this.harness.commit((tx) => tx.submissionByRequest(cache.conversation.id, cleanReqId), context) : undefined;
    if (repeated) {
      if (repeated.type !== "input") throw Object.assign(new Error("消息标识已用于另一项操作。"), { code: "request_intent_conflict", status: 409 });
      await this.harness.commit(async (tx) => {
        const current = await tx.submissionByRequest(cache.conversation.id, cleanReqId!);
        if (!current || current.type !== "input" || options.voiceDelegation) legacyDeliveryConflict();
        let stored: { text: string; attachments: ChatAttachment[]; replyTo?: ChatReplyReference } | undefined;
        let queueMode: "steer" | "followUp" | undefined;
        if (current.entry !== undefined) {
          const entry = await tx.entry(current.entry);
          const model = entry?.model?.[0];
          if (entry) stored = legacyUserPayload(entry.kind, entry.data, model?.role === "user" ? model.content : undefined);
        } else {
          const inbox = await tx.doc(InboxDoc, cache.conversation.id);
          const pending = inbox.items.find(item => item.id === current.id);
          if (pending && pending.mode !== "write") {
            queueMode = pending.mode;
            stored = legacyUserPayload(pending.entry?.kind ?? UserEntry.kind, pending.entry?.data,
              pending.content as Parameters<typeof parseUserEntryContent>[0]);
          }
        }
        assertLegacyChatPayload(stored, content, options.attachments ?? [], options.replyTo);
        if ((options.whenBusy ?? "steer") !== (queueMode ?? "steer")) legacyDeliveryConflict();
        if (options.targetDeviceId !== undefined) {
          const state = await tx.doc(KuloStateDoc);
          const targetKey = chatRequestTargetKey(Number(cache.conversation.id), `req:${cache.topicId}:${cleanReqId}`);
          const target = state.chatRequestTargets?.[targetKey];
          if (target === undefined || target !== options.targetDeviceId.trim()) legacyDeliveryConflict();
        }
        if (options.attachments?.length) {
          await bindChatAttachments(tx, this.uploads, { topicId: cache.topicId, conversationId: Number(cache.conversation.id) }, options.attachments, options.principalId);
        }
        await writeDeliveryReceipt(tx, intent, { topicId: cache.topicId, submissionId: Number(current.id),
          delivery: current.status === "queued" ? "queued" : "accepted" }, "complete", options.attachments?.length ? { attachmentsBound: true } : {});
      }, context);
      if (intent) intent.replayed = true;
      const submission = await this.harness.submission(repeated.id, context);
      if (!submission) throw new Error("Stored request refers to a missing submission");
      return submission;
    }
    if (!this.#liveSettings.model.defaultModel.trim()) {
      throw Object.assign(
        new Error("请先选择供应商和模型，再发送消息。"),
        { code: "model_not_selected" },
      );
    }
    if (Array.isArray(options.attachments) && options.attachments.length > 0) {
      for (const att of options.attachments) {
        if (!att?.id || !this.uploads.getUpload(att.id)) {
          throw Object.assign(
            new Error(`附件 '${att?.name || att?.id || "unknown"}' 不存在或已失效，请重新上传后再发送。`),
            { code: "attachment_not_found" },
          );
        }
      }
    }
    if (options.attachments?.length) {
      const canReadScope = await snapshotChatUploadScope(this.harness, context);
      if (options.attachments.some(asset => !this.uploads.canReadUpload(asset.id, options.principalId, canReadScope))) {
        throw Object.assign(new Error("无权引用此附件。"), { code: "attachment_forbidden", status: 403 });
      }
    }
    const reqKey = cleanReqId ? `req:${cache.topicId}:${cleanReqId}` : undefined;
    const targetDeviceId = await this.#bindChatTarget(cache.topicId, Number(cache.conversation.id), options.targetDeviceId, reqKey, context);
    content = (await this.connectionManager.processText(content, {
      requestId: cleanReqId ? `chat:${cache.topicId}:${cleanReqId}` : undefined, replyText: options.replyTo?.text,
    })).text;
    // Pi's current message contract accepts text and images; an audio modality label alone does not add an audio transport.
    for (const { record } of this.uploads.resolveAttachments(options.attachments)) {
      if (record.kind === "audio") await this.transcribeVoiceAsset(record.id, { topicId: targetTopicId, principalId: options.principalId || this.envManager.localEnvId }, context);
    }
    const replyTo = options.replyTo ? {
      messageId: options.replyTo.messageId,
      role: options.replyTo.role,
      text: this.connectionManager.redact(options.replyTo.text),
      ...(options.replyTo.excerpt ? { excerpt: true } : {}),
    } : undefined;
    const agentDispatchIntent = extractAgentDispatchIntent(content, this.#liveSettings.roles, this.envManager.listEnvs(), this.#liveSettings.externalClients);
    const draft: ChatDeliveryDraft = {
      topicId: cache.topicId, conversationId: Number(cache.conversation.id), targetDeviceId, content, receivedAt, replyTo,
      principalId: options.principalId, requestId: cleanReqId, whenBusy: options.whenBusy ?? "steer",
      ...(options.source ? { source: { ...options.source, name: this.connectionManager.redact(options.source.name) } } : {}),
      attachmentIds: (options.attachments ?? []).map(asset => asset.id), agentDispatchIntent, voiceDelegation: options.voiceDelegation,
      receipt: intent && { key: intent.key, fingerprint: intent.fingerprint, action: intent.action },
    };
    const pendingKey = draft.attachmentIds.length ? draft.receipt?.key : undefined;
    const admitted = pendingKey ? await stageChatAttachments(this.harness, this.uploads, pendingKey, draft, context) : draft;
    return this.#submitChatDraft(cache, admitted, context, pendingKey);
  }

  async #recoverChatAttachments(context: Context): Promise<void> {
    const pending = await this.harness.snapshot(PendingChatAttachmentsDoc, context);
    for (const [key, draft] of Object.entries(pending?.messages ?? {}).sort(([, a], [, b]) => a.receivedAt - b.receivedAt)) {
      try {
        await this.#replayChatDraft(draft, key, context);
      } catch (error) {
        if (error instanceof ProjectError && ["topic_deleted", "topic_not_found", "attachment_forbidden"].includes(error.code)) {
          await this.harness.commit(async tx => {
            await removePendingChatAttachments(tx, key);
            await writeDeliveryReceipt(tx, draft.receipt, { topicId: draft.topicId }, "admitted", {
              error: error.code === "attachment_forbidden" ? error.code : "topic_deleted",
            });
          }, context);
          continue;
        }
        context.abortSignal?.throwIfAborted();
        if (error instanceof Error && error.name === "SessionFailed") throw error;
        // Keep the verified input for the sender's retry even if its upload is temporarily unavailable.
        console.warn("[KuloChat] Attachment delivery pending", draft.topicId, this.connectionManager.redact(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  async #replayChatDraft(draft: ChatDeliveryDraft, key: string, context: Context) {
    const cache = await this.#resolveWatchedTopic(draft.topicId, context);
    if (Number(cache.conversation.id) !== draft.conversationId) legacyDeliveryConflict();
    if (draft.requestId) await this.#bindChatTarget(draft.topicId, draft.conversationId, draft.targetDeviceId, `req:${draft.topicId}:${draft.requestId}`, context);
    return this.#submitChatDraft(cache, draft, context, key);
  }

  async #submitChatDraft(cache: WatchedTopicCache, draft: ChatDeliveryDraft, context: Context, pendingKey?: string) {
    const { content, replyTo, agentDispatchIntent } = draft;
    if (Number(cache.conversation.id) !== draft.conversationId) legacyDeliveryConflict();
    await this.#contextCompaction.pruneCommittedBaseline(cache.conversation.id, context, false).catch(() => {});
    const messageContext = {
      ...(draft.source ? { source: draft.source } : {}),
      ...(draft.requestId ? { requestId: draft.requestId } : {}),
      targetDeviceId: draft.targetDeviceId,
    };
    const sourceContext = draft.source || draft.targetDeviceId ? `[KULO_MESSAGE_SOURCE]\n${JSON.stringify(messageContext)}` : "";
    const modelContent = [replyContext(content, replyTo), sourceContext, agentDispatchIntent ? agentIntentContext(agentDispatchIntent) : ""].filter(Boolean).join("\n\n");
    const prepared = this.uploads.buildMultimodalContent(modelContent, draft.attachmentIds);
    const capturedIntent: AgentDispatchIntent = agentDispatchIntent ?? { version: 1, targets: [] };
    const displayEntry = draft.voiceDelegation ? { kind: "kulo.voice.delegation", data: { ...messageContext, agentDispatchIntent: cloneJson(capturedIntent) } as unknown as JsonObject } : userDisplayEntry(content, prepared.attachments, {
      ...messageContext, createdAt: draft.receivedAt,
      agentDispatchIntent: capturedIntent,
    }, replyTo);

    const userPreview = draft.voiceDelegation
      ? undefined
      : summarizeTopicPreview([{ role: "user", text: this.connectionManager.redact(content), createdAt: draft.receivedAt }]);

    // Keep an immediate fallback while the first completed reply supplies context for a generated title.
    const { allTopics, pendingTitle, submissionId } = await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      assertChatDestination(state, draft);
      const live = await tx.doc(LiveDoc, cache.conversation.id);
      const inbox = await tx.doc(InboxDoc, cache.conversation.id);
      const queued = Boolean(live.run || inbox.items.length);
      if (draft.requestId) {
        recordProcessedCommand(state, `req:${cache.topicId}:${draft.requestId}`, cache.topicId, "chat.send");
      }
      ensureDefaultRootTopic(state, this.#liveSettings.presentation.agentName);
      const t = state.topics?.[cache.topicId];
      if (t) {
        const now = Date.now();
        t.updatedAt = now;
        applyTopicPreview(t, userPreview, now);
        if (t.draft) {
          t.title = deriveAutoTopicTitle(
            content,
            prepared.attachments.map((a) => a.name),
          );
          delete t.draft;
          const titleJob = createTopicTitleJob(content, prepared.attachments.map((attachment) => attachment.name), t.title);
          if (titleJob) {
            state.topicTitles ??= {};
            state.topicTitles[cache.topicId] = titleJob;
          }
        }
      }
      if (draft.attachmentIds.length) {
        if ((t?.targetDeviceId ?? "") !== draft.targetDeviceId) throw new ProjectError(409, "target_device_busy", "目标设备已变更，请重试发送。");
        await bindChatAttachments(tx, this.uploads, draft, draft.attachmentIds, draft.principalId, draft.sourceScopes);
        if (pendingKey) await removePendingChatAttachments(tx, pendingKey);
      }
      const submissionId = await cache.conversation.submit(tx, { type: "input", content: prepared.content, entry: displayEntry,
        whenBusy: draft.whenBusy, ...(draft.requestId ? { requestId: draft.requestId } : {}) });
      await writeDeliveryReceipt(tx, draft.receipt, { topicId: cache.topicId, submissionId: Number(submissionId), delivery: queued ? "queued" : "accepted" },
        "complete", draft.attachmentIds.length ? { attachmentsBound: true } : {});
      return { allTopics: listSortedTopics(state), pendingTitle: state.topicTitles?.[cache.topicId]?.status === "pending", submissionId };
    }, context);
    this.#emitTopics(allTopics);

    if (pendingTitle) this.#topicTitles.track(cache.topicId);
    if (!this.#recovering) this.harness.resume();
    const submission = await this.harness.submission(submissionId, context);
    if (!submission) throw new Error("Admitted request has no submission");
    await this.#resumePausedChat(cache.conversation, context);
    this.#refreshTopicContent(cache);
    return submission;
  }

  /** Abort only the foreground Kulo turn in the target topic (background Workers continue undisturbed!). */
  async abortForegroundTurn(
    topicId = "root",
    context: Context = BACKGROUND_CONTEXT,
    intent?: DeliveryIntent,
  ): Promise<void> {
    return this.#withDelivery(intent, context,
      (receipt) => this.#queueChatOperation(topicId, () => this.#abortForegroundTurn(topicId, context, intent, receipt)),
      async () => {});
  }

  async #abortForegroundTurn(topicId: string, context: Context, intent?: DeliveryIntent, prior?: Readonly<DeliveryReceipt>): Promise<void> {
    const cache = await this.#resolveWatchedTopic(topicId, context);
    const taskId = prior?.phase === "admitted" ? prior.continuation.taskId : await this.harness.commit(async (tx) => {
      if (intent && await tx.submissionByRequest(cache.conversation.id, intent.id)) legacyDeliveryConflict();
      const state = await tx.doc(KuloStateDoc);
      const live = await tx.doc(LiveDoc, cache.conversation.id);
      state.pausedChats ??= {};
      state.pausedChats[String(cache.conversation.id)] ??= [];
      const taskId = live.run?.taskId;
      await writeDeliveryReceipt(tx, intent, { topicId }, taskId === undefined ? "complete" : "admitted",
        taskId === undefined ? {} : { taskId: Number(taskId) });
      return taskId;
    }, context);
    const current = await this.harness.snapshot(LiveDoc, cache.conversation.id, context);
    // A replay may finish an interrupted stop, but must never stop a later run in this conversation.
    if (typeof taskId === "number" && current?.run?.taskId === taskId) {
      await this.harness.abortTask(taskId as never, context);
      await this.harness.waitForTask(taskId as never, context);
    }
    await this.harness.commit((tx) => writeDeliveryReceipt(tx, intent, { topicId }), context);
    this.#refreshTopicContent(cache);
  }

  /** Retry the most recent unanswered turn in an idle topic without re-sending user input. */
  async retryTurn(
    topicId = "root",
    requestId?: string,
    context: Context = BACKGROUND_CONTEXT,
    suppliedIntent?: DeliveryIntent,
  ): Promise<{ retried: boolean }> {
    const intent = suppliedIntent ?? clientDeliveryIntent({ type: "chat.retry", topicId, requestId });
    return this.#withDelivery(intent, context,
      () => this.#queueChatOperation(topicId, () => this.#retryTurn(topicId, requestId, context, intent)),
      async (receipt) => ({ retried: receipt.continuation.retried === true }));
  }

  async #retryTurn(topicId: string, requestId: string | undefined, context: Context, intent?: DeliveryIntent): Promise<{ retried: boolean }> {
    const cache = await this.#resolveWatchedTopic(topicId, context);
    const retried = await this.harness.commit(async (tx) => {
      const prior = requestId ? await tx.submissionByRequest(cache.conversation.id, requestId) : undefined;
      if (prior && prior.type !== "continue") throw Object.assign(new Error("消息标识已用于另一项操作。"), { code: "request_intent_conflict", status: 409 });
      const live = await tx.doc(LiveDoc, cache.conversation.id);
      if (!prior && live.run) {
        await writeDeliveryReceipt(tx, intent, { topicId }, "complete", { retried: false });
        return false;
      }
      if (!prior) await cache.conversation.submit(tx, { type: "continue", ...(requestId ? { requestId } : {}) });
      await writeDeliveryReceipt(tx, intent, { topicId }, "complete", { retried: true });
      return true;
    }, context);
    if (retried) {
      this.harness.resume();
      await this.#resumePausedChat(cache.conversation, context);
    }
    return { retried };
  }

  async #resumePausedChat(conversation: Conversation, context: Context): Promise<void> {
    for (;;) {
      const admitted = await this.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const key = String(conversation.id);
        const deferred = state.pausedChats?.[key];
        if (!deferred) return false;
        const draft = deferred[0];
        if (!draft) { delete state.pausedChats![key]; return false; }
        // Each native admission and removal share a commit, so recovery cannot lose or repeat a report.
        await conversation.submit(tx, draft);
        deferred.shift();
        return true;
      }, context);
      if (!admitted) return;
    }
  }

  /** Dispatch a durable Worker Ticket onto Kulo's table. */
  async dispatchTicket(
    params: DispatchTicketParams,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<TicketCardView> {
    params = redactCredentialData(params, (text) => this.connectionManager.redact(text));
    const inputs = await this.#currentControlInputs(params.originConversationId, context, params.originToolTaskId);
    const recoveryGuard = inputs[0] && WorkerRecoveryEntry.is(inputs[0]) ? inputs[0].data : undefined;
    const originConversationId = params.originConversationId ?? Number(ROOT_CONVERSATION_ID);
    const activeRoles = this.#liveSettings.roles;
    const existingState = await this.harness.snapshot(KuloStateDoc, context);
    const modelDispatch = !params.parentTicketId && params.originToolTaskId !== undefined;
    const selectedInput = params.sourceRequestId ? inputs.find((input) => chatRoutingData(input).requestId === params.sourceRequestId) : inputs[0];
    if (params.sourceRequestId && (!modelDispatch || !selectedInput)) {
      throw new ProjectError(409, "source_message_unavailable", "请使用当前待处理消息的 requestId 指定任务来源。");
    }
    const dispatchSource = modelDispatch
      ? await this.#agentDispatchSource(params.originConversationId, params.originToolTaskId, context, params.sourceRequestId ? selectedInput?.id : undefined)
      : { intent: undefined, entryId: undefined, inheritedAssignment: undefined, input: undefined, continuing: false };
    const sender = chatRoutingData(modelDispatch ? selectedInput ?? dispatchSource.input : undefined);
    const checkAdmission = (state: Readonly<KuloDurableState> | undefined, paused: boolean) => {
      const existingId = state && Object.hasOwn(state.commandIndex, params.commandId) ? state.commandIndex[params.commandId] : undefined;
      const prior = existingId ? state?.tickets[existingId] : undefined;
      if (!prior) {
        if (paused) throw new Error("新任务派发当前已暂停，请先在「设置 -> 并发与运行」中恢复处理。");
        if (typeof params.commandId !== "string" || !params.commandId.trim() || ["__proto__", "constructor", "prototype"].includes(params.commandId)) {
          throw new ProjectError(400, "invalid_command_id", "派单标识无效。");
        }
        return;
      }
      if ((prior.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== originConversationId || prior.parentTicketId !== params.parentTicketId) {
        throw new ProjectError(409, "dispatch_command_conflict", "该派单标识已用于其他任务，请使用新的标识。");
      }
      if (dispatchSource.intent || dispatchSource.inheritedAssignment) {
        const choice = resolveAgentDispatch({ roles: activeRoles, externalClients: this.#liveSettings.externalClients, language: this.#liveSettings.presentation.language, ...dispatchSource, requestedRole: prior.role,
          taskKind: prior.agentAssignment?.taskKind ?? params.taskKind, projectId: prior.projectId, envId: prior.envId, trustedManual: true });
        if (choice.role !== prior.role) throw new ProjectError(409, "agent_binding_conflict", "该派单标识已经绑定其他 Agent，请为新的用户指派创建新任务。");
      }
      return prior;
    };
    const prior = checkAdmission(existingState, this.#liveSettings.executor.paused);
    if (prior) {
      bindDispatchedAttachments(this.uploads, prior);
      return toTicketCardView(prior, activeRoles);
    }
    const executeAt = params.executeAt === undefined ? undefined : Date.parse(params.executeAt);
    if (params.executeAt !== undefined && (typeof params.executeAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(params.executeAt) ||
        !Number.isSafeInteger(executeAt) || executeAt! < 0)) {
      throw new ProjectError(400, "invalid_schedule", "执行时间必须是带时区的有效 ISO 8601 时间。");
    }
    if (params.repeatEverySeconds !== undefined && (executeAt === undefined ||
        !Number.isSafeInteger(params.repeatEverySeconds) || params.repeatEverySeconds <= 0 ||
        params.repeatEverySeconds * 1000 > 8_640_000_000_000_000 - executeAt)) {
      throw new ProjectError(400, "invalid_schedule", "重复间隔必须是正整数秒，并指定首次执行时间。");
    }
    if (recoveryGuard && executeAt !== undefined) throw new ProjectError(403, "recovery_schedule_denied", "自动恢复不能新建定时计划。");
    if (existingState) assertRecoveryGuard(existingState, recoveryGuard);
    if (recoveryGuard && !params.projectId && !params.workspaceDir) params.workspaceDir = existingState!.tickets[recoveryGuard.ticketId]!.workspaceDir;
    const connectionIds = [...new Set(params.connectionIds ?? [])];
    let connectionRevisions: Record<string, number> = {};
    if (connectionIds.length > 32 || connectionIds.some((id) => typeof id !== "string" || !id.trim())) throw new Error("任务连接授权无效。");
    if (connectionIds.length) {
      const available = (await this.connectionManager.snapshot()).connections;
      const known = new Set(available.map((connection) => connection.id));
      if (connectionIds.some((id) => !known.has(id))) throw new Error("任务引用了不存在的连接。");
      connectionRevisions = Object.fromEntries(available.filter((connection) => connectionIds.includes(connection.id)).map((connection) => [connection.id, connection.revision]));
    }

    const settingsSnapshot = await this.harness.snapshot(SettingsAssistantDoc, context);
    const originIsSettings = !isOrchestratorConversation(originConversationId, existingState) && isActiveSettingsConversation(originConversationId, settingsSnapshot);
    const resolvedOriginTopicId = originIsSettings
      ? settingsTopicId(originConversationId)
      : existingState?.conversationToTopic?.[String(originConversationId)] ?? "root";
    const originTopic = originIsSettings ? undefined : existingState?.topics?.[resolvedOriginTopicId];
    if (originTopic?.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
    if (sender.source && dispatchSource.continuing && Object.values(existingState?.tickets ?? {}).some((ticket) =>
      ticket.originTopicId === resolvedOriginTopicId && !ticket.parentTicketId && !["stopped", "closed"].includes(ticket.status))) {
      throw new ProjectError(409, "continue_existing_ticket", "请使用 kulo_steer 继续所指的原工单，沿用其执行设备和任务范围。");
    }
    if (params.workspaceMode !== undefined && !["staged", "direct", "read_only"].includes(params.workspaceMode)) {
      throw new ProjectError(400, "invalid_workspace_mode", "工作区隔离模式无效。");
    }
    if (modelDispatch && params.workspaceMode === "direct") {
      throw new ProjectError(400, "invalid_workspace_mode", "项目写任务默认在隔离副本（staged）中执行，模型不能直接指定 direct 模式。");
    }
    if (params.targetScope !== undefined && !["hub_local", "sender_device"].includes(params.targetScope)) {
      throw new ProjectError(400, "invalid_target_scope", "任务目标位置参数无效。");
    }
    const contextSummary = params.contextSummary?.trim()
      ? this.connectionManager.redact(params.contextSummary.trim()).slice(0, 16_000)
      : undefined;
    const inputAttachmentIds = [...new Set((params.attachmentIds ?? []).map((id) => typeof id === "string" ? id.trim() : "").filter(Boolean))];
    if (inputAttachmentIds.length > 16 || (params.attachmentIds ?? []).some((id) => typeof id !== "string" || !id.trim())) {
      throw new ProjectError(400, "invalid_attachments", "派单附件标识无效或超过数量上限。");
    }
    if (inputAttachmentIds.length > 0) {
      const allowedScopes = new Set([`conversation:${originConversationId}`]);
      for (const existingTicket of Object.values(existingState?.tickets ?? {})) {
        if ((existingTicket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === originConversationId &&
            (existingTicket.originTopicId ?? "root") === resolvedOriginTopicId) {
          allowedScopes.add(`ticket:${existingTicket.id}`);
          allowedScopes.add(`conversation:${existingTicket.workerConversationId}`);
        }
      }
      for (const id of inputAttachmentIds) {
        const loaded = this.uploads.getUpload(id);
        if (!loaded) throw new ProjectError(400, "attachment_not_found", `附件 '${id}' 不存在或已失效。`);
        if (params.originToolTaskId !== undefined && !this.uploads.canReadUpload(id, `agent:${originConversationId}`, (scope) => allowedScopes.has(scope))) {
          throw new ProjectError(403, "attachment_forbidden", "当前对话无权将该附件传递给后台任务。");
        }
      }
    }
    if (params.executionDomain !== undefined && !["android", "computer"].includes(params.executionDomain)) throw new ProjectError(400, "invalid_execution_domain", "任务执行类型无效。");
    const recoveryTicket = recoveryGuard ? existingState?.tickets[recoveryGuard.ticketId] : undefined;
    const fixedTargetId = recoveryTicket
      ? (originTopic?.targetDeviceId || undefined)
      : (sender.targetDeviceId ?? originTopic?.targetDeviceId) || undefined;
    const fixedTarget = fixedTargetId ? this.envManager.getEnvDescriptor(fixedTargetId) : undefined;
    const proposedEnv = params.envId?.trim() || undefined;
    const envs = this.envManager.listEnvs();
    const localEnvId = this.envManager.localEnvId;
    const localEnv = this.envManager.getEnvDescriptor(localEnvId);
    const localReady = Boolean(localEnv?.online && hasWorkerIsolation(localEnv));
    const priorUserTurns = modelDispatch && !recoveryTicket
      ? await this.#recentPriorUserTurns(
          params.originConversationId,
          context,
          params.originToolTaskId,
          new Set(inputs.map((entry) => entry.id)),
        )
      : [];
    const namedEnvResolution = resolveNamedOrContextualEnv({
      currentText: sender.text,
      priorUserTurns,
      envs,
      proposedEnvId: proposedEnv,
      targetScope: params.targetScope,
      isRecovery: Boolean(recoveryTicket),
    });
    const namedEnv = namedEnvResolution?.envId;
    if (namedEnvResolution?.source === "current" && fixedTargetId && fixedTargetId !== namedEnv) {
      throw new ProjectError(409, "target_device_conflict", "消息中指定的设备与所选执行设备不同，请核对实际目标。");
    }
    const domainEnv = fixedTargetId ?? recoveryTicket?.envId ?? namedEnv ??
      (!sender.source || sender.source.deviceId === proposedEnv ? proposedEnv : undefined);
    const requestedProject = params.projectId?.trim() || (recoveryTicket ? recoveryTicket.projectId : originTopic?.projectId) || undefined;
    const namedAgent = dispatchSource.intent || dispatchSource.inheritedAssignment?.source === "explicit" || dispatchSource.inheritedAssignment?.source === "manual";
    const namedComputerAgent = dispatchSource.intent?.targets.some(({ kind, agentId }) => kind || (agentId && activeRoles[agentId]?.external)) ||
      (dispatchSource.inheritedAssignment && activeRoles[dispatchSource.inheritedAssignment.agentId]?.external);
    const inferSourcePhone =
      !domainEnv &&
      !requestedProject &&
      !namedComputerAgent &&
      params.targetScope !== "hub_local" &&
      inputAttachmentIds.length === 0 &&
      sender.source?.kind === "android";
    const executionDomain = params.executionDomain ?? recoveryTicket?.executionDomain ??
      (inferSourcePhone || this.envManager.getEnvDescriptor(domainEnv ?? "")?.executionKind === "native-device" ? "android" : "computer");
    const androidDeviceIds = [...new Set(params.androidDeviceIds ?? recoveryTicket?.androidDeviceIds ?? [])];
    if (androidDeviceIds.length > 8 || androidDeviceIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256)) throw new ProjectError(400, "invalid_android_targets", "任务手机范围无效。");
    if (executionDomain === "android" && (params.projectId?.trim() || params.workspaceDir?.trim())) throw new ProjectError(400, "android_workspace_denied", "纯手机任务不使用电脑项目或工作目录。");
    const projectId = executionDomain === "android" ? undefined : requestedProject;
    let project = projectId ? await this.projects.get(projectId, context) : undefined;
    if (project && namedEnvResolution?.source === "current" && namedEnv !== project.deviceId) throw new ProjectError(409, "project_binding_conflict", "消息中指定的设备与项目所属设备不同，请核对实际目标。");
    if (!project && modelDispatch && !recoveryTicket && fixedTargetId && fixedTarget?.executionKind !== "native-device") {
      if (proposedEnv && proposedEnv !== fixedTargetId) {
        const lockedName = fixedTarget?.name ?? fixedTargetId;
        throw new ProjectError(
          409,
          "target_device_conflict",
          `当前会话已锁定执行设备「${lockedName}」(${fixedTargetId})，不能改派到 ${proposedEnv}；请先切换或解除会话目标设备。`,
        );
      }
      if (
        !proposedEnv &&
        params.targetScope === "sender_device" &&
        sender.source?.kind === "computer" &&
        sender.source.deviceId !== fixedTargetId
      ) {
        const lockedName = fixedTarget?.name ?? fixedTargetId;
        throw new ProjectError(
          409,
          "target_device_conflict",
          `当前会话已锁定执行设备「${lockedName}」(${fixedTargetId})，不能按发信设备改派到「${sender.source.name}」；请先切换或解除会话目标设备。`,
        );
      }
    }
    const boundEnv = project?.deviceId ?? fixedTargetId ?? recoveryTicket?.envId ?? namedEnv;
    const sourceEnv = !boundEnv && sender.source?.kind === executionDomain &&
      (!this.envManager.isLocalEnv(sender.source.deviceId) || this.envManager.getEnvDescriptor(localEnvId)) ? sender.source.deviceId : undefined;
    const sourceRootDir = sourceEnv ? this.envManager.getEnvDescriptor(sourceEnv)?.rootDir : undefined;
    const senderLocalSignals = Boolean(
      sourceEnv &&
      executionDomain === "computer" &&
      detectSenderLocalSignals({
        userMessage: sender.text,
        goal: params.goal,
        scope: params.scope,
        senderRootDir: sourceRootDir,
      }),
    );
    // Scope default Agent selection to the Hub-verified target, never to a model guess.
    const activeExternalClients = this.#liveSettings.externalClients;
    const activeLanguage = this.#liveSettings.presentation.language;
    const proposedRole = resolveRoleOrDirectClient(params.role, activeRoles, activeExternalClients, activeLanguage);
    if (!namedAgent && proposedRole?.external) {
      if (boundEnv && !project && proposedRole.external.envId !== boundEnv) {
        throw new ProjectError(409, "agent_device_conflict", `指定的外部 Agent「${proposedRole.label}」绑定在设备 ${proposedRole.external.envId}，与当前目标设备 ${boundEnv} 不一致。`);
      }
      if (sourceEnv && (params.targetScope === "sender_device" || senderLocalSignals) && proposedRole.external.envId !== sourceEnv) {
        throw new ProjectError(409, "agent_device_conflict", `该任务涉及发信设备「${sender.source?.name}」本地环境，不能改派到绑定其他设备的外部 Agent「${proposedRole.label}」。`);
      }
    }
    const routingEnv = boundEnv ?? (
      params.originToolTaskId === undefined
        ? proposedEnv
        : namedAgent
          ? undefined
          : proposedRole?.external
            ? proposedRole.external.envId
            : executionDomain === "computer" && params.targetScope === "hub_local" && !senderLocalSignals && localReady
              ? localEnvId
              : sourceEnv
    );
    const requestedRole = params.role;
    const selectionRoles = androidDeviceIds.length || executionDomain === "android" ? Object.fromEntries(Object.entries(activeRoles).map(([id, role]) => [id, role.external ? { ...role, dispatchPolicy: undefined } : role])) : activeRoles;
    const routing = resolveAgentDispatch({ roles: selectionRoles, externalClients: activeExternalClients, language: activeLanguage, ...dispatchSource, requestedRole, taskKind: params.taskKind,
      workspaceMode: params.workspaceMode,
      projectId: project?.id, envId: routingEnv,
      trustedManual: params.originToolTaskId === undefined });
    const roleId = routing.role;
    const rolePreset = resolveRoleOrDirectClient(roleId, activeRoles, activeExternalClients, activeLanguage);
    const externalBinding = rolePreset?.external;
    const explicitAgentDevice = externalBinding && (routing.source === "explicit" || routing.source === "manual") ? externalBinding.envId : undefined;
    if (modelDispatch && !params.sourceRequestId && !boundEnv && !explicitAgentDevice && inputs.some((input) =>
      chatRoutingData(input).source?.deviceId !== sender.source?.deviceId)) {
      throw new ProjectError(409, "source_device_ambiguous", "本轮有来自不同设备的消息，请为本次任务填写对应的 source_request_id。");
    }
    if (externalBinding && (!externalBinding.verifiedAt || isPersonalExternalAgentKind(externalBinding.kind))) {
      throw new ProjectError(409, "external_agent_unverified", `指定的外部 Agent「${rolePreset.label}」尚未完成稳定任务通信验证，请在智能体设置页继续配置。`);
    }
    if (externalBinding && proposedEnv && proposedEnv !== externalBinding.envId) throw new ProjectError(400, "agent_device_conflict", `指定的 Agent「${rolePreset.label}」已绑定其他执行设备，请明确选择同设备的 Agent。`);
    if (externalBinding && (executionDomain === "android" || androidDeviceIds.length || project && project.deviceId !== externalBinding.envId)) throw new ProjectError(400, "agent_project_conflict", "外部智能体必须使用其绑定电脑上的授权项目。");

    let targetEnvId: string;
    let envBinding: TicketEnvBinding;
    let waitForSource: boolean;
    if (executionDomain === "computer") {
      const resolved = resolveComputerEnvBinding({
        projectDeviceId: project?.deviceId,
        explicitWorkspaceDir: params.workspaceDir?.trim() || undefined,
        messageTargetDeviceId: !recoveryTicket ? sender.targetDeviceId : undefined,
        topicTargetDeviceId: originTopic?.targetDeviceId,
        namedEnvId: namedEnv,
        explicitAgentDeviceId: explicitAgentDevice,
        externalBindingDeviceId: externalBinding?.envId,
        recoveryTicket,
        sourceEnvId: sourceEnv,
        sourceRootDir,
        proposedEnvId: proposedEnv,
        targetScope: params.targetScope,
        userMessage: sender.text,
        goal: params.goal,
        scope: params.scope,
        localEnv,
        pickFallbackEnvId: () => this.envManager.pickDefaultWorkerEnvId(),
      });
      if (resolved.conflictWithSource) {
        throw new ProjectError(409, "source_device_conflict", `该消息默认在「${sender.source?.name}」上处理。请省略 env_id，或根据用户明确指定的设备重新派单。`);
      }
      if (!boundEnv && (!proposedEnv || proposedEnv === sourceEnv) && sourceEnv && resolved.envId === sourceEnv && !hasExplicitSenderReference(sender.text)) {
        const briefTargets = [
          ...new Set(
            namedDispatchDevices(`${params.goal}\n${params.scope}`, envs)
              .filter((ids) => ids.length === 1)
              .map((ids) => ids[0]!),
          ),
        ];
        if (briefTargets.length === 1 && briefTargets[0] !== sourceEnv) {
          const intended = this.envManager.getEnvDescriptor(briefTargets[0]!)?.name ?? briefTargets[0]!;
          throw new ProjectError(
            409,
            "target_device_mismatch",
            `工单内容指向设备「${intended}」，但未传入目标 env_id 而默认落到了发信设备「${sender.source?.name}」。请确认用户意图后显式传入目标设备的 env_id，避免误派到发信设备。`,
          );
        }
      }
      targetEnvId = resolved.envId;
      envBinding = resolved.envBinding;
      waitForSource = resolved.waitForSource;
    } else {
      if (sourceEnv && !explicitAgentDevice && proposedEnv && proposedEnv !== sourceEnv) {
        throw new ProjectError(409, "source_device_conflict", `该消息默认在「${sender.source?.name}」上处理。请省略 env_id，或根据用户明确指定的设备重新派单。`);
      }
      const initialEnv = (!explicitAgentDevice && sourceEnv ? sourceEnv : proposedEnv) ?? recoveryTicket?.envId ?? namedEnv;
      targetEnvId = initialEnv ?? fixedTargetId ?? androidDeviceIds[0] ?? this.envManager.pickDefaultWorkerEnvId();
      envBinding = !recoveryTicket && sender.targetDeviceId
        ? "message_target"
        : originTopic?.targetDeviceId
          ? "topic_target"
          : namedEnv
            ? "message_named"
            : sourceEnv
              ? "sender_local"
              : "pool_fallback";
      waitForSource = Boolean(sourceEnv && !explicitAgentDevice);
    }

    const agentEnv = project?.deviceId ?? targetEnvId ?? fixedTargetId;
    assertAgentDispatchAvailable(rolePreset, { envs, envId: agentEnv, allowOffline: waitForSource });
    if (project && this.envManager.getEnvDescriptor(project.deviceId)?.online) {
      project = await this.projects.ensureAuthorized(project.id, context);
    }
    if (project && proposedEnv && proposedEnv !== project.deviceId) {
      throw new ProjectError(400, "project_binding_conflict", "执行设备必须与项目所属设备一致。");
    }
    const pathApi = project?.platform === "win32" || /^[A-Za-z]:[\\/]|^\\\\/.test(project?.workspaceDir ?? "") ? path.win32 : path.posix;
    if (project && params.workspaceDir?.trim() && pathApi.normalize(params.workspaceDir.trim()) !== pathApi.normalize(project.workspaceDir)) {
      throw new ProjectError(400, "project_binding_conflict", "工作目录必须与项目授权目录一致。");
    }
    const targetDescriptor = this.envManager.getEnvDescriptor(targetEnvId);
    if (targetEnvId === sourceEnv && !targetDescriptor) {
      throw new ProjectError(409, "source_env_unavailable", `发信设备「${sender.source?.name}」的执行环境尚未连接。请启动该设备的 Kulo 执行环境，或指定其他设备。`);
    }
    if (!externalBinding && executionDomain === "computer" && targetDescriptor?.online && !hasWorkerIsolation(targetDescriptor)) {
      throw new ProjectError(409, "worker_isolation_unavailable", `目标执行设备「${targetDescriptor.name}」未启用沙箱隔离能力，无法运行内置后台 Worker。`);
    }
    if (targetEnvId === sourceEnv && executionDomain === "android" && androidDeviceIds.some((id) => id !== sourceEnv)) {
      throw new ProjectError(409, "target_device_conflict", "当前手机任务默认使用发信手机。要操作其他手机，请明确指定目标设备。");
    }
    if (executionDomain === "android" && !androidDeviceIds.length) androidDeviceIds.push(targetEnvId);
    if (executionDomain === "android" ? targetDescriptor?.executionKind !== "native-device" : targetDescriptor?.executionKind === "native-device") {
      throw new ProjectError(400, "execution_domain_mismatch", "任务执行类型与目标设备不符。");
    }
    if (executionDomain === "android" && !androidDeviceIds.includes(targetEnvId)) throw new ProjectError(400, "invalid_android_targets", "纯手机任务必须包含主目标手机。");
    for (const id of androidDeviceIds) {
      const phone = this.envManager.getEnvDescriptor(id);
      if (phone?.executionKind !== "native-device" || !phone.capabilities.includes("android-native-v1")) throw new ProjectError(409, "android_device_unavailable", `手机 ${id} 尚未接入原生控制协议。`);
    }
    if (fixedTargetId) {
      if (fixedTarget?.executionKind === "native-device") {
        if (!androidDeviceIds.length || androidDeviceIds.some(id => id !== fixedTargetId) || executionDomain === "android" && targetEnvId !== fixedTargetId) {
          throw new ProjectError(403, "target_device_conflict", "任务必须使用当前会话明确选择的手机。");
        }
      } else if (targetEnvId !== fixedTargetId || executionDomain !== "computer") {
        throw new ProjectError(403, "target_device_conflict", "任务必须使用当前会话明确选择的电脑。");
      }
    }
    if (!project && params.workspaceDir?.trim()) {
      const requested = { envId: targetEnvId, workspaceDir: this.envManager.isLocalEnv(targetEnvId) ? canonicalExecutionPath(params.workspaceDir) : params.workspaceDir } as TicketRecord;
      const overlap = (await this.projects.list(context)).find((p) => ticketsShareWriteScope(requested, { envId: p.deviceId, workspaceDir: p.workspaceDir } as TicketRecord));
      if (overlap) throw new ProjectError(400, "project_required", `该目录属于项目 ${overlap.name}，请使用 project_id 派单。`, { projectId: overlap.id });
    }
    const envDesc = targetDescriptor;
    if (!envDesc && !project) {
      throw new Error(
        `Execution environment '${targetEnvId}' is not registered. Available: ${this.envManager
          .listEnvs()
          .map((e) => e.id)
          .join(", ")}`,
      );
    }

    const sep = project ? pathApi.sep : envDesc?.platform === "win32" ? "\\" : "/";
    const cleanRoot = executionDomain === "android" ? "" : (envDesc?.rootDir ?? pathApi.dirname(project!.workspaceDir)).replace(/[\\/]+$/, "");
    const scratchRoot = project?.scratchRoot ?? `${cleanRoot}${sep}scratch`;
    const parent = params.parentTicketId ? existingState?.tickets[params.parentTicketId] : undefined;
    if (params.parentTicketId && (!parent?.externalExecution || parent.status !== "running" || !parent.externalExecution.allowSubagents || parent.envId !== targetEnvId || parent.projectId !== project?.id)) throw new ProjectError(403, "external_parent_invalid", "子任务的父级执行资格或项目范围已失效。");
    const requestedReadOnly = Boolean(rolePreset?.readOnly || routing.readOnly || parent?.readOnly || params.workspaceMode === "read_only");
    // Native clients own their tool permissions; a task's read-only request is not a host-enforced write guarantee.
    const isReadOnly = !externalBinding && requestedReadOnly;
    const builtInWorkspaceMode: ExternalWorkspaceMode | undefined =
      externalBinding || executionDomain === "android" || !project
        ? undefined
        : requestedReadOnly
          ? "read_only"
          : params.workspaceMode ?? "staged";
    const externalWorkspaceMode: ExternalWorkspaceMode | undefined = !externalBinding || !project
      ? undefined
      : requestedReadOnly
        ? "read_only"
        : params.workspaceMode ?? "staged";
    let nativeThinking: string | undefined;
    if (externalBinding) {
      if (rolePreset?.thinkingLevel && rolePreset.thinkingLevel !== "auto") {
        nativeThinking = rolePreset.thinkingLevel;
      } else if (params.thinkingLevel) {
        const clientId = rolePreset.externalClientId?.trim() || externalClientConnectionId(externalBinding);
        const clientModels = this.#liveSettings.externalClients?.[clientId]?.models ?? [];
        const targetModel = rolePreset.modelId
          ? clientModels.find((m) => m.id === rolePreset.modelId)
          : clientModels.find((m) => m.isDefault) ?? clientModels[0];
        const efforts = targetModel?.efforts ?? [];
        if (efforts.includes(params.thinkingLevel)) {
          nativeThinking = params.thinkingLevel;
        } else if (params.thinkingLevel === "off" && efforts.includes("none")) {
          nativeThinking = "none";
        }
      }
    }
    const providerOverride = !externalBinding && params.providerOverride?.trim() ? params.providerOverride.trim() : undefined;
    const modelOverride = !externalBinding && params.modelOverride?.trim() ? params.modelOverride.trim() : undefined;
    const workerProviderOpt =
      providerOverride || rolePreset?.provider?.trim() || this.#liveSettings.model.defaultProvider;
    const workerModelId =
      modelOverride || rolePreset?.modelId?.trim() || this.#liveSettings.model.defaultModel;
    const desiredThinking: ThinkingEffort =
      params.thinkingLevel ??
      (rolePreset?.thinkingLevel && rolePreset.thinkingLevel !== "auto"
        ? rolePreset.thinkingLevel
        : this.#liveSettings.model.thinkingLevel);
    const workerAgent = externalBinding ? undefined : resolveAgentModelAndThinking(
      this.#models,
      this.#providerId,
      workerProviderOpt,
      workerModelId,
      desiredThinking,
      this.#liveSettings.model,
    );

    const originConv =
      (await this.harness.conversation(originConversationId as ConversationId, context)) ??
      this.rootConversation;

    const supersededStagedToDiscard: TicketRecord[] = [];
    const admitted = await originConv.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const currentSettings = await tx.doc(SettingsAssistantDoc);
      ensureDefaultRootTopic(state, this.#liveSettings.presentation.agentName);
      if (project) assertProjectBinding(await tx.doc(KuloProjectsDoc), project.id, project.revision);
      const isSettingsOrigin = !isOrchestratorConversation(originConversationId, state) && isActiveSettingsConversation(originConversationId, currentSettings);
      if (!isSettingsOrigin) {
        if (originIsSettings) throw new ProjectError(404, "topic_deleted", "会话已删除。");
        const currentTopic = state.topics?.[state.conversationToTopic?.[String(originConversationId)] ?? "root"];
        if (currentTopic?.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
      }
      const settings = await tx.doc(KuloSettingsDoc);
      const duplicate = checkAdmission(state, settings.executor.paused);
      if (duplicate) return cloneJson(duplicate);
      const currentRoles = settings.roles;
      const currentExternalClients = settings.externalClients;
      const currentSelection = androidDeviceIds.length || executionDomain === "android" ? Object.fromEntries(Object.entries(currentRoles).map(([id, role]) => [id, role.external ? { ...role, dispatchPolicy: undefined } : role])) : currentRoles;
      const currentRouting = resolveAgentDispatch({ roles: currentSelection, externalClients: currentExternalClients, language: settings.presentation.language, ...dispatchSource, requestedRole, taskKind: params.taskKind,
        workspaceMode: params.workspaceMode,
        projectId: project?.id, envId: routingEnv,
        trustedManual: params.originToolTaskId === undefined });
      const currentResolvedRole = resolveRoleOrDirectClient(roleId, currentRoles, currentExternalClients, settings.presentation.language);
      if (currentRouting.role !== roleId || !isDeepStrictEqual(currentResolvedRole, rolePreset)) throw new ProjectError(409, "agent_configuration_changed", "派单期间智能体或默认承接范围已改变，请读取最新配置后重新指派。");
      assertAgentDispatchAvailable(currentResolvedRole, { envs: this.envManager.listEnvs(), envId: agentEnv, allowOffline: waitForSource });
      assertRecoveryGuard(state, recoveryGuard);
      if (recoveryGuard) {
        const failed = state.tickets[recoveryGuard.ticketId]!;
        const topicTargetDeviceId = originIsSettings ? undefined : state.topics?.[state.conversationToTopic?.[String(originConversationId)] ?? "root"]?.targetDeviceId;
        const allowFallbackEnv = canSwitchEnvDuringRecovery(failed, topicTargetDeviceId) && !externalBinding && !project;
        if (!params.supersedes?.some(old => old.ticketId === failed.id) || (!allowFallbackEnv && targetEnvId !== failed.envId) ||
            (project?.id ?? undefined) !== failed.projectId || (failed.readOnly && !isReadOnly) ||
            executionDomain !== (failed.executionDomain ?? "computer") || androidDeviceIds.some(id => !this.#androidTargets(failed).includes(id)) ||
            connectionIds.some(id => !failed.connectionIds?.includes(id))) {
          throw new Error("替代方案必须关联原任务并保持原设备、项目、连接和只读授权边界。");
        }
        if (params.workspaceDir?.trim() && pathApi.normalize(params.workspaceDir) !== pathApi.normalize(failed.workspaceDir)) {
          throw new Error("自动恢复不能扩大原任务的工作目录。");
        }
      }

      const originTopicId = isSettingsOrigin
        ? settingsTopicId(originConversationId)
        : state.conversationToTopic?.[String(originConversationId)] ?? "root";
      const ticketNum = state.nextTicketNumber++;
      const ticketId = `T-${String(ticketNum).padStart(4, "0")}`;
      const workspaceDir = executionDomain === "android" ? "" :
        project?.workspaceDir || params.workspaceDir?.trim() || `${cleanRoot}${sep}table${sep}${ticketId}-${slugifyTitle(params.title)}`;
      const scratchDir = executionDomain === "android" ? undefined : `${scratchRoot}${sep}${ticketId}`;

      const now = Date.now();
      const supersededIds: string[] = [];

      if (params.supersedes?.length) {
        for (const sup of params.supersedes) {
          const old = state.tickets[sup.ticketId];
          if (!old || !["ready", "failed"].includes(old.status) ||
              !sameRecoveryScope(old, { originTopicId, projectId: project?.id })) {
            throw new Error("只能替代同一会话和项目中已完成或失败的任务。");
          }
          if (!supersededIds.includes(old.id)) supersededIds.push(old.id);
        }
      }

      const configuredWaitMs =
        params.inlineWaitMs !== undefined
          ? Math.max(0, Math.min(30_000, Math.trunc(params.inlineWaitMs)))
          : (this.config.inlineDispatchWaitMs ?? 0);
      const candidateWriteTicket = {
        envId: targetEnvId,
        workspaceDir,
        ...(project ? { directoryId: project.directoryId } : {}),
        readOnly: isReadOnly,
        executionDomain,
        ...(androidDeviceIds.length ? { androidDeviceIds } : {}),
      } as TicketRecord;

      // Supersedes deadlock breaker: discard superseded pending-merge staged copies and release their project write lock.
      if (!isReadOnly && executionDomain !== "android" && supersededIds.length > 0) {
        for (const oldId of supersededIds) {
          const old = state.tickets[oldId];
          if (!old || !hasPendingWorkspaceApply(old) || !ticketsShareWriteScope(candidateWriteTicket, old)) continue;
          supersededStagedToDiscard.push(cloneJson(old));
          if (old.workspaceStaging && !old.workspaceStaging.appliedAt) {
            old.workspaceStaging.discardedAt = now;
            delete old.workspaceStaging.stagedCwd;
            delete old.workspaceStaging.stagedDiff;
          }
          if (old.externalExecution && !old.externalExecution.stagedAppliedAt) {
            delete old.externalExecution.stagedCwd;
            delete old.externalExecution.stagedDiff;
          }
          releaseProjectWrite(state, old.id, { force: true });
          old.updatedAt = now;
        }
      }

      const writeConflictExists =
        executionDomain !== "android" &&
        !isReadOnly &&
        Object.values(state.tickets).some(
          (other) =>
            (other.status === "running" ||
              other.status === "pausing" ||
              (!supersededIds.includes(other.id) && hasPendingWorkspaceApply(other))) &&
            ticketsShareWriteScope(candidateWriteTicket, other),
        );
      const eligibleInline =
        modelDispatch &&
        configuredWaitMs > 0 &&
        executeAt === undefined &&
        !recoveryGuard &&
        !settings.executor.paused &&
        state.slots.holders.length < settings.executor.maxConcurrentWorkers &&
        this.#ticketDevicesOnline(candidateWriteTicket) &&
        !writeConflictExists;

      const draft: TicketDispatchDraft = {
        id: ticketId,
        commandId: params.commandId,
        title: params.title.trim(),
        ...(params.userSummary?.trim() ? { userSummary: params.userSummary.trim() } : {}),
        goal: params.goal.trim(),
        scope: params.scope.trim(),
        ...(params.acceptance?.trim() ? { acceptance: params.acceptance.trim() } : {}),
        ...(params.assignment?.trim() ? { assignment: params.assignment.trim() } : {}),
        ...(contextSummary ? { contextSummary } : {}),
        ...(inputAttachmentIds.length ? { inputAttachmentIds } : {}),
        role: roleId,
        ...(providerOverride ? { providerOverride } : {}),
        ...(modelOverride ? { modelOverride } : {}),
        ...(routing.source !== "legacy" ? { agentAssignment: { agentId: roleId, source: routing.source,
          ...(routing.taskKind ? { taskKind: routing.taskKind } : {}), ...(routing.requestedName ? { requestedName: routing.requestedName } : {}),
          ...((dispatchSource.inheritedAssignment?.sourceEntryId ?? dispatchSource.entryId) === undefined ? {} : { sourceEntryId: dispatchSource.inheritedAssignment?.sourceEntryId ?? dispatchSource.entryId }) } } : {}),
        ...(params.parentTicketId ? { parentTicketId: params.parentTicketId } : {}),
        ...(builtInWorkspaceMode === "staged" || builtInWorkspaceMode === "direct"
          ? { workspaceStaging: { mode: builtInWorkspaceMode } }
          : {}),
        ...(externalBinding ? { externalExecution: { binding: cloneJson(externalBinding),
          ...(externalWorkspaceMode ? { workspaceMode: externalWorkspaceMode } : {}),
          ...(rolePreset?.modelId?.trim() ? { modelId: rolePreset.modelId.trim() } : {}),
          ...(nativeThinking && nativeThinking !== "auto" ? { thinkingLevel: nativeThinking } : {}),
          ...(rolePreset?.serviceTier?.trim() ? { serviceTier: rolePreset.serviceTier.trim() } : {}),
          instructions: [rolePreset?.prompt?.trim(), requestedReadOnly ? "Read-only assignment: inspect and analyze only; do not modify workspace files." : ""].filter(Boolean).join("\n\n"),
          allowSubagents: Boolean(rolePreset?.allowSubagents) } } : {}),
        status: executeAt === undefined ? "queued" : "waiting",
        envId: targetEnvId,
        envBinding,
        ...(sender.source ? { senderSource: { deviceId: sender.source.deviceId, name: sender.source.name } } : {}),
        executionDomain,
        ...(androidDeviceIds.length ? { androidDeviceIds } : {}),
        workspaceDir,
        ...(scratchDir ? { scratchDir } : {}),
        readOnly: isReadOnly,
        ...(connectionIds.length ? { connectionIds, connectionRevisions } : {}),
        ...(project ? { projectId: project.id, projectRevision: project.revision, directoryId: project.directoryId, grantRevision: project.grantRevision } : {}),
        runEpoch: 1,
        createdAt: now,
        updatedAt: now,
        queuedAt: now,
        accumulatedRunningMs: 0,
        ...(executeAt !== undefined ? {
          schedule: { executeAt, nextRunAt: executeAt, ...(params.repeatEverySeconds !== undefined ? { repeatEverySeconds: params.repeatEverySeconds } : {}) },
          waiting: { reason: "time" as const, since: now, until: executeAt, detail: "等待定时执行" },
        } : {}),
        ...(supersededIds.length > 0 ? { supersedes: supersededIds } : {}),
        ...(supersededIds.map(id => state.tickets[id]?.recovery).find(value => value?.state === "recovering")
          ? { recovery: { ...supersededIds.map(id => state.tickets[id]?.recovery).find(value => value?.state === "recovering")! } } : {}),
        deliveryClaim: eligibleInline ? "inline_waiting" : "escalated",
        originTopicId,
        originConversationId,
      };

      if (params.parentTicketId) {
        const request = params.parentExternalRequest;
        if (!request) throw new Error("外部协作缺少已认证的父任务请求。");
        const currentParent = this.#externalAgentScope({ envId: targetEnvId, taskId: params.parentTicketId, runId: request.runId, runEpoch: request.runEpoch }, state);
        const currentRole = this.#liveSettings.roles[currentParent.role];
        const childRole = this.#liveSettings.roles[roleId];
        if (!currentParent.externalExecution!.allowSubagents || !currentRole?.allowSubagents || currentRole.enabled === false ||
            !childRole || childRole.enabled === false || currentParent.readOnly && !isReadOnly ||
            currentParent.projectId !== draft.projectId || currentParent.workspaceDir !== workspaceDir ||
            connectionIds.some((id) => !currentParent.connectionIds?.includes(id))) throw new Error("协作请求超出父任务当前的授权范围。");
        const children = currentParent.externalExecution!.children ?? {};
        const prior = children[request.requestId];
        if (prior) throw new Error(prior.fingerprint === request.fingerprint ? "该协作请求已有子任务，请读取原任务。" : "该协作编号已用于另一份任务。");
        if (Object.keys(children).length >= this.#liveSettings.executor.maxSubagentsPerTicket) throw new Error("当前任务已达到子智能体上限。");
        currentParent.externalExecution!.children = { ...children, [request.requestId]: { taskId: ticketId, fingerprint: request.fingerprint } };
      }

      if (!externalBinding && executionDomain !== "android" && builtInWorkspaceMode !== "staged" && this.envManager.getEnvDescriptor(targetEnvId)?.online) {
        this.envManager.createWorkerExecutionEnv(targetEnvId, workspaceDir, {
          scratchDir, projectId: project?.id, grantRevision: project?.grantRevision, readOnly: isReadOnly,
        });
      }
      const created = await createDispatchedTicket(tx, state, draft, this.#workerTicketTask, workerAgent ? {
        model: workerAgent.model,
        thinkingLevel: workerAgent.thinkingLevel,
        ...this.#workerTools({
          executionDomain,
          androidTargetIds: androidDeviceIds,
          allowSubagents: Boolean(rolePreset?.allowSubagents),
          readOnly: isReadOnly,
        }),
        ...(executionDomain !== "android" ? { cwd: workspaceDir } : {}),
        maxTurns: 40,
      } : undefined);
      if (connectionIds.length > 0 && created.workerConversationId && executionDomain !== "android") {
        await injectEventToolsInTx(tx, created.workerConversationId, ["kulo_connections", "kulo_connection_use"]);
      }
      return created;
    }, context);

    if (supersededStagedToDiscard.length > 0) {
      await Promise.allSettled(supersededStagedToDiscard.map((old) => this.#discardTicketStagedWorkspace(old)));
    }
    bindDispatchedAttachments(this.uploads, admitted);
    if (!this.#recovering) this.harness.resume();
    await this.#broadcastTickets(context);
    return toTicketCardView(admitted, activeRoles, activeExternalClients);
  }

  #notifyInlineWaiters(ticketId: string): void {
    const waiters = this.#inlineDispatchWaiters.get(ticketId);
    if (!waiters) return;
    this.#inlineDispatchWaiters.delete(ticketId);
    for (const wake of waiters) {
      try {
        wake();
      } catch {
        // Ignore individual listener errors
      }
    }
  }

  async dispatchTicketForModel(
    params: DispatchTicketParams,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<DispatchTicketModelOutcome> {
    const card = await this.dispatchTicket(params, context);
    const configuredWaitMs =
      params.inlineWaitMs !== undefined
        ? Math.max(0, Math.min(30_000, Math.trunc(params.inlineWaitMs)))
        : (this.config.inlineDispatchWaitMs ?? 0);

    const initialState = await this.harness.snapshot(KuloStateDoc, context);
    const initialTicket = initialState?.tickets[card.id];
    const findPendingMergeBlocker = (
      state: Readonly<KuloDurableState> | undefined,
      current: Readonly<TicketRecord> | undefined,
    ): { ticketId: string; title: string } | undefined => {
      if (!state || !current || current.readOnly || current.executionDomain === "android" || current.status !== "queued") {
        return undefined;
      }
      const blocker = Object.values(state.tickets).find(
        (other) =>
          other.id !== current.id &&
          hasPendingWorkspaceApply(other) &&
          ticketsShareWriteScope(current, other),
      );
      return blocker ? { ticketId: blocker.id, title: blocker.title } : undefined;
    };
    const initialBlocker = findPendingMergeBlocker(initialState, initialTicket);
    if (initialTicket?.deliveryClaim === "claimed_inline" && initialTicket.inlineResult) {
      return {
        ticket: toTicketCardView(initialTicket, this.#liveSettings.roles),
        inlineDelivery: cloneJson(initialTicket.inlineResult),
      };
    }
    if (initialTicket?.deliveryClaim !== "inline_waiting" || configuredWaitMs <= 0) {
      return {
        ticket: card,
        ...(initialBlocker ? { blockedByPendingMerge: initialBlocker } : {}),
      };
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.abortSignal?.removeEventListener("abort", finish);
        const set = this.#inlineDispatchWaiters.get(card.id);
        if (set) {
          set.delete(finish);
          if (set.size === 0) this.#inlineDispatchWaiters.delete(card.id);
        }
        resolve();
      };
      const timer = setTimeout(finish, configuredWaitMs);
      timer.unref?.();
      let set = this.#inlineDispatchWaiters.get(card.id);
      if (!set) {
        set = new Set();
        this.#inlineDispatchWaiters.set(card.id, set);
      }
      set.add(finish);
      if (context.abortSignal?.aborted || this.#closed) {
        finish();
        return;
      }
      context.abortSignal?.addEventListener("abort", finish, { once: true });
      // Re-check snapshot after registering waiter so we cannot miss an immediate completion.
      void this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT).then((snap) => {
        const cur = snap?.tickets[card.id];
        if (!cur || cur.deliveryClaim !== "inline_waiting" || cur.status === "stopped" || cur.status === "closed" || cur.status === "failed") {
          finish();
        }
      }).catch(() => finish());
    });

    const outcome = await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const current = state.tickets[card.id];
      if (!current) {
        return { ticket: card, escalatedNow: false };
      }
      if (current.deliveryClaim === "claimed_inline" && current.inlineResult) {
        return {
          ticket: toTicketCardView(current, this.#liveSettings.roles),
          inlineDelivery: cloneJson(current.inlineResult),
          escalatedNow: false,
        };
      }
      let escalatedNow = false;
      if (current.deliveryClaim === "inline_waiting") {
        current.deliveryClaim = "escalated";
        current.updatedAt = Date.now();
        escalatedNow = true;
      }
      return {
        ticket: toTicketCardView(current, this.#liveSettings.roles),
        escalatedNow,
        blockedByPendingMerge: findPendingMergeBlocker(state, current),
      };
    }, withoutAbortSignal(context));

    if (outcome.escalatedNow && !this.#closed) {
      await this.#broadcastTickets(withoutAbortSignal(context));
    }
    if (outcome.inlineDelivery) {
      return { ticket: outcome.ticket, inlineDelivery: outcome.inlineDelivery };
    }
    return {
      ticket: outcome.ticket,
      ...(outcome.blockedByPendingMerge ? { blockedByPendingMerge: outcome.blockedByPendingMerge } : {}),
    };
  }

  async #readEntryAgentIntent(
    conversation: Awaited<ReturnType<Harness["conversation"]>>,
    sourceEntryId: number,
    context: Context,
  ): Promise<AgentDispatchIntent | undefined> {
    if (!conversation || !Number.isSafeInteger(sourceEntryId) || sourceEntryId < 1) return undefined;
    const page = await conversation.entries(
      { minEntryId: sourceEntryId as EntryId, maxEntryId: sourceEntryId as EntryId },
      1,
      undefined,
      context,
    );
    const entry = page.items.find((item) => Number(item.id) === sourceEntryId);
    if (!entry) return undefined;
    const data = entry.data as Record<string, unknown> | undefined;
    if (data && Object.hasOwn(data, "agentDispatchIntent")) {
      return capturedAgentIntent(data.agentDispatchIntent);
    }
    const message = entry.model?.find((item) => item.role === "user");
    const text = typeof data?.text === "string"
      ? data.text
      : message?.role === "user"
        ? parseUserEntryContent(message.content).text
        : "";
    return text ? extractAgentDispatchIntent(text, this.#liveSettings.roles, this.envManager.listEnvs(), this.#liveSettings.externalClients) : undefined;
  }

  async #agentDispatchSource(conversationId: number | undefined, toolTaskId: number | undefined, context: Context, selectedInput?: EntryId): Promise<{
    intent?: AgentDispatchIntent; entryId?: number; inheritedAssignment?: AgentAssignment; relaySettledReady?: boolean; input?: EntryRecord; continuing?: boolean;
  }> {
    if (conversationId === undefined) return {};
    const conversation = await this.harness.conversation(conversationId as ConversationId, context);
    if (!conversation) throw new ProjectError(409, "agent_assignment_source_missing", "无法核对这次任务的原始用户消息，请重新发起指派。");
    let assistant: number | undefined = selectedInput;
    if (toolTaskId !== undefined && assistant === undefined) {
      let current = toolTaskId;
      for (let depth = 0; depth < 16; depth++) {
        const task = await this.harness.commit((tx) => tx.task(current as never), context);
        const input = task?.input as { kind?: string; assistant?: number; parent?: number } | undefined;
        if (input?.kind === "model" && typeof input.assistant === "number") { assistant = input.assistant; break; }
        if (input?.kind !== "nested" || typeof input.parent !== "number") throw new ProjectError(409, "agent_assignment_source_missing", "无法核对派单工具对应的用户消息。");
        current = input.parent;
      }
      if (assistant === undefined) throw new ProjectError(409, "agent_assignment_source_missing", "派单上下文层级无效，请重新发起指派。");
    }
    // Original journal entries survive compaction. Limit to this tool's assistant entry so a later queued user turn cannot rebind it.
    let cursor: Parameters<typeof conversation.entries>[2];
    let continuing = false;
    let input: EntryRecord | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await conversation.entries(assistant === undefined ? {} : { maxEntryId: assistant as EntryId }, 200, cursor, context);
      for (const entry of [...page.items].sort((a, b) => Number(b.id) - Number(a.id))) {
        if (!isRecoveryInputBoundary(entry)) continue;
        if (WorkerRelayEntry.is(entry) || WorkerRecoveryEntry.is(entry) || WorkerWatchdogEntry.is(entry)) {
          const state = await this.harness.snapshot(KuloStateDoc, context);
          let ticket = state?.tickets[entry.data.ticketId];
          const ancestors = new Set<string>();
          while (ticket?.parentTicketId && !ancestors.has(ticket.id)) { ancestors.add(ticket.id); ticket = state?.tickets[ticket.parentTicketId] ?? ticket; if (ancestors.has(ticket.id)) break; }
          const relaySettledReady = WorkerRelayEntry.is(entry) && entry.data.state === "ready";
          const assignment = ticket?.agentAssignment;
          if (relaySettledReady && assignment?.source === "explicit" && assignment.sourceEntryId !== undefined) {
            const originIntent = await this.#readEntryAgentIntent(conversation, assignment.sourceEntryId, context);
            if (originIntent && originIntent.targets.length > 1) {
              return { entryId: Number(entry.id), intent: originIntent, input, continuing, relaySettledReady: true };
            }
          }
          const shouldInherit = Boolean(
            assignment && (assignment.source === "explicit" || assignment.source === "manual"),
          );
          return {
            entryId: Number(entry.id),
            input,
            continuing,
            ...(relaySettledReady ? { relaySettledReady: true } : {}),
            ...(shouldInherit && assignment ? { inheritedAssignment: cloneJson(assignment) } : {}),
          };
        }
        input ??= entry;
        const data = entry.data as Record<string, unknown> | undefined;
        const message = entry.model?.find((item) => item.role === "user");
        const text = typeof data?.text === "string" ? data.text : message?.role === "user" ? parseUserEntryContent(message.content).text : "";
        const intent = data && Object.hasOwn(data, "agentDispatchIntent") ? capturedAgentIntent(data.agentDispatchIntent)
          : extractAgentDispatchIntent(text, this.#liveSettings.roles, this.envManager.listEnvs(), this.#liveSettings.externalClients);
        if (!intent && !continuing && /^(?:请|帮我)?\s*(?:继续(?:执行|处理|推进|完成|原任务|这个任务)?|接着(?:做|执行|处理)?|重试(?:一下|这个任务)?|再试(?:一次|一下)?|continue|retry)[\s,，。.!！]*$/i.test(text.trim())) { continuing = true; continue; }
        if (!intent && continuing) {
          const state = await this.harness.snapshot(KuloStateDoc, context);
          const assignments = Object.values(state?.tickets ?? {}).filter((ticket) => ticket.originConversationId === conversationId && ticket.agentAssignment?.sourceEntryId === Number(entry.id)).flatMap((ticket) => ticket.agentAssignment ? [ticket.agentAssignment] : []);
          const byAgent = new Map(assignments.map((assignment) => [assignment.agentId, assignment]));
          if (byAgent.size > 1) throw new ProjectError(409, "agent_selection_required", "此前任务由多个 Agent 分工，请明确要继续哪一个任务或 Agent。");
          const inheritedAssignment = byAgent.values().next().value as AgentAssignment | undefined;
          if (inheritedAssignment) return { entryId: Number(entry.id), inheritedAssignment: cloneJson(inheritedAssignment), input, continuing };
        }
        return { entryId: Number(entry.id), intent, input, continuing };
      }
      if (!page.next) {
        if (toolTaskId !== undefined) throw new ProjectError(409, "agent_assignment_source_missing", "原始派发消息已不可用，请重新说明任务和指定 Agent。");
        return {};
      }
      cursor = page.next;
    }
    throw new ProjectError(409, "agent_assignment_source_missing", "原始指派消息过远，无法安全核对，请重新说明要使用的 Agent。");
  }

  #ticketAgentBlock(ticket: Readonly<TicketRecord>): string | undefined {
    if (!ticket.agentAssignment && !ticket.externalExecution) return;
    const role = resolveRoleOrDirectClient(ticket.role, this.#liveSettings.roles, this.#liveSettings.externalClients, this.#liveSettings.presentation.language);
    if (!role) return "原任务绑定的 Agent 已被移除，请明确选择其他 Agent 后新建任务。";
    if (ticket.agentAssignment && ticket.agentAssignment.agentId !== ticket.role) return "任务的 Agent 绑定已改变，请重新指派。";
    if (role.enabled === false) return `任务指定的 Agent「${role.label}」已停用，请启用它或明确选择其他 Agent。`;
    if (ticket.externalExecution) {
      const old = ticket.externalExecution;
      if (!role.external || role.external.kind !== old.binding.kind || role.external.envId !== old.binding.envId ||
          role.external.executable !== old.binding.executable || role.external.agentRef !== old.binding.agentRef ||
          JSON.stringify(role.external.acpArgs ?? []) !== JSON.stringify(old.binding.acpArgs ?? []) ||
          role.modelId !== old.modelId || role.serviceTier !== old.serviceTier) {
        return `任务指定的 Agent「${role.label}」配置已改变，请核对后重新指派。`;
      }
      if (!role.external.verifiedAt || isPersonalExternalAgentKind(role.external.kind)) return `任务指定的 Agent「${role.label}」尚未完成可用性验证，请先在智能体设置页完成验证。`;
    }
  }

  #externalAgentScope(scope: ExternalAgentToolScope, state: Readonly<KuloDurableState> | undefined): TicketRecord {
    const ticket = state?.tickets[scope.taskId];
    if (!ticket || ticket.envId !== scope.envId || ticket.runEpoch !== scope.runEpoch || ticket.status !== "running" || ticket.waiting ||
        !ticket.externalExecution || ticket.externalExecution.runId !== scope.runId || ticket.externalExecution.binding.envId !== scope.envId) {
      throw new Error("外部任务已结束、暂停或执行资格已改变。");
    }
    return ticket;
  }

  async #confirmCustomizationValidate(
    sessionId: string,
    api: { conversationId: unknown; callId: string },
    caller: CustomizationCaller,
    service: KuloCustomizationService,
  ): Promise<Record<string, unknown> | undefined> {
    if (!caller.canModify) return undefined;
    const status = await service.status(caller);
    const session = status.session && status.session.id === sessionId ? status.session : undefined;
    if (!session || session.status === "pending" || !session.changedFiles?.length) return undefined;
    const conversationId = Number(api.conversationId);
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const topicId = state?.conversationToTopic?.[String(conversationId)];
    const fingerprint = customizationValidateFingerprint(session.id, session.revision, session.changedFiles);
    const existing = await this.actionConfirmations.lookup(conversationId, "customization_validate", fingerprint);
    if (existing?.status === "approved") return undefined;
    const built = buildCustomizationConfirmCard(session.summary, session.changedFiles);
    const { confirmation } = await this.actionConfirmations.ensurePendingCard({
      conversationId,
      ...(topicId ? { topicId } : {}),
      callId: api.callId,
      kind: "customization_validate",
      fingerprint,
      cardInput: built.input,
      logicalIds: built.logicalIds,
      payload: {
        kind: "customization_validate",
        sessionId: session.id,
        revision: session.revision,
        summary: session.summary,
        changedFiles: [...session.changedFiles],
      },
    });
    return {
      status: "awaiting_user_confirmation",
      cardId: confirmation.cardId,
      sessionId: session.id,
      revision: session.revision,
      changedFiles: session.changedFiles,
      message: "界面源码定制需要用户在聊天卡片中点击确认后才会执行构建与下次启动替换。已展示确认卡片，请简短告知用户并结束当前轮次。",
    };
  }

  async #handleExternalAgentPermission(
    input: {
      ticketId: string;
      permissionId: string;
      choiceId?: string;
      runEpoch: number;
      mode: "decide" | "ask_user";
      reason?: string;
    },
    source: { conversationId: number; callId: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<WorkerInspectResult | Record<string, unknown>> {
    const { ticketId, permissionId, choiceId, runEpoch, mode } = input;
    const fingerprint = externalPermissionFingerprint(ticketId, runEpoch, permissionId);
    const existing = await this.actionConfirmations.lookup(source.conversationId, "external_permission", fingerprint, context);

    if (mode === "decide") {
      if (!choiceId?.trim()) {
        throw new Error("mode='decide' 时必须提供有效的 choice_id。");
      }
      if (existing?.executed) {
        return this.inspectWorker(ticketId, context);
      }
      const result = await this.respondExternalAgentPermission(ticketId, permissionId, choiceId.trim(), runEpoch, context);
      if (existing && (existing.status === "pending" || existing.status === "pending_orchestrator")) {
        await this.actionConfirmations.resolveProgrammatically(
          existing.id,
          {
            status: "approved",
            selectedChoiceId: choiceId.trim(),
            resultSummary: existing.cardId ? "已通过对话处理" : "主智能体已处理",
            markExecuted: true,
          },
          context,
        );
      }
      return result;
    }

    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    const execution = ticket?.externalExecution;
    if (!ticket || !execution?.runId || ticket.status !== "running" || ticket.waiting || ticket.runEpoch !== runEpoch) {
      throw new Error("外部任务的执行资格已改变，请重新查看待授权操作。");
    }
    const pending = execution.pendingPermissions?.find((permission) => permission.id === permissionId);
    if (!pending?.choices.length) {
      throw new Error("待授权操作或选项已失效，请重新查看。");
    }
    const topicId = state?.conversationToTopic?.[String(source.conversationId)];
    const redactedChoices = pending.choices.map((choice) => ({
      id: choice.id,
      label: this.connectionManager.redact(choice.label),
    }));
    const redactedReason = input.reason ? this.connectionManager.redact(input.reason) : undefined;
    const built = buildExternalPermissionCard(this.connectionManager.redact(pending.title), redactedChoices, redactedReason);
    const { confirmation } = await this.actionConfirmations.ensurePendingCard({
      conversationId: source.conversationId,
      ...(topicId ? { topicId } : {}),
      ticketId,
      callId: source.callId,
      kind: "external_permission",
      fingerprint,
      cardInput: built.input,
      logicalIds: built.logicalIds,
      payload: {
        kind: "external_permission",
        ticketId,
        runEpoch,
        permissionId,
        title: this.connectionManager.redact(pending.title),
        choices: redactedChoices,
      },
    }, context);
    return {
      status: "awaiting_user_confirmation",
      cardId: confirmation.cardId,
      requestId: confirmation.id,
      ticketId,
      runEpoch,
      permissionId,
      message: "已向用户展示外部智能体权限确认卡片（含选项与手动输入），对话不阻塞；若用户直接在聊天中回复，可再次调用 kulo_external_permission(mode='decide') 立即生效并自动收口卡片。",
    };
  }

  async #askUserForTicket(
    params: AskUserForTicketParams,
    source: { conversationId: number; callId: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Record<string, unknown>> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[params.ticketId];
    if (!ticket || !isTicketUnfinished(ticket)) {
      throw new Error(`任务 '${params.ticketId}' 不存在或已结束。`);
    }
    if ((ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== source.conversationId) {
      throw new Error("该任务不属于当前会话。");
    }
    const cleanQuestion = this.connectionManager.redact(params.question.trim());
    if (!cleanQuestion) {
      throw new Error("向用户确认时必须提供清晰的问题描述。");
    }
    const cleanOptions = (params.options ?? [])
      .slice(0, 11)
      .map((option, index) => ({
        id: option.id.trim() || `opt_${index}`,
        label: this.connectionManager.redact(option.label.trim()).slice(0, 120),
        ...(option.tone ? { tone: option.tone } : {}),
        ...(option.value?.trim() ? { value: this.connectionManager.redact(option.value.trim()).slice(0, 400) } : {}),
      }))
      .filter((option) => option.label.length > 0);

    let cardId: string | undefined;
    let confirmationId: string | undefined;
    if (params.showCard !== false) {
      const topicId = state?.conversationToTopic?.[String(source.conversationId)];
      const fingerprint = ticketDecisionFingerprint({
        ticketId: ticket.id,
        runEpoch: ticket.runEpoch,
        question: cleanQuestion,
        options: cleanOptions,
      });
      const built = buildTicketDecisionCard({
        title: ticket.title,
        question: cleanQuestion,
        options: cleanOptions,
      });
      const { confirmation } = await this.actionConfirmations.ensurePendingCard({
        conversationId: source.conversationId,
        ...(topicId ? { topicId } : {}),
        ticketId: ticket.id,
        callId: source.callId,
        kind: "ticket_decision",
        fingerprint,
        cardInput: built.input,
        logicalIds: built.logicalIds,
        payload: {
          kind: "ticket_decision",
          ticketId: ticket.id,
          runEpoch: ticket.runEpoch,
          question: cleanQuestion,
          options: cleanOptions,
        },
      }, context);
      cardId = confirmation.cardId;
      confirmationId = confirmation.id;
    }

    const now = Date.now();
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloStateDoc);
      const live = doc.tickets[ticket.id];
      if (!live || !isTicketUnfinished(live)) return;
      live.waiting = {
        reason: "user",
        since: now,
        detail: cleanQuestion,
        ...(cleanOptions.length ? { options: cleanOptions } : {}),
        ...(cardId ? { cardId } : {}),
        ...(confirmationId ? { requestId: confirmationId } : {}),
      };
      live.updatedAt = now;
    }, context);
    await this.#broadcastTickets(context);
    return {
      status: "awaiting_user_decision",
      ticketId: ticket.id,
      ...(cardId ? { cardId } : {}),
      ...(confirmationId ? { requestId: confirmationId } : {}),
      question: cleanQuestion,
      options: cleanOptions,
      message: "已向用户发起任务决策确认（支持按钮选择、手动输入或在聊天中直接回复，对话不阻塞；若用户在聊天中回复，调用 kulo_steer 即可恢复任务并自动收口卡片）。",
    };
  }

  async #applyStagedChangesFromTool(
    params: ApplyStagedChangesParams,
    source: { conversationId: number; callId: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<StagedWorkspaceApplyResult | Record<string, unknown>> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[params.ticketId];
    if (!ticket) return this.applyStagedChanges(params, context);
    const isExternalStaged = ticket.externalExecution?.workspaceMode === "staged";
    const isBuiltInStaged = !ticket.externalExecution && ticket.workspaceStaging?.mode === "staged";
    if (!isExternalStaged && !isBuiltInStaged) return this.applyStagedChanges(params, context);
    if (isExternalStaged ? ticket.externalExecution!.stagedAppliedAt : ticket.workspaceStaging!.appliedAt) {
      return this.applyStagedChanges(params, context);
    }

    if (params.askUser !== true) {
      const applied = await this.applyStagedChanges(params, context);
      const pendingList = await this.actionConfirmations.listPendingForConversation(source.conversationId, context);
      for (const item of pendingList) {
        if (item.payload.kind === "staged_apply" && item.payload.ticketId === ticket.id) {
          await this.actionConfirmations.resolveProgrammatically(
            item.id,
            { status: "approved", selectedChoiceId: "confirm", resultSummary: "已通过对话合并", markExecuted: true },
            context,
          );
        }
      }
      return applied;
    }

    let stagedDiff = isExternalStaged ? ticket.externalExecution!.stagedDiff : ticket.workspaceStaging!.stagedDiff;
    if (!stagedDiff && !isTicketUnfinished(ticket) && ticket.status !== "stopped" && ticket.status !== "closed") {
      try {
        stagedDiff = await this.inspectStagedDiff(ticket.id, undefined, context);
      } catch {
        // Fall through to applyStagedChanges which reports the authoritative error.
      }
    }
    const selectedPaths = params.paths?.length ? new Set(params.paths) : undefined;
    const sensitivePaths = (stagedDiff?.sensitivePaths ?? []).filter((entry) => !selectedPaths || selectedPaths.has(entry));
    const conflictFiles = (stagedDiff?.conflictFiles ?? []).filter((entry) => !selectedPaths || selectedPaths.has(entry));
    const fingerprint = stagedApplyFingerprint({
      ticketId: ticket.id,
      runEpoch: ticket.runEpoch,
      paths: params.paths,
      allowConflicts: Boolean(params.allowConflicts),
      sensitivePaths,
      conflictFiles,
    });
    const existing = await this.actionConfirmations.lookup(source.conversationId, "staged_apply", fingerprint, context);
    if (existing?.status === "approved") {
      const applied = await this.applyStagedChanges(params, context);
      await this.actionConfirmations.markExecuted(existing.id, context);
      return applied;
    }
    const topicId = state?.conversationToTopic?.[String(source.conversationId)];
    const built = buildStagedApplyConfirmCard({
      ticketId: ticket.id,
      sensitivePaths,
      conflictFiles,
      allowConflicts: Boolean(params.allowConflicts),
    });
    const { confirmation } = await this.actionConfirmations.ensurePendingCard({
      conversationId: source.conversationId,
      ...(topicId ? { topicId } : {}),
      ticketId: ticket.id,
      callId: source.callId,
      kind: "staged_apply",
      fingerprint,
      cardInput: built.input,
      logicalIds: built.logicalIds,
      payload: {
        kind: "staged_apply",
        ticketId: ticket.id,
        runEpoch: ticket.runEpoch,
        commandId: params.commandId,
        ...(params.paths?.length ? { paths: [...params.paths] } : {}),
        allowConflicts: Boolean(params.allowConflicts),
        sensitivePaths,
        conflictFiles,
      },
    }, context);
    return {
      status: "awaiting_user_confirmation",
      cardId: confirmation.cardId,
      requestId: confirmation.id,
      ticketId: ticket.id,
      sensitivePaths,
      conflictFiles,
      message: "已向用户展示合并确认卡片（含允许/拒绝/手动输入），对话不阻塞；若用户直接在聊天中同意，你可以直接调用 kulo_apply_staged_changes 完成合并并自动收口卡片。",
    };
  }

  async respondExternalAgentPermission(ticketId: string, permissionId: string, choiceId: string, runEpoch: number, context: Context = BACKGROUND_CONTEXT): Promise<WorkerInspectResult> {
    await this.#queueTicketOperation(ticketId, async () => {
      const state = await this.harness.snapshot(KuloStateDoc, context);
      const ticket = state?.tickets[ticketId];
      const execution = ticket?.externalExecution;
      if (!ticket || !execution?.runId || ticket.status !== "running" || ticket.waiting || ticket.runEpoch !== runEpoch) throw new Error("外部任务的执行资格已改变，请重新查看待授权操作。");
      const pending = execution.pendingPermissions?.find((permission) => permission.id === permissionId);
      if (!pending?.choices.some((choice) => choice.id === choiceId)) throw new Error("待授权操作或选项已失效，请重新查看。");
      const response = await this.envManager.requestExternalAgent(ticket.envId, { operation: "respond", runId: execution.runId, permissionId, choiceId });
      if (response.type !== "run" || response.run.id !== execution.runId || response.run.taskId !== ticketId || response.run.runEpoch !== runEpoch || response.run.kind !== execution.binding.kind) throw new Error("客户端返回了不匹配的授权回执。");
      await this.harness.commit(async (tx) => {
        const current = this.#externalAgentScope({ envId: ticket.envId, taskId: ticketId, runEpoch, runId: execution.runId! }, await tx.doc(KuloStateDoc));
        current.externalExecution!.pendingPermissions = cloneJson(response.run.permissions);
      }, context);
    });
    await this.#broadcastTickets(context);
    return this.inspectWorker(ticketId, context);
  }

  async inspectStagedDiff(ticketId: string, filePath?: string, context: Context = BACKGROUND_CONTEXT): Promise<StagedWorkspaceDiffDetail> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) throw new ProjectError(404, "ticket_not_found", `任务 '${ticketId}' 不存在。`);
    const isExternalStaged = ticket.externalExecution?.workspaceMode === "staged";
    const isBuiltInStaged = !ticket.externalExecution && ticket.workspaceStaging?.mode === "staged";
    if (!isExternalStaged && !isBuiltInStaged) {
      throw new ProjectError(400, "staged_workspace_unavailable", "该任务未使用隔离副本（staged）工作区模式。");
    }
    if (isExternalStaged ? ticket.externalExecution!.stagedAppliedAt : ticket.workspaceStaging!.appliedAt) {
      throw new ProjectError(409, "staged_already_applied", "该任务的隔离副本变更已经合并回项目目录。");
    }
    if (isBuiltInStaged && ticket.workspaceStaging!.discardedAt) {
      throw new ProjectError(409, "staged_already_discarded", "该任务的隔离副本已被清理或丢弃。");
    }
    if (!this.envManager.getEnvDescriptor(ticket.envId)?.online) {
      throw new ProjectError(503, "device_offline", "执行设备离线，暂时无法读取隔离副本差异。");
    }
    if (isExternalStaged) {
      const response = await this.envManager.requestExternalAgent(ticket.envId, {
        operation: "diff",
        taskId: ticket.id,
        ...(filePath?.trim() ? { filePath: filePath.trim() } : {}),
      });
      if (response.type !== "diff") throw new Error("客户端未返回有效的差异结果。");
      return redactCredentialData(response.diff, (value) => this.connectionManager.redact(value));
    }
    const diff = await this.envManager.inspectStagedWorkspaceDiff(ticket.envId, ticket.id, filePath);
    return redactCredentialData(diff, (value) => this.connectionManager.redact(value));
  }

  async applyStagedChanges(params: ApplyStagedChangesParams, context: Context = BACKGROUND_CONTEXT): Promise<StagedWorkspaceApplyResult> {
    const cleanCmdId = params.commandId?.trim();
    if (!cleanCmdId) throw new ProjectError(400, "invalid_command_id", "合并操作需要有效的 command_id。");
    return this.#queueTicketOperation(params.ticketId, async () => {
      const snapshot = await this.harness.snapshot(KuloStateDoc, context);
      const ticket = snapshot?.tickets[params.ticketId];
      if (!ticket) throw new ProjectError(404, "ticket_not_found", `任务 '${params.ticketId}' 不存在。`);
      if (params.originConversationId !== undefined && (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== params.originConversationId) {
        throw new ProjectError(403, "ticket_scope_denied", "不能跨会话合并其他对话的任务变更。");
      }
      const isExternalStaged = ticket.externalExecution?.workspaceMode === "staged";
      const isBuiltInStaged = !ticket.externalExecution && ticket.workspaceStaging?.mode === "staged";
      if (!isExternalStaged && !isBuiltInStaged) {
        throw new ProjectError(400, "staged_workspace_unavailable", "该任务未使用隔离副本（staged）工作区模式。");
      }
      const alreadyApplied = Boolean(
        isExternalStaged ? ticket.externalExecution!.stagedAppliedAt : ticket.workspaceStaging!.appliedAt,
      );
      const priorCmd = snapshot?.processedCommands?.[cleanCmdId];
      if (priorCmd) {
        if (priorCmd.ticketId !== ticket.id || priorCmd.action !== "apply_staged") legacyDeliveryConflict();
        if (alreadyApplied) return { appliedAdded: [], appliedModified: [], appliedDeleted: [], cleanedUp: true };
      }
      if (alreadyApplied) {
        return { appliedAdded: [], appliedModified: [], appliedDeleted: [], cleanedUp: true };
      }
      if (isBuiltInStaged && ticket.workspaceStaging!.discardedAt) {
        throw new ProjectError(409, "staged_already_discarded", "该任务的隔离副本已被清理或丢弃。");
      }
      if (isTicketUnfinished(ticket)) {
        throw new ProjectError(409, "ticket_still_running", "请等待任务结束当前轮执行后再合并变更。");
      }
      if (ticket.status === "stopped" || ticket.status === "closed") {
        throw new ProjectError(409, "ticket_stopped", "已停止或关闭的任务不能再合并隔离副本。");
      }
      if (!ticket.projectId) {
        throw new ProjectError(400, "project_required", "隔离副本合并需要绑定的项目。");
      }
      if (!this.envManager.getEnvDescriptor(ticket.envId)?.online) {
        throw new ProjectError(503, "device_offline", "执行设备离线，请待设备重连后再合并。");
      }
      const project = await this.projects.ensureAuthorized(ticket.projectId, context);
      if (project.grantRevision !== ticket.grantRevision || project.directoryId !== ticket.directoryId ||
          project.deviceId !== ticket.envId || project.workspaceDir !== ticket.workspaceDir) {
        throw new ProjectError(409, "project_binding_changed", "项目目录或授权版本已变化，不能将旧副本覆盖到新目录。");
      }
      let applied: StagedWorkspaceApplyResult;
      if (isExternalStaged) {
        const response = await this.envManager.requestExternalAgent(ticket.envId, {
          operation: "apply",
          taskId: ticket.id,
          projectId: project.id,
          directoryId: project.directoryId,
          grantRevision: project.grantRevision,
          ...(params.paths?.length ? { paths: params.paths } : {}),
          ...(params.allowConflicts ? { allowConflicts: true } : {}),
        });
        if (response.type !== "apply") throw new Error("执行节点未返回有效的合并回执。");
        applied = response.applied;
      } else {
        applied = await this.envManager.applyStagedWorkspaceChanges(ticket.envId, {
          taskId: ticket.id,
          projectId: project.id,
          directoryId: project.directoryId,
          grantRevision: project.grantRevision,
          ...(params.paths?.length ? { paths: params.paths } : {}),
          ...(params.allowConflicts ? { allowConflicts: true } : {}),
        });
      }
      const appliedDigest = createHash("sha256")
        .update(JSON.stringify([ticket.id, ticket.runEpoch, applied.appliedAdded, applied.appliedModified, applied.appliedDeleted]))
        .digest("hex")
        .slice(0, 32);
      let unlockedOrScheduled = false;
      await this.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const current = state.tickets[ticket.id];
        if (!current) return;
        recordProcessedCommand(state, cleanCmdId, ticket.id, "apply_staged");
        const now = Date.now();
        const appliedSet = new Set([
          ...applied.appliedAdded,
          ...applied.appliedModified,
          ...applied.appliedDeleted,
        ]);
        const filterSummary = (prev: StagedWorkspaceDiffSummary): StagedWorkspaceDiffSummary => {
          const added = prev.added.filter((p) => !appliedSet.has(p));
          const modified = prev.modified.filter((p) => !appliedSet.has(p));
          const deleted = prev.deleted.filter((p) => !appliedSet.has(p));
          const emptyDirsAdded = prev.emptyDirsAdded?.filter((p) => !appliedSet.has(p));
          const emptyDirsDeleted = prev.emptyDirsDeleted?.filter((p) => !appliedSet.has(p));
          const modeChanged = prev.modeChanged?.filter((p) => !appliedSet.has(p));
          const sensitivePaths = prev.sensitivePaths?.filter((p) => !appliedSet.has(p));
          const dirChanges = (emptyDirsAdded?.length ?? 0) + (emptyDirsDeleted?.length ?? 0);
          return {
            ...prev,
            hasChanges: added.length + modified.length + deleted.length + dirChanges > 0,
            added,
            modified,
            deleted,
            ...(emptyDirsAdded?.length ? { emptyDirsAdded } : { emptyDirsAdded: undefined }),
            ...(emptyDirsDeleted?.length ? { emptyDirsDeleted } : { emptyDirsDeleted: undefined }),
            ...(modeChanged?.length ? { modeChanged } : { modeChanged: undefined }),
            ...(sensitivePaths?.length ? { sensitivePaths } : { sensitivePaths: undefined }),
            conflictFiles: prev.conflictFiles.filter((p) => !appliedSet.has(p)),
          };
        };
        if (current.externalExecution?.workspaceMode === "staged") {
          if (applied.cleanedUp) {
            current.externalExecution.stagedAppliedAt = now;
            delete current.externalExecution.stagedCwd;
            delete current.externalExecution.stagedDiff;
          } else if (current.externalExecution.stagedDiff) {
            current.externalExecution.stagedDiff = filterSummary(current.externalExecution.stagedDiff);
          }
        } else if (current.workspaceStaging?.mode === "staged") {
          if (applied.cleanedUp) {
            current.workspaceStaging.appliedAt = now;
            current.workspaceStaging.appliedDigest = appliedDigest;
            delete current.workspaceStaging.stagedCwd;
            delete current.workspaceStaging.stagedDiff;
          } else if (current.workspaceStaging.stagedDiff) {
            current.workspaceStaging.stagedDiff = filterSummary(current.workspaceStaging.stagedDiff);
          }
        }
        if (!hasPendingWorkspaceApply(current)) {
          releaseProjectWrite(state, current.id);
          unlockedOrScheduled = true;
          // Re-arm deferred repeating schedule once staged changes have merged cleanly.
          if (
            current.status === "ready" &&
            current.schedule?.repeatEverySeconds &&
            current.schedule.deletedAt === undefined &&
            current.activeTaskId === undefined
          ) {
            const settingsDoc = await tx.doc(SettingsAssistantDoc);
            const origin = state.topics?.[current.originTopicId ?? "root"];
            const settingsConv = parseSettingsTopicConversationId(current.originTopicId);
            const originAlive = settingsConv !== null
              ? isActiveSettingsConversation(settingsConv, settingsDoc)
              : Boolean(origin && origin.deletedAt === undefined);
            if (originAlive) {
              const interval = current.schedule.repeatEverySeconds * 1000;
              const nextRunAt = current.schedule.nextRunAt && current.schedule.nextRunAt > now
                ? current.schedule.nextRunAt
                : current.schedule.executeAt + (Math.floor((now - current.schedule.executeAt) / interval) + 1) * interval;
              current.schedule.nextRunAt = nextRunAt;
              current.waiting = { reason: "time", since: now, until: nextRunAt, detail: "等待下次定时执行" };
              transitionTicketStatus(current, "waiting", now);
              const taskId = await tx.createTask(
                this.#workerTicketTask,
                { ticketId: current.id, runEpoch: current.runEpoch, promptOverride: null },
                { ownership: { kind: "conversation" }, conversationId: (current.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, background: true },
              );
              current.activeTaskId = Number(taskId);
            }
          }
        }
        current.updatedAt = now;
      }, context);
      if (unlockedOrScheduled && !this.#recovering) this.harness.resume();
      await this.#broadcastTickets(context);
      return applied;
    });
  }

  async #materializeExternalAttachments(
    ticket: Readonly<TicketRecord>,
    attachmentIds: readonly string[],
    context: Context,
  ): Promise<Array<{ id: string; name: string; mimeType: string; path: string }>> {
    if (!attachmentIds.length || !ticket.scratchDir) return [];
    const envDesc = this.envManager.getEnvDescriptor(ticket.envId);
    if (!envDesc?.online) return [];
    const pathApi = envDesc.platform === "win32" ? path.win32 : path.posix;
    const inputsDir = pathApi.join(ticket.scratchDir, "inputs");
    const env = this.envManager.createExecutionEnv(ticket.envId, ticket.scratchDir);
    getOrThrow(await env.createDir(inputsDir, { recursive: true }, context));
    const assertActive = async () => {
      const current = (await this.harness.snapshot(KuloStateDoc, context))?.tickets[ticket.id];
      if (!current || ["stopped", "closed"].includes(current.status)) throw new Error("任务已结束，停止转存附件。");
    };
    const epochPrefix = ticket.runEpoch > 1 ? `e${ticket.runEpoch}-` : "";
    const results: Array<{ id: string; name: string; mimeType: string; path: string }> = [];
    for (const [index, id] of attachmentIds.entries()) {
      const loaded = this.uploads.getUpload(id);
      if (!loaded) continue;
      const safeName = `${epochPrefix}${String(index + 1).padStart(2, "0")}-${sanitizeDiskFilename(loaded.record.name)}`;
      const targetPath = pathApi.join(inputsDir, safeName);
      const handle = await fs.promises.open(loaded.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        let sha = loaded.record.sha256;
        if (!sha) {
          const hasher = createHash("sha256");
          let pos = 0;
          while (pos < stat.size) {
            const buf = Buffer.alloc(Math.min(EXECUTION_FILE_CHUNK_BYTES, stat.size - pos));
            const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
            if (bytesRead <= 0) break;
            pos += bytesRead;
            hasher.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
          }
          sha = hasher.digest("hex");
        }
        async function* chunks(): AsyncGenerator<Uint8Array> {
          let offset = 0;
          while (offset < stat.size) {
            const buffer = Buffer.alloc(Math.min(EXECUTION_FILE_CHUNK_BYTES, stat.size - offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (bytesRead <= 0) break;
            offset += bytesRead;
            yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
          }
        }
        const written = await writeExecutionFile({
          env,
          root: ticket.scratchDir,
          target: targetPath,
          size: stat.size,
          hash: sha,
          chunks: chunks(),
          overwrite: true,
          assertActive,
          context,
        });
        results.push({ id: loaded.record.id, name: loaded.record.name, mimeType: loaded.record.mimeType, path: written.path });
      } finally {
        await handle.close();
      }
    }
    return results;
  }

  async #consumeExternalPendingReports(
    ticket: Readonly<TicketRecord>,
    reports: readonly ExternalAgentPendingReport[],
    context: Context,
  ): Promise<string[]> {
    const ackIds: string[] = [];
    let anyCommitted = false;
    for (const pending of reports) {
      const snap = await this.harness.snapshot(KuloStateDoc, context);
      const current = snap?.tickets[ticket.id];
      if (!current || current.runEpoch !== ticket.runEpoch || !current.externalExecution) break;
      if (current.externalExecution.consumedPendingReportIds?.includes(pending.reportId)) {
        ackIds.push(pending.reportId);
        continue;
      }

      const stagedAttachments: ChatAttachment[] = [];
      if (pending.files?.length) {
        const ownerId = `agent:${current.workerConversationId}`;
        for (const [index, file] of pending.files.entries()) {
          const env = this.envManager.createExecutionEnv(current.envId, path.dirname(file.snapshotPath));
          const readRes = await env.readBinaryFile(file.snapshotPath, context);
          if (!readRes.ok) {
            throw new Error(`无法读取离线交卷文件快照：${file.originalPath}`);
          }
          const bytes = Buffer.from(readRes.value);
          const actualSha = createHash("sha256").update(bytes).digest("hex");
          if (bytes.byteLength !== file.size || actualSha !== file.sha256) {
            throw new Error(`离线交卷文件快照校验失败：${file.originalPath}`);
          }
          const saved = this.uploads.saveUpload({
            name: file.name ?? path.basename(file.originalPath),
            mimeType: file.mimeType,
            bytes,
            ownerId,
            idempotencyKey: `ext-outbox:${current.id}:${current.runEpoch}:${pending.reportId}:${index}`,
          });
          this.uploads.bindAttachments([saved], `ticket:${current.id}`, ownerId);
          this.uploads.bindAttachments([saved], `conversation:${current.workerConversationId}`, ownerId);
          if (current.originConversationId !== undefined) {
            this.uploads.bindAttachments([saved], `conversation:${current.originConversationId}`, ownerId);
          }
          stagedAttachments.push(saved);
        }
      }

      const nextVersion = (current.externalExecution.explicitReportVersion ?? 0) + 1;
      const spilled = spillOversizedReport({
        uploads: this.uploads,
        ticketId: current.id,
        runEpoch: current.runEpoch,
        version: nextVersion,
        ownerConversationId: current.workerConversationId,
        originConversationId: current.originConversationId,
        report: {
          state: pending.state,
          summary: this.connectionManager.redact(pending.summary),
          ...(pending.deliverable ? { deliverable: this.connectionManager.redact(pending.deliverable) } : {}),
          ...(pending.question ? { question: this.connectionManager.redact(pending.question) } : {}),
          at: pending.at,
        },
      });
      const finalizedReport: WorkerReportRecord = {
        ...spilled,
        ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
      };

      await this.harness.commit(async (tx) => {
        const live = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
        if (!live || live.runEpoch !== ticket.runEpoch || !live.externalExecution) return;
        const consumed = live.externalExecution.consumedPendingReportIds ?? [];
        if (consumed.includes(pending.reportId)) return;
        live.externalExecution.consumedPendingReportIds = [...consumed, pending.reportId];
        const committedVersion = Math.max(nextVersion, (live.externalExecution.explicitReportVersion ?? 0) + 1);
        live.externalExecution.explicitReportVersion = committedVersion;
        live.latestReport = cloneJson(finalizedReport);
        if (finalizedReport.state === "ready") {
          live.externalExecution.explicitReadyReport = {
            ...cloneJson(finalizedReport),
            runEpoch: live.runEpoch,
            version: committedVersion,
          };
        } else if (finalizedReport.state === "blocked" || finalizedReport.state === "failed") {
          delete live.externalExecution.explicitReadyReport;
        }
        live.externalExecution.lastActivityAt = Date.now();
        live.updatedAt = Date.now();
        anyCommitted = true;
      }, context);
      ackIds.push(pending.reportId);
    }
    if (anyCommitted) {
      await this.#broadcastTickets(context);
    }
    return ackIds;
  }

  async #stageExternalReportFiles(scope: ExternalAgentToolScope, files: ExternalAgentReportFile[]): Promise<ChatAttachment[]> {
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const ticket = this.#externalAgentScope(scope, state);
    const envDesc = this.envManager.getEnvDescriptor(ticket.envId);
    if (!envDesc?.online) throw new Error("执行设备离线，无法读取待审产物文件。");
    const pathApi = envDesc.platform === "win32" ? path.win32 : path.posix;
    const insideRoot = (candidate: string, root: string) => {
      const rel = pathApi.relative(root, candidate);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
    };
    const stagedCwd = ticket.externalExecution?.stagedCwd && !ticket.externalExecution.stagedAppliedAt ? ticket.externalExecution.stagedCwd : undefined;
    const protectedPaths = [this.config.stateDir, resolveEffectiveIdentityDir(this.#liveSettings, this.#defaultIdentityDir)];
    const staged: ChatAttachment[] = [];
    for (const [index, item] of files.entries()) {
      const allowedRoot = stagedCwd && (!pathApi.isAbsolute(item.path) || insideRoot(item.path, stagedCwd))
        ? stagedCwd
        : ticket.scratchDir && pathApi.isAbsolute(item.path) && insideRoot(item.path, ticket.scratchDir)
          ? ticket.scratchDir
          : ticket.workspaceDir;
      const resolvedPath = pathApi.isAbsolute(item.path) ? item.path : pathApi.resolve(allowedRoot, item.path);
      const env = this.envManager.createExecutionEnv(ticket.envId, allowedRoot);
      const callId = `external-report-file:${scope.runId}:${index}:${createHash("sha256").update(resolvedPath).digest("hex").slice(0, 16)}`;
      const asset = await publishExecutionAsset(
        {
          path: resolvedPath,
          ...(item.name ? { name: item.name } : {}),
          ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          ...(item.caption ? { caption: item.caption } : {}),
        },
        { env, conversationId: ticket.workerConversationId as ConversationId, callId },
        BACKGROUND_CONTEXT,
        this.uploads,
        {
          allowedRoot,
          protectedPaths: protectedPaths.filter((p) => !insideRoot(allowedRoot, p)),
          trustedSandbox: true,
          ownerId: `agent:${ticket.workerConversationId}`,
        },
      );
      await this.#stageWorkerArtifact(asset, {
        conversationId: ticket.workerConversationId,
        topicId: ticket.originTopicId ?? "root",
        ticketId: ticket.id,
        runEpoch: ticket.runEpoch,
        envId: ticket.envId,
      }, callId);
      staged.push(asset);
    }
    return staged;
  }

  async #verifyExternalAgent(draft: AgentConfigurationDraft, nonce: string): Promise<{ sessionId?: string; version?: string }> {
    const env = this.envManager.getEnvDescriptor(draft.binding.envId);
    if (!env?.online || !env.rootDir) throw new Error("连接测试需要在线的电脑执行设备。");
    const pathApi = env.platform === "win32" ? path.win32 : path.posix;
    const id = `agent-setup-${createHash("sha256").update(`${draft.id}:${draft.revision}:${nonce}`).digest("hex").slice(0, 24)}`;
    const requestId = `${id}:verify`;
    let response = await this.envManager.requestExternalAgent(env.id, { operation: "run", binding: draft.binding, taskId: id,
      runEpoch: draft.revision, requestId, prompt: `Authorized external client connectivity check. Reply with the exact verification token below only—do not call tools or read/modify any files:\n${nonce}`,
      cwd: pathApi.join(env.rootDir, "table", id), ...(draft.modelId ? { modelId: draft.modelId } : {}),
      ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}), readOnly: false, allowSubagents: false, timeoutMs: 60_000 });
    if (response.type !== "run") throw new Error("客户端没有返回测试执行标识。");
    const deadline = Date.now() + 60_000;
    const matchesNonce = (rawText: string): boolean => {
      let cleaned = rawText.trim();
      const fenced = /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/.exec(cleaned);
      if (fenced) cleaned = fenced[1]!.trim();
      cleaned = cleaned.replace(/^(?:\*\*|__|`|["'「『“‘])+/, "").replace(/(?:\*\*|__|`|["'」』”’.,!。！])+$/, "").trim();
      return cleaned === nonce;
    };
    try {
      while (["starting", "running", "waiting"].includes(response.run.state) && Date.now() < deadline) {
        if (response.run.permissions.length) throw new Error("通信测试请求了额外工具授权，未自动批准。");
        await new Promise((resolve) => setTimeout(resolve, 200));
        response = await this.envManager.requestExternalAgent(env.id, { operation: "inspect", runId: requestId });
        if (response.type !== "run") throw new Error("测试执行状态无效。");
      }
      if (response.run.state !== "completed" || !matchesNonce(response.run.text)) throw new Error(this.connectionManager.redact(response.run.error || "客户端尚未确认正确的测试回复，请核对原会话。"));
      return { sessionId: response.run.sessionId, version: draft.detection?.version };
    } finally {
      try {
        await this.envManager.requestExternalAgent(env.id, { operation: "close", runId: requestId, discardStaged: true });
      } catch { /* ignore cleanup error on close */ }
    }
  }

  async retryTicket(
    ticketId: string,
    context: Context = BACKGROUND_CONTEXT,
    commandId?: string,
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    const intent = suppliedIntent ?? clientDeliveryIntent({ type: "ticket.retry", ticketId, commandId });
    return this.#withDelivery(intent, context, () => this.#queueTicketOperation(ticketId, () => this.#steerTicket(
      {
        commandId: commandId?.trim() || `retry-${ticketId}-${Date.now()}`,
        ticketId,
        text: "The user requested a retry of this ticket. Diagnose the prior failure or blocker, continue execution within scope, and report verified results.",
        resetRecovery: true,
      },
      context, intent,
    )), (receipt) => this.#receiptTicket(receipt, context));
  }

  async steerTicket(
    params: SteerTicketParams,
    context: Context = BACKGROUND_CONTEXT,
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    assertValidReplyReference(params.replyTo);
    const intent = suppliedIntent ?? clientDeliveryIntent({ type: "ticket.steer", ticketId: params.ticketId, commandId: params.commandId,
      text: params.text, attachments: params.attachments, replyTo: params.replyTo, ...(params.decisionOptionId ? { decisionOptionId: params.decisionOptionId } : {}), ...(params.resetRecovery ? { resetRecovery: true } : {}), ...(params.interrupt ? { interrupt: true } : {}) }, params.principalId);
    return this.#withDelivery(intent, context, () => this.#queueTicketOperation(params.ticketId, () => this.#steerTicket(params, context, intent)), (receipt) => this.#receiptTicket(receipt, context));
  }

  async #steerTicket(params: SteerTicketParams, context: Context, intent?: DeliveryIntent): Promise<TicketCardView> {
    const recoveryGuard = await this.#currentRecoveryGuard(params.originConversationId, context, params.originToolTaskId);
    if (params.principalId && params.attachments?.some((asset) => !this.uploads.canReadUpload(asset.id, params.principalId!))) {
      throw Object.assign(new Error("无权引用此附件。"), { code: "attachment_forbidden", status: 403 });
    }
    const cleanCmdId = params.commandId?.trim();
    const snapshot = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[params.ticketId];
    if (!ticket) throw new Error(`Ticket '${params.ticketId}' not found`);
    let effectiveText = params.text;
    if (params.originConversationId === undefined && ticket.waiting?.requestId) {
      const pending = await this.actionConfirmations.getById(ticket.waiting.requestId, context);
      if (pending && pending.payload.kind === "computer_handoff" && pending.status === "pending") {
        const action = params.decisionOptionId === "cancel" ? "cancel" : "done";
        this.#computerHandoffs.clear(params.ticketId);
        await this.actionConfirmations.resolveProgrammatically(pending.id, {
          status: action === "done" ? "approved" : "denied",
          selectedChoiceId: action === "done" ? "confirm" : "cancel",
          resultSummary: action === "done" ? "已在任务详情完成人工接管" : "已在任务详情跳过人工接管",
          markExecuted: true,
        }, context);
        if (action === "cancel") {
          for (const [key, session] of [...this.#computerSessions].filter(([, s]) => s.ticketId === params.ticketId)) {
            this.#computerSessions.delete(key);
            await this.envManager.requestComputerUse(session.envId, { tool: session.tool, action: "close", sessionId: session.sessionId }).catch(() => {});
          }
        }
        effectiveText = formatComputerHandoffResumePrompt({
          action,
          target: pending.payload.target,
          reason: pending.payload.reason,
          manualInstruction: params.decisionOptionId ? undefined : params.text,
        });
      }
      if (pending && pending.payload.kind === "host_action" && (pending.status === "pending" || pending.status === "pending_orchestrator")) {
        const payload = pending.payload;
        if (params.decisionOptionId === "confirm") {
          const resolved = await this.actionConfirmations.resolveProgrammatically(
            pending.id,
            { status: "approved", selectedChoiceId: "confirm", resultSummary: "已在任务详情允许", markExecuted: true },
            context,
          );
          if (resolved) {
            if (payload.ticketId) {
              await this.#recordTicketOutwardAction(payload.ticketId, undefined, "host_action", `host_action:${payload.summary}`, context);
            }
            try {
              const result = await this.envManager.requestHostAction(payload.envId, {
                kind: "run",
                commands: payload.commands,
                ...(payload.cwd ? { cwd: payload.cwd } : {}),
                ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
              });
              const safeOut = this.connectionManager.redact(JSON.stringify(result));
              effectiveText = `用户已批准并在 ${payload.envName} (${payload.envId}) 上执行完成本机操作「${payload.summary}」。执行结果：\n${safeOut}\n请基于实际执行结果继续验证并完成当前任务。`;
            } catch (error) {
              const errMsg = this.connectionManager.redact(error instanceof Error ? error.message : "本机操作执行失败");
              effectiveText = `用户已批准在 ${payload.envName} (${payload.envId}) 上执行本机操作「${payload.summary}」，但执行失败：${errMsg}\n请基于实际执行结果继续处理或向主智能体汇报。`;
            }
          }
        } else if (params.decisionOptionId === "cancel") {
          await this.actionConfirmations.resolveProgrammatically(
            pending.id,
            { status: "denied", selectedChoiceId: "cancel", resultSummary: "已在任务详情拒绝", markExecuted: true },
            context,
          );
          effectiveText = `用户拒绝了在 ${payload.envName} (${payload.envId}) 上执行的本机操作「${payload.summary}」。请勿再次尝试同一操作，改用其他方案或直接向主智能体汇报。`;
        } else {
          // User typed custom manual text in Task Detail for a pending host_action -> hand off to Main Agent!
          const manualText = this.connectionManager.redact(params.text.trim());
          if (pending.cardId) {
            await this.uiCards.settle(pending.cardId, { status: "submitted", resultSummary: "已在任务详情补充说明" });
            await this.actionConfirmations.resolveFromUiSubmit(
              pending.cardId,
              Object.entries(pending.actionMap).find(([, logical]) => logical === "manual")?.[0] ?? "",
              { instruction: manualText },
              context,
            );
          }
          const originConvId = (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId;
          const originConv = await this.harness.conversation(originConvId, context);
          const updatedCard = await this.harness.commit(async (tx) => {
            const state = await tx.doc(KuloStateDoc);
            const live = state.tickets[params.ticketId];
            if (!live) throw new Error(`Ticket '${params.ticketId}' not found`);
            recordProcessedCommand(state, cleanCmdId, live.id, "steer");
            await writeDeliveryReceipt(tx, intent, { ticketId: live.id });
            live.waiting = {
              reason: "coordinator",
              since: Date.now(),
              detail: manualText || live.waiting?.detail,
              waitToken: `host-action-req:${pending.id}`,
              requestId: pending.id,
            };
            live.updatedAt = Date.now();
            if (originConv) {
              await injectEventToolsInTx(tx, originConv.id, ["kulo_host_action_decide"]);
              await submitAutomaticChatInput(tx, originConv, {
                type: "input",
                content: `[KULO_USER_TASK_INSTRUCTION]\n用户在任务「${live.title}」（${live.id}）的待确认本机操作（request_id="${pending.id}"）中手动输入了说明：\n${manualText}\n请结合用户说明调用 kulo_host_action_decide(approve/deny) 或 kulo_steer 处理。`,
                whenBusy: "followUp",
                requestId: `kulo:task-manual:${pending.id}:${cleanCmdId ?? randomUUID()}`,
              });
            }
            return toTicketCardView(live, this.#liveSettings.roles);
          }, context);
          if (!this.#recovering) this.harness.resume();
          await this.#broadcastTickets(context);
          return updatedCard;
        }
      }
    }
    if (ticket.waiting?.requestId || ticket.waiting?.cardId) {
      const targetId = ticket.waiting.requestId ?? ticket.waiting.cardId!;
      const pending = await this.actionConfirmations.getById(targetId, context);
      if (pending && pending.payload.kind === "ticket_decision" && (pending.status === "pending" || pending.status === "pending_orchestrator")) {
        await this.actionConfirmations.resolveProgrammatically(
          pending.id,
          {
            status: "approved",
            selectedChoiceId: params.decisionOptionId ?? "chat",
            resultSummary: params.originConversationId !== undefined ? "已通过对话处理" : "已在任务详情确认",
            markExecuted: true,
          },
          context,
        );
      } else if (!pending && ticket.waiting.cardId) {
        await this.uiCards.settle(ticket.waiting.cardId, {
          status: "submitted",
          resultSummary: params.originConversationId !== undefined ? "已通过对话处理" : "已在任务详情确认",
        });
      }
    }
    const assignmentSource = params.originConversationId === undefined
      ? { intent: extractAgentDispatchIntent(effectiveText, this.#liveSettings.roles, this.envManager.listEnvs(), this.#liveSettings.externalClients) }
      : await this.#agentDispatchSource(params.originConversationId, params.originToolTaskId, context);
    if (assignmentSource.intent) {
      const choice = resolveAgentDispatch({ roles: this.#liveSettings.roles, externalClients: this.#liveSettings.externalClients, language: this.#liveSettings.presentation.language, intent: assignmentSource.intent, requestedRole: ticket.role,
        taskKind: ticket.agentAssignment?.taskKind, projectId: ticket.projectId, envId: ticket.envId, trustedManual: true });
      const boundRole = resolveRoleOrDirectClient(ticket.role, this.#liveSettings.roles, this.#liveSettings.externalClients, this.#liveSettings.presentation.language)
        ?? resolveRolePresetFromPool(this.#liveSettings.roles, ticket.role).preset;
      const sameLegacyInternalRole = !ticket.externalExecution && !boundRole?.external && boundRole?.id === choice.role;
      if (choice.role !== ticket.role && !sameLegacyInternalRole) throw new ProjectError(409, "agent_binding_conflict", `该任务固定由「${boundRole?.label ?? ticket.role}」执行。本次点名了其他 Agent，请创建对应的新任务，不能通过继续操作更换执行者。`);
      assertAgentDispatchAvailable(boundRole, { envs: this.envManager.listEnvs(), envId: ticket.envId });
    }
    if (ticket.externalExecution && params.attachments?.length && (!ticket.scratchDir || params.attachments.some((att) => typeof att?.id !== "string" || !this.uploads.getUpload(att.id)))) {
      throw new ProjectError(400, "external_agent_attachments_unsupported", "外部智能体附件需要有效受管上传及任务草稿箱支持。");
    }
    if (cleanCmdId && snapshot?.processedCommands?.[cleanCmdId]) {
      legacyDeliveryConflict();
    }
    if (snapshot) assertRecoveryGuard(snapshot, recoveryGuard);
    if (recoveryGuard && recoveryGuard.ticketId !== params.ticketId) throw new Error("自动恢复只能推进当前失败任务。");
    if (ticket.status === "stopped" || ticket.status === "closed") throw new ProjectError(409, "ticket_stopped", `Ticket '${params.ticketId}' was explicitly stopped or closed and cannot auto-resume.`);
    if (ticket.projectId) {
      const project = await this.projects.get(ticket.projectId, context);
      if (project.grantRevision !== ticket.grantRevision || project.workspaceDir !== ticket.workspaceDir || project.deviceId !== ticket.envId || project.directoryId !== ticket.directoryId) {
        throw new ProjectError(409, "project_binding_changed", "项目位置已改变，请创建新任务。");
      }
      if (this.envManager.getEnvDescriptor(ticket.envId)?.online) await this.projects.ensureAuthorized(project.id, context);
    }
    const workerConv = await this.harness.conversation(ticket.workerConversationId as ConversationId, context);
    if (!workerConv) throw new Error(`Worker conversation for '${params.ticketId}' not found`);
    if (cleanCmdId && await this.harness.commit(tx => tx.submissionByRequest(workerConv.id, `kulo:steer:${cleanCmdId}`), context)) legacyDeliveryConflict();
    const attachmentIds = this.uploads.resolveAttachments(params.attachments).map((item) => item.record.id);
    const protectedMessage = await this.connectionManager.processText(effectiveText, {
      requestId: cleanCmdId ? `steer:${ticket.id}:${cleanCmdId}` : undefined, replyText: params.replyTo?.text,
    });
    const prompt = protectedMessage.text.trim() || "请查看补充附件并继续原任务。";
    const replyTo = params.replyTo ? {
      messageId: params.replyTo.messageId,
      role: params.replyTo.role,
      text: this.connectionManager.redact(params.replyTo.text),
      ...(params.replyTo.excerpt ? { excerpt: true } : {}),
    } : undefined;
    const modelPrompt = replyContext(prompt, replyTo);
    for (const { record } of this.uploads.resolveAttachments(params.attachments)) {
      if (record.kind === "audio") await this.transcribeVoiceAsset(record.id, { topicId: ticket.originTopicId ?? "root", principalId: params.principalId || this.envManager.localEnvId }, context);
    }
    const prepared = this.uploads.buildMultimodalContent(`【主控补充引导】\n${modelPrompt}`, params.attachments);
    let created = false;
    let injected = false;
    let interruptTarget: { envId: string; runId: string } | undefined;
    const card = await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[params.ticketId];
      if (!t || t.status === "stopped" || t.status === "closed") throw new ProjectError(409, "ticket_stopped", "任务已停止，不能恢复。");
      if (t.schedule) {
        const settingsDoc = await tx.doc(SettingsAssistantDoc);
        const settingsConv = parseSettingsTopicConversationId(t.originTopicId);
        if (settingsConv !== null) {
          if (!isActiveSettingsConversation(settingsConv, settingsDoc)) throw new ProjectError(404, "topic_deleted", "定时任务所属会话已删除。");
        } else {
          const origin = state.topics?.[t.originTopicId ?? "root"];
          if (!origin || origin.deletedAt !== undefined) throw new ProjectError(404, "topic_deleted", "定时任务所属会话已删除。");
        }
      }
      if (cleanCmdId && state.processedCommands?.[cleanCmdId]) {
        legacyDeliveryConflict();
      }
      assertRecoveryGuard(state, recoveryGuard);
      if (params.resetRecovery) {
        const prior = t.recovery;
        if (prior) for (const related of Object.values(state.tickets)) {
          if (related.recovery?.startedAt === prior.startedAt && related.recovery.rootTicketId === prior.rootTicketId) related.recovery = undefined;
        }
        t.recovery = undefined;
        t.autoRecoverySuppressed = undefined;
      }
      if (t.projectId) {
        const project = assertProjectBinding(await tx.doc(KuloProjectsDoc), t.projectId);
        if (project.grantRevision !== t.grantRevision || project.directoryId !== t.directoryId || project.deviceId !== t.envId) {
          throw new ProjectError(409, "project_binding_changed", "项目位置已改变，请创建新任务。");
        }
      }
      recordProcessedCommand(state, cleanCmdId, t.id, "steer");
      await writeDeliveryReceipt(tx, intent, { ticketId: t.id });
      if (!t.externalExecution && t.status === "running" && !t.waiting && !this.#parkingTickets.has(t.id) && this.#ticketDevicesOnline(t)) {
        await workerConv.submit(tx, { type: "input", content: prepared.content, entry: userDisplayEntry(`【主控补充引导】\n${prompt}`, prepared.attachments, undefined, replyTo),
          whenBusy: "steer", requestId: `kulo:steer:${cleanCmdId ?? randomUUID()}` });
        t.updatedAt = Date.now();
        injected = true;
        return toTicketCardView(t, this.#liveSettings.roles);
      }
      if (replyTo) {
        // A parked worker receives this context on resume; keep its user-facing reply visible immediately without duplicating model input.
        const display = userDisplayEntry(`【主控补充引导】\n${prompt}`, prepared.attachments, { createdAt: Date.now() }, replyTo);
        await tx.appendEntry(workerConv.id, display);
      }
      t.resumePrompt = [t.resumePrompt, `[Follow-Up / Resume Instructions]\n${modelPrompt}`].filter(Boolean).join("\n\n");
      t.resumeAttachmentIds = [...new Set([...(t.resumeAttachmentIds ?? []), ...attachmentIds])];
      t.updatedAt = Date.now();
      if (t.externalExecution && t.status === "running") {
        t.wakePending = true;
        if (params.interrupt && t.externalExecution.runId) {
          t.externalExecution.interruptPending = true;
          interruptTarget = { envId: t.envId, runId: t.externalExecution.runId };
        }
        return toTicketCardView(t, this.#liveSettings.roles);
      }
      if (t.schedule?.nextRunAt != null && t.schedule.nextRunAt > Date.now()) return toTicketCardView(t, this.#liveSettings.roles);
      if (t.status === "queued") return toTicketCardView(t, this.#liveSettings.roles);
      t.wakePending = true;
      if (t.status === "pausing" || (t.status === "running" && this.#parkingTickets.has(t.id))) return toTicketCardView(t, this.#liveSettings.roles);
      if (!this.#ticketDevicesOnline(t) || t.cleanupPending || hasActiveSubagents(state, t.id)) {
        transitionTicketStatus(t, "waiting", Date.now());
        t.waiting = { reason: "env", since: Date.now(), detail: t.cleanupPending ? "等待确认旧执行已清理" : "等待执行设备上线" };
        return toTicketCardView(t, this.#liveSettings.roles);
      }
      const nextEpoch = t.runEpoch + 1;
      if (t.externalExecution) {
        delete t.externalExecution.runId;
        delete t.externalExecution.pendingPermissions;
      }
      const taskId = await tx.createTask(this.#workerTicketTask, { ticketId: t.id, runEpoch: nextEpoch,
        promptOverride: t.resumePrompt, attachmentIds: t.resumeAttachmentIds }, { ownership: { kind: "conversation" }, conversationId: (t.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, background: true });
      t.runEpoch = nextEpoch;
      transitionTicketStatus(t, "queued", Date.now());
      t.activeTaskId = Number(taskId);
      t.waiting = undefined;
      if (t.schedule) t.schedule.nextRunAt = null;
      t.resumePrompt = undefined;
      t.resumeAttachmentIds = undefined;
      t.wakePending = undefined;
      created = true;
      t.latestReport = { state: "progress", summary: "已收到补充要求，等待执行。", at: Date.now() };
      return toTicketCardView(t, this.#liveSettings.roles);
    }, context);
    this.uploads.bindAttachments(params.attachments, `conversation:${Number(workerConv.id)}`, params.principalId);
    if (interruptTarget && this.envManager.getEnvDescriptor(interruptTarget.envId)?.online) {
      await this.envManager.requestExternalAgent(interruptTarget.envId, { operation: "cancel", runId: interruptTarget.runId }).catch(() => {});
    }
    if ((created || injected) && !this.#recovering) this.harness.resume();
    if (!created && !injected && card.status === "waiting" && this.envManager.getEnvDescriptor(card.envId)?.online) {
      void this.#queueEnvReconcile();
    }
    await this.#broadcastTickets(context);
    return card;
  }

  async stopTicket(
    ticketId: string,
    reason: string | undefined,
    context: Context = BACKGROUND_CONTEXT,
    commandIdOrOrigin?: string | { conversationId: number; toolTaskId: number },
    originArgument?: { conversationId: number; toolTaskId: number },
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    const commandId = typeof commandIdOrOrigin === "string" ? commandIdOrOrigin : undefined;
    const origin = typeof commandIdOrOrigin === "object" ? commandIdOrOrigin : originArgument;
    const intent = suppliedIntent ?? clientDeliveryIntent({ type: "ticket.stop", ticketId, commandId, reason });
    return this.#withDelivery(intent, context,
      (receipt) => this.#queueTicketOperation(ticketId, () => this.#stopTicket(ticketId, reason, context, commandId, origin, intent, receipt)), (receipt) => this.#receiptTicket(receipt, context));
  }

  async #stopTicket(ticketId: string, reason: string | undefined, context: Context, commandId: string | undefined,
    origin: { conversationId: number; toolTaskId: number } | undefined, intent?: DeliveryIntent, prior?: Readonly<DeliveryReceipt>, deleteSchedule = false): Promise<TicketCardView> {
    const controlInput = await this.#currentControlInput(origin?.conversationId, context, origin?.toolTaskId);
    if (controlInput && WorkerRecoveryEntry.is(controlInput)) throw new ProjectError(409, "recovery_stop_denied", "自动恢复回合不能自行停止任务，请保留现有执行或请求用户决定。");
    if (controlInput && (WorkerWatchdogEntry.is(controlInput) || WorkerRelayEntry.is(controlInput))) {
      throw new ProjectError(409, "automatic_stop_denied", "后台巡检和回报不能代替用户停止任务。请纠偏，或让 Worker 汇报实际阻塞与所需权限。");
    }
    const snapshot = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[ticketId];
    if (!ticket) throw new Error(`Ticket '${ticketId}' not found`);
    const removeSchedule = (current: TicketRecord) => {
      if (!deleteSchedule) return;
      if (!current.schedule) throw new ProjectError(404, "schedule_not_found", "定时任务不存在。");
      current.schedule.deletedAt ??= Date.now();
      current.schedule.nextRunAt = null;
      current.updatedAt = Date.now();
    };
    if (deleteSchedule && (ticket.status === "closed" || ticket.status === "ready" && ticket.schedule?.repeatEverySeconds === undefined)) {
      return this.harness.commit(async (tx) => {
        const current = (await tx.doc(KuloStateDoc)).tickets[ticketId]!;
        removeSchedule(current);
        await writeDeliveryReceipt(tx, intent, { ticketId });
        return toTicketCardView(current, this.#liveSettings.roles);
      }, context);
    }
    if (prior?.phase === "admitted" && ticket.runEpoch !== Number(prior.continuation.epoch)) {
      await this.harness.commit((tx) => writeDeliveryReceipt(tx, intent, { ticketId }), context);
      return toTicketCardView(ticket, this.#liveSettings.roles);
    }
    if (prior?.phase !== "admitted" && commandId && snapshot?.processedCommands?.[commandId]) {
      legacyDeliveryConflict();
    }
    if (ticket.status === "stopped" && !ticket.cleanupPending) {
      await this.harness.commit(async (tx) => {
        if (deleteSchedule) removeSchedule((await tx.doc(KuloStateDoc)).tickets[ticketId]!);
        await writeDeliveryReceipt(tx, intent, { ticketId });
      }, context);
      return toTicketCardView(ticket, this.#liveSettings.roles);
    }
    let epoch: number;
    if (prior?.phase === "admitted") {
      epoch = Number(prior.continuation.epoch);
    } else if (ticket.status === "stopped") {
      epoch = await this.harness.commit(async (tx) => {
        if (deleteSchedule) removeSchedule((await tx.doc(KuloStateDoc)).tickets[ticketId]!);
        await writeDeliveryReceipt(tx, intent, { ticketId }, "admitted", { epoch: ticket.runEpoch, previousEpoch: ticket.runEpoch - 1 });
        return ticket.runEpoch;
      }, context);
    } else {
      epoch = await this.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const t = state.tickets[ticketId]!;
        recordProcessedCommand(state, commandId, ticketId, "stop");
        t.runEpoch += 1;
        transitionTicketStatus(t, "stopped", Date.now());
        const previousRecovery = t.recovery;
        t.recovery = undefined;
        if (previousRecovery) for (const related of Object.values(state.tickets)) {
          if (related.recovery?.startedAt === previousRecovery.startedAt && related.recovery.rootTicketId === previousRecovery.rootTicketId) {
            related.recovery = undefined;
            if (related.id !== t.id) related.autoRecoverySuppressed = true;
          }
        }
        t.stoppedReason = reason?.trim() || "Stopped by user";
        t.activeTaskId = undefined;
        t.waiting = undefined;
        if (t.schedule) t.schedule.nextRunAt = null;
        removeSchedule(t);
        t.resumePrompt = undefined;
        t.resumeAttachmentIds = undefined;
        t.wakePending = undefined;
        t.cleanupPending = true;
        t.updatedAt = Date.now();
        const projects = await tx.doc(KuloProjectsDoc);
        projects.cancellations ??= {};
        projects.cancellations[ticketId] = { ...(t.projectId ? { projectId: t.projectId } : {}), reason: t.stoppedReason, requestedAt: t.updatedAt };
        await writeDeliveryReceipt(tx, intent, { ticketId }, "admitted", { epoch: t.runEpoch,
          ...(ticket.activeTaskId === undefined ? {} : { taskId: ticket.activeTaskId }), previousEpoch: ticket.runEpoch });
        return t.runEpoch;
      }, context);
    }
    this.connectionManager.cancelRequests(ticketId);
    // Stop unfinished descendants top-down through each child's ticket queue (parent -> child DAG cannot deadlock).
    const childStops = await Promise.allSettled(Object.values(snapshot?.tickets ?? {})
      .filter(child => child.parentTicketId === ticketId && (isTicketUnfinished(child) || child.cleanupPending))
      .map(child => this.#queueTicketOperation(child.id, () => this.#stopTicket(child.id, reason ?? "父任务已停止", context, undefined, undefined))));
    const childCleanupPending = childStops.some(result => result.status === "rejected" || result.value.cleanupPending);
    for (const result of childStops) if (result.status === "rejected") console.error(`[KuloChildCleanup:${ticketId}]`, result.reason);
    for (const job of await this.mediaJobs.list({ ticketId })) {
      if (!["completed", "failed", "stopped"].includes(job.status)) await this.mediaJobs.stop(job.id);
    }
    const conversations = [ticket.workerConversationId, ...Object.values(snapshot?.subagents ?? {}).filter((s) => s.ticketId === ticketId).map((s) => s.conversationId)];
    await Promise.all(conversations.map(async (id) => {
      const conversation = await this.harness.conversation(id as ConversationId, context);
      if (conversation) await conversation.abort(context, { background: true });
    }));
    const activeTaskId = prior?.phase === "admitted" ? prior.continuation.taskId : ticket.activeTaskId;
    if (typeof activeTaskId === "number") await this.harness.abortTask(activeTaskId as never, context);
    const stoppedSnapshot = (await this.harness.snapshot(KuloStateDoc, context))?.tickets[ticketId] ?? ticket;
    const cleanup = await this.#releaseTicketExecution(stoppedSnapshot);
    const card = await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[ticketId]!;
      if (t.runEpoch === epoch) {
        for (const sub of Object.values(state.subagents ?? {})) if (sub.ticketId === ticketId) sub.state = "stopped";
        t.cleanupPending = cleanup.cleanupPending || childCleanupPending;
        if (!t.cleanupPending) {
          if (t.workspaceStaging && !t.workspaceStaging.appliedAt && !t.workspaceStaging.discardedAt) {
            t.workspaceStaging.discardedAt = Date.now();
            delete t.workspaceStaging.stagedCwd;
            delete t.workspaceStaging.stagedDiff;
          }
          if (t.externalExecution && !t.externalExecution.stagedAppliedAt) {
            delete t.externalExecution.stagedCwd;
            delete t.externalExecution.stagedDiff;
          }
        }
        releaseSlot(state, ticketId);
        const projects = await tx.doc(KuloProjectsDoc);
        delete projects.cancellations?.[ticketId];
      }
      await writeDeliveryReceipt(tx, intent, { ticketId });
      return toTicketCardView(t, this.#liveSettings.roles);
    }, context);
    this.#untrackWorker(ticketId, prior?.phase === "admitted" ? Number(prior.continuation.previousEpoch) : ticket.runEpoch);
    if (!card.cleanupPending && !this.#recovering) this.harness.resume();
    await this.#broadcastTickets(context);
    return card;
  }

  async #runSubagents(req: RunSubagentsRequest, context: Context = BACKGROUND_CONTEXT): Promise<SubagentTaskOutcome[]> {
    const key = req.callerConversationId;
    const previous = this.#subagentBatches.get(key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous ? previous.then(() => gate) : gate;
    this.#subagentBatches.set(key, tail);
    if (previous) await previous;
    try { return await this.#runSubagentBatch(req, context); }
    finally { release(); if (this.#subagentBatches.get(key) === tail) this.#subagentBatches.delete(key); }
  }

  async #runSubagentBatch(
    req: RunSubagentsRequest,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<SubagentTaskOutcome[]> {
    const snap = await this.harness.snapshot(KuloStateDoc, context);
    const callerKey = String(req.callerConversationId);
    if (snap?.conversationToSubagent?.[callerKey]) {
      throw new Error("Forbidden: Subagents cannot spawn nested subagents (max depth = 1).");
    }

    const ticketId = snap?.conversationToTicket[callerKey];
    const ticket = ticketId ? snap?.tickets[ticketId] : undefined;
    if (!ticket) {
      throw new Error(
        "kulo_subagent can only be called inside an active Worker Ticket conversation.",
      );
    }
    if (ticket.status !== "running") throw new ProjectError(409, "worker_not_running", "所属工单尚未取得执行资格。");

    const activeRoles = this.#liveSettings.roles;
    const parentPreset = resolveRolePresetFromPool(activeRoles, ticket.role).preset;
    if (!parentPreset?.allowSubagents) {
      throw new Error(
        `Role '${ticket.role}' is not authorized to spawn subagents (allowSubagents=false).`,
      );
    }

    const maxBatch = Math.max(
      1,
      Math.min(8, this.#liveSettings.executor.maxSubagentsPerTicket ?? 4),
    );
    if (req.tasks.length > maxBatch) {
      throw new Error(
        `Subagent batch size (${req.tasks.length}) exceeds maxSubagentsPerTicket (${maxBatch}). Split into batches of at most ${maxBatch}.`,
      );
    }

    const existingForTicket = Object.values(snap?.subagents ?? {}).filter(
      (s) => s.ticketId === ticket.id,
    );
    const totalUsedRuns = existingForTicket.reduce((sum, s) => sum + s.runs, 0);
    const maxTotalRuns = Math.max(16, maxBatch * 4);
    const newRuns = req.tasks.filter((_, index) => !req.invocationId || !existingForTicket.some((sub) => sub.invocationId === `${req.invocationId}:${index}`)).length;
    if (totalUsedRuns + newRuns > maxTotalRuns) {
      throw new Error(
        `Ticket '${ticket.id}' reached its subagent invocation limit (${maxTotalRuns} runs). Please synthesize existing findings and report.`,
      );
    }

    interface PreparedSubagentJob {
      record: SubagentRecord;
      conv: Conversation;
      reused: boolean;
      runNumber: number;
      promptText: string;
    }

    const jobs: PreparedSubagentJob[] = [];
    const seenTargetsInBatch = new Set<string>();
    let nextSeq = existingForTicket.length + 1;

    for (const [taskIndex, taskReq] of req.tasks.entries()) {
      const invocationId = req.invocationId ? `${req.invocationId}:${taskIndex}` : undefined;
      if (!taskReq.goal) {
        throw new Error("Each subagent task must include a non-empty `goal`.");
      }

      const matchedExisting = existingForTicket.find(
        (s) =>
          (invocationId && s.invocationId === invocationId) ||
          (taskReq.agentId && s.id === taskReq.agentId) ||
          (!taskReq.agentId &&
            taskReq.name &&
            s.name.toLowerCase() === taskReq.name.toLowerCase()),
      );

      if (matchedExisting) {
        if (seenTargetsInBatch.has(matchedExisting.id)) {
          throw new Error(
            `Cannot invoke the same teammate '${matchedExisting.name}' (${matchedExisting.id}) twice in one parallel batch. Combine the instructions or invoke sequentially.`,
          );
        }
        seenTargetsInBatch.add(matchedExisting.id);

        const conv = await this.harness.conversation(
          matchedExisting.conversationId as ConversationId,
          context,
        );
        if (!conv) {
          throw new Error(
            `Subagent conversation for '${matchedExisting.id}' was not found.`,
          );
        }

        const updatedRecord = await this.harness.commit(async (tx) => {
          const state = await tx.doc(KuloStateDoc);
          if (state.tickets[ticket.id]?.status !== "running" || state.tickets[ticket.id]?.runEpoch !== ticket.runEpoch) {
            throw new ProjectError(409, "worker_not_running", "所属工单尚未取得执行资格。");
          }
          state.subagents ??= {};
          const cur = state.subagents[matchedExisting.id];
          if (!cur) {
            throw new Error(`Subagent '${matchedExisting.id}' missing in state.`);
          }
          if (!invocationId || cur.invocationId !== invocationId) cur.runs += 1;
          cur.invocationId = invocationId;
          if (taskReq.scope?.trim()) cur.narrowedScope = taskReq.scope.trim();
          cur.state = "queued";
          cur.updatedAt = Date.now();
          return cloneJson(cur);
        }, context);

        await this.#syncSingleSubagentConversation(conv, ticket, updatedRecord, context);

        const promptParts = [
          `[Parent Worker Follow-Up — Round ${updatedRecord.runs}]`,
          taskReq.goal,
          ...(taskReq.scope ? ["", `[Updated Narrowed Scope]\n${taskReq.scope}`] : []),
        ];

        jobs.push({
          record: updatedRecord,
          conv,
          reused: true,
          runNumber: updatedRecord.runs,
          promptText: promptParts.join("\n"),
        });
        continue;
      }

      if (taskReq.agentId) {
        throw new Error(
          `Subagent '${taskReq.agentId}' does not exist on ticket '${ticket.id}'. Omit agent_id to create a new subagent.`,
        );
      }

      const { roleId, preset: subPreset } = resolveRolePresetFromPool(
        activeRoles,
        taskReq.role,
        "scout",
      );
      if (subPreset && subPreset.enabled === false) {
        throw new Error(
          `子智能体角色 '${subPreset.label} (${roleId})' 当前已被停用，请改选其他启用中的角色。`,
        );
      }
      if (subPreset?.external) throw new Error("外部 Agent 通过 Hub 独立工单执行，请把协作需求交回主 Agent 使用 kulo_dispatch。");

      const seq = nextSeq++;
      const subagentId = `${ticket.id}:S-${String(seq).padStart(2, "0")}`;
      const subagentName = taskReq.name || `${roleId}-${seq}`;
      if (seenTargetsInBatch.has(`name:${subagentName.toLowerCase()}`)) {
        throw new Error(
          `Duplicate teammate name '${subagentName}' in the same parallel batch. Use distinct names.`,
        );
      }
      seenTargetsInBatch.add(`name:${subagentName.toLowerCase()}`);

      const effectiveReadOnly = Boolean(ticket.readOnly || subPreset?.readOnly);
      const subProviderOpt =
        subPreset?.provider?.trim() || this.#liveSettings.model.defaultProvider;
      const subModelId =
        subPreset?.modelId?.trim() || this.#liveSettings.model.defaultModel;
      const desiredThinking: ThinkingEffort =
        subPreset?.thinkingLevel === "auto"
          ? taskReq.thinkingLevel ?? this.#liveSettings.model.thinkingLevel
          : subPreset?.thinkingLevel ??
            taskReq.thinkingLevel ??
            this.#liveSettings.model.thinkingLevel;

      const subAgent = resolveAgentModelAndThinking(
        this.#models,
        this.#providerId,
        subProviderOpt,
        subModelId,
        desiredThinking,
        this.#liveSettings.model,
      );

      const effectiveWorkspaceDir = getEffectiveWorkspaceDir(ticket);
      const subConv = await this.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: subAgent.model,
            thinkingLevel: subAgent.thinkingLevel,
            ...this.#workerTools({
              executionDomain: ticket.executionDomain,
              androidTargetIds: this.#androidTargets(ticket),
              allowSubagents: false,
              isSubagent: true,
              readOnly: effectiveReadOnly,
            }),
            ...(ticket.executionDomain !== "android" ? { cwd: effectiveWorkspaceDir } : {}),
            maxTurns: 25,
          },
        },
        context,
      );

      const now = Date.now();
      const record: SubagentRecord = {
        id: subagentId,
        state: "queued",
        ...(invocationId ? { invocationId } : {}),
        name: subagentName,
        role: roleId,
        roleLabel: subPreset?.label ?? roleId,
        ...(taskReq.scope?.trim() ? { narrowedScope: taskReq.scope.trim() } : {}),
        ticketId: ticket.id,
        parentConversationId: req.callerConversationId,
        conversationId: subConv.id as number,
        readOnly: effectiveReadOnly,
        runs: 1,
        createdAt: now,
        updatedAt: now,
      };

      await this.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        if (state.tickets[ticket.id]?.status !== "running" || state.tickets[ticket.id]?.runEpoch !== ticket.runEpoch) {
          throw new ProjectError(409, "worker_not_running", "所属工单尚未取得执行资格。");
        }
        state.subagents ??= {};
        state.conversationToSubagent ??= {};
        state.subagents[record.id] = record;
        state.conversationToSubagent[String(subConv.id)] = record.id;
      }, context);

      const promptParts = [
        `Execute sub-task (${subagentName}):`,
        "",
        `[Sub-task Goal]\n${taskReq.goal}`,
        ...(taskReq.scope ? ["", `[Narrowed Scope]\n${taskReq.scope}`] : []),
        "",
        "Return concise findings, exact file/line references, and real command verification results directly in your response.",
      ];

      jobs.push({
        record,
        conv: subConv,
        reused: false,
        runNumber: 1,
        promptText: promptParts.join("\n"),
      });
    }

    // Scratch setup uses the same OS-isolated daemon as subagent tools.
    if (ticket.executionDomain !== "android" && ticket.scratchDir) {
        const activeStagedCwd = getActiveStagedCwd(ticket);
        const execEnv = this.envManager.createWorkerExecutionEnv(
          ticket.envId,
          activeStagedCwd ?? ticket.workspaceDir,
          {
            scratchDir: ticket.scratchDir,
            projectId: ticket.projectId,
            grantRevision: ticket.grantRevision,
            readOnly: ticket.readOnly,
            ...(activeStagedCwd && !ticket.externalExecution ? { stagedTaskId: ticket.id } : {}),
          },
        );
        const result = await execEnv.createDir(ticket.scratchDir, { recursive: true }, context);
        if (!result.ok) throw new Error(result.error.message);
    }

    const touchParentActivity = () => {
      const tracked = this.#trackedWorkers.get(ticket.id);
      if (tracked) {
        tracked.lastActivityAt = Date.now();
      }
    };

    const onParentAbort = () => {
      if (this.#closed) return;
      for (const job of jobs) {
        void job.conv.abort(BACKGROUND_CONTEXT, { background: true }).catch((error) => {
          console.error(`[KuloSubagent:abort:${job.record.id}]`, error);
        });
      }
    };
    context.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      touchParentActivity();
      const runJob = async (job: PreparedSubagentJob): Promise<SubagentTaskOutcome> => {
          req.onProgress?.(
            `[子智能体启动] ${job.record.name} (${job.record.roleLabel}/${job.record.role}${job.reused ? " · 续接" : ""})`,
          );
          try {
            await this.harness.commit(async (tx) => {
              const state = await tx.doc(KuloStateDoc);
              const parent = state.tickets[ticket.id];
              const subagent = state.subagents?.[job.record.id];
              if (!parent || parent.status !== "running" || parent.runEpoch !== ticket.runEpoch || !state.slots.holders.includes(ticket.id)) {
                throw new ProjectError(409, "worker_not_running", "所属工单尚未取得执行资格。");
              }
              if (subagent) subagent.state = "running";
            }, context);
            const sub = await job.conv.submit(
              {
                type: "input",
                content: job.promptText,
                requestId: `kulo:subagent:${job.record.id}:${job.runNumber}`,
              },
              context,
            );
            const settled = await sub.wait(context);
            await job.conv.waitForIdle(context);
            touchParentActivity();

            let summary = "";
            let status: "done" | "error" = "done";

            if (settled.status === "unanswered") {
              status = "error";
              const detailStr =
                settled.detail === undefined
                  ? ""
                  : typeof settled.detail === "string"
                    ? `: ${settled.detail}`
                    : `: ${JSON.stringify(settled.detail)}`;
              summary = `子智能体未完成（${settled.reason}${detailStr}）`;
            } else {
              const page = await job.conv.entries({}, 12, undefined, context);
              for (const entry of page.items) {
                if (AssistantEntry.is(entry)) {
                  const msg = entry.model?.[0];
                  if (msg && msg.role === "assistant") {
                    const texts = msg.content
                      .filter(
                        (b): b is { type: "text"; text: string } => b.type === "text",
                      )
                      .map((b) => b.text.trim())
                      .filter(Boolean);
                    if (texts.length > 0) {
                      summary = texts.join("\n");
                      break;
                    }
                  }
                }
              }
              if (!summary) {
                summary = "（子智能体已执行完毕，未输出文本正文）";
              }
            }

            await this.harness.commit(async (tx) => {
              const state = await tx.doc(KuloStateDoc);
              const cur = state.subagents?.[job.record.id];
              if (cur && state.tickets[ticket.id]?.runEpoch === ticket.runEpoch) {
                cur.state = status === "done" ? "ready" : "failed";
                cur.lastSummary = summary.slice(0, 1000);
                cur.updatedAt = Date.now();
              }
            }, context);

            req.onProgress?.(
              `[子智能体${status === "done" ? "完成" : "异常"}] ${job.record.name}`,
            );

            return {
              agentId: job.record.id,
              name: job.record.name,
              role: job.record.role,
              roleLabel: job.record.roleLabel,
              readOnly: job.record.readOnly,
              reused: job.reused,
              status,
              summary,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.harness.commit(async (tx) => {
              const state = await tx.doc(KuloStateDoc);
              const subagent = state.subagents?.[job.record.id];
              if (subagent && state.tickets[ticket.id]?.runEpoch === ticket.runEpoch) { subagent.state = "failed"; subagent.lastSummary = msg.slice(0, 1000); }
            }, BACKGROUND_CONTEXT);
            req.onProgress?.(`[子智能体异常] ${job.record.name}: ${msg}`);
            return {
              agentId: job.record.id,
              name: job.record.name,
              role: job.record.role,
              roleLabel: job.record.roleLabel,
              readOnly: job.record.readOnly,
              reused: job.reused,
              status: "error",
              summary: `执行异常：${msg}`,
            };
          }
      };
      // Natural-language scopes cannot establish disjoint file ownership.
      let writes: Promise<unknown> = Promise.resolve();
      const outcomes = await Promise.all(jobs.map((job) => {
        if (job.record.readOnly) return runJob(job);
        const outcome = writes.then(() => runJob(job));
        writes = outcome.then(() => undefined, () => undefined);
        return outcome;
      }));

      return outcomes;
    } finally {
      context.abortSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  async closeTicket(
    params: CloseTicketParams,
    context: Context = BACKGROUND_CONTEXT,
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    const intent = suppliedIntent ?? clientDeliveryIntent({ type: "ticket.close", ticketId: params.ticketId, commandId: params.commandId,
      kind: params.kind, reason: params.reason, replacementTicketId: params.replacementTicketId });
    return this.#withDelivery(intent, context, () => this.#queueTicketOperation(params.ticketId, () => this.#closeTicket(params, context, intent)), (receipt) => this.#receiptTicket(receipt, context));
  }

  async #closeTicket(params: CloseTicketParams, context: Context, intent?: DeliveryIntent): Promise<TicketCardView> {
    const recoveryGuard = await this.#currentRecoveryGuard(params.originConversationId, context, params.originToolTaskId);
    const activeRoles = this.#liveSettings.roles;
    const cleanCmdId = params.commandId?.trim();
    let changed = false;
    let stagedToDiscard: TicketRecord | undefined;
    const card = await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[params.ticketId];
      if (!t) throw new Error(`Ticket '${params.ticketId}' not found`);
      if (cleanCmdId && state.processedCommands?.[cleanCmdId]) {
        legacyDeliveryConflict();
      }
      assertRecoveryGuard(state, recoveryGuard);
      if (recoveryGuard && params.kind !== "superseded") throw new Error("未解决的失败不能在自动恢复中忽略。");
      if (t.status === "closed" && params.originConversationId === undefined) {
        await writeDeliveryReceipt(tx, intent, { ticketId: params.ticketId });
        return toTicketCardView(t, activeRoles);
      }
      if (isTicketUnfinished(t)) {
        throw new Error(
          `Ticket '${params.ticketId}' is still ${t.status}; stop it or wait until settled before closing.`,
        );
      }
      if (t.status === "stopped" && params.originConversationId !== undefined) {
        throw new Error(
          `Ticket '${params.ticketId}' is human-stopped; cannot overwrite as closed.`,
        );
      }
      if (params.kind === "superseded" && !params.replacementTicketId) {
        throw new Error("replacementTicketId is required when kind='superseded'");
      }
      if (params.kind === "superseded") {
        const replacement = state.tickets[params.replacementTicketId!];
        if (!replacement || replacement.status !== "ready" || !sameRecoveryScope(t, replacement) ||
            !replacement.supersedes?.includes(t.id)) throw new Error("替代任务尚未成功完成。");
      }

      changed = true;
      recordProcessedCommand(state, cleanCmdId, params.ticketId, "close");
      await writeDeliveryReceipt(tx, intent, { ticketId: params.ticketId });
      const now = Date.now();
      if (!t.cleanupPending && (getActiveStagedCwd(t) || hasPendingWorkspaceApply(t))) {
        stagedToDiscard = cloneJson(t);
        if (t.workspaceStaging && !t.workspaceStaging.appliedAt) {
          t.workspaceStaging.discardedAt = now;
          delete t.workspaceStaging.stagedCwd;
          delete t.workspaceStaging.stagedDiff;
        }
        if (t.externalExecution && !t.externalExecution.stagedAppliedAt) {
          delete t.externalExecution.stagedCwd;
          delete t.externalExecution.stagedDiff;
        }
      }
      transitionTicketStatus(t, "closed", now);
      if (t.schedule) t.schedule.nextRunAt = null;
      releaseProjectWrite(state, t.id, { force: !t.cleanupPending });
      const prior = t.recovery;
      t.recovery = undefined;
      if (prior && (prior.rootTicketId ?? t.id) === t.id) {
        for (const related of Object.values(state.tickets)) {
          if (related.recovery?.rootTicketId === t.id && related.recovery.startedAt === prior.startedAt) {
            related.recovery = undefined;
            related.autoRecoverySuppressed = true;
          }
        }
      }
      t.closure = {
        kind: params.kind,
        reason: params.reason.trim(),
        ...(params.replacementTicketId
          ? { replacementTicketId: params.replacementTicketId }
          : {}),
        at: now,
      };
      t.updatedAt = now;
      return toTicketCardView(t, activeRoles);
    }, context);

    if (stagedToDiscard) {
      await this.#discardTicketStagedWorkspace(stagedToDiscard);
      if (!this.#recovering) this.harness.resume();
    }
    if (changed) {
      await this.#broadcastTickets(context);
    }
    return card;
  }

  async listScheduledTasks(context: Context = BACKGROUND_CONTEXT): Promise<TicketCardView[]> {
    const { tickets } = await this.getBoardSnapshot(context);
    return tickets.filter(ticket => ticket.schedule && ticket.schedule.deletedAt === undefined);
  }

  async stopScheduledTask(ticketId: string, context: Context = BACKGROUND_CONTEXT, intent?: DeliveryIntent): Promise<TicketCardView> {
    return this.#withDelivery(intent, context, (receipt) => this.#queueTicketOperation(ticketId, async () => {
      const state = await this.harness.snapshot(KuloStateDoc, context);
      const ticket = state?.tickets[ticketId];
      if (!ticket?.schedule || ticket.schedule.deletedAt !== undefined && receipt?.phase !== "admitted") throw new ProjectError(404, "schedule_not_found", "定时任务不存在。");
      if (ticket.status === "closed" || ticket.status === "stopped" && !ticket.cleanupPending) {
        await this.harness.commit((tx) => writeDeliveryReceipt(tx, intent, { ticketId }), context);
        return toTicketCardView(ticket, this.#liveSettings.roles);
      }
      return this.#stopTicket(ticketId, "用户停止定时任务", context, undefined, undefined, intent, receipt);
    }), (receipt) => this.#receiptTicket(receipt, context));
  }

  async deleteScheduledTask(ticketId: string, context: Context = BACKGROUND_CONTEXT, intent?: DeliveryIntent): Promise<void> {
    return this.#withDelivery(intent, context, (receipt) => this.#queueTicketOperation(ticketId, async () => {
      const state = await this.harness.snapshot(KuloStateDoc, context);
      const ticket = state?.tickets[ticketId];
      if (!ticket?.schedule) throw new ProjectError(404, "schedule_not_found", "定时任务不存在。");
      if (ticket.schedule.deletedAt !== undefined && receipt?.phase !== "admitted") {
        await this.harness.commit((tx) => writeDeliveryReceipt(tx, intent, { ticketId }), context);
        return;
      }
      await this.#stopTicket(ticketId, "用户停止定时任务", context, undefined, undefined, intent, receipt, true);
      await this.#broadcastTickets(context);
    }), async () => {});
  }

  getCurrentTicketBoard() {
    if (this.#closed) throw new Error("Hub is closed");
    this.#refreshTicketState();
    return this.#ticketBoard.snapshot();
  }

  async getBoardSnapshot(context: Context = BACKGROUND_CONTEXT) {
    context.abortSignal?.throwIfAborted();
    return { ...this.getCurrentTicketBoard(), envs: this.envManager.listEnvs() };
  }

  async getFullClientSnapshot(
    topicId = "root",
    context: Context = BACKGROUND_CONTEXT,
  ) {
    const [board, topics, topicView, projects, assistantDoc] = await Promise.all([
      this.getBoardSnapshot(context),
      this.listTopics(context),
      this.getTopicView(topicId, context),
      this.projects.list(context),
      this.harness.snapshot(AssistantDoc, context),
    ]);
    return {
      activeTopicId: topicView.topicId,
      topics,
      messages: topicView.messages,
      topicActivities: Object.fromEntries(this.#topicWatchesList().filter((cache) => topics.some((topic) => topic.id === cache.topicId))
        .map((cache) => [cache.topicId, topicActivity(cache.messages, cache.live)])),
      historyBefore: topicView.historyBefore,
      live: topicView.live,
      ...board,
      assistantItems: assistantDoc?.items ? cloneJson(assistantDoc.items) : [],
      assistantRevision: assistantDoc?.assistantRevision ?? 1,
      projects,
      expression: this.getActiveExpression(),
      settings: this.getSettingsView(),
    };
  }

  async getAssistantWorkspace(context: Context = BACKGROUND_CONTEXT): Promise<AssistantWorkspaceSnapshot> {
    const [snap, backgroundModel, digestCount24h, spark, homeAssistant, lark] = await Promise.all([
      this.harness.snapshot(AssistantDoc, context),
      this.ambientModel.status(),
      this.assistantLedger.countDigestsSince(Date.now() - 24 * 3_600_000),
      this.sparkMail.status().catch(() => ({ enabled: false, available: false })),
      this.homeAssistant.status().catch(() => ({ enabled: false, connected: false, hasToken: false })),
      this.larkConnector.status().catch(() => ({ enabled: false, cliAvailable: false, profiles: [], selectedProfiles: [] })),
    ]);
    return {
      revision: snap?.revision ?? 1,
      enabled: Boolean(snap?.enabled),
      sources: this.envManager.getConnectorStatuses(),
      mutedApps: snap?.mutedApps ? [...snap.mutedApps] : [],
      backgroundModel,
      advice: this.ambientModel.advise(),
      digestCount24h,
      spark,
      homeAssistant,
      lark,
    };
  }

  async getAssistantItemsSnapshot(context: Context = BACKGROUND_CONTEXT): Promise<{
    assistantRevision: number;
    items: AssistantItemView[];
  }> {
    const snap = await this.harness.snapshot(AssistantDoc, context);
    return {
      assistantRevision: snap?.assistantRevision ?? 1,
      items: snap?.items ? cloneJson(snap.items) : [],
    };
  }

  async configureAssistantSpark(
    input: { enabled: boolean },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<import("@kulo/protocol").SparkConnectorSnapshot> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AssistantDoc);
      ensureAssistantState(doc);
      doc.spark = { enabled: Boolean(input.enabled) };
      doc.revision += 1;
    }, context);
    this.sparkMail.invalidateCache();
    await this.#refreshAssistantActiveFlag(context);
    return this.sparkMail.status({ force: true });
  }

  setLanHttpEndpoint(provider: (() => { lanReachable: boolean; port: number } | undefined) | undefined): void {
    this.#lanHttpEndpointProvider = provider;
  }

  async configureAssistantHomeAssistant(
    input: {
      enabled?: boolean;
      baseUrl?: string;
      token?: string;
      clearToken?: boolean;
      sentinel?: Partial<import("@kulo/protocol").HomeAssistantSentinelConfig>;
      announce?: Partial<import("@kulo/protocol").HomeAssistantAnnounceConfig>;
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<import("@kulo/protocol").HomeAssistantSnapshot> {
    const snap = await this.homeAssistant.configure(input);
    await this.#refreshAssistantActiveFlag(context);
    return snap;
  }

  async configureAssistantLark(
    input: { enabled?: boolean; selectedProfiles?: string[] },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<import("@kulo/protocol").LarkConnectorSnapshot> {
    const snap = await this.larkConnector.configure(input);
    await this.#refreshAssistantActiveFlag(context);
    return snap;
  }

  async #refreshAssistantActiveFlag(context: Context): Promise<void> {
    const snap = await this.harness.snapshot(AssistantDoc, context);
    const active = Boolean(
      snap?.enabled ||
        snap?.spark?.enabled ||
        snap?.homeAssistant?.enabled ||
        snap?.lark?.enabled ||
        (await this.assistantLedger.hasAnyRecords()),
    );
    if (active !== this.#assistantActive) {
      this.#assistantActive = active;
      await this.#reconfigureOrchestratorConversations(context);
    }
  }

  async #ingestInternalAssistantEvents(
    driverId: "home-assistant" | "lark-cli",
    events: import("@kulo/protocol").RawConnectorEvent[],
    streamSuffix: string = driverId,
  ): Promise<void> {
    if (events.length === 0) return;
    const redact = (text: string): string => this.connectionManager.redact(redactSensitiveText(text));
    const batch: ConnectorEventBatch = {
      batchId: `${driverId}-${Date.now()}`,
      driverId,
      streamId: `${this.#androidHubId ?? "kulo-hub"}:local:${streamSuffix}`,
      sourceEpoch: "v1",
      cursorAfter: String(Date.now()),
      events,
    };
    const { inserted } = await this.assistantLedger.ingestBatch(this.envManager.localEnvId, batch, redact);
    if (inserted.length > 0) {
      this.assistantSorter.enqueue(inserted);
      await this.#refreshAssistantActiveFlag(BACKGROUND_CONTEXT);
    }
  }

  async configureAssistantNotifications(
    input: { enabled?: boolean; muteApp?: string; unmuteApp?: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<AssistantWorkspaceSnapshot> {
    const nextState = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AssistantDoc);
      ensureAssistantState(doc);
      if (typeof input.enabled === "boolean") doc.enabled = input.enabled;
      const mute = input.muteApp?.trim();
      if (mute && mute.length <= 255 && !doc.mutedApps.includes(mute)) {
        doc.mutedApps = [...doc.mutedApps, mute].slice(0, 256);
        doc.items = doc.items.filter((item) => item.sourceApp !== mute);
        doc.assistantRevision += 1;
      }
      const unmute = input.unmuteApp?.trim();
      if (unmute) {
        doc.mutedApps = doc.mutedApps.filter((app) => app !== unmute);
      }
      doc.revision += 1;
      return {
        enabled: doc.enabled,
        mutedApps: [...doc.mutedApps],
        assistantRevision: doc.assistantRevision,
        items: cloneJson(doc.items),
      };
    }, context);

    this.envManager.setConnectorConfig({
      driverId: "macos-notifications",
      enabled: nextState.enabled,
      mutedApps: nextState.mutedApps,
    });
    this.#emitAssistantItems(nextState.assistantRevision, nextState.items);

    const becameActive = nextState.enabled || (await this.assistantLedger.hasAnyRecords());
    if (becameActive !== this.#assistantActive) {
      this.#assistantActive = becameActive;
      await this.#reconfigureOrchestratorConversations(context);
    }
    return this.getAssistantWorkspace(context);
  }

  async configureAssistantBackgroundModel(
    input: {
      mode: "auto" | "local-managed" | "kulo-provider";
      engine?: AmbientLocalEngine;
      modelId?: string;
      providerId?: string;
      confirmed?: boolean;
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ requiresConfirmation?: boolean; proposal?: Record<string, unknown>; snapshot: AssistantWorkspaceSnapshot }> {
    if (input.mode === "local-managed") {
      const advice = this.ambientModel.advise();
      const engine = input.engine ?? advice.recommendedEngine ?? "omlx";
      const modelId = input.modelId?.trim() || advice.recommendedModelId || "mlx-community/Qwen3-4B-Instruct-2507-4bit";
      if (!input.confirmed) {
        return {
          requiresConfirmation: true,
          proposal: {
            host: advice.hostName,
            engine,
            modelId,
            estimatedRamGb: advice.estimatedRamGb,
            reason: advice.reason,
          },
          snapshot: await this.getAssistantWorkspace(context),
        };
      }
      await this.ambientModel.deployLocalManaged({ engine, modelId });
      return { snapshot: await this.getAssistantWorkspace(context) };
    }
    await this.ambientModel.configureAutoOrProvider({
      mode: input.mode,
      providerId: input.providerId,
      modelId: input.modelId,
    });
    return { snapshot: await this.getAssistantWorkspace(context) };
  }

  async #ingestConnectorBatch(envId: string, batch: ConnectorEventBatch): Promise<ConnectorBatchAck> {
    const snap = await this.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT);
    if (!snap?.enabled) {
      return {
        batchId: batch.batchId,
        driverId: batch.driverId,
        streamId: batch.streamId,
        sourceEpoch: batch.sourceEpoch,
        cursorAfter: batch.cursorAfter,
        status: "rejected",
        code: "source_disabled",
      };
    }
    const muted = new Set(snap.mutedApps ?? []);
    const filteredBatch: ConnectorEventBatch = {
      ...batch,
      events: batch.events.filter((ev) => !muted.has(ev.appId)),
    };
    const redact = (value: string) => this.connectionManager.redact(redactSensitiveText(value));
    const { inserted } = await this.assistantLedger.ingestBatch(envId, filteredBatch, redact);
    if (inserted.length > 0) {
      if (!this.#assistantActive) {
        this.#assistantActive = true;
        void this.#reconfigureOrchestratorConversations(BACKGROUND_CONTEXT).catch(() => {});
      }
      this.assistantSorter.enqueue(inserted);
    }
    return {
      batchId: batch.batchId,
      driverId: batch.driverId,
      streamId: batch.streamId,
      sourceEpoch: batch.sourceEpoch,
      cursorAfter: batch.cursorAfter,
      status: "accepted",
    };
  }

  async #taskDeliverableOptions(ticketId: string, context: Context): Promise<TaskDeliverableOptions> {
    const snapshot = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[ticketId];
    if (!ticket) throw new TaskDeliverableError(404, "ticket_not_found", "任务不存在。");
    if (ticket.executionDomain === "android") throw new TaskDeliverableError(409, "task_deliverable_unavailable", "手机任务没有可读取的工作区文件。");
    if (!this.envManager.getEnvDescriptor(ticket.envId)?.online) throw new TaskDeliverableError(503, "task_deliverable_device_offline", "任务设备离线，连接后可查看交付文件。");
    const assertAuthorized = async () => {
      if (context.abortSignal?.aborted) throw new TaskDeliverableError(499, "task_deliverable_aborted", "文件读取已取消。");
      const state = await this.harness.snapshot(KuloStateDoc, context);
      const current = state?.tickets[ticketId];
      if (!current || current.workspaceDir !== ticket.workspaceDir || current.scratchDir !== ticket.scratchDir || current.envId !== ticket.envId || current.projectId !== ticket.projectId || current.grantRevision !== ticket.grantRevision) {
        throw new TaskDeliverableError(403, "task_deliverable_scope_changed", "任务文件授权已变化。");
      }
      const settings = await this.harness.snapshot(SettingsAssistantDoc, context);
      if (isSettingsTopicDeleted(current.originTopicId, settings) || state?.topics?.[current.originTopicId ?? "root"]?.deletedAt !== undefined) {
        throw new TaskDeliverableError(403, "task_deliverable_scope_changed", "任务所属会话已删除。");
      }
      if (current.projectId) {
        const project = await this.projects.get(current.projectId, context);
        if (project.grantRevision !== current.grantRevision || project.workspaceDir !== current.workspaceDir || project.deviceId !== current.envId || project.directoryId !== current.directoryId) {
          throw new TaskDeliverableError(403, "task_deliverable_scope_changed", "项目目录授权已变化，请重新关联。");
        }
      }
    };
    await assertAuthorized();
    if (ticket.projectId) await this.projects.ensureAuthorized(ticket.projectId, context);
    await assertAuthorized();
    const activeStagedCwd = getActiveStagedCwd(ticket);
    const effectiveWorkspaceDir = activeStagedCwd ?? ticket.workspaceDir;
    const env = this.envManager.createWorkerExecutionEnv(ticket.envId, effectiveWorkspaceDir, {
      scratchDir: ticket.scratchDir,
      projectId: ticket.projectId,
      grantRevision: ticket.grantRevision,
      readOnly: true,
      ...(activeStagedCwd && !ticket.externalExecution ? { stagedTaskId: ticket.id } : {}),
    });
    const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
    const roots = [effectiveWorkspaceDir, ticket.workspaceDir, ticket.scratchDir].filter((value): value is string => Boolean(value));
    const statePath = normalize(this.config.stateDir);
    const protectedPaths = [
      ...(!roots.some((root) => normalize(root).startsWith(`${statePath}/`)) ? [this.config.stateDir] : []),
      resolveEffectiveIdentityDir(this.#liveSettings, this.#defaultIdentityDir),
    ];
    return { env, ticket: { ...ticket, workspaceDir: effectiveWorkspaceDir }, protectedPaths, assertAuthorized, context };
  }

  async listTicketDeliverables(ticketId: string, context: Context = BACKGROUND_CONTEXT) {
    const snapshot = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[ticketId];
    if (!ticket) throw new TaskDeliverableError(404, "ticket_not_found", "任务不存在。");
    if (ticket.latestReport?.attachments?.length) {
      const files = [];
      const missing = [];
      const overflowId = ticket.latestReport.overflowAsset?.id;
      for (const attachment of ticket.latestReport.attachments) {
        if (overflowId && attachment.id === overflowId) continue;
        const loaded = this.uploads.getUpload(attachment.id);
        if (!loaded) { missing.push(attachment.name); continue; }
        if (loaded.record.internalOnly) continue;
        const published = this.uploads.toChatAttachment(loaded.record);
        files.push({ id: published.id, name: published.name, size: published.size, mimeType: published.mimeType,
          url: published.url, previewable: published.mimeType === "text/html" && /\.html?$/i.test(published.name) });
      }
      return { files, ...(missing.length ? { missing } : {}) };
    }
    if (!reportFileReferences(ticket.latestReport).length) return { files: [] };
    try { return await listTaskDeliverables(await this.#taskDeliverableOptions(ticketId, context)); }
    catch (error) { return taskDeliverableError(error); }
  }

  async readTicketDeliverable(ticketId: string, fileId: string, context: Context = BACKGROUND_CONTEXT) {
    try { return await readTaskDeliverable(await this.#taskDeliverableOptions(ticketId, context), fileId); }
    catch (error) { return taskDeliverableError(error); }
  }

  async inspectTicketDetail(
    ticketId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{
    ticket: TicketRecord;
    transcript: ChatDisplayItem[];
    live: LiveStreamState;
  }> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) {
      throw new Error(`Ticket '${ticketId}' not found`);
    }
    if (ticket.externalExecution) {
      const { run, error } = await this.#externalAgentRunView(ticket);
      const text = this.connectionManager.redact(run?.text || ticket.latestReport?.deliverable || ticket.latestReport?.summary || "");
      const transcript: ChatDisplayItem[] = [{ id: -1, role: "user", text: [ticket.goal, ticket.scope, ticket.acceptance].filter(Boolean).join("\n\n"), createdAt: ticket.createdAt }];
      const eventMap = new Map<number, import("@kulo/protocol").ExternalAgentRuntimeEvent>();
      for (const ev of ticket.externalExecution.recentEvents ?? []) eventMap.set(ev.sequence, ev);
      for (const ev of run?.events ?? []) {
        if (ev.type !== "message") eventMap.set(ev.sequence, ev);
      }
      const timeline = [...eventMap.values()].sort((a, b) => a.sequence - b.sequence).slice(-30);
      let nextSyntheticId = -10;
      for (const ev of timeline) {
        const prefix = ev.type === "tool" ? "[工具] " : ev.type === "error" ? "[错误] " : ev.type === "permission" ? "[授权] " : "";
        transcript.push({
          id: nextSyntheticId--,
          role: "system_note",
          text: `${prefix}${this.connectionManager.redact(ev.text).slice(0, 500)}`,
          createdAt: ev.at,
        });
      }
      if (text) transcript.push({ id: -2, role: "assistant", text, createdAt: ticket.latestReport?.at ?? ticket.updatedAt });
      const activePermissions = run?.permissions ?? ticket.externalExecution.pendingPermissions ?? [];
      for (const permission of activePermissions) {
        transcript.push({ id: nextSyntheticId--, role: "system_note", text: `[待授权] ${this.connectionManager.redact(permission.title)}` });
      }
      const isBusy = ticket.status === "running" && (!run || ["starting", "running", "waiting"].includes(run.state));
      const latestToolEvent = isBusy ? [...timeline].reverse().find((ev) => ev.type === "tool") : undefined;
      const activeTools: LiveStreamState["activeTools"] = [
        ...activePermissions.map((permission) => ({ callId: permission.id, name: this.connectionManager.redact(permission.title).slice(0, 120), outputTail: "等待授权" })),
        ...(latestToolEvent && activePermissions.length === 0
          ? [{ callId: `ext-tool-${latestToolEvent.sequence}`, name: this.connectionManager.redact(latestToolEvent.text).slice(0, 120) }]
          : []),
      ];
      return { ticket: cloneJson(ticket), transcript, live: {
        busy: isBusy,
        ...(isBusy && text ? { streamingText: text } : {}), activeTools, queuedCount: ticket.resumePrompt ? 1 : 0,
        ...(error ? { runFailure: { reason: "external_status_unavailable", detail: error } } : {}),
      } };
    }
    const workerConv = await this.harness.conversation(
      ticket.workerConversationId as ConversationId,
      context,
    );
    if (!workerConv) {
      return {
        ticket: { ...ticket },
        transcript: [],
        live: { busy: false, activeTools: [], queuedCount: 0 },
      };
    }
    const watch = await workerConv.watch(context, { min: 80, max: 160 });
    const view = watch.value;
    await watch.stop();
    return {
      ticket: { ...ticket },
      transcript: await this.#hydrateMessages(view.entries, Number(workerConv.id), {
        includeToolResults: true,
        redactToolText: (text) => this.connectionManager.redact(text),
      }),
      live: extractLiveState(view),
    };
  }

  /**
   * Lightweight worker diagnostic snapshot used by `kulo_inspect` (no `watch()`).
   */
  async #externalAgentRunView(
    ticket: Readonly<TicketRecord>,
    options?: { compact?: boolean },
  ): Promise<{ run?: ExternalAgentRun; error?: string }> {
    const execution = ticket.externalExecution;
    if (!execution?.runId) return {};
    if (!this.envManager.getEnvDescriptor(ticket.envId)?.online) return { error: "等待执行设备上线后核对原会话。" };
    try {
      const response = await this.envManager.requestExternalAgent(ticket.envId, {
        operation: "inspect",
        runId: execution.runId,
        ...(options?.compact ? { compact: true } : {}),
      });
      if (response.type !== "run" || response.run.taskId !== ticket.id || response.run.id !== execution.runId || response.run.kind !== execution.binding.kind) throw new Error("客户端返回了不匹配的执行回执。");
      return { run: redactCredentialData(response.run, (value) => this.connectionManager.redact(value)) };
    } catch (error) {
      return { error: this.connectionManager.redact(error instanceof Error ? error.message : "客户端状态暂时无法读取。") };
    }
  }

  async inspectWorker(
    ticketId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<WorkerInspectResult> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) {
      throw new Error(`Ticket '${ticketId}' not found`);
    }
    if (ticket.externalExecution) {
      const { run, error } = await this.#externalAgentRunView(ticket, { compact: true });
      const lastActivity = Math.max(
        run?.events.at(-1)?.at ?? 0,
        ticket.externalExecution.lastActivityAt ?? 0,
        ticket.latestReport?.at ?? 0,
        ticket.startedRunningAt ?? 0,
        ticket.updatedAt,
      );
      const phase = run?.phase ?? ticket.externalExecution.phase;
      const touchedFiles = run?.touchedFiles ?? ticket.externalExecution.touchedFiles;
      const uncertainReason = run?.uncertainReason ?? ticket.externalExecution.uncertainReason;
      const externalInspect: WorkerInspectResult = {
        ticketId: ticket.id,
        title: ticket.title,
        role: ticket.role,
        status: ticket.status,
        runEpoch: ticket.runEpoch,
        ...(phase ? { phase } : {}),
        ...(touchedFiles?.length ? { touchedFiles: [...touchedFiles] } : {}),
        ...(ticket.startedRunningAt === undefined ? {} : { startedRunningAt: ticket.startedRunningAt, runningDurationSec: Math.max(0, Math.round((Date.now() - ticket.startedRunningAt) / 1000)) }),
        idleSec: Math.max(0, Math.round((Date.now() - lastActivity) / 1000)),
        busy: ticket.status === "running" && (!run || ["starting", "running", "waiting"].includes(run.state)),
        ...(run?.text ? { streamingPreview: run.text.slice(-1200) } : {}),
        activeTools: (run?.permissions ?? ticket.externalExecution.pendingPermissions ?? []).map((permission) => ({ callId: permission.id, name: permission.title, status: "waiting" })),
        ...(error || run?.error ? { runFailure: { reason: "external_agent", detail: error ?? run!.error } } : {}),
        ...(ticket.latestReport ? { latestReport: cloneJson(ticket.latestReport) } : {}),
        external: {
          kind: ticket.externalExecution.binding.kind,
          runId: ticket.externalExecution.runId,
          sessionId: run?.sessionId ?? ticket.externalExecution.sessionId,
          ...(ticket.externalExecution.workspaceMode ? { workspaceMode: ticket.externalExecution.workspaceMode } : {}),
          ...((run?.stagedCwd ?? ticket.externalExecution.stagedCwd) ? { stagedCwd: run?.stagedCwd ?? ticket.externalExecution.stagedCwd } : {}),
          ...(uncertainReason ? { uncertainReason } : {}),
          permissions: run?.permissions ?? ticket.externalExecution.pendingPermissions ?? [],
        },
        recentEntries: (run?.events ?? []).slice(-15).map((event) => ({
          id: event.sequence,
          kind: event.type === "message" ? "assistant" : event.type === "tool" ? "tool_result" : "other",
          summary: (event.type === "message" ? event.text : `[${event.type}] ${event.text}`).slice(-1200),
          createdAt: event.at,
        })),
      };
      return boundInspectResult(externalInspect);
    }

    const workerConvId = ticket.workerConversationId as ConversationId;
    const [live, workerConv] = await Promise.all([
      this.harness.snapshot(LiveDoc, workerConvId, context),
      this.harness.conversation(workerConvId, context),
    ]);
    const entriesPage = workerConv
      ? await workerConv.entries({}, 10, undefined, context)
      : undefined;
    const recentEntries = entriesPage
      ? [...entriesPage.items].reverse().map(summarizeEntryForInspect)
      : [];

    let streamingPreview: string | undefined;
    let thinkingPreview: string | undefined;
    const partialContent = live?.generation?.message?.content;
    if (Array.isArray(partialContent)) {
      const texts: string[] = [];
      const thoughts: string[] = [];
      for (const block of partialContent) {
        if (!block || typeof block !== "object") continue;
        if ("type" in block && block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          "type" in block &&
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          thoughts.push(block.thinking);
        }
      }
      const joinedText = texts.join("").trim();
      const joinedThinking = thoughts.join("").trim();
      if (joinedText) {
        streamingPreview =
          joinedText.length > 300 ? `...${joinedText.slice(-300)}` : joinedText;
      }
      if (joinedThinking) {
        thinkingPreview =
          joinedThinking.length > 200 ? `...${joinedThinking.slice(-200)}` : joinedThinking;
      }
    }

    const now = Date.now();
    const tracked = this.#trackedWorkers.get(ticketId);
    const runningDurationSec =
      ticket.status === "running" && ticket.startedRunningAt
        ? Math.max(0, Math.round((now - ticket.startedRunningAt) / 1000))
        : undefined;
    const lastActivityAt = Math.max(
      tracked?.lastActivityAt ?? 0,
      ticket.startedRunningAt ?? 0,
      ticket.latestReport?.at ?? 0,
    );
    const idleSec =
      ticket.status === "running" && lastActivityAt > 0
        ? Math.max(0, Math.round((now - lastActivityAt) / 1000))
        : undefined;

    const activeTools = (live?.tools ?? [])
      .filter((t) => t.status !== "done")
      .map((t) => ({
        callId: t.callId,
        name: t.name,
        status: t.status,
        ...(t.output ? { outputTail: t.output.slice(-300) } : {}),
      }));

    const builtInProjection = inferBuiltInWorkerPhaseAndFiles({
      activeTools,
      recentEntries,
      streamingPreview,
      workspaceDir: getEffectiveWorkspaceDir(ticket),
    });

    return boundInspectResult({
      ticketId: ticket.id,
      title: ticket.title,
      role: ticket.role,
      status: ticket.status,
      runEpoch: ticket.runEpoch,
      phase: builtInProjection.phase,
      ...(builtInProjection.touchedFiles?.length ? { touchedFiles: builtInProjection.touchedFiles } : {}),
      ...(ticket.startedRunningAt !== undefined
        ? { startedRunningAt: ticket.startedRunningAt }
        : {}),
      ...(runningDurationSec !== undefined ? { runningDurationSec } : {}),
      ...(idleSec !== undefined ? { idleSec } : {}),
      busy: Boolean(live?.run),
      ...(live?.run?.turns !== undefined ? { turns: live.run.turns } : {}),
      ...(streamingPreview ? { streamingPreview } : {}),
      ...(thinkingPreview ? { thinkingPreview } : {}),
      activeTools,
      ...(live?.runFailure
        ? {
            runFailure: {
              reason: live.runFailure.reason,
              ...(live.runFailure.detail !== undefined
                ? { detail: String(live.runFailure.detail) }
                : {}),
            },
          }
        : {}),
      ...(ticket.latestReport ? { latestReport: { ...ticket.latestReport } } : {}),
      recentEntries,
    });
  }

  async listProviders(): Promise<ProviderCatalogItem[]> {
    if (this.#providerManager) {
      return this.#providerManager.listCatalog();
    }
    const customById = new Map(
      (this.#liveSettings.model.customProviders ?? []).map((c) => [c.id, c]),
    );
    const items: ProviderCatalogItem[] = [];
    for (const p of this.#models.getProviders()) {
      const custom = customById.get(p.id);
      items.push(
        serializeProviderCatalogItem(p, this.#models, {
          builtin: !custom,
          ...(custom ? { api: custom.api } : {}),
          authenticated: true,
        }),
      );
    }
    return items;
  }

  async setProviderApiKey(providerId: string, apiKey: string): Promise<ProviderCatalogItem> {
    if (!this.#providerManager) {
      throw new Error("Current Models instance does not manage provider credentials");
    }
    const item = await this.#providerManager.setApiKey(providerId, apiKey);
    await this.#syncProviderVoiceModels();
    void this.#broadcastCapabilities().catch(() => {});
    void this.#broadcastVoice().catch(() => {});
    return item;
  }

  async logoutProvider(providerId: string): Promise<ProviderCatalogItem | null> {
    if (!this.#providerManager) {
      throw new Error("Current Models instance does not manage provider credentials");
    }
    const item = await this.#providerManager.logout(providerId);
    await this.#syncProviderVoiceModels();
    void this.#broadcastCapabilities().catch(() => {});
    void this.#broadcastVoice().catch(() => {});
    return item;
  }

  async refreshProviderModels(providerId: string): Promise<ProviderCatalogItem> {
    if (!this.#providerManager) {
      throw new Error("Current Models instance does not manage provider credentials");
    }
    return this.#providerManager.refreshProvider(providerId);
  }

  async discoverProviderModels(
    req: DiscoverModelsRequest,
  ): Promise<DiscoverModelsResponse> {
    if (!this.#providerManager) {
      throw new Error("Current Models instance does not manage providers");
    }
    return this.#providerManager.discoverModels(req);
  }

  async resolveModelMetadata(
    req: import("@kulo/protocol").ResolveModelMetadataRequest,
  ): Promise<import("@kulo/protocol").ResolveModelMetadataResponse> {
    if (!this.#providerManager) {
      throw new Error("Current Models instance does not manage providers");
    }
    return this.#providerManager.resolveModelMetadata(req);
  }

  async startProviderOAuth(providerId: string): Promise<OAuthSessionView> {
    if (!this.#providerManager) {
      throw new Error("Current Models instance does not support OAuth login");
    }
    return this.#providerManager.startOAuthLogin(providerId);
  }

  getProviderOAuth(sessionId: string): OAuthSessionView | null {
    return this.#providerManager?.getOAuthSession(sessionId) ?? null;
  }

  async respondProviderOAuth(
    sessionId: string,
    promptId: string | undefined,
    value: string,
  ): Promise<OAuthSessionView> {
    if (!this.#providerManager) {
      throw new Error("Current Models instance does not support OAuth login");
    }
    return this.#providerManager.respondOAuthPrompt(sessionId, promptId, value);
  }

  cancelProviderOAuth(sessionId: string): OAuthSessionView | null {
    return this.#providerManager?.cancelOAuthSession(sessionId) ?? null;
  }

  setOnClusterDirty(hook: ((kind: "sqlite" | "assistant" | "vault" | "files" | "uploads") => void) | undefined): void {
    this.#onClusterDirty = hook;
  }

  setClusterCloseHook(hook: (() => Promise<void>) | undefined): void {
    this.#clusterCloseHook = hook;
  }

  setClusterHostContext(ctx: { localNodeId: string; legacyLocalNodeId?: string } | undefined): void {
    this.#clusterHostContext = ctx;
    this.connectionManager.setClusterHostContext(ctx);
  }

  get isHandoverBarrierActive(): boolean {
    return this.#handoverBarrierActive;
  }

  #isLoopbackServicePausedForForeignHost(boundNodeId?: string): boolean {
    const ctx = this.#clusterHostContext;
    if (!ctx || ctx.localNodeId === "local") return false;
    const ownerNodeId = boundNodeId ?? ctx.legacyLocalNodeId;
    return Boolean(ownerNodeId && ownerNodeId !== ctx.localNodeId);
  }

  #effectiveMemoryConfig(memory: KuloDurableSettings["memory"]): KuloDurableSettings["memory"] {
    if (
      memory.enabled &&
      isLoopbackEndpointUrl(memory.endpoint) &&
      this.#isLoopbackServicePausedForForeignHost((memory as { boundNodeId?: string }).boundNodeId)
    ) {
      return { ...memory, enabled: false };
    }
    return memory;
  }

  async inspectActiveWorkForHandover(): Promise<{
    busy: boolean;
    activeTurns: number;
    activeTickets: number;
    activeVoiceCalls: number;
    activeSettingsTurns: number;
    activeMediaJobs: number;
  }> {
    let activeTurns = 0;
    for (const cache of this.#topicCaches.values()) {
      if (cache.live.busy) activeTurns += 1;
    }
    const board = await this.getBoardSnapshot();
    const activeTickets = board.tickets.filter((t) => ["running", "queued", "pausing"].includes(t.status)).length;
    const activeVoiceCalls = this.voiceCalls.hasActiveCalls() ? 1 : 0;
    const settingsSnap = await this.settingsAssistant.getSnapshot().catch(() => null);
    const activeSettingsTurns = settingsSnap?.live?.busy ? 1 : 0;
    const mediaList = await this.mediaJobs.list().catch(() => []);
    const activeMediaJobs = mediaList.filter((j) => j.status === "queued" || j.status === "running").length;
    return {
      busy: activeTurns + activeTickets + activeVoiceCalls + activeSettingsTurns + activeMediaJobs > 0,
      activeTurns,
      activeTickets,
      activeVoiceCalls,
      activeSettingsTurns,
      activeMediaJobs,
    };
  }

  async abortActiveWorkForHandover(timeoutMs = 10_000): Promise<void> {
    const localId = this.envManager.localEnvId;
    for (const [topicId, cache] of this.#topicCaches) {
      if (cache.live.busy) {
        await this.deliverClientMessage({ type: "chat.abort", topicId }, localId).catch(() => undefined);
      }
    }
    const board = await this.getBoardSnapshot();
    for (const ticket of board.tickets) {
      if (["running", "queued", "pausing"].includes(ticket.status)) {
        await this.stopTicket(ticket.id, "正在切换主机").catch(() => undefined);
      }
    }
    await this.settingsAssistant.abort().catch(() => undefined);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.inspectActiveWorkForHandover();
      if (!status.busy) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  beginHandoverBarrier(maxDurationMs = 15_000): void {
    this.#handoverBarrierActive = true;
    if (this.#handoverBarrierTimer) clearTimeout(this.#handoverBarrierTimer);
    this.#handoverBarrierTimer = setTimeout(() => {
      this.#handoverBarrierActive = false;
      this.#handoverBarrierTimer = null;
    }, maxDurationMs);
    this.#handoverBarrierTimer.unref?.();
  }

  releaseHandoverBarrier(): void {
    this.#handoverBarrierActive = false;
    if (this.#handoverBarrierTimer) {
      clearTimeout(this.#handoverBarrierTimer);
      this.#handoverBarrierTimer = null;
    }
  }

  getEffectiveIdentityDir(): string {
    return resolveEffectiveIdentityDir(this.#liveSettings, this.#defaultIdentityDir);
  }

  get defaultIdentityDir(): string {
    return this.#defaultIdentityDir;
  }

  #notifyClusterDirty(kind: "sqlite" | "assistant" | "vault" | "files" | "uploads"): void {
    try {
      this.#onClusterDirty?.(kind);
    } catch {
      // Ignore sync observer failures
    }
  }

  close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    return this.#closing ??= this.#finishClose(context);
  }

  async #finishClose(context: Context): Promise<void> {
    this.#closed = true;
    this.externalClientQuotas.close();
    this.releaseHandoverBarrier();
    const errors: unknown[] = [];
    const finish = async (work: () => unknown) => {
      try { await work(); } catch (error) { errors.push(error); }
    };
    await finish(() => this.#clusterCloseHook?.());
    for (const id of [...this.#inlineDispatchWaiters.keys()]) {
      this.#notifyInlineWaiters(id);
    }
    for (const topicId of [...this.#orchestratorBrowserSessions.keys()]) {
      await this.#closeOrchestratorBrowserSession(topicId, true);
    }
    await finish(() => this.#ticketBoard.close());
    if (this.#cleanupRetryTimer) {
      clearTimeout(this.#cleanupRetryTimer);
      this.#cleanupRetryTimer = null;
    }
    if (this.#watchdogTimer) {
      clearInterval(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
    if (this.#topicAutoArchiveTimer) {
      clearInterval(this.#topicAutoArchiveTimer);
      this.#topicAutoArchiveTimer = null;
    }
    if (this.#uploadCleanupTimer) {
      clearInterval(this.#uploadCleanupTimer);
      this.#uploadCleanupTimer = null;
    }
    await finish(() => this.#customizationInstance?.close());
    await finish(() => this.voiceCalls.close());
    await finish(() => this.voice.close());
    await finish(() => this.connectionManager.closeAsync());
    await finish(() => this.envManager.setAndroidNotificationClassifier(undefined));
    await finish(() => this.envManager.setConnectorHandlers(undefined));
    await finish(() => this.larkConnector.close());
    await finish(() => this.homeAssistant.close());
    this.haLanAudio.clear();
    await finish(() => this.assistantSorter.close());
    await finish(() => this.assistantCoordinator.close());
    await finish(() => this.ambientModel.close());
    await finish(() => this.assistantLedger.close());
    await finish(() => this.#androidNotifications.close());
    await finish(() => this.#topicTitles.close());
    await finish(() => this.personality.close());
    await finish(() => this.usageCaps.close());
    this.#computerHandoffs.closeAll();
    await finish(() => this.mediaJobs.close());
    await finish(() => this.extensions.close());
    await finish(() => this.#topicAutoArchiveRun);
    await finish(() => Promise.all(this.#topicActivityUpdates.values()));
    for (const rec of this.#trackedWorkers.values()) {
      await finish(() => rec.detachObserver?.());
    }
    this.#trackedWorkers.clear();
    this.#lastWatchdogAlertAt.clear();
    await finish(() => this.settingsAssistant.close());
    for (const cache of this.#topicWatchesList()) {
      await finish(() => cache.watch.stop());
    }
    this.#topicCaches.clear();
    // A cancelled caller may stop waiting on Durable before admitted writes have drained.
    await finish(() => this.harness.close(withoutAbortSignal(context)));
    const contextPackage = this.#contextPackage;
    this.#contextPackage = null;
    if (contextPackage) await finish(() => contextPackage.close());
    await finish(() => this.history.close());
    await finish(() => this.envManager.close());
    await finish(() => this.search.close());
    await finish(() => this.#releaseProxy());
    await finish(() => this.#stateOwner.close());
    if (errors.length) throw new AggregateError(errors, "关闭 Kulo 时部分资源未能正常退出。");
  }

  #resolveOrchestratorAgent(): {
    model: { provider: string; modelId: string };
    thinkingLevel: BuiltinThinkingEffort;
  } {
    return resolveAgentModelAndThinking(
      this.#models,
      this.#providerId,
      this.#liveSettings.model.defaultProvider,
      this.#liveSettings.model.defaultModel,
      this.#liveSettings.model.thinkingLevel,
      this.#liveSettings.model,
    );
  }

  #topicWatchesList(): WatchedTopicCache[] {
    return [...this.#topicCaches.values()];
  }

  async #resolveWatchedTopic(
    topicId: string,
    context: Context,
  ): Promise<WatchedTopicCache> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const topic = requireTopic(state, topicId);
    const existing = this.#topicCaches.get(topicId);
    if (existing) {
      await this.#alignContextCompaction(existing.conversation.id, context);
      return existing;
    }
    const conv = await this.harness.conversation(
      topic.conversationId as ConversationId,
      context,
    );
    if (!conv) {
      throw new ProjectError(500, "conversation_missing", "会话引用的对话记录不存在。");
    }

    const isRoot = topicId === "root";
    const orchestratorAgent = this.#resolveOrchestratorAgent();
    await conv.configure(
      {
        model: orchestratorAgent.model,
        thinkingLevel: orchestratorAgent.thinkingLevel,
        extensions: this.#orchestratorExtensions(isRoot),
        tools: this.#orchestratorTools(isRoot),
        cwd: topic.projectId ? (await this.projects.get(topic.projectId, context)).workspaceDir : this.#mainWorkspaceDir,
        maxTurns: 25,
      },
      context,
    );

    await this.#alignContextCompaction(conv.id, context);
    return this.#ensureTopicWatched(topicId, conv, context);
  }

  async #ensureTopicWatched(
    topicId: string,
    conversation: Conversation,
    context: Context,
  ): Promise<WatchedTopicCache> {
    const existing = this.#topicCaches.get(topicId);
    if (existing) return existing;

    const watch = await conversation.watch(context, { min: 80, max: 160 });
    try {
      await repairHistoricalChatAttachments(this.harness, this.uploads, queuedChatEntries(watch.value).entries, Number(conversation.id), context);
      await this.#hydrateMessages(watch.value.entries, Number(conversation.id));
      if (this.#closed) throw new Error("Hub is closed");
    } catch (error) {
      await watch.stop();
      throw error;
    }
    // Another selection of this cold topic may have attached its watch during hydration.
    const attached = this.#topicCaches.get(topicId);
    if (attached) { await watch.stop(); return attached; }
    const initialMessages = this.#projectTopicMessages(watch.value, Number(conversation.id));
    const initialLive = redactCredentialData(this.#projectTopicLiveState(watch.value, Number(conversation.id)), (text) => this.connectionManager.redact(text));
    const cache: WatchedTopicCache = {
      topicId,
      conversation,
      watch,
      messages: initialMessages,
      live: initialLive,
      notificationBaseline: createTopicNotificationBaseline(initialMessages, initialLive),
    };
    this.#topicCaches.set(topicId, cache);

    watch.start(async (call) => {
      if (call.kind !== "value") return;
      this.#refreshTopicContent(cache, call.value);
    });

    return cache;
  }

  async #ensureTopicWatchedByConversation(conversationId: number, context: Context): Promise<void> {
    if (this.#closed) return;
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const topicId = state?.conversationToTopic?.[String(conversationId)];
    if (!topicId) return;
    const topic = state?.topics?.[topicId];
    if (!topic || topic.deletedAt) return;
    if (topic.title) this.#topicTitleCache.set(topicId, topic.title);
    if (this.#topicCaches.has(topicId)) return;
    const conversation = await this.harness.conversation(conversationId as ConversationId, context);
    if (conversation) await this.#ensureTopicWatched(topicId, conversation, context);
  }

  async submitUiAction(input: UiActionInput): Promise<UiActionReceipt> {
    const card = await this.uiCards.get(input.cardId);
    if (!card) throw new UiCardError("ui_card_not_found", "卡片不存在。", 404);
    if (!this.#liveSettings.model.defaultModel.trim()) throw new UiCardError("model_not_selected", "请先选择供应商和模型。", 400);
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    if (!isOrchestratorConversation(card.originConversationId, state)) {
      const settings = await this.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
      if (!isActiveSettingsConversation(card.originConversationId, settings)) {
        throw new UiCardError("content_scope_denied", "请在主对话中提交卡片。", 403);
      }
      const receipt = await this.uiCards.submit(input, { conversationId: card.originConversationId });
      await this.#applyResolvedActionConfirmation(receipt, card.originConversationId, input.actionId, input.values);
      return receipt;
    }
    const topicId = state?.conversationToTopic?.[String(card.originConversationId)];
    const topic = topicId ? state?.topics?.[topicId] : undefined;
    if (topic?.deletedAt) throw new UiCardError("content_scope_denied", "当前对话已删除。", 403);
    if (topic?.projectId) await this.projects.ensureAuthorized(topic.projectId, BACKGROUND_CONTEXT);
    const receipt = await this.uiCards.submit(input, { conversationId: card.originConversationId });
    await this.#applyResolvedActionConfirmation(receipt, card.originConversationId, input.actionId, input.values);
    return receipt;
  }

  async executeMemoryServiceJob(input: { jobId: string; clientId: string }) {
    await this.memoryService.decide(input.jobId, input.clientId, "confirm");
    await this.#waitBrieflyForMemoryJob(input.jobId, 4_000);
    return this.memoryService.snapshot(input.clientId);
  }

  async confirmMemoryServiceOperation(input: {
    conversationId: number;
    callId: string;
    job: MemoryServiceJob;
  }): Promise<{ cardId: string; status: "pending" | "approved" | "denied" }> {
    const operation = input.job.operation;
    if (operation !== "deploy" && operation !== "configure" && operation !== "uninstall") {
      throw new Error("当前记忆服务操作不需要交互确认卡。");
    }
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const topicId = state?.conversationToTopic?.[String(input.conversationId)] ?? "root";
    const fingerprint = memoryServiceOperationFingerprint({
      jobId: input.job.id,
      clientId: input.job.clientId,
      operation,
    });
    const built = buildMemoryServiceConfirmCard({
      operation,
      title: input.job.title,
      deviceName: input.job.deviceName,
      changes: input.job.changes,
    });
    const { confirmation } = await this.actionConfirmations.ensurePendingCard({
      conversationId: input.conversationId,
      topicId,
      callId: input.callId,
      kind: "memory_service_operation",
      fingerprint,
      cardInput: built.input,
      logicalIds: built.logicalIds,
      payload: {
        kind: "memory_service_operation",
        jobId: input.job.id,
        clientId: input.job.clientId,
        operation,
        deviceName: input.job.deviceName,
        title: input.job.title,
        changes: [...input.job.changes],
      },
    });
    return {
      cardId: confirmation.cardId!,
      status: confirmation.status === "pending_orchestrator" ? "pending" : confirmation.status,
    };
  }

  async #resolveHostActionTargetEnv(
    caller: HostActionCaller,
    requestedEnvId: string | undefined,
    context: Context,
  ): Promise<{ envId: string; envName: string }> {
    let envId: string;
    if (caller.kind === "worker") {
      envId = caller.envId;
    } else if (requestedEnvId?.trim()) {
      envId = requestedEnvId.trim();
    } else {
      const state = await this.harness.snapshot(KuloStateDoc, context);
      const topicId = state?.conversationToTopic?.[String(caller.conversationId)];
      const topic = topicId ? state?.topics?.[topicId] : undefined;
      if (topic?.projectId) {
        const project = await this.projects.get(topic.projectId, context).catch(() => undefined);
        envId = project?.deviceId ?? this.envManager.pickDefaultEnvId();
      } else if (topic?.targetDeviceId) {
        envId = topic.targetDeviceId;
      } else {
        envId = this.envManager.pickDefaultEnvId();
      }
    }
    const descriptor = this.envManager.getEnvDescriptor(envId);
    if (!descriptor) {
      throw new Error(`找不到执行设备 '${envId}'。`);
    }
    if (!descriptor.online) {
      throw new Error(`目标设备 '${descriptor.name}' (${envId}) 当前离线。`);
    }
    if (descriptor.executionKind === "native-device") {
      throw new Error(`设备 '${descriptor.name}' 是 Android 手机，不支持电脑本机操作。`);
    }
    return { envId, envName: descriptor.name || envId };
  }

  async #hostActionInspect(
    caller: HostActionCaller,
    input: {
      envId?: string;
      scope: "summary" | "processes" | "ports";
      filter?: string;
      paths?: string[];
      limit?: number;
    },
    context: Context,
  ) {
    const { envId, envName } = await this.#resolveHostActionTargetEnv(caller, input.envId, context);
    const result = await this.envManager.requestHostAction(
      envId,
      {
        kind: "inspect",
        scope: input.scope,
        ...(input.filter ? { filter: input.filter } : {}),
        ...(input.paths?.length ? { paths: input.paths } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      context.abortSignal,
    );
    return { envId, envName, result };
  }

  async #hostActionRun(
    caller: HostActionCaller,
    input: {
      envId?: string;
      summary: string;
      commands: string[];
      cwd?: string;
      timeoutMs?: number;
    },
    context: Context,
  ): Promise<HostActionRunOutcome> {
    if (caller.kind === "worker" && caller.readOnly) {
      throw new Error("当前角色为只读模式，不能执行本机变更命令。");
    }
    validateHostMaintenanceCommands(input.commands);
    const { envId, envName } = await this.#resolveHostActionTargetEnv(caller, input.envId, context);

    // Main Agent holds full personal-assistant authority and executes host actions directly.
    if (caller.kind === "orchestrator") {
      const result = await this.envManager.requestHostAction(
        envId,
        {
          kind: "run",
          commands: input.commands,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
        context.abortSignal,
      );
      return { status: "executed", envId, envName, result };
    }

    if (caller.isSubagent) {
      throw new Error("子智能体不能直接申请本机运维操作；请将待执行的命令清单返回给父级 Worker，由父级 Worker 统一提交给主智能体研判。");
    }

    const originConversationId = caller.originConversationId || Number(ROOT_CONVERSATION_ID);
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const topicId = state?.conversationToTopic?.[String(originConversationId)];
    const topic = topicId ? state?.topics?.[topicId] : undefined;
    if (topic?.deletedAt) {
      throw new Error("所属会话已删除。");
    }

    const fingerprint = hostActionFingerprint({
      envId,
      commands: input.commands,
      cwd: input.cwd,
      ticketId: caller.ticketId,
      runEpoch: caller.runEpoch,
      requestId: caller.callId,
    });
    const existing = await this.actionConfirmations.lookup(originConversationId, "host_action", fingerprint, context);
    if (existing?.status === "approved" && !existing.executed) {
      const result = await this.envManager.requestHostAction(
        envId,
        {
          kind: "run",
          commands: input.commands,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
        context.abortSignal,
      );
      await this.actionConfirmations.markExecuted(existing.id, context);
      return { status: "executed", envId, envName, result };
    }

    const redactedSummary = this.connectionManager.redact(input.summary);
    const confirmation = await this.actionConfirmations.createPendingOrchestratorRequest({
      conversationId: originConversationId,
      kind: "host_action",
      fingerprint,
      payload: {
        kind: "host_action",
        envId,
        envName,
        summary: redactedSummary,
        commands: [...input.commands],
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ticketId: caller.ticketId,
        runEpoch: caller.runEpoch,
        requestId: caller.callId,
      },
    }, context);

    const now = Date.now();
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloStateDoc);
      const ticket = doc.tickets[caller.ticketId];
      if (!ticket || ticket.status !== "running" || ticket.runEpoch !== caller.runEpoch) return;
      ticket.waiting = {
        reason: "coordinator",
        since: now,
        detail: redactedSummary,
        waitToken: `host-action-req:${confirmation.id}`,
        requestId: confirmation.id,
      };
      ticket.updatedAt = now;
    }, context);
    this.#notifyInlineWaiters(caller.ticketId);
    await this.#broadcastTickets(context);

    return {
      status: "awaiting_orchestrator_decision",
      requestId: confirmation.id,
      envId,
      envName,
      message: "已将本机操作申请提交给主智能体研判，当前任务已挂起等待裁决。",
    };
  }

  async #relayHostActionRequest(ticketId: string): Promise<void> {
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const ticket = state?.tickets[ticketId];
    if (
      !ticket ||
      ticket.status !== "waiting" ||
      ticket.waiting?.reason !== "coordinator" ||
      !ticket.waiting.waitToken?.startsWith("host-action-req:")
    ) {
      return;
    }
    const requestId = ticket.waiting.waitToken.slice("host-action-req:".length);
    const confirmation = await this.actionConfirmations.getById(requestId, BACKGROUND_CONTEXT);
    if (!confirmation || confirmation.status !== "pending_orchestrator" || confirmation.payload.kind !== "host_action") {
      return;
    }
    const origin = await this.harness.conversation((ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, BACKGROUND_CONTEXT);
    if (!origin) return;
    const payload = confirmation.payload;
    const redactedCommands = payload.commands.map((cmd) => this.connectionManager.redact(cmd));
    const message = formatHostActionRequestMessage({
      requestId: confirmation.id,
      ticketId: ticket.id,
      title: ticket.title,
      envId: payload.envId,
      envName: payload.envName,
      cwd: payload.cwd,
      summary: this.connectionManager.redact(payload.summary),
      commands: redactedCommands,
    });
    await this.harness.commit(async (tx) => {
      await injectEventToolsInTx(tx, origin.id, ["kulo_host_action_decide"]);
      return submitAutomaticChatInput(tx, origin, {
        type: "input",
        content: this.connectionManager.redact(message),
        whenBusy: "followUp",
        requestId: `kulo:host-action-request:${confirmation.id}`,
      });
    }, BACKGROUND_CONTEXT);
    if (!this.#recovering) this.harness.resume();
    await this.#broadcastTickets(BACKGROUND_CONTEXT);
  }

  async #hostActionDecide(
    caller: Extract<HostActionCaller, { kind: "orchestrator" }>,
    input: {
      requestId: string;
      decision: "approve" | "deny" | "ask_user";
      reason?: string;
    },
    context: Context,
  ): Promise<HostActionDecideOutcome> {
    const pending = await this.actionConfirmations.getById(input.requestId, context);
    if (!pending || pending.payload.kind !== "host_action" || pending.conversationId !== caller.conversationId) {
      throw new Error(`找不到属于当前会话的本机操作申请 '${input.requestId}'。`);
    }
    if (pending.executed || (pending.status !== "pending_orchestrator" && pending.status !== "pending")) {
      return {
        status: "already_resolved",
        requestId: pending.id,
        message: "该本机操作申请已被处理完成。",
      };
    }
    const payload = pending.payload;

    if (input.decision === "ask_user") {
      const state = await this.harness.snapshot(KuloStateDoc, context);
      const topicId = state?.conversationToTopic?.[String(caller.conversationId)];
      const redactedSummary = this.connectionManager.redact(payload.summary);
      const redactedReason = input.reason ? this.connectionManager.redact(input.reason) : undefined;
      const redactedCommands = payload.commands.map((cmd) => this.connectionManager.redact(cmd));
      const built = buildHostActionConfirmCard({
        envName: payload.envName,
        summary: redactedSummary,
        commands: redactedCommands,
        cwd: payload.cwd,
        reason: redactedReason,
      });
      const { confirmation } = await this.actionConfirmations.attachCardToRequest(
        pending.id,
        {
          ...(topicId ? { topicId } : {}),
          ...(payload.ticketId ? { ticketId: payload.ticketId } : {}),
          callId: caller.callId,
          cardInput: built.input,
          logicalIds: built.logicalIds,
        },
        context,
      );
      if (payload.ticketId) {
        const now = Date.now();
        await this.harness.commit(async (tx) => {
          const doc = await tx.doc(KuloStateDoc);
          const ticket = doc.tickets[payload.ticketId!];
          if (!ticket || !isTicketUnfinished(ticket)) return;
          ticket.waiting = {
            reason: "user",
            since: now,
            detail: redactedReason ? `${redactedSummary}（${redactedReason}）` : redactedSummary,
            waitToken: `host-action:${confirmation.cardId}`,
            cardId: confirmation.cardId,
            requestId: confirmation.id,
            options: [
              { id: "confirm", label: "允许", tone: "primary" },
              { id: "cancel", label: "拒绝", tone: "secondary" },
            ],
          };
          ticket.updatedAt = now;
        }, context);
        await this.#broadcastTickets(context);
      }
      return {
        status: "awaiting_user_confirmation",
        requestId: confirmation.id,
        cardId: confirmation.cardId!,
        envId: payload.envId,
        envName: payload.envName,
        message: "已向用户弹出本机操作确认卡片（含允许/拒绝/手动输入），对话不阻塞；若用户直接在聊天中回复，你可以再次调用 kulo_host_action_decide 直接执行并自动收口该卡片。",
      };
    }

    const openCardId = pending.cardId;
    if (input.decision === "deny") {
      const resolved = await this.actionConfirmations.resolveProgrammatically(
        pending.id,
        {
          status: "denied",
          selectedChoiceId: "cancel",
          resultSummary: openCardId ? "已通过对话拒绝" : "主智能体已拒绝",
          markExecuted: true,
        },
        context,
      );
      if (!resolved) {
        return { status: "already_resolved", requestId: pending.id, message: "该本机操作申请已被处理完成。" };
      }
      if (payload.ticketId) {
        const reasonText = input.reason ? this.connectionManager.redact(input.reason) : "主智能体评估后拒绝了该本机操作。";
        await this.steerTicket({
          ticketId: payload.ticketId,
          commandId: `host-action:${resolved.id}:denied`,
          text: `主智能体拒绝了在 ${payload.envName} (${payload.envId}) 上执行的本机操作「${payload.summary}」。原因/指引：${reasonText}\n请勿重复同一操作，按指引调整方案或向主智能体汇报。`,
          originConversationId: caller.conversationId,
        }, context);
      }
      return {
        status: "denied",
        requestId: resolved.id,
        ...(payload.ticketId ? { ticketId: payload.ticketId } : {}),
        ...(openCardId ? { settledCardId: openCardId } : {}),
        message: "已拒绝该本机操作并通知 Worker 调整方案。",
      };
    }

    // decision === "approve"
    if (!openCardId) {
      for (const cmd of payload.commands) {
        const floor = classifyShellSafetyFloor(cmd);
        if (floor.verdict !== "safe") {
          throw new Error(
            floor.verdict === "block"
              ? `本机操作命令触发毁灭性安全底线（${floor.reason ?? "catastrophic"}），禁止放行。`
              : `本机操作命令包含无法静态完整解析的 Shell 语法（${floor.reason ?? "unreadable"}），禁止主智能体静默自动放行；请改用 decision='ask_user' 由用户亲自确认。`,
          );
        }
      }
    }
    const resolved = await this.actionConfirmations.resolveProgrammatically(
      pending.id,
      {
        status: "approved",
        selectedChoiceId: "confirm",
        resultSummary: openCardId ? "已通过对话允许" : "主智能体已允许",
        markExecuted: false,
      },
      context,
    );
    if (!resolved) {
      return { status: "already_resolved", requestId: pending.id, message: "该本机操作申请已被处理完成。" };
    }
    const dispatched = await this.actionConfirmations.markDispatched(resolved.id, context);
    if (!dispatched) {
      return { status: "already_resolved", requestId: resolved.id, message: "该本机操作申请已发出或已处理完成，切勿重复执行。" };
    }
    if (payload.ticketId) {
      await this.#recordTicketOutwardAction(payload.ticketId, undefined, "host_action", `host_action:${payload.summary}`, context);
    }
    let result: Awaited<ReturnType<EnvManager["requestHostAction"]>>;
    try {
      result = await this.envManager.requestHostAction(
        payload.envId,
        {
          kind: "run",
          commands: payload.commands,
          ...(payload.cwd ? { cwd: payload.cwd } : {}),
          ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
        },
        context.abortSignal,
      );
      await this.actionConfirmations.markOutcome(resolved.id, "confirmed", undefined, context);
    } catch (error) {
      const errMsg = this.connectionManager.redact(error instanceof Error ? error.message : "本机操作执行失败");
      const errCode = (error as { code?: unknown })?.code;
      const preDispatch = errCode === "env_offline" || errCode === "env_unavailable";
      await this.actionConfirmations.markOutcome(
        resolved.id,
        preDispatch ? "failed_pre_dispatch" : "unknown",
        errMsg,
        context,
      );
      throw error;
    }
    if (payload.ticketId) {
      const safeOut = this.connectionManager.redact(JSON.stringify(result));
      const summaryText = `主智能体已批准并在 ${payload.envName} (${payload.envId}) 上执行完成本机操作「${payload.summary}」。执行结果：\n${safeOut}`;
      await this.steerTicket({
        ticketId: payload.ticketId,
        commandId: `host-action:${resolved.id}:approved`,
        text: `${summaryText}\n请基于实际执行结果继续验证并完成当前任务。`,
        originConversationId: caller.conversationId,
      }, context);
    }
    return {
      status: "executed",
      requestId: resolved.id,
      envId: payload.envId,
      envName: payload.envName,
      result,
      ...(openCardId ? { settledCardId: openCardId } : {}),
      message: "已批准并执行完成，Worker 已恢复继续推进（如无需向用户汇报，可直接回复 [COORDINATOR_OK]）。",
    };
  }

  async #executeResolvedHostAction(
    resolved: PendingActionConfirmation,
    conversationId: number,
  ): Promise<void> {
    if (resolved.payload.kind !== "host_action" || effectiveConfirmationEffect(resolved) !== "none") return;
    const payload = resolved.payload;
    const refId = resolved.cardId ?? resolved.id;
    if (resolved.status !== "approved") {
      await this.actionConfirmations.markOutcome(resolved.id, "confirmed");
      if (payload.ticketId) {
        try {
          await this.steerTicket({
            ticketId: payload.ticketId,
            commandId: `host-action:${refId}:denied`,
            text: `用户拒绝了在 ${payload.envName} (${payload.envId}) 上执行的本机操作「${payload.summary}」。请勿再次尝试同一操作，直接按现状向主智能体汇报。`,
          });
        } catch (error) {
          console.warn("[KuloConfirmation] Failed to resume worker after host action denial", error instanceof Error ? error.message : String(error));
        }
      }
      return;
    }

    const claimed = await this.actionConfirmations.markDispatched(resolved.id);
    if (!claimed) return;
    if (payload.ticketId) {
      await this.#recordTicketOutwardAction(payload.ticketId, undefined, "host_action", `host_action:${payload.summary}`);
    }

    let summaryText: string;
    try {
      const result = await this.envManager.requestHostAction(payload.envId, {
        kind: "run",
        commands: payload.commands,
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
        ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
      });
      await this.actionConfirmations.markOutcome(resolved.id, "confirmed");
      const safeOut = this.connectionManager.redact(JSON.stringify(result));
      summaryText = `用户已批准并在 ${payload.envName} (${payload.envId}) 上执行完成本机操作「${payload.summary}」。执行结果：\n${safeOut}`;
    } catch (error) {
      const errMsg = this.connectionManager.redact(error instanceof Error ? error.message : "本机操作执行失败");
      const errCode = (error as { code?: unknown })?.code;
      const preDispatch = errCode === "env_offline" || errCode === "env_unavailable";
      await this.actionConfirmations.markOutcome(
        resolved.id,
        preDispatch ? "failed_pre_dispatch" : "unknown",
        errMsg,
      );
      summaryText = preDispatch
        ? `用户已批准在 ${payload.envName} (${payload.envId}) 上执行本机操作「${payload.summary}」，但目标设备当时离线未发出：${errMsg}`
        : `用户已批准在 ${payload.envName} (${payload.envId}) 上执行本机操作「${payload.summary}」，命令已发出但回执未决（未自动重放）：${errMsg}。请先通过只读命令核验实际状态，切勿盲目重复执行。`;
    }

    if (payload.ticketId) {
      try {
        await this.steerTicket({
          ticketId: payload.ticketId,
          commandId: `host-action:${refId}:approved`,
          text: `${summaryText}\n请基于实际执行结果继续验证并完成当前任务。`,
        });
      } catch (error) {
        console.warn("[KuloConfirmation] Failed to resume worker after host action execution", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const origin = await this.harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (origin) {
      await this.harness.commit(
        (tx) =>
          submitAutomaticChatInput(tx, origin, {
            type: "input",
            content: `[KULO_HOST_ACTION_RESULT]\n${summaryText}\n请用当前对话语言向用户简洁反馈实际执行结果，不要暴露内部卡片或工单编号。`,
            whenBusy: "followUp",
            requestId: `kulo:host-action-result:${refId}`,
          }),
        BACKGROUND_CONTEXT,
      );
    }
  }

  async #reconcileDispatchedConfirmations(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    const recovered = await this.actionConfirmations.reconcileDispatchedOnStartup(context);
    for (const record of recovered) {
      const payload = record.payload;
      if (payload.kind === "host_action") {
        const notice = `服务在执行已批准的本机操作「${payload.summary}」（设备 ${payload.envName} / ${payload.envId}）期间发生重启或切换，操作已发出但未收到最终回执（未自动重放）。请先通过只读方式核验实际状态，切勿盲目重复执行具有副作用的命令。`;
        if (payload.ticketId) {
          try {
            await this.steerTicket(
              {
                ticketId: payload.ticketId,
                commandId: `action-recovery:${record.id}:unknown`,
                text: notice,
              },
              context,
            );
          } catch (error) {
            console.warn("[KuloConfirmation] Startup unknown host_action wake skipped", error instanceof Error ? error.message : String(error));
          }
        } else {
          try {
            const origin = await this.harness.conversation(record.conversationId as ConversationId, context);
            if (origin) {
              await this.harness.commit(
                (tx) =>
                  submitAutomaticChatInput(tx, origin, {
                    type: "input",
                    content: `[KULO_HOST_ACTION_RESULT]\n${notice}\n请用当前对话语言简洁告知用户需要核实，不要暴露内部卡片或工单编号。`,
                    whenBusy: "followUp",
                    requestId: `kulo:action-recovery:${record.id}:unknown`,
                  }),
                context,
              );
            }
          } catch (error) {
            console.warn("[KuloConfirmation] Startup unknown host_action chat notice skipped", error instanceof Error ? error.message : String(error));
          }
        }
        continue;
      }
      if (payload.kind === "staged_apply" || payload.kind === "external_permission") {
        try {
          await this.steerTicket(
            {
              ticketId: payload.ticketId,
              commandId: `action-recovery:${record.id}:unknown`,
              text: "服务在应用已批准操作期间发生重启或切换，当前结果未知且未自动重放。请先只读检查工作区或外部任务现状后再决定下一步。",
            },
            context,
          );
        } catch (error) {
          console.warn("[KuloConfirmation] Startup unknown ticket recovery skipped", error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  async #waitBrieflyForMemoryJob(jobId: string, timeoutMs: number): Promise<void> {
    const doc = await this.harness.snapshot(MemoryServiceDoc, BACKGROUND_CONTEXT);
    const taskId = doc?.jobs?.[jobId]?.taskId;
    if (taskId === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.harness.waitForTask(taskId as TaskId, BACKGROUND_CONTEXT),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #applyResolvedActionConfirmation(
    receipt: UiActionReceipt,
    conversationId: number,
    actionId: string,
    values?: import("@kulo/protocol").UiValues,
  ): Promise<void> {
    if (receipt.deduplicated) return;
    const resolved = await this.actionConfirmations.resolveFromUiSubmit(receipt.cardId, actionId, values);
    if (!resolved) return;

    if (resolved.selectedChoiceId === "manual") {
      const toolsToInject: string[] = [];
      let ticketId: string | undefined;
      if (resolved.payload.kind === "host_action") {
        toolsToInject.push("kulo_host_action_decide");
        ticketId = resolved.payload.ticketId;
      } else if (resolved.payload.kind === "external_permission") {
        toolsToInject.push("kulo_external_permission");
        ticketId = resolved.payload.ticketId;
      } else if (resolved.payload.kind === "ticket_decision") {
        toolsToInject.push("kulo_ticket_ask_user");
        ticketId = resolved.payload.ticketId;
      } else if (resolved.payload.kind === "staged_apply") {
        toolsToInject.push("kulo_apply_staged_changes");
        ticketId = resolved.payload.ticketId;
      } else if (resolved.payload.kind === "customization_validate") {
        toolsToInject.push("kulo_customization");
      } else if (resolved.payload.kind === "memory_service_operation") {
        toolsToInject.push("kulo_memory_service_read", "kulo_memory_service_prepare");
      }
      await this.harness.commit(async (tx) => {
        if (toolsToInject.length > 0) {
          await injectEventToolsInTx(tx, conversationId, toolsToInject);
        }
        if (ticketId) {
          const doc = await tx.doc(KuloStateDoc);
          const ticket = doc.tickets[ticketId];
          if (ticket && ticket.status === "waiting" && ticket.waiting?.reason === "user") {
            ticket.waiting = {
              reason: "coordinator",
              since: Date.now(),
              detail: resolved.manualInstruction || ticket.waiting.detail,
              ...(resolved.payload.kind === "host_action" ? { waitToken: `host-action-req:${resolved.id}` } : {}),
              requestId: resolved.id,
            };
            ticket.updatedAt = Date.now();
          }
        }
      }, BACKGROUND_CONTEXT);
      if (ticketId) await this.#broadcastTickets(BACKGROUND_CONTEXT);
      return;
    }

    if (resolved.payload.kind === "memory_service_operation") {
      const decision = resolved.status === "approved" ? "confirm" : "reject";
      try {
        await this.memoryService.decide(resolved.payload.jobId, resolved.payload.clientId, decision);
        if (decision === "confirm") {
          await this.#waitBrieflyForMemoryJob(resolved.payload.jobId, 4_000);
        }
        await this.actionConfirmations.markExecuted(resolved.id);
      } catch (error) {
        console.warn("[KuloConfirmation] Memory service operation skipped", error instanceof Error ? error.message : String(error));
      }
      await this.harness.commit(async (tx) => {
        await injectEventToolsInTx(tx, conversationId, ["kulo_memory_service_read"]);
      }, BACKGROUND_CONTEXT);
      return;
    }
    if (resolved.payload.kind === "computer_handoff") {
      await this.resolveComputerHandoff(
        resolved.payload.ticketId,
        resolved.status === "approved" ? "done" : "cancel",
        resolved.manualInstruction,
      );
      return;
    }
    if (resolved.payload.kind === "host_action") {
      const task = this.#executeResolvedHostAction(resolved, conversationId).catch((error: unknown) => {
        console.warn("[KuloConfirmation] Host action execution failed", error instanceof Error ? error.message : String(error));
      });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          task,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 4_000);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return;
    }
    if (resolved.status !== "approved") return;
    if (resolved.payload.kind === "ticket_decision" && resolved.selectedChoiceId) {
      try {
        const chosen = resolved.payload.options.find((opt) => opt.id === resolved.selectedChoiceId);
        const answerText = chosen?.value ?? chosen?.label ?? resolved.selectedChoiceId;
        await this.actionConfirmations.markExecuted(resolved.id);
        await this.steerTicket({
          ticketId: resolved.payload.ticketId,
          commandId: `ticket-decision:${resolved.cardId ?? resolved.id}`,
          text: answerText,
          decisionOptionId: resolved.selectedChoiceId,
        });
      } catch (error) {
        console.warn("[KuloConfirmation] Ticket decision resume skipped", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (resolved.payload.kind === "external_permission" && resolved.selectedChoiceId) {
      const claimed = await this.actionConfirmations.markDispatched(resolved.id);
      if (!claimed) return;
      try {
        await this.respondExternalAgentPermission(
          resolved.payload.ticketId,
          resolved.payload.permissionId,
          resolved.selectedChoiceId,
          resolved.payload.runEpoch,
        );
        await this.actionConfirmations.markOutcome(resolved.id, "confirmed");
      } catch (error) {
        const errMsg = this.connectionManager.redact(error instanceof Error ? error.message : "外部权限回应失败");
        await this.actionConfirmations.markOutcome(resolved.id, "unknown", errMsg);
        console.warn("[KuloConfirmation] External permission execution skipped", errMsg);
      }
      return;
    }
    if (resolved.payload.kind === "staged_apply") {
      const claimed = await this.actionConfirmations.markDispatched(resolved.id);
      if (!claimed) return;
      try {
        await this.applyStagedChanges({
          commandId: resolved.payload.commandId,
          ticketId: resolved.payload.ticketId,
          paths: resolved.payload.paths,
          allowConflicts: resolved.payload.allowConflicts,
          originConversationId: conversationId,
        });
        await this.actionConfirmations.markOutcome(resolved.id, "confirmed");
      } catch (error) {
        const errMsg = this.connectionManager.redact(error instanceof Error ? error.message : "应用暂存更改失败");
        const errCode = (error as { code?: unknown })?.code;
        const preDispatch = errCode === "staged_conflict" || errCode === "env_offline";
        await this.actionConfirmations.markOutcome(
          resolved.id,
          preDispatch ? "failed_pre_dispatch" : "unknown",
          errMsg,
        );
        console.warn("[KuloConfirmation] Staged apply execution skipped", errMsg);
      }
      return;
    }
    if (resolved.payload.kind === "customization_validate") {
      await this.harness.commit(async (tx) => {
        await injectEventToolsInTx(tx, conversationId, ["kulo_customization"]);
      }, BACKGROUND_CONTEXT);
    }
  }

  async #hydrateMessages(entries: readonly EntryRecord[], conversationId: number, options?: DisplayMessageOptions, context: Context = BACKGROUND_CONTEXT): Promise<ChatDisplayItem[]> {
    await repairHistoricalChatAttachments(this.harness, this.uploads, entries, conversationId, context);
    if (entries[0]) {
      const conversation = await this.harness.conversation(conversationId as ConversationId, context);
      if (conversation) this.#searchHistory(conversationId).remember(await loadSearchEvidencePrefix(conversation, entries[0], context));
    }
    for (const card of await this.uiCards.snapshot(conversationId)) {
      if ((this.#cardSnapshots.get(card.cardId)?.revision ?? 0) <= card.revision) this.#cardSnapshots.set(card.cardId, card);
    }
    return this.#projectMessages(entries, conversationId, options);
  }

  #projectMessages(entries: readonly EntryRecord[], conversationId: number, options?: DisplayMessageOptions): ChatDisplayItem[] {
    return this.#decorateChatMessages(this.#searchHistory(conversationId).project(entries, (projection) => extractDisplayMessages(projection, options)), conversationId);
  }

  #decorateChatMessages(messages: ChatDisplayItem[], conversationId: number): ChatDisplayItem[] {
    const projected = messages.map((item) => {
      const parts = getMessageParts(item).map((part) => {
        if (part.type === "ui") return { ...part, card: this.#cardSnapshots.get(part.cardId) };
        if ("assetId" in part) {
          const loaded = this.uploads.getUpload(part.assetId);
          if (loaded) {
            if (loaded.record.ownerId !== undefined && !loaded.record.referenceScopes?.includes(`conversation:${conversationId}`)) {
              return { partId: part.partId, type: "markdown" as const, text: "附件不可用" };
            }
            return { ...part, asset: { ...this.uploads.toChatAttachment(loaded.record),
              ...(part.asset?.transcript ? { transcript: part.asset.transcript } : {}),
              ...(part.asset?.captions ? { captions: part.asset.captions } : {}),
            } };
          }
        }
        return part;
      });
      const attachments = item.attachments ? parts.flatMap((part) => "asset" in part && part.asset ? [part.asset] : []) : undefined;
      return { ...item, parts, ...(attachments ? { attachments } : {}) };
    });
    return redactCredentialData(projected, (text) => this.connectionManager.redact(text));
  }

  #searchHistory(conversationId: number): SearchEvidenceHistory {
    let history = this.#searchHistories.get(conversationId);
    if (!history) { history = new SearchEvidenceHistory(); this.#searchHistories.set(conversationId, history); }
    return history;
  }

  #projectTopicMessages(value: ConversationView, conversationId: number): ChatDisplayItem[] {
    const queued = queuedChatEntries(value);
    // Inbox receipts are not transcript boundaries and must never enter evidence history.
    const pending = this.#decorateChatMessages(extractDisplayMessages(queued.entries), conversationId).map((item) => {
      const delivery = queued.deliveries.get(item.id);
      return delivery ? { ...item, ...delivery } : item;
    });
    return [...this.#projectMessages(value.entries, conversationId), ...pending];
  }

  #projectTopicLiveState(value: ConversationView, conversationId: number): LiveStreamState {
    return extractLiveState(value, this.#searchHistory(conversationId).projectionEntries(value.entries));
  }

  #refreshTopicContent(cache: WatchedTopicCache, value = cache.watch.value): void {
    if (this.#closed || this.#topicCaches.get(cache.topicId) !== cache) return;
    const messages = this.#projectTopicMessages(value, Number(cache.conversation.id));
    cache.messages = messages;
    const latestPreview = summarizeTopicPreview(messages);
    if (latestPreview) this.#topicPreviewCache.set(cache.topicId, latestPreview);
    const wasBusy = cache.live.busy;
    cache.live = redactCredentialData(this.#projectTopicLiveState(value, Number(cache.conversation.id)), (text) => this.connectionManager.redact(text));
    if (wasBusy && !cache.live.busy) {
      this.#recordTopicActivity(cache.topicId, latestPreview);
    }
    if (!cache.live.busy && value.entries.some((entry) => CompactionEntry.is(entry))) {
      void this.#contextCompaction.pruneCommittedBaseline(cache.conversation.id, BACKGROUND_CONTEXT, false).catch(() => {});
    }
    const notification = detectMainSessionNotification({
      topicId: cache.topicId,
      topicTitle: cache.topicId === "root" ? undefined : this.#topicTitleCache.get(cache.topicId),
      previous: cache.notificationBaseline,
      messages,
      live: cache.live,
      redact: (text) => this.connectionManager.redact(text),
    });
    cache.notificationBaseline = notification.next;
    this.voiceCalls.topicUpdated(cache.topicId, messages, cache.live);
    this.#topicTitles.observe(cache.topicId, messages, cache.live.busy || Boolean(cache.live.runFailure));
    for (const listener of this.#listeners) {
      listener.onTopicView?.(cache.topicId, messages, cache.live);
      if (cache.topicId === "root") listener.onRootView?.(messages, cache.live);
      if (notification.event && !this.#recovering) listener.onNotification?.(notification.event);
    }
  }

  #recordTopicActivity(topicId: string, latestPreview?: { preview: string; at?: number }): void {
    const at = Date.now();
    const previous = this.#topicActivityUpdates.get(topicId);
    const update = (async () => {
      await previous;
      const topics = await this.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const topic = state.topics?.[topicId];
        if (!topic || topic.deletedAt) return undefined;
        let changed = false;
        if (!topic.master && topic.id !== "root") {
          const nextUpdatedAt = Math.max(topic.updatedAt, at);
          if (nextUpdatedAt !== topic.updatedAt) {
            topic.updatedAt = nextUpdatedAt;
            changed = true;
          }
        }
        if (applyTopicPreview(topic, latestPreview, at)) {
          changed = true;
        }
        return changed ? listSortedTopics(state) : undefined;
      }, BACKGROUND_CONTEXT);
      if (topics) this.#emitTopics(topics);
    })().catch((error) => {
      console.warn("[KuloTopicArchive] Could not record completed conversation activity", topicId, error);
    }).finally(() => {
      if (this.#topicActivityUpdates.get(topicId) === update) this.#topicActivityUpdates.delete(topicId);
    });
    this.#topicActivityUpdates.set(topicId, update);
  }

  async #migrateNativeSearchPlan(plan: { providerId: string; modelId: string; enabled: boolean }): Promise<boolean> {
    let available = true;
    const next = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      const model = cloneJson(doc.model) as KuloDurableSettings["model"];
      let list = plan.providerId === KULO_GATEWAY_PROVIDER_ID ? model.gatewayModels :
        model.subscriptionModels?.[plan.providerId] ?? model.customProviders?.find((provider) => provider.id === plan.providerId)?.models;
      let selected = list?.find((item) => item.id === plan.modelId);
      if (selected?.nativeTools?.webSearch !== undefined) return undefined;
      if (!selected) {
        const registered = this.#models.getModel(plan.providerId, plan.modelId);
        if (!registered) { available = false; return undefined; }
        selected = { id: registered.id, name: registered.name, reasoning: registered.reasoning,
          contextWindow: registered.contextWindow, maxTokens: registered.maxTokens,
          ...(registered.thinkingLevelMap ? { thinkingLevelMap: { ...registered.thinkingLevelMap } } : {}) };
        if (!list) {
          if (plan.providerId === KULO_GATEWAY_PROVIDER_ID) list = model.gatewayModels ??= [];
          else { model.subscriptionModels ??= {}; list = model.subscriptionModels[plan.providerId] ??= []; }
        }
        list.push(selected);
      }
      selected.nativeTools = { ...selected.nativeTools, webSearch: plan.enabled };
      applySettingsBlockUpdate(doc, "model", doc.revisions.model, model);
      return cloneJson(doc) as KuloDurableSettings;
    }, BACKGROUND_CONTEXT);
    if (next) await this.#applyLiveSettings(next, BACKGROUND_CONTEXT);
    return available;
  }

  async #applyLiveSettings(
    nextDoc: KuloDurableSettings,
    context: Context,
  ): Promise<void> {
    const oldIdentityDir = resolveEffectiveIdentityDir(this.#liveSettings, this.#defaultIdentityDir);
    const oldAuthFile = this.#liveSettings.memory.authFile;
    for (const key of Object.keys(this.#liveSettings)) {
      if (!Object.hasOwn(nextDoc, key)) delete (this.#liveSettings as Record<string, unknown>)[key];
    }
    Object.assign(this.#liveSettings, nextDoc);
    this.externalClientQuotas.reconcileFromSettings(this.#liveSettings.roles, this.#liveSettings.externalClients);

    const effectiveIdentityDir = resolveEffectiveIdentityDir(this.#liveSettings, this.#defaultIdentityDir);
    if (oldIdentityDir !== effectiveIdentityDir || oldAuthFile !== nextDoc.memory.authFile) {
      this.envManager.invalidateWorkerEnvironments();
    }
    if (effectiveIdentityDir === this.#defaultIdentityDir) {
      fs.mkdirSync(effectiveIdentityDir, { recursive: true, mode: 0o700 });
    }

    if (this.#providerManager) {
      this.#providerManager.syncProviders(
        normalizeModelConfig(this.#liveSettings.model),
        this.#liveSettings.roles,
      );
      await this.#syncProviderImageCapabilities();
      await this.#syncProviderVoiceModels();
      void this.#broadcastVoice().catch(() => {});
    }

    await this.#reconfigureOrchestratorConversations(context);
    await this.settingsAssistant.reconfigureActiveConversation(context);
    await this.#reconfigureWorkerConversations(context);
  }

  async #pruneCompactedConversationTools(
    conversationId: ConversationId,
    firstKept: number,
    context: Context,
  ): Promise<void> {
    const conv = await this.harness.conversation(conversationId, context);
    if (!conv) return;
    const [view, state, settingsDoc, connSnap] = await Promise.all([
      conv.context(context),
      this.harness.snapshot(KuloStateDoc, context),
      this.harness.snapshot(SettingsAssistantDoc, context),
      this.connectionManager.snapshot(),
    ]);
    const retained = new Set<string>();
    // 1. Retain tools invoked in the kept recent window (`entry.id >= firstKept`)
    for (const [idx, entry] of view.entries.entries()) {
      if (Number(entry.id) < firstKept) continue;
      for (const msg of view.contributions[idx] ?? []) {
        if (msg.role === "assistant") {
          for (const part of msg.content) {
            if (part.type === "toolCall") retained.add(part.name);
          }
        } else if (msg.role === "toolResult") {
          retained.add(msg.toolName);
        }
      }
    }
    const convNum = Number(conversationId);
    // 2. Retain Settings active-module preloaded tools
    if (isActiveSettingsConversation(convNum, settingsDoc)) {
      const turnCtx = settingsDoc?.conversationId === convNum
        ? settingsDoc.turnContext
        : settingsDoc?.conversations?.[String(convNum)]?.turnContext;
      for (const name of resolveSettingsPreloadedTools(
        this.#surfaceRuntimeState("settings", {
          settingsModule: turnCtx?.module,
          settingsActive: turnCtx?.active,
        }),
      )) {
        retained.add(name);
      }
    }
    // 3. Retain tools backed by unresolved server events on this orchestrator conversation
    if (isOrchestratorConversation(conversationId, state) || isActiveSettingsConversation(convNum, settingsDoc)) {
      for (const ticket of Object.values(state?.tickets ?? {})) {
        if ((ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== convNum) continue;
        if ((state?.workerArtifacts?.[ticket.id]?.length ?? 0) > 0) {
          retained.add("kulo_inspect_asset");
          retained.add("kulo_publish_asset");
        }
        if (
          ticket.externalExecution?.stagedDiff ||
          ticket.externalExecution?.stagedCwd ||
          ticket.workspaceStaging?.stagedDiff ||
          ticket.workspaceStaging?.stagedCwd
        ) {
          retained.add("kulo_inspect_staged_diff");
          retained.add("kulo_apply_staged_changes");
        }
        if ((ticket.externalExecution?.pendingPermissions?.length ?? 0) > 0) {
          retained.add("kulo_inspect");
          retained.add("kulo_external_permission");
        }
        if (
          ticket.status === "waiting" &&
          (ticket.waiting?.reason === "coordinator" || ticket.waiting?.reason === "user")
        ) {
          if (ticket.waiting.waitToken?.startsWith("host-action")) {
            retained.add("kulo_host_action_decide");
          } else if (ticket.latestReport?.state === "blocked" || ticket.waiting.reason === "coordinator") {
            retained.add("kulo_ticket_ask_user");
          }
        }
      }
      const pendingConfirmations = await this.actionConfirmations.listPendingForConversation(convNum, context);
      for (const pending of pendingConfirmations) {
        if (pending.kind === "host_action") retained.add("kulo_host_action_decide");
        if (pending.kind === "external_permission") retained.add("kulo_external_permission");
        if (pending.kind === "ticket_decision") retained.add("kulo_ticket_ask_user");
      }
      if (
        connSnap.requests.some(
          (req) =>
            req.status === "pending" &&
            (state?.tickets[req.ticketId]?.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === convNum,
        )
      ) {
        retained.add("kulo_connection_decide");
      }
    }
    await this.harness.commit((tx) => pruneIdleDeferredToolsInTx(tx, conversationId, retained), context);
  }

  async #syncProviderImageCapabilities(): Promise<void> {
    if (!this.#providerManager) return;
    const model = this.#liveSettings.model;
    const sources: SyncedProviderImageSource[] = [
      ...(model.gatewayDisabled !== true && model.baseUrl?.trim() && model.gatewayModels?.length
        ? [{ id: KULO_GATEWAY_PROVIDER_ID, name: "Kulo Gateway", baseUrl: model.baseUrl, api: model.apiMode, models: model.gatewayModels }]
        : []),
      ...(model.customProviders ?? []).map((cp) => ({
        id: cp.id, name: cp.name, baseUrl: cp.baseUrl, api: cp.api,
        ...(cp.preset ? { preset: cp.preset } : {}), models: cp.models,
      })),
    ];
    await this.capabilities.syncProviderImageModels(sources);
  }

  async #syncProviderVoiceModels(): Promise<void> {
    if (!this.#providerManager) return;
    const model = this.#liveSettings.model;
    const sources: Array<{
      id: string;
      baseUrl: string;
      api: CustomProviderApi;
      preset?: string;
      models: CustomModelConfig[];
    }> = [
      ...(model.gatewayDisabled !== true && model.baseUrl?.trim() && model.gatewayModels?.length
        ? [{ id: KULO_GATEWAY_PROVIDER_ID, baseUrl: model.baseUrl, api: model.apiMode, models: model.gatewayModels }]
        : []),
      ...(model.customProviders ?? []).map((cp) => ({
        id: cp.id,
        baseUrl: cp.baseUrl,
        api: cp.api,
        ...(cp.preset ? { preset: cp.preset } : {}),
        models: cp.models,
      })),
    ];
    const candidates: SyncedVoiceModelCandidate[] = [];
    for (const source of sources) {
      const apiKey = await this.#providerManager.resolveProbeApiKey(source.id, source.baseUrl);
      const authenticated = Boolean(apiKey);
      for (const m of source.models) {
        const purpose = inferModelPurpose(m);
        if (purpose !== "asr" && purpose !== "tts" && purpose !== "live") continue;
        const protocolAdapter = m.protocolAdapter ?? defaultProtocolAdapterForModel(purpose, m.id, source.api, source.preset);
        candidates.push({
          purpose,
          providerId: source.id,
          modelId: m.id,
          ...(protocolAdapter ? { protocolAdapter } : {}),
          ...(source.preset ? { preset: source.preset } : {}),
          ...(m.voices?.length ? { voices: m.voices } : {}),
          authenticated,
        });
      }
    }
    await this.voice.syncProviderModels(candidates);
  }

  async #reconfigureOrchestratorConversations(context: Context): Promise<void> {
    const orchestratorAgent = this.#resolveOrchestratorAgent();
    const topicState = await this.harness.snapshot(KuloStateDoc, context);
    for (const cache of this.#topicWatchesList()) {
      const topic = topicState?.topics?.[cache.topicId];
      if (topic?.deletedAt) continue;
      const isRoot = cache.topicId === "root";
      const cwd = topic?.projectId ? (await this.projects.get(topic.projectId, context)).workspaceDir : this.#mainWorkspaceDir;
      await cache.conversation.configure(
        {
          model: orchestratorAgent.model,
          thinkingLevel: orchestratorAgent.thinkingLevel,
          extensions: this.#orchestratorExtensions(isRoot),
          tools: this.#orchestratorTools(isRoot),
          cwd,
          maxTurns: 25,
        },
        context,
      );
    }
  }

  async #syncSingleWorkerConversation(ticket: Readonly<TicketRecord>, context: Context): Promise<void> {
    if (ticket.externalExecution) return;
    const conv = await this.harness.conversation(ticket.workerConversationId as ConversationId, context);
    if (!conv) return;
    const rolePreset = this.#liveSettings.roles[ticket.role];
    const workerProviderOpt = ticket.providerOverride || rolePreset?.provider?.trim() || this.#liveSettings.model.defaultProvider;
    const workerModelId = ticket.modelOverride || rolePreset?.modelId?.trim() || this.#liveSettings.model.defaultModel;
    const desiredThinking: ThinkingEffort =
      rolePreset?.thinkingLevel && rolePreset.thinkingLevel !== "auto"
        ? rolePreset.thinkingLevel
        : this.#liveSettings.model.thinkingLevel;
    const workerAgent = resolveAgentModelAndThinking(
      this.#models,
      this.#providerId,
      workerProviderOpt,
      workerModelId,
      desiredThinking,
      this.#liveSettings.model,
    );
    const androidTargets = this.#androidTargets(ticket);
    const effectiveWorkspaceDir = getEffectiveWorkspaceDir(ticket);
    await conv.configure(
      {
        model: workerAgent.model,
        ...(rolePreset?.thinkingLevel !== "auto" ? { thinkingLevel: workerAgent.thinkingLevel } : {}),
        ...this.#workerTools({
          executionDomain: ticket.executionDomain,
          androidTargetIds: androidTargets,
          allowSubagents: Boolean(rolePreset?.allowSubagents),
          readOnly: Boolean(ticket.readOnly),
        }),
        ...(ticket.executionDomain !== "android" ? { cwd: effectiveWorkspaceDir } : {}),
      },
      context,
    );
  }

  async #syncSingleSubagentConversation(
    conv: Conversation,
    ticket: Readonly<TicketRecord>,
    sub: Readonly<SubagentRecord>,
    context: Context,
  ): Promise<void> {
    if (ticket.externalExecution) return;
    const { preset: subPreset } = resolveRolePresetFromPool(this.#liveSettings.roles, sub.role, "scout");
    const effectiveReadOnly = Boolean(ticket.readOnly || sub.readOnly);
    const subProviderOpt = subPreset?.provider?.trim() || this.#liveSettings.model.defaultProvider;
    const subModelId = subPreset?.modelId?.trim() || this.#liveSettings.model.defaultModel;
    const desiredThinking: ThinkingEffort =
      subPreset?.thinkingLevel && subPreset.thinkingLevel !== "auto"
        ? subPreset.thinkingLevel
        : this.#liveSettings.model.thinkingLevel;
    const subAgent = resolveAgentModelAndThinking(
      this.#models,
      this.#providerId,
      subProviderOpt,
      subModelId,
      desiredThinking,
      this.#liveSettings.model,
    );
    const androidTargets = this.#androidTargets(ticket);
    const effectiveWorkspaceDir = getEffectiveWorkspaceDir(ticket);
    await conv.configure(
      {
        model: subAgent.model,
        ...(subPreset?.thinkingLevel !== "auto" ? { thinkingLevel: subAgent.thinkingLevel } : {}),
        ...this.#workerTools({
          executionDomain: ticket.executionDomain,
          androidTargetIds: androidTargets,
          allowSubagents: false,
          isSubagent: true,
          readOnly: effectiveReadOnly,
        }),
        ...(ticket.executionDomain !== "android" ? { cwd: effectiveWorkspaceDir } : {}),
      },
      context,
    );
  }

  async #reconfigureWorkerConversations(context: Context): Promise<void> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    if (!state) return;
    for (const ticket of Object.values(state.tickets ?? {})) {
      if (ticket.externalExecution || ticket.status === "stopped" || ticket.status === "closed") continue;
      await this.#syncSingleWorkerConversation(ticket, context);
    }
    for (const sub of Object.values(state.subagents ?? {})) {
      const parent = state.tickets?.[sub.ticketId];
      if (!parent || parent.externalExecution || parent.status === "stopped" || parent.status === "closed" || sub.state === "stopped") continue;
      const conv = await this.harness.conversation(sub.conversationId as ConversationId, context);
      if (conv) await this.#syncSingleSubagentConversation(conv, parent, sub, context);
    }
  }

  #scheduleTicketCleanup(state: Readonly<KuloDurableState>): void {
    const pending = [...this.#ticketBoard.cleanupCandidates].some(id => !state.slots.holders.includes(id) &&
      this.envManager.getEnvDescriptor(state.tickets[id]!.envId)?.online);
    if (!pending) {
      if (this.#cleanupRetryTimer) clearTimeout(this.#cleanupRetryTimer);
      this.#cleanupRetryTimer = null;
      this.#cleanupRetryDelayMs = 500;
    } else if (!this.#cleanupRetryTimer) {
      this.#cleanupRetryTimer = setTimeout(() => {
        this.#cleanupRetryTimer = null;
        if (!this.#closed) void this.#queueEnvReconcile();
      }, this.#cleanupRetryDelayMs);
      this.#cleanupRetryTimer.unref?.();
      this.#cleanupRetryDelayMs = Math.min(this.#cleanupRetryDelayMs * 2, 10_000);
    }
  }

  #refreshTicketState(notifyFullListeners = false): void {
    if (this.#closed) return;
    const { state, delta, voiceChanges } = this.#ticketBoard.refresh(this.#liveSettings.roles, this.#liveSettings.executor.maxConcurrentWorkers,
      () => this.connectionManager.redactionRevision, text => this.connectionManager.redact(text), this.#liveSettings.externalClients);
    this.#scheduleTicketCleanup(state);
    for (const id of voiceChanges) {
      const ticket = state.tickets[id];
      if (ticket?.originTopicId && ticket.latestReport?.summary && !isSilentRecoveryFailure(state, ticket, parent => this.#ticketBoard.replacementsOf(parent))) {
        this.voiceCalls.taskUpdated(ticket.originTopicId, id, this.connectionManager.redact(ticket.latestReport.summary), ticket.status);
      }
    }
    for (const listener of this.#listeners) {
      if (delta) listener.onTicketDelta?.(structuredClone(delta), () => this.#ticketBoard.snapshot());
      if ((delta || notifyFullListeners) && listener.onTickets) {
        const { tickets, slots } = this.#ticketBoard.snapshot();
        listener.onTickets(tickets, slots);
      }
    }
  }

  async #broadcastTickets(context: Context): Promise<void> {
    context.abortSignal?.throwIfAborted();
    this.#refreshTicketState(true);
  }

  async #currentRecoveryGuard(conversationId: number | undefined, context: Context, toolTaskId?: number): Promise<WorkerRecoveryEntryData | undefined> {
    const input = await this.#currentControlInput(conversationId, context, toolTaskId);
    return input && WorkerRecoveryEntry.is(input) ? input.data : undefined;
  }

  async #currentControlInput(conversationId: number | undefined, context: Context, toolTaskId?: number): Promise<EntryRecord | undefined> {
    return (await this.#currentControlInputs(conversationId, context, toolTaskId))[0];
  }

  #touchOrchestratorBrowserSession(
    topicId: string,
    conversationId: number,
    envId: string,
    sessionId: string,
  ): void {
    const prev = this.#orchestratorBrowserSessions.get(topicId);
    if (prev) clearTimeout(prev.idleTimer);
    const idleTimer = setTimeout(() => {
      if (!this.#closed) {
        void this.#closeOrchestratorBrowserSession(topicId);
      }
    }, this.#orchestratorBrowserIdleMs);
    idleTimer.unref?.();
    this.#orchestratorBrowserSessions.set(topicId, {
      topicId,
      conversationId,
      envId,
      sessionId,
      idleTimer,
    });
  }

  #forgetOrchestratorBrowserSession(topicId: string, sessionId?: string): void {
    const existing = this.#orchestratorBrowserSessions.get(topicId);
    if (!existing) return;
    if (sessionId && existing.sessionId !== sessionId) return;
    clearTimeout(existing.idleTimer);
    this.#orchestratorBrowserSessions.delete(topicId);
  }

  async #closeOrchestratorBrowserSession(topicId: string, allowDuringClose = false): Promise<void> {
    const existing = this.#orchestratorBrowserSessions.get(topicId);
    if (!existing) return;
    clearTimeout(existing.idleTimer);
    this.#orchestratorBrowserSessions.delete(topicId);
    if ((!this.#closed || allowDuringClose) && this.envManager.getEnvDescriptor(existing.envId)?.online) {
      await this.envManager
        .requestComputerUse(existing.envId, {
          tool: "browser",
          action: "close",
          sessionId: existing.sessionId,
        })
        .catch(() => {});
    }
  }

  async #closeOrchestratorBrowserSessionsForEnv(envId: string, sendClose = true): Promise<void> {
    const matching = [...this.#orchestratorBrowserSessions.values()].filter((s) => s.envId === envId);
    for (const entry of matching) {
      clearTimeout(entry.idleTimer);
      this.#orchestratorBrowserSessions.delete(entry.topicId);
      if (sendClose && !this.#closed && this.envManager.getEnvDescriptor(envId)?.online) {
        await this.envManager
          .requestComputerUse(envId, {
            tool: "browser",
            action: "close",
            sessionId: entry.sessionId,
          })
          .catch(() => {});
      }
    }
  }

  async #resolveOrchestratorTargetEnvId(
    conversationId: number,
    toolTaskId: number | undefined,
    context: Context,
  ): Promise<{ topicId: string; envId: string; descriptor: EnvNodeDescriptor }> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const topicId = state?.conversationToTopic?.[String(conversationId)] ?? "root";
    const topic = state?.topics?.[topicId];
    if (!topic || topic.deletedAt) throw new Error("会话已删除。");

    const inputs = await this.#currentControlInputs(conversationId, context, toolTaskId);
    const message = chatRoutingData(inputs[0]);
    const namedTargets = message.text
      ? [...new Set(namedDispatchDevices(message.text, this.envManager.listEnvs()).flat())]
      : [];
    if (namedTargets.length > 1) {
      throw new ProjectError(409, "target_device_conflict", "消息中提到多台设备，请用 kulo_dispatch 明确指定执行设备。");
    }
    const explicitTarget = message.targetDeviceId || topic.targetDeviceId || namedTargets[0];
    if (message.targetDeviceId && namedTargets[0] && message.targetDeviceId !== namedTargets[0]) {
      throw new ProjectError(409, "target_device_conflict", "消息中指定的设备与会话选定的设备不同，请先确认目标设备。");
    }
    if (
      inputs.some((inp) => chatRoutingData(inp).source?.deviceId !== message.source?.deviceId) &&
      !message.targetDeviceId &&
      !topic.targetDeviceId
    ) {
      throw new ProjectError(409, "source_device_ambiguous", "本轮有来自不同设备的消息，请用 kulo_dispatch 并填写对应的 source_request_id。");
    }

    let envId: string;
    if (topic.projectId) {
      const project = await this.projects.get(topic.projectId, context);
      if (explicitTarget && explicitTarget !== project.deviceId) {
        throw new ProjectError(409, "target_device_conflict", "所选设备与当前项目绑定设备不同，请确认目标设备或使用 kulo_dispatch。");
      }
      envId = project.deviceId;
    } else {
      const sourceId = message.source?.deviceId;
      if (explicitTarget) {
        envId = explicitTarget;
      } else if (sourceId && !(this.envManager.isLocalEnv(sourceId) && !this.envManager.getEnvDescriptor(this.envManager.localEnvId))) {
        envId = sourceId;
      } else {
        envId = this.envManager.pickDefaultEnvId();
      }
    }

    const descriptor = this.envManager.getEnvDescriptor(envId);
    if (!descriptor?.online || descriptor.executionKind === "native-device") {
      throw new ProjectError(
        409,
        "browser_device_unavailable",
        "目标电脑当前不在线或不支持桌面浏览器；请连接该电脑或用 kulo_dispatch 指定其他在线电脑。",
      );
    }
    return { topicId, envId, descriptor };
  }

  async #resolveOrchestratorSkillTarget(
    conversationId: number,
    toolTaskId: number | undefined,
    context: Context,
  ): Promise<{ platform?: string; capabilities: string[] }> {
    try {
      const resolved = await this.#resolveOrchestratorTargetEnvId(
        conversationId,
        toolTaskId,
        context,
      );
      return {
        platform: resolved.descriptor.platform,
        capabilities: [...resolved.descriptor.capabilities],
      };
    } catch (error) {
      if (
        !(error instanceof ProjectError) ||
        (error.code !== "target_device_conflict" && error.code !== "source_device_ambiguous")
      ) {
        return { capabilities: [] };
      }
      // Multi-device turns cannot bind a single read-only browser session, but the
      // orchestrator still needs capability-gated Skills (e.g. desktop-automation /
      // browser-automation) to plan and dispatch work across those online computers.
      const state = await this.harness.snapshot(KuloStateDoc, context);
      const topicId = state?.conversationToTopic?.[String(conversationId)] ?? "root";
      const topic = state?.topics?.[topicId];
      if (!topic || topic.deletedAt) return { capabilities: [] };

      const envs = this.envManager.listEnvs();
      const inputs = await this.#currentControlInputs(conversationId, context, toolTaskId);
      const candidateIds = new Set<string>();
      for (const inp of inputs) {
        const routing = chatRoutingData(inp);
        if (routing.targetDeviceId) candidateIds.add(routing.targetDeviceId);
        if (routing.text) {
          for (const id of namedDispatchDevices(routing.text, envs).flat()) {
            candidateIds.add(id);
          }
        }
      }
      if (topic.targetDeviceId) candidateIds.add(topic.targetDeviceId);
      if (topic.projectId) {
        try {
          const project = await this.projects.get(topic.projectId, context);
          candidateIds.add(project.deviceId);
        } catch {
          // Ignore unavailable project bindings when collecting candidate devices.
        }
      }
      if (error.code === "source_device_ambiguous" || candidateIds.size === 0) {
        for (const inp of inputs) {
          const sourceId = chatRoutingData(inp).source?.deviceId;
          if (sourceId) candidateIds.add(sourceId);
        }
      }

      const onlineComputers = [...candidateIds]
        .map((id) => this.envManager.getEnvDescriptor(id))
        .filter((desc): desc is EnvNodeDescriptor => Boolean(desc?.online && desc.executionKind !== "native-device"));
      if (!onlineComputers.length) return { capabilities: [] };

      const capabilities = [...new Set(onlineComputers.flatMap((desc) => desc.capabilities))];
      const platforms = new Set(onlineComputers.map((desc) => desc.platform));
      return {
        ...(platforms.size === 1 ? { platform: [...platforms][0] } : {}),
        capabilities,
      };
    }
  }

  async #assertChatReadTarget(conversationId: number, toolTaskId: number, environment: string | undefined, context: Context) {
    const inputs = await this.#currentControlInputs(conversationId, context, toolTaskId);
    const message = chatRoutingData(inputs[0]);
    const envs = this.envManager.listEnvs();
    const namedTargets = message.text ? [...new Set(namedDispatchDevices(message.text, envs).flat())] : [];
    if (namedTargets.length > 1) throw new ProjectError(409, "target_device_conflict", "消息中提到多台设备，请用 kulo_dispatch 指定文件所在的设备。");
    const explicitTarget = message.targetDeviceId || namedTargets[0];
    if (message.targetDeviceId && namedTargets[0] && message.targetDeviceId !== namedTargets[0]) {
      throw new ProjectError(409, "target_device_conflict", "消息中指定的设备与会话选定的设备不同，请确认文件所在设备。");
    }
    if (environment?.startsWith("kulo-project:")) {
      if (explicitTarget) {
        const project = await this.projects.get(environment.slice("kulo-project:".length), context);
        if (project.deviceId !== explicitTarget) throw new ProjectError(409, "target_device_conflict", "所选设备与项目所在设备不同，请确认要读取哪个设备上的文件。");
      }
      return;
    }
    if (inputs.some((input) => chatRoutingData(input).source?.deviceId !== message.source?.deviceId) && !message.targetDeviceId) {
      throw new ProjectError(409, "source_device_ambiguous", "本轮有来自不同设备的消息，请用 kulo_dispatch 并填写对应的 source_request_id。");
    }
    const localEnvId = this.envManager.localEnvId;
    const envTargetId = environment === "node:local"
      ? localEnvId
      : environment?.startsWith("pi-env:")
        ? environment.slice("pi-env:".length)
        : undefined;
    let contextualTarget: string | undefined;
    if (!explicitTarget && envTargetId) {
      const priorUserTurns = await this.#recentPriorUserTurns(
        conversationId,
        context,
        toolTaskId,
        new Set(inputs.map((entry) => entry.id)),
      );
      contextualTarget = resolveNamedOrContextualEnv({
        currentText: message.text,
        priorUserTurns,
        envs,
        proposedEnvId: envTargetId,
      })?.envId;
    }
    const sourceId = message.source?.deviceId;
    const target = explicitTarget || contextualTarget || (sourceId && this.envManager.isLocalEnv(sourceId) && !this.envManager.getEnvDescriptor(localEnvId) ? undefined : sourceId);
    const expectedEnv = target && this.envManager.isLocalEnv(target) ? "node:local" : target ? `pi-env:${target}` : undefined;
    if (target && environment !== expectedEnv) {
      throw new ProjectError(409, "read_device_mismatch", "请用 kulo_dispatch 在这条消息对应的设备上读取文件。");
    }
  }

  async #recentPriorUserTurns(
    conversationId: number | undefined,
    context: Context,
    toolTaskId: number | undefined,
    excludeIds: ReadonlySet<EntryId>,
    limit = 12,
  ): Promise<PriorUserDeviceTurn[]> {
    if (conversationId === undefined) return [];
    const conversation = await this.harness.conversation(conversationId as ConversationId, context);
    if (!conversation) return [];
    let assistant: EntryId | undefined;
    if (toolTaskId !== undefined) {
      let next = toolTaskId;
      for (let depth = 0; depth < 16; depth++) {
        const task = await this.harness.commit((tx) => tx.task(next as never), context);
        const input = task?.input as { kind?: string; assistant?: number; parent?: number } | undefined;
        if (input?.kind === "model" && input.assistant !== undefined) {
          assistant = input.assistant as EntryId;
          break;
        }
        if (input?.kind !== "nested" || input.parent === undefined) break;
        next = input.parent;
      }
    }
    const entries = (await conversation.context(context, assistant === undefined ? undefined : { at: assistant })).entries;
    const turns: PriorUserDeviceTurn[] = [];
    for (const entry of [...entries].reverse()) {
      if (excludeIds.has(entry.id)) continue;
      if (!KuloUserEntry.is(entry)) continue;
      const routing = chatRoutingData(entry);
      turns.push({
        text: routing.text,
        targetDeviceId: routing.targetDeviceId || undefined,
        sourceDeviceId: routing.source?.deviceId,
      });
      if (turns.length >= limit) break;
    }
    return turns;
  }

  async #currentControlInputs(conversationId: number | undefined, context: Context, toolTaskId?: number): Promise<EntryRecord[]> {
    if (conversationId === undefined) return [];
    const conversation = await this.harness.conversation(conversationId as ConversationId, context);
    let assistant: EntryId | undefined;
    if (toolTaskId !== undefined) {
      let next = toolTaskId;
      for (let depth = 0; depth < 16; depth++) {
        const task = await this.harness.commit(tx => tx.task(next as never), context);
        const input = task?.input as { kind?: string; assistant?: number; parent?: number } | undefined;
        if (input?.kind === "model" && input.assistant !== undefined) { assistant = input.assistant as EntryId; break; }
        if (input?.kind !== "nested" || input.parent === undefined) throw new Error("无法核对主脑工具的任务上下文。");
        next = input.parent;
      }
      if (assistant === undefined) throw new Error("主脑工具嵌套层级超出上下文核对范围。");
    }
    const entries = conversation ? (await conversation.context(context, assistant === undefined ? undefined : { at: assistant })).entries : [];
    const inputs: EntryRecord[] = [];
    for (const entry of [...entries].reverse()) {
      if (inputs.length && AssistantEntry.is(entry)) break;
      if (!isRecoveryInputBoundary(entry)) continue;
      if (WorkerRelayEntry.is(entry) || WorkerRecoveryEntry.is(entry) || WorkerWatchdogEntry.is(entry)) return inputs.length ? inputs : [entry];
      inputs.push(entry);
    }
    return inputs;
  }

  async #startLegacyFailureRecovery(context: Context): Promise<void> {
    await this.harness.commit(async tx => {
      const state = await tx.doc(KuloStateDoc);
      const settingsDoc = await tx.doc(SettingsAssistantDoc);
      const now = Date.now();
      for (const ticket of Object.values(state.tickets)) if (ticket.status === "ready") resolveSupersededTickets(state, ticket, now);
      const pending = Object.values(state.tickets).filter(ticket => ticket.status === "failed" && !ticket.recovery);
      pending.sort((a, b) => a.createdAt - b.createdAt);
      for (const ticket of pending) {
        if (ticket.status !== "failed" || ticket.recovery || ticket.autoRecoverySuppressed ||
            isSettingsTopicDeleted(ticket.originTopicId, settingsDoc) ||
            state.topics?.[ticket.originTopicId ?? "root"]?.deletedAt) continue;
        const existing = recoveryLeaf(state, ticket).recovery;
        if (existing) { ticket.recovery = { ...existing }; continue; }
        const recovery = beginTicketRecovery(ticket, now);
        const seen = new Set([ticket.id]);
        const ancestors = [...seen];
        while (ancestors.length) {
          const id = ancestors.pop()!;
          for (const related of Object.values(state.tickets)) {
            if (!seen.has(related.id) && related.supersedes?.includes(id) && sameRecoveryScope(ticket, related) &&
                related.status !== "closed" && related.status !== "stopped") {
              seen.add(related.id); ancestors.push(related.id);
              if (!related.recovery && !related.autoRecoverySuppressed) related.recovery = { ...recovery };
            }
          }
        }
        await tx.createTask(this.#failureRecoveryTask, { ticketId: ticket.id, startedAt: recovery.startedAt }, {
          ownership: { kind: "conversation" }, conversationId: (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, background: true,
        });
      }
    }, context);
  }

  async #reviewTicketRecovery(ticketId: string, startedAt: number, context: Context): Promise<number | null> {
    if (this.#closed) return null;
    if (this.#recovering || this.#liveSettings.executor.paused) return Date.now() + 30_000;
    const snapshot = await this.harness.snapshot(KuloStateDoc, context);
    const settingsSnapshot = await this.harness.snapshot(SettingsAssistantDoc, context);
    const root = snapshot?.tickets[ticketId];
    if (!root?.recovery || root.recovery.startedAt !== startedAt ||
        ["closed", "stopped", "ready"].includes(root.status) ||
        isSettingsTopicDeleted(root.originTopicId, settingsSnapshot) ||
        snapshot?.topics?.[root.originTopicId ?? "root"]?.deletedAt) return null;
    const origin = (await this.harness.conversation((root.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, context)) ?? this.rootConversation;
    let nextAt: number | null = Date.now() + 30_000;
    await origin.commit(async tx => {
      const state = await tx.doc(KuloStateDoc);
      const current = state.tickets[ticketId];
      const recovery = current?.recovery;
      if (!current || !recovery || recovery.startedAt !== startedAt || ["closed", "stopped", "ready"].includes(current.status)) { nextAt = null; return; }
      const target = recoveryLeaf(state, current);
      const now = Date.now();
      if (target.status === "ready") {
        resolveSupersededTickets(state, target, now);
        nextAt = null;
        return;
      }
      if (
        target.status === "blocked" ||
        (target.status === "waiting" &&
          (target.waiting?.reason === "user" || target.waiting?.reason === "coordinator"))
      ) {
        // The Worker's blocker relay already handed this decision to the coordinator/user.
        recovery.state = "exhausted";
        recovery.notifiedAt ??= target.latestReport?.at ?? now;
        recovery.nextAttemptAt = undefined;
        nextAt = null;
      } else if (target.status === "running" || target.status === "pausing") {
        return;
      } else if (now >= recovery.deadlineAt) {
        recovery.state = "exhausted";
        recovery.nextAttemptAt = undefined;
        nextAt = null;
        if (recovery.notifiedAt) return;
        const failed = target.status === "failed";
        const reportTicket = failed ? target : current;
        const summary = failed ? target.latestReport?.summary ?? "自动恢复未能完成任务。" : recoveryWaitSummary(target);
        await submitAutomaticChatInput(tx, origin, {
          type: "input", whenBusy: "followUp", requestId: `kulo:recovery-exhausted:${ticketId}:${startedAt}`,
          content: formatRecoveryExhaustedRelayMessage({
            title: reportTicket.title,
            summary,
            ...(!failed ? { replacementStatus: target.status } : {}),
          }),
          entry: { kind: WorkerRelayEntry.kind, data: { ticketId: reportTicket.id, title: reportTicket.title, role: reportTicket.role,
            state: "failed", summary, deliverable: null, question: null } },
        });
        recovery.notifiedAt = now;
      } else if (target.status !== "failed") {
        nextAt = Math.min(now + 30_000, recovery.deadlineAt);
        return;
      } else {
        if (recovery.attempts >= MAX_RECOVERY_ATTEMPTS) { nextAt = recovery.deadlineAt; return; }
        if (recovery.nextAttemptAt !== undefined && now < recovery.nextAttemptAt) { nextAt = Math.min(recovery.nextAttemptAt, recovery.deadlineAt); return; }
        recovery.attempts++;
        recovery.nextAttemptAt = Math.min(now + RECOVERY_REVIEW_INTERVAL_MS, recovery.deadlineAt);
        const guard: WorkerRecoveryEntryData = { ticketId: target.id, rootTicketId: ticketId,
          startedAt, attempt: recovery.attempts, runEpoch: target.runEpoch };
        const topicTargetDeviceId = state.topics?.[target.originTopicId ?? "root"]?.targetDeviceId;
        await injectEventToolsInTx(tx, origin.id, ["kulo_inspect"]);
        await submitAutomaticChatInput(tx, origin, {
          type: "input", whenBusy: "followUp", requestId: `kulo:recovery:${ticketId}:${startedAt}:${recovery.attempts}`,
          content: formatWorkerRecoveryMessage({
            ticketId: target.id,
            title: target.title,
            summary: target.latestReport?.summary ?? "execution incomplete",
            attempt: recovery.attempts,
            maxAttempts: MAX_RECOVERY_ATTEMPTS,
            deviceLocked: !canSwitchEnvDuringRecovery(target, topicTargetDeviceId),
            envId: target.envId,
          }),
          entry: { kind: WorkerRecoveryEntry.kind, data: guard },
        });
        nextAt = recovery.nextAttemptAt;
      }
      current.updatedAt = now;
      for (const related of Object.values(state.tickets)) {
        if (related.id !== current.id && related.recovery?.rootTicketId === ticketId && related.recovery.startedAt === startedAt) {
          related.recovery = { ...recovery };
          related.updatedAt = now;
        }
      }
    }, context);
    await this.#broadcastTickets(context);
    return nextAt;
  }

  #startWatchdog(): void {
    if (this.#watchdogTimer || this.#closed) return;
    this.#watchdogTimer = setInterval(() => {
      if (this.#handoverBarrierActive) return;
      void this.#runWatchdogCheck();
    }, this.#watchdogCheckIntervalMs);
    this.#watchdogTimer.unref?.();
  }

  #startTopicAutoArchive(): void {
    if (this.#topicAutoArchiveTimer || this.#closed) return;
    this.#topicAutoArchiveTimer = setInterval(() => {
      if (this.#handoverBarrierActive) return;
      void this.archiveInactiveTopics().catch((error) => {
        console.warn("[KuloTopicArchive] Automatic archive check failed", error);
      });
    }, 60_000);
    this.#topicAutoArchiveTimer.unref?.();
  }

  #startUploadCleanup(): void {
    if (this.#uploadCleanupTimer || this.#closed) return;
    this.#uploadCleanupTimer = setInterval(() => {
      if (this.#closed) return;
      try {
        this.uploads.cleanupIncompleteUploads();
        this.uploads.cleanupDrafts();
      } catch (error) {
        console.warn("[KuloUploads] Periodic upload cleanup failed", error);
      }
    }, 60 * 60_000);
    this.#uploadCleanupTimer.unref?.();
  }

  async #trackWorkerRunning(
    ticketId: string,
    workerConversationId: number,
    runEpoch: number,
  ): Promise<void> {
    if (this.#closed) return;
    const ticket = (await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets[ticketId];
    if (this.#closed || !ticket || ticket.runEpoch !== runEpoch || ticket.status !== "running") return;
    if (ticket.externalExecution) {
      this.#trackedWorkers.get(ticketId)?.detachObserver?.();
      this.#trackedWorkers.delete(ticketId);
      return;
    }
    const prev = this.#trackedWorkers.get(ticketId);
    if (
      prev &&
      prev.runEpoch === runEpoch &&
      prev.workerConversationId === workerConversationId
    ) {
      prev.lastActivityAt = Date.now();
      return;
    }
    if (prev) {
      prev.detachObserver?.();
      this.#trackedWorkers.delete(ticketId);
    }

    const rec: TrackedWorkerRuntime = {
      ticketId,
      workerConversationId,
      runEpoch,
      lastActivityAt: Date.now(),
    };
    this.#trackedWorkers.set(ticketId, rec);

    void this.harness
      .observeConversation(
        workerConversationId as ConversationId,
        {
          advance: () => {
            rec.lastActivityAt = Date.now();
          },
          end: () => {},
        },
        BACKGROUND_CONTEXT,
        { min: 1, max: 1 },
      )
      .then((obs) => {
        if (this.#closed || this.#trackedWorkers.get(ticketId) !== rec) {
          obs.detach();
          return;
        }
        rec.detachObserver = () => obs.detach();
      })
      .catch(() => {
        // Conversation might already be gone or harness closing
      });
  }

  #untrackWorker(ticketId: string, throughEpoch?: number): void {
    const prev = this.#trackedWorkers.get(ticketId);
    if (prev && throughEpoch !== undefined && prev.runEpoch > throughEpoch) return;
    void this.connectionManager.revoke(ticketId);
    if (prev) {
      prev.detachObserver?.();
      this.#trackedWorkers.delete(ticketId);
    }
  }

  async #runWatchdogCheck(): Promise<void> {
    if (this.#closed || this.#watchdogTickInFlight) return;
    const watchdogMinutes = this.#liveSettings.executor.watchdogMinutes ?? 0;
    if (watchdogMinutes <= 0 && this.#watchdogStallMsOverride === undefined) {
      return;
    }

    this.#watchdogTickInFlight = true;
    try {
      const stallMs =
        this.#watchdogStallMsOverride ?? Math.max(1, watchdogMinutes) * 60_000;
      const longRunMs = Math.max(stallMs * 3, 15 * 60_000);
      const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      if (!state || this.#closed) return;

      const now = Date.now();
      for (const id of [...this.#trackedWorkers.keys()]) {
        const ticket = state.tickets[id];
        if (!ticket || ticket.status !== "running") {
          this.#untrackWorker(id);
        }
      }

      for (const ticket of Object.values(state.tickets)) {
        if (ticket.status !== "running") continue;
        if (ticket.externalExecution && (ticket.externalExecution.pendingPermissions?.length ?? 0) > 0) continue;

        let tracked: TrackedWorkerRuntime | undefined;
        if (!ticket.externalExecution) {
          tracked = this.#trackedWorkers.get(ticket.id);
          if (!tracked || tracked.runEpoch !== ticket.runEpoch) {
            await this.#trackWorkerRunning(
              ticket.id,
              ticket.workerConversationId,
              ticket.runEpoch,
            );
            tracked = this.#trackedWorkers.get(ticket.id);
          }
        }

        const startedAt =
          ticket.startedRunningAt ?? ticket.updatedAt ?? ticket.createdAt;
        const lastActivityAt = Math.max(
          ticket.externalExecution ? (ticket.externalExecution.lastActivityAt ?? 0) : (tracked?.lastActivityAt ?? 0),
          startedAt,
          ticket.latestReport?.at ?? 0,
        );
        const idleMs = Math.max(0, now - lastActivityAt);
        const runningMs = Math.max(0, now - startedAt);

        let reason: "stalled" | "long_running" | null = null;
        let cooldownMs = stallMs;
        if (idleMs >= stallMs) {
          reason = "stalled";
          cooldownMs = stallMs;
        } else if (runningMs >= longRunMs) {
          reason = "long_running";
          cooldownMs = longRunMs;
        }
        if (!reason) continue;

        const dedupKey = `${ticket.id}:${ticket.runEpoch}:${reason}`;
        const lastAlert = this.#lastWatchdogAlertAt.get(dedupKey) ?? 0;
        if (now - lastAlert < cooldownMs) continue;

        this.#lastWatchdogAlertAt.set(dedupKey, now);

        const idleSec = Math.round(idleMs / 1000);
        const runningSec = Math.round(runningMs / 1000);
        const originConvId = (ticket.originConversationId ??
          Number(ROOT_CONVERSATION_ID)) as ConversationId;
        const originConv =
          (await this.harness.conversation(originConvId, BACKGROUND_CONTEXT)) ??
          this.rootConversation;

        const watchdogPrompt = formatWorkerWatchdogMessage({
          ticketId: ticket.id,
          title: ticket.title,
          role: ticket.role,
          ...(ticket.externalExecution ? { externalKind: ticket.externalExecution.binding.kind } : {}),
          reason,
          idleSec,
          runningSec,
        });

        await this.harness.commit(async (tx) => {
          await injectEventToolsInTx(tx, originConv.id, ["kulo_inspect"]);
          await submitAutomaticChatInput(tx, originConv, {
            type: "input",
            content: watchdogPrompt,
            whenBusy: "followUp",
            requestId: `kulo:watchdog:${ticket.id}:${ticket.runEpoch}:${reason}:${now}`,
            entry: {
              kind: WorkerWatchdogEntry.kind,
              data: {
                ticketId: ticket.id,
                title: ticket.title,
                role: ticket.role,
                reason,
                idleSec,
                runningSec,
                runEpoch: ticket.runEpoch,
              },
            },
          });
        }, BACKGROUND_CONTEXT);
      }
    } catch {
      // Best-effort periodic watchdog check
    } finally {
      this.#watchdogTickInFlight = false;
    }
  }

  #enrichTopicsWithPreviews(topics: TopicSummary[]): TopicSummary[] {
    return topics.map((topic) => {
      const cached = this.#topicPreviewCache.get(topic.id);
      if (!cached) return topic;
      if (topic.lastMessagePreview && (topic.lastMessageAt ?? 0) >= (cached.at ?? 0)) return topic;
      return {
        ...topic,
        lastMessagePreview: cached.preview,
        ...(cached.at ? { lastMessageAt: cached.at } : {}),
      };
    });
  }

  #emitTopics(topics: TopicSummary[]): void {
    const enriched = this.#enrichTopicsWithPreviews(topics);
    this.#topicTitleCache.clear();
    for (const topic of enriched) {
      if (!topic.deletedAt && topic.title) this.#topicTitleCache.set(topic.id, topic.title);
    }
    for (const listener of this.#listeners) {
      listener.onTopics?.(enriched);
    }
  }

  #emitAssistantItems(assistantRevision: number, items: AssistantItemView[]): void {
    for (const listener of this.#listeners) {
      listener.onAssistantItems?.(assistantRevision, items);
    }
  }

  #emitEnvs(envs: EnvNodeDescriptor[]): void {
    for (const listener of this.#listeners) {
      listener.onEnvs?.(envs);
    }
  }

  #emitSettings(settings: KuloSettingsView): void {
    for (const listener of this.#listeners) {
      listener.onSettings?.(settings);
    }
  }
}
