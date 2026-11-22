import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TopicContextMenu, formatContextTokens } from "./topic-context-menu";
import { WorkbenchTitlebar } from "./workbench-titlebar";

describe("TopicContextMenu and WorkbenchTitlebar context entry", () => {
  it("formats token counts concisely across raw, k, and M scales", () => {
    expect(formatContextTokens(undefined)).toBe("");
    expect(formatContextTokens(650)).toBe("650");
    expect(formatContextTokens(12_400)).toBe("12.4k");
    expect(formatContextTokens(72_000)).toBe("72k");
    expect(formatContextTokens(128_400)).toBe("128k");
    expect(formatContextTokens(1_000_000)).toBe("1M");
  });

  it("renders on root master topic and ordinary persisted topics, while hiding on local draft topics", () => {
    const baseProps = {
      settingsMode: false,
      settingsModule: "models" as const,
      language: "zh-CN" as const,
      projectedTitle: "",
      onCloseProjection: () => {},
      activeTopicId: "root",
      activeTopicTitle: "与 Kulo 对话",
      activeTopic: { id: "root", conversationId: 1, title: "与 Kulo 对话", master: true, createdAt: 1, updatedAt: 1 },
      locatingMessage: false,
      envs: [],
      selectedTargetDeviceId: "auto",
      connected: true,
      liveBusy: false,
      liveContext: { tokens: 38_000, source: "usage" as const, window: 256_000, softLimit: 72_000, warnLimit: 108_000 },
      onSelectTargetDevice: () => {},
      onOpenConversationSearch: () => {},
      filesRevision: "1:1",
      isLocalTopic: false,
      onNavigateConversation: () => {},
      onPatchTopic: () => {},
      activeTopicTaskCount: 0,
      rightExpanded: false,
      onToggleRightPanel: () => {},
      previewSessions: [],
      onOpenPreviewModal: () => {},
    };

    const rootHtml = renderToStaticMarkup(<WorkbenchTitlebar {...baseProps} />);
    expect(rootHtml).toContain("上下文 约 38k · 整理阈值 72k");
    expect(rootHtml).not.toContain("话题操作");

    const draftHtml = renderToStaticMarkup(
      <WorkbenchTitlebar {...baseProps} activeTopicId="local:draft-1" isLocalTopic={true} />,
    );
    expect(draftHtml).not.toContain("整理阈值");
  });

  it("exposes warning/error states and omits token number when unknown", () => {
    const unknownHtml = renderToStaticMarkup(
      <TopicContextMenu
        topicId="root"
        isLocalTopic={false}
        connected={true}
        liveBusy={false}
        context={{ window: 128_000, softLimit: 72_000, warnLimit: 97_200 }}
      />,
    );
    expect(unknownHtml).toContain("上下文 未知 · 整理阈值 72k");

    const errorHtml = renderToStaticMarkup(
      <TopicContextMenu
        topicId="root"
        isLocalTopic={false}
        connected={true}
        liveBusy={false}
        context={{
          tokens: 100_000,
          source: "usage",
          window: 128_000,
          softLimit: 72_000,
          warnLimit: 97_200,
          compactionError: "摘要模型超时",
        }}
      />,
    );
    expect(errorHtml).toContain("上下文整理异常");
    expect(errorHtml).toContain("text-danger");
  });
});
