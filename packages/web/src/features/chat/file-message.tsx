import { isHtmlArtifact, type ChatAttachment } from "@kulo/protocol";
import { Button, Card, Dropdown, Label, Modal, Spinner } from "@heroui/react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { translate as tr, useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { formatAssetSize, type PreviewableImage } from "./asset-preview";
import { CodeBlock } from "./code-block";
import { desktopFileBridge, downloadFileAsset, openFileInDefaultApp, openHtmlInBrowser, prepareHtmlPreview, readFileAsset } from "./file-actions";
import { FilePreview } from "./file-preview";
import { filePreviewKind, isOversizedOfficeFile } from "./file-preview-model";
import {
  ModalFooterComposer,
  usePreviewCommandContext,
  type ModalFooterComposerTarget,
} from "./modal-footer-composer";
import "./file-message.css";

export { isPreviewableFile } from "./file-preview-model";

function movePreview(node: HTMLElement | null, target: HTMLElement | null): void {
  if (!node || !target || node.parentElement === target) return;
  // Atomic DOM moves preserve the live iframe, including form values and chart state.
  const parent = target as HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void };
  if (node.isConnected && target.isConnected && parent.moveBefore) parent.moveBefore(node, null);
  else target.appendChild(node);
}

export function FileMessage({
  asset,
  defaultExpanded = true,
  compact = false,
  onPreviewImage,
  topicId,
  conversationId,
  connected,
  getUnavailableReason,
  onSendToTopic,
}: {
  asset: ChatAttachment;
  defaultExpanded?: boolean;
  compact?: boolean;
  onPreviewImage?: (image: PreviewableImage) => void;
  topicId?: string;
  conversationId?: number;
  connected?: boolean;
  getUnavailableReason?: (target: ModalFooterComposerTarget) => string | undefined;
  onSendToTopic?: (target: ModalFooterComposerTarget, text: string) => Promise<void> | void;
}) {
  useI18n();
  const previewContext = usePreviewCommandContext();
  const effectiveTopicId = topicId ?? previewContext?.topicId;
  const effectiveConversationId = conversationId ?? previewContext?.conversationId;
  const effectiveConnected = connected ?? previewContext?.connected ?? true;
  const effectiveGetUnavailableReason = getUnavailableReason ?? previewContext?.getUnavailableReason;
  const effectiveOnSendToTopic = onSendToTopic ?? previewContext?.onSendToTopic;
  const html = isHtmlArtifact(asset);
  const kind = filePreviewKind(asset);
  const officeOversized = isOversizedOfficeFile(asset);
  const previewable = kind !== undefined && !officeOversized;
  const desktop = desktopFileBridge();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [large, setLarge] = useState(false);
  const [frozenTarget, setFrozenTarget] = useState<ModalFooterComposerTarget | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
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
  const compactTrigger = useRef<HTMLButtonElement>(null);
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const hasOpened = useRef(false);
  const previewTouched = useRef(false);
  const isCompact = compact && !expanded;
  if ((expanded || large) && nearViewport) hasOpened.current = true;
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
    window.addEventListener("kulo:reveal-file", reveal);
    return () => window.removeEventListener("kulo:reveal-file", reveal);
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
      mount.className = "kulo-artifact-live-preview scrollbar";
      mount.dataset.kind = kind;
      mount.dataset.reading = reading ? "expanded" : "preview";
    }
    movePreview(mount, large ? largeStage : inlineStage);
  }, [mount, large, inlineStage, largeStage, kind, reading]);
  const openLarge = (expandInline: boolean) => {
    previewTouched.current = true;
    setNearViewport(true);
    if (expandInline) setExpanded(true);
    setFrozenTarget(
      effectiveTopicId && effectiveOnSendToTopic
        ? {
            targetKind: "file",
            topicId: effectiveTopicId,
            ...(effectiveConversationId !== undefined ? { conversationId: effectiveConversationId } : {}),
            fileLabel: asset.name,
          }
        : null,
    );
    setComposerExpanded(false);
    setLarge(true);
  };
  const closeLarge = () => {
    movePreview(mount, inlineStage);
    setLarge(false);
    setComposerExpanded(false);
    setFrozenTarget(null);
    requestAnimationFrame(() => (isCompact ? compactTrigger.current : expandTrigger.current)?.focus({ preventScroll: true }));
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
  const fileExt = html ? "HTML" : (asset.name.includes(".") ? asset.name.split(".").at(-1)?.toUpperCase() : undefined);
  const fileMeta = [fileExt, formatAssetSize(asset.size)].filter(Boolean).join(" · ");
  const openAction = (html || desktop) && <Button size="sm" variant="secondary" isDisabled={Boolean(pending)} isPending={pending === "open"} aria-label={desktop ? tr(`在默认应用打开：${asset.name}`, `Open in default app: ${asset.name}`) : tr(`在浏览器打开：${asset.name}`, `Open in browser: ${asset.name}`)} onPress={() => { void run("open"); }}>{desktop ? tr("默认应用打开", "Open in default app") : tr("浏览器打开", "Open in browser")}</Button>;
  const downloadAction = <Button size="sm" variant="secondary" isDisabled={Boolean(pending)} isPending={pending === "download"} aria-label={tr(`下载文件：${asset.name}`, `Download file: ${asset.name}`)} onPress={() => { void run("download"); }}>{tr("下载", "Download")}</Button>;
  const actions = <>{openAction}{downloadAction}</>;
  const feedback = actionError && <p className="kulo-artifact-error" role="alert">{actionError}</p>;
  const optionsMenu = previewable && <Dropdown><Button ref={sourceTrigger} size="sm" variant="ghost" isIconOnly aria-label={tr(`文件选项：${asset.name}`, `File options: ${asset.name}`)}><KuloIcon name="more" size={16} /></Button><Dropdown.Popover><Dropdown.Menu aria-label={tr("文件选项", "File options")} onAction={(key) => {
    if (key === "source") setSourceOpen(true);
    else if (key === "open") { void run("open"); }
    else if (key === "browser") { void run("browser"); }
    else if (key === "download") { void run("download"); }
    else if (key === "collapse") { previewTouched.current = true; setNearViewport(true); setExpanded((value) => !value); }
  }}>{isCompact && desktop && <Dropdown.Item id="open" isDisabled={Boolean(pending)} textValue={tr("默认应用打开", "Open in default app")}><Label>{tr("默认应用打开", "Open in default app")}</Label></Dropdown.Item>}<Dropdown.Item id="download" isDisabled={Boolean(pending)} textValue={tr("下载文件", "Download file")}><Label>{tr("下载文件", "Download file")}</Label></Dropdown.Item>{html && <Dropdown.Item id="source" textValue={tr("查看源码", "View source")}><Label>{tr("查看源码", "View source")}</Label></Dropdown.Item>}{html && (desktop || isCompact) && <Dropdown.Item id="browser" isDisabled={Boolean(pending)} textValue={tr("在浏览器打开", "Open in browser")}><Label>{tr("在浏览器打开", "Open in browser")}</Label></Dropdown.Item>}<Dropdown.Item id="collapse" textValue={expanded ? tr("收起预览", "Collapse preview") : tr("展开预览", "Show preview")}><Label>{expanded ? tr("收起预览", "Collapse preview") : tr("展开预览", "Show preview")}</Label></Dropdown.Item></Dropdown.Menu></Dropdown.Popover></Dropdown>;
  return <>
    <Card ref={root} variant="secondary" className="kulo-chat-artifact" data-asset-id={asset.id} data-kind={kind ?? "file"} data-compact={isCompact || undefined}>
      {isCompact ? (
        <div className="kulo-artifact-compact-row">
          {previewable ? (
            <Button
              ref={compactTrigger}
              variant="ghost"
              className="kulo-artifact-compact-trigger"
              aria-label={tr(`预览文件：${asset.name}`, `Preview file: ${asset.name}`)}
              onPress={() => openLarge(false)}
            >
              <span className="kulo-artifact-thumb" aria-hidden="true"><KuloIcon name={html ? "code" : "document"} size={20} /></span>
              <span className="kulo-artifact-detail"><span className="kulo-item-title kulo-chat-truncate" title={asset.name}>{asset.name}</span><span className="kulo-item-description">{fileMeta}</span></span>
            </Button>
          ) : (
            <div className="kulo-artifact-compact-info">
              <span className="kulo-artifact-thumb" aria-hidden="true"><KuloIcon name={html ? "code" : "document"} size={20} /></span>
              <div className="kulo-artifact-detail"><span className="kulo-item-title kulo-chat-truncate" title={asset.name}>{asset.name}</span><span className="kulo-item-description">{fileMeta}</span></div>
            </div>
          )}
          <div className="kulo-artifact-actions">
            {previewable ? optionsMenu : actions}
          </div>
        </div>
      ) : (
        <Card.Header className="kulo-artifact-header">
          <KuloIcon name={html ? "code" : "document"} size={20} />
          <div className="kulo-artifact-detail"><span className="kulo-item-title kulo-chat-truncate" title={asset.name}>{asset.name}</span><span className="kulo-item-description">{fileMeta}</span></div>
          <div className="kulo-artifact-actions">
            {previewable && <Button ref={expandTrigger} size="sm" variant="ghost" aria-label={tr(`放大预览：${asset.name}`, `Expand preview: ${asset.name}`)} onPress={() => openLarge(true)}>{tr("放大", "Expand")}</Button>}
            {openAction}
            {(!previewable || !desktop && !html) && downloadAction}
            {optionsMenu}
          </div>
        </Card.Header>
      )}
      {!large && feedback}
      {previewable && <div className="kulo-artifact-inline-stage" ref={setInlineStage} hidden={!expanded || large} />}
      {previewable && !large && !isCompact && <Card.Footer className="kulo-artifact-collapsed">
        {expanded ? <Button variant="ghost" size="sm" aria-expanded={reading} aria-label={reading ? tr(`收起阅读：${asset.name}`, `Collapse reading: ${asset.name}`) : tr(`展开阅读：${asset.name}`, `Expand reading: ${asset.name}`)} onPress={() => { previewTouched.current = true; setNearViewport(true); setReading((value) => !value); }}><KuloIcon name={reading ? "minimize" : "chevron-down"} size={16} />{reading ? tr("收起阅读", "Collapse reading") : tr("展开阅读", "Expand reading")}</Button> : <Button variant="ghost" size="sm" aria-label={tr(`展开预览：${asset.name}`, `Show preview: ${asset.name}`)} onPress={() => { previewTouched.current = true; setNearViewport(true); setExpanded(true); }}>{tr("展开预览", "Show preview")}</Button>}
      </Card.Footer>}
      {!previewable && (!isCompact || officeOversized) && <p className="kulo-artifact-unsupported kulo-item-description">{officeOversized ? tr("文件超过 15 MB，请下载或使用默认应用打开", "File exceeds 15 MB. Download or open in default app.") : tr("此文件暂不支持内嵌预览", "Inline preview is unavailable for this file")}</p>}
    </Card>
    {mount && previewable && createPortal(<>
      {!hasOpened.current ? <div className="kulo-artifact-feedback" role="status"><Spinner size="sm" /><span>{tr("正在加载预览", "Loading preview")}</span></div> : kind !== "html" ? <FilePreview asset={asset} kind={kind} onPreviewImage={onPreviewImage} /> : previewError ? <div className="kulo-artifact-feedback" role="alert"><span>{previewError}</span><Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>{tr("重试", "Retry")}</Button></div> : <>
        {!loaded && <div className="kulo-artifact-feedback" role="status"><Spinner size="sm" /><span>{tr("正在加载预览", "Loading preview")}</span></div>}
        {previewUrl && <iframe key={attempt} className="kulo-artifact-frame" title={tr(`预览：${asset.name}`, `Preview: ${asset.name}`)} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" src={previewUrl} onLoad={() => setLoaded(true)} onError={() => setPreviewError(tr("预览加载失败", "Failed to load preview"))} />}
      </>}
    </>, mount)}
    <Modal.Backdrop isOpen={large} isKeyboardDismissDisabled={composerExpanded} onOpenChange={(open) => { if (!open) closeLarge(); }}>
      <Modal.Container size="cover" scroll="inside"><Modal.Dialog className="kulo-artifact-dialog"><Modal.Header><Modal.Heading>{asset.name}</Modal.Heading><Modal.CloseTrigger aria-label={tr("关闭文件预览", "Close file preview")} /></Modal.Header><Modal.Body className="kulo-artifact-modal-body"><div className="kulo-artifact-large-stage" ref={setLargeStage} /></Modal.Body><Modal.Footer className="kulo-artifact-modal-footer">{frozenTarget && effectiveOnSendToTopic && <ModalFooterComposer target={frozenTarget} connected={effectiveConnected} unavailableReason={effectiveGetUnavailableReason?.(frozenTarget)} onExpandChange={setComposerExpanded} onSendToTopic={effectiveOnSendToTopic} />}{feedback}<div className="kulo-artifact-actions">{actions}</div></Modal.Footer></Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
    <Modal.Backdrop isOpen={sourceOpen} onOpenChange={(open) => { if (!open) { setSourceOpen(false); requestAnimationFrame(() => sourceTrigger.current?.focus({ preventScroll: true })); } }}>
      <Modal.Container size="lg" scroll="inside"><Modal.Dialog><Modal.Header><Modal.Heading>{asset.name}</Modal.Heading><Modal.CloseTrigger aria-label={tr("关闭源码", "Close source")} /></Modal.Header><Modal.Body>{sourceError ? <div className="kulo-artifact-feedback" role="alert"><span>{sourceError}</span><Button size="sm" variant="secondary" onPress={() => setSourceAttempt((value) => value + 1)}>{tr("重试", "Retry")}</Button></div> : source === undefined ? <div className="kulo-artifact-feedback" role="status"><Spinner size="sm" /><span>{tr("正在读取源码", "Loading source")}</span></div> : <CodeBlock code={source} language="html" fileName={asset.name} />}</Modal.Body></Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
  </>;
}
