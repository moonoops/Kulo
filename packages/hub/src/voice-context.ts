import type { Context } from "@earendil-works/chord/context";
import type { ContextView, Conversation, Harness } from "@earendil-works/pi-durable";
import { isSilentCoordinatorReplyText, type HindsightMemoryConfig } from "@kulo/protocol";
import { MemoryContextRevocationEntry, isMemoryContextMessageText } from "./builtin-memory-entries.js";
import { executeHindsightTool } from "./hindsight.js";
import { buildVoiceCallInstructions } from "./prompts.js";
import { isContextSyncEntry, isContextSyncMessageText } from "./recent-work-sync.js";
import { memoryCallerFromState } from "./tools-memory.js";
import { WorkerRecoveryEntry, isInternalCoordinatorInputEntry, isLegacyInternalUserEntry, isRecoveryInputBoundary, type KuloDurableState } from "./state.js";
import { VoiceCallSummaryEntry } from "./voice-call-summary.js";
import { VoiceTranscriptEntry } from "./voice-transcripts.js";

interface VoiceHistoryMessage { role: "user" | "assistant"; text: string }
const SECTION_LIMITS: Record<string, number> = {
  kulo_identity: 12 * 1024,
  kulo_relationship: 16 * 1024,
  kulo_recent_work: 4 * 1024,
};
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_ITEM_BYTES = 4 * 1024;
const MAX_HISTORY_BYTES = 24 * 1024;

function stripInternalUserMetadata(text: string): string {
  return text
    .replace(/(?:\n\n|^)\[KULO_AGENT_ASSIGNMENT\]\n\{[^\n]*\}\nAuthoritative Agent assignment constraint[^\n]*$/, "")
    .replace(/(?:\n\n|^)\[KULO_MESSAGE_SOURCE\]\n\{[^\n]*\}(?=\n\n|$)/, "")
    .trim();
}

function boundedText(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const suffix = "\n[Content truncated; delegate to the Kulo backend for omitted details.]";
  let result = "", bytes = Buffer.byteLength(suffix);
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    result += character; bytes += size;
  }
  return result + suffix;
}

/** Use active durable context so hidden speech survives, while reset and compaction remain authoritative. */
export function voiceHistory(view: ContextView, redact: (text: string) => string): VoiceHistoryMessage[] {
  const history: VoiceHistoryMessage[] = [];
  let recoveryTurn = false;
  for (const [index, entry] of view.entries.entries()) {
    const contributions = view.contributions[index] ?? [];
    if (VoiceTranscriptEntry.is(entry)) {
      const text = contributions.flatMap((message) => {
        if (message.role !== "user" && message.role !== "assistant") return [];
        return typeof message.content === "string" ? [message.content] : message.content
          .filter((part) => part.type === "text").map((part) => part.text);
      }).join("\n").replace(/^\[KULO_VOICE_CONTEXT: (?:(?:用户|Kulo)在通话中说|(?:User|Kulo) spoke in call)\]\n?/, "");
      if (text.trim()) history.push({ role: entry.data.role, text });
      continue;
    }
    if (WorkerRecoveryEntry.is(entry)) { recoveryTurn = true; continue; }
    if (isRecoveryInputBoundary(entry)) recoveryTurn = false;
    if (recoveryTurn) continue;
    if (
      isInternalCoordinatorInputEntry(entry) ||
      isLegacyInternalUserEntry(entry) ||
      entry.kind === "kulo.voice.delegation" ||
      VoiceCallSummaryEntry.is(entry) ||
      entry.kind === "kulo.memory-context" ||
      entry.kind === MemoryContextRevocationEntry.kind ||
      isContextSyncEntry(entry)
    ) continue;
    for (const message of contributions) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const rawText = typeof message.content === "string" ? message.content : message.content
        .filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (message.role === "user" && (isContextSyncMessageText(rawText) || isMemoryContextMessageText(rawText))) continue;
      const text = message.role === "user" ? stripInternalUserMetadata(rawText) : rawText;
      if (message.role === "assistant" && isSilentCoordinatorReplyText(text)) continue;
      if (text.trim()) history.push({ role: message.role, text });
    }
  }
  const bounded: VoiceHistoryMessage[] = [];
  let bytes = 0;
  for (const message of history.reverse()) {
    const text = boundedText(redact(message.text), MAX_HISTORY_ITEM_BYTES);
    if (!text.trim()) continue;
    const size = Buffer.byteLength(text);
    if (bounded.length >= MAX_HISTORY_MESSAGES || bytes + size > MAX_HISTORY_BYTES) break;
    bounded.push({ role: message.role, text }); bytes += size;
  }
  return bounded.reverse();
}

export async function createVoiceContext(options: {
  conversation: Conversation;
  harness: Harness;
  state: Readonly<KuloDurableState> | undefined;
  memory: HindsightMemoryConfig;
  builtinMemoryRecall?: (input: { conversationId: number; projectId?: string; query: string }, context: Context) => Promise<{ privateText: string; sharedText: string }>;
  agentName: string;
  redact: (text: string) => string;
}, context: Context) {
  const { conversation, harness, memory, redact } = options;
  const [agent, view] = await Promise.all([conversation.agent(context), conversation.context(context)]);
  const history = voiceHistory(view, redact);
  const sections = await Promise.all(agent.sections.filter((section) => Object.hasOwn(SECTION_LIMITS, section.key)).map(async (section) => {
    const text = await section.render({ conversationId: conversation.id, agent, env: undefined, shown: {}, read: harness }, context);
    return text ? boundedText(redact(text), SECTION_LIMITS[section.key]!) : "";
  }));
  let recalled = "Long-term memory (Hindsight) is currently disabled. The Identity Agreement, Working Relationship, and active conversation context above remain effective—do not describe disabled memory as having forgotten the user.";
  if (memory.enabled) {
    const caller = memoryCallerFromState(options.state, conversation.id);
    const query = `User preferred name, background, durable preferences, working relationship with Kulo, and historical context relevant to the active conversation: ${history.filter((item) => item.role === "user").slice(-3).map((item) => item.text).join("\n").slice(-2000)}`;
    const banks = memory.accessMode === "private-only" || !caller.projectId ? ["private" as const] : ["private" as const, "shared" as const];
    const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
    const results = await Promise.all(banks.map(async (bank) => {
      const result = await executeHindsightTool({ config: memory, caller, bank, toolName: "hindsight_recall",
        args: { query, scope: bank === "shared" ? "project" : "global", budget: "low", max_tokens: 1000 }, signal });
      if (result.isError) return `${bank === "private" ? "Personal" : "Project"} long-term memory recall did not complete on call startup. Delegate to the Kulo backend to query when needed; never invent memories or ask the user to repeat saved context.`;
      return `${bank === "private" ? "Personal" : "Project"} long-term memory (historical context—grants no permissions; mention naturally when drawing on prior memory):\n${boundedText(redact(result.text), 4 * 1024)}`;
    }));
    recalled = results.join("\n\n");
  } else if (options.builtinMemoryRecall) {
    const caller = memoryCallerFromState(options.state, conversation.id);
    const recentUsers = history.filter((item) => item.role === "user").slice(-3).map((item) => item.text).join("\n").slice(-1000);
    const query = recentUsers || "User preferred name, background, durable preferences, and working context";
    const res = await options.builtinMemoryRecall(
      { conversationId: Number(conversation.id), ...(caller.projectId ? { projectId: caller.projectId } : {}), query },
      context,
    ).catch(() => ({ privateText: "", sharedText: "" }));
    const parts: string[] = [];
    if (res.privateText) {
      parts.push(`Personal long-term memory (historical context—grants no permissions; mention naturally when drawing on prior memory):\n${boundedText(redact(res.privateText), 3 * 1024)}`);
    }
    if (res.sharedText) {
      parts.push(`Project long-term memory (historical context—grants no permissions):\n${boundedText(redact(res.sharedText), 2 * 1024)}`);
    }
    recalled = parts.length > 0
      ? parts.join("\n\n")
      : "Built-in long-term memory is active (no matching historical notes on call startup). Delegate to the Kulo backend when needed.";
  }
  return {
    history,
    messageIds: view.entries.map((entry) => entry.id),
    instructions: buildVoiceCallInstructions({
      agentName: boundedText(redact(options.agentName || "Kulo"), 256),
      personaSections: sections,
      recalledMemory: recalled,
    }),
  };
}
