import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  redactSensitiveText,
  type StagedWorkspaceApplyResult,
  type StagedWorkspaceDiffDetail,
  type StagedWorkspacePrepareResult,
} from "@moco/protocol";
import { canonicalExecutionPath } from "./isolation.js";
import type { ProjectDirectoryRegistry } from "./project-directories.js";
import {
  applyStagedChanges,
  cloneStagedWorkspace,
  computeStagedDiff,
  type WorkspaceManifest,
} from "./staged-workspace.js";

interface StoredBuiltInStagedTask {
  version: 1;
  taskId: string;
  projectId: string;
  sourceDir: string;
  stagedDir: string;
  baseline: WorkspaceManifest;
  createdAt: number;
  appliedAt?: number;
  discardedAt?: number;
}

export interface StagedWorkspaceServiceOptions {
  projectRegistry: ProjectDirectoryRegistry;
  rootDir?: string;
  redact?: (value: string) => string;
  maxNonCowBytes?: number;
  maxNonCowFiles?: number;
  forceNonCow?: boolean;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function assertValidTaskId(taskId: string): string {
  if (
    typeof taskId !== "string" ||
    !/^[A-Za-z0-9:_.-]{1,200}$/.test(taskId) ||
    ["__proto__", "constructor", "prototype"].includes(taskId)
  ) {
    throw new Error("Invalid staged workspace task ID");
  }
  return taskId;
}

function within(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export class StagedWorkspaceService {
  readonly rootDir: string;
  readonly #options: StagedWorkspaceServiceOptions;
  readonly #records = new Map<string, StoredBuiltInStagedTask>();
  #loaded = false;

  constructor(options: StagedWorkspaceServiceOptions) {
    this.#options = options;
    this.rootDir = options.rootDir ?? path.join(options.projectRegistry.privateDirectory, "staged-workspaces");
  }

  #redact(value: string): string {
    const custom = this.#options.redact ? this.#options.redact(value) : value;
    return redactSensitiveText(custom);
  }

  #ensureLoaded(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!fs.existsSync(this.rootDir)) return;
    for (const file of fs.readdirSync(this.rootDir)) {
      if (!file.startsWith("staged-") || !file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(this.rootDir, file), "utf8"),
        ) as StoredBuiltInStagedTask;
        if (
          parsed?.version === 1 &&
          typeof parsed.taskId === "string" &&
          typeof parsed.projectId === "string" &&
          typeof parsed.sourceDir === "string" &&
          typeof parsed.stagedDir === "string" &&
          parsed.baseline &&
          typeof parsed.baseline === "object"
        ) {
          this.#records.set(parsed.taskId, parsed);
        }
      } catch {
        // Ignore corrupted stale record files
      }
    }
  }

  #persist(record: StoredBuiltInStagedTask): void {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.rootDir, `staged-${hash(record.taskId)}.json`);
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  prepare(input: {
    taskId: string;
    projectId: string;
    sourceDir: string;
    directoryId?: string;
    grantRevision?: number;
    fresh?: boolean;
  }): StagedWorkspacePrepareResult {
    this.#ensureLoaded();
    const taskId = assertValidTaskId(input.taskId);
    const grant = this.#options.projectRegistry.validate(
      input.projectId,
      input.sourceDir,
      input.grantRevision,
    );
    if (input.directoryId && grant.directoryId !== input.directoryId) {
      throw new Error("Project directory identity changed before staged workspace preparation");
    }

    const safeSegment = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    const stagedDir = path.join(this.#options.projectRegistry.scratchRoot, "staged", safeSegment);
    const prior = this.#records.get(taskId);
    if (
      !input.fresh &&
      prior &&
      !prior.appliedAt &&
      !prior.discardedAt &&
      prior.projectId === input.projectId &&
      prior.sourceDir === grant.workspaceDir &&
      fs.existsSync(prior.stagedDir)
    ) {
      this.#options.projectRegistry.validateScratch(prior.stagedDir);
      return {
        stagedCwd: canonicalExecutionPath(prior.stagedDir),
        reused: true,
      };
    }

    const warnings: string[] = [];
    const baseline = cloneStagedWorkspace(grant.workspaceDir, stagedDir, {
      onWarning: (message) => warnings.push(message),
      maxNonCowBytes: this.#options.maxNonCowBytes,
      maxNonCowFiles: this.#options.maxNonCowFiles,
      forceNonCow: this.#options.forceNonCow,
    });
    this.#options.projectRegistry.validateScratch(stagedDir);
    const canonicalStagedDir = canonicalExecutionPath(stagedDir);
    const record: StoredBuiltInStagedTask = {
      version: 1,
      taskId,
      projectId: input.projectId,
      sourceDir: grant.workspaceDir,
      stagedDir: canonicalStagedDir,
      baseline,
      createdAt: Date.now(),
    };
    this.#records.set(taskId, record);
    this.#persist(record);
    return {
      stagedCwd: canonicalStagedDir,
      reused: false,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  validateStagedCwd(
    taskId: string,
    projectId: string,
    candidateCwd: string,
    grantRevision?: number,
  ): { stagedDir: string; sourceDir: string } {
    this.#ensureLoaded();
    assertValidTaskId(taskId);
    const record = this.#records.get(taskId);
    if (!record || record.projectId !== projectId || record.appliedAt || record.discardedAt) {
      throw new Error("Staged workspace for this task is missing, applied, or discarded");
    }
    const grant = this.#options.projectRegistry.validate(projectId, record.sourceDir, grantRevision);
    if (grant.workspaceDir !== record.sourceDir) {
      throw new Error("Project workspace binding changed; staged copy is stale");
    }
    this.#options.projectRegistry.validateScratch(record.stagedDir);
    if (!fs.existsSync(record.stagedDir)) {
      throw new Error("Staged workspace directory is no longer available on disk");
    }
    const canonicalStaged = canonicalExecutionPath(record.stagedDir);
    const canonicalCandidate = canonicalExecutionPath(candidateCwd);
    if (!within(canonicalCandidate, canonicalStaged)) {
      throw new Error("Worker execution path is outside the task's authorized staged workspace");
    }
    return { stagedDir: canonicalStaged, sourceDir: record.sourceDir };
  }

  diff(taskId: string, filePath?: string): StagedWorkspaceDiffDetail {
    this.#ensureLoaded();
    assertValidTaskId(taskId);
    const record = this.#records.get(taskId);
    if (!record) throw new Error("No staged workspace is recorded for this task");
    if (record.appliedAt) throw new Error("Staged workspace changes were already merged");
    if (record.discardedAt) throw new Error("Staged workspace was already discarded");
    if (!fs.existsSync(record.stagedDir)) {
      throw new Error("Staged workspace directory is no longer available");
    }
    const detail = computeStagedDiff({
      sourceDir: record.sourceDir,
      stagedDir: record.stagedDir,
      baseline: record.baseline,
      filePath,
      maxPreviewBytes: filePath ? 128 * 1024 : 24 * 1024,
    });
    return {
      ...detail,
      unifiedPreview: this.#redact(detail.unifiedPreview).slice(0, 24 * 1024),
      diff: this.#redact(detail.diff).slice(0, 128 * 1024),
    };
  }

  apply(input: {
    taskId: string;
    projectId: string;
    directoryId?: string;
    grantRevision?: number;
    paths?: string[];
    allowConflicts?: boolean;
  }): StagedWorkspaceApplyResult {
    this.#ensureLoaded();
    assertValidTaskId(input.taskId);
    const record = this.#records.get(input.taskId);
    if (!record || record.projectId !== input.projectId) {
      throw new Error("No staged workspace is recorded for this task");
    }
    if (record.appliedAt) {
      return { appliedAdded: [], appliedModified: [], appliedDeleted: [], cleanedUp: true };
    }
    if (record.discardedAt) {
      throw new Error("Staged workspace was already discarded");
    }
    const grant = this.#options.projectRegistry.validate(
      input.projectId,
      record.sourceDir,
      input.grantRevision,
    );
    if (input.directoryId && grant.directoryId !== input.directoryId) {
      throw new Error("Project directory identity changed before staged merge");
    }
    if (!fs.existsSync(record.stagedDir)) {
      throw new Error("Staged workspace directory is no longer available");
    }
    const applied = applyStagedChanges({
      sourceDir: record.sourceDir,
      stagedDir: record.stagedDir,
      baseline: record.baseline,
      paths: input.paths,
      allowConflicts: input.allowConflicts,
    });
    if (applied.cleanedUp) {
      record.appliedAt = Date.now();
    }
    this.#persist(record);
    return applied;
  }

  discard(taskId: string, projectId?: string): { discarded: boolean } {
    this.#ensureLoaded();
    assertValidTaskId(taskId);
    const record = this.#records.get(taskId);
    if (!record) return { discarded: false };
    if (projectId && record.projectId !== projectId) {
      throw new Error("Staged workspace belongs to another project");
    }
    if (fs.existsSync(record.stagedDir)) {
      this.#options.projectRegistry.validateScratch(record.stagedDir);
      fs.rmSync(record.stagedDir, { recursive: true, force: true });
    }
    record.discardedAt = Date.now();
    this.#persist(record);
    return { discarded: true };
  }

  discardProject(projectId: string): void {
    this.#ensureLoaded();
    for (const record of this.#records.values()) {
      if (record.projectId !== projectId || record.appliedAt || record.discardedAt) continue;
      try {
        if (fs.existsSync(record.stagedDir)) {
          this.#options.projectRegistry.validateScratch(record.stagedDir);
          fs.rmSync(record.stagedDir, { recursive: true, force: true });
        }
        record.discardedAt = Date.now();
        this.#persist(record);
      } catch {
        // Best-effort cleanup during project revocation
      }
    }
  }
}
