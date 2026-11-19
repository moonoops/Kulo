import { afterEach, expect, it, vi } from "vitest";
import type { ClientToHubMessage, HubToClientMessage, TicketCardView } from "@moco/protocol";
import { useMocoHubConnection } from "./moco-api";

const hooks = vi.hoisted(() => ({
  cells: [] as unknown[], cursor: 0, mounted: false,
  effects: [] as (() => void | (() => void))[], cleanups: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.cells[index], (next: unknown) => {
      hooks.cells[index] = typeof next === "function" ? next(hooks.cells[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    return hooks.cells[index] ??= { current: initial };
  },
  useCallback: (callback: unknown) => callback,
  useEffect(effect: () => void | (() => void)) { if (!hooks.mounted) hooks.effects.push(effect); },
}));
vi.mock("./features/chat/reliable-outbox-storage", async (original) => {
  const storage = await original<typeof import("./features/chat/reliable-outbox-storage")>();
  return { ...storage, createIndexedDbOutboxStorage: storage.createMemoryOutboxStorage };
});

function render() {
  hooks.cursor = 0;
  const value = useMocoHubConnection();
  hooks.mounted = true;
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  }
  return value;
}

class TestSocket {
  static readonly OPEN = 1;
  static readonly connections: TestSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  readonly sent: ClientToHubMessage[] = [];
  constructor(readonly url: string) { TestSocket.connections.push(this); }
  open() { this.readyState = TestSocket.OPEN; this.onopen?.(); }
  receive(frame: HubToClientMessage) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const card = (id: string, updatedAt: number): TicketCardView => ({
  id, title: `revision ${updatedAt}`, role: "coder", roleLabel: "Worker", status: "running",
  envId: "local", workspaceDir: "/test", createdAt: 1, updatedAt,
});
const slots = { max: 3, used: 1, queuedCount: 0 };
const snapshot = (tickets: TicketCardView[], ticketRevision?: number): Extract<HubToClientMessage, { type: "hub.snapshot" }> => ({
  type: "hub.snapshot", tickets, ticketRevision, slots, activeTopicId: "root", messages: [], topics: [], envs: [],
  live: { busy: false, activeTools: [], queuedCount: 0 }, deliveryIdentity: { hubId: "test", principalId: "local" },
});
const delta = (previousRevision: number, upsert: TicketCardView[], removed: string[] = []): HubToClientMessage => ({
  type: "hub.ticket_delta", previousRevision, ticketRevision: previousRevision + 1, upsert, removed, slots,
});

afterEach(() => {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup();
  hooks.mounted = false;
  hooks.cells.length = 0;
  TestSocket.connections.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mountConnection() {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: new URL("http://localhost") }));
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("fetch", async (url: string) => ({
    ok: true, json: async () => url === "/api/providers" ? { providers: [] } : url === "/api/media/session" ? { expiresAt: Date.now() + 300_000 } : null,
  }));
  render();
  await vi.advanceTimersByTimeAsync(0);
  return TestSocket.connections[0]!;
}

it("recovers a missing ticket revision once, resumes deltas after sync and reconnect, and accepts legacy full boards", async () => {
  const first = await mountConnection();
  expect(new URL(first.url).searchParams.get("ticketDeltas")).toBe("1");
  first.open();
  const a = card("A", 1), b = card("B", 2), edited = card("A", 3);
  first.receive(snapshot([a], 10));
  first.receive(delta(10, [b]));
  expect(render().tickets).toEqual([b, a]);
  first.receive(delta(11, [edited], ["B"]));
  const beforeGap = render().tickets;
  expect(beforeGap).toEqual([edited]);
  first.receive(delta(11, [b]));
  expect(render().tickets).toBe(beforeGap);

  first.receive(delta(13, [b]));
  first.receive(delta(14, [a]));
  expect(render().tickets).toBe(beforeGap);
  const requests = first.sent.filter(frame => frame.type === "state.sync");
  expect(requests).toHaveLength(1);
  first.receive(snapshot([b], 15));
  first.receive({ type: "hub.ack", action: "state.sync", requestId: requests[0]!.requestId });
  first.receive(delta(15, [edited]));
  expect(render().tickets).toEqual([edited, b]);

  first.close();
  expect(render().ticketsLoaded).toBe(false);
  await vi.advanceTimersByTimeAsync(1500);
  const reconnected = TestSocket.connections[1]!;
  reconnected.open();
  reconnected.receive(snapshot([a], 1));
  reconnected.receive(delta(1, [b], ["A"]));
  expect(render()).toMatchObject({ tickets: [b], ticketsLoaded: true });
  expect(reconnected.sent).toEqual([]);

  reconnected.close();
  await vi.advanceTimersByTimeAsync(1500);
  const legacy = TestSocket.connections[2]!;
  legacy.open();
  legacy.receive(snapshot([a]));
  legacy.receive({ type: "hub.tickets", tickets: [edited, b], slots: { ...slots, used: 2 } });
  expect(render()).toMatchObject({ tickets: [edited, b], slots: { ...slots, used: 2 } });
  expect(legacy.sent).toEqual([]);
});

const topics = ["root", "A", "B"].map((id, conversationId) => ({ id, conversationId, title: id, createdAt: 1, updatedAt: 1 }));
const message = (id: number, text: string) => ({ id, text, role: "user" as const });

it("keeps the latest choice through the handshake, returning to the same topic, and reconnecting", async () => {
  const first = await mountConnection();
  first.open();
  expect(render()).toMatchObject({ connected: true, subscriptionsReady: false });
  render().selectTopic("A");
  render().selectTopic("B");
  expect(first.sent).toEqual([]);
  first.receive({ ...snapshot([]), topics, selectionVersion: 0, supportsPing: true, messages: [message(1, "old root")] });
  expect(render()).toMatchObject({ subscriptionsReady: true, activeTopicId: "B", messages: [] });
  expect(first.sent).toEqual([{ type: "topic.select", topicId: "B", selectionVersion: 2, requestId: "select:2" }]);
  first.receive({ type: "hub.messages", topicId: "B", selectionVersion: 2, messages: [message(2, "first visit")] });
  expect(render().messages).toEqual([message(2, "first visit")]);

  render().selectTopic("A");
  render().selectTopic("B");
  first.receive({ type: "hub.messages", topicId: "B", messages: [message(3, "previous subscription")] });
  first.receive({ type: "hub.live", topicId: "B", live: { busy: true, activeTools: [], queuedCount: 1 } });
  first.receive({ ...snapshot([]), activeTopicId: "A", topics, selectionVersion: 3, supportsPing: true, messages: [message(4, "late A")] });
  first.receive({ type: "hub.messages", topicId: "B", selectionVersion: 2, messages: [message(5, "late B")] });
  expect(render()).toMatchObject({ activeTopicId: "B", messages: [], live: { busy: false } });
  first.receive({ type: "hub.messages", topicId: "B", selectionVersion: 4, messages: [message(6, "latest B")] });
  expect(render().messages).toEqual([message(6, "latest B")]);
  await vi.advanceTimersByTimeAsync(20_000);
  const ping = first.sent.at(-1);
  expect(ping?.type).toBe("client.ping");
  if (ping?.type === "client.ping") first.receive({ type: "hub.ack", action: ping.type, requestId: ping.requestId });
  expect(first.sent.some(frame => frame.type === "state.sync")).toBe(false);

  first.close();
  render().selectTopic("A");
  expect(render().subscriptionsReady).toBe(false);
  await vi.advanceTimersByTimeAsync(1500);
  const next = TestSocket.connections[1]!;
  expect(new URL(next.url).searchParams.get("topic")).toBe("A");
  expect(new URL(next.url).searchParams.get("selectionVersion")).toBe("5");
  next.open();
  next.receive({ ...snapshot([]), topics, activeTopicId: "A", selectionVersion: 5, supportsPing: true, messages: [message(7, "restored A")] });
  first.receive({ ...snapshot([]), activeTopicId: "B", selectionVersion: 4 });
  expect(render()).toMatchObject({ subscriptionsReady: true, activeTopicId: "A", messages: [message(7, "restored A")] });
});

it("reasserts the active topic and uses the existing sync heartbeat with a legacy Hub", async () => {
  const legacy = await mountConnection();
  legacy.open();
  legacy.receive({ ...snapshot([]), topics });
  render().selectTopic("A");
  render().selectTopic("B");
  legacy.receive({ type: "hub.messages", topicId: "B", messages: [message(1, "selected")] });
  legacy.receive({ type: "hub.messages", topicId: "A", messages: [message(2, "superseded")] });
  legacy.receive({ type: "hub.ack", action: "topic.select", topicId: "A", requestId: "select:1" });
  expect(legacy.sent.filter(frame => frame.type === "topic.select").map(frame => frame.topicId)).toEqual(["A", "B", "B"]);
  expect(render()).toMatchObject({ activeTopicId: "B", messages: [message(1, "selected")] });

  await vi.advanceTimersByTimeAsync(20_000);
  const heartbeat = legacy.sent.at(-1);
  expect(heartbeat?.type).toBe("state.sync");
  if (heartbeat?.type === "state.sync") legacy.receive({ type: "hub.ack", action: heartbeat.type, requestId: heartbeat.requestId });
  render().selectTopic("removed");
  legacy.receive({ type: "hub.error", action: "topic.select", topicId: "removed", requestId: "select:3", code: "topic_not_found", message: "会话不存在。" });
  expect(render().activeTopicId).toBe("root");
  expect(legacy.sent.at(-1)).toMatchObject({ type: "topic.select", topicId: "root" });
});
