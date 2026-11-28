import { useEffect, useState, type ReactNode } from "react";
import type { ChatReplyReference, ChatDisplayItem, MessagePart, UiCardSnapshot, UiValues } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { KuloMarkdown } from "../../kulo-markdown";
import { GeneratedCard, McpAppFrame } from "../genui";
import { CodeBlock } from "./code-block";
import { MessageContent } from "./message-content";
import { DeviceInvitationCopy } from "./device-invitation-copy";
import type { PreviewableImage } from "./asset-preview";
import { MessageActions } from "./message-actions";

type UiPart = Extract<MessagePart, { type: "ui" }>;

function ConnectedCard({ part, connected, conversationKey, onAdjust, onPreviewImage }: {
  part: UiPart;
  connected: boolean;
  conversationKey: string;
  onAdjust?: (card: UiCardSnapshot, values: UiValues) => void;
  onPreviewImage?: (image: PreviewableImage) => void;
}) {
  const [card, setCard] = useState(part.card);
  useEffect(() => { if (part.card) setCard(part.card); }, [part.card]);
  useEffect(() => {
    if (part.card) return;
    let alive = true;
    void kuloRest.getUiCard(part.cardId).then(({ card: latest }) => { if (alive) setCard(latest); }, () => { /* The persisted text remains available. */ });
    return () => { alive = false; };
  }, [part.cardId, part.card]);
  if (!card) return <KuloMarkdown text={part.fallbackText} onPreviewImage={onPreviewImage} />;
  if (card.schemaVersion !== 1 || card.catalogVersion !== 1) return <KuloMarkdown text={part.fallbackText} onPreviewImage={onPreviewImage} />;
  return <GeneratedCard card={card} fallbackText={part.fallbackText} isConnected={connected} onAdjust={onAdjust}
    onAction={async (input) => {
      const receipt = await kuloRest.submitUiAction(input);
      if (receipt.card) setCard(receipt.card);
      return receipt;
    }}
    renderCode={(props) => <CodeBlock {...props} />}
    renderMedia={({ assetId, alt }) => <MessageContent conversationKey={conversationKey} onPreviewImage={onPreviewImage}
      item={{ id: -1, role: "assistant", text: alt ?? "", parts: [{ partId: `card-asset:${assetId}`, type: "file", assetId, ...(alt ? { caption: alt } : {}) }] }} />}
  />;
}

export function ConnectedMessageContent({ item, connected = true, conversationKey = "root", deliveryScope, onPreviewImage, onAdjust, onReply, onSideQuestion, animateEntry = false, contentOnly = false, trailingContent, onNavigateReply }: {
  item: ChatDisplayItem;
  connected?: boolean;
  conversationKey?: string;
  deliveryScope?: string;
  onPreviewImage?: (image: PreviewableImage) => void;
  onAdjust?: (card: UiCardSnapshot, values: UiValues) => void;
  animateEntry?: boolean;
  contentOnly?: boolean;
  trailingContent?: ReactNode;
  onReply?: (reply: ChatReplyReference) => void;
  onSideQuestion?: (input: { quoteSnippet: string; sourceMessageId?: number }) => void;
  onNavigateReply?: (messageId: number) => void;
}) {
  const content = <MessageContent item={item} conversationKey={conversationKey} onPreviewImage={onPreviewImage} animateEntry={animateEntry} onNavigateReply={onNavigateReply}
    renderDeviceInvitation={(part) => <DeviceInvitationCopy key={`${deliveryScope ?? ""}:${conversationKey}:${part.hubId}`} hubId={part.hubId} hubName={part.hubName} partId={part.partId} connected={connected} deliveryScope={deliveryScope} />}
    renderUiPart={(part) => <ConnectedCard part={part} connected={connected} conversationKey={conversationKey} onPreviewImage={onPreviewImage} onAdjust={onAdjust} />}
    renderMcpAppPart={(part) => <McpAppFrame key={part.partId} partId={part.partId} mcpApp={part.mcpApp} fallbackText={part.fallbackText} connected={connected} conversationKey={conversationKey} />} />;
  return contentOnly ? <>{content}{trailingContent}</> : <MessageActions item={item} onReply={onReply} onSideQuestion={onSideQuestion} showFooter={!trailingContent}>{content}{trailingContent}</MessageActions>;
}
