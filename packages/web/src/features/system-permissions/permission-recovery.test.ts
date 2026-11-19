import { describe, expect, it } from "vitest";
import { isMicrophonePermissionFailure } from "./permission-recovery";

describe("microphone recovery classification", () => {
  it("offers permission recovery for access refusal and security restrictions", () => {
    expect(isMicrophonePermissionFailure(new DOMException("Denied", "NotAllowedError"))).toBe(true);
    expect(isMicrophonePermissionFailure(new DOMException("Blocked", "SecurityError"))).toBe(true);
  });

  it("keeps missing hardware, aborted requests and provider failures on their own recovery paths", () => {
    expect(isMicrophonePermissionFailure(new DOMException("No input", "NotFoundError"))).toBe(false);
    expect(isMicrophonePermissionFailure(new DOMException("Cancelled", "AbortError"))).toBe(false);
    expect(isMicrophonePermissionFailure(new Error("Permission denied by voice provider"))).toBe(false);
  });
});
