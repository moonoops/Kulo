export type RecoveryReleaseKind = "official" | "custom";

export interface RecoveryFileEntry {
  path: string;
  kind: "file" | "symlink";
  size: number;
  sha256: string;
  executable?: boolean;
  target?: string;
}

export interface RecoveryReleaseManifest {
  formatVersion: 1;
  id: string;
  version: string;
  kind: RecoveryReleaseKind;
  sourceCommit?: string;
  sourceTreeHash?: string;
  baseReleaseId?: string;
  customizationRevision?: string;
  platform: string;
  arch: string;
  nodeMajor: number;
  shellVersion: string;
  protocolVersion: number;
  dataVersion: number;
  minDataVersion: number;
  maxDataVersion: number;
  runtimeEntry: string;
  webDir: string;
  files: RecoveryFileEntry[];
  artifactHash: string;
  /** Host-produced evidence; this field never authorizes running a manifest script. */
  checks: string[];
}

export interface RecoveryManifestOptions {
  version: string;
  kind: RecoveryReleaseKind;
  sourceCommit?: string;
  sourceTreeHash?: string;
  baseReleaseId?: string;
  customizationRevision?: string;
  platform?: string;
  arch?: string;
  nodeMajor?: number;
  shellVersion?: string;
  protocolVersion?: number;
  dataVersion?: number;
  minDataVersion?: number;
  maxDataVersion?: number;
  runtimeEntry?: string;
  webDir?: string;
  checks?: string[];
}

export interface RecoveryReleaseIdentity extends Omit<RecoveryReleaseManifest, "files"> {
  entryFiles: RecoveryFileEntry[];
  inventoryHash: string;
  fileCount: number;
  totalBytes: number;
}

export interface RecoveryReleaseRecord {
  id: string;
  root: string;
  manifest: RecoveryReleaseIdentity;
  managed: boolean;
  registeredAt: number;
  status: "baseline" | "staged" | "ready" | "failed";
  bytes: number;
  startupInterruptions?: number;
}

export interface RecoveryLaunch {
  attemptId: string;
  releaseId: string;
  root: string;
  manifest: RecoveryReleaseIdentity;
  previousReleaseId?: string;
  recovered: boolean;
}

export interface RecoverySession {
  attemptId: string;
  releaseId: string;
  pid: number;
  childPids: number[];
  startedAt: number;
  readyAt?: number;
}

export interface RecoveryTransaction {
  id: string;
  from?: string;
  target: string;
  phase: "prepared" | "activating" | "committed" | "reverted";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface RecoveryInspection {
  formatVersion: 1;
  initialized: boolean;
  current: RecoveryReleaseRecord | null;
  pending: RecoveryReleaseRecord | null;
  baseline: RecoveryReleaseRecord | null;
  history: RecoveryReleaseRecord[];
  releases: RecoveryReleaseRecord[];
  session: RecoverySession | null;
  transaction: RecoveryTransaction | null;
  warnings: string[];
  protectedReleaseIds: string[];
  storage: { managedBytes: number; budgetBytes: number };
}
