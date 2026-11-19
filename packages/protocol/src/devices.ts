import { SENSITIVE_TEXT_REDACTION } from "./sensitive-text.js";

export interface DeviceSystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  release: string;
  cpu: string;
  memoryBytes: number;
  ips: string[];
}

export function isDeviceSystemInfo(value: unknown): value is DeviceSystemInfo {
  if (!value || typeof value !== "object") return false;
  const info = value as DeviceSystemInfo;
  return (["hostname", "platform", "arch", "release", "cpu"] as const).every((key) =>
    typeof info[key] === "string" && info[key].length <= 256 && !/[\x00-\x1f]/.test(info[key])) &&
    Number.isSafeInteger(info.memoryBytes) && info.memoryBytes >= 0 && Array.isArray(info.ips) && info.ips.length <= 128 &&
    info.ips.every((ip) => typeof ip === "string" && ip.length <= 100 && !/[\x00-\x20]/.test(ip));
}

export interface InterconnectedDevice {
  id: string;
  name: string;
  kind: "local" | "reverse-ws" | "ssh";
  status: "pending" | "online" | "offline";
  rootDir: string;
  info?: DeviceSystemInfo;
  lastSeenAt?: number;
  error?: string;
}

export interface DeviceInterconnectionView {
  enabled: boolean;
  role: "hub" | "joined";
  hubId: string;
  hubName: string;
  currentDeviceId: string;
  currentDeviceKnown?: boolean;
  canSwitchRole?: boolean;
  hubError?: string;
  hubUrls: string[];
  devices: InterconnectedDevice[];
}

/** A local role switch survives the change of the process's HTTP listener. */
export interface DeviceRoleTransition {
  id: string;
  targetRole: "hub" | "joined";
  status: "switching" | "ready" | "failed";
  error?: string;
  code?: string;
}

export interface ParsedDeviceJoinInput {
  hubUrl: string;
  inviteToken: string;
}

export interface DeviceChatInvitation extends ParsedDeviceJoinInput {
  hubId?: string;
  hubName?: string;
}

export interface DeviceJoinMatch extends ParsedDeviceJoinInput {
  tokenStart: number;
  tokenEnd: number;
}

const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{24,200}$/;
const HUB_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const CHAT_INVITE_PREFIX = "MOCO-JOIN/1 ";

function isSafeHubName(name: unknown, inviteToken: string): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 100 && name === name.trim() &&
    !name.includes(inviteToken) && !/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(name);
}

function normalizeCandidateHubOrigin(raw: string): string | null {
  try {
    if (typeof raw !== "string" || raw.length > 2048 || /[\p{Cc}\p{Bidi_Control}]/u.test(raw)) return null;
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.port === "0") {
      return null;
    }
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The chat invitation is plain text. Only the Hub origin is a link, and the quoted name has an explicit end. */
export function formatDeviceChatInvitation(input: Required<DeviceChatInvitation>): string {
  const hubUrl = normalizeCandidateHubOrigin(input.hubUrl);
  if (!hubUrl || typeof input.inviteToken !== "string" || !INVITE_TOKEN_RE.test(input.inviteToken) ||
    typeof input.hubId !== "string" || !HUB_ID_RE.test(input.hubId) ||
    hubUrl.includes(input.inviteToken) || input.hubId.includes(input.inviteToken)) {
    throw new Error("设备接入邀请无效。");
  }
  const hostname = new URL(hubUrl).hostname;
  const name = isSafeHubName(input.hubName, input.inviteToken) ? input.hubName : hostname.length <= 100 ? hostname : "Moco";
  return `${CHAT_INVITE_PREFIX}${hubUrl} ${input.inviteToken} ${input.hubId} ${JSON.stringify(name)}`;
}

export function formatDeviceInstallerInstructions(
  { hubUrl, inviteToken }: ParsedDeviceJoinInput,
): Pick<DeviceInvitation, "command" | "windowsCommand" | "agentInstructions"> {
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const command = `curl -fsSL ${quote(`${hubUrl}/connect/install.sh`)} | sh -s -- ${quote(hubUrl)} ${quote(inviteToken)}`;
  const ps = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const windowsCommand = `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing ${ps(`${hubUrl}/connect/install.ps1`)}).Content)) ${ps(hubUrl)} ${ps(inviteToken)}`;
  const agentInstructions = `请将这台设备接入现有 Moco 主脑 ${hubUrl}。确保 Node.js 22.19 或更新版本和 npm 可用，按系统运行下面的接入命令，验证设备在线，并打开安装程序输出的本机 Moco 地址，确认能看到主脑的对话和任务。以后运行安装生成的 moco 命令，默认连接这个主脑。\n\nmacOS / Linux：\n${command}\n\nWindows PowerShell：\n${windowsCommand}\n\n配对命令在十分钟内有效且只能使用一次。`;
  return { command, windowsCommand, agentInstructions };
}

function unquoteShellArg(raw: string): { value: string; innerOffset: number; innerLength: number } {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return {
      value: raw.slice(1, -1).replaceAll("'\\''", "'").replaceAll("''", "'"),
      innerOffset: 1,
      innerLength: raw.length - 2,
    };
  }
  if (raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) {
    return {
      value: raw.slice(1, -1),
      innerOffset: 1,
      innerLength: raw.length - 2,
    };
  }
  return { value: raw, innerOffset: 0, innerLength: raw.length };
}

// A copied credential still needs to be hidden if its invitation's address or version was edited.
type InvitationTokenMatch = Omit<DeviceJoinMatch, "hubUrl"> & { hubUrl: string | null };

const DEVICE_COMMAND_MARKER = /MOCO-JOIN\/|\/connect\/install\.|peer\.mjs/u;

/** Cheap prefilter for stored JSON as well as decoded text, before traversing chat history records. */
export function mayContainDeviceInvitation(text: string): boolean {
  return typeof text === "string" && (DEVICE_COMMAND_MARKER.test(text) ||
    /https?:\/\/\S{1,2048}(?:[ \t]|\\t)+(?:\\?['"])?[A-Za-z0-9_-]{24}/iu.test(text));
}

function scanDeviceInvitationTokens(text: string, includeBarePairs = false): InvitationTokenMatch[] {
  if (typeof text !== "string") return [];
  const scanCommands = DEVICE_COMMAND_MARKER.test(text);
  const scanBarePairs = includeBarePairs && /^[\t ]*https?:\/\//imu.test(text);
  if (!scanCommands && !scanBarePairs) return [];
  const matches: InvitationTokenMatch[] = [];
  const seen = new Set<number>();
  const chatPattern = /MOCO-JOIN\/\d+[ \t]+(\S+)[ \t]+([A-Za-z0-9_-]{24,200})(?![A-Za-z0-9_-])/gu;
  const barePairPattern = /^[\t ]*(https?:\/\/\S+)[\t ]+(['"]?[A-Za-z0-9_-]{24,200}['"]?)(?=[\t ]*\r?$)/gimu;
  const arg = `(?:'(?:''|'\\\\''|[^'\\r\\n])*'|"(?:[^"\\\\\\r\\n])*"|[^\\s'"\\r\\n]+)`;
  const patterns = scanCommands ? [
    chatPattern,
    new RegExp(`\\/connect\\/install\\.sh['"]?\\s*\\|\\s*(?:ba)?sh\\s+-s\\s+--\\s+(${arg})\\s+(${arg})`, "g"),
    new RegExp(`\\/connect\\/install\\.ps1['"]?\\)\\.Content\\)\\)\\s+(${arg})\\s+(${arg})`, "g"),
    new RegExp(`peer\\.mjs['"]?\\)?\\s+install\\s+--hub\\s+(${arg})\\s+--invite\\s+(${arg})`, "g"),
  ] : [];
  if (scanBarePairs) patterns.push(barePairPattern);
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const rawUrl = match[1]!;
      const rawToken = match[2]!;
      const tokenInfo = unquoteShellArg(rawToken);
      if (!INVITE_TOKEN_RE.test(tokenInfo.value)) continue;
      const supported = pattern !== chatPattern || /^MOCO-JOIN\/1[ \t]/u.test(match[0]);
      const hubUrl = supported ? normalizeCandidateHubOrigin(unquoteShellArg(rawUrl).value) : null;
      if (pattern === barePairPattern && !hubUrl) continue;
      const tokenStart = match.index + match[0].length - rawToken.length + tokenInfo.innerOffset;
      const tokenEnd = tokenStart + tokenInfo.innerLength;
      if (!seen.has(tokenStart)) {
        seen.add(tokenStart);
        matches.push({ hubUrl: hubUrl?.includes(tokenInfo.value) ? null : hubUrl, inviteToken: tokenInfo.value, tokenStart, tokenEnd });
      }
    }
  }
  return matches.sort((a, b) => a.tokenStart - b.tokenStart);
}

/** Locate usable credentials inside explanations and quotes for the Hub's credential sealer. */
export function extractDeviceJoinMatches(text: string): DeviceJoinMatch[] {
  return scanDeviceInvitationTokens(text).filter((match): match is DeviceJoinMatch => match.hubUrl !== null);
}

/** Require an entire official clipboard payload before treating a chat submission as a local action. */
export function parseStandaloneDeviceInvitation(text: string): DeviceChatInvitation | undefined {
  if (typeof text !== "string" || text.length > 32_768) return undefined;
  const content = text.replaceAll("\r\n", "\n").replace(/^\n+/u, "").trimEnd();
  if (content.startsWith(CHAT_INVITE_PREFIX)) {
    const fields = /^(\S+) (\S+) (\S+) (".*")$/u.exec(content.slice(CHAT_INVITE_PREFIX.length));
    if (!fields) return undefined;
    const [, hubUrl, inviteToken, hubId, encodedName] = fields;
    if (!hubUrl || normalizeCandidateHubOrigin(hubUrl) !== hubUrl ||
      !inviteToken || !INVITE_TOKEN_RE.test(inviteToken) || !hubId || !HUB_ID_RE.test(hubId) ||
      hubUrl.includes(inviteToken) || hubId.includes(inviteToken)) {
      return undefined;
    }
    let hubName: unknown;
    try { hubName = JSON.parse(encodedName!); } catch { return undefined; }
    if (!isSafeHubName(hubName, inviteToken) || JSON.stringify(hubName) !== encodedName) return undefined;
    return { hubUrl, inviteToken, hubId, hubName };
  }
  if (!content.startsWith("curl -fsSL ") && !content.startsWith("& ([scriptblock]::Create(") &&
    !content.startsWith("请将这台设备接入现有 Moco 主脑 ")) return undefined;
  const first = extractDeviceJoinMatches(content)[0];
  if (!first) return undefined;
  const input = { hubUrl: first.hubUrl, inviteToken: first.inviteToken };
  const { command, windowsCommand, agentInstructions } = formatDeviceInstallerInstructions(input);
  if (content === command || content === windowsCommand || content === agentInstructions) return input;
  return undefined;
}

export function redactDeviceInvitationText(text: string, remember?: (tokens: readonly string[]) => void): string {
  const tokens = [...new Set(scanDeviceInvitationTokens(text, true).map((match) => match.inviteToken))].sort((a, b) => b.length - a.length);
  if (!tokens.length) return text;
  remember?.(tokens);
  // Redact bare echoes too. Tokens contain only base64url characters; bound the size of each regex.
  let result = text;
  for (let i = 0; i < tokens.length; i += 256) {
    const pattern = new RegExp(tokens.slice(i, i + 256).join("|"), "g");
    result = result.replace(pattern, SENSITIVE_TEXT_REDACTION);
  }
  return result;
}

/**
 * Parse a device connection command, `agentInstructions` block, `<hubUrl> <token>` pair,
 * or explicit `(hubUrl, inviteToken)` fields. Throws a user-facing Error if ambiguous or invalid.
 */
export function parseDeviceJoinInput(rawInput: string, explicitToken?: string): DeviceChatInvitation {
  if (typeof rawInput !== "string" || !rawInput.trim()) {
    throw new Error("请粘贴完整的设备接入命令或输入主机地址与配对凭证。");
  }
  if (explicitToken !== undefined && explicitToken.trim() !== "") {
    const hubUrl = normalizeCandidateHubOrigin(rawInput);
    const token = explicitToken.trim();
    if (!hubUrl) throw new Error("请输入完整有效的主机地址（http:// 或 https://）。");
    if (!INVITE_TOKEN_RE.test(token)) throw new Error("配对凭证格式无效。");
    return { hubUrl, inviteToken: token };
  }
  if (rawInput.trimStart().startsWith("MOCO-JOIN/")) {
    const parsed = parseStandaloneDeviceInvitation(rawInput.trim());
    if (!parsed) throw new Error("设备接入邀请无效。");
    return parsed;
  }
  const extracted = extractDeviceJoinMatches(rawInput);
  if (extracted.length > 0) {
    const first = extracted[0]!;
    if (extracted.some((item) => item.hubUrl !== first.hubUrl || item.inviteToken !== first.inviteToken)) {
      throw new Error("检测到多组不同的设备配对命令，请只粘贴单次生成的接入命令。");
    }
    return { hubUrl: first.hubUrl, inviteToken: first.inviteToken };
  }
  const parts = rawInput.trim().split(/\s+/);
  if (parts.length === 2) {
    const hubUrl = normalizeCandidateHubOrigin(parts[0]!);
    const token = unquoteShellArg(parts[1]!).value.trim();
    if (hubUrl && INVITE_TOKEN_RE.test(token)) {
      return { hubUrl, inviteToken: token };
    }
  }
  throw new Error("未能识别有效的设备接入命令，请粘贴主机生成的接入命令或给 Agent 的指令。");
}

export interface DeviceInvitation {
  id: string;
  deviceId: string;
  expiresAt: number;
  command: string;
  windowsCommand: string;
  agentInstructions: string;
}

export interface DeviceSshRequest {
  host: string;
  port?: number;
  user?: string;
  name?: string;
  rootDir?: string;
  hubUrl: string;
}

export interface DeviceSshScan {
  scanId: string;
  fingerprints: string[];
}

/** Stored on the joined device, readable only by its owner. Never sent in a device-list response. */
export interface DevicePeerConfig {
  version: 1;
  deviceId: string;
  name: string;
  hubUrl: string;
  envToken: string;
  clientToken: string;
  rootDir: string;
  localPort?: number;
}
