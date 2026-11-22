import {
  BlobUrlRegistry,
  OfficeArchive,
  OfficePreviewError,
  parseRelationships,
  xmlAttr,
  xmlEffectiveChildren,
  xmlFindDescendants,
  xmlFirstChild,
  xmlLocalName,
  xmlRelAttr,
  type OpcRelationship,
  type ResolvedOfficeImage,
} from "./office-archive";

export const MAX_PPTX_SLIDES = 200;
const MAX_GROUP_DEPTH = 8;
const Y_BUCKET_EMU = 365_760; // ~0.4 inch
const SKIPPED_PLACEHOLDERS = new Set(["sldNum", "dt", "ftr", "hdr"]);

export interface PptxDeckMeta {
  slideCount: number;
  totalSlides: number;
  truncatedSlides: boolean;
}

export interface PptxTextLine {
  text: string;
  level: number;
  bullet: boolean;
}

export interface PptxTableCell {
  text: string;
  rowSpan: number;
  colSpan: number;
}

export type PptxBlock =
  | { kind: "text"; lines: PptxTextLine[] }
  | { kind: "table"; rows: Array<Array<PptxTableCell | null>> }
  | { kind: "image"; image: ResolvedOfficeImage; alt: string }
  | { kind: "chart"; title?: string };

export interface PptxSlideData {
  number: number;
  title?: string;
  subtitle?: string;
  blocks: PptxBlock[];
  notes?: string;
  images: ResolvedOfficeImage[];
  omittedImages: number;
}

interface PositionedItem {
  role: "title" | "subtitle" | "body";
  y: number | undefined;
  x: number | undefined;
  order: number;
  block: PptxBlock;
}

function readOff(container: Element, prTag: string): { x?: number; y?: number } {
  const pr = xmlFirstChild(container, prTag);
  const xfrm = pr ? xmlFirstChild(pr, "xfrm") : undefined;
  const off = xfrm ? xmlFirstChild(xfrm, "off") : undefined;
  if (!off) return {};
  const xRaw = Number(xmlAttr(off, "x"));
  const yRaw = Number(xmlAttr(off, "y"));
  return {
    x: Number.isFinite(xRaw) ? xRaw : undefined,
    y: Number.isFinite(yRaw) ? yRaw : undefined,
  };
}

function extractParagraphText(pEl: Element): string {
  let out = "";
  for (const child of xmlEffectiveChildren(pEl)) {
    const name = xmlLocalName(child);
    if (name === "r" || name === "fld") {
      for (const tEl of xmlEffectiveChildren(child, "t")) {
        out += tEl.textContent ?? "";
      }
    } else if (name === "br") {
      out += "\n";
    }
  }
  return out;
}

function extractTxBodyLines(txBody: Element, isBodyPlaceholder: boolean): PptxTextLine[] {
  const lines: PptxTextLine[] = [];
  for (const pEl of xmlEffectiveChildren(txBody, "p")) {
    const text = extractParagraphText(pEl).trim();
    if (!text) continue;
    const pPr = xmlFirstChild(pEl, "pPr");
    const rawLevel = pPr ? Number(xmlAttr(pPr, "lvl") ?? 0) : 0;
    const level = Number.isInteger(rawLevel) && rawLevel > 0 ? Math.min(rawLevel, 4) : 0;
    const hasBuNone = pPr ? xmlFirstChild(pPr, "buNone") !== undefined : false;
    const hasExplicitBullet = pPr
      ? xmlFirstChild(pPr, "buChar") !== undefined || xmlFirstChild(pPr, "buAutoNum") !== undefined
      : false;
    const bullet = !hasBuNone && (hasExplicitBullet || (isBodyPlaceholder && level >= 0));
    lines.push({ text, level, bullet });
  }
  return lines;
}

function extractTable(tblEl: Element): Array<Array<PptxTableCell | null>> {
  const rows: Array<Array<PptxTableCell | null>> = [];
  for (const trEl of xmlEffectiveChildren(tblEl, "tr")) {
    const row: Array<PptxTableCell | null> = [];
    for (const tcEl of xmlEffectiveChildren(trEl, "tc")) {
      const hMerge = xmlAttr(tcEl, "hMerge");
      const vMerge = xmlAttr(tcEl, "vMerge");
      if (hMerge === "1" || hMerge === "true" || vMerge === "1" || vMerge === "true") {
        row.push(null);
        continue;
      }
      const rawCol = Number(xmlAttr(tcEl, "gridSpan") ?? 1);
      const rawRow = Number(xmlAttr(tcEl, "rowSpan") ?? 1);
      const colSpan = Number.isInteger(rawCol) && rawCol > 1 ? rawCol : 1;
      const rowSpan = Number.isInteger(rawRow) && rawRow > 1 ? rawRow : 1;
      const txBody = xmlFirstChild(tcEl, "txBody");
      const text = txBody
        ? xmlEffectiveChildren(txBody, "p")
            .map((p) => extractParagraphText(p).trim())
            .filter(Boolean)
            .join("\n")
        : "";
      row.push({ text, rowSpan, colSpan });
    }
    if (row.length > 0) rows.push(row);
  }
  return rows;
}

async function extractChartTitle(
  archive: OfficeArchive,
  chartPath: string,
  domParser?: DOMParser,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const doc = await archive.readXml(chartPath, domParser, signal);
    if (!doc) return undefined;
    const titles = xmlFindDescendants(doc.documentElement, "title");
    for (const titleEl of titles) {
      const parts = xmlFindDescendants(titleEl, "t")
        .map((t) => t.textContent ?? "")
        .join("")
        .trim();
      if (parts) return parts;
      const values = xmlFindDescendants(titleEl, "v")
        .map((v) => v.textContent ?? "")
        .join("")
        .trim();
      if (values) return values;
    }
  } catch {
    // Non-critical chart title failure should never block slide preview.
  }
  return undefined;
}

export class PptxDeckSession {
  readonly meta: PptxDeckMeta;
  private readonly archive: OfficeArchive;
  private readonly slidePaths: string[];
  private readonly mediaRegistry: BlobUrlRegistry;
  private readonly domParser?: DOMParser;
  private readonly slideCache = new Map<number, PptxSlideData>();

  private constructor(
    archive: OfficeArchive,
    slidePaths: string[],
    totalSlides: number,
    mediaRegistry: BlobUrlRegistry,
    domParser?: DOMParser,
  ) {
    this.archive = archive;
    this.slidePaths = slidePaths;
    this.mediaRegistry = mediaRegistry;
    this.domParser = domParser;
    this.meta = {
      slideCount: slidePaths.length,
      totalSlides,
      truncatedSlides: totalSlides > MAX_PPTX_SLIDES,
    };
  }

  static async open(
    archive: OfficeArchive,
    mediaRegistry: BlobUrlRegistry,
    domParser?: DOMParser,
    signal?: AbortSignal,
  ): Promise<PptxDeckSession> {
    const presDoc = await archive.readXml("ppt/presentation.xml", domParser, signal);
    if (!presDoc) {
      throw new OfficePreviewError("invalid_format", "未找到演示文稿内容，无法预览", false);
    }
    const rels = await parseRelationships(archive, "ppt/presentation.xml", domParser, signal);
    const sldIdLst = xmlFirstChild(presDoc.documentElement, "sldIdLst");
    const slideIdNodes = sldIdLst ? xmlEffectiveChildren(sldIdLst, "sldId") : [];

    const resolvedPaths: string[] = [];
    for (const node of slideIdNodes) {
      const relId = xmlRelAttr(node, "id");
      const rel = relId ? rels.get(relId) : undefined;
      if (rel?.resolvedPath && archive.has(rel.resolvedPath)) {
        resolvedPaths.push(rel.resolvedPath);
      }
    }
    if (resolvedPaths.length === 0) {
      throw new OfficePreviewError("invalid_format", "演示文稿中没有可预览的幻灯片", false);
    }
    return new PptxDeckSession(
      archive,
      resolvedPaths.slice(0, MAX_PPTX_SLIDES),
      resolvedPaths.length,
      mediaRegistry,
      domParser,
    );
  }

  async loadSlide(index: number, signal?: AbortSignal): Promise<PptxSlideData> {
    const cached = this.slideCache.get(index);
    if (cached) return cached;
    const slidePath = this.slidePaths[index];
    if (!slidePath) {
      throw new OfficePreviewError("invalid_format", "请求的幻灯片不存在", false);
    }

    const slideDoc = await this.archive.readXml(slidePath, this.domParser, signal);
    if (!slideDoc) {
      throw new OfficePreviewError("invalid_format", "幻灯片内容缺失，无法预览", false);
    }
    const rels = await parseRelationships(this.archive, slidePath, this.domParser, signal);
    const cSld = xmlFirstChild(slideDoc.documentElement, "cSld");
    const spTree = cSld ? xmlFirstChild(cSld, "spTree") : undefined;

    const items: PositionedItem[] = [];
    const slideImages: ResolvedOfficeImage[] = [];
    const omittedBefore = this.mediaRegistry.omittedCount;
    let orderCounter = 0;

    const collectTree = async (
      container: Element,
      depth: number,
      inheritedPos?: { x?: number; y?: number },
    ): Promise<void> => {
      if (depth > MAX_GROUP_DEPTH) return;
      for (const child of xmlEffectiveChildren(container)) {
        const name = xmlLocalName(child);
        if (name === "grpSp") {
          const groupOff = readOff(child, "grpSpPr");
          const pos = {
            x: inheritedPos?.x ?? groupOff.x,
            y: inheritedPos?.y ?? groupOff.y,
          };
          await collectTree(child, depth + 1, pos);
          continue;
        }
        if (name === "sp") {
          const nvSpPr = xmlFirstChild(child, "nvSpPr");
          const nvPr = nvSpPr ? xmlFirstChild(nvSpPr, "nvPr") : undefined;
          const ph = nvPr ? xmlFirstChild(nvPr, "ph") : undefined;
          const phType = ph ? (xmlAttr(ph, "type") ?? "body") : undefined;
          if (phType && SKIPPED_PLACEHOLDERS.has(phType)) continue;

          const txBody = xmlFirstChild(child, "txBody");
          if (!txBody) continue;
          const isTitle = phType === "title" || phType === "ctrTitle";
          const isSubtitle = phType === "subTitle";
          const lines = extractTxBodyLines(txBody, !isTitle && !isSubtitle && phType === "body");
          if (lines.length === 0) continue;

          const off = readOff(child, "spPr");
          items.push({
            role: isTitle ? "title" : isSubtitle ? "subtitle" : "body",
            x: inheritedPos?.x ?? off.x,
            y: inheritedPos?.y ?? off.y,
            order: orderCounter++,
            block: { kind: "text", lines },
          });
          continue;
        }
        if (name === "pic") {
          const nvPicPr = xmlFirstChild(child, "nvPicPr");
          const cNvPr = nvPicPr ? xmlFirstChild(nvPicPr, "cNvPr") : undefined;
          const alt = xmlAttr(cNvPr ?? child, "descr") || xmlAttr(cNvPr ?? child, "name") || "幻灯片图片";
          const blipFill = xmlFirstChild(child, "blipFill");
          const blip = blipFill ? xmlFirstChild(blipFill, "blip") : undefined;
          const embedId = blip ? xmlRelAttr(blip, "embed") : undefined;
          if (!embedId) continue;
          const rel = rels.get(embedId);
          if (!rel?.resolvedPath) continue;
          const resolved = await this.mediaRegistry.resolveImage(this.archive, rel.resolvedPath, signal);
          if (!resolved) continue;
          slideImages.push(resolved);
          const off = readOff(child, "spPr");
          items.push({
            role: "body",
            x: inheritedPos?.x ?? off.x,
            y: inheritedPos?.y ?? off.y,
            order: orderCounter++,
            block: { kind: "image", image: resolved, alt },
          });
          continue;
        }
        if (name === "graphicFrame") {
          const off = readOff(child, "xfrm") ;
          const directXfrm = xmlFirstChild(child, "xfrm");
          const directOff = directXfrm ? xmlFirstChild(directXfrm, "off") : undefined;
          const xVal = directOff ? Number(xmlAttr(directOff, "x")) : off.x;
          const yVal = directOff ? Number(xmlAttr(directOff, "y")) : off.y;
          const pos = {
            x: inheritedPos?.x ?? (Number.isFinite(xVal) ? xVal : undefined),
            y: inheritedPos?.y ?? (Number.isFinite(yVal) ? yVal : undefined),
          };
          const graphic = xmlFirstChild(child, "graphic");
          const graphicData = graphic ? xmlFirstChild(graphic, "graphicData") : undefined;
          if (!graphicData) continue;

          const tblEl = xmlFirstChild(graphicData, "tbl");
          if (tblEl) {
            const rows = extractTable(tblEl);
            if (rows.length > 0) {
              items.push({
                role: "body",
                x: pos.x,
                y: pos.y,
                order: orderCounter++,
                block: { kind: "table", rows },
              });
            }
            continue;
          }

          const chartEl = xmlFirstChild(graphicData, "chart");
          if (chartEl) {
            const chartRelId = xmlRelAttr(chartEl, "id");
            const chartRel = chartRelId ? rels.get(chartRelId) : undefined;
            const title = chartRel?.resolvedPath
              ? await extractChartTitle(this.archive, chartRel.resolvedPath, this.domParser, signal)
              : undefined;
            items.push({
              role: "body",
              x: pos.x,
              y: pos.y,
              order: orderCounter++,
              block: { kind: "chart", ...(title ? { title } : {}) },
            });
          }
        }
      }
    };

    if (spTree) await collectTree(spTree, 0);

    let title: string | undefined;
    let subtitle: string | undefined;
    const bodyItems: PositionedItem[] = [];
    for (const item of items) {
      if (item.role === "title" && !title && item.block.kind === "text") {
        title = item.block.lines.map((line) => line.text).join(" ");
        continue;
      }
      if (item.role === "subtitle" && !subtitle && item.block.kind === "text") {
        subtitle = item.block.lines.map((line) => line.text).join("\n");
        continue;
      }
      bodyItems.push(item);
    }

    // Spatial reading-order sort: row-bucket by y (~0.4 in), left-to-right by x, document order fallback.
    bodyItems.sort((a, b) => {
      const aHasY = a.y !== undefined;
      const bHasY = b.y !== undefined;
      if (aHasY && bHasY) {
        const ya = Math.floor(a.y! / Y_BUCKET_EMU);
        const yb = Math.floor(b.y! / Y_BUCKET_EMU);
        if (ya !== yb) return ya - yb;
        const xa = a.x ?? Number.MAX_SAFE_INTEGER;
        const xb = b.x ?? Number.MAX_SAFE_INTEGER;
        if (xa !== xb) return xa - xb;
      } else if (aHasY !== bHasY) {
        return aHasY ? -1 : 1;
      }
      return a.order - b.order;
    });

    const notes = await this.loadNotes(rels, signal);
    const data: PptxSlideData = {
      number: index + 1,
      ...(title ? { title } : {}),
      ...(subtitle ? { subtitle } : {}),
      blocks: bodyItems.map((item) => item.block),
      ...(notes ? { notes } : {}),
      images: slideImages,
      omittedImages: Math.max(0, this.mediaRegistry.omittedCount - omittedBefore),
    };
    this.slideCache.set(index, data);
    return data;
  }

  private async loadNotes(
    slideRels: Map<string, OpcRelationship>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const notesRel = [...slideRels.values()].find(
      (rel) => !rel.external && rel.resolvedPath && /\/notesSlide$/i.test(rel.type),
    );
    if (!notesRel?.resolvedPath) return undefined;
    try {
      const doc = await this.archive.readXml(notesRel.resolvedPath, this.domParser, signal);
      if (!doc) return undefined;
      const cSld = xmlFirstChild(doc.documentElement, "cSld");
      const spTree = cSld ? xmlFirstChild(cSld, "spTree") : undefined;
      if (!spTree) return undefined;
      const paragraphs: string[] = [];
      for (const sp of xmlEffectiveChildren(spTree, "sp")) {
        const nvSpPr = xmlFirstChild(sp, "nvSpPr");
        const nvPr = nvSpPr ? xmlFirstChild(nvSpPr, "nvPr") : undefined;
        const ph = nvPr ? xmlFirstChild(nvPr, "ph") : undefined;
        const phType = ph ? xmlAttr(ph, "type") : undefined;
        if (phType && SKIPPED_PLACEHOLDERS.has(phType)) continue;
        const txBody = xmlFirstChild(sp, "txBody");
        if (!txBody) continue;
        for (const p of xmlEffectiveChildren(txBody, "p")) {
          const text = extractParagraphText(p).trim();
          if (text) paragraphs.push(text);
        }
      }
      const joined = paragraphs.join("\n").trim();
      return joined || undefined;
    } catch {
      return undefined;
    }
  }
}
