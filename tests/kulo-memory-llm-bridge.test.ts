import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { MEMORY_LLM_BRIDGE_FILENAME, MEMORY_LLM_BRIDGE_OWNER, MEMORY_LLM_BRIDGE_PATH, startKuloHubServer } from "@kulo/hub";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function fixture(responses: Array<ReturnType<typeof fauxAssistantMessage>>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-memory-bridge-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const faux = fauxProvider({
    provider: "api-vertex",
    models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: true }],
  });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const hub = await openTestHub({
    models,
    config: {
      stateDir: dir,
      identityDir: path.join(dir, "identity"),
      authToken: HUB_TEST_ADMIN_TOKEN,
      envTokens: { node: "node-bridge-token" },
      workerEnvIds: ["node"],
      enableLocalEnv: false,
      memory: { enabled: false },
      model: { defaultProvider: "api-vertex", defaultModel: "gemini-3.8-flash", apiKey: "" },
    },
  });
  cleanup.push(() => hub.close());
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanup.push(() => server.close());
  return { dir, hub, server, faux };
}

describe("Kulo Hub loopback memory LLM bridge", () => {
  it("publishes a private loopback bridge descriptor, enforces token and proxy isolation, and executes model calls", async () => {
    const { dir, server } = await fixture([
      fauxAssistantMessage([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "{\"facts\":[\"hello\"]}" }]),
    ]);
    const descriptorPath = path.join(dir, MEMORY_LLM_BRIDGE_FILENAME);
    const stat = fs.statSync(descriptorPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8")) as { owner: string; url: string; token: string };
    expect(descriptor.owner).toBe(MEMORY_LLM_BRIDGE_OWNER);
    expect(descriptor.url).toBe(`http://127.0.0.1:${server.port}${MEMORY_LLM_BRIDGE_PATH}`);
    expect(descriptor.token.length).toBeGreaterThanOrEqual(64);
    expect(descriptor.token).not.toBe(HUB_TEST_ADMIN_TOKEN);

    const payload = {
      providerId: "api-vertex",
      modelId: "gemini-3.8-flash",
      messages: [
        { role: "system", content: "Extract facts." },
        { role: "user", content: "I use Vertex AI." },
      ],
      responseSchema: {
        name: "Facts",
        strict: true,
        schema: { type: "object", properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] },
      },
      maxCompletionTokens: 512,
    };

    // Admin token, node token, missing token, and mobile connector proxy headers are all rejected.
    for (const headers of [
      {},
      { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      { Authorization: "Bearer node-bridge-token" },
      { Authorization: `Bearer ${descriptor.token}`, "x-kulo-connector": "spoof" },
      { Authorization: `Bearer ${descriptor.token}`, "x-moco-connector": "spoof" },
    ]) {
      const denied = await fetch(descriptor.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });
      expect(denied.status).toBe(401);
    }

    // Extra secret/override fields are rejected.
    const extraField = await fetch(descriptor.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({ ...payload, apiKey: "forbidden" }),
    });
    expect(extraField.status).toBe(400);

    // Valid bridge call succeeds and returns only final visible text (excluding thinking blocks).
    const ok = await fetch(descriptor.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify(payload),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { text: string; stopReason: string; provider: string; model: string };
    expect(body.text).toBe("{\"facts\":[\"hello\"]}");
    expect(body.stopReason).toBe("stop");
    expect(body.provider).toBe("api-vertex");
    expect(body.model).toBe("gemini-3.8-flash");

    // Closing the server cleans up the bridge descriptor file.
    await server.close();
    expect(fs.existsSync(descriptorPath)).toBe(false);
  });

  it("returns 404 for unknown models and exposes structured auth errors cleanly", async () => {
    const { dir } = await fixture([
      fauxAssistantMessage("403 Unauthorized: API key not valid", { stopReason: "error", errorMessage: "403 Unauthorized: API key not valid" }),
    ]);
    const descriptor = JSON.parse(fs.readFileSync(path.join(dir, MEMORY_LLM_BRIDGE_FILENAME), "utf8")) as { url: string; token: string };

    const missing = await fetch(descriptor.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({ providerId: "api-vertex", modelId: "no-such-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe("model_not_found");

    const authErr = await fetch(descriptor.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({ providerId: "api-vertex", modelId: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(authErr.status).toBe(403);
    expect((await authErr.json() as { error: { code: string; retryable: boolean } }).error).toMatchObject({ code: "auth", retryable: false });
  });
});
