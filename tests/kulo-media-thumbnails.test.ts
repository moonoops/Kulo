import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMediaHttpHandler, type MediaHttpHandler } from "../packages/hub/src/media-http.js";
import { isValidWebp, isValidWebpHeader, MediaThumbnailCache, THUMBNAIL_VERSION } from "../packages/hub/src/media-thumbnails.js";
import { KuloUploadStore } from "../packages/hub/src/uploads.js";

const require = createRequire(import.meta.url);
const BUNDLED_FFMPEG = path.join(
  path.dirname(require.resolve("../packages/hub/node_modules/ffmpeg-static/package.json")),
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);

const dirs: string[] = [];
const servers: http.Server[] = [];
const handlers: MediaHttpHandler[] = [];
const caches: MediaThumbnailCache[] = [];
const bearer = { authorization: "Bearer thumb-owner" };

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function generateImage(args: string[]): Buffer {
  const dir = makeTempDir("kulo-thumb-fixture-");
  const out = path.join(dir, args.at(-1)!);
  execFileSync(BUNDLED_FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args.slice(0, -1), out], { stdio: "pipe" });
  return fs.readFileSync(out);
}

function webpInfo(bytes: Buffer): { fmt: string; width: number; height: number; hasAlpha: boolean } {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
  expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
  expect(isValidWebp(bytes)).toBe(true);
  const fmt = bytes.toString("ascii", 12, 16);
  if (fmt === "VP8 ") {
    return { fmt, width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, hasAlpha: false };
  }
  if (fmt === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { fmt, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, hasAlpha: Boolean(bits & (1 << 28)) };
  }
  if (fmt === "VP8X") {
    return {
      fmt,
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
      hasAlpha: Boolean(bytes[20]! & 0x10),
    };
  }
  throw new Error(`Unexpected WebP chunk format: ${fmt}`);
}

function assertWebpDecodes(bytes: Buffer): void {
  execFileSync(BUNDLED_FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "webp_pipe", "-i", "pipe:0", "-f", "null", "-"], {
    input: bytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function makeExifRotatedJpeg(width: number, height: number): Buffer {
  const raw = generateImage(["-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:d=1`, "-frames:v", "1", "-q:v", "2", "orig.jpg"]);
  const exif = Buffer.from([
    0xff, 0xe1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  return Buffer.concat([raw.subarray(0, 2), exif, raw.subarray(2)]);
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makeApngAfterLargeMetadata(basePng: Buffer): Buffer {
  // Insert >70 KiB tEXt chunk followed by acTL right after IHDR (offset 33) before IDAT.
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  const bigText = makePngChunk("tEXt", Buffer.alloc(72 * 1024, 0x41));
  const acTL = makePngChunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]));
  return Buffer.concat([basePng.subarray(0, ihdrEnd), bigText, acTL, basePng.subarray(ihdrEnd)]);
}

async function startFixture(options: {
  thumbnailsDir?: string;
  thumbnailCache?: MediaThumbnailCache;
} = {}) {
  const root = makeTempDir("kulo-thumb-http-");
  const uploadsDir = path.join(root, "uploads");
  const store = new KuloUploadStore(uploadsDir);
  const thumbnailsDir = options.thumbnailsDir === undefined && !options.thumbnailCache
    ? path.join(root, "cache", "thumbnails")
    : options.thumbnailsDir;
  const handler = createMediaHttpHandler({
    uploads: store,
    ...(options.thumbnailCache ? { thumbnailCache: options.thumbnailCache } : thumbnailsDir ? { thumbnailsDir } : {}),
    authenticate: (req) => req.headers.authorization === "Bearer thumb-owner" ? "owner" : undefined,
  });
  handlers.push(handler);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (!await handler(req, res, url)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Missing address");
  return { root, uploadsDir, thumbnailsDir, store, handler, origin: `http://127.0.0.1:${addr.port}` };
}

function makeWrapperScript(scriptBody: string): string {
  const dir = makeTempDir("kulo-thumb-bin-");
  const file = path.join(dir, "fake-ffmpeg.mjs");
  fs.writeFileSync(file, `#!${process.execPath}\n${scriptBody}\n`, { mode: 0o700 });
  return file;
}

afterEach(async () => {
  for (const cache of caches.splice(0)) cache.close();
  for (const handler of handlers.splice(0)) handler.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("media thumbnails and revalidatable HTTP caching", () => {
  it("generates WebP thumbnails for large PNG (with alpha), odd dimensions, EXIF-rotated JPEG, and disguised filenames", async () => {
    const { origin, store, uploadsDir, thumbnailsDir } = await startFixture();

    // 1. Large 1400x1050 RGBA PNG with alpha channel
    const largeAlphaPng = generateImage([
      "-f", "lavfi", "-i", "testsrc2=s=1400x1050:d=1",
      "-vf", "format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=128",
      "-frames:v", "1", "alpha.png",
    ]);
    const alphaAsset = store.saveUpload({ name: "diagram.png", bytes: largeAlphaPng, ownerId: "owner" });
    const thumbRes = await fetch(`${origin}/api/uploads/${alphaAsset.id}?variant=thumb`, { headers: bearer });
    expect(thumbRes.status).toBe(200);
    expect(thumbRes.headers.get("content-type")).toBe("image/webp");
    expect(thumbRes.headers.get("cache-control")).toBe("private, no-cache");
    expect(thumbRes.headers.get("vary")).toBeNull();
    const thumbEtag = thumbRes.headers.get("etag")!;
    expect(thumbEtag).toMatch(new RegExp(`^"thumb-v${THUMBNAIL_VERSION}-[a-f0-9]{64}"$`));
    const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
    expect(thumbBytes.length).toBeLessThan(largeAlphaPng.length * 0.5);
    const alphaInfo = webpInfo(thumbBytes);
    assertWebpDecodes(thumbBytes);
    expect(alphaInfo.width).toBe(960);
    expect(alphaInfo.height).toBe(720);
    expect(alphaInfo.hasAlpha).toBe(true);
    // Stored under cache/thumbnails, never polluting uploads/
    expect(fs.readdirSync(thumbnailsDir!).some((n) => n.startsWith(`${alphaAsset.id}-`) && n.endsWith(`.v${THUMBNAIL_VERSION}.webp`))).toBe(true);
    expect(fs.readdirSync(uploadsDir).some((n) => n.endsWith(".webp"))).toBe(false);

    // 2. Compliant 304 for thumbnail (no content-length, no mismatched content-type), even AFTER disk eviction
    for (const file of fs.readdirSync(thumbnailsDir!)) fs.rmSync(path.join(thumbnailsDir!, file));
    const revalidated = await fetch(`${origin}/api/uploads/${alphaAsset.id}?variant=thumb`, {
      headers: { ...bearer, "if-none-match": thumbEtag },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("content-length")).toBeNull();
    expect(revalidated.headers.get("content-type")).toBeNull();
    expect(revalidated.headers.get("cache-control")).toBe("private, no-cache");
    expect(revalidated.headers.get("etag")).toBe(thumbEtag);
    // Still evicted -> proves 304 did NOT trigger ffmpeg re-encoding
    expect(fs.readdirSync(thumbnailsDir!)).toEqual([]);

    // 3. HEAD and Range on ?variant=thumb operate strictly on the WebP thumbnail bytes
    const headThumb = await fetch(`${origin}/api/uploads/${alphaAsset.id}?variant=thumb`, { method: "HEAD", headers: bearer });
    expect(headThumb.status).toBe(200);
    expect(headThumb.headers.get("content-type")).toBe("image/webp");
    expect(Number(headThumb.headers.get("content-length"))).toBe(thumbBytes.length);
    const rangeThumb = await fetch(`${origin}/api/uploads/${alphaAsset.id}?variant=thumb`, {
      headers: { ...bearer, range: "bytes=0-15" },
    });
    expect(rangeThumb.status).toBe(206);
    expect(rangeThumb.headers.get("content-type")).toBe("image/webp");
    expect(rangeThumb.headers.get("content-range")).toBe(`bytes 0-15/${thumbBytes.length}`);
    expect(Buffer.from(await rangeThumb.arrayBuffer()).equals(thumbBytes.subarray(0, 16))).toBe(true);

    // 4. download=1 takes precedence over variant=thumb and returns original with no-store
    const downloadRes = await fetch(`${origin}/api/uploads/${alphaAsset.id}?variant=thumb&download=1`, { headers: bearer });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("image/png");
    expect(downloadRes.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(downloadRes.headers.get("cache-control")).toBe("private, no-store");

    // 5. Odd scaled dimensions (1200x675 -> 960x539) & disguised filename with %02d + space
    const oddPng = generateImage(["-f", "lavfi", "-i", "testsrc2=s=1200x675:d=1", "-frames:v", "1", "odd.png"]);
    const disguised = store.saveUpload({ name: "photo %02d.txt", bytes: oddPng, ownerId: "owner" });
    const oddRes = await fetch(`${origin}/api/uploads/${disguised.id}?variant=thumb`, { headers: bearer });
    expect(oddRes.status).toBe(200);
    expect(oddRes.headers.get("content-type")).toBe("image/webp");
    const oddInfo = webpInfo(Buffer.from(await oddRes.arrayBuffer()));
    expect(oddInfo.width).toBe(960);
    expect(oddInfo.height).toBeLessThanOrEqual(540);

    // 6. Asymmetric EXIF Orientation=6 JPEG (1200x600 encoded -> rotated portrait h > w)
    const rotatedJpeg = makeExifRotatedJpeg(1200, 600);
    const exifAsset = store.saveUpload({ name: "portrait.jpg", bytes: rotatedJpeg, ownerId: "owner" });
    const exifRes = await fetch(`${origin}/api/uploads/${exifAsset.id}?variant=thumb`, { headers: bearer });
    expect(exifRes.status).toBe(200);
    expect(exifRes.headers.get("content-type")).toBe("image/webp");
    const exifInfo = webpInfo(Buffer.from(await exifRes.arrayBuffer()));
    expect(exifInfo.height).toBeGreaterThan(exifInfo.width);
    expect(exifInfo.height).toBe(960);
    expect(exifInfo.width).toBe(480);
  });

  it("bypasses small images, GIFs, animated/EXIF WebP, deep-chunk APNG, 64MP+ images, and corrupt images cleanly", async () => {
    const { origin, store } = await startFixture();

    // Small PNG (<= 150 KiB && <= 960px)
    const smallPng = generateImage(["-f", "lavfi", "-i", "color=c=blue:s=320x240:d=1", "-frames:v", "1", "small.png"]);
    const smallAsset = store.saveUpload({ name: "small.png", bytes: smallPng, ownerId: "owner" });
    const smallRes = await fetch(`${origin}/api/uploads/${smallAsset.id}?variant=thumb`, { headers: bearer });
    expect(smallRes.status).toBe(200);
    expect(smallRes.headers.get("content-type")).toBe("image/png");
    expect(smallRes.headers.get("cache-control")).toBe("private, no-cache");

    // GIF preserved untouched
    const gifBytes = generateImage(["-f", "lavfi", "-i", "testsrc=s=1000x600:d=0.4:r=5", "anim.gif"]);
    const gifAsset = store.saveUpload({ name: "anim.gif", bytes: gifBytes, ownerId: "owner" });
    const gifRes = await fetch(`${origin}/api/uploads/${gifAsset.id}?variant=thumb`, { headers: bearer });
    expect(gifRes.status).toBe(200);
    expect(gifRes.headers.get("content-type")).toBe("image/gif");

    // Animated WebP (VP8X anim flag 0x02) preserved untouched
    const animWebp = generateImage(["-f", "lavfi", "-i", "testsrc=s=1000x600:d=0.4:r=5", "-c:v", "libwebp_anim", "-method", "0", "-quality", "50", "anim.webp"]);
    const animWebpAsset = store.saveUpload({ name: "anim.webp", bytes: animWebp, ownerId: "owner" });
    const animWebpRes = await fetch(`${origin}/api/uploads/${animWebpAsset.id}?variant=thumb`, { headers: bearer });
    expect(animWebpRes.status).toBe(200);
    expect(Buffer.from(await animWebpRes.arrayBuffer()).equals(animWebp)).toBe(true);

    // WebP with VP8X EXIF flag (0x08) skipped to avoid orientation loss
    const exifWebp = Buffer.from(animWebp);
    exifWebp[20] = (exifWebp[20]! & ~0x02) | 0x08;
    const exifWebpAsset = store.saveUpload({ name: "exif.webp", bytes: exifWebp, ownerId: "owner" });
    const exifWebpRes = await fetch(`${origin}/api/uploads/${exifWebpAsset.id}?variant=thumb`, { headers: bearer });
    expect(exifWebpRes.status).toBe(200);
    expect(Buffer.from(await exifWebpRes.arrayBuffer()).equals(exifWebp)).toBe(true);

    // APNG with acTL placed AFTER a >72 KiB tEXt chunk (beyond 64 KiB prefix)
    const bigPng = generateImage(["-f", "lavfi", "-i", "testsrc2=s=1100x800:d=1", "-frames:v", "1", "base.png"]);
    const apngBytes = makeApngAfterLargeMetadata(bigPng);
    const apngAsset = store.saveUpload({ name: "anim.png", bytes: apngBytes, ownerId: "owner" });
    const apngRes = await fetch(`${origin}/api/uploads/${apngAsset.id}?variant=thumb`, { headers: bearer });
    expect(apngRes.status).toBe(200);
    expect(apngRes.headers.get("content-type")).toBe("image/png");

    // Oversized pixel header (20000x20000 decompression bomb) bypassed without calling ffmpeg
    const bombPng = Buffer.from(bigPng);
    bombPng.writeUInt32BE(20_000, 16);
    bombPng.writeUInt32BE(20_000, 20);
    const bombAsset = store.saveUpload({ name: "bomb.png", bytes: bombPng, ownerId: "owner" });
    const bombRes = await fetch(`${origin}/api/uploads/${bombAsset.id}?variant=thumb`, { headers: bearer });
    expect(bombRes.status).toBe(200);
    expect(bombRes.headers.get("content-type")).toBe("image/png");

    // Corrupted PNG bytes (valid 24-byte IHDR header, garbage IDAT) degrade gracefully to original
    const corruptPng = Buffer.concat([bigPng.subarray(0, 33), Buffer.alloc(160 * 1024, 0xff)]);
    const corruptAsset = store.saveUpload({ name: "corrupt.png", bytes: corruptPng, ownerId: "owner" });
    const corruptRes = await fetch(`${origin}/api/uploads/${corruptAsset.id}?variant=thumb`, { headers: bearer });
    expect(corruptRes.status).toBe(200);
    expect(corruptRes.headers.get("content-type")).toBe("image/png");
  });

  it("isolates child env secrets, deduplicates single-flight, avoids negative-cache poisoning on transient failures, and trips missing-binary breaker", async () => {
    const root = makeTempDir("kulo-thumb-sec-");
    const uploadsDir = path.join(root, "uploads");
    const thumbsDir = path.join(root, "cache", "thumbnails");
    const store = new KuloUploadStore(uploadsDir);
    const bigPng = generateImage(["-f", "lavfi", "-i", "testsrc2=s=1200x800:d=1", "-frames:v", "1", "big.png"]);
    const assetA = store.saveUpload({ name: "a.png", bytes: bigPng, ownerId: "owner" });
    const assetB = store.saveUpload({ name: "b.png", bytes: Buffer.concat([bigPng, Buffer.from("b")]), ownerId: "owner" });

    // Wrapper that records env keys, signals start, waits for gate file removal, and delegates to real bundled ffmpeg
    const logFile = path.join(root, "calls.jsonl");
    const startedFile = path.join(root, "started");
    const gateFile = path.join(root, "gate");
    const wrapper = makeWrapperScript(`
      import fs from "node:fs";
      import { spawnSync } from "node:child_process";
      fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ keys: Object.keys(process.env) }) + "\\n");
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const input = Buffer.concat(chunks);
      if (fs.existsSync(${JSON.stringify(gateFile)})) {
        fs.writeFileSync(${JSON.stringify(startedFile)}, "1");
        while (fs.existsSync(${JSON.stringify(gateFile)})) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      const res = spawnSync(${JSON.stringify(BUNDLED_FFMPEG)}, process.argv.slice(2), { input, maxBuffer: 8 * 1024 * 1024 });
      if (res.stdout?.length) process.stdout.write(res.stdout);
      if (res.stderr?.length) process.stderr.write(res.stderr);
      process.exit(res.status ?? 1);
    `);

    const prevOpenAI = process.env.OPENAI_API_KEY;
    const prevHubToken = process.env.KULO_AUTH_TOKEN;
    process.env.OPENAI_API_KEY = "sk-secret-must-not-leak";
    process.env.KULO_AUTH_TOKEN = "hub-secret-must-not-leak";
    try {
      fs.writeFileSync(gateFile, "1");
      const cache = new MediaThumbnailCache({ dir: thumbsDir, uploadsDir, ffmpegPath: wrapper, maxConcurrency: 1, maxQueued: 0 });
      caches.push(cache);

      // Single-flight: 4 concurrent calls for assetA spawn ffmpeg once; while A holds the only slot, B hits queue-full (maxQueued=0) -> null
      const loadedA = store.getUpload(assetA.id)!;
      const loadedB = store.getUpload(assetB.id)!;
      const groupA = Promise.all([
        cache.getOrCreate(loadedA),
        cache.getOrCreate(loadedA),
        cache.getOrCreate(loadedA),
        cache.getOrCreate(loadedA),
      ]);
      for (let i = 0; i < 200 && !fs.existsSync(startedFile); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(startedFile)).toBe(true);
      const rBOverflow = await cache.getOrCreate(loadedB);
      fs.rmSync(gateFile, { force: true });
      const [r1, r2, r3, r4] = await groupA;
      expect(r1?.mimeType).toBe("image/webp");
      expect(r2?.filePath).toBe(r1?.filePath);
      expect(r3?.filePath).toBe(r1?.filePath);
      expect(r4?.filePath).toBe(r1?.filePath);
      expect(rBOverflow).toBeNull();

      // Queue overflow is transient -> assetB must NOT be poisoned in skipped cache and succeeds on next call
      const rBRetry = await cache.getOrCreate(loadedB);
      expect(rBRetry?.mimeType).toBe("image/webp");

      const calls = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { keys: string[] });
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.keys).not.toContain("OPENAI_API_KEY");
        expect(call.keys).not.toContain("KULO_AUTH_TOKEN");
      }
    } finally {
      if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOpenAI;
      if (prevHubToken === undefined) delete process.env.KULO_AUTH_TOKEN; else process.env.KULO_AUTH_TOKEN = prevHubToken;
    }

    // Timeout aborts cleanly without poisoning skipped cache
    const slowWrapper = makeWrapperScript(`setTimeout(() => process.exit(0), 5000);`);
    const timeoutCache = new MediaThumbnailCache({
      dir: path.join(root, "cache-timeout"), uploadsDir, ffmpegPath: slowWrapper, timeoutMs: 250,
    });
    caches.push(timeoutCache);
    expect(await timeoutCache.getOrCreate(store.getUpload(assetA.id)!)).toBeNull();
    expect(timeoutCache.isDeterministicBypass(store.getUpload(assetA.id)!.record)).toBe(false);
    timeoutCache.close();

    // Missing binary trips global circuit breaker (no repeated spawns)
    const missingCache = new MediaThumbnailCache({
      dir: path.join(root, "cache-missing"), uploadsDir, ffmpegPath: path.join(root, "nonexistent-ffmpeg"),
    });
    caches.push(missingCache);
    expect(await missingCache.getOrCreate(store.getUpload(assetA.id)!)).toBeNull();
    expect(await missingCache.getOrCreate(store.getUpload(assetB.id)!)).toBeNull();
  });

  it("prunes stale tmp files, orphan/old-version thumbs, and LRU-evicts over budget while protecting fresh files", async () => {
    const root = makeTempDir("kulo-thumb-prune-");
    const uploadsDir = path.join(root, "uploads");
    const thumbsDir = path.join(root, "cache", "thumbnails");
    const store = new KuloUploadStore(uploadsDir);
    const bigPng = generateImage(["-f", "lavfi", "-i", "testsrc2=s=1000x800:d=1", "-frames:v", "1", "p.png"]);
    const live1 = store.saveUpload({ name: "1.png", bytes: bigPng, ownerId: "owner" });
    const live2 = store.saveUpload({ name: "2.png", bytes: Buffer.concat([bigPng, Buffer.from("2")]), ownerId: "owner" });
    const live3 = store.saveUpload({ name: "3.png", bytes: Buffer.concat([bigPng, Buffer.from("3")]), ownerId: "owner" });

    fs.mkdirSync(thumbsDir, { recursive: true, mode: 0o700 });
    const now = 1_700_000_000_000;
    const writeTimed = (name: string, size: number, ageMs: number) => {
      const p = path.join(thumbsDir, name);
      fs.writeFileSync(p, Buffer.alloc(size, 0x57));
      const t = (now - ageMs) / 1000;
      fs.utimesSync(p, t, t);
      return p;
    };

    const staleTmp = writeTimed(".att_x.abc123.tmp", 64, 10 * 60_000);
    const freshTmp = writeTimed(".att_y.def456.tmp", 64, 10_000);
    const orphan = writeTimed(`att_missing01-0123456789abcdef.v${THUMBNAIL_VERSION}.webp`, 2048, 120_000);
    const oldVer = writeTimed(`${live1.id}-0123456789abcdef.v1.webp`, 2048, 120_000);
    const oldestLive = writeTimed(`${live1.id}-aaaaaaaaaaaaaaaa.v${THUMBNAIL_VERSION}.webp`, 4000, 300_000);
    const middleLive = writeTimed(`${live2.id}-bbbbbbbbbbbbbbbb.v${THUMBNAIL_VERSION}.webp`, 4000, 200_000);
    const hotLive = writeTimed(`${live3.id}-cccccccccccccccc.v${THUMBNAIL_VERSION}.webp`, 4000, 10_000);

    const cache = new MediaThumbnailCache({
      dir: thumbsDir, uploadsDir, maxCacheBytes: 9000, targetCacheBytes: 6000, now: () => now,
    });
    caches.push(cache);
    await cache.prune();

    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(oldVer)).toBe(false);
    expect(fs.existsSync(oldestLive)).toBe(false);
    expect(fs.existsSync(middleLive)).toBe(false);
    expect(fs.existsSync(hotLive)).toBe(true);
  });

  it("disables thumbnailing when thumbnailsDir is omitted without creating cache directories", async () => {
    const { root, origin, store } = await startFixture({ thumbnailsDir: "" });
    const bigPng = generateImage(["-f", "lavfi", "-i", "testsrc2=s=1200x800:d=1", "-frames:v", "1", "big.png"]);
    const asset = store.saveUpload({ name: "big.png", bytes: bigPng, ownerId: "owner" });
    const res = await fetch(`${origin}/api/uploads/${asset.id}?variant=thumb`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(fs.existsSync(path.join(root, "cache"))).toBe(false);
  });

  it("emits valid RIFF sizes for >32 KiB RGB/RGBA WebP thumbnails, self-heals corrupt v1/v2 cache files, and validates odd-length chunks", async () => {
    // 1. Validation edge cases: riff_size=0, odd-length VP8L chunk padding, VP8X without pixel bitstream
    const oddChunkPayload = Buffer.alloc(247, 0x22);
    const oddValid = Buffer.alloc(20 + 247 + 1);
    oddValid.write("RIFF", 0, "ascii");
    oddValid.writeUInt32LE(oddValid.length - 8, 4);
    oddValid.write("WEBP", 8, "ascii");
    oddValid.write("VP8L", 12, "ascii");
    oddValid.writeUInt32LE(247, 16);
    oddChunkPayload.copy(oddValid, 20);
    expect(isValidWebpHeader(oddValid.subarray(0, 20), oddValid.length)).toBe(true);
    expect(isValidWebp(oddValid)).toBe(true);

    const zeroRiff = Buffer.from(oddValid);
    zeroRiff.writeUInt32LE(0, 4);
    expect(isValidWebpHeader(zeroRiff.subarray(0, 20), zeroRiff.length)).toBe(false);
    expect(isValidWebp(zeroRiff)).toBe(false);

    const vp8xNoPixels = Buffer.alloc(38);
    vp8xNoPixels.write("RIFF", 0, "ascii");
    vp8xNoPixels.writeUInt32LE(30, 4);
    vp8xNoPixels.write("WEBP", 8, "ascii");
    vp8xNoPixels.write("VP8X", 12, "ascii");
    vp8xNoPixels.writeUInt32LE(10, 16);
    vp8xNoPixels.write("EXIF", 30, "ascii");
    vp8xNoPixels.writeUInt32LE(0, 34);
    expect(isValidWebp(vp8xNoPixels)).toBe(false);

    // 2. High-entropy >32 KiB WebP thumbnails (RGB + RGBA) must have exact riff_size and decode cleanly
    const { origin, store, thumbnailsDir } = await startFixture();
    const noisyRgbPng = generateImage([
      "-f", "lavfi", "-i", "nullsrc=s=1400x1050:d=1",
      "-vf", "geq=r='random(1)*255':g='random(2)*255':b='random(3)*255'",
      "-frames:v", "1", "noisy-rgb.png",
    ]);
    const noisyRgbaPng = generateImage([
      "-f", "lavfi", "-i", "nullsrc=s=1200x900:d=1",
      "-vf", "format=rgba,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255':a='if(lt(X,600),128,255)'",
      "-frames:v", "1", "noisy-rgba.png",
    ]);
    const rgbAsset = store.saveUpload({ name: "screenshot-rgb.png", bytes: noisyRgbPng, ownerId: "owner" });
    const rgbaAsset = store.saveUpload({ name: "screenshot-rgba.png", bytes: noisyRgbaPng, ownerId: "owner" });

    // Pre-seed a corrupted v1 cache file and send its legacy v1 ETag -> must miss 304 fast-path, regenerate v2, then 304 on v2
    const loadedRgb = store.getUpload(rgbAsset.id)!;
    const prefix = loadedRgb.record.sha256!.slice(0, 16);
    fs.mkdirSync(thumbnailsDir!, { recursive: true, mode: 0o700 });
    const corruptV1Path = path.join(thumbnailsDir!, `${rgbAsset.id}-${prefix}.v1.webp`);
    fs.writeFileSync(corruptV1Path, zeroRiff);
    const oldV1Etag = `"thumb-v1-${loadedRgb.record.sha256!}"`;

    const upgradeRes = await fetch(`${origin}/api/uploads/${rgbAsset.id}?variant=thumb`, {
      headers: { ...bearer, "if-none-match": oldV1Etag },
    });
    expect(upgradeRes.status).toBe(200);
    const v2Etag = upgradeRes.headers.get("etag")!;
    expect(v2Etag).toBe(`"thumb-v${THUMBNAIL_VERSION}-${loadedRgb.record.sha256!}"`);
    const rgbThumb = Buffer.from(await upgradeRes.arrayBuffer());
    expect(rgbThumb.length).toBeGreaterThan(64 * 1024);
    const rgbInfo = webpInfo(rgbThumb);
    expect(rgbInfo.width).toBe(960);
    expect(rgbInfo.height).toBe(720);
    assertWebpDecodes(rgbThumb);

    const v2Revalidate = await fetch(`${origin}/api/uploads/${rgbAsset.id}?variant=thumb`, {
      headers: { ...bearer, "if-none-match": v2Etag },
    });
    expect(v2Revalidate.status).toBe(304);

    // 3. Large >32 KiB RGBA WebP preserves alpha and exact RIFF length
    const rgbaRes = await fetch(`${origin}/api/uploads/${rgbaAsset.id}?variant=thumb`, { headers: bearer });
    expect(rgbaRes.status).toBe(200);
    const rgbaThumb = Buffer.from(await rgbaRes.arrayBuffer());
    expect(rgbaThumb.length).toBeGreaterThan(64 * 1024);
    const rgbaInfo = webpInfo(rgbaThumb);
    expect(rgbaInfo.width).toBe(960);
    expect(rgbaInfo.height).toBe(720);
    expect(rgbaInfo.hasAlpha).toBe(true);
    assertWebpDecodes(rgbaThumb);

    // 4. Corrupt on-disk v2 cache file is detected by #statExisting, removed, and regenerated transparently
    const v2Path = path.join(thumbnailsDir!, `${rgbAsset.id}-${prefix}.v${THUMBNAIL_VERSION}.webp`);
    fs.writeFileSync(v2Path, zeroRiff);
    const healedRes = await fetch(`${origin}/api/uploads/${rgbAsset.id}?variant=thumb`, { headers: bearer });
    expect(healedRes.status).toBe(200);
    const healedBytes = Buffer.from(await healedRes.arrayBuffer());
    expect(healedBytes.length).toBeGreaterThan(64 * 1024);
    webpInfo(healedBytes);
    assertWebpDecodes(healedBytes);
  });
});
