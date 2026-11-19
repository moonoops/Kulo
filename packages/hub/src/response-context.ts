import { createHash } from "node:crypto";
import { AssistantEntry, ToolResultEntry, type EntryRecord } from "@earendil-works/pi-durable";
import { isRecoveryInputBoundary, WorkerRecoveryEntry } from "./state.js";
import { ContentPublicationEntry } from "./ui-cards.js";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Resolve display ownership from transcript causality, including publications written before provenance existed. */
export function resolveResponseContext(entries: readonly EntryRecord[]): { responseIds: Map<number, number>; currentResponseId?: number } {
  const responseIds = new Map<number, number>();
  const calls = new Map<string, number>();
  const legacyAssets = new Map<string, number>();
  let currentResponseId: number | undefined;
  let recovering = false;

  for (const entry of entries) {
    const id = Number(entry.id);
    if (isRecoveryInputBoundary(entry)) {
      currentResponseId = id;
      calls.clear();
      legacyAssets.clear();
      recovering = WorkerRecoveryEntry.is(entry);
      continue;
    }
    if (recovering) continue;
    if (AssistantEntry.is(entry)) {
      const message = entry.model?.[0];
      if (message?.role !== "assistant") continue;
      currentResponseId ??= id;
      responseIds.set(id, currentResponseId);
      const toolCalls = message.content.filter((part) => part.type === "toolCall");
      for (const call of toolCalls) {
        calls.set(call.id, currentResponseId);
        if (call.name === "kulo_publish_asset") {
          const sourceCallId = `asset:${hash([Number(entry.conversationId), call.id])}`;
          legacyAssets.set(`asset_${hash([Number(entry.conversationId), sourceCallId]).slice(0, 32)}`, currentResponseId);
        }
      }
      // A later continue without another input is a new reply, even though Pi has no new user entry.
      if (message.stopReason !== "toolUse" && toolCalls.length === 0) {
        currentResponseId = undefined;
        calls.clear();
        legacyAssets.clear();
      }
      continue;
    }
    if (ToolResultEntry.is(entry)) {
      const message = entry.model?.[0];
      const responseId = message?.role === "toolResult" ? calls.get(message.toolCallId) : undefined;
      if (responseId !== undefined) responseIds.set(id, responseId);
      continue;
    }
    if (!ContentPublicationEntry.is(entry)) continue;
    const source = entry.data.source;
    let responseId: number | undefined;
    if (source) {
      if (source.conversationId === Number(entry.conversationId)) responseId = calls.get(source.callId);
    } else {
      // A standalone notification must not acquire ownership merely because it is next to an assistant.
      const owners = entry.data.parts.map((part) => legacyAssets.get(part.partId));
      if (owners.length && owners.every((owner) => owner !== undefined && owner === owners[0])) responseId = owners[0];
    }
    if (responseId !== undefined) responseIds.set(id, responseId);
  }
  return { responseIds, ...(currentResponseId === undefined ? {} : { currentResponseId }) };
}
