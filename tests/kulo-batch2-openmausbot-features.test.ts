import { describe, expect, it, vi } from "vitest";
import { prepareSpeechText } from "../packages/hub/src/voice-speech-text.js";
import {
  checkRelationshipAntiWipe,
  findMatchingForgottenTerm,
  matchesForgottenTerm,
  stripForgottenLinesFromMarkdown,
  validateRelationshipReviewDecision,
} from "../packages/hub/src/memory-forget.js";
import {
  computeCapDeferredDueAt,
  isLoopbackBaseUrl,
  KuloUsageCaps,
  UsageLedgerDoc,
  withUsageMeterModels,
} from "../packages/hub/src/usage-caps.js";
import { AssistantSorter } from "../packages/hub/src/assistant-sorter.js";
import { AssistantLedger } from "../packages/hub/src/assistant-ledger.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Batch 2 #2: TTS Markdown-to-spoken-text sanitizer", () => {
  it("replaces kulo-card, diagram/mermaid, and generic fenced code blocks cleanly without protocol jargon", () => {
    const raw = [
      "## 总结",
      "下面是卡片和图表：",
      "```kulo-card",
      '{"type":"Card","props":{"title":"SecretProtocol"}}',
      "```",
      "```kulo-diagram",
      "flowchart LR; A-->B;",
      "```",
      "```ts",
      "const x = 1;".repeat(800),
      "```",
      "请查看 [项目文档](https://example.com/docs/guide)。",
    ].join("\n");

    const spoken = prepareSpeechText(raw, 8_000);
    expect(spoken).toContain("总结");
    expect(spoken).toContain("这里有一张交互卡片");
    expect(spoken).toContain("这里有一张图表");
    expect(spoken).toContain("此处省略一段代码");
    expect(spoken).toContain("项目文档");
    expect(spoken).not.toContain("kulo-card");
    expect(spoken).not.toContain("SecretProtocol");
    expect(spoken).not.toContain("https://example.com");
    expect(spoken.length).toBeLessThanOrEqual(8_000);
  });

  it("preserves currency amounts ($10 到 $50) and dates (2026/11/22) while cleaning LaTeX and long file paths", () => {
    const raw = "价格在 $10 到 $50 之间，日期是 2026/11/22，速度 80 km/h。公式 $a + b$ 已更新在 packages/hub/src/voice-speech-text.ts。";
    const spoken = prepareSpeechText(raw);
    expect(spoken).toContain("$10");
    expect(spoken).toContain("$50");
    expect(spoken).toContain("2026/11/22");
    expect(spoken).toContain("km/h");
    expect(spoken).toContain("a + b");
    expect(spoken).toContain("voice-speech-text.ts");
    expect(spoken).not.toContain("packages/hub/src/");
  });

  it("returns empty string when content has no speakable letters or digits", () => {
    expect(prepareSpeechText("   --- *** === \n\n !!!   ")).toBe("");
  });

  it("truncates oversized prose cleanly at sentence boundaries <= maxChars", () => {
    const sentence = "这是一个完整的测试句子。";
    const raw = sentence.repeat(100);
    const spoken = prepareSpeechText(raw, 120);
    expect(spoken.length).toBeLessThanOrEqual(120);
    expect(spoken.endsWith("。")).toBe(true);
  });
});

describe("Batch 2 #5: memory forget tombstones & relaxed anti-wipe guard", () => {
  it("uses ASCII word boundary matching for English terms and substring matching for Chinese", () => {
    expect(matchesForgottenTerm("User owns a cat at home.", "cat")).toBe(true);
    expect(matchesForgottenTerm("Category settings were updated.", "cat")).toBe(false);
    expect(matchesForgottenTerm("用户以前喜欢喝美式咖啡", "美式咖啡")).toBe(true);
    expect(matchesForgottenTerm("用户喜欢喝拿铁", "美式咖啡")).toBe(false);
  });

  it("strips matching non-heading lines from relationship.md while preserving structure", () => {
    const md = [
      "# 协作关系",
      "- 偏好简洁中文回复",
      "- 之前提过喜欢吃香菜",
      "- 早上 9 点看日程",
      "",
    ].join("\n");
    const { content, removedLines } = stripForgottenLinesFromMarkdown(md, "香菜");
    expect(removedLines).toBe(1);
    expect(content).toContain("# 协作关系");
    expect(content).toContain("偏好简洁中文回复");
    expect(content).not.toContain("香菜");
  });

  it("triggers anti-wipe guard ONLY on substantial documents (>=8 lines, >50% missing, <60% length) and never returns defer:true", () => {
    // Short 4-line doc: normal consolidation must NOT trigger anti-wipe
    const shortPrev = ["- 偏好中文", "- 简洁回复", "- 周五汇总", "- 用 pnpm"].join("\n");
    const shortNext = "- 偏好简洁中文回复，用 pnpm";
    expect(checkRelationshipAntiWipe(shortPrev, shortNext).blocked).toBe(false);

    // Rich 10-line doc wiped down to 1 line: MUST trigger skipReason (NOT defer: true!)
    const richPrev = [
      "# 协作关系",
      "- 偏好简洁中文回复，避免多余客套话",
      "- 代码仓库统一使用 pnpm 与 TypeScript strict 模式",
      "- 每周五下午汇总本周项目进展与未决风险",
      "- 修改生产配置前必须先给出变更影响清单",
      "- 界面遵循极简克制原则，禁止多余注释",
      "- 桌面应用构建必须使用 Developer ID 签名",
      "- 邮件草稿默认使用专业简洁语气",
      "- 优先使用本机模型处理低优先级通知",
      "- 讨论架构方案时先给结论和权衡表",
    ].join("\n");
    const wipedNext = "# 协作关系\n- 偏好中文回复\n";
    expect(checkRelationshipAntiWipe(richPrev, wipedNext).blocked).toBe(true);

    const decision = validateRelationshipReviewDecision(
      JSON.stringify({ content: wipedNext, summary: "精简重写" }),
      richPrev,
      [],
    );
    expect(decision.content).toBeNull();
    expect(decision.defer).toBeUndefined();
    expect(decision.skipReason).toContain("大幅删减");
  });

  it("strips forgotten terms from LLM review outputs before saving", () => {
    const terms = [{ term: "前公司", normalized: "前公司", addedAt: Date.now() }];
    const decision = validateRelationshipReviewDecision(
      JSON.stringify({
        content: "# 协作关系\n- 偏好简洁中文\n- 曾在前公司做后端\n",
        summary: "更新背景",
      }),
      "# 协作关系\n- 偏好简洁中文\n",
      terms,
    );
    expect(decision.content).toContain("偏好简洁中文");
    expect(decision.content).not.toContain("前公司");
    expect(findMatchingForgottenTerm("提到前公司的项目", terms)?.term).toBe("前公司");
  });
});

describe("Batch 2 #6: unattended background usage caps & HA security hard-exempt", () => {
  function makeMemoryHarness() {
    let doc = UsageLedgerDoc.definition.initial();
    const commits: number[] = [];
    const harness = {
      snapshot: vi.fn(async () => JSON.parse(JSON.stringify(doc))),
      commit: vi.fn(async (fn: (tx: { doc: () => Promise<typeof doc> }) => Promise<unknown>) => {
        commits.push(Date.now());
        await fn({ doc: async () => doc });
      }),
    };
    return { harness, commits, getDoc: () => doc };
  }

  it("recognizes loopback baseUrls as local-free and meters cloud stream/complete calls accurately", async () => {
    expect(isLoopbackBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackBaseUrl("http://localhost:18741/v1")).toBe(true);
    expect(isLoopbackBaseUrl("http://[::1]:1234/v1")).toBe(true);
    expect(isLoopbackBaseUrl("https://api.openai.com/v1")).toBe(false);

    const { harness, commits } = makeMemoryHarness();
    const caps = new KuloUsageCaps({ harness: harness as never });
    await caps.start();
    await caps.updateConfig(1, {
      enabled: true,
      dailyTokenLimit: 1000,
      weeklyTokenLimit: null,
      dailyCostUsdLimit: null,
      weeklyCostUsdLimit: null,
      scope: "all_background",
    });
    const commitsAfterConfig = commits.length;

    const fakeBaseModels = {
      completeSimple: vi.fn(async () => ({
        role: "assistant",
        content: [],
        usage: { input: 300, output: 200, totalTokens: 500, cost: { total: 0.01 } },
      })),
      streamSimple: vi.fn(() => ({
        result: async () => ({
          role: "assistant",
          content: [],
          usage: { input: 400, output: 200, totalTokens: 600, cost: { total: 0.02 } },
        }),
      })),
    };
    const metered = withUsageMeterModels(fakeBaseModels as never, () => caps);

    // Local loopback model call must NOT count toward cloud cap
    await metered.completeSimple({ baseUrl: "http://127.0.0.1:11434/v1", id: "qwen" } as never, {} as never, {} as never);
    expect(caps.snapshot().today.totalTokens).toBe(0);
    expect(caps.isCappedFor("schedule").capped).toBe(false);

    // Cloud completeSimple (500 tokens -> 50% of 1000 cap, debounced -> no immediate commit)
    await metered.completeSimple({ baseUrl: "https://api.openai.com/v1", id: "gpt-5" } as never, {} as never, {} as never);
    expect(caps.snapshot().today.totalTokens).toBe(500);
    expect(commits.length).toBe(commitsAfterConfig);
    expect(caps.isCappedFor("schedule").capped).toBe(false);

    // Cloud streamSimple (+600 = 1100 tokens -> crosses 100% -> triggers immediate flush & caps!)
    const stream = metered.streamSimple({ baseUrl: "https://api.anthropic.com/v1", id: "claude" } as never, {} as never, {} as never);
    await stream.result();
    await vi.waitFor(() => expect(caps.snapshot().today.totalTokens).toBe(1100));
    expect(caps.isCappedFor("schedule").capped).toBe(true);
    expect(caps.isCappedFor("assistant").capped).toBe(true);
    expect(caps.isCappedFor("personality").capped).toBe(true);
    expect(caps.snapshot().capReason).toBe("daily_tokens");
    expect(commits.length).toBeGreaterThan(commitsAfterConfig);

    // Scope isolation: schedules_only must not cap assistant/personality
    await caps.updateConfig(2, {
      enabled: true,
      dailyTokenLimit: 1000,
      weeklyTokenLimit: null,
      dailyCostUsdLimit: null,
      weeklyCostUsdLimit: null,
      scope: "schedules_only",
    });
    expect(caps.isCappedFor("schedule").capped).toBe(true);
    expect(caps.isCappedFor("assistant").capped).toBe(false);
    expect(caps.isCappedFor("personality").capped).toBe(false);

    const deferred = computeCapDeferredDueAt(
      { schedule: { repeatEverySeconds: 3600, anchorAt: 1_000_000 } },
      1_000_000 + 86_400_000,
      1_000_000 + 1000,
    );
    expect(deferred).toBeGreaterThanOrEqual(1_000_000 + 86_400_000);
    await caps.close();
  });

  it("hard-exempts Home Assistant security alerts in AssistantSorter even when usage-capped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-b2-ha-"));
    try {
      const ledger = new AssistantLedger({ stateDir: dir });
      const escalated: Array<{ appId: string; urgency: string; category: string }> = [];
      const completeZeroToolJson = vi.fn(async () => "{}");
      const sorter = new AssistantSorter({
        ledger,
        ambientModel: { completeZeroToolJson } as never,
        redact: (s) => s,
        shouldSkipCloudModel: async () => true,
        coalesceWindowMs: 10,
        maxCoalesceMs: 20,
        onNotifyBrain: ({ digest }) => {
          escalated.push({ appId: digest.appId, urgency: digest.urgency, category: digest.category });
        },
      });

      // Normal app notification -> archived silently without LLM call
      sorter.enqueue([
        {
          id: "ev-normal",
          appId: "com.apple.mail",
          appLabel: "Mail",
          title: "Newsletter",
          body: "Weekly digest",
          occurredAt: Date.now(),
          receivedAt: Date.now(),
          envId: "local",
        },
      ]);
      // Home Assistant security alert -> MUST bypass cap & escalate straight to brain!
      sorter.enqueue([
        {
          id: "ev-ha",
          appId: "home-assistant",
          appLabel: "Home Assistant",
          title: "厨房烟雾报警器触发",
          body: "检测到烟雾",
          occurredAt: Date.now(),
          receivedAt: Date.now(),
          envId: "local",
        },
      ]);
      await sorter.flushAll();

      await vi.waitFor(() => expect(escalated.length).toBe(1));
      expect(escalated[0]).toEqual({ appId: "home-assistant", urgency: "high", category: "security" });
      expect(completeZeroToolJson).not.toHaveBeenCalled();

      await sorter.close();
      await ledger.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
