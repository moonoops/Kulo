import {
  isValidElement,
  type ComponentProps,
  type Context,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, TextArea, TextField } from "@heroui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientToHubMessage, TicketCardView, TopicSummary } from "@kulo/protocol";
import type { ReliableOutboxRecord } from "./reliable-outbox";
import { TopicDraftStore } from "../topics/topic-drafts";
import {
  ModalFooterComposer,
  getFrozenTargetUnavailableReason,
  resolveModalComposerRoute,
  type ModalFooterComposerProps,
  type ModalFooterComposerTarget,
} from "./modal-footer-composer";
import { useChatSubmission } from "./use-chat-submission";

interface EffectSlot {
  deps?: readonly unknown[];
  cleanup?: (() => void) | void;
  pending?: () => (() => void) | void;
}

interface InstanceState {
  cells: unknown[];
  cursor: number;
  effects: EffectSlot[];
  layoutEffects: EffectSlot[];
  effectCursor: number;
  layoutEffectCursor: number;
}

const harness = vi.hoisted(() => {
  const instances = new Map<string, InstanceState>();
  const contextStack = new Map<unknown, unknown[]>();
  const state = {
    active: false,
    currentKey: "",
    instances,
    contextStack,
  };
  return state;
});

function depsChanged(prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (!prev || !next) return true;
  if (prev.length !== next.length) return true;
  return next.some((value, index) => !Object.is(value, prev[index]));
}

function currentInstance(): InstanceState {
  let instance = harness.instances.get(harness.currentKey);
  if (!instance) {
    instance = {
      cells: [],
      cursor: 0,
      effects: [],
      layoutEffects: [],
      effectCursor: 0,
      layoutEffectCursor: 0,
    };
    harness.instances.set(harness.currentKey, instance);
  }
  return instance;
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!harness.active) return actual.useState(initial as never);
      const inst = currentInstance();
      const idx = inst.cursor++;
      if (!(idx in inst.cells)) {
        inst.cells[idx] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      return [
        inst.cells[idx],
        (value: unknown) => {
          inst.cells[idx] =
            typeof value === "function" ? (value as (prev: unknown) => unknown)(inst.cells[idx]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      if (!harness.active) return actual.useRef(initial);
      const inst = currentInstance();
      const idx = inst.cursor++;
      if (!(idx in inst.cells)) inst.cells[idx] = { current: initial };
      return inst.cells[idx];
    },
    useCallback: (fn: unknown, deps?: readonly unknown[]) => {
      if (!harness.active) return actual.useCallback(fn as never, deps as never);
      const inst = currentInstance();
      const idx = inst.cursor++;
      const prev = inst.cells[idx] as { fn: unknown; deps?: readonly unknown[] } | undefined;
      if (!prev || depsChanged(prev.deps, deps)) {
        inst.cells[idx] = { fn, deps };
      }
      return (inst.cells[idx] as { fn: unknown }).fn;
    },
    useMemo: (factory: () => unknown, deps?: readonly unknown[]) => {
      if (!harness.active) return actual.useMemo(factory, deps as never);
      const inst = currentInstance();
      const idx = inst.cursor++;
      const prev = inst.cells[idx] as { value: unknown; deps?: readonly unknown[] } | undefined;
      if (!prev || depsChanged(prev.deps, deps)) {
        inst.cells[idx] = { value: factory(), deps };
      }
      return (inst.cells[idx] as { value: unknown }).value;
    },
    useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => {
      if (!harness.active) return actual.useEffect(fn, deps);
      const inst = currentInstance();
      const idx = inst.effectCursor++;
      const slot = inst.effects[idx] ?? {};
      if (!(idx in inst.effects) || depsChanged(slot.deps, deps)) {
        slot.deps = deps;
        slot.pending = fn;
        inst.effects[idx] = slot;
      }
    },
    useLayoutEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => {
      if (!harness.active) return actual.useLayoutEffect(fn, deps);
      const inst = currentInstance();
      const idx = inst.layoutEffectCursor++;
      const slot = inst.layoutEffects[idx] ?? {};
      if (!(idx in inst.layoutEffects) || depsChanged(slot.deps, deps)) {
        slot.deps = deps;
        slot.pending = fn;
        inst.layoutEffects[idx] = slot;
      }
    },
    useContext: (ctx: Context<unknown>) => {
      if (!harness.active) return actual.useContext(ctx);
      const stack = harness.contextStack.get(ctx);
      if (stack && stack.length > 0) return stack[stack.length - 1];
      return actual.useContext(ctx);
    },
    useSyncExternalStore: (subscribe: () => () => void, getSnapshot: () => unknown, getServerSnapshot?: () => unknown) => {
      if (!harness.active) return actual.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
      return getSnapshot();
    },
    useId: () => {
      if (!harness.active) return actual.useId();
      const inst = currentInstance();
      const idx = inst.cursor++;
      if (!(idx in inst.cells)) inst.cells[idx] = `id-${harness.currentKey}-${idx}`;
      return inst.cells[idx];
    },
  };
});

function flushEffects() {
  for (const inst of harness.instances.values()) {
    for (const slot of inst.layoutEffects) {
      if (slot.pending) {
        slot.cleanup?.();
        const fn = slot.pending;
        slot.pending = undefined;
        slot.cleanup = fn();
      }
    }
    for (const slot of inst.effects) {
      if (slot.pending) {
        slot.cleanup?.();
        const fn = slot.pending;
        slot.pending = undefined;
        slot.cleanup = fn();
      }
    }
  }
}

function resetHarness() {
  for (const inst of harness.instances.values()) {
    for (const slot of [...inst.layoutEffects, ...inst.effects]) {
      slot.cleanup?.();
    }
  }
  harness.instances.clear();
  harness.contextStack.clear();
  harness.active = false;
  harness.currentKey = "";
}

function renderComposer(props: ModalFooterComposerProps, key = "composer"): ReactNode {
  harness.active = true;
  harness.currentKey = key;
  const inst = currentInstance();
  inst.cursor = 0;
  inst.effectCursor = 0;
  inst.layoutEffectCursor = 0;
  try {
    return ModalFooterComposer(props);
  } finally {
    harness.active = false;
    flushEffects();
  }
}

function findElements<P = Record<string, unknown>>(
  tree: ReactNode,
  predicate: (el: ReactElement<P>) => boolean,
): ReactElement<P>[] {
  const results: ReactElement<P>[] = [];
  const visit = (node: ReactNode) => {
    for (const item of Array.isArray(node) ? node : [node]) {
      if (Array.isArray(item)) {
        visit(item);
        continue;
      }
      if (!isValidElement<{ children?: ReactNode }>(item)) continue;
      if (predicate(item as ReactElement<P>)) results.push(item as ReactElement<P>);
      visit(item.props.children);
    }
  };
  visit(tree);
  return results;
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return "";
}

function findButtonByText(tree: ReactNode, label: string): ReactElement<ComponentProps<typeof Button>> {
  const matches = findElements<ComponentProps<typeof Button>>(
    tree,
    (el) => el.type === Button && textContent(el.props.children).includes(label),
  );
  expect(matches.length, `expected button containing "${label}"`).toBeGreaterThan(0);
  return matches[0]!;
}

function createFakeDocument() {
  const captureListeners = new Set<(event: KeyboardEvent) => void>();
  const fakeDoc = {
    addEventListener: vi.fn((type: string, fn: (event: KeyboardEvent) => void, capture?: boolean) => {
      if (type === "keydown" && capture) captureListeners.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (event: KeyboardEvent) => void, capture?: boolean) => {
      if (type === "keydown" && capture) captureListeners.delete(fn);
    }),
    dispatchEscape(options: { isComposing?: boolean; keyCode?: number } = {}) {
      const event = {
        key: "Escape",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        isComposing: Boolean(options.isComposing),
        keyCode: options.keyCode ?? 27,
        preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) {
          this.defaultPrevented = true;
        }),
        stopPropagation: vi.fn(),
      };
      for (const listener of [...captureListeners]) {
        listener(event as unknown as KeyboardEvent);
      }
      return event;
    },
  };
  return fakeDoc;
}

describe("ModalFooterComposer routing and availability", () => {
  it("routes file and chat:<convId> previews to send_to_topic and never to steer_ticket", () => {
    expect(resolveModalComposerRoute({ targetKind: "file", topicId: "topic-a", conversationId: 10 }, "message")).toBe("send_to_topic");
    expect(resolveModalComposerRoute({ targetKind: "chat_preview", topicId: "root", conversationId: 1, ticketId: "chat:1" }, "message")).toBe("send_to_topic");
    expect(resolveModalComposerRoute({ targetKind: "ticket_preview", topicId: "root", ticketId: "chat:42" }, "message")).toBe("send_to_topic");
    expect(resolveModalComposerRoute({ targetKind: "ticket_preview", topicId: "topic-a", ticketId: "T-1" }, "message")).toBe("steer_ticket");
    expect(resolveModalComposerRoute({ targetKind: "ticket_preview", topicId: "topic-a", ticketId: "T-1" }, "resolve_handoff")).toBe("resolve_handoff");
    expect(resolveModalComposerRoute({ targetKind: "chat_preview", topicId: "root", ticketId: "chat:root:browser:local" }, "resolve_handoff")).toBe("resolve_handoff");
  });

  it("detects offline, deleted, archived, rotated-session, and ended-task frozen targets", () => {
    const topicA: TopicSummary = { id: "topic-a", title: "方案 A", conversationId: 10, createdAt: 1, updatedAt: 1 };
    const archivedTopic: TopicSummary = { id: "topic-arch", title: "归档", conversationId: 20, archived: true, createdAt: 1, updatedAt: 1 };
    const deletedTopic: TopicSummary = { id: "topic-del", title: "已删", conversationId: 30, deletedAt: 99, createdAt: 1, updatedAt: 1 };
    const stoppedTicket: TicketCardView = {
      id: "T-stop",
      title: "旧任务",
      role: "developer",
      roleLabel: "开发",
      status: "stopped",
      envId: "local",
      workspaceDir: "/repo",
      createdAt: 1,
      updatedAt: 2,
      accumulatedRunningMs: 0,
    };

    expect(getFrozenTargetUnavailableReason({ targetKind: "file", topicId: "topic-a", conversationId: 10 }, { connected: false })).toContain("断开");
    expect(getFrozenTargetUnavailableReason({ targetKind: "file", topicId: "topic-a", conversationId: 10 }, { connected: true, topics: [topicA] })).toBeUndefined();
    expect(getFrozenTargetUnavailableReason({ targetKind: "file", topicId: "topic-arch", conversationId: 20 }, { connected: true, topics: [topicA, archivedTopic] })).toContain("归档");
    expect(getFrozenTargetUnavailableReason({ targetKind: "file", topicId: "topic-del", conversationId: 30 }, { connected: true, topics: [topicA, deletedTopic] })).toContain("删除");
    expect(getFrozenTargetUnavailableReason({ targetKind: "file", topicId: "topic-a", conversationId: 9 }, { connected: true, topics: [topicA] })).toContain("归档");
    expect(getFrozenTargetUnavailableReason({ targetKind: "ticket_preview", topicId: "topic-a", ticketId: "T-stop" }, { connected: true, tickets: [stoppedTicket] })).toContain("结束");
    expect(getFrozenTargetUnavailableReason({ targetKind: "ticket_preview", topicId: "topic-a", ticketId: "T-live" }, { connected: true, previewClosed: true })).toContain("结束");
  });
});

describe("ModalFooterComposer interactive behavior and HeroUI v3 compliance", () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    resetHarness();
    vi.unstubAllGlobals();
  });

  it("renders a collapsed secondary sm trigger button in static markup with minimal copy", () => {
    const html = renderToStaticMarkup(
      <ModalFooterComposer
        target={{ targetKind: "file", topicId: "topic-a", conversationId: 10, fileLabel: "报告.pdf" }}
        onSendToTopic={vi.fn()}
      />,
    );
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain("button--secondary");
    expect(html).toContain("button--sm");
    expect(html).toContain("发指令…");
    expect(html).not.toContain("<textarea");
  });

  it("expands in place with kulo-context-field + secondary scrollbar TextArea, fires onBeforeExpand first, and dispatches to the frozen target", async () => {
    const events: string[] = [];
    const onBeforeExpand = vi.fn(() => { events.push("beforeExpand"); });
    const onExpandChange = vi.fn((next: boolean) => { events.push(`expand:${next}`); });
    const onSendToTopic = vi.fn(async () => {});
    const onSteerTicket = vi.fn(async () => {});
    const target: ModalFooterComposerTarget = {
      targetKind: "chat_preview",
      topicId: "topic-a",
      conversationId: 42,
      ticketId: "chat:42",
      previewSessionId: "sess-1",
    };

    const props: ModalFooterComposerProps = {
      target,
      onBeforeExpand,
      onExpandChange,
      onSendToTopic,
      onSteerTicket,
    };

    const collapsed = renderComposer(props);
    const trigger = findButtonByText(collapsed, "发指令…");
    expect(trigger.props.variant).toBe("secondary");
    expect(trigger.props.size).toBe("sm");

    trigger.props.onPress?.({} as never);
    expect(events).toEqual(["beforeExpand", "expand:true"]);

    const expanded = renderComposer(props);
    const textFields = findElements<ComponentProps<typeof TextField>>(expanded, (el) => el.type === TextField);
    const textAreas = findElements<ComponentProps<typeof TextArea>>(expanded, (el) => el.type === TextArea);
    expect(textFields).toHaveLength(1);
    expect(textFields[0]!.props.className).toContain("kulo-context-field");
    expect(textAreas).toHaveLength(1);
    expect(textAreas[0]!.props.variant).toBe("secondary");
    expect(textAreas[0]!.props.className).toContain("scrollbar");

    textFields[0]!.props.onChange?.("帮我查一下余额");
    const withDraft = renderComposer(props);
    const sendButton = findButtonByText(withDraft, "发送");
    await sendButton.props.onPress?.({} as never);

    expect(onSendToTopic).toHaveBeenCalledTimes(1);
    expect(onSendToTopic).toHaveBeenCalledWith(target, "帮我查一下余额");
    expect(onSteerTicket).not.toHaveBeenCalled();

    const afterSend = renderComposer(props);
    expect(findElements(afterSend, (el) => el.type === TextArea)).toHaveLength(0);
    expect(onExpandChange).toHaveBeenLastCalledWith(false);
  });

  it("provides two distinct Handoff buttons: 发消息 keeps handoff while 完成接管 resolves handoff", async () => {
    const onSteerTicket = vi.fn(async () => {});
    const onResolveHandoff = vi.fn(async () => {});
    const target: ModalFooterComposerTarget = {
      targetKind: "ticket_preview",
      topicId: "topic-a",
      ticketId: "ticket-9",
      previewSessionId: "browser-9",
    };
    const props: ModalFooterComposerProps = {
      target,
      interactiveHandoff: true,
      onSteerTicket,
      onResolveHandoff,
    };

    findButtonByText(renderComposer(props), "发指令…").props.onPress?.({} as never);
    let tree = renderComposer(props);

    const msgBtn = findButtonByText(tree, "发消息");
    const resolveBtn = findButtonByText(tree, "完成接管");
    expect(msgBtn.props.variant).toBe("secondary");
    expect(resolveBtn.props.variant).toBe("primary");
    expect(msgBtn.props.isDisabled).toBe(true);
    expect(resolveBtn.props.isDisabled).toBe(false);

    // Type note and click 发消息 -> calls onSteerTicket only, NEVER onResolveHandoff
    findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.onChange?.("先别点提交，只填表格");
    tree = renderComposer(props);
    await findButtonByText(tree, "发消息").props.onPress?.({} as never);
    expect(onSteerTicket).toHaveBeenCalledTimes(1);
    expect(onSteerTicket).toHaveBeenCalledWith(target, "先别点提交，只填表格");
    expect(onResolveHandoff).not.toHaveBeenCalled();

    // Re-open, type handoff completion note, click 完成接管 -> calls onResolveHandoff only
    findButtonByText(renderComposer(props), "发指令…").props.onPress?.({} as never);
    tree = renderComposer(props);
    findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.onChange?.("验证码已填好，请继续下一步");
    tree = renderComposer(props);
    await findButtonByText(tree, "完成接管").props.onPress?.({} as never);
    expect(onResolveHandoff).toHaveBeenCalledTimes(1);
    expect(onResolveHandoff).toHaveBeenCalledWith(target, "验证码已填好，请继续下一步");
    expect(onSteerTicket).toHaveBeenCalledTimes(1);
  });

  it("enforces Chinese IME composition guards for Enter and Escape, and collapses via capture-phase Escape without losing focus return", async () => {
    const fakeDoc = createFakeDocument();
    vi.stubGlobal("document", fakeDoc);

    const onSendToTopic = vi.fn(async () => {});
    const onExpandChange = vi.fn();
    const onCollapseFocusReturn = vi.fn();
    const target: ModalFooterComposerTarget = { targetKind: "file", topicId: "topic-a", conversationId: 10, fileLabel: "doc.pdf" };
    const props: ModalFooterComposerProps = {
      target,
      onSendToTopic,
      onExpandChange,
      onCollapseFocusReturn,
    };

    findButtonByText(renderComposer(props), "发指令…").props.onPress?.({} as never);
    let tree = renderComposer(props);
    findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.onChange?.("中文输入");
    tree = renderComposer(props);
    const area = findElements<ComponentProps<typeof TextArea>>(tree, (el) => el.type === TextArea)[0]!;

    // Start IME composition
    area.props.onCompositionStart?.({} as never);

    // Enter during composition (both isComposing and keyCode 229) must NOT submit
    const enterDuringIme = {
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      keyCode: 229,
      nativeEvent: { isComposing: true },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: { value: "中文输入", selectionStart: 4, selectionEnd: 4 },
    };
    area.props.onKeyDown?.(enterDuringIme as never);
    expect(onSendToTopic).not.toHaveBeenCalled();

    // Escape during composition must NOT collapse
    const escDuringIme = fakeDoc.dispatchEscape({ isComposing: true, keyCode: 229 });
    expect(escDuringIme.preventDefault).not.toHaveBeenCalled();
    expect(onCollapseFocusReturn).not.toHaveBeenCalled();

    // End IME composition, then Shift+Enter inserts newline without submitting
    area.props.onCompositionEnd?.({} as never);
    const shiftEnter = {
      key: "Enter",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      keyCode: 13,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: { value: "中文输入", selectionStart: 4, selectionEnd: 4 },
    };
    area.props.onKeyDown?.(shiftEnter as never);
    expect(shiftEnter.preventDefault).toHaveBeenCalled();
    expect(onSendToTopic).not.toHaveBeenCalled();
    tree = renderComposer(props);
    expect(findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.value).toBe("中文输入\n");

    // Capture-phase Escape collapses composer without letting modal dismiss, and restores focus
    const esc = fakeDoc.dispatchEscape();
    expect(esc.preventDefault).toHaveBeenCalledTimes(1);
    expect(esc.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onExpandChange).toHaveBeenLastCalledWith(false);
    expect(onCollapseFocusReturn).toHaveBeenCalledTimes(1);
    expect(findElements(renderComposer(props), (el) => el.type === TextArea)).toHaveLength(0);
  });

  it("preserves user draft and displays feedback when target is offline, archived, or dispatch fails", async () => {
    const target: ModalFooterComposerTarget = { targetKind: "file", topicId: "topic-a", conversationId: 10, fileLabel: "report.html" };

    // Case 1: offline target
    const onSendOffline = vi.fn(async () => {});
    const offlineProps: ModalFooterComposerProps = {
      target,
      connected: false,
      onSendToTopic: onSendOffline,
    };
    findButtonByText(renderComposer(offlineProps, "offline"), "发指令…").props.onPress?.({} as never);
    let tree = renderComposer(offlineProps, "offline");
    findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.onChange?.("离线保留这段草稿");
    tree = renderComposer(offlineProps, "offline");
    await findButtonByText(tree, "发送").props.onPress?.({} as never);
    tree = renderComposer(offlineProps, "offline");
    expect(onSendOffline).not.toHaveBeenCalled();
    expect(findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.value).toBe("离线保留这段草稿");
    const alerts = findElements(tree, (el) => el.props.role === "alert");
    expect(alerts.length).toBeGreaterThan(0);
    expect(textContent(alerts[0]!)).toContain("断开");

    // Case 2: dispatch failure (e.g. archived/rejected by hub)
    const onSendFail = vi.fn(async () => {
      throw new Error("原话题已归档，请还原后再发送");
    });
    const failProps: ModalFooterComposerProps = {
      target,
      connected: true,
      onSendToTopic: onSendFail,
    };
    findButtonByText(renderComposer(failProps, "fail"), "发指令…").props.onPress?.({} as never);
    let failTree = renderComposer(failProps, "fail");
    findElements<ComponentProps<typeof TextField>>(failTree, (el) => el.type === TextField)[0]!.props.onChange?.("不要丢掉我的问题");
    failTree = renderComposer(failProps, "fail");
    await findButtonByText(failTree, "发送").props.onPress?.({} as never);
    failTree = renderComposer(failProps, "fail");
    expect(onSendFail).toHaveBeenCalledTimes(1);
    expect(findElements<ComponentProps<typeof TextField>>(failTree, (el) => el.type === TextField)[0]!.props.value).toBe("不要丢掉我的问题");
    const failAlerts = findElements(failTree, (el) => el.props.role === "alert");
    expect(textContent(failAlerts[0]!)).toContain("已归档");
  });
});

describe("useChatSubmission frozen-target routing", () => {
  beforeEach(() => resetHarness());
  afterEach(() => resetHarness());

  function createSubmissionHarness(overrides: {
    activeTopicId?: string;
    connected?: boolean;
    topics?: TopicSummary[];
    tickets?: TicketCardView[];
    waitForQueuedAck?: (record: ReliableOutboxRecord) => Promise<unknown>;
  } = {}) {
    const enqueued: ClientToHubMessage[] = [];
    const discarded: string[] = [];
    const topics: TopicSummary[] = overrides.topics ?? [
      { id: "topic-a", title: "话题 A", conversationId: 101, createdAt: 1, updatedAt: 1 },
      { id: "topic-b", title: "话题 B", conversationId: 202, createdAt: 2, updatedAt: 2 },
    ];
    const tickets = overrides.tickets ?? [];
    const topicDrafts = new TopicDraftStore({
      create: async () => topics[0]!,
      onSaved: () => {},
    });

    const invoke = (activeTopicId = overrides.activeTopicId ?? "topic-b") => {
      harness.active = true;
      harness.currentKey = "submission";
      const inst = currentInstance();
      inst.cursor = 0;
      inst.effectCursor = 0;
      inst.layoutEffectCursor = 0;
      try {
        return useChatSubmission({
          connected: overrides.connected ?? true,
          outboxReady: true,
          deliveryScope: "hub-1",
          activeTopicId,
          activeTopic: topics.find((item) => item.id === activeTopicId),
          topics,
          rootConversationId: 1,
          projectedTicketRef: { current: undefined },
          ticketById: new Map(tickets.map((t) => [t.id, t])),
          inspectedTicket: null,
          topicDrafts,
          currentDraftKey: `topic:${activeTopicId}`,
          currentConversationDraftKey: `topic:${activeTopicId}`,
          currentDraft: "",
          currentAttachments: [],
          draftEditRevisionRef: { current: 0 },
          editingSubmissionRef: { current: new Map() },
          selectedTargetDeviceId: "",
          persistedTargetDeviceId: "",
          topicTargetOverrides: {},
          setTopicTargetOverrides: vi.fn(),
          viewingHistory: false,
          clearMessageWindow: vi.fn(),
          nearBottomRef: { current: true },
          setShowToBottom: vi.fn(),
          setComposerDrafts: vi.fn(),
          setReplyDrafts: vi.fn(),
          removeAttachment: vi.fn(),
          setActionError: vi.fn(),
          clearError: vi.fn(),
          closeProjection: vi.fn(),
          selectTopic: vi.fn(),
          enqueueWs: async (message) => {
            enqueued.push(message);
            return {
              id: `rec-${enqueued.length}`,
              scope: "hub-1",
              sequence: enqueued.length,
              createdAt: Date.now(),
              envelope: message as ReliableOutboxRecord["envelope"],
              state: "queued",
              attempt: 0,
              nextAttemptAt: 0,
            };
          },
          retryQueuedWs: vi.fn(),
          waitForQueuedAck: overrides.waitForQueuedAck ?? (async () => ({})),
          discardFailedWs: async (id) => {
            discarded.push(id);
          },
          sendWsWithAck: vi.fn(async () => ({})),
          clientId: "web-test",
        });
      } finally {
        harness.active = false;
      }
    };

    return { invoke, enqueued, discarded };
  }

  it("sends file instructions to the frozen topic and conversationId even after switching activeTopicId to another topic", async () => {
    const { invoke, enqueued } = createSubmissionHarness({ activeTopicId: "topic-b" });
    const api = invoke("topic-b");
    await api.sendToFrozenTopic(
      { targetKind: "file", topicId: "topic-a", conversationId: 101, fileLabel: "架构图.pdf" },
      "总结关键改动",
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      type: "chat.send",
      topicId: "topic-a",
      expectedConversationId: 101,
      whenBusy: "steer",
    });
    expect((enqueued[0] as Extract<ClientToHubMessage, { type: "chat.send" }>).content).toContain("架构图.pdf");
    expect((enqueued[0] as Extract<ClientToHubMessage, { type: "chat.send" }>).content).toContain("总结关键改动");
  });

  it("never emits ticket.steer for chat:<convId> previews even when passed through steerFrozenTicket", async () => {
    const { invoke, enqueued } = createSubmissionHarness({ activeTopicId: "topic-b" });
    const api = invoke("topic-b");
    await api.steerFrozenTicket(
      { targetKind: "ticket_preview", topicId: "topic-a", conversationId: 101, ticketId: "chat:101", previewSessionId: "s-chat" },
      "打开下一页",
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.type).toBe("chat.send");
    expect(enqueued[0]).toMatchObject({
      type: "chat.send",
      topicId: "topic-a",
      expectedConversationId: 101,
      content: "打开下一页",
    });
  });

  it("rejects archived or offline frozen targets before enqueueing and cleans up failed outbox records on ack rejection", async () => {
    const archivedHarness = createSubmissionHarness({
      topics: [
        { id: "topic-a", title: "已归档", conversationId: 101, archived: true, createdAt: 1, updatedAt: 1 },
        { id: "topic-b", title: "当前", conversationId: 202, createdAt: 2, updatedAt: 2 },
      ],
    });
    await expect(
      archivedHarness.invoke("topic-b").sendToFrozenTopic(
        { targetKind: "file", topicId: "topic-a", conversationId: 101, fileLabel: "旧文档.docx" },
        "继续分析",
      ),
    ).rejects.toThrow("归档");
    expect(archivedHarness.enqueued).toHaveLength(0);

    const rejectAckHarness = createSubmissionHarness({
      waitForQueuedAck: async () => {
        throw new Error("root_conversation_rotated");
      },
    });
    await expect(
      rejectAckHarness.invoke("topic-b").sendToFrozenTopic(
        { targetKind: "file", topicId: "topic-a", conversationId: 101, fileLabel: "旧文档.docx" },
        "继续分析",
      ),
    ).rejects.toThrow("root_conversation_rotated");
    expect(rejectAckHarness.discarded).toEqual(["rec-1"]);
  });
});
