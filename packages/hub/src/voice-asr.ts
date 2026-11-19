import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants, createReadStream, realpathSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";
import { serviceApiFetch } from "./web-content.js";

const require = createRequire(import.meta.url);
const MODEL_DIRECTORY = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
const ARCHIVE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_DIRECTORY}.tar.bz2`;
// The release asset digest also covers the license and tokenizer extracted below.
const ARCHIVE_SHA256 = "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e";
const ARCHIVE_BYTES = 163_002_883;
const MODEL_FILES = [
  { name: "model.int8.onnx", bytes: 239_233_841, sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" },
  { name: "tokens.txt", bytes: 315_894, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" },
] as const;
const ALLOWED_DOWNLOAD_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 20 * 60;
const PCM_BYTES_PER_SECOND = 16_000 * 4;
const MAX_PCM_BYTES = MAX_AUDIO_SECONDS * PCM_BYTES_PER_SECOND;
const WORKER_FILE = fileURLToPath(new URL("../scripts/voice-asr-worker.cjs", import.meta.url));

export interface LocalVoiceAsrStatus {
  status: "unprepared" | "preparing" | "ready" | "error";
  progress?: number;
  error?: string;
}

export class VoiceAsrError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "VoiceAsrError"; }
}

export interface VoiceAsrProcessOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
  native?: boolean;
}
export type VoiceAsrProcessRunner = (command: string, args: string[], options: VoiceAsrProcessOptions) => Promise<string>;
export interface LocalVoiceAsrOptions {
  stateDir: string;
  onStatus?: (status: LocalVoiceAsrStatus) => void;
  fetch?: typeof globalThis.fetch;
  /** An already installed, checksum-verified model directory supplied by the Hub. */
  modelDirectory?: string;
  ffmpegPath?: string;
  run?: VoiceAsrProcessRunner;
}

function aborted(signal: AbortSignal): void { signal.throwIfAborted(); }
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function childEnvironment(native: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: "C.UTF-8" };
  for (const name of ["PATH", "HOME", "SystemRoot", "SYSTEMROOT", "USERPROFILE", "TEMP", "TMP"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  if (native) {
    let directory: string;
    try {
      const dependencyRequire = createRequire(require.resolve("sherpa-onnx-node"));
      const platform = process.platform === "win32" ? "win" : process.platform;
      directory = path.dirname(dependencyRequire.resolve(`sherpa-onnx-${platform}-${process.arch}/package.json`));
    } catch {
      throw new VoiceAsrError("asr_runtime_missing", "本地语音识别组件不可用，请检查 Hub 安装。");
    }
    if (process.platform === "darwin") env.DYLD_LIBRARY_PATH = directory;
    else if (process.platform === "linux") env.LD_LIBRARY_PATH = directory;
    else if (process.platform === "win32") env.PATH = `${directory}${path.delimiter}${env.PATH ?? ""}`;
  }
  return env;
}

const runProcess: VoiceAsrProcessRunner = async (command, args, options) => {
  aborted(options.signal);
  const env = childEnvironment(options.native ?? false);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let failure: unknown;
    const finish = (error?: unknown, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(output ?? "");
    };
    const stop = (error: unknown) => {
      if (settled || failure !== undefined) return;
      failure = error;
      // Wait for close before the caller removes decoded audio, including on Windows.
      child.kill("SIGKILL");
    };
    const abort = () => stop(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => stop(new VoiceAsrError("asr_process_timeout", "本地语音处理超时，请重试较短的语音。")), options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure !== undefined) return;
      size += chunk.length;
      if (size > (options.maxOutputBytes ?? 256 * 1024)) stop(new VoiceAsrError("asr_output_too_large", "本地语音处理结果过大。"));
      else chunks.push(chunk);
    });
    child.once("error", () => finish(new VoiceAsrError("asr_process_unavailable", "本地语音处理组件无法启动，请检查 Hub 安装。")));
    child.once("close", (code) => {
      if (failure !== undefined) finish(failure);
      else if (code !== 0) finish(new VoiceAsrError("asr_process_failed", "本地语音处理失败，请检查音频文件后重试。"));
      else finish(undefined, Buffer.concat(chunks).toString("utf8"));
    });
    if (options.signal.aborted) abort();
  });
};

async function checksum(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function validModel(directory: string): Promise<boolean> {
  for (const model of MODEL_FILES) {
    const file = path.join(directory, model.name);
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== model.bytes || await checksum(file) !== model.sha256) return false;
  }
  return true;
}

async function fetchModel(url: URL, signal: AbortSignal): Promise<Response> {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return globalThis.fetch(url, { signal, redirect: "manual" });
  // Node's built-in fetch does not use HTTP(S)_PROXY on every supported Node
  // version. Model downloads follow the same explicit proxy as the Hub.
  return new Promise<Response>((resolve, reject) => {
    const request = httpsGet(url, { signal, agent: new HttpsProxyAgent(proxy) }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode, headers }));
    });
    request.once("error", reject);
  });
}

export class LocalVoiceAsr {
  readonly #options: LocalVoiceAsrOptions;
  readonly #root: string;
  readonly #model: string;
  readonly #lifetime = new AbortController();
  #status: LocalVoiceAsrStatus = { status: "unprepared" };
  #preparation?: Promise<void>;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: LocalVoiceAsrOptions) {
    this.#options = options;
    this.#root = path.join(path.resolve(options.stateDir), "voice", "asr");
    this.#model = options.modelDirectory ? path.resolve(options.modelDirectory) : path.join(this.#root, MODEL_DIRECTORY);
  }
  status(): LocalVoiceAsrStatus { return { ...this.#status }; }
  #setStatus(status: LocalVoiceAsrStatus): void {
    if (this.#status.status === status.status && this.#status.progress === status.progress && this.#status.error === status.error) return;
    this.#status = status;
    this.#options.onStatus?.(this.status());
  }
  #run(command: string, args: string[], options: VoiceAsrProcessOptions): Promise<string> {
    return (this.#options.run ?? runProcess)(command, args, options);
  }
  #assertOpen(): void {
    if (this.#closed) throw new VoiceAsrError("asr_closed", "本地语音识别已停止。");
  }

  prepare(): Promise<void> {
    try { this.#assertOpen(); } catch (error) { return Promise.reject(error); }
    if (this.#status.status === "ready") return Promise.resolve();
    if (this.#preparation) return this.#preparation;
    this.#preparation = this.#prepare().catch((error: unknown) => {
      if (!this.#closed) this.#setStatus({ status: "error", error: error instanceof VoiceAsrError ? error.message : "本地语音识别准备失败，请重试。" });
      throw error;
    }).finally(() => { this.#preparation = undefined; });
    return this.#preparation;
  }

  async #prepare(): Promise<void> {
    this.#setStatus({ status: "preparing", progress: 0 });
    await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
    try { await fs.access(this.#decoder(), fsConstants.X_OK); }
    catch { throw new VoiceAsrError("asr_decoder_missing", "本地音频解码组件不可用，请检查 Hub 安装。"); }
    if (!await validModel(this.#model)) {
      if (this.#options.modelDirectory) throw new VoiceAsrError("asr_model_invalid", "本地语音模型缺失或校验失败。");
      await this.#installModel();
    }
    aborted(this.#lifetime.signal);
    this.#setStatus({ status: "preparing", progress: 98 });
    await this.#run(process.execPath, [WORKER_FILE, "--check", this.#model], { signal: this.#lifetime.signal, timeoutMs: 60_000, native: true });
    aborted(this.#lifetime.signal);
    this.#setStatus({ status: "ready", progress: 100 });
  }

  async #download(file: string): Promise<void> {
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5 * 60_000)]);
    let url = new URL(ARCHIVE_URL);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname) || url.username || url.password) {
        throw new VoiceAsrError("asr_download_origin", "本地语音模型下载来源无效。");
      }
      response = this.#options.fetch ? await this.#options.fetch(url, { signal, redirect: "manual" }) : await fetchModel(url, signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new VoiceAsrError("asr_download_redirect", "本地语音模型下载跳转失败。");
      url = new URL(location, url);
    }
    if (!response?.ok || !response.body) {
      await response?.body?.cancel();
      throw new VoiceAsrError("asr_download_failed", "本地语音模型下载失败，请重试。");
    }
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) !== ARCHIVE_BYTES) {
      await response.body.cancel();
      throw new VoiceAsrError("asr_download_size", "本地语音模型大小不符，请重试。");
    }
    const output = await fs.open(file, "wx", 0o600);
    const reader = response.body.getReader();
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        aborted(signal);
        bytes += value.byteLength;
        if (bytes > ARCHIVE_BYTES) throw new VoiceAsrError("asr_download_size", "本地语音模型超过大小限制。");
        digest.update(value);
        await output.writeFile(value);
        this.#setStatus({ status: "preparing", progress: Math.floor(bytes / ARCHIVE_BYTES * 90) });
      }
      if (bytes !== ARCHIVE_BYTES || digest.digest("hex") !== ARCHIVE_SHA256) throw new VoiceAsrError("asr_model_checksum", "本地语音模型校验失败，请重试。");
    } finally {
      await reader.cancel().catch(() => undefined);
      await output.close();
    }
  }

  #decoder(): string {
    if (this.#options.ffmpegPath) return this.#options.ffmpegPath;
    let ffmpeg: string | undefined;
    try { ffmpeg = require("ffmpeg-static") as string | undefined; }
    catch { throw new VoiceAsrError("asr_decoder_missing", "本地音频解码组件不可用，请检查 Hub 安装。"); }
    if (!ffmpeg) throw new VoiceAsrError("asr_decoder_missing", "当前系统缺少本地音频解码组件。");
    return ffmpeg;
  }

  async #installModel(): Promise<void> {
    const temporary = await fs.mkdtemp(path.join(this.#root, ".prepare-"));
    try {
      const archive = path.join(temporary, "model.tar.bz2");
      await this.#download(archive);
      aborted(this.#lifetime.signal);
      this.#setStatus({ status: "preparing", progress: 92 });
      await this.#run("tar", ["-xjf", archive, "-C", temporary, ...["model.int8.onnx", "tokens.txt", "LICENSE", "README.md"].map((name) => `${MODEL_DIRECTORY}/${name}`)], {
        signal: this.#lifetime.signal, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
      });
      const extracted = path.join(temporary, MODEL_DIRECTORY);
      if (!await validModel(extracted)) throw new VoiceAsrError("asr_model_checksum", "本地语音模型校验失败，请重试。");
      aborted(this.#lifetime.signal);
      // Only the managed model directory is replaced, after the complete release is verified.
      await fs.rm(this.#model, { recursive: true, force: true });
      await fs.rename(extracted, this.#model);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }

  transcribe(filePath: string, signal?: AbortSignal): Promise<string> {
    try { this.#assertOpen(); } catch (error) { return Promise.reject(error); }
    const cancellation = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    if (cancellation.aborted) return Promise.reject(cancellation.reason);
    const work = this.#tail.then(async () => {
      aborted(cancellation);
      const stat = await fs.lstat(filePath).catch((error: unknown) => {
        if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new VoiceAsrError("asr_invalid_audio", "语音文件不存在或不可读取，请重新发送。");
        throw error;
      });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_AUDIO_BYTES) throw new VoiceAsrError("asr_invalid_audio", "语音文件无效或超过 50 MB。");
      await cancellable(this.prepare(), cancellation);
      aborted(cancellation);
      const temporary = await fs.mkdtemp(path.join(this.#root, ".audio-"));
      try {
        const pcm = path.join(temporary, `${randomUUID()}.pcm`);
        const ffmpeg = this.#decoder();
        try {
          await this.#run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-max_alloc", "67108864", "-i", path.resolve(filePath), "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-fs", String(MAX_PCM_BYTES + 4), pcm], {
            signal: cancellation, timeoutMs: 60_000, maxOutputBytes: 16 * 1024,
          });
        } catch (error) {
          if (cancellation.aborted) throw cancellation.reason;
          throw new VoiceAsrError("asr_decode_failed", error instanceof VoiceAsrError && error.code === "asr_process_timeout" ? error.message : "这段语音无法解码，请重新录制后重试。");
        }
        const decoded = await fs.stat(pcm);
        if (!decoded.size || decoded.size % 4 !== 0) throw new VoiceAsrError("asr_empty_audio", "这段语音没有可识别的音频。");
        if (decoded.size > MAX_PCM_BYTES) throw new VoiceAsrError("asr_audio_too_long", "本地语音识别每次最多支持 20 分钟。");
        const duration = decoded.size / PCM_BYTES_PER_SECOND;
        const output = await this.#run(process.execPath, [WORKER_FILE, "--transcribe", this.#model, pcm], {
          signal: cancellation, timeoutMs: Math.min(10 * 60_000, 30_000 + Math.ceil(duration * 2_000)), native: true,
        });
        let result: unknown;
        try { result = JSON.parse(output); }
        catch { throw new VoiceAsrError("asr_invalid_result", "本地语音识别结果无效，请重试。"); }
        const text = result && typeof result === "object" && "text" in result ? result.text : undefined;
        if (typeof text !== "string" || text.length > 100_000) throw new VoiceAsrError("asr_invalid_result", "本地语音识别结果无效，请重试。");
        if (!text.trim()) throw new VoiceAsrError("asr_no_speech", "没有识别到清晰语音，请重新录制后重试。");
        return text.trim();
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    });
    this.#tail = work.then(() => undefined, () => undefined);
    return cancellable(work, cancellation);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort(new VoiceAsrError("asr_closed", "本地语音识别已停止。"));
  }
}

interface BundledOpenAIModule {
  default: new (opts: Record<string, unknown>) => {
    audio: { transcriptions: { create: (body: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<{ text?: unknown }> } };
  };
  toFile: (value: Buffer, name: string) => Promise<unknown>;
}

let cachedOpenAIMod: BundledOpenAIModule | undefined;
function getBundledOpenAI(): BundledOpenAIModule {
  if (!cachedOpenAIMod) {
    const piDir = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/@earendil-works/pi-ai"));
    cachedOpenAIMod = createRequire(path.join(piDir, "package.json"))("openai") as BundledOpenAIModule;
  }
  return cachedOpenAIMod;
}

export async function transcribeCloudAudio(
  filePath: string,
  config: { baseUrl: string; apiKey: string; modelId: string },
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 120_000)]);
  signal.throwIfAborted();
  let parsedBase: URL;
  try { parsedBase = new URL(config.baseUrl); }
  catch { throw new VoiceAsrError("asr_invalid_endpoint", "语音识别服务地址无效。"); }
  if ((parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") || parsedBase.username || parsedBase.password) {
    throw new VoiceAsrError("asr_invalid_endpoint", "语音识别服务地址无效。");
  }
  if (!config.apiKey.trim()) {
    throw new VoiceAsrError("asr_missing_credential", "请先配置此语音识别模型的 API Key。");
  }
  const stat = await fs.lstat(filePath).catch((error: unknown) => {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new VoiceAsrError("asr_invalid_audio", "语音文件不存在或不可读取，请重新发送。");
    }
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_AUDIO_BYTES) {
    throw new VoiceAsrError("asr_invalid_audio", "语音文件无效或超过 50 MB。");
  }
  const audioBytes = await fs.readFile(filePath);
  signal.throwIfAborted();

  const rawBase = config.baseUrl.replace(/\/+$/, "");
  const normalizedBase = /\/v\d+(?:beta\d*)?$/.test(parsedBase.pathname.replace(/\/+$/, "")) ? rawBase : `${rawBase}/v1`;
  const { default: OpenAI, toFile } = getBundledOpenAI();
  const transport = (url: string | URL | Request, init?: RequestInit) => {
    const merged: RequestInit = { ...init, redirect: "error", signal };
    const target = typeof url === "string" || url instanceof URL ? url : url.url;
    return options.fetch ? options.fetch(target, merged) : serviceApiFetch(target, merged, { maxResponseBytes: 2 * 1024 * 1024, timeoutMs: options.timeoutMs ?? 120_000 });
  };
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: normalizedBase, maxRetries: 0, fetch: transport });
  let response: { text?: unknown };
  try {
    const file = await toFile(audioBytes, path.basename(filePath) || "audio.webm");
    response = await client.audio.transcriptions.create({ file, model: config.modelId.trim() }, { signal });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
    if (status === 401 || status === 403) throw new VoiceAsrError("asr_auth_failed", "语音识别认证失败，请检查模型连接的 API Key。");
    if (status !== undefined) throw new VoiceAsrError("asr_provider_error", `语音识别服务返回 HTTP ${status}。`);
    throw new VoiceAsrError(signal.aborted ? "asr_timeout" : "asr_connection_failed", signal.aborted ? "云端语音识别超时，请重试。" : "无法连接语音识别服务，请重试。");
  }
  const text = typeof response?.text === "string" ? response.text : undefined;
  if (text === undefined || text.length > 100_000) throw new VoiceAsrError("asr_invalid_result", "语音识别返回结果无效，请重试。");
  if (!text.trim()) throw new VoiceAsrError("asr_no_speech", "没有识别到清晰语音，请重新录制后重试。");
  return text.trim();
}
