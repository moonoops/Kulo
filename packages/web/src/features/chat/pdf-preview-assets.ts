/// <reference types="vite/client" />

// Only PDF previews load these local resources; PDFs never select arbitrary network font URLs.
const resources = {
  cMapUrl: import.meta.glob<string>("../../../node_modules/pdfjs-dist/cmaps/*.bcmap", { eager: true, query: "?url&no-inline", import: "default" }),
  standardFontDataUrl: import.meta.glob<string>("../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", { eager: true, query: "?url&no-inline", import: "default" }),
  wasmUrl: import.meta.glob<string>("../../../node_modules/pdfjs-dist/wasm/*.wasm", { eager: true, query: "?url&no-inline", import: "default" }),
};

export class PdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    if (!Object.hasOwn(resources, kind) || !/^[a-zA-Z0-9_.-]+$/.test(filename)) throw new Error("Invalid PDF resource");
    const group = resources[kind as keyof typeof resources];
    const resource = Object.entries(group).find(([key]) => key.endsWith(`/${filename}`))?.[1];
    if (!resource) throw new Error(`PDF resource unavailable: ${filename}`);
    const response = await fetch(resource, { credentials: "same-origin", redirect: "error" });
    if (!response.ok) throw new Error(`Unable to load PDF resource (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
