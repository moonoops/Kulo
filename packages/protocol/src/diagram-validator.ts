/**
 * Zero-dependency strict XML SVG security sanitizer, silent auto-fixer, and geometry checker.
 * Shared across @kulo/protocol, @kulo/hub, and standalone Worker check-diagram.mjs.
 */

export type DiagramMotionMode = "none" | "reveal" | "step";

export interface DiagramIssue {
  level: "L1" | "L2" | "L3";
  code: string;
  message: string;
}

export interface DiagramValidationOptions {
  title?: string;
  description?: string;
  motion?: DiagramMotionMode;
  allowGeometryWarnings?: boolean;
  strict?: boolean;
}

export interface DiagramValidationResult {
  ok: boolean;
  svg?: string;
  width?: number;
  height?: number;
  viewBox?: [number, number, number, number];
  autoFixed: string[];
  errors: DiagramIssue[];
  warnings: DiagramIssue[];
  stats: {
    elements: number;
    nodes: number;
    connectors: number;
    motionItems: number;
  };
}

export const DIAGRAM_LIMITS = {
  maxBytes: 192 * 1024,
  maxElements: 1200,
  maxDepth: 16,
  minWidth: 240,
  maxWidth: 2400,
  minHeight: 120,
  maxHeight: 2400,
  maxMotionItems: 16,
  maxMotionStep: 8,
  silentOverflowMaxPx: 48,
  silentPaddingPx: 12,
  budgetNodes: 9,
  budgetConnectors: 12,
} as const;

const ALLOWED_TAGS = new Set([
  "svg", "g", "defs", "symbol", "use", "marker", "clipPath", "mask", "pattern",
  "linearGradient", "radialGradient", "stop",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "title", "desc", "style",
  "filter", "feDropShadow", "feGaussianBlur", "feOffset", "feBlend",
  "feColorMatrix", "feMerge", "feMergeNode", "feFlood", "feComposite",
]);

const NON_PAINTED_CONTAINERS = new Set(["defs", "marker", "clipPath", "mask", "pattern", "symbol", "filter"]);
const FORBIDDEN_ATTRS = new Set(["src", "action", "formaction", "ping", "srcdoc", "srcset", "poster", "data"]);
const PAINT_REF_ATTRS = new Set([
  "fill", "stroke", "clip-path", "mask", "filter",
  "marker", "marker-start", "marker-mid", "marker-end", "cursor",
]);
const HREF_ALLOWED_TAGS = new Set(["use", "linearGradient", "radialGradient", "pattern", "textPath"]);
const INTERNAL_ID_REF_RE = /^#[A-Za-z_][A-Za-z0-9_.-]*$/;
const SAFE_ATTR_NAME_RE = /^[A-Za-z_][A-Za-z0-9:._-]*$/;
const REMOTE_OR_SCHEME_RE = /(?:javascript|vbscript|file|filesystem|blob|http|https)\s*:|\/\//i;
const FORBIDDEN_CSS_RE = /\\|<\/|<!|@import\b|@charset\b|@font-face\b|expression\s*\(|-moz-binding\b|behavior\s*:/i;
const FORBIDDEN_CSS_SELECTOR_RE = /(?:^|[,\s>+~(])(?:html|body|\*|:root|#kulo-diagram-[a-z0-9_-]*|\.kulo-diagram-[a-z0-9_-]*|\[data-motion-controls\])(?=$|[\s,{.#[:>+~])/i;

interface XmlTextNode { kind: "text"; value: string }
interface XmlElementNode {
  kind: "element";
  tag: string;
  attrs: Map<string, string>;
  children: XmlNode[];
}
type XmlNode = XmlElementNode | XmlTextNode;

interface Transform2D {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  rotated: boolean;
}

const IDENTITY_TRANSFORM: Transform2D = { sx: 1, sy: 1, tx: 0, ty: 0, rotated: false };

function decodeXmlEntities(raw: string): string | null {
  let valid = true;
  const decoded = raw.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z]+));/g, (match, hex, dec, named) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) { valid = false; return ""; }
      return String.fromCodePoint(code);
    }
    if (dec) {
      const code = Number.parseInt(dec, 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) { valid = false; return ""; }
      return String.fromCodePoint(code);
    }
    switch (named) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      default: valid = false; return match;
    }
  });
  return valid ? decoded : null;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function parseStrictXmlSvg(source: string): { root?: XmlElementNode; error?: string } {
  let input = source.replace(/^\uFEFF/, "");
  let pos = 0;
  const len = input.length;

  const skipWs = () => {
    while (pos < len && /\s/.test(input[pos]!)) pos++;
  };

  skipWs();
  if (input.startsWith("<?xml", pos)) {
    const end = input.indexOf("?>", pos + 5);
    if (end < 0) return { error: "XML 声明未闭合。" };
    pos = end + 2;
  }

  const stack: XmlElementNode[] = [];
  let root: XmlElementNode | undefined;
  let elementCount = 0;

  while (pos < len) {
    if (input[pos] !== "<") {
      const next = input.indexOf("<", pos);
      const rawText = next < 0 ? input.slice(pos) : input.slice(pos, next);
      pos = next < 0 ? len : next;
      if (!stack.length) {
        if (rawText.trim()) return { error: "SVG 根节点外存在非法文本。" };
        continue;
      }
      const decoded = decodeXmlEntities(rawText);
      if (decoded === null) return { error: "SVG 包含无效 XML 字符实体。" };
      stack.at(-1)!.children.push({ kind: "text", value: decoded });
      continue;
    }

    if (input.startsWith("<!--", pos)) {
      const end = input.indexOf("-->", pos + 4);
      if (end < 0) return { error: "SVG 注释未闭合。" };
      pos = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", pos)) return { error: "SVG 不允许包含 CDATA 区块。" };
    if (input.startsWith("<!", pos)) return { error: "SVG 不允许包含 DOCTYPE 或 ENTITY 声明。" };
    if (input.startsWith("<?", pos)) return { error: "SVG 不允许包含处理指令。" };

    if (input.startsWith("</", pos)) {
      pos += 2;
      const start = pos;
      while (pos < len && /[A-Za-z0-9:._-]/.test(input[pos]!)) pos++;
      const tag = input.slice(start, pos);
      skipWs();
      if (!tag || input[pos] !== ">") return { error: `闭合标签 </${tag || "?"}> 语法无效。` };
      pos++;
      const current = stack.pop();
      if (!current || current.tag !== tag) {
        return { error: `XML 标签不匹配：期望 </${current?.tag ?? "无"}>，实际 </${tag}>。` };
      }
      continue;
    }

    // Opening tag
    pos++;
    const tagStart = pos;
    while (pos < len && /[A-Za-z0-9:._-]/.test(input[pos]!)) pos++;
    const tag = input.slice(tagStart, pos);
    if (!tag || !/^[A-Za-z_][A-Za-z0-9:._-]*$/.test(tag)) return { error: "SVG 标签名语法无效。" };
    if (root && !stack.length) return { error: "只允许单一根 <svg> 元素。" };

    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (pos < len) {
      skipWs();
      if (input.startsWith("/>", pos)) { selfClosing = true; pos += 2; break; }
      if (input[pos] === ">") { pos++; break; }
      const nameStart = pos;
      while (pos < len && /[A-Za-z0-9:._-]/.test(input[pos]!)) pos++;
      const attrName = input.slice(nameStart, pos);
      if (!attrName || !SAFE_ATTR_NAME_RE.test(attrName)) return { error: `标签 <${tag}> 包含非法属性名。` };
      skipWs();
      if (input[pos] !== "=") return { error: `标签 <${tag}> 属性 ${attrName} 缺少等号或引号。` };
      pos++;
      skipWs();
      const quote = input[pos];
      if (quote !== "\"" && quote !== "'") return { error: `标签 <${tag}> 属性 ${attrName} 必须使用引号包裹。` };
      pos++;
      const valStart = pos;
      const valEnd = input.indexOf(quote, valStart);
      if (valEnd < 0) return { error: `标签 <${tag}> 属性 ${attrName} 引号未闭合。` };
      const rawVal = input.slice(valStart, valEnd);
      if (rawVal.includes("<")) return { error: `标签 <${tag}> 属性 ${attrName} 不允许包含 "<"。` };
      const decodedVal = decodeXmlEntities(rawVal);
      if (decodedVal === null) return { error: `标签 <${tag}> 属性 ${attrName} 包含无效 XML 实体。` };
      if (attrs.has(attrName)) return { error: `标签 <${tag}> 存在重复属性 ${attrName}。` };
      attrs.set(attrName, decodedVal);
      pos = valEnd + 1;
    }

    elementCount++;
    if (elementCount > DIAGRAM_LIMITS.maxElements) {
      return { error: `SVG 元素数量超过上限（最多 ${DIAGRAM_LIMITS.maxElements} 个）。` };
    }
    if (stack.length + 1 > DIAGRAM_LIMITS.maxDepth) {
      return { error: `SVG 嵌套深度超过上限（最多 ${DIAGRAM_LIMITS.maxDepth} 层）。` };
    }

    const node: XmlElementNode = { kind: "element", tag, attrs, children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    if (!selfClosing) stack.push(node);
  }

  if (stack.length) return { error: `SVG 标签 <${stack.at(-1)!.tag}> 未闭合。` };
  if (!root || root.tag !== "svg") return { error: "根元素必须为严格 XML 格式的 <svg>。" };
  return { root };
}

function serializeXml(node: XmlNode): string {
  if (node.kind === "text") return escapeXmlText(node.value);
  const attrParts: string[] = [];
  for (const [key, value] of node.attrs) {
    attrParts.push(`${key}="${escapeXmlAttr(value)}"`);
  }
  const open = attrParts.length ? `<${node.tag} ${attrParts.join(" ")}` : `<${node.tag}`;
  if (!node.children.length) return `${open}/>`;
  return `${open}>${node.children.map(serializeXml).join("")}</${node.tag}>`;
}

function textContentOf(node: XmlElementNode): string {
  let out = "";
  for (const child of node.children) {
    out += child.kind === "text" ? child.value : textContentOf(child);
  }
  return out;
}

function parseViewBox(raw: string | undefined): [number, number, number, number] | null {
  if (!raw) return null;
  const nums = raw.trim().split(/[\s,]+/).map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  const [minX, minY, w, h] = nums as [number, number, number, number];
  if (w < DIAGRAM_LIMITS.minWidth || w > DIAGRAM_LIMITS.maxWidth || h < DIAGRAM_LIMITS.minHeight || h > DIAGRAM_LIMITS.maxHeight) {
    return null;
  }
  return [minX, minY, w, h];
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.endsWith("%")) return undefined;
  const num = Number.parseFloat(trimmed);
  return Number.isFinite(num) ? num : undefined;
}

function parseTransform(raw: string | undefined, parent: Transform2D): Transform2D {
  if (!raw?.trim()) return parent;
  let current: Transform2D = { ...parent };
  const ops = raw.matchAll(/([A-Za-z]+)\s*\(([^)]*)\)/g);
  for (const match of ops) {
    const fn = match[1]!;
    const nums = match[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) { current.rotated = true; continue; }
    if (fn === "translate") {
      const dx = nums[0] ?? 0;
      const dy = nums[1] ?? 0;
      current = { ...current, tx: current.tx + current.sx * dx, ty: current.ty + current.sy * dy };
    } else if (fn === "scale") {
      const sx = nums[0] ?? 1;
      const sy = nums[1] ?? sx;
      current = { ...current, sx: current.sx * sx, sy: current.sy * sy };
    } else if (fn === "matrix" && nums.length === 6) {
      const [a, b, c, d, e, f] = nums as [number, number, number, number, number, number];
      if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) {
        current.rotated = true;
      } else {
        current = {
          sx: current.sx * a,
          sy: current.sy * d,
          tx: current.tx + current.sx * e,
          ty: current.ty + current.sy * f,
          rotated: current.rotated,
        };
      }
    } else {
      current.rotated = true;
    }
  }
  return current;
}

function applyPoint(t: Transform2D, x: number, y: number): [number, number] {
  return [t.tx + t.sx * x, t.ty + t.sy * y];
}

function applyRect(t: Transform2D, x: number, y: number, w: number, h: number) {
  const [x1, y1] = applyPoint(t, x, y);
  const [x2, y2] = applyPoint(t, x + w, y + h);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

interface PathSegment { x1: number; y1: number; x2: number; y2: number; straight: boolean }

function parsePathGeometry(d: string, t: Transform2D): { points: Array<[number, number]>; segments: PathSegment[] } {
  const tokens = d.match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const points: Array<[number, number]> = [];
  const segments: PathSegment[] = [];
  let i = 0;
  let cmd = "";
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const readNum = () => Number.parseFloat(tokens[i++] ?? "NaN");
  const pushPoint = (x: number, y: number) => {
    if (Number.isFinite(x) && Number.isFinite(y)) points.push(applyPoint(t, x, y));
  };
  const pushLine = (x1: number, y1: number, x2: number, y2: number, straight: boolean) => {
    const [ax, ay] = applyPoint(t, x1, y1);
    const [bx, by] = applyPoint(t, x2, y2);
    if (Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by)) {
      segments.push({ x1: ax, y1: ay, x2: bx, y2: by, straight });
    }
  };

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i]!)) {
      cmd = tokens[i++]!;
      if (cmd === "Z" || cmd === "z") {
        pushLine(cx, cy, sx, sy, true);
        cx = sx; cy = sy;
        continue;
      }
    }
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();
    if (upper === "M" || upper === "L" || upper === "T") {
      const x = readNum(), y = readNum();
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      if (upper === "M") { sx = nx; sy = ny; cmd = rel ? "l" : "L"; }
      else if (upper === "L") pushLine(cx, cy, nx, ny, true);
      else pushLine(cx, cy, nx, ny, false);
      cx = nx; cy = ny;
      pushPoint(cx, cy);
    } else if (upper === "H") {
      const x = readNum();
      if (!Number.isFinite(x)) break;
      const nx = rel ? cx + x : x;
      pushLine(cx, cy, nx, cy, true);
      cx = nx;
      pushPoint(cx, cy);
    } else if (upper === "V") {
      const y = readNum();
      if (!Number.isFinite(y)) break;
      const ny = rel ? cy + y : y;
      pushLine(cx, cy, cx, ny, true);
      cy = ny;
      pushPoint(cx, cy);
    } else if (upper === "C") {
      const x1 = readNum(), y1 = readNum(), x2 = readNum(), y2 = readNum(), x = readNum(), y = readNum();
      if (!Number.isFinite(y)) break;
      const nx = rel ? cx + x : x, ny = rel ? cy + y : y;
      pushPoint(rel ? cx + x1 : x1, rel ? cy + y1 : y1);
      pushPoint(rel ? cx + x2 : x2, rel ? cy + y2 : y2);
      pushPoint(nx, ny);
      pushLine(cx, cy, nx, ny, false);
      cx = nx; cy = ny;
    } else if (upper === "S" || upper === "Q") {
      const x1 = readNum(), y1 = readNum(), x = readNum(), y = readNum();
      if (!Number.isFinite(y)) break;
      const nx = rel ? cx + x : x, ny = rel ? cy + y : y;
      pushPoint(rel ? cx + x1 : x1, rel ? cy + y1 : y1);
      pushPoint(nx, ny);
      pushLine(cx, cy, nx, ny, false);
      cx = nx; cy = ny;
    } else if (upper === "A") {
      const rx = readNum(), ry = readNum(), _rot = readNum(), _large = readNum(), _sweep = readNum(), x = readNum(), y = readNum();
      if (!Number.isFinite(y) || !Number.isFinite(rx) || !Number.isFinite(ry)) break;
      const nx = rel ? cx + x : x, ny = rel ? cy + y : y;
      pushPoint(nx, ny);
      pushLine(cx, cy, nx, ny, false);
      cx = nx; cy = ny;
    } else {
      break;
    }
  }
  return { points, segments };
}

function estimateGlyphWidth(text: string, fontSize: number, isMono: boolean): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff01 && code <= 0xff60)
    ) {
      width += fontSize * 1.0;
    } else if (isMono) {
      width += fontSize * 0.64;
    } else if (ch === " ") {
      width += fontSize * 0.3;
    } else if (/[A-ZMW@]/.test(ch)) {
      width += fontSize * 0.68;
    } else if (/[ilI1.,:;|!']/.test(ch)) {
      width += fontSize * 0.32;
    } else {
      width += fontSize * 0.56;
    }
  }
  return width;
}

function estimateTextLines(el: XmlElementNode, defaultFontSize: number, isMono: boolean): string[] {
  const tspans = el.children.filter((c): c is XmlElementNode => c.kind === "element" && c.tag === "tspan");
  if (!tspans.length) {
    const text = textContentOf(el).trim();
    return text ? [text] : [];
  }
  const lines: string[] = [];
  let current = "";
  for (const child of el.children) {
    if (child.kind === "text") {
      current += child.value;
    } else if (child.tag === "tspan") {
      const dy = parseNumber(child.attrs.get("dy"));
      const hasX = child.attrs.has("x");
      const content = textContentOf(child);
      if ((hasX || (dy !== undefined && Math.abs(dy) >= defaultFontSize * 0.4)) && current.trim()) {
        lines.push(current.trim());
        current = content;
      } else {
        current += content;
      }
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

function validateCssBlock(css: string, definedIds: Set<string>, isStylesheet: boolean, errors: DiagramIssue[]): void {
  if (FORBIDDEN_CSS_RE.test(css) || REMOTE_OR_SCHEME_RE.test(css)) {
    errors.push({ level: "L1", code: "unsafe_css", message: "SVG 样式包含禁止的转义、@import、外链或危险表达式。" });
    return;
  }
  if (isStylesheet) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, " ");
    const selectors = withoutComments.replace(/\{[^}]*\}/g, "\n");
    if (FORBIDDEN_CSS_SELECTOR_RE.test(selectors)) {
      errors.push({ level: "L1", code: "unsafe_css_selector", message: "SVG 内嵌 <style> 不允许覆盖 html、body、*、:root 或 Kulo 容器样式。" });
    }
  }
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi)) {
    const ref = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!INTERNAL_ID_REF_RE.test(ref) || !definedIds.has(ref.slice(1))) {
      errors.push({ level: "L1", code: "unsafe_css_url", message: `SVG 样式中的 url(${ref}) 必须指向本文档内已定义的 #id。` });
    }
  }
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w - 1 && a.x + a.w > b.x + 1 && a.y < b.y + b.h - 1 && a.y + a.h > b.y + 1;
}

function rectContains(outer: { x: number; y: number; w: number; h: number }, inner: { x: number; y: number; w: number; h: number }, pad = 2): boolean {
  return inner.x >= outer.x - pad && inner.y >= outer.y - pad &&
    inner.x + inner.w <= outer.x + outer.w + pad && inner.y + inner.h <= outer.y + outer.h + pad;
}

function slugifyIdPrefix(title: string | undefined): string {
  const ascii = (title ?? "diagram").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return `d-${ascii || "figure"}`;
}

export function validateAndNormalizeDiagramSvg(rawSvg: string, options: DiagramValidationOptions = {}): DiagramValidationResult {
  const errors: DiagramIssue[] = [];
  const warnings: DiagramIssue[] = [];
  const autoFixed: string[] = [];
  const stats = { elements: 0, nodes: 0, connectors: 0, motionItems: 0 };

  if (typeof rawSvg !== "string" || !rawSvg.trim()) {
    return { ok: false, autoFixed, errors: [{ level: "L1", code: "empty_svg", message: "SVG 内容不能为空。" }], warnings, stats };
  }
  const byteLength = new TextEncoder().encode(rawSvg).byteLength;
  if (byteLength > DIAGRAM_LIMITS.maxBytes) {
    return {
      ok: false, autoFixed,
      errors: [{ level: "L1", code: "svg_too_large", message: `SVG 体积 ${byteLength} 字节超出上限（最大 ${DIAGRAM_LIMITS.maxBytes} 字节）。` }],
      warnings, stats,
    };
  }

  const parsed = parseStrictXmlSvg(rawSvg);
  if (!parsed.root) {
    return { ok: false, autoFixed, errors: [{ level: "L1", code: "invalid_xml", message: parsed.error ?? "SVG XML 格式无效。" }], warnings, stats };
  }
  const root = parsed.root;
  const viewBox = parseViewBox(root.attrs.get("viewBox"));
  if (!viewBox) {
    return {
      ok: false, autoFixed,
      errors: [{ level: "L1", code: "invalid_viewbox", message: `根 <svg> 必须声明有效 viewBox="minX minY W H"（宽 ${DIAGRAM_LIMITS.minWidth}–${DIAGRAM_LIMITS.maxWidth}，高 ${DIAGRAM_LIMITS.minHeight}–${DIAGRAM_LIMITS.maxHeight}）。` }],
      warnings, stats,
    };
  }

  // Pass 1: collect defined IDs & count elements + L1 tag/attribute/CSS whitelist checks
  const definedIds = new Set<string>();
  const collectIds = (el: XmlElementNode) => {
    stats.elements++;
    const id = el.attrs.get("id")?.trim();
    if (id) {
      if (id.startsWith("kulo-diagram-")) {
        errors.push({ level: "L1", code: "reserved_id", message: `ID "${id}" 使用了保留前缀 kulo-diagram-。` });
      }
      definedIds.add(id);
    }
    for (const child of el.children) if (child.kind === "element") collectIds(child);
  };
  collectIds(root);

  const motionMode: DiagramMotionMode = options.motion ?? "none";
  let usesThemeVars = false;
  let hasHardcodedColors = false;

  const sanitizeTree = (el: XmlElementNode) => {
    if (!ALLOWED_TAGS.has(el.tag)) {
      errors.push({ level: "L1", code: "disallowed_tag", message: `SVG 不允许使用 <${el.tag}> 元素。` });
      return;
    }

    if (el.tag === "title" || el.tag === "desc") {
      if (el.children.some((c) => c.kind === "element")) {
        errors.push({ level: "L1", code: "unsafe_metadata_children", message: `<${el.tag}> 内只能包含纯文本，不允许嵌套任何子标签。` });
        return;
      }
      const clean = textContentOf(el).replace(/[<>]/g, "").trim();
      el.children = clean ? [{ kind: "text", value: clean }] : [];
    }

    if (el.tag === "style") {
      if (el.children.some((c) => c.kind === "element")) {
        errors.push({ level: "L1", code: "unsafe_style_children", message: "<style> 内不能嵌套子标签。" });
        return;
      }
      const css = textContentOf(el);
      if (css.includes("var(--d-")) usesThemeVars = true;
      validateCssBlock(css, definedIds, true, errors);
    }

    const normalizedAttrs = new Map<string, string>();
    for (const [rawKey, val] of el.attrs) {
      const lower = rawKey.toLowerCase();
      if (lower.startsWith("on") || FORBIDDEN_ATTRS.has(lower)) {
        errors.push({ level: "L1", code: "unsafe_attribute", message: `元素 <${el.tag}> 不允许使用属性 ${rawKey}。` });
        continue;
      }
      if (lower === "xmlns:xlink") continue;
      if (lower === "xlink:href" || lower === "href") {
        if (!HREF_ALLOWED_TAGS.has(el.tag)) {
          errors.push({ level: "L1", code: "disallowed_href", message: `元素 <${el.tag}> 不允许携带 ${rawKey} 引用。` });
          continue;
        }
        const trimmed = val.trim();
        if (!INTERNAL_ID_REF_RE.test(trimmed) || !definedIds.has(trimmed.slice(1))) {
          errors.push({ level: "L1", code: "unsafe_href", message: `<${el.tag} ${rawKey}="${trimmed}"> 必须引用本文档内已定义的 #id。` });
          continue;
        }
        normalizedAttrs.set("href", trimmed);
        continue;
      }
      if (lower.startsWith("xlink:")) {
        errors.push({ level: "L1", code: "unsafe_xlink", message: `不支持的属性 ${rawKey}。` });
        continue;
      }
      if (lower === "style") {
        if (val.includes("var(--d-")) usesThemeVars = true;
        validateCssBlock(val, definedIds, false, errors);
        normalizedAttrs.set("style", val);
        continue;
      }
      if (PAINT_REF_ATTRS.has(lower)) {
        if (val.includes("var(--d-")) usesThemeVars = true;
        if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(val) && !val.includes("var(--d-")) hasHardcodedColors = true;
        if (REMOTE_OR_SCHEME_RE.test(val) || val.includes("\\")) {
          errors.push({ level: "L1", code: "unsafe_paint_ref", message: `属性 ${rawKey} 包含禁止的外链或转义。` });
          continue;
        }
        for (const match of val.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi)) {
          const ref = (match[1] ?? match[2] ?? match[3] ?? "").trim();
          if (!INTERNAL_ID_REF_RE.test(ref) || !definedIds.has(ref.slice(1))) {
            errors.push({ level: "L1", code: "unsafe_paint_url", message: `属性 ${rawKey} 中的 url(${ref}) 必须指向本文档内已定义的 #id。` });
          }
        }
      } else if (REMOTE_OR_SCHEME_RE.test(val) && !["title", "desc", "aria-label"].includes(lower)) {
        errors.push({ level: "L1", code: "unsafe_url_value", message: `属性 ${rawKey} 不允许包含外部链接或脚本协议。` });
        continue;
      }
      normalizedAttrs.set(rawKey, val);
    }

    if (motionMode !== "none" && normalizedAttrs.has("data-step") && !normalizedAttrs.has("data-motion-item")) {
      normalizedAttrs.set("data-motion-item", "true");
    }
    if (normalizedAttrs.has("data-motion-item")) {
      stats.motionItems++;
      const stepRaw = normalizedAttrs.get("data-step");
      const step = stepRaw ? Number(stepRaw) : NaN;
      if (motionMode !== "none" && (!Number.isInteger(step) || step < 1 || step > DIAGRAM_LIMITS.maxMotionStep)) {
        errors.push({ level: "L1", code: "invalid_motion_step", message: `data-motion-item 必须携带 1–${DIAGRAM_LIMITS.maxMotionStep} 的整数 data-step。` });
      }
    }

    el.attrs = normalizedAttrs;
    for (const child of el.children) if (child.kind === "element") sanitizeTree(child);
  };
  sanitizeTree(root);

  if (motionMode !== "none" && stats.motionItems > DIAGRAM_LIMITS.maxMotionItems) {
    errors.push({ level: "L1", code: "too_many_motion_items", message: `分步动画标记数量超出上限（最多 ${DIAGRAM_LIMITS.maxMotionItems} 个）。` });
  }
  if (errors.length) {
    return { ok: false, autoFixed, errors, warnings, stats };
  }

  // Pass 2: Geometry & bounds extraction with 2D affine transforms
  const [vbX, vbY, vbW, vbH] = viewBox;
  let minPaintedX = Infinity, minPaintedY = Infinity, maxPaintedX = -Infinity, maxPaintedY = -Infinity;
  const includeBounds = (x1: number, y1: number, x2: number, y2: number) => {
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return;
    if (x1 < minPaintedX) minPaintedX = x1;
    if (y1 < minPaintedY) minPaintedY = y1;
    if (x2 > maxPaintedX) maxPaintedX = x2;
    if (y2 > maxPaintedY) maxPaintedY = y2;
  };

  interface PaintRect { index: number; x: number; y: number; w: number; h: number; stroked: boolean; rotated: boolean }
  interface PaintText { el: XmlElementNode; x: number; y: number; lines: string[]; fontSize: number; isMono: boolean; rotated: boolean }
  const nodeRects: PaintRect[] = [];
  const maskRects: PaintRect[] = [];
  const paintTexts: PaintText[] = [];
  const straightConnectorSegments: Array<{ seg: PathSegment; radial: boolean }> = [];
  let paintOrder = 0;

  const isBackgroundRect = (r: { x: number; y: number; w: number; h: number }, rawW?: string, rawH?: string): boolean => {
    if (rawW === "100%" || rawH === "100%") return true;
    return Math.abs(r.x - vbX) <= 2 && Math.abs(r.y - vbY) <= 2 && Math.abs(r.w - vbW) <= 4 && Math.abs(r.h - vbH) <= 4;
  };

  const walkGeometry = (el: XmlElementNode, parentTransform: Transform2D, inDefs: boolean) => {
    const nextInDefs = inDefs || NON_PAINTED_CONTAINERS.has(el.tag);
    const t = parseTransform(el.attrs.get("transform"), parentTransform);

    if (!nextInDefs) {
      const order = paintOrder++;
      const hasArrowMarker = Boolean(el.attrs.get("marker-end") || el.attrs.get("marker-start"));
      const isRadial = el.attrs.get("data-radial") === "true" || el.attrs.get("class")?.includes("spoke");

      if (el.tag === "rect") {
        const rawW = el.attrs.get("width");
        const rawH = el.attrs.get("height");
        const w = parseNumber(rawW);
        const h = parseNumber(rawH);
        const x = parseNumber(el.attrs.get("x")) ?? 0;
        const y = parseNumber(el.attrs.get("y")) ?? 0;
        if (w !== undefined && h !== undefined && w > 0 && h > 0) {
          const box = applyRect(t, x, y, w, h);
          if (!isBackgroundRect(box, rawW, rawH)) {
            if (!t.rotated) includeBounds(box.x, box.y, box.x + box.w, box.y + box.h);
            const stroke = el.attrs.get("stroke");
            const stroked = Boolean(stroke && stroke !== "none");
            if (box.w >= 60 && box.h >= 40) {
              nodeRects.push({ index: order, ...box, stroked, rotated: t.rotated });
              if (stroked) stats.nodes++;
            } else if (!stroked && box.w >= 20 && box.w <= 220 && box.h >= 8 && box.h <= 22) {
              maskRects.push({ index: order, ...box, stroked: false, rotated: t.rotated });
            }
          }
        }
      } else if (el.tag === "circle") {
        const cx = parseNumber(el.attrs.get("cx")) ?? 0;
        const cy = parseNumber(el.attrs.get("cy")) ?? 0;
        const r = parseNumber(el.attrs.get("r")) ?? 0;
        if (r > 0 && !t.rotated) {
          const box = applyRect(t, cx - r, cy - r, r * 2, r * 2);
          includeBounds(box.x, box.y, box.x + box.w, box.y + box.h);
        }
      } else if (el.tag === "ellipse") {
        const cx = parseNumber(el.attrs.get("cx")) ?? 0;
        const cy = parseNumber(el.attrs.get("cy")) ?? 0;
        const rx = parseNumber(el.attrs.get("rx")) ?? 0;
        const ry = parseNumber(el.attrs.get("ry")) ?? 0;
        if (rx > 0 && ry > 0 && !t.rotated) {
          const box = applyRect(t, cx - rx, cy - ry, rx * 2, ry * 2);
          includeBounds(box.x, box.y, box.x + box.w, box.y + box.h);
        }
      } else if (el.tag === "line") {
        const x1 = parseNumber(el.attrs.get("x1")) ?? 0;
        const y1 = parseNumber(el.attrs.get("y1")) ?? 0;
        const x2 = parseNumber(el.attrs.get("x2")) ?? 0;
        const y2 = parseNumber(el.attrs.get("y2")) ?? 0;
        const [ax, ay] = applyPoint(t, x1, y1);
        const [bx, by] = applyPoint(t, x2, y2);
        if (!t.rotated) includeBounds(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
        if (hasArrowMarker) {
          stats.connectors++;
          straightConnectorSegments.push({ seg: { x1: ax, y1: ay, x2: bx, y2: by, straight: true }, radial: Boolean(isRadial) });
        }
      } else if (el.tag === "polyline" || el.tag === "polygon") {
        const nums = (el.attrs.get("points") ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
        const pts: Array<[number, number]> = [];
        for (let k = 0; k + 1 < nums.length; k += 2) {
          if (Number.isFinite(nums[k]) && Number.isFinite(nums[k + 1])) {
            const p = applyPoint(t, nums[k]!, nums[k + 1]!);
            pts.push(p);
            if (!t.rotated) includeBounds(p[0], p[1], p[0], p[1]);
          }
        }
        if (hasArrowMarker) {
          stats.connectors++;
          for (let k = 0; k + 1 < pts.length; k++) {
            straightConnectorSegments.push({
              seg: { x1: pts[k]![0], y1: pts[k]![1], x2: pts[k + 1]![0], y2: pts[k + 1]![1], straight: true },
              radial: Boolean(isRadial),
            });
          }
        }
      } else if (el.tag === "path") {
        const d = el.attrs.get("d");
        if (d) {
          const geom = parsePathGeometry(d, t);
          if (!t.rotated) for (const [px, py] of geom.points) includeBounds(px, py, px, py);
          if (hasArrowMarker) {
            stats.connectors++;
            for (const seg of geom.segments) {
              if (seg.straight) straightConnectorSegments.push({ seg, radial: Boolean(isRadial) });
            }
          }
        }
      } else if (el.tag === "text") {
        const x = parseNumber(el.attrs.get("x"));
        const y = parseNumber(el.attrs.get("y"));
        const fontSize = parseNumber(el.attrs.get("font-size")) ?? 13;
        const fontFamily = (el.attrs.get("font-family") ?? "").toLowerCase();
        const isMono = fontFamily.includes("mono");
        const lines = estimateTextLines(el, fontSize, isMono);
        if (x !== undefined && y !== undefined && lines.length) {
          const [ax, ay] = applyPoint(t, x, y);
          const maxW = Math.max(...lines.map((line) => estimateGlyphWidth(line, fontSize * Math.abs(t.sx), isMono)));
          const anchor = el.attrs.get("text-anchor") ?? "start";
          const x1 = anchor === "middle" ? ax - maxW / 2 : anchor === "end" ? ax - maxW : ax;
          const x2 = x1 + maxW;
          const totalH = lines.length * fontSize * 1.25 * Math.abs(t.sy);
          if (!t.rotated) includeBounds(x1, ay - fontSize * Math.abs(t.sy), x2, ay + Math.max(0, totalH - fontSize * Math.abs(t.sy)));
          paintTexts.push({ el, x: ax, y: ay, lines, fontSize: fontSize * Math.abs(t.sx), isMono, rotated: t.rotated });
        }
      }
    }

    for (const child of el.children) {
      if (child.kind === "element") walkGeometry(child, t, nextInDefs);
    }
  };
  walkGeometry(root, IDENTITY_TRANSFORM, false);

  // Silent auto-fix for small viewBox overflow (<= 48px) vs L2 severe clipping (> 48px)
  let finalVb: [number, number, number, number] = [vbX, vbY, vbW, vbH];
  if (Number.isFinite(minPaintedX)) {
    const overLeft = Math.max(0, vbX - minPaintedX);
    const overTop = Math.max(0, vbY - minPaintedY);
    const overRight = Math.max(0, maxPaintedX - (vbX + vbW));
    const overBottom = Math.max(0, maxPaintedY - (vbY + vbH));
    const maxOver = Math.max(overLeft, overTop, overRight, overBottom);
    if (maxOver > 4) {
      const nextX = overLeft > 4 ? Math.floor(minPaintedX - DIAGRAM_LIMITS.silentPaddingPx) : vbX;
      const nextY = overTop > 4 ? Math.floor(minPaintedY - DIAGRAM_LIMITS.silentPaddingPx) : vbY;
      const nextMaxX = overRight > 4 ? Math.ceil(maxPaintedX + DIAGRAM_LIMITS.silentPaddingPx) : vbX + vbW;
      const nextMaxY = overBottom > 4 ? Math.ceil(maxPaintedY + DIAGRAM_LIMITS.silentPaddingPx) : vbY + vbH;
      const nextW = nextMaxX - nextX;
      const nextH = nextMaxY - nextY;
      if (
        maxOver <= DIAGRAM_LIMITS.silentOverflowMaxPx &&
        nextW <= DIAGRAM_LIMITS.maxWidth &&
        nextH <= DIAGRAM_LIMITS.maxHeight
      ) {
        finalVb = [nextX, nextY, nextW, nextH];
        root.attrs.set("viewBox", finalVb.join(" "));
        autoFixed.push(`viewBox 已静默外扩为 "${finalVb.join(" ")}" 以避免轻微裁边`);
      } else {
        const issue: DiagramIssue = {
          level: "L2",
          code: "viewbox_overflow",
          message: `图形严重超出 viewBox（最大越界 ${Math.round(maxOver)}px），请缩小布局或扩大 viewBox。`,
        };
        if (options.allowGeometryWarnings && !options.strict) warnings.push(issue);
        else errors.push(issue);
      }
    }
  }

  // L2: Label mask covered by a node declared AFTER it in paint order
  for (const mask of maskRects) {
    if (mask.rotated) continue;
    for (const node of nodeRects) {
      if (node.rotated || node.index <= mask.index) continue;
      if (rectsOverlap(mask, node) && !rectContains(node, mask, 2)) {
        const issue: DiagramIssue = {
          level: "L2",
          code: "mask_clipped_by_later_node",
          message: `标签遮罩 (${Math.round(mask.x)},${Math.round(mask.y)}) 被后绘制的节点 (${Math.round(node.x)},${Math.round(node.y)} ${Math.round(node.w)}×${Math.round(node.h)}) 遮挡，请先画连线和遮罩，或调整标签位置。`,
        };
        if (options.allowGeometryWarnings && !options.strict) warnings.push(issue);
        else errors.push(issue);
        break;
      }
    }
  }

  // L2: Severe text overflow inside enclosing node box (> 30%)
  for (const txt of paintTexts) {
    const enclosing = nodeRects
      .filter((n) => !n.rotated && txt.x >= n.x - 4 && txt.x <= n.x + n.w + 4 && txt.y >= n.y && txt.y <= n.y + n.h + 4)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (!enclosing) continue;
    const maxLineW = Math.max(...txt.lines.map((line) => estimateGlyphWidth(line, txt.fontSize, txt.isMono)));
    const innerW = Math.max(24, enclosing.w - 12);
    if (maxLineW > innerW * 1.3) {
      const sample = txt.lines[0]!.slice(0, 20);
      const issue: DiagramIssue = {
        level: txt.rotated ? "L3" : "L2",
        code: "text_overflow_node",
        message: `文字 "${sample}" 估算宽度 ${Math.round(maxLineW)}px 严重超出节点内宽 ${Math.round(innerW)}px，请加宽节点框、缩短文案或拆分多行 <tspan>。`,
      };
      if (txt.rotated || (options.allowGeometryWarnings && !options.strict)) warnings.push(issue);
      else errors.push(issue);
    }
  }

  // L3 advisory checks (escalate to errors only in strict CLI report mode)
  const addAdvisory = (code: string, message: string) => {
    const issue: DiagramIssue = { level: "L3", code, message };
    if (options.strict) errors.push(issue);
    else warnings.push(issue);
  };

  if (stats.nodes > DIAGRAM_LIMITS.budgetNodes) {
    addAdvisory("node_budget", `节点数 ${stats.nodes} 超出推荐上限 ${DIAGRAM_LIMITS.budgetNodes}，建议精简或拆分图示。`);
  }
  if (stats.connectors > DIAGRAM_LIMITS.budgetConnectors) {
    addAdvisory("connector_budget", `连线数 ${stats.connectors} 超出推荐上限 ${DIAGRAM_LIMITS.budgetConnectors}。`);
  }
  for (const { seg, radial } of straightConnectorSegments) {
    if (radial) continue;
    const dx = Math.abs(seg.x2 - seg.x1);
    const dy = Math.abs(seg.y2 - seg.y1);
    const dist = Math.hypot(dx, dy);
    if (dist > 12 && dx > 1.5 && dy > 1.5) {
      addAdvisory("diagonal_connector", `存在斜线连线 (${Math.round(seg.x1)},${Math.round(seg.y1)})→(${Math.round(seg.x2)},${Math.round(seg.y2)})，建议使用直角折线或圆角转角。`);
      break;
    }
    if (dist >= 12) {
      for (const node of nodeRects) {
        if (!node.stroked || node.rotated) continue;
        const horizOnBorder = dy <= 1 && (Math.abs(seg.y1 - node.y) <= 1 || Math.abs(seg.y1 - (node.y + node.h)) <= 1) &&
          Math.min(seg.x1, seg.x2) < node.x + node.w - 4 && Math.max(seg.x1, seg.x2) > node.x + 4;
        const vertOnBorder = dx <= 1 && (Math.abs(seg.x1 - node.x) <= 1 || Math.abs(seg.x1 - (node.x + node.w)) <= 1) &&
          Math.min(seg.y1, seg.y2) < node.y + node.h - 4 && Math.max(seg.y1, seg.y2) > node.y + 4;
        if (horizOnBorder || vertOnBorder) {
          addAdvisory("connector_on_border", `连线紧贴节点 (${Math.round(node.x)},${Math.round(node.y)}) 边框，容易被节点遮挡。`);
          break;
        }
      }
    }
  }
  if (hasHardcodedColors && !usesThemeVars) {
    warnings.push({ level: "L3", code: "hardcoded_colors", message: "建议使用 var(--d-paper/--d-ink/--d-muted/--d-rule/--d-accent) 语义色变量以完美适配浅色与深色主题。" });
  }

  if (errors.length) {
    return { ok: false, autoFixed, errors, warnings, stats };
  }

  // Silent accessible-SVG normalization
  const slug = slugifyIdPrefix(options.title);
  const titleId = `${slug}-title`;
  const descId = `${slug}-desc`;
  root.attrs.set("xmlns", "http://www.w3.org/2000/svg");
  root.attrs.set("role", "img");
  root.attrs.set("aria-labelledby", `${titleId} ${descId}`);
  root.attrs.delete("width");
  root.attrs.delete("height");

  const existingTitleIdx = root.children.findIndex((c) => c.kind === "element" && c.tag === "title");
  const existingDescIdx = root.children.findIndex((c) => c.kind === "element" && c.tag === "desc");
  const titleText = (options.title?.trim() || (existingTitleIdx >= 0 ? textContentOf(root.children[existingTitleIdx] as XmlElementNode) : "图示"))
    .replace(/[<>]/g, "").slice(0, 120);
  const descText = (options.description?.trim() || (existingDescIdx >= 0 ? textContentOf(root.children[existingDescIdx] as XmlElementNode) : titleText))
    .replace(/[<>]/g, "").slice(0, 600);

  root.children = root.children.filter((c) => !(c.kind === "element" && (c.tag === "title" || c.tag === "desc")));
  root.children.unshift(
    { kind: "element", tag: "title", attrs: new Map([["id", titleId]]), children: [{ kind: "text", value: titleText }] },
    { kind: "element", tag: "desc", attrs: new Map([["id", descId]]), children: [{ kind: "text", value: descText }] },
  );

  return {
    ok: true,
    svg: serializeXml(root),
    width: Math.round(finalVb[2]),
    height: Math.round(finalVb[3]),
    viewBox: finalVb,
    autoFixed,
    errors,
    warnings,
    stats,
  };
}

/** Extract inline <svg> fragments from an HTML document for report-level validation. */
export function extractInlineSvgsFromHtml(html: string): string[] {
  const results: string[] = [];
  const lower = html.toLowerCase();
  let pos = 0;
  while (pos < html.length) {
    const start = lower.indexOf("<svg", pos);
    if (start < 0) break;
    const nextChar = lower[start + 4];
    if (nextChar && !/[\s>/]/.test(nextChar)) { pos = start + 4; continue; }
    let depth = 0;
    let cursor = start;
    let end = -1;
    while (cursor < html.length) {
      const open = lower.indexOf("<svg", cursor);
      const close = lower.indexOf("</svg>", cursor);
      if (close < 0) break;
      if (open >= 0 && open < close && (!lower[open + 4] || /[\s>/]/.test(lower[open + 4]!))) {
        depth++;
        cursor = open + 4;
      } else {
        depth--;
        cursor = close + 6;
        if (depth <= 0) { end = cursor; break; }
      }
    }
    if (end > start) {
      results.push(html.slice(start, end));
      pos = end;
    } else {
      break;
    }
  }
  return results;
}
