import { translate as tr, useI18n } from "../../kulo-i18n";
import { Button, Card, Disclosure, Link, ListBox, Select, Slider } from "@heroui/react";
import { isHtmlArtifact, type ChatAttachment } from "@kulo/protocol";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { resolveAssetUrl } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { AssetImageGallery, formatAssetSize, safeContentUrl, type PreviewableImage } from "./asset-preview";
import "./chat-content.css";
import { FileMessage } from "./file-message";
import { InlineDiagram } from "./inline-diagram";
export { FileMessage } from "./file-message";
export { InlineDiagram } from "./inline-diagram";

const activeMedia = new Set<HTMLMediaElement>();
const playbackPositions = new Map<string, number>();

export function pauseOtherMedia(current?: HTMLMediaElement): void {
  for (const media of activeMedia) if (media !== current && !media.paused) media.pause();
}

export function registerMedia(media: HTMLMediaElement, playbackKey?: string): () => void {
  activeMedia.add(media);
  const save = () => {
    if (!playbackKey) return;
    if (media.readyState < 1 && !media.ended) return;
    if (media.ended || !Number.isFinite(media.currentTime) || media.currentTime <= 0 || (Number.isFinite(media.duration) && media.currentTime >= media.duration)) {
      playbackPositions.delete(playbackKey); return;
    }
    playbackPositions.delete(playbackKey);
    playbackPositions.set(playbackKey, media.currentTime);
    if (playbackPositions.size > 128) playbackPositions.delete(playbackPositions.keys().next().value!);
  };
  const restore = () => {
    if (!playbackKey || media.readyState < 1) return;
    const position = playbackPositions.get(playbackKey) ?? 0;
    media.currentTime = Number.isFinite(media.duration) && media.duration > 0 ? Math.min(position, Math.max(0, media.duration - 0.05)) : position;
  };
  if (playbackKey) {
    media.addEventListener("loadedmetadata", restore, true);
    media.addEventListener("timeupdate", save);
    media.addEventListener("pause", save);
    media.addEventListener("ended", save);
    restore();
  }
  return () => {
    media.pause(); save(); activeMedia.delete(media);
    if (playbackKey) {
      media.removeEventListener("loadedmetadata", restore, true);
      media.removeEventListener("timeupdate", save);
      media.removeEventListener("pause", save);
      media.removeEventListener("ended", save);
    }
    if (typeof document !== "undefined" && document.pictureInPictureElement === media) {
      void document.exitPictureInPicture().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "InvalidStateError")) console.error("Unable to close media picture-in-picture", error);
      });
    }
  };
}

export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}` : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function PlayGlyph({ playing }: { playing: boolean }) {
  return <KuloIcon name={playing ? "pause" : "play"} size={22} />;
}

export function MediaMessage({ asset, conversationKey, onPreviewImage, localPreview = false, defaultExpanded = true, compact = false, fallbackText }: {
  asset: ChatAttachment;
  conversationKey?: string;
  onPreviewImage?: (image: PreviewableImage) => void;
  localPreview?: boolean;
  defaultExpanded?: boolean;
  compact?: boolean;
  fallbackText?: string;
}) {
  useI18n();
  if (asset.kind === "image") return <AssetImageGallery assets={[asset]} onPreviewImage={onPreviewImage} />;
  if (asset.kind === "file" && asset.presentation === "diagram" && isHtmlArtifact(asset)) return <InlineDiagram asset={asset} fallbackText={fallbackText} />;
  if (asset.kind !== "audio" && asset.kind !== "video") return <FileMessage asset={asset} defaultExpanded={defaultExpanded} compact={compact} onPreviewImage={onPreviewImage} />;
  return <PlayableMedia asset={asset} conversationKey={conversationKey} localPreview={localPreview} />;
}

function PlayableMedia({ asset, conversationKey, localPreview }: { asset: ChatAttachment; conversationKey?: string; localPreview: boolean }) {
  useI18n();
  const isVideo = asset.kind === "video";
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [enhanced, setEnhanced] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(asset.duration ?? 0);
  const [dimensions, setDimensions] = useState({ width: asset.width ?? 0, height: asset.height ?? 0 });
  const [volume, setVolume] = useState(1);
  const lastVolume = useRef(1);
  const [rate, setRate] = useState("1");
  const [error, setError] = useState<string>();
  const [errorKind, setErrorKind] = useState<"media" | "action">("media");
  const [captionsOn, setCaptionsOn] = useState(false);
  const [nativeControls, setNativeControls] = useState(false);
  const [pipAvailable, setPipAvailable] = useState(false);
  const [inPip, setInPip] = useState(false);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  const source = safeContentUrl(resolveAssetUrl(asset.url), localPreview);
  const poster = asset.posterUrl ? safeContentUrl(resolveAssetUrl(asset.posterUrl)) : undefined;
  const captions = (asset.captions ?? []).filter((caption) => safeContentUrl(caption.url));
  const transcript = asset.transcript;
  const ratio = dimensions.width > 0 && dimensions.height > 0 ? dimensions.width / dimensions.height : 16 / 9;
  const videoWidth = ratio < 1 ? Math.max(200, Math.round(400 * ratio)) : 480;
  useEffect(() => {
    setEnhanced(true);
    const media = mediaRef.current;
    if (!media) return;
    setPipAvailable(isVideo && !!document.pictureInPictureEnabled && typeof media.requestPictureInPicture === "function");
    setFullscreenAvailable(isVideo && document.fullscreenEnabled && typeof media.requestFullscreen === "function");
    const release = registerMedia(media, JSON.stringify([conversationKey ?? "", asset.id, source]));
    const enteredPip = () => setInPip(true);
    const leftPip = () => setInPip(false);
    media.addEventListener("enterpictureinpicture", enteredPip);
    media.addEventListener("leavepictureinpicture", leftPip);
    return () => { media.removeEventListener("enterpictureinpicture", enteredPip); media.removeEventListener("leavepictureinpicture", leftPip); release(); };
  }, [conversationKey, asset.id, source, isVideo]);
  useLayoutEffect(() => {
    setLoaded(false); setPlaying(false); setBuffering(false); setTime(0); setDuration(asset.duration ?? 0); setError(undefined);
    setDimensions({ width: asset.width ?? 0, height: asset.height ?? 0 });
  }, [source]);
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    for (let i = 0; i < media.textTracks.length; i++) media.textTracks[i]!.mode = captionsOn && i === 0 ? "showing" : "disabled";
  }, [captionsOn, loaded, asset.captions]);
  useEffect(() => {
    const update = () => { setNativeControls(document.fullscreenElement === mediaRef.current); };
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const toggle = async () => {
    const media = mediaRef.current;
    if (!media || !source) return;
    if (!media.paused) { media.pause(); return; }
    setError(undefined);
    pauseOtherMedia(media);
    try { await media.play(); } catch (cause) {
      setPlaying(false);
      setErrorKind("media");
      setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? tr("请再次点击播放", "Click play again") : tr("无法播放，可重试或下载原文件", "Unable to play. Retry or download the original file."));
    }
  };
  const seek = (value: number | number[]) => {
    const media = mediaRef.current;
    if (!media || !loaded) return;
    // Recorder WebM drafts can lack a duration header; use their measured recording time.
    const end = Number.isFinite(media.duration) ? media.duration : duration;
    if (end <= 0) return;
    const next = Math.min(end, Math.max(0, Array.isArray(value) ? value[0]! : value));
    media.currentTime = next; setTime(next);
  };
  const metadata = (event: SyntheticEvent<HTMLMediaElement>) => {
    const media = event.currentTarget;
    setTime(media.currentTime);
    if (Number.isFinite(media.duration) && media.duration >= 0) setDuration(media.duration);
    if (isVideo && (media as HTMLVideoElement).videoWidth > 0) setDimensions({ width: (media as HTMLVideoElement).videoWidth, height: (media as HTMLVideoElement).videoHeight });
    setLoaded(media.readyState >= 1); setError(undefined);
  };
  const retry = () => { setError(undefined); setLoaded(false); mediaRef.current?.load(); };
  const fullscreen = async () => {
    setError(undefined);
    try { setNativeControls(true); await mediaRef.current?.requestFullscreen(); }
    catch { setNativeControls(false); setErrorKind("action"); setError(tr("无法进入全屏", "Unable to enter full screen")); }
  };
  const pictureInPicture = async () => {
    setError(undefined);
    try { if (document.pictureInPictureElement === mediaRef.current) await document.exitPictureInPicture(); else await mediaRef.current?.requestPictureInPicture(); }
    catch { setErrorKind("action"); setError(tr("画中画暂不可用", "Picture in picture unavailable")); }
  };
  const syncVolume = (media: HTMLMediaElement) => {
    const next = media.muted ? 0 : media.volume;
    if (next > 0) lastVolume.current = next;
    setVolume(next);
  };
  const events = {
    onLoadedMetadata: metadata,
    onDurationChange: metadata,
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => setTime(event.currentTarget.currentTime),
    onVolumeChange: (event: SyntheticEvent<HTMLMediaElement>) => syncVolume(event.currentTarget),
    onRateChange: (event: SyntheticEvent<HTMLMediaElement>) => setRate(String(event.currentTarget.playbackRate)),
    onPlay: (event: SyntheticEvent<HTMLMediaElement>) => { pauseOtherMedia(event.currentTarget); setPlaying(true); setError(undefined); },
    onPause: () => { setPlaying(false); setBuffering(false); },
    onEnded: () => { setPlaying(false); setBuffering(false); },
    onWaiting: () => setBuffering(true),
    onPlaying: () => { setPlaying(true); setBuffering(false); },
    onCanPlay: () => setBuffering(false),
    onError: () => { setPlaying(false); setBuffering(false); setErrorKind("media"); setError(tr("无法播放，可重试或下载原文件", "Unable to play. Retry or download the original file.")); },
  };
  const playback = <>
    <div className="kulo-chat-playback-row">
      <Button variant="primary" isIconOnly aria-label={playing ? tr("暂停", "Pause") : tr("播放", "Play")} isDisabled={!source} onPress={() => { void toggle(); }}><PlayGlyph playing={playing} /></Button>
      <div className="kulo-chat-timeline">
        <Slider aria-label={isVideo ? tr("视频播放位置", "Video playback position") : tr("音频播放位置", "Audio playback position")} minValue={0} maxValue={duration > 0 ? duration : 1} step={0.1} value={Math.min(time, duration > 0 ? duration : 1)} onChange={seek} isDisabled={!loaded || !duration} className="kulo-chat-seek">
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>
        <div className="kulo-chat-time-row"><span>{formatMediaTime(time)}</span><span role={buffering ? "status" : undefined}>{buffering ? tr("缓冲中", "Buffering") : duration > 0 ? formatMediaTime(duration) : "--:--"}</span></div>
      </div>
    </div>
    <div className="kulo-chat-media-options">
      <Select aria-label={tr("播放速度", "Playback speed")} value={rate} onChange={(value) => {
        if (value === null) return;
        const next = String(value); setRate(next); if (mediaRef.current) mediaRef.current.playbackRate = Number(next);
      }} variant="primary" className="kulo-chat-rate">
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover><ListBox aria-label={tr("播放速度", "Playback speed")}>{[...new Set(["0.5", "0.75", "1", "1.25", "1.5", "2", rate])].sort((a, b) => Number(a) - Number(b)).map((value) => <ListBox.Item key={value} id={value} textValue={`${value}×`} className="kulo-chat-rate-option">{value}×<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
      </Select>
      <div className="kulo-chat-volume">
        <Button variant="ghost" size="sm" aria-label={volume === 0 ? tr("取消静音", "Unmute") : tr("静音", "Mute")} aria-pressed={volume === 0} onPress={() => {
          const media = mediaRef.current; if (!media) return;
          if (media.muted || media.volume === 0) { media.muted = false; media.volume = lastVolume.current; }
          else { lastVolume.current = media.volume; media.muted = true; }
          syncVolume(media);
        }}>{volume === 0 ? tr("静音", "Mute") : tr("音量", "Volume")}</Button>
        <Slider aria-label={tr("音量", "Volume")} minValue={0} maxValue={1} step={0.01} value={volume} onChange={(value) => {
          const next = Array.isArray(value) ? value[0]! : value;
          const media = mediaRef.current; if (!media) return;
          media.volume = next; media.muted = next === 0; syncVolume(media);
        }}><Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track></Slider>
      </div>
      {isVideo && <div className="kulo-chat-actions kulo-chat-video-actions">
        {captions.length > 0 && <Button variant="ghost" size="sm" aria-pressed={captionsOn} onPress={() => setCaptionsOn((value) => !value)}>{tr("字幕", "Captions")}</Button>}
        {pipAvailable && <Button variant="ghost" size="sm" isDisabled={!loaded} aria-pressed={inPip} onPress={() => { void pictureInPicture(); }}>{inPip ? tr("退出画中画", "Exit picture in picture") : tr("画中画", "Picture in picture")}</Button>}
        {fullscreenAvailable && <Button variant="ghost" size="sm" isDisabled={!loaded} onPress={() => { void fullscreen(); }}>{tr("全屏", "Full screen")}</Button>}
      </div>}
    </div>
  </>;
  return <Card variant="secondary" className={`kulo-chat-media ${isVideo ? "kulo-chat-video" : "kulo-chat-audio"}`} style={isVideo ? { "--kulo-media-width": `${videoWidth}px` } as CSSProperties : undefined}>
    {isVideo && <div className="kulo-chat-video-stage" style={{ aspectRatio: String(ratio) }}>
      <video ref={mediaRef} src={source} poster={poster} preload="metadata" playsInline controls={!enhanced || nativeControls} aria-label={asset.name} tabIndex={0} {...events} onKeyDown={(event) => {
        if (!enhanced || nativeControls) return;
        if (event.key === " " || event.key === "k") { event.preventDefault(); void toggle(); }
        if (event.key === "ArrowLeft") { event.preventDefault(); seek(time - 5); }
        if (event.key === "ArrowRight") { event.preventDefault(); seek(time + 5); }
      }}>
        {captions.map((caption) => <track key={caption.url} kind="captions" src={resolveAssetUrl(caption.url)} label={caption.label} srcLang={caption.language} />)}
      </video>
    </div>}
    <Card.Header className="kulo-chat-media-header">
      <div className="kulo-chat-media-heading"><span className="kulo-chat-media-kind">{isVideo ? tr("视频", "Video") : tr("音频", "Audio")}</span><Card.Title className="kulo-chat-media-title kulo-chat-truncate">{asset.name}</Card.Title></div>
      {source && <Link href={source} download={asset.name} target="_blank" rel="noopener noreferrer" className="kulo-chat-download-link">{tr("下载", "Download")}</Link>}
    </Card.Header>
    <Card.Content className="kulo-chat-media-content">
      {!isVideo && <audio ref={mediaRef} src={source} preload="metadata" controls={!enhanced} hidden={enhanced} aria-label={asset.name} {...events} />}
      {enhanced && playback}
      {(!source || error) && <div className="kulo-chat-media-error" role="status"><span>{source ? error : tr("媒体地址不可用", "Media URL unavailable")}</span>{source && errorKind === "media" && <Button variant="secondary" size="sm" onPress={retry}>{tr("重试", "Retry")}</Button>}</div>}
    </Card.Content>
    {transcript && <Card.Footer className="kulo-chat-transcript-footer">
      {transcript.text ? <Disclosure className="kulo-chat-transcript">
        <Disclosure.Heading><Button slot="trigger" variant="ghost" size="sm" className="kulo-chat-transcript-trigger"><span>{tr("文字稿", "Transcript")}</span><Disclosure.Indicator /></Button></Disclosure.Heading>
        <Disclosure.Content><Disclosure.Body className="kulo-chat-transcript-body">
          {transcript.segments?.length ? transcript.segments.map((segment, index) => <div key={`${segment.start}-${index}`} className="kulo-chat-transcript-cue"><Button variant="ghost" size="sm" isDisabled={!loaded} onPress={() => seek(segment.start)}>{formatMediaTime(segment.start)}</Button><span>{segment.text}</span></div>) : <p>{transcript.text}</p>}
        </Disclosure.Body></Disclosure.Content>
      </Disclosure> : <span className="kulo-chat-meta" role="status">{transcript.status === "processing" ? tr("文字稿生成中", "Preparing transcript") : tr("文字稿不可用", "Transcript unavailable")}</span>}
    </Card.Footer>}
  </Card>;
}
