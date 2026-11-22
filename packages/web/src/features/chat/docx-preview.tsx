import { Button, Spinner } from "@heroui/react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { ChatAttachment } from "@kulo/protocol";
import { translate as tr, useI18n } from "../../kulo-i18n";
import type { ImagePreviewSource, PreviewableImage } from "./asset-preview";
import { parseDocxArchive, type DocxDocumentData, type DocxInlineRun, type DocxParagraphBlock } from "./docx-parser";
import { BlobUrlRegistry, fetchOfficeArchive, normalizeOfficeError, type OfficePreviewError, type ResolvedOfficeImage } from "./office-archive";
import "./office-preview.css";

function toImageSource(image: ResolvedOfficeImage): ImagePreviewSource {
  return { src: image.url, name: image.name, size: image.size };
}

function renderRun(
  run: DocxInlineRun,
  key: number,
  openLightbox?: (image: ResolvedOfficeImage) => void,
): ReactNode {
  if (run.kind === "break") return <br key={key} />;
  if (run.kind === "image") {
    return openLightbox ? (
      <button
        key={key}
        type="button"
        className="kulo-office-image-button"
        aria-label={tr(`查看大图：${run.alt}`, `Inspect image: ${run.alt}`)}
        onClick={() => openLightbox(run.image)}
      >
        <img className="kulo-office-image" src={run.image.url} alt={run.alt} />
      </button>
    ) : (
      <img key={key} className="kulo-office-image" src={run.image.url} alt={run.alt} />
    );
  }

  let node: ReactNode = run.text;
  if (run.code) node = <code className="kulo-docx-code">{node}</code>;
  if (run.bold) node = <strong>{node}</strong>;
  if (run.italic) node = <em>{node}</em>;
  if (run.underline) node = <u>{node}</u>;
  if (run.strike) node = <del>{node}</del>;
  if (run.vertAlign === "superscript") node = <sup>{node}</sup>;
  else if (run.vertAlign === "subscript") node = <sub>{node}</sub>;
  if (run.highlight) node = <mark className="kulo-docx-highlight">{node}</mark>;
  if (run.href) {
    node = (
      <a className="kulo-chat-prose-link" href={run.href} target="_blank" rel="noopener noreferrer">
        {node}
      </a>
    );
  }
  return <Fragment key={key}>{node}</Fragment>;
}

function renderParagraph(
  block: DocxParagraphBlock,
  key: number,
  openLightbox?: (image: ResolvedOfficeImage) => void,
): ReactNode {
  const content = block.runs.map((run, index) => renderRun(run, index, openLightbox));
  const className = block.shaded ? "kulo-docx-p kulo-docx-p--shaded" : "kulo-docx-p";

  if (block.list) {
    const marker = block.list.ordered ? `${block.list.ordinal ?? 1}.` : "•";
    return (
      <div key={key} className="kulo-docx-list-row" data-level={block.list.level}>
        <span className="kulo-docx-list-marker" aria-hidden="true">
          {marker}
        </span>
        <p className={`${className} kulo-docx-list-content`} data-role={block.role} data-align={block.align}>
          {content}
        </p>
      </div>
    );
  }

  return (
    <p key={key} className={className} data-role={block.role} data-align={block.align}>
      {content}
    </p>
  );
}

export default function DocxPreview({
  asset,
  onPreviewImage,
}: {
  asset: ChatAttachment;
  onPreviewImage?: (image: PreviewableImage) => void;
}) {
  useI18n();
  const [doc, setDoc] = useState<DocxDocumentData>();
  const [error, setError] = useState<OfficePreviewError>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const registry = new BlobUrlRegistry();
    setDoc(undefined);
    setError(undefined);
    void (async () => {
      const archive = await fetchOfficeArchive(asset.id, controller.signal);
      const parsed = await parseDocxArchive(archive, registry, undefined, controller.signal);
      if (controller.signal.aborted) {
        registry.dispose(0);
        return;
      }
      setDoc(parsed);
    })().catch((reason: unknown) => {
      registry.dispose(0);
      if (!controller.signal.aborted) {
        setError(normalizeOfficeError(reason, tr("文档预览失败", "Unable to preview document")));
      }
    });
    return () => {
      controller.abort();
      registry.dispose();
    };
  }, [asset.id, attempt]);

  if (error) {
    return (
      <div className="kulo-artifact-feedback" role="alert">
        <span>{error.message}</span>
        {error.retryable && (
          <Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
            {tr("重试", "Retry")}
          </Button>
        )}
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="kulo-artifact-feedback" role="status">
        <Spinner size="sm" />
        <span>{tr("正在加载文档", "Loading document")}</span>
      </div>
    );
  }

  const gallery = doc.images.map(toImageSource);
  const openLightbox = onPreviewImage
    ? (image: ResolvedOfficeImage) => {
        const index = gallery.findIndex((item) => item.src === image.url);
        onPreviewImage({ ...toImageSource(image), gallery, index: index >= 0 ? index : 0 });
      }
    : undefined;

  return (
    <div className="kulo-docx-preview">
      <article className="kulo-docx-paper" aria-label={asset.name}>
        {doc.headerText && (
          <p className="kulo-docx-running-text kulo-docx-running-text--header">{doc.headerText}</p>
        )}

        {doc.blocks.length === 0 ? (
          <p className="kulo-office-empty">{tr("空文档", "Empty document")}</p>
        ) : (
          doc.blocks.map((block, index) => {
            if (block.kind === "page-break") {
              return <hr key={index} className="kulo-docx-page-break" />;
            }
            if (block.kind === "paragraph") {
              return renderParagraph(block, index, openLightbox);
            }
            return (
              <div key={index} className="kulo-office-table-scroll">
                <table className="kulo-office-table">
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, colIndex) => {
                          if (!cell) return null;
                          const Tag = cell.isHeader ? "th" : "td";
                          const cellClass = [
                            cell.isHeader ? "kulo-table-header" : "",
                            cell.isHeader || cell.shaded ? "kulo-office-table-cell--shaded" : "",
                          ]
                            .filter(Boolean)
                            .join(" ");
                          return (
                            <Tag
                              key={colIndex}
                              scope={cell.isHeader ? "col" : undefined}
                              className={cellClass || undefined}
                              rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                              colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                            >
                              {cell.paragraphs.length > 0
                                ? cell.paragraphs.map((p, pIdx) => renderParagraph(p, pIdx, openLightbox))
                                : null}
                            </Tag>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })
        )}

        {doc.omittedImages > 0 && (
          <p className="kulo-office-notice">
            {tr("部分图片超出预览体积预算已省略。", "Some images were omitted to stay within preview limits.")}
          </p>
        )}
        {doc.truncatedBlocks && (
          <p className="kulo-office-notice">
            {tr(
              `仅预览前 ${doc.blocks.length} 个内容块，完整文档请下载或在默认应用打开。`,
              `Showing first ${doc.blocks.length} blocks. Download or open in default app for the full document.`,
            )}
          </p>
        )}
        {doc.footerText && (
          <p className="kulo-docx-running-text kulo-docx-running-text--footer">{doc.footerText}</p>
        )}
      </article>
    </div>
  );
}
