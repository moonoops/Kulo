import { translate as t, useI18n } from "../../moco-i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { redactSensitiveText, type ConnectionWorkspaceSnapshot } from "@moco/protocol";
import { mocoRest } from "../../moco-api";

export function useConnectionsWorkspace({ enabled, connected, clientId, assistantBusy }: {
  enabled: boolean;
  connected: boolean;
  clientId: string;
  assistantBusy: boolean;
}) {
  useI18n();
  const [snapshot, setSnapshot] = useState<ConnectionWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const active = useRef({ enabled, connected, clientId });
  active.current = { enabled, connected, clientId };

  const refresh = useCallback(async () => {
    if (!active.current.enabled || !active.current.connected) return;
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const next = await mocoRest.getConnectionsWorkspace(active.current.clientId, controller.signal);
      if (current !== generation.current || controller.signal.aborted) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted) {
        setError(redactSensitiveText(cause instanceof Error ? cause.message : t("加载连接失败", "Failed to load connections")));
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !connected) {
      ++generation.current;
      request.current?.abort();
      setLoading(false);
      setSnapshot((current) => current ? { ...current, inputs: [] } : current);
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2500);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      ++generation.current;
      request.current?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, connected, clientId, assistantBusy, refresh]);

  return { snapshot, loading, error, refresh };
}
