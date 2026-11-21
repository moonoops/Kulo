import { describe, expect, it } from "vitest";
import {
  ANDROID_ACTIONS, ANDROID_CATALOG_VERSION, ANDROID_PERMISSION_GROUPS, ANDROID_INITIAL_TOOLS, ANDROID_MAX_RESULT, ANDROID_TOOL_CATALOG, androidOperationPolicy,
  isAndroidArgs, isAndroidCancel, isAndroidControlResult, isAndroidEnvStatus,
  isAndroidRequest, isAndroidResult, type AndroidEnvStatus, type AndroidRequest,
} from "@kulo/protocol";

const request: AndroidRequest = {
  version: 1, hubId: "hub-1", deviceId: "phone-1", ticketId: "T-0001", conversationId: 12,
  runEpoch: 3, operationId: "android:stable-call", action: "screen", args: {}, deadline: 1_800_000_000_000,
};

const status: AndroidEnvStatus = {
  version: 1, catalogVersion: 3, enabled: false, paused: true, revision: 0, grants: ["device", "observe"],
  capabilities: [{ action: "screen", available: false, reason: "accessibility_unavailable" }],
};

describe("Android Env protocol and deferred tool catalog (v3)", () => {
  it("exposes all 66 Catalog v3 typed tools with clean v3 UI actions and preserved non-UI capabilities", () => {
    expect(ANDROID_ACTIONS).toHaveLength(66);
    expect(new Set(ANDROID_ACTIONS).size).toBe(66);
    expect(ANDROID_CATALOG_VERSION).toBe(3);
    expect(ANDROID_PERMISSION_GROUPS).toHaveLength(40);
    expect(ANDROID_TOOL_CATALOG.map((tool) => tool.action)).toEqual(ANDROID_ACTIONS);
    expect(ANDROID_ACTIONS).toEqual(expect.arrayContaining([
      "screen", "tap", "type", "scroll", "key", "tap_xy", "open", "intent", "collect", "handoff",
      "apps", "wait_for", "gesture", "virtual_screen",
      "app_exit_info", "privacy_usage", "settings_restore", "notifications_query", "calendar_query",
      "contacts_query", "file_export",
    ]));
    for (const action of ["sensor", "bluetooth", "nfc", "infrared", "process_memory", "compute_run"]) {
      expect(ANDROID_ACTIONS).toContain(action);
    }
    for (const removed of ["observe", "screenshot", "sequence", "verification", "input_text", "open_app", "open_settings", "node_action", "global_action"]) {
      expect(ANDROID_ACTIONS).not.toContain(removed);
    }
  });

  it("starts with three native discovery and screen tools, deferring the rest", () => {
    expect(ANDROID_INITIAL_TOOLS).toEqual(["android_capabilities", "android_system_info", "android_screen"]);
    expect(ANDROID_TOOL_CATALOG.filter((tool) => !tool.deferred).map((tool) => tool.name))
      .toEqual(expect.arrayContaining([...ANDROID_INITIAL_TOOLS]));
    expect(ANDROID_TOOL_CATALOG.filter((tool) => !tool.deferred)).toHaveLength(3);
    expect(ANDROID_TOOL_CATALOG.find((tool) => tool.action === "tap")).toMatchObject({
      mutating: true, screen: true, permissions: ["observe", "control"], deferred: true,
    });
    expect(ANDROID_TOOL_CATALOG.find((tool) => tool.action === "collect")).toMatchObject({
      mutating: true, screen: true, permissions: ["observe", "control"], deferred: true,
    });
    expect(ANDROID_TOOL_CATALOG.find((tool) => tool.action === "open")).toMatchObject({
      mutating: true, screen: false, permissionSelector: "display", deferred: true,
    });
    expect(ANDROID_TOOL_CATALOG.find((tool) => tool.action === "intent")).toMatchObject({
      mutating: true, screen: false, permissionSelector: "kind", deferred: true,
    });
    expect(ANDROID_TOOL_CATALOG.find((tool) => tool.action === "settings_get")?.mutating).toBe(false);
    for (const tool of ANDROID_TOOL_CATALOG) {
      expect(tool.name).toBe("android_" + tool.action);
      expect(tool.description).not.toMatch(/Droy|DSH/);
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("converts required property annotations into standard nested JSON Schema", () => {
    const typeTool = ANDROID_TOOL_CATALOG.find((tool) => tool.action === "type")!;
    expect(typeTool.parameters.required).toEqual(["screen", "id", "text"]);
    expect(typeTool.parameters.properties?.id).not.toHaveProperty("required");
    const gesture = ANDROID_TOOL_CATALOG.find((tool) => tool.action === "gesture")!;
    expect(gesture.parameters.required).toEqual(["screen", "pointers"]);
    expect(gesture.parameters.properties?.pointers?.items?.required).toEqual(["points"]);
    expect(gesture.parameters.properties?.pointers?.items?.additionalProperties).toBe(false);
  });

  it("accepts typed v3 operations and rejects missing, wrong-type, or injected arguments", () => {
    expect(isAndroidArgs("screen", {})).toBe(true);
    expect(isAndroidArgs("screen", { image: true, detail: false, marks: true })).toBe(true);
    expect(isAndroidArgs("screen", { image: "yes" })).toBe(false);
    expect(isAndroidArgs("type", { screen: "s1", id: 3, text: "hello", replace: true, submit: true })).toBe(true);
    expect(isAndroidArgs("type", { id: 3, text: "missing screen" })).toBe(false);
    expect(isAndroidArgs("type", { screen: "s1", id: 3, text: 42 })).toBe(false);
    expect(isAndroidArgs("tap", { screen: "s1", id: 2, long: true })).toBe(true);
    expect(isAndroidArgs("tap", { screen: "s1", id: 0 })).toBe(false);
    expect(isAndroidArgs("tap", { screen: "s1", id: 2, command: "arbitrary shell" })).toBe(false);
    expect(isAndroidArgs("tap_xy", { screen: "s1", x: 120, y: 240, long: false })).toBe(true);
    expect(isAndroidArgs("tap_xy", { screen: "s1", x: 12.5, y: 240 })).toBe(false);
    expect(isAndroidArgs("scroll", { screen: "s1", direction: "down", id: 5 })).toBe(true);
    expect(isAndroidArgs("scroll", { screen: "s1", direction: "diagonal" })).toBe(false);
    expect(isAndroidArgs("key", { key: "back" })).toBe(true);
    expect(isAndroidArgs("key", { key: "power" })).toBe(false);
    expect(isAndroidArgs("collect", { screen: "s1", maxPages: 15, until: "底部" })).toBe(true);
    expect(isAndroidArgs("collect", { screen: "s1", maxPages: 31 })).toBe(false);
    expect(isAndroidArgs("handoff", { kind: "captcha", reason: "请完成滑块验证", targetPackage: "com.shop" })).toBe(true);
    expect(isAndroidArgs("intent", { kind: "alarm", hour: 7, minute: 30, message: "起床" })).toBe(true);
    expect(isAndroidArgs("intent", { kind: "alarm", hour: 25, minute: 0 })).toBe(false);
    expect(isAndroidArgs("capabilities", { device_id: "unapproved-phone" })).toBe(false);
    expect(isAndroidArgs("settings_set", { name: "airplane_mode", value: 1 })).toBe(false);
    expect(isAndroidArgs("open", { packageName: "test.app", display: "auto" })).toBe(true);
    expect(isAndroidArgs("open", { packageName: "test.app", display: "main" })).toBe(true);
    expect(isAndroidArgs("open", { packageName: "test.app", display: "virtual" })).toBe(true);
    expect(isAndroidArgs("open", { url: "https://example.com" })).toBe(true);
  });

  it("requires authoritative request identity and an explicit finite deadline", () => {
    expect(isAndroidRequest(request)).toBe(true);
    for (const patch of [
      { version: 2 }, { hubId: "../hub" }, { deviceId: "phone\nother" }, { ticketId: "" },
      { operationId: "x".repeat(129) }, { runEpoch: -1 }, { conversationId: 1.5 },
      { deadline: Infinity }, { deadline: 0 }, { platform: "android" }, { action: "bash" },
    ]) expect(isAndroidRequest({ ...request, ...patch })).toBe(false);
  });

  it("rejects cyclic, non-JSON, oversized and non-finite request data", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(isAndroidRequest({ ...request, args: cycle })).toBe(false);
    expect(isAndroidRequest({ ...request, args: new Date() })).toBe(false);
    expect(isAndroidArgs("tap_xy", { screen: "s1", x: NaN, y: 10 })).toBe(false);
    expect(isAndroidArgs("type", { screen: "s1", id: 1, text: "x".repeat(128 * 1024) })).toBe(false);
  });

  it("correlates result receipts to the durable operation and task epoch", () => {
    const result = { version: 1, operationId: request.operationId, ticketId: request.ticketId, runEpoch: request.runEpoch,
      action: request.action, status: "completed", data: { screen: "s2", packageName: "test.app" } };
    expect(isAndroidResult(result, request)).toBe(true);
    for (const patch of [{ operationId: "other" }, { ticketId: "T-0002" }, { runEpoch: 2 }, { action: "tap" }, { status: "success" }, { extra: true }]) {
      expect(isAndroidResult({ ...result, ...patch }, request)).toBe(false);
    }
    expect(isAndroidResult({ ...result, status: "failed" }, request)).toBe(false);
    expect(isAndroidResult({ ...result, error: { code: "FAILED", message: "not a success" } }, request)).toBe(false);
    expect(isAndroidResult({ ...result, status: "failed", error: { code: "stale_snapshot", message: "Observe again" } }, request)).toBe(true);
    expect(isAndroidResult({ ...result, status: "cancelled" }, request)).toBe(true);
    expect(isAndroidResult({ ...result, status: "unknown", error: { code: "outcome_unknown", message: "Inspect receipt" } }, request)).toBe(true);
  });

  it("keeps large screenshots off the WebSocket and counts UTF-8 bytes", () => {
    const base = { version: 1, operationId: request.operationId, ticketId: request.ticketId, runEpoch: request.runEpoch,
      action: request.action, status: "completed" };
    expect(isAndroidResult({ ...base, data: { image: "x".repeat(ANDROID_MAX_RESULT) } }, request)).toBe(false);
    expect(isAndroidResult({ ...base, data: "图".repeat(400_000) }, request)).toBe(false);
    expect(isAndroidResult({ ...base, data: { attachment: { url: "/api/uploads/att_fixture", mimeType: "image/jpeg" } } }, request)).toBe(true);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(isAndroidResult({ ...base, data: cycle }, request)).toBe(false);
  });

  it("accepts only Catalog v3 status payloads and rejects malformed entries", () => {
    expect(isAndroidEnvStatus(status)).toBe(true);
    expect(isAndroidEnvStatus({ ...status, catalogVersion: 2 as unknown as 3 })).toBe(false);
    expect(isAndroidEnvStatus({ ...status, enabled: true, active: { ticketId: "T-0001", runEpoch: 3, operationId: "op-1", action: "screen", state: "running" } })).toBe(true);
    expect(isAndroidEnvStatus({ ...status, capabilities: [...status.capabilities, ...status.capabilities] })).toBe(false);
    expect(isAndroidEnvStatus({ ...status, capabilities: [{ action: "sensor", available: true }] })).toBe(true);
    expect(isAndroidEnvStatus({ ...status, capabilities: [{ action: "screen", available: "yes" }] })).toBe(false);
    expect(isAndroidEnvStatus({ ...status, capabilities: [{ action: "screen", available: true, permissions: ["all"] }] })).toBe(false);
    expect(isAndroidEnvStatus({ ...status, grants: ["observe", "observe"] })).toBe(false);
    expect(isAndroidEnvStatus({ ...status, revision: -1 })).toBe(false);
  });

  it("distinguishes cancellation admission from confirmed quiescence", () => {
    const cancel = { version: 1, controlId: "cancel-1", ticketId: "T-0001", runEpoch: 3, reason: "User stopped task" };
    expect(isAndroidCancel(cancel)).toBe(true);
    expect(isAndroidCancel({ ...cancel, operationId: "unrelated" })).toBe(false);
    expect(isAndroidCancel({ ...cancel, ticketId: "*" })).toBe(false);
    const result = { version: 1, controlId: "cancel-1", ticketId: "T-0001", runEpoch: 3, quiescent: false };
    expect(isAndroidControlResult(result)).toBe(true);
    expect(isAndroidControlResult({ ...result, quiescent: true })).toBe(true);
    expect(isAndroidControlResult({ ...result, quiescent: "true" })).toBe(false);
    expect(isAndroidControlResult({ ...result, runEpoch: 3.5 })).toBe(false);
    expect(isAndroidControlResult({ ...result, epochQuiescent: true, resourcesRetained: true })).toBe(true);
    expect(isAndroidControlResult({ ...result, epochQuiescent: false, resourcesRetained: true })).toBe(false);
    expect(isAndroidControlResult({ ...result, quiescent: true, epochQuiescent: true, resourcesRetained: true })).toBe(false);
  });

  it("enforces operation-level and boolean-flag permissions cleanly (including screen image=true & non-root virtual)", () => {
    expect(androidOperationPolicy("screen", {})).toMatchObject({ permissions: ["observe"], mutating: false });
    expect(androidOperationPolicy("screen", { image: true })).toMatchObject({ permissions: ["observe", "screenshot"], mutating: false });
    expect(androidOperationPolicy("open", { packageName: "io.kulo.fixture" }).permissions).toEqual(["apps"]);
    expect(androidOperationPolicy("open", { packageName: "io.kulo.fixture", display: "virtual" }).permissions).toEqual(["apps", "observe", "control"]);
    expect(androidOperationPolicy("intent", { kind: "alarm", hour: 7, minute: 0 }).permissions).toEqual(["apps"]);
    expect(androidOperationPolicy("intent", { kind: "settings", page: "wifi" }).permissions).toEqual(["observe", "control"]);
    expect(androidOperationPolicy("virtual_screen", { operation: "status" })).toMatchObject({ permissions: ["observe"], mutating: false, localStatus: true });
    expect(androidOperationPolicy("virtual_screen", { operation: "stop" })).toMatchObject({ permissions: ["observe"], cleanup: true });
    expect(androidOperationPolicy("audio_start", { source: "microphone" })).toMatchObject({ permissions: ["audioMicrophone"], mutating: true });
    expect(androidOperationPolicy("audio_start", { source: "playback", scope: "system" })).toMatchObject({ permissions: ["audioPlayback"] });
    expect(androidOperationPolicy("process_memory", { operation: "open" })).toMatchObject({ permissions: ["apps", "memoryRead"], mutating: false });
    expect(androidOperationPolicy("process_memory", { operation: "open", mode: "read_write" })).toMatchObject({ permissions: ["apps", "memoryRead", "memoryWrite"], mutating: true });
    expect(androidOperationPolicy("nfc", { operation: "page_write" })).toMatchObject({ permissions: ["nfcRead", "nfcWrite"], mutating: true });
    expect(androidOperationPolicy("nfc", { operation: "status" })).toMatchObject({ permissions: [], mutating: false });
    expect(androidOperationPolicy("nfc", { operation: "close" })).toMatchObject({ permissions: [], cleanup: true });
    expect(androidOperationPolicy("audio_stop", { captureId: "capture-one" })).toMatchObject({ cleanup: true });
    expect(androidOperationPolicy("audio_transcribe", { operation: "status" })).toMatchObject({ mutating: false });
    expect(androidOperationPolicy("audio_transcribe", {})).toMatchObject({ mutating: true });
    expect(androidOperationPolicy("sensor", { operation: "read", sensorType: 19 }).permissions).toEqual(["sensors", "sensorsActivity"]);
    expect(androidOperationPolicy("sensor", { operation: "read", sensorType: 21 }).permissions).toEqual(["sensors", "sensorsBody"]);
    expect(androidOperationPolicy("device_shortcut", { operation: "create", target: "infrared" }).permissions).toEqual(["deviceDataWrite", "infrared"]);
  });

  it("accepts bounded structured JSON without accepting unknown tool fields or non-JSON values", () => {
    const data = { nested: [null, true, 3, { values: ["hello"] }] };
    expect(isAndroidArgs("compute_run", { code: "return input", input: data })).toBe(true);
    expect(isAndroidArgs("compute_run", { code: "return input", input: new Date() })).toBe(false);
    expect(isAndroidArgs("compute_run", { code: "return input", input: { value: Infinity } })).toBe(false);
    expect(isAndroidArgs("compute_run", { code: "return input", input: Array(257).fill(1) })).toBe(false);
    expect(isAndroidArgs("compute_run", { code: "return input", scriptPath: "/tmp/file" })).toBe(false);
    expect(isAndroidArgs("compute_run", { code: "x".repeat(16_385) })).toBe(false);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(isAndroidArgs("compute_run", { code: "return input", input: cycle })).toBe(false);
  });

  it("accepts current Kulo attachment references and reports bounded persistent resources", () => {
    expect(isAndroidArgs("audio_transcribe", { audioRef: { resourceId: "att_audiofixture", uri: "/api/uploads/att_audiofixture", name: "proof.wav", bytes: 44, mimeType: "audio/wav", sha256: "a".repeat(64) } })).toBe(true);
    expect(isAndroidArgs("audio_transcribe", { audioRef: { asset: { id: "att_audiofixture", name: "proof.wav", size: 44, kind: "audio", url: "/api/uploads/att_audiofixture" } } })).toBe(true);
    expect(isAndroidArgs("audio_transcribe", { audioRef: { id: "att_audiofixture", token: "unapproved" } })).toBe(false);
    expect(isAndroidEnvStatus({ ...status, resources: [{ ticketId: "T-0001", kind: "audio_capture", id: "capture-1", state: "running" }] })).toBe(true);
    expect(isAndroidEnvStatus({ ...status, resources: [{ ticketId: "../task", kind: "audio_capture", id: "capture-1", state: "running" }] })).toBe(false);
    expect(isAndroidEnvStatus({ ...status, resources: [{ ticketId: "T-1", kind: "audio_capture", id: "capture-1", state: "running", filePath: "/private" }] })).toBe(false);
  });

  it("keeps notification extras deferred and restricts notification delivery to the system channel", () => {
    for (const action of ["notification_rules", "notification_channels", "notify"]) expect(ANDROID_TOOL_CATALOG.find(tool => tool.action === action)?.deferred).toBe(true);
    expect(isAndroidArgs("notification_channels", {})).toBe(true);
    expect(isAndroidArgs("notification_channels", { operation: "setAppChannel" })).toBe(false);
    expect(isAndroidArgs("notify", { operation: "send", noticeKey: "result", text: "Completed", destinations: [{ channel: "system" }] })).toBe(true);
    expect(isAndroidArgs("notify", { operation: "send", noticeKey: "result", text: "Completed", destinations: [{ channel: "pet" }] })).toBe(false);
    expect(androidOperationPolicy("notification_rules", { operation: "archive" }).mutating).toBe(false);
    expect(androidOperationPolicy("notification_rules", { operation: "configure", enabled: true }).mutating).toBe(true);
  });
});
