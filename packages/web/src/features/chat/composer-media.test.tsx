import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { KuloComposer, type DraftAttachment } from "../../kulo-composer";
import { KULO_ICONS } from "../../kulo-icons";

const draft = (changes: Partial<DraftAttachment>): DraftAttachment => ({
  localId: "draft-one", name: "voice.webm", kind: "audio", size: 4096,
  mimeType: "audio/webm", status: "uploading", progress: 0, ...changes,
});
function renderComposer(attachments: DraftAttachment[], text = "保留的文字", connected = true, canQueueMessages = connected) {
  return renderToStaticMarkup(<KuloComposer draftText={text} onDraftTextChange={vi.fn()} attachments={attachments}
    onEnqueueFiles={vi.fn()} onRemoveAttachment={vi.fn()} onRetryAttachment={vi.fn()} onCancelAttachment={vi.fn()}
    onSubmit={vi.fn()} connected={connected} canQueueMessages={canQueueMessages} placeholder="输入消息" />);
}

function sendButton(html: string): string {
  return html.match(/<button\b[^>]*aria-label="发送"[^>]*>/)?.[0] ?? "";
}

describe("multimedia composer states", () => {
  it.each([{ text: "", isSendDisabled: false }, { text: "保留的草稿", isSendDisabled: true }])("shows only a filled stop square while waiting for the agent without busy send: %j", ({ text, isSendDisabled }) => {
    const html = renderToStaticMarkup(<KuloComposer draftText={text} onDraftTextChange={vi.fn()} attachments={[]}
      onEnqueueFiles={vi.fn()} onRemoveAttachment={vi.fn()} onSubmit={vi.fn()} onAbort={vi.fn()}
      busy connected isSendDisabled={isSendDisabled} placeholder="输入消息" />);
    const stop = html.match(/<button\b[^>]*aria-label="停止生成"[^>]*>([\s\S]*?)<\/button>/)?.[1];
    expect(stop).toContain(`d="${KULO_ICONS.stop}"`);
    expect(stop).toContain('fill="currentColor"');
    expect(stop).toContain('stroke="none"');
    expect(stop).not.toContain(`d="${KULO_ICONS.pause}"`);
    expect(html).not.toContain('aria-label="发送"');
  });

  it("keeps stop accessible alongside an enabled send button for busy interjections", () => {
    const html = renderToStaticMarkup(<KuloComposer draftText="插话追问" onDraftTextChange={vi.fn()} attachments={[]}
      onEnqueueFiles={vi.fn()} onRemoveAttachment={vi.fn()} onSubmit={vi.fn()} onAbort={vi.fn()}
      busy connected placeholder="输入消息" />);
    const stop = html.match(/<button\b[^>]*aria-label="停止生成"[^>]*>([\s\S]*?)<\/button>/);
    expect(stop?.[0]).toContain("kulo-composer-control");
    expect(stop?.[0]).not.toContain("disabled");
    expect(stop?.[1]).toContain(`d="${KULO_ICONS.stop}"`);
    expect(sendButton(html)).toContain("button--primary");
    expect(sendButton(html)).not.toContain("disabled");
  });

  it("allows offline text queueing only after durable storage is ready", () => {
    expect(sendButton(renderComposer([], "离线消息", false, true))).not.toContain("disabled");
    expect(sendButton(renderComposer([], "离线消息", false, false))).toContain("disabled");
    expect(sendButton(renderComposer([draft({ status: "error", error: "上传失败" })], "离线消息", false, true))).toContain("disabled");
  });
  it("offers explicit image, audio, video and file selection while keeping system inputs hidden", () => {
    const html = renderComposer([]);
    expect(html).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
    expect(html).toContain('accept="audio/*"');
    expect(html).toContain('accept="video/*"');
    expect((html.match(/type="file"/g) ?? [])).toHaveLength(4);
    expect(html).toContain('aria-label="语音输入"');
    expect(html).toContain('class="textarea');
  });
  it("does not enable sending when transfer reaches 100 percent but server processing is pending", () => {
    const html = renderComposer([draft({progress:100})]);
    expect(html).toContain("正在处理…");
    expect(sendButton(html)).toContain("disabled");
    expect(html).toContain('aria-label="取消上传 voice.webm"');
  });
  it("keeps failed files and text visible instead of silently omitting the attachment", () => {
    const html = renderComposer([draft({status:"error",error:"上传已取消"})]);
    expect(html).toContain("上传已取消");
    expect(html).toContain("保留的文字</textarea>");
    expect(html).toContain('aria-label="重试上传 voice.webm"');
    expect(html).toContain('aria-label="移除 voice.webm"');
    expect(sendButton(html)).toContain("disabled");
  });
  it("enables sending a server-confirmed attachment without requiring text", () => {
    const html = renderComposer([draft({status:"ready",progress:100,attachment:{id:"asset",name:"voice.webm",kind:"audio",size:4096,mimeType:"audio/webm",url:"/api/uploads/asset"}})], "");
    expect(sendButton(html)).not.toContain("disabled");
    expect(html).not.toContain("就绪");
  });
  it("renders image attachments as previewable tiles without ready-state text", () => {
    const html = renderComposer([draft({ kind: "image", name: "screenshot.png", mimeType: "image/png", status: "ready", previewUrl: "blob:https://kulo.test/preview", attachment: { id: "image", name: "screenshot.png", kind: "image", size: 4096, mimeType: "image/png", url: "/api/uploads/image" } })]);
    expect(html).toContain('data-kind="image"');
    expect(html).toContain('aria-label="预览 screenshot.png"');
    expect(html).toContain('aria-label="移除 screenshot.png"');
    expect(html).not.toContain("就绪");
    expect(html).toContain('aria-keyshortcuts=');
  });
});
