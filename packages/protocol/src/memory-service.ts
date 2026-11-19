import type { HindsightProbeResult, KuloSettingsView, PublicMemoryConfig } from "./domain.js";

export type HindsightAccessMode = "kulo" | "scoped" | "private-only";
export type HindsightModelProvider = "openai" | "anthropic" | "gemini" | "groq" | "ollama";

export interface HindsightServiceModel {
  provider: HindsightModelProvider;
  model: string;
  baseUrl?: string;
  /** Optional Kulo API connection; OAuth credentials are not exported. */
  connectionId?: string;
}

export type MemoryServiceOperation = "deploy" | "configure" | "connect" | "disconnect" | "uninstall" | "check";
export type MemoryServiceJobStatus = "awaiting-input" | "awaiting-confirmation" | "running" | "succeeded" | "failed" | "rejected";
export type MemoryServiceSecretField = "modelApiKey" | "routerApiKey" | "workerApiKey" | "sharedReadApiKey";

export interface MemoryServiceConnection {
  endpoint: string;
  endpoints?: string[];
  accessMode: HindsightAccessMode;
  banks: { private: string; shared: string };
}

export interface MemoryConnectionUpdateRequest {
  expectedRevision: number;
  enabled: boolean;
  connection: MemoryServiceConnection;
  routerApiKey?: string;
  workerApiKey?: string;
  sharedReadApiKey?: string;
  clearRouterApiKey?: boolean;
  clearWorkerApiKey?: boolean;
  clearSharedReadApiKey?: boolean;
  caCertPem?: string;
}

export interface MemoryConnectionUpdateResult {
  settings: KuloSettingsView;
  service: MemoryServiceSnapshot;
  probe?: HindsightProbeResult;
}

export interface MemoryServicePrepareRequest {
  commandId: string;
  clientId: string;
  expectedRevision: number;
  operation: MemoryServiceOperation;
  model?: HindsightServiceModel;
  connection?: MemoryServiceConnection;
  deleteData?: boolean;
}

export interface MemoryServiceJob {
  id: string;
  clientId: string;
  operation: MemoryServiceOperation;
  status: MemoryServiceJobStatus;
  stage: string;
  title: string;
  changes: string[];
  deviceName: string;
  createdAt: number;
  updatedAt: number;
  model?: HindsightServiceModel;
  connection?: MemoryServiceConnection;
  deleteData?: boolean;
  error?: string;
  probe?: HindsightProbeResult;
}

export interface MemoryServiceSecretInput {
  id: string;
  jobId: string;
  clientId: string;
  field: MemoryServiceSecretField;
  label: string;
  status: "pending" | "completed" | "cancelled" | "expired";
  expiresAt: number;
}

export interface MemoryServiceSnapshot {
  revision: number;
  deviceName: string;
  platform: string;
  installed: boolean;
  running: boolean;
  endpoint?: string;
  version?: string;
  model?: HindsightServiceModel;
  dataDirectory?: string;
  phase?: string;
  connection: PublicMemoryConfig;
  jobs: MemoryServiceJob[];
  inputs: MemoryServiceSecretInput[];
}
