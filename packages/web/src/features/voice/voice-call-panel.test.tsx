import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveVoiceCall } from "./use-voice-call";
import { VoiceCallPanel, voiceCallStatus } from "./voice-call-panel";

const active: ActiveVoiceCall = { target: { topicId: "topic-one", title: "项目讨论" }, state: "listening", startedAt: 1_000_000, muted: false, captionsEnabled: false, captions: [{ id: "user-one", role: "user", text: "先把今天的安排过一遍。", final: true }], minimized: false };
const handlers = () => ({ onHangup: vi.fn(), onToggleMute: vi.fn(), onRetry: vi.fn(), onOpenChat: vi.fn() });
const render = (patch: Partial<ActiveVoiceCall> = {}) => renderToStaticMarkup(<VoiceCallPanel call={{ ...active, ...patch }} {...handlers()} />);
const controlsIn = (html: string) => html.match(/<div class="kulo-voice-call-controls"[^>]*>([\s\S]*?)<\/div>/)?.[1];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_185_000); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("compact inline voice call panel", () => {
  it.each(["connecting", "listening", "speaking", "working", "reconnecting"] as const)("shows only the originating topic, timer, and controls during %s", (state) => {
    const html = render({ state, captionsEnabled: true });
    expect(html).toContain('role="region" aria-label="与Kulo的通话"');
    expect(html).toContain('aria-label="返回通话话题：项目讨论"');
    expect(html).toContain('class="kulo-voice-call-topic-title" title="项目讨论">项目讨论');
    expect(html).toContain('class="kulo-voice-call-duration" role="timer" aria-label="通话时长" aria-live="off">03:05');
    expect(html.match(/role="timer"/g)).toHaveLength(1);
    expect(html).not.toMatch(/role="dialog"|aria-modal|backdrop|kulo-marmot-avatar|<h[1-6]\b/);
    expect(html).not.toMatch(/正在聆听|正在回应|正在处理|字幕|先把今天的安排过一遍|收起通话|发消息|kulo-voice-call-mini/);
    if (state === "connecting" || state === "reconnecting") {
      expect(html).toContain(`role="status" aria-atomic="true">${state === "connecting" ? "正在连接" : "正在重连"}`);
    } else expect(html).not.toContain('role="status"');
    const controls = controlsIn(html);
    expect(controls).toBeDefined();
    expect(controls!.match(/<button\b/g)).toHaveLength(2);
    expect(controls).toContain('aria-label="静音麦克风"');
    expect(controls).toContain('aria-label="挂断通话"');
    expect(html.match(/<button\b/g)).toHaveLength(3);
  });

  it("uses named icon-only controls without hiding the originating topic title", () => {
    for (const patch of [{}, { minimized: true }, { state: "ended" as const }]) {
      const html = render(patch);
      expect(html).toContain('class="kulo-voice-call-topic-title" title="项目讨论">项目讨论');
      const buttons = [...controlsIn(html)!.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)];
      expect(buttons).toHaveLength(2);
      for (const [button, content] of buttons) {
        expect(button).toMatch(/aria-label="[^"]+"/);
        expect(content!.replace(/<[^>]*>/g, "").trim()).toBe("");
      }
    }
  });

  it("keeps mute on the neutral control and hides stored captions", () => {
    const html = render({ muted: true, captionsEnabled: true });
    const mute = html.match(/<button\b[^>]*aria-label="取消静音"[^>]*>/)?.[0];
    expect(mute).toContain('aria-pressed="true"');
    expect(mute).toContain("button--secondary");
    expect(mute).not.toContain("button--primary");
    expect(html).not.toMatch(/字幕|先把今天的安排过一遍|正在聆听|kulo-voice-call-captions/);
  });

  it("ignores the obsolete minimized view without restoring extra controls", () => {
    const html = render({ minimized: true, captionsEnabled: true });
    expect(html).toContain('class="kulo-voice-call"');
    expect(controlsIn(html)!.match(/<button\b/g)).toHaveLength(2);
    expect(html).not.toMatch(/返回与Kulo|收起通话|发消息|字幕|kulo-voice-call-mini/);
  });

  it("keeps failure and retry or close inside the compact panel", () => {
    const html = render({ minimized: true, state: "ended", error: "连接已断开", captionsEnabled: true });
    expect(html).toContain("通话已结束");
    expect(html).toContain('role="alert">连接已断开');
    expect(html).toContain('aria-label="重新通话"');
    expect(html).toContain('aria-label="关闭通话"');
    expect(controlsIn(html)!.match(/<button\b/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="挂断通话"');
    expect(html).not.toMatch(/role="dialog"|aria-modal|backdrop|字幕|先把今天的安排过一遍/);
  });

  it("does not claim an established duration before the call connects", () => {
    const html = render({ state: "connecting", startedAt: undefined });
    expect(html).toContain('aria-label="通话时长" aria-live="off">00:00');
    expect(voiceCallStatus({ state: "connecting", muted: true })).toBe("正在连接");
    expect(voiceCallStatus({ state: "reconnecting", muted: true })).toBe("正在重连");
    expect(renderToStaticMarkup(<VoiceCallPanel call={null} {...handlers()} />)).toBe("");
  });

  it("adds microphone recovery for permission failures and keeps retry available after granting access", () => {
    const html = render({ state: "ended", error: "麦克风访问未获允许", permissionRequired: "microphone" });
    expect(html).toContain('aria-label="检查麦克风权限"');
    expect(html).toContain('aria-label="关闭通话"');
    expect(html).toContain('aria-label="重新通话"');
    expect(render({ state: "ended", error: "连接中断" })).not.toContain('aria-label="检查麦克风权限"');
  });

  it("disables retry while recording or connection readiness prevents another call", () => {
    const blocked = renderToStaticMarkup(<VoiceCallPanel call={{ ...active, state: "ended" }} retryDisabled {...handlers()} />);
    const retry = blocked.match(/<button\b[^>]*aria-label="重新通话"[^>]*>/)?.[0];
    expect(retry).toContain('disabled=""');
    const available = render({ state: "ended" }).match(/<button\b[^>]*aria-label="重新通话"[^>]*>/)?.[0];
    expect(available).toBeDefined();
    expect(available).not.toContain('disabled=""');
    expect(blocked).toContain('aria-label="关闭通话"');
  });
});
