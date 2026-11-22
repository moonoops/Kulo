import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import type { UsageModelItem, UsageStatsView } from "@kulo/protocol";
import { entryTimestamp } from "./hub-display-projection.js";
import { KuloStateDoc, isTicketUnfinished } from "./state.js";

export interface HubUsageStatsDeps {
  harness: Harness;
  getSettingsAssistantConversationIds: () => Promise<readonly number[]>;
  getRelationshipReviewConversationIds: (context: Context) => Promise<readonly number[]>;
  getDefaultModel: () => string;
  defaultProviderId: string;
}

export async function computeHubUsageStats(
  deps: HubUsageStatsDeps,
  range: "today" | "7" | "30" = "today",
  context: Context = BACKGROUND_CONTEXT,
): Promise<UsageStatsView> {
  const now = Date.now();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range !== "today") {
    start.setDate(start.getDate() - (Number(range) - 1));
  }
  const fromMs = start.getTime();

  const state = await deps.harness.snapshot(KuloStateDoc, context);
  const convIds = new Set<number>([Number(ROOT_CONVERSATION_ID)]);
  for (const t of Object.values(state?.topics ?? {})) {
    convIds.add(t.conversationId);
  }
  for (const tk of Object.values(state?.tickets ?? {})) {
    if (tk.updatedAt >= fromMs || isTicketUnfinished(tk)) convIds.add(tk.workerConversationId);
  }
  for (const sub of Object.values(state?.subagents ?? {})) {
    if (sub.updatedAt >= fromMs || sub.state === "running" || sub.state === "queued") convIds.add(sub.conversationId);
  }
  for (const conversationId of await deps.getSettingsAssistantConversationIds()) convIds.add(conversationId);
  for (const conversationId of await deps.getRelationshipReviewConversationIds(context)) convIds.add(conversationId);
  for (const job of Object.values(state?.topicTitles ?? {})) {
    if (job.conversationId !== undefined) convIds.add(job.conversationId);
  }

  let totalTokens = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let turns = 0;
  const byModel = new Map<string, UsageModelItem>();

  for (const cid of convIds) {
    try {
      const conv = await deps.harness.conversation(cid as ConversationId, context);
      if (!conv) continue;
      const watch = await conv.watch(context, { min: 100, max: 200 });
      const entries = watch.value.entries;
      await watch.stop();

      for (const entry of entries) {
        if (!AssistantEntry.is(entry)) continue;
        const ts = entryTimestamp(entry);
        if (ts !== undefined && ts < fromMs) continue;

        const msg = entry.model?.[0] as
          | {
              model?: string;
              provider?: string;
              usage?: {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
                totalTokens?: number;
              };
            }
          | undefined;
        if (!msg) continue;

        turns += 1;
        const u = msg.usage;
        const input = Number(u?.input ?? 0) || 0;
        const output = Number(u?.output ?? 0) || 0;
        const cacheRead = Number(u?.cacheRead ?? 0) || 0;
        const cacheWrite = Number(u?.cacheWrite ?? 0) || 0;
        const tok =
          typeof u?.totalTokens === "number" && u.totalTokens > 0
            ? u.totalTokens
            : input + output + cacheRead + cacheWrite;

        totalTokens += tok;
        totalInput += input + cacheRead + cacheWrite;
        totalCacheRead += cacheRead;

        const modelId = msg.model || deps.getDefaultModel();
        const provider = msg.provider || deps.defaultProviderId;
        const key = `${provider}/${modelId}`;
        const cur = byModel.get(key) ?? { model: modelId, provider, totalTokens: 0, turns: 0 };
        cur.totalTokens += tok;
        cur.turns += 1;
        cur.inputTokens = (cur.inputTokens ?? 0) + input + cacheRead + cacheWrite;
        cur.cacheReadTokens = (cur.cacheReadTokens ?? 0) + cacheRead;
        cur.cacheWriteTokens = (cur.cacheWriteTokens ?? 0) + cacheWrite;
        if (cur.inputTokens > 0) cur.cacheHitRate = cur.cacheReadTokens / cur.inputTokens;
        byModel.set(key, cur);
      }
    } catch {
      // Ignore missing conversation
    }
  }

  const models = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    range,
    totalTokens,
    turns,
    ...(totalInput > 0 ? { cacheHitRate: totalCacheRead / totalInput } : {}),
    models,
  };
}
