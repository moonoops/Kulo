import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { Disclosure, Dropdown, Modal, Select } from "@heroui/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvNodeDescriptor, ProjectView, TicketCardView, TopicSummary } from "@kulo/protocol";
import { CreateProjectDialog } from "./create-project-dialog";
import { ProjectsSidebar } from "./projects-sidebar";
import { TopicRow } from "../topics/topic-row";
import { KuloTaskProjection, TaskStatus } from "../../kulo-tasks";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const project: ProjectView = {
  id: "project-1", name: "Kulo", deviceId: "remote", deviceName: "工作站", workspaceDir: "/projects/Kulo", directoryId: "directory-1", revision: 1, grantRevision: 1,
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
    expect(html).toContain("kulo-topic-failure");
    expect(html).not.toContain("kulo-topic-attention");
  });
  it("keeps unavailable projects and their history visible without claiming a local device", () => {
    const html = sidebar();
    expect(html).toContain("Kulo");
    expect(html).toContain("工作站");
    expect(html).toContain("项目讨论");
    expect(html).toContain("离线");
    expect(html).toContain('data-online="false"');
    expect(html).not.toContain("（本机）");
    expect(html).not.toContain("kulo-device-local-tag");
    expect(html).not.toContain("移动会话");
    expect(html).not.toContain("恢复项目");
  });

  it("places the current device first with a leading local tag and online/offline dots across sidebar and creation dialog", () => {
    vi.spyOn(Dropdown, "Popover").mockImplementation(({ children }) => <>{children}</>);
    vi.spyOn(Select, "Popover").mockImplementation(({ children }) => <>{children}</>);
    vi.spyOn(Modal, "Backdrop").mockImplementation(({ children }) => <>{children}</>);
    vi.spyOn(Modal, "Container").mockImplementation(({ children }) => <>{children}</>);
    vi.spyOn(Modal, "Dialog").mockImplementation(({ children }) => <>{children}</>);
    const hubEnv: EnvNodeDescriptor = { id: "local", name: "Macmini.local", kind: "local", online: true, platform: "darwin", arch: "arm64", rootDir: "/hub", capabilities: ["fs"], connectedAt: 1, lastSeenAt: 1 };
    const offlineEnv: EnvNodeDescriptor = { id: "studio", name: "Office-Studio.local", kind: "reverse-ws", online: false, platform: "darwin", arch: "arm64", rootDir: "/studio", capabilities: ["fs"], connectedAt: 1, lastSeenAt: 1 };
    const currentEnv: EnvNodeDescriptor = { id: "macbook", name: "iKoomas-Macboom-Pro.local", kind: "reverse-ws", online: true, platform: "darwin", arch: "arm64", rootDir: "/mbp", capabilities: ["fs"], connectedAt: 1, lastSeenAt: 1 };
    const currentProject: ProjectView = { ...project, id: "project-mbp", deviceId: "macbook", deviceName: "iKoomas-Macboom-Pro.local", availability: "ready" };
    const hubProject: ProjectView = { ...project, id: "project-hub", deviceId: "local", deviceName: "Macmini.local", availability: "ready" };
    const html = sidebar([hubProject, currentProject], [{ ...projectTopic, projectId: currentProject.id }], {
      envs: [hubEnv, offlineEnv, currentEnv],
      connected: true,
      currentDeviceId: "macbook",
    });

    expect(html).toContain("kulo-device-local-tag");
    expect(html).toContain('data-online="true"');
    expect(html).toContain('data-online="false"');
    expect(html).not.toContain("（本机）");

    const menuSlice = html.slice(html.indexOf('aria-label="项目设备"'));
    const idxCurrent = menuSlice.indexOf("iKoomas-Macboom-Pro.local");
    const idxHub = menuSlice.indexOf("Macmini.local");
    const idxOffline = menuSlice.indexOf("Office-Studio.local");
    expect(idxCurrent).toBeGreaterThan(-1);
    expect(idxCurrent).toBeLessThan(idxHub);
    expect(idxHub).toBeLessThan(idxOffline);
    expect(menuSlice.indexOf("kulo-device-local-tag")).toBeLessThan(idxCurrent);

    const dialogHtml = renderToStaticMarkup(<CreateProjectDialog
      devices={[
        { id: "local", name: "Macmini.local", online: true, rootDir: "/hub" },
        { id: "studio", name: "Office-Studio.local", online: false, rootDir: "/studio" },
        { id: "macbook", name: "iKoomas-Macboom-Pro.local", online: true, rootDir: "/mbp" },
      ]}
      currentDeviceId="macbook"
      initialDeviceId="macbook"
      onCreated={() => {}}
      onClose={() => {}}
    />);
    const listSlice = dialogHtml.slice(dialogHtml.indexOf('aria-label="项目所在设备"'));
    expect(listSlice.indexOf("iKoomas-Macboom-Pro.local")).toBeLessThan(listSlice.indexOf("Macmini.local"));
    expect(listSlice.indexOf("Macmini.local")).toBeLessThan(listSlice.indexOf("Office-Studio.local"));
    expect(listSlice.indexOf("kulo-device-local-tag")).toBeLessThan(listSlice.indexOf("iKoomas-Macboom-Pro.local"));
    expect(listSlice).toContain('data-online="true"');
    expect(listSlice).toContain('data-online="false"');
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
    expect(html).toContain('aria-label="在 Kulo 新建会话"');
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
    const html = renderToStaticMarkup(<KuloTaskProjection detail={{ ticket: {
      id: "task-1", commandId: "command-1", title: "修复测试", goal: "修复测试", scope: project.workspaceDir,
      role: "developer", status: "waiting", envId: project.deviceId, workspaceDir: project.workspaceDir, projectId: project.id,
      workerConversationId: 3, runEpoch: 1, createdAt: 1, updatedAt: 1, waiting: { reason: "env", since: 1 },
    }, transcript: [], live: { busy: false, activeTools: [], queuedCount: 0 } }} roleLabel="开发" projectName={project.name}
      onAnswerBlocker={async () => {}} onStop={() => {}} onRetry={() => {}} onArchiveClose={() => {}} onDefer={() => {}}
      onOpenOrigin={() => {}} onOpenProject={() => {}} />);
    expect(html).toContain("原会话");
    expect(html).toContain("Kulo");
    expect(html).toContain("等待设备");
    expect(html).not.toContain('aria-label="任务执行中"');
  });
});
