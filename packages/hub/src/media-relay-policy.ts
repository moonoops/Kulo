import { createHash } from "node:crypto";
import { redactSensitiveText, type MediaJob } from "@kulo/protocol";
import { formatMediaRelayMessage, type MediaRelayActiveSibling } from "./prompts/events-and-jobs.js";
import type { MediaRelayJobSummary } from "./state.js";

export type MediaRelayStatus = "completed" | "failed" | "needs_user" | "needs_reconciliation";

export interface PendingMediaRelayRef {
  eventKey: string;
  jobId: string;
  topicId: string;
  status: MediaRelayStatus;
  settledAt: number;
}

export interface MediaNoticesState {
  notices: Record<string, boolean>;
  pendingRelays?: Record<string, PendingMediaRelayRef[]>;
}

export interface MediaJobFlightRecord {
  id: string;
  operationId: string;
  capabilityId: string;
  modelId: string;
  kind: "image" | "video";
  status: MediaJob["status"];
  source: MediaJob["source"];
  assets: MediaJob["assets"];
  error?: string;
  createdAt: number;
  deliveredAt?: number;
  settledVersion?: number;
  notifiedSettledVersion?: number;
}

export const DEFAULT_BATCH_COALESCE_MAX_MS = 60_000;
export const BUSY_RECHECK_FALLBACK_MS = 1_000;
const MULTI_CAPABILITY_WINDOW_MS = 30_000;
const MAX_NON_SPEECH_NOTICES = 512;
const MAX_RELAY_ERROR_CHARS = 500;

const ACTIVE_MEDIA_STATUSES = new Set<MediaJob["status"]>(["queued", "submitting", "running", "collecting"]);
const SETTLED_RELAY_STATUSES = new Set<MediaJob["status"]>(["failed", "needs_user", "needs_reconciliation"]);

export function sanitizeMediaError(raw: string | undefined, redact: (text: string) => string): string | undefined {
  if (!raw?.trim()) return undefined;
  const cleaned = redact(redactSensitiveText(raw)).replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, MAX_RELAY_ERROR_CHARS) : undefined;
}

export function pruneMediaNotices(doc: MediaNoticesState): void {
  const protectedKeys = new Set<string>();
  for (const queue of Object.values(doc.pendingRelays ?? {})) {
    for (const item of queue) protectedKeys.add(item.eventKey);
  }
  const prunable = Object.keys(doc.notices).filter((key) => !key.startsWith("speech:") && !protectedKeys.has(key));
  const excess = prunable.length - MAX_NON_SPEECH_NOTICES;
  if (excess <= 0) return;
  for (let i = 0; i < excess; i++) delete doc.notices[prunable[i]!];
}

export function enqueuePendingMediaRelay(doc: MediaNoticesState, convKey: string, ref: PendingMediaRelayRef): number {
  if (doc.notices[ref.eventKey]) return doc.pendingRelays?.[convKey]?.length ?? 0;
  doc.pendingRelays ??= {};
  const current = doc.pendingRelays[convKey] ?? [];
  if (current.some((item) => item.eventKey === ref.eventKey)) return current.length;
  const kept: PendingMediaRelayRef[] = [];
  for (const existing of current) {
    if (existing.jobId === ref.jobId) {
      doc.notices[existing.eventKey] = true;
    } else {
      kept.push(existing);
    }
  }
  kept.push(ref);
  doc.pendingRelays[convKey] = kept;
  pruneMediaNotices(doc);
  return kept.length;
}

export function isMediaJobInFlightForRelay(
  job: Pick<MediaJobFlightRecord, "status" | "deliveredAt" | "settledVersion" | "notifiedSettledVersion">,
): boolean {
  if (ACTIVE_MEDIA_STATUSES.has(job.status)) return true;
  if (job.status === "completed" && !job.deliveredAt) return true;
  if (SETTLED_RELAY_STATUSES.has(job.status) && (job.settledVersion ?? 0) > (job.notifiedSettledVersion ?? 0)) {
    return true;
  }
  return false;
}

export function hasDifferentCapabilitySibling(
  job: Pick<MediaJob, "id" | "capabilityId" | "kind" | "createdAt">,
  conversationId: number,
  allJobs: readonly MediaJobFlightRecord[],
  pendingRefs: readonly PendingMediaRelayRef[],
): boolean {
  const pendingJobIds = new Set(pendingRefs.map((item) => item.jobId));
  return allJobs.some((other) => {
    if (other.id === job.id || other.source.ticketId || other.source.setupClientId) return false;
    if (other.source.conversationId !== conversationId || other.kind !== job.kind) return false;
    if (other.capabilityId === job.capabilityId) return false;
    return (
      isMediaJobInFlightForRelay(other) ||
      pendingJobIds.has(other.id) ||
      Math.abs(other.createdAt - job.createdAt) <= MULTI_CAPABILITY_WINDOW_MS
    );
  });
}

export function collectActiveDirectSiblings(
  allJobs: readonly MediaJobFlightRecord[],
  conversationId: number,
  queuedJobIds: ReadonlySet<string>,
): MediaJobFlightRecord[] {
  return allJobs.filter((candidate) => {
    if (candidate.source.ticketId || candidate.source.setupClientId) return false;
    if (candidate.source.conversationId !== conversationId || queuedJobIds.has(candidate.id)) return false;
    return isMediaJobInFlightForRelay(candidate);
  });
}

export function buildMediaRelayBatch(params: {
  convKey: string;
  queue: readonly PendingMediaRelayRef[];
  jobsById: Readonly<Record<string, MediaJobFlightRecord | undefined>>;
  activeSiblings: readonly MediaJobFlightRecord[];
  capabilityNames: ReadonlyMap<string, string>;
  redact: (text: string) => string;
}): {
  sorted: PendingMediaRelayRef[];
  batchKey: string;
  requestId: string;
  content: string;
  summaries: MediaRelayJobSummary[];
  failedSummaries: MediaRelayJobSummary[];
} {
  const sorted = [...params.queue].sort((a, b) => a.settledAt - b.settledAt || a.eventKey.localeCompare(b.eventKey));
  const summaries: MediaRelayJobSummary[] = sorted.map((ref) => {
    const stored = params.jobsById[ref.jobId];
    const capabilityId = stored?.capabilityId ?? "";
    const rawCapName = params.capabilityNames.get(capabilityId);
    const capabilityName = rawCapName ? params.redact(redactSensitiveText(rawCapName)).trim() || undefined : undefined;
    const safeError = ref.status === "completed" ? undefined : sanitizeMediaError(stored?.error, params.redact);
    return {
      jobId: ref.jobId,
      operationId: stored?.operationId ?? ref.jobId,
      capabilityId,
      ...(capabilityName ? { capabilityName } : {}),
      modelId: stored?.modelId ?? "unknown",
      kind: stored?.kind ?? "image",
      status: ref.status,
      assetIds: ref.status === "completed" ? (stored?.assets ?? []).map((asset) => asset.id) : [],
      ...(safeError ? { error: safeError } : {}),
    };
  });
  const stillActive: MediaRelayActiveSibling[] = [...params.activeSiblings]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((item) => {
      const capabilityName = params.capabilityNames.get(item.capabilityId) || undefined;
      return {
        jobId: item.id,
        ...(capabilityName ? { capabilityName } : {}),
        modelId: item.modelId,
        kind: item.kind,
        status: item.status,
      };
    });
  const batchKey = createHash("sha256")
    .update(JSON.stringify(sorted.map((item) => item.eventKey)))
    .digest("hex")
    .slice(0, 24);
  return {
    sorted,
    batchKey,
    requestId: `kulo:media-relay:${params.convKey}:${batchKey}`,
    content: formatMediaRelayMessage({ jobs: summaries, stillActive }),
    summaries,
    failedSummaries: summaries.filter((item) => item.status !== "completed"),
  };
}

export function formatMediaFallbackNotice(failedSummaries: readonly MediaRelayJobSummary[]): string {
  const lines = failedSummaries.map((item) => {
    const label = item.capabilityName || item.modelId;
    const verb = item.status === "needs_user" || item.status === "needs_reconciliation" ? "需要处理" : "失败";
    return `${label}${verb}${item.error ? `：${item.error}` : ""}`;
  });
  return `媒体作业未完成：${lines.join("；")}`;
}
