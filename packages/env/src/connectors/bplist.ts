/**
 * Zero-dependency, strictly bounded Apple binary property list (bplist00) reader.
 * Decodes only safe primitive values, arrays, and null-prototype dictionaries for
 * macOS Notification Center payloads; never instantiates archived classes.
 */

const MAGIC = "bplist00";
const MAX_PLIST_BYTES = 256 * 1024;
const MAX_OBJECTS = 512;
const MAX_DEPTH = 12;
const MAX_STRING_BYTES = 64 * 1024;
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000; // 2001-01-01T00:00:00Z
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | PlistValue[]
  | Record<string, unknown>;

export interface ParsedNotificationPlist {
  title: string;
  subtitle: string;
  body: string;
  threadId?: string;
  identifier?: string;
  appId?: string;
}

function readUIntBE(buf: Uint8Array, offset: number, size: number): number {
  if (offset < 0 || offset + size > buf.byteLength || size < 1 || size > 8) {
    throw new Error("bplist_out_of_bounds");
  }
  let value = 0;
  for (let i = 0; i < size; i += 1) {
    value = value * 256 + buf[offset + i]!;
  }
  if (!Number.isSafeInteger(value)) throw new Error("bplist_integer_overflow");
  return value;
}

function readInt64BE(buf: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 8 > buf.byteLength) throw new Error("bplist_out_of_bounds");
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const big = view.getBigInt64(0, false);
  const num = Number(big);
  return Number.isFinite(num) ? num : 0;
}

function readLength(buf: Uint8Array, pos: number, info: number): { length: number; nextPos: number } {
  if (info !== 0x0f) return { length: info, nextPos: pos };
  if (pos >= buf.byteLength) throw new Error("bplist_out_of_bounds");
  const marker = buf[pos]!;
  if ((marker & 0xf0) !== 0x10) throw new Error("bplist_invalid_length");
  const size = 1 << (marker & 0x0f);
  if (size > 8) throw new Error("bplist_invalid_length");
  const length = size === 8 ? readInt64BE(buf, pos + 1) : readUIntBE(buf, pos + 1, size);
  if (length < 0 || !Number.isSafeInteger(length)) throw new Error("bplist_invalid_length");
  return { length, nextPos: pos + 1 + size };
}

function decodeUtf16BE(buf: Uint8Array, offset: number, codeUnits: number): string {
  const byteLength = codeUnits * 2;
  if (byteLength > MAX_STRING_BYTES || offset + byteLength > buf.byteLength) {
    throw new Error("bplist_string_too_large");
  }
  const swapped = Buffer.allocUnsafe(byteLength);
  for (let i = 0; i < byteLength; i += 2) {
    swapped[i] = buf[offset + i + 1]!;
    swapped[i + 1] = buf[offset + i]!;
  }
  return swapped.toString("utf16le");
}

export function parseBinaryPlist(input: Uint8Array): PlistValue {
  if (!(input instanceof Uint8Array) || input.byteLength < 40 || input.byteLength > MAX_PLIST_BYTES) {
    throw new Error("bplist_invalid_size");
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (input[i] !== MAGIC.charCodeAt(i)) throw new Error("bplist_invalid_magic");
  }

  const trailerOffset = input.byteLength - 32;
  const offsetIntSize = input[trailerOffset + 6]!;
  const objectRefSize = input[trailerOffset + 7]!;
  const numObjects = readUIntBE(input, trailerOffset + 8, 8);
  const topObject = readUIntBE(input, trailerOffset + 16, 8);
  const offsetTableOffset = readUIntBE(input, trailerOffset + 24, 8);

  if (
    offsetIntSize < 1 || offsetIntSize > 8 ||
    objectRefSize < 1 || objectRefSize > 8 ||
    numObjects < 1 || numObjects > MAX_OBJECTS ||
    topObject >= numObjects ||
    offsetTableOffset < 8 ||
    offsetTableOffset + numObjects * offsetIntSize > trailerOffset
  ) {
    throw new Error("bplist_invalid_trailer");
  }

  const offsets: number[] = new Array<number>(numObjects);
  for (let i = 0; i < numObjects; i += 1) {
    const entryOffset = readUIntBE(input, offsetTableOffset + i * offsetIntSize, offsetIntSize);
    if (entryOffset < 8 || entryOffset >= offsetTableOffset) {
      throw new Error("bplist_invalid_offset");
    }
    offsets[i] = entryOffset;
  }

  const visiting = new Set<number>();
  let visitedCount = 0;

  function parseObject(index: number, depth: number): PlistValue {
    if (index < 0 || index >= numObjects) throw new Error("bplist_invalid_ref");
    if (depth > MAX_DEPTH) throw new Error("bplist_max_depth");
    if (visiting.has(index)) throw new Error("bplist_cycle");
    visitedCount += 1;
    if (visitedCount > MAX_OBJECTS * 2) throw new Error("bplist_object_budget");

    visiting.add(index);
    try {
      const start = offsets[index]!;
      const marker = input[start]!;
      const kind = (marker & 0xf0) >> 4;
      const info = marker & 0x0f;

      if (kind === 0x0) {
        if (info === 0x0 || info === 0xf) return null;
        if (info === 0x8) return false;
        if (info === 0x9) return true;
        return null;
      }
      if (kind === 0x1) {
        const size = 1 << info;
        if (size > 8) throw new Error("bplist_int_too_large");
        return size === 8 ? readInt64BE(input, start + 1) : readUIntBE(input, start + 1, size);
      }
      if (kind === 0x2) {
        const size = 1 << info;
        if (size !== 4 && size !== 8) throw new Error("bplist_invalid_real");
        if (start + 1 + size > offsetTableOffset) throw new Error("bplist_out_of_bounds");
        const view = new DataView(input.buffer, input.byteOffset + start + 1, size);
        return size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
      }
      if (kind === 0x3) {
        if (info !== 0x3 || start + 9 > offsetTableOffset) throw new Error("bplist_invalid_date");
        const view = new DataView(input.buffer, input.byteOffset + start + 1, 8);
        const seconds = view.getFloat64(0, false);
        return Number.isFinite(seconds) ? Math.round(APPLE_EPOCH_OFFSET_MS + seconds * 1000) : 0;
      }
      if (kind === 0x4) {
        const { length, nextPos } = readLength(input, start + 1, info);
        if (length > MAX_STRING_BYTES || nextPos + length > offsetTableOffset) {
          throw new Error("bplist_data_too_large");
        }
        return input.slice(nextPos, nextPos + length);
      }
      if (kind === 0x5) {
        const { length, nextPos } = readLength(input, start + 1, info);
        if (length > MAX_STRING_BYTES || nextPos + length > offsetTableOffset) {
          throw new Error("bplist_string_too_large");
        }
        return Buffer.from(input.buffer, input.byteOffset + nextPos, length).toString("latin1");
      }
      if (kind === 0x6) {
        const { length, nextPos } = readLength(input, start + 1, info);
        return decodeUtf16BE(input, nextPos, length);
      }
      if (kind === 0x8) {
        const size = info + 1;
        if (size > 8) throw new Error("bplist_uid_too_large");
        return readUIntBE(input, start + 1, size);
      }
      if (kind === 0xa || kind === 0xc) {
        const { length, nextPos } = readLength(input, start + 1, info);
        if (length > MAX_OBJECTS || nextPos + length * objectRefSize > offsetTableOffset) {
          throw new Error("bplist_array_too_large");
        }
        const items: PlistValue[] = [];
        for (let i = 0; i < length; i += 1) {
          const ref = readUIntBE(input, nextPos + i * objectRefSize, objectRefSize);
          items.push(parseObject(ref, depth + 1));
        }
        return items;
      }
      if (kind === 0xd) {
        const { length, nextPos } = readLength(input, start + 1, info);
        const refsEnd = nextPos + length * 2 * objectRefSize;
        if (length > MAX_OBJECTS || refsEnd > offsetTableOffset) {
          throw new Error("bplist_dict_too_large");
        }
        const dict: Record<string, unknown> = Object.create(null);
        for (let i = 0; i < length; i += 1) {
          const keyRef = readUIntBE(input, nextPos + i * objectRefSize, objectRefSize);
          const valRef = readUIntBE(input, nextPos + (length + i) * objectRefSize, objectRefSize);
          const key = parseObject(keyRef, depth + 1);
          const value = parseObject(valRef, depth + 1);
          if (typeof key === "string" && !UNSAFE_KEYS.has(key)) {
            dict[key] = value;
          }
        }
        return dict;
      }
      return null;
    } finally {
      visiting.delete(index);
    }
  }

  return parseObject(topObject, 0);
}

function asString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\0/g, "").trim().slice(0, max);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? value as Record<string, unknown>
    : undefined;
}

export function extractNotificationPlist(blob: Uint8Array): ParsedNotificationPlist | null {
  let root: PlistValue;
  try {
    root = parseBinaryPlist(blob);
  } catch {
    return null;
  }
  const dict = asRecord(root);
  if (!dict) return null;
  const req = asRecord(dict.req) ?? dict;
  const title = asString(req.titl ?? req.title, 1_000);
  const subtitle = asString(req.subt ?? req.subtitle, 1_000);
  const body = asString(req.body, 4_000);
  const threadId = asString(req.thrd ?? req.thread, 256) || undefined;
  const identifier = asString(req.iden ?? req.ident ?? dict.iden, 200) || undefined;
  const appId = asString(dict.app, 255) || undefined;
  return { title, subtitle, body, threadId, identifier, appId };
}
