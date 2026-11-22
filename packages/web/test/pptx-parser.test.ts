import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobUrlRegistry, OfficeArchive } from "../src/features/chat/office-archive";
import { PptxDeckSession } from "../src/features/chat/pptx-parser";
import { buildTestZip, createTestDomParser, TINY_PNG_BYTES } from "./office-zip-fixture";

afterEach(() => vi.restoreAllMocks());

describe("pptx-parser", () => {
  const domParser = createTestDomParser();

  it("follows sldIdLst order, extracts grouped shapes, deduplicates AlternateContent, handles merged tables, spatial ordering, notes, charts, and images", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://127.0.0.1:7788/slide-img-1");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const zip = buildTestZip([
      {
        name: "ppt/presentation.xml",
        content: `<p:presentation xmlns:p="urn:p" xmlns:r="urn:r">
          <p:sldIdLst>
            <p:sldId id="256" r:id="rIdSecond"/>
            <p:sldId id="257" r:id="rIdFirst"/>
          </p:sldIdLst>
        </p:presentation>`,
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        content: `<Relationships>
          <Relationship Id="rIdFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
          <Relationship Id="rIdSecond" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
        </Relationships>`,
      },
      {
        name: "ppt/slides/slide2.xml",
        content: `<p:sld xmlns:p="urn:p" xmlns:a="urn:a" xmlns:r="urn:r" xmlns:c="urn:c" xmlns:mc="urn:mc">
          <p:cSld>
            <p:spTree>
              <p:sp>
                <p:nvSpPr><p:cNvPr id="2" name="Bottom"/><p:nvPr/></p:nvSpPr>
                <p:spPr><a:xfrm><a:off x="100000" y="3000000"/></a:xfrm></p:spPr>
                <p:txBody><a:p><a:r><a:t>底部总结</a:t></a:r></a:p></p:txBody>
              </p:sp>
              <p:sp>
                <p:nvSpPr><p:cNvPr id="3" name="Title"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
                <p:txBody><a:p><a:r><a:t>Q4 经营复盘</a:t></a:r></a:p></p:txBody>
              </p:sp>
              <p:sp>
                <p:nvSpPr><p:cNvPr id="4" name="SlideNumber"/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>
                <p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody>
              </p:sp>
              <p:grpSp>
                <p:grpSpPr><a:xfrm><a:off x="100000" y="800000"/></a:xfrm></p:grpSpPr>
                <p:sp>
                  <p:nvSpPr><p:cNvPr id="5" name="Card"/><p:nvPr/></p:nvSpPr>
                  <p:txBody>
                    <a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:t>组合卡片核心指标</a:t></a:r></a:p>
                    <a:p><a:pPr lvl="1"/><a:r><a:t>同比增长 32%</a:t></a:r></a:p>
                  </p:txBody>
                </p:sp>
              </p:grpSp>
              <mc:AlternateContent>
                <mc:Choice Requires="a14">
                  <p:sp>
                    <p:nvSpPr><p:cNvPr id="6" name="Choice"/><p:nvPr/></p:nvSpPr>
                    <p:spPr><a:xfrm><a:off x="2000000" y="850000"/></a:xfrm></p:spPr>
                    <p:txBody><a:p><a:r><a:t>唯一正文</a:t></a:r></a:p></p:txBody>
                  </p:sp>
                </mc:Choice>
                <mc:Fallback>
                  <p:sp>
                    <p:nvSpPr><p:cNvPr id="7" name="Fallback"/><p:nvPr/></p:nvSpPr>
                    <p:txBody><a:p><a:r><a:t>不应重复出现</a:t></a:r></a:p></p:txBody>
                  </p:sp>
                </mc:Fallback>
              </mc:AlternateContent>
              <p:graphicFrame>
                <p:xfrm><a:off x="100000" y="1600000"/></p:xfrm>
                <a:graphic><a:graphicData>
                  <a:tbl>
                    <a:tr>
                      <a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>合并表头</a:t></a:r></a:p></a:txBody></a:tc>
                      <a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc>
                    </a:tr>
                    <a:tr>
                      <a:tc><a:txBody><a:p><a:r><a:t>华东</a:t></a:r></a:p><a:p><a:r><a:t>区域</a:t></a:r></a:p></a:txBody></a:tc>
                      <a:tc><a:txBody><a:p><a:r><a:t>120万</a:t></a:r></a:p></a:txBody></a:tc>
                    </a:tr>
                  </a:tbl>
                </a:graphicData></a:graphic>
              </p:graphicFrame>
              <p:graphicFrame>
                <p:xfrm><a:off x="100000" y="2200000"/></p:xfrm>
                <a:graphic><a:graphicData><c:chart r:id="rIdChart"/></a:graphicData></a:graphic>
              </p:graphicFrame>
              <p:pic>
                <p:nvPicPr><p:cNvPr id="8" name="arch.png" descr="架构示意图"/></p:nvPicPr>
                <p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill>
                <p:spPr><a:xfrm><a:off x="100000" y="2600000"/></a:xfrm></p:spPr>
              </p:pic>
            </p:spTree>
          </p:cSld>
        </p:sld>`,
      },
      {
        name: "ppt/slides/_rels/slide2.xml.rels",
        content: `<Relationships>
          <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/arch.png"/>
          <Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/>
          <Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
        </Relationships>`,
      },
      { name: "ppt/media/arch.png", content: TINY_PNG_BYTES, method: 0 },
      {
        name: "ppt/charts/chart1.xml",
        content: `<c:chartSpace xmlns:c="urn:c" xmlns:a="urn:a"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>季度营收趋势</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>`,
      },
      {
        name: "ppt/notesSlides/notesSlide2.xml",
        content: `<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree>
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>强调 Q4 毛利率提升原因</a:t></a:r></a:p></p:txBody></p:sp>
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>
        </p:spTree></p:cSld></p:notes>`,
      },
      {
        name: "ppt/slides/slide1.xml",
        content: `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      },
    ]);

    const registry = new BlobUrlRegistry();
    const session = await PptxDeckSession.open(OfficeArchive.open(zip), registry, domParser);
    expect(session.meta.slideCount).toBe(2);

    const first = await session.loadSlide(0);
    expect(first.number).toBe(1);
    expect(first.title).toBe("Q4 经营复盘");
    expect(first.notes).toBe("强调 Q4 毛利率提升原因");
    expect(first.images).toHaveLength(1);

    // Spatial order: y=800000 (grouped) -> y=850000 (same bucket, larger x) -> y=1600000 (table) -> y=2200000 (chart) -> y=2600000 (image) -> y=3000000 (bottom)
    expect(first.blocks.map((block) => block.kind)).toEqual(["text", "text", "table", "chart", "image", "text"]);
    expect(first.blocks[0]).toMatchObject({
      kind: "text",
      lines: [
        { text: "组合卡片核心指标", level: 0, bullet: true },
        { text: "同比增长 32%", level: 1 },
      ],
    });
    expect(first.blocks[1]).toMatchObject({ kind: "text", lines: [{ text: "唯一正文" }] });
    expect(first.blocks[2]).toEqual({
      kind: "table",
      rows: [
        [{ text: "合并表头", rowSpan: 1, colSpan: 2 }, null],
        [{ text: "华东\n区域", rowSpan: 1, colSpan: 1 }, { text: "120万", rowSpan: 1, colSpan: 1 }],
      ],
    });
    expect(first.blocks[3]).toEqual({ kind: "chart", title: "季度营收趋势" });
    expect(first.blocks[5]).toMatchObject({ kind: "text", lines: [{ text: "底部总结" }] });

    const second = await session.loadSlide(1);
    expect(second.title).toBe("第二页");
    registry.dispose(0);
  });
});
