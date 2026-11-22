import { randomUUID } from "node:crypto";
import { ProjectError } from "../projects.js";
import type { HubHttpRouteContext } from "./context.js";

/**
 * Handles `/api/projects*` business REST routes.
 * Must only be invoked after management authentication and the cluster handover barrier.
 */
export async function handleProjectsRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, parsedUrl, pathname, readJsonObject, sendJson } = ctx;

  if (pathname === "/api/projects/directories" && req.method === "GET") {
    const deviceId = parsedUrl.searchParams.get("deviceId")?.trim();
    if (!deviceId) throw new ProjectError(400, "invalid_device", "请选择设备。");
    sendJson(res, 200, await hub.envManager.listProjectDirectories(deviceId, parsedUrl.searchParams.get("path") ?? undefined));
    return true;
  }
  if (pathname === "/api/projects" && req.method === "GET") {
    sendJson(res, 200, { projects: await hub.projects.list() });
    return true;
  }
  if (pathname === "/api/projects" && req.method === "POST") {
    const body = await readJsonObject(req);
    if (
      typeof body.name !== "string" ||
      typeof body.deviceId !== "string" ||
      typeof body.workspaceDir !== "string" ||
      (body.commandId !== undefined && typeof body.commandId !== "string") ||
      (body.createDirectory !== undefined && typeof body.createDirectory !== "boolean")
    ) {
      throw new ProjectError(400, "invalid_project", "项目名称、设备和目录无效。");
    }
    const project = await hub.projects.create({
      name: body.name,
      deviceId: body.deviceId,
      workspaceDir: body.workspaceDir,
      commandId: (body.commandId as string | undefined) ?? randomUUID(),
      createDirectory: body.createDirectory as boolean | undefined,
    });
    sendJson(res, 201, { project });
    return true;
  }
  const projectRoute = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (projectRoute && req.method === "PATCH") {
    const body = await readJsonObject(req);
    if (body.deviceId !== undefined || body.workspaceDir !== undefined) {
      throw new ProjectError(400, "project_binding_tool_required", "请通过 Kulo 重新关联项目目录。");
    }
    if (
      (body.name !== undefined && typeof body.name !== "string") ||
      (body.notes !== undefined && typeof body.notes !== "string") ||
      (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1))
    ) {
      throw new ProjectError(400, "invalid_project", "项目修改参数无效。");
    }
    const project = await hub.projects.patch(decodeURIComponent(projectRoute[1]!), {
      name: body.name as string | undefined,
      notes: body.notes as string | undefined,
      expectedRevision: body.expectedRevision as number | undefined,
    });
    sendJson(res, 200, { project });
    return true;
  }
  if (projectRoute && req.method === "DELETE") {
    const body = (await readJsonObject(req)) as { stopTasks?: boolean };
    if (body.stopTasks !== undefined && typeof body.stopTasks !== "boolean") {
      throw new ProjectError(400, "invalid_project", "删除参数无效。");
    }
    sendJson(res, 200, await hub.projects.remove(decodeURIComponent(projectRoute[1]!), { stopTasks: body.stopTasks }));
    return true;
  }
  return false;
}
