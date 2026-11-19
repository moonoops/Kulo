import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfBinaryDataFactory } from "./pdf-preview-assets";

afterEach(() => vi.unstubAllGlobals());

describe("local PDF resources", () => {
  it("reads packaged CMaps through a same-origin request without carrying conversation credentials", async () => {
    const request = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", request);
    await expect(new PdfBinaryDataFactory().fetch({ kind: "cMapUrl", filename: "UniGB-UCS2-H.bcmap" })).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(request).toHaveBeenCalledWith(expect.stringContaining("UniGB-UCS2-H"), { credentials: "same-origin", redirect: "error" });
  });
  it("rejects unknown or path-like PDF resources without making a network request", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    const factory = new PdfBinaryDataFactory();
    for (const input of [{ kind: "remote", filename: "font.ttf" }, { kind: "cMapUrl", filename: "../settings" }, { kind: "cMapUrl", filename: "https://example.com/font" }, { kind: "cMapUrl", filename: "missing.bcmap" }]) await expect(factory.fetch(input)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
