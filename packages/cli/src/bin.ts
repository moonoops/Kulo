#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { KULO_VERSION, type DevicePeerConfig } from "@kulo/protocol";
import {
  activateStagedPeer, claimKuloRuntime, DeviceRoleTransitions, discoverDevicePeer, discoverKuloRuntime, getPeerConfigPath, LocalInstanceInUseError, KuloEnvAgent,
  normalizePeerHubUrl, readPeerConfig, stageDevicePeer, startDevicePeer, type DevicePeerRuntime, type LocalInstanceOwner,
} from "@kulo/env";
import {
  createStandbyHostBridge, findRunningHub, getClusterProtectedPaths, HubStateInUseError, KuloHub, loadDotEnv,
  recoverInterruptedClusterTransition, resolveClusterPaths, resolveHubStateDir, runPreStartFence, startKuloHubServer, type KuloHubServer,
} from "@kulo/hub";
import { runTuiChatClient } from "./tui-chat.js";
import { confirmRunningPeer, findRunningDevicePeer, joinRunningHub, resolveChatConnection, runJoinedDeviceCommand } from "./device-launch.js";

function resolveOptionalWebDistDir(): string | undefined {
  const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  return fs.existsSync(path.join(candidate, "index.html")) ? candidate : undefined;
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  const prefixed = args.find((a) => a.startsWith(`${flag}=`));
  if (prefixed) return prefixed.slice(flag.length + 1);
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function printHelp(): void {
  console.log(`
Kulo v${KULO_VERSION} — Low-attention SuperAgent built on Pi Durable + Pi Env

用法:
  kulo [dev] [--port 7788] [--no-tui] [--standalone]
      已配对设备默认连接原主脑；单机启动本机 Hub 与 Pi Env

  kulo join --hub <主脑地址> --invite <配对凭证> [--root ~/Kulo] [--no-open]
      加入主脑并保存连接，后续启动自动进入同一套对话和任务

  kulo open [--no-open]
      启动 Kulo 并打开 Web 控制台

  kulo hub [--host 0.0.0.0] [--port 7788] [--state-dir ./.kulo-state] [--no-local-env]
      独立启动常驻大脑中枢服务（管理 Pi Durable SQLite 与调度池）

  kulo env --connect ws://127.0.0.1:7788/ws/env --id <env-id> [--root ./workspace] [--token <node-token>]
      在任意电脑/服务器上启动 Pi Env 执行守护进程并反向注册至 Hub

  kulo chat [--url ws://127.0.0.1:7788/ws/client] [--token <token>]
      启动终端准全双工客户端连接运行中的 Hub

  kulo --version
      查看当前版本号
`);
}

function openBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]] as const
    : process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const
      : ["xdg-open", [url]] as const;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("系统浏览器启动失败。")));
  });
}

async function openHubConsole(url: URL): Promise<void> {
  try { await openBrowser(url.toString()); }
  catch { console.error(`无法自动打开浏览器，请访问 Web 控制台：${url.origin}`); }
}

function registerDeviceShutdown(close: () => Promise<void>): () => void {
  const shutdown = () => {
    void close().catch(() => {
      console.error("Kulo 设备客户端关闭失败。");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  };
}

async function main(runtime: { owner?: LocalInstanceOwner }): Promise<void> {
  loadDotEnv();
  const [, , subcommand = "dev", ...rest] = process.argv;

  if (subcommand === "-v" || subcommand === "--version" || subcommand === "version") {
    console.log(`kulo v${KULO_VERSION}`);
    return;
  }

  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    printHelp();
    return;
  }

  const cliWebDistDir = resolveOptionalWebDistDir();
  if (subcommand === "hub" || subcommand === "dev" || subcommand === "open" || subcommand === "join") {
    const host = getFlag(rest, "--host");
    const portStr = getFlag(rest, "--port");
    const stateDir = getFlag(rest, "--state-dir");
    const directory = resolveHubStateDir(stateDir);
    const peerConfigPath = getPeerConfigPath();
    const clusterPaths = resolveClusterPaths(path.dirname(directory), {
      hubStateDir: directory,
      peerConfigPath,
    });
    const clusterProtectedPaths = getClusterProtectedPaths(clusterPaths);
    await recoverInterruptedClusterTransition(clusterPaths);
    const claimRuntime = () => runtime.owner ??= claimKuloRuntime(directory);
    const noLocalEnv = hasFlag(rest, "--no-local-env");
    const noTui = subcommand !== "dev" || hasFlag(rest, "--no-tui") || !process.stdin.isTTY;
    const allowRoleSwitch = subcommand !== "hub" && noTui;

    let activeHub: KuloHub | undefined;
    let activeServer: KuloHubServer | undefined;
    let activePeer: DevicePeerRuntime | undefined;
    let boundPort = portStr ? Number.parseInt(portStr, 10) : undefined;
    let localToken = process.env.KULO_AUTH_TOKEN?.trim() || undefined;
    let roles: DeviceRoleTransitions;

    const startCliHub = async (): Promise<{ hub: KuloHub; server: KuloHubServer }> => {
      claimRuntime();
      if (activePeer) {
        await activePeer.close();
        activePeer = undefined;
      }
      if (activeServer) { await activeServer.close(); activeServer = undefined; }
      if (activeHub) { await activeHub.close(); activeHub = undefined; }
      const nextHub = await KuloHub.open({
        config: {
          ...(host ? { host } : {}),
          ...(boundPort !== undefined ? { port: boundPort } : {}),
          ...(stateDir ? { stateDir: path.resolve(stateDir) } : {}),
          enableLocalEnv: !noLocalEnv,
          extraProtectedPaths: clusterProtectedPaths,
        },
      });
      activeHub = nextHub;
      localToken = nextHub.config.authToken;
      let nextServer: KuloHubServer;
      try {
        nextServer = await startKuloHubServer(nextHub, {
          runtimeOwner: runtime.owner,
          ...(boundPort !== undefined ? { port: boundPort } : {}),
          ...(allowRoleSwitch ? { roleTransitions: roles } : {}),
          clusterPaths,
        });
      } catch (error) {
        await nextHub.close();
        activeHub = undefined;
        throw error;
      }
      activeServer = nextServer;
      boundPort = nextServer.port;
      return { hub: nextHub, server: nextServer };
    };

    const startCliPeer = async (config: DevicePeerConfig): Promise<DevicePeerRuntime> => {
      claimRuntime();
      if (activePeer) { await activePeer.close(); activePeer = undefined; }
      if (activeServer) { await activeServer.close(); activeServer = undefined; }
      if (activeHub) { await activeHub.close(); activeHub = undefined; }
      activePeer = await startDevicePeer(config, {
        runtimeOwner: runtime.owner,
        port: boundPort, authToken: localToken,
        webDistDir: cliWebDistDir,
        protectedPaths: [directory, ...clusterProtectedPaths],
        standbyHost: createStandbyHostBridge({ paths: clusterPaths }),
        ...(allowRoleSwitch ? { roleTransitions: roles } : {}),
        onLog: (message) => console.log(message),
      });
      boundPort = activePeer.port;
      return activePeer;
    };
    let closingRuntime: Promise<void> | undefined;
    const closeRuntime = () => closingRuntime ??= (async () => {
      await roles.settled();
      const failures: unknown[] = [];
      for (const service of [activePeer, activeServer, activeHub]) {
        try { await service?.close(); } catch (error) { failures.push(error); }
      }
      runtime.owner?.close();
      if (failures.length) throw new AggregateError(failures, "未能完整关闭 Kulo。");
    })();
    roles = new DeviceRoleTransitions({ startHub: startCliHub, startPeer: startCliPeer,
      onRecoveryFailure: (error) => { console.error(error.message); process.exitCode = 1; },
    });
    const current = subcommand === "open" || subcommand === "join" ? await discoverKuloRuntime(directory, localToken) : undefined;
    if (subcommand === "open" && current) {
      console.log(`Kulo 已在运行，Web 控制台：${current.url.origin}`);
      if (!hasFlag(rest, "--no-open")) await openHubConsole(current.url);
      return;
    }
    if (subcommand === "join") {
      const hubUrl = getFlag(rest, "--hub");
      const inviteToken = getFlag(rest, "--invite");
      if (!hubUrl || !inviteToken) throw new Error("请提供 --hub 主脑地址和 --invite 配对凭证。");
      if (current?.status.role === "joined" && current.status.hubUrl === normalizePeerHubUrl(hubUrl)) {
        await confirmRunningPeer(async () => {
          const next = await discoverKuloRuntime(directory, localToken);
          return next?.status.role === "joined" && next.status.hubUrl === current.status.hubUrl ? next : undefined;
        });
        console.log(`设备已连通该主机。Web 控制台：${current.url.origin}`);
        if (!hasFlag(rest, "--no-open")) await openHubConsole(current.url);
        return;
      }
      const existing = current?.url ?? await findRunningHub(directory, localToken);
      if (existing) {
        const root = getFlag(rest, "--root");
        const confirmed = await joinRunningHub(async () => (await discoverKuloRuntime(directory, localToken))?.url ?? await findRunningHub(directory, localToken),
          { hubUrl, inviteToken, rootDir: root && (root.startsWith("~") ? root : path.resolve(root)) }, async (message) => {
          if (!process.stdin.isTTY) return false;
          const prompt = createInterface({ input: process.stdin, output: process.stdout });
          try { return /^(y|yes|是)$/i.test((await prompt.question(`${message} 继续接入？[y/N] `)).trim()); }
          finally { prompt.close(); }
        });
        console.log(`已接入主机。Web 控制台：${confirmed.origin}`);
        if (!hasFlag(rest, "--no-open")) await openHubConsole(confirmed);
        if (process.stdin.isTTY && !hasFlag(rest, "--no-tui")) {
          const ws = new URL("/ws/client", confirmed);
          ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
          await runTuiChatClient({ wsUrl: ws.toString(), authToken: confirmed.searchParams.get("token") ?? undefined });
        }
        return;
      }
    }
    const joined = await runJoinedDeviceCommand(subcommand, rest, Boolean(process.stdin.isTTY), {
      readConfig: () => readPeerConfig(), stage: (...args) => { claimRuntime(); return stageDevicePeer(...args); }, activate: activateStagedPeer,
      confirmRunning: (config) => confirmRunningPeer(() => discoverDevicePeer(config, localToken)),
      findRunning: async (config, port) => {
        const found = await findRunningDevicePeer(config, port, localToken);
        if (found?.authToken) localToken = found.authToken;
        else if (found?.omitLocalToken) localToken = undefined;
        return found;
      },
      start: async (config, port) => {
        boundPort = port;
        const peer = await startCliPeer(config);
        localToken = peer.authToken;
        return { url: peer.url, ready: peer.ready, close: closeRuntime };
      },
      runTui: (options) => runTuiChatClient({ ...options, authToken: localToken }),
      openBrowser: async (url) => {
        const entry = new URL(url);
        if (localToken) entry.searchParams.set("token", localToken);
        await openBrowser(entry.toString());
      },
      registerShutdown: registerDeviceShutdown, log: (message) => console.log(message),
    });
    if (joined) {
      if (!activePeer && !activeHub) runtime.owner?.close();
      return;
    }
    const fence = await runPreStartFence(clusterPaths, { defaultRootDir: process.cwd() });
    if (fence.action === "start_peer") {
      const peer = await startCliPeer(fence.peerConfig);
      localToken = peer.authToken;
      registerDeviceShutdown(closeRuntime);
      console.log(`已检测到更新的主机（${fence.activePrimaryUrl}），本机自动切为备用主机同步。Web 控制台：${peer.url}`);
      if (subcommand === "open" && !hasFlag(rest, "--no-open")) await openBrowser(peer.url);
      return;
    }
    const { hub, server } = await startCliHub();

    const shutdown = async () => {
      console.log("\n正在安全保存状态并关闭 Kulo...");
      await closeRuntime();
      process.exit(0);
    };

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());

    console.log(`\x1b[32m✓ Kulo Hub v${KULO_VERSION} 已启动\x1b[0m`);
    console.log(`  • Web 控制台 : \x1b[36m${subcommand === "open" ? server.localUrl : server.url}\x1b[0m`);
    console.log(`  • Client WS  : ${server.clientWsUrl}`);
    console.log(`  • Env 接入点 : ${server.envWsUrl}`);
    console.log(`  • 默认模型   : ${hub.config.model.defaultModel} (${hub.config.model.baseUrl})`);
    console.log(`  • 状态目录   : ${hub.config.stateDir}`);

    if (!hub.config.model.apiKey) {
      console.log(
        `  \x1b[33m! 提示: 当前未检测到 KULO_API_KEY / OPENAI_API_KEY，请在 .env 中配置后再发起模型对话。\x1b[0m`,
      );
    }

    if (subcommand === "open" && !hasFlag(rest, "--no-open")) {
      const browserUrl = new URL(server.localUrl);
      if (hub.config.authToken) browserUrl.searchParams.set("token", hub.config.authToken);
      await openHubConsole(browserUrl);
    }

    if (!noTui) {
      await runTuiChatClient({
        wsUrl: server.clientWsUrl,
        authToken: hub.config.authToken,
        onExit: closeRuntime,
      });
    }
    return;
  }

  if (subcommand === "env") {
    const connectUrl =
      getFlag(rest, "--connect") ??
      process.env.KULO_HUB_WS_URL ??
      "ws://127.0.0.1:7788/ws/env";
    const envId =
      getFlag(rest, "--id") ??
      getFlag(rest, "--name") ??
      os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const displayName = getFlag(rest, "--name") ?? `${envId} (${os.hostname()})`;
    const rootDir = path.resolve(
      getFlag(rest, "--root") ?? path.join(process.cwd(), ".kulo-env-workspace"),
    );
    const authToken = getFlag(rest, "--token") ?? process.env.KULO_ENV_TOKEN;
    if (!authToken?.trim()) throw new Error("Env registration requires KULO_ENV_TOKEN or --token with a node-specific credential.");

    const agent = new KuloEnvAgent({
      hubUrl: connectUrl,
      envId,
      name: displayName,
      rootDir,
      authToken,
      onLog: (msg) => console.log(`[kulo-env:${envId}] ${msg}`),
    });

    const shutdown = async () => {
      console.log("\n正在断开并关闭 kulo-env...");
      await agent.stop();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());

    await agent.start();
    console.log(
      `\x1b[32m✓ kulo-env '${envId}' 已就绪并保持在线\x1b[0m (工作根目录: ${rootDir})`,
    );
    return;
  }

  if (subcommand === "chat") {
    await runTuiChatClient(resolveChatConnection(rest, process.env, () => readPeerConfig()));
    return;
  }

  console.error(`未知子命令: ${subcommand}`);
  printHelp();
  process.exit(1);
}

async function launch(): Promise<void> {
  for (;;) {
    const runtime: { owner?: LocalInstanceOwner } = {};
    try { return await main(runtime); }
    catch (error) {
      runtime.owner?.close();
      if (error instanceof LocalInstanceInUseError && ["open", "join"].includes(process.argv[2] ?? "")) continue;
      if (!(error instanceof HubStateInUseError) || process.argv[2] !== "open") throw error;
      const url = await findRunningHub(error.stateDir, process.env.KULO_AUTH_TOKEN?.trim());
      if (!url) continue;
      console.log(`Kulo 已在运行，Web 控制台：${url.origin}`);
      if (!hasFlag(process.argv.slice(3), "--no-open")) await openHubConsole(url);
      return;
    }
  }
}

launch().catch((err) => {
  let message = err instanceof Error ? err.message : "未知启动错误";
  for (const flag of ["--invite", "--token"]) {
    const credential = getFlag(process.argv, flag);
    if (credential) message = message.replaceAll(credential, "[已隐藏]");
  }
  console.error("Kulo 启动失败:", message);
  process.exit(1);
});
