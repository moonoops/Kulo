import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type {
  EnvNodeDescriptor,
  ExternalAgentQuickConnectResult,
  ExternalAgentResponse,
  ExternalAgentScanResult,
  SkillSnapshot,
} from "@kulo/protocol";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanup: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-direct-settings-http-")));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "openai", models: [{ id: "direct-http" }] }).provider);
  const hub = await openTestHub({
    models,
    config: {
      stateDir: path.join(dir, "state"),
      identityDir: path.join(dir, "identity"),
      localEnvRoot: path.join(dir, "runtime"),
      authToken: HUB_TEST_ADMIN_TOKEN,
      enableLocalEnv: false,
      envTokens: {},
      watchdogMinutes: 0,
      memory: { enabled: false },
      model: { defaultProvider: "openai", defaultModel: "", thinkingLevel: "off", apiKey: "" },
    },
  });
  cleanup.push(() => hub.close());

  const device: EnvNodeDescriptor = {
    id: "mac-local",
    name: "MacMini",
    kind: "local",
    executionKind: "pi-env",
    online: true,
    platform: "darwin",
    arch: "arm64",
    rootDir: path.join(dir, "env"),
    capabilities: ["external-agents", "flow-browser", "worker-isolation"],
    connectedAt: 1,
    lastSeenAt: 1,
  };
  vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => [structuredClone(device)]);
  vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((id) => id === device.id ? structuredClone(device) : undefined);

  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanup.push(() => server.close());

  async function post<T = Record<string, unknown>>(route: string, body: unknown, token: string | null = HUB_TEST_ADMIN_TOKEN) {
    const response = await fetch(`${server.url}${route}`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() as T };
  }

  return { dir, hub, device, post };
}

describe("direct settings HTTP routes without chat detours", () => {
  it("scans local external agent clients and connects them directly even before a chat model is configured", async () => {
    const f = await fixture();
    expect((await f.post("/api/external-clients/scan", {}, null)).status).toBe(401);
    expect((await f.post("/api/external-clients/scan", { bad: true })).status).toBe(400);

    vi.spyOn(f.hub.envManager, "requestExternalAgent").mockImplementation(async (_envId, request): Promise<ExternalAgentResponse> => {
      if (request.operation === "detect") {
        const installed = request.kind === "codex" || request.kind === "antigravity";
        return {
          type: "detection",
          detection: {
            kind: request.kind,
            installed,
            ...(installed ? { executable: `/usr/local/bin/${request.kind}`, version: `${request.kind}-2.0` } : { error: "not found" }),
            authenticated: null,
            models: [],
            capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" },
          },
        };
      }
      if (request.operation === "probe") {
        return {
          type: "detection",
          detection: {
            kind: request.binding.kind,
            installed: true,
            executable: `/usr/local/bin/${request.binding.kind}`,
            version: `${request.binding.kind}-2.0`,
            authenticated: true,
            models: [{ id: "native-1", name: "Native 1", isDefault: true }],
            capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" },
          },
        };
      }
      if (request.operation === "run") {
        const match = request.prompt.match(/KULO_AGENT_VERIFY_[a-f0-9]+/);
        const nonce = match?.[0] ?? "KULO_AGENT_VERIFY_missing";
        return {
          type: "run",
          run: {
            id: request.requestId,
            taskId: request.taskId,
            runEpoch: request.runEpoch,
            kind: request.binding.kind,
            sessionId: "verify-session-1",
            state: "completed",
            quiescent: true,
            text: nonce,
            events: [],
            permissions: [],
            nextSequence: 1,
          },
        };
      }
      if (request.operation === "close") {
        return {
          type: "run",
          run: {
            id: request.runId,
            taskId: "verify",
            runEpoch: 1,
            kind: "codex",
            state: "completed",
            quiescent: true,
            text: "",
            events: [],
            permissions: [],
            nextSequence: 1,
          },
        };
      }
      throw new Error(`Unexpected operation: ${request.operation}`);
    });

    const scanRes = await f.post<ExternalAgentScanResult>("/api/external-clients/scan", {});
    expect(scanRes.status).toBe(200);
    expect(scanRes.value.devices).toEqual([{ id: "mac-local", name: "MacMini", online: true }]);
    const installedKinds = scanRes.value.candidates.filter((item) => item.installed).map((item) => item.kind);
    expect(installedKinds).toEqual(["codex", "antigravity"]);

    const connectRes = await f.post<ExternalAgentQuickConnectResult>("/api/external-clients/connect", {
      clientId: "tab-direct",
      kind: "codex",
      envId: "mac-local",
      commandId: "direct-connect-1",
      runTest: true,
    });
    expect(connectRes.status).toBe(200);
    expect(connectRes.value).toMatchObject({
      kind: "codex",
      envId: "mac-local",
      enabled: true,
      verificationLevel: "roundtrip",
      version: "codex-2.0",
      modelsCount: 1,
    });
    expect(f.hub.getSettingsView().blocks.roles.value[connectRes.value.agentId]?.enabled).toBe(true);

    const afterScan = await f.post<ExternalAgentScanResult>("/api/external-clients/scan", {});
    expect(afterScan.value.candidates.find((item) => item.kind === "codex")).toMatchObject({
      alreadyConnected: true,
      connectedVerified: true,
    });
  });

  it("imports a local skill directly via POST /api/skills/import", async () => {
    const f = await fixture();
    const skillDir = path.join(f.dir, "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: direct-demo\ndescription: Direct skill import test\n---\n\n# Direct Demo\n");

    expect((await f.post("/api/skills/import", { source: skillDir, expectedRevision: 0, commandId: "unauth" }, null)).status).toBe(401);
    const before = await f.hub.skills.snapshot();
    const res = await f.post<SkillSnapshot>("/api/skills/import", {
      source: skillDir,
      expectedRevision: before.revision,
      commandId: "direct-skill-import-1",
    });
    expect(res.status).toBe(200);
    expect(res.value.skills.some((skill) => skill.name === "direct-demo")).toBe(true);
  });

  it("prepares Google Flow directly and creates a browser auth input without LLM turns", async () => {
    const f = await fixture();
    const browserSpy = vi.spyOn(f.hub.envManager, "requestBrowser").mockResolvedValue({
      status: "needs_login",
      profileRef: "flow-direct",
    });
    const res = await f.post<{ capability: { id: string; adapter?: string; allowTaskGeneration: boolean }; input?: { kind: string; envId?: string } }>(
      "/api/capabilities/flow",
      { clientId: "tab-flow", envId: "mac-local", commandId: "direct-flow-1" },
    );
    expect(res.status).toBe(200);
    expect(res.value.capability.allowTaskGeneration).toBe(true);
    expect(res.value.input).toMatchObject({ kind: "browser", envId: "mac-local" });
    expect(browserSpy).toHaveBeenCalled();
  });
});
