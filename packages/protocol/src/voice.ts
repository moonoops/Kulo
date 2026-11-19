export type VoiceTtsProvider = "minimax-cn" | "minimax-global" | "gemini" | "openai";
export type VoiceLiveProvider = "openai" | "gemini" | "vertex";
export type VoiceSpeed = "slow" | "normal" | "fast";
export type VoiceAsrStatus = "unprepared" | "preparing" | "ready" | "error";
export type VoiceAsrSource = "local" | "provider";

export interface VoiceSnapshot {
  revision: number;
  asr: {
    enabled: boolean;
    source?: VoiceAsrSource;
    providerId?: string;
    modelId?: string;
    hasCredential?: boolean;
    status: VoiceAsrStatus;
    progress?: number;
    error?: string;
  };
  tts: {
    enabled: boolean;
    provider?: VoiceTtsProvider;
    providerId?: string;
    modelId: string;
    voice: string;
    speed: VoiceSpeed;
    hasCredential: boolean;
  };
  call: {
    enabled: boolean;
    provider?: VoiceLiveProvider;
    providerId?: string;
    modelId: string;
    voice: string;
    hasCredential: boolean;
    status: "unverified" | "ready" | "error";
    lastCheckedAt?: number;
    error?: string;
  };
}

export interface VoiceSettingsInput {
  expectedRevision: number;
  asr?: {
    enabled: boolean;
    source?: VoiceAsrSource;
    providerId?: string;
    modelId?: string;
  };
  tts?: {
    enabled: boolean;
    provider?: VoiceTtsProvider;
    providerId?: string;
    modelId: string;
    voice: string;
    speed: VoiceSpeed;
    apiKey?: string;
  };
  call?: {
    enabled: boolean;
    provider?: VoiceLiveProvider;
    providerId?: string;
    modelId: string;
    voice: string;
    apiKey?: string;
  };
}

export type VoiceCallState = "connecting" | "listening" | "speaking" | "working" | "reconnecting" | "ended";
export type VoiceCallEvent =
  | { type: "state"; state: VoiceCallState }
  | { type: "audio"; data: string; sampleRate: number }
  | { type: "interrupted" }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean; id?: string }
  | { type: "error"; message: string; code?: string };

export type VoiceCallInput = { type: "audio"; data: string } | { type: "mute"; muted: boolean } | { type: "close" };
export interface VoiceCallSession {
  id: string;
  wsPath: string;
  inputSampleRate: number;
  outputSampleRate: number;
}
