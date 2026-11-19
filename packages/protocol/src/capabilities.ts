import type { ChatAttachment } from "./domain.js";
import type { SearchSnapshot } from "./search.js";
import type { ExtensionWorkspaceSnapshot } from "./extensions.js";
import type { ImageConfigurationWorkspace } from "./image-setup.js";

export type SkillAudience = "settings" | "chat" | "worker";
export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "git" | "local";
  sourceUrl?: string;
  version: string;
  enabled: boolean;
  audiences: SkillAudience[];
  dependencies: string[];
  diagnostics: string[];
  createdAt: number;
  updatedAt: number;
}
export interface SkillSnapshot { revision: number; skills: SkillRecord[] }

export type MediaAdapterId = "openai-image" | "gemini-image" | "custom-image" | "flow-browser";
export type MediaKind = "image" | "video";
export type MediaOutputFormat = "png" | "jpeg" | "webp" | "gif" | "svg" | "mp4";
export type ImageIntent = "generate" | "edit" | "animate" | "vector";
export type ImagePreference = "balanced" | "speed" | "quality" | "cost";
export type ImageJsonValue = string | number | boolean | null | ImageJsonValue[] | { [key: string]: ImageJsonValue };
export interface ImageGenerationParameters {
  format?: MediaOutputFormat;
  count?: number;
  aspectRatio?: string;
  size?: string;
  quality?: string;
  background?: "auto" | "opaque" | "transparent";
  complexity?: "low" | "medium" | "high";
  outputCompression?: number;
  frameCount?: number;
  frameDurationMs?: number;
  thinkingLevel?: string;
  grounding?: boolean;
  svgModel?: string;
  svgReasoning?: string;
  custom?: Record<string, ImageJsonValue>;
}
export interface ImageParameterDefinition {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  required?: boolean;
  default?: string | number | boolean;
}
export interface ImageModelProfile {
  id?: string;
  name?: string;
  formats: MediaOutputFormat[];
  supportsEdit: boolean;
  maxReferences: number;
  aspectRatios?: string[];
  sizes?: string[];
  qualities?: string[];
  supportsTransparency?: boolean;
  supportsComplexity?: boolean;
  supportsCustomSize?: boolean;
  thinkingLevels?: string[];
  supportsGrounding?: boolean;
  parameters?: ImageParameterDefinition[];
  speed?: number;
  quality?: number;
  cost?: number;
}
export interface ImageCapabilityRouting {
  priority?: number;
  useCases?: string[];
  instructions?: string;
}
export interface ImageRoutingRule {
  id: string;
  name: string;
  capabilityId: string;
  enabled: boolean;
  intents?: ImageIntent[];
  keywords?: string[];
  formats?: MediaOutputFormat[];
  preference?: ImagePreference;
}
export interface ImageRoutingSettings {
  mode: "auto" | "default";
  preference: ImagePreference;
  instructions: string;
  rules: ImageRoutingRule[];
}
export interface ImageRoutingConfigurationInput {
  settings: ImageRoutingSettings;
  expectedRevision: number;
  commandId: string;
}
export interface CustomImageRequest {
  path: string;
  body: ImageJsonValue;
  headers?: Record<string, string>;
}
export interface CustomImageAdapter {
  auth: { type: "bearer" | "api-key" | "none"; header?: string; prefix?: string };
  generate: CustomImageRequest;
  edit?: CustomImageRequest;
  referenceTemplate?: ImageJsonValue;
  response: { imagesPath: string; base64Path?: string; urlPath?: string; mimeTypePath?: string };
  poll?: {
    path: string;
    idPath: string;
    statusPath: string;
    completeValues: string[];
    failedValues: string[];
    intervalMs?: number;
  };
  outputOrigins?: string[];
}
export type CapabilityStatus = "unverified" | "ready" | "needs_auth" | "offline" | "missing_dependency" | "disabled" | "error";
export interface MediaConnectionView {
  id: string;
  name: string;
  adapter: MediaAdapterId;
  baseUrl?: string;
  origin?: string;
  browserEnvId?: string;
  profileRef?: string;
  credentialProviderId?: string;
  customAdapter?: CustomImageAdapter;
  hasCredential: boolean;
  revision: number;
}
export interface CapabilityRecord {
  id: string;
  name: string;
  connectionId: string;
  kind: MediaKind;
  modelId: string;
  formats: MediaOutputFormat[];
  supportsEdit: boolean;
  enabled: boolean;
  isDefault: boolean;
  allowTaskGeneration: boolean;
  maxOutputs: number;
  imageProfile?: ImageModelProfile;
  defaults?: ImageGenerationParameters;
  routing?: ImageCapabilityRouting;
  lastGeneratedAt?: number;
  revision: number;
  status: CapabilityStatus;
  lastCheckedAt?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
export interface CapabilityConfigurationInput {
  commandId: string;
  id?: string;
  expectedRevision?: number;
  name: string;
  adapter: MediaAdapterId;
  baseUrl?: string;
  modelId: string;
  browserEnvId?: string;
  profileRef?: string;
  credentialProviderId?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
  allowTaskGeneration?: boolean;
  maxOutputs?: number;
  imageProfile?: ImageModelProfile;
  defaults?: ImageGenerationParameters;
  routing?: ImageCapabilityRouting;
  customAdapter?: CustomImageAdapter;
}
export interface CapabilitySnapshot {
  revision: number;
  capabilities: CapabilityRecord[];
  connections: MediaConnectionView[];
  imageRouting?: ImageRoutingSettings;
}

export interface SetupInputRequest {
  id: string;
  kind: "secret" | "browser";
  label: string;
  clientId: string;
  capabilityId: string;
  expectedRevision: number;
  envId?: string;
  status: "pending" | "completed" | "expired" | "cancelled";
  createdAt: number;
  expiresAt: number;
}

export type MediaJobStatus = "queued" | "submitting" | "running" | "needs_user" | "needs_reconciliation" | "collecting" | "completed" | "failed" | "stopped";
export interface MediaJobSource {
  setupClientId?: string;
  conversationId: number;
  topicId: string;
  ticketId?: string;
  projectId?: string;
  envId?: string;
  runEpoch?: number;
  readOnly?: boolean;
}
export interface MediaJobRequest {
  operationId: string;
  capabilityId?: string;
  kind: MediaKind;
  prompt: string;
  inputAssetIds?: string[];
  format?: MediaOutputFormat;
  aspectRatio?: string;
  quality?: string;
  durationSeconds?: number;
  count?: number;
  parameters?: ImageGenerationParameters;
  intent?: ImageIntent;
  preference?: ImagePreference;
  source: MediaJobSource;
}
export interface MediaJob {
  id: string;
  operationId: string;
  capabilityId: string;
  capabilityRevision: number;
  connectionId: string;
  adapter: MediaAdapterId;
  modelId: string;
  kind: MediaKind;
  prompt: string;
  inputAssetIds: string[];
  format: MediaOutputFormat;
  aspectRatio?: string;
  quality?: string;
  durationSeconds?: number;
  count: number;
  parameters?: ImageGenerationParameters;
  imageProfile?: ImageModelProfile;
  intent?: ImageIntent;
  preference?: ImagePreference;
  selectionReason?: string;
  source: MediaJobSource;
  status: MediaJobStatus;
  remoteId?: string;
  remoteUrl?: string;
  assets: ChatAttachment[];
  error?: string;
  nextPollAt?: number;
  deliveredAt?: number;
  createdAt: number;
  updatedAt: number;
}
export interface CapabilitiesWorkspaceSnapshot extends CapabilitySnapshot {
  imageSetup?: ImageConfigurationWorkspace;
  extensions?: ExtensionWorkspaceSnapshot;
  search?: SearchSnapshot;
  skills: SkillRecord[];
  skillRevision: number;
  jobs: MediaJob[];
  inputs: SetupInputRequest[];
}

export type BrowserRequest =
  | { action: "open"; profileRef: string }
  | { action: "check"; profileRef: string; takeover?: boolean }
  | { action: "prepare"; profileRef: string; jobId: string; prompt: string; modelId?: string; durationSeconds?: number; referenceIds?: string[] }
  | { action: "submit"; profileRef: string; jobId: string; prompt: string; modelId?: string; durationSeconds?: number; referenceIds?: string[] }
  | { action: "poll" | "download" | "stop"; profileRef: string; jobId: string }
  | { action: "read"; profileRef: string; jobId: string; offset: number; length: number }
  | { action: "upload"; profileRef: string; jobId: string; assetId: string; name: string; mimeType: string; data: string; offset: number; final: boolean };
export interface BrowserResult {
  status: "ready" | "needs_login" | "running" | "completed" | "needs_review" | "stopped";
  profileRef: string;
  jobId?: string;
  remoteId?: string;
  remoteUrl?: string;
  message?: string;
  models?: string[];
  file?: { name: string; mimeType: string; size: number };
  data?: string;
  offset?: number;
  submitted?: boolean;
  prepared?: boolean;
  preparationSent?: boolean;
  quote?: { credits: number; outputs: number; durationSeconds?: number; modelId?: string };
}
