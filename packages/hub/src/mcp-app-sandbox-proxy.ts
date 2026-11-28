import http from "node:http";
import { URL } from "node:url";

export const MCP_APP_SANDBOX_PATH = "/mcp-app-sandbox";

const MAX_ALLOWED_HOST_ORIGINS = 16;

export const MCP_APP_INNER_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join("; ");

export function normalizeAllowedHostOrigin(raw: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 256) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function buildMcpAppSandboxProxyCsp(allowedHostOrigins: readonly string[]): string {
  const frameAncestors = allowedHostOrigins.length > 0 ? allowedHostOrigins.join(" ") : "'none'";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

/**
 * Generates the static zero-credential cross-origin outer sandbox proxy HTML aligned with
 * MCP Apps 2026-01-26.
 *
 * Security invariants:
 * - Hosted on a dedicated loopback origin separate from Kulo Hub UI (zero Hub cookies/tokens).
 * - Outer proxy only relays JSON-RPC messages between verified `allowedHostOrigins` and an
 *   inner `<iframe sandbox="allow-scripts">` (strictly NO `allow-same-origin`).
 * - Inner document receives strict `default-src 'none'; connect-src 'none'; form-action 'none'` CSP.
 * - Explicitly drops unsupported/write-like UI methods (`ui/message`, `ui/open-link`, etc.).
 */
export function buildMcpAppSandboxProxyHtml(allowedHostOrigins: readonly string[]): string {
  const serializedHosts = JSON.stringify([...allowedHostOrigins]).replace(/</g, "\\u003c");
  const serializedInnerCsp = JSON.stringify(MCP_APP_INNER_SANDBOX_CSP).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="referrer" content="no-referrer" />
<title>Kulo MCP App Sandbox</title>
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
#kulo-mcp-app-inner { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
</style>
</head>
<body>
<script>
(() => {
  "use strict";
  const ALLOWED_HOSTS = new Set(${serializedHosts});
  const INNER_CSP = ${serializedInnerCsp};
  const ALLOWED_INNER_METHODS = new Set([
    "ui/initialize",
    "ui/notifications/initialized",
    "ui/notifications/size-changed",
    "tools/call",
  ]);
  let hostOrigin = null;
  let innerFrame = null;

  function escapeAttr(value) {
    return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function injectInnerCsp(html) {
    const meta = '<meta http-equiv="Content-Security-Policy" content="' + escapeAttr(INNER_CSP) + '">';
    if (/<head\\b[^>]*>/i.test(html)) {
      return html.replace(/<head\\b[^>]*>/i, (match) => match + meta);
    }
    return "<!doctype html><html><head>" + meta + "</head><body>" + html + "</body></html>";
  }

  function mountInnerHtml(rawHtml) {
    if (innerFrame) {
      innerFrame.remove();
      innerFrame = null;
    }
    const frame = document.createElement("iframe");
    frame.id = "kulo-mcp-app-inner";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc = injectInnerCsp(rawHtml);
    document.body.appendChild(frame);
    innerFrame = frame;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") return;

    if (event.source === window.parent && ALLOWED_HOSTS.has(event.origin)) {
      hostOrigin = event.origin;
      if (data.method === "ui/notifications/sandbox-resource-ready") {
        const html = data.params && typeof data.params.html === "string" ? data.params.html : "";
        mountInnerHtml(html);
        return;
      }
      if (innerFrame && innerFrame.contentWindow) {
        innerFrame.contentWindow.postMessage(data, "*");
      }
      return;
    }

    if (innerFrame && event.source === innerFrame.contentWindow && hostOrigin) {
      if (typeof data.method === "string" && !ALLOWED_INNER_METHODS.has(data.method)) {
        if (data.id !== undefined) {
          innerFrame.contentWindow.postMessage({
            jsonrpc: "2.0",
            id: data.id,
            error: { code: -32601, message: "Method not supported in read-only inline MCP App sandbox" },
          }, "*");
        }
        return;
      }
      window.parent.postMessage(data, hostOrigin);
    }
  });

  if (window.parent && window.parent !== window) {
    for (const targetOrigin of ALLOWED_HOSTS) {
      try {
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: "ui/notifications/sandbox-proxy-ready",
          params: {},
        }, targetOrigin);
      } catch {
        // Ignore mismatched origins; only the matching parent origin receives the notification.
      }
    }
  }
})();
</script>
</body>
</html>`;
}

export interface McpAppSandboxProxyServer {
  readonly origin: string;
  readonly url: string;
  readonly port: number;
  allowHostOrigin(origin: string): boolean;
  getAllowedHostOrigins(): string[];
  close(): Promise<void>;
}

export interface McpAppSandboxProxyOptions {
  host?: string;
  port?: number;
  allowedHostOrigins?: readonly string[];
}

export async function startMcpAppSandboxProxyServer(
  options: McpAppSandboxProxyOptions = {},
): Promise<McpAppSandboxProxyServer> {
  const bindHost = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const allowedHosts = new Set<string>();
  let proxyOrigin = "";

  const addOrigin = (raw: string): boolean => {
    const normalized = normalizeAllowedHostOrigin(raw);
    if (!normalized) return false;
    if (proxyOrigin && normalized === proxyOrigin) return false;
    if (allowedHosts.has(normalized)) return true;
    if (allowedHosts.size >= MAX_ALLOWED_HOST_ORIGINS) return false;
    allowedHosts.add(normalized);
    return true;
  };

  for (const candidate of options.allowedHostOrigins ?? []) {
    addOrigin(candidate);
  }

  const server = http.createServer((req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      res.end("Method Not Allowed");
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? "/", proxyOrigin || "http://127.0.0.1");
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Bad Request");
      return;
    }

    // Actively reject any query parameters (especially ?token=...) so credentials can never enter sandbox URLs.
    if (parsedUrl.search) {
      res.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      res.end("Query parameters are forbidden on MCP App sandbox proxy");
      return;
    }

    if (parsedUrl.pathname !== MCP_APP_SANDBOX_PATH) {
      res.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      res.end("Not Found");
      return;
    }

    // Never read, trust, or emit Authorization / Cookie headers on the isolated proxy origin.
    const hostList = [...allowedHosts].sort();
    const html = buildMcpAppSandboxProxyHtml(hostList);
    const headers: http.OutgoingHttpHeaders = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "content-security-policy": buildMcpAppSandboxProxyCsp(hostList),
    };
    res.writeHead(200, headers);
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(html);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, bindHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to resolve MCP App sandbox proxy port");
  }

  const hostForOrigin = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
  proxyOrigin = `http://${hostForOrigin}:${addr.port}`;
  // Ensure the proxy origin itself can never frame itself.
  allowedHosts.delete(proxyOrigin);

  return {
    origin: proxyOrigin,
    url: `${proxyOrigin}${MCP_APP_SANDBOX_PATH}`,
    port: addr.port,
    allowHostOrigin: addOrigin,
    getAllowedHostOrigins: () => [...allowedHosts].sort(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
