import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { MocoHub, startMocoHubServer } from "@moco/hub";
import WebSocket from "ws";
import type { MobileInvitation, MobileInvitationData, MobilePairingProfile, MobilePublicProfile } from "@moco/protocol";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { MobileConnector } from "../packages/hub/src/mobile-connector.js";

const executable = fileURLToPath(new URL(`../packages/hub/native/moco-connector-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-mobile-http-"));
  cleanup.push(() => fs.rmSync(stateDir, { force: true, recursive: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "mobile-test" }] });
  provider.setResponses([() => fauxAssistantMessage([fauxText("已连接")])]);
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, providerId: "openai", config: { stateDir,
    host: "127.0.0.1", authToken: HUB_TEST_ADMIN_TOKEN, envTokens: {}, enableLocalEnv: false,
    workerEnvIds: [], memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "mobile-test", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" } } });
  cleanup.push(() => hub.close());
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0,
    mobileConnector: { binaryPath: executable, systemTailscaleOrigins: [], enableTailscale: false } });
  cleanup.push(() => server.close());
  const request = (pathname: string, method = "GET", body?: unknown, token = HUB_TEST_ADMIN_TOKEN) => fetch(`${server.url}${pathname}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect((await request("/api/devices", "PATCH", { enabled: true })).status).toBe(200);
  const response = await request("/api/mobile/invitations", "POST", { name: "Android test" });
  expect(response.status).toBe(201);
  const invitation = await response.json() as MobileInvitation;
  const qr = new URL(invitation.qrValue);
  const data = JSON.parse(Buffer.from(qr.searchParams.get("data")!, "base64url").toString()) as MobileInvitationData;
  const origin = data.candidates.find((candidate) => candidate.route === "lan")!.origin;
  const pairBody = { invitationId: data.invitationId, invitationToken: data.invitationToken,
    installationId: "f3b43bb5-0cca-4a8a-a6a2-9e5535feb538", attemptId: "d2bf7228-cf5b-4acd-bacb-5ddf71956c96", deviceName: "Android test",
    info: { hostname: "test-android", platform: "android", arch: "arm64", release: "16", cpu: "", memoryBytes: 0, ips: [] } };
  return { hub, server, request, invitation, data, origin, pairBody };
}

function tlsRequest(origin: string, pathname: string, method = "GET", body?: unknown, token?: string) {
  return new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = https.request(new URL(pathname, origin), { method, rejectUnauthorized: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } }, (res) => {
      const buffers: Buffer[] = [];
      res.on("data", (chunk: Buffer) => buffers.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, data: Buffer.concat(buffers).toString() }));
      res.on("error", reject);
    });
    req.setTimeout(8_000, () => req.destroy(new Error("Test request timed out")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function registeredEnv(origin: string, profile: MobilePairingProfile, lease: string) {
  const url = new URL("/ws/env", origin); url.protocol = "wss:";
  const ws = new WebSocket(url, { rejectUnauthorized: false });
  cleanup.push(() => { ws.terminate(); });
  const registered = new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", (raw) => { if (JSON.parse(raw.toString()).type === "hub.registered") resolve(); });
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "env.register", envId: profile.deviceId, name: profile.name,
    rootDir: "", platform: "android", arch: "arm64", capabilities: ["android-device"], executionKind: "native-device",
    connectionLease: lease, token: profile.envToken })));
  await registered;
  return ws;
}

// The Go binary is built by Moco-mobile/tools/build_phase2.sh before this integration suite.
describe.skipIf(!fs.existsSync(executable))("real mobile TLS Hub integration", () => {
  it("keeps the advertised LAN port and TLS identity when the managed process restarts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-mobile-restart-"));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const upstream = http.createServer((_req, res) => res.end("test"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const address = upstream.address() as { port: number };
    const input = { stateDir: directory, hubId: "stable-mobile-hub", upstream: async () => `http://127.0.0.1:${address.port}`,
      options: { binaryPath: executable, enableTailscale: false, systemTailscaleOrigins: [] } };
    const first = new MobileConnector(input);
    cleanup.push(() => first.close());
    const before = await first.status();
    await first.close();
    const second = new MobileConnector(input);
    cleanup.push(() => second.close());
    const after = await second.status();
    expect(after.spkiSHA256).toBe(before.spkiSHA256);
    expect(new URL(after.candidates.find((entry) => entry.route === "lan")!.origin).port)
      .toBe(new URL(before.candidates.find((entry) => entry.route === "lan")!.origin).port);
  });

  it("pairs through managed TLS, recovers the same result, and keeps the public profile credential-free", async () => {
    const f = await fixture();
    expect((await f.request("/api/mobile/pair", "POST", f.pairBody, "")).status).toBe(403);
    const info = await tlsRequest(f.origin, "/api/mobile/info");
    expect(JSON.parse(info.data).hubId).toBe(f.data.hubId);
    const paired = await tlsRequest(f.origin, "/api/mobile/pair", "POST", f.pairBody);
    expect(paired.status).toBe(200);
    const profile = JSON.parse(paired.data) as MobilePairingProfile;
    expect(profile.clientToken !== profile.envToken && profile.clientToken.length > 32).toBe(true);
    const retry = await tlsRequest(f.origin, "/api/mobile/pair", "POST", f.pairBody);
    expect(retry.status).toBe(200);
    const recovered = JSON.parse(retry.data) as MobilePairingProfile;
    expect(recovered.deviceId === profile.deviceId && recovered.clientToken === profile.clientToken && recovered.envToken === profile.envToken).toBe(true);
    const wrong = await tlsRequest(f.origin, "/api/mobile/pair", "POST", { ...f.pairBody, attemptId: "5aac3ff4-3da5-4e89-bcfe-a9b3bcffce65" });
    expect(wrong.status).toBe(409);
    const publicResponse = await tlsRequest(f.origin, "/api/mobile/connection", "GET", undefined, profile.clientToken);
    expect(publicResponse.status).toBe(200);
    const publicProfile = JSON.parse(publicResponse.data) as MobilePublicProfile;
    expect(publicProfile.hubId).toBe(profile.hubId);
    expect(publicResponse.data.includes(profile.clientToken) || publicResponse.data.includes(profile.envToken)).toBe(false);
    expect((await tlsRequest(f.origin, "/api/mobile/connection", "GET", undefined, profile.envToken)).status).toBe(401);
    expect((await f.request(`/api/mobile/invitations/${f.invitation.id}`, "DELETE")).status).toBe(200);
    expect((await tlsRequest(f.origin, "/api/mobile/connection", "GET", undefined, profile.clientToken)).status).toBe(200);
  });

  it("probes both credential roles without replacing the active native Env, then blocks revoked credentials", async () => {
    const f = await fixture();
    const profile = JSON.parse((await tlsRequest(f.origin, "/api/mobile/pair", "POST", f.pairBody)).data) as MobilePairingProfile;
    const lease = JSON.parse((await tlsRequest(f.origin, "/api/mobile/connection/lease", "POST", {}, profile.clientToken)).data).lease as string;
    const env = await registeredEnv(f.origin, profile, lease);
    let activeClosed = false; env.once("close", () => { activeClosed = true; });
    for (const role of ["client", "env"] as const) {
      const url = new URL(`/ws/mobile-probe?role=${role}`, f.origin); url.protocol = "wss:";
      const ws = new WebSocket(url, { rejectUnauthorized: false, headers: { authorization: `Bearer ${role === "client" ? profile.clientToken : profile.envToken}` } });
      await new Promise<void>((resolve, reject) => {
        ws.once("error", reject);
        ws.once("open", () => ws.send("transport-nonce"));
        ws.once("message", (raw) => { if (raw.toString() === "transport-nonce") resolve(); else reject(new Error("Wrong probe echo")); });
      });
      ws.terminate();
    }
    const media = await tlsRequest(f.origin, "/api/mobile/probe/media", "GET", undefined, profile.clientToken);
    expect(media.status).toBe(200);
    expect(media.data).toBe("Moco mobile transport media probe.\n".repeat(2048));
    expect(activeClosed).toBe(false);
    const descriptor = f.hub.envManager.listEnvs().find((entry) => entry.id === profile.deviceId)!;
    expect(descriptor.online && descriptor.executionKind === "native-device").toBe(true);
    expect(() => f.hub.envManager.createExecutionEnv(profile.deviceId, "/")).toThrow();
    expect((await f.request(`/api/devices/${profile.deviceId}`, "DELETE", { force: true })).status).toBe(200);
    expect((await tlsRequest(f.origin, "/api/mobile/connection", "GET", undefined, profile.clientToken)).status).toBe(401);
    expect((await tlsRequest(f.origin, "/api/mobile/pair", "POST", f.pairBody)).status).toBe(401);
  });
});
