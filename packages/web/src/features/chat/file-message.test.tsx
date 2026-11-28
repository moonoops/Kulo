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
import { HTML_ARTIFACT_CSP, htmlArtifactDocument, isHtmlArtifact, type ChatAttachment, type TopicSummary } from "@kulo/protocol";
import { UserAttachmentList } from "../../kulo-composer";
import { FileMessage } from "./file-message";
import { MAX_OFFICE_PREVIEW_BYTES } from "./file-preview-model";
import { MessageContent } from "./message-content";
import {
  ModalFooterComposer,
  PreviewCommandProvider,
  getFrozenTargetUnavailableReason,
  type ModalFooterComposerTarget,
} from "./modal-footer-composer";

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
      return (ctx as unknown as { _currentValue?: unknown })._currentValue;
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

const EXPANDED_COMPONENTS = new Set<unknown>([FileMessage, ModalFooterComposer, PreviewCommandProvider]);

function expandTree(node: ReactNode, path = "root", mounted = new Set<string>()): ReactNode {
  if (Array.isArray(node)) {
    return node.map((child, index) => expandTree(child, `${path}[${index}]`, mounted));
  }
  if (!isValidElement<{ children?: ReactNode; value?: unknown }>(node)) return node;

  const type = node.type as unknown;
  if (typeof type === "object" && type !== null && "$$typeof" in type && "Provider" in (type as Record<string, unknown>)) {
    // React 19 Context rendered as <Context value={...}>
    const stack = harness.contextStack.get(type) ?? [];
    stack.push(node.props.value);
    harness.contextStack.set(type, stack);
    try {
      return expandTree(node.props.children, `${path}:ctx`, mounted);
    } finally {
      stack.pop();
    }
  }
  if (typeof type === "object" && type !== null && "_context" in (type as Record<string, unknown>)) {
    const ctx = (type as { _context: unknown })._context;
    const stack = harness.contextStack.get(ctx) ?? [];
    stack.push(node.props.value);
    harness.contextStack.set(ctx, stack);
    try {
      return expandTree(node.props.children, `${path}:ctx`, mounted);
    } finally {
      stack.pop();
    }
  }

  if (EXPANDED_COMPONENTS.has(type)) {
    const key = node.key !== null ? `${path}:${String(node.key)}` : `${path}:${(type as { name?: string }).name ?? "fn"}`;
    mounted.add(key);
    const prevKey = harness.currentKey;
    harness.currentKey = key;
    const inst = currentInstance();
    inst.cursor = 0;
    inst.effectCursor = 0;
    inst.layoutEffectCursor = 0;
    const rendered = (type as (props: Record<string, unknown>) => ReactNode)(node.props as Record<string, unknown>);
    harness.currentKey = prevKey;
    return expandTree(rendered, key, mounted);
  }

  if (node.props.children !== undefined) {
    return {
      ...node,
      props: {
        ...node.props,
        children: expandTree(node.props.children, `${path}/${typeof type === "string" ? type : "el"}`, mounted),
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

const html: ChatAttachment = { id: "first", name: "可交互报告.html", kind: "file", mimeType: "text/html", size: 1024, url: "/api/uploads/first" };

beforeEach(() => resetHarness());
afterEach(() => {
  resetHarness();
  vi.unstubAllGlobals();
});

describe("message artifacts", () => {
  it("offers HTML preview controls while preserving an ordinary binary file's compact download", () => {
    const markup = renderToStaticMarkup(<FileMessage asset={html} />);
    expect(markup).toContain("card--secondary");
    expect(markup).toContain('data-kind="html"');
    for (const label of ["放大预览：可交互报告.html", "在浏览器打开：可交互报告.html", "文件选项：可交互报告.html"]) expect(markup).toContain(label);
    const archive = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "资料包.zip", mimeType: "application/zip" }} />);
    expect(archive).toContain("下载文件：资料包.zip");
    expect(archive).not.toContain("放大");
    expect(archive).not.toContain("在默认应用打开");
    const legacy = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "旧方案.doc", mimeType: "application/octet-stream" }} />);
    expect(legacy).toContain("下载文件：旧方案.doc");
    expect(legacy).not.toContain("放大");
  });

  it("shows the default-app action in the desktop renderer", () => {
    vi.stubGlobal("window", { kuloDesktop: { openFile: vi.fn(), saveFile: vi.fn() } });
    const archiveMarkup = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "照明方案.zip", mimeType: "application/zip" }} />);
    expect(archiveMarkup).toContain("在默认应用打开：照明方案.zip");
    expect(archiveMarkup).toContain("下载文件：照明方案.zip");
    const pptxMarkup = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "照明方案.pptx", mimeType: "application/octet-stream" }} />);
    expect(pptxMarkup).toContain('data-kind="pptx"');
    expect(pptxMarkup).toContain("在默认应用打开：照明方案.pptx");
    expect(pptxMarkup).toContain("放大预览：照明方案.pptx");
    const htmlMarkup = renderToStaticMarkup(<FileMessage asset={html} />);
    expect(htmlMarkup).toContain("在默认应用打开：可交互报告.html");
    expect(htmlMarkup).not.toContain("aria-label=\"在浏览器打开：可交互报告.html\"");
  });

  it("renders assistant files inline by default while showing user-sent files as compact thumbnails", () => {
    const assistant = renderToStaticMarkup(<MessageContent item={{ id: 1, role: "assistant", text: "结果如下", attachments: [html, { ...html, id: "second", name: "另一份.html" }] }} />);
    expect(assistant.match(/class="kulo-artifact-inline-stage"/g)).toHaveLength(2);
    expect(assistant).not.toContain('class="kulo-artifact-inline-stage" hidden=""');
    expect(assistant).not.toContain('data-compact="true"');
    expect(assistant).toContain("展开阅读：可交互报告.html");

    const supportedFiles: Array<[string, string, string]> = [
      ["可交互报告.html", "text/html", "html"],
      ["报告.pdf", "application/pdf", "pdf"],
      ["说明.md", "text/markdown", "markdown"],
      ["记录.txt", "text/plain", "text"],
      ["报表.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
      ["汇报.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
      ["纪要.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ];

    for (const [name, mimeType, kind] of supportedFiles) {
      const asset: ChatAttachment = { ...html, id: `asset-${kind}`, name, mimeType };

      const assistantMarkup = renderToStaticMarkup(
        <MessageContent item={{ id: 10, role: "assistant", text: "已生成文件", attachments: [asset] }} />,
      );
      expect(assistantMarkup).toContain(`data-kind="${kind}"`);
      expect(assistantMarkup).not.toContain('data-compact="true"');
      expect(assistantMarkup).not.toContain('class="kulo-artifact-inline-stage" hidden=""');
      expect(assistantMarkup).toContain(`放大预览：${name}`);
      expect(assistantMarkup).toContain(`展开阅读：${name}`);

      const userMarkup = renderToStaticMarkup(
        <MessageContent item={{ id: 20, role: "user", text: "请看这个文件", attachments: [asset] }} />,
      );
      expect(userMarkup).toContain(`data-kind="${kind}"`);
      expect(userMarkup).toContain('data-compact="true"');
      expect(userMarkup).toContain('class="kulo-artifact-inline-stage" hidden=""');
      expect(userMarkup).toContain(`预览文件：${name}`);
      expect(userMarkup).toContain(`文件选项：${name}`);
      expect(userMarkup).not.toContain(`展开阅读：${name}`);
      for (const button of userMarkup.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
        expect(button.match(/<button\b/g)).toHaveLength(1);
      }
    }

    const userZip = renderToStaticMarkup(
      <MessageContent item={{ id: 21, role: "user", text: "资料包", attachments: [{ ...html, id: "zip1", name: "资料包.zip", mimeType: "application/zip" }] }} />,
    );
    expect(userZip).toContain('data-compact="true"');
    expect(userZip).toContain("下载文件：资料包.zip");
    expect(userZip).not.toContain("预览文件：资料包.zip");
    expect(userZip).not.toContain("此文件暂不支持内嵌预览");

    const legacyUserList = renderToStaticMarkup(
      <UserAttachmentList attachments={[{ ...html, id: "pdf1", name: "手册.pdf", mimeType: "application/pdf" }]} />,
    );
    expect(legacyUserList).toContain('data-compact="true"');
    expect(legacyUserList).toContain('class="kulo-artifact-inline-stage" hidden=""');
    expect(legacyUserList).toContain("预览文件：手册.pdf");
  });

  it("degrades oversized Office files above 15 MiB into compact non-previewable cards without Expand controls", () => {
    vi.stubGlobal("window", { kuloDesktop: { openFile: vi.fn(), saveFile: vi.fn() } });
    const huge = renderToStaticMarkup(
      <FileMessage asset={{ ...html, name: "超大图集.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: MAX_OFFICE_PREVIEW_BYTES + 1024 }} />,
    );
    expect(huge).toContain("文件超过 15 MB");
    expect(huge).toContain("在默认应用打开：超大图集.pptx");
    expect(huge).toContain("下载文件：超大图集.pptx");
    expect(huge).not.toContain("放大预览：超大图集.pptx");
    expect(huge).not.toContain("kulo-artifact-inline-stage");
  });

  it("preserves an explicitly collapsed preview and exposes a discoverable expand action", () => {
    const markup = renderToStaticMarkup(<FileMessage asset={html} defaultExpanded={false} />);
    expect(markup).toContain('class="kulo-artifact-inline-stage" hidden=""');
    expect(markup).toContain("展开预览：可交互报告.html");
    expect(markup).not.toContain("展开阅读：");
  });

  it("requires an HTML filename and MIME and isolates scripts from host data and network", () => {
    expect(isHtmlArtifact(html)).toBe(true);
    expect(isHtmlArtifact({ ...html, name: "INDEX.HTM", mimeType: "text/html; charset=utf-8" })).toBe(true);
    expect(isHtmlArtifact({ ...html, mimeType: "image/svg+xml" })).toBe(false);
    expect(isHtmlArtifact({ ...html, name: "report.txt" })).toBe(false);
    expect(HTML_ARTIFACT_CSP).toContain("sandbox allow-scripts allow-forms");
    expect(HTML_ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(HTML_ARTIFACT_CSP).toContain("form-action 'none'");
    expect(HTML_ARTIFACT_CSP).not.toMatch(/allow-same-origin|allow-popups|unsafe-eval/);
    const source = '<html><body style="background:peachpuff"><button onclick="this.textContent=42">计算</button></body></html>';
    expect(htmlArtifactDocument(source)).toContain(source);
    expect(htmlArtifactDocument(source)).toContain("scrollbar-width:thin");
  });
});

describe("FileMessage Modal.Footer inline quick-instruction composer (Stage 2 P1-2)", () => {
  const pdf: ChatAttachment = {
    id: "pdf-1",
    name: "季度复盘.pdf",
    kind: "file",
    mimeType: "application/pdf",
    size: 4096,
    url: "/api/uploads/pdf-1",
  };

  it("freezes the opening topicId and conversationId snapshot so switching topics in the background never cross-posts", async () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const onSendToTopic = vi.fn(async () => {});
    const renderWithTopic = (topicId: string, conversationId: number) =>
      renderStateful(
        <PreviewCommandProvider value={{ topicId, conversationId, connected: true, onSendToTopic }}>
          <FileMessage asset={pdf} />
        </PreviewCommandProvider>,
      );

    // Open large preview while viewing Topic A (conversationId: 101)
    let tree = renderWithTopic("topic-a", 101);
    const expandBtn = findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && el.props["aria-label"] === "放大预览：季度复盘.pdf",
    )[0]!;
    expandBtn.props.onPress?.({} as never);
    tree = renderWithTopic("topic-a", 101);

    // Switch active topic in the background to Topic B (conversationId: 202) while modal stays open
    tree = renderWithTopic("topic-b", 202);

    // Expand inline composer inside Modal.Footer and submit
    const footerTrigger = findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发指令…"),
    )[0]!;
    footerTrigger.props.onPress?.({} as never);
    tree = renderWithTopic("topic-b", 202);

    const field = findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!;
    field.props.onChange?.("帮我提炼第 3 页的风险点");
    tree = renderWithTopic("topic-b", 202);

    const sendBtn = findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发送"),
    )[0]!;
    await sendBtn.props.onPress?.({} as never);

    expect(onSendToTopic).toHaveBeenCalledTimes(1);
    expect(onSendToTopic).toHaveBeenCalledWith(
      {
        targetKind: "file",
        topicId: "topic-a",
        conversationId: 101,
        fileLabel: "季度复盘.pdf",
      } satisfies ModalFooterComposerTarget,
      "帮我提炼第 3 页的风险点",
    );
  });

  it("disables Modal.Backdrop Escape dismissal while composer is expanded so Escape only collapses the composer", () => {
    const captureListeners = new Set<(event: KeyboardEvent) => void>();
    vi.stubGlobal("document", {
      createElement: () => ({ nodeType: 1, className: "", dataset: {}, isConnected: false, parentElement: null }),
      addEventListener: (_type: string, fn: (event: KeyboardEvent) => void, capture?: boolean) => {
        if (capture) captureListeners.add(fn);
      },
      removeEventListener: (_type: string, fn: (event: KeyboardEvent) => void, capture?: boolean) => {
        if (capture) captureListeners.delete(fn);
      },
    });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

    const onSendToTopic = vi.fn(async () => {});
    const renderFile = () =>
      renderStateful(<FileMessage asset={pdf} topicId="topic-a" conversationId={101} onSendToTopic={onSendToTopic} />);

    let tree = renderFile();
    findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && el.props["aria-label"] === "放大预览：季度复盘.pdf",
    )[0]!.props.onPress?.({} as never);
    tree = renderFile();

    let backdrop = findElements<ComponentProps<typeof Modal.Backdrop>>(tree, (el) => el.type === Modal.Backdrop)[0]!;
    expect(backdrop.props.isOpen).toBe(true);
    expect(backdrop.props.isKeyboardDismissDisabled).toBe(false);

    // Expand inline composer -> Modal.Backdrop disables Esc dismiss
    findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发指令…"),
    )[0]!.props.onPress?.({} as never);
    tree = renderFile();

    backdrop = findElements<ComponentProps<typeof Modal.Backdrop>>(tree, (el) => el.type === Modal.Backdrop)[0]!;
    expect(backdrop.props.isOpen).toBe(true);
    expect(backdrop.props.isKeyboardDismissDisabled).toBe(true);
    expect(findElements(tree, (el) => el.type === TextArea)).toHaveLength(1);

    // Press Escape -> collapses composer only, large preview modal stays open
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
    tree = renderFile();

    expect(esc.preventDefault).toHaveBeenCalledTimes(1);
    backdrop = findElements<ComponentProps<typeof Modal.Backdrop>>(tree, (el) => el.type === Modal.Backdrop)[0]!;
    expect(backdrop.props.isOpen).toBe(true);
    expect(backdrop.props.isKeyboardDismissDisabled).toBe(false);
    expect(findElements(tree, (el) => el.type === TextArea)).toHaveLength(0);
  });

  it("keeps the user's draft intact when the original topic is archived while the file preview modal is open", async () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const onSendToTopic = vi.fn(async () => {});
    let topics: TopicSummary[] = [
      { id: "topic-a", title: "主题 A", conversationId: 101, createdAt: 1, updatedAt: 1 },
    ];
    const renderFile = () =>
      renderStateful(
        <FileMessage
          asset={pdf}
          topicId="topic-a"
          conversationId={101}
          connected
          getUnavailableReason={(target) => getFrozenTargetUnavailableReason(target, { connected: true, topics })}
          onSendToTopic={onSendToTopic}
        />,
      );

    let tree = renderFile();
    findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && el.props["aria-label"] === "放大预览：季度复盘.pdf",
    )[0]!.props.onPress?.({} as never);
    tree = renderFile();
    findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发指令…"),
    )[0]!.props.onPress?.({} as never);
    tree = renderFile();
    findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.onChange?.("保留这份问题草稿");

    // Archive original topic while modal is open
    topics = [{ id: "topic-a", title: "主题 A", conversationId: 101, archived: true, createdAt: 1, updatedAt: 2 }];
    tree = renderFile();

    await findElements<ComponentProps<typeof Button>>(
      tree,
      (el) => el.type === Button && textContent(el.props.children).includes("发送"),
    )[0]!.props.onPress?.({} as never);
    tree = renderFile();

    expect(onSendToTopic).not.toHaveBeenCalled();
    expect(findElements<ComponentProps<typeof TextField>>(tree, (el) => el.type === TextField)[0]!.props.value).toBe("保留这份问题草稿");
    const alerts = findElements(tree, (el) => el.props.role === "alert");
    expect(alerts.length).toBeGreaterThan(0);
    expect(textContent(alerts[0]!)).toContain("归档");
  });
});
