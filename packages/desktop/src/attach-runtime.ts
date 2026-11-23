import { discoverKuloRuntime, readExistingHostRuntimeToken } from "@kulo/env";
import { resolveDesktopRuntimePaths } from "./runtime-config.js";

export interface AttachedHostRuntime {
  url: string;
  token: string;
}

export interface AttachExternalHostDeps {
  readToken?: (tokenPath: string) => string | undefined;
  discover?: (stateDir: string, token: string) => Promise<{ url: URL } | undefined>;
}

/**
 * Checks whether an external Kulo host runtime (e.g., `kulo host` / `kulo-host.service`)
 * is already serving this canonical data directory using the shared `runtime-token`.
 *
 * When present, the Electron GUI can attach directly to it without forking a duplicate
 * runtime, registering a Recovery process lease, or tearing down the external service on quit.
 */
export async function tryAttachExternalHostRuntime(
  dataDir: string,
  deps: AttachExternalHostDeps = {},
): Promise<AttachedHostRuntime | undefined> {
  const paths = resolveDesktopRuntimePaths(dataDir);
  const readToken = deps.readToken ?? readExistingHostRuntimeToken;
  const discover = deps.discover ?? discoverKuloRuntime;
  let token: string | undefined;
  try {
    token = readToken(paths.tokenPath);
  } catch {
    return undefined;
  }
  if (!token) return undefined;
  try {
    const running = await discover(paths.stateDir, token);
    if (!running) return undefined;
    return { url: running.url.origin, token };
  } catch {
    return undefined;
  }
}
