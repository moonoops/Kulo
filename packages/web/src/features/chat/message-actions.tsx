import { translate as tr, useI18n } from "../../kulo-i18n";
import { Button, Spinner } from "@heroui/react";
import { createPortal } from "react-dom";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getMessageParts, messagePartFallback, type ChatAttachment, type ChatDisplayItem, type ChatReplyReference } from "@kulo/protocol";
import { KuloIcon } from "../../kulo-icon";
import { formatMessageTime } from "./message-time";
import { useVoiceWorkspace } from "../voice/voice-context";
import { VoiceIcon } from "../voice/voice-icons";
import { messageReply } from "./reply-reference";
import "./message-actions.css";

const MessageReplyContext = createContext<((excerpt: string) => void) | undefined>(undefined);

export function useMessageReply(): ((excerpt: string) => void) | undefined {
  return useContext(MessageReplyContext);
}

const EXCLUDED_SELECTION_SELECTOR = [
  ".kulo-chat-code-toolbar",
  ".kulo-chat-code-footer",
  ".kulo-artifact-header",
  ".kulo-artifact-compact-row",
  ".kulo-artifact-collapsed",
  ".kulo-artifact-feedback",
  ".kulo-artifact-error",
  ".kulo-artifact-unsupported",
  ".kulo-pdf-toolbar",
  ".kulo-pptx-toolbar",
  ".kulo-xlsx-bar",
  ".kulo-message-reply",
  ".kulo-message-sources",
  ".kulo-message-footer",
  ".kulo-selection-quote-bar",
  "button",
  "input",
  "textarea",
  "[role=\"dialog\"]",
  "iframe",
].join(", ");

const STRIP_SELECTION_SELECTOR = [
  "[aria-hidden=\"true\"]",
  ".kulo-chat-code-toolbar",
  ".kulo-chat-code-footer",
  ".kulo-artifact-header",
  ".kulo-artifact-compact-row",
  ".kulo-artifact-collapsed",
  ".kulo-artifact-feedback",
  ".kulo-artifact-error",
  ".kulo-artifact-unsupported",
  ".kulo-pdf-toolbar",
  ".kulo-pptx-toolbar",
  ".kulo-xlsx-bar",
  ".kulo-message-reply",
  ".kulo-message-sources",
  ".kulo-message-footer",
  ".kulo-selection-quote-bar",
].join(", ");

interface SelectionRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SelectionQuoteBarPosition {
  text: string;
  top: number;
  left: number;
  placement: "above" | "below";
}

const CLIPPING_OVERFLOW = /^(?:auto|scroll|hidden|clip)$/;

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function isFinePointerEnvironment(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
}

function intersectRect(a: SelectionRect, b: SelectionRect): SelectionRect | null {
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  if (right <= left || bottom <= top) return null;
  return { top, bottom, left, right };
}

function visibleClipBounds(node: Element | null, vw: number, vh: number): SelectionRect | null {
  let clip: SelectionRect = { top: 0, left: 0, right: vw, bottom: vh };
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return clip;
  const body = typeof document !== "undefined" ? document.body : null;
  const docEl = typeof document !== "undefined" ? document.documentElement : null;
  for (let current: Element | null = node; current && current !== body && current !== docEl; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    const clipsX = CLIPPING_OVERFLOW.test(style.overflowX || style.overflow);
    const clipsY = CLIPPING_OVERFLOW.test(style.overflowY || style.overflow);
    if (!clipsX && !clipsY) continue;
    const box = current.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const next = intersectRect(clip, {
      top: clipsY ? box.top : clip.top,
      bottom: clipsY ? box.bottom : clip.bottom,
      left: clipsX ? box.left : clip.left,
      right: clipsX ? box.right : clip.right,
    });
    if (!next) return null;
    clip = next;
  }
  return clip;
}

function resolveVisibleSelectionRect(range: Range, anchorEl: Element | null, vw: number, vh: number): SelectionRect | null {
  const clip = visibleClipBounds(anchorEl, vw, vh);
  if (!clip) return null;

  const rawRects: SelectionRect[] = [];
  if (typeof range.getClientRects === "function") {
    for (const candidate of Array.from(range.getClientRects())) {
      if (candidate.width === 0 && candidate.height === 0) continue;
      const clipped = intersectRect(candidate, clip);
      if (clipped) rawRects.push(clipped);
    }
  }
  if (rawRects.length > 0) {
    let minTop = rawRects[0]!.top;
    for (const candidate of rawRects) {
      if (candidate.top < minTop) minTop = candidate.top;
    }
    const topLine = rawRects.filter((candidate) => candidate.top - minTop <= 4);
    let top = topLine[0]!.top;
    let bottom = topLine[0]!.bottom;
    let left = topLine[0]!.left;
    let right = topLine[0]!.right;
    for (const candidate of topLine.slice(1)) {
      if (candidate.top < top) top = candidate.top;
      if (candidate.bottom > bottom) bottom = candidate.bottom;
      if (candidate.left < left) left = candidate.left;
      if (candidate.right > right) right = candidate.right;
    }
    return { top, bottom, left, right };
  }

  const bounding = range.getBoundingClientRect();
  if (bounding.width === 0 && bounding.height === 0) return null;
  return intersectRect(bounding, clip);
}

export function extractValidMessageSelection(rootEl: HTMLElement | null): SelectionQuoteBarPosition | null {
  if (!rootEl || typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode || !rootEl.contains(anchorNode) || !rootEl.contains(focusNode)) return null;
  const anchorEl = elementOf(anchorNode);
  const focusEl = elementOf(focusNode);
  if (anchorEl?.isConnected === false || focusEl?.isConnected === false) return null;
  if (anchorEl?.closest(EXCLUDED_SELECTION_SELECTOR) || focusEl?.closest(EXCLUDED_SELECTION_SELECTOR)) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (
    !rootEl.contains(range.commonAncestorContainer)
    || (range.startContainer && !rootEl.contains(range.startContainer))
    || (range.endContainer && !rootEl.contains(range.endContainer))
  ) {
    return null;
  }

  let text = selection.toString();
  if (typeof document !== "undefined") {
    const fragment = range.cloneContents();
    if (fragment.querySelector(STRIP_SELECTION_SELECTOR)) {
      fragment.querySelectorAll(STRIP_SELECTION_SELECTOR).forEach((el) => el.remove());
      text = fragment.textContent ?? "";
    }
  }
  const trimmed = text.trim();
  if (!trimmed) return null;

  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const rect = resolveVisibleSelectionRect(range, elementOf(range.commonAncestorContainer) ?? anchorEl, vw, vh);
  if (!rect) return null;
  const left = Math.min(Math.max(rect.left + (rect.right - rect.left) / 2, 48), Math.max(48, vw - 48));
  if (rect.top >= 48) {
    return { text: trimmed, top: rect.top - 8, left, placement: "above" };
  }
  return { text: trimmed, top: Math.min(Math.max(12, vh - 44), rect.bottom + 8), left, placement: "below" };
}

export function messageQuote(item: ChatDisplayItem): { text: string; attachments: ChatAttachment[] } {
  const parts = getMessageParts(item);
  return {
    text: parts.map(messagePartFallback).filter(Boolean).join("\n\n"),
    attachments: Array.from(new Map(parts.flatMap((part) => "asset" in part && part.asset ? [[part.asset.id, part.asset] as const] : [])).values()),
  };
}

export function MessageActions({ item, children, onReply, onSideQuestion, showFooter = true }: {
  item: ChatDisplayItem;
  children: ReactNode;
  onReply?: (reply: ChatReplyReference) => void;
  onSideQuestion?: (input: { quoteSnippet: string; sourceMessageId?: number }) => void;
  showFooter?: boolean;
}) {
  useI18n();
  const voice = useVoiceWorkspace();
  const root = useRef<HTMLDivElement>(null);
  const selected = useRef("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [selectionBar, setSelectionBar] = useState<SelectionQuoteBarPosition | null>(null);
  const quote = messageQuote(item);
  const speechKey = `${item.role}:${item.id}:${quote.text}`;
  const currentSpeech = voice?.speech?.key === speechKey ? voice.speech : null;
  const timestamp = item.role === "user" || item.role === "assistant" || item.role === "dispatch" ? formatMessageTime(item.createdAt) : undefined;
  const canReply = Boolean(onReply && (item.role === "user" || item.role === "assistant" || item.role === "dispatch"));
  const quoteExcerpt = useMemo(
    () =>
      canReply && onReply
        ? (excerpt: string) => {
            const reply = messageReply(item, excerpt, { excerpt: true });
            if (reply) onReply(reply);
          }
        : undefined,
    [canReply, item, onReply],
  );
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const rememberSelection = useCallback(() => {
    const extracted = extractValidMessageSelection(root.current);
    selected.current = extracted?.text ?? "";
  }, []);
  const canSideQuestion = Boolean(onSideQuestion && (item.role === "user" || item.role === "assistant" || item.role === "dispatch"));
  useEffect(() => {
    if ((!quoteExcerpt && !canSideQuestion) || !isFinePointerEnvironment()) {
      setSelectionBar(null);
      return;
    }
    const syncSelection = () => {
      const extracted = extractValidMessageSelection(root.current);
      setSelectionBar(extracted);
    };
    const clearBar = () => setSelectionBar(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectionBar(null);
    };
    document.addEventListener("selectionchange", syncSelection);
    window.addEventListener("scroll", clearBar, true);
    window.addEventListener("resize", clearBar);
    window.addEventListener("blur", clearBar);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", syncSelection);
      window.removeEventListener("scroll", clearBar, true);
      window.removeEventListener("resize", clearBar);
      window.removeEventListener("blur", clearBar);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quoteExcerpt, canSideQuestion]);
  const copy = async () => {
    setError("");
    try {
      await navigator.clipboard.writeText(quote.text);
      setCopied(true);
    } catch { setError(tr("复制失败，请选择文字复制", "Copy failed. Select the text to copy it.")); }
  };
  const selectionToolbar = selectionBar && (quoteExcerpt || canSideQuestion) && typeof document !== "undefined"
    ? createPortal(
      <div
        className="kulo-selection-quote-bar"
        data-placement={selectionBar.placement}
        role="toolbar"
        aria-label={tr("引用选中内容", "Quote selection")}
        style={{ top: selectionBar.top, left: selectionBar.left }}
        onPointerDown={(event) => { event.preventDefault(); }}
      >
        {quoteExcerpt && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={tr("引用选中文本", "Quote selected text")}
            onPress={() => {
              const snippet = selectionBar.text;
              setSelectionBar(null);
              window.getSelection()?.removeAllRanges();
              quoteExcerpt(snippet);
            }}
          >
            {tr("引用", "Quote")}
          </Button>
        )}
        {canSideQuestion && onSideQuestion && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={tr("支线追问选中文本", "Ask side question about selected text")}
            onPress={() => {
              const snippet = selectionBar.text;
              setSelectionBar(null);
              window.getSelection()?.removeAllRanges();
              onSideQuestion({
                quoteSnippet: snippet,
                ...(item.id > 0 ? { sourceMessageId: item.id } : {}),
              });
            }}
          >
            {tr("支线追问", "Side question")}
          </Button>
        )}
      </div>,
      document.body,
    )
    : null;
  return <MessageReplyContext.Provider value={quoteExcerpt}>
    <div ref={root} className="kulo-message-with-actions" data-role={item.role}>
      {children}
      {selectionToolbar}
      {showFooter && (timestamp || quote.text) && <div className="kulo-message-footer">
        {timestamp && <time className="kulo-message-timestamp" dateTime={timestamp.dateTime} title={timestamp.title}>{timestamp.label}</time>}
        {quote.text && <div className="kulo-message-actions"
        onPointerDownCapture={(event) => { if (event.currentTarget.contains(event.target as Node)) rememberSelection(); }}
        onFocusCapture={(event) => { if (event.currentTarget.contains(event.target as Node)) rememberSelection(); }}>
        <Button size="sm" variant="ghost" className="kulo-message-action" onPress={() => { void copy(); }} aria-label={tr("复制消息", "Copy message")}><KuloIcon name="copy" size={12} />{copied ? tr("已复制", "Copied") : tr("复制", "Copy")}</Button>
        {item.role === "assistant" && voice?.snapshot?.tts.enabled && <Button size="sm" variant="ghost" className="kulo-message-action" aria-label={currentSpeech?.phase === "loading" ? tr("取消朗读", "Cancel reading") : currentSpeech?.phase === "playing" ? tr("停止朗读", "Stop reading") : tr("朗读消息", "Read message aloud")} aria-busy={currentSpeech?.phase === "loading" || undefined} isDisabled={!voice.connected || voice.call.active} onPress={() => {
          if (currentSpeech && currentSpeech.phase !== "error") voice.stopSpeech();
          else { setError(""); void voice.speak(quote.text, speechKey).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : tr("朗读失败，请重试", "Unable to read aloud. Please retry."))); }
        }}>{currentSpeech?.phase === "loading" ? <Spinner size="sm" className="kulo-message-action-icon" /> : <VoiceIcon name="speaker" size={12} className="kulo-message-action-icon" />}{currentSpeech?.phase === "loading" ? tr("取消", "Cancel") : currentSpeech?.phase === "playing" ? tr("停止", "Stop") : currentSpeech?.phase === "error" ? tr("重试朗读", "Retry reading") : tr("朗读", "Read aloud")}</Button>}
        {onReply && messageReply(item, quote.text) && <Button size="sm" variant="ghost" className="kulo-message-action" aria-label={tr("回复消息", "Reply to message")} onPress={() => {
          const isExcerpt = Boolean(selected.current);
          const reply = messageReply(item, selected.current || quote.text, { excerpt: isExcerpt });
          if (reply) onReply(reply);
        }}>{tr("回复", "Reply")}</Button>}
        {error && <span className="kulo-message-action-error" role="status">{error}</span>}
        {currentSpeech?.error && <span className="kulo-message-action-error" role="status">{currentSpeech.error}</span>}
        </div>}
      </div>}
    </div>
  </MessageReplyContext.Provider>;
}
