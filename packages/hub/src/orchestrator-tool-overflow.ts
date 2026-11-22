import crypto from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, hook, ToolTask, type ConversationId, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { redactSensitiveText } from "@kulo/protocol";
import { KuloStateDoc, isOrchestratorConversation } from "./state.js";
import { SettingsAssistantDoc, isActiveSettingsConversation } from "./settings-doc.js";
import { resolveDeferredAddTools } from "./tool-surface.js";
import type { KuloUploadStore } from "./uploads.js";

export const ORCHESTRATOR_TOOL_OVERFLOW_ALLOWLIST = new Set<string>(["read", "bash", "web_fetch"]);
export const ORCHESTRATOR_TOOL_OVERFLOW_THRESHOLD_CHARS = 8_000;
export const ORCHESTRATOR_TOOL_OVERFLOW_HEAD_CHARS = 2_400;
export const ORCHESTRATOR_TOOL_OVERFLOW_TAIL_CHARS = 1_200;
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
  thresholdChars?: number;
  headChars?: number;
  tailChars?: number;
  resolveDeferredTools?: (conversationId: ConversationId, candidates: readonly string[], context: Context) => Promise<string[]>;
  onEvent?: (event: OrchestratorToolOverflowEvent) => void;
}

export function containsToolOverflowMarker(text: string): boolean {
  return text.includes(TOOL_OVERFLOW_MARKER_PREFIX) || TOOL_OVERFLOW_MARKER_RE.test(text);
}

function sanitizeShortToken(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._-]+/, "");
  return (cleaned || "call").slice(0, 32);
}

function sliceHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let head = text.slice(0, maxChars);
  const nl = head.lastIndexOf("\n");
  if (nl > maxChars - 240 && nl > 0) head = head.slice(0, nl);
  return head;
}

function sliceTail(text: string, maxChars: number, alreadyUsedHeadChars: number): string {
  if (maxChars <= 0 || text.length <= alreadyUsedHeadChars) return "";
  const remaining = text.length - alreadyUsedHeadChars;
  const take = Math.min(maxChars, remaining);
  let tail = text.slice(text.length - take);
  if (tail.length < remaining) {
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
  const head = sliceHead(safeText, headChars);
  const tail = sliceTail(safeText, tailChars, head.length);
  const middle = `\n\n[KULO_TOOL_OVERFLOW_DEGRADED tool="${toolName}" total_chars=${safeText.length} preview_head=${head.length} preview_tail=${tail.length} reason="${reason}"]\nFull output could not be persisted to overflow storage; showing bounded redacted head/tail preview.\n\n`;
  return tail ? `${head}${middle}${tail}` : `${head}${middle.trimEnd()}`;
}

/**
 * Top-level chat-only write-time tool output overflow extension.
 *
 * Must be placed strictly AFTER `createCredentialRedactionExtension` in orchestrator
 * conversation extensions (never attached to Workers, Subagents, or SettingsAssistant).
 */
export function createOrchestratorToolOverflowExtension(options: OrchestratorToolOverflowOptions) {
  const thresholdChars = options.thresholdChars ?? ORCHESTRATOR_TOOL_OVERFLOW_THRESHOLD_CHARS;
  const headChars = options.headChars ?? ORCHESTRATOR_TOOL_OVERFLOW_HEAD_CHARS;
  const tailChars = options.tailChars ?? ORCHESTRATOR_TOOL_OVERFLOW_TAIL_CHARS;

  return defineExtension({
    name: "kulo-orchestrator-tool-overflow",
    hooks: [
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
          if (combinedRaw.length <= thresholdChars) return undefined;

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
                  buildDegradedText(call.name, "", headChars, tailChars, "redaction_verification_failed"),
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
                buildDegradedText(call.name, "", headChars, tailChars, "redaction_verification_failed"),
              ),
            };
          }

          // Re-check length after redaction in case redaction shrank it below threshold.
          if (redactedText.length <= thresholdChars) {
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
                buildDegradedText(call.name, redactedText, headChars, tailChars, "storage_unavailable"),
              ),
            };
          }

          // Re-verify stored text contains no newly registered secrets before surfacing preview.
          const safePreviewSource = options.redact(redactSensitiveText(storedText));
          const head = sliceHead(safePreviewSource, headChars);
          const tail = sliceTail(safePreviewSource, tailChars, head.length);
          const marker = [
            `${TOOL_OVERFLOW_MARKER_PREFIX}asset_id="${savedId}" tool="${call.name}" total_chars=${storedText.length} bytes=${storedBytesLen} sha256="${storedSha256.slice(0, 16)}" preview_head=${head.length} preview_tail=${tail.length}]`,
            `Full redacted output saved in internal overflow asset "${savedId}" (${savedName}). Paginate exact middle/full text on demand via kulo_inspect_asset(asset_id="${savedId}", offset=${head.length}, limit=12000). Never publish this internal asset to users.`,
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

          options.onEvent?.({
            kind: "spilled",
            conversationId: convNum,
            toolName: call.name,
            callId: call.id,
            assetId: savedId,
          });

          return {
            ...result,
            output: replaceTextOutput(result.output, pointerText),
            ...(nextControl ? { control: nextControl } : {}),
          };
        },
      }),
    ],
  });
}
