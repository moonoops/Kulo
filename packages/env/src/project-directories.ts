import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { ProjectDirectoryGrant, ProjectDirectoryListing } from "@moco/protocol";
import { canonicalExecutionPath, defaultProtectedPaths, isApplicationPrivatePath } from "./isolation.js";

interface StoredGrant extends ProjectDirectoryGrant {
  operationId: string;
  revoked?: boolean;
}

interface GrantState {
  version: 1;
  grants: Record<string, StoredGrant>;
  operations: Record<string, ProjectDirectoryGrant>;
}

export interface AuthorizeDirectoryInput {
  projectId: string;
  path: string;
  create?: boolean;
  operationId: string;
  revision?: number;
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_.-]{1,200}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw new Error(`Invalid ${label}`);
}

class ProtectedDirectoryError extends Error {}

export class ProjectDirectoryUnavailableError extends Error {
  readonly code = "project_directory_unavailable";
}

function directoryOperation<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new ProjectDirectoryUnavailableError(error instanceof Error ? error.message : "Project directory is unavailable on the selected device");
    }
    throw error;
  }
}

function absoluteDirectory(value: string): string {
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value)) {
    throw new Error("Project directory must be an absolute path on the selected device");
  }
  return directoryOperation(() => canonicalExecutionPath(value));
}

function directoryIdentity(directory: string): string {
  const stat = directoryOperation(() => fs.statSync(directory, { bigint: true }));
  if (!stat.isDirectory()) throw new ProjectDirectoryUnavailableError("Project path is not a directory");
  return createHash("sha256").update(`${process.platform}:${stat.dev}:${stat.ino}:${process.platform === "win32" ? directory.toLowerCase() : directory}`).digest("hex");
}

/** Only the authenticated Env control plane can create grants; Worker RPC never writes this registry. */
export class ProjectDirectoryRegistry {
  readonly filePath: string;
  readonly #deviceId: string;
  readonly #getProtectedPaths: () => readonly string[];
  readonly scratchRoot: string;
  readonly privateDirectory: string;
  #state: GrantState;

  constructor(options: { deviceId: string; filePath: string; scratchRoot: string; getProtectedPaths?: () => readonly string[] }) {
    this.filePath = path.resolve(options.filePath);
    this.privateDirectory = path.dirname(this.filePath);
    this.#deviceId = options.deviceId;
    this.scratchRoot = canonicalExecutionPath(options.scratchRoot);
    if (isApplicationPrivatePath(this.privateDirectory) || isApplicationPrivatePath(this.scratchRoot)) {
      throw new ProtectedDirectoryError("Env control and scratch directories overlap protected application data");
    }
    this.#getProtectedPaths = options.getProtectedPaths ?? (() => []);
    this.#state = { version: 1, grants: {}, operations: {} };
    if (fs.existsSync(this.filePath)) {
      const state = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as GrantState;
      if (state.version !== 1 || !state.grants || !state.operations || Array.isArray(state.grants) || Array.isArray(state.operations)) {
        throw new Error("Invalid project directory grant registry");
      }
      for (const grant of Object.values(state.grants)) {
        validIdentifier(grant.projectId, "project ID");
        if (typeof grant.workspaceDir !== "string" || !path.isAbsolute(grant.workspaceDir) || !Number.isSafeInteger(grant.revision) || grant.revision < 1) {
          throw new Error("Invalid persisted project directory grant");
        }
      }
      this.#state = state;
    }
  }

  protectedPaths(): string[] {
    return [...defaultProtectedPaths(), this.privateDirectory, ...this.#getProtectedPaths()].map(canonicalExecutionPath);
  }

  #assertAllowed(directory: string, granting: boolean): void {
    if (granting && (directory === path.parse(directory).root || directory === canonicalExecutionPath(os.homedir()))) {
      throw new Error("Select a project directory, not the filesystem or home root");
    }
    if (isApplicationPrivatePath(directory)) throw new ProtectedDirectoryError("Project directory overlaps protected application data");
    const managedRoot = path.dirname(this.scratchRoot);
    if (this.protectedPaths().some((entry) => within(directory, entry) && !(entry !== managedRoot && within(managedRoot, entry) && within(directory, managedRoot)))) {
      throw new ProtectedDirectoryError("Project directory overlaps protected device data");
    }
  }

  list(directory?: string): ProjectDirectoryListing {
    const current = absoluteDirectory(directory ?? os.homedir());
    this.#assertAllowed(current, false);
    if (!fs.statSync(current).isDirectory()) throw new Error("Selected path is not a directory");
    const entries: ProjectDirectoryListing["entries"] = [];
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      try {
        const actual = absoluteDirectory(candidate);
        this.#assertAllowed(actual, false);
        if (fs.statSync(actual).isDirectory()) entries.push({ name: entry.name, path: candidate });
      } catch (error) {
        if (error instanceof ProtectedDirectoryError || error instanceof ProjectDirectoryUnavailableError) continue;
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !["EACCES", "EPERM", "ENOENT", "ELOOP"].includes(code)) throw error;
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(current);
    return { deviceId: this.#deviceId, path: current, parentPath: parent === current ? null : parent, entries };
  }

  authorize(input: AuthorizeDirectoryInput): ProjectDirectoryGrant {
    validIdentifier(input.projectId, "project ID");
    validIdentifier(input.operationId, "operation ID");
    const directory = absoluteDirectory(input.path);
    this.#assertAllowed(directory, true);
    const receipt = this.#state.operations[input.operationId];
    if (receipt) {
      const current = this.#state.grants[input.projectId];
      if (receipt.projectId !== input.projectId || receipt.workspaceDir !== directory || current?.revoked || current?.revision !== receipt.revision) {
        throw new Error("Project authorization operation is stale or belongs to another directory");
      }
      this.validate(input.projectId, directory, receipt.revision);
      return { ...receipt };
    }
    if (!fs.existsSync(directory)) {
      if (!input.create) throw new ProjectDirectoryUnavailableError("Project directory does not exist on the selected device");
      directoryOperation(() => fs.mkdirSync(directory, { recursive: true }));
    }
    const actual = directoryOperation(() => fs.realpathSync(directory));
    this.#assertAllowed(actual, true);
    const directoryId = directoryIdentity(actual);
    for (const grant of Object.values(this.#state.grants)) {
      if (!grant.revoked && grant.projectId !== input.projectId && (grant.directoryId === directoryId || grant.workspaceDir === actual)) {
        throw new Error("This directory is already associated with another project");
      }
    }
    const previous = this.#state.grants[input.projectId];
    const revision = input.revision ?? (previous?.revision ?? 0) + 1;
    if (previous && !previous.revoked && revision === previous.revision && previous.workspaceDir === actual && previous.directoryId !== directoryId) {
      throw new ProjectDirectoryUnavailableError("Project directory identity changed; authorize it again");
    }
    if (previous && !previous.revoked && revision === previous.revision && previous.workspaceDir === actual && previous.directoryId === directoryId) {
      const grant: ProjectDirectoryGrant = { projectId: input.projectId, workspaceDir: actual, directoryId, revision, scratchRoot: this.scratchRoot, platform: process.platform };
      const previousState = structuredClone(this.#state);
      this.#state.operations[input.operationId] = grant;
      try { this.#save(); } catch (error) { this.#state = previousState; throw error; }
      return grant;
    }
    if (!Number.isSafeInteger(revision) || revision < 1 || (previous && revision <= previous.revision)) {
      throw new Error("Project directory grant revision must increase");
    }
    const grant: ProjectDirectoryGrant = { projectId: input.projectId, workspaceDir: actual, directoryId, revision, scratchRoot: this.scratchRoot, platform: process.platform };
    const previousState = structuredClone(this.#state);
    this.#state.grants[input.projectId] = { ...grant, operationId: input.operationId };
    this.#state.operations[input.operationId] = grant;
    try { this.#save(); } catch (error) { this.#state = previousState; throw error; }
    return { ...grant };
  }

  validate(projectId: string, cwd: string, revision?: number): ProjectDirectoryGrant {
    const grant = this.#state.grants[projectId];
    if (!grant || grant.revoked) throw new Error("Project directory has not been authorized or was revoked");
    if (revision !== undefined && grant.revision !== revision) throw new Error("Project directory grant is stale");
    const actual = absoluteDirectory(cwd);
    this.#assertAllowed(actual, true);
    if (!within(actual, grant.workspaceDir)) throw new Error("Project execution scope changed; authorize it again");
    if (directoryIdentity(grant.workspaceDir) !== grant.directoryId) throw new ProjectDirectoryUnavailableError("Project directory identity changed; authorize it again");
    return { projectId, workspaceDir: grant.workspaceDir, directoryId: grant.directoryId, revision: grant.revision, scratchRoot: this.scratchRoot, platform: process.platform };
  }

  validateScratch(directory: string): void {
    const actual = absoluteDirectory(directory);
    if (isApplicationPrivatePath(actual)) throw new ProtectedDirectoryError("Worker scratch overlaps protected application data");
    if (!within(actual, this.scratchRoot)) throw new Error("Worker scratch path is outside this Env's managed scratch directory");
  }

  assertUnregistered(directory: string): void {
    const actual = absoluteDirectory(directory);
    if (Object.values(this.#state.grants).some((grant) => !grant.revoked && (within(actual, grant.workspaceDir) || within(grant.workspaceDir, actual)))) {
      throw new Error("A registered project directory requires its explicit project authorization");
    }
  }

  revoke(projectId: string): void {
    validIdentifier(projectId, "project ID");
    const grant = this.#state.grants[projectId];
    if (grant && !grant.revoked) {
      const previousState = structuredClone(this.#state);
      grant.revoked = true;
      try { this.#save(); } catch (error) { this.#state = previousState; throw error; }
    }
  }

  #save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.#state), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
