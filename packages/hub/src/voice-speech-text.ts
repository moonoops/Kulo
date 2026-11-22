/**
 * Pure server-side Markdown-to-spoken-text sanitizer for chat message TTS playback.
 * Used exclusively for `POST /api/voice/synthesize` (`cleanMarkdown: true`);
 * never alters `kulo_synthesize_speech` verbatim scripts.
 */

export const MAX_VOICE_TTS_RAW_TEXT = 64_000;

const KULO_CARD_BLOCK_RE = /```[ \t]*kulo-card[^\n]*\n[\s\S]*?(?:```|$)/gi;
const KULO_DIAGRAM_BLOCK_RE = /```[ \t]*(?:kulo-diagram|mermaid)[^\n]*\n[\s\S]*?(?:```|$)/gi;
const GENERIC_FENCED_BLOCK_RE = /```[^\n]*\n[\s\S]*?(?:```|$)/g;
const BLOCK_MATH_DOLLAR_RE = /\$\$[\s\S]*?\$\$/g;
const BLOCK_MATH_BRACKET_RE = /\\\[[\s\S]*?\\\]/g;
// Inline LaTeX `$...$` — avoids currency such as `$10 到 $50` or `$99.99`
const INLINE_MATH_DOLLAR_RE = /(?<!\\|\w)\$(?!\s|\d)([^\n$]{1,200}?)(?<!\s)\$(?!\d|\w)/g;
const INLINE_MATH_PAREN_RE = /\\\(([^\n]{1,200}?)\\\)/g;

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\([^)\n]*\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g;
const BARE_URL_RE = /<?https?:\/\/[^\s<>)\]]+>?/gi;

// File paths only: requires either a known root prefix or a multi-segment path ending in a file extension.
// Never matches calendar dates (`2026/11/22`) or unit ratios (`km/h`, `1/2/3`).
const EXT_FILE_PATH_RE = /(?<![\w:/])(?:[\w.-]+\/){2,}([\w.-]+\.[a-zA-Z][a-zA-Z0-9]{0,7})\b/g;
const PREFIXED_PATH_RE = /(?<![\w:/])(?:\.\.?\/|\/(?:Users|home|var|etc|opt|tmp|Volumes|Applications|Library|System)\/|(?:packages|src|apps|tests|docs|integrations)\/)(?:[\w.@+-]+\/)*([\w.-]+)\b/g;

function cleanLatexFragment(raw: string): string {
  return raw
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, "")
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "$1 除以 $2")
    .replace(/\\times\b/g, " 乘 ")
    .replace(/\\cdot\b/g, " 乘 ")
    .replace(/\\pm\b/g, " 正负 ")
    .replace(/\\approx\b/g, " 约等于 ")
    .replace(/\\leq?\b/g, " 小于等于 ")
    .replace(/\\geq?\b/g, " 大于等于 ")
    .replace(/\\neq\b/g, " 不等于 ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}^_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMarkdownTables(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/.test(trimmed)) {
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 3) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length > 0) {
        out.push(`${cells.join("，")}。`);
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function truncateAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh", { granularity: "sentence" });
    let acc = "";
    for (const seg of segmenter.segment(text)) {
      if (acc.length + seg.segment.length > maxChars) break;
      acc += seg.segment;
    }
    if (acc.trim().length > 0) return acc.trim();
  }
  return text.slice(0, maxChars).trim();
}

/**
 * Transforms Markdown / structured Kulo assistant output into natural spoken text
 * suitable for TTS synthesis, truncated cleanly on sentence boundaries to `maxChars`.
 * Returns `""` when no speakable letters or digits remain.
 */
export function prepareSpeechText(raw: string, maxChars = 8_000): string {
  if (!raw || typeof raw !== "string") return "";
  let text = raw.replace(/\r\n?/g, "\n");

  // 1. Replace Kulo structured blocks & generic fenced code blocks before stripping inline syntax
  text = text.replace(KULO_CARD_BLOCK_RE, "\n这里有一张交互卡片。\n");
  text = text.replace(KULO_DIAGRAM_BLOCK_RE, "\n这里有一张图表。\n");
  text = text.replace(GENERIC_FENCED_BLOCK_RE, "\n此处省略一段代码。\n");

  // 2. Replace block math & safe inline LaTeX (preserving currency like `$10 到 $50`)
  text = text.replace(BLOCK_MATH_DOLLAR_RE, "\n此处省略一段公式。\n");
  text = text.replace(BLOCK_MATH_BRACKET_RE, "\n此处省略一段公式。\n");
  text = text.replace(INLINE_MATH_DOLLAR_RE, (_m, inner: string) => cleanLatexFragment(inner));
  text = text.replace(INLINE_MATH_PAREN_RE, (_m, inner: string) => cleanLatexFragment(inner));

  // 3. Strip raw HTML scripts/styles and inline tags while keeping inner prose
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?(?:p|div|li|tr|h[1-6]|section|article|details|summary)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");

  // 4. Convert Markdown tables before stripping formatting symbols
  text = cleanMarkdownTables(text);

  // 5. Convert images, links, and bare URLs
  text = text.replace(MARKDOWN_IMAGE_RE, (_m, alt: string) => (alt.trim() ? alt.trim() : ""));
  text = text.replace(MARKDOWN_LINK_RE, (_m, label: string) => label.trim());
  text = text.replace(BARE_URL_RE, "链接");

  // 6. Strip block-level Markdown markers line by line
  const cleanedLines: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^(?:[-*_]\s*){3,}$/.test(line)) continue;
    // Headings
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      line = heading[1]!.trim();
      if (line && !/[。！？.!?：:；;]$/.test(line)) line += "。";
    }
    // Blockquotes & list bullets / task checkboxes
    line = line.replace(/^(?:>\s*)+/, "");
    line = line.replace(/^[-*+]\s+\[[ xX]\]\s+/, "");
    line = line.replace(/^[-*+]\s+/, "");
    line = line.replace(/^\d+[.)]\s+/, "");
    if (line.trim()) cleanedLines.push(line.trim());
  }
  text = cleanedLines.join("\n");

  // 7. Strip inline Markdown formatting (bold, italic, strikethrough, inline code)
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  text = text.replace(/__([^_\n]+)__/g, "$1");
  text = text.replace(/~~([^~\n]+)~~/g, "$1");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  text = text.replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "$1");

  // 8. Shorten long file paths without altering dates (`2026/11/22`) or ratios (`km/h`)
  text = text.replace(PREFIXED_PATH_RE, "$1");
  text = text.replace(EXT_FILE_PATH_RE, "$1");

  // 9. Clean decorative separator runs & normalize whitespace into natural speech pauses
  text = text.replace(/[=*~_-]{4,}/g, " ");
  text = text.replace(/\n+/g, (match, offset: number, full: string) => {
    const prev = full[offset - 1] ?? "";
    if (!prev || /[。！？.!?,，；;：:\s]/.test(prev)) return " ";
    return "。";
  });
  text = text.replace(/([。！？.!?])\s*[。！？.!?]+/g, "$1");
  text = text.replace(/[ \t]{2,}/g, " ").trim();

  // 10. Reject content that has no speakable letters or digits
  if (!/[\p{L}\p{N}]/u.test(text)) return "";

  return truncateAtSentenceBoundary(text, maxChars);
}
