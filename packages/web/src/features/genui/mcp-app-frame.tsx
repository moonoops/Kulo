import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Button, Card, Chip, Spinner } from "@heroui/react";
import {
  KULO_VERSION,
  MCP_APP_PROTOCOL_VERSION,
  redactSensitiveText,
  type McpAppInlineMeta,
  type McpAppResourcePayload,
  type McpAppViewSession,
} from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { mcpAppRestApi, type McpAppFrameApi } from "./mcp-app-api";
import "./genui.css";

const DEFAULT_FRAME_HEIGHT = 280;
const MIN_FRAME_HEIGHT = 160;
const MAX_FRAME_HEIGHT = 640;

class ActiveMcpAppFrameManager {
  #activeKey: string | null = null;
  readonly #listeners = new Set<() => void>();

  getActiveKey = (): string | null => this.#activeKey;

  activate(frameKey: string): void {
    if (this.#activeKey === frameKey) return;
    this.#activeKey = frameKey;
    for (const listener of this.#listeners) listener();
  }

  deactivate(frameKey: string): void {
    if (this.#activeKey !== frameKey) return;
    this.#activeKey = null;
    for (const listener of this.#listeners) listener();
  }

  deactivateAll(): void {
    if (this.#activeKey === null) return;
    this.#activeKey = null;
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

/**
 * Global single-frame coordinator: guarantees at most ONE MCP App iframe is mounted across
 * the entire application at any moment (zero background multi-frame LRU residency).
 */
export const activeMcpAppFrameManager = new ActiveMcpAppFrameManager();

export function isValidCrossOriginSandboxUrl(
  sandboxUrl: string,
  sandboxOrigin: string,
  hostOrigin = typeof window !== "undefined" ? window.location?.origin : undefined,
): boolean {
  try {
    const parsedUrl = new URL(sandboxUrl);
    const parsedOrigin = new URL(sandboxOrigin);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return false;
    if (parsedUrl.origin !== parsedOrigin.origin) return false;
    // Never allow query parameters (e.g. ?token=...) on sandbox URLs.
    if (parsedUrl.search || parsedUrl.hash) return false;
    if (hostOrigin && parsedUrl.origin === hostOrigin) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function clampMcpAppFrameHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FRAME_HEIGHT;
  return Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, Math.round(value)));
}

export interface McpAppHostMessageHandlerOptions {
  session: McpAppViewSession;
  resource: McpAppResourcePayload;
  api: Pick<McpAppFrameApi, "callTool">;
  getTargetWindow: () => { postMessage(message: unknown, targetOrigin: string): void } | null | undefined;
  isSessionStillActive: () => boolean;
  onResize: (height: number) => void;
  formatCallError?: (cause: unknown) => string;
}

export function createMcpAppHostMessageHandler(options: McpAppHostMessageHandlerOptions) {
  const { session, resource, api, getTargetWindow, isSessionStillActive, onResize } = options;
  let resourceSent = false;
  let toolResultSent = false;

  const postToProxy = (payload: Record<string, unknown>) => {
    const targetWindow = getTargetWindow();
    if (!targetWindow) return;
    targetWindow.postMessage(payload, session.sandboxOrigin);
  };

  return (event: Pick<MessageEvent, "origin" | "source" | "data">) => {
    if (event.origin !== session.sandboxOrigin) return;
    const expectedWindow = getTargetWindow();
    if (!expectedWindow || event.source !== expectedWindow) return;
    const msg = event.data as
      | { jsonrpc?: unknown; id?: string | number; method?: unknown; params?: Record<string, unknown> }
      | null;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;

    if (msg.method === "ui/notifications/sandbox-proxy-ready") {
      if (resourceSent) return;
      resourceSent = true;
      postToProxy({
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: {
          html: resource.html,
          ...(resource.csp ? { csp: resource.csp } : {}),
        },
      });
      return;
    }

    if (msg.method === "ui/initialize" && msg.id !== undefined) {
      // Never inject Kulo HeroUI theme tokens into third-party iframe content (anti-spoofing).
      postToProxy({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "Kulo", version: KULO_VERSION },
          hostCapabilities: { serverTools: {} },
          hostContext: {
            displayMode: "inline",
            availableDisplayModes: ["inline"],
          },
        },
      });
      return;
    }

    if (msg.method === "ui/notifications/initialized") {
      if (!toolResultSent && session.initialToolResult) {
        toolResultSent = true;
        postToProxy({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: session.initialToolResult,
        });
      }
      return;
    }

    if (msg.method === "ui/notifications/size-changed") {
      onResize(clampMcpAppFrameHeight(msg.params?.height));
      return;
    }

    if (msg.method === "tools/call" && msg.id !== undefined) {
      const callId = msg.id;
      const toolName = typeof msg.params?.name === "string" ? msg.params.name : "";
      const rawArgs = msg.params?.arguments;
      const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : undefined;
      void api
        .callTool({ viewId: session.viewId, toolName, ...(args ? { arguments: args } : {}) })
        .then(
          ({ call }) => {
            if (!isSessionStillActive()) return;
            postToProxy({ jsonrpc: "2.0", id: callId, result: call.result });
          },
          (cause: unknown) => {
            if (!isSessionStillActive()) return;
            const message = redactSensitiveText(
              options.formatCallError
                ? options.formatCallError(cause)
                : cause instanceof Error
                  ? cause.message
                  : "Read-only tool call failed",
            );
            postToProxy({
              jsonrpc: "2.0",
              id: callId,
              error: { code: -32000, message },
            });
          },
        );
      return;
    }

    // Explicitly block ui/message, ui/open-link, ui/request-display-mode, etc. in Stage 4 read-only prototype.
    if (msg.id !== undefined) {
      postToProxy({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not supported in read-only inline MCP App" },
      });
    }
  };
}

export interface McpAppFrameProps {
  partId: string;
  mcpApp: McpAppInlineMeta;
  fallbackText: string;
  connected?: boolean;
  conversationKey?: string;
  api?: McpAppFrameApi;
}

export function McpAppFrame({
  partId,
  mcpApp,
  fallbackText,
  connected = true,
  conversationKey = "root",
  api = mcpAppRestApi,
}: McpAppFrameProps) {
  const { t } = useI18n();
  const frameKey = `${conversationKey}:${partId}`;
  const activeKey = useSyncExternalStore(
    activeMcpAppFrameManager.subscribe,
    activeMcpAppFrameManager.getActiveKey,
    () => null,
  );
  const isActive = activeKey === frameKey;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<McpAppViewSession | null>(null);
  const [resource, setResource] = useState<McpAppResourcePayload | null>(null);
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_HEIGHT);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sessionRef = useRef<McpAppViewSession | null>(null);
  const resourceRef = useRef<McpAppResourcePayload | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const teardownActiveView = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const current = sessionRef.current;
    sessionRef.current = null;
    resourceRef.current = null;
    setSession(null);
    setResource(null);
    setLoading(false);
    if (current) {
      void api.closeView(current.viewId).catch(() => undefined);
    }
  }, [api]);

  // Immediately unmount and close view if another frame took over, connection dropped, or topic changed.
  useEffect(() => {
    if (!isActive || !connected) {
      if (isActive && !connected) {
        activeMcpAppFrameManager.deactivate(frameKey);
      }
      teardownActiveView();
    }
  }, [isActive, connected, frameKey, teardownActiveView]);

  useEffect(() => {
    return () => {
      activeMcpAppFrameManager.deactivate(frameKey);
      teardownActiveView();
    };
  }, [frameKey, teardownActiveView]);

  // Load view session + verified text/html;profile=mcp-app resource on demand when expanded.
  useEffect(() => {
    if (!isActive || !connected) return;
    let alive = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setFrameHeight(DEFAULT_FRAME_HEIGHT);

    void (async () => {
      try {
        const { view } = await api.createView(
          {
            connectionId: mcpApp.connectionId,
            resourceUri: mcpApp.resourceUri,
            toolName: mcpApp.toolName,
            ...(mcpApp.title ? { title: mcpApp.title } : {}),
            ...(mcpApp.resultRef ? { resultRef: mcpApp.resultRef } : {}),
            expectedRevision: mcpApp.connectionRevision,
          },
          controller.signal,
        );
        if (!alive || controller.signal.aborted) {
          void api.closeView(view.viewId).catch(() => undefined);
          return;
        }
        if (!isValidCrossOriginSandboxUrl(view.sandboxUrl, view.sandboxOrigin)) {
          void api.closeView(view.viewId).catch(() => undefined);
          throw new Error(t("沙箱代理地址不是有效的异源回环地址。", "Sandbox proxy URL is not a valid cross-origin address."));
        }
        sessionRef.current = view;
        const { resource: loaded } = await api.readResource(
          { viewId: view.viewId, uri: view.resourceUri },
          controller.signal,
        );
        if (!alive || controller.signal.aborted) {
          void api.closeView(view.viewId).catch(() => undefined);
          return;
        }
        resourceRef.current = loaded;
        setSession(view);
        setResource(loaded);
      } catch (cause) {
        if (!alive || controller.signal.aborted) return;
        teardownActiveView();
        setError(
          redactSensitiveText(
            cause instanceof Error ? cause.message : t("无法加载只读视图", "Unable to load read-only view"),
          ),
        );
      } finally {
        if (alive && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [isActive, connected, mcpApp, api, t, teardownActiveView]);

  // Standard MCP Apps 2026-01-26 postMessage handshake over the cross-origin sandbox proxy.
  useEffect(() => {
    if (!isActive || !session || !resource) return;
    const activeSession = session;
    const handleMessage = createMcpAppHostMessageHandler({
      session: activeSession,
      resource,
      api,
      getTargetWindow: () => iframeRef.current?.contentWindow,
      isSessionStillActive: () => sessionRef.current?.viewId === activeSession.viewId,
      onResize: setFrameHeight,
      formatCallError: (cause) =>
        cause instanceof Error ? cause.message : t("只读工具调用失败", "Read-only tool call failed"),
    });
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [isActive, session, resource, api, t]);

  const displayTitle = mcpApp.title?.trim() || mcpApp.toolName;
  const openView = () => {
    if (!connected) return;
    setError(null);
    activeMcpAppFrameManager.activate(frameKey);
  };
  const closeView = () => {
    setError(null);
    activeMcpAppFrameManager.deactivate(frameKey);
    teardownActiveView();
  };

  return (
    <Card className="kulo-mcp-app-card" aria-label={`${mcpApp.connectionName} · ${displayTitle}`}>
      {/* Source identity bar stays strictly in Host DOM outside the sandbox iframe rectangle. */}
      <Card.Header className="kulo-mcp-app-header">
        <div className="kulo-mcp-app-source">
          <Card.Title className="kulo-mcp-app-title">{mcpApp.connectionName}</Card.Title>
          <span className="kulo-mcp-app-subtitle">{displayTitle}</span>
        </div>
        <Chip size="sm" variant="soft">{t("只读", "Read-only")}</Chip>
        {isActive ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={t(`收起 ${mcpApp.connectionName} 视图`, `Collapse ${mcpApp.connectionName} view`)}
            onPress={closeView}
          >
            {t("收起", "Collapse")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!connected}
            aria-label={t(`展开 ${mcpApp.connectionName} 视图`, `Open ${mcpApp.connectionName} view`)}
            onPress={openView}
          >
            {t("展开视图", "Open view")}
          </Button>
        )}
      </Card.Header>

      {error && (
        <Card.Content className="kulo-genui-content">
          <Alert status="danger" role="alert">
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
          {fallbackText && <p className="kulo-genui-fallback">{fallbackText}</p>}
        </Card.Content>
      )}

      {isActive && loading && (
        <Card.Content className="kulo-genui-content">
          <div className="flex items-center gap-2 text-xs text-muted" role="status">
            <Spinner size="sm" />
            <span>{t("正在加载只读视图…", "Loading read-only view…")}</span>
          </div>
        </Card.Content>
      )}

      {isActive && session && resource && (
        <Card.Content className="kulo-mcp-app-stage">
          <iframe
            ref={iframeRef}
            className="kulo-mcp-app-iframe"
            src={session.sandboxUrl}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            title={`${mcpApp.connectionName} · ${displayTitle}`}
            style={{ height: `${frameHeight}px` }}
          />
        </Card.Content>
      )}
    </Card>
  );
}
