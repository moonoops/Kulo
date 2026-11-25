import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  CompactionEntry,
  ToolResultEntry,
  UserEntry,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import {
  EARLY_COMPACT_CIRCUIT_MAX_FAILURES,
  HubContextGuard,
  KuloStateDoc,
  KuloUploadStore,
  TOOL_OVERFLOW_MARKER_RE,
  containsToolOverflowMarker,
  createOrchestratorToolOverflowExtension,
  resolveHubConfig,
  startKuloHubServer,
  type OrchestratorToolOverflowEvent,
} from "../packages/hub/src/index.js";
import { LiveSettingsStore } from "../packages/hub/src/hub-kernel-ports.js";
import { SettingsAssistantDoc } from "../packages/hub/src/settings-doc.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

function getAfterToolHook(ext: ReturnType<typeof createOrchestratorToolOverflowExtension>) {
  const toolHook = ext.hooks?.find((h) => h.task === "pi.tool");
  const afterTool = (toolHook?.handlers as { afterTool?: Function } | undefined)?.afterTool;
  if (!afterTool) throw new Error("afterTool hook missing");
  return afterTool as (
    call: ToolHookCall,
    result: ToolExecutionResult,
    api: Record<string, unknown>,
    context: typeof BACKGROUND_CONTEXT,
  ) => Promise<ToolExecutionResult | undefined>;
}

describe("Stage 2: Top-level chat tool overflow, internalOnly isolation, pruning retention, and 200k early guard", () => {
  it("spills allowlisted chat tools, preserves non-text/metadata, independently redacts, guarantees idempotent copy consistency, and degrades on I/O error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-s2-hook-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const uploads = new KuloUploadStore(path.join(dir, "uploads"));
    const events: OrchestratorToolOverflowEvent[] = [];
    const secret = "kulo_raw_stage2_secret_99887766";
    const redact = (text: string) => text.replaceAll(secret, "[已隐藏]");
    let knownCheckFail = false;

    const ext = createOrchestratorToolOverflowExtension({
      uploads,
      redact,
      isKnownSecret: (text) => knownCheckFail || text.includes(secret),
      thresholdChars: 200,
      headChars: 60,
      tailChars: 40,
      onEvent: (event) => events.push(event),
    });
    const afterTool = getAfterToolHook(ext);

    const mockApi = (convId: number, isSettings = false, isWorker = false) => ({
      conversationId: convId as ConversationId,
      snapshot: async (doc: unknown) => {
        if (doc === KuloStateDoc) {
          return isWorker
            ? { conversationToTopic: {}, conversationToTicket: { [String(convId)]: "T-1" }, topics: {} }
            : { conversationToTopic: { [String(convId)]: convId === 1 ? "root" : `topic_${convId}` }, conversationToTicket: {}, topics: {} };
        }
        if (doc === SettingsAssistantDoc) {
          return isSettings ? { conversationId: convId, conversations: {} } : { conversations: {} };
        }
        return undefined;
      },
      agent: async () => ({ deferred: [{ name: "kulo_inspect_asset" }] }),
    });

    const longBody = `HEAD_LINE_001\n${"MIDDLE_CHUNK_DATA_".repeat(30)}\ncontains ${secret} here\n${"TRAILING_LINES_".repeat(15)}\nTAIL_END_999`;

    // 1. Non-allowlisted tool, nested call, Harness-blocked diagnostic, Worker, and SettingsAssistant must be ignored.
    expect(await afterTool({ id: "c0", name: "kulo_status", arguments: {} } as ToolHookCall, { output: [{ type: "text", text: longBody }] }, mockApi(1), BACKGROUND_CONTEXT)).toBeUndefined();
    expect(await afterTool({ id: "c1", name: "read", arguments: {}, parent: { taskId: 9 as never, callId: "p1" } } as ToolHookCall, { output: [{ type: "text", text: longBody }] }, mockApi(1), BACKGROUND_CONTEXT)).toBeUndefined();
    expect(await afterTool({ id: "c2", name: "bash", arguments: {}, } as ToolHookCall, { output: [{ type: "text", text: longBody }], diagnostics: [{ level: "error", code: "blocked", message: "blocked" }] }, mockApi(1), BACKGROUND_CONTEXT)).toBeUndefined();
    expect(await afterTool({ id: "c3", name: "read", arguments: {} } as ToolHookCall, { output: [{ type: "text", text: longBody }] }, mockApi(99, false, true), BACKGROUND_CONTEXT)).toBeUndefined();
    expect(await afterTool({ id: "c4", name: "web_fetch", arguments: {} } as ToolHookCall, { output: [{ type: "text", text: longBody }] }, mockApi(1, true, false), BACKGROUND_CONTEXT)).toBeUndefined();

    // 2. Allowlisted top-level chat call spills, preserves image + details + structuredOutput + isError + existing control.addTools,
    // and independently redacts raw secret BEFORE disk persistence.
    const originalResult: ToolExecutionResult = {
      output: [
        { type: "text", text: longBody },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
      isError: true,
      details: { sources: [{ url: "https://example.test" }] },
      structuredOutput: { ok: false, lines: 500 },
      control: { addTools: ["kulo_history_read"] },
    };
    const spilled = await afterTool(
      { id: "call_spill_1", name: "web_fetch", arguments: { url: "https://example.test" } } as ToolHookCall,
      originalResult,
      mockApi(1),
      BACKGROUND_CONTEXT,
    );
    expect(spilled).toBeDefined();
    expect(spilled!.isError).toBe(true);
    expect(spilled!.details).toEqual(originalResult.details);
    expect(spilled!.structuredOutput).toEqual(originalResult.structuredOutput);
    expect(spilled!.control?.addTools).toEqual(["kulo_history_read", "kulo_inspect_asset"]);
    expect(spilled!.output).toHaveLength(2);
    expect(spilled!.output![1]).toEqual({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });

    const textOut = spilled!.output![0]!.type === "text" ? spilled!.output![0]!.text : "";
    expect(containsToolOverflowMarker(textOut)).toBe(true);
    expect(textOut).not.toContain(secret);
    const assetId = TOOL_OVERFLOW_MARKER_RE.exec(textOut)?.[1];
    expect(assetId).toBeTruthy();

    const loaded = uploads.getUpload(assetId!);
    expect(loaded?.record.internalOnly).toBe(true);
    expect(loaded?.record.internalKind).toBe("tool-overflow");
    expect(loaded?.record.ownerId).toBe("agent:1");
    expect(loaded?.record.referenceScopes).toContain("conversation:1");
    const diskText = uploads.readUploadBytes(loaded!).toString("utf8");
    expect(diskText).not.toContain(secret);
    expect(diskText).toContain("[已隐藏]");
    expect(diskText).toContain("MIDDLE_CHUNK_DATA_");

    // 3. Idempotent replay with same call.id but DIFFERENT input text MUST read persisted bytes so preview/sha256 match disk 100%.
    const replayed = await afterTool(
      { id: "call_spill_1", name: "web_fetch", arguments: { url: "https://example.test" } } as ToolHookCall,
      { output: [{ type: "text", text: "COMPLETELY_DIFFERENT_RETRY_BODY_".repeat(30) }] },
      mockApi(1),
      BACKGROUND_CONTEXT,
    );
    const replayText = replayed!.output![0]!.type === "text" ? replayed!.output![0]!.text : "";
    expect(TOOL_OVERFLOW_MARKER_RE.exec(replayText)?.[1]).toBe(assetId);
    expect(replayText).toContain("HEAD_LINE_001");
    expect(replayText).toContain("TAIL_END_999");
    expect(replayText).not.toContain("COMPLETELY_DIFFERENT_RETRY_BODY");

    // 4. Redaction verification failure writes NO disk file and degrades safely.
    knownCheckFail = true;
    const redactionFail = await afterTool(
      { id: "call_redact_fail", name: "bash", arguments: {} } as ToolHookCall,
      { output: [{ type: "text", text: longBody }] },
      mockApi(1),
      BACKGROUND_CONTEXT,
    );
    knownCheckFail = false;
    const redactionFailText = redactionFail!.output![0]!.type === "text" ? redactionFail!.output![0]!.text : "";
    expect(redactionFailText).toContain("redaction_verification_failed");
    expect(redactionFailText).not.toContain("asset_id=");
    expect(events.some((e) => e.kind === "degraded_redaction" && e.callId === "call_redact_fail")).toBe(true);

    // 5. Disk I/O failure degrades gracefully without throwing or emitting a broken asset_id pointer.
    vi.spyOn(uploads, "saveUpload").mockImplementationOnce(() => {
      throw new Error("ENOSPC: disk full");
    });
    const ioFail = await afterTool(
      { id: "call_io_fail", name: "read", arguments: {} } as ToolHookCall,
      { output: [{ type: "text", text: longBody }] },
      mockApi(1),
      BACKGROUND_CONTEXT,
    );
    const ioFailText = ioFail!.output![0]!.type === "text" ? ioFail!.output![0]!.text : "";
    expect(ioFailText).toContain("KULO_TOOL_OVERFLOW_DEGRADED");
    expect(ioFailText).not.toContain("asset_id=");
    expect(ioFailText).not.toContain(secret);
    expect(events.some((e) => e.kind === "degraded_io" && e.callId === "call_io_fail")).toBe(true);

    // 6. GC cleanup removes aged-out or expired-conversation tool-overflow assets while preserving fresh ones.
    const removedFresh = uploads.cleanupToolOverflows({ maxAgeMs: 60_000, now: Date.now() });
    expect(removedFresh).toBe(0);
    expect(uploads.getUpload(assetId!)).not.toBeNull();

    const removedExpired = uploads.cleanupToolOverflows({
      maxAgeMs: 14 * 24 * 60 * 60 * 1000,
      expiredConversationIds: new Set([1]),
    });
    expect(removedExpired).toBe(1);
    expect(uploads.getUpload(assetId!)).toBeNull();
  });

  it("blocks internalOnly tool-overflow assets from dispatchTicket, direct HTTP, other topics, and Worker publish while allowing owning orchestrator kulo_inspect_asset", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-s2-isolation-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const workspaceDir = path.join(dir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const bigFile = path.join(workspaceDir, "large.txt");
    const middleNeedle = "MIDDLE_NEEDLE_STAGE2_7741";
    const bigContent = `${"HEADER_ROW_LONG_LINE_PAD\n".repeat(420)}${middleNeedle}\n${"FOOTER_ROW_LONG_LINE_PAD\n".repeat(700)}`;
    fs.writeFileSync(bigFile, bigContent, "utf8");

    let spilledAssetId = "";
    const provider = fauxProvider({
      provider: "s2-iso",
      models: [{ id: "m1", contextWindow: 128_000, maxTokens: 4_096 }],
    });
    provider.setResponses([
      // Root turn 1: read large.txt (>24K on 128K window) -> spills via afterTool -> mounts kulo_inspect_asset
      () => fauxAssistantMessage([fauxToolCall("read", { path: "large.txt" })], { stopReason: "toolUse" }),
      (ctx) => {
        const lastTool = [...ctx.messages].reverse().find((m) => m.role === "toolResult");
        const toolText = lastTool && lastTool.role === "toolResult"
          ? lastTool.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n")
          : "";
        spilledAssetId = TOOL_OVERFLOW_MARKER_RE.exec(toolText)?.[1] ?? "";
        const headMatch = /preview_head=(\d+)/.exec(toolText);
        const nextOffset = headMatch ? Number(headMatch[1]) : 2400;
        return fauxAssistantMessage([fauxToolCall("kulo_inspect_asset", { asset_id: spilledAssetId, offset: nextOffset, limit: 8000 })], { stopReason: "toolUse" });
      },
      (ctx) => {
        const lastTool = [...ctx.messages].reverse().find((m) => m.role === "toolResult");
        const inspected = lastTool && lastTool.role === "toolResult"
          ? lastTool.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n")
          : "";
        return fauxAssistantMessage([fauxText(inspected.includes(middleNeedle) ? `FOUND:${middleNeedle}` : "MISSING")]);
      },
      // Topic 2 turn 1: tries to call kulo_inspect_asset on root's spilledAssetId (must be rejected 403!)
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_inspect_asset", limit: 3 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("kulo_inspect_asset", { asset_id: spilledAssetId, offset: 0, limit: 1000 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("done")]),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "s2-iso",
      config: {
        stateDir: dir,
        identityDir: path.join(dir, "identity"),
        localEnvRoot: workspaceDir,
        enableLocalEnv: true,
        authToken: "s2-token",
        memory: { enabled: false },
        model: {
          defaultProvider: "s2-iso",
          defaultModel: "m1",
          contextWindow: 128_000,
          compaction: { enabled: true, reserveTokens: 2_048, keepRecentTokens: 1_024, backgroundTokens: 64_000 },
        },
      },
    });
    cleanups.push(() => hub.close());

    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());
    const authHeaders = { authorization: "Bearer s2-token" };

    // 1. Root orchestrator reads large.txt -> spills -> inspects middle needle via kulo_inspect_asset!
    const sub = await hub.rootConversation.submit({ type: "input", content: "请读取 large.txt 并找出中段关键字" }, BACKGROUND_CONTEXT);
    const done = await sub.wait(BACKGROUND_CONTEXT);
    expect(done.status).toBe("done");
    expect(spilledAssetId).toMatch(/^att_pub_/);

    const rootView = await hub.getTopicView("root", BACKGROUND_CONTEXT);
    expect(rootView.messages.some((m) => m.role === "assistant" && m.text.includes(`FOUND:${middleNeedle}`))).toBe(true);

    // 2. Direct HTTP GET /api/uploads/:id and /meta MUST return 403 for internalOnly assets!
    const httpRaw = await fetch(`${server.url}/api/uploads/${encodeURIComponent(spilledAssetId)}`, { headers: authHeaders });
    expect(httpRaw.status).toBe(403);
    const httpMeta = await fetch(`${server.url}/api/uploads/${encodeURIComponent(spilledAssetId)}/meta`, { headers: authHeaders });
    expect(httpMeta.status).toBe(403);

    // 3. dispatchTicket MUST reject internalOnly overflow assets with 403 internal_overflow_asset_not_dispatchable!
    await expect(
      hub.dispatchTicket(
        {
          commandId: "s2-dispatch-internal",
          title: "试探转发溢出资产",
          goal: "验证拒绝",
          scope: "仅测试",
          role: "coder",
          attachmentIds: [spilledAssetId],
        },
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toMatchObject({ status: 403, code: "internal_overflow_asset_not_dispatchable" });

    // 4. Another topic MUST NOT be able to inspect root's tool-overflow asset!
    const topic2 = await hub.createTopic("隔离验证话题", BACKGROUND_CONTEXT);
    const conv2 = (await hub.harness.conversation(topic2.conversationId as ConversationId, BACKGROUND_CONTEXT))!;
    const sub2 = await conv2.submit({ type: "input", content: "尝试读取其他话题资产" }, BACKGROUND_CONTEXT);
    await sub2.wait(BACKGROUND_CONTEXT);
    const conv2Entries = await conv2.entries({}, 20, undefined, BACKGROUND_CONTEXT);
    const inspectResult2 = conv2Entries.items
      .filter(ToolResultEntry.is)
      .map((e) => e.model?.[0])
      .find((m) => m?.role === "toolResult" && m.toolName === "kulo_inspect_asset");
    expect(inspectResult2?.role === "toolResult" && inspectResult2.isError).toBe(true);
    const inspectErrText = inspectResult2 && inspectResult2.role === "toolResult"
      ? inspectResult2.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n")
      : "";
    expect(inspectErrText).toMatch(/asset_reference_denied|无权|尚未收到/);

    // 5. #pruneCompactedConversationTools retains kulo_inspect_asset when kept window has [KULO_TOOL_OVERFLOW asset_id="..."].
    // Verify kulo_inspect_asset is mounted in root AgentDoc and survives compaction when overflow marker is in kept tail!
    await hub.rootConversation.commit(async (tx) => {
      for (let i = 0; i < 6; i += 1) {
        await tx.appendEntry(UserEntry, hub.rootConversation.id, {
          model: [{ role: "user", content: `早期填充消息 ${i} ${"历史文本".repeat(120)}`, timestamp: 1000 + i }],
        });
      }
      await tx.appendEntry(ToolResultEntry, hub.rootConversation.id, {
        data: { diagnostics: [] },
        model: [{
          role: "toolResult",
          toolName: "read",
          toolCallId: "kept-overflow-call",
          isError: false,
          content: [{ type: "text", text: `preview\n[KULO_TOOL_OVERFLOW asset_id="${spilledAssetId}" tool="read"]` }],
          timestamp: 9999,
        }],
      });
    }, BACKGROUND_CONTEXT);
    const agentBefore = await hub.harness.snapshot(AgentDoc, hub.rootConversation.id, BACKGROUND_CONTEXT);
    expect(agentBefore?.modelTools?.add ?? []).toContain("kulo_inspect_asset");
  });

  it("triggers 200k early async compaction when idle above ceiling and opens circuit-breaker after 2 failures on the same tail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-s2-guard-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const provider = fauxProvider({
      provider: "s2-guard",
      models: [{ id: "m1", contextWindow: 256_000, maxTokens: 4_096 }],
    });
    const models = createModels();
    models.setProvider(provider.provider);

    let nowMs = 1_700_000_000_000;
    const compactCalls: number[] = [];
    const fakeConversation = {
      id: 1 as ConversationId,
      agent: async () => ({ model: { provider: "s2-guard", modelId: "m1" }, compaction: { enabled: true, reserveTokens: 2_048, keepRecentTokens: 1_024, backgroundTokens: 64_000 } }),
      context: async () => ({
        entries: Array.from({ length: 12 }, (_, i) => ({ id: (i + 1) as EntryId, kind: UserEntry.kind })),
        contributions: Array.from({ length: 12 }, (_, i) => [{ role: "user", content: `item ${i} ${"x".repeat(800)}`, timestamp: i + 1 }]),
      }),
      compact: async () => {
        compactCalls.push(nowMs);
        return (100 + compactCalls.length) as never;
      },
    };
    const fakeHarness = {
      snapshot: async (doc: { kind: string }) => {
        if (doc.kind === KuloStateDoc.kind) {
          return { topics: { root: { id: "root", conversationId: 1, title: "Kulo", createdAt: 1, updatedAt: 1, master: true } } };
        }
        return { run: undefined, compactions: [] };
      },
      conversation: async () => fakeConversation,
    };
    const settingsStore = new LiveSettingsStore(
      resolveHubConfig({
        stateDir: dir,
        model: {
          defaultProvider: "s2-guard",
          defaultModel: "m1",
          contextWindow: 256_000,
          compaction: { enabled: true, reserveTokens: 2_048, keepRecentTokens: 1_024, backgroundTokens: 64_000 },
        },
      }),
      path.join(dir, "identity"),
    );

    const guard = new HubContextGuard({
      harness: fakeHarness as never,
      models,
      settingsStore,
      runtimeGates: { isClosed: () => false, isHandoverBarrierActive: () => false, isRecovering: () => false },
      hardCeilingTokens: () => 200_000,
      now: () => nowMs,
    });

    const idleView = {
      entries: [{ id: 50 as EntryId, kind: UserEntry.kind, model: [{ role: "user", content: "hi", timestamp: 1 }] }],
      docs: { "pi.live": { run: undefined, compactions: [] } },
    } as unknown as ConversationView;

    // Below 200k ceiling -> no trigger.
    const below = await guard.maybeTriggerEarlyCompaction("root", 1, { tokens: 150_000, window: 256_000, softLimit: 72_000, warnLimit: 108_000 }, idleView, BACKGROUND_CONTEXT);
    expect(below).toBeUndefined();
    expect(compactCalls).toHaveLength(0);

    // Above 200k ceiling while idle -> triggers async compaction!
    const triggered = await guard.maybeTriggerEarlyCompaction("root", 1, { tokens: 205_000, window: 256_000, softLimit: 72_000, warnLimit: 108_000 }, idleView, BACKGROUND_CONTEXT);
    expect(triggered?.compacted).toBe(true);
    expect(compactCalls).toHaveLength(1);

    // Simulate 2 declines on the same tailEntryId (50) within 10 minutes -> circuit breaker opens!
    guard.projectLiveContext(idleView, 1);
    for (let i = 0; i < EARLY_COMPACT_CIRCUIT_MAX_FAILURES; i += 1) {
      guard.recordCompactionDeclined(1, "unredacted_in_memory_secret");
    }
    expect(guard.isEarlyCompactionCircuitOpen(1, 50, nowMs)).toBe(true);

    const blockedByCircuit = await guard.maybeTriggerEarlyCompaction("root", 1, { tokens: 210_000, window: 256_000, softLimit: 72_000, warnLimit: 108_000 }, idleView, BACKGROUND_CONTEXT);
    expect(blockedByCircuit).toBeUndefined();
    expect(compactCalls).toHaveLength(1);

    // A committed CompactionEntry resets the circuit breaker and decline diagnostic.
    const compactedView = {
      entries: [
        { id: 50 as EntryId, kind: UserEntry.kind, model: [{ role: "user", content: "hi", timestamp: 1 }] },
        { id: 51 as EntryId, kind: CompactionEntry.kind, head: 50 as EntryId, model: [] },
      ],
      docs: { "pi.live": { run: undefined, compactions: [] } },
    } as unknown as ConversationView;
    const afterCommitCtx = guard.projectLiveContext(compactedView, 1);
    expect(afterCommitCtx.compactionError).toBeUndefined();
    expect(guard.isEarlyCompactionCircuitOpen(1, 51, nowMs)).toBe(false);
  });
});
