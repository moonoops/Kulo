import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  isAllowedPrivateModelIp,
  isPrivateLocalModelEndpoint,
  supportsKeylessLocalModel,
  unwrapIpv4MappedIpv6,
} from "@kulo/protocol";
import {
  assertResolvedLocalModelEndpoint,
  LOCAL_KEYLESS_SYNTHETIC_API_KEY,
} from "../packages/hub/src/local-model-endpoint.js";
import { modelFetch, retainEnvironmentProxy } from "../packages/hub/src/http-transport.js";
import { fetchLiveProviderModels } from "../packages/hub/src/provider-discovery.js";
import { isLoopbackBaseUrl } from "../packages/hub/src/usage-caps.js";
import { KuloProviderManager } from "../packages/hub/src/providers.js";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { applySettingsBlockUpdate, hydrateSettingsFromConfig, KuloSettingsDoc } from "../packages/hub/src/settings.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function listenLocal(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

describe("Private/local keyless model endpoint allowlist & DNS defense", () => {
  it("normalizes dotted and WHATWG hex IPv4-mapped IPv6 literals and enforces strict positive IP/hostname allowlist", () => {
    expect(unwrapIpv4MappedIpv6("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(unwrapIpv4MappedIpv6("[::ffff:7f00:1]")).toBe("127.0.0.1");
    expect(unwrapIpv4MappedIpv6("[::ffff:c0a8:132]")).toBe("192.168.1.50");

    for (const allowed of [
      "http://127.0.0.1:11434/v1",
      "http://[::1]:8000/v1",
      "http://[::ffff:127.0.0.1]:8000/v1",
      "http://192.168.1.50:8000/v1",
      "http://192.168.1.5:8080/v1",
      "http://172.16.0.9:8000/v1",
      "http://100.64.0.10:8000/v1",
      "http://[fd00::1]:8000/v1",
      "http://localhost:11434/v1",
      "http://sub.localhost:11434/v1",
      "http://localstation.local:8000/v1",
      "http://localstation.lan:8000/v1",
      "http://localstation:8000/v1",
    ]) {
      expect(isPrivateLocalModelEndpoint(allowed), allowed).toBe(true);
      expect(supportsKeylessLocalModel(allowed, "openai-completions"), allowed).toBe(true);
      expect(supportsKeylessLocalModel(allowed, "openai-responses"), allowed).toBe(true);
      expect(supportsKeylessLocalModel(allowed, "anthropic-messages"), allowed).toBe(false);
    }

    for (const blocked of [
      "https://api.openai.com/v1",
      "http://8.8.8.8:8000/v1",
      "http://metadata.google.internal/computeMetadata/v1",
      "http://instance-data.ec2.internal/latest/meta-data",
      "http://kubernetes.default.svc.cluster.local/api",
      "http://metadata/v1",
      "http://wpad/wpad.dat",
      "http://kubernetes/api",
      "http://169.254.169.254/latest/meta-data",
      "http://100.100.100.200/latest/meta-data",
      "http://0.0.0.0:8000/v1",
      "http://[::]:8000/v1",
      "http://[fe80::1]:8000/v1",
      "http://224.0.0.1:8000/v1",
      "http://255.255.255.255:8000/v1",
      "http://user:pass@192.168.1.50:8000/v1",
      "http://192.168.1.50:8000/v1?foo=bar",
      "ftp://192.168.1.50:8000/v1",
    ]) {
      expect(isPrivateLocalModelEndpoint(blocked), blocked).toBe(false);
      expect(supportsKeylessLocalModel(blocked, "openai-completions"), blocked).toBe(false);
    }

    expect(isAllowedPrivateModelIp("100.100.100.200")).toBe(false);
    expect(isAllowedPrivateModelIp("100.64.0.10")).toBe(true);
    expect(isLoopbackBaseUrl("http://192.168.1.50:8000/v1")).toBe(true);
    expect(isLoopbackBaseUrl("http://100.64.0.10:8000/v1")).toBe(true);
    expect(isLoopbackBaseUrl("http://169.254.169.254/v1")).toBe(false);
    expect(isLoopbackBaseUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("blocks DNS rebinding on local hostnames resolving to public or metadata IPs", async () => {
    await expect(
      assertResolvedLocalModelEndpoint("http://localstation.local:8000/v1", async () => [{ address: "192.168.1.50" }]),
    ).resolves.toBeUndefined();
    await expect(
      assertResolvedLocalModelEndpoint("http://localstation.local:8000/v1", async () => [{ address: "169.254.169.254" }]),
    ).rejects.toThrow(/非私有局域网|受保护/);
    await expect(
      assertResolvedLocalModelEndpoint("http://localstation.local:8000/v1", async () => [
        { address: "192.168.1.50" },
        { address: "1.1.1.1" },
      ]),
    ).rejects.toThrow(/非私有局域网|受保护/);
    await expect(
      assertResolvedLocalModelEndpoint("https://api.openai.com/v1"),
    ).rejects.toThrow(/私有局域网/);
  });
});

describe("Local model transport proxy bypass & keyless provider auth", () => {
  it("bypasses HTTP_PROXY for self-hosted local endpoints in modelFetch and fetchLiveProviderModels", async () => {
    const localOrigin = await listenLocal((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "inkling-4bit" }] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    let proxyHits = 0;
    const proxyOrigin = await listenLocal((_req, res) => {
      proxyHits++;
      res.writeHead(502);
      res.end("proxy should not be hit");
    });
    vi.stubEnv("HTTP_PROXY", proxyOrigin);
    vi.stubEnv("HTTPS_PROXY", proxyOrigin);
    vi.stubEnv("NO_PROXY", "");
    const release = retainEnvironmentProxy();
    cleanups.push(release);

    const fetchRes = await modelFetch(`${localOrigin}/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(await fetchRes.json()).toEqual({ ok: true });
    const discovered = await fetchLiveProviderModels({ api: "openai-completions", baseUrl: `${localOrigin}/v1`, signal: AbortSignal.timeout(5_000) });
    expect(discovered.map((m) => m.id)).toEqual(["inkling-4bit"]);
    expect(proxyHits).toBe(0);
  });

  it("authenticates keyless private custom providers without storing credentials and prioritizes real saved keys", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-keyless-prov-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    const savedCreds = new Map<string, { type: "api_key"; key: string; env?: Record<string, string> }>();
    const credentialStore = {
      read: async (id: string) => savedCreds.get(id),
      write: async (id: string, cred: { type: "api_key"; key: string; env?: Record<string, string> }) => { savedCreds.set(id, cred); },
      modify: async (id: string, fn: (cur: { type: "api_key"; key: string; env?: Record<string, string> } | undefined) => Promise<{ type: "api_key"; key: string; env?: Record<string, string> } | undefined>) => {
        const next = await fn(savedCreds.get(id));
        if (next) savedCreds.set(id, next);
        else savedCreds.delete(id);
      },
      delete: async (id: string) => { savedCreds.delete(id); },
      list: async () => [...savedCreds.keys()],
    };

    const manager = new KuloProviderManager({ stateDir, credentials: credentialStore as never });
    manager.syncProviders(
      {
        baseUrl: "https://api.openai.com/v1",
        apiMode: "openai-completions",
        defaultModel: "",
        thinkingLevel: "off",
        customProviders: [
          {
            id: "api-localstation",
            name: "LocalStation",
            api: "openai-completions",
            baseUrl: "http://192.168.1.50:8000/v1",
            authMode: "none",
            models: [{ id: "inkling-4bit" }],
          },
        ],
      },
      {},
    );

    const catalog = await manager.listCatalog();
    const item = catalog.find((p) => p.id === "api-localstation");
    expect(item?.authenticated).toBe(true);
    expect(savedCreds.size).toBe(0);

    const provider = manager.models.getProvider("api-localstation")!;
    const keylessResolved = await provider.auth.apiKey!.resolve({ ctx: {} as never, credential: undefined });
    expect(keylessResolved?.auth.apiKey).toBe(LOCAL_KEYLESS_SYNTHETIC_API_KEY);

    // Once a real origin-bound key is saved, it takes precedence over keyless fallback.
    const realCred = { type: "api_key" as const, key: "sk-real-lan-key", env: { KULO_API_KEY_ORIGIN: "http://192.168.1.50:8000" } };
    const realResolved = await provider.auth.apiKey!.resolve({ ctx: {} as never, credential: realCred });
    expect(realResolved?.auth.apiKey).toBe("sk-real-lan-key");

    // Public URL with authMode: "none" is strictly rejected by sanitizeCustomProviders.
    const doc = KuloSettingsDoc.definition.initial();
    hydrateSettingsFromConfig(doc, resolveHubConfig({ stateDir, identityDir: path.join(stateDir, "identity") }));
    expect(() =>
      applySettingsBlockUpdate(doc, "model", doc.revisions.model, {
        ...doc.model,
        customProviders: [
          {
            id: "api-public-keyless",
            name: "Public",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            authMode: "none",
            models: [{ id: "gpt-4o" }],
          },
        ],
      }),
    ).toThrow(/免密模式/);
  });
});

describe("End-to-end kulo_local_model_register & keyless ModelConfigurationCard", () => {
  it("registers a live local OpenAI server from Main Chat, filters non-chat models, syncs revisions, and protects unsaved models form", async () => {
    const localOrigin = await listenLocal((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({
          data: [
            { id: "inkling-4bit" },
            { id: "text-embedding-3-small" },
            { id: "whisper-large-v3" },
          ],
        }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.end(JSON.stringify({
          id: "cmpl-1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-local-reg-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    let step = 0;
    const toolResults: Array<{ name: string; isError: boolean; text: string }> = [];
    const provider = fauxProvider({ provider: "local-reg-test", models: [{ id: "main-model", reasoning: true }] });
    provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "读取一下现在的模型和设备设置", limit: 3 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("kulo_settings_read", {})], { stopReason: "toolUse" }),
      (req: TranscriptContext) => {
        step++;
        const toolNames = (req.tools ?? []).map((t) => t.name);
        for (const m of req.messages) {
          if (m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded)) {
            toolNames.push(...m.toolsAdded.map((t) => t.name));
          }
        }
        expect(toolNames).toContain("kulo_local_model_register");
        return fauxAssistantMessage([
          fauxToolCall("kulo_local_model_register", {
            name: "LocalStation",
            base_url: `${localOrigin}/v1`,
            verify_model_id: "inkling-4bit",
          }),
        ], { stopReason: "toolUse" });
      },
      (req: TranscriptContext) => {
        for (const m of req.messages) {
          if (m.role === "toolResult") {
            const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
            toolResults.push({ name: m.toolName, isError: Boolean(m.isError), text });
          }
        }
        // Immediately follow up with kulo_settings_update(block="model") to prove mainObservedRevisions.model synced!
        return fauxAssistantMessage([
          fauxToolCall("kulo_settings_update", {
            block: "model",
            changes: JSON.stringify({ thinkingLevel: "medium" }),
            title: "调整思考强度",
          }),
        ], { stopReason: "toolUse" });
      },
      (req: TranscriptContext) => {
        const last = [...req.messages].reverse().find((m) => m.role === "toolResult");
        if (last && last.role === "toolResult") {
          const text = last.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
          toolResults.push({ name: last.toolName, isError: Boolean(last.isError), text });
        }
        return fauxAssistantMessage([fauxText("已注册 LocalStation 并调整思考强度。")]);
      },
    ]);
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "local-reg-test",
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "local-reg-test", defaultModel: "main-model", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub.close());

    // Wire real KuloProviderManager discovery/metadata onto test hub (openTestHub with custom `models` omits #providerManager).
    const realProviderManager = new KuloProviderManager({
      stateDir,
      credentials: { read: async () => undefined, write: async () => {}, modify: async () => {}, delete: async () => {}, list: async () => [] } as never,
    });
    vi.spyOn(hub, "discoverProviderModels").mockImplementation((req) => realProviderManager.discoverModels(req));
    vi.spyOn(hub, "resolveModelMetadata").mockImplementation((req) => realProviderManager.resolveModelMetadata(req));

    const sub = await hub.sendUserMessage("帮我把本地 LocalStation 模型接进来");
    await sub.wait(BACKGROUND_CONTEXT);

    expect(step).toBe(1);
    const regResult = toolResults.find((r) => r.name === "kulo_local_model_register");
    expect(regResult?.isError).toBe(false);
    const parsedReg = JSON.parse(regResult!.text);
    expect(parsedReg).toMatchObject({
      name: "LocalStation",
      authMode: "none",
      modelIds: ["inkling-4bit"],
      discoveredCount: 1,
      verification: { modelId: "inkling-4bit", ok: true },
    });

    // Follow-up kulo_settings_update must succeed without 409 revision mismatch
    const updateResult = toolResults.find((r) => r.name === "kulo_settings_update");
    expect(updateResult?.isError).toBe(false);

    // LOCAL_KEYLESS_SYNTHETIC_API_KEY must NEVER be registered into connectionManager.redact()
    expect(hub.connectionManager.redact(LOCAL_KEYLESS_SYNTHETIC_API_KEY)).toBe(LOCAL_KEYLESS_SYNTHETIC_API_KEY);

    // Re-registering same origin merges idempotently without creating a duplicate provider
    const second = await hub.modelConfiguration.registerLocalProvider({
      name: "LocalStation Renamed",
      baseUrl: `${localOrigin}/v1`,
      commandId: "cmd-idempotent-2",
    });
    expect(second.providerId).toBe(parsedReg.providerId);
    expect(hub.getSettingsView().blocks.model.value.customProviders).toHaveLength(1);

    // Active models page with unsaved changes blocks registerLocalModel
    hub.settingsAssistant.updateContext({
      clientId: "win-unsaved",
      module: "models",
      active: true,
      hasUnsavedChanges: true,
      appearance: "dark",
    });
    await expect(
      hub.settingsAssistant.registerLocalModel({
        name: "Blocked",
        baseUrl: `${localOrigin}/v1`,
        commandId: "cmd-blocked-unsaved",
      }),
    ).rejects.toThrow(/尚未保存/);

    // Public URL is rejected
    await expect(
      hub.modelConfiguration.registerLocalProvider({
        name: "Public",
        baseUrl: "https://api.openai.com/v1",
        commandId: "cmd-public-rejected",
      }),
    ).rejects.toThrow(/私有局域网/);

    // Explicit provider_id cannot overwrite a cloud/preset custom provider
    const currentModelBlock = hub.getSettingsView().blocks.model;
    await hub.updateSettingsBlock("model", currentModelBlock.revision, {
      ...currentModelBlock.value,
      customProviders: [
        ...(currentModelBlock.value.customProviders ?? []),
        {
          id: "api-cloud-preset",
          name: "DeepSeek Cloud",
          preset: "deepseek",
          api: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
        },
      ],
    });
    await expect(
      hub.modelConfiguration.registerLocalProvider({
        providerId: "api-cloud-preset",
        name: "Hijack Local",
        baseUrl: `${localOrigin}/v1`,
        commandId: "cmd-preset-overwrite-rejected",
      }),
    ).rejects.toMatchObject({ code: "model_provider_not_local" });

    // ModelConfigurationCard keyless test + save stamps authMode: "none"
    const draft = await hub.modelConfiguration.prepare({
      clientId: "card-client",
      name: "CardLocal",
      api: "openai-completions",
      baseUrl: `${localOrigin}/v1`,
    });
    const discovered = await hub.modelConfiguration.discover("card-client", draft.revision, draft.id);
    const updated = await hub.modelConfiguration.updateDraft({
      clientId: "card-client",
      draftId: discovered.id,
      expectedRevision: discovered.revision,
      provider: discovered.provider,
      selectedModelIds: ["inkling-4bit"],
    });
    const tested = await hub.modelConfiguration.test({
      clientId: "card-client",
      draftId: updated.id,
      expectedRevision: updated.revision,
      modelId: "inkling-4bit",
      commandId: "card-keyless-test-1",
    });
    expect(tested.verification.ok).toBe(true);
    const saved = await hub.modelConfiguration.save({
      clientId: "card-client",
      draftId: tested.draft.id,
      expectedRevision: tested.draft.revision,
      commandId: "card-keyless-save-1",
    });
    const cardProvider = saved.settings.blocks.model.value.customProviders?.find((p) => p.id === saved.providerId);
    expect(cardProvider?.authMode).toBe("none");
  });
});
