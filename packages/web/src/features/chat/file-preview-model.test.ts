import { describe, expect, it } from "vitest";
import { filePreviewKind, isPreviewableFile, MAX_TEXT_PREVIEW_BYTES, readTextPreview } from "./file-preview-model";

describe("file preview selection", () => {
  it("uses the isolated HTML path only for an actual HTML filename and MIME pair", () => {
    expect(filePreviewKind({ name: "report.html", mimeType: "text/html" })).toBe("html");
    expect(filePreviewKind({ name: "report.txt", mimeType: "text/html" })).toBe("text");
    expect(filePreviewKind({ name: "report.html", mimeType: "application/octet-stream" })).toBeUndefined();
  });
  it("recognizes PDFs, Markdown, text and code without claiming Office or binary previews", () => {
    expect(filePreviewKind({ name: "report.PDF", mimeType: "application/octet-stream" })).toBe("pdf");
    expect(filePreviewKind({ name: "report", mimeType: "application/pdf" })).toBe("pdf");
    expect(filePreviewKind({ name: "report.md", mimeType: "application/octet-stream" })).toBe("markdown");
    expect(filePreviewKind({ name: "data.json", mimeType: "application/json" })).toBe("text");
    expect(filePreviewKind({ name: "script.py", mimeType: "application/octet-stream" })).toBe("text");
    for (const name of ["report.docx", "report.pptx", "report.xlsx", "archive.zip"]) expect(isPreviewableFile({ name, mimeType: "application/octet-stream" })).toBe(false);
  });
});

describe("bounded text file previews", () => {
  it("preserves UTF-8 characters split across network chunks", async () => {
    const bytes = new TextEncoder().encode("客厅灯光\n原始文件");
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); controller.enqueue(bytes.subarray(4)); controller.close(); } });
    await expect(readTextPreview(new Response(stream))).resolves.toEqual({ text: "客厅灯光\n原始文件", truncated: false });
  });
  it("marks and cancels a long stream instead of loading a full document into the message", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(MAX_TEXT_PREVIEW_BYTES + 10).fill(65)); }, cancel() { canceled = true; } });
    const result = await readTextPreview(new Response(stream));
    expect(result.text.length).toBe(MAX_TEXT_PREVIEW_BYTES);
    expect(result.truncated).toBe(true);
    expect(canceled).toBe(true);
  });
  it("keeps an exactly budget-sized file complete and respects cancellation", async () => {
    await expect(readTextPreview(new Response("A".repeat(MAX_TEXT_PREVIEW_BYTES)))).resolves.toEqual({ text: "A".repeat(MAX_TEXT_PREVIEW_BYTES), truncated: false });
    const controller = new AbortController(); controller.abort();
    await expect(readTextPreview(new Response("text"), controller.signal)).rejects.toThrow();
  });
});
