/// <reference types="vite/client" />
import { Button, Spinner } from "@heroui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatAttachment } from "@kulo/protocol";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?worker&url";
import { translate as tr, useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { readFileAsset } from "./file-actions";
import { PdfBinaryDataFactory } from "./pdf-preview-assets";
import { resetPdfPageScroll } from "./pdf-reading-position";
import "./pdf-preview.css";

type PdfLibrary = typeof import("pdfjs-dist");
let library: Promise<PdfLibrary> | undefined;
function loadLibrary(): Promise<PdfLibrary> {
  library ??= import("pdfjs-dist").then((pdfjs) => { pdfjs.GlobalWorkerOptions.workerSrc = workerUrl; return pdfjs; }).catch((error: unknown) => { library = undefined; throw error; });
  return library;
}

function dispose(task: { destroy(): Promise<void> }): void {
  void task.destroy().catch((error: unknown) => console.warn("Unable to release PDF preview", error));
}

/** A single page stays mounted when FileMessage moves its live preview into the full-screen dialog. */
export default function PdfPreview({ asset }: { asset: ChatAttachment }) {
  useI18n();
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    let task: ReturnType<PdfLibrary["getDocument"]> | undefined;
    setDocument(undefined); setError("");
    void (async () => {
      const [pdfjs, response] = await Promise.all([loadLibrary(), readFileAsset(asset.id, controller.signal)]);
      const bytes = new Uint8Array(await response.arrayBuffer());
      controller.signal.throwIfAborted();
      task = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, BinaryDataFactory: PdfBinaryDataFactory,
        disableWorkerRendering: true, stopAtErrors: true });
      const opened = await task.promise;
      if (!controller.signal.aborted) { setDocument(opened); setPage((current) => Math.min(current, opened.numPages)); }
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : tr("PDF 预览失败", "Unable to preview PDF"));
    });
    return () => { controller.abort(); if (task) dispose(task); };
  }, [asset.id, attempt]);
  if (error) return <div className="kulo-artifact-feedback" role="alert"><span>{error}</span><Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>{tr("重试", "Retry")}</Button></div>;
  if (!document) return <div className="kulo-artifact-feedback" role="status"><Spinner size="sm" /><span>{tr("正在加载 PDF", "Loading PDF")}</span></div>;
  return <div className="kulo-pdf-preview">
    <div className="kulo-pdf-toolbar" aria-label={tr("PDF 阅读工具", "PDF reading controls")}>
      <div className="kulo-pdf-controls">
        <Button size="sm" variant="ghost" isIconOnly aria-label={tr("上一页", "Previous page")} isDisabled={page <= 1} onPress={() => setPage((current) => current - 1)}><KuloIcon name="arrow-left" size={16} /></Button>
        <span className="kulo-pdf-page-label" aria-live="polite">{tr(`第 ${page} 页 / 共 ${document.numPages} 页`, `Page ${page} / ${document.numPages}`)}</span>
        <Button size="sm" variant="ghost" isIconOnly aria-label={tr("下一页", "Next page")} isDisabled={page >= document.numPages} onPress={() => setPage((current) => current + 1)}><KuloIcon name="chevron-right" size={16} /></Button>
      </div>
      <div className="kulo-pdf-controls">
        <Button size="sm" variant="ghost" isDisabled={zoom <= 0.5} aria-label={tr("缩小 PDF", "Zoom PDF out")} onPress={() => setZoom((current) => Math.max(0.5, current - 0.25))}>−</Button>
        <Button size="sm" variant="ghost" aria-label={tr("PDF 适合宽度", "Fit PDF to width")} onPress={() => setZoom(1)}>{zoom === 1 ? tr("适合宽度", "Fit width") : `${Math.round(zoom * 100)}%`}</Button>
        <Button size="sm" variant="ghost" isDisabled={zoom >= 2.5} aria-label={tr("放大 PDF", "Zoom PDF in")} onPress={() => setZoom((current) => Math.min(2.5, current + 0.25))}>+</Button>
      </div>
    </div>
    <PdfPage document={document} number={page} zoom={zoom} />
  </div>;
}

function PdfPage({ document, number, zoom }: { document: PDFDocumentProxy; number: number; zoom: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const previousPage = useRef(number);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    resetPdfPageScroll(holder.current, previousPage.current, number);
    previousPage.current = number;
  }, [number]);
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const resize = () => { if (element.clientWidth > 0) setWidth(element.clientWidth); };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!width || !canvas.current || !text.current) return;
    let alive = true, page: PDFPageProxy | undefined, render: RenderTask | undefined, layer: TextLayer | undefined;
    setError(""); setBusy(true);
    const target = canvas.current, selection = text.current;
    void (async () => {
      page = await document.getPage(number);
      if (!alive) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width * zoom });
      const resolution = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_777_216 / (viewport.width * viewport.height)));
      const context = target.getContext("2d");
      if (!context) throw new Error(tr("此设备无法绘制 PDF", "This device cannot render PDF pages"));
      target.width = Math.ceil(viewport.width * resolution); target.height = Math.ceil(viewport.height * resolution);
      target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`;
      selection.replaceChildren();
      selection.style.setProperty("--total-scale-factor", String(viewport.scale));
      render = page.render({ canvas: target, canvasContext: context, viewport, transform: resolution === 1 ? undefined : [resolution, 0, 0, resolution, 0, 0] });
      await render.promise;
      if (!alive) return;
      const pdfjs = await loadLibrary();
      const content = await page.getTextContent();
      if (!alive) return;
      layer = new pdfjs.TextLayer({ textContentSource: content, container: selection, viewport });
      await layer.render();
      if (alive) setBusy(false);
    })().catch((reason: unknown) => { if (alive) { setBusy(false); setError(reason instanceof Error ? reason.message : tr("PDF 页面无法显示", "Unable to render PDF page")); } });
    return () => { alive = false; render?.cancel(); layer?.cancel(); page?.cleanup(); };
  }, [document, number, width, zoom, attempt]);
  return <div ref={holder} className="kulo-pdf-page-scroll scrollbar" role="region" aria-label={tr(`PDF 第 ${number} 页`, `PDF page ${number}`)} tabIndex={0}>
    {error && <div className="kulo-artifact-feedback" role="alert"><span>{error}</span><Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>{tr("重试", "Retry")}</Button></div>}
    <div className="kulo-pdf-page" aria-busy={busy}>
      <canvas ref={canvas} aria-label={tr(`PDF 第 ${number} 页`, `PDF page ${number}`)} />
      <div ref={text} className="kulo-pdf-text-layer" />
      {busy && <div className="kulo-pdf-rendering" role="status"><Spinner size="sm" /><span className="sr-only">{tr("正在绘制 PDF 页面", "Rendering PDF page")}</span></div>}
    </div>
  </div>;
}
