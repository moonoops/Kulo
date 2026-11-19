import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNavigationMotion } from "../packages/web/src/features/shell/navigation-motion";
import { interruptSettingsTransition, transitionSettingsLayout } from "../packages/web/src/features/shell/settings-transition";

const hubRequire = createRequire(new URL("../packages/hub/package.json", import.meta.url));
const { parseHTML } = hubRequire("linkedom") as {
  parseHTML: (html: string) => { document: Document; window: Window & typeof globalThis };
};

interface PlayedAnimation {
  element: HTMLElement;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: Animation;
  finish: () => void;
  cancel: ReturnType<typeof vi.fn>;
}

let document: Document;
let played: PlayedAnimation[];
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let cleanup: (() => void) | undefined;
let systemReduced: boolean;
let mediaListeners: Set<() => void>;
let sampled: Map<Element, Partial<CSSStyleDeclaration>>;

async function mutations() {
  await Promise.resolve();
  await Promise.resolve();
}

async function paint() {
  await mutations();
  const scheduled = [...frames.values()];
  frames.clear();
  scheduled.forEach((callback) => callback(0));
  await mutations();
}

function add(markup: string) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = markup;
  document.body.append(wrapper);
  return wrapper;
}

function surface(key = "one", attributes = 'data-moco-navigation="content"') {
  return add(`<section data-moco-navigation-key="${key}" ${attributes}><textarea>draft</textarea><p>original</p></section>`)
    .firstElementChild as HTMLElement;
}

beforeEach(() => {
  const dom = parseHTML("<html><body class=\"moco-ui\"></body></html>");
  const HTMLElementClass = dom.window.HTMLElement;
  const Observer = dom.window.MutationObserver;
  document = dom.document;
  frames = new Map();
  played = [];
  sampled = new Map();
  mediaListeners = new Set();
  nextFrame = 0;
  systemReduced = false;
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HTMLElementClass);
  vi.stubGlobal("MutationObserver", Observer);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  vi.stubGlobal("getComputedStyle", vi.fn((element: Element) => ({
    opacity: "1", translate: "none", direction: "ltr", ...sampled.get(element),
  })));
  vi.stubGlobal("window", { matchMedia: (query: string) => ({
    get matches() { return query.includes("min-width") || systemReduced; },
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
  }) });
  Object.defineProperty(HTMLElementClass.prototype, "getClientRects", { configurable: true, value: () => [{}] });
  Object.defineProperty(HTMLElementClass.prototype, "animate", { configurable: true, value: function (
    this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions,
  ) {
    let finish!: () => void;
    let reject!: (reason: unknown) => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const cancel = vi.fn(() => reject(new DOMException("Cancelled", "AbortError")));
    const animation = { id: "", finished, cancel } as unknown as Animation;
    played.push({ element: this, frames: keyframes, options, animation, finish, cancel });
    return animation;
  } });
});

afterEach(async () => {
  cleanup?.();
  cleanup = undefined;
  interruptSettingsTransition();
  await mutations();
  vi.unstubAllGlobals();
});

describe("global navigation motion", () => {
  it("seeds current views without animating initial rendering, then animates identity changes once", async () => {
    const view = surface();
    cleanup = installNavigationMotion();
    await paint();
    expect(played).toHaveLength(0);
    view.dataset.mocoNavigationKey = "two";
    await paint();
    expect(played).toHaveLength(1);
    expect(played[0].element).toBe(view);
    expect(played[0].animation.id).toBe("moco-navigation");
    expect(played[0].options.duration).toBe(160);
    expect(played[0].frames).toEqual([
      { opacity: "0", translate: "0px 4px" }, { opacity: "1", translate: "0px 0px" },
    ]);
    await paint();
    expect(played).toHaveLength(1);
  });

  it("does not replay for streaming text, ordinary child rendering, drafts or unchanged identity", async () => {
    const view = surface();
    cleanup = installNavigationMotion();
    view.querySelector("p")!.firstChild!.textContent = "streaming response";
    view.querySelector("textarea")!.value = "kept draft";
    view.append(document.createElement("strong"));
    view.dataset.mocoNavigationKey = "one";
    await paint();
    expect(played).toHaveLength(0);
    expect(view.querySelector("textarea")!.value).toBe("kept draft");
  });

  it("waits for the latest destination to be ready without adding a minimum loading duration", async () => {
    const view = surface();
    cleanup = installNavigationMotion();
    view.dataset.mocoNavigationKey = "two";
    view.dataset.mocoNavigationReady = "false";
    await paint();
    expect(played).toHaveLength(0);
    view.dataset.mocoNavigationKey = "three";
    await paint();
    view.dataset.mocoNavigationReady = "true";
    await paint();
    expect(played).toHaveLength(1);
    expect(played[0].element.dataset.mocoNavigationKey).toBe("three");
    expect(played[0].options.delay).toBeUndefined();
  });

  it("coalesces rapid changes to the latest frame instead of queueing every destination", async () => {
    const view = surface();
    cleanup = installNavigationMotion();
    view.dataset.mocoNavigationKey = "two";
    view.dataset.mocoNavigationKey = "three";
    view.dataset.mocoNavigationKey = "four";
    await paint();
    expect(played).toHaveLength(1);
    expect(view.dataset.mocoNavigationKey).toBe("four");
  });

  it("interrupts its own animation from the displayed frame without cancelling unrelated effects", async () => {
    const view = surface();
    view.animate([{ opacity: 1 }], { duration: 900 });
    const unrelated = played[0];
    cleanup = installNavigationMotion();
    view.dataset.mocoNavigationKey = "two";
    await paint();
    const first = played[1];
    sampled.set(view, { opacity: "0.6", translate: "0px 2px" });
    view.dataset.mocoNavigationKey = "three";
    await paint();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(unrelated.cancel).not.toHaveBeenCalled();
    expect(played[2].frames[0]).toEqual({ opacity: "0.6", translate: "0px 2px" });
    first.finish();
    await mutations();
    view.dataset.mocoNavigationKey = "four";
    await paint();
    expect(played[2].cancel).toHaveBeenCalledOnce();
    expect(played).toHaveLength(4);
  });

  it("activates retained tab panels in both directions within their owning group", async () => {
    const wrapper = add(`<div class="tabs"><div role="tablist"><button role="tab" id="first-tab">First</button><button role="tab" id="second-tab">Second</button></div>
      <div class="tabs__panel" role="tabpanel" id="first" aria-labelledby="first-tab"><textarea>draft</textarea></div>
      <div class="tabs__panel" role="tabpanel" id="second" aria-labelledby="second-tab" inert data-inert="true">Second</div></div>`);
    const first = wrapper.querySelector<HTMLElement>("#first")!;
    const second = wrapper.querySelector<HTMLElement>("#second")!;
    const draft = first.querySelector("textarea");
    cleanup = installNavigationMotion();
    first.setAttribute("inert", "");
    first.dataset.inert = "true";
    second.removeAttribute("inert");
    delete second.dataset.inert;
    await paint();
    expect(played).toHaveLength(1);
    expect(played[0].element).toBe(second);
    expect(played[0].frames[0].translate).toBe("8px 0px");
    second.setAttribute("inert", "");
    second.dataset.inert = "true";
    first.removeAttribute("inert");
    delete first.dataset.inert;
    await paint();
    expect(played).toHaveLength(2);
    expect(played[1].frames[0].translate).toBe("-8px 0px");
    expect(first.querySelector("textarea")).toBe(draft);
    expect(draft!.value).toBe("draft");
    expect(played[0].cancel).toHaveBeenCalledOnce();
  });

  it("animates only the outer navigation boundary when a module and nested panels mount together", async () => {
    cleanup = installNavigationMotion();
    const wrapper = add('<section data-moco-navigation-key="module" data-moco-navigation="content"><div class="tabs"><div class="tabs__panel" role="tabpanel" id="nested">Nested</div></div></section>');
    await paint();
    expect(played).toHaveLength(1);
    expect(played[0].element).toBe(wrapper.firstElementChild);
  });

  it.each(["hide", "navigate"])("cancels retained child motion when its ancestor changes through %s", async (change) => {
    const wrapper = add('<section data-moco-navigation-key="module:one" data-moco-navigation="content"><div data-moco-navigation-key="nested:one" data-moco-navigation="content"><textarea>retained draft</textarea></div></section>');
    const parent = wrapper.firstElementChild as HTMLElement;
    const child = parent.firstElementChild as HTMLElement;
    const draft = child.querySelector("textarea");
    cleanup = installNavigationMotion();
    child.dataset.mocoNavigationKey = "nested:two";
    await paint();
    expect(played).toHaveLength(1);
    expect(played[0].element).toBe(child);
    if (change === "hide") parent.setAttribute("inert", "");
    else parent.dataset.mocoNavigationKey = "module:two";
    await paint();
    expect(played[0].cancel).toHaveBeenCalledOnce();
    if (change === "hide") {
      expect(played).toHaveLength(1);
      parent.removeAttribute("inert");
      await paint();
    }
    expect(played).toHaveLength(2);
    expect(played[1].element).toBe(parent);
    expect(child.querySelector("textarea")).toBe(draft);
    expect(draft!.value).toBe("retained draft");
  });

  it.each([
    ['data-moco-navigation="none"', ""],
    ["hidden", ""],
    ["inert", ""],
    ["", 'data-entering="true"'],
  ])("skips opt-out, hidden and already entering surfaces (%s %s)", async (attributes, parentAttributes) => {
    cleanup = installNavigationMotion();
    add(`<div ${parentAttributes}><section data-moco-navigation-key="destination" ${attributes}>Visible content</section></div>`);
    await paint();
    expect(played).toHaveLength(0);
  });

  it.each(["system", "application"])("cancels and skips navigation when %s reduced motion is enabled", async (preference) => {
    const view = surface();
    cleanup = installNavigationMotion();
    view.dataset.mocoNavigationKey = "two";
    await paint();
    if (preference === "system") {
      systemReduced = true;
      mediaListeners.forEach((listener) => listener());
    } else document.documentElement.dataset.reduceMotion = "true";
    await mutations();
    expect(played[0].cancel).toHaveBeenCalledOnce();
    view.dataset.mocoNavigationKey = "three";
    await paint();
    expect(played).toHaveLength(1);
    expect(view.textContent).toContain("original");
  });

  it("leaves the destination usable when native element animation is unavailable", async () => {
    const view = surface();
    Object.defineProperty(view, "animate", { value: undefined });
    cleanup = installNavigationMotion();
    view.dataset.mocoNavigationKey = "two";
    await paint();
    expect(played).toHaveLength(0);
    expect(view.querySelector("textarea")!.value).toBe("draft");
    expect(view.getAttribute("style")).toBeNull();
  });

  it("uses the fade-only fallback for unspecified views and releases completed motion", async () => {
    const view = surface("one", "");
    cleanup = installNavigationMotion();
    view.dataset.mocoNavigationKey = "two";
    await paint();
    expect(played[0].options.duration).toBe(140);
    expect(played[0].frames[0].translate).toBe("0px 0px");
    played[0].finish();
    await mutations();
    cleanup();
    cleanup = undefined;
    expect(played[0].cancel).not.toHaveBeenCalled();
  });

  it("cancels pending frames and running motion on cleanup without changing existing DOM", async () => {
    const view = surface();
    cleanup = installNavigationMotion();
    view.dataset.mocoNavigationKey = "two";
    await paint();
    const draft = view.querySelector("textarea");
    view.dataset.mocoNavigationKey = "three";
    await mutations();
    expect(frames.size).toBe(1);
    cleanup();
    cleanup = undefined;
    expect(frames.size).toBe(0);
    expect(played[0].cancel).toHaveBeenCalledOnce();
    expect(mediaListeners.size).toBe(0);
    view.dataset.mocoNavigationKey = "four";
    await paint();
    expect(played).toHaveLength(1);
    expect(view.querySelector("textarea")).toBe(draft);
  });

  it("lets a newer navigation interrupt an active settings snapshot immediately", async () => {
    const view = surface("settings:one");
    cleanup = installNavigationMotion();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const skipTransition = vi.fn();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: (capture: () => void) => {
      capture();
      return { ready: Promise.resolve(), finished, skipTransition };
    } });
    transitionSettingsLayout("enter", () => {});
    expect(document.documentElement.dataset.mocoTransition).toBe("enter");
    view.dataset.mocoNavigationKey = "settings:two";
    await paint();
    expect(skipTransition).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.mocoTransition).toBeUndefined();
    expect(played).toHaveLength(1);
    finish();
    await mutations();
  });

  it.each(["system", "application"])("interrupts an active settings snapshot when %s reduced motion is enabled", async (preference) => {
    surface("settings:one");
    cleanup = installNavigationMotion();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const skipTransition = vi.fn();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: (capture: () => void) => {
      capture();
      return { ready: Promise.resolve(), finished, skipTransition };
    } });
    transitionSettingsLayout("enter", () => {});
    expect(document.documentElement.dataset.mocoTransition).toBe("enter");
    if (preference === "system") {
      systemReduced = true;
      mediaListeners.forEach((listener) => listener());
    } else document.documentElement.dataset.reduceMotion = "true";
    await mutations();
    expect(skipTransition).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.mocoTransition).toBeUndefined();
    expect(played).toHaveLength(0);
    finish();
    await mutations();
  });
});
