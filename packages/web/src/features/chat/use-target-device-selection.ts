import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TopicSummary } from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";
import type { PendingSubmissionBackup, SubmissionBackupInput } from "./chat-submissions";
import { newDeliveryId } from "./reliable-intents";

export function resolveFailedChatRetryEnvelope(input: {
  backup: PendingSubmissionBackup;
  activeTopicId: string;
  isProjectTopic: boolean;
  selectedTargetDeviceId: string;
  persistedTargetDeviceId: string;
  createRequestId?: () => string;
}): Extract<SubmissionBackupInput["envelope"], { type: "chat.send" }> | null {
  if (
    input.backup.state !== "failed" ||
    input.backup.envelope.type !== "chat.send" ||
    input.backup.topicId !== input.activeTopicId ||
    input.isProjectTopic ||
    input.backup.localSequence === undefined ||
    !input.backup.outboxScope
  ) {
    return null;
  }
  const desiredTarget =
    input.selectedTargetDeviceId !== "" || input.persistedTargetDeviceId !== ""
      ? input.selectedTargetDeviceId
      : undefined;
  const previousTarget = input.backup.envelope.targetDeviceId ?? "";
  if (previousTarget === (desiredTarget ?? "")) {
    return null;
  }
  const { targetDeviceId: _previous, ...rest } = input.backup.envelope;
  return {
    ...rest,
    requestId: (input.createRequestId ?? (() => newDeliveryId("web")))(),
    ...(desiredTarget !== undefined ? { targetDeviceId: desiredTarget } : {}),
  };
}

export function useTargetDeviceSelection(params: {
  activeTopicId: string;
  activeTopic?: TopicSummary;
  topics: TopicSummary[];
  setTopics: Dispatch<SetStateAction<TopicSummary[]>>;
  isLocalTopic: (topicId: string) => boolean;
  patchTopicTarget: (topicId: string, targetDeviceId: string) => Promise<TopicSummary>;
  onError: (message: string) => void;
}) {
  const {
    activeTopicId,
    activeTopic,
    topics,
    setTopics,
    isLocalTopic,
    patchTopicTarget,
    onError,
  } = params;
  const [topicTargetOverrides, setTopicTargetOverrides] = useState<Record<string, string>>({});
  const [savingTopics, setSavingTopics] = useState<Record<string, boolean>>({});
  const pendingSavesRef = useRef<Map<string, Promise<void>>>(new Map());
  const requestSeqRef = useRef<Map<string, number>>(new Map());

  const persistedTargetDeviceId = activeTopic?.projectId ? "" : (activeTopic?.targetDeviceId ?? "");
  const selectedTargetDeviceId = activeTopic?.projectId
    ? ""
    : Object.hasOwn(topicTargetOverrides, activeTopicId)
      ? topicTargetOverrides[activeTopicId]!
      : persistedTargetDeviceId;
  const savingTargetDevice = Boolean(savingTopics[activeTopicId]);

  useEffect(() => {
    setTopicTargetOverrides((current) => {
      const entries = Object.entries(current);
      if (!entries.length) return current;
      let changed = false;
      const next: Record<string, string> = {};
      for (const [topicId, value] of entries) {
        const topic = topics.find((item) => item.id === topicId);
        if (topic && (topic.targetDeviceId ?? "") === value) {
          changed = true;
          continue;
        }
        next[topicId] = value;
      }
      return changed ? next : current;
    });
  }, [topics]);

  const selectTargetDevice = useCallback((deviceId: string) => {
    if (activeTopic?.projectId) return;
    const topicId = activeTopicId;
    const nextValue = deviceId.trim();
    if (isLocalTopic(topicId)) {
      setTopicTargetOverrides((current) => ({ ...current, [topicId]: nextValue }));
      return;
    }
    if (nextValue === selectedTargetDeviceId && nextValue === persistedTargetDeviceId) return;

    const seq = (requestSeqRef.current.get(topicId) ?? 0) + 1;
    requestSeqRef.current.set(topicId, seq);
    setTopicTargetOverrides((current) => ({ ...current, [topicId]: nextValue }));
    setSavingTopics((current) => ({ ...current, [topicId]: true }));

    let task: Promise<void>;
    task = patchTopicTarget(topicId, nextValue)
      .then((updated) => {
        setTopics((current) => current.map((item) => (item.id === topicId ? updated : item)));
        if (requestSeqRef.current.get(topicId) === seq) {
          setTopicTargetOverrides((current) => {
            if (!Object.hasOwn(current, topicId)) return current;
            const next = { ...current };
            delete next[topicId];
            return next;
          });
        }
      })
      .catch((error: unknown) => {
        if (requestSeqRef.current.get(topicId) === seq) {
          setTopicTargetOverrides((current) => {
            if (!Object.hasOwn(current, topicId)) return current;
            const next = { ...current };
            delete next[topicId];
            return next;
          });
        }
        onError(error instanceof Error ? error.message : t("切换执行设备失败", "Could not switch target device"));
      })
      .finally(() => {
        if (pendingSavesRef.current.get(topicId) === task) {
          pendingSavesRef.current.delete(topicId);
        }
        if (requestSeqRef.current.get(topicId) === seq) {
          setSavingTopics((current) => {
            if (!current[topicId]) return current;
            const next = { ...current };
            delete next[topicId];
            return next;
          });
        }
      });

    pendingSavesRef.current.set(topicId, task);
  }, [
    activeTopic?.projectId,
    activeTopicId,
    isLocalTopic,
    onError,
    patchTopicTarget,
    persistedTargetDeviceId,
    selectedTargetDeviceId,
    setTopics,
  ]);

  const waitForPendingTargetDevice = useCallback(async (topicId: string) => {
    const pending = pendingSavesRef.current.get(topicId);
    if (pending) await pending;
  }, []);

  return {
    persistedTargetDeviceId,
    selectedTargetDeviceId,
    savingTargetDevice,
    topicTargetOverrides,
    setTopicTargetOverrides,
    selectTargetDevice,
    waitForPendingTargetDevice,
  };
}
