import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchivedTopicBar } from "./archived-topic-bar";
import { evaluateTopicConversationFrame } from "./root-rotation";
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
      selectedTargetDeviceId: "",
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

  it("marks every interactive WorkbenchTitlebar button as kulo-window-control across conversation and projected views", () => {
    const envs = [
      {
        id: "local",
        name: "Macmini.local",
        kind: "local" as const,
        online: true,
        platform: "darwin",
        arch: "arm64",
        rootDir: "/workspace",
        capabilities: ["fs", "bash"],
        connectedAt: 1,
        lastSeenAt: 1,
      },
      {
        id: "device-macbook",
        name: "MacBook Pro",
        kind: "reverse-ws" as const,
        online: true,
        platform: "darwin",
        arch: "arm64",
        rootDir: "/workspace",
        capabilities: ["fs", "bash"],
        connectedAt: 1,
        lastSeenAt: 1,
      },
    ];
    const previewSessions = [
      {
        id: "preview-1",
        ticketId: "T-1",
        envId: "local",
        deviceName: "Macmini.local",
        title: "浏览器检查",
        tool: "browser" as const,
      },
    ];
    const sharedProps = {
      settingsMode: false,
      settingsModule: "models" as const,
      language: "zh-CN" as const,
      projectedTitle: "",
      onCloseProjection: () => {},
      activeTopicId: "topic-1",
      activeTopicTitle: "跨设备排查",
      activeTopic: { id: "topic-1", conversationId: 2, title: "跨设备排查", master: false, createdAt: 1, updatedAt: 1 },
      locatingMessage: false,
      envs,
      selectedTargetDeviceId: "",
      connected: true,
      liveBusy: false,
      liveContext: { tokens: 12_000, source: "usage" as const, window: 256_000, softLimit: 72_000, warnLimit: 108_000 },
      onSelectTargetDevice: () => {},
      onOpenConversationSearch: () => {},
      filesRevision: "1:1",
      isLocalTopic: false,
      onNavigateConversation: () => {},
      onPatchTopic: () => {},
      activeTopicTaskCount: 2,
      rightExpanded: false,
      onToggleRightPanel: () => {},
      previewSessions,
      onOpenPreviewModal: () => {},
    };

    const conversationHtml = renderToStaticMarkup(<WorkbenchTitlebar {...sharedProps} />);
    const conversationButtons = conversationHtml.match(/<button\b[^>]*>/g) ?? [];
    // Target device, search, conversation files, topic context, topic actions, collapsed task count, live preview
    expect(conversationButtons).toHaveLength(7);
    expect(conversationHtml).toContain('aria-label="执行设备"');
    for (const button of conversationButtons) {
      expect(button).toMatch(/\bkulo-window-control\b/);
    }

    const projectedHtml = renderToStaticMarkup(
      <WorkbenchTitlebar
        {...sharedProps}
        projectedTicketId="T-1"
        projectedTitle="后台任务详情"
      />,
    );
    const projectedButtons = projectedHtml.match(/<button\b[^>]*>/g) ?? [];
    // Back to chat, live preview
    expect(projectedButtons).toHaveLength(2);
    for (const button of projectedButtons) {
      expect(button).toMatch(/\bkulo-window-control\b/);
    }
  });

  it("renders read-only ArchivedTopicBar with accessible restore action and evaluates conversation generation frames", () => {
    const barHtml = renderToStaticMarkup(
      <ArchivedTopicBar topicTitle="主对话归档 · 2026-11-23" connected={true} onRestore={() => {}} />,
    );
    expect(barHtml).toContain("此会话已归档，当前为只读");
    expect(barHtml).toContain('aria-label="还原“主对话归档 · 2026-11-23”"');
    expect(barHtml).toContain("还原会话");

    // Rejects stale old-root frame after rotation; accepts forward root rotation; accepts matching generation.
    expect(
      evaluateTopicConversationFrame({
        frameTopicId: "root",
        frameConversationId: 1,
        activeTopicId: "root",
        activeConversationId: 5,
        selectionVersion: 1,
        versionedSelections: true,
        changingTopic: false,
      }),
    ).toEqual({ accept: false });
    expect(
      evaluateTopicConversationFrame({
        frameTopicId: "root",
        frameConversationId: 5,
        activeTopicId: "root",
        activeConversationId: 1,
        selectionVersion: 1,
        versionedSelections: true,
        changingTopic: false,
      }),
    ).toEqual({ accept: true, rotatedTo: 5 });
    expect(
      evaluateTopicConversationFrame({
        frameTopicId: "root",
        frameConversationId: 5,
        activeTopicId: "root",
        activeConversationId: 5,
        selectionVersion: 1,
        versionedSelections: true,
        changingTopic: false,
      }),
    ).toEqual({ accept: true });
  });
});
