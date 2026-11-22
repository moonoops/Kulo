import {
  BlobUrlRegistry,
  OfficeArchive,
  OfficePreviewError,
  parseRelationships,
  safeOfficeExternalUrl,
  xmlAttr,
  xmlEffectiveChildren,
  xmlFindDescendants,
  xmlFirstChild,
  xmlLocalName,
  xmlRelAttr,
  type OpcRelationship,
  type ResolvedOfficeImage,
} from "./office-archive";

export const MAX_DOCX_BLOCKS = 1_500;
const MAX_STYLE_DEPTH = 16;
const MONO_FONT_RE = /(?:consolas|courier|menlo|monaco|sf mono|fira code|jetbrains|monospace)/i;

export type DocxParagraphRole = "title" | "subtitle" | "h1" | "h2" | "h3" | "body";

export type DocxInlineRun =
  | {
      kind: "text";
      text: string;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strike?: boolean;
      code?: boolean;
      highlight?: boolean;
      vertAlign?: "superscript" | "subscript";
      href?: string;
    }
  | { kind: "break" }
  | { kind: "image"; image: ResolvedOfficeImage; alt: string };

export interface DocxParagraphBlock {
  kind: "paragraph";
  role: DocxParagraphRole;
  align?: "center" | "right";
  list?: { ordered: boolean; level: number; ordinal?: number };
  shaded?: boolean;
  runs: DocxInlineRun[];
}

export interface DocxTableCell {
  paragraphs: DocxParagraphBlock[];
  rowSpan: number;
  colSpan: number;
  isHeader: boolean;
  shaded?: boolean;
}

export interface DocxTableBlock {
  kind: "table";
  rows: Array<Array<DocxTableCell | null>>;
}

export interface DocxPageBreakBlock {
  kind: "page-break";
}

export type DocxBlock = DocxParagraphBlock | DocxTableBlock | DocxPageBreakBlock;

export interface DocxDocumentData {
  headerText?: string;
  footerText?: string;
  blocks: DocxBlock[];
  truncatedBlocks: boolean;
  images: ResolvedOfficeImage[];
  omittedImages: number;
}

interface RawStyle {
  id: string;
  name?: string;
  basedOn?: string;
  outlineLvl?: number;
  align?: "center" | "right";
  bold?: boolean;
  italic?: boolean;
  numId?: string;
  ilvl?: number;
}

interface ResolvedStyle {
  role: DocxParagraphRole;
  align?: "center" | "right";
  bold?: boolean;
  italic?: boolean;
  numId?: string;
  ilvl?: number;
}

function isToggleOn(el: Element | undefined): boolean | undefined {
  if (!el) return undefined;
  const val = xmlAttr(el, "val")?.toLowerCase();
  if (val === "0" || val === "false" || val === "none") return false;
  return true;
}

function isNonWhiteShading(shd: Element | undefined): boolean {
  if (!shd) return false;
  const fill = xmlAttr(shd, "fill")?.trim().toLowerCase();
  if (!fill || fill === "auto" || fill === "ffffff" || fill === "clear" || fill === "nil") return false;
  return /^[0-9a-f]{6}$/.test(fill);
}

function roleFromStyleMeta(id: string, name?: string, outlineLvl?: number): DocxParagraphRole | undefined {
  const candidates = [name ?? "", id].map((s) => s.trim());
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (/^title$/i.test(candidate) || candidate === "标题") return "title";
    if (/^subtitle$/i.test(candidate) || candidate === "副标题") return "subtitle";
    const headingMatch = /^(?:heading|标题)\s*([1-6])$/i.exec(candidate);
    if (headingMatch) {
      const level = Number(headingMatch[1]);
      return level === 1 ? "h1" : level === 2 ? "h2" : "h3";
    }
  }
  if (outlineLvl !== undefined && outlineLvl >= 0 && outlineLvl <= 8) {
    return outlineLvl === 0 ? "h1" : outlineLvl === 1 ? "h2" : "h3";
  }
  return undefined;
}

function parseStyles(doc: Document | undefined): Map<string, ResolvedStyle> {
  const rawMap = new Map<string, RawStyle>();
  if (!doc) return new Map();

  for (const styleEl of xmlEffectiveChildren(doc.documentElement, "style")) {
    const id = xmlAttr(styleEl, "styleId");
    if (!id) continue;
    const nameEl = xmlFirstChild(styleEl, "name");
    const basedOnEl = xmlFirstChild(styleEl, "basedOn");
    const pPr = xmlFirstChild(styleEl, "pPr");
    const rPr = xmlFirstChild(styleEl, "rPr");

    const outlineEl = pPr ? xmlFirstChild(pPr, "outlineLvl") : undefined;
    const outlineRaw = outlineEl ? Number(xmlAttr(outlineEl, "val")) : NaN;
    const jcVal = pPr ? xmlAttr(xmlFirstChild(pPr, "jc") ?? pPr, "val")?.toLowerCase() : undefined;
    const align = pPr && xmlFirstChild(pPr, "jc")
      ? (jcVal === "center" ? "center" : jcVal === "right" || jcVal === "end" ? "right" : undefined)
      : undefined;
    const numPr = pPr ? xmlFirstChild(pPr, "numPr") : undefined;
    const numId = numPr ? xmlAttr(xmlFirstChild(numPr, "numId") ?? numPr, "val") : undefined;
    const ilvlRaw = numPr && xmlFirstChild(numPr, "ilvl") ? Number(xmlAttr(xmlFirstChild(numPr, "ilvl")!, "val")) : undefined;

    rawMap.set(id, {
      id,
      name: nameEl ? xmlAttr(nameEl, "val") : undefined,
      basedOn: basedOnEl ? xmlAttr(basedOnEl, "val") : undefined,
      outlineLvl: Number.isInteger(outlineRaw) && outlineRaw >= 0 ? outlineRaw : undefined,
      align,
      bold: rPr ? isToggleOn(xmlFirstChild(rPr, "b")) : undefined,
      italic: rPr ? isToggleOn(xmlFirstChild(rPr, "i")) : undefined,
      numId: numPr && xmlFirstChild(numPr, "numId") ? numId : undefined,
      ilvl: ilvlRaw !== undefined && Number.isInteger(ilvlRaw) && ilvlRaw >= 0 ? ilvlRaw : undefined,
    });
  }

  const resolved = new Map<string, ResolvedStyle>();
  const resolveOne = (id: string, depth: number, visited: Set<string>): ResolvedStyle => {
    const cached = resolved.get(id);
    if (cached) return cached;
    const raw = rawMap.get(id);
    if (!raw || depth >= MAX_STYLE_DEPTH || visited.has(id)) {
      return { role: "body" };
    }
    visited.add(id);
    const parent = raw.basedOn ? resolveOne(raw.basedOn, depth + 1, visited) : undefined;
    visited.delete(id);

    const ownRole = roleFromStyleMeta(raw.id, raw.name, raw.outlineLvl);
    const result: ResolvedStyle = {
      role: ownRole ?? parent?.role ?? "body",
      align: raw.align ?? parent?.align,
      bold: raw.bold ?? parent?.bold,
      italic: raw.italic ?? parent?.italic,
      numId: raw.numId ?? parent?.numId,
      ilvl: raw.ilvl ?? parent?.ilvl,
    };
    resolved.set(id, result);
    return result;
  };

  for (const id of rawMap.keys()) resolveOne(id, 0, new Set());
  return resolved;
}

function parseNumbering(doc: Document | undefined): Map<string, Map<number, boolean>> {
  const result = new Map<string, Map<number, boolean>>();
  if (!doc) return result;
  const abstractMap = new Map<string, Map<number, boolean>>();

  for (const absEl of xmlEffectiveChildren(doc.documentElement, "abstractNum")) {
    const absId = xmlAttr(absEl, "abstractNumId");
    if (!absId) continue;
    const levels = new Map<number, boolean>();
    for (const lvlEl of xmlEffectiveChildren(absEl, "lvl")) {
      const ilvl = Number(xmlAttr(lvlEl, "ilvl"));
      if (!Number.isInteger(ilvl) || ilvl < 0) continue;
      const numFmtEl = xmlFirstChild(lvlEl, "numFmt");
      const fmt = numFmtEl ? (xmlAttr(numFmtEl, "val") ?? "").toLowerCase() : "";
      const ordered = fmt !== "" && fmt !== "bullet" && fmt !== "none";
      levels.set(ilvl, ordered);
    }
    abstractMap.set(absId, levels);
  }

  for (const numEl of xmlEffectiveChildren(doc.documentElement, "num")) {
    const numId = xmlAttr(numEl, "numId");
    const absRefEl = xmlFirstChild(numEl, "abstractNumId");
    const absId = absRefEl ? xmlAttr(absRefEl, "val") : undefined;
    if (!numId || !absId) continue;
    const levels = abstractMap.get(absId);
    if (levels) result.set(numId, levels);
  }
  return result;
}

function extractSimplePartText(doc: Document | undefined): string | undefined {
  if (!doc) return undefined;
  const skip = new Set(["del", "delText", "instrText", "moveFrom"]);
  const parts: string[] = [];
  for (const pEl of xmlFindDescendants(doc.documentElement, "p", skip)) {
    const text = xmlFindDescendants(pEl, "t", skip)
      .map((t) => t.textContent ?? "")
      .join("")
      .trim();
    if (text) parts.push(text);
  }
  const joined = parts.join(" · ").trim();
  return joined ? joined.slice(0, 240) : undefined;
}

export async function parseDocxArchive(
  archive: OfficeArchive,
  mediaRegistry: BlobUrlRegistry,
  domParser?: DOMParser,
  signal?: AbortSignal,
): Promise<DocxDocumentData> {
  const docXml = await archive.readXml("word/document.xml", domParser, signal);
  if (!docXml) {
    throw new OfficePreviewError("invalid_format", "未找到 Word 文档正文内容，无法预览", false);
  }
  const body = xmlFirstChild(docXml.documentElement, "body");
  if (!body) {
    throw new OfficePreviewError("invalid_format", "Word 文档结构不完整，无法预览", false);
  }

  const [rels, stylesDoc, numberingDoc] = await Promise.all([
    parseRelationships(archive, "word/document.xml", domParser, signal),
    archive.readXml("word/styles.xml", domParser, signal),
    archive.readXml("word/numbering.xml", domParser, signal),
  ]);
  const styles = parseStyles(stylesDoc);
  const numbering = parseNumbering(numberingDoc);

  const images: ResolvedOfficeImage[] = [];
  const omittedBefore = mediaRegistry.omittedCount;
  const listCounters = new Map<string, number>();

  const parseRun = async (
    runEl: Element,
    inherited: { bold?: boolean; italic?: boolean; href?: string },
  ): Promise<{ runs: DocxInlineRun[]; hasPageBreak: boolean }> => {
    const rPr = xmlFirstChild(runEl, "rPr");
    const bold = (rPr ? isToggleOn(xmlFirstChild(rPr, "b")) : undefined) ?? inherited.bold;
    const italic = (rPr ? isToggleOn(xmlFirstChild(rPr, "i")) : undefined) ?? inherited.italic;
    const underline = rPr ? isToggleOn(xmlFirstChild(rPr, "u")) : undefined;
    const strike = rPr
      ? (isToggleOn(xmlFirstChild(rPr, "strike")) || isToggleOn(xmlFirstChild(rPr, "dstrike")))
      : undefined;
    const highlightEl = rPr ? xmlFirstChild(rPr, "highlight") : undefined;
    const highlightVal = highlightEl ? xmlAttr(highlightEl, "val")?.toLowerCase() : undefined;
    const highlight = Boolean((highlightVal && highlightVal !== "none") || isNonWhiteShading(rPr ? xmlFirstChild(rPr, "shd") : undefined));
    const vertEl = rPr ? xmlFirstChild(rPr, "vertAlign") : undefined;
    const vertVal = vertEl ? xmlAttr(vertEl, "val")?.toLowerCase() : undefined;
    const vertAlign = vertVal === "superscript" || vertVal === "subscript" ? vertVal : undefined;
    const fontsEl = rPr ? xmlFirstChild(rPr, "rFonts") : undefined;
    const fontName = fontsEl ? (xmlAttr(fontsEl, "ascii") || xmlAttr(fontsEl, "hAnsi") || xmlAttr(fontsEl, "cs") || "") : "";
    const code = Boolean(fontName && MONO_FONT_RE.test(fontName));

    const runs: DocxInlineRun[] = [];
    let hasPageBreak = false;

    const pushText = (text: string) => {
      if (!text) return;
      const last = runs.at(-1);
      if (
        last &&
        last.kind === "text" &&
        last.bold === bold &&
        last.italic === italic &&
        last.underline === underline &&
        last.strike === strike &&
        last.code === code &&
        last.highlight === highlight &&
        last.vertAlign === vertAlign &&
        last.href === inherited.href
      ) {
        last.text += text;
        return;
      }
      runs.push({
        kind: "text",
        text,
        ...(bold ? { bold: true } : {}),
        ...(italic ? { italic: true } : {}),
        ...(underline ? { underline: true } : {}),
        ...(strike ? { strike: true } : {}),
        ...(code ? { code: true } : {}),
        ...(highlight ? { highlight: true } : {}),
        ...(vertAlign ? { vertAlign } : {}),
        ...(inherited.href ? { href: inherited.href } : {}),
      });
    };

    for (const child of xmlEffectiveChildren(runEl)) {
      const name = xmlLocalName(child);
      if (name === "instrText" || name === "delText" || name === "fldChar") continue;
      if (name === "t") {
        pushText(child.textContent ?? "");
      } else if (name === "tab") {
        pushText("    ");
      } else if (name === "br" || name === "cr") {
        const brType = xmlAttr(child, "type")?.toLowerCase();
        if (brType === "page") hasPageBreak = true;
        else runs.push({ kind: "break" });
      } else if (name === "drawing" || name === "pict") {
        const blips = xmlFindDescendants(child, "blip");
        for (const blip of blips) {
          // Only embed relationships are resolved; external r:link images are intentionally dropped.
          const embedId = xmlRelAttr(blip, "embed");
          if (!embedId) continue;
          const rel = rels.get(embedId);
          if (!rel?.resolvedPath) continue;
          const resolved = await mediaRegistry.resolveImage(archive, rel.resolvedPath, signal);
          if (!resolved) continue;
          images.push(resolved);
          const docPr = xmlFindDescendants(child, "docPr")[0];
          const alt = (docPr ? xmlAttr(docPr, "descr") || xmlAttr(docPr, "name") : undefined) || resolved.name;
          runs.push({ kind: "image", image: resolved, alt });
        }
      }
    }
    return { runs, hasPageBreak };
  };

  const parseParagraph = async (
    pEl: Element,
    insideTable = false,
  ): Promise<{ paragraph?: DocxParagraphBlock; hasPageBreak: boolean }> => {
    const pPr = xmlFirstChild(pEl, "pPr");
    const pStyleEl = pPr ? xmlFirstChild(pPr, "pStyle") : undefined;
    const styleId = pStyleEl ? xmlAttr(pStyleEl, "val") : undefined;
    const resolvedStyle = styleId ? styles.get(styleId) : undefined;

    const outlineEl = pPr ? xmlFirstChild(pPr, "outlineLvl") : undefined;
    const outlineVal = outlineEl ? Number(xmlAttr(outlineEl, "val")) : undefined;
    let role: DocxParagraphRole = resolvedStyle?.role ?? "body";
    if (role === "body" && outlineVal !== undefined && Number.isInteger(outlineVal) && outlineVal >= 0 && outlineVal <= 8) {
      role = outlineVal === 0 ? "h1" : outlineVal === 1 ? "h2" : "h3";
    }
    if (role === "body" && styleId) {
      role = roleFromStyleMeta(styleId) ?? "body";
    }

    const jcEl = pPr ? xmlFirstChild(pPr, "jc") : undefined;
    const jcVal = jcEl ? xmlAttr(jcEl, "val")?.toLowerCase() : undefined;
    const align = jcVal === "center"
      ? "center"
      : jcVal === "right" || jcVal === "end"
        ? "right"
        : resolvedStyle?.align;
    const shaded = isNonWhiteShading(pPr ? xmlFirstChild(pPr, "shd") : undefined);

    const numPr = pPr ? xmlFirstChild(pPr, "numPr") : undefined;
    const numIdEl = numPr ? xmlFirstChild(numPr, "numId") : undefined;
    const ilvlEl = numPr ? xmlFirstChild(numPr, "ilvl") : undefined;
    const numId = (numIdEl ? xmlAttr(numIdEl, "val") : undefined) ?? resolvedStyle?.numId;
    const rawLevel = ilvlEl ? Number(xmlAttr(ilvlEl, "val")) : (resolvedStyle?.ilvl ?? 0);
    let list: DocxParagraphBlock["list"];
    if (numId && numId !== "0") {
      const level = Number.isInteger(rawLevel) && rawLevel > 0 ? Math.min(rawLevel, 4) : 0;
      const ordered = numbering.get(numId)?.get(level) ?? false;
      let ordinal: number | undefined;
      if (ordered) {
        const key = `${numId}:${level}`;
        ordinal = (listCounters.get(key) ?? 0) + 1;
        listCounters.set(key, ordinal);
        for (let deeper = level + 1; deeper <= 4; deeper++) {
          listCounters.delete(`${numId}:${deeper}`);
        }
      }
      list = { ordered, level, ...(ordinal !== undefined ? { ordinal } : {}) };
    } else if (!insideTable) {
      // Reset ordered counters when leaving list blocks? Only reset on heading boundaries to preserve multi-paragraph list flows.
      if (role !== "body") listCounters.clear();
    }

    const runs: DocxInlineRun[] = [];
    let hasPageBreak = false;

    const walkInline = async (container: Element, href?: string): Promise<void> => {
      for (const child of xmlEffectiveChildren(container)) {
        const name = xmlLocalName(child);
        if (name === "pPr" || name === "del" || name === "moveFrom" || name === "bookmarkStart" || name === "bookmarkEnd" || name === "proofErr") {
          continue;
        }
        if (name === "r") {
          const parsed = await parseRun(child, {
            bold: resolvedStyle?.bold,
            italic: resolvedStyle?.italic,
            href,
          });
          if (parsed.hasPageBreak) hasPageBreak = true;
          runs.push(...parsed.runs);
        } else if (name === "hyperlink") {
          const relId = xmlRelAttr(child, "id");
          const rel: OpcRelationship | undefined = relId ? rels.get(relId) : undefined;
          const safeUrl = rel?.external ? safeOfficeExternalUrl(rel.target) : undefined;
          await walkInline(child, safeUrl ?? href);
        } else if (name === "ins" || name === "smartTag" || name === "fldSimple") {
          await walkInline(child, href);
        } else if (name === "sdt") {
          const sdtContent = xmlFirstChild(child, "sdtContent");
          if (sdtContent) await walkInline(sdtContent, href);
        }
      }
    };

    await walkInline(pEl);

    const hasMeaningfulContent = runs.some((run) =>
      run.kind === "image" || (run.kind === "text" && run.text.trim().length > 0),
    );
    if (!hasMeaningfulContent) {
      return { hasPageBreak };
    }
    return {
      paragraph: {
        kind: "paragraph",
        role,
        ...(align ? { align } : {}),
        ...(list ? { list } : {}),
        ...(shaded ? { shaded: true } : {}),
        runs,
      },
      hasPageBreak,
    };
  };

  const parseTable = async (tblEl: Element): Promise<DocxTableBlock | undefined> => {
    interface RawCell {
      paragraphs: DocxParagraphBlock[];
      colSpan: number;
      vMerge: "none" | "restart" | "continue";
      isHeader: boolean;
      shaded: boolean;
      colStart: number;
    }

    const rawRows: RawCell[][] = [];
    for (const trEl of xmlEffectiveChildren(tblEl, "tr")) {
      const trPr = xmlFirstChild(trEl, "trPr");
      const rowIsHeader = Boolean(trPr && xmlFirstChild(trPr, "tblHeader"));
      const rawRow: RawCell[] = [];
      let colCursor = 0;

      for (const tcEl of xmlEffectiveChildren(trEl, "tc")) {
        const tcPr = xmlFirstChild(tcEl, "tcPr");
        const gridSpanEl = tcPr ? xmlFirstChild(tcPr, "gridSpan") : undefined;
        const rawSpan = gridSpanEl ? Number(xmlAttr(gridSpanEl, "val")) : 1;
        const colSpan = Number.isInteger(rawSpan) && rawSpan > 1 ? Math.min(rawSpan, 50) : 1;
        const vMergeEl = tcPr ? xmlFirstChild(tcPr, "vMerge") : undefined;
        let vMerge: "none" | "restart" | "continue" = "none";
        if (vMergeEl) {
          const val = xmlAttr(vMergeEl, "val")?.toLowerCase();
          vMerge = val === "restart" ? "restart" : "continue";
        }
        const shaded = isNonWhiteShading(tcPr ? xmlFirstChild(tcPr, "shd") : undefined);

        const paragraphs: DocxParagraphBlock[] = [];
        for (const child of xmlEffectiveChildren(tcEl)) {
          if (xmlLocalName(child) === "p") {
            const parsed = await parseParagraph(child, true);
            if (parsed.paragraph) paragraphs.push(parsed.paragraph);
          }
        }
        rawRow.push({
          paragraphs,
          colSpan,
          vMerge,
          isHeader: rowIsHeader,
          shaded,
          colStart: colCursor,
        });
        colCursor += colSpan;
      }
      if (rawRow.length > 0) rawRows.push(rawRow);
    }

    if (rawRows.length === 0) return undefined;

    // Resolve vMerge rowSpans by matching logical colStart across consecutive rows.
    const outputRows: Array<Array<DocxTableCell | null>> = rawRows.map((row) =>
      row.map((cell) =>
        cell.vMerge === "continue"
          ? null
          : {
              paragraphs: cell.paragraphs,
              rowSpan: 1,
              colSpan: cell.colSpan,
              isHeader: cell.isHeader,
              ...(cell.shaded ? { shaded: true } : {}),
            },
      ),
    );

    for (let r = 0; r < rawRows.length; r++) {
      for (let i = 0; i < rawRows[r]!.length; i++) {
        const cell = rawRows[r]![i]!;
        if (cell.vMerge !== "restart") continue;
        const outCell = outputRows[r]![i];
        if (!outCell) continue;
        let span = 1;
        for (let nextR = r + 1; nextR < rawRows.length; nextR++) {
          const below = rawRows[nextR]!.find((candidate) => candidate.colStart === cell.colStart);
          if (below && below.vMerge === "continue") span++;
          else break;
        }
        outCell.rowSpan = span;
      }
    }

    return { kind: "table", rows: outputRows };
  };

  const blocks: DocxBlock[] = [];
  let truncatedBlocks = false;

  const walkBody = async (container: Element): Promise<void> => {
    for (const child of xmlEffectiveChildren(container)) {
      if (blocks.length >= MAX_DOCX_BLOCKS) {
        truncatedBlocks = true;
        return;
      }
      const name = xmlLocalName(child);
      if (name === "p") {
        const parsed = await parseParagraph(child, false);
        if (parsed.paragraph) blocks.push(parsed.paragraph);
        if (parsed.hasPageBreak && blocks.length < MAX_DOCX_BLOCKS && blocks.length > 0) {
          blocks.push({ kind: "page-break" });
        }
      } else if (name === "tbl") {
        const table = await parseTable(child);
        if (table) blocks.push(table);
      } else if (name === "sdt") {
        const sdtContent = xmlFirstChild(child, "sdtContent");
        if (sdtContent) await walkBody(sdtContent);
      }
    }
  };

  await walkBody(body);

  // Extract optional concise header/footer text from the final section properties.
  let headerText: string | undefined;
  let footerText: string | undefined;
  const sectPr = xmlFirstChild(body, "sectPr");
  if (sectPr) {
    const headerRef = xmlEffectiveChildren(sectPr, "headerReference")[0];
    const footerRef = xmlEffectiveChildren(sectPr, "footerReference")[0];
    const headerRel = headerRef ? rels.get(xmlRelAttr(headerRef, "id") ?? "") : undefined;
    const footerRel = footerRef ? rels.get(xmlRelAttr(footerRef, "id") ?? "") : undefined;
    if (headerRel?.resolvedPath) {
      headerText = extractSimplePartText(await archive.readXml(headerRel.resolvedPath, domParser, signal));
    }
    if (footerRel?.resolvedPath) {
      footerText = extractSimplePartText(await archive.readXml(footerRel.resolvedPath, domParser, signal));
    }
  }

  return {
    ...(headerText ? { headerText } : {}),
    ...(footerText ? { footerText } : {}),
    blocks,
    truncatedBlocks,
    images,
    omittedImages: Math.max(0, mediaRegistry.omittedCount - omittedBefore),
  };
}
