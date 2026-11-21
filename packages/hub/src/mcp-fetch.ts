import dns from "node:dns";
import net from "node:net";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import type { McpFetch } from "@earendil-works/pi-mcp";
import { Agent, Dispatcher1Wrapper, ProxyAgent, type Dispatcher } from "undici";
import { isCloudMetadataIp, isLoopbackHost, isPrivateOrReservedIp, stripBrackets } from "./mcp-presets.js";

const processFetch = globalThis.fetch;

export interface McpFetchOptions {
  /**
   * True only when the configured MCP endpoint itself is a literal loopback or private-LAN host
   * saved by a localHost admin. Public hostnames MUST run with `allowPrivateNetwork: false`
   * so multi-hop OAuth discovery/DCR/token requests and DNS rebinding cannot pivot into local services.
   */
  allowPrivateNetwork: boolean;
  /** Optional per-request timeout merged with caller signal via AbortSignal.any. */
  timeoutMs?: number;
  /** Optional test injection hook; still enforces URL/scheme/redirect validation before invoking. */
  baseFetch?: typeof fetch;
}

export function validateMcpTargetUrl(rawUrl: string | URL, options: { allowPrivateNetwork: boolean }): URL {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("MCP 服务地址无效。"), { code: "connection_mcp_invalid_url", status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error("MCP 服务地址不能包含内嵌账号或密码。"), { code: "connection_mcp_invalid_url", status: 400 });
  }
  const host = stripBrackets(url.hostname);
  if (!host) {
    throw Object.assign(new Error("MCP 服务主机名无效。"), { code: "connection_mcp_invalid_url", status: 400 });
  }
  const loopback = isLoopbackHost(host);
  if (url.protocol === "http:") {
    if (!options.allowPrivateNetwork || !loopback) {
      throw Object.assign(new Error("远程 MCP 及授权端点必须使用 HTTPS。"), { code: "connection_mcp_insecure_url", status: 400 });
    }
  } else if (url.protocol !== "https:") {
    throw Object.assign(new Error("MCP 及授权端点仅支持 HTTPS 协议。"), { code: "connection_mcp_insecure_url", status: 400 });
  }
  if (net.isIP(host)) {
    if (isCloudMetadataIp(host)) {
      throw Object.assign(new Error("已阻止访问受保护的元数据地址。"), { code: "connection_mcp_ssrf_blocked", status: 403 });
    }
    if (!options.allowPrivateNetwork && isPrivateOrReservedIp(host)) {
      throw Object.assign(new Error("公网 MCP 连接禁止跳转到内网或本机地址。"), { code: "connection_mcp_ssrf_blocked", status: 403 });
    }
  } else if (!options.allowPrivateNetwork) {
    if (loopback || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || !host.includes(".")) {
      throw Object.assign(new Error("公网 MCP 连接禁止跳转到本机或内网主机。"), { code: "connection_mcp_ssrf_blocked", status: 403 });
    }
  }
  return url;
}

function createCheckedLookup(allowPrivateNetwork: boolean) {
  return (
    hostname: string,
    lookupOptions: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ) => {
    const checkAddress = (addr: string): Error | null => {
      if (isCloudMetadataIp(addr)) {
        return Object.assign(new Error("已阻止解析到受保护的元数据地址。"), { code: "connection_mcp_ssrf_blocked" });
      }
      if (!allowPrivateNetwork && isPrivateOrReservedIp(addr)) {
        return Object.assign(new Error("公网 MCP 连接禁止解析到本机或内网地址。"), { code: "connection_mcp_ssrf_blocked" });
      }
      return null;
    };
    dns.lookup(hostname, lookupOptions, (err, address, family) => {
      if (err) {
        callback(err, address as string, family);
        return;
      }
      if (Array.isArray(address)) {
        for (const item of address) {
          const failure = checkAddress(item.address);
          if (failure) {
            callback(failure as NodeJS.ErrnoException, []);
            return;
          }
        }
        callback(null, address);
        return;
      }
      const failure = checkAddress(address);
      if (failure) {
        callback(failure as NodeJS.ErrnoException, "", 0);
        return;
      }
      callback(null, address, family);
    });
  };
}

let publicDirectAgent: Agent | undefined;
let privateDirectAgent: Agent | undefined;
const proxyAgents = new Map<string, ProxyAgent>();

function getDirectAgent(allowPrivateNetwork: boolean): Agent {
  if (allowPrivateNetwork) {
    return (privateDirectAgent ??= new Agent({
      connect: { lookup: createCheckedLookup(true) as never },
    }));
  }
  return (publicDirectAgent ??= new Agent({
    connect: { lookup: createCheckedLookup(false) as never },
  }));
}

function getProxyAgent(uri: string): ProxyAgent {
  let agent = proxyAgents.get(uri);
  if (!agent) {
    agent = new ProxyAgent({ uri, proxyTunnel: true });
    proxyAgents.set(uri, agent);
  }
  return agent;
}

/**
 * Per-hop SSRF-hardened, DNS-rebinding-checked, proxy-aware, redirect-forbidding fetch
 * for all MCP Streamable HTTP & OAuth 2.1 (discovery, DCR, token exchange, refresh) requests.
 */
export function createMcpFetch(options: McpFetchOptions): McpFetch {
  return async (input, init) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? input : (input as Request).url;
    validateMcpTargetUrl(rawUrl, { allowPrivateNetwork: options.allowPrivateNetwork });

    const signal = options.timeoutMs
      ? init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(options.timeoutMs)])
        : AbortSignal.timeout(options.timeoutMs)
      : init?.signal;

    const requestInit: RequestInit = {
      ...init,
      redirect: "error",
      ...(signal ? { signal } : {}),
    };

    if (options.baseFetch) {
      return options.baseFetch(input as Parameters<typeof fetch>[0], requestInit);
    }

    const request = new Request(input as Parameters<typeof fetch>[0], requestInit);
    let proxy: URL | undefined;
    try {
      proxy = resolveHttpProxyUrlForTarget(request.url);
    } catch {
      throw Object.assign(new Error("HTTP 代理配置无效，请检查代理地址。"), { code: "connection_mcp_proxy_invalid", status: 502 });
    }
    const dispatcher: Dispatcher = proxy ? getProxyAgent(proxy.href) : getDirectAgent(options.allowPrivateNetwork);
    return processFetch(request, {
      dispatcher: new Dispatcher1Wrapper(dispatcher),
      redirect: "error",
    } as RequestInit & { dispatcher: Dispatcher });
  };
}

export async function closeMcpHttpAgents(): Promise<void> {
  const owned: Dispatcher[] = [
    ...proxyAgents.values(),
    ...(publicDirectAgent ? [publicDirectAgent] : []),
    ...(privateDirectAgent ? [privateDirectAgent] : []),
  ];
  proxyAgents.clear();
  publicDirectAgent = undefined;
  privateDirectAgent = undefined;
  await Promise.all(owned.map((agent) => agent.destroy().catch(() => undefined)));
}
