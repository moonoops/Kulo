import fs from "node:fs";
import path from "node:path";
import {
  CUSTOM_PROVIDER_APIS,
  normalizeVertexConfig,
  defaultRolePresets,
  type CompactionConfig,
  type CompletedTaskDisplayHours,
  type CustomModelConfig,
  type CustomProviderApi,
  type CustomProviderConfig,
  type HindsightMemoryConfig,
  type OpenAIApiMode,
  type PresentationConfig,
  type RolePreset,
  type ThinkingEffort,
} from "@kulo/protocol";

export type { OpenAIApiMode };

export function isCustomProviderApi(raw: unknown): raw is CustomProviderApi {
  return (
    typeof raw === "string" &&
    (CUSTOM_PROVIDER_APIS as readonly string[]).includes(raw)
  );
}

/**
 * Accepts current `CustomProviderApi` values as well as legacy gateway aliases
 * (`"completions"` -> `"openai-completions"`, `"responses"` -> `"openai-responses"`).
 */
export function coerceCustomProviderApi(raw: unknown): CustomProviderApi | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "completions") return "openai-completions";
  if (trimmed === "responses") return "openai-responses";
  return isCustomProviderApi(trimmed) ? trimmed : null;
}

export function normalizeCustomProviderApi(
  raw: unknown,
  fallback: CustomProviderApi = "openai-completions",
): CustomProviderApi {
  return coerceCustomProviderApi(raw) ?? fallback;
}

export const DEFAULT_CONTEXT_WINDOW = 256_000;
export const DEFAULT_MAX_TOKENS = 64_000;

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 24_000,
  backgroundTokens: 32_768,
};

export interface KuloModelConfig {
  baseUrl: string;
  apiKey?: string;
  apiMode: CustomProviderApi;
  vertexProject?: string;
  vertexLocation?: string;
  defaultProvider?: string;
  defaultModel: string;
  thinkingLevel: ThinkingEffort;
  contextWindow: number;
  compaction: CompactionConfig;
  customProviders: CustomProviderConfig[];
  subscriptionModels?: Record<string, CustomModelConfig[]>;
  gatewayName?: string;
  gatewayModels?: CustomModelConfig[];
  gatewayDisabled?: boolean;
}

export interface KuloCustomizationConfig {
  dataDir: string;
  appRoot: string;
  trustedRoot?: string;
  nodePath: string;
  shellVersion?: string;
  sourceRoot?: string;
}

export interface KuloHubConfig {
  stateDir: string;
  identityDir: string;
  host: string;
  port: number;
  authToken?: string;
  /** Node-only credentials, bound to a single env ID; never accepted by the client API. */
  envTokens: Record<string, string>;
  workerEnvIds: string[];
  enableLocalEnv: boolean;
  localEnvRoot?: string;
  localEnvName?: string;
  /** Supplied by the trusted desktop host, never by a settings form. */
  customization?: KuloCustomizationConfig;
  maxConcurrentWorkers: number;
  maxSubagentsPerTicket: number;
  watchdogMinutes: number;
  /** Default A2-lite inline wait window in ms when a free slot is available (default 10000; 0 disables inline wait). */
  inlineDispatchWaitMs?: number;
  completedTaskDisplayHours?: CompletedTaskDisplayHours;
  model: KuloModelConfig;
  roles: Record<string, RolePreset>;
  memory: HindsightMemoryConfig;
  presentation: PresentationConfig;
}

export type KuloHubConfigOverrides = Omit<Partial<KuloHubConfig>, "model"> & {
  model?: Partial<KuloModelConfig>;
  /** @deprecated Legacy alias mapped to maxConcurrentWorkers */
  normalSlots?: number;
};

/**
 * Normalizes OpenAI-compatible gateway URLs:
 * - Bare origins such as `https://api.example.com` automatically become `https://api.example.com/v1`
 * - Explicit paths such as `https://openrouter.ai/api/v1` are preserved without trailing slashes.
 */
export function normalizeOpenAIBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "https://api.openai.com/v1";
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === "" || parsed.pathname === "/") {
      return `${parsed.origin}/v1`;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export function normalizeProviderBaseUrl(raw: string, api: CustomProviderApi): string {
  if (api === "openai-completions" || api === "openai-responses") {
    return normalizeOpenAIBaseUrl(raw);
  }
  return raw.trim().replace(/\/+$/, "");
}

/** Load a `.env` file into `process.env` without overriding existing env vars. */
export function loadDotEnv(envFilePath = path.resolve(process.cwd(), ".env")): void {
  if (!fs.existsSync(envFilePath)) return;
  const content = fs.readFileSync(envFilePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseEnvTokens(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("KULO_ENV_TOKENS 必须是节点 ID 到独立密钥的 JSON 对象。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("KULO_ENV_TOKENS 必须是节点 ID 到独立密钥的 JSON 对象。");
  }
  const result: Record<string, string> = {};
  const tokens = new Set<string>();
  for (const [id, token] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || id === "local" ||
        typeof token !== "string" || !token.trim() || /\s/.test(token)) {
      throw new Error("KULO_ENV_TOKENS 包含无效的节点身份或密钥。");
    }
    if (tokens.has(token)) throw new Error("每个执行节点必须使用不同的密钥。");
    tokens.add(token);
    result[id] = token;
  }
  return result;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const lower = raw.trim().toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
  return fallback;
}

export function parseThinking(
  raw: string | undefined,
  fallback: ThinkingEffort,
): ThinkingEffort {
  const value = raw?.trim();
  if (value && value !== "auto" && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value)) return value;
  return fallback;
}

export function resolveHubStateDir(override?: string): string {
  return path.resolve(override ?? process.env.KULO_STATE_DIR ?? path.join(process.cwd(), ".kulo-state"));
}

export function resolveHubConfig(overrides: KuloHubConfigOverrides = {}): KuloHubConfig {
  loadDotEnv();
  const stateDir = resolveHubStateDir(overrides.stateDir);

  const rawIdentityDir = overrides.identityDir ?? process.env.KULO_IDENTITY_DIR?.trim();
  const identityDir = rawIdentityDir
    ? path.resolve(rawIdentityDir)
    : path.join(stateDir, "identity");

  const roles = defaultRolePresets();
  for (const r of Object.values(roles)) {
    if (r.enabled === undefined) r.enabled = true;
  }

  const scoutModel = process.env.KULO_SCOUT_MODEL?.trim();
  if (scoutModel && roles.scout) roles.scout.modelId = scoutModel;

  const archModel = process.env.KULO_ARCHITECT_MODEL?.trim();
  if (archModel && roles.architect) roles.architect.modelId = archModel;

  const coderModel =
    process.env.KULO_CODER_MODEL?.trim() || process.env.KULO_ENGINEER_MODEL?.trim();
  if (coderModel && roles.coder) roles.coder.modelId = coderModel;

  const checkerModel =
    process.env.KULO_CHECKER_MODEL?.trim() || process.env.KULO_REVIEWER_MODEL?.trim();
  if (checkerModel && roles.checker) roles.checker.modelId = checkerModel;

  const designerModel = process.env.KULO_DESIGNER_MODEL?.trim();
  if (designerModel && roles.designer) roles.designer.modelId = designerModel;

  const writerModel = process.env.KULO_WRITER_MODEL?.trim();
  if (writerModel && roles.writer) roles.writer.modelId = writerModel;

  if (overrides.roles) {
    for (const [k, v] of Object.entries(overrides.roles)) {
      roles[k] = { enabled: true, ...v };
    }
  }

  const rawApiMode = overrides.model?.apiMode ?? process.env.KULO_API_MODE?.trim();
  const apiMode: CustomProviderApi = normalizeCustomProviderApi(rawApiMode);

  const baseUrl = normalizeProviderBaseUrl(
    overrides.model?.baseUrl ??
      process.env.KULO_BASE_URL ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1",
    apiMode,
  );

  const apiKey =
    overrides.model?.apiKey ??
    (process.env.KULO_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || undefined);

  const defaultProvider =
    overrides.model?.defaultProvider?.trim() ??
    process.env.KULO_DEFAULT_PROVIDER?.trim();

  const defaultModel =
    overrides.model?.defaultModel?.trim() ??
    process.env.KULO_MODEL?.trim() ?? "";

  const hasExplicitGateway = Boolean(
    overrides.model?.gatewayDisabled === false ||
    overrides.model?.baseUrl?.trim() ||
    overrides.model?.gatewayName?.trim() ||
    overrides.model?.gatewayModels?.length ||
    apiKey?.trim() ||
    process.env.KULO_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    defaultProvider === "kulo-gateway" ||
    (defaultModel && !defaultProvider),
  );
  const gatewayDisabled =
    overrides.model?.gatewayDisabled !== undefined
      ? Boolean(overrides.model.gatewayDisabled) && defaultProvider !== "kulo-gateway"
      : !hasExplicitGateway;

  const thinkingLevel =
    overrides.model?.thinkingLevel ??
    parseThinking(process.env.KULO_THINKING_LEVEL?.trim(), "medium");

  const contextWindow =
    overrides.model?.contextWindow ??
    parsePositiveInt(process.env.KULO_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW);

  const compaction: CompactionConfig = {
    enabled: overrides.model?.compaction?.enabled ?? DEFAULT_COMPACTION_CONFIG.enabled,
    reserveTokens:
      overrides.model?.compaction?.reserveTokens ?? DEFAULT_COMPACTION_CONFIG.reserveTokens,
    keepRecentTokens:
      overrides.model?.compaction?.keepRecentTokens ??
      DEFAULT_COMPACTION_CONFIG.keepRecentTokens,
    backgroundTokens:
      overrides.model?.compaction?.backgroundTokens ??
      DEFAULT_COMPACTION_CONFIG.backgroundTokens,
  };

  const rawCustomProviders = Array.isArray(overrides.model?.customProviders)
    ? overrides.model!.customProviders!
    : [];
  const customProviders = rawCustomProviders.map(({ vertexProject, vertexLocation, ...provider }) => ({
    ...provider,
    ...(provider.api === "google-vertex" ? normalizeVertexConfig({ vertexProject, vertexLocation }) : undefined),
  }));
  const vertex = apiMode === "google-vertex" ? normalizeVertexConfig(overrides.model ?? {}) : undefined;

  const rawEndpoints = process.env.KULO_HINDSIGHT_ENDPOINTS?.trim();
  const parsedEndpoints = rawEndpoints
    ? rawEndpoints
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const memory: HindsightMemoryConfig = {
    accessMode: overrides.memory?.accessMode ?? "kulo",
    enabled:
      overrides.memory?.enabled ??
      parseBoolean(process.env.KULO_HINDSIGHT_ENABLED, false),
    endpoint:
      overrides.memory?.endpoint ??
      (process.env.KULO_HINDSIGHT_URL?.trim() || "http://127.0.0.1:8888"),
    endpoints: overrides.memory?.endpoints ?? parsedEndpoints,
    caCertPem: overrides.memory?.caCertPem ?? "",
    routerApiKey: overrides.memory?.routerApiKey,
    workerApiKey: overrides.memory?.workerApiKey,
    sharedReadApiKey: overrides.memory?.sharedReadApiKey,
    sharedReadApiKeyEnv: overrides.memory?.sharedReadApiKeyEnv ?? "KULO_HINDSIGHT_SHARED_READ_API_KEY",
    sharedReadApiKeyDisabled: overrides.memory?.sharedReadApiKeyDisabled,
    routerApiKeyEnv: overrides.memory?.routerApiKeyEnv ?? "KULO_HINDSIGHT_ROUTER_API_KEY",
    workerApiKeyEnv: overrides.memory?.workerApiKeyEnv ?? "KULO_HINDSIGHT_WORKER_API_KEY",
    routerApiKeyDisabled: overrides.memory?.routerApiKeyDisabled,
    workerApiKeyDisabled: overrides.memory?.workerApiKeyDisabled,
    authFile: overrides.memory?.authFile ?? "",
    autoAttachTopLevelRouters: overrides.memory?.autoAttachTopLevelRouters ?? true,
    banks: {
      private:
        overrides.memory?.banks?.private ??
        (process.env.KULO_HINDSIGHT_PRIVATE_BANK?.trim() || "kulo-core"),
      shared:
        overrides.memory?.banks?.shared ??
        (process.env.KULO_HINDSIGHT_SHARED_BANK?.trim() || "kulo-shared"),
    },
  };

  const presentation: PresentationConfig = {
    agentName: overrides.presentation?.agentName ?? "Kulo",
    workbenchName: overrides.presentation?.workbenchName ?? "Kulo's table",
  };
  const completedTaskDisplayHours = overrides.completedTaskDisplayHours === undefined
    ? 3
    : overrides.completedTaskDisplayHours;
  if (completedTaskDisplayHours !== null && ![1, 3, 6].includes(completedTaskDisplayHours)) {
    throw new Error("已完成任务显示时长需为 1、3、6 小时或一直显示。");
  }

  return {
    stateDir,
    identityDir,
    host: overrides.host ?? (process.env.KULO_HUB_HOST?.trim() || "127.0.0.1"),
    port: overrides.port ?? parsePositiveInt(process.env.KULO_HUB_PORT, 7788),
    authToken:
      overrides.authToken ?? (process.env.KULO_AUTH_TOKEN?.trim() || undefined),
    envTokens: overrides.envTokens ?? parseEnvTokens(process.env.KULO_ENV_TOKENS),
    workerEnvIds: overrides.workerEnvIds ?? (process.env.KULO_WORKER_ENV_IDS ?? "")
      .split(",").map((id) => id.trim()).filter(Boolean),
    enableLocalEnv: overrides.enableLocalEnv ?? true,
    localEnvRoot: overrides.localEnvRoot,
    localEnvName: overrides.localEnvName,
    ...(overrides.customization ? { customization: { ...overrides.customization } } : {}),
    maxConcurrentWorkers:
      overrides.maxConcurrentWorkers ??
      overrides.normalSlots ??
      parsePositiveInt(
        process.env.KULO_MAX_WORKERS ?? process.env.KULO_NORMAL_SLOTS,
        3,
      ),
    maxSubagentsPerTicket: Math.min(
      8,
      Math.max(
        1,
        overrides.maxSubagentsPerTicket ??
          parsePositiveInt(process.env.KULO_MAX_SUBAGENTS_PER_TICKET, 4),
      ),
    ),
    watchdogMinutes:
      overrides.watchdogMinutes ??
      parseNonNegativeInt(process.env.KULO_WATCHDOG_MINUTES, 5),
    inlineDispatchWaitMs: Math.min(
      15_000,
      Math.max(
        0,
        overrides.inlineDispatchWaitMs ??
          parseNonNegativeInt(process.env.KULO_INLINE_DISPATCH_WAIT_MS, 10_000),
      ),
    ),
    completedTaskDisplayHours,
    model: {
      baseUrl,
      apiKey,
      apiMode,
      ...vertex,
      ...(defaultProvider !== undefined ? { defaultProvider } : {}),
      defaultModel,
      thinkingLevel,
      contextWindow,
      compaction,
      customProviders,
      ...(overrides.model?.subscriptionModels !== undefined ? { subscriptionModels: overrides.model.subscriptionModels } : {}),
      ...(overrides.model?.gatewayName !== undefined ? { gatewayName: overrides.model.gatewayName } : {}),
      ...(overrides.model?.gatewayModels !== undefined ? { gatewayModels: overrides.model.gatewayModels } : {}),
      ...(gatewayDisabled ? { gatewayDisabled: true } : {}),
    },
    roles,
    memory,
    presentation,
  };
}
