import path from "node:path";
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { MocoHub, type MocoHubInitOptions } from "../../packages/hub/src/hub.js";
import { LocalConnectionVault } from "../../packages/hub/src/connection-vault.js";

/** Synthetic test keys never contact the user's OS credential store. */
export function openTestHub(init: MocoHubInitOptions = {}, context?: Context): Promise<MocoHub> {
  const stateDir = init.config?.stateDir;
  if (typeof stateDir !== "string" || !stateDir.trim()) throw new Error("Hub tests must provide an explicit temporary config.stateDir");
  const connectionVault = init.connectionVault ?? init.connectionManager?.localVault ?? new LocalConnectionVault({
    stateDir,
    keyStore: {
      async getOrCreateKey(namespace) {
        return createHash("sha256").update("moco-synthetic-test-key-v1\0").update(path.resolve(stateDir)).update("\0").update(namespace).digest();
      },
      async checkAvailability() {},
    },
  });
  return MocoHub.open(
    {
      ...init,
      config: { ...init.config, inlineDispatchWaitMs: init.config?.inlineDispatchWaitMs ?? 0 },
      connectionVault,
    },
    context,
  );
}
