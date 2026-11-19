import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MocoStateDoc, startMocoHubServer } from "@moco/hub";
import type { DeviceInvitation, DevicePeerConfig, EnvNodeDescriptor, HubToClientMessage } from "@moco/protocol";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => unknown | Promise<unknown>> = [];
const waitOptions = { timeout: 5_000, interval: 20 };
type ToolCall = { name: string; args: Record<string, unknown> };

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation(file => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_AUTH_TOKEN", "MOCO_ENV_TOKENS", "MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function hasTool(request: TranscriptContext, name: string): boolean {
  return Boolean(request.tools?.some(tool => tool.name === name)) || request.messages.some(message =>
    message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) && message.toolsAdded.some(tool => tool.name === name));
}

function socket(url: string, token?: string) {
  const connection = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const close = async () => {
    if (connection.readyState === WebSocket.CLOSED) return;
    const closed = once(connection, "close");
    connection.terminate();
    await closed;
  };
  cleanups.push(close);
  return { connection, close };
}

async function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-message-source-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "source-routing-model" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  const actions = new Map<string, ToolCall | ToolCall[] | (() => Promise<ToolCall[]>)>();
  const routerInputs = new Map<string, string>();
  provider.setResponses(Array.from({ length: 60 }, () => async (request: TranscriptContext) => {
    if (hasTool(request, "moco_dispatch")) {
      const lastUser = request.messages.filter(message => message.role === "user").at(-1)?.content;
      const input = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser ?? "");
      for (const [marker, action] of actions) {
        if (!input.includes(marker) || routerInputs.has(marker)) continue;
        routerInputs.set(marker, input);
        const calls = typeof action === "function" ? await action() : Array.isArray(action) ? action : [action];
        if (calls.length) return fauxAssistantMessage(calls.map(call => fauxToolCall(call.name, call.args)), { stopReason: "toolUse" });
        break;
      }
    } else if (hasTool(request, "moco_report")) {
      return fauxAssistantMessage([fauxToolCall("moco_report", { state: "ready", summary: "执行验证完成。" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("已收到。");
  }));
  const hub = await openTestHub({ models, config: {
    stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"), localEnvRoot: path.join(directory, "local"),
    authToken: HUB_TEST_ADMIN_TOKEN, envTokens: {}, enableLocalEnv: false, maxConcurrentWorkers: 2, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "source-routing-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
  } });
  cleanups.push(() => hub.close());
  // The sockets, registration, and task scheduler are real. Keep Worker I/O
  // inside the temporary workspaces without requiring a platform-specific sandbox.
  const execution = vi.spyOn(hub.envManager, "createWorkerExecutionEnv").mockImplementation((_id, cwd) => new NodeExecutionEnv({ cwd }));
  vi.spyOn(hub.envManager, "releaseWorkerExecutionEnv").mockResolvedValue({ cleanupPending: false });
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.close());

  const request = (pathname: string, method: string, body: unknown, authenticate = true) => fetch(`${server.url}${pathname}`, {
    method, headers: { "content-type": "application/json", ...(authenticate ? { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } : {}) }, body: JSON.stringify(body),
  });
  expect((await request("/api/devices", "PATCH", { enabled: true })).status).toBe(200);

  async function pair(name: string): Promise<DevicePeerConfig> {
    const invite = await request("/api/devices/invitations", "POST", { name, hubUrl: "https://hub.test" });
    expect(invite.status).toBe(201);
    const invitation = await invite.json() as DeviceInvitation;
    const token = /'([A-Za-z0-9_-]+)'$/.exec(invitation.command)?.[1];
    if (!token) throw new Error("Expected a one-time invitation token.");
    const rootDir = path.join(directory, invitation.deviceId);
    fs.mkdirSync(rootDir);
    const paired = await request("/api/devices/pair", "POST", {
      inviteToken: token, rootDir,
      info: { hostname: name, platform: process.platform, arch: process.arch, release: "test", cpu: "test", memoryBytes: 0, ips: [] },
    }, false);
    expect(paired.status).toBe(200);
    return paired.json() as Promise<DevicePeerConfig>;
  }

  async function connectExecution(device: DevicePeerConfig) {
    const env = socket(server.envWsUrl);
    await once(env.connection, "open");
    const registered = once(env.connection, "message");
    env.connection.send(JSON.stringify({
      type: "env.register", envId: device.deviceId, token: device.envToken,
      name: device.name, platform: process.platform, arch: process.arch, rootDir: device.rootDir,
      capabilities: ["fs", "worker-isolation"],
    }));
    const [message] = await registered;
    expect(JSON.parse(String(message))).toMatchObject({ type: "hub.registered", envId: device.deviceId });
    return env;
  }

  async function connectChat(device: DevicePeerConfig) {
    const client = socket(server.clientWsUrl, device.clientToken);
    const messages: HubToClientMessage[] = [];
    client.connection.on("message", raw => messages.push(JSON.parse(String(raw)) as HubToClientMessage));
    await once(client.connection, "open");
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      type: "hub.snapshot", activeTopicId: "root", deliveryIdentity: expect.objectContaining({ principalId: device.deviceId }),
    })), waitOptions);
    return {
      close: client.close,
      async send(requestId: string, content: string, extra?: Record<string, unknown>) {
        const start = messages.length;
        client.connection.send(JSON.stringify({ ...extra, type: "chat.send", topicId: "root", requestId, content }));
        const acknowledgement = await vi.waitFor(() => {
          const response = messages.slice(start).find(message => (message.type === "hub.ack" || message.type === "hub.error") && message.requestId === requestId);
          expect(response).toBeDefined();
          return response;
        }, waitOptions);
        expect(acknowledgement).toMatchObject({ type: "hub.ack", topicId: "root" });
        return acknowledgement;
      },
    };
  }

  async function idle() {
    await vi.waitFor(async () => expect((await hub.getTopicView("root")).live.busy).toBe(false), waitOptions);
  }
  const board = () => hub.harness.snapshot(MocoStateDoc, context);
  return { hub, actions, routerInputs, execution, pair, connectExecution, connectChat, board, idle };
}

function dispatch(commandId: string, sourceRequestId?: string): ToolCall {
  return { name: "moco_dispatch", args: { command_id: commandId, title: "执行验证", goal: "处理当前消息中的任务", scope: "本任务目录", role: "coder", task_kind: "coding",
    ...(sourceRequestId ? { source_request_id: sourceRequestId } : {}) } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function ticket(f: Fixture, commandId: string) {
  const board = await f.board();
  return Object.values(board?.tickets ?? {}).find(task => task.commandId === commandId);
}

async function ready(f: Fixture, commandId: string, device: DevicePeerConfig) {
  const task = await vi.waitFor(async () => {
    const current = await ticket(f, commandId);
    expect(current).toMatchObject({ status: "ready" });
    return current!;
  }, waitOptions);
  expect(task).toMatchObject({ envId: device.deviceId, originTopicId: "root" });
  return task;
}

it("routes each paired message in a shared topic and resumes work on its original Env after reconnect", async () => {
  const f = await fixture();
  const a = await f.pair("工作笔记本");
  const b = await f.pair("桌面工作站");
  const envA = await f.connectExecution(a);
  await f.connectExecution(b);
  const chatA = await f.connectChat(a);
  const chatB = await f.connectChat(b);
  const firstMessage = "[first-source-task] 刚刚在桌面工作站上保存了记录，请在这台电脑上检查文件。";
  const secondMessage = "[second-source-task] 检查一下本机日志。";
  const offlineMessage = "[offline-source-task] 再检查这台电脑上的结果。";
  const continuation = "[continue-source-task] 继续刚才笔记本上的原工单。";
  f.actions.set("[first-source-task]", dispatch("from-laptop"));
  f.actions.set("[second-source-task]", dispatch("from-workstation"));
  f.actions.set("[offline-source-task]", dispatch("from-offline-laptop"));

  await chatA.send("from-laptop-message", firstMessage);
  const first = await ready(f, "from-laptop", a);
  await f.idle();
  await chatB.send("from-workstation-message", secondMessage);
  const second = await ready(f, "from-workstation", b);
  await f.idle();
  expect((await f.board())?.topics?.root?.targetDeviceId).toBeUndefined();

  await envA.close();
  await chatA.close();
  await vi.waitFor(() => expect(f.hub.envManager.getEnvDescriptor(a.deviceId)?.online).toBe(false), waitOptions);
  const reconnectedChatA = await f.connectChat(a);
  expect(await reconnectedChatA.send("from-laptop-message", firstMessage)).toMatchObject({ deduplicated: true });
  await reconnectedChatA.send("from-offline-laptop-message", offlineMessage);
  await vi.waitFor(async () => expect(await ticket(f, "from-offline-laptop")).toMatchObject({
    status: "waiting", envId: a.deviceId, waiting: { reason: "env" },
  }), waitOptions);
  await f.idle();

  f.actions.set("继续", dispatch("wrong-continuation-device"));
  await chatB.send("continue-before-steer", "继续");
  await f.idle();
  expect(await ticket(f, "wrong-continuation-device")).toBeUndefined();

  f.actions.set("[continue-source-task]", { name: "moco_steer", args: { command_id: "resume-laptop", ticket_id: first.id, text: "补充检查原工单的结果。" } });
  await chatB.send("continue-laptop-message", continuation);
  await vi.waitFor(async () => expect(await ticket(f, "from-laptop")).toMatchObject({
    id: first.id, envId: a.deviceId, status: "waiting", waiting: { reason: "env" }, wakePending: true,
  }), waitOptions);
  await f.idle();

  await f.connectExecution(a);
  const offline = await ready(f, "from-offline-laptop", a);
  const resumed = await ready(f, "from-laptop", a);
  expect(resumed).toMatchObject({ id: first.id, workerConversationId: first.workerConversationId, workspaceDir: first.workspaceDir });
  expect(resumed.runEpoch).toBeGreaterThan(first.runEpoch);
  expect(Object.keys((await f.board())!.tickets)).toHaveLength(3);
  for (const task of [first, second, offline]) {
    const calls = f.execution.mock.calls.filter(([, cwd]) => cwd === task.workspaceDir);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([envId]) => envId === task.envId)).toBe(true);
  }

  const history = await f.hub.rootConversation.entries({}, 100, undefined, context);
  for (const [requestId, content, device, marker] of [
    ["from-laptop-message", firstMessage, a, "[first-source-task]"],
    ["from-workstation-message", secondMessage, b, "[second-source-task]"],
    ["from-offline-laptop-message", offlineMessage, a, "[offline-source-task]"],
    ["continue-laptop-message", continuation, b, "[continue-source-task]"],
  ] as const) {
    const entries = history.items.filter(entry => entry.kind === "moco.user" && entry.data?.requestId === requestId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data).toMatchObject({ text: content, source: { deviceId: device.deviceId, name: device.name, kind: "computer" } });
    expect(f.routerInputs.get(marker)).toContain(device.deviceId);
  }
});

it("uses authenticated source metadata and honors an explicitly selected target", async () => {
  const f = await fixture();
  const target = await f.pair("指定工作站");
  const sender = await f.pair("发信电脑");
  await f.connectExecution(target);
  await f.connectExecution(sender);
  const chat = await f.connectChat(sender);
  f.actions.set("[source-claim]", dispatch("route-by-authenticated-source"));
  f.actions.set("[target-selection]", dispatch("route-by-explicit-target"));

  await chat.send("source-claim", "[source-claim] 读取本机任务记录。", {
    source: { deviceId: target.deviceId, name: target.name, kind: "computer" },
  });
  await ready(f, "route-by-authenticated-source", sender);
  expect(f.routerInputs.get("[source-claim]")).toContain(sender.deviceId);
  expect(f.routerInputs.get("[source-claim]")).not.toContain(target.deviceId);
  await f.idle();

  const takeOtherDevice = dispatch("use-another-device");
  takeOtherDevice.args.env_id = target.deviceId;
  f.actions.set("[named-device]", takeOtherDevice);
  await chat.send("named-device", "[named-device] 请在指定工作站上检查日志。");
  await ready(f, "use-another-device", target);
  await f.idle();

  const unboundAgent = dispatch("wrong-device-for-builtin-agent");
  unboundAgent.args.env_id = target.deviceId;
  f.actions.set("[builtin-agent]", unboundAgent);
  await chat.send("builtin-agent", "[builtin-agent] 请用内置 Worker 检查这台电脑上的日志。");
  await f.idle();
  expect(await ticket(f, "wrong-device-for-builtin-agent")).toBeUndefined();

  await chat.send("target-selection", "[target-selection] 检查选定的工作站。", { targetDeviceId: target.deviceId });
  await ready(f, "route-by-explicit-target", target);
  expect((await f.board())?.topics?.root?.targetDeviceId).toBe(target.deviceId);
});

it("blocks a main-conversation file read on a different Env before any file access", async () => {
  const f = await fixture();
  const other = await f.pair("默认电脑");
  const sender = await f.pair("消息来源电脑");
  await f.connectExecution(other);
  await f.connectExecution(sender);
  const chat = await f.connectChat(sender);
  const environment = Object.assign(new NodeExecutionEnv({ cwd: other.rootDir }), { id: `pi-env:${other.deviceId}` });
  fs.writeFileSync(path.join(other.rootDir, "log.txt"), "different device");
  vi.spyOn(f.hub.envManager, "createExecutionEnv").mockImplementation(() => environment);
  const fileRead = vi.spyOn(environment, "openBinaryReader");
  f.actions.set("[read-source]", { name: "read", args: { path: "log.txt" } });

  await chat.send("read-source", "[read-source] 查看这台设备的 log.txt。");
  await f.idle();
  const history = await f.hub.rootConversation.entries({}, 30, undefined, context);
  const result = history.items.flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult" && message.toolName === "read");
  expect(result).toMatchObject({ isError: true });
  expect(result?.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("moco_dispatch") })]));
  expect(fileRead).not.toHaveBeenCalled();
});

it("uses a sending phone's native execution domain when dispatch omits both device and domain", async () => {
  const f = await fixture();
  const computer = await f.pair("在线电脑");
  await f.connectExecution(computer);
  const phone: EnvNodeDescriptor = {
    id: "sending-phone", name: "手机", kind: "reverse-ws", online: true, platform: "android", arch: "arm64", rootDir: "",
    executionKind: "native-device", capabilities: ["android-native-v1"], connectedAt: Date.now(), lastSeenAt: Date.now(),
    android: { version: 1, catalogVersion: 1, enabled: true, paused: false, revision: 1, grants: ["device"], capabilities: [] },
  };
  const getEnv = f.hub.envManager.getEnvDescriptor.bind(f.hub.envManager);
  const listEnvs = f.hub.envManager.listEnvs.bind(f.hub.envManager);
  vi.spyOn(f.hub.envManager, "getEnvDescriptor").mockImplementation(id => id === phone.id ? phone : getEnv(id));
  vi.spyOn(f.hub.envManager, "listEnvs").mockImplementation(() => [...listEnvs(), phone]);
  vi.spyOn(f.hub.envManager, "cancelAndroid").mockImplementation(async (_id, request) => ({
    version: 1, controlId: request.controlId, ticketId: request.ticketId, runEpoch: request.runEpoch, quiescent: true,
  }));
  f.actions.set("[phone-source]", dispatch("use-sending-phone"));
  await f.hub.sendUserMessage("[phone-source] 检查这台手机的状态。", {
    principalId: phone.id, requestId: "phone-source", source: { deviceId: phone.id, name: phone.name, kind: "android" },
  });
  await vi.waitFor(async () => expect(await ticket(f, "use-sending-phone")).toMatchObject({
    envId: phone.id, executionDomain: "android", androidDeviceIds: [phone.id], workspaceDir: "", status: "ready",
  }), waitOptions);
  expect(f.execution).not.toHaveBeenCalled();
});

it("binds a mixed-source follow-up batch to its current messages", async () => {
  const f = await fixture();
  const a = await f.pair("设备甲");
  const b = await f.pair("设备乙");
  await f.connectExecution(a);
  await f.connectExecution(b);
  const chatA = await f.connectChat(a);
  const chatB = await f.connectChat(b);
  const held = Promise.withResolvers<void>();
  cleanups.push(() => held.resolve());
  f.actions.set("[held-answer]", async () => { await held.promise; return []; });
  f.actions.set("[queued-device-b]", [
    dispatch("batch-device-a", "queued-a"),
    dispatch("batch-device-b", "queued-b"),
    dispatch("batch-stale-input", "held-input"),
    dispatch("batch-ambiguous-input"),
  ]);

  await chatA.send("held-input", "[held-answer] 先回答这个问题。");
  await vi.waitFor(() => expect(f.routerInputs.has("[held-answer]")).toBe(true), waitOptions);
  expect(await chatA.send("queued-a", "[queued-device-a] 检查甲设备上的运行记录。", { whenBusy: "followUp" })).toMatchObject({ delivery: "queued" });
  expect(await chatB.send("queued-b", "[queued-device-b] 检查乙设备上的运行记录。", { whenBusy: "followUp" })).toMatchObject({ delivery: "queued" });
  held.resolve();

  await ready(f, "batch-device-a", a);
  await ready(f, "batch-device-b", b);
  await f.idle();
  expect(await ticket(f, "batch-stale-input")).toBeUndefined();
  expect(await ticket(f, "batch-ambiguous-input")).toBeUndefined();
});
