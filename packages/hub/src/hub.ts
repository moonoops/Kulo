import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chatRoutingData, type ChatMessageSource } from "./chat-submissions.js";
import { observeChatAttachmentGrants } from "./chat-attachment-deliveries.js";
import { submitAutomaticChatInput } from "./chat-control.js";
import { DeliveryReceiptDoc, clientDeliveryIntent, deliveryReceiptKey, validateReliableClientMessage,
  type DeliveryAck, type DeliveryIntent, type DeliveryReceipt, type ReliableClientMessage } from "./delivery-receipts.js";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import type { Credential, CredentialStore, Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  Harness,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  UserEntry,
  createRegistry,
  defineExtension,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryRecord,
  type EntryId,
  type JsonObject,
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
import { EnvManager, canonicalExecutionPath } from "@kulo/env";
import { lazyProjectEnvironment } from "./project-env.js";
import { createAndroidToolsExtension, type AndroidToolScope } from "./tools-android.js";
import { createComputerMixedAndroidTierExtension, createReadOnlyAndroidTierExtension } from "./android-tool-tier.js";
import { resolveAndroidToolAssets } from "./android-delivery.js";
import { KuloAndroidNotifications } from "./android-notifications.js";
import { appendTicketOutwardAction, createFailureRecoveryTask, isSilentRecoveryFailure } from "./task-recovery.js";
import { ExternalTelemetryCache, type ExternalTicketTelemetry } from "./scheduler-external-settle.js";
import { prepareStateStorage } from "./state-storage.js";
import { HubStateOwner } from "./state-owner.js";
import { KuloConnections } from "./connections.js";
import { LocalConnectionVault } from "./connection-vault.js";
import { SecureCredentialStore } from "./secure-provider-credentials.js";
import { createCredentialRedactionExtension, redactCredentialData, scrubStoredConversationSecrets, wrapRedactedStorage } from "./credential-redaction.js";
import { HubContextGuard } from "./context-guard.js";
import type { ConnectionToolController } from "./tools-connections.js";
import { KuloSkills } from "./skills.js";
import { KuloCapabilities, type SyncedProviderImageSource } from "./capabilities.js";
import { KuloSearch } from "./search.js";
import { modelFetch, retainEnvironmentProxy } from "./http-transport.js";
import { withNativeToolsModels } from "./model-native-tools.js";
import { LocalVoiceAsr } from "./voice-asr.js";
import { KuloVoiceService, VoiceError, type SyncedVoiceModelCandidate, type VoiceAsrEngine } from "./voice-service.js";
import { KuloVoiceCalls, type KuloVoiceCallsOptions, type VoiceCallSummaryInput } from "./voice-calls.js";
import { TicketBoardProjection } from "./ticket-board.js";
import {
  persistVoiceCallSummary,
  persistVoiceTranscript,
  readVoiceCallTranscriptTurns,
  resolveBoundVoiceConversation,
  type ResolvedVoiceConversation,
} from "./voice-call-summary.js";
import { createVoiceContext } from "./voice-context.js";
import { createVoiceToolsExtension } from "./tools-voice.js";
import { KuloMediaJobs } from "./media-jobs.js";
import { createSkillToolsExtension } from "./tools-skills.js";
import { detectReactWorkspace, SkillRuntimeError } from "./skill-runtime.js";
import { FileError } from "@earendil-works/pi-durable/env";
import { createCapabilitySetupExtension } from "./tools-capability-setup.js";
import { createMediaToolsExtension } from "./tools-media.js";
import { createMediaExportExtension } from "./tools-media-export.js";
import { createMemoryLifecycleExtension } from "./memory-lifecycle.js";
import { executeMemoryForget, validateRelationshipReviewDecision } from "./memory-forget.js";
import { KuloUsageCaps, withUsageMeterModels } from "./usage-caps.js";
import { HindsightLocalService } from "./hindsight-service.js";
import { MemoryLlmBridge } from "./memory-llm-bridge.js";
import { KuloMemoryService, MemoryServiceDoc, createMemoryServiceExtension } from "./memory-service.js";
import { createMemorySetupExtension } from "./tools-memory-setup.js";
import { KuloExtensions, createExtensionsExtension, type ExtensionPackageExecutor } from "./extensions.js";
import { createExtensionSetupExtension } from "./tools-extensions.js";
import { KuloConversationHistory } from "./conversation-history.js";
import { deriveConnectedExternalClients, type BuiltinMemoryStateView, type ConversationSearchInput, type MainSessionNotificationEvent, type MemoryServiceJob, type TicketResumeOverrideRequest, type TicketResumeOverrideResponse } from "@kulo/protocol";
import { ExternalAgentQuotaService } from "./external-agent-quotas.js";
import { topicActivity } from "./topic-activity.js";
import { KuloSubagentRunner } from "./subagent-runner.js";
import { formatTaskBoardWorkerContext, readTaskBoard, searchTaskBoards, writeTaskBoardInTx } from "./task-boards.js";
import { collectReviewPackAssets, formatReviewPromptSection, writeReviewPackToScratchEnv } from "./ticket-review-pack.js";
import { createHistoryToolsExtension } from "./tools-history.js";
import { AssistantDoc, ensureAssistantState, muteAssistantAppInDoc, selectActiveAssistantItems } from "./assistant-state.js";
import { AssistantLedger } from "./assistant-ledger.js";
import { AmbientModelService } from "./ambient-model-service.js";
import type { AssistantSorter } from "./assistant-sorter.js";
import { AssistantEchoSuppressor } from "./assistant-echo.js";
import type { AssistantCoordinator } from "./assistant-coordinator.js";
import type { AssistantProactiveWakeService } from "./assistant-proactive-wake.js";
import { createHubAssistantRuntime } from "./assistant-wiring.js";
import { createAssistantToolsExtension, type AssistantWatchRuleHost } from "./tools-assistant.js";
import { LocalConfigMigrationService, createMigrationToolsExtension } from "./tools-migration.js";
import { SparkMailService } from "./connectors/spark-mail-service.js";
import { HomeAssistantService } from "./connectors/home-assistant.js";
import { isPrivateLocalModelEndpoint } from "./local-model-endpoint.js";
import { HaLanAudioRelay } from "./connectors/ha-lan-audio.js";
import { LarkConnectorService } from "./connectors/lark-connector.js";
import { ContextCompactionDoc, createContextCompactionController, validateBillionKernel, type BillionKernelRuntime } from "./context-compaction.js";
import { HubMemoryRuntime } from "./hub-memory-runtime.js";
import { EMPTY_MEDIA_CAPABILITIES, createConversationContextWindowResolver } from "./orchestrator-prompt-wiring.js";
import { createOrchestratorToolOverflowExtension } from "./orchestrator-tool-overflow.js";
import { createRunHealthController } from "./run-health-extension.js";
import { ORCHESTRATOR_MAX_TURNS, PROACTIVE_WAKE_MAX_TURNS, SUBAGENT_MAX_TURNS, WORKER_MAX_TURNS } from "./run-health-policy.js";
import { createRecentWorkSyncHook, isSystemBaselinePending } from "./recent-work-sync.js";
import { type LoadedBillionContextPackage } from "./extension-packages.js";
import { stageProjectSkillSource } from "./skill-source-env.js";
import {
  DEFAULT_IMAGE_TEST_PROMPT,
  defaultProtocolAdapterForModel,
  inferModelPurpose,
  resolveRolePresetFromPool,
  isSupportedExternalAgentKind,
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
  type CustomModelConfig,
  type CustomProviderApi,
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
  type SettingsBlockName,
  type SettingsAssistantSnapshot,
  type SlotSummary,
  type SubagentRecord,
  type ThinkingEffort,
  type BuiltinThinkingEffort,
  type TicketCardView,
  type TicketBoardDelta,
  type ExternalAgentPendingReport,
  type TicketRecord,
  type TopicSummary,
  type UsageStatsView,
  type WorkerInspectResult,
  type ComputerPreviewSessionView,
  type ComputerPreviewInputEvent,
  type ComputerPreviewUpdate,
  type ArchiveMainConversationInput,
  type ArchiveMainConversationResult,
  type VoiceCallTranscriptTurn,
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
import { buildRecentWorkSnapshot } from "./recent-work.js";
import {
  SettingsAssistant,
  SettingsAssistantDoc,
  createSettingsAssistantExtension,
  isActiveSettingsConversation,
  parseSettingsTopicConversationId,
  settingsTopicId,
} from "./settings-assistant.js";
import { createGlobalSettingsToolsExtension } from "./tools-global-settings.js";
import {
  assertUniqueExtensionTools,
  createSettingsTierExtension,
  injectEventToolsInTx,
  resolveDeferredAddTools,
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
import { externalClientConnectionId, type AgentConfigurationDraft, type StagedWorkspaceApplyResult, type StagedWorkspaceDiffDetail, type StagedWorkspaceDiffSummary } from "@kulo/protocol";
import { evaluateTicketAgentBlock } from "./agent-routing.js";
import { createAppearanceCustomizationToolsExtension } from "./tools-appearance-customization.js";
import { createCustomizationToolsExtension } from "./tools-customization.js";
import { createDesktopCustomizationService } from "./customization-host.js";
import type { CustomizationCaller, KuloCustomizationService } from "./customization.js";
import {
  KuloActionConfirmations,
  buildCustomizationConfirmCard,
  buildExternalPermissionCard,
  buildMemoryServiceConfirmCard,
  buildTicketDecisionCard,
  customizationValidateFingerprint,
  externalPermissionFingerprint,
  memoryServiceOperationFingerprint,
  resolveCardConfirmationDeniedInTx,
  ticketDecisionFingerprint,
} from "./action-confirmations.js";
import {
  admitTicketStopInTx,
  canDirectStopTicket,
  finalizeTicketStop,
  resolveDirectStopCardTarget,
  type AdmittedTicketStop,
} from "./ticket-stop.js";
import {
  extractDisplayMessages,
  extractLiveState,
} from "./hub-display-projection.js";
import { HubMessageProjection } from "./hub-message-projection.js";
export { extractDisplayMessages, extractLiveState };
import { MainConversationArchiveService } from "./main-conversation-archive.js";
import { SideQuestionService } from "./side-questions.js";
import { RelationshipReviewsDoc, collectRelationshipInput } from "./relationship-evidence.js";
import { computeHubUsageStats } from "./hub-usage-stats.js";
import { migrateLegacyLocalReferences } from "./cluster-migration.js";
import {
  clearFailoverTrustGuard, hasFailoverTrustGuard,
  InlineDispatchWaiters,
  LiveSettingsStore,
  TurnContextReader,
  type HubRuntimeGates,
} from "./hub-kernel-ports.js";
import {
  abortActiveOrchestratorConversationsBeforeResume,
  applyTicketRestartDecision,
  evaluateTicketRestartAutoResume,
  inspectBuiltInTicketsForRestartGate,
  preAbortFencedWorkerTasks,
  recordBootStart,
  recordGracefulShutdown,
  resolveBootGateLocalNodeId,
  type BootGateStartResult,
} from "./restart-gate.js";
import { HubChatPipeline, type MessageSubmissionOptions } from "./hub-chat-pipeline.js";
import { HubComputerController } from "./hub-computer-controller.js";
import { HubConnectionsBridge } from "./hub-connections-bridge.js";
import { HubDeliveryCoordinator } from "./hub-delivery-coordinator.js";
import { HubHostActions, buildHostActionResultDraft } from "./hub-host-actions.js";
import { HubMediaDelivery, MediaNoticesDoc } from "./hub-media-delivery.js";
import { HubTopicManager, type TopicView, type WatchedTopicCache } from "./hub-topic-manager.js";
import { ExternalClientAdminService } from "./external-client-admin.js";
import { HubFailureRecovery, HubWatchdog } from "./hub-watchdog.js";
import { TicketControlService } from "./ticket-control-service.js";
import { TicketDispatchService } from "./ticket-dispatch-service.js";
import { TicketExternalRuntime } from "./ticket-external-runtime.js";
import { TicketInspectionService } from "./ticket-inspection.js";
import { TicketReconciler } from "./ticket-reconciler.js";
import { resolveWorkerEffectiveModel } from "./ticket-model-arbiter.js";
import { TicketQuotaResumeService } from "./ticket-quota-pause.js";
import { TicketStagedApplyService } from "./ticket-staged-apply.js";
import { createOrchestratorCodingGuardExtension } from "./orchestrator-coding-guard.js";
import { selectOrchestratorDefaultEnv } from "./orchestrator-env-cwd.js";
import type { HostActionController } from "./tools-host-action.js";
import type { AskUserForTicketParams } from "./tools-router.js";
import { API_KEY_ORIGIN_ENV } from "./providers.js";
import { probeHindsightConnection, resolveHindsightToken, resolveHindsightSharedReadToken } from "./hindsight.js";
import {
  KULO_GATEWAY_PROVIDER_ID,
  KULO_PROVIDER_ID,
  resolveModelThinkingSelection,
  withThinkingLevelModels,
  probeOpenAICompatibleGateway,
} from "./models.js";
import { KuloProviderManager, serializeProviderCatalogItem } from "./providers.js";
import {
  DEFAULT_COMPACTION_FOCUS_INSTRUCTIONS,
  RELATIONSHIP_REVIEW_INSTRUCTIONS,
  createOrchestratorSections,
} from "./prompts.js";
import { createWorkerTicketTask } from "./scheduler.js";
import { androidTargetsOf, areTicketDevicesOnline } from "./ticket-dispatch.js";
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
  ensureDefaultRootTopic,
  isActiveRootConversation,
  isOrchestratorConversation,
  resolveActiveRootConversationId,
  getActiveStagedCwd,
  getEffectiveWorkspaceDir,
  isTicketUnfinished,
  resolveTicketExecutionScope,
  transitionTicketStatus,
  summarizeTopicPreview,
  type KuloDurableState,
} from "./state.js";
import {
  createOrchestratorToolsExtension,
  type ApplyStagedChangesParams,
  type CloseTicketParams,
  type DispatchTicketModelOutcome,
  type BoardToolParams,
  type DispatchTicketParams,
  type OrchestratorController,
  type SteerTicketParams,
} from "./tools-router.js";
import {
  createWorkerExtension,
  type RunSubagentsRequest,
  type SubagentTaskOutcome,
} from "./tools-worker.js";
import type { createComputerUseExtension } from "./tools-computer-use.js";
import { KuloUploadStore } from "./uploads.js";
import { ContentPublicationEntry, KuloUserEntry, KuloUiCards, UiCardError, type ContentPublicationData } from "./ui-cards.js";
import { createContentToolsExtension } from "./tools-content.js";
import { createAssetPublisher } from "./asset-publication.js";
import { createDiagramPublisher } from "./diagram-publication.js";
import { KuloProjects, KuloProjectsDoc, ProjectError } from "./projects.js";
import { createProjectToolsExtension, type ProjectController } from "./tools-projects.js";
import {
  inspectChatReadTarget,
  preflightOrchestratorTargetEnv,
  reconcileTopicRoutingTarget,
  resolveOrchestratorCatalogSkillTarget,
  resolveOrchestratorConflictSkillTarget,
  resolveOrchestratorTargetEnv,
  resolvePriorContextualComputerId,
  verifyChatReadTargetEnv,
  type ChatRoutingSignals,
  type PriorUserDeviceTurn,
} from "./env-routing-policy.js";

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

export interface KuloHubInitOptions {
  voiceAsr?: VoiceAsrEngine;
  voiceOpenLive?: KuloVoiceCallsOptions["openLive"];
  migrationHomeDir?: string;
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
  onBuiltinMemory?: (state: BuiltinMemoryStateView) => void;
  onTopicView?: (topicId: string, messages: ChatDisplayItem[], live: LiveStreamState, conversationId?: number) => void;
  onRootView?: (messages: ChatDisplayItem[], live: LiveStreamState) => void;
  onTopics?: (topics: TopicSummary[]) => void;
  onProjects?: (projects: ProjectView[]) => void;
  onTickets?: (tickets: TicketCardView[], slots: SlotSummary) => void;
  onTicketDelta?: (delta: TicketBoardDelta, snapshot: () => ReturnType<TicketBoardProjection["snapshot"]>) => void;
  onTicketTelemetry?: (telemetry: ExternalTicketTelemetry) => void;
  onAssistantItems?: (assistantRevision: number, items: AssistantItemView[]) => void;
  onEnvs?: (envs: EnvNodeDescriptor[]) => void;
  onExpression?: (expression: AgentExpressionState | null) => void;
  onSettings?: (settings: KuloSettingsView) => void;
  onSettingsAssistant?: (snapshot: SettingsAssistantSnapshot) => void;
  onUiCard?: (card: UiCardSnapshot) => void;
  onNotification?: (event: MainSessionNotificationEvent) => void;
}

/**
 * KuloHub: Durable SuperAgent Engine combining Pi Durable (SQLite) + Pi Env + Identity Documents + Hindsight.
 */
export class KuloHub implements OrchestratorController {
  readonly #ticketBoard = new TicketBoardProjection();
  readonly #externalTelemetry = new ExternalTelemetryCache();
  readonly config: KuloHubConfig;
  readonly envManager: EnvManager;
  readonly harness: Harness;
  #activeRootConversation: Conversation;
  get rootConversation(): Conversation { return this.#activeRootConversation; }
  readonly identityFiles: KuloIdentityFiles;
  readonly personality: KuloPersonality;
  readonly uploads: KuloUploadStore;
  readonly settingsAssistant: SettingsAssistant;
  readonly sideQuestions: SideQuestionService;
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
  readonly assistantProactiveWake: AssistantProactiveWakeService;
  readonly assistantWatchRules: AssistantWatchRuleHost;
  readonly assistantSorter: AssistantSorter;
  readonly assistantCoordinator: AssistantCoordinator;
  readonly sparkMail: SparkMailService;
  readonly haLanAudio: HaLanAudioRelay;
  readonly homeAssistant: HomeAssistantService;
  readonly larkConnector: LarkConnectorService;
  #lanHttpEndpointProvider?: () => { lanReachable: boolean; port: number } | undefined;
  readonly connectionManager: KuloConnections;
  readonly connections: ConnectionToolController;
  readonly migration: LocalConfigMigrationService;

  readonly #providerId: string;
  readonly #models: Models;
  readonly #releaseProxy: () => Promise<void>;
  readonly #stateOwner: HubStateOwner;
  get localInstance(): Pick<HubStateOwner, "publish" | "proveLocalIdentity"> { return this.#stateOwner; }
  get bootGate(): Readonly<BootGateStartResult & { bootWasFailover: boolean }> {
    return { ...this.#bootGate, bootWasFailover: this.#bootWasFailover };
  }
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
  readonly #readOnlyAndroidTierExt: ReturnType<typeof createReadOnlyAndroidTierExtension>;
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
  readonly #toolOverflowExt: ReturnType<typeof createOrchestratorToolOverflowExtension>;
  readonly #runHealth: ReturnType<typeof createRunHealthController>;
  readonly memoryRuntime: HubMemoryRuntime;
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
  readonly #contextPreferenceUpdates = new Set<Promise<void>>();
  readonly #subagentRunner: KuloSubagentRunner;
  readonly #listeners = new Set<HubEventListener>();
  readonly #topics: HubTopicManager;
  readonly #mainArchive: MainConversationArchiveService;
  readonly #contextGuard: HubContextGuard;
  readonly #chat: HubChatPipeline;
  readonly #connectionsBridge: HubConnectionsBridge;
  readonly #hostActions: HubHostActions;
  readonly #stagedApply: TicketStagedApplyService;
  readonly #ticketReconciler: TicketReconciler;
  readonly #ticketControl: TicketControlService;
  readonly #ticketQuotaResume: TicketQuotaResumeService;
  readonly #mediaDelivery: HubMediaDelivery;
  readonly #delivery: HubDeliveryCoordinator;
  readonly #inlineWaiters = new InlineDispatchWaiters();
  readonly #turnContext: TurnContextReader;
  readonly #runtimeGates: HubRuntimeGates;
  readonly #projection: HubMessageProjection;
  readonly #watchdog: HubWatchdog;
  readonly #failureRecovery: HubFailureRecovery;
  readonly #computer: HubComputerController;
  readonly #ticketDispatch: TicketDispatchService;
  readonly #externalClientAdmin: ExternalClientAdminService;
  readonly #externalRuntime: TicketExternalRuntime;
  readonly #ticketInspection: TicketInspectionService;
  readonly deviceJoinStaging: DeviceJoinStaging;
  readonly assistantEchoSuppressor = new AssistantEchoSuppressor();
  #deviceController: HubDeviceController | undefined;

  #uploadCleanupTimer: ReturnType<typeof setInterval> | null = null;
  #cleanupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #cleanupRetryDelayMs = 500;
  readonly #settingsStore: LiveSettingsStore;
  readonly #bootGate: BootGateStartResult;
  readonly #bootWasFailover: boolean;
  #bootCompleted = false;
  #recovering = true;
  #acceptingNewWork = true;
  #closed = false;
  #closing?: Promise<void>;
  #androidHubId = "";
  #onClusterDirty?: (kind: "sqlite" | "assistant" | "memory" | "vault" | "files" | "uploads", options?: { immediate?: boolean }) => void;
  #hasRemoteStandbys?: () => boolean;
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
    settingsStore: LiveSettingsStore;
    workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
    failureRecoveryTask: ReturnType<typeof createFailureRecoveryTask>;
    codingToolsExt: ReturnType<typeof createCodingTools>;
    androidExt: ReturnType<typeof createAndroidToolsExtension>;
    toolSearchExt: ReturnType<typeof createToolSearchExtension>;
    settingsTierExt: ReturnType<typeof createSettingsTierExtension>;
    computerMixedAndroidTierExt: ReturnType<typeof createComputerMixedAndroidTierExtension>;
    readOnlyAndroidTierExt: ReturnType<typeof createReadOnlyAndroidTierExtension>;
    orchestratorGuardExt: ReturnType<typeof defineExtension>;
    computerController: HubComputerController;
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
    migrationToolsExt: ReturnType<typeof createMigrationToolsExtension>; migrationHomeDir?: string;
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
    toolOverflowExt: ReturnType<typeof createOrchestratorToolOverflowExtension>;
    runHealth: ReturnType<typeof createRunHealthController>;
    memoryRuntime: HubMemoryRuntime;
    credentialStore: CredentialStore;
    voiceAsr?: VoiceAsrEngine;
    voiceOpenLive?: KuloVoiceCallsOptions["openLive"];
    watchdogCheckIntervalMs: number;
    watchdogStallMsOverride?: number;
    bootGate: BootGateStartResult;
    bootWasFailover: boolean;
  }) {
    this.#releaseProxy = params.releaseProxy;
    this.#stateOwner = params.stateOwner;
    this.#bootGate = params.bootGate;
    this.#bootWasFailover = params.bootWasFailover;
    this.config = params.config;
    this.envManager = params.envManager;
    this.harness = params.harness;
    this.connectionManager = params.connectionManager;
    this.connections = params.connections;
    this.#redactionExt = params.redactionExt;
    this.#toolOverflowExt = params.toolOverflowExt;
    this.#runHealth = params.runHealth;
    this.memoryRuntime = params.memoryRuntime;
    this.#activeRootConversation = params.rootConversation;
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
    this.#settingsStore = params.settingsStore;
    this.#delivery = new HubDeliveryCoordinator(this.harness);
    this.#turnContext = new TurnContextReader(this.harness);
    this.#runtimeGates = {
      isClosed: () => this.#closed,
      isRecovering: () => this.#recovering,
      isHandoverBarrierActive: () => this.#handoverBarrierActive,
      resumeIfNotRecovering: () => {
        if (!this.#recovering && !this.#closed) this.harness.resume();
      },
      broadcastTickets: (ctx) => this.#broadcastTickets(ctx),
      recordTicketOutwardAction: (ticketId, runEpoch, kind, label, ctx) =>
        this.#recordTicketOutwardAction(ticketId, runEpoch, kind, label, ctx),
    };
    this.#androidNotifications = new KuloAndroidNotifications({ stateDir: this.config.stateDir, models: this.#models,
      agent: () => this.#resolveOrchestratorAgent(), hubId: () => this.#androidHubId,
      redact: text => this.connectionManager.redact(text) });
    this.#androidNotifications.setOnWrite(() => this.#notifyClusterDirty("files"));
    this.uploads.setOnWrite(() => this.#notifyClusterDirty("uploads"));
    this.identityFiles.setOnWrite(() => this.#notifyClusterDirty("files"));
    this.connectionManager.setOnPersist(() => this.#notifyClusterDirty("files"));
    this.connectionManager.localVault?.setOnChange(() => this.#notifyClusterDirty("vault"));
    this.envManager.setAndroidNotificationClassifier((request, signal) => this.#androidNotifications.classify(request, signal));
    this.#subagentRunner = new KuloSubagentRunner({
      harness: this.harness,
      envManager: this.envManager,
      isClosed: () => this.#closed,
      getRoles: () => this.#liveSettings.roles,
      getMaxSubagentsPerTicket: () => this.#liveSettings.executor.maxSubagentsPerTicket ?? 4,
      resolveSubagentAgent: (subPreset, requestedThinking) => {
        const subProviderOpt = subPreset?.provider?.trim() || this.#liveSettings.model.defaultProvider;
        const subModelId = subPreset?.modelId?.trim() || this.#liveSettings.model.defaultModel;
        const desiredThinking: ThinkingEffort =
          subPreset?.thinkingLevel === "auto"
            ? requestedThinking ?? this.#liveSettings.model.thinkingLevel
            : subPreset?.thinkingLevel ?? requestedThinking ?? this.#liveSettings.model.thinkingLevel;
        return resolveAgentModelAndThinking(this.#models, this.#providerId, subProviderOpt, subModelId, desiredThinking, this.#liveSettings.model);
      },
      buildSubagentTools: (ticket, readOnly) =>
        this.#workerTools({ executionDomain: ticket.executionDomain, androidTargetIds: this.#androidTargets(ticket), allowSubagents: false, isSubagent: true, readOnly, hasProject: Boolean(ticket.projectId) }),
      syncSubagentConversation: (conv, ticket, sub, ctx) => this.#syncSingleSubagentConversation(conv, ticket, sub, ctx),
      touchParentActivity: (ticketId) => {
        this.#watchdog.touchActivity(ticketId);
      },
    });
    this.#workerTicketTask = params.workerTicketTask;
    this.#failureRecoveryTask = params.failureRecoveryTask;
    this.#watchdog = new HubWatchdog({
      harness: this.harness,
      getRootConversation: () => this.#activeRootConversation,
      revokeTicketConnections: (ticketId) => { void this.connectionManager.revoke(ticketId); },
      isClosed: () => this.#closed,
      isHandoverBarrierActive: () => this.#handoverBarrierActive,
      getWatchdogMinutes: () => this.#liveSettings.executor.watchdogMinutes ?? 0,
      checkIntervalMs: params.watchdogCheckIntervalMs,
      ...(params.watchdogStallMsOverride !== undefined ? { stallMsOverride: params.watchdogStallMsOverride } : {}),
    });
    this.#failureRecovery = new HubFailureRecovery({
      harness: this.harness,
      getRootConversation: () => this.#activeRootConversation,
      failureRecoveryTask: this.#failureRecoveryTask,
      isClosed: () => this.#closed,
      isRecovering: () => this.#recovering,
      isExecutorPaused: () => this.#liveSettings.executor.paused,
      broadcastTickets: (ctx) => this.#broadcastTickets(ctx),
    });
    this.#codingToolsExt = params.codingToolsExt;
    this.#androidExt = params.androidExt;
    this.#toolSearchExt = params.toolSearchExt;
    this.#settingsTierExt = params.settingsTierExt;
    this.#computerMixedAndroidTierExt = params.computerMixedAndroidTierExt;
    this.#readOnlyAndroidTierExt = params.readOnlyAndroidTierExt;
    this.#orchestratorGuardExt = params.orchestratorGuardExt;
    this.#computer = params.computerController;
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
      modelConfig: () => this.#liveSettings.model,
      persistedConfig: async () => (await this.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT))?.backgroundModel ?? { mode: "auto", revision: 1 },
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
      cursorStore: this.assistantLedger.larkCursorStore(),
      onEvents: (profile, events) => this.#ingestInternalAssistantEvents("lark-cli", events, `lark:${profile}`),
    });
    const assistantRuntime = createHubAssistantRuntime({
      harness: this.harness,
      ledger: this.assistantLedger,
      ambientModel: this.ambientModel,
      echoSuppressor: this.assistantEchoSuppressor,
      envManager: this.envManager,
      uploads: this.uploads,
      sparkMail: this.sparkMail,
      homeAssistant: this.homeAssistant,
      larkConnector: this.larkConnector,
      redact: redactAssistantText,
      agentName: () => this.#liveSettings.presentation.agentName,
      isForegroundBusy: () => this.voiceCalls.hasActiveCalls() || this.#topics.inspectBusyTopics().length > 0,
      isVoiceCallActive: () => this.voiceCalls.hasActiveCalls(),
      canMutateState: () => !this.#closed && !this.#recovering && !this.#handoverBarrierActive,
      isAssistantCloudCapped: () => this.usageCaps.isCappedFor("assistant").capped,
      isMainModelLocal: () => {
        const agent = this.#resolveOrchestratorAgent();
        const model = this.#models.getModel(agent.model.provider, agent.model.modelId);
        return Boolean(model?.baseUrl && isPrivateLocalModelEndpoint(model.baseUrl));
      },
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
              maxTurns: PROACTIVE_WAKE_MAX_TURNS,
            },
          },
          ctx,
        );
        return { id: conv.id };
      },
      queueChat: (topicId, fn) => this.#delivery.queueChat(topicId, fn),
      resolveWatchedTopic: (topicId, ctx) => this.#topics.resolveWatchedTopic(topicId, ctx),
      resumeIfNotRecovering: () => this.#runtimeGates.resumeIfNotRecovering(),
      onItemsChanged: (revision, items) => this.#emitAssistantItems(revision, items),
      onTopicsChanged: (topics) => this.#emitTopics(topics),
      onTopicContentChanged: (topicId) => this.#topics.refreshTopic(topicId),
      emitNotification: (event) => {
        for (const listener of this.#listeners) listener.onNotification?.(event);
      },
    });
    this.assistantProactiveWake = assistantRuntime.proactiveWake;
    this.assistantWatchRules = assistantRuntime.watchRules;
    this.assistantCoordinator = assistantRuntime.coordinator;
    this.assistantSorter = assistantRuntime.sorter;
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
      resolveMetadata: (request) => this.resolveModelMetadata(request), hasSavedProviderKey: async (id, url) => Boolean(await this.#providerManager?.resolveProbeApiKey(id, url)),
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
      canCreateCall: async (topicId) => {
        if (!this.#acceptingNewWork || this.#closed) {
          throw new VoiceError(503, "voice_calls_closed", "语音服务已关闭。");
        }
        if (topicId === "root" && this.#mainArchive?.isArchivingRoot()) {
          throw new VoiceError(409, "main_archive_in_progress", "主对话正在归档，请稍后再发起语音通话。");
        }
        const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const topic = state?.topics && Object.hasOwn(state.topics, topicId) ? state.topics[topicId] : undefined;
        if (!topic || topic.deletedAt) throw new VoiceError(404, "voice_topic_not_found", "通话所属会话不存在或已删除。");
        if (topic.archived) throw new VoiceError(409, "topic_archived", "会话已归档，请还原后再发起语音通话。");
      },
      context: async (topicId, principalId) => {
        const cache = await this.#voiceTopic(topicId);
        const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        for (const ticket of Object.values(state?.tickets ?? {})) {
          if (ticket.originTopicId === topicId && ticket.latestReport?.summary &&
              !isSilentRecoveryFailure(state!, ticket)) this.voiceCalls.taskUpdated(topicId, ticket.id,
            this.connectionManager.redact(ticket.latestReport.summary), ticket.status);
        }
        const voiceContext = await createVoiceContext({ conversation: cache.conversation, harness: this.harness, state,
          memory: this.#effectiveMemoryConfig(this.#liveSettings.memory), agentName: this.#liveSettings.presentation.agentName,
          builtinMemoryRecall: this.memoryRuntime.builtinMemory.isEffectiveActive() ? (input, ctx) => this.memoryRuntime.builtinMemory.recallForVoice(input, ctx) : undefined,
          redact: (text) => this.connectionManager.redact(text) }, BACKGROUND_CONTEXT);
        return {
          ...voiceContext,
          conversationId: Number(cache.conversation.id),
          ...(cache.live.runFailure ? { priorFailureTaskId: cache.live.runFailure.taskId ?? "router" } : {}),
        };
      },
      transcript: (topicId, event, callId, conversationId) => this.#recordVoiceTranscript(topicId, event, callId, conversationId),
      delegate: async ({ topicId, conversationId, principalId, callId, delegationId, text }) => {
        const target = await this.#resolveVoiceConversation(topicId, conversationId, false);
        if (!target || target.archived) return;
        await this.sendUserMessage(`[Voice Call Request]\n${text}\nFulfill this spoken request in the active conversation context (delegate complex work via kulo_dispatch, or update existing work via kulo_steer). Publish full deliverables to this chat and reply with concise, verified facts and status suitable for spoken summary.`,
          { topicId: target.topicId, expectedConversationId: target.conversationId, principalId, requestId: `voice:${callId}:${delegationId}`, voiceDelegation: true });
      },
      summary: (input) => this.#recordVoiceCallSummary(input) });
    this.mediaJobs = new KuloMediaJobs({ harness: this.harness, capabilities: this.capabilities, uploads: this.uploads,
      browser: (id, request) => this.envManager.requestBrowser(id, request),
      validateSource: (source, job) => this.#validateMediaSource(source, job),
      validateInput: (id, source) => this.#validateMediaInput(id, source),
      onChanged: () => this.#broadcastCapabilities(),
      onCreated: (job) => job.source.ticketId ? this.#recordTicketOutwardAction(job.source.ticketId, undefined, "media", `media:${job.kind}:${job.modelId}`) : undefined,
      onCompleted: (job) => this.#mediaDelivery.onMediaCompleted(job), onSettled: (job) => this.#mediaDelivery.onMediaSettled(job) });
    this.projects = new KuloProjects({
      harness: this.harness, envManager: this.envManager, stopTicket: (id, reason) => this.stopTicket(id, reason),
      onChanged: () => { void this.#broadcastProjects().catch((error) => console.error("[KuloProjects]", error)); },
      onProjectDeleted: (id, convIds, ctx) => this.memoryRuntime.onProjectDeleted(id, convIds, ctx), onTopicMoved: (id, pId, ctx) => this.memoryRuntime.onTopicMoved(id, pId, ctx),
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
      this.#projection.rememberCard(card);
      for (const listener of this.#listeners) listener.onUiCard?.(card);
      this.#topics.refreshByConversation(card.originConversationId);
      void this.settingsAssistant.refreshIfConversation(card.originConversationId);
    } });
    this.actionConfirmations = new KuloActionConfirmations({ harness: this.harness, uiCards: this.uiCards });
    this.#projection = new HubMessageProjection({
      harness: this.harness,
      uploads: this.uploads,
      uiCards: this.uiCards,
      connectionManager: this.connectionManager,
      actionConfirmations: this.actionConfirmations,
      getContextGuard: () => this.#contextGuard,
      hasPendingMediaRelay: (conversationId) => this.#mediaDelivery.hasPendingRelay(conversationId),
      getSettingsSurfaceState: (turnContext) =>
        this.#surfaceRuntimeState("settings", {
          settingsModule: turnContext?.module,
          settingsActive: turnContext?.active,
        }),
    });
    this.deviceJoinStaging = params.deviceJoinStaging;
    this.migration = new LocalConfigMigrationService({ stateDir: this.config.stateDir, homeDir: params.migrationHomeDir, connections: this.connectionManager, skills: this.skills, getLocalNodeId: () => this.#clusterHostContext?.localNodeId ?? this.config.localEnvId ?? "local", onClusterDirty: (kind) => this.#onClusterDirty?.(kind) });
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
        params.memoryRuntime.builtinMemoryRecallExt,
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
      registerLocalModel: (input, signal) => this.modelConfiguration.registerLocalProvider(input, signal),
      agentConfigurationExtensions: [params.agentConfigurationExt],
      deviceExtensions: [params.deviceToolsExt],
      migrationExtensions: [params.migrationToolsExt],
      securityExtensions: [params.redactionExt],
      customizationExtensions: this.#customizationExtensions,
      processText: async (text, requestId) => {
        const sealed = this.deviceJoinStaging.sealText(text, (values) => this.connectionManager.rememberSecrets(values));
        return this.connectionManager.processText(sealed.text, { requestId });
      },
      prepareInput: (text, attachments, principalId) => {
        for (const attachment of attachments) {
          const loaded = typeof attachment?.id === "string" ? this.uploads.getUpload(attachment.id) : null;
          if (!loaded) {
            throw Object.assign(new Error("附件不存在或已失效，请重新上传后再发送。"), { code: "attachment_not_found" });
          }
          if (loaded.record.internalOnly || !this.uploads.canReadUpload(attachment.id, principalId)) {
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
      hydrateConversation: (conversationId) => this.#projection.hydrateCards(conversationId),
      display: (view, conversationId) => this.#projection.projectSettingsDisplay(view, conversationId),
      applied: async (doc) => {
        await this.#applyLiveSettings(doc, BACKGROUND_CONTEXT);
        this.#emitSettings(this.getSettingsView());
        await this.#broadcastTickets(BACKGROUND_CONTEXT);
      },
      emit: (snapshot) => { for (const listener of this.#listeners) listener.onSettingsAssistant?.(snapshot); },
    });
    this.#contextGuard = new HubContextGuard({
      harness: this.harness,
      models: this.#models,
      settingsStore: this.#settingsStore,
      runtimeGates: this.#runtimeGates,
      isArchivingRoot: () => this.#mainArchive?.isArchivingRoot() ?? false,
      onContextUpdated: (conversationId) => this.#topics?.refreshByConversation(conversationId),
    });
    this.#topics = new HubTopicManager({
      harness: this.harness,
      settingsStore: this.#settingsStore,
      runtimeGates: this.#runtimeGates,
      envManager: this.envManager,
      uploads: this.uploads,
      projects: this.projects,
      connectionManager: this.connectionManager,
      listeners: this.#listeners,
      voiceCalls: this.voiceCalls,
      contextCompaction: {
        align: (conversationId, ctx) => this.#alignContextCompaction(conversationId, ctx),
        pruneCommittedBaseline: (conversationId, ctx, force) =>
          this.#contextCompaction.pruneCommittedBaseline(conversationId, ctx, force),
      },
      onTopicIdle: (topicId, conversationId, live, value) => {
        void this.#contextGuard.maybeTriggerEarlyCompaction(topicId, conversationId, live.context, value, BACKGROUND_CONTEXT).catch(() => {});
        this.#mediaDelivery?.onConversationIdle(conversationId);
      },
      hasPendingMediaRelay: (conversationId) => this.#mediaDelivery?.hasPendingRelay(conversationId) ?? false,
      decorateNotification: (event, entries, maxVisibleAssistantId) => {
        const decorated = this.assistantProactiveWake.decorateTopicNotification(event, entries, maxVisibleAssistantId);
        if (decorated) this.assistantEchoSuppressor.recordSelfNotification(decorated.summary);
        return decorated;
      },
      orchestrator: {
        resolveAgent: () => this.#resolveOrchestratorAgent(),
        extensions: (isRoot) => this.#orchestratorExtensions(isRoot),
        tools: (isRoot) => this.#orchestratorTools(isRoot),
        redactionExt: this.#redactionExt,
        mainWorkspaceDir: this.#mainWorkspaceDir,
      },
      projection: {
        hydrateMessages: (entries, conversationId, ctx) => this.#projection.hydrateMessages(entries, conversationId, undefined, ctx),
        projectTopicMessages: (value, conversationId) => this.#projection.projectTopicMessages(value, conversationId),
        projectTopicLiveState: (value, conversationId, conversation) => this.#projection.projectTopicLiveState(value, conversationId, conversation),
      },
      cleanup: {
        closeOrchestratorBrowserSession: (topicId) => this.#computer.closeOrchestratorBrowserSession(topicId),
        discardTicketStagedWorkspace: (ticket) => this.#discardTicketStagedWorkspace(ticket),
        onTopicDeleted: async (topicId, convId, ctx) => { await this.memoryRuntime.onTopicDeleted(topicId, convId, ctx); await this.#mediaDelivery?.onConversationDeleted(convId); },
      },
    });
    this.#chat = new HubChatPipeline({
      harness: this.harness,
      settingsStore: this.#settingsStore,
      runtimeGates: this.#runtimeGates,
      delivery: this.#delivery,
      topics: this.#topics,
      uploads: this.uploads,
      envManager: this.envManager,
      connectionManager: this.connectionManager,
      transcribeVoiceAsset: (assetId, options, ctx) => this.transcribeVoiceAsset(assetId, options, ctx),
      pruneCompactionBaseline: (conversationId, ctx, force) =>
        this.#contextCompaction.pruneCommittedBaseline(conversationId, ctx, force),
    });
    this.#connectionsBridge = new HubConnectionsBridge({
      harness: this.harness,
      connectionManager: this.connectionManager,
      envManager: this.envManager,
      projects: this.projects,
      settingsAssistant: this.settingsAssistant,
      runtimeGates: this.#runtimeGates,
      steerTicket: (req, ctx) => this.steerTicket(req, ctx),
    });
    this.#hostActions = new HubHostActions({
      harness: this.harness,
      envManager: this.envManager,
      projects: this.projects,
      actionConfirmations: this.actionConfirmations,
      connectionManager: this.connectionManager,
      inlineWaiters: this.#inlineWaiters,
      runtimeGates: this.#runtimeGates,
      turnContext: this.#turnContext,
      steerTicket: (req, ctx) => this.steerTicket(req, ctx),
    });
    this.#stagedApply = new TicketStagedApplyService({
      harness: this.harness,
      envManager: this.envManager,
      projects: this.projects,
      actionConfirmations: this.actionConfirmations,
      connectionManager: this.connectionManager,
      delivery: this.#delivery,
      runtimeGates: this.#runtimeGates,
      workerTicketTask: this.#workerTicketTask,
    });
    this.#ticketDispatch = new TicketDispatchService({
      harness: this.harness,
      getRootConversation: () => this.#activeRootConversation,
      inlineDispatchWaitMs: this.config.inlineDispatchWaitMs ?? 0,
      envManager: this.envManager,
      projects: this.projects,
      uploads: this.uploads,
      connectionManager: this.connectionManager,
      liveSettings: this.#settingsStore,
      runtimeGates: this.#runtimeGates,
      inlineWaiters: this.#inlineWaiters,
      turnContext: this.#turnContext,
      computerTransfer: this.#computer,
      workerOps: {
        workerTicketTask: this.#workerTicketTask,
        resolveWorkerAgent: (providerOpt, modelId, desiredThinking) =>
          resolveAgentModelAndThinking(
            this.#models,
            this.#providerId,
            providerOpt,
            modelId,
            desiredThinking,
            this.#liveSettings.model,
          ),
        workerTools: (options) => this.#workerTools(options),
        discardTicketStagedWorkspace: (ticket) => this.#discardTicketStagedWorkspace(ticket),
      },
    });
    this.#mediaDelivery = new HubMediaDelivery({
      harness: this.harness,
      getRootConversationId: () => Number(this.#activeRootConversation.id),
      uploads: this.uploads,
      uiCards: this.uiCards,
      mediaJobs: () => this.mediaJobs,
      capabilities: this.capabilities, liveSettings: this.#settingsStore, redact: (text: string) => this.connectionManager.redact(text),
      projects: this.projects,
      settingsAssistant: this.settingsAssistant,
      topics: this.#topics,
      runtimeGates: this.#runtimeGates,
      ticketWaitPort: {
        queueWaitReconcile: () => this.#queueWaitReconcile(),
        resumeWaitingTicket: (ticketId, ctx) => this.#resumeWaitingTicket(ticketId, ctx),
      },
    });
    this.#computer.attachRuntime({
      harness: this.harness,
      getRootConversationId: () => Number(this.#activeRootConversation.id),
      capabilities: this.capabilities,
      actionConfirmations: this.actionConfirmations,
      connectionManager: this.connectionManager,
      runtimeGates: this.#runtimeGates,
      mediaDelivery: this.#mediaDelivery,
      resolveOrchestratorTargetEnvId: (conversationId, toolTaskId, ctx) =>
        this.#resolveOrchestratorTargetEnvId(conversationId, toolTaskId, ctx),
      reconfigureConversations: async (ctx) => {
        await this.#reconfigureOrchestratorConversations(ctx);
        await this.settingsAssistant.reconfigureActiveConversation(ctx);
        await this.#reconfigureWorkerConversations(ctx);
      },
      stopTicket: (ticketId, reason, ctx, commandId) =>
        this.stopTicket(ticketId, reason, ctx, commandId),
      steerTicket: (req, ctx) => this.steerTicket(req, ctx),
    });
    this.#mainArchive = new MainConversationArchiveService({
      harness: this.harness,
      runtimeGates: this.#runtimeGates,
      delivery: this.#delivery,
      topics: this.#topics,
      voiceCalls: this.voiceCalls,
      contextGuard: this.#contextGuard,
      memoryRuntime: this.memoryRuntime,
      connectionManager: this.connectionManager,
      orchestrator: {
        resolveAgent: () => this.#resolveOrchestratorAgent(),
        extensions: (isRoot) => this.#orchestratorExtensions(isRoot),
        tools: (isRoot) => this.#orchestratorTools(isRoot),
        mainWorkspaceDir: this.#mainWorkspaceDir,
        alignContextCompaction: (cid, ctx) => this.#alignContextCompaction(cid, ctx),
      },
      hooks: {
        getAgentName: () => this.#liveSettings.presentation.agentName,
        isLongTermMemoryActive: () =>
          Boolean(this.#effectiveMemoryConfig(this.#liveSettings.memory).enabled || this.memoryRuntime.builtinMemory.isEffectiveActive()),
        closeOrchestratorBrowserSessionByConversation: (cid) => this.#computer.closeOrchestratorBrowserSessionByConversation(cid),
        onActiveRootChanged: (conv) => { this.#activeRootConversation = conv; },
        broadcastTicketsAndBoards: (ctx) => this.#broadcastTickets(ctx),
      },
    });
    this.sideQuestions = new SideQuestionService({ harness: this.harness, runtimeGates: this.#runtimeGates, redactionExt: this.#redactionExt, isArchivingRoot: () => this.#mainArchive.isArchivingRoot(), resolveOrchestratorAgent: () => this.#resolveOrchestratorAgent(), redact: (text) => this.connectionManager.redact(text) });
    this.#ticketReconciler = new TicketReconciler({
      harness: this.harness,
      envManager: this.envManager,
      projects: this.projects,
      connectionManager: this.connectionManager,
      usageCaps: this.usageCaps,
      runtimeGates: this.#runtimeGates,
      ports: {
        watchdog: this.#watchdog,
        computer: this.#computer,
        hostActions: this.#hostActions,
        connectionsBridge: this.#connectionsBridge,
        stagedApply: this.#stagedApply,
        mediaJobs: () => this.mediaJobs,
        workerTicketTask: this.#workerTicketTask,
        notifyInlineWaiters: (ticketId) => this.#notifyInlineWaiters(ticketId),
        ensureTopicWatchedByConversation: (conversationId, ctx) =>
          this.#ensureTopicWatchedByConversation(conversationId, ctx),
        broadcastProjects: () => this.#broadcastProjects(),
        steerTicket: (req, ctx) => this.steerTicket(req, ctx),
      },
    });
    this.#ticketControl = new TicketControlService({
      harness: this.harness,
      envManager: this.envManager,
      projects: this.projects,
      uploads: this.uploads,
      connectionManager: this.connectionManager,
      actionConfirmations: this.actionConfirmations,
      uiCards: this.uiCards,
      liveSettings: this.#settingsStore,
      delivery: this.#delivery,
      runtimeGates: this.#runtimeGates,
      ports: {
        turnContext: this.#turnContext,
        reconciler: this.#ticketReconciler,
        watchdog: this.#watchdog,
        computer: this.#computer,
        hostActions: this.#hostActions,
        stagedApply: this.#stagedApply,
        ticketDispatch: this.#ticketDispatch,
        mediaJobs: () => this.mediaJobs,
        workerTicketTask: this.#workerTicketTask,
        transcribeVoiceAsset: (assetId, opts, ctx) => this.transcribeVoiceAsset(assetId, opts, ctx),
      },
    });
    this.#ticketQuotaResume = new TicketQuotaResumeService({
      harness: this.harness, models: this.#models, envManager: this.envManager, projects: this.projects, usageCaps: this.usageCaps, liveSettings: this.#settingsStore, delivery: this.#delivery, runtimeGates: this.#runtimeGates,
      ports: { redact: (text) => this.connectionManager.redact(text), fallbackProviderId: this.#providerId, workerTicketTask: this.#workerTicketTask, reconciler: this.#ticketReconciler, syncWorkerConversation: (ticket, ctx) => this.#syncSingleWorkerConversation(ticket, ctx), refreshExternalQuota: (clientId) => { void this.externalClientQuotas.refresh({ clientId, force: false }).catch(() => {}); } },
    });
    this.#externalClientAdmin = new ExternalClientAdminService({
      harness: this.harness,
      envManager: this.envManager,
      connectionManager: this.connectionManager,
      applyLiveSettings: (nextDoc, ctx) => this.#applyLiveSettings(nextDoc, ctx),
      getSettingsView: () => this.getSettingsView(),
      emitSettings: (view) => this.#emitSettings(view),
    });
    this.#externalRuntime = new TicketExternalRuntime({
      harness: this.harness,
      envManager: this.envManager,
      uploads: this.uploads,
      connectionManager: this.connectionManager,
      liveSettings: this.#settingsStore,
      delivery: this.#delivery,
      runtimeGates: this.#runtimeGates,
      stateDir: this.config.stateDir,
      defaultIdentityDir: this.#defaultIdentityDir,
      getEffectiveMemoryConfig: () => this.#effectiveMemoryConfig(this.#liveSettings.memory), getBuiltinMemory: () => this.memoryRuntime.builtinMemory,
      ports: {
        connectionsBridge: this.#connectionsBridge,
        stageWorkerArtifact: (asset, meta, callId) => this.#stageWorkerArtifact(asset, meta, callId),
        dispatchTicket: (req, ctx) => this.dispatchTicket(req, ctx),
        inspectWorker: (ticketId, ctx) => this.inspectWorker(ticketId, ctx),
      },
    });
    this.envManager.setExternalAgentToolHandler(this.#externalRuntime.createToolHandler());
    this.#ticketInspection = new TicketInspectionService({
      harness: this.harness,
      envManager: this.envManager,
      projects: this.projects,
      uploads: this.uploads,
      connectionManager: this.connectionManager,
      liveSettings: this.#settingsStore,
      watchdog: this.#watchdog,
      stateDir: this.config.stateDir,
      defaultIdentityDir: this.#defaultIdentityDir,
      hydrateMessages: (entries, conversationId, options) => this.#projection.hydrateMessages(entries, conversationId, options),
      getExternalTelemetry: (ticket) =>
        this.#externalTelemetry.get(ticket.id, {
          envId: ticket.envId,
          runEpoch: ticket.runEpoch,
          ...(ticket.externalExecution?.sessionId ? { sessionId: ticket.externalExecution.sessionId } : {}),
        }),
    });
  }

  get #liveSettings(): KuloDurableSettings {
    return this.#settingsStore.get();
  }

  async refreshLiveSettings(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    const next = await this.harness.snapshot(KuloSettingsDoc, context);
    if (next) await this.#applyLiveSettings(cloneJson(next) as KuloDurableSettings, context);
  }

  async migrateLegacyLocalNode(legacyLocalNodeId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await migrateLegacyLocalReferences(this.harness, legacyLocalNodeId);
    await this.refreshLiveSettings(context);
    this.uploads.setLegacyLocalPrincipal(legacyLocalNodeId);
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
    const bootLocalNodeId = resolveBootGateLocalNodeId(config.stateDir, config.localEnvId);
    const bootGate = recordBootStart(config.stateDir, bootLocalNodeId);
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
    const redactionExt = createCredentialRedactionExtension(redact, { isKnownSecret, onCompactionDeclined: (convId, reason) => { if (hubRef) hubRef.#contextGuard.recordCompactionDeclined(convId, reason); } });
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
    uploads.cleanupToolOverflows();

    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.mkdirSync(mainWorkspaceDir, { recursive: true });
    fs.mkdirSync(defaultIdentityDir, { recursive: true, mode: 0o700 });

    const settingsStore = new LiveSettingsStore(config, defaultIdentityDir);

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
        ...settingsStore.getProtectedSettingsPaths(),
        path.resolve(".env"),
        ...(config.memory.authFile ? [path.resolve(config.memory.authFile)] : []),
      ],
      getCoreProtectedPaths: () => settingsStore.getCoreProtectedPaths(),
      getBlockedEnvNames: () => settingsStore.getBlockedSecretEnvNames(),
      onChange: (envs) => {
        if (hubRef) {
          for (const env of envs) {
            if (!env.online) {
              void hubRef.#computer.closeOrchestratorBrowserSessionsForEnv(env.id, false);
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
      fetch: modelFetch,
      getNativeTools: (provider, id) => {
        if (providerManager && !providerManager.isOfficialNativeSearchAllowed(provider)) return undefined;
        const modelConfig = settingsStore.getModel();
        return (provider === KULO_GATEWAY_PROVIDER_ID ? modelConfig.gatewayModels?.find((model) => model.id === id) :
          modelConfig.subscriptionModels?.[provider]?.find((model) => model.id === id) ??
          modelConfig.customProviders?.find((item) => item.id === provider)?.models.find((model) => model.id === id))?.nativeTools;
      },
    });

    const getLiveRoles = () => settingsStore.getRoles();
    const toolOverflowExt = createOrchestratorToolOverflowExtension({
      uploads,
      redact,
      isKnownSecret,
      resolveContextWindow: createConversationContextWindowResolver({
        getHarness: () => hubRef?.harness,
        models,
        settingsStore,
      }),
      resolveDeferredTools: async (convId, candidates, ctx) => {
        const conv = hubRef ? await hubRef.harness.conversation(convId, ctx) : undefined;
        return conv ? resolveDeferredAddTools(conv, ctx, candidates) : [];
      },
    });
    const runHealth = createRunHealthController({ getHarness: () => hubRef?.harness, getModels: () => models, resolveFallbackModel: () => (hubRef ? hubRef.#resolveOrchestratorAgent().model : undefined), redact });
    const getLiveMemory = () => {
      const mem = settingsStore.getMemory();
      return hubRef ? hubRef.#effectiveMemoryConfig(mem) : mem;
    };
    const getLiveIdentityDir = () => settingsStore.getIdentityDir();
    const getLiveIdentityState = () => ({
      directory: settingsStore.getIdentityDir(),
      directoryRevision: settingsStore.getIdentityDirectoryRevision(),
    });
    const getMaxConcurrentWorkers = () => settingsStore.getMaxConcurrentWorkers();
    const getAgentName = () => settingsStore.getAgentName();
    const getLiveLanguage = (): KuloLanguage | undefined => settingsStore.getLanguage();

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

    const orchestratorGuardExt = createOrchestratorCodingGuardExtension({
      stateDir: config.stateDir,
      mainWorkspaceDir,
      defaultIdentityDir: config.identityDir,
      defaultMemoryAuthFile: config.memory.authFile,
      extraProtectedPaths: config.extraProtectedPaths,
      getLiveIdentityDir,
      getLiveMemoryAuthFile: () => getLiveMemory().authFile,
      getExecutionTrustMode: () => settingsStore.getExecutionTrustMode(),
      envManager,
      redact,
      assertChatReadTarget: (conversationId, toolTaskId, envId, context, topic) =>
        hubRef!.#assertChatReadTarget(conversationId, toolTaskId, envId, context, topic),
      getProject: (projectId, context) => hubRef!.projects.get(projectId, context),
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
      list: (caller, ctx) => hubRef!.#connectionsBridge.list(caller, ctx),
      describe: (caller, input, ctx) => hubRef!.#connectionsBridge.describe(caller, input, ctx),
      request: (caller, input, ctx) => hubRef!.#connectionsBridge.request(caller, input, ctx),
      decide: (caller, input, ctx) => hubRef!.#connectionsBridge.decide(caller, input, ctx),
      grant: (caller, input, ctx) => hubRef!.#connectionsBridge.grant(caller, input, ctx),
      use: (caller, input, ctx) => hubRef!.#connectionsBridge.use(caller, input, ctx),
    };
    const { controller: computerController, extension: computerUseExt } = HubComputerController.createShell({
      envManager,
      orchestratorBrowserIdleMs: init.orchestratorBrowserIdleMs ?? 60_000,
    });
    const hostActions: HostActionController = {
      inspect: (caller, input, ctx) => hubRef!.#hostActions.inspect(caller, input, ctx),
      run: (caller, input, ctx) => hubRef!.#hostActions.run(caller, input, ctx),
      decide: (caller, input, ctx) => hubRef!.#hostActions.decide(caller, input, ctx),
    };
    const memoryRuntime = new HubMemoryRuntime({
      stateDir: config.stateDir, getHarness: () => hubRef!.harness, getModels: () => hubRef!.#models, getSettingsStore: () => hubRef!.#settingsStore, getContextGuard: () => hubRef!.#contextGuard, getRuntimeGates: () => hubRef!.#runtimeGates, getMemoryLifecycle: () => memoryLifecycleExt, getEffectiveMemoryConfig: getLiveMemory, getRawMemoryConfig: () => settingsStore.get().memory, onBuiltinMemoryModeChanged: (state) => { if (hubRef) return hubRef.#onBuiltinMemoryModeChanged(state); }, onBuiltinMemoryStoreWrite: () => { if (hubRef) hubRef.#notifyClusterDirty("memory"); }, isClusterStandbyActive: () => Boolean(hubRef && hubRef.#hasRemoteStandbys?.()), redact,
      isPersonalityCapped: () => { const c = hubRef!.usageCaps.isCappedFor("personality"); return { capped: c.capped, ...(c.resetAt !== null ? { resetAt: c.resetAt } : {}) }; }, willUseCloudModel: () => hubRef!.ambientModel.willUseCloudModel(false), completeZeroToolJson: (input) => hubRef!.ambientModel.completeZeroToolJson(input),
    });
    const workerExt = createWorkerExtension({
      connections,
      hostActions,
      uploads,
      search: () => hubRef!.search,
      getLocalEnvId: () => envManager.localEnvId, getEnvDescriptor: (id) => envManager.getEnvDescriptor(id),
      publishAsset: (input, api, context) => contentExt.publishAsset(input, api, context),
      onStateChanged: notifyTicketsChanged,
      onOutwardAction: (ticketId, runEpoch, label) => hubRef ? hubRef.#recordTicketOutwardAction(ticketId, runEpoch, "shell", label) : undefined,
      getIdentityDir: getLiveIdentityDir,
      getStateDir: () => config.stateDir, getMainWorkspaceDir: () => mainWorkspaceDir, getCoreProtectedPaths: () => settingsStore.getCoreProtectedPaths(), getExecutionTrustMode: () => settingsStore.getExecutionTrustMode(),
      getMemoryConfig: getLiveMemory, getSharedMemoryMode: () => memoryRuntime.builtinMemory.getExternalMemoryMode(), builtinMemoryTools: memoryRuntime.createBuiltinMemoryTools("shared"),
      getRoles: getLiveRoles,
      getLanguage: getLiveLanguage,
      getMaxSubagentsPerTicket: () => settingsStore.getMaxSubagentsPerTicket(),
      getMediaCapabilities: () =>
        hubRef
          ? hubRef.capabilities.snapshot()
          : Promise.resolve(EMPTY_MEDIA_CAPABILITIES),
      runSubagents: (req, ctx) => hubRef!.#runSubagents(req, ctx),
      mediaJob: async (id, conversationId) => {
        const source = await hubRef!.mediaSource(conversationId);
        const job = await hubRef!.mediaJobs.get(id);
        if (!source.ticketId || job.source.ticketId !== source.ticketId) throw new Error("不能等待其他任务的媒体作业。");
        return job;
      },
    });

    const memoryLifecycleExt = createMemoryLifecycleExtension({ getHarness: () => hubRef!.harness, getMemoryConfig: getLiveMemory, getBuiltinMemory: () => memoryRuntime.builtinMemory, redact });
    const failureRecoveryTask = createFailureRecoveryTask({
      review: (ticketId, startedAt, ctx) => hubRef!.#failureRecovery.review(ticketId, startedAt, ctx),
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
        if (hubRef && reason === "coordinator") void hubRef.#hostActions.relayRequest(id).catch((error) => console.error("[KuloHostActionRequest]", redact(error instanceof Error ? error.message : "本机操作审批转交失败")));
      },
      resumeWaitingTicket: async (id, ctx) => { if (hubRef) await hubRef.#resumeWaitingTicket(id, ctx); },
      scheduledWakeDeferUntil: (ticket, now) => hubRef ? hubRef.#ticketReconciler.scheduledWakeDeferUntil(ticket, now) : null,
      prepareTicketRelease: (ticket) => hubRef!.#releaseTicketExecution(ticket, { park: Boolean(ticket.waiting) && isTicketUnfinished(ticket) }),
      ticketAgentBlock: (ticket) => hubRef ? hubRef.#ticketAgentBlock(ticket) : undefined,
      getProjectMeta: async (projectId, ctx) => hubRef ? hubRef.projects.get(projectId, ctx).then((p) => ({ id: p.id, name: p.name, workspaceDir: p.workspaceDir }), () => undefined) : undefined,
      materializeExternalAttachments: (ticket, attachmentIds, ctx) => hubRef ? hubRef.#materializeExternalAttachments(ticket, attachmentIds, ctx) : Promise.resolve([]),
      recallExternalMemory: (ticket, ctx) => memoryLifecycleExt.recallTicketMemory(ticket, ctx),
      retainExternalMemory: (ticket, report, ctx) => memoryLifecycleExt.retainExternalTicketReport(ticket, report, ctx),
      consumeExternalPendingReports: (ticket, reports, ctx) => hubRef ? hubRef.#consumeExternalPendingReports(ticket, reports, ctx) : Promise.resolve([]),
      hasTicketConnections: (ticket) => Boolean(ticket.connectionIds?.length),
      isExternalMemoryEnabled: () => memoryRuntime.builtinMemory.getExternalMemoryMode() !== "none", getExternalMemoryMode: () => memoryRuntime.builtinMemory.getExternalMemoryMode(),
      syncWorkerConversation: async (ticket, ctx) => { if (hubRef) await hubRef.#syncSingleWorkerConversation(ticket, ctx); },
      prepareBuiltInStagedWorkspace: (ticket, ctx) => hubRef!.#prepareBuiltInStagedWorkspace(ticket, ctx),
      prepareWorkerCollaborationContext: (ticket, ctx) => hubRef!.#prepareWorkerCollaborationContext(ticket, ctx),
      inspectBuiltInStagedDiff: (ticket) => hubRef!.#inspectBuiltInStagedDiffSummary(ticket),
      discardBuiltInStagedWorkspace: (ticket) => hubRef!.#discardTicketStagedWorkspace(ticket).then(() => undefined),
      onTicketsChanged: notifyTicketsChanged,
      onTicketRunning: (ticketId, workerConversationId, runEpoch) => {
        if (hubRef) void hubRef.#watchdog.trackRunning(ticketId, workerConversationId, runEpoch).catch((error) => {
          if (hubRef && !hubRef.#closed) console.error("[KuloWorkerTracking]", redact(error instanceof Error ? error.message : String(error)));
        });
      },
      onTicketSettled: async (ticketId) => {
        if (hubRef) { hubRef.#externalTelemetry.clear(ticketId); hubRef.#watchdog.untrack(ticketId); await hubRef.#settleStaleTicketConfirmations(ticketId); void hubRef.memoryRuntime.onTicketSettled(ticketId).catch(() => {}); }
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
      onExternalTelemetry: (telemetry) => {
        if (!hubRef || hubRef.#closed) return;
        const updated = hubRef.#externalTelemetry.update(telemetry, redact);
        if (updated.changed && updated.current) {
          for (const listener of hubRef.#listeners) listener.onTicketTelemetry?.(updated.current);
        }
      },
      getWorkerModelContext: (ticket) => { const m = settingsStore.getModel(); return { rolePreset: settingsStore.getRoles()[ticket.role], defaultModel: { provider: m.defaultProvider, modelId: m.defaultModel, thinkingLevel: m.thinkingLevel } }; },
    });

    const schedulerExt = defineExtension({
      name: "kulo-scheduler",
      tasks: [workerTicketTask, failureRecoveryTask],
    });

    const controllerProxy: OrchestratorController = {
      connections,
      hostActions,
      webFetchContext: { getExecutionTrustMode: () => settingsStore.getExecutionTrustMode(), getLocalEnvId: () => envManager.localEnvId, getEnvDescriptor: (id) => envManager.getEnvDescriptor(id), getRemoteEnv: (id) => { const d = envManager.getEnvDescriptor(id); return d ? envManager.createExecutionEnv(id, d.rootDir, { executionMode: "trusted" }) : undefined; }, resolveOrchestratorTargetEnvId: (cid, tid, ctx) => hubRef!.#resolveOrchestratorTargetEnvId(cid, tid, ctx) },
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
      forgetMemory: (term, reason, caller, signal) => executeMemoryForget({ term, reason, caller, signal, host: { addForgottenTerm: (t, r) => hubRef!.personality.addForgottenTerm(t, r), forgetFromRelationship: (t, r) => hubRef!.personality.forgetFromRelationship(t, r), forgetFromWorkingMemory: (t, r) => hubRef!.memoryRuntime.forgetFromWorkingMemory(t, r), forgetFromBuiltinMemory: (t) => hubRef!.memoryRuntime.forgetFromBuiltinMemory(t), getMemoryConfig: getLiveMemory } }),
      setAgentExpression: (face, cue, ctx) => hubRef!.setAgentExpression(face, cue, ctx),
      handleBoardTool: (params, source, ctx) => hubRef!.#handleBoardTool(params, source, ctx),
    };

    const allOrchestratorSections = createOrchestratorSections({
      getAgentName,
      getLanguage: getLiveLanguage,
      getRoles: getLiveRoles,
      getExternalClients: () => settingsStore.getExternalClients(),
      getEnvs: () => envManager.listEnvs(), getExecutionTrustMode: () => settingsStore.getExecutionTrustMode(),
      getIdentityDir: getLiveIdentityDir,
      getMemoryConfig: getLiveMemory, getBuiltinMemoryState: () => ({ active: memoryRuntime.builtinMemory.isEffectiveActive(), sharedActive: memoryRuntime.builtinMemory.isSharedEffectiveActive() }),
      getMediaCapabilities: () =>
        hubRef
          ? hubRef.capabilities.snapshot()
          : Promise.resolve(EMPTY_MEDIA_CAPABILITIES),
      getPersonalityContext: () => hubRef!.personality.context(),
      freezeRecentWorkBaseline: true,
      isSystemBaselinePending: (conversationId, ctx) => isSystemBaselinePending(hubRef!.harness, conversationId, ctx),
    });
    const tailKeys = new Set(["kulo_envs", "kulo_projects", "kulo_recent_work", "kulo_working_memory"]);
    const headSections = allOrchestratorSections.filter((sec) => !tailKeys.has(sec.key));
    const tailSections = allOrchestratorSections.filter((sec) => tailKeys.has(sec.key));

    const orchestratorExt = createOrchestratorToolsExtension(
      controllerProxy,
      headSections,
      getLiveMemory,
      () => hubRef!.search,
      memoryRuntime.createBuiltinMemoryTools("private"),
    );
    const orchestratorTailExt = defineExtension({
      name: "kulo-orchestrator-tail",
      sections: tailSections,
      hooks: [
        createRecentWorkSyncHook({
          getHarness: () => hubRef!.harness,
          getPersonalityContext: () => hubRef!.personality.context(),
          redact,
        }),
      ],
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
    const migrationToolsExt = createMigrationToolsExtension({ service: () => hubRef!.migration, assertHubLocalDisplayTurn: () => hubRef!.settingsAssistant.assertHubLocalDisplayTurn(), redact });
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
            (cap !== "agent-browser" || computerController.settings.browserEnabled)
            && (cap !== "agent-desktop" || computerController.settings.desktopEnabled),
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
        const hasRegisteredAndroid = () =>
          envManager.listEnvs().some(
            (env) => env.executionKind === "native-device" && env.android?.enabled !== false,
          );
        const memoryKnowledgeForChat =
          hubRef!.#liveSettings.memory.enabled && Boolean(hubRef!.#liveSettings.memory.knowledgeGuidanceEnabled);
        const memoryKnowledgeForWorker =
          memoryKnowledgeForChat && hubRef!.#liveSettings.memory.accessMode !== "private-only";

        if (isOrchestratorConversation(api.conversationId, state)) {
          let platform: string | undefined;
          let capabilities: string[] = [];
          if (requirements.targetDevice) {
            const target = requirements.catalogOnly
              ? await hubRef!.#resolveOrchestratorCatalogSkillTarget(
                  Number(api.conversationId),
                  api.taskId !== undefined ? Number(api.taskId) : undefined,
                  context,
                )
              : await hubRef!.#resolveOrchestratorSkillTarget(
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
            androidAvailable: requirements.android
              ? (requirements.catalogOnly ? hasRegisteredAndroid() : hasOnlineAndroid())
              : false,
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
            androidAvailable: requirements.android
              ? (requirements.catalogOnly ? hasRegisteredAndroid() : hasOnlineAndroid())
              : false,
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
            memoryKnowledgeEnabled: Boolean(scope.ticket.projectId) && memoryKnowledgeForWorker,
          };
        }
        try {
          return {
            ...target,
            reactWorkspace: await detectReactWorkspace(api.env, context),
            executionDomain: "computer",
            mediaKinds,
            androidAvailable,
            memoryKnowledgeEnabled: Boolean(scope.ticket.projectId) && memoryKnowledgeForWorker,
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
            memoryKnowledgeEnabled: Boolean(scope.ticket.projectId) && memoryKnowledgeForWorker,
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
        hubRef!.#topics.refreshTopic(source.topicId);
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
      watchRules: hubRef!.assistantWatchRules,
      isConversationInProactiveWake: (convId) => hubRef!.assistantProactiveWake.isConversationInProactiveWake(convId),
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
    const readOnlyAndroidTierExt = createReadOnlyAndroidTierExtension();
    const contextCompaction = createContextCompactionController({
      getHarness: () => hubRef!.harness,
      getKernel: () => hubRef!.#getContextKernel(),
      isActive: () => hubRef ? hubRef.#contextEnabled : false,
      getReserveTokens: () => settingsStore.getCompactionConfig().reserveTokens,
      onCompactionBaseline: async (conversationId, firstKept, ctx) => {
        if (hubRef) { await hubRef.#projection.pruneCompactedConversationTools(conversationId, firstKept, ctx); void hubRef.memoryRuntime.onCompactionCommitted(conversationId, firstKept, BACKGROUND_CONTEXT).catch(() => {}); }
      },
    });
    const registry = createRegistry();
    registry.install(redactionExt); registry.install(toolOverflowExt);
    registry.install(memoryRuntime.memoryFlushExt); registry.install(memoryRuntime.builtinMemoryRecallExt); registry.install(runHealth.extension);
    registry.install(schedulerExt); registry.install(codingToolsExt);
    registry.install(androidExt); registry.install(toolSearchExt);
    registry.install(settingsTierExt); registry.install(computerMixedAndroidTierExt);
    registry.install(readOnlyAndroidTierExt); registry.install(orchestratorGuardExt);
    registry.install(computerUseExt); registry.install(routerReadExt);
    registry.install(workerExt); registry.install(orchestratorExt);
    registry.install(orchestratorTailExt); registry.install(globalSettingsExt);
    registry.install(settingsAssistantExt); registry.install(deviceToolsExt); registry.install(migrationToolsExt);
    if (customizationExt) registry.install(customizationExt);
    registry.install(appearanceCustomizationExt); registry.install(modelConfigurationExt);
    registry.install(agentConfigurationExt); registry.install(contentExt);
    registry.install(projectExt); registry.install(skillExt);
    registry.install(capabilitySetupExt); registry.install(mediaExt);
    registry.install(voiceExt); registry.install(mediaExportExt);
    registry.install(memoryLifecycleExt); registry.install(memoryServiceExt);
    registry.install(memorySetupExt); registry.install(extensionsExt);
    registry.install(extensionSetupExt); registry.install(historyExt);
    registry.install(assistantToolsExt); registry.install(contextCompaction.extension);

    const harness = await Harness.open(
      storage,
      {
        models: withKuloCompactionFocus(models),
        registry,
        identity: { attribution: null },
        settings: () => {
          const liveComp = settingsStore.getCompactionConfig();
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
                  readOnly: activeSettings, executionKey: `orchestrator-topic:${topic.id}`,
                });
              });
            }
            // Hub-hosted tools such as search and settings remain available without an online execution node.
            const selection = selectOrchestratorDefaultEnv({
              listEnvs: () => envManager.listEnvs(), localEnvId: envManager.localEnvId, isLocalEnv: (id) => envManager.isLocalEnv(id),
              getEnvDescriptor: (id) => envManager.getEnvDescriptor(id), pickDefaultEnvId: () => envManager.pickDefaultEnvId(),
              targetCwd: target.cwd, mainWorkspaceDir, topicTargetDeviceId: topic?.targetDeviceId, activeSettings, hubTrustMode: settingsStore.getExecutionTrustMode(),
            });
            if (!selection) return undefined;
            const execOptions = { ...(activeSettings ? { sandboxed: true, readOnly: true } : {}), offline: false };
            if (selection.activeEnvId) return envManager.createExecutionEnv(selection.activeEnvId, selection.cwd, execOptions);
            return lazyProjectEnvironment(`kulo-env:${selection.candidateEnv.id}`, selection.cwd, async () => {
              const lazy = selection.resolveLazy(settingsStore.getExecutionTrustMode());
              return envManager.createExecutionEnv(lazy.envId, lazy.cwd, execOptions);
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
          const frozenMode = state?.ticketExecutionModes?.[ticket.id];
          return envManager.createWorkerExecutionEnv(
            ticket.envId,
            activeStagedCwd ? effectiveWorkspaceDir : (target.cwd ?? effectiveWorkspaceDir),
            {
              scratchDir: ticket.scratchDir,
              projectId: ticket.projectId,
              grantRevision: ticket.grantRevision,
              readOnly: execScope?.readOnly,
              executionKey: ticket.id,
              ...(frozenMode?.runEpoch === ticket.runEpoch ? { executionMode: frozenMode.mode } : {}),
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
    const failoverGuarded = hasFailoverTrustGuard(config.stateDir);
    const bootWasFailover = failoverGuarded;
    const hydratedSettings = await harness.commit(async (tx) => {
      const stateDoc = await tx.doc(KuloStateDoc);
      const settingsDoc = await tx.doc(KuloSettingsDoc);
      hydrateSettingsFromConfig(settingsDoc, config, { hasGatewayCredential });
      if (failoverGuarded && settingsDoc.executor.executionTrustMode === "trusted") {
        settingsDoc.executor.executionTrustMode = "sandboxed";
        settingsDoc.executionTrustModeRevision = (settingsDoc.executionTrustModeRevision ?? 1) + 1;
      }
      assertMemoryIdentitySeparation(settingsDoc.memory, config, envManager);
      ensureDefaultRootTopic(stateDoc, settingsDoc.presentation.agentName);
      return cloneJson(settingsDoc) as KuloDurableSettings;
    }, context);
    if (failoverGuarded) clearFailoverTrustGuard(config.stateDir);

    settingsStore.hydrate(hydratedSettings);
    envManager.setExecutionTrustMode(settingsStore.getExecutionTrustMode(), settingsStore.getExecutionTrustModeRevision());
    connectionManager.setExecutionTrustModeProvider(() => settingsStore.getExecutionTrustMode(), () => settingsStore.getBlockedSecretEnvNames());
    const effectiveIdentityDir = settingsStore.getIdentityDir();
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
    const bootState = await harness.snapshot(KuloStateDoc, context);
    const activeRootConvId = resolveActiveRootConversationId(bootState);
    const rootAgent = {
      model: orchestratorAgent.model,
      thinkingLevel: orchestratorAgent.thinkingLevel,
      extensions: [redactionExt, toolOverflowExt, orchestratorExt, codingToolsExt, orchestratorGuardExt, computerUseExt, toolSearchExt, contentExt, projectExt, skillExt, orchestratorTailExt, memoryRuntime.builtinMemoryRecallExt, runHealth.extension, mediaExt, voiceExt, memoryServiceExt, memorySetupExt, historyExt, assistantToolsExt, globalSettingsExt, ...(customizationExt ? [customizationExt] : []), contextCompaction.extension],
      cwd: mainWorkspaceDir,
      maxTurns: ORCHESTRATOR_MAX_TURNS,
    };
    const initialRoot = await harness.root(context, activeRootConvId === Number(ROOT_CONVERSATION_ID) ? { agent: rootAgent } : undefined);
    const rootConversation = activeRootConvId === Number(ROOT_CONVERSATION_ID)
      ? initialRoot
      : (await harness.conversation(activeRootConvId as ConversationId, context)) ?? initialRoot;
    await rootConversation.configure(rootAgent, context);

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
      settingsStore,
      workerTicketTask,
      failureRecoveryTask,
      codingToolsExt,
      androidExt,
      toolSearchExt,
      settingsTierExt,
      computerMixedAndroidTierExt,
      readOnlyAndroidTierExt,
      orchestratorGuardExt,
      computerController,
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
      deviceToolsExt, migrationToolsExt, migrationHomeDir: init.migrationHomeDir,
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
      toolOverflowExt,
      runHealth,
      memoryRuntime,
      credentialStore,
      voiceAsr: init.voiceAsr,
      voiceOpenLive: init.voiceOpenLive,
      watchdogCheckIntervalMs: init.watchdogCheckIntervalMs ?? 30_000,
      ...(init.watchdogStallMsOverride !== undefined
        ? { watchdogStallMsOverride: init.watchdogStallMsOverride }
        : {}),
      bootGate,
      bootWasFailover,
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
    hub.#computer.setInitialSettings((await hub.capabilities.computerUseSettings()).computerUse);
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
    void hub.assistantSorter.recoverUndigested().catch(() => {});
    if (assistantSnap?.enabled) {
      envManager.setConnectorConfig({
        driverId: "macos-notifications",
        enabled: true,
        mutedApps: assistantSnap.mutedApps ?? [],
      });
    }
    void hub.assistantLedger.pruneExpiredBodies().catch(() => {});

    await hub.#ensureTopicWatched("root", rootConversation, context);
    await hub.#mainArchive.finalizeMainArchive(context).catch((err) => {
      console.warn("[KuloMainArchive] Startup finalize deferred", err);
    });

    // Reattach only unfinished topic sources before Durable resumes them; idle histories stay unloaded.
    const [unfinished, topicState] = await Promise.all([
      harness.inspect(context), harness.snapshot(KuloStateDoc, context),
    ]);
    const activeConversations = new Set(unfinished.submissions.map((submission) => Number(submission.conversationId)));
    for (const topic of Object.values(topicState?.topics ?? {})) {
      if (!topic.deletedAt && topic.title) hub.#topics.setCachedTitle(topic.id, topic.title);
      if (topic.deletedAt || !activeConversations.has(topic.conversationId) || hub.#topics.hasCache(topic.id)) continue;
      const conversation = await harness.conversation(topic.conversationId as ConversationId, context);
      if (conversation) await hub.#ensureTopicWatched(topic.id, conversation, context);
    }
    await hub.#reconfigureOrchestratorConversations(context);

    const restartInspections = await inspectBuiltInTicketsForRestartGate(harness, topicState, context);
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
        // Positive read-only proof MUST evaluate oldEpoch strictly before incrementing runEpoch.
        const oldEpoch = ticket.runEpoch;
        const inspection = restartInspections.get(ticket.id);
        const decision = evaluateTicketRestartAutoResume({
          ticket,
          oldEpoch,
          wasGracefulRestart: bootGate.wasGracefulRestart,
          bootWasFailover,
          crashLoopTripped: bootGate.crashLoopTripped,
          executedTools: inspection?.executedTools,
          historyVerified: inspection?.historyVerified ?? false,
          hasActiveSubagents: inspection?.hasActiveSubagents ?? false,
          redact,
        });
        const now = Date.now();
        // abortConversation resumes Durable's driver, so fence every old run before the first abort.
        ticket.runEpoch++;
        transitionTicketStatus(ticket, "pausing", now);
        applyTicketRestartDecision(ticket, decision, now, redact);
        ticket.cleanupPending = true;
        if (!state.slots.holders.includes(ticket.id)) state.slots.holders.push(ticket.id);
      }
    }, context);
    await preAbortFencedWorkerTasks(harness, topicState, unfinished, restartInspections, context);
    if (bootWasFailover || bootGate.crashLoopTripped) {
      await abortActiveOrchestratorConversationsBeforeResume(harness, topicState, unfinished, activeRootConvId, context);
      await hub.sideQuestions.interruptActiveOnFailover(context);
    }
    await hub.projects.reconcileCancellations(context);
    await hub.#queueWaitReconcile();
    await hub.#queueEnvReconcile();
    await hub.extensions.initialize();
    await hub.#chat.recoverChatAttachments(context);
    await hub.assistantCoordinator.start(context);
    hub.#recovering = false;
    await hub.#reconcileDispatchedConfirmations(context);
    await hub.#failureRecovery.startLegacyRecovery(context);
    await hub.mediaJobs.start();
    await hub.usageCaps.start();
    await hub.personality.start();
    hub.#watchdog.start();
    harness.resume();
    await hub.#topics.startTitles(context);
    await hub.settingsAssistant.start();
    await hub.#mediaDelivery.reconcilePendingRelays();

    await hub.archiveInactiveTopics(context);
    hub.#topics.startAutoArchive();
    await hub.sideQuestions.start(context);
    hub.#startUploadCleanup();
    await hub.memoryRuntime.start({ hasCustomStorage: Boolean(init.storage), isKnownSecret });
    hub.#bootCompleted = true;
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
    return this.#computer.listComputerPreviews(topicId);
  }

  async subscribeComputerPreview(id: string, topicId: string, listener: (update: ComputerPreviewUpdate) => void): Promise<() => void> {
    return this.#computer.subscribeComputerPreview(id, topicId, listener);
  }

  async sendComputerPreviewInput(id: string, topicId: string, event: ComputerPreviewInputEvent): Promise<boolean> {
    return this.#computer.sendComputerPreviewInput(id, topicId, event);
  }

  async resolveComputerHandoff(
    ticketId: string,
    action: "done" | "cancel" | "expired",
    manualInstruction?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ ok: boolean; status: string }> {
    return this.#computer.resolveComputerHandoff(ticketId, action, manualInstruction, context);
  }

  async removeConnection(id: string): Promise<void> {
    return this.#connectionsBridge.removeConnection(id);
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

  async #relayConnectionRequest(ticketId: string): Promise<void> {
    return this.#ticketReconciler.relayConnectionRequest(ticketId);
  }

  async getCapabilitiesSnapshot(clientId?: string): Promise<CapabilitiesWorkspaceSnapshot> {
    const [capabilities, skills, jobs, inputs, search, extensions, imageSetup] = await Promise.all([
      this.capabilities.snapshot(), this.skills.snapshot(), this.mediaJobs.list(), this.capabilities.listInputs(clientId), this.search.snapshot(),
      this.extensions.snapshot(clientId), this.imageConfiguration.workspace(clientId),
    ]);
    return { ...capabilities, skills: skills.skills, skillRevision: skills.revision, jobs, inputs, search, extensions, imageSetup };
  }

  async configureComputerUse(input: ComputerUseConfigurationInput): Promise<{ computerUse: ComputerUseSettings; revision: number }> {
    return this.#computer.configureComputerUse(input);
  }

  setMediaRelayTimingForTest(options: { batchCoalesceMaxMs?: number; busyRecheckMs?: number }): void { this.#mediaDelivery.setRelayTimingForTest(options); }

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

  async #voiceTopic(topicId: string, allowArchived = false) {
    const state = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const topic = state?.topics && Object.hasOwn(state.topics, topicId) ? state.topics[topicId] : undefined;
    if (!topic || topic.deletedAt) throw new VoiceError(404, "voice_topic_not_found", "通话所属会话不存在或已删除。");
    if (!allowArchived && topic.archived) throw new VoiceError(409, "topic_archived", "会话已归档，请还原后再发起语音通话。");
    if (topic.projectId) await this.projects.ensureAuthorized(topic.projectId, BACKGROUND_CONTEXT);
    return this.#resolveWatchedTopic(topicId, BACKGROUND_CONTEXT);
  }

  async #resolveVoiceConversation(topicId: string, conversationId?: number, allowArchived = true): Promise<ResolvedVoiceConversation | undefined> {
    if (conversationId !== undefined) return resolveBoundVoiceConversation(this.harness, conversationId, allowArchived, BACKGROUND_CONTEXT);
    const cache = await this.#voiceTopic(topicId, allowArchived);
    return { conversation: cache.conversation, conversationId: Number(cache.conversation.id), topicId: cache.topicId, archived: false };
  }

  async #recordVoiceTranscript(topicId: string, event: Extract<VoiceCallEvent, { type: "transcript" }>, callId: string, conversationId?: number): Promise<boolean> {
    if (!event.final || !event.text.trim() || this.#closed) return false;
    const target = await this.#resolveVoiceConversation(topicId, conversationId, true);
    if (!target) return false;
    return persistVoiceTranscript({
      target, event, callId,
      processUserText: async (text) => (await this.connectionManager.processText(text)).text,
      redact: (text) => this.connectionManager.redact(text),
      refreshConversation: (id) => this.#topics.refreshByConversation(id),
      recordTopicActivity: (id, preview, convId) => this.#topics.recordTopicActivity(id, preview, convId),
    }, BACKGROUND_CONTEXT);
  }

  async #recordVoiceCallSummary(input: VoiceCallSummaryInput): Promise<void> {
    if (this.#closed || input.turnCount < 1) return;
    const target = await this.#resolveVoiceConversation(input.topicId, input.conversationId, true);
    if (!target) return;
    await persistVoiceCallSummary({
      harness: this.harness, target, input,
      redact: (text) => this.connectionManager.redact(text),
      refreshConversation: (id) => this.#topics.refreshByConversation(id),
    }, BACKGROUND_CONTEXT);
  }

  async getVoiceCallTranscript(topicId: string, callId: string, context: Context = BACKGROUND_CONTEXT): Promise<VoiceCallTranscriptTurn[]> {
    const cleanCallId = callId.trim();
    if (!cleanCallId || cleanCallId.length > 240 || /[\x00-\x1f\x7f]/.test(cleanCallId)) {
      throw new VoiceError(400, "invalid_voice_call", "通话标识无效。");
    }
    const cache = await this.#voiceTopic(topicId || "root", true);
    return readVoiceCallTranscriptTurns(cache.conversation, cleanCallId, (text) => this.connectionManager.redact(text), context);
  }

  async transcribeVoiceAsset(assetId: string, options: { topicId?: string; principalId: string }, context: Context = BACKGROUND_CONTEXT): Promise<ChatAttachment> {
    const cache = await this.#voiceTopic(options.topicId || "root", true);
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
      this.#topics.refreshAll();
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
    return this.#mediaDelivery.mediaSource(conversationId);
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

  async #resolveAndroidAssets(
    scope: AndroidToolScope & { deviceId: string; supportsImages: boolean; stageForUser?: boolean },
    result: import("@kulo/protocol").AndroidResult,
  ) {
    return resolveAndroidToolAssets(
      {
        uploads: this.uploads,
        snapshotState: () => this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT),
        stageWorkerArtifact: (asset, source, callId) => this.#stageWorkerArtifact(asset, source, callId),
      },
      scope,
      result,
    );
  }

  #androidTargets(ticket: Readonly<TicketRecord>): string[] {
    return androidTargetsOf(ticket);
  }

  #ticketDevicesOnline(ticket: Readonly<TicketRecord>): boolean {
    return areTicketDevicesOnline(ticket, (id) => this.envManager.getEnvDescriptor(id));
  }

  #surfaceRuntimeState(
    audience: ToolSurfaceAudience,
    extra: Partial<Omit<ToolSurfaceRuntimeState, "audience">> = {},
  ): ToolSurfaceRuntimeState {
    const effMem = this.#effectiveMemoryConfig(this.#liveSettings.memory);
    const sharedMemoryEnabled = effMem.enabled && effMem.accessMode !== "private-only";
    const deviceView = this.#deviceController?.view();
    return {
      audience,
      memoryEnabled: effMem.enabled,
      sharedMemoryEnabled,
      builtinMemoryEnabled: this.memoryRuntime.builtinMemory.isEffectiveActive(), builtinSharedMemoryEnabled: this.memoryRuntime.builtinMemory.isSharedEffectiveActive(),
      ttsEnabled: this.#ttsEnabled,
      webSearchAvailable: this.#webSearchAvailable,
      customizationEnabled: Boolean(this.config.customization),
      deviceInviteAvailable: deviceView?.role === "hub",
      computerUseBrowserEnabled: this.#computer.settings.browserEnabled, computerUseDesktopEnabled: this.#computer.settings.desktopEnabled, executionTrustMode: this.#settingsStore.getExecutionTrustMode(),
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
      this.#toolOverflowExt,
      this.#orchestratorExt,
      this.#codingToolsExt,
      this.#orchestratorGuardExt,
      this.#computerUseExt,
      this.#toolSearchExt,
      this.#contentExt,
      this.#projectExt,
      this.#skillExt,
      this.#orchestratorTailExt,
      this.memoryRuntime.builtinMemoryRecallExt, this.#runHealth.extension,
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
    readOnly = false,
  ): ReturnType<typeof defineExtension>[] {
    if (executionDomain === "android") {
      return [
        this.#redactionExt,
        this.#androidExt,
        ...(readOnly ? [this.#readOnlyAndroidTierExt] : []),
        this.#toolSearchExt,
        this.#workerExt,
        this.#contentExt,
        this.#skillExt,
        this.#runHealth.extension, this.#contextCompaction.extension,
      ];
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
      this.#runHealth.extension, this.#contextCompaction.extension,
    ];
  }

  #workerTools(options: {
    executionDomain: "computer" | "android" | undefined; androidTargetIds: readonly string[];
    allowSubagents: boolean; isSubagent?: boolean; readOnly?: boolean; hasProject?: boolean;
  }): { extensions: ReturnType<typeof defineExtension>[]; tools: ToolRegistration[] } {
    const extensions = this.#workerExtensions(options.executionDomain, options.androidTargetIds, Boolean(options.readOnly));
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
      this.#surfaceRuntimeState(audience, { allowSubagents: options.allowSubagents, readOnly: options.readOnly, androidTargets, ...(options.hasProject ? {} : { sharedMemoryEnabled: false, builtinSharedMemoryEnabled: false }) }),
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
    return this.#mediaDelivery.validateMediaInput(assetId, source);
  }

  async #validateMediaSource(source: MediaJobSource, job?: MediaJob): Promise<void> {
    return this.#mediaDelivery.validateMediaSource(source, job);
  }

  async #stageWorkerArtifact(asset: ChatAttachment, source: MediaJobSource, callId: string): Promise<void> {
    return this.#mediaDelivery.stageWorkerArtifact(asset, source, callId);
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
    await this.#topics.unwatchDeletedTopics(state, BACKGROUND_CONTEXT);
  }

  #queueWaitReconcile(): Promise<void> {
    return this.#ticketReconciler.queueWaitReconcile();
  }

  #queueEnvReconcile(): Promise<void> {
    return this.#ticketReconciler.queueEnvReconcile();
  }

  async #prepareBuiltInStagedWorkspace(
    ticket: Readonly<TicketRecord>,
    context: Context,
  ): Promise<{ stagedCwd: string; reused: boolean; warnings?: string[] }> {
    return this.#stagedApply.prepareBuiltInStagedWorkspace(ticket, context);
  }

  async #inspectBuiltInStagedDiffSummary(
    ticket: Readonly<TicketRecord>,
  ): Promise<StagedWorkspaceDiffSummary | undefined> {
    return this.#stagedApply.inspectBuiltInStagedDiffSummary(ticket);
  }

  async #discardTicketStagedWorkspace(ticket: Readonly<TicketRecord>): Promise<boolean> {
    return this.#stagedApply.discardTicketStagedWorkspace(ticket);
  }

  async #releaseTicketExecution(ticket: Readonly<TicketRecord>, options: { park?: boolean } = {}): Promise<{ cleanupPending: boolean }> {
    return this.#ticketReconciler.releaseTicketExecution(ticket, options);
  }

  async #resumeWaitingTicket(ticketId: string, context: Context): Promise<void> {
    return this.#ticketReconciler.resumeWaitingTicket(ticketId, context);
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
    return this.#topics.listTopics(context);
  }

  async archiveInactiveTopics(context: Context = BACKGROUND_CONTEXT): Promise<TopicSummary[]> {
    return this.#topics.archiveInactiveTopics(context);
  }

  async createTopic(title?: string, context: Context = BACKGROUND_CONTEXT, projectId?: string | null, options?: { draft?: boolean }): Promise<TopicSummary> { return this.#topics.createTopic(title, context, projectId, options); }
  async patchTopic(topicId: string, patch: { title?: string; pinned?: boolean; archived?: boolean; targetDeviceId?: string | null }, context: Context = BACKGROUND_CONTEXT): Promise<TopicSummary> { return this.#topics.patchTopic(topicId, patch, context); }
  async deleteTopic(topicId: string, context: Context = BACKGROUND_CONTEXT, options: { stopTasks?: boolean } = {}): Promise<{ deleted: string; topics: TopicSummary[] }> { return this.#topics.deleteTopic(topicId, context, options); }
  async compactTopic(topicId: string, context: Context = BACKGROUND_CONTEXT) { return this.#contextGuard.compactTopic(topicId, context); }
  async getTopicView(topicId = "root", context: Context = BACKGROUND_CONTEXT): Promise<TopicView> { return this.#topics.getTopicView(topicId, context); }

  async publishCurrentTopicView(topicId: string, publish: (view: TopicView) => void, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    return this.#topics.publishCurrentTopicView(topicId, publish, context);
  }

  getTopicHistoryBefore(topicId: string): number | undefined {
    return this.#topics.getTopicHistoryBefore(topicId);
  }

  async getTopicHistory(topicId: string, before: number, context: Context = BACKGROUND_CONTEXT) {
    return this.#topics.getTopicHistory(topicId, before, context);
  }

  searchConversations(input: ConversationSearchInput, context: Context = BACKGROUND_CONTEXT) {
    return this.#topics.searchConversations(input, context);
  }

  getTopicMessageWindow(topicId: string, messageId: number, context: Context = BACKGROUND_CONTEXT) {
    return this.#topics.getTopicMessageWindow(topicId, messageId, context);
  }

  listTopicFiles(topicId: string, input: { cursor?: string; limit?: number } = {}, context: Context = BACKGROUND_CONTEXT) {
    return this.#topics.listTopicFiles(topicId, input, context);
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
    return this.#externalClientAdmin.refreshModels(clientId, context);
  }

  async verifyExternalClient(
    clientId: string,
    options: { commandId?: string; expectedRevision?: number } = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<import("@kulo/protocol").ExternalAgentVerifyClientResult> {
    return this.#externalClientAdmin.verifyClient(clientId, options, context);
  }

  async removeExternalClient(
    clientId: string,
    expectedRevision?: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ settings: KuloSettingsView }> {
    return this.#externalClientAdmin.removeClient(clientId, expectedRevision, context);
  }

  async rollbackSettings(
    toRevision: number,
    expectedGlobalRevision: number,
    context: Context = BACKGROUND_CONTEXT,
    options?: { allowTrustModeChange?: boolean },
  ): Promise<{ settings: KuloSettingsView; summary: string }> {
    const { nextDoc, summary } = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      const state = await tx.doc(KuloStateDoc);
      if (Object.values(state.tickets).some((ticket) => ticket.status === "running")) {
        throw new SettingsUpdateError(400, "请先停止正在运行的后台任务，再恢复历史设置。");
      }
      const msg = rollbackSettingsToSnapshot(doc, toRevision, expectedGlobalRevision, this.config.memory, options);
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
    return computeHubUsageStats(
      {
        harness: this.harness,
        getSettingsAssistantConversationIds: () => this.settingsAssistant.conversationIds(),
        getRelationshipReviewConversationIds: async (ctx) =>
          (await this.harness.snapshot(RelationshipReviewsDoc, ctx))?.conversationIds ?? [],
        getDefaultModel: () => this.#liveSettings.model.defaultModel,
        defaultProviderId: this.#providerId,
      },
      range,
      context,
    );
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
    return collectRelationshipInput(this.harness, since);
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

    this.#settingsStore.setExpression(nextDoc.expression);
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
    return this.#chat.hasSubmittedRequest(topicId, requestId, context);
  }

  async #deliveryReceipt(intent: DeliveryIntent, context: Context): Promise<Readonly<DeliveryReceipt> | undefined> {
    return this.#delivery.deliveryReceipt(intent, context);
  }

  async deliverClientMessage(message: ReliableClientMessage, principalId = this.envManager.localEnvId, context: Context = BACKGROUND_CONTEXT,
    source?: ChatMessageSource): Promise<DeliveryAck & { deduplicated?: boolean }> {
    if (!this.#acceptingNewWork || this.#closed) {
      throw new ProjectError(503, "hub_closing", "中枢正在退出，请稍后重试。");
    }
    if (this.#handoverBarrierActive && message.type !== "chat.abort") {
      throw new ProjectError(503, "cluster_handover_in_progress", "主机正在切换，请稍候。");
    }
    validateReliableClientMessage(message);
    const intent = clientDeliveryIntent(message, principalId);
    let fallback: DeliveryAck;
    switch (message.type) {
      case "chat.send": {
        const submission = await this.sendUserMessage(message.content, { topicId: message.topicId || "root", requestId: message.requestId,
          attachments: message.attachments, replyTo: message.replyTo, whenBusy: message.whenBusy, targetDeviceId: message.targetDeviceId,
          ...(message.expectedConversationId !== undefined ? { expectedConversationId: message.expectedConversationId } : {}),
          principalId, source, deliveryIntent: intent }, context);
        const status = await submission.status(context);
        fallback = { topicId: message.topicId || "root", conversationId: Number(status.conversationId), submissionId: Number(status.id), delivery: status.status === "queued" ? "queued" : "accepted" };
        break;
      }
      case "chat.abort":
        await this.abortForegroundTurn(message.topicId || "root", context, intent, message.expectedConversationId);
        fallback = { topicId: message.topicId || "root" }; break;
      case "chat.retry":
        await this.retryTurn(message.topicId || "root", message.requestId, context, intent, message.expectedConversationId);
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

  /** Submit a user message to the selected topic conversation (defaults to `"root"`). */
  async sendUserMessage(
    content: string,
    options: MessageSubmissionOptions = {},
    context: Context = BACKGROUND_CONTEXT,
  ) {
    if ((!this.#acceptingNewWork && !options.voiceDelegation) || this.#closed) {
      throw new ProjectError(503, "hub_closing", "中枢正在退出，请稍后重试。");
    }
    return this.#chat.sendUserMessage(content, options, context);
  }

  #queueTicketOperation<T>(ticketId: string, operation: () => Promise<T>): Promise<T> {
    return this.#delivery.queueTicket(ticketId, operation);
  }

  /** Abort only the foreground Kulo turn in the target topic (background Workers continue undisturbed!). */
  async abortForegroundTurn(
    topicId = "root",
    context: Context = BACKGROUND_CONTEXT,
    intent?: DeliveryIntent,
    expectedConversationId?: number,
  ): Promise<void> {
    return this.#chat.abortForegroundTurn(topicId, context, intent, expectedConversationId);
  }

  /** Retry the most recent unanswered turn in an idle topic without re-sending user input. */
  async retryTurn(
    topicId = "root",
    requestId?: string,
    context: Context = BACKGROUND_CONTEXT,
    suppliedIntent?: DeliveryIntent,
    expectedConversationId?: number,
  ): Promise<{ retried: boolean }> {
    return this.#chat.retryTurn(topicId, requestId, context, suppliedIntent, expectedConversationId);
  }

  /** Atomically archive the current main conversation ("root") and rotate to a fresh empty conversation. */
  async archiveMainConversation(
    input: ArchiveMainConversationInput,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ArchiveMainConversationResult> {
    if (!this.#acceptingNewWork || this.#closed) {
      throw new ProjectError(503, "hub_unavailable", "中枢当前不可执行主对话归档，请稍后重试。");
    }
    return this.#mainArchive.archiveMainConversation(input, context);
  }

  /** Dispatch a durable Worker Ticket onto Kulo's table. */
  async dispatchTicket(
    params: DispatchTicketParams,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<TicketCardView> {
    return this.#ticketDispatch.dispatchTicket(params, context);
  }

  #notifyInlineWaiters(ticketId: string): void {
    this.#inlineWaiters.notify(ticketId);
  }

  async dispatchTicketForModel(
    params: DispatchTicketParams,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<DispatchTicketModelOutcome> {
    return this.#ticketDispatch.dispatchTicketForModel(params, context);
  }

  #ticketAgentBlock(ticket: Readonly<TicketRecord>): string | undefined {
    return evaluateTicketAgentBlock(ticket, this.#liveSettings.roles, this.#liveSettings.externalClients, this.#liveSettings.presentation.language);
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
        ...(option.action === "stop" ? { action: "stop" as const } : {}),
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
      message: "已向用户发起任务决策确认（支持按钮选择、手动输入或在聊天中直接回复，对话不阻塞；若用户在聊天中回复继续方案，调用 kulo_steer 即可恢复任务并自动收口卡片；若用户明确取消、暂不授权或要求结束任务，请直接调用 kulo_stop，系统会直接停止任务并自动收口卡片，切勿用 kulo_steer 让 Worker 自行结束）。",
    };
  }

  async #applyStagedChangesFromTool(
    params: ApplyStagedChangesParams,
    source: { conversationId: number; callId: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<StagedWorkspaceApplyResult | Record<string, unknown>> {
    return this.#stagedApply.applyStagedChangesFromTool(params, source, context);
  }

  async respondExternalAgentPermission(ticketId: string, permissionId: string, choiceId: string, runEpoch: number, context: Context = BACKGROUND_CONTEXT): Promise<WorkerInspectResult> {
    return this.#externalRuntime.respondPermission(ticketId, permissionId, choiceId, runEpoch, context);
  }

  async inspectStagedDiff(ticketId: string, filePath?: string, context: Context = BACKGROUND_CONTEXT): Promise<StagedWorkspaceDiffDetail> {
    return this.#stagedApply.inspectStagedDiff(ticketId, filePath, context);
  }

  async applyStagedChanges(params: ApplyStagedChangesParams, context: Context = BACKGROUND_CONTEXT): Promise<StagedWorkspaceApplyResult> {
    return this.#stagedApply.applyStagedChanges(params, context);
  }

  async #materializeExternalAttachments(
    ticket: Readonly<TicketRecord>,
    attachmentIds: readonly string[],
    context: Context,
    options?: { subdir?: string },
  ): Promise<Array<{ id: string; name: string; mimeType: string; path: string; size?: number; sha256?: string }>> {
    return this.#externalRuntime.materializeAttachments(ticket, attachmentIds, context, options);
  }

  async #consumeExternalPendingReports(
    ticket: Readonly<TicketRecord>,
    reports: readonly ExternalAgentPendingReport[],
    context: Context,
  ): Promise<string[]> {
    return this.#externalRuntime.consumePendingReports(ticket, reports, context);
  }

  async #verifyExternalAgent(draft: AgentConfigurationDraft, nonce: string): Promise<{ sessionId?: string; version?: string }> {
    return this.#externalClientAdmin.verifyRoundtrip(draft, nonce);
  }

  async retryTicket(
    ticketId: string,
    context: Context = BACKGROUND_CONTEXT,
    commandId?: string,
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    return this.#ticketControl.retryTicket(ticketId, context, commandId, suppliedIntent);
  }

  async resumeTicketWithOverride(ticketId: string, input: TicketResumeOverrideRequest, context: Context = BACKGROUND_CONTEXT, principalId = "local"): Promise<TicketResumeOverrideResponse> {
    return this.#ticketQuotaResume.resumeWithOverride(ticketId, input, context, principalId);
  }

  async steerTicket(
    params: SteerTicketParams,
    context: Context = BACKGROUND_CONTEXT,
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    return this.#ticketControl.steerTicket(params, context, suppliedIntent);
  }

  async stopTicket(
    ticketId: string,
    reason: string | undefined,
    context: Context = BACKGROUND_CONTEXT,
    commandIdOrOrigin?: string | { conversationId: number; toolTaskId: number },
    originArgument?: { conversationId: number; toolTaskId: number },
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    return this.#ticketControl.stopTicket(ticketId, reason, context, commandIdOrOrigin, originArgument, suppliedIntent);
  }

  async #settleStaleTicketConfirmations(ticketId: string): Promise<void> {
    return this.#ticketControl.settleStaleTicketConfirmations(ticketId);
  }

  #finalizeTicketStopDeps() {
    return this.#ticketControl.finalizeTicketStopDeps();
  }

  async #runSubagents(req: RunSubagentsRequest, context: Context = BACKGROUND_CONTEXT): Promise<SubagentTaskOutcome[]> {
    return this.#subagentRunner.runSubagents(req, context);
  }

  async #handleBoardTool(
    params: BoardToolParams,
    source: { conversationId: number },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Record<string, unknown>> {
    const redact = (text: string) => this.connectionManager.redact(text);
    if (params.action === "search") {
      const [state, projects, settings] = await Promise.all([
        this.harness.snapshot(KuloStateDoc, context),
        this.harness.snapshot(KuloProjectsDoc, context),
        this.harness.snapshot(SettingsAssistantDoc, context),
      ]);
      const matches = searchTaskBoards(
        state,
        projects,
        settings,
        source.conversationId,
        params.query ?? "",
        params.includeArchived !== false,
        redact,
      );
      return { boards: matches, count: matches.length };
    }
    if (params.action === "read") {
      if (!params.boardId?.trim()) throw new ProjectError(400, "board_id_required", "读取交接板须提供 board_id。");
      const [state, projects, settings] = await Promise.all([
        this.harness.snapshot(KuloStateDoc, context),
        this.harness.snapshot(KuloProjectsDoc, context),
        this.harness.snapshot(SettingsAssistantDoc, context),
      ]);
      return { board: readTaskBoard(state, projects, settings, source.conversationId, params.boardId, redact) };
    }
    if (!params.commandId?.trim()) throw new ProjectError(400, "invalid_command_id", "写入交接板须提供唯一 command_id。");
    const outcome = await this.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const projects = await tx.doc(KuloProjectsDoc);
      const settings = await tx.doc(SettingsAssistantDoc);
      return writeTaskBoardInTx(
        state,
        projects,
        settings,
        {
          commandId: params.commandId!,
          conversationId: source.conversationId,
          ...(params.boardId !== undefined ? { boardId: params.boardId } : {}),
          ...(params.boardTitle !== undefined ? { boardTitle: params.boardTitle } : {}),
          ...(params.goal !== undefined ? { goal: params.goal } : {}),
          ...(params.ticketId !== undefined ? { ticketId: params.ticketId } : {}),
          ...(params.kind !== undefined ? { kind: params.kind } : {}),
          ...(params.note !== undefined ? { note: params.note } : {}),
          ...(params.supersedesSeq !== undefined ? { supersedesSeq: params.supersedesSeq } : {}),
          ...(params.status !== undefined ? { status: params.status } : {}),
          now: Date.now(),
        },
        redact,
      );
    }, context);
    return { board: outcome.board, deduplicated: outcome.deduplicated };
  }

  async #prepareWorkerCollaborationContext(
    ticket: Readonly<TicketRecord>,
    context: Context,
  ): Promise<{
    boardContext?: string;
    reviewContext?: string;
    reviewMaterialized?: Array<{ id: string; name: string; mimeType: string; path: string }>;
  }> {
    if (!ticket.boardId && !ticket.reviewTicketId) return {};
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const redact = (text: string) => this.connectionManager.redact(text);
    const board = ticket.boardId ? state?.boards?.[ticket.boardId] : undefined;
    const boardContext = formatTaskBoardWorkerContext(board, redact);

    let reviewContext: string | undefined;
    let reviewMaterialized: Array<{ id: string; name: string; mimeType: string; path: string }> | undefined;
    if (ticket.reviewTicketId) {
      const target = state?.tickets?.[ticket.reviewTicketId];
      if (target) {
        const collected = await collectReviewPackAssets({
          target,
          inspectStagedDiff: (tid, filePath) => this.inspectStagedDiff(tid, filePath, context),
          redact,
        });
        if (ticket.externalExecution) {
          const safeTargetId = target.id.replace(/[^A-Za-z0-9._-]/g, "_");
          const uploadIds: string[] = [];
          for (const asset of collected.assets) {
            const saved = this.uploads.saveUpload({
              name: `review-${safeTargetId}-${asset.name.replace(/\//g, "_")}`,
              mimeType: asset.mimeType,
              bytes: asset.bytes,
              ownerId: `agent:${ticket.workerConversationId}`,
              idempotencyKey: `reviewpack:${ticket.id}:${ticket.runEpoch}:${target.id}:${asset.name}`,
              internalOnly: true,
            });
            this.uploads.bindAttachments([saved], `ticket:${ticket.id}`, `agent:${ticket.workerConversationId}`);
            uploadIds.push(saved.id);
          }
          reviewMaterialized = await this.#materializeExternalAttachments(ticket, uploadIds, context, { subdir: `review-${safeTargetId}` });
          const hint = reviewMaterialized[0]?.path ? path.posix.dirname(reviewMaterialized[0].path.replace(/\\/g, "/")) : "inputs";
          reviewContext = formatReviewPromptSection({
            target,
            locationHint: hint,
            snapshotNote: collected.snapshotNote,
          });
        } else {
          const written = await writeReviewPackToScratchEnv({
            reviewTicket: ticket,
            target,
            assets: collected.assets,
            snapshotNote: collected.snapshotNote,
            envManager: this.envManager,
            context,
          });
          reviewContext = written.promptSection;
        }
      }
    }
    return {
      ...(boardContext ? { boardContext } : {}),
      ...(reviewContext ? { reviewContext } : {}),
      ...(reviewMaterialized?.length ? { reviewMaterialized } : {}),
    };
  }

  async closeTicket(
    params: CloseTicketParams,
    context: Context = BACKGROUND_CONTEXT,
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    return this.#ticketControl.closeTicket(params, context, suppliedIntent);
  }

  async listScheduledTasks(context: Context = BACKGROUND_CONTEXT): Promise<TicketCardView[]> {
    const { tickets } = await this.getBoardSnapshot(context);
    return tickets.filter((ticket) => ticket.schedule && ticket.schedule.deletedAt === undefined);
  }

  async stopScheduledTask(ticketId: string, context: Context = BACKGROUND_CONTEXT, intent?: DeliveryIntent): Promise<TicketCardView> {
    return this.#ticketControl.stopScheduledTask(ticketId, context, intent);
  }

  async deleteScheduledTask(ticketId: string, context: Context = BACKGROUND_CONTEXT, intent?: DeliveryIntent): Promise<void> {
    return this.#ticketControl.deleteScheduledTask(ticketId, context, intent);
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
      activeConversationId: topicView.conversationId,
      topics,
      messages: topicView.messages,
      topicActivities: Object.fromEntries(this.#topicWatchesList().filter((cache) => topics.some((topic) => topic.id === cache.topicId))
        .map((cache) => [cache.topicId, topicActivity(cache.messages, cache.live)])),
      historyBefore: topicView.historyBefore,
      live: topicView.live,
      ...board,
      assistantItems: selectActiveAssistantItems(assistantDoc?.items, Date.now()),
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
      items: selectActiveAssistantItems(snap?.items, Date.now()),
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
  ): Promise<{ inserted: number; deduplicated: number }> {
    if (events.length === 0) return { inserted: 0, deduplicated: 0 };
    const redact = (text: string): string => this.connectionManager.redact(redactSensitiveText(text));
    const batch: ConnectorEventBatch = {
      batchId: `${driverId}-${Date.now()}`,
      driverId,
      streamId: `${this.#androidHubId ?? "kulo-hub"}:local:${streamSuffix}`,
      sourceEpoch: "v1",
      cursorAfter: String(Date.now()),
      events,
    };
    const { inserted, deduplicatedCount } = await this.assistantLedger.ingestBatch(this.envManager.localEnvId, batch, redact);
    if (inserted.length > 0) {
      this.assistantSorter.enqueue(inserted);
      if (inserted.some((ev) => ev.direction === "outgoing")) void this.assistantCoordinator.resolvePassiveCardsForOutgoingReply(inserted).catch(() => {});
      await this.#refreshAssistantActiveFlag(BACKGROUND_CONTEXT);
    }
    return { inserted: inserted.length, deduplicated: deduplicatedCount };
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
      if (mute && mute.length <= 255) muteAssistantAppInDoc(doc, mute, Date.now());
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

    await this.#refreshAssistantActiveFlag(context);
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

  async listTicketDeliverables(ticketId: string, context: Context = BACKGROUND_CONTEXT) {
    return this.#ticketInspection.listTicketDeliverables(ticketId, context);
  }

  async readTicketDeliverable(ticketId: string, fileId: string, context: Context = BACKGROUND_CONTEXT) {
    return this.#ticketInspection.readTicketDeliverable(ticketId, fileId, context);
  }

  async inspectTicketDetail(
    ticketId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{
    ticket: TicketRecord;
    transcript: ChatDisplayItem[];
    live: LiveStreamState;
    subagents?: import("@kulo/protocol").SubagentCardView[];
  }> {
    return this.#ticketInspection.inspectTicketDetail(ticketId, context);
  }

  async inspectWorker(
    ticketId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<WorkerInspectResult> {
    return this.#ticketInspection.inspectWorker(ticketId, context);
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

  setOnClusterDirty(hook: ((kind: "sqlite" | "assistant" | "memory" | "vault" | "files" | "uploads", options?: { immediate?: boolean }) => void) | undefined, hasRemoteStandbys?: () => boolean): void { this.#onClusterDirty = hook; this.#hasRemoteStandbys = hasRemoteStandbys; }
  backupSyncSqlite(name: "assistant.sqlite" | "memory.sqlite", destPath: string): Promise<boolean> { return name === "memory.sqlite" ? this.memoryRuntime.builtinMemory.store.backupTo(destPath) : this.assistantLedger.backupTo(destPath); }
  async #onBuiltinMemoryModeChanged(state: BuiltinMemoryStateView): Promise<void> {
    if (this.#closed) return;
    await this.#reconfigureOrchestratorConversations(BACKGROUND_CONTEXT); await this.settingsAssistant.reconfigureActiveConversation(BACKGROUND_CONTEXT); await this.#reconfigureWorkerConversations(BACKGROUND_CONTEXT);
    for (const listener of this.#listeners) listener.onBuiltinMemory?.(state);
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
    const activeTurns = this.#topics.inspectBusyTopics().length;
    const board = await this.getBoardSnapshot();
    const activeTickets = board.tickets.filter((t) => ["running", "queued", "pausing"].includes(t.status)).length;
    const activeVoiceCalls = this.voiceCalls.hasActiveCalls() ? 1 : 0;
    const settingsSnap = await this.settingsAssistant.getSnapshot().catch(() => null);
    const activeSettingsTurns = settingsSnap?.live?.busy ? 1 : 0;
    const mediaList = await this.mediaJobs.list().catch(() => []);
    const activeMediaJobs = mediaList.filter((j) => ["queued", "submitting", "running", "collecting"].includes(j.status)).length + this.#mediaDelivery.pendingRelayCount();
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
    for (const topicId of this.#topics.inspectBusyTopics()) {
      await this.deliverClientMessage({ type: "chat.abort", topicId }, localId).catch(() => undefined);
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

  #notifyClusterDirty(kind: "sqlite" | "assistant" | "memory" | "vault" | "files" | "uploads"): void {
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
    // Reject new incoming work first, then drain active voice calls (trailing transcripts & summary cards)
    // BEFORE marking #closed = true so drain-period durable writes are never dropped.
    this.#acceptingNewWork = false;
    const errors: unknown[] = [];
    const finish = async (work: () => unknown) => {
      try { await work(); } catch (error) { errors.push(error); }
    };
    await finish(() => this.voiceCalls.close());
    this.#closed = true;
    this.#runHealth.close();
    this.externalClientQuotas.close();
    this.#externalClientAdmin.clearReceipts();
    this.releaseHandoverBarrier();
    await finish(() => this.#clusterCloseHook?.());
    this.#inlineWaiters.notifyAll();
    await this.#computer.closeAllOrchestratorBrowserSessions();
    await finish(() => this.#ticketBoard.close());
    if (this.#cleanupRetryTimer) {
      clearTimeout(this.#cleanupRetryTimer);
      this.#cleanupRetryTimer = null;
    }
    this.#watchdog.stopTimer();
    this.#topics.stopAutoArchiveTimer();
    await finish(() => this.sideQuestions.close());
    await finish(() => this.memoryRuntime.close());
    if (this.#uploadCleanupTimer) { clearInterval(this.#uploadCleanupTimer); this.#uploadCleanupTimer = null; }
    await finish(() => this.#customizationInstance?.close());
    await finish(() => this.voice.close());
    await finish(() => this.connectionManager.closeAsync());
    await finish(() => this.envManager.setAndroidNotificationClassifier(undefined));
    await finish(() => this.envManager.setConnectorHandlers(undefined));
    await finish(() => this.larkConnector.close());
    await finish(() => this.homeAssistant.close());
    this.haLanAudio.clear();
    await finish(() => this.assistantSorter.close());
    await finish(() => this.assistantCoordinator.close());
    await finish(() => this.assistantProactiveWake.close());
    await finish(() => this.ambientModel.close());
    await finish(() => this.assistantLedger.close());
    await finish(() => this.#androidNotifications.close());
    await finish(() => this.#topics.closeTitles());
    await finish(() => this.personality.close());
    await finish(() => this.usageCaps.close());
    this.#computer.closeAllHandoffs();
    await finish(() => this.mediaJobs.close());
    await finish(() => this.#mediaDelivery.close());
    await finish(() => this.extensions.close());
    await finish(() => this.#topics.drainPendingActivity());
    for (const detach of this.#watchdog.drainDetachers()) {
      await finish(detach);
    }
    await finish(() => this.settingsAssistant.close());
    await this.#topics.stopAllWatches(finish);
    // A cancelled caller may stop waiting on Durable before admitted writes have drained.
    await finish(() => this.#delivery.close());
    await finish(() => this.harness.close(withoutAbortSignal(context)));
    const contextPackage = this.#contextPackage;
    this.#contextPackage = null;
    if (contextPackage) await finish(() => contextPackage.close());
    await finish(() => this.history.close());
    await finish(() => this.envManager.close());
    await finish(() => this.search.close());
    await finish(() => this.#releaseProxy());
    if (this.#bootCompleted && errors.length === 0) {
      const shutdownNodeId =
        this.#clusterHostContext?.localNodeId && this.#clusterHostContext.localNodeId !== "local"
          ? this.#clusterHostContext.localNodeId
          : resolveBootGateLocalNodeId(this.config.stateDir, this.config.localEnvId);
      await finish(() => recordGracefulShutdown(this.config.stateDir, shutdownNodeId, this.#bootGate.bootId));
    }
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
    return this.#topics.listWatchedCaches();
  }

  async #resolveWatchedTopic(
    topicId: string,
    context: Context,
  ): Promise<WatchedTopicCache> {
    return this.#topics.resolveWatchedTopic(topicId, context);
  }

  async #ensureTopicWatched(
    topicId: string,
    conversation: Conversation,
    context: Context,
  ): Promise<WatchedTopicCache> {
    return this.#topics.ensureTopicWatched(topicId, conversation, context);
  }

  async #ensureTopicWatchedByConversation(conversationId: number, context: Context): Promise<void> {
    return this.#topics.ensureTopicWatchedByConversation(conversationId, context);
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
    } else {
      const topicId = state?.conversationToTopic?.[String(card.originConversationId)];
      const topic = topicId ? state?.topics?.[topicId] : undefined;
      if (topic?.deletedAt) throw new UiCardError("content_scope_denied", "当前对话已删除。", 403);
      if (topic?.projectId) await this.projects.ensureAuthorized(topic.projectId, BACKGROUND_CONTEXT);
    }

    const directStopTarget = resolveDirectStopCardTarget(await this.actionConfirmations.getByCardId(input.cardId), input.actionId);
    if (!directStopTarget) {
      const receipt = await this.uiCards.submit(input, { conversationId: card.originConversationId });
      await this.#applyResolvedActionConfirmation(receipt, card.originConversationId, input.actionId, input.values);
      return receipt;
    }

    const { ticketId, reason: stopReason } = directStopTarget;
    return this.#queueTicketOperation(ticketId, async () => {
      let admittedStop: AdmittedTicketStop | undefined;
      const receipt = await this.uiCards.submit(input, { conversationId: card.originConversationId }, {
        beforeConversationSubmit: async (tx, ctx) => {
          await resolveCardConfirmationDeniedInTx(tx, ctx.card.cardId, ctx.action.id);
          const t = (await tx.doc(KuloStateDoc)).tickets[ticketId];
          if (t && canDirectStopTicket(t)) {
            admittedStop = await admitTicketStopInTx(tx, { ticketId, reason: stopReason });
            return { resultSummary: "已停止任务", systemEffect: { kind: "ticket_stopped", ticketId, reason: admittedStop.stoppedReason } as JsonObject };
          }
          const status = t?.status ?? "missing";
          return {
            resultSummary: status === "stopped" ? "任务已停止" : status === "closed" ? "任务已关闭" : "任务已完成",
            systemEffect: { kind: "ticket_already_settled", ticketId, status } as JsonObject,
          };
        },
      });
      if (admittedStop) {
        const postSnapshot = await this.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const postTicket = postSnapshot?.tickets[ticketId];
        if (postTicket) {
          await finalizeTicketStop(this.#finalizeTicketStopDeps(), {
            ticketId, reason: admittedStop.stoppedReason, epoch: admittedStop.epoch, previousEpoch: admittedStop.previousEpoch,
            ...(admittedStop.activeTaskId === undefined ? {} : { activeTaskId: admittedStop.activeTaskId }),
            ...(admittedStop.priorWaitingCardId ? { priorWaitingCardId: admittedStop.priorWaitingCardId } : {}),
            snapshot: postSnapshot, ticket: postTicket,
          }, BACKGROUND_CONTEXT);
        }
      } else if (receipt.deduplicated && (await this.harness.snapshot(KuloProjectsDoc, BACKGROUND_CONTEXT))?.cancellations?.[ticketId]) {
        await this.#ticketControl.stopTicketDirect(ticketId, stopReason, BACKGROUND_CONTEXT);
      }
      return receipt;
    });
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

  async #reconcileDispatchedConfirmations(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    const recovered = await this.actionConfirmations.reconcileDispatchedOnStartup(context);
    for (const record of recovered) {
      const payload = record.payload;
      if (payload.kind === "host_action") {
        const notice = this.connectionManager.redact(`服务在执行已批准的本机操作「${payload.summary}」（设备 ${payload.envName} / ${payload.envId}）期间发生重启或切换，操作已发出但未收到最终回执（未自动重放）。请先通过只读方式核验实际状态，切勿盲目重复执行具有副作用的命令。`);
        if (payload.ticketId) {
          try {
            await this.steerTicket({ ticketId: payload.ticketId, commandId: `action-recovery:${record.id}:unknown`, text: notice, internalResume: true }, context);
          } catch (error) {
            console.warn("[KuloConfirmation] Startup unknown host_action wake skipped", error instanceof Error ? error.message : String(error));
          }
        } else {
          try {
            const origin = await this.harness.conversation(record.conversationId as ConversationId, context);
            if (origin) {
              const draft = buildHostActionResultDraft({ requestId: `kulo:action-recovery:${record.id}:unknown`, refId: record.id, envId: payload.envId, envName: payload.envName, body: notice, instruction: "请用当前对话语言简洁告知用户需要核实，不要暴露内部卡片或工单编号。", redact: (text) => this.connectionManager.redact(text) });
              await this.harness.commit((tx) => submitAutomaticChatInput(tx, origin, draft), context);
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
              internalResume: true,
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
      const task = this.#hostActions.executeResolvedHostAction(resolved, conversationId).catch((error: unknown) => {
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

  #refreshTopicContent(cache: WatchedTopicCache, value = cache.watch.value): void {
    this.#topics.refreshContent(cache, value);
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
    const prevMemEnabled = this.#effectiveMemoryConfig(this.#liveSettings.memory).enabled;
    const prevRawMem = this.#liveSettings.memory;
    const update = this.#settingsStore.replace(nextDoc);
    if (!update.applied) return;
    if (prevMemEnabled !== this.#effectiveMemoryConfig(this.#liveSettings.memory).enabled || prevRawMem.enabled !== this.#liveSettings.memory.enabled || prevRawMem.accessMode !== this.#liveSettings.memory.accessMode) await this.memoryRuntime.builtinMemory.onExternalEngineChanged(context);
    this.externalClientQuotas.reconcileFromSettings(this.#liveSettings.roles, this.#liveSettings.externalClients);

    if (update.protectedPathsChanged) this.envManager.retireIdleWorkerEnvironments();
    if (update.executionTrustModeChanged) {
      this.envManager.setExecutionTrustMode(update.newExecutionTrustMode, update.executionTrustModeRevision);
      void this.connectionManager.invalidateStdioMcpConnections().catch(() => {});
      if (update.tightenedTrustMode) this.#onClusterDirty?.("sqlite", { immediate: true });
    }
    if (update.newIdentityDir === this.#defaultIdentityDir) {
      fs.mkdirSync(update.newIdentityDir, { recursive: true, mode: 0o700 });
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
    this.#contextGuard.invalidateAll();
    this.#topics.refreshAll();
    await this.settingsAssistant.reconfigureActiveConversation(context);
    await this.#reconfigureWorkerConversations(context);
  }

  async #syncProviderImageCapabilities(): Promise<void> {
    if (!this.#providerManager) return;
    const model = this.#liveSettings.model;
    const sources: SyncedProviderImageSource[] = [
      ...(model.gatewayDisabled !== true && model.baseUrl?.trim() && model.gatewayModels?.length
        ? [{ id: KULO_GATEWAY_PROVIDER_ID, name: "Kulo Gateway", baseUrl: model.baseUrl, api: model.apiMode, ...(model.vertexProject ? { vertexProject: model.vertexProject } : {}), ...(model.vertexLocation ? { vertexLocation: model.vertexLocation } : {}), models: model.gatewayModels }]
        : []),
      ...(model.customProviders ?? []).map((cp) => ({
        id: cp.id, name: cp.name, baseUrl: cp.baseUrl, api: cp.api, ...(cp.preset ? { preset: cp.preset } : {}),
        ...(cp.vertexProject ? { vertexProject: cp.vertexProject } : {}), ...(cp.vertexLocation ? { vertexLocation: cp.vertexLocation } : {}), models: cp.models,
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
    const configureOne = async (cache: WatchedTopicCache) => {
      const topicState = await this.harness.snapshot(KuloStateDoc, context);
      const topic = topicState?.topics?.[cache.topicId];
      if (!topic || topic.deletedAt || topic.conversationId !== Number(cache.conversation.id)) return;
      const isRoot = isActiveRootConversation(Number(cache.conversation.id), topicState);
      const cwd = topic.projectId ? (await this.projects.get(topic.projectId, context)).workspaceDir : this.#mainWorkspaceDir;
      await cache.conversation.configure(
        {
          model: orchestratorAgent.model,
          thinkingLevel: orchestratorAgent.thinkingLevel,
          extensions: this.#orchestratorExtensions(isRoot),
          tools: this.#orchestratorTools(isRoot),
          cwd,
          maxTurns: ORCHESTRATOR_MAX_TURNS,
        },
        context,
      );
    };
    for (const cache of this.#topicWatchesList()) {
      if (cache.topicId === "root") {
        await this.#delivery.queueChat("root", async () => {
          const liveRoot = this.#topics.getCache("root");
          if (liveRoot) await configureOne(liveRoot);
        });
      } else {
        await configureOne(cache);
      }
    }
  }

  async #syncSingleWorkerConversation(ticket: Readonly<TicketRecord>, context: Context): Promise<void> {
    if (ticket.externalExecution) return;
    const conv = await this.harness.conversation(ticket.workerConversationId as ConversationId, context);
    if (!conv) return;
    const rolePreset = this.#liveSettings.roles[ticket.role];
    const effective = resolveWorkerEffectiveModel({ ticket, rolePreset, defaultModel: { provider: this.#liveSettings.model.defaultProvider, modelId: this.#liveSettings.model.defaultModel, thinkingLevel: this.#liveSettings.model.thinkingLevel } });
    const workerAgent = resolveAgentModelAndThinking(this.#models, this.#providerId, effective.provider, effective.modelId, effective.thinkingLevel, this.#liveSettings.model);
    const androidTargets = this.#androidTargets(ticket);
    const effectiveWorkspaceDir = getEffectiveWorkspaceDir(ticket);
    await conv.configure(
      {
        model: workerAgent.model,
        ...(effective.explicitThinking ? { thinkingLevel: workerAgent.thinkingLevel } : {}),
        ...this.#workerTools({ executionDomain: ticket.executionDomain, androidTargetIds: androidTargets, allowSubagents: Boolean(rolePreset?.allowSubagents), readOnly: Boolean(ticket.readOnly), hasProject: Boolean(ticket.projectId) }),
        ...(ticket.executionDomain !== "android" ? { cwd: effectiveWorkspaceDir } : {}), maxTurns: WORKER_MAX_TURNS,
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
        ...this.#workerTools({ executionDomain: ticket.executionDomain, androidTargetIds: androidTargets, allowSubagents: false, isSubagent: true, readOnly: effectiveReadOnly, hasProject: Boolean(ticket.projectId) }),
        ...(ticket.executionDomain !== "android" ? { cwd: effectiveWorkspaceDir } : {}), maxTurns: SUBAGENT_MAX_TURNS,
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

  #toRoutingSignals(inputs: readonly EntryRecord[], topic?: { targetDeviceId?: string }): ChatRoutingSignals[] {
    return inputs.map((inp) => {
      const r = chatRoutingData(inp);
      return { text: r.text, targetDeviceId: reconcileTopicRoutingTarget(r.targetDeviceId, topic?.targetDeviceId, Boolean(topic)), sourceDeviceId: r.source?.deviceId };
    });
  }

  async #resolveOptionalProjectDeviceId(projectId: string | null | undefined, context: Context): Promise<string | undefined> {
    if (!projectId) return undefined;
    try {
      return (await this.projects.get(projectId, context)).deviceId;
    } catch {
      return undefined;
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
    const preflight = preflightOrchestratorTargetEnv({
      routings: this.#toRoutingSignals(inputs, topic),
      topicTargetDeviceId: topic.targetDeviceId,
      envs: this.envManager.listEnvs(),
    });
    if (!preflight.ok) throw new ProjectError(409, preflight.code, preflight.message);

    const projectDeviceId = topic.projectId ? (await this.projects.get(topic.projectId, context)).deviceId : undefined;
    const envs = this.envManager.listEnvs();
    const priorContextualComputerId = !projectDeviceId && !preflight.explicitTarget
      ? resolvePriorContextualComputerId({
          currentText: this.#toRoutingSignals(inputs, topic)[0]?.text,
          priorUserTurns: await this.#recentPriorUserTurns(conversationId, context, toolTaskId, new Set(inputs.map((entry) => entry.id))),
          envs,
        })
      : undefined;
    const resolved = resolveOrchestratorTargetEnv({
      explicitTarget: preflight.explicitTarget,
      sourceId: preflight.sourceId,
      projectDeviceId,
      priorContextualComputerId,
      activeTopicBrowserEnvId: this.#computer.activeOrchestratorBrowserEnvId(topicId),
      getEnvDescriptor: (id) => this.envManager.getEnvDescriptor(id),
      isLocalEnv: (id) => this.envManager.isLocalEnv(id),
      localEnvId: this.envManager.localEnvId,
      pickDefaultEnvId: () => this.envManager.pickDefaultEnvId(),
    });
    if (!resolved.ok) throw new ProjectError(409, resolved.code, resolved.message);
    return { topicId, envId: resolved.envId, descriptor: resolved.descriptor };
  }

  async #resolveOrchestratorCatalogSkillTarget(
    conversationId: number,
    toolTaskId: number | undefined,
    context: Context,
  ): Promise<{ platform?: string; capabilities: string[] }> {
    const state = await this.harness.snapshot(KuloStateDoc, context);
    const topicId = state?.conversationToTopic?.[String(conversationId)] ?? "root";
    const topic = state?.topics?.[topicId];
    if (!topic || topic.deletedAt) return { capabilities: [] };
    const inputs = await this.#currentControlInputs(conversationId, context, toolTaskId);
    const projectDeviceId = await this.#resolveOptionalProjectDeviceId(topic.projectId, context);
    return resolveOrchestratorCatalogSkillTarget({
      routings: this.#toRoutingSignals(inputs, topic),
      topicTargetDeviceId: topic.targetDeviceId,
      projectDeviceId,
      envs: this.envManager.listEnvs(),
      getEnvDescriptor: (id) => this.envManager.getEnvDescriptor(id),
    });
  }

  async #resolveOrchestratorSkillTarget(
    conversationId: number,
    toolTaskId: number | undefined,
    context: Context,
  ): Promise<{ platform?: string; capabilities: string[] }> {
    try {
      const resolved = await this.#resolveOrchestratorTargetEnvId(conversationId, toolTaskId, context);
      return { platform: resolved.descriptor.platform, capabilities: [...resolved.descriptor.capabilities] };
    } catch (error) {
      if (
        !(error instanceof ProjectError) ||
        (error.code !== "target_device_conflict" && error.code !== "source_device_ambiguous")
      ) {
        return { capabilities: [] };
      }
      const state = await this.harness.snapshot(KuloStateDoc, context);
      const topicId = state?.conversationToTopic?.[String(conversationId)] ?? "root";
      const topic = state?.topics?.[topicId];
      if (!topic || topic.deletedAt) return { capabilities: [] };
      const inputs = await this.#currentControlInputs(conversationId, context, toolTaskId);
      const projectDeviceId = await this.#resolveOptionalProjectDeviceId(topic.projectId, context);
      return resolveOrchestratorConflictSkillTarget({
        errorCode: error.code,
        routings: this.#toRoutingSignals(inputs, topic),
        topicTargetDeviceId: topic.targetDeviceId,
        projectDeviceId,
        envs: this.envManager.listEnvs(),
        getEnvDescriptor: (id) => this.envManager.getEnvDescriptor(id),
      });
    }
  }

  async #assertChatReadTarget(conversationId: number, toolTaskId: number, environment: string | undefined, context: Context, topic?: { targetDeviceId?: string }) {
    const inputs = await this.#currentControlInputs(conversationId, context, toolTaskId);
    const envs = this.envManager.listEnvs();
    const localEnvId = this.envManager.localEnvId;
    const preflight = inspectChatReadTarget({
      routings: this.#toRoutingSignals(inputs, topic),
      topicTargetDeviceId: topic?.targetDeviceId,
      envs,
      environment,
      localEnvId,
    });
    if (preflight.status === "error") throw new ProjectError(409, preflight.code, preflight.message);
    if (preflight.status === "project") {
      if (preflight.explicitTarget) {
        const project = await this.projects.get(preflight.projectId, context);
        if (project.deviceId !== preflight.explicitTarget) {
          throw new ProjectError(409, "target_device_conflict", "所选设备与项目所在设备不同，请确认要读取哪个设备上的文件。");
        }
      }
      return;
    }
    const priorUserTurns = !preflight.explicitTarget && preflight.envTargetId
      ? await this.#recentPriorUserTurns(conversationId, context, toolTaskId, new Set(inputs.map((entry) => entry.id)))
      : undefined;
    const verified = verifyChatReadTargetEnv({
      ...preflight,
      priorUserTurns,
      envs,
      localEnvId,
      isLocalEnv: (id) => this.envManager.isLocalEnv(id),
      hasLocalEnv: Boolean(this.envManager.getEnvDescriptor(localEnvId)),
      environment,
    });
    if (!verified.ok) throw new ProjectError(409, verified.code, verified.message);
  }

  async #recentPriorUserTurns(conversationId: number | undefined, context: Context, toolTaskId: number | undefined, excludeIds: ReadonlySet<EntryId>, limit = 12): Promise<PriorUserDeviceTurn[]> {
    return this.#turnContext.recentPriorUserTurns(conversationId, context, toolTaskId, excludeIds, limit);
  }
  async #currentControlInputs(conversationId: number | undefined, context: Context, toolTaskId?: number): Promise<EntryRecord[]> {
    return this.#turnContext.currentControlInputs(conversationId, context, toolTaskId);
  }
  #startUploadCleanup(): void {
    if (this.#uploadCleanupTimer || this.#closed) return;
    this.#uploadCleanupTimer = setInterval(() => {
      if (this.#closed) return;
      try { this.uploads.cleanupIncompleteUploads(); this.uploads.cleanupDrafts(); this.uploads.cleanupToolOverflows(); }
      catch (error) { console.warn("[KuloUploads] Periodic upload cleanup failed", error); }
    }, 60 * 60_000);
    this.#uploadCleanupTimer.unref?.();
  }
  #emitTopics(topics: TopicSummary[]): void { this.#topics.emitTopics(topics); }
  #emitAssistantItems(assistantRevision: number, items: AssistantItemView[]): void { const active = selectActiveAssistantItems(items, Date.now()); for (const l of this.#listeners) l.onAssistantItems?.(assistantRevision, active); }
  #emitEnvs(envs: EnvNodeDescriptor[]): void { for (const l of this.#listeners) l.onEnvs?.(envs); }
  #emitSettings(settings: KuloSettingsView): void { for (const l of this.#listeners) l.onSettings?.(settings); }
}
