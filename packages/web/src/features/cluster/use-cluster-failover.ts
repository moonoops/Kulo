import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClusterClientSummary,
  ClusterFailoverCandidate,
  ClusterLocalStatusView,
} from "@kulo/protocol";
import { toast } from "@heroui/react";
import { translate as t } from "../../kulo-i18n";
import { KuloApiError } from "../../kulo-api";
import { deviceApi } from "../settings/device-api";

export type ClusterConfirmState =
  | { kind: "failover"; candidate: ClusterFailoverCandidate }
  | { kind: "handover"; targetNodeId: string; targetName: string; force: boolean };

export interface ClusterFailoverController {
  status: ClusterLocalStatusView | null;
  busy: boolean;
  hasFailoverOffer: boolean;
  hasFailbackOffer: boolean;
  hasConflictNotice: boolean;
  hasBanner: boolean;
  confirm: ClusterConfirmState | null;
  confirmError: string | null;
  requestPromote: (candidate: ClusterFailoverCandidate) => void;
  requestHandover: (targetNodeId: string, targetName: string) => void;
  executeConfirm: () => Promise<void>;
  cancelConfirm: () => void;
  dismissFailback: () => void;
  dismissConflictNotice: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useClusterFailover({
  connected,
  cluster,
  onRoleChanged,
}: {
  connected: boolean;
  cluster: ClusterClientSummary | null;
  onRoleChanged?: () => Promise<void> | void;
}): ClusterFailoverController {
  const [status, setStatus] = useState<ClusterLocalStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ClusterConfirmState | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [dismissedFailbackKey, setDismissedFailbackKey] = useState<string | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);

  const shouldPollOffline = !connected;
  const shouldPollFailback = Boolean(
    connected &&
    cluster &&
    cluster.primaryNodeId !== cluster.preferredPrimaryNodeId,
  );

  const refresh = useCallback(async () => {
    if (inFlightRef.current && !inFlightRef.current.signal.aborted) return;
    const controller = new AbortController();
    inFlightRef.current = controller;
    try {
      const next = await deviceApi.clusterStatus(controller.signal);
      if (!controller.signal.aborted) setStatus(next);
    } catch {
      // Cluster status probe is best-effort; ignore transient transport errors while switching
    } finally {
      if (inFlightRef.current === controller) inFlightRef.current = null;
    }
  }, []);

  // One-time check on mount/connect for conflict notices or standby role, plus active polling only when needed.
  useEffect(() => {
    void refresh();
    if (!shouldPollOffline && !shouldPollFailback) return;
    const intervalMs = shouldPollOffline ? 2_500 : 8_000;
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => {
      window.clearInterval(timer);
      inFlightRef.current?.abort();
    };
  }, [refresh, shouldPollOffline, shouldPollFailback, cluster?.epoch, cluster?.primaryNodeId]);

  const promotableCandidates = (status?.failoverOffer?.candidates ?? []).filter(
    (c) => c.reachable && c.canPromote,
  );
  const hasFailoverOffer = Boolean(!connected && status?.failoverOffer && promotableCandidates.length > 0);

  const failbackOffer = status?.failbackOffer;
  const failbackKey = failbackOffer && status
    ? `${status.epoch}:${failbackOffer.preferredPrimaryNodeId}`
    : null;
  const hasFailbackOffer = Boolean(
    connected &&
    failbackOffer?.ready &&
    failbackKey &&
    failbackKey !== dismissedFailbackKey,
  );

  const hasConflictNotice = Boolean(connected && status?.conflictBackupNotice);
  const hasBanner = hasFailoverOffer || hasFailbackOffer || hasConflictNotice;

  const requestPromote = useCallback((candidate: ClusterFailoverCandidate) => {
    setConfirmError(null);
    setConfirm({ kind: "failover", candidate });
  }, []);

  const requestHandover = useCallback((targetNodeId: string, targetName: string) => {
    setConfirmError(null);
    setConfirm({ kind: "handover", targetNodeId, targetName, force: false });
  }, []);

  const cancelConfirm = useCallback(() => {
    if (busy) return;
    setConfirm(null);
    setConfirmError(null);
  }, [busy]);

  const executeConfirm = useCallback(async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setConfirmError(null);
    try {
      if (confirm.kind === "failover") {
        await deviceApi.promote(confirm.candidate.isSelf ? undefined : confirm.candidate.nodeId);
        setConfirm(null);
        toast.success(t(`已切换至「${confirm.candidate.name}」`, `Switched to ${confirm.candidate.name}`));
        await refresh();
        await onRoleChanged?.();
      } else {
        await deviceApi.handover(confirm.targetNodeId, confirm.force);
        setConfirm(null);
        toast.success(t(`已切换至「${confirm.targetName}」`, `Switched to ${confirm.targetName}`));
        await refresh();
        await onRoleChanged?.();
      }
    } catch (error) {
      if (confirm.kind === "handover" && !confirm.force && error instanceof KuloApiError && error.code === "handover_busy") {
        setConfirm({ ...confirm, force: true });
      } else {
        setConfirmError(error instanceof Error ? error.message : t("切换主机失败，请重试。", "Failed to switch host. Please retry."));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, confirm, onRoleChanged, refresh]);

  const dismissFailback = useCallback(() => {
    if (failbackKey) setDismissedFailbackKey(failbackKey);
  }, [failbackKey]);

  const dismissConflictNotice = useCallback(async () => {
    try {
      await deviceApi.dismissConflictNotice();
    } catch {
      // Ignore if already cleared
    }
    setStatus((prev) => prev ? { ...prev, conflictBackupNotice: undefined } : prev);
  }, []);

  return {
    status,
    busy,
    hasFailoverOffer,
    hasFailbackOffer,
    hasConflictNotice,
    hasBanner,
    confirm,
    confirmError,
    requestPromote,
    requestHandover,
    executeConfirm,
    cancelConfirm,
    dismissFailback,
    dismissConflictNotice,
    refresh,
  };
}
