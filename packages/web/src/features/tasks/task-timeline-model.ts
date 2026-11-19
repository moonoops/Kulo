import type { ChatDisplayItem } from "@moco/protocol";

export type TaskToolCall = NonNullable<ChatDisplayItem["toolCalls"]>[number];
export interface TaskToolEvent { id: string; call: TaskToolCall; createdAt?: number }
export type TaskTimelineEntry =
  | { kind: "message"; id: string; item: ChatDisplayItem }
  | { kind: "tools"; id: string; name: string; calls: TaskToolEvent[] };

export function taskTimeline(transcript: readonly ChatDisplayItem[]): TaskTimelineEntry[] {
  const entries: TaskTimelineEntry[] = [];
  for (const item of transcript) {
    if (item.text.trim() || item.parts?.length || item.attachments?.length || item.thinking?.trim()) {
      entries.push({ kind: "message", id: `message:${item.id}`, item });
    }
    for (const call of item.toolCalls ?? []) {
      const event = { id: `${item.id}:${call.id}`, call, createdAt: item.createdAt };
      const previous = entries.at(-1);
      if (previous?.kind === "tools" && previous.name === call.name) previous.calls.push(event);
      else entries.push({ kind: "tools", id: `tool:${event.id}`, name: call.name, calls: [event] });
    }
  }
  return entries;
}

export function toolActionSummary(call: TaskToolCall): string {
  if (call.actionSummary) return call.actionSummary;
  try {
    const args = JSON.parse(call.argsSummary) as Record<string, unknown>;
    for (const key of ["command", "path", "file_path", "query", "url", "action"]) {
      if (typeof args[key] === "string" && args[key].trim()) return args[key].trim().split("\n")[0]!;
    }
  } catch { /* Stored argument summaries may already be truncated. */ }
  return call.argsSummary;
}
