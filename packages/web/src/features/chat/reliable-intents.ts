import type { ClientToHubMessage } from "@moco/protocol";

export function newDeliveryId(prefix: string): string {
  if (globalThis.crypto.randomUUID) return `${prefix}:${globalThis.crypto.randomUUID()}`;
  return `${prefix}:${[...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([first], [second]) => first.localeCompare(second))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Coalesce one pending button intent, while explicit message IDs still distinguish deliberate sends. */
export function deliveryIntentKey(message: ClientToHubMessage): string {
  const { requestId: _request, commandId: _command, ...payload } = message as ClientToHubMessage & { requestId?: string; commandId?: string };
  return JSON.stringify(canonical(payload));
}
