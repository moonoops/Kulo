import {
  redactSensitiveText,
  type ConnectionApplicationDefinition,
  type ConnectionSecrets,
  type ConnectionUseOperation,
} from "@moco/protocol";

export type WebConnectionApplicationId = "github" | "figma";
type AppOperation = Extract<ConnectionUseOperation, { kind: "app" }>;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 64_000;
const origins = { github: "https://api.github.com", figma: "https://api.figma.com" } as const;

// PAT scopes and endpoint payloads follow the linked official documentation; Figma REST writes are comments only.
export const WEB_CONNECTION_APPLICATIONS: ConnectionApplicationDefinition[] = [
  {
    id: "github", name: "GitHub", description: "读取与管理议题", authentication: "token",
    helpUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    instructions: [
      "打开 GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens，创建 Token。",
      "选择需要的仓库。Issues 设为 Read-only；需要创建 Issue 或评论时设为 Read and write。",
      "将 Token 填入保密输入框。组织仓库可能需要管理员批准。",
    ],
    actions: [
      { id: "list_issues", label: "查看 Issue 列表", readOnly: true, parameters: "owner、repo 必填；state?: open|closed|all；limit?: 1..100，默认30；page?: 1..10，默认1。" },
      { id: "read_issue", label: "读取 Issue", readOnly: true, parameters: "owner、repo、issue_number（正整数）必填。" },
      { id: "create_issue", label: "创建 Issue", readOnly: false, parameters: "owner、repo、title（单行，最多256字）必填；body?: 最多32000字。" },
      { id: "comment_issue", label: "发表 Issue 评论", readOnly: false, parameters: "owner、repo、issue_number（正整数）、body（非空，最多32000字）必填。" },
    ],
  },
  {
    id: "figma", name: "Figma", description: "读取文件和节点，查看与发表评论。", authentication: "token",
    helpUrl: "https://developers.figma.com/docs/rest-api/personal-access-tokens/",
    instructions: [
      "打开 Figma 文件首页的账号菜单 → Settings → Security → Personal access tokens → Generate new token。",
      "选择 current_user:read、file_content:read、file_comments:read；需要发表评论时增加 file_comments:write。",
      "设置有效期，将生成的 Token 填入保密输入框。",
    ],
    actions: [
      { id: "read_file", label: "读取文件", readOnly: true, parameters: "file_key（文件标识，非完整URL）必填；depth?: 1..10，默认2。" },
      { id: "read_nodes", label: "读取节点", readOnly: true, parameters: "file_key、ids（1..50个节点ID的字符串数组，例如[\"1:2\"]）必填；depth?: 1..10，默认2。" },
      { id: "list_comments", label: "查看评论", readOnly: true, parameters: "file_key 必填；limit?: 1..100，默认30，仅限制本地返回数量。" },
      { id: "create_comment", label: "发表评论", readOnly: false, parameters: "file_key、message（非空，最多32000字）必填；comment_id?: 回复的根评论ID。" },
    ],
  },
];

export class WebConnectionApplicationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "WebConnectionApplicationError"; }
}
function fail(message: string, code = "connection_app_invalid_input", status = 400): never {
  throw new WebConnectionApplicationError(code, message, status);
}
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function appId(value: unknown): WebConnectionApplicationId {
  if (value !== "github" && value !== "figma") fail("此应用不支持网页 API 操作。", "connection_app_unsupported");
  return value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("应用操作包含不支持的参数。");
}
function text(value: unknown, label: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() && !optional || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`${label}无效。`);
  return value;
}
function segment(value: unknown, label: string, pattern: RegExp, max = 128): string {
  const result = text(value, label, max)!;
  if (!pattern.test(result) || result === "." || result === "..") fail(`${label}无效。`);
  return result;
}
function integer(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(`${label}无效。`);
  return value as number;
}

export function isWebApplicationActionReadOnly(id: string, action: string): boolean {
  const selected = WEB_CONNECTION_APPLICATIONS.find((item) => item.id === appId(id))?.actions.find((item) => item.id === action);
  if (!selected) fail("此应用不支持该操作。", "connection_app_action_unsupported");
  return selected.readOnly;
}

/** Validates action-specific parameters before any request or credential access. No URL/header passthrough exists. */
export function validateWebApplicationOperation(id: string, operation: AppOperation): AppOperation {
  const selectedApp = appId(id);
  if (!record(operation) || operation.kind !== "app" || typeof operation.action !== "string") fail("应用操作格式无效。");
  keys(operation, ["kind", "action", "params"]);
  isWebApplicationActionReadOnly(selectedApp, operation.action);
  const input = operation.params ?? {};
  if (!record(input)) fail("应用操作参数应为对象。");
  let params: Record<string, unknown>;
  if (selectedApp === "github") {
    const common = { owner: segment(input.owner, "仓库所有者", /^[A-Za-z0-9][A-Za-z0-9-]*$/, 39), repo: segment(input.repo, "仓库名", /^[A-Za-z0-9_.-]+$/, 100) };
    if (operation.action === "list_issues") {
      keys(input, ["owner", "repo", "state", "limit", "page"]);
      const state = input.state ?? "open";
      if (state !== "open" && state !== "closed" && state !== "all") fail("Issue 状态无效。");
      params = { ...common, state, limit: integer(input.limit, "结果数量", 1, 100, 30), page: integer(input.page, "页码", 1, 10, 1) };
    } else if (operation.action === "read_issue") {
      keys(input, ["owner", "repo", "issue_number"]);
      params = { ...common, issue_number: integer(input.issue_number, "Issue 编号", 1, Number.MAX_SAFE_INTEGER) };
    } else if (operation.action === "create_issue") {
      keys(input, ["owner", "repo", "title", "body"]);
      const title = text(input.title, "Issue 标题", 256)!;
      if (/[\r\n\t]/.test(title)) fail("Issue 标题应为单行。");
      const body = text(input.body, "Issue 内容", 32_000, true);
      params = { ...common, title, ...(body !== undefined ? { body } : {}) };
    } else {
      keys(input, ["owner", "repo", "issue_number", "body"]);
      params = { ...common, issue_number: integer(input.issue_number, "Issue 编号", 1, Number.MAX_SAFE_INTEGER), body: text(input.body, "评论内容", 32_000)! };
    }
  } else {
    const file_key = segment(input.file_key, "Figma 文件标识", /^[A-Za-z0-9_-]+$/);
    if (operation.action === "read_file") {
      keys(input, ["file_key", "depth"]);
      params = { file_key, depth: integer(input.depth, "节点深度", 1, 10, 2) };
    } else if (operation.action === "read_nodes") {
      keys(input, ["file_key", "ids", "depth"]);
      if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 50) fail("请选择 1 到 50 个 Figma 节点。");
      const ids = [...new Set(input.ids.map((value) => segment(value, "Figma 节点标识", /^[A-Za-z0-9_:;-]+$/)))];
      params = { file_key, ids, depth: integer(input.depth, "节点深度", 1, 10, 2) };
    } else if (operation.action === "list_comments") {
      keys(input, ["file_key", "limit"]);
      params = { file_key, limit: integer(input.limit, "结果数量", 1, 100, 30) };
    } else {
      keys(input, ["file_key", "message", "comment_id"]);
      const commentId = input.comment_id === undefined ? undefined : segment(input.comment_id, "评论标识", /^[A-Za-z0-9_-]+$/);
      params = { file_key, message: text(input.message, "评论内容", 32_000)!, ...(commentId !== undefined ? { comment_id: commentId } : {}) };
    }
  }
  return { kind: "app", action: operation.action, params };
}

function invalidResponse(): never { return fail("平台返回的数据格式无效。", "connection_app_response_invalid", 502); }
function issue(value: unknown, compact = false): Record<string, unknown> {
  if (!record(value) || !Number.isSafeInteger(value.number) || (value.number as number) < 1 || typeof value.title !== "string") invalidResponse();
  const body = typeof value.body === "string" ? value.body : "";
  const max = compact ? 512 : 32_000;
  return { number: value.number, title: value.title, state: value.state, body: body.slice(0, max), ...(body.length > max ? { bodyTruncated: true } : {}),
    url: value.html_url, author: record(value.user) ? value.user.login : undefined, comments: value.comments, isPullRequest: Boolean(value.pull_request),
    createdAt: value.created_at, updatedAt: value.updated_at };
}
function comment(value: unknown, id: WebConnectionApplicationId): Record<string, unknown> {
  if (!record(value) || id === "github" && (!Number.isSafeInteger(value.id) || (value.id as number) < 1) || id === "figma" && (typeof value.id !== "string" || !value.id)) invalidResponse();
  const message = id === "github" ? value.body : value.message;
  if (typeof message !== "string") invalidResponse();
  return { id: value.id, message: message.slice(0, 32_000), ...(message.length > 32_000 ? { messageTruncated: true } : {}),
    author: record(value.user) ? id === "github" ? value.user.login : value.user.handle : undefined,
    createdAt: value.created_at, ...(id === "figma" ? { parentId: value.parent_id, resolvedAt: value.resolved_at, position: value.client_meta } : { url: value.html_url }) };
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_RESPONSE_BYTES) { await response.body?.cancel(); fail("平台响应过大，请缩小读取范围。", "connection_app_response_too_large", 413); }
  const reader = response.body?.getReader();
  if (!reader) invalidResponse();
  const chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => { /* Cancellation cleanup must not replace the safe operation error. */ }); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); fail("平台响应过大，请缩小读取范围。", "connection_app_response_too_large", 413); }
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { return invalidResponse(); }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

export class WebConnectionApplications {
  readonly #fetch: typeof globalThis.fetch;
  constructor(options: { fetch?: typeof globalThis.fetch } = {}) { this.#fetch = options.fetch ?? globalThis.fetch; }

  #token(secrets: ConnectionSecrets): string {
    const value = secrets.apiKey;
    if (typeof value !== "string" || !value.trim() || value.length > 16_384 || /[\x00-\x1f\x7f]/.test(value) || !/^[\x21-\x7e]+$/.test(value.trim())) fail("请填写有效的个人访问 Token。", "connection_app_credential_missing", 409);
    return value.trim();
  }
  #redact(value: string, secrets: ConnectionSecrets): string {
    return redactSensitiveText(value, Object.values(secrets).filter((item): item is string => typeof item === "string" && Boolean(item)).flatMap((item) => [item, item.trim()]));
  }
  #output(value: unknown, secrets: ConnectionSecrets): string {
    const encoded = this.#redact(JSON.stringify(value), secrets);
    // The JSON wrapper escapes the already encoded prefix again; leave room for a worst-case doubling.
    return encoded.length <= MAX_OUTPUT_CHARS ? encoded : JSON.stringify({ truncated: true, content: encoded.slice(0, 28_000) });
  }
  async #request(id: WebConnectionApplicationId, secrets: ConnectionSecrets, path: string, method: "GET" | "POST", body: unknown, signal?: AbortSignal): Promise<{ data: unknown; status: number; hasNextPage: boolean }> {
    if (signal?.aborted) fail("应用操作已取消。", "connection_app_cancelled", 409);
    const token = this.#token(secrets);
    const url = new URL(path, origins[id]);
    if (url.origin !== origins[id] || url.protocol !== "https:") fail("应用 API 地址无效。");
    const headers = new Headers({ Accept: id === "github" ? "application/vnd.github+json" : "application/json" });
    if (id === "github") { headers.set("Authorization", `Bearer ${token}`); headers.set("X-GitHub-Api-Version", "2026-03-10"); headers.set("User-Agent", "Moco"); }
    else headers.set("X-Figma-Token", token);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
    let response: Response;
    try { response = await this.#fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: requestSignal }); }
    catch {
      if (method === "POST") fail("平台操作结果尚未确认，请先检查平台记录后再重试。", "connection_app_write_unconfirmed", 502);
      if (requestSignal.aborted) fail("应用操作已取消或超时。", "connection_app_cancelled", 409);
      fail("无法连接应用，请检查网络后重试。", "connection_app_unavailable", 502);
    }
    if (response.redirected || response.url && new URL(response.url).origin !== origins[id] || response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); fail("平台返回重定向，未继续发送凭据。", "connection_app_redirect_blocked", 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (method === "POST" && response.status >= 500) fail("平台操作结果尚未确认，请先检查平台记录后再重试。", "connection_app_write_unconfirmed", 502);
      if (response.status === 401 || response.status === 403) fail("应用授权无效或权限不足，请更新 Token。", "connection_app_authorization_failed", response.status);
      if (response.status === 404) fail("目标资源不存在或当前账号无权访问。", "connection_app_resource_unavailable", 404);
      if (response.status === 429) fail("应用调用频率受限，请稍后再试。", "connection_app_rate_limited", 429);
      fail("应用操作失败，请检查参数和平台状态。", "connection_app_request_failed", response.status >= 400 ? response.status : 502);
    }
    try { return { data: await readJson(response, requestSignal), status: response.status, hasNextPage: /;\s*rel="next"/i.test(response.headers.get("link") ?? "") }; }
    catch (error) {
      if (method === "POST") fail("平台操作结果尚未确认，请先检查平台记录后再重试。", "connection_app_write_unconfirmed", 502);
      if (error instanceof WebConnectionApplicationError) throw error;
      if (requestSignal.aborted) fail("应用操作已取消或超时。", "connection_app_cancelled", 409);
      invalidResponse();
    }
  }

  async probe(id: string, secrets: ConnectionSecrets, signal?: AbortSignal, _options?: { requestPermission?: boolean }): Promise<{ username?: string }> {
    const selected = appId(id);
    const { data } = await this.#request(selected, secrets, selected === "github" ? "/user" : "/v1/me", "GET", undefined, signal);
    const username = record(data) ? selected === "github" ? data.login : data.handle : undefined;
    if (typeof username !== "string" || !username.trim() || username.length > 256) invalidResponse();
    return { username: this.#redact(username, secrets) };
  }

  async execute(id: string, secrets: ConnectionSecrets, operation: AppOperation, signal?: AbortSignal): Promise<{ kind: "app"; output: string; status?: number }> {
    const selected = appId(id);
    const validated = validateWebApplicationOperation(selected, operation);
    const p = validated.params!;
    let path: string; let method: "GET" | "POST" = "GET"; let body: unknown;
    if (selected === "github") {
      const root = `/repos/${encodeURIComponent(p.owner as string)}/${encodeURIComponent(p.repo as string)}/issues`;
      if (validated.action === "list_issues") path = `${root}?${new URLSearchParams({ state: p.state as string, per_page: String(p.limit), page: String(p.page) })}`;
      else if (validated.action === "read_issue") path = `${root}/${p.issue_number}`;
      else if (validated.action === "create_issue") { path = root; method = "POST"; body = { title: p.title, ...(p.body !== undefined ? { body: p.body } : {}) }; }
      else { path = `${root}/${p.issue_number}/comments`; method = "POST"; body = { body: p.body }; }
    } else {
      const root = `/v1/files/${encodeURIComponent(p.file_key as string)}`;
      if (validated.action === "read_file") path = `${root}?depth=${p.depth}`;
      else if (validated.action === "read_nodes") path = `${root}/nodes?${new URLSearchParams({ ids: (p.ids as string[]).join(","), depth: String(p.depth) })}`;
      else if (validated.action === "list_comments") path = `${root}/comments?as_md=true`;
      else { path = `${root}/comments`; method = "POST"; body = { message: p.message, ...(p.comment_id !== undefined ? { comment_id: p.comment_id } : {}) }; }
    }
    const response = await this.#request(selected, secrets, path, method, body, signal);
    let output: unknown;
    try {
      if (selected === "github") {
        if (validated.action === "list_issues") {
          if (!Array.isArray(response.data)) invalidResponse();
          output = { issues: response.data.slice(0, p.limit as number).map((item) => issue(item, true)), page: p.page, limit: p.limit, hasMore: response.hasNextPage };
        } else output = validated.action === "comment_issue" ? comment(response.data, selected) : issue(response.data);
      } else if (validated.action === "list_comments") {
        if (!record(response.data) || !Array.isArray(response.data.comments)) invalidResponse();
        output = { comments: response.data.comments.slice(0, p.limit as number).map((item) => comment(item, selected)), total: response.data.comments.length, truncated: response.data.comments.length > (p.limit as number) };
      } else if (validated.action === "create_comment") output = comment(response.data, selected);
      else {
        if (!record(response.data) || validated.action === "read_file" && !record(response.data.document) || validated.action === "read_nodes" && !record(response.data.nodes)) invalidResponse();
        output = { name: response.data.name, lastModified: response.data.lastModified, version: response.data.version, depth: p.depth,
          ...(validated.action === "read_file" ? { document: response.data.document } : { nodes: response.data.nodes }) };
      }
    } catch (error) {
      if (method === "POST") fail("平台操作结果尚未确认，请先检查平台记录后再重试。", "connection_app_write_unconfirmed", 502);
      throw error;
    }
    return { kind: "app", status: response.status, output: this.#output(output, secrets) };
  }
}
