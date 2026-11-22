import { BinaryPreviewLimitError, MAX_OFFICE_PREVIEW_BYTES, readBinaryPreview } from "./file-preview-model";
import { readFileAsset } from "./file-actions";

export const MAX_ZIP_ENTRIES = 1_000;
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 100;
export const RATIO_CHECK_MIN_BYTES = 10 * 1024 * 1024;
export const MAX_XML_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_EMBEDDED_MEDIA_BYTES = 16 * 1024 * 1024;
export const MAX_EMBEDDED_MEDIA_COUNT = 40;
const DEFLATE_CHUNK_BYTES = 64 * 1024;

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const MAX_EOCD_SCAN_BYTES = 65_535 + 22;

export type OfficePreviewErrorCode =
  | "too_large"
  | "encrypted_or_legacy"
  | "invalid_format"
  | "zip_limit"
  | "unsafe_xml"
  | "corrupt_xml"
  | "unsupported_compression"
  | "runtime_unavailable"
  | "network";

export class OfficePreviewError extends Error {
  constructor(
    readonly code: OfficePreviewErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OfficePreviewError";
  }
}

export interface ZipEntryMeta {
  path: string;
  method: 0 | 8;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataStart: number;
  dataEnd: number;
}

export interface OpcRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
  resolvedPath?: string;
}

export type SafeRasterMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ResolvedOfficeImage {
  url: string;
  mime: SafeRasterMime;
  size: number;
  name: string;
}

export function normalizeOfficeError(reason: unknown, fallbackMessage: string): OfficePreviewError {
  if (reason instanceof OfficePreviewError) return reason;
  if (reason instanceof BinaryPreviewLimitError) {
    return new OfficePreviewError("too_large", reason.message, false);
  }
  const message = reason instanceof Error && reason.message ? reason.message : fallbackMessage;
  return new OfficePreviewError("network", message, true);
}

export async function fetchOfficeArchive(assetId: string, signal?: AbortSignal): Promise<OfficeArchive> {
  const response = await readFileAsset(assetId, signal);
  const bytes = await readBinaryPreview(response, MAX_OFFICE_PREVIEW_BYTES, signal);
  signal?.throwIfAborted();
  return OfficeArchive.open(bytes);
}

function normalizeZipPath(rawName: string): string | undefined {
  if (!rawName || /[\x00-\x1f\x7f]/.test(rawName)) return undefined;
  const unified = rawName.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!unified) return undefined;
  const segments = unified.split("/");
  if (segments.some((segment) => segment === "..")) return undefined;
  return segments.filter((segment) => segment && segment !== ".").join("/");
}

function findEocdOffset(view: DataView, length: number): number {
  const minOffset = Math.max(0, length - MAX_EOCD_SCAN_BYTES);
  for (let offset = length - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) !== SIG_EOCD) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === length) return offset;
  }
  return -1;
}

async function inflateRawBounded(
  compressed: Uint8Array,
  maxEntryBytes: number,
  remainingTotalBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new OfficePreviewError("runtime_unavailable", "当前运行环境不支持流式解压预览", false);
  }
  const limit = Math.min(maxEntryBytes, remainingTotalBytes);
  if (limit < 0) {
    throw new OfficePreviewError("zip_limit", "文档解压后超出预览安全上限，请使用默认应用打开", false);
  }

  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let stopped = false;
  let limitError: OfficePreviewError | undefined;

  const stopWriter = () => {
    stopped = true;
    void writer.abort().catch(() => {});
  };
  const onAbort = () => stopWriter();
  signal?.addEventListener("abort", onAbort, { once: true });

  const pump = (async () => {
    try {
      for (let offset = 0; !stopped && offset < compressed.byteLength; offset += DEFLATE_CHUNK_BYTES) {
        const end = Math.min(offset + DEFLATE_CHUNK_BYTES, compressed.byteLength);
        await writer.write(compressed.slice(offset, end));
      }
      if (!stopped) await writer.close();
    } catch {
      // Writer errors are observed via reader.read() or limitError.
    } finally {
      try { writer.releaseLock(); } catch { /* Already released */ }
    }
  })();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (!chunk || chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (
        total > limit ||
        (total > RATIO_CHECK_MIN_BYTES && total > Math.max(compressed.byteLength, 1) * MAX_COMPRESSION_RATIO)
      ) {
        limitError = new OfficePreviewError("zip_limit", "文档解压后超出预览安全上限，请使用默认应用打开", false);
        stopped = true;
        await reader.cancel().catch(() => {});
        await writer.abort().catch(() => {});
        throw limitError;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    stopped = true;
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    if (limitError) throw limitError;
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (error instanceof OfficePreviewError) throw error;
    throw new OfficePreviewError("invalid_format", "文档压缩内容已损坏，无法预览", false);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* Already released */ }
    await pump;
  }

  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out;
}

export class OfficeArchive {
  private readonly bytes: Uint8Array;
  private readonly entries: Map<string, ZipEntryMeta>;
  private readonly lowerEntries: Map<string, ZipEntryMeta>;
  private totalDecompressedBytes = 0;

  private constructor(
    bytes: Uint8Array,
    entries: Map<string, ZipEntryMeta>,
    lowerEntries: Map<string, ZipEntryMeta>,
  ) {
    this.bytes = bytes;
    this.entries = entries;
    this.lowerEntries = lowerEntries;
  }

  static open(bytes: Uint8Array): OfficeArchive {
    if (bytes.byteLength < 4) {
      throw new OfficePreviewError("invalid_format", "文件格式无效或已损坏，无法预览", false);
    }
    // OLE2 compound document: legacy .doc/.xls/.ppt or password-encrypted OOXML container.
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      throw new OfficePreviewError("encrypted_or_legacy", "暂不支持加密或旧版 Office 文档，请使用默认应用打开", false);
    }
    const isPkLocal = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    const isPkEmpty = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06;
    if (!isPkLocal && !isPkEmpty) {
      throw new OfficePreviewError("invalid_format", "文件格式与扩展名不匹配或已损坏", false);
    }
    if (bytes.byteLength < 22) {
      throw new OfficePreviewError("invalid_format", "文档压缩结构不完整，无法预览", false);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocdOffset = findEocdOffset(view, bytes.byteLength);
    if (eocdOffset < 0) {
      throw new OfficePreviewError("invalid_format", "文档压缩目录损坏，无法预览", false);
    }

    const diskNumber = view.getUint16(eocdOffset + 4, true);
    const cdStartDisk = view.getUint16(eocdOffset + 6, true);
    const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    if (
      totalEntries === 0xffff ||
      entriesOnDisk === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff
    ) {
      throw new OfficePreviewError("zip_limit", "暂不支持 ZIP64 扩展格式，请使用默认应用打开", false);
    }
    if (diskNumber !== 0 || cdStartDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw new OfficePreviewError("invalid_format", "暂不支持分卷压缩文档，请使用默认应用打开", false);
    }
    if (totalEntries > MAX_ZIP_ENTRIES) {
      throw new OfficePreviewError("zip_limit", "文档内部条目过多，超出预览安全上限，请使用默认应用打开", false);
    }
    if (cdOffset + cdSize > eocdOffset) {
      throw new OfficePreviewError("invalid_format", "文档压缩目录越界，无法预览", false);
    }

    const decoder = new TextDecoder("utf-8", { fatal: false });
    const entries = new Map<string, ZipEntryMeta>();
    const lowerEntries = new Map<string, ZipEntryMeta>();
    const ordered: ZipEntryMeta[] = [];

    let cursor = cdOffset;
    const cdEnd = cdOffset + cdSize;
    for (let index = 0; index < totalEntries; index++) {
      if (cursor + 46 > cdEnd || view.getUint32(cursor, true) !== SIG_CENTRAL_DIR) {
        throw new OfficePreviewError("invalid_format", "文档压缩目录条目损坏，无法预览", false);
      }
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLen = view.getUint16(cursor + 28, true);
      const extraLen = view.getUint16(cursor + 30, true);
      const commentLen = view.getUint16(cursor + 32, true);
      const localHeaderOffset = view.getUint32(cursor + 42, true);

      if ((flags & 0x01) !== 0 || method === 99) {
        throw new OfficePreviewError("encrypted_or_legacy", "暂不支持加密的 Office 文档，请使用默认应用打开", false);
      }
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        throw new OfficePreviewError("zip_limit", "暂不支持 ZIP64 扩展格式，请使用默认应用打开", false);
      }
      if (method !== 0 && method !== 8) {
        throw new OfficePreviewError("unsupported_compression", "文档使用了不支持的压缩方式，请使用默认应用打开", false);
      }

      const nameStart = cursor + 46;
      const nextCursor = nameStart + nameLen + extraLen + commentLen;
      if (nextCursor > cdEnd) {
        throw new OfficePreviewError("invalid_format", "文档压缩目录长度异常，无法预览", false);
      }
      const rawName = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
      cursor = nextCursor;

      // Skip directory entries while still validating their headers are not malformed.
      if (rawName.endsWith("/") && compressedSize === 0) continue;

      const normalized = normalizeZipPath(rawName);
      if (!normalized) {
        throw new OfficePreviewError("invalid_format", "文档包含非法内部路径，已拒绝预览", false);
      }
      if (entries.has(normalized)) {
        throw new OfficePreviewError("invalid_format", "文档包含重复内部条目，已拒绝预览", false);
      }

      if (localHeaderOffset + 30 > cdOffset || view.getUint32(localHeaderOffset, true) !== SIG_LOCAL_FILE) {
        throw new OfficePreviewError("invalid_format", "文档本地文件头损坏，无法预览", false);
      }
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataStart < localHeaderOffset + 30 || dataEnd > cdOffset) {
        throw new OfficePreviewError("invalid_format", "文档压缩数据区间越界，无法预览", false);
      }

      const meta: ZipEntryMeta = {
        path: normalized,
        method,
        flags,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        dataStart,
        dataEnd,
      };
      entries.set(normalized, meta);
      const lower = normalized.toLowerCase();
      if (!lowerEntries.has(lower)) lowerEntries.set(lower, meta);
      ordered.push(meta);
    }

    // Reject overlapping compressed payload kernels (overlapping-kernel Zip Bomb defense).
    ordered.sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i - 1]!.dataEnd > ordered[i]!.localHeaderOffset) {
        throw new OfficePreviewError("zip_limit", "检测到重叠压缩结构，已拒绝预览", false);
      }
    }

    return new OfficeArchive(bytes, entries, lowerEntries);
  }

  resolveEntry(targetPath: string): ZipEntryMeta | undefined {
    const clean = normalizeZipPath(targetPath);
    if (!clean) return undefined;
    return this.entries.get(clean) ?? this.lowerEntries.get(clean.toLowerCase());
  }

  has(targetPath: string): boolean {
    return this.resolveEntry(targetPath) !== undefined;
  }

  listPaths(): string[] {
    return [...this.entries.keys()];
  }

  get decompressedBytes(): number {
    return this.totalDecompressedBytes;
  }

  async readBytes(
    targetPath: string,
    maxEntryBytes = MAX_ENTRY_UNCOMPRESSED_BYTES,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    signal?.throwIfAborted();
    const entry = this.resolveEntry(targetPath);
    if (!entry) return undefined;

    const remainingTotal = MAX_TOTAL_UNCOMPRESSED_BYTES - this.totalDecompressedBytes;
    const compressed = this.bytes.subarray(entry.dataStart, entry.dataEnd);

    let out: Uint8Array;
    if (entry.method === 0) {
      if (compressed.byteLength > maxEntryBytes || compressed.byteLength > remainingTotal) {
        throw new OfficePreviewError("zip_limit", "文档解压后超出预览安全上限，请使用默认应用打开", false);
      }
      out = compressed;
    } else {
      out = await inflateRawBounded(compressed, maxEntryBytes, remainingTotal, signal);
    }

    this.totalDecompressedBytes += out.byteLength;
    return out;
  }

  async readXml(
    targetPath: string,
    domParser?: DOMParser,
    signal?: AbortSignal,
  ): Promise<Document | undefined> {
    const bytes = await this.readBytes(targetPath, MAX_XML_TEXT_BYTES, signal);
    if (!bytes) return undefined;
    return parseOfficeXml(bytes, domParser);
  }
}

export function parseOfficeXml(bytes: Uint8Array, domParser?: DOMParser): Document {
  if (bytes.byteLength > MAX_XML_TEXT_BYTES) {
    throw new OfficePreviewError("zip_limit", "文档内容结构过大，请使用默认应用打开", false);
  }
  let xml = new TextDecoder("utf-8").decode(bytes);
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new OfficePreviewError("unsafe_xml", "文档包含不受支持的 XML 声明，已拒绝预览", false);
  }
  const trimmed = xml.trim();
  if (!trimmed.startsWith("<") || !trimmed.endsWith(">")) {
    throw new OfficePreviewError("corrupt_xml", "文档 XML 结构损坏，无法预览", false);
  }
  const parser = domParser ?? (typeof globalThis.DOMParser === "function" ? new globalThis.DOMParser() : undefined);
  if (!parser) {
    throw new OfficePreviewError("runtime_unavailable", "当前运行环境不支持 XML 解析", false);
  }
  const doc = parser.parseFromString(xml, "application/xml");
  if (!doc || !doc.documentElement || doc.getElementsByTagName("parsererror").length > 0) {
    throw new OfficePreviewError("corrupt_xml", "文档 XML 解析失败，请使用默认应用打开", false);
  }
  return doc;
}

/** Normalize element local names consistently across browsers and linkedom (which preserves namespace prefixes). */
export function xmlLocalName(node: { localName?: string | null; nodeName?: string | null }): string {
  const raw = node.localName || node.nodeName || "";
  const colon = raw.indexOf(":");
  return colon >= 0 ? raw.slice(colon + 1) : raw;
}

/** Read an attribute by local name regardless of namespace prefix. */
export function xmlAttr(element: Element, localName: string): string | undefined {
  const direct = element.getAttribute(localName);
  if (direct !== null) return direct;
  const attrs = element.attributes;
  if (!attrs) return undefined;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    if (!attr) continue;
    const name = attr.name;
    const colon = name.indexOf(":");
    const local = colon >= 0 ? name.slice(colon + 1) : name;
    if (local === localName) return attr.value;
  }
  return undefined;
}

/** Read a relationship attribute (e.g. r:id, r:embed), preferring namespaced over bare attributes like <p:sldId id="256" r:id="rId2"/>. */
export function xmlRelAttr(element: Element, localName: "id" | "embed" | "link" = "id"): string | undefined {
  const attrs = element.attributes;
  if (attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs[i];
      if (!attr) continue;
      const colon = attr.name.indexOf(":");
      if (colon >= 0 && attr.name.slice(colon + 1) === localName) return attr.value;
    }
  }
  return xmlAttr(element, localName);
}

/** Yield direct element children, automatically unwrapping mc:AlternateContent (Choice preferred over Fallback). */
export function xmlEffectiveChildren(parent: Element, filterLocalName?: string): Element[] {
  const result: Element[] = [];
  const visit = (container: Element) => {
    const children = container.childNodes;
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (!node || node.nodeType !== 1) continue;
      const el = node as Element;
      const name = xmlLocalName(el);
      if (name === "AlternateContent") {
        let choice: Element | undefined;
        let fallback: Element | undefined;
        for (let j = 0; j < el.childNodes.length; j++) {
          const branch = el.childNodes[j];
          if (!branch || branch.nodeType !== 1) continue;
          const branchEl = branch as Element;
          const branchName = xmlLocalName(branchEl);
          if (branchName === "Choice" && !choice) choice = branchEl;
          else if (branchName === "Fallback" && !fallback) fallback = branchEl;
        }
        const before = result.length;
        if (choice) visit(choice);
        if (result.length === before && fallback) visit(fallback);
        continue;
      }
      if (!filterLocalName || name === filterLocalName) {
        result.push(el);
      }
    }
  };
  visit(parent);
  return result;
}

export function xmlFirstChild(parent: Element, localName: string): Element | undefined {
  const children = xmlEffectiveChildren(parent, localName);
  return children[0];
}

export function xmlFindDescendants(root: Element, localName: string, skipLocalNames?: ReadonlySet<string>): Element[] {
  const result: Element[] = [];
  const walk = (el: Element) => {
    for (const child of xmlEffectiveChildren(el)) {
      const name = xmlLocalName(child);
      if (skipLocalNames?.has(name)) continue;
      if (name === localName) result.push(child);
      walk(child);
    }
  };
  walk(root);
  return result;
}

export function relsPathFor(sourcePartPath: string): string {
  const clean = sourcePartPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean) return "_rels/.rels";
  const slash = clean.lastIndexOf("/");
  if (slash < 0) return `_rels/${clean}.rels`;
  return `${clean.slice(0, slash)}/_rels/${clean.slice(slash + 1)}.rels`;
}

/** Resolve an OPC relationship Target relative to its source part (never relative to _rels/). */
export function resolveOpcTarget(
  sourcePartPath: string,
  rawTarget: string,
  targetMode?: string,
): string | undefined {
  if (targetMode && targetMode.trim().toLowerCase() === "external") return undefined;
  const trimmed = rawTarget.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return undefined;

  const withoutFragment = trimmed.split("#", 1)[0]!.split("?", 1)[0]!;
  if (!withoutFragment) return undefined;
  let decoded = withoutFragment;
  try { decoded = decodeURIComponent(withoutFragment); } catch { /* Keep raw target if percent sequence is malformed */ }
  const unified = decoded.replace(/\\/g, "/");

  const stack: string[] = [];
  if (!unified.startsWith("/")) {
    const cleanSource = sourcePartPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const slash = cleanSource.lastIndexOf("/");
    if (slash > 0) {
      for (const segment of cleanSource.slice(0, slash).split("/")) {
        if (segment && segment !== ".") stack.push(segment);
      }
    }
  }

  for (const segment of unified.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.length > 0 ? stack.join("/") : undefined;
}

export function safeOfficeExternalUrl(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function parseRelationships(
  archive: OfficeArchive,
  sourcePartPath: string,
  domParser?: DOMParser,
  signal?: AbortSignal,
): Promise<Map<string, OpcRelationship>> {
  const map = new Map<string, OpcRelationship>();
  const doc = await archive.readXml(relsPathFor(sourcePartPath), domParser, signal);
  if (!doc) return map;
  for (const rel of xmlEffectiveChildren(doc.documentElement, "Relationship")) {
    const id = xmlAttr(rel, "Id");
    const type = xmlAttr(rel, "Type") ?? "";
    const target = xmlAttr(rel, "Target") ?? "";
    if (!id || !target) continue;
    const mode = xmlAttr(rel, "TargetMode");
    const external = mode?.trim().toLowerCase() === "external";
    const resolvedPath = external ? undefined : resolveOpcTarget(sourcePartPath, target, mode);
    map.set(id, { id, type, target, external, resolvedPath });
  }
  return map;
}

/** Detect only safe raster image formats from actual binary signatures (excludes SVG/EMF/WMF). */
export function detectSafeRasterMime(bytes: Uint8Array): SafeRasterMime | undefined {
  if (bytes.byteLength >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.byteLength >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif";
  }
  if (bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return undefined;
}

export class BlobUrlRegistry {
  private readonly cache = new Map<string, ResolvedOfficeImage>();
  private totalBytes = 0;
  private disposed = false;
  omittedCount = 0;

  async resolveImage(
    archive: OfficeArchive,
    entryPath: string,
    signal?: AbortSignal,
  ): Promise<ResolvedOfficeImage | undefined> {
    const key = entryPath.toLowerCase();
    const existing = this.cache.get(key);
    if (existing) return existing;
    if (this.disposed) return undefined;
    if (this.cache.size >= MAX_EMBEDDED_MEDIA_COUNT) {
      this.omittedCount++;
      return undefined;
    }
    const remaining = MAX_EMBEDDED_MEDIA_BYTES - this.totalBytes;
    if (remaining <= 0) {
      this.omittedCount++;
      return undefined;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await archive.readBytes(entryPath, Math.min(remaining, MAX_ENTRY_UNCOMPRESSED_BYTES), signal);
    } catch (error) {
      if (error instanceof OfficePreviewError && error.code === "zip_limit") {
        this.omittedCount++;
        return undefined;
      }
      throw error;
    }
    if (!bytes) return undefined;
    const mime = detectSafeRasterMime(bytes);
    if (!mime) return undefined;
    if (this.totalBytes + bytes.byteLength > MAX_EMBEDDED_MEDIA_BYTES) {
      this.omittedCount++;
      return undefined;
    }
    if (this.disposed) return undefined;
    const blob = new Blob([bytes.slice()], { type: mime });
    const url = URL.createObjectURL(blob);
    const name = entryPath.split("/").at(-1) || "image";
    const resolved: ResolvedOfficeImage = { url, mime, size: bytes.byteLength, name };
    this.totalBytes += bytes.byteLength;
    this.cache.set(key, resolved);
    return resolved;
  }

  dispose(delayMs = 1_000): void {
    if (this.disposed) return;
    this.disposed = true;
    const urls = [...this.cache.values()].map((item) => item.url);
    this.cache.clear();
    if (!urls.length) return;
    const revokeAll = () => {
      for (const url of urls) {
        try { URL.revokeObjectURL(url); } catch { /* Ignore revocation errors */ }
      }
    };
    if (delayMs > 0) setTimeout(revokeAll, delayMs);
    else revokeAll();
  }
}
