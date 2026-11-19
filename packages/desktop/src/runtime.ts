import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KuloHub, KuloHubServer } from "@kulo/hub";
import type { DevicePeerConfig } from "@kulo/protocol";
import {
  buildRuntimeEnvironment,
  loadDesktopRuntimeOptions,
  prepareDesktopRuntime,
  readDesktopRuntimePort,
  resolveDesktopRuntimePaths,
  saveDesktopRuntimePort,
} from "./runtime-config.js";

interface Closable { close(): Promise<unknown> }

export interface RuntimeResources {
  server?: Closable;
  hub?: Closable;
}

/** Always close the Hub even if closing the listener failed. */
export function createRuntimeShutdown(resources: RuntimeResources): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => closing ??= (async () => {
    const errors: unknown[] = [];
    for (const resource of [resources.server, resources.hub]) {
      if (!resource) continue;
      try { await resource.close(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Kulo 后台服务未能完整关闭。");
  })();
}

export async function runDesktopRuntime(): Promise<void> {
  if (!process.send) throw new Error("Kulo 后台服务需要由桌面客户端启动。");
  const options = loadDesktopRuntimeOptions(process.env);
  const env = buildRuntimeEnvironment(process.env, options);
  for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env);

  const paths = resolveDesktopRuntimePaths(options.dataDir);
  process.umask(0o077);
  const token = prepareDesktopRuntime(paths);
  let activePort = readDesktopRuntimePort(paths);
  process.chdir(paths.dataDir);

  let hub: KuloHub | undefined;
  let activePeer: DevicePeerConfig | undefined;
  const resources: RuntimeResources = {};
  const close = createRuntimeShutdown(resources);
  let startupComplete!: () => void;
  const startup = new Promise<void>((resolve) => { startupComplete = resolve; });
  let roles: import("@kulo/env").DeviceRoleTransitions | undefined;
  let runtimeOwner: import("@kulo/env").LocalInstanceOwner | undefined;
  let stopping = false;
  let finishing: Promise<void> | undefined;
  let finalExitCode = 0;

  const safeText = (raw: string): string => {
    let text = (hub ? hub.connectionManager.redact(raw) : raw).replaceAll(token, "[已隐藏]");
    for (const secret of [activePeer?.envToken, activePeer?.clientToken]) {
      if (secret) text = text.replaceAll(secret, "[已隐藏]");
    }
    return text;
  };
  const safeMessage = (error: unknown): string => {
    const message = error instanceof Error ? error.message : "未知后台服务错误。";
    return safeText(message);
  };
  const report = (error: unknown): void => {
    const message = safeMessage(error);
    if (process.connected) process.send?.({ type: "error", message }, () => {});
    else console.error(message);
  };
  const stop = (exitCode: number): Promise<void> => {
    if (exitCode !== 0) finalExitCode = exitCode;
    return finishing ??= (async () => {
      stopping = true;
      await startup;
      await roles?.settled();
      try { await close(); }
      catch (error) { report(error); finalExitCode = 1; }
      runtimeOwner?.close();
      process.exit(finalExitCode);
    })();
  };
  const fatal = (error: unknown): void => {
    report(error);
    void stop(1);
  };

  process.on("message", (message: unknown) => {
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "shutdown") void stop(0);
  });
  process.once("disconnect", () => { void stop(0); });
  process.once("SIGINT", () => { void stop(0); });
  process.once("SIGTERM", () => { void stop(0); });
  process.once("uncaughtException", fatal);
  process.once("unhandledRejection", fatal);

  const closeActiveResources = async (): Promise<void> => {
    const currentServer = resources.server;
    const currentHub = resources.hub;
    resources.server = undefined;
    resources.hub = undefined;
    hub = undefined;
    const errors: unknown[] = [];
    for (const resource of [currentServer, currentHub]) {
      if (!resource) continue;
      try { await resource.close(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Kulo 后台服务切换模式时未能关闭旧服务。");
  };

  try {
    // Imports that discover credentials or configuration run only after isolation is established.
    const { claimKuloRuntime, DeviceRoleTransitions, readPeerConfig, startDevicePeer } = await import("@kulo/env");
    if (stopping) return;
    runtimeOwner = claimKuloRuntime(paths.stateDir);

    const startPeerRuntime = async (peerConfig: DevicePeerConfig) => {
      await closeActiveResources();
      activePeer = peerConfig;
      const peer = await startDevicePeer(peerConfig, {
        runtimeOwner,
        port: activePort,
        configPath: paths.peerConfigPath,
        authToken: token,
        webDistDir: options.webDir,
        protectedPaths: [paths.stateDir, path.join(paths.dataDir, "chromium")],
        roleTransitions: roles,
        onLog: (message) => console.log(safeText(message)),
      });
      resources.server = peer;
      activePort = peer.port;
      saveDesktopRuntimePort(paths, activePort);
      return peer;
    };

    const startHubRuntime = async (): Promise<string> => {
      await closeActiveResources();
      activePeer = undefined;
      const { KuloHub, startKuloHubServer } = await import("@kulo/hub");
      hub = await KuloHub.open({ config: {
        stateDir: paths.stateDir,
        identityDir: paths.identityDir,
        localEnvRoot: paths.workspaceDir,
        authToken: token,
        host: "127.0.0.1",
        port: activePort,
        envTokens: {},
        workerEnvIds: [],
        enableLocalEnv: true,
        ...(options.appRoot ? { customization: {
          dataDir: paths.dataDir, appRoot: options.appRoot, nodePath: process.execPath,
          shellVersion: options.shellVersion, sourceRoot: options.sourceRoot,
          trustedRoot: options.trustedRoot ?? options.appRoot,
        } } : {}),
      } });
      resources.hub = hub;
      hub.envManager.protectPaths([
        path.dirname(paths.peerConfigPath),
        path.join(paths.dataDir, "chromium"),
      ]);
      const server: KuloHubServer = await startKuloHubServer(hub, {
        runtimeOwner,
        port: activePort,
        webDistDir: options.webDir,
        peerConfigPath: paths.peerConfigPath,
        peerRootDir: paths.workspaceDir,
        roleTransitions: roles,
      });
      resources.server = server;
      activePort = server.port;
      saveDesktopRuntimePort(paths, activePort);
      return server.url;
    };

    roles = new DeviceRoleTransitions({
      configPath: paths.peerConfigPath, rootDir: paths.workspaceDir,
      startHub: startHubRuntime, startPeer: startPeerRuntime, onRecoveryFailure: fatal,
    });
    const initialPeer = readPeerConfig(paths.peerConfigPath);
    const readyUrl = initialPeer
      ? (await startPeerRuntime(initialPeer)).url
      : await startHubRuntime();
    if (stopping) return;
    await new Promise<void>((resolve, reject) => {
      process.send!({ type: "ready", url: readyUrl, token }, (error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    report(error);
    startupComplete();
    await stop(1);
  } finally {
    startupComplete();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDesktopRuntime().catch((error: unknown) => {
    // Before the private token exists, validation errors contain paths and field names only.
    const message = error instanceof Error ? error.message : "Kulo 后台服务启动失败。";
    if (process.connected) process.send?.({ type: "error", message }, () => process.exit(1));
    else { console.error(message); process.exit(1); }
  });
}
