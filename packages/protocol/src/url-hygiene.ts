const TRACKING_QUERY_PARAM_EXACT: ReadonlySet<string> = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "msockid", "yclid", "wickedid",
  "mc_cid", "mc_eid", "igshid", "trk", "_hsenc", "_hsmi", "mkt_tok",
  "oly_anon_id", "oly_enc_id", "vero_id", "ref_src", "spm",
]);

export function isTrackingQueryParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_QUERY_PARAM_EXACT.has(lower);
}

/** Strips analytics/referral tracking params (`utm_*`, `fbclid`, `msockid`, etc.) in place. */
export function stripTrackingSearchParams(url: URL): boolean {
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingQueryParam(key)) { url.searchParams.delete(key); changed = true; }
  }
  return changed;
}

export function stripTrackingParamsFromUrl(rawUrl: string): string {
  if (!rawUrl || (!rawUrl.includes("?") && !rawUrl.includes("&"))) return rawUrl;
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return rawUrl; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return rawUrl;
  return stripTrackingSearchParams(parsed) ? parsed.toString() : rawUrl;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

function findClosingBracket(value: string, openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < value.length; i++) {
    if (value[i] === "\n" && value[i + 1] === "\n") return -1;
    if (isEscaped(value, i)) continue;
    if (value[i] === "[") depth++;
    else if (value[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

interface ParsedDest { url: string; angleBracketed: boolean; suffix: string; closeParenIndex: number }

function parseMarkdownDestination(value: string, start: number): ParsedDest | undefined {
  let i = start;
  while (i < value.length && /[ \t]/.test(value[i]!)) i++;
  let url = "";
  let angleBracketed = false;
  if (value[i] === "<") {
    const closeAngle = value.indexOf(">", i + 1);
    if (closeAngle < 0 || value.slice(i + 1, closeAngle).includes("\n")) return undefined;
    url = value.slice(i + 1, closeAngle); angleBracketed = true; i = closeAngle + 1;
  } else {
    let depth = 0;
    for (; i < value.length; i++) {
      const ch = value[i]!;
      if (ch === "\\" && i + 1 < value.length && /[\\()]/.test(value[i + 1]!)) { url += ch + value[++i]!; continue; }
      if (ch === "(") { if (++depth > 16) return undefined; url += ch; continue; }
      if (ch === ")") { if (depth === 0) break; depth--; url += ch; continue; }
      if (/\s/.test(ch)) break;
      url += ch;
    }
    if (depth !== 0) return undefined;
  }
  const suffixStart = i;
  while (i < value.length && /[ \t]/.test(value[i]!)) i++;
  if (value[i] === '"' || value[i] === "'") {
    const quote = value[i++]!;
    while (i < value.length && (value[i] !== quote || isEscaped(value, i))) { if (value[i++] === "\n") return undefined; }
    if (value[i++] !== quote) return undefined;
    while (i < value.length && /[ \t]/.test(value[i]!)) i++;
  }
  return value[i] === ")" ? { url, angleBracketed, suffix: value.slice(suffixStart, i), closeParenIndex: i } : undefined;
}

function cleanBareHttpUrlToken(token: string): string {
  let end = token.length;
  while (end > 0 && /[.,;:!?]/.test(token[end - 1]!)) end--;
  while (end > 0 && token[end - 1] === ")") {
    const candidate = token.slice(0, end - 1);
    if ((candidate.match(/\)/g) ?? []).length < (candidate.match(/\(/g) ?? []).length) break;
    end--;
  }
  return `${stripTrackingParamsFromUrl(token.slice(0, end))}${token.slice(end)}`;
}

function readCitationSpan(text: string, pos: number): { end: number; canonicalUrl: string } | undefined {
  const wrapped = text[pos] === "(" && text[pos + 1] === "[";
  const bracketStart = wrapped ? pos + 1 : text[pos] === "[" ? pos : -1;
  if (bracketStart < 0 || (bracketStart > 0 && text[bracketStart - 1] === "!" && !isEscaped(text, bracketStart - 1))) return undefined;
  const closeBracket = findClosingBracket(text, bracketStart);
  if (closeBracket < 0 || text[closeBracket + 1] !== "(") return undefined;
  const dest = parseMarkdownDestination(text, closeBracket + 2);
  if (!dest) return undefined;
  const end = wrapped ? (text[dest.closeParenIndex + 1] === ")" ? dest.closeParenIndex + 2 : -1) : dest.closeParenIndex + 1;
  if (end < 0) return undefined;
  const rawDest = dest.url.replace(/\\([\\()])/g, "$1");
  return /^https?:\/\//i.test(rawDest) ? { end, canonicalUrl: stripTrackingParamsFromUrl(rawDest) } : undefined;
}

function sanitizeProseSegment(prose: string): string {
  if (!/https?:\/\//i.test(prose)) return prose;
  let out = "";
  let i = 0;
  while (i < prose.length) {
    if (prose[i] === "<" && !isEscaped(prose, i)) {
      const auto = /^<(https?:\/\/[^<>\s]+)>/i.exec(prose.slice(i));
      if (auto) { out += `<${stripTrackingParamsFromUrl(auto[1]!)}>`; i += auto[0].length; continue; }
    }
    if (prose[i] === "[" && !isEscaped(prose, i)) {
      const closeBracket = findClosingBracket(prose, i);
      if (closeBracket >= 0 && prose[closeBracket + 1] === "(") {
        const dest = parseMarkdownDestination(prose, closeBracket + 2);
        if (!dest) {
          if (!prose.slice(closeBracket + 2).includes("\n")) { out += prose.slice(i); break; }
        } else {
          const rawLabel = prose.slice(i + 1, closeBracket);
          const cleanLabel = /^https?:\/\//i.test(rawLabel.trim()) ? stripTrackingParamsFromUrl(rawLabel.trim()) : rawLabel;
          const cleanedUrl = stripTrackingParamsFromUrl(dest.url.replace(/\\([\\()])/g, "$1"));
          out += `[${cleanLabel}](${dest.angleBracketed ? `<${cleanedUrl}>` : cleanedUrl}${dest.suffix})`;
          i = dest.closeParenIndex + 1;
          continue;
        }
      }
    }
    const bareMatch = /^https?:\/\/[^\s<>[\]"'`]+/i.exec(prose.slice(i));
    if (bareMatch && (i === 0 || !/[A-Za-z0-9]/.test(prose[i - 1]!))) {
      out += cleanBareHttpUrlToken(bareMatch[0]);
      i += bareMatch[0].length;
      continue;
    }
    out += prose[i++]!;
  }
  let folded = "";
  for (let pos = 0; pos < out.length;) {
    const first = readCitationSpan(out, pos);
    if (!first) { folded += out[pos++]!; continue; }
    folded += out.slice(pos, first.end);
    let cursor = first.end;
    for (;;) {
      let ws = cursor;
      while (ws < out.length && (out[ws] === " " || out[ws] === "\t")) ws++;
      const next = readCitationSpan(out, ws);
      if (!next || next.canonicalUrl !== first.canonicalUrl) break;
      cursor = next.end;
    }
    pos = cursor;
  }
  return folded;
}

export function sanitizeMarkdownTrackingLinks(markdown: string): string {
  if (!markdown || !/https?:\/\//i.test(markdown)) return markdown;
  let result = "";
  for (let pos = 0; pos < markdown.length;) {
    if (pos === 0 || markdown[pos - 1] === "\n") {
      const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/.exec(markdown.slice(pos));
      if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
        const scan = pos + fence[0].length;
        const closeHit = new RegExp(`^ {0,3}${fence[1]![0]!}{${fence[1]!.length},}[ \\t]*(?:\\n|$)`, "m").exec(markdown.slice(scan));
        const blockEnd = closeHit ? scan + closeHit.index + closeHit[0].length : markdown.length;
        result += markdown.slice(pos, blockEnd);
        pos = blockEnd;
        continue;
      }
    }
    const nextBacktick = markdown.indexOf("`", pos);
    if (nextBacktick === pos) {
      let tickEnd = pos;
      while (tickEnd < markdown.length && markdown[tickEnd] === "`") tickEnd++;
      const tickRun = markdown.slice(pos, tickEnd);
      let matchedClose = -1;
      for (let s = tickEnd; s < markdown.length;) {
        const c = markdown.indexOf(tickRun, s);
        if (c < 0) break;
        if (markdown[c - 1] !== "`" && markdown[c + tickRun.length] !== "`") { matchedClose = c + tickRun.length; break; }
        s = c + 1;
      }
      if (matchedClose >= 0) { result += markdown.slice(pos, matchedClose); pos = matchedClose; continue; }
      result += tickRun;
      pos = tickEnd;
      continue;
    }
    const nextNewline = markdown.indexOf("\n", pos);
    let boundary = markdown.length;
    if (nextBacktick >= 0 && nextBacktick < boundary) boundary = nextBacktick;
    if (nextNewline >= 0 && nextNewline + 1 < boundary) boundary = nextNewline + 1;
    result += sanitizeProseSegment(markdown.slice(pos, boundary));
    pos = boundary;
  }
  return result;
}
