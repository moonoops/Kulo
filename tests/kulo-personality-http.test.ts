import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { KuloHub, KuloStateDoc, PersonalityDoc, startKuloHubServer } from "@kulo/hub";
import type { IdentityRead, IdentitySaved, PersonalitySnapshot, RecentWorkSnapshot, TicketRecord, UsageStatsView } from "@kulo/protocol";
import { HUB_TEST_ADMIN_TOKEN, fetchWithHubAuth } from "./helpers/hub-auth.js";

const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function tools(context: TranscriptContext): string[] {
  return [...new Set([
    ...(context.tools?.map((tool) => tool.name) ?? []),
    ...context.messages.flatMap((message) => message.role === "system" ? message.toolsAdded?.map((tool) => tool.name) ?? [] : []),
  ])];
}

async function fixture(options: {
  localEnv?: boolean;
  reply?: (context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;
} = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-personality-http-"));
  cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const requests: TranscriptContext[] = [];
  const provider = fauxProvider({ provider: "openai", models: [{ id: "personality-main-model" }] });
  provider.setResponses(Array.from({ length: 40 }, () => (context: TranscriptContext) => {
    requests.push(JSON.parse(JSON.stringify(context)) as TranscriptContext);
    return options.reply?.(context) ?? fauxAssistantMessage([fauxText("已收到。")]);
  }));
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: {
    stateDir, authToken: HUB_TEST_ADMIN_TOKEN, enableLocalEnv: options.localEnv !== false,
    localEnvRoot: path.join(stateDir, "workspace"), watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "personality-main-model", thinkingLevel: "off" },
  } });
  cleanup.push(() => hub.close());
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanup.push(() => server.close());
  const request = async <T>(route: string, body?: unknown) => {
    const response = await fetchWithHubAuth(`${server.url}${route}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as T };
  };
  return { hub, request, requests, stateDir, server };
}

describe("personality HTTP and main-model integration", () => {
  it("exposes disabled daily relationship updates, validates settings, and preserves CAS over HTTP", async () => {
    const f = await fixture();
    const unauthorized = await globalThis.fetch(`${f.server.url}/api/personality`);
    expect(unauthorized.status).toBe(401);
    const initial = await f.request<PersonalitySnapshot>("/api/personality");
    expect(initial.status).toBe(200);
    expect(initial.data.settings.relationshipUpdate).toEqual({ enabled: false, intervalDays: 1 });
    expect(initial.data.settings.recentWorkEnabled).toBe(true);
    await f.hub.personality.checkRelationship();
    expect(f.requests).toHaveLength(0);

    const invalid = await f.request("/api/personality/settings", {
      expectedRevision: initial.data.revision, ...initial.data.settings,
      relationshipUpdate: { ...initial.data.settings.relationshipUpdate, intervalDays: 0 },
    });
    expect(invalid.status).toBe(400);
    const changed = await f.request<PersonalitySnapshot>("/api/personality/settings", {
      expectedRevision: initial.data.revision, ...initial.data.settings,
      relationshipUpdate: { enabled: true, intervalDays: 1 },
    });
    expect(changed.status).toBe(200);
    expect(changed.data.relationshipStatus.nextRunAt).toBeTypeOf("number");
    expect((await f.request("/api/personality/settings", {
      expectedRevision: initial.data.revision, ...initial.data.settings,
    })).status).toBe(409);
  });

  it("keeps a model identity proposal inactive until a confirmed identity document save", async () => {
    const proposed = "# 身份约定\n新的身份表达：自然直接，认真解释。";
    const f = await fixture({ reply: (context) => {
      if (context.messages.some((message) => message.role === "toolResult" && message.toolName === "kulo_identity_propose")) {
        return fauxAssistantMessage([fauxText("请到个性与记忆审阅身份修改。")]);
      }
      if (!tools(context).includes("kulo_identity_propose")) {
        return fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_identity_propose", limit: 3 })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxToolCall("kulo_identity_propose", { content: proposed, summary: "调整默认表达" })], { stopReason: "toolUse" });
    } });
    const initial = (await f.request<IdentityRead>("/api/personality/identity")).data;
    await f.hub.sendUserMessage("请提出身份调整建议。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    const pending = (await f.request<PersonalitySnapshot>("/api/personality")).data.identityProposal;
    expect(pending).toMatchObject({ content: proposed, summary: "调整默认表达", expected: initial.version });
    expect((await f.request<IdentityRead>("/api/personality/identity")).data.content).toBe(initial.content);
    expect(fs.existsSync(path.join(f.stateDir, "identity", "identity-agreement.md"))).toBe(false);
    const payload = { file: "identity-agreement.md", content: pending!.content, expected: pending!.expected, summary: pending!.summary };
    expect((await f.request("/api/identity/save", payload)).status).toBe(400);
    const saved = await f.request<IdentitySaved>("/api/identity/save", { ...payload, dualSignConfirmed: true });
    expect(saved.status).toBe(200);
    expect(saved.data.backupId).toBeTruthy();
    expect((await f.request<IdentityRead>("/api/personality/identity")).data.content).toBe(proposed);
    expect((await f.request("/api/identity/save", { ...payload, content: "过期版本覆盖", dualSignConfirmed: true })).status).toBe(409);
    expect((await f.request("/api/personality/identity/dismiss", { id: pending!.id })).status).toBe(200);
    expect((await f.request<PersonalitySnapshot>("/api/personality")).data.identityProposal).toBeNull();
  });

  it("limits direct relationship writes and rollback to relationship.md", async () => {
    const f = await fixture();
    const identity = (await f.request<IdentityRead>("/api/personality/identity")).data;
    const original = (await f.request<IdentityRead>("/api/identity/file?file=relationship.md")).data;
    const bad = await f.request("/api/personality/relationship", {
      file: "identity-agreement.md", expected: identity.version, content: "绕过身份确认", summary: "越界写入",
    });
    expect(bad.status).toBe(400);
    const first = await f.request<IdentitySaved>("/api/personality/relationship", {
      expected: original.version, content: "称呼：小李。", summary: "用户指定称呼",
    });
    expect(first.status).toBe(200);
    const second = await f.request<IdentitySaved>("/api/personality/relationship", {
      expected: first.data.version, content: "称呼：阿李。", summary: "用户修订称呼",
    });
    expect(second.status).toBe(200);
    expect((await f.request("/api/personality/relationship/rollback", {
      file: "identity-agreement.md", expected: second.data.version, backupId: second.data.backupId, summary: "越界回滚",
    })).status).toBe(400);
    const restored = await f.request<IdentitySaved>("/api/personality/relationship/rollback", {
      expected: second.data.version, backupId: second.data.backupId, summary: "恢复原称呼",
    });
    expect(restored.status).toBe(200);
    expect((await f.request<IdentityRead>("/api/identity/file?file=relationship.md")).data.content).toBe("称呼：小李。");
    expect((await f.request<IdentityRead>("/api/personality/identity")).data.content).toBe(identity.content);
    expect((await f.request("/api/personality/relationship", {
      expected: original.version, content: "过期覆盖", summary: "旧版本",
    })).status).toBe(409);
  });

  it("serves the same current-work snapshot and stops injecting it when disabled", async () => {
    const f = await fixture();
    await f.hub.harness.commit(async (tx) => {
      (await tx.doc(KuloStateDoc)).tickets.t1 = {
        id: "t1", commandId: "t1", title: "验证个性页面", goal: "完成四模块", scope: "本地验证", status: "waiting", role: "checker",
        envId: "local", workspaceDir: "/project", workerConversationId: 200, runEpoch: 1, createdAt: 1, updatedAt: 1,
        waiting: { reason: "user", since: 1, detail: "请确认页面内容" },
      } satisfies TicketRecord;
    }, BACKGROUND_CONTEXT);
    const preview = await f.request<RecentWorkSnapshot>("/api/personality/recent-work");
    expect(preview.status).toBe(200);
    expect(preview.data.content).toContain("请确认页面内容");
    expect((await f.request<RecentWorkSnapshot>("/api/personality/recent-work/refresh", {})).data).toEqual(preview.data);
    await f.hub.sendUserMessage("查看近期工作。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    const active = JSON.stringify(f.requests.at(-1));
    expect(active).toContain(preview.data.content.replace(/\n/g, "\\n"));
    const snapshot = (await f.request<PersonalitySnapshot>("/api/personality")).data;
    expect((await f.request("/api/personality/settings", {
      expectedRevision: snapshot.revision, ...snapshot.settings, recentWorkEnabled: false,
    })).status).toBe(200);
    expect((await f.request<RecentWorkSnapshot>("/api/personality/recent-work")).data).toMatchObject({ enabled: false, content: "" });
    await f.hub.sendUserMessage("继续。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    const systems = f.requests.at(-1)!.messages.filter((message) => message.role === "system");
    const latest = systems.filter((message) => message.sections?.kulo_recent_work !== undefined).at(-1);
    expect(latest?.sections?.kulo_recent_work).toContain("Recent work snapshot injection is disabled");
    expect(latest?.sections?.kulo_recent_work).not.toContain("请确认页面内容");
  });

  it("offers private personality tools to the main brain while keeping them out of Worker requests", async () => {
    const f = await fixture({ localEnv: true, reply: (context) => {
      const names = tools(context);
      if (names.includes("kulo_dispatch")) {
        if (context.messages.some((message) => message.role === "toolResult")) return fauxAssistantMessage([fauxText("已安排验证。")]);
        return fauxAssistantMessage([fauxToolCall("kulo_dispatch", {
          command_id: "personality-worker-check", title: "验证隐私边界", goal: "仅汇报结果", scope: "不读写文件",
        })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "验证完成" })], { stopReason: "toolUse" });
    } });
    await f.hub.sendUserMessage("检查 Worker 的上下文边界。");
    await vi.waitFor(async () => { expect((await f.hub.getBoardSnapshot()).tickets[0]?.status).toBe("ready"); }, { timeout: 10_000, interval: 20 });
    const main = f.requests.find((request) => tools(request).includes("kulo_dispatch"));
    const worker = f.requests.find((request) => tools(request).includes("kulo_report"));
    expect(main).toBeDefined(); expect(worker).toBeDefined();
    const mainAgent = await f.hub.rootConversation.agent(BACKGROUND_CONTEXT);
    expect(mainAgent.deferred.map((t) => t.name)).toContain("kulo_identity_propose");
    expect(mainAgent.deferred.map((t) => t.name)).toContain("kulo_relationship_update");
    const state = (await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    const workerConv = (await f.hub.harness.conversation(Object.values(state.tickets)[0]!.workerConversationId as never, BACKGROUND_CONTEXT))!;
    const workerCallable = (await workerConv.agent(BACKGROUND_CONTEXT)).callable.map((t) => t.name);
    for (const name of ["kulo_identity_propose", "kulo_relationship_update", "kulo_identity_read"]) {
      expect(tools(worker!)).not.toContain(name);
      expect(workerCallable).not.toContain(name);
    }
    expect(JSON.stringify(worker)).not.toContain("kulo_relationship");
  });

  it("collects new timestamped user evidence and reviews it with the configured main model in a tool-free conversation", async () => {
    let checks = 0;
    const f = await fixture({ reply: (context) => {
      if (JSON.stringify(context.messages).includes("You maintain Kulo's Working Relationship file")) {
        checks++;
        return fauxAssistantMessage([fauxText(JSON.stringify({ content: "# 协作关系\n用户明确要求称呼为小陈。", summary: "记录用户指定称呼" }))]);
      }
      return fauxAssistantMessage([fauxText("明白了。")]);
    } });
    const empty = await f.hub.personality.checkRelationship({ force: true });
    expect(empty.relationshipStatus.lastResult).toBe("skipped");
    expect(f.requests).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.hub.sendUserMessage("以后请称呼我小陈。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    const updated = await f.hub.personality.checkRelationship({ force: true });
    expect(updated.relationshipStatus.lastResult).toBe("updated");
    expect(checks).toBe(1);
    const review = f.requests.find((request) => JSON.stringify(request.messages).includes("You maintain Kulo's Working Relationship file"));
    expect(review).toBeDefined();
    expect(tools(review!)).toEqual([]);
    expect(JSON.stringify(review)).toContain("以后请称呼我小陈");
    const current = (await f.request<IdentityRead>("/api/identity/file?file=relationship.md")).data;
    expect(current.content).toContain("小陈");
    const total = f.requests.length;
    expect((await f.hub.personality.checkRelationship({ force: true })).relationshipStatus.lastResult).toBe("skipped");
    expect(f.requests).toHaveLength(total);
    expect(checks).toBe(1);
    expect((await f.request<IdentityRead>("/api/identity/file?file=relationship.md")).data.version).toEqual(current.version);
  });

  it("waits for foreground work to finish before invoking relationship maintenance", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reviews = 0;
    const f = await fixture({ reply: async (context) => {
      if (JSON.stringify(context.messages).includes("You maintain Kulo's Working Relationship file")) {
        reviews++;
        return fauxAssistantMessage([fauxText(JSON.stringify({ content: "# 协作关系\n偏好简洁回复。", summary: "整理明确偏好" }))]);
      }
      await gate;
      return fauxAssistantMessage([fauxText("明白，我会简洁回复。")]);
    } });
    try {
      await f.hub.sendUserMessage("以后请简洁回复。");
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      const busy = await f.hub.personality.checkRelationship({ force: true });
      expect(busy.relationshipStatus.lastCheckedAt).toBeNull();
      expect(reviews).toBe(0);
      expect(f.requests).toHaveLength(1);
      expect((await f.hub.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(0);
      release();
      await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
      const idle = await f.hub.personality.checkRelationship({ force: true });
      expect(idle.relationshipStatus.lastResult).toBe("updated");
      expect(reviews).toBe(1);
    } finally { release(); }
  });

  it("lets the main model defer with current work context and retains evidence for a later review", async () => {
    const reviews: TranscriptContext[] = [];
    const f = await fixture({ reply: (context) => {
      if (JSON.stringify(context.messages).includes("You maintain Kulo's Working Relationship file")) {
        reviews.push(JSON.parse(JSON.stringify(context)) as TranscriptContext);
        return fauxAssistantMessage([fauxText(JSON.stringify(reviews.length === 1
          ? { defer: true, content: null, summary: "等待当前讨论形成结论后再整理" }
          : { content: "# 协作关系\n用户希望先确认方案再实施。", summary: "记录协作习惯" }))]);
      }
      return fauxAssistantMessage([fauxText("我们先确认方案。")]);
    } });
    await f.hub.sendUserMessage("请记住：先确认方案再实施 EVIDENCE_FOR_LATER。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    const before = (await f.request<IdentityRead>("/api/identity/file?file=relationship.md")).data;
    await f.hub.personality.checkRelationship({ force: true });
    expect(reviews).toHaveLength(1);
    expect((await f.hub.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(0);
    expect((await f.request<IdentityRead>("/api/identity/file?file=relationship.md")).data.version).toEqual(before.version);
    const request = reviews[0]!.messages.find((message) => message.role === "user");
    expect(JSON.stringify(request)).toContain("currentActivity");
    expect(JSON.stringify(request)).toContain("foregroundBusy");
    expect(JSON.stringify(request)).toContain("No active or recent tickets in scope");
    const result = await f.hub.personality.checkRelationship({ force: true });
    expect(result.relationshipStatus.lastResult).toBe("updated");
    expect(reviews).toHaveLength(2);
    expect(JSON.stringify(reviews[1])).toContain("EVIDENCE_FOR_LATER");
    expect((await f.hub.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBeGreaterThan(0);
  });

  it("does not lose an answer committed after a review when its generation-start timestamp is older", async () => {
    const reviews: TranscriptContext[] = [];
    const f = await fixture({ reply: (context) => {
      if (JSON.stringify(context.messages).includes("You maintain Kulo's Working Relationship file")) {
        reviews.push(JSON.parse(JSON.stringify(context)) as TranscriptContext);
        return fauxAssistantMessage([fauxText(JSON.stringify({ content: null, summary: "无需更新" }))]);
      }
      return fauxAssistantMessage([fauxText("已经理解当前要求。")]);
    } });
    await f.hub.sendUserMessage("本轮讨论如何协作。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    const first = await f.hub.personality.checkRelationship({ force: true });
    expect(first.relationshipStatus.lastResult).toBe("unchanged");
    expect(reviews).toHaveLength(1);
    const before = await f.hub.rootConversation.entries({}, 1, undefined, BACKGROUND_CONTEXT);
    const late = {
      ...fauxAssistantMessage([fauxText("LATE_ASSISTANT_EVIDENCE：较早开始生成、较晚提交的答复。")]),
      timestamp: first.relationshipStatus.lastCheckedAt! - 60_000,
    };
    const submission = await f.hub.rootConversation.submit({ type: "write", entry: {
      kind: AssistantEntry.kind, model: [late],
    } }, BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
    const after = await f.hub.rootConversation.entries({}, 1, undefined, BACKGROUND_CONTEXT);
    expect(Number(after.items[0]!.id)).toBeGreaterThan(Number(before.items[0]!.id));
    expect(late.timestamp).toBeLessThan(first.relationshipStatus.lastCheckedAt!);

    expect((await f.hub.personality.checkRelationship({ force: true })).relationshipStatus.lastResult).toBe("unchanged");
    expect(reviews).toHaveLength(2);
    expect(JSON.stringify(reviews[1])).toContain("LATE_ASSISTANT_EVIDENCE");
    const requests = f.requests.length;
    expect((await f.hub.personality.checkRelationship({ force: true })).relationshipStatus.lastResult).toBe("skipped");
    expect(f.requests).toHaveLength(requests);
    expect(reviews).toHaveLength(2);
  });

  it("keeps work stable through ordinary chat and manual refresh without extra model calls or history reads", async () => {
    const f = await fixture();
    const initial = (await f.request<RecentWorkSnapshot>("/api/personality/recent-work")).data;
    await f.hub.sendUserMessage("先聊一个新的想法 NEW_CHAT_BACKGROUND。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    await f.hub.sendUserMessage("这里没有新增或修改任何任务。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await f.request<RecentWorkSnapshot>("/api/personality/recent-work")).data).toEqual(initial);
    expect(f.requests).toHaveLength(2);
    const history = vi.spyOn(f.hub.harness, "conversation");
    const refreshed = await f.request<RecentWorkSnapshot>("/api/personality/recent-work/refresh", {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.data).toEqual(initial);
    expect(refreshed.data.content).not.toContain("NEW_CHAT_BACKGROUND");
    expect(history).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(2);
    history.mockRestore();
    await f.hub.sendUserMessage("继续普通聊天，不变更工作状态。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await f.request<RecentWorkSnapshot>("/api/personality/recent-work")).data).toEqual(refreshed.data);
    const sections = f.requests.at(-1)!.messages.filter((message) => message.role === "system" && message.sections?.kulo_recent_work !== undefined);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.sections?.kulo_recent_work).toBe(`<kulo_recent_work>\n${initial.content}\n</kulo_recent_work>`);
    expect(f.requests).toHaveLength(3);
  });

  it("reads changed committed work without history scans and injects the same bounded preview", async () => {
    const f = await fixture();
    const history = vi.spyOn(f.hub.harness, "conversation");
    const initial = (await f.request<RecentWorkSnapshot>("/api/personality/recent-work")).data;
    await f.hub.harness.commit(async (tx) => {
      (await tx.doc(KuloStateDoc)).tickets.t1 = {
        id: "t1", commandId: "t1", title: "工作状态更新", goal: "完成工作", scope: "本地", status: "waiting", role: "checker",
        envId: "local", workspaceDir: "/project", workerConversationId: 200, runEpoch: 1, createdAt: 1, updatedAt: 1,
        waiting: { reason: "user", since: 1, detail: "等待确认" },
      } satisfies TicketRecord;
    }, BACKGROUND_CONTEXT);
    const updated = (await f.request<RecentWorkSnapshot>("/api/personality/recent-work")).data;
    expect(updated.revision).not.toBe(initial.revision);
    expect(updated.content).toContain("等待确认");
    expect(updated.content.length).toBeLessThanOrEqual(1200);
    expect(history).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
    history.mockRestore();
    await f.hub.sendUserMessage("查看近期工作。");
    await f.hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(f.requests).toHaveLength(1);
    const sections = f.requests[0]!.messages.filter((message) => message.role === "system" && message.sections?.kulo_recent_work !== undefined);
    expect(sections.at(-1)?.sections?.kulo_recent_work).toBe(`<kulo_recent_work>\n${updated.content}\n</kulo_recent_work>`);
  });

  it("counts cache writes in input totals and separates identical model names from different providers", async () => {
    const f = await fixture();
    for (const usage of [
      { provider: "provider-a", input: 10, cacheRead: 60, cacheWrite: 30, output: 5 },
      { provider: "provider-b", input: 20, cacheRead: 10, cacheWrite: 70, output: 2 },
    ]) {
      const message = {
        ...fauxAssistantMessage([fauxText("统计样本。")]),
        provider: usage.provider, model: "same-model-name", timestamp: Date.now(),
        usage: {
          input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output,
          totalTokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const submission = await f.hub.rootConversation.submit({ type: "write", entry: {
        kind: AssistantEntry.kind, model: [message],
      } }, BACKGROUND_CONTEXT);
      await submission.wait(BACKGROUND_CONTEXT);
    }
    const response = await f.request<UsageStatsView>("/api/usage?range=today");
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ totalTokens: 207, turns: 2 });
    expect(response.data.cacheHitRate).toBeCloseTo(0.35);
    expect(response.data.models).toHaveLength(2);
    expect(response.data.models.find((model) => model.provider === "provider-a")).toMatchObject({
      model: "same-model-name", provider: "provider-a", inputTokens: 100,
      cacheReadTokens: 60, cacheWriteTokens: 30, cacheHitRate: 0.6, totalTokens: 105, turns: 1,
    });
    expect(response.data.models.find((model) => model.provider === "provider-b")).toMatchObject({
      model: "same-model-name", provider: "provider-b", inputTokens: 100,
      cacheReadTokens: 10, cacheWriteTokens: 70, cacheHitRate: 0.1, totalTokens: 102, turns: 1,
    });
    expect(f.requests).toHaveLength(0);
  });
});
