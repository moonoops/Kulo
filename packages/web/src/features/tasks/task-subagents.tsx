import { Chip, Disclosure, Spinner } from "@heroui/react";
import type { SubagentCardView } from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";

function subagentChipProps(
  state: SubagentCardView["state"],
  t: (zh: string, en: string) => string,
): { color: "accent" | "success" | "danger" | "default"; label: string } {
  switch (state) {
    case "running":
      return { color: "accent", label: t("运行中", "Running") };
    case "queued":
      return { color: "default", label: t("排队中", "Queued") };
    case "waiting":
      return { color: "default", label: t("等待中", "Waiting") };
    case "ready":
      return { color: "success", label: t("已完成", "Done") };
    case "failed":
      return { color: "danger", label: t("异常", "Failed") };
    case "stopped":
      return { color: "default", label: t("已停止", "Stopped") };
  }
}

export function TaskSubagents({
  subagents,
}: {
  subagents?: readonly SubagentCardView[];
}) {
  const { t } = useI18n();
  if (!subagents || subagents.length === 0) return null;

  const runningCount = subagents.filter((s) => s.state === "running").length;

  return (
    <Disclosure
      defaultExpanded={runningCount > 0}
      className="kulo-task-detail-disclosure"
    >
      <Disclosure.Heading level={2}>
        <Disclosure.Trigger className="kulo-task-detail-trigger">
          <span className="kulo-task-subagents-heading">
            <span>
              {t("协作队友", "Teammates")} ({subagents.length})
            </span>
            {runningCount > 0 && (
              <Chip size="sm" variant="soft" color="accent" className="inline-flex shrink-0 items-center gap-1.5 font-medium">
                <Spinner size="sm" color="current" aria-label={t("队友运行中", "Teammates running")} className="h-3.5 w-3.5" />
                <span>{t(`${runningCount} 运行中`, `${runningCount} active`)}</span>
              </Chip>
            )}
          </span>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="kulo-task-subagents-body">
          <div className="kulo-list-surface kulo-task-subagents-list" role="list" aria-label={t("协作队友列表", "Teammates list")}>
            {subagents.map((sub) => {
              const chip = subagentChipProps(sub.state, t);
              const metaParts = [
                sub.roleLabel || sub.role,
                sub.readOnly ? t("只读", "Read-only") : t("可写", "Writable"),
                ...(sub.runs > 1 ? [`×${sub.runs}`] : []),
              ];
              return (
                <div key={sub.id} className="kulo-task-subagent-row" role="listitem">
                  <div className="kulo-task-subagent-head">
                    <div className="kulo-task-subagent-identity">
                      <span className="kulo-task-subagent-name">{sub.name}</span>
                      <span className="kulo-task-subagent-meta">{metaParts.join(" · ")}</span>
                    </div>
                    <Chip size="sm" variant="soft" color={chip.color} className="inline-flex shrink-0 items-center gap-1.5 font-medium">
                      {sub.state === "running" ? (
                        <Spinner size="sm" color="current" aria-label={chip.label} className="h-3.5 w-3.5" />
                      ) : (
                        <KuloIcon
                          size={14}
                          filled
                          name={
                            sub.state === "ready"
                              ? "check-circle"
                              : sub.state === "failed"
                                ? "error"
                                : "schedule"
                          }
                        />
                      )}
                      <span>{chip.label}</span>
                    </Chip>
                  </div>
                  {sub.lastSummary && (
                    <Disclosure className="kulo-task-subagent-disclosure">
                      <Disclosure.Heading level={3}>
                        <Disclosure.Trigger className="kulo-task-event-trigger kulo-task-subagent-trigger">
                          <span className="kulo-task-event-preview">{sub.lastSummary}</span>
                          <Disclosure.Indicator />
                        </Disclosure.Trigger>
                      </Disclosure.Heading>
                      <Disclosure.Content>
                        <Disclosure.Body className="kulo-task-subagent-summary-body">
                          <p className="kulo-task-subagent-summary">{sub.lastSummary}</p>
                        </Disclosure.Body>
                      </Disclosure.Content>
                    </Disclosure>
                  )}
                </div>
              );
            })}
          </div>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
