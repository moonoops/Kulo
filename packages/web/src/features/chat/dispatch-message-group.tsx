import type { ReactNode } from "react";
import type { ChatReplyReference, ChatDisplayItem } from "@moco/protocol";
import { MessageActions } from "./message-actions";
import { dispatchGroupActionItem, type DispatchReplyGroup } from "./dispatch-groups";

export function DispatchMessageGroup<T extends ChatDisplayItem>({ group, renderMessage, onReply, trailingContent, onNavigateReply }: {
  group: DispatchReplyGroup<T>;
  renderMessage: (item: T, onNavigateReply?: (messageId: number) => void) => ReactNode;
  onReply?: (reply: ChatReplyReference) => void;
  onNavigateReply?: (messageId: number) => void;
  trailingContent?: ReactNode;
}) {
  return <MessageActions item={dispatchGroupActionItem(group)} onReply={onReply} showFooter={!trailingContent}>
    <div className="moco-dispatch-message-content">
      {group.dispatches.map((item) => renderMessage(item, onNavigateReply))}
      {group.replies.map((item) => renderMessage(item, onNavigateReply))}
      {trailingContent}
    </div>
  </MessageActions>;
}
