import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView, TicketCardView, TopicSummary } from "@moco/protocol";
import { describe, expect, it, vi } from "vitest";
import { TopicsSidebar } from "./topics-sidebar";

const { createPresses } = vi.hoisted(() => ({ createPresses: [] as Array<() => void> }));
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  return { ...actual, Button: (props: ComponentProps<typeof actual.Button>) => {
    if (typeof props.className === "string" && props.className.includes("moco-navigation-create")) createPresses.push(() => props.onPress?.({} as never));
    return <actual.Button {...props} />;
  } };
});

vi.mock("./agent-terminal", () => ({ AgentTerminal: () => null }));
vi.mock("./conversation-model-settings", () => ({ ConversationModelSettings: () => null }));
vi.mock("../projects/projects-sidebar", () => ({ ProjectsSidebar: () => null }));
vi.mock("../voice/voice-context", () => ({ useVoiceWorkspace: () => null }));

function topic(id: string, patch: Partial<TopicSummary> = {}): TopicSummary {
  return { id, title: id, conversationId: 1, createdAt: 1, updatedAt: 1, ...patch };
}

function renderSidebar(topics: TopicSummary[], patch: Partial<ComponentProps<typeof TopicsSidebar>> = {}) {
  const props: ComponentProps<typeof TopicsSidebar> = {
    agentName: "Moco", connected: false, terminalEntries: [],
    onAgentClick: vi.fn(), settingsMode: false,
    settingsModule: "appearance", onSelectSettingsModule: vi.fn(),
    onEnterSettings: vi.fn(), onExitSettings: vi.fn(), topics, projects: [],
    onProjectsChange: vi.fn(), onTopicsChange: vi.fn(), activeTopicId: "recent",
    tickets: [], envs: [], settings: null, showProcess: false,
    onShowProcessChange: vi.fn(), onSettingsUpdated: vi.fn(),
    onCreateTopic: vi.fn(async () => {}), onSelectTopic: vi.fn(),
    onPatchTopic: vi.fn(async () => {}), onDeleteTopic: vi.fn(async () => {}),
    searchFocusRequest: 0, searchQuery: "",
    onSearchQueryChange: vi.fn(), messagesCount: 0, ...patch,
  };
  createPresses.length = 0;
  return renderToStaticMarkup(<TopicsSidebar {...props} />);
}

function renderList(topics: TopicSummary[], patch: Partial<ComponentProps<typeof TopicsSidebar>> = {}) {
  const html = renderSidebar(topics, patch);
  const nav = html.match(/<nav\b[^>]*aria-label="话题列表"[^>]*>([\s\S]*?)<\/nav>/);
  expect(nav).not.toBeNull();
  return nav![1]!;
}

function ids(html: string) {
  return Array.from(html.matchAll(/data-topic-id="([^"]+)"/g), (match) => match[1]);
}

describe("flat topic navigation", () => {
  it("passes scoped failures and cleanup decisions to the shared conversation status", () => {
    const ticket: TicketCardView = { id: "failed", title: "检查", role: "developer", roleLabel: "开发", status: "failed", envId: "local", workspaceDir: "/tmp", originTopicId: "recent", createdAt: 1, updatedAt: 1 };
    const html = renderList([topic("recent")], { tickets: [ticket, { ...ticket, id: "cleanup", status: "stopped", cleanupPending: true }, { ...ticket, id: "other", originTopicId: "other" }] });
    expect(html).toContain('aria-label="1 项执行失败，1 项待处理"');
    expect(html).toContain('data-notice="failed"');
    expect(html).toContain("moco-topic-failure");
    expect(html).not.toContain("moco-topic-attention");
  });
  it("shows pinned, recent and older conversations directly without collapsible groups", () => {
    const html = renderList([
      topic("recent", { updatedAt: Date.now() }),
      topic("older"),
      topic("pinned-one", { pinned: true }),
      topic("pinned-two", { pinned: true }),
    ]);
    expect(ids(html)).toEqual(["pinned-one", "pinned-two", "recent", "older"]);
    expect(html).not.toMatch(/<h[1-6]\b/);
    for (const group of ["今天", "更早", "置顶"]) expect(html).not.toContain(`>${group}<`);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="older操作"');
  });

  it("keeps search, archive and project boundaries when rendering a flat list", () => {
    const html = renderList([
      topic("recent", { title: "设备检查" }),
      topic("other", { title: "写作讨论" }),
      topic("archived", { title: "设备归档", archived: true }),
      topic("project", { title: "设备项目", projectId: "project-1" }),
      topic("deleted", { title: "设备删除", deletedAt: 1 }),
    ], { searchQuery: "设备" });
    expect(ids(html)).toEqual(["recent"]);
    expect(html).not.toContain("已归档");
    expect(html).not.toContain("返回活跃话题");
  });

  it("keeps an empty active list when every ordinary topic is archived", () => {
    const html = renderList([topic("archived", { archived: true })]);
    expect(ids(html)).toEqual([]);
    expect(html).toContain("暂无话题");
    expect(html).not.toContain("已归档");
  });

  it("never mixes the persistent main chat into ordinary topics, including search", () => {
    const topics = [topic("root", { title: "Moco", master: true, pinned: true }), topic("recent", { title: "Moco 界面优化" })];
    expect(ids(renderList(topics))).toEqual(["recent"]);
    expect(ids(renderList(topics, { searchQuery: "Moco" }))).toEqual(["recent"]);
    expect(renderList([topics[0]!])).toContain("暂无话题");
  });

  it("keeps empty and no-match feedback at the shared body size", () => {
    for (const [html, message] of [
      [renderList([]), "暂无话题"],
      [renderList([topic("recent")], { searchQuery: "不存在" }), "没有匹配的话题"],
    ]) {
      expect(html).toMatch(new RegExp(`<p class="[^"]*\\btext-sm\\b[^"]*">${message}</p>`));
    }
  });

  it("keeps one unfilled create action and a compact search trigger above settings", () => {
    const html = renderSidebar([], { connected: true });
    const footer = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1];
    expect(footer).toBeDefined();
    const actions = Array.from(footer!.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g))
      .filter((button) => button[1]!.includes("moco-navigation-create"));
    expect(actions).toHaveLength(1);
    expect(actions[0]![1]).toContain("button--ghost");
    expect(actions[0]![1]).not.toContain('disabled=""');
    expect(footer!.indexOf("新建话题")).toBeLessThan(footer!.indexOf("设置"));
    expect(footer).toContain('aria-label="搜索话题"');
    expect(footer).not.toContain("新建项目");
    expect(html).not.toContain("search-field__input");
    expect(html.slice(0, html.indexOf("<footer"))).not.toContain("moco-navigation-create");
  });

  it("starts ordinary topics from the Topics tab and clears the topic filter", () => {
    const onCreateTopic = vi.fn(async () => {});
    const onSearchQueryChange = vi.fn();
    renderSidebar([], { connected: true, onCreateTopic, onSearchQueryChange, searchQuery: "旧话题" });
    expect(createPresses).toHaveLength(1);
    createPresses[0]!();
    expect(onCreateTopic).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(onSearchQueryChange).toHaveBeenCalledExactlyOnceWith("");
  });

  it("creates in the active project instead of falling back to an ordinary topic", () => {
    const project: ProjectView = { id: "project-1", name: "界面优化", deviceId: "local", deviceName: "本机", workspaceDir: "/projects/ui", directoryId: "directory-1", revision: 1, grantRevision: 1, notes: "", createdAt: 1, updatedAt: 1, availability: "ready" };
    const onCreateTopic = vi.fn(async () => {});
    const html = renderSidebar([topic("project-topic", { projectId: project.id })], { projects: [project], activeTopicId: "project-topic", connected: true, onCreateTopic });
    expect(html).toContain('aria-label="在 界面优化 新建话题"');
    expect(html).toContain('aria-label="搜索项目和会话"');
    createPresses[0]!();
    expect(onCreateTopic).toHaveBeenCalledExactlyOnceWith(project.id);
  });

  it("disables creation when offline or the Projects tab has no valid project", () => {
    const onCreateTopic = vi.fn(async () => {});
    for (const patch of [
      { connected: false },
      { connected: true, projectNavigation: { projectId: "missing", sequence: 1 } },
    ]) {
      const html = renderSidebar([], { ...patch, onCreateTopic });
      const action = html.match(/<button\b[^>]*class="[^"]*moco-navigation-create[^>]*>/)?.[0];
      expect(action).toContain('disabled=""');
      createPresses[0]!();
    }
    expect(onCreateTopic).not.toHaveBeenCalled();
  });
});
