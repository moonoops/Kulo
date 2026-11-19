import { translate as tr, useI18n } from "../../kulo-i18n";
import type { WebSource } from "@kulo/protocol";
import "./message-sources.css";

export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4_096 || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || /\.(?:localhost|local|internal|home|lan)$/.test(host)) return undefined;
  if (host.startsWith("[")) {
    if (/^\[(?:::|::1|::ffff:|f[cd]|fe[89ab]|ff)/.test(host)) return undefined;
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)) return undefined;
  }
  return url.toString();
}

export function searchSuggestionsDocument(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; object-src 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><style>:root{scrollbar-width:thin;scrollbar-color:color-mix(in oklch,CanvasText 15%,transparent) transparent}body{margin:0;font:14px/20px system-ui,sans-serif;overflow-wrap:anywhere}a{overflow-wrap:anywhere}</style></head><body>${content.slice(0, 24_000)}</body></html>`;
}

export function MessageSources({ sources, searchSuggestions }: { sources: readonly WebSource[]; searchSuggestions?: readonly string[] }) {
  useI18n();
  const urls = new Set<string>();
  const safe = sources.slice(0, 40).flatMap((source) => {
    const url = safeSourceUrl(source.url);
    if (!url || urls.has(url)) return [];
    urls.add(url);
    const title = typeof source.title === "string" ? source.title.trim().slice(0, 300) : "";
    return [{ ...source, url, title: title || new URL(url).hostname }];
  });
  if (!safe.length) return null;
  const suggestions = [...new Set(searchSuggestions?.filter((content) => typeof content === "string" && content.trim()).slice(0, 3))];
  return <>
  <nav className="kulo-message-sources" aria-label={tr("引用来源", "Cited sources")}>
    <span className="kulo-message-sources-label">{tr("来源", "Sources")}</span>
    <ol className="kulo-message-sources-list">
      {safe.map((source) => <li key={source.url} className="kulo-message-source">
        <a className="kulo-message-source-link" href={source.url} target="_blank" rel="noopener noreferrer" title={source.title}>
          <span className="kulo-message-source-title">{source.title}</span>
          <span className="kulo-message-source-domain">{new URL(source.url).hostname.replace(/^www\./, "")}</span>
        </a>
      </li>)}
    </ol>
  </nav>
  {suggestions.length > 0 && <div className="kulo-message-search-suggestions" aria-label={tr("搜索建议", "Search suggestions")}>
    {suggestions.map((content, index) => <iframe key={content} className="kulo-message-search-suggestions-frame" title={tr(`搜索建议 ${index + 1}`, `Search suggestion ${index + 1}`)} sandbox="allow-popups" referrerPolicy="no-referrer" loading="lazy" srcDoc={searchSuggestionsDocument(content)} />)}
  </div>}
  </>;
}
