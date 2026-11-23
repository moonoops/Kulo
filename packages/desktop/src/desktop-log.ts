import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactDiagnosticText } from "@kulo/recovery";
import { atomicReplaceDesktopFileSync } from "./desktop-fs.js";

export const DESKTOP_LOG_FILE_BYTES = 4 * 1024 * 1024;
const ENTRY_BYTES = 64 * 1024;

function regularFile(file: string): fs.Stats | undefined {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("桌面日志不是当前用户的普通文件。");
  }
  return stat;
}

function tail(file: string, size: number): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Math.min(size, DESKTOP_LOG_FILE_BYTES);
    const result = Buffer.alloc(bytes);
    fs.readSync(descriptor, result, 0, bytes, Math.max(0, size - bytes));
    return result;
  } finally { fs.closeSync(descriptor); }
}

function replace(file: string, bytes: Buffer): void {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    atomicReplaceDesktopFileSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function writeDesktopLog(dataDir: string, message: string, managementToken?: string): void {
  const file = path.join(dataDir, "desktop.log"), previous = file + ".previous";
  const clean = redactDiagnosticText(managementToken ? message.replaceAll(managementToken, "[已隐藏]") : message);
  let line = Buffer.from(new Date().toISOString() + " " + clean + "\n");
  if (line.length > ENTRY_BYTES) line = Buffer.concat([line.subarray(0, ENTRY_BYTES - 16), Buffer.from("\n[已截断]\n")]);
  const old = regularFile(previous);
  if (old && old.size > DESKTOP_LOG_FILE_BYTES) replace(previous, tail(previous, old.size));
  const current = regularFile(file);
  if (current && current.size + line.length > DESKTOP_LOG_FILE_BYTES) {
    replace(previous, tail(file, current.size));
    fs.unlinkSync(file);
  }
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeSync(descriptor, line); }
  finally { fs.closeSync(descriptor); }
}
