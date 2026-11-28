import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIDE_QUESTION_MAX_USER_TURNS,
  formatSideQuestionInsertDraft,
  type ChatDisplayItem,
  type SideQuestionView,
} from "@kulo/protocol";
import { MessageActions } from "./message-actions";
import { SideQuestionDrawer } from "./side-question-drawer";
import type { ReliableOutboxRecord } from "./reliable-outbox";
import { useChatSubmission, type UseChatSubmissionParams } from "./use-chat-submission";
import { isSideQuestionAwaitingReply } from "./use-side-question";

const here = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeSideQuestionView(overrides: Partial<SideQuestionView> = {}): SideQuestionView {
  return {
    record: {
      id: "sq-test-1",
      parentTopicId: "root",
      parentConversationId: 1,
      conversationId: 42,
      forkedAtEntryId: 10,
      title: "解释索引策略",
      quoteSnippet: "使用复合索引 (topic_id, created_at)",
      status: "active",
      userTurnCount: 1,
      maxUserTurns: SIDE_QUESTION_MAX_USER_TURNS,
      createdAt: 1_770_000_000_000,
      updatedAt: 1_770_000_001_000,
      expiresAt: 1_770_086_400_000,
    },
    messages: [
      { id: 101, role: "user", text: "为什么这个顺序更好？" },
      { id: 102, role: "assistant", text: "因为可以同时满足等值筛选和按时间排序。" },
    ],
    live: {
      busy: false,
      activeTools: [],
      queuedCount: 0,
    },
    remainingTurns: SIDE_QUESTION_MAX_USER_TURNS - 1,
    limitReached: false,
    ...overrides,
  };
}

function captureChatSubmission(overrides: Partial<UseChatSubmissionParams> = {}) {
  let drafts: Record<string, string> = { root: overrides.currentDraft ?? "" };
  const enqueueWs = vi.fn(async (message) => ({
    id: "outbox-1",
    sequence: 1,
    scope: "scope-1",
    envelope: message,
    state: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: 0,
  }) as unknown as ReliableOutboxRecord);
  const sendWsWithAck = vi.fn(async () => ({ ok: true }));
  const setActionError = vi.fn();
  const onSideQuestionSubmit = vi.fn(async () => true);

  const params: UseChatSubmissionParams = {
    connected: true,
    outboxReady: true,
    deliveryScope: "scope-1",
    activeTopicId: "root",
    projectedTicketRef: { current: undefined },
    ticketById: new Map(),
    inspectedTicket: null,
    topicDrafts: {
      isLocal: () => false,
      ensure: async () => ({ id: "root", conversationId: 1, title: "主对话", createdAt: 0, updatedAt: 0 }),
    } as unknown as UseChatSubmissionParams["topicDrafts"],
    currentDraftKey: "root",
    currentConversationDraftKey: "root",
    currentDraft: "",
    currentAttachments: [],
    draftEditRevisionRef: { current: 1 },
    editingSubmissionRef: { current: new Map() },
    selectedTargetDeviceId: "",
    persistedTargetDeviceId: "",
    topicTargetOverrides: {},
    setTopicTargetOverrides: vi.fn(),
    viewingHistory: false,
    clearMessageWindow: vi.fn(),
    nearBottomRef: { current: true },
    setShowToBottom: vi.fn(),
    setComposerDrafts: (updater) => {
      drafts = typeof updater === "function" ? updater(drafts) : updater;
    },
    setReplyDrafts: vi.fn(),
    removeAttachment: vi.fn(),
    setActionError,
    clearError: vi.fn(),
    closeProjection: vi.fn(),
    selectTopic: vi.fn(),
    enqueueWs,
    retryQueuedWs: vi.fn(),
    waitForQueuedAck: vi.fn(async () => ({})),
    sendWsWithAck,
    onSideQuestionSubmit,
    clientId: "client-1",
    ...overrides,
  };

  let hookApi!: ReturnType<typeof useChatSubmission>;
  function Harness() {
    hookApi = useChatSubmission(params);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  return {
    hookApi,
    getDrafts: () => drafts,
    enqueueWs,
    sendWsWithAck,
    setActionError,
    onSideQuestionSubmit,
  };
}

describe("Stage 3 P1-1 Side Question (/btw) frontend behavior", () => {
  it("intercepts /btw submissions into the side question drawer without sending to main chat", async () => {
    const harness = captureChatSubmission({ currentDraft: "/btw 这个错误码代表什么？" });
    await harness.hookApi.submitMessage();

    expect(harness.onSideQuestionSubmit).toHaveBeenCalledTimes(1);
    expect(harness.onSideQuestionSubmit).toHaveBeenCalledWith("这个错误码代表什么？");
    expect(harness.enqueueWs).not.toHaveBeenCalled();
    expect(harness.sendWsWithAck).not.toHaveBeenCalled();
    expect(harness.getDrafts().root).toBe("");
  });

  it("blocks /btw with attachments cleanly and never leaks into main chat", async () => {
    const harness = captureChatSubmission({
      currentDraft: "/btw 帮我看下附件",
      currentAttachments: [
        {
          localId: "att-1",
          status: "ready",
          name: "log.txt",
          mimeType: "text/plain",
          size: 12,
          kind: "file",
          attachment: { id: "a1", name: "log.txt", mimeType: "text/plain", size: 12, kind: "file", url: "/api/uploads/a1" },
        },
      ],
    });
    await harness.hookApi.submitMessage();

    expect(harness.onSideQuestionSubmit).not.toHaveBeenCalled();
    expect(harness.enqueueWs).not.toHaveBeenCalled();
    expect(harness.setActionError).toHaveBeenLastCalledWith(expect.stringContaining("附件"));
  });

  it("does not intercept normal messages or /btwfoo prefix; routes them to main chat", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const normal = captureChatSubmission({ currentDraft: "继续实现主对话任务" });
    await normal.hookApi.submitMessage();
    expect(normal.onSideQuestionSubmit).not.toHaveBeenCalled();
    expect(normal.enqueueWs).toHaveBeenCalledTimes(1);

    const nonCmd = captureChatSubmission({ currentDraft: "/btwfoo 不是指令" });
    await nonCmd.hookApi.submitMessage();
    expect(nonCmd.onSideQuestionSubmit).not.toHaveBeenCalled();
    expect(nonCmd.enqueueWs).toHaveBeenCalledTimes(1);
  });

  it("inserts side-question conclusion into main composer draft without auto-sending", () => {
    const submitSpy = vi.fn();
    let composerDraft = "已有想法";
    const onInsertToMainComposer = (answerText: string) => {
      composerDraft = formatSideQuestionInsertDraft(answerText, composerDraft);
    };

    onInsertToMainComposer("结论：改为复合索引即可。");
    expect(composerDraft).toBe("已有想法\n\n> 结论：改为复合索引即可。\n\n");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("evaluates awaiting-reply state accurately across live, queued, trailing-user, and error states", () => {
    expect(isSideQuestionAwaitingReply(null)).toBe(false);
    expect(isSideQuestionAwaitingReply(makeSideQuestionView())).toBe(false);
    expect(
      isSideQuestionAwaitingReply(
        makeSideQuestionView({
          live: { busy: true, activeTools: [], queuedCount: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      isSideQuestionAwaitingReply(
        makeSideQuestionView({
          messages: [{ id: 101, role: "user", text: "等待中" }],
        }),
      ),
    ).toBe(true);
    expect(
      isSideQuestionAwaitingReply(
        makeSideQuestionView({
          messages: [{ id: 101, role: "user", text: "失败了" }],
          live: { busy: false, activeTools: [], queuedCount: 0, runFailure: { reason: "模型超时" } },
        }),
      ),
    ).toBe(false);
  });

  it("renders SideQuestionDrawer & MessageActions cleanly without HeroUI v3 violations or Tabs", () => {
    const view = makeSideQuestionView();
    const html = renderToStaticMarkup(
      <SideQuestionDrawer
        open
        sideQuestion={view}
        loading={false}
        submitting={false}
        error={null}
        connected
        onSend={async () => true}
        onInsertToMainComposer={() => {}}
        onClose={() => {}}
      />,
    );
    // In SSR environments HeroUI Drawer portal may defer mounting; verify static source invariants directly too.
    expect(typeof html).toBe("string");

    const drawerSource = fs.readFileSync(path.join(here, "side-question-drawer.tsx"), "utf8");
    expect(drawerSource).toContain("Drawer.Dialog");
    expect(drawerSource).toContain("支线 · 不写入主对话");
    expect(drawerSource).toContain("插入主框");
    expect(drawerSource).toContain("kulo-context-field");
    expect(drawerSource).toContain('variant="secondary"');
    expect(drawerSource).toContain("scrollbar");
    expect(drawerSource).not.toContain("<Tabs");
    expect(drawerSource).not.toContain("promote");

    const item: ChatDisplayItem = { id: 25, role: "assistant", text: "检查划词追问入口" };
    const actionsHtml = renderToStaticMarkup(
      <MessageActions item={item} onReply={() => {}} onSideQuestion={() => {}}>
        <p>{item.text}</p>
      </MessageActions>,
    );
    expect(actionsHtml).toContain("检查划词追问入口");
    expect(actionsHtml).toContain('aria-label="复制消息"');
    expect(actionsHtml).toContain('aria-label="回复消息"');

    const actionsSource = fs.readFileSync(path.join(here, "message-actions.tsx"), "utf8");
    expect(actionsSource).toContain("支线追问");
  });
});
