import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  HindsightEmbeddingsModel,
  HindsightEmbeddingsProvider,
  HindsightModelProvider,
  HindsightRerankerModel,
  HindsightRerankerProvider,
} from "@kulo/protocol";
import { buildAugmentedHostPath } from "./host-path.js";
import { MEMORY_LLM_BRIDGE_FILENAME } from "./memory-llm-bridge.js";
import { HINDSIGHT_RETAIN_MISSIONS } from "./prompts.js";

export const MANAGED_HINDSIGHT_VERSION = "1.2.1";
const OWNER = "kulo-managed-hindsight-v1";
const KULO_BRIDGE_PROVIDER = "kulo_hindsight.bridge:KuloBridgeLLM";
const PROVIDERS = new Set<HindsightModelProvider>(["kulo", "openai", "anthropic", "gemini", "groq", "ollama"]);
const EMBEDDINGS_PROVIDERS = new Set<HindsightEmbeddingsProvider>(["onnx", "openai", "google", "cohere", "tei"]);
const RERANKER_PROVIDERS = new Set<HindsightRerankerProvider>(["onnx", "rrf", "cohere", "siliconflow", "alibaba", "zeroentropy", "tei"]);
const MODEL_DEFAULT_URL: Record<Exclude<HindsightModelProvider, "kulo">, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  groq: "https://api.groq.com",
  ollama: "http://localhost:11434",
};
const EMBEDDINGS_DEFAULT_URL: Partial<Record<HindsightEmbeddingsProvider, string>> = {
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  cohere: "https://api.cohere.com",
};
const RERANKER_DEFAULT_URL: Partial<Record<HindsightRerankerProvider, string>> = {
  cohere: "https://api.cohere.com",
  siliconflow: "https://api.siliconflow.cn",
  alibaba: "https://dashscope.aliyuncs.com",
  zeroentropy: "https://api.zeroentropy.dev",
};
export const DEFAULT_LOCAL_EMBEDDINGS: HindsightEmbeddingsModel = {
  provider: "onnx",
  model: "intfloat/multilingual-e5-small",
  dimensions: 384,
};
export const DEFAULT_LOCAL_RERANKER: HindsightRerankerModel = {
  provider: "onnx",
  model: "hindsight-ai/hs-rerank-1",
};
/** Map bare PyTorch HF repos that lack onnx/model.onnx to verified ONNX-exported repos. */
export const ONNX_EMBEDDINGS_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "BAAI/bge-small-zh-v1.5": "Xenova/bge-small-zh-v1.5",
};
export const ONNX_RERANKER_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "BAAI/bge-reranker-v2-m3": "onnx-community/bge-reranker-v2-m3-ONNX",
};
export function normalizeOnnxEmbeddingsModel(model: string): string {
  return ONNX_EMBEDDINGS_MODEL_ALIASES[model] ?? model;
}
export function normalizeOnnxRerankerModel(model: string): string {
  return ONNX_RERANKER_MODEL_ALIASES[model] ?? model;
}
const STARTUP_FAILED_MARKER = "Application startup failed. Exiting.";
/** Classify fatal Hindsight startup errors from new service.log bytes into secret-free diagnostics. */
export function diagnoseHindsightStartupFailure(logSlice: string): string | undefined {
  if (!logSlice) return undefined;
  const failures = logSlice.split(STARTUP_FAILED_MARKER).length - 1;
  if (failures <= 0) return undefined;
  if (/NO_SUCHFILE|NoSuchFile/i.test(logSlice) && /\.onnx\b/i.test(logSlice)) {
    return "所选本机 ONNX 模型仓库缺少 onnx/model.onnx 文件，请更换支持 ONNX 导出的模型后重试。";
  }
  if (/Configured ONNX embedding dimension/i.test(logSlice)) {
    return "向量模型维度与所选 ONNX 模型实际输出维度不一致，请留空自动检测或更正维度后重试。";
  }
  if (/ONNX reranker .* expected 1 or 2/i.test(logSlice)) {
    return "所选本机 ONNX 重排模型输出格式不受支持，请更换其他重排模型后重试。";
  }
  if (/RepositoryNotFoundError|EntryNotFoundError|GatedRepoError|LocalEntryNotFoundError/i.test(logSlice)) {
    return "无法下载所选本机 ONNX 模型（仓库不存在、需要授权或网络不可达），请检查模型名称与网络后重试。";
  }
  if (/Address already in use|Errno (?:48|98)\b/i.test(logSlice)) {
    return "Hindsight 本机服务监听端口已被占用，请重试部署。";
  }
  if (/ModuleNotFoundError|ImportError/i.test(logSlice)) {
    return "Hindsight 运行环境缺少依赖组件，请卸载（可保留数据）后重新部署。";
  }
  if (/Kulo memory bridge|KULO_HINDSIGHT_MODEL_PROVIDER_ID/i.test(logSlice)) {
    return "Hindsight 无法连接 Kulo 模型桥接服务，请检查所选理解模型后重试。";
  }
  if (failures >= 2) {
    return "Hindsight 启动失败并提前退出，请检查所选模型配置与托管服务日志后重试。";
  }
  return undefined;
}
const EMBEDDINGS_ENV_KEYS = [
  "HINDSIGHT_API_EMBEDDINGS_PROVIDER",
  "HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID",
  "HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS",
  "HINDSIGHT_API_EMBEDDINGS_ONNX_THREADS",
  "HINDSIGHT_API_EMBEDDINGS_ONNX_POOLING",
  "HINDSIGHT_API_EMBEDDINGS_ONNX_QUERY_PREFIX",
  "HINDSIGHT_API_EMBEDDINGS_ONNX_PASSAGE_PREFIX",
  "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY",
  "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL",
  "HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL",
  "HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS",
  "HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY",
  "HINDSIGHT_API_EMBEDDINGS_GEMINI_MODEL",
  "HINDSIGHT_API_EMBEDDINGS_GEMINI_OUTPUT_DIMENSIONALITY",
  "HINDSIGHT_API_EMBEDDINGS_COHERE_API_KEY",
  "HINDSIGHT_API_EMBEDDINGS_COHERE_MODEL",
  "HINDSIGHT_API_EMBEDDINGS_COHERE_BASE_URL",
  "HINDSIGHT_API_EMBEDDINGS_COHERE_OUTPUT_DIMENSIONS",
  "HINDSIGHT_API_EMBEDDINGS_TEI_URL",
] as const;
const RERANKER_ENV_KEYS = [
  "HINDSIGHT_API_RERANKER_PROVIDER",
  "HINDSIGHT_API_RERANKER_ONNX_MODEL_ID",
  "HINDSIGHT_API_RERANKER_ONNX_THREADS",
  "HINDSIGHT_API_RERANKER_COHERE_API_KEY",
  "HINDSIGHT_API_RERANKER_COHERE_MODEL",
  "HINDSIGHT_API_RERANKER_COHERE_BASE_URL",
  "HINDSIGHT_API_RERANKER_SILICONFLOW_API_KEY",
  "HINDSIGHT_API_RERANKER_SILICONFLOW_MODEL",
  "HINDSIGHT_API_RERANKER_SILICONFLOW_BASE_URL",
  "HINDSIGHT_API_RERANKER_ALIBABA_API_KEY",
  "HINDSIGHT_API_RERANKER_ALIBABA_MODEL",
  "HINDSIGHT_API_RERANKER_ZEROENTROPY_API_KEY",
  "HINDSIGHT_API_RERANKER_ZEROENTROPY_MODEL",
  "HINDSIGHT_API_RERANKER_ZEROENTROPY_BASE_URL",
  "HINDSIGHT_API_RERANKER_TEI_URL",
] as const;

/** Intentional diagnostics with fixed, secret-free wording suitable for the setup UI. */
export class HindsightServiceError extends Error {
  constructor(message: string) { super(message); this.name = "HindsightServiceError"; }
}
class MissingManagedMetadataError extends HindsightServiceError {}
class HindsightSpawnError extends HindsightServiceError {
  constructor(message: string, readonly code?: string) { super(message); this.name = "HindsightSpawnError"; }
}

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
  embeddings?: HindsightEmbeddingsModel;
  reranker?: HindsightRerankerModel;
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
  embeddings?: HindsightEmbeddingsModel;
  reranker?: HindsightRerankerModel;
  apiKey?: string;
  embeddingsApiKey?: string;
  rerankerApiKey?: string;
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
  embeddings?: HindsightEmbeddingsModel;
  reranker?: HindsightRerankerModel;
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
  bridgeFile?: string;
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
const modelOrigin = (model: LocalHindsightModel) => model.provider === "kulo" ? `kulo:${model.connectionId ?? ""}` : new URL(model.baseUrl || MODEL_DEFAULT_URL[model.provider]).origin;
const embeddingsOrigin = (model: HindsightEmbeddingsModel) => {
  if (model.provider === "onnx") return "onnx";
  if (model.provider === "tei") return new URL(model.baseUrl!).origin;
  return new URL(model.baseUrl || EMBEDDINGS_DEFAULT_URL[model.provider]!).origin;
};
const rerankerOrigin = (model: HindsightRerankerModel) => {
  if (model.provider === "onnx" || model.provider === "rrf") return model.provider;
  if (model.provider === "tei") return new URL(model.baseUrl!).origin;
  return new URL(model.baseUrl || RERANKER_DEFAULT_URL[model.provider]!).origin;
};
function cleanServiceUrl(raw: string, label: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new HindsightServiceError(`${label}无效。`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HindsightServiceError(`${label}必须是不含凭据、查询参数的 HTTP(S) 地址。`);
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new HindsightServiceError(`远端${label}必须使用 HTTPS。`);
  return url.toString().replace(/\/+$/, "");
}
function modelConfig(raw: LocalHindsightModel): LocalHindsightModel {
  if (!raw || !PROVIDERS.has(raw.provider) || typeof raw.model !== "string" || !raw.model.trim() || raw.model.length > 200 || /[\x00-\x1f]/.test(raw.model)) throw new HindsightServiceError("请选择受支持的 Hindsight 模型供应商和模型。");
  if (raw.provider === "kulo") {
    if (typeof raw.connectionId !== "string" || !raw.connectionId.trim() || raw.connectionId.length > 160 || /[\x00-\x1f]/.test(raw.connectionId)) throw new HindsightServiceError("请选择有效的 Kulo 模型连接。");
    return { provider: "kulo", model: raw.model.trim(), connectionId: raw.connectionId.trim() };
  }
  const baseUrl = raw.baseUrl?.trim() ? cleanServiceUrl(raw.baseUrl, "模型地址") : undefined;
  return { provider: raw.provider, model: raw.model.trim(), ...(baseUrl ? { baseUrl } : {}), ...(raw.connectionId ? { connectionId: raw.connectionId } : {}) };
}
function embeddingsConfig(raw?: HindsightEmbeddingsModel): HindsightEmbeddingsModel {
  if (!raw) return { ...DEFAULT_LOCAL_EMBEDDINGS };
  if (!EMBEDDINGS_PROVIDERS.has(raw.provider)) throw new HindsightServiceError("请选择受支持的向量模型（Embedding）供应商。");
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
  if (model && (model.length > 200 || /[\x00-\x1f]/.test(model))) throw new HindsightServiceError("向量模型名称无效。");
  const baseUrl = raw.baseUrl?.trim() ? cleanServiceUrl(raw.baseUrl, "向量服务地址") : undefined;
  if (raw.provider === "tei" && !baseUrl) throw new HindsightServiceError("TEI 向量服务必须填写服务地址。");
  const dimensions = raw.dimensions !== undefined ? Math.trunc(raw.dimensions) : undefined;
  if (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || dimensions < 32 || dimensions > 8192)) throw new HindsightServiceError("向量维度必须在 32 到 8192 之间。");
  const rawResolvedModel = model ?? (raw.provider === "onnx" ? DEFAULT_LOCAL_EMBEDDINGS.model : raw.provider === "openai" ? "text-embedding-3-small" : raw.provider === "google" ? "gemini-embedding-001" : raw.provider === "cohere" ? "embed-multilingual-v3.0" : undefined);
  const resolvedModel = raw.provider === "onnx" && rawResolvedModel ? normalizeOnnxEmbeddingsModel(rawResolvedModel) : rawResolvedModel;
  const resolvedDims = dimensions ?? (raw.provider === "onnx" && resolvedModel === DEFAULT_LOCAL_EMBEDDINGS.model ? DEFAULT_LOCAL_EMBEDDINGS.dimensions : undefined);
  return {
    provider: raw.provider,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(raw.connectionId ? { connectionId: raw.connectionId } : {}),
    ...(resolvedDims !== undefined ? { dimensions: resolvedDims } : {}),
  };
}
function rerankerConfig(raw?: HindsightRerankerModel): HindsightRerankerModel {
  if (!raw) return { ...DEFAULT_LOCAL_RERANKER };
  if (!RERANKER_PROVIDERS.has(raw.provider)) throw new HindsightServiceError("请选择受支持的重排模型（Rerank）供应商。");
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
  if (model && (model.length > 200 || /[\x00-\x1f]/.test(model))) throw new HindsightServiceError("重排模型名称无效。");
  const baseUrl = raw.baseUrl?.trim() ? cleanServiceUrl(raw.baseUrl, "重排服务地址") : undefined;
  if (raw.provider === "tei" && !baseUrl) throw new HindsightServiceError("TEI 重排服务必须填写服务地址。");
  const rawResolvedModel = model ?? (raw.provider === "onnx" ? DEFAULT_LOCAL_RERANKER.model : raw.provider === "cohere" ? "rerank-multilingual-v3.0" : raw.provider === "siliconflow" ? "BAAI/bge-reranker-v2-m3" : raw.provider === "alibaba" ? "qwen3-rerank" : raw.provider === "zeroentropy" ? "zerank-2" : undefined);
  const resolvedModel = raw.provider === "onnx" && rawResolvedModel ? normalizeOnnxRerankerModel(rawResolvedModel) : rawResolvedModel;
  return {
    provider: raw.provider,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(raw.connectionId ? { connectionId: raw.connectionId } : {}),
  };
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
    child.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); clearTimeout(killTimer); reject(new HindsightSpawnError("无法启动 Hindsight 安装或服务管理工具。", error.code)); });
    child.once("close", (code) => { clearTimeout(timer); clearTimeout(killTimer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/** A resource executor, not another memory queue. Durable callers can replay a command. */
export class HindsightLocalService {
  readonly root: string;
  readonly #options: HindsightLocalServiceOptions;
  readonly #bridgeFile: string;
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
    const resolvedState = path.resolve(options.stateDir);
    this.root = path.join(resolvedState, "managed-hindsight");
    this.#bridgeFile = options.bridgeFile ?? path.join(resolvedState, MEMORY_LLM_BRIDGE_FILENAME);
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
      if ((await fs.readdir(this.root)).length) throw new MissingManagedMetadataError("该目录不是可识别的 Kulo Hindsight 安装，未作修改。");
      return undefined;
    }
    const value = JSON.parse(await fs.readFile(this.#manifestPath, "utf8")) as Manifest;
    if (value.owner !== OWNER || value.root !== this.root || value.label !== this.#label() || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || value.version !== MANAGED_HINDSIGHT_VERSION) throw new HindsightServiceError("Hindsight 安装清单不匹配，未作修改。");
    return value;
  }
  #label() { return `io.kulo.hindsight.${createHash("sha256").update(this.root).digest("hex").slice(0, 12)}`; }
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
    const hostHome = this.#options.homeDir ?? (process.env.HOME || os.homedir());
    const cargoHome = build ? (process.env.CARGO_HOME || path.join(hostHome, ".cargo")) : undefined;
    const result: NodeJS.ProcessEnv = {
      PATH: buildAugmentedHostPath({
        basePath: process.env.PATH,
        homeDir: hostHome,
        platform: this.#platform as NodeJS.Platform,
        ...(cargoHome ? { extraDirs: [path.join(cargoHome, "bin")] } : {}),
      }),
      HOME: path.join(this.root, "home"),
      UV_CACHE_DIR: path.join(this.root, "cache", "uv"),
      UV_PYTHON_INSTALL_DIR: path.join(this.root, "python"),
      LANG: "en_US.UTF-8",
    };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "TMPDIR"]) if (process.env[key]) result[key] = process.env[key];
    if (build) {
      result.RUSTUP_HOME = process.env.RUSTUP_HOME || path.join(hostHome, ".rustup");
      result.CARGO_HOME = cargoHome;
    }
    return result;
  }
  async #command(command: string, args: string[], timeoutMs = 60_000, allowed = [0]) {
    const base = path.basename(command);
    let value: Awaited<ReturnType<HindsightProcessRunner>>;
    try { value = await this.#run(command, args, { cwd: this.root, env: this.#environment(["uv", "rustc", "cargo"].includes(base)), timeoutMs }); }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (base === "uv") {
        if (code === "ENOENT") {
          throw new HindsightServiceError("本机未检测到 uv（Python 环境管理工具），无法自动部署 Hindsight。请先在本机安装 uv（例如执行 brew install uv 或官方安装脚本）后重试。");
        }
        throw new HindsightServiceError("无法启动 uv（Python 环境管理工具），请检查本机 uv 安装及执行权限后重试。");
      }
      throw new HindsightServiceError(`无法运行 ${base}，请检查本机安装环境。`);
    }
    // Third-party installers may include URLs/headers in their output. It never becomes an error payload.
    if (!allowed.includes(value.code)) throw new HindsightServiceError(`Hindsight ${base} 操作未完成（退出码 ${value.code}）。`);
    return value;
  }
  #unitPath(manifest: Manifest) {
    return this.#platform === "darwin" ? path.join(this.#home, "Library", "LaunchAgents", `${manifest.label}.plist`) : path.join(this.#home, ".config", "systemd", "user", `${manifest.label}.service`);
  }
  async #unitOwned(manifest: Manifest): Promise<boolean> {
    const file = this.#unitPath(manifest);
    if (!await this.#regular(file)) return false;
    const content = await fs.readFile(file, "utf8");
    if (!content.includes(OWNER) || !content.includes(this.#platform === "darwin" ? xml(this.root) : this.root.replace(/%/g, "%%"))) throw new HindsightServiceError("系统服务不属于当前 Kulo 安装，未作修改。");
    return true;
  }
  async #installUnit(manifest: Manifest) {
    await this.#unitOwned(manifest);
    const file = this.#unitPath(manifest);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await this.#regular(path.dirname(file));
    const args = [this.#python, "-m", "kulo_hindsight.managed", "--config", this.#runtimePath];
    if (this.#platform === "darwin") {
      const env = { ...this.#environment(), KULO_MANAGED_SERVICE: OWNER };
      await this.#write(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${manifest.label}</string><key>Comment</key><string>${OWNER}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(this.root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xml(path.join(this.root, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(this.root, "service.log"))}</string></dict></plist>\n`);
    } else {
      const environment = Object.entries(this.#environment()).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => `Environment=${systemd(`${key}=${value}`)}`).join("\n");
      await this.#write(file, `[Unit]\nDescription=Kulo Hindsight (${OWNER})\n[Service]\nType=simple\nWorkingDirectory=${systemd(this.root)}\nExecStart=${args.map(systemd).join(" ")}\n${environment}\nRestart=on-failure\nRestartSec=15\nUMask=0077\n[Install]\nWantedBy=default.target\n`);
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
  async #serviceLogSize(): Promise<number> {
    try { return (await fs.stat(path.join(this.root, "service.log"))).size; }
    catch { return 0; }
  }
  async #readStartupLogSince(offset: number): Promise<string> {
    const file = path.join(this.root, "service.log");
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(file, "r");
      const info = await handle.stat();
      const start = info.size < offset ? 0 : offset;
      const length = Math.min(info.size - start, 65_536);
      if (length <= 0) return "";
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  async #ready(manifest: Manifest, runtime: RuntimeFile, logOffset?: number) {
    const start = (this.#options.now ?? Date.now)();
    const timeout = this.#options.readinessTimeoutMs ?? 600_000;
    while ((this.#options.now ?? Date.now)() - start < timeout) {
      try {
        const response = await this.#request(manifest, runtime.env.KULO_HINDSIGHT_ROUTER_API_KEY!, "/v1/kulo/access", "GET", undefined, 3000);
        if (response.ok) { const value = await response.json() as { policyVersion?: number }; if (value.policyVersion === 1) return; }
        else await response.body?.cancel();
      } catch { /* Model download and database initialization precede HTTP readiness. */ }
      if (logOffset !== undefined) {
        const diagnosis = diagnoseHindsightStartupFailure(await this.#readStartupLogSince(logOffset));
        if (diagnosis) throw new HindsightServiceError(diagnosis);
      }
      await this.#sleep(1000);
    }
    throw new HindsightServiceError("Hindsight 未在时限内启动，请检查托管服务日志后重试。");
  }
  #status(manifest: Manifest | undefined, running = false): LocalHindsightStatus {
    const phase: LocalHindsightStatus["phase"] = manifest
      ? running && manifest.phase === "ready"
        ? "ready"
        : manifest.phase === "ready"
          ? "stopped"
          : manifest.phase
      : "absent";
    return {
      installed: phase === "ready" || phase === "stopped",
      running,
      platform: this.#platform,
      deviceName: this.#options.deviceName ?? os.hostname(),
      endpoint: this.#endpoint(manifest),
      version: MANAGED_HINDSIGHT_VERSION,
      ...(manifest ? { model: manifest.model, embeddings: manifest.embeddings ?? { ...DEFAULT_LOCAL_EMBEDDINGS }, reranker: manifest.reranker ?? { ...DEFAULT_LOCAL_RERANKER } } : {}),
      dataDirectory: path.join(this.root, "home"),
      phase,
    };
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
        try { const response = await this.#request(manifest, runtime.env.KULO_HINDSIGHT_ROUTER_API_KEY!, "/v1/kulo/access", "GET", undefined, 2000); running = response.ok && (await response.json() as { policyVersion?: number }).policyVersion === 1; if (!response.ok) await response.body?.cancel(); }
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
  #checkApiKey(apiKey: string | undefined, label: string, required: boolean) {
    if (required && !apiKey?.trim()) throw new HindsightServiceError(`请先通过保密输入配置 ${label} API Key。`);
    if (apiKey && (apiKey.length > 16_384 || /[\x00-\x20\x7f]/.test(apiKey))) throw new HindsightServiceError(`${label} API Key 格式无效。`);
  }
  #applyModelEnv(target: Record<string, string>, model: LocalHindsightModel, apiKey?: string): void {
    if (model.provider === "kulo") {
      delete target.HINDSIGHT_API_LLM_API_KEY;
      target.HINDSIGHT_API_LLM_PROVIDER = KULO_BRIDGE_PROVIDER;
      target.HINDSIGHT_API_LLM_MODEL = model.model;
      target.HINDSIGHT_API_LLM_API_KEY = "";
      target.HINDSIGHT_API_LLM_BASE_URL = "";
      target.KULO_HINDSIGHT_MODEL_PROVIDER_ID = model.connectionId!;
      target.KULO_HINDSIGHT_BRIDGE_FILE = this.#bridgeFile;
      target.HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS = "16000";
      target.HINDSIGHT_API_LLM_MAX_CONCURRENT = "2";
      return;
    }
    this.#checkApiKey(apiKey, "Hindsight 模型", model.provider !== "ollama");
    delete target.KULO_HINDSIGHT_MODEL_PROVIDER_ID;
    delete target.KULO_HINDSIGHT_BRIDGE_FILE;
    target.HINDSIGHT_API_LLM_PROVIDER = model.provider;
    target.HINDSIGHT_API_LLM_MODEL = model.model;
    target.HINDSIGHT_API_LLM_API_KEY = apiKey ?? "";
    target.HINDSIGHT_API_LLM_BASE_URL = model.baseUrl ?? "";
    target.HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS = "16000";
    target.HINDSIGHT_API_LLM_MAX_CONCURRENT = "2";
  }
  #existingEmbeddingsApiKey(env: Record<string, string>, provider: HindsightEmbeddingsProvider): string | undefined {
    if (provider === "openai") return env.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY || undefined;
    if (provider === "google") return env.HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY || undefined;
    if (provider === "cohere") return env.HINDSIGHT_API_EMBEDDINGS_COHERE_API_KEY || undefined;
    return undefined;
  }
  #applyEmbeddingsEnv(target: Record<string, string>, embeddings: HindsightEmbeddingsModel, apiKey?: string): void {
    for (const key of EMBEDDINGS_ENV_KEYS) delete target[key];
    target.HINDSIGHT_API_EMBEDDINGS_PROVIDER = embeddings.provider;
    if (embeddings.provider === "onnx") {
      const modelId = normalizeOnnxEmbeddingsModel(embeddings.model || DEFAULT_LOCAL_EMBEDDINGS.model!);
      target.HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID = modelId;
      if (embeddings.dimensions !== undefined) target.HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS = String(embeddings.dimensions);
      target.HINDSIGHT_API_EMBEDDINGS_ONNX_THREADS = "2";
      if (/\/bge-/i.test(modelId)) {
        target.HINDSIGHT_API_EMBEDDINGS_ONNX_POOLING = "cls";
        target.HINDSIGHT_API_EMBEDDINGS_ONNX_QUERY_PREFIX = "";
        target.HINDSIGHT_API_EMBEDDINGS_ONNX_PASSAGE_PREFIX = "";
      }
      return;
    }
    if (embeddings.provider === "tei") {
      target.HINDSIGHT_API_EMBEDDINGS_TEI_URL = embeddings.baseUrl!;
      return;
    }
    this.#checkApiKey(apiKey, "向量模型（Embedding）", true);
    if (embeddings.provider === "openai") {
      target.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY = apiKey!.trim();
      target.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL = embeddings.model || "text-embedding-3-small";
      if (embeddings.baseUrl) target.HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL = embeddings.baseUrl;
      if (embeddings.dimensions !== undefined) target.HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS = String(embeddings.dimensions);
      return;
    }
    if (embeddings.provider === "google") {
      target.HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY = apiKey!.trim();
      target.HINDSIGHT_API_EMBEDDINGS_GEMINI_MODEL = embeddings.model || "gemini-embedding-001";
      if (embeddings.dimensions !== undefined) target.HINDSIGHT_API_EMBEDDINGS_GEMINI_OUTPUT_DIMENSIONALITY = String(embeddings.dimensions);
      return;
    }
    if (embeddings.provider === "cohere") {
      target.HINDSIGHT_API_EMBEDDINGS_COHERE_API_KEY = apiKey!.trim();
      target.HINDSIGHT_API_EMBEDDINGS_COHERE_MODEL = embeddings.model || "embed-multilingual-v3.0";
      if (embeddings.baseUrl) target.HINDSIGHT_API_EMBEDDINGS_COHERE_BASE_URL = embeddings.baseUrl;
      if (embeddings.dimensions !== undefined) target.HINDSIGHT_API_EMBEDDINGS_COHERE_OUTPUT_DIMENSIONS = String(embeddings.dimensions);
    }
  }
  #existingRerankerApiKey(env: Record<string, string>, provider: HindsightRerankerProvider): string | undefined {
    if (provider === "cohere") return env.HINDSIGHT_API_RERANKER_COHERE_API_KEY || undefined;
    if (provider === "siliconflow") return env.HINDSIGHT_API_RERANKER_SILICONFLOW_API_KEY || undefined;
    if (provider === "alibaba") return env.HINDSIGHT_API_RERANKER_ALIBABA_API_KEY || undefined;
    if (provider === "zeroentropy") return env.HINDSIGHT_API_RERANKER_ZEROENTROPY_API_KEY || undefined;
    return undefined;
  }
  #applyRerankerEnv(target: Record<string, string>, reranker: HindsightRerankerModel, apiKey?: string): void {
    for (const key of RERANKER_ENV_KEYS) delete target[key];
    target.HINDSIGHT_API_RERANKER_PROVIDER = reranker.provider;
    if (reranker.provider === "rrf") return;
    if (reranker.provider === "onnx") {
      target.HINDSIGHT_API_RERANKER_ONNX_MODEL_ID = normalizeOnnxRerankerModel(reranker.model || DEFAULT_LOCAL_RERANKER.model!);
      target.HINDSIGHT_API_RERANKER_ONNX_THREADS = "2";
      return;
    }
    if (reranker.provider === "tei") {
      target.HINDSIGHT_API_RERANKER_TEI_URL = reranker.baseUrl!;
      return;
    }
    this.#checkApiKey(apiKey, "重排模型（Rerank）", true);
    if (reranker.provider === "cohere") {
      target.HINDSIGHT_API_RERANKER_COHERE_API_KEY = apiKey!.trim();
      target.HINDSIGHT_API_RERANKER_COHERE_MODEL = reranker.model || "rerank-multilingual-v3.0";
      if (reranker.baseUrl) target.HINDSIGHT_API_RERANKER_COHERE_BASE_URL = reranker.baseUrl;
      return;
    }
    if (reranker.provider === "siliconflow") {
      target.HINDSIGHT_API_RERANKER_SILICONFLOW_API_KEY = apiKey!.trim();
      target.HINDSIGHT_API_RERANKER_SILICONFLOW_MODEL = reranker.model || "BAAI/bge-reranker-v2-m3";
      if (reranker.baseUrl) target.HINDSIGHT_API_RERANKER_SILICONFLOW_BASE_URL = reranker.baseUrl;
      return;
    }
    if (reranker.provider === "alibaba") {
      target.HINDSIGHT_API_RERANKER_ALIBABA_API_KEY = apiKey!.trim();
      target.HINDSIGHT_API_RERANKER_ALIBABA_MODEL = reranker.model || "qwen3-rerank";
      return;
    }
    if (reranker.provider === "zeroentropy") {
      target.HINDSIGHT_API_RERANKER_ZEROENTROPY_API_KEY = apiKey!.trim();
      target.HINDSIGHT_API_RERANKER_ZEROENTROPY_MODEL = reranker.model || "zerank-2";
      if (reranker.baseUrl) target.HINDSIGHT_API_RERANKER_ZEROENTROPY_BASE_URL = reranker.baseUrl;
    }
  }
  async #syncSource(installIntoExistingVenv = false): Promise<string> {
    const integration = this.#options.integrationDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../integrations/hindsight");
    const source = path.join(this.root, "source");
    await this.#regular(source);
    if (installIntoExistingVenv) {
      const currentToml = await fs.readFile(path.join(integration, "pyproject.toml"), "utf8");
      const installedToml = await this.#regular(path.join(source, "pyproject.toml")) ? await fs.readFile(path.join(source, "pyproject.toml"), "utf8") : "";
      const hasBridge = await this.#regular(path.join(source, "src", "kulo_hindsight", "bridge.py"));
      if (currentToml === installedToml && hasBridge) return source;
    }
    await fs.mkdir(source, { recursive: true, mode: 0o700 });
    await fs.cp(path.join(integration, "src"), path.join(source, "src"), { recursive: true, dereference: false, filter: (file) => !file.includes("__pycache__") && !file.endsWith(".pyc") });
    await fs.copyFile(path.join(integration, "pyproject.toml"), path.join(source, "pyproject.toml"));
    if (installIntoExistingVenv) {
      await this.#command("uv", ["pip", "install", "--no-config", "--no-deps", "--python", this.#python, source], 300_000);
    }
    return source;
  }
  deploy(command: HindsightServiceCommand): Promise<LocalHindsightConnection> {
    return this.#exclusive(async () => {
      this.#checkCommand(command.commandId); this.#checkPlatform();
      const model = modelConfig(command.model);
      const embeddings = embeddingsConfig(command.embeddings);
      const reranker = rerankerConfig(command.reranker);
      const stagedEnv: Record<string, string> = {};
      this.#applyModelEnv(stagedEnv, model, command.apiKey);
      this.#applyEmbeddingsEnv(stagedEnv, embeddings, command.embeddingsApiKey);
      this.#applyRerankerEnv(stagedEnv, reranker, command.rerankerApiKey);
      let manifest = await this.#manifest();
      if (manifest?.phase === "ready") {
        if (manifest.commandId !== command.commandId) throw new HindsightServiceError("本机已由 Kulo 部署 Hindsight，请使用配置服务。");
        return this.#connection(manifest, await this.#runtime());
      }
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.#regular(this.root);
      await fs.chmod(this.root, 0o700);
      if (!manifest) {
        manifest = { owner: OWNER, version: MANAGED_HINDSIGHT_VERSION, root: this.root, label: this.#label(), port: await this.#port(), model, embeddings, reranker, phase: "installing", commandId: command.commandId, serviceSetupStarted: false };
        await this.#saveManifest(manifest);
      } else if (manifest.phase === "absent") {
        manifest = { ...manifest, model, embeddings, reranker, phase: "installing", commandId: command.commandId, serviceSetupStarted: false };
        delete manifest.verificationId;
        await this.#saveManifest(manifest);
      } else if (manifest.phase === "failed") {
        await this.#stop(manifest);
        manifest = { ...manifest, model, embeddings, reranker, phase: "installing", commandId: command.commandId };
        delete manifest.verificationId;
        await this.#saveManifest(manifest);
      } else if (manifest.commandId !== command.commandId) throw new HindsightServiceError("已有未完成的 Hindsight 安装，请重试原操作。");
      const directories = ["home", "cache", "cache/uv", "python"];
      for (const directory of directories) { const target = path.join(this.root, directory); await this.#regular(target); await fs.mkdir(target, { recursive: true, mode: 0o700 }); }
      const existingRuntime = await this.#regular(this.#runtimePath) ? await this.#runtime() : undefined;
      const env: Record<string, string> = {
        ...existingRuntime?.env,
        KULO_HINDSIGHT_ROUTER_API_KEY: existingRuntime?.env.KULO_HINDSIGHT_ROUTER_API_KEY ?? randomBytes(32).toString("hex"),
        KULO_HINDSIGHT_WORKER_API_KEY: existingRuntime?.env.KULO_HINDSIGHT_WORKER_API_KEY ?? randomBytes(32).toString("hex"),
        KULO_HINDSIGHT_MANAGEMENT_API_KEY: existingRuntime?.env.KULO_HINDSIGHT_MANAGEMENT_API_KEY ?? randomBytes(32).toString("hex"),
        KULO_HINDSIGHT_PRIVATE_BANK: "kulo-core",
        KULO_HINDSIGHT_SHARED_BANK: "kulo-shared",
        HINDSIGHT_API_DATABASE_URL: existingRuntime?.env.HINDSIGHT_API_DATABASE_URL ?? `pg0://kulo:${randomBytes(32).toString("hex")}@${manifest.label.replace(/\./g, "-")}`,
        HINDSIGHT_API_HOST: "127.0.0.1",
        HINDSIGHT_API_PORT: String(manifest.port),
        HINDSIGHT_API_WORKER_ID: manifest.label,
        HINDSIGHT_API_MCP_ENABLED: "false",
        HINDSIGHT_API_LLM_TRACE_ENABLED: "false",
        HINDSIGHT_API_LOG_LEVEL: "WARNING",
        HINDSIGHT_API_WORKER_MAX_SLOTS: "2",
        HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS: "1",
      };
      this.#applyModelEnv(env, model, command.apiKey);
      this.#applyEmbeddingsEnv(env, embeddings, command.embeddingsApiKey);
      this.#applyRerankerEnv(env, reranker, command.rerankerApiKey);
      await this.#write(this.#runtimePath, JSON.stringify({ owner: OWNER, env } satisfies RuntimeFile));
      if (!await this.#regular(path.join(this.root, "service.log"))) await this.#write(path.join(this.root, "service.log"), "");
      try {
        await command.onProgress?.("检查安装环境");
        await this.#command("uv", ["--version"]);
        const source = await this.#syncSource(false);
        await command.onProgress?.("安装 Hindsight 与本地检索模型");
        await this.#command("uv", ["venv", "--no-project", "--no-config", "--managed-python", "--allow-existing", "--python", "3.12", path.join(this.root, "venv")], 300_000);
        await this.#command("uv", ["pip", "install", "--no-config", "--python", this.#python, `hindsight-api-slim[local-onnx,embedded-db]==${MANAGED_HINDSIGHT_VERSION}`, source], 1_800_000);
        // Persist before registration so an interrupted setup cannot look unstarted.
        manifest.serviceSetupStarted = true;
        await this.#saveManifest(manifest);
        await this.#installUnit(manifest);
        manifest.phase = "verifying"; await this.#saveManifest(manifest);
        await command.onProgress?.("启动并验证长期记忆");
        const logOffset = await this.#serviceLogSize();
        await this.#start(manifest);
        return await this.#verify(manifest, logOffset);
      } catch (error) {
        if (manifest.serviceSetupStarted) {
          await this.#stop(manifest).catch(() => {});
        }
        manifest.phase = "failed"; await this.#saveManifest(manifest);
        throw error;
      }
    });
  }
  configure(command: HindsightServiceCommand): Promise<LocalHindsightConnection> {
    return this.#exclusive(async () => {
      this.#checkCommand(command.commandId); this.#checkPlatform();
      let manifest = await this.#manifest();
      if (!manifest) throw new HindsightServiceError("本机尚未由 Kulo 部署 Hindsight。");
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
        const restoreLogOffset = await this.#serviceLogSize();
        await this.#start(manifest); await this.#ready(manifest, backup.runtime, restoreLogOffset);
        await fs.unlink(backupPath);
      }
      const before = await this.#runtime();
      const model = modelConfig(command.model);
      const beforeModel = manifest.model;
      const sameModelOrigin = model.provider !== "kulo" && beforeModel.provider === model.provider && modelOrigin(beforeModel) === modelOrigin(model);
      const apiKey = command.apiKey ?? (sameModelOrigin ? before.env.HINDSIGHT_API_LLM_API_KEY : undefined);

      const beforeEmbeddings = manifest.embeddings ?? { ...DEFAULT_LOCAL_EMBEDDINGS };
      const embeddings = embeddingsConfig(command.embeddings ?? beforeEmbeddings);
      const sameEmbeddingsOrigin = beforeEmbeddings.provider === embeddings.provider && embeddingsOrigin(beforeEmbeddings) === embeddingsOrigin(embeddings);
      const embeddingsApiKey = command.embeddingsApiKey ?? (sameEmbeddingsOrigin ? this.#existingEmbeddingsApiKey(before.env, embeddings.provider) : undefined);

      const beforeReranker = manifest.reranker ?? { ...DEFAULT_LOCAL_RERANKER };
      const reranker = rerankerConfig(command.reranker ?? beforeReranker);
      const sameRerankerOrigin = beforeReranker.provider === reranker.provider && rerankerOrigin(beforeReranker) === rerankerOrigin(reranker);
      const rerankerApiKey = command.rerankerApiKey ?? (sameRerankerOrigin ? this.#existingRerankerApiKey(before.env, reranker.provider) : undefined);

      const nextEnv: Record<string, string> = { ...before.env };
      this.#applyModelEnv(nextEnv, model, apiKey);
      this.#applyEmbeddingsEnv(nextEnv, embeddings, embeddingsApiKey);
      this.#applyRerankerEnv(nextEnv, reranker, rerankerApiKey);
      const after: RuntimeFile = { owner: OWNER, env: nextEnv };
      await command.onProgress?.("更新记忆模型配置");
      if (model.provider === "kulo") {
        await this.#syncSource(true);
      }
      await this.#write(backupPath, JSON.stringify({ owner: OWNER, commandId: command.commandId, manifest, runtime: before }));
      await this.#write(this.#runtimePath, JSON.stringify(after));
      try {
        const logOffset = await this.#serviceLogSize();
        await this.#start(manifest);
        const candidate = { ...manifest, model, embeddings, reranker, commandId: command.commandId, phase: "verifying" as const };
        const connection = await this.#verify(candidate, logOffset);
        await fs.unlink(backupPath);
        return connection;
      } catch (error) {
        await this.#write(this.#runtimePath, JSON.stringify(before));
        try {
          const rollbackLogOffset = await this.#serviceLogSize();
          await this.#start(manifest); await this.#ready(manifest, before, rollbackLogOffset); await this.#saveManifest(manifest); await fs.unlink(backupPath);
        } catch {
          if (manifest.serviceSetupStarted) await this.#stop(manifest).catch(() => {});
          manifest.phase = "failed"; await this.#saveManifest(manifest); throw new HindsightServiceError("新模型验证失败，旧配置已恢复，但服务恢复失败，请重试检查。");
        }
        throw error;
      }
    });
  }
  async #verify(manifest: Manifest, logOffset?: number): Promise<LocalHindsightConnection> {
    const runtime = await this.#runtime();
    const router = runtime.env.KULO_HINDSIGHT_ROUTER_API_KEY!, worker = runtime.env.KULO_HINDSIGHT_WORKER_API_KEY!, manager = runtime.env.KULO_HINDSIGHT_MANAGEMENT_API_KEY!;
    await this.#ready(manifest, runtime, logOffset);
    for (const [token, bank, method] of [[worker, "kulo-core", "GET"], [router, "kulo-shared", "POST"]] as const) {
      const response = await this.#request(manifest, token, `/v1/default/banks/${bank}/${method === "GET" ? "documents?limit=1" : "memories"}`, method, method === "POST" ? {} : undefined);
      await response.body?.cancel();
      if (response.status !== 403) throw new HindsightServiceError("Hindsight 未通过主脑与 Worker 权限隔离验证。");
    }
    for (const bank of ["kulo-core", "kulo-shared"]) {
      await this.#json(manifest, manager, `/v1/default/banks/${bank}/config`, "PATCH", { updates: { retain_extraction_mode: "concise", store_document_text: true, enable_observations: true, enable_auto_consolidation: true, retain_mission: bank === "kulo-core" ? HINDSIGHT_RETAIN_MISSIONS.private : HINDSIGHT_RETAIN_MISSIONS.shared, retain_strategies: { document: { retain_extraction_mode: "concise" }, conversation: { retain_extraction_mode: "concise" }, worklog: { retain_extraction_mode: "concise" } } } });
    }
    manifest.verificationId ??= randomUUID();
    await this.#saveManifest(manifest);
    const documentId = `kulo-install-check-${manifest.verificationId}`;
    const operationId = manifest.verificationId;
    const marker = `Kulo deployment verification ${documentId}`;
    const bankPrefix = "/v1/default/banks/kulo-shared";
    let submittedOperation: string | undefined;
    let completed = false;
    let terminal = false;
    try {
      submittedOperation = operationId;
      const accepted = await this.#json(manifest, worker, `${bankPrefix}/memories`, "POST", { async: true, operation_id: operationId, items: [{ content: `Kulo 安装验证项目的名称为「${marker}」，该项目由 Kulo 负责验证，验证语言是简体中文。`, document_id: documentId, tags: ["application:kulo", "verification:installation"], observation_scopes: [["verification:installation"]] }] });
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
    return {
      ...status,
      model: manifest.model,
      embeddings: manifest.embeddings ?? { ...DEFAULT_LOCAL_EMBEDDINGS },
      reranker: manifest.reranker ?? { ...DEFAULT_LOCAL_RERANKER },
      routerApiKey: runtime.env.KULO_HINDSIGHT_ROUTER_API_KEY!,
      workerApiKey: runtime.env.KULO_HINDSIGHT_WORKER_API_KEY!,
      banks: { private: "kulo-core", shared: "kulo-shared" },
    };
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
        try { await fs.access(this.#python); await this.#command(this.#python, ["-m", "kulo_hindsight.managed", "--config", this.#runtimePath, "--stop-database"]); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (await this.#unitOwned(manifest)) await fs.unlink(this.#unitPath(manifest));
      if (this.#platform === "linux") await this.#command("systemctl", ["--user", "daemon-reload"]);
      if (command.deleteData) {
        await this.#removeRoot(manifest);
      } else {
        // Retained databases stay recoverable, while model API keys are removed.
        if (await this.#regular(this.#runtimePath)) {
          const runtime = await this.#runtime();
          for (const key of [
            "HINDSIGHT_API_LLM_API_KEY",
            "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY",
            "HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY",
            "HINDSIGHT_API_EMBEDDINGS_COHERE_API_KEY",
            "HINDSIGHT_API_RERANKER_COHERE_API_KEY",
            "HINDSIGHT_API_RERANKER_SILICONFLOW_API_KEY",
            "HINDSIGHT_API_RERANKER_ALIBABA_API_KEY",
            "HINDSIGHT_API_RERANKER_ZEROENTROPY_API_KEY",
            "KULO_HINDSIGHT_ROUTER_API_KEY",
            "KULO_HINDSIGHT_WORKER_API_KEY",
            "KULO_HINDSIGHT_MANAGEMENT_API_KEY",
          ]) delete runtime.env[key];
          await this.#write(this.#runtimePath, JSON.stringify(runtime));
        }
        for (const directory of ["venv", "source", "python", "cache", "home/.cache", "configuration-backup.json"]) await fs.rm(path.join(this.root, directory), { recursive: true, force: true });
        manifest.phase = "absent"; manifest.commandId = command.commandId; await this.#saveManifest(manifest);
      }
      const status = await this.inspect();
      return { ...status, installed: false, running: false, phase: "absent" };
    });
  }
}
