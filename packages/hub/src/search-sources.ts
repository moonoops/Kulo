import type { WebSource } from "@kulo/protocol";
import { normalizeWebSourceUrl } from "./web-content.js";

const SOURCE_LIMIT = 40;
const text = (value: unknown, limit: number): string | undefined => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) || undefined
  : undefined;

export function sanitizeSearchSources(value: unknown): WebSource[] {
  if (!Array.isArray(value)) return [];
  const sources: WebSource[] = [];
  const urls = new Set<string>();
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const url = typeof raw.url === "string" ? normalizeWebSourceUrl(raw.url) : undefined;
    const id = typeof raw.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.id) ? raw.id : undefined;
    const title = text(raw.title, 300);
    if (!url || !id || !title || urls.has(url)) continue;
    urls.add(url);
    const snippet = text(raw.snippet, 2_000);
    const content = typeof raw.content === "string" ? raw.content.slice(0, 24_000) : undefined;
    const publishedAt = text(raw.publishedAt, 100);
    sources.push({ id, title, url, ...(snippet ? { snippet } : {}), ...(content ? { content } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(typeof raw.fetchedAt === "number" && Number.isFinite(raw.fetchedAt) && raw.fetchedAt >= 0 ? { fetchedAt: raw.fetchedAt } : {}) });
    if (sources.length === SOURCE_LIMIT) break;
  }
  return sources;
}

export function nativeSearchEvidence(value: unknown): { sources: WebSource[]; searchSuggestions: string[] } {
  if (!value || typeof value !== "object") return { sources: [], searchSuggestions: [] };
  const message = value as { role?: unknown; stopReason?: unknown; kuloSearchSources?: unknown; kuloSearchSuggestions?: unknown };
  if (message.role !== "assistant" || ["error", "aborted", "length"].includes(String(message.stopReason))) return { sources: [], searchSuggestions: [] };
  const sources = sanitizeSearchSources(message.kuloSearchSources);
  const searchSuggestions = sources.length && Array.isArray(message.kuloSearchSuggestions)
    ? message.kuloSearchSuggestions.filter((item): item is string => typeof item === "string" && item.length <= 24_000).slice(-4) : [];
  return { sources, searchSuggestions };
}

function escaped(value: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

function withoutCode(value: string): string {
  let fence: { mark: string; length: number } | undefined;
  const lines = value.slice(0, 200_000).split("\n").map((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match?.[1]?.[0] === fence.mark && match[1].length >= fence.length && !match[2]?.trim()) fence = undefined;
      return "";
    }
    if (match) { fence = { mark: match[1]![0]!, length: match[1]!.length }; return ""; }
    if (/^(?: {4}|\t)/.test(line)) return "";
    return line;
  }).join("\n");
  const ticks = [...lines.matchAll(/`+/g)];
  const following = new Map<number, number>();
  const next = new Array<number>(ticks.length).fill(-1);
  for (let index = ticks.length - 1; index >= 0; index--) {
    const length = ticks[index]![0].length;
    next[index] = following.get(length) ?? -1;
    following.set(length, index);
  }
  let output = "";
  let offset = 0;
  for (let index = 0; index < ticks.length; index++) {
    const close = next[index]!;
    if (close < 0) continue;
    output += lines.slice(offset, ticks[index]!.index);
    offset = ticks[close]!.index + ticks[close]![0].length;
    index = close;
  }
  return output + lines.slice(offset);
}

function closingBracket(value: string, start: number): number {
  let depth = 1;
  for (let i = start + 1; i < value.length; i++) {
    if (escaped(value, i)) continue;
    if (value[i] === "[") depth++;
    if (value[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

function destination(value: string, start: number): { url: string; end: number } | undefined {
  let i = start;
  while (/\s/.test(value[i] ?? "") && i < value.length) i++;
  let raw = "";
  if (value[i] === "<") {
    const end = value.indexOf(">", i + 1);
    if (end < 0) return undefined;
    raw = value.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    for (; i < value.length; i++) {
      const character = value[i]!;
      if (character === "\\" && /[\\()]/.test(value[i + 1] ?? "")) { raw += value[++i]; continue; }
      if (character === "(" && ++depth > 16) return undefined;
      if (character === ")") { if (depth === 0) break; depth--; }
      if (/\s/.test(character)) break;
      raw += character;
    }
    if (depth !== 0) return undefined;
  }
  while (/\s/.test(value[i] ?? "") && i < value.length) i++;
  if (value[i] === '"' || value[i] === "'") {
    const quote = value[i++]!;
    while (i < value.length && (value[i] !== quote || escaped(value, i))) i++;
    if (value[i++] !== quote) return undefined;
    while (/\s/.test(value[i] ?? "") && i < value.length) i++;
  }
  return value[i] === ")" ? { url: raw, end: i } : undefined;
}

const referenceKey = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

function citedUrls(markdown: string): Set<string> {
  const urls = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const url = normalizeWebSourceUrl(raw.replace(/&amp;/g, "&"));
    if (url) urls.add(url);
  };
  const references = new Map<string, string>();
  const value = withoutCode(markdown).replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^\s]+))[^\n]*$/gm, (_line, label: string, angle: string | undefined, bare: string | undefined) => {
    const key = referenceKey(label);
    if (!references.has(key)) references.set(key, angle ?? bare ?? "");
    return "";
  });
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "<" && !escaped(value, i)) {
      const link = /^<(https?:\/\/[^<>\s]+)>/i.exec(value.slice(i));
      if (link) { add(link[1]); i += link[0].length - 1; continue; }
    }
    if (value[i] !== "[" || escaped(value, i)) continue;
    const close = closingBracket(value, i);
    if (close < 0) break;
    const image = value[i - 1] === "!" && !escaped(value, i - 1);
    const label = value.slice(i + 1, close);
    if (value[close + 1] === "(") {
      const link = destination(value, close + 2);
      if (link) { if (!image) add(link.url); i = link.end; continue; }
    } else if (value[close + 1] === "[") {
      const end = closingBracket(value, close + 1);
      if (end >= 0) { if (!image) add(references.get(referenceKey(value.slice(close + 2, end) || label))); i = end; continue; }
    } else if (!image) add(references.get(referenceKey(label)));
    i = close;
  }
  return urls;
}

/** A source becomes a citation only when the answer links to that exact fetched URL. */
export function selectCitedSources(markdown: string, sources: readonly WebSource[]): WebSource[] {
  const cited = citedUrls(markdown);
  return sanitizeSearchSources(sources).filter((source) => cited.has(source.url));
}
