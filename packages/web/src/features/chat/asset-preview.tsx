import { translate as tr, useI18n } from "../../kulo-i18n";
import { Button, Link, Modal } from "@heroui/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ChatAttachment } from "@kulo/protocol";
import { resolveAssetUrl } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { constrainPreviewPan, constrainPreviewScale, fitPreviewScale, MAX_PREVIEW_SCALE, previewPanLimits, type PreviewPan, type PreviewSize } from "./asset-preview-model";
import "./chat-content.css";

export interface ImagePreviewSource {
  src: string;
  name: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface PreviewableImage extends ImagePreviewSource {
  gallery?: ImagePreviewSource[];
  index?: number;
}

export function formatAssetSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Media never needs executable, inline SVG, or protocol-relative URLs. */
export function safeContentUrl(value: string, allowBlob = false): string | undefined {
  if (!value || /[\u0000-\u0020\\]/.test(value)) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (allowBlob && /^blob:https?:\/\//i.test(value)) return value;
  return undefined;
}

const LOCAL_UPLOAD_IMAGE_RE = /^\/api\/uploads\/[^/?#]+$/;

/** Requests a compact server-side WebP thumbnail for inline chat previews without changing lightbox originals. */
export function resolveImageThumbUrl(url: string): string {
  return LOCAL_UPLOAD_IMAGE_RE.test(url) ? `${url}?variant=thumb` : url;
}

export function AssetImage({
  image,
  onPreviewImage,
  count,
}: {
  image: PreviewableImage;
  onPreviewImage?: (image: PreviewableImage) => void;
  count?: number;
}) {
  useI18n();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<PreviewableImage | null>(null);
  const src = safeContentUrl(image.src, true);
  const displaySrc = src ? resolveImageThumbUrl(src) : undefined;
  useEffect(() => { setFailed(false); setAttempt(0); }, [image.src]);
  return <span className="kulo-chat-image">
    {displaySrc && !failed ? <Button
      aria-label={tr(`预览图片：${image.name}`, `Preview image: ${image.name}`)}
      className="kulo-chat-image-trigger"
      variant="ghost"
      onPress={() => onPreviewImage ? onPreviewImage(image) : setPreview(image)}
    >
      <img key={attempt} src={displaySrc} alt={image.name} width={image.width} height={image.height} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      {count !== undefined && count > 0 && <span className="kulo-chat-image-count">+{count}</span>}
    </Button> : <span className="kulo-chat-image-error" role="status">
      <KuloIcon name="image" size={24} />
      <span>{tr("图片无法显示", "Image unavailable")}</span>
      {src && <Button size="sm" variant="secondary" onPress={() => { setFailed(false); setAttempt((n) => n + 1); }}>{tr("重试", "Retry")}</Button>}
    </span>}
    {!onPreviewImage && <AssetPreview image={preview} onClose={() => setPreview(null)} />}
  </span>;
}

export function AssetImageGallery({ assets, onPreviewImage }: {
  assets: ChatAttachment[];
  onPreviewImage?: (image: PreviewableImage) => void;
}) {
  useI18n();
  const [selected, setSelected] = useState<PreviewableImage | null>(null);
  const images: ImagePreviewSource[] = assets.map((asset) => ({
    src: resolveAssetUrl(asset.url), name: asset.name, size: asset.size,
    width: asset.width, height: asset.height,
  }));
  if (images.length === 0) return null;
  return <div className="kulo-chat-image-gallery" data-count={Math.min(images.length, 4)}>
    {images.slice(0, 4).map((image, index) => <AssetImage
      key={assets[index]!.id}
      image={{ ...image, gallery: images, index }}
      onPreviewImage={onPreviewImage ?? setSelected}
      count={index === 3 ? images.length - 4 : undefined}
    />)}
    {!onPreviewImage && <AssetPreview image={selected} onClose={() => setSelected(null)} />}
  </div>;
}

export function AssetPreview({ image, onClose }: {
  image: PreviewableImage | null;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const retained = useRef<PreviewableImage | null>(image);
  if (image) retained.current = image;
  const shown = image ?? retained.current;
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [natural, setNatural] = useState<PreviewSize | null>(null);
  const [viewport, setViewport] = useState<PreviewSize>({ width: 0, height: 0 });
  const [scale, setScale] = useState<number | null>(null);
  const [pan, setPan] = useState<PreviewPan>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);
  const zoomInRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; pan: PreviewPan } | null>(null);
  useLayoutEffect(() => { if (image) setIndex(image.index ?? 0); }, [image]);
  const gallery = shown?.gallery?.length ? shown.gallery : shown ? [shown] : [];
  const current = gallery[index] ?? shown;
  const src = current ? safeContentUrl(current.src, true) : undefined;
  const fitScale = natural ? fitPreviewScale(natural, viewport) : 1;
  const effectiveScale = scale ?? fitScale;
  const limits = natural ? previewPanLimits(natural, viewport, effectiveScale) : { x: 0, y: 0 };
  const ready = loaded && natural !== null && viewport.width > 0 && viewport.height > 0;
  const canPan = ready && (limits.x > 0 || limits.y > 0);
  const finishDrag = useCallback(() => {
    const pointerId = drag.current?.pointerId;
    drag.current = null;
    setDragging(false);
    if (pointerId !== undefined && stage?.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
  }, [stage]);
  useLayoutEffect(() => {
    setFailed(false); setLoaded(false); setNatural(null); setAttempt(0); setScale(null); setPan({ x: 0, y: 0 });
    finishDrag();
  }, [src, finishDrag]);
  useLayoutEffect(() => {
    if (!stage) return;
    const measure = () => setViewport({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);
  useLayoutEffect(() => {
    if (natural) setPan((value) => constrainPreviewPan(value, natural, viewport, effectiveScale));
  }, [natural, viewport, effectiveScale]);
  const move = (step: number) => setIndex((value) => (value + step + gallery.length) % gallery.length);
  const setZoom = (next: number | null) => {
    const nextScale = next === null ? null : constrainPreviewScale(next, fitScale);
    const visibleScale = nextScale ?? fitScale;
    // Disabling the focused button can send focus to body, outside the modal's Escape handler.
    if (document.activeElement === zoomOutRef.current && visibleScale <= Math.min(fitScale, 0.1) ||
        document.activeElement === zoomInRef.current && visibleScale >= MAX_PREVIEW_SCALE) {
      stage?.focus({ preventScroll: true });
    }
    finishDrag();
    setScale(nextScale);
    setPan({ x: 0, y: 0 });
  };
  const beginPan = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canPan) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan };
    setDragging(true);
  };
  const updatePan = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId || !natural) return;
    setPan(constrainPreviewPan({ x: drag.current.pan.x + event.clientX - drag.current.x, y: drag.current.pan.y + event.clientY - drag.current.y }, natural, viewport, effectiveScale));
  };
  const navigateStage = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!ready) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); setZoom(effectiveScale * 1.25); }
    else if (event.key === "-") { event.preventDefault(); setZoom(effectiveScale / 1.25); }
    else if (event.key === "0") { event.preventDefault(); setZoom(null); }
    else if (canPan && natural && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const distance = event.shiftKey ? 120 : 48;
      setPan((value) => constrainPreviewPan({
        x: value.x + (event.key === "ArrowLeft" ? distance : event.key === "ArrowRight" ? -distance : 0),
        y: value.y + (event.key === "ArrowUp" ? distance : event.key === "ArrowDown" ? -distance : 0),
      }, natural, viewport, effectiveScale));
    }
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || gallery.length < 2 || event.target instanceof HTMLInputElement) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
  };
  return <Modal.Backdrop isOpen={image !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Modal.Container size="cover" placement="center" className="kulo-chat-preview-container">
      <div className="kulo-chat-preview-events" onKeyDown={navigate}>
        <Modal.Dialog className="kulo-chat-preview-dialog" aria-label={tr("图片预览", "Image preview")}>
          <Modal.CloseTrigger aria-label={tr("关闭图片预览", "Close image preview")} />
          <Modal.Header className="kulo-chat-preview-header">
            <Modal.Heading className="kulo-chat-truncate">{current?.name ?? tr("图片", "Image")}</Modal.Heading>
            <span className="kulo-chat-meta">{[current?.width && current.height ? `${current.width} × ${current.height}` : "", formatAssetSize(current?.size), gallery.length > 1 ? `${index + 1} / ${gallery.length}` : ""].filter(Boolean).join(" · ")}</span>
          </Modal.Header>
          <Modal.Body className="kulo-chat-preview-body">
            <div ref={setStage} className="kulo-chat-preview-stage" data-pannable={canPan || undefined} data-dragging={dragging || undefined}
              tabIndex={0} role="region" aria-label={tr("图片画布", "Image canvas")} aria-keyshortcuts="+ - 0 ArrowLeft ArrowRight ArrowUp ArrowDown"
              onKeyDown={navigateStage} onPointerDown={beginPan} onPointerMove={updatePan}
              onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}>
              {src && !failed ? <>
                <img key={`${src}:${attempt}`} className="kulo-chat-preview-image" src={src} alt={current?.name ?? tr("图片", "Image")} draggable={false}
                  data-ready={ready || undefined} style={{ width: natural?.width, height: natural?.height, transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${effectiveScale})` }}
                  onLoad={(event) => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoaded(true); }}
                  onError={() => { setFailed(true); setLoaded(false); }} />
                {!ready && <span role="status">{tr("加载中…", "Loading…")}</span>}
              </> : <span role="status">{tr("图片无法显示", "Image unavailable")}</span>}
            </div>
          </Modal.Body>
          <Modal.Footer className="kulo-chat-preview-footer">
            {gallery.length > 1 && <div className="kulo-chat-actions">
              <Button size="sm" variant="secondary" aria-label={tr("上一张图片", "Previous image")} onPress={() => move(-1)}><KuloIcon name="arrow-left" size={16} /></Button>
              <Button size="sm" variant="secondary" aria-label={tr("下一张图片", "Next image")} onPress={() => move(1)}><KuloIcon name="chevron-right" size={16} /></Button>
            </div>}
            <div className="kulo-chat-preview-tools" role="group" aria-label={tr("图片缩放", "Image zoom")}>
              {src && failed && <Button size="sm" variant="secondary" onPress={() => { setFailed(false); setAttempt((value) => value + 1); }}>{tr("重试", "Retry")}</Button>}
              <Button ref={zoomOutRef} size="sm" variant="ghost" isIconOnly aria-label={tr("缩小图片", "Zoom out")} isDisabled={!ready || effectiveScale <= Math.min(fitScale, 0.1)} onPress={() => setZoom(effectiveScale / 1.25)}><span aria-hidden="true">−</span></Button>
              <output className="kulo-chat-preview-scale" aria-label={tr("图片缩放比例", "Image zoom level")}>{ready ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: effectiveScale < 0.01 ? 2 : 0 }).format(effectiveScale * 100)}%` : "—"}</output>
              <Button ref={zoomInRef} size="sm" variant="ghost" isIconOnly aria-label={tr("放大图片", "Zoom in")} isDisabled={!ready || effectiveScale >= MAX_PREVIEW_SCALE} onPress={() => setZoom(effectiveScale * 1.25)}><KuloIcon name="add" size={18} /></Button>
              <Button size="sm" variant="secondary" isDisabled={!ready} aria-pressed={scale === null} onPress={() => setZoom(null)}>{tr("适应窗口", "Fit to window")}</Button>
              <Button size="sm" variant="ghost" isDisabled={!ready} aria-pressed={scale === 1} onPress={() => setZoom(1)}>100%</Button>
              {src && <Link href={src} download={current?.name} target="_blank" rel="noopener noreferrer" className="kulo-chat-download-link">{tr("下载", "Download")}</Link>}
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </div>
    </Modal.Container>
  </Modal.Backdrop>;
}
