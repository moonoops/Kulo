import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EXTERNAL_AGENT_KINDS,
  validateCustomAcpArgs,
  type ExternalAgentBinding,
  type ExternalAgentContextUsage,
  type ExternalAgentInputAttachment,
  type ExternalAgentKind,
  type ExternalAgentPendingReport,
  type ExternalAgentPendingReportFile,
  type ExternalAgentRequest,
  type ExternalAgentResponse,
  type ExternalAgentUncertainReason,
  type ReadOnlyViolationSummary,
  type StagedWorkspaceDiffSummary,
  type WorkerExecutionPhase,
} from "@kulo/protocol";
import { isValidQuotaProbeResult } from "./external-agent-quota.js";
import { canonicalExecutionPath } from "./isolation.js";

const WORKER_PHASES = new Set<WorkerExecutionPhase>(["starting", "investigating", "editing", "verifying", "responding", "waiting_permission"]);
const UNCERTAIN_REASONS = new Set<ExternalAgentUncertainReason>(["timeout", "disconnect", "env_restart", "closed"]);
export type ExternalImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
const INLINE_IMAGE_MIMES = new Set<ExternalImageMimeType>(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const EXTERNAL_DEVELOPER_INSTRUCTIONS_MAX_CHARS = 24_000;
export const EXTERNAL_INPUT_ATTACHMENTS_MAX_ITEMS = 8;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9:_.-]{1,200}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
}

function optionalString(value: unknown, max = 8192): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00]/.test(value));
}

function binding(value: unknown): value is ExternalAgentBinding {
  if (!object(value) || !EXTERNAL_AGENT_KINDS.includes(value.kind as ExternalAgentKind) || !id(value.envId) || !optionalString(value.executable) || !optionalString(value.agentRef) || !optionalString(value.cdpUrl)) {
    return false;
  }
  if (value.acpArgs !== undefined) {
    if (value.kind !== "acp") return false;
    if (!validateCustomAcpArgs(value.acpArgs).ok) return false;
  }
  return true;
}

function validPathList(value: unknown, maxItems = 5000, maxLen = 4096): boolean {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= maxLen);
}

function validDiffSummary(value: unknown): value is StagedWorkspaceDiffSummary {
  if (!object(value) || typeof value.hasChanges !== "boolean" || typeof value.truncated !== "boolean" || typeof value.unifiedPreview !== "string" || value.unifiedPreview.length > 64_000) return false;
  if (!["added", "modified", "deleted", "conflictFiles"].every((key) => validPathList(value[key]))) return false;
  return ["emptyDirsAdded", "emptyDirsDeleted", "modeChanged", "sensitivePaths", "autoExecPaths"].every((key) => value[key] === undefined || validPathList(value[key]));
}

function validReadOnlyViolation(value: unknown): value is ReadOnlyViolationSummary {
  return object(value) && validPathList(value.mutatedPaths, 50, 4096) && typeof value.totalCount === "number" && Number.isSafeInteger(value.totalCount) && value.totalCount >= 1 && typeof value.discardedFromClone === "boolean";
}

export function isValidExternalContextUsage(value: unknown): value is ExternalAgentContextUsage {
  if (!object(value)) return false;
  if (Object.keys(value).some((key) => !["usedTokens", "contextWindow", "percent", "updatedAt"].includes(key))) {
    return false;
  }
  if (typeof value.usedTokens !== "number" || !Number.isFinite(value.usedTokens) || value.usedTokens < 0) {
    return false;
  }
  if (
    value.contextWindow !== undefined &&
    (typeof value.contextWindow !== "number" || !Number.isFinite(value.contextWindow) || value.contextWindow <= 0)
  ) {
    return false;
  }
  if (
    value.percent !== undefined &&
    (value.contextWindow === undefined ||
      typeof value.percent !== "number" ||
      !Number.isFinite(value.percent) ||
      value.percent < 0 ||
      value.percent > 100)
  ) {
    return false;
  }
  return typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) && value.updatedAt > 0;
}

function validPendingReportFile(value: unknown): value is ExternalAgentPendingReportFile {
  return object(value) && typeof value.originalPath === "string" && value.originalPath.length > 0 && value.originalPath.length <= 4096 && typeof value.snapshotPath === "string" && value.snapshotPath.length > 0 && value.snapshotPath.length <= 4096 && optionalString(value.name, 240) && optionalString(value.mimeType, 120) && optionalString(value.caption, 500) && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 25 * 1024 * 1024 && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
}

function validPendingReport(value: unknown): value is ExternalAgentPendingReport {
  return object(value) && id(value.reportId) && ["progress", "blocked", "ready", "failed"].includes(String(value.state)) && typeof value.summary === "string" && value.summary.length > 0 && value.summary.length <= 4000 && (value.deliverable === undefined || (typeof value.deliverable === "string" && value.deliverable.length <= 60_000)) && (value.question === undefined || (typeof value.question === "string" && value.question.length <= 2000)) && (value.files === undefined || (Array.isArray(value.files) && value.files.length <= 16 && value.files.every(validPendingReportFile))) && typeof value.at === "number" && Number.isFinite(value.at);
}

/** Pure in-memory attachment validation — never performs fs I/O inside control-frame validation. */
function validInputAttachment(value: unknown): value is ExternalAgentInputAttachment {
  if (!object(value)) return false;
  const allowed = ["id", "name", "mimeType", "path", "size", "sha256"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (value.id !== undefined && !optionalString(value.id, 200)) return false;
  if (typeof value.name !== "string" || !value.name.length || value.name.length > 240 || /[\x00-\x1f\x7f]/.test(value.name)) return false;
  if (typeof value.mimeType !== "string" || !value.mimeType.length || value.mimeType.length > 120 || /[\x00-\x1f\x7f]/.test(value.mimeType)) return false;
  if (typeof value.path !== "string" || !value.path.length || value.path.length > 4096 || !path.isAbsolute(value.path) || /[\x00-\x1f\x7f]/.test(value.path)) return false;
  if (value.size !== undefined && (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 50 * 1024 * 1024)) return false;
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))) return false;
  return true;
}

export function isExternalAgentRequest(value: unknown): value is ExternalAgentRequest {
  if (!object(value)) return false;
  const fields: Record<string, string[]> = {
    detect: ["operation", "kind", "executable"],
    probe: ["operation", "binding", "modelId"],
    quota: ["operation", "binding"],
    run: ["operation", "binding", "taskId", "runEpoch", "requestId", "prompt", "developerInstructions", "attachments", "cwd", "workspaceMode", "modelId", "thinkingLevel", "serviceTier", "sessionId", "readOnly", "allowSubagents", "taskTools", "hasConnections", "memoryEnabled", "memoryMode", "projectId", "directoryId", "grantRevision", "timeoutMs", "mcpServers"],
    inspect: ["operation", "runId", "afterSequence", "compact", "ackReportIds"],
    diff: ["operation", "taskId", "filePath"],
    apply: ["operation", "taskId", "projectId", "directoryId", "grantRevision", "paths", "allowConflicts"],
    cancel: ["operation", "runId"],
    respond: ["operation", "runId", "permissionId", "choiceId"],
    close: ["operation", "runId", "discardStaged"],
  };
  const allowed = fields[String(value.operation)];
  if (!allowed || Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (value.operation === "detect") return EXTERNAL_AGENT_KINDS.includes(value.kind as ExternalAgentKind) && optionalString(value.executable);
  if (value.operation === "probe") return binding(value.binding) && optionalString(value.modelId, 512);
  if (value.operation === "quota") return binding(value.binding);
  if (value.operation === "diff") return id(value.taskId) && optionalString(value.filePath, 4096);
  if (value.operation === "apply") {
    return id(value.taskId) && id(value.projectId) && (value.directoryId === undefined || id(value.directoryId)) && (value.grantRevision === undefined || (Number.isSafeInteger(value.grantRevision) && Number(value.grantRevision) >= 1)) && (value.allowConflicts === undefined || typeof value.allowConflicts === "boolean") && (value.paths === undefined || (Array.isArray(value.paths) && value.paths.length <= 2000 && value.paths.every((p) => typeof p === "string" && p.length > 0 && p.length <= 4096 && !/[\x00]/.test(p))));
  }
  if (["inspect", "cancel", "close"].includes(String(value.operation))) {
    return id(value.runId) && (value.afterSequence === undefined || (Number.isSafeInteger(value.afterSequence) && Number(value.afterSequence) >= 0)) && (value.compact === undefined || typeof value.compact === "boolean") && (value.ackReportIds === undefined || (Array.isArray(value.ackReportIds) && value.ackReportIds.length <= 32 && value.ackReportIds.every((item) => id(item)))) && (value.discardStaged === undefined || typeof value.discardStaged === "boolean");
  }
  if (value.operation === "respond") return id(value.runId) && id(value.permissionId) && optionalString(value.choiceId, 200) && typeof value.choiceId === "string";
  if (value.operation !== "run" || !binding(value.binding) || !id(value.taskId) || !id(value.requestId) || !Number.isSafeInteger(value.runEpoch) || Number(value.runEpoch) < 0 || typeof value.prompt !== "string" || value.prompt.length > 256_000 || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) || value.cwd.length > 8192 || /[\x00-\x1f\x7f]/.test(value.cwd) || typeof value.readOnly !== "boolean" || typeof value.allowSubagents !== "boolean" || !Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1000 || Number(value.timeoutMs) > 86_400_000) {
    return false;
  }
  if (value.developerInstructions !== undefined && (typeof value.developerInstructions !== "string" || value.developerInstructions.length > EXTERNAL_DEVELOPER_INSTRUCTIONS_MAX_CHARS || value.developerInstructions.includes("\0"))) {
    return false;
  }
  if (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > EXTERNAL_INPUT_ATTACHMENTS_MAX_ITEMS || !value.attachments.every(validInputAttachment))) {
    return false;
  }
  if ((value.taskTools !== undefined && typeof value.taskTools !== "boolean") || (value.hasConnections !== undefined && typeof value.hasConnections !== "boolean") || (value.memoryEnabled !== undefined && typeof value.memoryEnabled !== "boolean")) return false;
  if (value.memoryMode !== undefined && value.memoryMode !== "hindsight" && value.memoryMode !== "builtin") return false;
  if (value.workspaceMode !== undefined && !["staged", "direct", "read_only"].includes(String(value.workspaceMode))) return false;
  if (!optionalString(value.modelId, 512) || !optionalString(value.thinkingLevel, 512) || !optionalString(value.serviceTier, 128) || !optionalString(value.sessionId, 512) || (value.projectId !== undefined && !id(value.projectId)) || (value.directoryId !== undefined && !id(value.directoryId)) || (value.grantRevision !== undefined && (!Number.isSafeInteger(value.grantRevision) || Number(value.grantRevision) < 1))) return false;
  // Only Env creates task-scoped MCP endpoints; arbitrary URLs/credentials are not accepted from control messages.
  return value.mcpServers === undefined || (Array.isArray(value.mcpServers) && value.mcpServers.length === 0);
}

export function isExternalAgentResponse(value: unknown): value is ExternalAgentResponse {
  if (!object(value)) return false;
  if (value.type === "detection") {
    const detection = value.detection;
    if (!object(detection) || !EXTERNAL_AGENT_KINDS.includes(detection.kind as ExternalAgentKind) || typeof detection.installed !== "boolean" || (detection.desktopAppInstalled !== undefined && typeof detection.desktopAppInstalled !== "boolean") || (detection.authenticated !== null && typeof detection.authenticated !== "boolean") || !Array.isArray(detection.models) || detection.models.length > 1000 || !optionalString(detection.executable) || !optionalString(detection.version, 200) || !optionalString(detection.error, 4000)) return false;
    const capabilities = detection.capabilities;
    if (!object(capabilities) || !["resume", "cancel", "models", "permissions", "collaboration"].every((key) => typeof capabilities[key] === "boolean") || !["native", "observed", "none"].includes(String(capabilities.terminalEvidence))) return false;
    return detection.models.every((model) => object(model) && typeof model.id === "string" && model.id.length > 0 && model.id.length <= 4096 && typeof model.name === "string" && model.name.length <= 4096 && (model.isDefault === undefined || typeof model.isDefault === "boolean") && (model.effortCapability === undefined || model.effortCapability === "unknown" || model.effortCapability === "unsupported" || model.effortCapability === "supported") && (model.defaultServiceTier === undefined || (typeof model.defaultServiceTier === "string" && model.defaultServiceTier.length > 0 && model.defaultServiceTier.length <= 128)) && (model.efforts === undefined || (Array.isArray(model.efforts) && model.efforts.length <= 32 && model.efforts.every((effort) => typeof effort === "string" && effort.length > 0 && effort.length <= 64))) && (model.serviceTiers === undefined || (Array.isArray(model.serviceTiers) && model.serviceTiers.length <= 32 && model.serviceTiers.every((tier) => object(tier) && typeof tier.id === "string" && tier.id.length > 0 && tier.id.length <= 64 && (tier.name === undefined || (typeof tier.name === "string" && tier.name.length <= 128)) && (tier.description === undefined || (typeof tier.description === "string" && tier.description.length <= 512))))));
  }
  if (value.type === "quota") {
    if (Object.keys(value).some((key) => key !== "type" && key !== "quota")) return false;
    return isValidQuotaProbeResult(value.quota);
  }
  if (value.type === "diff") {
    const d = value.diff;
    return object(d) && typeof d.diff === "string" && d.diff.length <= 256_000 && optionalString(d.filteredPath, 4096) && validDiffSummary(d);
  }
  if (value.type === "apply") {
    const applied = value.applied;
    return object(applied) && typeof applied.cleanedUp === "boolean" && ["appliedAdded", "appliedModified", "appliedDeleted"].every((key) => Array.isArray(applied[key]) && (applied[key] as unknown[]).length <= 5000 && (applied[key] as unknown[]).every((item) => typeof item === "string" && item.length > 0 && item.length <= 4096));
  }
  if (value.type !== "run" || !object(value.run)) return false;
  const run = value.run;
  if (!id(run.id) || !id(run.taskId) || !Number.isSafeInteger(run.runEpoch) || Number(run.runEpoch) < 0 || !EXTERNAL_AGENT_KINDS.includes(run.kind as ExternalAgentKind) || !["starting", "running", "waiting", "completed", "failed", "cancelled", "uncertain"].includes(String(run.state)) || typeof run.text !== "string" || run.text.length > 256_000 || !Array.isArray(run.events) || run.events.length > 401 || !Array.isArray(run.permissions) || run.permissions.length > 64 || !Number.isSafeInteger(run.nextSequence) || Number(run.nextSequence) < 1 || (run.quiescent !== undefined && typeof run.quiescent !== "boolean") || !optionalString(run.sessionId, 512) || !optionalString(run.stagedCwd, 8192) || !optionalString(run.scratchNotesDir, 8192) || (run.stagedDiff !== undefined && !validDiffSummary(run.stagedDiff)) || (run.uncertainReason !== undefined && !UNCERTAIN_REASONS.has(run.uncertainReason as ExternalAgentUncertainReason)) || (run.phase !== undefined && !WORKER_PHASES.has(run.phase as WorkerExecutionPhase)) || (run.touchedFiles !== undefined && !validPathList(run.touchedFiles, 25, 1024)) || (run.readOnlyViolation !== undefined && !validReadOnlyViolation(run.readOnlyViolation)) || (run.pendingReports !== undefined && (!Array.isArray(run.pendingReports) || run.pendingReports.length > 16 || !run.pendingReports.every(validPendingReport))) || (run.latestQuota !== undefined && !isValidQuotaProbeResult(run.latestQuota)) || (run.contextUsage !== undefined && !isValidExternalContextUsage(run.contextUsage)) || !optionalString(run.activeSessionMode, 128) || !optionalString(run.error, 4000)) return false;
  let previous = 0;
  for (const event of run.events) {
    if (!object(event) || !Number.isSafeInteger(event.sequence) || Number(event.sequence) <= previous || Number(event.sequence) >= Number(run.nextSequence) || !Number.isFinite(event.at) || !["message", "tool", "permission", "state", "error"].includes(String(event.type)) || typeof event.text !== "string" || event.text.length > 16_000) return false;
    previous = Number(event.sequence);
  }
  return run.permissions.every((permission) => object(permission) && id(permission.id) && typeof permission.title === "string" && permission.title.length <= 4000 && Array.isArray(permission.choices) && permission.choices.length > 0 && permission.choices.length <= 20 && permission.choices.every((choice) => object(choice) && typeof choice.id === "string" && choice.id.length > 0 && choice.id.length <= 200 && typeof choice.label === "string" && choice.label.length <= 500));
}

export function normalizeExternalImageMimeType(raw: string): ExternalImageMimeType | undefined {
  const cleaned = raw.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  const normalized = cleaned === "image/jpg" ? "image/jpeg" : cleaned;
  return INLINE_IMAGE_MIMES.has(normalized as ExternalImageMimeType) ? normalized as ExternalImageMimeType : undefined;
}

export function prependKuloInstructions(developerInstructions: string | undefined, prompt: string): string {
  const trimmed = developerInstructions?.trim();
  if (!trimmed) return prompt;
  return `<kulo_instructions>\n${trimmed}\n</kulo_instructions>\n\n${prompt}`;
}

export interface ResolvedExternalImage {
  name: string;
  mimeType: ExternalImageMimeType;
  path: string;
  size: number;
  base64?: string;
}

function isWithinDir(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function hasSymlinkUnderRoot(rawPath: string, expectedInputsDir: string): boolean {
  const resolvedRoot = path.resolve(expectedInputsDir);
  const resolvedTarget = path.resolve(rawPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  let cursor = resolvedRoot;
  for (const segment of rel.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Runtime-only attachment resolution for external drivers.
 * Checks lstatSync (rejecting symlinks) BEFORE canonicalExecutionPath containment, then opens a
 * controlled fd to verify regular file size and optional sha256 snapshot digest.
 */
export function resolveSafeExternalImages(options: {
  attachments?: readonly ExternalAgentInputAttachment[];
  expectedInputsDir?: string;
  overlapsProtected?: (canonicalPath: string) => boolean;
  maxCount: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  readBytes: boolean;
  onSkip?: (reason: string) => void;
}): ResolvedExternalImage[] {
  const { attachments, expectedInputsDir, overlapsProtected, maxCount, maxFileBytes, maxTotalBytes, readBytes, onSkip } = options;
  if (!attachments?.length || !expectedInputsDir || maxCount <= 0) return [];
  let canonicalRoot: string;
  try {
    if (!fs.existsSync(expectedInputsDir)) return [];
    canonicalRoot = canonicalExecutionPath(expectedInputsDir);
  } catch {
    return [];
  }

  const results: ResolvedExternalImage[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  for (const item of attachments) {
    const mimeType = normalizeExternalImageMimeType(item.mimeType);
    if (!mimeType) continue;
    if (results.length >= maxCount) {
      onSkip?.(`Skipped inline image "${item.name}": exceeds max inline image count (${maxCount}); path remains listed.`);
      continue;
    }
    const rawPath = item.path;
    if (!path.isAbsolute(rawPath) || /[\x00-\x1f\x7f]/.test(rawPath)) {
      onSkip?.(`Skipped inline image "${item.name}": invalid path.`);
      continue;
    }
    let rawStat: fs.Stats;
    try {
      rawStat = fs.lstatSync(rawPath);
    } catch {
      onSkip?.(`Skipped inline image "${item.name}": file unavailable on execution device.`);
      continue;
    }
    if (!rawStat.isFile() || rawStat.isSymbolicLink() || hasSymlinkUnderRoot(rawPath, expectedInputsDir)) {
      onSkip?.(`Skipped inline image "${item.name}": symlinks and non-regular files are not allowed.`);
      continue;
    }
    let canonical: string;
    try {
      canonical = canonicalExecutionPath(rawPath);
    } catch {
      onSkip?.(`Skipped inline image "${item.name}": path could not be resolved.`);
      continue;
    }
    if (!isWithinDir(canonical, canonicalRoot) || overlapsProtected?.(canonical)) {
      onSkip?.(`Skipped inline image "${item.name}": path lies outside authorized task inputs.`);
      continue;
    }
    if (seenPaths.has(canonical)) continue;
    let fd: number | undefined;
    try {
      fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size <= 0) {
        onSkip?.(`Skipped inline image "${item.name}": empty or non-regular file.`);
        continue;
      }
      if (item.size !== undefined && stat.size !== item.size) {
        onSkip?.(`Skipped inline image "${item.name}": size mismatch with dispatched snapshot.`);
        continue;
      }
      if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) {
        onSkip?.(`Skipped inline image "${item.name}": exceeds inline byte budget; path remains listed.`);
        continue;
      }
      let base64: string | undefined;
      if (readBytes || item.sha256) {
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < stat.size) {
          const n = fs.readSync(fd, buffer, offset, stat.size - offset, offset);
          if (n <= 0) break;
          offset += n;
        }
        const bytes = offset === stat.size ? buffer : buffer.subarray(0, offset);
        if (bytes.byteLength !== stat.size) {
          onSkip?.(`Skipped inline image "${item.name}": truncated read.`);
          continue;
        }
        if (item.sha256) {
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (digest !== item.sha256) {
            onSkip?.(`Skipped inline image "${item.name}": digest mismatch with dispatched snapshot.`);
            continue;
          }
        }
        if (readBytes) base64 = bytes.toString("base64");
      }
      seenPaths.add(canonical);
      totalBytes += stat.size;
      results.push({
        name: item.name,
        mimeType,
        path: canonical,
        size: stat.size,
        ...(base64 !== undefined ? { base64 } : {}),
      });
    } catch {
      onSkip?.(`Skipped inline image "${item.name}": unreadable snapshot.`);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  return results;
}
