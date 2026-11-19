import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ComputerUseResult, EnvNodeDescriptor } from "@moco/protocol";
import { startMocoHubServer } from "../packages/hub/src/server.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanup: Array<() => void | Promise<void>> = [];
const admin = "system-permission-synthetic-management-token";
const nodeToken = "system-permission-synthetic-env-token";
const permissionStates = { platform: "darwin", permissions: [{ kind: "accessibility", state: "denied" }, { kind: "screen", state: "granted" }] };

beforeEach(() => { vi.stubEnv("MOCO_AUTH_TOKEN", ""); vi.stubEnv("MOCO_ENV_TOKENS", ""); });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-system-permission-http-"));
  cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "permission-test", models: [{ id: "permission-test" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: { stateDir, enableLocalEnv: false, authToken: admin, envTokens: { "remote-mac": nodeToken }, memory: { enabled: false } } });
  cleanup.push(() => hub.close());
  let descriptor: EnvNodeDescriptor | undefined = { id: "remote-mac", name: "Remote Mac", kind: "reverse-ws", online: true, platform: "darwin", arch: "arm64", rootDir: "/synthetic-runtime", capabilities: ["agent-desktop"], connectedAt: 1, lastSeenAt: 1 };
  vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((id) => id === "remote-mac" ? descriptor : undefined);
  const execute = vi.spyOn(hub.envManager, "requestComputerUse").mockImplementation(async (_envId, request): Promise<ComputerUseResult> => ({
    tool: request.tool, action: request.action, platform: "darwin", ok: true,
    data: { ...permissionStates, ...(request.action === "permission-guide" ? { guide: "started" } : {}) },
  }));
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanup.push(() => server.close());
  const route = "/api/envs/remote-mac/system-permissions";
  const request = (suffix = "", options: { method?: string; body?: unknown; token?: string; origin?: string; site?: string } = {}) => fetch(`${server.url}${route}${suffix}`, {
    method: options.method ?? "GET", headers: {
      authorization: `Bearer ${options.token ?? admin}`, origin: options.origin ?? server.url,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.site ? { "sec-fetch-site": options.site } : {}),
    }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { hub, server, request, execute, setDescriptor: (next: EnvNodeDescriptor | undefined) => { descriptor = next; }, get descriptor() { return descriptor!; } };
}

describe("system permission management HTTP boundary", () => {
  it("queries the selected execution device without starting a guide", async () => {
    const f = await fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(permissionStates);
    expect(f.execute).toHaveBeenCalledWith("remote-mac", { tool: "desktop", action: "permissions" }, expect.any(AbortSignal));
  });

  it("starts a shared desktop guide only from a validated user request", async () => {
    const f = await fixture();
    const response = await f.request("/guide", { method: "POST", body: { kind: "screen" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...permissionStates, guide: "started" });
    expect(f.execute).toHaveBeenCalledWith("remote-mac", { tool: "desktop", action: "permission-guide" }, expect.any(AbortSignal));
    for (const body of [{}, { kind: "microphone" }, { kind: "screen", request: true }, { kind: "screen;run-arbitrary-command" }]) {
      expect((await f.request("/guide", { method: "POST", body })).status).toBe(400);
    }
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("rejects worker identities and foreign browser origins before native dispatch", async () => {
    const f = await fixture();
    for (const token of [nodeToken, "unrecognized-token"]) {
      expect((await f.request("", { token })).status).toBe(401);
      expect((await f.request("/guide", { token, method: "POST", body: { kind: "accessibility" } })).status).toBe(401);
    }
    for (const options of [{ origin: "https://foreign.example" }, { site: "cross-site" }]) {
      expect((await f.request("", options)).status).toBe(403);
      expect((await f.request("/guide", { ...options, method: "POST", body: { kind: "accessibility" } })).status).toBe(403);
    }
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("reports offline and disabled devices without running a native command", async () => {
    const f = await fixture();
    f.setDescriptor({ ...f.descriptor, online: false });
    const offline = await f.request();
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({ code: "system_permissions_device_offline" });
    f.setDescriptor({ ...f.descriptor, online: true, capabilities: [] });
    const disabled = await f.request();
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ code: "system_permissions_desktop_disabled" });
    f.setDescriptor(undefined);
    expect((await f.request()).status).toBe(404);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("returns unsupported states on non-macOS devices and refuses their guide", async () => {
    const f = await fixture();
    f.setDescriptor({ ...f.descriptor, platform: "linux", capabilities: [] });
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ platform: "linux", permissions: [{ kind: "accessibility", state: "unsupported" }, { kind: "screen", state: "unsupported" }] });
    expect((await f.request("/guide", { method: "POST", body: { kind: "screen" } })).status).toBe(409);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects legacy or malformed device receipts without exposing raw output", async () => {
    const f = await fixture();
    f.execute.mockResolvedValueOnce({ tool: "desktop", action: "permissions", platform: "darwin", ok: false, error: { code: "INVALID_INPUT", message: "native-private-diagnostic" } });
    const legacy = await f.request();
    expect(legacy.status).toBe(502);
    expect(await legacy.json()).toMatchObject({ code: "system_permissions_update_required" });
    f.execute.mockResolvedValueOnce({ tool: "desktop", action: "permissions", platform: "darwin", ok: true, data: { ...permissionStates, private: "native-private-diagnostic" } });
    const malformed = await f.request();
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toMatchObject({ code: "system_permissions_invalid_response" });
    f.execute.mockRejectedValueOnce(new Error("native-private-diagnostic"));
    const disconnected = await f.request();
    expect(disconnected.status).toBe(503);
    expect(await disconnected.text()).not.toContain("native-private-diagnostic");
  });
});
