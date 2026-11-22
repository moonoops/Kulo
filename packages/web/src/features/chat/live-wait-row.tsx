import { useEffect, useState } from "react";
import type { LiveStreamState } from "@kulo/protocol";
import { KuloThinkingIndicator } from "./thinking-indicator";
import { resolveLiveWaitStatus } from "./live-status";

export function KuloLiveWaitRow({
  live,
  topicKey,
  showProcess,
}: {
  live: LiveStreamState;
  topicKey: string;
  showProcess: boolean;
}) {
  const waitingForFirstByte = Boolean(
    live.busy &&
    !live.streamingText &&
    !live.retrying &&
    live.activeTools.length === 0 &&
    !live.streamingThinking?.trim(),
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!waitingForFirstByte) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [waitingForFirstByte, topicKey]);

  const status = resolveLiveWaitStatus(live, { elapsedSeconds, showProcess });

  return (
    <div className="flex items-center gap-2.5 py-2 text-xs text-muted">
      <KuloThinkingIndicator decorative={Boolean(status.label)} />
      {status.label && (
        <span className="inline-flex min-w-0 items-baseline truncate">
          <span role="status" aria-live="polite" className="truncate">
            {status.label}
          </span>
          {status.elapsedSuffix && (
            <span aria-hidden="true" className="shrink-0 tabular-nums">
              {status.elapsedSuffix}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
