import { Badge, Spinner } from "@heroui/react";
import type { VoiceCallState } from "@kulo/protocol";
import { KuloIcon } from "../../kulo-icon";
import "./call-status-icon.css";

export function CallStatusIcon({ state = "idle", muted = false, size = 20 }: {
  state?: VoiceCallState | "idle";
  muted?: boolean;
  size?: 16 | 20;
}) {
  const connecting = state === "connecting" || state === "reconnecting";
  const active = state !== "idle" && state !== "ended" && !connecting;
  return <span className={`kulo-call-status-icon${size === 16 ? " kulo-call-status-icon--compact" : ""}`} data-call-state={state} aria-hidden="true">
    {connecting ? <Spinner size="sm" color="current" /> : <Badge.Anchor className="kulo-call-status-anchor">
      <KuloIcon name={state === "idle" ? "waveform" : "phone"} size={size} />
      {active && <Badge className="kulo-call-status-dot" size="sm" color={muted ? "warning" : "success"} />}
    </Badge.Anchor>}
  </span>;
}
