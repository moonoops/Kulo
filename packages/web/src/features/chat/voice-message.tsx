import { translate as tr, useI18n } from "../../kulo-i18n";
import { Button, Link, Popover, ProgressBar, Slider, Spinner } from "@heroui/react";
import type { ChatAttachment } from "@kulo/protocol";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { resolveAssetUrl } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { safeContentUrl } from "./asset-preview";
import { formatMediaTime, pauseOtherMedia, registerMedia } from "./media-message";
import { useVoiceWorkspace } from "../voice/voice-context";
import { voiceApi } from "../voice/voice-api";
import "../voice/voice.css";
import "./voice-message.css";

export function voiceDuration(asset: Pick<ChatAttachment, "duration" | "recordedDuration">, nativeDuration?: number): { seconds: number; approximate: boolean } {
  if (nativeDuration !== undefined && Number.isFinite(nativeDuration) && nativeDuration > 0) return { seconds: nativeDuration, approximate: false };
  if (asset.duration !== undefined && Number.isFinite(asset.duration) && asset.duration > 0) return { seconds: asset.duration, approximate: false };
  if (asset.recordedDuration !== undefined && Number.isFinite(asset.recordedDuration) && asset.recordedDuration > 0) return { seconds: asset.recordedDuration, approximate: true };
  return { seconds: 0, approximate: false };
}

export function voiceBubbleWidth(seconds: number): number {
  return Number.isFinite(seconds) ? Math.round(Math.max(120, Math.min(260, 120 + seconds * 2.4))) : 120;
}

function durationLabel(seconds: number, approximate: boolean): string {
  if (seconds <= 0) return tr("语音", "Voice");
  const total = Math.ceil(seconds);
  const duration = total < 60 ? `${total}″` : `${Math.floor(total / 60)}′${total % 60 ? `${total % 60}″` : ""}`;
  return approximate ? tr(`约 ${duration}`, `About ${duration}`) : duration;
}

function SoundGlyph() {
  return <KuloIcon name="speaker" size={22} />;
}

export function VoiceMessage({ asset, conversationKey }: { asset: ChatAttachment; conversationKey?: string }) {
  useI18n();
  const voice = useVoiceWorkspace();
  const source = safeContentUrl(resolveAssetUrl(asset.url));
  const mediaRef = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [time, setTime] = useState(0);
  const [nativeDuration, setNativeDuration] = useState<number>();
  const [error, setError] = useState<string>();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptText, setTranscriptText] = useState(asset.transcript?.text ?? "");
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string>();
  const [transcriptCopied, setTranscriptCopied] = useState(false);
  const transcriptRequest = useRef<AbortController | null>(null);
  const duration = voiceDuration(asset, nativeDuration);
  const label = durationLabel(duration.seconds, duration.approximate);
  useLayoutEffect(() => {
    request.current++;
    setLoaded(false); setPlaying(false); setBuffering(false); setTime(0); setNativeDuration(undefined); setError(undefined);
  }, [source]);
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const release = registerMedia(media, JSON.stringify([conversationKey ?? "", asset.id, source]));
    return () => { request.current++; release(); };
  }, [conversationKey, asset.id, source]);
  useEffect(() => {
    setOptionsOpen(false); setTranscriptOpen(false); setTranscriptText(asset.transcript?.text ?? ""); setTranscribing(false); setTranscriptError(undefined); setTranscriptCopied(false);
    return () => { transcriptRequest.current?.abort(); transcriptRequest.current = null; };
  }, [conversationKey, source, asset.id]);
  useEffect(() => { if (asset.transcript?.text) setTranscriptText(asset.transcript.text); }, [asset.transcript?.text]);
  useEffect(() => { if (!transcriptCopied) return; const timer = setTimeout(() => setTranscriptCopied(false), 1800); return () => clearTimeout(timer); }, [transcriptCopied]);
  const showTranscript = async () => {
    setOptionsOpen(false); setTranscriptError(undefined);
    if (transcriptOpen) { setTranscriptOpen(false); return; }
    if (transcriptText) { setTranscriptOpen(true); return; }
    if (!voice?.snapshot?.asr.enabled || transcribing) return;
    const controller = new AbortController(); transcriptRequest.current?.abort(); transcriptRequest.current = controller;
    setTranscribing(true);
    try {
      const result = await voiceApi.transcribe({ assetId: asset.id, clientId: voice.clientId, ...(conversationKey && !conversationKey.includes(":ticket:") ? { topicId: conversationKey } : {}) }, controller.signal);
      if (!controller.signal.aborted) {
        if (!result.transcript.text.trim()) throw new Error(tr("这段语音未能识别，请重试", "Unable to transcribe this recording. Please retry."));
        setTranscriptText(result.transcript.text); setTranscriptOpen(true);
      }
    } catch (failure) { if (!controller.signal.aborted) setTranscriptError(failure instanceof Error ? failure.message : tr("转文字失败，请重试", "Transcription failed. Please retry.")); }
    finally { if (transcriptRequest.current === controller) { transcriptRequest.current = null; if (!controller.signal.aborted) setTranscribing(false); } }
  };
  const play = async () => {
    const media = mediaRef.current;
    if (!media || !source) return;
    const ticket = ++request.current;
    setError(undefined); setBuffering(media.readyState < 3);
    pauseOtherMedia(media);
    try { await media.play(); }
    catch (cause) {
      if (ticket !== request.current || (cause instanceof DOMException && cause.name === "AbortError" && media.paused)) return;
      setPlaying(false); setBuffering(false);
      setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? tr("请再点一次播放", "Click play again") : tr("语音无法播放", "Unable to play voice message"));
    }
  };
  const toggle = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (!media.paused) { request.current++; media.pause(); setPlaying(false); setBuffering(false); }
    else void play();
  };
  const seek = (value: number | number[]) => {
    const media = mediaRef.current;
    if (!media || !loaded || duration.seconds <= 0) return;
    const end = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : duration.seconds;
    const next = Math.max(0, Math.min(end, Array.isArray(value) ? value[0]! : value));
    media.currentTime = next; setTime(next);
  };
  const metadata = (event: SyntheticEvent<HTMLAudioElement>) => {
    const media = event.currentTarget;
    if (Number.isFinite(media.duration) && media.duration > 0) setNativeDuration(media.duration);
    setTime(media.currentTime); setLoaded(media.readyState >= 1);
  };
  const retry = () => {
    setError(undefined); setLoaded(false); mediaRef.current?.load(); void play();
  };
  const readableDuration = duration.seconds > 0 ? tr(`${duration.approximate ? "约" : ""}${Math.ceil(duration.seconds)}秒`, `${duration.approximate ? "About " : ""}${Math.ceil(duration.seconds)} seconds`) : tr("时长加载中", "Loading duration");
  const failure = !source ? tr("语音地址不可用", "Voice URL unavailable") : error;
  return <div className="kulo-voice-message" data-options-open={optionsOpen || undefined} style={{ "--voice-width": `${voiceBubbleWidth(duration.seconds)}px` } as CSSProperties}>
    <audio ref={mediaRef} src={source} preload="metadata" hidden aria-label={asset.name || tr("语音消息", "Voice message")}
      onLoadedMetadata={metadata} onDurationChange={metadata}
      onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
      onPlay={(event) => { pauseOtherMedia(event.currentTarget); setPlaying(true); setError(undefined); }}
      onPlaying={() => { setPlaying(true); setBuffering(false); setError(undefined); }}
      onPause={() => { setPlaying(false); setBuffering(false); }}
      onEnded={() => { setPlaying(false); setBuffering(false); }}
      onWaiting={() => setBuffering(true)} onCanPlay={() => setBuffering(false)}
      onError={() => { setPlaying(false); setBuffering(false); setError(tr("语音无法播放", "Unable to play voice message")); }} />
    <div className="kulo-voice-row">
      <span className="kulo-voice-options-anchor">
        <Popover isOpen={optionsOpen} onOpenChange={setOptionsOpen}>
          <Button isIconOnly variant="ghost" size="sm" aria-label={tr("语音选项", "Voice options")} className="kulo-voice-options-trigger"><KuloIcon name="more" size={18} /></Button>
          <Popover.Content placement="bottom end" className="kulo-voice-options">
            <Popover.Dialog aria-label={tr("语音选项", "Voice options")}>
              <div className="kulo-voice-position"><span>{formatMediaTime(time)}</span><span>{duration.approximate ? tr("约 ", "About ") : ""}{duration.seconds > 0 ? formatMediaTime(duration.seconds) : "--:--"}</span></div>
              <Slider aria-label={tr("语音播放位置", "Voice playback position")} minValue={0} maxValue={duration.seconds > 0 ? duration.seconds : 1} step={0.1} value={Math.min(time, duration.seconds > 0 ? duration.seconds : 1)} onChange={seek} isDisabled={!loaded || !duration.seconds} className="kulo-voice-seek">
                <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
              </Slider>
              {source && <Link href={source} download={asset.name} target="_blank" rel="noopener noreferrer" className="kulo-voice-download">{tr("下载语音", "Download voice message")}</Link>}
              {(voice?.snapshot?.asr.enabled || transcriptText) && <Button size="sm" variant="ghost" isDisabled={transcribing || !transcriptText && !voice?.connected} onPress={() => { void showTranscript(); }}>{transcribing ? <Spinner size="sm" /> : null}{transcriptOpen ? tr("收起文字", "Hide transcript") : transcriptText ? tr("查看文字", "View transcript") : tr("转文字", "Transcribe")}</Button>}
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
      </span>
      <div className="kulo-voice-surface">
        <Button variant="secondary" className="kulo-voice-bubble" aria-label={tr(`${playing ? "暂停" : "播放"}语音，${readableDuration}`, `${playing ? "Pause" : "Play"} voice message, ${readableDuration}`)} aria-pressed={playing} aria-busy={buffering || undefined} isDisabled={!source} onPress={toggle} onKeyDown={(event) => {
          if (event.key === "ArrowLeft") { event.preventDefault(); seek(time - 5); }
          if (event.key === "ArrowRight") { event.preventDefault(); seek(time + 5); }
        }}>
          <span className="kulo-voice-duration">{label}</span>
          <span className="kulo-voice-sound">{playing ? <KuloIcon name="pause" size={20} /> : <SoundGlyph />}</span>
        </Button>
        {duration.seconds > 0 && (time > 0 || playing) && <ProgressBar aria-label={tr("语音播放进度", "Voice playback progress")} value={Math.min(100, Math.max(0, time / duration.seconds * 100))} size="sm" className="kulo-voice-progress" valueLabel={tr(`${formatMediaTime(time)} / ${duration.approximate ? "约 " : ""}${formatMediaTime(duration.seconds)}`, `${formatMediaTime(time)} / ${duration.approximate ? "About " : ""}${formatMediaTime(duration.seconds)}`)}><ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track></ProgressBar>}
      </div>
    </div>
    {transcribing && <span className="kulo-voice-status" role="status">{tr("正在转文字", "Transcribing")}</span>}
    {transcriptError && <div className="kulo-voice-failure"><span role="alert">{transcriptError}</span><Button variant="ghost" size="sm" onPress={() => { void showTranscript(); }}>{tr("重试", "Retry")}</Button></div>}
    {transcriptOpen && <div className="kulo-voice-transcript-expanded"><p tabIndex={0} aria-label={tr("文字稿", "Transcript")}>{transcriptText}</p><div className="flex gap-1"><Button size="sm" variant="ghost" onPress={() => { void (async () => { try { await navigator.clipboard.writeText(transcriptText); setTranscriptCopied(true); } catch { setTranscriptError(tr("复制失败，请选择文字复制", "Copy failed. Select the text to copy it.")); } })(); }}>{transcriptCopied ? tr("已复制", "Copied") : tr("复制", "Copy")}</Button><Button size="sm" variant="ghost" onPress={() => setTranscriptOpen(false)}>{tr("收起", "Collapse")}</Button></div></div>}
    {buffering && !failure && <span className="kulo-voice-status" role="status">{tr("缓冲中", "Buffering")}</span>}
    {failure && <div className="kulo-voice-failure"><span role="status">{failure}</span>{source && <><Button variant="ghost" size="sm" onPress={retry}>{tr("重试", "Retry")}</Button><Link href={source} download={asset.name} target="_blank" rel="noopener noreferrer" className="kulo-voice-download">{tr("下载", "Download")}</Link></>}</div>}
  </div>;
}
