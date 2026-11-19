import { describe, expect, it } from "vitest";
import { composerDraftKey, resolveTaskChatReturn, restoreComposerDraft, restoredChatScroll } from "./task-navigation";

describe("task conversation context", () => {
  it("keeps one task draft across source-chat navigation without sharing a chat bucket", () => {
    const originalChat = composerDraftKey("conversation-one");
    const otherChat = composerDraftKey("conversation-two");
    const taskFromOriginal = composerDraftKey("conversation-one", "task-one");
    const taskFromOther = composerDraftKey("conversation-two", "task-one");
    expect(taskFromOriginal).toBe(taskFromOther);
    expect(new Set([originalChat, otherChat, taskFromOriginal]).size).toBe(3);
    expect(composerDraftKey("task-one")).not.toBe(taskFromOriginal);
  });

  it("restores a rejected task message beside new typing while preserving both chats and other tasks", () => {
    const chat = composerDraftKey("conversation-one");
    const task = composerDraftKey("conversation-one", "task-one");
    const otherTask = composerDraftKey("conversation-one", "task-two");
    const drafts = { [chat]: "原聊天草稿", [task]: "刚输入的补充", [otherTask]: "另一项任务的草稿" };
    const restored = restoreComposerDraft(drafts, task, "未被接收的指令");
    expect(restored[task]).toBe("未被接收的指令\n刚输入的补充");
    expect(restored[chat]).toBe("原聊天草稿");
    expect(restored[otherTask]).toBe("另一项任务的草稿");
    expect(drafts[task]).toBe("刚输入的补充");
  });

  it("recovers a closed-task follow-up into its origin chat without changing the browsing chat", () => {
    const browsingChat = composerDraftKey("currently-open");
    const originChat = composerDraftKey("task-origin");
    const recovered = restoreComposerDraft({ [browsingChat]: "继续原来的聊天" }, originChat, "[关于任务「已关闭的任务」]\n请再检查一次");
    expect(recovered[browsingChat]).toBe("继续原来的聊天");
    expect(recovered[originChat]).toBe("[关于任务「已关闭的任务」]\n请再检查一次");
  });
});

describe("returning from task details", () => {
  it("restores a captured position only for an explicit Back request and consumes it once", () => {
    const captured = { topicId: "original", top: 400, requested: false };
    const opened = resolveTaskChatReturn(captured, "original", true, false);
    expect(opened.restore).toBeNull();
    expect(opened.captured).toEqual(captured);
    const back = resolveTaskChatReturn({ ...opened.captured!, requested: true }, "original", false, false);
    expect(back.restore?.top).toBe(400);
    expect(back.captured).toBeNull();
    expect(resolveTaskChatReturn(back.captured, "original", false, false).restore).toBeNull();
  });

  it.each([
    { label: "another existing chat", topicId: "another", projectionOpen: false, settingsOpen: false },
    { label: "a newly created chat", topicId: "new-chat", projectionOpen: false, settingsOpen: false },
    { label: "settings", topicId: "original", projectionOpen: false, settingsOpen: true },
    { label: "leaving the projection without Back", topicId: "original", projectionOpen: false, settingsOpen: false },
  ])("discards the reading position after navigating to $label", ({ topicId, projectionOpen, settingsOpen }) => {
    const abandoned = resolveTaskChatReturn({ topicId: "original", top: 400, requested: false }, topicId, projectionOpen, settingsOpen);
    expect(abandoned).toEqual({ captured: null, restore: null });
    const laterOriginalChat = resolveTaskChatReturn(abandoned.captured, "original", false, false);
    expect(laterOriginalChat.restore).toBeNull();
  });

  it("preserves the original reading position when messages arrive while a task is open", () => {
    expect(restoredChatScroll(400, 2400, 800)).toEqual({
      scrollTop: 400, nearBottom: false, showToBottom: true,
    });
  });

  it("clamps the restored position when content becomes shorter than before", () => {
    expect(restoredChatScroll(1200, 900, 800)).toEqual({
      scrollTop: 100, nearBottom: true, showToBottom: false,
    });
    expect(restoredChatScroll(1200, 300, 800).scrollTop).toBe(0);
  });
});
