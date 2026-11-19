import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import WebSocket from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { applyTicketBoardDelta, type TicketRecord } from "@kulo/protocol";
import { KuloHub, startKuloHubServer } from "@kulo/hub";
import type { ClientToHubMessage, HubToClientMessage } from "@kulo/protocol";
import { HUB_TEST_ADMIN_TOKEN, withHubTestAuth } from "./helpers/hub-auth";
import { traceTicketTransitions } from "./helpers/ticket-trace.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kulo-ws-ack-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function isOrchestratorContext(ctx: TranscriptContext): boolean {
  if (ctx.tools?.some((t) => t.name === "kulo_dispatch")) return true;
  return ctx.messages.some(
    (m) =>
      m.role === "system" &&
      "toolsAdded" in m &&
      Array.isArray(m.toolsAdded) &&
      m.toolsAdded.some((t) => t.name === "kulo_dispatch"),
  );
}

async function openWsClient(url: string): Promise<{
  ws: WebSocket;
  received: HubToClientMessage[];
  send: (msg: ClientToHubMessage) => void;
  waitFor: <T extends HubToClientMessage["type"]>(
    type: T,
    predicate?: (msg: Extract<HubToClientMessage, { type: T }>) => boolean,
    timeoutMs?: number,
  ) => Promise<Extract<HubToClientMessage, { type: T }>>;
  close: () => Promise<void>;
}> {
  const ws = new WebSocket(withHubTestAuth(url));
  const received: HubToClientMessage[] = [];
  const waiters = new Set<() => void>();

  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString("utf8")) as HubToClientMessage;
    received.push(parsed);
    for (const notify of waiters) notify();
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const waitFor = <T extends HubToClientMessage["type"]>(
    type: T,
    predicate?: (msg: Extract<HubToClientMessage, { type: T }>) => boolean,
    timeoutMs = 8_000,
  ) =>
    new Promise<Extract<HubToClientMessage, { type: T }>>((resolve, reject) => {
      const findMatch = () => {
        for (const item of received) {
          if (item.type === type) {
            const typed = item as Extract<HubToClientMessage, { type: T }>;
            if (!predicate || predicate(typed)) return typed;
          }
        }
        return undefined;
      };

      const initial = findMatch();
      if (initial) {
        resolve(initial);
        return;
      }

      const timer = setTimeout(() => {
        waiters.delete(onMessage);
        reject(new Error(`Timed out waiting for WS message '${type}'`));
      }, timeoutMs);

      const onMessage = () => {
        const hit = findMatch();
        if (hit) {
          clearTimeout(timer);
          waiters.delete(onMessage);
          resolve(hit);
        }
      };

      waiters.add(onMessage);
    });

  return {
    ws,
    received,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor,
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

async function withClientSession(run: (hub: KuloHub, connect: (query?: string) => ReturnType<typeof openWsClient>) => Promise<void>) {
  const stateDir = makeTempDir("session");
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "openai", models: [{ id: "socket-test" }] }).provider);
  const hub = await openTestHub({ models, config: { stateDir, identityDir: path.join(stateDir, "identity"), authToken: HUB_TEST_ADMIN_TOKEN,
    enableLocalEnv: false, memory: { enabled: false }, model: { defaultProvider: "openai", defaultModel: "socket-test", baseUrl: "http://127.0.0.1:9/v1" } } });
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  const clients: Awaited<ReturnType<typeof openWsClient>>[] = [];
  try {
    await run(hub, async (query = "") => {
      const client = await openWsClient(server.clientWsUrl + query);
      clients.push(client);
      return client;
    });
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
    await hub.close();
  }
}

// A WebSocket control pong confirms all preceding frames reached the server, even when its snapshot is blocked.
function flushSocket(ws: WebSocket) {
  return new Promise<void>((resolve) => { ws.once("pong", () => resolve()); ws.ping(); });
}

describe("client socket subscriptions", () => {
  it("handles subscriptions sent during its initial read and discards them if that socket closes", async () => {
    await withClientSession(async (hub, connect) => {
      const starting = gate();
      const initial = hub.getFullClientSnapshot.bind(hub);
      const reads = vi.spyOn(hub, "getFullClientSnapshot").mockImplementation(async (...args) => {
        const snapshot = await initial(...args);
        await starting.wait;
        return snapshot;
      });
      const context = { module: "workers", hasUnsavedChanges: false, appearance: "light", clientId: "early-client" } as const;
      const updates = vi.spyOn(hub.settingsAssistant, "updateContext");
      const abandoned = await connect();
      const connected = await connect();
      try {
        abandoned.send({ type: "settings.assistant.subscribe", context: { ...context, clientId: "abandoned" }, requestId: "abandoned" });
        connected.send({ type: "settings.assistant.subscribe", context, requestId: "early" });
        await Promise.all([flushSocket(abandoned.ws), flushSocket(connected.ws)]);
        await abandoned.close();
      } finally { starting.release(); }
      expect((await connected.waitFor("hub.snapshot")).supportsPing).toBe(true);
      await connected.waitFor("hub.settings_assistant", (message) => message.requestId === "early");
      await connected.waitFor("hub.ack", (message) => message.requestId === "early");
      expect(connected.received[0]?.type).toBe("hub.snapshot");
      expect(updates.mock.calls.map(([value]) => value.clientId)).toEqual(["early-client"]);
      const beforePing = reads.mock.calls.length;
      connected.send({ type: "client.ping", requestId: "heartbeat" });
      await connected.waitFor("hub.ack", (message) => message.requestId === "heartbeat");
      expect(reads.mock.calls).toHaveLength(beforePing);
    });
  });

  it("keeps the latest topic when an earlier select and sync both finish late, including reconnect", async () => {
    await withClientSession(async (hub, connect) => {
      const a = await hub.createTopic("Earlier selection");
      const b = await hub.createTopic("Latest selection");
      const client = await connect();
      await client.waitFor("hub.snapshot");
      const oldSync = gate(), readingSync = gate(), oldSelect = gate(), readingSelect = gate();
      const full = hub.getFullClientSnapshot.bind(hub);
      vi.spyOn(hub, "getFullClientSnapshot").mockImplementationOnce(async (...args) => {
        const snapshot = await full(...args);
        readingSync.release();
        await oldSync.wait;
        return snapshot;
      });
      const view = hub.getTopicView.bind(hub);
      vi.spyOn(hub, "getTopicView").mockImplementation(async (...args) => {
        const result = await view(...args);
        if (args[0] === a.id) { readingSelect.release(); await oldSelect.wait; }
        return result;
      });
      try {
        client.send({ type: "state.sync", requestId: "old-sync" });
        await readingSync.wait;
        client.send({ type: "topic.select", topicId: a.id, selectionVersion: 1, requestId: "select-a" });
        await readingSelect.wait;
        client.send({ type: "topic.select", topicId: b.id, selectionVersion: 2, requestId: "select-b" });
        await client.waitFor("hub.ack", (message) => message.requestId === "select-b");
      } finally { oldSelect.release(); oldSync.release(); }
      await client.waitFor("hub.ack", (message) => message.requestId === "select-a");
      await client.waitFor("hub.ack", (message) => message.requestId === "old-sync");
      expect(client.received.filter((message) => message.type === "hub.snapshot").map((message) => [message.activeTopicId, message.selectionVersion])).toEqual([["root", 0], [b.id, 2]]);
      expect(client.received.some((message) => message.type === "hub.messages" && message.selectionVersion === 1)).toBe(false);
      await client.close();
      const reconnect = await connect(`?topic=${encodeURIComponent(b.id)}&selectionVersion=2`);
      expect(await reconnect.waitFor("hub.snapshot")).toMatchObject({ activeTopicId: b.id, selectionVersion: 2 });
    });
  });

  it("keeps new messages when a full snapshot arrives after a broadcast and checks deletion before publishing", async () => {
    await withClientSession(async (hub, connect) => {
      const a = await hub.createTopic("First visit");
      const b = await hub.createTopic("Other conversation");
      const client = await connect(`?topic=${a.id}`);
      await client.waitFor("hub.snapshot");
      const full = hub.getFullClientSnapshot.bind(hub);
      const reads = vi.spyOn(hub, "getFullClientSnapshot");
      const delayNextSnapshot = () => {
        const captured = gate(), release = gate();
        reads.mockImplementationOnce(async (...args) => {
          const snapshot = await full(...args);
          captured.release();
          await release.wait;
          return snapshot;
        });
        return { captured, release };
      };
      const readView = hub.getTopicView.bind(hub);
      const firstVisit = gate(), releaseFirstVisit = gate();
      vi.spyOn(hub, "getTopicView").mockImplementationOnce(async (...args) => {
        const result = await readView(...args);
        firstVisit.release();
        await releaseFirstVisit.wait;
        return result;
      });
      try {
        client.send({ type: "topic.select", topicId: a.id, selectionVersion: 1, requestId: "first-visit" });
        await firstVisit.wait;
        client.send({ type: "topic.select", topicId: b.id, selectionVersion: 2, requestId: "visit-b" });
        await client.waitFor("hub.ack", (message) => message.requestId === "visit-b");
        client.send({ type: "topic.select", topicId: a.id, selectionVersion: 3, requestId: "visit-a-again" });
        await client.waitFor("hub.ack", (message) => message.requestId === "visit-a-again");
      } finally { releaseFirstVisit.release(); }
      await client.waitFor("hub.ack", (message) => message.requestId === "first-visit");
      expect(client.received.filter((message) => message.type === "hub.messages" && message.selectionVersion !== undefined)
        .map((message) => message.type === "hub.messages" && message.selectionVersion)).toEqual([2, 3]);

      const delayed = delayNextSnapshot();
      const text = "published during the snapshot read";
      try {
        client.send({ type: "state.sync", requestId: "delayed" });
        await delayed.captured.wait;
        await hub.harness.commit((tx) => tx.appendEntry(UserEntry, a.conversationId as ConversationId, {
          model: [{ role: "user", content: text, timestamp: Date.now() }],
        }), BACKGROUND_CONTEXT);
        await client.waitFor("hub.messages", (message) => message.messages.some((item) => item.text === text));
      } finally { delayed.release.release(); }
      await client.waitFor("hub.ack", (message) => message.requestId === "delayed");
      const afterBroadcast = client.received.filter((message) => message.type === "hub.snapshot").at(-1);
      expect(afterBroadcast).toMatchObject({ activeTopicId: a.id, selectionVersion: 3, messages: expect.arrayContaining([expect.objectContaining({ text })]) });

      const beforeDeletion = delayNextSnapshot();
      try {
        client.send({ type: "state.sync", requestId: "before-deletion" });
        await beforeDeletion.captured.wait;
        await hub.deleteTopic(a.id);
      } finally { beforeDeletion.release.release(); }
      await client.waitFor("hub.ack", (message) => message.requestId === "before-deletion");
      const afterDeletion = client.received.filter((message) => message.type === "hub.snapshot").at(-1);
      expect(afterDeletion).toMatchObject({ activeTopicId: "root", selectionVersion: 3, messages: [] });
      expect(afterDeletion?.topics.some((topic) => topic.id === a.id)).toBe(false);
    });
  });

  it("shares the same live watch when two clients arrive at an unloaded topic together", async () => {
    await withClientSession(async (hub, connect) => {
      const topic = await hub.createTopic("Restored conversation");
      await hub.deleteTopic(topic.id);
      await hub.projects.restoreTopic(topic.id);
      const bothReading = gate(), resume = gate();
      const cards = hub.uiCards.snapshot.bind(hub.uiCards);
      let readers = 0;
      vi.spyOn(hub.uiCards, "snapshot").mockImplementation(async (...args) => {
        if (args[0] === topic.conversationId) {
          if (++readers === 2) bothReading.release();
          await resume.wait;
        }
        return cards(...args);
      });
      const [one, two] = await Promise.all([connect(`?topic=${topic.id}`), connect(`?topic=${topic.id}`)]);
      try { await bothReading.wait; } finally { resume.release(); }
      await Promise.all([one.waitFor("hub.snapshot"), two.waitFor("hub.snapshot")]);
      const received = vi.fn();
      const unsubscribe = hub.subscribe({ onTopicView: (id, messages) => {
        if (id === topic.id && messages.some((item) => item.text === "one publication")) received();
      } });
      try {
        await hub.harness.commit((tx) => tx.appendEntry(UserEntry, topic.conversationId as ConversationId, {
          model: [{ role: "user", content: "one publication", timestamp: Date.now() }],
        }), BACKGROUND_CONTEXT);
        await Promise.all([one, two].map((client) => client.waitFor("hub.messages", (msg) => msg.messages.some((item) => item.text === "one publication"))));
        expect(received).toHaveBeenCalledTimes(1);
      } finally { unsubscribe(); }
    });
  });
});

describe("WebSocket Request ACK, Error Attribution & Idempotency Suite", () => {
  it("delivers versioned ticket edits and deletions alongside legacy snapshots, including changes in redaction", async () => {
    const stateDir = makeTempDir("ticket-delta");
    const models = createModels();
    models.setProvider(fauxProvider({ provider: "openai", models: [{ id: "test" }] }).provider);
    const hub = await openTestHub({ models, config: { stateDir, identityDir: path.join(stateDir, "identity"),
      authToken: HUB_TEST_ADMIN_TOKEN, envTokens: {}, enableLocalEnv: false, memory: { enabled: false },
      model: { defaultProvider: "openai", defaultModel: "test", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" } } });
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    const clients: Awaited<ReturnType<typeof openWsClient>>[] = [];
    const makeTicket = (id: string, at: number): TicketRecord => ({
      id, commandId: id, title: id, role: "coder", goal: "test", scope: "test", status: "closed",
      envId: "local", workspaceDir: stateDir, workerConversationId: at, runEpoch: 1, createdAt: at, updatedAt: at,
    });
    try {
      await hub.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        state.tickets.first = makeTicket("first", 1);
        state.tickets.second = makeTicket("second", 2);
      }, BACKGROUND_CONTEXT);
      const url = new URL(server.clientWsUrl);
      url.searchParams.set("ticketDeltas", "1");
      const modern = await openWsClient(url.href); clients.push(modern);
      const legacy = await openWsClient(server.clientWsUrl); clients.push(legacy);
      const snapshot = await modern.waitFor("hub.snapshot");
      await legacy.waitFor("hub.snapshot");
      await hub.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        state.tickets.first!.title = "ordinary text displayed before it is marked private";
        state.tickets.first!.updatedAt = 3;
      }, BACKGROUND_CONTEXT);
      const edit = await modern.waitFor("hub.ticket_delta", m => m.upsert.some(t => t.updatedAt === 3));
      const full = await legacy.waitFor("hub.tickets", m => m.tickets[0]?.updatedAt === 3);
      expect(edit.previousRevision).toBe(snapshot.ticketRevision);
      expect(edit.upsert.map(t => t.id)).toEqual(["first"]);
      const afterEdit = applyTicketBoardDelta(snapshot.tickets, edit);
      expect(afterEdit).toEqual(full.tickets);
      expect(afterEdit[1]).toBe(snapshot.tickets[0]);
      const localView = await hub.getBoardSnapshot();
      localView.tickets[0]!.title = "local-only change";
      localView.tickets.reverse();
      localView.slots.max = -1;
      expect(hub.getCurrentTicketBoard()).toMatchObject({ tickets: full.tickets, slots: full.slots });
      hub.connectionManager.rememberSecrets(["marked private"]);
      const redacted = hub.getCurrentTicketBoard();
      const privacy = await modern.waitFor("hub.ticket_delta", m => m.previousRevision === edit.ticketRevision);
      expect(JSON.stringify(privacy)).not.toContain("marked private");
      expect(applyTicketBoardDelta(afterEdit, privacy)).toEqual(redacted.tickets);
      await hub.harness.commit(async tx => { delete (await tx.doc(KuloStateDoc)).tickets.first; }, BACKGROUND_CONTEXT);
      const removal = await modern.waitFor("hub.ticket_delta", m => m.removed.includes("first"));
      expect(removal.previousRevision).toBe(privacy.ticketRevision);
      modern.send({ type: "state.sync", requestId: "board-sync" });
      const synced = await modern.waitFor("hub.snapshot", m => m.ticketRevision === removal.ticketRevision);
      expect(applyTicketBoardDelta(redacted.tickets, removal)).toEqual(synced.tickets);
      const phrase = "private test phrase";
      const redact = hub.connectionManager.redact.bind(hub.connectionManager);
      vi.spyOn(hub.connectionManager, "redact").mockImplementation(text => {
        if (text === "register this test phrase") hub.connectionManager.rememberSecrets([phrase]);
        return redact(text);
      });
      await hub.harness.commit(async tx => {
        const state = await tx.doc(KuloStateDoc);
        state.tickets.echo = { ...makeTicket("echo", 4), title: phrase };
        state.tickets.register = { ...makeTicket("register", 5), title: "register this test phrase" };
      }, BACKGROUND_CONTEXT);
      const combined = await modern.waitFor("hub.ticket_delta", m => m.upsert.some(t => t.id === "register"));
      const legacyCombined = await legacy.waitFor("hub.tickets", m => m.tickets.some(t => t.id === "register"));
      expect(JSON.stringify(combined)).not.toContain(phrase);
      expect(applyTicketBoardDelta(synced.tickets, combined)).toEqual(legacyCombined.tickets);
      expect(modern.received.some(m => m.type === "hub.tickets")).toBe(false);
      expect(legacy.received.some(m => m.type === "hub.ticket_delta")).toBe(false);
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await server.close();
      await hub.close();
    }
  });

  it("1. emits matching hub.ack and deduplicates repeated chat.send requestId across reconnects", async () => {
    const stateDir = makeTempDir("chat-ack");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    faux.setResponses(
      Array.from({ length: 10 }, () => () =>
        fauxAssistantMessage([fauxText("已收到消息。")]),
      ),
    );

    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        model: {
          baseUrl: "http://127.0.0.1:9/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "medium",
        },
      },
      models,
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      const c1 = await openWsClient(server.clientWsUrl);
      await c1.waitFor("hub.snapshot");

      c1.send({
        type: "chat.send",
        topicId: "root",
        content: "幂等消息测试",
        requestId: "req-idempotent-1",
      });

      const ack1 = await c1.waitFor(
        "hub.ack",
        (m) => m.requestId === "req-idempotent-1",
      );
      expect(ack1.action).toBe("chat.send");
      expect(ack1.topicId).toBe("root");
      expect(ack1.deduplicated).toBeUndefined();

      await c1.close();

      // Reconnect and resend with the exact same requestId
      const c2 = await openWsClient(server.clientWsUrl);
      await c2.waitFor("hub.snapshot");
      c2.send({
        type: "chat.send",
        topicId: "root",
        content: "幂等消息测试",
        requestId: "req-idempotent-1",
      });

      const ack2 = await c2.waitFor(
        "hub.ack",
        (m) => m.requestId === "req-idempotent-1",
      );
      expect(ack2.action).toBe("chat.send");
      expect(ack2.topicId).toBe("root");
      expect(ack2.deduplicated).toBe(true);

      const view = await hub.getTopicView("root");
      const userMsgs = view.messages.filter(
        (m) => m.role === "user" && m.text === "幂等消息测试",
      );
      expect(userMsgs).toHaveLength(1);

      await c2.close();
    } finally {
      await server.close();
      await hub.close();
    }
  });

  it("2. attributes hub.error with action, requestId/commandId, topicId, and ticketId (including ticket.inspect failure)", async () => {
    const stateDir = makeTempDir("error-attr");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([() => fauxAssistantMessage([fauxText("ok")])]);

    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        model: {
          baseUrl: "http://127.0.0.1:9/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "medium",
        },
      },
      models,
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      const topicA = await hub.createTopic("话题 A");
      const client = await openWsClient(server.clientWsUrl);
      await client.waitFor("hub.snapshot");

      // 1) Invalid attachment on topic A should carry topicId + requestId + action
      client.send({
        type: "chat.send",
        topicId: topicA.id,
        content: "带非法附件的消息",
        attachments: [
          {
            id: "att_nonexistent_123456",
            name: "missing.png",
            mimeType: "image/png",
            size: 128,
            kind: "image",
            url: "/api/uploads/att_nonexistent_123456",
          },
        ],
        requestId: "req-bad-att-1",
      });

      const chatErr = await client.waitFor(
        "hub.error",
        (m) => m.requestId === "req-bad-att-1",
      );
      expect(chatErr.action).toBe("chat.send");
      expect(chatErr.topicId).toBe(topicA.id);
      expect(chatErr.message).toBeTruthy();

      // 2) ticket.inspect on missing ticketId should carry action + ticketId + requestId
      client.send({
        type: "ticket.inspect",
        ticketId: "T-9999",
        requestId: "req-inspect-missing",
      });

      const inspectErr = await client.waitFor(
        "hub.error",
        (m) => m.requestId === "req-inspect-missing",
      );
      expect(inspectErr.action).toBe("ticket.inspect");
      expect(inspectErr.ticketId).toBe("T-9999");
      expect(inspectErr.message).toContain("T-9999");

      await client.close();
    } finally {
      await server.close();
      await hub.close();
    }
  });

  it("3. deduplicates ticket.steer and ticket.close by commandId without double-incrementing runEpoch or throwing", async () => {
    const stateDir = makeTempDir("ticket-cmd-idem");
    const workRoot = makeTempDir("work-root");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let workerCalls = 0;

    faux.setResponses(
      Array.from({ length: 16 }, () => (ctx) => {
        if (isOrchestratorContext(ctx)) {
          return fauxAssistantMessage([fauxText("已同步工单进展。")]);
        }
        workerCalls += 1;
        if (workerCalls === 1) {
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_report", {
                state: "blocked",
                summary: "等待确认端口",
                question: "使用 8080 还是 9090？",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage(
          [
            fauxToolCall("kulo_report", {
              state: "ready",
              summary: "已使用 8080 完成配置",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        localEnvRoot: workRoot,
        model: {
          baseUrl: "http://127.0.0.1:9/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "medium",
        },
      },
      models,
    });
    const server = await startKuloHubServer(hub, { port: 0 });
    let ticketTrace: ReturnType<typeof traceTicketTransitions> | undefined;

    try {
      const client = await openWsClient(server.clientWsUrl);
      await client.waitFor("hub.snapshot");
      const dispatched = await hub.dispatchTicket({
        commandId: "dispatch-port-1",
        title: "配置服务监听端口",
        goal: "设置服务端口",
        scope: workRoot,
        role: "coder",
      });
      ticketTrace = traceTicketTransitions(hub, dispatched.id);

      const waiting = await client.waitFor(
        "hub.tickets",
        (m) =>
          m.tickets.some(
            (t) => t.id === dispatched.id && t.status === "waiting" && t.waiting?.reason === "user",
          ),
      );
      expect(waiting.slots.used).toBe(0);
      const pausedEpoch = (await hub.inspectTicketDetail(dispatched.id)).ticket.runEpoch;

      // Steer once with commandId "cmd-steer-port-1"
      client.send({
        type: "ticket.steer",
        ticketId: dispatched.id,
        text: "使用 8080",
        commandId: "cmd-steer-port-1",
      });
      const steerAck1 = await client.waitFor(
        "hub.ack",
        (m) => m.commandId === "cmd-steer-port-1",
      );
      expect(steerAck1.action).toBe("ticket.steer");
      expect(steerAck1.ticketId).toBe(dispatched.id);
      expect(steerAck1.deduplicated).toBeUndefined();

      // Wait until ready
      await client.waitFor(
        "hub.tickets",
        (m) =>
          m.tickets.some((t) => t.id === dispatched.id && t.status === "ready"),
      );
      const readyEpoch = (await hub.inspectTicketDetail(dispatched.id)).ticket.runEpoch;
      expect(readyEpoch).toBe(pausedEpoch + 1);

      // Duplicate steer with the exact same commandId must be deduplicated cleanly
      client.send({
        type: "ticket.steer",
        ticketId: dispatched.id,
        text: "使用 8080",
        commandId: "cmd-steer-port-1",
      });
      const steerAck2 = await client.waitFor(
        "hub.ack",
        (m) =>
          m.commandId === "cmd-steer-port-1" && m.deduplicated === true,
      );
      expect(steerAck2.deduplicated).toBe(true);

      const detailAfterDupSteer = await hub.inspectTicketDetail(dispatched.id);
      expect(detailAfterDupSteer.ticket.runEpoch).toBe(readyEpoch);
      expect(workerCalls).toBe(2);

      // Close once with commandId "cmd-close-port-1", then repeat same commandId
      client.send({
        type: "ticket.close",
        ticketId: dispatched.id,
        kind: "obsolete",
        reason: "验收完成收口",
        commandId: "cmd-close-port-1",
      });
      const closeAck1 = await client.waitFor(
        "hub.ack",
        (m) => m.commandId === "cmd-close-port-1",
      );
      expect(closeAck1.deduplicated).toBeUndefined();

      client.send({
        type: "ticket.close",
        ticketId: dispatched.id,
        kind: "obsolete",
        reason: "验收完成收口",
        commandId: "cmd-close-port-1",
      });
      const closeAck2 = await client.waitFor(
        "hub.ack",
        (m) =>
          m.commandId === "cmd-close-port-1" && m.deduplicated === true,
      );
      expect(closeAck2.deduplicated).toBe(true);

      client.send({ type: "ticket.steer", ticketId: dispatched.id, text: "新的语音补充", commandId: "cmd-after-close" });
      const rejected = await client.waitFor("hub.error", (m) => m.commandId === "cmd-after-close");
      expect(rejected.code).toBe("ticket_stopped");
      expect(rejected.action).toBe("ticket.steer");
      expect(await hub.hasProcessedCommand("cmd-after-close")).toBe(false);

      const afterClose = client.received.length;
      client.send({ type: "ticket.steer", ticketId: dispatched.id, text: "使用 8080", commandId: "cmd-steer-port-1" });
      const acceptedReplay = await client.waitFor("hub.ack", (m) =>
        m.commandId === "cmd-steer-port-1" && client.received.indexOf(m) >= afterClose);
      expect(acceptedReplay.deduplicated).toBe(true);
      expect(workerCalls).toBe(2);

      await client.close();
    } catch (error) {
      throw new Error(`Ticket command trace: ${JSON.stringify(ticketTrace?.events)}`, { cause: error });
    } finally {
      ticketTrace?.stop();
      await server.close();
      await hub.close();
    }
  });

  it("enforces same-origin on /ws/client, sets no-referrer/nosniff headers, and returns safe 503 when web dist is missing", async () => {
    const stateDir = makeTempDir("http-security-state");
    const emptyWebDir = makeTempDir("empty-web-dist");
    const populatedWebDir = makeTempDir("populated-web-dist");
    fs.writeFileSync(path.join(populatedWebDir, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>");
    fs.writeFileSync(path.join(populatedWebDir, "favicon-32.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const faux = fauxProvider({ provider: "openai", models: [{ id: "<script>alert(1)</script>" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const hub = await openTestHub({
      config: {
        authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        enableLocalEnv: false,
        model: {
          baseUrl: "http://127.0.0.1:9/v1",
          apiMode: "openai-completions",
          defaultModel: "<script>alert(1)</script>",
          thinkingLevel: "off",
        },
      },
      models,
    });

    const missingServer = await startKuloHubServer(hub, { port: 0, webDistDir: emptyWebDir });
    try {
      const res = await fetch(`${missingServer.url}/`);
      expect(res.status).toBe(503);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const text = await res.text();
      expect(text).not.toContain("<script>");
    } finally {
      await missingServer.close();
    }

    const server = await startKuloHubServer(hub, { port: 0, webDistDir: populatedWebDir });
    try {
      const rootRes = await fetch(`${server.url}/`);
      expect(rootRes.status).toBe(200);
      expect(rootRes.headers.get("referrer-policy")).toBe("no-referrer");
      expect(rootRes.headers.get("x-content-type-options")).toBe("nosniff");

      const favRes = await fetch(`${server.url}/favicon.ico`);
      expect(favRes.status).toBe(200);
      expect(favRes.headers.get("content-type")).toBe("image/png");

      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(withHubTestAuth(server.clientWsUrl), { headers: { Origin: "https://evil.example" } });
          ws.once("open", () => { ws.close(); resolve(); });
          ws.once("unexpected-response", (_req, res) => {
            ws.terminate();
            reject(new Error(`HTTP ${res.statusCode}`));
          });
          ws.once("error", reject);
        }),
      ).rejects.toThrow("HTTP 401");

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(withHubTestAuth(server.clientWsUrl), { headers: { Origin: server.url } });
        ws.once("open", () => { ws.close(); resolve(); });
        ws.once("error", reject);
      });
    } finally {
      await server.close();
      await hub.close();
    }
  });
});
