import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapabilityConfigurationInput, ImageDraftUpdateRequest, ImageRoutingConfigurationInput } from "@kulo/protocol";
import { CapabilityError } from "./capabilities.js";
import { imageSetupIdentifier } from "./image-configuration.js";
import type { KuloHub } from "./hub.js";

type ReadBody = (request: IncomingMessage) => Promise<Record<string, unknown>>;
type Send = (response: ServerResponse, status: number, value: unknown) => void;

function allowed(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some((key) => !fields.includes(key))) throw new CapabilityError(400, "invalid_image_setup_request", "图像配置请求包含无效字段。");
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new CapabilityError(400, "invalid_image_setup_revision", "图像配置版本无效。");
  return Number(value);
}

/** Called only after the management authenticator accepts the request. */
export async function handleImageConfigurationHttp(hub: KuloHub, req: IncomingMessage, res: ServerResponse, url: URL, read: ReadBody, send: Send): Promise<boolean> {
  const prefix = "/api/capabilities/image/";
  if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length);
  res.setHeader("cache-control", "no-store");
  if (path === "draft" && req.method === "POST") {
    const body = await read(req); allowed(body, ["clientId", "config", "expectedRevision"]);
    send(res, 200, await hub.imageConfiguration.updateDraft(body as unknown as ImageDraftUpdateRequest));
    return true;
  }
  if (path === "draft" && req.method === "DELETE") {
    const body = await read(req); allowed(body, ["clientId", "expectedRevision"]);
    await hub.imageConfiguration.discardDraft(imageSetupIdentifier(body.clientId, "窗口标识"), body.expectedRevision === undefined ? undefined : revision(body.expectedRevision));
    send(res, 200, { removed: true }); return true;
  }
  if (path === "draft/save" && req.method === "POST") {
    const body = await read(req); allowed(body, ["clientId", "expectedRevision", "commandId"]);
    send(res, 200, await hub.imageConfiguration.saveDraft({ clientId: imageSetupIdentifier(body.clientId, "窗口标识"), expectedRevision: revision(body.expectedRevision), commandId: imageSetupIdentifier(body.commandId, "操作标识") }));
    return true;
  }
  if (path === "discover" && (req.method === "POST" || req.method === "GET")) {
    const body = req.method === "POST" ? await read(req) : { clientId: url.searchParams.get("clientId") };
    allowed(body, ["clientId", "providerIds"]);
    send(res, 200, await hub.imageConfiguration.discover(imageSetupIdentifier(body.clientId, "窗口标识"), body.providerIds as string[] | undefined));
    return true;
  }
  if (path === "import" && req.method === "POST") {
    const body = await read(req); allowed(body, ["clientId", "discoveryId", "candidateIds", "commandId", "allowTaskGeneration"]);
    send(res, 200, await hub.imageConfiguration.importModels(body as unknown as Parameters<KuloHub["imageConfiguration"]["importModels"]>[0]));
    return true;
  }
  if (path === "routing" && req.method === "PUT") {
    const body = await read(req); allowed(body, ["settings", "expectedRevision", "commandId"]);
    const result = await hub.capabilities.configureRouting(body as unknown as ImageRoutingConfigurationInput);
    send(res, 200, result.settings); return true;
  }
  const match = /^([^/]+)(?:\/(check|test))?$/.exec(path);
  if (!match) { send(res, 404, { error: "图像配置操作不存在。" }); return true; }
  let id: string;
  try { id = imageSetupIdentifier(decodeURIComponent(match[1]!), "图像能力标识"); }
  catch { throw new CapabilityError(400, "invalid_image_capability_id", "图像能力标识无效。"); }
  const snapshot = await hub.capabilities.snapshot();
  const capability = snapshot.capabilities.find((item) => item.id === id && item.kind === "image");
  if (!capability) throw new CapabilityError(404, "image_capability_not_found", "图像能力不存在。");
  if (match[2] === "check" && req.method === "POST") {
    const body = await read(req); allowed(body, []);
    send(res, 200, await hub.capabilities.check(id)); return true;
  }
  if (match[2] === "test" && req.method === "POST") {
    const body = await read(req); allowed(body, ["clientId", "commandId", "prompt"]);
    if (body.prompt !== undefined && (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 32_000)) throw new CapabilityError(400, "invalid_image_test_prompt", "测试提示词无效。");
    send(res, 200, await hub.testImageCapability(id, { clientId: imageSetupIdentifier(body.clientId, "窗口标识"), commandId: imageSetupIdentifier(body.commandId, "操作标识"), prompt: body.prompt as string | undefined }));
    return true;
  }
  if (!match[2] && req.method === "DELETE") {
    const body = await read(req); allowed(body, ["expectedRevision", "commandId"]);
    await hub.capabilities.remove(id, revision(body.expectedRevision), imageSetupIdentifier(body.commandId, "操作标识"));
    send(res, 200, { removed: true }); return true;
  }
  if (!match[2] && req.method === "PATCH") {
    const body = await read(req); allowed(body, ["enabled", "isDefault", "allowTaskGeneration", "expectedRevision", "commandId"]);
    if ((typeof body.enabled !== "boolean" && typeof body.isDefault !== "boolean" && typeof body.allowTaskGeneration !== "boolean") ||
      (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
      (body.isDefault !== undefined && typeof body.isDefault !== "boolean") ||
      (body.allowTaskGeneration !== undefined && typeof body.allowTaskGeneration !== "boolean")) throw new CapabilityError(400, "invalid_image_preferences", "图像能力偏好无效。");
    const connection = snapshot.connections.find((item) => item.id === capability.connectionId)!;
    const config: CapabilityConfigurationInput = { commandId: imageSetupIdentifier(body.commandId, "操作标识"), id, expectedRevision: revision(body.expectedRevision),
      name: capability.name, adapter: connection.adapter, modelId: capability.modelId, baseUrl: connection.baseUrl,
      credentialProviderId: connection.credentialProviderId, imageProfile: capability.imageProfile, defaults: capability.defaults, routing: capability.routing, customAdapter: connection.customAdapter,
      enabled: body.enabled as boolean | undefined ?? capability.enabled, isDefault: body.isDefault as boolean | undefined ?? capability.isDefault,
      allowTaskGeneration: body.allowTaskGeneration as boolean | undefined ?? capability.allowTaskGeneration, maxOutputs: capability.maxOutputs };
    send(res, 200, await hub.capabilities.configure(config)); return true;
  }
  send(res, 405, { error: "此图像配置操作不支持该请求方法。" }); return true;
}
