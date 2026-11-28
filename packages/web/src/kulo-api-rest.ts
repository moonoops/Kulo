/** Typed REST client, auth/media helpers, and provider catalog cache for KuloHub. */
import { normalizeKuloLanguage } from "@kulo/protocol";
import { getLanguage, translate as t, type KuloLanguage } from "./kulo-i18n";
import { ProviderCatalogCache } from "./features/settings/provider-catalog";
import type {
  AcpRegistryTemplate, AmbientLocalEngine, ArchiveMainConversationResult, AssistantWorkspaceSnapshot,
  CapabilitiesWorkspaceSnapshot, CapabilityConfigurationInput, CapabilityRecord, ChatAttachment, ChatDisplayItem,
  ComputerUseConfigurationInput, ComputerUseSettings, ConnectionPrepareRequest, ConnectionRecordView,
  ConnectionSaveRequest, ConnectionSetupInput, ConnectionTestResult, ConnectionWorkspaceSnapshot,
  ConversationFilesPage, ConversationMessageWindow, ConversationSearchInput, ConversationSearchPage,
  CreateProjectInput, CustomProviderApi, DiscoverModelsRequest, DiscoverModelsResponse, ExternalAgentKind,
  ExternalAgentQuickConnectRequest, ExternalAgentQuickConnectResult, ExternalAgentScanResult,
  ExternalAgentVerifyClientResult, ExternalClientConnection, ExternalClientQuotasView, ExtensionWorkspaceSnapshot,
  HindsightProbeResult, HomeAssistantMigrationAdvice, IdentityBackup, IdentityFile, IdentityList, IdentityRead,
  IdentityRollbackRequest, IdentitySaved, IdentityWriteRequest, ImageCapabilityDraft, ImageModelDiscovery,
  ImageRoutingSettings, KuloSettingsView, McpOAuthSessionView, MediaJob, MemoryConnectionUpdateRequest,
  MemoryConnectionUpdateResult, MemoryServicePrepareRequest, MemoryServiceSnapshot, MigrationImportRequest,
  MigrationImportResult, MigrationScanResult, ModelProbeRequest,
  ModelProbeResult, NativeAppPermissionKind, OAuthSessionView, PersonalitySettingsRequest, PersonalitySnapshot,
  ProjectDirectoryListing, ProjectView, ProviderCatalogItem, RecentWorkSnapshot, RelationshipRollbackRequest,
  RelationshipWriteRequest, ResolveModelMetadataRequest, ResolveModelMetadataResponse, SearchAttempt,
  SearchFailure, SearchPlanInput, SearchSnapshot, SettingsBlockName, SetupInputRequest,
  SideQuestionActiveResponse, SideQuestionCloseResponse, SideQuestionCreateRequest, SideQuestionCreateResponse,
  SideQuestionMessageRequest, SideQuestionMessageResponse, SkillAudience,
  SkillSnapshot, TicketCardView, TicketResumeOverrideRequest, TicketResumeOverrideResponse, TopicCompactResult, TopicSummary, UiActionInput, UiActionReceipt,
  UiCardSnapshot, UsageCapsSnapshot, UsageCapsUpdateInput, UsageStatsView, WebSearchResult,
} from "@kulo/protocol";

export type AssistantWorkspaceView = AssistantWorkspaceSnapshot;

export class KuloApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly card?: UiCardSnapshot,
    readonly failure?: SearchFailure,
    readonly attempts?: SearchAttempt[],
  ) {
    super(message);
    this.name = "KuloApiError";
  }
}

const SESSION_AUTH_TOKEN_KEY = "kulo.session.authToken";
let memoryAuthToken: string | null = null;

export function getAuthTokenFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("token");
    if (fromUrl) {
      memoryAuthToken = fromUrl;
      try {
        window.sessionStorage.setItem(SESSION_AUTH_TOKEN_KEY, fromUrl);
      } catch {
        // Ignore restricted sessionStorage environments; in-memory token remains active.
      }
      params.delete("token");
      const nextSearch = params.toString();
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
      try {
        window.history.replaceState(window.history.state, "", nextUrl);
      } catch {
        // Ignore history restrictions in non-standard browsing contexts.
      }
      return fromUrl;
    }
    try {
      const stored = window.sessionStorage.getItem(SESSION_AUTH_TOKEN_KEY);
      if (stored) {
        memoryAuthToken = stored;
        return stored;
      }
    } catch {
      // Fall back to in-memory token if sessionStorage is unavailable.
    }
    return memoryAuthToken;
  } catch {
    return memoryAuthToken;
  }
}

export function resolveAssetUrl(url: string): string {
  try {
    if (typeof window === "undefined") return /^(https?:\/\/|\/(?!\/)|blob:)/.test(url) ? url : "";
    const resolved = new URL(url, window.location.origin);
    if (!["http:", "https:", "blob:"].includes(resolved.protocol)) return "";
    if (resolved.protocol === "blob:") return resolved.href;
    if (resolved.origin === window.location.origin) {
      resolved.searchParams.delete("token");
      return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    }
    return resolved.href;
  } catch { return ""; }
}

export interface ChatHistoryPage { conversationId?: number; messages: ChatDisplayItem[]; beforeEntryId?: number; hasMore: boolean }

export interface MediaSession {
  expiresAt: number;
  limits: { imageBytes: number; audioBytes: number; videoBytes: number; fileBytes: number; messageBytes: number; maxAttachments: number };
}
let mediaSession: MediaSession | undefined;
let mediaSessionRequest: Promise<MediaSession> | undefined;
let mediaSessionAbort: (() => void) | undefined;

export function resetMediaSession(): void {
  mediaSession = undefined;
}

export function ensureMediaSession(force = false): Promise<MediaSession> {
  if (!force && mediaSession && mediaSession.expiresAt > Date.now() + 60_000) return Promise.resolve(mediaSession);
  if (force && mediaSessionAbort) {
    mediaSessionAbort();
  }
  if (!mediaSessionRequest) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);
    const request = apiRequest<MediaSession>("/api/media/session", { method: "POST", signal: controller.signal })
      .then((session) => { mediaSession = session; return session; })
      .catch((error: unknown) => {
        if (timedOut) throw new KuloApiError(408, t("连接中枢超时，待发内容已保留", "The Hub connection timed out. Pending content has been kept"));
        if (error instanceof KuloApiError && error.status === 404) throw new KuloApiError(404, t("请重启中枢加载新版聊天功能", "Restart the Hub to load the updated chat features"), "media_session_unavailable");
        throw error;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (mediaSessionRequest === request) {
          mediaSessionRequest = undefined;
          mediaSessionAbort = undefined;
        }
      });
    mediaSessionRequest = request;
    mediaSessionAbort = () => {
      if (mediaSessionRequest === request) {
        mediaSessionRequest = undefined;
        mediaSessionAbort = undefined;
      }
      controller.abort();
    };
  }
  return mediaSessionRequest;
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
    transitionId?: string;
    redirect?: RequestRedirect;
  } = {},
): Promise<T> {
  const token = getAuthTokenFromUrl();
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.transitionId) headers["X-Kulo-Transition-Id"] = options.transitionId;

  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    ...(options.redirect ? { redirect: options.redirect } : {}),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errObj = (data ?? {}) as { error?: string; code?: string; card?: UiCardSnapshot; failure?: SearchFailure; attempts?: SearchAttempt[] };
    throw new KuloApiError(
      res.status,
      errObj.error || t(`请求失败 (HTTP ${res.status})`, `Request failed (HTTP ${res.status})`),
      errObj.code,
      errObj.card,
      errObj.failure,
      errObj.attempts,
    );
  }

  return data as T;
}

export interface TicketDeliverable {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  previewable: boolean;
}

export const kuloRest = {
  ensureMediaSession,
  getConnectionsWorkspace: (clientId: string, signal?: AbortSignal) =>
    apiRequest<ConnectionWorkspaceSnapshot>(`/api/connections?${new URLSearchParams({ clientId })}`, { signal }),
  saveConnection: (body: ConnectionSaveRequest) =>
    apiRequest<{ connection: ConnectionRecordView }>("/api/connections", { method: "POST", body }),
  prepareConnection: (body: ConnectionPrepareRequest) =>
    apiRequest<ConnectionSetupInput>("/api/connections/prepare", { method: "POST", body }),
  submitConnectionInput: (id: string, body: ConnectionSaveRequest & { clientId: string }) =>
    apiRequest<{ connection: ConnectionRecordView }>(`/api/connections/inputs/${encodeURIComponent(id)}/submit`, { method: "POST", body }),
  cancelConnectionInput: (id: string, clientId: string) =>
    apiRequest<void>(`/api/connections/inputs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { clientId } }),
  deleteConnection: (id: string) =>
    apiRequest<void>(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testConnection: (id: string, body?: { rescan?: boolean }) =>
    apiRequest<ConnectionTestResult>(`/api/connections/${encodeURIComponent(id)}/test`, { method: "POST", ...(body ? { body } : {}) }),
  trustConnection: (id: string, fingerprint: string) =>
    apiRequest<{ connection: ConnectionRecordView }>(`/api/connections/${encodeURIComponent(id)}/trust`, { method: "POST", body: { fingerprint } }),
  startConnectionOAuth: (connectionId: string, body: { clientId?: string; forceReauth?: boolean } = {}) =>
    apiRequest<{ session: McpOAuthSessionView }>(`/api/connections/${encodeURIComponent(connectionId)}/oauth/start`, { method: "POST", body }),
  getConnectionOAuth: (sessionId: string, clientId?: string) =>
    apiRequest<{ session: McpOAuthSessionView }>(`/api/connections/oauth/${encodeURIComponent(sessionId)}${clientId ? `?${new URLSearchParams({ clientId })}` : ""}`),
  completeConnectionOAuth: (sessionId: string, body: { clientId?: string; redirectUrl: string }) =>
    apiRequest<{ session: McpOAuthSessionView }>(`/api/connections/oauth/${encodeURIComponent(sessionId)}/complete`, { method: "POST", body }),
  cancelConnectionOAuth: (sessionId: string, clientId?: string) =>
    apiRequest<{ session: McpOAuthSessionView }>(`/api/connections/oauth/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", body: { ...(clientId ? { clientId } : {}) } }),
  openConnectionPermissionSettings: (kind: NativeAppPermissionKind) =>
    apiRequest<{ ok: true }>("/api/connections/permission-settings", { method: "POST", body: { kind } }),
  scanLocalMigration: (signal?: AbortSignal) =>
    apiRequest<MigrationScanResult>("/api/migration/scan", { method: "POST", body: {}, signal }),
  importLocalMigration: (body: MigrationImportRequest, signal?: AbortSignal) =>
    apiRequest<MigrationImportResult>("/api/migration/import", { method: "POST", body, signal }),
  getAssistantWorkspace: (signal?: AbortSignal) =>
    apiRequest<AssistantWorkspaceView>("/api/assistant", { signal }),
  configureAssistantNotifications: (body: { enabled?: boolean; muteApp?: string; unmuteApp?: string }) =>
    apiRequest<AssistantWorkspaceView>("/api/assistant/configure", { method: "POST", body }),
  configureAssistantBackgroundModel: (body: {
    mode: "auto" | "local-managed" | "kulo-provider";
    engine?: AmbientLocalEngine;
    modelId?: string;
    providerId?: string;
    confirmed?: boolean;
  }) =>
    apiRequest<{
      requiresConfirmation?: boolean;
      proposal?: Record<string, unknown>;
      snapshot: AssistantWorkspaceSnapshot;
      localHost?: boolean; canManageHub?: boolean;
    }>("/api/assistant/background-model", { method: "POST", body }),
  configureAssistantSpark: (body: { enabled: boolean }) =>
    apiRequest<AssistantWorkspaceView>("/api/assistant/spark", { method: "POST", body }),
  configureAssistantHomeAssistant: (body: { enabled?: boolean; baseUrl?: string; token?: string; clearToken?: boolean }) =>
    apiRequest<AssistantWorkspaceView>("/api/assistant/home-assistant", { method: "POST", body }),
  getHomeAssistantMigration: (signal?: AbortSignal) =>
    apiRequest<HomeAssistantMigrationAdvice>("/api/assistant/home-assistant/migration", { signal }),
  deployLocalHomeAssistant: (body: { confirmed: boolean; installXiaomiHome?: boolean }) =>
    apiRequest<{
      requiresConfirmation?: boolean;
      advice: HomeAssistantMigrationAdvice;
      started?: boolean;
      xiaomiHomeInstalled?: boolean;
      url?: string;
      snapshot: AssistantWorkspaceSnapshot;
      localHost?: boolean; canManageHub?: boolean;
    }>("/api/assistant/home-assistant", { method: "POST", body: { deployLocal: true, ...body } }),
  configureAssistantLark: (body: { enabled?: boolean; selectedProfiles?: string[]; syncNow?: boolean }) =>
    apiRequest<AssistantWorkspaceView>("/api/assistant/lark", { method: "POST", body }),
  getCapabilitiesWorkspace: (clientId: string, signal?: AbortSignal) =>
    apiRequest<CapabilitiesWorkspaceSnapshot>(`/api/capabilities?${new URLSearchParams({ clientId })}`, { signal }),
  updateComputerUse: (body: ComputerUseConfigurationInput) =>
    apiRequest<{ computerUse: ComputerUseSettings; revision: number }>("/api/capabilities/computer-use", { method: "PUT", body }),
  updateImageDraft: (body: { clientId: string; config: Omit<CapabilityConfigurationInput, "commandId">; expectedRevision?: number }) =>
    apiRequest<ImageCapabilityDraft>("/api/capabilities/image/draft", { method: "POST", body }),
  deleteImageDraft: (clientId: string, expectedRevision?: number) =>
    apiRequest<void>("/api/capabilities/image/draft", { method: "DELETE", body: { clientId, expectedRevision } }),
  saveImageDraft: (body: { clientId: string; expectedRevision: number; commandId: string }) =>
    apiRequest<{ capability: CapabilityRecord; input?: SetupInputRequest }>("/api/capabilities/image/draft/save", { method: "POST", body }),
  discoverImageModels: (clientId: string, providerIds?: string[]) =>
    apiRequest<ImageModelDiscovery>("/api/capabilities/image/discover", { method: "POST", body: { clientId, providerIds } }),
  importImageModels: (body: { clientId: string; discoveryId: string; candidateIds: string[]; commandId: string; allowTaskGeneration?: boolean }) =>
    apiRequest<{ added: CapabilityRecord[]; errors: Array<{ candidateId: string; error: string }> }>("/api/capabilities/image/import", { method: "POST", body }),
  saveImageRouting: (settings: ImageRoutingSettings, expectedRevision: number, commandId: string) =>
    apiRequest<ImageRoutingSettings>("/api/capabilities/image/routing", { method: "PUT", body: { settings, expectedRevision, commandId } }),
  checkImageCapability: (id: string) =>
    apiRequest<CapabilityRecord>(`/api/capabilities/image/${encodeURIComponent(id)}/check`, { method: "POST" }),
  testImageCapability: (id: string, body: { clientId: string; commandId: string; prompt?: string }) =>
    apiRequest<MediaJob>(`/api/capabilities/image/${encodeURIComponent(id)}/test`, { method: "POST", body }),
  patchImageCapability: (id: string, body: { enabled?: boolean; isDefault?: boolean; allowTaskGeneration?: boolean; expectedRevision: number; commandId: string }) =>
    apiRequest<CapabilityRecord>(`/api/capabilities/image/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  deleteImageCapability: (id: string, expectedRevision: number, commandId: string) =>
    apiRequest<{ removed: true }>(`/api/capabilities/image/${encodeURIComponent(id)}`, { method: "DELETE", body: { expectedRevision, commandId } }),
  getSkills: (signal?: AbortSignal) => apiRequest<SkillSnapshot>("/api/skills", { signal }),
  importSkill: (body: { source: string; expectedRevision: number; commandId: string; audiences?: SkillAudience[] }) =>
    apiRequest<SkillSnapshot>("/api/skills/import", { method: "POST", body }),
  updateSkill: (id: string, body: { enabled: boolean; audiences?: SkillAudience[]; expectedRevision: number; commandId: string }) =>
    apiRequest<SkillSnapshot>(`/api/skills/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  deleteSkill: (id: string, body: { expectedRevision: number; commandId: string }) =>
    apiRequest<SkillSnapshot>(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE", body }),
  getExtensions: (signal?: AbortSignal) => apiRequest<ExtensionWorkspaceSnapshot>("/api/extensions", { signal }),
  manageExtension: (id: string, body: { operation: "install" | "enable" | "stop" | "remove"; expectedRevision: number; commandId: string }) =>
    apiRequest<ExtensionWorkspaceSnapshot>(`/api/extensions/${encodeURIComponent(id)}/operations`, { method: "POST", body }),
  connectGoogleFlow: (body: { clientId: string; envId: string; commandId: string; name?: string }) =>
    apiRequest<{ capability: CapabilityRecord; input?: SetupInputRequest; snapshot: CapabilitiesWorkspaceSnapshot }>("/api/capabilities/flow", { method: "POST", body }),
  getSearch: (signal?: AbortSignal) => apiRequest<SearchSnapshot>("/api/search", { signal }),
  saveSearchPlan: (body: SearchPlanInput) => apiRequest<SearchSnapshot>("/api/search/plans", { method: "POST", body }),
  reorderSearchPlans: (ids: string[], expectedRevision: number) =>
    apiRequest<SearchSnapshot>("/api/search/order", { method: "PATCH", body: { ids, expectedRevision } }),
  deleteSearchPlan: (id: string, expectedRevision: number) =>
    apiRequest<SearchSnapshot>(`/api/search/plans/${encodeURIComponent(id)}?${new URLSearchParams({ expectedRevision: String(expectedRevision) })}`, { method: "DELETE" }),
  testSearchPlan: (id: string, expectedRevision: number) =>
    apiRequest<{ snapshot: SearchSnapshot; result: WebSearchResult }>(`/api/search/plans/${encodeURIComponent(id)}/test`, { method: "POST", body: { expectedRevision } }),
  submitCapabilityInput: (id: string, body: { clientId: string; secret?: string; cancel?: boolean }) =>
    apiRequest<void>(`/api/capabilities/inputs/${encodeURIComponent(id)}`, { method: "POST", body }),
  completeCapabilityBrowserInput: (id: string, clientId: string) =>
    apiRequest<void>(`/api/capabilities/inputs/${encodeURIComponent(id)}/browser`, { method: "POST", body: { clientId } }),
  getAsset: (assetId: string) => apiRequest<{ attachment: ChatAttachment }>(`/api/uploads/${encodeURIComponent(assetId)}/meta`),
  getTicketDeliverables: (ticketId: string, signal?: AbortSignal) =>
    apiRequest<{ files: TicketDeliverable[]; missing?: string[] }>(`/api/tickets/${encodeURIComponent(ticketId)}/deliverables`, { signal }),
  getUiCard: (cardId: string) => apiRequest<{ card: UiCardSnapshot }>(`/api/ui/cards/${encodeURIComponent(cardId)}`),
  submitUiAction: (input: UiActionInput) => apiRequest<UiActionReceipt>(`/api/ui/cards/${encodeURIComponent(input.cardId)}/actions`, { method: "POST", body: input }),
  getTopicHistory: (topicId: string, before: number) => apiRequest<ChatHistoryPage>(`/api/topics/${encodeURIComponent(topicId)}/messages?before=${before}`),
  searchConversations: (input: ConversationSearchInput, signal?: AbortSignal) => {
    const query = new URLSearchParams({ q: input.query });
    if (input.topicId) query.set("topicId", input.topicId);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return apiRequest<ConversationSearchPage>(`/api/conversations/search?${query}`, { signal });
  },
  getTopicMessageWindow: (topicId: string, messageId: number, signal?: AbortSignal) =>
    apiRequest<ConversationMessageWindow>(`/api/topics/${encodeURIComponent(topicId)}/messages/${messageId}`, { signal }),
  listTopicFiles: (topicId: string, input: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return apiRequest<ConversationFilesPage>(`/api/topics/${encodeURIComponent(topicId)}/files?${query}`, { signal });
  },
  listTopics: () => apiRequest<{ items: TopicSummary[] }>("/api/topics"),
  listProjects: () => apiRequest<{ projects: ProjectView[] }>("/api/projects"),
  createProject: (body: CreateProjectInput) =>
    apiRequest<{ project: ProjectView }>("/api/projects", { method: "POST", body }),
  patchProject: (projectId: string, body: { name?: string; notes?: string; expectedRevision?: number }) =>
    apiRequest<{ project: ProjectView }>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body }),
  deleteProject: (projectId: string, stopTasks = false) =>
    apiRequest<{ deleted: string; projects: ProjectView[]; topics: TopicSummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", body: { stopTasks } },
    ),
  listProjectDirectories: (deviceId: string, path?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ deviceId });
    if (path) query.set("path", path);
    return apiRequest<ProjectDirectoryListing>(`/api/projects/directories?${query}`, { signal });
  },
  createTopic: (title?: string, projectId?: string, options?: { draft?: boolean }) =>
    apiRequest<TopicSummary>("/api/topics", {
      method: "POST",
      body: { ...(title ? { title } : {}), ...(projectId ? { projectId } : {}), ...(options?.draft !== undefined ? { draft: options.draft } : {}) },
    }),
  patchTopic: (topicId: string, body: { title?: string; pinned?: boolean; archived?: boolean; targetDeviceId?: string | null }) =>
    apiRequest<TopicSummary>(`/api/topics/${encodeURIComponent(topicId)}`, { method: "PATCH", body }),
  deleteTopic: (topicId: string, stopTasks = false) =>
    apiRequest<{ deleted: string; topics: TopicSummary[] }>(`/api/topics/${encodeURIComponent(topicId)}`, { method: "DELETE", body: { stopTasks } }),
  retryTopic: (topicId: string) => apiRequest<{ retried: boolean }>(`/api/topics/${encodeURIComponent(topicId)}/retry`, { method: "POST" }),
  compactTopic: (topicId: string) => apiRequest<TopicCompactResult>(`/api/topics/${encodeURIComponent(topicId)}/compact`, { method: "POST" }),
  archiveMainConversation: (expectedConversationId: number) =>
    apiRequest<ArchiveMainConversationResult>("/api/topics/root/archive", { method: "POST", body: { expectedConversationId } }),
  createSideQuestion: (topicId: string, body: SideQuestionCreateRequest = {}) =>
    apiRequest<SideQuestionCreateResponse>(`/api/topics/${encodeURIComponent(topicId)}/side-questions`, { method: "POST", body })
      .then((result) => result.sideQuestion),
  getActiveSideQuestion: (topicId: string, signal?: AbortSignal) =>
    apiRequest<SideQuestionActiveResponse>(`/api/topics/${encodeURIComponent(topicId)}/side-questions/active`, { signal })
      .then((result) => result.sideQuestion),
  sendSideQuestionMessage: (id: string, body: SideQuestionMessageRequest) =>
    apiRequest<SideQuestionMessageResponse>(`/api/side-questions/${encodeURIComponent(id)}/messages`, { method: "POST", body })
      .then((result) => result.sideQuestion),
  closeSideQuestion: (id: string) =>
    apiRequest<SideQuestionCloseResponse>(`/api/side-questions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getUsage: (range: "today" | "7" | "30") =>
    apiRequest<UsageStatsView>(`/api/usage?range=${range}`),
  getExternalClientQuotas: (options?: { signal?: AbortSignal }) =>
    apiRequest<ExternalClientQuotasView>("/api/external-clients/quotas", { method: "GET", signal: options?.signal }),
  refreshExternalClientQuotas: (body: { clientId?: string; force?: boolean } = {}, options?: { signal?: AbortSignal }) =>
    apiRequest<ExternalClientQuotasView>("/api/external-clients/quotas/refresh", { method: "POST", body, signal: options?.signal }),
  retryTicket: (ticketId: string) =>
    apiRequest<{ ticket: TicketCardView }>(`/api/tickets/${encodeURIComponent(ticketId)}/retry`, { method: "POST" }),
  resumeTicketOverride: (ticketId: string, body: TicketResumeOverrideRequest = {}) =>
    apiRequest<TicketResumeOverrideResponse>(
      `/api/tickets/${encodeURIComponent(ticketId)}/resume-override`,
      { method: "POST", body },
    ),
  stopScheduledTask: (ticketId: string) =>
    apiRequest<{ task: TicketCardView }>(`/api/scheduled-tasks/${encodeURIComponent(ticketId)}/stop`, { method: "POST" }),
  deleteScheduledTask: (ticketId: string) =>
    apiRequest<{ ok: true }>(`/api/scheduled-tasks/${encodeURIComponent(ticketId)}`, { method: "DELETE" }),
  getSettings: () => apiRequest<KuloSettingsView>("/api/settings"),
  scanExternalAgents: (body: { envId?: string; kinds?: ExternalAgentKind[] } = {}, options?: { signal?: AbortSignal }) =>
    apiRequest<ExternalAgentScanResult>("/api/external-clients/scan", { method: "POST", body, signal: options?.signal }),
  getAcpRegistryTemplates: (options?: { refresh?: boolean; signal?: AbortSignal }) =>
    apiRequest<{ templates: AcpRegistryTemplate[]; fetchedAt: number }>(`/api/external-clients/acp-registry${options?.refresh ? "?refresh=1" : ""}`, { method: "GET", signal: options?.signal }),
  connectExternalAgent: (body: ExternalAgentQuickConnectRequest & { clientId: string }) =>
    apiRequest<ExternalAgentQuickConnectResult>("/api/external-clients/connect", { method: "POST", body }),
  refreshExternalClient: (clientId: string) =>
    apiRequest<{ settings: KuloSettingsView; client: ExternalClientConnection }>(`/api/external-clients/${encodeURIComponent(clientId)}/refresh`, { method: "POST" }),
  verifyExternalClient: (clientId: string, body: { commandId?: string; expectedRevision?: number } = {}) =>
    apiRequest<ExternalAgentVerifyClientResult>(`/api/external-clients/${encodeURIComponent(clientId)}/verify`, { method: "POST", body }),
  removeExternalClient: (clientId: string, expectedRevision?: number) =>
    apiRequest<{ settings: KuloSettingsView }>(`/api/external-clients/${encodeURIComponent(clientId)}${expectedRevision !== undefined ? `?expectedRevision=${encodeURIComponent(String(expectedRevision))}` : ""}`, { method: "DELETE" }),
  saveSettingsBlock: (block: SettingsBlockName, expectedRevision: number, value: unknown) =>
    apiRequest<{ settings: KuloSettingsView; summary: string }>(`/api/settings/${block}`, { method: "POST", body: { expectedRevision, value } })
      .then((result) => {
        if (block === "model" && value && typeof value === "object" && ("apiKey" in value || "clearApiKey" in value)) providerCatalog.invalidate();
        void providerCatalog.configure(result.settings);
        return result;
      }),
  rollbackSettings: (toRevision: number, expectedGlobalRevision: number) =>
    apiRequest<{ settings: KuloSettingsView; summary: string }>("/api/settings/rollback", { method: "POST", body: { toRevision, expectedGlobalRevision } })
      .then((result) => { void providerCatalog.configure(result.settings); return result; }),
  listIdentityFiles: () => apiRequest<IdentityList>("/api/identity/files"),
  getPersonality: () => apiRequest<PersonalitySnapshot>("/api/personality"),
  getUsageCaps: () => apiRequest<UsageCapsSnapshot>("/api/usage-caps"),
  saveUsageCaps: (body: UsageCapsUpdateInput) => apiRequest<UsageCapsSnapshot>("/api/usage-caps", { method: "PUT", body }),
  resolveComputerHandoff: (ticketId: string, action: "done" | "cancel", note?: string) =>
    apiRequest<{ ok: boolean; status: string }>(`/api/tickets/${encodeURIComponent(ticketId)}/computer-handoff`, { method: "POST", body: { action, ...(note ? { note } : {}) } }),
  savePersonalitySettings: (body: PersonalitySettingsRequest) =>
    apiRequest<PersonalitySnapshot>("/api/personality/settings", { method: "POST", body }),
  readIdentityAgreement: () =>
    apiRequest<IdentityRead>(`/api/personality/identity?lang=${encodeURIComponent(getLanguage())}`),
  readIdentityPreset: (lang?: KuloLanguage) =>
    apiRequest<{ content: string }>(`/api/personality/identity/preset?lang=${encodeURIComponent(normalizeKuloLanguage(lang) ?? getLanguage())}`),
  dismissIdentityProposal: (id: string) =>
    apiRequest<PersonalitySnapshot>("/api/personality/identity/dismiss", { method: "POST", body: { id } }),
  saveRelationship: (body: RelationshipWriteRequest) =>
    apiRequest<IdentitySaved>("/api/personality/relationship", { method: "POST", body }),
  rollbackRelationship: (body: RelationshipRollbackRequest) =>
    apiRequest<IdentitySaved>("/api/personality/relationship/rollback", { method: "POST", body }),
  getRecentWork: (topicId?: string, signal?: AbortSignal) =>
    apiRequest<RecentWorkSnapshot>(`/api/personality/recent-work${topicId ? `?topicId=${encodeURIComponent(topicId)}` : ""}`, { signal }),
  refreshRecentWork: (topicId?: string, signal?: AbortSignal) =>
    apiRequest<RecentWorkSnapshot>("/api/personality/recent-work/refresh", { method: "POST", body: { topicId }, signal }),
  readIdentityFile: (file: IdentityFile, lang?: KuloLanguage) =>
    apiRequest<IdentityRead>(`/api/identity/file?file=${encodeURIComponent(file)}&lang=${encodeURIComponent(normalizeKuloLanguage(lang) ?? getLanguage())}`),
  readIdentityBackup: (file: IdentityFile, backupId: string) =>
    apiRequest<IdentityBackup & { content: string }>(`/api/identity/backup?file=${encodeURIComponent(file)}&backupId=${encodeURIComponent(backupId)}`),
  saveIdentityFile: (body: IdentityWriteRequest) =>
    apiRequest<IdentitySaved>("/api/identity/save", { method: "POST", body }),
  rollbackIdentityFile: (body: IdentityRollbackRequest) =>
    apiRequest<IdentitySaved>("/api/identity/rollback", { method: "POST", body }),
  probeMemory: () => apiRequest<HindsightProbeResult>("/api/memory/probe", { method: "POST" }),
  getMemoryService: (clientId?: string) =>
    apiRequest<MemoryServiceSnapshot>(`/api/memory/service${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`),
  prepareMemoryService: (body: MemoryServicePrepareRequest) =>
    apiRequest<MemoryServiceSnapshot>("/api/memory/service/prepare", { method: "POST", body }),
  saveMemoryConnection: (body: MemoryConnectionUpdateRequest) =>
    apiRequest<MemoryConnectionUpdateResult>("/api/memory/service/connection", { method: "POST", body }),
  probeMemoryConnection: (body: MemoryConnectionUpdateRequest) =>
    apiRequest<MemoryConnectionUpdateResult>("/api/memory/service/connection/probe", { method: "POST", body }),
  submitMemoryServiceInput: (id: string, body: { clientId: string; secret?: string; cancel?: boolean }) =>
    apiRequest<MemoryServiceSnapshot>(`/api/memory/service/inputs/${encodeURIComponent(id)}`, { method: "POST", body }),
  decideMemoryService: (id: string, body: { clientId: string; decision: "confirm" | "reject" }) =>
    apiRequest<MemoryServiceSnapshot>(`/api/memory/service/jobs/${encodeURIComponent(id)}/decision`, { method: "POST", body }),
  setMemoryEnabled: (body: { enabled: boolean; expectedRevision: number }) =>
    apiRequest<MemoryServiceSnapshot>("/api/memory/service/enabled", { method: "POST", body }),
  setMemoryKnowledgeGuidance: (body: { enabled: boolean; expectedRevision: number }) =>
    apiRequest<MemoryServiceSnapshot>("/api/memory/service/knowledge-guidance", { method: "POST", body }),
  probeModel: (body?: ModelProbeRequest) =>
    apiRequest<ModelProbeResult>("/api/model/probe", { method: "POST", body: body ?? {} }),
  listProviders: () => apiRequest<{ providers: ProviderCatalogItem[]; presets?: Array<{ id: string; name: string; api: CustomProviderApi; baseUrl: string }> }>("/api/providers"),
  setProviderApiKey: (providerId: string, apiKey: string) =>
    apiRequest<{ provider: ProviderCatalogItem }>(`/api/providers/${encodeURIComponent(providerId)}/api-key`, { method: "POST", body: { apiKey } })
      .then((result) => { providerCatalog.updateProvider(result.provider); return result; }),
  logoutProvider: (providerId: string) =>
    apiRequest<{ ok: boolean; provider: ProviderCatalogItem | null }>(`/api/providers/${encodeURIComponent(providerId)}/auth`, { method: "DELETE" })
      .then((result) => { providerCatalog.updateProvider(result.provider, providerId); return result; }),
  refreshProviderModels: (providerId: string, options?: { signal?: AbortSignal }) =>
    apiRequest<{ provider: ProviderCatalogItem }>(`/api/providers/${encodeURIComponent(providerId)}/refresh`, { method: "POST", ...options })
      .then((result) => { providerCatalog.updateProvider(result.provider); return result; }),
  discoverProviderModels: (payload: DiscoverModelsRequest, options?: { signal?: AbortSignal }) =>
    apiRequest<DiscoverModelsResponse>("/api/providers/discover-models", { method: "POST", body: payload, signal: options?.signal }),
  resolveModelMetadata: (payload: ResolveModelMetadataRequest, options?: { signal?: AbortSignal }) =>
    apiRequest<ResolveModelMetadataResponse>("/api/providers/resolve-model", { method: "POST", body: payload, signal: options?.signal }),
  startProviderOAuth: (providerId: string) =>
    apiRequest<{ session: OAuthSessionView }>(`/api/providers/${encodeURIComponent(providerId)}/oauth/start`, { method: "POST" }),
  getProviderOAuth: (sessionId: string) =>
    apiRequest<{ session: OAuthSessionView }>(`/api/providers/oauth/${encodeURIComponent(sessionId)}`),
  respondProviderOAuth: (sessionId: string, promptId: string | undefined, value: string) =>
    apiRequest<{ session: OAuthSessionView }>(`/api/providers/oauth/${encodeURIComponent(sessionId)}/respond`, { method: "POST", body: { promptId, value } }),
  cancelProviderOAuth: (sessionId: string) =>
    apiRequest<{ session: OAuthSessionView }>(`/api/providers/oauth/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" }),
  uploadFile: async (
    file: File,
    overrideName?: string,
    options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void; presentation?: "voice"; recordedDuration?: number; idempotencyKey?: string } = {},
  ): Promise<ChatAttachment> => {
    await ensureMediaSession();
    if (options.signal?.aborted) throw new DOMException(t("上传已取消", "Upload cancelled"), "AbortError");
    const fileName = (overrideName || file.name || "attachment").trim() || "attachment";
    return new Promise<ChatAttachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const params = new URLSearchParams({ name: fileName });
      if (options.presentation) params.set("presentation", options.presentation);
      if (options.recordedDuration !== undefined) params.set("recordedDuration", String(options.recordedDuration));
      xhr.open("POST", `/api/uploads?${params}`);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(fileName));
      if (options.idempotencyKey) xhr.setRequestHeader("X-Upload-Id", options.idempotencyKey);
      const token = getAuthTokenFromUrl();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      const abort = () => xhr.abort();
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      options.signal?.addEventListener("abort", abort, { once: true });
      xhr.upload.onprogress = (event) => options.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
      xhr.onerror = () => { cleanup(); reject(new KuloApiError(0, t("上传连接中断，请重试", "The upload connection was interrupted. Try again"))); };
      xhr.onabort = () => { cleanup(); reject(new DOMException(t("上传已取消", "Upload cancelled"), "AbortError")); };
      xhr.onload = () => {
        cleanup();
        let data: { attachment?: ChatAttachment; error?: string; code?: string };
        try { data = JSON.parse(xhr.responseText); }
        catch { reject(new KuloApiError(xhr.status, t("服务器未返回有效的附件信息", "The server returned invalid attachment information"))); return; }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new KuloApiError(xhr.status, data.error || t(`上传失败 (HTTP ${xhr.status})`, `Upload failed (HTTP ${xhr.status})`), data.code)); return;
        }
        if (!data.attachment?.id) { reject(new KuloApiError(500, t("服务器未返回有效的附件信息", "The server returned invalid attachment information"))); return; }
        options.onProgress?.(file.size, file.size);
        resolve(data.attachment);
      };
      xhr.send(file);
    });
  },
};

export const providerCatalog = new ProviderCatalogCache(() => kuloRest.listProviders());
