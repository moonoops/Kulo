import { isHtmlArtifact, type ChatAttachment } from "@moco/protocol";

export type FilePreviewKind = "html" | "pdf" | "markdown" | "text";
const textExtensions = new Set(["txt", "text", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "log", "css", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "sh", "sql", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "rb"]);

export function filePreviewKind(asset: Pick<ChatAttachment, "name" | "mimeType">): FilePreviewKind | undefined {
  const mime = asset.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = asset.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (isHtmlArtifact(asset)) return "html";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (mime === "text/markdown" || ["md", "markdown"].includes(extension)) return "markdown";
  if (mime.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/toml"].includes(mime) || textExtensions.has(extension)) return "text";
  return undefined;
}

export function isPreviewableFile(asset: Pick<ChatAttachment, "name" | "mimeType">): boolean {
  return filePreviewKind(asset) !== undefined;
}

export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

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
