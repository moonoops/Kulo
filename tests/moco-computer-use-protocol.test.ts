import { describe, expect, it } from "vitest";
import { isComputerUseRequest, isComputerUseResult, type ComputerUseRequest } from "@moco/protocol";

describe("computer-use protocol boundary", () => {
  it("accepts only HTTP(S), safe session keys, current ref formats and supported arguments", () => {
    expect(isComputerUseRequest({ tool: "browser", action: "open", sessionId: "moco-test", url: "https://example.com" })).toBe(true);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://account:password@example.com"]) {
      expect(isComputerUseRequest({ tool: "browser", action: "open", sessionId: "moco-test", url })).toBe(false);
    }
    expect(isComputerUseRequest({ tool: "browser", action: "snapshot", sessionId: "../other" })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "click", sessionId: "moco-test", ref: "#arbitrary-selector" })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "click", sessionId: "moco-test", app: "TextEdit", ref: "@sabc:e3" })).toBe(true);
    expect(isComputerUseRequest({ tool: "desktop", action: "click", sessionId: "moco-test", app: "TextEdit", ref: "@e3" })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "snapshot", sessionId: "moco-test", app: "TextEdit", headed: true })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "status", envId: "unapproved-target" })).toBe(false);
    // Step 5 bounded scroll & wait protocol validation
    expect(isComputerUseRequest({ tool: "browser", action: "scroll", sessionId: "moco-test", direction: "down", amount: 600 })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "scroll", sessionId: "moco-test", direction: "diagonal", amount: 600 })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "scroll", sessionId: "moco-test", direction: "down", amount: 99_999 })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "wait", sessionId: "moco-test", text: "Loaded", timeoutMs: 3000 })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "wait", sessionId: "moco-test", ref: "@e2", timeoutMs: 3000 })).toBe(true);
    expect(isComputerUseRequest({ tool: "browser", action: "wait", sessionId: "moco-test" })).toBe(false);
    expect(isComputerUseRequest({ tool: "browser", action: "wait", sessionId: "moco-test", text: "Loaded", timeoutMs: 60_000 })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "scroll", sessionId: "moco-test", app: "Finder", ref: "@sabc:e1", direction: "down", amount: 4 })).toBe(true);
    expect(isComputerUseRequest({ tool: "desktop", action: "scroll", sessionId: "moco-test", app: "Finder", ref: "@sabc:e1", direction: "down", amount: 50 })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "wait", sessionId: "moco-test", app: "Finder", text: "button:OK", timeoutMs: 5000 })).toBe(true);
  });

  it("correlates receipts and rejects oversized or success-shaped errors", () => {
    const request: ComputerUseRequest = { tool: "browser", action: "snapshot", sessionId: "moco-test" };
    const result = { ...request, platform: "linux", ok: true, data: { snapshot: "page" } };
    expect(isComputerUseResult(result, request)).toBe(true);
    expect(isComputerUseResult({ ...result, sessionId: "other-session" }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, action: "click" }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, error: { code: "FAILED", message: "failed" } }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, ok: false }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, data: "x".repeat(1024 * 1024) }, request)).toBe(false);
    expect(isComputerUseResult({ ...result, unexpected: "unvalidated output" }, request)).toBe(false);
  });
});
