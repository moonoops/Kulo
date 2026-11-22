import { isBlockedMcpEnvKey, isValidMcpEnvKey } from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";

export interface ParsedMcpEnvField {
  key: string;
  value: string;
  placeholderDetected?: boolean;
}

export interface ParsedMcpServer {
  name: string;
  mcpTransport: "http" | "stdio";
  url?: string;
  mcpAuthMode?: "oauth" | "bearer" | "header" | "none";
  headerName?: string;
  apiKey?: string;
  apiKeyPlaceholder?: boolean;
  mcpCommand?: string;
  mcpArgs?: string[];
  mcpCwd?: string;
  envFields?: ParsedMcpEnvField[];
  warnings: string[];
}

export type ParseMcpPasteResult =
  | { ok: true; servers: ParsedMcpServer[] }
  | { ok: false; error: string };

const BLOCKED_SHELL_COMMANDS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh",
  "curl", "wget", "eval", "exec", "osascript", "wscript", "cscript",
]);

const DIRECT_CLI_COMMANDS = new Set([
  "npx", "uvx", "pnpx", "bunx", "pnpm", "yarn", "node", "deno", "bun",
  "python", "python3", "uv", "docker", "podman",
]);

const DOCKER_BOOL_FLAGS = new Set([
  "-i", "-t", "-it", "-ti", "-d", "--rm", "--init", "--interactive",
  "--tty", "--detach", "--read-only", "--privileged", "--pull", "--sig-proxy",
]);

const DOCKER_VALUE_FLAGS = new Set([
  "-p", "--publish", "-v", "--volume", "-w", "--workdir", "-u", "--user",
  "--name", "--network", "--net", "--platform", "--entrypoint", "--mount",
  "--add-host", "--env-file", "--label", "-l", "--memory", "-m", "--cpus",
]);

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^\$\{?(?:env:|input:)?[A-Za-z_][A-Za-z0-9_.:-]*\}?$/,
  /^<[^>\s]{1,64}>$/,
  /^\[[^\]\s]{1,64}\]$/,
  /^(?:your[_-]|replace[_-]|insert[_-]|paste[_-]|enter[_-]|todo|changeme|example[_-]|dummy[_-]|test[_-]?token|xxx+|\*{3,}|\.{3,})/i,
  /^(?:sk|pk|ak|ghp|xox[baprs])[-_](?:your|xxx+|\.{3,}|placeholder)/i,
  /\$\{(?:env:|input:)?[A-Za-z_][A-Za-z0-9_.:-]*\}/,
];

function isPlaceholderSecret(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function stripBrackets(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

function isLoopbackHost(hostname: string): boolean {
  const bare = stripBrackets(hostname);
  if (!bare) return false;
  if (bare === "localhost" || bare.endsWith(".localhost") || bare === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  return Boolean(v4 && Number(v4[1]) === 127);
}

function isNonPublicHost(hostname: string): boolean {
  const bare = stripBrackets(hostname);
  if (!bare) return true;
  if (isLoopbackHost(bare)) return true;
  if (bare.endsWith(".local") || bare.endsWith(".internal") || bare.endsWith(".lan") || !bare.includes(".")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) {
      return true;
    }
  }
  if (bare.includes(":")) {
    const first = parseInt(bare.split(":")[0] || "0", 16);
    if (bare === "::" || (!Number.isNaN(first) && ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80))) {
      return true;
    }
  }
  return false;
}

function titleCaseName(raw: string): string {
  const cleaned = raw
    .replace(/^@[^/]+\//, "")
    .replace(/^(?:mcp|server|modelcontextprotocol)[-_./]*/i, "")
    .replace(/[-_./]*(?:mcp|server)$/i, "")
    .replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
  if (!cleaned) return "MCP";
  return cleaned
    .split(/\s+/)
    .slice(0, 4)
    .map((word) => (word.length > 0 && /^[a-z]/.test(word) ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word))
    .join(" ")
    .slice(0, 120);
}

function deriveNameFromUrl(url: URL): string {
  const parts = url.hostname.split(".").filter(Boolean);
  const meaningful = parts.filter((part) => !["www", "mcp", "api", "app", "remote", "com", "io", "ai", "dev", "org", "net", "co", "sh", "to", "tech"].includes(part.toLowerCase()));
  return titleCaseName(meaningful[0] ?? parts[0] ?? "MCP");
}

function deriveNameFromCommand(command: string, args: readonly string[]): string {
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? command.toLowerCase();
  if (base === "docker" || base === "podman") {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (i === 0 && arg === "run") continue;
      if (DOCKER_BOOL_FLAGS.has(arg)) continue;
      if (arg === "-e" || arg === "--env" || DOCKER_VALUE_FLAGS.has(arg)) { i++; continue; }
      if (arg.startsWith("-")) continue;
      return titleCaseName(arg.split(":")[0]!.split("/").pop() ?? arg);
    }
  }
  for (const arg of args) {
    if (arg === "dlx" || arg === "run" || arg === "-y" || arg === "--yes" || arg.startsWith("-")) continue;
    return titleCaseName(arg);
  }
  return titleCaseName(base);
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

function normalizeSmartPunctuation(text: string): string {
  return text
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/(^|[\s])[\u2014\u2013]([a-zA-Z])/g, "$1--$2");
}

function stripTrailingJsonCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      if (input[j] === "}" || input[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = stripTrailingJsonCommas(raw.trim());
  const candidates = [cleaned];
  if (!cleaned.startsWith("{") && /^"[^"]+"\s*:\s*\{[\s\S]*\}$/.test(cleaned)) {
    candidates.push(`{${cleaned}}`);
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to CLI parser.
    }
  }
  return null;
}

type TokenizeResult = {
  ok: true;
  tokens: string[];
} | {
  ok: false;
  error: string;
};

function tokenizeCommand(raw: string): TokenizeResult {
  const joined = normalizeSmartPunctuation(raw)
    .replace(/^\s*[$>]\s+/, "")
    .replace(/(?:\\|\^|`)\r?\n\s*/g, " ")
    .trim();
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]!;
    const next = joined[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\\" && next !== undefined && (next === "\"" || next === "\\" || next === "$" || next === "`")) {
        current += next;
        i++;
        continue;
      }
      if (ch === "`" || (ch === "$" && next === "(")) {
        return { ok: false, error: t("出于安全考虑，不支持导入包含命令替换的命令，请直接填写 MCP 启动程序。", "Commands with shell substitution are not allowed for security. Enter the MCP executable directly.") };
      }
      if (ch === "\"") quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      current += next;
      hasToken = true;
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "`" || ch === ">" || ch === "<" || (ch === "$" && next === "(")) {
      return { ok: false, error: t("出于安全考虑，不支持导入包含 Shell 管道、重定向或命令替换的命令，请直接填写 MCP 启动程序。", "Commands with shell pipes, redirects, or substitution are not allowed. Enter the MCP executable directly.") };
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote) {
    return { ok: false, error: t("命令中的引号未闭合，请检查后重试。", "Unclosed quote in pasted command.") };
  }
  if (hasToken) tokens.push(current);
  return { ok: true, tokens };
}

function validateAndParseUrl(rawUrl: string, localHost: boolean): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: t("无法识别有效的 MCP 服务地址。", "Enter a valid MCP server URL.") };
  }
  if (url.username || url.password || url.search || url.hash) {
    return {
      ok: false,
      error: t("MCP 服务地址不能包含账号、密码或查询参数，请去掉查询参数并改用请求头或 Token 认证。", "MCP URL cannot include credentials, query parameters, or fragments. Strip them and use Token or Header authentication."),
    };
  }
  if (url.protocol === "http:") {
    if (!isLoopbackHost(url.hostname)) {
      return { ok: false, error: t("远程 MCP 服务地址必须使用 HTTPS。", "Remote MCP servers must use HTTPS.") };
    }
  } else if (url.protocol !== "https:") {
    return { ok: false, error: t("MCP 服务地址必须使用 HTTPS。", "MCP servers must use HTTPS.") };
  }
  if (!localHost && isNonPublicHost(url.hostname)) {
    return { ok: false, error: t("本机或内网 MCP 服务仅可在主脑本机配置。", "Local or private-network MCP servers can only be configured on the local host.") };
  }
  return { ok: true, url };
}

function parseHeadersToAuth(headers: Record<string, string>, warnings: string[]): {
  mcpAuthMode: "oauth" | "bearer" | "header";
  headerName?: string;
  apiKey?: string;
  apiKeyPlaceholder?: boolean;
} {
  const entries = Object.entries(headers).filter(([k]) => k.trim().length > 0);
  if (entries.length === 0) return { mcpAuthMode: "oauth" };
  const authEntry = entries.find(([k]) => k.toLowerCase() === "authorization") ?? entries[0]!;
  if (entries.length > 1) {
    warnings.push(t(`检测到 ${entries.length} 个请求头，已自动提取「${authEntry[0]}」，其余请按需检查。`, `Found ${entries.length} headers; imported "${authEntry[0]}".`));
  }
  const [rawKey, rawVal] = authEntry;
  const trimmedVal = rawVal.trim();
  if (rawKey.toLowerCase() === "authorization" && /^bearer\s+/i.test(trimmedVal)) {
    const token = trimmedVal.replace(/^bearer\s+/i, "").trim();
    if (!token || isPlaceholderSecret(token)) {
      warnings.push(t("检测到令牌占位符，请手动填入真实 Token。", "Detected a token placeholder; enter your real token."));
      return { mcpAuthMode: "bearer", apiKey: "", apiKeyPlaceholder: true };
    }
    return { mcpAuthMode: "bearer", apiKey: token };
  }
  if (!trimmedVal || isPlaceholderSecret(trimmedVal)) {
    warnings.push(t(`检测到请求头「${rawKey}」的占位符，请手动填入真实值。`, `Detected a placeholder for header "${rawKey}"; enter the real value.`));
    return { mcpAuthMode: "header", headerName: rawKey.trim(), apiKey: "", apiKeyPlaceholder: true };
  }
  return { mcpAuthMode: "header", headerName: rawKey.trim(), apiKey: trimmedVal };
}

function normalizeEnvEntries(
  rawEnv: ReadonlyArray<[string, string | null]>,
  warnings: string[],
): ParsedMcpEnvField[] {
  const seen = new Set<string>();
  const fields: ParsedMcpEnvField[] = [];
  for (const [rawKey, rawVal] of rawEnv) {
    const trimmedKey = rawKey.trim();
    if (!trimmedKey) continue;
    if (isBlockedMcpEnvKey(trimmedKey)) {
      warnings.push(t(`已跳过受保护系统环境变量「${trimmedKey}」。`, `Skipped protected system env var "${trimmedKey}".`));
      continue;
    }
    if (!isValidMcpEnvKey(trimmedKey)) {
      warnings.push(t(`环境变量「${trimmedKey}」不符合大写命名规范，已跳过。`, `Skipped invalid env var name "${trimmedKey}" (must be uppercase).`));
      continue;
    }
    if (seen.has(trimmedKey)) continue;
    seen.add(trimmedKey);
    if (rawVal === null || rawVal === "" || isPlaceholderSecret(rawVal)) {
      fields.push({ key: trimmedKey, value: "", placeholderDetected: true });
      warnings.push(t(`请手动填写环境变量「${trimmedKey}」的真实值。`, `Enter the value for env var "${trimmedKey}".`));
    } else {
      fields.push({ key: trimmedKey, value: rawVal });
    }
  }
  return fields;
}

function validateStdioCommand(command: string, localHost: boolean): string | null {
  if (!localHost) {
    return t("本机命令（Stdio）MCP 仅可在主脑本机配置。", "Local command (Stdio) MCP servers can only be configured on the local host.");
  }
  const trimmed = command.trim();
  if (!trimmed) return t("缺少本机 MCP 启动命令。", "Missing local MCP command.");
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~/") || trimmed.includes("..")) {
    return t("启动命令不能使用相对路径或家目录简写。", "Command cannot use relative or tilde paths.");
  }
  if (/^[A-Za-z]:\\/.test(trimmed) && typeof navigator !== "undefined" && !/win/i.test(navigator.platform ?? "")) {
    return t("检测到 Windows 绝对路径，请改为当前设备的有效命令路径。", "Windows absolute path detected; use a valid command for this device.");
  }
  const base = trimmed.split(/[\\/]/).pop()?.toLowerCase() ?? trimmed.toLowerCase();
  if (BLOCKED_SHELL_COMMANDS.has(base)) {
    return t("出于安全考虑，不支持导入 Shell 解释器或下载命令，请直接填写 MCP 启动程序（如 npx / uvx）。", "Shell interpreters and download tools are blocked for security. Enter the MCP executable (e.g. npx / uvx).");
  }
  const isAbs = trimmed.startsWith("/") || /^[A-Za-z]:\\/.test(trimmed);
  if (!isAbs && !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return t("启动命令名称包含不支持的字符。", "Command contains unsupported characters.");
  }
  return null;
}

function rewriteDockerArgs(
  command: string,
  args: readonly string[],
  extraEnv: Array<[string, string | null]>,
  warnings: string[],
): string[] {
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if ((base !== "docker" && base !== "podman") || args[0] !== "run") return [...args];
  const rewritten: string[] = ["run"];
  let reachedImage = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (reachedImage) {
      rewritten.push(arg);
      continue;
    }
    if (DOCKER_BOOL_FLAGS.has(arg)) {
      rewritten.push(arg);
      continue;
    }
    if (arg === "-e" || arg === "--env") {
      const next = args[i + 1];
      if (next === undefined) {
        rewritten.push(arg);
        continue;
      }
      i++;
      const eq = next.indexOf("=");
      if (eq > 0) {
        const key = next.slice(0, eq).trim();
        const val = next.slice(eq + 1);
        if (isValidMcpEnvKey(key)) {
          rewritten.push("-e", key);
          extraEnv.push([key, val]);
        } else {
          warnings.push(t(`已忽略不合规或受保护的容器环境变量「${key}」。`, `Ignored invalid or protected container env var "${key}".`));
        }
      } else {
        const key = next.trim();
        if (isValidMcpEnvKey(key)) {
          rewritten.push("-e", key);
          extraEnv.push([key, null]);
        } else {
          warnings.push(t(`已忽略不合规或受保护的容器环境变量「${key}」。`, `Ignored invalid or protected container env var "${key}".`));
        }
      }
      continue;
    }
    if (arg.startsWith("--env=") || arg.startsWith("-e=")) {
      const spec = arg.slice(arg.indexOf("=") + 1);
      const eq = spec.indexOf("=");
      const key = (eq > 0 ? spec.slice(0, eq) : spec).trim();
      const val = eq > 0 ? spec.slice(eq + 1) : null;
      if (isValidMcpEnvKey(key)) {
        rewritten.push("-e", key);
        extraEnv.push([key, val]);
      } else {
        warnings.push(t(`已忽略不合规或受保护的容器环境变量「${key}」。`, `Ignored invalid or protected container env var "${key}".`));
      }
      continue;
    }
    if (DOCKER_VALUE_FLAGS.has(arg)) {
      rewritten.push(arg);
      if (i + 1 < args.length) rewritten.push(args[++i]!);
      continue;
    }
    if (arg.startsWith("-")) {
      rewritten.push(arg);
      continue;
    }
    reachedImage = true;
    rewritten.push(arg);
  }
  return rewritten;
}

function buildStdioServer(
  name: string,
  command: string,
  args: readonly string[],
  rawEnv: ReadonlyArray<[string, string | null]>,
  cwd: string | undefined,
  localHost: boolean,
  warnings: string[],
): { ok: true; server: ParsedMcpServer } | { ok: false; error: string } {
  const err = validateStdioCommand(command, localHost);
  if (err) return { ok: false, error: err };
  const combinedEnv: Array<[string, string | null]> = [...rawEnv];
  const safeArgs = rewriteDockerArgs(command, args, combinedEnv, warnings);
  if (safeArgs.length > 64) {
    return { ok: false, error: t("启动参数超过 64 项上限。", "At most 64 command arguments are allowed.") };
  }
  const envFields = normalizeEnvEntries(combinedEnv, warnings);
  return {
    ok: true,
    server: {
      name: name.trim().slice(0, 120) || deriveNameFromCommand(command, safeArgs),
      mcpTransport: "stdio",
      mcpCommand: command.trim(),
      mcpArgs: safeArgs,
      ...(cwd ? { mcpCwd: cwd.trim() } : {}),
      envFields,
      warnings,
    },
  };
}

function parseJsonServerObject(
  name: string,
  spec: Record<string, unknown>,
  localHost: boolean,
): { ok: true; server: ParsedMcpServer } | { ok: false; error: string } {
  const warnings: string[] = [];
  const rawUrl = typeof spec.url === "string"
    ? spec.url
    : typeof spec.serverUrl === "string"
      ? spec.serverUrl
      : typeof spec.httpUrl === "string"
        ? spec.httpUrl
        : undefined;
  if (rawUrl) {
    const checked = validateAndParseUrl(rawUrl, localHost);
    if (!checked.ok) return checked;
    if (spec.type === "sse" || spec.transport === "sse") {
      warnings.push(t("Kulo 使用 Streamable HTTP，已自动按远程 HTTP 导入，请确认服务端支持。", "Kulo uses Streamable HTTP; verify the endpoint supports it."));
    }
    const headers: Record<string, string> = {};
    if (spec.headers && typeof spec.headers === "object" && !Array.isArray(spec.headers)) {
      for (const [k, v] of Object.entries(spec.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    const auth = parseHeadersToAuth(headers, warnings);
    return {
      ok: true,
      server: {
        name: name.trim().slice(0, 120) || deriveNameFromUrl(checked.url),
        mcpTransport: "http",
        url: checked.url.href,
        ...auth,
        warnings,
      },
    };
  }
  if (typeof spec.command === "string") {
    const args = Array.isArray(spec.args) ? spec.args.filter((item): item is string => typeof item === "string") : [];
    const cwd = typeof spec.cwd === "string" ? spec.cwd : undefined;
    const rawEnv: Array<[string, string | null]> = [];
    if (spec.env && typeof spec.env === "object" && !Array.isArray(spec.env)) {
      for (const [k, v] of Object.entries(spec.env as Record<string, unknown>)) {
        rawEnv.push([k, typeof v === "string" ? v : v === null ? null : String(v)]);
      }
    }
    return buildStdioServer(name, spec.command, args, rawEnv, cwd, localHost, warnings);
  }
  return { ok: false, error: t("JSON 中缺少有效的 url 或 command 字段。", "JSON is missing a valid url or command field.") };
}

function parseJsonConfig(obj: Record<string, unknown>, localHost: boolean): ParseMcpPasteResult {
  const nestedMap =
    (obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers) ? obj.mcpServers : null)
    ?? (obj.servers && typeof obj.servers === "object" && !Array.isArray(obj.servers) ? obj.servers : null)
    ?? (obj.mcp && typeof obj.mcp === "object" && !Array.isArray(obj.mcp) && (obj.mcp as Record<string, unknown>).servers && typeof (obj.mcp as Record<string, unknown>).servers === "object"
      ? (obj.mcp as Record<string, unknown>).servers
      : null);

  if (nestedMap) {
    const entries = Object.entries(nestedMap as Record<string, unknown>).filter(([, v]) => Boolean(v && typeof v === "object" && !Array.isArray(v)));
    if (entries.length === 0) {
      return { ok: false, error: t("配置 JSON 中未找到 MCP 服务条目。", "No MCP server entries found in JSON.") };
    }
    const servers: ParsedMcpServer[] = [];
    let firstError: string | null = null;
    for (const [name, spec] of entries) {
      const parsed = parseJsonServerObject(name, spec as Record<string, unknown>, localHost);
      if (parsed.ok) servers.push(parsed.server);
      else if (!firstError) firstError = parsed.error;
    }
    if (servers.length === 0) {
      return { ok: false, error: firstError ?? t("无法解析配置 JSON 中的 MCP 服务。", "Failed to parse MCP servers from JSON.") };
    }
    return { ok: true, servers };
  }

  if (typeof obj.url === "string" || typeof obj.serverUrl === "string" || typeof obj.httpUrl === "string" || typeof obj.command === "string") {
    const name = typeof obj.name === "string" ? obj.name : "";
    const parsed = parseJsonServerObject(name, obj, localHost);
    return parsed.ok ? { ok: true, servers: [parsed.server] } : parsed;
  }

  // Support bare `{ "my-server": { "command": ..., "args": ... } }` snippets
  const directEntries = Object.entries(obj).filter(([, v]) =>
    Boolean(v && typeof v === "object" && !Array.isArray(v) && (
      typeof (v as Record<string, unknown>).url === "string"
      || typeof (v as Record<string, unknown>).serverUrl === "string"
      || typeof (v as Record<string, unknown>).command === "string"
    )),
  );
  if (directEntries.length > 0) {
    const servers: ParsedMcpServer[] = [];
    let firstError: string | null = null;
    for (const [name, spec] of directEntries) {
      const parsed = parseJsonServerObject(name, spec as Record<string, unknown>, localHost);
      if (parsed.ok) servers.push(parsed.server);
      else if (!firstError) firstError = parsed.error;
    }
    if (servers.length > 0) return { ok: true, servers };
    return { ok: false, error: firstError ?? t("无法解析 JSON 中的 MCP 服务。", "Failed to parse MCP servers from JSON.") };
  }

  return { ok: false, error: t("未在 JSON 中识别到 MCP 配置字段（url / command / mcpServers）。", "No recognizable MCP fields (url / command / mcpServers) found in JSON.") };
}

function parseClaudeMcpAdd(tokens: readonly string[], localHost: boolean): ParseMcpPasteResult {
  const sub = tokens[2];
  if (sub === "add-json") {
    const rest = tokens.slice(3);
    const positionals: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i]!;
      if (tok === "-s" || tok === "--scope") { i++; continue; }
      if (tok.startsWith("--scope=")) continue;
      positionals.push(tok);
    }
    if (positionals.length < 2) {
      return { ok: false, error: t("claude mcp add-json 缺少名称或 JSON 配置。", "claude mcp add-json requires a server name and JSON config.") };
    }
    const obj = tryParseJsonObject(positionals[1]!);
    if (!obj) return { ok: false, error: t("claude mcp add-json 中的 JSON 格式无效。", "Invalid JSON in claude mcp add-json.") };
    const parsed = parseJsonServerObject(positionals[0]!, obj, localHost);
    return parsed.ok ? { ok: true, servers: [parsed.server] } : parsed;
  }

  if (sub !== "add") {
    return { ok: false, error: t("仅支持解析 claude mcp add 或 claude mcp add-json 命令。", "Only claude mcp add and claude mcp add-json commands are supported.") };
  }

  let transportHint: string | undefined;
  const headers: Record<string, string> = {};
  const rawEnv: Array<[string, string | null]> = [];
  const positionals: string[] = [];
  const warnings: string[] = [];
  let afterDoubleDash = false;

  for (let i = 3; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (afterDoubleDash) {
      positionals.push(tok);
      continue;
    }
    if (tok === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (tok === "-t" || tok === "--transport") {
      transportHint = tokens[++i]?.toLowerCase();
      continue;
    }
    if (tok.startsWith("--transport=")) {
      transportHint = tok.slice("--transport=".length).toLowerCase();
      continue;
    }
    if (tok === "-s" || tok === "--scope") {
      i++;
      continue;
    }
    if (tok.startsWith("--scope=")) continue;
    if (tok === "-H" || tok === "--header") {
      const pair = tokens[++i] ?? "";
      const colon = pair.indexOf(":");
      if (colon > 0) headers[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
      continue;
    }
    if (tok.startsWith("--header=")) {
      const pair = tok.slice("--header=".length);
      const colon = pair.indexOf(":");
      if (colon > 0) headers[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
      continue;
    }
    if (tok === "-e" || tok === "--env") {
      const pair = tokens[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) rawEnv.push([pair.slice(0, eq), pair.slice(eq + 1)]);
      else if (pair) rawEnv.push([pair, null]);
      continue;
    }
    if (tok.startsWith("--env=")) {
      const pair = tok.slice("--env=".length);
      const eq = pair.indexOf("=");
      if (eq > 0) rawEnv.push([pair.slice(0, eq), pair.slice(eq + 1)]);
      else if (pair) rawEnv.push([pair, null]);
      continue;
    }
    if (tok.startsWith("-") && positionals.length === 0) continue;
    positionals.push(tok);
  }

  if (positionals.length < 2) {
    return { ok: false, error: t("claude mcp add 缺少名称或目标地址/命令。", "claude mcp add requires a name and URL or command.") };
  }

  const name = positionals[0]!;
  const target = positionals[1]!;
  const isHttp = transportHint === "http" || transportHint === "sse" || /^https?:\/\//i.test(target);
  if (isHttp) {
    const checked = validateAndParseUrl(target, localHost);
    if (!checked.ok) return checked;
    if (transportHint === "sse") {
      warnings.push(t("Kulo 仅支持 Streamable HTTP，已按远程 HTTP 导入，请确认服务端支持。", "Kulo uses Streamable HTTP; verify the endpoint supports it."));
    }
    const auth = parseHeadersToAuth(headers, warnings);
    return {
      ok: true,
      servers: [{
        name: name.trim().slice(0, 120) || deriveNameFromUrl(checked.url),
        mcpTransport: "http",
        url: checked.url.href,
        ...auth,
        warnings,
      }],
    };
  }

  const built = buildStdioServer(name, target, positionals.slice(2), rawEnv, undefined, localHost, warnings);
  return built.ok ? { ok: true, servers: [built.server] } : built;
}

export function parseMcpPaste(raw: string, options: { localHost: boolean }): ParseMcpPasteResult {
  const cleaned = stripCodeFence(raw);
  if (!cleaned) {
    return { ok: false, error: t("请粘贴 MCP 服务地址、命令或 JSON 配置。", "Paste an MCP URL, command, or JSON config.") };
  }
  if (cleaned.length > 64 * 1024) {
    return { ok: false, error: t("粘贴内容过长（最多 64 KiB）。", "Pasted content is too large (max 64 KiB).") };
  }

  // 1. Bare URL
  if (/^https?:\/\/\S+$/i.test(cleaned)) {
    const checked = validateAndParseUrl(cleaned, options.localHost);
    if (!checked.ok) return checked;
    return {
      ok: true,
      servers: [{
        name: deriveNameFromUrl(checked.url),
        mcpTransport: "http",
        url: checked.url.href,
        mcpAuthMode: "oauth",
        warnings: [],
      }],
    };
  }

  // 2. JSON object / mcpServers snippet
  const jsonObj = tryParseJsonObject(cleaned);
  if (jsonObj) {
    return parseJsonConfig(jsonObj, options.localHost);
  }

  // 3. Command line (claude mcp add / npx / uvx / docker run / executable)
  const tokenized = tokenizeCommand(cleaned);
  if (!tokenized.ok) return tokenized;
  const tokens = tokenized.tokens;
  if (tokens.length === 0) {
    return { ok: false, error: t("无法识别有效的 MCP 配置。", "Could not recognize a valid MCP configuration.") };
  }

  if (tokens[0] === "claude" && tokens[1] === "mcp") {
    return parseClaudeMcpAdd(tokens, options.localHost);
  }

  const cmd = tokens[0]!;
  const base = cmd.split(/[\\/]/).pop()?.toLowerCase() ?? cmd.toLowerCase();
  if (BLOCKED_SHELL_COMMANDS.has(base)) {
    return { ok: false, error: t("出于安全考虑，不支持导入 Shell 解释器或下载命令，请直接填写 MCP 启动程序（如 npx / uvx）。", "Shell interpreters and download tools are blocked for security. Enter the MCP executable (e.g. npx / uvx).") };
  }

  const isAbsPath = cmd.startsWith("/") || /^[A-Za-z]:\\/.test(cmd);
  if (DIRECT_CLI_COMMANDS.has(base) || isAbsPath) {
    if ((base === "pnpm" || base === "yarn") && tokens[1] !== "dlx") {
      return { ok: false, error: t("请粘贴完整的 MCP 命令（如 npx / uvx / pnpm dlx / docker run / claude mcp add）或 JSON 配置。", "Paste a complete MCP command (npx / uvx / pnpm dlx / docker run / claude mcp add) or JSON config.") };
    }
    const built = buildStdioServer("", cmd, tokens.slice(1), [], undefined, options.localHost, []);
    return built.ok ? { ok: true, servers: [built.server] } : built;
  }

  return {
    ok: false,
    error: t("未能识别此格式，支持粘贴 HTTPS 地址、claude mcp add、npx / uvx / docker run 或 mcpServers JSON。", "Unrecognized format. Paste an HTTPS URL, claude mcp add, npx / uvx / docker run, or mcpServers JSON."),
  };
}
