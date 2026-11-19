import { useI18n } from "../../moco-i18n";
import { useEffect, useRef, useState, type Ref } from "react";
import { Button } from "@heroui/react";
import type { LiveStreamState, TicketCardView } from "@moco/protocol";
import { CatAvatar } from "../../components/cat-avatar";
import { CatPicker } from "../../components/cat-picker";
import { useCatPreferences } from "../../components/cat-preferences";
import { useVoiceWorkspace } from "../voice/voice-context";
import { VoiceCallPanel } from "../voice/voice-call-panel";
import type { AgentProfileActivity } from "./agent-profile-state";
import { useAgentCompanion } from "./use-agent-companion";
import type { AgentTerminalEntry } from "./agent-terminal-state";
import "./agent-terminal.css";

export function AgentProfileCard({ agentName, connected, activity, selected = false, onOpenChat, buttonRef, attentionTarget }: {
  agentName: string;
  connected: boolean;
  activity: AgentProfileActivity;
  selected?: boolean;
  onOpenChat: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  attentionTarget?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const { appearance, animated } = useCatPreferences();
  const [reactionKey, setReactionKey] = useState(0);
  return <div className="moco-agent-profile-header">
    <CatPicker>
      <CatAvatar state={activity.state} appearance={appearance} animated={animated} className="moco-agent-profile-avatar" attentionTarget={attentionTarget} reactionKey={reactionKey} />
    </CatPicker>
    <Button ref={buttonRef} variant="ghost" className="moco-agent-profile-overview"
    aria-label={t(`${agentName} 主会话`, `${agentName} main chat`)} aria-current={selected ? "page" : undefined} onPress={() => { setReactionKey((value) => value + 1); onOpenChat(); }}>
      <span className="moco-agent-profile-identity">
        <span className="moco-agent-profile-title-row">
          <strong className="moco-agent-profile-name" title={agentName}>{agentName}</strong>
          <span className="moco-agent-profile-presence" role="status" aria-label={t("连接状态", "Connection status")} aria-atomic="true">
            <i data-connected={connected} aria-hidden="true" />{connected ? t("在线", "Online") : t("重连中", "Reconnecting")}
          </span>
        </span>
        <span className="moco-agent-profile-chat-label">{t("主会话", "Main chat")}</span>
      </span>
    </Button>
  </div>;
}

export function AgentTerminal({ agentName, connected, entries, live, tickets = [], activityScope = "root", mainChatSelected = false, onAgentClick, onOpenCallTopic, onCallClosed }: {
  agentName: string;
  connected: boolean;
  entries: readonly AgentTerminalEntry[];
  live?: LiveStreamState;
  tickets?: readonly TicketCardView[];
  activityScope?: string;
  mainChatSelected?: boolean;
  onAgentClick: () => void;
  onOpenCallTopic: (topicId: string) => void;
  onCallClosed?: () => void;
}) {
  const { t } = useI18n();
  const voice = useVoiceWorkspace();
  const call = voice?.call.call ?? null;
  const mainChatRef = useRef<HTMLButtonElement>(null);
  const previousCall = useRef(Boolean(call));
  useEffect(() => {
    if (previousCall.current && !call) mainChatRef.current?.focus({ preventScroll: true });
    previousCall.current = Boolean(call);
  }, [Boolean(call)]);
  const { activity, attentionTarget } = useAgentCompanion({ scope: activityScope, connected, entries, live, tickets, voice });
  const callDisabled = !connected || Boolean(voice?.loading) || Boolean(voice?.recordingActive);

  return <section className="moco-agent-profile" data-calling={Boolean(call)} aria-label={t(`${agentName} 主会话与通话`, `${agentName} main chat and call`)}>
    <AgentProfileCard buttonRef={mainChatRef} agentName={agentName} connected={connected} activity={activity} attentionTarget={attentionTarget}
      selected={mainChatSelected} onOpenChat={onAgentClick} />
    {call && voice && <VoiceCallPanel call={call} agentName={agentName}
      onHangup={() => { voice.call.hangup(); onCallClosed?.(); }} onToggleMute={voice.call.toggleMute}
      retryDisabled={callDisabled} onRetry={() => { if (!callDisabled) void voice.call.start(call.target); }} onOpenChat={() => onOpenCallTopic(call.target.topicId)} />}
  </section>;
}
