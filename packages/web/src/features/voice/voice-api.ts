import type { MediaTranscript, VoiceCallSession, VoiceSettingsInput, VoiceSnapshot } from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";
import { apiRequest, ensureMediaSession, getAuthTokenFromUrl, KuloApiError } from "../../kulo-api";

export interface VoiceCallTarget { topicId: string; projectId?: string; title: string }

export function voiceSocketUrl(path: string, clientId: string): string {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error(t("通话连接地址无效", "Invalid call connection address"));
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientId", clientId);
  const token = getAuthTokenFromUrl();
  if (token) url.searchParams.set("token", token);
  return url.href;
}

export const voiceApi = {
  get: (signal?: AbortSignal) => apiRequest<VoiceSnapshot>("/api/voice", { signal }),
  save: (body: VoiceSettingsInput) => apiRequest<VoiceSnapshot>("/api/voice", { method: "PUT", body }),
  prepare: () => apiRequest<VoiceSnapshot>("/api/voice/asr/prepare", { method: "POST" }),
  probe: () => apiRequest<VoiceSnapshot>("/api/voice/call/probe", { method: "POST" }),
  transcribe: (body: { assetId: string; topicId?: string; projectId?: string; clientId: string }, signal?: AbortSignal) =>
    apiRequest<{ transcript: MediaTranscript }>("/api/voice/transcribe", { method: "POST", body, signal }),
  createCall: (body: { topicId: string; projectId?: string; clientId: string; commandId: string }, signal?: AbortSignal) =>
    apiRequest<VoiceCallSession>("/api/voice/calls", { method: "POST", body, signal }),
  closeCall: (id: string, clientId: string) =>
    apiRequest<void>(`/api/voice/calls/${encodeURIComponent(id)}`, { method: "DELETE", body: { clientId } }),
  synthesize: async (text: string, clientId: string, signal?: AbortSignal, preview = false): Promise<Blob> => {
    await ensureMediaSession();
    const token = getAuthTokenFromUrl();
    const response = await fetch("/api/voice/synthesize", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Accept: "audio/*", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text, clientId, ...(preview ? { preview: true } : {}) }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      throw new KuloApiError(response.status, error?.error ?? t(`语音合成失败 (HTTP ${response.status})`, `Speech synthesis failed (HTTP ${response.status})`), error?.code);
    }
    const blob = await response.blob();
    if (!blob.size || !blob.type.startsWith("audio/")) throw new Error(t("合成服务没有返回可播放的语音", "The synthesis service returned no playable audio"));
    return blob;
  },
};
