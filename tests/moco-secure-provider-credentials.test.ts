import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionVaultError, LocalConnectionVault, type ConnectionSecretFields, type ConnectionVaultKeyStore } from "../packages/hub/src/connection-vault.js";
import { SecureCredentialStore } from "../packages/hub/src/secure-provider-credentials.js";

const directories: string[] = [];
function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "moco-secure-provider-test-"));
  directories.push(result);
  return result;
}

class MemoryKeyStore implements ConnectionVaultKeyStore {
  readonly keys = new Map<string, Buffer>();
  calls = 0;
  locked = false;
  async getOrCreateKey(namespace: string, create = true): Promise<Buffer> {
    this.calls++;
    if (this.locked) throw new ConnectionVaultError("connection_vault_locked");
    let key = this.keys.get(namespace);
    if (!key && create) { key = randomBytes(32); this.keys.set(namespace, key); }
    if (!key) throw new ConnectionVaultError("connection_vault_key_missing");
    return Buffer.from(key);
  }
}

function fixture() {
  const stateDir = directory();
  const legacyPath = path.join(stateDir, "credentials.json");
  const keyStore = new MemoryKeyStore();
  const vault = new LocalConnectionVault({ stateDir, keyStore });
  const observed: string[] = [];
  const store = new SecureCredentialStore({ vault, legacyPath, onSecrets: (values) => observed.push(...values) });
  return { stateDir, legacyPath, keyStore, vault, store, observed };
}

function allFileContents(directory: string): string {
  return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => entry.isDirectory() ? allFileContents(path.join(directory, entry.name)) : fs.readFileSync(path.join(directory, entry.name), "utf8")).join("\n");
}

afterEach(() => { vi.restoreAllMocks(); for (const entry of directories.splice(0)) fs.rmSync(entry, { recursive: true, force: true }); });

describe("encrypted provider credential store", () => {
  it("does not touch the system key store for a fresh installation", async () => {
    const { store, keyStore, stateDir } = fixture();
    await store.initialize();
    expect(await store.list()).toEqual([]);
    expect(await store.read("not-saved")).toBeUndefined();
    expect(await store.secrets()).toEqual([]);
    expect(keyStore.calls).toBe(0);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("persists model and media credentials encrypted without losing origin binding", async () => {
    const { store, stateDir, legacyPath, vault } = fixture();
    const credential: Credential = { type: "api_key", key: "fixture-provider-key-599382", env: { MOCO_API_KEY_ORIGIN: "https://trusted.example", EXTRA_CONFIG: "preserved" } };
    await store.modify("api-private-provider", async () => credential);
    await store.modify("media:private-video", async () => ({ type: "api_key", key: "fixture-media-key-8843", env: { MOCO_MEDIA_ORIGIN: "https://media.example" } }));
    expect(await store.read("api-private-provider")).toEqual(credential);
    expect(await store.list()).toEqual([
      { providerId: "api-private-provider", type: "api_key" },
      { providerId: "media:private-video", type: "api_key" },
    ]);
    expect(fs.existsSync(legacyPath)).toBe(false);
    const disk = allFileContents(stateDir);
    for (const value of ["fixture-provider-key-599382", "fixture-media-key-8843", "api-private-provider", "private-video", "https://trusted.example"]) expect(disk).not.toContain(value);
    expect((await vault.refs()).every((ref) => /^provider:[a-f0-9]{64}$/.test(ref))).toBe(true);
  });

  it("migrates the full legacy credential file, verifies it, then removes the plaintext", async () => {
    const { store, legacyPath, stateDir, observed } = fixture();
    const legacy = {
      "moco-gateway": { type: "api_key", key: "fixture-gateway-secret-10392", env: { MOCO_API_KEY_ORIGIN: "https://gateway.example" } },
      "openai-codex": { type: "oauth", access: "fixture-access-secret-558", refresh: "fixture-refresh-secret-883", expires: 30000, accountId: "fixture-account", extra: { selected: true } },
    };
    fs.writeFileSync(legacyPath, JSON.stringify(legacy));
    await store.initialize();
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(await store.read("moco-gateway")).toEqual(legacy["moco-gateway"]);
    expect(await store.read("openai-codex")).toEqual(legacy["openai-codex"]);
    expect(await store.list()).toHaveLength(2);
    const disk = allFileContents(stateDir);
    for (const value of [legacy["moco-gateway"].key, legacy["openai-codex"].access, legacy["openai-codex"].refresh]) expect(disk).not.toContain(value);
    expect(observed).toEqual(expect.arrayContaining([legacy["moco-gateway"].key, legacy["openai-codex"].access, legacy["openai-codex"].refresh]));
    expect(fs.readdirSync(stateDir).filter((name) => name.includes("credentials"))).toEqual([]);
  });

  it("preserves the legacy file when the key store is locked and retries after unlock", async () => {
    const { store, keyStore, legacyPath, vault } = fixture();
    const original = JSON.stringify({ "api-fixture": { type: "api_key", key: "fixture-locked-migration-82" } });
    fs.writeFileSync(legacyPath, original);
    keyStore.locked = true;
    await expect(store.initialize()).rejects.toMatchObject({ code: "connection_vault_locked" });
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(original);
    expect(fs.existsSync(vault.filePath)).toBe(false);
    if (process.platform !== "win32") expect(fs.statSync(legacyPath).mode & 0o777).toBe(0o600);
    keyStore.locked = false;
    await store.initialize();
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect((await store.read("api-fixture"))?.type).toBe("api_key");
  });

  it.each(["{broken", "[]", '{"api-fixture":{"type":"api_key","key":123}}', '{"first":{"type":"api_key","key":"fixture-valid-first"},"bad":{"type":"unknown"}}'])("rejects malformed legacy data before encrypting anything: %s", async (original) => {
    const { store, legacyPath, vault, keyStore } = fixture();
    fs.writeFileSync(legacyPath, original);
    await expect(store.initialize()).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(original);
    expect(fs.existsSync(vault.filePath)).toBe(false);
    expect(keyStore.calls).toBe(0);
  });

  it("recovers an interrupted partial migration without deleting the remaining plaintext early", async () => {
    const stateDir = directory();
    const legacyPath = path.join(stateDir, "credentials.json");
    const keyStore = new MemoryKeyStore();
    class InterruptedVault extends LocalConnectionVault {
      count = 0;
      interrupt = true;
      override async set(ref: string, fields: ConnectionSecretFields): Promise<void> {
        if (++this.count === 2 && this.interrupt) throw new ConnectionVaultError("connection_vault_io");
        await super.set(ref, fields);
      }
    }
    const vault = new InterruptedVault({ stateDir, keyStore });
    const store = new SecureCredentialStore({ vault, legacyPath });
    const legacy = { first: { type: "api_key", key: "fixture-first-interrupted" }, second: { type: "api_key", key: "fixture-second-interrupted" } };
    fs.writeFileSync(legacyPath, JSON.stringify(legacy));
    await expect(store.initialize()).rejects.toMatchObject({ code: "connection_vault_io" });
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(await vault.refs()).toHaveLength(1);
    vault.interrupt = false;
    await store.initialize();
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(await store.read("second")).toEqual(legacy.second);
    expect(await store.list()).toHaveLength(2);
  });

  it("does not overwrite a conflicting encrypted credential with a stale legacy file", async () => {
    const { store, legacyPath, vault } = fixture();
    await store.modify("same-provider", async () => ({ type: "api_key", key: "fixture-newer-encrypted" }));
    fs.writeFileSync(legacyPath, JSON.stringify({ "same-provider": { type: "api_key", key: "fixture-stale-legacy" } }));
    const encryptedBefore = fs.readFileSync(vault.filePath);
    const restarted = new SecureCredentialStore({ vault, legacyPath });
    await expect(restarted.initialize()).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.readFileSync(vault.filePath)).toEqual(encryptedBefore);
  });

  it("seals exact leftover atomic-write files without promoting their stale credentials", async () => {
    const { store, vault, stateDir, legacyPath, keyStore } = fixture();
    const temporary = `${legacyPath}.12345.1700000000000.tmp`;
    fs.writeFileSync(legacyPath, JSON.stringify({ same: { type: "api_key", key: "fixture-current-active" } }));
    fs.writeFileSync(temporary, JSON.stringify({ same: { type: "api_key", key: "fixture-stale-temp" }, oauth: { type: "oauth", access: "fixture-stale-access", refresh: "fixture-stale-refresh", expires: 1 } }));
    await store.initialize();
    expect(fs.existsSync(temporary)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(await store.read("same")).toEqual({ type: "api_key", key: "fixture-current-active" });
    expect(await store.read("oauth")).toBeUndefined();
    expect(await store.list()).toEqual([{ providerId: "same", type: "api_key" }]);
    expect((await vault.refs()).some((ref) => /^legacy-provider-backup:[a-f0-9]{64}$/.test(ref))).toBe(true);
    const disk = allFileContents(stateDir);
    for (const secret of ["fixture-current-active", "fixture-stale-temp", "fixture-stale-access", "fixture-stale-refresh"]) expect(disk).not.toContain(secret);
    const observed: string[] = [];
    const reopened = new SecureCredentialStore({ vault: new LocalConnectionVault({ stateDir, keyStore }), legacyPath, onSecrets: (values) => observed.push(...values) });
    await reopened.initialize();
    expect(observed).toEqual(expect.arrayContaining(["fixture-current-active", "fixture-stale-temp", "fixture-stale-access", "fixture-stale-refresh"]));
    expect(await reopened.secrets()).toEqual(expect.arrayContaining(["fixture-stale-temp", "fixture-stale-access", "fixture-stale-refresh"]));
  });

  it("preserves a malformed partial temporary file as verified encrypted chunks", async () => {
    const { store, vault, legacyPath, stateDir } = fixture();
    const temporary = `${legacyPath}.45.1700000000001.tmp`;
    const original = Buffer.from('{"old":{"type":"api_key","key":"fixture-partial-secret"},"unfinished":"' + "x".repeat(300 * 1024));
    fs.writeFileSync(temporary, original);
    await store.initialize();
    expect(fs.existsSync(temporary)).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.secrets()).toContain("fixture-partial-secret");
    const entries = await vault.entries();
    const descriptor = entries.find((entry) => entry.fields.format === "legacy-provider-temp-v1")!;
    const chunks = JSON.parse(descriptor.fields.chunks!) as string[];
    expect(chunks).toHaveLength(2);
    const restored = Buffer.concat(chunks.map((ref) => Buffer.from(entries.find((entry) => entry.ref === ref)!.fields.data!, "base64")));
    expect(restored.equals(original)).toBe(true);
    expect(allFileContents(stateDir)).not.toContain("fixture-partial-secret");
  });

  it.each(["locked", "missing-key"])("keeps both original files when archiving cannot use the %s key", async (failure) => {
    const { vault, legacyPath, stateDir } = fixture();
    if (failure === "missing-key") await vault.set("seed", { password: "fixture-existing-ciphertext" });
    const keyStore = new MemoryKeyStore();
    keyStore.locked = failure === "locked";
    const temporary = `${legacyPath}.46.1700000000002.tmp`;
    const rawTemporary = '{"old":{"type":"api_key","key":"fixture-locked-temp"}}';
    const rawMain = '{"active":{"type":"api_key","key":"fixture-locked-main"}}';
    fs.writeFileSync(temporary, rawTemporary);
    fs.writeFileSync(legacyPath, rawMain);
    const store = new SecureCredentialStore({ vault: new LocalConnectionVault({ stateDir, keyStore }), legacyPath });
    await expect(store.initialize()).rejects.toMatchObject({ code: failure === "locked" ? "connection_vault_locked" : "connection_vault_key_missing" });
    expect(fs.readFileSync(temporary, "utf8")).toBe(rawTemporary);
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(rawMain);
    if (process.platform !== "win32") expect(fs.statSync(temporary).mode & 0o777).toBe(0o600);
  });

  it("leaves differently named files untouched without contacting the key store", async () => {
    const { store, stateDir, keyStore } = fixture();
    const names = ["credentials.json.word.1700000000000.tmp", "credentials.json.12.word.tmp", "credentials.json.12.1700000000000.tmp.backup", "other.json.12.1700000000000.tmp"];
    for (const name of names) fs.writeFileSync(path.join(stateDir, name), "unrelated-fixture");
    await store.initialize();
    expect(fs.readdirSync(stateDir).sort()).toEqual(names.sort());
    for (const name of names) expect(fs.readFileSync(path.join(stateDir, name), "utf8")).toBe("unrelated-fixture");
    expect(keyStore.calls).toBe(0);
  });

  it("rejects owned temporary-file symlinks without following or removing them", async () => {
    if (process.platform === "win32") return;
    const { store, legacyPath, keyStore } = fixture();
    const target = path.join(directory(), "unrelated");
    fs.writeFileSync(target, "unrelated-fixture");
    const temporary = `${legacyPath}.47.1700000000003.tmp`;
    fs.symlinkSync(target, temporary);
    await expect(store.initialize()).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    expect(fs.lstatSync(temporary).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("unrelated-fixture");
    expect(keyStore.calls).toBe(0);
  });

  it("refuses an oversized temporary file and preserves it without reading its contents", async () => {
    const { store, legacyPath, keyStore } = fixture();
    const temporary = `${legacyPath}.48.1700000000004.tmp`;
    fs.writeFileSync(temporary, "");
    fs.truncateSync(temporary, 16 * 1024 * 1024 + 1);
    await expect(store.initialize()).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    expect(fs.statSync(temporary).size).toBe(16 * 1024 * 1024 + 1);
    expect(keyStore.calls).toBe(0);
  });

  it("waits for an owner's not-yet-written lock metadata", async () => {
    const { store, stateDir, keyStore } = fixture();
    const lock = path.join(stateDir, ".connection-vault.lock");
    fs.writeFileSync(lock, "");
    const release = setTimeout(() => fs.unlinkSync(lock), 60);
    try { await store.initialize(); } finally { clearTimeout(release); }
    expect(await store.list()).toEqual([]);
    expect(keyStore.calls).toBe(0);
  });

  it("retries the owner releasing between lock collision and inspection", async () => {
    const { store, stateDir } = fixture();
    const lock = path.join(stateDir, ".connection-vault.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "fixture-lock" }));
    const lstat = fs.lstatSync;
    let raced = false;
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
      if (String(file) === lock && !raced) {
        raced = true;
        fs.unlinkSync(lock);
        throw Object.assign(new Error("fixture released lock"), { code: "ENOENT" });
      }
      return lstat(file, options as never);
    }) as typeof fs.lstatSync);
    await store.initialize();
    expect(raced).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("serializes OAuth refresh across store instances and preserves OAuth extensions", async () => {
    const { store, legacyPath, vault } = fixture();
    await store.modify("oauth-fixture", async () => ({ type: "oauth", refresh: "fixture-refresh-0", access: "fixture-access-0", expires: 0, accountId: "fixture-account", gatewayConfig: { baseUrl: "https://gateway.example", models: [] } }));
    const other = new SecureCredentialStore({ vault, legacyPath });
    const seen: number[] = [];
    await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : other).modify("oauth-fixture", async (current) => {
      if (current?.type !== "oauth") throw new Error("Missing OAuth fixture");
      seen.push(current.expires);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { ...current, expires: current.expires + 1, refresh: `fixture-refresh-${current.expires + 1}`, access: `fixture-access-${current.expires + 1}` };
    })));
    expect(seen).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(await store.read("oauth-fixture")).toMatchObject({ expires: 12, refresh: "fixture-refresh-12", accountId: "fixture-account", gatewayConfig: { baseUrl: "https://gateway.example", models: [] } });
  });

  it("allows independent provider callbacks to run concurrently", async () => {
    const { store } = fixture();
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const write = (provider: string) => store.modify(provider, async () => {
      started++;
      if (started === 2) release();
      await barrier;
      return { type: "api_key", key: `fixture-${provider}` };
    });
    await Promise.all([write("provider-one"), write("provider-two")]);
    expect(await store.list()).toHaveLength(2);
  });

  it("keeps undefined modify as no change, returns copies, and propagates callback failure", async () => {
    const { store } = fixture();
    await store.modify("provider-fixture", async () => ({ type: "api_key", key: "fixture-original" }));
    expect(await store.modify("provider-fixture", async (current) => { if (current?.type === "api_key") current.key = "caller-copy-only"; return undefined; })).toEqual({ type: "api_key", key: "fixture-original" });
    const error = new Error("fixture callback failed");
    await expect(store.modify("provider-fixture", async () => { throw error; })).rejects.toBe(error);
    expect(await store.read("provider-fixture")).toEqual({ type: "api_key", key: "fixture-original" });
    await store.delete("provider-fixture");
    expect(await store.read("provider-fixture")).toBeUndefined();
  });

  it("registers rotated and environment secrets without treating origin metadata as a secret", async () => {
    const { store, observed } = fixture();
    await store.modify("provider-fixture", async () => ({ type: "api_key", key: "fixture-provider-secret", env: { MOCO_API_KEY_ORIGIN: "https://trusted.example", AWS_SECRET_ACCESS_KEY: "fixture-aws-secret", AWS_REGION: "ap-southeast-1" } }));
    expect(await store.secrets()).toEqual(expect.arrayContaining(["fixture-provider-secret", "fixture-aws-secret"]));
    expect(observed).toContain("fixture-provider-secret");
    expect(observed).not.toContain("https://trusted.example");
    expect(observed).not.toContain("ap-southeast-1");
    expect(JSON.stringify(await store.list())).not.toContain("fixture-provider-secret");
  });

  it("coordinates refresh callbacks across separate Node processes", async () => {
    const stateDir = directory();
    const vault = new LocalConnectionVault({ stateDir, keyStore: { async getOrCreateKey() { return Buffer.alloc(32, 19); } } });
    const legacyPath = path.join(stateDir, "credentials.json");
    const store = new SecureCredentialStore({ vault, legacyPath });
    await store.modify("cross-process", async () => ({ type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 0 }));
    const vaultModule = fileURLToPath(new URL("../packages/hub/src/connection-vault.ts", import.meta.url));
    const storeModule = fileURLToPath(new URL("../packages/hub/src/secure-provider-credentials.ts", import.meta.url));
    const script = `
      import { LocalConnectionVault } from ${JSON.stringify(vaultModule)};
      import { SecureCredentialStore } from ${JSON.stringify(storeModule)};
      const vault = new LocalConnectionVault({stateDir:${JSON.stringify(stateDir)},keyStore:{async getOrCreateKey(){return Buffer.alloc(32,19)}}});
      const store = new SecureCredentialStore({vault,legacyPath:${JSON.stringify(legacyPath)}});
      for(let index=0;index<4;index++) await store.modify('cross-process',async(current)=>{
        await new Promise(resolve=>setTimeout(resolve,10));
        return {...current,expires:current.expires+1};
      });
    `;
    const run = () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "ignore", "pipe"] });
      let diagnostic = "";
      child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4096); });
      child.once("error", reject);
      child.once("close", (status) => status === 0 ? resolve() : reject(new Error(`Isolated credential fixture process failed (${status}): ${diagnostic}`)));
    });
    const results = await Promise.allSettled([run(), run(), run()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    expect(await store.read("cross-process")).toMatchObject({ expires: 12 });
  }, 15_000);
});
