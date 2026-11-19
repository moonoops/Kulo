import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { arr, int, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import type { ChatAttachment, UiCardInput } from "@moco/protocol";
import { MocoUiCards, type UiAssetPublicationInput, type UiCardSource } from "./ui-cards.js";
import { MocoStateDoc, isOrchestratorConversation } from "./state.js";
import { resolveDeferredAddTools } from "./tool-surface.js";

export interface ContentToolsOptions {
  get: () => MocoUiCards;
  scope: (api: ToolExecutionApi) => UiCardSource | Promise<UiCardSource>;
  /** Workers stage privately; only the main Agent may publish to the user. */
  publishAsset?: (input: UiAssetPublicationInput, api: ToolExecutionApi, context: Context) => Promise<ChatAttachment>;
  inspectAsset?: (input: UiAssetPublicationInput & { offset?: number; limit?: number }, api: ToolExecutionApi, context: Context) => ToolExecutionResult | Promise<ToolExecutionResult>;
}

function result(value: unknown) { return { output: [{ type: "text" as const, text: JSON.stringify(value) }], details: value as never }; }
const definition = {
  title: str(), spec: unknown(),
  actions: arr(obj({ id: str(), label: str(), kind: oneOf(["submit", "cancel"]), fields: opt(arr(unknown())) })),
  fallback_text: opt(str()),
};
function cardInput(args: { title: string; spec: unknown; actions: unknown[]; fallback_text?: string }): UiCardInput {
  return { title: args.title, spec: args.spec, actions: args.actions, ...(args.fallback_text ? { fallbackText: args.fallback_text } : {}) } as UiCardInput;
}

export function createContentToolsExtension(options: ContentToolsOptions) {
  const queues = new Map<number, Promise<unknown>>();
  // Preserve entry order for content calls entering this process, including a slow asset import.
  // Durable call receipts retain already published entries when Pi replays after a restart.
  const ordered = <T>(api: ToolExecutionApi, run: () => Promise<T>): Promise<T> => {
    const id = Number(api.conversationId);
    const prior = queues.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(run);
    queues.set(id, next);
    void next.then(() => { if (queues.get(id) === next) queues.delete(id); }, () => { if (queues.get(id) === next) queues.delete(id); });
    return next;
  };
  const publishAsset = (input: UiAssetPublicationInput, api: ToolExecutionApi, context: Context): Promise<ChatAttachment> => ordered(api, async () => {
    if (!options.publishAsset) throw new Error("当前环境无法发送文件。");
    return options.publishAsset(input, api, context);
  });
  const extension = defineExtension({
    name: "moco-content",
    tools: [
      defineTool({
        name: "moco_ui_show",
        description:
          "Publish a durable HeroUI v3 card in the active conversation (Orchestrator/Settings only). Read the `genui-cards` skill before building multi-element, table-selection, chart, or tabbed layouts. Minimal spec example: `{\"root\":\"main\",\"elements\":{\"main\":{\"type\":\"Stack\",\"props\":{\"gap\":\"md\"},\"children\":[\"q\",\"go\"]},\"q\":{\"type\":\"Choice\",\"props\":{\"field\":\"choice\",\"options\":[{\"value\":\"a\",\"label\":\"Option A\"}],\"required\":true}},\"go\":{\"type\":\"Button\",\"props\":{\"actionId\":\"ok\",\"label\":\"Confirm\",\"variant\":\"primary\"}}},\"state\":{\"values\":{}}}` with `actions: [{\"id\":\"ok\",\"label\":\"Confirm\",\"kind\":\"submit\"}]` (max 80 elements, depth 8; no JS/style/class/URLs).",
        parameters: obj(definition),
        replay: "safe",
        execute: (args, api, context) => ordered(api, async () => {
          const shown = await options.get().show(cardInput(args), await options.scope(api));
          const addTools = await resolveDeferredAddTools(api, context, ["moco_ui_update"]);
          return { ...result(shown), ...(addTools.length ? { control: { addTools } } : {}) };
        }),
      }),
      defineTool({
        name: "moco_ui_update",
        description:
          "Update an unsubmitted `ready` card in the active conversation by `card_id` and current `revision` without appending duplicate entries. 关键词：更新卡片 刷新面板 修改交互卡片",
        parameters: obj({ card_id: str(), revision: int({ minimum: 1 }), ...definition }),
        deferred: true,
        replay: "safe",
        execute: (args, api) => ordered(api, async () => result(await options.get().update({ cardId: args.card_id, revision: args.revision, ...cardInput(args) }, await options.scope(api)))),
      }),
      ...(options.publishAsset ? [defineTool({
        name: "moco_publish_asset",
        description:
          "Publish a verified file/media asset to chat (`status: \"published\"` confirms delivery; failed calls mean undelivered). When called by a Worker, stages privately as `pending_review` without delivering to the user. Pass `asset_id` for staged/existing assets, or `ticket_id` + `path` for prior ticket files. 关键词：发送文件 发布附件 导出图片 交付产物 分享文档",
        parameters: obj({ path: opt(str()), asset_id: opt(str()), ticket_id: opt(str()), name: opt(str()), mime_type: opt(str()), caption: opt(str()) }),
        deferred: true,
        replay: "safe",
        execute: async (args, api, context) => {
          const input: UiAssetPublicationInput = { path: args.path ?? (args.asset_id ? `asset:${args.asset_id}` : ""), ...(args.asset_id ? { assetId: args.asset_id } : {}), ...(args.ticket_id ? { ticketId: args.ticket_id } : {}), ...(args.name ? { name: args.name } : {}), ...(args.mime_type ? { mimeType: args.mime_type } : {}), ...(args.caption ? { caption: args.caption } : {}) };
          try {
            const asset = await publishAsset(input, api, context);
            const state = await api.snapshot(MocoStateDoc, context);
            return result({ ...asset, status: isOrchestratorConversation(api.conversationId, state) ? "published" : "pending_review" });
          }
          catch (error) { return { isError: true, output: [{ type: "text" as const, text: error instanceof Error ? error.message : "文件发送失败，未送达聊天。" }] }; }
        },
      })] : []),
      ...(options.inspectAsset ? [defineTool({
        name: "moco_inspect_asset",
        description:
          "Coordinating assistant only: inspect the real image or paginated text of a staged artifact (`asset_id`, or `ticket_id` + `path` for prior tickets) without publishing to the user. Continue via `nextOffset` for long files/HTML before deciding to publish or request Worker revisions. 关键词：查看附件 检查图片 预览产物 审查素材",
        parameters: obj({ asset_id: opt(str()), ticket_id: opt(str()), path: opt(str()), offset: opt(int({ minimum: 0 })), limit: opt(int({ minimum: 1, maximum: 24000 })) }),
        deferred: true,
        replay: "safe",
        execute: async (args, api, context) => {
          const input = { path: args.path ?? (args.asset_id ? `asset:${args.asset_id}` : ""), ...(args.asset_id ? { assetId: args.asset_id } : {}), ...(args.ticket_id ? { ticketId: args.ticket_id } : {}), offset: args.offset, limit: args.limit };
          try { return await options.inspectAsset!(input, api, context); }
          catch (error) { return { isError: true, output: [{ type: "text" as const, text: error instanceof Error ? error.message : "产物未能读取，尚未审核。" }] }; }
        },
      })] : []),
    ],
  });
  return Object.assign(extension, { publishAsset });
}
