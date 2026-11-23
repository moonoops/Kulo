import { randomUUID } from "node:crypto";
import {
  isAssistantItemAction,
  isNativeAppPermissionKind,
  type ConnectionPrepareRequest,
  type ConnectionSaveRequest,
  type HomeAssistantAnnounceConfig,
  type HomeAssistantSentinelConfig,
} from "@kulo/protocol";
import { handleComposioRoutes } from "../composio-routes.js";
import { isNonPublicMcpUrl } from "../mcp-presets.js";
import { VoiceError } from "../voice-service.js";
import { assertHttpSameOrigin, type HubHttpRouteContext } from "./context.js";

/**
 * Handles `/api/voice*`, `/api/assistant*` (excluding `/api/assistant/stream` SSE,
 * which MUST match in `server.ts` first), and `/api/connections*` business REST routes.
 */
export async function handleVoiceAssistantConnectionsRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const {
    hub,
    req,
    res,
    parsedUrl,
    pathname,
    authority,
    readJsonObject,
    sendJson,
    currentDevice,
    isHubSecret,
    openNativePermissionSettings,
  } = ctx;
  const hostFlags = () => ({ localHost: authority.isHubLocalDisplay, canManageHub: authority.hasOwnerHubControl });

  if (pathname === "/api/voice" || pathname.startsWith("/api/voice/")) {
    res.setHeader("cache-control", "no-store");
    if (pathname === "/api/voice" && req.method === "GET") {
      const snapshot = await hub.voice.snapshot();
      sendJson(res, 200, snapshot);
      if (snapshot.asr.enabled && snapshot.asr.status === "unprepared") {
        void hub.voice.prepareAsr().catch((error: unknown) =>
          console.warn("[KuloVoice]", hub.connectionManager.redact(error instanceof Error ? error.message : String(error))),
        );
      }
      return true;
    }
    if (pathname === "/api/voice" && req.method === "PUT") {
      const body = await readJsonObject(req);
      for (const section of [body.tts, body.call]) {
        const key = section && typeof section === "object" && "apiKey" in section ? section.apiKey : undefined;
        if (typeof key === "string" && isHubSecret(key)) {
          throw new VoiceError(400, "invalid_voice_credential", "语音服务需要独立的 API Key。");
        }
      }
      sendJson(res, 200, await hub.voice.configure(body as never));
      return true;
    }
    if (pathname === "/api/voice/asr/prepare" && req.method === "POST") {
      await hub.voice.prepareAsr();
      sendJson(res, 200, await hub.voice.snapshot());
      return true;
    }
    if (pathname === "/api/voice/call/probe" && req.method === "POST") {
      sendJson(res, 200, await hub.voice.probeCall());
      return true;
    }
    if (pathname === "/api/voice/transcribe" && req.method === "POST") {
      const body = await readJsonObject(req);
      if (
        Object.keys(body).some((key) => !["assetId", "topicId", "projectId", "clientId"].includes(key)) ||
        typeof body.assetId !== "string" ||
        (body.topicId !== undefined && typeof body.topicId !== "string")
      ) {
        throw new VoiceError(400, "invalid_voice_transcription", "语音转文字请求无效。");
      }
      const attachment = await hub.transcribeVoiceAsset(body.assetId, {
        topicId: body.topicId as string | undefined,
        principalId: currentDevice(req, parsedUrl),
      });
      sendJson(res, 200, { transcript: attachment.transcript });
      return true;
    }
    if (pathname === "/api/voice/synthesize" && req.method === "POST") {
      const body = await readJsonObject(req);
      if (
        Object.keys(body).some((key) => !["text", "clientId", "preview"].includes(key)) ||
        typeof body.text !== "string" ||
        (body.preview !== undefined && typeof body.preview !== "boolean")
      ) {
        throw new VoiceError(400, "invalid_voice_synthesis", "语音合成请求无效。");
      }
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", onClose);
      try {
        const audio = await hub.voice.synthesize(body.text, controller.signal, {
          preview: body.preview === true,
          cleanMarkdown: body.preview !== true,
        });
        if (!res.destroyed) {
          res.writeHead(200, {
            "content-type": audio.mimeType,
            "content-length": audio.bytes.length,
            "x-content-type-options": "nosniff",
          });
          res.end(audio.bytes);
        }
      } finally {
        res.off("close", onClose);
      }
      return true;
    }
    if (pathname === "/api/voice/calls" && req.method === "POST") {
      const body = await readJsonObject(req);
      if (
        Object.keys(body).some((key) => !["topicId", "projectId", "clientId", "commandId"].includes(key)) ||
        typeof body.topicId !== "string" ||
        typeof body.clientId !== "string" ||
        typeof body.commandId !== "string"
      ) {
        throw new VoiceError(400, "invalid_voice_call", "通话请求无效。");
      }
      sendJson(
        res,
        201,
        await hub.voiceCalls.create({
          topicId: body.topicId,
          clientId: body.clientId,
          commandId: body.commandId,
          principalId: currentDevice(req, parsedUrl),
        }),
      );
      return true;
    }
    const callRoute = /^\/api\/voice\/calls\/([^/]+)$/.exec(pathname);
    if (callRoute && req.method === "DELETE") {
      await hub.voiceCalls.end(decodeURIComponent(callRoute[1]!), currentDevice(req, parsedUrl));
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 404, { error: "语音接口不存在" });
    return true;
  }

  if (pathname === "/api/assistant" || pathname.startsWith("/api/assistant/")) {
    res.setHeader("cache-control", "no-store");
    if (pathname === "/api/assistant" && req.method === "GET") {
      sendJson(res, 200, { ...(await hub.getAssistantWorkspace()), ...hostFlags() });
      return true;
    }
    if (pathname === "/api/assistant/configure" && req.method === "POST") {
      const body = await readJsonObject(req, 64 * 1024);
      sendJson(res, 200, {
        ...(await hub.configureAssistantNotifications({
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(typeof body.muteApp === "string" ? { muteApp: body.muteApp } : {}),
          ...(typeof body.unmuteApp === "string" ? { unmuteApp: body.unmuteApp } : {}),
        })),
        ...hostFlags(),
      });
      return true;
    }
    if (pathname === "/api/assistant/background-model" && req.method === "GET") {
      if (!authority.hasOwnerHubControl || authority.isSshPrincipal) {
        throw Object.assign(new Error("请通过受信任的 Kulo 客户端查看后台处理模型。"), { status: 403 });
      }
      const includeAdvice = parsedUrl.searchParams.get("includeAdvice") === "1";
      const backgroundModel = await hub.ambientModel.status();
      sendJson(res, 200, {
        backgroundModel,
        ...(includeAdvice ? { advice: hub.ambientModel.advise() } : {}),
        ...hostFlags(),
      });
      return true;
    }
    if (pathname === "/api/assistant/background-model" && req.method === "POST") {
      assertHttpSameOrigin(ctx, {
        code: "assistant_origin_required",
        message: "请在 Kulo 中修改后台处理模型。",
      });
      if (!authority.hasOwnerHubControl || authority.isSshPrincipal) {
        throw Object.assign(new Error("请通过受信任的 Kulo 客户端修改后台处理模型。"), { status: 403 });
      }
      const body = await readJsonObject(req, 64 * 1024);
      const mode = body.mode;
      if (mode !== "auto" && mode !== "local-managed" && mode !== "kulo-provider") {
        throw Object.assign(new Error("后台模型模式无效。"), { status: 400 });
      }
      const includeWorkspace = parsedUrl.searchParams.get("includeWorkspace") === "1";
      const engine = body.engine === "omlx" || body.engine === "ollama" ? body.engine : undefined;
      if (mode === "local-managed") {
        const advice = hub.ambientModel.advise();
        const targetEngine = engine ?? advice.recommendedEngine ?? "omlx";
        const targetModelId =
          (typeof body.modelId === "string" ? body.modelId.trim() : "") ||
          advice.recommendedModelId ||
          "mlx-community/Qwen3-4B-Instruct-2507-4bit";
        if (body.confirmed !== true) {
          const backgroundModel = await hub.ambientModel.status();
          sendJson(res, 200, {
            requiresConfirmation: true,
            proposal: {
              host: advice.hostName,
              engine: targetEngine,
              modelId: targetModelId,
              estimatedRamGb: advice.estimatedRamGb,
              reason: advice.reason,
            },
            backgroundModel,
            ...(includeWorkspace ? { snapshot: await hub.getAssistantWorkspace() } : {}),
            ...hostFlags(),
          });
          return true;
        }
        const backgroundModel = await hub.ambientModel.deployLocalManaged({
          engine: targetEngine,
          modelId: targetModelId,
        });
        sendJson(res, 200, {
          backgroundModel,
          ...(includeWorkspace ? { snapshot: await hub.getAssistantWorkspace() } : {}),
          ...hostFlags(),
        });
        return true;
      }
      if (mode === "kulo-provider") {
        const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
        const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
        if (!providerId || !modelId) {
          throw Object.assign(new Error("请选择有效的供应商与对话模型。"), { status: 400 });
        }
      }
      const backgroundModel = await hub.ambientModel.configureAutoOrProvider({
        mode,
        ...(typeof body.providerId === "string" ? { providerId: body.providerId } : {}),
        ...(typeof body.modelId === "string" ? { modelId: body.modelId } : {}),
      });
      sendJson(res, 200, {
        backgroundModel,
        ...(includeWorkspace ? { snapshot: await hub.getAssistantWorkspace() } : {}),
        ...hostFlags(),
      });
      return true;
    }
    if (pathname === "/api/assistant/spark" && req.method === "POST") {
      const body = await readJsonObject(req, 32 * 1024);
      if (typeof body.enabled !== "boolean") {
        throw Object.assign(new Error("缺少 Spark Mail 开关参数。"), { status: 400 });
      }
      await hub.configureAssistantSpark({ enabled: body.enabled });
      sendJson(res, 200, { ...(await hub.getAssistantWorkspace()), ...hostFlags() });
      return true;
    }
    if (pathname === "/api/assistant/home-assistant" && req.method === "POST") {
      const body = await readJsonObject(req, 64 * 1024);
      if (body.deployLocal === true) {
        assertHttpSameOrigin(ctx, {
          code: "assistant_origin_required",
          message: "请在 Kulo 中部署 Home Assistant 容器。",
        });
        if (!authority.hasOwnerHubControl) {
          throw Object.assign(new Error("请通过受信任的 Kulo 客户端在主机上部署 Home Assistant 容器。"), { status: 403 });
        }
        const deployed = await hub.homeAssistant.deployLocalContainer({
          confirmed: body.confirmed === true,
          installXiaomiHome: body.installXiaomiHome !== false,
        });
        sendJson(res, 200, {
          ...deployed,
          snapshot: await hub.getAssistantWorkspace(),
          ...hostFlags(),
        });
        return true;
      }
      await hub.configureAssistantHomeAssistant({
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
        ...(typeof body.token === "string" ? { token: body.token } : {}),
        ...(body.clearToken === true ? { clearToken: true } : {}),
        ...(body.sentinel && typeof body.sentinel === "object" && !Array.isArray(body.sentinel)
          ? { sentinel: body.sentinel as Partial<HomeAssistantSentinelConfig> }
          : {}),
        ...(body.announce && typeof body.announce === "object" && !Array.isArray(body.announce)
          ? { announce: body.announce as Partial<HomeAssistantAnnounceConfig> }
          : {}),
      });
      sendJson(res, 200, { ...(await hub.getAssistantWorkspace()), ...hostFlags() });
      return true;
    }
    if (pathname === "/api/assistant/home-assistant/migration" && req.method === "GET") {
      sendJson(res, 200, await hub.homeAssistant.adviseMigration());
      return true;
    }
    if (pathname === "/api/assistant/home-assistant/entities" && req.method === "GET") {
      const domain = parsedUrl.searchParams.get("domain") ?? undefined;
      const area = parsedUrl.searchParams.get("area") ?? undefined;
      const query = parsedUrl.searchParams.get("q") ?? undefined;
      const includeAttributes = parsedUrl.searchParams.get("attributes") !== "0";
      sendJson(
        res,
        200,
        hub.homeAssistant.listEntities({
          ...(domain ? { domain } : {}),
          ...(area ? { area } : {}),
          ...(query ? { query } : {}),
          includeAttributes,
        }),
      );
      return true;
    }
    if (pathname === "/api/assistant/lark" && req.method === "POST") {
      const body = await readJsonObject(req, 32 * 1024);
      if (body.syncNow === true) {
        const sync = await hub.larkConnector.syncNow();
        sendJson(res, 200, { sync, snapshot: await hub.getAssistantWorkspace(), ...hostFlags() });
        return true;
      }
      await hub.configureAssistantLark({
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(Array.isArray(body.selectedProfiles)
          ? { selectedProfiles: body.selectedProfiles.filter((item): item is string => typeof item === "string") }
          : {}),
      });
      sendJson(res, 200, { ...(await hub.getAssistantWorkspace()), ...hostFlags() });
      return true;
    }
    if (pathname === "/api/assistant/items" && req.method === "GET") {
      sendJson(res, 200, await hub.getAssistantItemsSnapshot());
      return true;
    }
    const itemActionMatch = /^\/api\/assistant\/items\/([^/]+)\/action$/.exec(pathname);
    if (itemActionMatch && req.method === "POST") {
      const body = await readJsonObject(req, 32 * 1024);
      const itemId = decodeURIComponent(itemActionMatch[1]!);
      const action = body.action;
      const expectedRevision = body.expectedRevision;
      if (!isAssistantItemAction(action) || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision)) {
        throw Object.assign(new Error("提醒动作参数无效。"), { status: 400 });
      }
      const commandId =
        typeof body.commandId === "string" && body.commandId.trim() ? body.commandId.trim() : `http:${randomUUID()}`;
      const ack = await hub.deliverClientMessage(
        { type: "assistant.item_action", itemId, expectedRevision, action, commandId },
        currentDevice(req, parsedUrl),
      );
      sendJson(res, 200, ack);
      return true;
    }
    sendJson(res, 404, { error: "Not found" });
    return true;
  }

  if (pathname === "/api/connections" || pathname.startsWith("/api/connections/")) {
    res.setHeader("cache-control", "no-store");
    const assertSameOrigin = () =>
      assertHttpSameOrigin(ctx, {
        code: "connection_origin_required",
        message: "请在 Kulo 中执行此连接管理操作。",
      });
    const requiresLocalHostForMcp = (
      payload: Record<string, unknown>,
      existing?: { kind?: unknown; mcpTransport?: unknown; url?: unknown },
    ): boolean => {
      const kind = payload.kind ?? existing?.kind;
      if (kind !== "mcp") return false;
      const transport = payload.mcpTransport ?? (payload.mcpCommand !== undefined ? "stdio" : existing?.mcpTransport ?? "http");
      if (transport === "stdio" || existing?.mcpTransport === "stdio") return true;
      const candidateUrl =
        typeof payload.url === "string" ? payload.url : typeof existing?.url === "string" ? existing.url : undefined;
      if (candidateUrl && isNonPublicMcpUrl(candidateUrl)) return true;
      if (typeof existing?.url === "string" && isNonPublicMcpUrl(existing.url)) return true;
      return false;
    };
    const assertLocalMcpAccess = (
      payload: Record<string, unknown>,
      existing?: { kind?: unknown; mcpTransport?: unknown; url?: unknown },
    ) => {
      if (!requiresLocalHostForMcp(payload, existing)) return;
      assertSameOrigin();
      if (!authority.hasOwnerHubControl) {
        throw Object.assign(new Error("本机命令（Stdio）或内网/环回地址的 MCP 连接请通过受信任的 Kulo 客户端配置。"), {
          status: 403,
          code: "connection_mcp_local_host_required",
        });
      }
    };
    if (pathname === "/api/connections" && req.method === "GET") {
      const clientId = parsedUrl.searchParams.get("clientId") ?? undefined;
      if (clientId && (clientId.length > 160 || /[\x00-\x20\x7f]/.test(clientId))) {
        throw Object.assign(new Error("窗口标识无效。"), { status: 400 });
      }
      sendJson(res, 200, {
        ...(await hub.connectionManager.snapshot(clientId)),
        ...hostFlags(),
      });
      return true;
    }
    if (pathname === "/api/connections" && req.method === "POST") {
      const body = await readJsonObject(req, 5 * 1024 * 1024);
      const existing = typeof body.id === "string" ? hub.connectionManager.getConnectionRecord(body.id) : undefined;
      assertLocalMcpAccess(body, existing);
      sendJson(res, 201, { connection: await hub.connectionManager.save(body as unknown as ConnectionSaveRequest) });
      return true;
    }
    if (pathname === "/api/connections/prepare" && req.method === "POST") {
      const body = await readJsonObject(req);
      const existing =
        typeof body.connectionId === "string" ? hub.connectionManager.getConnectionRecord(body.connectionId) : undefined;
      assertLocalMcpAccess(body, existing);
      sendJson(res, 201, await hub.connectionManager.prepare(body as unknown as ConnectionPrepareRequest));
      return true;
    }
    if (pathname === "/api/connections/permission-settings") {
      if (req.method !== "POST") {
        sendJson(res, 405, {
          error: "此系统权限接口不支持该操作。",
          code: "connection_permission_settings_method_not_allowed",
        });
        return true;
      }
      assertHttpSameOrigin(ctx, {
        code: "connection_permission_settings_origin_required",
        message: "请在 Kulo 中打开系统权限设置。",
      });
      if (!authority.isHubLocalDisplay) {
        throw Object.assign(new Error("请在主脑 Mac 上打开系统设置完成授权。"), {
          status: 403,
          code: "connection_permission_settings_remote",
        });
      }
      const body = await readJsonObject(req, 1024);
      if (Object.keys(body).some((key) => key !== "kind") || !isNativeAppPermissionKind(body.kind)) {
        throw Object.assign(new Error("系统权限类型无效。"), { status: 400, code: "connection_app_invalid_parameters" });
      }
      await openNativePermissionSettings(body.kind);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (await handleComposioRoutes({ req, res, pathname, connections: hub.connectionManager, assertSameOrigin, readJsonObject, sendJson })) {
      return true;
    }
    const oauthSession = /^\/api\/connections\/oauth\/([^/]+)(?:\/(complete|cancel))?$/.exec(pathname);
    if (oauthSession) {
      assertSameOrigin();
      const sessionId = decodeURIComponent(oauthSession[1]!);
      const principalId = currentDevice(req, parsedUrl);
      if (!oauthSession[2] && req.method === "GET") {
        const clientId = parsedUrl.searchParams.get("clientId") ?? undefined;
        sendJson(res, 200, { session: hub.connectionManager.mcpOAuth.get(sessionId, { clientId, principalId }) });
        return true;
      }
      if (oauthSession[2] === "complete" && req.method === "POST") {
        const body = await readJsonObject(req, 16_384);
        const clientId = typeof body.clientId === "string" ? body.clientId : undefined;
        const redirectUrl = typeof body.redirectUrl === "string" ? body.redirectUrl : "";
        if (!redirectUrl.trim()) {
          throw Object.assign(new Error("请粘贴浏览器跳转后的回调地址。"), {
            status: 400,
            code: "connection_oauth_invalid_redirect",
          });
        }
        sendJson(res, 200, {
          session: await hub.connectionManager.mcpOAuth.complete(sessionId, { clientId, principalId }, redirectUrl.trim()),
        });
        return true;
      }
      if (oauthSession[2] === "cancel" && req.method === "POST") {
        const body = await readJsonObject(req, 4_096);
        const clientId = typeof body.clientId === "string" ? body.clientId : undefined;
        sendJson(res, 200, { session: await hub.connectionManager.mcpOAuth.cancel(sessionId, { clientId, principalId }) });
        return true;
      }
    }
    const oauthStart = /^\/api\/connections\/([^/]+)\/oauth\/start$/.exec(pathname);
    if (oauthStart && req.method === "POST") {
      assertSameOrigin();
      const id = decodeURIComponent(oauthStart[1]!);
      const body = await readJsonObject(req, 4_096);
      const clientId = typeof body.clientId === "string" && body.clientId.length <= 160 ? body.clientId : undefined;
      const principalId = currentDevice(req, parsedUrl);
      sendJson(res, 200, {
        session: await hub.connectionManager.mcpOAuth.start({
          connectionId: id,
          owner: { clientId, principalId },
          forceReauth: body.forceReauth === true,
        }),
      });
      return true;
    }
    const input = /^\/api\/connections\/inputs\/([^/]+)\/(submit|cancel)$/.exec(pathname);
    if (input && req.method === "POST") {
      const body = await readJsonObject(req, 5 * 1024 * 1024);
      if (typeof body.clientId !== "string" || !body.clientId || body.clientId.length > 160) {
        throw Object.assign(new Error("窗口标识无效。"), { status: 400 });
      }
      const id = decodeURIComponent(input[1]!);
      if (input[2] === "submit") {
        const pendingInput = hub.connectionManager.getPendingInput(id);
        const existingRecord = pendingInput?.connectionId
          ? hub.connectionManager.getConnectionRecord(pendingInput.connectionId)
          : undefined;
        assertLocalMcpAccess(body, existingRecord ?? pendingInput);
        sendJson(res, 200, {
          connection: await hub.connectionManager.submitInput(id, body.clientId, body as unknown as ConnectionSaveRequest),
        });
      } else {
        await hub.connectionManager.cancelInput(id, body.clientId);
        sendJson(res, 200, { ok: true });
      }
      return true;
    }
    const connection = /^\/api\/connections\/([^/]+)(?:\/(test|trust))?$/.exec(pathname);
    if (connection) {
      const id = decodeURIComponent(connection[1]!);
      if (!connection[2] && req.method === "DELETE") {
        await hub.removeConnection(id);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (connection[2] === "test" && req.method === "POST") {
        const body = await readJsonObject(req, 1024);
        if (Object.keys(body).some((key) => key !== "rescan") || body.rescan !== undefined && typeof body.rescan !== "boolean") {
          throw Object.assign(new Error("连接测试参数无效。"), { status: 400, code: "invalid_connection" });
        }
        sendJson(res, 200, await hub.connectionManager.test(id, body.rescan === true ? { rescan: true } : undefined));
        return true;
      }
      if (connection[2] === "trust" && req.method === "POST") {
        const body = await readJsonObject(req);
        if (typeof body.fingerprint !== "string") {
          throw Object.assign(new Error("服务器指纹无效。"), { status: 400 });
        }
        sendJson(res, 200, { connection: await hub.connectionManager.trust(id, body.fingerprint) });
        return true;
      }
    }
    sendJson(res, 404, { error: "连接操作不存在。" });
    return true;
  }

  return false;
}
