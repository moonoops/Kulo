import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { HindsightModelProvider } from "@moco/protocol";
import { HINDSIGHT_RETAIN_MISSIONS } from "./prompts.js";

export const MANAGED_HINDSIGHT_VERSION = "1.2.1";
const OWNER = "moco-managed-hindsight-v1";
const PROVIDERS = new Set(["openai", "anthropic", "gemini", "groq", "ollama"]);
const MODEL_DEFAULT_URL: Record<HindsightModelProvider, string> = { openai: "https://api.openai.com", anthropic: "https://api.anthropic.com", gemini: "https://generativelanguage.googleapis.com", groq: "https://api.groq.com", ollama: "http://localhost:11434" };

/** Intentional diagnostics with fixed, secret-free wording suitable for the setup UI. */
export class HindsightServiceError extends Error {
  constructor(message: string) { super(message); this.name = "HindsightServiceError"; }
}
class MissingManagedMetadataError extends HindsightServiceError {}

export interface LocalHindsightModel {
  provider: HindsightModelProvider;
  model: string;
  baseUrl?: string;
  connectionId?: string;
}
export interface LocalHindsightStatus {
  installed: boolean;
  running: boolean;
  platform: string;
  deviceName: string;
  endpoint: string;
  version: string;
  model?: LocalHindsightModel;
  dataDirectory: string;
  phase: "absent" | "installing" | "stopped" | "verifying" | "ready" | "failed";
  error?: string;
}
/** Contains runtime credentials. Never forward this result to model or browser. */
export interface LocalHindsightConnection extends LocalHindsightStatus {
  routerApiKey: string;
  workerApiKey: string;
  banks: { private: string; shared: string };
}
export interface HindsightServiceCommand {
  commandId: string;
  model: LocalHindsightModel;
  apiKey?: string;
  onProgress?: (phase: string) => void | Promise<void>;
}
export interface HindsightProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
export type HindsightProcessRunner = (command: string, args: string[], options: HindsightProcessOptions) => Promise<{ code: number; stdout?: string; stderr?: string }>;
interface Manifest {
  owner: typeof OWNER;
  version: string;
  root: string;
  label: string;
  port: number;
  model: LocalHindsightModel;
  phase: LocalHindsightStatus["phase"];
  commandId: string;
  configuredAt?: number;
  verificationId?: string;
  serviceSetupStarted?: boolean;
}
interface RuntimeFile {
  owner: typeof OWNER;
  env: Record<string, string>;
}
export interface HindsightLocalServiceOptions {
  stateDir: string;
  integrationDir?: string;
  platform?: string;
  homeDir?: string;
  deviceName?: string;
  run?: HindsightProcessRunner;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readinessTimeoutMs?: number;
  verificationTimeoutMs?: number;
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const systemd = (value: string) => `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const modelOrigin = (model: LocalHindsightModel) => new URL(model.baseUrl || MODEL_DEFAULT_URL[model.provider]).origin;
function modelConfig(raw: LocalHindsightModel): LocalHindsightModel {
  if (!raw || !PROVIDERS.has(raw.provider) || typeof raw.model !== "string" || !raw.model.trim() || raw.model.length > 200 || /[\x00-\x1f]/.test(raw.model)) throw new HindsightServiceError("请选择受支持的 Hindsight 模型供应商和模型。");
  let baseUrl: string | undefined;
  if (raw.baseUrl?.trim()) {
    let url: URL;
    try { url = new URL(raw.baseUrl.trim()); } catch { throw new HindsightServiceError("模型服务地址无效。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HindsightServiceError("模型地址必须是不含凭据、查询参数的 HTTP(S) 地址。");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new HindsightServiceError("远端模型连接必须使用 HTTPS。");
    baseUrl = url.toString().replace(/\/+$/, "");
  }
  return { provider: raw.provider, model: raw.model.trim(), ...(baseUrl ? { baseUrl } : {}), ...(raw.connectionId ? { connectionId: raw.connectionId } : {}) };
}

async function runProcess(command: string, args: string[], options: HindsightProcessOptions): ReturnType<HindsightProcessRunner> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" });
    let stdout = "", stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
    };
    const timer = setTimeout(() => { kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 5000); }, options.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-16_384); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-16_384); });
    child.once("error", () => { clearTimeout(timer); clearTimeout(killTimer); reject(new HindsightServiceError("无法启动 Hindsight 安装或服务管理工具。")); });
    child.once("close", (code) => { clearTimeout(timer); clearTimeout(killTimer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/** A resource executor, not another memory queue. Durable callers can replay a command. */
export class HindsightLocalService {
  readonly root: string;
  readonly #options: HindsightLocalServiceOptions;
  readonly #platform: string;
  readonly #home: string;
  readonly #run: HindsightProcessRunner;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  #serial: Promise<unknown> = Promise.resolve();
  #removalEpoch = 0;
  #removing = false;
  #removalStatus?: LocalHindsightStatus;

  constructor(options: HindsightLocalServiceOptions) {
    this.#options = options;
    this.root = path.join(path.resolve(options.stateDir), "managed-hindsight");
    this.#platform = options.platform ?? process.platform;
    this.#home = options.homeDir ?? os.homedir();
    this.#run = options.run ?? runProcess;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(run);
    this.#serial = next.catch(() => {});
    return next;
  }
  get #manifestPath() { return path.join(this.root, "manifest.json"); }
  get #runtimePath() { return path.join(this.root, "runtime.json"); }
  get #python() { return path.join(this.root, "venv", "bin", "python"); }
  #endpoint(manifest?: Manifest) { return `http://127.0.0.1:${manifest?.port ?? 8888}`; }

  async #regular(file: string): Promise<boolean> {
    try {
      const info = await fs.lstat(file);
      if (info.isSymbolicLink()) throw new HindsightServiceError("Hindsight 托管路径不能是符号链接。");
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async #manifest(): Promise<Manifest | undefined> {
    if (!await this.#regular(this.root)) return undefined;
    if (!await this.#regular(this.#manifestPath)) {
      if ((await fs.readdir(this.root)).length) throw new MissingManagedMetadataError("该目录不是可识别的 Moco Hindsight 安装，未作修改。");
      return undefined;
    }
    const value = JSON.parse(await fs.readFile(this.#manifestPath, "utf8")) as Manifest;
    if (value.owner !== OWNER || value.root !== this.root || value.label !== this.#label() || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || value.version !== MANAGED_HINDSIGHT_VERSION) throw new HindsightServiceError("Hindsight 安装清单不匹配，未作修改。");
    return value;
  }
  #label() { return `io.moco.hindsight.${createHash("sha256").update(this.root).digest("hex").slice(0, 12)}`; }
  async #write(file: string, value: string) {
    await this.#regular(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  }
  async #saveManifest(value: Manifest) { await this.#write(this.#manifestPath, JSON.stringify(value, null, 2)); }
  async #runtime(): Promise<RuntimeFile> {
    await this.#manifest();
    if (!await this.#regular(this.#runtimePath)) throw new MissingManagedMetadataError("Hindsight 服务配置不存在。");
    let value: RuntimeFile;
    try { value = JSON.parse(await fs.readFile(this.#runtimePath, "utf8")) as RuntimeFile; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingManagedMetadataError("Hindsight 服务配置不存在。");
      throw new HindsightServiceError("Hindsight 服务配置无法读取。");
    }
    if (value.owner !== OWNER || !value.env || Object.values(value.env).some((v) => typeof v !== "string")) throw new HindsightServiceError("Hindsight 服务配置无效。");
    return value;
  }
  #environment(build = false): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", HOME: path.join(this.root, "home"), UV_CACHE_DIR: path.join(this.root, "cache", "uv"), UV_PYTHON_INSTALL_DIR: path.join(this.root, "python"), LANG: "en_US.UTF-8" };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "TMPDIR"]) if (process.env[key]) result[key] = process.env[key];
    if (build) {
      const hostHome = process.env.HOME || os.homedir();
      result.RUSTUP_HOME = process.env.RUSTUP_HOME || path.join(hostHome, ".rustup");
      result.CARGO_HOME = process.env.CARGO_HOME || path.join(hostHome, ".cargo");
    }
    return result;
  }
  async #command(command: string, args: string[], timeoutMs = 60_000, allowed = [0]) {
    let value: Awaited<ReturnType<HindsightProcessRunner>>;
    try { value = await this.#run(command, args, { cwd: this.root, env: this.#environment(["uv", "rustc", "cargo"].includes(path.basename(command))), timeoutMs }); }
    catch { throw new HindsightServiceError(`无法运行 ${path.basename(command)}，请检查本机安装环境。`); }
    // Third-party installers may include URLs/headers in their output. It never becomes an error payload.
    if (!allowed.includes(value.code)) throw new HindsightServiceError(`Hindsight ${path.basename(command)} 操作未完成（退出码 ${value.code}）。`);
    return value;
  }
  #unitPath(manifest: Manifest) {
    return this.#platform === "darwin" ? path.join(this.#home, "Library", "LaunchAgents", `${manifest.label}.plist`) : path.join(this.#home, ".config", "systemd", "user", `${manifest.label}.service`);
  }
  async #unitOwned(manifest: Manifest): Promise<boolean> {
    const file = this.#unitPath(manifest);
    if (!await this.#regular(file)) return false;
    const content = await fs.readFile(file, "utf8");
    if (!content.includes(OWNER) || !content.includes(this.#platform === "darwin" ? xml(this.root) : this.root.replace(/%/g, "%%"))) throw new HindsightServiceError("系统服务不属于当前 Moco 安装，未作修改。");
    return true;
  }
  async #installUnit(manifest: Manifest) {
    await this.#unitOwned(manifest);
    const file = this.#unitPath(manifest);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await this.#regular(path.dirname(file));
    const args = [this.#python, "-m", "moco_hindsight.managed", "--config", this.#runtimePath];
    if (this.#platform === "darwin") {
      const env = { ...this.#environment(), MOCO_MANAGED_SERVICE: OWNER };
      await this.#write(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${manifest.label}</string><key>Comment</key><string>${OWNER}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(this.root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xml(path.join(this.root, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(this.root, "service.log"))}</string></dict></plist>\n`);
    } else {
      const environment = Object.entries(this.#environment()).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => `Environment=${systemd(`${key}=${value}`)}`).join("\n");
      await this.#write(file, `[Unit]\nDescription=Moco Hindsight (${OWNER})\n[Service]\nType=simple\nWorkingDirectory=${systemd(this.root)}\nExecStart=${args.map(systemd).join(" ")}\n${environment}\nRestart=on-failure\nRestartSec=15\nUMask=0077\n[Install]\nWantedBy=default.target\n`);
    }
  }
  async #start(manifest: Manifest) {
    if (this.#platform === "darwin") {
      const domain = `gui/${process.getuid?.() ?? 0}`;
      await this.#stop(manifest);
      await this.#command("launchctl", ["bootstrap", domain, this.#unitPath(manifest)]);
    } else {
      await this.#command("systemctl", ["--user", "daemon-reload"]);
      await this.#command("systemctl", ["--user", "enable", "--now", `${manifest.label}.service`]);
      await this.#command("systemctl", ["--user", "restart", `${manifest.label}.service`]);
    }
  }
  async #stop(manifest: Manifest) {
    const unitPresent = await this.#unitOwned(manifest);
    if (!unitPresent && manifest.serviceSetupStarted === false) return;
    if (this.#platform === "darwin") {
      const target = `gui/${process.getuid?.() ?? 0}/${manifest.label}`;
      await this.#command("launchctl", ["bootout", target], 30_000, [0, 3, 5, 113]);
      const now = this.#options.now ?? Date.now;
      const started = now();
      // bootout can return before launchd unregisters a live service; bootstrap then fails with EIO.
      while (now() - started < 30_000) {
        const status = await this.#command("launchctl", ["print", target], 5000, [0, 113]);
        if (status.code === 113) return;
        await this.#sleep(100);
      }
      throw new HindsightServiceError("Hindsight 系统服务尚未停止，请稍后重试原操作。");
    }
    else if (unitPresent) await this.#command("systemctl", ["--user", "disable", "--now", `${manifest.label}.service`]);
    else await this.#command("systemctl", ["--user", "stop", `${manifest.label}.service`], 30_000, [0, 5]);
  }
  async #request(manifest: Manifest, token: string, suffix: string, method = "GET", body?: unknown, timeoutMs = 15_000): Promise<Response> {
    return this.#fetch(`${this.#endpoint(manifest)}${suffix}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  }
  async #json(manifest: Manifest, token: string, suffix: string, method = "GET", body?: unknown, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const response = await this.#request(manifest, token, suffix, method, body, timeoutMs);
    if (!response.ok) { await response.body?.cancel(); throw new HindsightServiceError(`Hindsight 验证失败（HTTP ${response.status}）。`); }
    return await response.json() as Record<string, unknown>;
  }
  async #ready(manifest: Manifest, runtime: RuntimeFile) {
    const start = (this.#options.now ?? Date.now)();
    const timeout = this.#options.readinessTimeoutMs ?? 600_000;
    while ((this.#options.now ?? Date.now)() - start < timeout) {
      try {
        const response = await this.#request(manifest, runtime.env.MOCO_HINDSIGHT_ROUTER_API_KEY!, "/v1/moco/access", "GET", undefined, 3000);
        if (response.ok) { const value = await response.json() as { policyVersion?: number }; if (value.policyVersion === 1) return; }
        else await response.body?.cancel();
      } catch { /* Model download and database initialization precede HTTP readiness. */ }
      await this.#sleep(1000);
    }
    throw new HindsightServiceError("Hindsight 未在时限内启动，请检查托管服务日志后重试。");
  }
  #status(manifest: Manifest | undefined, running = false): LocalHindsightStatus {
    return { installed: Boolean(manifest && manifest.phase !== "absent"), running, platform: this.#platform, deviceName: this.#options.deviceName ?? os.hostname(), endpoint: this.#endpoint(manifest), version: MANAGED_HINDSIGHT_VERSION, ...(manifest ? { model: manifest.model } : {}), dataDirectory: path.join(this.root, "home"), phase: manifest ? running && manifest.phase === "ready" ? "ready" : manifest.phase === "ready" ? "stopped" : manifest.phase : "absent" };
  }
  #removedDuring(epoch: number): LocalHindsightStatus | undefined {
    return this.#removalStatus && (this.#removing || epoch !== this.#removalEpoch) ? { ...this.#removalStatus } : undefined;
  }
  async inspect(): Promise<LocalHindsightStatus> {
    const epoch = this.#removalEpoch;
    const removing = this.#removedDuring(epoch);
    if (removing) return removing;
    try {
      const manifest = await this.#manifest();
      const removed = this.#removedDuring(epoch);
      if (removed) return removed;
      let running = false;
      if (manifest && manifest.phase !== "absent" && await this.#regular(this.#runtimePath)) {
        const runtime = await this.#runtime();
        try { const response = await this.#request(manifest, runtime.env.MOCO_HINDSIGHT_ROUTER_API_KEY!, "/v1/moco/access", "GET", undefined, 2000); running = response.ok && (await response.json() as { policyVersion?: number }).policyVersion === 1; if (!response.ok) await response.body?.cancel(); }
        catch { running = false; }
      }
      return this.#removedDuring(epoch) ?? this.#status(manifest, running);
    } catch (error) {
      const removed = this.#removedDuring(epoch);
      if (removed && (error instanceof MissingManagedMetadataError || (error as NodeJS.ErrnoException).code === "ENOENT")) return removed;
      throw error;
    }
  }
  async #removeRoot(manifest: Manifest): Promise<void> {
    await this.#regular(this.root);
    this.#removalEpoch++;
    this.#removing = true;
    this.#removalStatus = this.#status({ ...manifest, phase: manifest.phase === "absent" ? "absent" : "stopped" });
    try {
      // Recursive removal can delete the ownership manifest before its remaining files.
      await fs.rm(this.root, { recursive: true });
      this.#removalStatus = this.#status(undefined);
    } catch (error) {
      this.#removalStatus = { ...this.#removalStatus, phase: "failed", error: "Hindsight 托管目录未能完整删除。" };
      throw error;
    } finally {
      this.#removing = false;
    }
  }
  async #port(): Promise<number> {
    return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = (server.address() as net.AddressInfo).port; server.close((error) => error ? reject(error) : resolve(port)); }); });
  }
  #checkCommand(commandId: string) { if (typeof commandId !== "string" || !commandId.trim() || commandId.length > 200) throw new HindsightServiceError("部署操作标识无效。"); }
  #checkPlatform() { if (!["darwin", "linux"].includes(this.#platform)) throw new HindsightServiceError("本机托管部署目前支持 macOS 和 Linux 用户级服务。"); }
  #modelEnv(model: LocalHindsightModel, apiKey?: string): Record<string, string> {
    if (model.provider !== "ollama" && !apiKey?.trim()) throw new HindsightServiceError("请先通过保密输入配置 Hindsight 模型 API Key。");
    if (apiKey && (apiKey.length > 16_384 || /[\x00-\x20\x7f]/.test(apiKey))) throw new HindsightServiceError("模型 API Key 格式无效。");
    return { HINDSIGHT_API_LLM_PROVIDER: model.provider, HINDSIGHT_API_LLM_MODEL: model.model, HINDSIGHT_API_LLM_API_KEY: apiKey ?? "", HINDSIGHT_API_LLM_BASE_URL: model.baseUrl ?? "", HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS: "16000", HINDSIGHT_API_LLM_MAX_CONCURRENT: "2" };
  }
  deploy(command: HindsightServiceCommand): Promise<LocalHindsightConnection> {
    return this.#exclusive(async () => {
      this.#checkCommand(command.commandId); this.#checkPlatform();
      const model = modelConfig(command.model);
      const modelEnv = this.#modelEnv(model, command.apiKey);
      let manifest = await this.#manifest();
      if (manifest?.phase === "ready") {
        if (manifest.commandId !== command.commandId) throw new HindsightServiceError("本机已由 Moco 部署 Hindsight，请使用配置服务。");
        return this.#connection(manifest, await this.#runtime());
      }
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.#regular(this.root);
      await fs.chmod(this.root, 0o700);
      if (!manifest) {
        manifest = { owner: OWNER, version: MANAGED_HINDSIGHT_VERSION, root: this.root, label: this.#label(), port: await this.#port(), model, phase: "installing", commandId: command.commandId, serviceSetupStarted: false };
        await this.#saveManifest(manifest);
      } else if (manifest.phase === "absent") {
        manifest = { ...manifest, model, phase: "installing", commandId: command.commandId, serviceSetupStarted: false };
        delete manifest.verificationId;
        await this.#saveManifest(manifest);
      } else if (manifest.phase === "failed" && manifest.commandId !== command.commandId) {
        await this.#stop(manifest);
        manifest = { ...manifest, model, phase: "installing", commandId: command.commandId };
        delete manifest.verificationId;
        await this.#saveManifest(manifest);
      } else if (manifest.commandId !== command.commandId) throw new HindsightServiceError("已有未完成的 Hindsight 安装，请重试原操作。");
      const directories = ["home", "cache", "cache/uv", "python"];
      for (const directory of directories) { const target = path.join(this.root, directory); await this.#regular(target); await fs.mkdir(target, { recursive: true, mode: 0o700 }); }
      const existingRuntime = await this.#regular(this.#runtimePath) ? await this.#runtime() : undefined;
      const env: Record<string, string> = { ...existingRuntime?.env,
        ...modelEnv, MOCO_HINDSIGHT_ROUTER_API_KEY: existingRuntime?.env.MOCO_HINDSIGHT_ROUTER_API_KEY ?? randomBytes(32).toString("hex"), MOCO_HINDSIGHT_WORKER_API_KEY: existingRuntime?.env.MOCO_HINDSIGHT_WORKER_API_KEY ?? randomBytes(32).toString("hex"), MOCO_HINDSIGHT_MANAGEMENT_API_KEY: existingRuntime?.env.MOCO_HINDSIGHT_MANAGEMENT_API_KEY ?? randomBytes(32).toString("hex"),
        MOCO_HINDSIGHT_PRIVATE_BANK: "moco-core", MOCO_HINDSIGHT_SHARED_BANK: "moco-shared", HINDSIGHT_API_DATABASE_URL: existingRuntime?.env.HINDSIGHT_API_DATABASE_URL ?? `pg0://moco:${randomBytes(32).toString("hex")}@${manifest.label.replace(/\./g, "-")}`,
        HINDSIGHT_API_HOST: "127.0.0.1", HINDSIGHT_API_PORT: String(manifest.port), HINDSIGHT_API_WORKER_ID: manifest.label, HINDSIGHT_API_MCP_ENABLED: "false", HINDSIGHT_API_LLM_TRACE_ENABLED: "false", HINDSIGHT_API_EMBEDDINGS_PROVIDER: "onnx", HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID: "intfloat/multilingual-e5-small", HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS: "384", HINDSIGHT_API_EMBEDDINGS_ONNX_THREADS: "2", HINDSIGHT_API_RERANKER_PROVIDER: "onnx", HINDSIGHT_API_RERANKER_ONNX_MODEL_ID: "hindsight-ai/hs-rerank-1", HINDSIGHT_API_RERANKER_ONNX_THREADS: "2", HINDSIGHT_API_LOG_LEVEL: "WARNING", HINDSIGHT_API_WORKER_MAX_SLOTS: "2", HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS: "1" };
      await this.#write(this.#runtimePath, JSON.stringify({ owner: OWNER, env } satisfies RuntimeFile));
      if (!await this.#regular(path.join(this.root, "service.log"))) await this.#write(path.join(this.root, "service.log"), "");
      try {
        await command.onProgress?.("检查安装环境");
        await this.#command("uv", ["--version"]);
        const integration = this.#options.integrationDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../integrations/hindsight");
        const source = path.join(this.root, "source");
        await this.#regular(source);
        await fs.mkdir(source, { recursive: true, mode: 0o700 });
        await fs.cp(path.join(integration, "src"), path.join(source, "src"), { recursive: true, dereference: false, filter: (file) => !file.includes("__pycache__") && !file.endsWith(".pyc") });
        await fs.copyFile(path.join(integration, "pyproject.toml"), path.join(source, "pyproject.toml"));
        await command.onProgress?.("安装 Hindsight 与本地检索模型");
        await this.#command("uv", ["venv", "--no-project", "--no-config", "--managed-python", "--allow-existing", "--python", "3.12", path.join(this.root, "venv")], 300_000);
        await this.#command("uv", ["pip", "install", "--no-config", "--python", this.#python, `hindsight-api-slim[local-onnx,embedded-db]==${MANAGED_HINDSIGHT_VERSION}`, source], 1_800_000);
        // Persist before registration so an interrupted setup cannot look unstarted.
        manifest.serviceSetupStarted = true;
        await this.#saveManifest(manifest);
        await this.#installUnit(manifest);
        manifest.phase = "verifying"; await this.#saveManifest(manifest);
        await command.onProgress?.("启动并验证长期记忆");
        await this.#start(manifest);
        return await this.#verify(manifest);
      } catch (error) {
        manifest.phase = "failed"; await this.#saveManifest(manifest);
        throw error;
      }
    });
  }
  configure(command: HindsightServiceCommand): Promise<LocalHindsightConnection> {
    return this.#exclusive(async () => {
      this.#checkCommand(command.commandId); this.#checkPlatform();
      let manifest = await this.#manifest();
      if (!manifest) throw new HindsightServiceError("本机尚未由 Moco 部署 Hindsight。");
      if (manifest.phase === "absent") throw new HindsightServiceError("本机 Hindsight 已卸载，请先重新部署。");
      const backupPath = path.join(this.root, "configuration-backup.json");
      if (manifest.commandId === command.commandId && manifest.phase === "ready") {
        if (await this.#regular(backupPath)) await fs.unlink(backupPath);
        return this.#connection(manifest, await this.#runtime());
      }
      if (await this.#regular(backupPath)) {
        let backup: { owner: string; commandId: string; manifest: Manifest; runtime: RuntimeFile };
        try { backup = JSON.parse(await fs.readFile(backupPath, "utf8")); } catch { throw new HindsightServiceError("模型配置恢复记录无效。"); }
        if (backup.owner !== OWNER || backup.commandId !== command.commandId || backup.manifest.root !== this.root || backup.runtime.owner !== OWNER) throw new HindsightServiceError("请先恢复上一次模型配置操作。");
        await this.#write(this.#runtimePath, JSON.stringify(backup.runtime));
        await this.#saveManifest(backup.manifest);
        manifest = backup.manifest;
        await this.#start(manifest); await this.#ready(manifest, backup.runtime);
        await fs.unlink(backupPath);
      }
      const before = await this.#runtime();
      const model = modelConfig(command.model);
      const beforeModel = manifest.model;
      const sameOrigin = modelOrigin(beforeModel) === modelOrigin(model) && beforeModel.provider === model.provider;
      const apiKey = command.apiKey ?? (sameOrigin ? before.env.HINDSIGHT_API_LLM_API_KEY : undefined);
      const after: RuntimeFile = { owner: OWNER, env: { ...before.env, ...this.#modelEnv(model, apiKey) } };
      await command.onProgress?.("更新记忆模型配置");
      await this.#write(backupPath, JSON.stringify({ owner: OWNER, commandId: command.commandId, manifest, runtime: before }));
      await this.#write(this.#runtimePath, JSON.stringify(after));
      try {
        await this.#start(manifest);
        const candidate = { ...manifest, model, commandId: command.commandId, phase: "verifying" as const };
        const connection = await this.#verify(candidate);
        await fs.unlink(backupPath);
        return connection;
      } catch (error) {
        await this.#write(this.#runtimePath, JSON.stringify(before));
        try { await this.#start(manifest); await this.#ready(manifest, before); await this.#saveManifest(manifest); await fs.unlink(backupPath); }
        catch { manifest.phase = "failed"; await this.#saveManifest(manifest); throw new HindsightServiceError("新模型验证失败，旧配置已恢复，但服务恢复失败，请重试检查。"); }
        throw error;
      }
    });
  }
  async #verify(manifest: Manifest): Promise<LocalHindsightConnection> {
    const runtime = await this.#runtime();
    const router = runtime.env.MOCO_HINDSIGHT_ROUTER_API_KEY!, worker = runtime.env.MOCO_HINDSIGHT_WORKER_API_KEY!, manager = runtime.env.MOCO_HINDSIGHT_MANAGEMENT_API_KEY!;
    await this.#ready(manifest, runtime);
    for (const [token, bank, method] of [[worker, "moco-core", "GET"], [router, "moco-shared", "POST"]] as const) {
      const response = await this.#request(manifest, token, `/v1/default/banks/${bank}/${method === "GET" ? "documents?limit=1" : "memories"}`, method, method === "POST" ? {} : undefined);
      await response.body?.cancel();
      if (response.status !== 403) throw new HindsightServiceError("Hindsight 未通过主脑与 Worker 权限隔离验证。");
    }
    for (const bank of ["moco-core", "moco-shared"]) {
      await this.#json(manifest, manager, `/v1/default/banks/${bank}/config`, "PATCH", { updates: { retain_extraction_mode: "concise", store_document_text: true, enable_observations: true, enable_auto_consolidation: true, retain_mission: bank === "moco-core" ? HINDSIGHT_RETAIN_MISSIONS.private : HINDSIGHT_RETAIN_MISSIONS.shared, retain_strategies: { document: { retain_extraction_mode: "concise" }, conversation: { retain_extraction_mode: "concise" }, worklog: { retain_extraction_mode: "concise" } } } });
    }
    manifest.verificationId ??= randomUUID();
    await this.#saveManifest(manifest);
    const documentId = `moco-install-check-${manifest.verificationId}`;
    const operationId = manifest.verificationId;
    const marker = `Moco deployment verification ${documentId}`;
    const bankPrefix = "/v1/default/banks/moco-shared";
    let submittedOperation: string | undefined;
    let completed = false;
    let terminal = false;
    try {
      submittedOperation = operationId;
      const accepted = await this.#json(manifest, worker, `${bankPrefix}/memories`, "POST", { async: true, operation_id: operationId, items: [{ content: `Moco 安装验证项目的名称为「${marker}」，该项目由 Moco 负责验证，验证语言是简体中文。`, document_id: documentId, tags: ["application:moco", "verification:installation"], observation_scopes: [["verification:installation"]] }] });
      const op = typeof accepted.operation_id === "string" ? accepted.operation_id : operationId;
      submittedOperation = op;
      const start = (this.#options.now ?? Date.now)();
      while ((this.#options.now ?? Date.now)() - start < (this.#options.verificationTimeoutMs ?? 240_000)) {
        const status = await this.#json(manifest, worker, `${bankPrefix}/operations/${encodeURIComponent(op)}`);
        if (status.status === "completed") { completed = true; terminal = true; break; }
        if (["failed", "cancelled", "not_found"].includes(String(status.status))) { terminal = true; throw new HindsightServiceError("Hindsight 模型未完成记忆提取，请检查模型兼容性和额度。"); }
        await this.#sleep(1000);
      }
      if (!completed) throw new HindsightServiceError("Hindsight 记忆提取验证超时。");
      const recalled = await this.#json(manifest, worker, `${bankPrefix}/memories/recall`, "POST", { query: marker, budget: "low", max_tokens: 500, tags: ["verification:installation"], tags_match: "all_strict" }, 30_000);
      if (!Array.isArray(recalled.results) || !JSON.stringify(recalled.results).includes(documentId)) throw new HindsightServiceError("Hindsight 已处理验证记录，但尚不能查询读回。");
      const reflected = await this.#json(manifest, worker, `${bankPrefix}/reflect`, "POST", { query: `查询安装验证标记：${marker}`, budget: "low", max_tokens: 300, tags: ["verification:installation"], tags_match: "all_strict" }, 120_000);
      if (typeof reflected.text !== "string" || !reflected.text.includes(documentId)) throw new HindsightServiceError("Hindsight 反思模型未返回带验证依据的结果。");
    } finally {
      if (submittedOperation && !terminal) {
        const cancelled = await this.#request(manifest, manager, `${bankPrefix}/operations/${encodeURIComponent(submittedOperation)}`, "DELETE");
        await cancelled.body?.cancel();
        if (!cancelled.ok && ![404, 409].includes(cancelled.status)) throw new HindsightServiceError("Hindsight 验证任务清理失败，请重试原操作。");
      }
      const deleted = await this.#request(manifest, manager, `${bankPrefix}/documents/${encodeURIComponent(documentId)}`, "DELETE");
      await deleted.body?.cancel();
      if (!deleted.ok && deleted.status !== 404) throw new HindsightServiceError("Hindsight 验证材料清理失败，请重试原操作。");
      delete manifest.verificationId;
      await this.#saveManifest(manifest);
    }
    manifest.phase = "ready"; manifest.configuredAt = (this.#options.now ?? Date.now)(); delete manifest.verificationId;
    await this.#saveManifest(manifest);
    return this.#connection(manifest, runtime);
  }
  async #connection(manifest: Manifest, runtime: RuntimeFile): Promise<LocalHindsightConnection> {
    const status = await this.inspect();
    if (!status.running) throw new HindsightServiceError("Hindsight 服务未运行，请重试检查。");
    return { ...status, model: manifest.model, routerApiKey: runtime.env.MOCO_HINDSIGHT_ROUTER_API_KEY!, workerApiKey: runtime.env.MOCO_HINDSIGHT_WORKER_API_KEY!, banks: { private: "moco-core", shared: "moco-shared" } };
  }
  verify(): Promise<LocalHindsightConnection> { return this.#exclusive(async () => { const manifest = await this.#manifest(); if (!manifest) throw new HindsightServiceError("没有可验证的本机 Hindsight 安装。"); return this.#verify(manifest); }); }
  uninstall(command: { commandId: string; deleteData?: boolean; onProgress?: (phase: string) => void | Promise<void> }): Promise<LocalHindsightStatus> {
    return this.#exclusive(async () => {
      this.#checkCommand(command.commandId);
      const manifest = await this.#manifest();
      if (!manifest) return this.inspect();
      if (manifest.phase === "absent") {
        if (command.deleteData) await this.#removeRoot(manifest);
        return this.inspect();
      }
      await command.onProgress?.("停止本机记忆服务");
      const earlyInstall = manifest.serviceSetupStarted === false && ["installing", "failed"].includes(manifest.phase) && !await this.#unitOwned(manifest);
      await this.#stop(manifest);
      if (!earlyInstall) {
        try { await fs.access(this.#python); await this.#command(this.#python, ["-m", "moco_hindsight.managed", "--config", this.#runtimePath, "--stop-database"]); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (await this.#unitOwned(manifest)) await fs.unlink(this.#unitPath(manifest));
      if (this.#platform === "linux") await this.#command("systemctl", ["--user", "daemon-reload"]);
      if (command.deleteData) {
        await this.#removeRoot(manifest);
      } else {
        // Retained databases stay recoverable, while model API keys are removed.
        const runtime = await this.#runtime();
        delete runtime.env.HINDSIGHT_API_LLM_API_KEY;
        delete runtime.env.MOCO_HINDSIGHT_ROUTER_API_KEY;
        delete runtime.env.MOCO_HINDSIGHT_WORKER_API_KEY;
        delete runtime.env.MOCO_HINDSIGHT_MANAGEMENT_API_KEY;
        await this.#write(this.#runtimePath, JSON.stringify(runtime));
        for (const directory of ["venv", "source", "python", "cache", "home/.cache", "configuration-backup.json"]) await fs.rm(path.join(this.root, directory), { recursive: true, force: true });
        manifest.phase = "absent"; manifest.commandId = command.commandId; await this.#saveManifest(manifest);
      }
      const status = await this.inspect();
      return { ...status, installed: false, running: false, phase: "absent" };
    });
  }
}
