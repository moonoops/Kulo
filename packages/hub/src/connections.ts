import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  inspectSensitiveText, redactDeviceInvitationText, redactSensitiveText, SENSITIVE_TEXT_REDACTION,
  type ConnectionAccessRequest, type ConnectionApplicationView, type ConnectionDescribeRequest, type ConnectionFields, type ConnectionKind, type ConnectionPrepareRequest,
  type ConnectionRecordView, type ConnectionSaveRequest, type ConnectionSecrets, type ConnectionSetupInput,
  type ConnectionTestResult, type ConnectionUseOperation, type ConnectionUseResult, type ConnectionWorkspaceSnapshot,
} from "@kulo/protocol";
import { LocalConnectionVault } from "./connection-vault.js";
import { LocalConnectionExecutor, type ConnectionExecutionBackend, type ConnectionHostScan } from "./connection-execution.js";
import { classifySshExecutionFailure, classifySshScanFailure } from "./connection-ssh-diagnostics.js";
import {
  MAX_CREDENTIAL_FIELDS, SECRET_FIELDS, allowedSecretKeyFor, credentialKey, credentialSchema,
  fieldLabel, identifier, informationRequest, normalizedSecrets, requiresCustomSecretFallback, textField,
} from "./connection-validation.js";
import { binding, completesIdentity, normalizeFields, usable } from "./connection-fields.js";
import { CONNECTION_APPLICATIONS, getConnectionApplication, LocalConnectionApplications, type ConnectionApplicationBackend } from "./connection-applications.js";
import { closeMcpHttpAgents } from "./mcp-fetch.js";
import { McpConnectionPool, type McpDiscoverySnapshot, type McpTransportFactoryContext } from "./mcp-connections.js";
import { McpOAuthRefreshLockManager, McpOAuthSessionManager, extractMcpOAuthSecrets, mcpOAuthVaultRef, parseMcpOAuthVaultEntry } from "./mcp-oauth.js";
import { MCP_PRESET_CATALOG, getMcpPreset, isLoopbackHost } from "./mcp-presets.js";
import { COMPOSIO_PRESET_ID, createComposioSession } from "./composio-bridge.js";
import type { McpTransport } from "@earendil-works/pi-mcp";

export type { ConnectionTestResult };
export interface ResolvedDeviceSshCredential {
  connection: ConnectionRecordView;
  secrets: ConnectionSecrets;
  knownHostsPath: string;
  revision: number;
}
export type DeviceSshConnectionEvent = {
  type: "identity-changed" | "credentials-rotated" | "host-mismatch" | "verified";
  connectionId: string;
};
export interface ConnectionVault {
  get(ref: string): Promise<Record<string, string> | undefined>;
  set(ref: string, fields: Record<string, string>): Promise<void>;
  delete(ref: string): Promise<void>;
  entries(): Promise<Array<{ ref: string; fields: Record<string, string> }>>;
  refs?(): Promise<string[]>;
  ready(): Promise<{ available: boolean; error?: string }>;
}
interface StoredConnection extends ConnectionRecordView {
  credentialRef?: string;
  trustedHostFingerprint?: string;
  /** Physical cluster nodeId where a local stdio/loopback MCP connection was configured (P1-4). */
  boundNodeId?: string;
}
interface ConnectionDocument {
  version: 1;
  connections: Record<string, StoredConnection>;
  inputs: Record<string, ConnectionSetupInput>;
  imports: Record<string, string[]>;
  requests: Record<string, ConnectionAccessRequest>;
}
export interface ConnectionTextReceipt { text: string; connectionIds: string[]; saved: boolean }
const MAX_RECORDS = 256;
const MAX_INPUT_AGE = 30 * 60_000;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fail(message: string, code = "invalid_connection", status = 400): never { throw Object.assign(new Error(message), { code, status }); }

/** Public records contain descriptions and opaque references; only the vault contains authentication material. */
export class KuloConnections {
  readonly #stateDir: string;
  readonly #file: string;
  readonly #vault: ConnectionVault;
  readonly #executor: ConnectionExecutionBackend;
  readonly #applications: ConnectionApplicationBackend;
  readonly #platform: NodeJS.Platform;
  readonly #onChanged?: () => void | Promise<void>;
  #onPersist?: () => void;
  #sshInUseGuard?: (connectionId: string) => void;
  #onSshChanged?: (event: DeviceSshConnectionEvent) => void;
  #clusterHostContext?: { localNodeId: string; legacyLocalNodeId?: string };
  readonly #mcpLocks: McpOAuthRefreshLockManager;
  readonly #mcpBaseFetch?: typeof fetch;
  readonly #mcpPool: McpConnectionPool;
  readonly mcpOAuth: McpOAuthSessionManager;
  #doc: ConnectionDocument;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #known = new Set<string>();
  readonly #grants = new Map<string, { runEpoch: number; ids: Set<string>; revisions: Map<string, number> }>();
  readonly #requests = new Map<string, ConnectionAccessRequest>();
  readonly #scans = new Map<string, { revision: number; value: ConnectionHostScan; at: number }>();
  readonly #active = new Map<AbortController, { ticketId: string; connectionId: string }>();
  readonly #updating = new Set<string>();
  readonly #readableInformation = new Set<string>();
  readonly #mcpOAuthAuthorized = new Set<string>();
  readonly #applicationProbes = new Map<string, { revision: number; at: number; connected: boolean; error?: string }>();
  #vaultState: { available: boolean; error?: string } = { available: true };
  #initialized = false;
  #closed = false;
  constructor(options: {
    stateDir: string;
    vault?: ConnectionVault;
    executor?: ConnectionExecutionBackend;
    applications?: ConnectionApplicationBackend;
    platform?: NodeJS.Platform;
    onChanged?: () => void | Promise<void>;
    mcpBaseFetch?: typeof fetch;
    mcpTransportFactory?: (ctx: McpTransportFactoryContext) => McpTransport | Promise<McpTransport>;
    mcpIdleMs?: number;
  }) {
    this.#stateDir = options.stateDir;
    this.#file = path.join(options.stateDir, "connections.json");
    this.#vault = options.vault ?? new LocalConnectionVault({ stateDir: options.stateDir });
    this.#platform = options.platform ?? process.platform;
    this.#applications = options.applications ?? new LocalConnectionApplications({ stateDir: options.stateDir, platform: this.#platform });
    this.#executor = options.executor ?? new LocalConnectionExecutor({ stateDir: options.stateDir, applications: this.#applications, platform: this.#platform });
    this.#onChanged = options.onChanged;
    this.#mcpLocks = new McpOAuthRefreshLockManager(options.stateDir);
    this.#mcpBaseFetch = options.mcpBaseFetch;
    this.#doc = { version: 1, connections: {}, inputs: {}, imports: {}, requests: {} };
    if (fs.existsSync(this.#file)) {
      if (fs.lstatSync(this.#file).isSymbolicLink() || !fs.statSync(this.#file).isFile()) fail("连接记录路径无效。", "connection_storage_corrupt", 500);
      let parsed: ConnectionDocument;
      try { parsed = JSON.parse(fs.readFileSync(this.#file, "utf8")) as ConnectionDocument; }
      catch { fail("连接记录损坏，请恢复有效的本地记录。", "connection_storage_corrupt", 500); }
      if (parsed.version !== 1 || !parsed.connections || !parsed.inputs || !parsed.imports || Object.keys(parsed.connections).length > MAX_RECORDS) fail("连接记录格式无效。", "connection_storage_corrupt", 500);
      for (const [id, record] of Object.entries(parsed.connections)) {
        if (identifier(id) !== record.id || !Number.isSafeInteger(record.revision) || record.revision < 1 || !Array.isArray(record.secretFields) || record.secretFields.length > MAX_CREDENTIAL_FIELDS ||
          new Set(record.secretFields).size !== record.secretFields.length ||
          record.secretFields.some((key) => !allowedSecretKeyFor(record.kind, key, record.mcpTransport, record.mcpAuthMode))) fail("连接记录格式无效。", "connection_storage_corrupt", 500);
        normalizeFields(record, this.#stateDir);
      }
      this.#doc = { ...parsed, requests: parsed.requests ?? {} };
      for (const request of Object.values(this.#doc.requests)) this.#requests.set(request.id, request);
    }
    this.#mcpPool = new McpConnectionPool({
      vault: this.#vault,
      locks: this.#mcpLocks,
      getBinding: (id) => {
        const record = this.#doc.connections[id];
        return record ? binding(record) : undefined;
      },
      redact: (text) => this.redact(text),
      onSecrets: (values) => this.rememberSecrets(values),
      onAuthorizedChange: (id, authorized) => {
        if (authorized) this.#mcpOAuthAuthorized.add(id);
        else this.#mcpOAuthAuthorized.delete(id);
      },
      onDiscoveryUpdated: (id, expectedRevision, discovery) => this.#updateMcpDiscoveryCache(id, expectedRevision, discovery),
      onComposioSessionExpired: (id, expectedBinding, signal, failedSessionId) => this.refreshComposioSession(id, expectedBinding, signal, failedSessionId),
      ...(options.mcpIdleMs !== undefined ? { idleMs: options.mcpIdleMs } : {}),
      ...(options.mcpBaseFetch ? { baseFetch: options.mcpBaseFetch } : {}),
      ...(options.mcpTransportFactory ? { transportFactory: options.mcpTransportFactory } : {}),
    });
    this.mcpOAuth = new McpOAuthSessionManager({
      getRecord: (id) => {
        const record = this.#doc.connections[id];
        return record ? this.#view(record) : undefined;
      },
      getBinding: (id) => {
        const record = this.#doc.connections[id];
        return record ? binding(record) : undefined;
      },
      getClientSecret: async (id) => {
        const record = this.#doc.connections[id];
        if (!record?.credentialRef) return undefined;
        const fields = await this.#vault.get(record.credentialRef);
        if (!fields || fields.__binding !== binding(record)) return undefined;
        return fields.clientSecret || undefined;
      },
      getChallenge: (id) => this.#mcpPool.getChallenge(id),
      clearChallenge: (id) => this.#mcpPool.clearChallenge(id),
      vault: this.#vault,
      locks: this.#mcpLocks,
      onSecrets: (values) => this.rememberSecrets(values),
      onAuthorizedChange: (id, authorized) => {
        if (authorized) this.#mcpOAuthAuthorized.add(id);
        else this.#mcpOAuthAuthorized.delete(id);
      },
      onCompletedProbe: async (id, expectedRevision, signal) => {
        await this.#mcpPool.invalidate(id);
        const current = this.#doc.connections[id];
        if (!current || current.revision !== expectedRevision) return undefined;
        const secrets = current.credentialRef ? await this.#secrets(current) : {};
        const discovery = await this.#mcpPool.test(this.#view(current), secrets, binding(current), signal);
        return this.#markMcpVerified(id, expectedRevision, discovery);
      },
      redact: (text) => this.redact(text),
      ...(options.mcpBaseFetch ? { baseFetch: options.mcpBaseFetch } : {}),
    });
  }
  getConnectionRecord(id: string): ConnectionRecordView | undefined {
    const record = this.#doc.connections[id];
    return record ? this.#view(record) : undefined;
  }
  getPendingInput(id: string): ConnectionSetupInput | undefined {
    const input = this.#doc.inputs[id];
    return input ? clone(input) : undefined;
  }
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(work, work);
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }
  #persist(next: ConnectionDocument): void {
    if (fs.existsSync(this.#file) && fs.lstatSync(this.#file).isSymbolicLink()) fail("连接记录路径无效。", "connection_storage_corrupt", 500);
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.#file);
      this.#doc = next;
      this.#onPersist?.();
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  setOnPersist(hook: (() => void) | undefined): void { this.#onPersist = hook; }
  setSshInUseGuard(guard: ((connectionId: string) => void) | undefined): void { this.#sshInUseGuard = guard; }
  setOnSshChangedHook(hook: ((event: DeviceSshConnectionEvent) => void) | undefined): void { this.#onSshChanged = hook; }
  setClusterHostContext(ctx: { localNodeId: string; legacyLocalNodeId?: string } | undefined): void {
    this.#clusterHostContext = ctx;
  }
  #assertNotPausedLocalMcp(record: StoredConnection): void {
    if (record.kind !== "mcp") return;
    const isLocalBound = record.mcpTransport === "stdio" || (record.url ? (() => {
      try { return isLoopbackHost(new URL(record.url).hostname); } catch { return false; }
    })() : false);
    if (!isLocalBound) return;
    const ctx = this.#clusterHostContext;
    if (!ctx || ctx.localNodeId === "local") return;
    const ownerNodeId = record.boundNodeId ?? ctx.legacyLocalNodeId;
    if (ownerNodeId && ownerNodeId !== ctx.localNodeId) {
      fail("该本地 MCP 服务绑定在原主机，当前运行于备用主机故已自动暂停。", "connection_host_changed_paused", 409);
    }
  }
  async #changed(): Promise<void> { await this.#onChanged?.(); }
  #view(record: StoredConnection): ConnectionRecordView {
    const fields = normalizeFields(record, this.#stateDir);
    return clone({ ...fields, id: record.id, revision: record.revision, status: record.status, hasCredential: record.hasCredential,
      secretFields: record.secretFields, createdAt: record.createdAt, updatedAt: record.updatedAt,
      ...(record.error ? { error: this.redact(record.error) } : {}), ...(record.hostFingerprint ? { hostFingerprint: record.hostFingerprint } : {}),
      ...(record.source ? { source: record.source } : {}),
      ...(record.kind === "custom" && record.category === "information" ? { canReadInformation: this.#readableInformation.has(record.id) } : {}),
      ...(record.kind === "mcp" ? {
        ...(record.mcpTools ? { mcpTools: record.mcpTools } : {}),
        ...(record.mcpToolsUpdatedAt !== undefined ? { mcpToolsUpdatedAt: record.mcpToolsUpdatedAt } : {}),
        ...(record.mcpServerName ? { mcpServerName: record.mcpServerName } : {}),
        ...(record.mcpTransport === "http" && (record.mcpAuthMode ?? "oauth") === "oauth" ? { mcpOAuthAuthorized: this.#mcpOAuthAuthorized.has(record.id) } : {}),
      } : {}) });
  }
  #record(id: string): StoredConnection {
    const record = this.#doc.connections[identifier(id)];
    if (!record) fail("此连接已取消或不存在。", "connection_not_found", 404);
    return record;
  }
  #assertOpen(): void { if (this.#closed) fail("连接服务已关闭。", "connection_manager_closed", 503); }
  #remember(fields: Record<string, string>): void {
    this.rememberSecrets(Object.entries(fields).flatMap(([key, value]) => !key.startsWith("__") && value ? [value] : []));
  }
  #rememberActualSecrets(fields: Record<string, string>): void {
    for (const [key, value] of Object.entries(fields)) if (!key.startsWith("__")) this.rememberSecrets(inspectSensitiveText(value).secrets.map((secret) => secret.value));
  }
  #rememberStoredEntry(ref: string, fields: Record<string, string>): void {
    if (ref.startsWith("connection:")) {
      const record = Object.values(this.#doc.connections).find((item) => item.credentialRef === ref);
      if (record?.kind === "custom" && record.category === "information" && fields.__informationReadable === "1") { this.#readableInformation.add(record.id); this.#rememberActualSecrets(fields); }
      else this.#remember(fields);
      return;
    }
    if (ref.startsWith("mcp-oauth:")) {
      const connectionId = ref.slice("mcp-oauth:".length);
      const record = this.#doc.connections[connectionId];
      const parsed = parseMcpOAuthVaultEntry(fields);
      if (parsed) {
        this.rememberSecrets(extractMcpOAuthSecrets(parsed));
        if (record && record.kind === "mcp" && fields.__binding === binding(record) && parsed.tokens?.access_token) {
          this.#mcpOAuthAuthorized.add(connectionId);
        }
      }
      return;
    }
    if (ref.startsWith("durable-secret:")) { if (fields.value) this.rememberSecrets([fields.value]); return; }
    // These owners decode their envelopes and report actual keys/tokens through onSecrets.
    if (ref.startsWith("provider:") || ref.startsWith("legacy-provider-backup:")) return;
    const secretField = /^(?:password|passwd|passphrase|private[_-]?key|api[_-]?key|key|token|secret|access|refresh|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)$/i;
    this.rememberSecrets(Object.entries(fields).flatMap(([key, value]) => value && secretField.test(key) ? [value] : []));
  }
  get localVault(): LocalConnectionVault | undefined { return this.#vault instanceof LocalConnectionVault ? this.#vault : undefined; }
  get mcpBaseFetch(): typeof fetch | undefined { return this.#mcpBaseFetch; }
  get redactionRevision(): number { return this.#known.size; }
  rememberSecrets(values: readonly string[]): void {
    for (const value of values) {
      if (typeof value !== "string" || !value) continue;
      this.#known.add(value);
      if (value.length >= 4) {
        this.#known.add(Buffer.from(value, "utf8").toString("base64"));
        this.#known.add(Buffer.from(value, "utf8").toString("base64url"));
      }
    }
  }
  containsKnownSecret(text: string): boolean {
    for (const value of this.#known) if (value.length >= 4 ? text.includes(value) : text === value) return true;
    return false;
  }
  #metadataHasSecret(text: string): boolean {
    const inspection = inspectSensitiveText(text);
    const known = [...this.#known].filter((value) => value.length >= 4 || text === value);
    return inspection.secrets.length > 0 || redactSensitiveText(text, known) !== text;
  }
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#vaultState = await this.#vault.ready();
    if (Object.values(this.#doc.connections).some((record) => record.hasCredential || record.kind === "mcp") || this.#vault.refs && (await this.#vault.refs()).length > 0) {
      if (!this.#vaultState.available) fail(this.#vaultState.error ?? "本地凭据库无法解锁。", "connection_vault_unavailable", 503);
      try { for (const { ref, fields } of await this.#vault.entries()) this.#rememberStoredEntry(ref, fields); }
      catch { fail("本地凭据库无法解锁，请检查系统密钥库。", "connection_vault_unavailable", 503); }
    }
    this.#initialized = true;
  }
  redact(text: string): string {
    const safe = redactDeviceInvitationText(text, (values) => this.rememberSecrets(values));
    return redactSensitiveText(safe, [...this.#known], { definiteOnly: true });
  }
  async snapshot(clientId?: string): Promise<ConnectionWorkspaceSnapshot> {
    const vault = await this.#vault.ready();
    const applications = await Promise.all(CONNECTION_APPLICATIONS.map(async (definition): Promise<ConnectionApplicationView> => {
      const record = Object.values(this.#doc.connections).find((item) => item.kind === "app" && item.appId === definition.id);
      if (definition.authentication === "macos" && this.#platform !== "darwin") return { ...clone(definition), status: "unavailable", ...(record ? { connectionId: record.id } : {}), error: "此应用需要在 Mac 上连接。" };
      if (!record) return { ...clone(definition), status: "disconnected" };
      if (record.status !== "verified") return { ...clone(definition), status: "needs_attention", connectionId: record.id, error: record.error ?? "请重新连接以完成授权。" };
      let probe = this.#applicationProbes.get(record.id);
      if (!probe || probe.revision !== record.revision || Date.now() - probe.at > 30_000) {
        const controller = new AbortController();
        this.#active.set(controller, { ticketId: `application-probe:${record.id}`, connectionId: record.id });
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
        try {
          const secrets = await this.#secrets(record);
          signal.throwIfAborted();
          await this.#applications.probe(definition.id, secrets, signal, { requestPermission: false });
          signal.throwIfAborted();
          probe = { revision: record.revision, at: Date.now(), connected: true };
        } catch {
          probe = { revision: record.revision, at: Date.now(), connected: false, error: "应用暂不可用，请检查连接或授权。" };
        } finally { this.#active.delete(controller); }
        if (this.#doc.connections[record.id]?.revision === record.revision) this.#applicationProbes.set(record.id, probe);
      }
      if (!this.#doc.connections[record.id]) return { ...clone(definition), status: "disconnected" };
      if (this.#doc.connections[record.id]?.revision !== record.revision) return { ...clone(definition), status: "needs_attention", error: "连接已更新，请刷新后重试。" };
      return { ...clone(definition), status: probe.connected ? "connected" : "needs_attention", connectionId: record.id, ...(probe.error ? { error: probe.error } : {}) };
    }));
    return { connections: Object.values(this.#doc.connections).map((record) => {
        const view = this.#view(record), application = record.kind === "app" ? applications.find((app) => app.connectionId === record.id) : undefined;
        return application?.status === "needs_attention" || application?.status === "unavailable" ? { ...view, status: "error" as const, error: application.error } : view;
      }).sort((a, b) => b.updatedAt - a.updatedAt),
      inputs: clientId ? Object.values(this.#doc.inputs).filter((input) => input.clientId === clientId && Date.now() - input.createdAt < MAX_INPUT_AGE).map(clone) : [],
      requests: [...this.#requests.values()].map(clone), vault, applications, mcpPresets: clone([...MCP_PRESET_CATALOG]) };
  }
  async #updateMcpDiscoveryCache(id: string, expectedRevision: number, discovery: McpDiscoverySnapshot): Promise<void> {
    await this.#serialize(async () => {
      if (this.#closed) return;
      const current = this.#doc.connections[id];
      if (!current || current.kind !== "mcp" || current.revision !== expectedRevision) return;
      const updated: StoredConnection = {
        ...current,
        ...(discovery.serverName ? { mcpServerName: discovery.serverName } : {}),
        mcpTools: discovery.tools,
        mcpToolsUpdatedAt: discovery.updatedAt,
      };
      this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
    });
  }
  async #markMcpVerified(id: string, expectedRevision: number, discovery: McpDiscoverySnapshot): Promise<ConnectionRecordView | undefined> {
    return this.#serialize(async () => {
      if (this.#closed) return undefined;
      const current = this.#doc.connections[id];
      if (!current || current.kind !== "mcp" || current.revision !== expectedRevision) return undefined;
      const updated: StoredConnection = {
        ...current,
        status: "verified",
        error: undefined,
        ...(discovery.serverName ? { mcpServerName: discovery.serverName } : {}),
        mcpTools: discovery.tools,
        mcpToolsUpdatedAt: discovery.updatedAt,
        updatedAt: Date.now(),
      };
      this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
      await this.#changed();
      return this.#view(updated);
    });
  }
  async #markMcpError(id: string, expectedRevision: number, message: string): Promise<ConnectionRecordView | undefined> {
    return this.#serialize(async () => {
      if (this.#closed) return undefined;
      const current = this.#doc.connections[id];
      if (!current || current.kind !== "mcp" || current.revision !== expectedRevision) return undefined;
      const updated: StoredConnection = {
        ...current,
        status: "error",
        error: this.redact(message).slice(0, 500),
        updatedAt: Date.now(),
      };
      this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
      await this.#changed();
      return this.#view(updated);
    });
  }
  async save(request: ConnectionSaveRequest, source: "form" | "chat" = "form"): Promise<ConnectionRecordView> {
    return this.#serialize(async () => { const view = await this.#save(request, source); await this.#changed(); return view; });
  }
  async saveComposioSession(request: ConnectionSaveRequest): Promise<ConnectionRecordView> {
    return this.#serialize(async () => { const view = await this.#save(request, "form", { allowComposioDirect: true }); await this.#changed(); return view; });
  }
  async getComposioContext(id: string): Promise<{ record: ConnectionRecordView; apiKey: string; binding: string }> {
    this.#assertOpen();
    const record = this.#record(id);
    if (record.kind !== "mcp" || record.mcpPresetId !== COMPOSIO_PRESET_ID) fail("此连接不是 Composio 应用连接。", "connection_composio_not_composio", 400);
    const secrets = await this.#secrets(record);
    if (!secrets.apiKey) fail("Composio API Key 尚未保存。", "connection_credential_missing", 409);
    return { record: this.#view(record), apiKey: secrets.apiKey, binding: binding(record) };
  }
  async refreshComposioSession(id: string, expectedBinding: string, signal?: AbortSignal, failedSessionId?: string): Promise<ConnectionRecordView | undefined> {
    return this.#mcpLocks.withLock(id, async () => {
      if (this.#closed) return undefined;
      const current = this.#doc.connections[id];
      if (!current || current.kind !== "mcp" || current.mcpPresetId !== COMPOSIO_PRESET_ID || binding(current) !== expectedBinding || !current.mcpComposioUserId) return undefined;
      if (failedSessionId && current.mcpComposioSessionId && current.mcpComposioSessionId !== failedSessionId) return this.#view(current);
      const secrets = await this.#secrets(current);
      if (!secrets.apiKey) return undefined;
      const created = await createComposioSession(secrets.apiKey, { userId: current.mcpComposioUserId, allowedToolkits: current.mcpAllowedToolkits, baseFetch: this.#mcpBaseFetch, redact: (t) => this.redact(t), signal });
      return this.#serialize(async () => {
        if (this.#closed) return undefined;
        const latest = this.#doc.connections[id];
        if (!latest || latest.kind !== "mcp" || latest.mcpPresetId !== COMPOSIO_PRESET_ID || binding(latest) !== expectedBinding) return undefined;
        const updated: StoredConnection = { ...latest, url: created.mcpUrl, mcpComposioSessionId: created.sessionId, updatedAt: Date.now() };
        this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
        return this.#view(updated);
      });
    });
  }
  async #save(request: ConnectionSaveRequest, source: "form" | "chat", options: { requestPermission?: boolean; signal?: AbortSignal; trustedInformation?: boolean; humanInformation?: boolean; inputId?: string; allowComposioDirect?: boolean } = {}): Promise<ConnectionRecordView> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    const previous = request.id ? this.#record(request.id) : undefined;
    if (previous && request.expectedRevision !== previous.revision) fail("连接已被修改，请刷新后重试。", "connection_conflict", 409);
    if (previous && (previous.kind === "app" || request.kind === "app") && (previous.kind !== request.kind || previous.appId !== request.appId)) fail("应用连接不能更换应用，请使用对应应用入口。", "connection_application_identity_changed", 409);
    const draft = { ...request };
    if (request.kind === "mcp") {
      if (draft.category === undefined) draft.category = "app";
      if (draft.mcpTransport === undefined && previous?.kind === "mcp") draft.mcpTransport = previous.mcpTransport;
      if (draft.mcpAuthMode === undefined && previous?.kind === "mcp" && draft.mcpTransport === "http") draft.mcpAuthMode = previous.mcpAuthMode;
      const prevComposio = previous?.kind === "mcp" && previous.mcpPresetId === COMPOSIO_PRESET_ID;
      if (draft.mcpPresetId === undefined && previous?.kind === "mcp" && draft.mcpTransport === "http" && (draft.url === previous.url || prevComposio)) draft.mcpPresetId = previous.mcpPresetId;
      if (prevComposio) {
        if (draft.mcpComposioUserId === undefined) draft.mcpComposioUserId = previous.mcpComposioUserId;
        if (draft.mcpComposioSessionId === undefined) draft.mcpComposioSessionId = previous.mcpComposioSessionId;
        if (!options.allowComposioDirect && draft.mcpAllowedToolkits === undefined && previous.mcpAllowedToolkits) draft.mcpAllowedToolkits = previous.mcpAllowedToolkits;
      }
      if (!options.allowComposioDirect && (draft.mcpPresetId === COMPOSIO_PRESET_ID || prevComposio)) {
        const mutatesComposio = !previous || Boolean(request.secrets?.apiKey) || draft.url !== previous.url || draft.mcpComposioUserId !== previous.mcpComposioUserId || draft.mcpComposioSessionId !== previous.mcpComposioSessionId || JSON.stringify(draft.mcpAllowedToolkits ?? []) !== JSON.stringify(previous.mcpAllowedToolkits ?? []);
        if (mutatesComposio) fail("请通过 Composio 专用配置弹窗创建或修改 Composio 连接。", "connection_composio_route_required", 400);
      }
      if (draft.credentialFields === undefined && previous?.kind === "mcp" && draft.mcpTransport === "stdio") draft.credentialFields = previous.credentialFields;
    }
    const effectiveMcpTransport = request.kind === "mcp" ? (draft.mcpTransport ?? (draft.mcpCommand ? "stdio" : "http")) : undefined;
    const effectiveMcpAuthMode = request.kind === "mcp" && effectiveMcpTransport === "http" ? (draft.mcpAuthMode ?? (draft.mcpPresetId ? getMcpPreset(draft.mcpPresetId).authMode : "oauth")) : undefined;
    const supplied = normalizedSecrets(request.secrets, request.kind, effectiveMcpTransport, effectiveMcpAuthMode);
    const oldBinding = previous ? binding(previous) : undefined;
    const stored = previous?.credentialRef ? await this.#vault.get(previous.credentialRef) : undefined;
    if (stored && stored.__binding !== oldBinding) fail("凭据与连接地址不匹配，请重新填写。", "connection_credential_mismatch", 409);
    const priorReadable = previous?.kind === "custom" && previous.category === "information" && stored?.__informationReadable === "1";
    const valueChanged = Object.entries(supplied).some(([key, value]) => (value || undefined) !== (stored?.[key] || undefined));
    if (stored) { if (priorReadable) this.#rememberActualSecrets(stored); else this.#remember(stored); }
    if (request.kind === "custom") {
      if (draft.category === undefined) draft.category = previous?.category ?? "credential";
      if (draft.typeLabel === undefined) draft.typeLabel = previous?.typeLabel;
      if (draft.instructions === undefined) draft.instructions = previous?.instructions;
      if (draft.credentialFields === undefined) {
        const schema = credentialSchema(previous?.credentialFields) ?? (previous?.secretFields ?? []).map((key) => ({ key, label: fieldLabel(key) }));
        const seen = new Set(schema.map((field) => field.key));
        draft.credentialFields = [...schema, ...Object.keys(supplied).filter((key) => !seen.has(key)).map((key) => ({ key, label: fieldLabel(key) }))];
      }
    } else if (request.kind !== "mcp" && draft.credentialFields === undefined && previous?.credentialFields) draft.credentialFields = previous.credentialFields;
    const fields = normalizeFields(draft, this.#stateDir);
    if (previous?.kind === "ssh" && fields.kind !== "ssh") this.#sshInUseGuard?.(previous.id);
    if (fields.kind === "app") {
      const app = getConnectionApplication(fields.appId);
      if (app.authentication === "macos" && this.#platform !== "darwin") fail("此应用需要在 Mac 上连接。", "connection_application_unavailable", 503);
      if (Object.keys(supplied).some((key) => app.authentication !== "token" || key !== "apiKey")) fail("此应用不支持该凭据字段。");
      if (Object.values(this.#doc.connections).some((item) => item.kind === "app" && item.appId === fields.appId && item.id !== previous?.id)) fail("此应用已有连接，请编辑现有连接。", "connection_application_exists", 409);
    }
    const schemaKeys = new Set(fields.credentialFields?.map((field) => field.key));
    if ((fields.kind === "custom" || fields.kind === "mcp") && Object.keys(supplied).some((key) => !schemaKeys.has(key))) fail("凭据字段与卡片定义不匹配。");
    if (!previous && Object.keys(this.#doc.connections).length >= MAX_RECORDS) fail("连接数量已达到上限。");
    const id = previous?.id ?? `connection-${randomUUID()}`;
    const newBinding = binding(fields);
    const sameIdentity = oldBinding === newBinding;
    let secrets: Record<string, string> = {};
    if (previous?.credentialRef && (sameIdentity || previous.status === "incomplete" && completesIdentity(previous, fields))) {
      secrets = Object.fromEntries(Object.entries(stored ?? {}).filter(([key, value]) => credentialKey(key) && value && (fields.kind === "custom" || fields.kind === "mcp" ? schemaKeys.has(key) : SECRET_FIELDS.some((field) => field === key))));
    }
    for (const [key, value] of Object.entries(supplied)) { if (value) secrets[key] = value; else delete secrets[key]; }
    if (fields.kind === "ssh") {
      if (supplied.password && !supplied.privateKey) { delete secrets.privateKey; delete secrets.passphrase; }
      else if (supplied.privateKey && !supplied.password) delete secrets.password;
    }
    const priorKeys = new Set(previous?.credentialFields?.map((field) => field.key) ?? previous?.secretFields ?? []);
    const sameKeys = schemaKeys.size === priorKeys.size && [...schemaKeys].every((key) => priorKeys.has(key));
    const infoCategory = fields.kind === "custom" && fields.category === "information";
    const allReplaced = previous?.secretFields.every((key) => Object.hasOwn(supplied, key) && Boolean(supplied[key])) ?? true;
    const namedCredential = /密码|口令|私钥|密钥|令牌|凭据|账号|帐号|验证码|Cookie|Token|API[ _-]?Key|Client[ _-]?Secret|Password|Passphrase|Secret|Access[ _-]?Key/iu;
    const safeInformationFields = ![fields.name, fields.typeLabel ?? "", ...(fields.credentialFields?.map((field) => field.label) ?? [])].some((label) => namedCredential.test(label)) &&
      Object.values(secrets).every((value) => !this.#metadataHasSecret(value));
    const trustedInformation = infoCategory && (options.trustedInformation === true || options.humanInformation === true && (priorReadable || !previous || allReplaced) && safeInformationFields);
    if (options.trustedInformation && !safeInformationFields) fail("信息中包含凭据，请通过登录凭据保存。", "connection_information_sensitive", 409);
    if (!trustedInformation && !(priorReadable && !valueChanged)) this.#remember(supplied);
    const informationReadable = fields.kind === "custom" && fields.category === "information" && (trustedInformation || priorReadable && !valueChanged && sameKeys);
    if (!informationReadable) this.#remember(secrets);
    // Public card descriptions may not become a second copy of an encrypted value.
    const metadataHasSecret = (value: string) => this.#metadataHasSecret(value) || informationReadable && redactSensitiveText(value, Object.values(secrets).filter((secret) => secret.length >= 4 || secret === value)) !== value;
    for (const key of ["name", "username", "host", "url", "headerName", "typeLabel", "instructions", "mcpCommand", "mcpCwd", "mcpOAuthClientId", "mcpOAuthScope", "mcpComposioUserId", "mcpComposioSessionId"] as const) if (fields[key] && metadataHasSecret(fields[key]!)) fail("连接资料中包含凭据，请把秘密值放入专用输入框。");
    for (const arg of [...(fields.mcpArgs ?? []), ...(fields.mcpAllowedToolkits ?? [])]) if (arg && metadataHasSecret(arg)) fail("MCP 参数中包含凭据，请通过专用凭据字段安全录入。");
    for (const field of fields.credentialFields ?? []) if (metadataHasSecret(field.key) || metadataHasSecret(field.label)) fail("字段名称中包含凭据，请使用普通名称。");
    const secretFields = fields.kind === "custom" || fields.kind === "mcp" ? [...schemaKeys].filter((key) => Boolean(secrets[key])) : SECRET_FIELDS.filter((key) => Boolean(secrets[key]));
    if (fields.kind === "ssh" && previous?.kind === "ssh" && previous.hasCredential && !sameIdentity && secretFields.length === 0) {
      fail("修改 SSH 服务器地址、端口或用户名时，请重新输入密码或私钥。", "connection_ssh_secret_required_on_target_change");
    }
    if (fields.kind === "app") {
      const app = getConnectionApplication(fields.appId);
      if (app.authentication === "token" && !secrets.apiKey) fail("请填写应用访问令牌。", "connection_credential_missing", 409);
      const result = await this.#applications.probe(app.id, secrets, options.signal ?? AbortSignal.timeout(30_000), { requestPermission: options.requestPermission === true });
      this.#assertOpen(); options.signal?.throwIfAborted();
      if (result.username !== undefined) {
        const username = textField(result.username, "应用账号", 256);
        if (username && this.#metadataHasSecret(username)) fail("应用账号信息无效。", "connection_application_identity_invalid", 409);
        fields.username = username;
      }
    }
    const ref = `connection:${id}`;
    const oauthRef = mcpOAuthVaultRef(id);
    const dropMcpOAuth = Boolean(previous?.kind === "mcp" && (!sameIdentity || fields.kind !== "mcp" || fields.mcpTransport !== "http" || fields.mcpAuthMode !== "oauth"));
    let previousOAuth: Record<string, string> | undefined;
    options.signal?.throwIfAborted();
    this.#updating.add(id);
    let vaultChanged = false, oauthVaultChanged = false, committed = false;
    try {
      if (previous) this.#revokeConnection(id, options.inputId ? `connection-input:${options.inputId}` : undefined);
      if (previous?.kind === "mcp") {
        await this.mcpOAuth.cancelForConnection(id);
        await this.#mcpPool.invalidate(id);
      }
      if (dropMcpOAuth) {
        await this.#mcpLocks.withLock(id, async () => {
          previousOAuth = await this.#vault.get(oauthRef);
          if (previousOAuth) {
            await this.#vault.delete(oauthRef);
            oauthVaultChanged = true;
          }
          this.#mcpOAuthAuthorized.delete(id);
        });
      }
      if (secretFields.length) { vaultChanged = Boolean(previous?.credentialRef); await this.#vault.set(ref, { ...secrets, __binding: newBinding, ...(informationReadable ? { __informationReadable: "1" } : {}) }); vaultChanged = true; }
      else if (previous?.credentialRef) { vaultChanged = true; await this.#vault.delete(previous.credentialRef); }
      this.#assertOpen(); options.signal?.throwIfAborted();
      const now = Date.now();
      const keepMcpMeta = fields.kind === "mcp" && sameIdentity && previous?.kind === "mcp";
      const keepSshVerified = fields.kind === "ssh" && sameIdentity && !valueChanged && previous?.status === "verified" && Boolean(previous.trustedHostFingerprint);
      const oauthAuthorized = fields.kind === "mcp" && sameIdentity && this.#mcpOAuthAuthorized.has(id);
      const isLocalBoundMcp = fields.kind === "mcp" && (fields.mcpTransport === "stdio" || (fields.url ? (() => {
        try { return isLoopbackHost(new URL(fields.url).hostname); } catch { return false; }
      })() : false));
      const boundNodeId = isLocalBoundMcp
        ? (this.#clusterHostContext && this.#clusterHostContext.localNodeId !== "local"
            ? this.#clusterHostContext.localNodeId
            : previous?.boundNodeId)
        : undefined;
      const record: StoredConnection = { ...fields, id, revision: (previous?.revision ?? 0) + 1,
        status: fields.kind === "app" ? "verified" : usable(fields, secrets, oauthAuthorized) ? ((keepMcpMeta || keepSshVerified) && previous?.status === "verified" ? "verified" : "saved") : "incomplete",
        hasCredential: secretFields.length > 0, secretFields,
        createdAt: previous?.createdAt ?? now, updatedAt: now, source: previous?.source ?? source,
        ...(boundNodeId ? { boundNodeId } : {}),
        ...(secretFields.length ? { credentialRef: ref } : {}),
        ...(keepMcpMeta && previous.mcpTools ? { mcpTools: previous.mcpTools } : {}),
        ...(keepMcpMeta && previous.mcpToolsUpdatedAt !== undefined ? { mcpToolsUpdatedAt: previous.mcpToolsUpdatedAt } : {}),
        ...(keepMcpMeta && previous.mcpServerName ? { mcpServerName: previous.mcpServerName } : {}),
        ...(sameIdentity && previous?.trustedHostFingerprint ? { trustedHostFingerprint: previous.trustedHostFingerprint, hostFingerprint: previous.hostFingerprint } : {}) };
      this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: record } });
      committed = true;
      if (previous?.kind === "ssh" && !sameIdentity) this.#executor.clearTrustedHost?.(this.#view(previous));
      if (previous?.kind === "ssh" && (fields.kind !== "ssh" || !sameIdentity || !record.hasCredential)) {
        this.#onSshChanged?.({ type: "identity-changed", connectionId: id });
      } else if (fields.kind === "ssh" && previous?.kind === "ssh" && sameIdentity && valueChanged) {
        this.#onSshChanged?.({ type: "credentials-rotated", connectionId: id });
      }
      if (informationReadable) this.#readableInformation.add(id); else this.#readableInformation.delete(id);
      if (fields.kind === "app") this.#applicationProbes.set(id, { revision: record.revision, at: Date.now(), connected: true });
      this.#scans.delete(id);
      return this.#view(record);
    } catch (error) {
      if ((vaultChanged || oauthVaultChanged) && !committed) {
        try {
          if (vaultChanged) {
            if (previous?.credentialRef && stored) await this.#vault.set(previous.credentialRef, stored); else await this.#vault.delete(ref);
          }
          if (oauthVaultChanged && previousOAuth) {
            await this.#vault.set(oauthRef, previousOAuth);
            const restored = parseMcpOAuthVaultEntry(previousOAuth);
            if (restored?.tokens?.access_token) this.#mcpOAuthAuthorized.add(id);
          }
        } catch { this.close(); fail("未能安全更新凭据，连接服务已停止，请检查本地存储。", "connection_storage_failed", 503); }
      }
      throw error;
    } finally { this.#updating.delete(id); }
  }
  async describe(request: ConnectionDescribeRequest): Promise<ConnectionRecordView> {
    return this.#serialize(async () => {
      if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key) => !["id", "expectedRevision", "category", "name", "typeLabel", "instructions", "credentialFields"].includes(key))) fail("连接描述只能修改分类、名称、类型说明和已有字段标签。");
      const previous = this.#record(request.id);
      if (request.expectedRevision !== previous.revision) fail("连接已被修改，请刷新后重试。", "connection_conflict", 409);
      if (previous.kind === "app") fail("预置应用请通过对应应用入口管理。", "connection_application_identity_changed", 409);
      if (previous.kind === "mcp") {
        if (request.category !== undefined && request.category !== "app") fail("MCP 连接不能修改分类。");
        if (request.credentialFields !== undefined && previous.mcpTransport === "http") fail("远程 MCP 连接不能修改凭据字段定义。");
      } else if (request.category !== undefined && (request.category !== "credential" && request.category !== "information" || request.category === "information" && previous.kind !== "custom")) fail("此连接类型不支持该分类。");
      const schema = request.credentialFields !== undefined ? credentialSchema(request.credentialFields)! : undefined;
      const existingSchema = previous.credentialFields ?? previous.secretFields.map((key) => ({ key, label: fieldLabel(key) }));
      const existingKeys = new Set(existingSchema.map((field) => field.key));
      if (schema && (schema.length !== existingKeys.size || schema.some((field) => !existingKeys.has(field.key)))) fail("整理卡片时不能增加、删除或更换凭据字段。");
      const saved = await this.#save({ ...this.#view(previous), id: previous.id, expectedRevision: previous.revision,
        ...(request.category !== undefined ? { category: request.category } : {}),
        ...(request.name !== undefined ? { name: request.name } : {}), ...(request.typeLabel !== undefined ? { typeLabel: request.typeLabel } : {}),
        ...(request.instructions !== undefined ? { instructions: request.instructions } : {}), ...(schema ? { credentialFields: schema } : {}) }, previous.source ?? "form");
      await this.#changed();
      return saved;
    });
  }
  async remove(id: string): Promise<void> {
    if (this.#doc.connections[id]?.kind === "ssh") this.#sshInUseGuard?.(id);
    await this.mcpOAuth.cancelForConnection(id);
    await this.#mcpPool.invalidate(id);
    await this.#serialize(async () => {
      const record = this.#record(id);
      if (record.kind === "ssh") this.#sshInUseGuard?.(id);
      this.#revokeConnection(id);
      if (record.kind === "mcp") {
        await this.#mcpLocks.withLock(id, async () => {
          await this.#vault.delete(mcpOAuthVaultRef(id));
          this.#mcpOAuthAuthorized.delete(id);
        });
      }
      if (record.credentialRef) await this.#vault.delete(record.credentialRef);
      const next = clone(this.#doc);
      delete next.connections[id];
      for (const [key, input] of Object.entries(next.inputs)) if (input.connectionId === id) delete next.inputs[key];
      for (const key of Object.keys(next.imports)) next.imports[key] = next.imports[key]!.filter((value) => value !== id);
      this.#persist(next);
      if (record.kind === "ssh") this.#executor.clearTrustedHost?.(this.#view(record));
      this.#scans.delete(id);
      await this.#changed();
    });
  }
  async prepare(request: ConnectionPrepareRequest): Promise<ConnectionSetupInput> {
    return this.#serialize(async () => {
      if (!request || typeof request !== "object") fail("连接输入请求无效。");
      const clientId = textField(request.clientId, "窗口标识", 160);
      if (!clientId || /\s/.test(clientId)) fail("窗口标识无效。");
      const existing = request.connectionId ? this.#record(request.connectionId) : undefined;
      const appId = request.appId ?? existing?.appId;
      if (appId && (request.kind !== undefined && request.kind !== "app" || request.category !== undefined && request.category !== "app" || existing && existing.appId !== appId)) fail("请使用对应的预置应用入口。");
      const target = existing ?? (appId ? Object.values(this.#doc.connections).find((record) => record.kind === "app" && record.appId === appId) : undefined);
      const app = appId ? getConnectionApplication(appId) : undefined;
      const preset = !app && (request.kind === "mcp" || target?.kind === "mcp" || request.mcpPresetId) && (request.mcpPresetId ?? target?.mcpPresetId)
        ? getMcpPreset(request.mcpPresetId ?? target?.mcpPresetId) : undefined;
      if (preset?.id === COMPOSIO_PRESET_ID || target?.mcpPresetId === COMPOSIO_PRESET_ID) fail("Composio 连接请通过左侧「添加应用 → Composio」或该行的「编辑 / 管理应用」配置。", "connection_composio_route_required", 400);
      const kind: ConnectionKind = app ? "app" : preset ? "mcp" : request.kind ?? target?.kind ?? "ssh";
      const merged: ConnectionFields = {
        ...target,
        ...request,
        name: app?.name ?? request.name ?? target?.name ?? preset?.name ?? "新连接",
        kind,
        ...(app ? { appId: app.id, category: "app" } : {}),
        ...(kind === "mcp" ? {
          category: "app",
          mcpTransport: request.mcpTransport ?? target?.mcpTransport ?? preset?.transport ?? "http",
          ...(preset && !(request.url ?? target?.url) ? { url: preset.url } : {}),
          ...(preset && !(request.mcpAuthMode ?? target?.mcpAuthMode) ? { mcpAuthMode: preset.authMode } : {}),
          ...(preset?.headerName && !(request.headerName ?? target?.headerName) ? { headerName: preset.headerName } : {}),
        } : {}),
      };
      const fields = normalizeFields(merged, this.#stateDir);
      for (const key of ["name", "username", "host", "url", "headerName", "typeLabel", "instructions", "mcpCommand", "mcpCwd", "mcpOAuthClientId", "mcpOAuthScope"] as const) if (fields[key] && this.#metadataHasSecret(fields[key]!)) fail("请通过保密输入框填写凭据。");
      for (const arg of fields.mcpArgs ?? []) if (arg && this.#metadataHasSecret(arg)) fail("启动参数不能包含凭据。");
      for (const field of fields.credentialFields ?? []) if (this.#metadataHasSecret(field.key) || this.#metadataHasSecret(field.label)) fail("字段名称中包含凭据，请使用普通名称。");
      const input: ConnectionSetupInput = { ...fields, id: `connection-input-${randomUUID()}`, clientId,
        ...(target ? { connectionId: target.id, expectedRevision: target.revision } : {}), status: "pending", createdAt: Date.now() };
      const inputs = Object.fromEntries(Object.entries(this.#doc.inputs).filter(([, value]) => Date.now() - value.createdAt < MAX_INPUT_AGE && value.clientId !== clientId));
      if (Object.keys(inputs).length >= MAX_RECORDS) fail("待填写的连接数量已达到上限。");
      inputs[input.id] = input;
      this.#persist({ ...this.#doc, inputs });
      await this.#changed();
      return clone(input);
    });
  }
  async submitInput(id: string, clientId: string, request: ConnectionSaveRequest): Promise<ConnectionRecordView> {
    return this.#serialize(async () => {
      const input = this.#doc.inputs[id];
      if (!input || Date.now() - input.createdAt >= MAX_INPUT_AGE) fail("连接输入已过期，请重新添加。", "connection_input_expired", 409);
      if (input.clientId !== clientId) fail("请在原窗口完成连接输入。", "connection_input_forbidden", 403);
      if (input.status !== "pending") {
        if (input.status === "completed" && input.connectionId) return this.#view(this.#record(input.connectionId));
        fail("此连接输入已取消。", "connection_input_cancelled", 409);
      }
      if (request.id !== undefined && request.id !== input.connectionId) fail("连接输入目标不匹配。");
      if (input.kind === "app" && (request.kind !== "app" || request.appId !== input.appId || request.category !== undefined && request.category !== "app") || input.kind !== "app" && request.kind === "app") fail("应用授权目标不匹配。");
      const controller = new AbortController();
      this.#active.set(controller, { ticketId: `connection-input:${id}`, connectionId: input.connectionId ?? `pending:${id}` });
      let saved: ConnectionRecordView;
      const category = request.category ?? input.category;
      try { saved = await this.#save({ ...request, ...(category ? { category } : {}), id: input.connectionId, expectedRevision: input.expectedRevision }, "form", { requestPermission: input.kind === "app", humanInformation: request.kind === "custom" && category === "information", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]), inputId: id }); }
      finally { this.#active.delete(controller); }
      const next = clone(this.#doc);
      next.inputs[id] = { ...input, connectionId: saved.id, status: "completed" };
      this.#persist(next);
      await this.#changed();
      return saved;
    });
  }
  async cancelInput(id: string, clientId: string): Promise<void> {
    const pending = this.#doc.inputs[id];
    if (pending?.clientId === clientId && pending.status === "pending") for (const [controller, active] of this.#active) if (active.ticketId === `connection-input:${id}`) controller.abort();
    return this.#serialize(async () => {
      const input = this.#doc.inputs[id];
      if (!input) fail("连接输入不存在。", "connection_input_not_found", 404);
      if (input.clientId !== clientId) fail("请在原窗口取消连接输入。", "connection_input_forbidden", 403);
      if (input.status === "completed") fail("此连接已保存，请从卡片取消授权。", "connection_input_completed", 409);
      this.#persist({ ...this.#doc, inputs: { ...this.#doc.inputs, [id]: { ...input, status: "cancelled" } } });
      await this.#changed();
    });
  }
  async processText(text: string, options: { requestId?: string; replyText?: string } = {}): Promise<ConnectionTextReceipt> {
    if (typeof text !== "string" || text.length > 1_000_000) fail("消息内容无效。");
    // Pairing credentials belong to the local join action, including when a user quotes one in a save request.
    text = redactDeviceInvitationText(text, (values) => this.rememberSecrets(values));
    if (options.replyText) {
      redactDeviceInvitationText(options.replyText, (values) => {
        this.rememberSecrets(values);
        for (const value of values) text = text.replaceAll(value, SENSITIVE_TEXT_REDACTION);
      });
    }
    const inspection = inspectSensitiveText(text);
    const note = informationRequest(text);
    const information = note && !this.#metadataHasSecret(note.value) ? note : undefined;
    const explicitDecline = /(?:不要|别|无需|不必|不需要|不想|不能)(?:.{0,8})(?:保存|记住|存|记录)|\b(?:do\s+not|don't|never|without)\s+(?:save|store|remember)\b/iu.test(text);
    if (!inspection.saveRequested && !note && !explicitDecline) {
      const definite = inspectSensitiveText(text, { definiteOnly: true });
      this.rememberSecrets(definite.secrets.map((secret) => secret.value));
      return { text: this.redact(definite.text), connectionIds: [], saved: false };
    }
    if (!information) {
      this.rememberSecrets(inspection.secrets.map((secret) => secret.value));
      this.rememberSecrets((inspection.customCredential?.fields ?? []).map((field) => field.value));
    }
    const safeText = this.redact(inspection.text);
    const custom = information ? { name: information.name, typeLabel: "其他信息", fields: [{ key: "content", label: "内容", value: information.value }] }
      : inspection.customCredential ?? (note || inspection.saveRequested && inspection.secrets.length === 0 && inspection.text !== text
      ? { fields: [{ key: "credential", label: "凭据内容", value: text }] } : undefined);
    if (custom && !information) this.rememberSecrets(custom.fields.map((field) => field.value));
    if (!inspection.saveRequested && !information || inspection.secrets.length === 0 && !custom?.fields.length) return { text: safeText, connectionIds: [], saved: false };
    return this.#serialize(async () => {
      const importKey = options.requestId ? createHash("sha256").update(options.requestId).digest("hex") : undefined;
      const previous = importKey ? this.#doc.imports[importKey]?.filter((id) => Boolean(this.#doc.connections[id])) : undefined;
      let ids = previous ?? [];
      if (!previous) {
        if (custom?.fields.length) {
          const saved = await this.#save({ name: this.redact(custom.name ?? "自定义凭据"), kind: "custom",
            category: information ? "information" : "credential",
            ...(custom.typeLabel ? { typeLabel: this.redact(custom.typeLabel) } : {}),
            credentialFields: custom.fields.map(({ key, label }) => ({ key, label })),
            secrets: Object.fromEntries(custom.fields.map(({ key, value }) => [key, value])) }, "chat", { trustedInformation: Boolean(information) });
          ids = [saved.id];
        } else {
          const secrets: ConnectionSecrets = {};
          const extras: ConnectionSecrets[] = [];
          for (const item of inspection.secrets) {
            const key = item.kind === "token" ? "apiKey" : item.kind;
            if (!SECRET_FIELDS.includes(key as typeof SECRET_FIELDS[number])) continue;
            const typedKey = key as keyof ConnectionSecrets;
            if (!secrets[typedKey]) secrets[typedKey] = item.value;
            else if (secrets[typedKey] !== item.value && !extras.some((extra) => extra[typedKey] === item.value)) extras.push({ [typedKey]: item.value });
          }
          const metadata = inspection.metadata;
          const fallbackCustom = requiresCustomSecretFallback(secrets);
          const kind: ConnectionKind = fallbackCustom ? "custom" : metadata.kind ?? (secrets.privateKey || metadata.host ? "ssh" : secrets.apiKey ? "api-key" : "account");
          const name = metadata.name || (kind === "ssh" ? metadata.host || "SSH 连接" : metadata.url ? new URL(metadata.url).hostname : kind === "api-key" ? "API 连接" : kind === "custom" ? "自定义凭据" : "账号连接");
          const fields: ConnectionFields = fallbackCustom
            ? { name: this.redact(name), kind: "custom", category: "credential", credentialFields: Object.keys(secrets).map((key) => ({ key, label: fieldLabel(key) })) }
            : { name: this.redact(name), kind, ...(metadata.host ? { host: metadata.host } : {}), ...(metadata.port ? { port: metadata.port } : {}), ...(metadata.username ? { username: metadata.username } : {}), ...(metadata.url ? { url: metadata.url } : {}) };
          // Only a definite endpoint and account identify a previous connection. Ambiguous secrets stay on incomplete cards.
          const candidate = !fallbackCustom && (fields.host || fields.url) && Object.values(this.#doc.connections).find((record) => binding(record) === binding(normalizeFields(fields)));
          const saved = await this.#save({ ...fields, ...(candidate ? { id: candidate.id, expectedRevision: candidate.revision } : {}), secrets }, "chat");
          ids = [saved.id];
          for (const [index, extra] of extras.entries()) {
            const extraCustom = requiresCustomSecretFallback(extra);
            const extraKind: ConnectionKind = extraCustom ? "custom" : extra.privateKey ? "ssh" : extra.apiKey ? "api-key" : "account";
            const extraCard = await this.#save({ name: `${extraKind === "ssh" ? "SSH" : extraKind === "api-key" ? "API" : extraKind === "custom" ? "自定义" : "账号"}凭据 ${index + 2}`, kind: extraKind, ...(extraCustom ? { category: "credential" as const, credentialFields: Object.keys(extra).map((key) => ({ key, label: fieldLabel(key) })) } : {}), secrets: extra }, "chat");
            ids.push(extraCard.id);
          }
        }
        if (importKey) {
          const imports = { ...this.#doc.imports, [importKey]: ids };
          while (Object.keys(imports).length > 2_048) delete imports[Object.keys(imports)[0]!];
          this.#persist({ ...this.#doc, imports });
        }
        await this.#changed();
      }
      const receipt = ids.map((id) => { const card = this.#doc.connections[id]!; return `${card.name}（${id}）${card.status === "incomplete" ? "，待补全连接信息" : ""}`; }).join("；");
      const kind = ids.length > 0 && ids.every((id) => this.#doc.connections[id]?.category === "information") ? "信息" : "连接";
      return { text: `${safeText}\n[${kind}已安全保存：${receipt}。可在连接授权中管理。]`, connectionIds: ids, saved: true };
    });
  }
  grant(ticketId: string, runEpoch: number, ids: string[], expectedRevisions?: Record<string, number>): void {
    this.#assertOpen();
    if (!ticketId || !Number.isSafeInteger(runEpoch) || runEpoch < 0 || !Array.isArray(ids) || ids.length > MAX_RECORDS) fail("任务连接授权无效。");
    const versions = new Map<string, number>();
    for (const id of ids) {
      if (this.#updating.has(id)) fail("连接正在更新，请稍后重试。", "connection_updating", 409);
      const current = this.#record(id);
      if (expectedRevisions && expectedRevisions[id] !== current.revision) fail("连接已被修改，请由主模型重新授权。", "connection_grant_stale", 403);
      versions.set(id, current.revision);
    }
    const previous = this.#grants.get(ticketId);
    if (previous && previous.runEpoch !== runEpoch) this.revoke(ticketId);
    const grant = this.#grants.get(ticketId) ?? { runEpoch, ids: new Set<string>(), revisions: new Map<string, number>() };
    for (const id of ids) { grant.ids.add(id); grant.revisions.set(id, versions.get(id)!); }
    this.#grants.set(ticketId, grant);
  }
  hasGrant(ticketId: string, runEpoch: number, connectionId: string): boolean { const grant = this.#grants.get(ticketId); return Boolean(!this.#updating.has(connectionId) && grant && grant.runEpoch === runEpoch && grant.ids.has(connectionId) && grant.revisions.get(connectionId) === this.#doc.connections[connectionId]?.revision); }
  revoke(ticketId: string): void {
    this.#grants.delete(ticketId);
    for (const [controller, active] of this.#active) if (active.ticketId === ticketId) controller.abort();
  }
  cancelRequests(ticketId: string): void {
    this.revoke(ticketId);
    for (const request of this.#requests.values()) if (request.ticketId === ticketId && request.status === "pending") { request.status = "revoked"; request.updatedAt = Date.now(); }
    this.#persist({ ...this.#doc, requests: Object.fromEntries(this.#requests) });
  }
  #revokeConnection(id: string, exceptTicketId?: string): void {
    this.#applicationProbes.delete(id);
    for (const grant of this.#grants.values()) { grant.ids.delete(id); grant.revisions.delete(id); }
    for (const [controller, active] of this.#active) if (active.connectionId === id && active.ticketId !== exceptTicketId) controller.abort();
    for (const request of this.#requests.values()) if (request.connectionId === id && (request.status === "pending" || request.status === "approved")) { request.status = "revoked"; request.updatedAt = Date.now(); }
    this.#persist({ ...this.#doc, requests: Object.fromEntries(this.#requests) });
  }
  requestAccess(input: { ticketId: string; conversationId: number; runEpoch: number; connectionId: string; reason: string; requestId: string }): ConnectionAccessRequest {
    this.#record(input.connectionId);
    if (!input.ticketId || !input.requestId || input.requestId.length > 256 || !Number.isSafeInteger(input.conversationId) || !Number.isSafeInteger(input.runEpoch) || !input.reason.trim() || input.reason.length > 2_000) fail("连接权限申请无效。");
    const id = `connection-access-${createHash("sha256").update(JSON.stringify([input.ticketId, input.runEpoch, input.conversationId, input.requestId])).digest("hex").slice(0, 32)}`;
    const old = this.#requests.get(id);
    if (old) { if (old.connectionId !== input.connectionId) fail("同一申请不能用于不同连接。", "connection_request_conflict", 409); return clone(old); }
    const now = Date.now();
    if (this.#requests.size >= 4_096) {
      for (const [oldId, oldRequest] of this.#requests) {
        if (oldRequest.status !== "pending") this.#requests.delete(oldId);
        if (this.#requests.size < 4_096) break;
      }
      if (this.#requests.size >= 4_096) fail("待处理的连接申请已达到上限。", "connection_request_limit", 409);
    }
    const request: ConnectionAccessRequest = { id, ticketId: input.ticketId, conversationId: input.conversationId, runEpoch: input.runEpoch, connectionId: input.connectionId,
      reason: this.redact(input.reason), status: this.hasGrant(input.ticketId, input.runEpoch, input.connectionId) ? "approved" : "pending", createdAt: now, updatedAt: now };
    this.#requests.set(id, request);
    this.#persist({ ...this.#doc, requests: Object.fromEntries(this.#requests) });
    return clone(request);
  }
  getRequest(id: string): ConnectionAccessRequest | undefined { const request = this.#requests.get(id); return request ? clone(request) : undefined; }
  decide(id: string, approve: boolean): ConnectionAccessRequest {
    const request = this.#requests.get(id);
    if (!request) fail("连接申请已失效。", "connection_request_not_found", 404);
    if (request.status !== "pending") {
      if (request.status === (approve ? "approved" : "rejected")) return clone(request);
      fail("连接申请已处理或撤销。", "connection_request_settled", 409);
    }
    if (approve) this.grant(request.ticketId, request.runEpoch, [request.connectionId]);
    request.status = approve ? "approved" : "rejected";
    request.updatedAt = Date.now();
    this.#persist({ ...this.#doc, requests: Object.fromEntries(this.#requests) });
    return clone(request);
  }
  async #secrets(record: StoredConnection, information = false): Promise<ConnectionSecrets> {
    if (record.kind === "app" && getConnectionApplication(record.appId).authentication === "macos" && !record.credentialRef) return {};
    if (record.kind === "mcp" && !record.credentialRef && (record.mcpTransport === "stdio" || (record.mcpAuthMode ?? "oauth") === "none" || (record.mcpAuthMode ?? "oauth") === "oauth")) return {};
    if (!record.credentialRef) fail("连接凭据尚未填写。", "connection_credential_missing", 409);
    const fields = await this.#vault.get(record.credentialRef);
    if (!fields || fields.__binding !== binding(record)) fail("凭据与当前连接不匹配，请重新填写。", "connection_credential_mismatch", 409);
    const readable = record.kind === "custom" && record.category === "information" && fields.__informationReadable === "1";
    if (information && !readable) fail("此记录包含受保护凭据，不能作为普通信息读取。", "connection_information_protected", 403);
    if (readable) { this.#readableInformation.add(record.id); this.#rememberActualSecrets(fields); } else this.#remember(fields);
    if (record.username && fields.password) this.#known.add(Buffer.from(`${record.username}:${fields.password}`).toString("base64"));
    return Object.fromEntries(record.secretFields.flatMap((key) => credentialKey(key) && fields[key] ? [[key, fields[key]!]] : []));
  }
  async #applicationFailed(record: StoredConnection, detail?: string): Promise<void> {
    await this.#serialize(async () => {
      const current = this.#doc.connections[record.id];
      if (!current || current.revision !== record.revision) return;
      const updated = { ...current, status: "error" as const, error: detail ? this.redact(detail).slice(0, 500) : "应用暂不可用，请检查连接或授权。", updatedAt: Date.now() };
      this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [record.id]: updated } });
      this.#revokeConnection(record.id);
      this.#applicationProbes.set(record.id, { revision: record.revision, at: Date.now(), connected: false, error: updated.error });
      await this.#changed();
    });
  }
  async use(ticketId: string, runEpoch: number, connectionId: string, operation: ConnectionUseOperation, options: { readOnly?: boolean; signal?: AbortSignal; assertActive?: () => Promise<void>; onOutwardAction?: (label: string) => void | Promise<void> } = {}): Promise<ConnectionUseResult> {
    this.#assertOpen();
    if (!this.hasGrant(ticketId, runEpoch, connectionId)) fail("本任务尚未获得此连接的使用权限，请向主模型申请。", "connection_access_denied", 403);
    const record = this.#record(connectionId);
    const informationRead = operation.kind === "information" && operation.action === "read" && record.kind === "custom" && record.category === "information";
    if (operation.kind === "information" && !informationRead) fail("此记录不能作为普通信息读取。", "connection_information_protected", 403);
    if (record.kind === "custom" && !informationRead) fail("此凭据已安全保存，当前未接入对应的执行工具。", "connection_adapter_unavailable", 409);
    if (record.kind === "app") {
      if (operation.kind !== "app") fail("预置应用不能使用通用 SSH 或 HTTP 操作。", "connection_application_action_invalid", 400);
      const definition = getConnectionApplication(record.appId), action = definition.actions.find((item) => item.id === operation.action);
      if (definition.authentication === "macos" && this.#platform !== "darwin") fail("此应用需要在 Mac 上连接。", "connection_application_unavailable", 503);
      if (!action) fail("此应用不支持该操作。", "connection_application_action_invalid", 400);
      if (record.status !== "verified" || this.#applicationProbes.get(record.id)?.connected === false) fail("请先连接并完成此应用的授权。", "connection_application_not_ready", 409);
      if (options.readOnly && !action.readOnly) fail("只读任务不能执行此应用的写入操作。", "connection_read_only", 403);
    } else if (record.kind === "mcp") {
      if (operation.kind !== "mcp") fail("MCP 连接请使用 operation='mcp' 执行 list_tools 或 call_tool。", "connection_mcp_operation_invalid", 400);
      if (record.mcpTransport === "http" && (record.mcpAuthMode ?? "oauth") === "oauth" && !this.#mcpOAuthAuthorized.has(record.id)) {
        fail("请先在连接设置中完成此 MCP 应用的 OAuth 授权登录。", "connection_mcp_auth_required", 401);
      }
    } else {
      if (operation.kind === "app" || operation.kind === "mcp") fail("此连接不支持该应用操作。", "connection_application_action_invalid", 400);
      if (options.readOnly && (operation.kind === "ssh" || operation.kind === "http" && !["GET", "HEAD"].includes(operation.method ?? "GET"))) fail("只读任务不能执行此连接操作。", "connection_read_only", 403);
    }
    if (record.kind === "ssh" && !record.trustedHostFingerprint) fail("请先在连接授权页确认服务器指纹。", "connection_host_untrusted", 409);
    // A stop must fence this attempt even if an older parent snapshot later restores its grant.
    const controller = new AbortController();
    this.#active.set(controller, { ticketId, connectionId });
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      if (signal.aborted) fail("任务连接权限已撤销。", "connection_access_revoked", 403);
      const secrets = await this.#secrets(record, informationRead);
      this.#assertOpen();
      if (signal.aborted || !this.hasGrant(ticketId, runEpoch, connectionId) || this.#record(connectionId).revision !== record.revision) fail("任务连接权限已撤销。", "connection_access_revoked", 403);
      if (options.assertActive) await options.assertActive();
      this.#assertOpen();
      if (signal.aborted || !this.hasGrant(ticketId, runEpoch, connectionId) || this.#record(connectionId).revision !== record.revision) fail("任务连接权限已撤销。", "connection_access_revoked", 403);
      if (record.kind === "app") {
        await this.#applications.probe(record.appId!, secrets, signal, { requestPermission: false });
        this.#assertOpen();
        if (signal.aborted || !this.hasGrant(ticketId, runEpoch, connectionId) || this.#record(connectionId).revision !== record.revision) fail("任务连接权限已撤销。", "connection_access_revoked", 403);
      }
      if (informationRead) {
        const labels = new Map(record.credentialFields?.map((field) => [field.key, field.label]));
        return { kind: "information", output: JSON.stringify({ name: record.name, fields: record.secretFields.map((key) => ({ label: labels.get(key) ?? key, value: this.redact(secrets[key] ?? "") })) }) };
      }
      if (record.kind === "mcp" && operation.kind === "mcp") {
        this.#assertNotPausedLocalMcp(record);
        const result = await this.#mcpPool.execute(this.#view(record), secrets, binding(record), operation, { readOnly: options.readOnly, signal, onOutwardAction: options.onOutwardAction });
        if (!this.hasGrant(ticketId, runEpoch, connectionId) || signal.aborted) fail("任务连接权限已撤销。", "connection_access_revoked", 403);
        return { ...result, output: this.redact(result.output) };
      }
      if (options.onOutwardAction) {
        if (operation.kind === "ssh") {
          await options.onOutwardAction(`ssh:${record.name}`);
        } else if (operation.kind === "http") {
          const method = (operation.method ?? "GET").toUpperCase();
          if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
            await options.onOutwardAction(`http:${method} ${record.name}${operation.path}`);
          }
        } else if (operation.kind === "app") {
          const action = getConnectionApplication(record.appId).actions.find((item) => item.id === operation.action);
          if (action && !action.readOnly) {
            await options.onOutwardAction(`app:${record.appId ?? record.name}:${operation.action}`);
          }
        }
      }
      const result = await this.#executor.execute(this.#view(record), secrets, operation, signal);
      if (!this.hasGrant(ticketId, runEpoch, connectionId) || signal.aborted) fail("任务连接权限已撤销。", "connection_access_revoked", 403);
      return { ...result, output: this.redact(result.output) };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const inputOrResourceError = typeof code === "string" && /(?:invalid_input|invalid_parameters|action_unsupported|resource_unavailable|target_unavailable|mailbox_unavailable|send_rejected|rate_limited)$/.test(code);
      if (record.kind === "app" && !inputOrResourceError && !signal.aborted && !this.#closed && this.hasGrant(ticketId, runEpoch, connectionId)) await this.#applicationFailed(record, typeof code === "string" && code.startsWith("connection_") && error instanceof Error ? error.message : undefined);
      if (record.kind === "mcp" && code === "connection_mcp_auth_required" && !signal.aborted && !this.#closed) {
        this.#mcpOAuthAuthorized.delete(record.id);
        await this.#markMcpError(record.id, record.revision, "授权已过期或权限不足，请重新登录授权。");
      }
      if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.startsWith("connection_")) throw Object.assign(new Error(this.redact(error instanceof Error ? error.message : "连接操作失败。")), { code: error.code, status: "status" in error ? error.status : 400 });
      fail("连接操作未完成，请检查连接与授权状态。", "connection_execution_failed", 502);
    } finally { this.#active.delete(controller); }
  }
  async test(id: string, options: { rescan?: boolean } = {}): Promise<ConnectionTestResult> {
    this.#assertOpen();
    if (this.#record(id).kind === "custom") fail("此凭据已安全保存，尚未配置对应的连接测试。", "connection_adapter_unavailable", 409);
    const controller = new AbortController();
    this.#active.set(controller, { ticketId: `connection-test:${id}`, connectionId: id });
    try { return await this.#test(id, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]), options); }
    finally { this.#active.delete(controller); }
  }
  async #test(id: string, signal: AbortSignal, options: { rescan?: boolean } = {}): Promise<ConnectionTestResult> {
    const record = this.#record(id);
    if (record.kind === "app") {
      try {
        const secrets = await this.#secrets(record);
        signal.throwIfAborted();
        await this.#applications.probe(record.appId!, secrets, signal, { requestPermission: false });
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw error;
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        await this.#applicationFailed(record, typeof code === "string" && code.startsWith("connection_") && error instanceof Error ? error.message : undefined);
        return { connection: this.#view(this.#record(id)) };
      }
      return this.#serialize(async () => {
        signal.throwIfAborted();
        const current = this.#record(id);
        if (current.revision !== record.revision) fail("连接已被修改，请重新测试。", "connection_conflict", 409);
        const updated = { ...current, status: "verified" as const, error: undefined, updatedAt: Date.now() };
        this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
        this.#applicationProbes.set(id, { revision: current.revision, at: Date.now(), connected: true });
        await this.#changed();
        return { connection: this.#view(updated) };
      });
    }
    if (record.kind === "mcp") {
      try {
        this.#assertNotPausedLocalMcp(record);
        const secrets = await this.#secrets(record);
        signal.throwIfAborted();
        const discovery = await this.#mcpPool.test(this.#view(record), secrets, binding(record), signal);
        signal.throwIfAborted();
        const updated = await this.#markMcpVerified(id, record.revision, discovery);
        if (!updated) fail("连接已被修改，请重新测试。", "connection_conflict", 409);
        return { connection: updated };
      } catch (error) {
        if (signal.aborted) throw error;
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code === "connection_mcp_auth_required") this.#mcpOAuthAuthorized.delete(record.id);
        const message = error instanceof Error ? error.message : "MCP 连接测试未通过，请检查地址、网络和授权状态。";
        const updated = await this.#markMcpError(id, record.revision, message);
        return { connection: updated ?? this.#view(this.#record(id)) };
      }
    }
    if (!record.hasCredential || record.status === "incomplete" && (!record.host && !record.url || !record.username && record.kind !== "api-key")) fail("请先补全连接信息和凭据。", "connection_incomplete", 409);
    const revision = record.revision;
    const needsScan = record.kind === "ssh" && (
      options.rescan === true ||
      !record.trustedHostFingerprint ||
      this.#executor.hasTrustedHost?.(this.#view(record), record.trustedHostFingerprint) === false
    );
    if (needsScan) {
      let scan: ConnectionHostScan;
      try { scan = await this.#executor.scan(this.#view(record), signal); }
      catch (error) {
        if (signal.aborted) throw error;
        const classified = classifySshScanFailure({ error, host: record.host, platform: this.#platform });
        return this.#serialize(async () => {
          signal.throwIfAborted();
          const current = this.#record(id);
          if (current.revision !== revision) fail("连接已被修改，请重新测试。", "connection_conflict", 409);
          const updated: StoredConnection = { ...current, status: "error", error: classified.message, updatedAt: Date.now() };
          this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
          await this.#changed();
          return { connection: this.#view(updated), errorCode: classified.code };
        });
      }
      return this.#serialize(async () => {
        signal.throwIfAborted();
        const current = this.#record(id);
        if (current.revision !== revision) fail("连接已被修改，请重新测试。", "connection_conflict", 409);
        const hostMismatch = Boolean(current.trustedHostFingerprint && scan.fingerprint !== current.trustedHostFingerprint);
        if (hostMismatch) {
          this.#revokeConnection(id);
          this.#onSshChanged?.({ type: "host-mismatch", connectionId: id });
        }
        this.#scans.set(id, { revision, value: scan, at: Date.now() });
        const updated: StoredConnection = {
          ...current, hostFingerprint: scan.fingerprint, status: hostMismatch ? "error" : "incomplete",
          error: hostMismatch ? "服务器指纹已变更，请核对后重新信任。" : "请确认服务器指纹。", updatedAt: Date.now(),
        };
        this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
        await this.#changed();
        return {
          connection: this.#view(updated), fingerprint: scan.fingerprint, requiresTrust: true,
          ...(hostMismatch ? { hostMismatch: true, previousFingerprint: current.trustedHostFingerprint, errorCode: "connection_host_mismatch" as const } : {}),
        };
      });
    }
    const secrets = await this.#secrets(record);
    signal.throwIfAborted();
    if (this.#record(id).revision !== revision) fail("连接已被修改，请重新测试。", "connection_conflict", 409);
    if (record.kind === "account") return { connection: this.#view(record) };
    let exitCode: number | undefined, stderr: string | undefined, output = "", status: number | undefined, caught: unknown;
    try {
      if (record.kind === "ssh" && this.#executor.probeSsh) {
        const probe = await this.#executor.probeSsh(this.#view(record), secrets, signal);
        exitCode = probe.exitCode; stderr = probe.stderr; output = probe.output;
      } else {
        const result = await this.#executor.execute(this.#view(record), secrets, record.kind === "ssh" ? { kind: "ssh", command: "exit 0", timeoutMs: 15_000 } : { kind: "http", path: new URL(record.url!).pathname, method: "GET" }, signal);
        exitCode = result.exitCode; output = result.output; status = result.status;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      caught = error;
    }
    return this.#serialize(async () => {
      signal.throwIfAborted();
      const current = this.#record(id);
      if (current.revision !== revision) fail("连接已被修改，请重新测试。", "connection_conflict", 409);
      const ok = !caught && (record.kind === "ssh" ? exitCode === 0 : Boolean(status && status >= 200 && status < 400));
      if (ok) {
        const updated: StoredConnection = { ...current, status: "verified", error: undefined, updatedAt: Date.now() };
        this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
        if (record.kind === "ssh") this.#onSshChanged?.({ type: "verified", connectionId: id });
        await this.#changed();
        return { connection: this.#view(updated) };
      }
      if (record.kind === "ssh") {
        const diag = classifySshExecutionFailure({
          error: caught, exitCode, stderr, output, host: current.host,
          authMethod: secrets.privateKey ? "private-key" : "password", platform: this.#platform,
        });
        if (diag.hostMismatch) {
          this.#revokeConnection(id);
          this.#onSshChanged?.({ type: "host-mismatch", connectionId: id });
        }
        const updated: StoredConnection = { ...current, status: "error", error: diag.message, updatedAt: Date.now() };
        this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
        await this.#changed();
        return {
          connection: this.#view(updated), errorCode: diag.code,
          ...(diag.hostMismatch ? { hostMismatch: true, previousFingerprint: current.trustedHostFingerprint } : {}),
        };
      }
      const updated: StoredConnection = { ...current, status: "error", error: "连接测试未通过，请检查地址、网络和凭据。", updatedAt: Date.now() };
      this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
      await this.#changed();
      return { connection: this.#view(updated), errorCode: "connection_execution_failed" };
    });
  }
  async trust(id: string, fingerprint: string): Promise<ConnectionRecordView> {
    return this.#serialize(async () => {
      const record = this.#record(id), scan = this.#scans.get(id);
      if (record.kind !== "ssh" || !scan || Date.now() - scan.at > 5 * 60_000 || scan.revision !== record.revision || fingerprint !== scan.value.fingerprint) fail("指纹确认已过期或不匹配，请重新测试连接。", "connection_host_scan_expired", 409);
      const identityChanged = Boolean(record.trustedHostFingerprint && record.trustedHostFingerprint !== fingerprint);
      await this.#executor.trust(this.#view(record), scan.value);
      if (identityChanged) this.#revokeConnection(id);
      const updated: StoredConnection = {
        ...record, revision: identityChanged ? record.revision + 1 : record.revision,
        trustedHostFingerprint: fingerprint, hostFingerprint: fingerprint, status: "saved", error: undefined, updatedAt: Date.now(),
      };
      this.#persist({ ...this.#doc, connections: { ...this.#doc.connections, [id]: updated } });
      this.#scans.delete(id);
      await this.#changed();
      return this.#view(updated);
    });
  }
  async resolveSshForDevice(
    connectionId: string,
    options: { requireVerified?: boolean } = {},
  ): Promise<ResolvedDeviceSshCredential> {
    this.#assertOpen();
    const record = this.#record(connectionId);
    if (record.kind !== "ssh") fail("所选凭据不是 SSH 服务器。", "invalid_connection", 400);
    if (!record.hasCredential || !record.host || !record.username) {
      fail("此 SSH 凭据信息不完整，请先在「授权凭据」补全。", "connection_credential_missing", 409);
    }
    if (options.requireVerified !== false && record.status !== "verified") {
      fail("请先在「授权凭据」中测试并验证此 SSH 凭据。", "connection_ssh_unverified", 409);
    }
    const view = this.#view(record);
    const knownHostsPath = record.trustedHostFingerprint
      ? this.#executor.trustedHostPath?.(view, record.trustedHostFingerprint)
      : undefined;
    if (!record.trustedHostFingerprint || !knownHostsPath) {
      fail("此 SSH 凭据的主机指纹尚未信任或已失效，请在「授权凭据」重新验证。", "connection_host_untrusted", 409);
    }
    const secrets = await this.#secrets(record);
    if (!secrets.password && !secrets.privateKey) {
      fail("此 SSH 凭据缺少登录密码或私钥。", "connection_credential_missing", 409);
    }
    return { connection: view, secrets, knownHostsPath, revision: record.revision };
  }
  async closeAsync(): Promise<void> {
    await this.mcpOAuth.close().catch(() => undefined);
    await this.#mcpPool.close().catch(() => undefined);
    await closeMcpHttpAgents().catch(() => undefined);
    this.close();
  }
  close(): void {
    this.#closed = true;
    for (const controller of this.#active.keys()) controller.abort();
    void this.mcpOAuth.close().catch(() => undefined);
    void this.#mcpPool.close().catch(() => undefined);
    this.#grants.clear();
    this.#requests.clear();
    this.#scans.clear();
  }
}
