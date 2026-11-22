import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ConnectionRecordView, ConnectionSetupInput, ConnectionWorkspaceSnapshot } from "@kulo/protocol";
import { KuloHub } from "../packages/hub/src/hub.js";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import { KuloConnections } from "../packages/hub/src/connections.js";
import { LocalConnectionVault } from "../packages/hub/src/connection-vault.js";
import type { ConnectionExecutionBackend } from "../packages/hub/src/connection-execution.js";
import type { ConnectionApplicationBackend } from "../packages/hub/src/connection-applications.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";

const resources: Array<() => unknown | Promise<unknown>> = [];
const key = "http-connection-dummy-secret-18274";
const nodeToken = "http-connection-node-token";
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((filename) => path.basename(String(filename)) === ".env" ? false : exists(filename));
  for (const name of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-connection-http-"));
  resources.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const models = createModels(); models.setProvider(fauxProvider({ provider: "connections-http", models: [{ id: "test" }] }).provider);
  const executor: ConnectionExecutionBackend = {
    scan: vi.fn(async () => ({ fingerprint: "SHA256:kulo-test-public-host-fingerprint", lines: ["host.example.test ssh-ed25519 AAAApublictest"] })),
    trust: vi.fn(async () => {}),
    execute: vi.fn(async (_connection, _secrets, operation) => operation.kind === "ssh" ? { kind: "ssh", output: "ok", exitCode: 0 } : { kind: "http", output: "ok", status: 200 }),
  };
  const vault = new LocalConnectionVault({ stateDir, keyStore: { getOrCreateKey: async () => Buffer.alloc(32, 7) } });
  const applications: ConnectionApplicationBackend = {
    probe: vi.fn(async () => ({ username: "test-account" })),
    execute: vi.fn(async () => ({ kind: "app", output: "test result" })),
  };
  const manager = new KuloConnections({ stateDir, vault, executor, applications, platform: "darwin" });
  const hub = await KuloHub.open({ models, providerId: "connections-http", connectionManager: manager,
    config: { stateDir, identityDir: path.join(stateDir, "identity"), localEnvRoot: path.join(stateDir, "workspace"), enableLocalEnv: false,
      authToken: HUB_TEST_ADMIN_TOKEN, envTokens: { "test-node": nodeToken }, workerEnvIds: ["test-node"], memory: { enabled: false }, watchdogMinutes: 0,
      model: { defaultProvider: "connections-http", defaultModel: "test", thinkingLevel: "off", apiKey: "" } } });
  resources.push(() => hub.close());
  const openNativePermissionSettings = vi.fn(async () => {});
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0, openNativePermissionSettings });
  resources.push(() => server.close());
  const request = (endpoint: string, method = "GET", body?: unknown, token: string | null = HUB_TEST_ADMIN_TOKEN, extraHeaders?: Record<string, string>) => fetch(`${server.url}${endpoint}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { request, manager, vault, executor, hub, applications, openNativePermissionSettings, url: server.url };
}

describe("connection authorization HTTP boundary", () => {
  it("completes a preset application connection only after a client-bound permission check", async () => {
    const f = await fixture();
    const prepared = await f.request("/api/connections/prepare", "POST", { clientId: "app-tab", category: "app", appId: "messages" });
    expect(prepared.status).toBe(201);
    const input = await prepared.json() as ConnectionSetupInput;
    expect(input).toMatchObject({ kind: "app", category: "app", appId: "messages" });
    const body = { name: "消息", kind: "app", category: "app", appId: "messages" };
    const wrongClient = await f.request(`/api/connections/inputs/${input.id}/submit`, "POST", { ...body, clientId: "other-tab" });
    expect(wrongClient.status).toBe(403);
    expect(f.applications.probe).not.toHaveBeenCalled();
    const submitted = await f.request(`/api/connections/inputs/${input.id}/submit`, "POST", { ...body, clientId: "app-tab" });
    expect(submitted.status).toBe(200);
    const { connection } = await submitted.json() as { connection: ConnectionRecordView };
    expect(connection).toMatchObject({ kind: "app", appId: "messages", category: "app", status: "verified", hasCredential: false });
    expect(f.applications.probe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.applications.probe).mock.calls[0]?.[3]).toMatchObject({ requestPermission: true });
    const snapshot = await (await f.request("/api/connections")).json() as ConnectionWorkspaceSnapshot;
    expect(snapshot.applications?.find((app) => app.id === "messages")).toMatchObject({ status: "connected", connectionId: connection.id });
    expect((await f.request(`/api/connections/${connection.id}`, "DELETE")).status).toBe(200);
    const disconnected = await (await f.request("/api/connections")).json() as ConnectionWorkspaceSnapshot;
    expect(disconnected.applications?.find((app) => app.id === "messages")?.status).toBe("disconnected");
  });

  it("saves arbitrary credential fields through the same secure form without returning their values", async () => {
    const f = await fixture();
    const credentialFields = [{ key: "sessionTicket", label: "会话票据" }, { key: "certificateChain", label: "证书链" }];
    const secrets = { sessionTicket: "custom-session-synthetic-28534", certificateChain: "custom-certificate-line-one\ncustom-certificate-line-two" };
    const prepared = await f.request("/api/connections/prepare", "POST", { clientId: "custom-tab", name: "星云网关", kind: "custom", typeLabel: "会话认证", credentialFields });
    expect(prepared.status).toBe(201);
    const input = await prepared.json() as ConnectionSetupInput;
    const response = await f.request(`/api/connections/inputs/${input.id}/submit`, "POST", {
      clientId: "custom-tab", name: "星云网关", kind: "custom", typeLabel: "会话认证", instructions: "供网关认证使用", credentialFields, secrets,
    });
    expect(response.status).toBe(200);
    const saved = await response.json() as { connection: ConnectionRecordView };
    expect(saved.connection).toMatchObject({ kind: "custom", typeLabel: "会话认证", status: "saved", hasCredential: true, credentialFields });
    expect(await f.vault.get(`connection:${saved.connection.id}`)).toMatchObject(secrets);
    const snapshot = await (await f.request("/api/connections?clientId=custom-tab")).json() as ConnectionWorkspaceSnapshot;
    for (const secret of Object.values(secrets)) {
      expect(JSON.stringify(saved)).not.toContain(secret);
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    }
    const test = await f.request(`/api/connections/${saved.connection.id}/test`, "POST");
    expect(test.status).toBe(409);
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect((await f.manager.snapshot()).connections[0]?.status).toBe("saved");
    expect((await f.request(`/api/connections/${saved.connection.id}`, "DELETE")).status).toBe(200);
    expect(await f.vault.get(`connection:${saved.connection.id}`)).toBeUndefined();
  });

  it("accepts a bounded multi-field credential bundle larger than the ordinary JSON request limit", async () => {
    const f = await fixture();
    const response = await f.request("/api/connections", "POST", {
      name: "证书资料", kind: "custom", typeLabel: "证书",
      credentialFields: [{ key: "chain", label: "证书链" }, { key: "bundle", label: "附加材料" }],
      secrets: { chain: `synthetic-chain-${"a".repeat(140_000)}`, bundle: `synthetic-bundle-${"b".repeat(140_000)}` },
    });
    expect(response.status).toBe(201);
    const saved = await response.json() as { connection: ConnectionRecordView };
    expect(saved.connection).toMatchObject({ kind: "custom", status: "saved", secretFields: ["chain", "bundle"] });
    expect(JSON.stringify(saved).length).toBeLessThan(2_000);
  });

  it("requires administrator authentication for listing, creation, tests, trust and removal", async () => {
    const f = await fixture();
    const routes = [
      ["/api/connections", "GET"], ["/api/connections", "POST"], ["/api/connections/prepare", "POST"],
      ["/api/connections/connection-dummy/test", "POST"], ["/api/connections/connection-dummy/trust", "POST"], ["/api/connections/connection-dummy", "DELETE"],
    ];
    for (const token of [null, nodeToken]) for (const [endpoint, method] of routes) {
      const response = await f.request(endpoint!, method!, method === "POST" ? {} : undefined, token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    const allowed = await f.request("/api/connections");
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect((await allowed.json() as ConnectionWorkspaceSnapshot).connections).toEqual([]);
  });

  it("binds dedicated secret forms to their original window, saves idempotently and never returns secret fields", async () => {
    const f = await fixture();
    const prepared = await f.request("/api/connections/prepare", "POST", { clientId: "original-tab", name: "API 测试", kind: "api-key", url: "https://api.example.test/v1" });
    expect(prepared.status).toBe(201);
    const input = await prepared.json() as ConnectionSetupInput;
    const body = { name: "API 测试", kind: "api-key", url: "https://api.example.test/v1", secrets: { apiKey: key } };
    const wrong = await f.request(`/api/connections/inputs/${input.id}/submit`, "POST", { ...body, clientId: "other-tab" });
    expect(wrong.status).toBe(403);
    expect((await (await f.request("/api/connections?clientId=other-tab")).json() as ConnectionWorkspaceSnapshot).inputs).toEqual([]);
    const first = await f.request(`/api/connections/inputs/${input.id}/submit`, "POST", { ...body, clientId: "original-tab" });
    expect(first.status).toBe(200);
    const saved = await first.json() as { connection: ConnectionRecordView };
    expect(JSON.stringify(saved)).not.toContain(key);
    expect(saved.connection).toMatchObject({ kind: "api-key", hasCredential: true, status: "saved", secretFields: ["apiKey"] });
    const retry = await f.request(`/api/connections/inputs/${input.id}/submit`, "POST", { ...body, clientId: "original-tab" });
    expect((await retry.json() as { connection: ConnectionRecordView }).connection.id).toBe(saved.connection.id);
    const snapshot = await (await f.request("/api/connections?clientId=original-tab")).json() as ConnectionWorkspaceSnapshot;
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.inputs[0]?.status).toBe("completed");
    expect(JSON.stringify(snapshot)).not.toContain(key);
    expect((await f.vault.get(`connection:${saved.connection.id}`))?.apiKey).toBe(key);
    const pending = await (await f.request("/api/connections/prepare", "POST", { clientId: "original-tab", kind: "account", name: "待取消" })).json() as ConnectionSetupInput;
    expect((await f.request(`/api/connections/inputs/${pending.id}/cancel`, "POST", { clientId: "other-tab" })).status).toBe(403);
    expect((await f.request(`/api/connections/inputs/${pending.id}/cancel`, "POST", { clientId: "original-tab" })).status).toBe(200);
    expect((await f.request(`/api/connections/inputs/${pending.id}/submit`, "POST", { clientId: "original-tab", ...body })).status).toBe(409);
  });

  it("clears stale credentials after an origin edit and blocks their use against the new destination", async () => {
    const f = await fixture();
    const created = await f.request("/api/connections", "POST", { name: "Origin 测试", kind: "api-key", url: "https://original.example.test/v1", secrets: { apiKey: key } });
    expect(created.status).toBe(201);
    const { connection } = await created.json() as { connection: ConnectionRecordView };
    const edit = await f.request("/api/connections", "POST", { id: connection.id, expectedRevision: connection.revision, name: connection.name, kind: connection.kind, url: "https://changed.example.test/v1" });
    expect(edit.status).toBe(201);
    const next = (await edit.json() as { connection: ConnectionRecordView }).connection;
    expect(next).toMatchObject({ status: "incomplete", hasCredential: false, secretFields: [] });
    f.manager.grant("test-task", 1, [connection.id]);
    await expect(f.manager.use("test-task", 1, connection.id, { kind: "http", path: "/v1" })).rejects.toMatchObject({ code: "connection_credential_missing" });
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect((await f.request(`/api/connections/${connection.id}`, "DELETE")).status).toBe(200);
    expect((await f.manager.snapshot()).connections).toEqual([]);
    expect(await f.vault.entries()).toEqual([]);
    expect(f.manager.hasGrant("test-task", 1, connection.id)).toBe(false);
  });

  it("requires matching SSH fingerprint confirmation before authentication", async () => {
    const f = await fixture();
    const { connection } = await (await f.request("/api/connections", "POST", { name: "SSH 测试", kind: "ssh", host: "host.example.test", username: "deploy", secrets: { password: key } })).json() as { connection: ConnectionRecordView };
    const scan = await f.request(`/api/connections/${connection.id}/test`, "POST");
    expect(scan.status).toBe(200);
    const scanned = await scan.json() as { fingerprint: string; requiresTrust: boolean; connection: ConnectionRecordView };
    expect(scanned.requiresTrust).toBe(true);
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect((await f.request(`/api/connections/${connection.id}/trust`, "POST", { fingerprint: "SHA256:wrong" })).status).toBe(409);
    const trusted = await f.request(`/api/connections/${connection.id}/trust`, "POST", { fingerprint: scanned.fingerprint });
    expect(trusted.status).toBe(200);
    expect(f.executor.trust).toHaveBeenCalledTimes(1);
    const tested = await f.request(`/api/connections/${connection.id}/test`, "POST");
    expect((await tested.json() as { connection: ConnectionRecordView }).connection.status).toBe("verified");
    expect(f.executor.execute).toHaveBeenCalledTimes(1);
    expect((await f.request(`/api/connections/${connection.id}/test`, "POST", { rescan: "yes" })).status).toBe(400);
    expect((await f.request(`/api/connections/${connection.id}/test`, "POST", { extra: true })).status).toBe(400);
    const rescanned = await f.request(`/api/connections/${connection.id}/test`, "POST", { rescan: true });
    expect(rescanned.status).toBe(200);
    expect((await rescanned.json() as { requiresTrust?: boolean }).requiresTrust).toBe(true);
    expect(JSON.stringify(await (await f.request("/api/connections")).json())).not.toContain(key);
  });

  it("forwards native permission error codes and gates local permission settings opening", async () => {
    const f = await fixture();
    const localSnapshot = await (await f.request("/api/connections")).json() as ConnectionWorkspaceSnapshot;
    expect(localSnapshot.localHost).toBe(true);
    const forwardedSnapshot = await (await f.request("/api/connections", "GET", undefined, HUB_TEST_ADMIN_TOKEN, { "x-forwarded-for": "198.51.100.10" })).json() as ConnectionWorkspaceSnapshot;
    expect(forwardedSnapshot.localHost).toBe(false);

    const prepared = await f.request("/api/connections/prepare", "POST", { clientId: "perm-tab", category: "app", appId: "messages" });
    const input = await prepared.json() as ConnectionSetupInput;
    vi.mocked(f.applications.probe).mockRejectedValueOnce(Object.assign(new Error("无法读取信息数据库。"), { code: "connection_messages_full_disk_access_required", status: 409 }));
    const failed = await f.request(`/api/connections/inputs/${input.id}/submit`, "POST", { clientId: "perm-tab", name: "信息", kind: "app", category: "app", appId: "messages" });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({ error: "无法读取信息数据库。", code: "connection_messages_full_disk_access_required" });

    expect((await f.request("/api/connections/permission-settings", "POST", { kind: "full-disk-access" }, null)).status).toBe(401);
    expect((await f.request("/api/connections/permission-settings", "GET")).status).toBe(405);
    expect((await f.request("/api/connections/permission-settings", "POST", { kind: "full-disk-access" }, HUB_TEST_ADMIN_TOKEN, { Origin: "https://evil.example" })).status).toBe(403);
    const remote = await f.request("/api/connections/permission-settings", "POST", { kind: "full-disk-access" }, HUB_TEST_ADMIN_TOKEN, { "x-forwarded-for": "198.51.100.10" });
    expect(remote.status).toBe(403);
    expect(await remote.json()).toMatchObject({ code: "connection_permission_settings_remote" });
    expect((await f.request("/api/connections/permission-settings", "POST", { kind: "microphone" })).status).toBe(400);
    expect((await f.request("/api/connections/permission-settings", "POST", { kind: "automation", extra: true })).status).toBe(400);
    expect(f.openNativePermissionSettings).not.toHaveBeenCalled();

    const okFullDisk = await f.request("/api/connections/permission-settings", "POST", { kind: "full-disk-access" }, HUB_TEST_ADMIN_TOKEN, { Origin: f.url });
    expect(okFullDisk.status).toBe(200);
    const okAutomation = await f.request("/api/connections/permission-settings", "POST", { kind: "automation" }, HUB_TEST_ADMIN_TOKEN, { Origin: f.url });
    expect(okAutomation.status).toBe(200);
    const okLocalNet = await f.request("/api/connections/permission-settings", "POST", { kind: "local-network" }, HUB_TEST_ADMIN_TOKEN, { Origin: f.url });
    expect(okLocalNet.status).toBe(200);
    expect(f.openNativePermissionSettings.mock.calls).toEqual([["full-disk-access"], ["automation"], ["local-network"]]);
  });
});
