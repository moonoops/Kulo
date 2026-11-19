import { isHtmlArtifact, type ChatAttachment } from "@moco/protocol";
import { Button, Card, Dropdown, Label, Modal, Spinner } from "@heroui/react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { translate as tr, useI18n } from "../../moco-i18n";
import { MocoIcon } from "../../moco-icon";
import { formatAssetSize } from "./asset-preview";
import { CodeBlock } from "./code-block";
import { desktopFileBridge, downloadFileAsset, openFileInDefaultApp, openHtmlInBrowser, prepareHtmlPreview, readFileAsset } from "./file-actions";
import { FilePreview } from "./file-preview";
import { filePreviewKind } from "./file-preview-model";
import "./file-message.css";

export { isPreviewableFile } from "./file-preview-model";

function movePreview(node: HTMLElement | null, target: HTMLElement | null): void {
  if (!node || !target || node.parentElement === target) return;
  // Atomic DOM moves preserve the live iframe, including form values and chart state.
  const parent = target as HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void };
  if (node.isConnected && target.isConnected && parent.moveBefore) parent.moveBefore(node, null);
  else target.appendChild(node);
}

export function FileMessage({ asset, defaultExpanded = true }: { asset: ChatAttachment; defaultExpanded?: boolean }) {
  useI18n();
  const html = isHtmlArtifact(asset);
  const kind = filePreviewKind(asset);
  const previewable = kind !== undefined;
  const desktop = desktopFileBridge();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [large, setLarge] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState<string>();
  const [sourceError, setSourceError] = useState("");
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewError, setPreviewError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(false);
  const [nearViewport, setNearViewport] = useState(false);
  const [pending, setPending] = useState<"open" | "browser" | "download">();
  const [actionError, setActionError] = useState("");
  const [inlineStage, setInlineStage] = useState<HTMLDivElement | null>(null);
  const [largeStage, setLargeStage] = useState<HTMLDivElement | null>(null);
  const [mount] = useState(() => typeof document === "undefined" ? null : document.createElement("div"));
  const action = useRef<AbortController | undefined>(undefined);
  const expandTrigger = useRef<HTMLButtonElement>(null);
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const hasOpened = useRef(false);
  const previewTouched = useRef(false);
  if (expanded && nearViewport) hasOpened.current = true;
  const shouldPrepare = html && hasOpened.current;
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    if (defaultExpanded && !previewTouched.current && !hasOpened.current) setExpanded(true);
  }, [defaultExpanded]);
  useEffect(() => {
    if (!previewable || nearViewport || !expanded || !root.current) return;
    if (typeof IntersectionObserver === "undefined") { setNearViewport(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNearViewport(true); observer.disconnect(); }
    }, { rootMargin: "400px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [previewable, nearViewport, expanded]);
  useEffect(() => {
    const reveal = (event: Event) => {
      if ((event as CustomEvent<{ assetId?: string }>).detail?.assetId !== asset.id) return;
      previewTouched.current = true;
      setNearViewport(true); setExpanded(true);
    };
    window.addEventListener("moco:reveal-file", reveal);
    return () => window.removeEventListener("moco:reveal-file", reveal);
  }, [asset.id]);
  useEffect(() => {
    if (!shouldPrepare) return;
    const controller = new AbortController();
    setPreviewError("");
    setPreviewUrl(undefined);
    setLoaded(false);
    void prepareHtmlPreview(asset.id, controller.signal).then((url) => {
      if (!controller.signal.aborted) setPreviewUrl(url);
    }, (error: unknown) => {
      if (!controller.signal.aborted) setPreviewError(error instanceof Error ? error.message : tr("预览加载失败", "Failed to load preview"));
    });
    return () => controller.abort();
  }, [asset.id, shouldPrepare, attempt]);
  useEffect(() => {
    if (!sourceOpen || source !== undefined) return;
    const controller = new AbortController();
    setSourceError("");
    void readFileAsset(asset.id, controller.signal).then((response) => response.text()).then((text) => {
      if (!controller.signal.aborted) setSource(text);
    }, (error: unknown) => {
      if (!controller.signal.aborted) setSourceError(error instanceof Error ? error.message : tr("源码读取失败", "Unable to read source"));
    });
    return () => controller.abort();
  }, [sourceOpen, asset.id, source, sourceAttempt]);
  useLayoutEffect(() => {
    if (mount) {
      mount.className = "moco-artifact-live-preview scrollbar";
      mount.dataset.kind = kind;
      mount.dataset.reading = reading ? "expanded" : "preview";
    }
    movePreview(mount, large ? largeStage : inlineStage);
  }, [mount, large, inlineStage, largeStage, kind, reading]);
  const closeLarge = () => {
    movePreview(mount, inlineStage);
    setLarge(false);
    requestAnimationFrame(() => expandTrigger.current?.focus({ preventScroll: true }));
  };
  const run = async (kind: "open" | "browser" | "download") => {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setPending(kind); setActionError("");
    try {
      if (kind === "download") await downloadFileAsset(asset, controller.signal);
      else if (kind === "browser" || !desktop && html) await openHtmlInBrowser(asset.id, controller.signal);
      else await openFileInDefaultApp(asset.id, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setActionError(error instanceof Error ? error.message : tr("文件操作失败，请重试", "File action failed. Please retry"));
    } finally {
      if (!controller.signal.aborted) { setPending(undefined); action.current = undefined; }
    }
  };
  const openAction = (html || desktop) && <Button size="sm" variant="secondary" isDisabled={Boolean(pending)} isPending={pending === "open"} aria-label={desktop ? tr(`在默认应用打开：${asset.name}`, `Open in default app: ${asset.name}`) : tr(`在浏览器打开：${asset.name}`, `Open in browser: ${asset.name}`)} onPress={() => { void run("open"); }}>{desktop ? tr("默认应用打开", "Open in default app") : tr("浏览器打开", "Open in browser")}</Button>;
  const downloadAction = <Button size="sm" variant="secondary" isDisabled={Boolean(pending)} isPending={pending === "download"} aria-label={tr(`下载文件：${asset.name}`, `Download file: ${asset.name}`)} onPress={() => { void run("download"); }}>{tr("下载", "Download")}</Button>;
  const actions = <>{openAction}{downloadAction}</>;
  const feedback = actionError && <p className="moco-artifact-error" role="alert">{actionError}</p>;
  return <>
    <Card ref={root} variant="default" className="moco-chat-artifact" data-asset-id={asset.id} data-kind={kind ?? "file"}>
      <Card.Header className="moco-artifact-header">
        <MocoIcon name={html ? "code" : "document"} size={20} />
        <div className="moco-artifact-detail"><span className="moco-item-title moco-chat-truncate" title={asset.name}>{asset.name}</span><span className="moco-item-description">{html ? "HTML" : asset.name.split(".").at(-1)?.toUpperCase()} · {formatAssetSize(asset.size)}</span></div>
        <div className="moco-artifact-actions">
          {previewable && <Button ref={expandTrigger} size="sm" variant="ghost" aria-label={tr(`放大预览：${asset.name}`, `Expand preview: ${asset.name}`)} onPress={() => { previewTouched.current = true; setNearViewport(true); setExpanded(true); setLarge(true); }}>{tr("放大", "Expand")}</Button>}
          {openAction}
          {(!previewable || !desktop && !html) && downloadAction}
          {previewable && <Dropdown><Button ref={sourceTrigger} size="sm" variant="ghost" isIconOnly aria-label={tr(`文件选项：${asset.name}`, `File options: ${asset.name}`)}><MocoIcon name="more" size={16} /></Button><Dropdown.Popover><Dropdown.Menu aria-label={tr("文件选项", "File options")} onAction={(key) => {
            if (key === "source") setSourceOpen(true);
            else if (key === "browser") { void run("browser"); }
            else if (key === "download") { void run("download"); }
            else if (key === "collapse") { previewTouched.current = true; setExpanded((value) => !value); }
          }}><Dropdown.Item id="download" isDisabled={Boolean(pending)} textValue={tr("下载文件", "Download file")}><Label>{tr("下载文件", "Download file")}</Label></Dropdown.Item>{html && <Dropdown.Item id="source" textValue={tr("查看源码", "View source")}><Label>{tr("查看源码", "View source")}</Label></Dropdown.Item>}{html && desktop && <Dropdown.Item id="browser" isDisabled={Boolean(pending)} textValue={tr("在浏览器打开", "Open in browser")}><Label>{tr("在浏览器打开", "Open in browser")}</Label></Dropdown.Item>}<Dropdown.Item id="collapse" textValue={expanded ? tr("收起预览", "Collapse preview") : tr("展开预览", "Show preview")}><Label>{expanded ? tr("收起预览", "Collapse preview") : tr("展开预览", "Show preview")}</Label></Dropdown.Item></Dropdown.Menu></Dropdown.Popover></Dropdown>}
        </div>
      </Card.Header>
      {!large && feedback}
      {previewable && <div className="moco-artifact-inline-stage" ref={setInlineStage} hidden={!expanded || large} />}
      {previewable && !large && <Card.Footer className="moco-artifact-collapsed">
        {expanded ? <Button variant="ghost" size="sm" aria-expanded={reading} aria-label={reading ? tr(`收起阅读：${asset.name}`, `Collapse reading: ${asset.name}`) : tr(`展开阅读：${asset.name}`, `Expand reading: ${asset.name}`)} onPress={() => { previewTouched.current = true; setNearViewport(true); setReading((value) => !value); }}><MocoIcon name={reading ? "minimize" : "chevron-down"} size={16} />{reading ? tr("收起阅读", "Collapse reading") : tr("展开阅读", "Expand reading")}</Button> : <Button variant="ghost" size="sm" aria-label={tr(`展开预览：${asset.name}`, `Show preview: ${asset.name}`)} onPress={() => { previewTouched.current = true; setNearViewport(true); setExpanded(true); }}>{tr("展开预览", "Show preview")}</Button>}
      </Card.Footer>}
      {!previewable && <p className="moco-artifact-unsupported moco-item-description">{tr("此文件暂不支持内嵌预览", "Inline preview is unavailable for this file")}</p>}
    </Card>
    {mount && previewable && createPortal(<>
      {!hasOpened.current ? <div className="moco-artifact-feedback" role="status"><Spinner size="sm" /><span>{tr("正在加载预览", "Loading preview")}</span></div> : kind !== "html" ? <FilePreview asset={asset} kind={kind} /> : previewError ? <div className="moco-artifact-feedback" role="alert"><span>{previewError}</span><Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>{tr("重试", "Retry")}</Button></div> : <>
        {!loaded && <div className="moco-artifact-feedback" role="status"><Spinner size="sm" /><span>{tr("正在加载预览", "Loading preview")}</span></div>}
        {previewUrl && <iframe key={attempt} className="moco-artifact-frame" title={tr(`预览：${asset.name}`, `Preview: ${asset.name}`)} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" src={previewUrl} onLoad={() => setLoaded(true)} onError={() => setPreviewError(tr("预览加载失败", "Failed to load preview"))} />}
      </>}
    </>, mount)}
    <Modal.Backdrop isOpen={large} onOpenChange={(open) => { if (!open) closeLarge(); }}>
      <Modal.Container size="cover" scroll="inside"><Modal.Dialog className="moco-artifact-dialog"><Modal.Header><Modal.Heading>{asset.name}</Modal.Heading><Modal.CloseTrigger aria-label={tr("关闭文件预览", "Close file preview")} /></Modal.Header><Modal.Body className="moco-artifact-modal-body"><div className="moco-artifact-large-stage" ref={setLargeStage} /></Modal.Body><Modal.Footer className="moco-artifact-modal-footer">{feedback}<div className="moco-artifact-actions">{actions}</div></Modal.Footer></Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
    <Modal.Backdrop isOpen={sourceOpen} onOpenChange={(open) => { if (!open) { setSourceOpen(false); requestAnimationFrame(() => sourceTrigger.current?.focus({ preventScroll: true })); } }}>
      <Modal.Container size="lg" scroll="inside"><Modal.Dialog><Modal.Header><Modal.Heading>{asset.name}</Modal.Heading><Modal.CloseTrigger aria-label={tr("关闭源码", "Close source")} /></Modal.Header><Modal.Body>{sourceError ? <div className="moco-artifact-feedback" role="alert"><span>{sourceError}</span><Button size="sm" variant="secondary" onPress={() => setSourceAttempt((value) => value + 1)}>{tr("重试", "Retry")}</Button></div> : source === undefined ? <div className="moco-artifact-feedback" role="status"><Spinner size="sm" /><span>{tr("正在读取源码", "Loading source")}</span></div> : <CodeBlock code={source} language="html" fileName={asset.name} />}</Modal.Body></Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
  </>;
}
