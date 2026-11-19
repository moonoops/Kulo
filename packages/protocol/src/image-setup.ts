import type { CustomProviderApi } from "./domain.js";
import type { CapabilityConfigurationInput, CapabilityRecord, CustomImageAdapter, ImageGenerationParameters, ImageModelProfile, MediaAdapterId, SetupInputRequest } from "./capabilities.js";

export type ImageCapabilityConfiguration = Omit<CapabilityConfigurationInput, "commandId">;

export interface ImageCapabilityDraft {
  id: string;
  clientId: string;
  revision: number;
  config: ImageCapabilityConfiguration;
  updatedAt: number;
}

export interface ImageProviderConnection {
  id: string;
  name: string;
  baseUrl?: string;
  api?: CustomProviderApi;
  authType?: "api_key" | "oauth";
  authenticated: boolean;
  imageSupported: boolean;
  reason?: string;
}

export interface ImageModelCandidate {
  id: string;
  providerId: string;
  providerName: string;
  baseUrl: string;
  adapter: Exclude<MediaAdapterId, "flow-browser">;
  modelId: string;
  name: string;
  alreadyAdded: boolean;
  imageProfile?: ImageModelProfile;
  defaults?: ImageGenerationParameters;
  customAdapter?: CustomImageAdapter;
  maxOutputs?: number;
  needsConfiguration?: boolean;
  configurationReason?: string;
  evidence: "catalog" | "preset";
}

export interface ImageModelDiscovery {
  id: string;
  clientId: string;
  status: "ready" | "partial";
  candidates: ImageModelCandidate[];
  errors: Array<{ providerId: string; providerName: string; error: string }>;
  createdAt: number;
}

export interface ImageConfigurationWorkspace {
  draft?: ImageCapabilityDraft;
  discovery?: ImageModelDiscovery;
  providers: ImageProviderConnection[];
}

export interface ImageDraftUpdateRequest {
  clientId: string;
  config: ImageCapabilityConfiguration;
  expectedRevision?: number;
}

export interface ImageModelImportResult {
  added: CapabilityRecord[];
  errors: Array<{ candidateId: string; error: string }>;
}

export interface ImageDraftSaveResult {
  capability: CapabilityRecord;
  input?: SetupInputRequest;
}
