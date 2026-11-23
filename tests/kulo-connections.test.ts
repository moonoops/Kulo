import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KuloConnections, type ConnectionVault } from "../packages/hub/src/connections.js";
import { LocalConnectionVault } from "../packages/hub/src/connection-vault.js";
import { SecureCredentialStore } from "../packages/hub/src/secure-provider-credentials.js";
import type { ConnectionExecutionBackend } from "../packages/hub/src/connection-execution.js";
import { formatDeviceChatInvitation, type ConnectionSaveRequest } from "@kulo/protocol";

const directories: string[] = [];
class MemoryVault implements ConnectionVault {
  readonly values = new Map<string, Record<string, string>>();
  available = true;
  async get(ref: string) { return this.values.get(ref) && structuredClone(this.values.get(ref)!); }
  async set(ref: string, fields: Record<string, string>) { if (!this.available) throw new Error("vault unavailable"); this.values.set(ref, structuredClone(fields)); }
  async delete(ref: string) { this.values.delete(ref); }
  async entries() { return [...this.values].map(([ref, fields]) => ({ ref, fields: structuredClone(fields) })); }
  async refs() { return [...this.values.keys()]; }
  async ready() { return { available: this.available, ...(!this.available ? { error: "系统密钥库已锁定。" } : {}) }; }
}
function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-connections-")); directories.push(stateDir);
  const vault = new MemoryVault();
  const executor: ConnectionExecutionBackend = {
    scan: vi.fn(async () => ({ fingerprint: "ssh-ed25519 SHA256:synthetic-fingerprint", lines: ["synthetic-public-host-key"] })),
    trust: vi.fn(async () => undefined),
    execute: vi.fn(async (_record, _secrets, operation) => operation.kind === "ssh" ? { kind: "ssh", exitCode: 0, output: "done" } : { kind: "http", status: 200, output: "done" }),
  };
  const manager = new KuloConnections({ stateDir, vault, executor });
  return { stateDir, vault, executor, manager };
}
const api = (extra: Partial<ConnectionSaveRequest> = {}): ConnectionSaveRequest => ({ name: "代码服务", kind: "api-key", url: "https://api.example.test/v1", secrets: { apiKey: "synthetic-test-api-secret" }, ...extra });
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("connection authorization records", () => {
  it("keeps secrets outside public records and the metadata file, and exposes no inputs without an owning client", async () => {
    const f = fixture();
    const card = await f.manager.save(api());
    await f.manager.prepare({ clientId: "window-one", kind: "ssh", name: "服务器" });
    expect(card).toMatchObject({ status: "saved", hasCredential: true, secretFields: ["apiKey"] });
    const snapshot = await f.manager.snapshot();
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.inputs).toEqual([]);
    expect((await f.manager.snapshot("window-one")).inputs).toHaveLength(1);
    for (const serialized of [JSON.stringify(snapshot), fs.readFileSync(path.join(f.stateDir, "connections.json"), "utf8")]) {
      expect(serialized).not.toContain("synthetic-test-api-secret");
    }
  });
  it("preserves a saved incomplete account while filling its first endpoint and username", async () => {
    const f = fixture();
    const initial = await f.manager.save({ name: "工作账号", kind: "account", secrets: { password: "synthetic-account-password" } });
    expect(initial.status).toBe("incomplete");
    const completed = await f.manager.save({ ...initial, expectedRevision: initial.revision, url: "https://accounts.example.test", username: "person" });
    expect(completed).toMatchObject({ status: "saved", hasCredential: true });
    f.manager.grant("T-1", 1, [completed.id]);
    await f.manager.use("T-1", 1, completed.id, { kind: "http", path: "/profile" });
    expect(f.executor.execute).toHaveBeenCalledWith(expect.objectContaining({ id: completed.id }), expect.objectContaining({ password: "synthetic-account-password" }), expect.anything(), expect.any(AbortSignal));
  });
  it("clears credentials when an established endpoint or user changes, and rejects stale edits", async () => {
    const f = fixture(), first = await f.manager.save(api());
    const changed = await f.manager.save({ ...first, expectedRevision: first.revision, url: "https://another.example.test" });
    expect(changed).toMatchObject({ status: "incomplete", hasCredential: false });
    expect(await f.vault.get(`connection:${first.id}`)).toBeUndefined();
    await expect(f.manager.save({ ...first, expectedRevision: first.revision, name: "旧编辑" })).rejects.toMatchObject({ code: "connection_conflict", status: 409 });
  });
  it("retains same-origin credentials across path edits and rejects tampered metadata at use", async () => {
    const f = fixture(), first = await f.manager.save(api());
    const changed = await f.manager.save({ ...first, expectedRevision: first.revision, url: "https://api.example.test/v2" });
    expect(changed.hasCredential).toBe(true);
    const filename = path.join(f.stateDir, "connections.json"), doc = JSON.parse(fs.readFileSync(filename, "utf8"));
    doc.connections[first.id].url = "https://attacker.example.test";
    fs.writeFileSync(filename, JSON.stringify(doc));
    const reopened = new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor });
    reopened.grant("T-1", 1, [first.id]);
    await expect(reopened.use("T-1", 1, first.id, { kind: "http", path: "/" })).rejects.toMatchObject({ code: "connection_credential_mismatch" });
    expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it("binds secure inputs to their window and makes successful submission replay safe", async () => {
    const f = fixture(), input = await f.manager.prepare({ clientId: "window-one", kind: "api-key" });
    await expect(f.manager.submitInput(input.id, "window-two", api())).rejects.toMatchObject({ status: 403 });
    const saved = await f.manager.submitInput(input.id, "window-one", api());
    const replay = await f.manager.submitInput(input.id, "window-one", api({ secrets: { apiKey: "synthetic-replay-secret" } }));
    expect(replay.id).toBe(saved.id);
    expect((await f.vault.get(`connection:${saved.id}`))?.apiKey).toBe("synthetic-test-api-secret");
    expect((await f.manager.snapshot("window-one")).inputs[0]?.status).toBe("completed");
  });
  it("imports explicitly requested pasted credentials once and returns only a redacted save receipt", async () => {
    const f = fixture();
    const raw = "请记住这个账号，网站：https://accounts.example.test，账号：person，密码：synthetic-pasted-password";
    const first = await f.manager.processText(raw, { requestId: "topic-one:request-one" });
    const repeated = await f.manager.processText(raw, { requestId: "topic-one:request-one" });
    expect(first.saved).toBe(true);
    expect(first.connectionIds).toHaveLength(1);
    expect(repeated.connectionIds).toEqual(first.connectionIds);
    expect(first.text).toContain("连接已安全保存");
    expect(first.text).not.toContain("synthetic-pasted-password");
    const snapshot = await f.manager.snapshot();
    expect(snapshot.connections).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-pasted-password");
    expect(fs.readFileSync(path.join(f.stateDir, "connections.json"), "utf8")).not.toContain("synthetic-pasted-password");
    expect(f.manager.redact("echo synthetic-pasted-password")).not.toContain("synthetic-pasted-password");
  });
  it("redacts unrequested definite credentials without silently creating a connection card", async () => {
    const f = fixture();
    const secretKey = "sk-proj-synthetic-temporary-secret-0123456789";
    const receipt = await f.manager.processText(`调试参数 API_KEY=${secretKey}`);
    expect(receipt.text).not.toContain(secretKey);
    expect(receipt.saved).toBe(false);
    expect((await f.manager.snapshot()).connections).toEqual([]);
  });
  it("removes invitation echoes from replied-to save requests before credential storage", async () => {
    const f = fixture();
    const inviteToken = "synthetic-quoted-device-invitation";
    const replyText = formatDeviceChatInvitation({ hubUrl: "http://host.example.test", hubId: "test-hub", hubName: "测试主机", inviteToken });
    const receipt = await f.manager.processText(`请帮我保存这段信息，配对号是 ${inviteToken}`, { replyText });
    expect(receipt.text.includes(inviteToken)).toBe(false);
    expect(JSON.stringify(await f.vault.entries()).includes(inviteToken)).toBe(false);
    expect(f.manager.redact(replyText).includes(inviteToken)).toBe(false);
  });
  it("keeps unrequested prose labels, generated passwords, and CLI flags readable while hiding saved secrets", async () => {
    const f = fixture();
    await f.manager.save({ name: "已存账号", kind: "account", username: "demo", url: "https://example.test", secrets: { password: "saved-vault-password-7788" } });
    for (const sample of [
      "命令中包含配对令牌 `example_invite_token_123456`",
      "为你生成的随机密码：K9#mP2$vL8qR4wX1",
      "kulo env --token node-demo-token",
      "Here is a basic configuration for Bearer authentication",
    ]) {
      expect(f.manager.redact(sample)).toBe(sample);
      const receipt = await f.manager.processText(sample);
      expect(receipt.text).toBe(sample);
      expect(receipt.saved).toBe(false);
    }
    expect(f.manager.redact("回显 saved-vault-password-7788")).toBe("回显 [已隐藏]");
  });
  it("fails closed when the native vault is unavailable and stores no metadata", async () => {
    const f = fixture(); f.vault.available = false;
    await expect(f.manager.save(api())).rejects.toThrow();
    expect((await f.manager.snapshot()).connections).toEqual([]);
    expect(fs.existsSync(path.join(f.stateDir, "connections.json"))).toBe(false);
  });
  it("restores an existing credential when a vault write fails after replacing its bytes", async () => {
    const f = fixture(), original = await f.manager.save(api());
    const set = f.vault.set.bind(f.vault);
    f.vault.set = vi.fn(async (ref, fields) => { await set(ref, fields); if (fields.apiKey === "synthetic-failing-replacement") throw new Error("post-rename fixture failure"); });
    await expect(f.manager.save({ ...original, expectedRevision: original.revision, secrets: { apiKey: "synthetic-failing-replacement" } })).rejects.toThrow("post-rename fixture failure");
    expect((await f.vault.get(`connection:${original.id}`))?.apiKey).toBe("synthetic-test-api-secret");
    expect((await f.manager.snapshot()).connections[0]?.revision).toBe(original.revision);
  });
  it("loads actual durable, memory and media secrets without registering their descriptive metadata", async () => {
    const f = fixture();
    await f.vault.set("durable-secret:test", { value: "synthetic-settings-secret" });
    await f.vault.set("memory-service:test", { apiKey: "synthetic-memory-secret", origin: "https://memory.example.test" });
    await f.vault.set("media:test", { key: "synthetic-media-secret", model: "media-model" });
    await f.manager.initialize();
    for (const secret of ["synthetic-settings-secret", "synthetic-memory-secret", "synthetic-media-secret"]) expect(f.manager.redact(secret)).not.toContain(secret);
    expect(f.manager.redact("使用 https://memory.example.test 和 media-model")).toBe("使用 https://memory.example.test 和 media-model");
  });
  it("lets the provider owner register actual keys while keeping public provider IDs and backup descriptors readable", async () => {
    const f = fixture(), keyStore = { getOrCreateKey: async () => Buffer.alloc(32, 45), checkAvailability: async () => undefined };
    const vault = new LocalConnectionVault({ stateDir: f.stateDir, keyStore });
    const store = new SecureCredentialStore({ vault, legacyPath: path.join(f.stateDir, "credentials.json") });
    await store.modify("openai", async () => ({ type: "api_key", key: "synthetic-owned-provider-secret", env: { KULO_API_KEY_ORIGIN: "https://api.example.test" } }));
    const manager = new KuloConnections({ stateDir: f.stateDir, vault, executor: f.executor });
    await manager.initialize();
    const reopenedStore = new SecureCredentialStore({ vault, legacyPath: path.join(f.stateDir, "credentials.json"), onSecrets: (values) => manager.rememberSecrets(values) });
    await reopenedStore.initialize();
    expect(manager.redact("请使用 openai 模型处理这个任务")).toBe("请使用 openai 模型处理这个任务");
    expect(manager.redact("https://api.example.test")).toBe("https://api.example.test");
    expect(manager.redact("synthetic-owned-provider-secret")).not.toContain("synthetic-owned-provider-secret");
    const other = fixture();
    await other.vault.set("legacy-provider-backup:fixture", { format: "legacy-provider-temp-v1", name: "credentials.json.fixture.tmp", chunks: '["fixture-chunk"]', digest: "f".repeat(64) });
    await other.manager.initialize();
    expect(other.manager.redact("保留 legacy-provider-temp-v1 和 credentials.json.fixture.tmp 标记")).toBe("保留 legacy-provider-temp-v1 和 credentials.json.fixture.tmp 标记");
    for (const metadata of ['["fixture-chunk"]', "f".repeat(64)]) expect(other.manager.redact(metadata)).toBe(metadata);
  });
  it("refuses metadata symlinks without reading or replacing their targets", () => {
    const f = fixture(), outside = path.join(f.stateDir, "outside.json");
    fs.writeFileSync(outside, "synthetic-untouched-content");
    fs.symlinkSync(outside, path.join(f.stateDir, "connections.json"));
    expect(() => new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor })).toThrow("连接记录路径无效");
    expect(fs.readFileSync(outside, "utf8")).toBe("synthetic-untouched-content");
  });
  it("switches SSH methods without retaining the previously selected key or password", async () => {
    const f = fixture(), key = "-----BEGIN OPENSSH PRIVATE KEY-----\nc3ludGhldGljLXRlc3Qta2V5\n-----END OPENSSH PRIVATE KEY-----";
    const initial = await f.manager.save({ name: "服务器", kind: "ssh", host: "server.example.test", username: "kulo", secrets: { privateKey: key, passphrase: "synthetic-old-passphrase" } });
    const changed = await f.manager.save({ ...initial, expectedRevision: initial.revision, secrets: { password: "synthetic-replacement-password" } });
    expect(changed.secretFields).toEqual(["password"]);
    expect(await f.vault.get(`connection:${initial.id}`)).toMatchObject({ password: "synthetic-replacement-password" });
    expect((await f.vault.get(`connection:${initial.id}`))?.privateKey).toBeUndefined();
    const restored = await f.manager.save({ ...changed, expectedRevision: changed.revision, secrets: { privateKey: key } });
    expect(restored.secretFields).toEqual(["privateKey"]);
    expect((await f.vault.get(`connection:${initial.id}`))?.password).toBeUndefined();
  });
});

describe("task scoped connection access", () => {
  it("denies ungranted and stale runs, and restricts read-only workers", async () => {
    const f = fixture(), card = await f.manager.save(api());
    await expect(f.manager.use("T-1", 1, card.id, { kind: "http", path: "/" })).rejects.toMatchObject({ status: 403 });
    f.manager.grant("T-1", 1, [card.id]);
    await expect(f.manager.use("T-1", 2, card.id, { kind: "http", path: "/" })).rejects.toMatchObject({ status: 403 });
    await expect(f.manager.use("T-1", 1, card.id, { kind: "http", path: "/", method: "POST" }, { readOnly: true })).rejects.toMatchObject({ code: "connection_read_only" });
    await f.manager.use("T-1", 1, card.id, { kind: "http", path: "/", method: "GET" }, { readOnly: true });
    f.manager.revoke("T-1");
    expect(f.manager.hasGrant("T-1", 1, card.id)).toBe(false);
  });
  it("keeps a parked worker request pending across runtime release and restart", async () => {
    const f = fixture(), card = await f.manager.save(api());
    const request = f.manager.requestAccess({ ticketId: "T-1", conversationId: 5, runEpoch: 1, connectionId: card.id, reason: "查询构建", requestId: "call-one" });
    expect(request.status).toBe("pending");
    f.manager.revoke("T-1");
    expect(f.manager.getRequest(request.id)?.status).toBe("pending");
    const reopened = new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor });
    expect(reopened.getRequest(request.id)?.status).toBe("pending");
    expect(reopened.decide(request.id, true).status).toBe("approved");
    expect(reopened.hasGrant("T-1", 1, card.id)).toBe(true);
  });
  it("revokes and persists actual card deletion, rejecting subsequent replay", async () => {
    const f = fixture(), card = await f.manager.save(api());
    f.manager.grant("T-1", 1, [card.id]);
    const request = f.manager.requestAccess({ ticketId: "T-2", conversationId: 6, runEpoch: 1, connectionId: card.id, reason: "查询", requestId: "call-two" });
    await f.manager.remove(card.id);
    expect((await f.manager.snapshot()).connections).toEqual([]);
    expect(f.manager.hasGrant("T-1", 1, card.id)).toBe(false);
    expect(f.manager.getRequest(request.id)?.status).toBe("revoked");
    await expect(f.manager.use("T-1", 1, card.id, { kind: "http", path: "/" })).rejects.toMatchObject({ status: 403 });
    const reopened = new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor });
    expect((await reopened.snapshot()).connections).toEqual([]);
    expect(await f.vault.get(`connection:${card.id}`)).toBeUndefined();
  });
  it("aborts active connection operations when the grant is revoked", async () => {
    const f = fixture(), card = await f.manager.save(api());
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    f.executor.execute = vi.fn(async (_record, _secrets, _operation, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); started();
    }));
    f.manager.grant("T-1", 1, [card.id]);
    const execution = f.manager.use("T-1", 1, card.id, { kind: "http", path: "/" });
    await ready; f.manager.revoke("T-1");
    await expect(execution).rejects.toThrow();
    expect(f.manager.hasGrant("T-1", 1, card.id)).toBe(false);
  });
  it("redacts a provider echo from a trusted execution result", async () => {
    const f = fixture(), card = await f.manager.save(api());
    f.executor.execute = vi.fn(async () => ({ kind: "http", status: 200, output: "echo synthetic-test-api-secret" }));
    f.manager.grant("T-1", 1, [card.id]);
    expect((await f.manager.use("T-1", 1, card.id, { kind: "http", path: "/" })).output).not.toContain("synthetic-test-api-secret");
  });
  it("requires explicit host trust before SSH credentials can be used", async () => {
    const f = fixture(), card = await f.manager.save({ name: "测试服务器", kind: "ssh", host: "server.example.test", username: "kulo", secrets: { password: "synthetic-ssh-password" } });
    f.manager.grant("T-1", 1, [card.id]);
    await expect(f.manager.use("T-1", 1, card.id, { kind: "ssh", command: "true" })).rejects.toMatchObject({ code: "connection_host_untrusted" });
    const scan = await f.manager.test(card.id);
    expect(scan.requiresTrust).toBe(true);
    await expect(f.manager.trust(card.id, "wrong-fingerprint")).rejects.toMatchObject({ code: "connection_host_scan_expired" });
    await f.manager.trust(card.id, scan.fingerprint!);
    expect((await f.manager.test(card.id)).connection.status).toBe("verified");
    await f.manager.use("T-1", 1, card.id, { kind: "ssh", command: "true" });
    expect(f.executor.trust).toHaveBeenCalledTimes(1);
  });
  it("normalizes CRLF OpenSSH private keys on save, persists scan failures with errorCode, and recovers missing known-hosts without silently accepting a changed key", async () => {
    const f = fixture({ platform: "darwin" });
    const clearTrustedHost = vi.fn();
    let hasKnownHostFile = true;
    f.executor.hasTrustedHost = vi.fn(() => hasKnownHostFile);
    f.executor.clearTrustedHost = clearTrustedHost;

    const card = await f.manager.save({
      name: "KuloStation",
      kind: "ssh",
      host: "10.0.0.10",
      username: "demo",
      secrets: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\r\nZmFrZS1rZXk=\r\n-----END OPENSSH PRIVATE KEY-----\r\n" },
    });
    const savedVault = (await f.vault.entries()).find((e) => e.ref === `connection:${card.id}`)!;
    expect(savedVault.fields.privateKey).toBe("-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END OPENSSH PRIVATE KEY-----\n");

    // 1. Scan failure persists status='error' and returns structured errorCode
    vi.mocked(f.executor.scan).mockRejectedValueOnce(Object.assign(new Error("blocked"), { code: "connection_local_network_blocked" }));
    const blocked = await f.manager.test(card.id);
    expect(blocked.connection.status).toBe("error");
    expect(blocked.errorCode).toBe("connection_local_network_blocked");

    // 2. Normal first scan + trust keeps revision
    const firstScan = await f.manager.test(card.id);
    expect(firstScan.requiresTrust).toBe(true);
    const trusted = await f.manager.trust(card.id, firstScan.fingerprint!);
    expect(trusted.revision).toBe(card.revision);
    f.manager.grant("T-ssh", 1, [card.id]);

    // 3. Standby failover loses local known-hosts file; rescanning SAME key preserves revision
    hasKnownHostFile = false;
    const recoveredScan = await f.manager.test(card.id);
    expect(recoveredScan.requiresTrust).toBe(true);
    expect(recoveredScan.hostMismatch).toBeUndefined();
    const reTrustedSame = await f.manager.trust(card.id, recoveredScan.fingerprint!);
    expect(reTrustedSame.revision).toBe(card.revision);
    expect(f.manager.hasGrant("T-ssh", 1, card.id)).toBe(true);

    // 4. Missing known-hosts encountering a CHANGED key (potential MITM) flags hostMismatch and revokes grants
    vi.mocked(f.executor.scan).mockResolvedValueOnce({ fingerprint: "ssh-ed25519 SHA256:changed-attacker", lines: ["kulo ssh-ed25519 AAAA"] });
    const mitmScan = await f.manager.test(card.id);
    expect(mitmScan.requiresTrust).toBe(true);
    expect(mitmScan.hostMismatch).toBe(true);
    expect(mitmScan.previousFingerprint).toBe(firstScan.fingerprint);
    expect(mitmScan.errorCode).toBe("connection_host_mismatch");
    expect(f.manager.hasGrant("T-ssh", 1, card.id)).toBe(false);

    // 5. Explicit rescan + trust of a changed key increments revision and revokes active grants
    hasKnownHostFile = true;
    f.manager.grant("T-ssh-2", 1, [card.id]);
    f.executor.probeSsh = vi.fn(async () => ({ exitCode: 255, stderr: "REMOTE HOST IDENTIFICATION HAS CHANGED!", output: "" }));
    const mismatchTest = await f.manager.test(card.id);
    expect(mismatchTest.hostMismatch).toBe(true);
    expect(mismatchTest.errorCode).toBe("connection_host_mismatch");
    expect(f.manager.hasGrant("T-ssh-2", 1, card.id)).toBe(false);

    vi.mocked(f.executor.scan).mockResolvedValueOnce({ fingerprint: "ssh-ed25519 SHA256:reinstalled-host", lines: ["kulo ssh-ed25519 BBBB"] });
    const rescan = await f.manager.test(card.id, { rescan: true });
    expect(rescan.requiresTrust).toBe(true);
    expect(rescan.hostMismatch).toBe(true);
    expect(rescan.previousFingerprint).toBe(firstScan.fingerprint);
    f.manager.grant("T-ssh-3", 1, [card.id]);
    const reTrustedNew = await f.manager.trust(card.id, rescan.fingerprint!);
    expect(reTrustedNew.revision).toBe(card.revision + 1);
    expect(f.manager.hasGrant("T-ssh-3", 1, card.id)).toBe(false);

    // 6. Changing host without re-entering secrets fails cleanly without deleting vault secret; with new secret it cleans up known-hosts
    await expect(f.manager.save({ ...reTrustedNew, expectedRevision: reTrustedNew.revision, host: "10.0.0.11" })).rejects.toMatchObject({
      code: "connection_ssh_secret_required_on_target_change",
      status: 400,
    });
    expect((await f.vault.get(`connection:${card.id}`))?.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    await f.manager.save({ ...reTrustedNew, expectedRevision: reTrustedNew.revision, host: "10.0.0.11", secrets: { password: "new-host-password" } });
    expect(clearTrustedHost).toHaveBeenCalledTimes(1);
    await f.manager.remove(card.id);
    expect(clearTrustedHost).toHaveBeenCalledTimes(2);
  });
  it("preserves verified status on SSH rename, enforces in-use guard on remove and kind change, and resolves verified SSH credentials for devices", async () => {
    const f = fixture();
    let knownHostReady = false;
    const knownHostsPath = path.join(f.stateDir, "connection-runtime", "trusted.known-hosts");
    f.executor.hasTrustedHost = vi.fn(() => knownHostReady);
    f.executor.trustedHostPath = vi.fn(() => knownHostReady ? knownHostsPath : undefined);
    f.executor.probeSsh = vi.fn(async () => ({ exitCode: 0, stderr: "", output: "" }));
    const events: Array<{ type: string; connectionId: string }> = [];
    f.manager.setOnSshChangedHook((event) => events.push(event));

    const card = await f.manager.save({
      name: "Workstation", kind: "ssh", host: "192.0.2.50", port: 22, username: "demo",
      secrets: { password: "station-password-1" },
    });
    // Unverified credential is rejected for device onboarding (1B)
    await expect(f.manager.resolveSshForDevice(card.id)).rejects.toMatchObject({ code: "connection_ssh_unverified", status: 409 });

    const scan = await f.manager.test(card.id);
    await f.manager.trust(card.id, scan.fingerprint!);
    knownHostReady = true;
    const verified = await f.manager.test(card.id);
    expect(verified.connection.status).toBe("verified");
    expect(events.at(-1)).toEqual({ type: "verified", connectionId: card.id });

    // Pure display-name edit keeps verified status
    const renamed = await f.manager.save({
      ...verified.connection,
      expectedRevision: verified.connection.revision,
      name: "KuloStation 主机",
    });
    expect(renamed.status).toBe("verified");

    // Verified + trusted credential resolves cleanly for devices
    const resolved = await f.manager.resolveSshForDevice(card.id);
    expect(resolved.knownHostsPath).toBe(knownHostsPath);
    expect(resolved.secrets.password).toBe("station-password-1");

    // Missing known-hosts file blocks resolution even when status is verified
    knownHostReady = false;
    await expect(f.manager.resolveSshForDevice(card.id)).rejects.toMatchObject({ code: "connection_host_untrusted", status: 409 });
    knownHostReady = true;

    // In-use guard blocks both remove() and cross-kind save()
    f.manager.setSshInUseGuard((id) => {
      if (id === card.id) throw Object.assign(new Error("设备正在使用"), { code: "connection_in_use_by_device", status: 409 });
    });
    await expect(f.manager.remove(card.id)).rejects.toMatchObject({ code: "connection_in_use_by_device", status: 409 });
    await expect(f.manager.save({
      name: renamed.name, id: card.id, expectedRevision: renamed.revision, kind: "account",
      url: "https://example.test", username: "demo", secrets: { password: "other-password" },
    })).rejects.toMatchObject({ code: "connection_in_use_by_device", status: 409 });

    // Rotating password emits credentials-rotated
    const rotated = await f.manager.save({
      ...renamed,
      expectedRevision: renamed.revision,
      secrets: { password: "station-password-2" },
    });
    expect(rotated.status).toBe("saved");
    expect(events.at(-1)).toEqual({ type: "credentials-rotated", connectionId: card.id });
    // Restore resolution still works with rotated password when host key remains trusted
    const restored = await f.manager.resolveSshForDevice(card.id, { requireVerified: false });
    expect(restored.secrets.password).toBe("station-password-2");
  });
  it("rejects a stale authorization when a user edit lands after the parent's preflight snapshot", async () => {
    const f = fixture(), card = await f.manager.save(api());
    const parentPreflight = { [card.id]: card.revision };
    await f.manager.save({ ...card, expectedRevision: card.revision, name: "修改后的连接" });
    expect(() => f.manager.grant("T-1", 1, [card.id], parentPreflight)).toThrow("连接已被修改");
    expect(f.manager.hasGrant("T-1", 1, card.id)).toBe(false);
    expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it("rechecks the granted revision after an asynchronous vault read", async () => {
    const f = fixture(), card = await f.manager.save(api());
    f.manager.grant("T-1", 1, [card.id], { [card.id]: card.revision });
    const originalGet = f.vault.get.bind(f.vault);
    let unblock!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    f.vault.get = vi.fn(async (ref) => { const found = await originalGet(ref); entered(); await gate; return found; });
    const execution = f.manager.use("T-1", 1, card.id, { kind: "http", path: "/" });
    await started;
    f.vault.get = originalGet;
    await f.manager.save({ ...card, expectedRevision: card.revision, name: "修改后的连接" });
    unblock();
    await expect(execution).rejects.toMatchObject({ code: "connection_access_revoked" });
    expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it("aborts an in-flight connection test when its card is removed", async () => {
    const f = fixture(), card = await f.manager.save(api());
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    f.executor.execute = vi.fn(async (_record, _secrets, _operation, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true }); started();
    }));
    const execution = f.manager.test(card.id);
    await ready;
    await f.manager.remove(card.id);
    await expect(execution).rejects.toThrow();
    expect(aborted).toBe(true);
    expect((await f.manager.snapshot()).connections).toEqual([]);
  });
  it("fences a stop during the awaited caller check even if a late lazy grant restores the old epoch", async () => {
    const f = fixture(), card = await f.manager.save(api());
    f.manager.grant("T-1", 1, [card.id], { [card.id]: card.revision });
    let unblock!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const execution = f.manager.use("T-1", 1, card.id, { kind: "http", path: "/" }, { assertActive: async () => { entered(); await gate; } });
    await started;
    f.manager.cancelRequests("T-1");
    // Simulate an old parent snapshot completing after the task was already stopped.
    f.manager.grant("T-1", 1, [card.id], { [card.id]: card.revision });
    unblock();
    await expect(execution).rejects.toMatchObject({ code: "connection_access_revoked" });
    expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it("registers cancellation before reading the vault and never executes after a stop during that read", async () => {
    const f = fixture(), card = await f.manager.save(api());
    f.manager.grant("T-1", 1, [card.id]);
    const originalGet = f.vault.get.bind(f.vault);
    let unblock!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    f.vault.get = vi.fn(async (ref) => { const found = await originalGet(ref); entered(); await gate; return found; });
    const assertActive = vi.fn(async () => undefined);
    const execution = f.manager.use("T-1", 1, card.id, { kind: "http", path: "/" }, { assertActive });
    await started;
    f.manager.cancelRequests("T-1");
    f.manager.grant("T-1", 1, [card.id]);
    unblock();
    await expect(execution).rejects.toMatchObject({ code: "connection_access_revoked" });
    expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it("fences shutdown during an awaited caller check and rejects late grants and new operations", async () => {
    const f = fixture(), card = await f.manager.save(api());
    f.manager.grant("T-1", 1, [card.id]);
    let unblock!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const execution = f.manager.use("T-1", 1, card.id, { kind: "http", path: "/" }, { assertActive: async () => { entered(); await gate; } });
    await started;
    f.manager.close();
    expect(() => f.manager.grant("T-1", 1, [card.id])).toThrow("连接服务已关闭");
    await expect(f.manager.test(card.id)).rejects.toMatchObject({ code: "connection_manager_closed" });
    await expect(f.manager.use("T-1", 1, card.id, { kind: "http", path: "/" })).rejects.toMatchObject({ code: "connection_manager_closed" });
    unblock();
    await expect(execution).rejects.toMatchObject({ code: "connection_manager_closed" });
    expect(f.executor.execute).not.toHaveBeenCalled();
  });
});

describe("custom credential cards", () => {
  const custom = (): ConnectionSaveRequest => ({ name: "制品平台凭据", kind: "custom", typeLabel: "内部制品平台", instructions: "用于同步制品。\n按项目选择资源。",
    credentialFields: [{ key: "tenant", label: "租户标识" }, { key: "proof", label: "设备证明" }],
    secrets: { tenant: "opaque-tenant-value", proof: "opaque-proof-line-one\nopaque-proof-line-two" } });
  it("persists arbitrary multiline fields encrypted and restores every value for redaction after restart", async () => {
    const f = fixture(), keyStore = { getOrCreateKey: async () => Buffer.alloc(32, 27), checkAvailability: async () => undefined };
    const vault = new LocalConnectionVault({ stateDir: f.stateDir, keyStore });
    const manager = new KuloConnections({ stateDir: f.stateDir, vault, executor: f.executor });
    const saved = await manager.save(custom());
    expect(saved).toMatchObject({ kind: "custom", status: "saved", hasCredential: true, secretFields: ["tenant", "proof"] });
    expect(saved.authType).toBeUndefined(); expect(saved.url).toBeUndefined();
    for (const filename of ["connections.json", "connection-vault.json"]) {
      const contents = fs.readFileSync(path.join(f.stateDir, filename), "utf8");
      expect(contents).not.toContain("opaque-tenant-value"); expect(contents).not.toContain("opaque-proof-line-one");
    }
    const reopenedVault = new LocalConnectionVault({ stateDir: f.stateDir, keyStore });
    const reopened = new KuloConnections({ stateDir: f.stateDir, vault: reopenedVault, executor: f.executor });
    await reopened.initialize();
    expect((await reopened.snapshot()).connections[0]).toEqual(saved);
    expect((await reopenedVault.get(`connection:${saved.id}`))?.proof).toBe(custom().secrets?.proof);
    expect(reopened.redact("opaque-tenant-value")).not.toContain("opaque-tenant-value");
    expect(reopened.redact(custom().secrets!.proof!)).not.toContain("opaque-proof-line-one");
    const encodedProof = Buffer.from(custom().secrets!.proof!).toString("base64");
    expect(reopened.redact(encodedProof)).not.toContain(encodedProof);
    expect(JSON.stringify(await reopened.snapshot())).not.toContain("opaque-tenant-value");
  });
  it("keeps omitted fields and secrets, deletes explicitly removed schema fields, and accepts opaque built-in names", async () => {
    const f = fixture(), first = await f.manager.save(custom());
    const changed = await f.manager.save({ name: first.name, kind: "custom", id: first.id, expectedRevision: first.revision, secrets: { tenant: "replacement-tenant-opaque" } });
    expect(changed.credentialFields).toEqual(first.credentialFields);
    expect(changed.instructions).toBe(first.instructions);
    expect((await f.vault.get(`connection:${first.id}`))?.proof).toBe(custom().secrets?.proof);
    const pruned = await f.manager.save({ ...changed, expectedRevision: changed.revision, credentialFields: [{ key: "tenant", label: "组织标识" }] });
    expect(pruned.secretFields).toEqual(["tenant"]);
    expect((await f.vault.get(`connection:${first.id}`))?.proof).toBeUndefined();
    await expect(f.manager.save({ ...pruned, expectedRevision: pruned.revision, secrets: { proof: "not-in-schema" } })).rejects.toThrow("定义不匹配");
    const opaque = await f.manager.save({ name: "不预设类型", kind: "custom", secrets: { privateKey: "arbitrary multiline\nprivate material", password: "first line\nsecond line" } });
    expect(opaque.status).toBe("saved"); expect(opaque.secretFields).toEqual(["privateKey", "password"]);
    const cleared = await f.manager.save({ ...pruned, expectedRevision: pruned.revision, credentialFields: [] });
    expect(cleared).toMatchObject({ hasCredential: false, secretFields: [], status: "incomplete" });
    expect(await f.vault.get(`connection:${first.id}`)).toBeUndefined();
  });
  it("organizes existing metadata through describe without changing values or retaining task grants", async () => {
    const f = fixture(), first = await f.manager.save(custom());
    f.manager.grant("T-custom", 1, [first.id]);
    const before = await f.vault.get(`connection:${first.id}`);
    const described = await f.manager.describe({ id: first.id, expectedRevision: first.revision, name: "工作制品平台", typeLabel: "制品签名", instructions: "用于项目发布。\n按平台文档使用。",
      credentialFields: [{ key: "proof", label: "签名证明" }, { key: "tenant", label: "组织" }] });
    expect(described.revision).toBe(first.revision + 1);
    expect(described.name).toBe("工作制品平台");
    expect(described.credentialFields?.map((field) => field.key)).toEqual(["proof", "tenant"]);
    expect(await f.vault.get(`connection:${first.id}`)).toEqual(before);
    expect(f.manager.hasGrant("T-custom", 1, first.id)).toBe(false);
    await expect(f.manager.describe({ id: first.id, expectedRevision: first.revision, name: "过期改动" })).rejects.toMatchObject({ code: "connection_conflict" });
  });
  it("binds custom values to an established endpoint and clears them before a different origin is stored", async () => {
    const f = fixture(), first = await f.manager.save({ ...custom(), url: "https://one.example.test/v1" });
    const sameOrigin = await f.manager.save({ ...first, expectedRevision: first.revision, url: "https://one.example.test/v2" });
    expect(sameOrigin.secretFields).toEqual(first.secretFields);
    const changedOrigin = await f.manager.save({ ...sameOrigin, expectedRevision: sameOrigin.revision, url: "https://two.example.test/v2" });
    expect(changedOrigin).toMatchObject({ hasCredential: false, secretFields: [], status: "incomplete" });
    expect(await f.vault.get(`connection:${first.id}`)).toBeUndefined();
  });
  it("rejects secret-bearing or structural changes through describe, including after reopening without initialize", async () => {
    const f = fixture(), first = await f.manager.save(custom());
    const reopened = new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor });
    for (const change of [{ name: "opaque-tenant-value" }, { typeLabel: "opaque-tenant-value" }, { instructions: "使用 opaque-tenant-value" },
      { name: JSON.stringify(custom().secrets!.proof!).slice(1, -1) },
      { name: encodeURIComponent(custom().secrets!.proof!) },
      { name: Buffer.from(custom().secrets!.proof!).toString("base64") },
      { credentialFields: [{ key: "tenant", label: "opaque-tenant-value" }, { key: "proof", label: "证明" }] }]) {
      await expect(reopened.describe({ id: first.id, expectedRevision: first.revision, ...change })).rejects.toThrow();
    }
    for (const schema of [[{ key: "tenant", label: "组织" }], [{ key: "tenant", label: "组织" }, { key: "replacement", label: "替换" }],
      [{ key: "tenant", label: "组织" }, { key: "proof", label: "证明" }, { key: "extra", label: "新增" }]]) {
      await expect(reopened.describe({ id: first.id, expectedRevision: first.revision, credentialFields: schema })).rejects.toThrow("不能增加、删除或更换");
    }
    await expect(reopened.describe({ id: first.id, expectedRevision: first.revision, secrets: { tenant: "forbidden" } } as never)).rejects.toThrow("只能修改");
    await expect(reopened.describe({ id: first.id, expectedRevision: first.revision, credentialRef: "forbidden" } as never)).rejects.toThrow("只能修改");
    await expect(reopened.describe({ id: first.id, expectedRevision: first.revision, credentialFields: [{ key: "tenant", label: "组织", value: "forbidden" }, { key: "proof", label: "证明" }] } as never)).rejects.toThrow("字段定义无效");
    expect((await reopened.snapshot()).connections[0]?.revision).toBe(first.revision);
  });
  it("groups previously unknown pasted credentials into one custom card and preserves opaque fallback text", async () => {
    const f = fixture();
    const raw = '请保存这个自定义凭据：{"tenantCode":"tenant-opaque-one","deviceProof":"proof-opaque-two","backupPhrase":"backup-opaque-three"}';
    const receipt = await f.manager.processText(raw, { requestId: "custom-json-one" });
    expect(receipt.saved).toBe(true); expect(receipt.connectionIds).toHaveLength(1);
    const saved = (await f.manager.snapshot()).connections[0]!;
    expect(saved.kind).toBe("custom"); expect(saved.status).toBe("saved");
    const stored = await f.vault.get(`connection:${saved.id}`);
    expect(Object.values(stored!)).toEqual(expect.arrayContaining(["tenant-opaque-one", "proof-opaque-two", "backup-opaque-three"]));
    expect(receipt.text).not.toContain("tenant-opaque-one"); expect(receipt.text).not.toContain("proof-opaque-two");
    expect((await f.manager.processText(raw, { requestId: "custom-json-one" })).connectionIds).toEqual(receipt.connectionIds);
    const opaque = '请保存这段凭据：{"tenant":"opaque-fallback-material", "broken":';
    const fallback = await f.manager.processText(opaque, { requestId: "opaque-fallback-one" });
    expect(fallback.saved).toBe(true); expect(fallback.connectionIds).toHaveLength(1);
    expect(Object.values((await f.vault.get(`connection:${fallback.connectionIds[0]}`))!)).toContain(opaque);
    expect(fallback.text).not.toContain("opaque-fallback-material");
    const metadata = fs.readFileSync(path.join(f.stateDir, "connections.json"), "utf8");
    expect(metadata).not.toContain("tenant-opaque-one"); expect(metadata).not.toContain("opaque-fallback-material");
  });
  it("rejects unsafe keys, duplicate schemas, oversize values and secret labels before any metadata write", async () => {
    const f = fixture();
    for (const key of ["__binding", "__proto__", "constructor", "prototype", "toString"]) {
      await expect(f.manager.save({ name: "自定义", kind: "custom", secrets: Object.fromEntries([[key, "opaque-secret"]]) })).rejects.toThrow("凭据字段无效");
    }
    await expect(f.manager.save({ name: "自定义", kind: "custom", credentialFields: [{ key: "value", label: "重复一" }, { key: "value", label: "重复二" }], secrets: { value: "opaque-secret" } })).rejects.toThrow();
    await expect(f.manager.save({ name: "自定义", kind: "custom", secrets: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field_${index}`, `opaque-secret-${index}`])) })).rejects.toThrow();
    await expect(f.manager.save({ name: "自定义", kind: "custom", secrets: { value: "x".repeat(256 * 1024 + 1) } })).rejects.toThrow();
    await expect(f.manager.save({ name: "自定义", kind: "custom", secrets: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`field_${index}`, "x".repeat(200 * 1024)])) })).rejects.toThrow("内容过长");
    await expect(f.manager.save({ name: "自定义", kind: "custom", credentialFields: [{ key: "value", label: "opaque-secret" }], secrets: { value: "opaque-secret" } })).rejects.toThrow("字段名称中包含凭据");
    await expect(f.manager.save({ name: "自定义", kind: "custom", credentialFields: [{ key: "opaqueSecretKey", label: "证明" }], secrets: { opaqueSecretKey: "opaqueSecretKey" } })).rejects.toThrow("字段名称中包含凭据");
    expect((await f.manager.snapshot()).connections).toEqual([]);
    expect(fs.existsSync(path.join(f.stateDir, "connections.json"))).toBe(false);
  });
  it("never sends custom credentials through a generic HTTP or SSH adapter", async () => {
    const f = fixture(), saved = await f.manager.save({ ...custom(), url: "https://resource.example.test" });
    f.manager.grant("T-custom", 1, [saved.id]);
    await expect(f.manager.test(saved.id)).rejects.toMatchObject({ code: "connection_adapter_unavailable", status: 409 });
    await expect(f.manager.use("T-custom", 1, saved.id, { kind: "http", path: "/" })).rejects.toMatchObject({ code: "connection_adapter_unavailable", status: 409 });
    await expect(f.manager.use("T-custom", 1, saved.id, { kind: "ssh", command: "exit 0" })).rejects.toMatchObject({ code: "connection_adapter_unavailable", status: 409 });
    expect(f.executor.scan).not.toHaveBeenCalled(); expect(f.executor.execute).not.toHaveBeenCalled();
  });
});

describe("ordinary information cards", () => {
  it("accepts ordinary information through the client-bound human form and keeps it readable when a field is updated", async () => {
    const f = fixture(), input = await f.manager.prepare({ clientId: "human-window", kind: "custom", category: "information", name: "办公资料" });
    const first = await f.manager.submitInput(input.id, "human-window", { name: "办公资料", kind: "custom", credentialFields: [{ key: "address", label: "地址" }, { key: "preference", label: "偏好" }],
      secrets: { address: "合成路 123 号", preference: "午餐不放辣椒" } });
    expect(first).toMatchObject({ category: "information", canReadInformation: true });
    f.manager.grant("T-info", 1, [first.id]);
    expect((await f.manager.use("T-info", 1, first.id, { kind: "information", action: "read" })).output).toContain("合成路 123 号");
    const edit = await f.manager.prepare({ clientId: "human-window", connectionId: first.id });
    const changed = await f.manager.submitInput(edit.id, "human-window", { ...first, expectedRevision: first.revision, secrets: { preference: "午餐少放盐" } });
    expect(changed.canReadInformation).toBe(true);
    f.manager.grant("T-info", 2, [first.id]);
    const result = await f.manager.use("T-info", 2, first.id, { kind: "information", action: "read" });
    expect(result.output).toContain("合成路 123 号"); expect(result.output).toContain("午餐少放盐");
    expect(f.manager.redact("午餐少放盐")).toBe("午餐少放盐");
  });
  it("does not turn retained credentials into readable information through human form reclassification or encoded re-entry", async () => {
    const f = fixture(), old = await f.manager.save({ name: "受保护资料", kind: "custom", secrets: { proof: "opaque-form-protected-secret" } });
    const input = await f.manager.prepare({ clientId: "human-window", connectionId: old.id });
    const changed = await f.manager.submitInput(input.id, "human-window", { ...old, name: "普通资料", category: "information", credentialFields: [{ key: "proof", label: "内容" }], secrets: {} });
    expect(changed.canReadInformation).toBe(false);
    f.manager.grant("T-info", 1, [old.id]);
    await expect(f.manager.use("T-info", 1, old.id, { kind: "information", action: "read" })).rejects.toMatchObject({ code: "connection_information_protected" });
    const retry = await f.manager.prepare({ clientId: "human-window", connectionId: old.id });
    const encoded = await f.manager.submitInput(retry.id, "human-window", { ...changed, secrets: { proof: Buffer.from("opaque-form-protected-secret").toString("base64") } });
    expect(encoded.canReadInformation).toBe(false);
    f.manager.grant("T-info", 2, [old.id]);
    await expect(f.manager.use("T-info", 2, old.id, { kind: "information", action: "read" })).rejects.toMatchObject({ code: "connection_information_protected" });
  });
  it("remembers an explicit ordinary fact encrypted and lets an authorized task read it without treating it as a credential", async () => {
    const f = fixture(), fact = "上海市合成路 123 号 8 楼";
    const receipt = await f.manager.processText(`请记住我的办公室地址是${fact}`, { requestId: "remember-office" });
    expect(receipt.saved).toBe(true); expect(receipt.connectionIds).toHaveLength(1);
    const card = (await f.manager.snapshot()).connections.find((record) => record.id === receipt.connectionIds[0])!;
    expect(card).toMatchObject({ kind: "custom", category: "information", name: "办公室地址", status: "saved", canReadInformation: true });
    expect(fs.readFileSync(path.join(f.stateDir, "connections.json"), "utf8")).not.toContain(fact);
    expect((await f.vault.get(`connection:${card.id}`))?.__informationReadable).toBe("1");
    expect(f.manager.redact(fact)).toBe(fact);
    await expect(f.manager.use("T-info", 1, card.id, { kind: "information", action: "read" })).rejects.toMatchObject({ code: "connection_access_denied" });
    f.manager.grant("T-info", 1, [card.id]);
    const result = await f.manager.use("T-info", 1, card.id, { kind: "information", action: "read" }, { readOnly: true });
    expect(result.kind).toBe("information"); expect(result.output).toContain(fact);
    expect(f.executor.execute).not.toHaveBeenCalled();
    const reopened = new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor });
    await reopened.initialize();
    expect(reopened.redact(fact)).toBe(fact);
    expect((await reopened.snapshot()).connections.find((record) => record.id === card.id)?.canReadInformation).toBe(true);
    reopened.grant("T-info", 2, [card.id]);
    expect((await reopened.use("T-info", 2, card.id, { kind: "information", action: "read" })).output).toContain(fact);
  });
  it("preserves readable provenance for metadata-only edits but clears it for untrusted value changes", async () => {
    const f = fixture(), receipt = await f.manager.processText("请记住我的饮食偏好是午餐不放辣椒", { requestId: "remember-food" });
    const first = (await f.manager.snapshot()).connections.find((record) => record.id === receipt.connectionIds[0])!;
    const described = await f.manager.describe({ id: first.id, expectedRevision: first.revision, name: "午餐偏好", credentialFields: [{ key: "content", label: "偏好内容" }] });
    expect(described.canReadInformation).toBe(true);
    expect((await f.vault.get(`connection:${first.id}`))?.__informationReadable).toBe("1");
    const unchanged = await f.manager.save({ ...described, expectedRevision: described.revision, secrets: {} });
    expect(unchanged.canReadInformation).toBe(true);
    const changed = await f.manager.save({ ...unchanged, expectedRevision: unchanged.revision, secrets: { content: "new opaque value from a manual field" } });
    expect(changed.canReadInformation).toBe(false);
    expect((await f.vault.get(`connection:${first.id}`))?.__informationReadable).toBeUndefined();
    f.manager.grant("T-info", 1, [first.id]);
    await expect(f.manager.use("T-info", 1, first.id, { kind: "information", action: "read" })).rejects.toMatchObject({ code: "connection_information_protected" });
  });
  it("does not unlock credential values by reclassification or a forged public readable flag", async () => {
    const f = fixture(), credential = await f.manager.save({ name: "受保护资料", kind: "custom", secrets: { proof: "opaque-protected-secret" } });
    const moved = await f.manager.describe({ id: credential.id, expectedRevision: credential.revision, category: "information" });
    expect(moved.canReadInformation).toBe(false);
    const filename = path.join(f.stateDir, "connections.json"), document = JSON.parse(fs.readFileSync(filename, "utf8"));
    document.connections[moved.id].canReadInformation = true;
    fs.writeFileSync(filename, JSON.stringify(document));
    const reopened = new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor });
    await reopened.initialize();
    expect((await reopened.snapshot()).connections[0]?.canReadInformation).toBe(false);
    reopened.grant("T-info", 1, [moved.id]);
    await expect(reopened.use("T-info", 1, moved.id, { kind: "information", action: "read" })).rejects.toMatchObject({ code: "connection_information_protected" });
    await expect(reopened.save({ name: "伪造读取权限", kind: "custom", category: "information", secrets: { __informationReadable: "1", content: "opaque" } })).rejects.toThrow("凭据字段无效");
  });
  it("keeps file, code, setting instructions out of information cards and checks known credentials before granting readability", async () => {
    const f = fixture();
    for (const message of ["请记住我的要求：把代码保存到 app.ts", "请记住我的设置是修改项目配置文件", "请把这段代码保存到 app.ts"]) {
      const receipt = await f.manager.processText(message);
      expect(receipt.saved).toBe(false);
    }
    f.manager.rememberSecrets(["opaque-known-provider-credential"]);
    const unsafe = await f.manager.processText("请记住我的备注是opaque-known-provider-credential", { requestId: "unsafe-note" });
    expect(unsafe.text).not.toContain("opaque-known-provider-credential");
    expect((await f.manager.snapshot()).connections.every((record) => record.category !== "information" || !record.canReadInformation)).toBe(true);
  });
  it("filters credentials discovered after an ordinary information card was created", async () => {
    const f = fixture(), receipt = await f.manager.processText("请记住我的备注是opaque-later-known-value", { requestId: "later-secret" });
    const id = receipt.connectionIds[0]!;
    f.manager.grant("T-info", 1, [id]);
    f.manager.rememberSecrets(["opaque-later-known-value"]);
    const result = await f.manager.use("T-info", 1, id, { kind: "information", action: "read" });
    expect(result.output).not.toContain("opaque-later-known-value");
  });
  it("classifies legacy custom cards as credentials without changing their encrypted values", async () => {
    const f = fixture(), saved = await f.manager.save({ name: "旧自定义凭据", kind: "custom", secrets: { customField: "opaque-legacy-value" } });
    const filename = path.join(f.stateDir, "connections.json"), document = JSON.parse(fs.readFileSync(filename, "utf8"));
    delete document.connections[saved.id].category;
    fs.writeFileSync(filename, JSON.stringify(document));
    const reopened = new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor });
    await reopened.initialize();
    expect((await reopened.snapshot()).connections[0]).toMatchObject({ kind: "custom", category: "credential", hasCredential: true });
    expect((await f.vault.get(`connection:${saved.id}`))?.customField).toBe("opaque-legacy-value");
  });
});
