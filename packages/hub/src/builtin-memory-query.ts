/**
 * Pure tokenization, identifier extraction, safe FTS5 query construction,
 * vector math, and RRF + content-hash folding helpers for BuiltinMemoryStore.
 * Zero I/O, zero Harness dependencies.
 */
import { createHash } from "node:crypto";
import type {
  BuiltinMemoryCategory,
  BuiltinMemoryDurability,
  BuiltinMemoryEvidenceLevel,
  BuiltinMemoryScopeKind,
  MemoryBank,
} from "@kulo/protocol";

const DAY_MS = 86_400_000;

export interface BuiltinMemoryRecallHit {
  id: string;
  mergedIds: string[];
  sourceCount: number;
  bank: MemoryBank;
  scopeKind: BuiltinMemoryScopeKind;
  projectId?: string;
  topicId?: string;
  category: BuiltinMemoryCategory;
  durability: BuiltinMemoryDurability;
  evidenceLevel: BuiltinMemoryEvidenceLevel;
  content: string;
  score: number;
  exactHit: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ScorableMemoryRow {
  id: string;
  bank: MemoryBank;
  scope_kind: BuiltinMemoryScopeKind;
  project_id: string | null;
  topic_id: string | null;
  category: BuiltinMemoryCategory;
  durability: BuiltinMemoryDurability;
  evidence_level: BuiltinMemoryEvidenceLevel;
  importance: number;
  content: string;
  content_hash: string;
  embedding: Uint8Array | null;
  created_at: number;
  updated_at: number;
}

export function normalizeMemoryText(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function computeMemoryContentHash(content: string): string {
  return createHash("sha256").update(normalizeMemoryText(content).toLocaleLowerCase("en-US")).digest("hex");
}

/**
 * Produces NFKC-folded CJK 2-grams + ASCII word tokens safe for SQLite FTS5 `unicode61`.
 * Keeps 2-character Chinese terms searchable (unlike FTS5 trigram) while avoiding punctuation traps.
 */
export function tokenizeForMemoryFts(raw: string, maxTokens = 160): string[] {
  const folded = raw.normalize("NFKC").toLocaleLowerCase("en-US");
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (token: string) => {
    const clean = token.replace(/["*:^()[\]{}]/g, "").trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };

  for (const match of folded.matchAll(/[a-z0-9_]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    if (out.length >= maxTokens) break;
    const segment = match[0];
    if (/^[a-z0-9_]+$/.test(segment)) {
      push(segment);
      if (segment.includes("_")) {
        for (const part of segment.split("_")) {
          if (part.length >= 2 && out.length < maxTokens) push(part);
        }
      }
      continue;
    }
    const chars = [...segment];
    if (chars.length === 1) {
      push(chars[0]!);
    } else {
      for (let i = 0; i < chars.length - 1 && out.length < maxTokens; i++) {
        push(chars[i]! + chars[i + 1]!);
      }
    }
  }
  return out;
}

/**
 * Extracts normalized technical identifiers (paths, dotted names, host:port, C++/C#, ticket IDs, 3-5 digit ports)
 * preserving punctuation boundaries that FTS5 `unicode61` collapses.
 */
export function extractMemoryIdentifiers(raw: string, maxItems = 48): string[] {
  const folded = raw.normalize("NFKC").toLocaleLowerCase("en-US");
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string) => {
    const clean = value.replace(/^[,.;:!?()[\]{}<>"'`]+|[,.;:!?()[\]{}<>"'`]+$/g, "");
    if (clean.length < 2 || clean.length > 160 || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  const re = /(?:[a-z0-9_.-]+\/[a-z0-9_./-]+|[a-z0-9_]+(?:[.:-][a-z0-9_]+)+|[a-z]+(?:\+\+|#)|\b\d{3,5}\b)/gi;
  for (const match of folded.matchAll(re)) {
    if (out.length >= maxItems) break;
    push(match[0]);
  }
  return out;
}

/** Builds a safe quoted FTS5 MATCH query or returns `null` when no searchable tokens remain. */
export function buildSafeFtsMatchQuery(query: string): string | null {
  const tokens = tokenizeForMemoryFts(query, 24)
    .map((token) => token.replace(/"/g, "").trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(" OR ");
}

export function l2Normalize(vec: Float32Array): Float32Array | null {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  if (!Number.isFinite(sum) || sum <= 1e-12) return null;
  const inv = 1 / Math.sqrt(sum);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! * inv;
  return out;
}

export function float32ToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToFloat32(blob: Uint8Array): Float32Array | null {
  if (blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Pure chitchat / acknowledgement filter for automatic recall (allows short substantive Chinese queries like "端口多少"). */
const PURE_CHITCHAT_RE =
  /^(?:好|好的|好呀|好哒|行|行吧|可以|收到|明白|知道了|懂了|嗯|嗯嗯|哦|喔|继续|继续吧|开始吧|谢谢|感谢|多谢|辛苦了|没事|没问题|ok|okay|yes|yeah|yep|no|nope|sure|thanks|thank you|thx|got it|continue|go ahead|done|nice|great|cool)[.!?,。！？，、~～\s]*$/i;

export function isChitchatRecallQuery(raw: string): boolean {
  const clean = normalizeMemoryText(raw);
  if (!clean) return true;
  if (PURE_CHITCHAT_RE.test(clean)) return true;
  const hasLettersOrCjk = /[a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/iu.test(clean);
  if (!hasLettersOrCjk) return true;
  return [...clean].length < 2;
}

export function rankAndFoldAuthorizedCandidates(input: {
  rows: Iterable<ScorableMemoryRow>;
  ftsRankMap: ReadonlyMap<string, number>;
  vecRankMap: ReadonlyMap<string, number>;
  exactHitIds: ReadonlySet<string>;
  effectiveProjectById: ReadonlyMap<string, string | undefined>;
  callerRole: "router" | "worker";
  bank: MemoryBank;
  projectId?: string;
  topicId?: string;
  limit: number;
  now: number;
}): BuiltinMemoryRecallHit[] {
  const scored: Array<{
    row: ScorableMemoryRow;
    score: number;
    exactHit: boolean;
    isFreshUnembeddedTopFts: boolean;
    effectiveProjectId?: string;
  }> = [];

  for (const row of input.rows) {
    const vecRank = input.vecRankMap.get(row.id);
    const ftsRank = input.ftsRankMap.get(row.id);
    const exactHit = input.exactHitIds.has(row.id);
    const rrf = (vecRank ? 0.55 / (60 + vecRank) : 0) + (ftsRank ? 0.45 / (60 + ftsRank) : 0);
    const exactBonus = exactHit ? 0.012 : 0;
    const effectiveProjectId = input.effectiveProjectById.get(row.id);
    let scopeBoost = 1.0;
    if (input.topicId && row.topic_id === input.topicId) {
      scopeBoost = 1.2;
    } else if (input.projectId && effectiveProjectId === input.projectId) {
      scopeBoost = 1.15;
    } else if (row.scope_kind === "global") {
      scopeBoost = 1.0;
    } else if (input.bank === "private" && input.callerRole === "router") {
      scopeBoost = 0.75;
    }
    const ageDays = Math.max(0, (input.now - row.updated_at) / DAY_MS);
    const freshness = row.durability === "permanent" ? 1.0 : Math.max(0.55, Math.exp(-ageDays / 45));
    const score = (rrf + exactBonus) * scopeBoost * freshness * (0.8 + 0.2 * row.importance);
    scored.push({
      row,
      score,
      exactHit,
      isFreshUnembeddedTopFts: row.embedding === null && ftsRank === 1,
      effectiveProjectId,
    });
  }
  scored.sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at);

  const foldedByHash = new Map<string, BuiltinMemoryRecallHit & { _guaranteed: boolean }>();
  const ordered: Array<BuiltinMemoryRecallHit & { _guaranteed: boolean }> = [];
  for (const item of scored) {
    const existing = foldedByHash.get(item.row.content_hash);
    if (existing) {
      existing.mergedIds.push(item.row.id);
      existing.sourceCount += 1;
      if (item.exactHit) existing.exactHit = true;
      if (item.exactHit || item.isFreshUnembeddedTopFts) existing._guaranteed = true;
      continue;
    }
    const hit: BuiltinMemoryRecallHit & { _guaranteed: boolean } = {
      id: item.row.id,
      mergedIds: [item.row.id],
      sourceCount: 1,
      bank: item.row.bank,
      scopeKind: item.row.scope_kind,
      ...(item.effectiveProjectId ? { projectId: item.effectiveProjectId } : {}),
      ...(item.row.topic_id ? { topicId: item.row.topic_id } : {}),
      category: item.row.category,
      durability: item.row.durability,
      evidenceLevel: item.row.evidence_level,
      content: item.row.content,
      score: item.score,
      exactHit: item.exactHit,
      createdAt: item.row.created_at,
      updatedAt: item.row.updated_at,
      _guaranteed: item.exactHit || item.isFreshUnembeddedTopFts,
    };
    foldedByHash.set(item.row.content_hash, hit);
    ordered.push(hit);
  }

  let selected = ordered.slice(0, input.limit);
  if (input.limit >= 1 && !selected.some((h) => h._guaranteed)) {
    const guaranteed = ordered.slice(input.limit).find((h) => h._guaranteed);
    if (guaranteed) {
      selected = [...selected.slice(0, input.limit - 1), guaranteed];
    }
  }
  return selected.map(({ _guaranteed: _, ...rest }) => rest);
}
