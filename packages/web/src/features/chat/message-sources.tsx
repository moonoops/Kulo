import { Disclosure } from "@heroui/react";
import { useMemo, useState } from "react";
import { translate as tr, useI18n } from "../../kulo-i18n";
import type { WebSource } from "@kulo/protocol";
import { indexMessageSources, safeSourceUrl, summarizeSourceSites } from "./citation-sources";
import "./message-sources.css";

export { safeSourceUrl };

export function searchSuggestionsDocument(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; object-src 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><style>:root{scrollbar-width:thin;scrollbar-color:color-mix(in oklch,CanvasText 15%,transparent) transparent}body{margin:0;font:14px/20px system-ui,sans-serif;overflow-wrap:anywhere}a{overflow-wrap:anywhere}</style></head><body>${content.slice(0, 24_000)}</body></html>`;
}

export function MessageSources({
  sources,
  searchSuggestions,
  highlightedSourceUrl,
  onHighlightSource,
}: {
  sources: readonly WebSource[];
  searchSuggestions?: readonly string[];
  highlightedSourceUrl?: string;
  onHighlightSource?: (url?: string) => void;
}) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  const safe = useMemo(() => indexMessageSources(sources), [sources]);
  const siteSummary = useMemo(() => summarizeSourceSites(safe), [safe]);

  if (!safe.length) return null;
  const suggestions = [...new Set(searchSuggestions?.filter((content) => typeof content === "string" && content.trim()).slice(0, 3))];
  const countLabel = tr(`来源 · ${safe.length}`, `Sources · ${safe.length}`);

  return <>
    <nav className="kulo-message-sources" aria-label={tr("引用来源", "Cited sources")}>
      <Disclosure isExpanded={expanded} onExpandedChange={setExpanded} className="kulo-message-sources-disclosure">
        <Disclosure.Heading level={3} className="kulo-message-sources-heading">
          <Disclosure.Trigger className="kulo-message-sources-trigger">
            <span className="kulo-message-sources-count">{countLabel}</span>
            {siteSummary && <span className="kulo-message-sources-preview" aria-hidden="true">{siteSummary}</span>}
            <Disclosure.Indicator className="kulo-message-sources-indicator" />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content className="kulo-message-sources-content">
          <Disclosure.Body className="kulo-message-sources-body">
            <ol className="kulo-message-sources-list">
              {safe.map((source) => {
                const highlighted = highlightedSourceUrl === source.url;
                return <li key={source.url} className="kulo-message-source">
                  <a
                    className="kulo-message-source-link"
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={source.title}
                    data-highlighted={highlighted || undefined}
                    onMouseEnter={() => onHighlightSource?.(source.url)}
                    onMouseLeave={() => onHighlightSource?.(undefined)}
                    onFocus={() => onHighlightSource?.(source.url)}
                    onBlur={() => onHighlightSource?.(undefined)}
                  >
                    <span className="kulo-message-source-index" aria-hidden="true">{source.index}</span>
                    <span className="kulo-message-source-title">{source.title}</span>
                    <span className="kulo-message-source-domain">{source.domain}</span>
                  </a>
                </li>;
              })}
            </ol>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </nav>
    {suggestions.length > 0 && <div className="kulo-message-search-suggestions" aria-label={tr("搜索建议", "Search suggestions")}>
      {suggestions.map((content, index) => <iframe key={content} className="kulo-message-search-suggestions-frame" title={tr(`搜索建议 ${index + 1}`, `Search suggestion ${index + 1}`)} sandbox="allow-popups" referrerPolicy="no-referrer" loading="lazy" srcDoc={searchSuggestionsDocument(content)} />)}
    </div>}
  </>;
}
