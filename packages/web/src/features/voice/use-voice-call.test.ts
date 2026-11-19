import { describe, expect, it } from "vitest";
import viteConfig from "../../../vite.config";
import { VOICE_CAPTURE_WORKLET_URL, formatVoiceCallError } from "./use-voice-call";

describe("voice capture worklet packaging and error formatting", () => {
  it("never resolves the AudioWorklet module to a data URI", () => {
    expect(typeof VOICE_CAPTURE_WORKLET_URL).toBe("string");
    expect(VOICE_CAPTURE_WORKLET_URL.length).toBeGreaterThan(0);
    expect(VOICE_CAPTURE_WORKLET_URL).not.toMatch(/^data:/i);
  });

  it("configures Vite to never inline .worklet.js modules", () => {
    const limit = viteConfig.build?.assetsInlineLimit;
    expect(typeof limit).toBe("function");
    if (typeof limit === "function") {
      expect(limit("/repo/packages/web/src/features/voice/voice-capture.worklet.js", Buffer.from("x"))).toBe(false);
      expect(limit("/repo/packages/web/src/features/voice/audio.worklet.mjs", Buffer.from("x"))).toBe(false);
      expect(limit("/repo/packages/web/src/assets/icon.png", Buffer.from("x"))).toBeUndefined();
    }
  });

  it("replaces raw worklet loader errors and strips embedded data URIs", () => {
    const workletFailure = new Error(
      "Failed to load worklet module script: data:text/javascript;base64,Y2xhc3MgTW9jb1ZvaWNlQ2FwdHVyZQ== (a dependency or cross-origin script failed to load)",
    );
    const formatted = formatVoiceCallError(workletFailure);
    expect(formatted).toBe("无法初始化语音采集模块，请刷新页面后重试");
    expect(formatted).not.toContain("data:text/javascript");
    expect(formatted).not.toContain("base64");

    const dataUriError = new Error("Unexpected script data:text/javascript;base64,YWJjZGVm failed");
    expect(formatVoiceCallError(dataUriError)).toBe("Unexpected script [data-url] failed");

    expect(formatVoiceCallError(new DOMException("missing", "NotFoundError"))).toBe("未找到麦克风");
    expect(formatVoiceCallError(new Error("语音连接已断开。"))).toBe("语音连接已断开。");
    expect(formatVoiceCallError("unknown")).toBe("通话连接失败，请重试");
  });
});
