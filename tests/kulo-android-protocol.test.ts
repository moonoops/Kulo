import { describe, expect, it } from "vitest";
import {
  ANDROID_ACTIONS, ANDROID_CATALOG_VERSION, ANDROID_PERMISSION_GROUPS, ANDROID_INITIAL_TOOLS, ANDROID_MAX_RESULT, ANDROID_TOOL_CATALOG, androidOperationPolicy,
  isAndroidArgs, isAndroidCancel, isAndroidControlResult, isAndroidEnvStatus,
  isAndroidRequest, isAndroidResult, type AndroidEnvStatus, type AndroidRequest,
} from "@kulo/protocol";

const request: AndroidRequest = {
  version: 1, hubId: "hub-1", deviceId: "phone-1", ticketId: "T-0001", conversationId: 12,
  runEpoch: 3, operationId: "android:stable-call", action: "observe", args: {}, deadline: 1_800_000_000_000,
};

const status: AndroidEnvStatus = {
  version: 1, catalogVersion: 1, enabled: false, paused: true, revision: 0, grants: ["device", "observe"],
  capabilities: [{ action: "observe", available: false, reason: "accessibility_unavailable" }],
};

describe("Android Env protocol and deferred tool catalog", () => {
  it("keeps all 65 captured capabilities plus the three retained notification features", () => {
    expect(ANDROID_ACTIONS).toHaveLength(68);
    expect(new Set(ANDROID_ACTIONS).size).toBe(68);
    expect(ANDROID_CATALOG_VERSION).toBe(2);
    expect(ANDROID_PERMISSION_GROUPS).toHaveLength(40);
    expect(ANDROID_TOOL_CATALOG.map((tool) => tool.action)).toEqual(ANDROID_ACTIONS);
    expect(ANDROID_ACTIONS).toEqual(expect.arrayContaining([
      "observe", "tap", "gesture", "sequence", "verification", "app_exit_info", "privacy_usage",
      "settings_restore", "notifications_query", "calendar_query", "contacts_query", "file_export",
    ]));
    for (const action of ["sensor", "bluetooth", "nfc", "infrared", "process_memory", "compute_run"]) {
      expect(ANDROID_ACTIONS).toContain(action);
    }
  });

  it("starts with three native discovery and observation tools, deferring the rest", () => {
    expect(ANDROID_INITIAL_TOOLS).toEqual(["android_capabilities", "android_system_info", "android_observe"]);
    expect(ANDROID_TOOL_CATALOG.filter((tool) => !tool.deferred).map((tool) => tool.name))
      .toEqual(expect.arrayContaining([...ANDROID_INITIAL_TOOLS]));
    expect(ANDROID_TOOL_CATALOG.filter((tool) => !tool.deferred)).toHaveLength(3);
    expect(ANDROID_TOOL_CATALOG.find((tool) => tool.action === "tap")).toMatchObject({
      mutating: true, screen: true, permissions: ["observe", "control"], deferred: true,
    });
    expect(ANDROID_TOOL_CATALOG.find((tool) => tool.action === "settings_get")?.mutating).toBe(false);
    for (const tool of ANDROID_TOOL_CATALOG) {
      expect(tool.name).toBe("android_" + tool.action);
      expect(tool.description).not.toMatch(/Droy|DSH/);
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("converts required property annotations into standard nested JSON Schema", () => {
    const input = ANDROID_TOOL_CATALOG.find((tool) => tool.action === "input_text")!;
    expect(input.parameters.required).toEqual(["nodeId", "snapshotId", "text"]);
    expect(input.parameters.properties?.nodeId).not.toHaveProperty("required");
    const sequence = ANDROID_TOOL_CATALOG.find((tool) => tool.action === "sequence")!;
    expect(sequence.parameters.required).toEqual(["packageName", "snapshotId", "steps"]);
    expect(sequence.parameters.properties?.steps?.items?.required).toEqual(["action"]);
    expect(sequence.parameters.properties?.steps?.items?.properties?.target?.additionalProperties).toBe(false);
  });

  it("accepts typed operations and rejects missing, wrong-type, or injected arguments", () => {
    expect(isAndroidArgs("input_text", { nodeId: "n12", snapshotId: "snapshot-2", text: "" })).toBe(true);
    expect(isAndroidArgs("input_text", { nodeId: "n12", text: "missing snapshot" })).toBe(false);
    expect(isAndroidArgs("input_text", { nodeId: "n12", snapshotId: "snapshot-2", text: 42 })).toBe(false);
    expect(isAndroidArgs("tap", { snapshotId: "s1", x: 12, y: 20, channel: "accessibility", holdMs: 800 })).toBe(true);
    expect(isAndroidArgs("tap", { snapshotId: "s1", holdMs: 800.2 })).toBe(false);
    expect(isAndroidArgs("tap", { snapshotId: "s1", channel: "shell" })).toBe(false);
    expect(isAndroidArgs("tap", { snapshotId: "s1", command: "arbitrary shell" })).toBe(false);
    expect(isAndroidArgs("capabilities", { device_id: "unapproved-phone" })).toBe(false);
    expect(isAndroidArgs("settings_set", { name: "airplane_mode", value: 1 })).toBe(false);
    expect(isAndroidArgs("open_app", { packageName: "test.app", display: "auto" })).toBe(true);
    expect(isAndroidArgs("open_app", { packageName: "test.app", display: "main" })).toBe(true);
    expect(isAndroidArgs("open_app", { packageName: "test.app", display: "virtual" })).toBe(true);
  });

  it("rejects extra nested sequence parameters rather than accepting a script surface", () => {
    const args = { packageName: "test.app", snapshotId: "s1", steps: [{ action: "tap", target: { text: "Next" } }] };
    expect(isAndroidArgs("sequence", args)).toBe(true);
    expect(isAndroidArgs("sequence", { ...args, steps: [{ action: "tap", target: { text: "Next", xpath: "//button" } }] })).toBe(false);
    expect(isAndroidArgs("sequence", { ...args, steps: [{ action: "eval", text: "untrusted program" }] })).toBe(false);
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
    expect(isAndroidArgs("tap", { snapshotId: "s1", x: NaN })).toBe(false);
    expect(isAndroidArgs("input_text", { nodeId: "n1", snapshotId: "s1", text: "x".repeat(128 * 1024) })).toBe(false);
  });

  it("correlates result receipts to the durable operation and task epoch", () => {
    const result = { version: 1, operationId: request.operationId, ticketId: request.ticketId, runEpoch: request.runEpoch,
      action: request.action, status: "completed", data: { snapshotId: "s2", packageName: "test.app" } };
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
    expect(isAndroidResult({ ...base, data: { attachment: { url: "/api/uploads/att_fixture", mimeType: "image/png" } } }, request)).toBe(true);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(isAndroidResult({ ...base, data: cycle }, request)).toBe(false);
  });

  it("accepts disabled or permission-denied capability status without inventing availability", () => {
    expect(isAndroidEnvStatus(status)).toBe(true);
    expect(isAndroidEnvStatus({ ...status, enabled: true, active: { ticketId: "T-0001", runEpoch: 3, operationId: "op-1", action: "observe", state: "running" } })).toBe(true);
    expect(isAndroidEnvStatus({ ...status, capabilities: [...status.capabilities, ...status.capabilities] })).toBe(false);
    expect(isAndroidEnvStatus({ ...status, catalogVersion: 2, capabilities: [{ action: "sensor", available: true }] })).toBe(true);
    expect(isAndroidEnvStatus({ ...status, capabilities: [{ action: "observe", available: "yes" }] })).toBe(false);
    expect(isAndroidEnvStatus({ ...status, capabilities: [{ action: "observe", available: true, permissions: ["all"] }] })).toBe(false);
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

  it("uses operation-level permissions and read-only policy without granting missing local access", () => {
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
    expect(androidOperationPolicy("open_app", { packageName: "io.kulo.fixture", display: "virtual" }).permissions).toEqual(["apps", "observe", "control", "root"]);
    expect(androidOperationPolicy("open_app", { packageName: "io.kulo.fixture" }).permissions).toEqual(["apps", "control"]);
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
    expect(isAndroidEnvStatus({ ...status, catalogVersion: 2, resources: [{ ticketId: "T-0001", kind: "audio_capture", id: "capture-1", state: "running" }] })).toBe(true);
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
