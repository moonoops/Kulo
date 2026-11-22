import { describe, expect, it } from "vitest";
import { OfficeArchive } from "../src/features/chat/office-archive";
import {
  columnIndexToLabel,
  formatExcelDate,
  isExcelDateFormat,
  MAX_XLSX_COLS,
  MAX_XLSX_ROWS,
  XlsxWorkbookSession,
} from "../src/features/chat/xlsx-parser";
import { buildTestZip, createTestDomParser } from "./office-zip-fixture";

describe("xlsx-parser", () => {
  const domParser = createTestDomParser();

  it("distinguishes real date formats from color/literal numeric formats", () => {
    expect(isExcelDateFormat(14)).toBe(true);
    expect(isExcelDateFormat(31)).toBe(true); // CJK date
    expect(isExcelDateFormat(55)).toBe(true); // CJK date
    expect(isExcelDateFormat(164, "yyyy-mm-dd")).toBe(true);
    expect(isExcelDateFormat(165, 'yyyy"年"m"月"d"日"')).toBe(true);
    expect(isExcelDateFormat(166, "[Red]#,##0.00")).toBe(false);
    expect(isExcelDateFormat(167, "[Magenta]0.00")).toBe(false);
    expect(isExcelDateFormat(168, "0.0\\s")).toBe(false);
    expect(isExcelDateFormat(169, '#,##0.00" m"')).toBe(false);
  });

  it("formats 1900 and 1904 Excel serial dates accurately with second rounding", () => {
    expect(formatExcelDate(46348, false, 14)).toBe("2026-11-22");
    expect(formatExcelDate(1, false, 14)).toBe("1900-01-01");
    expect(formatExcelDate(59, false, 14)).toBe("1900-02-28");
    expect(formatExcelDate(61, false, 14)).toBe("1900-03-01");
    expect(formatExcelDate(46348.4999999, false, 22)).toBe("2026-11-22 12:00");
    expect(formatExcelDate(0, true, 14)).toBe("1904-01-01");
    expect(columnIndexToLabel(0)).toBe("A");
    expect(columnIndexToLabel(26)).toBe("AA");
  });

  it("skips hidden sheets, preserves spaces & strips rPh, handles openpyxl /xl/ paths, shared formulas, and huge mergeCell clamp", async () => {
    const zip = buildTestZip([
      {
        name: "xl/workbook.xml",
        content: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets>
            <sheet name="HiddenData" sheetId="1" r:id="rId1" state="hidden"/>
            <sheet name="财务汇总" sheetId="2" r:id="rId2"/>
          </sheets>
        </workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        content: `<Relationships>
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/>
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
        </Relationships>`,
      },
      {
        name: "xl/sharedStrings.xml",
        content: `<sst>
          <si><t>项目</t></si>
          <si><r><t xml:space="preserve">营收 </t></r><r><t>总计</t></r><rPh sb="0" eb="2"><t>エイギョウ</t></rPh></si>
          <si><t>日期</t></si>
          <si><t>A 组</t></si>
        </sst>`,
      },
      {
        name: "xl/styles.xml",
        content: `<styleSheet>
          <numFmts count="2">
            <numFmt numFmtId="164" formatCode="[Red]#,##0.00"/>
            <numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>
          </numFmts>
          <cellXfs count="3">
            <xf numFmtId="0"/>
            <xf numFmtId="164"/>
            <xf numFmtId="165"/>
          </cellXfs>
        </styleSheet>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        content: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>secret</t></is></c></row></sheetData></worksheet>`,
      },
      {
        name: "xl/worksheets/sheet2.xml",
        content: `<worksheet>
          <sheetViews><sheetView tabSelected="1"><pane ySplit="1"/></sheetView></sheetViews>
          <sheetData>
            <row r="1">
              <c r="A1" t="s"><v>0</v></c>
              <c r="B1" t="s"><v>1</v></c>
              <c r="C1" t="s"><v>2</v></c>
              <c r="D1" t="inlineStr"><is><t>合计公式</t></is></c>
            </row>
            <row r="2">
              <c r="A2" t="s"><v>3</v></c>
              <c r="B2" s="1"><v>12345.6</v></c>
              <c r="C2" s="2"><v>46348</v></c>
              <c r="D2"><f t="shared" ref="D2:D3" si="0">SUM(B2:B2)</f></c>
            </row>
            <row r="3">
              <c r="A3" t="inlineStr"><is><t>B 组</t></is></c>
              <c r="B3" s="1"><v>88</v></c>
              <c r="C3" s="2"><v>46349</v></c>
              <c r="D3"><f t="shared" si="0"/></c>
            </row>
          </sheetData>
          <mergeCells count="2">
            <mergeCell ref="A5:XFD1048576"/>
            <mergeCell ref="E1:F1"/>
          </mergeCells>
        </worksheet>`,
      },
    ]);

    const started = performance.now();
    const session = await XlsxWorkbookSession.open(OfficeArchive.open(zip), domParser);
    expect(session.meta.sheets.map((s) => s.name)).toEqual(["财务汇总"]);
    const sheet = await session.loadSheet(0);
    expect(performance.now() - started).toBeLessThan(1000);

    expect(sheet.hasHeaderRow).toBe(true);
    expect(sheet.rows[0]?.[1]?.text).toBe("营收 总计");
    expect(sheet.rows[1]?.[1]?.text).toMatch(/12,345\.6/);
    expect(sheet.rows[1]?.[2]?.text).toBe("2026-11-22");
    expect(sheet.rows[1]?.[3]?.text).toBe("=SUM(B2:B2)");
    expect(sheet.rows[2]?.[3]?.text).toBe("=SUM(B2:B2)");
    expect(sheet.hasUncalculatedFormulas).toBe(true);
  });

  it("clamps oversized sheets cleanly to 500x50 and reports full counts", async () => {
    const rowXml: string[] = [];
    for (let r = 1; r <= MAX_XLSX_ROWS + 12; r++) {
      rowXml.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="${columnIndexToLabel(MAX_XLSX_COLS + 3)}${r}"><v>9</v></c></row>`);
    }
    const zip = buildTestZip([
      { name: "xl/workbook.xml", content: `<workbook xmlns:r="urn:r"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", content: `<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: "xl/worksheets/sheet1.xml", content: `<worksheet><sheetData>${rowXml.join("")}</sheetData></worksheet>` },
    ]);
    const session = await XlsxWorkbookSession.open(OfficeArchive.open(zip), domParser);
    const sheet = await session.loadSheet(0);
    expect(sheet.renderedRows).toBe(MAX_XLSX_ROWS);
    expect(sheet.totalRows).toBe(MAX_XLSX_ROWS + 12);
    expect(sheet.truncatedRows).toBe(true);
    expect(sheet.truncatedCols).toBe(true);
    expect(sheet.totalCols).toBe(MAX_XLSX_COLS + 4);
  });
});
