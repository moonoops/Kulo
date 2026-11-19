import { describe, expect, it } from "vitest";
import { COMPUTER_PREVIEW_MAX_DATA, isComputerPreviewTarget, isComputerPreviewUpdate } from "@moco/protocol";

describe("ephemeral computer previews", () => {
  it("accepts only a bounded native session target, without endpoint injection", () => {
    expect(isComputerPreviewTarget({ tool: "browser", sessionId: "moco-one" })).toBe(true);
    expect(isComputerPreviewTarget({ tool: "desktop", sessionId: "moco-two" })).toBe(true);
    for (const value of [null, [], { tool: "browser", sessionId: "../other" }, { tool: "browser", sessionId: "a".repeat(65) },
      { tool: "browser", sessionId: "one", url: "ws://other-host" }, { tool: "shell", sessionId: "one" }]) {
      expect(isComputerPreviewTarget(value)).toBe(false);
    }
  });

  it("accepts bounded raster frames and explicit states but refuses unsafe payloads", () => {
    const frame = { mimeType: "image/png", data: "iVBORw==", capturedAt: 1234 };
    expect(isComputerPreviewUpdate({ state: "live", frame })).toBe(true);
    for (const state of ["connecting", "live", "unavailable", "closed"]) expect(isComputerPreviewUpdate({ state })).toBe(true);
    for (const value of [{ state: "unavailable", frame }, { state: "live", frame: { ...frame, mimeType: "image/svg+xml" } },
      { state: "live", frame: { ...frame, data: "data:image/png;base64,AAA=" } },
      { state: "live", frame: { ...frame, data: "A".repeat(COMPUTER_PREVIEW_MAX_DATA + 4) } },
      { state: "live", frame: { ...frame, capturedAt: Infinity } }, { state: "live", frame: { ...frame, capturedAt: 1.5 } },
      { state: "connecting", message: "x".repeat(2001) }, { state: "live", input: "click" }]) {
      expect(isComputerPreviewUpdate(value)).toBe(false);
    }
  });

  it("accepts permission recovery only for unavailable previews and known desktop permissions", () => {
    expect(isComputerPreviewUpdate({ state: "unavailable", permissionRequired: "screen" })).toBe(true);
    expect(isComputerPreviewUpdate({ state: "unavailable", permissionRequired: "accessibility" })).toBe(true);
    expect(isComputerPreviewUpdate({ state: "live", permissionRequired: "screen" })).toBe(false);
    expect(isComputerPreviewUpdate({ state: "unavailable", permissionRequired: "microphone" })).toBe(false);
    expect(isComputerPreviewUpdate({ state: "unavailable", permissionRequired: "arbitrary" })).toBe(false);
  });
});
