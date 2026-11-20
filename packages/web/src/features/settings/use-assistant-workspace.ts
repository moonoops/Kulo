import { translate as t, useI18n } from "../../kulo-i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { redactSensitiveText } from "@kulo/protocol";
import { kuloRest, type AssistantWorkspaceView } from "../../kulo-api";

export function useAssistantWorkspace({ enabled, connected, assistantBusy }: {
  enabled: boolean;
  connected: boolean;
  assistantBusy: boolean;
}) {
  useI18n();
  const [snapshot, setSnapshot] = useState<AssistantWorkspaceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const active = useRef({ enabled, connected });
  active.current = { enabled, connected };

  const refresh = useCallback(async () => {
    if (!active.current.enabled || !active.current.connected) return;
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const next = await kuloRest.getAssistantWorkspace(controller.signal);
      if (current !== generation.current || controller.signal.aborted) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted) {
        setError(redactSensitiveText(cause instanceof Error ? cause.message : t("加载实时感知状态失败", "Failed to load ambient awareness status")));
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
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      ++generation.current;
      request.current?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, connected, assistantBusy, refresh]);

  return { snapshot, setSnapshot, loading, error, refresh };
}
