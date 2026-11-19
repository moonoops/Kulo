export interface ProjectRecord {
  id: string;
  name: string;
  deviceId: string;
  workspaceDir: string;
  directoryId: string;
  revision: number;
  grantRevision: number;
  notes: string;
  scratchRoot?: string;
  platform?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  deletionId?: string;
}

export interface ProjectView extends ProjectRecord {
  availability: "ready" | "offline" | "unavailable";
  deviceName: string;
  error?: string;
}

export interface CreateProjectInput {
  commandId: string;
  name: string;
  deviceId: string;
  workspaceDir: string;
  createDirectory?: boolean;
}

export interface ProjectDirectoryEntry {
  name: string;
  path: string;
}

export interface ProjectDirectoryListing {
  deviceId: string;
  path: string;
  parentPath: string | null;
  entries: ProjectDirectoryEntry[];
}

export interface ProjectDirectoryGrant {
  projectId: string;
  workspaceDir: string;
  directoryId: string;
  revision: number;
  scratchRoot?: string;
  platform?: string;
}

export interface TicketWait {
  reason: "user" | "env" | "time" | "external" | "project" | "connection";
  since: number;
  until?: number;
  detail?: string;
  externalJobIds?: string[];
  waitToken?: string;
}

export interface StagedWorkspacePrepareResult {
  stagedCwd: string;
  reused: boolean;
  warnings?: string[];
}

export type ProjectEnvRequest =
  | { action: "list"; path?: string }
  | { action: "authorize"; projectId: string; path: string; create?: boolean; operationId: string; revision?: number }
  | { action: "revoke"; projectId: string }
  | { action: "cleanup"; workspaceDir: string; scratchDir?: string }
  | { action: "staged_prepare"; taskId: string; projectId: string; sourceDir: string; directoryId?: string; grantRevision?: number; fresh?: boolean }
  | { action: "staged_diff"; taskId: string; filePath?: string }
  | { action: "staged_apply"; taskId: string; projectId: string; directoryId?: string; grantRevision?: number; paths?: string[]; allowConflicts?: boolean; expectedDigest?: string }
  | { action: "staged_discard"; taskId: string; projectId?: string };
