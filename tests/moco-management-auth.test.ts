import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import WebSocket from "ws";
import { MocoHub, startMocoHubServer, type MocoHubServer } from "@moco/hub";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";

const NODE_TOKEN = "moco-env-node-only-test-token";
const resources: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubEnv("MOCO_AUTH_TOKEN", "");
  vi.stubEnv("MOCO_ENV_TOKENS", "");
});

afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function makeHub(authToken: string, nodeToken = NODE_TOKEN): Promise<MocoHub> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-management-auth-"));
  resources.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "auth-test-model" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  const hub = await openTestHub({
    models,
    config: {
      stateDir,
      enableLocalEnv: false,
      authToken,
      envTokens: { "test-node": nodeToken },
      workerEnvIds: ["test-node"],
      memory: { enabled: false },
    },
  });
  resources.push(() => hub.close());
  return hub;
}

async function listen(hub: MocoHub): Promise<MocoHubServer> {
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  resources.push(() => server.close());
  return server;
}

function websocketStatus(url: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WebSocket authentication did not settle"));
    }, 5_000);
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve(101);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("Hub management identity is distinct from worker node identity", () => {
  it.each(["", "   ", "invalid token"])("refuses an absent or invalid administrator key", async (token) => {
    const hub = await makeHub(token);
    await expect(listen(hub)).rejects.toThrow("MOCO_AUTH_TOKEN");
  });

  it("refuses to reuse a node credential as the administrator credential", async () => {
    const hub = await makeHub(HUB_TEST_ADMIN_TOKEN, HUB_TEST_ADMIN_TOKEN);
    await expect(listen(hub)).rejects.toThrow("不能与 Hub 管理密钥相同");
  });

  it("keeps identity documents, settings and user commands unavailable to anonymous and node requests", async () => {
    const hub = await makeHub(HUB_TEST_ADMIN_TOKEN);
    const server = await listen(hub);
    const revision = hub.getSettingsView().globalRevision;
    const routes = [
      { path: "/api/settings", method: "GET" },
      { path: "/api/identity/file?file=identity-agreement.md", method: "GET" },
      { path: "/api/settings/memory", method: "POST" },
      { path: "/api/topics", method: "POST" },
    ];
    for (const authorization of [undefined, `Bearer ${NODE_TOKEN}`, HUB_TEST_ADMIN_TOKEN]) {
      for (const route of routes) {
        const response = await fetch(`${server.url}${route.path}`, {
          method: route.method,
          headers: authorization ? { Authorization: authorization } : undefined,
          ...(route.method === "POST" ? { body: "{}" } : {}),
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Unauthorized" });
      }
    }
    const query = await fetch(`${server.url}/api/settings?token=${NODE_TOKEN}`);
    expect(query.status).toBe(401);
    expect(hub.getSettingsView().globalRevision).toBe(revision);

    const allowed = await fetch(`${server.url}/api/settings`, {
      headers: { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
    });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).globalRevision).toBe(revision);
    expect(server.url).not.toContain(HUB_TEST_ADMIN_TOKEN);
  });

  it("rejects node and anonymous client WebSockets while allowing the administrator", async () => {
    const server = await listen(await makeHub(HUB_TEST_ADMIN_TOKEN));
    expect(await websocketStatus(server.clientWsUrl)).toBe(401);
    expect(await websocketStatus(server.clientWsUrl, NODE_TOKEN)).toBe(401);
    expect(await websocketStatus(`${server.clientWsUrl}?token=${NODE_TOKEN}`)).toBe(401);
    expect(await websocketStatus(server.clientWsUrl, HUB_TEST_ADMIN_TOKEN)).toBe(101);
  });

  it("exposes only liveness and version in the public health response", async () => {
    const server = await listen(await makeHub(HUB_TEST_ADMIN_TOKEN));
    const response = await fetch(`${server.url}/api/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["ok", "version"]);
    expect(body.ok).toBe(true);
  });
});
