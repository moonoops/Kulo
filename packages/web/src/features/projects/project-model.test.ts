import { describe, expect, it } from "vitest";
import type { EnvNodeDescriptor, ProjectView, TicketCardView, TopicSummary } from "@kulo/protocol";
import { ALL_PROJECT_DEVICES, initialProjectDevice, joinProjectDirectory, ordinaryTopics, projectDevices, projectTickets, topicsForProject, unfinishedTicket } from "./project-model";
import { scopeTickets, ticketWaitLabel } from "../../kulo-tasks";

const topics: TopicSummary[] = [
  { id: "root", conversationId: 0, title: "Kulo 主会话", master: true, pinned: true, createdAt: 0, updatedAt: 10 },
  { id: "plain", conversationId: 1, title: "普通讨论", createdAt: 1, updatedAt: 9 },
  { id: "a", conversationId: 2, title: "开发", projectId: "p", createdAt: 2, updatedAt: 5 },
  { id: "b", conversationId: 3, title: "需求", projectId: "p", pinned: true, createdAt: 3, updatedAt: 3 },
  { id: "deleted", conversationId: 4, title: "已删除", projectId: "p", deletedAt: 7, createdAt: 4, updatedAt: 7 },
  { id: "other", conversationId: 5, title: "另一个项目", projectId: "q", createdAt: 5, updatedAt: 5 },
];
const ticket = (id: string, originTopicId: string, projectId?: string, status: TicketCardView["status"] = "queued"): TicketCardView => ({
  id, title: id, role: "coder", roleLabel: "开发者", envId: "remote", workspaceDir: "/projects/kulo", originTopicId, projectId, status, createdAt: 1, updatedAt: 1,
});
const devices = [
  { id: "local", name: "Hub", online: true, rootDir: "/hub" },
  { id: "laptop", name: "笔记本", online: true, rootDir: "/home/projects" },
];

describe("project navigation boundaries", () => {
  it("keeps the main chat, project conversations and soft-deleted records out of ordinary topics", () => {
    expect(ordinaryTopics(topics).map((topic) => topic.id)).toEqual(["plain"]);
    expect(topicsForProject(topics, "p").map((topic) => topic.id)).toEqual(["b", "a"]);
  });

  it("never treats the Hub as the current device when browser identity is unknown", () => {
    expect(initialProjectDevice(null, "local", false, devices)).toBe(ALL_PROJECT_DEVICES);
    expect(initialProjectDevice(null, "laptop", true, devices)).toBe("laptop");
    expect(initialProjectDevice("local", "laptop", true, devices)).toBe("local");
    expect(initialProjectDevice("removed", "laptop", true, devices)).toBe("laptop");
    expect(initialProjectDevice(ALL_PROJECT_DEVICES, "laptop", true, devices)).toBe(ALL_PROJECT_DEVICES);
  });

  it("preserves projects from unavailable devices without claiming they are online", () => {
    const project = { deviceId: "removed", deviceName: "原工作站", availability: "unavailable" } as ProjectView;
    expect(projectDevices([], [project])[0]).toMatchObject({ id: "removed", name: "原工作站", online: false });
  });

  it("keeps saved device names while refreshing live connectivity and directories", () => {
    const envs: EnvNodeDescriptor[] = [{ id: "local", name: "Local (old-hostname)", kind: "local", online: false, platform: "darwin", arch: "arm64", rootDir: "/new/workspace", capabilities: ["fs"], connectedAt: 1, lastSeenAt: 2 }];
    const known = [{ id: "local", name: "工作用 MacBook", online: true, rootDir: "/old/workspace" }];
    expect(projectDevices(envs, [], known)).toEqual([{ id: "local", name: "工作用 MacBook", online: false, rootDir: "/new/workspace" }]);
    expect(projectDevices(envs, [ { deviceId: "local", deviceName: "旧项目设备名", availability: "ready" } as ProjectView ])[0]?.name).toBe("Local (old-hostname)");
  });

  it("orders the current device first ahead of the Hub, followed by online then offline devices", () => {
    const known = [
      { id: "local", name: "Macmini.local", online: true, rootDir: "/hub" },
      { id: "studio", name: "Office-Studio.local", online: false, rootDir: "/studio" },
      { id: "macbook", name: "iKoomas-Macboom-Pro.local", online: true, rootDir: "/mbp" },
    ];
    expect(projectDevices([], [], known, "macbook").map((device) => device.id)).toEqual(["macbook", "local", "studio"]);
    expect(projectDevices([], [], known).map((device) => device.id)).toEqual(["local", "macbook", "studio"]);
  });

  it("targets project tasks independently of their originating ordinary conversation", () => {
    const tasks = [ticket("ordinary-project", "plain", "p"), ticket("project-local", "a", "p"), ticket("other-project", "plain", "q")];
    expect(scopeTickets(tasks, "project", "plain", "p").map((task) => task.id)).toEqual(["ordinary-project", "project-local"]);
    expect(scopeTickets(tasks, "topic", "plain", "p").map((task) => task.id)).toEqual(["ordinary-project", "other-project"]);
    expect(scopeTickets(tasks, "project", "plain").map((task) => task.id)).toEqual(["ordinary-project", "other-project"]);
    expect(scopeTickets(tasks, "all", "plain", "p")).toHaveLength(3);
  });

  it("includes running, waiting and queued work in project deletion impact", () => {
    const tasks = [ticket("target", "plain", "p", "waiting"), ticket("origin", "a", "q", "pausing"), ticket("done", "a", "p", "ready"), ticket("unrelated", "other", "q")];
    expect(projectTickets("p", topics, tasks).filter(unfinishedTicket).map((task) => task.id)).toEqual(["target", "origin"]);
    for (const status of ["queued", "running", "waiting", "pausing", "blocked"] as const) expect(unfinishedTicket({ status })).toBe(true);
    for (const status of ["ready", "failed", "stopped", "closed"] as const) expect(unfinishedTicket({ status })).toBe(false);
  });

  it("labels durable waits by their actual cause", () => {
    expect(ticketWaitLabel({ reason: "env", since: 1 })).toBe("等待设备");
    expect(ticketWaitLabel({ reason: "user", since: 1 })).toBe("等待确认");
    expect(ticketWaitLabel({ reason: "time", since: 1 })).toBe("等待时间");
  });

  it("constructs remote directory paths using the target platform", () => {
    expect(joinProjectDirectory("/projects/", "Kulo")).toBe("/projects/Kulo");
    expect(joinProjectDirectory("/", "Kulo")).toBe("/Kulo");
    expect(joinProjectDirectory("C:\\Projects\\", "Kulo")).toBe("C:\\Projects\\Kulo");
    expect(joinProjectDirectory("C:/Projects", "Kulo")).toBe("C:\\Projects\\Kulo");
    expect(joinProjectDirectory("\\\\server\\share", "项目 文件")).toBe("\\\\server\\share\\项目 文件");
    for (const invalid of ["", ".", "..", "../escape", "a\\b", "a\0b"]) expect(() => joinProjectDirectory("/projects", invalid)).toThrow();
  });
});
