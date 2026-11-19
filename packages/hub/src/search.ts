import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import {
  redactSecrets, redactSensitiveText,
  type SearchAdapterId, type SearchPlanInput, type SearchPlanView, type SearchSnapshot,
  type SearchAttempt, type SearchFailure, type WebPageResult, type WebSearchInput, type WebSearchResult,
} from "@moco/protocol";
import { fetchSearchPageAdapter, runSearchAdapter } from "./search-adapters.js";
import { fetchWebPage } from "./web-content.js";

const ORIGIN_ENV = "MOCO_API_KEY_ORIGIN";
const ADAPTERS: readonly SearchAdapterId[] = ["exa", "tavily", "brave", "duckduckgo"];
const DEFAULT_URLS: Record<SearchAdapterId, string> = {
  exa: "https://mcp.exa.ai/mcp", tavily: "https://mcp.tavily.com/mcp",
  brave: "https://api.search.brave.com", duckduckgo: "https://duckduckgo.com",
};
const MAX_PLANS = 64;
interface StoredPlan extends Omit<SearchPlanView, "hasCredential" | "adapter"> {
  adapter: SearchAdapterId | "native";
  credentialRef?: string;
  credentialOrigin?: string;
  providerId?: string;
  modelId?: string;
  transportVersion?: number;
  requestSequence?: number;
  credentialConfirmationRequired?: boolean;
}
export interface MocoSearchState {
  revision: number;
  plans: Record<string, StoredPlan>;
  order: string[];
  cleanup: Record<string, boolean>;
  legacyImported: boolean;
  presetVersion?: number;
  healthRevision?: number;
  nativeMigrations?: Record<string, boolean>;
  pendingNativeMigrations?: string[];
}
export const MocoSearchDoc = defineDoc<MocoSearchState & JsonObject>({
  kind: "moco.search", version: 1, scope: "session",
  initial: () => ({ revision: 0, healthRevision: 0, plans: {}, order: [], cleanup: {}, legacyImported: false, presetVersion: 0, nativeMigrations: {}, pendingNativeMigrations: [] }) as MocoSearchState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});
export class SearchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly failure?: SearchFailure, readonly attempts?: SearchAttempt[]) { super(message); this.name = "SearchError"; }
}
export interface MocoSearchOptions {
  harness: Harness;
  credentials: CredentialStore;
  migrateNativePlan?: (plan: { providerId: string; modelId: string; enabled: boolean }) => Promise<void | boolean>;
  stateDir?: string;
  onChanged?: () => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
  /** Trusted page-reader transport injection for tests; service/MCP transports must use fetch instead. */
  pageFetch?: typeof globalThis.fetch;
  now?: () => number;
  attemptTimeoutMs?: number;
  timeoutMs?: number;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const own = <T>(record: Readonly<Record<string, T>> | undefined, id: string): T | undefined => record && Object.hasOwn(record, id) ? record[id] : undefined;
function fail(status: number, code: string, message: string): never { throw new SearchError(status, code, message); }
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, "invalid_search", `${label}无效。`);
  return value.trim();
}
function identifier(value: unknown): string {
  const result = text(value, "搜索方案标识");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result) || ["__proto__", "constructor", "prototype"].includes(result)) fail(400, "invalid_search", "搜索方案标识无效。");
  return result;
}
function expected(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) fail(400, "search_revision_required", "请先读取当前搜索方案版本。");
  return Number(value);
}
function requirePlan(state: Readonly<MocoSearchState> | undefined, id: string): StoredPlan {
  return own(state?.plans, id) ?? fail(404, "search_plan_not_found", "搜索方案不存在或已移除。");
}
function assertRevision(plan: StoredPlan, revision: number): void {
  if (plan.revision !== revision) fail(409, "search_revision_conflict", "搜索方案已更新，请刷新后重试。");
}
function baseUrl(value: unknown, adapter: SearchAdapterId): string {
  const raw = value === undefined ? DEFAULT_URLS[adapter] : text(value, "搜索服务地址", 2048);
  let url: URL;
  try { url = new URL(raw); } catch { return fail(400, "invalid_search_url", "搜索服务地址必须是有效的 HTTP 或 HTTPS 地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) fail(400, "invalid_search_url", "搜索服务地址不能包含凭证、查询参数或片段。");
  const normalized = url.toString().replace(/\/+$/, "");
  if ((adapter === "brave" || adapter === "duckduckgo") && normalized !== DEFAULT_URLS[adapter]) fail(400, "invalid_search_url", "此搜索服务使用固定的官方地址。");
  return normalized;
}
function fixedIdentityValid(plan: StoredPlan): boolean {
  return plan.adapter !== "brave" && plan.adapter !== "duckduckgo" || plan.baseUrl === DEFAULT_URLS[plan.adapter];
}
function confirmationRequired(plan: StoredPlan): boolean { return Boolean(plan.credentialConfirmationRequired) || !fixedIdentityValid(plan); }
const FAILURE_MESSAGES: Record<SearchFailure["kind"], string> = {
  auth: "搜索服务认证失败，请检查密钥。", quota: "搜索服务额度已用尽。", rate_limit: "搜索服务请求过于频繁，请稍后重试。",
  unsupported_tool: "此服务未提供所需的搜索工具。", invalid_request: "搜索参数不被服务接受。", network: "无法连接搜索服务。",
  timeout: "搜索请求超时。", no_results: "未找到匹配的网页。", ungrounded: "搜索服务未返回可引用的网页来源。",
  upstream: "搜索服务暂不可用。", unknown: "搜索失败，请重试。",
};
function failureValue(error: unknown, secret?: string): SearchFailure {
  const object = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const candidate = object.failure && typeof object.failure === "object" ? object.failure as Record<string, unknown> : {};
  const status = typeof candidate.upstreamStatus === "number" ? candidate.upstreamStatus : Object.keys(candidate).length ? undefined : typeof object.status === "number" ? object.status : undefined;
  const rawKind = candidate.kind;
  let kind: SearchFailure["kind"] = typeof rawKind === "string" && Object.hasOwn(FAILURE_MESSAGES, rawKind) ? rawKind as SearchFailure["kind"] : "unknown";
  if (kind === "unknown") {
    if (status === 401 || status === 403) kind = "auth";
    else if (status === 429) kind = "rate_limit";
    else if (status !== undefined && status >= 500) kind = "upstream";
    else if (status === 400 || status === 422) kind = "invalid_request";
    else if (["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(String(object.code))) kind = "network";
    else if (object.name === "TimeoutError" || object.code === "ETIMEDOUT") kind = "timeout";
  }
  const machine = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string" || !value.length || value.length > max || !/^[A-Za-z0-9_.:/\[\]-]+$/.test(value)) return undefined;
    const redacted = redactSecrets(redactSensitiveText(value, secret ? [secret] : []));
    return redacted === value ? value : undefined;
  };
  const upstreamCode = machine(candidate.upstreamCode, 100);
  const parameter = machine(candidate.parameter, 100);
  const requestId = machine(candidate.requestId, 200);
  return { kind, message: FAILURE_MESSAGES[kind], retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : ["rate_limit", "network", "timeout", "upstream", "unknown"].includes(kind),
    ...(Number.isSafeInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? { upstreamStatus: Number(status) } : {}),
    ...(upstreamCode ? { upstreamCode } : {}), ...(parameter ? { parameter } : {}), ...(requestId ? { requestId } : {}) };
}
function failureStatus(failure: SearchFailure): number {
  // Upstream authentication is separate from the Hub's own HTTP authentication domain.
  return failure.kind === "timeout" ? 504 : 502;
}
function timeoutFailure(): SearchFailure { return { kind: "timeout", message: FAILURE_MESSAGES.timeout, retryable: true }; }
function assertActive(signal: AbortSignal, attempts?: SearchAttempt[]): void {
  if (!signal.aborted) return;
  if ((signal.reason as { name?: string } | undefined)?.name === "TimeoutError") {
    const failure = timeoutFailure();
    throw new SearchError(504, "search_timeout", failure.message, failure, attempts);
  }
  signal.throwIfAborted();
}
function inputValue(raw: WebSearchInput): WebSearchInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(400, "invalid_search", "搜索请求无效。");
  if (Object.keys(raw).some((key) => !["query", "maxResults", "includeDomains", "excludeDomains", "timeRange"].includes(key))) fail(400, "invalid_search", "搜索请求包含不支持的字段。");
  const query = text(raw.query, "搜索关键词", 4000);
  if (raw.maxResults !== undefined && (!Number.isSafeInteger(raw.maxResults) || raw.maxResults < 1 || raw.maxResults > 10)) fail(400, "invalid_search", "搜索结果数量应为 1 至 10。");
  if (raw.timeRange !== undefined && !["day", "week", "month", "year"].includes(raw.timeRange)) fail(400, "invalid_search", "搜索时间范围无效。");
  const domains = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 20) fail(400, "invalid_search", "搜索域名筛选无效。");
    return [...new Set(value.map((item) => {
      const domain = text(item, "搜索域名", 253).toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) fail(400, "invalid_search", "搜索域名筛选无效。");
      return domain;
    }))];
  };
  const includeDomains = domains(raw.includeDomains);
  const excludeDomains = domains(raw.excludeDomains);
  return { query, maxResults: raw.maxResults ?? 5, ...(raw.timeRange ? { timeRange: raw.timeRange } : {}),
    ...(includeDomains ? { includeDomains } : {}), ...(excludeDomains ? { excludeDomains } : {}) };
}
function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class MocoSearch {
  readonly #options: MocoSearchOptions;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(options: MocoSearchOptions) { this.#options = options; }
  #now(): number { return this.#options.now?.() ?? Date.now(); }
  #state(): Promise<Readonly<MocoSearchState> | undefined> { return this.#options.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT); }
  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
  async #changed(): Promise<void> { await this.#options.onChanged?.(); }
  async #cleanup(): Promise<void> {
    for (const id of Object.keys((await this.#state())?.cleanup ?? {})) {
      await this.#options.credentials.delete(id);
      await this.#options.harness.commit(async (tx) => { delete (await tx.doc(MocoSearchDoc)).cleanup[id]; }, BACKGROUND_CONTEXT);
    }
  }
  async initialize(): Promise<void> {
    await this.#serial(async () => {
      await this.#cleanup();
      const before = await this.#state();
      const startingPlans = [...new Set([...(before?.pendingNativeMigrations ?? []), ...(before?.order ?? [])])].map((id) => clone(requirePlan(before, id)));
      const handled = new Set<string>();
      for (const initial of startingPlans) {
        const id = initial.id;
        if (handled.has(id)) continue;
        const plan = clone(requirePlan(await this.#state(), id));
        if (plan.adapter === "native") {
          if (!this.#options.migrateNativePlan) fail(409, "search_native_migration_required", "旧原生搜索方案需要迁移到模型设置。");
          const group = startingPlans.filter((item) => item.adapter === "native" && item.providerId === plan.providerId && item.modelId === plan.modelId);
          const ids = new Set(group.map((item) => item.id));
          const migrated = await this.#options.migrateNativePlan({ providerId: text(plan.providerId, "旧搜索服务商"), modelId: text(plan.modelId, "旧搜索模型", 300), enabled: group.some((item) => item.enabled) });
          await this.#options.harness.commit(async (tx) => {
            const doc = await tx.doc(MocoSearchDoc);
            for (const item of group) assertRevision(requirePlan(doc, item.id), item.revision);
            if (migrated === false) {
              const pending = doc.pendingNativeMigrations ??= [];
              const changed = group.some((item) => doc.order.includes(item.id) || !pending.includes(item.id));
              for (const item of group) if (!pending.includes(item.id)) pending.push(item.id);
              doc.order = doc.order.filter((item) => !ids.has(item));
              if (changed) doc.revision++;
              return;
            }
            for (const item of group) {
              (doc.nativeMigrations ??= {})[item.id] = true;
              if (item.credentialRef) doc.cleanup[item.credentialRef] = true;
              delete doc.plans[item.id];
            }
            doc.order = doc.order.filter((item) => !ids.has(item));
            doc.pendingNativeMigrations = (doc.pendingNativeMigrations ?? []).filter((item) => !ids.has(item)); doc.revision++;
          }, BACKGROUND_CONTEXT);
          for (const item of ids) handled.add(item);
        } else if (plan.transportVersion !== 1) {
          const officialTavily = plan.adapter === "tavily" && ["https://api.tavily.com", "https://api.tavily.com/"].includes(plan.baseUrl ?? "");
          const officialBrave = plan.adapter === "brave" && ["https://api.search.brave.com", "https://api.search.brave.com/"].includes(plan.baseUrl ?? "");
          if (officialBrave) {
            await this.#configure({ id, expectedRevision: plan.revision, name: plan.name, adapter: plan.adapter,
              enabled: plan.enabled, baseUrl: DEFAULT_URLS[plan.adapter] });
          } else {
            await this.#options.harness.commit(async (tx) => {
              const doc = await tx.doc(MocoSearchDoc);
              const current = requirePlan(doc, id); assertRevision(current, plan.revision);
              // Keep the saved key bound to its original origin until the user explicitly replaces it.
              if (officialTavily) current.baseUrl = DEFAULT_URLS.tavily;
              current.credentialConfirmationRequired = true;
              current.transportVersion = 1; current.revision++; current.updatedAt = this.#now();
              current.status = "needs_auth"; current.error = officialTavily ? "服务已切换为 MCP，请重新填写 API Key。" : "请重新配置 MCP 服务地址和密钥。";
              current.failure = { kind: "auth", message: current.error, retryable: false };
              current.healthRevision = (current.healthRevision ?? 0) + 1;
              doc.healthRevision = (doc.healthRevision ?? 0) + 1; doc.revision++;
            }, BACKGROUND_CONTEXT);
          }
        }
      }
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(MocoSearchDoc);
        if (doc.presetVersion !== 1) {
          if (!doc.order.some((id) => doc.plans[id]?.adapter === "exa") && doc.order.length < MAX_PLANS) {
            const id = `search-${randomUUID()}`;
            doc.plans[id] = { id, name: "Exa", adapter: "exa", baseUrl: DEFAULT_URLS.exa, enabled: true,
              revision: 1, status: "unverified", healthRevision: 0, transportVersion: 1, requestSequence: 0,
              createdAt: this.#now(), updatedAt: this.#now() };
            doc.order.push(id); doc.revision++;
          }
          doc.presetVersion = 1;
        }
      }, BACKGROUND_CONTEXT);
      if (!before?.legacyImported) {
        const legacyKey = process.env.MOCO_SEARCH_API_KEY?.trim();
        if (!before?.order.length && legacyKey?.startsWith("tvly-")) await this.#configure({ name: "Tavily", adapter: "tavily", apiKey: legacyKey });
        await this.#options.harness.commit(async (tx) => { (await tx.doc(MocoSearchDoc)).legacyImported = true; }, BACKGROUND_CONTEXT);
      }
      await this.#cleanup();
    });
  }
  async #key(plan: StoredPlan): Promise<string | undefined> {
    if (confirmationRequired(plan) || plan.adapter === "duckduckgo") return undefined;
    if (!plan.credentialRef || !plan.credentialOrigin || !plan.baseUrl || new URL(plan.baseUrl).origin !== plan.credentialOrigin) return undefined;
    const credential = await this.#options.credentials.read(plan.credentialRef);
    return credential?.type === "api_key" && credential.env?.[ORIGIN_ENV] === plan.credentialOrigin && credential.key?.trim() ? credential.key : undefined;
  }
  async #view(plan: StoredPlan): Promise<SearchPlanView> {
    if (plan.adapter === "native") return fail(409, "search_native_migration_required", "旧原生搜索方案需要迁移到模型设置。");
    const { credentialRef: _ref, credentialOrigin: _origin, providerId: _provider, modelId: _model, transportVersion: _transport,
      requestSequence: _sequence, credentialConfirmationRequired: _confirmation, ...stored } = clone(plan);
    const value = { ...stored, adapter: plan.adapter, healthRevision: plan.healthRevision ?? 0 };
    const hasCredential = Boolean(await this.#key(plan));
    if (!plan.enabled) { delete value.error; delete value.failure; return { ...value, hasCredential, status: "disabled" }; }
    if (confirmationRequired(plan) || (plan.adapter === "tavily" || plan.adapter === "brave") && !hasCredential) {
      const failure: SearchFailure = plan.failure?.kind === "auth" ? plan.failure : { kind: "auth", message: "请填写此搜索方案的 API Key。", retryable: false };
      return { ...value, hasCredential, status: "needs_auth", error: failure.message, failure };
    }
    return { ...value, hasCredential, status: value.status === "disabled" ? "unverified" : value.status };
  }
  async snapshot(): Promise<SearchSnapshot> {
    const state = await this.#state();
    return { revision: state?.revision ?? 0, healthRevision: state?.healthRevision ?? 0, plans: await Promise.all((state?.order ?? []).map((id) => this.#view(requirePlan(state, id)))) };
  }
  async configure(input: SearchPlanInput): Promise<SearchPlanView> {
    const result = await this.#serial(() => this.#configure(input));
    await this.#changed();
    return this.#view(result);
  }
  async #configure(raw: SearchPlanInput): Promise<StoredPlan> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["id", "expectedRevision", "name", "adapter", "enabled", "baseUrl", "apiKey"].includes(key))) fail(400, "invalid_search", "搜索方案包含不支持的字段。");
    if (!ADAPTERS.includes(raw.adapter)) fail(400, "invalid_search", "请选择支持的搜索服务。");
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") fail(400, "invalid_search", "搜索方案开关必须是布尔值。");
    if (raw.apiKey !== undefined && (typeof raw.apiKey !== "string" || raw.apiKey.length > 16_384 || /[\x00-\x1f\x7f]/.test(raw.apiKey))) fail(400, "invalid_search", "搜索 API Key 无效。");
    const name = text(raw.name, "搜索方案名称", 100);
    const state = await this.#state();
    const old = raw.id !== undefined ? requirePlan(state, identifier(raw.id)) : undefined;
    if (old) assertRevision(old, expected(raw.expectedRevision));
    else if (raw.expectedRevision !== undefined) fail(400, "invalid_search", "新增搜索方案不需要旧版本。");
    if (!old && (state?.order.length ?? 0) >= MAX_PLANS) fail(400, "search_plan_limit", "搜索方案数量已达到上限。");
    const adapter = raw.adapter;
    const key = raw.apiKey?.trim();
    if (adapter === "duckduckgo" && key) fail(400, "invalid_search", "DuckDuckGo 不使用 API Key。");
    const endpoint = baseUrl(raw.baseUrl ?? (adapter !== "brave" && adapter !== "duckduckgo" && old?.adapter === adapter ? old.baseUrl : undefined), adapter);
    const id = old?.id ?? `search-${randomUUID()}`;
    const origin = new URL(endpoint).origin;
    const quarantined = old?.adapter === adapter && confirmationRequired(old) && adapter !== "duckduckgo";
    const reusable = old?.adapter === adapter && old.credentialOrigin === origin && !quarantined;
    const credentialRef = key ? `search:${randomUUID()}` : quarantined || reusable ? old?.credentialRef : undefined;
    if (key && credentialRef) {
      await this.#options.harness.commit(async (tx) => { (await tx.doc(MocoSearchDoc)).cleanup[credentialRef] = true; }, BACKGROUND_CONTEXT);
      try { await this.#options.credentials.modify(credentialRef, async () => ({ type: "api_key", key, env: { [ORIGIN_ENV]: origin! } })); }
      catch { fail(500, "search_credential_write_failed", "未能保存搜索 API Key，请重试。"); }
    }
    const plan: StoredPlan = { id, name, adapter, enabled: raw.enabled ?? old?.enabled ?? true, revision: (old?.revision ?? 0) + 1,
      status: "unverified", healthRevision: (old?.healthRevision ?? 0) + 1, transportVersion: 1, requestSequence: 0,
      createdAt: old?.createdAt ?? this.#now(), updatedAt: this.#now(), baseUrl: endpoint, credentialOrigin: !key && quarantined ? old!.credentialOrigin : origin,
      ...(!key && quarantined ? { credentialConfirmationRequired: true } : {}),
      ...(credentialRef ? { credentialRef } : {}) };
    try {
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(MocoSearchDoc);
        if (old) assertRevision(requirePlan(doc, id), old.revision);
        else if (doc.order.length >= MAX_PLANS) fail(400, "search_plan_limit", "搜索方案数量已达到上限。");
        if (old?.credentialRef && old.credentialRef !== credentialRef) doc.cleanup[old.credentialRef] = true;
        if (credentialRef) delete doc.cleanup[credentialRef];
        doc.plans[id] = clone(plan);
        if (!old) doc.order.push(id);
        doc.revision++; doc.healthRevision = (doc.healthRevision ?? 0) + 1;
      }, BACKGROUND_CONTEXT);
    } finally { await this.#cleanup(); }
    return plan;
  }
  async remove(id: string, expectedRevision: number): Promise<SearchSnapshot> {
    const key = identifier(id);
    const revision = expected(expectedRevision);
    await this.#serial(async () => {
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(MocoSearchDoc);
        const plan = requirePlan(doc, key); assertRevision(plan, revision);
        if (plan.credentialRef) doc.cleanup[plan.credentialRef] = true;
        delete doc.plans[key]; doc.order = doc.order.filter((item) => item !== key);
        doc.pendingNativeMigrations = (doc.pendingNativeMigrations ?? []).filter((item) => item !== key); doc.revision++;
      }, BACKGROUND_CONTEXT);
      await this.#cleanup();
    });
    await this.#changed();
    return this.snapshot();
  }
  async reorder(ids: string[], expectedRevision: number): Promise<SearchSnapshot> {
    if (!Array.isArray(ids) || ids.length > MAX_PLANS) fail(400, "invalid_search_order", "搜索方案排序无效。");
    const order = ids.map(identifier);
    const revision = expected(expectedRevision, true);
    await this.#serial(async () => {
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(MocoSearchDoc);
        if (doc.revision !== revision) fail(409, "search_revision_conflict", "搜索方案列表已更新，请刷新后重试。");
        if (order.length !== doc.order.length || new Set(order).size !== order.length || order.some((id) => !own(doc.plans, id))) fail(400, "invalid_search_order", "排序必须包含全部搜索方案，且不能重复。");
        doc.order = [...order]; doc.revision++;
      }, BACKGROUND_CONTEXT);
    });
    await this.#changed();
    return this.snapshot();
  }
  #signal(signal?: AbortSignal): AbortSignal { return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.#options.timeoutMs ?? 90_000)]); }
  async #begin(plan: StoredPlan): Promise<number> {
    let sequence = 0;
    await this.#serial(async () => {
      await this.#options.harness.commit(async (tx) => {
        const current = requirePlan(await tx.doc(MocoSearchDoc), plan.id);
        assertRevision(current, plan.revision);
        sequence = (current.requestSequence ?? 0) + 1; current.requestSequence = sequence;
      }, BACKGROUND_CONTEXT);
    });
    return sequence;
  }
  async #status(plan: StoredPlan, sequence: number, failure?: SearchFailure): Promise<void> {
    let changed = false;
    await this.#serial(async () => {
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(MocoSearchDoc);
        const current = own(doc.plans, plan.id);
        // Only the latest started request may publish health, independently of configuration CAS.
        if (!current || current.revision !== plan.revision || current.requestSequence !== sequence) return;
        current.status = failure ? failure.kind === "auth" ? "needs_auth" : "error" : "ready";
        current.lastCheckedAt = this.#now();
        current.healthRevision = (current.healthRevision ?? 0) + 1; doc.healthRevision = (doc.healthRevision ?? 0) + 1;
        if (failure) { current.error = failure.message; current.failure = clone(failure); }
        else { delete current.error; delete current.failure; }
        changed = true;
      }, BACKGROUND_CONTEXT);
    });
    if (changed) await this.#changed();
  }
  async #run(plan: StoredPlan, input: WebSearchInput, overall: AbortSignal): Promise<Omit<WebSearchResult, "attempts">> {
    const signal = AbortSignal.any([overall, AbortSignal.timeout(this.#options.attemptTimeoutMs ?? 30_000)]);
    const sequence = await this.#begin(plan);
    let key: string | undefined;
    try {
      const result = await abortable(async () => {
        const view = await this.#view(plan);
        if (confirmationRequired(plan) || (plan.adapter === "tavily" || plan.adapter === "brave") && !view.hasCredential) {
          const failure: SearchFailure = { kind: "auth", message: view.error ?? "搜索方案需要连接凭证。", retryable: false };
          throw new SearchError(409, "search_credential_missing", failure.message, failure);
        }
        key = await this.#key(plan);
        const result = await runSearchAdapter({ plan: view, apiKey: key, input, signal, fetch: this.#options.fetch, stateDir: this.#options.stateDir });
        if (!result.sources.length && result.answer) {
          const failure: SearchFailure = { kind: "ungrounded", message: FAILURE_MESSAGES.ungrounded, retryable: false };
          throw new SearchError(502, "search_ungrounded", failure.message, failure);
        }
        return result;
      }, signal);
      assertActive(overall);
      await this.#status(plan, sequence);
      return { query: input.query, planId: plan.id, planName: plan.name, ...result };
    } catch (error) {
      if (overall.aborted && (overall.reason as { name?: string } | undefined)?.name !== "TimeoutError") overall.throwIfAborted();
      const failure = signal.aborted ? timeoutFailure() : failureValue(error, key);
      await this.#status(plan, sequence, failure);
      throw new SearchError(error instanceof SearchError && error.code === "search_credential_missing" ? 409 : failureStatus(failure), "search_plan_failed", failure.message, failure);
    }
  }
  async test(id: string, expectedRevision?: number, signal?: AbortSignal): Promise<WebSearchResult> {
    const plan = clone(requirePlan(await this.#state(), identifier(id)));
    if (expectedRevision !== undefined) assertRevision(plan, expected(expectedRevision));
    const overall = this.#signal(signal);
    try {
      const result = await this.#run(plan, { query: "OpenAI official API documentation", maxResults: 3 }, overall);
      const failure = !result.sources.length ? { kind: "no_results" as const, message: FAILURE_MESSAGES.no_results, retryable: false } : undefined;
      return { ...result, attempts: [{ planId: plan.id, name: plan.name, ...(failure ? { failure } : {}) }] };
    } catch (error) {
      if (overall.aborted && (overall.reason as { name?: string } | undefined)?.name !== "TimeoutError") overall.throwIfAborted();
      const failure = failureValue(error);
      throw new SearchError(error instanceof SearchError ? error.status : failureStatus(failure), error instanceof SearchError ? error.code : "search_plan_failed", failure.message,
        failure, [{ planId: plan.id, name: plan.name, error: failure.message, failure }]);
    }
  }
  async search(raw: WebSearchInput, signal?: AbortSignal): Promise<WebSearchResult> {
    const input = inputValue(raw);
    const overall = this.#signal(signal); assertActive(overall);
    const state = await this.#state();
    const plans = (state?.order ?? []).map((id) => clone(requirePlan(state, id))).filter((plan) => plan.enabled);
    if (!plans.length) fail(409, "search_not_configured", "尚未启用搜索方案，请前往设置 → 能力与技能 → 搜索添加。");
    const attempts: SearchAttempt[] = [];
    let empty: Omit<WebSearchResult, "attempts"> | undefined;
    for (const plan of plans) {
      assertActive(overall, attempts);
      try {
        const result = await this.#run(plan, input, overall);
        if (result.sources.length) return { ...result, attempts: [...attempts, { planId: plan.id, name: plan.name }] };
        empty ??= result;
        attempts.push({ planId: plan.id, name: plan.name, failure: { kind: "no_results", message: FAILURE_MESSAGES.no_results, retryable: false } });
      } catch (error) {
        const failure = failureValue(error);
        attempts.push({ planId: plan.id, name: plan.name, error: failure.message, failure });
        assertActive(overall, attempts);
      }
    }
    if (empty) return { ...empty, attempts };
    const failure = attempts.at(-1)?.failure ?? { kind: "unknown", message: FAILURE_MESSAGES.unknown, retryable: true };
    throw new SearchError(failureStatus(failure), "search_all_failed", "所有搜索方案均未成功，请检查各方案的连接状态。", failure, attempts);
  }
  async fetch(url: string, signal?: AbortSignal): Promise<WebPageResult> {
    const overall = this.#signal(signal); assertActive(overall);
    const state = await this.#state();
    const candidates = (state?.order ?? []).map((id) => clone(requirePlan(state, id))).filter((plan) => plan.enabled);
    const attempts: SearchAttempt[] = [];
    for (const plan of candidates) {
      const key = await this.#key(plan);
      try {
        const view = await this.#view(plan);
        if (confirmationRequired(plan) || (plan.adapter === "tavily" || plan.adapter === "brave") && !view.hasCredential) continue;
        const attempt = AbortSignal.any([overall, AbortSignal.timeout(this.#options.attemptTimeoutMs ?? 30_000)]);
        const page = await abortable(() => fetchSearchPageAdapter({ plan: view, apiKey: key, signal: attempt, fetch: this.#options.fetch, stateDir: this.#options.stateDir }, url), attempt);
        if (page) return page;
      } catch (error) {
        if (overall.aborted && (overall.reason as { name?: string } | undefined)?.name !== "TimeoutError") overall.throwIfAborted();
        const failure = failureValue(error, key);
        attempts.push({ planId: plan.id, name: plan.name, error: failure.message, failure });
        assertActive(overall, attempts);
      }
    }
    try {
      return await abortable(() => fetchWebPage({ url, signal: overall, fetch: this.#options.pageFetch }), overall);
    } catch (error) {
      assertActive(overall, attempts);
      const failure = failureValue(error);
      throw new SearchError(failureStatus(failure), "web_fetch_failed", "网页读取失败。", failure, attempts);
    }
  }
  async close(): Promise<void> { await this.#tail; }
}
