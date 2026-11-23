import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const WINDOWS_RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const DEFAULT_RENAME_RETRIES = 5;

export function isWindowsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function safeChmodSync(filePath: string, mode: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  fs.chmodSync(filePath, mode);
}

export function safeFchmodSync(fd: number, mode: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  fs.fchmodSync(fd, mode);
}

export async function safeHandleChmod(
  handle: fsp.FileHandle,
  mode: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") return;
  await handle.chmod(mode);
}

/**
 * Checks POSIX group/other permission bits only on POSIX platforms.
 * On Windows, POSIX mode bits do not reflect NTFS DACLs.
 */
export function hasForbiddenPosixPermissions(
  stat: Pick<fs.Stats, "mode">,
  mask = 0o077,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return false;
  return (stat.mode & mask) !== 0;
}

export function isOwnerMismatch(stat: Pick<fs.Stats, "uid">): boolean {
  return typeof process.getuid === "function" && stat.uid !== process.getuid();
}

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Atomically replaces `targetPath` with `temporaryPath`.
 * On Windows, retries transient `EPERM`/`EBUSY`/`EACCES` caused by antivirus scanners.
 */
export function atomicReplaceFileSync(
  temporaryPath: string,
  targetPath: string,
  options: { platform?: NodeJS.Platform; maxRetries?: number } = {},
): void {
  const platform = options.platform ?? process.platform;
  const maxRetries = platform === "win32" ? (options.maxRetries ?? DEFAULT_RENAME_RETRIES) : 0;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporaryPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= maxRetries || !code || !WINDOWS_RETRYABLE_RENAME_CODES.has(code)) {
        throw error;
      }
      sleepSync(Math.min(100, 10 * (attempt + 1)));
    }
  }
}

export async function atomicReplaceFile(
  temporaryPath: string,
  targetPath: string,
  options: { platform?: NodeJS.Platform; maxRetries?: number } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const maxRetries = platform === "win32" ? (options.maxRetries ?? DEFAULT_RENAME_RETRIES) : 0;
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= maxRetries || !code || !WINDOWS_RETRYABLE_RENAME_CODES.has(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}

function clearReadonlyAttributesSync(targetPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  try {
    fs.chmodSync(targetPath, stat.isDirectory() ? 0o777 : 0o666);
  } catch {
    // Ignore permission errors on best-effort cleanup
  }
  if (stat.isDirectory()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      clearReadonlyAttributesSync(path.join(targetPath, entry.name));
    }
  }
}

/**
 * Recursively deletes a path, clearing Windows NTFS read-only flags first so cleanup
 * never leaks directories due to `EPERM`.
 */
export function removeReadonlyTreeSync(targetPath: string, platform: NodeJS.Platform = process.platform): void {
  if (!fs.existsSync(targetPath)) return;
  if (platform === "win32") {
    clearReadonlyAttributesSync(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    return;
  }
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      clearReadonlyAttributesSync(targetPath);
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

export async function removeReadonlyTree(targetPath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    clearReadonlyAttributesSync(targetPath);
    await fsp.rm(targetPath, { recursive: true, force: true });
    return;
  }
  try {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      clearReadonlyAttributesSync(targetPath);
      await fsp.rm(targetPath, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}
