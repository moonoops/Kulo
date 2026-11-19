import type { ChatReplyReference } from "@kulo/protocol";
import { Button } from "@heroui/react";
import { useI18n } from "../../kulo-i18n";
import { replyPreview } from "./reply-reference";
import "./message-reply.css";

export function MessageReply({ reply, onNavigateReply }: {
  reply: ChatReplyReference;
  onNavigateReply?: (messageId: number) => void;
}) {
  const { t } = useI18n();
  const author = reply.role === "user" ? t("你", "You") : "Kulo";
  const preview = replyPreview(reply);
  const content = <>
    <span className="kulo-message-reply-author">{author}</span>
    <span className="kulo-message-reply-text">{preview}</span>
  </>;
  return <aside className="kulo-message-reply" aria-label={t("回复引用", "Reply reference")} data-source-message-id={reply.messageId}>
    {onNavigateReply ? <Button variant="ghost" className="kulo-message-reply-trigger"
      aria-label={t(`查看原消息：${author}，${preview}`, `View original message: ${author}, ${preview}`)}
      onPress={() => onNavigateReply(reply.messageId)}>{content}</Button> : content}
  </aside>;
}
