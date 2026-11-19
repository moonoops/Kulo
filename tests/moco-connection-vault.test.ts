import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionVaultError, LocalConnectionVault, type ConnectionVaultKeyStore } from "../packages/hub/src/connection-vault.js";

const directories: string[] = [];
function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "moco-connection-vault-test-"));
  directories.push(result);
  return result;
}

class MemoryKeyStore implements ConnectionVaultKeyStore {
  readonly keys = new Map<string, Buffer>();
  readonly calls: boolean[] = [];
  available = true;
  async checkAvailability(): Promise<void> {
    if (!this.available) throw new ConnectionVaultError("connection_vault_locked");
  }
  async getOrCreateKey(namespace: string, create = true): Promise<Buffer> {
    this.calls.push(create);
    if (!this.available) throw new ConnectionVaultError("connection_vault_locked");
    let key = this.keys.get(namespace);
    if (!key && create) { key = randomBytes(32); this.keys.set(namespace, key); }
    if (!key) throw new ConnectionVaultError("connection_vault_key_missing");
    return Buffer.from(key);
  }
}

function fixture() {
  const stateDir = directory();
  const keyStore = new MemoryKeyStore();
  return { stateDir, keyStore, vault: new LocalConnectionVault({ stateDir, keyStore }) };
}

afterEach(() => {
  for (const entry of directories.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
});

describe("local connection vault", () => {
  it("stores only ciphertext, including multiline private keys and account names", async () => {
    const { stateDir, keyStore, vault } = fixture();
    const fields = { username: "fixture-account-private", password: "fixture-password-S38@!", apiKey: "fixture-api-secret-1283982", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-private-body\n-----END OPENSSH PRIVATE KEY-----" };
    await vault.set("connection-1", fields);
    expect(await vault.get("connection-1")).toEqual(fields);
    const content = fs.readFileSync(vault.filePath, "utf8");
    for (const value of Object.values(fields)) expect(content).not.toContain(value);
    expect(content).not.toContain("fixture-private-body");
    const master = keyStore.keys.get(vault.namespace)!;
    expect(content).not.toContain(master.toString("base64"));
    expect(content).not.toContain(master.toString("hex"));
    expect(fs.readdirSync(stateDir)).toEqual(["connection-vault.json"]);
    if (process.platform !== "win32") expect(fs.statSync(vault.filePath).mode & 0o777).toBe(0o600);
    expect(await new LocalConnectionVault({ stateDir, keyStore }).get("connection-1")).toEqual(fields);
  });

  it("uses fresh nonces and returns independent secret objects", async () => {
    const { vault } = fixture();
    const fields = { password: "same-fixture-password" };
    await vault.set("connection-1", fields);
    const before = JSON.parse(fs.readFileSync(vault.filePath, "utf8"));
    await vault.set("connection-1", fields);
    const after = JSON.parse(fs.readFileSync(vault.filePath, "utf8"));
    expect(after.entries["connection-1"].iv).not.toBe(before.entries["connection-1"].iv);
    expect(after.entries["connection-1"].data).not.toBe(before.entries["connection-1"].data);
    const copy = (await vault.get("connection-1"))!;
    copy.password = "changed-only-in-caller";
    fields.password = "changed-original";
    expect(await vault.get("connection-1")).toEqual({ password: "same-fixture-password" });
  });

  it("reads and probes an empty vault without creating a key", async () => {
    const { vault, keyStore } = fixture();
    expect(await vault.get("missing")).toBeUndefined();
    expect(await vault.entries()).toEqual([]);
    expect(await vault.refs()).toEqual([]);
    expect(await vault.ready()).toEqual({ available: true });
    expect(keyStore.calls).toEqual([]);
    expect(keyStore.keys.size).toBe(0);
    expect(fs.existsSync(vault.filePath)).toBe(false);
  });

  it("supports trusted enumeration and deleting one connection without losing others", async () => {
    const { vault } = fixture();
    await vault.set("connection-1", { password: "first-fixture" });
    await vault.set("connection-2", { apiKey: "second-fixture" });
    expect(await vault.refs()).toEqual(["connection-1", "connection-2"]);
    expect(await vault.entries()).toEqual([
      { ref: "connection-1", fields: { password: "first-fixture" } },
      { ref: "connection-2", fields: { apiKey: "second-fixture" } },
    ]);
    await vault.delete("connection-1");
    await vault.delete("connection-1");
    expect(await vault.get("connection-1")).toBeUndefined();
    expect(await vault.get("connection-2")).toEqual({ apiKey: "second-fixture" });
    await vault.delete("connection-2");
    expect(await vault.entries()).toEqual([]);
  });

  it.each(["entry", "manifest", "delete-entry", "rename-entry", "invalid-json", "version"])("rejects %s tampering and never overwrites the damaged file", async (kind) => {
    const { vault } = fixture();
    await vault.set("connection-1", { password: "fixture-tamper-secret" });
    const document = JSON.parse(fs.readFileSync(vault.filePath, "utf8"));
    if (kind === "entry") document.entries["connection-1"].data = Buffer.from("changed").toString("base64");
    if (kind === "manifest") document.manifest.tag = Buffer.alloc(16).toString("base64");
    if (kind === "delete-entry") delete document.entries["connection-1"];
    if (kind === "rename-entry") { document.entries["connection-2"] = document.entries["connection-1"]; delete document.entries["connection-1"]; }
    if (kind === "version") document.version = 2;
    const damaged = kind === "invalid-json" ? "{not-json" : JSON.stringify(document);
    fs.writeFileSync(vault.filePath, damaged);
    await expect(vault.get("connection-1")).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    await expect(vault.entries()).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    await expect(vault.set("another", { password: "new-fixture-secret" })).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    await expect(vault.delete("connection-1")).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    expect(fs.readFileSync(vault.filePath, "utf8")).toBe(damaged);
    expect((await vault.ready()).available).toBe(false);
  });

  it("does not replace a missing system key when encrypted data already exists", async () => {
    const { vault, stateDir } = fixture();
    await vault.set("connection-1", { password: "fixture-master-missing" });
    const before = fs.readFileSync(vault.filePath);
    const emptyStore = new MemoryKeyStore();
    const reopened = new LocalConnectionVault({ stateDir, keyStore: emptyStore });
    await expect(reopened.get("connection-1")).rejects.toMatchObject({ code: "connection_vault_key_missing" });
    await expect(reopened.set("connection-2", { password: "should-not-save" })).rejects.toMatchObject({ code: "connection_vault_key_missing" });
    expect(emptyStore.calls).toEqual([false, false]);
    expect(emptyStore.keys.size).toBe(0);
    expect(fs.readFileSync(vault.filePath)).toEqual(before);
  });

  it("rejects a copied vault in another local storage namespace", async () => {
    const { vault, keyStore } = fixture();
    await vault.set("connection-1", { apiKey: "fixture-copy-secret" });
    const copied = new LocalConnectionVault({ stateDir: directory(), keyStore });
    fs.copyFileSync(vault.filePath, copied.filePath);
    const before = keyStore.calls.length;
    await expect(copied.get("connection-1")).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    expect(keyStore.calls).toHaveLength(before);
  });

  it("rejects the wrong master key without modifying data", async () => {
    const { stateDir, vault } = fixture();
    await vault.set("connection-1", { password: "fixture-wrong-key-secret" });
    const before = fs.readFileSync(vault.filePath);
    const reopened = new LocalConnectionVault({ stateDir, keyStore: { async getOrCreateKey() { return randomBytes(32); } } });
    await expect(reopened.get("connection-1")).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    await expect(reopened.delete("connection-1")).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    expect(fs.readFileSync(vault.filePath)).toEqual(before);
  });

  it("serializes concurrent updates across vault instances", async () => {
    const { stateDir, keyStore, vault } = fixture();
    const other = new LocalConnectionVault({ stateDir, keyStore });
    await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? vault : other).set(`connection-${index}`, { password: `fixture-${index}` })));
    expect(await vault.refs()).toHaveLength(40);
    expect(await other.get("connection-0")).toEqual({ password: "fixture-0" });
    expect(await other.get("connection-39")).toEqual({ password: "fixture-39" });
    expect(fs.readdirSync(stateDir)).toEqual(["connection-vault.json"]);
  });

  it("fails closed when the OS key store is locked and permits retry after unlock", async () => {
    const { keyStore, vault } = fixture();
    keyStore.available = false;
    expect(await vault.ready()).toEqual({ available: false, error: "系统密钥库已锁定或未授权，请解锁后重试。" });
    await expect(vault.set("connection-1", { password: "fixture-locked-secret" })).rejects.toMatchObject({ code: "connection_vault_locked" });
    expect(fs.existsSync(vault.filePath)).toBe(false);
    keyStore.available = true;
    await vault.set("connection-1", { password: "fixture-locked-secret" });
    expect(await vault.get("connection-1")).toEqual({ password: "fixture-locked-secret" });
  });

  it("never forwards backend error output or stores a plaintext fallback key", async () => {
    const stateDir = directory();
    const secret = "fixture-error-secret-must-not-escape";
    const vault = new LocalConnectionVault({ stateDir, keyStore: { async getOrCreateKey() { throw new Error(`backend diagnostic ${secret}`); } } });
    await expect(vault.set("connection-1", { password: secret })).rejects.toMatchObject({ code: "connection_vault_unavailable", message: "本机安全凭证存储不可用。" });
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("rejects credential-file symlinks", async () => {
    if (process.platform === "win32") return;
    const { vault } = fixture();
    const target = path.join(directory(), "target");
    fs.writeFileSync(target, "unrelated-file");
    fs.symlinkSync(target, vault.filePath);
    await expect(vault.set("connection-1", { password: "fixture-symlink-secret" })).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    expect(fs.readFileSync(target, "utf8")).toBe("unrelated-file");
  });

  it("rejects dangling credential-file symlinks instead of replacing them", async () => {
    if (process.platform === "win32") return;
    const { vault } = fixture();
    const target = path.join(directory(), "absent-target");
    fs.symlinkSync(target, vault.filePath);
    await expect(vault.set("connection-1", { password: "fixture-dangling-secret" })).rejects.toMatchObject({ code: "connection_vault_corrupt" });
    expect(fs.lstatSync(vault.filePath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("validates secret fields without echoing their values", async () => {
    const { vault } = fixture();
    await expect(vault.set("../../outside", { password: "fixture-input-secret" })).rejects.toMatchObject({ code: "connection_vault_invalid_input" });
    await expect(vault.set("connection-1", { password: { value: "fixture-input-secret" } } as never)).rejects.toMatchObject({ code: "connection_vault_invalid_input" });
    await expect(vault.set("__proto__", { password: "fixture-input-secret" })).rejects.toMatchObject({ code: "connection_vault_invalid_input" });
    await expect(vault.set("connection-1", JSON.parse('{"__proto__":"fixture-input-secret"}'))).rejects.toMatchObject({ code: "connection_vault_invalid_input" });
    expect(fs.existsSync(vault.filePath)).toBe(false);
  });
});
