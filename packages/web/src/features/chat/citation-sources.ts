import { stripTrackingSearchParams, type WebSource } from "@kulo/protocol";

export interface IndexedWebSource {
  id: string;
  index: number;
  url: string;
  domain: string;
  siteLabel: string;
  showIndex: boolean;
  title: string;
  snippet?: string;
}

const KNOWN_SITE_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/^(?:cj|finance)\.sina\.com\.cn$/, "新浪财经"],
  [/^(?:tech|news)\.sina\.com\.cn$/, "新浪科技"],
  [/(?:^|\.)sina\.com\.cn$/, "新浪"],
  [/(?:^|\.)sohu\.com$/, "搜狐"],
  [/(?:^|\.)ifeng\.com$/, "凤凰网"],
  [/(?:^|\.)163\.com$/, "网易"],
  [/(?:^|\.)qq\.com$/, "腾讯网"],
  [/(?:^|\.)zhihu\.com$/, "知乎"],
  [/(?:^|\.)ithome\.com$/, "IT之家"],
  [/(?:^|\.)36kr\.com$/, "36氪"],
  [/(?:^|\.)thepaper\.cn$/, "澎湃新闻"],
  [/(?:^|\.)cls\.cn$/, "财联社"],
  [/(?:^|\.)wallstreetcn\.com$/, "华尔街见闻"],
  [/(?:^|\.)eastmoney\.com$/, "东方财富"],
  [/(?:^|\.)caixin\.com$/, "财新"],
  [/(?:^|\.)huxiu\.com$/, "虎嗅"],
  [/(?:^|\.)sspai\.com$/, "少数派"],
  [/(?:^|\.)bilibili\.com$/, "哔哩哔哩"],
  [/(?:^|\.)weibo\.com$/, "微博"],
  [/(?:^|\.)baidu\.com$/, "百度"],
  [/(?:^|\.)jd\.com$/, "京东"],
  [/(?:^|\.)apple\.com$/, "Apple"],
  [/(?:^|\.)github\.com$/, "GitHub"],
  [/(?:^|\.)wikipedia\.org$/, "Wikipedia"],
  [/^developer\.mozilla\.org$/, "MDN"],
  [/(?:^|\.)reuters\.com$/, "Reuters"],
  [/(?:^|\.)bloomberg\.com$/, "Bloomberg"],
  [/(?:^|\.)techcrunch\.com$/, "TechCrunch"],
  [/(?:^|\.)theverge\.com$/, "The Verge"],
  [/(?:^|\.)macrumors\.com$/, "MacRumors"],
  [/(?:^|\.)9to5mac\.com$/, "9to5Mac"],
  [/(?:^|\.)openai\.com$/, "OpenAI"],
  [/(?:^|\.)anthropic\.com$/, "Anthropic"],
  [/(?:^|\.)google\.com$/, "Google"],
  [/(?:^|\.)heroui\.com$/, "HeroUI"],
];

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
  stripTrackingSearchParams(url);
  return url.toString();
}

export function extractSourceDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function formatSourceSiteLabel(domain: string): string {
  const clean = domain.toLowerCase().replace(/^www\./, "");
  for (const [pattern, label] of KNOWN_SITE_LABELS) {
    if (pattern.test(clean)) return label;
  }
  return clean;
}

export function indexMessageSources(sources: readonly WebSource[] | undefined): IndexedWebSource[] {
  if (!sources?.length) return [];
  const seen = new Set<string>();
  const raw: Array<Omit<IndexedWebSource, "showIndex">> = [];
  for (const source of sources.slice(0, 40)) {
    const url = safeSourceUrl(source.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const domain = extractSourceDomain(url);
    const siteLabel = formatSourceSiteLabel(domain);
    const title = typeof source.title === "string" ? source.title.trim().slice(0, 300) : "";
    const snippet = typeof source.snippet === "string"
      ? source.snippet.replace(/\s+/g, " ").trim().slice(0, 180) || undefined
      : undefined;
    raw.push({
      id: source.id,
      index: raw.length + 1,
      url,
      domain,
      siteLabel,
      title: title || domain,
      ...(snippet ? { snippet } : {}),
    });
  }
  const labelCounts = new Map<string, number>();
  for (const item of raw) {
    labelCounts.set(item.siteLabel, (labelCounts.get(item.siteLabel) ?? 0) + 1);
  }
  return raw.map((item) => ({
    ...item,
    showIndex: (labelCounts.get(item.siteLabel) ?? 0) > 1,
  }));
}

export function summarizeSourceSites(sources: readonly IndexedWebSource[]): string {
  const unique: string[] = [];
  for (const source of sources) {
    if (!unique.includes(source.siteLabel)) unique.push(source.siteLabel);
  }
  return unique.join(" · ");
}

function normalizeLabelCompare(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function shouldRenderCitationPill(input: {
  source: IndexedWebSource;
  linkText: string;
  citationKind?: string;
}): boolean {
  if (input.citationKind === "group" || input.citationKind === "trailing") return true;
  const trimmed = input.linkText.trim();
  if (!trimmed) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^\[?\d{1,3}\]?$/.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  if (lower === input.source.domain || lower === input.source.siteLabel.toLowerCase()) return true;
  const normText = normalizeLabelCompare(trimmed);
  const normTitle = normalizeLabelCompare(input.source.title);
  if (!normText || !normTitle) return false;
  if (normText === normTitle) return true;
  if (normText.length >= 6 && normTitle.includes(normText)) return true;
  if (normTitle.length >= 6 && normText.includes(normTitle)) return true;
  return false;
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  data?: { hProperties?: Record<string, unknown>; [key: string]: unknown };
}

const CITATION_SEPARATOR_RE = /^[\s、,，;；·/|]*$/;
const TRAILING_BEFORE_RE = /(?:\s|[、,，;；：:（(\[【—–-]|。|\.|\)|）)$/;
const TRAILING_AFTER_RE = /^[ \t]*(?:[。！？.!?;；,，、）)\]\n]|$)/;

function markCitationNode(node: MdastNode, kind: "group" | "trailing") {
  node.data = {
    ...node.data,
    hProperties: {
      ...(node.data?.hProperties ?? {}),
      "data-kulo-citation": kind,
    },
  };
}

function isSourceLink(node: MdastNode | undefined, sourceMap: ReadonlyMap<string, IndexedWebSource>): boolean {
  if (!node || node.type !== "link" || typeof node.url !== "string") return false;
  const normalized = safeSourceUrl(node.url);
  return Boolean(normalized && sourceMap.has(normalized));
}

function processCitationChildren(children: MdastNode[], sourceMap: ReadonlyMap<string, IndexedWebSource>) {
  for (let i = 0; i < children.length; i++) {
    const opener = children[i];
    if (!opener || opener.type !== "text" || typeof opener.value !== "string") continue;
    const openMatch = /([\n \t]*)([（(])[ \t]*$/.exec(opener.value);
    if (!openMatch) continue;
    const closeChar = openMatch[2] === "（" ? "）" : ")";

    let cursor = i + 1;
    const linkIndices: number[] = [];
    const sepIndices: number[] = [];
    let valid = true;
    while (cursor < children.length) {
      const current = children[cursor];
      if (!current) break;
      if (isSourceLink(current, sourceMap)) {
        linkIndices.push(cursor);
        cursor++;
        continue;
      }
      if (current.type === "text" && typeof current.value === "string") {
        if (linkIndices.length > 0 && current.value.trimStart().startsWith(closeChar)) {
          break;
        }
        if (linkIndices.length > 0 && CITATION_SEPARATOR_RE.test(current.value)) {
          sepIndices.push(cursor);
          cursor++;
          continue;
        }
      }
      valid = false;
      break;
    }

    const closer = valid && linkIndices.length > 0 ? children[cursor] : undefined;
    if (!closer || closer.type !== "text" || typeof closer.value !== "string") continue;
    const closeMatch = new RegExp(`^[ \\t]*\\${closeChar}`).exec(closer.value);
    if (!closeMatch) continue;

    // Strip wrapping parentheses cleanly; move sentence-ending punctuation before the citation pill
    // (ChatGPT/Perplexity editorial style) so narrow viewports never orphan `。` onto a blank line.
    const prefix = opener.value.slice(0, openMatch.index);
    const hadNewline = openMatch[1]?.includes("\n") ?? false;
    let remainingCloser = closer.value.slice(closeMatch[0].length);
    const trailingStop = /^[。！？.!?;；]/.exec(remainingCloser)?.[0];
    if (prefix && trailingStop && !/[。！？.!?;；]$/.test(prefix)) {
      opener.value = `${prefix}${trailingStop}`;
      remainingCloser = remainingCloser.slice(trailingStop.length);
    } else {
      opener.value = prefix ? (hadNewline ? `${prefix} ` : prefix) : "";
    }

    for (const sepIdx of sepIndices) {
      const sepNode = children[sepIdx];
      if (sepNode) sepNode.value = "";
    }
    for (const linkIdx of linkIndices) {
      const linkNode = children[linkIdx];
      if (linkNode) markCitationNode(linkNode, "group");
    }
    closer.value = remainingCloser;

    // Re-check closer on the next iteration in case it also opens a subsequent parenthesized citation group.
    i = cursor - 1;
  }

  // Drop empty text nodes produced by stripping parens/separators.
  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i];
    if (node?.type === "text" && !node.value) children.splice(i, 1);
  }

  // Mark unparenthesized trailing source links (e.g. `...结论 [新浪财经](url)。`).
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (!isSourceLink(node, sourceMap)) continue;
    if (node?.data?.hProperties?.["data-kulo-citation"]) continue;
    const prev = children[i - 1];
    const next = children[i + 1];
    const prevOk = !prev
      || isSourceLink(prev, sourceMap)
      || (prev.type === "text" && typeof prev.value === "string" && TRAILING_BEFORE_RE.test(prev.value));
    const nextOk = !next
      || isSourceLink(next, sourceMap)
      || (next.type === "text" && typeof next.value === "string" && TRAILING_AFTER_RE.test(next.value));
    if (prevOk && nextOk && node) markCitationNode(node, "trailing");
  }
}

export function remarkSourceCitations(sourceMap: ReadonlyMap<string, IndexedWebSource>) {
  return () => (tree: MdastNode) => {
    if (!sourceMap.size) return;
    const walk = (node: MdastNode) => {
      if (node.type === "code" || node.type === "inlineCode") return;
      if (Array.isArray(node.children)) {
        processCitationChildren(node.children, sourceMap);
        for (const child of node.children) walk(child);
      }
    };
    walk(tree);
  };
}
