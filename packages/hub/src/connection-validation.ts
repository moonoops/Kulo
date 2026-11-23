import { createPrivateKey } from "node:crypto";
import {
  isValidMcpEnvKey,
  type ConnectionCredentialField,
  type ConnectionKind,
  type ConnectionSecrets,
  type McpAuthMode,
  type McpTransportKind,
} from "@kulo/protocol";
import { normalizeSshPrivateKey } from "./connection-ssh-diagnostics.js";

export const SECRET_FIELDS = ["password", "privateKey", "passphrase", "apiKey"] as const;
export const KNOWN_KINDS: ConnectionKind[] = ["ssh", "account", "api-key", "custom", "app", "mcp"];
export const MAX_CREDENTIAL_FIELDS = 32;
const RESERVED_FIELD_KEYS = new Set([
  "__binding",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);

function fail(message: string, code = "invalid_connection", status = 400): never {
  throw Object.assign(new Error(message), { code, status });
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^connection-[a-f0-9-]{16,64}$/.test(value)) fail("连接标识无效。");
  return value;
}

export function textField(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`${label}无效。`);
  return value.trim() || undefined;
}

export function credentialKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !RESERVED_FIELD_KEYS.has(value);
}

export function allowedSecretKeyFor(
  kind: ConnectionKind,
  key: string,
  mcpTransport?: McpTransportKind,
  mcpAuthMode?: McpAuthMode,
): boolean {
  if (!credentialKey(key)) return false;
  if (kind === "custom") return true;
  if (kind === "mcp") {
    if (mcpTransport === "stdio") return isValidMcpEnvKey(key);
    const mode = mcpAuthMode ?? "oauth";
    if (mode === "oauth") return key === "clientSecret";
    if (mode === "bearer" || mode === "header") return key === "apiKey";
    return false;
  }
  return SECRET_FIELDS.includes(key as (typeof SECRET_FIELDS)[number]);
}

export function credentialSchema(value: unknown): ConnectionCredentialField[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CREDENTIAL_FIELDS) fail("凭据字段定义无效（最多 32 项）。");
  const seen = new Set<string>();
  return value.map((field: unknown) => {
    if (
      !field ||
      typeof field !== "object" ||
      Array.isArray(field) ||
      Object.keys(field).some((key) => key !== "key" && key !== "label") ||
      !("key" in field) ||
      !credentialKey(field.key) ||
      seen.has(field.key) ||
      !("label" in field)
    ) {
      fail("凭据字段定义无效。");
    }
    const label = textField(field.label, "凭据字段名称", 120);
    if (!label) fail("请填写凭据字段名称。");
    seen.add(field.key);
    return { key: field.key, label };
  });
}

export function instructionsField(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 8_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    fail("使用说明无效（最多 8000 字）。");
  }
  return value.trim() || undefined;
}

export function fieldLabel(key: string): string {
  return ({ password: "密码", privateKey: "私钥", passphrase: "私钥口令", apiKey: "API Key", clientSecret: "Client Secret" } as Record<string, string>)[key] ?? key;
}

export function normalizedSecrets(
  value: unknown,
  kind: ConnectionKind,
  mcpTransport?: McpTransportKind,
  mcpAuthMode?: McpAuthMode,
): Record<string, string> {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length > MAX_CREDENTIAL_FIELDS ||
    Object.keys(value).some((key) => !allowedSecretKeyFor(kind, key, mcpTransport, mcpAuthMode))
  ) {
    fail("凭据字段无效。");
  }
  const output: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    let field = (value as ConnectionSecrets)[key];
    if (field === undefined) continue;
    if (
      typeof field !== "string" ||
      field.includes("\0") ||
      (kind === "custom" ? Buffer.byteLength(field, "utf8") > 256 * 1024 : field.length > (key === "privateKey" ? 65_536 : 16_384))
    ) {
      fail("凭据值无效或内容过长。");
    }
    if (kind !== "custom" && field && key !== "privateKey" && /[\r\n]/.test(field)) fail("凭据不能包含换行。");
    if (kind !== "custom" && field && key === "privateKey") {
      field = normalizeSshPrivateKey(field);
      if (!/^-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+-----END (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----\n$/.test(field)) {
        fail("SSH 私钥格式无效。");
      }
      // OpenSSH's own parser validates its format at authentication time; Node cannot parse it.
      if (!field.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) {
        try { createPrivateKey({ key: field, passphrase: (value as ConnectionSecrets).passphrase }); }
        catch { fail("SSH 私钥或私钥口令无效。"); }
      }
    }
    output[key] = field;
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > 768 * 1024) fail("凭据内容过长，请分条保存。");
  return output;
}

export function informationRequest(text: string): { name: string; value: string } | undefined {
  const match = /^(?:(?:请|帮我|替我|麻烦你|请帮我)[\t ]*)?(?:记住|记一下|记录一下|记录下来)[\t ]*我的[\t ]*([^\r\n:：是为，,]{1,60})[\t ]*(?:[:：]|是|为|，|,)[\t ]*([\s\S]+)$/u.exec(text.trim());
  if (!match) return undefined;
  const name = match[1]!.trim(), value = match[2]!.trim();
  if (
    !name ||
    !value ||
    /密码|口令|私钥|密钥|令牌|凭据|账号|帐号|验证码|证书|Cookie|Token|API|SSH|连接串|数据库|文件|代码|脚本|配置|设置|任务|要求|需求|命令|方案|程序/iu.test(name) ||
    /(?:保存|写入|生成|修改|删除|创建|执行|运行|部署)[^\r\n。]{0,40}(?:文件|代码|脚本|配置|设置|项目|程序)|(?:文件|代码|脚本|配置|设置)[^\r\n。]{0,24}(?:保存|写入|修改|生成)/u.test(value)
  ) {
    return undefined;
  }
  return { name, value };
}

export function requiresCustomSecretFallback(secrets: ConnectionSecrets): boolean {
  return Object.entries(secrets).some(
    ([key, value]) => key !== "privateKey" && typeof value === "string" && (/[\r\n]/.test(value) || value.length > 16_384),
  );
}
