import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectAssetContent } from "../packages/hub/src/asset-inspection.js";
import { KuloUploadStore } from "../packages/hub/src/uploads.js";

const directories: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==", "base64");
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-asset-inspection-"));
  directories.push(directory);
  return { directory, uploads: new KuloUploadStore(path.join(directory, "uploads")) };
}

function wav(): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}

describe("managed asset inspection", () => {
  it("returns canonical metadata and the actual PNG bytes without exposing storage paths", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "received.png", mimeType: "image/png", bytes: png, ownerId: "agent:7" });
    const result = inspectAssetContent({ assetId: asset.id }, f.uploads);
    expect(result.details).toMatchObject({ asset, inspection: "image", contentProvided: true });
    expect(result.output?.[1]).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    expect(JSON.stringify(result)).not.toContain(f.directory);
    expect(JSON.stringify(result)).not.toContain("agent:7");
  });

  it("paginates an HTML file larger than the inline attachment limit without losing content", () => {
    const f = fixture();
    const text = `<!DOCTYPE html><html><body>${"待审核的正文".repeat(9000)}</body></html>`;
    const asset = f.uploads.saveUpload({ name: "index.html", mimeType: "text/html", bytes: Buffer.from(text) });
    let offset = 0;
    let combined = "";
    let pages = 0;
    while (true) {
      const result = inspectAssetContent({ assetId: asset.id, offset }, f.uploads);
      const details = result.details as { inspection: string; text: string; offset: number; nextOffset: number | null; totalLength: number; truncated: boolean };
      expect(details).toMatchObject({ inspection: "text", offset, totalLength: text.length });
      expect(details.text.length).toBeLessThanOrEqual(12_000);
      expect(result.output).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
      combined += details.text;
      pages++;
      if (details.nextOffset === null) { expect(details.truncated).toBe(false); break; }
      expect(details.nextOffset).toBeGreaterThan(offset);
      expect(details.truncated).toBe(true);
      offset = details.nextOffset;
    }
    expect(pages).toBeGreaterThan(1);
    expect(combined).toBe(text);
  });

  it("supports a bounded custom text page and an explicit end-of-file position", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "code.js", mimeType: "application/javascript", bytes: Buffer.from("const answer = 42;") });
    expect(inspectAssetContent({ assetId: asset.id, offset: 6, limit: 6 }, f.uploads).details).toMatchObject({ text: "answer", offset: 6, nextOffset: 12, truncated: true });
    expect(inspectAssetContent({ assetId: asset.id, offset: 18 }, f.uploads).details).toMatchObject({ text: "", nextOffset: null, truncated: false });
    expect(() => inspectAssetContent({ assetId: asset.id, offset: 19 }, f.uploads)).toThrowError(expect.objectContaining({ status: 416 }));
  });

  it.each([-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid offset %s before reading bytes", (offset) => {
    const f = fixture();
    const read = vi.spyOn(f.uploads, "readUploadBytes");
    expect(() => inspectAssetContent({ assetId: "att_missing_resource", offset }, f.uploads)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, 24_001, Infinity])("rejects invalid page limit %s before reading bytes", (limit) => {
    const f = fixture();
    const read = vi.spyOn(f.uploads, "readUploadBytes");
    expect(() => inspectAssetContent({ assetId: "att_missing_resource", limit }, f.uploads)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects missing or deleted assets rather than returning a success-shaped inspection", () => {
    const f = fixture();
    expect(() => inspectAssetContent({ assetId: "att_missing_resource" }, f.uploads)).toThrowError(expect.objectContaining({ status: 404 }));
    const asset = f.uploads.saveUpload({ name: "note.txt", bytes: Buffer.from("review me") });
    fs.unlinkSync(f.uploads.getUpload(asset.id)!.filePath);
    expect(() => inspectAssetContent({ assetId: asset.id }, f.uploads)).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("rejects a stored asset whose bytes changed even when its size stayed the same", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "note.txt", bytes: Buffer.from("expected text") });
    fs.writeFileSync(f.uploads.getUpload(asset.id)!.filePath, Buffer.alloc(asset.size, "x"));
    expect(() => inspectAssetContent({ assetId: asset.id }, f.uploads)).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it("surfaces malformed UTF-8 declared as text without silently replacing bytes", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "invalid.txt", mimeType: "text/plain", bytes: Buffer.from([0xc3, 0x28]) });
    expect(() => inspectAssetContent({ assetId: asset.id }, f.uploads)).toThrowError(expect.objectContaining({ status: 422 }));
  });

  it("reports an expected read denial without exposing the private storage path", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "note.txt", bytes: Buffer.from("review me") });
    vi.spyOn(f.uploads, "readUploadBytes").mockImplementation(() => { throw Object.assign(new Error(`EACCES: ${f.directory}/private`), { code: "EACCES" }); });
    let failure: unknown;
    try { inspectAssetContent({ assetId: asset.id }, f.uploads); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 403 });
    expect(String(failure)).not.toContain(f.directory);
  });

  it("preserves unexpected store failures instead of disguising them as unavailable content", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "note.txt", bytes: Buffer.from("review me") });
    const failure = new Error("unexpected storage failure");
    vi.spyOn(f.uploads, "readUploadBytes").mockImplementation(() => { throw failure; });
    expect(() => inspectAssetContent({ assetId: asset.id }, f.uploads)).toThrow(failure);
  });

  it("returns truthful binary metadata without implying the file content was decoded", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "archive.zip", mimeType: "application/zip", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]) });
    const result = inspectAssetContent({ assetId: asset.id }, f.uploads);
    expect(result.details).toMatchObject({ asset, inspection: "metadata", contentProvided: false });
    expect(JSON.stringify(result)).toContain("未解码");
    expect(result.output).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(f.directory);
  });

  it("pages an existing audio transcript while clearly distinguishing it from decoded audio", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "speech.wav", mimeType: "audio/wav", bytes: wav() });
    f.uploads.saveTranscript(asset.id, { text: "这是已经保存的语音转写。", status: "ready" });
    const result = inspectAssetContent({ assetId: asset.id, offset: 2, limit: 4 }, f.uploads);
    expect(result.details).toMatchObject({ inspection: "transcript", contentProvided: false, transcriptProvided: true, text: "已经保存", offset: 2, nextOffset: 6, truncated: true });
    expect(JSON.stringify(result)).toContain("音视频内容未解码");
  });

  it("does not repeat an entire transcript through canonical attachment metadata", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "speech.wav", mimeType: "audio/wav", bytes: wav() });
    const transcript = "转写内容".repeat(10_000);
    f.uploads.saveTranscript(asset.id, { text: transcript, status: "ready" });
    const result = inspectAssetContent({ assetId: asset.id, offset: 0, limit: 4 }, f.uploads);
    expect(result.details).toMatchObject({ text: "转写内容", nextOffset: 4, truncated: true });
    expect((result.details as { asset: Record<string, unknown> }).asset.transcript).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(transcript);
  });

  it("does not silently apply text pagination to a complete image", () => {
    const f = fixture();
    const asset = f.uploads.saveUpload({ name: "received.png", mimeType: "image/png", bytes: png });
    expect(() => inspectAssetContent({ assetId: asset.id, offset: 1 }, f.uploads)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => inspectAssetContent({ assetId: asset.id, limit: 4 }, f.uploads)).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("assigns canonical OOXML MIME types for .docx/.xlsx/.pptx and keeps inspection metadata-only without bloating model context", () => {
    const f = fixture();
    const pkBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]);
    const cases = [
      ["方案.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["报表.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["演示.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ] as const;
    for (const [name, expectedMime] of cases) {
      const asset = f.uploads.saveUpload({ name, mimeType: "application/octet-stream", bytes: pkBytes });
      expect(asset.kind).toBe("file");
      expect(asset.mimeType).toBe(expectedMime);
      const result = inspectAssetContent({ assetId: asset.id }, f.uploads);
      expect(result.details).toMatchObject({ inspection: "metadata", contentProvided: false });
      expect(result.output).toHaveLength(1);
    }
  });
});
