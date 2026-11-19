import { isComputerPreviewUpdate, type ComputerPreviewServerMessage, type ComputerPreviewSessionView, type ComputerPreviewUpdate } from "@kulo/protocol";
import type { RawData, WebSocket } from "ws";

export interface ComputerPreviewSource {
  listComputerPreviews(topicId: string): Promise<ComputerPreviewSessionView[]>;
  subscribeComputerPreview(id: string, topicId: string, onUpdate: (update: ComputerPreviewUpdate) => void): Promise<() => void>;
}

interface Subscription {
  dispose?: () => void;
}

/** A separate transport keeps image backpressure out of the conversation socket. */
export function attachComputerPreviewSocket(
  ws: WebSocket,
  source: ComputerPreviewSource,
  topicId: string,
  options: { pollMs?: number; isPrincipalActive?: () => boolean } = {},
): () => void {
  const subscriptions = new Map<string, Subscription>();
  const latestFrames = new Map<string, ComputerPreviewUpdate>();
  const retryAfter = new Map<string, number>();
  let sessions = new Map<string, ComputerPreviewSessionView>();
  let signature: string | undefined;
  let visible = true;
  let closed = false;
  let polling = false;
  let lastError: string | undefined;

  const removeSubscription = (id: string) => {
    const subscription = subscriptions.get(id);
    subscriptions.delete(id);
    latestFrames.delete(id);
    subscription?.dispose?.();
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(frameTimer);
    for (const id of subscriptions.keys()) removeSubscription(id);
    latestFrames.clear();
    retryAfter.clear();
    ws.off("message", onMessage);
    ws.off("close", cleanup);
    ws.off("error", onSocketError);
  };
  const close = (code: number, reason: string) => {
    cleanup();
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };
  const send = (message: ComputerPreviewServerMessage): boolean => {
    if (closed || ws.readyState !== ws.OPEN) return false;
    if (options.isPrincipalActive && !options.isPrincipalActive()) { close(4001, "Preview authorization revoked"); return false; }
    if (ws.bufferedAmount > 8 * 1024 * 1024) { close(1013, "Preview consumer too slow"); return false; }
    try { ws.send(JSON.stringify(message)); return true; }
    catch { close(1011, "Preview transport failed"); return false; }
  };
  const flushFrames = () => {
    if (closed || !visible || ws.readyState !== ws.OPEN) return;
    for (const [id, update] of latestFrames) {
      if (ws.bufferedAmount > 512 * 1024) break;
      latestFrames.delete(id);
      if (sessions.has(id) && subscriptions.has(id)) send({ type: "preview.update", id, update });
    }
  };
  const subscribe = (id: string) => {
    const subscription: Subscription = {};
    subscriptions.set(id, subscription);
    void source.subscribeComputerPreview(id, topicId, (update) => {
      if (closed || !visible || subscriptions.get(id) !== subscription || !sessions.has(id)) return;
      if (!isComputerPreviewUpdate(update)) {
        latestFrames.delete(id);
        send({ type: "preview.update", id, update: { state: "unavailable", message: "画面格式无效。" } });
        return;
      }
      if (update.state === "closed") {
        removeSubscription(id);
        retryAfter.set(id, Date.now() + 500);
        send({ type: "preview.update", id, update });
        return;
      }
      if (update.frame) {
        latestFrames.set(id, update);
        flushFrames();
      } else {
        latestFrames.delete(id);
        send({ type: "preview.update", id, update });
      }
    }).then((dispose) => {
      if (closed || !visible || subscriptions.get(id) !== subscription || !sessions.has(id)) dispose();
      else subscription.dispose = dispose;
    }, () => {
      if (closed || subscriptions.get(id) !== subscription) return;
      removeSubscription(id);
      retryAfter.set(id, Date.now() + 2000);
      send({ type: "preview.update", id, update: { state: "unavailable", message: "暂时无法连接操作画面。" } });
    });
  };
  const poll = async () => {
    if (closed || polling) return;
    if (options.isPrincipalActive && !options.isPrincipalActive()) { close(4001, "Preview authorization revoked"); return; }
    polling = true;
    try {
      const available = (await source.listComputerPreviews(topicId)).slice(0, 16);
      if (closed) return;
      const next = new Map(available.map((session) => [session.id, session]));
      for (const id of subscriptions.keys()) if (!next.has(id)) removeSubscription(id);
      for (const id of retryAfter.keys()) if (!next.has(id)) retryAfter.delete(id);
      sessions = next;
      const nextSignature = JSON.stringify(available);
      if (signature !== nextSignature) {
        signature = nextSignature;
        send({ type: "preview.sessions", sessions: available });
      }
      lastError = undefined;
      if (visible) for (const id of sessions.keys()) {
        if (!subscriptions.has(id) && (retryAfter.get(id) ?? 0) <= Date.now()) subscribe(id);
      }
    } catch {
      if (!closed) {
        for (const id of subscriptions.keys()) removeSubscription(id);
        sessions.clear();
        signature = undefined;
        const message = "暂时无法获取操作画面。";
        if (lastError !== message) send({ type: "preview.error", message });
        lastError = message;
      }
    } finally { polling = false; }
  };
  const onMessage = (raw: RawData, binary: boolean) => {
    if (closed) return;
    const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    if (binary || bytes.byteLength > 1024) { close(1008, "Invalid preview command"); return; }
    let message: unknown;
    try { message = JSON.parse(bytes.toString("utf8")); }
    catch { close(1008, "Invalid preview command"); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)
      || Object.keys(message).some((key) => key !== "type" && key !== "visible")
      || (message as { type?: unknown }).type !== "preview.visibility"
      || typeof (message as { visible?: unknown }).visible !== "boolean") {
      close(1008, "Invalid preview command");
      return;
    }
    visible = (message as { visible: boolean }).visible;
    if (!visible) for (const id of subscriptions.keys()) removeSubscription(id);
    else void poll();
  };
  const onSocketError = () => cleanup();
  const pollTimer = setInterval(() => { void poll(); }, options.pollMs ?? 500);
  const frameTimer = setInterval(flushFrames, 100);
  pollTimer.unref();
  frameTimer.unref();
  ws.on("message", onMessage);
  ws.once("close", cleanup);
  ws.once("error", onSocketError);
  void poll();
  return cleanup;
}
