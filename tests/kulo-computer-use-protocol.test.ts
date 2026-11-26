import { describe, expect, it } from "vitest";
import {
  BROWSER_V2_CAPABILITY,
  browserRequestWantsAutoSnapshot,
  computerUseEnvDeadlineMs,
  computerUseRpcTimeoutMs,
  hasBrowserV2Capability,
  isBrowserBatchReadOnly,
  isComputerUseRequest,
  isComputerUseResult,
  type ComputerUseRequest,
} from "@kulo/protocol";

describe("computer-use protocol boundary", () => {
  it("accepts only HTTP(S), safe session keys, current ref formats and supported arguments", () => {
    expect(isComputerUseRequest({ tool: "browser", action: "open", sessionId: "kulo-test", url: "https://example.com" })).toBe(true);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://account:password@example.com"]) {
      expect(isComputerUseRequest({ tool: "browser", action: "open", sessionId: "kulo-test", url })).toBe(false);
    }
    expect(isComputerUseRequest({ tool: "browser", action: "snapshot", sessionId: "../other" })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "click", sessionId: "kulo-test", ref: "#arbitrary-selector" })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "click", sessionId: "kulo-test", app: "TextEdit", ref: "@sabc:e3" })).toBe(true);
    expect(isComputerUseRequest({ tool: "desktop", action: "click", sessionId: "kulo-test", app: "TextEdit", ref: "@e3" })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "snapshot", sessionId: "kulo-test", app: "TextEdit", headed: true })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "status", envId: "unapproved-target" })).toBe(false);
    // Step 5 bounded scroll & wait protocol validation
    expect(isComputerUseRequest({ tool: "browser", action: "scroll", sessionId: "kulo-test", direction: "down", amount: 600 })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "scroll", sessionId: "kulo-test", direction: "diagonal", amount: 600 })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "scroll", sessionId: "kulo-test", direction: "down", amount: 99_999 })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "wait", sessionId: "kulo-test", text: "Loaded", timeoutMs: 3000 })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "wait", sessionId: "kulo-test", ref: "@e2", timeoutMs: 3000 })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "wait", sessionId: "kulo-test" })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "wait", sessionId: "kulo-test", text: "Loaded", timeoutMs: 60_000 })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "scroll", sessionId: "kulo-test", app: "Finder", ref: "@sabc:e1", direction: "down", amount: 4 })).toBe(true);
    expect(isComputerUseRequest({ tool: "desktop", action: "scroll", sessionId: "kulo-test", app: "Finder", ref: "@sabc:e1", direction: "down", amount: 50 })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "wait", sessionId: "kulo-test", app: "Finder", text: "button:OK", timeoutMs: 5000 })).toBe(true);
  });

  it("validates browser v2 snapshot mode, returnSnapshot/snapshotMode allowlists, and bounded batch steps", () => {
    // snapshot mode
    expect(isComputerUseRequest({ tool: "browser", action: "snapshot", sessionId: "kulo-test", mode: "interactive" })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "snapshot", sessionId: "kulo-test", mode: "compact" })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "snapshot", sessionId: "kulo-test", mode: "full" })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "snapshot", sessionId: "kulo-test", returnSnapshot: true })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "snapshot", sessionId: "kulo-test", snapshotMode: "compact" })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "snapshot", sessionId: "kulo-test", app: "Finder", mode: "compact" })).toBe(false);

    // returnSnapshot + snapshotMode allowed on open/click/scroll/back/forward/fill/type only
    expect(isComputerUseRequest({ tool: "browser", action: "open", sessionId: "kulo-test", url: "https://example.com", returnSnapshot: false, snapshotMode: "compact" })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "click", sessionId: "kulo-test", ref: "@e1", returnSnapshot: true, snapshotMode: "interactive" })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "scroll", sessionId: "kulo-test", direction: "down", amount: 400, returnSnapshot: false })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "back", sessionId: "kulo-test", returnSnapshot: true, snapshotMode: "compact" })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "forward", sessionId: "kulo-test", returnSnapshot: false })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "fill", sessionId: "kulo-test", ref: "@e1", text: "alice", returnSnapshot: true, snapshotMode: "compact" })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "type", sessionId: "kulo-test", ref: "@e1", text: "bob", returnSnapshot: false })).toBe(true);
    // invalid types or disallowed actions
    expect(isComputerUseRequest({ tool: "browser", action: "open", sessionId: "kulo-test", url: "https://example.com", mode: "compact" })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "click", sessionId: "kulo-test", ref: "@e1", returnSnapshot: "true" })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "click", sessionId: "kulo-test", ref: "@e1", snapshotMode: "raw" })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "get-url", sessionId: "kulo-test", returnSnapshot: true })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "get-text", sessionId: "kulo-test", snapshotMode: "compact" })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "wait", sessionId: "kulo-test", text: "ok", returnSnapshot: true })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "close", sessionId: "kulo-test", returnSnapshot: false })).toBe(false);

    // bounded batch (1..5 steps)
    const validBatch: ComputerUseRequest = {
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [
        { action: "fill", ref: "@e1", text: "alice" },
        { action: "type", ref: "@e2", text: "secret" },
        { action: "click", ref: "@e3" },
        { action: "wait", text: "Welcome", timeoutMs: 8000 },
        { action: "snapshot", mode: "compact" },
      ],
      returnSnapshot: true,
      snapshotMode: "interactive",
    };
    expect(isComputerUseRequest(validBatch)).toBe(true);
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [{ action: "scroll", direction: "down", amount: 500 }, { action: "back" }, { action: "forward" }, { action: "get-url" }, { action: "get-text" }],
    })).toBe(true);

    // step count bounds: 0 or >5 rejected
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [] })).toBe(false);
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: Array.from({ length: 6 }, () => ({ action: "get-url" })),
    })).toBe(false);

    // disallowed actions inside batch (nested batch, open, close, status) & desktop batch
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "batch", steps: [{ action: "get-url" }] }] })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "open", url: "https://example.com" }] })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "close" }] })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "status" }] })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "batch", sessionId: "kulo-test", steps: [{ action: "get-url" }] })).toBe(false);

    // mode strictly only on snapshot step
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "click", ref: "@e1", mode: "compact" }] })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "get-url", mode: "compact" }] })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "snapshot", mode: "full" }] })).toBe(false);

    // strict key allowlists inside batch & steps
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "get-url", extra: true }] })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "get-url" }], extra: 1 })).toBe(false);

    // cumulative wait.timeoutMs <= 15_000 (including defaulted 5_000 ms waits)
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [{ action: "wait", text: "A", timeoutMs: 10_000 }, { action: "wait", text: "B", timeoutMs: 5_000 }],
    })).toBe(true);
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [{ action: "wait", text: "A", timeoutMs: 10_000 }, { action: "wait", text: "B", timeoutMs: 5_001 }],
    })).toBe(false);
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [{ action: "wait", text: "A" }, { action: "wait", text: "B" }, { action: "wait", text: "C" }],
    })).toBe(true);
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [{ action: "wait", text: "A" }, { action: "wait", text: "B" }, { action: "wait", text: "C" }, { action: "wait", text: "D" }],
    })).toBe(false);

    // cumulative UTF-8 text bytes across steps <= 20_000
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [{ action: "fill", ref: "@e1", text: "a".repeat(10_000) }, { action: "type", ref: "@e2", text: "b".repeat(10_000) }],
    })).toBe(true);
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [{ action: "fill", ref: "@e1", text: "a".repeat(10_000) }, { action: "type", ref: "@e2", text: "b".repeat(10_001) }],
    })).toBe(false);
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [{ action: "fill", ref: "@e1", text: "中".repeat(7_000) }], // 21_000 UTF-8 bytes
    })).toBe(false);
    expect(isComputerUseRequest({
      tool: "browser",
      action: "batch",
      sessionId: "kulo-test",
      steps: [{ action: "fill", ref: "@e1", text: "bad\0null" }],
    })).toBe(false);
  });

  it("computes capability flags, auto-snapshot defaults, read-only batch check, and shared RPC deadlines", () => {
    expect(BROWSER_V2_CAPABILITY).toBe("agent-browser-v2");
    expect(hasBrowserV2Capability(["agent-browser"])).toBe(false);
    expect(hasBrowserV2Capability(["agent-browser", "agent-browser-v2"])).toBe(true);

    expect(browserRequestWantsAutoSnapshot({ tool: "browser", action: "open", sessionId: "s", url: "https://example.com" })).toBe(true);
    expect(browserRequestWantsAutoSnapshot({ tool: "browser", action: "open", sessionId: "s", url: "https://example.com", returnSnapshot: false })).toBe(false);
    expect(browserRequestWantsAutoSnapshot({ tool: "browser", action: "fill", sessionId: "s", ref: "@e1", text: "x" })).toBe(false);
    expect(browserRequestWantsAutoSnapshot({ tool: "browser", action: "fill", sessionId: "s", ref: "@e1", text: "x", returnSnapshot: true })).toBe(true);
    expect(browserRequestWantsAutoSnapshot({ tool: "browser", action: "batch", sessionId: "s", steps: [{ action: "click", ref: "@e1" }] })).toBe(true);
    expect(browserRequestWantsAutoSnapshot({ tool: "browser", action: "batch", sessionId: "s", steps: [{ action: "click", ref: "@e1" }, { action: "snapshot" }] })).toBe(false);
    expect(browserRequestWantsAutoSnapshot({ tool: "browser", action: "batch", sessionId: "s", steps: [{ action: "click", ref: "@e1" }], returnSnapshot: false })).toBe(false);

    expect(isBrowserBatchReadOnly([{ action: "get-url" }, { action: "get-text" }, { action: "snapshot", mode: "compact" }])).toBe(true);
    expect(isBrowserBatchReadOnly([{ action: "get-url" }, { action: "click", ref: "@e1" }])).toBe(false);

    const openReq: ComputerUseRequest = { tool: "browser", action: "open", sessionId: "s", url: "https://example.com" };
    expect(computerUseEnvDeadlineMs(openReq)).toBe(40_000);
    expect(computerUseRpcTimeoutMs(openReq)).toBe(45_000);

    const heavyBatch: ComputerUseRequest = {
      tool: "browser",
      action: "batch",
      sessionId: "s",
      steps: [
        { action: "fill", ref: "@e1", text: "u" },
        { action: "fill", ref: "@e2", text: "p" },
        { action: "click", ref: "@e3" },
        { action: "wait", text: "Dashboard", timeoutMs: 15_000 },
      ],
    };
    const envBudget = computerUseEnvDeadlineMs(heavyBatch);
    expect(envBudget).toBe(70_000);
    expect(computerUseRpcTimeoutMs(heavyBatch)).toBe(envBudget + 5_000);
    expect(computerUseRpcTimeoutMs(heavyBatch)).toBeGreaterThan(45_000);
  });

  it("correlates receipts and rejects oversized or success-shaped errors", () => {
    const request: ComputerUseRequest = { tool: "browser", action: "snapshot", sessionId: "kulo-test" };
    const result = { ...request, platform: "linux", ok: true, data: { snapshot: "page" } };
    expect(isComputerUseResult(result, request)).toBe(true);
    expect(isComputerUseResult({ ...result, sessionId: "other-session" }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, action: "click" }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, error: { code: "FAILED", message: "failed" } }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, ok: false }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, data: "x".repeat(1024 * 1024) }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, unexpected: "unvalidated output" }, request)).toBe(false);

    const batchReq: ComputerUseRequest = { tool: "browser", action: "batch", sessionId: "kulo-test", steps: [{ action: "get-url" }] };
    expect(isComputerUseResult({ tool: "browser", action: "batch", sessionId: "kulo-test", platform: "darwin", ok: true, data: { steps: [{ index: 0, action: "get-url", ok: true }] } }, batchReq)).toBe(true);
    expect(isComputerUseResult({ tool: "browser", action: "batch", sessionId: "kulo-test", platform: "darwin", ok: false, data: { steps: [], failedStepIndex: 0 }, error: { code: "NATIVE_OPERATION_FAILED", message: "step 0 failed" } }, batchReq)).toBe(true);
  });
});
