import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExternalClientConnection, ProviderCatalogItem, ProviderModelItem, TicketCardView, TicketRecord } from "@kulo/protocol";
import { KuloTaskProjection, TaskStatus } from "../../kulo-tasks";
import { buildSameEngineResumeOptions, QuotaResumePopover, TaskQuotaActions } from "./quota-resume-popover";
import { isTicketQuotaPaused, isTicketRunHealthStuck, taskNeedsAttention, taskRank, taskStatusLabel, ticketWaitLabel } from "./task-model";
import { KuloTaskRail } from "./task-rail";

const makeModel = (id: string, name: string, reasoning: boolean): ProviderModelItem => ({
  id,
  name,
  reasoning,
  vision: false,
  modalities: ["text"],
  contextWindow: 128_000,
  maxTokens: 16_384,
  supportedThinkingLevels: reasoning ? ["low", "medium", "high"] : [],
});

const builtInProviders: ProviderCatalogItem[] = [
  {
    id: "openai",
    name: "OpenAI",
    builtin: true,
    supportsApiKey: true,
    supportsOAuth: false,
    authenticated: true,
    baseUrl: "https://api.openai.com/v1",
    models: [
      makeModel("gpt-4o", "GPT-4o", true),
      makeModel("gpt-4o-mini", "GPT-4o Mini", false),
      makeModel("dall-e-3", "DALL-E 3", false),
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    builtin: true,
    supportsApiKey: true,
    supportsOAuth: false,
    authenticated: true,
    baseUrl: "https://api.anthropic.com/v1",
    models: [makeModel("claude-opus-4", "Claude Opus 4", true)],
  },
  {
    id: "local-ollama",
    name: "Ollama Local",
    builtin: false,
    supportsApiKey: false,
    supportsOAuth: false,
    authenticated: false,
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [makeModel("qwen2.5-coder:32b", "Qwen 2.5 Coder 32B", true)],
  },
  {
    id: "unconfigured-provider",
    name: "Unconfigured",
    builtin: true,
    supportsApiKey: true,
    supportsOAuth: false,
    authenticated: false,
    baseUrl: "https://api.example.com/v1",
    models: [makeModel("hidden-model", "Hidden", false)],
  },
];

const externalClients: Record<string, ExternalClientConnection> = {
  "codex:local": {
    id: "codex:local",
    kind: "codex",
    envId: "local",
    label: "Codex",
    models: [
      { id: "gpt-5-codex", name: "GPT-5 Codex" },
      { id: "gpt-5-codex-mini", name: "GPT-5 Codex Mini" },
    ],
    updatedAt: 1,
  },
  "claude-code:local": {
    id: "claude-code:local",
    kind: "claude-code",
    envId: "local",
    label: "Claude Code",
    models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }],
    updatedAt: 1,
  },
};

const baseCard: TicketCardView = {
  id: "T-0001",
  title: "实现额度暂停与恢复",
  role: "developer",
  roleLabel: "开发智能体",
  status: "waiting",
  envId: "local",
  workspaceDir: "/project",
  createdAt: 1,
  updatedAt: 2,
  waiting: { reason: "quota", since: 2, detail: "Monthly usage limit reached" },
  quotaPause: {
    kind: "provider_quota",
    provider: "openai",
    modelId: "gpt-4o",
    errorMessage: "Monthly usage limit reached",
    pausedAt: 2,
  },
};

describe("quota pause & run-health stuck UI", () => {
  it("recognizes waiting(reason='quota') as attention-required in task-model", () => {
    expect(ticketWaitLabel({ reason: "quota", since: 1 })).toBe("额度暂停");
    expect(taskStatusLabel(baseCard)).toBe("额度暂停");
    expect(isTicketQuotaPaused(baseCard)).toBe(true);
    expect(taskNeedsAttention(baseCard)).toBe(true);
    expect(taskRank(baseCard)).toBe(0);
    expect(renderToStaticMarkup(<TaskStatus status="waiting" waiting={{ reason: "quota", since: 1 }} />)).toContain("额度暂停");
  });

  it("lists only same-engine built-in conversation models and disables exhausted models", () => {
    const options = buildSameEngineResumeOptions({
      ticket: baseCard,
      providers: builtInProviders,
      externalClients,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });

    expect(options.map((o) => `${o.provider}:${o.modelId}`)).toEqual([
      "openai:gpt-4o",
      "openai:gpt-4o-mini",
      "anthropic:claude-opus-4",
      "local-ollama:qwen2.5-coder:32b",
    ]);
    // Image models and unconfigured providers are excluded; external clients never appear
    expect(options.some((o) => o.modelId === "dall-e-3")).toBe(false);
    expect(options.some((o) => o.provider === "codex:local")).toBe(false);

    const exhausted = options.find((o) => o.modelId === "gpt-4o")!;
    expect(exhausted.exhausted).toBe(true);
    expect(exhausted.disabled).toBe(true);
    expect(exhausted.disabledReason).toContain("额度已耗尽");

    const alt = options.find((o) => o.modelId === "claude-opus-4")!;
    expect(alt.exhausted).toBe(false);
    expect(alt.disabled).toBe(false);
  });

  it("disables cloud models under usage_cap while keeping local loopback models enabled", () => {
    const options = buildSameEngineResumeOptions({
      ticket: {
        ...baseCard,
        quotaPause: {
          kind: "usage_cap",
          provider: "openai",
          modelId: "gpt-4o",
          errorMessage: "已达每日 Token 上限",
          pausedAt: 2,
        },
      },
      providers: builtInProviders,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });

    expect(options.find((o) => o.modelId === "claude-opus-4")?.disabled).toBe(true);
    expect(options.find((o) => o.modelId === "qwen2.5-coder:32b")?.disabled).toBe(false);
  });

  it("lists only same-client models for external ACP tickets and grays out exhausted model", () => {
    const externalCard: TicketCardView = {
      ...baseCard,
      externalAgentKind: "codex",
      externalClientId: "codex:local",
      externalModelId: "gpt-5-codex",
      quotaPause: {
        kind: "external_quota",
        externalClientId: "codex:local",
        modelId: "gpt-5-codex",
        errorMessage: "Weekly limit reached",
        pausedAt: 2,
      },
    };
    const options = buildSameEngineResumeOptions({
      ticket: externalCard,
      providers: builtInProviders,
      externalClients,
    });

    expect(options.map((o) => o.modelId)).toEqual(["gpt-5-codex", "gpt-5-codex-mini"]);
    expect(options[0]?.exhausted).toBe(true);
    expect(options[0]?.disabled).toBe(true);
    expect(options[1]?.disabled).toBe(false);
  });

  it("renders '额度暂停' badge and '换模型继续' / '重试' / '停止' actions on quota-paused task card", () => {
    const html = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[baseCard]}
        providers={builtInProviders}
        externalClients={externalClients}
        defaultProvider="openai"
        defaultModel="gpt-4o"
        onProject={() => {}}
        onResumeOverride={async () => {}}
        onStop={async () => {}}
      />,
    );
    expect(html).toContain("额度暂停");
    expect(html).toContain('data-attention="true"');
    expect(html).toContain("换模型继续");
    expect(html).toContain("重试");
    expect(html).toContain("停止");
  });

  it("renders '换更强模型继续' action on run-health stuck cards (doom_loop & judge_stuck)", () => {
    const stuckCard: TicketCardView = {
      ...baseCard,
      status: "running",
      waiting: undefined,
      quotaPause: undefined,
      runHealthStuck: {
        kind: "doom_loop",
        reason: "连续 5 轮重复相同工具调用",
        at: 3,
      },
    };
    expect(isTicketRunHealthStuck(stuckCard)).toBe(true);

    const railHtml = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[stuckCard]}
        providers={builtInProviders}
        onProject={() => {}}
        onResumeOverride={async () => {}}
      />,
    );
    expect(railHtml).toContain("换更强模型继续");

    const stuckRecord: TicketRecord = {
      id: "T-0002",
      commandId: "cmd-2",
      title: "停滞任务详情",
      goal: "修复回归",
      scope: "src",
      role: "developer",
      status: "running",
      envId: "local",
      workspaceDir: "/project",
      workerConversationId: 5,
      runEpoch: 1,
      createdAt: 1,
      updatedAt: 3,
      runHealthStuck: {
        kind: "judge_stuck",
        reason: "模型陷入死循环",
        at: 3,
      },
    };
    const detailHtml = renderToStaticMarkup(
      <KuloTaskProjection
        detail={{ ticket: stuckRecord, transcript: [], live: { busy: false, activeTools: [], queuedCount: 0 } }}
        roleLabel="开发智能体"
        onAnswerBlocker={async () => {}}
        onStop={() => {}}
        onRetry={async () => {}}
        onResumeOverride={async () => {}}
        providers={builtInProviders}
        onArchiveClose={async () => {}}
        onDefer={() => {}}
      />,
    );
    expect(detailHtml).toContain("任务疑似停滞");
    expect(detailHtml).toContain("模型陷入死循环");
    expect(detailHtml).toContain("换更强模型继续");
  });

  it("renders standalone QuotaResumePopover and TaskQuotaActions cleanly", () => {
    const popoverHtml = renderToStaticMarkup(
      <QuotaResumePopover
        ticket={baseCard}
        mode="quota"
        providers={builtInProviders}
        onResumeOverride={async () => {}}
      />,
    );
    expect(popoverHtml).toContain("换模型继续");

    const actionsHtml = renderToStaticMarkup(
      <TaskQuotaActions
        ticket={baseCard}
        providers={builtInProviders}
        onResumeOverride={async () => {}}
        onStop={async () => {}}
      />,
    );
    expect(actionsHtml).toContain("换模型继续");
    expect(actionsHtml).toContain("重试");
    expect(actionsHtml).toContain("停止");
  });
});
