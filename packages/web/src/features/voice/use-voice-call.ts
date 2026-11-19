/// <reference types="vite/client" />
import { useCallback, useEffect, useRef, useState } from "react";
import { translate as t } from "../../kulo-i18n";
import { redactSecrets, type VoiceCallEvent, type VoiceCallSession, type VoiceCallState } from "@kulo/protocol";
import { pauseOtherMedia } from "../chat/media-message";
import { voiceApi, voiceSocketUrl } from "./voice-api";
import { MicrophoneActivity, Pcm16Resampler, VoicePlayback, pcm16Base64 } from "./voice-audio";
import voiceCaptureWorkletUrl from "./voice-capture.worklet.js?url&no-inline";
import { isMicrophonePermissionFailure, microphonePermissionFailureMessage } from "../system-permissions/permission-recovery";
import { noteMicrophoneAccess } from "../system-permissions/system-permissions";

export interface VoiceCallTarget { topicId: string; title: string; projectId?: string }
export interface VoiceCaption { id: string; role: "user" | "assistant"; text: string; final: boolean }
export interface ActiveVoiceCall {
  target: VoiceCallTarget;
  state: VoiceCallState;
  startedAt?: number;
  muted: boolean;
  captionsEnabled: boolean;
  captions: VoiceCaption[];
  minimized: boolean;
  error?: string;
  permissionRequired?: "microphone";
}

export function mergeVoiceCaption(previous: VoiceCaption[], event: Extract<VoiceCallEvent, { type: "transcript" }>): VoiceCaption[] {
  const last = previous.at(-1);
  const id = event.id ?? (last?.role === event.role && !last.final ? last.id : `${event.role}-${previous.length}`);
  const index = previous.findIndex((item) => item.id === id && item.role === event.role);
  if (index < 0) return [...previous.slice(-79), { id, role: event.role, text: event.text, final: event.final }];
  return previous.map((item, at) => at === index ? { ...item, text: event.text, final: event.final } : item);
}

export const VOICE_CAPTURE_WORKLET_URL = voiceCaptureWorkletUrl;

export function formatVoiceCallError(error: unknown): string {
  if (isMicrophonePermissionFailure(error)) return microphonePermissionFailureMessage();
  if (error instanceof DOMException && error.name === "NotFoundError") return t("未找到麦克风", "No microphone found");
  const raw = error instanceof Error ? error.message : "";
  if (/worklet module/i.test(raw)) return t("无法初始化语音采集模块，请刷新页面后重试", "Unable to initialize voice capture. Refresh and try again");
  const cleaned = redactSecrets(raw.replace(/\bdata:[a-z0-9.+/-]+(?:;[^,\s)]+)*,[^\s)]+/gi, "[data-url]")).replace(/\s+/g, " ").trim();
  return cleaned || t("通话连接失败，请重试", "Call connection failed. Try again");
}

function callError(error: unknown): string {
  return formatVoiceCallError(error);
}

interface CallResources {
  operation: number;
  controller: AbortController;
  context: AudioContext;
  session?: VoiceCallSession;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  capture?: AudioWorkletNode;
  socket?: WebSocket;
  playback: VoicePlayback;
  timer?: ReturnType<typeof setTimeout>;
  ready: boolean;
  muted: boolean;
  playing: boolean;
  activity: MicrophoneActivity;
}

export function useVoiceCall(clientId: string, beforeStart: () => void) {
  const [call, setCall] = useState<ActiveVoiceCall | null>(null);
  const resources = useRef<CallResources | undefined>(undefined);
  const operation = useRef(0);
  const mounted = useRef(true);

  const release = useCallback((remote = true) => {
    const current = resources.current;
    resources.current = undefined;
    if (!current) return;
    clearTimeout(current.timer); current.controller.abort(); current.ready = false;
    if (current.capture) { current.capture.port.onmessage = null; current.capture.port.close(); current.capture.disconnect(); }
    current.source?.disconnect();
    current.stream?.getTracks().forEach((track) => track.stop());
    current.playback.interrupt();
    if (current.socket) {
      current.socket.onopen = null; current.socket.onmessage = null; current.socket.onerror = null; current.socket.onclose = null;
      if (current.socket.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ type: "close" }));
      current.socket.close();
    }
    if (current.context.state !== "closed") void current.context.close().catch((error: unknown) => {
      if (mounted.current && operation.current === current.operation) setCall((previous) => previous ? { ...previous, error: callError(error) } : previous);
    });
    if (remote && current.session) void voiceApi.closeCall(current.session.id, clientId).catch((error: unknown) => {
      if (mounted.current && operation.current === current.operation) setCall((previous) => previous ? { ...previous, error: callError(error) } : previous);
    });
  }, [clientId]);

  const hangup = useCallback(() => { operation.current++; release(); setCall(null); }, [release]);
  const fail = useCallback((message: string, permissionRequired?: "microphone") => {
    operation.current++; release();
    if (mounted.current) setCall((previous) => previous ? { ...previous, state: "ended", minimized: false, error: message, permissionRequired } : previous);
  }, [release]);

  const start = useCallback(async (target: VoiceCallTarget) => {
    if (resources.current) { setCall((previous) => previous ? { ...previous, minimized: false } : previous); return; }
    beforeStart(); pauseOtherMedia();
    const currentOperation = ++operation.current;
    setCall({ target, state: "connecting", muted: false, captionsEnabled: false, captions: [], minimized: false });
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error(t("通话需要 HTTPS 或本机地址，并允许麦克风访问", "Calls require HTTPS or localhost and microphone access"));
      if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") throw new Error(t("当前浏览器不支持实时语音", "This browser does not support real-time voice"));
      const context = new AudioContext({ latencyHint: "interactive" });
      const playback = new VoicePlayback(context, (playing) => {
        const live = resources.current;
        if (!live || live.operation !== currentOperation) return;
        live.playing = playing;
        if (mounted.current) setCall((previous) => !previous || previous.state === "ended" ? previous : {
          ...previous, state: playing ? "speaking" : previous.state === "speaking" ? "listening" : previous.state,
        });
      });
      const current: CallResources = { operation: currentOperation, controller: new AbortController(), context, playback, ready: false, muted: false, playing: false, activity: new MicrophoneActivity() };
      resources.current = current;
      await context.resume();
      if (currentOperation !== operation.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      noteMicrophoneAccess(true);
      if (currentOperation !== operation.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      current.stream = stream;
      stream.getAudioTracks().forEach((track) => { track.enabled = !current.muted; });
      try {
        const workletUrl = new URL(voiceCaptureWorkletUrl, window.location.href);
        if (workletUrl.origin !== window.location.origin) throw new Error("Cross-origin voice capture worklet");
        await context.audioWorklet.addModule(workletUrl.href);
      } catch (workletError) {
        console.warn("Voice capture worklet failed to load", callError(workletError));
        throw new Error(t("无法初始化语音采集模块，请刷新页面后重试", "Unable to initialize voice capture. Refresh and try again"));
      }
      if (currentOperation !== operation.current) return;
      const session = await voiceApi.createCall({ topicId: target.topicId, ...(target.projectId ? { projectId: target.projectId } : {}), clientId, commandId: `voice-${crypto.randomUUID()}` }, current.controller.signal);
      current.session = session;
      if (currentOperation !== operation.current) {
        void voiceApi.closeCall(session.id, clientId).catch((error: unknown) => { console.warn("Voice session cleanup failed", callError(error)); });
        return;
      }
      const socket = new WebSocket(voiceSocketUrl(session.wsPath, clientId));
      current.socket = socket;
      const capture = new AudioWorkletNode(context, "kulo-voice-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const source = context.createMediaStreamSource(stream);
      current.capture = capture; current.source = source;
      const resampler = new Pcm16Resampler(context.sampleRate, session.inputSampleRate);
      capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (resources.current !== current || !current.ready || current.muted || socket.readyState !== WebSocket.OPEN) return;
        const frame = event.data;
        if (!(frame instanceof Float32Array)) return;
        if (current.activity.observe(frame, context.sampleRate, performance.now()) && current.playing) playback.interrupt();
        const pcm = resampler.push(frame);
        if (!pcm.length) return;
        if (socket.bufferedAmount > 512 * 1024) { fail(t("通话网络拥堵，请重新连接", "The call network is congested. Reconnect to continue")); return; }
        socket.send(JSON.stringify({ type: "audio", data: pcm16Base64(pcm) }));
      };
      source.connect(capture); capture.connect(context.destination);
      current.timer = setTimeout(() => { if (!current.ready && resources.current === current) fail(t("通话连接超时，请重试", "The call connection timed out. Try again")); }, 30_000);
      socket.onmessage = (event) => {
        if (resources.current !== current) return;
        try {
          const message = JSON.parse(String(event.data)) as VoiceCallEvent;
          if (message.type === "state") {
            if (message.state === "ended") { release(false); setCall((previous) => previous ? { ...previous, state: "ended" } : previous); return; }
            if (message.state !== "connecting" && message.state !== "reconnecting") {
              if (!current.ready) socket.send(JSON.stringify({ type: "mute", muted: current.muted }));
              current.ready = true; clearTimeout(current.timer);
            }
            setCall((previous) => previous ? { ...previous, state: current.playing ? "speaking" : message.state, startedAt: previous.startedAt ?? (current.ready ? Date.now() : undefined) } : previous);
          } else if (message.type === "audio") {
            if (!current.activity.isSpeaking(performance.now())) playback.enqueue(message.data, message.sampleRate);
          }
          else if (message.type === "interrupted") playback.interrupt();
          else if (message.type === "transcript") setCall((previous) => previous ? { ...previous, captions: mergeVoiceCaption(previous.captions, message) } : previous);
          else if (message.type === "error") fail(callError(new Error(message.message)));
        } catch (error) { fail(callError(error)); }
      };
      socket.onerror = () => fail(t("通话连接中断，请重试", "The call connection was interrupted. Try again"));
      socket.onclose = () => { if (resources.current === current) fail(t("通话连接已断开", "The call connection was closed")); };
    } catch (error) {
      if (currentOperation === operation.current) {
        const needsPermission = isMicrophonePermissionFailure(error);
        if (needsPermission) noteMicrophoneAccess(false);
        fail(callError(error), needsPermission ? "microphone" : undefined);
      }
    }
  }, [clientId, beforeStart, fail, release]);

  const toggleMute = useCallback(() => {
    const current = resources.current;
    if (!current) return;
    current.muted = !current.muted; current.activity.reset();
    current.stream?.getAudioTracks().forEach((track) => { track.enabled = !current.muted; });
    if (current.ready && current.socket?.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ type: "mute", muted: current.muted }));
    setCall((previous) => previous ? { ...previous, muted: current.muted } : previous);
  }, []);
  const minimize = useCallback(() => setCall((previous) => previous ? { ...previous, minimized: true } : previous), []);
  const expand = useCallback(() => setCall((previous) => previous ? { ...previous, minimized: false } : previous), []);
  const toggleCaptions = useCallback(() => setCall((previous) => previous ? { ...previous, captionsEnabled: !previous.captionsEnabled } : previous), []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++; release(); }; }, [release]);
  return { call, active: Boolean(call && call.state !== "ended"), start, hangup, toggleMute, toggleCaptions, minimize, expand };
}
