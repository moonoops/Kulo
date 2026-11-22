import {
  OfficeArchive,
  OfficePreviewError,
  parseRelationships,
  xmlAttr,
  xmlEffectiveChildren,
  xmlFirstChild,
  xmlLocalName,
  xmlRelAttr,
} from "./office-archive";

export const MAX_XLSX_SHEETS = 20;
export const MAX_XLSX_ROWS = 500;
export const MAX_XLSX_COLS = 50;
export const MAX_XLSX_MERGES = 2_000;

export interface XlsxSheetDescriptor {
  index: number;
  name: string;
  path: string;
}

export interface XlsxWorkbookMeta {
  sheets: XlsxSheetDescriptor[];
  totalVisibleSheets: number;
  truncatedSheets: boolean;
  date1904: boolean;
}

export type XlsxCellKind = "empty" | "text" | "number" | "boolean" | "error" | "formula";

export interface XlsxRenderCell {
  text: string;
  kind: XlsxCellKind;
  align: "left" | "right" | "center";
  formula?: string;
  rowSpan: number;
  colSpan: number;
}

export interface XlsxSheetData {
  index: number;
  name: string;
  rows: Array<Array<XlsxRenderCell | null>>;
  renderedRows: number;
  renderedCols: number;
  totalRows: number;
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
  hasHeaderRow: boolean;
  hasUncalculatedFormulas: boolean;
}

interface XlsxStyleFormat {
  numFmtId: number;
  formatCode?: string;
}

const BUILTIN_DATE_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

const BUILTIN_TIME_ONLY_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);
const BUILTIN_PERCENT_IDS = new Set([9, 10]);

export function columnIndexToLabel(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export function parseCellRef(ref: string): { row: number; col: number } | undefined {
  const match = /^([A-Za-z]{1,4})(\d{1,7})$/.exec(ref.trim());
  if (!match) return undefined;
  const letters = match[1]!.toUpperCase();
  const rowNum = Number(match[2]);
  if (!Number.isSafeInteger(rowNum) || rowNum < 1) return undefined;
  let colNum = 0;
  for (let i = 0; i < letters.length; i++) {
    colNum = colNum * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row: rowNum - 1, col: colNum - 1 };
}

function stripFormatLiterals(formatCode: string): string {
  const firstSection = formatCode.split(";", 1)[0] ?? "";
  return firstSection
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, "")
    .replace(/[_*]./g, "");
}

export function isExcelDateFormat(numFmtId?: number, formatCode?: string): boolean {
  if (numFmtId !== undefined && BUILTIN_DATE_IDS.has(numFmtId)) return true;
  if (!formatCode) return false;
  const stripped = stripFormatLiterals(formatCode);
  if (/[#0]/.test(stripped)) return false;
  return /(?:y+|d+|h+|s+|m{1,5})/i.test(stripped);
}

function isTimeOnlyFormat(numFmtId?: number, formatCode?: string): boolean {
  if (numFmtId !== undefined && BUILTIN_TIME_ONLY_IDS.has(numFmtId)) return true;
  if (!formatCode) return false;
  const stripped = stripFormatLiterals(formatCode);
  return !/[yd]/i.test(stripped) && /[hs]/i.test(stripped);
}

function isPercentFormat(numFmtId?: number, formatCode?: string): boolean {
  if (numFmtId !== undefined && BUILTIN_PERCENT_IDS.has(numFmtId)) return true;
  if (!formatCode) return false;
  return stripFormatLiterals(formatCode).includes("%");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatExcelDate(serial: number, date1904: boolean, numFmtId?: number, formatCode?: string): string {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466) return formatPlainNumber(serial);
  const totalSeconds = Math.round(serial * 86_400);
  if (isTimeOnlyFormat(numFmtId, formatCode) || (serial < 1 && !date1904)) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(hours)}:${pad2(minutes)}`;
  }

  let dayCount = Math.floor(totalSeconds / 86_400);
  const secondsInDay = totalSeconds - dayCount * 86_400;
  let baseUtcMs: number;
  if (date1904) {
    baseUtcMs = Date.UTC(1904, 0, 1);
  } else {
    // Excel 1900 epoch includes the nonexistent 1900-02-29 (serial 60).
    baseUtcMs = Date.UTC(1899, 11, 30);
    if (dayCount > 0 && dayCount < 60) dayCount += 1;
  }
  const date = new Date(baseUtcMs + dayCount * 86_400_000 + secondsInDay * 1000);
  const yyyy = date.getUTCFullYear();
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  if (secondsInDay === 0) return `${yyyy}-${mm}-${dd}`;
  const hh = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const ss = date.getUTCSeconds();
  return ss > 0 ? `${yyyy}-${mm}-${dd} ${hh}:${mi}:${pad2(ss)}` : `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatPlainNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Object.is(value, -0)) return "0";
  if (Number.isInteger(value)) return String(value);
  // Trim IEEE-754 floating artifacts such as 0.30000000000000004.
  return Number(value.toPrecision(12)).toString();
}

function formatNumericCell(raw: string, style: XlsxStyleFormat | undefined, date1904: boolean): string {
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  if (isExcelDateFormat(style?.numFmtId, style?.formatCode)) {
    return formatExcelDate(num, date1904, style?.numFmtId, style?.formatCode);
  }
  if (isPercentFormat(style?.numFmtId, style?.formatCode)) {
    const pct = num * 100;
    const cleaned = Number(pct.toPrecision(10));
    return `${cleaned}%`;
  }
  const formatCode = style?.formatCode;
  if (formatCode && stripFormatLiterals(formatCode).includes(",")) {
    const decimalsMatch = /\.([0#]+)/.exec(stripFormatLiterals(formatCode));
    const maxFrac = decimalsMatch ? Math.min(decimalsMatch[1]!.length, 6) : 2;
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: maxFrac }).format(num);
  }
  return formatPlainNumber(num);
}

/** Concatenate text from <si> or <is>, preserving whitespace and skipping <rPh> phonetic runs. */
function extractRichText(container: Element): string {
  let out = "";
  for (const child of xmlEffectiveChildren(container)) {
    const name = xmlLocalName(child);
    if (name === "t") {
      out += child.textContent ?? "";
    } else if (name === "r") {
      for (const runChild of xmlEffectiveChildren(child)) {
        if (xmlLocalName(runChild) === "t") {
          out += runChild.textContent ?? "";
        }
      }
    }
  }
  return out;
}

function parseStyles(doc: Document | undefined): XlsxStyleFormat[] {
  if (!doc) return [];
  const custom = new Map<number, string>();
  const numFmts = xmlFirstChild(doc.documentElement, "numFmts");
  if (numFmts) {
    for (const fmt of xmlEffectiveChildren(numFmts, "numFmt")) {
      const id = Number(xmlAttr(fmt, "numFmtId"));
      const code = xmlAttr(fmt, "formatCode");
      if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
    }
  }
  const styles: XlsxStyleFormat[] = [];
  const cellXfs = xmlFirstChild(doc.documentElement, "cellXfs");
  if (cellXfs) {
    for (const xf of xmlEffectiveChildren(cellXfs, "xf")) {
      const numFmtId = Number(xmlAttr(xf, "numFmtId") ?? 0);
      styles.push({
        numFmtId: Number.isInteger(numFmtId) ? numFmtId : 0,
        formatCode: custom.get(numFmtId),
      });
    }
  }
  return styles;
}

export class XlsxWorkbookSession {
  readonly meta: XlsxWorkbookMeta;
  private readonly archive: OfficeArchive;
  private readonly domParser?: DOMParser;
  private readonly styles: XlsxStyleFormat[];
  private sharedStrings: string[] | undefined;
  private sharedStringsLoaded = false;
  private readonly sheetCache = new Map<number, XlsxSheetData>();

  private constructor(
    archive: OfficeArchive,
    meta: XlsxWorkbookMeta,
    styles: XlsxStyleFormat[],
    domParser?: DOMParser,
  ) {
    this.archive = archive;
    this.meta = meta;
    this.styles = styles;
    this.domParser = domParser;
  }

  static async open(
    archive: OfficeArchive,
    domParser?: DOMParser,
    signal?: AbortSignal,
  ): Promise<XlsxWorkbookSession> {
    const workbookDoc = await archive.readXml("xl/workbook.xml", domParser, signal);
    if (!workbookDoc) {
      throw new OfficePreviewError("invalid_format", "未找到 Excel 工作簿内容，无法预览", false);
    }
    const rels = await parseRelationships(archive, "xl/workbook.xml", domParser, signal);
    const workbookPr = xmlFirstChild(workbookDoc.documentElement, "workbookPr");
    const date1904Raw = xmlAttr(workbookPr ?? workbookDoc.documentElement, "date1904");
    const date1904 = workbookPr !== undefined && (date1904Raw === "1" || date1904Raw === "true");

    const sheetsContainer = xmlFirstChild(workbookDoc.documentElement, "sheets");
    const rawSheets = sheetsContainer ? xmlEffectiveChildren(sheetsContainer, "sheet") : [];
    const allResolved: Array<{ name: string; path: string; hidden: boolean }> = [];
    for (const sheetEl of rawSheets) {
      const name = xmlAttr(sheetEl, "name") || `Sheet ${allResolved.length + 1}`;
      const relId = xmlRelAttr(sheetEl, "id");
      const state = xmlAttr(sheetEl, "state")?.toLowerCase();
      const hidden = state === "hidden" || state === "veryhidden";
      const rel = relId ? rels.get(relId) : undefined;
      if (!rel?.resolvedPath || !archive.has(rel.resolvedPath)) continue;
      allResolved.push({ name, path: rel.resolvedPath, hidden });
    }
    const visible = allResolved.filter((sheet) => !sheet.hidden);
    const chosen = visible.length > 0 ? visible : allResolved.slice(0, 1);
    if (chosen.length === 0) {
      throw new OfficePreviewError("invalid_format", "工作簿中无可预览的工作表", false);
    }
    const sheets: XlsxSheetDescriptor[] = chosen.slice(0, MAX_XLSX_SHEETS).map((entry, index) => ({
      index,
      name: entry.name,
      path: entry.path,
    }));

    const stylesDoc = await archive.readXml("xl/styles.xml", domParser, signal);
    const styles = parseStyles(stylesDoc);

    return new XlsxWorkbookSession(
      archive,
      {
        sheets,
        totalVisibleSheets: chosen.length,
        truncatedSheets: chosen.length > MAX_XLSX_SHEETS,
        date1904,
      },
      styles,
      domParser,
    );
  }

  private async ensureSharedStrings(signal?: AbortSignal): Promise<string[]> {
    if (this.sharedStringsLoaded) return this.sharedStrings ?? [];
    this.sharedStringsLoaded = true;
    const doc = await this.archive.readXml("xl/sharedStrings.xml", this.domParser, signal);
    if (!doc) {
      this.sharedStrings = [];
      return this.sharedStrings;
    }
    const list: string[] = [];
    for (const si of xmlEffectiveChildren(doc.documentElement, "si")) {
      list.push(extractRichText(si));
    }
    this.sharedStrings = list;
    return list;
  }

  async loadSheet(index: number, signal?: AbortSignal): Promise<XlsxSheetData> {
    const cached = this.sheetCache.get(index);
    if (cached) return cached;
    const descriptor = this.meta.sheets[index];
    if (!descriptor) {
      throw new OfficePreviewError("invalid_format", "请求的工作表不存在", false);
    }

    const sharedStrings = await this.ensureSharedStrings(signal);
    const doc = await this.archive.readXml(descriptor.path, this.domParser, signal);
    if (!doc) {
      throw new OfficePreviewError("invalid_format", "工作表内容缺失，无法预览", false);
    }

    let frozenRows = 0;
    const sheetViews = xmlFirstChild(doc.documentElement, "sheetViews");
    if (sheetViews) {
      for (const view of xmlEffectiveChildren(sheetViews, "sheetView")) {
        const pane = xmlFirstChild(view, "pane");
        const ySplit = pane ? Number(xmlAttr(pane, "ySplit")) : 0;
        if (Number.isFinite(ySplit) && ySplit >= 1) {
          frozenRows = Math.max(frozenRows, Math.floor(ySplit));
        }
      }
    }

    // Clamp merge ranges to the rendered window BEFORE iterating (blocks 17.1B-iteration DoS).
    const mergeMasters = new Map<string, { rowSpan: number; colSpan: number }>();
    const mergeCovered = new Set<string>();
    const mergeCellsEl = xmlFirstChild(doc.documentElement, "mergeCells");
    if (mergeCellsEl) {
      const mergeNodes = xmlEffectiveChildren(mergeCellsEl, "mergeCell");
      const limit = Math.min(mergeNodes.length, MAX_XLSX_MERGES);
      for (let i = 0; i < limit; i++) {
        const ref = xmlAttr(mergeNodes[i]!, "ref");
        if (!ref) continue;
        const parts = ref.split(":");
        if (parts.length !== 2) continue;
        const start = parseCellRef(parts[0]!);
        const end = parseCellRef(parts[1]!);
        if (!start || !end) continue;
        const r1 = Math.min(start.row, end.row);
        const c1 = Math.min(start.col, end.col);
        if (r1 >= MAX_XLSX_ROWS || c1 >= MAX_XLSX_COLS) continue;
        const r2 = Math.min(Math.max(start.row, end.row), MAX_XLSX_ROWS - 1);
        const c2 = Math.min(Math.max(start.col, end.col), MAX_XLSX_COLS - 1);
        if (r2 === r1 && c2 === c1) continue;
        mergeMasters.set(`${r1}:${c1}`, { rowSpan: r2 - r1 + 1, colSpan: c2 - c1 + 1 });
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            if (r !== r1 || c !== c1) mergeCovered.add(`${r}:${c}`);
          }
        }
      }
    }

    const sheetData = xmlFirstChild(doc.documentElement, "sheetData");
    const cellGrid = new Map<number, Map<number, XlsxRenderCell>>();
    const sharedFormulas = new Map<string, string>();
    let totalRows = 0;
    let totalCols = 0;
    let maxRenderedRow = -1;
    let maxRenderedCol = -1;
    let hasUncalculatedFormulas = false;

    if (sheetData) {
      let nextRowIndex = 0;
      for (const rowEl of xmlEffectiveChildren(sheetData, "row")) {
        const rAttr = xmlAttr(rowEl, "r");
        const parsedRow = rAttr ? Number(rAttr) - 1 : nextRowIndex;
        const rowIndex = Number.isSafeInteger(parsedRow) && parsedRow >= 0 ? parsedRow : nextRowIndex;
        nextRowIndex = rowIndex + 1;

        let nextColIndex = 0;
        let rowHasContent = false;
        for (const cellEl of xmlEffectiveChildren(cellElChildrenRow(rowEl), "c")) {
          const refAttr = xmlAttr(cellEl, "r");
          const decoded = refAttr ? parseCellRef(refAttr) : undefined;
          const colIndex = decoded ? decoded.col : nextColIndex;
          const effectiveRow = decoded ? decoded.row : rowIndex;
          nextColIndex = colIndex + 1;

          const fEl = xmlFirstChild(cellEl, "f");
          let formulaText: string | undefined;
          if (fEl) {
            const fType = xmlAttr(fEl, "t");
            const si = xmlAttr(fEl, "si");
            const rawFormula = (fEl.textContent ?? "").trim();
            if (fType === "shared" && si !== undefined) {
              if (rawFormula) {
                sharedFormulas.set(si, rawFormula);
                formulaText = rawFormula;
              } else {
                formulaText = sharedFormulas.get(si) ?? "";
              }
            } else {
              formulaText = rawFormula;
            }
          }

          const cellType = xmlAttr(cellEl, "t") ?? "";
          const styleAttr = xmlAttr(cellEl, "s");
          const styleIndex = styleAttr !== undefined ? Number(styleAttr) : undefined;
          const style = styleIndex !== undefined && Number.isInteger(styleIndex) ? this.styles[styleIndex] : undefined;
          const vEl = xmlFirstChild(cellEl, "v");
          const vRaw = vEl ? (vEl.textContent ?? "") : undefined;
          const isEl = cellType === "inlineStr" ? xmlFirstChild(cellEl, "is") : undefined;

          let text = "";
          let kind: XlsxCellKind = "empty";
          let align: "left" | "right" | "center" = "left";

          if (cellType === "s") {
            const idx = vRaw !== undefined ? Number(vRaw) : NaN;
            text = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx]! : "";
            kind = text ? "text" : "empty";
          } else if (cellType === "inlineStr") {
            text = isEl ? extractRichText(isEl) : "";
            kind = text ? "text" : "empty";
          } else if (cellType === "str") {
            text = vRaw ?? "";
            kind = text ? "text" : "empty";
          } else if (cellType === "b") {
            text = vRaw === "1" || vRaw?.toLowerCase() === "true" ? "TRUE" : "FALSE";
            kind = "boolean";
            align = "center";
          } else if (cellType === "e") {
            text = vRaw ?? "#ERR";
            kind = "error";
            align = "center";
          } else if (vRaw !== undefined && vRaw !== "") {
            text = formatNumericCell(vRaw, style, this.meta.date1904);
            kind = isExcelDateFormat(style?.numFmtId, style?.formatCode) ? "text" : "number";
            align = kind === "number" ? "right" : "left";
          }

          if (fEl && kind === "empty") {
            hasUncalculatedFormulas = true;
            text = formulaText ? `=${formulaText}` : "=公式";
            kind = "formula";
            align = "left";
          }

          if (kind !== "empty") {
            rowHasContent = true;
            if (colIndex + 1 > totalCols) totalCols = colIndex + 1;
            if (effectiveRow < MAX_XLSX_ROWS && colIndex < MAX_XLSX_COLS) {
              let rowMap = cellGrid.get(effectiveRow);
              if (!rowMap) {
                rowMap = new Map();
                cellGrid.set(effectiveRow, rowMap);
              }
              const merge = mergeMasters.get(`${effectiveRow}:${colIndex}`);
              rowMap.set(colIndex, {
                text,
                kind,
                align,
                ...(formulaText ? { formula: `=${formulaText}` } : {}),
                rowSpan: merge?.rowSpan ?? 1,
                colSpan: merge?.colSpan ?? 1,
              });
              const endRow = effectiveRow + (merge?.rowSpan ?? 1) - 1;
              const endCol = colIndex + (merge?.colSpan ?? 1) - 1;
              if (endRow > maxRenderedRow) maxRenderedRow = endRow;
              if (endCol > maxRenderedCol) maxRenderedCol = endCol;
            }
          }
        }
        if (rowHasContent && rowIndex + 1 > totalRows) totalRows = rowIndex + 1;
      }
    }

    const renderedRows = maxRenderedRow >= 0 ? Math.min(maxRenderedRow + 1, MAX_XLSX_ROWS) : 0;
    const renderedCols = maxRenderedCol >= 0 ? Math.min(maxRenderedCol + 1, MAX_XLSX_COLS) : 0;
    const rows: Array<Array<XlsxRenderCell | null>> = [];
    for (let r = 0; r < renderedRows; r++) {
      const rowMap = cellGrid.get(r);
      const outRow: Array<XlsxRenderCell | null> = [];
      for (let c = 0; c < renderedCols; c++) {
        const key = `${r}:${c}`;
        if (mergeCovered.has(key)) {
          outRow.push(null);
          continue;
        }
        const existing = rowMap?.get(c);
        if (existing) {
          // Re-clamp span to actual trimmed sheet bounds so tables never have ragged rows.
          outRow.push({
            ...existing,
            rowSpan: Math.min(existing.rowSpan, renderedRows - r),
            colSpan: Math.min(existing.colSpan, renderedCols - c),
          });
        } else {
          const merge = mergeMasters.get(key);
          outRow.push({
            text: "",
            kind: "empty",
            align: "left",
            rowSpan: merge ? Math.min(merge.rowSpan, renderedRows - r) : 1,
            colSpan: merge ? Math.min(merge.colSpan, renderedCols - c) : 1,
          });
        }
      }
      rows.push(outRow);
    }

    const firstRowCells = (rows[0] ?? []).filter((cell): cell is XlsxRenderCell => cell !== null && cell.kind !== "empty");
    const inferredHeader = renderedRows >= 2 && firstRowCells.length > 0 && firstRowCells.every((cell) => cell.kind === "text");
    const hasHeaderRow = renderedRows > 0 && (frozenRows >= 1 || inferredHeader);

    const data: XlsxSheetData = {
      index,
      name: descriptor.name,
      rows,
      renderedRows,
      renderedCols,
      totalRows: Math.max(totalRows, renderedRows),
      totalCols: Math.max(totalCols, renderedCols),
      truncatedRows: totalRows > MAX_XLSX_ROWS,
      truncatedCols: totalCols > MAX_XLSX_COLS,
      hasHeaderRow,
      hasUncalculatedFormulas,
    };
    this.sheetCache.set(index, data);
    return data;
  }
}

function cellElChildrenRow(rowEl: Element): Element {
  return rowEl;
}
