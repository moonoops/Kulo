import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POSIX_SYSTEM_STUB_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
const POSIX_SYSTEM_FALLBACK_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export interface HostPathOptions {
  basePath?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  extraDirs?: readonly string[];
}

export interface FindHostExecutableOptions extends HostPathOptions {
  extraPaths?: readonly string[];
}

function isValidAbsoluteDir(segment: string, platform: NodeJS.Platform): boolean {
  if (!segment || /[\x00-\x1f\x7f]/.test(segment)) return false;
  return platform === "win32" ? path.win32.isAbsolute(segment) : path.posix.isAbsolute(segment);
}

function listExistingVersionedDirs(parent: string, suffix: readonly string[], platform: NodeJS.Platform): string[] {
  if (platform === "win32") return [];
  try {
    const entries = fs.readdirSync(parent);
    entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
    const result: string[] = [];
    for (const entry of entries) {
      const candidate = path.posix.join(parent, entry, ...suffix);
      if (isValidAbsoluteDir(candidate, platform) && fs.existsSync(candidate)) result.push(candidate);
    }
    return result;
  } catch {
    return [];
  }
}

function wellKnownToolDirs(homeDir: string, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const appData = process.env.APPDATA ?? path.win32.join(homeDir, "AppData", "Roaming");
    return [
      path.win32.join(appData, "npm"),
      path.win32.join(programFiles, "nodejs"),
      path.win32.join(programFiles, "Git", "cmd"),
      path.win32.join(homeDir, ".local", "bin"),
      path.win32.join(homeDir, ".cargo", "bin"),
      path.win32.join(homeDir, ".bun", "bin"),
      path.win32.join(homeDir, "AppData", "Local", "Programs", "uv"),
      path.win32.join(homeDir, "AppData", "Local", "pnpm"),
    ];
  }
  const join = path.posix.join;
  const staticDirs = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/opt/local/bin",
    join(homeDir, ".local", "bin"),
    join(homeDir, ".cargo", "bin"),
    join(homeDir, ".local", "share", "mise", "shims"),
    join(homeDir, ".asdf", "shims"),
    join(homeDir, ".rye", "shims"),
    join(homeDir, ".pyenv", "shims"),
    join(homeDir, ".volta", "bin"),
    join(homeDir, ".bun", "bin"),
    ...(platform === "darwin" ? [join(homeDir, "Library", "pnpm")] : []),
    join(homeDir, ".local", "share", "pnpm"),
    join(homeDir, ".npm-global", "bin"),
    "/nix/var/nix/profiles/default/bin",
    join(homeDir, ".nix-profile", "bin"),
  ];
  const versionedDirs = [
    ...listExistingVersionedDirs(join(homeDir, ".nvm", "versions", "node"), ["bin"], platform),
    ...(platform === "darwin"
      ? listExistingVersionedDirs(join(homeDir, "Library", "Application Support", "fnm", "node-versions"), ["installation", "bin"], platform)
      : []),
    ...listExistingVersionedDirs(join(homeDir, ".fnm", "node-versions"), ["installation", "bin"], platform),
    ...listExistingVersionedDirs(join(homeDir, ".local", "share", "fnm", "node-versions"), ["installation", "bin"], platform),
  ];
  return [...staticDirs, ...versionedDirs];
}

/**
 * Builds a deduplicated PATH that preserves caller directories while ensuring
 * common user and package-manager tool directories (Homebrew, ~/.local/bin,
 * ~/.cargo/bin, mise/asdf/pyenv/nvm, etc.) remain discoverable when Kulo Hub
 * runs under macOS Finder / launchd / systemd with a minimal system PATH.
 */
export function buildAugmentedHostPath(options: HostPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const delimiter = platform === "win32" ? ";" : ":";
  const homeDir = options.homeDir ?? os.homedir();
  const basePath = options.basePath ?? process.env.PATH ?? "";

  const nonStubBase: string[] = [];
  const systemStubs: string[] = [];
  for (const rawSegment of basePath.split(delimiter)) {
    const segment = rawSegment.trim();
    if (!isValidAbsoluteDir(segment, platform)) continue;
    if (platform !== "win32" && POSIX_SYSTEM_STUB_DIRS.has(segment)) systemStubs.push(segment);
    else nonStubBase.push(segment);
  }

  const ordered = [
    ...nonStubBase,
    ...(options.extraDirs ?? []).map((dir) => dir.trim()).filter((dir) => isValidAbsoluteDir(dir, platform)),
    ...wellKnownToolDirs(homeDir, platform).filter((dir) => isValidAbsoluteDir(dir, platform)),
    ...systemStubs,
    ...(platform === "win32" ? [] : POSIX_SYSTEM_FALLBACK_DIRS),
  ];

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of ordered) {
    const key = platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(dir);
  }
  return deduped.join(delimiter);
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findHostExecutable(name: string, options: FindHostExecutableOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const delimiter = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;

  for (const explicit of options.extraPaths ?? []) {
    if (explicit && isExecutableFile(explicit)) return explicit;
  }

  const suffixes = platform === "win32" && !path.win32.extname(name)
    ? [".exe", ".cmd", ".bat", ""]
    : [""];

  const augmented = buildAugmentedHostPath(options);
  for (const dir of augmented.split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}
