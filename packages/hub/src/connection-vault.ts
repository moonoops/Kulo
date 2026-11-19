import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

export type ConnectionSecretFields = Record<string, string>;

export interface ConnectionVaultKeyStore {
  /** `create=false` must never replace a missing master key for an existing vault. */
  getOrCreateKey(namespace: string, create?: boolean): Promise<Buffer>;
  checkAvailability?(): Promise<void>;
}

export class ConnectionVaultError extends Error {
  constructor(readonly code: "connection_vault_unavailable" | "connection_vault_locked" | "connection_vault_key_missing" | "connection_vault_corrupt" | "connection_vault_io" | "connection_vault_invalid_input" | "connection_vault_busy") {
    super({
      connection_vault_unavailable: "本机安全凭证存储不可用。",
      connection_vault_locked: "系统密钥库已锁定或未授权，请解锁后重试。",
      connection_vault_key_missing: "本地凭证主密钥不可用，请恢复系统密钥库。",
      connection_vault_corrupt: "本地凭证库校验失败，未读取或覆盖凭据。",
      connection_vault_io: "无法访问本地凭证库，请检查目录权限和磁盘状态。",
      connection_vault_invalid_input: "凭证内容无效。",
      connection_vault_busy: "本地凭证库正被其他进程使用，请稍后重试。",
    }[code]);
    this.name = "ConnectionVaultError";
  }
}

interface EncryptedEntry { iv: string; tag: string; data: string }
interface VaultDocument {
  version: 1;
  namespace: string;
  entries: Record<string, EncryptedEntry>;
  manifest: { iv: string; tag: string };
}

const queues = new Map<string, Promise<void>>();
const MAX_VAULT_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(ref) && !["__proto__", "constructor", "prototype"].includes(ref);
}

function fieldsCopy(value: unknown): ConnectionSecretFields {
  if (!record(value) || Object.keys(value).length > 100 || Object.entries(value).some(([name, item]) => !name || name.length > 128 || ["__proto__", "constructor", "prototype"].includes(name) || typeof item !== "string")) throw new ConnectionVaultError("connection_vault_invalid_input");
  const copy = Object.fromEntries(Object.entries(value)) as ConnectionSecretFields;
  if (Buffer.byteLength(JSON.stringify(copy), "utf8") > MAX_ENTRY_BYTES) throw new ConnectionVaultError("connection_vault_invalid_input");
  return copy;
}

function bytes(value: unknown, size?: number): Buffer {
  if (typeof value !== "string" || value.length > MAX_ENTRY_BYTES * 2 || value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value)) throw new ConnectionVaultError("connection_vault_corrupt");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (size !== undefined && decoded.length !== size)) throw new ConnectionVaultError("connection_vault_corrupt");
  return decoded;
}

function processEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin", LANG: "C.UTF-8" };
  for (const name of ["HOME", "SystemRoot", "SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]) if (process.env[name]) result[name] = process.env[name];
  return result;
}

/** Output remains inside the trusted Hub; failures never include process output or input. */
function privateProcess(command: string, args: string[], input?: string | Buffer, timeout = 15_000): Promise<{ status: number | null; output: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], env: processEnvironment(), windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, timeout);
    child.stdin.on("error", () => { failed = true; });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) { failed = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.once("error", () => { clearTimeout(timer); reject(new ConnectionVaultError("connection_vault_unavailable")); });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (failed) reject(new ConnectionVaultError("connection_vault_unavailable"));
      else resolve({ status, output: Buffer.concat(chunks) });
    });
    child.stdin.end(input);
  });
}

function assertPrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new ConnectionVaultError("connection_vault_io");
}

class MacConnectionKeyStore implements ConnectionVaultKeyStore {
  #preparation?: Promise<string>;
  constructor(readonly stateDir: string) {}

  #helper(): Promise<string> {
    return this.#preparation ??= (async () => {
      const directory = path.join(this.stateDir, ".secure");
      assertPrivateDirectory(directory);
      fs.chmodSync(directory, 0o700);
      const source = fs.readFileSync(fileURLToPath(new URL("../native/kulo-vault-keychain.c", import.meta.url)), "utf8");
      const digest = createHash("sha256").update(source).update(process.arch).digest("hex").slice(0, 20);
      const helper = path.join(directory, `kulo-vault-keychain-${digest}`);
      if (!fs.existsSync(helper)) {
        const temporary = `${helper}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          const bundled = fileURLToPath(new URL("./kulo-vault-keychain", import.meta.url));
          if (fs.existsSync(bundled)) {
            const stat = fs.lstatSync(bundled);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new ConnectionVaultError("connection_vault_unavailable");
            // Distributables carry the signed helper so the target Mac needs no compiler.
            fs.copyFileSync(bundled, temporary, fs.constants.COPYFILE_EXCL);
          } else {
            const compiled = await privateProcess("/usr/bin/clang", ["-x", "c", "-O2", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-framework", "CoreFoundation", "-framework", "Security", "-o", temporary, "-"], source, 30_000);
            if (compiled.status !== 0) throw new ConnectionVaultError("connection_vault_unavailable");
            const signed = await privateProcess("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "io.kulo.connection-vault-helper", temporary]);
            if (signed.status !== 0) throw new ConnectionVaultError("connection_vault_unavailable");
          }
          fs.chmodSync(temporary, 0o500);
          fs.renameSync(temporary, helper);
        } finally {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
      }
      const stat = fs.lstatSync(helper);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new ConnectionVaultError("connection_vault_unavailable");
      return helper;
    })().catch((error: unknown) => {
      this.#preparation = undefined;
      throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_unavailable");
    });
  }

  async checkAvailability(): Promise<void> {
    const result = await privateProcess(await this.#helper(), ["--status"]);
    if (result.status !== 0) throw new ConnectionVaultError(result.status === 11 ? "connection_vault_locked" : "connection_vault_unavailable");
  }

  async getOrCreateKey(namespace: string, create = true): Promise<Buffer> {
    const result = await privateProcess(await this.#helper(), [create ? "create" : "read", namespace]);
    if (result.status !== 0) throw new ConnectionVaultError(result.status === 10 ? "connection_vault_key_missing" : result.status === 11 ? "connection_vault_locked" : "connection_vault_unavailable");
    if (result.output.length !== 32) throw new ConnectionVaultError("connection_vault_unavailable");
    return result.output;
  }
}

class LinuxConnectionKeyStore implements ConnectionVaultKeyStore {
  #executable(): string {
    const executable = ["/usr/bin/secret-tool", "/bin/secret-tool"].find((candidate) => fs.existsSync(candidate));
    if (!executable || !process.env.DBUS_SESSION_BUS_ADDRESS) throw new ConnectionVaultError("connection_vault_unavailable");
    return executable;
  }

  async checkAvailability(): Promise<void> { this.#executable(); }

  async getOrCreateKey(namespace: string, create = true): Promise<Buffer> {
    const executable = this.#executable();
    const attributes = ["kulo-service", "connection-vault", "kulo-instance", namespace];
    const result = await privateProcess(executable, ["lookup", ...attributes]);
    if (result.status === 0) {
      const encoded = result.output.toString("utf8").trim();
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length !== 32 || decoded.toString("base64") !== encoded) throw new ConnectionVaultError("connection_vault_unavailable");
      return decoded;
    }
    if (result.status !== 1) throw new ConnectionVaultError("connection_vault_unavailable");
    if (!create) throw new ConnectionVaultError("connection_vault_key_missing");
    const key = randomBytes(32);
    const stored = await privateProcess(executable, ["store", "--label=Kulo connection vault master key", ...attributes], key.toString("base64"));
    if (stored.status !== 0) { key.fill(0); throw new ConnectionVaultError("connection_vault_unavailable"); }
    return key;
  }
}

// The script is fixed code; only a non-secret namespace and operation arrive on stdin.
const WINDOWS_KEYSTORE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
public static class KuloVaultCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool Write(ref Credential credential, uint flags);
  [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr credential);
  public static byte[] Get(string name, bool create) {
    using (var mutex = new Mutex(false, "Local\\Kulo.ConnectionVault." + name)) {
      if (!mutex.WaitOne(10000)) throw new Exception();
      try {
        IntPtr pointer;
        if (Read("Kulo.ConnectionVault." + name, 1, 0, out pointer)) {
          try {
            var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            if (credential.CredentialBlobSize != 32) throw new Exception();
            var result = new byte[32]; Marshal.Copy(credential.CredentialBlob, result, 0, 32); return result;
          } finally { CredFree(pointer); }
        }
        if (Marshal.GetLastWin32Error() != 1168 || !create) throw new Exception();
        var key = new byte[32]; using (var random = RandomNumberGenerator.Create()) random.GetBytes(key);
        var buffer = Marshal.AllocHGlobal(32);
        try {
          Marshal.Copy(key, 0, buffer, 32);
          var credential = new Credential { Type=1, TargetName="Kulo.ConnectionVault." + name, Comment="Kulo connection vault master key", CredentialBlobSize=32, CredentialBlob=buffer, Persist=2, UserName=Environment.UserName };
          if (!Write(ref credential, 0)) { Array.Clear(key, 0, key.Length); throw new Exception(); }
        } finally { for (int i=0; i<32; i++) Marshal.WriteByte(buffer, i, 0); Marshal.FreeHGlobal(buffer); }
        return key;
      } finally { mutex.ReleaseMutex(); }
    }
  }
}
'@
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.namespace -notmatch '^[a-f0-9]{64}$') { exit 12 }
  $key = [KuloVaultCredential]::Get([string]$request.namespace, [bool]$request.create)
  [Console]::Out.Write([Convert]::ToBase64String($key))
  [Array]::Clear($key, 0, $key.Length)
  exit 0
} catch { exit 12 }
`;

class WindowsConnectionKeyStore implements ConnectionVaultKeyStore {
  #executable(): string {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!root) throw new ConnectionVaultError("connection_vault_unavailable");
    const executable = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!fs.existsSync(executable)) throw new ConnectionVaultError("connection_vault_unavailable");
    return executable;
  }
  async checkAvailability(): Promise<void> { this.#executable(); }
  async getOrCreateKey(namespace: string, create = true): Promise<Buffer> {
    const result = await privateProcess(this.#executable(), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_KEYSTORE_SCRIPT], JSON.stringify({ namespace, create }));
    const encoded = result.output.toString("utf8").trim();
    const key = Buffer.from(encoded, "base64");
    if (result.status !== 0 || key.length !== 32 || key.toString("base64") !== encoded) throw new ConnectionVaultError("connection_vault_unavailable");
    return key;
  }
}

function systemKeyStore(stateDir: string): ConnectionVaultKeyStore {
  if (process.platform === "darwin") return new MacConnectionKeyStore(stateDir);
  if (process.platform === "linux") return new LinuxConnectionKeyStore();
  if (process.platform === "win32") return new WindowsConnectionKeyStore();
  return { async getOrCreateKey() { throw new ConnectionVaultError("connection_vault_unavailable"); }, async checkAvailability() { throw new ConnectionVaultError("connection_vault_unavailable"); } };
}

async function acquireFileLock(directory: string): Promise<() => void> {
  const lockPath = path.join(directory, ".connection-vault.lock");
  const owner = JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString("hex") });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (Date.now() >= deadline) throw new ConnectionVaultError("connection_vault_busy");
    try {
      const handle = fs.openSync(lockPath, "wx", 0o600);
      try { fs.writeFileSync(handle, owner); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      return () => {
        if (fs.readFileSync(lockPath, "utf8") !== owner) throw new ConnectionVaultError("connection_vault_io");
        fs.unlinkSync(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stat: fs.Stats;
      let previous: unknown;
      try {
        stat = fs.lstatSync(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new ConnectionVaultError("connection_vault_io");
        const content = fs.readFileSync(lockPath, "utf8");
        // Another process may observe a new exclusive file before its owner finishes this tiny write.
        try { previous = JSON.parse(content); } catch { previous = undefined; }
      } catch (error) {
        // The previous owner can release between EEXIST and inspecting its lock.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (record(previous) && typeof previous.pid === "number" && Number.isInteger(previous.pid) && previous.pid > 0 && typeof previous.nonce === "string") {
        let gone = false;
        try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") gone = true; }
        if (gone) {
          try {
            const current = fs.lstatSync(lockPath);
            if (current.ino === stat.ino && current.dev === stat.dev && current.mtimeMs === stat.mtimeMs) fs.unlinkSync(lockPath);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Keeps a refresh callback locked as one transaction, independently of encrypted file writes. */
export function runWithLocalCredentialLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lockKey = path.join(directory, ".connection-vault.lock");
  const previous = queues.get(lockKey) ?? Promise.resolve();
  const run = previous.then(async () => {
    let release: () => void;
    try {
      assertPrivateDirectory(directory);
      release = await acquireFileLock(directory);
    } catch (error) {
      throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_io");
    }
    try { return await operation(); }
    finally {
      try { release(); }
      catch { throw new ConnectionVaultError("connection_vault_io"); }
    }
  });
  const tail = run.then(() => undefined, () => undefined);
  queues.set(lockKey, tail);
  void tail.then(() => { if (queues.get(lockKey) === tail) queues.delete(lockKey); });
  return run;
}

export class LocalConnectionVault {
  readonly filePath: string;
  readonly namespace: string;
  readonly #stateDir: string;
  readonly #store: ConnectionVaultKeyStore;
  #key?: Buffer;

  constructor(options: { stateDir: string; keyStore?: ConnectionVaultKeyStore }) {
    this.#stateDir = path.resolve(options.stateDir);
    this.filePath = path.join(this.#stateDir, "connection-vault.json");
    this.namespace = createHash("sha256").update("kulo-connection-vault-v1\0").update(this.#stateDir).digest("hex");
    this.#store = options.keyStore ?? systemKeyStore(this.#stateDir);
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await runWithLocalCredentialLock(this.#stateDir, operation); }
    catch (error) { throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_io"); }
  }

  async #master(create: boolean): Promise<Buffer> {
    if (!this.#key) {
      let key: Buffer;
      try { key = await this.#store.getOrCreateKey(this.namespace, create); }
      catch (error) { throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_unavailable"); }
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new ConnectionVaultError("connection_vault_unavailable");
      this.#key = Buffer.from(key);
    }
    return this.#key;
  }

  #load(): VaultDocument | undefined {
    try {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(this.filePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new ConnectionVaultError("connection_vault_io");
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VAULT_BYTES) throw new ConnectionVaultError("connection_vault_corrupt");
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!record(parsed) || parsed.version !== 1 || parsed.namespace !== this.namespace || !record(parsed.entries) || !record(parsed.manifest) || Object.keys(parsed.entries).length > 10_000) throw new ConnectionVaultError("connection_vault_corrupt");
      bytes(parsed.manifest.iv, 12); bytes(parsed.manifest.tag, 16);
      for (const [ref, entry] of Object.entries(parsed.entries)) {
        if (!validRef(ref) || !record(entry)) throw new ConnectionVaultError("connection_vault_corrupt");
        bytes(entry.iv, 12); bytes(entry.tag, 16); bytes(entry.data);
      }
      return parsed as unknown as VaultDocument;
    } catch (error) {
      throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_corrupt");
    }
  }

  #aad(ref: string): Buffer { return Buffer.from(`kulo-connection-vault-v1\0${this.namespace}\0${ref}`, "utf8"); }
  #manifestData(document: Pick<VaultDocument, "version" | "namespace" | "entries">): Buffer {
    return Buffer.from(JSON.stringify([document.version, document.namespace, Object.keys(document.entries).sort().map((ref) => [ref, document.entries[ref]])]), "utf8");
  }

  #validate(document: VaultDocument, key: Buffer): void {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes(document.manifest.iv, 12));
      decipher.setAAD(this.#manifestData(document));
      decipher.setAuthTag(bytes(document.manifest.tag, 16));
      decipher.final();
    } catch { throw new ConnectionVaultError("connection_vault_corrupt"); }
  }

  #decrypt(ref: string, entry: EncryptedEntry, key: Buffer): ConnectionSecretFields {
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes(entry.iv, 12));
      decipher.setAAD(this.#aad(ref));
      decipher.setAuthTag(bytes(entry.tag, 16));
      plaintext = Buffer.concat([decipher.update(bytes(entry.data)), decipher.final()]);
      return fieldsCopy(JSON.parse(plaintext.toString("utf8")));
    } catch { throw new ConnectionVaultError("connection_vault_corrupt"); }
    finally { plaintext?.fill(0); }
  }

  #write(entries: Record<string, EncryptedEntry>, key: Buffer): void {
    const iv = randomBytes(12);
    const document: VaultDocument = { version: 1, namespace: this.namespace, entries, manifest: { iv: iv.toString("base64"), tag: "" } };
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(this.#manifestData(document));
    cipher.final();
    document.manifest.tag = cipher.getAuthTag().toString("base64");
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized, "utf8") > MAX_VAULT_BYTES) throw new ConnectionVaultError("connection_vault_invalid_input");
    const temporary = `${this.filePath}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const handle = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(handle, serialized); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== "win32") fs.chmodSync(this.filePath, 0o600);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  async ready(): Promise<{ available: boolean; error?: string }> {
    try {
      await this.#run(async () => {
        const document = this.#load();
        if (document) this.#validate(document, await this.#master(false));
        else if (this.#store.checkAvailability) await this.#store.checkAvailability();
      });
      return { available: true };
    } catch (error) {
      return { available: false, error: error instanceof ConnectionVaultError ? error.message : new ConnectionVaultError("connection_vault_unavailable").message };
    }
  }

  async get(ref: string): Promise<ConnectionSecretFields | undefined> {
    if (!validRef(ref)) throw new ConnectionVaultError("connection_vault_invalid_input");
    return this.#run(async () => {
      const document = this.#load();
      if (!document) return undefined;
      const key = await this.#master(false);
      this.#validate(document, key);
      return Object.hasOwn(document.entries, ref) ? this.#decrypt(ref, document.entries[ref]!, key) : undefined;
    });
  }

  async entries(): Promise<Array<{ ref: string; fields: ConnectionSecretFields }>> {
    return this.#run(async () => {
      const document = this.#load();
      if (!document) return [];
      const key = await this.#master(false);
      this.#validate(document, key);
      return Object.entries(document.entries).map(([ref, entry]) => ({ ref, fields: this.#decrypt(ref, entry, key) }));
    });
  }

  async refs(): Promise<string[]> { return (await this.entries()).map((entry) => entry.ref); }

  async set(ref: string, fields: ConnectionSecretFields): Promise<void> {
    if (!validRef(ref)) throw new ConnectionVaultError("connection_vault_invalid_input");
    const safeFields = fieldsCopy(fields);
    await this.#run(async () => {
      const document = this.#load();
      const key = await this.#master(!document);
      if (document) this.#validate(document, key);
      const entries = document?.entries ?? {};
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(this.#aad(ref));
      const plaintext = Buffer.from(JSON.stringify(safeFields), "utf8");
      try {
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        entries[ref] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
      } finally { plaintext.fill(0); }
      this.#write(entries, key);
    });
  }

  async delete(ref: string): Promise<void> {
    if (!validRef(ref)) throw new ConnectionVaultError("connection_vault_invalid_input");
    await this.#run(async () => {
      const document = this.#load();
      if (!document) return;
      const key = await this.#master(false);
      this.#validate(document, key);
      if (Object.hasOwn(document.entries, ref)) { delete document.entries[ref]; this.#write(document.entries, key); }
    });
  }
}
