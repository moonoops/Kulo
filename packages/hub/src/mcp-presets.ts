import net from "node:net";
import type { McpPresetDefinition } from "@kulo/protocol";

const RAW_MCP_PRESETS: McpPresetDefinition[] = [
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
];

export const MCP_PRESET_CATALOG: readonly McpPresetDefinition[] = Object.freeze(
  RAW_MCP_PRESETS.map((item) => Object.freeze({ ...item, supportedAuthModes: Object.freeze([...item.supportedAuthModes]) })),
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

/** Case-insensitive blocklist of process-hijacking or runtime-overriding environment variables for stdio MCP servers. */
export const MCP_BLOCKED_ENV_KEYS = new Set<string>([
  "path",
  "home",
  "userprofile",
  "comspec",
  "pathext",
  "systemroot",
  "windir",
  "tmpdir",
  "temp",
  "tmp",
  "ld_preload",
  "ld_library_path",
  "ld_audit",
  "dyld_insert_libraries",
  "dyld_library_path",
  "dyld_framework_path",
  "dyld_fallback_library_path",
  "node_options",
  "node_extra_ca_certs",
  "node_tls_reject_unauthorized",
  "node_path",
  "electron_run_as_node",
  "ssl_cert_file",
  "ssl_cert_dir",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "ifs",
  "bash_env",
  "env",
  "zdotdir",
  "pythonpath",
  "pythonstartup",
  "pythonhome",
  "rubyopt",
  "perl5opt",
  "java_tool_options",
  "jdk_java_options",
  "dotnet_startup_hooks",
  "npm_config_script_shell",
]);

export function isBlockedMcpEnvKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (MCP_BLOCKED_ENV_KEYS.has(lower)) return true;
  if (lower.startsWith("dyld_") || lower.startsWith("ld_") || lower.startsWith("kulo_")) return true;
  return false;
}

export function isValidMcpEnvKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(key) && !isBlockedMcpEnvKey(key);
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
