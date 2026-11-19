import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveVoiceCall } from "./use-voice-call";
import * as voiceContext from "./voice-context";
import { VoiceCallErrorAlert, VoiceCallErrorBanner } from "./voice-call-error-banner";

const baseCall: ActiveVoiceCall = {
  target: { topicId: "root", title: "与 Kulo 对话" },
  state: "ended",
  muted: false,
  captionsEnabled: false,
  captions: [],
  minimized: false,
  error: "无法初始化语音采集模块，请刷新页面后重试",
};

afterEach(() => vi.restoreAllMocks());

describe("VoiceCallErrorBanner", () => {
  it("renders a danger Alert in the main workspace for startup failures and mid-call interruptions", () => {
    const startup = renderToStaticMarkup(
      <VoiceCallErrorAlert call={baseCall} onRetry={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(startup).toContain('role="alert"');
    expect(startup).toContain("alert--danger");
    expect(startup).toContain("无法开始语音通话");
    expect(startup).toContain("无法初始化语音采集模块，请刷新页面后重试");
    expect(startup).toContain("scrollbar");
    expect(startup).toContain("max-h-24");
    expect(startup).toContain("overflow-y-auto");
    expect(startup).toContain("重新通话");
    expect(startup).toContain("关闭");
    expect(startup).not.toContain("检查权限");

    const interrupted = renderToStaticMarkup(
      <VoiceCallErrorAlert call={{ ...baseCall, startedAt: 1_000_000, error: "通话连接已断开" }} onRetry={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(interrupted).toContain("语音通话已中断");
    expect(interrupted).toContain("通话连接已断开");
  });

  it("shows microphone permission recovery only for microphone permission failures", () => {
    const html = renderToStaticMarkup(
      <VoiceCallErrorAlert
        call={{ ...baseCall, error: "麦克风访问未获允许", permissionRequired: "microphone" }}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(html).toContain("检查权限");
    expect(html).toContain("重新通话");
    expect(html).toContain("关闭");
  });

  it("stays empty when there is no failed call", () => {
    expect(renderToStaticMarkup(<VoiceCallErrorAlert call={null} onRetry={vi.fn()} onDismiss={vi.fn()} />)).toBe("");
    expect(renderToStaticMarkup(<VoiceCallErrorAlert call={{ ...baseCall, state: "listening" }} onRetry={vi.fn()} onDismiss={vi.fn()} />)).toBe("");
    expect(renderToStaticMarkup(<VoiceCallErrorAlert call={{ ...baseCall, error: undefined }} onRetry={vi.fn()} onDismiss={vi.fn()} />)).toBe("");
  });

  it.each([
    { connected: false, loading: false, recordingActive: false, expectedDisabled: true },
    { connected: true, loading: true, recordingActive: false, expectedDisabled: true },
    { connected: true, loading: false, recordingActive: true, expectedDisabled: true },
    { connected: true, loading: false, recordingActive: false, expectedDisabled: false },
  ])("disables retry when connected=$connected loading=$loading recording=$recordingActive", ({ connected, loading, recordingActive, expectedDisabled }) => {
    const workspace = {
      loading,
      recordingActive,
      call: {
        call: baseCall,
        start: vi.fn(),
        hangup: vi.fn(),
      },
    } as unknown as voiceContext.VoiceWorkspace;
    vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue(workspace);
    const html = renderToStaticMarkup(<VoiceCallErrorBanner connected={connected} />);
    const retry = html.match(/<button\b[^>]*>重新通话<\/button>/)?.[0];
    expect(retry).toBeDefined();
    expect(retry!.includes('disabled=""')).toBe(expectedDisabled);
  });
});
