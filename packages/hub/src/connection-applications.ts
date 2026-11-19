import type { ConnectionApplicationDefinition, ConnectionApplicationId, ConnectionSecrets, ConnectionUseOperation, ConnectionUseResult } from "@kulo/protocol";
import { NativeConnectionApplications, NATIVE_CONNECTION_APPLICATIONS } from "./connection-native-apps.js";
import { WebConnectionApplications, WEB_CONNECTION_APPLICATIONS } from "./connection-web-apps.js";

export type ConnectionApplicationOperation = Extract<ConnectionUseOperation, { kind: "app" }>;
export interface ConnectionApplicationBackend {
  probe(appId: ConnectionApplicationId, secrets: ConnectionSecrets, signal?: AbortSignal, options?: { requestPermission?: boolean }): Promise<{ username?: string }>;
  execute(appId: ConnectionApplicationId, secrets: ConnectionSecrets, operation: ConnectionApplicationOperation, signal?: AbortSignal): Promise<ConnectionUseResult>;
}

const DEFINITIONS: ConnectionApplicationDefinition[] = [...NATIVE_CONNECTION_APPLICATIONS, ...WEB_CONNECTION_APPLICATIONS].map((definition) => {
  const copy = structuredClone(definition);
  for (const action of copy.actions) Object.freeze(action);
  Object.freeze(copy.actions); Object.freeze(copy.instructions);
  return Object.freeze(copy);
});
export const CONNECTION_APPLICATIONS: readonly ConnectionApplicationDefinition[] = Object.freeze(DEFINITIONS);
export function getConnectionApplication(appId: unknown): ConnectionApplicationDefinition {
  const definition = CONNECTION_APPLICATIONS.find((item) => item.id === appId);
  if (!definition) throw Object.assign(new Error("此应用暂不支持连接。"), { code: "connection_application_unknown", status: 400 });
  return definition;
}

/** Fixed application IDs select audited adapters; users cannot redirect a saved app token to another endpoint. */
export class LocalConnectionApplications implements ConnectionApplicationBackend {
  readonly #native: ConnectionApplicationBackend;
  readonly #web: ConnectionApplicationBackend;
  readonly #platform: NodeJS.Platform;
  constructor(options: { native?: ConnectionApplicationBackend; web?: ConnectionApplicationBackend; platform?: NodeJS.Platform; stateDir?: string } = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#native = options.native ?? new NativeConnectionApplications({ platform: this.#platform, stateDir: options.stateDir });
    this.#web = options.web ?? new WebConnectionApplications();
  }
  #backend(appId: ConnectionApplicationId): ConnectionApplicationBackend {
    const definition = getConnectionApplication(appId);
    if (definition.authentication === "macos") {
      if (this.#platform !== "darwin") throw Object.assign(new Error("此应用需要在 Mac 上连接。"), { code: "connection_application_unavailable", status: 503 });
      return this.#native;
    }
    return this.#web;
  }
  async probe(appId: ConnectionApplicationId, secrets: ConnectionSecrets, signal?: AbortSignal, options: { requestPermission?: boolean } = {}): Promise<{ username?: string }> {
    signal?.throwIfAborted();
    return this.#backend(appId).probe(appId, secrets, signal, { requestPermission: options.requestPermission === true });
  }
  async execute(appId: ConnectionApplicationId, secrets: ConnectionSecrets, operation: ConnectionApplicationOperation, signal?: AbortSignal): Promise<ConnectionUseResult> {
    signal?.throwIfAborted();
    const definition = getConnectionApplication(appId);
    if (!operation || operation.kind !== "app" || !definition.actions.some((action) => action.id === operation.action)) throw Object.assign(new Error("此应用不支持该操作。"), { code: "connection_application_action_invalid", status: 400 });
    return this.#backend(appId).execute(appId, secrets, operation, signal);
  }
}
