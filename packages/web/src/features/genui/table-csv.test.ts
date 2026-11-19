import { describe, expect, it } from "vitest";
import { buildTableCsv, tableCsvFileName, type DataRow } from "./table-csv";

describe("table CSV export", () => {
  it("quotes headers and fields without losing commas, quotes, Unicode or line breaks", () => {
    const csv = buildTableCsv([{ key: "name", label: '名称,"备注"' }], [{ name: '中文,\r\n含"引号"' }]);
    expect(csv).toBe('"名称,""备注"""\r\n"中文,\r\n含""引号"""\r\n');
  });

  it("retains numbers and booleans while exporting null and absent cells as empty fields", () => {
    const columns = ["number", "yes", "no", "empty", "absent"].map((key) => ({ key, label: key }));
    const csv = buildTableCsv(columns, [{ number: -12.5, yes: true, no: false, empty: null }]);
    expect(csv).toBe('"number","yes","no","empty","absent"\r\n"-12.5","true","false","",""\r\n');
  });

  it.each([
    "=1+2", "+SUM(1,2)", "-1+2", "@SUM(A1:A2)", " =1", "\t=1", "\r=1", "\n=1",
    "\u0000=1", "\ufeff=1", "\u200b=1", "＝1+2", "＋1", "－1", "＠SUM(A1)",
  ])("keeps spreadsheet formula text literal: %j", (value) => {
    const csv = buildTableCsv([{ key: "text", label: "内容" }], [{ text: value }]);
    expect(csv).toBe(`"内容"\r\n"\t${value.replaceAll('"', '""')}"\r\n`);
  });

  it("protects header formulas and delimiter/quote attempts at introducing a new cell", () => {
    const csv = buildTableCsv([{ key: "text", label: "=SUM(A1)" }], [{ text: '=1+2";,=1+2' }]);
    expect(csv).toBe('"\t=SUM(A1)"\r\n"\t=1+2"";,=1+2"\r\n');
  });

  it("includes every loaded source row and additional source fields in stable column order", () => {
    const rows: DataRow[] = Array.from({ length: 100 }, (_, index) => ({ index, name: `行${index}`, source: `原始${index}` }));
    const csv = buildTableCsv([{ key: "name", label: "名称" }], rows);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(102);
    expect(lines[0]).toBe('"名称","index","source"');
    expect(lines[1]).toBe('"行0","0","原始0"');
    expect(lines[100]).toBe('"行99","99","原始99"');
    expect(rows[0]).toEqual({ index: 0, name: "行0", source: "原始0" });
  });

  it("builds a usable file name from captions", () => {
    expect(tableCsvFileName("方案对比")).toBe("方案对比.csv");
    expect(tableCsvFileName("A/B:C\nD")).toBe("A_B_C_D.csv");
    expect(tableCsvFileName("  ... ")).toBe("数据表.csv");
    expect(tableCsvFileName()).toBe("数据表.csv");
  });
});
