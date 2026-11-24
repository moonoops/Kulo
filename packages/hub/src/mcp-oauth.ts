import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  McpRefreshLockBusyError,
  MemoryOAuthStateStore,
  authorizeMcp,
  listenForLoopbackSignIn,
  parseWwwAuthenticate,
  responseFromRedirectUrl,
  stepUpScope,
  type McpLoopbackCallback,
  type McpOAuthServerStore,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthCallback,
  type OAuthCallbackPage,
  type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
import type { ConnectionRecordView, ExecutionTrustMode, McpOAuthSessionView } from "@kulo/protocol";
import type { ConnectionVault } from "./connections.js";
import { createMcpFetch, validateMcpTargetUrl } from "./mcp-fetch.js";
import { isNonPublicMcpUrl } from "./mcp-presets.js";

const OAUTH_FORMAT = "mcp-oauth-v1";
const REFRESH_SKEW_MS = 30_000;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const OAUTH_SESSION_TTL_MS = 5 * 60_000;
const REFRESH_LOCK_TIMEOUT_MS = 15_000;
const STALE_LOCK_MS = 60_000;

export function mcpOAuthVaultRef(connectionId: string): string {
  return `mcp-oauth:${connectionId}`;
}

export function extractMcpOAuthSecrets(state: McpOAuthState | undefined): string[] {
  if (!state) return [];
  const secrets: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) secrets.push(value);
  };
  push(state.tokens?.access_token);
  push(state.tokens?.refresh_token);
  push(state.tokens?.id_token);
  if (state.clientInformation) {
    push(state.clientInformation.client_secret);
    if ("registration_access_token" in state.clientInformation) {
      push(state.clientInformation.registration_access_token);
    }
  }
  return secrets;
}

export function parseMcpOAuthVaultEntry(
  fields: Record<string, string> | undefined,
  expectedBinding?: string,
): McpOAuthState | undefined {
  if (!fields || fields.format !== OAUTH_FORMAT || typeof fields.state !== "string") return undefined;
  if (expectedBinding !== undefined && fields.__binding !== expectedBinding) return undefined;
  try {
    const parsed = JSON.parse(fields.state) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (typeof (parsed as { serverUrl?: unknown }).serverUrl !== "string") return undefined;
    return parsed as McpOAuthState;
  } catch {
    return undefined;
  }
}

export function serializeMcpOAuthVaultEntry(binding: string, state: McpOAuthState): Record<string, string> {
  return {
    __binding: binding,
    format: OAUTH_FORMAT,
    state: JSON.stringify(state),
  };
}

/**
 * Per-connection refresh mutex (in-process queue + independent filesystem lock directory
 * under `<stateDir>/.secure/mcp-oauth-locks/`, never reusing `.connection-vault.lock`).
 */
export class McpOAuthRefreshLockManager {
  readonly #lockRoot: string;
  readonly #inProcess = new Map<string, Promise<void>>();

  constructor(stateDir: string) {
    this.#lockRoot = path.join(stateDir, ".secure", "mcp-oauth-locks");
  }

  async withLock<T>(connectionId: string, fn: () => Promise<T>, timeoutMs = REFRESH_LOCK_TIMEOUT_MS): Promise<T> {
    const prev = this.#inProcess.get(connectionId) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const tail = prev.then(() => gate);
    this.#inProcess.set(connectionId, tail);

    const deadline = Date.now() + timeoutMs;
    await Promise.race([
      prev,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new McpRefreshLockBusyError()), timeoutMs);
        t.unref();
      }),
    ]);

    let lockPath: string | undefined;
    try {
      const safeId = connectionId.replace(/[^A-Za-z0-9._-]/g, "_");
      fs.mkdirSync(this.#lockRoot, { recursive: true, mode: 0o700 });
      lockPath = path.join(this.#lockRoot, `${safeId}.lock`);
      while (true) {
        try {
          const fd = fs.openSync(lockPath, "wx", 0o600);
          try {
            fs.writeFileSync(fd, `${process.pid}:${Date.now()}\n`);
          } finally {
            fs.closeSync(fd);
          }
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "EEXIST") throw err;
          try {
            const st = fs.statSync(lockPath);
            if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
              fs.rmSync(lockPath, { force: true });
              continue;
            }
          } catch {
            continue;
          }
          if (Date.now() >= deadline) throw new McpRefreshLockBusyError();
          await new Promise<void>((r) => {
            const t = setTimeout(r, 40);
            t.unref();
          });
        }
      }
      return await fn();
    } finally {
      if (lockPath) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Best-effort lock cleanup
        }
      }
      releaseQueue();
      if (this.#inProcess.get(connectionId) === tail) this.#inProcess.delete(connectionId);
    }
  }
}

export interface VaultMcpOAuthStoreOptions {
  connectionId: string;
  serverUrl: string;
  expectedBinding: string;
  vault: ConnectionVault;
  locks: McpOAuthRefreshLockManager;
  getCurrentBinding: () => string | undefined;
  onSecrets: (values: readonly string[]) => void;
  onAuthorizedChange: (authorized: boolean) => void;
}

export function createVaultMcpOAuthStore(options: VaultMcpOAuthStoreOptions): McpOAuthServerStore {
  const ref = mcpOAuthVaultRef(options.connectionId);
  return {
    async load(): Promise<McpOAuthState | undefined> {
      if (options.getCurrentBinding() !== options.expectedBinding) return undefined;
      const fields = await options.vault.get(ref);
      const parsed = parseMcpOAuthVaultEntry(fields, options.expectedBinding);
      if (parsed) options.onSecrets(extractMcpOAuthSecrets(parsed));
      return parsed;
    },
    async save(state: McpOAuthState): Promise<void> {
      if (options.getCurrentBinding() !== options.expectedBinding) return;
      const secrets = extractMcpOAuthSecrets(state);
      if (secrets.length) options.onSecrets(secrets);
      await options.vault.set(ref, serializeMcpOAuthVaultEntry(options.expectedBinding, state));
      options.onAuthorizedChange(Boolean(state.tokens?.access_token));
    },
    withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
      return options.locks.withLock(options.connectionId, fn);
    },
  };
}

export interface KuloMcpAuthProvider extends AuthProvider {
  settled(): Promise<void>;
}

export interface CreateKuloMcpAuthProviderOptions {
  serverUrl: string;
  store: McpOAuthServerStore;
  clientName?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUrl?: string;
  fetch: McpFetch;
  onChallenge?: (challenge: OAuthChallenge) => void;
}

function buildProvider(options: {
  serverUrl: string;
  redirectUrl: string;
  store: McpOAuthStateStore;
  clientName?: string;
  clientId?: string;
  clientSecret?: string;
  onRedirect?: (url: URL) => void;
}): McpOAuthProvider {
  return new McpOAuthProvider({
    serverUrl: options.serverUrl,
    redirectUrl: options.redirectUrl,
    clientMetadata: {
      client_name: options.clientName || "Kulo",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: options.clientSecret ? "client_secret_basic" : "none",
    },
    ...(options.clientId ? { clientId: options.clientId } : {}),
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    store: options.store,
    onRedirect: (url) => {
      options.onRedirect?.(url);
    },
  });
}

function pickRefreshRedirectUrl(state: McpOAuthState | undefined, fallback?: string): string {
  const registered = state?.clientInformation && "redirect_uris" in state.clientInformation
    ? state.clientInformation.redirect_uris?.[0]
    : undefined;
  return registered || fallback || "http://127.0.0.1/callback";
}

/**
 * Custom AuthProvider built strictly on public `@earendil-works/pi-mcp/oauth` exports
 * (`McpOAuthProvider` + `authorizeMcp`), ensuring BOTH proactive expiry refresh AND 401 refresh
 * always go through our hardened `createMcpFetch` (with 15s per-request timeout + SSRF/redirect guards).
 */
export function createKuloMcpAuthProvider(options: CreateKuloMcpAuthProviderOptions): KuloMcpAuthProvider {
  let refreshing: Promise<void> | undefined;

  const refresh = (staleToken: string | undefined, challenge?: OAuthChallenge): Promise<void> => {
    refreshing ??= options.store
      .withRefreshLock(async () => {
        const state = await options.store.load();
        if (state?.tokens?.access_token !== staleToken) return;
        if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
        const provider = buildProvider({
          serverUrl: options.serverUrl,
          redirectUrl: pickRefreshRedirectUrl(state, options.redirectUrl),
          store: options.store,
          clientName: options.clientName,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
        });
        const outcome = await authorizeMcp(provider, {
          serverUrl: options.serverUrl,
          resourceMetadataUrl: challenge?.resourceMetadataUrl,
          fetch: options.fetch,
          refreshOnly: true,
        });
        if (outcome === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };

  return {
    token: async () => {
      await refreshing?.catch(() => undefined);
      const state = await options.store.load();
      const token = state?.tokens?.access_token;
      const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
      if (!expired || !state?.tokens?.refresh_token) return token;
      await refresh(token).catch(() => undefined);
      return (await options.store.load())?.tokens?.access_token;
    },
    onUnauthorized: async (context) => {
      const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
      options.onChallenge?.(challenge);
      if (challenge.error === "insufficient_scope") {
        throw new McpOAuthAuthorizationRequiredError();
      }
      await refresh(context.token, challenge);
    },
    settled: async () => {
      await refreshing?.catch(() => undefined);
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderCallbackPage(page: OAuthCallbackPage): string {
  const title = page.ok ? "授权已完成" : "授权未完成";
  const body = page.ok
    ? "已成功完成授权，可以关闭此标签页并返回 Kulo。"
    : `${escapeHtml(page.message)}${page.details ? `<p style="color:#666;font-size:13px">${escapeHtml(page.details)}</p>` : ""}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:460px;margin:18vh auto;padding:24px;text-align:center;color:#111;line-height:1.6}</style></head><body><h2>${title}</h2><p>${body}</p></body></html>`;
}

export interface McpOAuthSessionOwner {
  clientId?: string;
  principalId?: string;
}

export interface McpOAuthSessionHost {
  getRecord(connectionId: string): ConnectionRecordView | undefined;
  getBinding(connectionId: string): string | undefined;
  getClientSecret(connectionId: string): Promise<string | undefined>;
  getChallenge(connectionId: string): OAuthChallenge | undefined;
  clearChallenge(connectionId: string): void;
  vault: ConnectionVault;
  locks: McpOAuthRefreshLockManager;
  onSecrets(values: readonly string[]): void;
  onAuthorizedChange(connectionId: string, authorized: boolean): void;
  onCompletedProbe(connectionId: string, expectedRevision: number, signal?: AbortSignal): Promise<ConnectionRecordView | undefined>;
  redact(text: string): string;
  getExecutionTrustMode?: () => ExecutionTrustMode;
  baseFetch?: typeof fetch;
}

interface ActiveOAuthSession {
  sessionId: string;
  connectionId: string;
  owner: McpOAuthSessionOwner;
  expectedRevision: number;
  expectedBinding: string;
  serverUrl: string;
  allowPrivateNetwork: boolean;
  allowPrivateHttp: boolean;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUrl: string;
  authorizationUrl?: string;
  oauthState?: string;
  requestedScope?: string;
  challenge?: OAuthChallenge;
  staging: MemoryOAuthStateStore;
  callback?: McpLoopbackCallback;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  status: McpOAuthSessionView["status"];
  expiresAt: number;
  error?: string;
  connection?: ConnectionRecordView;
  exchanging?: Promise<void>;
}

/**
 * Manages interactive OAuth 2.1 sign-in sessions using an isolated in-memory staging store
 * so cancelling or timing out a re-authorization never wipes live Vault tokens.
 */
export class McpOAuthSessionManager {
  readonly #host: McpOAuthSessionHost;
  readonly #sessions = new Map<string, ActiveOAuthSession>();
  #closed = false;

  constructor(host: McpOAuthSessionHost) {
    this.#host = host;
  }

  #view(session: ActiveOAuthSession): McpOAuthSessionView {
    return {
      sessionId: session.sessionId,
      connectionId: session.connectionId,
      status: session.status,
      ...(session.authorizationUrl ? { authorizationUrl: session.authorizationUrl } : {}),
      ...(session.redirectUrl ? { redirectUrl: session.redirectUrl } : {}),
      expiresAt: session.expiresAt,
      ...(session.error ? { error: this.#host.redact(session.error) } : {}),
      ...(session.connection ? { connection: session.connection } : {}),
    };
  }

  #assertOwner(session: ActiveOAuthSession, owner: McpOAuthSessionOwner): void {
    if (session.owner.clientId && owner.clientId !== session.owner.clientId) {
      throw Object.assign(new Error("请在发起授权的原窗口继续操作。"), { code: "connection_oauth_forbidden", status: 403 });
    }
    if (session.owner.principalId && owner.principalId !== session.owner.principalId) {
      throw Object.assign(new Error("无权访问此授权会话。"), { code: "connection_oauth_forbidden", status: 403 });
    }
  }

  async #commitStaging(session: ActiveOAuthSession): Promise<ConnectionRecordView | undefined> {
    const nextState = session.staging.load();
    if (!nextState?.tokens?.access_token) {
      throw Object.assign(new Error("授权服务器未返回有效访问令牌。"), { code: "connection_oauth_failed", status: 502 });
    }
    const secrets = extractMcpOAuthSecrets(nextState);
    if (secrets.length) this.#host.onSecrets(secrets);

    await this.#host.locks.withLock(session.connectionId, async () => {
      const liveBinding = this.#host.getBinding(session.connectionId);
      if (liveBinding !== session.expectedBinding) {
        throw Object.assign(new Error("连接配置已在授权期间发生变化，请重新发起授权。"), { code: "connection_conflict", status: 409 });
      }
      await this.#host.vault.set(
        mcpOAuthVaultRef(session.connectionId),
        serializeMcpOAuthVaultEntry(session.expectedBinding, nextState),
      );
      this.#host.onAuthorizedChange(session.connectionId, true);
      this.#host.clearChallenge(session.connectionId);
    });

    return this.#host.onCompletedProbe(session.connectionId, session.expectedRevision, session.abort.signal);
  }

  async #finishWithCallback(session: ActiveOAuthSession, response: OAuthCallback): Promise<void> {
    if (session.status !== "pending") return;
    if (session.exchanging) {
      await session.exchanging;
      return;
    }
    session.exchanging = (async () => {
      try {
        if (response.state !== session.oauthState) {
          throw new Error("授权回调 state 不匹配，请重新发起授权。");
        }
        const oauthFetch = createMcpFetch({
          allowPrivateNetwork: session.allowPrivateNetwork,
          allowPrivateHttp: session.allowPrivateHttp,
          timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
          baseFetch: this.#host.baseFetch,
        });
        const provider = buildProvider({
          serverUrl: session.serverUrl,
          redirectUrl: session.redirectUrl,
          store: session.staging,
          clientId: session.clientId,
          clientSecret: session.clientSecret,
        });
        await authorizeMcp(provider, {
          serverUrl: session.serverUrl,
          resourceMetadataUrl: session.challenge?.resourceMetadataUrl,
          scope: session.requestedScope,
          authorizationRedirectUrl: session.redirectUrl,
          authorizationCode: response.code,
          iss: response.iss,
          fetch: oauthFetch,
          signal: session.abort.signal,
        });
        session.connection = await this.#commitStaging(session);
        session.status = "completed";
        session.error = undefined;
      } catch (err) {
        if (session.status === "cancelled") return;
        session.status = "failed";
        session.error = this.#host.redact(err instanceof Error ? err.message : "OAuth 授权失败。");
      } finally {
        clearTimeout(session.timer);
        const cb = session.callback;
        session.callback = undefined;
        await cb?.callback.close().catch(() => undefined);
      }
    })();
    await session.exchanging;
  }

  async start(input: {
    connectionId: string;
    owner: McpOAuthSessionOwner;
    forceReauth?: boolean;
  }): Promise<McpOAuthSessionView> {
    if (this.#closed) {
      throw Object.assign(new Error("授权服务已关闭。"), { code: "connection_manager_closed", status: 503 });
    }
    const record = this.#host.getRecord(input.connectionId);
    if (!record) {
      throw Object.assign(new Error("连接不存在。"), { code: "connection_not_found", status: 404 });
    }
    if (record.kind !== "mcp" || record.mcpTransport !== "http" || record.mcpAuthMode !== "oauth" || !record.url) {
      throw Object.assign(new Error("此连接不支持 OAuth 授权。"), { code: "connection_oauth_unsupported", status: 400 });
    }
    const expectedBinding = this.#host.getBinding(record.id);
    if (!expectedBinding) {
      throw Object.assign(new Error("连接不存在。"), { code: "connection_not_found", status: 404 });
    }

    // Cancel any existing pending session for the same connection first.
    await this.cancelForConnection(record.id);

    const allowPrivateHttp = this.#host.getExecutionTrustMode?.() === "trusted";
    const allowPrivateNetwork = allowPrivateHttp || isNonPublicMcpUrl(record.url);
    validateMcpTargetUrl(record.url, { allowPrivateNetwork, allowPrivateHttp });

    const clientSecret = await this.#host.getClientSecret(record.id);
    const existingEntry = await this.#host.vault.get(mcpOAuthVaultRef(record.id));
    const existingState = parseMcpOAuthVaultEntry(existingEntry, expectedBinding);
    const staging = new MemoryOAuthStateStore();
    if (existingState) staging.save(structuredClone(existingState));

    const challenge = this.#host.getChallenge(record.id);
    const stepUp = challenge?.error === "insufficient_scope";
    const oauthFetch = createMcpFetch({
      allowPrivateNetwork,
      allowPrivateHttp,
      timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
      baseFetch: this.#host.baseFetch,
    });

    const sessionId = `mcp-oauth-session-${randomUUID()}`;
    const abort = new AbortController();
    const expiresAt = Date.now() + OAUTH_SESSION_TTL_MS;

    // 1. Try silent refresh first unless forceReauth or step-up scope is required.
    if (!input.forceReauth && !stepUp && existingState?.tokens?.refresh_token) {
      try {
        const refreshProvider = buildProvider({
          serverUrl: record.url,
          redirectUrl: pickRefreshRedirectUrl(existingState),
          store: staging,
          clientId: record.mcpOAuthClientId,
          clientSecret,
        });
        const outcome = await authorizeMcp(refreshProvider, {
          serverUrl: record.url,
          resourceMetadataUrl: challenge?.resourceMetadataUrl,
          fetch: oauthFetch,
          refreshOnly: true,
          signal: abort.signal,
        });
        if (outcome === "AUTHORIZED") {
          const tempSession: ActiveOAuthSession = {
            sessionId,
            connectionId: record.id,
            owner: input.owner,
            expectedRevision: record.revision,
            expectedBinding,
            serverUrl: record.url,
            allowPrivateNetwork,
            allowPrivateHttp,
            clientId: record.mcpOAuthClientId,
            clientSecret,
            redirectUrl: pickRefreshRedirectUrl(existingState),
            staging,
            abort,
            timer: setTimeout(() => {}, 0),
            status: "authorized",
            expiresAt,
          };
          clearTimeout(tempSession.timer);
          tempSession.connection = await this.#commitStaging(tempSession);
          return this.#view(tempSession);
        }
      } catch {
        // Fall through to interactive browser sign-in without mutating live Vault state.
      }
    }

    // 2. Start loopback callback server on 127.0.0.1
    const loopback = await listenForLoopbackSignIn({
      serverUrl: record.url,
      store: staging,
      settings: {
        ...(record.mcpOAuthCallbackPort ? { callbackPort: record.mcpOAuthCallbackPort } : {}),
        ...(record.mcpOAuthClientId ? { clientId: record.mcpOAuthClientId } : {}),
      },
      renderPage: renderCallbackPage,
    });

    try {
      // Drop incompatible DCR client only in staging store (live Vault untouched!)
      const staged = staging.load();
      if (staged) {
        const next: McpOAuthState = { ...staged };
        delete next.oauthState;
        const registered =
          next.clientInformation && "redirect_uris" in next.clientInformation
            ? next.clientInformation.redirect_uris
            : undefined;
        const keepClient = Boolean(record.mcpOAuthClientId) || Boolean(registered?.includes(loopback.redirectUrl));
        if (!keepClient) {
          delete next.clientInformation;
          delete next.tokens;
          delete next.tokensExpireAt;
        }
        staging.save(next);
      }

      let authorizationUrl: URL | undefined;
      const provider = buildProvider({
        serverUrl: record.url,
        redirectUrl: loopback.redirectUrl,
        store: staging,
        clientId: record.mcpOAuthClientId,
        clientSecret,
        onRedirect: (url) => {
          authorizationUrl = url;
        },
      });

      const mergedScopes = [
        ...(record.mcpOAuthScope?.split(/\s+/).filter(Boolean) ?? []),
        ...((stepUp ? stepUpScope(existingState?.tokens?.scope, challenge?.scope) : challenge?.scope)?.split(/\s+/).filter(Boolean) ?? []),
      ];
      const scope = mergedScopes.length > 0 ? [...new Set(mergedScopes)].join(" ") : undefined;

      await authorizeMcp(provider, {
        serverUrl: record.url,
        resourceMetadataUrl: challenge?.resourceMetadataUrl,
        scope,
        skipRefresh: true,
        fetch: oauthFetch,
        signal: abort.signal,
      });

      if (!authorizationUrl) {
        throw Object.assign(new Error("授权服务器未返回登录地址。"), { code: "connection_oauth_failed", status: 502 });
      }
      validateMcpTargetUrl(authorizationUrl, { allowPrivateNetwork, allowPrivateHttp });
      const oauthState = await provider.state();
      const requestedScope = authorizationUrl.searchParams.get("scope") ?? scope;

      const timer = setTimeout(() => {
        const active = this.#sessions.get(sessionId);
        if (!active || active.status !== "pending") return;
        active.status = "failed";
        active.error = "授权已超时，请重新发起登录。";
        active.abort.abort();
        const cb = active.callback;
        active.callback = undefined;
        void cb?.callback.close().catch(() => undefined);
      }, OAUTH_SESSION_TTL_MS);
      timer.unref();

      const session: ActiveOAuthSession = {
        sessionId,
        connectionId: record.id,
        owner: input.owner,
        expectedRevision: record.revision,
        expectedBinding,
        serverUrl: record.url,
        allowPrivateNetwork,
        allowPrivateHttp,
        clientId: record.mcpOAuthClientId,
        clientSecret,
        scope,
        redirectUrl: loopback.redirectUrl,
        authorizationUrl: authorizationUrl.href,
        oauthState,
        requestedScope,
        challenge,
        staging,
        callback: loopback,
        abort,
        timer,
        status: "pending",
        expiresAt,
      };
      this.#sessions.set(sessionId, session);

      // Background listener for automatic local loopback callback
      void loopback.callback
        .waitForCallback(oauthState)
        .then((response) => this.#finishWithCallback(session, response))
        .catch((err: unknown) => {
          if (session.status !== "pending") return;
          session.status = "failed";
          session.error = this.#host.redact(err instanceof Error ? err.message : "OAuth 回调失败。");
          clearTimeout(session.timer);
          const cb = session.callback;
          session.callback = undefined;
          void cb?.callback.close().catch(() => undefined);
        });

      return this.#view(session);
    } catch (err) {
      await loopback.callback.close().catch(() => undefined);
      throw err;
    }
  }

  get(sessionId: string, owner: McpOAuthSessionOwner): McpOAuthSessionView {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error("授权会话不存在或已过期。"), { code: "connection_oauth_not_found", status: 404 });
    }
    this.#assertOwner(session, owner);
    return this.#view(session);
  }

  async complete(sessionId: string, owner: McpOAuthSessionOwner, pastedRedirectUrl: string): Promise<McpOAuthSessionView> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error("授权会话不存在或已过期。"), { code: "connection_oauth_not_found", status: 404 });
    }
    this.#assertOwner(session, owner);
    if (session.status === "completed" || session.status === "authorized") return this.#view(session);
    if (session.status !== "pending" || !session.oauthState) {
      throw Object.assign(new Error("此授权会话已结束，请重新发起。"), { code: "connection_oauth_ended", status: 409 });
    }
    const response = responseFromRedirectUrl(pastedRedirectUrl, {
      state: session.oauthState,
      redirectUrl: session.redirectUrl,
    });
    await this.#finishWithCallback(session, response);
    return this.#view(session);
  }

  async cancel(sessionId: string, owner: McpOAuthSessionOwner): Promise<McpOAuthSessionView> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error("授权会话不存在或已过期。"), { code: "connection_oauth_not_found", status: 404 });
    }
    this.#assertOwner(session, owner);
    if (session.status === "pending") {
      session.status = "cancelled";
      session.abort.abort();
      clearTimeout(session.timer);
      const cb = session.callback;
      session.callback = undefined;
      await cb?.callback.close().catch(() => undefined);
    }
    return this.#view(session);
  }

  async cancelForConnection(connectionId: string): Promise<void> {
    const targets = [...this.#sessions.values()].filter((s) => s.connectionId === connectionId);
    for (const session of targets) {
      if (session.status === "pending") {
        session.status = "cancelled";
        session.abort.abort();
      }
      clearTimeout(session.timer);
      const cb = session.callback;
      session.callback = undefined;
      await cb?.callback.close().catch(() => undefined);
      this.#sessions.delete(session.sessionId);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const all = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(
      all.map(async (session) => {
        if (session.status === "pending") session.status = "cancelled";
        session.abort.abort();
        clearTimeout(session.timer);
        const cb = session.callback;
        session.callback = undefined;
        await cb?.callback.close().catch(() => undefined);
      }),
    );
  }
}
