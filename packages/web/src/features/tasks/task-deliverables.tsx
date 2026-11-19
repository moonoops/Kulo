import { translate, useI18n } from "../../kulo-i18n";
import { Button, Modal, Spinner } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import type { TicketRecord } from "@kulo/protocol";
import { getAuthTokenFromUrl, kuloRest, type TicketDeliverable } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { formatAssetSize } from "../chat/asset-preview";

export function taskPreviewDocument(html: string): string {
  // srcDoc has no response headers; keep active documents away from the Hub and network.
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">${html}`;
}

async function readFile(file: TicketDeliverable, signal?: AbortSignal): Promise<Response> {
  const token = getAuthTokenFromUrl();
  const response = await fetch(file.url, { signal, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!response.ok) {
    const body = await response.text();
    let message = translate(`文件读取失败 (HTTP ${response.status})`, `Failed to read file (HTTP ${response.status})`);
    try { message = (JSON.parse(body) as { error?: string }).error || message; }
    catch { /* An HTML gateway error is not a server JSON error message. */ }
    throw new Error(message);
  }
  return response;
}

export function TaskDeliverables({ ticket, connected }: { ticket: TicketRecord; connected: boolean }) {
  const { t } = useI18n();
  const [files, setFiles] = useState<TicketDeliverable[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<TicketDeliverable>();
  const [html, setHtml] = useState<string>();
  const [previewError, setPreviewError] = useState("");
  const [downloading, setDownloading] = useState<string>();
  const downloadController = useRef<AbortController | undefined>(undefined);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setFiles([]); setMissing([]);
    void kuloRest.getTicketDeliverables(ticket.id, controller.signal).then(result => {
      if (!controller.signal.aborted) { setFiles(result.files); setMissing(result.missing ?? []); }
    }, (failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("交付文件加载失败", "Failed to load delivered files"));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticket.id, ticket.latestReport?.at, attempt]);
  useEffect(() => () => downloadController.current?.abort(), []);
  useEffect(() => {
    setHtml(undefined); setPreviewError("");
    if (!preview) return;
    const controller = new AbortController();
    void readFile(preview, controller.signal).then(response => response.text()).then(text => {
      if (!controller.signal.aborted) setHtml(text);
    }, (failure: unknown) => {
      if (!controller.signal.aborted) setPreviewError(failure instanceof Error ? failure.message : t("预览加载失败", "Failed to load preview"));
    });
    return () => controller.abort();
  }, [preview]);
  const download = async (file: TicketDeliverable) => {
    downloadController.current?.abort();
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(file.id); setError("");
    try {
      const blob = await (await readFile(file, controller.signal)).blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = file.name; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("下载失败", "Download failed"));
    } finally { if (!controller.signal.aborted) setDownloading(undefined); }
  };
  const closePreview = () => {
    setPreview(undefined);
    requestAnimationFrame(() => previewTrigger.current?.focus({ preventScroll: true }));
  };
  return <>
    {loading && <div className="kulo-task-deliverable-feedback" role="status"><Spinner size="sm" /><span>{t("正在加载交付文件…", "Loading delivered files…")}</span></div>}
    {files.length > 0 && <ul className="kulo-task-deliverables" aria-label={t("交付文件", "Delivered files")}>
      {files.map(file => <li key={file.id} className="kulo-task-file">
        <KuloIcon name="attach" size={20} />
        <div className="kulo-task-file-description"><strong className="kulo-item-title">{file.name}</strong><span className="kulo-item-description">{formatAssetSize(file.size)}</span></div>
        <div className="kulo-task-file-actions">
          {file.previewable && <Button variant="primary" size="sm" isDisabled={!connected} aria-label={t(`预览文件：${file.name}`, `Preview file: ${file.name}`)} onPress={(event) => { previewTrigger.current = event.target as HTMLButtonElement; setPreview(file); }}>{t("预览", "Preview")}</Button>}
          <Button variant="secondary" size="sm" isDisabled={!connected || Boolean(downloading)} isPending={downloading === file.id} aria-label={t(`下载文件：${file.name}`, `Download file: ${file.name}`)} onPress={() => { void download(file); }}>{t("下载", "Download")}</Button>
        </div>
      </li>)}
    </ul>}
    {missing.length > 0 && <p className="kulo-item-description" role="status">{t("文件不可用：", "File unavailable: ")}{missing.join(t("、", ", "))}</p>}
    {error && <div className="kulo-task-deliverable-feedback" role="alert"><span>{error}</span><Button size="sm" variant="ghost" isDisabled={!connected} onPress={() => setAttempt(value => value + 1)}>{t("重新加载", "Reload")}</Button></div>}
    <Modal.Backdrop isOpen={Boolean(preview)} onOpenChange={open => { if (!open) closePreview(); }}>
      <Modal.Container size="cover" scroll="inside">
        <Modal.Dialog className="kulo-task-file-preview">
          <Modal.Header><Modal.Heading>{preview?.name}</Modal.Heading><Modal.CloseTrigger aria-label={t("关闭文件预览", "Close file preview")} /></Modal.Header>
          <Modal.Body className="kulo-task-file-preview-body">
            {previewError ? <div className="kulo-task-deliverable-feedback" role="alert"><span>{previewError}</span><Button size="sm" variant="secondary" onPress={() => setPreview(current => current ? { ...current } : current)}>{t("重试", "Retry")}</Button></div>
              : html === undefined ? <div className="kulo-task-deliverable-feedback" role="status"><Spinner size="sm" /><span>{t("正在加载预览…", "Loading preview…")}</span></div>
                : <iframe title={t(`预览：${preview?.name}`, `Preview: ${preview?.name}`)} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={taskPreviewDocument(html)} className="kulo-task-file-frame" />}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}
