import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  inspectSensitiveText,
  isValidMcpEnvKey,
  redactSensitiveText,
  type McpAuthMode,
  type MigrationStdioPrefill,
  type MigrationStdioRiskFlag,
} from "@kulo/protocol";
import { isCloudMetadataHostOrIp } from "./net-policy.js";

export const MIGRATION_MAX_CONFIG_BYTES = 2 * 1024 * 1024;
export const MIGRATION_MAX_SKILL_FILES = 512;
export const MIGRATION_MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
export const MIGRATION_MAX_SKILL_PACKAGE_BYTES = 16 * 1024 * 1024;
export const MIGRATION_MAX_SKILL_MD_BYTES = 256 * 1024;
export const MIGRATION_MAX_SKILL_DEPTH = 24;

export const SKILL_IGNORED = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  ".gitignore",
  ".gitattributes",
  ".ignore",
  ".fdignore",
]);
export const SKILL_HARMLESS_DOTFILES = new Set([".gitkeep", ".keep"]);
export const SKILL_SENSITIVE_NAME =
  /^(?:\.env(?:\..+)?|credentials?(?:\.[^.]+)?|auth\.json|secrets?(?:\.[^.]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:key|pem|p12|pfx))$/i;
export const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

const FORBIDDEN_HEADER_NAMES =
  /^(?:host|cookie|set-cookie|proxy-authorization|connection|content-length|transfer-encoding)$/i;
const VALID_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_REF_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;
const SHELL_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);
const SHELL_EXEC_FLAGS = new Set(["-c", "-lc", "-ic", "/c", "/k", "-command", "-encodedcommand", "-enc"]);
const SENSITIVE_ARG_FLAG_RE =
  /^--?[a-z0-9._-]*(?:key|token|secret|pass(?:word|phrase)?|pwd|auth|cred(?:ential)?|bearer|cookie|session|header)[a-z0-9._-]*$/i;
const SENSITIVE_SHORT_FLAGS = new Set(["-k", "-p", "-t", "-H"]);
const SENSITIVE_ARG_ASSIGN_RE =
  /^(--?[a-z0-9._-]*(?:key|token|secret|pass(?:word|phrase)?|pwd|auth|cred(?:ential)?|bearer|cookie|session|header)[a-z0-9._-]*=)(.+)$/i;
const SENSITIVE_ENV_ARG_RE =
  /^([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASS(?:WORD|PHRASE)?|PWD|AUTH|CRED(?:ENTIAL)?|BEARER|COOKIE|SESSION)[A-Za-z0-9_]*=)(.+)$/i;
const URL_IN_TEXT_RE = /\b([a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>`]+)/gi;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function displayHomePath(homeDir: string, absPath: string): string {
  const rel = path.relative(homeDir, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(absPath);
  return `~/${rel.split(path.sep).join("/")}`;
}

export function normalizeMigratedSkillName(raw: string): { normalized: string; wasNormalized: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(trimmed)) return null;
  const normalized = trimmed.replace(/_/g, "-");
  return { normalized, wasNormalized: normalized !== trimmed };
}

function shannonEntropy(value: string): number {
  if (!value.length) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function isHighEntropySecret(token: string): boolean {
  const value = token.trim();
  if (value.length < 20 || value.length > 4096) return false;
  if (!/^[!-~]+$/.test(value)) return false;
  if (/^(?:\/|~\/|\.\.?\/|[A-Za-z]:\\)/.test(value) && !value.includes("@") && !value.includes("?")) return false;
  if (/^@[a-z0-9._-]+\/[a-z0-9._-]+(?:@[a-z0-9._^~-]+)?$/i.test(value)) return false;
  if (/^--?[a-z][a-z0-9._-]*$/i.test(value)) return false;
  if (/^[a-z][a-z0-9._-]+$/.test(value) && (value.includes(".") || value.includes("-") || value.includes("_"))) return false;
  if (/^https?:\/\/[^@?]+$/i.test(value)) return false;
  const classes =
    (/[a-z]/.test(value) ? 1 : 0) +
    (/[A-Z]/.test(value) ? 1 : 0) +
    (/[0-9]/.test(value) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(value) ? 1 : 0);
  const entropy = shannonEntropy(value);
  if (classes >= 3 && entropy >= 3.4) return true;
  if (/^[A-Fa-f0-9]{24,}$/.test(value) && entropy >= 3.3) return true;
  if (/^[A-Za-z0-9+/_-]{28,}={0,2}$/.test(value) && classes >= 2 && entropy >= 3.6) return true;
  return false;
}

export function recordSecret(seenSecrets: Set<string>, value: string | undefined): void {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.length >= 4 && !ENV_REF_RE.test(trimmed)) {
    seenSecrets.add(trimmed);
  }
  const bearer = /^(?:Bearer|Basic)\s+(.+)$/i.exec(trimmed)?.[1]?.trim();
  if (bearer && bearer.length >= 4 && !ENV_REF_RE.test(bearer)) {
    seenSecrets.add(bearer);
  }
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function stripUrlCredentialsAndQuery(
  rawUrl: string,
  seenSecrets: Set<string>,
): {
  valid: boolean;
  cleanUrl?: string;
  hostSummary?: string;
  hadUserinfo: boolean;
  hadQuery: boolean;
  hasEnvRef: boolean;
} {
  const trimmed = rawUrl.trim();
  const hasEnvRef = ENV_REF_RE.test(trimmed);
  const inspected = inspectSensitiveText(trimmed);
  for (const s of inspected.secrets) recordSecret(seenSecrets, s.value);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, hadUserinfo: /:\/\/[^/\s]*@/.test(trimmed), hadQuery: trimmed.includes("?"), hasEnvRef };
  }
  const hadUserinfo = Boolean(parsed.username || parsed.password);
  const hadQuery = Boolean(parsed.search);
  if (parsed.username) recordSecret(seenSecrets, decodeSafe(parsed.username));
  if (parsed.password) recordSecret(seenSecrets, decodeSafe(parsed.password));
  if (parsed.search) {
    recordSecret(seenSecrets, parsed.search.slice(1));
    for (const [, val] of parsed.searchParams) recordSecret(seenSecrets, val);
  }
  if (parsed.hash) recordSecret(seenSecrets, parsed.hash.slice(1));
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { valid: false, hadUserinfo, hadQuery, hasEnvRef };
  }
  if (!parsed.hostname || isCloudMetadataHostOrIp(parsed.hostname)) {
    return { valid: false, hadUserinfo, hadQuery, hasEnvRef };
  }
  const cleanUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const hostSummary = parsed.host;
  return { valid: !hasEnvRef, cleanUrl, hostSummary, hadUserinfo, hadQuery, hasEnvRef };
}

export function sanitizeDisplayText(
  raw: string,
  seenSecrets: ReadonlySet<string>,
  extraRedact?: (text: string) => string,
  maxLen = 160,
): string {
  if (!raw) return "";
  let text = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
  text = text.replace(URL_IN_TEXT_RE, (match) => {
    try {
      const u = new URL(match);
      if (u.username || u.password || u.search || u.hash) {
        return `${u.protocol}//${u.host}${u.pathname}`;
      }
      return match;
    } catch {
      return "[已隐藏]";
    }
  });
  const known = [...seenSecrets];
  text = redactSensitiveText(text, known);
  text = text.replace(/[^\s"'`<>()[\]{},;:=]+/g, (word) => (isHighEntropySecret(word) ? "[已隐藏]" : word));
  if (extraRedact) text = extraRedact(text);
  if (known.length) text = redactSensitiveText(text, known);
  return text.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function sanitizeCliArgs(
  rawArgs: readonly unknown[],
  seenSecrets: Set<string>,
): { sanitizedArgs: string[]; hadSecretsStripped: boolean; warnings: string[] } {
  const sanitizedArgs: string[] = [];
  let hadSecretsStripped = false;
  const warnings: string[] = [];
  const addWarning = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const item = rawArgs[i];
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;

    const assignMatch = SENSITIVE_ARG_ASSIGN_RE.exec(trimmed);
    if (assignMatch) {
      recordSecret(seenSecrets, assignMatch[2]);
      hadSecretsStripped = true;
      addWarning("已剥离命令行中的凭据参数，请通过环境变量安全录入。");
      continue;
    }

    if (SENSITIVE_ARG_FLAG_RE.test(trimmed) || SENSITIVE_SHORT_FLAGS.has(trimmed)) {
      const next = rawArgs[i + 1];
      if (typeof next === "string") {
        recordSecret(seenSecrets, next);
        const inspectedNext = inspectSensitiveText(next);
        for (const s of inspectedNext.secrets) recordSecret(seenSecrets, s.value);
        i += 1;
      }
      hadSecretsStripped = true;
      addWarning("已剥离命令行中的凭据参数，请通过环境变量安全录入。");
      continue;
    }

    const envAssign = SENSITIVE_ENV_ARG_RE.exec(trimmed);
    if (envAssign) {
      recordSecret(seenSecrets, envAssign[2]);
      hadSecretsStripped = true;
      addWarning("已剥离命令行中的凭据赋值参数，请通过环境变量安全录入。");
      continue;
    }

    if (URL_IN_TEXT_RE.test(trimmed)) {
      URL_IN_TEXT_RE.lastIndex = 0;
      let strippedAnyUrl = false;
      const rewritten = trimmed.replace(URL_IN_TEXT_RE, (match) => {
        try {
          const u = new URL(match);
          let stripped = false;
          if (u.username || u.password) {
            recordSecret(seenSecrets, decodeSafe(u.username));
            recordSecret(seenSecrets, decodeSafe(u.password));
            stripped = true;
          }
          if (u.search) {
            recordSecret(seenSecrets, u.search.slice(1));
            for (const [, v] of u.searchParams) recordSecret(seenSecrets, v);
            stripped = true;
          }
          if (u.hash) {
            recordSecret(seenSecrets, u.hash.slice(1));
            stripped = true;
          }
          if (stripped) {
            strippedAnyUrl = true;
            return `${u.protocol}//${u.host}${u.pathname}`;
          }
          return match;
        } catch {
          return match;
        }
      });
      if (strippedAnyUrl) {
        hadSecretsStripped = true;
        addWarning("已剥离命令行 URL 中的账号密码或查询参数。");
        sanitizedArgs.push(rewritten);
        continue;
      }
    }

    const inspected = inspectSensitiveText(trimmed);
    if (inspected.secrets.length > 0 || isHighEntropySecret(trimmed)) {
      for (const s of inspected.secrets) recordSecret(seenSecrets, s.value);
      if (isHighEntropySecret(trimmed)) recordSecret(seenSecrets, trimmed);
      hadSecretsStripped = true;
      addWarning("已剥离命令行中的高熵或凭据参数。");
      continue;
    }

    sanitizedArgs.push(trimmed);
  }
  return { sanitizedArgs, hadSecretsStripped, warnings };
}

export function classifyStdioRisks(
  command: string,
  rawArgs: readonly string[],
  hadSecretsStripped: boolean,
): MigrationStdioRiskFlag[] {
  const flags = new Set<MigrationStdioRiskFlag>();
  const base = path.basename(command).toLowerCase();
  const joinedArgs = rawArgs.join(" ");

  if (command.startsWith("./") || command.startsWith("../") || command.includes("..")) {
    flags.add("relative_command");
  }
  if (SHELL_COMMANDS.has(base)) {
    const hasExecFlag = rawArgs.some((arg) => SHELL_EXEC_FLAGS.has(arg.toLowerCase()));
    if (hasExecFlag || rawArgs.length > 0) flags.add("shell_exec");
  }
  if (
    base === "curl" ||
    base === "wget" ||
    /\b(?:curl|wget)\b[^|]*\|/i.test(joinedArgs) ||
    /\b(?:curl|wget)\b[\s\S]*\b(?:sh|bash|zsh|eval|iex|invoke-expression)\b/i.test(joinedArgs)
  ) {
    flags.add("pipe_download");
  }
  if (
    base === "uvx" ||
    base === "bunx" ||
    base === "pnpx" ||
    (base === "npx" && rawArgs.some((arg) => arg === "-y" || arg === "--yes"))
  ) {
    flags.add("ephemeral_runner");
  }
  if (hadSecretsStripped) {
    flags.add("inline_secret_stripped");
  }
  return [...flags];
}

export type BoundedFileRead =
  | { kind: "missing" }
  | { kind: "symlink" }
  | { kind: "not_file" }
  | { kind: "too_large"; size: number }
  | { kind: "error"; message: string }
  | { kind: "ok"; absPath: string; bytes: Buffer; sha256: string };

export function readBoundedRegularFile(
  baseDir: string,
  relSegments: readonly string[],
  maxBytes = MIGRATION_MAX_CONFIG_BYTES,
): BoundedFileRead {
  try {
    const baseStat = fs.lstatSync(baseDir);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) return { kind: "symlink" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", message: "无法访问用户主目录。" };
  }

  let current = baseDir;
  for (let idx = 0; idx < relSegments.length; idx++) {
    const seg = relSegments[idx]!;
    current = path.join(current, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      return { kind: "error", message: "读取配置文件路径失败。" };
    }
    if (st.isSymbolicLink()) return { kind: "symlink" };
    const isLast = idx === relSegments.length - 1;
    if (!isLast && !st.isDirectory()) return { kind: "missing" };
    if (isLast) {
      if (!st.isFile()) return { kind: "not_file" };
      if (st.size > maxBytes) return { kind: "too_large", size: st.size };
    }
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: "not_file" };
    if (st.size > maxBytes) return { kind: "too_large", size: st.size };
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const read = fs.readSync(fd, buf, offset, st.size - offset, offset);
      if (read <= 0) return { kind: "error", message: "文件读取期间发生变化。" };
      offset += read;
    }
    if (fs.fstatSync(fd).size !== st.size) return { kind: "error", message: "文件读取期间发生变化。" };
    return { kind: "ok", absPath: current, bytes: buf, sha256: sha256Hex(buf) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") return { kind: "symlink" };
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", message: "无法读取配置文件。" };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function readBoundedFileAtPath(absPath: string, homeDir: string, maxBytes = MIGRATION_MAX_CONFIG_BYTES): BoundedFileRead {
  const rel = path.relative(homeDir, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { kind: "error", message: "配置文件超出主目录边界。" };
  }
  return readBoundedRegularFile(homeDir, rel.split(path.sep), maxBytes);
}

export interface ParsedMcpEntry {
  serverKey: string;
  jsonScope: "root" | "project";
  projectKey?: string;
  raw: Record<string, unknown>;
}

export function extractMcpServerEntries(parsedJson: unknown): ParsedMcpEntry[] {
  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) return [];
  const doc = parsedJson as Record<string, unknown>;
  const entries: ParsedMcpEntry[] = [];
  const collectMap = (map: unknown, jsonScope: "root" | "project", projectKey?: string) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    for (const [serverKey, value] of Object.entries(map as Record<string, unknown>)) {
      if (UNSAFE_PATH_SEGMENTS.has(serverKey)) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      entries.push({ serverKey, jsonScope, ...(projectKey ? { projectKey } : {}), raw: value as Record<string, unknown> });
    }
  };
  collectMap(doc.mcpServers, "root");
  if (doc.projects && typeof doc.projects === "object" && !Array.isArray(doc.projects)) {
    for (const [projectKey, projVal] of Object.entries(doc.projects as Record<string, unknown>)) {
      if (UNSAFE_PATH_SEGMENTS.has(projectKey)) continue;
      if (projVal && typeof projVal === "object" && !Array.isArray(projVal)) {
        collectMap((projVal as Record<string, unknown>).mcpServers, "project", projectKey);
      }
    }
  }
  return entries;
}

export function parseHeadersInfo(
  rawHeaders: unknown,
  seenSecrets: Set<string>,
): {
  headerNames: string[];
  hasEnvRef: boolean;
  hadSecrets: boolean;
  inferredAuthMode?: McpAuthMode;
  primaryHeaderName?: string;
  extraHeaderNames: string[];
} {
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    return { headerNames: [], hasEnvRef: false, hadSecrets: false, extraHeaderNames: [] };
  }
  const validNames: string[] = [];
  let hasEnvRef = false;
  let hadSecrets = false;
  for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
    if (UNSAFE_PATH_SEGMENTS.has(key)) continue;
    if (typeof value === "string" && value.trim()) {
      if (ENV_REF_RE.test(value)) hasEnvRef = true;
      else hadSecrets = true;
      recordSecret(seenSecrets, value);
      const inspected = inspectSensitiveText(value);
      for (const s of inspected.secrets) recordSecret(seenSecrets, s.value);
    }
    if (VALID_HEADER_NAME.test(key) && !FORBIDDEN_HEADER_NAMES.test(key)) {
      validNames.push(key);
    }
  }
  if (!validNames.length) {
    return { headerNames: [], hasEnvRef, hadSecrets, extraHeaderNames: [] };
  }
  const authIdx = validNames.findIndex((h) => h.toLowerCase() === "authorization");
  if (authIdx >= 0) {
    const others = validNames.filter((_, idx) => idx !== authIdx);
    return {
      headerNames: validNames,
      hasEnvRef,
      hadSecrets,
      inferredAuthMode: "bearer",
      extraHeaderNames: others,
    };
  }
  const [primary, ...rest] = validNames;
  return {
    headerNames: validNames,
    hasEnvRef,
    hadSecrets,
    inferredAuthMode: "header",
    primaryHeaderName: primary,
    extraHeaderNames: rest,
  };
}

export function extractToolFilterNames(raw: Record<string, unknown>): string[] {
  const labels: string[] = [];
  for (const field of ["disabledTools", "allowedTools", "alwaysAllow", "autoApprove"] as const) {
    const value = raw[field];
    if (Array.isArray(value) && value.length > 0) {
      const safeNames = value
        .filter((v): v is string => typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,80}$/.test(v.trim()))
        .map((v) => v.trim());
      if (safeNames.length > 0) {
        const preview = safeNames.slice(0, 4).join(", ");
        labels.push(`${field}(${safeNames.length}${preview ? `: ${preview}` : ""})`);
      } else {
        labels.push(`${field}(${value.length})`);
      }
    }
  }
  return labels;
}

export function collectEnvKeys(rawEnv: unknown, seenSecrets: Set<string>): {
  envKeys: string[];
  hasEnvRef: boolean;
  hadSecrets: boolean;
} {
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    return { envKeys: [], hasEnvRef: false, hadSecrets: false };
  }
  const envKeys: string[] = [];
  let hasEnvRef = false;
  let hadSecrets = false;
  for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
    if (UNSAFE_PATH_SEGMENTS.has(key)) continue;
    if (typeof value === "string" && value.trim()) {
      if (ENV_REF_RE.test(value)) hasEnvRef = true;
      else hadSecrets = true;
      recordSecret(seenSecrets, value);
      const inspected = inspectSensitiveText(value);
      for (const s of inspected.secrets) recordSecret(seenSecrets, s.value);
    }
    const upper = key.trim().toUpperCase();
    if (isValidMcpEnvKey(upper) && !envKeys.includes(upper)) {
      envKeys.push(upper);
    }
  }
  return { envKeys, hasEnvRef, hadSecrets };
}

export function buildStdioPrefillFromEntry(input: {
  candidateId: string;
  serverKey: string;
  raw: Record<string, unknown>;
  localNodeId: string;
  seenSecrets: Set<string>;
  extraRedact?: (text: string) => string;
}): MigrationStdioPrefill {
  const rawCmd = typeof input.raw.command === "string" ? input.raw.command.trim() : "";
  const rawArgs = Array.isArray(input.raw.args) ? input.raw.args : [];
  const { sanitizedArgs, hadSecretsStripped: argSecrets, warnings } = sanitizeCliArgs(rawArgs, input.seenSecrets);
  const envInfo = collectEnvKeys(input.raw.env, input.seenSecrets);
  const rawCwd = typeof input.raw.cwd === "string" && path.isAbsolute(input.raw.cwd.trim()) ? input.raw.cwd.trim() : undefined;
  const cwdSafe = rawCwd && sanitizeDisplayText(rawCwd, input.seenSecrets, input.extraRedact, 512) === rawCwd ? rawCwd : undefined;
  const riskFlags = classifyStdioRisks(
    rawCmd,
    rawArgs.filter((a): a is string => typeof a === "string"),
    argSecrets || envInfo.hadSecrets,
  );
  const allWarnings = [...warnings];
  if (envInfo.hadSecrets || envInfo.hasEnvRef) {
    allWarnings.push("已剥离原配置中的环境变量值，请在下方手动填写所需凭据。");
  }
  if (riskFlags.includes("shell_exec") || riskFlags.includes("pipe_download")) {
    allWarnings.push("该命令包含高风险 Shell 或远程脚本下载模式，请仔细核对后再决定是否保存。");
  }
  const safeName = sanitizeDisplayText(input.serverKey, input.seenSecrets, input.extraRedact, 120) || "mcp-server";
  return {
    candidateId: input.candidateId,
    name: safeName,
    mcpTransport: "stdio",
    mcpCommand: sanitizeDisplayText(rawCmd, input.seenSecrets, input.extraRedact, 512),
    mcpArgs: sanitizedArgs.map((arg) => sanitizeDisplayText(arg, input.seenSecrets, input.extraRedact, 512)),
    ...(cwdSafe ? { mcpCwd: cwdSafe } : {}),
    envKeys: envInfo.envKeys,
    boundNodeId: input.localNodeId,
    riskFlags,
    warnings: allWarnings,
  };
}
