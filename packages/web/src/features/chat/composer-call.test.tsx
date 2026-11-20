import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KuloComposer } from "../../kulo-composer";
import * as voiceContext from "../voice/voice-context";
import { KULO_ICONS } from "../../kulo-icons";
import type { ActiveVoiceCall } from "../voice/use-voice-call";

afterEach(() => vi.restoreAllMocks());

function render({ active = false, callState = "listening" as ActiveVoiceCall["state"], muted = false, recording = false, connected = true, loading = false, configured = true, needsModel = false, withTarget = true, text = "", allowVoice = true, busy = false, attachments = [] as import("../../kulo-composer").DraftAttachment[] } = {}) {
  vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue({
    recordingActive: recording, loading,
    snapshot: { call: { enabled: configured, hasCredential: configured } },
    call: { active, call: active ? { state: callState, muted } : null },
  } as voiceContext.VoiceWorkspace);
  return renderToStaticMarkup(<KuloComposer draftText={text} onDraftTextChange={vi.fn()} attachments={attachments}
    onEnqueueFiles={vi.fn()} onRemoveAttachment={vi.fn()} onSubmit={vi.fn()} onTranscribeVoice={vi.fn()}
    connected={connected} placeholder="输入消息" voiceCallTarget={withTarget ? { topicId: "design", title: "界面优化", projectId: "kulo" } : undefined}
    allowVoice={allowVoice} busy={busy} onAbort={vi.fn()} onOpenCall={vi.fn()} onConfigureVoice={vi.fn()} onConfigure={needsModel ? vi.fn() : undefined} />);
}

function button(html: string, label: string) {
  return html.match(new RegExp('<button\\b[^>]*aria-label="' + label + '"[^>]*>'))?.[0] ?? "";
}

describe("contextual composer calling", () => {
  it("uses the empty composer's last action for calling and keeps dictation separate", () => {
    const html = render();
    expect(button(html, "语音通话")).toContain("kulo-composer-control");
    expect(button(html, "语音通话")).not.toContain("disabled");
    expect(button(html, "语音输入")).not.toContain("disabled");
    expect(html).toContain('data-composer-action="call"');
    expect(html).not.toContain('aria-label="发送"');
    expect(html.match(/kulo-composer-call/g)).toHaveLength(1);
  });

  it("switches the shared action to send as soon as a draft exists", () => {
    const html = render({ text: "保留的草稿" });
    expect(html).toContain("保留的草稿</textarea>");
    expect(button(html, "发送")).not.toContain("disabled");
    expect(html).not.toContain("kulo-composer-call");
  });

  it("shows stop as the sole action while busy and empty, and shows send beside stop when a draft exists", () => {
    const emptyBusy = render({ text: "", busy: true, active: true });
    expect(button(emptyBusy, "停止生成")).not.toContain("disabled");
    expect(button(emptyBusy, "停止生成")).toContain("button--primary");
    expect(emptyBusy).not.toContain('aria-label="发送"');
    expect(emptyBusy).not.toContain("kulo-composer-call");

    const draftBusy = render({ text: "下一条草稿", busy: true, active: true });
    expect(button(draftBusy, "停止生成")).not.toContain("disabled");
    expect(button(draftBusy, "停止生成")).toContain("kulo-composer-control");
    expect(button(draftBusy, "发送")).not.toContain("disabled");
    expect(button(draftBusy, "发送")).toContain("button--primary");
    expect(draftBusy).not.toContain("kulo-composer-call");
    expect(draftBusy).toContain("下一条草稿</textarea>");
  });

  it("keeps upload and settings states from becoming call actions", () => {
    const uploading = render({ attachments: [{ localId: "upload", status: "uploading", name: "file.pdf", size: 10, kind: "file", mimeType: "application/pdf" }] });
    expect(button(uploading, "发送")).toContain("disabled");
    expect(uploading).not.toContain("kulo-composer-call");
    const settings = render({ allowVoice: false });
    expect(button(settings, "发送")).toContain("disabled");
    expect(settings).not.toContain("kulo-composer-call");
  });

  it("returns to the existing call even while offline or refreshing, while preventing dictation", () => {
    const html = render({ active: true, connected: false, loading: true });
    expect(button(html, "返回通话")).not.toContain("disabled");
    expect(button(html, "语音输入")).toContain("disabled");
    expect(button(html, "语音通话")).toBe("");
  });

  it.each(["listening", "speaking", "working"] as const)("replaces the idle waveform with the connected-call icon during %s", (callState) => {
    const html = render({ active: true, callState });
    expect(button(html, "返回通话")).not.toContain("disabled");
    expect(html).toContain(KULO_ICONS.phone);
    expect(html).not.toContain(KULO_ICONS.waveform);
    expect(html).toContain("badge--success");
  });

  it.each(["connecting", "reconnecting"] as const)("shows pending connection feedback while %s", (callState) => {
    const html = render({ active: true, callState });
    expect(html).toContain("spinner");
    expect(html).not.toContain(KULO_ICONS.waveform);
    expect(html).not.toContain("badge--success");
  });

  it("identifies a muted ongoing call without turning its return action into hangup", () => {
    const html = render({ active: true, muted: true });
    expect(button(html, "返回通话（已静音）")).not.toContain("disabled");
    expect(html).toContain("badge--warning");
    expect(html).not.toContain('aria-label="挂断通话"');
  });

  it.each([{ connected: false }, { loading: true }, { recording: true }])("blocks a new call when unavailable: %j", (state) => {
    expect(button(render(state), "语音通话")).toContain("disabled");
  });

  it("offers voice settings before a provider is configured", () => {
    expect(button(render({ configured: false }), "设置语音通话")).not.toContain("disabled");
  });

  it("keeps initial model setup available as a separate composer action", () => {
    const html = render({ needsModel: true });
    expect(html).toContain("连接模型");
    expect(html).not.toContain("kulo-composer-call");
    expect(html).not.toContain('aria-label="发送"');
  });

  it("omits the phone from composers without a topic call target", () => {
    expect(render({ withTarget: false })).not.toContain("kulo-composer-call");
  });
});
