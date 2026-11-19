import { Badge, Spinner } from "@heroui/react";
import type { VoiceCallState } from "@moco/protocol";
import { MocoIcon } from "../../moco-icon";
import "./call-status-icon.css";

export function CallStatusIcon({ state = "idle", muted = false, size = 20 }: {
  state?: VoiceCallState | "idle";
  muted?: boolean;
  size?: 16 | 20;
}) {
  const connecting = state === "connecting" || state === "reconnecting";
  const active = state !== "idle" && state !== "ended" && !connecting;
  return <span className={`moco-call-status-icon${size === 16 ? " moco-call-status-icon--compact" : ""}`} data-call-state={state} aria-hidden="true">
    {connecting ? <Spinner size="sm" color="current" /> : <Badge.Anchor className="moco-call-status-anchor">
      <MocoIcon name={state === "idle" ? "waveform" : "phone"} size={size} />
      {active && <Badge className="moco-call-status-dot" size="sm" color={muted ? "warning" : "success"} />}
    </Badge.Anchor>}
  </span>;
}
