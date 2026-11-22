import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  defineDoc,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import {
  redactSensitiveText,
  type TicketClosureKind,
  type TicketRecord,
} from "@kulo/protocol";
import { redactCredentialData } from "./credential-redaction.js";
import { isSafeMemoryText } from "./hindsight.js";
import { matchesForgottenTerm, type ForgottenTermEntry } from "./memory-forget.js";
import type { KuloProjectsState } from "./projects.js";
import { isActiveSettingsConversation, type SettingsAssistantState } from "./settings-doc.js";
import { isOrchestratorConversation, isTicketUnfinished, type KuloDurableState } from "./state.js";

export type WorkingMemoryScope =
  | { kind: "global" }
  | { kind: "project"; projectId: string }
  | { kind: "topic"; topicId: string };

/** Authoritative ticket settlement outcome; obsolete/superseded are NEVER collapsed into completed. */
export type TicketOutcomeKind =
  | "ticket_ready_for_review"
  | "ticket_applied"
  | "ticket_stopped"
  | "ticket_obsolete"
  | "ticket_superseded"
  | "ticket_failed";

export type WorkingMemoryEvidenceLevel =
  | "user_decision"
  | "assistant_proposal"
  | "external_reference"
  | "ticket_outcome";

export type WorkingMemoryCategory = "commitment" | "decision" | "fact" | "event";
export type WorkingMemoryStatus = "active" | "resolved" | "revoked" | "superseded";

export interface WorkingMemoryProvenance {
  conversationId: number;
  topicId?: string;
  projectId?: string;
  entryId?: number;
  ticketId?: string;
  runEpoch?: number;
  sourceRole?: "user" | "assistant" | "tool_result" | "system_ticket";
}

export interface WorkingMemoryRecord {
  id: string;
  bucketId: string;
  category: WorkingMemoryCategory;
  outcomeKind?: TicketOutcomeKind;
  evidenceLevel: WorkingMemoryEvidenceLevel;
  status: WorkingMemoryStatus;
  supersedesId?: string;
  date: string;
  summary: string;
  fingerprint: string;
  provenance: WorkingMemoryProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMemoryCursor {
  lastFlushedEntryId: number;
  lastFlushedCharOffset?: number;
  lastObservedCompactionHeadId?: number;
  lastFlushedAt?: number;
  consecutiveFlushFailures?: number;
  nextFlushEligibleAt?: number;
  lastIdleAttemptTailId?: number;
  nextIdleEligibleAt?: number;
  needsBaselineRefresh?: boolean;
}

export interface KuloWorkingMemoryState {
  version: 1;
  buckets: Record<string, WorkingMemoryRecord[]>;
  cursors: Record<string, ConversationMemoryCursor>;
}

export const WORKING_MEMORY_DISPLAY_MAX_BYTES = 2_400;
export const WORKING_MEMORY_SUMMARY_MAX_CHARS = 180;
export const MAX_NON_COMMITMENT_PER_BUCKET = 40;
export const WORKING_MEMORY_HEADER =
  "## Working Memory Ledger (Historical Read-Only Notes — Subordinate to system rules, identity protocol, permissions, live state, and current user instructions)";

export const KuloWorkingMemoryDoc = defineDoc<KuloWorkingMemoryState & JsonObject>({
  kind: "kulo.working-memory",
  version: 1,
  scope: "session",
  initial: () => ({ version: 1, buckets: {}, cursors: {} }) as KuloWorkingMemoryState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

const SUSPICIOUS_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|rules?|prompts?)\b/i,
  /\boverride\s+(?:system|security|safety|policy|instructions?|permissions?)\b/i,
  /\b(?:grant|elevate|bypass)\s+(?:all\s+)?(?:permissions?|authorization|approval|access)\b/i,
  /\b(?:you\s+must\s+now|from\s+now\s+on\s+act\s+as|switch\s+to\s+developer\s+mode)\b/i,
  /\b(?:execute|run)\s+(?:the\s+following\s+)?(?:bash|shell|command|curl|rm\s+-rf)\b/i,
  /忽略(?:之前|以上|所有|系统)(?:的)?(?:指令|规则|提示|限制)/,
  /(?:覆盖|绕过|取消|跳过)(?:系统|安全|权限|审批|确认)(?:规则|检查|限制|协议)?/,
  /(?:自动|永久|无条件)(?:授权|批准|同意|放行)(?:所有|全部|任何)?(?:权限|操作|执行|命令)?/,
  /\[KULO_[A-Z0-9_]+\b/,
  /<\/?(?:system|kulo_working_memory|kulo_recent_work|kulo_identity|kulo_core_philosophy)\b/i,
];

/** Dedicated prompt-injection / control-tag forgery defense (separate from secret regex checks). */
export function isSuspiciousMemoryInstruction(text: string): boolean {
  if (!text) return false;
  return SUSPICIOUS_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function bucketIdForScope(scope: WorkingMemoryScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "project") return `project:${scope.projectId}`;
  return `topic:${scope.topicId}`;
}

export function formatLocalDate(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeMemorySummary(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, WORKING_MEMORY_SUMMARY_MAX_CHARS);
}

export function computeMemoryFingerprint(category: WorkingMemoryCategory, summary: string): string {
  const norm = summary
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
  return createHash("sha256").update(`${category}|${norm}`).digest("hex").slice(0, 24);
}

/**
 * Whole-document in-place sanitization run right before every commit of `KuloWorkingMemoryDoc`
 * so newly registered credentials can never trigger `wrapRedactedStorage` `credential_document_leak`.
 */
export function sanitizeWorkingMemoryDocInPlace(
  doc: KuloWorkingMemoryState,
  redact: (text: string) => string,
): void {
  const safeText = (value: string) => redact(redactSensitiveText(value));
  doc.version = 1;
  doc.buckets ??= {};
  doc.cursors ??= {};
  for (const [bucketKey, records] of Object.entries(doc.buckets)) {
    if (!Array.isArray(records)) {
      delete doc.buckets[bucketKey];
      continue;
    }
    const sanitized = redactCredentialData(records, safeText) as WorkingMemoryRecord[];
    for (let i = 0; i < sanitized.length; i += 1) {
      const rec = sanitized[i]!;
      rec.summary = normalizeMemorySummary(safeText(rec.summary));
      if (!rec.summary) {
        sanitized.splice(i, 1);
        i -= 1;
      }
    }
    if (sanitized.length === 0) {
      delete doc.buckets[bucketKey];
    } else {
      doc.buckets[bucketKey] = sanitized;
    }
  }
  doc.cursors = redactCredentialData(doc.cursors, safeText) as Record<string, ConversationMemoryCursor>;
}

/**
 * Independent transaction wrapper for `KuloWorkingMemoryDoc`.
 * Never shares transactions with `KuloStateDoc` or `KuloProjectsDoc`.
 * Skips no-op writes when the serialized snapshot is unchanged, and sanitizes the entire
 * document before commit to prevent `documentLeak()` rollbacks.
 */
export async function commitWorkingMemory<T>(
  harness: Harness,
  redact: (text: string) => string,
  mutator: (doc: KuloWorkingMemoryState) => T,
  context: Context = BACKGROUND_CONTEXT,
): Promise<{ committed: boolean; result: T }> {
  let result!: T;
  let committed = false;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(KuloWorkingMemoryDoc);
    const before = JSON.stringify(doc);
    const workingCopy = JSON.parse(before) as KuloWorkingMemoryState;
    result = mutator(workingCopy);
    sanitizeWorkingMemoryDocInPlace(workingCopy, redact);
    const after = JSON.stringify(workingCopy);
    if (after === before) return;
    doc.version = workingCopy.version;
    doc.buckets = workingCopy.buckets;
    doc.cursors = workingCopy.cursors;
    committed = true;
  }, context);
  return { committed, result };
}

export async function tryCommitWorkingMemory<T>(
  harness: Harness,
  redact: (text: string) => string,
  mutator: (doc: KuloWorkingMemoryState) => T,
  context: Context = BACKGROUND_CONTEXT,
): Promise<{ ok: boolean; committed: boolean; result?: T }> {
  try {
    const res = await commitWorkingMemory(harness, redact, mutator, context);
    return { ok: true, committed: res.committed, result: res.result };
  } catch (error) {
    console.warn("[KuloWorkingMemory] Best-effort working memory commit skipped", error);
    return { ok: false, committed: false };
  }
}

/**
 * Inserts or updates a record inside its scoped bucket while enforcing:
 * - active `commitment` records are NEVER evicted by other categories or cross-project volume;
 * - non-commitment records (`decision`/`fact`/`event`) retain the latest 40 per bucket;
 * - `supersedesId` marks the referenced prior record as `"superseded"` preserving audit lineage.
 */
export function upsertWorkingMemoryRecord(
  doc: KuloWorkingMemoryState,
  input: WorkingMemoryRecord,
): { inserted: boolean; record: WorkingMemoryRecord } {
  doc.buckets ??= {};
  const bucket = (doc.buckets[input.bucketId] ??= []);

  // Mark superseded predecessor in this bucket (or any bucket if moved).
  if (input.supersedesId) {
    for (const records of Object.values(doc.buckets)) {
      for (const existing of records) {
        if (existing.id === input.supersedesId && existing.status === "active") {
          existing.status = "superseded";
          existing.updatedAt = Math.max(existing.updatedAt, input.updatedAt);
        }
      }
    }
  }

  // Exact idempotent match by record id.
  const byId = bucket.findIndex((item) => item.id === input.id);
  if (byId >= 0) {
    const prev = bucket[byId]!;
    bucket[byId] = {
      ...prev,
      ...input,
      createdAt: Math.min(prev.createdAt, input.createdAt),
      updatedAt: Math.max(prev.updatedAt, input.updatedAt),
    };
    return { inserted: false, record: bucket[byId]! };
  }

  // Deduplicate active records sharing the same (category, fingerprint).
  const byFp = bucket.findIndex(
    (item) => item.status === "active" && item.category === input.category && item.fingerprint === input.fingerprint,
  );
  if (byFp >= 0) {
    const prev = bucket[byFp]!;
    prev.updatedAt = Math.max(prev.updatedAt, input.updatedAt);
    prev.date = input.date;
    // Only upgrade evidenceLevel when the new source is strictly more authoritative (user_decision > assistant_proposal > external_reference).
    if (evidenceRank(input.evidenceLevel) > evidenceRank(prev.evidenceLevel)) {
      prev.evidenceLevel = input.evidenceLevel;
      prev.provenance = input.provenance;
    }
    return { inserted: false, record: prev };
  }

  bucket.push(input);
  pruneBucketRecords(bucket);
  return { inserted: true, record: input };
}

function evidenceRank(level: WorkingMemoryEvidenceLevel): number {
  switch (level) {
    case "user_decision": return 4;
    case "ticket_outcome": return 3;
    case "assistant_proposal": return 2;
    case "external_reference": return 1;
  }
}

function pruneBucketRecords(bucket: WorkingMemoryRecord[]): void {
  const activeCommitments: WorkingMemoryRecord[] = [];
  const others: WorkingMemoryRecord[] = [];
  for (const record of bucket) {
    if (record.category === "commitment" && record.status === "active") {
      activeCommitments.push(record);
    } else {
      others.push(record);
    }
  }
  if (others.length <= MAX_NON_COMMITMENT_PER_BUCKET) return;
  // Keep newest non-commitment records, preferring active items over resolved/superseded/revoked.
  others.sort((a, b) => {
    const aActive = a.status === "active" ? 1 : 0;
    const bActive = b.status === "active" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return b.updatedAt - a.updatedAt;
  });
  const keptOthers = others.slice(0, MAX_NON_COMMITMENT_PER_BUCKET);
  bucket.length = 0;
  bucket.push(...activeCommitments, ...keptOthers);
}

/** Deterministic mapping from authoritative ticket transition to real TicketOutcomeKind. */
export function classifyTicketOutcome(
  ticket: Readonly<TicketRecord>,
  override?: {
    applied?: boolean;
    closureKind?: TicketClosureKind;
    failed?: boolean;
  },
): TicketOutcomeKind | undefined {
  if (override?.applied) return "ticket_applied";
  if (override?.failed) return "ticket_failed";
  const closureKind = override?.closureKind ?? ticket.closure?.kind;
  if (ticket.status === "closed") {
    if (closureKind === "obsolete") return "ticket_obsolete";
    if (closureKind === "superseded") return "ticket_superseded";
    return "ticket_applied";
  }
  if (ticket.status === "ready") return "ticket_ready_for_review";
  if (ticket.status === "stopped") return "ticket_stopped";
  return undefined;
}

const OUTCOME_LABEL: Record<TicketOutcomeKind, string> = {
  ticket_ready_for_review: "待审核交付",
  ticket_applied: "已合入应用",
  ticket_stopped: "已停止",
  ticket_obsolete: "已作废（未交付）",
  ticket_superseded: "已被新任务取代（未交付）",
  ticket_failed: "执行失败",
};

export function buildTicketOutcomeRecord(
  ticket: Readonly<TicketRecord>,
  outcomeKind: TicketOutcomeKind,
  options: { detail?: string; now?: number } = {},
): WorkingMemoryRecord {
  const now = options.now ?? Date.now();
  const originConvId = ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID);
  const originTopicId = ticket.originTopicId ?? "root";
  const bucketId = ticket.projectId
    ? bucketIdForScope({ kind: "project", projectId: ticket.projectId })
    : bucketIdForScope({ kind: "topic", topicId: originTopicId });
  const detail = options.detail?.trim() || ticket.latestReport?.summary?.trim() || ticket.stoppedReason?.trim() || "";
  const rawSummary = detail
    ? `工单 ${ticket.id}「${ticket.title}」${OUTCOME_LABEL[outcomeKind]}：${detail}`
    : `工单 ${ticket.id}「${ticket.title}」${OUTCOME_LABEL[outcomeKind]}`;
  const summary = normalizeMemorySummary(rawSummary);
  return {
    id: `ticket:${ticket.id}:e${ticket.runEpoch}:${outcomeKind}`,
    bucketId,
    category: "event",
    outcomeKind,
    evidenceLevel: "ticket_outcome",
    status: "active",
    date: formatLocalDate(now),
    summary,
    fingerprint: computeMemoryFingerprint("event", summary),
    provenance: {
      conversationId: originConvId,
      topicId: originTopicId,
      ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
      ticketId: ticket.id,
      runEpoch: ticket.runEpoch,
      sourceRole: "system_ticket",
    },
    createdAt: now,
    updatedAt: now,
  };
}

export async function recordTicketOutcomeToWorkingMemory(
  harness: Harness,
  redact: (text: string) => string,
  ticket: Readonly<TicketRecord>,
  outcomeKind: TicketOutcomeKind,
  options: { detail?: string; now?: number } = {},
  context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
  const record = buildTicketOutcomeRecord(ticket, outcomeKind, options);
  const res = await tryCommitWorkingMemory(
    harness,
    redact,
    (doc) => {
      upsertWorkingMemoryRecord(doc, record);
    },
    context,
  );
  return res.committed;
}

export interface BuildWorkingMemorySnapshotOptions {
  doc: Readonly<KuloWorkingMemoryState> | undefined;
  state: Readonly<KuloDurableState> | undefined;
  projects: Readonly<KuloProjectsState> | undefined;
  settings: Readonly<SettingsAssistantState> | undefined;
  conversationId: number;
  recentWorkEnabled?: boolean;
  forgottenTerms?: readonly ForgottenTermEntry[];
  maxBytes?: number;
}

export interface WorkingMemorySnapshotResult {
  content: string;
  recordCount: number;
  bytes: number;
}

function resolveLiveRecordVisibility(
  record: Readonly<WorkingMemoryRecord>,
  callerConversationId: number,
  callerTopicId: string,
  callerProjectId: string | undefined,
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
): { visible: boolean; directReadable: boolean; sourceHint?: string } {
  const isRootCaller = callerTopicId === "root";
  const provTopicId = record.provenance.topicId;
  const provTopic = provTopicId ? state?.topics?.[provTopicId] : undefined;

  // Source topic explicitly soft-deleted -> skip everywhere!
  if (provTopicId && (!provTopic || provTopic.deletedAt !== undefined)) {
    return { visible: false, directReadable: false };
  }

  // Live project resolution (handles `moveTopic` dynamically!).
  const liveProjectId = provTopic ? (provTopic.projectId ?? undefined) : record.provenance.projectId;
  if (liveProjectId) {
    const project = projects?.projects?.[liveProjectId];
    if (!project || project.deletedAt !== undefined) {
      return { visible: false, directReadable: false };
    }
  }

  // Bucket-level live scope resolution.
  if (record.bucketId === "global") {
    const directReadable =
      record.provenance.conversationId === callerConversationId ||
      Boolean(callerProjectId && liveProjectId && callerProjectId === liveProjectId);
    return {
      visible: true,
      directReadable,
      sourceHint: directReadable ? undefined : buildNonDirectSourceHint(record, provTopic?.title, liveProjectId, projects),
    };
  }

  if (record.bucketId.startsWith("project:")) {
    const bucketProjectId = record.bucketId.slice("project:".length);
    const bucketProject = projects?.projects?.[bucketProjectId];
    if (!bucketProject || bucketProject.deletedAt !== undefined) {
      return { visible: false, directReadable: false };
    }
    const effectiveProjectId = provTopic ? (provTopic.projectId ?? undefined) : bucketProjectId;
    if (effectiveProjectId !== bucketProjectId) {
      // Topic moved out of this project -> fall through to live topic/project ownership.
      if (callerProjectId && effectiveProjectId === callerProjectId) {
        return { visible: true, directReadable: true };
      }
      if (provTopicId === callerTopicId) {
        return { visible: true, directReadable: true };
      }
      if (isRootCaller) {
        return {
          visible: true,
          directReadable: false,
          sourceHint: buildNonDirectSourceHint(record, provTopic?.title, effectiveProjectId, projects),
        };
      }
      return { visible: false, directReadable: false };
    }
    if (callerProjectId === bucketProjectId) {
      return { visible: true, directReadable: true };
    }
    if (isRootCaller) {
      return {
        visible: true,
        directReadable: false,
        sourceHint: buildNonDirectSourceHint(record, provTopic?.title, bucketProjectId, projects),
      };
    }
    return { visible: false, directReadable: false };
  }

  if (record.bucketId.startsWith("topic:")) {
    const bucketTopicId = record.bucketId.slice("topic:".length);
    const bucketTopic = state?.topics?.[bucketTopicId];
    if (!bucketTopic || bucketTopic.deletedAt !== undefined) {
      return { visible: false, directReadable: false };
    }
    const bucketTopicProjectId = bucketTopic.projectId ?? undefined;
    if (bucketTopicProjectId) {
      const movedProj = projects?.projects?.[bucketTopicProjectId];
      if (!movedProj || movedProj.deletedAt !== undefined) {
        return { visible: false, directReadable: false };
      }
    }
    if (bucketTopicId === callerTopicId) {
      return { visible: true, directReadable: true };
    }
    if (callerProjectId && bucketTopicProjectId === callerProjectId) {
      return { visible: true, directReadable: true };
    }
    if (isRootCaller) {
      return {
        visible: true,
        directReadable: false,
        sourceHint: buildNonDirectSourceHint(record, bucketTopic.title, bucketTopicProjectId, projects),
      };
    }
    return { visible: false, directReadable: false };
  }

  // Unknown/corrupt bucket key -> NEVER fall back to global!
  return { visible: false, directReadable: false };
}

function buildNonDirectSourceHint(
  record: Readonly<WorkingMemoryRecord>,
  topicTitle: string | undefined,
  projectId: string | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
): string {
  if (record.provenance.ticketId) return record.provenance.ticketId;
  if (projectId) {
    const projectName = projects?.projects?.[projectId]?.name;
    if (projectName) return `项目「${projectName.slice(0, 32)}」`;
    return "项目检索";
  }
  if (topicTitle) return `话题「${topicTitle.slice(0, 32)}」`;
  return "历史摘要";
}

function formatMemoryLine(
  record: Readonly<WorkingMemoryRecord>,
  directReadable: boolean,
  sourceHint: string | undefined,
): string {
  const evidenceTag =
    record.evidenceLevel === "assistant_proposal"
      ? "[提议/待确认] "
      : record.evidenceLevel === "external_reference"
        ? "[外部资料] "
        : "";
  let pointer: string;
  if (directReadable && record.provenance.entryId) {
    pointer = `${record.date} · conv#${record.provenance.conversationId}/entry#${record.provenance.entryId}`;
  } else if (record.provenance.ticketId) {
    pointer = `${record.date} · ${record.provenance.ticketId}`;
  } else if (sourceHint) {
    pointer = `${record.date} · ${sourceHint}`;
  } else {
    pointer = record.date;
  }
  return `- ${evidenceTag}${record.summary} [${pointer}]`;
}

/**
 * Renders the caller's live-scoped working memory snapshot within a hard UTF-8 byte budget
 * (`<= 2,400` bytes). Strictly excludes `SettingsAssistant`, Workers, soft-deleted scopes,
 * forgotten terms, and un-readable direct `entry#` pointers.
 */
export function buildWorkingMemorySnapshot(
  options: BuildWorkingMemorySnapshotOptions,
): WorkingMemorySnapshotResult {
  const { doc, state, projects, settings, conversationId } = options;
  if (!doc || !state) return { content: "", recordCount: 0, bytes: 0 };
  if (
    !isOrchestratorConversation(conversationId, state) ||
    isActiveSettingsConversation(conversationId, settings)
  ) {
    return { content: "", recordCount: 0, bytes: 0 };
  }

  const callerTopicId = state.conversationToTopic?.[String(conversationId)] ?? "root";
  const callerTopic = state.topics?.[callerTopicId];
  if (!callerTopic || callerTopic.deletedAt !== undefined) {
    return { content: "", recordCount: 0, bytes: 0 };
  }
  const callerProjectId = callerTopic.projectId ?? undefined;
  if (callerProjectId) {
    const proj = projects?.projects?.[callerProjectId];
    if (!proj || proj.deletedAt !== undefined) {
      return { content: "", recordCount: 0, bytes: 0 };
    }
  }

  const maxBytes = options.maxBytes ?? WORKING_MEMORY_DISPLAY_MAX_BYTES;
  const forgotten = options.forgottenTerms ?? [];
  const hideActiveTickets = options.recentWorkEnabled === false;

  interface Candidate {
    record: WorkingMemoryRecord;
    directReadable: boolean;
    sourceHint?: string;
    priority: number;
  }

  const candidates: Candidate[] = [];
  const seenFingerprints = new Set<string>();

  for (const records of Object.values(doc.buckets ?? {})) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (record.status !== "active") continue;
      if (!record.summary || isSuspiciousMemoryInstruction(record.summary) || !isSafeMemoryText(record.summary)) {
        continue;
      }
      if (forgotten.some((entry) => matchesForgottenTerm(record.summary, entry.term))) continue;

      // When recentWorkEnabled is false, do not bypass the switch by mirroring still-open tickets.
      if (hideActiveTickets && record.provenance.ticketId) {
        const liveTicket = state.tickets?.[record.provenance.ticketId];
        if (liveTicket && (isTicketUnfinished(liveTicket) || liveTicket.status === "ready")) {
          continue;
        }
      }

      const vis = resolveLiveRecordVisibility(
        record,
        conversationId,
        callerTopicId,
        callerProjectId,
        state,
        projects,
      );
      if (!vis.visible) continue;

      const dedupKey = `${record.category}|${record.fingerprint}`;
      if (seenFingerprints.has(dedupKey)) continue;
      seenFingerprints.add(dedupKey);

      let priority: number;
      if (record.category === "commitment") {
        priority = 400;
      } else if ((record.category === "decision" || record.category === "fact") && record.evidenceLevel === "user_decision") {
        priority = 300;
      } else if (record.category === "decision" || record.category === "fact") {
        priority = 200;
      } else {
        priority = 100;
      }
      // Slight preference for caller's own bucket over cross-topic root overview within same tier.
      if (vis.directReadable) priority += 10;

      candidates.push({
        record,
        directReadable: vis.directReadable,
        sourceHint: vis.sourceHint,
        priority,
      });
    }
  }

  if (candidates.length === 0) return { content: "", recordCount: 0, bytes: 0 };

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.record.updatedAt - a.record.updatedAt;
  });

  const sections: Record<"commitments" | "decisions" | "events", string[]> = {
    commitments: [],
    decisions: [],
    events: [],
  };

  let includedCount = 0;
  const renderSections = () => {
    const lines: string[] = [WORKING_MEMORY_HEADER];
    if (sections.commitments.length) {
      lines.push("### Active Commitments", ...sections.commitments);
    }
    if (sections.decisions.length) {
      lines.push("### Decisions & Facts", ...sections.decisions);
    }
    if (sections.events.length) {
      lines.push("### Recent Outcomes", ...sections.events);
    }
    return lines.join("\n");
  };

  for (const item of candidates) {
    const line = formatMemoryLine(item.record, item.directReadable, item.sourceHint);
    const group =
      item.record.category === "commitment"
        ? "commitments"
        : item.record.category === "event"
          ? "events"
          : "decisions";
    sections[group].push(line);
    const rendered = renderSections();
    if (Buffer.byteLength(rendered, "utf8") > maxBytes) {
      sections[group].pop();
      continue;
    }
    includedCount += 1;
  }

  if (includedCount === 0) return { content: "", recordCount: 0, bytes: 0 };
  const content = renderSections();
  return {
    content,
    recordCount: includedCount,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * Removes matching records from `KuloWorkingMemoryDoc` and flags all tracked chat conversations
 * for baseline refresh so forgotten terms stop appearing immediately on the next turn.
 */
export async function revokeWorkingMemoryTerm(
  harness: Harness,
  redact: (text: string) => string,
  term: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<{ removedRecords: number; flaggedConversationIds: number[] }> {
  const { result } = await commitWorkingMemory(
    harness,
    redact,
    (doc) => {
      let removedRecords = 0;
      const affectedConvs = new Set<number>();
      for (const [bucketKey, records] of Object.entries(doc.buckets)) {
        const kept: WorkingMemoryRecord[] = [];
        for (const rec of records) {
          if (matchesForgottenTerm(rec.summary, term)) {
            removedRecords += 1;
            if (rec.provenance.conversationId) affectedConvs.add(rec.provenance.conversationId);
          } else {
            kept.push(rec);
          }
        }
        if (kept.length === 0) delete doc.buckets[bucketKey];
        else doc.buckets[bucketKey] = kept;
      }
      // Flag all known cursors + affected conversations so derived baselines refresh immediately.
      for (const key of Object.keys(doc.cursors)) {
        const convId = Number(key);
        if (Number.isSafeInteger(convId) && convId > 0) affectedConvs.add(convId);
      }
      affectedConvs.add(Number(ROOT_CONVERSATION_ID));
      for (const convId of affectedConvs) {
        const key = String(convId);
        const existing = doc.cursors[key] ?? { lastFlushedEntryId: 0 };
        existing.needsBaselineRefresh = true;
        doc.cursors[key] = existing;
      }
      return { removedRecords, flaggedConversationIds: [...affectedConvs] };
    },
    context,
  );
  return result;
}

/**
 * Purges working memory buckets/records belonging to a deleted topic or project and marks
 * active conversations (including root) for derived baseline refresh.
 */
export async function purgeDeletedScopeWorkingMemory(
  harness: Harness,
  redact: (text: string) => string,
  scope: { topicId?: string; projectId?: string; conversationIds?: readonly number[] },
  context: Context = BACKGROUND_CONTEXT,
): Promise<{ removedRecords: number; flaggedConversationIds: number[] }> {
  const res = await tryCommitWorkingMemory(
    harness,
    redact,
    (doc) => {
      let removedRecords = 0;
      const convSet = new Set<number>(scope.conversationIds ?? []);
      const targetBuckets = new Set<string>();
      if (scope.topicId) targetBuckets.add(bucketIdForScope({ kind: "topic", topicId: scope.topicId }));
      if (scope.projectId) targetBuckets.add(bucketIdForScope({ kind: "project", projectId: scope.projectId }));

      for (const [bucketKey, records] of Object.entries(doc.buckets)) {
        if (targetBuckets.has(bucketKey)) {
          removedRecords += records.length;
          delete doc.buckets[bucketKey];
          continue;
        }
        const kept = records.filter((rec) => {
          const matchesTopic = scope.topicId && rec.provenance.topicId === scope.topicId;
          const matchesProject = scope.projectId && rec.provenance.projectId === scope.projectId;
          const matchesConv = convSet.has(rec.provenance.conversationId);
          if (matchesTopic || matchesProject || matchesConv) {
            removedRecords += 1;
            return false;
          }
          return true;
        });
        if (kept.length === 0) delete doc.buckets[bucketKey];
        else doc.buckets[bucketKey] = kept;
      }

      for (const convId of convSet) {
        delete doc.cursors[String(convId)];
      }
      const flagged = new Set<number>([Number(ROOT_CONVERSATION_ID)]);
      for (const key of Object.keys(doc.cursors)) {
        const cid = Number(key);
        if (Number.isSafeInteger(cid) && cid > 0) flagged.add(cid);
      }
      if (removedRecords > 0) {
        for (const cid of flagged) {
          const k = String(cid);
          const cursor = doc.cursors[k] ?? { lastFlushedEntryId: 0 };
          cursor.needsBaselineRefresh = true;
          doc.cursors[k] = cursor;
        }
      }
      return { removedRecords, flaggedConversationIds: removedRecords > 0 ? [...flagged] : [] };
    },
    context,
  );
  return res.result ?? { removedRecords: 0, flaggedConversationIds: [] };
}
