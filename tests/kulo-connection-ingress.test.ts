import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { SettingsAssistantContext, TicketRecord } from "@kulo/protocol";
import { KuloHub, type KuloHubInitOptions } from "../packages/hub/src/hub.js";
import { KuloConnections } from "../packages/hub/src/connections.js";
import { ConnectionVaultError, LocalConnectionVault } from "../packages/hub/src/connection-vault.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";

const resources: Array<() => unknown | Promise<unknown>> = [];
const password = "ingress-dummy-password-57218";
const key = "sk-proj-ingress-dummy-key-abcdefghijklmnopqrstuvwxyz";

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((filename) => path.basename(String(filename)) === ".env" ? false : exists(filename));
  for (const name of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function scanFiles(root: string): Buffer[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? scanFiles(path.join(root, entry.name)) : entry.isFile() ? [fs.readFileSync(path.join(root, entry.name))] : []);
}

async function fixture(failSaving = false, enableLocalEnv = false) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-connection-ingress-"));
  resources.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const requests: string[] = [];
  let titleRequests = 0;
  const provider = fauxProvider({ provider: "connection-ingress", models: [{ id: "test" }] });
  const respond = (transcript: TranscriptContext) => {
    requests.push(JSON.stringify(transcript.messages));
    if (JSON.stringify(transcript.messages).includes("Generate a concise noun-phrase title for this Kulo conversation")) {
      titleRequests++;
      return fauxAssistantMessage('{"title":"连接授权设置"}');
    }
    return fauxAssistantMessage("已处理连接设置。");
  };
  provider.setResponses(Array.from({ length: 30 }, () => respond));
  const models = createModels(); models.setProvider(routeSettingsTitleRequests(provider));
  const keyStore = { getOrCreateKey: async () => {
    if (failSaving) throw new ConnectionVaultError("connection_vault_locked");
    return Buffer.alloc(32, 7);
  } };
  const vault = new LocalConnectionVault({ stateDir, keyStore });
  const manager = new KuloConnections({ stateDir, vault });
  const init: KuloHubInitOptions = {
    models, providerId: "connection-ingress", connectionManager: manager,
    config: { stateDir, identityDir: path.join(stateDir, "identity"), localEnvRoot: path.join(stateDir, "workspace"), enableLocalEnv,
      workerEnvIds: ["offline-node"], authToken: HUB_TEST_ADMIN_TOKEN, envTokens: { "offline-node": "ingress-node-test-token" },
      watchdogMinutes: 0, memory: { enabled: false },
      model: { defaultProvider: "connection-ingress", defaultModel: "test", thinkingLevel: "off", apiKey: "" } },
  };
  const hub = await KuloHub.open(init);
  resources.push(() => hub.close());
  return { stateDir, hub, init, manager, vault, keyStore, provider, requests, titleRequests: () => titleRequests };
}

describe("connection credential admission across user input paths", () => {
  it.skipIf(process.platform !== "darwin")("keeps the main model's generic file reader out of application-private stores", async () => {
    const f = await fixture(false, true);
    const home = path.join(f.stateDir, "synthetic-home");
    const filename = path.join(home, "Library/Mail/private.emlx");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "synthetic-mail-must-use-the-application-broker");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    let toolResults = "";
    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("read", { path: filename })], { stopReason: "toolUse" }),
      (transcript) => { toolResults = JSON.stringify(transcript.messages.filter((message) => message.role === "toolResult")); return fauxAssistantMessage("需要先连接对应应用。"); },
    ]);
    const sent = await f.hub.sendUserMessage("读取指定文件", { requestId: "private-application-reader" });
    await sent.wait(BACKGROUND_CONTEXT);
    expect(toolResults).toContain("通过已授权");
    expect(toolResults).not.toContain("synthetic-mail-must-use-the-application-broker");
  });

  it("creates an unknown credential card from chat and allows the main model to organize its schema without receiving values", async () => {
    const f = await fixture();
    const values = ["ingress-tenant-60531", "ingress-sign-seed-89426", "ingress-exchange-ticket-39451"];
    const content = `请保存这组「星云网关」凭据：\n凭据类型：自定义签名\n租户代号=${values[0]}\n签名种子=${values[1]}\n交换票据=${values[2]}`;
    const submitted = await f.hub.sendUserMessage(content, { requestId: "save-unknown-credential" });
    await submitted.wait(BACKGROUND_CONTEXT);
    const cards = (await f.manager.snapshot()).connections;
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({ kind: "custom", source: "chat", status: "saved", hasCredential: true });
    expect(card.credentialFields!.length).toBeGreaterThanOrEqual(3);
    const fields = await f.vault.get(`connection:${card.id}`);
    for (const value of values) expect(Object.values(fields!)).toContain(value);
    const organized = await f.hub.connections.describe({ kind: "orchestrator", conversationId: Number(f.hub.rootConversation.id) }, {
      id: card.id, expectedRevision: card.revision, name: "生产星云网关", typeLabel: "自定义签名",
      instructions: "用于星云网关的签名认证。", credentialFields: card.credentialFields,
    }, BACKGROUND_CONTEXT);
    expect(organized).toMatchObject({ id: card.id, kind: "custom", name: "生产星云网关", typeLabel: "自定义签名", status: "saved" });
    await f.hub.sendUserMessage(content, { requestId: "save-unknown-credential" });
    expect((await f.manager.snapshot()).connections).toHaveLength(1);
    for (const value of values) {
      expect(f.requests.join("\n")).not.toContain(value);
      expect(JSON.stringify(await f.hub.getTopicView("root"))).not.toContain(value);
      expect(JSON.stringify(await f.hub.connections.list({ kind: "orchestrator", conversationId: Number(f.hub.rootConversation.id) }, BACKGROUND_CONTEXT))).not.toContain(value);
    }
    await f.hub.close();
    for (const file of scanFiles(f.stateDir)) for (const value of values) expect(file.includes(Buffer.from(value))).toBe(false);
    const restored = new KuloConnections({ stateDir: f.stateDir, vault: new LocalConnectionVault({ stateDir: f.stateDir, keyStore: f.keyStore }) });
    await restored.initialize();
    expect((await restored.snapshot()).connections[0]).toMatchObject({ id: card.id, name: "生产星云网关", kind: "custom", typeLabel: "自定义签名" });
    for (const value of values) expect(restored.redact(`回显 ${value}`)).not.toContain(value);
  });

  it("uses the existing settings assistant to save and organize arbitrary credential fields", async () => {
    const f = await fixture();
    const context: SettingsAssistantContext = { module: "connections", hasUnsavedChanges: false, appearance: "dark", clientId: "custom-credential-settings" };
    const values = ["settings-dummy-session-62513", "settings-dummy-proof-58249"];
    await f.hub.settingsAssistant.send(`请保存星云会话凭据：\n会话票据=${values[0]}\n校验材料=${values[1]}`, context, "settings-save-custom");
    await vi.waitFor(async () => expect((await f.hub.settingsAssistant.getSnapshot()).live.busy).toBe(false));
    const card = (await f.manager.snapshot()).connections[0]!;
    expect(card).toMatchObject({ kind: "custom", status: "saved", hasCredential: true });
    const described = await f.hub.settingsAssistant.describeConnection({ id: card.id, expectedRevision: card.revision, name: "星云会话", typeLabel: "会话认证", credentialFields: card.credentialFields });
    expect(described.name).toBe("星云会话");
    f.hub.settingsAssistant.updateContext({ ...context, hasUnsavedChanges: true });
    await expect(f.hub.settingsAssistant.describeConnection({ id: card.id, expectedRevision: described.revision, name: "修改名称" })).rejects.toThrow("未保存");
    f.hub.settingsAssistant.forgetContext(context.clientId);
    await expect(f.hub.settingsAssistant.describeConnection({ id: card.id, expectedRevision: described.revision, name: "修改名称" })).rejects.toThrow("断开");
    for (const value of values) {
      expect(f.requests.join("\n")).not.toContain(value);
      expect(JSON.stringify(await f.hub.settingsAssistant.getSnapshot())).not.toContain(value);
    }
    await f.hub.close();
    for (const file of scanFiles(f.stateDir)) for (const value of values) expect(file.includes(Buffer.from(value))).toBe(false);
  });

  it("imports a chat credential once and keeps provider requests, titles, live views and disk free of plaintext", async () => {
    const f = await fixture();
    const events: string[] = [];
    f.hub.subscribe({ onTopicView: (_id, messages, live) => { events.push(JSON.stringify({ messages, live })); } });
    const topic = await f.hub.createTopic();
    const content = `保存服务器连接，名称：验收机，ssh deploy@server.example.test -p 2222，密码：${password}`;
    const submitted = await f.hub.sendUserMessage(content, { topicId: topic.id, requestId: "save-ssh" });
    await submitted.wait(BACKGROUND_CONTEXT);
    await vi.waitFor(() => { expect(f.titleRequests()).toBe(1); }, { timeout: 8_000 });
    const cards = (await f.manager.snapshot()).connections;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "ssh", host: "server.example.test", username: "deploy", port: 2222, source: "chat", hasCredential: true });
    expect((await f.vault.get(`connection:${cards[0]!.id}`))?.password).toBe(password);
    expect(JSON.stringify(await f.hub.getTopicView(topic.id))).toMatch(/已隐藏/);
    for (const captured of [...f.requests, ...events, JSON.stringify(await f.hub.harness.snapshot(KuloStateDoc))]) expect(captured).not.toContain(password);
    await f.hub.sendUserMessage(content, { topicId: topic.id, requestId: "save-ssh" });
    expect((await f.manager.snapshot()).connections).toHaveLength(1);
    await f.hub.close();
    for (const file of scanFiles(f.stateDir)) expect(file.includes(Buffer.from(password))).toBe(false);

    const restored = new KuloConnections({ stateDir: f.stateDir, vault: new LocalConnectionVault({ stateDir: f.stateDir, keyStore: f.keyStore }) });
    const reopened = await KuloHub.open({ ...f.init, connectionManager: restored });
    resources.push(() => reopened.close());
    expect((await restored.snapshot()).connections).toHaveLength(1);
    expect(JSON.stringify(await reopened.getTopicView(topic.id))).not.toContain(password);
    expect(JSON.stringify(await reopened.listTopics())).not.toContain(password);
  });

  it("uses the same secure import and history redaction in the existing settings assistant", async () => {
    const f = await fixture();
    const context: SettingsAssistantContext = { module: "connections", hasUnsavedChanges: false, appearance: "dark", clientId: "credential-settings-test" };
    await f.hub.settingsAssistant.send(`请记住账号：demo@example.test，密码：${password}，网站 https://example.test/login`, context, "settings-save");
    await vi.waitFor(async () => {
      const snapshot = await f.hub.settingsAssistant.getSnapshot();
      expect(snapshot.live.busy).toBe(false);
      expect(snapshot.messages.some((message) => message.role === "assistant")).toBe(true);
    }, { timeout: 8_000 });
    const snapshot = await f.hub.settingsAssistant.getSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain(password);
    expect(JSON.stringify(snapshot)).toMatch(/已隐藏/);
    expect((await f.manager.snapshot()).connections[0]).toMatchObject({ kind: "account", username: "demo@example.test", url: "https://example.test/login", hasCredential: true });
    for (const request of f.requests) expect(request).not.toContain(password);
    await f.hub.close();
    for (const file of scanFiles(f.stateDir)) expect(file.includes(Buffer.from(password))).toBe(false);
  });

  it("redacts an accidentally pasted API key without creating an account card against the user's intent", async () => {
    const f = await fixture();
    const sent = await f.hub.sendUserMessage(`不要保存，这个请求失败了：API_KEY=${key}`, { requestId: "no-save" });
    await sent.wait(BACKGROUND_CONTEXT);
    expect((await f.manager.snapshot()).connections).toEqual([]);
    expect(JSON.stringify(await f.hub.getTopicView("root"))).not.toContain(key);
    expect(f.requests.join("\n")).not.toContain(key);
    await f.hub.close();
    for (const file of scanFiles(f.stateDir)) expect(file.includes(Buffer.from(key))).toBe(false);
  });

  it("sanitizes Worker follow-ups before resume prompts and durable task inputs are constructed", async () => {
    const f = await fixture();
    const worker = await f.hub.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const ticket: TicketRecord = { id: "T-0099", commandId: "seed-worker", title: "等待部署", goal: "部署应用", scope: "应用目录", role: "coder", status: "blocked",
      envId: "offline-node", workspaceDir: "/workspace/app", workerConversationId: Number(worker.id), runEpoch: 1, createdAt: 1, updatedAt: 1 };
    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets[ticket.id] = ticket;
      state.conversationToTicket[String(worker.id)] = ticket.id;
    }, BACKGROUND_CONTEXT);
    await f.hub.steerTicket({ ticketId: ticket.id, commandId: "steer-password", text: `保存服务器连接，ssh deploy@server.example.test，密码：${password}` });
    const stored = (await f.hub.harness.snapshot(KuloStateDoc))!.tickets[ticket.id]!;
    expect(stored.status).toBe("waiting");
    expect(stored.resumePrompt).toMatch(/已隐藏/);
    expect(JSON.stringify(stored)).not.toContain(password);
    expect((await f.manager.snapshot()).connections[0]?.kind).toBe("ssh");
    await f.hub.close();
    for (const file of scanFiles(f.stateDir)) expect(file.includes(Buffer.from(password))).toBe(false);
  });

  it("fails before conversation admission when the local vault cannot safely store a requested credential", async () => {
    const f = await fixture(true);
    await expect(f.hub.sendUserMessage(`保存账号：demo，密码：${password}`, { requestId: "failed-save" })).rejects.toThrow("系统密钥库");
    expect((await f.hub.getTopicView("root")).messages).toEqual([]);
    expect(await f.hub.hasSubmittedRequest("root", "failed-save")).toBe(false);
    expect((await f.manager.snapshot()).connections).toEqual([]);
    expect(f.requests).toEqual([]);
    await f.hub.close();
    for (const file of scanFiles(f.stateDir)) expect(file.includes(Buffer.from(password))).toBe(false);
  });
});
