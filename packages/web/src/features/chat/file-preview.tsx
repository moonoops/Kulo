import { Button, Spinner } from "@heroui/react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ChatAttachment } from "@kulo/protocol";
import { KuloMarkdown } from "../../kulo-markdown";
import { translate as tr, useI18n } from "../../kulo-i18n";
import { readFileAsset } from "./file-actions";
import { readTextPreview, type FilePreviewKind } from "./file-preview-model";

const PdfPreview = lazy(() => import("./pdf-preview"));

export function FilePreview({ asset, kind }: { asset: ChatAttachment; kind: Exclude<FilePreviewKind, "html"> }) {
  useI18n();
  return kind === "pdf" ? <Suspense fallback={<div className="kulo-artifact-feedback" role="status"><Spinner size="sm" /><span>{tr("正在加载预览", "Loading preview")}</span></div>}><PdfPreview asset={asset} /></Suspense> : <TextPreview key={asset.id} asset={asset} markdown={kind === "markdown"} />;
}

function TextPreview({ asset, markdown }: { asset: ChatAttachment; markdown: boolean }) {
  const [content, setContent] = useState<{ text: string; truncated: boolean }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined); setError("");
    void readFileAsset(asset.id, controller.signal).then((response) => readTextPreview(response, controller.signal)).then((result) => {
      if (!controller.signal.aborted) setContent(result);
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : tr("预览加载失败", "Failed to load preview"));
    });
    return () => controller.abort();
  }, [asset.id, attempt]);
  if (error) return <div className="kulo-artifact-feedback" role="alert"><span>{error}</span><Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>{tr("重试", "Retry")}</Button></div>;
  if (!content) return <div className="kulo-artifact-feedback" role="status"><Spinner size="sm" /><span>{tr("正在加载预览", "Loading preview")}</span></div>;
  return <div className="kulo-artifact-text">
    {markdown ? <KuloMarkdown text={content.text} /> : <pre className="kulo-artifact-plain-text">{content.text || tr("空文件", "Empty file")}</pre>}
    {content.truncated && <p className="kulo-item-description">{tr("仅预览前 256 KB，下载或用默认应用查看完整内容。", "Previewing the first 256 KB. Download or open the original for the complete file.")}</p>}
  </div>;
}
