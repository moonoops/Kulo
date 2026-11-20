import { describe, expect, it } from "vitest";
import { resolveComposerAction, resolveComposerActions } from "./composer-actions";

const state = { busy: false, canStop: true, needsConfiguration: false, hasPayload: false, hasAttachments: false, canCall: true };

describe("composer primary action precedence", () => {
  it("keeps stop as the sole primary action while busy without an editable send", () => {
    for (const patch of [{}, { needsConfiguration: true }, { hasPayload: true, allowBusySend: false }, { hasAttachments: true, allowBusySend: false }]) {
      expect(resolveComposerActions({ ...state, ...patch, busy: true })).toEqual({ primary: "stop", showStop: false });
    }
  });
  it("shows send alongside stop when busy with text or attachments and busy sending is enabled", () => {
    expect(resolveComposerActions({ ...state, busy: true, hasPayload: true })).toEqual({ primary: "send", showStop: true });
    expect(resolveComposerActions({ ...state, busy: true, hasAttachments: true })).toEqual({ primary: "send", showStop: true });
    expect(resolveComposerActions({ ...state, busy: true, hasPayload: true, canStop: false })).toEqual({ primary: "send", showStop: false });
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
