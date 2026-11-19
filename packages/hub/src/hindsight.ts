/**
 * Official Hindsight Dual-Bank Memory Client & Access Guard for Kulo.
 *
 * Role & Bank Isolation Rules:
 * - Root Kulo Orchestrator (`role: "router"`):
 *   - `private` bank (default `kulo-core`): READ + WRITE
 *   - `shared` bank (default `kulo-shared`): READ-ONLY (never writes `shared` to prevent private persona leakage)
 * - Background Worker (`role: "worker"`):
 *   - `private` bank: STRICTLY FORBIDDEN (neither read nor write)
 *   - `shared` bank: READ + WRITE (stamped with `application:kulo`, `ticket:<ticketId>`, `role:<workerRole>`)
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createClient, sdk, type RecallRequest, type ReflectRequest, type RetainRequest } from "@vectorize-io/hindsight-client";
import type {
  HindsightEndpointStatus,
  HindsightMemoryConfig,
  HindsightProbeResult,
  MemoryBank,
} from "@kulo/protocol";

export const OFFICIAL_HINDSIGHT_TOOLS = [
  "hindsight_retain",
  "hindsight_recall",
  "hindsight_reflect",
  "hindsight_list_mental_models",
  "hindsight_get_mental_model",
  "hindsight_create_mental_model",
  "hindsight_refresh_mental_model",
  "hindsight_get_page_tree",
  "hindsight_search_pages",
  "hindsight_get_page",
  "hindsight_create_page",
  "hindsight_update_page_node",
  "hindsight_invalidate_memory",
  "hindsight_get_operation",
  // Replay / compatibility aliases:
  "hindsight_search_knowledge_pages",
  "hindsight_list_knowledge_pages",
  "hindsight_read_knowledge_page",
  "hindsight_capture_initiative",
  "hindsight_ingest_document",
] as const;

export type OfficialHindsightToolName = (typeof OFFICIAL_HINDSIGHT_TOOLS)[number];

export interface MemoryCallerContext {
  role: "router" | "worker";
  conversationId: string;
  ticketId?: string;
  workerRole?: string;
  projectId?: string;
  runEpoch?: number;
  /** Stable tool/event identity supplied by Pi, never by the model. */
  sourceId?: string;
  sourceTimestamp?: number;
  /** Checks whether a ticketId exists on Kulo's table (used when Router scopes recall to a ticket). */
  isValidTicket?: (ticketId: string) => boolean;
}

export type HindsightDiagnosticCode =
  | "DISABLED"
  | "FORBIDDEN"
  | "INVALID_ARGUMENTS"
  | "UNSAFE_CONTENT"
  | "ABORTED"
  | "TIMEOUT"
  | "AUTH"
  | "ISOLATION_UNVERIFIED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "UPSTREAM"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE";

export interface HindsightDiagnostic {
  code: HindsightDiagnosticCode;
  stage: "configuration" | "authorization" | "validation" | "request" | "response";
  status?: number;
  retryable: boolean;
}

export class HindsightAccessError extends Error {
  constructor(readonly diagnostic: HindsightDiagnostic) {
    super(`Hindsight ${diagnostic.code}`);
    this.name = "HindsightAccessError";
  }
}

function makeError(
  code: HindsightDiagnosticCode,
  stage: HindsightDiagnostic["stage"],
  status?: number,
): HindsightAccessError {
  return new HindsightAccessError({
    code,
    stage,
    ...(status !== undefined ? { status } : {}),
    retryable:
      code === "TIMEOUT" ||
      code === "RATE_LIMITED" ||
      code === "UNAVAILABLE" ||
      (code === "UPSTREAM" && status !== undefined && status >= 500),
  });
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/i,
];

/** Rejects accidental API keys, private keys, or NUL bytes from entering Hindsight memory. */
export function isSafeMemoryText(text: string): boolean {
  if (text.includes("\0")) return false;
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(text)) return false;
  }
  return true;
}

/** Resolves Hindsight tenant bearer token from inline config, env var, or restricted authFile. */
export function resolveHindsightToken(config: HindsightMemoryConfig, role: "router" | "worker"): string | undefined {
  const disabled = role === "router" ? config.routerApiKeyDisabled : config.workerApiKeyDisabled;
  if (disabled) return undefined;
  const envName = role === "router" ? config.routerApiKeyEnv : config.workerApiKeyEnv;
  let token = (role === "router" ? config.routerApiKey : config.workerApiKey)?.trim() ||
    (envName ? process.env[envName]?.trim() : undefined);

  if (!token && config.authFile?.trim()) {
    try {
      const resolved = path.resolve(config.authFile.trim());
      const content = fs.readFileSync(resolved, "utf8");
      const keyName = envName || (role === "router" ? "KULO_HINDSIGHT_ROUTER_API_KEY" : "KULO_HINDSIGHT_WORKER_API_KEY");
      const matchLine = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith(`${keyName}=`));
      if (matchLine) {
        let val = matchLine.slice(keyName.length + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        token = val || undefined;
      }
    } catch {
      // Fall through if authFile unreadable
    }
  }

  if (token && (!/^[\x21-\x7e]{32,8192}$/.test(token))) {
    return undefined;
  }
  return token || undefined;
}

export function resolveHindsightSharedReadToken(config: HindsightMemoryConfig): string | undefined {
  if (config.sharedReadApiKeyDisabled) return undefined;
  const token = config.sharedReadApiKey?.trim() || (config.sharedReadApiKeyEnv ? process.env[config.sharedReadApiKeyEnv]?.trim() : undefined);
  return token && /^[\x21-\x7e]{32,8192}$/.test(token) ? token : undefined;
}

export function orderedHindsightEndpoints(config: HindsightMemoryConfig): string[] {
  const list = [
    config.endpoint.trim(),
    ...config.endpoints.map((e) => e.trim()).filter(Boolean),
  ].filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of list) {
    const clean = raw.replace(/\/+$/, "");
    if (!seen.has(clean)) {
      seen.add(clean);
      unique.push(clean);
    }
  }
  return unique.length > 0 ? unique : ["http://127.0.0.1:8888"];
}

export function enforceBankAuthorization(
  config: HindsightMemoryConfig,
  caller: MemoryCallerContext,
  bank: MemoryBank,
  write: boolean,
): string {
  if (!config.enabled) {
    throw makeError("DISABLED", "configuration");
  }
  if (config.accessMode === "private-only" && (caller.role !== "router" || bank !== "private")) {
    throw makeError("FORBIDDEN", "authorization");
  }
  const priv = config.banks.private.trim();
  const shared = config.banks.shared.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(priv) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(shared) || priv.toLowerCase() === shared.toLowerCase()) {
    throw makeError("FORBIDDEN", "configuration");
  }

  if (caller.role === "worker") {
    if (bank !== "shared" || !caller.ticketId) {
      throw makeError("FORBIDDEN", "authorization");
    }
    return shared;
  }

  // Router: private read/write, shared read-only
  if (bank === "shared" && write) {
    throw makeError("FORBIDDEN", "authorization");
  }
  return bank === "private" ? priv : shared;
}

const CREDIT_REMINDER =
  'When recalled memory informs your answer, cite its source in the active conversation language (e.g. "> 🧠 **From Hindsight Memory (<page or topic>)** — <key fact>"); ignore irrelevant items silently. Historical memory is not live source-code truth—verify implementation details against current files.';

export function documentIdForTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /[^\x00-\x7f]/.test(title) || !slug
    ? `${slug || "doc"}--${createHash("sha256").update(title).digest("hex")}`
    : slug;
}

interface KnowledgeNode {
  id: string;
  kind: "folder" | "page";
  name: string;
  description?: string;
  children?: KnowledgeNode[];
}

interface MemoryAccessPolicy {
  policyVersion: number;
  role: "router" | "worker";
  banks: {
    private: { id: string; read: boolean; write: boolean };
    shared: { id: string; read: boolean; write: boolean };
  };
}

function memoryToken(config: HindsightMemoryConfig, role: "router" | "worker", bank?: MemoryBank): string {
  const router = resolveHindsightToken(config, "router");
  const worker = resolveHindsightToken(config, "worker");
  if (config.accessMode === "private-only") {
    if (role !== "router" || bank === "shared" || !router) throw makeError("AUTH", "configuration");
    return router;
  }
  if (!router || !worker || router === worker) throw makeError("AUTH", "configuration");
  if (config.accessMode === "scoped" && role === "router" && bank === "shared") {
    const read = resolveHindsightSharedReadToken(config);
    if (!read || read === worker || read === router) throw makeError("AUTH", "configuration");
    return read;
  }
  return role === "router" ? router : worker;
}

async function fetchMemoryResponse(params: {
  endpoint: string;
  token: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  pathSuffix: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Response> {
  let parsed: URL;
  try { parsed = new URL(params.endpoint); } catch { throw makeError("INVALID_ARGUMENTS", "configuration"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw makeError("INVALID_ARGUMENTS", "configuration");
  }
  if (params.signal?.aborted) throw makeError("ABORTED", "request");
  const timeout = AbortSignal.timeout(params.timeoutMs ?? 15_000);
  try {
    return await fetch(`${params.endpoint}${params.pathSuffix}`, {
      method: params.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "kulo-hindsight/0.3.0",
        Authorization: `Bearer ${params.token}`,
      },
      ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
      signal: params.signal ? AbortSignal.any([params.signal, timeout]) : timeout,
      redirect: "error",
    });
  } catch (error) {
    if (params.signal?.aborted) throw makeError("ABORTED", "request");
    if (timeout.aborted) throw makeError("TIMEOUT", "request");
    throw makeError("UNAVAILABLE", "request");
  }
}

async function responseJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try { return await response.json(); } catch (error) {
    if (signal?.aborted) throw makeError("ABORTED", "response");
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw makeError("TIMEOUT", "response");
    }
    throw makeError("INVALID_RESPONSE", "response", response.status);
  }
}

function checkStatus(response: Response): void {
  if (response.status === 401 || response.status === 403) throw makeError("AUTH", "response", response.status);
  if (response.status === 429) throw makeError("RATE_LIMITED", "response", 429);
  if (!response.ok) throw makeError(response.status === 404 ? "NOT_FOUND" : "UPSTREAM", "response", response.status);
}

function checkPolicyAvailability(response: Response): void {
  // An outage during a permission check is not evidence of a bad policy. Read-only
  // requests may try another endpoint, which must independently prove its policy.
  if (response.status === 429 || response.status >= 500) checkStatus(response);
}

async function verifyIdentityPolicy(
  config: HindsightMemoryConfig,
  endpoint: string,
  role: "router" | "worker",
  signal?: AbortSignal,
): Promise<void> {
  if (config.accessMode === "private-only") {
    if (role !== "router") throw makeError("FORBIDDEN", "authorization");
    const suffix = `/v1/default/banks/${encodeURIComponent(config.banks.private)}/documents?limit=1`;
    const allowed = await fetchMemoryResponse({ endpoint, token: memoryToken(config, "router"), pathSuffix: suffix, signal, timeoutMs: 5_000 });
    if (!allowed.ok && allowed.status !== 404) checkStatus(allowed);
    await allowed.body?.cancel();
    const anonymous = await fetchMemoryResponse({ endpoint, token: "kulo-invalid-memory-credential-00000000", pathSuffix: suffix, signal, timeoutMs: 5_000 });
    await anonymous.body?.cancel();
    checkPolicyAvailability(anonymous);
    if (![401, 403].includes(anonymous.status)) throw makeError("ISOLATION_UNVERIFIED", "authorization", anonymous.status);
    return;
  }
  if (config.accessMode === "scoped") {
    // Native scoped credentials must prove the same bank/operation boundary as the Kulo extension.
    const checks = role === "worker"
      ? [{ token: memoryToken(config, "worker"), bank: config.banks.shared, status: "allowed" },
          { token: memoryToken(config, "worker"), bank: config.banks.private, status: "denied" }]
      : [{ token: memoryToken(config, "router", "private"), bank: config.banks.private, status: "allowed" },
          { token: memoryToken(config, "router", "private"), bank: config.banks.shared, status: "denied" },
          { token: memoryToken(config, "router", "shared"), bank: config.banks.shared, status: "allowed" },
          { token: memoryToken(config, "router", "shared"), bank: config.banks.private, status: "denied" }];
    for (const check of checks) {
      const response = await fetchMemoryResponse({ endpoint, token: check.token, pathSuffix: `/v1/default/banks/${encodeURIComponent(check.bank)}/documents?limit=1`, signal, timeoutMs: 5_000 });
      await response.body?.cancel();
      checkPolicyAvailability(response);
      if (check.status === "denied" ? response.status !== 403 : !response.ok && response.status !== 404) {
        throw makeError("ISOLATION_UNVERIFIED", "authorization", response.status);
      }
    }
    const denied = await fetchMemoryResponse({ endpoint, token: memoryToken(config, role, "shared"), method: "POST",
      pathSuffix: `/v1/default/banks/${encodeURIComponent(role === "router" ? config.banks.shared : config.banks.private)}/memories`, body: {}, signal, timeoutMs: 5_000 });
    await denied.body?.cancel();
    checkPolicyAvailability(denied);
    if (denied.status !== 403) throw makeError("ISOLATION_UNVERIFIED", "authorization", denied.status);
    return;
  }
  const token = memoryToken(config, role);
  const access = await fetchMemoryResponse({ endpoint, token, pathSuffix: "/v1/kulo/access", signal, timeoutMs: 5_000 });
  if (!access.ok) {
    await access.body?.cancel();
    checkPolicyAvailability(access);
    if (access.status === 401 || access.status === 403) throw makeError("AUTH", "authorization", access.status);
    throw makeError("ISOLATION_UNVERIFIED", "authorization", access.status);
  }
  const policy = await responseJson(access, signal) as Partial<MemoryAccessPolicy> | null;
  const priv = policy?.banks?.private;
  const shared = policy?.banks?.shared;
  const isRouter = role === "router";
  if (policy?.policyVersion !== 1 || policy.role !== role ||
      priv?.id !== config.banks.private.trim() || shared?.id !== config.banks.shared.trim() ||
      priv.read !== isRouter || priv.write !== isRouter || shared.read !== true || shared.write !== !isRouter) {
    throw makeError("ISOLATION_UNVERIFIED", "authorization");
  }
  // A policy description alone is insufficient: exercise the forbidden upstream operation.
  const rejected = await fetchMemoryResponse({
    endpoint, token, signal, timeoutMs: 5_000,
    method: isRouter ? "POST" : "GET",
    pathSuffix: isRouter
      ? `/v1/default/banks/${encodeURIComponent(config.banks.shared)}/memories`
      : `/v1/default/banks/${encodeURIComponent(config.banks.private)}/documents?limit=1`,
    ...(isRouter ? { body: {} } : {}),
  });
  await rejected.body?.cancel();
  checkPolicyAvailability(rejected);
  if (rejected.status !== 403) throw makeError("ISOLATION_UNVERIFIED", "authorization", rejected.status);
}

const verifiedPolicies = new Map<string, number>();

async function ensureIdentityPolicy(config: HindsightMemoryConfig, endpoint: string, role: "router" | "worker", signal?: AbortSignal): Promise<void> {
  const key = createHash("sha256").update(JSON.stringify([endpoint, role, memoryToken(config, role), resolveHindsightSharedReadToken(config), config.accessMode, config.banks])).digest("hex");
  if ((verifiedPolicies.get(key) ?? 0) > Date.now()) return;
  await verifyIdentityPolicy(config, endpoint, role, signal);
  if (verifiedPolicies.size >= 128) verifiedPolicies.clear();
  verifiedPolicies.set(key, Date.now() + 30_000);
}

async function fetchHindsightJson(params: {
  config: HindsightMemoryConfig;
  role: "router" | "worker";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  pathSuffix: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  tolerate404?: boolean;
}): Promise<{ status: number; data: unknown; endpoint: string }> {
  let lastError: HindsightAccessError | undefined;
  const readOnly = params.method === "GET" && !params.pathSuffix.includes("/operations/") ||
    params.method === "POST" && (params.pathSuffix.endsWith("/memories/recall") || params.pathSuffix.endsWith("/reflect"));
  // Matching bank names and ACLs do not prove that backup URLs share a database. Keep writes and
  // their receipts on the primary; only historical retrieval may use a validated alternate.
  const endpoints = orderedHindsightEndpoints(params.config);
  for (const endpoint of readOnly ? endpoints : endpoints.slice(0, 1)) {
    try {
      await ensureIdentityPolicy(params.config, endpoint, params.role, params.signal);
      const bank = params.pathSuffix.startsWith(`/v1/default/banks/${encodeURIComponent(params.config.banks.shared)}/`) ? "shared" : "private";
      const timeout = AbortSignal.timeout(params.timeoutMs ?? 15_000);
      const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
      const client = createClient({ baseUrl: endpoint, headers: { Authorization: `Bearer ${memoryToken(params.config, params.role, bank)}`, "Accept-Encoding": "identity", "User-Agent": "kulo-hindsight/0.4.0" },
        redirect: "error", signal, fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) });
      const bankId = bank === "shared" ? params.config.banks.shared : params.config.banks.private;
      let result: { response?: Response; data?: unknown };
      try {
        const url = new URL(params.pathSuffix, "http://kulo.invalid");
        const pageTags = url.searchParams.getAll("tags");
        const pageQuery = pageTags.length ? { tags: pageTags, tags_match: "all_strict" as const } : {};
        if (params.method === "POST" && params.pathSuffix.endsWith("/memories/recall")) {
          result = await sdk.recallMemories({ client, path: { bank_id: bankId }, body: params.body as RecallRequest, signal });
        } else if (params.method === "POST" && params.pathSuffix.endsWith("/memories")) {
          result = await sdk.retainMemories({ client, path: { bank_id: bankId }, body: params.body as RetainRequest, signal });
        } else if (params.method === "POST" && params.pathSuffix.endsWith("/reflect")) {
          result = await sdk.reflect({ client, path: { bank_id: bankId }, body: params.body as ReflectRequest, signal });
        } else if (params.method === "GET" && /\/operations\/[^/?]+$/.test(params.pathSuffix)) {
          result = await sdk.getOperationStatus({ client, path: { bank_id: bankId, operation_id: decodeURIComponent(params.pathSuffix.split("/").at(-1)!) }, signal });
        } else if (params.method === "GET" && url.pathname.endsWith("/knowledge-base/tree")) {
          result = await sdk.getKnowledgeBaseTree({ client, path: { bank_id: bankId }, query: pageQuery, signal });
        } else if (params.method === "GET" && url.pathname.endsWith("/knowledge-base/search")) {
          result = await sdk.searchKnowledgeBase({ client, path: { bank_id: bankId }, query: { q: url.searchParams.get("q") ?? "", limit: 3, ...pageQuery }, signal });
        } else if (params.method === "GET" && /\/knowledge-base\/pages\/[^/]+$/.test(url.pathname)) {
          result = await sdk.getKnowledgePage({ client, path: { bank_id: bankId, page_id: decodeURIComponent(url.pathname.split("/").at(-1)!) }, signal });
        } else if (params.method === "POST" && url.pathname.endsWith("/knowledge-base/folders")) {
          result = await sdk.createKnowledgeFolder({ client, path: { bank_id: bankId }, body: params.body as Parameters<typeof sdk.createKnowledgeFolder>[0]["body"], signal });
        } else if (params.method === "POST" && url.pathname.endsWith("/knowledge-base/pages")) {
          result = await sdk.createKnowledgePage({ client, path: { bank_id: bankId }, body: params.body as Parameters<typeof sdk.createKnowledgePage>[0]["body"], signal });
        } else {
          result = await client.request({ method: params.method, url: params.pathSuffix, ...(params.body !== undefined ? { body: params.body } : {}), signal });
        }
      } catch {
        if (params.signal?.aborted) throw makeError("ABORTED", "request");
        if (timeout.aborted) throw makeError("TIMEOUT", "request");
        throw makeError("UNAVAILABLE", "request");
      }
      const response = result.response;
      if (!response) throw makeError(timeout.aborted ? "TIMEOUT" : "UNAVAILABLE", "request");
      if (response.status === 404 && params.tolerate404) {
        await response.body?.cancel();
        return { status: 404, data: null, endpoint };
      }
      checkStatus(response);
      return { status: response.status, data: response.status === 204 ? {} : result.data, endpoint };
    } catch (error) {
      if (!(error instanceof HindsightAccessError)) throw error;
      if (!error.diagnostic.retryable) throw error;
      lastError = error;
    }
  }
  throw lastError ?? makeError("UNAVAILABLE", "request");
}

/** Tests both allowed access and actual denied operations for every configured endpoint. */
export async function probeHindsightConnection(config: HindsightMemoryConfig, signal?: AbortSignal): Promise<HindsightProbeResult> {
  const endpoints: HindsightEndpointStatus[] = [];
  let activeEndpoint: string | undefined;
  let version: string | undefined;
  for (const endpoint of orderedHindsightEndpoints(config)) {
    const startedAt = Date.now();
    try {
      memoryToken(config, "router");
      await verifyIdentityPolicy(config, endpoint, "router", signal);
      if (config.accessMode !== "private-only") await verifyIdentityPolicy(config, endpoint, "worker", signal);
      const reads = config.accessMode === "private-only" ? [["router", "private"]] as const : [["router", "private"], ["router", "shared"], ["worker", "shared"]] as const;
      for (const [role, bank] of reads) {
        const response = await fetchMemoryResponse({ endpoint, token: memoryToken(config, role, bank), pathSuffix: `/v1/default/banks/${encodeURIComponent(config.banks[bank])}/documents?limit=1`, signal, timeoutMs: 5_000 });
        // A missing authorized bank can be created on first write; it never proves a denial.
        if (!response.ok && response.status !== 404) checkStatus(response);
        await response.body?.cancel();
      }
      const response = await fetchMemoryResponse({ endpoint, token: memoryToken(config, "router"), pathSuffix: "/v1/version", signal, timeoutMs: 5_000 });
      checkStatus(response);
      const data = await responseJson(response, signal) as { api_version?: string; version?: string };
      const detected = data.api_version ?? data.version ?? "ok";
      endpoints.push({ endpoint, status: "healthy", version: detected, latencyMs: Date.now() - startedAt,
        isolationVerified: config.accessMode !== "private-only", ...(config.accessMode === "private-only" ? { detail: "主脑私库可用；Worker 共享记忆未启用" } : {}) });
      if (!activeEndpoint) { activeEndpoint = endpoint; version = detected; }
    } catch (error) {
      if (signal?.aborted) throw makeError("ABORTED", "request");
      const code = error instanceof HindsightAccessError ? error.diagnostic.code : "INVALID_RESPONSE";
      endpoints.push({ endpoint, status: "unavailable", latencyMs: Date.now() - startedAt, isolationVerified: false,
        detail: code === "ISOLATION_UNVERIFIED" ? "未通过主脑／Worker 服务端隔离检查" : `记忆检查失败 (${code})` });
    }
  }
  const healthy = Boolean(activeEndpoint) && endpoints.every((endpoint) => endpoint.status === "healthy");
  const isolationVerified = healthy && config.accessMode !== "private-only";
  return { healthy, ...(activeEndpoint ? { activeEndpoint, version } : {}), privateBankOk: healthy, sharedBankOk: config.accessMode !== "private-only" && healthy,
    workerPrivateDenied: isolationVerified, routerSharedWriteDenied: isolationVerified, isolationVerified, endpoints, checkedAt: Date.now() };
}

export function memoryProjectTag(caller: Pick<MemoryCallerContext, "projectId">): string {
  return `project:${caller.projectId || "unassigned"}`;
}

function buildProvenanceTags(caller: MemoryCallerContext): string[] {
  const tags = [
    "application:kulo",
    caller.role === "worker"
      ? "provenance:assistant-worklog"
      : "provenance:assistant-inference",
    `session:${caller.conversationId}`,
    memoryProjectTag(caller),
  ];
  if (caller.ticketId) tags.push(`ticket:${caller.ticketId}`);
  if (caller.workerRole) tags.push(`role:${caller.workerRole}`);
  if (caller.runEpoch !== undefined) tags.push(`run:${caller.runEpoch}`);
  return tags;
}

export function memoryDocumentId(caller: MemoryCallerContext, title: string): string {
  // Titles are display metadata; identity belongs to a real producer and source event.
  const scope = JSON.stringify([caller.role, caller.projectId ?? null, caller.ticketId ?? null, caller.conversationId, caller.runEpoch ?? null, caller.sourceId ?? null, title]);
  return `kulo-${createHash("sha256").update(scope).digest("hex")}`;
}

export function memoryOperationId(source: string): string {
  const hash = createHash("sha256").update(source).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function projectFilter(caller: MemoryCallerContext, bank: MemoryBank, global = false): string[] {
  return bank === "shared" && (caller.role === "worker" || !global) ? [memoryProjectTag(caller)] : [];
}

export interface HindsightOperationReceipt {
  operationId: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled" | "not_found";
}

export async function getHindsightOperation(config: HindsightMemoryConfig, caller: MemoryCallerContext, bank: MemoryBank, operationId: string, signal?: AbortSignal): Promise<HindsightOperationReceipt> {
  const bankId = enforceBankAuthorization(config, caller, bank, false);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId)) throw makeError("INVALID_ARGUMENTS", "validation");
  const { data } = await fetchHindsightJson({ config, role: caller.role, method: "GET", pathSuffix: `/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`, signal });
  const status = (data as { status?: string })?.status;
  if (!["pending", "processing", "completed", "failed", "cancelled", "not_found"].includes(status ?? "")) throw makeError("INVALID_RESPONSE", "response");
  return { operationId, status: status as HindsightOperationReceipt["status"] };
}

export async function retainHindsightDocument(params: {
  config: HindsightMemoryConfig; caller: MemoryCallerContext; bank: MemoryBank;
  title: string; content: string; timestamp: number; operationId: string; signal?: AbortSignal;
  source?: "worklog" | "document" | "initiative";
  customDocumentId?: string;
  extraTags?: readonly string[];
}): Promise<{ documentId: string; operationId: string; status: "pending" | "completed" }> {
  const { config, caller, bank, title, content, timestamp, operationId, signal } = params;
  const bankId = enforceBankAuthorization(config, caller, bank, true);
  if (!isSafeMemoryText(content) || !isSafeMemoryText(title)) throw makeError("UNSAFE_CONTENT", "validation");
  const userExtraTags = (params.extraTags ?? []).filter((t): t is string => typeof t === "string" && Boolean(t.trim())).map((t) => t.trim());
  if (
    userExtraTags.some((tag) =>
      /^(?:session|ticket|project|run|role|provenance|verification|application|evidence|source|harness):/i.test(tag),
    )
  ) {
    throw makeError("FORBIDDEN", "authorization");
  }
  const documentId = params.customDocumentId?.trim()
    ? `${memoryDocumentId(caller, params.customDocumentId.trim())}`
    : memoryDocumentId(caller, title);
  const tags = [...new Set([...buildProvenanceTags(caller), `source:${params.source ?? "document"}`, "harness:kulo", ...userExtraTags])];
  const { data } = await fetchHindsightJson({ config, role: caller.role, method: "POST", pathSuffix: `/v1/default/banks/${encodeURIComponent(bankId)}/memories`, signal,
    body: { async: true, operation_id: operationId, items: [{ content, context: title, document_id: documentId, tags,
      observation_scopes: [[memoryProjectTag(caller)]], timestamp: new Date(timestamp).toISOString(),
      metadata: { actor: caller.role === "worker" ? "worker" : "assistant", harness: "kulo", title,
        projectId: caller.projectId ?? "", ticketId: caller.ticketId ?? "", conversationId: caller.conversationId, runEpoch: String(caller.runEpoch ?? ""), sourceId: caller.sourceId ?? "" } }] } });
  const response = data as { operation_id?: string; async?: boolean; success?: boolean };
  if (response?.operation_id !== operationId || response.async === false) {
    if (response?.success === true && response.async === false) return { documentId, operationId, status: "completed" };
    throw makeError("INVALID_RESPONSE", "response");
  }
  return { documentId, operationId, status: "pending" };
}

const WRITE_HINDSIGHT_TOOLS = new Set<OfficialHindsightToolName>([
  "hindsight_retain",
  "hindsight_ingest_document",
  "hindsight_capture_initiative",
  "hindsight_create_page",
  "hindsight_update_page_node",
  "hindsight_create_mental_model",
  "hindsight_refresh_mental_model",
  "hindsight_invalidate_memory",
]);

const PRIVATE_CURATION_ONLY_TOOLS = new Set<OfficialHindsightToolName>([
  "hindsight_create_mental_model",
  "hindsight_refresh_mental_model",
  "hindsight_invalidate_memory",
]);

function validateIsoTimestamp(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 64) {
    throw makeError("INVALID_ARGUMENTS", "validation");
  }
  const parsed = Date.parse(raw.trim());
  if (!Number.isFinite(parsed)) {
    throw makeError("INVALID_ARGUMENTS", "validation");
  }
  return new Date(parsed).toISOString();
}

export async function executeHindsightTool(params: {
  toolName: OfficialHindsightToolName;
  args: Record<string, unknown>;
  bank: MemoryBank;
  config: HindsightMemoryConfig;
  caller: MemoryCallerContext;
  signal?: AbortSignal;
}): Promise<{ isError?: boolean; text: string }> {
  const { toolName, args, bank, config, caller, signal } = params;
  const fetchBank = (request: Omit<Parameters<typeof fetchHindsightJson>[0], "role">) =>
    fetchHindsightJson({ ...request, role: caller.role });
  const isWrite = WRITE_HINDSIGHT_TOOLS.has(toolName);

  try {
    if (PRIVATE_CURATION_ONLY_TOOLS.has(toolName) && (caller.role !== "router" || bank !== "private")) {
      throw makeError("FORBIDDEN", "authorization");
    }
    const bankId = enforceBankAuthorization(config, caller, bank, isWrite);
    const bankPrefix = `/v1/default/banks/${encodeURIComponent(bankId)}`;

    if (!isSafeMemoryText(JSON.stringify(args))) {
      throw makeError("UNSAFE_CONTENT", "validation");
    }

    const assertSharedItemProjectTag = (item: Record<string, unknown> | null | undefined) => {
      if (bank === "shared" && caller.role === "worker") {
        const tags = Array.isArray(item?.tags) ? item.tags : [];
        if (!tags.includes(memoryProjectTag(caller))) {
          throw makeError("FORBIDDEN", "authorization");
        }
      }
    };

    switch (toolName) {
      case "hindsight_recall": {
        const query = String(args.query ?? "").trim();
        if (!query || query.length > 16_000) {
          throw makeError("INVALID_ARGUMENTS", "validation");
        }
        const scope = (args.scope as "global" | "project" | "ticket" | "session" | undefined) ?? (bank === "shared" ? "project" : "global");
        const maxTokens = Math.min(
          Math.max(1, Number(args.max_tokens ?? 2000) || 2000),
          16_000,
        );
        const budget =
          args.budget === "high" || args.budget === "mid" ? args.budget : "low";
        const rawTypes = Array.isArray(args.types)
          ? args.types.filter(
              (t): t is string =>
                t === "world" || t === "experience" || t === "observation",
            )
          : ["world", "experience", "observation"];
        const types = rawTypes.length > 0 ? rawTypes : ["world", "experience", "observation"];

        const userTags = Array.isArray(args.tags)
          ? args.tags.filter((t): t is string => typeof t === "string")
          : [];
        if (
          userTags.some((tag) =>
            /^(?:session|ticket|project|run|role|provenance|verification|application|evidence):/i.test(tag),
          )
        ) {
          throw makeError("FORBIDDEN", "authorization");
        }

        const filterTags = [...userTags, ...projectFilter(caller, bank, scope === "global")];
        if (scope === "ticket") {
          const targetTicket =
            caller.role === "worker"
              ? caller.ticketId
              : typeof args.ticket_id === "string"
                ? args.ticket_id.trim()
                : undefined;
          if (!targetTicket) throw makeError("INVALID_ARGUMENTS", "validation");
          if (
            caller.role === "router" &&
            caller.isValidTicket &&
            !caller.isValidTicket(targetTicket)
          ) {
            throw makeError("FORBIDDEN", "authorization");
          }
          filterTags.push(`ticket:${targetTicket}`);
        } else if (scope === "session") {
          filterTags.push(`session:${caller.conversationId}`);
        }

        let temporalWindow: { start?: string; end?: string } | undefined;
        if (args.temporal_window !== undefined) {
          if (!args.temporal_window || typeof args.temporal_window !== "object" || Array.isArray(args.temporal_window)) {
            throw makeError("INVALID_ARGUMENTS", "validation");
          }
          const tw = args.temporal_window as { start?: unknown; end?: unknown };
          const start = tw.start !== undefined ? validateIsoTimestamp(tw.start) : undefined;
          const end = tw.end !== undefined ? validateIsoTimestamp(tw.end) : undefined;
          if (!start && !end) throw makeError("INVALID_ARGUMENTS", "validation");
          temporalWindow = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
        }
        const includeChunks = args.include_chunks === true;

        const { status, data } = await fetchBank({
          config,
          method: "POST",
          pathSuffix: `${bankPrefix}/memories/recall`,
          body: {
            query,
            types,
            budget,
            max_tokens: maxTokens,
            prefer_observations: true,
            ...(filterTags.length > 0
              ? { tags: filterTags, tags_match: "all_strict" }
              : {}),
            ...(temporalWindow ? { temporal_window: temporalWindow } : {}),
            ...(includeChunks ? { include: { chunks: {} } } : {}),
          },
          signal,
          tolerate404: true,
        });

        if (status === 404) {
          return { text: JSON.stringify({ results: [], bank }) };
        }
        const payload = data as { results?: Array<Record<string, unknown>>; chunks?: Record<string, unknown> };
        const results = payload?.results;
        if (!Array.isArray(results)) throw makeError("INVALID_RESPONSE", "response");
        return {
          text: JSON.stringify({
            results: results.map(({ id, text, type, document_id, occurred_start, occurred_end, tags, chunk_id }) => ({
              id,
              text,
              type,
              document_id,
              occurred_start,
              occurred_end,
              tags,
              ...(chunk_id ? { chunk_id } : {}),
            })),
            ...(includeChunks && payload.chunks ? { chunks: payload.chunks } : {}),
            crediting: CREDIT_REMINDER,
          }),
        };
      }

      case "hindsight_search_pages":
      case "hindsight_search_knowledge_pages": {
        const query = String(args.query ?? "").trim();
        if (!query) throw makeError("INVALID_ARGUMENTS", "validation");
        const limitNum = Math.min(Math.max(1, Number(args.limit ?? 5) || 5), 20);
        const filters = projectFilter(caller, bank);
        const search = new URLSearchParams({ q: query, limit: String(toolName === "hindsight_search_knowledge_pages" ? 3 : limitNum), ...(filters.length ? { tags_match: "all_strict" } : {}) });
        filters.forEach((tag) => search.append("tags", tag));
        const q = `?${search}`;
        let res = await fetchBank({
          config,
          method: "GET",
          pathSuffix: `${bankPrefix}/${toolName === "hindsight_search_pages" ? "pages" : "knowledge-base"}/search${q}`,
          signal,
          tolerate404: true,
        });
        if (res.status === 404 && toolName === "hindsight_search_pages") {
          res = await fetchBank({
            config,
            method: "GET",
            pathSuffix: `${bankPrefix}/knowledge-base/search${q}`,
            signal,
            tolerate404: true,
          });
        }
        if (res.status === 404) {
          return { text: JSON.stringify({ pages: [], crediting: CREDIT_REMINDER }, null, 2) };
        }
        const results = Array.isArray((res.data as { results?: unknown[] })?.results)
          ? ((res.data as {
              results: Array<{
                id: string;
                name: string;
                source_query?: string;
                snippet?: string;
              }>;
            }).results ?? [])
          : [];
        return {
          text: JSON.stringify(
            {
              pages: results.map((h) => ({
                page: h.name,
                page_id: h.id,
                ...(h.source_query ? { description: h.source_query } : {}),
                snippet: h.snippet ?? "",
              })),
              crediting: CREDIT_REMINDER,
            },
            null,
            2,
          ),
        };
      }

      case "hindsight_get_page_tree":
      case "hindsight_list_knowledge_pages": {
        const filters = projectFilter(caller, bank);
        const search = new URLSearchParams(filters.length ? { tags_match: "all_strict" } : {});
        filters.forEach((tag) => search.append("tags", tag));
        const querySuffix = filters.length ? `?${search}` : "";
        let res = await fetchBank({
          config,
          method: "GET",
          pathSuffix: `${bankPrefix}/${toolName === "hindsight_get_page_tree" ? "pages" : "knowledge-base"}/tree${querySuffix}`,
          signal,
          tolerate404: true,
        });
        if (res.status === 404 && toolName === "hindsight_get_page_tree") {
          res = await fetchBank({
            config,
            method: "GET",
            pathSuffix: `${bankPrefix}/knowledge-base/tree${querySuffix}`,
            signal,
            tolerate404: true,
          });
        }
        if (res.status === 404) {
          return { text: JSON.stringify({ items: [], roots: [] }, null, 2) };
        }
        const roots = Array.isArray((res.data as { roots?: KnowledgeNode[] })?.roots)
          ? ((res.data as { roots: KnowledgeNode[] }).roots ?? [])
          : [];
        const items: Array<{ id: string; name: string; description?: string; folder?: string; folder_id?: string }> =
          [];
        const walk = (nodes: KnowledgeNode[], folder?: string, folderId?: string) => {
          for (const n of nodes) {
            if (!n?.id || !n?.name) continue;
            if (n.kind === "page") {
              items.push({
                id: n.id,
                name: n.name,
                ...(n.description ? { description: n.description } : {}),
                ...(folder ? { folder } : {}),
                ...(folderId ? { folder_id: folderId } : {}),
              });
            }
            if (n.children?.length) {
              walk(n.children, n.kind === "folder" ? n.name : folder, n.kind === "folder" ? n.id : folderId);
            }
          }
        };
        walk(roots);
        return {
          text: JSON.stringify(
            toolName === "hindsight_get_page_tree" ? { items, roots } : { items },
            null,
            2,
          ),
        };
      }

      case "hindsight_get_page":
      case "hindsight_read_knowledge_page": {
        const pageId = String(args.page_id ?? "").trim();
        if (!pageId || ["export", "tree", "search", "folders", "nodes"].includes(pageId.toLowerCase())) {
          throw makeError("INVALID_ARGUMENTS", "validation");
        }
        let res = await fetchBank({
          config,
          method: "GET",
          pathSuffix: `${bankPrefix}/${toolName === "hindsight_get_page" ? "pages" : "knowledge-base/pages"}/${encodeURIComponent(pageId)}`,
          signal,
          tolerate404: toolName === "hindsight_get_page",
        });
        if (res.status === 404 && toolName === "hindsight_get_page") {
          res = await fetchBank({
            config,
            method: "GET",
            pathSuffix: `${bankPrefix}/knowledge-base/pages/${encodeURIComponent(pageId)}`,
            signal,
          });
        }
        const p = (res.data ?? {}) as Record<string, unknown>;
        assertSharedItemProjectTag(p);
        const body =
          typeof p.body === "string" && p.body.trim() ? p.body : p.markdown;
        return {
          text: JSON.stringify(
            {
              id: p.id,
              name: p.name,
              ...(p.description ? { description: p.description } : {}),
              ...(p.source_query ? { source_query: p.source_query } : {}),
              ...(Array.isArray(p.tags) && p.tags.length ? { tags: p.tags } : {}),
              ...(p.timestamp ? { last_updated_at: p.timestamp } : {}),
              body,
            },
            null,
            2,
          ),
        };
      }

      case "hindsight_create_page": {
        const name = String(args.name ?? "").trim();
        const sourceQuery = String(args.source_query ?? "").trim();
        const parentId = typeof args.parent_id === "string" && args.parent_id.trim() ? args.parent_id.trim() : undefined;
        const maxTokens = Math.min(Math.max(256, Number(args.max_tokens ?? 2048) || 2048), 8192);
        if (!name || !sourceQuery || name.length > 240 || sourceQuery.length > 4000) {
          throw makeError("INVALID_ARGUMENTS", "validation");
        }
        const tags = bank === "shared" ? [memoryProjectTag(caller)] : [];
        const pageRes = await fetchBank({
          config,
          method: "POST",
          pathSuffix: `${bankPrefix}/pages`,
          body: {
            name,
            source_query: sourceQuery,
            ...(parentId ? { parent_id: parentId } : {}),
            ...(tags.length ? { tags } : {}),
            max_tokens: maxTokens,
          },
          signal,
        });
        const created = (pageRes.data ?? {}) as { id?: string; page_id?: string; name?: string };
        const pageId = created.page_id ?? created.id;
        if (!pageId) throw makeError("INVALID_RESPONSE", "response");
        return {
          text: JSON.stringify({ page_id: pageId, name: created.name ?? name, bank, tags }, null, 2),
        };
      }

      case "hindsight_update_page_node": {
        const nodeId = String(args.node_id ?? "").trim();
        if (!nodeId || nodeId.toLowerCase() === "export") {
          throw makeError("INVALID_ARGUMENTS", "validation");
        }
        // Pre-read ownership verification on shared bank before any mutation!
        const existingRes = await fetchBank({
          config,
          method: "GET",
          pathSuffix: `${bankPrefix}/pages/${encodeURIComponent(nodeId)}`,
          signal,
        });
        const existingPage = (existingRes.data ?? {}) as Record<string, unknown>;
        assertSharedItemProjectTag(existingPage);

        const patchBody: Record<string, unknown> = {};
        if (typeof args.name === "string" && args.name.trim()) patchBody.name = args.name.trim();
        if (typeof args.source_query === "string" && args.source_query.trim()) patchBody.source_query = args.source_query.trim();
        if (args.parent_id !== undefined) {
          patchBody.parent_id = args.parent_id === null || args.parent_id === "" ? null : String(args.parent_id).trim();
        }
        if (args.max_tokens !== undefined) {
          patchBody.max_tokens = Math.min(Math.max(256, Number(args.max_tokens) || 2048), 8192);
        }
        if (Object.keys(patchBody).length === 0) {
          throw makeError("INVALID_ARGUMENTS", "validation");
        }
        // Preserve mandatory project tag on shared bank updates.
        if (bank === "shared") {
          const currentTags = Array.isArray(existingPage.tags)
            ? existingPage.tags.filter((t): t is string => typeof t === "string")
            : [];
          patchBody.tags = [...new Set([...currentTags, memoryProjectTag(caller)])];
        }

        const updatedRes = await fetchBank({
          config,
          method: "PATCH",
          pathSuffix: `${bankPrefix}/pages/nodes/${encodeURIComponent(nodeId)}`,
          body: patchBody,
          signal,
        });
        return {
          text: JSON.stringify(updatedRes.data ?? { id: nodeId, updated: true, bank }, null, 2),
        };
      }

      case "hindsight_list_mental_models": {
        const filters = projectFilter(caller, bank);
        const search = new URLSearchParams(filters.length ? { tags_match: "all_strict" } : {});
        filters.forEach((tag) => search.append("tags", tag));
        const { status, data } = await fetchBank({
          config,
          method: "GET",
          pathSuffix: `${bankPrefix}/mental-models${filters.length ? `?${search}` : ""}`,
          signal,
          tolerate404: true,
        });
        if (status === 404) {
          return { text: JSON.stringify({ items: [] }, null, 2) };
        }
        const rawItems = Array.isArray((data as { items?: unknown[] })?.items)
          ? ((data as { items: Array<Record<string, unknown>> }).items)
          : Array.isArray(data)
            ? (data as Array<Record<string, unknown>>)
            : [];
        const visible = bank === "shared" && caller.role === "worker"
          ? rawItems.filter((m) => Array.isArray(m.tags) && m.tags.includes(memoryProjectTag(caller)))
          : rawItems;
        return {
          text: JSON.stringify(
            {
              items: visible.map((m) => ({
                id: m.id,
                name: m.name,
                ...(m.source_query ? { source_query: m.source_query } : {}),
                ...(Array.isArray(m.tags) && m.tags.length ? { tags: m.tags } : {}),
                ...(m.last_refreshed_at ? { last_refreshed_at: m.last_refreshed_at } : {}),
              })),
            },
            null,
            2,
          ),
        };
      }

      case "hindsight_get_mental_model": {
        const modelId = String(args.mental_model_id ?? "").trim();
        if (!modelId || modelId.toLowerCase() === "export") {
          throw makeError("INVALID_ARGUMENTS", "validation");
        }
        const { data } = await fetchBank({
          config,
          method: "GET",
          pathSuffix: `${bankPrefix}/mental-models/${encodeURIComponent(modelId)}`,
          signal,
        });
        const m = (data ?? {}) as Record<string, unknown>;
        assertSharedItemProjectTag(m);
        return {
          text: JSON.stringify(
            {
              id: m.id,
              name: m.name,
              ...(m.source_query ? { source_query: m.source_query } : {}),
              content: m.content ?? "",
              ...(Array.isArray(m.tags) && m.tags.length ? { tags: m.tags } : {}),
              ...(m.last_refreshed_at ? { last_refreshed_at: m.last_refreshed_at } : {}),
              crediting: CREDIT_REMINDER,
            },
            null,
            2,
          ),
        };
      }

      case "hindsight_create_mental_model": {
        const name = String(args.name ?? "").trim();
        const sourceQuery = String(args.source_query ?? "").trim();
        const maxTokens = Math.min(Math.max(256, Number(args.max_tokens ?? 2048) || 2048), 8192);
        if (!name || !sourceQuery || name.length > 240 || sourceQuery.length > 4000) {
          throw makeError("INVALID_ARGUMENTS", "validation");
        }
        const { data } = await fetchBank({
          config,
          method: "POST",
          pathSuffix: `${bankPrefix}/mental-models`,
          body: {
            name,
            source_query: sourceQuery,
            max_tokens: maxTokens,
          },
          signal,
        });
        return { text: JSON.stringify({ bank, ...(data as Record<string, unknown>) }, null, 2) };
      }

      case "hindsight_refresh_mental_model": {
        const modelId = String(args.mental_model_id ?? "").trim();
        if (!modelId || modelId.toLowerCase() === "export") {
          throw makeError("INVALID_ARGUMENTS", "validation");
        }
        const mode = args.mode === "full" ? "full" : undefined;
        const { data } = await fetchBank({
          config,
          method: "POST",
          pathSuffix: `${bankPrefix}/mental-models/${encodeURIComponent(modelId)}/refresh`,
          body: mode ? { mode } : {},
          signal,
        });
        return { text: JSON.stringify({ bank, mental_model_id: modelId, ...(data as Record<string, unknown>) }, null, 2) };
      }

      case "hindsight_invalidate_memory": {
        const memoryId = String(args.memory_id ?? "").trim();
        const reason = String(args.reason ?? "").trim();
        if (
          !memoryId ||
          ["list", "recall", "dry-run-extract", "export"].includes(memoryId.toLowerCase()) ||
          !reason ||
          reason.length > 1000
        ) {
          throw makeError("INVALID_ARGUMENTS", "validation");
        }
        const { data } = await fetchBank({
          config,
          method: "PATCH",
          pathSuffix: `${bankPrefix}/memories/${encodeURIComponent(memoryId)}`,
          body: { state: "invalidated", reason },
          signal,
        });
        return {
          text: JSON.stringify({ invalidated: true, memory_id: memoryId, bank, reason, ...(data as Record<string, unknown>) }, null, 2),
        };
      }

      case "hindsight_reflect": {
        const query = String(args.query ?? "").trim();
        if (!query) throw makeError("INVALID_ARGUMENTS", "validation");
        const budget =
          args.budget === "low" || args.budget === "mid" ? args.budget : "high";
        const { data } = await fetchBank({
          config,
          method: "POST",
          pathSuffix: `${bankPrefix}/reflect`,
          body: { query, budget, ...((caller.role === "worker" || caller.projectId) && bank === "shared" ? { tags: [memoryProjectTag(caller)], tags_match: "all_strict" } : {}) },
          timeoutMs: 120_000,
          signal,
        });
        const text = String((data as { text?: string })?.text ?? "").trim();
        return {
          text: JSON.stringify({ synthesis: text, crediting: CREDIT_REMINDER }, null, 2),
        };
      }

      case "hindsight_retain":
      case "hindsight_ingest_document": {
        const rawTitle =
          typeof args.title === "string" && args.title.trim()
            ? args.title.trim()
            : typeof args.context === "string" && args.context.trim()
              ? args.context.trim()
              : toolName === "hindsight_retain"
                ? "retained-note"
                : "";
        const content = String(args.content ?? "").trim();
        if (!rawTitle || !content) throw makeError("INVALID_ARGUMENTS", "validation");
        const customDocId =
          typeof args.document_id === "string" && args.document_id.trim() ? args.document_id.trim() : undefined;
        const extraTags = Array.isArray(args.tags)
          ? args.tags.filter((t): t is string => typeof t === "string")
          : undefined;

        const operationId = memoryOperationId(
          `${memoryDocumentId(caller, customDocId ?? rawTitle)}:${content}`,
        );
        const receipt = await retainHindsightDocument({
          config,
          caller,
          bank,
          title: rawTitle,
          content,
          timestamp: caller.sourceTimestamp ?? Date.now(),
          operationId,
          ...(customDocId ? { customDocumentId: customDocId } : {}),
          ...(extraTags?.length ? { extraTags } : {}),
          signal,
        });
        return {
          text: JSON.stringify(
            {
              accepted: true,
              status: receipt.status,
              bank,
              doc_id: receipt.documentId,
              operation_id: receipt.operationId,
            },
            null,
            2,
          ),
        };
      }

      case "hindsight_get_operation": {
        const operationId = String(args.operation_id ?? "").trim();
        return { text: JSON.stringify(await getHindsightOperation(config, caller, bank, operationId, signal)) };
      }

      case "hindsight_capture_initiative": {
        const title = String(args.title ?? "").trim();
        const summary = String(args.summary ?? "").trim();
        const relatesToPageId =
          typeof args.relates_to_page_id === "string" && args.relates_to_page_id.trim()
            ? args.relates_to_page_id.trim()
            : undefined;
        if (!title || !summary) throw makeError("INVALID_ARGUMENTS", "validation");

        let pageId = relatesToPageId;
        if (pageId) {
          const { data } = await fetchBank({ config, method: "GET", pathSuffix: `${bankPrefix}/knowledge-base/pages/${encodeURIComponent(pageId)}`, signal });
          const page = data as { tags?: string[] };
          if (caller.role === "worker" && !page.tags?.includes(memoryProjectTag(caller))) throw makeError("FORBIDDEN", "authorization");
        }
        if (!pageId) {
          let folderId: string | undefined;
          const treeRes = await fetchBank({
            config,
            method: "GET",
            pathSuffix: `${bankPrefix}/knowledge-base/tree`,
            signal,
            tolerate404: true,
          });
          const roots = ((treeRes.data as { roots?: KnowledgeNode[] })?.roots ?? []);
          const folderName = `Initiatives (${caller.projectId || "unassigned"})`;
          const hit = roots.find((n) => n.kind === "folder" && n.name === folderName);
          if (hit?.id) {
            folderId = hit.id;
          } else {
            const folderRes = await fetchBank({
              config,
              method: "POST",
              pathSuffix: `${bankPrefix}/knowledge-base/folders`,
              body: { name: folderName },
              signal,
            });
            folderId = (folderRes.data as { id?: string })?.id;
          }
          const minute = parseInt(createHash("sha256").update(`${bankId}:${title}`).digest("hex").slice(0, 4), 16) % 60;
          const pageRes = await fetchBank({
            config,
            method: "POST",
            pathSuffix: `${bankPrefix}/knowledge-base/pages`,
            body: {
              name: title,
              source_query: `Summarize the "${title}" initiative: what is being built or changed and why, and its current state — drawn from the bank's memory.`,
              ...(folderId ? { parent_id: folderId } : {}),
              tags: [memoryProjectTag(caller)],
              max_tokens: 2048,
              trigger: { mode: "delta", refresh_after_consolidation: false, refresh_cron: `${minute} * * * *`, fact_types: ["observation"], exclude_mental_models: true },
            },
            signal,
          });
          const p = pageRes.data as { page_id?: string; id?: string };
          pageId = p?.page_id ?? p?.id;
          if (!pageId) throw makeError("INVALID_RESPONSE", "response");
        }

        const verb = relatesToPageId ? "Update to an existing initiative" : "New initiative";
        const marker = `${verb}: ${title}. ${summary}`;
        const receipt = await retainHindsightDocument({ config, caller, bank, title: `initiative:${pageId}`, content: marker, timestamp: caller.sourceTimestamp ?? Date.now(), operationId: memoryOperationId(`${memoryDocumentId(caller, `initiative:${pageId}`)}:${marker}`), source: "initiative", signal });

        return {
          text: JSON.stringify({ page_id: pageId, bank, accepted: true, status: receipt.status, operation_id: receipt.operationId }, null, 2),
        };
      }
    }
  } catch (err) {
    const diagnostic: HindsightDiagnostic =
      err instanceof HindsightAccessError
        ? err.diagnostic
        : {
            code: signal?.aborted ? "ABORTED" : "UNAVAILABLE",
            stage: "request",
            retryable: true,
          };
    return {
      isError: true,
      text: JSON.stringify(
        {
          tool: toolName,
          bank,
          ...diagnostic,
          error:
            diagnostic.code === "DISABLED"
              ? "Hindsight 长期记忆尚未在「设置 -> 个性与记忆」中开启。"
              : diagnostic.code === "FORBIDDEN"
                ? "越权拒绝：Router 仅可读写 private / 只读 shared；Worker 仅可访问 shared。"
                : diagnostic.code === "ISOLATION_UNVERIFIED"
                  ? "Hindsight 尚未通过主脑／Worker 服务端隔离检查，请先安装双库权限扩展并测试已保存配置。"
                  : `Hindsight 请求未成功 (${diagnostic.code})，未执行任何隐式替代操作。`,
        },
        null,
        2,
      ),
    };
  }
}
