import { describe, expect, it } from "vitest";
import {
  isMacOsSensitiveBundleId,
  isSensitiveNotificationPayload,
  type ChatDisplayItem,
  type LiveStreamState,
  type UiCardSnapshot,
} from "@kulo/protocol";
import {
  createTopicNotificationBaseline,
  detectMainSessionNotification,
} from "../packages/hub/src/session-notifications.js";

const idle: LiveStreamState = { busy: false, activeTools: [], queuedCount: 0 };
const busy: LiveStreamState = { busy: true, activeTools: [], queuedCount: 0 };

function assistantMsg(id: number, text: string, extra: Partial<ChatDisplayItem> = {}): ChatDisplayItem {
  return { id, role: "assistant", text, ...extra };
}

function dispatchMsg(id: number, responseId: number, ticketId = "T-1"): ChatDisplayItem {
  return {
    id,
    role: "dispatch",
    text: "修复登录问题",
    responseId,
    dispatch: { actionLabel: "派发任务", ticketId, title: "修复登录问题" },
  };
}

function pendingCard(cardId: string, title = "确认执行命令"): UiCardSnapshot {
  return {
    cardId,
    schemaVersion: 1,
    catalogVersion: 3,
    title,
    status: "ready",
    revision: 1,
    spec: { root: "root", elements: { root: { type: "Card", props: { title } } } },
    actions: [{ id: "confirm", label: "确认", kind: "submit" }],
    committedState: {},
    originConversationId: 1,
  };
}

describe("main-session notification detection", () => {
  it("stays silent on baseline hydration and emits reply_completed when the main agent finishes a user-facing reply", () => {
    const initialMessages = [assistantMsg(10, "历史回复", { responseId: 1 })];
    const baseline = createTopicNotificationBaseline(initialMessages, idle);

    // Re-evaluating unchanged state emits nothing
    const unchanged = detectMainSessionNotification({
      topicId: "root",
      previous: baseline,
      messages: initialMessages,
      live: idle,
    });
    expect(unchanged.event).toBeNull();

    // Streaming while busy stays silent
    const streaming = detectMainSessionNotification({
      topicId: "root",
      previous: unchanged.next,
      messages: [...initialMessages, assistantMsg(12, "正在整理…", { responseId: 2 })],
      live: busy,
    });
    expect(streaming.event).toBeNull();

    // Settled turn emits reply_completed
    const settled = detectMainSessionNotification({
      topicId: "root",
      previous: streaming.next,
      messages: [...initialMessages, assistantMsg(12, "全部修改已完成。", { responseId: 2 })],
      live: idle,
      now: 1234,
      createId: () => "evt-reply-1",
    });
    expect(settled.event).toEqual({
      id: "evt-reply-1",
      kind: "reply_completed",
      topicId: "root",
      summary: "全部修改已完成。",
      createdAt: 1234,
    });
  });

  it("extracts concise single-line summaries from markdown replies, strips filler openings, and redacts secrets", () => {
    const baseline = createTopicNotificationBaseline([], idle);
    const messages = [
      assistantMsg(10, "好的，**MacMini** 这边的实测也全部通过了：\n\n- 浏览器自动化：打开 `bilibili.com` 成功\n- 密钥 sk-secret-999", { responseId: 10 }),
    ];
    const result = detectMainSessionNotification({
      topicId: "root",
      previous: baseline,
      messages,
      live: idle,
      now: 2000,
      createId: () => "evt-md",
      redact: (text) => text.replaceAll("sk-secret-999", "[REDACTED]"),
    });
    expect(result.event).toEqual({
      id: "evt-md",
      kind: "reply_completed",
      topicId: "root",
      summary: "MacMini 这边的实测也全部通过了",
      createdAt: 2000,
    });

    const attachmentOnly = detectMainSessionNotification({
      topicId: "root",
      previous: result.next,
      messages: [
        ...messages,
        assistantMsg(11, "", {
          responseId: 11,
          attachments: [{ id: "att-1", name: "report.pdf", kind: "file", mimeType: "application/pdf", size: 100 }],
        }),
      ],
      live: idle,
      now: 2001,
      createId: () => "evt-att",
    });
    expect(attachmentOnly.event?.summary).toBe("已发送 report.pdf");
  });

  it("does NOT notify when the main agent only dispatches a worker or finishes silently without replying to the user", () => {
    const baseline = createTopicNotificationBaseline([], idle);

    // Turn 1: Main agent dispatches a background worker and posts a dispatch ack in the same responseId
    const dispatchTurnMessages: ChatDisplayItem[] = [
      dispatchMsg(20, 100, "T-1"),
      assistantMsg(21, "已安排后台开发任务处理。", { responseId: 100 }),
    ];
    const afterDispatch = detectMainSessionNotification({
      topicId: "topic_work",
      topicTitle: "重构登录模块",
      previous: baseline,
      messages: dispatchTurnMessages,
      live: idle,
    });
    expect(afterDispatch.event).toBeNull();

    // Turn 2: Worker hands in report -> main agent inspects silently (toolCalls only, text: "", [COORDINATOR_OK] stripped)
    const silentCoordinatorMessages: ChatDisplayItem[] = [
      ...dispatchTurnMessages,
      assistantMsg(25, "", {
        responseId: 101,
        toolCalls: [{ id: "call-1", name: "kulo_inspect", argsSummary: "{}" }],
      }),
    ];
    const afterSilentInspect = detectMainSessionNotification({
      topicId: "topic_work",
      topicTitle: "重构登录模块",
      previous: afterDispatch.next,
      messages: silentCoordinatorMessages,
      live: idle,
    });
    expect(afterSilentInspect.event).toBeNull();

    // Turn 3: Worker finishes and main agent decides to reply to the user in a new responseId
    const finalReplyMessages: ChatDisplayItem[] = [
      ...silentCoordinatorMessages,
      assistantMsg(30, "登录模块重构已完成并通过全部测试。", { responseId: 102 }),
    ];
    const afterFinalReply = detectMainSessionNotification({
      topicId: "topic_work",
      topicTitle: "重构登录模块",
      previous: afterSilentInspect.next,
      messages: finalReplyMessages,
      live: idle,
      now: 5678,
      createId: () => "evt-final",
    });
    expect(afterFinalReply.event).toEqual({
      id: "evt-final",
      kind: "reply_completed",
      topicId: "topic_work",
      topicTitle: "重构登录模块",
      summary: "登录模块重构已完成并通过全部测试。",
      createdAt: 5678,
    });
  });

  it("notifies with attention_required when a pending confirmation card appears and redacts sensitive text", () => {
    const baseline = createTopicNotificationBaseline([], idle);
    const messages: ChatDisplayItem[] = [
      dispatchMsg(40, 200, "T-2"),
      assistantMsg(41, "请确认是否合并变更。", {
        responseId: 200,
        parts: [
          { partId: "p1", type: "markdown", text: "请确认是否合并变更。" },
          { partId: "p2", type: "ui", cardId: "card-1", fallbackText: "确认", card: pendingCard("card-1", "合并变更 sk-secret-123") },
        ],
      }),
    ];

    const result = detectMainSessionNotification({
      topicId: "topic_sec",
      topicTitle: "发布 sk-secret-123",
      previous: baseline,
      messages,
      live: idle,
      now: 9000,
      createId: () => "evt-card",
      redact: (text) => text.replaceAll("sk-secret-123", "[REDACTED]"),
    });
    expect(result.event).toEqual({
      id: "evt-card",
      kind: "attention_required",
      topicId: "topic_sec",
      topicTitle: "发布 [REDACTED]",
      summary: "合并变更 [REDACTED]",
      createdAt: 9000,
    });
  });

  it("notifies on non-abort run failures and stays silent when the user explicitly stopped generation", () => {
    const baseline = createTopicNotificationBaseline([], idle);

    const aborted = detectMainSessionNotification({
      topicId: "root",
      previous: baseline,
      messages: [],
      live: { ...idle, runFailure: { taskId: 1, reason: "aborted" } },
    });
    expect(aborted.event).toBeNull();

    const failed = detectMainSessionNotification({
      topicId: "root",
      previous: aborted.next,
      messages: [],
      live: { ...idle, runFailure: { taskId: 2, reason: "rate_limit", detail: "429" } },
      now: 9999,
      createId: () => "evt-fail",
    });
    expect(failed.event).toEqual({
      id: "evt-fail",
      kind: "run_failed",
      topicId: "root",
      summary: expect.any(String),
      createdAt: 9999,
    });
    expect(failed.event?.summary?.length).toBeGreaterThan(0);

    // Same failure stays deduplicated
    const repeated = detectMainSessionNotification({
      topicId: "root",
      previous: failed.next,
      messages: [],
      live: { ...idle, runFailure: { taskId: 2, reason: "rate_limit", detail: "429" } },
    });
    expect(repeated.event).toBeNull();
  });

  it("excludes Kulo desktop bundle IDs from macOS notification sensor ingestion to prevent feedback loops", () => {
    for (const bundleId of ["io.kulo.desktop", "io.kulo.desktop.dev", "io.kulo.app", "io.moco.desktop.dev"]) {
      expect(isMacOsSensitiveBundleId(bundleId)).toBe(true);
      expect(isSensitiveNotificationPayload({ appId: bundleId, title: "回复已完成", body: "主会话" })).toBe(true);
    }
    expect(isMacOsSensitiveBundleId("com.tencent.xinWeChat")).toBe(false);
  });
});
