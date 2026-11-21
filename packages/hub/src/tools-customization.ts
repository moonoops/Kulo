import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { CustomizationCaller, KuloCustomizationService } from "./customization.js";
import { CustomizationError } from "./customization-source.js";

export interface CustomizationToolsHost {
  service: () => KuloCustomizationService | Promise<KuloCustomizationService>;
  caller: (api: { conversationId: unknown; callId: string }) => CustomizationCaller | Promise<CustomizationCaller>;
  confirmValidate?: (
    sessionId: string,
    api: { conversationId: unknown; callId: string },
    caller: CustomizationCaller,
    service: KuloCustomizationService,
  ) => Promise<Record<string, unknown> | undefined>;
}
const output = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
const ACTIONS = ["status", "prepare", "read", "write", "validate", "cancel"] as const;
function requestFor(action: string, raw?: string): Record<string, unknown> {
  const fields: Record<string, { required: string[]; optional?: string[] }> = {
    status: { required: [] },
    prepare: { required: ["summary"] },
    read: { required: ["session_id", "path"] },
    write: { required: ["session_id", "path", "content", "expected_revision"] },
    validate: { required: ["session_id"], optional: ["ask_user"] },
    cancel: { required: ["session_id"] },
  };
  if (!Object.hasOwn(fields, action) || raw !== undefined && (typeof raw !== "string" || Buffer.byteLength(raw) > 2 * 1024 * 1024)) {
    throw new CustomizationError("invalid_customization_request", "定制请求无效或过大。", 400);
  }
  let value: unknown;
  try { value = JSON.parse(raw ?? "{}"); } catch { throw new CustomizationError("invalid_customization_request", "定制参数必须是 JSON 对象。", 400); }
  const spec = fields[action]!;
  const allowed = [...spec.required, ...(spec.optional ?? [])];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((field) => !allowed.includes(field))) throw new CustomizationError("invalid_customization_request", "定制参数包含无效字段。", 400);
  const request = value as Record<string, unknown>;
  for (const field of spec.required) {
    if (field === "content" && action === "write") {
      if (request[field] !== null && typeof request[field] !== "string") throw new CustomizationError("invalid_customization_request", "源码内容必须是文本，删除时使用 null。", 400);
    } else if (field === "expected_revision") {
      if (!Number.isSafeInteger(request[field]) || Number(request[field]) < 1) throw new CustomizationError("invalid_customization_request", "候选 revision 无效。", 400);
    } else if (typeof request[field] !== "string" || !(request[field] as string).length) throw new CustomizationError("invalid_customization_request", "定制请求缺少必要字段。", 400);
  }
  if (request.ask_user !== undefined && typeof request.ask_user !== "boolean") {
    throw new CustomizationError("invalid_customization_request", "ask_user 必须是布尔值。", 400);
  }
  return request;
}

export function createCustomizationToolsExtension(host: CustomizationToolsHost) {
  return defineExtension({
    name: "kulo-customization",
    tools: [
      defineTool({ name: "kulo_customization",
        description:
          "Managed Web UI self-customization (use only when explicitly asked to modify your own Web UI source; use settings/appearance tools for ordinary preferences). Supports `packages/web/{src,public,test}`: read before writing a candidate, then `validate` to stage for next launch (executes directly by default; pass `ask_user: true` in `validate` only if you want user confirmation first; check `currentReleaseId`/`applicationState` via `status`; never overwrite runtime/credential/recovery paths via shell). `request` JSON: `prepare{summary}`, `read{session_id,path}`, `write{session_id,path,content,expected_revision}`, `validate{session_id,ask_user?}`/`cancel{session_id}`. 关键词：客户端自改 桌面端界面源码定制 构建预览验证",
        parameters: obj({ action: oneOf(ACTIONS), request: opt(str()) }),
        deferred: true,
        execute: async ({ action, request }, api) => {
          const values = requestFor(action, request), caller = await host.caller(api), service = await host.service();
          switch (action) {
            case "status": return output(await service.status(caller));
            case "prepare": return output(await service.prepare({ summary: values.summary as string, commandId: "customization:" + api.callId }, caller));
            case "read": return output(await service.read(values.session_id as string, values.path as string, caller));
            case "write": return output(await service.write(values.session_id as string, values.path as string, values.content as string | null, values.expected_revision as number, caller));
            case "validate": {
              if (values.ask_user === true) {
                const pending = await host.confirmValidate?.(values.session_id as string, api, caller, service);
                if (pending) return output(pending);
              }
              return output(await service.validateAndStage(values.session_id as string, caller));
            }
            case "cancel": return output(await service.cancel(values.session_id as string, caller));
          }
        } }),
      defineTool({ name: "kulo_official_update", description: "Stage an official Kulo release update from the host's configured trusted source while preserving validated customizations (takes effect on next launch). 关键词：检查官方更新 升级软件版本 安装新版本", parameters: obj({}), deferred: true, replay: "safe",
        execute: async (_args, api) => output(await (await host.service()).installOfficial(undefined, await host.caller(api))) }),
    ],
  });
}
