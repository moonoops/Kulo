/**
 * Pure leaf structural verifier for raster image base64 payloads & data URLs.
 *
 * Designed for zero-copy O(1) header + trailer framing verification paired with a
 * single linear base64 charset pass (<= 20 MiB), safe for both Node and browser bundles.
 * Never exempts `image/svg+xml` (readable XML text must always be redacted).
 */

export const VISION_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export const MAX_VERIFIED_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VERIFIED_IMAGE_BASE64_CHARS = Math.ceil(MAX_VERIFIED_IMAGE_BYTES / 3) * 4;

const SYSTEM_ONE_IMAGE_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "gif"]);

const B64_TABLE = new Int8Array(128).fill(-1);
for (let i = 0; i < 26; i++) {
  B64_TABLE[65 + i] = i; // A-Z
  B64_TABLE[97 + i] = 26 + i; // a-z
}
for (let i = 0; i < 10; i++) {
  B64_TABLE[48 + i] = 52 + i; // 0-9
}
B64_TABLE[43] = 62; // +
B64_TABLE[47] = 63; // /

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_IHDR_PREFIX = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52] as const;
const PNG_IEND_CHUNK = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] as const;

function normalizeMime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const semi = value.indexOf(";");
  const base = (semi >= 0 ? value.slice(0, semi) : value).trim().toLowerCase();
  return base || undefined;
}

export function isVisionImageMime(value: unknown): boolean {
  const mime = normalizeMime(value);
  return mime !== undefined && VISION_IMAGE_MIMES.has(mime);
}

function isWhitelistedImageFormat(value: unknown): boolean {
  return typeof value === "string" && SYSTEM_ONE_IMAGE_FORMATS.has(value.trim().toLowerCase());
}

function decodeBase64Range(str: string, start: number, end: number): Uint8Array {
  const len = end - start;
  const pad = len >= 2 && str.charCodeAt(end - 1) === 61 ? (str.charCodeAt(end - 2) === 61 ? 2 : 1) : 0;
  const outLen = (len >>> 2) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = start; i < end; i += 4) {
    const a = B64_TABLE[str.charCodeAt(i)]!;
    const b = B64_TABLE[str.charCodeAt(i + 1)]!;
    const cCode = str.charCodeAt(i + 2);
    const dCode = str.charCodeAt(i + 3);
    const c = cCode === 61 ? 0 : B64_TABLE[cCode]!;
    const d = dCode === 61 ? 0 : B64_TABLE[dCode]!;
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (triple >>> 16) & 0xff;
    if (o < outLen) out[o++] = (triple >>> 8) & 0xff;
    if (o < outLen) out[o++] = triple & 0xff;
  }
  return out;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function matchBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || offset + expected.length > bytes.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

function trimTrailingZeroBytes(bytes: Uint8Array, minRemaining: number): number {
  let end = bytes.length;
  while (end > minRemaining && bytes[end - 1] === 0) {
    end--;
  }
  return end;
}

function verifyPngHead(head: Uint8Array, decodedByteLength: number): boolean {
  if (decodedByteLength < 45 || head.length < 24) return false;
  if (!matchBytesAt(head, 0, PNG_MAGIC)) return false;
  if (!matchBytesAt(head, 8, PNG_IHDR_PREFIX)) return false;
  return readU32BE(head, 16) > 0 && readU32BE(head, 20) > 0;
}

function verifyPngTail(tail: Uint8Array): boolean {
  const end = trimTrailingZeroBytes(tail, PNG_IEND_CHUNK.length);
  return matchBytesAt(tail, end - PNG_IEND_CHUNK.length, PNG_IEND_CHUNK);
}

function verifyJpegHead(head: Uint8Array, decodedByteLength: number): boolean {
  return (
    decodedByteLength >= 12 &&
    head.length >= 4 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff &&
    head[3] !== 0x00 &&
    head[3] !== 0xff
  );
}

function verifyJpegTail(tail: Uint8Array): boolean {
  const end = trimTrailingZeroBytes(tail, 2);
  return end >= 2 && tail[end - 2] === 0xff && tail[end - 1] === 0xd9;
}

function verifyGifHead(head: Uint8Array, decodedByteLength: number): boolean {
  if (decodedByteLength < 14 || head.length < 10) return false;
  const isGifMagic =
    head[0] === 0x47 && // G
    head[1] === 0x49 && // I
    head[2] === 0x46 && // F
    head[3] === 0x38 && // 8
    (head[4] === 0x37 || head[4] === 0x39) && // 7 or 9
    head[5] === 0x61; // a
  if (!isGifMagic) return false;
  return readU16LE(head, 6) > 0 && readU16LE(head, 8) > 0;
}

function verifyGifTail(tail: Uint8Array): boolean {
  const end = trimTrailingZeroBytes(tail, 1);
  return end >= 1 && tail[end - 1] === 0x3b;
}

function verifyWebpHead(head: Uint8Array, decodedByteLength: number): boolean {
  if (decodedByteLength < 20 || head.length < 20) return false;
  // "RIFF" ... "WEBP"
  if (
    head[0] !== 0x52 ||
    head[1] !== 0x49 ||
    head[2] !== 0x46 ||
    head[3] !== 0x46 ||
    head[8] !== 0x57 ||
    head[9] !== 0x45 ||
    head[10] !== 0x42 ||
    head[11] !== 0x50
  ) {
    return false;
  }
  const chunkSize = readU32LE(head, 4);
  if (chunkSize < 12) return false;
  const sizeMatches =
    decodedByteLength === chunkSize + 8 ||
    (chunkSize % 2 === 1 && decodedByteLength === chunkSize + 9);
  if (!sizeMatches) return false;

  // FourCC must be "VP8 ", "VP8L", or "VP8X"
  if (head[12] !== 0x56 || head[13] !== 0x50 || head[14] !== 0x38) return false;
  const variant = head[15]!;
  const subChunkSize = readU32LE(head, 16);
  if (subChunkSize === 0 || 20 + subChunkSize > decodedByteLength) return false;

  if (variant === 0x20) {
    // "VP8 " lossy bitstream: 3-byte frame tag + 0x9d 0x01 0x2a start code
    return decodedByteLength >= 30 && head.length >= 30 && head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a;
  }
  if (variant === 0x4c) {
    // "VP8L" lossless bitstream: signature byte 0x2f
    return decodedByteLength >= 25 && head.length >= 25 && head[20] === 0x2f;
  }
  if (variant === 0x58) {
    // "VP8X" extended header: fixed 10-byte chunk payload
    return decodedByteLength >= 30 && subChunkSize === 10;
  }
  return false;
}

function isVerifiedBase64Range(str: string, start: number, end: number): boolean {
  const len = end - start;
  if (len < 16 || len > MAX_VERIFIED_IMAGE_BASE64_CHARS || (len & 3) !== 0) return false;

  const last = str.charCodeAt(end - 1);
  const secondLast = str.charCodeAt(end - 2);
  const pad = last === 61 ? (secondLast === 61 ? 2 : 1) : 0;
  if (pad === 0 && secondLast === 61) return false;

  const decodedByteLength = (len >>> 2) * 3 - pad;
  if (decodedByteLength < 12 || decodedByteLength > MAX_VERIFIED_IMAGE_BYTES) return false;

  // Fast-reject head bytes before scanning the full payload to fail early on non-images.
  const headChars = Math.min(len, 40);
  const headDataEnd = Math.min(start + headChars, end - pad);
  for (let i = start; i < headDataEnd; i++) {
    const code = str.charCodeAt(i);
    if (code >= 128 || B64_TABLE[code]! < 0) return false;
  }
  const head = decodeBase64Range(str, start, start + headChars);

  let kind: "png" | "jpeg" | "gif" | "webp" | undefined;
  if (verifyPngHead(head, decodedByteLength)) kind = "png";
  else if (verifyJpegHead(head, decodedByteLength)) kind = "jpeg";
  else if (verifyGifHead(head, decodedByteLength)) kind = "gif";
  else if (verifyWebpHead(head, decodedByteLength)) kind = "webp";
  else return false;

  // Check tail framing before scanning the middle so truncated/forged tails also fail in O(1).
  if (kind !== "webp") {
    const tailChars = Math.min(len, 64);
    const tailStart = end - tailChars;
    const tailDataEnd = end - pad;
    for (let i = tailStart; i < tailDataEnd; i++) {
      const code = str.charCodeAt(i);
      if (code >= 128 || B64_TABLE[code]! < 0) return false;
    }
    const tail = decodeBase64Range(str, tailStart, end);
    if (kind === "png" && !verifyPngTail(tail)) return false;
    if (kind === "jpeg" && !verifyJpegTail(tail)) return false;
    if (kind === "gif" && !verifyGifTail(tail)) return false;
  }

  // Single-pass linear scan over the remaining interior base64 characters.
  const scanStart = start + headChars;
  const scanEnd = kind === "webp" ? end - pad : Math.max(scanStart, end - Math.min(len, 64));
  for (let i = scanStart; i < scanEnd; i++) {
    const code = str.charCodeAt(i);
    if (code >= 128 || B64_TABLE[code]! < 0) return false;
  }
  return true;
}

/**
 * Verifies that `value` is a strictly valid base64-encoded raster image (PNG, JPEG, WebP, or GIF)
 * up to 20 MiB, with valid head and tail framing. Tolerates MIME/magic mismatch among the 4 raster
 * formats when `declaredMime` is supplied (while still rejecting non-whitelisted MIMEs like SVG).
 */
export function isVerifiedImageBinaryPayload(value: unknown, declaredMime?: unknown): value is string {
  if (declaredMime !== undefined && !isVisionImageMime(declaredMime)) return false;
  if (typeof value !== "string") return false;
  return isVerifiedBase64Range(value, 0, value.length);
}

/**
 * Verifies `data:image/(png|jpeg|jpg|webp|gif);base64,<verified>` without copying the payload string.
 */
export function isVerifiedImageDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 28 || value.length > MAX_VERIFIED_IMAGE_BASE64_CHARS + 64) {
    return false;
  }
  const comma = value.indexOf(",", 11);
  if (comma < 0 || comma > 64) return false;
  const header = value.slice(0, comma);
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64$/i.exec(header);
  if (!match) return false;
  if (!VISION_IMAGE_MIMES.has(match[1]!.toLowerCase())) return false;
  return isVerifiedBase64Range(value, comma + 1, value.length);
}

/**
 * Verifies a string value inside a known internal or provider-wire image container:
 * - Pi / Kulo internal: `{ type: "image", mimeType, data }`
 * - Anthropic wire: `{ type: "base64", media_type, data }`
 * - Google wire / Vertex: `{ inlineData: { mimeType, data } }`
 * - Kulo media-adapters / Gemini Interactions: `{ type: "image", mime_type, data }`
 * - System One assets: `{ type: "image", format, data_base64 }`
 * - OpenAI Responses / Completions, Mistral, System One `images[]`: `image_url` / `imageUrl` / `url` / `images` data URLs
 */
export function isVerifiedImageContainerValue(
  parent: unknown,
  key: string | number | undefined,
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  if (key === "image_url" || key === "imageUrl" || key === "url" || key === "images") {
    return isVerifiedImageDataUrl(value);
  }
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return false;
  const record = parent as Record<string, unknown>;
  if (key === "data") {
    const mime = record.mimeType ?? record.mime_type ?? record.media_type;
    return isVisionImageMime(mime) && isVerifiedImageBinaryPayload(value, mime);
  }
  if (key === "data_base64") {
    return (
      record.type === "image" &&
      isWhitelistedImageFormat(record.format) &&
      isVerifiedImageBinaryPayload(value)
    );
  }
  return false;
}
