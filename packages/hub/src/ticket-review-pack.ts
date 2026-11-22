import type { Context } from "@earendil-works/chord/context";
import {
  redactSensitiveText,
  type StagedWorkspaceDiffDetail,
  type StagedWorkspaceDiffSummary,
  type TicketRecord,
} from "@kulo/protocol";
import type { EnvManager } from "@kulo/env";
import { ProjectError, type KuloProjectsState } from "./projects.js";
import type { SettingsAssistantState } from "./settings-doc.js";
import { getActiveStagedCwd, type KuloDurableState } from "./state.js";
import { canAccessTicketInScope, resolveBoardCallerScope } from "./task-boards.js";

export const MAX_REVIEW_PACK_FILES = 40;
export const MAX_REVIEW_PACK_TOTAL_BYTES = 4 * 1024 * 1024;

const REVIEWABLE_TICKET_STATES = new Set(["ready", "failed", "waiting"]);

export interface ReviewPackMaterializationResult {
  promptSection: string;
  reviewDirRelative: string;
  filesWritten: number;
  hasFullPatch: boolean;
}

export interface MaterializedReviewAsset {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

export function validateReviewTargetTicket(
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
  settings: Readonly<SettingsAssistantState> | undefined,
  callerConversationId: number,
  targetTicketId: string,
): TicketRecord {
  const target = state?.tickets?.[targetTicketId.trim()];
  if (!target) {
    throw new ProjectError(404, "review_ticket_not_found", `待评审任务 '${targetTicketId}' 不存在。`);
  }
  const scope = resolveBoardCallerScope(state, projects, settings, callerConversationId);
  if (!canAccessTicketInScope(target, scope, state, projects)) {
    throw new ProjectError(403, "ticket_scope_denied", "当前会话无权评审该任务。");
  }
  if (!REVIEWABLE_TICKET_STATES.has(target.status)) {
    throw new ProjectError(
      409,
      "review_ticket_not_ready",
      `任务 '${target.id}' 当前状态为 ${target.status}；只能评审已落定的非运行任务（ready / failed / waiting）。`,
    );
  }
  return target;
}

export async function collectReviewPackAssets(options: {
  target: Readonly<TicketRecord>;
  inspectStagedDiff?: (ticketId: string, filePath?: string) => Promise<StagedWorkspaceDiffDetail>;
  redact: (text: string) => string;
}): Promise<{
  assets: MaterializedReviewAsset[];
  changedPaths: string[];
  hasFullPatch: boolean;
  snapshotNote: string;
}> {
  const { target, inspectStagedDiff, redact } = options;
  const stagedSummary: StagedWorkspaceDiffSummary | undefined =
    target.externalExecution?.stagedDiff ?? target.workspaceStaging?.stagedDiff;
  const stagedApplied = Boolean(
    target.externalExecution?.stagedAppliedAt ?? target.workspaceStaging?.appliedAt,
  );
  const activeStagedCwd = getActiveStagedCwd(target);
  const changedPaths = stagedSummary
    ? [...new Set([...stagedSummary.added, ...stagedSummary.modified, ...stagedSummary.deleted])]
    : [];

  const summaryLines = [
    `# Review Pack for Ticket ${target.id}: ${target.title}`,
    `- Role: \`${target.role}\` | Status: \`${target.status}\` | Env: \`${target.envId}\``,
    ...(target.projectId ? [`- Project: \`${target.projectId}\``] : []),
    `- Goal: ${target.goal}`,
    `- Scope: ${target.scope}`,
    ...(target.acceptance ? [`- Acceptance: ${target.acceptance}`] : []),
    "",
    "## Upstream Report Summary",
    target.latestReport?.summary ?? "(No report summary)",
    ...(target.latestReport?.deliverable
      ? ["", "## Upstream Deliverable Preview", target.latestReport.deliverable.slice(0, 4000)]
      : []),
  ];
  if (stagedSummary) {
    summaryLines.push(
      "",
      `## Staged Changes (${stagedApplied ? "already merged into project" : "unmerged isolated snapshot"})`,
      `- Added (${stagedSummary.added.length}): ${stagedSummary.added.slice(0, 40).join(", ") || "(none)"}`,
      `- Modified (${stagedSummary.modified.length}): ${stagedSummary.modified.slice(0, 40).join(", ") || "(none)"}`,
      `- Deleted (${stagedSummary.deleted.length}): ${stagedSummary.deleted.slice(0, 40).join(", ") || "(none)"}`,
    );
    if (stagedSummary.sensitivePaths?.length) {
      summaryLines.push(`- [HIGH-SENSITIVITY PATHS]: ${stagedSummary.sensitivePaths.join(", ")}`);
    }
    if (stagedSummary.conflictFiles.length) {
      summaryLines.push(`- [CONFLICT FILES]: ${stagedSummary.conflictFiles.join(", ")}`);
    }
  }
  if (target.latestReport?.readOnlyViolation) {
    summaryLines.push(
      "",
      "## [READ-ONLY VIOLATION WARNING]",
      `Upstream run mutated ${target.latestReport.readOnlyViolation.totalCount} paths: ${target.latestReport.readOnlyViolation.mutatedPaths.join(", ")}`,
    );
  }

  const assets: MaterializedReviewAsset[] = [
    {
      name: "summary.md",
      mimeType: "text/markdown",
      bytes: Buffer.from(redactSensitiveText(redact(summaryLines.join("\n"))), "utf8"),
    },
  ];

  let totalBytes = assets[0]!.bytes.length;
  let hasFullPatch = false;
  let snapshotNote = stagedApplied
    ? "Upstream changes are already merged into the live project directory."
    : "No active unmerged staged clone available; review is based on persisted report and diff summary.";

  if (!stagedApplied && activeStagedCwd && inspectStagedDiff && changedPaths.length > 0) {
    const patchChunks: string[] = [];
    for (const relPath of changedPaths.slice(0, MAX_REVIEW_PACK_FILES)) {
      if (totalBytes >= MAX_REVIEW_PACK_TOTAL_BYTES) break;
      try {
        const detail = await inspectStagedDiff(target.id, relPath);
        if (detail.diff) {
          const chunk = redactSensitiveText(redact(detail.diff));
          const bufLen = Buffer.byteLength(chunk, "utf8");
          if (totalBytes + bufLen <= MAX_REVIEW_PACK_TOTAL_BYTES) {
            patchChunks.push(chunk);
            totalBytes += bufLen;
          }
        }
      } catch {
        // Continue with remaining files on single-file diff error
      }
    }
    if (patchChunks.length > 0) {
      hasFullPatch = true;
      assets.push({
        name: "changes.patch",
        mimeType: "text/x-diff",
        bytes: Buffer.from(patchChunks.join("\n\n"), "utf8"),
      });
      snapshotNote = `Materialized full unified diff for ${patchChunks.length}/${changedPaths.length} changed file(s) from upstream staged snapshot (zero lock on upstream).`;
    }
  } else if (!stagedApplied && stagedSummary?.unifiedPreview) {
    assets.push({
      name: "changes.patch",
      mimeType: "text/x-diff",
      bytes: Buffer.from(redactSensitiveText(redact(stagedSummary.unifiedPreview)), "utf8"),
    });
    snapshotNote = "Upstream device offline or clone unavailable; materialized persisted unified diff preview.";
  }

  return { assets, changedPaths, hasFullPatch, snapshotNote };
}

export function formatReviewPromptSection(options: {
  target: Readonly<TicketRecord>;
  locationHint: string;
  snapshotNote: string;
}): string {
  return [
    `## Independent Read-Only Review Target (Ticket ${options.target.id}: ${options.target.title})`,
    "- Your workspace directory is the READ-ONLY baseline project (verify live files and available tooling in cwd).",
    `- Materialized review pack for \`${options.target.id}\` is located at \`${options.locationHint}\` (\`summary.md\` and \`changes.patch\` when available).`,
    `- Snapshot completeness: ${options.snapshotNote}`,
    "- Focus on correctness, edge cases, concurrency/security invariants, regressions, and untested branches. Never modify live project files.",
  ].join("\n");
}

export async function writeReviewPackToScratchEnv(options: {
  reviewTicket: Readonly<TicketRecord>;
  target: Readonly<TicketRecord>;
  assets: readonly MaterializedReviewAsset[];
  snapshotNote: string;
  envManager: EnvManager;
  context: Context;
}): Promise<ReviewPackMaterializationResult> {
  const { reviewTicket, target, assets, snapshotNote, envManager, context } = options;
  const safeTargetId = target.id.replace(/[^A-Za-z0-9._-]/g, "_");
  const reviewDirRelative = `review-${safeTargetId}`;
  const baseScratch = reviewTicket.scratchDir;
  let filesWritten = 0;

  if (baseScratch && reviewTicket.executionDomain !== "android") {
    const execEnv = envManager.createWorkerExecutionEnv(
      reviewTicket.envId,
      reviewTicket.workspaceDir,
      {
        scratchDir: baseScratch,
        projectId: reviewTicket.projectId,
        grantRevision: reviewTicket.grantRevision,
        readOnly: true,
      },
    );
    for (const asset of assets) {
      const segments = [baseScratch, reviewDirRelative, ...asset.name.split("/").filter(Boolean)];
      const targetJoined = await execEnv.joinPath(segments, context);
      if (!targetJoined.ok) continue;
      const parentJoined = await execEnv.joinPath(segments.slice(0, -1), context);
      if (parentJoined.ok) {
        await execEnv.createDir(parentJoined.value, { recursive: true }, context);
      }
      const res = await execEnv.writeFile(targetJoined.value, asset.bytes.toString("utf8"), context);
      if (res.ok) filesWritten += 1;
    }
  }

  const locationHint = baseScratch ? `${baseScratch}/${reviewDirRelative}` : reviewDirRelative;
  return {
    promptSection: formatReviewPromptSection({ target, locationHint, snapshotNote }),
    reviewDirRelative,
    filesWritten,
    hasFullPatch: assets.some((a) => a.name === "changes.patch"),
  };
}
