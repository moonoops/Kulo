import type { IncomingMessage, ServerResponse } from "node:http";
import type { ModelConfigurationPrepareRequest, ModelConfigurationUpdateRequest } from "@moco/protocol";
import { ModelConfigurationError, type MocoModelConfiguration } from "./model-configuration.js";

type ReadBody = (request: IncomingMessage) => Promise<Record<string, unknown>>;
type Send = (response: ServerResponse, status: number, value: unknown) => void;
function allowed(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some((key) => !fields.includes(key))) throw new ModelConfigurationError(400, "invalid_model_configuration_request", "模型配置请求包含无效字段。");
}

/** The owning server authenticates management requests before dispatching here. */
export async function handleModelConfigurationHttp(service: MocoModelConfiguration, req: IncomingMessage, res: ServerResponse, url: URL, read: ReadBody, send: Send): Promise<boolean> {
  const prefix = "/api/settings/model-configuration";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  res.setHeader("cache-control", "no-store");
  const path = url.pathname.slice(prefix.length);
  try {
    if (!path && req.method === "GET") { send(res, 200, await service.workspace(url.searchParams.get("clientId") as string)); return true; }
    const body = await read(req);
    if (path === "/prepare" && req.method === "POST") {
      allowed(body, ["clientId", "providerId", "name", "api", "baseUrl", "preset"]);
      send(res, 200, await service.prepare(body as unknown as ModelConfigurationPrepareRequest)); return true;
    }
    if (path === "/draft" && req.method === "PUT") {
      allowed(body, ["clientId", "draftId", "expectedRevision", "provider", "selectedModelIds", "defaultModelId"]);
      send(res, 200, await service.updateDraft(body as unknown as ModelConfigurationUpdateRequest)); return true;
    }
    if (path === "/credential" && req.method === "POST") {
      allowed(body, ["clientId", "draftId", "expectedRevision", "apiKey"]);
      send(res, 200, await service.supplyCredential(body as unknown as Parameters<MocoModelConfiguration["supplyCredential"]>[0])); return true;
    }
    if (path === "/discover" && req.method === "POST") {
      allowed(body, ["clientId", "draftId", "expectedRevision"]);
      send(res, 200, await service.discover(body.clientId as string, body.expectedRevision as number, body.draftId as string | undefined)); return true;
    }
    if (path === "/test" && req.method === "POST") {
      allowed(body, ["clientId", "draftId", "expectedRevision", "modelId", "commandId"]);
      const controller = new AbortController();
      const closed = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", closed);
      try { send(res, 200, await service.test(body as unknown as Parameters<MocoModelConfiguration["test"]>[0], controller.signal)); }
      finally { res.removeListener("close", closed); }
      return true;
    }
    if (path === "/save" && req.method === "POST") {
      allowed(body, ["clientId", "draftId", "expectedRevision", "commandId"]);
      send(res, 200, await service.save(body as unknown as Parameters<MocoModelConfiguration["save"]>[0])); return true;
    }
    if (path === "/draft" && req.method === "DELETE") {
      allowed(body, ["clientId", "draftId", "expectedRevision"]);
      await service.discard(body.clientId as string, body.expectedRevision as number, body.draftId as string | undefined); send(res, 200, { removed: true }); return true;
    }
    send(res, 404, { error: "模型配置操作不存在。" }); return true;
  } catch (cause) {
    if (!(cause instanceof ModelConfigurationError)) throw cause;
    send(res, cause.status, { error: cause.message, code: cause.code }); return true;
  }
}
