import net from "node:net";
import type { ConnectionCategory, ConnectionFields, ConnectionSecrets } from "@kulo/protocol";
import {
  KNOWN_KINDS,
  SECRET_FIELDS,
  allowedSecretKeyFor,
  credentialSchema,
  instructionsField,
  textField,
} from "./connection-validation.js";
import { getConnectionApplication } from "./connection-applications.js";
import { COMPOSIO_PRESET_ID, composioBinding } from "./composio-bridge.js";
import { normalizeMcpConnectionFields } from "./mcp-presets.js";
import { isCloudMetadataHostOrIp, isPrivateOrLoopbackHost } from "./net-policy.js";

function fail(message: string, code = "invalid_connection", status = 400): never {
  throw Object.assign(new Error(message), { code, status });
}

export function normalizeFields(
  input: ConnectionFields,
  stateDir?: string,
  options?: { allowPrivateHttp?: boolean },
): ConnectionFields {
  if (!input || typeof input !== "object" || !KNOWN_KINDS.includes(input.kind)) fail("请选择连接类型。");
  if (input.kind === "app") {
    const app = getConnectionApplication(input.appId);
    if (input.category !== undefined && input.category !== "app" || input.host !== undefined || input.port !== undefined || input.url !== undefined || input.authType !== undefined || input.headerName !== undefined) fail("应用连接类型或地址不能修改。");
    const schema = credentialSchema(input.credentialFields);
    if (schema?.some((field) => app.authentication !== "token" || field.key !== "apiKey")) fail("此应用不支持该凭据字段。");
    return {
      name: app.name, kind: "app", category: "app", appId: app.id,
      ...(input.username ? { username: textField(input.username, "应用账号", 256) } : {}),
      instructions: app.instructions.join("\n"),
      credentialFields: app.authentication === "token" ? [{ key: "apiKey", label: "访问令牌" }] : [],
    };
  }
  if (input.kind === "mcp") {
    return normalizeMcpConnectionFields(input, {
      stateDir,
      allowPrivateHttp: options?.allowPrivateHttp,
      textField,
      instructionsField,
      credentialSchema,
      allowedSecretKeyFor,
    });
  }
  if (input.appId !== undefined || input.category === "app") fail("请从预置应用入口连接应用。");
  const category: ConnectionCategory = input.category ?? "credential";
  if (category !== "credential" && category !== "information" || category === "information" && input.kind !== "custom") fail("此连接类型不支持该分类。");
  const name = textField(input.name, "连接名称", 120);
  if (!name) fail("请填写连接名称。");
  const username = textField(input.username, "用户名", 256);
  const typeLabel = textField(input.typeLabel, "连接类型名称", 120);
  const instructions = instructionsField(input.instructions);
  const schema = credentialSchema(input.credentialFields);
  if (input.kind !== "custom" && schema?.some((field) => !SECRET_FIELDS.includes(field.key as typeof SECRET_FIELDS[number]))) fail("此连接类型不支持该凭据字段。");
  const fields: ConnectionFields = {
    name, kind: input.kind, category,
    ...(username ? { username } : {}),
    ...(typeLabel ? { typeLabel } : {}),
    ...(instructions ? { instructions } : {}),
    ...(schema ? { credentialFields: schema } : {}),
  };
  if (input.kind === "ssh") {
    const rawHost = textField(input.host, "主机地址", 253);
    const host = rawHost?.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
    if (host && !net.isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host)) fail("主机地址无效。");
    if (username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]{0,127}$/.test(username)) fail("SSH 用户名无效。");
    const port = input.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("SSH 端口必须在 1 到 65535 之间。");
    if (host) fields.host = host;
    fields.port = port;
  } else {
    const rawUrl = textField(input.url, "站点地址", 2_048);
    if (rawUrl) {
      let url: URL;
      try { url = new URL(rawUrl); } catch { fail("请输入完整的 HTTPS 地址。"); }
      if (url.username || url.password || url.search || url.hash) fail("站点地址不能包含账号、密码、查询参数或片段。");
      if (isCloudMetadataHostOrIp(url.hostname)) fail("站点地址受安全策略阻止。");
      if (url.protocol === "http:") {
        if (!options?.allowPrivateHttp || !isPrivateOrLoopbackHost(url.hostname)) {
          fail("站点地址必须使用 HTTPS，且不能包含账号、密码或查询参数。");
        }
      } else if (url.protocol !== "https:") {
        fail("站点地址必须使用 HTTPS，且不能包含账号、密码或查询参数。");
      }
      fields.url = url.href;
    }
    if (input.kind === "custom") return fields;
    const authType = input.authType ?? (input.kind === "account" ? "basic" : "bearer");
    if (!["bearer", "basic", "header"].includes(authType)) fail("认证类型无效。");
    fields.authType = authType;
    if (authType === "header") {
      const header = textField(input.headerName, "认证请求头", 80) ?? "X-API-Key";
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) || /^(host|cookie|set-cookie|proxy-authorization|connection|content-length|transfer-encoding)$/i.test(header)) fail("认证请求头无效。");
      fields.headerName = header;
    }
  }
  return fields;
}

export function binding(fields: ConnectionFields): string {
  if (fields.kind === "app") return JSON.stringify(["app", fields.appId, "app"]);
  if (fields.kind === "mcp") {
    if (fields.mcpTransport === "stdio") {
      return JSON.stringify(["mcp", "stdio", fields.mcpCommand ?? "", fields.mcpArgs ?? [], fields.mcpCwd ?? ""]);
    }
    if (fields.mcpPresetId === COMPOSIO_PRESET_ID) return composioBinding(fields);
    const u = fields.url ? new URL(fields.url) : undefined;
    const sortedSearch = u && u.search
      ? `?${[...u.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
      : "";
    return JSON.stringify(["mcp", "http", u ? `${u.origin}${u.pathname}${sortedSearch}` : "", fields.mcpAuthMode ?? "oauth", fields.headerName?.toLowerCase() ?? "", fields.mcpOAuthClientId ?? ""]);
  }
  if (fields.kind === "custom") return JSON.stringify(["custom", fields.url ? new URL(fields.url).origin : "", fields.username ?? ""]);
  return JSON.stringify(fields.kind === "ssh"
    ? [fields.kind, fields.host ?? "", fields.port ?? 22, fields.username ?? ""]
    : [fields.kind, fields.url ? new URL(fields.url).origin : "", fields.username ?? "", fields.authType ?? "", fields.headerName?.toLowerCase() ?? ""]);
}

export function completesIdentity(previous: ConnectionFields, next: ConnectionFields): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "app") return previous.appId === next.appId && previous.category === next.category;
  if (previous.kind === "mcp") return binding(previous) === binding(next);
  if (previous.kind === "ssh") return (!previous.host || previous.host === next.host) && (!previous.username || previous.username === next.username) && (!previous.host || (previous.port ?? 22) === (next.port ?? 22));
  return (!previous.url || Boolean(next.url) && new URL(previous.url).origin === new URL(next.url!).origin) && (!previous.username || previous.username === next.username) &&
    previous.authType === next.authType && previous.headerName === next.headerName;
}

export function usable(record: ConnectionFields, fields: ConnectionSecrets, mcpOAuthAuthorized = false): boolean {
  if (record.kind === "app") return getConnectionApplication(record.appId).authentication === "macos" || Boolean(fields.apiKey);
  if (record.kind === "mcp") {
    if (record.mcpTransport === "stdio") return Boolean(record.mcpCommand);
    if ((record.mcpAuthMode ?? "oauth") === "none") return Boolean(record.url);
    if ((record.mcpAuthMode ?? "oauth") === "oauth") return Boolean(record.url && mcpOAuthAuthorized);
    return Boolean(record.url && fields.apiKey);
  }
  if (record.kind === "custom") return Object.values(fields).some((value) => typeof value === "string" && value.length > 0);
  return record.kind === "ssh" ? Boolean(record.host && record.username && (fields.password || fields.privateKey))
    : record.kind === "account" || record.authType === "basic" ? Boolean(record.url && record.username && fields.password)
      : Boolean(record.url && fields.apiKey);
}
