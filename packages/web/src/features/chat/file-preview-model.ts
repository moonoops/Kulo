import { isHtmlArtifact, type ChatAttachment } from "@kulo/protocol";

export type OfficePreviewKind = "docx" | "xlsx" | "pptx";
export type FilePreviewKind = "html" | "pdf" | "markdown" | "text" | OfficePreviewKind;

const OFFICE_MIME_TO_KIND: Record<string, OfficePreviewKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

const OFFICE_EXTENSION_TO_KIND: Record<string, OfficePreviewKind> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
};

const textExtensions = new Set(["txt", "text", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "log", "css", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "sh", "sql", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "rb"]);

export function filePreviewKind(asset: Pick<ChatAttachment, "name" | "mimeType">): FilePreviewKind | undefined {
  const mime = asset.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = asset.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (isHtmlArtifact(asset)) return "html";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  const officeByMime = OFFICE_MIME_TO_KIND[mime];
  if (officeByMime) return officeByMime;
  const officeByExtension = OFFICE_EXTENSION_TO_KIND[extension];
  if (officeByExtension) return officeByExtension;
  if (mime === "text/markdown" || ["md", "markdown"].includes(extension)) return "markdown";
  if (mime.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/toml"].includes(mime) || textExtensions.has(extension)) return "text";
  return undefined;
}

export function isOfficePreviewKind(kind: FilePreviewKind | undefined): kind is OfficePreviewKind {
  return kind === "docx" || kind === "xlsx" || kind === "pptx";
}

export function isPreviewableFile(asset: Pick<ChatAttachment, "name" | "mimeType">): boolean {
  return filePreviewKind(asset) !== undefined;
}

export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
export const MAX_OFFICE_PREVIEW_BYTES = 15 * 1024 * 1024;

export function isOversizedOfficeFile(asset: Pick<ChatAttachment, "name" | "mimeType" | "size">): boolean {
  return isOfficePreviewKind(filePreviewKind(asset)) && Number.isFinite(asset.size) && asset.size > MAX_OFFICE_PREVIEW_BYTES;
}

export class BinaryPreviewLimitError extends Error {
  constructor(readonly maxBytes: number, message = "文件超过 15 MB，请下载或使用默认应用打开") {
    super(message);
    this.name = "BinaryPreviewLimitError";
  }
}

/** Stop streaming once the binary preview budget is reached; downloading still returns the original file. */
export async function readBinaryPreview(
  response: Response,
  maxBytes = MAX_OFFICE_PREVIEW_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BinaryPreviewLimitError(maxBytes);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
    if (buffer.byteLength > maxBytes) throw new BinaryPreviewLimitError(maxBytes);
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (!chunk || chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BinaryPreviewLimitError(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Stop streaming once the preview budget is reached; downloading still returns the original file. */
export async function readTextPreview(response: Response, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let text = "", bytes = 0, truncated = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_TEXT_PREVIEW_BYTES - bytes;
      if (next.value.byteLength > remaining) {
        text += decoder.decode(next.value.subarray(0, remaining), { stream: true });
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(next.value, { stream: true });
      bytes += next.value.byteLength;
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  return { text, truncated };
}
