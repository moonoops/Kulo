import { randomUUID, createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type {
  BrowserRequest, BrowserResult, CapabilityConfigurationInput, CapabilityRecord,
  CapabilitySnapshot, CapabilityStatus, CustomModelConfig, CustomProviderApi, EnvNodeDescriptor, MediaAdapterId,
  MediaConnectionView, MediaKind, MediaOutputFormat, SetupInputRequest, ImageModelProfile,
  ImageRoutingSettings, ImageRoutingConfigurationInput, MediaJobRequest, ImageCapabilityRouting,
} from "@kulo/protocol";
import {
  defaultProtocolAdapterForModel, getImageModelPreset, getImageModelProfile, inferModelPurpose,
  mergeImageGenerationParameters, normalizeImageGenerationParameters, validateImageModelProfile, validateCustomImageAdapter,
} from "@kulo/protocol";

const ORIGIN_ENV = "KULO_API_KEY_ORIGIN";
const ADAPTERS: readonly MediaAdapterId[] = ["openai-image", "gemini-image", "custom-image", "flow-browser"];
const INPUT_LIFETIME_MS = 15 * 60_000;
const MAX_CAPABILITIES = 128;

interface StoredConnection extends Omit<MediaConnectionView, "hasCredential"> {
  credentialRef?: string;
}
interface StoredInput extends SetupInputRequest {
  connectionId: string;
  connectionRevision: number;
  origin?: string;
}
interface CommandReceipt {
  fingerprint: string;
  capability?: CapabilityRecord;
  routing?: ImageRoutingSettings;
}
export interface KuloCapabilitiesState {
  revision: number;
  capabilities: Record<string, CapabilityRecord>;
  connections: Record<string, StoredConnection>;
  commands: Record<string, CommandReceipt>;
  inputs: Record<string, StoredInput>;
  cleanup: Record<string, boolean>;
  imageRouting?: ImageRoutingSettings;
  dismissedModelCapabilities?: Record<string, string>;
}

export interface SyncedProviderImageSource {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  preset?: string;
  models: readonly CustomModelConfig[];
}

export const KuloCapabilitiesDoc = defineDoc<KuloCapabilitiesState & JsonObject>({
  kind: "kulo.capabilities", version: 1, scope: "session",
  initial: () => ({ revision: 0, capabilities: {}, connections: {}, commands: {}, inputs: {}, cleanup: {} }) as KuloCapabilitiesState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export class CapabilityError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message); this.name = "CapabilityError";
  }
}

export interface KuloCapabilitiesOptions {
  harness: Harness;
  credentials: CredentialStore;
  resolveProviderApiKey?: (providerId: string, baseUrl: string) => Promise<string | undefined>;
  envs: () => EnvNodeDescriptor[];
  browser: (envId: string, request: BrowserRequest) => Promise<BrowserResult>;
  onChanged?: () => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
export interface CapabilityPreferenceValues {
  name: string;
  enabled: boolean;
  allowTaskGeneration: boolean;
  maxOutputs: number;
}
export interface RestoreCapabilityPreferencesInput {
  id: string;
  commandId: string;
  expectedRevision: number;
  expectedWorkspaceRevision: number;
  connectionId: string;
  modelId: string;
  values: CapabilityPreferenceValues;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined;
function fail(status: number, code: string, message: string): never { throw new CapabilityError(status, code, message); }
function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, "invalid_capability", `${label}无效。`);
  return value.trim();
}
function identifier(value: unknown, label: string): string {
  const result = text(value, label);
  if (["__proto__", "constructor", "prototype"].includes(result)) fail(400, "invalid_capability", `${label}无效。`);
  return result;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(400, "capability_revision_required", "请先读取当前能力版本。");
  return Number(value);
}
function fingerprint(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, ordered(value)]));
    return item;
  }
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}
function normalizedUrl(value: unknown, adapter: MediaAdapterId): string {
  if (adapter === "custom-image" && value === undefined) fail(400, "invalid_capability_url", "请填写自定义服务地址。");
  const raw = value === undefined ? adapter === "openai-image" ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com/v1beta" : text(value, "服务地址", 2048);
  let url: URL;
  try { url = new URL(raw); } catch { return fail(400, "invalid_capability_url", "服务地址必须是有效的 HTTP 或 HTTPS 地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    fail(400, "invalid_capability_url", "服务地址不能包含凭证、查询参数或片段。");
  }
  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (!cleanPath) url.pathname = adapter === "openai-image" ? "/v1" : "/v1beta";
  else if (adapter === "gemini-image" && url.hostname !== "generativelanguage.googleapis.com" && /\/v1$/i.test(cleanPath)) {
    url.pathname = cleanPath.replace(/\/v1$/i, "/v1beta");
  } else if (adapter === "openai-image" && url.hostname !== "api.openai.com" && /\/v1beta$/i.test(cleanPath)) {
    url.pathname = cleanPath.replace(/\/v1beta$/i, "/v1");
  }
  return url.toString().replace(/\/+$/, "");
}
function modelCapabilities(adapter: MediaAdapterId, modelId: string, profile?: ImageModelProfile): { kind: MediaKind; formats: MediaOutputFormat[]; supportsEdit: boolean } {
  if (adapter === "flow-browser") return { kind: "video", formats: ["mp4"], supportsEdit: false };
  if (adapter === "openai-image" && /^dall-e-/i.test(modelId)) fail(400, "unsupported_media_model", "当前图片适配器使用 GPT Image 协议，尚未接入 DALL-E 协议。");
  if (!profile) fail(400, "image_profile_required", "此模型尚无图像能力声明，请通过配置表单或右侧Kulo补充接口与参数。");
  return { kind: "image", formats: [...profile.formats], supportsEdit: profile.supportsEdit };
}
const defaultRouting = (): ImageRoutingSettings => ({ mode: "auto", preference: "balanced", instructions: "", rules: [] });
function imageValue<T>(run: () => T): T { try { return run(); } catch (cause) { if (cause instanceof CapabilityError) throw cause; return fail(400, "invalid_image_configuration", cause instanceof Error ? cause.message : "图像配置无效。"); } }
function capabilityRouting(value: ImageCapabilityRouting | undefined): ImageCapabilityRouting | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["priority", "useCases", "instructions"].includes(key))
    || value.priority !== undefined && (!Number.isInteger(value.priority) || value.priority < -100 || value.priority > 100)
    || value.useCases !== undefined && (!Array.isArray(value.useCases) || value.useCases.length > 20 || value.useCases.some((item) => typeof item !== "string" || !item.trim() || item.length > 80))
    || value.instructions !== undefined && (typeof value.instructions !== "string" || value.instructions.length > 2000)) fail(400, "invalid_image_routing", "图像调用偏好无效。");
  return clone(value);
}
function requireCapability(state: Readonly<KuloCapabilitiesState> | undefined, id: string): CapabilityRecord {
  return own(state?.capabilities, id) ?? fail(404, "capability_not_found", "能力不存在或已移除。");
}
function requireConnection(state: Readonly<KuloCapabilitiesState> | undefined, id: string): StoredConnection {
  return own(state?.connections, id) ?? fail(404, "connection_not_found", "能力连接不存在或已移除。");
}
function assertRevision(capability: CapabilityRecord, expected: number): void {
  if (capability.revision !== expected) fail(409, "capability_revision_conflict", "能力已被其他操作更新，请重新读取后重试。");
}
function publicInput(input: StoredInput): SetupInputRequest {
  const { connectionId: _connectionId, connectionRevision: _connectionRevision, origin: _origin, ...view } = clone(input);
  return view;
}
async function metadataMatches(response: Response, adapter: MediaAdapterId, modelId: string): Promise<boolean> {
  if (!response.body) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 64 * 1024) fail(502, "media_metadata_too_large", "服务返回的模型信息过大。");
      chunks.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return adapter === "gemini-image"
      ? object.name === `models/${modelId.replace(/^models\//, "")}`
      : object.id === modelId;
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export class KuloCapabilities {
  readonly #options: KuloCapabilitiesOptions;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(options: KuloCapabilitiesOptions) { this.#options = options; }
  async initialize(): Promise<void> {
    await this.#serial(async () => {
      await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(KuloCapabilitiesDoc);
        let changed = false;
        for (const cap of Object.values(state.capabilities)) {
          if (cap.kind !== "image" || cap.imageProfile) continue;
          const connection = requireConnection(state, cap.connectionId);
          const preset = getImageModelPreset(connection.adapter, cap.modelId);
          if (!preset) continue;
          cap.imageProfile = clone(preset.profile);
          cap.defaults = clone(preset.defaults);
          cap.formats = [...preset.profile.formats];
          cap.supportsEdit = preset.profile.supportsEdit;
          cap.revision++;
          cap.updatedAt = this.#now();
          changed = true;
        }
        if (changed) state.revision++;
      }, BACKGROUND_CONTEXT);
      await this.#cleanup();
    });
  }
  #now(): number { return this.#options.now?.() ?? Date.now(); }
  async #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(run, run);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
  async #changed(): Promise<void> { await this.#options.onChanged?.(); }
  async #state(): Promise<Readonly<KuloCapabilitiesState> | undefined> {
    return this.#options.harness.snapshot(KuloCapabilitiesDoc, BACKGROUND_CONTEXT);
  }
  #device(connection: StoredConnection): EnvNodeDescriptor {
    const device = this.#options.envs().find((env) => env.id === connection.browserEnvId);
    if (!device?.online) fail(409, "browser_device_offline", "浏览器所在设备离线。");
    if (!device.capabilities.includes("flow-browser")) fail(409, "browser_dependency_missing", "该设备尚未提供 Flow 浏览器能力。");
    return device;
  }
  async #boundKey(connection: StoredConnection): Promise<string | undefined> {
    if (!connection.origin || !connection.baseUrl || new URL(connection.baseUrl).origin !== connection.origin) return undefined;
    if (connection.credentialProviderId) return this.#options.resolveProviderApiKey?.(connection.credentialProviderId, connection.baseUrl);
    if (!connection.credentialRef) return undefined;
    const credential = await this.#options.credentials.read(connection.credentialRef);
    return credential?.type === "api_key" && credential.env?.[ORIGIN_ENV] === connection.origin && new URL(connection.baseUrl).origin === connection.origin && credential.key?.trim() ? credential.key : undefined;
  }
  async #connectionView(connection: StoredConnection): Promise<MediaConnectionView> {
    const { credentialRef: _credentialRef, ...view } = clone(connection);
    return { ...view, hasCredential: connection.customAdapter?.auth.type === "none" || Boolean(await this.#boundKey(connection)) };
  }
  async #capabilityView(capability: CapabilityRecord, connection: StoredConnection): Promise<CapabilityRecord> {
    const result = clone(capability);
    if (!result.enabled) { result.status = "disabled"; delete result.error; return result; }
    if (connection.adapter === "flow-browser") {
      const device = this.#options.envs().find((env) => env.id === connection.browserEnvId);
      if (!device?.online) { result.status = "offline"; result.error = "浏览器所在设备离线。"; }
      else if (!device.capabilities.includes("flow-browser")) { result.status = "missing_dependency"; result.error = "该设备尚未提供 Flow 浏览器能力。"; }
    } else if (connection.customAdapter?.auth.type !== "none" && !await this.#boundKey(connection)) { result.status = "needs_auth"; result.error = "需要填写此服务的 API Key。"; }
    return result;
  }
  async snapshot(): Promise<CapabilitySnapshot> {
    const state = await this.#state();
    const connections = Object.values(state?.connections ?? {}).sort((a, b) => a.id.localeCompare(b.id));
    const capabilities = Object.values(state?.capabilities ?? {}).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return {
      revision: state?.revision ?? 0,
      connections: await Promise.all(connections.map((item) => this.#connectionView(item))),
      capabilities: await Promise.all(capabilities.map((item) => this.#capabilityView(item, requireConnection(state, item.connectionId)))),
      imageRouting: clone(state?.imageRouting ?? defaultRouting()),
    };
  }
  #defaults(state: KuloCapabilitiesState, kind: MediaKind, preferred?: string): void {
    const candidates = Object.values(state.capabilities).filter((cap) => cap.kind === kind && cap.enabled).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const selected = candidates.find((cap) => cap.id === preferred) ?? candidates.find((cap) => cap.isDefault) ?? candidates[0];
    for (const cap of Object.values(state.capabilities)) {
      if (cap.kind !== kind) continue;
      const next = cap.id === selected?.id;
      if (cap.isDefault !== next) { cap.isDefault = next; cap.revision++; cap.updatedAt = this.#now(); }
    }
  }
  #retireUnused(state: KuloCapabilitiesState): void {
    const referenced = new Set(Object.values(state.capabilities).map((cap) => cap.connectionId));
    for (const connection of Object.values(state.connections)) {
      if (referenced.has(connection.id)) continue;
      delete state.connections[connection.id];
      if (connection.credentialRef && !Object.values(state.connections).some((item) => item.credentialRef === connection.credentialRef)) state.cleanup[connection.credentialRef] = true;
    }
  }
  async #cleanup(): Promise<void> {
    const pending = Object.keys((await this.#state())?.cleanup ?? {});
    for (const credentialRef of pending) {
      try { await this.#options.credentials.delete(credentialRef); }
      catch { fail(500, "capability_cleanup_pending", "配置已保存，旧凭证清理尚未完成，请重试原操作。"); }
      await this.#options.harness.commit(async (tx) => { delete (await tx.doc(KuloCapabilitiesDoc)).cleanup[credentialRef]; }, BACKGROUND_CONTEXT);
    }
  }

  async configure(raw: CapabilityConfigurationInput): Promise<CapabilityRecord> {
    const result = await this.#serial(async () => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(400, "invalid_capability", "能力配置无效。");
      const allowed = ["commandId", "id", "expectedRevision", "name", "adapter", "baseUrl", "modelId", "browserEnvId", "profileRef", "credentialProviderId", "enabled", "isDefault", "allowTaskGeneration", "maxOutputs", "imageProfile", "defaults", "routing", "customAdapter"];
      if (Object.keys(raw).some((key) => !allowed.includes(key))) fail(400, "invalid_capability", "配置包含不支持的字段，凭证必须使用保密输入。");
      const commandId = identifier(raw.commandId, "操作标识");
      if (!ADAPTERS.includes(raw.adapter)) fail(400, "unsupported_media_adapter", "尚未支持该媒体接口，请提供接口文档以补充适配。");
      const name = text(raw.name, "能力名称", 100);
      const suppliedModel = text(raw.modelId, "模型标识", 200);
      const modelId = raw.adapter === "gemini-image" ? suppliedModel.replace(/^models\//, "") : suppliedModel;
      if (raw.adapter !== "flow-browser" && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(modelId)) fail(400, "invalid_capability_model", "模型标识无效。");
      for (const field of ["enabled", "isDefault", "allowTaskGeneration"] as const) {
        if (raw[field] !== undefined && typeof raw[field] !== "boolean") fail(400, "invalid_capability", "能力开关必须是布尔值。");
      }
      if (raw.maxOutputs !== undefined && (!Number.isSafeInteger(raw.maxOutputs) || raw.maxOutputs < 1 || raw.maxOutputs > 8)) fail(400, "invalid_capability", "每次生成数量上限应为 1 至 8。");
      const input = { ...raw, commandId, name, modelId };
      const signature = fingerprint({ action: "configure", input });
      const previousReceipt = own((await this.#state())?.commands, commandId);
      if (previousReceipt) {
        if (previousReceipt.fingerprint !== signature || !previousReceipt.capability) fail(409, "capability_command_conflict", "同一操作标识不能用于不同配置。");
        await this.#cleanup();
        return clone(previousReceipt.capability);
      }
      const before = await this.#state();
      const old = raw.id !== undefined ? requireCapability(before, identifier(raw.id, "能力标识")) : undefined;
      if (old) assertRevision(old, revision(raw.expectedRevision));
      else if (raw.expectedRevision !== undefined) fail(400, "invalid_capability", "新增能力不需要旧版本。");
      const oldConnection = old ? requireConnection(before, old.connectionId) : undefined;
      const adapter = raw.adapter;
      if (adapter === "openai-image" && /^dall-e-/i.test(modelId)) fail(400, "unsupported_media_model", "当前图片适配器使用 GPT Image 协议，尚未接入 DALL-E 协议。");
      const profile = adapter === "flow-browser" ? undefined : imageValue(() => validateImageModelProfile(raw.imageProfile ??
        (oldConnection?.adapter === adapter && old?.modelId === modelId ? old.imageProfile : undefined) ??
        getImageModelProfile(adapter, modelId) ?? fail(400, "image_profile_required", "此模型尚无图像能力声明，请通过配置表单或右侧Kulo补充接口与参数。")));
      const preset = getImageModelPreset(adapter, modelId);
      if (preset && profile && (profile.formats.some((format) => !preset.profile.formats.includes(format)) || profile.supportsEdit && !preset.profile.supportsEdit || profile.maxReferences > preset.profile.maxReferences
        || ["supportsTransparency", "supportsComplexity", "supportsCustomSize", "supportsGrounding"].some((key) => profile[key as keyof ImageModelProfile] === true && preset.profile[key as keyof ImageModelProfile] !== true)
        || ["qualities", "thinkingLevels", "aspectRatios"].some((key) => (profile[key as "qualities"] ?? []).some((value) => !preset.profile[key as "qualities"]?.includes(value))))) fail(400, "invalid_image_profile", "模型声明超出预设接口支持的能力。");
      const defaults = profile ? imageValue(() => normalizeImageGenerationParameters(raw.defaults ??
        (oldConnection?.adapter === adapter && old?.modelId === modelId ? old.defaults : undefined) ?? preset?.defaults ?? {}, profile, adapter)) : undefined;
      if (defaults?.count !== undefined && defaults.count > (raw.maxOutputs ?? old?.maxOutputs ?? 1)) fail(400, "invalid_image_configuration", "默认图片数量超过单次输出上限。");
      const routing = capabilityRouting(raw.routing ?? old?.routing);
      const customAdapter = adapter === "custom-image" ? imageValue(() => validateCustomImageAdapter(raw.customAdapter ?? oldConnection?.customAdapter!)) : undefined;
      if (customAdapter && profile?.supportsEdit && !customAdapter.edit) fail(400, "invalid_image_configuration", "已声明参考图编辑能力，请补充编辑接口。");
      if (adapter !== "custom-image" && raw.customAdapter !== undefined) fail(400, "invalid_image_configuration", "只有自定义图像接口使用请求映射。");
      if (adapter === "flow-browser" && (raw.imageProfile !== undefined || raw.defaults !== undefined)) fail(400, "invalid_image_configuration", "Flow视频不使用图像参数。");
      const baseUrl = adapter === "flow-browser" ? undefined : normalizedUrl(raw.baseUrl ?? (oldConnection?.adapter === adapter ? oldConnection.baseUrl : undefined), adapter);
      if (adapter === "flow-browser" && raw.baseUrl !== undefined) fail(400, "invalid_capability", "会员浏览器连接不使用 API 地址。");
      if (adapter === "flow-browser" && raw.credentialProviderId !== undefined) fail(400, "invalid_capability", "会员浏览器连接不使用模型 API Key。");
      if (adapter !== "flow-browser" && (raw.browserEnvId !== undefined || raw.profileRef !== undefined)) fail(400, "invalid_capability", "API 连接不使用浏览器会话。");
      const credentialProviderId = raw.credentialProviderId === null ? undefined : raw.credentialProviderId !== undefined
        ? identifier(raw.credentialProviderId, "模型连接标识") : oldConnection?.adapter === adapter ? oldConnection.credentialProviderId : undefined;
      if (credentialProviderId && !await this.#options.resolveProviderApiKey?.(credentialProviderId, baseUrl!)) {
        fail(409, "capability_provider_credential_unavailable", "此模型连接没有可复用的同来源 API Key；请选择有效连接，或使用新密钥的保密输入。OAuth 订阅不能复用为生图密钥。");
      }
      const browserEnvId = adapter === "flow-browser" ? identifier(raw.browserEnvId ?? oldConnection?.browserEnvId, "浏览器设备") : undefined;
      const existingBrowser = adapter === "flow-browser" ? Object.values(before?.connections ?? {}).find((connection) => connection.adapter === adapter && connection.browserEnvId === browserEnvId) : undefined;
      const profileRef = adapter === "flow-browser" ? raw.profileRef ?? (oldConnection?.adapter === adapter && oldConnection.browserEnvId === browserEnvId ? oldConnection.profileRef : existingBrowser?.profileRef) ?? `flow-${randomUUID()}` : undefined;
      if (profileRef && !/^[A-Za-z0-9_-]{1,100}$/.test(profileRef)) fail(400, "invalid_capability", "浏览器会话标识无效。");
      if (adapter === "flow-browser") this.#device({ id: "", name, adapter, browserEnvId, profileRef, revision: 1 });
      const endpointKey = fingerprint({ adapter, baseUrl, browserEnvId, profileRef, credentialProviderId, customAdapter,
        ...(raw.credentialProviderId === null ? { newCredentialCommand: commandId } : {}) });
      const keepConnection = raw.credentialProviderId !== null && oldConnection?.adapter === adapter && oldConnection.baseUrl === baseUrl &&
        oldConnection.browserEnvId === browserEnvId && oldConnection.profileRef === profileRef && oldConnection.credentialProviderId === credentialProviderId && fingerprint(oldConnection.customAdapter ?? null) === fingerprint(customAdapter ?? null);
      // An explicitly new key owns a connection so changing it cannot replace a sibling model's key.
      const connectionId = keepConnection ? oldConnection.id : `media-${endpointKey.slice(0, 24)}`;
      const capabilityId = old?.id ?? `cap-${randomUUID()}`;
      const meta = modelCapabilities(adapter, modelId, profile);
      const now = this.#now();
      const saved = await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(KuloCapabilitiesDoc);
        const receipt = own(state.commands, commandId);
        if (receipt) {
          if (receipt.fingerprint !== signature || !receipt.capability) fail(409, "capability_command_conflict", "同一操作标识不能用于不同配置。");
          return clone(receipt.capability);
        }
        const current = old ? requireCapability(state, old.id) : undefined;
        if (current) assertRevision(current, revision(raw.expectedRevision));
        else if (Object.keys(state.capabilities).length >= MAX_CAPABILITIES) fail(400, "capability_limit", "能力数量已达到上限。");
        if (!own(state.connections, connectionId)) {
          state.connections[connectionId] = clone({ id: connectionId, name, adapter, baseUrl, origin: baseUrl ? new URL(baseUrl).origin : undefined,
            browserEnvId, profileRef, credentialProviderId, customAdapter,
            credentialRef: adapter === "flow-browser" || credentialProviderId || customAdapter?.auth.type === "none" ? undefined :
              raw.credentialProviderId !== null && oldConnection?.origin === (baseUrl ? new URL(baseUrl).origin : undefined) && oldConnection?.customAdapter?.auth.type === customAdapter?.auth.type ? oldConnection?.credentialRef ?? `media:${connectionId}` : `media:${connectionId}`, revision: 1 });
        }
        const record: CapabilityRecord = {
          id: capabilityId, name, connectionId, modelId, ...meta,
          enabled: raw.enabled ?? current?.enabled ?? true,
          isDefault: raw.isDefault ?? current?.isDefault ?? false,
          allowTaskGeneration: raw.allowTaskGeneration ?? current?.allowTaskGeneration ?? (meta.kind === "image"),
          maxOutputs: raw.maxOutputs ?? current?.maxOutputs ?? 1,
          imageProfile: profile, defaults, routing,
          revision: (current?.revision ?? 0) + 1,
          status: "unverified", createdAt: current?.createdAt ?? now, updatedAt: now,
        };
        state.capabilities[capabilityId] = clone(record);
        this.#defaults(state, meta.kind, raw.isDefault === true ? capabilityId : undefined);
        if (current && current.kind !== meta.kind) this.#defaults(state, current.kind);
        for (const request of Object.values(state.inputs)) if (request.capabilityId === capabilityId && request.status === "pending") request.status = "cancelled";
        this.#retireUnused(state);
        state.revision++;
        const committed = clone(state.capabilities[capabilityId]!);
        state.commands[commandId] = { fingerprint: signature, capability: committed };
        return committed;
      }, BACKGROUND_CONTEXT);
      await this.#cleanup();
      return saved;
    });
    await this.#changed();
    const state = await this.#state();
    const current = own(state?.capabilities, result.id);
    return current ? this.#capabilityView(current, requireConnection(state, current.connectionId)) : result;
  }

  async setEnabled(id: string, enabled: boolean, expectedRevision: number, commandId: string): Promise<CapabilityRecord> {
    if (typeof enabled !== "boolean") fail(400, "invalid_capability", "能力开关必须是布尔值。");
    const capabilityId = identifier(id, "能力标识");
    const command = identifier(commandId, "操作标识");
    const expected = revision(expectedRevision);
    const signature = fingerprint({ action: "set-enabled", capabilityId, enabled, expected });
    const result = await this.#serial(() => this.#options.harness.commit(async (tx) => {
      const state = await tx.doc(KuloCapabilitiesDoc);
      const prior = own(state.commands, command);
      if (prior) {
        if (prior.fingerprint !== signature || !prior.capability) fail(409, "capability_command_conflict", "同一操作标识不能用于不同操作。");
        return clone(prior.capability);
      }
      const cap = requireCapability(state, capabilityId);
      assertRevision(cap, expected);
      cap.enabled = enabled;
      cap.revision++;
      cap.updatedAt = this.#now();
      this.#defaults(state, cap.kind);
      for (const request of Object.values(state.inputs)) if (request.capabilityId === capabilityId && request.status === "pending") request.status = "cancelled";
      const saved = clone(cap);
      state.commands[command] = { fingerprint: signature, capability: saved };
      state.revision++;
      return saved;
    }, BACKGROUND_CONTEXT));
    await this.#changed();
    const state = await this.#state();
    const current = own(state?.capabilities, result.id);
    return current ? this.#capabilityView(current, requireConnection(state, current.connectionId)) : result;
  }

  async restorePreferences(input: RestoreCapabilityPreferencesInput): Promise<CapabilityRecord> {
    const id = identifier(input.id, "能力标识");
    const commandId = identifier(input.commandId, "操作标识");
    const expectedRevision = revision(input.expectedRevision);
    if (!Number.isSafeInteger(input.expectedWorkspaceRevision) || input.expectedWorkspaceRevision < 0) fail(400, "capability_revision_required", "请先读取能力目录版本。");
    const values = input.values;
    if (!values || Object.keys(values).some((key) => !["name", "enabled", "allowTaskGeneration", "maxOutputs"].includes(key)) || typeof values.enabled !== "boolean" || typeof values.allowTaskGeneration !== "boolean" || !Number.isSafeInteger(values.maxOutputs) || values.maxOutputs < 1 || values.maxOutputs > 8) fail(400, "invalid_capability", "能力偏好恢复值无效。");
    const restored = { ...values, name: text(values.name, "能力名称", 100) };
    const signature = fingerprint({ action: "restore-preferences", ...input, values: restored });
    const result = await this.#serial(() => this.#options.harness.commit(async (tx) => {
      const state = await tx.doc(KuloCapabilitiesDoc);
      const prior = own(state.commands, commandId);
      if (prior) {
        if (prior.fingerprint !== signature || !prior.capability) fail(409, "capability_command_conflict", "同一操作标识不能用于不同操作。");
        return clone(prior.capability);
      }
      if (state.revision !== input.expectedWorkspaceRevision) fail(409, "capability_revision_conflict", "能力目录已发生变化，无法覆盖；请重新发起操作。");
      const current = requireCapability(state, id);
      assertRevision(current, expectedRevision);
      if (current.connectionId !== input.connectionId || current.modelId !== input.modelId) fail(409, "capability_revision_conflict", "能力连接或模型已变化，不能撤销这次偏好修改。");
      if (current.isDefault && !restored.enabled || restored.enabled && !current.isDefault && !Object.values(state.capabilities).some((cap) => cap.id !== id && cap.kind === current.kind && cap.enabled && cap.isDefault)) fail(409, "capability_default_changed", "此次撤销会改变默认能力关系，请重新发起操作。");
      Object.assign(current, restored);
      current.revision++;
      current.updatedAt = this.#now();
      for (const request of Object.values(state.inputs)) if (request.capabilityId === id && request.status === "pending") request.status = "cancelled";
      state.revision++;
      const saved = clone(current);
      state.commands[commandId] = { fingerprint: signature, capability: saved };
      return saved;
    }, BACKGROUND_CONTEXT));
    await this.#changed();
    const state = await this.#state();
    const current = own(state?.capabilities, result.id);
    return current ? this.#capabilityView(current, requireConnection(state, current.connectionId)) : result;
  }

  async remove(id: string, expectedRevision: number, commandId: string): Promise<CapabilitySnapshot> {
    await this.#serial(async () => {
      const capabilityId = identifier(id, "能力标识");
      const command = identifier(commandId, "操作标识");
      const expected = revision(expectedRevision);
      const signature = fingerprint({ action: "remove", capabilityId, expected });
      await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(KuloCapabilitiesDoc);
        const prior = own(state.commands, command);
        if (prior) {
          if (prior.fingerprint !== signature) fail(409, "capability_command_conflict", "同一操作标识不能用于不同操作。");
          return;
        }
        const cap = requireCapability(state, capabilityId);
        assertRevision(cap, expected);
        const kind = cap.kind;
        if (capabilityId.startsWith("cap-model-")) {
          state.dismissedModelCapabilities ??= {};
          state.dismissedModelCapabilities[capabilityId] = fingerprint({ connectionId: cap.connectionId, modelId: cap.modelId });
        }
        delete state.capabilities[capabilityId];
        if (state.imageRouting) state.imageRouting.rules = state.imageRouting.rules.filter((rule) => rule.capabilityId !== capabilityId);
        for (const request of Object.values(state.inputs)) if (request.capabilityId === capabilityId && request.status === "pending") request.status = "cancelled";
        this.#retireUnused(state);
        this.#defaults(state, kind);
        state.commands[command] = { fingerprint: signature };
        state.revision++;
      }, BACKGROUND_CONTEXT);
      await this.#cleanup();
    });
    await this.#changed();
    return this.snapshot();
  }

  async requestInput(id: string, kind: "secret" | "browser", clientId: string): Promise<SetupInputRequest> {
    const request = await this.#serial(async () => {
      const capabilityId = identifier(id, "能力标识");
      const client = identifier(clientId, "客户端标识");
      if (kind !== "secret" && kind !== "browser") fail(400, "invalid_capability_input", "不支持的配置输入。");
      const state = await this.#state();
      const cap = requireCapability(state, capabilityId);
      const connection = requireConnection(state, cap.connectionId);
      if ((connection.adapter === "flow-browser") !== (kind === "browser")) fail(400, "invalid_capability_input", "输入方式与此连接不匹配。");
      if (kind === "secret" && connection.credentialProviderId) fail(409, "capability_credential_source_conflict", "此能力正在复用模型连接的密钥。请先选择使用独立新密钥，再请求保密输入。");
      if (kind === "browser") this.#device(connection);
      const now = this.#now();
      return this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(KuloCapabilitiesDoc);
        const current = requireCapability(doc, capabilityId);
        assertRevision(current, cap.revision);
        for (const existing of Object.values(doc.inputs)) {
          if (existing.status === "pending" && existing.expiresAt <= now) existing.status = "expired";
          if (existing.clientId === client && existing.capabilityId === capabilityId && existing.kind === kind && existing.status === "pending" && existing.expectedRevision === cap.revision) return publicInput(existing);
        }
        const input: StoredInput = clone({ id: `input-${randomUUID()}`, kind, label: kind === "secret" ? "API Key" : "连接主 Chrome", clientId: client, capabilityId, expectedRevision: cap.revision, connectionId: connection.id, connectionRevision: connection.revision, origin: connection.origin, envId: connection.browserEnvId, status: "pending", createdAt: now, expiresAt: now + INPUT_LIFETIME_MS });
        doc.inputs[input.id] = input;
        doc.revision++;
        return publicInput(input);
      }, BACKGROUND_CONTEXT);
    });
    if (kind === "browser") {
      const state = await this.#state();
      const cap = requireCapability(state, request.capabilityId);
      const connection = requireConnection(state, cap.connectionId);
      try { await this.#options.browser(connection.browserEnvId!, { action: "open", profileRef: connection.profileRef! }); }
      catch { fail(502, "browser_open_failed", "未能打开目标设备的 Flow 浏览器，请检查设备后重试。"); }
    }
    await this.#changed();
    return request;
  }

  async listInputs(clientId?: string): Promise<SetupInputRequest[]> {
    if (!clientId) return [];
    const client = identifier(clientId, "客户端标识");
    const now = this.#now();
    return Object.values((await this.#state())?.inputs ?? {}).filter((item) => item.clientId === client).sort((a, b) => a.createdAt - b.createdAt).map((item) => publicInput({ ...item, status: item.status === "pending" && item.expiresAt <= now ? "expired" : item.status }));
  }

  async submitInput(inputId: string, clientId: string, values: { secret?: string; cancel?: boolean }): Promise<void> {
    await this.#serial(async () => {
      const id = identifier(inputId, "输入请求标识");
      const client = identifier(clientId, "客户端标识");
      if (!values || typeof values !== "object" || Object.keys(values).some((key) => key !== "secret" && key !== "cancel")) fail(400, "invalid_capability_input", "配置输入无效。");
      const state = await this.#state();
      const request = own(state?.inputs, id) ?? fail(404, "capability_input_not_found", "配置输入请求不存在。");
      if (request.clientId !== client) fail(403, "capability_input_forbidden", "该输入请求属于另一台浏览器。");
      if (request.status === "completed") return;
      if (request.status !== "pending" || request.expiresAt <= this.#now()) fail(409, "capability_input_expired", "配置输入已失效，请重新发起。");
      const cap = requireCapability(state, request.capabilityId);
      assertRevision(cap, request.expectedRevision);
      const connection = requireConnection(state, cap.connectionId);
      if (connection.id !== request.connectionId || connection.revision !== request.connectionRevision || connection.origin !== request.origin) fail(409, "capability_input_stale", "连接已修改，请重新发起保密输入。");
      if (values.cancel === true) {
        await this.#options.harness.commit(async (tx) => { const doc = await tx.doc(KuloCapabilitiesDoc); doc.inputs[id]!.status = "cancelled"; doc.revision++; }, BACKGROUND_CONTEXT);
        return;
      }
      if (values.cancel !== undefined && typeof values.cancel !== "boolean") fail(400, "invalid_capability_input", "配置输入无效。");
      if (request.kind === "secret") {
        if (typeof values.secret !== "string" || !values.secret.trim() || values.secret.length > 16_384 || /[\x00-\x20\x7f]/.test(values.secret.trim())) fail(400, "invalid_capability_secret", "请输入有效的 API Key。");
        const secret = values.secret.trim();
        if (!connection.credentialRef || !connection.origin) fail(400, "invalid_capability_input", "此连接不能保存 API Key。");
        try { await this.#options.credentials.modify(connection.credentialRef, async () => ({ type: "api_key", key: secret, env: { [ORIGIN_ENV]: connection.origin! } })); }
        catch { fail(500, "capability_credential_write_failed", "未能保存 API Key，请重新提交。"); }
        // Only the dedicated credential store receives the value; Durable keeps the input receipt.
        await this.#options.harness.commit(async (tx) => {
          const doc = await tx.doc(KuloCapabilitiesDoc);
          const current = requireCapability(doc, cap.id);
          assertRevision(current, request.expectedRevision);
          const currentConnection = requireConnection(doc, request.connectionId);
          if (currentConnection.revision !== request.connectionRevision || currentConnection.origin !== request.origin) fail(409, "capability_input_stale", "连接已修改，请重新发起保密输入。");
          currentConnection.revision++;
          for (const record of Object.values(doc.capabilities)) if (record.connectionId === connection.id) { record.status = "unverified"; delete record.error; record.revision++; record.updatedAt = this.#now(); }
          doc.inputs[id]!.status = "completed";
          for (const other of Object.values(doc.inputs)) if (other.id !== id && other.connectionId === connection.id && other.status === "pending") other.status = "cancelled";
          doc.revision++;
        }, BACKGROUND_CONTEXT);
      } else {
        if (values.secret !== undefined) fail(400, "invalid_capability_input", "浏览器登录不需要提交凭证文本。");
        const checked = await this.#checkInternal(cap.id, true);
        if (checked.status !== "ready") fail(409, "browser_login_pending", "Flow 标签页尚未连接，请在目标设备的主 Chrome 中授权后继续。");
        await this.#options.harness.commit(async (tx) => { const doc = await tx.doc(KuloCapabilitiesDoc); doc.inputs[id]!.status = "completed"; doc.revision++; }, BACKGROUND_CONTEXT);
      }
    });
    await this.#changed();
  }

  async #checkInternal(id: string, takeover = false): Promise<CapabilityRecord> {
    const state = await this.#state();
    const cap = requireCapability(state, identifier(id, "能力标识"));
    const connection = requireConnection(state, cap.connectionId);
    if (!cap.enabled) return this.#capabilityView(cap, connection);
    let status: CapabilityStatus = "unverified";
    let error: string | undefined;
    if (connection.adapter === "flow-browser") {
      try {
        this.#device(connection);
        const result = await this.#options.browser(connection.browserEnvId!, { action: "check", profileRef: connection.profileRef!, ...(takeover ? { takeover: true } : {}) });
        if (result.profileRef !== connection.profileRef) fail(502, "browser_profile_mismatch", "浏览器会话检查未返回匹配的会话。");
        status = result.status === "ready" ? "ready" : result.status === "needs_login" ? "needs_auth" : "unverified";
        if (status !== "ready") error = status === "needs_auth" ? "请在目标设备的主 Chrome 中连接 Flow 标签页。" : "Flow 会话需要检查。";
      } catch (cause) {
        status = cause instanceof CapabilityError && cause.code === "browser_device_offline" ? "offline" : cause instanceof CapabilityError && cause.code === "browser_dependency_missing" ? "missing_dependency" : "error";
        error = status === "offline" ? "浏览器所在设备离线。" : status === "missing_dependency" ? "该设备尚未提供 Flow 浏览器能力。" : "未能检查 Flow 浏览器连接。";
      }
    } else {
      const key = await this.#boundKey(connection);
      if (!key && connection.customAdapter?.auth.type !== "none") { status = "needs_auth"; error = "需要填写此服务的 API Key。"; }
      else if (connection.adapter === "custom-image") { status = "unverified"; error = "接口已配置，尚未验证生成。"; }
      else {
        try {
          const isGoogleHost = connection.baseUrl ? new URL(connection.baseUrl).hostname === "generativelanguage.googleapis.com" : true;
          const headers: Record<string, string> = connection.adapter === "gemini-image"
            ? { "x-goog-api-key": key!, ...(!isGoogleHost ? { Authorization: `Bearer ${key}` } : {}) }
            : { Authorization: `Bearer ${key}` };
          const response = await (this.#options.fetch ?? globalThis.fetch)(`${connection.baseUrl}/models/${encodeURIComponent(cap.modelId)}`, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
          if (response.ok) {
            if (await metadataMatches(response, connection.adapter, cap.modelId)) status = "ready";
            else { status = "unverified"; error = "连接已响应，尚未核对模型，可通过实际生成验证。"; }
          }
          else if (response.status === 401 || response.status === 403) { status = "needs_auth"; error = "服务未接受当前凭证或模型权限。"; }
          else if (response.status === 404 || response.status === 405) { status = "unverified"; error = "服务未提供该模型的连接检查，可通过实际生成验证。"; }
          else { status = "error"; error = "服务连接检查失败，请检查地址和模型后重试。"; }
          await response.body?.cancel();
        } catch { status = "error"; error = "无法连接此服务，请检查地址或网络后重试。"; }
      }
    }
    await this.#options.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloCapabilitiesDoc);
      const current = requireCapability(doc, cap.id);
      assertRevision(current, cap.revision);
      current.status = status;
      if (error) current.error = error; else delete current.error;
      current.lastCheckedAt = this.#now();
      current.updatedAt = this.#now();
      doc.revision++;
    }, BACKGROUND_CONTEXT);
    const current = await this.#state();
    return this.#capabilityView(requireCapability(current, cap.id), requireConnection(current, cap.connectionId));
  }
  async check(id: string, _clientId?: string): Promise<CapabilityRecord> {
    const result = await this.#serial(() => this.#checkInternal(id));
    await this.#changed();
    return result;
  }

  async routingSettings(): Promise<{ settings: ImageRoutingSettings; revision: number }> {
    const state = await this.#state();
    return { settings: clone(state?.imageRouting ?? defaultRouting()), revision: state?.revision ?? 0 };
  }
  async configureRouting(input: ImageRoutingConfigurationInput): Promise<{ settings: ImageRoutingSettings; revision: number }> {
    const commandId = identifier(input?.commandId, "操作标识");
    const settings = input?.settings;
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !settings || typeof settings !== "object" || Array.isArray(settings)
      || Object.keys(settings).some((key) => !["mode", "preference", "instructions", "rules"].includes(key))
      || !["auto", "default"].includes(settings.mode) || !["balanced", "speed", "quality", "cost"].includes(settings.preference)
      || typeof settings.instructions !== "string" || settings.instructions.length > 4000 || !Array.isArray(settings.rules) || settings.rules.length > 40) fail(400, "invalid_image_routing", "图像调用规则无效。");
    const signature = fingerprint({ action: "image-routing", ...input });
    const result = await this.#serial(() => this.#options.harness.commit(async (tx) => {
      const state = await tx.doc(KuloCapabilitiesDoc);
      const receipt = own(state.commands, commandId);
      if (receipt) {
        if (receipt.fingerprint !== signature || !receipt.routing) fail(409, "capability_command_conflict", "同一操作标识不能用于不同配置。");
        return { settings: clone(receipt.routing), revision: state.revision };
      }
      if (state.revision !== input.expectedRevision) fail(409, "capability_revision_conflict", "图像配置已更新，请重新读取后修改规则。");
      const ids = new Set<string>();
      for (const rule of settings.rules) {
        if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.keys(rule).some((key) => !["id", "name", "capabilityId", "enabled", "intents", "keywords", "formats", "preference"].includes(key)) || typeof rule.enabled !== "boolean") fail(400, "invalid_image_routing", "调用规则字段无效。");
        identifier(rule.id, "规则标识"); text(rule.name, "规则名称", 100);
        if (ids.has(rule.id)) fail(400, "invalid_image_routing", "调用规则标识重复。");
        ids.add(rule.id);
        if (requireCapability(state, rule.capabilityId).kind !== "image") fail(400, "invalid_image_routing", "调用规则需要图像模型。");
        if (rule.intents !== undefined && (!Array.isArray(rule.intents) || rule.intents.length > 4 || rule.intents.some((intent) => !["generate", "edit", "animate", "vector"].includes(intent)))
          || rule.formats !== undefined && (!Array.isArray(rule.formats) || rule.formats.length > 5 || rule.formats.some((format) => !["png", "jpeg", "webp", "gif", "svg"].includes(format)))
          || rule.keywords !== undefined && (!Array.isArray(rule.keywords) || rule.keywords.length > 20 || rule.keywords.some((keyword) => typeof keyword !== "string" || !keyword.trim() || keyword.length > 100))
          || rule.preference !== undefined && !["balanced", "speed", "quality", "cost"].includes(rule.preference)) fail(400, "invalid_image_routing", "调用规则条件无效。");
      }
      state.imageRouting = clone(settings);
      state.revision++;
      state.commands[commandId] = { fingerprint: signature, routing: clone(settings) };
      return { settings: clone(settings), revision: state.revision };
    }, BACKGROUND_CONTEXT));
    await this.#changed();
    return result;
  }
  async markGenerated(id: string, expectedRevision: number): Promise<void> {
    await this.#serial(() => this.#options.harness.commit(async (tx) => {
      const state = await tx.doc(KuloCapabilitiesDoc);
      const cap = own(state.capabilities, id);
      if (!cap || cap.revision !== expectedRevision) return;
      cap.lastGeneratedAt = this.#now();
      cap.status = "ready";
      delete cap.error;
      state.revision++;
    }, BACKGROUND_CONTEXT));
    await this.#changed();
  }

  async resolve(id: string | undefined, kind: MediaKind, format?: MediaOutputFormat, request?: Partial<MediaJobRequest>): Promise<{ capability: CapabilityRecord; connection: MediaConnectionView; selectionReason?: string }> {
    if (kind !== "image" && kind !== "video") fail(400, "invalid_media_kind", "生成类型无效。");
    let snapshot = await this.snapshot();
    const desiredFormat = format ?? request?.parameters?.format ?? (request?.intent === "animate" ? "gif" : request?.intent === "vector" ? "svg" : undefined);
    const intent = request?.intent ?? (request?.inputAssetIds?.length ? "edit" : desiredFormat === "gif" ? "animate" : desiredFormat === "svg" ? "vector" : "generate");
    const acceptsParameters = (cap: CapabilityRecord): boolean => {
      if (!request || kind !== "image") return true;
      const connection = snapshot.connections.find((item) => item.id === cap.connectionId);
      const profile = cap.imageProfile ?? (connection ? getImageModelProfile(connection.adapter, cap.modelId) : undefined);
      if (!connection || !profile) return false;
      const values = { ...request.parameters, ...(desiredFormat ? { format: desiredFormat } : {}), ...(request.count !== undefined ? { count: request.count } : {}),
        ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}), ...(request.quality !== undefined ? { quality: request.quality } : {}) };
      if (connection.adapter === "gemini-image" && values.quality && ["0.5K", "1K", "2K", "4K"].includes(values.quality)) { values.size = values.quality; delete values.quality; }
      try { normalizeImageGenerationParameters(mergeImageGenerationParameters(cap.defaults, values), profile, connection.adapter); return true; } catch { return false; }
    };
    const available = snapshot.capabilities.filter((cap) => cap.kind === kind && cap.enabled && (!desiredFormat || cap.formats.includes(desiredFormat))
      && (!request || request.source?.setupClientId || cap.allowTaskGeneration) && (kind !== "image" || ["ready", "unverified"].includes(cap.status))
      && (!(request?.inputAssetIds?.length || intent === "edit") || cap.supportsEdit)
      && (!request?.inputAssetIds?.length || request.inputAssetIds.length <= (cap.imageProfile?.maxReferences ?? 16))
      && (request?.count ?? request?.parameters?.count ?? 1) <= cap.maxOutputs
      && (!request?.parameters?.background || request.parameters.background !== "transparent" || cap.imageProfile?.supportsTransparency) && acceptsParameters(cap));
    const routing = snapshot.imageRouting ?? defaultRouting();
    const preference = request?.preference ?? routing.preference;
    const prompt = request?.prompt?.toLocaleLowerCase() ?? "";
    const rule = !id && kind === "image" && routing.mode === "auto" ? routing.rules.find((item) => item.enabled && available.some((cap) => cap.id === item.capabilityId)
      && (!item.intents?.length || item.intents.includes(intent)) && (!item.formats?.length || !!desiredFormat && item.formats.includes(desiredFormat))
      && (!item.preference || item.preference === preference) && (!item.keywords?.length || item.keywords.some((keyword) => prompt.includes(keyword.toLocaleLowerCase())))) : undefined;
    const score = (cap: CapabilityRecord): number => {
      const profile = cap.imageProfile;
      const choice = preference === "speed" ? profile?.speed : preference === "quality" ? profile?.quality : preference === "cost" ? profile?.cost : undefined;
      return (cap.routing?.priority ?? 0) + (cap.isDefault ? preference === "balanced" ? 30 : 1 : 0) + (choice ?? 0) * 10
        + (cap.routing?.useCases?.some((word) => prompt.includes(word.toLocaleLowerCase())) ? 40 : 0);
    };
    const chosen = id ? snapshot.capabilities.find((cap) => cap.id === id) : rule ? available.find((cap) => cap.id === rule.capabilityId)
      : kind === "image" && routing.mode === "auto" ? [...available].sort((a, b) => score(b) - score(a) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
      : available.find((cap) => cap.isDefault) ?? available[0];
    if (!chosen) fail(404, "media_capability_missing", "尚未配置支持此请求的生成能力。");
    if (chosen.kind !== kind || desiredFormat && !chosen.formats.includes(desiredFormat)) fail(400, "unsupported_media_format", "所选能力不支持此生成类型或输出格式。");
    if (!chosen.enabled) fail(409, "media_capability_disabled", "此生成能力已停用。");
    if (snapshot.connections.find((conn) => conn.id === chosen.connectionId)?.adapter === "flow-browser") {
      await this.check(chosen.id);
      snapshot = await this.snapshot();
    }
    const cap = snapshot.capabilities.find((item) => item.id === chosen.id) ?? fail(404, "capability_not_found", "能力不存在或已移除。");
    const connection = snapshot.connections.find((item) => item.id === cap.connectionId) ?? fail(404, "connection_not_found", "能力连接不存在或已移除。");
    if (connection.adapter === "flow-browser" && cap.status !== "ready") fail(409, `media_capability_${cap.status}`, cap.error ?? "Flow 会话尚未就绪，请先完成连接验证。");
    if (cap.status !== "ready" && cap.status !== "unverified") fail(409, `media_capability_${cap.status}`, cap.error ?? "此生成能力暂不可用，请先修复连接。");
    return { capability: clone(cap), connection: clone(connection), selectionReason: id ? "用户指定模型" : rule ? `匹配规则：${rule.name}` : routing.mode === "default" ? "使用默认模型" : preference === "balanced" ? "按任务能力与默认偏好选择" : `按${preference === "speed" ? "速度" : preference === "quality" ? "质量" : "成本"}偏好选择` };
  }
  async apiKey(connectionId: string, expectedOrigin?: string): Promise<string> {
    const connection = requireConnection(await this.#state(), identifier(connectionId, "连接标识"));
    if (connection.adapter === "flow-browser") fail(400, "browser_has_no_api_key", "会员浏览器连接不使用 API Key。");
    if (expectedOrigin !== undefined && connection.origin !== expectedOrigin) fail(409, "media_connection_changed", "服务地址已变化，请重新核对生成请求。");
    if (connection.customAdapter?.auth.type === "none") return "";
    return await this.#boundKey(connection) ?? fail(409, "media_credential_missing", "此服务需要重新填写 API Key。");
  }
  async connection(id: string): Promise<MediaConnectionView> {
    return this.#connectionView(requireConnection(await this.#state(), identifier(id, "连接标识")));
  }

  async syncProviderImageModels(providers: readonly SyncedProviderImageSource[]): Promise<void> {
    let changed = false;
    await this.#serial(async () => {
      const desired = new Map<string, {
        capabilityId: string;
        connectionId: string;
        providerId: string;
        providerName: string;
        capabilityName: string;
        adapter: "openai-image" | "gemini-image" | "custom-image";
        baseUrl: string;
        modelId: string;
        profile: ImageModelProfile;
        defaults: NonNullable<CapabilityRecord["defaults"]>;
        customAdapter?: NonNullable<StoredConnection["customAdapter"]>;
        syncSignature: string;
      }>();

      for (const p of providers) {
        if (!p.id?.trim() || !p.baseUrl?.trim()) continue;
        for (const m of p.models ?? []) {
          if (inferModelPurpose(m) !== "image") continue;
          const inferredAdapter = m.protocolAdapter === "custom-image" && m.customImageAdapter
            ? "custom-image" as const
            : m.protocolAdapter === "gemini-image"
              ? "gemini-image" as const
              : m.protocolAdapter === "openai-image"
                ? "openai-image" as const
                : defaultProtocolAdapterForModel("image", m.id, p.api, p.preset) === "gemini-image"
                  ? "gemini-image" as const
                  : "openai-image" as const;
          const cleanId = inferredAdapter === "gemini-image" ? m.id.trim().replace(/^models\//, "") : m.id.trim();
          if (!cleanId || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(cleanId)) continue;
          if (inferredAdapter === "openai-image" && /^dall-e-/i.test(cleanId)) continue;
          let baseUrl: string;
          try { baseUrl = normalizedUrl(p.baseUrl, inferredAdapter); } catch { continue; }
          const preset = getImageModelPreset(inferredAdapter, cleanId);
          let profile: ImageModelProfile;
          try {
            if (preset) {
              const userFormats = m.imageProfile?.formats?.filter((f) => preset.profile.formats.includes(f));
              profile = validateImageModelProfile({
                ...preset.profile,
                ...(userFormats?.length ? { formats: userFormats } : {}),
                ...(m.imageProfile?.supportsEdit !== undefined ? {
                  supportsEdit: m.imageProfile.supportsEdit && preset.profile.supportsEdit,
                  maxReferences: m.imageProfile.supportsEdit && preset.profile.supportsEdit ? preset.profile.maxReferences : 0,
                } : {}),
              });
            } else {
              profile = validateImageModelProfile(m.imageProfile ?? {
                formats: inferredAdapter === "gemini-image" ? ["jpeg", "png"] : ["png", "jpeg", "webp"],
                supportsEdit: true,
                maxReferences: 4,
              });
            }
          } catch { continue; }
          let defaults: NonNullable<CapabilityRecord["defaults"]>;
          try {
            defaults = normalizeImageGenerationParameters(
              m.imageDefaults ?? preset?.defaults ?? { format: profile.formats[0] ?? "png", count: 1 },
              profile,
              inferredAdapter,
            );
          } catch {
            defaults = { format: profile.formats[0] ?? "png", count: 1 };
          }
          const customAdapter = inferredAdapter === "custom-image"
            ? (() => { try { return validateCustomImageAdapter(m.customImageAdapter!); } catch { return undefined; } })()
            : undefined;
          if (inferredAdapter === "custom-image" && (!customAdapter || profile.supportsEdit && !customAdapter.edit)) continue;
          const capabilityId = `cap-model-${fingerprint({ providerId: p.id, modelId: cleanId }).slice(0, 20)}`;
          const connectionId = `media-model-${fingerprint({ providerId: p.id, adapter: inferredAdapter, baseUrl, customAdapter: customAdapter ?? null }).slice(0, 20)}`;
          const capabilityName = (m.name?.trim() || cleanId).slice(0, 100);
          const syncSignature = fingerprint({ connectionId, modelId: cleanId, capabilityName, profile, defaults });
          desired.set(capabilityId, {
            capabilityId, connectionId, providerId: p.id, providerName: (p.name?.trim() || p.id).slice(0, 100),
            capabilityName, adapter: inferredAdapter, baseUrl, modelId: cleanId, profile, defaults, customAdapter, syncSignature,
          });
        }
      }

      await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(KuloCapabilitiesDoc);
        const now = this.#now();

        for (const existing of Object.values(state.capabilities)) {
          if (!existing.id.startsWith("cap-model-") || desired.has(existing.id)) continue;
          delete state.capabilities[existing.id];
          if (state.dismissedModelCapabilities) delete state.dismissedModelCapabilities[existing.id];
          if (state.imageRouting) state.imageRouting.rules = state.imageRouting.rules.filter((rule) => rule.capabilityId !== existing.id);
          for (const req of Object.values(state.inputs)) if (req.capabilityId === existing.id && req.status === "pending") req.status = "cancelled";
          changed = true;
        }

        for (const item of desired.values()) {
          const dismissedSig = own(state.dismissedModelCapabilities, item.capabilityId);
          const connectionSig = fingerprint({ connectionId: item.connectionId, modelId: item.modelId });
          if (dismissedSig === connectionSig) continue;
          if (dismissedSig && state.dismissedModelCapabilities) delete state.dismissedModelCapabilities[item.capabilityId];

          const existingConn = own(state.connections, item.connectionId);
          const nextOrigin = new URL(item.baseUrl).origin;
          if (!existingConn || existingConn.name !== item.providerName || existingConn.baseUrl !== item.baseUrl || existingConn.origin !== nextOrigin) {
            state.connections[item.connectionId] = clone({
              id: item.connectionId, name: item.providerName, adapter: item.adapter, baseUrl: item.baseUrl, origin: nextOrigin,
              credentialProviderId: item.providerId, ...(item.customAdapter ? { customAdapter: item.customAdapter } : {}),
              revision: (existingConn?.revision ?? 0) + 1,
            });
            changed = true;
          }

          const current = own(state.capabilities, item.capabilityId);
          if (!current && Object.keys(state.capabilities).length >= MAX_CAPABILITIES) continue;
          const prevSig = current ? fingerprint({
            connectionId: current.connectionId, modelId: current.modelId, capabilityName: current.name,
            profile: current.imageProfile, defaults: current.defaults,
          }) : undefined;
          if (!current || prevSig !== item.syncSignature) {
            state.capabilities[item.capabilityId] = clone({
              id: item.capabilityId,
              name: item.capabilityName,
              connectionId: item.connectionId,
              modelId: item.modelId,
              kind: "image",
              formats: [...item.profile.formats],
              supportsEdit: item.profile.supportsEdit,
              enabled: current?.enabled ?? true,
              isDefault: current?.isDefault ?? false,
              allowTaskGeneration: current?.allowTaskGeneration ?? true,
              maxOutputs: current?.maxOutputs ?? 1,
              imageProfile: item.profile,
              defaults: item.defaults,
              ...(current?.routing ? { routing: current.routing } : {}),
              ...(current?.lastGeneratedAt && current.connectionId === item.connectionId ? { lastGeneratedAt: current.lastGeneratedAt } : {}),
              revision: (current?.revision ?? 0) + 1,
              status: current && current.connectionId === item.connectionId ? current.status : "unverified",
              createdAt: current?.createdAt ?? now,
              updatedAt: now,
            });
            changed = true;
          }
        }

        if (changed) {
          this.#defaults(state, "image");
          this.#retireUnused(state);
          state.revision++;
        }
      }, BACKGROUND_CONTEXT);
      if (changed) await this.#cleanup();
    });
    if (changed) await this.#changed();
  }
}
