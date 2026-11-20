import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { KuloEnvAgent } from "../packages/env/src/agent.js";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanup: Array<() => void | Promise<void>> = [];
const nativeWorkers = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
const answer = () => fauxAssistantMessage([fauxText("任务结果已收到。")]);
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY", "KULO_ENV_TOKENS"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function isWorker(request: TranscriptContext): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === "kulo_report")) || request.messages.some((message) =>
    message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) && message.toolsAdded.some((tool) => tool.name === "kulo_report"));
}

function catalog(request: TranscriptContext): string {
  return request.messages.flatMap((message) => message.role === "system" && message.sections?.kulo_skills ? [message.sections.kulo_skills] : []).at(-1) ?? "";
}

async function createHubFixture(options: {
  memory?: { enabled: boolean; knowledgeGuidanceEnabled?: boolean };
} = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-skill-worker-")));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "project");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "skill-flow", private: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "skill-worker-model" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const requests: TranscriptContext[] = [];
  let activeOperations: Array<{ name: string; args: Record<string, unknown> }> = [];
  let stage = 0;
  provider.setResponses(Array.from({ length: 48 }, () => (request: TranscriptContext) => {
    if (!isWorker(request)) return answer();
    requests.push(request);
    const operation = activeOperations[stage++];
    return operation ? call(operation.name, operation.args) : call("kulo_report", { state: "ready", summary: "预置 Skill 验证完成。" });
  }));
  const hub = await openTestHub({ models, config: {
    authToken: HUB_TEST_ADMIN_TOKEN, stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"), localEnvRoot: path.join(directory, "runtime"),
    enableLocalEnv: true,
    memory: options.memory?.enabled
      ? { enabled: true, knowledgeGuidanceEnabled: options.memory.knowledgeGuidanceEnabled, endpoint: "http://127.0.0.1:19999", accessMode: "kulo", routerApiKey: "r".repeat(36), workerApiKey: "w".repeat(36) }
      : { enabled: false },
    watchdogMinutes: 0,
    model: { defaultProvider: "openai", defaultModel: "skill-worker-model", thinkingLevel: "off", apiKey: "" },
  } });
  cleanup.push(() => hub.close());
  // Known credential text must not corrupt boolean fields in Skill tool JSON.
  hub.connectionManager.rememberSecrets(["false"]);
  const project = await hub.projects.create({ commandId: "skill-project", name: "Skill project", deviceId: "local", workspaceDir: workspace });
  const dispatch = async (commandId: string, operations: Array<{ name: string; args: Record<string, unknown> }>) => {
    activeOperations = operations;
    stage = 0;
    const ticket = await hub.dispatchTicket({ commandId, title: "验证预置 Skill", goal: "读取并准备任务需要的 Skill", scope: "当前项目", role: "coder", projectId: project.id });
    await vi.waitFor(async () => {
      const { ticket: current } = await hub.inspectTicketDetail(ticket.id);
      expect(current.status, JSON.stringify(current.latestReport)).toBe("ready");
      expect(current.cleanupPending).not.toBe(true);
    }, { timeout: 15_000, interval: 25 });
    const completed = (await hub.inspectTicketDetail(ticket.id)).ticket;
    const conversation = await hub.harness.conversation(completed.workerConversationId as ConversationId, BACKGROUND_CONTEXT);
    const results = (await conversation!.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "toolResult" && message.toolName.startsWith("kulo_skill_"));
    return { ticket: completed, results };
  };
  return { hub, requests, dispatch };
}

describe.skipIf(!nativeWorkers)("conditional Skills & capability switches through real Hub Workers", () => {
  it("loads Computer Use guides and platform references when enabled and materializes into sandbox", async () => {
    vi.stubEnv("KULO_COMPUTER_USE", "browser,desktop");
    const f = await createHubFixture();
    const { ticket, results } = await f.dispatch("skill-work-enabled", [
      { name: "kulo_skill_read", args: { id: "browser-automation" } },
      { name: "kulo_skill_read", args: { id: "desktop-automation", resource: "references/macos.md" } },
      { name: "kulo_skill_read", args: { id: "interactive-html" } },
      { name: "kulo_skill_materialize", args: { id: "browser-automation" } },
    ]);
    const initial = catalog(f.requests[0]!);
    for (const id of ["browser-automation", "desktop-automation", "interactive-html"]) expect(initial).toContain(`"id":"${id}"`);
    expect(initial).not.toContain('"id":"image-generation"');
    expect(initial).not.toContain('"id":"video-generation"');
    expect(initial).not.toContain('"id":"hindsight-knowledge"');
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.role === "toolResult" && !result.isError)).toBe(true);
    const materialized = results.find((result) => result.role === "toolResult" && result.toolName === "kulo_skill_materialize")!;
    const data = JSON.parse(materialized.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    expect(data.id).toBe("browser-automation");
    expect(data.directory.startsWith(`${ticket.scratchDir}${path.sep}`)).toBe(true);
    expect(fs.readFileSync(path.join(data.directory, "SKILL.md"), "utf8")).toContain("kulo_browser");
  });

  it("hides both Computer Use tools and guides when Computer Use toggles are turned off", async () => {
    vi.stubEnv("KULO_COMPUTER_USE", "browser,desktop");
    const f = await createHubFixture();
    const server = await startKuloHubServer(f.hub, { host: "127.0.0.1", port: 0 });
    cleanup.push(() => server.close());

    const before = await f.hub.getCapabilitiesSnapshot();
    expect(before.computerUse).toEqual({ browserEnabled: true, desktopEnabled: true });

    const res = await fetch(`${server.url}/api/capabilities/computer-use`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({ browserEnabled: false, desktopEnabled: false, expectedRevision: before.revision, commandId: "cu-off" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ computerUse: { browserEnabled: false, desktopEnabled: false } });

    const rootAgent = await f.hub.rootConversation.agent(BACKGROUND_CONTEXT);
    expect(rootAgent.callable.map((t) => t.name)).not.toContain("kulo_browser");

    const { ticket, results } = await f.dispatch("skill-work-disabled", [
      { name: "kulo_skill_read", args: { id: "browser-automation" } },
      { name: "kulo_skill_read", args: { id: "desktop-automation" } },
    ]);
    const initial = catalog(f.requests[0]!);
    expect(initial).toContain('"id":"interactive-html"');
    expect(initial).not.toContain('"id":"browser-automation"');
    expect(initial).not.toContain('"id":"desktop-automation"');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.isError)).toBe(true);

    const workerConv = (await f.hub.harness.conversation(ticket.workerConversationId as ConversationId, BACKGROUND_CONTEXT))!;
    const workerCallable = (await workerConv.agent(BACKGROUND_CONTEXT)).callable.map((t) => t.name);
    expect(workerCallable).not.toContain("kulo_browser");
    expect(workerCallable).not.toContain("kulo_desktop");
  });

  it("exposes hindsight-knowledge only when both long-term memory and the independent knowledge guide switch are enabled", async () => {
    vi.stubEnv("KULO_COMPUTER_USE", "");
    const f = await createHubFixture({
      memory: { enabled: true, knowledgeGuidanceEnabled: false },
    });
    const server = await startKuloHubServer(f.hub, { host: "127.0.0.1", port: 0 });
    cleanup.push(() => server.close());

    // Initially off -> hidden and denied even though long-term memory is enabled
    const firstRun = await f.dispatch("skill-memory-guide-off", [{ name: "kulo_skill_read", args: { id: "hindsight-knowledge" } }]);
    expect(catalog(f.requests[0]!)).not.toContain('"id":"hindsight-knowledge"');
    expect(firstRun.results[0]).toMatchObject({ isError: true });

    // Enable independent knowledge guidance switch via Long-Term Memory HTTP endpoint
    const settings = f.hub.getSettingsView();
    const res = await fetch(`${server.url}/api/memory/service/knowledge-guidance`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({ enabled: true, expectedRevision: settings.blocks.memory.revision }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { connection: { knowledgeGuidanceEnabled?: boolean } }).connection.knowledgeGuidanceEnabled).toBe(true);

    const secondRun = await f.dispatch("skill-memory-guide-on", [{ name: "kulo_skill_read", args: { id: "hindsight-knowledge" } }]);
    expect(catalog(f.requests[f.requests.length - 1]!)).toContain('"id":"hindsight-knowledge"');
    expect(secondRun.results[0]).toMatchObject({ isError: false });
  });
});

describe("orchestrator multi-device Skill resolution", () => {
  it("keeps desktop-automation and browser-automation readable when a turn mentions multiple online computers", async () => {
    vi.stubEnv("KULO_COMPUTER_USE", "browser,desktop");
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-skill-multi-")));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const macbookRoot = path.join(directory, "macbook-env");
    const macminiRoot = path.join(directory, "macmini-env");
    fs.mkdirSync(macbookRoot);
    fs.mkdirSync(macminiRoot);
    const provider = fauxProvider({ provider: "openai", models: [{ id: "orch-skill-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const requests: TranscriptContext[] = [];
    let step = 0;
    provider.setResponses([
      (request) => {
        requests.push(request);
        step++;
        return call("kulo_skill_read", { id: "desktop-automation" });
      },
      (request) => {
        requests.push(request);
        step++;
        return call("kulo_skill_read", { id: "desktop-automation", resource: "references/macos.md" });
      },
      (request) => {
        requests.push(request);
        step++;
        return fauxAssistantMessage([fauxText("多设备桌面指引已读取。")]);
      },
      // Second user turn after Macbook disconnects: targeting only offline Macbook must deny desktop-automation.
      (request) => {
        requests.push(request);
        step++;
        return call("kulo_skill_read", { id: "desktop-automation" });
      },
      (request) => {
        requests.push(request);
        step++;
        return fauxAssistantMessage([fauxText("离线设备不可读取。")]);
      },
    ]);
    const hub = await openTestHub({
      models,
      config: {
        authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir: path.join(directory, "state"),
        identityDir: path.join(directory, "identity"),
        localEnvRoot: path.join(directory, "local-env"),
        enableLocalEnv: true,
        envTokens: {
          "device-macbook": "macbook-secret-token",
          "device-macmini": "macmini-secret-token",
        },
        watchdogMinutes: 0,
        model: { defaultProvider: "openai", defaultModel: "orch-skill-model", thinkingLevel: "off", apiKey: "" },
      },
    });
    cleanup.push(() => hub.close());
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanup.push(() => server.close());

    const macbookAgent = new KuloEnvAgent({
      hubUrl: server.envWsUrl,
      envId: "device-macbook",
      name: "Macbook",
      rootDir: macbookRoot,
      authToken: "macbook-secret-token",
      capabilities: ["agent-browser", "agent-desktop"],
      reconnect: false,
    });
    const macminiAgent = new KuloEnvAgent({
      hubUrl: server.envWsUrl,
      envId: "device-macmini",
      name: "MacMini",
      rootDir: macminiRoot,
      authToken: "macmini-secret-token",
      capabilities: ["agent-browser", "agent-desktop"],
      reconnect: false,
    });
    await macbookAgent.start();
    await macminiAgent.start();
    cleanup.push(() => macbookAgent.stop());
    cleanup.push(() => macminiAgent.stop());
    await vi.waitFor(() => {
      expect(hub.envManager.getEnvDescriptor("device-macbook")?.online).toBe(true);
      expect(hub.envManager.getEnvDescriptor("device-macmini")?.online).toBe(true);
    });

    await hub.sendUserMessage("看看我的 computer use 在 Macbook 和 MacMini 上是否有效", {
      source: { deviceId: "device-macbook", name: "Macbook", kind: "computer" },
      requestId: "req-multi-1",
    });
    await hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);

    expect(step).toBe(3);
    const firstCatalog = catalog(requests[0]!);
    expect(firstCatalog).toContain('"id":"desktop-automation"');
    expect(firstCatalog).toContain('"id":"browser-automation"');

    const messagesAfterMulti = (await hub.rootConversation.context(BACKGROUND_CONTEXT)).messages;
    const skillResults = messagesAfterMulti.filter((message) => message.role === "toolResult" && message.toolName === "kulo_skill_read");
    expect(skillResults).toHaveLength(2);
    expect(skillResults[0]).toMatchObject({ isError: false });
    expect(skillResults[1]).toMatchObject({ isError: false });
    const bodyText = skillResults.map((result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n");
    expect(bodyText).toContain("设置 → 系统权限");
    expect(bodyText).toContain('state: "blocked"');

    // Negative case: disconnect both named devices and mention them -> fallback must not leak local capabilities.
    await macbookAgent.stop();
    await macminiAgent.stop();
    await vi.waitFor(() => {
      expect(hub.envManager.getEnvDescriptor("device-macbook")?.online).toBe(false);
      expect(hub.envManager.getEnvDescriptor("device-macmini")?.online).toBe(false);
    });
    await hub.sendUserMessage("在 Macbook 和 MacMini 上检查桌面自动化", {
      requestId: "req-offline-1",
    });
    await hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);

    const offlineCatalog = catalog(requests[3]!);
    expect(offlineCatalog).not.toContain('"id":"desktop-automation"');
    const allSkillResults = (await hub.rootConversation.context(BACKGROUND_CONTEXT)).messages
      .filter((message) => message.role === "toolResult" && message.toolName === "kulo_skill_read");
    expect(allSkillResults.at(-1)).toMatchObject({ isError: true });
  });
});
