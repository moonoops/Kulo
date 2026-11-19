import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvManager } from "@kulo/env";
import { startKuloHubServer, type KuloHub, type KuloHubServer } from "@kulo/hub";
import { MAX_WORKER_SHELL_TIMEOUT_SECONDS } from "../packages/hub/src/tools-worker.js";
import { openTestHub } from "./helpers/secure-hub.js";

const TEST_ADMIN_TOKEN = "kulo-test-admin-token-0123456789abcdef";

const dirs: string[] = [];
const hubs: KuloHub[] = [];
const servers: KuloHubServer[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kulo-p0-${prefix}-`));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0).reverse()) await server.close().catch(() => {});
  for (const hub of hubs.splice(0).reverse()) await hub.close().catch(() => {});
  for (const dir of dirs.splice(0).reverse()) fs.rmSync(dir, { recursive: true, force: true });
});

describe("P0 foundation hardening", () => {
  it("serves a strict Content-Security-Policy header on Hub static HTML pages", async () => {
    const stateDir = tempDir("csp-state");
    const webDist = tempDir("csp-web");
    fs.writeFileSync(
      path.join(webDist, "index.html"),
      '<!doctype html><html><head><script>window.__kuloBoot = 1;</script></head><body><div id="root"></div></body></html>',
    );
    const hub = await openTestHub({
      config: { stateDir, enableLocalEnv: false, authToken: TEST_ADMIN_TOKEN },
    });
    hubs.push(hub);
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0, webDistDir: webDist });
    servers.push(server);

    const res = await fetch(`${server.localUrl}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-src 'self' about:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("'sha256-");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("refuses unsandboxed fallback when createExecutionEnv requests sandboxed: true without worker-isolation", async () => {
    const rootDir = tempDir("nosandbox");
    const envManager = new EnvManager({
      enableLocal: true,
      localRootDir: rootDir,
      authToken: TEST_ADMIN_TOKEN,
    });
    await envManager.start();
    try {
      const localDesc = envManager.getEnvDescriptor("local");
      expect(localDesc).toBeDefined();
      // Simulate host lacking native worker isolation.
      const mutableCaps = localDesc!.capabilities as string[];
      const idx = mutableCaps.indexOf("worker-isolation");
      if (idx >= 0) mutableCaps.splice(idx, 1);

      expect(() => envManager.createExecutionEnv("local", rootDir, { sandboxed: true, offline: true })).toThrow(
        /refusing unsandboxed fallback/i,
      );
    } finally {
      await envManager.close();
    }
  });

  it("exports a bounded worker shell timeout ceiling", () => {
    expect(MAX_WORKER_SHELL_TIMEOUT_SECONDS).toBe(1800);
  });
});
