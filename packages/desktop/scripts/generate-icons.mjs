import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodeRgbaPng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIG)) throw new Error("Not a valid PNG file.");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idatChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (bitDepth !== 8 || colorType !== 6) {
        throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType}); expected 8-bit RGBA.`);
      }
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * 4;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[rowStart + x];
      const left = x >= 4 ? rgba[outStart + x - 4] : 0;
      const up = y > 0 ? rgba[outStart - stride + x] : 0;
      const upLeft = y > 0 && x >= 4 ? rgba[outStart - stride + x - 4] : 0;
      let recon = value;
      if (filter === 1) recon = (value + left) & 0xff;
      else if (filter === 2) recon = (value + up) & 0xff;
      else if (filter === 3) recon = (value + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) recon = (value + paeth(left, up, upLeft)) & 0xff;
      rgba[outStart + x] = recon;
    }
  }
  return { width, height, rgba };
}

function encodeRgbaPng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(filtered, { level: 9 });
  return Buffer.concat([
    PNG_SIG,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function downsampleRgba(src, targetSize) {
  const { width, height, rgba } = src;
  const out = Buffer.alloc(targetSize * targetSize * 4);
  const scaleX = width / targetSize;
  const scaleY = height / targetSize;
  for (let ty = 0; ty < targetSize; ty++) {
    const y0 = Math.floor(ty * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((ty + 1) * scaleY)));
    for (let tx = 0; tx < targetSize; tx++) {
      const x0 = Math.floor(tx * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((tx + 1) * scaleX)));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const idx = (sy * width + sx) * 4;
          const alpha = rgba[idx + 3];
          r += rgba[idx] * alpha;
          g += rgba[idx + 1] * alpha;
          b += rgba[idx + 2] * alpha;
          a += alpha;
          count++;
        }
      }
      const outIdx = (ty * targetSize + tx) * 4;
      const avgA = Math.round(a / count);
      out[outIdx + 3] = avgA;
      if (a > 0) {
        out[outIdx] = Math.round(r / a);
        out[outIdx + 1] = Math.round(g / a);
        out[outIdx + 2] = Math.round(b / a);
      }
    }
  }
  return encodeRgbaPng(targetSize, targetSize, out);
}

/** Encodes PNG frames into a standard multi-resolution Windows .ico container. */
export function encodeIcoFromPngFrames(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(frames.length * 16);
  let imageOffset = 6 + dir.length;
  for (let i = 0; i < frames.length; i++) {
    const { size, png } = frames[i];
    const base = i * 16;
    dir[base] = size >= 256 ? 0 : size;
    dir[base + 1] = size >= 256 ? 0 : size;
    dir[base + 2] = 0;
    dir[base + 3] = 0;
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bpp
    dir.writeUInt32LE(png.length, base + 8);
    dir.writeUInt32LE(imageOffset, base + 12);
    imageOffset += png.length;
  }
  return Buffer.concat([header, dir, ...frames.map((frame) => frame.png)]);
}

/** Creates a solid monochrome tinted RGBA PNG preserving the alpha channel of a template silhouette. */
export function tintMonochromePng(pngBuffer, rgb) {
  const { width, height, rgba } = decodeRgbaPng(pngBuffer);
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    if (alpha > 0) {
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      out[i + 3] = alpha;
    }
  }
  return encodeRgbaPng(width, height, out);
}

function resizeIconFrame(sourcePngPath, decodedSource, size) {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sips")) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-ico-"));
    try {
      const target = path.join(tempDir, `icon-${size}.png`);
      execFileSync("/usr/bin/sips", ["-z", String(size), String(size), sourcePngPath, "--out", target], { stdio: "ignore" });
      return fs.readFileSync(target);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
  return downsampleRgba(decodedSource, size);
}

export function generateCrossPlatformIcons(assetsDir) {
  const iconPngPath = path.join(assetsDir, "kulo-icon.png");
  const iconBytes = fs.readFileSync(iconPngPath);
  const decodedIcon = decodeRgbaPng(iconBytes);
  const frames = ICO_SIZES.map((size) => ({
    size,
    png: resizeIconFrame(iconPngPath, decodedIcon, size),
  }));
  const icoPath = path.join(assetsDir, "kulo.ico");
  fs.writeFileSync(icoPath, encodeIcoFromPngFrames(frames));

  for (const suffix of ["", "@2x"]) {
    const templatePath = path.join(assetsDir, `kulo-trayTemplate${suffix}.png`);
    const templateBytes = fs.readFileSync(templatePath);
    // Light taskbar / menu bar: dark silhouette (#18181B)
    fs.writeFileSync(path.join(assetsDir, `kulo-tray-light${suffix}.png`), tintMonochromePng(templateBytes, [24, 24, 27]));
    // Dark taskbar / panel: crisp light silhouette (#F4F4F5)
    fs.writeFileSync(path.join(assetsDir, `kulo-tray-dark${suffix}.png`), tintMonochromePng(templateBytes, [244, 244, 245]));
  }
  return {
    icoPath,
    trayIcons: [
      "kulo-tray-light.png",
      "kulo-tray-light@2x.png",
      "kulo-tray-dark.png",
      "kulo-tray-dark@2x.png",
    ].map((name) => path.join(assetsDir, name)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const assetsDir = fileURLToPath(new URL("../assets", import.meta.url));
  const result = generateCrossPlatformIcons(assetsDir);
  console.log(`Generated ${result.icoPath} and ${result.trayIcons.length} cross-platform tray icons.`);
}
