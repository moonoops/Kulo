import { translate as tr, useI18n } from "./kulo-i18n";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import { Link, Tooltip } from "@heroui/react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { WebSource } from "@kulo/protocol";
import { AssetImage, safeContentUrl, type PreviewableImage } from "./features/chat/asset-preview";
import { CodeBlock } from "./features/chat/code-block";
import {
  indexMessageSources,
  remarkSourceCitations,
  safeSourceUrl,
  shouldRenderCitationPill,
  type IndexedWebSource,
} from "./features/chat/citation-sources";
import "./features/chat/chat-content.css";

export { CodeBlock } from "./features/chat/code-block";

interface CitationHighlightContextValue {
  highlightedSourceUrl?: string;
  onHighlightSource?: (url?: string) => void;
}

const CitationHighlightContext = createContext<CitationHighlightContextValue>({});

export function markdownUrlTransform(url: string, key: string): string {
  if (key === "src") return safeContentUrl(url) ?? "";
  if (/^mailto:/i.test(url) || url.startsWith("#")) return defaultUrlTransform(url);
  return safeContentUrl(url) ?? "";
}

function hastText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const entry = node as { type?: string; value?: unknown; children?: unknown[] };
  if (entry.type === "text" && typeof entry.value === "string") return entry.value;
  return Array.isArray(entry.children) ? entry.children.map(hastText).join("") : "";
}

function CitationTooltip({ citation }: { citation: IndexedWebSource }) {
  return <Tooltip.Content placement="top" className="kulo-chat-citation-tooltip">
    <span className="kulo-chat-citation-tooltip-domain">[{citation.index}] {citation.domain}</span>
    <span className="kulo-chat-citation-tooltip-title">{citation.title}</span>
    {citation.snippet && <span className="kulo-chat-citation-tooltip-snippet">{citation.snippet}</span>}
  </Tooltip.Content>;
}

function SourceCitationLink({
  citation,
  asPill,
  children,
}: {
  citation: IndexedWebSource;
  asPill: boolean;
  children: ReactNode;
}) {
  const { highlightedSourceUrl, onHighlightSource } = useContext(CitationHighlightContext);
  const highlighted = highlightedSourceUrl === citation.url;
  const linkEl = asPill
    ? <Link
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
      className="kulo-chat-citation"
      data-highlighted={highlighted || undefined}
      aria-label={tr(`来源 ${citation.index}：${citation.title}（${citation.domain}）`, `Source ${citation.index}: ${citation.title} (${citation.domain})`)}
      onHoverChange={(hovered) => onHighlightSource?.(hovered ? citation.url : undefined)}
      onFocus={() => onHighlightSource?.(citation.url)}
      onBlur={() => onHighlightSource?.(undefined)}
    >
      <span className="kulo-chat-citation-label">{citation.siteLabel}</span>
      {citation.showIndex && <span className="kulo-chat-citation-index">{citation.index}</span>}
    </Link>
    : <Link
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
      className="kulo-chat-prose-link"
      onHoverChange={(hovered) => onHighlightSource?.(hovered ? citation.url : undefined)}
      onFocus={() => onHighlightSource?.(citation.url)}
      onBlur={() => onHighlightSource?.(undefined)}
    >
      {children}
    </Link>;
  return <Tooltip delay={180} closeDelay={120}>
    {linkEl}
    <CitationTooltip citation={citation} />
  </Tooltip>;
}

export function KuloMarkdown({
  text,
  sources,
  highlightedSourceUrl,
  onHighlightSource,
  onPreviewImage,
}: {
  text: string;
  sources?: readonly WebSource[];
  highlightedSourceUrl?: string;
  onHighlightSource?: (url?: string) => void;
  onPreviewImage?: (image: PreviewableImage) => void;
}) {
  const { language } = useI18n();
  const sourceMap = useMemo(() => {
    const map = new Map<string, IndexedWebSource>();
    for (const item of indexMessageSources(sources)) map.set(item.url, item);
    return map;
  }, [sources]);

  const highlightContext = useMemo(
    () => ({ highlightedSourceUrl, onHighlightSource }),
    [highlightedSourceUrl, onHighlightSource],
  );

  const remarkPlugins = useMemo(
    () => sourceMap.size
      ? [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough, remarkSourceCitations(sourceMap)]
      : [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough],
    [sourceMap],
  );

  const components: Components = useMemo(() => ({
    pre: ({ node, children }) => {
      const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
      if (!code || code.type !== "element") return <pre>{children}</pre>;
      const classNames = Array.isArray(code.properties.className) ? code.properties.className : [];
      const codeLanguage = classNames.map(String).find((name) => name.startsWith("language-"))?.slice(9);
      const value = code.children.map((child) => child.type === "text" ? child.value : "").join("").replace(/\n$/, "");
      return <CodeBlock code={value} language={codeLanguage} />;
    },
    code: ({ children }) => <code className="kulo-chat-inline-code">{children}</code>,
    a: ({ href, children, node, ...rest }) => {
      if (!href) return <span>{children}</span>;
      const normalized = safeSourceUrl(href);
      const citation = normalized ? sourceMap.get(normalized) : undefined;
      if (citation) {
        const props = (node?.properties ?? {}) as Record<string, unknown>;
        const citationKind = String((rest as Record<string, unknown>)["data-kulo-citation"] ?? props.dataKuloCitation ?? props["data-kulo-citation"] ?? "") || undefined;
        const asPill = shouldRenderCitationPill({ source: citation, linkText: hastText(node), citationKind });
        return <SourceCitationLink citation={citation} asPill={asPill}>{children}</SourceCitationLink>;
      }
      return <Link href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" className="kulo-chat-prose-link">{children}</Link>;
    },
    img: ({ src, alt }) => typeof src === "string" && src ? <AssetImage image={{ src, name: alt || tr("图片", "Image") }} onPreviewImage={onPreviewImage} /> : <span className="kulo-chat-meta">{alt || tr("图片无法显示", "Image unavailable")}</span>,
    table: ({ children }) => <div className="kulo-chat-table-scroll" tabIndex={0} role="region" aria-label={tr("表格", "Table")}><table className="kulo-chat-table">{children}</table></div>,
    blockquote: ({ children, node }) => {
      const content = node?.children.flatMap((child) => child.type === "element" ? child.children : [child]).map((child) => child.type === "text" ? child.value : "").join("") ?? "";
      return <blockquote className={/🧠|Hindsight/.test(content) ? "kulo-chat-memory-callout" : undefined}>{children}</blockquote>;
    },
    input: ({ checked }) => <span className="kulo-chat-task-mark" role="img" aria-label={checked ? tr("已完成", "Complete") : tr("未完成", "Incomplete")}>{checked ? "☑" : "☐"}</span>,
  }), [onPreviewImage, language, sourceMap]);

  if (!text) return null;
  return <CitationHighlightContext.Provider value={highlightContext}>
    <div className="kulo-chat-markdown"><Markdown skipHtml remarkPlugins={remarkPlugins} urlTransform={markdownUrlTransform} components={components}>{text}</Markdown></div>
  </CitationHighlightContext.Provider>;
}
