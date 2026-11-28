import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { VoiceCallEvent, VoiceCallSession } from "@kulo/protocol";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import {
  KuloVoiceCalls,
  type KuloVoiceCallsOptions,
  type VoiceCallSummaryInput,
} from "../packages/hub/src/voice-calls.js";
import { openVoiceLive } from "../packages/hub/src/voice-live-adapters.js";
import {
  VoiceCallSummaryEntry,
  buildVoiceCallSummaryData,
  persistVoiceCallSummary,
  persistVoiceTranscript,
  resolveBoundVoiceConversation,
} from "../packages/hub/src/voice-call-summary.js";
import { VoiceTranscriptEntry } from "../packages/hub/src/voice-transcripts.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => (path.basename(String(file)) === ".env" ? false : exists(file)));
  for (const name of [
    "KULO_API_KEY",
    "OPENAI_API_KEY",
    "KULO_AUTH_TOKEN",
    "KULO_ENV_TOKENS",
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

class BrowserSocketStub extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: VoiceCallEvent[] = [];
  send(value: string) {
    this.sent.push(JSON.parse(value) as VoiceCallEvent);
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
  ws() {
    return this as unknown as WebSocket;
  }
}

async function startUpstreamWsServer(
  onConnection: (ws: WebSocket, reqUrl: string) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", (ws, req) => onConnection(ws, req.url ?? ""));
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address() as AddressInfo;
  const close = async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };
  cleanups.push(close);
  return { baseUrl: `http://127.0.0.1:${address.port}`, close };
}

function makeTestModels(reply = "好的，已处理。") {
  const provider = fauxProvider({ provider: "voice-p14a", models: [{ id: "voice-test" }] });
  provider.setResponses(Array.from({ length: 16 }, () => () => fauxAssistantMessage([fauxText(reply)])));
  const models = createModels();
  models.setProvider(provider.provider);
  return models;
}

describe("Stage 1 P1-4A: Voice hangup drain order, immutable session binding, redaction & collapsible summary card", () => {
  it("OpenAI production manager + adapter over in-process WS sends session.close, receives 1.5s delayed tail utterance without duplicate, and flushes pending delegation", async () => {
    const receivedByUpstream: Record<string, unknown>[] = [];
    let upstreamSocket: WebSocket | undefined;
    let upstreamCloseCode: number | undefined;
    let closeDelayedTimer: ReturnType<typeof setTimeout> | undefined;

    const server = await startUpstreamWsServer((ws) => {
      upstreamSocket = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        receivedByUpstream.push(msg);
        if (msg.type === "session.start") {
          ws.send(JSON.stringify({ type: "session.started", session: { id: "live-openai-1" } }));
        } else if (msg.type === "session.close") {
          // Simulate upstream taking 1.5s to flush the trailing ASR fragment before session.closed.
          closeDelayedTimer = setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({
              type: "session.input_transcript.delta",
              delta: "最新库存报告",
              start_ms: 600,
              end_ms: 1200,
            }));
            ws.send(JSON.stringify({ type: "session.closed" }));
          }, 1500);
        }
      });
      ws.on("close", (code) => {
        upstreamCloseCode = code;
        if (closeDelayedTimer) clearTimeout(closeDelayedTimer);
      });
    });

    const eventsOrder: string[] = [];
    const persistedTranscripts: Array<{ topicId: string; event: Extract<VoiceCallEvent, { type: "transcript" }>; callId: string; conversationId?: number }> = [];
    const delegations: Array<{ id: string; text: string; conversationId?: number }> = [];
    const summaries: VoiceCallSummaryInput[] = [];
    let clock = 10_000;

    const manager = new KuloVoiceCalls({
      voice: {
        liveConfig: async () => ({
          provider: "openai",
          baseUrl: server.baseUrl,
          modelId: "gpt-live-1.1",
          voice: "marin",
          apiKey: "synthetic-openai-live-key",
        }),
      },
      context: async () => ({
        history: [],
        instructions: "Test OpenAI live drain",
        conversationId: 42,
      }),
      transcript: async (topicId, event, callId, conversationId) => {
        eventsOrder.push(`transcript:${event.role}:${event.text}`);
        persistedTranscripts.push({ topicId, event, callId, conversationId });
        return true;
      },
      delegate: async ({ delegationId, text, conversationId }) => {
        eventsOrder.push(`delegate:${delegationId}:${text}`);
        delegations.push({ id: delegationId, text, conversationId });
        return { ticketId: "ticket-voice-1" };
      },
      summary: async (input) => {
        eventsOrder.push(`summary:${input.callId}`);
        summaries.push(input);
      },
      openLive: (input, options) => openVoiceLive(input, options),
      now: () => clock,
    });
    cleanups.push(() => manager.close());

    const session = await manager.create({
      topicId: "root",
      principalId: "owner",
      clientId: "web-1",
      commandId: "cmd-openai-drain",
    });
    const browser = new BrowserSocketStub();
    await manager.attach(session.id, "owner", browser.ws());
    await vi.waitFor(() => expect(upstreamSocket).toBeDefined());

    // User speaks first half + upstream queues a client delegation right before hangup.
    upstreamSocket!.send(JSON.stringify({
      type: "session.input_transcript.delta",
      delta: "请查一下",
      start_ms: 100,
      end_ms: 500,
    }));
    upstreamSocket!.send(JSON.stringify({
      type: "session.delegation.created",
      offset_ms: 1200,
      delegation: { id: "del-tail-1", target: "client", type: "delegation" },
    }));
    // Wait briefly so the initial delta arrives before hangup (still < 150ms delegation timer).
    await new Promise((resolve) => setTimeout(resolve, 30));

    clock = 10_000 + 192_000;
    const ending = manager.end(session.id, "owner");

    // During drain, topic must still be reported as having a pending call.
    expect(manager.hasActiveOrPendingCallForTopic("root")).toBe(true);
    await vi.waitFor(() => expect(receivedByUpstream.some((m) => m.type === "session.close")).toBe(true));

    await ending;

    expect(manager.hasActiveOrPendingCallForTopic("root")).toBe(false);
    await vi.waitFor(() => expect(upstreamCloseCode).toBe(1000));
    expect(persistedTranscripts).toHaveLength(1);
    expect(persistedTranscripts[0]!.conversationId).toBe(42);
    expect(persistedTranscripts[0]!.event).toMatchObject({
      type: "transcript",
      role: "user",
      text: "请查一下最新库存报告",
      final: true,
    });
    expect(persistedTranscripts[0]!.event.incomplete).toBeUndefined();

    // Pending delegation must be flushed with the full sentence AFTER transcript persistence.
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toEqual({
      id: "del-tail-1",
      text: "请查一下最新库存报告",
      conversationId: 42,
    });
    expect(eventsOrder[0]).toMatch(/^transcript:user:/);
    expect(eventsOrder[1]).toBe("delegate:del-tail-1:请查一下最新库存报告");
    expect(eventsOrder.at(-1)).toBe(`summary:${session.id}`);

    expect(summaries).toEqual([
      expect.objectContaining({
        topicId: "root",
        conversationId: 42,
        callId: session.id,
        durationMs: 192_000,
        turnCount: 1,
        delegatedTicketIds: ["ticket-voice-1"],
      }),
    ]);
  });

  it("Gemini production manager + adapter over in-process WS performs clean WS 1000 close and finalizes trailing transcript once without duplicates", async () => {
    let upstreamSocket: WebSocket | undefined;
    let upstreamCloseCode: number | undefined;
    const server = await startUpstreamWsServer((ws) => {
      upstreamSocket = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.setup) {
          ws.send(JSON.stringify({ setupComplete: {} }));
        }
      });
      ws.on("close", (code) => {
        upstreamCloseCode = code;
      });
    });

    const persisted: Array<Extract<VoiceCallEvent, { type: "transcript" }>> = [];
    const summaries: VoiceCallSummaryInput[] = [];
    const manager = new KuloVoiceCalls({
      voice: {
        liveConfig: async () => ({
          provider: "gemini",
          baseUrl: server.baseUrl,
          modelId: "gemini-3.8-live",
          voice: "Kore",
          apiKey: "synthetic-gemini-live-key",
        }),
      },
      context: async () => ({
        history: [],
        instructions: "Test Gemini live drain",
        conversationId: 77,
      }),
      transcript: async (_topicId, event) => {
        persisted.push(event);
        return true;
      },
      delegate: async () => {},
      summary: async (input) => {
        summaries.push(input);
      },
      openLive: (input, options) => openVoiceLive(input, options),
    });
    cleanups.push(() => manager.close());

    const session = await manager.create({
      topicId: "topic-gemini",
      principalId: "owner",
      clientId: "web-1",
      commandId: "cmd-gemini-drain",
    });
    await manager.attach(session.id, "owner", new BrowserSocketStub().ws());
    await vi.waitFor(() => expect(upstreamSocket).toBeDefined());

    upstreamSocket!.send(JSON.stringify({
      serverContent: { inputTranscription: { text: "帮我整理" } },
    }));
    upstreamSocket!.send(JSON.stringify({
      serverContent: { inputTranscription: { text: "今天的会议纪要" } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    await manager.end(session.id, "owner");

    // Must close gracefully with code 1000 (not 1006 terminate) and persist exactly one finalized utterance.
    await vi.waitFor(() => expect(upstreamCloseCode).toBe(1000));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: "user",
      text: "帮我整理今天的会议纪要",
      final: true,
    });
    expect(persisted[0]!.incomplete).toBeUndefined();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      callId: session.id,
      conversationId: 77,
      turnCount: 1,
    });
  });

  it("aborts immediately during handshake cancellation (!ready) without waiting for drain timeout", async () => {
    let sawConnection = false;
    let upstreamCloseCode: number | undefined;
    const server = await startUpstreamWsServer((ws) => {
      sawConnection = true;
      // Intentionally never send session.started so connection stays in handshake phase.
      ws.on("close", (code) => {
        upstreamCloseCode = code;
      });
    });

    const summaries: VoiceCallSummaryInput[] = [];
    const manager = new KuloVoiceCalls({
      voice: {
        liveConfig: async () => ({
          provider: "openai",
          baseUrl: server.baseUrl,
          modelId: "gpt-live-1.1",
          voice: "marin",
          apiKey: "synthetic-openai-key",
        }),
      },
      context: async () => ({ history: [], instructions: "Handshake cancel", conversationId: 9 }),
      transcript: async () => true,
      delegate: async () => {},
      summary: async (input) => { summaries.push(input); },
      openLive: (input, options) => openVoiceLive(input, options),
      drainTimeoutMs: 3500,
    });
    cleanups.push(() => manager.close());

    const session = await manager.create({
      topicId: "root",
      principalId: "owner",
      clientId: "web-1",
      commandId: "cmd-handshake-cancel",
    });
    const browser = new BrowserSocketStub();
    const attaching = manager.attach(session.id, "owner", browser.ws());
    await vi.waitFor(() => expect(sawConnection).toBe(true));

    const startedAt = Date.now();
    await manager.end(session.id, "owner");
    await attaching;
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);
    await vi.waitFor(() => expect(upstreamCloseCode).toBe(1006));
    expect(summaries).toHaveLength(0);
    expect(manager.hasActiveOrPendingCallForTopic("root")).toBe(false);
  });

  it("falls back to controller.abort() after drain timeout, persists unfinalized interim once with incomplete: true, and never auto-delegates it", async () => {
    let upstreamSocket: WebSocket | undefined;
    let upstreamCloseCode: number | undefined;
    let sawSessionClose = false;
    const server = await startUpstreamWsServer((ws) => {
      upstreamSocket = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.type === "session.start") {
          ws.send(JSON.stringify({ type: "session.started", session: { id: "live-hang" } }));
        } else if (msg.type === "session.close") {
          sawSessionClose = true;
          // Hang forever: never reply session.closed and never close WS.
        }
      });
      ws.on("close", (code) => {
        upstreamCloseCode = code;
      });
    });

    const persisted: Array<Extract<VoiceCallEvent, { type: "transcript" }>> = [];
    const delegated = vi.fn(async () => {});
    const manager = new KuloVoiceCalls({
      voice: {
        liveConfig: async () => ({
          provider: "openai",
          baseUrl: server.baseUrl,
          modelId: "gpt-live-1.1",
          voice: "marin",
          apiKey: "synthetic-openai-key",
        }),
      },
      context: async () => ({ history: [], instructions: "Timeout fallback", conversationId: 12 }),
      transcript: async (_topicId, event) => {
        persisted.push(event);
        return true;
      },
      delegate: delegated,
      openLive: (input, options) => openVoiceLive(input, { ...options, closeTimeoutMs: 5000 }),
      drainTimeoutMs: 220,
    });
    cleanups.push(() => manager.close());

    const session = await manager.create({
      topicId: "root",
      principalId: "owner",
      clientId: "web-1",
      commandId: "cmd-timeout-incomplete",
    });
    await manager.attach(session.id, "owner", new BrowserSocketStub().ws());
    await vi.waitFor(() => expect(upstreamSocket).toBeDefined());

    upstreamSocket!.send(JSON.stringify({
      type: "session.input_transcript.delta",
      delta: "帮我删除那个",
      start_ms: 100,
      end_ms: 400,
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    await manager.end(session.id, "owner");

    expect(sawSessionClose).toBe(true);
    await vi.waitFor(() => expect(upstreamCloseCode).toBe(1006));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: "user",
      text: "帮我删除那个",
      final: true,
      incomplete: true,
    });
    expect(persisted[0]!.id).toBeTruthy();
    expect(delegated).not.toHaveBeenCalled();

    // Also verify KuloVoiceCalls fallback directly when a mock connection ignores abort() and never resolves closed.
    let capturedSignal: AbortSignal | undefined;
    let onMockEvent: ((event: VoiceCallEvent) => void) | undefined;
    const fallbackTranscripts: Array<Extract<VoiceCallEvent, { type: "transcript" }>> = [];
    const fallbackDelegate = vi.fn(async () => {});
    const mockManager = new KuloVoiceCalls({
      voice: {
        liveConfig: async () => ({ provider: "openai", modelId: "gpt-live-1.1", voice: "marin", apiKey: "k" }),
      },
      context: async () => ({ history: [], instructions: "Mock hung connection", conversationId: 13 }),
      transcript: async (_t, event) => { fallbackTranscripts.push(event); return true; },
      delegate: fallbackDelegate,
      drainTimeoutMs: 120,
      openLive: async (input) => {
        capturedSignal = input.signal;
        onMockEvent = input.onEvent;
        return {
          inputSampleRate: 24000,
          outputSampleRate: 24000,
          closed: new Promise<void>(() => {}),
          sendAudio: vi.fn(),
          setMuted: vi.fn(),
          sendTaskResult: vi.fn(),
          sendContext: vi.fn(),
          sendNotification: vi.fn(),
          close: vi.fn(),
        };
      },
    });
    cleanups.push(() => mockManager.close());
    const s2 = await mockManager.create({ topicId: "root", principalId: "owner", clientId: "w", commandId: "c2" });
    await mockManager.attach(s2.id, "owner", new BrowserSocketStub().ws());
    onMockEvent!({ type: "transcript", role: "user", id: "item-99", text: "半句话还没说完", final: false });
    const end2 = mockManager.end(s2.id, "owner");
    expect(capturedSignal?.aborted).toBe(false);
    await end2;
    expect(capturedSignal?.aborted).toBe(true);
    expect(fallbackTranscripts).toEqual([
      { type: "transcript", role: "user", id: "item-99", text: "半句话还没说完", final: true, incomplete: true },
    ]);
    // Late callback after call.sealed must be hard-dropped.
    onMockEvent!({ type: "transcript", role: "user", id: "item-100", text: "封口后迟到文本", final: true });
    expect(fallbackTranscripts).toHaveLength(1);
    expect(fallbackDelegate).not.toHaveBeenCalled();
  });

  it("Hub graceful shutdown rejects new work immediately, drains trailing voice transcript and summary card to SQLite before #closed", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-voice-shutdown-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    let upstreamSocket: WebSocket | undefined;
    let delayedTimer: ReturnType<typeof setTimeout> | undefined;
    const server = await startUpstreamWsServer((ws) => {
      upstreamSocket = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.type === "session.start") {
          ws.send(JSON.stringify({ type: "session.started", session: { id: "live-hub-close" } }));
        } else if (msg.type === "session.close") {
          delayedTimer = setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({
              type: "session.input_transcript.delta",
              delta: "明天上午九点开会",
              start_ms: 400,
              end_ms: 900,
            }));
            ws.send(JSON.stringify({ type: "session.closed" }));
          }, 300);
        }
      });
      ws.on("close", () => {
        if (delayedTimer) clearTimeout(delayedTimer);
      });
    });

    const hub = await openTestHub({
      models: makeTestModels(),
      voiceOpenLive: (input, options) => openVoiceLive({ ...input, baseUrl: server.baseUrl }, options),
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        authToken: "voice-shutdown-token-0123456789",
        envTokens: {},
        enableLocalEnv: false,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "voice-p14a", defaultModel: "voice-test", apiKey: "", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub.close().catch(() => {}));

    await hub.voice.configure({
      expectedRevision: (await hub.voice.snapshot()).revision,
      call: { enabled: true, provider: "openai", modelId: "gpt-live-1.1", voice: "marin", apiKey: "synthetic-live-key" },
    });

    const session = await hub.voiceCalls.create({
      topicId: "root",
      principalId: "local",
      clientId: "web-shutdown",
      commandId: "cmd-hub-shutdown",
    });
    await hub.voiceCalls.attach(session.id, "local", new BrowserSocketStub().ws());
    await vi.waitFor(() => expect(upstreamSocket).toBeDefined());

    upstreamSocket!.send(JSON.stringify({
      type: "session.input_transcript.delta",
      delta: "请记一下",
      start_ms: 0,
      end_ms: 350,
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Begin Hub graceful shutdown while call is active.
    const closing = hub.close();

    // New work must be rejected immediately during the drain window.
    await expect(hub.sendUserMessage("退出期新消息")).rejects.toMatchObject({ status: 503 });
    await expect(
      hub.voiceCalls.create({ topicId: "root", principalId: "local", clientId: "w2", commandId: "cmd-rejected" }),
    ).rejects.toMatchObject({ status: 503 });

    await closing;

    // Reopen Hub on the same SQLite database to verify durability of trailing utterance + summary card!
    const reopened = await openTestHub({
      models: makeTestModels(),
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        authToken: "voice-shutdown-token-0123456789",
        envTokens: {},
        enableLocalEnv: false,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "voice-p14a", defaultModel: "voice-test", apiKey: "", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => reopened.close());

    const contextView = await reopened.rootConversation.context(BACKGROUND_CONTEXT);
    const transcripts = contextView.entries.filter(VoiceTranscriptEntry.is);
    const summaries = contextView.entries.filter(VoiceCallSummaryEntry.is);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.data).toMatchObject({
      callId: session.id,
      role: "user",
      text: "请记一下明天上午九点开会",
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.data).toMatchObject({
      callId: session.id,
      turnCount: 1,
    });
    // VoiceCallSummaryEntry must never inject messages into model ContextView.messages.
    expect(JSON.stringify(contextView.messages)).not.toContain("语音通话");
    expect(JSON.stringify(contextView.messages)).not.toContain("kulo.voice.summary");
  });

  it("blocks main archive until call.sealed, prevents cross-conversation contamination across rotation, and blocks writes to deleted topics", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-voice-archive-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    let releaseUpstreamClose!: () => void;
    let onUpstreamEvent!: (event: VoiceCallEvent) => void;
    const hub = await openTestHub({
      models: makeTestModels(),
      voiceOpenLive: async (input) => {
        onUpstreamEvent = input.onEvent;
        return {
          inputSampleRate: 24000,
          outputSampleRate: 24000,
          closed: new Promise<void>((resolve) => { releaseUpstreamClose = resolve; }),
          sendAudio: vi.fn(),
          setMuted: vi.fn(),
          sendTaskResult: vi.fn(),
          sendContext: vi.fn(),
          sendNotification: vi.fn(),
          close: vi.fn(),
        };
      },
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        authToken: "voice-archive-token-0123456789",
        envTokens: {},
        enableLocalEnv: false,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "voice-p14a", defaultModel: "voice-test", apiKey: "", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub.close());

    await hub.voice.configure({
      expectedRevision: (await hub.voice.snapshot()).revision,
      call: { enabled: true, provider: "openai", modelId: "gpt-live-1.1", voice: "marin", apiKey: "synthetic-live-key" },
    });

    const conv1Id = Number(hub.rootConversation.id);
    const session = await hub.voiceCalls.create({
      topicId: "root",
      principalId: "local",
      clientId: "web-archive",
      commandId: "cmd-archive-1",
    });
    await hub.voiceCalls.attach(session.id, "local", new BrowserSocketStub().ws());
    onUpstreamEvent({ type: "transcript", role: "user", id: "u-1", text: "先聊一下归档前的内容", final: true });

    // Start hangup drain (still closing, not yet sealed).
    const ending = hub.voiceCalls.end(session.id, "local");
    expect(hub.voiceCalls.hasActiveOrPendingCallForTopic("root")).toBe(true);
    await expect(hub.archiveMainConversation({ expectedConversationId: conv1Id })).rejects.toMatchObject({
      status: 409,
      code: "voice_call_active",
    });

    // Release upstream close so call seals and writes summary card into conv1.
    releaseUpstreamClose();
    await ending;
    expect(hub.voiceCalls.hasActiveOrPendingCallForTopic("root")).toBe(false);

    // Archive now succeeds cleanly and rotates "root" to conv2.
    const rotated = await hub.archiveMainConversation({ expectedConversationId: conv1Id });
    expect(rotated.archived).toBe(true);
    if (!rotated.archived) throw new Error("Expected archive to succeed");
    const conv2Id = rotated.rootConversationId;
    expect(conv2Id).not.toBe(conv1Id);

    // Writing with the frozen conv1Id AFTER rotation MUST stay bound to conv1Id and NEVER cross-contaminate conv2Id!
    const bound = await resolveBoundVoiceConversation(hub.harness, conv1Id, true, BACKGROUND_CONTEXT);
    expect(bound?.conversationId).toBe(conv1Id);
    expect(bound?.topicId).toBe(rotated.archivedTopic.id);
    await persistVoiceTranscript({
      target: bound!,
      event: { type: "transcript", role: "assistant", id: "late-after-rotate", text: "归档后仍绑定原会话", final: true },
      callId: session.id,
      processUserText: async (text) => text,
      redact: (text) => text,
      refreshConversation: () => {},
      recordTopicActivity: () => {},
    });

    const newRootView = await hub.getTopicView("root");
    expect(newRootView.conversationId).toBe(conv2Id);
    expect(newRootView.messages).toHaveLength(0);
    const newRootEntries = (await (await hub.harness.conversation(conv2Id as ConversationId, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)).entries;
    expect(newRootEntries.some((e) => VoiceTranscriptEntry.is(e) || VoiceCallSummaryEntry.is(e))).toBe(false);

    // Archived topic retains both transcripts & summary card and supports transcript read by callId.
    const archivedTurns = await hub.getVoiceCallTranscript(rotated.archivedTopic.id, session.id);
    expect(archivedTurns.map((t) => t.text)).toEqual(["先聊一下归档前的内容", "归档后仍绑定原会话"]);

    // Deleting a topic blocks any bound voice resolution/write.
    const tempTopic = await hub.createTopic("待删除通话会话");
    const tempConvId = tempTopic.conversationId;
    await hub.deleteTopic(tempTopic.id);
    expect(await resolveBoundVoiceConversation(hub.harness, tempConvId, true, BACKGROUND_CONTEXT)).toBeUndefined();
  });

  it("redacts sentinel and vault secrets across VoiceTranscriptEntry, VoiceCallSummaryEntry, KuloStateDoc without documentLeak, and protects transcript HTTP route", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-voice-redaction-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const adminToken = "voice-redact-admin-token-0123456789";
    const sentinelKey = "sk-test-sentinel-1234567890abcdef123456";
    const vaultSecret = "kulo-vault-secret-9876543210zyxwvut";

    let onUpstreamEvent!: (event: VoiceCallEvent) => void;
    let resolveClosed!: () => void;
    const hub = await openTestHub({
      models: makeTestModels(),
      voiceOpenLive: async (input) => {
        onUpstreamEvent = input.onEvent;
        return {
          inputSampleRate: 24000,
          outputSampleRate: 24000,
          closed: new Promise<void>((resolve) => { resolveClosed = resolve; }),
          sendAudio: vi.fn(),
          setMuted: vi.fn(),
          sendTaskResult: vi.fn(),
          sendContext: vi.fn(),
          sendNotification: vi.fn(),
          close: vi.fn(() => resolveClosed()),
        };
      },
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        authToken: adminToken,
        envTokens: {},
        enableLocalEnv: false,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "voice-p14a", defaultModel: "voice-test", apiKey: "", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub.close());
    const server = await startKuloHubServer(hub, { port: 0, host: "127.0.0.1" });
    cleanups.push(() => server.close());

    // Register a vault secret so connectionManager.redact knows about it.
    await hub.connectionManager.save({
      name: "Test Vault Service",
      kind: "api-key",
      url: "https://api.example.test",
      secrets: { apiKey: vaultSecret },
    });

    await hub.voice.configure({
      expectedRevision: (await hub.voice.snapshot()).revision,
      call: { enabled: true, provider: "openai", modelId: "gpt-live-1.1", voice: "marin", apiKey: "synthetic-live-key" },
    });

    const session = await hub.voiceCalls.create({
      topicId: "root",
      principalId: "local",
      clientId: "web-redact",
      commandId: "cmd-redact-1",
    });
    await hub.voiceCalls.attach(session.id, "local", new BrowserSocketStub().ws());

    onUpstreamEvent({
      type: "transcript",
      role: "assistant",
      id: "a-secret-1",
      text: `测试密钥 ${sentinelKey} 与 ${vaultSecret} 不应落盘明文`,
      final: true,
    });
    await hub.voiceCalls.end(session.id, "local");

    // Also test direct sentinel injection into summary fields (callId & delegatedTicketIds).
    const sanitizedSummary = buildVoiceCallSummaryData(
      {
        callId: `call-${sentinelKey}-${vaultSecret}`,
        durationMs: 65_000,
        turnCount: 2,
        delegatedTicketIds: [`ticket-${sentinelKey}`, `ticket-${vaultSecret}`],
        startedAt: 1000,
        endedAt: 66_000,
      },
      (text) => hub.connectionManager.redact(text),
    );
    expect(JSON.stringify(sanitizedSummary)).not.toContain(sentinelKey);
    expect(JSON.stringify(sanitizedSummary)).not.toContain(vaultSecret);

    // Writing a summary containing sentinel/vault strings via persistVoiceCallSummary must never throw documentLeak.
    const bound = await resolveBoundVoiceConversation(hub.harness, Number(hub.rootConversation.id), true, BACKGROUND_CONTEXT);
    await expect(
      persistVoiceCallSummary({
        harness: hub.harness,
        target: bound!,
        input: {
          topicId: "root",
          conversationId: Number(hub.rootConversation.id),
          callId: `call-sentinel-${sentinelKey}`,
          startedAt: 1000,
          endedAt: 5000,
          durationMs: 4000,
          turnCount: 1,
          delegatedTicketIds: [`t-${vaultSecret}`],
          hadDelegations: false,
        },
        redact: (text) => hub.connectionManager.redact(text),
        refreshConversation: () => {},
      }),
    ).resolves.toBeUndefined();

    // Verify stored entries, KuloStateDoc preview, projected ChatDisplayItem, and ContextView.messages.
    const ctxView = await hub.rootConversation.context(BACKGROUND_CONTEXT);
    expect(JSON.stringify(ctxView.entries)).not.toContain(sentinelKey);
    expect(JSON.stringify(ctxView.entries)).not.toContain(vaultSecret);
    expect(ctxView.entries.some((e) => VoiceCallSummaryEntry.is(e) && e.data.callId === session.id)).toBe(true);
    expect(JSON.stringify(ctxView.messages)).not.toContain("kulo.voice.summary");

    const stateSnap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(JSON.stringify(stateSnap)).not.toContain(sentinelKey);
    expect(JSON.stringify(stateSnap)).not.toContain(vaultSecret);

    const view = await hub.getTopicView("root");
    const summaryItem = view.messages.find((m) => m.voiceSummary?.callId === session.id);
    expect(summaryItem).toBeDefined();
    expect(summaryItem?.role).toBe("system_note");
    expect(summaryItem?.voiceSummary?.turnCount).toBe(1);
    expect(summaryItem?.voiceSummary?.turns).toHaveLength(1);
    expect(JSON.stringify(summaryItem)).not.toContain(sentinelKey);
    expect(JSON.stringify(summaryItem)).not.toContain(vaultSecret);

    // HTTP endpoint auth + redacted transcript response.
    const unauth = await fetch(`${server.url}/api/voice/calls/${encodeURIComponent(session.id)}/transcript?topicId=root`);
    expect(unauth.status).toBe(401);

    const authed = await fetch(`${server.url}/api/voice/calls/${encodeURIComponent(session.id)}/transcript?topicId=root`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(authed.status).toBe(200);
    expect(authed.headers.get("cache-control")).toBe("no-store");
    const payload = (await authed.json()) as { callId: string; turns: Array<{ role: string; text: string }> };
    expect(payload.callId).toBe(session.id);
    expect(payload.turns).toHaveLength(1);
    expect(payload.turns[0]!.text).not.toContain(sentinelKey);
    expect(payload.turns[0]!.text).not.toContain(vaultSecret);
  });
});
