export const CONNECTORS_CAPABILITY = "connectors-v1" as const;
export const CONNECTOR_MAX_BATCH_BYTES = 512 * 1024;
export const CONNECTOR_MAX_BATCH_EVENTS = 100;
export const CONNECTOR_MAX_TEXT_CHARS = 4_000;

export type ConnectorDriverId = "macos-notifications" | "spark-mail" | "home-assistant" | "lark-cli";

export type ConnectorCallRequest = {
  driverId: "spark-mail";
  action: "status" | "list_emails" | "search" | "read_thread" | "list_events" | "create_draft";
  params?: Record<string, unknown>;
};

export interface ConnectorCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export type ConnectorPermissionState =
  | "granted"
  | "full_disk_access_required"
  | "database_missing"
  | "unsupported_schema"
  | "unavailable"
  | "error";

export interface ConnectorSourceStatus {
  driverId: ConnectorDriverId;
  envId: string;
  envName: string;
  platform: string;
  enabled: boolean;
  permission: ConnectorPermissionState;
  mutedApps: string[];
  lastEventAt?: number;
  error?: string;
}

export interface ConnectorSourceConfig {
  driverId: ConnectorDriverId;
  enabled: boolean;
  mutedApps: string[];
}

export interface RawConnectorEvent {
  nativeEventId: string;
  eventVersion: string;
  appId: string;
  appLabel?: string;
  threadHint?: string;
  sender?: string;
  title: string;
  subtitle?: string;
  body: string;
  occurredAt: number;
  fidelity: "notification" | "local-db" | "structured";
  /** Optional internal reference to a sanitized temporary snapshot stored by Hub (never user-supplied over /ws/env). */
  snapshotRef?: string;
}

export interface ConnectorEventBatch {
  batchId: string;
  driverId: ConnectorDriverId;
  streamId: string;
  sourceEpoch: string;
  cursorAfter: string;
  events: RawConnectorEvent[];
  gapDetected?: boolean;
}

export interface ConnectorBatchAck {
  batchId: string;
  driverId: ConnectorDriverId;
  streamId: string;
  sourceEpoch: string;
  cursorAfter?: string;
  status: "accepted" | "rejected";
  code?: string;
}

export type AssistantItemKind = "alert" | "fyi" | "decision";

export type AssistantItemAction = "acknowledge" | "mute_app" | "promote_to_topic" | "confirm_action";

export type AssistantPendingActionKind =
  | "spark_create_draft"
  | "ha_call_service"
  | "ha_upsert_automation"
  | "ha_delete_automation"
  | "lark_send_reply";

export type ActionEffectState =
  | "none"
  | "dispatched"
  | "confirmed"
  | "failed_pre_dispatch"
  | "unknown";

export interface AssistantPendingAction {
  actionId: string;
  kind: AssistantPendingActionKind;
  label: string;
  targetLabel: string;
  previewText: string;
  driverId: ConnectorDriverId;
  envId?: string;
  operation: string;
  params: Record<string, unknown>;
  /** Durable execution barrier state for L2 side-effect replay protection. */
  executionState?: ActionEffectState;
  dispatchedAt?: number;
  lastError?: string;
}

export interface AssistantItemView {
  id: string;
  revision: number;
  situationId: string;
  kind: AssistantItemKind;
  sourceApp: string;
  sourceLabel: string;
  envName?: string;
  title: string;
  summary: string;
  primaryActionLabel?: string;
  pendingAction?: AssistantPendingAction;
  linkedTopicId?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export type AmbientLocalEngine = "omlx" | "ollama";

export interface AssistantBackgroundModelAdvice {
  hostName: string;
  platform: string;
  arch: string;
  cpu: string;
  memoryBytes: number;
  diskFreeBytes: number;
  detectedRuntimes: string[];
  recommendedMode: "local-managed" | "auto";
  recommendedEngine?: AmbientLocalEngine;
  recommendedModelId?: string;
  estimatedRamGb?: number;
  reason: string;
}

export interface AssistantBackgroundModelJob {
  id: string;
  operation: "deploy" | "configure" | "stop" | "uninstall";
  status: "queued" | "running" | "completed" | "failed";
  progress?: string;
  error?: string;
  updatedAt: number;
}

export interface AssistantBackgroundModelStatus {
  mode: "auto" | "local-managed" | "kulo-provider";
  engine?: AmbientLocalEngine;
  modelId?: string;
  providerId?: string;
  running: boolean;
  endpoint?: string;
  error?: string;
  job?: AssistantBackgroundModelJob;
  revision: number;
}

export interface SparkConnectorSnapshot {
  enabled: boolean;
  available: boolean;
  envId?: string;
  envName?: string;
  accessTier?: "off" | "read" | "triage" | "send" | "unknown";
  accountCount?: number;
  error?: string;
}

export type HomeAssistantAttributeValue = string | number | boolean | string[];

export interface HomeAssistantEntityView {
  entityId: string;
  domain: string;
  name: string;
  state: string;
  area?: string;
  areaId?: string;
  deviceId?: string;
  labels?: string[];
  deviceClass?: string;
  unit?: string;
  readOnlySecurity?: boolean;
  readOnlyContext?: boolean;
  configId?: string;
  editable?: boolean;
  attributes?: Record<string, HomeAssistantAttributeValue>;
  lastChanged?: string;
}

export interface HomeAssistantDoorwayTrigger {
  triggerEntityId: string;
  cameraEntityId?: string;
  label?: string;
  onlyWhenAwayOrNight?: boolean;
}

export interface HomeAssistantSentinelConfig {
  offlineDetectionEnabled: boolean;
  offlineThresholdSec: number;
  ignoredOfflineEntities: string[];
  lowBatteryThresholdPct: number;
  visionCameraAllowlist: string[];
  doorwayTriggers: HomeAssistantDoorwayTrigger[];
}

export interface HomeAssistantAnnounceConfig {
  enabled: boolean;
  defaultSpeakerEntityId?: string;
  useKuloVoiceTts: boolean;
  onlyWhenHome: boolean;
  overrideQuietForCritical: boolean;
  quietHours?: { start: string; end: string };
  minUrgency: "normal" | "high";
}

export interface HomeAssistantMigrationAdvice {
  dockerAvailable: boolean;
  orbStackAvailable: boolean;
  containerRunning: boolean;
  port8123Reachable: boolean;
  xiaomiHomeInstalled?: boolean;
  configDir: string;
  steps: string[];
}

export interface HomeAssistantSnapshot {
  enabled: boolean;
  connected: boolean;
  baseUrl?: string;
  hasToken: boolean;
  mcpSupported?: boolean;
  totalEntities?: number;
  curatedEntities?: number;
  filteredNoiseCount?: number;
  areaCount?: number;
  automationCount?: number;
  speakerCount?: number;
  wsConnected?: boolean;
  stale?: boolean;
  staleReason?: string;
  lastSyncAt?: number;
  error?: string;
  sentinel?: HomeAssistantSentinelConfig;
  announce?: HomeAssistantAnnounceConfig;
  migration?: HomeAssistantMigrationAdvice;
}

export interface LarkProfileView {
  name: string;
  brand?: string;
  userName?: string;
  ready: boolean;
  organizationKind?: "personal" | "enterprise" | "unknown";
  error?: string;
}

export interface LarkConnectorSnapshot {
  enabled: boolean;
  cliAvailable: boolean;
  profiles: LarkProfileView[];
  selectedProfiles: string[];
  lastSyncAt?: number;
  error?: string;
}

export interface AssistantWorkspaceSnapshot {
  revision: number;
  enabled: boolean;
  sources: ConnectorSourceStatus[];
  mutedApps: string[];
  backgroundModel: AssistantBackgroundModelStatus;
  advice?: AssistantBackgroundModelAdvice;
  digestCount24h: number;
  spark?: SparkConnectorSnapshot;
  homeAssistant?: HomeAssistantSnapshot;
  lark?: LarkConnectorSnapshot;
  localHost?: boolean;
  canManageHub?: boolean;
}

const ONE_TIME_CODE_PATTERN =
  /验证码|动态码|校验码|口令|一次性密码|verification code|one[ -]?time (?:pass|code)|\botp\b|sensitive.*(?:hidden|redacted)|敏感.*(?:隐藏|内容)/iu;

const MACOS_SENSITIVE_BUNDLES = new Set<string>([
  "io.kulo.app",
  "io.kulo.app.dev",
  "io.kulo.desktop",
  "io.kulo.desktop.dev",
  "io.moco.desktop",
  "io.moco.desktop.dev",
  "com.apple.Passwords",
  "com.apple.keychainaccess",
  "com.apple.systempreferences",
  "com.apple.SecurityAgent",
  "com.apple.LocalAuthentication.UIAgent",
  "com.agilebits.onepassword7",
  "com.1password.1password",
  "com.bitwarden.desktop",
  "org.keepassxc.keepassxc",
  "com.dashlane.Dashlane",
  "com.lastpass.LastPass",
  "com.apple.loginwindow",
  "com.apple.UserNotificationCenter",
]);

export function isOneTimeCodeText(text: string): boolean {
  return ONE_TIME_CODE_PATTERN.test(text);
}

export function isMacOsSensitiveBundleId(bundleId: string): boolean {
  const normalized = bundleId.trim();
  if (!normalized) return true;
  if (MACOS_SENSITIVE_BUNDLES.has(normalized)) return true;
  return /^(?:com\.1password\.|com\.agilebits\.onepassword|com\.bitwarden\.|io\.kulo\.(?:app|desktop)(?:\.|$)|io\.moco\.desktop(?:\.|$))/iu.test(normalized);
}

export function isSensitiveNotificationPayload(input: {
  appId: string;
  title?: string;
  subtitle?: string;
  body?: string;
}): boolean {
  if (isMacOsSensitiveBundleId(input.appId)) return true;
  return isOneTimeCodeText(`${input.title ?? ""}\n${input.subtitle ?? ""}\n${input.body ?? ""}`);
}

const safeId = (value: unknown, max = 160): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);

const safeText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !value.includes("\0");

const plainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const CONNECTOR_DRIVERS = new Set<ConnectorDriverId>(["macos-notifications", "spark-mail", "home-assistant", "lark-cli"]);

export function isConnectorDriverId(value: unknown): value is ConnectorDriverId {
  return typeof value === "string" && CONNECTOR_DRIVERS.has(value as ConnectorDriverId);
}

export function isConnectorSourceConfig(value: unknown): value is ConnectorSourceConfig {
  if (!plainObject(value)) return false;
  return isConnectorDriverId(value.driverId) &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.mutedApps) &&
    value.mutedApps.length <= 256 &&
    value.mutedApps.every((item) => safeId(item, 255));
}

export function isConnectorSourceStatus(value: unknown): value is ConnectorSourceStatus {
  if (!plainObject(value)) return false;
  const permissions: ConnectorPermissionState[] = [
    "granted",
    "full_disk_access_required",
    "database_missing",
    "unsupported_schema",
    "unavailable",
    "error",
  ];
  return isConnectorDriverId(value.driverId) &&
    safeId(value.envId, 160) &&
    safeText(value.envName, 200) &&
    safeId(value.platform, 40) &&
    typeof value.enabled === "boolean" &&
    permissions.includes(value.permission as ConnectorPermissionState) &&
    Array.isArray(value.mutedApps) &&
    value.mutedApps.length <= 256 &&
    value.mutedApps.every((item) => safeId(item, 255)) &&
    (value.lastEventAt === undefined || (typeof value.lastEventAt === "number" && Number.isSafeInteger(value.lastEventAt) && value.lastEventAt >= 0)) &&
    (value.error === undefined || safeText(value.error, 500));
}

export function isRawConnectorEvent(value: unknown): value is RawConnectorEvent {
  if (!plainObject(value)) return false;
  return safeId(value.nativeEventId, 200) &&
    safeId(value.eventVersion, 64) &&
    safeId(value.appId, 255) &&
    (value.appLabel === undefined || safeText(value.appLabel, 200)) &&
    (value.threadHint === undefined || safeText(value.threadHint, 256)) &&
    (value.sender === undefined || safeText(value.sender, 256)) &&
    safeText(value.title, 1_000) &&
    (value.subtitle === undefined || safeText(value.subtitle, 1_000)) &&
    safeText(value.body, CONNECTOR_MAX_TEXT_CHARS) &&
    typeof value.occurredAt === "number" &&
    Number.isSafeInteger(value.occurredAt) &&
    value.occurredAt >= 0 &&
    (value.fidelity === "notification" || value.fidelity === "local-db" || value.fidelity === "structured") &&
    (value.snapshotRef === undefined || safeId(value.snapshotRef, 160));
}

export function isConnectorEventBatch(value: unknown): value is ConnectorEventBatch {
  if (!plainObject(value)) return false;
  if (!isConnectorDriverId(value.driverId) ||
    !safeId(value.batchId, 160) ||
    !safeId(value.streamId, 256) ||
    !safeId(value.sourceEpoch, 160) ||
    !safeText(value.cursorAfter, 160) ||
    !Array.isArray(value.events) ||
    value.events.length > CONNECTOR_MAX_BATCH_EVENTS ||
    (value.gapDetected !== undefined && typeof value.gapDetected !== "boolean")) {
    return false;
  }
  if (!value.events.every(isRawConnectorEvent)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= CONNECTOR_MAX_BATCH_BYTES;
  } catch {
    return false;
  }
}

export function isConnectorCallRequest(value: unknown): value is ConnectorCallRequest {
  if (!plainObject(value)) return false;
  const actions = new Set(["status", "list_emails", "search", "read_thread", "list_events", "create_draft"]);
  return value.driverId === "spark-mail" &&
    typeof value.action === "string" &&
    actions.has(value.action) &&
    (value.params === undefined || plainObject(value.params));
}

export function isAssistantItemAction(value: unknown): value is AssistantItemAction {
  return value === "acknowledge" || value === "mute_app" || value === "promote_to_topic" || value === "confirm_action";
}

export const ASSISTANT_FYI_TTL_MS = 2 * 60 * 60 * 1_000;
export const ASSISTANT_ALERT_TTL_MS = 12 * 60 * 60 * 1_000;
export const ASSISTANT_HA_ALERT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface AssistantDismissTarget {
  id: string;
  expectedRevision: number;
  expectedUpdatedAt: number;
}

export function isAssistantDismissTarget(value: unknown): value is AssistantDismissTarget {
  if (!plainObject(value)) return false;
  return safeId(value.id, 160) &&
    typeof value.expectedRevision === "number" &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 1 &&
    typeof value.expectedUpdatedAt === "number" &&
    Number.isSafeInteger(value.expectedUpdatedAt) &&
    value.expectedUpdatedAt >= 0;
}

export function isAssistantDecisionItem(
  item: Pick<AssistantItemView, "kind" | "pendingAction">,
): boolean {
  return item.kind === "decision" || Boolean(item.pendingAction);
}

export function defaultAssistantItemTtlMs(kind: AssistantItemKind, sourceApp: string): number | undefined {
  if (kind === "decision") return undefined;
  if (kind === "alert") {
    return sourceApp === "home-assistant" ? ASSISTANT_HA_ALERT_TTL_MS : ASSISTANT_ALERT_TTL_MS;
  }
  return ASSISTANT_FYI_TTL_MS;
}

export function effectiveAssistantItemExpiresAt(
  item: Pick<AssistantItemView, "kind" | "sourceApp" | "pendingAction" | "updatedAt" | "expiresAt">,
): number | undefined {
  if (isAssistantDecisionItem(item)) return undefined;
  if (typeof item.expiresAt === "number" && Number.isFinite(item.expiresAt)) {
    return item.expiresAt;
  }
  const ttl = defaultAssistantItemTtlMs(item.kind, item.sourceApp);
  return ttl === undefined ? undefined : item.updatedAt + ttl;
}

export function isAssistantItemExpired(
  item: Pick<AssistantItemView, "kind" | "sourceApp" | "pendingAction" | "updatedAt" | "expiresAt">,
  now: number,
): boolean {
  const expiresAt = effectiveAssistantItemExpiresAt(item);
  return expiresAt !== undefined && now >= expiresAt;
}

/** 0: L2 decision -> 1: Home Assistant alert -> 2: ordinary alert -> 3: fyi */
export function assistantItemPriorityRank(
  item: Pick<AssistantItemView, "kind" | "sourceApp" | "pendingAction">,
): number {
  if (isAssistantDecisionItem(item)) return 0;
  if (item.kind === "alert") return item.sourceApp === "home-assistant" ? 1 : 2;
  return 3;
}

export function compareAssistantItems(a: AssistantItemView, b: AssistantItemView): number {
  return (
    assistantItemPriorityRank(a) - assistantItemPriorityRank(b) ||
    b.updatedAt - a.updatedAt ||
    a.id.localeCompare(b.id)
  );
}
