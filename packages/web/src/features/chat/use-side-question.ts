import { useCallback, useEffect, useRef, useState } from "react";
import type { SideQuestionView } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { translate as t } from "../../kulo-i18n";
import type { TopicDraftStore } from "../topics/topic-drafts";
import { newDeliveryId } from "./reliable-intents";

const POLL_INTERVAL_MS = 320;
const MAX_IDLE_WAIT_POLLS = 90;

export interface SideQuestionSelectionInput {
  quoteSnippet: string;
  sourceMessageId?: number;
}

export interface UseSideQuestionParams {
  activeTopicId: string;
  activeTopicConvId?: number;
  deliveryScope?: string;
  connected: boolean;
  topicDrafts: Pick<TopicDraftStore, "isLocal" | "ensure">;
}

export function isSideQuestionAwaitingReply(view: SideQuestionView | null): boolean {
  if (!view || view.record.status !== "active") return false;
  if (view.live.busy || view.live.queuedCount > 0) return true;
  if (view.live.runFailure) return false;
  const last = view.messages[view.messages.length - 1];
  return last?.role === "user";
}

export function useSideQuestion(params: UseSideQuestionParams) {
  const [open, setOpen] = useState(false);
  const [sideQuestion, setSideQuestion] = useState<SideQuestionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeKey = `${params.deliveryScope ?? ""}:${params.activeTopicId}:${params.activeTopicConvId ?? ""}`;
  const generationRef = useRef(0);
  const idleWaitPollsRef = useRef(0);
  const sideQuestionRef = useRef<SideQuestionView | null>(null);
  sideQuestionRef.current = sideQuestion;

  useEffect(() => {
    generationRef.current += 1;
    idleWaitPollsRef.current = 0;
    setOpen(false);
    setSideQuestion(null);
    setLoading(false);
    setSubmitting(false);
    setError(null);
  }, [scopeKey]);

  const resolveTopicId = useCallback(async () => {
    if (params.topicDrafts.isLocal(params.activeTopicId)) {
      const created = await params.topicDrafts.ensure(params.activeTopicId, { draft: true });
      return created.id;
    }
    return params.activeTopicId;
  }, [params.activeTopicId, params.topicDrafts]);

  const openFromBtw = useCallback(async (question: string): Promise<boolean> => {
    const gen = ++generationRef.current;
    idleWaitPollsRef.current = 0;
    setOpen(true);
    setError(null);
    setLoading(true);
    setSideQuestion(null);
    try {
      const topicId = await resolveTopicId();
      if (generationRef.current !== gen) return true;
      const view = await kuloRest.createSideQuestion(topicId, {
        ...(question.trim() ? { question: question.trim() } : {}),
        ...(params.activeTopicConvId !== undefined ? { expectedParentConversationId: params.activeTopicConvId } : {}),
        requestId: newDeliveryId("sideq"),
      });
      if (generationRef.current !== gen) return true;
      setSideQuestion(view);
      return true;
    } catch (err) {
      if (generationRef.current === gen) {
        setError(err instanceof Error ? err.message : t("开启支线提问失败", "Could not start the side question"));
      }
      return true;
    } finally {
      if (generationRef.current === gen) {
        setLoading(false);
      }
    }
  }, [params.activeTopicConvId, resolveTopicId]);

  const openFromSelection = useCallback((input: SideQuestionSelectionInput) => {
    const snippet = input.quoteSnippet.trim();
    if (!snippet) return;
    const gen = ++generationRef.current;
    idleWaitPollsRef.current = 0;
    setOpen(true);
    setError(null);
    setLoading(true);
    setSideQuestion(null);
    void (async () => {
      try {
        const topicId = await resolveTopicId();
        if (generationRef.current !== gen) return;
        const view = await kuloRest.createSideQuestion(topicId, {
          quoteSnippet: snippet,
          ...(input.sourceMessageId !== undefined && input.sourceMessageId > 0
            ? { sourceMessageId: input.sourceMessageId }
            : {}),
          ...(params.activeTopicConvId !== undefined ? { expectedParentConversationId: params.activeTopicConvId } : {}),
        });
        if (generationRef.current !== gen) return;
        setSideQuestion(view);
      } catch (err) {
        if (generationRef.current === gen) {
          setError(err instanceof Error ? err.message : t("开启支线提问失败", "Could not start the side question"));
        }
      } finally {
        if (generationRef.current === gen) {
          setLoading(false);
        }
      }
    })();
  }, [params.activeTopicConvId, resolveTopicId]);

  const sendMessage = useCallback(async (questionRaw: string): Promise<boolean> => {
    const question = questionRaw.trim();
    const current = sideQuestionRef.current;
    if (!question || !current) return false;
    const gen = generationRef.current;
    idleWaitPollsRef.current = 0;
    setSubmitting(true);
    setError(null);
    try {
      const next = await kuloRest.sendSideQuestionMessage(current.record.id, {
        question,
        requestId: newDeliveryId("sideq"),
      });
      if (generationRef.current !== gen) return false;
      setSideQuestion(next);
      return true;
    } catch (err) {
      if (generationRef.current === gen) {
        setError(err instanceof Error ? err.message : t("发送支线追问失败", "Could not send the side question"));
      }
      return false;
    } finally {
      if (generationRef.current === gen) {
        setSubmitting(false);
      }
    }
  }, []);

  const hideDrawer = useCallback(() => {
    setOpen(false);
  }, []);

  const closeAndDiscard = useCallback(async () => {
    const current = sideQuestionRef.current;
    generationRef.current += 1;
    idleWaitPollsRef.current = 0;
    setOpen(false);
    setSideQuestion(null);
    setLoading(false);
    setSubmitting(false);
    setError(null);
    if (current) {
      await kuloRest.closeSideQuestion(current.record.id).catch(() => {});
    }
  }, []);

  const awaitingReply = isSideQuestionAwaitingReply(sideQuestion);
  const pollTopicId = sideQuestion?.record.parentTopicId;
  const pollSideId = sideQuestion?.record.id;

  useEffect(() => {
    if (!open || !params.connected || !awaitingReply || !pollTopicId || !pollSideId) return;
    let alive = true;
    let controller: AbortController | null = null;
    const gen = generationRef.current;

    const timer = window.setInterval(() => {
      if (!alive || generationRef.current !== gen) return;
      const latest = sideQuestionRef.current;
      if (!latest || latest.record.id !== pollSideId) return;
      if (!latest.live.busy && latest.live.queuedCount === 0) {
        idleWaitPollsRef.current += 1;
        if (idleWaitPollsRef.current > MAX_IDLE_WAIT_POLLS) return;
      } else {
        idleWaitPollsRef.current = 0;
      }
      controller?.abort();
      controller = new AbortController();
      void kuloRest
        .getActiveSideQuestion(pollTopicId, controller.signal)
        .then((next) => {
          if (!alive || generationRef.current !== gen) return;
          if (!next || next.record.id !== pollSideId) {
            setSideQuestion(null);
            setOpen(false);
            return;
          }
          setSideQuestion(next);
        })
        .catch(() => {
          // Ignore transient poll cancellations or disconnects.
        });
    }, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [open, params.connected, awaitingReply, pollTopicId, pollSideId]);

  return {
    open,
    sideQuestion,
    loading,
    submitting,
    error,
    awaitingReply,
    openFromBtw,
    openFromSelection,
    sendMessage,
    hideDrawer,
    closeAndDiscard,
  };
}
