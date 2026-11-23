#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KULO_VERSION, type DevicePeerConfig } from "@kulo/protocol";
import {
  claimKuloRuntime,
  DeviceRoleTransitions,
  ensureHostRuntimeToken,
  readHostRuntimePort,
  readPeerConfig,
  resolveDefaultHostDataDir,
  resolveKuloHostLayout,
  saveHostRuntimePort,
  startDevicePeer,
  type DevicePeerRuntime,
  type HostAppChannel,
  type LocalInstanceOwner,
} from "@kulo/env";
import {
  createStandbyHostBridge,
  getClusterProtectedPaths,
  KuloHub,
  loadDotEnv,
  recoverInterruptedClusterTransition,
  resolveClusterPaths,
  runPreStartFence,
  startKuloHubServer,
  type KuloHubServer,
} from "@kulo/hub";

export interface RunHeadlessHostOptions {
  dataDir?: string;
  channel?: HostAppChannel;
  host?: string;
  port?: number;
  webDistDir?: string;
  noLocalEnv?: boolean;
  onLog?: (message: string) => void;
}

export interface HeadlessHostHandle {
  readonly url: string;
  readonly port: number;
  readonly dataDir: string;
  readonly role: "hub" | "peer";
  close(): Promise<void>;
}

function resolvePackagedWebDistDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../web/dist"),
    path.resolve(here, "../../../web/dist"),
    path.resolve(here, "../web/dist"),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html")));
}

/**
 * Standalone headless Kulo host runtime shared by Linux `.deb` (`kulo host`),
 * `Kulo-Runtime-*.tar.gz`, and systemd user services.
 *
 * Uses the exact same data layout, `runtime-token`, `runtime-port`, and `kulo-runtime`
 * single-instance lock as Desktop GUI so both can coexist seamlessly via Attach Mode.
 */
export async function startHeadlessHost(options: RunHeadlessHostOptions = {}): Promise<HeadlessHostHandle> {
  loadDotEnv();
  const log = options.onLog ?? ((message: string) => console.log(message));
  const dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : resolveDefaultHostDataDir({ channel: options.channel ?? "release" });
  const paths = resolveKuloHostLayout(dataDir);
  if (process.platform !== "win32") process.umask(0o077);
  const token = ensureHostRuntimeToken(paths);
  let activePort = options.port ?? readHostRuntimePort(paths);
  const webDistDir = options.webDistDir ?? resolvePackagedWebDistDir();

  // Always acquire the canonical runtime lock BEFORE replaying cluster transitions.
  const runtimeOwner: LocalInstanceOwner = claimKuloRuntime(paths.stateDir);
  const clusterPaths = resolveClusterPaths(paths.dataDir, {
    hubStateDir: paths.stateDir,
    peerConfigPath: paths.peerConfigPath,
  });
  const clusterProtectedPaths = getClusterProtectedPaths(clusterPaths);
  const sharedProtectedPaths = [
    ...clusterProtectedPaths,
    path.dirname(paths.peerConfigPath),
  ];

  let activeHub: KuloHub | undefined;
  let activeServer: KuloHubServer | undefined;
  let activePeer: DevicePeerRuntime | undefined;
  let closing: Promise<void> | undefined;

  const closeActive = async (): Promise<void> => {
    const targets: Array<{ close(): Promise<unknown> } | undefined> = [activePeer, activeServer, activeHub];
    activePeer = undefined;
    activeServer = undefined;
    activeHub = undefined;
    const errors: unknown[] = [];
    for (const target of targets) {
      if (!target) continue;
      try { await target.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "未能完整关闭 Kulo 无头主机服务。");
  };

  let roles!: DeviceRoleTransitions;

  const startPeer = async (peerConfig: DevicePeerConfig): Promise<DevicePeerRuntime> => {
    await closeActive();
    const peer = await startDevicePeer(peerConfig, {
      runtimeOwner,
      port: activePort,
      configPath: paths.peerConfigPath,
      authToken: token,
      webDistDir,
      protectedPaths: [paths.stateDir, ...sharedProtectedPaths],
      roleTransitions: roles,
      standbyHost: createStandbyHostBridge({ paths: clusterPaths }),
      onLog: log,
    });
    activePeer = peer;
    activePort = peer.port;
    saveHostRuntimePort(paths, activePort);
    return peer;
  };

  const startHub = async (): Promise<{ hub: KuloHub; server: KuloHubServer }> => {
    await closeActive();
    const hub = await KuloHub.open({
      config: {
        stateDir: paths.stateDir,
        identityDir: paths.identityDir,
        localEnvRoot: paths.workspaceDir,
        authToken: token,
        host: options.host ?? "127.0.0.1",
        port: activePort,
        envTokens: {},
        workerEnvIds: [],
        enableLocalEnv: !options.noLocalEnv,
        extraProtectedPaths: sharedProtectedPaths,
      },
    });
    activeHub = hub;
    hub.envManager.protectPaths(sharedProtectedPaths);
    let server: KuloHubServer;
    try {
      server = await startKuloHubServer(hub, {
        runtimeOwner,
        port: activePort,
        webDistDir,
        peerConfigPath: paths.peerConfigPath,
        peerRootDir: paths.workspaceDir,
        roleTransitions: roles,
        clusterPaths,
      });
    } catch (error) {
      await hub.close();
      activeHub = undefined;
      throw error;
    }
    activeServer = server;
    activePort = server.port;
    saveHostRuntimePort(paths, activePort);
    return { hub, server };
  };

  const closeAll = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await roles?.settled();
        await closeActive();
      } finally {
        runtimeOwner.close();
      }
    })());

  roles = new DeviceRoleTransitions({
    configPath: paths.peerConfigPath,
    rootDir: paths.workspaceDir,
    startHub: async () => (await startHub()).server.url,
    startPeer,
    onRecoveryFailure: (error) => {
      log(`Kulo 无头主机恢复失败：${error.message}`);
      void closeAll().finally(() => process.exit(1));
    },
  });

  try {
    await recoverInterruptedClusterTransition(clusterPaths);
    const existingPeer = readPeerConfig(paths.peerConfigPath);
    let url: string;
    let role: "hub" | "peer";
    if (existingPeer) {
      url = (await startPeer(existingPeer)).url;
      role = "peer";
    } else {
      const fence = await runPreStartFence(clusterPaths, { defaultRootDir: paths.workspaceDir });
      if (fence.action === "start_peer") {
        url = (await startPeer(fence.peerConfig)).url;
        role = "peer";
      } else {
        url = (await startHub()).server.url;
        role = "hub";
      }
    }
    log(`Kulo Host v${KULO_VERSION} 已启动（模式：${role}，地址：${url}，数据目录：${paths.dataDir}）`);
    return { url, port: activePort, dataDir: paths.dataDir, role, close: closeAll };
  } catch (error) {
    await closeAll().catch(() => {});
    throw error;
  }
}

function cliFlag(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portRaw = cliFlag(args, "--port");
  const port = portRaw !== undefined ? Number.parseInt(portRaw, 10) : undefined;
  const channelRaw = cliFlag(args, "--channel");
  const channel: HostAppChannel = channelRaw === "dev" ? "dev" : "release";
  startHeadlessHost({
    dataDir: cliFlag(args, "--data-dir"),
    channel,
    host: cliFlag(args, "--host"),
    ...(port !== undefined && Number.isInteger(port) ? { port } : {}),
    webDistDir: cliFlag(args, "--web-dir"),
    noLocalEnv: args.includes("--no-local-env"),
  })
    .then((handle) => {
      const shutdown = () => {
        void handle.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Kulo 无头主机启动失败。");
      process.exit(1);
    });
}
