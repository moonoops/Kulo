import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Models } from "@earendil-works/pi-ai";
import type {
  AmbientLocalEngine,
  AssistantBackgroundModelAdvice,
  AssistantBackgroundModelJob,
  AssistantBackgroundModelStatus,
} from "@kulo/protocol";
import type { AssistantBackgroundModelPersisted } from "./assistant-state.js";

const GIB = 1024 ** 3;
const DEFAULT_OMLX_PORT = 18_741;
const DEFAULT_OLLAMA_PORT = 11_434;

interface ManagedOwnerRecord {
  pid: number;
  fingerprint: string;
  engine: AmbientLocalEngine;
  modelId: string;
  port: number;
  mode: "managed" | "borrowed";
}

export interface AmbientModelServiceHost {
  stateDir: string;
  models: Models;
  defaultModel(): { provider: string; modelId: string };
  persistedConfig(): Promise<AssistantBackgroundModelPersisted>;
  saveConfig(next: AssistantBackgroundModelPersisted): Promise<void>;
  redact(text: string): string;
  onStatusChanged?: () => void;
  /** Injectable command runner for tests. */
  commandRunner?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** Injectable hardware probe for tests. */
  hardwareProbe?: () => {
    hostName: string;
    platform: string;
    arch: string;
    cpu: string;
    memoryBytes: number;
    diskFreeBytes: number;
    detectedRuntimes: string[];
  };
}

function readProcessStartFingerprint(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  if (process.platform === "win32") return String(pid);
  const res = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  const text = res.status === 0 ? res.stdout.trim() : "";
  return text ? `${pid}:${text}` : undefined;
}

function findExecutable(name: string): string | undefined {
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    path.join(os.homedir(), ".local", "bin", name),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

function detectFreeDiskBytes(dir: string): number {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return 0;
  }
}

function cleanRuntimeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `/opt/homebrew/bin:/usr/local/bin:${path.join(os.homedir(), ".local", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    ...extra,
  };
  for (const proxyKey of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[proxyKey]) env[proxyKey] = process.env[proxyKey];
  }
  return env;
}

/**
 * Direct loopback HTTP POST using node:http so local inference traffic NEVER passes through
 * globalThis.fetch's EnvHttpProxyAgent (HTTP_PROXY / ALL_PROXY).
 */
export function loopbackJsonPost(
  port: number,
  reqPath: string,
  body: unknown,
  options: { bearerToken?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
          ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
        },
        timeout: options.timeoutMs ?? 18_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 256 * 1024) {
            req.destroy(new Error("local_model_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    const onAbort = () => req.destroy(new Error("local_model_aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => req.destroy(new Error("local_model_timeout")));
    req.on("error", (err) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    req.on("close", () => {
      options.signal?.removeEventListener("abort", onAbort);
    });
    req.end(payload);
  });
}

function loopbackHealthCheck(port: number, bearerToken?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/models",
        method: "GET",
        headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : undefined,
        timeout: 1_500,
      },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export class AmbientModelService {
  readonly #host: AmbientModelServiceHost;
  readonly #secureDir: string;
  readonly #tokenPath: string;
  readonly #ownerPath: string;

  #child: ChildProcess | null = null;
  #running = false;
  #endpoint?: string;
  #bearerToken?: string;
  #lastError?: string;
  #job?: AssistantBackgroundModelJob;
  #closed = false;

  constructor(host: AmbientModelServiceHost) {
    this.#host = host;
    this.#secureDir = path.join(path.resolve(host.stateDir), ".secure");
    this.#tokenPath = path.join(this.#secureDir, "ambient-runtime-token");
    this.#ownerPath = path.join(this.#secureDir, "ambient-runtime-owner.json");
  }

  async start(): Promise<void> {
    this.#cleanupOrphanProcess();
    const cfg = await this.#host.persistedConfig();
    if (cfg.mode === "local-managed" && cfg.engine && cfg.modelId) {
      this.#bearerToken = this.#ensureBearerToken();
      const port = cfg.port ?? (cfg.engine === "omlx" ? DEFAULT_OMLX_PORT : DEFAULT_OLLAMA_PORT);
      if (await loopbackHealthCheck(port, this.#bearerToken)) {
        this.#running = true;
        this.#endpoint = `http://127.0.0.1:${port}`;
      } else {
        void this.#spawnManagedProcess(cfg.engine, cfg.modelId, port).catch((err) => {
          this.#lastError = this.#host.redact(err instanceof Error ? err.message : "本机模型启动失败");
        });
      }
    }
  }

  advise(): AssistantBackgroundModelAdvice {
    const hw = this.#host.hardwareProbe
      ? this.#host.hardwareProbe()
      : {
          hostName: os.hostname() || "Local Mac",
          platform: process.platform,
          arch: process.arch,
          cpu: os.cpus()[0]?.model ?? "Unknown CPU",
          memoryBytes: os.totalmem(),
          diskFreeBytes: detectFreeDiskBytes(this.#host.stateDir),
          detectedRuntimes: (["omlx", "ollama", "llama-server", "lms"] as const).filter((name) => Boolean(findExecutable(name))),
        };
    const ramGiB = hw.memoryBytes / GIB;
    const diskGiB = hw.diskFreeBytes / GIB;

    if (hw.platform === "darwin" && hw.arch === "arm64") {
      if (ramGiB >= 30 && diskGiB >= 12) {
        return {
          ...hw,
          recommendedMode: "local-managed",
          recommendedEngine: "omlx",
          recommendedModelId: "mlx-community/Qwen3-8B-4bit",
          estimatedRamGb: 5.5,
          reason: `本机为 ${Math.round(ramGiB)}GB 统一内存 Apple Silicon，推荐使用原生 oMLX（支持 SSD 分页前缀缓存）运行 Qwen3-8B-4bit，常驻约占 5.5GB 内存，零 API 费用且私密消息不出机。`,
        };
      }
      if (ramGiB >= 15 && diskGiB >= 8) {
        return {
          ...hw,
          recommendedMode: "local-managed",
          recommendedEngine: "omlx",
          recommendedModelId: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
          estimatedRamGb: 3,
          reason: `本机为 ${Math.round(ramGiB)}GB 统一内存 Apple Silicon，推荐使用原生 oMLX 运行轻量 Qwen3-4B-4bit，常驻仅占约 3GB 内存，后台摘要低延迟且不抢占主力工作内存。`,
        };
      }
      return {
        ...hw,
        recommendedMode: "auto",
        reason: `本机可用内存（${Math.round(ramGiB)}GB）或剩余磁盘空间偏紧，建议直接复用已配置的云端轻量模型，避免常驻本地模型拖慢系统。`,
      };
    }

    if (ramGiB >= 16 && diskGiB >= 10) {
      return {
        ...hw,
        recommendedMode: "local-managed",
        recommendedEngine: "ollama",
        recommendedModelId: ramGiB >= 30 ? "qwen3:8b" : "qwen3:4b",
        estimatedRamGb: ramGiB >= 30 ? 5.5 : 3,
        reason: `本机为 ${hw.platform}/${hw.arch}（${Math.round(ramGiB)}GB 内存），推荐使用 Ollama 常驻轻量模型跑后台摘要。`,
      };
    }

    return {
      ...hw,
      recommendedMode: "auto",
      reason: "当前宿主机内存较紧凑，建议直接沿用已配置的云端模型进行后台处理。",
    };
  }

  async status(): Promise<AssistantBackgroundModelStatus> {
    const cfg = await this.#host.persistedConfig();
    return {
      mode: cfg.mode,
      ...(cfg.engine ? { engine: cfg.engine } : {}),
      ...(cfg.modelId ? { modelId: cfg.modelId } : {}),
      ...(cfg.providerId ? { providerId: cfg.providerId } : {}),
      running: cfg.mode === "local-managed" ? this.#running : true,
      ...(this.#endpoint && cfg.mode === "local-managed" ? { endpoint: this.#endpoint } : {}),
      ...(this.#lastError ? { error: this.#lastError } : {}),
      ...(this.#job ? { job: { ...this.#job } } : {}),
      revision: cfg.revision,
    };
  }

  async configureAutoOrProvider(input: { mode: "auto" | "kulo-provider"; providerId?: string; modelId?: string }): Promise<AssistantBackgroundModelStatus> {
    await this.#stopManagedProcess();
    const prev = await this.#host.persistedConfig();
    this.#lastError = undefined;
    await this.#host.saveConfig({
      mode: input.mode,
      ...(input.mode === "kulo-provider" && input.providerId ? { providerId: input.providerId } : {}),
      ...(input.mode === "kulo-provider" && input.modelId ? { modelId: input.modelId } : {}),
      revision: prev.revision + 1,
    });
    this.#host.onStatusChanged?.();
    return this.status();
  }

  async deployLocalManaged(input: { engine: AmbientLocalEngine; modelId: string }): Promise<AssistantBackgroundModelStatus> {
    if (this.#closed) throw new Error("Ambient model service is closed");
    const job: AssistantBackgroundModelJob = {
      id: `amb-${randomUUID()}`,
      operation: "deploy",
      status: "running",
      progress: `正在检查 ${input.engine} 运行时…`,
      updatedAt: Date.now(),
    };
    this.#job = job;
    this.#lastError = undefined;
    this.#host.onStatusChanged?.();

    try {
      await this.#stopManagedProcess();
      const exe = findExecutable(input.engine);
      if (!exe) {
        job.progress = `未检测到 ${input.engine}，尝试安装…`;
        job.updatedAt = Date.now();
        this.#host.onStatusChanged?.();
        const installCmd = input.engine === "omlx"
          ? (findExecutable("brew") ? ["brew", ["install", "omlx"]] as const : findExecutable("uv") ? ["uv", ["tool", "install", "omlx"]] as const : null)
          : (findExecutable("brew") ? ["brew", ["install", "ollama"]] as const : null);
        if (!installCmd) {
          throw new Error(`未找到 ${input.engine}，且本机缺少自动安装器（brew/uv）。请先手动安装 ${input.engine} 后重试。`);
        }
        const installRes = await this.#execCommand(installCmd[0], [...installCmd[1]]);
        if (!installRes.ok) {
          throw new Error(`安装 ${input.engine} 失败：${this.#host.redact(installRes.stderr || installRes.stdout).slice(0, 240)}`);
        }
      }

      const port = input.engine === "omlx" ? DEFAULT_OMLX_PORT : DEFAULT_OLLAMA_PORT;
      job.progress = `正在拉起 ${input.engine} 并加载 ${input.modelId}…`;
      job.updatedAt = Date.now();
      this.#host.onStatusChanged?.();

      await this.#spawnManagedProcess(input.engine, input.modelId, port);
      const prev = await this.#host.persistedConfig();
      await this.#host.saveConfig({
        mode: "local-managed",
        engine: input.engine,
        modelId: input.modelId,
        port,
        revision: prev.revision + 1,
      });

      job.status = "completed";
      job.progress = "本机加速已就绪";
      job.updatedAt = Date.now();
      this.#host.onStatusChanged?.();
      return this.status();
    } catch (error) {
      const msg = this.#host.redact(error instanceof Error ? error.message : "本机模型部署失败").slice(0, 300);
      this.#lastError = msg;
      job.status = "failed";
      job.error = msg;
      job.updatedAt = Date.now();
      this.#host.onStatusChanged?.();
      throw error;
    }
  }

  /**
   * Executes a strictly zero-tool JSON generation using the configured background model
   * (Hub-local oMLX/Ollama via direct loopback bypassing HTTP_PROXY, or fallback to Kulo model
   * with `disableNativeTools: true`).
   */
  async completeZeroToolJson(input: {
    systemPrompt: string;
    userContent: string;
    maxTokens?: number;
    signal?: AbortSignal;
    preferMainModel?: boolean;
  }): Promise<string> {
    const cfg = await this.#host.persistedConfig();
    if (!input.preferMainModel && cfg.mode === "local-managed" && cfg.modelId && this.#running && this.#endpoint) {
      const port = cfg.port ?? (cfg.engine === "omlx" ? DEFAULT_OMLX_PORT : DEFAULT_OLLAMA_PORT);
      try {
        const res = await loopbackJsonPost(
          port,
          "/v1/chat/completions",
          {
            model: cfg.modelId,
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: this.#host.redact(input.userContent) },
            ],
            temperature: 0.1,
            max_tokens: input.maxTokens ?? 800,
          },
          { bearerToken: this.#bearerToken, timeoutMs: 18_000, signal: input.signal },
        );
        if (res.status >= 200 && res.status < 300) {
          const decoded = JSON.parse(res.body) as { choices?: Array<{ message?: { content?: unknown } }> };
          const content = decoded?.choices?.[0]?.message?.content;
          if (typeof content === "string" && content.trim()) {
            return this.#host.redact(content);
          }
        }
      } catch {
        // Fall through cleanly to configured Kulo model when local runtime is temporarily busy/offline.
      }
    }

    const chosen = !input.preferMainModel && cfg.mode === "kulo-provider" && cfg.providerId && cfg.modelId
      ? { provider: cfg.providerId, modelId: cfg.modelId }
      : this.#host.defaultModel();
    const model = this.#host.models.getModel(chosen.provider, chosen.modelId);
    if (!model) throw new Error("assistant_model_unavailable");

    const message = await this.#host.models.completeSimple(
      model,
      {
        messages: [
          { role: "system", content: input.systemPrompt, timestamp: Date.now() },
          { role: "user", content: this.#host.redact(input.userContent), timestamp: Date.now() },
        ],
      },
      {
        signal: input.signal,
        maxTokens: Math.min(input.maxTokens ?? 1_200, model.maxTokens || 1_200),
        cacheRetention: "none",
        disableNativeTools: true,
      } as Parameters<Models["completeSimple"]>[2],
    );
    if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) {
      throw new Error("assistant_model_invalid_response");
    }
    return this.#host.redact(
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#stopManagedProcess();
  }

  #ensureBearerToken(): string {
    fs.mkdirSync(this.#secureDir, { recursive: true, mode: 0o700 });
    try {
      if (fs.existsSync(this.#tokenPath)) {
        const existing = fs.readFileSync(this.#tokenPath, "utf8").trim();
        if (existing.length >= 32) return existing;
      }
    } catch { /* regenerate */ }
    const token = randomBytes(32).toString("hex");
    fs.writeFileSync(this.#tokenPath, token, { mode: 0o600 });
    return token;
  }

  #execCommand(command: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const env = cleanRuntimeEnv();
    if (this.#host.commandRunner) {
      return this.#host.commandRunner(command, args, env);
    }
    return new Promise((resolve) => {
      const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
      timer.unref();
      child.stdout.on("data", (c: Buffer) => { if (out.length < 64) out.push(c); });
      child.stderr.on("data", (c: Buffer) => { if (err.length < 64) err.push(c); });
      child.once("error", (e) => { clearTimeout(timer); resolve({ ok: false, stdout: "", stderr: e.message }); });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
    });
  }

  async #spawnManagedProcess(engine: AmbientLocalEngine, modelId: string, port: number): Promise<void> {
    this.#bearerToken = this.#ensureBearerToken();
    const exe = findExecutable(engine);
    if (!exe) throw new Error(`未找到可执行程序 ${engine}`);

    if (engine === "ollama") {
      // Ensure the requested model is pulled before serving.
      const pull = await this.#execCommand(exe, ["pull", modelId]);
      if (!pull.ok) throw new Error(`拉取模型 ${modelId} 失败：${pull.stderr.slice(0, 200)}`);
    }

    const args = engine === "omlx"
      ? ["serve", "--host", "127.0.0.1", "--port", String(port), "--api-key", this.#bearerToken, "--no-proxy", "localhost,127.0.0.1"]
      : ["serve"];
    const env = cleanRuntimeEnv(
      engine === "ollama"
        ? { OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_ORIGINS: "http://127.0.0.1" }
        : { OMLX_API_KEY: this.#bearerToken },
    );
    const child = spawn(exe, args, {
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    child.unref();
    this.#child = child;
    const pid = child.pid;
    if (pid) {
      const fingerprint = readProcessStartFingerprint(pid) ?? String(pid);
      this.#writeOwner({ pid, fingerprint, engine, modelId, port, mode: "managed" });
    }
    child.once("exit", () => {
      if (this.#child === child) {
        this.#child = null;
        this.#running = false;
      }
    });

    // Wait briefly for local loopback readiness.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !this.#closed) {
      if (await loopbackHealthCheck(port, this.#bearerToken)) {
        this.#running = true;
        this.#endpoint = `http://127.0.0.1:${port}`;
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    await this.#stopManagedProcess();
    throw new Error(`${engine} 启动超时，请检查端口 ${port} 或本机日志`);
  }

  #writeOwner(record: ManagedOwnerRecord): void {
    try {
      fs.mkdirSync(this.#secureDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.#ownerPath, JSON.stringify(record), { mode: 0o600 });
    } catch { /* ignore */ }
  }

  #cleanupOrphanProcess(): void {
    try {
      if (!fs.existsSync(this.#ownerPath)) return;
      const saved = JSON.parse(fs.readFileSync(this.#ownerPath, "utf8")) as Partial<ManagedOwnerRecord>;
      if (saved.mode !== "managed" || !Number.isSafeInteger(saved.pid) || typeof saved.fingerprint !== "string") {
        fs.rmSync(this.#ownerPath, { force: true });
        return;
      }
      const liveFingerprint = readProcessStartFingerprint(saved.pid!);
      if (liveFingerprint && liveFingerprint === saved.fingerprint) {
        try {
          if (process.platform !== "win32") process.kill(-saved.pid!, "SIGTERM");
          else process.kill(saved.pid!, "SIGTERM");
        } catch { /* already gone */ }
      }
      fs.rmSync(this.#ownerPath, { force: true });
    } catch { /* ignore */ }
  }

  async #stopManagedProcess(): Promise<void> {
    this.#running = false;
    this.#endpoint = undefined;
    const child = this.#child;
    this.#child = null;
    if (child?.pid) {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { /* ignore */ }
    }
    this.#cleanupOrphanProcess();
  }
}
