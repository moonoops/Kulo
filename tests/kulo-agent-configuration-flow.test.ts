import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentConfigurationDraft, AgentConfigurationWorkspace, EnvNodeDescriptor, ExternalAgentDetection, ExternalAgentResponse, KuloSettingsView, SettingsAssistantContext, SettingsAssistantSnapshot } from "@kulo/protocol";
import type { AgentConfigurationSaveResult } from "../packages/hub/src/agent-configuration";
import { KuloStateDoc } from "../packages/hub/src/state";
import { openTestHub } from "./helpers/secure-hub";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider";

const cleanup: Array<() => void | Promise<void>> = [];
const setupContext: SettingsAssistantContext = { module: "workers", active: true, pageGeneration: 1, appearance: "light", hasUnsavedChanges: false, clientId: "external-agent-settings-window" };
const prefix = "kulo_agent_configuration_";
const text = (value: string) => fauxAssistantMessage([fauxText(value)]);
const tool = (name: string, args: Record<string, unknown> = {}) => fauxAssistantMessage([fauxToolCall(`${prefix}${name}`, args)], { stopReason: "toolUse" });

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(withProject = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-agent-configuration-flow-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "agent-settings-fixture" }] });
  const models = createModels(); models.setProvider(routeSettingsTitleRequests(provider));
  // Do not import a developer's .env into this fixture; restore this one startup spy immediately.
  const exists = fs.existsSync;
  const envFile = vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  let hub: Awaited<ReturnType<typeof openTestHub>>;
  try {
    hub = await openTestHub({ models, config: {
      stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"), localEnvRoot: path.join(directory, "runtime"),
      enableLocalEnv: false, envTokens: {}, watchdogMinutes: 0, memory: { enabled: false },
      model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultProvider: "openai", defaultModel: "agent-settings-fixture", thinkingLevel: "off", apiKey: "" },
    } });
  } finally { envFile.mockRestore(); }
  cleanup.push(() => hub.close());
  const device: EnvNodeDescriptor = { id: "fixture-computer", name: "Settings test Mac", kind: "reverse-ws", executionKind: "pi-env", online: true,
    platform: "darwin", arch: "arm64", rootDir: path.join(directory, "device"), capabilities: ["external-agents", "worker-isolation"], connectedAt: 1, lastSeenAt: 1 };
  const devices = vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => [structuredClone(device)]);
  const descriptor = vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((id) => id === device.id ? structuredClone(device) : undefined);
  let project: Awaited<ReturnType<typeof hub.projects.create>> | undefined;
  if (withProject) {
    const authorization = vi.spyOn(hub.envManager, "authorizeProjectDirectory").mockImplementation(async (_deviceId, input) => ({ projectId: input.projectId, workspaceDir: input.path, directoryId: `fixture:${input.projectId}`,
      revision: input.revision ?? 1, scratchRoot: path.join(directory, "project-scratch"), platform: "darwin" }));
    try { project = await hub.projects.create({ commandId: "fixture-project", name: "设置流程项目", deviceId: device.id, workspaceDir: path.join(directory, "project") }); }
    finally { authorization.mockRestore(); }
  }
  const detection: ExternalAgentDetection = { kind: "codex", installed: true, executable: "/usr/local/bin/codex", version: "fixture-native-1", authenticated: null, models: [],
    capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" } };
  const native = vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation(async (envId, request): Promise<ExternalAgentResponse> => {
    expect(envId).toBe(device.id);
    if (request.operation !== "detect" && request.operation !== "probe") throw new Error(`This fixture cannot execute native tasks: ${request.operation}`);
    return { type: "detection", detection: { ...structuredClone(detection), kind: request.operation === "detect" ? request.kind : request.binding.kind } };
  });
  cleanup.push(() => { native.mockRestore(); devices.mockRestore(); descriptor.mockRestore(); });
  const send = async (content: string, requestId: string, context = setupContext) => {
    hub.settingsAssistant.updateContext(context);
    await hub.settingsAssistant.send(content, context, requestId);
  };
  return { hub, provider, native, device, devices, detection, project, send };
}

async function settled(hub: Awaited<ReturnType<typeof openTestHub>>, marker: string): Promise<SettingsAssistantSnapshot> {
  let snapshot: SettingsAssistantSnapshot;
  await vi.waitFor(async () => {
    snapshot = await hub.settingsAssistant.getSnapshot();
    expect(snapshot.live.busy).toBe(false);
    expect(snapshot.messages.some((message) => message.role === "assistant" && message.text.includes(marker))).toBe(true);
  }, { timeout: 10_000, interval: 20 });
  return snapshot!;
}

function lastTool(context: TranscriptContext, name: string) {
  const result = [...context.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === `${prefix}${name}`);
  if (!result || result.role !== "toolResult") throw new Error(`Missing real tool result: ${name}`);
  return result;
}

function toolValue<T>(context: TranscriptContext, name: string): T {
  const result = lastTool(context, name);
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  return JSON.parse(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")) as T;
}

function currentAgentContext(context: TranscriptContext) {
  const tools = new Set<string>(); const sections = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
    for (const added of message.toolsAdded ?? []) tools.add(added.name);
    for (const [name, value] of Object.entries(message.sections ?? {})) { if (value === null) sections.delete(name); else sections.set(name, value); }
  }
  return { tools: [...tools], sections };
}

describe("external agent setup through the real Hub settings Agent", () => {
  it("configures across user turns through real tools and publishes the disabled role to the settings list", async () => {
    const f = await fixture(true); const traces: TranscriptContext[] = []; const views: KuloSettingsView[] = [];
    cleanup.push(f.hub.subscribe({ onSettings: (view) => views.push(view) }));
    const before = f.hub.getSettingsView().blocks.roles;
    let draft: AgentConfigurationDraft; let saved: AgentConfigurationSaveResult;
    f.provider.setResponses([
      (context) => { traces.push(context); return tool("read"); },
      (context) => { traces.push(context); const workspace = toolValue<AgentConfigurationWorkspace>(context, "read"); expect(workspace.devices).toContainEqual(expect.objectContaining({ id: f.device.id })); expect(workspace.projects).toContainEqual({ id: f.project!.id, name: f.project!.name, envId: f.device.id }); return tool("read", { client_kind: "codex" }); },
      (context) => { traces.push(context); expect(toolValue<AgentConfigurationWorkspace & { guide: string }>(context, "read").guide).toContain("app-server"); return tool("prepare", { client_kind: "codex", env_id: f.device.id }); },
      (context) => { traces.push(context); draft = toolValue(context, "prepare"); return text("已准备本机 Codex 草稿，请告诉我希望它承担什么工作。"); },
    ]);
    await f.send("连接测试电脑上的 Codex", "agent-flow-prepare");
    await settled(f.hub, "已准备本机 Codex 草稿");
    expect(draft!).toMatchObject({ clientId: setupContext.clientId, binding: { kind: "codex", envId: f.device.id }, allowSubagents: false });
    expect(f.hub.getSettingsView().blocks.roles).toEqual(before);

    f.provider.setResponses([
      (context) => { traces.push(context); return tool("update", { expected_revision: draft.revision, label: "本机代码助手", when_to_use: "用户指定的本机代码修改和验证", prompt: "遵守任务范围，结果交回 Kulo；协作先向 Hub 请求。", model_id: '["native-provider","native-model"]', thinking_level: "high", default_for: ["coding", "debugging"], project_ids: [f.project!.id] }); },
      (context) => { traces.push(context); draft = toolValue(context, "update"); return tool("detect", { expected_revision: draft.revision }); },
      (context) => { traces.push(context); draft = toolValue(context, "detect"); return tool("probe", { expected_revision: draft.revision }); },
      (context) => { traces.push(context); draft = toolValue(context, "probe"); return text("协议连接可用。尚未做真实试发，可以先以停用状态保存。"); },
    ]);
    await f.send("叫本机代码助手，默认承接设置流程项目的代码实现和排错，思考深度用high，先检查协议", "agent-flow-probe");
    await settled(f.hub, "协议连接可用");
    expect(draft!.verification?.level).toBe("protocol");
    expect(draft!.dispatchPolicy).toEqual({ defaultFor: ["coding", "debugging"], projectIds: [f.project!.id] });
    expect(f.hub.getSettingsView().blocks.roles).toEqual(before);
    f.provider.setResponses([
      (context) => { traces.push(context); return tool("save", { expected_revision: draft.revision }); },
      (context) => { traces.push(context); saved = toolValue(context, "save"); return text("已保存，左侧已显示本机代码助手，当前保持停用。"); },
    ]);
    await f.send("先保存，不要真实试发", "agent-flow-save");
    await settled(f.hub, "左侧已显示本机代码助手");

    const role = f.hub.getSettingsView().blocks.roles.value[saved!.agentId];
    expect(role).toMatchObject({ label: "本机代码助手", enabled: false, allowSubagents: false, modelId: '["native-provider","native-model"]', thinkingLevel: "high", dispatchPolicy: { defaultFor: ["coding", "debugging"], projectIds: [f.project!.id] }, external: { kind: "codex", envId: f.device.id, version: f.detection.version } });
    expect(role?.external?.verifiedAt).toBeUndefined(); expect(role?.provider).toBeUndefined();
    expect(f.hub.getSettingsView().blocks.roles.revision).toBe(before.revision + 1);
    expect(views.some((view) => view.blocks.roles.value[saved!.agentId]?.label === role?.label)).toBe(true);
    expect(f.native.mock.calls.map(([, request]) => request.operation)).toEqual(["detect", "probe"]);
    expect((await f.hub.agentConfiguration.workspace(setupContext.clientId)).draft).toBeUndefined();
    expect((await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets).toEqual({});
    expect(currentAgentContext(traces[0]!).tools).toEqual(expect.arrayContaining([`${prefix}read`, `${prefix}prepare`, `${prefix}update`, `${prefix}detect`, `${prefix}probe`, `${prefix}save`]));
    const update = traces[0]!.messages.flatMap((message) => message.role === "system" ? message.toolsAdded ?? [] : []).find((item) => item.name === `${prefix}update`)!;
    expect(update.parameters.properties).toHaveProperty("thinking_level");
    for (const field of ["read_only", "sandbox", "permissions", "mcp_servers", "plugins", "network"]) expect(update.parameters.properties).not.toHaveProperty(field);
    expect(currentAgentContext(traces[0]!).sections.get("kulo_agent_configuration")).toContain("Only for the active Settings -> Agents assistant");
    const results = traces.at(-1)!.messages.filter((message) => message.role === "toolResult" && message.toolName.startsWith(prefix));
    expect(results).toHaveLength(7); expect(results.every((result) => result.role === "toolResult" && !result.isError)).toBe(true);
  });

  it.each([
    { module: "models" as const, active: true },
    { module: "workers" as const, active: false },
  ])("removes setup tools and its active guide after switching to $module (active=$active)", async (next) => {
    const f = await fixture(); const traces: TranscriptContext[] = [];
    f.provider.setResponses([(context) => { traces.push(context); return text("智能体配置入口已加载。"); }]);
    await f.send("查看当前可用的智能体配置能力", "scope-entry"); await settled(f.hub, "智能体配置入口已加载");
    expect(currentAgentContext(traces[0]!).tools).toContain(`${prefix}read`);
    f.provider.setResponses([(context) => { traces.push(context); return text("当前页面没有外部智能体配置入口。"); }]);
    await f.send("继续查看当前设置页", "scope-leave", { ...setupContext, ...next, pageGeneration: 2 });
    await settled(f.hub, "当前页面没有外部智能体配置入口");
    const current = currentAgentContext(traces[1]!);
    expect(current.tools.some((name) => name.startsWith(prefix))).toBe(false);
    expect(current.sections.has("kulo_agent_configuration")).toBe(false);
    expect(f.native).not.toHaveBeenCalled();
  });

  it("revokes a pending native probe when the original settings page becomes inactive", async () => {
    const f = await fixture(); let draft: AgentConfigurationDraft; const traces: TranscriptContext[] = [];
    f.provider.setResponses([
      () => tool("prepare", { client_kind: "codex", env_id: f.device.id }),
      (context) => { draft = toolValue(context, "prepare"); return text("等待检查连接。"); },
    ]);
    await f.send("准备本机 Codex", "revoked-prepare"); await settled(f.hub, "等待检查连接");
    const before = f.hub.getSettingsView();
    let release!: (response: ExternalAgentResponse) => void;
    const pending = new Promise<ExternalAgentResponse>((resolve) => { release = resolve; });
    f.native.mockImplementationOnce(async () => pending);
    f.provider.setResponses([
      () => tool("probe", { expected_revision: draft.revision }),
      (context) => { traces.push(context); return text("连接检查已停止。"); },
    ]);
    try {
      await f.send("检查协议连接", "revoked-probe");
      await vi.waitFor(() => expect(f.native).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 20 });
      f.hub.settingsAssistant.updateContext({ ...setupContext, active: false, pageGeneration: 2 });
    } finally { release({ type: "detection", detection: f.detection }); }
    await settled(f.hub, "连接检查已停止");
    const result = lastTool(traces[0]!, "probe");
    expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain("已切换");
    expect((await f.hub.agentConfiguration.workspace(setupContext.clientId)).draft).toEqual(draft!);
    expect(draft!.verification).toBeUndefined(); expect(f.hub.getSettingsView()).toEqual(before);
    expect(f.native.mock.calls.map(([, request]) => request.operation)).toEqual(["probe"]);
  });

  it("scans installed clients first and connects in one step when confirmed", async () => {
    const f = await fixture();
    const views: KuloSettingsView[] = [];
    cleanup.push(f.hub.subscribe({ onSettings: (view) => views.push(view) }));
    f.native.mockImplementation(async (envId, request): Promise<ExternalAgentResponse> => {
      expect(envId).toBe(f.device.id);
      if (request.operation === "detect") {
        const installed = request.kind === "codex" || request.kind === "claude-code";
        return {
          type: "detection",
          detection: {
            ...structuredClone(f.detection),
            kind: request.kind,
            installed,
            ...(installed ? { version: `${request.kind}-1.0` } : { executable: undefined, version: undefined, error: "not found" }),
          },
        };
      }
      if (request.operation === "probe") {
        return {
          type: "detection",
          detection: {
            ...structuredClone(f.detection),
            kind: request.binding.kind,
            version: `${request.binding.kind}-1.0`,
            models: [{ id: "native-default", name: "Native Default", isDefault: true }],
          },
        };
      }
      throw new Error(`Unexpected native request: ${request.operation}`);
    });
    let scannedKinds: string[] = [];
    f.provider.setResponses([
      () => tool("scan"),
      (context) => {
        const result = toolValue<{ candidates: Array<{ kind: string; installed: boolean; alreadyConnected: boolean }> }>(context, "scan");
        scannedKinds = result.candidates.filter((item) => item.installed && !item.alreadyConnected).map((item) => item.kind);
        return text("在 Settings test Mac 上检测到可连接的 Codex 和 Claude Code，是否帮你连接？");
      },
    ]);
    await f.send("帮我连接本地 Agent", "agent-fast-scan");
    await settled(f.hub, "检测到可连接的 Codex 和 Claude Code");
    expect(scannedKinds).toEqual(["codex", "claude-code"]);

    let connectedResult!: { clientId: string; agentId?: string; enabled: boolean; verificationLevel: string };
    f.provider.setResponses([
      () => tool("connect", { client_kind: "codex", env_id: f.device.id, run_test: false }),
      (context) => {
        connectedResult = toolValue(context, "connect");
        return text("已完成 Codex 协议检查并保存。");
      },
    ]);
    await f.send("先只做协议检查并保存 Codex", "agent-fast-connect");
    await settled(f.hub, "已完成 Codex 协议检查并保存");
    expect(connectedResult).toMatchObject({ clientId: `codex:${f.device.id}`, enabled: false, verificationLevel: "protocol" });
    expect(connectedResult.agentId).toBeUndefined();
    const client = f.hub.getSettingsView().externalClients?.[connectedResult.clientId];
    expect(client).toMatchObject({ id: connectedResult.clientId, kind: "codex", envId: f.device.id, version: "codex-1.0" });
    expect(client?.verifiedAt).toBeUndefined();
    expect(views.some((view) => Boolean(view.externalClients?.[connectedResult.clientId]))).toBe(true);
  });

  it("keeps setup guides out of normal chat and automatic Worker skill catalogs", async () => {
    const f = await fixture(); const traces: TranscriptContext[] = [];
    expect((await f.hub.skills.snapshot()).skills.some((skill) => skill.id === "agent-configuration")).toBe(false);
    for (const audience of ["settings", "chat", "worker"] as const) {
      expect((await f.hub.skills.catalog(audience)).some((skill) => skill.id === "agent-configuration")).toBe(false);
    }
    f.devices.mockReturnValue([]);
    f.provider.setResponses([(context) => { traces.push(context); return text("普通主对话响应。"); }]);
    await f.hub.sendUserMessage("这是一条普通对话", { requestId: "normal-chat-without-agent-setup" });
    await vi.waitFor(async () => expect((await f.hub.getTopicView("root")).messages.some((message) => message.text.includes("普通主对话响应"))).toBe(true), { timeout: 10_000, interval: 20 });
    expect(traces).toHaveLength(1);
    const current = currentAgentContext(traces[0]!);
    expect(current.tools.some((name) => name.startsWith(prefix))).toBe(false);
    expect(current.sections.has("kulo_agent_configuration")).toBe(false);
    expect(JSON.stringify(traces[0]!.messages.filter((message) => message.role === "system"))).not.toContain("本指南只供当前活动");
    expect(f.native).not.toHaveBeenCalled();
  });
});
