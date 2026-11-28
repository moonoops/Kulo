import { useEffect, useRef, useState } from "react";
import { Button, Chip, Disclosure, Spinner } from "@heroui/react";
import type { VoiceCallSummaryView, VoiceCallTranscriptTurn } from "@kulo/protocol";
import { translate as tr, useI18n } from "../../kulo-i18n";
import { VoiceIcon } from "../voice/voice-icons";
import { voiceApi } from "../voice/voice-api";
import "./voice-call-summary-card.css";

export function formatVoiceCallSummaryDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round((Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0) / 1000));
  if (totalSeconds < 60) return tr(`${totalSeconds}秒`, `${totalSeconds}s`);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0
      ? tr(`${hours}小时${minutes}分`, `${hours}h ${minutes}m`)
      : tr(`${hours}小时`, `${hours}h`);
  }
  return seconds > 0
    ? tr(`${minutes}分${seconds}秒`, `${minutes}m ${seconds}s`)
    : tr(`${minutes}分`, `${minutes}m`);
}

export function formatVoiceCallSummaryHeadline(
  summary: Pick<VoiceCallSummaryView, "durationMs" | "turnCount" | "delegatedTicketIds">,
): string {
  const turns = Math.max(0, Math.floor(summary.turnCount));
  const parts = [
    tr("语音通话", "Voice call"),
    formatVoiceCallSummaryDuration(summary.durationMs),
    tr(`${turns} 句交流`, turns === 1 ? "1 turn" : `${turns} turns`),
  ];
  const ticketCount = summary.delegatedTicketIds.length;
  if (ticketCount > 0) {
    parts.push(tr(`${ticketCount} 项任务`, ticketCount === 1 ? "1 task" : `${ticketCount} tasks`));
  }
  return parts.join(" · ");
}

export interface VoiceCallSummaryCardProps {
  summary: VoiceCallSummaryView;
  topicId: string;
  agentName?: string;
  defaultExpanded?: boolean;
  loadTranscript?: (
    callId: string,
    topicId: string,
    signal?: AbortSignal,
  ) => Promise<{ callId: string; turns: VoiceCallTranscriptTurn[] }>;
}

export function VoiceCallSummaryCard({
  summary,
  topicId,
  agentName = "Kulo",
  defaultExpanded = false,
  loadTranscript = voiceApi.getCallTranscript,
}: VoiceCallSummaryCardProps) {
  useI18n();
  const hasCompleteInlineTurns = Boolean(
    summary.turns && summary.turns.length > 0 && summary.turns.length >= summary.turnCount,
  );
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [loadedTurns, setLoadedTurns] = useState<VoiceCallTranscriptTurn[] | undefined>(
    hasCompleteInlineTurns ? summary.turns : undefined,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLoadedTurns(hasCompleteInlineTurns ? summary.turns : undefined);
    setError(undefined);
    setLoading(false);
  }, [summary.callId, topicId, hasCompleteInlineTurns, summary.turns]);

  useEffect(() => {
    if (!expanded || hasCompleteInlineTurns || loadedTurns !== undefined || !summary.callId) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setLoading(true);
    setError(undefined);
    void loadTranscript(summary.callId, topicId, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setLoadedTurns(res.turns);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(tr("无法加载通话记录", "Unable to load call transcript"));
        }
      })
      .finally(() => {
        if (controllerRef.current === controller) controllerRef.current = null;
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [expanded, hasCompleteInlineTurns, loadedTurns, summary.callId, topicId, attempt, loadTranscript]);

  const turns = loadedTurns ?? summary.turns;
  const headline = formatVoiceCallSummaryHeadline(summary);

  return (
    <Disclosure
      className="kulo-voice-summary-card"
      data-voice-call-id={summary.callId}
      isExpanded={expanded}
      onExpandedChange={setExpanded}
    >
      <Disclosure.Heading>
        <Disclosure.Trigger className="kulo-voice-summary-trigger">
          <span className="kulo-voice-summary-heading">
            <VoiceIcon name="phone" size={14} />
            <span className="kulo-voice-summary-label">{headline}</span>
          </span>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="kulo-voice-summary-body">
          {loading && !turns?.length ? (
            <div className="kulo-voice-summary-status" role="status">
              <Spinner size="sm" />
              <span>{tr("加载通话记录", "Loading transcript")}</span>
            </div>
          ) : error && !turns?.length ? (
            <div className="kulo-voice-summary-status" role="alert">
              <span>{error}</span>
              <Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
                {tr("重试", "Retry")}
              </Button>
            </div>
          ) : turns && turns.length > 0 ? (
            <div className="kulo-voice-summary-turns scrollbar">
              {turns.map((turn, index) => (
                <div key={turn.id ?? `${turn.role}-${index}`} className="kulo-voice-summary-turn" data-role={turn.role}>
                  <div className="kulo-voice-summary-turn-meta">
                    <span>{turn.role === "user" ? tr("我", "You") : agentName}</span>
                    {turn.incomplete ? (
                      <Chip size="sm" variant="soft">
                        {tr("未说完", "Incomplete")}
                      </Chip>
                    ) : null}
                  </div>
                  <p className="kulo-voice-summary-turn-text">{turn.text}</p>
                </div>
              ))}
            </div>
          ) : null}
          {summary.delegatedTicketIds.length > 0 ? (
            <div className="kulo-voice-summary-tickets">
              {summary.delegatedTicketIds.map((ticketId) => (
                <Chip key={ticketId} size="sm" variant="soft" className="font-mono">
                  {ticketId}
                </Chip>
              ))}
            </div>
          ) : null}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
