import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  validateUiCardInput,
  type BatchWorkflowCardView,
  type UiCardSnapshot,
} from "@kulo/protocol";
import { buildBatchDispatchConfirmCard } from "../../../../hub/src/action-confirmation-cards";
import { GeneratedCard } from "../genui/generated-card";
import { BatchWorkflowCard, BatchWorkflowSection } from "./batch-workflow-card";
import { KuloTaskRail } from "./task-rail";

const sampleBatch: BatchWorkflowCardView = {
  id: "BW-0001",
  title: "只读代码安全审计",
  mode: "parallel",
  readOnly: true,
  status: "partial",
  originTopicId: "root",
  role: "scout",
  concurrency: 4,
  waveSize: 8,
  totalWaves: 2,
  currentWave: 1,
  counts: {
    total: 9,
    completed: 6,
    failed: 2,
    pending: 1,
    running: 0,
    stopped: 0,
  },
  budgetCapped: true,
  budgetCapReason: "用量上限已触顶，停止派发新子项（在途子项单独结算）。",
  items: [
    {
      itemId: "item-01",
      label: "审计 packages/hub/src/auth.ts",
      status: "completed",
      attempts: 1,
      validatedOutput: { findings: 0, verdict: "ok" },
      waveIndex: 0,
      updatedAt: 100,
    },
    {
      itemId: "item-02",
      label: "审计 packages/hub/src/server.ts",
      status: "failed",
      attempts: 2,
      error: "子项输出未通过 Schema 校验：/verdict (enum): must match allowed values",
      waveIndex: 0,
      updatedAt: 120,
    },
    {
      itemId: "item-09",
      label: "审计 packages/web/src/App.tsx",
      status: "pending",
      attempts: 0,
      waveIndex: 1,
      updatedAt: 130,
    },
  ],
  createdAt: 10,
  updatedAt: 130,
  completedAt: 130,
};

describe("BatchWorkflowCard and batch_dispatch confirmation card", () => {
  it("renders a single collapsible parent progress card with counts, wave info, budget partial notice, and retry action", () => {
    const html = renderToStaticMarkup(
      <BatchWorkflowCard
        batch={sampleBatch}
        defaultExpanded
        onRetryFailed={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(html).toContain("只读代码安全审计");
    expect(html).toContain("纯只读");
    expect(html).toContain("部分完成");
    expect(html).toContain("共 9 项");
    expect(html).toContain("已完成 6");
    expect(html).toContain("失败 2");
    expect(html).toContain("待执行 1");
    expect(html).toContain("波次 2/2");
    expect(html).toContain("用量上限已触顶");
    expect(html).toContain("审计 packages/hub/src/auth.ts");
    expect(html).toContain("审计 packages/hub/src/server.ts");
    expect(html).toContain("×2");
    expect(html).toContain("W1");
    expect(html).toContain("W2");
    expect(html).toContain("重试失败项 (2)");
    expect(html).toContain('aria-label="重试子项：审计 packages/hub/src/server.ts"');
    // Ensure no nested <button> tags inside any button
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
      expect(button.match(/<button\b/g)).toHaveLength(1);
    }
  });

  it("integrates into KuloTaskRail without showing empty state when batch workflows exist", () => {
    const runningBatch: BatchWorkflowCardView = {
      ...sampleBatch,
      id: "BW-0002",
      status: "running",
      budgetCapped: false,
      budgetCapReason: undefined,
      counts: { total: 4, completed: 1, failed: 0, pending: 1, running: 2, stopped: 0 },
    };

    const html = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        batchWorkflows={[runningBatch]}
        onProject={() => {}}
        onRetryBatchWorkflow={vi.fn()}
        onStopBatchWorkflow={vi.fn()}
      />,
    );

    expect(html).toContain("只读代码安全审计");
    expect(html).toContain("运行中");
    expect(html).toContain('aria-label="停止批处理：只读代码安全审计"');
    expect(html).not.toContain("暂无后台任务");
  });

  it("renders awaiting_confirmation batch state with human-approval hint", () => {
    const awaitingBatch: BatchWorkflowCardView = {
      ...sampleBatch,
      id: "BW-0003",
      status: "awaiting_confirmation",
      budgetCapped: false,
      budgetCapReason: undefined,
      confirmationCardId: "card_batch_001",
      counts: { total: 8, completed: 0, failed: 0, pending: 8, running: 0, stopped: 0 },
    };

    const html = renderToStaticMarkup(
      <BatchWorkflowSection batches={[awaitingBatch]} onStop={vi.fn()} />,
    );
    expect(html).toContain("待人工批准");
    expect(html).toContain("超过 6 项");
    expect(html).toContain("共 8 项");
  });

  it("builds a valid GenUI batch_dispatch confirmation card (human Approve/Reject only, no manual orchestrator bypass) and renders cleanly via GeneratedCard", () => {
    const built = buildBatchDispatchConfirmCard({
      batchId: "BW-0009",
      title: "批量只读依赖核查",
      itemCount: 8,
      itemLabels: Array.from({ length: 8 }, (_, idx) => `模块 ${idx + 1}`),
      waveSize: 8,
      concurrency: 4,
    });

    expect(() => validateUiCardInput(built.input)).not.toThrow();
    expect(built.logicalIds).toEqual(["confirm", "cancel"]);
    expect(built.logicalIds).not.toContain("manual");

    const snapshot: UiCardSnapshot = {
      cardId: "card_batch_confirm_1",
      schemaVersion: 1,
      catalogVersion: 1,
      originConversationId: 1,
      title: built.input.title,
      spec: built.input.spec,
      actions: built.input.actions.map((a) => ({ ...a, fields: [] })),
      committedState: {},
      status: "ready",
      revision: 1,
    };

    const html = renderToStaticMarkup(
      <GeneratedCard
        card={snapshot}
        onAction={vi.fn(async (input) => ({
          commandId: input.commandId,
          cardId: snapshot.cardId,
          status: "submitted" as const,
          revision: 2,
          deduplicated: false,
        }))}
      />,
    );

    expect(html).toContain("确认批量只读派发（8 项）");
    expect(html).toContain("纯只读并行");
    expect(html).toContain("需人工批准 (8 项)");
    expect(html).toContain("允许批量执行");
    expect(html).toContain("拒绝");
    expect(html).not.toContain("按说明处理");
  });
});
