import path from "node:path";
import fs from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactDiagnosticText } from "@kulo/recovery";

/** Executed by the trusted sandbox runner, independently of candidate test scripts. */
export async function probeCustomizationPayload(options: {
  payloadRoot: string; runtimeEntry: string; webDir: string; dataDir: string; timeoutMs?: number;
}): Promise<void> {
  const payloadRoot = fs.realpathSync(options.payloadRoot);
  const dataDir = fs.realpathSync(options.dataDir);
  const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); };
  if (!inside(payloadRoot, path.resolve(payloadRoot, options.runtimeEntry)) || !inside(payloadRoot, path.resolve(payloadRoot, options.webDir)) ||
      inside(payloadRoot, dataDir) || inside(dataDir, payloadRoot)) throw new Error("候选运行验证路径无效。");
  const child = fork(path.join(payloadRoot, options.runtimeEntry), [], {
    cwd: dataDir, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]
      .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
      KULO_DESKTOP_DATA_DIR: dataDir, KULO_DESKTOP_WEB_DIR: path.join(payloadRoot, options.webDir) },
  });
  child.stderr?.resume();
  let settled = false;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const ready = await new Promise<{ url: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => { settled = true; reject(new Error("候选运行验证启动超时。")); }, options.timeoutMs ?? 90_000);
    const finish = () => { settled = true; clearTimeout(timer); };
    child.once("error", () => { if (!settled) { finish(); reject(new Error("候选运行验证无法启动。")); } });
    child.once("exit", () => { if (!settled) { finish(); reject(new Error("候选后台在就绪前退出。")); } });
    child.on("message", (raw: unknown) => {
      if (settled || !raw || typeof raw !== "object") return;
      const message = raw as { type?: unknown; url?: unknown; token?: unknown; message?: unknown };
      if (message.type === "error") {
        const detail = typeof message.message === "string" ? redactDiagnosticText(message.message.slice(0, 16 * 1024)).slice(0, 2000) : "";
        finish(); reject(new Error("候选后台报告启动失败。" + (detail ? " " + detail : ""))); return;
      }
      if (message.type !== "ready" || typeof message.url !== "string" || typeof message.token !== "string" || !/^[a-f0-9]{64}$/.test(message.token)) return;
      let url: URL;
      try { url = new URL(message.url); } catch { return; }
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return;
      finish(); resolve({ url: url.origin, token: message.token });
    });
  }).catch(async (error) => {
    child.kill("SIGKILL"); await exited; throw error;
  });
  try {
    const request = async (target: string) => {
      const response = await fetch(new URL(target, ready.url), {
        headers: { Authorization: "Bearer " + ready.token }, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("候选必要接口验证失败。"); }
      return response;
    };
    const settings = await (await request("/api/settings")).json() as { blocks?: unknown };
    if (!settings || typeof settings !== "object" || !settings.blocks) throw new Error("候选配置接口格式无效。");
    const response = await request("/");
    if (!response.headers.get("content-type")?.includes("text/html")) throw new Error("候选页面类型无效。");
    const html = await response.text();
    if (html.length > 2 * 1024 * 1024 || !/<[^>]+\bid=["']root["']/.test(html)) throw new Error("候选页面缺少应用挂载入口。");
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]!);
    if (!scripts.length) throw new Error("候选页面缺少构建脚本。");
    for (const script of scripts.slice(0, 20)) {
      const asset = new URL(script, ready.url);
      if (asset.origin !== ready.url) throw new Error("候选脚本不属于本机应用。");
      const result = await request(asset.pathname + asset.search);
      if (!(await result.text()).trim()) throw new Error("候选脚本为空。");
    }
  } finally {
    if (child.connected) child.send({ type: "shutdown" }, () => {});
    else child.kill("SIGTERM");
    const shutdown = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { await exited; } finally { clearTimeout(shutdown); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , payloadRoot, runtimeEntry, webDir, dataDir] = process.argv;
  if (!payloadRoot || !runtimeEntry || !webDir || !dataDir) throw new Error("缺少候选验证参数。");
  await probeCustomizationPayload({ payloadRoot, runtimeEntry, webDir, dataDir });
}
