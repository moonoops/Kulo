import { useState } from "react";
import { Chip, Disclosure, Spinner } from "@heroui/react";
import type { ChatDisplayItem, KuloLanguage, ToolActionStatus } from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import {
  formatReadSummaryLabel,
  resolveToolActionLabel,
  resolveToolActionStatusLabel,
} from "./live-status";
import "./tool-step-list.css";

export type ChatToolCallItem = NonNullable<ChatDisplayItem["toolCalls"]>[number];

export type ChatToolStepSegment =
  | {
      kind: "read_group";
      /** Stable key anchored to the first callId in the contiguous read run. */
      id: string;
      steps: ChatToolCallItem[];
    }
  | {
      kind: "step";
      id: string;
      step: ChatToolCallItem;
    };

export function effectiveToolStepStatus(
  step: ChatToolCallItem,
  activeToolIds?: ReadonlySet<string>,
): ToolActionStatus {
  if (activeToolIds?.has(step.id)) return "running";
  if (step.actionMeta) return step.actionMeta.status;
  if (step.result) return step.result.isError ? "error" : "ok";
  return "ok";
}

export function isFoldableReadStep(
  step: ChatToolCallItem,
  activeToolIds?: ReadonlySet<string>,
): boolean {
  if (activeToolIds?.has(step.id)) return false;
  const meta = step.actionMeta;
  if (!meta) return false;
  return meta.category === "read" && meta.status === "ok";
}

/**
 * Render-layer-only grouping of chat tool steps.
 * - Preserves exact original 1:1 call order (never re-orders by completion time).
 * - Only folds contiguous runs of >= 2 steps where every step has `category === "read" && status === "ok"`.
 * - While `liveBusy` is true, holds off collapsing a contiguous `read` span if any sibling read in that
 *   span is still `"running"`, preventing DOM key churn / flicker during out-of-order parallel returns.
 * - Never folds `write`, `confirm`, `awaiting_confirm`, `error`, `other`, or unannotated steps.
 */
export function groupChatToolSteps(
  toolCalls: readonly ChatToolCallItem[],
  options: {
    activeToolIds?: ReadonlySet<string>;
    liveBusy?: boolean;
  } = {},
): ChatToolStepSegment[] {
  const { activeToolIds, liveBusy = false } = options;
  const segments: ChatToolStepSegment[] = [];

  const isInFlightRead = (step: ChatToolCallItem): boolean =>
    step.actionMeta?.category === "read" && effectiveToolStepStatus(step, activeToolIds) === "running";

  const flushRun = (run: ChatToolCallItem[]) => {
    if (run.length === 0) return;
    if (run.length >= 2) {
      segments.push({
        kind: "read_group",
        id: `read-group:${run[0]!.id}`,
        steps: run,
      });
    } else {
      const only = run[0]!;
      segments.push({ kind: "step", id: only.id, step: only });
    }
  };

  let i = 0;
  while (i < toolCalls.length) {
    const current = toolCalls[i]!;
    if (!isFoldableReadStep(current, activeToolIds) && !(liveBusy && isInFlightRead(current))) {
      segments.push({ kind: "step", id: current.id, step: current });
      i += 1;
      continue;
    }

    // Collect a contiguous span of read steps (completed ok + optionally in-flight running reads when liveBusy).
    const span: ChatToolCallItem[] = [];
    let spanHasRunningRead = false;
    while (i < toolCalls.length) {
      const candidate = toolCalls[i]!;
      if (isFoldableReadStep(candidate, activeToolIds)) {
        span.push(candidate);
        i += 1;
      } else if (liveBusy && isInFlightRead(candidate)) {
        span.push(candidate);
        spanHasRunningRead = true;
        i += 1;
      } else {
        break;
      }
    }

    if (liveBusy && spanHasRunningRead) {
      // Keep stable 1:1 keys while parallel reads in this contiguous span are still finishing out of order.
      for (const step of span) {
        segments.push({ kind: "step", id: step.id, step });
      }
    } else {
      flushRun(span);
    }
  }

  return segments;
}

export function summarizeReadGroupTargets(steps: readonly ChatToolCallItem[]): string | undefined {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const label = step.actionMeta?.targetLabel?.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    unique.push(label);
    if (unique.length >= 2) break;
  }
  return unique.length > 0 ? unique.join(" · ") : undefined;
}

function ToolStepRow({
  step,
  active,
  language,
}: {
  step: ChatToolCallItem;
  active: boolean;
  language: KuloLanguage;
}) {
  const status = effectiveToolStepStatus(step, active ? new Set([step.id]) : undefined);
  const label = resolveToolActionLabel({
    name: step.name,
    actionMeta: step.actionMeta,
    running: status === "running",
    language,
  });
  const statusLabel = resolveToolActionStatusLabel(status, language);
  const targetLabel = step.actionMeta?.targetLabel;
  const fallbackToolName = !step.actionMeta && label !== step.name ? step.name : undefined;
  const errorBrief = status === "error" ? step.actionMeta?.errorBrief : undefined;

  return (
    <div className="kulo-tool-step-main">
      <div className="kulo-tool-step-line">
        <span className="kulo-tool-step-label">{label}</span>
        {(targetLabel || fallbackToolName) && (
          <span className="kulo-tool-step-target" title={targetLabel ?? fallbackToolName}>
            {targetLabel ?? fallbackToolName}
          </span>
        )}
        {status === "running" && (
          <Spinner size="sm" aria-label={statusLabel ?? (language === "en" ? "Running" : "执行中")} />
        )}
        {status === "awaiting_confirm" && statusLabel && (
          <Chip size="sm" variant="soft" color="warning">
            {statusLabel}
          </Chip>
        )}
        {status === "error" && statusLabel && (
          <Chip size="sm" variant="soft" color="danger">
            {statusLabel}
          </Chip>
        )}
      </div>
      {errorBrief && (
        <p className="kulo-tool-step-error" role="status">
          {errorBrief}
        </p>
      )}
    </div>
  );
}

export function ChatToolStepList({
  toolCalls,
  activeToolIds,
  liveBusy = false,
  language: languageOverride,
  defaultExpandedGroupIds,
}: {
  toolCalls: readonly ChatToolCallItem[];
  activeToolIds?: ReadonlySet<string>;
  liveBusy?: boolean;
  language?: KuloLanguage;
  defaultExpandedGroupIds?: readonly string[];
}) {
  const i18n = useI18n();
  const language = languageOverride ?? i18n.language;
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(defaultExpandedGroupIds ?? []),
  );

  if (toolCalls.length === 0) return null;

  const segments = groupChatToolSteps(toolCalls, { activeToolIds, liveBusy });
  const setGroupExpanded = (groupId: string, expanded: boolean) => {
    setExpandedGroups((current) => {
      if (expanded === current.has(groupId)) return current;
      const next = new Set(current);
      if (expanded) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
  };

  return (
    <div
      className="kulo-tool-steps"
      aria-label={language === "en" ? "Execution steps" : "执行步骤"}
    >
      {segments.map((segment) => {
        if (segment.kind === "read_group") {
          const expanded = expandedGroups.has(segment.id);
          const preview = summarizeReadGroupTargets(segment.steps);
          return (
            <Disclosure
              key={segment.id}
              isExpanded={expanded}
              onExpandedChange={(open) => setGroupExpanded(segment.id, open)}
              className="kulo-tool-step-group"
            >
              <Disclosure.Heading level={4} className="kulo-tool-step-heading">
                <Disclosure.Trigger className="kulo-tool-step-trigger">
                  <span className="kulo-tool-step-summary-label">
                    {formatReadSummaryLabel(segment.steps.length, language)}
                  </span>
                  {preview && (
                    <span className="kulo-tool-step-preview" aria-hidden="true">
                      {preview}
                    </span>
                  )}
                  <Disclosure.Indicator className="kulo-tool-step-indicator" />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content className="kulo-tool-step-content">
                <Disclosure.Body className="kulo-tool-step-body">
                  <ol className="kulo-tool-step-detail-list">
                    {segment.steps.map((step) => {
                      const status = effectiveToolStepStatus(step, activeToolIds);
                      return (
                        <li
                          key={step.id}
                          className="kulo-tool-step-detail-item"
                          data-call-id={step.id}
                          data-category={step.actionMeta?.category ?? "other"}
                          data-status={status}
                        >
                          <ToolStepRow
                            step={step}
                            active={Boolean(activeToolIds?.has(step.id))}
                            language={language}
                          />
                        </li>
                      );
                    })}
                  </ol>
                </Disclosure.Body>
              </Disclosure.Content>
            </Disclosure>
          );
        }

        const { step } = segment;
        const status = effectiveToolStepStatus(step, activeToolIds);
        return (
          <div
            key={segment.id}
            className="kulo-tool-step-row"
            data-call-id={step.id}
            data-category={step.actionMeta?.category ?? "other"}
            data-status={status}
          >
            <ToolStepRow
              step={step}
              active={Boolean(activeToolIds?.has(step.id))}
              language={language}
            />
          </div>
        );
      })}
    </div>
  );
}
