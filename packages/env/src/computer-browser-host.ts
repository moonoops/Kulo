import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MacosChromeBackgroundTaskState = "allowed" | "disallowed" | "unknown";

export interface ManagedBrowserExecutable {
  executablePath?: string;
  source?: "env" | "chrome-for-testing";
}

interface BrowserCandidate {
  path: string;
  archScore: number;
  productScore: number;
  version: number[];
  cachePriority: number;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function extractVersionTuple(name: string): number[] {
  const match = name.match(/(\d+(?:\.\d+)*)/);
  if (!match) return [0];
  return match[1]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function macosRelativeCandidates(arch: string): Array<{ rel: string; archScore: number; productScore: number }> {
  const cft = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const chromium = "Chromium.app/Contents/MacOS/Chromium";
  if (arch === "arm64") {
    return [
      { rel: path.join("chrome-mac-arm64", cft), archScore: 3, productScore: 2 },
      { rel: path.join("chrome-mac-arm64", chromium), archScore: 3, productScore: 1 },
      { rel: path.join("chrome-mac", cft), archScore: 2, productScore: 2 },
      { rel: path.join("chrome-mac", chromium), archScore: 2, productScore: 1 },
      { rel: path.join("chrome-mac-x64", cft), archScore: 1, productScore: 2 },
      { rel: path.join("chrome-mac-x64", chromium), archScore: 1, productScore: 1 },
    ];
  }
  return [
    { rel: path.join("chrome-mac-x64", cft), archScore: 3, productScore: 2 },
    { rel: path.join("chrome-mac", cft), archScore: 2, productScore: 2 },
    { rel: path.join("chrome-mac-x64", chromium), archScore: 3, productScore: 1 },
    { rel: path.join("chrome-mac", chromium), archScore: 2, productScore: 1 },
  ];
}

/**
 * Resolves an isolated browser binary for managed agent-browser sessions.
 *
 * Explicit env overrides always win. On macOS, when no override is configured,
 * prefer an installed automation-dedicated browser (Chrome for Testing / Chromium)
 * over /Applications/Google Chrome.app so macOS Background Task Management (BTM)
 * settings for the user's personal Google Chrome cannot force-quit headless sessions.
 */
export function resolveManagedBrowserExecutable(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): ManagedBrowserExecutable {
  const env = options.env ?? process.env;
  const explicit = (env.KULO_BROWSER_EXECUTABLE_PATH ?? env.AGENT_BROWSER_EXECUTABLE_PATH ?? "").trim();
  if (explicit) return { executablePath: explicit, source: "env" };

  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return {};

  const arch = options.arch ?? process.arch;
  const homeDir = options.homeDir ?? os.homedir();
  const roots: Array<{ dir: string; prefix: RegExp; priority: number }> = [
    { dir: path.join(homeDir, ".agent-browser", "browsers"), prefix: /^chrome/i, priority: 3 },
    { dir: path.join(homeDir, ".cache", "puppeteer", "chrome"), prefix: /^(?:mac_arm-|mac-|chrome)/i, priority: 2 },
    { dir: path.join(homeDir, "Library", "Caches", "ms-playwright"), prefix: /^chromium-/i, priority: 1 },
  ];

  const rels = macosRelativeCandidates(arch);
  const found: BrowserCandidate[] = [];

  for (const root of roots) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root.dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !root.prefix.test(entry.name)) continue;
      if (arch !== "arm64" && /^mac_arm-/i.test(entry.name)) continue;
      const versionDir = path.join(root.dir, entry.name);
      const version = extractVersionTuple(entry.name);
      for (const rel of rels) {
        const candidate = path.join(versionDir, rel.rel);
        if (!isExecutableFile(candidate)) continue;
        const dirArchBonus = arch === "arm64" && /^mac_arm-/i.test(entry.name) ? 1 : 0;
        found.push({
          path: candidate,
          archScore: rel.archScore + dirArchBonus,
          productScore: rel.productScore,
          version,
          cachePriority: root.priority,
        });
        break;
      }
    }
  }

  if (!found.length) return {};
  found.sort((a, b) =>
    (b.archScore - a.archScore)
    || (b.productScore - a.productScore)
    || compareVersions(b.version, a.version)
    || (b.cachePriority - a.cachePriority)
    || a.path.localeCompare(b.path),
  );
  return { executablePath: found[0]!.path, source: "chrome-for-testing" };
}

/**
 * Parses `sfltool dumpbtm` output for Google Chrome's macOS background tasks entry.
 */
export function parseMacosChromeBackgroundTasksStatus(output: string): MacosChromeBackgroundTaskState {
  const blocks = output.split(/^\s*#\d+:\s*$/m);
  for (const block of blocks) {
    let identifier = "";
    let parentIdentifier = "";
    let type = "";
    let disposition = "";
    for (const rawLine of block.split(/\r?\n/)) {
      const idx = rawLine.indexOf(":");
      if (idx === -1) continue;
      const key = rawLine.slice(0, idx).trim().toLowerCase();
      const value = rawLine.slice(idx + 1).trim();
      if (key === "identifier") identifier = value;
      else if (key === "parent identifier") parentIdentifier = value;
      else if (key === "type") type = value;
      else if (key === "disposition") disposition = value;
    }
    const isChromeBackgroundTasks =
      identifier === "8192.com.google.Chrome"
      || (parentIdentifier === "2.com.google.Chrome" && /^background tasks\b/i.test(type));
    if (!isChromeBackgroundTasks) continue;
    const bracket = disposition.match(/\[([^\]]*)\]/);
    if (!bracket) return "unknown";
    const flags = bracket[1]!.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (flags.includes("disallowed")) return "disallowed";
    if (flags.includes("allowed")) return "allowed";
    return "unknown";
  }
  return "unknown";
}

export async function checkMacosChromeBackgroundTasks(
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<MacosChromeBackgroundTaskState> {
  if (platform !== "darwin" || process.platform !== "darwin" || signal?.aborted) return "unknown";
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/sfltool",
      ["dumpbtm"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024, signal },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve("unknown");
          return;
        }
        resolve(parseMacosChromeBackgroundTasksStatus(stdout));
      },
    );
  });
}
