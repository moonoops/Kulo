import { createElement, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ChatDisplayItem, LiveStreamState } from "@kulo/protocol";
import { KuloMarkdown } from "../../kulo-markdown";
import type { PreviewableImage } from "./asset-preview";
import type { ChatViewItem } from "./chat-submissions";
import type { ConversationEntry } from "./dispatch-groups";
import { useReducedContentMotion } from "./use-content-motion";
import "./message-motion.css";

export function messageMotionKey(item: Pick<ChatDisplayItem, "id" | "requestId" | "role" | "responseId">): string {
  if (item.role === "user" && item.requestId) return `request:${item.requestId}`;
  return `message:${item.id}`;
}

export function responseMotionScopes(entries: readonly ConversationEntry[], pending: readonly ChatDisplayItem[], live: Pick<LiveStreamState, "responseId">) {
  const messages = new Map<number, string>();
  let boundary = "start";
  const responseKey = (responseId: number | undefined, fallback: string) => responseId === undefined ? fallback : `${boundary}:response:${responseId}`;
  for (const entry of entries) {
    if (entry.type === "dispatch-group") {
      boundary = entry.key;
      for (const reply of entry.replies) messages.set(reply.id, responseKey(reply.responseId, messageMotionKey(reply)));
    } else if (entry.item.role === "assistant") messages.set(entry.item.id, responseKey(entry.item.responseId, messageMotionKey(entry.item)));
    else boundary = messageMotionKey(entry.item);
  }
  const last = entries.at(-1);
  const lastResponse = last?.type === "message" ? last.item.responseId : last?.replies.at(-1)?.responseId ?? last?.dispatches.at(-1)?.responseId;
  if (pending.length && (live.responseId === undefined || lastResponse !== live.responseId)) boundary = messageMotionKey(pending[0]!);
  return { messages, live: responseKey(live.responseId, `${boundary}:live`) };
}

export function useLiveResponseEntryMotion(conversationKey: string, live: Pick<LiveStreamState, "busy" | "responseId">, ready: boolean): boolean {
  const previous = useRef({ key: conversationKey, initialized: ready, busy: live.busy, responseId: live.responseId, fresh: false });
  const current = previous.current;
  if (current.key !== conversationKey) previous.current = { key: conversationKey, initialized: ready, busy: live.busy, responseId: live.responseId, fresh: false };
  else if (!current.initialized) previous.current = { ...current, initialized: ready, busy: live.busy, responseId: live.responseId, fresh: false };
  else if (!live.busy) previous.current = { ...current, busy: false, responseId: live.responseId, fresh: false };
  else previous.current = { ...current, busy: true, responseId: live.responseId, fresh: current.fresh || !current.busy || current.responseId !== undefined && current.responseId !== live.responseId };
  return previous.current.fresh;
}

export function useMessageEntryMotion(conversationKey: string, messages: readonly ChatViewItem[], newMessageIds: ReadonlySet<number>, ready: boolean) {
  const tracked = useRef<{ key: string; initialized: boolean; seen: Set<string>; fresh: Set<string> }>({ key: conversationKey, initialized: ready, seen: new Set(messages.map(messageMotionKey)), fresh: new Set() });
  if (tracked.current.key !== conversationKey) tracked.current = { key: conversationKey, initialized: ready, seen: new Set(messages.map(messageMotionKey)), fresh: new Set() };
  else if (!tracked.current.initialized) {
    tracked.current.seen = new Set(messages.map(messageMotionKey));
    tracked.current.initialized = ready;
  } else {
    const current = new Set<string>();
    for (const item of messages) {
      const key = messageMotionKey(item);
      current.add(key);
      if (!tracked.current.seen.has(key) && item.clientSubmission) tracked.current.fresh.add(key);
      tracked.current.seen.add(key);
    }
    for (const key of tracked.current.fresh) if (!current.has(key)) tracked.current.fresh.delete(key);
  }
  return (item: ChatViewItem): boolean => tracked.current.fresh.has(messageMotionKey(item)) || newMessageIds.has(item.id);
}

function motionReduced(reduced: boolean): boolean {
  return reduced || document.documentElement.dataset.reduceMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function MessageMotion({ animateEntry = false, scopeKey, className = "", as = "div", children }: {
  animateEntry?: boolean;
  scopeKey?: string | number;
  className?: string;
  as?: "div" | "article";
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedContentMotion();
  const entered = useRef<{ key: string | number | undefined; done: boolean }>({ key: scopeKey, done: false });
  useLayoutEffect(() => {
    if (entered.current.key !== scopeKey) entered.current = { key: scopeKey, done: false };
    if (entered.current.done) return;
    entered.current.done = true;
    const node = ref.current;
    if (!animateEntry || !node || motionReduced(reduced) || typeof node.animate !== "function") return;
    const animation = node.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 180, easing: "ease-out" });
    return () => animation.cancel();
  }, [scopeKey, animateEntry, reduced]);
  return createElement(as, { ref, className: `kulo-message-motion${className ? ` ${className}` : ""}` }, children);
}

export function StreamingMessage({ text, onPreviewImage }: { text: string; onPreviewImage?: (image: PreviewableImage) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useRef(new WeakSet<Element>());
  const running = useRef(new Set<Animation>());
  const reduced = useReducedContentMotion();
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Keep existing paragraphs and text nodes mounted as tokens arrive. Only new
    // Markdown blocks enter; updates never fade previously readable text again.
    for (const node of root.querySelectorAll(".kulo-chat-markdown > *, .kulo-chat-markdown li")) {
      if (seen.current.has(node)) continue;
      seen.current.add(node);
      if (!motionReduced(reduced) && typeof node.animate === "function") {
        const animation = node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease-out" });
        running.current.add(animation);
        void animation.finished.then(() => running.current.delete(animation), () => running.current.delete(animation));
      }
    }
  }, [text, reduced]);
  useEffect(() => () => { for (const animation of running.current) animation.cancel(); running.current.clear(); }, []);
  return <div ref={ref} className="kulo-streaming-message"><KuloMarkdown text={text} onPreviewImage={onPreviewImage} /></div>;
}
