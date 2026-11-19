import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ANDROID_INITIAL_TOOLS, ANDROID_TOOL_CATALOG, type AndroidResult } from "@kulo/protocol";
import { describe, expect, it, vi } from "vitest";
import { androidOperationId, createAndroidTools, type AndroidToolScope } from "../packages/hub/src/tools-android.js";

function fixture() {
  let now = Date.now();
  const scope: AndroidToolScope = { ticketId: "T-1", conversationId: 7, runEpoch: 2, deviceIds: ["phone"], readOnly: false,
    assertActive: vi.fn(async () => {}) };
  const memo = new Map<string, unknown>();
  const execute = vi.fn(async (_id, request): Promise<AndroidResult> => ({ version: 1, action: request.action,
    operationId: request.operationId, ticketId: request.ticketId, runEpoch: request.runEpoch, status: "completed", data: { ok: true } }));
  const assets = vi.fn(async () => [{ type: "image" as const, mimeType: "image/png", data: "test-image" }]);
  const tools = createAndroidTools({ hubId: () => "hub-a", scope: async () => scope, execute, resolveAssets: assets });
  const api = { taskId: 20, callId: "call-one", conversationId: 7,
    now: () => now, memo: async (key, candidate) => { if (!memo.has(key)) memo.set(key, structuredClone(candidate)); return structuredClone(memo.get(key)); },
    agent: async () => ({ model: { provider: "test", modelId: "vision" }, deferred: tools.filter((tool) => tool.deferred) }),
    models: { getModel: () => ({ input: ["text", "image"] }) },
  } as unknown as ToolExecutionApi;
  const tool = (action: string) => tools.find((item) => item.name === `android_${action}`)!;
  return { scope, memo, execute, assets, tools, api, tool, advance: (duration: number) => { now += duration; } };
}

describe("native Android model tools", () => {
  it("uses the retained capability schemas and Pi's native deferred discovery", async () => {
    const f = fixture();
    expect(f.tools).toHaveLength(68);
    expect(f.tools.filter((tool) => !tool.deferred).map((tool) => tool.name)).toEqual(ANDROID_INITIAL_TOOLS);
    for (const definition of ANDROID_TOOL_CATALOG) {
      const tool = f.tools.find((item) => item.name === definition.name)!;
      expect(tool.parameters).toMatchObject({ additionalProperties: false, properties: definition.parameters.properties });
      expect(tool.replay).toBe(definition.mutating ? "unsafe" : "safe");
    }
    const found = await createToolSearchTool().execute({ query: "android_input_text", limit: 1 }, f.api, BACKGROUND_CONTEXT);
    expect(found.control?.addTools).toEqual(["android_input_text"]);
    expect(found.output?.[0]).toMatchObject({ type: "text" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("pins the complete native intent and deadline with Pi memo across a rerun", async () => {
    const f = fixture();
    await f.tool("system_info").execute({}, f.api, BACKGROUND_CONTEXT);
    const first = f.execute.mock.calls[0]![1];
    f.advance(1000);
    await f.tool("system_info").execute({}, f.api, BACKGROUND_CONTEXT);
    expect(f.execute.mock.calls[1]![1]).toEqual(first);
    expect(first).toMatchObject({ hubId: "hub-a", deviceId: "phone", ticketId: "T-1", conversationId: 7, runEpoch: 2, action: "system_info" });
    expect(first.operationId).toBe(androidOperationId(f.scope, f.api, "system_info", "phone"));
    f.advance(120_000);
    await expect(f.tool("system_info").execute({}, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("原始期限");
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects a changed intent, unauthorized target, and ambiguous multi-phone calls", async () => {
    const f = fixture();
    await f.tool("system_info").execute({}, f.api, BACKGROUND_CONTEXT);
    await expect(f.tool("system_info").execute({ sections: ["battery"] }, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("意图已改变");
    await expect(f.tool("system_info").execute({ device_id: "other" }, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("获准");
    f.scope.deviceIds = ["phone", "phone-two"];
    await expect(f.tool("system_info").execute({}, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("多目标");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps role, active epoch, and strict argument validation as execution boundaries", async () => {
    const f = fixture();
    f.scope.readOnly = true;
    await expect(f.tool("tap").execute({ snapshotId: "snap", x: 2, y: 2 }, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("只读");
    await expect(f.tool("system_info").execute({ shell: "whoami" }, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("参数无效");
    vi.mocked(f.scope.assertActive).mockRejectedValueOnce(new Error("stale epoch"));
    await expect(f.tool("system_info").execute({}, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("stale epoch");
    const controller = new AbortController(); controller.abort();
    await expect(f.tool("system_info").execute({}, f.api, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("never captures a screenshot for a text-only model", async () => {
    const f = fixture();
    vi.spyOn(f.api.models, "getModel").mockReturnValue({ input: ["text"] } as never);
    await expect(f.tool("screenshot").execute({}, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("不支持图片");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.memo.size).toBe(0);
  });

  it("passes the actual selected asset owner and rejects mismatching receipts", async () => {
    const f = fixture();
    f.scope.deviceIds = ["phone", "phone-two"];
    const result = await f.tool("screenshot").execute({ device_id: "phone-two" }, f.api, BACKGROUND_CONTEXT);
    expect(f.assets).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "phone-two", deviceIds: ["phone", "phone-two"] }), expect.objectContaining({ status: "completed" }));
    expect(result.output?.[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    const other = fixture();
    other.execute.mockImplementationOnce(async (_id, req) => ({ version: 1, action: req.action, operationId: req.operationId,
      ticketId: "wrong-ticket", runEpoch: req.runEpoch, status: "completed" }));
    await expect(other.tool("system_info").execute({}, other.api, BACKGROUND_CONTEXT)).rejects.toThrow("回执");
    expect(other.assets).not.toHaveBeenCalled();
  });

  it("does not present unknown outcomes as successful completed actions", async () => {
    const f = fixture();
    f.execute.mockImplementationOnce(async (_id, req) => ({ version: 1, action: req.action, operationId: req.operationId,
      ticketId: req.ticketId, runEpoch: req.runEpoch, status: "unknown", error: { code: "outcome_unknown", message: "Observe before retrying" } }));
    const result = await f.tool("system_info").execute({}, f.api, BACKGROUND_CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.output?.[0]).toMatchObject({ type: "text", text: expect.stringContaining('"status":"unknown"') });
    expect(f.assets).not.toHaveBeenCalled();
  });

  it("rechecks the task after resolving authenticated screenshot assets", async () => {
    const f = fixture();
    f.assets.mockImplementationOnce(async () => {
      vi.mocked(f.scope.assertActive).mockRejectedValueOnce(new Error("task stopped during asset resolution"));
      return [];
    });
    await expect(f.tool("screenshot").execute({}, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("task stopped");
  });

  it.each(["sensor", "bluetooth", "nfc", "audio_transcribe", "browser_open", "compute_run", "virtual_screen", "notification_rules", "notification_channels", "notify"])("discovers %s through native Pi deferred loading", async (action) => {
    const f = fixture();
    expect(f.tools.find(tool => tool.name === `android_${action}`)?.deferred).toBe(true);
    const found = await createToolSearchTool().execute({ query: `android_${action}`, limit: 1 }, f.api, BACKGROUND_CONTEXT);
    expect(found.control?.addTools).toEqual([`android_${action}`]);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("keeps notification reads available to read-only roles without exposing organizer internals", async () => {
    const read = fixture(); read.scope.readOnly = true;
    await read.tool("notification_rules").execute({ operation: "archive", limit: 20 }, read.api, BACKGROUND_CONTEXT);
    const write = fixture(); write.scope.readOnly = true;
    await expect(write.tool("notification_rules").execute({ operation: "configure", enabled: true }, write.api, BACKGROUND_CONTEXT)).rejects.toThrow("只读");
    const internal = fixture();
    await expect(internal.tool("notification_rules").execute({ operation: "apply", decision: { action: "clear" } }, internal.api, BACKGROUND_CONTEXT)).rejects.toThrow("参数无效");
    expect(internal.tools.map(tool => tool.name)).not.toContain("android_notification_apply");
  });

  it("allows scoped read-only operations but rejects writes within the same discovered tool", async () => {
    const read = fixture(); read.scope.readOnly = true;
    await read.tool("nfc").execute({ operation: "status" }, read.api, BACKGROUND_CONTEXT);
    expect(read.execute).toHaveBeenCalledOnce();
    const write = fixture(); write.scope.readOnly = true;
    await expect(write.tool("nfc").execute({ operation: "format" }, write.api, BACKGROUND_CONTEXT)).rejects.toThrow("只读");
    expect(write.execute).not.toHaveBeenCalled();
    const memory = fixture(); memory.scope.readOnly = true;
    await memory.tool("process_memory").execute({ operation: "open", mode: "read_only", packageName: "io.kulo.fixture" }, memory.api, BACKGROUND_CONTEXT);
    const denied = fixture(); denied.scope.readOnly = true;
    await expect(denied.tool("process_memory").execute({ operation: "open", mode: "read_write", packageName: "io.kulo.fixture" }, denied.api, BACKGROUND_CONTEXT)).rejects.toThrow("只读");
  });

  it("does not require image support for compute and audio attachments", async () => {
    const f = fixture();
    vi.spyOn(f.api.models, "getModel").mockReturnValue({ input: ["text"] } as never);
    const result = await f.tool("compute_artifact").execute({ jobId: "job-one", name: "proof.json" }, f.api, BACKGROUND_CONTEXT);
    expect(f.assets).toHaveBeenCalledWith(expect.objectContaining({ supportsImages: false, deviceId: "phone" }), expect.anything());
    expect(result.output?.some(part => part.type === "image")).toBe(false);
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("does not forward attachment or file inputs without the Hub resource ownership resolver", async () => {
    const f = fixture();
    await expect(f.tool("audio_transcribe").execute({ audioRef: { id: "att_fixture" } }, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("资源归属");
    await expect(f.tool("audio_transcribe").execute({ filePath: "/data/private/audio.wav" }, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("资源归属");
    expect(f.execute).not.toHaveBeenCalled();
  });
});
