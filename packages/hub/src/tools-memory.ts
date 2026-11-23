/**
 * Pi-Durable Tool Bindings for Hindsight 1.2.1 Dual-Bank Memory (`kulo-core` private / `kulo-shared` shared).
 */
import { ROOT_CONVERSATION_ID, defineTool } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { HindsightMemoryConfig, MemoryBank } from "@kulo/protocol";
import {
  executeHindsightTool,
  type MemoryCallerContext,
  type OfficialHindsightToolName,
} from "./hindsight.js";
import { KuloStateDoc, resolveTicketExecutionScope, type KuloDurableState } from "./state.js";
import { SettingsAssistantDoc, isMainOrchestratorConversation, type SettingsAssistantState } from "./settings-doc.js";
import { resolveDeferredAddTools } from "./tool-surface.js";
import { findMatchingForgottenTerm, type ForgottenTermEntry, type MemoryForgetOutcome } from "./memory-forget.js";

export function memoryCallerFromState(
  state: Readonly<KuloDurableState> | undefined,
  conversationId: unknown,
  sourceId?: string,
  settingsDoc?: Readonly<SettingsAssistantState> | undefined,
): MemoryCallerContext {
  if (isMainOrchestratorConversation(conversationId, state, settingsDoc)) {
    const topicId = state?.conversationToTopic?.[String(conversationId)];
    const projectId = topicId ? state?.topics?.[topicId]?.projectId : undefined;
    return {
      role: "router",
      conversationId: topicId === "root" ? "root" : String(conversationId),
      ...(projectId ? { projectId } : {}),
      ...(sourceId ? { sourceId } : {}),
      isValidTicket: (ticketId) => Boolean(state?.tickets[ticketId]),
    };
  }
  const scope = resolveTicketExecutionScope(state, conversationId);
  return {
    role: "worker",
    conversationId: String(conversationId),
    ...(sourceId ? { sourceId } : {}),
    ...(scope?.ticket.status === "running" ? { ticketId: scope.ticket.id, runEpoch: scope.ticket.runEpoch } : {}),
    ...(scope?.ticket.projectId ? { projectId: scope.ticket.projectId } : {}),
    ...(scope?.role ? { workerRole: scope.role } : {}),
  };
}

function hasUnassignedProjectTag(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tags = (value as { tags?: unknown }).tags;
  return Array.isArray(tags) && tags.includes("project:unassigned");
}

function filterLegacyUnassignedSharedPayload(
  toolName: OfficialHindsightToolName,
  rawText: string,
): { isError?: boolean; text: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { text: rawText };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text: rawText };
  const record = parsed as Record<string, unknown>;
  if (toolName === "hindsight_recall" && Array.isArray(record.results)) {
    const filtered = record.results.filter((item) => !hasUnassignedProjectTag(item));
    if (filtered.length === record.results.length) return { text: rawText };
    return { text: JSON.stringify({ ...record, results: filtered }) };
  }
  if (toolName === "hindsight_list_mental_models" && Array.isArray(record.items)) {
    const filtered = record.items.filter((item) => !hasUnassignedProjectTag(item));
    if (filtered.length === record.items.length) return { text: rawText };
    return { text: JSON.stringify({ ...record, items: filtered }, null, 2) };
  }
  if (
    (toolName === "hindsight_get_page" ||
      toolName === "hindsight_read_knowledge_page" ||
      toolName === "hindsight_get_mental_model") &&
    hasUnassignedProjectTag(record)
  ) {
    return { isError: true, text: "已跳过历史未分组共享记忆条目。" };
  }
  return { text: rawText };
}

export function createHindsightTools(options: {
  getMemoryConfig: () => HindsightMemoryConfig;
  defaultBank: MemoryBank;
  getForgottenTerms?: () => Promise<ForgottenTermEntry[]>;
  forgetMemory?: (
    term: string,
    reason: string | undefined,
    caller: MemoryCallerContext,
    signal?: AbortSignal,
  ) => Promise<MemoryForgetOutcome>;
}) {
  type ToolExecApi = Parameters<Parameters<typeof defineTool>[0]["execute"]>[1];
  type ToolExecCtx = Parameters<Parameters<typeof defineTool>[0]["execute"]>[2];

  const resolveCaller = async (
    api: ToolExecApi,
    context: ToolExecCtx,
  ): Promise<MemoryCallerContext> => {
    const state = await api.snapshot(KuloStateDoc, context);
    const settings = await api.snapshot(SettingsAssistantDoc, context);
    return memoryCallerFromState(state, api.conversationId, api.callId, settings);
  };

  const run = async (
    toolName: OfficialHindsightToolName,
    rawArgs: Record<string, unknown>,
    api: ToolExecApi,
    context: ToolExecCtx,
    followUpCandidates?: readonly string[],
  ) => {
    const caller = await resolveCaller(api, context);
    caller.sourceTimestamp = await api.memo("hindsight-source-time", api.now(), context);
    const requestedBank =
      rawArgs.bank === "private" || rawArgs.bank === "shared"
        ? rawArgs.bank
        : caller.role === "worker"
          ? "shared"
          : options.defaultBank;

    const { bank: _b, ...rawRest } = rawArgs;
    const rest: Record<string, unknown> = { ...rawRest };
    if (caller.role === "worker" && requestedBank === "shared" && !caller.projectId) {
      return {
        isError: true,
        output: [{ type: "text" as const, text: "非项目独立任务不访问共享项目记忆库。" }],
      };
    }
    if (caller.role === "router" && requestedBank === "shared" && !caller.projectId && toolName === "hindsight_recall") {
      if (rest.scope === "project") {
        return {
          isError: true,
          output: [{ type: "text" as const, text: "当前为未分组对话，未绑定项目；如需跨项目检索共享记忆，请传入 scope='global'。" }],
        };
      }
      if (rest.scope === undefined) {
        rest.scope = "global";
      }
    }
    if (
      requestedBank === "private" &&
      (toolName === "hindsight_retain" || toolName === "hindsight_ingest_document") &&
      options.getForgottenTerms
    ) {
      const terms = await options.getForgottenTerms();
      const candidateText = [typeof rest.title === "string" ? rest.title : "", typeof rest.content === "string" ? rest.content : ""].join("\n");
      const matched = findMatchingForgottenTerm(candidateText, terms);
      if (matched) {
        return {
          isError: true,
          output: [{ type: "text" as const, text: `拒绝写入私有记忆：内容命中用户已遗忘词条「${matched.term}」。` }],
        };
      }
    }
    const res = await executeHindsightTool({
      toolName,
      args: rest,
      bank: requestedBank,
      config: options.getMemoryConfig(),
      caller,
      signal: context.abortSignal,
    });
    const cleaned =
      !res.isError && requestedBank === "shared"
        ? filterLegacyUnassignedSharedPayload(toolName, res.text)
        : res;

    const addTools =
      !cleaned.isError && followUpCandidates?.length
        ? await resolveDeferredAddTools(api, context, followUpCandidates)
        : [];

    return {
      ...(cleaned.isError ? { isError: true } : {}),
      output: [{ type: "text" as const, text: cleaned.text }],
      ...(addTools.length ? { control: { addTools } } : {}),
    };
  };

  const bankParam = opt(
    oneOf(options.defaultBank === "shared" ? ["shared"] : ["private", "shared"], {
      description:
        "Target Hindsight bank: 'private' (your private personal memory, main assistant only) or 'shared' (project-wide shared knowledge; main assistant read-only, Worker read/write).",
    }),
  );

  // 1. Resident Core Pair (when memory enabled): hindsight_retain + hindsight_recall
  const retainTool = defineTool({
    name: "hindsight_retain",
    description:
      "Retain durable facts, user preferences, architectural decisions, or evidence-backed 'Correction: <topic>' into Hindsight memory. Work reports are retained automatically; never include secrets or re-ingest recalled memory. Router writes 'private' only; Workers write 'shared' only.",
    replay: "safe",
    outputLimits: { maxBytes: 4_000, maxLines: 80 },
    parameters: obj({
      content: str({ description: "Durable factual text to retain (without secrets)." }),
      title: opt(str({ description: "Short topic/context title (e.g. 'Correction: <topic>')." })),
      document_id: opt(str({ description: "Optional logical document key when updating an existing topic." })),
      tags: opt(arr(str({ description: "Optional user-defined domain tags (never reserved provenance prefixes)." }))),
      bank: bankParam,
    }),
    execute: (args, api, context) =>
      run("hindsight_retain", args as Record<string, unknown>, api, context, ["hindsight_get_operation"]),
  });

  const recallTool = defineTool({
    name: "hindsight_recall",
    description:
      "Recall facts, experiences, and consolidated observations from Hindsight memory (supports `temporal_window` and `include_chunks`). Router defaults to 'private' (and may read 'shared'); Workers query 'shared'. Results are historical evidence, not live file ground truth.",
    replay: "safe",
    outputLimits: { maxBytes: 14_000, maxLines: 180 },
    parameters: obj({
      query: str({ description: "Natural language recall query." }),
      bank: bankParam,
      scope: opt(oneOf(["global", "project", "ticket", "session"], { description: "Shared defaults to current project; Private defaults to global." })),
      ticket_id: opt(str({ description: "Optional Ticket ID when scope='ticket' (Router only)." })),
      budget: opt(oneOf(["low", "mid", "high"])),
      max_tokens: opt(num({ description: "Max token budget for recalled facts (default 2000)." })),
      types: opt(arr(oneOf(["world", "experience", "observation"]))),
      tags: opt(arr(str())),
      temporal_window: opt(
        obj({
          start: opt(str({ description: "ISO 8601 start timestamp." })),
          end: opt(str({ description: "ISO 8601 end timestamp." })),
        }),
      ),
      include_chunks: opt(bool({ description: "Include verbatim source document chunks alongside recalled facts." })),
    }),
    execute: (args, api, context) => run("hindsight_recall", args as Record<string, unknown>, api, context),
  });

  // 2. Deferred Official Hindsight 1.2.1 Suite
  const reflectTool = defineTool({
    name: "hindsight_reflect",
    description:
      "Deep agentic memory synthesis over the bank to answer WHY questions, design rationale, and historical root causes. 关键词：深度记忆反思 历史原因归纳 决策脉络总结",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 20_000, maxLines: 240 },
    parameters: obj({
      query: str({ description: "Deep reasoning question over accumulated memory." }),
      budget: opt(oneOf(["low", "mid", "high"])),
      bank: bankParam,
    }),
    execute: (args, api, context) =>
      run("hindsight_reflect", args as Record<string, unknown>, api, context),
  });

  const listMentalModelsTool = defineTool({
    name: "hindsight_list_mental_models",
    description:
      "List curated Hindsight Mental Models (continuously refreshed topic syntheses) in the selected bank. 关键词：心智模型列表 查看长期认知模型 主题综述目录",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 10_000, maxLines: 150 },
    parameters: obj({ bank: bankParam }),
    execute: (args, api, context) =>
      run("hindsight_list_mental_models", args as Record<string, unknown>, api, context, [
        "hindsight_get_mental_model",
        "hindsight_refresh_mental_model",
      ]),
  });

  const getMentalModelTool = defineTool({
    name: "hindsight_get_mental_model",
    description:
      "Read the synthesized markdown content of a Hindsight Mental Model by `mental_model_id`. 关键词：读取心智模型 查看长期认知模型内容",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 24_000, maxLines: 300 },
    parameters: obj({
      mental_model_id: str({ description: "Mental Model ID from hindsight_list_mental_models." }),
      bank: bankParam,
    }),
    execute: (args, api, context) =>
      run("hindsight_get_mental_model", args as Record<string, unknown>, api, context),
  });

  const getPageTreeTool = defineTool({
    name: "hindsight_get_page_tree",
    description:
      "Inspect the hierarchical `/pages/tree` folder and page structure in the selected Hindsight bank. 关键词：知识页目录树 记忆页面结构 浏览知识库目录",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 12_000, maxLines: 180 },
    parameters: obj({ bank: bankParam }),
    execute: (args, api, context) =>
      run("hindsight_get_page_tree", args as Record<string, unknown>, api, context, [
        "hindsight_get_page",
        "hindsight_create_page",
        "hindsight_update_page_node",
      ]),
  });

  const searchPagesTool = defineTool({
    name: "hindsight_search_pages",
    description:
      "Hybrid BM25 + vector search over Hindsight `/pages/search` (architecture, conventions, past decisions, initiatives). 关键词：搜索知识页 检索记忆页面 查找项目文档",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 10_000, maxLines: 150 },
    parameters: obj({
      query: str({ description: "Topic or question to search across pages." }),
      limit: opt(num({ description: "Max matching pages (1..20, default 5)." })),
      bank: bankParam,
    }),
    execute: (args, api, context) =>
      run("hindsight_search_pages", args as Record<string, unknown>, api, context, [
        "hindsight_get_page",
        "hindsight_update_page_node",
      ]),
  });

  const getPageTool = defineTool({
    name: "hindsight_get_page",
    description:
      "Read the full markdown content and metadata of a Hindsight Page (`/pages/{page_id}`). 关键词：读取知识页 查看记忆页面正文",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 24_000, maxLines: 300 },
    parameters: obj({
      page_id: str({ description: "Page ID from hindsight_get_page_tree or hindsight_search_pages." }),
      bank: bankParam,
    }),
    execute: (args, api, context) =>
      run("hindsight_get_page", args as Record<string, unknown>, api, context, ["hindsight_update_page_node"]),
  });

  const createPageTool = defineTool({
    name: "hindsight_create_page",
    description:
      "Create a living Hindsight Page (`POST /pages`) driven by a `source_query` (Router writes 'private'; Workers write 'shared' scoped to the active project). 关键词：新建知识页 创建记忆专题页",
    deferred: true,
    outputLimits: { maxBytes: 6_000, maxLines: 100 },
    parameters: obj({
      name: str({ description: "Concise page title." }),
      source_query: str({ description: "Synthesis prompt defining what this page tracks from memory." }),
      parent_id: opt(str({ description: "Optional folder ID from hindsight_get_page_tree." })),
      max_tokens: opt(num({ description: "Max synthesis tokens (256..8192, default 2048)." })),
      bank: bankParam,
    }),
    execute: (args, api, context) =>
      run("hindsight_create_page", args as Record<string, unknown>, api, context, ["hindsight_get_page"]),
  });

  const updatePageNodeTool = defineTool({
    name: "hindsight_update_page_node",
    description:
      "Rename, move, or update `source_query`/`max_tokens` of an existing Hindsight Page node (`PATCH /pages/nodes/{node_id}`; verifies project tag ownership before mutating shared pages). 关键词：修改知识页 重命名移动记忆页面 更新页面查询",
    deferred: true,
    outputLimits: { maxBytes: 6_000, maxLines: 100 },
    parameters: obj({
      node_id: str({ description: "Target page/node ID." }),
      name: opt(str({ description: "Updated node title." })),
      source_query: opt(str({ description: "Updated synthesis query (schedules async page refresh)." })),
      parent_id: opt(str({ description: "New parent folder ID (or empty string for root)." })),
      max_tokens: opt(num({ description: "Updated max synthesis tokens (256..8192)." })),
      bank: bankParam,
    }),
    execute: (args, api, context) =>
      run("hindsight_update_page_node", args as Record<string, unknown>, api, context),
  });

  const operationTool = defineTool({
    name: "hindsight_get_operation",
    description:
      "Check an accepted Hindsight async write (`GET /operations/{operation_id}`). Only status='completed' means consolidation finished. 关键词：查询记忆写入进度 记忆异步任务状态",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 2_000, maxLines: 40 },
    parameters: obj({ operation_id: str(), bank: bankParam }),
    execute: (args, api, context) =>
      run("hindsight_get_operation", args as Record<string, unknown>, api, context),
  });

  // 3. Replay & Legacy Compatibility Aliases (deferred)
  const legacySearchPagesTool = defineTool({
    name: "hindsight_search_knowledge_pages",
    description:
      "Compatibility alias for `hindsight_search_pages`: search Hindsight Pages. 关键词：搜索知识页 检索记忆页面",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 10_000, maxLines: 150 },
    parameters: obj({ query: str(), bank: bankParam }),
    execute: (args, api, context) =>
      run("hindsight_search_knowledge_pages", args as Record<string, unknown>, api, context),
  });

  const legacyListPagesTool = defineTool({
    name: "hindsight_list_knowledge_pages",
    description:
      "Compatibility alias for `hindsight_get_page_tree`: list Hindsight Pages. 关键词：知识页面目录 列出记忆页面",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 10_000, maxLines: 150 },
    parameters: obj({ bank: bankParam }),
    execute: (args, api, context) =>
      run("hindsight_list_knowledge_pages", args as Record<string, unknown>, api, context),
  });

  const legacyReadPageTool = defineTool({
    name: "hindsight_read_knowledge_page",
    description:
      "Compatibility alias for `hindsight_get_page`: read a Hindsight Page by `page_id`. 关键词：读取知识页 查看记忆页面正文",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 24_000, maxLines: 300 },
    parameters: obj({ page_id: str(), bank: bankParam }),
    execute: (args, api, context) =>
      run("hindsight_read_knowledge_page", args as Record<string, unknown>, api, context),
  });

  const captureInitiativeTool = defineTool({
    name: "hindsight_capture_initiative",
    description:
      "Create or append a tracked Initiative Page (`relates_to_page_id` when updating). Router writes 'private'; Workers write 'shared'. 关键词：创建知识专题 记录专项计划 更新知识页",
    deferred: true,
    parameters: obj({
      title: str({ description: "Short, specific initiative title." }),
      summary: str({ description: "2-3 sentences describing current intent, scope, and rationale." }),
      relates_to_page_id: opt(str({ description: "Existing initiative page_id when recording an update." })),
      bank: bankParam,
    }),
    execute: (args, api, context) =>
      run("hindsight_capture_initiative", args as Record<string, unknown>, api, context),
  });

  const ingestDocumentTool = defineTool({
    name: "hindsight_ingest_document",
    description:
      "Compatibility alias for `hindsight_retain`: retain durable facts with `title` and `content`. 关键词：写入长期记忆 保存事实 纠正旧记忆",
    deferred: true,
    replay: "safe",
    outputLimits: { maxBytes: 4_000, maxLines: 80 },
    parameters: obj({
      title: str({ description: "Document title." }),
      content: str({ description: "Durable factual text to retain." }),
      bank: bankParam,
    }),
    execute: (args, api, context) =>
      run("hindsight_ingest_document", args as Record<string, unknown>, api, context),
  });

  const sharedEligibleTools = [
    retainTool,
    recallTool,
    reflectTool,
    listMentalModelsTool,
    getMentalModelTool,
    getPageTreeTool,
    searchPagesTool,
    getPageTool,
    createPageTool,
    updatePageNodeTool,
    operationTool,
    legacySearchPagesTool,
    legacyListPagesTool,
    legacyReadPageTool,
    captureInitiativeTool,
    ingestDocumentTool,
  ];

  if (options.defaultBank === "shared") {
    return sharedEligibleTools;
  }

  // 4. Router-only Private-Bank Curation Tools (never registered on Workers)
  const createMentalModelTool = defineTool({
    name: "hindsight_create_mental_model",
    description:
      "Create a living Mental Model (`POST /mental-models`) in your private memory bank (`kulo-core`, main assistant only). 关键词：创建心智模型 新建长期认知综述",
    deferred: true,
    outputLimits: { maxBytes: 6_000, maxLines: 100 },
    parameters: obj({
      name: str({ description: "Mental Model title." }),
      source_query: str({ description: "Prompt defining what this Mental Model synthesizes from private memory." }),
      max_tokens: opt(num({ description: "Max synthesis tokens (256..8192, default 2048)." })),
    }),
    execute: (args, api, context) =>
      run("hindsight_create_mental_model", { ...(args as Record<string, unknown>), bank: "private" }, api, context, [
        "hindsight_get_mental_model",
        "hindsight_refresh_mental_model",
      ]),
  });

  const refreshMentalModelTool = defineTool({
    name: "hindsight_refresh_mental_model",
    description:
      "Trigger a refresh (`POST /mental-models/{id}/refresh`) of a Mental Model in your private memory bank (main assistant only). 关键词：刷新心智模型 重建认知综述",
    deferred: true,
    outputLimits: { maxBytes: 4_000, maxLines: 80 },
    parameters: obj({
      mental_model_id: str({ description: "Target Mental Model ID in private bank." }),
      mode: opt(oneOf(["full"], { description: "Optional 'full' regeneration mode." })),
    }),
    execute: (args, api, context) =>
      run("hindsight_refresh_mental_model", { ...(args as Record<string, unknown>), bank: "private" }, api, context),
  });

  const invalidateMemoryTool = defineTool({
    name: "hindsight_invalidate_memory",
    description:
      "Explicitly invalidate an obsolete or erroneous memory unit (`PATCH /memories/{memory_id}`, `state='invalidated'`) in your private memory bank with a required `reason` (main assistant only). 关键词：作废旧记忆 标记记忆失效 删除错误记忆",
    deferred: true,
    outputLimits: { maxBytes: 4_000, maxLines: 80 },
    parameters: obj({
      memory_id: str({ description: "Memory unit ID returned by `hindsight_recall` in the private bank." }),
      reason: str({ description: "Concise reason explaining why this memory is superseded or invalid." }),
    }),
    execute: (args, api, context) =>
      run("hindsight_invalidate_memory", { ...(args as Record<string, unknown>), bank: "private" }, api, context),
  });

  const forgetMemoryTool = options.forgetMemory
    ? defineTool({
        name: "kulo_memory_forget",
        description:
          "Permanently forget a personal fact/topic when the user asks to forget or stop remembering it: records a tombstone in forgottenTerms, removes matching lines from relationship.md, and invalidates exact-matching private Hindsight memories (never touches shared project memory). 关键词：忘掉 别再记住 清除记忆 遗忘黑名单 删除个人偏好",
        deferred: true,
        replay: "safe",
        outputLimits: { maxBytes: 4_000, maxLines: 80 },
        parameters: obj({
          term: str({ description: "Specific personal fact, topic, or keyword to forget (2–120 characters)." }),
          reason: opt(str({ description: "Optional short reason recorded alongside the tombstone." })),
        }),
        execute: async (args, api, context) => {
          try {
            const caller = await resolveCaller(api, context);
            const outcome = await options.forgetMemory!(args.term, args.reason, caller, context.abortSignal);
            return { output: [{ type: "text" as const, text: JSON.stringify(outcome) }] };
          } catch (error) {
            return {
              isError: true,
              output: [{ type: "text" as const, text: error instanceof Error ? error.message : "遗忘记忆失败。" }],
            };
          }
        },
      })
    : undefined;

  return [
    ...sharedEligibleTools,
    createMentalModelTool,
    refreshMentalModelTool,
    invalidateMemoryTool,
    ...(forgetMemoryTool ? [forgetMemoryTool] : []),
  ];
}
