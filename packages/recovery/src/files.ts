import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export class RecoveryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RecoveryError"; }
}

export function fail(code: string, message: string): never { throw new RecoveryError(code, message); }

export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

export function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("unsafe_directory", "恢复目录不可用。");
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);
}

/** Self-contained Windows NTFS read-only bit cleaner (keeps `@kulo/recovery` zero-dependency). */
export function clearWindowsReadonlyTreeSync(targetPath: string): void {
  if (process.platform !== "win32" || !fs.existsSync(targetPath)) return;
  const clear = (current: string) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(current); } catch { return; }
    if (st.isSymbolicLink()) return;
    try { fs.chmodSync(current, st.isDirectory() ? 0o777 : 0o666); } catch { /* best effort */ }
    if (st.isDirectory()) {
      try {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) clear(path.join(current, entry.name));
      } catch { /* best effort */ }
    }
  };
  clear(targetPath);
}

export function dataDirectory(value: string): string {
  if (!value || !path.isAbsolute(value) || path.resolve(value) === path.parse(value).root || path.resolve(value) === os.homedir()) fail("invalid_data_directory", "恢复操作需要独立的应用数据目录。");
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) fail("unsafe_directory", "恢复数据根目录不能是符号链接。");
  let current = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) fail("invalid_data_directory", "无法定位恢复数据目录。");
    current = parent;
  }
  const canonical = path.join(fs.realpathSync(current), ...missing);
  if (canonical === fs.realpathSync(os.homedir()) || canonical === path.parse(canonical).root) fail("invalid_data_directory", "恢复操作需要独立的应用数据目录。");
  return canonical;
}

export function readText(filename: string, limit = 1024 * 1024): string {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit) fail("invalid_metadata", "恢复记录无效或超过大小限制。");
    return fs.readFileSync(descriptor, "utf8");
  } finally { fs.closeSync(descriptor); }
}

export function readJson(filename: string, limit?: number): unknown { return JSON.parse(readText(filename, limit)); }

export function atomicJson(filename: string, value: unknown): void {
  const temporary = path.join(path.dirname(filename), "." + path.basename(filename) + "-" + randomUUID() + ".tmp");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value) + "\n");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
    if (process.platform !== "win32") {
      const parent = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY);
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  } finally {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}

export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export function redact(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/([?&](?:token|key|api_key|secret|password)=)[^\s&#]+/gi, "$1[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[redacted]")
    .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, "https://[redacted]@")
    .slice(0, 4096);
}

/** An owner-specific filename prevents one stale-lock reclaimer removing a new owner's marker. */
export function operationLock(directory: string, isAlive: (pid: number) => boolean): () => void {
  const lock = path.join(directory, ".mutation-lock");
  const marker = process.pid + "-" + randomUUID() + ".owner";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      const identity = fs.lstatSync(lock);
      try {
        fs.writeFileSync(path.join(lock, marker), "", { flag: "wx", mode: 0o600 });
        const current = fs.lstatSync(lock);
        if (current.ino !== identity.ino || current.dev !== identity.dev) fail("recovery_busy", "恢复锁已被其他操作接管。");
      } catch (error) {
        try { fs.unlinkSync(path.join(lock, marker)); } catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw cleanup; }
        try { fs.rmdirSync(lock); } catch (cleanup) { if (!["ENOENT", "ENOTEMPTY"].includes((cleanup as NodeJS.ErrnoException).code ?? "")) throw cleanup; }
        throw error;
      }
      return () => {
        fs.unlinkSync(path.join(lock, marker));
        fs.rmdirSync(lock);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_lock", "恢复操作锁无效。");
    const entries = fs.readdirSync(lock);
    if (entries.length === 0 && Date.now() - stat.mtimeMs > 30_000) {
      try { fs.rmdirSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      continue;
    }
    if (entries.length !== 1) fail("recovery_busy", "另一个恢复操作尚未结束，请稍后重试。");
    const owner = /^([1-9]\d*)-[a-f0-9-]{36}\.owner$/.exec(entries[0]!);
    if (!owner || isAlive(Number(owner[1]))) fail("recovery_busy", "另一个恢复操作正在进行。");
    try { fs.unlinkSync(path.join(lock, entries[0]!)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    try { fs.rmdirSync(lock); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
  }
  return fail("recovery_busy", "无法取得恢复操作锁。");
}
