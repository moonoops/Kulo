import { translate as tr, useI18n } from "../../kulo-i18n";
import { Button } from "@heroui/react";
import { Component, useEffect, useLayoutEffect, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { getMessageParts, messagePartFallback, type ChatAttachment, type ChatDisplayItem, type MessagePart } from "@kulo/protocol";
import { KuloMarkdown } from "../../kulo-markdown";
import { kuloRest } from "../../kulo-api";
import { AssetImageGallery, type PreviewableImage } from "./asset-preview";
import { CodeBlock } from "./code-block";
import { filePreviewKind, isOfficePreviewKind } from "./file-preview-model";
import { MediaMessage } from "./media-message";
import { MessageSources } from "./message-sources";
import { VoiceMessage } from "./voice-message";
import { ContentPresence } from "./use-content-motion";
import { MessageReply } from "./message-reply";
import "./chat-content.css";

type AssetPart = Extract<MessagePart, { assetId: string }>;
type UiPart = Extract<MessagePart, { type: "ui" }>;
export interface ContentGroup { id: string; parts: MessagePart[] }
interface ContentRow { group: ContentGroup; present: boolean; animateEntry: boolean }

export function groupMessageParts(parts: MessagePart[]): ContentGroup[] {
  const groups: ContentGroup[] = [];
  for (const part of parts) {
    const previous = groups.at(-1);
    if (part.type === "image" && previous?.parts[0]?.type === "image") previous.parts.push(part);
    else groups.push({ id: part.partId, parts: [part] });
  }
  return groups;
}

function reconcileRows(previous: ContentRow[], groups: ContentGroup[]): ContentRow[] {
  const next = new Map(groups.map((group) => [group.id, group]));
  const rows = previous.map((row) => ({ ...row, group: next.get(row.group.id) ?? row.group, present: next.has(row.group.id) }));
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (rows.some((row) => row.group.id === group.id)) continue;
    const following = groups.slice(index + 1).find((candidate) => rows.some((row) => row.group.id === candidate.id));
    const position = following ? rows.findIndex((row) => row.group.id === following.id) : rows.length;
    rows.splice(position, 0, { group, present: true, animateEntry: true });
  }
  return rows;
}

class ContentBoundary extends Component<{ children: ReactNode; fallback: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Chat content failed to render", error, info.componentStack); }
  render() {
    return this.state.failed ? <div className="kulo-chat-content-error"><p className="kulo-chat-meta">{tr("内容暂时无法显示", "Content temporarily unavailable")}</p><pre className="kulo-chat-fallback-text">{this.props.fallback}</pre><Button size="sm" variant="secondary" onPress={() => this.setState({ failed: false })}>{tr("重试", "Retry")}</Button></div> : this.props.children;
  }
}

const assetRequests = new Map<string, Promise<ChatAttachment>>();
function loadAsset(id: string): Promise<ChatAttachment> {
  const cached = assetRequests.get(id);
  if (cached) return cached;
  const request = kuloRest.getAsset(id).then(({ attachment }) => attachment);
  assetRequests.set(id, request);
  if (assetRequests.size > 128) assetRequests.delete(assetRequests.keys().next().value!);
  request.catch(() => assetRequests.delete(id));
  return request;
}

function ResolvedAssets({ parts, conversationKey, onPreviewImage, role }: {
  parts: AssetPart[];
  conversationKey?: string;
  onPreviewImage?: (image: PreviewableImage) => void;
  role: ChatDisplayItem["role"];
}) {
  useI18n();
  const [resolved, setResolved] = useState<Map<string, ChatAttachment>>(() => new Map());
  const [failures, setFailures] = useState<Set<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);
  const missingKey = parts.filter((part) => !part.asset).map((part) => part.assetId).join("\u0000");
  useEffect(() => {
    let alive = true;
    const missing = missingKey ? missingKey.split("\u0000") : [];
    setFailures(new Set());
    for (const id of missing) loadAsset(id).then((asset) => {
      if (alive) setResolved((previous) => new Map(previous).set(id, asset));
    }, () => { if (alive) setFailures((previous) => new Set(previous).add(id)); });
    return () => { alive = false; };
  }, [missingKey, attempt]);
  const assets = parts.flatMap((part) => { const asset = part.asset ?? resolved.get(part.assetId); return asset ? [asset] : []; });
  const unavailable = parts.filter((part) => !part.asset && !resolved.has(part.assetId));
  const fallbackByAsset = new Map(parts.filter((part) => part.fallbackText).map((part) => [part.assetId, part.fallbackText!]));
  return <>
    {parts[0]?.type === "image" ? <AssetImageGallery assets={assets} onPreviewImage={onPreviewImage} /> : assets.map((asset) => role === "user" && asset.kind === "audio" && asset.presentation === "voice" ? <VoiceMessage key={asset.id} asset={asset} conversationKey={conversationKey} /> : <MediaMessage key={asset.id} asset={asset} conversationKey={conversationKey} onPreviewImage={onPreviewImage} defaultExpanded={role === "assistant" || !isOfficePreviewKind(filePreviewKind(asset))} fallbackText={fallbackByAsset.get(asset.id)} />)}
    {unavailable.map((part) => <div key={part.partId} className="kulo-chat-unavailable-part" role="status"><span>{failures.has(part.assetId) ? tr("附件不可用", "Attachment unavailable") : tr("正在加载附件", "Loading attachment")}</span>{failures.has(part.assetId) && <Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>{tr("重试", "Retry")}</Button>}</div>)}
    {parts.some((part) => part.caption) && <p className="kulo-chat-media-caption">{parts.map((part) => part.caption).filter(Boolean).join("\n")}</p>}
  </>;
}

export function stableUserParts(item: Pick<ChatDisplayItem, "role" | "requestId">, parts: MessagePart[]): MessagePart[] {
  if (item.role !== "user" || !item.requestId) return parts;
  const prefix = `request:${item.requestId}`;
  return parts.map((part) => {
    const match = /^-?\d+:(text|asset:.+)$/.exec(part.partId);
    return match ? { ...part, partId: `${prefix}:${match[1]}` } : part;
  });
}

export function MessageContent({ item, onPreviewImage, renderUiPart, renderDeviceInvitation, conversationKey, animateEntry = false, onNavigateReply }: {
  item: ChatDisplayItem;
  onPreviewImage?: (image: PreviewableImage) => void;
  renderUiPart?: (part: UiPart) => ReactNode;
  renderDeviceInvitation?: (part: Extract<MessagePart, { type: "device-invitation" }>) => ReactNode;
  conversationKey?: string;
  animateEntry?: boolean;
  onNavigateReply?: (messageId: number) => void;
}) {
  useI18n();
  const groups = useMemo(
    () => groupMessageParts(stableUserParts(item, getMessageParts(item))),
    [item.id, item.role, item.requestId, item.text, item.parts, item.attachments],
  );
  const scope = `${conversationKey ?? ""}:${item.role === "user" && item.requestId ? `request:${item.requestId}` : item.id}`;
  const [snapshot, setSnapshot] = useState(() => ({ scope, rows: groups.map((group) => ({ group, present: true, animateEntry })) as ContentRow[] }));
  useLayoutEffect(() => {
    setSnapshot((previous) => previous.scope === scope ? { scope, rows: reconcileRows(previous.rows, groups) } : { scope, rows: groups.map((group) => ({ group, present: true, animateEntry: false })) });
  }, [groups, scope]);
  const [highlightedSourceUrl, setHighlightedSourceUrl] = useState<string | undefined>(undefined);
  const assistantSources = item.role === "assistant" && item.sources?.length ? item.sources : undefined;
  const rows = snapshot.scope === scope ? snapshot.rows : groups.map((group) => ({ group, present: true, animateEntry: false }));
  const render = (group: ContentGroup) => {
    const part = group.parts[0]!;
    switch (part.type) {
      case "markdown": return item.role === "user"
        ? <div className="mc-user-message kulo-chat-user-text">{part.text}</div>
        : <KuloMarkdown text={part.text} sources={assistantSources} highlightedSourceUrl={highlightedSourceUrl} onHighlightSource={assistantSources ? setHighlightedSourceUrl : undefined} onPreviewImage={onPreviewImage} />;
      case "code": return <CodeBlock code={part.code} language={part.language} fileName={part.fileName} />;
      case "ui": return renderUiPart ? renderUiPart(part) : <KuloMarkdown text={part.fallbackText} sources={assistantSources} onPreviewImage={onPreviewImage} />;
      case "device-invitation": return item.role === "assistant" && renderDeviceInvitation
        ? renderDeviceInvitation(part)
        : <span>{messagePartFallback(part)}</span>;
      default: return <ResolvedAssets parts={group.parts as AssetPart[]} conversationKey={conversationKey} onPreviewImage={onPreviewImage} role={item.role} />;
    }
  };
  return <div className="kulo-chat-content" data-role={item.role}>
    {item.replyTo && <MessageReply reply={item.replyTo} onNavigateReply={onNavigateReply} />}
    {rows.map((row) => <ContentPresence key={row.group.id} present={row.present} animateEntry={row.animateEntry} onExited={() => setSnapshot((previous) => ({ ...previous, rows: previous.rows.filter((candidate) => candidate.group.id !== row.group.id || candidate.present) }))}>
      <ContentBoundary fallback={row.group.parts.map(messagePartFallback).join("\n\n")}>{render(row.group)}</ContentBoundary>
    </ContentPresence>)}
    {assistantSources ? <MessageSources sources={assistantSources} searchSuggestions={item.searchSuggestions} highlightedSourceUrl={highlightedSourceUrl} onHighlightSource={setHighlightedSourceUrl} /> : null}
  </div>;
}
