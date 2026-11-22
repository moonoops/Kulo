import type { HindsightMemoryConfig } from "@kulo/protocol";
import { executeHindsightTool, isSafeMemoryText, type MemoryCallerContext } from "./hindsight.js";

export interface ForgottenTermEntry {
  term: string;
  normalized: string;
  reason?: string;
  addedAt: number;
}

export const MAX_FORGOTTEN_TERMS = 64;
const MAX_FORGET_TERM_LENGTH = 120;
const MIN_FORGET_TERM_LENGTH = 2;
const MAX_INVALIDATE_PER_FORGET = 20;

const ASCII_WORD_TERM_RE = /^[a-z0-9][a-z0-9 _.-]*[a-z0-9]$|^[a-z0-9]{2,}$/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeForgetTerm(raw: string): { term: string; normalized: string } {
  const term = String(raw ?? "").replace(/\s+/g, " ").trim();
  if ([...term].length < MIN_FORGET_TERM_LENGTH || [...term].length > MAX_FORGET_TERM_LENGTH || /[\x00-\x1f\x7f]/.test(term)) {
    throw new Error(`遗忘词条长度须在 ${MIN_FORGET_TERM_LENGTH} 到 ${MAX_FORGET_TERM_LENGTH} 个字符之间。`);
  }
  return { term, normalized: term.toLowerCase() };
}

/**
 * Matches a forgotten term against candidate memory/markdown text.
 * Pure ASCII terms use alphanumeric boundary matching so forgetting `cat`
 * never hits `category`; CJK or mixed-script terms use case-insensitive substring matching.
 */
export function matchesForgottenTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  const cleanTerm = term.replace(/\s+/g, " ").trim();
  if (!cleanTerm) return false;
  if (ASCII_WORD_TERM_RE.test(cleanTerm)) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegex(cleanTerm)}(?![a-z0-9])`, "i");
    return re.test(text);
  }
  return text.toLowerCase().includes(cleanTerm.toLowerCase());
}

export function findMatchingForgottenTerm(
  text: string,
  terms: readonly ForgottenTermEntry[],
): ForgottenTermEntry | undefined {
  for (const entry of terms) {
    if (matchesForgottenTerm(text, entry.term)) return entry;
  }
  return undefined;
}

export function stripForgottenLinesFromMarkdown(
  markdown: string,
  term: string,
): { content: string; removedLines: number } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let removedLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && matchesForgottenTerm(line, term)) {
      removedLines += 1;
      continue;
    }
    kept.push(line);
  }
  const content = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + (markdown.endsWith("\n") ? "\n" : "");
  return { content, removedLines };
}

export function stripAllForgottenTermsFromMarkdown(
  markdown: string,
  terms: readonly ForgottenTermEntry[],
): { content: string; removedLines: number } {
  let content = markdown;
  let removedLines = 0;
  for (const entry of terms) {
    const res = stripForgottenLinesFromMarkdown(content, entry.term);
    content = res.content;
    removedLines += res.removedLines;
  }
  return { content, removedLines };
}

function substantiveLines(markdown: string): string[] {
  return markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter((line) => line.length >= 4 && !line.startsWith("#") && !/^[-*_]{3,}$/.test(line));
}

function lineSurvives(oldLine: string, newLines: readonly string[], fullNextLower: string): boolean {
  const normOld = oldLine.toLowerCase().replace(/\s+/g, " ");
  if (fullNextLower.includes(normOld)) return true;
  // Also tolerate mild rewrites where at least half of meaningful 2+ char chunks remain
  const tokens = normOld.match(/[\p{Script=Han}]{2,}|[a-z0-9_-]{3,}/gu) ?? [];
  if (tokens.length === 0) return false;
  let best = 0;
  for (const candidate of newLines) {
    const lower = candidate.toLowerCase();
    let hits = 0;
    for (const token of tokens) {
      if (lower.includes(token)) hits += 1;
    }
    if (hits > best) best = hits;
  }
  return best / tokens.length >= 0.6;
}

/**
 * Relaxed anti-wipe guard for background `relationship.md` consolidation:
 * triggers ONLY when the existing document has >= 8 substantive lines,
 * > 50% of old lines are absent, AND total length shrank below 60%.
 */
export function checkRelationshipAntiWipe(
  previous: string,
  next: string,
): { blocked: boolean; reason?: string } {
  const oldLines = substantiveLines(previous);
  if (oldLines.length < 8) return { blocked: false };
  const trimmedPrev = previous.trim();
  const trimmedNext = next.trim();
  if (trimmedNext.length >= trimmedPrev.length * 0.6) return { blocked: false };
  const newLines = substantiveLines(next);
  const fullNextLower = trimmedNext.toLowerCase().replace(/\s+/g, " ");
  let missing = 0;
  for (const line of oldLines) {
    if (!lineSurvives(line, newLines, fullNextLower)) missing += 1;
  }
  if (missing / oldLines.length > 0.5) {
    return { blocked: true, reason: "检测到协作关系大幅删减，已自动保留原文档" };
  }
  return { blocked: false };
}

export interface RelationshipReviewDecision {
  content: string | null;
  summary?: string;
  defer?: boolean;
  skipReason?: string;
}

export function validateRelationshipReviewDecision(
  rawText: string,
  currentContent: string,
  forgottenTerms: readonly ForgottenTermEntry[],
): RelationshipReviewDecision {
  const json = rawText.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const decision: unknown = JSON.parse(json);
  if (
    !decision ||
    typeof decision !== "object" ||
    !("content" in decision) ||
    (decision.content !== null && typeof decision.content !== "string")
  ) {
    throw new Error("主模型返回的协作关系格式无效。");
  }
  if ("defer" in decision && (typeof decision.defer !== "boolean" || (decision.defer && decision.content !== null))) {
    throw new Error("主模型返回的协作关系推迟决定无效。");
  }
  const summary = "summary" in decision && typeof decision.summary === "string" ? decision.summary.slice(0, 500) : "整理协作关系";
  if ("defer" in decision && decision.defer === true) {
    return { content: null, summary, defer: true };
  }
  if (decision.content === null) {
    return { content: null, summary };
  }
  if (!isSafeMemoryText(decision.content)) {
    throw new Error("协作关系结果包含不适合保存的敏感内容。");
  }
  const stripped = forgottenTerms.length
    ? stripAllForgottenTermsFromMarkdown(decision.content, forgottenTerms).content
    : decision.content;
  const antiWipe = checkRelationshipAntiWipe(currentContent, stripped);
  if (antiWipe.blocked) {
    // Advance cursor cleanly via skipped instead of returning defer: true (prevents 15m infinite retry loop)
    return { content: null, summary, skipReason: antiWipe.reason };
  }
  return { content: stripped, summary };
}

export interface MemoryForgetHost {
  addForgottenTerm: (term: string, reason?: string) => Promise<{ added: boolean; entry: ForgottenTermEntry; total: number }>;
  forgetFromRelationship: (term: string, reason?: string) => Promise<{ removedLines: number }>;
  forgetFromWorkingMemory?: (term: string, reason?: string) => Promise<{ removedRecords: number }>;
  getMemoryConfig: () => HindsightMemoryConfig;
}

export interface MemoryForgetOutcome {
  term: string;
  tombstoneAdded: boolean;
  totalForgottenTerms: number;
  relationshipRemovedLines: number;
  workingMemoryRemovedRecords?: number;
  privateMemoriesScanned: number;
  privateMemoriesInvalidated: number;
  hindsightSkipped?: string;
}

/**
 * Router-only personal memory forget orchestration:
 * 1) Persists tombstone in `PersonalityDoc.forgottenTerms` (without bumping settings revision).
 * 2) Removes matching lines from `relationship.md` (via `saveRelationship` so cluster-sync marks files dirty).
 * 3) Recalls Hindsight `private` bank (`kulo-core` ONLY — never touches `kulo-shared`), verifies
 *    exact local term match on each recalled result text, and invalidates matched private memories.
 */
export async function executeMemoryForget(options: {
  term: string;
  reason?: string;
  host: MemoryForgetHost;
  caller: MemoryCallerContext;
  signal?: AbortSignal;
}): Promise<MemoryForgetOutcome> {
  if (options.caller.role !== "router") {
    throw new Error("只有主智能体可以执行个人记忆遗忘操作。");
  }
  const { term } = normalizeForgetTerm(options.term);
  const cleanReason = options.reason?.trim().slice(0, 200) || undefined;
  const tombstone = await options.host.addForgottenTerm(term, cleanReason);
  const rel = await options.host.forgetFromRelationship(term, cleanReason);
  const wm = options.host.forgetFromWorkingMemory
    ? await options.host.forgetFromWorkingMemory(term, cleanReason)
    : undefined;

  const memoryConfig = options.host.getMemoryConfig();
  if (!memoryConfig.enabled) {
    return {
      term: tombstone.entry.term,
      tombstoneAdded: tombstone.added,
      totalForgottenTerms: tombstone.total,
      relationshipRemovedLines: rel.removedLines,
      ...(wm ? { workingMemoryRemovedRecords: wm.removedRecords } : {}),
      privateMemoriesScanned: 0,
      privateMemoriesInvalidated: 0,
      hindsightSkipped: "memory_disabled",
    };
  }

  let scanned = 0;
  let invalidated = 0;
  let hindsightSkipped: string | undefined;
  try {
    const recall = await executeHindsightTool({
      toolName: "hindsight_recall",
      bank: "private",
      args: { query: term, budget: "high", max_tokens: 4000 },
      config: memoryConfig,
      caller: options.caller,
      signal: options.signal,
    });
    if (recall.isError) {
      hindsightSkipped = recall.text.slice(0, 200);
    } else {
      const parsed = JSON.parse(recall.text) as { results?: Array<{ id?: unknown; text?: unknown }> };
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      scanned = results.length;
      const seenIds = new Set<string>();
      for (const item of results) {
        if (invalidated >= MAX_INVALIDATE_PER_FORGET) break;
        const id = typeof item.id === "string" ? item.id.trim() : "";
        const text = typeof item.text === "string" ? item.text : "";
        if (!id || seenIds.has(id)) continue;
        // Strict local secondary match prevents semantic top-K false invalidation
        if (!matchesForgottenTerm(text, term)) continue;
        seenIds.add(id);
        const inv = await executeHindsightTool({
          toolName: "hindsight_invalidate_memory",
          bank: "private",
          args: { memory_id: id, reason: cleanReason ?? `用户要求遗忘「${term}」` },
          config: memoryConfig,
          caller: options.caller,
          signal: options.signal,
        });
        if (!inv.isError) invalidated += 1;
      }
    }
  } catch (error) {
    hindsightSkipped = error instanceof Error ? error.message.slice(0, 200) : "hindsight_unavailable";
  }

  return {
    term: tombstone.entry.term,
    tombstoneAdded: tombstone.added,
    totalForgottenTerms: tombstone.total,
    relationshipRemovedLines: rel.removedLines,
    ...(wm ? { workingMemoryRemovedRecords: wm.removedRecords } : {}),
    privateMemoriesScanned: scanned,
    privateMemoriesInvalidated: invalidated,
    ...(hindsightSkipped ? { hindsightSkipped } : {}),
  };
}
