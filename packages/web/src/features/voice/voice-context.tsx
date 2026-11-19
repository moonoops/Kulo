import { translate as tr, useI18n } from "../../moco-i18n";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { redactSecrets, type VoiceSettingsInput, type VoiceSnapshot } from "@moco/protocol";
import { voiceApi } from "./voice-api";
import { useVoiceCall } from "./use-voice-call";
import { pauseOtherMedia } from "../chat/media-message";

export interface VoiceSpeechState { key: string; phase: "loading" | "playing" | "error"; error?: string }
export function voiceTtsFingerprint(snapshot: VoiceSnapshot): string {
  return JSON.stringify([snapshot.revision, snapshot.tts.provider, snapshot.tts.modelId, snapshot.tts.voice, snapshot.tts.speed]);
}
export interface VoiceWorkspace {
  clientId: string;
  connected: boolean;
  snapshot: VoiceSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (input: VoiceSettingsInput) => Promise<VoiceSnapshot>;
  prepare: () => Promise<VoiceSnapshot>;
  probe: () => Promise<VoiceSnapshot>;
  call: ReturnType<typeof useVoiceCall>;
  recordingActive: boolean;
  setRecordingActive: (active: boolean) => void;
  speech: VoiceSpeechState | null;
  speak: (text: string, key: string) => Promise<void>;
  stopSpeech: () => void;
}

const VoiceContext = createContext<VoiceWorkspace | null>(null);
export function useVoiceWorkspace(): VoiceWorkspace | null {
  useI18n(); return useContext(VoiceContext); }

export function VoiceProvider({ children, connected, clientId, updateVersion = 0, incoming, agentName }: {
  children: ReactNode;
  connected: boolean;
  clientId: string;
  updateVersion?: number;
  incoming?: VoiceSnapshot;
  agentName?: string;
}) {
  useI18n();
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speech, setSpeech] = useState<VoiceSpeechState | null>(null);
  const [recordingActive, setRecordingActive] = useState(false);
  const generation = useRef(0);
  const fetchController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const speaking = useRef<{ key: string; config: string; controller: AbortController; audio?: HTMLAudioElement } | null>(null);
  const cachedSpeech = useRef(new Map<string, { text: string; url: string }>());
  const accept = useCallback((next: VoiceSnapshot) => {
    if (mounted.current) setSnapshot((previous) => previous && previous.revision > next.revision ? previous : next);
    return next;
  }, []);
  const stopSpeech = useCallback(() => {
    const current = speaking.current; speaking.current = null;
    current?.controller.abort();
    if (current?.audio) { current.audio.pause(); current.audio.onended = null; current.audio.onerror = null; current.audio.removeAttribute("src"); current.audio.load(); }
    if (mounted.current) setSpeech(null);
  }, []);
  const call = useVoiceCall(clientId, stopSpeech);
  const ttsFingerprint = snapshot ? voiceTtsFingerprint(snapshot) : "";
  useEffect(() => {
    stopSpeech();
    for (const cached of cachedSpeech.current.values()) URL.revokeObjectURL(cached.url);
    cachedSpeech.current.clear();
  }, [ttsFingerprint, stopSpeech]);
  useEffect(() => { if (incoming) accept(incoming); }, [incoming, accept]);

  const refresh = useCallback(async () => {
    const id = ++generation.current;
    fetchController.current?.abort();
    const controller = new AbortController(); fetchController.current = controller;
    setLoading(true);
    try {
      const next = await voiceApi.get(controller.signal);
      if (id === generation.current && !controller.signal.aborted) { accept(next); setError(null); }
    } catch (failure) {
      if (id === generation.current && !controller.signal.aborted && mounted.current) setError(redactSecrets(failure instanceof Error ? failure.message : tr("语音配置加载失败", "Unable to load voice settings")));
    } finally { if (id === generation.current && mounted.current) setLoading(false); }
  }, [accept]);
  useEffect(() => {
    if (!connected) return;
    void refresh();
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onFocus);
    return () => { generation.current++; fetchController.current?.abort(); document.removeEventListener("visibilitychange", onFocus); };
  }, [connected, updateVersion, refresh]);
  useEffect(() => {
    if (!connected || snapshot?.asr.status !== "preparing") return;
    const timer = setTimeout(() => { void refresh(); }, 2000);
    return () => clearTimeout(timer);
  }, [connected, snapshot, refresh]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; generation.current++; fetchController.current?.abort(); stopSpeech();
      for (const cached of cachedSpeech.current.values()) URL.revokeObjectURL(cached.url);
      cachedSpeech.current.clear();
    };
  }, [stopSpeech]);

  const save = useCallback(async (input: VoiceSettingsInput) => {
    const next = accept(await voiceApi.save(input));
    setError(null); return next;
  }, [accept]);
  const prepare = useCallback(async () => accept(await voiceApi.prepare()), [accept]);
  const probe = useCallback(async () => accept(await voiceApi.probe()), [accept]);
  const speak = useCallback(async (text: string, key: string) => {
    const previous = speaking.current;
    if (previous?.key === key && previous.config === ttsFingerprint && previous.audio?.src) {
      try { pauseOtherMedia(previous.audio); await previous.audio.play(); if (speaking.current === previous) setSpeech({ key, phase: "playing" }); }
      catch (failure) { if (speaking.current === previous) setSpeech({ key, phase: "error", error: redactSecrets(failure instanceof Error ? failure.message : tr("语音无法播放，请重试", "Unable to play audio. Please retry.")) }); }
      return;
    }
    stopSpeech();
    if (!snapshot?.tts.enabled || !snapshot.tts.hasCredential) throw new Error(tr("请先启用语音合成", "Enable speech synthesis first"));
    if (call.active) throw new Error(tr("请在通话结束后朗读消息", "Wait until the call ends to read messages aloud"));
    const current = { key, config: ttsFingerprint, controller: new AbortController(), audio: undefined as HTMLAudioElement | undefined };
    speaking.current = current; setSpeech({ key, phase: "loading" });
    try {
      const cacheKey = `${ttsFingerprint}:${key}`;
      let cached = cachedSpeech.current.get(cacheKey);
      if (!cached || cached.text !== text) {
        if (cached) URL.revokeObjectURL(cached.url);
        const blob = await voiceApi.synthesize(text, clientId, current.controller.signal);
        if (speaking.current !== current || current.controller.signal.aborted) return;
        cached = { text, url: URL.createObjectURL(blob) };
        cachedSpeech.current.set(cacheKey, cached);
        if (cachedSpeech.current.size > 8) {
          const oldest = cachedSpeech.current.keys().next().value!;
          URL.revokeObjectURL(cachedSpeech.current.get(oldest)!.url); cachedSpeech.current.delete(oldest);
        }
      }
      const audio = new Audio(cached.url); current.audio = audio;
      audio.onended = () => { if (speaking.current === current) stopSpeech(); };
      audio.onerror = () => { if (speaking.current === current) setSpeech({ key, phase: "error", error: tr("语音无法播放，请重试", "Unable to play audio. Please retry.") }); };
      pauseOtherMedia(audio);
      await audio.play();
      if (speaking.current === current) setSpeech({ key, phase: "playing" });
    } catch (failure) {
      if (speaking.current !== current || current.controller.signal.aborted) return;
      setSpeech({ key, phase: "error", error: failure instanceof DOMException && failure.name === "NotAllowedError" ? tr("请再点一次播放", "Click play again") : redactSecrets(failure instanceof Error ? failure.message : tr("语音合成失败，请重试", "Speech synthesis failed. Please retry.")) });
    }
  }, [call.active, clientId, snapshot?.tts.enabled, snapshot?.tts.hasCredential, ttsFingerprint, stopSpeech]);

  return <VoiceContext.Provider value={{ clientId, connected, snapshot, loading, error, refresh, save, prepare, probe, call, recordingActive, setRecordingActive, speech, speak, stopSpeech }}>
    {children}
  </VoiceContext.Provider>;
}
