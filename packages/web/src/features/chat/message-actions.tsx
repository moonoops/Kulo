import { translate as tr, useI18n } from "../../kulo-i18n";
import { Button, Spinner } from "@heroui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getMessageParts, messagePartFallback, type ChatAttachment, type ChatDisplayItem, type ChatReplyReference } from "@kulo/protocol";
import { KuloIcon } from "../../kulo-icon";
import { formatMessageTime } from "./message-time";
import { useVoiceWorkspace } from "../voice/voice-context";
import { VoiceIcon } from "../voice/voice-icons";
import { messageReply } from "./reply-reference";
import "./message-actions.css";

export function messageQuote(item: ChatDisplayItem): { text: string; attachments: ChatAttachment[] } {
  const parts = getMessageParts(item);
  return {
    text: parts.map(messagePartFallback).filter(Boolean).join("\n\n"),
    attachments: Array.from(new Map(parts.flatMap((part) => "asset" in part && part.asset ? [[part.asset.id, part.asset] as const] : [])).values()),
  };
}

export function MessageActions({ item, children, onReply, showFooter = true }: {
  item: ChatDisplayItem;
  children: ReactNode;
  onReply?: (reply: ChatReplyReference) => void;
  showFooter?: boolean;
}) {
  useI18n();
  const voice = useVoiceWorkspace();
  const root = useRef<HTMLDivElement>(null);
  const selected = useRef("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const quote = messageQuote(item);
  const speechKey = `${item.role}:${item.id}:${quote.text}`;
  const currentSpeech = voice?.speech?.key === speechKey ? voice.speech : null;
  const timestamp = item.role === "user" || item.role === "assistant" || item.role === "dispatch" ? formatMessageTime(item.createdAt) : undefined;
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const rememberSelection = () => {
    const selection = window.getSelection();
    if (selection?.anchorNode && selection.focusNode && root.current?.contains(selection.anchorNode) && root.current.contains(selection.focusNode)) {
      selected.current = selection.toString().trim();
    } else selected.current = "";
  };
  const copy = async () => {
    setError("");
    try {
      await navigator.clipboard.writeText(quote.text);
      setCopied(true);
    } catch { setError(tr("复制失败，请选择文字复制", "Copy failed. Select the text to copy it.")); }
  };
  return <div ref={root} className="kulo-message-with-actions" data-role={item.role}>
    {children}
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
        const reply = messageReply(item, selected.current || quote.text);
        if (reply) onReply(reply);
      }}>{tr("回复", "Reply")}</Button>}
      {error && <span className="kulo-message-action-error" role="status">{error}</span>}
      {currentSpeech?.error && <span className="kulo-message-action-error" role="status">{currentSpeech.error}</span>}
      </div>}
    </div>}
  </div>;
}
