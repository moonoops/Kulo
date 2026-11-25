import crypto from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import {
  GenerationTask,
  ToolTask,
  defineExtension,
  hook,
  type ConversationId,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { redactSensitiveText } from "@kulo/protocol";
import { DEFAULT_CONTEXT_WINDOW } from "./config.js";
import type { ResolvedConversationModelContext } from "./orchestrator-prompt-wiring.js";
import { KuloStateDoc, isOrchestratorConversation } from "./state.js";
import { SettingsAssistantDoc, isActiveSettingsConversation } from "./settings-doc.js";
import { resolveDeferredAddTools } from "./tool-surface.js";
import type { KuloUploadStore } from "./uploads.js";

export const ORCHESTRATOR_TOOL_OVERFLOW_ALLOWLIST = new Set<string>(["read", "bash", "web_fetch"]);
/** Legacy small-window default & decoupled independent redaction threshold. */
export const ORCHESTRATOR_TOOL_OVERFLOW_THRESHOLD_CHARS = 8_000;
export const ORCHESTRATOR_TOOL_REDACTION_CHECK_CHARS = 8_000;
export const ORCHESTRATOR_TOOL_REDACTION_CHECK_BYTES = 24 * 1024;
export const ORCHESTRATOR_TOOL_OVERFLOW_HEAD_CHARS = 2_400;
export const ORCHESTRATOR_TOOL_OVERFLOW_TAIL_CHARS = 1_200;
/** Hard safety bounds keeping every inline or preview output safely below pi-durable's 50 KiB / 2,000-line wall. */
export const ORCHESTRATOR_TOOL_OVERFLOW_MAX_BYTES = 44 * 1024;
export const ORCHESTRATOR_TOOL_OVERFLOW_MAX_LINES = 1_600;
export const ORCHESTRATOR_TOOL_OVERFLOW_HEAD_MAX_BYTES = 28 * 1024;
export const ORCHESTRATOR_TOOL_OVERFLOW_HEAD_MAX_LINES = 1_000;
export const ORCHESTRATOR_TOOL_OVERFLOW_TAIL_MAX_BYTES = 12 * 1024;
export const ORCHESTRATOR_TOOL_OVERFLOW_TAIL_MAX_LINES = 500;
/** Aggregate per-assistant-turn inline UTF-8 budget across parallel allowlisted tool calls. */
export const ORCHESTRATOR_TURN_INLINE_BUDGET_BYTES = 64 * 1024;
export const TOOL_OVERFLOW_MARKER_PREFIX = "[KULO_TOOL_OVERFLOW ";
export const TOOL_OVERFLOW_MARKER_RE = /\[KULO_TOOL_OVERFLOW\s+asset_id="([^"]+)"/i;

const HARNESS_NON_EXECUTION_DIAGNOSTIC_CODES = new Set<string>([
  "tool_unavailable",
  "invalid_arguments",
  "blocked",
  "interrupted",
  "restart_limit",
  "aborted",
  "abandoned",
]);

export interface ToolOverflowPolicy {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}

export interface OrchestratorToolOverflowEvent {
  kind: "spilled" | "degraded_redaction" | "degraded_io";
  conversationId: number;
  toolName: string;
  callId: string;
  assetId?: string;
}

export interface OrchestratorToolOverflowOptions {
  uploads: KuloUploadStore;
  /** Must apply connection secret redaction (`connectionManager.redact`). */
  redact: (text: string) => string;
  /** Exact known-secret detector (`connectionManager.isKnownSecret`). */
  isKnownSecret?: (text: string) => boolean;
  /** Optional explicit overrides (primarily for deterministic tests). */
  thresholdChars?: number;
  headChars?: number;
  tailChars?: number;
  turnInlineBudgetBytes?: number;
  /** Lazily resolves the conversation's active model context window for dynamic overflow tiering. */
  resolveContextWindow?: (
    conversationId: ConversationId,
    context: Context,
  ) => Promise<ResolvedConversationModelContext | number>;
  resolveDeferredTools?: (conversationId: ConversationId, candidates: readonly string[], context: Context) => Promise<string[]>;
  onEvent?: (event: OrchestratorToolOverflowEvent) => void;
}

export function containsToolOverflowMarker(text: string): boolean {
  return text.includes(TOOL_OVERFLOW_MARKER_PREFIX) || TOOL_OVERFLOW_MARKER_RE.test(text);
}

export function resolveToolOverflowPolicy(
  toolName: string,
  contextWindow: number,
  isUncalibratedLocal = false,
  overrides?: { thresholdChars?: number; headChars?: number; tailChars?: number },
): ToolOverflowPolicy {
  if (overrides?.thresholdChars !== undefined) {
    return {
      thresholdChars: overrides.thresholdChars,
      headChars: overrides.headChars ?? ORCHESTRATOR_TOOL_OVERFLOW_HEAD_CHARS,
      tailChars: overrides.tailChars ?? ORCHESTRATOR_TOOL_OVERFLOW_TAIL_CHARS,
    };
  }
  const tier: "small" | "medium" | "large" =
    isUncalibratedLocal
      ? "medium"
      : contextWindow < 64_000
        ? "small"
        : contextWindow < 128_000
          ? "medium"
          : "large";

  let base: ToolOverflowPolicy;
  if (tier === "small") {
    base =
      toolName === "bash"
        ? { thresholdChars: 6_000, headChars: 1_500, tailChars: 2_500 }
        : { thresholdChars: 8_000, headChars: 2_400, tailChars: 1_200 };
  } else if (tier === "medium") {
    base =
      toolName === "bash"
        ? { thresholdChars: 10_000, headChars: 2_500, tailChars: 3_500 }
        : toolName === "web_fetch"
          ? { thresholdChars: 12_000, headChars: 3_500, tailChars: 2_000 }
          : { thresholdChars: 14_000, headChars: 4_000, tailChars: 2_000 };
  } else {
    base =
      toolName === "bash"
        ? { thresholdChars: 14_000, headChars: 3_500, tailChars: 5_500 }
        : toolName === "web_fetch"
          ? { thresholdChars: 20_000, headChars: 6_000, tailChars: 3_000 }
          : { thresholdChars: 24_000, headChars: 7_000, tailChars: 3_500 };
  }
  return {
    thresholdChars: base.thresholdChars,
    headChars: overrides?.headChars ?? base.headChars,
    tailChars: overrides?.tailChars ?? base.tailChars,
  };
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function shouldSpillText(text: string, thresholdChars: number): boolean {
  if (text.length > thresholdChars) return true;
  if (Buffer.byteLength(text, "utf8") > ORCHESTRATOR_TOOL_OVERFLOW_MAX_BYTES) return true;
  return countLines(text) > ORCHESTRATOR_TOOL_OVERFLOW_MAX_LINES;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function safeEndBoundary(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end)) ? end - 1 : end;
}

function safeStartBoundary(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return start;
  return isHighSurrogate(text.charCodeAt(start - 1)) && isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
}

function sanitizeShortToken(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._-]+/, "");
  return (cleaned || "call").slice(0, 32);
}

/** Bounds head preview by chars, UTF-8 bytes, line count, and UTF-16 surrogate boundaries BEFORE building markers. */
function sliceHeadBounded(
  text: string,
  maxChars: number,
  maxBytes = ORCHESTRATOR_TOOL_OVERFLOW_HEAD_MAX_BYTES,
  maxLines = ORCHESTRATOR_TOOL_OVERFLOW_HEAD_MAX_LINES,
): string {
  if (!text || maxChars <= 0 || maxBytes <= 0 || maxLines <= 0) return "";
  let end = safeEndBoundary(text, Math.min(text.length, maxChars));

  // Enforce line limit first.
  let lines = 1;
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 10) {
      if (lines >= maxLines) {
        end = i;
        break;
      }
      lines += 1;
    }
  }

  // Enforce UTF-8 byte limit via binary search when multibyte text exceeds maxBytes.
  let head = text.slice(0, end);
  if (Buffer.byteLength(head, "utf8") > maxBytes) {
    let lo = 0;
    let hi = end;
    let best = 0;
    while (lo <= hi) {
      const mid = safeEndBoundary(text, Math.floor((lo + hi) / 2));
      if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    end = best;
    head = text.slice(0, end);
  }

  if (end < text.length) {
    const nl = head.lastIndexOf("\n");
    if (nl > end - 240 && nl > 0) head = head.slice(0, nl);
  }
  return head;
}

/** Bounds tail preview by chars, UTF-8 bytes, line count, and UTF-16 surrogate boundaries BEFORE building markers. */
function sliceTailBounded(
  text: string,
  maxChars: number,
  alreadyUsedHeadChars: number,
  maxBytes = ORCHESTRATOR_TOOL_OVERFLOW_TAIL_MAX_BYTES,
  maxLines = ORCHESTRATOR_TOOL_OVERFLOW_TAIL_MAX_LINES,
): string {
  if (!text || maxChars <= 0 || maxBytes <= 0 || maxLines <= 0 || text.length <= alreadyUsedHeadChars) {
    return "";
  }
  const minStart = safeStartBoundary(text, alreadyUsedHeadChars);
  const remaining = text.length - minStart;
  if (remaining <= 0) return "";
  let start = safeStartBoundary(text, Math.max(minStart, text.length - maxChars));

  // Enforce line limit scanning backwards from end.
  let lines = 1;
  for (let i = text.length - 1; i >= start; i -= 1) {
    if (text.charCodeAt(i) === 10) {
      if (lines >= maxLines) {
        start = i + 1;
        break;
      }
      lines += 1;
    }
  }

  let tail = text.slice(start);
  if (Buffer.byteLength(tail, "utf8") > maxBytes) {
    let lo = start;
    let hi = text.length;
    let best = text.length;
    while (lo <= hi) {
      const mid = safeStartBoundary(text, Math.floor((lo + hi) / 2));
      if (Buffer.byteLength(text.slice(mid), "utf8") <= maxBytes) {
        best = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    start = best;
    tail = text.slice(start);
  }

  if (start > minStart) {
    const nl = tail.indexOf("\n");
    if (nl > 0 && nl < 240) tail = tail.slice(nl + 1);
  }
  return tail;
}

function replaceTextOutput(
  output: NonNullable<ToolExecutionResult["output"]>,
  replacementText: string,
): NonNullable<ToolExecutionResult["output"]> {
  const nonText = output.filter((part) => part.type !== "text");
  return [{ type: "text", text: replacementText }, ...nonText];
}

function buildDegradedText(
  toolName: string,
  safeText: string,
  headChars: number,
  tailChars: number,
  reason: "storage_unavailable" | "redaction_verification_failed",
): string {
  if (reason === "redaction_verification_failed") {
    return `[KULO_TOOL_OVERFLOW_DEGRADED tool="${toolName}" reason="${reason}"]\nOutput omitted because independent redaction verification did not pass; no disk file was written.`;
  }
  const head = sliceHeadBounded(safeText, headChars);
  const tail = sliceTailBounded(safeText, tailChars, head.length);
  const middle = `\n\n[KULO_TOOL_OVERFLOW_DEGRADED tool="${toolName}" total_chars=${safeText.length} preview_head=${head.length} preview_tail=${tail.length} reason="${reason}"]\nFull output could not be persisted to overflow storage; showing bounded redacted head/tail preview.\n\n`;
  return tail ? `${head}${middle}${tail}` : `${head}${middle.trimEnd()}`;
}

function buildOverflowGuidanceLine(toolName: string, savedId: string, savedName: string, headLength: number): string {
  if (toolName === "read") {
    return `Tool-returned window (up to 50 KiB / 2,000 lines, redacted) saved in internal overflow asset "${savedId}" (${savedName}). Paginate omitted middle via kulo_inspect_asset(asset_id="${savedId}", offset=${headLength}, limit=12000); use read(offset=...) for lines beyond the tool window. Never publish this internal asset to users.`;
  }
  if (toolName === "bash") {
    return `Tool-retained tail window (up to 50 KiB / 2,000 lines, redacted) saved in internal overflow asset "${savedId}" (${savedName}). Paginate omitted middle on demand via kulo_inspect_asset(asset_id="${savedId}", offset=${headLength}, limit=12000). Never publish this internal asset to users.`;
  }
  return `Full redacted output saved in internal overflow asset "${savedId}" (${savedName}). Paginate exact middle/full text on demand via kulo_inspect_asset(asset_id="${savedId}", offset=${headLength}, limit=12000). Never publish this internal asset to users.`;
}

/**
 * Top-level chat-only write-time tool output overflow extension.
 *
 * Must be placed strictly AFTER `createCredentialRedactionExtension` in orchestrator
 * conversation extensions (never attached to Workers, Subagents, or SettingsAssistant).
 */
export function createOrchestratorToolOverflowExtension(options: OrchestratorToolOverflowOptions) {
  const turnInlineBudgetBytes = options.turnInlineBudgetBytes ?? ORCHESTRATOR_TURN_INLINE_BUDGET_BYTES;
  const turnInlineUsedBytes = new Map<number, number>();
  const overrides = {
    ...(options.thresholdChars !== undefined ? { thresholdChars: options.thresholdChars } : {}),
    ...(options.headChars !== undefined ? { headChars: options.headChars } : {}),
    ...(options.tailChars !== undefined ? { tailChars: options.tailChars } : {}),
  };

  return defineExtension({
    name: "kulo-orchestrator-tool-overflow",
    hooks: [
      hook(GenerationTask, {
        afterTools: (_assistant, _results, api) => {
          turnInlineUsedBytes.delete(Number(api.conversationId));
        },
        afterRun: (_run, api) => {
          turnInlineUsedBytes.delete(Number(api.conversationId));
          return undefined;
        },
      }),
      hook(ToolTask, {
        afterTool: async (call, result, api, context) => {
          if (!ORCHESTRATOR_TOOL_OVERFLOW_ALLOWLIST.has(call.name)) return undefined;
          // Never spill nested calls invoked via executeTool().
          if ("parent" in call && call.parent !== undefined) return undefined;
          // Never spill Harness-synthesized rejection/interruption/abort results.
          if (context.abortSignal?.aborted) return undefined;
          if (result.diagnostics?.some((d) => Boolean(d.code && HARNESS_NON_EXECUTION_DIAGNOSTIC_CODES.has(d.code)))) {
            return undefined;
          }
          if (!Array.isArray(result.output) || result.output.length === 0) return undefined;

          const textParts = result.output.filter((part): part is { type: "text"; text: string } => part.type === "text");
          if (textParts.length === 0) return undefined;
          const combinedRaw = textParts.map((part) => part.text).join("\n");
          const rawBytes = Buffer.byteLength(combinedRaw, "utf8");
          const rawLines = countLines(combinedRaw);

          const fastMinChars =
            options.thresholdChars !== undefined
              ? Math.min(options.thresholdChars, ORCHESTRATOR_TOOL_REDACTION_CHECK_CHARS)
              : Math.min(6_000, ORCHESTRATOR_TOOL_REDACTION_CHECK_CHARS);
          if (
            combinedRaw.length <= fastMinChars &&
            rawBytes <= ORCHESTRATOR_TOOL_REDACTION_CHECK_BYTES &&
            rawLines <= ORCHESTRATOR_TOOL_OVERFLOW_MAX_LINES
          ) {
            return undefined;
          }

          // Strictly scope to top-level chat topics; explicitly exclude SettingsAssistant & Workers.
          const [state, settingsDoc] = await Promise.all([
            api.snapshot(KuloStateDoc, context),
            api.snapshot(SettingsAssistantDoc, context),
          ]);
          if (
            !isOrchestratorConversation(api.conversationId, state) ||
            isActiveSettingsConversation(api.conversationId, settingsDoc)
          ) {
            return undefined;
          }

          const convNum = Number(api.conversationId);
          if (!Number.isSafeInteger(convNum) || convNum < 1) return undefined;

          let contextWindow = DEFAULT_CONTEXT_WINDOW;
          let isUncalibratedLocal = false;
          if (options.resolveContextWindow && options.thresholdChars === undefined) {
            try {
              const resolved = await options.resolveContextWindow(api.conversationId, context);
              if (typeof resolved === "number") {
                if (Number.isFinite(resolved) && resolved > 0) contextWindow = resolved;
              } else {
                if (Number.isFinite(resolved.contextWindow) && resolved.contextWindow > 0) {
                  contextWindow = resolved.contextWindow;
                }
                isUncalibratedLocal = resolved.isUncalibratedLocal;
              }
            } catch {
              // Keep safe default window if resolution fails.
            }
          }

          const policy = resolveToolOverflowPolicy(call.name, contextWindow, isUncalibratedLocal, overrides);
          const usedThisTurn = turnInlineUsedBytes.get(convNum) ?? 0;
          const turnBudgetTightened =
            options.thresholdChars === undefined &&
            usedThisTurn > 0 &&
            usedThisTurn + rawBytes > turnInlineBudgetBytes;
          const effectiveThresholdChars = turnBudgetTightened
            ? Math.min(policy.thresholdChars, ORCHESTRATOR_TOOL_REDACTION_CHECK_CHARS)
            : policy.thresholdChars;

          const needsRedactionCheck =
            combinedRaw.length > ORCHESTRATOR_TOOL_REDACTION_CHECK_CHARS ||
            rawBytes > ORCHESTRATOR_TOOL_REDACTION_CHECK_BYTES ||
            rawLines > ORCHESTRATOR_TOOL_OVERFLOW_MAX_LINES ||
            shouldSpillText(combinedRaw, effectiveThresholdChars);
          if (!needsRedactionCheck) {
            turnInlineUsedBytes.set(convNum, usedThisTurn + rawBytes);
            return undefined;
          }

          // Independent redaction & secondary verification: prior afterTool hooks may throw and leave raw text.
          let redactedText: string;
          try {
            const firstPass = options.redact(redactSensitiveText(combinedRaw));
            const secondPass = options.redact(redactSensitiveText(firstPass));
            if (secondPass !== firstPass || options.isKnownSecret?.(firstPass)) {
              options.onEvent?.({
                kind: "degraded_redaction",
                conversationId: convNum,
                toolName: call.name,
                callId: call.id,
              });
              return {
                ...result,
                output: replaceTextOutput(
                  result.output,
                  buildDegradedText(call.name, "", policy.headChars, policy.tailChars, "redaction_verification_failed"),
                ),
              };
            }
            redactedText = firstPass;
          } catch {
            options.onEvent?.({
              kind: "degraded_redaction",
              conversationId: convNum,
              toolName: call.name,
              callId: call.id,
            });
            return {
              ...result,
              output: replaceTextOutput(
                result.output,
                buildDegradedText(call.name, "", policy.headChars, policy.tailChars, "redaction_verification_failed"),
              ),
            };
          }

          // Re-check FULL 3D spill condition after redaction (chars + 44 KiB UTF-8 + 1,600 lines).
          const redactedBytes = Buffer.byteLength(redactedText, "utf8");
          const postRedactionThreshold =
            options.thresholdChars === undefined &&
            usedThisTurn > 0 &&
            usedThisTurn + redactedBytes > turnInlineBudgetBytes
              ? Math.min(policy.thresholdChars, ORCHESTRATOR_TOOL_REDACTION_CHECK_CHARS)
              : policy.thresholdChars;
          if (!shouldSpillText(redactedText, postRedactionThreshold)) {
            turnInlineUsedBytes.set(convNum, usedThisTurn + redactedBytes);
            if (redactedText === combinedRaw) return undefined;
            return { ...result, output: replaceTextOutput(result.output, redactedText) };
          }

          // Idempotent disk persistence + strict copy-consistency from persisted bytes.
          const ownerId = `agent:${convNum}`;
          const idempotencyKey = `tool-overflow:${convNum}:${call.id}`;
          let savedId: string;
          let savedName: string;
          let storedText: string;
          let storedBytesLen: number;
          let storedSha256: string;
          try {
            const saved = options.uploads.saveUpload({
              name: `tool-overflow-${call.name}-${sanitizeShortToken(call.id)}.txt`,
              mimeType: "text/plain",
              bytes: Buffer.from(redactedText, "utf8"),
              ownerId,
              idempotencyKey,
              internalOnly: true,
              internalKind: "tool-overflow",
            });
            options.uploads.bindAttachments([saved], `conversation:${convNum}`, ownerId);
            const loaded = options.uploads.getUpload(saved.id);
            if (!loaded) throw new Error("Persisted overflow upload missing");
            const storedBytes = options.uploads.readUploadBytes(loaded);
            if (storedBytes.length !== loaded.record.size) {
              throw new Error("Persisted overflow upload size mismatch");
            }
            const actualSha = crypto.createHash("sha256").update(storedBytes).digest("hex");
            if (loaded.record.sha256 && actualSha !== loaded.record.sha256) {
              throw new Error("Persisted overflow upload checksum mismatch");
            }
            savedId = loaded.record.id;
            savedName = loaded.record.name;
            storedBytesLen = storedBytes.length;
            storedSha256 = actualSha;
            storedText = storedBytes.toString("utf8");
          } catch {
            options.onEvent?.({
              kind: "degraded_io",
              conversationId: convNum,
              toolName: call.name,
              callId: call.id,
            });
            return {
              ...result,
              output: replaceTextOutput(
                result.output,
                buildDegradedText(call.name, redactedText, policy.headChars, policy.tailChars, "storage_unavailable"),
              ),
            };
          }

          // Re-verify stored text contains no newly registered secrets, then bound head/tail BEFORE assembling marker.
          const safePreviewSource = options.redact(redactSensitiveText(storedText));
          const head = sliceHeadBounded(safePreviewSource, policy.headChars);
          const tail = sliceTailBounded(safePreviewSource, policy.tailChars, head.length);
          const marker = [
            `${TOOL_OVERFLOW_MARKER_PREFIX}asset_id="${savedId}" tool="${call.name}" total_chars=${storedText.length} bytes=${storedBytesLen} sha256="${storedSha256.slice(0, 16)}" preview_head=${head.length} preview_tail=${tail.length}]`,
            buildOverflowGuidanceLine(call.name, savedId, savedName, head.length),
          ].join("\n");
          const pointerText = tail ? `${head}\n\n${marker}\n\n${tail}` : `${head}\n\n${marker}`;

          const added = options.resolveDeferredTools
            ? await options.resolveDeferredTools(api.conversationId, ["kulo_inspect_asset"], context)
            : await resolveDeferredAddTools(
                api as unknown as { agent?: (ctx: Context) => Promise<{ deferred: readonly { name: string }[] }> },
                context,
                ["kulo_inspect_asset"],
              );
          const existingAddTools = result.control?.addTools ?? [];
          const mergedAddTools = [...new Set([...existingAddTools, ...added])];
          const nextControl = mergedAddTools.length
            ? { ...(result.control ?? {}), addTools: mergedAddTools }
            : result.control;

          // Strip unredacted raw temp spill path diagnostics on spilled bash results so the model uses kulo_inspect_asset.
          const nextDiagnostics =
            call.name === "bash" && result.diagnostics
              ? result.diagnostics.filter((diag) => diag.code !== "full_output")
              : result.diagnostics;

          options.onEvent?.({
            kind: "spilled",
            conversationId: convNum,
            toolName: call.name,
            callId: call.id,
            assetId: savedId,
          });

          return {
            ...result,
            ...(nextDiagnostics !== undefined ? { diagnostics: nextDiagnostics } : {}),
            output: replaceTextOutput(result.output, pointerText),
            ...(nextControl ? { control: nextControl } : {}),
          };
        },
      }),
    ],
  });
}
