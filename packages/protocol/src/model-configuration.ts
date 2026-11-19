import type { CustomModelConfig, CustomProviderApi, CustomProviderConfig, ModelProbeResult, MocoSettingsView, ProviderCatalogItem } from "./domain.js";

export interface ModelConfigurationVerification {
  modelId: string;
  kind: "text-call";
  ok: boolean;
  checkedAt: number;
  latencyMs: number;
  error?: string;
}

export interface ModelConfigurationCandidate {
  model: CustomModelConfig;
  /** Directory metadata can include SDK defaults; it is a reference, not a successful probe. */
  catalogModel?: CustomModelConfig;
  evidence: "catalog" | "configured" | "manual";
}

export interface ModelConfigurationDraft {
  id: string;
  clientId: string;
  revision: number;
  settingsRevision: number;
  provider: CustomProviderConfig;
  existingProvider: boolean;
  selectedModelIds: string[];
  defaultModelId?: string;
  candidates: ModelConfigurationCandidate[];
  verifications: ModelConfigurationVerification[];
  hasCredential: boolean;
  updatedAt: number;
}

export interface ModelConfigurationWorkspace {
  draft?: ModelConfigurationDraft;
  drafts?: ModelConfigurationDraft[];
  presets?: Array<{ id: string; name: string; api: CustomProviderApi; baseUrl: string }>;
  providers: Array<Pick<ProviderCatalogItem, "id" | "name" | "authenticated" | "builtin" | "isGateway" | "authType" | "api" | "baseUrl">>;
}

export interface ModelConfigurationPrepareRequest {
  clientId: string;
  providerId?: string;
  name?: string;
  api?: CustomProviderApi;
  baseUrl?: string;
  preset?: string;
}

export interface ModelConfigurationUpdateRequest {
  clientId: string;
  draftId?: string;
  expectedRevision: number;
  provider: CustomProviderConfig;
  selectedModelIds: string[];
  defaultModelId?: string;
}

export interface ModelConfigurationSaveResult {
  providerId: string;
  modelIds: string[];
  defaultModelId?: string;
  settings: MocoSettingsView;
  verifications: ModelConfigurationVerification[];
}

export type ModelCalibrationFieldPatch = Partial<Omit<CustomModelConfig, "id">>;

export interface ModelCalibrationModelUpdate {
  id: string;
  patch: ModelCalibrationFieldPatch;
}

export interface ModelCalibrationProviderUpdate {
  providerId: string;
  models: ModelCalibrationModelUpdate[];
}

export interface ModelConfigurationApi {
  workspace(clientId: string, signal?: AbortSignal): Promise<ModelConfigurationWorkspace>;
  prepare(input: ModelConfigurationPrepareRequest): Promise<ModelConfigurationDraft>;
  update(input: ModelConfigurationUpdateRequest): Promise<ModelConfigurationDraft>;
  credential(input: { clientId: string; draftId?: string; expectedRevision: number; apiKey: string }): Promise<ModelConfigurationDraft>;
  discover(input: { clientId: string; draftId?: string; expectedRevision: number }): Promise<ModelConfigurationDraft>;
  test(input: { clientId: string; draftId?: string; expectedRevision: number; modelId: string; commandId: string }, signal?: AbortSignal): Promise<{ draft: ModelConfigurationDraft; verification: ModelConfigurationVerification }>;
  save(input: { clientId: string; draftId?: string; expectedRevision: number; commandId: string }): Promise<ModelConfigurationSaveResult>;
  discard(input: { clientId: string; draftId?: string; expectedRevision: number }): Promise<void>;
}

export type ModelConfigurationProbe = (request: import("./domain.js").ModelProbeRequest, signal?: AbortSignal) => Promise<ModelProbeResult>;
