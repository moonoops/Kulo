import {
  CUSTOM_PROVIDER_APIS,
  normalizeKuloLanguage,
  type CustomProviderApi,
  type DiscoverModelsRequest,
  type IdentityFile,
  type MemoryConnectionUpdateRequest,
  type MemoryServicePrepareRequest,
  type ModelProbeRequest,
  type RelationshipRollbackRequest,
  type RelationshipWriteRequest,
  type ResolveModelMetadataRequest,
  type SettingsBlockName,
} from "@kulo/protocol";
import { fetchAcpRegistryTemplates } from "../acp-registry.js";
import { AgentConfigurationError } from "../agent-configuration.js";
import { getIdentityTemplate } from "../identity-files.js";
import { MemoryServiceError } from "../memory-service.js";
import { ProjectError } from "../projects.js";
import { MAINSTREAM_PROVIDER_PRESETS } from "../providers.js";
import { handleBuiltinMemoryRoutes } from "./builtin-memory-routes.js";
import type { HubHttpRouteContext } from "./context.js";

const VALID_BLOCKS: readonly SettingsBlockName[] = [
  "presentation",
  "executor",
  "roles",
  "model",
  "identity",
  "memory",
];

/**
 * Handles `/api/settings*`, `/api/external-clients*`, `/api/usage-caps`,
 * `/api/personality*`, `/api/identity*`, `/api/memory*`, `/api/model/probe`,
 * and `/api/providers*` routes.
 * MUST run AFTER `handleCapabilitiesRoutes` so `/api/settings/model-configuration`
 * matches before the generic `POST /api/settings/:block` handler.
 */
export async function handleSettingsProvidersRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  if (await handleBuiltinMemoryRoutes(ctx)) return true;
  const { hub, req, res, parsedUrl, pathname, readJsonBody, readJsonObject, sendJson, requestOrigin } = ctx;

  // Settings API
  if (req.method === "GET" && pathname === "/api/settings") {
    sendJson(res, 200, hub.getSettingsView());
    return true;
  }

  if (req.method === "GET" && pathname === "/api/external-clients/quotas") {
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, hub.externalClientQuotas.getSnapshot());
    return true;
  }

  if (req.method === "POST" && pathname === "/api/external-clients/quotas/refresh") {
    res.setHeader("cache-control", "no-store");
    if (
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin && req.headers.origin !== requestOrigin(req))
    ) {
      sendJson(res, 403, { error: "请在 Kulo 中刷新外部客户端额度。", code: "external_quota_origin_required" });
      return true;
    }
    const body = await readJsonObject(req, 4096);
    if (Object.keys(body).some((key) => key !== "clientId" && key !== "force")) {
      throw new AgentConfigurationError(400, "invalid_agent_configuration", "刷新额度参数无效。");
    }
    let clientId: string | undefined;
    if (body.clientId !== undefined) {
      if (
        typeof body.clientId !== "string" ||
        !body.clientId.trim() ||
        body.clientId.length > 200 ||
        /[\x00-\x1f\x7f]/.test(body.clientId)
      ) {
        throw new AgentConfigurationError(400, "invalid_agent_configuration", "外部客户端标识无效。");
      }
      clientId = body.clientId.trim();
    }
    if (body.force !== undefined && typeof body.force !== "boolean") {
      throw new AgentConfigurationError(400, "invalid_agent_configuration", "刷新标志无效。");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const view = await hub.externalClientQuotas.refresh({
        ...(clientId ? { clientId } : {}),
        force: body.force === true,
        signal: controller.signal,
      });
      if (!res.writableEnded && !res.destroyed) {
        sendJson(res, 200, view);
      }
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/external-clients/scan") {
    const body = await readJsonObject(req);
    if (Object.keys(body).some((key) => key !== "envId" && key !== "kinds")) {
      throw new AgentConfigurationError(400, "invalid_agent_configuration", "扫描参数无效。");
    }
    if (body.envId !== undefined && typeof body.envId !== "string") {
      throw new AgentConfigurationError(400, "invalid_agent_configuration", "设备标识无效。");
    }
    if (body.kinds !== undefined && (!Array.isArray(body.kinds) || body.kinds.some((item) => typeof item !== "string"))) {
      throw new AgentConfigurationError(400, "invalid_agent_configuration", "客户端类型列表无效。");
    }
    res.setHeader("cache-control", "no-store");
    sendJson(
      res,
      200,
      await hub.agentConfiguration.scan({
        ...(typeof body.envId === "string" && body.envId.trim() ? { envId: body.envId.trim() } : {}),
        ...(Array.isArray(body.kinds) ? { kinds: body.kinds as never } : {}),
      }),
    );
    return true;
  }

  if (req.method === "GET" && pathname === "/api/external-clients/acp-registry") {
    const forceRefresh = parsedUrl.searchParams.get("refresh") === "1";
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, await fetchAcpRegistryTemplates({ forceRefresh }));
    return true;
  }

  if (req.method === "POST" && pathname === "/api/external-clients/connect") {
    const body = await readJsonObject(req);
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, await hub.agentConfiguration.quickConnect(body as never, undefined, { allowCustomAcpCommand: true }));
    return true;
  }

  if (req.method === "POST" && pathname.startsWith("/api/external-clients/") && pathname.endsWith("/refresh")) {
    const encoded = pathname.slice("/api/external-clients/".length, -"/refresh".length);
    if (!encoded || encoded.includes("/")) {
      sendJson(res, 404, { error: "Invalid external client path" });
      return true;
    }
    const out = await hub.refreshExternalClientModels(decodeURIComponent(encoded));
    sendJson(res, 200, out);
    return true;
  }

  if (req.method === "POST" && pathname.startsWith("/api/external-clients/") && pathname.endsWith("/verify")) {
    const encoded = pathname.slice("/api/external-clients/".length, -"/verify".length);
    if (!encoded || encoded.includes("/")) {
      sendJson(res, 404, { error: "Invalid external client path" });
      return true;
    }
    const body = await readJsonObject(req);
    const expectedRevision =
      typeof body.expectedRevision === "number" && Number.isSafeInteger(body.expectedRevision)
        ? body.expectedRevision
        : undefined;
    const commandId =
      typeof body.commandId === "string" && body.commandId.trim()
        ? body.commandId.trim()
        : undefined;
    res.setHeader("cache-control", "no-store");
    const out = await hub.verifyExternalClient(decodeURIComponent(encoded), {
      ...(commandId ? { commandId } : {}),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
    sendJson(res, 200, out);
    return true;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/external-clients/")) {
    const encoded = pathname.slice("/api/external-clients/".length);
    if (!encoded || encoded.includes("/")) {
      sendJson(res, 404, { error: "Invalid external client path" });
      return true;
    }
    const expectedRaw = parsedUrl.searchParams.get("expectedRevision");
    const expectedRevision = expectedRaw !== null && expectedRaw !== "" ? Number(expectedRaw) : undefined;
    const out = await hub.removeExternalClient(
      decodeURIComponent(encoded),
      Number.isSafeInteger(expectedRevision) ? expectedRevision : undefined,
    );
    sendJson(res, 200, out);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/settings/rollback") {
    const body = (await readJsonBody(req)) as {
      toRevision?: number;
      expectedGlobalRevision?: number;
    };
    const canChangeTrustMode = ctx.authority.hasOwnerHubControl && !ctx.authority.isSshPrincipal;
    const out = await hub.rollbackSettings(Number(body.toRevision), Number(body.expectedGlobalRevision), undefined, {
      allowTrustModeChange: canChangeTrustMode,
    });
    sendJson(res, 200, out);
    return true;
  }

  if (req.method === "POST" && pathname.startsWith("/api/settings/")) {
    const block = pathname.slice("/api/settings/".length) as SettingsBlockName;
    if (!VALID_BLOCKS.includes(block)) {
      sendJson(res, 404, { error: `Unknown settings block '${block}'` });
      return true;
    }
    const body = (await readJsonBody(req)) as {
      expectedRevision?: number;
      value?: unknown;
    };
    if (block === "executor" && body.value && typeof body.value === "object" && Object.hasOwn(body.value, "executionTrustMode")) {
      const requestedMode = (body.value as Record<string, unknown>).executionTrustMode;
      const currentMode = hub.getSettingsView().blocks.executor.value.executionTrustMode;
      if (requestedMode !== undefined && requestedMode !== currentMode) {
        if (!ctx.authority.hasOwnerHubControl || ctx.authority.isSshPrincipal) {
          sendJson(res, 403, { error: "仅主人设备控制台可修改执行权限模式。" });
          return true;
        }
      }
    }
    const out = await hub.updateSettingsBlock(block, Number(body.expectedRevision), body.value);
    sendJson(res, 200, out);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/usage-caps") {
    sendJson(res, 200, hub.usageCaps.snapshot());
    return true;
  }
  if (req.method === "PUT" && pathname === "/api/usage-caps") {
    const body = await readJsonObject(req);
    sendJson(res, 200, await hub.usageCaps.updateConfig(Number(body.expectedRevision), body.config));
    return true;
  }

  // Identity & Relationship API
  if (req.method === "GET" && pathname === "/api/personality") {
    sendJson(res, 200, await hub.personality.snapshot());
    return true;
  }
  if (req.method === "POST" && pathname === "/api/personality/settings") {
    const body = await readJsonObject(req);
    sendJson(res, 200, await hub.personality.updateSettings(Number(body.expectedRevision), body));
    return true;
  }
  if (req.method === "GET" && pathname === "/api/personality/identity") {
    const language = normalizeKuloLanguage(parsedUrl.searchParams.get("lang"));
    sendJson(res, 200, await hub.personality.readIdentity(language ? { language } : undefined));
    return true;
  }
  if (req.method === "GET" && pathname === "/api/personality/identity/preset") {
    const language =
      normalizeKuloLanguage(parsedUrl.searchParams.get("lang")) ??
      hub.getSettingsView().blocks.presentation.value.language ??
      "en";
    sendJson(res, 200, { content: getIdentityTemplate("identity-agreement.md", language) });
    return true;
  }
  if (req.method === "POST" && pathname === "/api/personality/identity/dismiss") {
    const body = await readJsonObject(req);
    if (typeof body.id !== "string") throw new ProjectError(400, "invalid_proposal", "修改建议无效。");
    await hub.personality.dismissIdentityProposal(body.id);
    sendJson(res, 200, await hub.personality.snapshot());
    return true;
  }
  if (req.method === "POST" && pathname === "/api/personality/relationship") {
    sendJson(res, 200, await hub.personality.saveRelationship((await readJsonObject(req)) as unknown as RelationshipWriteRequest));
    return true;
  }
  if (req.method === "POST" && pathname === "/api/personality/relationship/rollback") {
    sendJson(
      res,
      200,
      await hub.personality.rollbackRelationship((await readJsonObject(req)) as unknown as RelationshipRollbackRequest),
    );
    return true;
  }
  if (req.method === "GET" && pathname === "/api/personality/recent-work") {
    sendJson(res, 200, await hub.getRecentWork(parsedUrl.searchParams.get("topicId") ?? undefined));
    return true;
  }
  if (req.method === "POST" && pathname === "/api/personality/recent-work/refresh") {
    const body = await readJsonObject(req);
    if (body.topicId !== undefined && typeof body.topicId !== "string") {
      throw new ProjectError(400, "invalid_topic", "会话无效。");
    }
    sendJson(res, 200, await hub.getRecentWork(body.topicId as string | undefined));
    return true;
  }
  if (req.method === "GET" && pathname === "/api/identity/files") {
    sendJson(res, 200, await hub.identityFiles.list());
    return true;
  }
  if (req.method === "GET" && pathname === "/api/identity/file") {
    const file = parsedUrl.searchParams.get("file") as IdentityFile | null;
    const language = normalizeKuloLanguage(parsedUrl.searchParams.get("lang"));
    sendJson(res, 200, await hub.identityFiles.read(file, language ? { language } : undefined));
    return true;
  }
  if (req.method === "GET" && pathname === "/api/identity/backup") {
    const file = parsedUrl.searchParams.get("file");
    const backupId = parsedUrl.searchParams.get("backupId");
    sendJson(res, 200, await hub.identityFiles.readBackup(file, backupId));
    return true;
  }
  if (req.method === "POST" && pathname === "/api/identity/save") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await hub.identityFiles.save(body));
    return true;
  }
  if (req.method === "POST" && pathname === "/api/identity/rollback") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await hub.identityFiles.rollback(body));
    return true;
  }

  if (pathname === "/api/memory/service" && req.method === "GET") {
    sendJson(res, 200, await hub.memoryService.snapshot(parsedUrl.searchParams.get("clientId") ?? undefined));
    return true;
  }
  if (pathname === "/api/memory/service/prepare" && req.method === "POST") {
    const body = await readJsonObject(req);
    sendJson(res, 200, await hub.memoryService.prepare(body as unknown as MemoryServicePrepareRequest));
    return true;
  }
  if (pathname === "/api/memory/service/connection" && req.method === "POST") {
    const body = await readJsonObject(req);
    sendJson(res, 200, await hub.memoryService.updateConnection(body as unknown as MemoryConnectionUpdateRequest));
    return true;
  }
  if (pathname === "/api/memory/service/connection/probe" && req.method === "POST") {
    const body = await readJsonObject(req);
    sendJson(res, 200, await hub.memoryService.updateConnection(body as unknown as MemoryConnectionUpdateRequest, true));
    return true;
  }
  if (pathname === "/api/memory/service/enabled" && req.method === "POST") {
    const body = await readJsonObject(req);
    if (Object.keys(body).some((key) => !["enabled", "expectedRevision"].includes(key))) {
      throw new MemoryServiceError(400, "invalid_memory_request", "启用设置字段无效。");
    }
    sendJson(res, 200, await hub.memoryService.setEnabled(body.enabled as boolean, body.expectedRevision as number));
    return true;
  }
  if (pathname === "/api/memory/service/knowledge-guidance" && req.method === "POST") {
    const body = await readJsonObject(req);
    if (Object.keys(body).some((key) => !["enabled", "expectedRevision"].includes(key))) {
      throw new MemoryServiceError(400, "invalid_memory_request", "知识整理指引字段无效。");
    }
    sendJson(
      res,
      200,
      await hub.memoryService.setKnowledgeGuidanceEnabled(body.enabled as boolean, body.expectedRevision as number),
    );
    return true;
  }
  const memoryInput = pathname.match(/^\/api\/memory\/service\/inputs\/([^/]+)$/);
  if (memoryInput && req.method === "POST") {
    const body = await readJsonObject(req);
    if (Object.keys(body).some((key) => !["clientId", "secret", "cancel"].includes(key))) {
      throw new MemoryServiceError(400, "invalid_memory_input", "保密输入字段无效。");
    }
    sendJson(
      res,
      200,
      await hub.memoryService.submitInput(decodeURIComponent(memoryInput[1]!), body.clientId as string, {
        secret: body.secret as string | undefined,
        cancel: body.cancel as boolean | undefined,
      }),
    );
    return true;
  }
  const memoryDecision = pathname.match(/^\/api\/memory\/service\/jobs\/([^/]+)\/decision$/);
  if (memoryDecision && req.method === "POST") {
    const body = await readJsonObject(req);
    if (Object.keys(body).some((key) => !["clientId", "decision"].includes(key))) {
      throw new MemoryServiceError(400, "invalid_memory_decision", "确认字段无效。");
    }
    sendJson(
      res,
      200,
      await hub.memoryService.decide(
        decodeURIComponent(memoryDecision[1]!),
        body.clientId as string,
        body.decision as "confirm" | "reject",
      ),
    );
    return true;
  }
  if (req.method === "POST" && pathname === "/api/memory/probe") {
    const result = await hub.probeMemory();
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/model/probe") {
    const body = (await readJsonBody(req)) as ModelProbeRequest;
    const result = await hub.probeModel(body);
    sendJson(res, 200, result);
    return true;
  }

  // Providers & OAuth API
  if (req.method === "GET" && pathname === "/api/providers") {
    sendJson(res, 200, {
      providers: await hub.listProviders(),
      presets: MAINSTREAM_PROVIDER_PRESETS.map(({ id, name, api, baseUrl }) => ({ id, name, api, baseUrl })),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/providers/discover-models") {
    const body = (await readJsonBody(req)) as Partial<DiscoverModelsRequest>;
    const api = body.api;
    if (typeof api !== "string" || !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(api)) {
      sendJson(res, 400, { error: "无效的 API 协议类型" });
      return true;
    }
    const vertex =
      api === "google-vertex"
        ? { vertexProject: body.vertexProject, vertexLocation: body.vertexLocation }
        : undefined;
    const result = await hub.discoverProviderModels({
      ...(typeof body.providerId === "string" && body.providerId.trim() ? { providerId: body.providerId.trim() } : {}),
      ...(typeof body.preset === "string" && body.preset.trim() ? { preset: body.preset.trim() } : {}),
      api: api as CustomProviderApi,
      ...vertex,
      ...(typeof body.baseUrl === "string" && body.baseUrl.trim() ? { baseUrl: body.baseUrl.trim() } : {}),
      ...(typeof body.apiKey === "string" && body.apiKey.trim() ? { apiKey: body.apiKey.trim() } : {}),
      ...(body.refreshMetadata === true ? { refreshMetadata: true } : {}),
    });
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/providers/resolve-model") {
    const body = (await readJsonBody(req)) as Partial<ResolveModelMetadataRequest>;
    const api = body.api;
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!modelId) {
      sendJson(res, 400, { error: "请填写模型 ID" });
      return true;
    }
    if (typeof api !== "string" || !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(api)) {
      sendJson(res, 400, { error: "无效的 API 协议类型" });
      return true;
    }
    const result = await hub.resolveModelMetadata({
      modelId,
      api: api as CustomProviderApi,
      ...(typeof body.providerId === "string" && body.providerId.trim() ? { providerId: body.providerId.trim() } : {}),
      ...(typeof body.preset === "string" && body.preset.trim() ? { preset: body.preset.trim() } : {}),
      ...(typeof body.baseUrl === "string" && body.baseUrl.trim() ? { baseUrl: body.baseUrl.trim() } : {}),
      ...(body.refreshMetadata === true ? { refreshMetadata: true } : {}),
    });
    sendJson(res, 200, result);
    return true;
  }

  if (pathname.startsWith("/api/providers/oauth/")) {
    const rest = pathname.slice("/api/providers/oauth/".length);
    if (req.method === "GET" && !rest.includes("/")) {
      const sessionId = decodeURIComponent(rest);
      const session = hub.getProviderOAuth(sessionId);
      if (!session) {
        sendJson(res, 404, { error: "OAuth session not found" });
        return true;
      }
      sendJson(res, 200, { session });
      return true;
    }
    if (req.method === "POST" && rest.endsWith("/respond")) {
      const sessionId = decodeURIComponent(rest.slice(0, -"/respond".length));
      const body = (await readJsonBody(req)) as { promptId?: unknown; value?: unknown };
      const session = await hub.respondProviderOAuth(
        sessionId,
        typeof body.promptId === "string" ? body.promptId : undefined,
        typeof body.value === "string" ? body.value : String(body.value ?? ""),
      );
      sendJson(res, 200, { session });
      return true;
    }
    if (req.method === "POST" && rest.endsWith("/cancel")) {
      const sessionId = decodeURIComponent(rest.slice(0, -"/cancel".length));
      const session = hub.cancelProviderOAuth(sessionId);
      if (!session) {
        sendJson(res, 404, { error: "OAuth session not found" });
        return true;
      }
      sendJson(res, 200, { session });
      return true;
    }
  }

  if (pathname.startsWith("/api/providers/")) {
    const rest = pathname.slice("/api/providers/".length);
    if (req.method === "POST" && rest.endsWith("/api-key")) {
      const id = decodeURIComponent(rest.slice(0, -"/api-key".length));
      const body = (await readJsonBody(req)) as { apiKey?: unknown };
      const provider = await hub.setProviderApiKey(id, typeof body.apiKey === "string" ? body.apiKey : "");
      sendJson(res, 200, { provider });
      return true;
    }
    if (req.method === "DELETE" && rest.endsWith("/auth")) {
      const id = decodeURIComponent(rest.slice(0, -"/auth".length));
      const provider = await hub.logoutProvider(id);
      sendJson(res, 200, { ok: true, provider });
      return true;
    }
    if (req.method === "POST" && rest.endsWith("/refresh")) {
      const id = decodeURIComponent(rest.slice(0, -"/refresh".length));
      const provider = await hub.refreshProviderModels(id);
      sendJson(res, 200, { provider });
      return true;
    }
    if (req.method === "POST" && rest.endsWith("/oauth/start")) {
      const id = decodeURIComponent(rest.slice(0, -"/oauth/start".length));
      const session = await hub.startProviderOAuth(id);
      sendJson(res, 200, { session });
      return true;
    }
  }

  return false;
}
