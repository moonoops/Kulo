import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { Disclosure, Dropdown } from "@heroui/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectView, TicketCardView, TopicSummary } from "@moco/protocol";
import { ProjectsSidebar } from "./projects-sidebar";
import { TopicRow } from "../topics/topic-row";
import { MocoTaskProjection, TaskStatus } from "../../moco-tasks";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const project: ProjectView = {
  id: "project-1", name: "Moco", deviceId: "remote", deviceName: "工作站", workspaceDir: "/projects/Moco", directoryId: "directory-1", revision: 1, grantRevision: 1,
  notes: "", createdAt: 1, updatedAt: 1, availability: "offline",
};

const projectTopic: TopicSummary = { id: "conversation", title: "项目讨论", projectId: project.id, conversationId: 2, createdAt: 1, updatedAt: 1 };

function sidebar(projects = [project], topics = [projectTopic], patch: Partial<ComponentProps<typeof ProjectsSidebar>> = {}) {
  return renderToStaticMarkup(<ProjectsSidebar projects={projects} topics={topics}
    creating={false} onCreatingChange={() => {}} selectedProjectId={projects[0]?.id} onSelectedProjectChange={() => {}} query="" onQueryChange={() => {}}
    tickets={[]} envs={[]} connected={false} activeTopicId="conversation" onCreateTopic={async () => {}} onSelectTopic={() => {}}
    onPatchTopic={async () => {}} onRequestDeleteTopic={() => {}} onProjectsChange={() => {}} onTopicsChange={() => {}} onManageDevices={() => {}} {...patch} />);
}

describe("project navigation accessibility", () => {
  it("keeps empty and no-match project feedback at the shared body size", () => {
    for (const [html, message] of [
      [sidebar([], []), "暂无项目"],
      [sidebar([project], [projectTopic], { query: "不存在" }), "没有匹配的项目"],
    ]) {
      expect(html).toMatch(new RegExp(`<div class="[^"]*\\btext-sm\\b[^"]*">[^]*?<span>${message}</span></div>`));
    }
  });

  it("uses the same scoped failure and cleanup priority as ordinary conversations", () => {
    const ticket: TicketCardView = { id: "failed", title: "检查", role: "developer", roleLabel: "开发", status: "failed", envId: "remote", workspaceDir: project.workspaceDir, originTopicId: projectTopic.id, projectId: project.id, createdAt: 1, updatedAt: 1 };
    const html = sidebar([project], [projectTopic], { tickets: [ticket, { ...ticket, id: "cleanup", status: "stopped", cleanupPending: true }, { ...ticket, id: "other", originTopicId: "other" }] });
    expect(html).toContain('aria-label="1 项执行失败，1 项待处理"');
    expect(html).toContain('data-notice="failed"');
    expect(html).toContain("moco-topic-failure");
    expect(html).not.toContain("moco-topic-attention");
  });
  it("keeps unavailable projects and their history visible without claiming a local device", () => {
    const html = sidebar();
    expect(html).toContain("Moco");
    expect(html).toContain("工作站");
    expect(html).toContain("项目讨论");
    expect(html).toContain("离线");
    expect(html).not.toContain("（本机）");
    expect(html).not.toContain("移动会话");
    expect(html).not.toContain("恢复项目");
  });

  it("renders project disclosure and actions without nested buttons or duplicate IDs", () => {
    const html = sidebar();
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g) ?? []) expect(button.match(/<button\b/g)).toHaveLength(1);
    const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).toContain('aria-label="选择项目设备"');
    expect(html).not.toContain("search-field__input");
  });

  it("keeps search out of the list and exposes the selected project and independent conversation controls", () => {
    const html = sidebar();
    expect(html).not.toContain("search-field__input");
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain("autofocus");
    expect(html).toContain('aria-label="在 Moco 新建会话"');
    expect(html).toContain('aria-label="项目讨论"');
    expect(html).toContain('aria-label="项目讨论操作"');
  });

  it("selects the clicked project header as the contextual creation target", () => {
    const triggers: Array<() => void> = [];
    const OriginalTrigger = Disclosure.Trigger;
    vi.spyOn(Disclosure, "Trigger").mockImplementation((props) => {
      triggers.push(() => props.onPress?.({} as never));
      return <OriginalTrigger {...props} />;
    });
    const other = { ...project, id: "project-2", name: "第二个项目" };
    const onSelectedProjectChange = vi.fn();
    sidebar([project, other], [projectTopic], { onSelectedProjectChange });
    expect(triggers).toHaveLength(2);
    triggers[1]!();
    expect(onSelectedProjectChange).toHaveBeenCalledExactlyOnceWith(other.id);
  });

  it("opens project creation from the device menu without changing device selection", () => {
    vi.spyOn(Dropdown, "Popover").mockImplementation(({ children }) => <>{children}</>);
    const menuActions: Array<(key: string) => void> = [];
    const OriginalMenu = Dropdown.Menu;
    vi.spyOn(Dropdown, "Menu").mockImplementation((props) => {
      if (props["aria-label"] === "项目设备" && props.onAction) menuActions.push((key) => props.onAction?.(key, {}));
      return <OriginalMenu {...props} />;
    });
    const onCreatingChange = vi.fn();
    const onSelectedProjectChange = vi.fn();
    const html = sidebar([project], [projectTopic], { connected: true, onCreatingChange, onSelectedProjectChange });
    expect(html).toContain("新建项目");
    expect(menuActions).toHaveLength(1);
    menuActions[0]!("create");
    expect(onCreatingChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(onSelectedProjectChange).not.toHaveBeenCalled();
  });

  it("keeps the project conversation title and independent actions without timestamps", () => {
    const title = "很长的项目会话名称与清晰的完整标题";
    const html = renderToStaticMarkup(<TopicRow layout="project" topic={{ ...projectTopic, title }} selected attentionCount={1}
      onSelect={() => {}} onPatch={() => {}} onRequestDelete={() => {}} />);
    expect(html).toContain(`title="${title}"`);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("<time");
    expect(html).toContain(`aria-label="${title}操作"`);
  });

  it("groups all-device projects by their named device", () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => key.endsWith(":device") ? '"*"' : null });
    const other = { ...project, id: "project-2", deviceId: "laptop", deviceName: "笔记本", name: "第二个项目", availability: "ready" as const };
    const html = sidebar([project, other]);
    expect(html).toContain('aria-label="工作站的项目"');
    expect(html).toContain('aria-label="笔记本的项目"');
    expect(html).toContain("全部设备");
    expect(html).toContain("第二个项目");
  });

  it("recovers from malformed browsing preferences", () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => key.endsWith("expanded") ? "null" : "{\"unexpected\":true}" });
    expect(() => sidebar()).not.toThrow();
  });

  it("distinguishes awaiting device and cleanup from active execution", () => {
    const waiting = renderToStaticMarkup(<TaskStatus status="waiting" waiting={{ reason: "env", since: 1 }} />);
    const cleanup = renderToStaticMarkup(<TaskStatus status="stopped" cleanupPending />);
    expect(waiting).toContain("等待设备");
    expect(waiting).not.toContain('aria-label="运行中"');
    expect(cleanup).toContain("清理待确认");
  });

  it("offers task navigation to its origin conversation and target project", () => {
    const html = renderToStaticMarkup(<MocoTaskProjection detail={{ ticket: {
      id: "task-1", commandId: "command-1", title: "修复测试", goal: "修复测试", scope: project.workspaceDir,
      role: "developer", status: "waiting", envId: project.deviceId, workspaceDir: project.workspaceDir, projectId: project.id,
      workerConversationId: 3, runEpoch: 1, createdAt: 1, updatedAt: 1, waiting: { reason: "env", since: 1 },
    }, transcript: [], live: { busy: false, activeTools: [], queuedCount: 0 } }} roleLabel="开发" projectName={project.name}
      onAnswerBlocker={async () => {}} onStop={() => {}} onRetry={() => {}} onArchiveClose={() => {}} onDefer={() => {}}
      onOpenOrigin={() => {}} onOpenProject={() => {}} />);
    expect(html).toContain("原会话");
    expect(html).toContain("Moco");
    expect(html).toContain("等待设备");
    expect(html).not.toContain('aria-label="任务执行中"');
  });
});
