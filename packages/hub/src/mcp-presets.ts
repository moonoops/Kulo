import net from "node:net";
import { isCloudMetadataHostOrIp, isPrivateOrLoopbackHost } from "./net-policy.js";
import path from "node:path";
import {
  MCP_BLOCKED_ENV_KEYS,
  isBlockedMcpEnvKey,
  isValidMcpEnvKey,
  type ConnectionCredentialField,
  type ConnectionFields,
  type McpAuthMode,
  type McpPresetDefinition,
  type McpTransportKind,
} from "@kulo/protocol";
import { COMPOSIO_PRESET_ID, validateComposioMetadataFields } from "./composio-bridge.js";

export { MCP_BLOCKED_ENV_KEYS, isBlockedMcpEnvKey, isValidMcpEnvKey };

const AGGREGATOR_KEYWORDS: readonly string[] = [
  "gmail", "google", "calendar", "drive", "sheets", "docs", "slack", "discord",
  "hubspot", "asana", "airtable", "trello", "salesforce", "jira", "dropbox",
  "reddit", "shopify", "notion", "linear", "github", "email", "mail",
  "邮箱", "日历", "网盘", "表格", "聚合", "500", "9000",
];

const RAW_MCP_PRESETS: McpPresetDefinition[] = [
  {
    id: "zapier",
    name: "Zapier",
    description: "云端聚合 9,000+ 应用动作（需在 Zapier 勾选开放，免费版约 50 次/月）",
    transport: "http",
    url: "https://mcp.zapier.com/api/v1/connect",
    authMode: "oauth",
    supportedAuthModes: ["oauth", "bearer"],
    helpUrl: "https://mcp.zapier.com",
    category: "aggregator",
    keywords: AGGREGATOR_KEYWORDS,
    hostedAggregator: true,
  },
  {
    id: "composio",
    name: "Composio",
    description: "云端聚合 500+ 应用（Gmail、日历、Drive、Slack 等，免费版 10 万次/月）",
    transport: "http",
    url: "https://backend.composio.dev/api/v3.1",
    authMode: "header",
    supportedAuthModes: ["header"],
    headerName: "x-api-key",
    helpUrl: "https://dashboard.composio.dev/~/project/settings/api-keys",
    category: "aggregator",
    keywords: AGGREGATOR_KEYWORDS,
    hostedAggregator: true,
    bootstrapMode: "composio",
  },
  {
    id: "linear",
    name: "Linear",
    description: "议题、项目与迭代管理",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    authMode: "oauth",
    supportedAuthModes: ["oauth", "bearer"],
    helpUrl: "https://linear.app/docs/mcp",
    category: "engineering",
  },
  {
    id: "notion",
    name: "Notion",
    description: "页面、数据库与知识库检索编辑",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    authMode: "oauth",
    supportedAuthModes: ["oauth"],
    helpUrl: "https://developers.notion.com/docs/mcp",
    category: "productivity",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: "Jira 议题与 Confluence 文档",
    transport: "http",
    url: "https://mcp.atlassian.com/v2/mcp",
    authMode: "oauth",
    supportedAuthModes: ["oauth"],
    helpUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/",
    category: "engineering",
    keywords: ["jira", "confluence"],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "线上异常与链路追踪排查",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    authMode: "oauth",
    supportedAuthModes: ["oauth", "bearer"],
    helpUrl: "https://docs.sentry.io/product/sentry-mcp/",
    category: "engineering",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "数据库、迁移与边缘函数",
    transport: "http",
    url: "https://mcp.supabase.com/mcp",
    authMode: "oauth",
    supportedAuthModes: ["oauth", "bearer"],
    helpUrl: "https://supabase.com/docs/guides/getting-started/mcp",
    category: "cloud",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "项目部署、日志与域名管理",
    transport: "http",
    url: "https://mcp.vercel.com",
    authMode: "oauth",
    supportedAuthModes: ["oauth", "bearer"],
    helpUrl: "https://vercel.com/docs/mcp/vercel-mcp",
    category: "cloud",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Workers、存储与站点配置",
    transport: "http",
    url: "https://mcp.cloudflare.com/mcp",
    authMode: "oauth",
    supportedAuthModes: ["oauth", "bearer"],
    helpUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
    category: "cloud",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "客户、订阅与账单查询",
    transport: "http",
    url: "https://mcp.stripe.com",
    authMode: "oauth",
    supportedAuthModes: ["oauth", "bearer"],
    helpUrl: "https://docs.stripe.com/mcp",
    category: "cloud",
  },
  {
    id: "context7",
    name: "Context7",
    description: "最新开源库与框架文档检索",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    authMode: "none",
    supportedAuthModes: ["none", "bearer"],
    helpUrl: "https://context7.com/docs",
    category: "docs",
  },
  {
    id: "github-mcp",
    name: "GitHub (MCP)",
    description: "官方全功能 MCP（代码、PR 与议题）",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    authMode: "bearer",
    supportedAuthModes: ["bearer", "oauth"],
    helpUrl: "https://github.com/github/github-mcp-server",
    category: "engineering",
  },
  {
    id: "figma-mcp",
    name: "Figma (MCP)",
    description: "官方设计稿与组件上下文",
    transport: "http",
    url: "https://mcp.figma.com/mcp",
    authMode: "bearer",
    supportedAuthModes: ["bearer", "oauth"],
    helpUrl: "https://developers.figma.com/docs/figma-mcp-server/",
    category: "design",
  },
  {
    id: "slack",
    name: "Slack",
    description: "频道消息读取与发送（需自备 App 凭据或令牌）",
    transport: "http",
    url: "https://mcp.slack.com/mcp",
    authMode: "oauth",
    supportedAuthModes: ["oauth", "bearer"],
    requiresClientId: true,
    helpUrl: "https://docs.slack.dev/ai/mcp-server/",
    category: "productivity",
  },
  {
    id: "exa",
    name: "Exa",
    description: "网页、代码与论文深度检索",
    transport: "http",
    url: "https://mcp.exa.ai/mcp",
    authMode: "none",
    supportedAuthModes: ["none", "bearer"],
    helpUrl: "https://docs.exa.ai/reference/exa-mcp",
    category: "docs",
    keywords: ["search", "research", "搜索", "检索"],
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "开源 GitHub 仓库结构与文档问答",
    transport: "http",
    url: "https://mcp.deepwiki.com/mcp",
    authMode: "none",
    supportedAuthModes: ["none", "bearer"],
    helpUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    category: "docs",
    keywords: ["github", "wiki", "docs", "文档", "代码库"],
  },
  {
    id: "tavily",
    name: "Tavily",
    description: "AI 实时网页搜索与正文抽取",
    transport: "http",
    url: "https://mcp.tavily.com/mcp",
    authMode: "oauth",
    supportedAuthModes: ["oauth", "bearer"],
    helpUrl: "https://docs.tavily.com/documentation/mcp",
    category: "docs",
    keywords: ["search", "web", "extract", "搜索"],
  },
  {
    id: "posthog",
    name: "PostHog",
    description: "产品分析、事件与实验排查（推荐令牌或自设最小 Scope）",
    transport: "http",
    url: "https://mcp.posthog.com/mcp",
    authMode: "bearer",
    supportedAuthModes: ["bearer", "oauth"],
    helpUrl: "https://posthog.com/docs/model-context-protocol",
    category: "engineering",
    keywords: ["analytics", "events", "flags", "分析", "埋点"],
  },
];

export const MCP_PRESET_CATALOG: readonly McpPresetDefinition[] = Object.freeze(
  RAW_MCP_PRESETS.map((item) => Object.freeze({
    ...item,
    supportedAuthModes: Object.freeze([...item.supportedAuthModes]),
    ...(item.keywords ? { keywords: Object.freeze([...item.keywords]) } : {}),
  })),
);

export function findMcpPreset(id: unknown): McpPresetDefinition | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return MCP_PRESET_CATALOG.find((item) => item.id === id);
}

export function getMcpPreset(id: unknown): McpPresetDefinition {
  const preset = findMcpPreset(id);
  if (!preset) {
    throw Object.assign(new Error("不支持的预置 MCP 应用。"), { code: "connection_mcp_preset_unknown", status: 400 });
  }
  return preset;
}

export function stripBrackets(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

export function isLoopbackHost(hostname: string): boolean {
  const bare = stripBrackets(hostname);
  if (!bare) return false;
  if (bare === "localhost" || bare.endsWith(".localhost") || bare === "::1") return true;
  if (bare.startsWith("::ffff:")) {
    const mapped = bare.slice("::ffff:".length);
    return isLoopbackHost(mapped);
  }
  const parts = parseIpv4(bare);
  return parts !== undefined && parts[0] === 127;
}

function parseIpv4(ip: string): [number, number, number, number] | undefined {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
    }
  }
  return undefined;
}

function unwrapIpv4MappedIpv6(ip: string): string {
  const bare = stripBrackets(ip);
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(bare);
  if (dotted && net.isIPv4(dotted[1]!)) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return bare;
}

export function isCloudMetadataIp(ip: string): boolean {
  const bare = unwrapIpv4MappedIpv6(ip);
  const v4 = parseIpv4(bare);
  if (v4) {
    const [a, b, c, d] = v4;
    // 169.254.0.0/16 link-local (AWS/GCP/Azure IMDS), 100.100.100.200 (Alibaba IMDS), 0.0.0.0/8 unspecified
    if (a === 169 && b === 254) return true;
    if (a === 100 && b === 100 && c === 100 && d === 200) return true;
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(bare)) {
    const normalized = bare.toLowerCase();
    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
    // Link-local fe80::/10 (fe80..febf)
    const first = normalized.split(":")[0] || "0";
    const word = parseInt(first, 16);
    if (!Number.isNaN(word) && (word & 0xffc0) === 0xfe80) return true;
  }
  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const bare = unwrapIpv4MappedIpv6(ip);
  if (isCloudMetadataIp(bare)) return true;
  const v4 = parseIpv4(bare);
  if (v4) {
    const [a, b] = v4;
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // 127.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT / Tailscale / Alibaba IMDS)
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a >= 224) return true;                          // multicast & reserved
    return false;
  }
  if (net.isIPv6(bare)) {
    const normalized = bare.toLowerCase();
    if (normalized === "::1") return true;
    const first = normalized.split(":")[0] || "0";
    const word = parseInt(first, 16);
    if (!Number.isNaN(word)) {
      if ((word & 0xfe00) === 0xfc00) return true;      // fc00::/7 ULA
      if ((word & 0xffc0) === 0xfe80) return true;      // fe80::/10 link-local
      if ((word & 0xff00) === 0xff00) return true;      // ff00::/8 multicast
    }
  }
  return false;
}

/**
 * Returns true if the URL's literal hostname refers to loopback, a private/reserved IP,
 * or a local-only TLD (.local / .internal / single-label host without dots).
 */
export function isNonPublicMcpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  const host = stripBrackets(parsed.hostname);
  if (!host) return true;
  if (isLoopbackHost(host)) return true;
  if (net.isIP(host)) return isPrivateOrReservedIp(host);
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || !host.includes(".")) {
    return true;
  }
  return false;
}

const MAX_MCP_ARGS = 64;

function failMcpField(message: string): never {
  throw Object.assign(new Error(message), { code: "invalid_connection", status: 400 });
}

function cleanMcpText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f]/.test(value)) failMcpField(`${label}无效。`);
  return value.trim() || undefined;
}

export function normalizeMcpCommand(value: unknown): string {
  const command = cleanMcpText(value, "启动命令", 512);
  if (!command) failMcpField("请填写本机 MCP 启动命令。");
  if (command.startsWith("./") || command.startsWith("../") || command.includes("..")) failMcpField("启动命令不能使用相对路径。");
  if ((command.includes("/") || command.includes("\\")) && !path.isAbsolute(command)) failMcpField("启动命令须为可执行文件名或绝对路径。");
  if (!path.isAbsolute(command) && !/^[A-Za-z0-9._-]+$/.test(command)) failMcpField("启动命令名称包含不支持的字符。");
  return command;
}

export function normalizeMcpArgs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MCP_ARGS) failMcpField("MCP 启动参数无效（最多 64 项）。");
  return value.map((item) => {
    if (typeof item !== "string" || item.length > 1_024 || /[\x00\r\n]/.test(item)) failMcpField("MCP 启动参数包含无效字符或过长。");
    return item;
  });
}

export function normalizeMcpCwd(value: unknown, stateDir?: string): string | undefined {
  const cwd = cleanMcpText(value, "工作目录", 1_024);
  if (!cwd) return undefined;
  if (!path.isAbsolute(cwd)) failMcpField("MCP 工作目录必须为绝对路径。");
  if (stateDir) {
    const resolvedState = path.resolve(stateDir);
    const resolvedCwd = path.resolve(cwd);
    if (resolvedCwd === resolvedState || resolvedCwd.startsWith(`${resolvedState}${path.sep}`)) {
      failMcpField("MCP 工作目录不能指向应用受保护数据目录。");
    }
  }
  return cwd;
}

export function normalizeMcpConnectionFields(
  input: ConnectionFields,
  helpers: {
    stateDir?: string;
    allowPrivateHttp?: boolean;
    textField: (value: unknown, label: string, max: number) => string | undefined;
    instructionsField: (value: unknown) => string | undefined;
    credentialSchema: (value: unknown) => ConnectionCredentialField[] | undefined;
    allowedSecretKeyFor: (kind: "mcp", key: string, mcpTransport?: McpTransportKind, mcpAuthMode?: McpAuthMode) => boolean;
  },
): ConnectionFields {
  if (input.appId !== undefined) failMcpField("MCP 连接不能指定固定应用标识。");
  if (input.category !== undefined && input.category !== "app") failMcpField("MCP 连接归属应用分类。");
  const name = helpers.textField(input.name, "连接名称", 120);
  if (!name) failMcpField("请填写连接名称。");
  const transport: McpTransportKind = input.mcpTransport ?? (input.mcpCommand ? "stdio" : "http");
  if (transport !== "http" && transport !== "stdio") failMcpField("MCP 传输方式无效。");
  const instructions = helpers.instructionsField(input.instructions);
  if (transport === "http") {
    if (input.mcpCommand !== undefined || input.mcpArgs !== undefined || input.mcpCwd !== undefined) failMcpField("远程 HTTP MCP 不能包含本地命令行参数。");
    const preset = input.mcpPresetId ? getMcpPreset(input.mcpPresetId) : undefined;
    const rawUrl = helpers.textField(input.url ?? preset?.url, "MCP 服务地址", 2_048);
    if (!rawUrl) failMcpField("请填写 MCP 服务地址。");
    let url: URL;
    try { url = new URL(rawUrl); } catch { failMcpField("请输入有效的 MCP 服务地址。"); }
    if (url.username || url.password || url.hash) failMcpField("MCP 服务地址不能包含账号、密码或片段。");
    for (const [paramKey] of url.searchParams) {
      if (/^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|auth|key)$/i.test(paramKey)) {
        failMcpField("MCP 服务地址查询参数不能包含明文凭据，请使用专用凭据字段。");
      }
    }
    const host = stripBrackets(url.hostname);
    if (!host || isCloudMetadataIp(host) || isCloudMetadataHostOrIp(host)) failMcpField("MCP 服务地址无效或受安全策略阻止。");
    if (url.protocol === "http:") {
      const httpAllowed = isLoopbackHost(host) || (Boolean(helpers.allowPrivateHttp) && isPrivateOrLoopbackHost(host));
      if (!httpAllowed) failMcpField("远程 MCP 服务地址必须使用 HTTPS。");
    } else if (url.protocol !== "https:") {
      failMcpField("远程 MCP 服务地址必须使用 HTTPS。");
    }
    const authMode: McpAuthMode = input.mcpAuthMode ?? preset?.authMode ?? "oauth";
    if (!["oauth", "bearer", "header", "none"].includes(authMode)) failMcpField("MCP 认证方式无效。");
    let headerName: string | undefined;
    if (authMode === "header") {
      const header = helpers.textField(input.headerName ?? preset?.headerName, "认证请求头", 80) ?? "X-API-Key";
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) || /^(host|cookie|set-cookie|proxy-authorization|connection|content-length|transfer-encoding)$/i.test(header)) failMcpField("认证请求头无效。");
      headerName = header;
    }
    const mcpOAuthClientId = authMode === "oauth" ? helpers.textField(input.mcpOAuthClientId, "OAuth Client ID", 256) : undefined;
    const mcpOAuthScope = authMode === "oauth" ? helpers.textField(input.mcpOAuthScope, "OAuth Scope", 512) : undefined;
    let mcpOAuthCallbackPort: number | undefined;
    if (authMode === "oauth" && input.mcpOAuthCallbackPort !== undefined) {
      if (!Number.isInteger(input.mcpOAuthCallbackPort) || input.mcpOAuthCallbackPort < 1024 || input.mcpOAuthCallbackPort > 65_535) failMcpField("OAuth 回调端口必须在 1024 到 65535 之间。");
      mcpOAuthCallbackPort = input.mcpOAuthCallbackPort;
    }
    const schema = helpers.credentialSchema(input.credentialFields);
    if (schema?.some((field) => !helpers.allowedSecretKeyFor("mcp", field.key, "http", authMode))) failMcpField("此 MCP 认证方式不支持该凭据字段。");
    const composioMeta = preset?.id === COMPOSIO_PRESET_ID
      ? validateComposioMetadataFields(input, url, authMode, headerName)
      : undefined;
    if (!composioMeta && (input.mcpComposioUserId !== undefined || input.mcpComposioSessionId !== undefined || input.mcpAllowedToolkits !== undefined)) {
      failMcpField("仅 Composio 连接支持 Composio 会话与应用范围字段。");
    }
    const credentialFields: ConnectionCredentialField[] =
      authMode === "bearer" || authMode === "header"
        ? [{ key: "apiKey", label: "访问令牌" }]
        : authMode === "oauth" && mcpOAuthClientId
          ? [{ key: "clientSecret", label: "Client Secret" }]
          : [];
    return {
      name, kind: "mcp", category: "app", mcpTransport: "http", url: url.href, mcpAuthMode: authMode,
      ...(preset ? { mcpPresetId: preset.id } : {}),
      ...(headerName ? { headerName } : {}),
      ...(mcpOAuthClientId ? { mcpOAuthClientId } : {}),
      ...(mcpOAuthScope ? { mcpOAuthScope } : {}),
      ...(mcpOAuthCallbackPort !== undefined ? { mcpOAuthCallbackPort } : {}),
      ...(composioMeta ?? {}),
      ...(instructions ? { instructions } : {}),
      credentialFields,
    };
  }
  if (input.url !== undefined || input.mcpAuthMode !== undefined || input.headerName !== undefined || input.mcpPresetId !== undefined || input.mcpOAuthClientId !== undefined || input.mcpOAuthScope !== undefined || input.mcpOAuthCallbackPort !== undefined || input.mcpComposioUserId !== undefined || input.mcpComposioSessionId !== undefined || input.mcpAllowedToolkits !== undefined) {
    failMcpField("本机 Stdio MCP 不能包含远程 HTTP、OAuth 或 Composio 字段。");
  }
  const mcpCommand = normalizeMcpCommand(input.mcpCommand);
  const mcpArgs = normalizeMcpArgs(input.mcpArgs);
  const mcpCwd = normalizeMcpCwd(input.mcpCwd, helpers.stateDir);
  const schema = helpers.credentialSchema(input.credentialFields) ?? [];
  if (schema.some((field) => !isValidMcpEnvKey(field.key))) failMcpField("本机 MCP 环境变量名须为大写字母/数字/下划线且不得覆盖受保护系统变量。");
  return {
    name, kind: "mcp", category: "app", mcpTransport: "stdio", mcpCommand,
    ...(mcpArgs?.length ? { mcpArgs } : {}),
    ...(mcpCwd ? { mcpCwd } : {}),
    ...(instructions ? { instructions } : {}),
    credentialFields: schema,
  };
}
