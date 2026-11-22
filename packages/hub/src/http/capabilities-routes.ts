import type { ExtensionOperationRequest } from "@kulo/protocol";
import { CapabilityError } from "../capabilities.js";
import { handleImageConfigurationHttp } from "../image-configuration-http.js";
import { handleModelConfigurationHttp } from "../model-configuration-http.js";
import { ProjectError } from "../projects.js";
import { SkillError } from "../skills.js";
import type { HubHttpRouteContext } from "./context.js";

/**
 * Handles `/api/capabilities*`, `/api/skills*`, `/api/extensions*`, `/api/search*`,
 * and delegated image/model configuration routes (including `/api/settings/model-configuration`,
 * which MUST run before the generic `/api/settings/*` handler).
 */
export async function handleCapabilitiesRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, parsedUrl, pathname, readJsonObject, sendJson, isHubSecret } = ctx;

  if (pathname === "/api/capabilities" && req.method === "GET") {
    sendJson(res, 200, await hub.getCapabilitiesSnapshot(parsedUrl.searchParams.get("clientId") ?? undefined));
    return true;
  }
  if (pathname === "/api/capabilities/computer-use" && req.method === "PUT") {
    const body = await readJsonObject(req);
    const allowed = ["browserEnabled", "desktopEnabled", "expectedRevision", "commandId"];
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      typeof body.browserEnabled !== "boolean" ||
      typeof body.desktopEnabled !== "boolean" ||
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 0 ||
      typeof body.commandId !== "string"
    ) {
      throw new CapabilityError(400, "invalid_computer_use", "电脑操控开关参数无效。");
    }
    res.setHeader("cache-control", "no-store");
    sendJson(
      res,
      200,
      await hub.configureComputerUse({
        browserEnabled: body.browserEnabled,
        desktopEnabled: body.desktopEnabled,
        expectedRevision: body.expectedRevision as number,
        commandId: body.commandId,
      }),
    );
    return true;
  }
  if (await handleImageConfigurationHttp(hub, req, res, parsedUrl, readJsonObject, sendJson)) return true;
  if (await handleModelConfigurationHttp(hub.modelConfiguration, req, res, parsedUrl, readJsonObject, sendJson)) return true;
  if (pathname === "/api/skills" && req.method === "GET") {
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, await hub.skills.snapshot());
    return true;
  }
  if (pathname === "/api/skills/import" && req.method === "POST") {
    const body = await readJsonObject(req);
    const allowed = ["source", "expectedRevision", "commandId", "audiences"];
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      typeof body.source !== "string" ||
      !body.source.trim() ||
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 0 ||
      typeof body.commandId !== "string"
    ) {
      throw new SkillError(400, "invalid_skill_request", "导入技能参数无效。");
    }
    const snapshot = await hub.skills.manage({
      action: "import",
      source: body.source,
      expectedRevision: body.expectedRevision as number,
      commandId: body.commandId,
      ...(body.audiences !== undefined ? { audiences: body.audiences as never } : {}),
    });
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, snapshot);
    return true;
  }
  const skillRoute = /^\/api\/skills\/([^/]+)$/.exec(pathname);
  if (skillRoute && (req.method === "PATCH" || req.method === "DELETE")) {
    const body = await readJsonObject(req);
    const editing = req.method === "PATCH";
    const allowed = editing
      ? ["enabled", "audiences", "expectedRevision", "commandId"]
      : ["expectedRevision", "commandId"];
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 0 ||
      typeof body.commandId !== "string" ||
      (editing && typeof body.enabled !== "boolean")
    ) {
      throw new SkillError(400, "invalid_skill_request", "技能操作参数无效。");
    }
    let id: string;
    try {
      id = decodeURIComponent(skillRoute[1]!);
    } catch {
      throw new SkillError(400, "invalid_skill_request", "技能标识无效。");
    }
    if (!id || id.length > 256 || /[\x00-\x1f\x7f/\\]/.test(id)) {
      throw new SkillError(400, "invalid_skill_request", "技能标识无效。");
    }
    const snapshot = await hub.skills.manage({
      id,
      action: editing ? (body.enabled ? "enable" : "disable") : "remove",
      expectedRevision: body.expectedRevision as number,
      commandId: body.commandId,
      ...(editing && body.audiences !== undefined ? { audiences: body.audiences as never } : {}),
    });
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, snapshot);
    return true;
  }
  if (pathname === "/api/extensions" && req.method === "GET") {
    sendJson(res, 200, await hub.extensions.snapshot(parsedUrl.searchParams.get("clientId") ?? undefined));
    return true;
  }
  const extensionOperationRoute = /^\/api\/extensions\/([^/]+)\/operations$/.exec(pathname);
  if (extensionOperationRoute && req.method === "POST") {
    const body = await readJsonObject(req);
    if (Object.keys(body).some((key) => !["operation", "expectedRevision", "commandId", "clientId"].includes(key))) {
      sendJson(res, 400, { error: "扩展操作参数无效。" });
      return true;
    }
    sendJson(
      res,
      200,
      await hub.extensions.request({
        ...body,
        id: decodeURIComponent(extensionOperationRoute[1]!),
      } as unknown as ExtensionOperationRequest),
    );
    return true;
  }
  if (pathname === "/api/search" && req.method === "GET") {
    sendJson(res, 200, await hub.search.snapshot());
    return true;
  }
  if (pathname === "/api/search/plans" && req.method === "POST") {
    const body = await readJsonObject(req);
    const apiKey = body.apiKey;
    if (typeof apiKey === "string" && isHubSecret(apiKey)) {
      throw new ProjectError(400, "invalid_search_credential", "搜索服务需要独立的 API Key。");
    }
    await hub.search.configure(body as never);
    sendJson(res, 200, await hub.search.snapshot());
    return true;
  }
  if (pathname === "/api/search/order" && req.method === "PATCH") {
    const body = await readJsonObject(req);
    if (
      Object.keys(body).some((key) => !["ids", "expectedRevision"].includes(key)) ||
      !Array.isArray(body.ids) ||
      body.ids.some((id) => typeof id !== "string")
    ) {
      throw new ProjectError(400, "invalid_search_order", "搜索方案排序无效。");
    }
    sendJson(res, 200, await hub.search.reorder(body.ids as string[], body.expectedRevision as number));
    return true;
  }
  const searchPlanRoute = /^\/api\/search\/plans\/([^/]+)(\/test)?$/.exec(pathname);
  if (searchPlanRoute && req.method === "DELETE" && !searchPlanRoute[2]) {
    await hub.search.remove(decodeURIComponent(searchPlanRoute[1]!), Number(parsedUrl.searchParams.get("expectedRevision")));
    sendJson(res, 200, await hub.search.snapshot());
    return true;
  }
  if (searchPlanRoute?.[2] && req.method === "POST") {
    const body = await readJsonObject(req);
    if (Object.keys(body).some((key) => key !== "expectedRevision")) {
      throw new ProjectError(400, "invalid_search_test", "搜索测试参数无效。");
    }
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClose);
    try {
      const result = await hub.search.test(
        decodeURIComponent(searchPlanRoute[1]!),
        body.expectedRevision as number,
        controller.signal,
      );
      if (!res.destroyed) sendJson(res, 200, { snapshot: await hub.search.snapshot(), result });
    } finally {
      res.off("close", onClose);
    }
    return true;
  }
  if (pathname === "/api/capabilities/flow" && req.method === "POST") {
    const body = await readJsonObject(req);
    const allowed = ["clientId", "envId", "commandId", "name"];
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      typeof body.clientId !== "string" ||
      !body.clientId.trim() ||
      body.clientId.length > 120 ||
      typeof body.envId !== "string" ||
      !body.envId.trim() ||
      body.envId.length > 180 ||
      typeof body.commandId !== "string" ||
      !body.commandId.trim() ||
      body.commandId.length > 180 ||
      (body.name !== undefined && typeof body.name !== "string")
    ) {
      throw new CapabilityError(400, "invalid_capability_flow", "Google Flow 连接参数无效。");
    }
    const existingWorkspace = await hub.capabilities.snapshot();
    const existingConnection = existingWorkspace.connections.find(
      (connection) => connection.adapter === "flow-browser" && connection.browserEnvId === body.envId,
    );
    const existingCapability = existingConnection
      ? existingWorkspace.capabilities.find(
          (capability) => capability.connectionId === existingConnection.id && capability.kind === "video",
        )
      : undefined;
    const saved = await hub.capabilities.configure({
      commandId: body.commandId,
      ...(existingCapability ? { id: existingCapability.id, expectedRevision: existingCapability.revision } : {}),
      name:
        existingCapability?.name ??
        (typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Google Flow"),
      adapter: "flow-browser",
      modelId: "auto",
      browserEnvId: body.envId,
      enabled: true,
      allowTaskGeneration: true,
    });
    const input =
      saved.status !== "ready"
        ? await hub.capabilities.requestInput(saved.id, "browser", body.clientId)
        : undefined;
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, {
      capability: saved,
      ...(input ? { input } : {}),
      snapshot: await hub.getCapabilitiesSnapshot(body.clientId),
    });
    return true;
  }
  const capabilityInput = /^\/api\/capabilities\/inputs\/([^/]+)(\/browser)?$/.exec(pathname);
  if (capabilityInput && req.method === "POST") {
    const body = await readJsonObject(req);
    if (
      typeof body.clientId !== "string" ||
      !body.clientId.trim() ||
      body.clientId.length > 120 ||
      (body.secret !== undefined && typeof body.secret !== "string") ||
      (body.cancel !== undefined && typeof body.cancel !== "boolean") ||
      Object.keys(body).some((key) => !["clientId", "secret", "cancel"].includes(key))
    ) {
      throw new ProjectError(400, "invalid_capability_input", "配置输入无效。");
    }
    if (capabilityInput[2] && body.secret !== undefined) {
      throw new ProjectError(400, "invalid_capability_input", "浏览器登录不接受密钥。");
    }
    await hub.capabilities.submitInput(decodeURIComponent(capabilityInput[1]!), body.clientId, {
      ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
      ...(typeof body.cancel === "boolean" ? { cancel: body.cancel } : {}),
    });
    sendJson(res, 200, await hub.getCapabilitiesSnapshot(body.clientId));
    return true;
  }
  return false;
}
