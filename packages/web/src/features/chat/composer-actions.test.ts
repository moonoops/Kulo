import { describe, expect, it } from "vitest";
import { resolveComposerAction } from "./composer-actions";

const state = { busy: false, canStop: true, needsConfiguration: false, hasPayload: false, hasAttachments: false, canCall: true };

describe("composer primary action precedence", () => {
  it("keeps stop above a next draft, upload, configuration or call", () => {
    for (const patch of [{}, { hasPayload: true }, { hasAttachments: true }, { needsConfiguration: true }]) {
      expect(resolveComposerAction({ ...state, ...patch, busy: true })).toBe("stop");
    }
  });
  it("returns to calling only for a completely empty idle composer", () => {
    expect(resolveComposerAction(state)).toBe("call");
    expect(resolveComposerAction({ ...state, hasPayload: true })).toBe("send");
    expect(resolveComposerAction({ ...state, hasAttachments: true })).toBe("send");
    expect(resolveComposerAction({ ...state, canCall: false })).toBe("send");
    expect(resolveComposerAction({ ...state, busy: true, canStop: false })).toBe("send");
  });
  it("keeps model connection as an explicit recoverable action", () => {
    expect(resolveComposerAction({ ...state, needsConfiguration: true })).toBe("configure");
  });
});
