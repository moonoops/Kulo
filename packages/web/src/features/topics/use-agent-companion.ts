import { useEffect, useRef, useState } from "react";
import type { LiveStreamState, TicketCardView } from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";
import { CAT_SUCCESS_MS } from "../../components/cat-motion";
import { useComposerAttention } from "../../components/use-composer-attention";
import type { VoiceWorkspace } from "../voice/voice-context";
import { agentProfileActivity, type AgentProfileActivity } from "./agent-profile-state";
import { CompanionCompletionTracker } from "./agent-companion-completions";
import type { AgentTerminalEntry } from "./agent-terminal-state";

export function useAgentCompanion({ scope, connected, live, tickets, entries, voice }: {
  scope: string;
  connected: boolean;
  live?: LiveStreamState;
  tickets: readonly TicketCardView[];
  entries: readonly AgentTerminalEntry[];
  voice: VoiceWorkspace | null;
}): { activity: AgentProfileActivity; attentionTarget: HTMLTextAreaElement | null } {
  const attentionTarget = useComposerAttention();
  const [replyActive, setReplyActive] = useState(Boolean(live?.busy && live.streamingText));
  const [completion, setCompletion] = useState<string>();
  const tracker = useRef<CompanionCompletionTracker | null>(null);
  if (!tracker.current) tracker.current = new CompanionCompletionTracker({ scope, connected, live, tickets, entries });

  useEffect(() => {
    if (!live?.busy || !live.streamingText) { setReplyActive(false); return; }
    setReplyActive(true);
    // streamingText is accumulated text; a stalled stream must stop the reply gesture.
    const timer = setTimeout(() => setReplyActive(false), 1400);
    return () => clearTimeout(timer);
  }, [scope, live?.busy, live?.responseId, live?.streamingText]);

  useEffect(() => {
    const result = tracker.current!.observe({ scope, connected, live, tickets, entries });
    const occupied = live?.busy || voice?.recordingActive || voice?.call.call && voice.call.call.state !== "ended";
    if (result.reset || occupied) setCompletion(undefined);
    else if (result.eventId && agentProfileActivity({ connected, live, tickets, entries, replyActive }).state === "success") setCompletion(result.eventId);
  }, [scope, connected, live, tickets, entries, replyActive, voice?.recordingActive, voice?.call.call]);
  useEffect(() => {
    if (!completion) return;
    const timer = setTimeout(() => setCompletion(undefined), CAT_SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [completion]);

  let activity = agentProfileActivity({ connected, live, tickets, entries, replyActive });
  let composerAttention: HTMLTextAreaElement | null = null;
  if (activity.state === "success" && !completion) activity = { state: "idle", label: t("等待任务", "Waiting for a task") };
  if (connected) {
    const call = voice?.call.call;
    if (call && call.state !== "ended") {
      activity = call.state === "speaking" ? { state: "speaking", label: t("正在说话", "Speaking") }
        : call.state === "listening" ? { state: call.muted ? "idle" : "listening", label: t("正在聆听", "Listening") }
          : call.state === "working" ? { state: "thinking", label: t("正在思考", "Thinking") }
            : { state: "idle", label: t("连接中…", "Connecting…") };
    } else if (call?.error) activity = { state: "error", label: t("通话中断", "Call interrupted"), tone: "danger" };
    else if (voice?.recordingActive) activity = { state: "listening", label: t("正在聆听", "Listening") };
    else if (voice?.speech?.phase === "playing") activity = { state: "speaking", label: t("正在朗读", "Reading aloud") };
    else if (attentionTarget && activity.state === "idle") {
      activity = { state: "listening", label: t("正在聆听", "Listening") };
      composerAttention = attentionTarget;
    }
  }
  return { activity, attentionTarget: composerAttention };
}
