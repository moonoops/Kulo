/**
 * Pi-Durable Tool Bindings for Kulo Built-in Memory (`kulo_memory_recall` & `kulo_memory_retain`).
 * Mirrors `tools-memory.ts` server-side dual-bank authorization (`private` vs `shared`)
 * without exposing Hindsight-only concepts (Pages, Mental Models, Reflect, Operations).
 */
import { defineTool } from "@earendil-works/pi-durable";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type {
  BuiltinMemoryCategory,
  BuiltinMemoryScopeKind,
  MemoryBank,
} from "@kulo/protocol";
import type { MemoryCallerContext } from "./hindsight.js";
import type { BuiltinMemoryRecallHit } from "./builtin-memory-query.js";
import { KuloStateDoc } from "./state.js";
import { SettingsAssistantDoc } from "./settings-doc.js";
import { memoryCallerFromState } from "./tools-memory.js";

export interface BuiltinMemoryToolPort {
  isEffectiveActive: () => boolean;
  isSharedEffectiveActive: () => boolean;
  retainFromTool: (input: {
    caller: MemoryCallerContext;
    bank: MemoryBank;
    content: string;
    scope?: BuiltinMemoryScopeKind;
    category?: BuiltinMemoryCategory;
    callId: string;
  }) => Promise<{ id: string; bank: MemoryBank; inserted: boolean }>;
  recallForTool: (input: {
    caller: MemoryCallerContext;
    bank: MemoryBank;
    query: string;
    scope?: BuiltinMemoryScopeKind;
    limit?: number;
  }) => Promise<BuiltinMemoryRecallHit[]>;
}

export function createBuiltinMemoryTools(options: {
  port: BuiltinMemoryToolPort;
  defaultBank: MemoryBank;
}) {
  type ToolExecApi = Parameters<Parameters<typeof defineTool>[0]["execute"]>[1];
  type ToolExecCtx = Parameters<Parameters<typeof defineTool>[0]["execute"]>[2];

  const resolveCaller = async (api: ToolExecApi, context: ToolExecCtx): Promise<MemoryCallerContext> => {
    const [state, settings] = await Promise.all([
      api.snapshot(KuloStateDoc, context),
      api.snapshot(SettingsAssistantDoc, context),
    ]);
    return memoryCallerFromState(state, api.conversationId, api.callId, settings);
  };

  const bankParam = opt(
    oneOf(options.defaultBank === "shared" ? ["shared"] : ["private", "shared"], {
      description: "Target bank ('private' personal, 'shared' project).",
    }),
  );

  const retainTool = defineTool({
    name: "kulo_memory_retain",
    description:
      "Save a durable preference, decision, or verified fact to built-in memory (no secrets). Router writes 'private'; Workers write 'shared'. 关键词：记住 保存记忆 写入长期记忆",
    replay: "safe",
    outputLimits: { maxBytes: 2_000, maxLines: 40 },
    parameters: obj({
      content: str({ description: "Concise fact (no secrets, <= 1200 chars)." }),
      scope: opt(
        oneOf(["global", "project", "topic"], {
          description: "Private scope ('global' | 'project' | 'topic').",
        }),
      ),
      category: opt(
        oneOf(["commitment", "decision", "fact"], {
          description: "Category ('decision' | 'commitment' | 'fact').",
        }),
      ),
      bank: bankParam,
    }),
    execute: async (args, api, context) => {
      try {
        if (!options.port.isEffectiveActive()) {
          return { isError: true, output: [{ type: "text" as const, text: "内置记忆当前未启用。" }] };
        }
        const caller = await resolveCaller(api, context);
        const bank: MemoryBank = caller.role === "worker" ? "shared" : (args.bank ?? options.defaultBank);
        if (caller.role === "worker" && bank !== "shared") {
          return { isError: true, output: [{ type: "text" as const, text: "Worker 禁止写入个人私有记忆库。" }] };
        }
        if (caller.role === "router" && bank !== "private") {
          return { isError: true, output: [{ type: "text" as const, text: "主脑禁止写入项目共享记忆库。" }] };
        }
        if (bank === "shared" && (!options.port.isSharedEffectiveActive() || !caller.projectId)) {
          return { isError: true, output: [{ type: "text" as const, text: "当前任务未获授权写入共享项目记忆库。" }] };
        }
        const saved = await options.port.retainFromTool({
          caller,
          bank,
          content: args.content,
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.category ? { category: args.category } : {}),
          callId: api.callId,
        });
        return {
          output: [{ type: "text" as const, text: JSON.stringify({ status: "saved", id: saved.id, bank: saved.bank }) }],
        };
      } catch (error) {
        return {
          isError: true,
          output: [{ type: "text" as const, text: error instanceof Error ? error.message : "写入内置记忆失败。" }],
        };
      }
    },
  });

  const recallTool = defineTool({
    name: "kulo_memory_recall",
    description:
      "Search built-in memory for preferences, decisions, or shared project findings (historical context, not live truth). 关键词：回忆 检索长期记忆 查询记忆",
    replay: "safe",
    outputLimits: { maxBytes: 10_000, maxLines: 140 },
    parameters: obj({
      query: str({ description: "Search query or identifier." }),
      bank: bankParam,
      scope: opt(
        oneOf(["global", "project", "topic"], {
          description: "Optional scope filter.",
        }),
      ),
      limit: opt(num({ description: "Max items (1..12, default 6)." })),
    }),
    execute: async (args, api, context) => {
      try {
        if (!options.port.isEffectiveActive()) {
          return { isError: true, output: [{ type: "text" as const, text: "内置记忆当前未启用。" }] };
        }
        const caller = await resolveCaller(api, context);
        const bank: MemoryBank = caller.role === "worker" ? "shared" : (args.bank ?? options.defaultBank);
        if (caller.role === "worker" && bank !== "shared") {
          return { isError: true, output: [{ type: "text" as const, text: "Worker 禁止读取个人私有记忆库。" }] };
        }
        if (bank === "shared" && !options.port.isSharedEffectiveActive()) {
          return { isError: true, output: [{ type: "text" as const, text: "共享项目记忆当前未启用。" }] };
        }
        if (caller.role === "worker" && !caller.projectId) {
          return { isError: true, output: [{ type: "text" as const, text: "非项目独立任务不访问共享项目记忆库。" }] };
        }
        if (caller.role === "router" && bank === "shared" && !caller.projectId && args.scope === "project") {
          return {
            isError: true,
            output: [{ type: "text" as const, text: "当前为未分组对话，未绑定项目；如需跨项目检索共享记忆，请传入 scope='global'。" }],
          };
        }
        const hits = await options.port.recallForTool({
          caller,
          bank,
          query: args.query,
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.limit !== undefined ? { limit: Math.min(12, Math.max(1, Math.trunc(args.limit))) } : {}),
        });
        return {
          output: [
            {
              type: "text" as const,
              text: JSON.stringify({
                bank,
                results: hits.map((hit) => ({
                  id: hit.id,
                  date: new Date(hit.updatedAt || hit.createdAt).toISOString().slice(0, 10),
                  scope: hit.scopeKind,
                  category: hit.category,
                  text: hit.content,
                })),
              }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          output: [{ type: "text" as const, text: error instanceof Error ? error.message : "检索内置记忆失败。" }],
        };
      }
    },
  });

  return [retainTool, recallTool];
}
