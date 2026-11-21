import { diagramTitleFromName, type ChatAttachment } from "@kulo/protocol";
import { Button, Modal } from "@heroui/react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useKuloAppearance } from "../../kulo-appearance";
import { translate as tr, useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { prepareHtmlPreview, readFileAsset } from "./file-actions";
import { exportDiagramAsPng, exportDiagramAsSvg, readHostDiagramThemeVars } from "./inline-diagram-export";
import { useReducedContentMotion } from "./use-content-motion";
import "./inline-diagram.css";

const MIN_INLINE_HEIGHT = 140;
const MAX_INLINE_HEIGHT = 560;
const FALLBACK_REVEAL_MS = 1500;

function movePreview(node: HTMLElement | null, target: HTMLElement | null): void {
  if (!node || !target || node.parentElement === target) return;
  const parent = target as HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void };
  if (node.isConnected && target.isConnected && parent.moveBefore) parent.moveBefore(node, null);
  else target.appendChild(node);
}

function clampInlineHeight(value: number): number {
  return Math.max(MIN_INLINE_HEIGHT, Math.min(MAX_INLINE_HEIGHT, Math.ceil(value)));
}

export function InlineDiagram({ asset, fallbackText }: { asset: ChatAttachment; fallbackText?: string }) {
  const { language } = useI18n();
  const { resolved, effectiveCustomization } = useKuloAppearance();
  const reduceMotion = useReducedContentMotion();
  const title = diagramTitleFromName(asset.name);
  const locale = language === "en" ? "en" : "zh";

  const [nearViewport, setNearViewport] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewError, setPreviewError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState<number>();
  const [large, setLarge] = useState(false);
  const [exporting, setExporting] = useState<"png" | "svg">();
  const [exportError, setExportError] = useState("");
  const [inlineStage, setInlineStage] = useState<HTMLDivElement | null>(null);
  const [largeStage, setLargeStage] = useState<HTMLDivElement | null>(null);
  const [mount] = useState(() => (typeof document === "undefined" ? null : document.createElement("div")));

  const rootRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const expandTriggerRef = useRef<HTMLButtonElement>(null);
  const cachedHtmlRef = useRef<string | undefined>(undefined);
  const exportAbortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => exportAbortRef.current?.abort(), []);
  useEffect(() => { cachedHtmlRef.current = undefined; }, [asset.id]);

  // Lazy-activate when approaching viewport (400px margin).
  useEffect(() => {
    if (nearViewport || !rootRef.current) return;
    if (typeof IntersectionObserver === "undefined") { setNearViewport(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: "400px" });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, [nearViewport]);

  // Support jumping back to this diagram via kulo:reveal-file if triggered.
  useEffect(() => {
    const reveal = (event: Event) => {
      if ((event as CustomEvent<{ assetId?: string }>).detail?.assetId !== asset.id) return;
      setNearViewport(true);
      rootRef.current?.scrollIntoView?.({ block: "nearest" });
    };
    window.addEventListener("kulo:reveal-file", reveal);
    return () => window.removeEventListener("kulo:reveal-file", reveal);
  }, [asset.id]);

  // Load zero-query-string /preview URL strictly on [asset.id, nearViewport, attempt].
  useEffect(() => {
    if (!nearViewport) return;
    const controller = new AbortController();
    setPreviewError("");
    setPreviewUrl(undefined);
    setLoaded(false);
    setReady(false);
    void prepareHtmlPreview(asset.id, controller.signal).then(
      (url) => { if (!controller.signal.aborted) setPreviewUrl(url); },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setPreviewError(error instanceof Error ? error.message : tr("图示暂时无法显示", "Diagram temporarily unavailable"));
        }
      },
    );
    return () => controller.abort();
  }, [asset.id, nearViewport, attempt]);

  const postTheme = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const vars = readHostDiagramThemeVars(resolved);
    win.postMessage({
      type: "kulo:diagram-theme",
      theme: resolved,
      reduceMotion,
      expanded: large,
      locale,
      vars,
    }, "*");
  }, [resolved, reduceMotion, large, locale, effectiveCustomization]);

  // Push live theme / appearance customization / reduced motion / expanded mode without reloading iframe.
  useEffect(() => {
    if (!loaded) return;
    postTheme();
  }, [loaded, postTheme]);

  // Fallback reveal timer in case a synthetic browser environment suppresses ResizeObserver/postMessage.
  useEffect(() => {
    if (!loaded || ready) return;
    const timer = window.setTimeout(() => setReady(true), FALLBACK_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [loaded, ready]);

  // Strictly verify postMessage source before accepting ready/height updates.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current?.contentWindow || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "kulo:diagram-ready" || data.type === "kulo:diagram-height") {
        if (typeof data.height === "number" && Number.isFinite(data.height) && data.height > 0 && !large) {
          setMeasuredHeight(clampInlineHeight(data.height));
        }
        if (data.type === "kulo:diagram-ready") setReady(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [large]);

  useLayoutEffect(() => {
    if (mount) mount.className = "kulo-inline-diagram-mount";
    movePreview(mount, large ? largeStage : inlineStage);
  }, [mount, large, inlineStage, largeStage]);

  const closeLarge = () => {
    movePreview(mount, inlineStage);
    setLarge(false);
    setExportError("");
    requestAnimationFrame(() => expandTriggerRef.current?.focus({ preventScroll: true }));
  };

  const runExport = async (format: "png" | "svg") => {
    if (exporting) return;
    exportAbortRef.current?.abort();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExporting(format);
    setExportError("");
    try {
      let html = cachedHtmlRef.current;
      if (!html) {
        const response = await readFileAsset(asset.id, controller.signal);
        html = await response.text();
        if (controller.signal.aborted) return;
        cachedHtmlRef.current = html;
      }
      const vars = readHostDiagramThemeVars(resolved);
      if (format === "svg") exportDiagramAsSvg(html, title, vars);
      else await exportDiagramAsPng(html, title, vars);
    } catch (error) {
      if (!controller.signal.aborted) {
        setExportError(error instanceof Error ? error.message : tr("保存失败，请重试", "Export failed. Please retry."));
      }
    } finally {
      if (!controller.signal.aborted) setExporting(undefined);
    }
  };

  const naturalWidth = asset.width && asset.width > 0 ? Math.min(780, asset.width + 32) : undefined;
  const aspectRatio = asset.width && asset.height && asset.width > 0 && asset.height > 0
    ? `${asset.width + 32} / ${asset.height + 32}`
    : "16 / 9";

  const figureStyle = naturalWidth
    ? ({ "--kulo-diagram-natural-width": `${naturalWidth}px` } as CSSProperties)
    : undefined;
  const stageStyle: CSSProperties = measuredHeight
    ? { height: `${measuredHeight}px` }
    : { aspectRatio, maxHeight: "min(62dvh, 520px)" };

  return <>
    <figure ref={rootRef} className="kulo-inline-diagram" style={figureStyle} data-asset-id={asset.id} data-presentation="diagram">
      <div className="kulo-inline-diagram-expand">
        <Button
          ref={expandTriggerRef}
          size="sm"
          variant="ghost"
          isIconOnly
          aria-label={tr(`放大查看：${title}`, `Expand diagram: ${title}`)}
          onPress={() => { setNearViewport(true); setLarge(true); }}
        >
          <KuloIcon name="maximize" size={16} />
        </Button>
      </div>
      {previewError ? (
        <div className="kulo-inline-diagram-fallback" role="alert">
          <p className="kulo-inline-diagram-fallback-text">{fallbackText || title}</p>
          <Button size="sm" variant="secondary" onPress={() => setAttempt((n) => n + 1)}>
            {tr("重试", "Retry")}
          </Button>
        </div>
      ) : (
        <div className="kulo-inline-diagram-stage" ref={setInlineStage} style={stageStyle} hidden={large} />
      )}
    </figure>

    {mount && !previewError && createPortal(<>
      {!ready && <div className="kulo-inline-diagram-placeholder" aria-hidden="true" />}
      {previewUrl && (
        <iframe
          key={attempt}
          ref={iframeRef}
          className="kulo-inline-diagram-frame"
          data-ready={ready ? "true" : "false"}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={previewUrl}
          onLoad={() => { setLoaded(true); postTheme(); }}
          onError={() => setPreviewError(tr("图示暂时无法显示", "Diagram temporarily unavailable"))}
        />
      )}
    </>, mount)}

    <Modal.Backdrop isOpen={large} onOpenChange={(open) => { if (!open) closeLarge(); }}>
      <Modal.Container size="cover" scroll="inside">
        <Modal.Dialog className="kulo-inline-diagram-dialog">
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
            <Modal.CloseTrigger aria-label={tr("关闭图示预览", "Close diagram preview")} />
          </Modal.Header>
          <Modal.Body className="kulo-inline-diagram-modal-body">
            <div className="kulo-inline-diagram-large-stage" ref={setLargeStage} />
          </Modal.Body>
          <Modal.Footer className="kulo-inline-diagram-modal-footer">
            {exportError && <p className="kulo-inline-diagram-export-error" role="alert">{exportError}</p>}
            <Button
              size="sm"
              variant="secondary"
              isDisabled={Boolean(exporting)}
              isPending={exporting === "png"}
              onPress={() => { void runExport("png"); }}
            >
              {tr("存为图片", "Save image")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={Boolean(exporting)}
              isPending={exporting === "svg"}
              onPress={() => { void runExport("svg"); }}
            >
              {tr("存为矢量图", "Save SVG")}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}
