import fs from "node:fs";
import fsp from "node:fs/promises";

const WINDOWS_RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function safeDesktopChmodSync(target: string, mode: number): void {
  if (process.platform === "win32") return;
  fs.chmodSync(target, mode);
}

export function safeDesktopFchmodSync(fd: number, mode: number): void {
  if (process.platform === "win32") return;
  fs.fchmodSync(fd, mode);
}

export async function safeDesktopChmod(target: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  await fsp.chmod(target, mode);
}

export function hasDesktopForbiddenPosixPermissions(stat: Pick<fs.Stats, "mode">): boolean {
  if (process.platform === "win32") return false;
  return (stat.mode & 0o077) !== 0;
}

export function atomicReplaceDesktopFileSync(tempPath: string, targetPath: string): void {
  const maxAttempts = process.platform === "win32" ? 5 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < maxAttempts && code && WINDOWS_RETRYABLE_CODES.has(code)) {
        const deadline = Date.now() + 20 * attempt;
        while (Date.now() < deadline) {
          // Brief synchronous spin for Windows Defender / indexer lock release.
        }
        continue;
      }
      throw error;
    }
  }
}

export async function atomicReplaceDesktopFile(tempPath: string, targetPath: string): Promise<void> {
  const maxAttempts = process.platform === "win32" ? 5 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fsp.rename(tempPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < maxAttempts && code && WINDOWS_RETRYABLE_CODES.has(code)) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        continue;
      }
      throw error;
    }
  }
}
