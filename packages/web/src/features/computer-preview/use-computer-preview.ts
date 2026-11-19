import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getAuthTokenFromUrl } from "../../kulo-api";
import { ComputerPreviewClient, EMPTY_PREVIEW_STATE, type PreviewSocket } from "./preview-client";

export function computerPreviewSocketUrl(topicId: string): string {
  const url = new URL("/ws/computer-preview", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("topicId", topicId);
  const token = getAuthTokenFromUrl();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export function useComputerPreview(topicId: string, enabled: boolean) {
  const client = useMemo(() => new ComputerPreviewClient({ connect: () => new WebSocket(computerPreviewSocketUrl(topicId)) as unknown as PreviewSocket }), [topicId]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, () => EMPTY_PREVIEW_STATE);
  useEffect(() => {
    if (!enabled) return;
    client.start();
    const visibility = () => client.setPageVisible(document.visibilityState !== "hidden");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); client.close(); };
  }, [client, enabled]);
  return { client, state };
}
