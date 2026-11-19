import { interruptSettingsTransition } from "./settings-transition";

const SURFACE = '[data-moco-navigation-key], .tabs__panel[role="tabpanel"]';
const INACTIVE = '[hidden], [inert], [data-inert="true"], [aria-hidden="true"], [data-exiting="true"]';
const EASING = "cubic-bezier(.2,.7,.2,1)";

interface SurfaceState {
  key: string;
  active: boolean;
  ready: boolean;
}

/** Observe navigation identity/activation, never message text, field values or render counts. */
export function installNavigationMotion(root: HTMLElement = document.body): () => void {
  const documentRoot = root.ownerDocument.documentElement;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const states = new WeakMap<HTMLElement, SurfaceState>();
  const tabs = new WeakMap<HTMLElement, number>();
  const running = new Map<HTMLElement, Animation>();
  const pending = new Set<HTMLElement>();
  let frame: number | undefined;

  const reduced = () => media.matches || Boolean(root.closest('[data-reduce-motion="true"]'));
  const stateOf = (element: HTMLElement): SurfaceState => ({
    key: element.dataset.mocoNavigationKey ?? element.id,
    active: !element.closest(INACTIVE),
    ready: element.dataset.mocoNavigationReady !== "false",
  });
  const tabPosition = (element: HTMLElement) => {
    if (!element.matches('.tabs__panel[role="tabpanel"]')) return undefined;
    const group = element.closest<HTMLElement>(".tabs");
    if (!group) return undefined;
    const label = element.getAttribute("aria-labelledby");
    const items = Array.from(group.querySelectorAll<HTMLElement>('[role="tab"]'))
      .filter((tab) => tab.closest(".tabs") === group);
    const index = items.findIndex((tab) => tab.id === label);
    return index < 0 ? undefined : { group, index };
  };
  const remember = (element: HTMLElement, state: SurfaceState) => {
    states.set(element, state);
    const position = state.active && tabPosition(element);
    if (position) tabs.set(position.group, position.index);
  };
  const cancel = (element: HTMLElement) => {
    running.get(element)?.cancel();
    running.delete(element);
  };
  const cancelAll = () => {
    for (const element of running.keys()) cancel(element);
  };
  const cancelBranch = (parent: HTMLElement) => {
    for (const element of running.keys()) if (element === parent || parent.contains(element)) cancel(element);
  };
  const stopReducedMotion = () => {
    if (!reduced()) return;
    cancelAll();
    if (documentRoot.dataset.mocoTransition) interruptSettingsTransition();
  };

  function flush() {
    frame = undefined;
    for (const element of running.keys()) if (!root.contains(element)) cancel(element);
    const candidates = [...pending].filter((element) => root.contains(element));
    pending.clear();
    const entering = candidates.flatMap((element) => {
      const before = states.get(element);
      const next = stateOf(element);
      const position = tabPosition(element);
      const direction = position && position.index < (tabs.get(position.group) ?? position.index) ? -1 : 1;
      remember(element, next);
      if (!next.active || !next.ready) { cancelBranch(element); return []; }
      const changed = !before || before.key !== next.key || !before.active || !before.ready;
      return changed ? [{ element, before, position, direction }] : [];
    });

    if (reduced()) { stopReducedMotion(); return; }
    // A second navigation must reveal its destination even while a settings snapshot is playing.
    if (documentRoot.dataset.mocoTransition && entering.some(({ before }) => before)) interruptSettingsTransition();
    if (documentRoot.dataset.mocoTransition) return;

    for (const { element, position, direction } of entering) {
      if (element.closest('[data-moco-navigation="none"], [data-entering], [data-exiting]')) continue;
      if (entering.some((other) => other.element !== element && other.element.contains(element))) continue;
      if ([...running.keys()].some((parent) => parent !== element && parent.contains(element))) continue;
      if (!element.getClientRects().length || typeof element.animate !== "function") continue;
      const previous = running.get(element);
      const current = previous ? getComputedStyle(element) : undefined;
      const content = element.dataset.mocoNavigation === "content";
      const horizontal = Boolean(position);
      const rtl = position && getComputedStyle(position.group).direction === "rtl";
      const offset = horizontal ? `${8 * direction * (rtl ? -1 : 1)}px 0px` : content ? "0px 4px" : "0px 0px";
      const from = { opacity: current?.opacity ?? "0", translate: current?.translate === "none" ? offset : current?.translate ?? offset };
      cancelBranch(element);
      const animation = element.animate([from, { opacity: "1", translate: "0px 0px" }], {
        duration: horizontal || content ? 160 : 140,
        easing: EASING,
      });
      animation.id = "moco-navigation";
      running.set(element, animation);
      const release = () => { if (running.get(element) === animation) running.delete(element); };
      void animation.finished.then(release, (error: unknown) => {
        release();
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error("页面过渡未完成。", error);
      });
    }
  }

  const collect = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(SURFACE)) pending.add(node);
    for (const element of node.querySelectorAll<HTMLElement>(SURFACE)) pending.add(element);
  };
  for (const element of root.querySelectorAll<HTMLElement>(SURFACE)) remember(element, stateOf(element));

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") for (const node of record.addedNodes) collect(node);
      else if (record.target instanceof HTMLElement && record.target.matches(SURFACE)) pending.add(record.target);
    }
    stopReducedMotion();
    if (frame === undefined && (pending.size || running.size)) frame = requestAnimationFrame(flush);
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["data-moco-navigation-key", "data-moco-navigation-ready", "inert", "data-inert", "hidden", "aria-hidden"] });
  const preferenceObserver = new MutationObserver(stopReducedMotion);
  preferenceObserver.observe(documentRoot, { subtree: true, attributes: true, attributeFilter: ["data-reduce-motion"] });
  const preferenceChanged = stopReducedMotion;
  media.addEventListener("change", preferenceChanged);

  return () => {
    observer.disconnect();
    preferenceObserver.disconnect();
    media.removeEventListener("change", preferenceChanged);
    if (frame !== undefined) cancelAnimationFrame(frame);
    pending.clear();
    cancelAll();
  };
}
