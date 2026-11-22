import { Button, Disclosure, Spinner } from "@heroui/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatAttachment } from "@kulo/protocol";
import { translate as tr, useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import type { ImagePreviewSource, PreviewableImage } from "./asset-preview";
import { BlobUrlRegistry, fetchOfficeArchive, normalizeOfficeError, type OfficePreviewError, type ResolvedOfficeImage } from "./office-archive";
import { resetPdfPageScroll } from "./pdf-reading-position";
import { PptxDeckSession, type PptxSlideData } from "./pptx-parser";
import "./office-preview.css";

function toImageSource(image: ResolvedOfficeImage): ImagePreviewSource {
  return { src: image.url, name: image.name, size: image.size };
}

export default function PptxPreview({
  asset,
  onPreviewImage,
}: {
  asset: ChatAttachment;
  onPreviewImage?: (image: PreviewableImage) => void;
}) {
  useI18n();
  const [session, setSession] = useState<PptxDeckSession>();
  const [page, setPage] = useState(1);
  const [slide, setSlide] = useState<PptxSlideData>();
  const [slideLoading, setSlideLoading] = useState(false);
  const [error, setError] = useState<OfficePreviewError>();
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const previousPage = useRef(page);

  useEffect(() => {
    const controller = new AbortController();
    const registry = new BlobUrlRegistry();
    setSession(undefined);
    setSlide(undefined);
    setPage(1);
    setError(undefined);
    void (async () => {
      const archive = await fetchOfficeArchive(asset.id, controller.signal);
      const opened = await PptxDeckSession.open(archive, registry, undefined, controller.signal);
      if (controller.signal.aborted) {
        registry.dispose(0);
        return;
      }
      setSession(opened);
    })().catch((reason: unknown) => {
      registry.dispose(0);
      if (!controller.signal.aborted) {
        setError(normalizeOfficeError(reason, tr("演示文稿预览失败", "Unable to preview presentation")));
      }
    });
    return () => {
      controller.abort();
      registry.dispose();
    };
  }, [asset.id, attempt]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setSlideLoading(true);
    setError(undefined);
    void session.loadSlide(page - 1, controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) {
          setSlide(loaded);
          setSlideLoading(false);
        }
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setSlideLoading(false);
          setError(normalizeOfficeError(reason, tr("幻灯片加载失败", "Unable to load slide")));
        }
      },
    );
    return () => controller.abort();
  }, [session, page]);

  useLayoutEffect(() => {
    resetPdfPageScroll(containerRef.current, previousPage.current, page);
    previousPage.current = page;
  }, [page]);

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

  if (!session) {
    return (
      <div className="kulo-artifact-feedback" role="status">
        <Spinner size="sm" />
        <span>{tr("正在加载幻灯片", "Loading presentation")}</span>
      </div>
    );
  }

  const totalPages = session.meta.slideCount;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowLeft" && page > 1) {
      event.preventDefault();
      setPage((current) => Math.max(1, current - 1));
    } else if (event.key === "ArrowRight" && page < totalPages) {
      event.preventDefault();
      setPage((current) => Math.min(totalPages, current + 1));
    }
  };

  const gallery = slide ? slide.images.map(toImageSource) : [];
  const openLightbox = (image: ResolvedOfficeImage) => {
    if (!onPreviewImage) return;
    const index = gallery.findIndex((item) => item.src === image.url);
    onPreviewImage({ ...toImageSource(image), gallery, index: index >= 0 ? index : 0 });
  };

  const isEmptySlide = slide && !slide.title && !slide.subtitle && slide.blocks.length === 0;

  return (
    <div
      ref={containerRef}
      className="kulo-pptx-preview"
      role="region"
      aria-label={tr(`演示文稿第 ${page} 页`, `Slide ${page}`)}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="kulo-pptx-toolbar" aria-label={tr("幻灯片翻页控制", "Slide navigation")}>
        <div className="kulo-pptx-controls">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={tr("上一页", "Previous slide")}
            isDisabled={page <= 1}
            onPress={() => setPage((current) => Math.max(1, current - 1))}
          >
            <KuloIcon name="arrow-left" size={16} />
          </Button>
          <span className="kulo-pptx-page-label" aria-live="polite">
            {tr(`第 ${page} 页 / 共 ${totalPages} 页`, `Slide ${page} / ${totalPages}`)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={tr("下一页", "Next slide")}
            isDisabled={page >= totalPages}
            onPress={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            <KuloIcon name="chevron-right" size={16} />
          </Button>
        </div>
        {session.meta.truncatedSlides && (
          <span className="kulo-pptx-page-label">
            {tr(`仅预览前 ${totalPages} 页`, `First ${totalPages} slides`)}
          </span>
        )}
      </div>

      {slideLoading || !slide ? (
        <div className="kulo-artifact-feedback" role="status">
          <Spinner size="sm" />
          <span>{tr("正在加载幻灯片", "Loading slide")}</span>
        </div>
      ) : (
        <article className="kulo-pptx-slide">
          {(slide.title || slide.subtitle) && (
            <header className="kulo-pptx-slide-header">
              {slide.title && <h3 className="kulo-pptx-slide-title">{slide.title}</h3>}
              {slide.subtitle && <p className="kulo-pptx-slide-subtitle">{slide.subtitle}</p>}
            </header>
          )}

          {isEmptySlide ? (
            <p className="kulo-office-empty">
              {tr("此页主要包含版式图形，可在默认应用查看完整效果。", "This slide contains visual layout graphics. Open in default app for full view.")}
            </p>
          ) : (
            slide.blocks.map((block, blockIndex) => {
              if (block.kind === "text") {
                return (
                  <div key={blockIndex} className="kulo-pptx-text-block">
                    {block.lines.map((line, lineIndex) => (
                      <p key={lineIndex} className="kulo-pptx-line" data-level={line.level}>
                        {line.bullet && (
                          <span className="kulo-pptx-bullet" aria-hidden="true">
                            •
                          </span>
                        )}
                        <span>{line.text}</span>
                      </p>
                    ))}
                  </div>
                );
              }
              if (block.kind === "table") {
                return (
                  <div key={blockIndex} className="kulo-office-table-scroll">
                    <table className="kulo-office-table">
                      <tbody>
                        {block.rows.map((row, rowIndex) => (
                          <tr key={rowIndex}>
                            {row.map((cell, colIndex) => {
                              if (!cell) return null;
                              const Tag = rowIndex === 0 ? "th" : "td";
                              return (
                                <Tag
                                  key={colIndex}
                                  scope={rowIndex === 0 ? "col" : undefined}
                                  className={rowIndex === 0 ? "kulo-table-header kulo-office-table-cell--shaded" : undefined}
                                  rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                                  colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                                >
                                  {cell.text}
                                </Tag>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              }
              if (block.kind === "chart") {
                return (
                  <div key={blockIndex} className="kulo-pptx-chart-tag">
                    <KuloIcon name="chart" size={16} />
                    <span>
                      {block.title
                        ? tr(`图表：${block.title}`, `Chart: ${block.title}`)
                        : tr("图表（可在默认应用查看完整样式）", "Chart (open in default app for full view)")}
                    </span>
                  </div>
                );
              }
              return onPreviewImage ? (
                <button
                  key={blockIndex}
                  type="button"
                  className="kulo-office-image-button"
                  aria-label={tr(`查看大图：${block.alt}`, `Inspect image: ${block.alt}`)}
                  onClick={() => openLightbox(block.image)}
                >
                  <img className="kulo-office-image" src={block.image.url} alt={block.alt} />
                </button>
              ) : (
                <img key={blockIndex} className="kulo-office-image" src={block.image.url} alt={block.alt} />
              );
            })
          )}

          {slide.omittedImages > 0 && (
            <p className="kulo-office-notice">
              {tr("部分图片超出预览体积预算已省略。", "Some images were omitted to stay within preview limits.")}
            </p>
          )}

          {slide.notes && (
            <div className="kulo-pptx-notes">
              <Disclosure>
                <Disclosure.Heading>
                  <Button slot="trigger" variant="ghost" size="sm">
                    <span>{tr("演讲备注", "Speaker notes")}</span>
                    <Disclosure.Indicator />
                  </Button>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body className="kulo-pptx-notes-body">{slide.notes}</Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            </div>
          )}
        </article>
      )}
    </div>
  );
}
