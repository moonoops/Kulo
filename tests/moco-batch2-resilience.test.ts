import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  DEVICE_UNACKED_MAX_BYTES,
  STREAM_UNACKED_MAX_BYTES,
  decodeSequencedStreamChunk,
  encodeSequencedStreamChunk,
  type ExternalAgentRun,
} from "@moco/protocol";
import {
  EnvManager,
  ExternalAgentService,
  MocoEnvAgent,
  ProjectDirectoryRegistry,
  StreamResumeBuffer,
} from "@moco/env";
import { MocoStateDoc } from "@moco/hub";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => unknown | Promise<unknown>> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function mkTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("Batch 2 — R4-A StreamResumeBuffer & Sequenced Binary Framing", () => {
  it("encodes/decodes sequenced frames, deduplicates replays, detects gaps, and enforces 8MiB/32MiB limits", () => {
    const encoded = encodeSequencedStreamChunk(42, 7, Buffer.from("hello"));
    expect(decodeSequencedStreamChunk(encoded)).toEqual({
      streamId: 42,
      seq: 7,
      payload: Buffer.from("hello"),
    });

    const buf = new StreamResumeBuffer();
    const f1 = buf.enqueueOutgoing(Buffer.from("aaa"), 0);
    const f2 = buf.enqueueOutgoing(Buffer.from("bbbb"), 3);
    expect(f1.ok && f1.seq === 1).toBe(true);
    expect(f2.ok && f2.seq === 2).toBe(true);
    expect(buf.unackedBytes).toBe(7);

    // Replay from peer rxSeq=1 drops seq 1 and replays seq 2
    const replay = buf.replayFrom(1);
    expect(replay.freedBytes).toBe(3);
    expect(replay.frames.map((f) => [f.seq, f.payload.toString()])).toEqual([[2, "bbbb"]]);

    // Incoming dedup & gap detection
    expect(buf.acceptIncoming(1, Buffer.from("x"))).toMatchObject({ status: "deliver" });
    expect(buf.acceptIncoming(1, Buffer.from("x"))).toEqual({ status: "duplicate" });
    expect(buf.acceptIncoming(3, Buffer.from("z"))).toEqual({ status: "gap" });
    expect(buf.acceptIncoming(2, Buffer.from("y"))).toMatchObject({ status: "deliver" });

    // Stream & device buffer caps
    const bigBuf = new StreamResumeBuffer();
    const tooLargeStream = bigBuf.enqueueOutgoing(Buffer.alloc(STREAM_UNACKED_MAX_BYTES + 1), 0);
    expect(tooLargeStream).toEqual({ ok: false, reason: "stream_limit" });
    const tooLargeDevice = bigBuf.enqueueOutgoing(Buffer.alloc(1024), DEVICE_UNACKED_MAX_BYTES);
    expect(tooLargeDevice).toEqual({ ok: false, reason: "device_limit" });
  });
});

describe("Batch 2 — R4-A Live 20s Transparent Stream Resume & Revocation Priority", () => {
  async function startEnvBridge(options?: { streamResumeGraceMs?: number }) {
    const dir = mkTempDir("moco-b2-bridge-");
    const envId = "remote-laptop";
    const token = "secret-env-token-batch2";
    const envManager = new EnvManager({
      enableLocal: false,
      envTokens: { [envId]: token },
      workerEnvIds: [envId],
      streamResumeGraceMs: options?.streamResumeGraceMs ?? 5_000,
    });
    await envManager.start();
    cleanups.push(() => envManager.close());

    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: "/ws/env" });
    const serverSockets: WebSocket[] = [];
    wss.on("connection", (ws) => {
      serverSockets.push(ws);
      envManager.handleEnvWebSocket(ws);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    cleanups.push(async () => {
      for (const s of serverSockets) {
        if (s.readyState !== WebSocket.CLOSED) s.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const agentRoot = path.join(dir, "agent-root");
    fs.mkdirSync(agentRoot, { recursive: true });
    const agent = new MocoEnvAgent({
      hubUrl: `ws://127.0.0.1:${addr.port}/ws/env`,
      envId,
      name: "Remote Laptop",
      rootDir: agentRoot,
      authToken: token,
      streamResumeGraceMs: options?.streamResumeGraceMs ?? 5_000,
    });
    await agent.start();
    cleanups.push(() => agent.stop());

    return { dir, envId, agentRoot, envManager, agent, serverSockets, wss };
  }

  it("keeps an in-flight remote pi-env shell command alive across a transient WebSocket drop without flipping descriptor.online", async () => {
    const { envId, agentRoot, envManager, agent, serverSockets } = await startEnvBridge({ streamResumeGraceMs: 6_000 });

    const remoteEnv = envManager.createExecutionEnv(envId, agentRoot);
    // Warm up the pi-env connection first
    const warm = await remoteEnv.exec("echo WARM_OK", undefined, context);
    expect(warm.ok && warm.value.exitCode === 0).toBe(true);

    let output = "";
    const runningCmd = remoteEnv.exec(
      "sleep 1.2 && echo SURVIVED_BLIP_12345",
      {
        onOutput: (chunk) => {
          output += chunk;
        },
      },
      context,
    );

    // Wait briefly so the command is actively executing on remote pi-env, then sever the WebSocket abruptly (1006)
    await new Promise((r) => setTimeout(r, 250));
    const activeSocket = serverSockets.at(-1)!;
    activeSocket.terminate();

    // Wait for close event to propagate on Hub
    await vi.waitFor(() => {
      expect(envManager.getConnectionState(envId)).toBe("reconnecting");
    }, { timeout: 2_000, interval: 15 });

    // During grace window: descriptor.online stays true AND daemon stays alive on Env!
    expect(envManager.getEnvDescriptor(envId)?.online).toBe(true);
    expect(agent.hasActiveExecution).toBe(true);

    // Agent reconnects automatically and the in-flight command completes transparently!
    const result = await runningCmd;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitCode).toBe(0);
    }
    expect(output).toContain("SURVIVED_BLIP_12345");
    expect(envManager.getConnectionState(envId)).toBe("online");
  });

  it("kills daemons immediately with zero grace on 4001 revocation and marks offline when grace expires", async () => {
    // 1) Revocation (4001) -> zero grace
    const f1 = await startEnvBridge({ streamResumeGraceMs: 10_000 });
    const env1 = f1.envManager.createExecutionEnv(f1.envId, f1.agentRoot);
    const warm1 = await env1.exec("echo OK", undefined, context);
    expect(warm1.ok).toBe(true);
    expect(f1.agent.hasActiveExecution).toBe(true);

    f1.envManager.removeDevice(f1.envId);
    expect(f1.envManager.getConnectionState(f1.envId)).toBe("offline");
    await vi.waitFor(() => {
      expect(f1.agent.hasActiveExecution).toBe(false);
    }, { timeout: 3_000, interval: 30 });

    // 2) Grace expiry -> transitions to offline after grace window
    const f2 = await startEnvBridge({ streamResumeGraceMs: 350 });
    const env2 = f2.envManager.createExecutionEnv(f2.envId, f2.agentRoot);
    const warm2 = await env2.exec("echo OK", undefined, context);
    expect(warm2.ok).toBe(true);

    // Block further connections so agent cannot reconnect within 350ms
    f2.wss.removeAllListeners("connection");
    f2.wss.on("connection", (ws) => ws.terminate());
    f2.serverSockets.at(-1)!.terminate();

    await vi.waitFor(() => {
      expect(f2.envManager.getConnectionState(f2.envId)).toBe("reconnecting");
    }, { timeout: 2_000, interval: 15 });
    expect(f2.envManager.getEnvDescriptor(f2.envId)?.online).toBe(true);

    await vi.waitFor(() => {
      expect(f2.envManager.getConnectionState(f2.envId)).toBe("offline");
      expect(f2.envManager.getEnvDescriptor(f2.envId)?.online).toBe(false);
    }, { timeout: 2_000, interval: 30 });
  });
});

describe("Batch 2 — R4-A External Agent Offline moco_task_report Outbox & Anti-Race Inspect", () => {
  it("buffers offline moco_task_report with private file snapshot + SHA-256, withholds completed until ACKed, and delivers atomically via Hub scheduler", async () => {
    const root = mkTempDir("moco-b2-outbox-");
    const projectDir = path.join(root, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src.ts"), "export const a = 1;\n");

    const fakeBin = path.join(root, "fake-codex");
    fs.writeFileSync(fakeBin, "#!/bin/sh\necho 'codex 0.1.0'\n", { mode: 0o755 });

    const models = createModels();
    const provider = fauxProvider({ provider: "openai", models: [{ id: "hub-model" }] });
    provider.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("Reviewed")])));
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      config: {
        stateDir: path.join(root, "state"),
        identityDir: path.join(root, "identity"),
        localEnvRoot: path.join(root, "workspace"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "hub-model", thinkingLevel: "off", apiKey: "" },
        roles: {
          "codex-outbox": {
            id: "codex-outbox",
            label: "Codex Outbox",
            whenToUse: "Test offline outbox",
            prompt: "You are a test external agent.",
            enabled: true,
            modelId: "gpt-5-codex",
            thinkingLevel: "high",
            external: { kind: "codex", envId: "local", executable: fakeBin, verifiedAt: 1_700_000_000_000 },
          },
        },
      },
    });
    cleanups.push(() => hub.close());

    const project = await hub.projects.create({
      commandId: "create-outbox-proj",
      name: "Outbox Demo",
      deviceId: "local",
      workspaceDir: projectDir,
    });

    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(root, "native-control", "grants.json"),
      scratchRoot: path.join(root, "workspace", "scratch"),
    });
    registry.authorize({ id: project.directoryId, projectId: project.id, path: projectDir, operationId: "grant-outbox-1" });

    let mcpUrl = "";
    let mcpAuth = "";
    const service = new ExternalAgentService({
      envId: "local",
      rootDir: path.join(root, "workspace"),
      projectRegistry: registry,
      // Simulate Hub being offline when the external agent invokes moco_task_report!
      toolHandler: async () => {
        throw new Error("Hub is offline; task tool request was not sent");
      },
      pipeFactory: async (spec) => {
        let closed = false;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        const emit = (msg: unknown) => {
          if (!closed) spec.onStdout(Buffer.from(`${JSON.stringify(msg)}\n`));
        };
        return {
          write(data: string) {
            if (closed) return;
            for (const line of data.split("\n").filter(Boolean)) {
              const parsed = JSON.parse(line) as { id?: number | string; method?: string; params?: any };
              if (parsed.method === "initialize") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { userAgent: "codex-test" } }));
              } else if (parsed.method === "model/list") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { data: [{ id: "gpt-5-codex", displayName: "GPT-5 Codex", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] } }));
              } else if (parsed.method === "config/read") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { config: {} } }));
              } else if (parsed.method === "thread/start" || parsed.method === "thread/resume") {
                const mcpServer = Object.values(parsed.params?.config?.mcp_servers ?? {})[0] as any;
                if (mcpServer?.url) mcpUrl = mcpServer.url;
                if (mcpServer?.http_headers?.Authorization) mcpAuth = mcpServer.http_headers.Authorization;
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { thread: { id: "thread-outbox-1" } } }));
              } else if (parsed.method === "turn/start") {
                const artifactFile = path.join(spec.cwd, "outbox-deliverable.txt");
                fs.writeFileSync(artifactFile, "OFFLINE_SNAPSHOT_BYTES_VERIFIED\n");
                queueMicrotask(() => {
                  emit({ jsonrpc: "2.0", id: parsed.id, result: { turn: { id: "turn-outbox-1", status: "inProgress" } } });
                  emit({ method: "item/agentMessage/delta", params: { threadId: "thread-outbox-1", delta: "Fallback text that must NOT replace outbox report" } });
                });
                void (async () => {
                  // Call the real local MCP endpoint while toolHandler throws "Hub is offline"
                  const res = await fetch(mcpUrl, {
                    method: "POST",
                    headers: { "content-type": "application/json", authorization: mcpAuth },
                    body: JSON.stringify({
                      jsonrpc: "2.0",
                      id: 99,
                      method: "tools/call",
                      params: {
                        name: "moco_task_report",
                        arguments: {
                          state: "ready",
                          summary: "OFFLINE_OUTBOX_READY_SUMMARY",
                          deliverable: "Verified offline outbox deliverable content.",
                          files: [{ path: "outbox-deliverable.txt", name: "outbox-deliverable.txt" }],
                        },
                      },
                    }),
                  });
                  const body = (await res.json()) as any;
                  const payloadText = body.result?.content?.[0]?.text ?? "";
                  expect(payloadText).toContain("queuedOffline");
                  // Remove the original file right after reporting to prove the private snapshot protects it!
                  fs.rmSync(artifactFile, { force: true });
                  emit({ method: "turn/completed", params: { threadId: "thread-outbox-1", turn: { id: "turn-outbox-1", status: "completed" } } });
                  closed = true;
                  resolveExit(0);
                })();
              } else if (parsed.id !== undefined) {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: {} }));
              }
            }
          },
          close() {
            if (!closed) {
              closed = true;
              resolveExit(0);
            }
          },
          cleanup: async () => true,
          exited,
        };
      },
    });
    cleanups.push(() => service.close());

    const inspectLog: Array<{ state: ExternalAgentRun["state"]; pendingCount: number; acked: number }> = [];
    vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation(async (_envId, req) => {
      const res = await service.request(req);
      if (req.operation === "inspect" && !req.compact && res.type === "run") {
        inspectLog.push({
          state: res.run.state,
          pendingCount: res.run.pendingReports?.length ?? 0,
          acked: req.ackReportIds?.length ?? 0,
        });
      }
      return res;
    });

    const card = await hub.dispatchTicket({
      commandId: "dispatch-outbox-1",
      title: "Offline outbox test",
      goal: "Report while Hub is offline and reconcile on reconnect",
      scope: "src.ts",
      role: "codex-outbox",
      projectId: project.id,
    });

    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(MocoStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 10_000, interval: 40 });

    const snap = await hub.harness.snapshot(MocoStateDoc, context);
    const ticket = snap!.tickets[card.id]!;
    expect(ticket.latestReport?.state).toBe("ready");
    expect(ticket.latestReport?.summary).toBe("OFFLINE_OUTBOX_READY_SUMMARY");
    expect(ticket.latestReport?.deliverable).toContain("Verified offline outbox deliverable content.");
    expect(ticket.latestReport?.attachments?.map((a) => a.name)).toEqual(["outbox-deliverable.txt"]);

    // Verify anti-race iron rule: the inspect returning pendingReports withheld "completed", and ACKed inspect revealed "completed"
    const sawWithheld = inspectLog.some((entry) => entry.pendingCount === 1 && entry.state !== "completed");
    const sawAckedCompleted = inspectLog.some((entry) => entry.acked === 1 && entry.pendingCount === 0 && entry.state === "completed");
    expect(sawWithheld).toBe(true);
    expect(sawAckedCompleted).toBe(true);

    // Verify uploaded bytes match exact snapshot content
    const savedId = ticket.latestReport!.attachments![0]!.id;
    const loaded = hub.uploads.getUpload(savedId);
    expect(loaded).not.toBeNull();
    expect(hub.uploads.readUploadBytes(loaded!).toString("utf8")).toBe("OFFLINE_SNAPSHOT_BYTES_VERIFIED\n");
  });
});
