import { Button, Spinner } from "@heroui/react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ChatAttachment } from "@kulo/protocol";
import { KuloMarkdown } from "../../kulo-markdown";
import { translate as tr, useI18n } from "../../kulo-i18n";
import type { PreviewableImage } from "./asset-preview";
import { readFileAsset } from "./file-actions";
import { readTextPreview, type FilePreviewKind } from "./file-preview-model";

const PdfPreview = lazy(() => import("./pdf-preview"));
const XlsxPreview = lazy(() => import("./xlsx-preview"));
const PptxPreview = lazy(() => import("./pptx-preview"));
const DocxPreview = lazy(() => import("./docx-preview"));

export function FilePreview({
  asset,
  kind,
  onPreviewImage,
}: {
  asset: ChatAttachment;
  kind: Exclude<FilePreviewKind, "html">;
  onPreviewImage?: (image: PreviewableImage) => void;
}) {
  useI18n();
  const fallback = (
    <div className="kulo-artifact-feedback" role="status">
      <Spinner size="sm" />
      <span>{tr("正在加载预览", "Loading preview")}</span>
    </div>
  );
  if (kind === "pdf") {
    return <Suspense fallback={fallback}><PdfPreview key={asset.id} asset={asset} /></Suspense>;
  }
  if (kind === "xlsx") {
    return <Suspense fallback={fallback}><XlsxPreview key={asset.id} asset={asset} /></Suspense>;
  }
  if (kind === "pptx") {
    return <Suspense fallback={fallback}><PptxPreview key={asset.id} asset={asset} onPreviewImage={onPreviewImage} /></Suspense>;
  }
  if (kind === "docx") {
    return <Suspense fallback={fallback}><DocxPreview key={asset.id} asset={asset} onPreviewImage={onPreviewImage} /></Suspense>;
  }
  return <TextPreview key={asset.id} asset={asset} markdown={kind === "markdown"} />;
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
