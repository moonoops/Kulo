import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_UUID = 0x1b;
const LC_UUID_SIZE = 24;
const MACH_HEADER_64_SIZE = 32;

export function formatMachOUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex").toUpperCase();
  if (hex.length !== 32) throw new Error("Mach-O UUID 长度无效。");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function deriveDeterministicMachOUuid({ appId, role, cpuType, originalUuid }) {
  if (!appId || !role || !originalUuid) throw new Error("生成 Mach-O UUID 缺少必要标识。");
  const digest = createHash("sha256")
    .update(`kulo-macho-uuid-v1:${appId}:${role}:${cpuType}:${String(originalUuid).toUpperCase()}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

function listMachOSlices(buffer) {
  if (buffer.length < MACH_HEADER_64_SIZE) throw new Error("Mach-O 文件头长度不足。");
  const magicLE = buffer.readUInt32LE(0);
  if (magicLE === MH_MAGIC_64) {
    return [{ offset: 0, size: buffer.length }];
  }
  const magicBE = buffer.readUInt32BE(0);
  if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
    const isFat64 = magicBE === FAT_MAGIC_64;
    const count = buffer.readUInt32BE(4);
    const entrySize = isFat64 ? 32 : 20;
    if (count === 0 || count > 16 || 8 + count * entrySize > buffer.length) {
      throw new Error("Universal Mach-O 切片表无效。");
    }
    const slices = [];
    for (let i = 0; i < count; i++) {
      const entry = 8 + i * entrySize;
      const offset = isFat64 ? Number(buffer.readBigUInt64BE(entry + 8)) : buffer.readUInt32BE(entry + 8);
      const size = isFat64 ? Number(buffer.readBigUInt64BE(entry + 16)) : buffer.readUInt32BE(entry + 12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < MACH_HEADER_64_SIZE || offset + size > buffer.length) {
        throw new Error("Universal Mach-O 切片偏移越界。");
      }
      slices.push({ offset, size });
    }
    return slices;
  }
  throw new Error(`不支持的 Mach-O 文件格式（magic=0x${magicLE.toString(16)}）。`);
}

function locateSliceUuidCommand(buffer, slice) {
  const { offset, size } = slice;
  if (buffer.readUInt32LE(offset) !== MH_MAGIC_64) {
    throw new Error("仅支持 64-bit Little-Endian Mach-O 切片。");
  }
  const cpuType = buffer.readUInt32LE(offset + 4);
  const ncmds = buffer.readUInt32LE(offset + 16);
  const sizeofcmds = buffer.readUInt32LE(offset + 20);
  const cmdsEnd = offset + MACH_HEADER_64_SIZE + sizeofcmds;
  if (cmdsEnd > offset + size) throw new Error("Mach-O load commands 越界。");
  let cursor = offset + MACH_HEADER_64_SIZE;
  for (let i = 0; i < ncmds; i++) {
    if (cursor + 8 > cmdsEnd) throw new Error("Mach-O load command 截断。");
    const cmd = buffer.readUInt32LE(cursor);
    const cmdsize = buffer.readUInt32LE(cursor + 4);
    if (cmdsize < 8 || cursor + cmdsize > cmdsEnd) throw new Error("Mach-O load command 大小无效。");
    if (cmd === LC_UUID) {
      if (cmdsize !== LC_UUID_SIZE) throw new Error("Mach-O LC_UUID 大小异常。");
      return { cpuType, uuidOffset: cursor + 8 };
    }
    cursor += cmdsize;
  }
  throw new Error("Mach-O 切片缺少 LC_UUID 命令。");
}

export function readMachOUuidsFromBuffer(buffer) {
  return listMachOSlices(buffer).map((slice) => {
    const { cpuType, uuidOffset } = locateSliceUuidCommand(buffer, slice);
    return { cpuType, uuid: formatMachOUuid(buffer.subarray(uuidOffset, uuidOffset + 16)) };
  });
}

export function patchMachOUuidBuffer(buffer, { appId, role }) {
  const copy = Buffer.from(buffer);
  const slices = listMachOSlices(copy).map((slice) => {
    const { cpuType, uuidOffset } = locateSliceUuidCommand(copy, slice);
    const originalUuid = formatMachOUuid(copy.subarray(uuidOffset, uuidOffset + 16));
    const nextBytes = deriveDeterministicMachOUuid({ appId, role, cpuType, originalUuid });
    const patchedUuid = formatMachOUuid(nextBytes);
    if (patchedUuid === originalUuid) throw new Error("派生的 Mach-O UUID 与原值冲突。");
    nextBytes.copy(copy, uuidOffset);
    return { cpuType, originalUuid, patchedUuid };
  });
  return { buffer: copy, slices };
}

export async function patchMachOUuidFile(executablePath, { appId, role }) {
  const original = await fs.readFile(executablePath);
  const { buffer, slices } = patchMachOUuidBuffer(original, { appId, role });
  await fs.writeFile(executablePath, buffer);
  return { role, executablePath, slices };
}

/**
 * Rewrites LC_UUID deterministically on the main app launcher and the 4 Electron Helper launchers
 * (never touching `Electron Framework` or `runtime/node`) so macOS `nehelper` / Local Network privacy
 * never collides across channels (`io.kulo.desktop`, `io.kulo.desktop.dev`, legacy `io.moco.desktop.dev`).
 */
export async function patchMacAppBundleUuids(bundlePath, { appId, appName }) {
  const targets = [
    { role: "main", executablePath: path.join(bundlePath, "Contents/MacOS", appName), required: true },
    { role: "helper", executablePath: path.join(bundlePath, "Contents/Frameworks", `${appName} Helper.app/Contents/MacOS`, `${appName} Helper`), required: true },
    { role: "helper-gpu", executablePath: path.join(bundlePath, "Contents/Frameworks", `${appName} Helper (GPU).app/Contents/MacOS`, `${appName} Helper (GPU)`), required: true },
    { role: "helper-plugin", executablePath: path.join(bundlePath, "Contents/Frameworks", `${appName} Helper (Plugin).app/Contents/MacOS`, `${appName} Helper (Plugin)`), required: true },
    { role: "helper-renderer", executablePath: path.join(bundlePath, "Contents/Frameworks", `${appName} Helper (Renderer).app/Contents/MacOS`, `${appName} Helper (Renderer)`), required: true },
  ];
  const results = [];
  for (const target of targets) {
    let stat;
    try {
      stat = await fs.lstat(target.executablePath);
    } catch (error) {
      if (error.code === "ENOENT" && !target.required) continue;
      throw new Error(`打包产物缺少预期可执行文件：${target.executablePath}`, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`打包产物可执行文件类型无效：${target.executablePath}`);
    }
    results.push(await patchMachOUuidFile(target.executablePath, { appId, role: target.role }));
  }
  return results;
}
