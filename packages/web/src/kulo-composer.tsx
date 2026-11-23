import { translate as tr, useI18n } from "./kulo-i18n";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { Button, Dropdown, Label, ProgressBar, Spinner, TextArea, Tooltip } from "@heroui/react";
import { useFocusRing } from "react-aria";
import { redactSecrets, type ChatAttachment, type ChatReplyReference } from "@kulo/protocol";
import { kuloRest, resolveAssetUrl } from "./kulo-api";
import { useKuloAppearance } from "./kulo-appearance";
import { KuloIcon } from "./kulo-icon";
import { AssetImageGallery, AssetPreview, resolveImageThumbUrl, type PreviewableImage } from "./features/chat/asset-preview";
import { filePreviewKind, isOfficePreviewKind } from "./features/chat/file-preview-model";
import { MediaMessage, formatMediaTime } from "./features/chat/media-message";
import { composerEnterAction, insertComposerNewline, isMacComposerPlatform } from "./features/chat/composer-keyboard";
import type { ComposerDeviceJoin } from "./features/chat/use-chat-device-join";
import { MicrophoneGlyph, RecordingStopGlyph, RecordingWaveform, useVoiceRecorder, type TranscribeVoice } from "./features/chat/voice-recorder";
import { requestSystemPermissionHelp } from "./features/system-permissions/system-permissions";
import { useVoiceWorkspace } from "./features/voice/voice-context";
import type { VoiceCallTarget } from "./features/voice/use-voice-call";
import { CallStatusIcon } from "./features/voice/call-status-icon";
import { MessageReply } from "./features/chat/message-reply";
import { resolveComposerActions } from "./features/chat/composer-actions";
import "./features/chat/composer-media.css";
import "./features/chat/composer-actions.css";

export type { PreviewableImage } from "./features/chat/asset-preview";

export function composerPlaceholder(): string {
  return tr("描述你的想法，提出你的问题···", "Describe your ideas, ask your questions…");
}

const RASTER_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MIB = 1024 * 1024;
const DEFAULT_LIMITS = { imageBytes: 25 * MIB, audioBytes: 50 * MIB, videoBytes: 250 * MIB, fileBytes: 25 * MIB, messageBytes: 300 * MIB, maxAttachments: 16 };
const DEFAULT_UPLOAD_MENU_KINDS: readonly ChatAttachment["kind"][] = ["image", "audio", "video", "file"];
type UploadLimits = typeof DEFAULT_LIMITS;

export interface DraftAttachment {
  localId: string;
  status: "uploading" | "ready" | "error";
  name: string;
  mimeType: string;
  size: number;
  kind: ChatAttachment["kind"];
  previewUrl?: string;
  attachment?: ChatAttachment;
  progress?: number;
  duration?: number;
  error?: string;
}

interface UploadSource {
  file: File;
  topicKey: string;
  controller?: AbortController;
  generation: number;
  stopProbe?: () => void;
}

export function draftFileKind(file: Pick<File, "type" | "name">): ChatAttachment["kind"] {
  const mime = (file.type || "").split(";")[0]!.trim().toLowerCase();
  if (RASTER_IMAGE_MIMES.has(mime) || (!mime && /\.(png|jpe?g|webp|gif)$/i.test(file.name))) return "image";
  if (mime.startsWith("audio/") || (!mime && /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i.test(file.name))) return "audio";
  if (mime.startsWith("video/") || (!mime && /\.(mp4|webm|mov|mkv|m4v|ogv)$/i.test(file.name))) return "video";
  return "file";
}

function resolveDraftFilename(file: File): string {
  if (file.name?.trim()) return file.name.trim();
  const mime = file.type.split(";")[0]!.trim().toLowerCase();
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg" } as Record<string, string>)[mime];
  return `attachment-${Date.now()}${extension ? `.${extension}` : ""}`;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}

function probeMediaDuration(kind: "audio" | "video", url: string, receive: (seconds: number) => void): () => void {
  const media = document.createElement(kind);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    media.onloadedmetadata = null;
    media.onerror = null;
    media.removeAttribute("src");
    media.load();
  };
  const timeout = setTimeout(stop, 15_000);
  media.preload = "metadata";
  media.onloadedmetadata = () => {
    if (Number.isFinite(media.duration) && media.duration > 0) receive(media.duration);
    stop();
  };
  media.onerror = stop;
  media.src = url;
  media.load();
  return stop;
}

export function useTopicAttachments() {
  useI18n();
  const [byTopic, setByTopic] = useState<Record<string, DraftAttachment[]>>({});
  const stateRef = useRef(byTopic);
  const sourcesRef = useRef(new Map<string, UploadSource>());
  const objectUrlsRef = useRef(new Map<string, string>());
  const limitsRef = useRef<UploadLimits>(DEFAULT_LIMITS);
  const mountedRef = useRef(true);

  const update = useCallback((mutate: (current: Record<string, DraftAttachment[]>) => Record<string, DraftAttachment[]>) => {
    if (!mountedRef.current) return;
    stateRef.current = mutate(stateRef.current);
    setByTopic(stateRef.current);
  }, []);
  const patch = useCallback((topicKey: string, localId: string, changes: Partial<DraftAttachment>) => {
    update((current) => {
      const list = current[topicKey];
      if (!list?.some((item) => item.localId === localId)) return current;
      return { ...current, [topicKey]: list.map((item) => item.localId === localId ? { ...item, ...changes } : item) };
    });
  }, [update]);
  const release = useCallback((localId: string) => {
    const source = sourcesRef.current.get(localId);
    sourcesRef.current.delete(localId);
    source?.controller?.abort();
    source?.stopProbe?.();
    const url = objectUrlsRef.current.get(localId);
    if (url) { URL.revokeObjectURL(url); objectUrlsRef.current.delete(localId); }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    const sources = sourcesRef.current;
    const urls = objectUrlsRef.current;
    return () => {
      mountedRef.current = false;
      for (const source of sources.values()) { source.controller?.abort(); source.stopProbe?.(); }
      sources.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const upload = useCallback(async (localId: string) => {
    const source = sourcesRef.current.get(localId);
    if (!source) return;
    source.controller?.abort();
    const controller = new AbortController();
    source.controller = controller;
    const generation = ++source.generation;
    const isCurrent = () => sourcesRef.current.get(localId) === source && source.generation === generation && !controller.signal.aborted;
    const current = stateRef.current[source.topicKey]?.find((item) => item.localId === localId);
    if (!current) return;
    patch(source.topicKey, localId, { status: "uploading", progress: 0, error: undefined });
    try {
      if (!source.file.size) throw new Error(tr("文件为空，请选择有内容的文件", "The file is empty. Choose a file with content."));
      const session = await kuloRest.ensureMediaSession();
      if (!isCurrent()) return;
      limitsRef.current = session.limits;
      const limits = session.limits;
      const sizeLimit = limits[`${current.kind}Bytes` as "imageBytes" | "audioBytes" | "videoBytes" | "fileBytes"];
      if (source.file.size > sizeLimit) throw new Error(tr(`文件过大，最大支持 ${formatByteSize(sizeLimit)}`, `File too large. Maximum size: ${formatByteSize(sizeLimit)}`));
      const list = stateRef.current[source.topicKey] ?? [];
      const index = list.findIndex((item) => item.localId === localId);
      if (index >= limits.maxAttachments) throw new Error(tr(`每条消息最多 ${limits.maxAttachments} 个附件`, `Up to ${limits.maxAttachments} attachments per message`));
      const precedingSize = list.slice(0, index).filter((item) => item.status !== "error").reduce((sum, item) => sum + item.size, 0);
      if (precedingSize + source.file.size > limits.messageBytes) throw new Error(tr(`附件总量不能超过 ${formatByteSize(limits.messageBytes)}`, `Total attachment size cannot exceed ${formatByteSize(limits.messageBytes)}`));
      const uploaded = await kuloRest.uploadFile(source.file, current.name, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (isCurrent()) patch(source.topicKey, localId, { progress: total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : undefined });
        },
      });
      if (!isCurrent()) return;
      patch(source.topicKey, localId, { status: "ready", progress: 100, name: uploaded.name, mimeType: uploaded.mimeType, size: uploaded.size, kind: uploaded.kind, attachment: uploaded, ...(uploaded.duration !== undefined ? { duration: uploaded.duration } : {}), error: undefined });
    } catch (error) {
      if (isCurrent()) patch(source.topicKey, localId, { status: "error", error: error instanceof Error ? error.message : tr("上传失败", "Upload failed") });
    } finally {
      if (source.generation === generation) source.controller = undefined;
    }
  }, [patch]);

  const enqueueFiles = useCallback((topicKey: string, inputFiles: FileList | File[]) => {
    const files = Array.from(inputFiles).filter((file) => !!file);
    if (!files.length) return;
    const limits = limitsRef.current;
    const previous = stateRef.current[topicKey] ?? [];
    let totalSize = previous.reduce((sum, item) => sum + item.size, 0);
    const created = files.map((file, index): DraftAttachment => {
      const localId = `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const name = resolveDraftFilename(file);
      const kind = draftFileKind(file);
      const previewUrl = kind !== "file" ? URL.createObjectURL(file) : undefined;
      if (previewUrl) objectUrlsRef.current.set(localId, previewUrl);
      const sizeLimit = limits[`${kind}Bytes` as "imageBytes" | "audioBytes" | "videoBytes" | "fileBytes"];
      const error = !file.size ? tr("文件为空，请选择有内容的文件", "The file is empty. Choose a file with content.") : previous.length + index >= limits.maxAttachments ? tr(`每条消息最多 ${limits.maxAttachments} 个附件`, `Up to ${limits.maxAttachments} attachments per message`) : file.size > sizeLimit ? tr(`文件过大，最大支持 ${formatByteSize(sizeLimit)}`, `File too large. Maximum size: ${formatByteSize(sizeLimit)}`) : totalSize + file.size > limits.messageBytes ? tr(`附件总量不能超过 ${formatByteSize(limits.messageBytes)}`, `Total attachment size cannot exceed ${formatByteSize(limits.messageBytes)}`) : undefined;
      if (!error) totalSize += file.size;
      sourcesRef.current.set(localId, { file, topicKey, generation: 0 });
      return { localId, status: error ? "error" : "uploading", name, mimeType: file.type.split(";")[0]!.trim() || "application/octet-stream", size: file.size, kind, previewUrl, progress: 0, error };
    });
    update((current) => ({ ...current, [topicKey]: [...(current[topicKey] ?? []), ...created] }));
    for (const draft of created) {
      if (draft.previewUrl && (draft.kind === "audio" || draft.kind === "video")) {
        const source = sourcesRef.current.get(draft.localId)!;
        source.stopProbe = probeMediaDuration(draft.kind, draft.previewUrl, (duration) => patch(topicKey, draft.localId, { duration }));
      }
      if (draft.status === "uploading") void upload(draft.localId);
    }
  }, [patch, update, upload]);

  const removeAttachment = useCallback((topicKey: string, localId: string) => {
    release(localId);
    update((current) => ({ ...current, [topicKey]: (current[topicKey] ?? []).filter((item) => item.localId !== localId) }));
  }, [release, update]);
  const cancelAttachment = useCallback((topicKey: string, localId: string) => {
    const source = sourcesRef.current.get(localId);
    if (!source || source.topicKey !== topicKey) return;
    source.generation++;
    source.controller?.abort();
    source.controller = undefined;
    patch(topicKey, localId, { status: "error", error: tr("上传已取消", "Upload cancelled") });
  }, [patch]);
  const retryAttachment = useCallback((topicKey: string, localId: string) => {
    if (sourcesRef.current.get(localId)?.topicKey === topicKey) void upload(localId);
  }, [upload]);
  const clearAttachments = useCallback((topicKey: string) => {
    for (const item of stateRef.current[topicKey] ?? []) release(item.localId);
    update((current) => ({ ...current, [topicKey]: [] }));
  }, [release, update]);
  const restoreAttachments = useCallback((topicKey: string, items: DraftAttachment[]) => {
    if (!items.length) return;
    update((current) => {
      const existing = current[topicKey] ?? [];
      const existingIds = new Set(existing.map((item) => item.localId));
      return { ...current, [topicKey]: [...existing, ...items.filter((item) => !existingIds.has(item.localId)).map((item) => ({ ...item, previewUrl: objectUrlsRef.current.get(item.localId) }))] };
    });
  }, [update]);
  const getAttachments = useCallback((topicKey: string): DraftAttachment[] => byTopic[topicKey] ?? [], [byTopic]);
  return { getAttachments, enqueueFiles, removeAttachment, cancelAttachment, retryAttachment, clearAttachments, restoreAttachments };
}

export function KuloComposer({
  draftText, onDraftTextChange, attachments, onEnqueueFiles, onRemoveAttachment, onRetryAttachment, onCancelAttachment, onPreviewImage, onSubmit, onAbort,
  busy = false, connected, canQueueMessages = connected, placeholder = composerPlaceholder(), textareaRef, allowAttachments = true, isSendDisabled = false, onConfigure, conversationKey, onTranscribeVoice,
  voiceCallTarget, onResolveVoiceCallTarget, onOpenCall, onConfigureVoice, replyTo, onCancelReply, deviceJoin, allowVoice = true, uploadMenuKinds = DEFAULT_UPLOAD_MENU_KINDS,
}: {
  draftText: string;
  onDraftTextChange: (next: string) => void;
  attachments: readonly DraftAttachment[];
  onEnqueueFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (localId: string) => void;
  onRetryAttachment?: (localId: string) => void;
  onCancelAttachment?: (localId: string) => void;
  onPreviewImage?: (image: PreviewableImage) => void;
  onSubmit: () => void;
  onAbort?: () => void;
  busy?: boolean;
  connected: boolean;
  canQueueMessages?: boolean;
  placeholder?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  allowAttachments?: boolean;
  allowVoice?: boolean;
  uploadMenuKinds?: readonly ChatAttachment["kind"][];
  isSendDisabled?: boolean;
  onConfigure?: () => void;
  conversationKey?: string;
  onTranscribeVoice?: TranscribeVoice;
  voiceCallTarget?: VoiceCallTarget;
  onResolveVoiceCallTarget?: () => Promise<VoiceCallTarget>;
  onOpenCall?: () => void;
  onConfigureVoice?: () => void;
  replyTo?: ChatReplyReference;
  onCancelReply?: () => void;
  deviceJoin?: ComposerDeviceJoin;
}) {
  useI18n();
  const voiceWorkspace = useVoiceWorkspace();
  const callActive = Boolean(voiceWorkspace?.call.active);
  const currentCall = voiceWorkspace?.call.call;
  const callState = callActive ? currentCall?.state ?? "listening" : "idle";
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const microphoneRef = useRef<HTMLButtonElement>(null);
  const voiceActionRef = useRef<HTMLButtonElement>(null);
  const localTextareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = textareaRef ?? localTextareaRef;
  const displayedDraft = deviceJoin?.preview ?? draftText;
  const joining = deviceJoin?.phase === "joining";
  const { chatFontSize } = useKuloAppearance();
  const { focusProps, isFocusVisible } = useFocusRing({ within: true });
  const dragDepthRef = useRef(0);
  const composingRef = useRef(false);
  const [dragActive, setDragActive] = useState(false);
  const [preparingCall, setPreparingCall] = useState(false);
  const [callPreparationError, setCallPreparationError] = useState<string>();
  const callOperation = useRef(0);
  const draftRef = useRef({ draftText, onDraftTextChange });
  draftRef.current = { draftText, onDraftTextChange };
  const voice = useVoiceRecorder(conversationKey, onTranscribeVoice, (text) => {
    const current = draftRef.current;
    current.onDraftTextChange(`${current.draftText}${current.draftText && !/\s$/.test(current.draftText) ? "\n" : ""}${text}`);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  });
  const voiceActive = allowVoice && (voice.phase === "requesting" || voice.phase === "recording" || voice.phase === "transcribing");
  const callConfigured = Boolean(voiceWorkspace?.snapshot?.call.enabled && voiceWorkspace.snapshot.call.hasCredential);
  const callDisabled = !callActive && (!connected || Boolean(voiceWorkspace?.loading) || Boolean(voiceWorkspace?.recordingActive) || voiceActive || preparingCall || busy);
  const callLabel = callActive ? currentCall?.muted ? tr("返回通话（已静音）", "Return to call (muted)") : tr("返回通话", "Return to call") : callConfigured ? tr("语音通话", "Voice call") : tr("设置语音通话", "Set up voice calls");
  const openCall = async () => {
    if (!voiceWorkspace || !voiceCallTarget && !onResolveVoiceCallTarget || callDisabled) return;
    if (callActive) {
      voiceWorkspace.call.expand();
      onOpenCall?.();
    } else if (callConfigured) {
      const operation = ++callOperation.current;
      setCallPreparationError(undefined);
      setPreparingCall(true);
      try {
        const target = onResolveVoiceCallTarget ? await onResolveVoiceCallTarget() : voiceCallTarget!;
        if (callOperation.current !== operation) return;
        onOpenCall?.();
        await voiceWorkspace.call.start(target);
      } catch (error) {
        if (callOperation.current === operation) setCallPreparationError(redactSecrets(error instanceof Error ? error.message : tr("无法开始通话，请重试", "Could not start the call. Try again")));
      } finally {
        if (callOperation.current === operation) setPreparingCall(false);
      }
    } else onConfigureVoice?.();
  };
  useEffect(() => {
    setPreparingCall(false);
    setCallPreparationError(undefined);
    return () => { callOperation.current++; };
  }, [conversationKey]);
  useEffect(() => {
    if (!onTranscribeVoice) return;
    voiceWorkspace?.setRecordingActive(voiceActive);
    return () => voiceWorkspace?.setRecordingActive(false);
  }, [onTranscribeVoice, voiceActive, voiceWorkspace?.setRecordingActive]);
  useEffect(() => {
    if (voiceActive) voiceActionRef.current?.focus({ preventScroll: true });
  }, [voiceActive]);
  const voiceTimeId = useId();
  const discardVoice = () => {
    voice.discard();
    requestAnimationFrame(() => microphoneRef.current?.focus({ preventScroll: true }));
  };
  useEffect(() => { setDragActive(false); dragDepthRef.current = 0; }, [conversationKey]);
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    const fit = () => {
      element.style.height = "auto";
      const style = getComputedStyle(element);
      const borderHeight = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const minHeight = parseFloat(style.minHeight);
      // scrollHeight includes padding, while the textarea's border-box height also includes its borders.
      const contentHeight = element.value ? element.scrollHeight + borderHeight : minHeight;
      element.style.height = `${Math.min(parseFloat(style.maxHeight), Math.max(minHeight, contentHeight))}px`;
    };
    fit();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [displayedDraft, inputRef, chatFontSize, voiceActive]);
  const uploadingCount = attachments.filter((item) => item.status === "uploading").length;
  const hasFailed = attachments.some((item) => item.status === "error");
  const hasSendablePayload = draftText.trim().length > 0 || attachments.some((item) => item.status === "ready" && item.attachment);
  const canSend = deviceJoin ? !voiceActive && (deviceJoin.phase === "preview" || deviceJoin.phase === "retry")
    : canQueueMessages && !isSendDisabled && !onConfigure && !voiceActive && uploadingCount === 0 && !hasFailed && hasSendablePayload;
  const { primary: action, showStop } = deviceJoin
    ? { primary: "send" as const, showStop: false }
    : resolveComposerActions({
        busy,
        canStop: Boolean(onAbort),
        allowBusySend: !isSendDisabled,
        needsConfiguration: Boolean(onConfigure),
        hasPayload: hasSendablePayload,
        hasAttachments: attachments.length > 0,
        canCall: Boolean(allowVoice && voiceWorkspace && (voiceCallTarget || onResolveVoiceCallTarget)),
      });
  const stopLabel = tr("停止生成", "Stop generating");
  const actionLabel = deviceJoin ? joining ? tr("正在接入", "Joining") : deviceJoin.phase === "retry" ? tr("重试接入", "Retry joining") : deviceJoin.sameHost ? tr("打开主会话", "Open main chat") : tr("接入主 Kulo", "Join host Kulo")
    : action === "stop" ? stopLabel : action === "call" ? callLabel : tr("发送", "Send");
  const submitFromButton = () => {
    onSubmit();
    if (!deviceJoin) requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };
  const cancelDeviceJoin = () => {
    deviceJoin?.cancel();
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229 || joining) return;
    const action = composerEnterAction(event, platform);
    if (!action) return;
    event.preventDefault();
    if (action === "send") {
      if (canSend) onSubmit();
    } else {
      const element = event.currentTarget;
      const next = insertComposerNewline(element.value, element.selectionStart, element.selectionEnd);
      onDraftTextChange(next.text);
      requestAnimationFrame(() => {
        if (inputRef.current === element && element.value === next.text) element.setSelectionRange(next.caret, next.caret);
      });
    }
  };
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData;
    const files = Array.from(clipboard.items ?? []).filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => !!file && file.size > 0);
    if (!files.length) files.push(...Array.from(clipboard.files ?? []).filter((file) => file.size > 0));
    if (files.length) {
      if (!clipboard.getData("text/plain")) event.preventDefault();
      onEnqueueFiles(files);
    }
  };
  const isFileDrag = (event: DragEvent<HTMLDivElement>) => Array.from(event.dataTransfer.types ?? []).includes("Files");
  const pickFilesFromInput = (input: HTMLInputElement) => {
    if (input.files?.length) onEnqueueFiles(Array.from(input.files));
    input.value = "";
  };

  return <div {...focusProps} className="kulo-composer" data-drag-active={dragActive || undefined} data-keyboard-focus={isFocusVisible || undefined}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !composingRef.current && (voiceActive || deviceJoin && !joining || replyTo && onCancelReply)) {
        event.preventDefault();
        if (voiceActive) discardVoice();
        else if (deviceJoin) cancelDeviceJoin();
        else {
          onCancelReply?.();
          requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
        }
      }
    }}
    onDragEnter={allowAttachments ? (event) => { if (isFileDrag(event)) { event.preventDefault(); dragDepthRef.current++; setDragActive(true); } } : undefined}
    onDragOver={allowAttachments ? (event) => { if (isFileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); } } : undefined}
    onDragLeave={allowAttachments ? (event) => { if (isFileDrag(event)) { event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (!dragDepthRef.current) setDragActive(false); } } : undefined}
    onDrop={allowAttachments ? (event) => { if (event.dataTransfer.files.length) { event.preventDefault(); dragDepthRef.current = 0; setDragActive(false); onEnqueueFiles(event.dataTransfer.files); } } : undefined}>
    {allowAttachments && uploadMenuKinds.includes("image") && <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(event) => pickFilesFromInput(event.currentTarget)} />}
    {allowAttachments && uploadMenuKinds.includes("audio") && <input ref={audioInputRef} type="file" accept="audio/*" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(event) => pickFilesFromInput(event.currentTarget)} />}
    {allowAttachments && uploadMenuKinds.includes("video") && <input ref={videoInputRef} type="file" accept="video/*" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(event) => pickFilesFromInput(event.currentTarget)} />}
    {allowAttachments && uploadMenuKinds.includes("file") && <input ref={fileInputRef} type="file" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(event) => pickFilesFromInput(event.currentTarget)} />}
    {replyTo && <div className="kulo-composer-reply">
      <MessageReply reply={replyTo} />
      {onCancelReply && <Button isIconOnly size="sm" variant="ghost" className="kulo-composer-reply-cancel" aria-label={tr("取消回复", "Cancel reply")} onPress={() => {
        onCancelReply();
        requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
      }}><KuloIcon name="close" size={16} /></Button>}
    </div>}
    {allowVoice && allowAttachments && voice.phase === "error" && <div className="kulo-composer-voice-status" data-phase="error">
      <span className="text-danger" role="alert">{voice.error}</span>
      {voice.permissionRequired
        ? <Button size="sm" variant="secondary" onPress={() => requestSystemPermissionHelp({ kind: "microphone" })}>{tr("检查权限", "Check permissions")}</Button>
        : <Button size="sm" variant="ghost" isDisabled={!connected || callActive && !voice.canRetry} onPress={voice.retry}>{voice.canRetry ? tr("重试转写", "Retry transcription") : tr("重试", "Retry")}</Button>}
      <Button isIconOnly size="sm" variant="ghost" aria-label={tr("丢弃录音", "Discard recording")} onPress={discardVoice}><KuloIcon name="close" size={16} /></Button>
    </div>}
    {callPreparationError && <div className="kulo-composer-voice-status" role="alert"><span className="text-danger">{callPreparationError}</span><Button isIconOnly size="sm" variant="ghost" aria-label={tr("关闭通话错误", "Dismiss call error")} onPress={() => setCallPreparationError(undefined)}><KuloIcon name="close" size={16} /></Button></div>}
    {attachments.length > 0 && <div className="kulo-composer-media-list" role="list" aria-label={tr("待发送附件", "Attachments to send")}>
      {attachments.map((item) => {
        const imageSrc = item.kind === "image" ? item.previewUrl || (item.attachment ? resolveAssetUrl(item.attachment.url) : "") : "";
        return <div key={item.localId} role="listitem" className="kulo-composer-media-item" data-status={item.status} data-kind={item.kind} title={`${item.name}\n${formatByteSize(item.size)}`}>
          {imageSrc ? <Button isIconOnly variant="ghost" className="kulo-composer-thumbnail" aria-label={tr(`预览 ${item.name}`, `Preview ${item.name}`)} onPress={() => onPreviewImage?.({ src: imageSrc, name: item.name, size: item.size })}><img src={resolveImageThumbUrl(imageSrc)} alt={item.name} /></Button> : <span className="kulo-composer-type" aria-hidden="true">{item.kind === "audio" ? <MicrophoneGlyph /> : <KuloIcon name={item.kind === "image" ? "image" : item.kind === "video" ? "video" : "document"} size={20} />}</span>}
          <div className="kulo-composer-media-info">
            <span className="kulo-composer-media-name" title={item.name}>{item.name}</span>
            <span className="kulo-composer-media-status text-xs text-muted">{item.status === "error" ? item.error : item.kind === "image" && item.status === "uploading" ? item.progress === 100 ? tr("处理中", "Processing") : item.progress !== undefined ? `${item.progress}%` : tr("上传中", "Uploading") : [formatByteSize(item.size), item.duration !== undefined ? formatMediaTime(item.duration) : undefined, item.status === "uploading" ? item.progress === 100 ? tr("正在处理…", "Processing…") : tr(`上传中${item.progress !== undefined ? ` ${item.progress}%` : "…"}`, `Uploading${item.progress !== undefined ? ` ${item.progress}%` : "…"}`) : undefined].filter(Boolean).join(" · ")}</span>
            {item.status === "uploading" && <ProgressBar size="sm" aria-label={tr(`${item.name} 上传进度`, `${item.name} upload progress`)} value={item.progress ?? 0} isIndeterminate={item.progress === undefined}><ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track></ProgressBar>}
          </div>
          {item.status === "error" && onRetryAttachment && <Button isIconOnly size="sm" variant="tertiary" className="kulo-composer-retry-upload" aria-label={tr(`重试上传 ${item.name}`, `Retry upload for ${item.name}`)} onPress={() => onRetryAttachment(item.localId)}><KuloIcon name="refresh" size={17} /></Button>}
          {item.status === "uploading" && onCancelAttachment ? <Button isIconOnly size="sm" variant="tertiary" className="kulo-composer-attachment-action" aria-label={tr(`取消上传 ${item.name}`, `Cancel upload for ${item.name}`)} onPress={() => onCancelAttachment(item.localId)}><KuloIcon name="cancel" size={17} /></Button> : <Button isIconOnly size="sm" variant="tertiary" className="kulo-composer-attachment-action" aria-label={tr(`移除 ${item.name}`, `Remove ${item.name}`)} onPress={() => onRemoveAttachment(item.localId)}><KuloIcon name="close" size={17} /></Button>}
        </div>;
      })}
    </div>}
    <div className="kulo-composer-input-row flex w-full items-end gap-2" data-voice-active={voiceActive || undefined}>
      {voiceActive ? <>
        <Button isIconOnly variant="tertiary" aria-label={voice.phase === "transcribing" ? tr("取消转写", "Cancel transcription") : tr("取消录音", "Cancel recording")} className="kulo-composer-button kulo-composer-control" onPress={discardVoice}><KuloIcon name="close" size={20} /></Button>
        <RecordingWaveform levels={voice.levels} />
        <span id={voiceTimeId} className="kulo-composer-recording-time" role={voice.phase === "recording" ? "timer" : "status"} aria-live={voice.phase === "recording" ? "off" : "polite"}>{voice.phase === "requesting" ? tr("连接中", "Connecting") : voice.phase === "transcribing" ? voice.progress !== undefined && voice.progress < 100 ? tr(`上传中 ${voice.progress}%`, `Uploading ${voice.progress}%`) : tr("转写中", "Transcribing") : formatMediaTime(voice.duration).padStart(5, "0")}</span>
        <Button ref={voiceActionRef} isIconOnly variant="tertiary" aria-label={voice.phase === "recording" ? tr("停止录音并转写", "Stop recording and transcribe") : voice.phase === "requesting" ? tr("正在连接麦克风", "Connecting to microphone") : tr("正在转写", "Transcribing")} aria-describedby={voiceTimeId}
          isPending={voice.phase !== "recording"} className="kulo-composer-button kulo-composer-control" onPress={voice.stop}>
          {voice.phase === "recording" ? <RecordingStopGlyph /> : <Spinner size="sm" color="current" />}
        </Button>
      </> : <>
      {deviceJoin && deviceJoin.phase !== "conflict" && <Button isIconOnly variant="tertiary" isDisabled={joining} aria-label={tr("取消接入", "Cancel joining")}
        className="kulo-composer-button kulo-composer-control" onPress={cancelDeviceJoin}><KuloIcon name="close" size={18} /></Button>}
      {allowAttachments && !deviceJoin && <Dropdown>
        <Button isIconOnly variant="tertiary" aria-label={tr("添加附件", "Add attachment")} className="kulo-composer-button kulo-composer-control"><KuloIcon name="add" size={20} /></Button>
        <Dropdown.Popover placement="top start"><Dropdown.Menu className="kulo-composer-upload-menu" aria-label={tr("添加附件", "Add attachment")} onAction={(key) => {
          ({ image: imageInputRef, audio: audioInputRef, video: videoInputRef, file: fileInputRef } as const)[key as "image" | "audio" | "video" | "file"]?.current?.click();
        }}>
          {uploadMenuKinds.includes("image") && <Dropdown.Item id="image" textValue={tr("上传图片", "Upload image")}><span className="kulo-composer-upload-icon" aria-hidden="true"><KuloIcon name="image" size={20} /></span><Label>{tr("上传图片", "Upload image")}</Label></Dropdown.Item>}
          {uploadMenuKinds.includes("audio") && <Dropdown.Item id="audio" textValue={tr("上传音频", "Upload audio")}><span className="kulo-composer-upload-icon" aria-hidden="true"><MicrophoneGlyph /></span><Label>{tr("上传音频", "Upload audio")}</Label></Dropdown.Item>}
          {uploadMenuKinds.includes("video") && <Dropdown.Item id="video" textValue={tr("上传视频", "Upload video")}><span className="kulo-composer-upload-icon" aria-hidden="true"><KuloIcon name="video" size={20} /></span><Label>{tr("上传视频", "Upload video")}</Label></Dropdown.Item>}
          {uploadMenuKinds.includes("file") && <Dropdown.Item id="file" textValue={tr("上传文件", "Upload file")}><span className="kulo-composer-upload-icon" aria-hidden="true"><KuloIcon name="attach" size={20} /></span><Label>{tr("上传文件", "Upload file")}</Label></Dropdown.Item>}
        </Dropdown.Menu></Dropdown.Popover>
      </Dropdown>}
      <TextArea ref={inputRef} data-kulo-companion-input="" rows={1} aria-label={deviceJoin ? tr("接入邀请", "Device invitation") : placeholder} aria-keyshortcuts={`${isMacComposerPlatform(platform) ? "Alt+Enter" : "Control+Enter"} Shift+Enter`} variant="secondary" className="kulo-composer-input min-w-0 flex-1 resize-none" placeholder={placeholder} value={displayedDraft} readOnly={joining}
        onChange={(event) => onDraftTextChange(event.target.value)} onKeyDown={handleKeyDown} onPaste={allowAttachments ? handlePaste : undefined}
        onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} />
      {allowVoice && allowAttachments && !onConfigure && !deviceJoin && <div className="kulo-composer-voice-control">
        <Button ref={microphoneRef} isIconOnly variant="tertiary" aria-label={tr("语音输入", "Voice input")}
          isDisabled={callActive || !connected || isSendDisabled || !onTranscribeVoice || voice.canRetry}
          className="kulo-composer-microphone kulo-composer-button kulo-composer-control" onPress={() => void voice.start()}>
          <MicrophoneGlyph />
        </Button>
      </div>}
      <div className="kulo-composer-actions">
        {showStop && <Tooltip delay={350}>
          <Button isIconOnly variant="tertiary" aria-label={stopLabel} data-composer-action="stop"
            className="kulo-composer-button kulo-composer-control" onPress={onAbort}>
            <span className="kulo-composer-action-icon" aria-hidden="true"><KuloIcon name="stop" size={18} fill="currentColor" stroke="none" /></span>
          </Button>
          <Tooltip.Content placement="top">{stopLabel}</Tooltip.Content>
        </Tooltip>}
        {action === "configure" ? <Button size="sm" className="kulo-composer-configure shrink-0" onPress={onConfigure}>{tr("连接模型", "Connect a model")}</Button> : <Tooltip key={deviceJoin ? "join" : action} delay={350}>
          <Button isIconOnly variant={action === "stop" || action === "send" && canSend ? "primary" : "tertiary"}
            isDisabled={action === "call" ? callDisabled : action === "send" ? !canSend : false}
            isPending={joining || action === "call" && preparingCall} aria-label={actionLabel} data-composer-action={deviceJoin ? "join" : action}
            className={`kulo-composer-button${action === "call" ? " kulo-composer-call" : action === "send" ? " kulo-composer-send" : ""}${action === "call" || action === "send" && !canSend ? " kulo-composer-control" : ""}`}
            onPress={action === "stop" ? onAbort : action === "call" ? () => void openCall() : submitFromButton}>
            <span key={action} className="kulo-composer-action-icon" aria-hidden="true">{action === "stop" ? <KuloIcon name="stop" size={18} fill="currentColor" stroke="none" /> : action === "call" ? <CallStatusIcon state={preparingCall ? "connecting" : callState} muted={currentCall?.muted} /> : joining || uploadingCount ? <Spinner size="sm" /> : <KuloIcon name="send" size={18} />}</span>
          </Button>
          <Tooltip.Content placement="top">{actionLabel}</Tooltip.Content>
        </Tooltip>}
      </div>
      </>}
    </div>
    {deviceJoin?.message && <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 pb-2">
      <span className="min-w-0 break-words text-sm" role="alert">{deviceJoin.message}</span>
      {deviceJoin.phase === "conflict" && <>
        <Button size="sm" variant="danger" onPress={() => {
          deviceJoin.confirmStop();
          requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
        }}>{tr("停止任务并接入", "Stop tasks and join")}</Button>
        <Button size="sm" variant="ghost" onPress={cancelDeviceJoin}>{tr("取消", "Cancel")}</Button>
      </>}
    </div>}
    <span className="sr-only" role="status">{joining ? actionLabel : voice.phase === "recording" ? tr("正在录音", "Recording") : ""}</span>
  </div>;
}

export function UserAttachmentList({ attachments, onPreviewImage }: { attachments?: readonly ChatAttachment[]; onPreviewImage?: (image: PreviewableImage) => void }) {
  useI18n();
  if (!attachments?.length) return null;
  const images = attachments.filter((asset) => asset.kind === "image");
  return <div className="kulo-composer-legacy-attachments">{images.length > 0 && <AssetImageGallery assets={images} onPreviewImage={onPreviewImage} />}{attachments.filter((asset) => asset.kind !== "image").map((asset) => <MediaMessage key={asset.id} asset={asset} onPreviewImage={onPreviewImage} defaultExpanded={!isOfficePreviewKind(filePreviewKind(asset))} />)}</div>;
}

export function AttachmentLightbox({ image, onClose }: { image: PreviewableImage | null; onClose: () => void }) {
  useI18n();
  return <AssetPreview image={image} onClose={onClose} />;
}
