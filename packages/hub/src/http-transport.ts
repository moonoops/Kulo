import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import { Agent, Dispatcher1Wrapper, EnvHttpProxyAgent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { isPrivateLocalModelEndpoint } from "./local-model-endpoint.js";

let direct: Agent | undefined;
const processFetch = globalThis.fetch;
const proxies = new Map<string, ProxyAgent>();
let installation: { owners: number; previous: Dispatcher; agent: Dispatcher; transport?: EnvHttpProxyAgent } | undefined;

export function getDirectDispatcher(): Dispatcher {
  return new Dispatcher1Wrapper(direct ??= new Agent());
}

const preventGoogleKeyRedirects: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (options, handler) => {
  const headers = options.headers;
  const names = Array.isArray(headers)
    ? headers.filter((_, index) => index % 2 === 0)
    : [...new Headers((headers ?? undefined) as ConstructorParameters<typeof Headers>[0]).keys()];
  if (!names.some((name) => name.toLowerCase() === "x-goog-api-key")) return dispatch(options, handler);
  // The Google SDK controls fetch's redirect mode, so stop redirects before it can resend the key.
  return dispatch(options, {
    onRequestStart: (...args) => handler.onRequestStart?.(...args),
    onRequestUpgrade: (...args) => handler.onRequestUpgrade?.(...args),
    onResponseStart: (controller, status, responseHeaders, statusMessage) => {
      if ([301, 302, 303, 307, 308].includes(status) && responseHeaders.location) {
        controller.abort(new Error("模型接口发生重定向，已停止请求以保护 API Key。"));
        return;
      }
      handler.onResponseStart?.(controller, status, responseHeaders, statusMessage);
    },
    onResponseData: (...args) => handler.onResponseData?.(...args),
    onResponseEnd: (...args) => handler.onResponseEnd?.(...args),
    onResponseError: (...args) => handler.onResponseError?.(...args),
    onResponseStarted: () => handler.onResponseStarted?.(),
    onBodySent: (...args) => handler.onBodySent?.(...args),
    onRequestSent: () => handler.onRequestSent?.(),
  });
};

/** Keep response bodies streaming; model SSE and MCP must not wait for the whole body. */
async function runTransportFetch(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], bypassPrivateLocal: boolean): Promise<Response> {
  const request = new Request(input, init);
  let proxy: URL | undefined;
  try {
    proxy = bypassPrivateLocal && isPrivateLocalModelEndpoint(request.url)
      ? undefined
      : resolveHttpProxyUrlForTarget(request.url);
  } catch { throw new Error("HTTP 代理配置无效，请检查代理地址。"); }
  let dispatcher: Dispatcher;
  if (proxy) {
    const key = proxy.href;
    let agent = proxies.get(key);
    if (!agent) { agent = new ProxyAgent({ uri: key, proxyTunnel: true }); proxies.set(key, agent); }
    dispatcher = agent;
  } else dispatcher = direct ??= new Agent();
  // Service credentials must never follow a redirect to a different connection.
  // Node 22's bundled fetch uses the legacy handler contract; Undici 8 agents use v2.
  return processFetch(request, { dispatcher: new Dispatcher1Wrapper(dispatcher), redirect: "error" } as RequestInit & { dispatcher: Dispatcher });
}

export const proxyFetch: typeof fetch = (input, init) => runTransportFetch(input, init, false);
/** Model inference and probe transport: bypasses HTTP_PROXY/ALL_PROXY for self-hosted local/LAN endpoints. */
export const modelFetch: typeof fetch = (input, init) => runTransportFetch(input, init, true);

/** Google SDKs use the process fetch and reject Pi's per-request fetch override. */
export function retainEnvironmentProxy(): () => Promise<void> {
  if (!installation) {
    const env = process.env;
    const fallback = env.all_proxy || env.ALL_PROXY;
    const httpProxy = env.http_proxy || env.HTTP_PROXY || fallback;
    const httpsProxy = env.https_proxy || env.HTTPS_PROXY || fallback;
    const previous = getGlobalDispatcher();
    let transport: EnvHttpProxyAgent | undefined;
    try { transport = httpProxy || httpsProxy ? new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: env.no_proxy || env.NO_PROXY, proxyTunnel: true }) : undefined; }
    catch { throw new Error("HTTP 代理配置无效，请检查代理地址。"); }
    const agent = (transport ?? previous).compose(preventGoogleKeyRedirects);
    installation = { owners: 0, previous, agent, transport };
    setGlobalDispatcher(agent);
  }
  const retained = installation;
  retained.owners++;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (--retained.owners !== 0) return;
    if (getGlobalDispatcher() === retained.agent) setGlobalDispatcher(retained.previous);
    installation = undefined;
    const owned: Dispatcher[] = [...proxies.values(), ...(direct ? [direct] : []), ...(retained.transport ? [retained.transport] : [])];
    proxies.clear(); direct = undefined;
    await Promise.all(owned.map((agent) => agent.destroy()));
  };
}
