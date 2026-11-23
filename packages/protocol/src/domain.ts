import type { LiveContextState } from "./context-state.js";
export const KULO_VERSION = "0.1.6";

export type TicketStatus =
  | "queued"
  | "running"
  | "pausing"
  | "waiting"
  | "blocked"
  | "ready"
  | "failed"
  | "stopped"
  | "closed";

export type TicketClosureKind = "obsolete" | "superseded";

export type WorkerReportState = "progress" | "blocked" | "ready" | "failed";

export type BuiltinThinkingEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ThinkingEffort = BuiltinThinkingEffort | (string & {});

export type RoleThinkingEffort = ThinkingEffort | "auto";

export type OpenAIApiMode = "openai-completions" | "openai-responses";

export const CUSTOM_PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "azure-openai-responses",
  "openai-codex-responses",
  "bedrock-converse-stream",
  "pi-messages",
] as const;

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export interface RolePreset {
  id: string;
  label: string;
  whenToUse: string;
  prompt: string;
  /** Whether this role is enabled in dispatch candidates (default true). */
  enabled?: boolean;
  /** When true, project workspace files are protected read-only while ticket scratchDir stays writable. */
  readOnly?: boolean;
  /** When true, this Worker may spawn internal subagents / teammates via kulo_subagent. */
  allowSubagents?: boolean;
  provider?: string;
  modelId?: string;
  thinkingLevel?: RoleThinkingEffort;
  serviceTier?: string;
  externalClientId?: string;
  external?: import("./external-agents.js").ExternalAgentBinding;
  dispatchPolicy?: import("./agent-routing.js").AgentDispatchPolicy;
}

export type { OverflowReportAsset, SubagentRecord, TicketSubagentSummary } from "./task-boards.js";
import type { OverflowReportAsset, TicketSubagentSummary } from "./task-boards.js";

export interface WorkerReportRecord {
  state: WorkerReportState;
  summary: string;
  deliverable?: string;
  /** Privately staged artifacts awaiting the main Agent's review; these are not chat publications. */
  attachments?: ChatAttachment[];
  /** System overflow slot when deliverable exceeds the ingress bound; internal review only (never published directly). */
  overflowAsset?: OverflowReportAsset;
  /** Recorded when a read-only external agent mutated files via native tools/shell. */
  readOnlyViolation?: import("./external-agents.js").ReadOnlyViolationSummary;
  question?: string;
  /** Optional structured choice suggestions when reporting state='blocked'. */
  options?: string[];
  at: number;
}

export interface TicketClosureRecord {
  kind: TicketClosureKind;
  reason: string;
  replacementTicketId?: string;
  at: number;
}

export interface TicketRecoveryRecord {
  state: "recovering" | "exhausted";
  attempts: number;
  startedAt: number;
  deadlineAt: number;
  nextAttemptAt?: number;
  lastError?: string;
  notifiedAt?: number;
  /** Shared budget owner when a replacement continues an earlier attempt. */
  rootTicketId?: string;
}

export interface TicketSchedule {
  executeAt: number;
  repeatEverySeconds?: number;
  nextRunAt: number | null;
  deletedAt?: number;
}

export type TicketEnvBinding =
  | "project"
  | "workspace_dir"
  | "topic_target"
  | "message_target"
  | "message_named"
  | "agent_bound"
  | "sender_local"
  | "hub_local"
  | "pool_fallback";

export type DispatchTargetScope = "hub_local" | "sender_device";

export interface TicketWorkspaceStaging {
  mode: import("./external-agents.js").ExternalWorkspaceMode;
  stagedCwd?: string;
  stagedDiff?: import("./external-agents.js").StagedWorkspaceDiffSummary;
  appliedAt?: number;
  appliedDigest?: string;
  discardedAt?: number;
  warnings?: string[];
}

export interface TicketOutwardAction {
  runEpoch: number;
  kind: "connection" | "media" | "voice" | "shell" | "host_action" | "external_bash";
  label: string;
  at: number;
}

export interface TicketRecord {
  id: string;
  commandId: string;
  title: string;
  userSummary?: string;
  goal: string;
  scope: string;
  acceptance?: string;
  assignment?: string;
  contextSummary?: string;
  inputAttachmentIds?: string[];
  role: string;
  providerOverride?: string;
  modelOverride?: string;
  status: TicketStatus;
  envId: string;
  /** Authoritative binding category for `envId`; undefined on legacy tickets defaults to locked. */
  envBinding?: TicketEnvBinding;
  /** Set once the Worker uses device-local GUI/browser tools (`kulo_browser` / `kulo_desktop`). */
  deviceStateTouched?: boolean;
  /** Authenticated message sender metadata when dispatched from a paired device. */
  senderSource?: { deviceId: string; name: string };
  executionDomain?: "computer" | "android";
  androidDeviceIds?: string[];
  workspaceDir: string;
  scratchDir?: string;
  readOnly?: boolean;
  workerConversationId: number;
  workspaceStaging?: TicketWorkspaceStaging;
  externalExecution?: import("./external-agents.js").ExternalTicketExecution;
  agentAssignment?: import("./agent-routing.js").AgentAssignment;
  parentTicketId?: string;
  activeTaskId?: number;
  runEpoch: number;
  createdAt: number;
  updatedAt: number;
  startedRunningAt?: number;
  /** Settled execution segments; add the current running/pausing segment separately. */
  accumulatedRunningMs?: number;
  completedAt?: number;
  latestReport?: WorkerReportRecord;
  stoppedReason?: string;
  closure?: TicketClosureRecord;
  recovery?: TicketRecoveryRecord;
  /** A user dismissed the recovery lineage while this alternative was still running. */
  autoRecoverySuppressed?: boolean;
  /** Real harness-recorded outward side effects (never model text) used to block blind auto-retry. */
  outwardActions?: TicketOutwardAction[];
  supersedes?: string[];
  originTopicId?: string; originConversationId?: number;
  finalRelayPending?: boolean;
  projectId?: string;
  projectRevision?: number;
  directoryId?: string;
  grantRevision?: number;
  waiting?: import("./projects.js").TicketWait;
  queuedAt?: number;
  cleanupPending?: boolean;
  resumePrompt?: string;
  wakePending?: boolean;
  resumeAttachmentIds?: string[];
  /** Connection IDs authorized by the main model for this ticket; never secret values. */
  connectionIds?: string[];
  connectionRevisions?: Record<string, number>;
  schedule?: TicketSchedule;
  /** Durable single-delivery CAS state for A2-lite inline dispatch fast lane. */
  deliveryClaim?: "inline_waiting" | "claimed_inline" | "escalated";
  inlineResult?: {
    state: WorkerReportRecord["state"]; summary: string; deliverable?: string | null;
    sources?: import("./search.js").WebSource[];
    stagedDiff?: import("./external-agents.js").StagedWorkspaceDiffSummary;
    stagedAssets?: Array<{ id: string; name: string; mimeType: string }>;
  };
  /** Optional TaskBoard ID linking multi-ticket collaborative work. */
  boardId?: string;
  /** Optional upstream ticket ID reviewed in read-only mode by this ticket. */
  reviewTicketId?: string;
}

export interface TicketCardView {
  externalAgentKind?: import("./external-agents.js").ExternalAgentKind;
  pendingWorkspaceApply?: boolean;
  subagentSummary?: TicketSubagentSummary;
  boardId?: string;
  reviewTicketId?: string;
  id: string;
  title: string;
  userSummary?: string;
  role: string;
  roleLabel: string;
  status: TicketStatus;
  envId: string;
  executionDomain?: "computer" | "android";
  androidDeviceIds?: string[];
  workspaceDir: string;
  createdAt: number;
  updatedAt: number;
  startedRunningAt?: number;
  accumulatedRunningMs?: number;
  completedAt?: number;
  queuedAt?: number;
  latestReport?: WorkerReportRecord;
  stoppedReason?: string;
  closure?: TicketClosureRecord;
  recovery?: TicketRecoveryRecord;
  originTopicId?: string;
  projectId?: string;
  waiting?: import("./projects.js").TicketWait;
  cleanupPending?: boolean;
  schedule?: TicketSchedule;
}

/** Content-free sidebar state; message bodies remain scoped to the selected topic. */
export interface TopicActivity {
  busy: boolean;
  queuedCount: number;
  lastAssistantMessageId?: number;
}

export type MainSessionNotificationKind =
  | "reply_completed"
  | "attention_required"
  | "run_failed";

export interface MainSessionNotificationEvent {
  id: string;
  kind: MainSessionNotificationKind;
  topicId: string;
  topicTitle?: string;
  summary?: string;
  createdAt: number;
}

export interface TopicSummary {
  id: string;
  conversationId: number;
  title: string;
  master?: boolean;
  pinned?: boolean;
  archived?: boolean; archivedFromRoot?: boolean;
  draft?: boolean;
  origin?: "user" | "proactive";
  situationId?: string;
  proactiveSeq?: number;
  createdAt: number;
  updatedAt: number;
  projectId?: string | null;
  targetDeviceId?: string;
  lastMessagePreview?: string;
  lastMessageAt?: number;
  deletedAt?: number;
  deletionId?: string;
}

export interface DispatchCardMeta {
  actionLabel: string;
  ticketId: string;
  title: string;
  userSummary?: string;
}

export interface UsageModelItem {
  model: string;
  totalTokens: number;
  turns: number;
  provider?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheHitRate?: number;
}

export interface UsageStatsView {
  range: "today" | "7" | "30";
  totalTokens: number;
  turns: number;
  cacheHitRate?: number;
  models: UsageModelItem[];
}

export interface SlotSummary {
  used: number;
  max: number;
  queuedCount: number;
}

export interface EnvNodeDescriptor {
  id: string;
  name: string;
  kind: "local" | "reverse-ws" | "ssh";
  online: boolean;
  platform: string;
  arch: string;
  rootDir: string;
  /** Omitted by legacy nodes, which speak the Pi Env daemon protocol. */
  executionKind?: "pi-env" | "native-device";
  android?: import("./android-validation.js").AndroidEnvStatus;
  capabilities: string[];
  connectedAt: number;
  lastSeenAt: number;
  info?: import("./devices.js").DeviceSystemInfo;
  listenPort?: number;
  standbyPublicKey?: string;
  identityPublicKey?: string;
  clusterEpoch?: number;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "audio" | "video" | "file";
  url: string;
  width?: number;
  height?: number;
  /** Media duration in seconds, when available. */
  duration?: number;
  presentation?: "voice" | "diagram";
  /** Valid only when presentation === "diagram": declares whether playback controls are present. */
  diagramMotion?: "none" | "reveal" | "step";
  /** Recording timer, independent of probed media metadata. */
  recordedDuration?: number;
  posterUrl?: string;
  metadataStatus?: "ready" | "unavailable";
  transcript?: import("./content.js").MediaTranscript;
  captions?: import("./content.js").MediaCaptionTrack[];
}

export interface ChatReplyReference {
  messageId: number;
  role: "user" | "assistant" | "dispatch";
  text: string;
  /** True when quoting a user-selected text or code excerpt rather than the full message. */
  excerpt?: boolean;
}

export interface ChatDisplayItem {
  id: number;
  /** Shared by the text and tool publications belonging to one assistant response. */
  responseId?: number;
  requestId?: string;
  submissionId?: number;
  delivery?: "queued" | "paused";
  voiceCallId?: string;
  role: "user" | "assistant" | "relay" | "dispatch" | "system_note";
  text: string;
  replyTo?: ChatReplyReference;
  attachments?: ChatAttachment[];
  sources?: import("./search.js").WebSource[];
  searchSuggestions?: string[];
  parts?: import("./content.js").MessagePart[];
  createdAt?: number;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    argsSummary: string;
    actionSummary?: string;
    result?: {
      text: string;
      isError: boolean;
      createdAt?: number;
      truncated?: boolean;
    };
  }>;
  dispatch?: DispatchCardMeta;
  meta?: Record<string, unknown>;
}

export interface LiveStreamState {
  busy: boolean;
  responseId?: number;
  streamingText?: string;
  streamingThinking?: string;
  activeTools: Array<{ callId: string; name: string; outputTail?: string }>;
  queuedCount: number;
  retrying?: { attempt: number; at: number };
  runFailure?: { taskId?: number; reason: string; detail?: string };
  context?: LiveContextState;
}

// ============================================================================
// Agent LED Matrix Expression
// ============================================================================

export type AgentFace =
  | "idle"
  | "thinking"
  | "working"
  | "happy"
  | "waiting"
  | "error";

export interface AgentExpressionState {
  face: AgentFace;
  cue?: string;
  updatedAt: number;
  expiresAt: number;
}

// ============================================================================
// Identity & Relationship Documents
// ============================================================================

export const IDENTITY_FILES = [
  "identity-agreement.md",
  "relationship.md",
] as const;

export type IdentityFile = (typeof IDENTITY_FILES)[number];

export interface IdentityVersion {
  directoryRevision: number;
  sha256: string | null;
}

export interface IdentityDirectoryState {
  directory: string;
  directoryRevision: number;
}

export interface IdentityBackup {
  backupId: string;
  file: IdentityFile;
  createdAt: string;
  sha256: string;
  previouslyMissing: boolean;
  summary: string;
}

export interface IdentityRead {
  file: IdentityFile;
  content: string;
  exists: boolean;
  configured: boolean;
  version: IdentityVersion;
  lastBackup: IdentityBackup | null;
}

export interface IdentitySaved {
  file: IdentityFile;
  version: IdentityVersion;
  backupId: string | null;
  unchanged: boolean;
  metadata: {
    operation: "save" | "rollback";
    summary: string;
    savedAt: string;
    restoredMissing: boolean;
  };
}

export interface IdentityList {
  configured: boolean;
  directory: string;
  directoryRevision: number;
  files: Array<Omit<IdentityRead, "content" | "configured">>;
}

export interface IdentityWriteRequest {
  file: IdentityFile;
  expected: IdentityVersion;
  content: string;
  summary: string;
  dualSignConfirmed: true;
}

export interface IdentityRollbackRequest {
  file: IdentityFile;
  expected: IdentityVersion;
  backupId: string;
  summary: string;
  dualSignConfirmed: true;
}

// ============================================================================
// Hindsight Dual-Bank Memory
// ============================================================================

export type MemoryBank = "private" | "shared";

export interface MemoryBanksConfig {
  private: string;
  shared: string;
}

export interface HindsightMemoryConfig {
  accessMode?: "kulo" | "scoped" | "private-only";
  enabled: boolean;
  knowledgeGuidanceEnabled?: boolean;
  endpoint: string;
  endpoints: string[];
  caCertPem: string;
  routerApiKey?: string;
  workerApiKey?: string;
  sharedReadApiKey?: string;
  sharedReadApiKeyEnv?: string;
  sharedReadApiKeyDisabled?: boolean;
  routerApiKeyEnv: string;
  workerApiKeyEnv: string;
  /** An explicit clear also disables environment/auth-file fallback for this identity. */
  routerApiKeyDisabled?: boolean;
  workerApiKeyDisabled?: boolean;
  authFile: string;
  autoAttachTopLevelRouters: boolean;
  banks: MemoryBanksConfig;
}

export type PublicMemoryConfig = Omit<HindsightMemoryConfig, "routerApiKey" | "workerApiKey" | "sharedReadApiKey">;

export interface HindsightEndpointStatus {
  endpoint: string;
  status: "healthy" | "unavailable" | "unprobed";
  version?: string;
  latencyMs?: number;
  detail?: string;
  isolationVerified?: boolean;
}

export interface HindsightProbeResult {
  healthy: boolean;
  activeEndpoint?: string;
  version?: string;
  privateBankOk?: boolean;
  sharedBankOk?: boolean;
  workerPrivateDenied?: boolean;
  routerSharedWriteDenied?: boolean;
  isolationVerified?: boolean;
  endpoints: HindsightEndpointStatus[];
  checkedAt: number;
}

// ============================================================================
// Kulo Runtime Settings & Revision CAS
// ============================================================================

export type KuloLanguage = "zh-CN" | "en";

export function normalizeKuloLanguage(value: unknown): KuloLanguage | undefined {
  return value === "zh-CN" || value === "en" ? value : undefined;
}

export function resolveKuloLanguage(value: unknown): KuloLanguage {
  return value === "en" ? "en" : "zh-CN";
}

export interface PresentationConfig {
  agentName: string;
  workbenchName: string;
  language?: KuloLanguage;
}

export type CompletedTaskDisplayHours = 1 | 3 | 6 | null;
export type HostActionPermission = "ask" | "always";

export interface ExecutorSlotsConfig {
  maxConcurrentWorkers: number;
  maxSubagentsPerTicket: number;
  paused: boolean;
  watchdogMinutes: number;
  completedTaskDisplayHours?: CompletedTaskDisplayHours;
  autoArchiveEnabled?: boolean;
  autoArchiveDays?: number;
  hostActionPermission?: HostActionPermission;
}

export type ModelModality = "text" | "image" | "audio" | "video" | "pdf";
export const MODEL_PURPOSES = ["chat", "image", "tts", "asr", "live"] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export const MODEL_PROTOCOL_ADAPTERS = [
  "openai-image", "gemini-image", "vertex-image", "custom-image",
  "openai-speech", "minimax-t2a", "gemini-tts",
  "openai-asr", "openai-realtime", "gemini-live", "vertex-live",
] as const;
export type ModelProtocolAdapter = (typeof MODEL_PROTOCOL_ADAPTERS)[number];

const IMAGE_MODEL_ID_PATTERN = /(?:^|\/)(?:gpt-image(?:-|$)|chatgpt-image(?:-|$)|dall-e(?:-|$)|imagen(?:[-.@]|$)|nano-banana(?:[-.@]|$)|gemini-(?:nano-banana(?:[-.@]|$)|[^/]*-image(?:[-.@]|$)))/i;
const LIVE_MODEL_ID_PATTERN = /(?:^|[/-])(?:gpt-realtime|gpt-4o-realtime|gpt-live|gemini-live|gemini-[^/]*-live|gemini-[^/]*-native-audio)(?:[-.@]|$)/i;
const TTS_MODEL_ID_PATTERN = /(?:^|[/-])(?:tts-\d|gpt-4o[^/]*-tts|gpt-audio[^/]*-tts|gemini-[^/]*-tts|speech-\d[\d.]*|qwen\d*-tts|cosyvoice|fish-speech|kokoro)(?:[-.@]|$)/i;
const ASR_MODEL_ID_PATTERN = /(?:^|[/-])(?:whisper(?:[-.@]|$)|gpt-4o[^/]*-transcribe|sensevoice|paraformer|funasr|canary-qwen)(?:[-.@]|$)/i;

/** Infer primary model purpose from explicit declaration, output modalities, or well-known model family IDs. */
export function inferModelPurpose(model: { id: string; purpose?: ModelPurpose; outputModalities?: readonly ModelModality[] }): ModelPurpose {
  if (model.purpose && (MODEL_PURPOSES as readonly string[]).includes(model.purpose)) return model.purpose;
  if (model.outputModalities?.includes("image") || IMAGE_MODEL_ID_PATTERN.test(model.id)) return "image";
  if (LIVE_MODEL_ID_PATTERN.test(model.id)) return "live";
  if (TTS_MODEL_ID_PATTERN.test(model.id)) return "tts";
  if (ASR_MODEL_ID_PATTERN.test(model.id)) return "asr";
  return "chat";
}

/** Input modalities describe perception; generation models have a separate output purpose. */
export function isImageGenerationModel(model: { id: string; purpose?: ModelPurpose; outputModalities?: readonly ModelModality[] }): boolean {
  return inferModelPurpose(model) === "image";
}

export function isConversationModel(model: { id: string; purpose?: ModelPurpose; outputModalities?: readonly ModelModality[] }): boolean {
  return inferModelPurpose(model) === "chat";
}

export function defaultProtocolAdapterForModel(
  purpose: ModelPurpose,
  modelId: string,
  providerApi?: string,
  preset?: string,
): ModelProtocolAdapter | undefined {
  const lower = modelId.toLowerCase();
  if (purpose === "image") {
    if (preset === "google-vertex" || providerApi === "google-vertex") return "vertex-image";
    if (preset === "google" || providerApi === "google-generative-ai" || /(?:^|\/)(?:imagen|nano-banana|gemini-)/.test(lower)) {
      return "gemini-image";
    }
    return "openai-image";
  }
  if (purpose === "tts") {
    if (preset === "minimax-cn" || preset === "minimax" || /(?:^|\/)speech-\d/.test(lower)) return "minimax-t2a";
    if (preset === "google" || providerApi === "google-generative-ai" || /(?:^|\/)gemini-/.test(lower)) return "gemini-tts";
    return "openai-speech";
  }
  if (purpose === "asr") {
    return "openai-asr";
  }
  if (purpose === "live") {
    if (preset === "google-vertex" || providerApi === "google-vertex") return "vertex-live";
    if (preset === "google" || providerApi === "google-generative-ai" || /(?:^|\/)gemini-/.test(lower)) return "gemini-live";
    return "openai-realtime";
  }
  return undefined;
}

export function defaultVoicesForAdapter(adapter: ModelProtocolAdapter | undefined): string[] {
  switch (adapter) {
    case "minimax-t2a":
      return ["male-qn-qingse", "female-shaonv", "male-qn-jingying", "female-yujie"];
    case "gemini-tts":
      return ["Kore", "Aoede", "Puck", "Charon", "Zephyr", "Fenrir", "Leda", "Orus"];
    case "openai-speech":
      return ["marin", "alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
    case "openai-realtime":
      return ["marin", "quartz", "ripple", "vesper", "willow", "gleam", "meridian"];
    case "gemini-live":
    case "vertex-live":
      return ["Aoede", "Kore", "Puck", "Charon", "Zephyr", "Fenrir", "Leda", "Orus"];
    default:
      return [];
  }
}

export type DisplayThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingLevelMapConfig = Partial<Record<BuiltinThinkingEffort, string | null>>;

export interface ThinkingLevelOption {
  id: string;
  label: string;
  value: string;
}

export interface ModelNativeTools {
  webSearch?: boolean;
}

export interface CustomModelConfig {
  id: string;
  purpose?: ModelPurpose;
  protocolAdapter?: ModelProtocolAdapter;
  voices?: string[];
  imageProfile?: import("./capabilities.js").ImageModelProfile;
  imageDefaults?: import("./capabilities.js").ImageGenerationParameters;
  customImageAdapter?: import("./capabilities.js").CustomImageAdapter;
  outputModalities?: ModelModality[];
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingEnabled?: boolean;
  vision?: boolean;
  modalities?: ModelModality[];
  thinkingLevelMap?: ThinkingLevelMapConfig;
  thinkingLevels?: ThinkingLevelOption[];
  nativeTools?: ModelNativeTools;
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  preset?: string;
  api: CustomProviderApi;
  baseUrl: string;
  authMode?: "api-key" | "none";
  vertexProject?: string; vertexLocation?: string;
  models: CustomModelConfig[];
}

export interface CompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  backgroundTokens: number;
}

export interface ModelGatewayConfig {
  baseUrl: string;
  apiMode: CustomProviderApi;
  vertexProject?: string;
  vertexLocation?: string;
  defaultProvider?: string;
  defaultModel: string;
  thinkingLevel: ThinkingEffort;
  contextWindow?: number;
  compaction?: CompactionConfig;
  customProviders?: CustomProviderConfig[];
  subscriptionModels?: Record<string, CustomModelConfig[]>;
  gatewayName?: string;
  gatewayModels?: CustomModelConfig[];
  gatewayDisabled?: boolean;
  apiKey?: string;
}

export type PublicModelGatewayConfig = Omit<ModelGatewayConfig, "apiKey">;

export interface ModelProbeRequest {
  providerId?: string;
  api?: CustomProviderApi;
  baseUrl?: string;
  apiKey?: string;
  vertexProject?: string;
  vertexLocation?: string;
  apiMode?: CustomProviderApi;
  model?: string;
}

export type ModelMetadataSource =
  | "provider-api"
  | "models.dev"
  | "pi-ai"
  | "litellm"
  | "default";

export interface DiscoverModelsRequest {
  providerId?: string;
  preset?: string;
  api: CustomProviderApi;
  baseUrl?: string;
  apiKey?: string;
  vertexProject?: string;
  vertexLocation?: string;
  /** When true, also refresh the online public model metadata registry on demand. */
  refreshMetadata?: boolean;
}

export interface ResolveModelMetadataRequest {
  modelId: string;
  api: CustomProviderApi;
  providerId?: string;
  preset?: string;
  baseUrl?: string;
  refreshMetadata?: boolean;
}

export interface ResolveModelMetadataResponse {
  model: ProviderModelItem;
  allowedThinkingWireValues?: string[];
  nativeSearchAllowed: boolean;
}

export interface ProviderModelItem {
  id: string;
  purpose?: ModelPurpose;
  protocolAdapter?: ModelProtocolAdapter;
  voices?: string[];
  imageProfile?: import("./capabilities.js").ImageModelProfile;
  imageDefaults?: import("./capabilities.js").ImageGenerationParameters;
  customImageAdapter?: import("./capabilities.js").CustomImageAdapter;
  outputModalities?: ModelModality[];
  name: string;
  api?: string;
  reasoning: boolean;
  thinkingEnabled?: boolean;
  vision: boolean;
  modalities: ModelModality[];
  contextWindow: number;
  maxTokens: number;
  supportedThinkingLevels: ThinkingEffort[];
  thinkingLevelMap?: ThinkingLevelMapConfig;
  thinkingLevels?: ThinkingLevelOption[];
  nativeTools?: ModelNativeTools;
  metadataSource?: ModelMetadataSource;
}

export interface DiscoverModelsResponse {
  ok: boolean;
  models: ProviderModelItem[];
  latencyMs: number;
  error?: string;
  source?: "official-documentation";
  sourceUrl?: string;
}

export interface ProviderCatalogItem {
  id: string;
  name: string;
  builtin: boolean;
  preset?: string;
  isGateway?: boolean;
  baseUrl?: string;
  api?: CustomProviderApi;
  vertexProject?: string;
  vertexLocation?: string;
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  oauthName?: string;
  oauthLoginLabel?: string;
  authenticated: boolean;
  authType?: "api_key" | "oauth";
  authSource?: string;
  supportsModelDiscovery?: boolean;
  modelCatalogSource?: "remote" | "configured" | "preset" | "official-documentation";
  configuredModels?: ProviderModelItem[];
  models: ProviderModelItem[];
}

export interface OAuthPromptOptionView {
  id: string;
  label: string;
  description?: string;
}

export interface OAuthPromptView {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: OAuthPromptOptionView[];
}

export interface OAuthSessionView {
  sessionId: string;
  providerId: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  authUrl?: string;
  instructions?: string;
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  };
  infoMessages: string[];
  progressMessage?: string;
  prompt?: OAuthPromptView;
  error?: string;
}

export interface WorkerInspectEntrySummary {
  id: number;
  kind: "user" | "assistant" | "tool_result" | "compaction" | "other";
  summary: string;
  createdAt?: number;
}

export interface WorkerInspectResult {
  ticketId: string;
  title: string;
  role: string;
  providerOverride?: string;
  modelOverride?: string;
  status: TicketStatus;
  runEpoch: number;
  phase?: import("./external-agents.js").WorkerExecutionPhase;
  touchedFiles?: string[];
  truncated?: boolean;
  startedRunningAt?: number;
  runningDurationSec?: number;
  idleSec?: number;
  busy: boolean;
  turns?: number;
  streamingPreview?: string;
  thinkingPreview?: string;
  activeTools: Array<{
    callId: string;
    name: string;
    status: string;
    outputTail?: string;
  }>;
  runFailure?: {
    reason: string;
    detail?: string;
  };
  latestReport?: WorkerReportRecord;
  recentEntries: WorkerInspectEntrySummary[];
  external?: {
    kind: import("./external-agents.js").ExternalAgentKind;
    sessionId?: string;
    runId?: string;
    workspaceMode?: import("./external-agents.js").ExternalWorkspaceMode;
    stagedCwd?: string;
    uncertainReason?: import("./external-agents.js").ExternalAgentUncertainReason;
    permissions: import("./external-agents.js").ExternalAgentPermission[];
  };
}

export interface ModelProbeResult {
  ok: boolean;
  latencyMs: number;
  baseUrl: string;
  model: string;
  availableModels: string[];
  title?: string;
  error?: string;
  rawDetail?: string;
  checkedAt: number;
}

export type SettingsBlockName =
  | "presentation"
  | "executor"
  | "roles"
  | "model"
  | "identity"
  | "memory";

export interface SettingsBlockEnvelope<T> {
  revision: number;
  value: T;
}

export interface SettingsHistoryItem {
  revision: number;
  block: SettingsBlockName;
  summary: string;
  savedAt: number;
}

export interface KuloSettingsView {
  globalRevision: number;
  externalClients?: Record<string, import("./external-agents.js").ExternalClientConnection>;
  blocks: {
    presentation: SettingsBlockEnvelope<PresentationConfig>;
    executor: SettingsBlockEnvelope<ExecutorSlotsConfig>;
    roles: SettingsBlockEnvelope<Record<string, RolePreset>>;
    model: SettingsBlockEnvelope<PublicModelGatewayConfig> & {
      hasApiKey: boolean;
    };
    identity: SettingsBlockEnvelope<{ directory: string }> & {
      effectiveDirectory: string;
      directoryRevision: number;
    };
    memory: SettingsBlockEnvelope<PublicMemoryConfig> & {
      hasRouterApiKey: boolean;
      hasWorkerApiKey: boolean;
      hasSharedReadApiKey?: boolean;
    };
  };
  history: SettingsHistoryItem[];
}
