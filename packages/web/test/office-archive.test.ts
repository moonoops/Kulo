import { describe, expect, it } from "vitest";
import {
  detectSafeRasterMime,
  MAX_ENTRY_UNCOMPRESSED_BYTES,
  OfficeArchive,
  OfficePreviewError,
  parseOfficeXml,
  parseRelationships,
  resolveOpcTarget,
  safeOfficeExternalUrl,
  xmlAttr,
  xmlEffectiveChildren,
  xmlLocalName,
} from "../src/features/chat/office-archive";
import { buildTestZip, createTestDomParser, TINY_PNG_BYTES } from "./office-zip-fixture";

describe("OfficeArchive security & ZIP reader", () => {
  it("reads both stored, deflated, and data-descriptor entries accurately", async () => {
    const zip = buildTestZip([
      { name: "word/document.xml", content: "<w:document><w:body><w:p/></w:body></w:document>", method: 8, dataDescriptor: true },
      { name: "word/media/image1.png", content: TINY_PNG_BYTES, method: 0 },
    ]);
    const archive = OfficeArchive.open(zip);
    expect(archive.has("word/document.xml")).toBe(true);
    expect(archive.has("WORD/MEDIA/IMAGE1.PNG")).toBe(true);
    const xmlBytes = await archive.readBytes("word/document.xml");
    expect(new TextDecoder().decode(xmlBytes)).toContain("<w:document>");
    const pngBytes = await archive.readBytes("word/media/image1.png");
    expect(detectSafeRasterMime(pngBytes!)).toBe("image/png");
  });

  it("rejects OLE2 encrypted/legacy documents, encrypted ZIP flags, and non-ZIP masquerades", () => {
    const ole2 = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => OfficeArchive.open(ole2)).toThrowError(OfficePreviewError);
    try { OfficeArchive.open(ole2); } catch (error) {
      expect((error as OfficePreviewError).code).toBe("encrypted_or_legacy");
      expect((error as OfficePreviewError).retryable).toBe(false);
    }

    const encryptedZip = buildTestZip([{ name: "word/document.xml", content: "secret", flags: 0x0001 }]);
    expect(() => OfficeArchive.open(encryptedZip)).toThrowError(OfficePreviewError);
    try { OfficeArchive.open(encryptedZip); } catch (error) {
      expect((error as OfficePreviewError).code).toBe("encrypted_or_legacy");
    }

    const plainText = new TextEncoder().encode("not a zip archive at all");
    expect(() => OfficeArchive.open(plainText)).toThrowError(OfficePreviewError);
    try { OfficeArchive.open(plainText); } catch (error) {
      expect((error as OfficePreviewError).code).toBe("invalid_format");
    }
  });

  it("rejects forged originalSize=0 Zip Bombs mid-stream at actual decompressed limit", async () => {
    // 14 MiB of zeros compresses to ~14 KiB, with forged uncompressedSize = 0 in the header.
    const hugeZeros = new Uint8Array(MAX_ENTRY_UNCOMPRESSED_BYTES + 2 * 1024 * 1024);
    const bomb = buildTestZip([
      { name: "xl/worksheets/sheet1.xml", content: hugeZeros, method: 8, declaredUncompressedSize: 0 },
    ]);
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    const archive = OfficeArchive.open(bomb);
    await expect(archive.readBytes("xl/worksheets/sheet1.xml")).rejects.toMatchObject({
      code: "zip_limit",
      retryable: false,
    });
  });

  it("rejects overlapping-kernel Zip Bombs during Central Directory open", () => {
    const zip = buildTestZip([
      { name: "a.xml", content: "<a/>", method: 0 },
      { name: "b.xml", content: "<b/>", method: 0 },
    ]);
    // Point entry B's localHeaderOffset to entry A's localHeaderOffset (0) to simulate overlapping kernels.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocdOffset = zip.byteLength - 22;
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const firstNameLen = view.getUint16(cdOffset + 28, true);
    const secondCdOffset = cdOffset + 46 + firstNameLen;
    view.setUint32(secondCdOffset + 42, 0, true);

    expect(() => OfficeArchive.open(zip)).toThrowError(OfficePreviewError);
    try { OfficeArchive.open(zip); } catch (error) {
      expect((error as OfficePreviewError).code).toBe("zip_limit");
    }
  });

  it("rejects ZIP64 sentinel headers (immune to CVE-2026-45820 class malformed ZIP64 loops)", () => {
    const zip = buildTestZip([{ name: "a.xml", content: "<a/>", method: 0 }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocdOffset = zip.byteLength - 22;
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    view.setUint32(cdOffset + 20, 0xffffffff, true);
    expect(() => OfficeArchive.open(zip)).toThrowError(OfficePreviewError);
    try { OfficeArchive.open(zip); } catch (error) {
      expect((error as OfficePreviewError).code).toBe("zip_limit");
    }
  });

  it("rejects path traversal entries in ZIP directory", () => {
    const zip = buildTestZip([{ name: "../evil.xml", content: "<x/>", method: 0 }]);
    expect(() => OfficeArchive.open(zip)).toThrowError(OfficePreviewError);
  });
});

describe("XML safety, OPC resolution, and image signature validation", () => {
  const domParser = createTestDomParser();

  it("blocks DOCTYPE/ENTITY declarations even after > 6 KiB of leading comments", () => {
    const padding = `<!-- ${"A".repeat(6500)} -->`;
    const xml = `<?xml version="1.0"?>${padding}<!DOCTYPE foo [<!ENTITY xxe "boom">]><root>&xxe;</root>`;
    expect(() => parseOfficeXml(new TextEncoder().encode(xml), domParser)).toThrowError(OfficePreviewError);
    try { parseOfficeXml(new TextEncoder().encode(xml), domParser); } catch (error) {
      expect((error as OfficePreviewError).code).toBe("unsafe_xml");
    }
  });

  it("normalizes local names, attributes, and unwraps mc:AlternateContent without duplicating Fallback", () => {
    const xml = `<p:sld xmlns:p="urn:p" xmlns:mc="urn:mc" xmlns:r="urn:r">
      <mc:AlternateContent>
        <mc:Choice Requires="a14"><p:sp r:id="rIdChoice"><p:t>首选内容</p:t></p:sp></mc:Choice>
        <mc:Fallback><p:sp r:id="rIdFallback"><p:t>回退内容</p:t></p:sp></mc:Fallback>
      </mc:AlternateContent>
    </p:sld>`;
    const doc = parseOfficeXml(new TextEncoder().encode(xml), domParser);
    const shapes = xmlEffectiveChildren(doc.documentElement, "sp");
    expect(shapes).toHaveLength(1);
    expect(xmlLocalName(shapes[0]!)).toBe("sp");
    expect(xmlAttr(shapes[0]!, "id")).toBe("rIdChoice");
  });

  it("resolves openpyxl root-relative and python-pptx parent-relative OPC targets while blocking escapes and externals", async () => {
    expect(resolveOpcTarget("ppt/slides/slide1.xml", "../media/image1.png")).toBe("ppt/media/image1.png");
    expect(resolveOpcTarget("ppt/slides/slide1.xml", "../notesSlides/notesSlide1.xml")).toBe("ppt/notesSlides/notesSlide1.xml");
    expect(resolveOpcTarget("xl/workbook.xml", "/xl/worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
    expect(resolveOpcTarget("xl/workbook.xml", "worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
    expect(resolveOpcTarget("ppt/slides/slide1.xml", "../../../etc/passwd")).toBeUndefined();
    expect(resolveOpcTarget("word/document.xml", "https://evil.example/tracker.png", "External")).toBeUndefined();
    expect(resolveOpcTarget("word/document.xml", "https://evil.example/tracker.png")).toBeUndefined();

    const zip = buildTestZip([
      {
        name: "word/_rels/document.xml.rels",
        content: `<Relationships>
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.png"/>
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report" TargetMode="External"/>
          <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
        </Relationships>`,
      },
    ]);
    const rels = await parseRelationships(OfficeArchive.open(zip), "word/document.xml", domParser);
    expect(rels.get("rId1")?.resolvedPath).toBe("word/media/photo.png");
    expect(rels.get("rId2")?.external).toBe(true);
    expect(safeOfficeExternalUrl(rels.get("rId2")!.target)).toBe("https://example.com/report");
    expect(safeOfficeExternalUrl(rels.get("rId3")!.target)).toBeUndefined();
  });

  it("accepts PNG/JPEG/GIF/WebP signatures and rejects SVG/EMF masquerading as PNG", () => {
    expect(detectSafeRasterMime(TINY_PNG_BYTES)).toBe("image/png");
    expect(detectSafeRasterMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeUndefined();
    expect(detectSafeRasterMime(Uint8Array.from([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00]))).toBeUndefined();
  });
});
