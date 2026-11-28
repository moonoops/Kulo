import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveStreamState, ToolActionMeta } from "@kulo/protocol";
import { setLanguage } from "../../kulo-i18n";
import { resolveLiveWaitStatus, resolveToolActionLabel } from "./live-status";
import {
  ChatToolStepList,
  groupChatToolSteps,
  isFoldableReadStep,
  type ChatToolCallItem,
} from "./tool-step-list";

function step(
  id: string,
  name: string,
  actionMeta?: ToolActionMeta,
): ChatToolCallItem {
  return {
    id,
    name,
    argsSummary: "{}",
    ...(actionMeta ? { actionMeta } : {}),
  };
}

afterEach(() => setLanguage("zh-CN"));

describe("ChatToolStepList grouping and rendering", () => {
  it("folds adjacent successful read-only steps into one summary row and expands all 1:1 details in place", () => {
    const calls = [
      step("c1", "web_search", { category: "read", labelKey: "web_search", targetLabel: "Kulo docs", status: "ok" }),
      step("c2", "web_fetch", { category: "read", labelKey: "web_fetch", targetLabel: "docs.example.com", status: "ok" }),
      step("c3", "read", { category: "read", labelKey: "read", targetLabel: "README.md", status: "ok" }),
    ];

    const segments = groupChatToolSteps(calls);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "read_group", id: "read-group:c1" });
    expect(segments[0]?.kind === "read_group" ? segments[0].steps.map((s) => s.id) : []).toEqual(["c1", "c2", "c3"]);

    const collapsedHtml = renderToStaticMarkup(<ChatToolStepList toolCalls={calls} language="zh-CN" />);
    expect(collapsedHtml).toContain("已查阅 3 项资料");
    expect(collapsedHtml).toContain('aria-expanded="false"');
    expect(collapsedHtml).toContain('data-call-id="c1"');
    expect(collapsedHtml).toContain('data-call-id="c2"');
    expect(collapsedHtml).toContain('data-call-id="c3"');

    const expandedHtml = renderToStaticMarkup(
      <ChatToolStepList
        toolCalls={calls}
        language="zh-CN"
        defaultExpandedGroupIds={["read-group:c1"]}
      />,
    );
    expect(expandedHtml).toContain('aria-expanded="true"');
    expect(expandedHtml).toContain("搜索网页");
    expect(expandedHtml).toContain("读取网页");
    expect(expandedHtml).toContain("读取文件");
    expect(expandedHtml).toContain("docs.example.com");
    expect(expandedHtml).toContain("README.md");
  });

  it("never folds write, confirm, awaiting_confirm, error, other, or unannotated steps", () => {
    const calls = [
      step("r1", "read", { category: "read", labelKey: "read", targetLabel: "a.ts", status: "ok" }),
      step("r2", "web_fetch", { category: "read", labelKey: "web_fetch", targetLabel: "example.com", status: "ok" }),
      step("w1", "bash", { category: "write", labelKey: "bash", status: "ok" }),
      step("w2", "edit", { category: "write", labelKey: "edit", targetLabel: "a.ts", status: "ok" }),
      step("k1", "kulo_lark_bridge", { category: "confirm", labelKey: "lark_propose_reply", status: "awaiting_confirm" }),
      step("e1", "web_fetch", {
        category: "read",
        labelKey: "web_fetch",
        targetLabel: "broken.example.com",
        status: "error",
        errorBrief: "HTTP 503 Service Unavailable",
      }),
      step("r3", "kulo_lark_bridge", { category: "read", labelKey: "lark_read_chat", targetLabel: "work", status: "ok" }),
      step("r4", "kulo_browser", { category: "read", labelKey: "browser_observe", status: "ok" }),
      step("o1", "kulo_host_action", { category: "other", labelKey: "kulo_host_action_inspect", status: "ok" }),
      step("u1", "legacy_tool"),
    ];

    expect(isFoldableReadStep(calls[2]!)).toBe(false);
    expect(isFoldableReadStep(calls[4]!)).toBe(false);
    expect(isFoldableReadStep(calls[5]!)).toBe(false);
    expect(isFoldableReadStep(calls[8]!)).toBe(false);
    expect(isFoldableReadStep(calls[9]!)).toBe(false);

    const segments = groupChatToolSteps(calls);
    expect(segments.map((seg) => [seg.kind, seg.id])).toEqual([
      ["read_group", "read-group:r1"],
      ["step", "w1"],
      ["step", "w2"],
      ["step", "k1"],
      ["step", "e1"],
      ["read_group", "read-group:r3"],
      ["step", "o1"],
      ["step", "u1"],
    ]);

    const html = renderToStaticMarkup(<ChatToolStepList toolCalls={calls} language="zh-CN" />);
    expect(html).toContain("已查阅 2 项资料");
    expect(html).toContain("执行命令");
    expect(html).toContain("编辑文件");
    expect(html).toContain("草拟飞书回复");
    expect(html).toContain("待确认");
    expect(html).toContain("失败");
    expect(html).toContain("HTTP 503 Service Unavailable");
    expect(html).toContain("诊断本机状态");
  });

  it("keeps live status and historical step labels bilingual and consistent across zh-CN and en", () => {
    const samples: Array<{ name: string; meta: ToolActionMeta }> = [
      { name: "web_search", meta: { category: "read", labelKey: "web_search", targetLabel: "Kulo", status: "ok" } },
      { name: "kulo_lark_bridge", meta: { category: "read", labelKey: "lark_read_chat", targetLabel: "work", status: "ok" } },
      { name: "kulo_browser", meta: { category: "write", labelKey: "browser_interact", targetLabel: "example.com", status: "ok" } },
      { name: "bash", meta: { category: "write", labelKey: "bash", status: "error", errorBrief: "Exit code 1" } },
    ];

    for (const lang of ["zh-CN", "en"] as const) {
      for (const sample of samples) {
        const liveState: LiveStreamState = {
          busy: true,
          activeTools: [{ callId: "live", name: sample.name, actionMeta: { ...sample.meta, status: "running" } }],
          queuedCount: 0,
        };
        const liveLabel = resolveLiveWaitStatus(liveState, { showProcess: false, language: lang }).label;
        const expectedRunning = `${resolveToolActionLabel({ name: sample.name, actionMeta: sample.meta, running: true, language: lang })}…`;
        expect(liveLabel).toBe(expectedRunning);
      }
    }

    const calls = [
      step("c1", "read", { category: "read", labelKey: "read", targetLabel: "app.ts", status: "ok" }),
      step("c2", "kulo_memory_recall", { category: "read", labelKey: "memory_recall", status: "ok" }),
      step("c3", "kulo_lark_bridge", { category: "confirm", labelKey: "lark_propose_reply", status: "awaiting_confirm" }),
    ];

    setLanguage("en");
    const enHtml = renderToStaticMarkup(<ChatToolStepList toolCalls={calls} />);
    expect(enHtml).toContain("Checked 2 sources");
    expect(enHtml).toContain("Drafted Feishu reply");
    expect(enHtml).toContain("Awaiting confirmation");

    setLanguage("zh-CN");
    const zhHtml = renderToStaticMarkup(<ChatToolStepList toolCalls={calls} />);
    expect(zhHtml).toContain("已查阅 2 项资料");
    expect(zhHtml).toContain("草拟飞书回复");
    expect(zhHtml).toContain("待确认");
  });

  it("prevents flicker and preserves original call order during out-of-order parallel returns", () => {
    const activeAll = new Set(["c1", "c2", "c3"]);
    // Frame 1: all 3 parallel reads are running.
    const frame1 = groupChatToolSteps(
      [
        step("c1", "web_search", { category: "read", labelKey: "web_search", status: "running" }),
        step("c2", "web_fetch", { category: "read", labelKey: "web_fetch", status: "running" }),
        step("c3", "read", { category: "read", labelKey: "read", status: "running" }),
      ],
      { activeToolIds: activeAll, liveBusy: true },
    );
    expect(frame1.map((seg) => [seg.kind, seg.id])).toEqual([
      ["step", "c1"],
      ["step", "c2"],
      ["step", "c3"],
    ]);

    // Frame 2: c3 returns first (out of order).
    const frame2 = groupChatToolSteps(
      [
        step("c1", "web_search", { category: "read", labelKey: "web_search", status: "running" }),
        step("c2", "web_fetch", { category: "read", labelKey: "web_fetch", status: "running" }),
        step("c3", "read", { category: "read", labelKey: "read", status: "ok" }),
      ],
      { activeToolIds: new Set(["c1", "c2"]), liveBusy: true },
    );
    expect(frame2.map((seg) => [seg.kind, seg.id])).toEqual([
      ["step", "c1"],
      ["step", "c2"],
      ["step", "c3"],
    ]);

    // Frame 3: c2 returns second (still waiting on c1) — must NOT flicker into read-group:c2 then remount as read-group:c1!
    const frame3 = groupChatToolSteps(
      [
        step("c1", "web_search", { category: "read", labelKey: "web_search", status: "running" }),
        step("c2", "web_fetch", { category: "read", labelKey: "web_fetch", status: "ok" }),
        step("c3", "read", { category: "read", labelKey: "read", status: "ok" }),
      ],
      { activeToolIds: new Set(["c1"]), liveBusy: true },
    );
    expect(frame3.map((seg) => [seg.kind, seg.id])).toEqual([
      ["step", "c1"],
      ["step", "c2"],
      ["step", "c3"],
    ]);

    // Frame 4: c1 finishes last -> collapses cleanly once into read-group:c1 in original order [c1, c2, c3].
    const frame4 = groupChatToolSteps(
      [
        step("c1", "web_search", { category: "read", labelKey: "web_search", status: "ok" }),
        step("c2", "web_fetch", { category: "read", labelKey: "web_fetch", status: "ok" }),
        step("c3", "read", { category: "read", labelKey: "read", status: "ok" }),
      ],
      { activeToolIds: new Set(), liveBusy: true },
    );
    expect(frame4.map((seg) => [seg.kind, seg.id])).toEqual([["read_group", "read-group:c1"]]);
    expect(frame4[0]?.kind === "read_group" ? frame4[0].steps.map((s) => s.id) : []).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps errored read steps uncollapsed even inside a parallel read batch", () => {
    const settled = groupChatToolSteps(
      [
        step("c1", "web_search", { category: "read", labelKey: "web_search", status: "ok" }),
        step("c2", "web_fetch", { category: "read", labelKey: "web_fetch", status: "error", errorBrief: "Timeout" }),
        step("c3", "read", { category: "read", labelKey: "read", status: "ok" }),
      ],
      { activeToolIds: new Set(), liveBusy: true },
    );
    expect(settled.map((seg) => [seg.kind, seg.id])).toEqual([
      ["step", "c1"],
      ["step", "c2"],
      ["step", "c3"],
    ]);
  });
});
