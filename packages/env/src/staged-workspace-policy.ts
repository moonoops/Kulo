import fs from "node:fs";

const LIFECYCLE_SCRIPT_KEYS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "preversion",
  "version",
  "postversion",
]);

function readPackageLifecycleScripts(filePath: string | undefined): { valid: boolean; scripts: Record<string, string> } {
  if (!filePath || !fs.existsSync(filePath)) return { valid: true, scripts: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { valid: false, scripts: {} };
    const rawScripts = (parsed as { scripts?: unknown }).scripts;
    if (!rawScripts || typeof rawScripts !== "object" || Array.isArray(rawScripts)) return { valid: true, scripts: {} };
    const scripts: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawScripts as Record<string, unknown>)) {
      if (LIFECYCLE_SCRIPT_KEYS.has(key) && typeof value === "string") {
        scripts[key] = value;
      }
    }
    return { valid: true, scripts };
  } catch {
    return { valid: false, scripts: {} };
  }
}

export function hasPackageLifecycleScriptChange(
  beforePath: string | undefined,
  afterPath: string | undefined,
): boolean {
  const before = readPackageLifecycleScripts(beforePath);
  const after = readPackageLifecycleScripts(afterPath);
  if (!after.valid) return true;
  const keys = new Set([...Object.keys(before.scripts), ...Object.keys(after.scripts)]);
  for (const key of keys) {
    if (before.scripts[key] !== after.scripts[key]) return true;
  }
  return false;
}

const AGENT_RULE_FILENAME_RE = /(?:^|\/)(?:agents(?:\.override)?\.md|claude\.md)$/i;

/**
 * Identifies paths whose modification can auto-execute code, alter repo hooks/CI, or inject
 * repository-level agent instructions. Ordinary file deletions/renames are intentionally excluded.
 */
export function isAutoExecSensitivePath(
  relPosix: string,
  beforePath: string | undefined,
  afterPath: string | undefined,
): boolean {
  if (
    relPosix === ".husky" ||
    relPosix.startsWith(".husky/") ||
    relPosix.includes("/.husky/") ||
    relPosix === ".envrc" ||
    relPosix.endsWith("/.envrc") ||
    relPosix === ".vscode" ||
    relPosix.startsWith(".vscode/") ||
    relPosix.includes("/.vscode/") ||
    relPosix === ".github/workflows" ||
    relPosix.startsWith(".github/workflows/") ||
    relPosix.includes("/.github/workflows/") ||
    AGENT_RULE_FILENAME_RE.test(relPosix)
  ) {
    return true;
  }
  if (relPosix === "package.json" || relPosix.endsWith("/package.json")) {
    return hasPackageLifecycleScriptChange(beforePath, afterPath);
  }
  return false;
}
