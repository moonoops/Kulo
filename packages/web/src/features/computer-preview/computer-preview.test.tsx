import {
  isValidElement,
  type ComponentProps,
  type Context,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Modal, TextArea, TextField } from "@heroui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerPreviewInputEvent, TicketCardView, TopicSummary } from "@kulo/protocol";
import { KuloTaskRail } from "../tasks/task-rail";
import {
  ComputerPreviewModal,
  buildComputerPreviewTarget,
  formatModalSessionLabels,
  TaskCardComputerPreview,
  type ComputerPreviewActions,
} from "./computer-preview";
import { RemoteInputTracker } from "./handoff-controls";
import { ModalFooterComposer, type ModalFooterComposerTarget } from "../chat/modal-footer-composer";
import { EMPTY_PREVIEW_STATE, type ComputerPreviewState } from "./preview-client";

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

const harness = vi.hoisted(() => ({
  active: false,
  currentKey: "",
  instances: new Map<string, InstanceState>(),
  contextStack: new Map<unknown, unknown[]>(),
}));

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
      if (!prev || depsChanged(prev.deps, deps)) inst.cells[idx] = { fn, deps };
      return (inst.cells[idx] as { fn: unknown }).fn;
    },
    useMemo: (factory: () => unknown, deps?: readonly unknown[]) => {
      if (!harness.active) return actual.useMemo(factory, deps as never);
      const inst = currentInstance();
      const idx = inst.cursor++;
      const prev = inst.cells[idx] as { value: unknown; deps?: readonly unknown[] } | undefined;
      if (!prev || depsChanged(prev.deps, deps)) inst.cells[idx] = { value: factory(), deps };
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

function isCustomExpandable(type: unknown): type is (props: Record<string, unknown>) => ReactNode {
  if (typeof type !== "function") return false;
  return (
    type === ComputerPreviewModal ||
    type === ModalFooterComposer ||
    (type as { name?: string }).name === "PreviewViewport"
  );
}

function expandTree(node: ReactNode, path = "root", mounted = new Set<string>()): ReactNode {
  if (Array.isArray(node)) {
    return node.map((child, index) => expandTree(child, `${path}[${index}]`, mounted));
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;

  if (isCustomExpandable(node.type)) {
    const key = node.key !== null ? `${path}:${String(node.key)}` : `${path}:${node.type.name || "fn"}`;
    mounted.add(key);
    const prevKey = harness.currentKey;
    harness.currentKey = key;
    const inst = currentInstance();
    inst.cursor = 0;
    inst.effectCursor = 0;
    inst.layoutEffectCursor = 0;
    const rendered = node.type(node.props as Record<string, unknown>);
    harness.currentKey = prevKey;
    return expandTree(rendered, key, mounted);
  }

  if (node.props.children !== undefined) {
    return {
      ...node,
      props: {
        ...node.props,
        children: expandTree(node.props.children, `${path}/${typeof node.type === "string" ? node.type : "el"}`, mounted),
      },
    };
  }
  return node;
}

function renderStateful(element: ReactElement): ReactNode {
  const mounted = new Set<string>();
  harness.active = true;
  let tree: ReactNode;
  try {
    tree = expandTree(element, "root", mounted);
  } finally {
    harness.active = false;
  }
  for (const [key, inst] of harness.instances) {
    if (!mounted.has(key)) {
      for (const slot of [...inst.layoutEffects, ...inst.effects]) slot.cleanup?.();
      harness.instances.delete(key);
    }
  }
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
  return tree;
}

function resetHarness() {
  for (const inst of harness.instances.values()) {
    for (const slot of [...inst.layoutEffects, ...inst.effects]) slot.cleanup?.();
  }
  harness.instances.clear();
  harness.contextStack.clear();
  harness.active = false;
  harness.currentKey = "";
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

const desktopSession = {
  id: "desktop-1",
  ticketId: "ticket-1",
  tool: "desktop" as const,
  envId: "local",
  deviceName: "Mac",
  title: "更新文档",
  app: "TextEdit",
};

const browserSession = {
  id: "browser-2",
  ticketId: "ticket-2",
  tool: "browser" as const,
  envId: "remote",
  deviceName: "Macmini",
  title: "搜索 B 站视频",
};

const state: ComputerPreviewState = {
  ...EMPTY_PREVIEW_STATE,
  connection: "connected",
  selectedId: "desktop-1",
  activeTicketId: "ticket-1",
  selectedByTicket: { "ticket-1": "desktop-1" },
  sessions: [desktopSession],
  displays: { "desktop-1": { state: "live", imageUrl: "blob:preview", capturedAt: 1 } },
};

const client: ComputerPreviewActions = {
  setCollapsed: vi.fn(),
  setExpanded: vi.fn(),
  expandTicket: vi.fn(),
  collapseTicket: vi.fn(),
  openModal: vi.fn(),
  closeModal: vi.fn(),
  select: vi.fn(),
  stopTask: vi.fn(),
  retry: vi.fn(),
  frameFailed: vi.fn(),
};

const renderCardPreview = (value: ComputerPreviewState, sessions = value.sessions) =>
  renderToStaticMarkup(
    <TaskCardComputerPreview
      ticketId="ticket-1"
      ticketTitle="更新文档"
      showInlineControls
      sessions={sessions}
      state={value}
      client={client}
      connected
      onStop={async () => {}}
    />,
  );

const ticket = (id: string, title: string, originTopicId?: string): TicketCardView => ({
  id,
  title,
  role: "developer",
  roleLabel: "开发智能体",
  status: "running",
  envId: "local",
  workspaceDir: "/project",
  ...(originTopicId ? { originTopicId } : {}),
  createdAt: 1,
  updatedAt: 1,
  startedRunningAt: Date.now(),
  accumulatedRunningMs: 0,
});

beforeEach(() => resetHarness());
afterEach(() => {
  resetHarness();
  vi.unstubAllGlobals();
});

describe("embedded task card operation preview", () => {
  it("renders a compact embedded preview with overlaid fullscreen zoom and no secondary header or inline session switcher", () => {
    const secondOnT1 = {
      ...desktopSession,
      id: "browser-1b",
      tool: "browser" as const,
      app: undefined,
    };
    const html = renderCardPreview(state, [desktopSession, secondOnT1]);
    expect(html).toContain('aria-label="设备操作预览：更新文档"');
    expect(html).toContain('aria-label="停止任务：更新文档"');
    expect(html).toContain('aria-label="放大操作预览：更新文档"');
    expect(html).toContain('aria-label="收起操作预览：更新文档"');
    expect(html).toContain("kulo-task-preview-viewport-frame");
    expect(html).toContain("kulo-task-preview-zoom-button");
    expect(html).toContain('alt="应用窗口截图"');
    expect(html).not.toContain("kulo-task-preview-bar");
    expect(html).not.toContain("kulo-computer-preview-sessions");
    expect(html).not.toContain("操作截图");
    expect(html).not.toMatch(/role="dialog"|aria-modal|autofocus|aria-live/);
  });

  it("keeps stop available while collapsed and offers an accessible expand control", () => {
    const html = renderCardPreview({ ...state, collapsed: true });
    expect(html).toContain('aria-label="展开操作预览：更新文档"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="停止任务：更新文档"');
    expect(html).not.toContain('aria-label="放大操作预览：更新文档"');
    expect(html).toMatch(/<div[^>]*hidden=""/);
  });

  it("surfaces stop failures and a retry even while collapsed", () => {
    const html = renderCardPreview({
      ...state,
      collapsed: true,
      stops: { "ticket-1": { pending: false, error: "停止请求未确认" } },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("停止请求未确认");
    expect(html).toContain("重试停止");
  });

  it("offers a device-specific permission recovery action only for desktop previews", () => {
    const desktop = renderCardPreview({
      ...state,
      displays: { "desktop-1": { state: "unavailable", permissionRequired: "screen", message: "需要录屏权限才能预览窗口" } },
    });
    expect(desktop).toContain('aria-label="检查Mac的系统权限"');
    expect(desktop).toContain("检查权限");

    const browser = renderCardPreview(
      {
        ...state,
        sessions: [{ ...desktopSession, tool: "browser", app: undefined }],
        displays: { "desktop-1": { state: "unavailable" } },
      },
      [{ ...desktopSession, tool: "browser", app: undefined }],
    );
    expect(browser).not.toContain("检查权限");
  });

  it("embeds previews directly between the card title bar and status footer without nested buttons or redundant archive controls", () => {
    const multiState: ComputerPreviewState = {
      ...EMPTY_PREVIEW_STATE,
      connection: "connected",
      selectedId: "browser-2",
      activeTicketId: "ticket-2",
      selectedByTicket: { "ticket-1": "desktop-1", "ticket-2": "browser-2" },
      sessions: [desktopSession, browserSession],
      displays: {
        "desktop-1": { state: "live", imageUrl: "blob:preview-1", capturedAt: 1 },
        "browser-2": { state: "live", imageUrl: "blob:preview-2", capturedAt: 2 },
      },
    };
    const html = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[ticket("ticket-2", "搜索 B 站视频"), ticket("ticket-1", "更新文档")]}
        onProject={() => {}}
        onArchive={async () => {}}
        computerPreview={{ state: multiState, client, onStop: async () => {} }}
      />,
    );
    expect(html).toContain('aria-label="设备操作预览：搜索 B 站视频"');
    expect(html).toContain('aria-label="设备操作预览：更新文档"');
    expect(html).toContain('aria-label="收起操作预览：搜索 B 站视频"');
    expect(html).toContain('aria-label="展开操作预览：更新文档"');
    expect(html).toContain('aria-label="放大操作预览：搜索 B 站视频"');
    expect(html).not.toContain('aria-label="归档任务：搜索 B 站视频"');
    expect(html).not.toContain("Macmini · 实时画面");
    expect(html).toContain('class="kulo-task-device-name" title="Macmini">Macmini<');
    expect(html.indexOf("kulo-task-card-head")).toBeLessThan(html.indexOf("kulo-task-preview-viewport-frame"));
    expect(html.indexOf("kulo-task-preview-viewport-frame")).toBeLessThan(html.indexOf("kulo-task-card-preview-foot"));
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
      expect(button.match(/<button\b/g)).toHaveLength(1);
    }
  });

  it("falls back to an orphan preview card in KuloTaskRail when the ticket row has not synced yet", () => {
    const html = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        onProject={() => {}}
        computerPreview={{ state, client, onStop: async () => {} }}
      />,
    );
    expect(html).toContain("kulo-task-preview-orphans");
    expect(html).toContain("更新文档");
    expect(html).toContain('aria-label="停止任务：更新文档"');
    expect(html).not.toContain("暂无后台任务");
  });

  it("renders ComputerPreviewModal when closed without stray dialog content and disambiguates duplicate modal session labels", () => {
    const closed = renderToStaticMarkup(
      <ComputerPreviewModal state={state} client={client} connected onStop={async () => {}} />,
    );
    expect(closed).not.toContain("关闭放大预览");

    const labels = formatModalSessionLabels(
      [
        { ...browserSession, id: "browser-mbp", deviceName: "MacBook Pro" },
        { ...desktopSession, id: "calc-mbp", deviceName: "MacBook Pro", app: "Calculator" },
        { ...desktopSession, id: "calc-mini", ticketId: "ticket-2", deviceName: "MacMini", app: "Calculator" },
      ],
      (zh) => zh,
    );
    expect(labels.get("browser-mbp")).toBe("浏览器");
    expect(labels.get("calc-mbp")).toBe("Calculator · MacBook Pro");
    expect(labels.get("calc-mini")).toBe("Calculator · MacMini");
  });
});

describe("ComputerPreviewModal inline Modal.Footer composer and handoff zero-leakage contract (Stage 2 P1-2)", () => {
  const topics: TopicSummary[] = [
    { id: "topic-a", title: "主题 A", conversationId: 101, createdAt: 1, updatedAt: 1 },
    { id: "topic-b", title: "主题 B", conversationId: 202, createdAt: 2, updatedAt: 2 },
  ];

  it("freezes chat:<convId> target snapshot and routes strictly to onSendToTopic without calling steerTicket even after topic switch", async () => {
    const chatSession = {
      id: "chat-sess-1",
      ticketId: "chat:101",
      tool: "browser" as const,
      envId: "local",
      deviceName: "Mac",
      title: "主对话浏览器",
    };
    const previewState: ComputerPreviewState = {
      ...EMPTY_PREVIEW_STATE,
      connection: "connected",
      expanded: true,
      selectedId: chatSession.id,
      activeTicketId: chatSession.ticketId,
      selectedByTicket: { [chatSession.ticketId]: chatSession.id },
      sessions: [chatSession],
      displays: { [chatSession.id]: { state: "live", imageUrl: "blob:chat", capturedAt: 1 } },
    };

    const target = buildComputerPreviewTarget(chatSession, {
      topics,
      fallbackTopicId: "topic-b",
      fallbackConversationId: 202,
    });
    expect(target).toEqual({
      targetKind: "chat_preview",
      topicId: "topic-a",
      conversationId: 101,
      ticketId: "chat:101",
      previewSessionId: "chat-sess-1",
    } satisfies ModalFooterComposerTarget);

    const onSendToTopic = vi.fn(async () => {});
    const onSteerTicket = vi.fn(async () => {});

    const renderModal = (activeTopicId: string, activeConversationId: number) =>
      renderStateful(
        <ComputerPreviewModal
          state={previewState}
          client={client}
          connected
          onStop={async () => {}}
          activeTopicId={activeTopicId}
          activeConversationId={activeConversationId}
          topics={topics}
          tickets={[]}
          onSendToTopic={onSendToTopic}
          onSteerTicket={onSteerTicket}
        />,
      );

    // Open while on topic-a, then switch active topic to topic-b
    let tree = renderModal("topic-a", 101);
    tree = renderModal("topic-b", 202);

    findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发指令…"),
    )[0]!.props.onPress?.({} as never);
    tree = renderModal("topic-b", 202);

    findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.onChange?.("帮我切换到订单页");
    tree = renderModal("topic-b", 202);

    await findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发送"),
    )[0]!.props.onPress?.({} as never);

    expect(onSendToTopic).toHaveBeenCalledTimes(1);
    expect(onSendToTopic).toHaveBeenCalledWith(target, "帮我切换到订单页");
    expect(onSteerTicket).not.toHaveBeenCalled();
  });

  it("flushes held remote keys/pointers before expanding, sends 0 typing events to remote while expanded, supports dual Handoff buttons, and restores focus to stageRef on capture-phase Esc", async () => {
    const captureListeners = new Set<(event: KeyboardEvent) => void>();
    vi.stubGlobal("document", {
      addEventListener: (_type: string, fn: (event: KeyboardEvent) => void, capture?: boolean) => {
        if (capture) captureListeners.add(fn);
      },
      removeEventListener: (_type: string, fn: (event: KeyboardEvent) => void, capture?: boolean) => {
        if (capture) captureListeners.delete(fn);
      },
    });

    const sentInputs: ComputerPreviewInputEvent[] = [];
    const closeModal = vi.fn();
    const interactiveClient: ComputerPreviewActions = {
      ...client,
      closeModal,
      sendInput: vi.fn((_id: string, event: ComputerPreviewInputEvent) => {
        sentInputs.push(event);
        return true;
      }),
    };
    const handoffSession = {
      ...browserSession,
      id: "handoff-browser",
      ticketId: "ticket-2",
      handoff: {
        requestId: "req-1",
        reason: "请完成短信验证登录",
        target: "browser" as const,
        expiresAt: Date.now() + 60_000,
        interactive: true,
      },
    };
    const handoffState: ComputerPreviewState = {
      ...EMPTY_PREVIEW_STATE,
      connection: "connected",
      expanded: true,
      selectedId: handoffSession.id,
      activeTicketId: handoffSession.ticketId,
      selectedByTicket: { [handoffSession.ticketId]: handoffSession.id },
      sessions: [handoffSession],
      displays: {
        [handoffSession.id]: {
          state: "live",
          imageUrl: "blob:handoff",
          capturedAt: 1,
          deviceWidth: 1000,
          deviceHeight: 500,
        },
      },
    };

    const onSteerTicket = vi.fn(async () => {});
    const onResolveHandoff = vi.fn(async () => ({ ok: true, status: "done" }));
    const mockStageFocus = vi.fn();
    const mockStageEl = { focus: mockStageFocus } as unknown as HTMLDivElement;
    const mockImgEl = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
      naturalWidth: 1000,
      naturalHeight: 500,
    } as unknown as HTMLImageElement;

    const renderHandoff = () => {
      const tree = renderStateful(
        <ComputerPreviewModal
          state={handoffState}
          client={interactiveClient}
          connected
          onStop={async () => {}}
          activeTopicId="topic-a"
          activeConversationId={101}
          topics={topics}
          tickets={[ticket("ticket-2", "搜索 B 站视频", "topic-a")]}
          onSteerTicket={onSteerTicket}
          onResolveHandoff={onResolveHandoff}
        />,
      );
      // Bind fake DOM refs onto the rendered PreviewViewport stage & image
      const stage = findElements(tree, (el) => el.type === "div" && el.props.className === "kulo-computer-preview-modal-stage")[0]!;
      const img = findElements(tree, (el) => el.type === "img" && el.props.className === "kulo-computer-preview-image")[0]!;
      const stageRefObj = stage.props.ref as { current: HTMLDivElement | null } | undefined;
      if (stageRefObj) stageRefObj.current = mockStageEl;
      const imgRefObj = img.props.ref as { current: HTMLImageElement | null } | undefined;
      if (imgRefObj) imgRefObj.current = mockImgEl;
      return { tree, stage };
    };

    let { tree, stage } = renderHandoff();

    // Verify Mod+/ during interactive takeover does NOT expand composer (no global shortcut)
    const modSlash = {
      key: "/",
      code: "Slash",
      keyCode: 191,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
    };
    (stage.props.onKeyDown as (e: unknown) => void)(modSlash);
    (stage.props.onKeyUp as (e: unknown) => void)(modSlash);
    ({ tree, stage } = renderHandoff());
    expect(findElements(tree, (el) => el.type === TextArea)).toHaveLength(0);

    // Hold a key and press mouse button on the remote viewport without releasing
    sentInputs.length = 0;
    (stage.props.onPointerDown as (e: unknown) => void)({
      clientX: 250,
      clientY: 125,
      button: 0,
      detail: 1,
      pointerType: "mouse",
      pointerId: 1,
    });
    (stage.props.onKeyDown as (e: unknown) => void)({
      key: "a",
      code: "KeyA",
      keyCode: 65,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
    });
    expect(sentInputs.map((ev) => ("eventType" in ev ? ev.eventType : ev.type))).toEqual(["mousePressed", "keyDown"]);

    // Click 发指令… -> synchronously flushes mouseReleased + keyUp to remote BEFORE expanding
    sentInputs.length = 0;
    findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发指令…"),
    )[0]!.props.onPress?.({} as never);
    expect(sentInputs).toEqual([
      expect.objectContaining({ type: "input_mouse", eventType: "mouseReleased", x: 250, y: 125, button: "left" }),
      expect.objectContaining({ type: "input_keyboard", eventType: "keyUp", key: "a", code: "KeyA" }),
    ]);

    ({ tree, stage } = renderHandoff());

    // While expanded: Modal.Backdrop disables Esc dismiss and PreviewViewport completely suspends keyboard forwarding
    const backdropExpanded = findElements<ComponentProps<typeof Modal.Backdrop>>(tree, (el) => el.type === Modal.Backdrop)[0]!;
    expect(backdropExpanded.props.isKeyboardDismissDisabled).toBe(true);
    expect(stage.props.onKeyDown).toBeUndefined();
    expect(stage.props.onKeyUp).toBeUndefined();
    expect(stage.props["data-keyboard-suspended"]).toBe(true);

    // Typing in composer emits ZERO remote input events
    sentInputs.length = 0;
    const field = findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!;
    const area = findElements<ComponentProps<typeof TextArea>>(tree, (el) => el.type === TextArea)[0]!;
    field.props.onChange?.("已登录完成");
    area.props.onKeyDown?.({
      key: "a",
      code: "KeyA",
      keyCode: 65,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: { value: "已登录完成", selectionStart: 5, selectionEnd: 5 },
    } as never);
    expect(sentInputs).toHaveLength(0);

    // Press capture-phase Esc -> collapses composer ONLY, does NOT close modal, and restores focus to stageRef
    const esc = {
      key: "Escape",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      isComposing: false,
      keyCode: 27,
      preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }),
      stopPropagation: vi.fn(),
    };
    for (const listener of [...captureListeners]) listener(esc as unknown as KeyboardEvent);
    ({ tree, stage } = renderHandoff());

    expect(esc.preventDefault).toHaveBeenCalledTimes(1);
    expect(closeModal).not.toHaveBeenCalled();
    expect(mockStageFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(findElements<ComponentProps<typeof Modal.Backdrop>>(tree, (el) => el.type === Modal.Backdrop)[0]!.props.isKeyboardDismissDisabled).toBe(false);
    expect(typeof stage.props.onKeyDown).toBe("function");

    // Re-open composer and verify independent Handoff dual buttons: 发消息 vs 完成接管
    findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发指令…"),
    )[0]!.props.onPress?.({} as never);
    ({ tree } = renderHandoff());
    findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.onChange?.("只补充一句，保持接管");
    ({ tree } = renderHandoff());
    await findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发消息"),
    )[0]!.props.onPress?.({} as never);
    expect(onSteerTicket).toHaveBeenCalledTimes(1);
    expect(onSteerTicket).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: "ticket_preview", ticketId: "ticket-2", previewSessionId: "handoff-browser" }),
      "只补充一句，保持接管",
    );
    expect(onResolveHandoff).not.toHaveBeenCalled();

    // Now expand again and click 完成接管 -> calls resolveComputerHandoff(ticketId, "done", text)
    ({ tree } = renderHandoff());
    findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发指令…"),
    )[0]!.props.onPress?.({} as never);
    ({ tree } = renderHandoff());
    findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.onChange?.("已通过验证，继续执行");
    ({ tree } = renderHandoff());
    await findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("完成接管"),
    )[0]!.props.onPress?.({} as never);
    expect(onResolveHandoff).toHaveBeenCalledTimes(1);
    expect(onResolveHandoff).toHaveBeenCalledWith("ticket-2", "done", "已通过验证，继续执行");
  });

  it("flushes active touches, dragged mouse buttons at latest coordinates, and held keys cleanly via RemoteInputTracker", () => {
    const tracker = new RemoteInputTracker();
    tracker.recordTouchStart(7, 10, 20);
    tracker.recordTouchMove(7, 50, 60);
    tracker.recordMouseDown("left", 100, 100);
    tracker.recordMouseMove(140, 180);
    tracker.recordKeyDown("Shift", "ShiftLeft", 16);
    expect(tracker.hasHeldInputs()).toBe(true);

    const flushed: ComputerPreviewInputEvent[] = [];
    const count = tracker.flush((ev) => {
      flushed.push(ev);
      return true;
    });
    expect(count).toBe(3);
    expect(tracker.hasHeldInputs()).toBe(false);
    expect(flushed).toEqual([
      { type: "input_touch", eventType: "touchEnd", touchPoints: [{ x: 50, y: 60, id: 7 }] },
      { type: "input_mouse", eventType: "mouseReleased", x: 140, y: 180, button: "left", clickCount: 1, modifiers: 0 },
      { type: "input_keyboard", eventType: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 },
    ]);
  });
});
