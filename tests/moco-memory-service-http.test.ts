import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { MocoHub, startMocoHubServer } from "@moco/hub";
import type { MemoryServiceSnapshot } from "@moco/protocol";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";

const NODE = "node-memory-http-test-only", ROUTER = "router-memory-http-" + "r".repeat(40);
const cleanup: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY", "MOCO_HINDSIGHT_ROUTER_API_KEY", "MOCO_HINDSIGHT_WORKER_API_KEY", "MOCO_HINDSIGHT_SHARED_READ_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-memory-http-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "memory-http" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: { stateDir: directory, identityDir: path.join(directory, "identity"), authToken: HUB_TEST_ADMIN_TOKEN,
    envTokens: { node: NODE }, workerEnvIds: ["node"], enableLocalEnv: false, memory: { enabled: false }, model: { defaultModel: "memory-http", defaultProvider: "openai", apiKey: "" } } });
  cleanup.push(() => hub.close());
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanup.push(() => server.close());
  const call = async (route: string, body?: unknown, token = HUB_TEST_ADMIN_TOKEN) => {
    const response = await fetch(`${server.url}${route}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  return { hub, call };
}

describe("memory service management HTTP", () => {
  it("keeps service configuration, secure inputs and decisions behind management authentication", async () => {
    const { call } = await fixture();
    for (const [route, body] of [
      ["/api/memory/service", undefined], ["/api/memory/service/prepare", {}],
      ["/api/memory/service/inputs/test", { clientId: "client" }],
      ["/api/memory/service/jobs/test/decision", { clientId: "client", decision: "confirm" }],
      ["/api/memory/service/enabled", { enabled: true, expectedRevision: 1 }],
      ["/api/memory/service/connection", {}], ["/api/memory/service/connection/probe", {}],
    ] as const) expect((await call(route, body, NODE)).status).toBe(401);
    const publicState = await call("/api/memory/service");
    expect(publicState.status).toBe(200);
    expect(publicState.value).toMatchObject({ installed: false, running: false, jobs: [], inputs: [] });
  });

  it("directly probes and saves the left-hand connection form, preserving state on failed checks", async () => {
    let accepts = true;
    const seen: Array<{ url: string; token: string | undefined }> = [];
    const upstream = http.createServer((request, response) => {
      seen.push({ url: request.url!, token: request.headers.authorization });
      const send = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
      if (!accepts || request.headers.authorization !== `Bearer ${ROUTER}`) return send(401, {});
      if (request.url?.startsWith("/v1/default/banks/private/documents")) return send(200, { items: [] });
      if (request.url === "/v1/version") return send(200, { version: "1.2.1" });
      return send(404, {});
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const { call, hub } = await fixture();
    const revision = hub.getSettingsView().blocks.memory.revision;
    const connection = { endpoint, accessMode: "private-only", banks: { private: "private", shared: "shared" } };
    const checked = await call("/api/memory/service/connection/probe", { expectedRevision: revision, enabled: false, connection, routerApiKey: ROUTER });
    expect(checked.status).toBe(200); expect(checked.value.probe.healthy).toBe(true);
    expect(checked.value.settings.blocks.memory.revision).toBe(revision);
    expect(hub.getSettingsView().blocks.memory.value.enabled).toBe(false);
    expect(checked.value.service.jobs).toEqual([]); expect(checked.value.service.inputs).toEqual([]);
    const saved = await call("/api/memory/service/connection", { expectedRevision: revision, enabled: true, connection, routerApiKey: ROUTER });
    expect(saved.status).toBe(200);
    expect(saved.value.settings.blocks.memory).toMatchObject({ revision: revision + 1, hasRouterApiKey: true, value: { enabled: true, endpoint, accessMode: "private-only" } });
    expect(saved.value.service.connection.enabled).toBe(true);
    expect(JSON.stringify(saved.value)).not.toContain(ROUTER);
    const retained = await call("/api/memory/service/connection", { expectedRevision: saved.value.settings.blocks.memory.revision, enabled: true, connection, routerApiKey: "" });
    expect(retained.status).toBe(200); expect(retained.value.settings.blocks.memory.hasRouterApiKey).toBe(true);
    const currentRevision = retained.value.settings.blocks.memory.revision;
    const beforeStale = seen.length;
    const stale = await call("/api/memory/service/connection", { expectedRevision: revision, enabled: true, connection, routerApiKey: "" });
    expect(stale.status).toBe(409); expect(seen).toHaveLength(beforeStale);
    accepts = false;
    const failure = await call("/api/memory/service/connection", { expectedRevision: currentRevision, enabled: true, connection, routerApiKey: "" });
    expect(failure.status).toBe(409); expect(JSON.stringify(failure.value)).not.toContain(ROUTER);
    expect(hub.getSettingsView().blocks.memory).toMatchObject({ revision: currentRevision, value: { enabled: true, endpoint } });
    const beforePause = seen.length;
    const paused = await call("/api/memory/service/connection", { expectedRevision: currentRevision, enabled: false, connection, routerApiKey: "" });
    expect(paused.status).toBe(200); expect(paused.value.probe).toBeUndefined(); expect(seen).toHaveLength(beforePause);
    expect(paused.value.settings.blocks.memory.value.enabled).toBe(false);
    expect(JSON.stringify(await call("/api/memory/service"))).not.toContain(ROUTER);
  });

  it("blocks old keys at a changed origin and rejects invalid or management credentials before any probe", async () => {
    const seen: number[] = [];
    const upstream = http.createServer((_request, response) => { seen.push(1); response.writeHead(401, { "Content-Type": "application/json" }); response.end("{}"); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const { call, hub } = await fixture();
    const connection = { endpoint: "https://old.example.test", accessMode: "private-only", banks: { private: "private", shared: "shared" } };
    const stored = await call("/api/memory/service/connection", { expectedRevision: hub.getSettingsView().blocks.memory.revision, enabled: false, connection, routerApiKey: ROUTER });
    expect(stored.status).toBe(200); expect(stored.value.settings.blocks.memory.hasRouterApiKey).toBe(true);
    const revision = stored.value.settings.blocks.memory.revision;
    const changed = await call("/api/memory/service/connection", { expectedRevision: revision, enabled: true, connection: { ...connection, endpoint }, routerApiKey: "" });
    expect(changed.status).toBe(400); expect(seen).toHaveLength(0);
    expect(hub.getSettingsView().blocks.memory).toMatchObject({ revision, value: { endpoint: connection.endpoint } });
    for (const patch of [{ secret: ROUTER }, { routerApiKey: 123 }, { clearRouterApiKey: "true" }, { enabled: "true" }, { connection: { ...connection, banks: { ...connection.banks, key: ROUTER } } }]) {
      const rejected = await call("/api/memory/service/connection/probe", { expectedRevision: revision, enabled: false, connection, routerApiKey: ROUTER, ...patch });
      expect(rejected.status).toBe(400); expect(JSON.stringify(rejected.value)).not.toContain(ROUTER);
    }
    const reserved = await call("/api/memory/service/connection", { expectedRevision: revision, enabled: true, connection: { ...connection, endpoint }, routerApiKey: HUB_TEST_ADMIN_TOKEN });
    expect(reserved.status).toBe(400); expect(JSON.stringify(reserved.value)).not.toContain(HUB_TEST_ADMIN_TOKEN); expect(seen).toHaveLength(0);
  });

  it("rejects credential-bearing or non-HTTP URLs for probes and saves, including disabled connections", async () => {
    const { call, hub } = await fixture();
    const before = hub.getSettingsView();
    const revision = before.blocks.memory.revision;
    const embedded = "embedded-url-value";
    const urls = [
      `https://${embedded}@memory.example.test`, `https://user:${embedded}@memory.example.test`,
      `https://:${embedded}@memory.example.test`, `https://memory.example.test?token=${embedded}`,
      `https://memory.example.test#${embedded}`, `javascript:${embedded}`, `file:///${embedded}`, `ftp://memory.example.test/${embedded}`,
    ];
    for (const endpoint of urls) {
      for (const alternate of [false, true]) {
        const connection = { endpoint: alternate ? "https://memory.example.test" : endpoint, ...(alternate ? { endpoints: [endpoint] } : {}), accessMode: "private-only", banks: { private: "private", shared: "shared" } };
        for (const route of ["/api/memory/service/connection", "/api/memory/service/connection/probe"]) {
          for (const enabled of [false, true]) {
            const result = await call(route, { expectedRevision: revision, enabled, connection, routerApiKey: ROUTER });
            expect(result.status).toBe(400);
            expect(JSON.stringify(result.value)).not.toContain(embedded);
            expect(JSON.stringify(result.value)).not.toContain(ROUTER);
          }
        }
      }
    }
    expect(hub.getSettingsView()).toEqual(before);
    const snapshot = await call("/api/memory/service");
    expect(JSON.stringify(snapshot.value)).not.toContain(embedded);
    expect(snapshot.value.jobs).toEqual([]);
  });

  it("verifies a standard existing service before enabling, supports pause, and never serializes credentials", async () => {
    let accepts = true;
    const upstream = http.createServer((request, response) => {
      const send = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
      if (!accepts || request.headers.authorization !== `Bearer ${ROUTER}`) return send(401, {});
      if (request.url?.startsWith("/v1/default/banks/private/documents")) return send(200, { items: [] });
      if (request.url === "/v1/version") return send(200, { version: "1.2.1" });
      return send(404, {});
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const { call, hub } = await fixture();
    const revision = hub.getSettingsView().blocks.memory.revision;
    const prepared = await call("/api/memory/service/prepare", { commandId: "connect-standard", clientId: "browser-a", expectedRevision: revision,
      operation: "connect", connection: { endpoint, accessMode: "private-only", banks: { private: "private", shared: "shared" } } });
    expect(prepared.status).toBe(200);
    expect(prepared.value.jobs[0].status).toBe("awaiting-input");
    expect(hub.getSettingsView().blocks.memory.revision).toBe(revision);
    const input = prepared.value.inputs[0];
    expect((await call(`/api/memory/service/inputs/${input.id}`, { clientId: "browser-b", secret: ROUTER })).status).toBe(403);
    const supplied = await call(`/api/memory/service/inputs/${input.id}`, { clientId: "browser-a", secret: ROUTER });
    expect(supplied.status).toBe(200); expect(JSON.stringify(supplied.value)).not.toContain(ROUTER);
    expect(hub.getSettingsView().blocks.memory.value.enabled).toBe(false);
    await call("/api/memory/service/jobs/connect-standard/decision", { clientId: "browser-a", decision: "confirm" });
    let snapshot!: MemoryServiceSnapshot;
    await vi.waitFor(async () => {
      snapshot = (await call("/api/memory/service?clientId=browser-a")).value;
      expect(snapshot.jobs[0]?.status).toBe("succeeded");
    }, { timeout: 5000, interval: 10 });
    expect(snapshot.connection).toMatchObject({ enabled: true, endpoint, accessMode: "private-only" });
    expect(snapshot.jobs[0]!.probe).toMatchObject({ healthy: true, sharedBankOk: false, isolationVerified: false });
    expect(JSON.stringify(snapshot)).not.toContain(ROUTER);
    const paused = await call("/api/memory/service/enabled", { enabled: false, expectedRevision: snapshot.revision });
    expect(paused.status).toBe(200); expect(paused.value.connection.enabled).toBe(false);
    expect(hub.getSettingsView().blocks.memory.hasRouterApiKey).toBe(true);
    accepts = false;
    const failed = await call("/api/memory/service/enabled", { enabled: true, expectedRevision: paused.value.revision });
    expect(failed.status).toBe(409); expect(hub.getSettingsView().blocks.memory.value.enabled).toBe(false);
    accepts = true;
    const enabled = await call("/api/memory/service/enabled", { enabled: true, expectedRevision: paused.value.revision });
    expect(enabled.status).toBe(200); expect(enabled.value.connection.enabled).toBe(true);
  });
});
