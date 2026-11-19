import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeHindsightTool, probeHindsightConnection } from "../packages/hub/src/hindsight.js";
import { resolveHindsightToken } from "../packages/hub/src/hindsight.js";
import { applySettingsBlockUpdate, hydrateSettingsFromConfig, normalizeMemoryConfig, rollbackSettingsToSnapshot, toPublicSettingsView, type KuloDurableSettings } from "../packages/hub/src/settings.js";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import type { HindsightMemoryConfig } from "@kulo/protocol";

const ROUTER = "kulo-router-test-00000000000000000001";
const WORKER = "kulo-worker-test-00000000000000000001";
const READER = "kulo-reader-test-00000000000000000001";
const servers: http.Server[] = [];

function memory(patch: Partial<HindsightMemoryConfig> = {}): HindsightMemoryConfig {
  return { enabled: true, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "",
    routerApiKey: ROUTER, workerApiKey: WORKER, routerApiKeyEnv: "KULO_MEMORY_TEST_ROUTER", workerApiKeyEnv: "KULO_MEMORY_TEST_WORKER",
    authFile: "", autoAttachTopLevelRouters: false, banks: { private: "private-bank", shared: "shared-bank" }, ...patch };
}

function settings(value = memory()): KuloDurableSettings {
  return { initialized: true, rolesMigratedV2: true, rolesMigratedV3: true, globalRevision: 1,
    revisions: { presentation: 1, executor: 1, roles: 1, model: 1, identity: 1, memory: 1 },
    presentation: { agentName: "Kulo", workbenchName: "Table" },
    executor: { paused: false, maxConcurrentWorkers: 1, maxSubagentsPerTicket: 1, watchdogMinutes: 0 }, roles: {},
    model: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "", thinkingLevel: "off", customProviders: [] },
    identity: { directory: "", directoryRevision: 1 }, memory: value, expression: null, snapshots: [] };
}

type UpstreamFailure = { status: number; path: string; role?: string; method?: string };
async function upstream(options: { privateStatus?: number; policy?: boolean; scoped?: boolean; failure?: UpstreamFailure } = {}) {
  const requests: Array<{ path: string; role: string; method: string }> = [];
  const server = http.createServer((req, res) => {
    const role = req.headers.authorization === `Bearer ${ROUTER}` ? "router" : req.headers.authorization === `Bearer ${WORKER}` ? "worker" : req.headers.authorization === `Bearer ${READER}` ? "reader" : "anonymous";
    const url = new URL(req.url!, "http://127.0.0.1");
    requests.push({ path: url.pathname, role, method: req.method! });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data));
    };
    const failure = options.failure;
    if (failure && url.pathname === failure.path && (!failure.role || role === failure.role) && (!failure.method || req.method === failure.method)) return send(failure.status, {});
    if (role === "anonymous") return send(401, {});
    if (url.pathname === "/v1/kulo/access") {
      if (options.policy === false) return send(404, {});
      return send(200, { policyVersion: 1, role, banks: {
        private: { id: "private-bank", read: role === "router", write: role === "router" },
        shared: { id: "shared-bank", read: true, write: role === "worker" },
      } });
    }
    if (url.pathname === "/v1/version") return send(200, { version: "test" });
    if (options.scoped && url.pathname.includes("/private-bank/") && role === "reader") return send(403, {});
    if (options.scoped && url.pathname.includes("/shared-bank/") && role === "router") return send(403, {});
    if (options.scoped && url.pathname.includes("/shared-bank/") && role === "reader" && req.method === "POST" && !url.pathname.endsWith("/recall")) return send(403, {});
    if (url.pathname.includes("/private-bank/") && role === "worker") return send(options.privateStatus ?? 403, {});
    if (url.pathname.includes("/shared-bank/") && req.method === "POST" && role === "router" && !url.pathname.endsWith("/recall")) return send(403, {});
    if (url.pathname.endsWith("/documents")) return send(200, { items: [] });
    if (url.pathname.endsWith("/memories/recall")) return send(200, { results: [{ text: role === "router" ? "private-canary" : "shared-fact" }] });
    return send(404, {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("separate memory credentials", () => {
  it("migrates a legacy key to Router only and never falls back for Worker", () => {
    vi.stubEnv("KULO_HINDSIGHT_API_KEY", ROUTER);
    const legacy = memory();
    delete legacy.routerApiKey;
    delete legacy.workerApiKey;
    const raw = { ...legacy, apiKey: ROUTER, apiKeyEnv: "KULO_LEGACY_TEST_MEMORY" };
    const normalized = normalizeMemoryConfig(raw);
    expect(resolveHindsightToken(normalized, "router")).toBe(ROUTER);
    expect(resolveHindsightToken(normalized, "worker")).toBeUndefined();
    const view = JSON.stringify(toPublicSettingsView(settings(raw), "/test/identity"));
    expect(view).not.toContain(ROUTER);
    expect(view).not.toContain(WORKER);
    expect(view).not.toContain('"apiKey"');
  });

  it("clears one identity without reviving it from environment or startup config", () => {
    vi.stubEnv("KULO_MEMORY_TEST_WORKER", WORKER);
    const doc = settings();
    applySettingsBlockUpdate(doc, "memory", 1, { ...doc.memory, enabled: false, routerApiKey: "", workerApiKey: "", clearWorkerApiKey: true });
    expect(resolveHindsightToken(doc.memory, "worker")).toBeUndefined();
    expect(resolveHindsightToken(doc.memory, "router")).toBe(ROUTER);
    hydrateSettingsFromConfig(doc, resolveHubConfig({ memory: memory() }));
    expect(resolveHindsightToken(doc.memory, "worker")).toBeUndefined();
    expect(toPublicSettingsView(doc, "/test/identity").blocks.memory.hasWorkerApiKey).toBe(false);
  });

  it("keeps both stored credentials on unrelated edits and rejects identical identities", () => {
    const doc = settings();
    const publicValue = toPublicSettingsView(doc, "/test/identity").blocks.memory.value;
    applySettingsBlockUpdate(doc, "memory", 1, { ...publicValue, banks: { private: "private-bank", shared: "shared-bank" } });
    expect(doc.memory.routerApiKey).toBe(ROUTER);
    expect(doc.memory.workerApiKey).toBe(WORKER);
    expect(() => applySettingsBlockUpdate(doc, "memory", 2, { ...doc.memory, workerApiKey: ROUTER })).toThrow("必须不同");
    expect(doc.revisions.memory).toBe(2);
  });

  it("does not forward retained or environment credentials to a changed origin", () => {
    vi.stubEnv("KULO_MEMORY_TEST_ROUTER", ROUTER);
    vi.stubEnv("KULO_MEMORY_TEST_WORKER", WORKER);
    const doc = settings();
    const payload = toPublicSettingsView(doc, "/test/identity").blocks.memory.value;
    expect(() => applySettingsBlockUpdate(doc, "memory", 1, { ...payload, endpoint: "http://127.0.0.1:10" })).toThrow("重新填写");
    expect(doc.memory.endpoint).toBe("http://127.0.0.1:9");
    applySettingsBlockUpdate(doc, "memory", 1, { ...payload, enabled: false, endpoint: "http://127.0.0.1:10" });
    expect(resolveHindsightToken(doc.memory, "router")).toBeUndefined();
    expect(resolveHindsightToken(doc.memory, "worker")).toBeUndefined();
  });

  it("does not hydrate new runtime environment keys into a persisted different service", () => {
    vi.stubEnv("KULO_MEMORY_TEST_ROUTER", ROUTER);
    vi.stubEnv("KULO_MEMORY_TEST_WORKER", WORKER);
    const savedRouter = "saved-origin-router-key-00000000000001";
    const doc = settings(memory({ routerApiKey: savedRouter, workerApiKey: undefined }));
    hydrateSettingsFromConfig(doc, resolveHubConfig({ memory: memory({ endpoint: "http://127.0.0.1:10", routerApiKey: undefined, workerApiKey: undefined }) }));
    expect(resolveHindsightToken(doc.memory, "router")).toBe(savedRouter);
    expect(resolveHindsightToken(doc.memory, "worker")).toBeUndefined();
    expect(doc.memory.endpoint).toBe("http://127.0.0.1:9");
  });

  it("does not revive cross-origin environment credentials through settings history", () => {
    vi.stubEnv("KULO_MEMORY_TEST_ROUTER", ROUTER);
    vi.stubEnv("KULO_MEMORY_TEST_WORKER", WORKER);
    const doc = settings(memory({ routerApiKey: undefined, workerApiKey: undefined }));
    applySettingsBlockUpdate(doc, "presentation", 1, { agentName: "Changed", workbenchName: "Table" });
    rollbackSettingsToSnapshot(doc, 2, 2, memory({ endpoint: "http://127.0.0.1:10" }));
    expect(resolveHindsightToken(doc.memory, "router")).toBeUndefined();
    expect(resolveHindsightToken(doc.memory, "worker")).toBeUndefined();
  });
});

describe("verified Hindsight endpoints", () => {
  const worker = { role: "worker" as const, conversationId: "worker", ticketId: "T-1" };

  it.each([500, 503, 429])("falls back on a temporary policy response without weakening the full probe (%i)", async (status) => {
    const primary = await upstream({ failure: { path: "/v1/kulo/access", status } });
    const backup = await upstream();
    const config = memory({ endpoint: primary.endpoint, endpoints: [backup.endpoint] });
    const probe = await probeHindsightConnection(config);
    expect(probe).toMatchObject({ healthy: false, isolationVerified: false, activeEndpoint: backup.endpoint });
    const read = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config, caller: worker, bank: "shared" });
    expect(read.isError).toBeUndefined(); expect(read.text).toContain("shared-fact");
    expect(primary.requests.some((request) => request.path.endsWith("/memories/recall"))).toBe(false);
    expect(backup.requests.some((request) => request.path.endsWith("/memories/recall"))).toBe(true);
  });

  it.each([
    { mode: "kulo", role: "worker", bank: "shared", failure: { path: "/v1/default/banks/private-bank/documents", role: "worker", status: 503 } },
    { mode: "scoped", role: "worker", bank: "shared", failure: { path: "/v1/default/banks/shared-bank/documents", role: "worker", status: 503 } },
    { mode: "scoped", role: "worker", bank: "shared", failure: { path: "/v1/default/banks/private-bank/documents", role: "worker", status: 503 } },
    { mode: "scoped", role: "worker", bank: "shared", failure: { path: "/v1/default/banks/private-bank/memories", role: "worker", status: 503 } },
    { mode: "scoped", role: "router", bank: "private", failure: { path: "/v1/default/banks/shared-bank/memories", role: "reader", status: 503 } },
    { mode: "private-only", role: "router", bank: "private", failure: { path: "/v1/default/banks/private-bank/documents", role: "router", status: 503 } },
    { mode: "private-only", role: "router", bank: "private", failure: { path: "/v1/default/banks/private-bank/documents", role: "anonymous", status: 503 } },
  ] as const)("falls back when $mode/$role policy verification is temporarily unavailable at $failure.path", async ({ mode, role, bank, failure }) => {
    const primary = await upstream({ scoped: mode === "scoped", failure });
    const backup = await upstream({ scoped: mode === "scoped" });
    const config = memory({ accessMode: mode, endpoint: primary.endpoint, endpoints: [backup.endpoint], sharedReadApiKey: READER });
    const caller = role === "worker" ? worker : { role: "router" as const, conversationId: "root" };
    const read = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config, caller, bank });
    expect(read.isError).toBeUndefined();
    expect(read.text).toContain(role === "worker" ? "shared-fact" : "private-canary");
    expect(primary.requests.some((request) => request.path.endsWith("/memories/recall"))).toBe(false);
    expect(backup.requests.some((request) => request.path.endsWith("/memories/recall"))).toBe(true);
  });

  it.each([401, 403, 404, 200])("does not hide an invalid primary policy by falling back (%i)", async (status) => {
    const primary = await upstream({ failure: { path: "/v1/kulo/access", status } });
    const backup = await upstream();
    const result = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config: memory({ endpoint: primary.endpoint, endpoints: [backup.endpoint] }), caller: worker, bank: "shared" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(status === 401 || status === 403 ? "AUTH" : "ISOLATION_UNVERIFIED");
    expect(backup.requests).toHaveLength(0);
  });

  it("never queries an unverified backup after a temporary primary failure", async () => {
    const primary = await upstream({ failure: { path: "/v1/kulo/access", status: 503 } });
    const backup = await upstream({ policy: false });
    const result = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config: memory({ endpoint: primary.endpoint, endpoints: [backup.endpoint] }), caller: worker, bank: "shared" });
    expect(result.isError).toBe(true); expect(result.text).toContain("ISOLATION_UNVERIFIED");
    expect(backup.requests.some((request) => request.path.endsWith("/memories/recall"))).toBe(false);
  });

  it.each(["scoped", "private-only"] as const)("does not treat a failed expected denial as an outage in %s mode", async (mode) => {
    const primary = await upstream({ scoped: mode === "scoped", failure: { path: "/v1/default/banks/private-bank/documents", role: mode === "scoped" ? "worker" : "anonymous", status: 200 } });
    const backup = await upstream({ scoped: mode === "scoped" });
    const config = memory({ accessMode: mode, endpoint: primary.endpoint, endpoints: [backup.endpoint], sharedReadApiKey: READER });
    const result = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config, caller: mode === "scoped" ? worker : { role: "router", conversationId: "root" }, bank: mode === "scoped" ? "shared" : "private" });
    expect(result.isError).toBe(true); expect(result.text).toContain("ISOLATION_UNVERIFIED");
    expect(backup.requests).toHaveLength(0);
  });

  it.each(["kulo", "scoped", "private-only"] as const)("keeps writes and operation receipts on the primary in %s mode", async (mode) => {
    const bank = mode === "private-only" ? "private" : "shared";
    const caller = bank === "private" ? { role: "router" as const, conversationId: "root" } : worker;
    for (const kind of ["write", "receipt"] as const) {
      const path = `/v1/default/banks/${bank}-bank/${kind === "write" ? "memories" : "operations/original-operation"}`;
      const primary = await upstream({ scoped: mode === "scoped", failure: { path, status: 503 } });
      const backup = await upstream({ scoped: mode === "scoped" });
      const config = memory({ accessMode: mode, endpoint: primary.endpoint, endpoints: [backup.endpoint], sharedReadApiKey: READER });
      const request = kind === "write" ? { toolName: "hindsight_ingest_document" as const, args: { title: "verified work", content: "The shared cache was verified." } } : { toolName: "hindsight_get_operation" as const, args: { operation_id: "original-operation" } };
      const result = await executeHindsightTool({ ...request, config, caller, bank });
      expect(result.isError).toBe(true); expect(result.text).toContain("UPSTREAM");
      expect(primary.requests.at(-1)?.path).toBe(path);
      expect(backup.requests).toHaveLength(0);
    }
  });

  it("uses the calling identity's key and verifies actual denials", async () => {
    const api = await upstream();
    const config = memory({ endpoint: api.endpoint });
    const probe = await probeHindsightConnection(config);
    expect(probe).toMatchObject({ healthy: true, isolationVerified: true, workerPrivateDenied: true, routerSharedWriteDenied: true });
    const read = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config, caller: worker, bank: "shared" });
    expect(read.isError).toBeUndefined(); expect(read.text).toContain("shared-fact");
    const privateRead = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config, caller: { role: "router", conversationId: "root" }, bank: "private" });
    expect(privateRead.isError).toBeUndefined(); expect(privateRead.text).toContain("private-canary");
    expect(api.requests.filter((request) => request.path.endsWith("/memories/recall"))).toEqual([
      { path: "/v1/default/banks/shared-bank/memories/recall", role: "worker", method: "POST" },
      { path: "/v1/default/banks/private-bank/memories/recall", role: "router", method: "POST" },
    ]);
  });

  it.each([200, 404])("rejects a server that does not actually forbid Worker private access (%i)", async (privateStatus) => {
    const api = await upstream({ privateStatus });
    const config = memory({ endpoint: api.endpoint });
    expect(await probeHindsightConnection(config)).toMatchObject({ healthy: false, isolationVerified: false });
    const result = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config, caller: worker, bank: "shared" });
    expect(result.isError).toBe(true); expect(result.text).toContain("ISOLATION_UNVERIFIED");
    expect(api.requests.some((request) => request.path.endsWith("/memories/recall"))).toBe(false);
  });

  it("blocks missing Worker credentials and explicit private tools before sending data", async () => {
    const api = await upstream();
    const config = memory({ endpoint: api.endpoint, workerApiKey: undefined, workerApiKeyEnv: "" });
    const missing = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config, caller: worker, bank: "shared" });
    expect(missing.text).toContain("AUTH"); expect(api.requests).toHaveLength(0);
    const denied = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config: memory({ endpoint: api.endpoint }), caller: worker, bank: "private" });
    expect(denied.text).toContain("FORBIDDEN"); expect(api.requests).toHaveLength(0);
  });

  it("rejects changed bank mappings and an unprotected backup without sending a memory query", async () => {
    const api = await upstream();
    const backup = await upstream({ policy: false });
    const config = memory({ endpoint: api.endpoint, endpoints: [backup.endpoint] });
    expect(await probeHindsightConnection(config)).toMatchObject({ healthy: false, isolationVerified: false });
    const result = await executeHindsightTool({ toolName: "hindsight_recall", args: { query: "fact" }, config: memory({ endpoint: api.endpoint, banks: { private: "shared-bank", shared: "private-bank" } }), caller: worker, bank: "shared" });
    expect(result.text).toContain("ISOLATION_UNVERIFIED");
    expect(api.requests.some((request) => request.path.endsWith("/memories/recall"))).toBe(false);
    expect(backup.requests.some((request) => request.path.endsWith("/memories/recall"))).toBe(false);
  });

  it("times out a server that sends policy headers but never finishes the JSON body", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"policyVersion":1,');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const startedAt = Date.now();
    const result = await probeHindsightConnection(memory({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    expect(result.healthy).toBe(false);
    expect(result.endpoints[0]?.detail).toContain("TIMEOUT");
    expect(Date.now() - startedAt).toBeLessThan(7_000);
  });

  it("enforces Step 6 Hindsight 1.2.1 retain/recall enhancements, pre-read project tag ownership on shared pages, and Router-only private curation", async () => {
    const pages = new Map<string, { id: string; name: string; source_query: string; tags: string[]; body: string }>();
    const invalidated: Array<{ memoryId: string; body: Record<string, unknown> }> = [];
    const recallBodies: Array<Record<string, unknown>> = [];
    const mentalModels = new Map<string, { id: string; name: string; source_query: string; content: string; tags: string[] }>([
      ["mm-alpha", { id: "mm-alpha", name: "Alpha Model", source_query: "Alpha", content: "Alpha summary", tags: ["project:proj-alpha"] }],
      ["mm-beta", { id: "mm-beta", name: "Beta Model", source_query: "Beta", content: "Beta summary", tags: ["project:proj-beta"] }],
    ]);

    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
      const role = req.headers.authorization === `Bearer ${ROUTER}` ? "router" : req.headers.authorization === `Bearer ${WORKER}` ? "worker" : "anonymous";
      const url = new URL(req.url!, "http://127.0.0.1");
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (role === "anonymous") return send(401, {});
      if (url.pathname === "/v1/kulo/access") {
        return send(200, {
          policyVersion: 1,
          role,
          banks: {
            private: { id: "private-bank", read: role === "router", write: role === "router" },
            shared: { id: "shared-bank", read: true, write: role === "worker" },
          },
        });
      }
      if (url.pathname.includes("/private-bank/") && role !== "router") return send(403, {});
      if (url.pathname.includes("/shared-bank/") && role === "router" && req.method === "POST" && !url.pathname.endsWith("/recall") && !url.pathname.endsWith("/reflect")) {
        return send(403, {});
      }
      if (url.pathname.endsWith("/memories/recall")) {
        recallBodies.push(body);
        return send(200, {
          results: [{ id: "m-1", text: "windowed fact", type: "world", document_id: "d-1", tags: body.tags ?? [], chunk_id: "c-1" }],
          chunks: { "c-1": { text: "verbatim source chunk" } },
        });
      }
      if (url.pathname.endsWith("/memories") && req.method === "POST") {
        return send(202, { operation_id: body.operation_id, async: true, success: true });
      }
      if (/\/private-bank\/memories\/[^/]+$/.test(url.pathname) && req.method === "PATCH") {
        const memoryId = decodeURIComponent(url.pathname.split("/").at(-1)!);
        invalidated.push({ memoryId, body });
        return send(200, { id: memoryId, state: body.state });
      }
      if (url.pathname.endsWith("/pages") && req.method === "POST") {
        const id = `page-${pages.size + 1}`;
        const entry = {
          id,
          name: String(body.name),
          source_query: String(body.source_query),
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
          body: `Synthesized ${String(body.name)}`,
        };
        pages.set(id, entry);
        return send(201, entry);
      }
      if (/\/pages\/nodes\/[^/]+$/.test(url.pathname) && req.method === "PATCH") {
        const nodeId = decodeURIComponent(url.pathname.split("/").at(-1)!);
        const existing = pages.get(nodeId);
        if (!existing) return send(404, {});
        if (typeof body.name === "string") existing.name = body.name;
        if (Array.isArray(body.tags)) existing.tags = body.tags as string[];
        return send(200, existing);
      }
      if (/\/pages\/[^/]+$/.test(url.pathname) && req.method === "GET" && !url.pathname.endsWith("/pages/tree") && !url.pathname.endsWith("/pages/search")) {
        const pageId = decodeURIComponent(url.pathname.split("/").at(-1)!);
        const existing = pages.get(pageId);
        return existing ? send(200, existing) : send(404, {});
      }
      if (url.pathname.endsWith("/mental-models") && req.method === "GET") {
        return send(200, { items: [...mentalModels.values()] });
      }
      if (url.pathname.endsWith("/mental-models") && req.method === "POST") {
        return send(201, { id: "mm-priv-1", name: body.name, source_query: body.source_query });
      }
      if (/\/mental-models\/[^/]+$/.test(url.pathname) && req.method === "GET") {
        const mm = mentalModels.get(decodeURIComponent(url.pathname.split("/").at(-1)!));
        return mm ? send(200, mm) : send(404, {});
      }
      return send(404, {});
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const config = memory({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` });

    const router = { role: "router" as const, conversationId: "root" };
    const workerAlpha = { role: "worker" as const, conversationId: "w-a", ticketId: "T-A", projectId: "proj-alpha", sourceId: "src-a" };
    const workerBeta = { role: "worker" as const, conversationId: "w-b", ticketId: "T-B", projectId: "proj-beta", sourceId: "src-b" };

    // 1. Enhanced hindsight_recall with temporal_window and include_chunks
    const recalled = await executeHindsightTool({
      toolName: "hindsight_recall",
      args: {
        query: "windowed",
        temporal_window: { start: "2026-01-01T00:00:00Z", end: "2026-12-31T23:59:59Z" },
        include_chunks: true,
      },
      config,
      caller: router,
      bank: "private",
    });
    expect(recalled.isError).toBeUndefined();
    expect(recallBodies[0]).toMatchObject({
      temporal_window: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
      include: { chunks: {} },
    });
    expect(JSON.parse(recalled.text).chunks).toMatchObject({ "c-1": { text: "verbatim source chunk" } });

    // 2. Resident hindsight_retain works for Worker (shared) and Router (private)
    const retained = await executeHindsightTool({
      toolName: "hindsight_retain",
      args: { title: "Alpha Convention", content: "Use strict Zod validation." },
      config,
      caller: workerAlpha,
      bank: "shared",
    });
    expect(retained.isError).toBeUndefined();
    expect(JSON.parse(retained.text)).toMatchObject({ accepted: true, bank: "shared" });

    // 3. Shared Pages: Project Alpha creates & updates its own page; Project Beta is FORBIDDEN from reading or mutating Alpha's page!
    const createdPage = await executeHindsightTool({
      toolName: "hindsight_create_page",
      args: { name: "Alpha Spec", source_query: "Summarize Alpha architecture" },
      config,
      caller: workerAlpha,
      bank: "shared",
    });
    expect(createdPage.isError).toBeUndefined();
    const alphaPageId = (JSON.parse(createdPage.text) as { page_id: string }).page_id;

    const betaReadDenied = await executeHindsightTool({
      toolName: "hindsight_get_page",
      args: { page_id: alphaPageId },
      config,
      caller: workerBeta,
      bank: "shared",
    });
    expect(betaReadDenied.isError).toBe(true);
    expect(betaReadDenied.text).toContain("FORBIDDEN");

    const betaMutateDenied = await executeHindsightTool({
      toolName: "hindsight_update_page_node",
      args: { node_id: alphaPageId, name: "Hijacked by Beta" },
      config,
      caller: workerBeta,
      bank: "shared",
    });
    expect(betaMutateDenied.isError).toBe(true);
    expect(betaMutateDenied.text).toContain("FORBIDDEN");
    expect(pages.get(alphaPageId)?.name).toBe("Alpha Spec");

    const alphaMutateOk = await executeHindsightTool({
      toolName: "hindsight_update_page_node",
      args: { node_id: alphaPageId, name: "Alpha Spec v2" },
      config,
      caller: workerAlpha,
      bank: "shared",
    });
    expect(alphaMutateOk.isError).toBeUndefined();
    expect(pages.get(alphaPageId)?.name).toBe("Alpha Spec v2");
    expect(pages.get(alphaPageId)?.tags).toContain("project:proj-alpha");

    // Reserved export slug rejected before network
    const exportDenied = await executeHindsightTool({
      toolName: "hindsight_get_page",
      args: { page_id: "export" },
      config,
      caller: workerAlpha,
      bank: "shared",
    });
    expect(exportDenied.isError).toBe(true);
    expect(exportDenied.text).toContain("INVALID_ARGUMENTS");

    // 4. Mental Models & Invalidation: Worker blocked from create_mental_model & invalidate_memory; Router allowed on private only!
    const workerInvalidateDenied = await executeHindsightTool({
      toolName: "hindsight_invalidate_memory",
      args: { memory_id: "m-1", reason: "wrong" },
      config,
      caller: workerAlpha,
      bank: "shared",
    });
    expect(workerInvalidateDenied.isError).toBe(true);
    expect(workerInvalidateDenied.text).toContain("FORBIDDEN");

    const routerSharedInvalidateDenied = await executeHindsightTool({
      toolName: "hindsight_invalidate_memory",
      args: { memory_id: "m-1", reason: "wrong" },
      config,
      caller: router,
      bank: "shared",
    });
    expect(routerSharedInvalidateDenied.isError).toBe(true);
    expect(routerSharedInvalidateDenied.text).toContain("FORBIDDEN");

    const routerPrivateInvalidateOk = await executeHindsightTool({
      toolName: "hindsight_invalidate_memory",
      args: { memory_id: "m-priv-1", reason: "Superseded preference" },
      config,
      caller: router,
      bank: "private",
    });
    expect(routerPrivateInvalidateOk.isError).toBeUndefined();
    expect(invalidated).toEqual([{ memoryId: "m-priv-1", body: { state: "invalidated", reason: "Superseded preference" } }]);

    const workerMentalCreateDenied = await executeHindsightTool({
      toolName: "hindsight_create_mental_model",
      args: { name: "Illegal", source_query: "q" },
      config,
      caller: workerAlpha,
      bank: "shared",
    });
    expect(workerMentalCreateDenied.isError).toBe(true);
    expect(workerMentalCreateDenied.text).toContain("FORBIDDEN");

    const routerMentalCreateOk = await executeHindsightTool({
      toolName: "hindsight_create_mental_model",
      args: { name: "User Working Style", source_query: "Summarize collaboration preferences" },
      config,
      caller: router,
      bank: "private",
    });
    expect(routerMentalCreateOk.isError).toBeUndefined();
    expect(JSON.parse(routerMentalCreateOk.text)).toMatchObject({ id: "mm-priv-1", bank: "private" });

    // Worker mental model list/get filters strictly by project tag
    const alphaModels = JSON.parse(
      (await executeHindsightTool({ toolName: "hindsight_list_mental_models", args: {}, config, caller: workerAlpha, bank: "shared" })).text,
    ) as { items: Array<{ id: string }> };
    expect(alphaModels.items.map((i) => i.id)).toEqual(["mm-alpha"]);
    const betaModelDenied = await executeHindsightTool({
      toolName: "hindsight_get_mental_model",
      args: { mental_model_id: "mm-beta" },
      config,
      caller: workerAlpha,
      bank: "shared",
    });
    expect(betaModelDenied.isError).toBe(true);
    expect(betaModelDenied.text).toContain("FORBIDDEN");
  });
});
