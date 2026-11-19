import { describe, expect, it } from "vitest";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { redactSensitiveText } from "@kulo/protocol";
import { extractDisplayMessages } from "../packages/hub/src/hub.js";

const entry = (id: number, kind: string, model: unknown) => ({ id, kind, conversationId: 1, model: [model] }) as unknown as EntryRecord;
const call = (id: number, callId: string, name = "bash", args: Record<string, unknown> = { command: "pwd" }) => entry(id, "pi.assistant", {
  role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: 1000 + id,
});
const result = (id: number, callId: string, text: string, isError = false, name = "bash") => entry(id, "pi.tool-result", {
  role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError, timestamp: 1000 + id,
});
const answer = (id: number, text = "已安排开发者执行。") => entry(id, "pi.assistant", { role: "assistant", content: [{ type: "text", text }], timestamp: 1000 + id });
const dispatch = (id: number, ticketId: string) => result(id, `dispatch-${id}`, JSON.stringify({ ticket: { id: ticketId, title: ticketId } }), false, "kulo_dispatch");

describe("task transcript projection", () => {
  it("keeps multiple dispatches before their acknowledgement without changing event times", () => {
    const messages = extractDisplayMessages([dispatch(10, "T-1"), dispatch(11, "T-2"), answer(12)]);
    expect(messages.map((item) => [item.id, item.role, item.createdAt])).toEqual([
      [10, "dispatch", 1010], [11, "dispatch", 1011], [12, "assistant", 1012],
    ]);
  });

  it("associates out-of-order results by call ID and preserves tool-only records", () => {
    const messages = extractDisplayMessages([
      call(1, "first"), call(2, "second"), result(3, "second", "Command failed", true), result(4, "first", "/workspace"), answer(5, "已检查目录。"),
    ], { includeToolResults: true });
    expect(messages.map((item) => item.id)).toEqual([1, 2, 5]);
    expect(messages[0]).toMatchObject({ text: "", toolCalls: [{ id: "first", name: "bash", argsSummary: '{"command":"pwd"}', result: { text: "/workspace", isError: false, createdAt: 1004 } }] });
    expect(messages[1]?.toolCalls?.[0]?.result).toEqual({ text: "Command failed", isError: true, createdAt: 1003 });
  });

  it("does not add tool output to ordinary chat or invent completion for a pending call", () => {
    const entries = [call(1, "done"), result(2, "done", "raw tool output"), call(3, "pending")];
    const ordinary = extractDisplayMessages(entries);
    expect(ordinary.every((item) => item.toolCalls?.every((tool) => tool.result === undefined))).toBe(true);
    const inspected = extractDisplayMessages(entries, { includeToolResults: true });
    expect(inspected[0]?.toolCalls?.[0]?.result?.isError).toBe(false);
    expect(inspected[1]?.toolCalls?.[0]?.result).toBeUndefined();
  });

  it("does not attach an unrelated result with a different tool name", () => {
    const messages = extractDisplayMessages([call(1, "same-id"), result(2, "same-id", "other tool", false, "read")], { includeToolResults: true });
    expect(messages[0]?.toolCalls?.[0]?.result).toBeUndefined();
  });

  it("bounds individual and combined tool output while retaining each outcome", () => {
    const entries = Array.from({ length: 10 }, (_, index) => [call(index * 2 + 1, String(index)), result(index * 2 + 2, String(index), "line\n".repeat(1000), index === 9)]).flat();
    const tools = extractDisplayMessages(entries, { includeToolResults: true }).flatMap((item) => item.toolCalls ?? []);
    expect(tools).toHaveLength(10);
    expect(tools.every((tool) => tool.result!.text.length <= 4096 && tool.result!.truncated)).toBe(true);
    expect(tools.reduce((sum, tool) => sum + tool.result!.text.length, 0)).toBeLessThanOrEqual(32_768);
    expect(tools.at(-1)?.result).toEqual({ text: "", isError: true, createdAt: 1020, truncated: true });
  });

  it("redacts known credentials before cutting arguments or outputs through their value", () => {
    const syntheticCredential = "synthetic-task-inspector-credential-0123456789";
    const messages = extractDisplayMessages([
      call(1, "protected", "bash", { token: syntheticCredential, command: "x".repeat(105) + syntheticCredential }),
      result(2, "protected", "x".repeat(4090) + syntheticCredential),
    ], { includeToolResults: true, redactToolText: (text) => redactSensitiveText(text, [syntheticCredential]) });
    const tool = messages[0]!.toolCalls![0]!;
    expect(tool.argsSummary).toContain("[已隐藏]");
    expect(JSON.stringify(messages)).not.toContain("synthetic-task-inspector");
    expect(tool.result?.text).toContain("[已隐藏]");
  });

  it("keeps nontext tool results complete without fabricating text", () => {
    const output = entry(2, "pi.tool-result", { role: "toolResult", toolCallId: "image", toolName: "read", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], isError: false, timestamp: 1002 });
    const messages = extractDisplayMessages([call(1, "image", "read"), output], { includeToolResults: true });
    expect(messages[0]?.toolCalls?.[0]?.result).toEqual({ text: "", isError: false, createdAt: 1002 });
    expect(JSON.stringify(messages)).not.toContain("AA==");
  });

  it("derives a short redacted action from actual arguments even when file contents precede the path", () => {
    const syntheticCredential = "synthetic-action-summary-credential-0123456789";
    const messages = extractDisplayMessages([
      call(1, "write-page", "write", { content: "<html>".repeat(500), path: "/workspace/index.html" }),
      call(2, "protected-action", "bash", { command: `\n  echo ${syntheticCredential}\nsecond command`, path: "/unused" }),
      call(3, "unknown-action", "custom", { contents: "has no recognized action" }),
      call(4, "long-action", "read", { command: " ", file_path: "a".repeat(200) }),
    ], { includeToolResults: true, redactToolText: (text) => redactSensitiveText(text, [syntheticCredential]) });
    expect(messages[0]?.toolCalls?.[0]).toMatchObject({ actionSummary: "/workspace/index.html" });
    expect(messages[0]?.toolCalls?.[0]?.argsSummary).not.toContain("/workspace/index.html");
    expect(messages[1]?.toolCalls?.[0]?.actionSummary).toBe("echo [已隐藏]");
    expect(messages[2]?.toolCalls?.[0]?.actionSummary).toBeUndefined();
    expect(messages[3]?.toolCalls?.[0]?.actionSummary).toHaveLength(140);
    expect(JSON.stringify(messages)).not.toContain(syntheticCredential);
  });
});
