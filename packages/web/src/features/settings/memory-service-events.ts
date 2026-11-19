import type { MemoryServiceOperation, MemoryServiceSnapshot } from "@moco/protocol";

export const MEMORY_SERVICE_INTENT_EVENT = "moco:memory-service-intent";
export const MEMORY_SERVICE_CHANGED_EVENT = "moco:memory-service-changed";
export const MEMORY_CONNECTION_FOCUS_EVENT = "moco:memory-connection-focus";
export type MemoryDialogueOperation = Extract<MemoryServiceOperation, "deploy" | "configure" | "uninstall">;
export const isMemoryDialogueOperation = (operation: MemoryServiceOperation): operation is MemoryDialogueOperation => ["deploy", "configure", "uninstall"].includes(operation);
let pendingIntent: MemoryServiceOperation | null = null;

export function requestMemoryService(operation: MemoryServiceOperation): void {
  if (!isMemoryDialogueOperation(operation)) { requestMemoryConnectionFocus(); return; }
  pendingIntent = operation;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MEMORY_SERVICE_INTENT_EVENT, { detail: operation }));
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
