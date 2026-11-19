import fs from "node:fs/promises";
import path from "node:path";
import { createPublicKey, createHash, randomUUID, verify } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyRelease, validateReleaseManifest, type RecoveryReleaseManifest } from "@moco/recovery";
import {
  CustomizationError, customizationCommand, customizationIdentifier, customizationSourceFile,
  type CustomizationFileChange,
} from "./customization-source.js";

export interface SignedCustomizationUpdate {
  formatVersion: 1;
  keyId: string;
  manifest: RecoveryReleaseManifest;
  signature: string;
}

const MAX_UPDATE_DESCRIPTOR_BYTES = 32 * 1024 * 1024;

export function customizationSignatureData(value: unknown): Buffer {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical((input as Record<string, unknown>)[key])]));
    return input;
  };
  return Buffer.from(JSON.stringify(canonical(value)));
}

function signedEnvelope(raw: unknown, trustedKeys: Readonly<Record<string, string>>): SignedCustomizationUpdate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CustomizationError("update_package_invalid", "更新签名清单无效。");
  const envelope = raw as SignedCustomizationUpdate;
  if (envelope.formatVersion !== 1 || typeof envelope.keyId !== "string" ||
      !Object.hasOwn(trustedKeys, envelope.keyId) || typeof envelope.signature !== "string" ||
      !/^[a-zA-Z0-9+/]{86}==$/.test(envelope.signature) ||
      !envelope.manifest || envelope.manifest.kind !== "official") throw new CustomizationError("update_signature_invalid", "更新来源或签名无效。");
  let valid = false;
  try {
    const key = createPublicKey(trustedKeys[envelope.keyId]!);
    valid = key.asymmetricKeyType === "ed25519" && verify(null, customizationSignatureData(envelope.manifest), key, Buffer.from(envelope.signature, "base64"));
  } catch { throw new CustomizationError("update_signature_invalid", "官方更新验证密钥无效。"); }
  if (!valid) throw new CustomizationError("update_signature_invalid", "官方更新签名校验失败。");
  validateReleaseManifest(envelope.manifest);
  return envelope;
}

export async function readSignedCustomizationUpdate(options: {
  inboxRoot: string; packageName: string; trustedKeys: Readonly<Record<string, string>>;
}): Promise<{ root: string; envelope: SignedCustomizationUpdate }> {
  customizationIdentifier(options.packageName);
  if (!Object.keys(options.trustedKeys).length) throw new CustomizationError("official_updates_unconfigured", "当前安装包尚未配置可信官方更新来源。");
  const inboxStat = await fs.lstat(options.inboxRoot);
  if (!inboxStat.isDirectory() || inboxStat.isSymbolicLink()) throw new CustomizationError("update_inbox_invalid", "更新目录不可用。");
  const directory = path.join(await fs.realpath(options.inboxRoot), options.packageName);
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new CustomizationError("update_package_invalid", "更新包不是受管目录。");
  const descriptor = path.join(directory, "moco-update.json"), stat = await fs.lstat(descriptor);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CustomizationError("update_package_invalid", "更新签名清单无效。");
  if (stat.size > MAX_UPDATE_DESCRIPTOR_BYTES) throw new CustomizationError("update_manifest_limit", "更新清单过大。");
  const envelope = signedEnvelope(JSON.parse(await fs.readFile(descriptor, "utf8")), options.trustedKeys);
  const root = path.join(directory, "payload"), rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new CustomizationError("update_package_invalid", "更新运行目录无效。");
  await verifyRelease(root, envelope.manifest, { full: true });
  return { root: await fs.realpath(root), envelope };
}

export async function fetchSignedCustomizationUpdate(options: {
  feedUrl: string; inboxRoot: string; trustedKeys: Readonly<Record<string, string>>; fetch: typeof fetch;
  signal?: AbortSignal; allowLocalFeed?: boolean; maxBytes?: number; ownerId?: string;
}): Promise<string> {
  if (!Object.keys(options.trustedKeys).length) throw new CustomizationError("official_updates_unconfigured", "当前安装包尚未配置可信官方更新来源。");
  const feed = new URL(options.feedUrl);
  if (feed.username || feed.password || feed.hash || feed.search ||
      feed.protocol !== "https:" && !(options.allowLocalFeed && feed.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(feed.hostname))) {
    throw new CustomizationError("update_feed_invalid", "官方更新地址无效。");
  }
  const downloads = new AbortController();
  const signal = AbortSignal.any([downloads.signal, AbortSignal.timeout(15 * 60_000), ...(options.signal ? [options.signal] : [])]);
  const request = async (url: URL) => {
    if (url.origin !== feed.origin) throw new CustomizationError("update_origin_changed", "更新资源与可信来源不一致。");
    const response = await options.fetch(url, { method: "GET", redirect: "error", credentials: "omit", signal, headers: { Accept: "application/octet-stream, application/json" } });
    if (!response.ok || response.redirected || !response.body) { await response.body?.cancel(); throw new CustomizationError("update_download_failed", "官方更新下载未完成。", 502); }
    return response;
  };
  const descriptor = await request(feed), chunks: Buffer[] = [];
  let descriptorBytes = 0;
  for await (const chunk of Readable.fromWeb(descriptor.body as import("node:stream/web").ReadableStream<Uint8Array>)) {
    const bytes = Buffer.from(chunk as Uint8Array); descriptorBytes += bytes.length;
    if (descriptorBytes > MAX_UPDATE_DESCRIPTOR_BYTES) { await descriptor.body?.cancel().catch(() => {}); throw new CustomizationError("update_manifest_limit", "更新清单过大。"); }
    chunks.push(bytes);
  }
  const envelope = signedEnvelope(JSON.parse(Buffer.concat(chunks).toString("utf8")), options.trustedKeys);
  const total = envelope.manifest.files.reduce((sum, file) => sum + (file.kind === "file" ? file.size : 0), 0);
  if (total > (options.maxBytes ?? 2 * 1024 ** 3)) throw new CustomizationError("update_download_limit", "更新包超过本机下载限制。");
  await fs.mkdir(options.inboxRoot, { recursive: true, mode: 0o700 });
  const inbox = await fs.lstat(options.inboxRoot);
  if (!inbox.isDirectory() || inbox.isSymbolicLink()) throw new CustomizationError("update_inbox_invalid", "更新目录不可用。");
  const packageName = "update-" + envelope.manifest.id, destination = path.join(options.inboxRoot, packageName);
  try {
    await fs.lstat(destination);
    await readSignedCustomizationUpdate({ inboxRoot: options.inboxRoot, packageName, trustedKeys: options.trustedKeys });
    return packageName;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = path.join(options.inboxRoot, ".download-" + randomUUID()), payload = path.join(temporary, "payload");
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(temporary, ".moco-owned-download.json"), JSON.stringify({ formatVersion: 1,
      ownerId: options.ownerId ?? "standalone", ownerPid: process.pid, createdAt: Date.now() }), { mode: 0o600, flag: "wx" });
    await fs.mkdir(payload, { mode: 0o700 });
    const files = envelope.manifest.files.filter((file) => file.kind === "file");
    let next = 0;
    const download = async () => {
      while (next < files.length) {
        const file = files[next++]!, target = path.join(payload, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const url = new URL("payloads/" + envelope.manifest.id + "/" + file.path.split("/").map(encodeURIComponent).join("/"), feed);
        const response = await request(url), hash = createHash("sha256");
        let written = 0;
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            written += chunk.length;
            if (written > file.size) { callback(new CustomizationError("update_download_limit", "更新文件超过签名清单大小。")); return; }
            hash.update(chunk); callback(null, chunk);
          },
        }), createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
        if (written !== file.size || hash.digest("hex") !== file.sha256) throw new CustomizationError("update_integrity_mismatch", "更新文件摘要校验失败。");
        await fs.chmod(target, file.executable ? 0o700 : 0o600);
      }
    };
    const results = await Promise.allSettled([download, download].map((operation) => operation().catch((error) => { downloads.abort(); throw error; })));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    for (const file of envelope.manifest.files.filter((entry) => entry.kind === "symlink")) {
      const target = path.join(payload, file.path); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.symlink(file.target!, target);
    }
    await verifyRelease(payload, envelope.manifest, { full: true });
    await fs.writeFile(path.join(temporary, "moco-update.json"), JSON.stringify(envelope), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, destination);
    return packageName;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

/** Called only while the customization operation lock is held and old sandboxes are stopped. */
export async function cleanupManagedCustomizationUpdates(options: { inboxRoot: string; ownerId: string; packageName?: string }): Promise<number> {
  let entries;
  try {
    const stat = await fs.lstat(options.inboxRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CustomizationError("update_inbox_invalid", "更新目录不可用。");
    entries = await fs.readdir(options.inboxRoot, { withFileTypes: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let removed = 0;
  for (const entry of entries) {
    if (options.packageName && entry.name !== options.packageName || !entry.isDirectory() || entry.isSymbolicLink() ||
        !/^(?:\.download-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|update-release_[a-f0-9]{24})$/.test(entry.name)) continue;
    const root = path.join(options.inboxRoot, entry.name);
    let descriptor: Awaited<ReturnType<typeof fs.open>> | undefined;
    let raw: unknown;
    try {
      descriptor = await fs.open(path.join(root, ".moco-owned-download.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await descriptor.stat();
      if (!stat.isFile() || stat.size > 2000 || typeof process.getuid === "function" && stat.uid !== process.getuid()) continue;
      raw = JSON.parse(await descriptor.readFile("utf8"));
    } catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "") || error instanceof SyntaxError) continue;
      throw error;
    } finally { await descriptor?.close(); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const owner = raw as { formatVersion?: unknown; ownerId?: unknown; ownerPid?: unknown };
    if (owner.formatVersion !== 1 || owner.ownerId !== options.ownerId || !Number.isSafeInteger(owner.ownerPid) || Number(owner.ownerPid) <= 0) continue;
    if (owner.ownerPid !== process.pid) {
      try { process.kill(Number(owner.ownerPid), 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") continue; if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await fs.rm(root, { recursive: true }); removed++;
  }
  return removed;
}

/** The merge inputs are recorded source bytes, never instructions obtained from an update package. */
export async function mergeCustomizationChanges(options: {
  sourceRoot: string; workRoot: string; changes: readonly CustomizationFileChange[]; signal?: AbortSignal;
}): Promise<{ conflicts: string[] }> {
  const conflicts: string[] = [];
  for (let index = 0; index < options.changes.length; index++) {
    const change = options.changes[index]!;
    let target: string, upstream: string | null = null;
    try { target = await customizationSourceFile(options.sourceRoot, change.path); upstream = await fs.readFile(target, "utf8"); }
    catch (error) {
      if (!(error instanceof CustomizationError && error.code === "customization_file_missing")) throw error;
      target = await customizationSourceFile(options.sourceRoot, change.path, true);
    }
    if (upstream === change.after || change.before === change.after) continue;
    if (upstream === change.before) {
      if (change.after === null) await fs.rm(target, { force: true });
      else await fs.writeFile(target, change.after, { mode: 0o600 });
      continue;
    }
    if (upstream === null || change.before === null || change.after === null) { conflicts.push(change.path); continue; }
    const mergeRoot = path.join(options.workRoot, ".merge", String(index));
    await fs.mkdir(mergeRoot, { recursive: true, mode: 0o700 });
    const ours = path.join(mergeRoot, "custom"), base = path.join(mergeRoot, "base"), theirs = path.join(mergeRoot, "official");
    await Promise.all([fs.writeFile(ours, change.after), fs.writeFile(base, change.before), fs.writeFile(theirs, upstream)]);
    const result = await customizationCommand("git", ["merge-file", "-p", "--", ours, base, theirs], {
      cwd: options.workRoot, workRoot: options.workRoot, signal: options.signal, allowedExitCodes: [1], timeoutMs: 10_000,
      captureLimitBytes: 2 * 1024 * 1024, failOnOutputLimit: true,
    });
    if (result.code === 1) conflicts.push(change.path);
    else await fs.writeFile(target, result.output, { mode: 0o600 });
  }
  return { conflicts };
}
