import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { pipeline } from "node:stream/promises";
import { HTML_ARTIFACT_BROWSER_CSP, htmlArtifactBrowserDocument, isHtmlArtifact } from "@kulo/protocol";

const ASSET_ID = /^att_[a-z0-9_]{6,48}$/;
const DOCUMENT_EXTENSIONS = new Set([
  ".ppt", ".pptx", ".odp", ".key", ".doc", ".docx", ".odt", ".rtf", ".pages",
  ".xls", ".xlsx", ".ods", ".numbers", ".csv", ".tsv", ".pdf",
  ".txt", ".md", ".markdown", ".log", ".json", ".jsonl", ".yaml", ".yml", ".xml",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic",
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".aiff", ".mp4", ".webm", ".mov", ".mkv",
  ".zip",
]);

export interface DesktopFileConnection { url: string; token: string }
interface FileMetadata { id: string; name: string; size: number; mimeType: string; kind: string }
interface PreparedFile { metadata: FileMetadata; bytes: Buffer; connection: DesktopFileConnection }

export interface DesktopFileActionsOptions {
  dataDir: string;
  connection(): DesktopFileConnection | undefined;
  fetch?: typeof fetch;
  openPath(file: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  chooseSavePath(name: string): Promise<string | undefined>;
}

/** Native actions belong only to the active application frame, never an embedded document. */
export function isTrustedFileActionSender(
  event: { sender: unknown; senderFrame: { origin: string } | null },
  owner: { isDestroyed(): boolean; webContents: { mainFrame: unknown; isDestroyed(): boolean } } | undefined,
  rendererOrigin: string | undefined,
): boolean {
  return Boolean(owner && !owner.isDestroyed() && !owner.webContents.isDestroyed() && rendererOrigin &&
    event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame &&
    event.senderFrame?.origin === rendererOrigin);
}

function assetId(value: unknown): string {
  if (typeof value !== "string" || !ASSET_ID.test(value)) throw new Error("文件标识无效。");
  return value;
}

function filename(value: string): string {
  const clean = value.replace(/[/\\\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  const extension = path.extname(clean);
  return `${Array.from(clean.slice(0, clean.length - extension.length)).slice(0, 120).join("") || "file"}${extension.slice(0, 20)}`;
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("文件读取失败。");
  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("文件大小超过限制。"); }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}

async function privateDirectory(directory: string): Promise<void> {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
    throw new Error("文件缓存目录不可用。");
  }
}

async function saveBytes(file: string, bytes: Buffer): Promise<void> {
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("保存位置不是普通文件。");
  const temporary = path.join(path.dirname(file), `.kulo-save-${randomBytes(16).toString("hex")}`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export function createDesktopFileActions(options: DesktopFileActionsOptions) {
  const request = options.fetch ?? fetch;
  const documents = new Map<string, { file: string; size: number }>();
  let server: Server | undefined;
  let previewOrigin: Promise<string> | undefined;
  let closed = false;

  function assertConnection(connection: DesktopFileConnection): void {
    if (closed || options.connection() !== connection) throw new Error("后台连接已变化，请重试。");
  }

  async function prepare(value: unknown): Promise<PreparedFile> {
    const id = assetId(value);
    const connection = options.connection();
    if (closed || !connection) throw new Error("后台尚未就绪，请稍后重试。");
    const origin = new URL(connection.url);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
      throw new Error("后台文件地址无效。");
    }
    const init: RequestInit = { headers: { Authorization: `Bearer ${connection.token}` }, redirect: "error", signal: AbortSignal.timeout(60_000) };
    const response = await request(new URL(`/api/uploads/${id}/meta`, origin), init);
    if (!response.ok) throw new Error(response.status === 404 ? "文件已不可用。" : "无法读取文件信息，请重试。");
    let valueMeta: unknown;
    try { valueMeta = JSON.parse((await readBounded(response, 64 * 1024)).toString("utf8")); }
    catch { throw new Error("文件信息无效。"); }
    const metadata = (valueMeta as { attachment?: FileMetadata } | null)?.attachment;
    if (!metadata || metadata.id !== id || typeof metadata.name !== "string" || !metadata.name || metadata.name.length > 720 ||
      /[\x00-\x1f\x7f]/.test(metadata.name) || typeof metadata.mimeType !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(metadata.mimeType) ||
      !["image", "audio", "video", "file"].includes(metadata.kind) || !Number.isSafeInteger(metadata.size) || metadata.size <= 0 ||
      metadata.size > (metadata.kind === "video" ? 250 : metadata.kind === "audio" ? 50 : 25) * 1024 * 1024) {
      throw new Error("文件信息无效。");
    }
    assertConnection(connection);
    const fileResponse = await request(new URL(`/api/uploads/${id}`, origin), init);
    if (!fileResponse.ok) throw new Error(fileResponse.status === 404 ? "文件已不可用。" : "文件读取失败，请重试。");
    const length = fileResponse.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== metadata.size)) throw new Error("文件已变化，请重新加载。");
    const bytes = await readBounded(fileResponse, metadata.size);
    if (bytes.length !== metadata.size) throw new Error("文件读取中断，请重试。");
    assertConnection(connection);
    return { metadata, bytes, connection };
  }

  async function cachedFile(file: PreparedFile, bytes = file.bytes): Promise<string> {
    const root = path.join(options.dataDir, "artifacts");
    await privateDirectory(root);
    // A fresh open copy preserves edits made in the default app and never overwrites a previous document.
    const directory = await fs.mkdtemp(path.join(root, `${file.metadata.id}-`));
    await fs.chmod(directory, 0o700);
    const target = path.join(directory, filename(file.metadata.name));
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    return target;
  }

  async function browserOrigin(): Promise<string> {
    if (closed) throw new Error("文件预览已关闭。");
    previewOrigin ??= new Promise<string>((resolve, reject) => {
      server = createServer(async (req, res) => {
        const address = server?.address();
        const host = address && typeof address === "object" ? `127.0.0.1:${address.port}` : undefined;
        const html = req.url && req.headers.host === host ? documents.get(req.url) : undefined;
        if (!html || !["GET", "HEAD"].includes(req.method ?? "")) { res.writeHead(404); res.end(); return; }
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          handle = await fs.open(html.file, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size !== html.size) throw new Error("预览文件已变化。");
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8", "content-length": html.size,
            "content-security-policy": HTML_ARTIFACT_BROWSER_CSP, "referrer-policy": "no-referrer",
            "cache-control": "private, no-store", "x-content-type-options": "nosniff",
            "cross-origin-resource-policy": "same-origin",
          });
          if (req.method === "HEAD") res.end();
          else await pipeline(handle.createReadStream({ autoClose: false }), res);
        } catch {
          if (!res.headersSent) { res.writeHead(410); res.end(); }
          else res.destroy();
        } finally { await handle?.close(); }
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (!address || typeof address !== "object") { reject(new Error("无法启动文件预览。")); return; }
        server?.unref();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return previewOrigin;
  }

  return {
    async openFile(id: unknown, target: unknown): Promise<void> {
      if (target !== "default" && target !== "browser") throw new Error("文件打开方式无效。");
      const file = await prepare(id);
      if (isHtmlArtifact(file.metadata)) {
        const origin = await browserOrigin();
        const route = `/${randomBytes(24).toString("hex")}/${encodeURIComponent(filename(file.metadata.name))}`;
        const html = Buffer.from(htmlArtifactBrowserDocument(file.bytes.toString("utf8"), file.metadata.name));
        documents.set(route, { file: await cachedFile(file, html), size: html.length });
        assertConnection(file.connection);
        try { await options.openExternal(`${origin}${route}`); }
        catch { documents.delete(route); throw new Error("无法打开浏览器，请检查系统默认浏览器。"); }
        return;
      }
      if (target === "browser" || !DOCUMENT_EXTENSIONS.has(path.extname(filename(file.metadata.name)).toLowerCase())) {
        throw new Error("此文件请先下载后打开。");
      }
      const cached = await cachedFile(file);
      assertConnection(file.connection);
      const error = await options.openPath(cached);
      if (error) throw new Error("无法打开文件，请检查系统默认应用。");
    },
    async saveFile(id: unknown): Promise<"saved" | "canceled"> {
      const file = await prepare(id);
      const target = await options.chooseSavePath(filename(file.metadata.name));
      if (!target) return "canceled";
      if (!path.isAbsolute(target)) throw new Error("保存位置无效。");
      assertConnection(file.connection);
      await saveBytes(target, file.bytes);
      return "saved";
    },
    async close(): Promise<void> {
      closed = true;
      documents.clear();
      if (server) {
        const current = server;
        server = undefined;
        current.closeAllConnections();
        await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
      }
    },
  };
}
