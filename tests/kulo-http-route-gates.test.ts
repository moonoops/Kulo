import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startKuloHubServer, type KuloHub, type KuloHubServer } from "@kulo/hub";
import { HUB_TEST_ADMIN_TOKEN, fetchWithHubAuth } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function openServer(): Promise<{ hub: KuloHub; server: KuloHubServer }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-http-gates-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = await openTestHub({
    config: {
      stateDir: dir,
      identityDir: path.join(dir, "identity"),
      authToken: HUB_TEST_ADMIN_TOKEN,
      enableLocalEnv: false,
      memory: { enabled: false },
    },
  });
  cleanups.push(() => hub.close());
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.close());
  return { hub, server };
}

describe("Extracted HTTP route plugins preserve auth, handover barrier, route precedence, and origin error codes", () => {
  it("rejects unauthenticated requests with 401 across all extracted route groups", async () => {
    const { server } = await openServer();
    const paths = [
      "/api/projects",
      "/api/capabilities",
      "/api/topics",
      "/api/settings",
      "/api/voice",
      "/api/assistant",
      "/api/connections",
    ];
    for (const p of paths) {
      const res = await fetch(`http://127.0.0.1:${server.port}${p}`);
      expect(res.status, p).toBe(401);
    }
  });

  it("blocks write methods with 503 during cluster handover barrier across extracted route groups", async () => {
    const { hub, server } = await openServer();
    hub.beginHandoverBarrier(30_000);
    try {
      const writes: Array<[string, string]> = [
        ["POST", "/api/projects"],
        ["POST", "/api/topics"],
        ["POST", "/api/topics/root/compact"],
        ["POST", "/api/settings/presentation"],
        ["POST", "/api/assistant/configure"],
        ["POST", "/api/connections"],
        ["POST", "/api/skills/import"],
      ];
      for (const [method, p] of writes) {
        const res = await fetchWithHubAuth(`http://127.0.0.1:${server.port}${p}`, {
          method,
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(res.status, `${method} ${p}`).toBe(503);
        const body = (await res.json()) as { code?: string };
        expect(body.code).toBe("cluster_handover_in_progress");
      }
    } finally {
      hub.releaseHandoverBarrier();
    }
  });

  it("routes /api/settings/model-configuration before generic POST /api/settings/:block and preserves origin error codes", async () => {
    const { server } = await openServer();

    // If S4 generic POST /api/settings/:block shadowed model-configuration-http, this POST would return 404 "Unknown settings block".
    const modelCfgGet = await fetchWithHubAuth(
      `http://127.0.0.1:${server.port}/api/settings/model-configuration?clientId=win-1`,
      { method: "GET" },
    );
    expect(modelCfgGet.status).toBe(200);
    const modelCfgPost = await fetchWithHubAuth(
      `http://127.0.0.1:${server.port}/api/settings/model-configuration/prepare`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(modelCfgPost.status).toBe(400);
    expect(((await modelCfgPost.json()) as { error?: string }).error).not.toContain("Unknown settings block");

    // Preserved cross-site origin error code on permission-settings.
    const permRes = await fetchWithHubAuth(
      `http://127.0.0.1:${server.port}/api/connections/permission-settings`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ kind: "automation" }),
      },
    );
    expect(permRes.status).toBe(403);
    expect(((await permRes.json()) as { code?: string }).code).toBe(
      "connection_permission_settings_origin_required",
    );

    // Preserved cross-site origin error code on connections OAuth.
    const oauthRes = await fetchWithHubAuth(
      `http://127.0.0.1:${server.port}/api/connections/oauth/fake-session/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: "{}",
      },
    );
    expect(oauthRes.status).toBe(403);
    expect(((await oauthRes.json()) as { code?: string }).code).toBe("connection_origin_required");
  });
});
