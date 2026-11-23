import dns from "node:dns/promises";
import net from "node:net";
import {
  isAllowedPrivateModelIp,
  isIpLiteralHost,
  isPrivateLocalModelEndpoint,
  KEYLESS_LOCAL_MODEL_APIS,
  supportsKeylessLocalModel,
  unwrapIpv4MappedIpv6,
} from "@kulo/protocol";

export {
  isAllowedPrivateModelIp,
  isIpLiteralHost,
  isPrivateLocalModelEndpoint,
  KEYLESS_LOCAL_MODEL_APIS,
  supportsKeylessLocalModel,
  unwrapIpv4MappedIpv6,
};

/**
 * In-memory synthetic key returned ONLY for verified private/local `authMode: "none"`
 * custom providers so `@earendil-works/pi-ai` OpenAI streams satisfy non-empty key checks.
 * NEVER persist to `credentials.json` and NEVER register into `rememberSecrets(...)`.
 */
export const LOCAL_KEYLESS_SYNTHETIC_API_KEY = "kulo-local-no-auth";

export interface LocalModelDnsLookup {
  (hostname: string): Promise<Array<{ address: string }>>;
}

const defaultLookup: LocalModelDnsLookup = async (hostname) => {
  const entries = await dns.lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => ({ address: entry.address }));
};

/**
 * Defends against DNS rebinding on non-IP local hostnames (e.g. `foo.local` or
 * single-label LAN names) before `registerLocalProvider` performs discovery/probing.
 */
export async function assertResolvedLocalModelEndpoint(
  rawUrl: string,
  lookup: LocalModelDnsLookup = defaultLookup,
): Promise<void> {
  if (!isPrivateLocalModelEndpoint(rawUrl)) {
    throw new Error("免密本地模型仅支持本机或私有局域网 HTTP/HTTPS 地址。");
  }
  const parsed = new URL(rawUrl);
  const bare = unwrapIpv4MappedIpv6(parsed.hostname);
  if (net.isIP(bare) || isIpLiteralHost(bare)) {
    if (!isAllowedPrivateModelIp(bare)) {
      throw new Error("目标 IP 不属于允许的本机或私有局域网地址范围。");
    }
    return;
  }
  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(bare);
  } catch {
    throw new Error(`无法解析本地模型主机名「${bare}」，请确认局域网地址或直接使用 IP。`);
  }
  if (!resolved.length || resolved.some((item) => !isAllowedPrivateModelIp(item.address))) {
    throw new Error(`主机名「${bare}」解析结果包含非私有局域网或受保护地址，已拒绝免密访问。`);
  }
}
