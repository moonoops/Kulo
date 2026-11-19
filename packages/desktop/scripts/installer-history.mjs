import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { APP_ID, APP_NAME } from "./package.mjs";

const run = promisify(execFile);
const suffix = ".moco-backup.json";

export async function recordInstallerBackup(bundle) {
  const stat = await fs.lstat(bundle);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("旧应用备份归属无效。");
  const marker = bundle + suffix, temporary = marker + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify({
      formatVersion: 1, appId: APP_ID, basename: path.basename(bundle),
      createdAt: Date.now(), dev: stat.dev, ino: stat.ino,
    }), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, marker);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function ownedBackup(bundle) {
  let handle;
  try { handle = await fs.open(bundle + suffix, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ELOOP") return undefined; throw error; }
  let value;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 || typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
    try { value = JSON.parse(await handle.readFile("utf8")); }
    catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
  } finally { await handle.close(); }
  if (!value || value.formatVersion !== 1 || value.appId !== APP_ID || value.basename !== path.basename(bundle) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) return undefined;
  const stat = await fs.lstat(bundle);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== value.dev || stat.ino !== value.ino ||
      typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
  return value;
}

/** Only installer-owned backups outside every protected release root are eligible. */
export async function pruneInstallerBackups(destination, protectedRoots = [], keep = 2) {
  const parent = await fs.realpath(path.dirname(destination));
  const protectedCanonical = await Promise.all(protectedRoots.map((root) => fs.realpath(root)));
  const candidates = [];
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("." + APP_NAME + ".backup-") || !entry.name.endsWith(".app")) continue;
    const bundle = path.join(parent, entry.name), ownership = await ownedBackup(bundle);
    if (ownership) candidates.push({ bundle, createdAt: ownership.createdAt });
  }
  candidates.sort((a, b) => b.createdAt - a.createdAt || b.bundle.localeCompare(a.bundle));
  const preserved = new Set(candidates.slice(0, keep).map((entry) => entry.bundle));
  const { stdout } = await run("/bin/ps", ["-axo", "comm="]);
  const running = stdout.split("\n").map((line) => line.trim()).filter((file) => file.endsWith("/Contents/MacOS/" + APP_NAME));
  const executables = new Set(await Promise.all(running.map(async (file) => {
    try { return await fs.realpath(file); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  })));
  const removed = [];
  for (const { bundle } of candidates) {
    if (preserved.has(bundle) || executables.has(path.join(bundle, "Contents/MacOS", APP_NAME)) ||
        protectedCanonical.some((root) => {
          const relative = path.relative(bundle, root);
          return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
        })) continue;
    const { stdout: identifier } = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")]);
    if (identifier.trim() !== APP_ID) continue;
    try { await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]); }
    catch (error) { if (typeof error.code === "number") continue; throw error; }
    // Recheck the ownership binding after potentially slow native inspection.
    if (!await ownedBackup(bundle)) continue;
    await fs.rm(bundle, { recursive: true });
    await fs.rm(bundle + suffix, { force: true });
    removed.push(bundle);
  }
  return removed;
}
