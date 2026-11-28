import os from "node:os";
import {
  McpAuthRequiredError,
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  limitMcpContent,
  normalizeMcpInputSchema,
  toLlmContent,
  type ClientCapabilities,
  type LlmContent,
  type McpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import {
  KULO_VERSION,
  MCP_APP_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
  extractMcpToolUiMeta,
  isMcpToolVisibleToApp,
  isMcpToolVisibleToModel,
  isValidMcpAppResourceUri,
  type ConnectionRecordView,
  type ConnectionSecrets,
  type ConnectionUseOperation,
  type ConnectionUseResult,
  type ExecutionTrustMode,
  type McpAppViewToolResult,
  type McpToolSummary,
} from "@kulo/protocol";
import { buildSafeMcpDiscoveryEnv } from "@kulo/env";
import type { ConnectionVault } from "./connections.js";
import { buildAugmentedHostPath } from "./host-path.js";
import { createMcpFetch, validateMcpTargetUrl } from "./mcp-fetch.js";
import {
  McpOAuthRefreshLockManager,
  createKuloMcpAuthProvider,
  createVaultMcpOAuthStore,
  type KuloMcpAuthProvider,
} from "./mcp-oauth.js";
import {
  COMPOSIO_PRESET_ID,
  evaluateComposioCall,
  filterComposioTools,
  isComposioSessionMissingError,
} from "./composio-bridge.js";
import { isBlockedMcpEnvKey, isMcpAggregatorConnection, isNonPublicMcpUrl } from "./mcp-presets.js";
import {
  buildMcpAppViewToolResult,
  isHostApprovedReadOnlyMcpAppTool,
  sanitizeStructuredContentForView,
  validateMcpAppResourceResult,
  type McpAppReadResourceOutput,
  type McpAppToolResultCapture,
} from "./mcp-app-sanitize.js";

export {
  buildMcpAppViewToolResult,
  isHostApprovedReadOnlyMcpAppTool,
  sanitizeStructuredContentForView,
  type McpAppReadResourceOutput,
  type McpAppToolResultCapture,
};

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const OAUTH_REFRESH_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_STORED_TOOLS = 200;
const MAX_TOOL_DESCRIPTION_CHARS = 300;
const MAX_LIST_TOOLS_BYTES = 32 * 1024;
const MAX_INLINE_IMAGE_BASE64_BYTES = 64 * 1024;

export type McpOperation = Extract<ConnectionUseOperation, { kind: "mcp" }>;

export interface McpExecuteResult extends ConnectionUseResult {
  mcpAppCapture?: McpAppToolResultCapture;
}

export interface McpDiscoverySnapshot {
  serverName?: string;
  tools: McpToolSummary[];
  updatedAt: number;
}

export interface McpTransportFactoryContext {
  record: ConnectionRecordView;
  secrets: ConnectionSecrets;
  openGetStream: boolean;
  authProvider?: KuloMcpAuthProvider;
}

export interface McpConnectionPoolOptions {
  vault: ConnectionVault;
  locks: McpOAuthRefreshLockManager;
  getBinding: (connectionId: string) => string | undefined;
  redact: (text: string) => string;
  onSecrets: (values: readonly string[]) => void;
  onAuthorizedChange: (connectionId: string, authorized: boolean) => void;
  onDiscoveryUpdated: (connectionId: string, expectedRevision: number, snapshot: McpDiscoverySnapshot) => Promise<void> | void;
  onComposioSessionExpired?: (connectionId: string, expectedBinding: string, signal?: AbortSignal, failedSessionId?: string) => Promise<ConnectionRecordView | undefined>;
  idleMs?: number;
  baseFetch?: typeof fetch;
  transportFactory?: (ctx: McpTransportFactoryContext) => McpTransport | Promise<McpTransport>;
  getExecutionTrustMode?: () => ExecutionTrustMode;
  getBlockedEnvNames?: () => Iterable<string>;
}

interface PoolEntry {
  connectionId: string;
  revision: number;
  binding: string;
  isStdio?: boolean;
  mcpAppsActive: boolean;
  client: McpClient;
  authProvider?: KuloMcpAuthProvider;
  tools: Tool[];
  toolsDirty: boolean;
  serverName?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}

export function isMcpToolReadOnly(tool: Pick<Tool, "annotations">): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
}

export function summarizeMcpTools(tools: readonly Tool[], redact: (text: string) => string): McpToolSummary[] {
  return tools
    .filter((tool) => isMcpToolVisibleToModel(tool._meta))
    .slice(0, MAX_STORED_TOOLS)
    .map((tool) => {
      const ui = extractMcpToolUiMeta(tool._meta);
      return {
        name: tool.name,
        ...(tool.title ? { title: redact(tool.title).slice(0, 120) } : {}),
        ...(tool.description ? { description: redact(tool.description).slice(0, MAX_TOOL_DESCRIPTION_CHARS) } : {}),
        readOnly: isMcpToolReadOnly(tool),
        ...(tool.annotations?.destructiveHint === true ? { destructive: true } : {}),
        ...(ui?.resourceUri ? { uiResourceUri: redact(ui.resourceUri).slice(0, 256) } : {}),
        ...(ui?.visibility ? { visibility: ui.visibility } : {}),
      };
    });
}

export function buildMcpStdioEnv(
  secrets: ConnectionSecrets,
  allowedKeys: readonly string[],
  options?: { trustMode?: ExecutionTrustMode; blockedEnvNames?: Iterable<string> },
): Record<string, string> {
  const env: Record<string, string> = options?.trustMode === "trusted"
    ? {
        ...buildSafeMcpDiscoveryEnv({ sourceEnv: process.env, blockedEnvNames: options.blockedEnvNames }),
        PATH: buildAugmentedHostPath(),
        HOME: os.homedir(),
        TMPDIR: os.tmpdir(),
        LANG: process.env.LANG || "en_US.UTF-8",
      }
    : {
        PATH: buildAugmentedHostPath(),
        HOME: os.homedir(),
        TMPDIR: os.tmpdir(),
        LANG: process.env.LANG || "en_US.UTF-8",
      };
  if (options?.trustMode !== "trusted") {
    const baseWhitelist = [
      "LC_CTYPE",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      ...(process.platform === "win32"
        ? ["SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP"]
        : []),
    ];
    for (const name of baseWhitelist) {
      const val = process.env[name];
      if (val && !val.startsWith("()")) env[name] = val;
    }
  }
  for (const key of allowedKeys) {
    if (isBlockedMcpEnvKey(key)) continue;
    const value = secrets[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Redacts all text blocks FIRST (before any middle truncation so secrets spanning the 10 KiB
 * boundary cannot leak half-redacted), summarizes oversized images, and bounds total text via `limitMcpContent`.
 */
export async function sanitizeMcpCallContent(
  blocks: readonly LlmContent[],
  redact: (text: string) => string,
): Promise<LlmContent[]> {
  let keptImages = 0;
  const redactedBlocks: LlmContent[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      redactedBlocks.push({ type: "text", text: redact(block.text) });
      continue;
    }
    if (block.type === "image") {
      const approxBytes = Buffer.byteLength(block.data, "utf8");
      if (keptImages === 0 && approxBytes <= MAX_INLINE_IMAGE_BASE64_BYTES) {
        keptImages++;
        redactedBlocks.push(block);
      } else {
        redactedBlocks.push({
          type: "text",
          text: `[Image omitted: ${redact(block.mimeType || "image/*")}, ${approxBytes} bytes]`,
        });
      }
      continue;
    }
  }
  const limited = await limitMcpContent(redactedBlocks);
  return limited.content.map((block) =>
    block.type === "text" ? { type: "text", text: redact(block.text) } : block,
  );
}

export class McpConnectionPool {
  readonly #options: McpConnectionPoolOptions;
  readonly #idleMs: number;
  readonly #entries = new Map<string, PoolEntry>();
  readonly #connecting = new Map<string, Promise<PoolEntry>>();
  readonly #challenges = new Map<string, OAuthChallenge>();
  #stdioGeneration = 0;
  #closed = false;

  constructor(options: McpConnectionPoolOptions) {
    this.#options = options;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  getChallenge(connectionId: string): OAuthChallenge | undefined {
    return this.#challenges.get(connectionId);
  }

  clearChallenge(connectionId: string): void {
    this.#challenges.delete(connectionId);
  }

  #touchIdle(entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.#entries.get(entry.connectionId) === entry) {
        void this.#closeEntry(entry);
      }
    }, this.#idleMs);
    entry.idleTimer.unref();
  }

  async #closeEntry(entry: PoolEntry): Promise<void> {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    if (this.#entries.get(entry.connectionId) === entry) {
      this.#entries.delete(entry.connectionId);
    }
    if (entry.closing) {
      await entry.closing;
      return;
    }
    entry.closing = (async () => {
      // Wait for any in-flight OAuth token refresh to save rotated refresh tokens before closing.
      await entry.authProvider?.settled().catch(() => undefined);
      await entry.client.close().catch(() => undefined);
    })();
    await entry.closing;
  }

  async #buildTransport(
    record: ConnectionRecordView,
    secrets: ConnectionSecrets,
    binding: string,
    openGetStream: boolean,
  ): Promise<{ transport: McpTransport; authProvider?: KuloMcpAuthProvider }> {
    let authProvider: KuloMcpAuthProvider | undefined;
    if (record.mcpTransport === "http" && record.url && (record.mcpAuthMode ?? "oauth") === "oauth") {
      const trusted = this.#options.getExecutionTrustMode?.() === "trusted";
      const allowPrivateNetwork = trusted || isNonPublicMcpUrl(record.url);
      const oauthFetch = createMcpFetch({
        allowPrivateNetwork,
        allowPrivateHttp: trusted,
        timeoutMs: OAUTH_REFRESH_TIMEOUT_MS,
        baseFetch: this.#options.baseFetch,
      });
      const store = createVaultMcpOAuthStore({
        connectionId: record.id,
        serverUrl: record.url,
        expectedBinding: binding,
        vault: this.#options.vault,
        locks: this.#options.locks,
        getCurrentBinding: () => this.#options.getBinding(record.id),
        onSecrets: this.#options.onSecrets,
        onAuthorizedChange: (authorized) => this.#options.onAuthorizedChange(record.id, authorized),
      });
      authProvider = createKuloMcpAuthProvider({
        serverUrl: record.url,
        store,
        clientId: record.mcpOAuthClientId,
        clientSecret: secrets.clientSecret,
        fetch: oauthFetch,
        onChallenge: (challenge) => {
          this.#challenges.set(record.id, challenge);
        },
      });
    }

    if (this.#options.transportFactory) {
      const transport = await this.#options.transportFactory({ record, secrets, openGetStream, authProvider });
      return { transport, authProvider };
    }

    if (record.mcpDisabled) {
      throw Object.assign(new Error("此 MCP 连接当前已禁用，请先在授权凭据中启用。"), {
        code: "connection_mcp_disabled",
        status: 409,
      });
    }
    if (record.mcpTransport === "http") {
      if (!record.url) {
        throw Object.assign(new Error("缺少远程 MCP 服务地址。"), { code: "connection_mcp_invalid_config", status: 400 });
      }
      const trusted = this.#options.getExecutionTrustMode?.() === "trusted";
      const allowPrivateNetwork = trusted || isNonPublicMcpUrl(record.url);
      validateMcpTargetUrl(record.url, { allowPrivateNetwork, allowPrivateHttp: trusted });
      const headers: Record<string, string> = {};
      const authMode = record.mcpAuthMode ?? "oauth";
      let authHeaderName: string | undefined;
      if (authMode === "bearer") {
        if (!secrets.apiKey) {
          throw Object.assign(new Error("缺少 MCP 访问令牌。"), { code: "connection_credential_missing", status: 409 });
        }
        headers.Authorization = `Bearer ${secrets.apiKey}`;
      } else if (authMode === "header") {
        if (!secrets.apiKey) {
          throw Object.assign(new Error("缺少 MCP 认证请求头密钥。"), { code: "connection_credential_missing", status: 409 });
        }
        authHeaderName = record.headerName || "X-API-Key";
        headers[authHeaderName] = secrets.apiKey;
      }
      const transport = new StreamableHttpTransport({
        url: record.url,
        headers,
        fetch: createMcpFetch({
          allowPrivateNetwork,
          allowPrivateHttp: trusted,
          allowSafeRedirects: trusted,
          ...(authHeaderName ? { authHeaderName } : {}),
          baseFetch: this.#options.baseFetch,
        }),
        openGetStream,
        maxMessageBytes: MAX_MESSAGE_BYTES,
        ...(authProvider ? { authProvider } : {}),
      });
      return { transport, authProvider };
    }

    if (record.mcpTransport === "stdio") {
      if (!record.mcpCommand) {
        throw Object.assign(new Error("缺少本机 MCP 启动命令。"), { code: "connection_mcp_invalid_config", status: 400 });
      }
      const allowedKeys = (record.credentialFields ?? []).map((f) => f.key);
      const trustMode = this.#options.getExecutionTrustMode?.() ?? "sandboxed";
      const transport = new StdioTransport({
        command: record.mcpCommand,
        args: record.mcpArgs ?? [],
        ...(record.mcpCwd ? { cwd: record.mcpCwd } : {}),
        inheritEnv: false,
        env: buildMcpStdioEnv(secrets, allowedKeys, {
          trustMode,
          blockedEnvNames: this.#options.getBlockedEnvNames?.(),
        }),
        maxMessageBytes: MAX_MESSAGE_BYTES,
        closeTimeoutMs: 2_000,
      });
      return { transport };
    }

    throw Object.assign(new Error("不支持的 MCP 传输类型。"), { code: "connection_mcp_invalid_config", status: 400 });
  }

  #mapError(error: unknown): never {
    if (error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError) {
      throw Object.assign(new Error("此 MCP 应用需要完成或重新进行 OAuth 授权。"), {
        code: "connection_mcp_auth_required",
        status: 401,
      });
    }
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.startsWith("connection_")) {
      throw error;
    }
    const detail = error instanceof Error ? this.#options.redact(error.message) : "MCP 调用失败";
    throw Object.assign(new Error(detail || "MCP 调用失败。"), {
      code: "connection_mcp_execution_failed",
      status: 502,
    });
  }

  async #openEntry(
    record: ConnectionRecordView,
    secrets: ConnectionSecrets,
    binding: string,
    openGetStream: boolean,
    signal?: AbortSignal,
  ): Promise<PoolEntry> {
    signal?.throwIfAborted();
    const mcpAppsEligible = record.mcpAppsEnabled === true && !isMcpAggregatorConnection(record);
    const { transport, authProvider } = await this.#buildTransport(record, secrets, binding, openGetStream);
    const client = new McpClient({
      name: "kulo",
      version: KULO_VERSION,
      requestTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
      ...(mcpAppsEligible
        ? {
            capabilities: {
              extensions: {
                [MCP_APP_EXTENSION_ID]: {
                  mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
                },
              },
            } as ClientCapabilities,
          }
        : {}),
    });
    try {
      const init = await client.connect(transport);
      signal?.throwIfAborted();
      const rawTools = init.capabilities?.tools ? await client.listTools({ signal, timeoutMs: 20_000 }) : [];
      const tools = filterComposioTools(record, rawTools);
      const serverName = init.serverInfo?.title || init.serverInfo?.name;
      const entry: PoolEntry = {
        connectionId: record.id,
        revision: record.revision,
        binding,
        isStdio: record.mcpTransport === "stdio",
        mcpAppsActive: mcpAppsEligible,
        client,
        authProvider,
        tools,
        toolsDirty: false,
        serverName,
      };
      client.onNotification("notifications/tools/list_changed", () => {
        entry.toolsDirty = true;
      });
      client.onClose(() => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (this.#entries.get(record.id) === entry) this.#entries.delete(record.id);
      });
      await this.#options.onDiscoveryUpdated(record.id, record.revision, {
        ...(serverName ? { serverName } : {}),
        tools: summarizeMcpTools(tools, this.#options.redact),
        updatedAt: Date.now(),
      });
      return entry;
    } catch (err) {
      await authProvider?.settled().catch(() => undefined);
      await client.close().catch(() => undefined);
      this.#mapError(err);
    }
  }

  async #getOrConnect(
    record: ConnectionRecordView,
    secrets: ConnectionSecrets,
    binding: string,
    signal?: AbortSignal,
  ): Promise<PoolEntry> {
    if (this.#closed) {
      throw Object.assign(new Error("连接池已关闭。"), { code: "connection_manager_closed", status: 503 });
    }
    const existing = this.#entries.get(record.id);
    if (existing && existing.revision === record.revision && existing.binding === binding && existing.client.connectionState === "connected") {
      this.#touchIdle(existing);
      return existing;
    }
    if (existing) await this.#closeEntry(existing);

    let pending = this.#connecting.get(record.id);
    if (!pending) {
      const stdioGen = record.mcpTransport === "stdio" ? this.#stdioGeneration : undefined;
      pending = this.#openEntry(record, secrets, binding, true, signal)
        .then((entry) => {
          if (
            this.#closed ||
            this.#options.getBinding(record.id) !== binding ||
            (stdioGen !== undefined && this.#stdioGeneration !== stdioGen)
          ) {
            void this.#closeEntry(entry);
            throw Object.assign(new Error("连接配置或执行模式已变更，请重试。"), { code: "connection_conflict", status: 409 });
          }
          this.#entries.set(record.id, entry);
          this.#touchIdle(entry);
          return entry;
        })
        .finally(() => {
          if (this.#connecting.get(record.id) === pending) this.#connecting.delete(record.id);
        });
      this.#connecting.set(record.id, pending);
    }
    return pending;
  }

  async #ensureFreshTools(record: ConnectionRecordView, entry: PoolEntry, forceRefresh: boolean, signal?: AbortSignal): Promise<Tool[]> {
    if (forceRefresh || entry.toolsDirty) {
      const fresh = filterComposioTools(record, await entry.client.listTools({ signal, timeoutMs: 20_000 }));
      entry.tools = fresh;
      entry.toolsDirty = false;
      await this.#options.onDiscoveryUpdated(entry.connectionId, entry.revision, {
        ...(entry.serverName ? { serverName: entry.serverName } : {}),
        tools: summarizeMcpTools(fresh, this.#options.redact),
        updatedAt: Date.now(),
      });
    }
    return entry.tools;
  }

  /** Lightweight one-shot probe (openGetStream: false) for connection test & post-OAuth discovery. */
  async test(
    record: ConnectionRecordView,
    secrets: ConnectionSecrets,
    binding: string,
    signal?: AbortSignal,
  ): Promise<McpDiscoverySnapshot> {
    if (this.#closed) {
      throw Object.assign(new Error("连接池已关闭。"), { code: "connection_manager_closed", status: 503 });
    }
    let current = record;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const entry = await this.#openEntry(current, secrets, binding, false, signal);
        const snapshot: McpDiscoverySnapshot = {
          ...(entry.serverName ? { serverName: entry.serverName } : {}),
          tools: summarizeMcpTools(entry.tools, this.#options.redact),
          updatedAt: Date.now(),
        };
        await this.#closeEntry(entry);
        return snapshot;
      } catch (error) {
        if (attempt === 0 && current.mcpPresetId === COMPOSIO_PRESET_ID && isComposioSessionMissingError(error) && this.#options.onComposioSessionExpired) {
          const refreshed = await this.#options.onComposioSessionExpired(current.id, binding, signal, current.mcpComposioSessionId);
          if (refreshed) {
            current = refreshed;
            continue;
          }
        }
        throw error;
      }
    }
    throw Object.assign(new Error("MCP 连接测试失败。"), { code: "connection_mcp_execution_failed", status: 502 });
  }

  async execute(
    record: ConnectionRecordView,
    secrets: ConnectionSecrets,
    binding: string,
    operation: McpOperation,
    options: { readOnly?: boolean; signal?: AbortSignal; onOutwardAction?: (label: string) => void | Promise<void> } = {},
  ): Promise<McpExecuteResult> {
    const composioPolicy = evaluateComposioCall(record, operation, { readOnly: options.readOnly });
    let current = record;
    let outwardRecorded = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const entry = await this.#getOrConnect(current, secrets, binding, options.signal);
        this.#touchIdle(entry);

        if (operation.action === "list_tools") {
          const allTools = await this.#ensureFreshTools(current, entry, operation.refresh === true, options.signal);
          // Per MCP Apps 2026-01-26, hide app-only tools (`visibility: ["app"]`) from the model.
          const tools = allTools.filter((tool) => isMcpToolVisibleToModel(tool._meta));
          const query = operation.query?.trim().toLowerCase() ?? "";
          const limit = Math.max(1, Math.min(30, operation.limit ?? 20));
          const matched = query
            ? tools.filter((t) => {
                const hay = `${t.name} ${t.title ?? ""} ${t.description ?? ""}`.toLowerCase();
                return hay.includes(query);
              })
            : tools;

          const outTools: Array<Record<string, unknown>> = [];
          let approxBytes = 256;
          for (const tool of matched.slice(0, limit)) {
            const ui = current.mcpAppsEnabled === true && !isMcpAggregatorConnection(current)
              ? extractMcpToolUiMeta(tool._meta)
              : undefined;
            const item = {
              name: tool.name,
              ...(tool.title ? { title: this.#options.redact(tool.title).slice(0, 120) } : {}),
              ...(tool.description ? { description: this.#options.redact(tool.description).slice(0, MAX_TOOL_DESCRIPTION_CHARS) } : {}),
              readOnly: isMcpToolReadOnly(tool),
              ...(tool.annotations?.destructiveHint === true ? { destructive: true } : {}),
              ...(ui?.resourceUri ? { uiResourceUri: this.#options.redact(ui.resourceUri).slice(0, 256) } : {}),
              inputSchema: normalizeMcpInputSchema(tool.inputSchema),
            };
            const serialized = this.#options.redact(JSON.stringify(item));
            if (approxBytes + Buffer.byteLength(serialized, "utf8") > MAX_LIST_TOOLS_BYTES) break;
            approxBytes += Buffer.byteLength(serialized, "utf8");
            outTools.push(JSON.parse(serialized) as Record<string, unknown>);
          }
          return {
            kind: "mcp",
            output: JSON.stringify({
              untrustedData: true,
              connectionId: current.id,
              total: tools.length,
              matched: matched.length,
              returned: outTools.length,
              tools: outTools,
            }),
          };
        }

        // call_tool: verify tool against current live tool list (re-fetching if dirtied by list_changed)
        const tools = await this.#ensureFreshTools(current, entry, false, options.signal);
        const target = tools.find((item) => item.name === operation.tool);
        if (!target) {
          throw Object.assign(new Error(`此 MCP 服务未提供名为「${operation.tool}」的工具。`), {
            code: "connection_mcp_tool_not_found",
            status: 400,
          });
        }
        if (!isMcpToolVisibleToModel(target._meta)) {
          throw Object.assign(new Error("此 MCP 工具仅限应用视图调用，模型不可直接调用。"), {
            code: "connection_mcp_tool_app_only",
            status: 403,
          });
        }
        if (options.readOnly && !isMcpToolReadOnly(target)) {
          throw Object.assign(new Error("只读任务不能调用非只读 MCP 工具（工具未明确声明 readOnlyHint=true 且非破坏性）。"), {
            code: "connection_read_only",
            status: 403,
          });
        }
        if (!outwardRecorded) {
          if (composioPolicy.forceOutwardLabel) {
            outwardRecorded = true;
            await options.onOutwardAction?.(composioPolicy.forceOutwardLabel);
          } else if (!composioPolicy.skipOutwardAction && !isMcpToolReadOnly(target)) {
            outwardRecorded = true;
            await options.onOutwardAction?.(`mcp:${current.name}:${operation.tool}`);
          }
        }

        const rawResult = await entry.client.callTool(operation.tool, operation.arguments ?? {}, {
          signal: options.signal,
          timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        });
        this.#touchIdle(entry);

        const blocks = toLlmContent(rawResult);
        const sanitized = await sanitizeMcpCallContent(blocks, this.#options.redact);

        let mcpAppCapture: McpAppToolResultCapture | undefined;
        if (
          current.mcpAppsEnabled === true &&
          !isMcpAggregatorConnection(current) &&
          isHostApprovedReadOnlyMcpAppTool(target)
        ) {
          const uiMeta = extractMcpToolUiMeta(target._meta);
          if (uiMeta?.resourceUri) {
            const viewResult = await buildMcpAppViewToolResult(rawResult, this.#options.redact);
            mcpAppCapture = {
              connectionId: current.id,
              connectionName: this.#options.redact(current.name).slice(0, 120),
              connectionRevision: current.revision,
              toolName: target.name,
              ...(target.title ? { title: this.#options.redact(target.title).slice(0, 120) } : {}),
              resourceUri: this.#options.redact(uiMeta.resourceUri).slice(0, 512),
              viewResult,
              readOnly: true,
            };
          }
        }

        return {
          kind: "mcp",
          output: JSON.stringify({
            untrustedData: true,
            connectionId: current.id,
            tool: operation.tool,
            isError: rawResult.isError === true,
            content: sanitized,
          }),
          ...(mcpAppCapture ? { mcpAppCapture } : {}),
        };
      } catch (error) {
        if (attempt === 0 && current.mcpPresetId === COMPOSIO_PRESET_ID && isComposioSessionMissingError(error) && this.#options.onComposioSessionExpired) {
          await this.invalidate(current.id);
          const refreshed = await this.#options.onComposioSessionExpired(current.id, binding, options.signal, current.mcpComposioSessionId);
          if (refreshed) {
            current = refreshed;
            continue;
          }
        }
        this.#mapError(error);
      }
    }
    throw Object.assign(new Error("MCP 调用失败。"), { code: "connection_mcp_execution_failed", status: 502 });
  }

  /** Reads and validates a `ui://` `text/html;profile=mcp-app` resource (<= 2.5 MiB) for an enabled non-aggregator MCP connection. */
  async readAppResource(
    record: ConnectionRecordView,
    secrets: ConnectionSecrets,
    binding: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<McpAppReadResourceOutput> {
    if (record.mcpAppsEnabled !== true || isMcpAggregatorConnection(record)) {
      throw Object.assign(new Error("该连接未启用只读内联 MCP App。"), {
        code: "connection_mcp_apps_disabled",
        status: 403,
      });
    }
    if (!isValidMcpAppResourceUri(uri)) {
      throw Object.assign(new Error("无效的 MCP App 资源地址（仅允许 ui:// 协议）。"), {
        code: "connection_mcp_app_invalid_uri",
        status: 400,
      });
    }
    try {
      const entry = await this.#getOrConnect(record, secrets, binding, signal);
      this.#touchIdle(entry);
      const resource = await entry.client.readResource(uri, { signal, timeoutMs: DEFAULT_CALL_TIMEOUT_MS });
      this.#touchIdle(entry);
      return validateMcpAppResourceResult(uri, resource, this.#options.redact);
    } catch (error) {
      this.#mapError(error);
    }
  }

  /** Executes a read-only, app-visible MCP tool strictly within the same connection for an active MCP App View. */
  async callAppTool(
    record: ConnectionRecordView,
    secrets: ConnectionSecrets,
    binding: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpAppViewToolResult> {
    if (record.mcpAppsEnabled !== true || isMcpAggregatorConnection(record)) {
      throw Object.assign(new Error("该连接未启用只读内联 MCP App。"), {
        code: "connection_mcp_apps_disabled",
        status: 403,
      });
    }
    try {
      const entry = await this.#getOrConnect(record, secrets, binding, signal);
      this.#touchIdle(entry);
      const tools = await this.#ensureFreshTools(record, entry, false, signal);
      const target = tools.find((item) => item.name === toolName);
      if (!target) {
        throw Object.assign(new Error(`此 MCP 服务未提供名为「${toolName}」的工具。`), {
          code: "connection_mcp_tool_not_found",
          status: 404,
        });
      }
      if (!isMcpToolVisibleToApp(target._meta)) {
        throw Object.assign(new Error("此 MCP 工具仅供模型调用，禁止应用视图调用。"), {
          code: "connection_mcp_app_tool_visibility_denied",
          status: 403,
        });
      }
      if (!isHostApprovedReadOnlyMcpAppTool(target)) {
        throw Object.assign(new Error("MCP App 只读原型拒绝执行写操作或非只读工具。"), {
          code: "connection_mcp_app_write_forbidden",
          status: 403,
        });
      }
      const rawResult = await entry.client.callTool(toolName, args, {
        signal,
        timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
      });
      this.#touchIdle(entry);
      return await buildMcpAppViewToolResult(rawResult, this.#options.redact);
    } catch (error) {
      this.#mapError(error);
    }
  }

  async invalidate(connectionId: string): Promise<void> {
    const entry = this.#entries.get(connectionId);
    if (entry) await this.#closeEntry(entry);
    this.#challenges.delete(connectionId);
  }

  /** Invalidates active and in-flight Stdio MCP sessions when execution trust mode changes. */
  async invalidateStdioConnections(): Promise<void> {
    this.#stdioGeneration += 1;
    const stdioEntries = [...this.#entries.values()].filter((entry) => entry.isStdio);
    await Promise.all(stdioEntries.map((entry) => this.#closeEntry(entry)));
  }

  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    this.#connecting.clear();
    this.#challenges.clear();
    await Promise.all(entries.map((entry) => this.#closeEntry(entry)));
  }
}
