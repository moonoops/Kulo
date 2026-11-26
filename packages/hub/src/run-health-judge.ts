import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
  isGoogleThinkingApi,
  resolveZeroToolThinkingLevel,
  suppressGoogleThoughtSummaries,
  ZERO_TOOL_THINKING_HEADROOM_TOKENS,
} from "./zero-tool-thinking.js";
import {
  parseRunHealthJudgeVerdict,
  type JudgeTrajectoryInput,
  type RunHealthJudgeVerdict,
} from "./run-health-policy.js";

export const RUN_HEALTH_JUDGE_TIMEOUT_MS = 10_000;
export const RUN_HEALTH_JUDGE_MAX_TOKENS = 400;

const RUN_HEALTH_JUDGE_SYSTEM_PROMPT = [
  "You are a lightweight execution-health monitor for an AI agent loop.",
  "Inspect the allowlisted trajectory JSON and return STRICT JSON ONLY (no markdown, no extra prose):",
  '{"verdict":"healthy"|"handoff_or_wrap"|"stuck","reason":"<concise Chinese/English reason>","guidance":"<optional concise next step>"}',
  "Verdict rules:",
  '- "healthy": clearly making genuine forward progress toward the goal.',
  '- "handoff_or_wrap": slow/sprawling multi-step work; orchestrator should hand off via kulo_dispatch or wrap up soon, worker should converge and report soon.',
  '- "stuck": repeating fruitless steps, spinning on unresolvable errors/pages, or unable to advance; must wrap up immediately.',
  "When uncertain, prefer \"healthy\".",
].join("\n");

export interface RunHealthJudgeInput {
  models: Models;
  modelRef: ModelRef;
  trajectory: JudgeTrajectoryInput;
  redact: (text: string) => string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onWarning?: (message: string) => void;
}

/**
 * Evaluates a long-running agent trajectory using the wrapped `models.completeSimple` path
 * (preserving UsageCaps, `kulo-thinking:` wrappers, OAuth refresh, and reasoning-model
 * thinking-level clamping). Strictly fail-open: never throws and resolves to `null` on
 * timeout, abort, transport error, tool-call/non-stop response, or malformed JSON.
 */
export async function evaluateRunHealthWithJudge(
  input: RunHealthJudgeInput,
): Promise<RunHealthJudgeVerdict | null> {
  const warn = (message: string) => {
    const safe = input.redact(message).slice(0, 300);
    if (input.onWarning) input.onWarning(safe);
    else console.warn("[KuloRunHealthJudge]", safe);
  };

  if (input.signal?.aborted) return null;

  const timeoutMs = input.timeoutMs ?? RUN_HEALTH_JUDGE_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;

  try {
    const model = input.models.getModel(input.modelRef.provider, input.modelRef.modelId);
    if (!model) {
      warn(`model_unavailable:${input.modelRef.provider}/${input.modelRef.modelId}`);
      return null;
    }

    const minThinking = resolveZeroToolThinkingLevel(model, input.models);
    const needsHeadroom =
      minThinking !== "off" || (Boolean(model.reasoning) && model.api !== "anthropic-messages");
    const targetTokens =
      RUN_HEALTH_JUDGE_MAX_TOKENS + (needsHeadroom ? ZERO_TOOL_THINKING_HEADROOM_TOKENS : 0);
    const maxTokens = model.maxTokens ? Math.min(targetTokens, model.maxTokens) : targetTokens;
    const isGoogle = isGoogleThinkingApi(model.api);

    const safeUserContent = input.redact(JSON.stringify(input.trajectory));

    const message = await input.models.completeSimple(
      model,
      {
        systemPrompt: RUN_HEALTH_JUDGE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: safeUserContent,
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal,
        maxTokens,
        cacheRetention: "none",
        disableNativeTools: true,
        ...(minThinking !== "off" ? { reasoning: minThinking } : {}),
        ...(isGoogle
          ? { onPayload: (payload: unknown) => suppressGoogleThoughtSummaries(model.api, payload) }
          : {}),
      } as Parameters<Models["completeSimple"]>[2],
    );

    if (
      message.stopReason !== "stop" ||
      message.content.some((part) => part.type === "toolCall")
    ) {
      warn(`judge_invalid_stop:${message.stopReason}`);
      return null;
    }

    const rawText = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const redactedOutput = input.redact(rawText);
    const parsed = parseRunHealthJudgeVerdict(redactedOutput);
    if (!parsed) {
      warn("judge_invalid_json_verdict");
      return null;
    }

    return {
      verdict: parsed.verdict,
      reason: input.redact(parsed.reason),
      ...(parsed.guidance ? { guidance: input.redact(parsed.guidance) } : {}),
    };
  } catch (error) {
    if (!input.signal?.aborted) {
      const msg = error instanceof Error ? error.message : String(error);
      warn(`judge_failed:${msg}`);
    }
    return null;
  }
}
