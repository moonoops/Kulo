import http from "node:http";
import vm from "node:vm";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalAgentBinding } from "@moco/protocol";
import type { ExternalDriver, ExternalDriverContext } from "../packages/env/src/external-agent-drivers.js";
import { connectGrok, detectGrok } from "../packages/env/src/external-agent-grok.js";

type Entry = { id: string; kind: string; role?: string; content?: string; clientNonce?: string; isStreaming?: boolean; message?: { type: string; content: string } };
type Row = { id: string; isRunning?: boolean; runningSessionIds?: string[]; awaitingUserResponse?: unknown };
type Send = { agentId: string; prompt: string; attachments: unknown[]; onNonceAssigned: (value: { nonce: string }) => void };
type Fixture = Awaited<ReturnType<typeof desktop>>;
const fixtures: Fixture[] = [];
const drivers: ExternalDriver[] = [];

afterEach(async () => {
  for (const driver of drivers.splice(0)) driver.close();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function desktop(options: {
  socketUrl?: (port: number) => string;
  redirect?: boolean;
  dropSendReply?: boolean;
  busy?: boolean;
  onSend?: (request: Send, entries: Entry[], row: Row) => void | Promise<void>;
} = {}) {
  const id = "exact-bot-id", otherId = "another-bot-id";
  const selected: Entry[] = [{ id: "old-user", kind: "message", role: "user", content: "private old question" },
    { id: "old-answer", kind: "message", role: "assistant", content: "private history must not leak" }];
  const other: Entry[] = [{ id: "unrelated", kind: "message", role: "assistant", content: "unrelated Bot history" }];
  const row: Row = { id, isRunning: options.busy ?? false, runningSessionIds: [] };
  const rows = new Map([[id, row], [otherId, { id: otherId }]]);
  const reads: string[] = [], sends: Send[] = [], interrupts: unknown[] = [], requests: string[] = [], methods: string[] = [];
  let rosterReads = 0, releases = 0, connections = 0;
  const stores = {
    roster: {
      createAgent: () => { throw new Error("create is not allowed"); },
      interruptAgentRun: (value: unknown) => { interrupts.push(value); },
      snapshots: { get: () => { rosterReads++; return { agentsById: rows }; } },
    },
    transcript: {
      snapshotsFor: (bot: string) => {
        reads.push(bot);
        if (bot !== id) throw new Error("unrelated transcript was accessed");
        return { get: () => ({ loadState: "ready", entries: bot === id ? selected : other }) };
      },
      observeEntries: (bot: string) => {
        if (bot !== id) throw new Error("unrelated transcript was observed");
        return () => { releases++; };
      },
      load: () => { throw new Error("ready transcript should not load older history"); },
      loadOlder: () => { throw new Error("older history must not load"); },
    },
    sendJournal: {
      sendPrompt: async (request: Send) => {
        sends.push(request);
        if (request.agentId !== id) throw new Error("wrong Bot");
        if (options.onSend) await options.onSend(request, selected, row);
        else {
          request.onNonceAssigned({ nonce: "owned-nonce" });
          selected.push({ id: "owned-user", kind: "message", role: "user", content: request.prompt, clientNonce: "owned-nonce" },
            { id: "owned-reply", kind: "send-message", message: { type: "text", content: "Moco owned result" } });
        }
      },
    },
  };
  const page = vm.createContext({ setTimeout, clearTimeout, console });
  page.window = page;
  page.document = { body: { __reactFiber$test: { memoizedProps: { value: stores }, return: null } }, querySelectorAll: () => [] };
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (options.redirect) { response.writeHead(302, { Location: "http://192.0.2.1:9333/json/list" }); response.end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ type: "page", url: "file:///Applications/Grok%20Bot.app/Contents/Resources/app.asar/renderer/index.html", title: "Grok Bot",
      webSocketDebuggerUrl: options.socketUrl?.(port) ?? `ws://127.0.0.1:${port}/devtools/page/grok-main` }]));
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", socket => {
    connections++;
    socket.on("message", async data => {
      const request = JSON.parse(data.toString()) as { id: number; method: string; params?: { expression?: string } };
      methods.push(request.method);
      let result: unknown;
      if (request.method === "Runtime.getIsolateId") result = { id: "fake-isolate" };
      else if (request.method === "Runtime.evaluate") {
        const sentBefore = sends.length;
        try {
          const value = await vm.runInContext(request.params?.expression ?? "", page, { timeout: 1000 });
          if (options.dropSendReply && sends.length > sentBefore) { socket.terminate(); return; }
          result = { result: { type: "object", value } };
        } catch { result = { exceptionDetails: { text: "fake-renderer-error" } }; }
      } else { socket.send(JSON.stringify({ id: request.id, error: { message: "Unsupported fake CDP method" } })); return; }
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const binding: ExternalAgentBinding = { kind: "grok-bot", envId: "local-test", agentRef: id, cdpUrl: `http://127.0.0.1:${port}`, experimental: true };
  const fixture = {
    binding, selected, row, reads, sends, interrupts, requests, methods,
    get rosterReads() { return rosterReads; },
    get releases() { return releases; },
    get connections() { return connections; },
    dispose: async () => {
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>(resolve => websocket.close(() => server.close(() => resolve())));
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function context(binding: ExternalAgentBinding, overrides: Partial<ExternalDriverContext> = {}) {
  let resolveCompletion!: (value: { state: string; error?: string }) => void;
  const completion = new Promise<{ state: string; error?: string }>(resolve => { resolveCompletion = resolve; });
  const ctx: ExternalDriverContext = {
    binding, executable: "", cwd: "/workspace", readOnly: false, prompt: "Please return the Moco owned result", timeoutMs: 6000, servers: [],
    pipe: vi.fn(async () => { throw new Error("Grok Bot must not spawn a client or shell"); }),
    event: vi.fn(), session: vi.fn(), submitted: vi.fn(),
    complete: vi.fn((state, error) => resolveCompletion({ state, error })),
    permission: vi.fn(async () => { throw new Error("Grok Bot must not approve native permissions"); }),
    ...overrides,
  };
  return { ctx, completion };
}

async function connect(ctx: ExternalDriverContext) {
  const driver = await connectGrok(ctx);
  drivers.push(driver);
  return driver;
}

describe("Grok Bot explicit local CDP boundary", () => {
  it.each([
    "https://127.0.0.1:9333", "http://localhost:9333", "http://127.1:9333", "http://2130706433:9333", "http://0x7f000001:9333",
    "http://192.0.2.1:9333", "http://user:canary@127.0.0.1:9333", "http://127.0.0.1:9333/?token=canary", "http://127.0.0.1:9333/json/list",
    "http://127.0.0.1:9333/#debug", "http://[::ffff:127.0.0.1]:9333", "http://[::1]:0",
  ])("rejects nonliteral or credential-bearing CDP origins: %s", async cdpUrl => {
    const result = await detectGrok({ kind: "grok-bot", envId: "test", agentRef: "bot", experimental: true, cdpUrl });
    expect(result.installed).toBe(false);
    expect(result.error).not.toContain("canary");
  });

  it("only handshakes metadata during detection, without reading account, Bot or transcript state", async () => {
    const f = await desktop();
    const result = await detectGrok(f.binding);
    expect(result).toMatchObject({ installed: true, authenticated: null, models: [], capabilities: { resume: false, cancel: false, permissions: false, collaboration: false, terminalEvidence: "observed" } });
    expect(f.requests).toEqual(["/json/list"]);
    expect(f.methods).toEqual(["Runtime.getIsolateId"]);
    expect(f.rosterReads).toBe(0);
    expect(f.reads).toEqual([]);
    expect(f.sends).toEqual([]);
  });

  it("refuses a websocket advertised outside the configured loopback origin", async () => {
    const f = await desktop({ socketUrl: () => "ws://192.0.2.1:9333/devtools/page/wrong" });
    expect((await detectGrok(f.binding)).installed).toBe(false);
    expect(f.connections).toBe(0);
    const differentPort = await desktop({ socketUrl: port => `ws://127.0.0.1:${port + 1}/devtools/page/wrong` });
    expect((await detectGrok(differentPort.binding)).installed).toBe(false);
    expect(differentPort.connections).toBe(0);
  });

  it("does not follow metadata redirects", async () => {
    const f = await desktop({ redirect: true });
    expect((await detectGrok(f.binding)).installed).toBe(false);
    expect(f.connections).toBe(0);
    expect(f.requests).toEqual(["/json/list"]);
  });

  it("requires experimental opt-in and an exact Bot before touching the endpoint", async () => {
    const f = await desktop();
    expect((await detectGrok({ ...f.binding, experimental: false })).installed).toBe(false);
    expect((await detectGrok({ ...f.binding, agentRef: "" })).installed).toBe(false);
    expect(f.requests).toEqual([]);
    const { ctx } = context({ ...f.binding, agentRef: "Exact Bot Name" });
    await expect(connect(ctx)).rejects.toThrow("exact idle Bot");
    expect(f.sends).toEqual([]);
  });

  it("rejects unsupported model, thinking and session selections before connecting", async () => {
    const f = await desktop();
    await expect(connect(context(f.binding, { modelId: "grok" }).ctx)).rejects.toThrow("model selection");
    await expect(connect(context(f.binding, { thinkingLevel: "high" }).ctx)).rejects.toThrow("thinking level");
    await expect(connect(context(f.binding, { sessionId: "some-session" }).ctx)).rejects.toThrow("resume");
    expect(f.requests).toEqual([]);
  });
});

describe("Grok Bot nonce-scoped experimental observation", () => {
  it("reads only replies after the exact Bot's nonce and leaves observed idle results for main Agent acceptance", async () => {
    const f = await desktop();
    const { ctx, completion } = context(f.binding);
    await connect(ctx);
    const outcome = await completion;
    expect(outcome.state).toBe("uncertain");
    expect(outcome.error).toContain("main Agent acceptance");
    expect(ctx.event).toHaveBeenCalledWith("message", "Moco owned result");
    expect(vi.mocked(ctx.event).mock.calls.filter(([type]) => type === "message")).toEqual([["message", "Moco owned result"]]);
    expect(f.reads.every(id => id === f.binding.agentRef)).toBe(true);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ agentId: f.binding.agentRef, attachments: [], prompt: ctx.prompt });
    expect(ctx.submitted).toHaveBeenCalledTimes(1);
    expect(ctx.session).not.toHaveBeenCalled();
    expect(ctx.pipe).not.toHaveBeenCalled();
    expect(ctx.permission).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.releases).toBe(1));
  });

  it("does not send into an already running Bot", async () => {
    const f = await desktop({ busy: true });
    const { ctx } = context(f.binding);
    await expect(connect(ctx)).rejects.toThrow("exact idle Bot");
    expect(f.sends).toEqual([]);
    expect(ctx.submitted).not.toHaveBeenCalled();
  });

  it("never guesses the latest reply or resends when sendPrompt supplies no nonce", async () => {
    const f = await desktop({ onSend(request, entries) {
      entries.push({ id: "someone-user", kind: "message", role: "user", content: request.prompt, clientNonce: "not-owned" },
        { id: "someone-reply", kind: "message", role: "assistant", content: "must not be read" });
    } });
    const { ctx, completion } = context(f.binding);
    await connect(ctx);
    expect((await completion).state).toBe("uncertain");
    expect(f.sends).toHaveLength(1);
    expect(vi.mocked(ctx.event).mock.calls.filter(([type]) => type === "message")).toEqual([]);
  });

  it.each(["wrong-prompt", "duplicate-nonce", "new-user"])("rejects ambiguous correlation before emitting a result: %s", async variant => {
    const f = await desktop({ onSend(request, entries) {
      request.onNonceAssigned({ nonce: "owned-nonce" });
      entries.push({ id: "owned-user", kind: "message", role: "user", content: variant === "wrong-prompt" ? "another user's request" : request.prompt, clientNonce: "owned-nonce" });
      if (variant === "duplicate-nonce") entries.push({ id: "duplicate", kind: "message", role: "user", content: request.prompt, clientNonce: "owned-nonce" });
      if (variant === "new-user") entries.push({ id: "interleaved", kind: "message", role: "user", content: "another turn" });
      entries.push({ id: "unowned-result", kind: "message", role: "assistant", content: "must not leak" });
    } });
    const { ctx, completion } = context(f.binding);
    await connect(ctx);
    expect((await completion).state).toBe("uncertain");
    expect(vi.mocked(ctx.event).mock.calls.filter(([type]) => type === "message")).toEqual([]);
    expect(f.sends).toHaveLength(1);
  });

  it("keeps a lost post-send CDP reply uncertain and never resends", async () => {
    const f = await desktop({ dropSendReply: true });
    const { ctx, completion } = context(f.binding);
    await connect(ctx);
    expect((await completion).state).toBe("uncertain");
    expect(f.sends).toHaveLength(1);
    expect(vi.mocked(ctx.event).mock.calls.filter(([type]) => type === "message")).toEqual([]);
  });

  it("does not interrupt all sessions or infer cancellation ownership from runningSessionIds", async () => {
    const f = await desktop({ onSend(request, entries, row) {
      request.onNonceAssigned({ nonce: "owned-nonce" });
      entries.push({ id: "owned-user", kind: "message", role: "user", content: request.prompt, clientNonce: "owned-nonce" });
      row.isRunning = true;
      row.runningSessionIds = ["unproven-native-session"];
    } });
    const { ctx } = context(f.binding);
    const driver = await connect(ctx);
    await expect(driver.cancel()).rejects.toThrow("Moco-owned native session");
    expect(f.interrupts).toEqual([]);
    expect(ctx.complete).not.toHaveBeenCalledWith("cancelled", expect.anything());
    driver.close();
    await vi.waitFor(() => expect(f.releases).toBe(1));
    expect(f.interrupts).toEqual([]);
  });
});
