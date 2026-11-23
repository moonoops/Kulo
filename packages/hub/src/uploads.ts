import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { DIAGRAM_LIMITS, isHtmlArtifact, type ChatAttachment } from "@kulo/protocol";
import { inspectMediaPrefix, probeMediaFile, type MediaMetadata, type UploadKind } from "./media-probe.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_UPLOAD_BYTES = 250 * 1024 * 1024;
export const MAX_MESSAGE_UPLOAD_BYTES = 300 * 1024 * 1024;
export const MAX_INLINE_TEXT_BYTES = 32 * 1024;
export const MAX_INLINE_TEXT_CHARS = 12_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 16;

const UPLOAD_ID_RE = /^att_[a-z0-9_]{6,48}$/;
const PREFIX_BYTES = 64 * 1024;

export const MEDIA_UPLOAD_LIMITS = Object.freeze({
  imageBytes: MAX_UPLOAD_BYTES,
  audioBytes: MAX_AUDIO_UPLOAD_BYTES,
  videoBytes: MAX_VIDEO_UPLOAD_BYTES,
  fileBytes: MAX_UPLOAD_BYTES,
  messageBytes: MAX_MESSAGE_UPLOAD_BYTES,
  maxAttachments: MAX_ATTACHMENTS_PER_MESSAGE,
});

export function uploadByteLimit(kind: UploadKind): number {
  return kind === "video" ? MAX_VIDEO_UPLOAD_BYTES : kind === "audio" ? MAX_AUDIO_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
}

export const VISION_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".log": "text/plain",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".aiff": "audio/aiff",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".vtt": "text/vtt",
};

const TEXT_SNIPPET_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "image/svg+xml",
]);

const ATTACHMENTS_MARKER_START = "<!--kulo-attachments:";
const ATTACHMENTS_MARKER_END = "-->";
const ATTACHMENT_CONTEXT_PREFIX = "<!--kulo-attachment-context-->";

export interface StoredUploadRecord extends MediaMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  fileName: string;
  createdAt: number;
  version?: 2;
  sha256?: string;
  ownerId?: string;
  referenceScopes?: string[];
  posterUrl?: string;
  transcript?: ChatAttachment["transcript"];
  captions?: ChatAttachment["captions"];
  presentation?: "voice" | "diagram";
  diagramMotion?: "none" | "reveal" | "step";
  recordedDuration?: number;
  internalOnly?: boolean;
  internalKind?: "tool-overflow";
}

export interface UploadPresentationInput {
  presentation?: "voice" | "diagram";
  diagramMotion?: "none" | "reveal" | "step";
  recordedDuration?: number;
  width?: number;
  height?: number;
}

function validateUploadPresentation(
  input: UploadPresentationInput,
  resolved?: { kind: UploadKind; name: string; mimeType: string },
): void {
  if (input.presentation !== undefined && input.presentation !== "voice" && input.presentation !== "diagram") {
    throw new UploadError("无效的附件展示类型", 400);
  }
  if (input.recordedDuration !== undefined && (input.presentation !== "voice" || typeof input.recordedDuration !== "number" || !Number.isFinite(input.recordedDuration) || input.recordedDuration < 0 || input.recordedDuration > 24 * 60 * 60)) {
    throw new UploadError("录音时长必须为 0 到 86400 秒，且仅用于语音消息", 400);
  }
  if (input.diagramMotion !== undefined && (input.presentation !== "diagram" || !["none", "reveal", "step"].includes(input.diagramMotion))) {
    throw new UploadError("图示动效模式无效", 400);
  }
  if (input.presentation === "diagram") {
    if (input.width !== undefined && (!Number.isInteger(input.width) || input.width < DIAGRAM_LIMITS.minWidth || input.width > DIAGRAM_LIMITS.maxWidth)) {
      throw new UploadError("图示宽度超出有效范围", 400);
    }
    if (input.height !== undefined && (!Number.isInteger(input.height) || input.height < DIAGRAM_LIMITS.minHeight || input.height > DIAGRAM_LIMITS.maxHeight)) {
      throw new UploadError("图示高度超出有效范围", 400);
    }
  } else if (resolved === undefined && (input.width !== undefined || input.height !== undefined)) {
    throw new UploadError("仅内联图示允许显式指定尺寸", 400);
  }
  if (resolved) {
    if (input.presentation === "voice" && resolved.kind !== "audio") throw new UploadError("语音消息必须上传音频文件", 400);
    if (input.presentation === "diagram" && (resolved.kind !== "file" || !isHtmlArtifact(resolved))) {
      throw new UploadError("内联图示必须为受控 HTML 文档", 400);
    }
  }
}

export interface LoadedUpload {
  record: StoredUploadRecord;
  filePath: string;
}

export class UploadError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

export function sanitizeDisplayFilename(rawName?: string): string {
  const base = path
    .basename((rawName ?? "").replace(/[/\\]/g, "/"))
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\uD800-\uDFFF]/gu, "\uFFFD")
    .trim();
  if (!base) return "attachment";
  return Array.from(base).slice(0, 180).join("");
}

export function sanitizeDiskFilename(displayName: string): string {
  const cleaned = displayName
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "");
  const clipped = cleaned.slice(0, 80);
  return clipped || "file";
}

export function normalizeUploadMimeType(
  rawMime: string | undefined,
  fileName: string,
): string {
  const base = ((rawMime ?? "").split(";")[0] ?? "")
    .trim()
    .toLowerCase();
  if (base === "image/jpg") return "image/jpeg";
  if (base && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) throw new UploadError("无效的文件类型", 400);
  if (base && base !== "application/octet-stream") {
    return base;
  }
  const ext = path.extname(fileName).toLowerCase();
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

function createUploadId(idempotencyKey?: string): string {
  if (idempotencyKey !== undefined) {
    if (!idempotencyKey || idempotencyKey.length > 512) throw new UploadError("无效的资源发布标识", 400);
    return `att_pub_${crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40)}`;
  }
  return `att_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function isProbablyTextBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return false;
  }
  return true;
}

function shouldInlineTextSnippet(mimeType: string, buf: Buffer): boolean {
  if (buf.byteLength === 0 || buf.byteLength > MAX_INLINE_TEXT_BYTES) {
    return false;
  }
  if (!mimeType.startsWith("text/") && !TEXT_SNIPPET_MIMES.has(mimeType)) {
    return false;
  }
  return isProbablyTextBuffer(buf);
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class KuloUploadStore {
  readonly dir: string;
  private readonly activeUploads = new Set<string>();
  private readonly pendingPublications = new Map<string, { ownerId?: string; result: Promise<ChatAttachment> }>();
  private chatScopes: Readonly<Record<string, readonly string[]>> = {};
  private legacyLocalPrincipal?: string;
  private onWriteHook?: () => void;

  constructor(uploadsDir: string) {
    this.dir = path.resolve(uploadsDir);
  }

  setLegacyLocalPrincipal(nodeId: string | undefined): void {
    this.legacyLocalPrincipal = nodeId?.trim() || undefined;
  }

  setOnWrite(hook: (() => void) | undefined): void {
    this.onWriteHook = hook;
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(this.dir).isDirectory()) throw new UploadError("资源目录不可用", 500);
  }

  private writeRecord(record: StoredUploadRecord): void {
    const metadataPath = path.join(this.dir, `${record.id}.meta.json`);
    const temporary = `${metadataPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(record));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, metadataPath);
      this.onWriteHook?.();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }

  private createRecord(input: { id: string; name: string; fileName: string; size: number; ownerId?: string; sha256: string; internalOnly?: boolean; internalKind?: "tool-overflow" } & UploadPresentationInput, metadata: MediaMetadata): StoredUploadRecord {
    if (input.ownerId !== undefined && (!input.ownerId || input.ownerId.length > 240)) throw new UploadError("无效的上传归属", 400);
    validateUploadPresentation(input, { kind: metadata.kind, name: input.name, mimeType: metadata.mimeType });
    const { width, height, diagramMotion, ...rest } = input;
    return {
      ...rest,
      ...metadata,
      ...(input.presentation === "diagram" && width !== undefined ? { width } : {}),
      ...(input.presentation === "diagram" && height !== undefined ? { height } : {}),
      ...(input.presentation === "diagram" && diagramMotion !== undefined ? { diagramMotion } : {}),
      version: 2,
      createdAt: Date.now(),
      referenceScopes: [],
    };
  }

  private checkSize(size: number, kind: UploadKind): void {
    const maximum = uploadByteLimit(kind);
    if (size > maximum) throw new UploadError(`文件过大（此类型最大支持 ${maximum / (1024 * 1024)} MiB）`, 413);
  }

  saveUpload(input: {
    name?: string;
    mimeType?: string;
    bytes: Buffer;
    ownerId?: string;
    idempotencyKey?: string;
    internalOnly?: boolean;
    internalKind?: "tool-overflow";
  } & UploadPresentationInput): ChatAttachment {
    validateUploadPresentation(input);
    const bytes = input.bytes;
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
      throw new UploadError("上传文件不能为空", 400);
    }
    this.ensureDir();
    const id = createUploadId(input.idempotencyKey);
    if (input.idempotencyKey) {
      const previous = this.getUpload(id);
      if (previous) {
        if (previous.record.ownerId !== input.ownerId) throw new UploadError("资源发布归属不匹配", 409);
        return this.toChatAttachment(previous.record);
      }
    }
    const displayName = sanitizeDisplayFilename(input.name);
    const mimeType = normalizeUploadMimeType(input.mimeType, displayName);
    const metadata = inspectMediaPrefix(bytes.subarray(0, PREFIX_BYTES), mimeType, bytes.length);
    this.checkSize(bytes.length, metadata.kind);
    const diskFileName = `${id}-${sanitizeDiskFilename(displayName)}`;
    const filePath = path.join(this.dir, diskFileName);
    const record = this.createRecord({ id, name: displayName, fileName: diskFileName, size: bytes.length, ownerId: input.ownerId, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), ...(input.internalOnly ? { internalOnly: true } : {}), ...(input.internalKind ? { internalKind: input.internalKind } : {}), presentation: input.presentation, diagramMotion: input.diagramMotion, recordedDuration: input.recordedDuration, width: input.width, height: input.height }, metadata);
    const temporary = path.join(this.dir, `.${id}.partial`);
    let committed = false;
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, filePath);
      committed = true;
      this.writeRecord(record);
      return this.toChatAttachment(record);
    } catch (error) {
      if (committed) fs.rmSync(filePath, { force: true });
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async saveUploadStream(input: { name?: string; mimeType?: string; stream: AsyncIterable<Uint8Array>; ownerId?: string; signal?: AbortSignal; idempotencyKey?: string } & UploadPresentationInput): Promise<ChatAttachment> {
    validateUploadPresentation(input);
    this.ensureDir();
    const id = createUploadId(input.idempotencyKey);
    const pending = this.pendingPublications.get(id);
    if (pending) {
      if (pending.ownerId !== input.ownerId) throw new UploadError("资源发布归属不匹配", 409);
      return pending.result;
    }
    const publication = this.persistUploadStream(input, id);
    if (!input.idempotencyKey) return publication;
    this.pendingPublications.set(id, { ownerId: input.ownerId, result: publication });
    try { return await publication; } finally { this.pendingPublications.delete(id); }
  }

  private async persistUploadStream(input: { name?: string; mimeType?: string; stream: AsyncIterable<Uint8Array>; ownerId?: string; signal?: AbortSignal; idempotencyKey?: string } & UploadPresentationInput, id: string): Promise<ChatAttachment> {
    if (input.idempotencyKey) {
      const previous = this.getUpload(id);
      if (previous) {
        if (previous.record.ownerId !== input.ownerId) throw new UploadError("资源发布归属不匹配", 409);
        return this.toChatAttachment(previous.record);
      }
    }
    const name = sanitizeDisplayFilename(input.name);
    const declaredMime = normalizeUploadMimeType(input.mimeType, name);
    const fileName = `${id}-${sanitizeDiskFilename(name)}`;
    const filePath = path.join(this.dir, fileName);
    const temporary = path.join(this.dir, `.${id}.partial`);
    const hash = crypto.createHash("sha256");
    let prefix = Buffer.alloc(0);
    let size = 0;
    let committed = false;
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    this.activeUploads.add(id);
    let closed = false;
    try {
      if (input.signal?.aborted) throw new UploadError("上传已取消", 499);
      for await (const chunk of input.stream) {
        if (input.signal?.aborted) throw new UploadError("上传已取消", 499);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (prefix.length < PREFIX_BYTES) prefix = Buffer.concat([prefix, bytes.subarray(0, PREFIX_BYTES - prefix.length)]);
        this.checkSize(size, inspectMediaPrefix(prefix, declaredMime, size).kind);
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(bytes, offset, bytes.length - offset);
          if (result.bytesWritten === 0) throw new UploadError("资源写入中断", 500);
          offset += result.bytesWritten;
        }
      }
      if (input.signal?.aborted) throw new UploadError("上传已取消", 499);
      if (size === 0) throw new UploadError("上传文件不能为空", 400);
      await handle.sync();
      await handle.close();
      closed = true;
      const metadata = await probeMediaFile(temporary, inspectMediaPrefix(prefix, declaredMime, size));
      if (input.signal?.aborted) throw new UploadError("上传已取消", 499);
      this.checkSize(size, metadata.kind);
      const record = this.createRecord({ id, name, fileName, size, ownerId: input.ownerId, sha256: hash.digest("hex"), presentation: input.presentation, diagramMotion: input.diagramMotion, recordedDuration: input.recordedDuration, width: input.width, height: input.height }, metadata);
      await fs.promises.rename(temporary, filePath);
      committed = true;
      if (input.signal?.aborted) throw new UploadError("上传已取消", 499);
      this.writeRecord(record);
      return this.toChatAttachment(record);
    } catch (error) {
      if (committed) await fs.promises.rm(filePath, { force: true });
      throw error;
    } finally {
      this.activeUploads.delete(id);
      if (!closed) await handle.close();
      await fs.promises.rm(temporary, { force: true });
    }
  }

  setCommittedChatScopes(scopes: Readonly<Record<string, readonly string[]>>): void {
    this.chatScopes = scopes;
  }

  getUpload(id: string): LoadedUpload | null {
    const stored = this.readStoredUpload(id);
    const chat = this.chatScopes[id];
    if (!stored || !chat?.length) return stored;
    return { ...stored, record: { ...stored.record, referenceScopes: [...new Set([...(stored.record.referenceScopes ?? []), ...chat])] } };
  }

  private readStoredUpload(id: string): LoadedUpload | null {
    if (!UPLOAD_ID_RE.test(id)) return null;
    if (fs.existsSync(this.dir) && !fs.lstatSync(this.dir).isDirectory()) throw new UploadError("资源目录不可用", 500);
    const metaPath = path.join(this.dir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return null;
    if (!fs.lstatSync(metaPath).isFile()) throw new UploadError("资源索引不可用", 500);

    let parsed: StoredUploadRecord;
    try {
      parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as StoredUploadRecord;
    } catch {
      throw new UploadError("资源索引损坏", 500);
    }
    if (!parsed || parsed.id !== id || typeof parsed.fileName !== "string" || path.basename(parsed.fileName) !== parsed.fileName ||
      typeof parsed.name !== "string" || sanitizeDisplayFilename(parsed.name) !== parsed.name ||
      typeof parsed.mimeType !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(parsed.mimeType) ||
      !["image", "audio", "video", "file"].includes(parsed.kind) || !Number.isSafeInteger(parsed.size) || parsed.size <= 0 ||
      !Number.isFinite(parsed.createdAt) || parsed.createdAt < 0 ||
      (parsed.sha256 !== undefined && (typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.sha256))) ||
      (parsed.width !== undefined && (!Number.isInteger(parsed.width) || parsed.width <= 0 || parsed.width > 100_000)) ||
      (parsed.height !== undefined && (!Number.isInteger(parsed.height) || parsed.height <= 0 || parsed.height > 100_000)) ||
      (parsed.duration !== undefined && (!Number.isFinite(parsed.duration) || parsed.duration <= 0)) ||
      (parsed.version === 2 && parsed.metadataStatus !== "ready" && parsed.metadataStatus !== "unavailable") ||
      (parsed.ownerId !== undefined && (typeof parsed.ownerId !== "string" || !parsed.ownerId || parsed.ownerId.length > 240)) ||
      (parsed.internalOnly !== undefined && typeof parsed.internalOnly !== "boolean") ||
      (parsed.internalKind !== undefined && parsed.internalKind !== "tool-overflow") ||
      (parsed.referenceScopes !== undefined && (!Array.isArray(parsed.referenceScopes) || parsed.referenceScopes.some((scope) => typeof scope !== "string" || !scope || scope.length > 240)))) {
      throw new UploadError("资源索引损坏", 500);
    }

    const resolvedFile = path.resolve(this.dir, path.basename(parsed.fileName));
    if (path.dirname(resolvedFile) !== this.dir || !fs.existsSync(resolvedFile)) {
      return null;
    }
    const stat = fs.lstatSync(resolvedFile);
    if (!stat.isFile() || stat.size !== parsed.size) throw new UploadError("资源文件不可用", 500);
    const migrated = parsed.version !== 2;
    if (migrated) {
      const handle = fs.openSync(resolvedFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const prefix = Buffer.alloc(Math.min(PREFIX_BYTES, stat.size));
      try { fs.readSync(handle, prefix, 0, prefix.length, 0); } finally { fs.closeSync(handle); }
      parsed = { ...parsed, ...inspectMediaPrefix(prefix, parsed.mimeType, stat.size), version: 2 };
    }
    try { validateUploadPresentation(parsed, { kind: parsed.kind, name: parsed.name, mimeType: parsed.mimeType }); } catch { throw new UploadError("资源索引损坏", 500); }
    if (migrated) this.writeRecord(parsed);
    return { record: parsed, filePath: resolvedFile };
  }

  readUploadBytes(loaded: LoadedUpload): Buffer {
    const descriptor = fs.openSync(loaded.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size !== loaded.record.size) throw new UploadError("资源文件不可用", 500);
      return fs.readFileSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  }

  toChatAttachment(record: StoredUploadRecord): ChatAttachment {
    return {
      id: record.id,
      name: record.name,
      mimeType: record.mimeType,
      size: record.size,
      kind: record.kind,
      url: `/api/uploads/${encodeURIComponent(record.id)}`,
      metadataStatus: record.metadataStatus,
      ...(record.width === undefined ? {} : { width: record.width }),
      ...(record.height === undefined ? {} : { height: record.height }),
      ...(record.duration === undefined ? {} : { duration: record.duration }),
      ...(record.presentation === undefined ? {} : { presentation: record.presentation }),
      ...(record.diagramMotion === undefined ? {} : { diagramMotion: record.diagramMotion }),
      ...(record.recordedDuration === undefined ? {} : { recordedDuration: record.recordedDuration }),
      ...(record.posterUrl === undefined ? {} : { posterUrl: record.posterUrl }),
      ...(record.transcript === undefined ? {} : { transcript: record.transcript }),
      ...(record.captions === undefined ? {} : { captions: record.captions }),
    };
  }

  saveTranscript(id: string, transcript: NonNullable<ChatAttachment["transcript"]>): ChatAttachment {
    const loaded = this.readStoredUpload(id);
    if (!loaded || loaded.record.kind !== "audio") throw new UploadError("语音资源不存在", 404);
    if (typeof transcript.text !== "string" || !transcript.text.trim() || transcript.text.length > 200_000) throw new UploadError("语音文字无效", 400);
    const record = { ...loaded.record, transcript: { text: transcript.text, status: "ready" as const } };
    this.writeRecord(record);
    return this.toChatAttachment(record);
  }

  isUploadOwner(record: Pick<StoredUploadRecord, "ownerId">, principalId: string): boolean {
    if (!principalId) return false;
    return (
      record.ownerId === undefined ||
      record.ownerId === principalId ||
      (record.ownerId === "local" && Boolean(this.legacyLocalPrincipal && principalId === this.legacyLocalPrincipal))
    );
  }

  canReadUpload(id: string, principalId: string, canReadScope: (scope: string) => boolean = () => true): boolean {
    const loaded = this.getUpload(id);
    if (!loaded || !principalId) return false;
    return this.isUploadOwner(loaded.record, principalId) || Boolean(loaded.record.referenceScopes?.some(canReadScope));
  }

  attachmentsForBinding(refs: Array<Pick<ChatAttachment, "id"> | string> | undefined, ownerId?: string, canReadScope: (scope: string) => boolean = () => true): LoadedUpload[] {
    const loaded = this.resolveAttachments(refs);
    if (refs?.some((ref) => !this.getUpload(typeof ref === "string" ? ref : ref.id))) throw new UploadError("附件不存在", 404);
    if (ownerId && loaded.some((entry) => !this.canReadUpload(entry.record.id, ownerId, canReadScope))) throw new UploadError("无权引用此附件", 403);
    return loaded;
  }

  bindAttachments(refs: Array<Pick<ChatAttachment, "id"> | string> | undefined, scopeId: string, ownerId?: string, canReadScope: (scope: string) => boolean = () => true): void {
    if (!scopeId || scopeId.length > 240) throw new UploadError("无效的会话范围", 400);
    const loaded = this.attachmentsForBinding(refs, ownerId, canReadScope);
    for (const entry of loaded) {
      // Store only this writer's grant. Chat grants belong to the Durable transaction that published them.
      const stored = this.readStoredUpload(entry.record.id);
      if (!stored) throw new UploadError("附件不存在", 404);
      if (stored.record.referenceScopes?.includes(scopeId)) continue;
      this.writeRecord({ ...stored.record, referenceScopes: [...(stored.record.referenceScopes ?? []), scopeId] });
    }
  }

  cleanupDrafts(before = Date.now() - 7 * 24 * 60 * 60 * 1000): number {
    if (!fs.existsSync(this.dir)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".meta.json")) continue;
      const id = name.slice(0, -".meta.json".length);
      const loaded = this.getUpload(id);
      if (!loaded || loaded.record.ownerId === undefined || loaded.record.referenceScopes?.length || loaded.record.createdAt >= before) continue;
      fs.rmSync(loaded.filePath);
      fs.rmSync(path.join(this.dir, name));
      removed++;
    }
    return removed;
  }

  /** Garbage-collect expired or deleted-topic internal tool-overflow assets. */
  cleanupToolOverflows(options: {
    maxAgeMs?: number;
    expiredConversationIds?: ReadonlySet<number>;
    now?: number;
  } = {}): number {
    if (!fs.existsSync(this.dir)) return 0;
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? 14 * 24 * 60 * 60 * 1000;
    const expiredConvs = options.expiredConversationIds;
    let removed = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".meta.json")) continue;
      const id = name.slice(0, -".meta.json".length);
      let loaded: LoadedUpload | null = null;
      try { loaded = this.readStoredUpload(id); } catch { continue; }
      if (!loaded || !loaded.record.internalOnly || loaded.record.internalKind !== "tool-overflow") continue;
      const agedOut = loaded.record.createdAt < now - maxAgeMs;
      let ownerExpired = false;
      if (!agedOut && expiredConvs && expiredConvs.size > 0) {
        const convScopes = (loaded.record.referenceScopes ?? [])
          .map((scope) => (/^conversation:(\d+)$/.exec(scope)?.[1]))
          .filter((raw): raw is string => raw !== undefined)
          .map((raw) => Number(raw));
        if (convScopes.length > 0 && convScopes.every((convId) => expiredConvs.has(convId))) {
          ownerExpired = true;
        }
      }
      if (!agedOut && !ownerExpired) continue;
      fs.rmSync(loaded.filePath, { force: true });
      fs.rmSync(path.join(this.dir, name), { force: true });
      removed++;
    }
    return removed;
  }

  cleanupIncompleteUploads(before = Date.now() - 24 * 60 * 60 * 1000): number {
    if (!fs.existsSync(this.dir)) return 0;
    if (!fs.lstatSync(this.dir).isDirectory()) throw new UploadError("资源目录不可用", 500);
    let removed = 0;
    for (const name of fs.readdirSync(this.dir)) {
      const partial = /^\.(att_[a-z0-9_]{6,48})\.partial$/.exec(name);
      const metadata = /^(att_[a-z0-9_]{6,48})\.meta\.json\.[a-f0-9]{12}\.tmp$/.exec(name);
      const id = partial?.[1] ?? metadata?.[1];
      if (!id || this.activeUploads.has(id)) continue;
      const filePath = path.join(this.dir, name);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.mtimeMs >= before) continue;
      fs.rmSync(filePath);
      removed++;
    }
    return removed;
  }

  resolveAttachments(
    refs?: Array<Pick<ChatAttachment, "id"> | string>,
  ): LoadedUpload[] {
    if (!Array.isArray(refs) || refs.length === 0) return [];
    if (refs.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new UploadError(`单条消息最多支持 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`, 400);
    const seen = new Set<string>();
    const out: LoadedUpload[] = [];
    for (const ref of refs) {
      const id = typeof ref === "string" ? ref : ref?.id;
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      const loaded = this.getUpload(id);
      if (loaded) {
        out.push(loaded);
      }
    }
    if (out.reduce((sum, entry) => sum + entry.record.size, 0) > MAX_MESSAGE_UPLOAD_BYTES) throw new UploadError("单条消息的附件总量不能超过 300 MiB", 413);
    return out;
  }

  buildMultimodalContent(
    rawText: string,
    refs?: Array<Pick<ChatAttachment, "id"> | string>,
    options: { prefixText?: string } = {},
  ): {
    content: UserMessage["content"];
    attachments: ChatAttachment[];
  } {
    const trimmedPrefix = options.prefixText?.trimEnd() ?? "";
    const composedText = trimmedPrefix
      ? rawText.trim()
        ? `${trimmedPrefix}\n${rawText}`
        : trimmedPrefix
      : rawText;

    const loadedList = this.resolveAttachments(refs);
    if (loadedList.length === 0) {
      return {
        content: composedText,
        attachments: [],
      };
    }

    const attachments = loadedList.map((entry) => this.toChatAttachment(entry.record));
    const safeManifestJson = JSON.stringify(attachments).replaceAll(">", "\\u003e");
    const markerHeader = `${ATTACHMENTS_MARKER_START}${safeManifestJson}${ATTACHMENTS_MARKER_END}`;
    const primaryText = composedText ? `${markerHeader}\n${composedText}` : markerHeader;

    const parts: Array<TextContent | ImageContent> = [
      {
        type: "text",
        text: primaryText,
      },
    ];

    const contextLines: string[] = [
      ATTACHMENT_CONTEXT_PREFIX,
      "以下附件已持久化保存到上传目录。图片作为视觉输入；音频如附有文字稿可据其理解内容，其余音视频仅提供资源路径，不代表模型已读取媒体内容：",
    ];
    const imageParts: ImageContent[] = [];

    for (const loaded of loadedList) {
      const { record, filePath } = loaded;
      contextLines.push(
        `- [${record.kind}] ${record.name} (${record.mimeType}, ${formatByteSize(record.size)}) -> ${filePath}`,
      );
      if (record.kind === "audio" && record.transcript?.status !== "failed" && record.transcript?.text) {
        contextLines.push(`<audio_transcript>\n${record.transcript.text}\n</audio_transcript>`);
      }
      if (record.kind === "image") {
        try {
          const bytes = this.readUploadBytes(loaded);
          imageParts.push({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: record.mimeType,
          });
        } catch {
          contextLines.push(`  (图片读取失败，路径: ${filePath})`);
        }
      } else if (record.size <= MAX_INLINE_TEXT_BYTES) {
        try {
          const bytes = this.readUploadBytes(loaded);
          if (shouldInlineTextSnippet(record.mimeType, bytes)) {
            let text = bytes.toString("utf8");
            if (text.length > MAX_INLINE_TEXT_CHARS) {
              text = `${text.slice(0, MAX_INLINE_TEXT_CHARS)}\n... [truncated]`;
            }
            contextLines.push(
              `<file_content name="${record.name.replaceAll('"', '\\"')}">\n${text}\n</file_content>`,
            );
          }
        } catch {
          // Non-fatal; file path is still supplied above
        }
      }
    }

    parts.push({
      type: "text",
      text: contextLines.join("\n"),
    });
    parts.push(...imageParts);

    return {
      content: parts,
      attachments,
    };
  }
}

function stripLeadingAttachmentMarker(raw: string): {
  text: string;
  attachments: ChatAttachment[];
} {
  if (!raw.startsWith(ATTACHMENTS_MARKER_START)) {
    return { text: raw, attachments: [] };
  }
  const endIdx = raw.indexOf(ATTACHMENTS_MARKER_END, ATTACHMENTS_MARKER_START.length);
  if (endIdx < 0) {
    return { text: raw, attachments: [] };
  }
  const jsonPayload = raw.slice(ATTACHMENTS_MARKER_START.length, endIdx);
  let attachments: ChatAttachment[] = [];
  try {
    const parsed = JSON.parse(jsonPayload);
    if (Array.isArray(parsed)) {
      attachments = parsed.filter(
        (item): item is ChatAttachment =>
          Boolean(
            item &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              typeof item.name === "string" &&
              typeof item.mimeType === "string" &&
              typeof item.url === "string",
          ),
      );
    }
  } catch {
    return { text: raw, attachments: [] };
  }
  let remainder = raw.slice(endIdx + ATTACHMENTS_MARKER_END.length);
  if (remainder.startsWith("\r\n")) {
    remainder = remainder.slice(2);
  } else if (remainder.startsWith("\n")) {
    remainder = remainder.slice(1);
  }
  return { text: remainder, attachments };
}

export function parseUserEntryContent(content: UserMessage["content"]): {
  text: string;
  attachments: ChatAttachment[];
} {
  if (typeof content === "string") {
    return stripLeadingAttachmentMarker(content);
  }

  const textSegments: string[] = [];
  const attachments: ChatAttachment[] = [];
  const seenIds = new Set<string>();

  for (const block of content) {
    if (block.type !== "text") continue;
    if (block.text.startsWith(ATTACHMENT_CONTEXT_PREFIX)) {
      continue;
    }
    const stripped = stripLeadingAttachmentMarker(block.text);
    for (const att of stripped.attachments) {
      if (!seenIds.has(att.id)) {
        seenIds.add(att.id);
        attachments.push(att);
      }
    }
    if (stripped.text) {
      textSegments.push(stripped.text);
    }
  }

  return {
    text: textSegments.join("\n"),
    attachments,
  };
}
