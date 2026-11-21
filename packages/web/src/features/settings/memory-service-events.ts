import type { MemoryServiceOperation, MemoryServiceSnapshot } from "@kulo/protocol";

export const MEMORY_SERVICE_INTENT_EVENT = "kulo:memory-service-intent";
export const MEMORY_ASSISTANT_PREFILL_EVENT = "kulo:memory-assistant-prefill";
export const MEMORY_SERVICE_CHANGED_EVENT = "kulo:memory-service-changed";
export const MEMORY_CONNECTION_FOCUS_EVENT = "kulo:memory-connection-focus";
export type MemoryDialogueOperation = Extract<MemoryServiceOperation, "deploy" | "configure" | "uninstall">;
export const isMemoryDialogueOperation = (operation: MemoryServiceOperation): operation is MemoryDialogueOperation => ["deploy", "configure", "uninstall"].includes(operation);
let pendingIntent: MemoryServiceOperation | null = null;
let pendingPrefill: string | null = null;

export function requestMemoryService(operation: MemoryServiceOperation): void {
  if (!isMemoryDialogueOperation(operation)) { requestMemoryConnectionFocus(); return; }
  pendingIntent = operation;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MEMORY_SERVICE_INTENT_EVENT, { detail: operation }));
}

export function requestMemoryAssistantPrefill(draft: string): void {
  pendingPrefill = draft;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MEMORY_ASSISTANT_PREFILL_EVENT, { detail: draft }));
}

export function takeMemoryAssistantPrefill(): string | null {
  const draft = pendingPrefill;
  pendingPrefill = null;
  return draft;
}

export function requestMemoryConnectionFocus(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MEMORY_CONNECTION_FOCUS_EVENT));
}

export function takeMemoryServiceIntent(): MemoryServiceOperation | null {
  const operation = pendingIntent;
  pendingIntent = null;
  return operation;
}

export function publishMemoryService(snapshot: MemoryServiceSnapshot): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MEMORY_SERVICE_CHANGED_EVENT, { detail: snapshot }));
}
