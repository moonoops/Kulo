export type ConnectionKind = "ssh" | "account" | "api-key" | "custom" | "app" | "mcp";
export type ConnectionCategory = "app" | "credential" | "information";
export type ConnectionApplicationId = "messages" | "mail" | "github" | "figma";
export type ConnectionAuthType = "bearer" | "basic" | "header";
export type McpTransportKind = "http" | "stdio";
export type McpAuthMode = "oauth" | "bearer" | "header" | "none";
export type McpPresetCategory = "productivity" | "engineering" | "design" | "cloud" | "docs";
export interface McpToolSummary {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean;
  destructive?: boolean;
}
export interface McpPresetDefinition {
  id: string;
  name: string;
  description: string;
  transport: "http";
  url: string;
  authMode: McpAuthMode;
  supportedAuthModes: readonly McpAuthMode[];
  requiresClientId?: boolean;
  headerName?: string;
  helpUrl?: string;
  category: McpPresetCategory;
}
export type McpOAuthSessionStatus = "pending" | "authorized" | "completed" | "failed" | "cancelled";
export interface McpOAuthSessionView {
  sessionId: string;
  connectionId: string;
  status: McpOAuthSessionStatus;
  authorizationUrl?: string;
  redirectUrl?: string;
  expiresAt: number;
  error?: string;
  connection?: ConnectionRecordView;
}
export interface ConnectionSecrets {
  [key: string]: string | undefined;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  apiKey?: string;
  clientSecret?: string;
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
  mcpTransport?: McpTransportKind;
  mcpPresetId?: string;
  mcpAuthMode?: McpAuthMode;
  mcpOAuthClientId?: string;
  mcpOAuthScope?: string;
  mcpOAuthCallbackPort?: number;
  mcpCommand?: string;
  mcpArgs?: string[];
  mcpCwd?: string;
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
  mcpTools?: McpToolSummary[];
  mcpToolsUpdatedAt?: number;
  mcpServerName?: string;
  mcpOAuthAuthorized?: boolean;
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
  mcpPresets?: McpPresetDefinition[];
  localHost?: boolean;
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
  | { kind: "information"; action: "read" }
  | { kind: "mcp"; action: "list_tools"; query?: string; refresh?: boolean; limit?: number }
  | { kind: "mcp"; action: "call_tool"; tool: string; arguments?: Record<string, unknown> };
export interface ConnectionUseResult {
  kind: "ssh" | "http" | "app" | "information" | "mcp";
  output: string;
  exitCode?: number;
  status?: number;
}
