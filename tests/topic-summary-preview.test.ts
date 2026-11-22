import { describe, expect, it } from "vitest";
import type { TopicSummary } from "@kulo/protocol";
import { applyTopicPreview, summarizeTopicPreview } from "../packages/hub/src/state.js";

describe("summarizeTopicPreview", () => {
  it("extracts cleaned single-line preview from latest assistant or user message", () => {
    const result = summarizeTopicPreview([
      { role: "user", text: "Hello", createdAt: 1000 },
      { role: "system_note", text: "ignored internal note", createdAt: 1500 },
      { role: "assistant", text: "### Morning Briefing\n- Build **passed** with `0` warnings.", createdAt: 2000 },
    ]);
    expect(result).toEqual({
      preview: "Morning Briefing - Build passed with 0 warnings.",
      at: 2000,
    });
  });

  it("replaces fenced code blocks and truncates long text cleanly", () => {
    const long = "A".repeat(200);
    const result = summarizeTopicPreview([
      { role: "assistant", text: "```ts\nconst x = 1;\n```\n" + long, createdAt: 3000 },
    ], 40);
    expect(result?.preview.startsWith("[code] A")).toBe(true);
    expect(result?.preview.endsWith("…")).toBe(true);
    expect(result?.preview.length).toBeLessThanOrEqual(40);
    expect(result?.at).toBe(3000);
  });

  it("returns undefined when no visible message has non-empty text", () => {
    expect(summarizeTopicPreview([{ role: "system_note", text: "note" }])).toBeUndefined();
    expect(summarizeTopicPreview([{ role: "dispatch", text: "后台任务" }])).toBeUndefined();
    expect(summarizeTopicPreview([])).toBeUndefined();
  });

  it("applies preview monotonically without mutating updatedAt", () => {
    const topic: TopicSummary = { id: "topic-1", conversationId: 1, title: "Demo", createdAt: 100, updatedAt: 100 };
    expect(applyTopicPreview(topic, undefined, 200)).toBe(false);
    expect(applyTopicPreview(topic, { preview: "Hello", at: 150 }, 200)).toBe(true);
    expect(topic).toMatchObject({ updatedAt: 100, lastMessagePreview: "Hello", lastMessageAt: 150 });
    expect(applyTopicPreview(topic, { preview: "Hello", at: 150 }, 200)).toBe(false);
    expect(applyTopicPreview(topic, { preview: "Reply", at: 140 }, 200)).toBe(true);
    expect(topic).toMatchObject({ updatedAt: 100, lastMessagePreview: "Reply", lastMessageAt: 150 });
  });
});
