import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { VoiceCallSummaryView } from "@kulo/protocol";
import { setLanguage } from "../../kulo-i18n";
import {
  VoiceCallSummaryCard,
  formatVoiceCallSummaryDuration,
  formatVoiceCallSummaryHeadline,
} from "./voice-call-summary-card";

const baseSummary: VoiceCallSummaryView = {
  callId: "call_demo_001",
  durationMs: 192_000,
  turnCount: 6,
  delegatedTicketIds: [],
  turns: [
    { id: "u-1", role: "user", text: "帮我看一下项目进度" },
    { id: "a-1", role: "assistant", text: "好的，目前两项任务都已完成。" },
    { id: "u-2", role: "user", text: "另外把那份", incomplete: true },
  ],
};

afterEach(() => {
  setLanguage("zh-CN");
});

describe("VoiceCallSummaryCard", () => {
  it("formats compact single-line summaries in Chinese and English", () => {
    setLanguage("zh-CN");
    expect(formatVoiceCallSummaryDuration(0)).toBe("0秒");
    expect(formatVoiceCallSummaryDuration(45_000)).toBe("45秒");
    expect(formatVoiceCallSummaryDuration(120_000)).toBe("2分");
    expect(formatVoiceCallSummaryDuration(192_000)).toBe("3分12秒");
    expect(formatVoiceCallSummaryHeadline(baseSummary)).toBe("语音通话 · 3分12秒 · 6 句交流");
    expect(
      formatVoiceCallSummaryHeadline({ ...baseSummary, delegatedTicketIds: ["T-1", "T-2"] }),
    ).toBe("语音通话 · 3分12秒 · 6 句交流 · 2 项任务");

    setLanguage("en");
    expect(formatVoiceCallSummaryHeadline(baseSummary)).toBe("Voice call · 3m 12s · 6 turns");
    expect(
      formatVoiceCallSummaryHeadline({ ...baseSummary, turnCount: 1, delegatedTicketIds: ["T-1"] }),
    ).toBe("Voice call · 3m 12s · 1 turn · 1 task");
  });

  it("renders collapsed HeroUI Disclosure by default without extraneous prose", () => {
    const html = renderToStaticMarkup(
      <VoiceCallSummaryCard summary={baseSummary} topicId="root" agentName="Kulo" />,
    );
    expect(html).toContain('data-voice-call-id="call_demo_001"');
    expect(html).toContain("语音通话 · 3分12秒 · 6 句交流");
    expect(html).toContain('aria-expanded="false"');
  });

  it("renders expanded redacted turns, incomplete badge, and delegated ticket chips", () => {
    const html = renderToStaticMarkup(
      <VoiceCallSummaryCard
        summary={{ ...baseSummary, turnCount: 3, delegatedTicketIds: ["ticket-a1", "ticket-b2"] }}
        topicId="root"
        agentName="Kulo"
        defaultExpanded
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("帮我看一下项目进度");
    expect(html).toContain("好的，目前两项任务都已完成。");
    expect(html).toContain("另外把那份");
    expect(html).toContain("未说完");
    expect(html).toContain("ticket-a1");
    expect(html).toContain("ticket-b2");
    expect(html).toContain("kulo-voice-summary-turns scrollbar");
  });
});
