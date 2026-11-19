import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MocoComposer } from "../../moco-composer";

const voice = vi.hoisted(() => ({
  phase: "idle" as "idle" | "requesting" | "recording" | "transcribing" | "error",
  duration: 0,
  progress: undefined as number | undefined,
  levels: [] as number[],
  error: undefined as string | undefined,
  canRetry: false,
  start: vi.fn(), stop: vi.fn(), discard: vi.fn(), retry: vi.fn(),
}));

vi.mock("./voice-recorder", async (importOriginal) => ({
  ...await importOriginal<typeof import("./voice-recorder")>(),
  useVoiceRecorder: () => voice,
}));

function render(text = "已有文字草稿", busy = false) {
  return renderToStaticMarkup(<MocoComposer draftText={text} onDraftTextChange={vi.fn()} attachments={[]}
    onEnqueueFiles={vi.fn()} onRemoveAttachment={vi.fn()} onSubmit={vi.fn()} onAbort={vi.fn()} busy={busy}
    onTranscribeVoice={vi.fn()} connected placeholder="输入消息" />);
}

function button(html: string, label: string) {
  return html.match(new RegExp('<button\\b[^>]*aria-label="' + label + '"[^>]*>'))?.[0] ?? "";
}

describe("voice input", () => {
  beforeEach(() => Object.assign(voice, { phase: "idle", duration: 0, progress: undefined, levels: [], error: undefined, canRetry: false }));

  it("keeps the idle microphone beside the editable draft and send action", () => {
    const html = render();
    expect(button(html, "语音输入")).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).toContain("已有文字草稿</textarea>");
    expect(button(html, "发送")).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).not.toContain("moco-composer-waveform");
  });

  it("replaces the input row with the waveform, elapsed time, cancel and stop actions", () => {
    Object.assign(voice, { phase: "recording", duration: 13.6, levels: [0.1, 0.7, 0.3] });
    const html = render();
    expect(html).toContain('data-voice-active="true"');
    expect(html).toContain('class="moco-composer-waveform"');
    expect(html).toContain('role="timer" aria-live="off">00:13');
    expect(button(html, "停止录音并转写")).not.toContain("disabled");
    expect(button(html, "取消录音")).not.toContain("disabled");
    expect(html).not.toContain("<textarea");
    expect(button(html, "发送")).toBe("");
  });

  it("keeps the cancellation action while microphone permission is pending", () => {
    voice.phase = "requesting";
    const html = render();
    expect(button(html, "正在连接麦克风")).toContain('aria-disabled="true"');
    expect(button(html, "取消录音")).not.toContain("disabled");
    expect(html).toContain("连接中");
  });

  it("shows upload progress without offering a message send action", () => {
    Object.assign(voice, { phase: "transcribing", progress: 47 });
    const html = render();
    expect(html).toContain("上传中 47%");
    expect(button(html, "正在转写")).toContain('aria-disabled="true"');
    expect(button(html, "取消转写")).not.toContain("disabled");
    expect(button(html, "发送")).toBe("");
  });

  it("keeps transcription pending after upload reaches 100 percent", () => {
    Object.assign(voice, { phase: "transcribing", progress: 100 });
    const html = render();
    expect(html).toContain(">转写中</span>");
    expect(html).not.toContain("已发送");
    expect(html).not.toContain("正在发送语音");
  });

  it("keeps the draft editable and offers transcription recovery after failure", () => {
    Object.assign(voice, { phase: "error", error: "转写服务暂不可用", canRetry: true });
    const html = render();
    expect(html).toContain('role="alert">转写服务暂不可用');
    expect(html).toContain("重试转写");
    expect(button(html, "丢弃录音")).not.toContain("disabled");
    expect(html).toContain("已有文字草稿</textarea>");
    expect(button(html, "语音输入")).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).not.toContain('data-voice-active="true"');
  });

  it("uses the primary accent for the generation stop button", () => {
    const stop = button(render("", true), "停止生成");
    expect(stop).toContain("button--primary");
    expect(stop).not.toContain("button--danger");
  });
});
