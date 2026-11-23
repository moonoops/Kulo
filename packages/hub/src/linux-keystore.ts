import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { ConnectionVaultError, type ConnectionVaultKeyStore } from "./connection-vault-errors.js";

export type LinuxKeyStoreBackend = "secret-service" | "systemd-creds-user" | "sealed-file";
export type LinuxSealedKdfSource = "etc-machine-id" | "dbus-machine-id" | "host-salt-only";

export interface LinuxKeyStoreProcessResult {
  status: number | null;
  output: Buffer;
}

export type LinuxKeyStoreProcessRunner = (
  command: string,
  args: string[],
  input?: string | Buffer,
  timeoutMs?: number,
) => Promise<LinuxKeyStoreProcessResult>;

export interface LinuxConnectionKeyStoreOptions {
  stateDir: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  runProcess?: LinuxKeyStoreProcessRunner;
  secretToolPaths?: readonly string[];
  systemdCredsPaths?: readonly string[];
  machineIdPaths?: { etc?: string; dbus?: string };
}

interface BackendPinFile {
  formatVersion: 1;
  backend: LinuxKeyStoreBackend;
}

interface SealedKeyEnvelope {
  formatVersion: 1;
  kdfSource: LinuxSealedKdfSource;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const VALID_BACKENDS = new Set<LinuxKeyStoreBackend>(["secret-service", "systemd-creds-user", "sealed-file"]);
const VALID_KDF_SOURCES = new Set<LinuxSealedKdfSource>(["etc-machine-id", "dbus-machine-id", "host-salt-only"]);
const MACHINE_ID_RE = /^[0-9a-f]{32}$/;
const NAMESPACE_RE = /^[a-f0-9]{64}$/;
const ZERO_MACHINE_ID = "0".repeat(32);

const keystoreQueues = new Map<string, Promise<void>>();
const activeKeystoreLocks = new AsyncLocalStorage<Set<string>>();

function buildLinuxKeyStoreEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  for (const name of [
    "HOME",
    "TEMP",
    "TMP",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]) {
    if (source[name]) result[name] = source[name];
  }
  return result;
}

function defaultRunProcess(env: NodeJS.ProcessEnv): LinuxKeyStoreProcessRunner {
  return (command, args, input, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "ignore"],
        env: buildLinuxKeyStoreEnv(env),
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill();
      }, timeoutMs);
      child.stdin.on("error", () => {
        failed = true;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65_536) {
          failed = true;
          child.kill();
        } else {
          chunks.push(chunk);
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new ConnectionVaultError("connection_vault_unavailable"));
      });
      child.once("close", (status) => {
        clearTimeout(timer);
        if (failed) reject(new ConnectionVaultError("connection_vault_unavailable"));
        else resolve({ status, output: Buffer.concat(chunks) });
      });
      child.stdin.end(input);
    });
}

function assertPrivateDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new ConnectionVaultError("connection_vault_io");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    fs.chmodSync(directory, 0o700);
  }
}

function readStrictPrivateFile(filePath: string, maxBytes = 65_536): Buffer | undefined {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new ConnectionVaultError("connection_vault_io");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > maxBytes ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new ConnectionVaultError("connection_vault_corrupt");
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeStrictPrivateFile(filePath: string, content: Buffer | string): void {
  assertPrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

async function acquireKeystoreLock(directory: string): Promise<() => void> {
  const lockPath = path.join(directory, ".keystore.lock");
  const owner = JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString("hex") });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (Date.now() >= deadline) throw new ConnectionVaultError("connection_vault_busy");
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, owner);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf8") === owner) fs.unlinkSync(lockPath);
        } catch {
          // Best-effort lock release
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ConnectionVaultError("connection_vault_io");
      try {
        const stat = fs.lstatSync(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new ConnectionVaultError("connection_vault_io");
        const raw = fs.readFileSync(lockPath, "utf8");
        let parsed: { pid?: unknown } | undefined;
        try { parsed = JSON.parse(raw) as { pid?: unknown }; } catch { parsed = undefined; }
        if (parsed && typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
          let dead = false;
          try { process.kill(parsed.pid, 0); } catch (killErr) { if ((killErr as NodeJS.ErrnoException).code === "ESRCH") dead = true; }
          if (dead) {
            try { fs.unlinkSync(lockPath); } catch { /* raced */ }
            continue;
          }
        }
      } catch (inspectErr) {
        if ((inspectErr as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (inspectErr instanceof ConnectionVaultError) throw inspectErr;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function readValidatedMachineId(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim().toLowerCase();
    if (!raw || raw === "uninitialized" || raw === ZERO_MACHINE_ID) return undefined;
    if (!MACHINE_ID_RE.test(raw)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Three-tier Linux master-key store with backend pinning and legacy vault protection:
 * 1. `secret-service` (desktop Freedesktop Secret Service via `secret-tool`)
 * 2. `systemd-creds-user` (modern headless systemd >= 256, `--user --with-key=host`)
 * 3. `sealed-file` (universal headless AES-256-GCM envelope with self-describing KDF source)
 */
export class LinuxConnectionKeyStore implements ConnectionVaultKeyStore {
  readonly #stateDir: string;
  readonly #dataDir: string;
  readonly #keystoreDir: string;
  readonly #backendPinPath: string;
  readonly #hostSaltPath: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #run: LinuxKeyStoreProcessRunner;
  readonly #secretToolPaths: readonly string[];
  readonly #systemdCredsPaths: readonly string[];
  readonly #machineIdPaths: { etc: string; dbus: string };

  constructor(options: LinuxConnectionKeyStoreOptions) {
    this.#stateDir = path.resolve(options.stateDir);
    this.#dataDir = path.resolve(options.dataDir ?? path.dirname(this.#stateDir));
    this.#keystoreDir = path.join(this.#stateDir, ".secure", "linux-keystore");
    this.#backendPinPath = path.join(this.#keystoreDir, "backend.json");
    this.#hostSaltPath = path.join(this.#keystoreDir, ".host-salt");
    this.#env = options.env ?? process.env;
    this.#run = options.runProcess ?? defaultRunProcess(this.#env);
    this.#secretToolPaths = options.secretToolPaths ?? ["/usr/bin/secret-tool", "/bin/secret-tool"];
    this.#systemdCredsPaths = options.systemdCredsPaths ?? ["/usr/bin/systemd-creds", "/bin/systemd-creds"];
    this.#machineIdPaths = {
      etc: options.machineIdPaths?.etc ?? "/etc/machine-id",
      dbus: options.machineIdPaths?.dbus ?? "/var/lib/dbus/machine-id",
    };
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.#keystoreDir;
    const held = activeKeystoreLocks.getStore();
    if (held?.has(key)) {
      return operation();
    }
    const prev = keystoreQueues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      assertPrivateDir(path.join(this.#stateDir, ".secure"));
      assertPrivateDir(this.#keystoreDir);
      const release = await acquireKeystoreLock(this.#keystoreDir);
      const nextHeld = new Set(held);
      nextHeld.add(key);
      try {
        return await activeKeystoreLocks.run(nextHeld, operation);
      } finally {
        release();
      }
    });
    const tail = next.then(() => undefined, () => undefined);
    keystoreQueues.set(key, tail);
    void tail.then(() => { if (keystoreQueues.get(key) === tail) keystoreQueues.delete(key); });
    return next;
  }

  #findExecutable(candidates: readonly string[]): string | undefined {
    return candidates.find((candidate) => {
      try { return fs.existsSync(candidate); } catch { return false; }
    });
  }

  #readPinnedBackend(): LinuxKeyStoreBackend | undefined {
    const raw = readStrictPrivateFile(this.#backendPinPath, 4096);
    if (!raw) return undefined;
    let parsed: Partial<BackendPinFile>;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as Partial<BackendPinFile>;
    } catch {
      throw new ConnectionVaultError("connection_vault_corrupt");
    }
    if (parsed.formatVersion !== 1 || !parsed.backend || !VALID_BACKENDS.has(parsed.backend)) {
      throw new ConnectionVaultError("connection_vault_corrupt");
    }
    return parsed.backend;
  }

  #writePinnedBackend(backend: LinuxKeyStoreBackend): void {
    const payload: BackendPinFile = { formatVersion: 1, backend };
    writeStrictPrivateFile(this.#backendPinPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  #hasLegacyEncryptedState(): boolean {
    const candidates = [
      path.join(this.#stateDir, "connection-vault.json"),
      path.join(this.#dataDir, "standby", "sync-key.enc"),
      path.join(this.#dataDir, "standby", "replica", "connection-vault.json"),
      path.join(this.#dataDir, "standby", "replica", "vault-envelope.enc"),
    ];
    return candidates.some((filePath) => fs.existsSync(filePath));
  }

  async #probeSecretService(): Promise<boolean> {
    const exe = this.#findExecutable(this.#secretToolPaths);
    if (!exe || !this.#env.DBUS_SESSION_BUS_ADDRESS) return false;
    try {
      const probe = await this.#run(
        exe,
        ["lookup", "kulo-service", "connection-vault", "kulo-probe", "availability-check"],
        undefined,
        5_000,
      );
      return probe.status === 0 || probe.status === 1;
    } catch {
      return false;
    }
  }

  async #probeSystemdCredsUser(): Promise<boolean> {
    const exe = this.#findExecutable(this.#systemdCredsPaths);
    if (!exe) return false;
    try {
      const token = randomBytes(16).toString("hex");
      const encrypted = await this.#run(
        exe,
        ["encrypt", "--user", "--with-key=host", "--name=kulo-probe", "-", "-"],
        token,
        5_000,
      );
      if (encrypted.status !== 0 || encrypted.output.length === 0) return false;
      const decrypted = await this.#run(
        exe,
        ["decrypt", "--user", "--name=kulo-probe", "-", "-"],
        encrypted.output,
        5_000,
      );
      return decrypted.status === 0 && decrypted.output.toString("utf8") === token;
    } catch {
      return false;
    }
  }

  async #resolveBackendLocked(createPin: boolean): Promise<LinuxKeyStoreBackend> {
    const pinned = this.#readPinnedBackend();
    if (pinned) return pinned;

    // Never silently fall back to `sealed-file` if legacy encrypted state already exists!
    if (this.#hasLegacyEncryptedState()) {
      if (await this.#probeSecretService()) {
        if (createPin) this.#writePinnedBackend("secret-service");
        return "secret-service";
      }
      throw new ConnectionVaultError("connection_vault_locked");
    }

    let selected: LinuxKeyStoreBackend;
    if (await this.#probeSecretService()) {
      selected = "secret-service";
    } else if (await this.#probeSystemdCredsUser()) {
      selected = "systemd-creds-user";
    } else {
      selected = "sealed-file";
    }
    if (createPin) this.#writePinnedBackend(selected);
    return selected;
  }

  async #secretServiceGetOrCreate(namespace: string, create: boolean): Promise<Buffer> {
    const exe = this.#findExecutable(this.#secretToolPaths);
    if (!exe || !this.#env.DBUS_SESSION_BUS_ADDRESS) {
      throw new ConnectionVaultError("connection_vault_locked");
    }
    const attributes = ["kulo-service", "connection-vault", "kulo-instance", namespace];
    const result = await this.#run(exe, ["lookup", ...attributes]);
    if (result.status === 0) {
      const encoded = result.output.toString("utf8").trim();
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
        throw new ConnectionVaultError("connection_vault_unavailable");
      }
      return decoded;
    }
    if (result.status !== 1) throw new ConnectionVaultError("connection_vault_locked");
    if (!create) throw new ConnectionVaultError("connection_vault_key_missing");
    const key = randomBytes(32);
    const stored = await this.#run(
      exe,
      ["store", "--label=Kulo connection vault master key", ...attributes],
      key.toString("base64"),
    );
    if (stored.status !== 0) {
      key.fill(0);
      throw new ConnectionVaultError("connection_vault_locked");
    }
    return key;
  }

  async #systemdCredsGetOrCreate(namespace: string, create: boolean): Promise<Buffer> {
    const exe = this.#findExecutable(this.#systemdCredsPaths);
    if (!exe) throw new ConnectionVaultError("connection_vault_unavailable");
    const credPath = path.join(this.#keystoreDir, `${namespace}.cred`);
    const credName = `kulo-vault-${namespace.slice(0, 24)}`;
    const existing = readStrictPrivateFile(credPath, 32_768);
    if (existing) {
      const dec = await this.#run(exe, ["decrypt", "--user", `--name=${credName}`, "-", "-"], existing);
      if (dec.status !== 0) throw new ConnectionVaultError("connection_vault_unavailable");
      const encoded = dec.output.toString("utf8").trim();
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
        throw new ConnectionVaultError("connection_vault_corrupt");
      }
      return decoded;
    }
    if (!create) throw new ConnectionVaultError("connection_vault_key_missing");
    const key = randomBytes(32);
    const enc = await this.#run(
      exe,
      ["encrypt", "--user", "--with-key=host", `--name=${credName}`, "-", "-"],
      key.toString("base64"),
    );
    if (enc.status !== 0 || enc.output.length === 0) {
      key.fill(0);
      throw new ConnectionVaultError("connection_vault_unavailable");
    }
    writeStrictPrivateFile(credPath, enc.output);
    return key;
  }

  #getOrCreateHostSalt(create: boolean): Buffer {
    const existing = readStrictPrivateFile(this.#hostSaltPath, 1024);
    if (existing) {
      const trimmed = existing.toString("utf8").trim();
      const buf = Buffer.from(trimmed, "hex");
      if (buf.length !== 32 || buf.toString("hex") !== trimmed) {
        throw new ConnectionVaultError("connection_vault_corrupt");
      }
      return buf;
    }
    if (!create) throw new ConnectionVaultError("connection_vault_key_missing");
    const salt = randomBytes(32);
    writeStrictPrivateFile(this.#hostSaltPath, `${salt.toString("hex")}\n`);
    return salt;
  }

  #deriveSealedKek(kdfSource: LinuxSealedKdfSource, namespace: string, salt: Buffer, createSalt: boolean): Buffer {
    let ikmParts: string[];
    if (kdfSource === "etc-machine-id") {
      const id = readValidatedMachineId(this.#machineIdPaths.etc);
      if (!id) throw new ConnectionVaultError("connection_vault_key_missing");
      ikmParts = [id, this.#stateDir];
    } else if (kdfSource === "dbus-machine-id") {
      const id = readValidatedMachineId(this.#machineIdPaths.dbus);
      if (!id) throw new ConnectionVaultError("connection_vault_key_missing");
      ikmParts = [id, this.#stateDir];
    } else {
      const hostSalt = this.#getOrCreateHostSalt(createSalt);
      ikmParts = [hostSalt.toString("hex"), this.#stateDir];
    }
    return Buffer.from(
      hkdfSync("sha256", Buffer.from(ikmParts.join("\0"), "utf8"), salt, Buffer.from(`kulo-linux-sealed-v1:${namespace}`, "utf8"), 32),
    );
  }

  #selectKdfSource(): LinuxSealedKdfSource {
    if (readValidatedMachineId(this.#machineIdPaths.etc)) return "etc-machine-id";
    if (readValidatedMachineId(this.#machineIdPaths.dbus)) return "dbus-machine-id";
    return "host-salt-only";
  }

  #sealedFileGetOrCreate(namespace: string, create: boolean): Buffer {
    const keyPath = path.join(this.#keystoreDir, `${namespace}.key`);
    const existingRaw = readStrictPrivateFile(keyPath, 16_384);
    if (existingRaw) {
      let envelope: Partial<SealedKeyEnvelope>;
      try {
        envelope = JSON.parse(existingRaw.toString("utf8")) as Partial<SealedKeyEnvelope>;
      } catch {
        throw new ConnectionVaultError("connection_vault_corrupt");
      }
      if (
        envelope.formatVersion !== 1 ||
        !envelope.kdfSource ||
        !VALID_KDF_SOURCES.has(envelope.kdfSource) ||
        typeof envelope.salt !== "string" ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.data !== "string"
      ) {
        throw new ConnectionVaultError("connection_vault_corrupt");
      }
      const salt = Buffer.from(envelope.salt, "base64");
      const iv = Buffer.from(envelope.iv, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      const data = Buffer.from(envelope.data, "base64");
      if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16 || data.length !== 32) {
        throw new ConnectionVaultError("connection_vault_corrupt");
      }
      const kek = this.#deriveSealedKek(envelope.kdfSource, namespace, salt, false);
      try {
        const decipher = createDecipheriv("aes-256-gcm", kek, iv);
        decipher.setAAD(Buffer.from(`kulo-linux-sealed-v1\0${envelope.kdfSource}\0${namespace}`, "utf8"));
        decipher.setAuthTag(tag);
        const key = Buffer.concat([decipher.update(data), decipher.final()]);
        if (key.length !== 32) throw new ConnectionVaultError("connection_vault_corrupt");
        return key;
      } catch (error) {
        if (error instanceof ConnectionVaultError) throw error;
        throw new ConnectionVaultError("connection_vault_corrupt");
      } finally {
        kek.fill(0);
      }
    }

    if (!create) throw new ConnectionVaultError("connection_vault_key_missing");
    const kdfSource = this.#selectKdfSource();
    const salt = randomBytes(32);
    const iv = randomBytes(12);
    const key = randomBytes(32);
    const kek = this.#deriveSealedKek(kdfSource, namespace, salt, true);
    try {
      const cipher = createCipheriv("aes-256-gcm", kek, iv);
      cipher.setAAD(Buffer.from(`kulo-linux-sealed-v1\0${kdfSource}\0${namespace}`, "utf8"));
      const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
      const envelope: SealedKeyEnvelope = {
        formatVersion: 1,
        kdfSource,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: encrypted.toString("base64"),
      };
      writeStrictPrivateFile(keyPath, `${JSON.stringify(envelope, null, 2)}\n`);
      return key;
    } finally {
      kek.fill(0);
    }
  }

  async checkAvailability(): Promise<void> {
    await this.runExclusive(async () => {
      const backend = await this.#resolveBackendLocked(false);
      if (backend === "secret-service" && !(await this.#probeSecretService())) {
        throw new ConnectionVaultError("connection_vault_locked");
      }
      if (backend === "systemd-creds-user" && !(await this.#probeSystemdCredsUser())) {
        throw new ConnectionVaultError("connection_vault_unavailable");
      }
    });
  }

  async getOrCreateKey(namespace: string, create = true): Promise<Buffer> {
    if (!NAMESPACE_RE.test(namespace)) {
      throw new ConnectionVaultError("connection_vault_invalid_input");
    }
    return this.runExclusive(async () => {
      const backend = await this.#resolveBackendLocked(create);
      if (backend === "secret-service") {
        return this.#secretServiceGetOrCreate(namespace, create);
      }
      if (backend === "systemd-creds-user") {
        return this.#systemdCredsGetOrCreate(namespace, create);
      }
      return this.#sealedFileGetOrCreate(namespace, create);
    });
  }

  /** Exposed for diagnostics and tests only. */
  readPinnedBackendForDiagnostics(): LinuxKeyStoreBackend | undefined {
    return this.#readPinnedBackend();
  }
}
