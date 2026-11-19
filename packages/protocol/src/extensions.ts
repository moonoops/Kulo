export type ExtensionOperation = "install" | "enable" | "stop" | "remove";
export type ExtensionStatus = "not_installed" | "installing" | "stopped" | "starting" | "running" | "stopping" | "removing" | "error";
export type ExtensionJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ExtensionRecord {
  id: string;
  name: string;
  sourceUrl: string;
  packageName?: string;
  availableVersion: string;
  installedVersion?: string;
  adapterVersion: string;
  enabled: boolean;
  status: ExtensionStatus;
  revision: number;
  error?: string;
  updatedAt: number;
}

export interface ExtensionJob {
  id: string;
  clientId: string;
  extensionId: string;
  operation: ExtensionOperation;
  status: ExtensionJobStatus;
  stage: string;
  taskId?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExtensionWorkspaceSnapshot {
  revision: number;
  items: ExtensionRecord[];
  jobs: ExtensionJob[];
}

export interface ExtensionOperationRequest {
  id: string;
  operation: ExtensionOperation;
  expectedRevision: number;
  commandId: string;
  clientId?: string;
}
