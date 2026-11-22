import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RolePreset, TicketRecord } from "@kulo/protocol";
import { startExternalAgentMcp, type ExternalAgentMcpServer } from "../packages/env/src/external-agent-mcp.js";
import { createExternalAgentToolHandler, externalAgentCollaborationFingerprint, type ExternalAgentToolCall, type ExternalAgentToolHost, type ExternalAgentToolSnapshot } from "../packages/hub/src/external-agent-tools.js";

const bridges: ExternalAgentMcpServer[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.close())); });

const scope = { envId: "local", runId: "run-1", taskId: "T-0001", runEpoch: 1 };
const role: RolePreset = { id: "external-coder", label: "Codex", whenToUse: "Code", prompt: "Work on this task", enabled: true, allowSubagents: true };
function fixture() {
  const snapshot: ExternalAgentToolSnapshot = {
    ticket: { id: scope.taskId, commandId: "dispatch-1", title: "Implement feature", goal: "Add a bounded feature", scope: "src", role: role.id, status: "running", envId: "local", workspaceDir: "/project", workerConversationId: 12, runEpoch: 1, createdAt: 1, updatedAt: 1, originConversationId: 99,
      externalExecution: { binding: { kind: "codex", envId: "local" }, runId: scope.runId } } satisfies TicketRecord,
    role: { ...role }, maxSubagents: 2, children: {},
  };
  const host: ExternalAgentToolHost = {
    read: vi.fn(async () => structuredClone(snapshot)),
    agents: vi.fn(async () => [{ id: "checker", label: "Checker", whenToUse: "Review code", readOnly: true }, { id: "coder", label: "Coder", whenToUse: "Write code", readOnly: false }, { id: "remote", label: "Remote", whenToUse: "Remote", readOnly: true, envId: "server" }]),
    report: vi.fn(async (_scope, report) => ({ recorded: true, state: report.state })),
    delegate: vi.fn(async (_scope, request) => { snapshot.children[request.requestId] = { taskId: "T-0002", fingerprint: request.fingerprint }; return { taskId: "T-0002", state: "queued" }; }),
    inspect: vi.fn(async (_scope, childId) => ({ taskId: childId, state: "completed", summary: "Reviewed" })),
  };
  const invoke = (name: string, args: Record<string, unknown> = {}, extra: Partial<ExternalAgentToolCall> = {}) => createExternalAgentToolHandler(host)({ ...scope, name, args, ...extra });
  return { snapshot, host, invoke };
}

describe("task-scoped external agent tools", () => {
  it("returns only the authorized task brief, without the main conversation or credentials", async () => {
    const { invoke } = fixture();
    const result = await invoke("kulo_task_context") as Record<string, unknown>;
    expect(result).toMatchObject({ taskId: "T-0001", goal: "Add a bounded feature", workspaceDir: "/project", allowSubagents: true });
    expect(result).not.toHaveProperty("originConversationId");
    expect(result).not.toHaveProperty("externalExecution");
    expect(result).not.toHaveProperty("connectionIds");
  });

  it.each([
    { envId: "another-device" }, { runEpoch: 2 }, { runId: "another-run" }, { taskId: "T-0099" },
  ])("rejects a stale or foreign caller %j", async (extra) => {
    const { invoke, host } = fixture();
    await expect(invoke("kulo_task_report", { state: "ready", summary: "done" }, extra)).rejects.toMatchObject({ code: "external_task_scope_expired" });
    expect(host.report).not.toHaveBeenCalled();
  });

  it("revokes tools when the parent task is stopped or waiting", async () => {
    const { snapshot, invoke } = fixture();
    snapshot.ticket.status = "stopped";
    await expect(invoke("kulo_task_context")).rejects.toMatchObject({ code: "external_task_scope_expired" });
    snapshot.ticket.status = "running";
    snapshot.ticket.waiting = { reason: "user", since: 1 };
    await expect(invoke("kulo_task_context")).rejects.toMatchObject({ code: "external_task_scope_expired" });
  });

  it("keeps reports available but disallows collaboration by default", async () => {
    const { snapshot, invoke, host } = fixture();
    snapshot.role!.allowSubagents = false;
    expect(await invoke("kulo_task_report", { state: "progress", summary: "Working" })).toEqual({ recorded: true, state: "progress" });
    await expect(invoke("kulo_agents")).rejects.toMatchObject({ code: "external_collaboration_disabled" });
    await expect(invoke("kulo_request_collaboration", { request_id: "review-1", agent_id: "checker", goal: "Review" })).rejects.toMatchObject({ code: "external_collaboration_disabled" });
    expect(host.delegate).not.toHaveBeenCalled();
  });

  it("filters a read-only parent's candidates and rejects another device", async () => {
    const { snapshot, invoke, host } = fixture();
    snapshot.ticket.readOnly = true;
    expect(await invoke("kulo_agents")).toEqual({ agents: [{ id: "checker", label: "Checker", whenToUse: "Review code", readOnly: true }] });
    for (const agent_id of ["coder", "remote"]) await expect(invoke("kulo_request_collaboration", { request_id: agent_id, agent_id, goal: "Review" })).rejects.toMatchObject({ code: "external_collaboration_target_denied" });
    expect(host.delegate).not.toHaveBeenCalled();
  });

  it("uses durable request identity and does not redispatch after a successful retry", async () => {
    const { snapshot, invoke, host } = fixture();
    const args = { request_id: "review-1", agent_id: "checker", goal: "Review feature", acceptance: "Find regressions" };
    expect(await invoke("kulo_request_collaboration", args)).toEqual({ taskId: "T-0002", state: "queued" });
    snapshot.maxSubagents = 1;
    expect(await invoke("kulo_request_collaboration", args)).toEqual({ taskId: "T-0002", state: "completed", summary: "Reviewed" });
    expect(host.delegate).toHaveBeenCalledTimes(1);
    await expect(invoke("kulo_request_collaboration", { ...args, goal: "Different task" })).rejects.toMatchObject({ code: "external_collaboration_request_conflict" });
    await expect(invoke("kulo_request_collaboration", { ...args, request_id: "review-2" })).rejects.toMatchObject({ code: "external_collaboration_limit" });
  });

  it("rechecks authorization after asynchronous candidate discovery", async () => {
    const { snapshot, invoke, host } = fixture();
    host.agents = vi.fn(async () => { snapshot.ticket.runEpoch += 1; return [{ id: "checker", label: "Checker", whenToUse: "Review", readOnly: true }]; });
    await expect(invoke("kulo_request_collaboration", { request_id: "review-1", agent_id: "checker", goal: "Review" })).rejects.toMatchObject({ code: "external_task_scope_expired" });
    expect(host.delegate).not.toHaveBeenCalled();
  });

  it("permits reading only the parent's recorded children", async () => {
    const { snapshot, invoke, host } = fixture();
    snapshot.children["review-1"] = { taskId: "T-0002", fingerprint: "recorded" };
    expect(await invoke("kulo_child_task", { task_id: "T-0002" })).toMatchObject({ summary: "Reviewed" });
    await expect(invoke("kulo_child_task", { task_id: "T-0003" })).rejects.toMatchObject({ code: "external_child_task_forbidden" });
    expect(host.inspect).toHaveBeenCalledTimes(1);
  });

  it("rejects caller-provided authorization fields and invalid request IDs", async () => {
    const { invoke, host } = fixture();
    await expect(invoke("kulo_task_report", { state: "ready", summary: "Done", task_id: "T-9999" })).rejects.toMatchObject({ code: "invalid_task_tool_arguments" });
    await expect(invoke("kulo_request_collaboration", { request_id: "constructor", agent_id: "checker", goal: "Review" })).rejects.toMatchObject({ code: "invalid_task_tool_arguments" });
    expect(host.report).not.toHaveBeenCalled();
    expect(host.delegate).not.toHaveBeenCalled();
  });

  it("redacts reports before persistence and rejects secrets in child briefs", async () => {
    const { invoke, host } = fixture();
    await invoke("kulo_task_report", { state: "progress", summary: "password=private-value" });
    expect(JSON.stringify(vi.mocked(host.report).mock.calls)).not.toContain("private-value");
    await expect(invoke("kulo_request_collaboration", { request_id: "review-1", agent_id: "checker", goal: "Use password=private-value" })).rejects.toMatchObject({ code: "external_collaboration_secret" });
    expect(host.delegate).not.toHaveBeenCalled();
  });

  it("keeps a stable collaboration fingerprint independent of request identity", () => {
    expect(externalAgentCollaborationFingerprint({ agentId: "checker", goal: "Review" })).toBe(externalAgentCollaborationFingerprint({ agentId: "checker", goal: "Review", acceptance: undefined }));
    expect(externalAgentCollaborationFingerprint({ agentId: "checker", goal: "Review" })).not.toBe(externalAgentCollaborationFingerprint({ agentId: "coder", goal: "Review" }));
  });

  it("does not provide a command execution proxy through the Hub handler", async () => {
    const { invoke } = fixture();
    await expect(invoke("kulo_task_exec", { command: "pwd", timeout_ms: 1000 })).rejects.toMatchObject({ code: "external_task_tool_unknown" });
  });
});

async function bridge(allowSubagents = false, handler = vi.fn(async () => ({ recorded: true }))) {
  const result = await startExternalAgentMcp({ ...scope, cwd: "/project", allowSubagents, handler });
  bridges.push(result);
  const authorization = result.server.headers[0]!.value;
  const call = (method: string, params?: unknown, extraHeaders?: Record<string, string>) => fetch(result.server.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization, ...extraHeaders }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { result, authorization, call, handler };
}

describe("per-run loopback MCP transport", () => {
  it("binds loopback, negotiates JSON-RPC, and hides collaboration tools by default", async () => {
    const { result, call } = await bridge();
    expect(result.server.url).toBe(`http://127.0.0.1:${result.port}/mcp`);
    const init = await (await call("initialize", { protocolVersion: "2025-06-18" })).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const listing = await (await call("tools/list")).json();
    expect(listing.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["kulo_task_context", "kulo_task_report"]);
    const denied = await (await call("tools/call", { name: "kulo_agents", arguments: {} })).json();
    expect(denied.error.code).toBe(-32602);
  });

  it.each([false, true])("does not expose or forward the removed execution proxy (collaboration=%s)", async enabled => {
    const { call, handler } = await bridge(enabled);
    const listing = await (await call("tools/list")).json();
    const names = listing.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).not.toContain("kulo_task_exec");
    expect(names.includes("kulo_request_collaboration")).toBe(enabled);
    const response = await (await call("tools/call", { name: "kulo_task_exec", arguments: { command: "pnpm test", timeout_ms: 1000 } })).json();
    expect(response.error.code).toBe(-32602);
    expect(handler).not.toHaveBeenCalled();
  });

  it("supplies only the server-owned run scope to tools", async () => {
    const { call, handler } = await bridge(true);
    const result = await (await call("tools/call", { name: "kulo_request_collaboration", arguments: { request_id: "review-1", agent_id: "checker", goal: "Review" } })).json();
    expect(result.result).toEqual({ content: [{ type: "text", text: '{"recorded":true}' }] });
    expect(handler).toHaveBeenCalledWith({ runId: "run-1", taskId: "T-0001", runEpoch: 1, cwd: "/project", allowSubagents: true, name: "kulo_request_collaboration", args: { request_id: "review-1", agent_id: "checker", goal: "Review" } });
    const denied = await (await call("tools/call", { name: "kulo_task_context", arguments: { taskId: "T-9999" } })).json();
    expect(denied.error.code).toBe(-32602);
  });

  it("rejects missing or sibling authentication and foreign origins", async () => {
    const one = await bridge();
    const two = await bridge();
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await fetch(one.result.server.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload })).status).toBe(401);
    expect((await one.call("tools/list", undefined, { Authorization: two.authorization })).status).toBe(401);
    expect((await one.call("tools/list", undefined, { Origin: "https://unrelated.example" })).status).toBe(403);
  });

  it("rejects DNS-rebinding host names", async () => {
    const { result, authorization } = await bridge();
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(result.server.url, { method: "POST", headers: { Host: "attacker.example", Authorization: authorization, "Content-Type": "application/json" } }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.once("error", reject);
      request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
    expect(status).toBe(403);
  });

  it("reports domain failures as errors and redacts error text", async () => {
    const { call } = await bridge(false, vi.fn(async () => { throw new Error("password=private-value"); }));
    const result = await (await call("tools/call", { name: "kulo_task_context", arguments: {} })).json();
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).not.toContain("private-value");
  });

  it("rejects oversized bodies and unsupported media without invoking tools", async () => {
    const { result, authorization, handler } = await bridge();
    const large = await fetch(result.server.url, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify({ text: "x".repeat(270_000) }) });
    expect(large.status).toBe(413);
    const unsupported = await fetch(result.server.url, { method: "POST", headers: { Authorization: authorization, "Content-Type": "text/plain" }, body: "{}" });
    expect(unsupported.status).toBe(415);
    expect(handler).not.toHaveBeenCalled();
  });

  it("revokes a bridge without interrupting a sibling endpoint", async () => {
    const one = await bridge();
    const two = await bridge();
    await one.result.close();
    await expect(one.call("tools/list")).rejects.toThrow();
    expect((await two.call("tools/list")).status).toBe(200);
    await one.result.close();
  });
});
