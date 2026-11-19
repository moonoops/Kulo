import { afterEach, describe, expect, it, vi } from "vitest";
import { kuloRest } from "../../kulo-api";

afterEach(() => vi.unstubAllGlobals());

describe("project REST requests", () => {
  it("sends the selected device and explicit directory creation choice with a stable operation ID", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ project: { id: "p" } }), { status: 201 }));
    vi.stubGlobal("fetch", request);
    const body = { commandId: "create-project-1", name: "Kulo", deviceId: "laptop", workspaceDir: "C:\\Projects\\Kulo", createDirectory: true };
    await kuloRest.createProject(body);
    expect(request.mock.calls[0][0]).toBe("/api/projects");
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(body);
  });

  it("queries directories on the chosen device without mixing its Windows path into URL syntax", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ deviceId: "remote", path: "C:\\项目", parentPath: "C:\\", entries: [] })));
    vi.stubGlobal("fetch", request);
    await kuloRest.listProjectDirectories("remote", "C:\\项目 & 文件");
    const url = new URL(request.mock.calls[0][0], "http://kulo.invalid");
    expect(url.searchParams.get("deviceId")).toBe("remote");
    expect(url.searchParams.get("path")).toBe("C:\\项目 & 文件");
  });

  it("makes the stop-and-delete intent explicit for both projects and conversations", async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ deleted: "p", projects: [], topics: [] }))));
    vi.stubGlobal("fetch", request);
    await kuloRest.deleteProject("p / 1", true);
    await kuloRest.deleteTopic("topic-1", true);
    expect(request.mock.calls[0][0]).toBe("/api/projects/p%20%2F%201");
    for (const call of request.mock.calls) {
      expect(call[1].method).toBe("DELETE");
      expect(JSON.parse(call[1].body)).toEqual({ stopTasks: true });
    }
  });

  it("creates project conversations without changing how ordinary conversations are created", async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: "topic" }))));
    vi.stubGlobal("fetch", request);
    await kuloRest.createTopic(undefined, "project-1");
    await kuloRest.createTopic();
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ projectId: "project-1" });
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({});
  });
});
