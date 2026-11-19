import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceWorkspace } from "../voice/voice-context";
import * as composerAttention from "../../components/use-composer-attention";
import { useAgentCompanion } from "./use-agent-companion";

afterEach(() => vi.restoreAllMocks());

function renderCompanion(voice: VoiceWorkspace | null, connected = true) {
  let result: ReturnType<typeof useAgentCompanion> | undefined;
  function Probe() {
    result = useAgentCompanion({ scope: "root", connected, tickets: [], entries: [], voice });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result!;
}

function focusedComposer() {
  const input = {} as HTMLTextAreaElement;
  vi.spyOn(composerAttention, "useComposerAttention").mockReturnValue(input);
  return input;
}

describe("companion listening provenance", () => {
  it("follows the focused composer only when ordinary idle activity becomes attentive", () => {
    const input = focusedComposer();
    const result = renderCompanion(null);
    expect(result.activity.state).toBe("listening");
    expect(result.attentionTarget).toBe(input);
  });

  it("keeps real call listening separate from a concurrently focused composer", () => {
    focusedComposer();
    const voice = { call: { call: { state: "listening", muted: false } }, recordingActive: false } as unknown as VoiceWorkspace;
    const result = renderCompanion(voice);
    expect(result.activity).toMatchObject({ state: "listening", label: "正在聆听" });
    expect(result.attentionTarget).toBeNull();
  });

  it("keeps voice recording separate from a concurrently focused composer", () => {
    focusedComposer();
    const voice = { call: { call: null }, recordingActive: true } as unknown as VoiceWorkspace;
    const result = renderCompanion(voice);
    expect(result.activity).toMatchObject({ state: "listening", label: "正在聆听" });
    expect(result.attentionTarget).toBeNull();
  });

  it.each([
    ["listening", true, "idle"],
    ["speaking", false, "speaking"],
    ["working", false, "thinking"],
    ["reconnecting", false, "idle"],
  ])("does not let composer focus override an active %s call", (state, muted, expected) => {
    focusedComposer();
    const voice = { call: { call: { state, muted } }, recordingActive: false } as unknown as VoiceWorkspace;
    const result = renderCompanion(voice);
    expect(result.activity.state).toBe(expected);
    expect(result.attentionTarget).toBeNull();
  });

  it("preserves offline and failed-call priority over composer attention", () => {
    focusedComposer();
    expect(renderCompanion(null, false)).toMatchObject({ activity: { state: "offline" }, attentionTarget: null });
    const voice = { call: { call: { state: "ended", error: "Connection lost" } } } as unknown as VoiceWorkspace;
    expect(renderCompanion(voice)).toMatchObject({ activity: { state: "error" }, attentionTarget: null });
  });
});
