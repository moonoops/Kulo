import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  ChatReplyReference,
  ClientToHubMessage,
  TicketCardView,
  TopicSummary,
} from "@kulo/protocol";
import {
  KuloWsDisconnectedError,
  type TicketDetailSnapshot,
} from "../../kulo-api";
import type { DraftAttachment } from "../../kulo-composer";
import { translate as t } from "../../kulo-i18n";
import { composerDraftKey } from "../tasks/task-navigation";
import type { TopicDraftStore } from "../topics/topic-drafts";
import {
  submissionKey,
  type PendingSubmissionBackup,
  type SubmissionBackupInput,
} from "./chat-submissions";
import { redactChatInvitation } from "./device-invitation-outbox";
import { consumePersistedDraft } from "./outbox-submissions";
import { newDeliveryId } from "./reliable-intents";
import type { ReliableOutboxMetadata, ReliableOutboxRecord } from "./reliable-outbox";
import { consumeReplyDraft, type ReplyDrafts } from "./reply-reference";
import { resolveFailedChatRetryEnvelope } from "./use-target-device-selection";
import type { TranscribeVoice } from "./voice-recorder";
import { transcribeVoiceRecording } from "./voice-transcription";

export interface UseChatSubmissionParams {
  connected: boolean;
  outboxReady: boolean;
  deliveryScope?: string;
  activeTopicId: string;
  activeTopic?: TopicSummary;
  projectedTicketId?: string;
  projectedTicketRef: MutableRefObject<string | undefined>;
  ticketById: Map<string, TicketCardView>;
  inspectedTicket: TicketDetailSnapshot | null;
  topicDrafts: TopicDraftStore;
  currentDraftKey: string;
  currentConversationDraftKey: string;
  currentDraft: string;
  currentReply?: ChatReplyReference;
  currentAttachments: DraftAttachment[];
  draftEditRevisionRef: MutableRefObject<number>;
  editingSubmissionRef: MutableRefObject<
    Map<string, { id: string; sequence: number; scope: string }>
  >;
  selectedTargetDeviceId: string;
  persistedTargetDeviceId: string;
  topicTargetOverrides: Record<string, string>;
  setTopicTargetOverrides: Dispatch<SetStateAction<Record<string, string>>>;
  waitForPendingTargetDevice?: (topicId: string) => Promise<void>;
  viewingHistory: boolean;
  clearMessageWindow: () => void;
  nearBottomRef: MutableRefObject<boolean>;
  setShowToBottom: Dispatch<SetStateAction<boolean>>;
  setComposerDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setReplyDrafts: Dispatch<SetStateAction<ReplyDrafts>>;
  removeAttachment: (draftKey: string, localId: string) => void;
  setActionError: Dispatch<SetStateAction<string | null>>;
  clearError: () => void;
  closeProjection: () => void;
  selectTopic: (topicId: string) => void;
  enqueueWs: (
    message: ClientToHubMessage,
    metadata?: ReliableOutboxMetadata,
    expectedScope?: string,
  ) => Promise<ReliableOutboxRecord>;
  retryQueuedWs: (id: string, scope?: string) => Promise<ReliableOutboxRecord>;
  waitForQueuedAck: (record: ReliableOutboxRecord) => Promise<unknown>;
  sendWsWithAck: (message: ClientToHubMessage) => Promise<unknown>;
  deviceJoin?: { submit: () => void };
  clientId: string;
}

export function useChatSubmission(params: UseChatSubmissionParams) {
  const submitFlightRef = useRef(false);
  const submittedIntentRef = useRef<string | undefined>(undefined);
  const resumeFlightsRef = useRef(new Set<string>());
  const [resumingQueuedTopic, setResumingQueuedTopic] = useState<string>();

  const dispatchSubmissionWithAck = async (
    input: SubmissionBackupInput | PendingSubmissionBackup,
  ) => {
    await params.waitForPendingTargetDevice?.(input.topicId);
    const key = submissionKey(input);
    const replacementEnvelope =
      "localMessageId" in input
        ? resolveFailedChatRetryEnvelope({
            backup: input,
            activeTopicId: params.activeTopicId,
            isProjectTopic: Boolean(params.activeTopic?.projectId),
            selectedTargetDeviceId: params.selectedTargetDeviceId,
            persistedTargetDeviceId: params.persistedTargetDeviceId,
          })
        : null;
    const replacesFailed = replacementEnvelope
      ? {
          id: key,
          sequence: (input as PendingSubmissionBackup).localSequence!,
          scope: (input as PendingSubmissionBackup).outboxScope!,
        }
      : "localMessageId" in input
        ? undefined
        : params.editingSubmissionRef.current.get(params.currentDraftKey);
    const record =
      "localMessageId" in input && !replacementEnvelope
        ? await params.retryQueuedWs(key, input.outboxScope)
        : await params.enqueueWs(
            replacementEnvelope ?? input.envelope,
            {
              topicId: input.topicId,
              draftKey: input.draftKey,
              rawUserText: input.rawUserText,
              draftAttachments: input.draftAttachments,
              ...(replacesFailed ? { replacesFailed } : {}),
            },
            "localMessageId" in input && replacementEnvelope ? input.outboxScope : params.deliveryScope,
          );
    if (replacesFailed && !replacementEnvelope) {
      params.editingSubmissionRef.current.delete(params.currentDraftKey);
    }
    void params.waitForQueuedAck(record).catch((error: unknown) => {
      if (error && typeof error === "object" && "isDisconnect" in error) return;
      if (input.envelope.type === "ticket.steer") {
        params.setActionError(
          error instanceof Error
            ? error.message
            : t("任务指令被中枢拒绝", "The hub rejected the task instruction"),
        );
      }
    });
    return record;
  };

  const resumeQueuedMessages = (topicId: string) => {
    if (!params.outboxReady || resumeFlightsRef.current.has(topicId)) return;
    resumeFlightsRef.current.add(topicId);
    setResumingQueuedTopic(topicId);
    void (async () => {
      await params.waitForPendingTargetDevice?.(topicId);
      await params.sendWsWithAck({ type: "chat.retry", topicId });
    })()
      .catch((error) =>
        params.setActionError(
          error instanceof Error
            ? error.message
            : t("继续处理失败", "Could not resume processing"),
        ),
      )
      .finally(() => {
        resumeFlightsRef.current.delete(topicId);
        setResumingQueuedTopic((current) =>
          current === topicId ? undefined : current,
        );
      });
  };

  const submitMessage = async (overrideText?: string) => {
    if (overrideText === undefined && params.deviceJoin) {
      params.deviceJoin.submit();
      return;
    }
    if (submitFlightRef.current) return;
    params.setActionError(null);
    params.clearError();
    const sourceReply =
      overrideText === undefined ? params.currentReply : undefined;
    const { content, replyTo } = redactChatInvitation(
      overrideText ?? params.currentDraft,
      sourceReply,
    );
    const raw = content.trim();
    const isUploading =
      overrideText === undefined &&
      params.currentAttachments.some((a) => a.status === "uploading");
    const readyDraftAttachments =
      overrideText === undefined
        ? params.currentAttachments.filter(
            (a) => a.status === "ready" && Boolean(a.attachment),
          )
        : [];
    const attachmentsToSend = readyDraftAttachments.map((a) => a.attachment!);

    if (isUploading || (!raw && attachmentsToSend.length === 0)) return;
    const intent = JSON.stringify([
      params.currentDraftKey,
      params.draftEditRevisionRef.current,
      overrideText === undefined ? null : raw,
      readyDraftAttachments.map((item) => item.localId),
      replyTo ?? null,
      params.selectedTargetDeviceId,
    ]);
    if (submittedIntentRef.current === intent) return;
    if (!params.outboxReady) {
      params.setActionError(
        t(
          "待发队列尚未就绪，输入草稿已保留",
          "The send queue is not ready. Your draft is saved.",
        ),
      );
      return;
    }
    if (!params.projectedTicketId) {
      if (params.viewingHistory) params.clearMessageWindow();
      params.nearBottomRef.current = true;
      params.setShowToBottom(false);
    }
    submitFlightRef.current = true;
    const sourceDraftKey = params.currentDraftKey;
    const sourceDraft = params.currentDraft;
    const consumeDraft = () => {
      submittedIntentRef.current = intent;
      if (overrideText !== undefined) return;
      params.setComposerDrafts((current) =>
        consumePersistedDraft(current, sourceDraftKey, sourceDraft),
      );
      params.setReplyDrafts((current) =>
        consumeReplyDraft(current, sourceDraftKey, sourceReply),
      );
      for (const item of readyDraftAttachments) {
        params.removeAttachment(sourceDraftKey, item.localId);
      }
    };

    try {
      const targetTicket = params.projectedTicketId
        ? (params.ticketById.get(params.projectedTicketId) ??
          (params.inspectedTicket?.ticket.id === params.projectedTicketId
            ? params.inspectedTicket.ticket
            : undefined))
        : undefined;
      const targetTopic =
        params.projectedTicketId && overrideText === undefined
          ? (targetTicket?.originTopicId ?? "root")
          : params.topicDrafts.isLocal(params.activeTopicId)
            ? (await params.topicDrafts.ensure(params.activeTopicId)).id
            : params.activeTopicId;

      if (params.projectedTicketId && overrideText === undefined) {
        const card = targetTicket;
        if (card?.status === "stopped" || card?.status === "closed") {
          const composed = `[关于任务「${card.title}」]${raw ? `\n${raw}` : ""}`;
          const reqId = newDeliveryId("web");
          await dispatchSubmissionWithAck({
            topicId: targetTopic,
            draftKey: composerDraftKey(targetTopic),
            envelope: {
              type: "chat.send",
              topicId: targetTopic,
              content: composed,
              ...(replyTo ? { replyTo } : {}),
              ...(attachmentsToSend.length > 0
                ? { attachments: attachmentsToSend }
                : {}),
              requestId: reqId,
              whenBusy: "steer",
            },
            rawUserText: composed,
            draftAttachments: readyDraftAttachments,
            state: "sending",
          });
          consumeDraft();
          if (params.projectedTicketRef.current === params.projectedTicketId) {
            params.closeProjection();
            if (targetTopic !== params.activeTopicId) {
              params.selectTopic(targetTopic);
            }
          }
          return;
        }

        const cmdId = newDeliveryId("steer");
        await dispatchSubmissionWithAck({
          topicId: targetTopic,
          draftKey: params.currentConversationDraftKey,
          envelope: {
            type: "ticket.steer",
            ticketId: params.projectedTicketId,
            text: raw,
            ...(replyTo ? { replyTo } : {}),
            ...(attachmentsToSend.length > 0
              ? { attachments: attachmentsToSend }
              : {}),
            commandId: cmdId,
          },
          rawUserText: raw,
          draftAttachments: readyDraftAttachments,
          state: "sending",
        });
        consumeDraft();
        return;
      }

      const reqId = newDeliveryId("web");
      const messageTargetDeviceId =
        !params.activeTopic?.projectId &&
        (params.selectedTargetDeviceId !== "" ||
          params.persistedTargetDeviceId !== "")
          ? params.selectedTargetDeviceId
          : undefined;
      await dispatchSubmissionWithAck({
        topicId: targetTopic,
        draftKey: composerDraftKey(targetTopic),
        envelope: {
          type: "chat.send",
          topicId: targetTopic,
          content: raw,
          ...(replyTo ? { replyTo } : {}),
          ...(attachmentsToSend.length > 0
            ? { attachments: attachmentsToSend }
            : {}),
          ...(messageTargetDeviceId !== undefined
            ? { targetDeviceId: messageTargetDeviceId }
            : {}),
          requestId: reqId,
          whenBusy: "steer",
        },
        rawUserText: raw,
        draftAttachments: readyDraftAttachments,
        state: "sending",
      });
      if (
        targetTopic !== params.activeTopicId &&
        Object.hasOwn(params.topicTargetOverrides, params.activeTopicId)
      ) {
        params.setTopicTargetOverrides((current) => {
          const next = { ...current };
          delete next[params.activeTopicId];
          if (params.selectedTargetDeviceId) {
            next[targetTopic] = params.selectedTargetDeviceId;
          }
          return next;
        });
      }
      consumeDraft();
    } catch (error) {
      params.setActionError(
        error instanceof Error
          ? error.message
          : t(
              "无法保存待发消息，草稿已保留",
              "Could not save the pending message. Your draft is saved.",
            ),
      );
    } finally {
      requestAnimationFrame(() => {
        submitFlightRef.current = false;
      });
    }
  };

  const transcribeVoice: TranscribeVoice = async (recording, options) => {
    if (!params.connected) {
      throw new KuloWsDisconnectedError(
        t(
          "当前与中枢连接已断开，录音已保留",
          "Disconnected from the hub. Your recording is saved.",
        ),
      );
    }
    const ticket = params.projectedTicketId
      ? (params.ticketById.get(params.projectedTicketId) ??
        (params.inspectedTicket?.ticket.id === params.projectedTicketId
          ? params.inspectedTicket.ticket
          : undefined))
      : undefined;
    return transcribeVoiceRecording(
      recording,
      {
        topicId: params.projectedTicketId
          ? (ticket?.originTopicId ?? "root")
          : params.topicDrafts.isLocal(params.activeTopicId)
            ? undefined
            : params.activeTopicId,
        clientId: params.clientId,
      },
      options,
    );
  };

  return {
    resumingQueuedTopic,
    dispatchSubmissionWithAck,
    resumeQueuedMessages,
    submitMessage,
    transcribeVoice,
  };
}
