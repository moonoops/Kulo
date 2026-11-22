import { describe, expect, it } from "vitest";
import {
  BinaryPreviewLimitError,
  filePreviewKind,
  isOfficePreviewKind,
  isOversizedOfficeFile,
  isPreviewableFile,
  MAX_OFFICE_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  readBinaryPreview,
  readTextPreview,
} from "./file-preview-model";

describe("file preview selection", () => {
  it("uses the isolated HTML path only for an actual HTML filename and MIME pair", () => {
    expect(filePreviewKind({ name: "report.html", mimeType: "text/html" })).toBe("html");
    expect(filePreviewKind({ name: "report.txt", mimeType: "text/html" })).toBe("text");
    expect(filePreviewKind({ name: "report.html", mimeType: "application/octet-stream" })).toBeUndefined();
  });

  it("recognizes PDFs, modern OOXML Office docs, Markdown, text and code while rejecting legacy binary Office and archives", () => {
    expect(filePreviewKind({ name: "report.PDF", mimeType: "application/octet-stream" })).toBe("pdf");
    expect(filePreviewKind({ name: "report", mimeType: "application/pdf" })).toBe("pdf");
    expect(filePreviewKind({ name: "report.docx", mimeType: "application/octet-stream" })).toBe("docx");
    expect(filePreviewKind({ name: "report", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe("docx");
    expect(filePreviewKind({ name: "sheet.XLSX", mimeType: "application/octet-stream" })).toBe("xlsx");
    expect(filePreviewKind({ name: "sheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe("xlsx");
    expect(filePreviewKind({ name: "deck.pptx", mimeType: "application/octet-stream" })).toBe("pptx");
    expect(filePreviewKind({ name: "deck", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })).toBe("pptx");
    expect(isOfficePreviewKind("docx")).toBe(true);
    expect(isOfficePreviewKind("xlsx")).toBe(true);
    expect(isOfficePreviewKind("pptx")).toBe(true);
    expect(isOfficePreviewKind("pdf")).toBe(false);
    expect(filePreviewKind({ name: "report.md", mimeType: "application/octet-stream" })).toBe("markdown");
    expect(filePreviewKind({ name: "data.json", mimeType: "application/json" })).toBe("text");
    expect(filePreviewKind({ name: "script.py", mimeType: "application/octet-stream" })).toBe("text");
    for (const name of ["legacy.doc", "legacy.xls", "legacy.ppt", "archive.zip"]) {
      expect(isPreviewableFile({ name, mimeType: "application/octet-stream" })).toBe(false);
    }
  });

  it("flags oversized Office documents above 15 MiB while leaving PDFs and small Office files unaffected", () => {
    expect(isOversizedOfficeFile({ name: "big.pptx", mimeType: "application/octet-stream", size: MAX_OFFICE_PREVIEW_BYTES + 1 })).toBe(true);
    expect(isOversizedOfficeFile({ name: "exact.xlsx", mimeType: "application/octet-stream", size: MAX_OFFICE_PREVIEW_BYTES })).toBe(false);
    expect(isOversizedOfficeFile({ name: "big.pdf", mimeType: "application/pdf", size: MAX_OFFICE_PREVIEW_BYTES + 1 })).toBe(false);
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

describe("bounded binary file previews", () => {
  it("cancels immediately when Content-Length exceeds budget", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(64)); },
      cancel() { canceled = true; },
    });
    const response = new Response(stream, { headers: { "content-length": "200" } });
    await expect(readBinaryPreview(response, 100)).rejects.toBeInstanceOf(BinaryPreviewLimitError);
    expect(canceled).toBe(true);
  });

  it("cancels mid-stream when actual received bytes exceed budget without Content-Length", async () => {
    let canceled = false;
    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pushed += 60;
        controller.enqueue(new Uint8Array(60).fill(1));
      },
      cancel() { canceled = true; },
    });
    await expect(readBinaryPreview(new Response(stream), 100)).rejects.toBeInstanceOf(BinaryPreviewLimitError);
    expect(canceled).toBe(true);
    expect(pushed).toBeLessThanOrEqual(120);
  });

  it("reassembles multi-chunk binary payloads within budget and respects abort signal", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.enqueue(Uint8Array.from([4, 5]));
        controller.close();
      },
    });
    await expect(readBinaryPreview(new Response(stream), 10)).resolves.toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
    const controller = new AbortController();
    controller.abort();
    await expect(readBinaryPreview(new Response(Uint8Array.from([1, 2])), 10, controller.signal)).rejects.toThrow();
  });
});
