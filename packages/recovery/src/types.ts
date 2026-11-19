export type {
  RecoveryReleaseKind, RecoveryFileEntry, RecoveryReleaseManifest, RecoveryReleaseIdentity,
  RecoveryManifestOptions, RecoveryReleaseRecord, RecoveryLaunch,
  RecoverySession, RecoveryTransaction, RecoveryInspection,
} from "@moco/protocol";

export interface RecoveryManagerOptions {
  shellVersion?: string;
  protocolVersion?: number;
  dataVersion?: number;
  nodeMajor?: number;
  platform?: string;
  arch?: string;
  now?: () => number;
  maxStorageBytes?: number;
  /** Injectable only for isolated tests; production uses OS process liveness. */
  isProcessAlive?: (pid: number) => boolean;
}
