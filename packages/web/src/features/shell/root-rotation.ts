import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { toast } from "@heroui/react";
import type { ConversationMessageWindow, TopicSummary } from "@kulo/protocol";
import type { DraftAttachment } from "../../kulo-composer";
import { translate as t } from "../../kulo-i18n";
import type { ConversationDestination } from "../chat/conversation-library";
import type { ReliableOutboxRecord } from "../chat/reliable-outbox";
import type { ReplyDrafts } from "../chat/reply-reference";
import { composerDraftKey, restoreComposerDraft, type TaskChatReturn } from "../tasks/task-navigation";

export interface TopicFrameCheckResult {
  accept: boolean;
  rotatedTo?: number;
}

/**
 * Evaluates whether an incoming `hub.messages` or `hub.live` frame matches the active topic
 * and active conversation generation, detecting forward `"root"` rotation when a view frame
 * arrives ahead of `hub.topics`.
 */
export function evaluateTopicConversationFrame(params: {
  frameTopicId?: string;
  frameVersion?: number;
  frameConversationId?: number;
  activeTopicId: string;
  activeConversationId?: number;
  selectionVersion: number;
  versionedSelections: boolean;
  changingTopic: boolean;
}): TopicFrameCheckResult {
  const {
    frameTopicId,
    frameVersion,
    frameConversationId,
    activeTopicId,
    activeConversationId,
    selectionVersion,
    versionedSelections,
    changingTopic,
  } = params;
  const topicMatches = !frameTopicId || frameTopicId === activeTopicId;
  const versionMatches =
    frameVersion === undefined
      ? !versionedSelections || !changingTopic
      : frameVersion === selectionVersion;
  if (!topicMatches || !versionMatches) return { accept: false };
  if (frameConversationId !== undefined && activeConversationId !== undefined && frameConversationId !== activeConversationId) {
    if ((frameTopicId ?? activeTopicId) === "root" && frameConversationId > activeConversationId) {
      return { accept: true, rotatedTo: frameConversationId };
    }
    return { accept: false };
  }
  return { accept: true };
}

export function findRootConversationId(topics: readonly TopicSummary[]): number | undefined {
  return topics.find((topic) => topic.id === "root")?.conversationId;
}

export interface UseRootRotationResetParams {
  rootConversationId?: number;
  deliveryScope?: string;
  scopedDraftKey: (key: string, scope?: string) => string;
  outboxRecords: readonly ReliableOutboxRecord[];
  discardFailedWs: (id: string, scope?: string) => Promise<void>;
  setComposerDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setReplyDrafts: Dispatch<SetStateAction<ReplyDrafts>>;
  restoreAttachments: (draftKey: string, attachments: DraftAttachment[]) => void;
  setMessageWindow: Dispatch<SetStateAction<ConversationMessageWindow | undefined>>;
  setPendingMessageJump: Dispatch<SetStateAction<ConversationDestination | undefined>>;
  setLocatingMessage: Dispatch<SetStateAction<boolean>>;
  setShowToBottom: Dispatch<SetStateAction<boolean>>;
  nearBottomRef: MutableRefObject<boolean>;
  returnChatScrollRef: MutableRefObject<TaskChatReturn | null>;
  messageNavigationRequest: MutableRefObject<AbortController | null>;
}

/**
 * Resets `"root"`-scoped UI view/reply/scroll state whenever the main conversation rotates
 * to a new `conversationId`, and cleanly recovers outbox entries rejected with
 * `root_conversation_rotated` (restoring unsent `chat.send` drafts without stale `replyTo`).
 */
export function useRootRotationReset(params: UseRootRotationResetParams): void {
  const {
    rootConversationId,
    deliveryScope,
    scopedDraftKey,
    outboxRecords,
    discardFailedWs,
    setComposerDrafts,
    setReplyDrafts,
    restoreAttachments,
    setMessageWindow,
    setPendingMessageJump,
    setLocatingMessage,
    setShowToBottom,
    nearBottomRef,
    returnChatScrollRef,
    messageNavigationRequest,
  } = params;

  const prevRootConvRef = useRef<number | undefined>(undefined);
  const handledRotatedOutboxRef = useRef(new Set<string>());

  useEffect(() => {
    const prev = prevRootConvRef.current;
    prevRootConvRef.current = rootConversationId;
    if (prev === undefined || rootConversationId === undefined || prev === rootConversationId) return;

    const rootDraftKey = scopedDraftKey(composerDraftKey("root"), deliveryScope);
    setReplyDrafts((current) => {
      if (!(rootDraftKey in current)) return current;
      const next = { ...current };
      delete next[rootDraftKey];
      return next;
    });
    setMessageWindow((current) => (current?.topicId === "root" ? undefined : current));
    setPendingMessageJump((current) => (current?.topicId === "root" ? undefined : current));
    messageNavigationRequest.current?.abort();
    setLocatingMessage(false);
    setShowToBottom(false);
    nearBottomRef.current = true;
    if (returnChatScrollRef.current?.topicId === "root") {
      returnChatScrollRef.current = null;
    }
  }, [
    rootConversationId,
    deliveryScope,
    scopedDraftKey,
    setReplyDrafts,
    setMessageWindow,
    setPendingMessageJump,
    setLocatingMessage,
    setShowToBottom,
    nearBottomRef,
    returnChatScrollRef,
    messageNavigationRequest,
  ]);

  useEffect(() => {
    const rotatedRecords = outboxRecords.filter(
      (record) =>
        record.state === "failed" &&
        record.errorCode === "root_conversation_rotated" &&
        !handledRotatedOutboxRef.current.has(record.id),
    );
    if (rotatedRecords.length === 0) return;

    let restoredSendCount = 0;
    for (const record of rotatedRecords) {
      handledRotatedOutboxRef.current.add(record.id);
      if (record.envelope.type === "chat.send") {
        const targetKey = scopedDraftKey(
          record.metadata?.draftKey ?? composerDraftKey("root"),
          record.scope,
        );
        const rawText = record.metadata?.rawUserText ?? record.envelope.content;
        if (rawText) {
          setComposerDrafts((cur) => restoreComposerDraft(cur, targetKey, rawText));
        }
        const attachments: DraftAttachment[] =
          record.metadata?.draftAttachments ??
          (record.envelope.attachments ?? []).map((attachment) => ({
            localId: `restored:${record.id}:${attachment.id}`,
            status: "ready",
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            kind: attachment.kind,
            attachment,
          }));
        if (attachments.length > 0) {
          restoreAttachments(targetKey, attachments);
        }
        restoredSendCount += 1;
      }
      void discardFailedWs(record.id, record.scope).catch(() => {});
    }

    if (restoredSendCount > 0) {
      toast(
        t(
          "主对话已开启新对话，未发出的消息已放回输入框。",
          "Main chat started fresh. Your unsent message is back in the composer.",
        ),
      );
    }
  }, [outboxRecords, scopedDraftKey, setComposerDrafts, restoreAttachments, discardFailedWs]);
}
