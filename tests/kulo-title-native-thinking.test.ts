import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { SettingsAssistantDoc } from "../packages/hub/src/settings-assistant.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
const settingsContext = { module: "machines" as const, hasUnsavedChanges: false, appearance: "dark" as const, clientId: "native-title" };
const secret = "synthetic-provider-secret-never-log";

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((filename) => path.basename(String(filename)) === ".env" ? false : exists(filename));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
  vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function until(check: () => Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 8000, interval: 20 });
}

async function fixture() {
  const requests: Array<{ title: boolean; thinking: Record<string, unknown> }> = [];
  let rejectTitles = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gemini-4-hydrogen" }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const title = JSON.stringify(payload.systemInstruction).includes("Generate a concise noun-phrase title for this Kulo conversation");
    const thinking = payload.generationConfig?.thinkingConfig ?? {};
    requests.push({ title, thinking });
    if ("thinkingBudget" in thinking || title && rejectTitles) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT",
        message: `Thinking budget is not supported for this model. Use thinking level instead. ${secret}` } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: title ? '{"title":"本机连接排查"}' : "先检查本机连接。" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-native-title-"));
  cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = "api-native-title";
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const init = { config: { stateDir, identityDir: path.join(stateDir, "identity"), enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false }, model: {
    defaultProvider: provider, defaultModel: "gemini-4-hydrogen", thinkingLevel: "balanced", gatewayDisabled: true,
    customProviders: [{ id: provider, name: "Local Vertex", api: "google-vertex" as const, baseUrl,
      models: [{ id: "gemini-4-hydrogen", reasoning: true, thinkingLevels: [{ id: "balanced", label: "平衡", value: "low" }] }] }],
  } } };
  let hub = await openTestHub(init);
  await hub.setProviderApiKey(provider, "synthetic-local-key");
  cleanups.push(() => hub.close());
  return { get hub() { return hub; }, requests, rejectTitles: (value: boolean) => { rejectTitles = value; },
    reopen: async () => { await hub.close(); hub = await openTestHub(init); },
  };
}

describe("native Gemini title requests", () => {
  it.each(["topic", "settings"] as const)("uses the resolved thinking level for %s titles", async (scope) => {
    const f = await fixture();
    if (scope === "topic") {
      const topic = await f.hub.createTopic();
      await f.hub.sendUserMessage("请排查本机连接问题", { topicId: topic.id });
      await until(async () => (await f.hub.listTopics()).find((item) => item.id === topic.id)?.title === "本机连接排查");
    } else {
      await f.hub.settingsAssistant.send("请排查本机连接问题", settingsContext, "native-settings");
      await until(async () => (await f.hub.settingsAssistant.getSnapshot()).conversations[0]?.title === "本机连接排查");
    }
    expect(f.requests.filter((request) => request.title)).toHaveLength(1);
    for (const request of f.requests) {
      expect(request.thinking).toMatchObject({ thinkingLevel: "LOW" });
      expect(request.thinking).not.toHaveProperty("thinkingBudget");
    }
  });

  it.each(["topic", "settings"] as const)("diagnoses real provider errors and retries %s titles once after restart", async (scope) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await fixture(); f.rejectTitles(true);
    let id: string;
    if (scope === "topic") {
      const topic = await f.hub.createTopic(); id = topic.id;
      await f.hub.sendUserMessage("请排查本机连接问题", { topicId: id });
    } else {
      await f.hub.settingsAssistant.send("请排查本机连接问题", settingsContext, "native-settings");
      id = (await f.hub.settingsAssistant.getSnapshot()).topicId!.slice("settings-".length);
    }
    const job = async () => scope === "topic"
      ? (await f.hub.harness.snapshot(KuloStateDoc))?.topicTitles?.[id]
      : (await f.hub.harness.snapshot(SettingsAssistantDoc))?.titleJobs?.[id];
    await until(async () => (await job())?.status === "failed");
    expect((await job())?.failure?.code).toBe("thinking_configuration");
    expect(JSON.stringify((await job())?.failure)).not.toContain(secret);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    const failedConversation = (await job())?.conversationId;
    f.rejectTitles(false);
    await f.reopen();
    await until(async () => (await job())?.status === "done");
    expect((await job())?.conversationId).not.toBe(failedConversation);
    expect((await job())?.retryCount).toBe(1);
    expect(f.requests.filter((request) => request.title)).toHaveLength(2);
  });

  it("does not issue a third request when the controlled restart retry also fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await fixture(); f.rejectTitles(true);
    const topic = await f.hub.createTopic();
    await f.hub.sendUserMessage("请排查本机连接问题", { topicId: topic.id });
    const job = async () => (await f.hub.harness.snapshot(KuloStateDoc))?.topicTitles?.[topic.id];
    await until(async () => (await job())?.status === "failed");
    await f.reopen();
    await until(async () => (await job())?.status === "failed" && (await job())?.retryCount === 1);
    f.rejectTitles(false);
    await f.reopen();
    expect((await job())?.status).toBe("failed");
    expect(f.requests.filter((request) => request.title)).toHaveLength(2);
  });
});
