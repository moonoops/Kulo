import type { DevicePeerConfig, DeviceRoleTransition } from "@moco/protocol";
import { randomBytes } from "node:crypto";
import { discoverDevicePeer, DevicePeerInUseError, waitForPeerReady } from "@moco/env";
import type { TuiChatOptions } from "./tui-chat.js";

export function cliFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index !== -1) {
    const value = args[index + 1];
    return value && !value.startsWith("--") ? value : undefined;
  }
  return args.find((value) => value.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

function localPort(args: readonly string[]): number | undefined {
  const raw = cliFlag(args, "--port");
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port 必须是 0 到 65535 之间的整数。");
  }
  return port;
}

export interface JoinedDeviceProcess {
  url: string;
  ready?: Promise<unknown>;
  close(): Promise<void>;
}

export interface DeviceLaunchDependencies {
  readConfig(): DevicePeerConfig | null;
  stage(options: { hubUrl: string; inviteToken: string; rootDir?: string }): Promise<DevicePeerConfig>;
  activate(config: DevicePeerConfig): void;
  findRunning(config: DevicePeerConfig, port?: number): Promise<{ url: string } | null>;
  confirmRunning(config: DevicePeerConfig): Promise<void>;
  start(config: DevicePeerConfig, port?: number): Promise<JoinedDeviceProcess>;
  runTui(options: TuiChatOptions): Promise<void>;
  openBrowser(url: string): Promise<void>;
  registerShutdown(close: () => Promise<void>): () => void;
  log(message: string): void;
}

export async function confirmRunningPeer(discover: () => Promise<{ url: URL; status: { ready?: boolean; error?: string } } | undefined>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await discover();
    if (!current) throw new Error("无法确认现有设备客户端的连接，请从原启动环境检查。");
    if (current.status.error) throw new Error("现有设备客户端尚未连通主机，请检查连接后重试。");
    if (current.status.ready) {
      const credential = current.url.searchParams.get("token");
      const response = await fetch(new URL("/api/topics", current.url), {
        headers: credential ? { authorization: `Bearer ${credential}` } : undefined,
        redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      if (response.ok && Array.isArray((await response.json() as { items?: unknown }).items)) return;
      throw new Error("现有设备客户端未能读取主机对话，请检查连接后重试。");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("现有设备客户端尚未连通主机，请检查连接后重试。");
}

/** Re-prove the local listener after a role switch before sending its management credential. */
export async function joinRunningHub(
  discover: () => Promise<URL | undefined>,
  input: { hubUrl: string; inviteToken: string; rootDir?: string },
  confirmInterrupt: (message: string) => Promise<boolean>,
): Promise<URL> {
  let force = false;
  const endpoint = async () => {
    const url = await discover();
    if (!url) throw new Error("原运行实例已关闭，可使用原命令重试。");
    const token = url.searchParams.get("token");
    return { url, headers: token ? { authorization: `Bearer ${token}` } : {} as Record<string, string> };
  };
  for (;;) {
    const id = randomBytes(16).toString("hex");
    const source = await endpoint();
    const response = await fetch(new URL("/api/devices/join", source.url), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { ...source.headers, "content-type": "application/json", "x-moco-transition-id": id },
      body: JSON.stringify({ input: input.hubUrl, token: input.inviteToken, rootDir: input.rootDir, force }),
    }).catch(() => undefined); // A listener swap may race its acknowledgement.
    if (response && response.status !== 202) {
      const result = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!force && result.code === "local_tasks_running" && await confirmInterrupt(result.error ?? "本机有未结束的任务。")) {
        force = true;
        continue;
      }
      throw new Error(result.error ?? `现有主机未能受理接入（HTTP ${response.status}）。`);
    }
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      const current = await endpoint();
      const result = await fetch(new URL(`/api/devices/role-transition?id=${id}`, current.url), {
        redirect: "error", headers: current.headers, signal: AbortSignal.timeout(4_000),
      }).catch(() => undefined);
      if (result?.ok) {
        const state = await result.json() as DeviceRoleTransition;
        if (state.id === id && state.targetRole === "joined") {
          if (state.status === "ready") return current.url;
          if (state.status === "failed") {
            if (!force && state.code === "local_tasks_running" && await confirmInterrupt(state.error ?? "本机有未结束的任务。")) break;
            throw new Error(state.error ?? "设备接入失败。");
          }
        }
      }
      if (result?.status === 401 || result?.status === 403) throw new Error("本机主机的授权已改变，请重新打开 Moco。");
      if (result?.status === 404 && Date.now() - started > 5_000) throw new Error("未找到此次接入，请在本机设备互联查看当前状态。");
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    }
    if (Date.now() - started >= 120_000) throw new Error("尚未确认接入结果，请在本机设备互联查看当前状态。");
    force = true;
  }
}

function safeDiagnostic(error: unknown, config: DevicePeerConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const credential of [config.envToken, config.clientToken]) {
    if (credential) message = message.replaceAll(credential, "[已隐藏]");
  }
  return message;
}

/** Returns before any Hub is opened when this installation belongs to another Hub. */
export async function runJoinedDeviceCommand(
  command: string,
  args: readonly string[],
  isTTY: boolean,
  dependencies: DeviceLaunchDependencies,
): Promise<boolean> {
  if (!["dev", "open", "join"].includes(command)) return false;
  if (command !== "join" && args.includes("--standalone")) return false;

  let config: DevicePeerConfig | null;
  if (command === "join") {
    const hubUrl = cliFlag(args, "--hub");
    const inviteToken = cliFlag(args, "--invite");
    if (!hubUrl || !inviteToken) throw new Error("请提供 --hub 主脑地址和 --invite 配对凭证。");
    const previous = dependencies.readConfig();
    if (previous && await dependencies.findRunning(previous, localPort(args))) {
      throw new Error("本机 Moco 客户端仍在运行，请先退出客户端，再加入主脑。");
    }
    const rootDir = cliFlag(args, "--root");
    config = await dependencies.stage({ hubUrl, inviteToken, ...(rootDir ? { rootDir } : {}) });
  } else {
    config = dependencies.readConfig();
  }
  if (!config) return false;

  const port = localPort(args);
  let running: { url: string } | null;
  let owned: JoinedDeviceProcess | null = null;
  for (;;) {
    running = await dependencies.findRunning(config, port);
    if (running) break;
    try { owned = await dependencies.start(config, port); break; }
    catch (error) { if (!(error instanceof DevicePeerInUseError)) throw error; }
  }
  const url = (running ?? owned)!.url;
  let unregister = () => {};
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      unregister();
      await owned?.close();
    })();
    return closing;
  };
  if (owned) unregister = dependencies.registerShutdown(close);

  if (command === "join") {
    try {
      if (running) await dependencies.confirmRunning(config);
      if (owned?.ready) await waitForPeerReady(owned);
      dependencies.activate(config);
    } catch (error) {
      await close();
      throw new Error(`设备接入未完成，可使用原命令重试：${safeDiagnostic(error, config)}`);
    }
  }

  dependencies.log(`Moco 设备客户端：${config.name}`);
  dependencies.log(`Web 控制台：${url}`);
  dependencies.log(`主脑：${config.hubUrl}`);
  if (owned?.ready) {
    void owned.ready.catch((error: unknown) => {
      dependencies.log(`主脑连接尚未就绪：${safeDiagnostic(error, config)}`);
    });
  }

  if ((command === "open" || command === "join") && !args.includes("--no-open")) {
    try {
      await dependencies.openBrowser(url);
    } catch (error) {
      dependencies.log(`无法自动打开浏览器，请访问上面的 Web 控制台：${safeDiagnostic(error, config)}`);
    }
  }

  if (command !== "open" && isTTY && !args.includes("--no-tui")) {
    const ws = new URL("/ws/client", url);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    try {
      await dependencies.runTui({ wsUrl: ws.toString(), onExit: close });
    } catch (error) {
      await close();
      throw new Error(`无法连接已配对的主脑：${safeDiagnostic(error, config)}`);
    }
  }
  return true;
}

export async function findRunningDevicePeer(
  config: DevicePeerConfig,
  port = config.localPort ?? 7788,
  localToken?: string,
): Promise<{ url: string; omitLocalToken?: boolean } | null> {
  const verifiedPeer = async () => {
    const existing = await discoverDevicePeer(config, localToken);
    if (existing) return { url: existing.url.origin, ...(localToken && !existing.url.searchParams.has("token") ? { omitLocalToken: true } : {}) };
  };
  const existing = await verifiedPeer();
  if (existing) return existing;
  if (port === 0) return null;
  const url = `http://127.0.0.1:${port}`;
  let response: Response;
  try {
    response = await fetch(`${url}/_moco/peer-status`, { signal: AbortSignal.timeout(1_000), redirect: "error" });
  } catch (error) {
    const cause = error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause : undefined;
    if (cause?.code === "ECONNREFUSED" || (error instanceof Error && error.name === "TimeoutError")) return null;
    throw new Error("无法检查本机 Moco 客户端，请检查本机代理端口。");
  }
  if (!response.ok) return null;
  let status: { deviceId?: unknown; hubUrl?: unknown };
  try {
    status = await response.json() as typeof status;
  } catch {
    return null;
  }
  if (status?.deviceId !== config.deviceId || status.hubUrl !== config.hubUrl) return null;
  const started = await verifiedPeer();
  if (started) return started;
  // Older clients do not prove ownership of their port. Avoid opening or registering a second Env against them.
  throw new Error("无法验证此旧版设备客户端的身份，请退出旧客户端后重新打开 Moco。");
}

/** A saved client credential belongs only to the saved Hub and is never reused for an explicit URL. */
export function resolveChatConnection(
  args: readonly string[],
  environment: { MOCO_AUTH_TOKEN?: string },
  readConfig: () => DevicePeerConfig | null,
): Pick<TuiChatOptions, "wsUrl" | "authToken"> {
  const explicitUrl = cliFlag(args, "--url");
  const explicitToken = cliFlag(args, "--token");
  if (explicitUrl) {
    return { wsUrl: explicitUrl, authToken: explicitToken ?? environment.MOCO_AUTH_TOKEN };
  }
  const config = readConfig();
  if (config) {
    const url = new URL("/ws/client", config.hubUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { wsUrl: url.toString(), authToken: explicitToken ?? config.clientToken };
  }
  return { wsUrl: "ws://127.0.0.1:7788/ws/client", authToken: explicitToken ?? environment.MOCO_AUTH_TOKEN };
}
