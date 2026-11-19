export type ConnectionKind = "ssh" | "account" | "api-key" | "custom" | "app";
export type ConnectionCategory = "app" | "credential" | "information";
export type ConnectionApplicationId = "messages" | "mail" | "github" | "figma";
export type ConnectionAuthType = "bearer" | "basic" | "header";
export interface ConnectionSecrets {
  [key: string]: string | undefined;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  apiKey?: string;
}
/** Credential values live only in the vault; cards and model tools carry their field definitions. */
export interface ConnectionCredentialField {
  key: string;
  label: string;
}
export interface ConnectionFields {
  name: string;
  kind: ConnectionKind;
  category?: ConnectionCategory;
  appId?: ConnectionApplicationId;
  host?: string;
  port?: number;
  username?: string;
  url?: string;
  authType?: ConnectionAuthType;
  headerName?: string;
  typeLabel?: string;
  instructions?: string;
  credentialFields?: ConnectionCredentialField[];
}
export interface ConnectionRecordView extends ConnectionFields {
  id: string;
  revision: number;
  status: "saved" | "verified" | "error" | "incomplete";
  hasCredential: boolean;
  secretFields: string[];
  error?: string;
  hostFingerprint?: string;
  createdAt: number;
  updatedAt: number;
  source?: "form" | "chat";
  canReadInformation?: boolean;
}
export interface ConnectionSaveRequest extends ConnectionFields {
  id?: string;
  expectedRevision?: number;
  secrets?: ConnectionSecrets;
}
export interface ConnectionPrepareRequest extends Partial<ConnectionFields> {
  clientId: string;
  connectionId?: string;
}
export interface ConnectionDescribeRequest {
  id: string;
  expectedRevision: number;
  category?: ConnectionCategory;
  name?: string;
  typeLabel?: string;
  instructions?: string;
  credentialFields?: ConnectionCredentialField[];
}
export interface ConnectionSetupInput extends Partial<ConnectionFields> {
  id: string;
  clientId: string;
  connectionId?: string;
  expectedRevision?: number;
  status: "pending" | "completed" | "cancelled";
  createdAt: number;
}
export interface ConnectionAccessRequest {
  id: string;
  ticketId: string;
  conversationId: number;
  runEpoch: number;
  connectionId: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "revoked";
  createdAt: number;
  updatedAt: number;
}
export interface ConnectionWorkspaceSnapshot {
  connections: ConnectionRecordView[];
  inputs: ConnectionSetupInput[];
  requests: ConnectionAccessRequest[];
  vault: { available: boolean; error?: string };
  applications?: ConnectionApplicationView[];
}
export interface ConnectionApplicationDefinition {
  id: ConnectionApplicationId;
  name: string;
  description: string;
  authentication: "macos" | "token";
  instructions: string[];
  helpUrl?: string;
  actions: Array<{ id: string; label: string; readOnly: boolean; parameters?: string }>;
}
export interface ConnectionApplicationView extends ConnectionApplicationDefinition {
  status: "connected" | "disconnected" | "needs_attention" | "unavailable";
  connectionId?: string;
  error?: string;
}
export type ConnectionUseOperation =
  | { kind: "ssh"; command: string; timeoutMs?: number }
  | { kind: "http"; path: string; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"; body?: string; headers?: Record<string, string> }
  | { kind: "app"; action: string; params?: Record<string, unknown> }
  | { kind: "information"; action: "read" };
export interface ConnectionUseResult {
  kind: "ssh" | "http" | "app" | "information";
  output: string;
  exitCode?: number;
  status?: number;
}
