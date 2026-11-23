import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { LoadedUpload, StoredUploadRecord } from "./uploads.js";

const require = createRequire(import.meta.url);

export const THUMBNAIL_VERSION = 1;
const THUMB_MAX_EDGE = 960;
const THUMB_MIN_BYPASS_BYTES = 150 * 1024;
const MAX_SOURCE_DIMENSION = 16_384;
const MAX_SOURCE_PIXELS = 64_000_000;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const FFMPEG_MAX_ALLOC = "268435456";
const FFMPEG_MAX_PIXELS = "67108864";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUED = 16;
const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024;
const DEFAULT_TARGET_CACHE_BYTES = 192 * 1024 * 1024;
const MAX_SKIPPED_ENTRIES = 512;
const DEFAULT_STALE_TMP_AGE_MS = 5 * 60_000;
const DEFAULT_HOT_FILE_PROTECT_MS = 60_000;
const PRUNE_EVERY_WRITES = 32;
const MAX_PNG_CHUNKS_TO_SCAN = 64;

const THUMB_FILE_RE = /^(att_[a-z0-9_]{6,48})-[a-f0-9]{16}\.v(\d+)\.webp$/;
const SUPPORTED_DEMUXERS: Readonly<Record<string, string>> = {
  "image/png": "png_pipe",
  "image/jpeg": "jpeg_pipe",
  "image/webp": "webp_pipe",
};
const ALLOWED_CHILD_ENV_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot"] as const;

export interface ThumbnailHit {
  filePath: string;
  size: number;
  etag: string;
  mimeType: "image/webp";
}

export interface MediaThumbnailCacheOptions {
  dir: string;
  uploadsDir: string;
  ffmpegPath?: string;
  maxConcurrency?: number;
  maxQueued?: number;
  maxCacheBytes?: number;
  targetCacheBytes?: number;
  timeoutMs?: number;
  staleTmpAgeMs?: number;
  hotFileProtectMs?: number;
  now?: () => number;
}

type TranscodeOutcome =
  | { kind: "ok"; bytes: Buffer }
  | { kind: "deterministic_fail" }
  | { kind: "transient_fail" }
  | { kind: "encoder_missing" };

function minimalChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function resolveBundledFfmpeg(): string | null {
  try {
    const pkgPath = require.resolve("ffmpeg-static/package.json");
    return path.join(path.dirname(pkgPath), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  } catch {
    return null;
  }
}

function isValidWebp(bytes: Buffer): boolean {
  return bytes.length >= 16 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
}

function digestPrefix16(record: StoredUploadRecord): string {
  if (record.sha256) return record.sha256.slice(0, 16);
  return crypto.createHash("sha256").update(`${record.id}:${record.size}`).digest("hex").slice(0, 16);
}

function cacheKeyFor(record: StoredUploadRecord): string {
  return `${record.id}-${digestPrefix16(record)}`;
}

function fileNameFor(record: StoredUploadRecord): string {
  return `${cacheKeyFor(record)}.v${THUMBNAIL_VERSION}.webp`;
}

function etagFor(record: StoredUploadRecord): string {
  return `"thumb-v${THUMBNAIL_VERSION}-${record.sha256 ?? `${record.id}-${record.size}`}"`;
}

function isSupportedImage(record: StoredUploadRecord): boolean {
  return record.kind === "image" && Object.hasOwn(SUPPORTED_DEMUXERS, record.mimeType);
}

function isStaticBypass(record: StoredUploadRecord): boolean {
  if (!isSupportedImage(record)) return true;
  if (
    record.size <= THUMB_MIN_BYPASS_BYTES &&
    record.width !== undefined &&
    record.height !== undefined &&
    record.width <= THUMB_MAX_EDGE &&
    record.height <= THUMB_MAX_EDGE
  ) {
    return true;
  }
  if (
    record.width !== undefined &&
    record.height !== undefined &&
    (record.width > MAX_SOURCE_DIMENSION ||
      record.height > MAX_SOURCE_DIMENSION ||
      record.width * record.height > MAX_SOURCE_PIXELS)
  ) {
    return true;
  }
  return false;
}

async function shouldSkipSourceByHeader(handle: fs.promises.FileHandle, mimeType: string, fileSize: number): Promise<boolean> {
  if (mimeType === "image/webp") {
    const head = Buffer.alloc(21);
    const { bytesRead } = await handle.read(head, 0, 21, 0);
    if (
      bytesRead >= 21 &&
      head.toString("ascii", 0, 4) === "RIFF" &&
      head.toString("ascii", 8, 12) === "WEBP" &&
      head.toString("ascii", 12, 16) === "VP8X"
    ) {
      const flags = head[20]!;
      // Skip Animated WebP (0x02, unsupported by ffmpeg webp decoder) and WebP with EXIF (0x08, avoids orientation loss).
      if ((flags & 0x02) !== 0 || (flags & 0x08) !== 0) return true;
    }
    return false;
  }
  if (mimeType === "image/png") {
    const sig = Buffer.alloc(8);
    const { bytesRead } = await handle.read(sig, 0, 8, 0);
    if (bytesRead < 8 || !sig.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
    const chunkHeader = Buffer.alloc(8);
    let offset = 8;
    for (let i = 0; i < MAX_PNG_CHUNKS_TO_SCAN && offset + 8 <= fileSize; i++) {
      const read = await handle.read(chunkHeader, 0, 8, offset);
      if (read.bytesRead < 8) break;
      const length = chunkHeader.readUInt32BE(0);
      const type = chunkHeader.toString("ascii", 4, 8);
      if (type === "acTL") return true;
      if (type === "IDAT" || type === "IEND") return false;
      const next = offset + 8 + length + 4;
      if (!Number.isSafeInteger(next) || next <= offset || next > fileSize) break;
      offset = next;
    }
  }
  return false;
}

async function ensurePrivateDirectory(directory: string): Promise<boolean> {
  try {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    await fs.promises.chmod(directory, 0o700);
    return true;
  } catch {
    return false;
  }
}

export class MediaThumbnailCache {
  readonly dir: string;
  readonly #uploadsDir: string;
  readonly #configuredFfmpegPath?: string;
  readonly #maxConcurrency: number;
  readonly #maxQueued: number;
  readonly #maxCacheBytes: number;
  readonly #targetCacheBytes: number;
  readonly #timeoutMs: number;
  readonly #staleTmpAgeMs: number;
  readonly #hotFileProtectMs: number;
  readonly #now: () => number;

  #closed = false;
  #encoderUnavailable = false;
  #resolvedFfmpeg: string | null | undefined;
  #dirReady = false;
  #pruning = false;
  #writesSincePrune = 0;
  #activeCount = 0;
  #waiters: Array<(acquired: boolean) => void> = [];
  #inflight = new Map<string, Promise<ThumbnailHit | null>>();
  #skipped = new Set<string>();
  #lifetime = new AbortController();

  constructor(options: MediaThumbnailCacheOptions) {
    this.dir = path.resolve(options.dir);
    this.#uploadsDir = path.resolve(options.uploadsDir);
    this.#configuredFfmpegPath = options.ffmpegPath;
    this.#maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.#maxQueued = Math.max(0, options.maxQueued ?? DEFAULT_MAX_QUEUED);
    this.#maxCacheBytes = Math.max(1024, options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES);
    this.#targetCacheBytes = Math.min(this.#maxCacheBytes, Math.max(0, options.targetCacheBytes ?? DEFAULT_TARGET_CACHE_BYTES));
    this.#timeoutMs = Math.max(200, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#staleTmpAgeMs = Math.max(0, options.staleTmpAgeMs ?? DEFAULT_STALE_TMP_AGE_MS);
    this.#hotFileProtectMs = Math.max(0, options.hotFileProtectMs ?? DEFAULT_HOT_FILE_PROTECT_MS);
    this.#now = options.now ?? Date.now;
  }

  isDeterministicBypass(record: StoredUploadRecord): boolean {
    return isStaticBypass(record) || this.#skipped.has(cacheKeyFor(record));
  }

  fastEtag(record: StoredUploadRecord): string | undefined {
    if (this.#closed || !record.sha256 || this.isDeterministicBypass(record)) return undefined;
    return etagFor(record);
  }

  async getOrCreate(loaded: LoadedUpload): Promise<ThumbnailHit | null> {
    if (this.#closed || this.isDeterministicBypass(loaded.record)) return null;
    const key = cacheKeyFor(loaded.record);
    const active = this.#inflight.get(key);
    if (active) return active;
    const work = this.#resolveOrGenerate(loaded, key).finally(() => {
      if (this.#inflight.get(key) === work) this.#inflight.delete(key);
    });
    this.#inflight.set(key, work);
    return work;
  }

  async #resolveOrGenerate(loaded: LoadedUpload, key: string): Promise<ThumbnailHit | null> {
    if (!await this.#ensureDir()) return null;
    const thumbPath = path.join(this.dir, fileNameFor(loaded.record));
    const etag = etagFor(loaded.record);
    const existing = await this.#statExisting(thumbPath, etag);
    if (existing) return existing;
    if (this.#encoderUnavailable) return null;
    return this.#generate(loaded, key, thumbPath, etag);
  }

  async prune(): Promise<void> {
    if (this.#closed || this.#pruning) return;
    this.#pruning = true;
    try {
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(this.dir, { withFileTypes: true }); }
      catch { return; }
      const now = this.#now();
      const live: Array<{ abs: string; size: number; mtimeMs: number }> = [];
      let totalBytes = 0;
      for (const entry of entries) {
        const abs = path.join(this.dir, entry.name);
        let stat: fs.Stats;
        try { stat = await fs.promises.lstat(abs); } catch { continue; }
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
          if (stat.mtimeMs < now - this.#staleTmpAgeMs) await fs.promises.rm(abs, { force: true }).catch(() => {});
          continue;
        }
        const match = THUMB_FILE_RE.exec(entry.name);
        if (!match) continue;
        const [, id, version] = match;
        const metaPath = path.join(this.#uploadsDir, `${id}.meta.json`);
        if (version !== String(THUMBNAIL_VERSION) || !fs.existsSync(metaPath)) {
          await fs.promises.rm(abs, { force: true }).catch(() => {});
          continue;
        }
        totalBytes += stat.size;
        live.push({ abs, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      if (totalBytes > this.#maxCacheBytes) {
        live.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const item of live) {
          if (totalBytes <= this.#targetCacheBytes) break;
          if (item.mtimeMs >= now - this.#hotFileProtectMs) continue;
          try {
            await fs.promises.rm(item.abs, { force: true });
            totalBytes -= item.size;
          } catch { /* Best-effort eviction. */ }
        }
      }
    } finally {
      this.#pruning = false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort(new Error("Thumbnail cache closed"));
    const pending = this.#waiters;
    this.#waiters = [];
    for (const resolve of pending) resolve(false);
  }

  #markSkipped(key: string): void {
    this.#skipped.delete(key);
    this.#skipped.add(key);
    if (this.#skipped.size > MAX_SKIPPED_ENTRIES) {
      this.#skipped.delete(this.#skipped.values().next().value!);
    }
  }

  async #ensureDir(): Promise<boolean> {
    if (this.#dirReady) return true;
    const parent = path.dirname(this.dir);
    try {
      await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const parentStat = await fs.promises.lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
    if (!await ensurePrivateDirectory(this.dir)) return false;
    this.#dirReady = true;
    void this.prune();
    return true;
  }

  async #statExisting(thumbPath: string, etag: string): Promise<ThumbnailHit | null> {
    try {
      const stat = await fs.promises.lstat(thumbPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16) return null;
      return { filePath: thumbPath, size: stat.size, etag, mimeType: "image/webp" };
    } catch {
      return null;
    }
  }

  async #resolveEncoder(): Promise<string | null> {
    if (this.#encoderUnavailable) return null;
    if (this.#resolvedFfmpeg !== undefined) return this.#resolvedFfmpeg;
    const candidate = this.#configuredFfmpegPath ?? resolveBundledFfmpeg();
    if (!candidate) {
      this.#encoderUnavailable = true;
      this.#resolvedFfmpeg = null;
      return null;
    }
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      this.#resolvedFfmpeg = candidate;
      return candidate;
    } catch {
      this.#encoderUnavailable = true;
      this.#resolvedFfmpeg = null;
      return null;
    }
  }

  #acquireSlot(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    if (this.#activeCount < this.#maxConcurrency) {
      this.#activeCount++;
      return Promise.resolve(true);
    }
    if (this.#waiters.length >= this.#maxQueued) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #releaseSlot(): void {
    this.#activeCount = Math.max(0, this.#activeCount - 1);
    if (!this.#closed && this.#waiters.length > 0 && this.#activeCount < this.#maxConcurrency) {
      const next = this.#waiters.shift()!;
      this.#activeCount++;
      next(true);
    }
  }

  async #generate(loaded: LoadedUpload, key: string, thumbPath: string, etag: string): Promise<ThumbnailHit | null> {
    if (!await this.#acquireSlot()) return null;
    try {
      if (this.#closed) return null;
      const existing = await this.#statExisting(thumbPath, etag);
      if (existing) return existing;
      const bin = await this.#resolveEncoder();
      if (!bin) return null;
      const demuxer = SUPPORTED_DEMUXERS[loaded.record.mimeType];
      if (!demuxer) return null;

      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(loaded.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch {
        return null;
      }
      let outcome: TranscodeOutcome;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== loaded.record.size) return null;
        if (await shouldSkipSourceByHeader(handle, loaded.record.mimeType, stat.size)) {
          this.#markSkipped(key);
          return null;
        }
        outcome = await this.#transcodePipe(bin, demuxer, handle, loaded.filePath);
      } finally {
        await handle.close().catch(() => {});
      }

      if (outcome.kind === "encoder_missing") {
        this.#encoderUnavailable = true;
        return null;
      }
      if (outcome.kind === "deterministic_fail") {
        this.#markSkipped(key);
        return null;
      }
      if (outcome.kind !== "ok") return null;
      const { bytes } = outcome;
      if (!isValidWebp(bytes) || bytes.length >= loaded.record.size * 0.9) {
        this.#markSkipped(key);
        return null;
      }
      const written = await this.#writeAtomic(thumbPath, bytes);
      if (!written) return null;
      this.#writesSincePrune++;
      if (this.#writesSincePrune >= PRUNE_EVERY_WRITES) {
        this.#writesSincePrune = 0;
        void this.prune();
      }
      return { filePath: thumbPath, size: bytes.length, etag, mimeType: "image/webp" };
    } finally {
      this.#releaseSlot();
    }
  }

  #transcodePipe(bin: string, demuxer: string, handle: fs.promises.FileHandle, sourcePath: string): Promise<TranscodeOutcome> {
    if (this.#lifetime.signal.aborted) return Promise.resolve({ kind: "transient_fail" });
    const args = [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-protocol_whitelist", "pipe",
      "-max_alloc", FFMPEG_MAX_ALLOC,
      "-max_pixels", FFMPEG_MAX_PIXELS,
      "-f", demuxer, "-i", "pipe:0",
      "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-threads", "1",
      "-vf", `scale=w=min(${THUMB_MAX_EDGE}\\,iw):h=min(${THUMB_MAX_EDGE}\\,ih):force_original_aspect_ratio=decrease`,
      "-c:v", "libwebp", "-quality", "80", "-compression_level", "4",
      "-f", "webp", "pipe:1",
    ];
    return new Promise<TranscodeOutcome>((resolve) => {
      const child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: minimalChildEnv(),
      });
      const chunks: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      let killedReason: "timeout" | "abort" | "oversize" | undefined;
      const source = fs.createReadStream(sourcePath, { fd: handle.fd, start: 0, autoClose: false });

      const finish = (outcome: TranscodeOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#lifetime.signal.removeEventListener("abort", onAbort);
        source.destroy();
        resolve(outcome);
      };
      const killChild = (reason: "timeout" | "abort" | "oversize") => {
        if (!killedReason) killedReason = reason;
        source.destroy();
        child.kill("SIGKILL");
      };
      const onAbort = () => killChild("abort");
      const timer = setTimeout(() => killChild("timeout"), this.#timeoutMs);
      timer.unref();
      this.#lifetime.signal.addEventListener("abort", onAbort, { once: true });

      child.stdin.on("error", () => {});
      source.on("error", () => killChild("abort"));
      source.pipe(child.stdin);

      child.stdout.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outBytes += buf.length;
        if (outBytes > MAX_THUMB_BYTES) {
          killChild("oversize");
          return;
        }
        chunks.push(buf);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        errBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        if (errBytes > MAX_STDERR_BYTES) child.stderr.pause();
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "EACCES") finish({ kind: "encoder_missing" });
        else finish({ kind: "transient_fail" });
      });
      child.once("close", (code, signal) => {
        if (killedReason === "timeout" || killedReason === "abort") finish({ kind: "transient_fail" });
        else if (killedReason === "oversize") finish({ kind: "deterministic_fail" });
        else if (code === 0 && !signal) finish({ kind: "ok", bytes: Buffer.concat(chunks, outBytes) });
        else if (code !== null && code !== 0) finish({ kind: "deterministic_fail" });
        else finish({ kind: "transient_fail" });
      });
    });
  }

  async #writeAtomic(targetPath: string, bytes: Buffer): Promise<boolean> {
    const tmpPath = path.join(this.dir, `.${path.basename(targetPath)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(tmpPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.close();
      handle = undefined;
      await fs.promises.rename(tmpPath, targetPath);
      return true;
    } catch {
      return false;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    }
  }
}
