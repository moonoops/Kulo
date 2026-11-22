import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobUrlRegistry, OfficeArchive } from "../src/features/chat/office-archive";
import { MAX_DOCX_BLOCKS, parseDocxArchive } from "../src/features/chat/docx-parser";
import { buildTestZip, createTestDomParser, TINY_PNG_BYTES } from "./office-zip-fixture";

afterEach(() => vi.restoreAllMocks());

describe("docx-parser", () => {
  const domParser = createTestDomParser();

  it("resolves style inheritance with cycle protection, numbering lists, merged tables, safe links, embedded images, and filters instrText/del", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://127.0.0.1:7788/doc-img-1");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const zip = buildTestZip([
      {
        name: "word/styles.xml",
        content: `<w:styles xmlns:w="urn:w">
          <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/></w:rPr></w:style>
          <w:style w:type="paragraph" w:styleId="CustomH1"><w:basedOn w:val="Heading1"/></w:style>
          <w:style w:type="paragraph" w:styleId="CycleA"><w:basedOn w:val="CycleB"/></w:style>
          <w:style w:type="paragraph" w:styleId="CycleB"><w:basedOn w:val="CycleA"/></w:style>
        </w:styles>`,
      },
      {
        name: "word/numbering.xml",
        content: `<w:numbering xmlns:w="urn:w">
          <w:abstractNum w:abstractNumId="1">
            <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
            <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
          </w:abstractNum>
          <w:num w:numId="10"><w:abstractNumId w:val="1"/></w:num>
        </w:numbering>`,
      },
      {
        name: "word/_rels/document.xml.rels",
        content: `<Relationships>
          <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/fig1.png"/>
          <Relationship Id="rIdExtImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://evil.example/pixel.png" TargetMode="External"/>
          <Relationship Id="rIdSafeLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/spec" TargetMode="External"/>
          <Relationship Id="rIdBadLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
          <Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
        </Relationships>`,
      },
      { name: "word/media/fig1.png", content: TINY_PNG_BYTES, method: 0 },
      { name: "word/header1.xml", content: `<w:hdr xmlns:w="urn:w"><w:p><w:r><w:t>内部评审草案</w:t></w:r></w:p></w:hdr>` },
      {
        name: "word/document.xml",
        content: `<w:document xmlns:w="urn:w" xmlns:r="urn:r" xmlns:a="urn:a">
          <w:body>
            <w:p>
              <w:pPr><w:pStyle w:val="CustomH1"/></w:pPr>
              <w:r><w:t>一、项目背景</w:t></w:r>
            </w:p>
            <w:p>
              <w:pPr><w:pStyle w:val="CycleA"/></w:pPr>
              <w:r><w:instrText>HYPERLINK "secret"</w:instrText><w:t>正常正文 </w:t></w:r>
              <w:del><w:r><w:delText>已删内容</w:delText></w:r></w:del>
              <w:hyperlink r:id="rIdSafeLink"><w:r><w:t>参考链接</w:t></w:r></w:hyperlink>
              <w:hyperlink r:id="rIdBadLink"><w:r><w:t> 危险链接文本</w:t></w:r></w:hyperlink>
            </w:p>
            <w:p>
              <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="10"/></w:numPr></w:pPr>
              <w:r><w:t>第一项</w:t></w:r>
            </w:p>
            <w:p>
              <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="10"/></w:numPr></w:pPr>
              <w:r><w:t>子要点</w:t></w:r>
            </w:p>
            <w:p>
              <w:r><w:drawing><a:blip r:embed="rIdImg"/><a:blip r:link="rIdExtImg"/></w:drawing></w:r>
            </w:p>
            <w:tbl>
              <w:tr>
                <w:trPr><w:tblHeader/></w:trPr>
                <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并标题</w:t></w:r></w:p></w:tc>
              </w:tr>
              <w:tr>
                <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>跨行项</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>值 1</w:t></w:r></w:p></w:tc>
              </w:tr>
              <w:tr>
                <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
                <w:tc><w:p><w:r><w:t>值 2</w:t></w:r></w:p></w:tc>
              </w:tr>
            </w:tbl>
            <w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/></w:sectPr>
          </w:body>
        </w:document>`,
      },
    ]);

    const registry = new BlobUrlRegistry();
    const doc = await parseDocxArchive(OfficeArchive.open(zip), registry, domParser);
    expect(doc.headerText).toBe("内部评审草案");
    expect(doc.truncatedBlocks).toBe(false);
    expect(doc.images).toHaveLength(1);

    expect(doc.blocks[0]).toMatchObject({ kind: "paragraph", role: "h1" });
    expect(doc.blocks[1]).toMatchObject({
      kind: "paragraph",
      role: "body",
      runs: [
        { kind: "text", text: "正常正文 " },
        { kind: "text", text: "参考链接", href: "https://example.com/spec" },
        { kind: "text", text: " 危险链接文本" },
      ],
    });
    // Ensure javascript: link was stripped while text survived and instrText/delText disappeared.
    const serialized = JSON.stringify(doc.blocks[1]);
    expect(serialized).not.toContain("javascript:");
    expect(serialized).not.toContain("HYPERLINK");
    expect(serialized).not.toContain("已删内容");

    expect(doc.blocks[2]).toMatchObject({ kind: "paragraph", list: { ordered: true, level: 0, ordinal: 1 } });
    expect(doc.blocks[3]).toMatchObject({ kind: "paragraph", list: { ordered: false, level: 1 } });
    expect(doc.blocks[4]).toMatchObject({ kind: "paragraph", runs: [{ kind: "image", image: { url: "blob:http://127.0.0.1:7788/doc-img-1" } }] });

    const table = doc.blocks[5];
    expect(table?.kind).toBe("table");
    if (table?.kind === "table") {
      expect(table.rows[0]?.[0]?.colSpan).toBe(2);
      expect(table.rows[0]?.[0]?.isHeader).toBe(true);
      expect(table.rows[1]?.[0]?.rowSpan).toBe(2);
      expect(table.rows[2]?.[0]).toBeNull();
    }
    registry.dispose(0);
  });

  it("caps document blocks at MAX_DOCX_BLOCKS and flags truncation", async () => {
    const paragraphs = Array.from({ length: MAX_DOCX_BLOCKS + 20 }, (_, i) => `<w:p><w:r><w:t>段落 ${i + 1}</w:t></w:r></w:p>`).join("");
    const zip = buildTestZip([
      { name: "word/document.xml", content: `<w:document xmlns:w="urn:w"><w:body>${paragraphs}</w:body></w:document>` },
    ]);
    const registry = new BlobUrlRegistry();
    const doc = await parseDocxArchive(OfficeArchive.open(zip), registry, domParser);
    expect(doc.blocks).toHaveLength(MAX_DOCX_BLOCKS);
    expect(doc.truncatedBlocks).toBe(true);
    registry.dispose(0);
  });
});
