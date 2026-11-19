import { translate as tr, useI18n } from "../../moco-i18n";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Button, Tooltip } from "@heroui/react";
import { MocoIcon } from "../../moco-icon";
import { VoiceIcon } from "./voice-icons";
import { CallStatusIcon } from "./call-status-icon";
import type { ActiveVoiceCall } from "./use-voice-call";
import { requestSystemPermissionHelp } from "../system-permissions/system-permissions";
import "./voice.css";

export function voiceCallStatus(call: Pick<ActiveVoiceCall, "state" | "muted">): string {
  if (call.state === "ended") return tr("通话已结束", "Call ended");
  if (call.state === "connecting") return tr("正在连接", "Connecting");
  if (call.state === "reconnecting") return tr("正在重连", "Reconnecting");
  if (call.muted) return tr("麦克风已静音", "Microphone muted");
  return tr("通话中", "In call");
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function CallButton({ label, onPress, children, variant = "secondary", pressed, disabled, buttonRef, className = "" }: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  variant?: "secondary" | "primary" | "danger";
  pressed?: boolean;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
}) {
  return <Tooltip delay={350}>
    <Button ref={buttonRef} isIconOnly isDisabled={disabled} variant={variant} className={`moco-voice-call-circle ${className}`} aria-label={label} aria-pressed={pressed} onPress={onPress}>
      {children}
    </Button>
    <Tooltip.Content>{label}</Tooltip.Content>
  </Tooltip>;
}

export function VoiceCallPanel({ call, agentName = "Moco", onHangup, onToggleMute, onRetry, onOpenChat, retryDisabled = false }: {
  call: ActiveVoiceCall | null;
  agentName?: string;
  onHangup: () => void;
  onToggleMute: () => void;
  onRetry: () => void;
  onOpenChat?: () => void;
  retryDisabled?: boolean;
}) {
  useI18n();
  const [now, setNow] = useState(Date.now);
  const muteButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const ended = call?.state === "ended";
  useEffect(() => {
    if (call?.startedAt === undefined || ended) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call?.startedAt, ended]);
  useEffect(() => {
    if (!call) return;
    const frame = requestAnimationFrame(() => {
      (ended ? closeButtonRef.current : muteButtonRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [Boolean(call), ended]);
  if (!call) return null;
  const elapsed = elapsedLabel(call.startedAt === undefined ? 0 : now - call.startedAt);
  const muteLabel = call.muted ? tr("取消静音", "Unmute") : tr("静音麦克风", "Mute microphone");
  const status = ended || call.state === "connecting" || call.state === "reconnecting" ? voiceCallStatus(call) : null;
  const topic = <><CallStatusIcon state={call.state} muted={call.muted} size={16} /><span className="moco-voice-call-topic-title" title={call.target.title}>{call.target.title}</span></>;

  return <section className="moco-voice-call" role="region" aria-label={tr(`与${agentName}的通话`, `Call with ${agentName}`)}>
    <div className="moco-voice-call-heading">
      {onOpenChat
        ? <Button variant="ghost" className="moco-voice-call-topic" aria-label={tr(`返回通话话题：${call.target.title}`, `Return to call topic: ${call.target.title}`)} onPress={onOpenChat}>{topic}</Button>
        : <span className="moco-voice-call-topic" title={call.target.title}>{topic}</span>}
      <span className="moco-voice-call-duration" role="timer" aria-label={tr("通话时长", "Call duration")} aria-live="off">{elapsed}</span>
    </div>
    {status && <p className="moco-voice-call-status" role="status" aria-atomic="true">{status}</p>}
    {call.error && <p className="moco-voice-call-error" role="alert">{call.error}</p>}
    {ended ? <div className="moco-voice-call-controls" role="group" aria-label={tr("通话恢复", "Call recovery")}>
      {call.permissionRequired && <CallButton label={tr("检查麦克风权限", "Check microphone permissions")} onPress={() => requestSystemPermissionHelp({ kind: "microphone" })}><MocoIcon name="key" /></CallButton>}
      <CallButton label={tr("重新通话", "Call again")} variant="primary" disabled={retryDisabled} onPress={onRetry}><MocoIcon name="refresh" /></CallButton>
      <CallButton buttonRef={closeButtonRef} label={tr("关闭通话", "Close call")} onPress={onHangup}><MocoIcon name="close" /></CallButton>
    </div> : <div className="moco-voice-call-controls" role="group" aria-label={tr("通话控制", "Call controls")}>
      <CallButton buttonRef={muteButtonRef} className="moco-voice-call-mute" label={muteLabel} pressed={call.muted} onPress={onToggleMute}><VoiceIcon name={call.muted ? "muted" : "microphone"} size={22} /></CallButton>
      <CallButton label={tr("挂断通话", "Hang up")} variant="danger" onPress={onHangup}><VoiceIcon name="hangup" size={22} /></CallButton>
    </div>}
  </section>;
}
