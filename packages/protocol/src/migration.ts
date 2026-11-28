import type { SkillAudience } from "./capabilities.js";
import type { McpAuthMode } from "./connections.js";

export type MigrationSourceTool =
  | "claude-code"
  | "cursor"
  | "antigravity"
  | "agents-shared"
  | "codex";

export type MigrationStdioRiskFlag =
  | "shell_exec"
  | "pipe_download"
  | "ephemeral_runner"
  | "relative_command"
  | "inline_secret_stripped";

export type MigrationPendingItemKind =
  | "auth_required"
  | "multiple_auth_headers"
  | "env_var_reference"
  | "tool_filters"
  | "source_disabled"
  | "private_or_http_url"
  | "query_params_stripped"
  | "invalid_url"
  | "manual_toml_only";

export interface MigrationPendingItem {
  kind: MigrationPendingItemKind;
  message: string;
  /** Strictly redacted/sanitized metadata (header/tool names only, never values). */
  detail?: string;
}

/**
 * Safe, secret-free MCP candidate summary returned by scan API and Settings Assistant tool.
 * Never carries raw `args`, raw `url`, `env` values, `headers` values, or unredacted descriptions.
 */
export interface MigrationMcpCandidate {
  candidateId: string;
  source: MigrationSourceTool;
  sourceLabel: string;
  sourcePath: string;
  name: string;
  transport: "http" | "stdio";
  /** Safe hostname (and non-default port) only; never full URL, query, or userinfo. */
  hostSummary?: string;
  /** Safe executable basename only for stdio; never raw args or credentials. */
  commandSummary?: string;
  inferredAuthMode?: McpAuthMode;
  /** Header key name only (never value) when `inferredAuthMode === "header"`. */
  headerName?: string;
  disabledInSource: boolean;
  /** Always false for stdio (blocked from one-click import); true only for valid HTTP MCP. */
  importable: boolean;
  alreadyImported: boolean;
  hadSecretsStripped: boolean;
  descriptionSummary?: string;
  /** Safe env var key names only (never values). */
  requiredEnvKeys?: string[];
  pendingItems: MigrationPendingItem[];
  riskFlags: MigrationStdioRiskFlag[];
}

export interface MigrationSkillCandidate {
  candidateId: string;
  source: MigrationSourceTool;
  sourceLabel: string;
  sourcePath: string;
  sourceDevice: "local";
  originalName: string;
  normalizedName: string;
  nameNormalized: boolean;
  descriptionSummary: string;
  sha256: string;
  fileCount: number;
  totalBytes: number;
  skippedDotfiles: string[];
  /** True when Kulo already manages a skill with the same normalized name (kept intact). */
  conflictWithManaged: boolean;
  existingSkillId?: string;
  importable: boolean;
  blockedReason?: string;
}

export type MigrationManualNoticeCode =
  | "codex_toml_manual"
  | "file_too_large"
  | "symlink_rejected"
  | "invalid_json"
  | "read_error";

export interface MigrationManualNotice {
  source: MigrationSourceTool;
  sourceLabel: string;
  sourcePath: string;
  code: MigrationManualNoticeCode;
  message: string;
}

export interface MigrationScanResult {
  scanId: string;
  scannedAt: number;
  expiresAt: number;
  localNodeId: string;
  currentConnectionCount: number;
  maxConnections: number;
  httpMcpCandidates: MigrationMcpCandidate[];
  stdioMcpCandidates: MigrationMcpCandidate[];
  skillCandidates: MigrationSkillCandidate[];
  manualNotices: MigrationManualNotice[];
}

/**
 * Sanitized read-only prefill payload for the manual custom stdio MCP form.
 * Secrets in args/env are stripped; never auto-saved or started.
 */
export interface MigrationStdioPrefill {
  candidateId: string;
  name: string;
  mcpTransport: "stdio";
  mcpCommand: string;
  mcpArgs: string[];
  mcpCwd?: string;
  envKeys: string[];
  boundNodeId: string;
  riskFlags: MigrationStdioRiskFlag[];
  warnings: string[];
}

export interface MigrationImportRequest {
  scanId: string;
  commandId?: string;
  mcpCandidateIds?: string[];
  skillCandidateIds?: string[];
  /** Defaults to `["worker"]` when omitted. */
  skillAudiences?: SkillAudience[];
  /** Optional single stdio candidate ID to generate read-only manual form prefill. */
  stdioPrefillCandidateId?: string;
}

export interface MigrationImportItemOutcome {
  candidateId: string;
  kind: "http_mcp" | "stdio_mcp" | "skill";
  name: string;
  status: "imported" | "skipped" | "failed";
  code?: string;
  message: string;
  createdId?: string;
  sha256?: string;
  disabledInSource?: boolean;
  pendingItems?: MigrationPendingItem[];
}

export interface MigrationImportResult {
  scanId: string;
  importedAt: number;
  results: MigrationImportItemOutcome[];
  stdioPrefill?: MigrationStdioPrefill;
  summary: {
    imported: number;
    skipped: number;
    failed: number;
  };
}
