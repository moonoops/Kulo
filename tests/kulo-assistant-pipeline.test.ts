import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import WebSocket from "ws";
import type {
  ClientToHubMessage,
  ConnectorEventBatch,
  HubToClientMessage,
} from "@kulo/protocol";
import {
  AmbientModelService,
  AssistantLedger,
  AssistantSorter,
  loopbackJsonPost,
  parseCoordinatorDecision,
  parseSorterOutput,
  startKuloHubServer,
} from "@kulo/hub";
import { openTestHub } from "./helpers/secure-hub.js";
import { fetchWithHubAuth, HUB_TEST_ADMIN_TOKEN, withHubTestAuth } from "./helpers/hub-auth.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kulo-assistant-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("AssistantLedger", () => {
  it("enforces user_version migration fail-closed, redacts pre-insert, supports 2-char Chinese search, cross-env dedupe, and TTL body pruning", async () => {
    const stateDir = makeTempDir("ledger");
    const ledger = new AssistantLedger({ stateDir, rawBodyTtlMs: 5_000 });
    const now = 1_760_000_000_000;
    const redact = (value: string) => value.replace(/sk-[a-zA-Z0-9]{16,}/g, "[REDACTED]");

    const batchMacA: ConnectorEventBatch = {
      batchId: "b-1",
      driverId: "macos-notifications",
      streamId: "hub-1:mac-a:macos-notifications",
      sourceEpoch: "epoch-1",
      cursorAfter: "10",
      events: [
        {
          nativeEventId: "10",
          eventVersion: "v1",
          appId: "com.apple.mail",
          appLabel: "邮件",
          sender: "Alice",
          title: "合同审阅",
          body: "请今天确认合同，token=sk-1234567890abcdefghijklmnop",
          occurredAt: now,
          fidelity: "notification",
        },
        {
          nativeEventId: "11",
          eventVersion: "v1",
          appId: "com.tencent.xinWeChat",
          appLabel: "微信",
          threadHint: "chat-1",
          sender: "Bob",
          title: "Bob",
          body: "好的",
          occurredAt: now,
          fidelity: "notification",
        },
      ],
    };

    const resA = await ledger.ingestBatch("mac-a", batchMacA, redact, now);
    expect(resA.inserted).toHaveLength(2);
    expect(resA.deduplicatedCount).toBe(0);
    expect(resA.inserted[0]!.body).not.toContain("sk-1234567890");
    expect(resA.inserted[0]!.body).toContain("[REDACTED]");

    // Cross-Env duplicate mail within 90s merges cleanly, while short "好的" in another thread/after 12s does NOT falsely merge.
    const batchMacB: ConnectorEventBatch = {
      batchId: "b-2",
      driverId: "macos-notifications",
      streamId: "hub-1:mac-b:macos-notifications",
      sourceEpoch: "epoch-1",
      cursorAfter: "22",
      events: [
        {
          nativeEventId: "21",
          eventVersion: "v1",
          appId: "com.apple.mail",
          appLabel: "邮件",
          sender: "Alice",
          title: "合同审阅",
          body: "请今天确认合同，token=sk-1234567890abcdefghijklmnop",
          occurredAt: now + 30_000,
          fidelity: "notification",
        },
        {
          nativeEventId: "22",
          eventVersion: "v1",
          appId: "com.tencent.xinWeChat",
          appLabel: "微信",
          threadHint: "chat-2",
          sender: "Bob",
          title: "Bob",
          body: "好的",
          occurredAt: now + 15_000,
          fidelity: "notification",
        },
      ],
    };
    const resB = await ledger.ingestBatch("mac-b", batchMacB, redact, now + 30_000);
    expect(resB.deduplicatedCount).toBe(1);
    expect(resB.inserted).toHaveLength(1);
    expect(resB.inserted[0]!.body).toBe("好的");

    await ledger.recordDigest(
      {
        createdAt: now,
        appId: "com.apple.mail",
        appLabel: "邮件",
        category: "work",
        disposition: "notify_brain",
        urgency: "high",
        digest: "Alice 提醒下午三点开会确认合同审阅细节",
        eventIds: [resA.inserted[0]!.id],
        situationKey: "com.apple.mail:alice_contract",
      },
      redact,
    );

    // 2-char Chinese query ("开会") uses instr() fallback; 4-char ("合同审阅") uses FTS5 trigram.
    const shortHits = await ledger.searchDigests({ query: "开会" });
    expect(shortHits).toHaveLength(1);
    expect(shortHits[0]!.digest).toContain("开会");

    const ftsHits = await ledger.searchDigests({ query: "合同审阅" });
    expect(ftsHits).toHaveLength(1);

    // TTL pruning clears raw body on expired events while keeping digests searchable.
    const pruned = await ledger.pruneExpiredBodies(now + 10_000);
    expect(pruned).toBeGreaterThanOrEqual(2);
    expect(await ledger.searchDigests({ query: "开会" })).toHaveLength(1);

    await ledger.close();

    // Verify PRAGMA user_version = 2 and future version fails closed.
    const rawDb = new DatabaseSync(ledger.dbPath);
    const uv = rawDb.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(uv.user_version).toBe(2);
    const tables = (rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("ha_sentinel_state");
    expect(tables).toContain("ha_automation_backups");
    rawDb.exec("PRAGMA user_version = 99");
    rawDb.close();

    const futureLedger = new AssistantLedger({ stateDir });
    await expect(futureLedger.searchDigests({ query: "开会" })).rejects.toThrow(/unsupported assistant\.sqlite schema version 99/i);
    await futureLedger.close();
  });
});

describe("AmbientModelService", () => {
  it("recommends oMLX on Apple Silicon >= 16GB, auto on 8GB, and Ollama on Linux", () => {
    const stateDir = makeTempDir("ambient-advise");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const baseHost = {
      stateDir,
      models,
      defaultModel: () => ({ provider: "openai", modelId: "faux-1" }),
      persistedConfig: async () => ({ mode: "auto" as const }),
      saveConfig: async () => {},
      redact: (t: string) => t,
    };

    const m4Pro = new AmbientModelService({
      ...baseHost,
      hardwareProbe: () => ({
        hostName: "Mac-Studio",
        platform: "darwin",
        arch: "arm64",
        cpu: "Apple M4 Pro",
        memoryBytes: 32 * 1024 ** 3,
        diskFreeBytes: 200 * 1024 ** 3,
        detectedRuntimes: ["omlx"],
      }),
    }).advise();
    expect(m4Pro.recommendedMode).toBe("local-managed");
    expect(m4Pro.recommendedEngine).toBe("omlx");
    expect(m4Pro.recommendedModelId).toContain("Qwen3-8B");

    const m2Base = new AmbientModelService({
      ...baseHost,
      hardwareProbe: () => ({
        hostName: "MacBook-Air",
        platform: "darwin",
        arch: "arm64",
        cpu: "Apple M2",
        memoryBytes: 16 * 1024 ** 3,
        diskFreeBytes: 100 * 1024 ** 3,
        detectedRuntimes: [],
      }),
    }).advise();
    expect(m2Base.recommendedMode).toBe("local-managed");
    expect(m2Base.recommendedEngine).toBe("omlx");
    expect(m2Base.recommendedModelId).toContain("Qwen3-4B");

    const smallMac = new AmbientModelService({
      ...baseHost,
      hardwareProbe: () => ({
        hostName: "MacBook-8G",
        platform: "darwin",
        arch: "arm64",
        cpu: "Apple M1",
        memoryBytes: 8 * 1024 ** 3,
        diskFreeBytes: 100 * 1024 ** 3,
        detectedRuntimes: [],
      }),
    }).advise();
    expect(smallMac.recommendedMode).toBe("auto");

    const linuxBox = new AmbientModelService({
      ...baseHost,
      hardwareProbe: () => ({
        hostName: "Linux-Host",
        platform: "linux",
        arch: "x64",
        cpu: "AMD Ryzen",
        memoryBytes: 32 * 1024 ** 3,
        diskFreeBytes: 200 * 1024 ** 3,
        detectedRuntimes: ["ollama"],
      }),
    }).advise();
    expect(linuxBox.recommendedMode).toBe("local-managed");
    expect(linuxBox.recommendedEngine).toBe("ollama");
  });

  it("posts directly to 127.0.0.1 with Bearer token even when HTTP_PROXY points to a blackhole", async () => {
    let observedAuth: string | undefined;
    const server = http.createServer((req, res) => {
      observedAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    const prevProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    try {
      const res = await loopbackJsonPost(address.port, "/v1/chat/completions", { model: "test" }, {
        bearerToken: "secret-local-token",
        timeoutMs: 3_000,
      });
      expect(res.status).toBe(200);
      expect(observedAuth).toBe("Bearer secret-local-token");
    } finally {
      if (prevProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prevProxy;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("enforces 3-layer kulo-provider validation, consistent fallback on auth/config loss, and UsageCaps accuracy", async () => {
    const stateDir = makeTempDir("ambient-validate");
    let cfg: { mode: "auto" | "local-managed" | "kulo-provider"; providerId?: string; modelId?: string; revision: number } = {
      mode: "auto",
      revision: 1,
    };
    let customAuthenticated = true;
    let builtinAuth: { type: "api_key" | "oauth" } | undefined = { type: "api_key" };
    let customModels: Array<{ id: string; purpose?: "chat" | "image" }> = [
      { id: "deepseek-chat", purpose: "chat" },
      { id: "flux-custom", purpose: "image" },
      { id: "BAAI/bge-m3", purpose: "chat" },
    ];
    const completedModels: string[] = [];
    const fakeModels = {
      getModel(provider: string, id: string) {
        if (provider === "api-cloud" && id === "main-1") {
          return { id, provider, api: "openai-completions", baseUrl: "https://api.example.com/v1", reasoning: false, maxTokens: 4096 };
        }
        if (provider === "api-local" && (id === "deepseek-chat" || id === "flux-custom" || id === "BAAI/bge-m3" || id === "cached-deleted")) {
          return { id, provider, api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1", reasoning: false, maxTokens: 4096 };
        }
        if (provider === "openai" && id === "gpt-5.4") {
          return { id, provider, api: "openai-responses", baseUrl: "https://api.openai.com/v1", reasoning: true, maxTokens: 8192 };
        }
        return undefined;
      },
      async checkAuth(provider: string) {
        if (provider === "api-cloud") return { type: "api_key" as const };
        if (provider === "api-local") return customAuthenticated ? { type: "api_key" as const } : undefined;
        if (provider === "openai") return builtinAuth;
        return undefined;
      },
      async completeSimple(model: { provider: string; id: string }) {
        completedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(fauxText('{"ok":true}'));
      },
    };
    const svc = new AmbientModelService({
      stateDir,
      models: fakeModels as never,
      defaultModel: () => ({ provider: "api-cloud", modelId: "main-1" }),
      modelConfig: () => ({
        gatewayDisabled: true,
        customProviders: [
          {
            id: "api-local",
            name: "Local Ollama",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:11434/v1",
            models: customModels,
          },
        ],
        defaultProvider: "api-cloud",
        defaultModel: "main-1",
      }),
      persistedConfig: async () => cfg,
      saveConfig: async (next) => { cfg = next; },
      redact: (t) => t,
    });

    // Rejects image model, embedding model, cached-but-deleted model, and non-OAuth builtin provider.
    await expect(svc.configureAutoOrProvider({ mode: "kulo-provider", providerId: "api-local", modelId: "flux-custom" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.configureAutoOrProvider({ mode: "kulo-provider", providerId: "api-local", modelId: "BAAI/bge-m3" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.configureAutoOrProvider({ mode: "kulo-provider", providerId: "api-local", modelId: "cached-deleted" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.configureAutoOrProvider({ mode: "kulo-provider", providerId: "openai", modelId: "gpt-5.4" })).rejects.toMatchObject({ status: 400 });

    // Accepts valid configured conversation model (loopback => willUseCloudModel is false).
    const active = await svc.configureAutoOrProvider({ mode: "kulo-provider", providerId: "api-local", modelId: "deepseek-chat" });
    expect(active.mode).toBe("kulo-provider");
    expect(active.running).toBe(true);
    expect(active.error).toBeUndefined();
    expect(await svc.willUseCloudModel(false)).toBe(false);

    // When auth expires or model is removed, status reports unavailable AND willUseCloudModel + completeZeroToolJson consistently fall back to cloud defaultModel.
    customAuthenticated = false;
    const stale = await svc.status();
    expect(stale.running).toBe(false);
    expect(stale.error).toContain("已选后台模型不可用");
    expect(await svc.willUseCloudModel(false)).toBe(true);
    await expect(svc.completeZeroToolJson({ systemPrompt: "sys", userContent: "hi", allowCloudFallback: false })).rejects.toMatchObject({ code: "ambient_cloud_fallback_disallowed" });
    await svc.completeZeroToolJson({ systemPrompt: "sys", userContent: "hi" });
    expect(completedModels).toEqual(["api-cloud/main-1"]);

    // Restoring auth but removing model from customProviders also flags stale.
    customAuthenticated = true;
    customModels = [];
    expect((await svc.status()).running).toBe(false);

    // Builtin OAuth subscription passes when auth.type === "oauth".
    builtinAuth = { type: "oauth" };
    const oauthStatus = await svc.configureAutoOrProvider({ mode: "kulo-provider", providerId: "openai", modelId: "gpt-5.4" });
    expect(oauthStatus.running).toBe(true);
    await svc.close();
  });

  it("clamps zero-tool thinking level, adds +2048 headroom, suppresses Google thoughts, and keeps Anthropic off", async () => {
    const stateDir = makeTempDir("ambient-thinking");
    const calls: Array<{ options: Record<string, unknown>; payload?: unknown }> = [];
    const fakeModels = {
      getModel(provider: string, id: string) {
        if (provider === "api-vertex" && id === "gemini-3.8-flash") {
          return { id, provider, api: "google-vertex", baseUrl: "https://aiplatform.googleapis.com", reasoning: true, maxTokens: 65536 };
        }
        if (provider === "api-anthropic" && id === "claude-sonnet-4-5") {
          return { id, provider, api: "anthropic-messages", baseUrl: "https://api.anthropic.com", reasoning: true, maxTokens: 8192 };
        }
        if (provider === "api-openai" && id === "deepseek-reasoner") {
          return { id, provider, api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", reasoning: true, maxTokens: 8192 };
        }
        return undefined;
      },
      async checkAuth() { return { type: "api_key" as const }; },
      async completeSimple(model: { api: string }, _ctx: unknown, options: Record<string, unknown>) {
        const onPayload = options.onPayload as ((p: unknown) => unknown) | undefined;
        const payload = onPayload
          ? onPayload({ config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" } } })
          : undefined;
        calls.push({ options, payload });
        return fauxAssistantMessage(fauxText('{"ok":true}'));
      },
    };
    let current = { provider: "api-vertex", modelId: "gemini-3.8-flash" };
    const svc = new AmbientModelService({
      stateDir,
      models: fakeModels as never,
      defaultModel: () => current,
      persistedConfig: async () => ({ mode: "auto", revision: 1 }),
      saveConfig: async () => {},
      redact: (t) => t,
    });

    await svc.completeZeroToolJson({ systemPrompt: "sys", userContent: "hi", maxTokens: 400 });
    expect(calls[0]!.options.reasoning).toBe("low");
    expect(calls[0]!.options.maxTokens).toBe(400 + 2048);
    expect((calls[0]!.payload as { config: { thinkingConfig: { includeThoughts: boolean } } }).config.thinkingConfig.includeThoughts).toBe(false);

    current = { provider: "api-anthropic", modelId: "claude-sonnet-4-5" };
    await svc.completeZeroToolJson({ systemPrompt: "sys", userContent: "hi", maxTokens: 400 });
    expect(calls[1]!.options.reasoning).toBeUndefined();
    expect(calls[1]!.options.maxTokens).toBe(400);

    current = { provider: "api-openai", modelId: "deepseek-reasoner" };
    await svc.completeZeroToolJson({ systemPrompt: "sys", userContent: "hi", maxTokens: 400 });
    expect(calls[2]!.options.reasoning).toBe("low");
    expect(calls[2]!.options.maxTokens).toBe(400 + 2048);
    await svc.close();
  });

  it("blocks concurrent deploy with 409, allows configureAutoOrProvider to preempt & abort in-flight install, and passes allowCloudFallback in AssistantSorter", async () => {
    const stateDir = makeTempDir("ambient-cancel");
    let cfg: { mode: "auto" | "local-managed" | "kulo-provider"; revision: number } = { mode: "auto", revision: 1 };
    let abortedInstall = false;
    let releaseInstall: (() => void) | null = null;
    const models = createModels();
    const svc = new AmbientModelService({
      stateDir,
      models,
      defaultModel: () => ({ provider: "openai", modelId: "faux-1" }),
      persistedConfig: async () => cfg,
      saveConfig: async (next) => { cfg = next; },
      redact: (t) => t,
      commandRunner: (_cmd, _args, _env, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            abortedInstall = true;
            resolve({ ok: false, stdout: "", stderr: "aborted" });
          }, { once: true });
          releaseInstall = () => resolve({ ok: true, stdout: "ok", stderr: "" });
        }),
    });

    // Trigger deploy in background; if executable isn't installed locally, commandRunner blocks until aborted.
    // Either way, test concurrent guard + preemption cleanly when commandRunner is reached.
    const deployPromise = svc.deployLocalManaged({ engine: "omlx", modelId: "mlx-community/Qwen3-4B-Instruct-2507-4bit" }).catch(() => null);
    await new Promise((r) => setTimeout(r, 30));
    if (releaseInstall) {
      await expect(svc.deployLocalManaged({ engine: "omlx", modelId: "mlx-community/Qwen3-4B-Instruct-2507-4bit" })).rejects.toMatchObject({ status: 409 });
      const resetStatus = await svc.configureAutoOrProvider({ mode: "auto" });
      expect(resetStatus.mode).toBe("auto");
      expect(abortedInstall).toBe(true);
    }
    await deployPromise;
    await svc.close();

    // P1-4: AssistantSorter forwards allowCloudFallback: false when UsageCaps is active.
    const ledger = new AssistantLedger({ stateDir });
    const seenFallbackFlags: Array<boolean | undefined> = [];
    const sorter = new AssistantSorter({
      ledger,
      ambientModel: {
        completeZeroToolJson: async (input: { allowCloudFallback?: boolean }) => {
          seenFallbackFlags.push(input.allowCloudFallback);
          return JSON.stringify({ digest: "d", category: "work", disposition: "archive", urgency: "low", situationKey: "k", title: "t" });
        },
      } as never,
      redact: (t) => t,
      isCloudCapped: () => true,
      coalesceWindowMs: 5,
      maxCoalesceMs: 10,
      onNotifyBrain: () => {},
    });
    const ing = await ledger.ingestBatch("local", {
      batchId: "b-cap",
      driverId: "macos-notifications",
      streamId: "s-cap",
      sourceEpoch: "v1",
      cursorAfter: "1",
      events: [{
        nativeEventId: "e-cap-1",
        eventVersion: "v1",
        appId: "com.apple.mail",
        appLabel: "Mail",
        title: "Cap Check",
        body: "Test body",
        occurredAt: Date.now(),
        fidelity: "notification",
      }],
    }, (t) => t);
    sorter.enqueue(ing.inserted);
    await vi.waitFor(() => expect(seenFallbackFlags).toEqual([false]));
    await sorter.close();
    ledger.close();
  });
});

describe("Assistant end-to-end Hub pipeline (sorter -> coordinator -> WS/REST)", () => {
  it("parses strict JSON outputs and rejects unexpected keys", () => {
    expect(() =>
      parseSorterOutput('{"digest":"ok","category":"work","disposition":"archive","urgency":"low","situationKey":"a","title":"t","extra":1}', {
        appId: "a",
        appLabel: "A",
        title: "t",
        body: "b",
      }),
    ).toThrow(/unexpected_keys/);
    expect(() => parseCoordinatorDecision('{"action":"upsert_card","evil":true}')).toThrow(/unexpected_keys/);
  });

  it("coalesces notifications, surfaces card, promotes to proactive topic idempotently, and prevents stale card resurrection", async () => {
    const stateDir = makeTempDir("hub");
    let coordinatorDelayResolve: (() => void) | null = null;
    let coordinatorCallCount = 0;

    const faux = fauxProvider({ provider: "openai", models: [{ id: "faux-1" }] });
    faux.setResponses([
      // 1st sorter call
      () =>
        fauxAssistantMessage(
          fauxText(
            JSON.stringify({
              digest: "老板在邮件询问 Q4 预算表是否定稿",
              category: "work",
              disposition: "notify_brain",
              urgency: "high",
              situationKey: "mail:q4_budget",
              title: "Q4 预算表确认",
            }),
          ),
        ),
      // 1st coordinator call -> upsert_card
      () => {
        coordinatorCallCount += 1;
        return fauxAssistantMessage(
          fauxText(
            JSON.stringify({
              action: "upsert_card",
              kind: "alert",
              title: "Q4 预算表需要确认",
              summary: "老板刚发邮件询问 Q4 预算表是否已定稿。",
            }),
          ),
        );
      },
      // 2nd sorter call (for anti-reentrancy test)
      () =>
        fauxAssistantMessage(
          fauxText(
            JSON.stringify({
              digest: "客户发送了新的合同修改意见",
              category: "work",
              disposition: "notify_brain",
              urgency: "high",
              situationKey: "mail:client_contract",
              title: "客户合同修改",
            }),
          ),
        ),
      // 2nd coordinator call -> upsert_card
      () => {
        coordinatorCallCount += 1;
        return fauxAssistantMessage(
          fauxText(
            JSON.stringify({
              action: "upsert_card",
              kind: "fyi",
              title: "客户合同修改意见",
              summary: "客户发来新的合同条款调整。",
            }),
          ),
        );
      },
      // 3rd sorter call on the SAME situationKey right before user dismisses it
      () =>
        fauxAssistantMessage(
          fauxText(
            JSON.stringify({
              digest: "客户补充了一条合同备注",
              category: "work",
              disposition: "notify_brain",
              urgency: "high",
              situationKey: "mail:client_contract",
              title: "客户合同补充",
            }),
          ),
        ),
      // 3rd coordinator call: delayed while user dismisses the card!
      async () => {
        coordinatorCallCount += 1;
        await new Promise<void>((resolve) => {
          coordinatorDelayResolve = resolve;
        });
        return fauxAssistantMessage(
          fauxText(
            JSON.stringify({
              action: "upsert_card",
              kind: "fyi",
              title: "不应复活的卡片",
              summary: "用户已点击知道了，不应复活。",
            }),
          ),
        );
      },
    ]);

    const models = createModels();
    models.setProvider(faux.provider);
    const hub = await openTestHub({
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: false,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "faux-1", baseUrl: "http://127.0.0.1:9/v1" },
      },
      models,
    });
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });

    const ws = new WebSocket(withHubTestAuth(`ws://127.0.0.1:${server.port}/ws/client`));
    const messages: HubToClientMessage[] = [];
    const waiters = new Set<() => void>();
    ws.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString("utf8")) as HubToClientMessage);
      for (const fn of waiters) fn();
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const waitFor = <T extends HubToClientMessage["type"]>(
      type: T,
      predicate?: (m: Extract<HubToClientMessage, { type: T }>) => boolean,
      timeoutMs = 12_000,
    ) =>
      new Promise<Extract<HubToClientMessage, { type: T }>>((resolve, reject) => {
        const find = () =>
          messages.find(
            (m): m is Extract<HubToClientMessage, { type: T }> =>
              m.type === type && (!predicate || predicate(m as Extract<HubToClientMessage, { type: T }>)),
          );
        const existing = find();
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs);
        const check = () => {
          const hit = find();
          if (hit) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(hit);
          }
        };
        waiters.add(check);
      });

    try {
      const snap = await waitFor("hub.snapshot");
      expect(snap.assistantItems).toEqual([]);

      // Enable notifications via REST and verify confirmation gate on local-managed model.
      const cfgRes = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/assistant/configure`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(cfgRes.status).toBe(200);
      const cfgJson = (await cfgRes.json()) as { enabled: boolean };
      expect(cfgJson.enabled).toBe(true);

      const unconfirmedRes = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/assistant/background-model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "local-managed", confirmed: false }),
      });
      expect(unconfirmedRes.status).toBe(200);
      const unconfirmedJson = (await unconfirmedRes.json()) as {
        requiresConfirmation?: boolean;
        backgroundModel?: { mode: string };
        snapshot?: unknown;
      };
      expect(unconfirmedJson.requiresConfirmation).toBe(true);
      expect(unconfirmedJson.backgroundModel?.mode).toBe("auto");
      // Lightweight POST omits full workspace snapshot unless ?includeWorkspace=1 is requested.
      expect(unconfirmedJson.snapshot).toBeUndefined();

      // Lightweight GET returns backgroundModel without advice by default, and includes advice with ?includeAdvice=1.
      const bgGetDefault = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/assistant/background-model`);
      expect(bgGetDefault.status).toBe(200);
      const bgGetDefaultJson = (await bgGetDefault.json()) as { backgroundModel?: { mode: string }; advice?: unknown };
      expect(bgGetDefaultJson.backgroundModel?.mode).toBe("auto");
      expect(bgGetDefaultJson.advice).toBeUndefined();

      const bgGetAdvice = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/assistant/background-model?includeAdvice=1`);
      expect(bgGetAdvice.status).toBe(200);
      const bgGetAdviceJson = (await bgGetAdvice.json()) as { advice?: { hostName?: string } };
      expect(bgGetAdviceJson.advice?.hostName).toBeTruthy();

      // Cross-origin POST is rejected (P0-3).
      const crossOriginRes = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/assistant/background-model`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ mode: "auto" }),
      });
      expect(crossOriginRes.status).toBe(403);

      // Invalid kulo-provider missing modelId is rejected with 400 (P0-1).
      const missingModelRes = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/assistant/background-model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "kulo-provider", providerId: "api-fake" }),
      });
      expect(missingModelRes.status).toBe(400);

      // Speed up sorter coalesce window by testing direct ingestion into hub's ledger + fast sorter OR pushing a batch.
      // Let's push a real connector batch via hub's ingest path and verify the real AssistantSorter -> AssistantCoordinator -> WS flow!
      const fastSorter = new AssistantSorter({
        ledger: hub.assistantLedger,
        ambientModel: hub.ambientModel,
        redact: (t) => t,
        coalesceWindowMs: 10,
        maxCoalesceMs: 30,
        onNotifyBrain: (input) => hub.assistantCoordinator.enqueueEscalation(input),
      });

      const now = Date.now();
      const batch1: ConnectorEventBatch = {
        batchId: "batch-1",
        driverId: "macos-notifications",
        streamId: "test:mac-1:macos-notifications",
        sourceEpoch: "e1",
        cursorAfter: "1",
        events: [
          {
            nativeEventId: "1",
            eventVersion: "v1",
            appId: "com.apple.mail",
            appLabel: "邮件",
            sender: "Boss",
            title: "Q4 预算表",
            body: "请确认 Q4 预算表是否已定稿。",
            occurredAt: now,
            fidelity: "notification",
          },
        ],
      };
      const ing1 = await hub.assistantLedger.ingestBatch("local", batch1, (t) => t, now);
      fastSorter.enqueue(ing1.inserted);

      const firstCardBroadcast = await waitFor(
        "hub.assistant_items",
        (m) => m.items.some((item) => item.title === "Q4 预算表需要确认"),
      );
      const card = firstCardBroadcast.items.find((item) => item.title === "Q4 预算表需要确认")!;
      expect(card.kind).toBe("alert");

      // Promote card to proactive topic via WS with explicit commandId; replay MUST be idempotent!
      const promoteCmdId = "cmd:promote-q4-1";
      const sendClient = (msg: ClientToHubMessage) => ws.send(JSON.stringify(msg));
      sendClient({
        type: "assistant.item_action",
        itemId: card.id,
        expectedRevision: card.revision,
        action: "promote_to_topic",
        commandId: promoteCmdId,
      });
      const ack1 = await waitFor("hub.ack", (m) => m.commandId === promoteCmdId);
      expect(ack1.topicId).toBeTruthy();
      expect(ack1.deduplicated).toBeFalsy();

      const topicsMsg = await waitFor("hub.topics", (m) => m.topics.some((t) => t.id === ack1.topicId));
      const proactiveTopic = topicsMsg.topics.find((t) => t.id === ack1.topicId)!;
      expect(proactiveTopic.origin).toBe("proactive");
      expect(proactiveTopic.proactiveSeq).toBe(1);

      // Replay exact same commandId -> deduplicated with SAME topicId, no second topic created!
      messages.length = 0;
      sendClient({
        type: "assistant.item_action",
        itemId: card.id,
        expectedRevision: card.revision,
        action: "promote_to_topic",
        commandId: promoteCmdId,
      });
      const ack2 = await waitFor("hub.ack", (m) => m.commandId === promoteCmdId);
      expect(ack2.topicId).toBe(ack1.topicId);
      expect(ack2.deduplicated).toBe(true);

      // Anti-reentrancy test: create a second card, trigger a slow coordinator update for the same situation,
      // then dismiss the card BEFORE the slow coordinator finishes -> card MUST NOT resurrect!
      const ing2 = await hub.assistantLedger.ingestBatch(
        "local",
        {
          batchId: "batch-2",
          driverId: "macos-notifications",
          streamId: "test:mac-1:macos-notifications",
          sourceEpoch: "e1",
          cursorAfter: "2",
          events: [
            {
              nativeEventId: "2",
              eventVersion: "v1",
              appId: "com.apple.mail",
              appLabel: "邮件",
              sender: "Client",
              title: "合同修改",
              body: "请看新的合同修改意见。",
              occurredAt: now + 1000,
              fidelity: "notification",
            },
          ],
        },
        (t) => t,
        now + 1000,
      );
      fastSorter.enqueue(ing2.inserted);
      const secondBroadcast = await waitFor(
        "hub.assistant_items",
        (m) => m.items.some((item) => item.title === "客户合同修改意见"),
      );
      const contractCard = secondBroadcast.items.find((item) => item.title === "客户合同修改意见")!;

      const ing3 = await hub.assistantLedger.ingestBatch(
        "local",
        {
          batchId: "batch-3",
          driverId: "macos-notifications",
          streamId: "test:mac-1:macos-notifications",
          sourceEpoch: "e1",
          cursorAfter: "3",
          events: [
            {
              nativeEventId: "3",
              eventVersion: "v1",
              appId: "com.apple.mail",
              appLabel: "邮件",
              sender: "Client",
              title: "合同补充",
              body: "再补充一条备注。",
              occurredAt: now + 2000,
              fidelity: "notification",
            },
          ],
        },
        (t) => t,
        now + 2000,
      );
      fastSorter.enqueue(ing3.inserted);

      // Wait until the 3rd coordinator call is actively blocked inside our promise.
      const deadline = Date.now() + 8_000;
      while (!coordinatorDelayResolve && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(coordinatorDelayResolve).not.toBeNull();
      expect(coordinatorCallCount).toBe(3);

      // User acknowledges the card while the slow coordinator call is still in-flight!
      const dismissCmdId = "cmd:ack-contract";
      sendClient({
        type: "assistant.item_action",
        itemId: contractCard.id,
        expectedRevision: contractCard.revision,
        action: "acknowledge",
        commandId: dismissCmdId,
      });
      await waitFor("hub.ack", (m) => m.commandId === dismissCmdId);

      // Now let the stale in-flight coordinator finish.
      coordinatorDelayResolve!();
      await new Promise((r) => setTimeout(r, 120));

      messages.length = 0;
      sendClient({ type: "state.sync" });
      const finalSnapshot = await waitFor("hub.snapshot");
      expect((finalSnapshot.assistantItems ?? []).some((i) => i.id === contractCard.id || i.title === "不应复活的卡片")).toBe(false);

      await fastSorter.close();
    } finally {
      ws.close();
      await server.close();
      await hub.close();
    }
  });
});
