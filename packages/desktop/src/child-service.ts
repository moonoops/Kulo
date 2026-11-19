import { fork, type ChildProcess } from "node:child_process";

export interface NodeService<T> {
  child: ChildProcess;
  ready: Promise<T>;
  close(): Promise<void>;
}

export function startNodeService<T>(options: {
  nodePath: string;
  entry: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  validateReady(message: unknown): T | undefined;
  onExit?(code: number | null, signal: NodeJS.Signals | null): void;
  onOutput?(text: string): void;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}): NodeService<T> {
  const child = fork(options.entry, [], {
    execPath: options.nodePath,
    execArgv: [],
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let closing: Promise<void> | undefined;
  let settled = false;
  let readySucceeded = false;
  let rejectReady!: (error: Error) => void;
  let startupTimer: NodeJS.Timeout;
  const ready = new Promise<T>((resolve, reject) => {
    rejectReady = reject;
    startupTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Moco 后台服务启动超时。"));
      child.kill("SIGTERM");
    }, options.startupTimeoutMs ?? 90_000);
    const finish = () => { settled = true; clearTimeout(startupTimer); };
    child.on("message", (message: unknown) => {
      if (settled) return;
      if (message && typeof message === "object" && (message as { type?: unknown }).type === "error") {
        finish();
        const detail = (message as { message?: unknown }).message;
        reject(new Error(typeof detail === "string" ? detail : "Moco 后台服务启动失败。"));
        return;
      }
      try {
        const value = options.validateReady(message);
        if (value !== undefined) { readySucceeded = true; finish(); resolve(value); }
      } catch {
        finish(); reject(new Error("Moco 后台服务返回了无效的启动消息。"));
        child.kill("SIGTERM");
      }
    });
    child.once("error", () => {
      if (!settled) { finish(); reject(new Error("无法启动 Moco 后台进程。")); }
    });
    child.once("exit", () => {
      if (!settled) { finish(); reject(new Error("Moco 后台服务在启动完成前退出。")); }
    });
  });
  child.stdout?.on("data", (chunk: Buffer) => options.onOutput?.(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => options.onOutput?.(chunk.toString()));
  child.on("exit", (code, signal) => { if (!closing && settled) options.onExit?.(code, signal); });

  const waitForExit = (timeoutMs: number): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timeout); child.off("exit", done); resolve(true); };
      const timeout = setTimeout(() => { child.off("exit", done); resolve(false); }, timeoutMs);
      child.once("exit", done);
    });
  };

  return {
    child,
    ready,
    close: () => closing ??= (async () => {
      clearTimeout(startupTimer);
      if (!settled) { settled = true; rejectReady(new Error("Moco 后台服务启动已取消。")); }
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (child.connected) child.send({ type: "shutdown" }, () => {});
      else child.kill("SIGTERM");
      if (await waitForExit(options.shutdownTimeoutMs ?? 15_000)) return;
      child.kill("SIGTERM");
      if (!await waitForExit(3_000)) {
        child.kill("SIGKILL");
        if (!await waitForExit(3_000)) throw new Error("Moco 后台进程未能退出。");
      }
      if (readySucceeded) throw new Error("Moco 后台未能安全关闭，本次切换已暂停。");
    })(),
  };
}
