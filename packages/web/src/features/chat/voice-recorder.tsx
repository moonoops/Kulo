import { translate as tr, useI18n } from "../../moco-i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { pauseOtherMedia } from "./media-message";
import { MocoIcon } from "../../moco-icon";
import { isMicrophonePermissionFailure, microphonePermissionFailureMessage } from "../system-permissions/permission-recovery";
import { noteMicrophoneAccess } from "../system-permissions/system-permissions";

export function MicrophoneGlyph() {
  return <MocoIcon name="microphone" size={20} />;
}

export function RecordingStopGlyph() {
  return <MocoIcon name="stop" size={20} />;
}

export function RecordingWaveform({ levels }: { levels: readonly number[] }) {
  return <svg className="moco-composer-waveform" viewBox="0 0 480 32" preserveAspectRatio="none" aria-hidden="true">
    {Array.from({ length: 80 }, (_, index) => {
      const height = 2 + (levels[index - (80 - levels.length)] ?? 0) * 26;
      return <line key={index} x1={index * 6 + 3} x2={index * 6 + 3} y1={16 - height / 2} y2={16 + height / 2} />;
    })}
  </svg>;
}

export interface VoiceRecording { id: string; file: File; duration: number }
export interface VoiceTranscribeOptions { signal: AbortSignal; onProgress: (loaded: number, total: number) => void }
export type TranscribeVoice = (recording: VoiceRecording, options: VoiceTranscribeOptions) => Promise<string>;
type RecorderPhase = "idle" | "requesting" | "recording" | "transcribing" | "error";
const MAX_RECORDING_BYTES = 50 * 1024 * 1024;

export function useVoiceRecorder(conversationKey: string | undefined, onTranscribe?: TranscribeVoice, onTranscript?: (text: string) => void) {
  useI18n();
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [error, setError] = useState<string>();
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState<number>();
  const [levels, setLevels] = useState<number[]>([]);
  const [canRetry, setCanRetry] = useState(false);
  const [permissionRequired, setPermissionRequired] = useState(false);
  const phaseRef = useRef<RecorderPhase>("idle");
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const meterRef = useRef<{ context: AudioContext; timer?: ReturnType<typeof setInterval> } | undefined>(undefined);
  const pendingRef = useRef<VoiceRecording | undefined>(undefined);
  const transcriptionRef = useRef<AbortController | undefined>(undefined);
  const operationRef = useRef(0);
  const startedAtRef = useRef(0);
  const stopAtRef = useRef<number | undefined>(undefined);
  const transcribeRef = useRef(onTranscribe); transcribeRef.current = onTranscribe;
  const transcriptRef = useRef(onTranscript); transcriptRef.current = onTranscript;

  const changePhase = useCallback((next: RecorderPhase) => { phaseRef.current = next; setPhase(next); }, []);
  const releaseMeter = useCallback(() => {
    const meter = meterRef.current; meterRef.current = undefined;
    if (!meter) return;
    clearInterval(meter.timer);
    if (meter.context.state !== "closed") void meter.context.close().catch((cause: unknown) => console.warn(tr("无法关闭录音音量检测", "Unable to close recording level meter"), cause));
  }, []);
  const releaseCapture = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    if (recorder) {
      recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    releaseMeter();
  }, [releaseMeter]);
  const cleanup = useCallback(() => {
    operationRef.current++;
    releaseCapture();
    transcriptionRef.current?.abort(); transcriptionRef.current = undefined;
    pendingRef.current = undefined;
  }, [releaseCapture]);
  const discard = useCallback(() => {
    cleanup(); changePhase("idle"); setError(undefined); setDuration(0); setProgress(undefined); setLevels([]); setCanRetry(false); setPermissionRequired(false);
  }, [cleanup, changePhase]);

  const transcribe = useCallback(async (recording: VoiceRecording, operation: number) => {
    if (operation !== operationRef.current) return;
    const controller = new AbortController();
    transcriptionRef.current = controller;
    changePhase("transcribing"); setError(undefined); setProgress(0); setCanRetry(false);
    try {
      if (!transcribeRef.current) throw new Error(tr("语音转写尚未就绪", "Voice transcription is not ready"));
      const text = (await transcribeRef.current(recording, { signal: controller.signal, onProgress: (loaded, total) => {
        if (operation === operationRef.current && total > 0) setProgress(Math.min(100, Math.round(loaded / total * 100)));
      } })).trim();
      if (operation !== operationRef.current || controller.signal.aborted) return;
      if (!text) throw new Error(tr("没有识别到文字，请重新录制", "No speech recognized. Please record again."));
      pendingRef.current = undefined; transcriptionRef.current = undefined;
      setProgress(undefined); setDuration(0); setLevels([]); changePhase("idle");
      transcriptRef.current?.(text);
    } catch (cause) {
      if (operation !== operationRef.current || controller.signal.aborted) return;
      transcriptionRef.current = undefined;
      setError(cause instanceof Error ? cause.message : tr("语音转写失败，请重试", "Voice transcription failed. Please retry."));
      setCanRetry(true); changePhase("error");
    }
  }, [changePhase]);

  const start = useCallback(async () => {
    if (!transcribeRef.current || ["requesting", "recording", "transcribing"].includes(phaseRef.current) || pendingRef.current) return;
    cleanup();
    const operation = operationRef.current;
    stopAtRef.current = undefined;
    setError(undefined); setDuration(0); setProgress(undefined); setLevels([]); setCanRetry(false); setPermissionRequired(false); changePhase("requesting");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined") {
      setError(window.isSecureContext ? tr("当前浏览器不支持录音，请上传音频文件", "Recording is unavailable in this browser. Upload an audio file instead.") : tr("录音需要 HTTPS 或本机地址，也可上传音频文件", "Recording requires HTTPS or a local address. You can also upload an audio file."));
      changePhase("error"); return;
    }
    let stream: MediaStream | undefined;
    try {
      pauseOtherMedia();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      noteMicrophoneAccess(true);
      if (operation !== operationRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const meter = { context: audioContext, timer: undefined as ReturnType<typeof setInterval> | undefined };
      meterRef.current = meter;
      await audioContext.resume();
      if (operation !== operationRef.current) return;
      const samples = new Float32Array(analyser.fftSize);
      meter.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        setLevels((current) => [...current.slice(-79), Math.min(1, rms * 5)]);
      }, 70);
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      const recordingId = `recording-${crypto.randomUUID()}`;
      let size = 0;
      let failed = false;
      recorderRef.current = recorder;
      const fail = (message: string) => {
        if (operation !== operationRef.current) return;
        failed = true; releaseCapture(); setError(message); changePhase("error");
      };
      recorder.ondataavailable = (event) => {
        if (!event.data.size || failed || operation !== operationRef.current) return;
        size += event.data.size;
        if (size > MAX_RECORDING_BYTES) { fail(tr("录音超过 50 MB，请重新录制", "Recording exceeds 50 MB. Please record again.")); return; }
        chunks.push(event.data);
      };
      recorder.onerror = () => fail(tr("录音中断，请重新录制", "Recording interrupted. Please record again."));
      recorder.onstop = () => {
        stream?.getTracks().forEach((track) => track.stop());
        if (operation !== operationRef.current || failed) return;
        recorderRef.current = undefined; streamRef.current = undefined; releaseMeter();
        if (stopAtRef.current === undefined) { setError(tr("录音已中断，请重新录制", "Recording interrupted. Please record again.")); changePhase("error"); return; }
        if (!chunks.length) { setError(tr("没有录到声音，请重新录制", "No audio recorded. Please record again.")); changePhase("error"); return; }
        const mime = recorder.mimeType || chunks[0]!.type || "audio/webm";
        const extension = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
        const elapsed = Math.max(0, (stopAtRef.current - startedAtRef.current) / 1000);
        const recording = { id: recordingId, file: new File(chunks, tr(`语音输入.${extension}`, `Voice input.${extension}`), { type: mime }), duration: elapsed };
        pendingRef.current = recording; setDuration(elapsed);
        void transcribe(recording, operation);
      };
      recorder.start(1000);
      startedAtRef.current = performance.now(); changePhase("recording");
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop());
      if (operation !== operationRef.current) return;
      releaseCapture();
      const needsPermission = isMicrophonePermissionFailure(cause);
      if (needsPermission) noteMicrophoneAccess(false);
      setPermissionRequired(needsPermission);
      setError(needsPermission ? microphonePermissionFailureMessage() : cause instanceof DOMException && cause.name === "NotFoundError" ? tr("未找到麦克风，可上传音频文件", "No microphone found. You can upload an audio file.") : tr("无法开始录音，请重试", "Unable to start recording. Please retry."));
      changePhase("error");
    }
  }, [cleanup, changePhase, transcribe, releaseCapture, releaseMeter]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (phaseRef.current !== "recording" || recorder?.state !== "recording") return;
    stopAtRef.current = performance.now(); changePhase("transcribing"); releaseMeter(); recorder.stop();
  }, [changePhase, releaseMeter]);
  const retry = useCallback(() => {
    const recording = pendingRef.current;
    if (recording && phaseRef.current === "error") void transcribe(recording, operationRef.current);
    else if (!recording) void start();
  }, [transcribe, start]);

  useLayoutEffect(() => { discard(); return cleanup; }, [conversationKey, discard, cleanup]);
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setDuration((performance.now() - startedAtRef.current) / 1000), 250);
    return () => clearInterval(timer);
  }, [phase]);
  return { phase, error, duration, progress, levels, canRetry, permissionRequired, start, stop, discard, retry };
}
