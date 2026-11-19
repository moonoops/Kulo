import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { HubToClientMessage } from "@kulo/protocol";
import { startKuloHubServer } from "@kulo/hub";
import WebSocket from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it } from "vitest";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN, withHubTestAuth } from "./helpers/hub-auth.js";

async function connect(url: string) {
  const ws = new WebSocket(withHubTestAuth(url));
  const messages: HubToClientMessage[] = [];
  const listeners = new Set<() => void>();
  ws.on("message", (raw) => { messages.push(JSON.parse(String(raw))); for (const listener of listeners) listener(); });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const until = (predicate: (message: HubToClientMessage) => boolean) => new Promise<HubToClientMessage>((resolve, reject) => {
    const check = () => {
      const found = messages.find(predicate);
      if (!found) return;
      clearTimeout(timer); listeners.delete(check); resolve(found);
    };
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error("Timed out waiting for topic activity")); }, 8_000);
    listeners.add(check); check();
  });
  return { ws, messages, until };
}

it("broadcasts running and completed activity across topics while keeping message contents scoped", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-topic-activity-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([async () => { await gate; return fauxAssistantMessage("Private completed reply"); }]);
  const hub = await openTestHub({ config: { stateDir, authToken: HUB_TEST_ADMIN_TOKEN,
    model: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "gpt-4o", thinkingLevel: "off" } }, models });
  const server = await startKuloHubServer(hub, { port: 0 });
  const clients: WebSocket[] = [];
  try {
    const topic = await hub.createTopic("Other conversation");
    const root = await connect(server.clientWsUrl); clients.push(root.ws);
    await root.until((message) => message.type === "hub.snapshot");
    await hub.sendUserMessage("Private user question", { topicId: topic.id });
    await root.until((message) => message.type === "hub.topic_activity" && message.topicId === topic.id && message.activity.busy);
    release();
    const complete = await root.until((message) => message.type === "hub.topic_activity" && message.topicId === topic.id && !message.activity.busy && message.activity.lastAssistantMessageId !== undefined);
    expect(JSON.stringify(complete)).not.toContain("Private");
    expect(root.messages.filter((message) => (message.type === "hub.messages" || message.type === "hub.live") && message.topicId === topic.id)).toEqual([]);
    const reconnected = await connect(server.clientWsUrl); clients.push(reconnected.ws);
    const snapshot = await reconnected.until((message) => message.type === "hub.snapshot");
    expect(snapshot.type === "hub.snapshot" && snapshot.topicActivities?.[topic.id]).toMatchObject({ busy: false, lastAssistantMessageId: expect.any(Number) });
    const current = await connect(`${server.clientWsUrl}?topic=${encodeURIComponent(topic.id)}`); clients.push(current.ws);
    const currentSnapshot = await current.until((message) => message.type === "hub.snapshot");
    expect(currentSnapshot.type === "hub.snapshot" && currentSnapshot.messages.some((message) => message.text === "Private completed reply")).toBe(true);
  } finally {
    release();
    for (const client of clients) client.terminate();
    await server.close(); await hub.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

it("restores watches only for unfinished topic submissions after a Hub restart", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-topic-activity-restart-"));
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  let resumed!: () => void;
  const secondStarted = new Promise<void>((resolve) => { resumed = resolve; });
  let finish!: () => void;
  const finishGate = new Promise<void>((resolve) => { finish = resolve; });
  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    async (_context, options) => {
      started();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      options?.signal?.throwIfAborted();
      return fauxAssistantMessage("Should remain interrupted");
    },
    async () => { resumed(); await finishGate; return fauxAssistantMessage("Restored reply"); },
  ]);
  const init = { config: { stateDir, authToken: HUB_TEST_ADMIN_TOKEN,
    model: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions" as const, defaultModel: "gpt-4o", thinkingLevel: "off" as const } }, models };
  let hub = await openTestHub(init);
  let server: Awaited<ReturnType<typeof startKuloHubServer>> | undefined;
  let client: WebSocket | undefined;
  try {
    const idle = await hub.createTopic("Idle history");
    const active = await hub.createTopic("Previously titled active conversation");
    await hub.sendUserMessage("Continue after restart", { topicId: active.id });
    await firstStarted;
    await hub.close();
    hub = await openTestHub(init);
    await secondStarted;
    const snapshot = await hub.getFullClientSnapshot("root");
    expect(snapshot.topicActivities[active.id]?.busy).toBe(true);
    expect(snapshot.topicActivities[idle.id]).toBeUndefined();
    server = await startKuloHubServer(hub, { port: 0 });
    const connected = await connect(server.clientWsUrl); client = connected.ws;
    await connected.until((message) => message.type === "hub.snapshot");
    finish();
    await connected.until((message) => message.type === "hub.topic_activity" && message.topicId === active.id && !message.activity.busy && message.activity.lastAssistantMessageId !== undefined);
    expect((await hub.getTopicView(active.id, BACKGROUND_CONTEXT)).messages.some((message) => message.text === "Restored reply")).toBe(true);
  } finally {
    finish(); client?.terminate();
    if (server) await server.close();
    await hub.close(); fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
