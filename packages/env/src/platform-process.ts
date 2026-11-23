import fs from "node:fs";
import path from "node:path";

export const WINDOWS_CORE_ENV_KEYS = [
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
] as const;

export function preserveWindowsCoreEnv(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return target;
  for (const key of WINDOWS_CORE_ENV_KEYS) {
    if (target[key] === undefined && source[key] !== undefined) {
      target[key] = source[key];
    }
  }
  return target;
}

export function quoteWindowsCmdArg(arg: string): string {
  if (/[\0\r\n]/.test(arg)) {
    throw new Error("Windows command argument cannot contain NUL or newline characters");
  }
  if (/%[A-Za-z_][A-Za-z0-9_]*%|%~/.test(arg)) {
    throw new Error("Windows command argument cannot contain cmd.exe variable expansion sequences");
  }
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1""')
    .replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

function locateWindowsCmdPath(
  cmdPath: string,
  envPath?: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (/[\\/]/.test(cmdPath)) return cmdPath;
  const rawPath = envPath ?? process.env.PATH ?? process.env.Path ?? "";
  if (!rawPath) return undefined;
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const entry of rawPath.split(delimiter)) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed) continue;
    const candidate = path.join(trimmed, cmdPath);
    try {
      if (fs.lstatSync(candidate).isFile()) return candidate;
    } catch {
      // Try next PATH entry
    }
  }
  return undefined;
}

/**
 * Inspects standard npm/pnpm `.cmd` shims (`"%dp0%\..."` / `"%~dp0\..."`) and returns
 * the underlying JS entrypoint when it resolves cleanly inside the shim's directory tree.
 * Executing that JS file directly with `process.execPath` avoids Node 22+ CVE-2024-27980 `EINVAL`
 * without invoking `cmd.exe`.
 */
export function resolveWindowsNpmCmdTarget(
  cmdPath: string,
  options: { envPath?: string; platform?: NodeJS.Platform } = {},
): { scriptPath: string } | undefined {
  if (!/\.(?:cmd|bat)$/i.test(cmdPath)) return undefined;
  const actualCmdPath = locateWindowsCmdPath(cmdPath, options.envPath, options.platform ?? "win32");
  if (!actualCmdPath) return undefined;
  let content: string;
  try {
    const stat = fs.lstatSync(actualCmdPath);
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
    content = fs.readFileSync(actualCmdPath, "utf8");
  } catch {
    return undefined;
  }
  const baseDir = path.dirname(actualCmdPath);
  const matches = [
    ...content.matchAll(/"(?:%dp0%[\\/]+|%~dp0[\\/]*?)([^"\r\n]+?\.(?:c?js|mjs))"/gi),
  ];
  for (const match of matches) {
    const relative = match[1]?.replace(/\\/g, path.sep);
    if (!relative) continue;
    const candidate = path.resolve(baseDir, relative);
    try {
      if (fs.lstatSync(candidate).isFile()) {
        return { scriptPath: candidate };
      }
    } catch {
      // Try next match
    }
  }
  return undefined;
}

export interface CrossPlatformSpawnSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  windowsHide: true;
}

/**
 * Prepares safe spawn arguments across platforms, handling Windows `.cmd`/`.bat`
 * execution under Node 22+ (`CVE-2024-27980`, where `shell: false` throws `EINVAL`).
 */
export function resolveCrossPlatformSpawn(
  command: string,
  args: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    execPath?: string;
    comSpec?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): CrossPlatformSpawnSpec {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args: [...args], windowsHide: true };
  }
  const envPath = options.env?.PATH ?? options.env?.Path ?? process.env.PATH ?? process.env.Path;
  const resolvedJs = resolveWindowsNpmCmdTarget(command, { envPath, platform });
  if (resolvedJs) {
    return {
      command: options.execPath ?? process.execPath,
      args: [resolvedJs.scriptPath, ...args],
      windowsHide: true,
    };
  }
  const comSpec = options.comSpec ?? options.env?.ComSpec ?? options.env?.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  const commandLine = `${quoteWindowsCmdArg(command)} ${args.map(quoteWindowsCmdArg).join(" ")}`.trim();
  return {
    command: comSpec,
    args: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
    windowsHide: true,
  };
}

/**
 * On Windows, explicitly resolves `%SystemRoot%\System32\tar.exe` (bsdtar) so Git for Windows'
 * GNU `tar.exe` does not misinterpret `C:\...` paths as remote `host:file` specs.
 */
export function resolveSystemTarExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return "tar";
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (root) {
    const candidate = path.win32.join(root, "System32", "tar.exe");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Fall back to PATH lookup
    }
  }
  return "tar.exe";
}
