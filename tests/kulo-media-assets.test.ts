import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_AUDIO_UPLOAD_BYTES, MAX_MESSAGE_UPLOAD_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES,
  MEDIA_UPLOAD_LIMITS, KuloUploadStore, UploadError, parseUserEntryContent, uploadByteLimit,
} from "../packages/hub/src/uploads.js";
import { createMediaHttpHandler, parseMediaRange, type MediaHttpHandler } from "../packages/hub/src/media-http.js";
import { inspectMediaPrefix, probeMediaFile } from "../packages/hub/src/media-probe.js";

const dirs: string[] = [];
const servers: http.Server[] = [];
const handlers: MediaHttpHandler[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const videoHeader = Buffer.from("000000186674797069736F6D0000020069736F6D6D703432", "hex");
const bearer = { authorization: "Bearer synthetic-media-owner" };

function makeStore(): KuloUploadStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-media-"));
  dirs.push(dir);
  return new KuloUploadStore(dir);
}

function wav(seconds = 1): Buffer {
  const sampleRate = 8000;
  const dataLength = sampleRate * seconds * 2;
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}

async function* pieces(bytes: Buffer, size = 127): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

function resizeAsset(store: KuloUploadStore, id: string, size: number): void {
  const loaded = store.getUpload(id)!;
  fs.truncateSync(loaded.filePath, size);
  fs.writeFileSync(path.join(store.dir, `${id}.meta.json`), JSON.stringify({ ...loaded.record, size }));
}

async function httpFixture(options: { now?: () => number; isPrincipalActive?: (principal: string) => boolean } = {}) {
  const store = makeStore();
  const authenticate = (req: http.IncomingMessage, url: URL): string | undefined => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
    return token === "synthetic-media-owner" ? "owner" : token === "synthetic-media-peer" ? "peer" : undefined;
  };
  const handler = createMediaHttpHandler({
    uploads: store, authenticate, sessionTtlMs: 1000, ...options,
    canReadScope: (principal, scope) => principal === "owner" || scope === "shared",
  });
  handlers.push(handler);
  const errors: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (await handler(req, res, url)) return;
      res.writeHead(authenticate(req, url) ? 200 : 401);
      res.end();
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const session = async () => {
    const response = await fetch(`${origin}/api/media/session`, { method: "POST", headers: { ...bearer, origin } });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return { response, cookie };
  };
  return { store, handler, origin, session, errors };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handler of handlers.splice(0)) handler.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

describe("media signature and upload storage", () => {
  it("uses actual media headers and keeps active document formats downloadable", () => {
    expect(inspectMediaPrefix(png, "video/mp4")).toMatchObject({ kind: "image", mimeType: "image/png", width: 1, height: 1, metadataStatus: "ready" });
    expect(inspectMediaPrefix(wav(2), "application/octet-stream", wav(2).length)).toMatchObject({ kind: "audio", mimeType: "audio/wav", duration: 2, metadataStatus: "ready" });
    expect(inspectMediaPrefix(videoHeader, "image/png")).toMatchObject({ kind: "video", mimeType: "video/mp4", metadataStatus: "unavailable" });
    expect(inspectMediaPrefix(Buffer.from("<svg onload='alert(1)'></svg>"), "image/png")).toMatchObject({ kind: "file", mimeType: "image/svg+xml" });
    expect(inspectMediaPrefix(Buffer.from("<!doctype html><html></html>"), "image/png")).toMatchObject({ kind: "file", mimeType: "text/html" });
    expect(inspectMediaPrefix(Buffer.from("ordinary text"), "audio/mpeg")).toMatchObject({ kind: "file", mimeType: "application/octet-stream" });
    expect(inspectMediaPrefix(Buffer.from("GIF89a\0\0\0\0", "binary"))).toMatchObject({ kind: "image", metadataStatus: "unavailable" });
  });

  it("stores streamed assets atomically and never fabricates unavailable probe metadata", async () => {
    const store = makeStore();
    const audio = await store.saveUploadStream({ name: "../../录音.wav", stream: pieces(wav(2)), ownerId: "owner" });
    expect(audio).toMatchObject({ name: "录音.wav", kind: "audio", mimeType: "audio/wav", duration: 2, metadataStatus: "ready" });
    const loaded = store.getUpload(audio.id)!;
    expect(store.readUploadBytes(loaded).equals(wav(2))).toBe(true);
    expect(loaded.record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.record.ownerId).toBe("owner");
    expect(fs.readdirSync(store.dir).some((name) => name.endsWith(".partial"))).toBe(false);

    const invalidVideo = store.saveUpload({ name: "incomplete.mp4", bytes: videoHeader });
    const video = store.getUpload(invalidVideo.id)!;
    const metadata = await probeMediaFile(video.filePath, inspectMediaPrefix(videoHeader));
    expect(metadata).toMatchObject({ kind: "video", metadataStatus: "unavailable" });
    expect(metadata.duration).toBeUndefined();
    expect(metadata.width).toBeUndefined();
  });

  it("persists voice presentation and keeps recorded time separate from probed duration", async () => {
    const store = makeStore();
    const measured = await store.saveUploadStream({ name: "recording.wav", stream: pieces(wav(2)), ownerId: "owner", presentation: "voice", recordedDuration: 2.7 });
    expect(measured).toMatchObject({ kind: "audio", presentation: "voice", recordedDuration: 2.7, duration: 2, metadataStatus: "ready" });
    const fallback = store.saveUpload({ name: "recording.mp3", bytes: Buffer.from("ID3metadata unavailable"), presentation: "voice", recordedDuration: 3.4 });
    expect(fallback).toMatchObject({ kind: "audio", presentation: "voice", recordedDuration: 3.4, metadataStatus: "unavailable" });
    expect(fallback.duration).toBeUndefined();
    const reopened = new KuloUploadStore(store.dir);
    expect(reopened.toChatAttachment(reopened.getUpload(measured.id)!.record)).toEqual(measured);
    expect(reopened.toChatAttachment(reopened.getUpload(fallback.id)!.record)).toEqual(fallback);
    const historic = parseUserEntryContent(reopened.buildMultimodalContent("", [measured]).content);
    expect(historic.attachments).toEqual([measured]);
    expect(reopened.saveUpload({ bytes: wav(), presentation: "voice", recordedDuration: 0 })).toMatchObject({ presentation: "voice", recordedDuration: 0 });
  });

  it("does not infer voice presentation from a filename, audio MIME or client attachment fields", () => {
    const store = makeStore();
    const audio = store.saveUpload({ name: "语音.wav", mimeType: "audio/wav", bytes: wav() });
    expect(audio.presentation).toBeUndefined();
    expect(audio.recordedDuration).toBeUndefined();
    const forged = { ...audio, presentation: "voice" as const, recordedDuration: 999, duration: 999 };
    const authoritative = store.buildMultimodalContent("", [forged]);
    expect(authoritative.attachments).toEqual([audio]);
    expect(parseUserEntryContent(authoritative.content).attachments).toEqual([audio]);
    const voice = store.saveUpload({ bytes: wav(), presentation: "voice", recordedDuration: 1.2 });
    expect(store.buildMultimodalContent("", [{ ...voice, recordedDuration: 999, duration: 999 }]).attachments).toEqual([voice]);
  });

  it.each([
    { presentation: "other", recordedDuration: 1 },
    { presentation: "voice", recordedDuration: NaN },
    { presentation: "voice", recordedDuration: Infinity },
    { presentation: "voice", recordedDuration: -1 },
    { presentation: "voice", recordedDuration: 86400.001 },
    { presentation: "voice", recordedDuration: "1" },
    { recordedDuration: 1 },
  ])("rejects invalid voice metadata before writing any resource: %j", async (input) => {
    const store = makeStore();
    const unsafe = input as { presentation?: "voice"; recordedDuration?: number };
    expect(() => store.saveUpload({ bytes: wav(), ...unsafe })).toThrow(UploadError);
    await expect(store.saveUploadStream({ stream: pieces(wav()), ...unsafe })).rejects.toMatchObject({ status: 400 });
    expect(fs.readdirSync(store.dir)).toEqual([]);
  });

  it.each([png, videoHeader, Buffer.from("not audio")])("rejects non-audio voice resources even when their declared MIME is audio", async (bytes) => {
    const store = makeStore();
    expect(() => store.saveUpload({ bytes, mimeType: "audio/wav", presentation: "voice", recordedDuration: 1 })).toThrowError(/必须上传音频/);
    await expect(store.saveUploadStream({ stream: pieces(bytes), mimeType: "audio/wav", presentation: "voice", recordedDuration: 1 })).rejects.toMatchObject({ status: 400 });
    expect(fs.readdirSync(store.dir)).toEqual([]);
  });

  it("keeps voice metadata immutable during owner-checked durable publication replays", async () => {
    const store = makeStore();
    const voice = await store.saveUploadStream({ stream: pieces(wav()), presentation: "voice", recordedDuration: 1.25, ownerId: "owner", idempotencyKey: "voice:first" });
    const reopened = new KuloUploadStore(store.dir);
    const replayed = await reopened.saveUploadStream({ stream: pieces(wav(2)), presentation: "voice", recordedDuration: 200, ownerId: "owner", idempotencyKey: "voice:first" });
    expect(replayed).toEqual(voice);
    expect(reopened.saveUpload({ bytes: wav(2), ownerId: "owner", idempotencyKey: "voice:first" })).toEqual(voice);
    await expect(reopened.saveUploadStream({ stream: pieces(wav()), presentation: "voice", recordedDuration: 1, ownerId: "peer", idempotencyKey: "voice:first" })).rejects.toMatchObject({ status: 409 });
    expect(() => reopened.saveUpload({ bytes: wav(), ownerId: "peer", idempotencyKey: "voice:first" })).toThrowError(/归属不匹配/);
    expect(fs.readdirSync(store.dir)).toHaveLength(2);
  });

  it("cleans cancelled and failed streams without exposing a complete asset", async () => {
    const store = makeStore();
    const controller = new AbortController();
    async function* cancelled() { yield Buffer.from("partial"); controller.abort(); yield Buffer.from("not written"); }
    await expect(store.saveUploadStream({ stream: cancelled(), signal: controller.signal })).rejects.toMatchObject({ status: 499 });
    expect(fs.readdirSync(store.dir)).toEqual([]);
    async function* failed() { yield Buffer.from("partial"); throw new Error("source failed"); }
    await expect(store.saveUploadStream({ stream: failed() })).rejects.toThrow("source failed");
    expect(fs.readdirSync(store.dir)).toEqual([]);
    await expect(store.saveUploadStream({ stream: pieces(Buffer.alloc(0)) })).rejects.toMatchObject({ status: 400 });
    expect(fs.readdirSync(store.dir)).toEqual([]);
  });

  it("rolls back a payload when its metadata cannot be committed", () => {
    const store = makeStore();
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(destination).endsWith(".meta.json")) throw Object.assign(new Error("no disk space"), { code: "ENOSPC" });
      rename(source, destination);
    });
    expect(() => store.saveUpload({ bytes: png })).toThrow("no disk space");
    expect(fs.readdirSync(store.dir)).toEqual([]);
  });

  it.each([
    { kind: "file", header: Buffer.from("plain"), limit: MAX_UPLOAD_BYTES },
    { kind: "image", header: png, limit: MAX_UPLOAD_BYTES },
    { kind: "audio", header: Buffer.from("ID3"), limit: MAX_AUDIO_UPLOAD_BYTES },
    { kind: "video", header: videoHeader, limit: MAX_VIDEO_UPLOAD_BYTES },
  ])("enforces the $kind limit while receiving a stream", async ({ kind, header, limit }) => {
    const store = makeStore();
    const block = Buffer.alloc(1024 * 1024);
    async function* oversized() {
      yield header;
      for (let i = 0; i <= limit / block.length; i++) yield block;
    }
    await expect(store.saveUploadStream({ stream: oversized() })).rejects.toMatchObject({ status: 413 });
    expect(uploadByteLimit(kind as "image" | "audio" | "video" | "file")).toBe(limit);
    expect(fs.readdirSync(store.dir)).toEqual([]);
  });

  it("reuses durable publication IDs across retries, restarts and concurrent calls", async () => {
    const store = makeStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let consumedRetry = false;
    async function* original() { yield Buffer.from("saved result"); await gate; }
    async function* retried() { consumedRetry = true; yield Buffer.from("changed result"); }
    const first = store.saveUploadStream({ name: "result.txt", stream: original(), ownerId: "owner", idempotencyKey: "call:one" });
    const duplicate = store.saveUploadStream({ stream: retried(), ownerId: "owner", idempotencyKey: "call:one" });
    await expect(store.saveUploadStream({ stream: retried(), ownerId: "peer", idempotencyKey: "call:one" })).rejects.toMatchObject({ status: 409 });
    release();
    const [a, b] = await Promise.all([first, duplicate]);
    expect(a).toEqual(b);
    expect(consumedRetry).toBe(false);
    const recovered = new KuloUploadStore(store.dir);
    expect(await recovered.saveUploadStream({ stream: retried(), ownerId: "owner", idempotencyKey: "call:one" })).toEqual(a);
    expect(consumedRetry).toBe(false);
    expect(fs.readdirSync(store.dir)).toHaveLength(2);
  });

  it("keeps draft ownership until an accessible message reference is established", () => {
    const store = makeStore();
    const asset = store.saveUpload({ bytes: png, ownerId: "owner" });
    expect(store.canReadUpload(asset.id, "owner", () => false)).toBe(true);
    expect(store.canReadUpload(asset.id, "peer", () => true)).toBe(false);
    expect(() => store.bindAttachments([asset], "shared", "peer")).toThrow(UploadError);
    store.bindAttachments([asset], "shared", "owner");
    store.bindAttachments([asset], "shared", "owner");
    expect(store.getUpload(asset.id)!.record.referenceScopes).toEqual(["shared"]);
    expect(store.canReadUpload(asset.id, "peer", (scope) => scope === "shared")).toBe(true);
    expect(store.canReadUpload(asset.id, "peer", () => false)).toBe(false);
    const abandoned = store.saveUpload({ bytes: Buffer.from("draft"), ownerId: "owner" });
    expect(store.cleanupDrafts(Date.now() + 1)).toBe(1);
    expect(store.getUpload(abandoned.id)).toBeNull();
    expect(store.getUpload(asset.id)).not.toBeNull();
  });

  it("migrates legacy metadata without changing IDs or accepting spoofed image MIME", () => {
    const store = makeStore();
    const asset = store.saveUpload({ name: "legacy.png", bytes: Buffer.from("<html>legacy</html>"), mimeType: "image/png" });
    const loaded = store.getUpload(asset.id)!;
    const { version: _version, metadataStatus: _status, referenceScopes: _scopes, ...legacy } = loaded.record;
    fs.writeFileSync(path.join(store.dir, `${asset.id}.meta.json`), JSON.stringify({ ...legacy, kind: "image", mimeType: "image/png" }));
    const recovered = store.getUpload(asset.id)!;
    expect(recovered.record).toMatchObject({ id: asset.id, kind: "file", mimeType: "text/html", version: 2 });
    expect(store.canReadUpload(asset.id, "authenticated-peer", () => false)).toBe(true);
    expect(store.canReadUpload(asset.id, "", () => false)).toBe(false);
    store.bindAttachments([asset.id], "historic-scope");
    expect(store.getUpload(asset.id)!.record.referenceScopes).toEqual(["historic-scope"]);
    expect(store.cleanupDrafts(Date.now() + 1)).toBe(0);
  });

  it("bounds message attachment count and total bytes using stored metadata", () => {
    const store = makeStore();
    const a = store.saveUpload({ name: "a.mp4", bytes: videoHeader });
    const b = store.saveUpload({ name: "b.mp4", bytes: videoHeader });
    resizeAsset(store, a.id, MAX_MESSAGE_UPLOAD_BYTES / 2);
    resizeAsset(store, b.id, MAX_MESSAGE_UPLOAD_BYTES / 2 + 1);
    expect(() => store.resolveAttachments([a, b])).toThrowError(/300 MiB/);
    expect(() => store.resolveAttachments(Array.from({ length: 17 }, () => a))).toThrowError(/16/);
    expect(store.resolveAttachments([a, a])).toHaveLength(1);
  });

  it("preserves manifest round trips and avoids reading large non-image content into memory", () => {
    const store = makeStore();
    const text = store.saveUpload({ name: "note.md", bytes: Buffer.from("# saved text") });
    const audio = store.saveUpload({ name: "voice.wav", bytes: wav(3) });
    const read = store.readUploadBytes.bind(store);
    let reads = 0;
    store.readUploadBytes = (loaded) => { reads++; return read(loaded); };
    const content = store.buildMultimodalContent("请阅读", [text, audio]);
    expect(reads).toBe(1);
    expect(parseUserEntryContent(content.content)).toMatchObject({ text: "请阅读", attachments: [{ id: text.id }, { id: audio.id }] });
    expect(JSON.stringify(content.content)).toContain("# saved text");
    expect(JSON.stringify(content.content)).toContain("不代表模型已读取媒体内容");
  });

  it("rejects symlinked resources and metadata instead of serving files outside the store", () => {
    const store = makeStore();
    const asset = store.saveUpload({ name: "inside.txt", bytes: Buffer.from("inside") });
    const loaded = store.getUpload(asset.id)!;
    const outside = path.join(makeStore().dir, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.rmSync(loaded.filePath);
    fs.symlinkSync(outside, loaded.filePath);
    expect(() => store.getUpload(asset.id)).toThrowError(/资源文件不可用/);
    fs.rmSync(path.join(store.dir, `${asset.id}.meta.json`));
    fs.symlinkSync(outside, path.join(store.dir, `${asset.id}.meta.json`));
    expect(() => store.getUpload(asset.id)).toThrowError(/资源索引不可用/);
  });

  it("removes expired partial files while retaining recent files and complete assets", () => {
    const store = makeStore();
    store.saveUpload({ bytes: png });
    const stale = path.join(store.dir, ".att_stale123.partial");
    const recent = path.join(store.dir, ".att_recent12.partial");
    fs.writeFileSync(stale, "incomplete");
    fs.writeFileSync(recent, "current");
    fs.utimesSync(stale, new Date(0), new Date(0));
    expect(store.cleanupIncompleteUploads(Date.now() - 1000)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.readdirSync(store.dir)).toHaveLength(3);
  });
});

describe("asset HTTP authentication and media responses", () => {
  it("accepts recorded voice metadata and reuses the upload receipt within its authenticated owner", async () => {
    const { origin, store, errors } = await httpFixture();
    const upload = async (recordedDuration: number, headers = bearer) => {
      const response = await fetch(`${origin}/api/uploads?name=voice.wav&presentation=voice&recordedDuration=${recordedDuration}`, {
        method: "POST", headers: { ...headers, "content-type": "audio/wav", "x-upload-id": "voice-retry_01" }, body: wav(),
      });
      expect(response.status).toBe(201);
      return (await response.json()).attachment;
    };
    const first = await upload(1.25);
    expect(first).toMatchObject({ presentation: "voice", recordedDuration: 1.25, duration: 1, metadataStatus: "ready" });
    expect(await upload(99)).toEqual(first);
    const metadata = await fetch(`${origin}/api/uploads/${first.id}/meta`, { headers: bearer });
    expect(await metadata.json()).toEqual({ attachment: first });
    const reopened = new KuloUploadStore(store.dir);
    expect(reopened.toChatAttachment(reopened.getUpload(first.id)!.record)).toEqual(first);
    const peer = await upload(2, { authorization: "Bearer synthetic-media-peer" });
    expect(peer.id).not.toBe(first.id);
    expect(peer).toMatchObject({ presentation: "voice", recordedDuration: 2 });
    expect(store.getUpload(first.id)!.record.ownerId).toBe("owner");
    expect(store.getUpload(peer.id)!.record.ownerId).toBe("peer");
    expect((await fetch(`${origin}/api/uploads/${first.id}/meta`, { headers: { authorization: "Bearer synthetic-media-peer" } })).status).toBe(403);
    expect(fs.readdirSync(store.dir)).toHaveLength(4);
    expect(errors).toEqual([]);
  });

  it("does not upgrade ordinary audio presentation when the same HTTP upload ID is replayed", async () => {
    const { origin } = await httpFixture();
    const headers = { ...bearer, "content-type": "audio/wav", "x-upload-id": "ordinary-audio" };
    const original = await fetch(`${origin}/api/uploads?name=audio.wav`, { method: "POST", headers, body: wav() });
    const first = (await original.json()).attachment;
    expect(first.presentation).toBeUndefined();
    const replay = await fetch(`${origin}/api/uploads?name=audio.wav&presentation=voice&recordedDuration=1`, { method: "POST", headers, body: wav() });
    expect(replay.status).toBe(201);
    expect((await replay.json()).attachment).toEqual(first);
  });

  it("rejects invalid HTTP recording metadata, non-audio voice uploads and unsafe upload IDs", async () => {
    const { origin, store, errors } = await httpFixture();
    for (const query of [
      "presentation=voice&recordedDuration=NaN", "presentation=voice&recordedDuration=-1",
      "presentation=voice&recordedDuration=86401", "presentation=voice&recordedDuration=Infinity",
      "presentation=voice&recordedDuration=", "recordedDuration=1", "presentation=other",
    ]) {
      const response = await fetch(`${origin}/api/uploads?name=voice.wav&${query}`, { method: "POST", headers: { ...bearer, "content-type": "audio/wav" }, body: wav() });
      expect(response.status).toBe(400);
    }
    for (const id of ["", "unsafe/id", "spaces are invalid", "a".repeat(161)]) {
      const response = await fetch(`${origin}/api/uploads?name=voice.wav`, { method: "POST", headers: { ...bearer, "content-type": "audio/wav", "x-upload-id": id }, body: wav() });
      expect(response.status).toBe(400);
    }
    const notAudio = await fetch(`${origin}/api/uploads?name=voice.wav&presentation=voice&recordedDuration=1`, { method: "POST", headers: { ...bearer, "content-type": "audio/wav" }, body: png });
    expect(notAudio.status).toBe(400);
    expect(fs.readdirSync(store.dir)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("supports legacy JSON uploads, streamed binary uploads and safe metadata resolution", async () => {
    const { origin, store, errors } = await httpFixture();
    const jsonUpload = await fetch(`${origin}/api/uploads`, {
      method: "POST", headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ name: "pixel.png", dataBase64: `data:image/png;base64,${png.toString("base64")}` }),
    });
    expect(jsonUpload.status).toBe(201);
    const { attachment } = await jsonUpload.json();
    expect(attachment).toMatchObject({ kind: "image", width: 1, height: 1 });
    const streamed = await fetch(`${origin}/api/uploads?name=${encodeURIComponent("录音.wav")}`, {
      method: "POST", headers: { ...bearer, "content-type": "audio/wav" }, body: wav(1),
    });
    expect(streamed.status).toBe(201);
    const audio = (await streamed.json()).attachment;
    expect(audio).toMatchObject({ kind: "audio", duration: 1 });
    expect(store.getUpload(audio.id)!.record.ownerId).toBe("owner");
    const jsonFile = await fetch(`${origin}/api/uploads?name=data.json`, {
      method: "POST", headers: { ...bearer, "content-type": "application/json", "x-file-name": "data.json" }, body: '{"real":"file"}',
    });
    expect(jsonFile.status).toBe(201);
    expect((await jsonFile.json()).attachment).toMatchObject({ kind: "file", name: "data.json", mimeType: "application/json" });
    const metadata = await fetch(`${origin}/api/uploads/${audio.id}/meta`, { headers: bearer });
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({ attachment: audio });
    const metadataText = await (await fetch(`${origin}/api/uploads/${audio.id}/meta`, { headers: bearer })).text();
    for (const internal of ["ownerId", "filePath", "fileName", "sha256", "referenceScopes", store.dir]) expect(metadataText.includes(internal)).toBe(false);
    expect(errors).toEqual([]);
  });

  it("issues a same-origin HttpOnly resource cookie that cannot authorize API writes or WS", async () => {
    const { origin, store, session, errors } = await httpFixture();
    const asset = store.saveUpload({ bytes: png, ownerId: "owner" });
    expect((await fetch(`${origin}/api/uploads/${asset.id}`)).status).toBe(401);
    const { response, cookie } = await session();
    const cookieFlags = response.headers.get("set-cookie")!.split(";").slice(1).map((part) => part.trim());
    expect(cookieFlags).toEqual(expect.arrayContaining(["Path=/api/uploads/", "HttpOnly", "SameSite=Strict", "Max-Age=1"]));
    expect(await response.json()).toMatchObject({ limits: MEDIA_UPLOAD_LIMITS });
    const headers = { cookie };
    expect((await fetch(`${origin}/api/uploads/${asset.id}`, { headers })).status).toBe(200);
    expect((await fetch(`${origin}/api/uploads/${asset.id}/meta`, { headers })).status).toBe(200);
    expect((await fetch(`${origin}/api/uploads/${asset.id}`, { method: "HEAD", headers })).status).toBe(200);
    expect((await fetch(`${origin}/api/uploads`, { method: "POST", headers, body: "cannot write" })).status).toBe(401);
    expect((await fetch(`${origin}/api/projects`, { headers })).status).toBe(401);
    expect((await fetch(`${origin}/ws/client`, { headers })).status).toBe(401);
    expect((await fetch(`${origin}/api/media/session`, { method: "POST", headers })).status).toBe(401);
    expect((await fetch(`${origin}/api/media/session?token=synthetic-media-owner`, { method: "POST" })).status).toBe(401);
    expect(errors).toEqual([]);
  });

  it("rejects foreign or downgraded session origins and sets Secure behind HTTPS", async () => {
    const { origin } = await httpFixture();
    for (const requestOrigin of ["https://example.invalid", origin.replace("http:", "https:"), "null"]) {
      expect((await fetch(`${origin}/api/media/session`, { method: "POST", headers: { ...bearer, origin: requestOrigin } })).status).toBe(403);
    }
    const httpsResponse = await fetch(`${origin}/api/media/session`, {
      method: "POST", headers: { ...bearer, origin: origin.replace("http:", "https:"), "x-forwarded-proto": "https" },
    });
    expect(httpsResponse.status).toBe(200);
    expect(httpsResponse.headers.get("set-cookie")!.split(";").map((part) => part.trim()).includes("Secure")).toBe(true);
  });

  it("expires, revokes and invalidates sessions with their original principal", async () => {
    let time = 1000;
    let active = true;
    const { origin, store, session, handler } = await httpFixture({ now: () => time, isPrincipalActive: () => active });
    const asset = store.saveUpload({ bytes: png, ownerId: "owner" });
    const read = (cookie: string) => fetch(`${origin}/api/uploads/${asset.id}`, { headers: { cookie } });
    const first = await session();
    expect((await read(first.cookie)).status).toBe(200);
    time = 2000;
    expect((await read(first.cookie)).status).toBe(401);
    const second = await session();
    handler.revoke("owner");
    expect((await read(second.cookie)).status).toBe(401);
    const third = await session();
    active = false;
    expect((await read(third.cookie)).status).toBe(401);
    active = true;
    const fourth = await session();
    handler.close();
    expect((await read(fourth.cookie)).status).toBe(401);
  });

  it("checks ownership and scope on every resource, metadata and Range read", async () => {
    const { origin, store } = await httpFixture();
    const asset = store.saveUpload({ bytes: wav(), ownerId: "owner" });
    const peer = { authorization: "Bearer synthetic-media-peer" };
    for (const suffix of ["", "/meta"]) expect((await fetch(`${origin}/api/uploads/${asset.id}${suffix}`, { headers: peer })).status).toBe(403);
    expect((await fetch(`${origin}/api/uploads/${asset.id}`, { headers: { ...peer, range: "bytes=0-3" } })).status).toBe(403);
    store.bindAttachments([asset], "private", "owner");
    expect((await fetch(`${origin}/api/uploads/${asset.id}`, { headers: peer })).status).toBe(403);
    store.bindAttachments([asset], "shared", "owner");
    expect((await fetch(`${origin}/api/uploads/${asset.id}`, { headers: { ...peer, range: "bytes=0-3" } })).status).toBe(206);
    expect((await fetch(`${origin}/api/uploads/${asset.id}/meta`, { headers: peer })).status).toBe(200);
  });

  it("serves bounded single byte ranges, HEAD and conditional reads with stable headers", async () => {
    const { origin, store, errors } = await httpFixture();
    const bytes = Buffer.from("0123456789");
    const asset = store.saveUpload({ name: "十个字节.txt", bytes, ownerId: "owner" });
    const url = `${origin}/api/uploads/${asset.id}`;
    const complete = await fetch(url, { headers: bearer });
    expect(complete.status).toBe(200);
    expect(complete.headers.get("content-length")).toBe("10");
    expect(complete.headers.get("accept-ranges")).toBe("bytes");
    expect(complete.headers.get("cache-control")).toBe("private, no-store");
    expect(complete.headers.get("x-content-type-options")).toBe("nosniff");
    expect(complete.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(complete.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    const etag = complete.headers.get("etag")!;
    expect(await complete.text()).toBe("0123456789");
    for (const [range, body, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=6-", "6789", "bytes 6-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=8-999", "89", "bytes 8-9/10"],
    ]) {
      const response = await fetch(url, { headers: { ...bearer, range: range! } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(Number(response.headers.get("content-length"))).toBe(body!.length);
      expect(await response.text()).toBe(body);
    }
    for (const range of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4", "bytes=NaN-1"]) {
      const response = await fetch(url, { headers: { ...bearer, range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
      expect(await response.text()).toBe("");
    }
    const head = await fetch(url, { method: "HEAD", headers: { ...bearer, range: "bytes=2-5" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
    expect((await fetch(url, { headers: { ...bearer, "if-none-match": etag } })).status).toBe(304);
    const staleRange = await fetch(url, { headers: { ...bearer, range: "bytes=2-5", "if-range": '"old-version"' } });
    expect(staleRange.status).toBe(200);
    expect(await staleRange.text()).toBe("0123456789");
    expect(errors).toEqual([]);
  });

  it("only inlines verified raster/media types and offers explicit downloads", async () => {
    const { origin, store } = await httpFixture();
    const image = store.saveUpload({ name: "actually.png", bytes: png });
    const html = store.saveUpload({ name: "spoofed.png", mimeType: "image/png", bytes: Buffer.from("<html><script>bad()</script></html>") });
    const svg = store.saveUpload({ name: "vector.svg", bytes: Buffer.from("<svg></svg>") });
    const audio = store.saveUpload({ name: "voice.wav", bytes: wav() });
    const unusualName = store.saveUpload({ name: "bad\uD800.png", bytes: png });
    const unusualResponse = await fetch(`${origin}/api/uploads/${unusualName.id}`, { headers: bearer });
    expect(unusualResponse.status).toBe(200);
    expect(unusualName.name).toBe("bad\uFFFD.png");
    for (const asset of [image, audio]) {
      const response = await fetch(`${origin}/api/uploads/${asset.id}`, { headers: bearer });
      expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    }
    for (const asset of [html, svg]) {
      const response = await fetch(`${origin}/api/uploads/${asset.id}`, { headers: bearer });
      expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
    }
    const download = await fetch(`${origin}/api/uploads/${image.id}?download=1`, { headers: bearer });
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("rejects malformed uploads without leaving draft resources", async () => {
    const { origin, store } = await httpFixture();
    for (const body of ["{", "[]", JSON.stringify({ dataBase64: "invalid!" }), JSON.stringify({ dataBase64: "" })]) {
      const response = await fetch(`${origin}/api/uploads`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body });
      expect(response.status).toBe(400);
    }
    const badName = await fetch(`${origin}/api/uploads`, { method: "POST", headers: { ...bearer, "x-file-name": "%not-encoded" }, body: "small" });
    expect(badName.status).toBe(400);
    expect(fs.readdirSync(store.dir)).toEqual([]);
  });

  it("returns a real 413 response when a chunked upload exceeds its type limit", async () => {
    const { origin, store, errors } = await httpFixture();
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(`${origin}/api/uploads?name=large.txt`, { method: "POST", headers: { ...bearer, "content-type": "text/plain" } }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => resolve({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject);
      const block = Buffer.alloc(1024 * 1024, 65);
      for (let i = 0; i < 26; i++) request.write(block);
      request.end();
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body).error).toContain("25 MiB");
    expect(fs.readdirSync(store.dir)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("cleans the temporary upload after the browser disconnects mid-request", async () => {
    const { origin, store, errors } = await httpFixture();
    const request = http.request(`${origin}/api/uploads?name=interrupted.txt`, { method: "POST", headers: bearer });
    request.on("error", () => {});
    request.write(Buffer.from("unfinished upload"));
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Upload cleanup timed out");
    };
    await waitFor(() => fs.readdirSync(store.dir).some((name) => name.endsWith(".partial")));
    request.destroy();
    await waitFor(() => fs.readdirSync(store.dir).length === 0);
    expect(errors).toEqual([]);
  });
});

describe("single-range parsing", () => {
  it("rejects unsafe integers and malformed or unsupported range sets", () => {
    expect(parseMediaRange("bytes=-999", 10)).toEqual({ start: 0, end: 9 });
    for (const value of ["bytes=9007199254740992-", "bytes=0-9007199254740992", "items=0-1", "bytes=-", `bytes=${"1".repeat(130)}-`]) expect(parseMediaRange(value, 10)).toBeNull();
    expect(parseMediaRange("bytes=0-1", 0)).toBeNull();
  });
});
