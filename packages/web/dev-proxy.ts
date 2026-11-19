import type { ClientRequest, IncomingMessage } from "node:http";
import type { ProxyOptions } from "vite";

export function createHubDevProxy(target: string): ProxyOptions {
  const origin = new URL(target).origin;
  return {
    target,
    changeOrigin: true,
    ws: true,
    configure(proxy) {
      const preserveOrigin = (outgoing: ClientRequest, incoming: IncomingMessage) => {
        // Match the rewritten Host without turning a foreign Origin into a trusted one.
        if (incoming.headers.origin === `http://${incoming.headers.host}`) outgoing.setHeader("origin", origin);
      };
      proxy.on("proxyReq", preserveOrigin);
      proxy.on("proxyReqWs", preserveOrigin);
    },
  };
}
