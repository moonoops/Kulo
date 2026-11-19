import type { IdentityVersion } from "./domain.js";

export interface RelationshipUpdateSettings {
  enabled: boolean;
  intervalDays: number;
}

export interface PersonalitySettings {
  relationshipUpdate: RelationshipUpdateSettings;
  recentWorkEnabled: boolean;
}

export interface RelationshipUpdateStatus {
  lastCheckedAt: number | null;
  lastUpdatedAt: number | null;
  nextRunAt: number | null;
  lastResult: "never" | "unchanged" | "updated" | "skipped" | "error";
  lastError?: string;
}

export interface IdentityProposal {
  id: string;
  content: string;
  summary: string;
  expected: IdentityVersion;
}

export interface PersonalitySnapshot {
  revision: number;
  settings: PersonalitySettings;
  relationshipStatus: RelationshipUpdateStatus;
  identityProposal: IdentityProposal | null;
}

export interface PersonalitySettingsRequest extends PersonalitySettings {
  expectedRevision: number;
}

export interface RelationshipWriteRequest {
  expected: IdentityVersion;
  content: string;
  summary: string;
}

export interface RelationshipRollbackRequest {
  expected: IdentityVersion;
  backupId: string;
  summary: string;
}

export interface RecentWorkSnapshot {
  enabled: boolean;
  content: string;
  revision: string;
  topicId?: string;
  projectId?: string;
}
