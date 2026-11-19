import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { ConnectionVaultError, LocalConnectionVault, runWithLocalCredentialLock } from "./connection-vault.js";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertProviderId(providerId: unknown, corrupt = false): asserts providerId is string {
  if (typeof providerId !== "string" || !providerId.trim() || providerId.length > 512 || /[\x00-\x1f\x7f]/.test(providerId) || ["__proto__", "constructor", "prototype"].includes(providerId)) throw new ConnectionVaultError(corrupt ? "connection_vault_corrupt" : "connection_vault_invalid_input");
}

function credentialCopy(value: unknown, corrupt = false): Credential {
  const code = corrupt ? "connection_vault_corrupt" : "connection_vault_invalid_input";
  let copy: unknown;
  try { copy = JSON.parse(JSON.stringify(value)); }
  catch { throw new ConnectionVaultError(code); }
  if (!object(copy)) throw new ConnectionVaultError(code);
  if (copy.type === "api_key") {
    if (copy.key !== undefined && typeof copy.key !== "string") throw new ConnectionVaultError(code);
    if (copy.env !== undefined && (!object(copy.env) || Object.values(copy.env).some((item) => typeof item !== "string"))) throw new ConnectionVaultError(code);
  } else if (copy.type === "oauth") {
    if (typeof copy.access !== "string" || typeof copy.refresh !== "string" || typeof copy.expires !== "number" || !Number.isFinite(copy.expires)) throw new ConnectionVaultError(code);
  } else throw new ConnectionVaultError(code);
  return copy as unknown as Credential;
}

function secretValues(credential: unknown): string[] {
  const values = new Set<string>();
  const visit = (value: unknown, environment = false): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!object(value)) return;
    for (const [name, item] of Object.entries(value)) {
      if (typeof item === "string" && item && (/^(?:key|access|refresh|password|secret|token|clientSecret|client_secret|access_token|refresh_token|privateKey|private_key|apiKey|api_key|authorization)$/i.test(name) || environment && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE)/i.test(name) && !/(?:^|_)(?:ORIGIN|BASE_URL|ENDPOINT|URL|HOST)$/i.test(name))) values.add(item);
      else if (object(item)) visit(item, name === "env");
    }
  };
  visit(credential);
  return [...values];
}

function reference(providerId: string): string { return `provider:${createHash("sha256").update(providerId).digest("hex")}`; }

const BACKUP_PREFIX = "legacy-provider-backup:";
const BACKUP_PART_BYTES = 256 * 1024;
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;

function backupReference(name: string): string { return `${BACKUP_PREFIX}${createHash("sha256").update(name).digest("hex")}`; }

function backupSecrets(content: Buffer): string[] {
  const text = content.toString("utf8");
  try { return secretValues(JSON.parse(text)); }
  catch {
    // A killed write may end after complete secret fields but before the final JSON delimiter.
    const values = new Set<string>();
    const fields = /"(key|access|refresh|password|secret|token|clientSecret|client_secret|access_token|refresh_token|privateKey|private_key|apiKey|api_key|authorization)"\s*:\s*("(?:[^"\\\r\n]|\\.)*")/gi;
    for (const match of text.matchAll(fields)) {
      try {
        const value: unknown = JSON.parse(match[2]!);
        if (typeof value === "string" && value) values.add(value);
      } catch { /* The raw bytes are still sealed even when a truncated field cannot be decoded. */ }
    }
    return [...values];
  }
}

export class SecureCredentialStore implements CredentialStore {
  readonly #vault: LocalConnectionVault;
  readonly #legacyPath: string;
  readonly #lockDirectory: string;
  readonly #onSecrets?: (values: readonly string[]) => void;
  readonly #archivedSecrets = new Set<string>();
  #initialization?: Promise<void>;

  constructor(options: { vault: LocalConnectionVault; legacyPath: string; onSecrets?: (values: readonly string[]) => void }) {
    this.#vault = options.vault;
    this.#legacyPath = path.resolve(options.legacyPath);
    this.#lockDirectory = path.join(path.dirname(this.#vault.filePath), ".secure", "provider-locks");
    this.#onSecrets = options.onSecrets;
  }

  #remember(credential: Credential): void { this.#onSecrets?.(secretValues(credential)); }

  #ownedTemporaryName(name: string): boolean {
    const prefix = `${path.basename(this.#legacyPath)}.`;
    return name.startsWith(prefix) && /^[1-9][0-9]*\.[0-9]+\.tmp$/.test(name.slice(prefix.length));
  }

  #temporaryNames(): string[] {
    try { return fs.readdirSync(path.dirname(this.#legacyPath)).filter((name) => this.#ownedTemporaryName(name)).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ConnectionVaultError("connection_vault_io");
    }
  }

  #rememberBackup(content: Buffer): void {
    const values = backupSecrets(content);
    for (const value of values) this.#archivedSecrets.add(value);
    this.#onSecrets?.(values);
  }

  #decodeBackup(ref: string, fields: Record<string, string>, entries: Map<string, Record<string, string>>): Buffer {
    try {
      if (fields.format !== "legacy-provider-temp-v1" || !fields.name || !this.#ownedTemporaryName(fields.name) || backupReference(fields.name) !== ref || !/^(?:0|[1-9][0-9]*)$/.test(fields.length ?? "") || !/^[a-f0-9]{64}$/.test(fields.digest ?? "")) throw new ConnectionVaultError("connection_vault_corrupt");
      const length = Number(fields.length);
      const chunks: unknown = JSON.parse(fields.chunks ?? "");
      if (!Number.isSafeInteger(length) || length > MAX_BACKUP_BYTES || !Array.isArray(chunks) || chunks.length !== Math.ceil(length / BACKUP_PART_BYTES)) throw new ConnectionVaultError("connection_vault_corrupt");
      const buffers: Buffer[] = [];
      try {
        for (let index = 0; index < chunks.length; index++) {
          const chunkRef = `${ref}:part:${index}`;
          const chunk = entries.get(chunkRef);
          if (chunks[index] !== chunkRef || chunk?.format !== "legacy-provider-temp-chunk-v1" || typeof chunk.data !== "string" || chunk.data.length > BACKUP_PART_BYTES * 2) throw new ConnectionVaultError("connection_vault_corrupt");
          const bytes = Buffer.from(chunk.data, "base64");
          buffers.push(bytes);
          if (bytes.toString("base64") !== chunk.data || bytes.length !== Math.min(BACKUP_PART_BYTES, length - index * BACKUP_PART_BYTES)) throw new ConnectionVaultError("connection_vault_corrupt");
        }
        const content = Buffer.concat(buffers);
        if (content.length !== length || createHash("sha256").update(content).digest("hex") !== fields.digest) {
          content.fill(0);
          throw new ConnectionVaultError("connection_vault_corrupt");
        }
        return content;
      } finally { for (const buffer of buffers) buffer.fill(0); }
    } catch (error) {
      throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_corrupt");
    }
  }

  async #loadBackups(): Promise<void> {
    const entries = new Map((await this.#vault.entries()).map(({ ref, fields }) => [ref, fields]));
    for (const [ref, fields] of entries) {
      if (!ref.startsWith(BACKUP_PREFIX) || ref.includes(":part:")) continue;
      const content = this.#decodeBackup(ref, fields, entries);
      try { this.#rememberBackup(content); } finally { content.fill(0); }
    }
  }

  async #archiveTemporary(name: string): Promise<void> {
    const filePath = path.join(path.dirname(this.#legacyPath), name);
    let content: Buffer | undefined;
    try {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(filePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BACKUP_BYTES) throw new ConnectionVaultError("connection_vault_corrupt");
      if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
      content = fs.readFileSync(filePath);
      if (content.length > MAX_BACKUP_BYTES) throw new ConnectionVaultError("connection_vault_corrupt");
      this.#rememberBackup(content);
      const ref = backupReference(name);
      const chunks = Array.from({ length: Math.ceil(content.length / BACKUP_PART_BYTES) }, (_, index) => `${ref}:part:${index}`);
      const descriptor = { format: "legacy-provider-temp-v1", name, length: String(content.length), digest: createHash("sha256").update(content).digest("hex"), chunks: JSON.stringify(chunks) };
      for (let index = 0; index < chunks.length; index++) {
        const chunkRef = chunks[index]!;
        const fields = { format: "legacy-provider-temp-chunk-v1", data: content.subarray(index * BACKUP_PART_BYTES, (index + 1) * BACKUP_PART_BYTES).toString("base64") };
        const existing = await this.#vault.get(chunkRef);
        if (existing && !isDeepStrictEqual(existing, fields)) throw new ConnectionVaultError("connection_vault_corrupt");
        if (!existing) await this.#vault.set(chunkRef, fields);
      }
      const existing = await this.#vault.get(ref);
      if (existing && !isDeepStrictEqual(existing, descriptor)) throw new ConnectionVaultError("connection_vault_corrupt");
      if (!existing) await this.#vault.set(ref, descriptor);
      const encrypted = new Map((await this.#vault.entries()).map(({ ref, fields }) => [ref, fields]));
      const sealed = this.#decodeBackup(ref, encrypted.get(ref) ?? {}, encrypted);
      try { if (!sealed.equals(content)) throw new ConnectionVaultError("connection_vault_corrupt"); }
      finally { sealed.fill(0); }
      let currentStat: fs.Stats;
      try { currentStat = fs.lstatSync(filePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.ino !== stat.ino || currentStat.dev !== stat.dev || currentStat.size > MAX_BACKUP_BYTES) throw new ConnectionVaultError("connection_vault_io");
      const current = fs.readFileSync(filePath);
      try { if (!current.equals(content)) throw new ConnectionVaultError("connection_vault_io"); }
      finally { current.fill(0); }
      fs.unlinkSync(filePath);
    } catch (error) {
      throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_io");
    } finally { content?.fill(0); }
  }

  async #decode(ref: string, fields: Record<string, string>): Promise<{ providerId: string; credential: Credential }> {
    try {
      assertProviderId(fields.providerId, true);
      if (reference(fields.providerId) !== ref || typeof fields.credential !== "string") throw new ConnectionVaultError("connection_vault_corrupt");
      const credential = credentialCopy(JSON.parse(fields.credential), true);
      this.#remember(credential);
      return { providerId: fields.providerId, credential };
    } catch (error) {
      throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_corrupt");
    }
  }

  async #readSaved(providerId: string): Promise<Credential | undefined> {
    const ref = reference(providerId);
    const fields = await this.#vault.get(ref);
    return fields ? (await this.#decode(ref, fields)).credential : undefined;
  }

  async #allSaved(): Promise<Array<{ providerId: string; credential: Credential }>> {
    const entries = await this.#vault.entries();
    const providers = entries.filter((entry) => entry.ref.startsWith("provider:"));
    return Promise.all(providers.map((entry) => this.#decode(entry.ref, entry.fields)));
  }

  #legacy(): { bytes: Buffer; stat: fs.Stats; credentials: Array<{ providerId: string; credential: Credential }> } | undefined {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.#legacyPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ConnectionVaultError("connection_vault_io");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new ConnectionVaultError("connection_vault_corrupt");
    let bytes: Buffer | undefined;
    try {
      if (process.platform !== "win32") fs.chmodSync(this.#legacyPath, 0o600);
      bytes = fs.readFileSync(this.#legacyPath);
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (!object(parsed)) throw new ConnectionVaultError("connection_vault_corrupt");
      const credentials = Object.entries(parsed).map(([providerId, value]) => {
        assertProviderId(providerId, true);
        return { providerId, credential: credentialCopy(value, true) };
      });
      return { bytes, stat, credentials };
    } catch (error) {
      bytes?.fill(0);
      throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_corrupt");
    }
  }

  async #migrate(): Promise<void> {
    const legacy = this.#legacy();
    if (!legacy) return;
    try {
      // Validate every legacy record before writing any encrypted entry.
      for (const { credential } of legacy.credentials) this.#remember(credential);
      for (const { providerId, credential } of legacy.credentials) {
        const current = await this.#readSaved(providerId);
        if (current && !isDeepStrictEqual(current, credential)) throw new ConnectionVaultError("connection_vault_corrupt");
        if (!current) await this.#vault.set(reference(providerId), { providerId, credential: JSON.stringify(credential) });
      }
      for (const { providerId, credential } of legacy.credentials) {
        if (!isDeepStrictEqual(await this.#readSaved(providerId), credential)) throw new ConnectionVaultError("connection_vault_corrupt");
      }
      const currentStat = fs.lstatSync(this.#legacyPath);
      const currentBytes = fs.readFileSync(this.#legacyPath);
      try {
        if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.ino !== legacy.stat.ino || currentStat.dev !== legacy.stat.dev || !currentBytes.equals(legacy.bytes)) throw new ConnectionVaultError("connection_vault_io");
      } finally { currentBytes.fill(0); }
      fs.unlinkSync(this.#legacyPath);
    } catch (error) {
      throw error instanceof ConnectionVaultError ? error : new ConnectionVaultError("connection_vault_io");
    } finally { legacy.bytes.fill(0); }
  }

  async initialize(): Promise<void> {
    return this.#initialization ??= (async () => {
      // Empty installations do not touch the OS key store or create provider lock directories.
      let legacyExists = false;
      try { fs.lstatSync(this.#legacyPath); legacyExists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConnectionVaultError("connection_vault_io"); }
      if (legacyExists || this.#temporaryNames().length) await runWithLocalCredentialLock(path.join(this.#lockDirectory, "migration"), async () => {
        for (const name of this.#temporaryNames()) await this.#archiveTemporary(name);
        await this.#migrate();
      });
      await this.#loadBackups();
      await this.#allSaved();
    })().catch((error: unknown) => { this.#initialization = undefined; throw error; });
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    assertProviderId(providerId);
    options?.signal?.throwIfAborted();
    await this.initialize();
    return this.#readSaved(providerId);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    await this.initialize();
    return (await this.#allSaved()).map(({ providerId, credential }) => ({ providerId, type: credential.type }));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    assertProviderId(providerId);
    options?.signal?.throwIfAborted();
    await this.initialize();
    return runWithLocalCredentialLock(path.join(this.#lockDirectory, reference(providerId).slice("provider:".length)), async () => {
      options?.signal?.throwIfAborted();
      const current = await this.#readSaved(providerId);
      const result = await fn(current ? credentialCopy(current) : undefined);
      if (result === undefined) return current ? credentialCopy(current) : undefined;
      const candidate = credentialCopy(result);
      this.#remember(candidate);
      await this.#vault.set(reference(providerId), { providerId, credential: JSON.stringify(candidate) });
      return credentialCopy(candidate);
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    assertProviderId(providerId);
    options?.signal?.throwIfAborted();
    await this.initialize();
    await runWithLocalCredentialLock(path.join(this.#lockDirectory, reference(providerId).slice("provider:".length)), async () => {
      options?.signal?.throwIfAborted();
      await this.#readSaved(providerId);
      await this.#vault.delete(reference(providerId));
    });
  }

  /** For trusted in-process redaction only; never return this from management APIs. */
  async secrets(): Promise<string[]> {
    await this.initialize();
    return [...new Set([...this.#archivedSecrets, ...(await this.#allSaved()).flatMap(({ credential }) => secretValues(credential))])];
  }
}
