import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";

const linkedom = createRequire(new URL("../../hub/package.json", import.meta.url))("linkedom") as {
  DOMParser: new () => DOMParser;
};

export function createTestDomParser(): DOMParser {
  return new linkedom.DOMParser();
}

export interface TestZipEntryInput {
  name: string;
  content: string | Uint8Array;
  method?: 0 | 8;
  flags?: number;
  /** Override declared uncompressedSize in Central Directory (e.g. 0 for Zip Bomb simulation). */
  declaredUncompressedSize?: number;
  /** Use Data Descriptor mode (bit 3): local header sizes set to 0, real sizes in Central Directory. */
  dataDescriptor?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function buildTestZip(entries: readonly TestZipEntryInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const rawBytes = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const nameBytes = encoder.encode(entry.name);
    const method = entry.method ?? 8;
    const payload = method === 8 ? new Uint8Array(deflateRawSync(rawBytes)) : rawBytes;
    const crc = crc32(rawBytes);
    const flags = (entry.flags ?? 0) | (entry.dataDescriptor ? 0x0008 : 0);
    const declaredUncompressed = entry.declaredUncompressedSize ?? rawBytes.byteLength;

    const localHeader = new Uint8Array(30 + nameBytes.byteLength);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, entry.dataDescriptor ? 0 : crc, true);
    lv.setUint32(18, entry.dataDescriptor ? 0 : payload.byteLength, true);
    lv.setUint32(22, entry.dataDescriptor ? 0 : declaredUncompressed, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const dd = entry.dataDescriptor ? new Uint8Array(16) : new Uint8Array(0);
    if (entry.dataDescriptor) {
      const dv = new DataView(dd.buffer);
      dv.setUint32(0, 0x08074b50, true);
      dv.setUint32(4, crc, true);
      dv.setUint32(8, payload.byteLength, true);
      dv.setUint32(12, declaredUncompressed, true);
    }

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.byteLength, true);
    cv.setUint32(24, declaredUncompressed, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localParts.push(localHeader, payload, dd);
    centralParts.push(central);
    offset += localHeader.byteLength + payload.byteLength + dd.byteLength;
  }

  const cdOffset = offset;
  const cdSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);

  const total = offset + cdSize + eocd.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

/** 1×1 transparent PNG binary fixture. */
export const TINY_PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
