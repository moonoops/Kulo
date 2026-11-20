import type { Context } from "@earendil-works/chord/context";
import type { ContextView, Conversation, Harness } from "@earendil-works/pi-durable";
import type { HindsightMemoryConfig } from "@kulo/protocol";
import { executeHindsightTool } from "./hindsight.js";
import { buildVoiceCallInstructions } from "./prompts.js";
import { memoryCallerFromState } from "./tools-memory.js";
import { WorkerRecoveryEntry, isRecoveryInputBoundary, type KuloDurableState } from "./state.js";
import { VoiceTranscriptEntry } from "./voice-transcripts.js";

interface VoiceHistoryMessage { role: "user" | "assistant"; text: string }
const SECTION_LIMITS: Record<string, number> = {
  kulo_identity: 12 * 1024,
  kulo_relationship: 16 * 1024,
  kulo_recent_work: 4 * 1024,
};

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
    if (entry.kind === "kulo.voice.delegation" || entry.kind === "kulo.memory-context") continue;
    for (const message of contributions) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = typeof message.content === "string" ? message.content : message.content
        .filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (message.role === "assistant" && ["[RECOVERY_OK]", "[WATCHDOG_OK]", "[COORDINATOR_OK]"].includes(text.trim())) continue;
      if (text.trim()) history.push({ role: message.role, text });
    }
  }
  const bounded: VoiceHistoryMessage[] = [];
  let bytes = 0;
  for (const message of history.reverse()) {
    const text = boundedText(redact(message.text), 6 * 1024);
    if (!text.trim()) continue;
    const size = Buffer.byteLength(text);
    if (bounded.length >= 24 || bytes + size > 32 * 1024) break;
    bounded.push({ role: message.role, text }); bytes += size;
  }
  return bounded.reverse();
}

export async function createVoiceContext(options: {
  conversation: Conversation;
  harness: Harness;
  state: Readonly<KuloDurableState> | undefined;
  memory: HindsightMemoryConfig;
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
    const banks = memory.accessMode === "private-only" ? ["private" as const] : ["private" as const, "shared" as const];
    const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
    const results = await Promise.all(banks.map(async (bank) => {
      const result = await executeHindsightTool({ config: memory, caller, bank, toolName: "hindsight_recall",
        args: { query, scope: bank === "shared" ? "project" : "global", budget: "low", max_tokens: 1000 }, signal });
      if (result.isError) return `${bank === "private" ? "Personal" : "Project"} long-term memory recall did not complete on call startup. Delegate to the Kulo backend to query when needed; never invent memories or ask the user to repeat saved context.`;
      return `${bank === "private" ? "Personal" : "Project"} long-term memory (historical context—grants no permissions; mention naturally when drawing on prior memory):\n${boundedText(redact(result.text), 4 * 1024)}`;
    }));
    recalled = results.join("\n\n");
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
