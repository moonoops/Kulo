import { describe, expect, it, vi } from "vitest";
import {
  isWebApplicationActionReadOnly,
  validateWebApplicationOperation,
  WEB_CONNECTION_APPLICATIONS,
  WebConnectionApplications,
} from "../packages/hub/src/connection-web-apps.js";

const token = "synthetic-web-application-token-54321";
const secrets = { apiKey: token };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const issue = { number: 17, title: "修复问题", body: "内容", state: "open", html_url: "https://github.com/owner/repo/issues/17", user: { login: "tester" } };
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, apps: new WebConnectionApplications({ fetch }) };
}

describe("GitHub and Figma application connections", () => {
  it("declares only supported fixed actions and their authoritative read/write boundary", () => {
    expect(WEB_CONNECTION_APPLICATIONS.map((item) => item.id)).toEqual(["github", "figma"]);
    expect(isWebApplicationActionReadOnly("github", "list_issues")).toBe(true);
    expect(isWebApplicationActionReadOnly("github", "read_issue")).toBe(true);
    expect(isWebApplicationActionReadOnly("github", "create_issue")).toBe(false);
    expect(isWebApplicationActionReadOnly("github", "comment_issue")).toBe(false);
    expect(isWebApplicationActionReadOnly("figma", "read_file")).toBe(true);
    expect(isWebApplicationActionReadOnly("figma", "create_comment")).toBe(false);
    expect(() => isWebApplicationActionReadOnly("figma", "edit_nodes")).toThrow("不支持");
    expect(() => isWebApplicationActionReadOnly("other", "read")).toThrow("不支持");
    expect(WEB_CONNECTION_APPLICATIONS[1]!.instructions.join(" ")).toContain("file_comments:write");
  });

  it("authenticates GitHub with a real user endpoint and keeps the token in a fixed-host header", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ login: "tester", email: "private@example.test" }));
    expect(await f.apps.probe("github", secrets)).toEqual({ username: "tester" });
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/user");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    const headers = new Headers(init!.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(headers.get("x-figma-token")).toBeNull();
    expect(String(url)).not.toContain(token);
  });

  it("authenticates Figma through GET me with X-Figma-Token and never returns the credential", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ handle: "设计师", id: "1", email: "private@example.test" }));
    expect(await f.apps.probe("figma", secrets, undefined, { requestPermission: true })).toEqual({ username: "设计师" });
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.figma.com/v1/me");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    const headers = new Headers(init!.headers);
    expect(headers.get("x-figma-token")).toBe(token);
    expect(headers.get("authorization")).toBeNull();
    f.fetch.mockResolvedValueOnce(json({ handle: token }));
    expect(JSON.stringify(await f.apps.probe("figma", secrets))).not.toContain(token);
  });

  it("lists GitHub issues with bounded explicit pagination and compact safe fields", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json([{ ...issue, repository: { temp_clone_token: "omit-this" } }]));
    const result = await f.apps.execute("github", secrets, { kind: "app", action: "list_issues", params: { owner: "owner", repo: ".github", state: "all", limit: 2, page: 3 } });
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/owner/.github/issues?state=all&per_page=2&page=3");
    expect(init!.method).toBe("GET");
    expect(JSON.parse(result.output)).toMatchObject({ issues: [{ number: 17, title: "修复问题", isPullRequest: false }], page: 3, limit: 2, hasMore: false });
    expect(result.output).not.toContain("omit-this");
    const page = json([issue]); page.headers.set("link", '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"');
    f.fetch.mockResolvedValueOnce(page);
    const next = await f.apps.execute("github", secrets, { kind: "app", action: "list_issues", params: { owner: "owner", repo: "repo", limit: 1 } });
    expect(JSON.parse(next.output).hasMore).toBe(true);
  });

  it("reads a GitHub issue using its repository and integer issue number", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json(issue));
    const result = await f.apps.execute("github", secrets, { kind: "app", action: "read_issue", params: { owner: "owner", repo: "repo", issue_number: 17 } });
    expect(String(f.fetch.mock.calls[0]![0])).toBe("https://api.github.com/repos/owner/repo/issues/17");
    expect(JSON.parse(result.output)).toMatchObject({ number: 17, body: "内容" });
  });

  it("creates a GitHub issue with the documented POST payload and redacts echoed secrets", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ ...issue, body: `Echo ${token}` }, 201));
    const result = await f.apps.execute("github", secrets, { kind: "app", action: "create_issue", params: { owner: "owner", repo: "repo", title: "修复问题", body: "问题说明\n第二行" } });
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/owner/repo/issues");
    expect(init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify({ title: "修复问题", body: "问题说明\n第二行" }) });
    expect(new Headers(init!.headers).get("content-type")).toBe("application/json");
    expect(result.status).toBe(201);
    expect(result.output).not.toContain(token);
    expect(JSON.parse(result.output)).toMatchObject({ number: 17 });
  });

  it("writes a GitHub issue comment with only the selected body", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ id: 99, body: "已处理", user: { login: "tester" } }, 201));
    const result = await f.apps.execute("github", secrets, { kind: "app", action: "comment_issue", params: { owner: "owner", repo: "repo", issue_number: 17, body: "已处理" } });
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/owner/repo/issues/17/comments");
    expect(init).toMatchObject({ method: "POST", body: '{"body":"已处理"}' });
    expect(JSON.parse(result.output)).toMatchObject({ id: 99, message: "已处理" });
  });

  it("reads Figma file depth and selected node IDs without arbitrary URL passthrough", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(json({ name: "设计文件", version: "v1", document: { id: "0:0", children: [] } }));
    const result = await f.apps.execute("figma", secrets, { kind: "app", action: "read_file", params: { file_key: "File_key-12" } });
    expect(String(f.fetch.mock.calls[0]![0])).toBe("https://api.figma.com/v1/files/File_key-12?depth=2");
    expect(JSON.parse(result.output)).toMatchObject({ name: "设计文件", depth: 2, document: { id: "0:0" } });
    f.fetch.mockResolvedValueOnce(json({ nodes: { "1:2": { document: { id: "1:2", type: "FRAME" } } } }));
    await f.apps.execute("figma", secrets, { kind: "app", action: "read_nodes", params: { file_key: "File_key-12", ids: ["1:2", "I2:3;4:5"], depth: 1 } });
    const url = new URL(String(f.fetch.mock.calls[1]![0]));
    expect(url.origin).toBe("https://api.figma.com");
    expect(url.pathname).toBe("/v1/files/File_key-12/nodes");
    expect(url.searchParams.get("ids")).toBe("1:2,I2:3;4:5");
    expect(url.searchParams.get("depth")).toBe("1");
  });

  it("reads bounded Figma comments and posts or replies with the official JSON payload", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(json({ comments: [{ id: "1", message: "第一条", user: { handle: "A" } }, { id: "2", message: "第二条" }] }));
    const listed = await f.apps.execute("figma", secrets, { kind: "app", action: "list_comments", params: { file_key: "FileKey", limit: 1 } });
    expect(String(f.fetch.mock.calls[0]![0])).toBe("https://api.figma.com/v1/files/FileKey/comments?as_md=true");
    expect(JSON.parse(listed.output)).toMatchObject({ comments: [{ id: "1", message: "第一条" }], total: 2, truncated: true });
    f.fetch.mockResolvedValueOnce(json({ id: "3", message: "回复", parent_id: "1", user: { handle: "B" } }));
    const written = await f.apps.execute("figma", secrets, { kind: "app", action: "create_comment", params: { file_key: "FileKey", message: "回复", comment_id: "1" } });
    expect(f.fetch.mock.calls[1]![1]).toMatchObject({ method: "POST", body: '{"message":"回复","comment_id":"1"}', redirect: "error" });
    expect(JSON.parse(written.output)).toMatchObject({ id: "3", parentId: "1" });
  });

  it("fails closed on unknown app/actions, extra parameters, traversal and unbounded pagination before fetch", async () => {
    const f = fixture();
    const github = (params: Record<string, unknown>) => f.apps.execute("github", secrets, { kind: "app", action: "list_issues", params });
    for (const params of [
      { owner: "owner", repo: "repo", url: "https://evil.example" },
      { owner: "owner", repo: "repo", headers: { authorization: "other" } },
      { owner: "owner/../../user", repo: "repo" }, { owner: "owner", repo: ".." },
      { owner: "owner", repo: "repo", limit: 101 }, { owner: "owner", repo: "repo", page: 11 },
      { owner: "owner", repo: "repo", state: "delete" },
    ]) await expect(github(params)).rejects.toThrow();
    await expect(f.apps.execute("figma", secrets, { kind: "app", action: "edit_nodes", params: { file_key: "FileKey" } })).rejects.toThrow("不支持");
    await expect(f.apps.execute("figma", secrets, { kind: "app", action: "read_file", params: { file_key: "https://evil.example", depth: 2 } })).rejects.toThrow();
    await expect(f.apps.execute("figma", secrets, { kind: "app", action: "read_nodes", params: { file_key: "FileKey", ids: Array.from({ length: 51 }, () => "1:2") } })).rejects.toThrow();
    await expect(f.apps.execute("figma", secrets, { kind: "app", action: "read_file", params: { file_key: "FileKey", depth: 11 } })).rejects.toThrow();
    await expect(f.apps.probe("other", secrets)).rejects.toThrow("不支持");
    expect(() => validateWebApplicationOperation("github", { kind: "app", action: "list_issues", params: JSON.parse('{"owner":"owner","repo":"repo","__proto__":{}}') })).toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("refuses missing and malformed credentials before network access", async () => {
    const f = fixture();
    for (const apiKey of [undefined, "", "   ", "a token", "token\r\nHeader: x"]) {
      await expect(f.apps.probe("github", { apiKey })).rejects.toThrow("Token");
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not follow redirects or return secret-bearing platform error bodies", async () => {
    const f = fixture();
    for (const status of [401, 403, 404, 429, 500]) {
      f.fetch.mockResolvedValueOnce(json({ error: token }, status));
      const error = await f.apps.probe("github", secrets).catch((value: Error) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(token);
    }
    f.fetch.mockResolvedValueOnce(new Response(token, { status: 302, headers: { location: "https://evil.example/collect" } }));
    await expect(f.apps.probe("figma", secrets)).rejects.toMatchObject({ code: "connection_app_redirect_blocked" });
    expect(f.fetch.mock.calls.every(([url, init]) => ["https://api.github.com", "https://api.figma.com"].includes(new URL(String(url)).origin) && init?.redirect === "error")).toBe(true);
    f.fetch.mockRejectedValueOnce(new Error(token));
    await expect(f.apps.probe("github", secrets)).rejects.not.toThrow(token);
  });

  it("marks writes with a lost or malformed receipt as unconfirmed without retrying", async () => {
    const f = fixture();
    const operation = { kind: "app" as const, action: "create_issue", params: { owner: "owner", repo: "repo", title: "确认写入" } };
    f.fetch.mockRejectedValueOnce(new Error(`network ${token}`));
    await expect(f.apps.execute("github", secrets, operation)).rejects.toMatchObject({ code: "connection_app_write_unconfirmed" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.fetch.mockResolvedValueOnce(json({ wrong: token }, 201));
    await expect(f.apps.execute("github", secrets, operation)).rejects.toMatchObject({ code: "connection_app_write_unconfirmed" });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.fetch.mockResolvedValueOnce(json({ error: token }, 503));
    await expect(f.apps.execute("github", secrets, operation)).rejects.toMatchObject({ code: "connection_app_write_unconfirmed" });
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it("bounds response bytes and encoded output length while preserving an explicit truncation receipt", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response("{}", { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }));
    await expect(f.apps.probe("github", secrets)).rejects.toMatchObject({ code: "connection_app_response_too_large" });
    const bytes = new Uint8Array(4 * 1024 * 1024 + 1);
    f.fetch.mockResolvedValueOnce(new Response(bytes));
    await expect(f.apps.probe("github", secrets)).rejects.toMatchObject({ code: "connection_app_response_too_large" });
    f.fetch.mockResolvedValueOnce(json({ document: { id: "0:0", many: Array.from({ length: 40_000 }, () => '\\"') } }));
    const result = await f.apps.execute("figma", secrets, { kind: "app", action: "read_file", params: { file_key: "FileKey" } });
    expect(result.output.length).toBeLessThanOrEqual(64_000);
    expect(JSON.parse(result.output)).toMatchObject({ truncated: true });
  });

  it("cancels before dispatch and during body reading without exposing errors or credentials", async () => {
    const f = fixture();
    const pre = new AbortController(); pre.abort();
    await expect(f.apps.probe("github", secrets, pre.signal)).rejects.toMatchObject({ code: "connection_app_cancelled" });
    expect(f.fetch).not.toHaveBeenCalled();
    const during = new AbortController();
    const cancelled = vi.fn();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const stream = new ReadableStream({ pull() { started(); }, cancel: cancelled });
    f.fetch.mockResolvedValueOnce(new Response(stream));
    const request = f.apps.probe("figma", secrets, during.signal);
    await reading; during.abort();
    await expect(request).rejects.toMatchObject({ code: "connection_app_cancelled" });
    expect(cancelled).toHaveBeenCalled();
  });
});
