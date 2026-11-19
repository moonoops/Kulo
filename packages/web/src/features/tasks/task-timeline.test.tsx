import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatDisplayItem } from "@moco/protocol";
import { TaskTimeline } from "./task-timeline";
import { taskTimeline, toolActionSummary } from "./task-timeline-model";
import { taskPreviewDocument } from "./task-deliverables";

const call = (id: string, name = "bash") => ({ id, name, argsSummary: '{"command":"wc -c index.html"}' });
const message = (id: number, changes: Partial<ChatDisplayItem> = {}): ChatDisplayItem => ({ id, role: "assistant", text: "", ...changes });

describe("compact task timeline", () => {
  it("groups adjacent repeated calls without crossing a report or losing call IDs", () => {
    const entries = taskTimeline([
      message(1, { toolCalls: [call("a"), call("b")] }),
      message(2, { toolCalls: [call("c")] }),
      message(3, { text: "文件已保存" }),
      message(4, { toolCalls: [call("d")] }),
    ]);
    expect(entries.map(entry => entry.kind)).toEqual(["tools", "message", "tools"]);
    expect(entries[0]).toMatchObject({ calls: [{ call: { id: "a" } }, { call: { id: "b" } }, { call: { id: "c" } }] });
  });

  it("keeps attachments and thinking-only entries while dropping genuinely empty entries", () => {
    expect(taskTimeline([message(1), message(2, { thinking: "检查参数" }), message(3, { parts: [{ partId: "file", type: "file", assetId: "att_example" }] })])).toHaveLength(2);
  });

  it("shows an action summary and preserves an already truncated argument summary", () => {
    expect(toolActionSummary(call("a"))).toBe("wc -c index.html");
    expect(toolActionSummary({ ...call("a"), actionSummary: "index.html" })).toBe("index.html");
    expect(toolActionSummary({ ...call("a"), argsSummary: '{"command":"truncated...' })).toBe('{"command":"truncated...');
  });

  it("shows failure only for recorded errors and exposes arguments and output without chat bubbles or footers", () => {
    const html = renderToStaticMarkup(<TaskTimeline ticketId="t1" roleLabel="开发者" live={{ busy: false, activeTools: [], queuedCount: 0 }} transcript={[
      message(1, { role: "user", text: "生成 HTML 页面", createdAt: 1 }),
      message(2, { toolCalls: [call("pending", "read")] }),
      message(3, { toolCalls: [{ ...call("failed"), result: { text: "读取失败", isError: true } }] }),
    ]} />);
    expect(html).toContain("任务执行时间线");
    expect(html).toContain("任务要求");
    expect(html).toContain("wc -c index.html");
    expect(html).toContain("读取失败");
    expect(html).not.toContain("mc-user-message");
    expect(html).not.toContain("moco-message-footer");
    expect(html).not.toContain("已返回");
    expect(html).toContain("data-error=\"true\"");
  });

  it("isolates an HTML preview from network access while preserving inline interaction", () => {
    const doc = taskPreviewDocument('<html><button>测试</button><script>window.test=1</script></html>');
    expect(doc.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("script-src 'unsafe-inline'");
    expect(doc).toContain("<button>测试</button>");
  });
});
