import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HindsightLocalService, type HindsightProcessRunner } from "../packages/hub/src/hindsight-service.js";
import { buildAugmentedHostPath, findHostExecutable } from "../packages/hub/src/host-path.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: { pending?: boolean; clockLimit?: number; installationFails?: boolean; platform?: "darwin" | "linux"; removalDelay?: number; removalNeverCompletes?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-managed-memory-")); directories.push(directory);
  const stateDir = path.join(directory, "state"), homeDir = path.join(directory, "user");
  const root = path.join(stateDir, "managed-hindsight");
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const requests: Array<{ path: string; method: string; token: string; body: unknown }> = [];
  let running = false, now = 0;
  let registered = false, removing = 0;
  let marker = "";
  let submissionCount = 0;
  const run: HindsightProcessRunner = async (command, args, processOptions) => {
    calls.push({ command, args, env: processOptions.env });
    if (command === "uv" && args[0] === "pip") {
      await fs.mkdir(path.join(root, "venv", "bin"), { recursive: true });
      await fs.writeFile(path.join(root, "venv", "bin", "python"), "test executable");
      if (options.installationFails) return { code: 1 };
    }
    if (command === path.join(root, "venv", "bin", "python") && options.installationFails) return { code: 1 };
    if (command === "launchctl" && args[0] === "bootstrap") {
      if (registered) return { code: 5 };
      running = registered = true;
    }
    if (command === "launchctl" && args[0] === "bootout") {
      running = false;
      if (registered) removing = options.removalDelay ?? 0;
      if (!removing && !options.removalNeverCompletes) registered = false;
    }
    if (command === "launchctl" && args[0] === "print") {
      if (!registered) return { code: 113 };
      if (removing > 0 && --removing === 0 && !options.removalNeverCompletes) registered = false;
      return { code: 0, stdout: "private launchd details" };
    }
    if (command === "systemctl" && ["enable", "restart"].some((operation) => args.includes(operation))) running = true;
    if (command === "systemctl" && ["disable", "stop"].some((operation) => args.includes(operation))) running = false;
    return { code: 0, stdout: "test", stderr: "" };
  };
  const request: typeof fetch = async (input, init) => {
    if (!running) throw new Error("not listening");
    const runtime = JSON.parse(await fs.readFile(path.join(root, "runtime.json"), "utf8")) as { env: Record<string, string> };
    const env = runtime.env;
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")!.slice(7);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path: url.pathname, method, token, body });
    const send = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/v1/kulo/access") return send({ policyVersion: 1 });
    if (token === env.KULO_HINDSIGHT_WORKER_API_KEY && url.pathname.includes("/kulo-core/")) return send({}, 403);
    if (token === env.KULO_HINDSIGHT_ROUTER_API_KEY && method === "POST" && url.pathname.endsWith("/memories")) return send({}, 403);
    if (url.pathname.endsWith("/config")) return send({});
    if (method === "POST" && url.pathname.endsWith("/memories")) {
      submissionCount++;
      marker = body.items[0].document_id;
      return send({ operation_id: body.operation_id });
    }
    if (url.pathname.includes("/operations/")) return send({ status: method === "DELETE" ? "cancelled" : env.HINDSIGHT_API_LLM_MODEL === "bad-model" ? "failed" : options.pending ? "pending" : "completed" });
    if (url.pathname.endsWith("/memories/recall")) return send({ results: [{ text: marker }] });
    if (url.pathname.endsWith("/reflect")) return send({ text: marker });
    if (method === "DELETE" && url.pathname.includes("/documents/")) return send({ status: "deleted" });
    return send({}, 404);
  };
  const service = new HindsightLocalService({ stateDir, homeDir, platform: options.platform ?? "darwin", deviceName: "Test Mac", run, fetch: request, now: () => now, sleep: async (ms) => { now += ms; }, readinessTimeoutMs: options.clockLimit ?? 5000, verificationTimeoutMs: options.clockLimit ?? 5000 });
  const deploy = () => service.deploy({ commandId: "install-1", model: { provider: "openai", model: "test-model", baseUrl: "https://api.example.test/v1" }, apiKey: "test-model-key-0000000000000000000000000" });
  return { directory, root, homeDir, calls, requests, service, deploy, submissions: () => submissionCount };
}

describe("Kulo-owned Hindsight local service", () => {
  it("only inspects before deployment and never returns credentials in public state", async () => {
    const f = await fixture();
    expect(await f.service.inspect()).toMatchObject({ installed: false, running: false, phase: "absent", deviceName: "Test Mac" });
    expect(f.calls).toHaveLength(0); expect(f.requests).toHaveLength(0);
    const connection = await f.deploy();
    expect(connection).toMatchObject({ installed: true, running: true, phase: "ready", model: { provider: "openai", model: "test-model" } });
    expect(connection.routerApiKey).not.toEqual(connection.workerApiKey);
    const status = JSON.stringify(await f.service.inspect());
    expect(status).not.toContain(connection.routerApiKey); expect(status).not.toContain(connection.workerApiKey); expect(status).not.toContain("test-model-key");
    expect((await fs.stat(f.root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(f.root, "runtime.json"))).mode & 0o777).toBe(0o600);
    const runtime = JSON.parse(await fs.readFile(path.join(f.root, "runtime.json"), "utf8"));
    expect(Number(runtime.env.HINDSIGHT_API_WORKER_MAX_SLOTS)).toBeGreaterThan(Number(runtime.env.HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS));
    expect(JSON.stringify(f.calls)).not.toContain("test-model-key");
    const plist = await fs.readFile(path.join(f.homeDir, "Library", "LaunchAgents", (await fs.readdir(path.join(f.homeDir, "Library", "LaunchAgents")))[0]!), "utf8");
    expect(plist).toContain("kulo_hindsight.managed"); expect(plist).not.toContain("test-model-key");
  });

  it("preserves explicit Rust toolchain locations only for build processes with an isolated service HOME", async () => {
    vi.stubEnv("RUSTUP_HOME", "/test-host/toolchains"); vi.stubEnv("CARGO_HOME", "/test-host/cargo");
    const f = await fixture(); await f.deploy();
    for (const call of f.calls.filter((call) => ["uv", "rustc", "cargo"].includes(call.command))) {
      expect(call.env.HOME).toBe(path.join(f.root, "home"));
      expect(call.env.RUSTUP_HOME).toBe("/test-host/toolchains"); expect(call.env.CARGO_HOME).toBe("/test-host/cargo");
    }
    for (const call of f.calls.filter((call) => call.command === "launchctl")) {
      expect(call.env.RUSTUP_HOME).toBeUndefined(); expect(call.env.CARGO_HOME).toBeUndefined();
    }
    const plist = await fs.readFile(path.join(f.homeDir, "Library", "LaunchAgents", (await fs.readdir(path.join(f.homeDir, "Library", "LaunchAgents")))[0]!), "utf8");
    expect(plist).not.toContain("/test-host/toolchains"); expect(plist).not.toContain("/test-host/cargo");
  });

  it("installs official platform wheels without requiring a host Rust toolchain", async () => {
    const f = await fixture();
    await f.deploy();
    expect(f.calls.some((call) => ["rustc", "cargo"].includes(call.command))).toBe(false);
    expect(f.calls.some((call) => call.command === "uv" && call.args[0] === "pip" && call.args.includes("hindsight-api-slim[local-onnx,embedded-db]==1.2.1"))).toBe(true);
  });

  it.each([false, true])("uninstalls an incomplete Python environment after dependency installation fails (deleteData=%s)", async (deleteData) => {
    const f = await fixture({ installationFails: true });
    await expect(f.deploy()).rejects.toThrow("uv 操作未完成");
    expect(await f.service.inspect()).toMatchObject({ phase: "failed", running: false });
    await fs.access(path.join(f.root, "venv", "bin", "python"));
    expect(await f.service.uninstall({ commandId: "clean-failed-install", deleteData })).toMatchObject({ installed: false, running: false, phase: "absent" });
    expect(f.calls.some((call) => call.command === path.join(f.root, "venv", "bin", "python"))).toBe(false);
    await expect(fs.access(path.join(f.root, "venv"))).rejects.toThrow();
  });

  it.each(["darwin", "linux"] as const)("stops the registered %s service and database even when its unit file is missing", async (platform) => {
    const f = await fixture({ platform });
    await f.deploy();
    const units = platform === "darwin" ? path.join(f.homeDir, "Library", "LaunchAgents") : path.join(f.homeDir, ".config", "systemd", "user");
    await fs.unlink(path.join(units, (await fs.readdir(units))[0]!));
    const before = f.calls.length;
    await f.service.uninstall({ commandId: "missing-unit", deleteData: true });
    const cleanup = f.calls.slice(before);
    expect(cleanup.some((call) => platform === "darwin" ? call.command === "launchctl" && call.args[0] === "bootout" : call.command === "systemctl" && call.args[1] === "stop")).toBe(true);
    expect(cleanup.some((call) => call.command === path.join(f.root, "venv", "bin", "python") && call.args.includes("--stop-database"))).toBe(true);
  });

  it("waits for official processing before recall and reflect, and replays install without reingesting", async () => {
    const f = await fixture();
    await f.deploy();
    const methods = f.requests.map((request) => `${request.method} ${request.path}`);
    const firstRecall = methods.findIndex((value) => value.endsWith("/memories/recall"));
    expect(methods.slice(0, firstRecall).some((value) => value.includes("GET /v1/default/banks/kulo-shared/operations/"))).toBe(true);
    expect(methods.findIndex((value) => value.endsWith("/reflect"))).toBeGreaterThan(firstRecall);
    expect(methods.some((value) => value.includes("DELETE /v1/default/banks/kulo-shared/documents/"))).toBe(true);
    const installs = f.calls.length;
    await f.deploy();
    expect(f.calls).toHaveLength(installs); expect(f.submissions()).toBe(1);
  });

  it("does not call a service ready when retain is only accepted, and cancels before deleting the probe", async () => {
    const f = await fixture({ pending: true });
    await expect(f.deploy()).rejects.toThrow("提取验证超时");
    expect(await f.service.inspect()).toMatchObject({ phase: "failed" });
    expect(f.requests.some((request) => request.path.endsWith("/memories/recall"))).toBe(false);
    const cleanup = f.requests.filter((request) => request.method === "DELETE");
    expect(cleanup).toHaveLength(2);
    expect(cleanup[0]?.path).toContain("/operations/"); expect(cleanup[1]?.path).toContain("/documents/");
  });

  it("rolls back both private runtime settings and public model after a new model fails", async () => {
    const f = await fixture(); await f.deploy();
    const before = await fs.readFile(path.join(f.root, "runtime.json"), "utf8");
    await expect(f.service.configure({ commandId: "configure-bad", model: { provider: "openai", model: "bad-model", baseUrl: "https://api.example.test/v1" } })).rejects.toThrow("未完成记忆提取");
    expect(await fs.readFile(path.join(f.root, "runtime.json"), "utf8")).toBe(before);
    expect(await f.service.inspect()).toMatchObject({ running: true, phase: "ready", model: { model: "test-model" } });
    await expect(fs.access(path.join(f.root, "configuration-backup.json"))).rejects.toThrow();
    await expect(f.service.configure({ commandId: "origin-change", model: { provider: "openai", model: "test-model", baseUrl: "https://other.example.test/v1" } })).rejects.toThrow("API Key");
    expect(await fs.readFile(path.join(f.root, "runtime.json"), "utf8")).toBe(before);
  });

  it("waits until launchd reports the removed job as absent before bootstrapping configuration and rollback", async () => {
    const f = await fixture({ removalDelay: 3 });
    await f.deploy();
    const before = await fs.readFile(path.join(f.root, "runtime.json"), "utf8");
    const callCount = f.calls.length;
    await expect(f.service.configure({ commandId: "configure-bad", model: { provider: "openai", model: "bad-model", baseUrl: "https://api.example.test/v1" } })).rejects.toThrow("未完成记忆提取");
    expect(await fs.readFile(path.join(f.root, "runtime.json"), "utf8")).toBe(before);
    expect(await f.service.inspect()).toMatchObject({ running: true, phase: "ready", model: { model: "test-model" } });
    const commands = f.calls.slice(callCount).filter((call) => call.command === "launchctl").map((call) => call.args[0]);
    expect(commands).toEqual(["bootout", "print", "print", "print", "print", "bootstrap", "bootout", "print", "print", "print", "print", "bootstrap"]);
  });

  it("does not remove runtime files or bootstrap while a stopped job remains registered", async () => {
    const f = await fixture({ removalNeverCompletes: true });
    await f.deploy();
    const count = f.calls.length;
    await expect(f.service.uninstall({ commandId: "uninstall-pending", deleteData: true })).rejects.toThrow("系统服务尚未停止");
    expect(f.calls.slice(count).some((call) => call.command === "launchctl" && call.args[0] === "bootstrap")).toBe(false);
    await fs.access(path.join(f.root, "runtime.json"));
  });

  it("repairs only an owned failed installation with a newly confirmed deployment", async () => {
    const f = await fixture();
    await expect(f.service.deploy({ commandId: "failed-install", model: { provider: "openai", model: "bad-model" }, apiKey: "test-model-key-0000000000000000000000000" })).rejects.toThrow("未完成记忆提取");
    const runtime = JSON.parse(await fs.readFile(path.join(f.root, "runtime.json"), "utf8"));
    const fixed = await f.service.deploy({ commandId: "confirmed-repair", model: { provider: "openai", model: "fixed-model" }, apiKey: "replacement-model-key-00000000000000000000" });
    expect(fixed).toMatchObject({ phase: "ready", model: { model: "fixed-model" } });
    expect(fixed.routerApiKey).toBe(runtime.env.KULO_HINDSIGHT_ROUTER_API_KEY);
    expect(f.calls.filter((call) => call.command === "uv" && call.args[0] === "venv").every((call) => call.args.includes("--allow-existing"))).toBe(true);
    await expect(f.service.deploy({ commandId: "unrelated-deploy", model: { provider: "ollama", model: "other" } })).rejects.toThrow("已由 Kulo 部署");
  });

  it("reuses a model key across paths or explicit defaults on the same provider origin", async () => {
    const f = await fixture();
    await f.service.deploy({ commandId: "default-origin", model: { provider: "openai", model: "test-model" }, apiKey: "test-model-key-0000000000000000000000000" });
    await expect(f.service.configure({ commandId: "same-origin", model: { provider: "openai", model: "test-model-2", baseUrl: "https://api.openai.com/api/v1" } })).resolves.toMatchObject({ phase: "ready" });
    const runtime = JSON.parse(await fs.readFile(path.join(f.root, "runtime.json"), "utf8"));
    expect(runtime.env.HINDSIGHT_API_LLM_API_KEY).toBe("test-model-key-0000000000000000000000000");
    await expect(f.service.configure({ commandId: "other-origin", model: { provider: "openai", model: "test-model-2", baseUrl: "https://other.example.test/v1" } })).rejects.toThrow("API Key");
  });

  it("retains only owned database data by default, removes runtime credentials, and supports reinstall", async () => {
    const f = await fixture(); const first = await f.deploy();
    await fs.mkdir(path.join(f.root, "home", ".pg0"), { recursive: true });
    await fs.writeFile(path.join(f.root, "home", ".pg0", "memory-data"), "retained");
    expect(await f.service.uninstall({ commandId: "uninstall-1" })).toMatchObject({ installed: false, running: false, phase: "absent" });
    expect(await f.service.inspect()).toMatchObject({ installed: false, running: false, phase: "absent" });
    expect(await fs.readFile(path.join(f.root, "home", ".pg0", "memory-data"), "utf8")).toBe("retained");
    const retained = await fs.readFile(path.join(f.root, "runtime.json"), "utf8");
    expect(retained).not.toContain(first.routerApiKey); expect(retained).not.toContain(first.workerApiKey); expect(retained).not.toContain("test-model-key");
    const second = await f.service.deploy({ commandId: "reinstall", model: { provider: "openai", model: "test-model" }, apiKey: "test-model-key-0000000000000000000000000" });
    expect(second.routerApiKey).not.toBe(first.routerApiKey);
    expect(await fs.readFile(path.join(f.root, "home", ".pg0", "memory-data"), "utf8")).toBe("retained");
    await f.service.uninstall({ commandId: "purge", deleteData: true });
    await expect(fs.access(f.root)).rejects.toThrow();
  });

  it.each([false, true])("reports deletion progress when its ownership manifest is removed first (alreadyAbsent=%s)", async (alreadyAbsent) => {
    const f = await fixture();
    await f.deploy();
    if (alreadyAbsent) await f.service.uninstall({ commandId: "keep-data" });
    const entered = deferred(), release = deferred();
    const remove = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (String(file) === f.root) {
        await fs.unlink(path.join(f.root, "manifest.json"));
        entered.resolve();
        await release.promise;
      }
      return remove(file, options);
    });
    const uninstall = f.service.uninstall({ commandId: "delete-data", deleteData: true });
    await entered.promise;
    try {
      expect(await f.service.inspect()).toMatchObject({ installed: !alreadyAbsent, running: false, phase: alreadyAbsent ? "absent" : "stopped" });
    } finally { release.resolve(); }
    await expect(uninstall).resolves.toMatchObject({ installed: false, running: false, phase: "absent" });
    await expect(f.service.inspect()).resolves.toMatchObject({ installed: false, running: false, phase: "absent" });
    await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, "unrelated-file"), "keep");
    await expect(f.service.inspect()).rejects.toThrow("不是可识别");
  });

  it.each(["manifest.json", "runtime.json"])("handles an already pending %s read when the owned deletion finishes", async (name) => {
    const f = await fixture();
    await f.deploy();
    const entered = deferred(), release = deferred();
    const read = fs.readFile;
    let intercept = true;
    vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (intercept && String(args[0]) === path.join(f.root, name)) {
        intercept = false;
        entered.resolve();
        await release.promise;
      }
      return read(...args);
    }) as typeof fs.readFile);
    const inspection = f.service.inspect();
    await entered.promise;
    try { await f.service.uninstall({ commandId: "delete-during-inspection", deleteData: true }); }
    finally { release.resolve(); }
    await expect(inspection).resolves.toMatchObject({ installed: false, running: false, phase: "absent" });
  });

  it("surfaces a real directory removal failure without reporting successful deletion", async () => {
    const f = await fixture();
    await f.deploy();
    const remove = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (String(file) === f.root) throw Object.assign(new Error("removal denied"), { code: "EACCES" });
      return remove(file, options);
    });
    await expect(f.service.uninstall({ commandId: "failed-delete", deleteData: true })).rejects.toMatchObject({ code: "EACCES" });
    await expect(f.service.inspect()).resolves.toMatchObject({ installed: true, running: false, phase: "stopped" });
    await fs.access(path.join(f.root, "manifest.json"));
  });

  it("refuses unknown directories and symlinks without running a command", async () => {
    const f = await fixture();
    await fs.mkdir(f.root, { recursive: true }); await fs.writeFile(path.join(f.root, "user-file"), "keep");
    await expect(f.deploy()).rejects.toThrow("不是可识别");
    await expect(f.service.uninstall({ commandId: "purge", deleteData: true })).rejects.toThrow("不是可识别");
    expect(await fs.readFile(path.join(f.root, "user-file"), "utf8")).toBe("keep");
    expect(f.calls).toHaveLength(0);
    await fs.rm(f.root, { recursive: true });
    const other = path.join(f.directory, "unrelated"); await fs.mkdir(other); await fs.symlink(other, f.root);
    await expect(f.deploy()).rejects.toThrow("符号链接"); expect(f.calls).toHaveLength(0);
  });

  it("deploys and configures Kulo bridge models alongside custom embedding and rerank providers, clearing secrets on keep-data uninstall", async () => {
    const f = await fixture();
    const connection = await f.service.deploy({
      commandId: "install-kulo-bridge",
      model: { provider: "kulo", connectionId: "api-vertex", model: "gemini-3.8-flash" },
      embeddings: { provider: "openai", model: "text-embedding-3-large", baseUrl: "https://embed.example.test/v1", dimensions: 1536 },
      reranker: { provider: "siliconflow", model: "BAAI/bge-reranker-v2-m3", baseUrl: "https://api.siliconflow.cn/v1" },
      embeddingsApiKey: "embed-secret-0000000000000000000000000",
      rerankerApiKey: "rerank-secret-00000000000000000000000",
    });
    expect(connection.model).toEqual({ provider: "kulo", connectionId: "api-vertex", model: "gemini-3.8-flash" });
    expect(connection.embeddings).toEqual({ provider: "openai", model: "text-embedding-3-large", baseUrl: "https://embed.example.test/v1", dimensions: 1536 });
    expect(connection.reranker).toEqual({ provider: "siliconflow", model: "BAAI/bge-reranker-v2-m3", baseUrl: "https://api.siliconflow.cn/v1" });

    const runtime1 = JSON.parse(await fs.readFile(path.join(f.root, "runtime.json"), "utf8")) as { env: Record<string, string> };
    expect(runtime1.env.HINDSIGHT_API_LLM_PROVIDER).toBe("kulo_hindsight.bridge:KuloBridgeLLM");
    expect(runtime1.env.HINDSIGHT_API_LLM_MODEL).toBe("gemini-3.8-flash");
    expect(runtime1.env.HINDSIGHT_API_LLM_API_KEY).toBe("");
    expect(runtime1.env.KULO_HINDSIGHT_MODEL_PROVIDER_ID).toBe("api-vertex");
    expect(runtime1.env.KULO_HINDSIGHT_BRIDGE_FILE).toMatch(/memory-llm-bridge\.json$/);
    expect(runtime1.env.HINDSIGHT_API_EMBEDDINGS_PROVIDER).toBe("openai");
    expect(runtime1.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL).toBe("text-embedding-3-large");
    expect(runtime1.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS).toBe("1536");
    expect(runtime1.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY).toBe("embed-secret-0000000000000000000000000");
    expect(runtime1.env.HINDSIGHT_API_RERANKER_PROVIDER).toBe("siliconflow");
    expect(runtime1.env.HINDSIGHT_API_RERANKER_SILICONFLOW_API_KEY).toBe("rerank-secret-00000000000000000000000");

    // Reconfiguring to RRF + local ONNX removes stale remote provider env keys cleanly.
    const updated = await f.service.configure({
      commandId: "reconfigure-local-retrieval",
      model: { provider: "kulo", connectionId: "openai-codex", model: "gpt-5.4" },
      embeddings: { provider: "onnx", model: "BAAI/bge-m3", dimensions: 1024 },
      reranker: { provider: "rrf" },
    });
    expect(updated.model).toEqual({ provider: "kulo", connectionId: "openai-codex", model: "gpt-5.4" });
    expect(updated.embeddings).toEqual({ provider: "onnx", model: "BAAI/bge-m3", dimensions: 1024 });
    expect(updated.reranker).toEqual({ provider: "rrf" });
    const runtime2 = JSON.parse(await fs.readFile(path.join(f.root, "runtime.json"), "utf8")) as { env: Record<string, string> };
    expect(runtime2.env.KULO_HINDSIGHT_MODEL_PROVIDER_ID).toBe("openai-codex");
    expect(runtime2.env.HINDSIGHT_API_EMBEDDINGS_PROVIDER).toBe("onnx");
    expect(runtime2.env.HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID).toBe("BAAI/bge-m3");
    expect(runtime2.env.HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS).toBe("1024");
    expect(runtime2.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY).toBeUndefined();
    expect(runtime2.env.HINDSIGHT_API_RERANKER_PROVIDER).toBe("rrf");
    expect(runtime2.env.HINDSIGHT_API_RERANKER_SILICONFLOW_API_KEY).toBeUndefined();

    // Re-add remote keys and confirm uninstall(deleteData: false) scrubs them from retained runtime.json.
    await f.service.configure({
      commandId: "reconfigure-remote-again",
      model: { provider: "kulo", connectionId: "openai-codex", model: "gpt-5.4" },
      embeddings: { provider: "google", model: "gemini-embedding-001" },
      reranker: { provider: "cohere", model: "rerank-multilingual-v3.0" },
      embeddingsApiKey: "gem-embed-secret-00000000000000000000",
      rerankerApiKey: "cohere-rerank-secret-0000000000000000",
    });
    await f.service.uninstall({ commandId: "uninstall-keep", deleteData: false });
    const retained = JSON.parse(await fs.readFile(path.join(f.root, "runtime.json"), "utf8")) as { env: Record<string, string> };
    expect(retained.env.HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY).toBeUndefined();
    expect(retained.env.HINDSIGHT_API_RERANKER_COHERE_API_KEY).toBeUndefined();
  });

  it("augments minimal GUI/launchd PATH with Homebrew, ~/.local/bin, and ~/.cargo/bin for uv while reporting clear ENOENT diagnostics", async () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("CARGO_HOME", "/test-host/custom-cargo");
    const f = await fixture();
    await f.deploy();
    const uvCalls = f.calls.filter((call) => call.command === "uv");
    expect(uvCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of uvCalls) {
      const dirs = (call.env.PATH ?? "").split(":");
      expect(dirs).toContain("/opt/homebrew/bin");
      expect(dirs).toContain("/usr/local/bin");
      expect(dirs).toContain(path.posix.join(f.homeDir, ".local", "bin"));
      expect(dirs).toContain(path.posix.join(f.homeDir, ".cargo", "bin"));
      expect(dirs).toContain("/test-host/custom-cargo/bin");
      expect(dirs).toContain("/usr/bin");
    }
    const plist = await fs.readFile(path.join(f.homeDir, "Library", "LaunchAgents", (await fs.readdir(path.join(f.homeDir, "Library", "LaunchAgents")))[0]!), "utf8");
    expect(plist).not.toContain("/test-host/custom-cargo");

    // Missing uv (ENOENT) produces an actionable installation message instead of a generic failure.
    const missingDir = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-missing-uv-")); directories.push(missingDir);
    const missingService = new HindsightLocalService({
      stateDir: path.join(missingDir, "state"),
      homeDir: path.join(missingDir, "user"),
      platform: "darwin",
      deviceName: "Test Mac",
      run: async () => { throw Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" }); },
    });
    await expect(missingService.deploy({ commandId: "missing-uv", model: { provider: "ollama", model: "llama3.2" } }))
      .rejects.toThrow(/未检测到 uv.*brew install uv/);

    const deniedService = new HindsightLocalService({
      stateDir: path.join(missingDir, "state-eacces"),
      homeDir: path.join(missingDir, "user"),
      platform: "darwin",
      deviceName: "Test Mac",
      run: async () => { throw Object.assign(new Error("spawn uv EACCES"), { code: "EACCES" }); },
    });
    await expect(deniedService.deploy({ commandId: "denied-uv", model: { provider: "ollama", model: "llama3.2" } }))
      .rejects.toThrow(/无法启动 uv.*执行权限/);
  });

  it("discovers executables in augmented user directories and ignores directories sharing the binary name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-host-path-")); directories.push(dir);
    const fakeHome = path.join(dir, "home");
    const firstBin = path.join(dir, "first-bin");
    const localBin = path.join(fakeHome, ".local", "bin");
    await fs.mkdir(path.join(firstBin, "uv"), { recursive: true }); // directory named "uv" must not match
    await fs.mkdir(localBin, { recursive: true });
    const uvExe = path.join(localBin, "uv");
    await fs.writeFile(uvExe, "#!/bin/sh\necho uv 0.99\n", { mode: 0o755 });

    const augmented = buildAugmentedHostPath({ basePath: `${firstBin}:/usr/bin:/bin`, homeDir: fakeHome, platform: "darwin" });
    const segments = augmented.split(":");
    expect(segments.indexOf(firstBin)).toBe(0);
    expect(segments).toContain("/opt/homebrew/bin");
    expect(segments).toContain(localBin);
    expect(segments.indexOf(localBin)).toBeLessThan(segments.indexOf("/usr/bin"));

    expect(findHostExecutable("uv", { basePath: `${firstBin}:/usr/bin:/bin`, homeDir: fakeHome, platform: "darwin" })).toBe(uvExe);
  });
});
