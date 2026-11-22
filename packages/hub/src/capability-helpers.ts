import { createHash } from "node:crypto";
import type {
  CapabilityRecord, CustomImageAdapter, CustomModelConfig, CustomProviderApi,
  ImageModelProfile, MediaAdapterId,
} from "@kulo/protocol";
import {
  cleanGoogleImageModelId, defaultProtocolAdapterForModel, getImageModelPreset, inferModelPurpose,
  isOfficialVertexBaseUrl, normalizeImageGenerationParameters, resolveVertexImageBaseUrl,
  validateCustomImageAdapter, validateImageModelProfile,
} from "@kulo/protocol";

export interface SyncedProviderImageSource {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  preset?: string;
  vertexProject?: string;
  vertexLocation?: string;
  models: readonly CustomModelConfig[];
}

export interface DesiredSyncedImageModel {
  capabilityId: string;
  connectionId: string;
  providerId: string;
  providerName: string;
  capabilityName: string;
  adapter: "openai-image" | "gemini-image" | "vertex-image" | "custom-image";
  baseUrl: string;
  modelId: string;
  profile: ImageModelProfile;
  defaults: NonNullable<CapabilityRecord["defaults"]>;
  customAdapter?: CustomImageAdapter;
  syncSignature: string;
}

export function isGoogleImageAdapter(adapter: string | undefined): adapter is "gemini-image" | "vertex-image" {
  return adapter === "gemini-image" || adapter === "vertex-image";
}

export function isOfficialGoogleImageHost(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname === "generativelanguage.googleapis.com" || isOfficialVertexBaseUrl(parsed.toString());
  } catch {
    return false;
  }
}

export function capabilityFingerprint(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return item;
  }
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}

export function normalizeCapabilityUrl(
  value: unknown,
  adapter: MediaAdapterId,
  fail: (status: number, code: string, message: string) => never,
  readText: (raw: unknown, label: string, max?: number) => string,
): string {
  if (adapter === "custom-image" && value === undefined) fail(400, "invalid_capability_url", "请填写自定义服务地址。");
  const defaultUrl = adapter === "openai-image"
    ? "https://api.openai.com/v1"
    : adapter === "vertex-image"
      ? "https://aiplatform.googleapis.com/v1"
      : "https://generativelanguage.googleapis.com/v1beta";
  const raw = value === undefined ? defaultUrl : readText(value, "服务地址", 2048);
  let url: URL;
  try { url = new URL(raw); } catch { return fail(400, "invalid_capability_url", "服务地址必须是有效的 HTTP 或 HTTPS 地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    fail(400, "invalid_capability_url", "服务地址不能包含凭证、查询参数或片段。");
  }
  const cleanPath = url.pathname.replace(/\/+$/, "");
  const officialVertex = isOfficialVertexBaseUrl(url.toString());
  if (adapter === "vertex-image") {
    if (!cleanPath) url.pathname = "/v1";
    else if (officialVertex && /\/v1beta$/i.test(cleanPath)) url.pathname = cleanPath.replace(/\/v1beta$/i, "/v1");
    else if (!cleanPath.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part))) url.pathname = `${cleanPath}/v1`;
  } else if (!cleanPath) {
    url.pathname = adapter === "openai-image" || officialVertex ? "/v1" : "/v1beta";
  } else if (adapter === "gemini-image" && url.hostname !== "generativelanguage.googleapis.com" && !officialVertex && /\/v1$/i.test(cleanPath)) {
    url.pathname = cleanPath.replace(/\/v1$/i, "/v1beta");
  } else if (adapter === "openai-image" && url.hostname !== "api.openai.com" && /\/v1beta$/i.test(cleanPath)) {
    url.pathname = cleanPath.replace(/\/v1beta$/i, "/v1");
  }
  return url.toString().replace(/\/+$/, "");
}

export async function capabilityMetadataMatches(
  response: Response,
  adapter: MediaAdapterId,
  modelId: string,
  failTooLarge: () => never,
): Promise<boolean> {
  if (!response.body) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 64 * 1024) failTooLarge();
      chunks.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return adapter === "gemini-image"
      ? object.name === `models/${cleanGoogleImageModelId(modelId)}`
      : object.id === modelId;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function planSyncedProviderImageModels(
  providers: readonly SyncedProviderImageSource[],
  normalizeUrl: (value: unknown, adapter: MediaAdapterId) => string,
): Map<string, DesiredSyncedImageModel> {
  const desired = new Map<string, DesiredSyncedImageModel>();
  for (const p of providers) {
    if (!p.id?.trim() || !p.baseUrl?.trim()) continue;
    for (const m of p.models ?? []) {
      if (inferModelPurpose(m) !== "image") continue;
      const inferredAdapter: DesiredSyncedImageModel["adapter"] = m.protocolAdapter === "custom-image" && m.customImageAdapter
        ? "custom-image"
        : p.api === "google-vertex" && (!m.protocolAdapter || m.protocolAdapter === "gemini-image" || m.protocolAdapter === "vertex-image")
          ? "vertex-image"
          : m.protocolAdapter === "vertex-image"
            ? "vertex-image"
            : m.protocolAdapter === "gemini-image"
              ? "gemini-image"
              : m.protocolAdapter === "openai-image"
                ? "openai-image"
                : (() => {
                    const fallback = defaultProtocolAdapterForModel("image", m.id, p.api, p.preset);
                    return fallback === "vertex-image" ? "vertex-image" : fallback === "gemini-image" ? "gemini-image" : "openai-image";
                  })();
      const cleanId = isGoogleImageAdapter(inferredAdapter) ? cleanGoogleImageModelId(m.id) : m.id.trim();
      if (!cleanId || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(cleanId)) continue;
      if (inferredAdapter === "openai-image" && /^dall-e-/i.test(cleanId)) continue;
      let baseUrl: string;
      try {
        const candidateUrl = p.api === "google-vertex" && inferredAdapter === "vertex-image"
          ? resolveVertexImageBaseUrl(p.baseUrl, { vertexProject: p.vertexProject, vertexLocation: p.vertexLocation })
          : p.baseUrl;
        baseUrl = normalizeUrl(candidateUrl, inferredAdapter);
      } catch {
        continue;
      }
      const preset = getImageModelPreset(inferredAdapter, cleanId);
      let profile: ImageModelProfile;
      try {
        if (preset) {
          const userFormats = m.imageProfile?.formats?.filter((f) => preset.profile.formats.includes(f));
          profile = validateImageModelProfile({
            ...preset.profile,
            ...(userFormats?.length ? { formats: userFormats } : {}),
            ...(m.imageProfile?.supportsEdit !== undefined ? {
              supportsEdit: m.imageProfile.supportsEdit && preset.profile.supportsEdit,
              maxReferences: m.imageProfile.supportsEdit && preset.profile.supportsEdit ? preset.profile.maxReferences : 0,
            } : {}),
          });
        } else {
          profile = validateImageModelProfile(m.imageProfile ?? {
            formats: isGoogleImageAdapter(inferredAdapter) ? ["jpeg", "png"] : ["png", "jpeg", "webp"],
            supportsEdit: true,
            maxReferences: 4,
          });
        }
      } catch {
        continue;
      }
      let defaults: NonNullable<CapabilityRecord["defaults"]>;
      try {
        defaults = normalizeImageGenerationParameters(
          m.imageDefaults ?? preset?.defaults ?? { format: profile.formats[0] ?? "png", count: 1 },
          profile,
          inferredAdapter,
        );
      } catch {
        defaults = { format: profile.formats[0] ?? "png", count: 1 };
      }
      const customAdapter = inferredAdapter === "custom-image"
        ? (() => { try { return validateCustomImageAdapter(m.customImageAdapter!); } catch { return undefined; } })()
        : undefined;
      if (inferredAdapter === "custom-image" && (!customAdapter || profile.supportsEdit && !customAdapter.edit)) continue;
      const capabilityId = `cap-model-${capabilityFingerprint({ providerId: p.id, modelId: cleanId }).slice(0, 20)}`;
      const connectionId = `media-model-${capabilityFingerprint({ providerId: p.id, adapter: inferredAdapter, baseUrl, customAdapter: customAdapter ?? null }).slice(0, 20)}`;
      const capabilityName = (m.name?.trim() || cleanId).slice(0, 100);
      const syncSignature = capabilityFingerprint({ connectionId, modelId: cleanId, capabilityName, profile, defaults });
      desired.set(capabilityId, {
        capabilityId, connectionId, providerId: p.id, providerName: (p.name?.trim() || p.id).slice(0, 100),
        capabilityName, adapter: inferredAdapter, baseUrl, modelId: cleanId, profile, defaults, customAdapter, syncSignature,
      });
    }
  }
  return desired;
}
