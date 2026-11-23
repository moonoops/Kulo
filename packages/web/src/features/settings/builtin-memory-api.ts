import type {
  BuiltinMemoryClearRequest,
  BuiltinMemoryEnabledRequest,
  BuiltinMemoryStateView,
} from "@kulo/protocol";
import { apiRequest } from "../../kulo-api";

export const BUILTIN_MEMORY_CHANGED_EVENT = "kulo:builtin-memory-changed";

export function publishBuiltinMemoryState(state: BuiltinMemoryStateView): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BUILTIN_MEMORY_CHANGED_EVENT, { detail: state }));
  }
}

export const builtinMemoryApi = {
  getState: (signal?: AbortSignal) =>
    apiRequest<BuiltinMemoryStateView>("/api/builtin-memory", { method: "GET", ...(signal ? { signal } : {}) }),
  setEnabled: (request: BuiltinMemoryEnabledRequest) =>
    apiRequest<BuiltinMemoryStateView>("/api/builtin-memory/enabled", { method: "POST", body: request }),
  clear: (request: BuiltinMemoryClearRequest) =>
    apiRequest<BuiltinMemoryStateView>("/api/builtin-memory/clear", { method: "POST", body: request }),
};
