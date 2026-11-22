import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SubagentCardView, TicketCardView, TicketRecord } from "@kulo/protocol";
import { KuloTaskProjection } from "../../kulo-tasks";
import { KuloTaskRail } from "./task-rail";
import { TaskSubagents } from "./task-subagents";

const baseTicket: TicketRecord = {
  id: "T-0001",
  commandId: "cmd-1",
  title: "排查并发状态机问题",
  goal: "排查并修复状态机缺陷",
  scope: "packages/hub",
  role: "architect",
  status: "running",
  envId: "local",
  workspaceDir: "/tmp/project",
  workerConversationId: 10,
  runEpoch: 1,
  createdAt: 1000,
  updatedAt: 2000,
};

const sampleSubagents: SubagentCardView[] = [
  {
    id: "T-0001:S-01",
    name: "hub-scout",
    role: "scout",
    roleLabel: "侦察员",
    readOnly: true,
    runs: 2,
    state: "running",
    lastSummary: "正在核查 packages/hub/src/hub.ts 状态转移路径",
    updatedAt: 2500,
  },
  {
    id: "T-0001:S-02",
    name: "edge-checker",
    role: "checker",
    roleLabel: "检验员",
    readOnly: true,
    runs: 1,
    state: "ready",
    lastSummary: "已确认只读边界与脱敏链路完好",
    updatedAt: 2400,
  },
  {
    id: "T-0001:S-03",
    name: "patch-coder",
    role: "coder",
    roleLabel: "开发者",
    readOnly: false,
    runs: 1,
    state: "failed",
    lastSummary: "[TIMEOUT] 单任务超时并已安全排空",
    updatedAt: 2300,
  },
];

describe("TaskSubagents & TaskRail subagent observability", () => {
  it("renders nothing when a ticket has no subagents", () => {
    expect(renderToStaticMarkup(<TaskSubagents subagents={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<TaskSubagents subagents={[]} />)).toBe("");

    const detailHtml = renderToStaticMarkup(
      <KuloTaskProjection
        detail={{
          ticket: baseTicket,
          transcript: [],
          live: { busy: true, activeTools: [], queuedCount: 0 },
        }}
        roleLabel="架构师"
        onRetry={async () => {}}
        onArchiveClose={async () => {}}
        onStop={() => {}}
        onDefer={() => {}}
        onAnswerBlocker={async () => {}}
      />,
    );
    expect(detailHtml).not.toContain("协作队友");
  });

  it("renders grouped list of teammates with running indicator, role metadata, run count, and summaries", () => {
    const html = renderToStaticMarkup(
      <KuloTaskProjection
        detail={{
          ticket: baseTicket,
          transcript: [],
          live: { busy: true, activeTools: [], queuedCount: 0 },
          subagents: sampleSubagents,
        }}
        roleLabel="架构师"
        onRetry={async () => {}}
        onArchiveClose={async () => {}}
        onStop={() => {}}
        onDefer={() => {}}
        onAnswerBlocker={async () => {}}
      />,
    );

    expect(html).toContain("协作队友");
    expect(html).toContain("(3)");
    expect(html).toContain("1 运行中");
    expect(html).toContain("kulo-list-surface");
    expect(html).toContain("hub-scout");
    expect(html).toContain("侦察员 · 只读 · ×2");
    expect(html).toContain("edge-checker");
    expect(html).toContain("检验员 · 只读");
    expect(html).toContain("patch-coder");
    expect(html).toContain("开发者 · 可写");
    expect(html).toContain("已确认只读边界与脱敏链路完好");
    expect(html).toContain("[TIMEOUT] 单任务超时并已安全排空");
  });

  it("shows running teammate count in TaskRail only when running > 0", () => {
    const runningCard: TicketCardView = {
      id: "T-0001",
      title: "主任务 A",
      role: "architect",
      roleLabel: "架构师",
      status: "running",
      envId: "local",
      workspaceDir: "/tmp/project",
      createdAt: 1000,
      updatedAt: 2000,
      subagentSummary: { running: 2, total: 3, revision: 42 },
    };
    const settledCard: TicketCardView = {
      ...runningCard,
      id: "T-0002",
      title: "主任务 B",
      status: "ready",
      subagentSummary: { running: 0, total: 3, revision: 43 },
    };

    const html = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[runningCard, settledCard]}
        onProject={() => {}}
      />,
    );
    expect(html).toContain("2 队友运行中");
    expect(html).not.toContain("0 队友运行中");
  });
});
