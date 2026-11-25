import {
  AssistantEntry,
  LiveDoc,
  ToolTask,
  UserEntry,
  hook,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { isActiveSettingsConversation, SettingsAssistantDoc } from "./settings-doc.js";
import {
  CoordinatorEventEntry,
  isOrchestratorConversation,
  KuloStateDoc,
  type CoordinatorEventEntryData,
} from "./state.js";

const MAX_PROPOSE_CALLS_PER_WAKE = 2;
const MAX_PROACTIVE_L2_PREVIEW_CHARS = 400;

const ALWAYS_ALLOWED_PROACTIVE_TOOLS = new Set<string>([
  "tool_search",
  "kulo_assistant_digests",
  "kulo_assistant_event_read",
  "kulo_assistant_read",
  "kulo_history_search",
  "kulo_history_read",
  "kulo_status",
  "kulo_inspect",
  "kulo_memory_recall",
  "hindsight_recall",
  "hindsight_search_pages",
  "hindsight_get_page_tree",
  "hindsight_get_page",
  "hindsight_search_knowledge_pages",
  "hindsight_list_knowledge_pages",
  "hindsight_read_knowledge_page",
  "hindsight_list_mental_models",
  "hindsight_get_mental_model",
]);

const LARK_ALLOWED_ACTIONS = new Set<string>(["status", "list_chats", "read_chat", "search_messages", "propose_reply"]);
const SPARK_ALLOWED_ACTIONS = new Set<string>(["status", "emails", "search", "thread", "events", "propose_draft"]);
const HA_ALLOWED_ACTIONS = new Set<string>([
  "status",
  "entities",
  "list_automations",
  "get_automation",
  "get_traces",
  "get_history",
  "propose_action",
]);

export interface ActiveProactiveWakeInfo {
  wakeEntryId: number;
  data: CoordinatorEventEntryData;
}

/**
 * True when an `AssistantEntry` contains NO tool calls — i.e., a true turn-end boundary
 * (either a final visible reply or a non-tool-call error/aborted turn).
 */
export function isNonToolCallAssistantEntry(entry: EntryRecord): boolean {
  if (!AssistantEntry.is(entry)) return false;
  const msg = entry.model?.[0];
  if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return true;
  return !msg.content.some((part) => part.type === "toolCall");
}

/**
 * Full-segment taint scan from newest to oldest until the prior non-tool-call `AssistantEntry`.
 * Defeats `followUpMode: "all"` batching (e.g. `[proactive_wake, WorkerRelayEntry]`) AND
 * mid-turn `steeringMode: "all"` user interjections while releasing immediately on the next
 * user turn after the woken turn ends.
 */
export function findActiveProactiveWakeInDescending(
  entriesDescending: readonly EntryRecord[],
): ActiveProactiveWakeInfo | null {
  for (const entry of entriesDescending) {
    if (isNonToolCallAssistantEntry(entry)) return null;
    if (CoordinatorEventEntry.is(entry) && entry.data.eventKind === "assistant_proactive_wake") {
      return { wakeEntryId: Number(entry.id), data: entry.data };
    }
  }
  return null;
}

/**
 * Inspects an ascending entry window ending at `upToEntryId` (inclusive) to determine whether
 * the completed reply was attributed to an `assistant_proactive_wake` entry, and whether a
 * real user input (`UserEntry` / `kulo.user`) also arrived after that wake in the same turn.
 */
export function findReplyWakeAttribution(
  entriesAscending: readonly EntryRecord[],
  upToEntryId: number,
): { wake: ActiveProactiveWakeInfo; hasNewerUserInput: boolean } | null {
  let endIdx = -1;
  for (let i = entriesAscending.length - 1; i >= 0; i -= 1) {
    if (Number(entriesAscending[i]!.id) <= upToEntryId) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return null;

  let seenNewerUser = false;
  let seenStartAssistant = false;
  for (let i = endIdx; i >= 0; i -= 1) {
    const entry = entriesAscending[i]!;
    if (isNonToolCallAssistantEntry(entry)) {
      if (!seenStartAssistant && Number(entry.id) === upToEntryId) {
        seenStartAssistant = true;
        continue;
      }
      break;
    }
    if (UserEntry.is(entry) || entry.kind === "kulo.user") {
      seenNewerUser = true;
      continue;
    }
    if (CoordinatorEventEntry.is(entry) && entry.data.eventKind === "assistant_proactive_wake") {
      return {
        wake: { wakeEntryId: Number(entry.id), data: entry.data },
        hasNewerUserInput: seenNewerUser,
      };
    }
  }
  return null;
}

export function isCriticalSafetyAlert(input: { sourceApp: string; title: string; summary: string }): boolean {
  return (
    input.sourceApp === "home-assistant" &&
    /(?:告警|烟雾|燃气|漏水|报警|异常|入侵|alarm|smoke|gas|leak)/i.test(`${input.title} ${input.summary}`)
  );
}

export function readOnlyToolsForWakeSource(sourceApp: string): string[] {
  const norm = sourceApp.trim().toLowerCase();
  const tools = ["kulo_assistant_digests", "kulo_assistant_event_read"];
  if (norm.startsWith("lark:") || norm === "com.electron.lark" || norm === "com.bytedance.feishu" || norm === "com.bytedance.lark") {
    tools.push("kulo_lark_bridge");
  } else if (norm === "com.readdle.sparkdesktop" || norm === "com.readdle.sparkdesktop.appstore") {
    tools.push("kulo_spark_mail");
  } else if (norm === "home-assistant") {
    tools.push("kulo_home_assistant");
  }
  return tools;
}

export interface ProactiveWakeGuardDeps {
  maxProposePerWake?: number;
}

/**
 * Code-enforced L0-L2 `beforeTool` guardrail mounted onto `kulo-orchestrator-guard`
 * so ALL orchestrator conversations (including legacy/cold topics) stay fail-closed
 * during any untrusted `assistant_proactive_wake` turn.
 */
export function createProactiveWakeBeforeToolHook(deps: ProactiveWakeGuardDeps = {}) {
  const maxPropose = deps.maxProposePerWake ?? MAX_PROPOSE_CALLS_PER_WAKE;
  // Short-lived per-run cache: key = `${convId}:${runTaskId}` -> ActiveProactiveWakeInfo | null
  const runTaintCache = new Map<string, ActiveProactiveWakeInfo | null>();
  // Counts `propose_*` tool calls per wakeId to prevent permanent L2 card spam.
  const proposeCounts = new Map<string, number>();

  const rememberTaint = (key: string, value: ActiveProactiveWakeInfo | null) => {
    runTaintCache.set(key, value);
    if (runTaintCache.size > 128) {
      const oldest = runTaintCache.keys().next().value;
      if (oldest !== undefined) runTaintCache.delete(oldest);
    }
  };

  const countProposeCall = (wakeKey: string): boolean => {
    const current = proposeCounts.get(wakeKey) ?? 0;
    if (current >= maxPropose) return false;
    proposeCounts.set(wakeKey, current + 1);
    if (proposeCounts.size > 200) {
      const oldest = proposeCounts.keys().next().value;
      if (oldest !== undefined) proposeCounts.delete(oldest);
    }
    return true;
  };

  return hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      // Fast path: skip non-orchestrator conversations (Workers, Subagents, Settings Assistant).
      const state = await api.snapshot(KuloStateDoc, context);
      if (!isOrchestratorConversation(api.conversationId, state)) return undefined;
      const settingsDoc = await api.snapshot(SettingsAssistantDoc, context);
      if (isActiveSettingsConversation(api.conversationId, settingsDoc)) return undefined;

      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const runTaskId = live?.run?.taskId;
      const cacheKey = runTaskId !== undefined ? `${Number(api.conversationId)}:${Number(runTaskId)}` : undefined;

      let activeWake: ActiveProactiveWakeInfo | null;
      if (cacheKey && runTaintCache.has(cacheKey)) {
        activeWake = runTaintCache.get(cacheKey)!;
      } else {
        // Scan backward across pages until prior non-tool-call AssistantEntry (bounded to 4 pages = 320 entries).
        activeWake = null;
        let cursor = undefined;
        for (let pageIdx = 0; pageIdx < 4; pageIdx += 1) {
          const page = await api.entries({ order: "descending" }, 80, cursor, context);
          let hitBoundary = false;
          for (const entry of page.items) {
            if (isNonToolCallAssistantEntry(entry)) {
              hitBoundary = true;
              break;
            }
            if (CoordinatorEventEntry.is(entry) && entry.data.eventKind === "assistant_proactive_wake") {
              activeWake = { wakeEntryId: Number(entry.id), data: entry.data };
              hitBoundary = true;
              break;
            }
          }
          if (hitBoundary || !page.next) break;
          cursor = page.next;
        }
        if (cacheKey) rememberTaint(cacheKey, activeWake);
      }

      if (!activeWake) return undefined;

      const toolName = call.name;
      const args = (call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
        ? (call.arguments as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const wakeKey = activeWake.data.wakeId ?? `entry:${activeWake.wakeEntryId}`;

      if (ALWAYS_ALLOWED_PROACTIVE_TOOLS.has(toolName)) {
        return undefined;
      }

      if (toolName === "kulo_assistant_watch") {
        if (typeof args.action === "string" && args.action === "list") return undefined;
        return { block: "主动唤醒回合处于只读安全模式，禁止修改关注规则或安静时段；请先向用户汇报，待用户回复后再修改。" };
      }

      if (toolName === "kulo_lark_bridge") {
        const action = typeof args.action === "string" ? args.action : "";
        if (!LARK_ALLOWED_ACTIONS.has(action)) {
          return { block: `主动唤醒回合处于只读安全模式，禁止执行飞书动作 '${action || "unknown"}'。` };
        }
        if (action === "propose_reply") {
          const text = typeof args.text === "string" ? args.text.trim() : "";
          const chatId = typeof args.chat_id === "string" ? args.chat_id.trim() : "";
          if (text.length > MAX_PROACTIVE_L2_PREVIEW_CHARS) {
            return { block: `主动唤醒回合内提议的飞书回复草稿不可超过 ${MAX_PROACTIVE_L2_PREVIEW_CHARS} 字，以确保确认卡完整呈现将发送的全部内容。` };
          }
          if (activeWake.data.triggerChatId && chatId !== activeWake.data.triggerChatId) {
            return { block: `主动唤醒回合内仅允许向原触发会话（${activeWake.data.triggerChatId}）提议回复确认卡，禁止跨会话外发。` };
          }
          if (!countProposeCall(wakeKey)) {
            return { block: `单次主动唤醒回合最多只能生成 ${maxPropose} 张待确认动作卡。` };
          }
        }
        return undefined;
      }

      if (toolName === "kulo_spark_mail") {
        const action = typeof args.action === "string" ? args.action : "";
        if (!SPARK_ALLOWED_ACTIONS.has(action)) {
          return { block: `主动唤醒回合处于只读安全模式，禁止执行 Spark Mail 动作 '${action || "unknown"}'。` };
        }
        if (action === "propose_draft") {
          const body = typeof args.body === "string" ? args.body.trim() : "";
          const hasTarget = Boolean(
            (typeof args.to === "string" && args.to.trim()) ||
            (typeof args.thread_id === "string" && args.thread_id.trim()),
          );
          if (!hasTarget) {
            return { block: "主动唤醒回合内提议邮件草稿必须明确指定收件人 to 或原线索 thread_id。" };
          }
          if (body.length > MAX_PROACTIVE_L2_PREVIEW_CHARS) {
            return { block: `主动唤醒回合内提议的邮件草稿不可超过 ${MAX_PROACTIVE_L2_PREVIEW_CHARS} 字，以确保确认卡完整呈现全部正文。` };
          }
          if (!countProposeCall(wakeKey)) {
            return { block: `单次主动唤醒回合最多只能生成 ${maxPropose} 张待确认动作卡。` };
          }
        }
        return undefined;
      }

      if (toolName === "kulo_home_assistant") {
        const action = typeof args.action === "string" ? args.action : "";
        if (!HA_ALLOWED_ACTIONS.has(action)) {
          return { block: `主动唤醒回合处于只读安全模式，禁止执行智能家居动作 '${action || "unknown"}'。` };
        }
        if (action === "propose_action") {
          if (!countProposeCall(wakeKey)) {
            return { block: `单次主动唤醒回合最多只能生成 ${maxPropose} 张待确认动作卡。` };
          }
        }
        return undefined;
      }

      return {
        block: `当前回合由外部不可信消息自动唤醒，代码级安全护栏仅放行只读补查与受限 L2 确认卡，已拦截工具 '${toolName}'。请先向用户简洁汇报情况，待用户回复确认后再执行操作。`,
      };
    },
  });
}
