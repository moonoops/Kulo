import dns from "node:dns";
import net from "node:net";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import type { McpFetch } from "@earendil-works/pi-mcp";
import { Agent, Dispatcher1Wrapper, ProxyAgent, type Dispatcher } from "undici";
import { isCloudMetadataIp, isLoopbackHost, isPrivateOrReservedIp, stripBrackets } from "./mcp-presets.js";
import {
  MAX_SAFE_HTTP_REDIRECTS,
  SAFE_HTTP_REDIRECT_STATUSES,
  isCloudMetadataHostOrIp,
  isPrivateOrLoopbackHost,
  prepareSafeHttpRedirect,
} from "./net-policy.js";

const processFetch = globalThis.fetch;

export interface McpFetchOptions {
  /**
   * True only when the configured MCP endpoint itself is a literal loopback or private-LAN host
   * saved by a localHost admin. Public hostnames MUST run with `allowPrivateNetwork: false`
   * so multi-hop OAuth discovery/DCR/token requests and DNS rebinding cannot pivot into local services.
   */
  allowPrivateNetwork: boolean;
  /** True in trusted mode to allow plaintext HTTP on private/LAN hosts (never cloud metadata). */
  allowPrivateHttp?: boolean;
  /** True in trusted mode to follow up to 3 strict RFC 9110 safe redirects manually. */
  allowSafeRedirects?: boolean;
  /** Optional custom auth header name stripped on cross-origin GET/HEAD redirects. */
  authHeaderName?: string;
  /** Optional per-request timeout merged with caller signal via AbortSignal.any. */
  timeoutMs?: number;
  /** Optional test injection hook; still enforces URL/scheme/redirect validation before invoking. */
  baseFetch?: typeof fetch;
}

export function validateMcpTargetUrl(
  rawUrl: string | URL,
  options: { allowPrivateNetwork: boolean; allowPrivateHttp?: boolean },
): URL {
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
  if (isCloudMetadataHostOrIp(host)) {
    throw Object.assign(new Error("已阻止访问受保护的元数据地址。"), { code: "connection_mcp_ssrf_blocked", status: 403 });
  }
  const loopback = isLoopbackHost(host);
  if (url.protocol === "http:") {
    const allowedHttp =
      (options.allowPrivateNetwork && loopback) ||
      (Boolean(options.allowPrivateHttp) && isPrivateOrLoopbackHost(host));
    if (!allowedHttp) {
      throw Object.assign(new Error("远程 MCP 及授权端点必须使用 HTTPS。"), { code: "connection_mcp_insecure_url", status: 400 });
    }
  } else if (url.protocol !== "https:") {
    throw Object.assign(new Error("MCP 及授权端点仅支持 HTTPS 协议。"), { code: "connection_mcp_insecure_url", status: 400 });
  }
  if (net.isIP(host)) {
    if (isCloudMetadataIp(host) || isCloudMetadataHostOrIp(host)) {
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
      if (isCloudMetadataIp(addr) || isCloudMetadataHostOrIp(addr)) {
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
    const validateOpts = {
      allowPrivateNetwork: options.allowPrivateNetwork,
      allowPrivateHttp: options.allowPrivateHttp,
    };
    const initialUrl = validateMcpTargetUrl(rawUrl, validateOpts);

    const signal = options.timeoutMs
      ? init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(options.timeoutMs)])
        : AbortSignal.timeout(options.timeoutMs)
      : init?.signal;

    const sendHop = async (
      targetInput: Parameters<typeof fetch>[0],
      hopInit: RequestInit,
    ): Promise<Response> => {
      if (options.baseFetch) {
        return options.baseFetch(targetInput, hopInit);
      }
      const request = new Request(targetInput, hopInit);
      let proxy: URL | undefined;
      try {
        proxy = resolveHttpProxyUrlForTarget(request.url);
      } catch {
        throw Object.assign(new Error("HTTP 代理配置无效，请检查代理地址。"), { code: "connection_mcp_proxy_invalid", status: 502 });
      }
      const dispatcher: Dispatcher = proxy ? getProxyAgent(proxy.href) : getDirectAgent(options.allowPrivateNetwork);
      return processFetch(request, {
        dispatcher: new Dispatcher1Wrapper(dispatcher),
        redirect: hopInit.redirect,
      } as RequestInit & { dispatcher: Dispatcher });
    };

    if (!options.allowSafeRedirects) {
      const requestInit: RequestInit = {
        ...init,
        redirect: "error",
        ...(signal ? { signal } : {}),
      };
      return sendHop(input as Parameters<typeof fetch>[0], requestInit);
    }

    const baseMethod = init?.method ?? (input instanceof Request ? input.method : "GET");
    const baseHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const baseBody = init?.body !== undefined ? init.body : (input instanceof Request ? input.body : undefined);

    let currentUrl = initialUrl;
    let currentMethod = baseMethod.toUpperCase();
    let currentHeaders = baseHeaders;
    let currentBody = baseBody;

    for (let hop = 0; hop <= MAX_SAFE_HTTP_REDIRECTS; hop++) {
      signal?.throwIfAborted();
      validateMcpTargetUrl(currentUrl, validateOpts);
      const hopInit: RequestInit = {
        ...init,
        method: currentMethod,
        headers: currentHeaders,
        ...(currentBody !== undefined ? { body: currentBody } : { body: undefined }),
        redirect: "manual",
        ...(signal ? { signal } : {}),
      };
      const response = await sendHop(hop === 0 ? (input as Parameters<typeof fetch>[0]) : currentUrl.href, hopInit);
      if (!SAFE_HTTP_REDIRECT_STATUSES.has(response.status)) {
        return response;
      }
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (hop === MAX_SAFE_HTTP_REDIRECTS) {
        throw Object.assign(new Error("MCP HTTP 重定向次数过多。"), { code: "connection_redirect_limit", status: 502 });
      }
      const next = prepareSafeHttpRedirect({
        status: response.status,
        location,
        currentUrl,
        initialOrigin: initialUrl.origin,
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        authHeaderName: options.authHeaderName,
      });
      validateMcpTargetUrl(next.url, validateOpts);
      currentUrl = next.url;
      currentMethod = next.method;
      currentHeaders = next.headers;
      currentBody = next.body;
    }
    throw Object.assign(new Error("MCP HTTP 重定向次数过多。"), { code: "connection_redirect_limit", status: 502 });
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
