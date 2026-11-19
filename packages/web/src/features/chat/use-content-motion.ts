import { createElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export function useReducedContentMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches || document.documentElement.dataset.reduceMotion === "true");
    const observer = new MutationObserver(update);
    update();
    query.addEventListener("change", update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
    return () => { query.removeEventListener("change", update); observer.disconnect(); };
  }, []);
  return reduced;
}

function hasReducedMotion(): boolean {
  return document.documentElement.dataset.reduceMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The wrapper owns completion, so a child's animation cannot remove its card. */
export function useContentMotion(ref: RefObject<HTMLElement | null>, { present, animateEntry = false, animateExit = true, onExited }: {
  present: boolean;
  animateEntry?: boolean;
  animateExit?: boolean;
  onExited?: () => void;
}): void {
  const reduced = useReducedContentMotion();
  const first = useRef(true);
  const exited = useRef(onExited); exited.current = onExited;
  const animations = useRef<Animation[]>([]);
  const interruptedFrame = useRef<{ height: number; opacity: string } | null>(null);
  const desired = useRef(present); desired.current = present;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const initial = first.current; first.current = false;
    if (!present) for (const media of node.querySelectorAll("audio, video")) (media as HTMLMediaElement).pause();
    const wasAnimating = animations.current.length > 0;
    const previousHeight = interruptedFrame.current?.height ?? node.getBoundingClientRect().height;
    const previousOpacity = interruptedFrame.current?.opacity ?? getComputedStyle(node).opacity;
    interruptedFrame.current = null;
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    if (reduced || hasReducedMotion() || !present && !animateExit || typeof node.animate !== "function") {
      if (!present) exited.current?.();
      return;
    }
    if (present) {
      if ((initial && animateEntry) || wasAnimating) {
        const opacity = node.animate([{ opacity: wasAnimating ? previousOpacity : 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
        const next = [opacity];
        if (wasAnimating) next.push(node.animate([{ height: `${previousHeight}px` }, { height: `${node.scrollHeight}px` }], { duration: 200, easing: "cubic-bezier(.25,.46,.45,.94)" }));
        animations.current = next;
        Promise.all(next.map((animation) => animation.finished)).then(() => { if (desired.current) animations.current = []; }, () => {});
      }
    } else {
      const opacity = node.animate([{ opacity: previousOpacity }, { opacity: 0 }], { duration: 100, easing: "ease-out", fill: "forwards" });
      const height = node.animate([{ height: `${previousHeight}px`, marginBlock: getComputedStyle(node).marginBlock }, { height: "0px", marginBlock: "0px" }], { duration: 200, easing: "cubic-bezier(.25,.46,.45,.94)", fill: "forwards" });
      animations.current = [opacity, height];
      Promise.all([opacity.finished, height.finished]).then(() => { if (!desired.current) exited.current?.(); }, () => {});
    }
    return () => {
      if (animations.current.length) interruptedFrame.current = { height: node.getBoundingClientRect().height, opacity: getComputedStyle(node).opacity };
      for (const animation of animations.current) animation.cancel();
    };
  }, [present, animateEntry, animateExit, reduced, ref]);
}

export function ContentPresence({ present = true, animateEntry = false, animateExit = true, onExited, children }: {
  present?: boolean;
  animateEntry?: boolean;
  animateExit?: boolean;
  onExited?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useContentMotion(ref, { present, animateEntry, animateExit, onExited });
  return createElement("div", { ref, className: "moco-chat-content-presence", "data-exiting": !present || undefined, "aria-hidden": !present || undefined, inert: !present || undefined }, children);
}

export function useContentResize(ref: RefObject<HTMLElement | null>, changeKey: string | boolean): () => void {
  const previous = useRef<number | undefined>(undefined);
  const running = useRef<Animation | null>(null);
  const reduced = useReducedContentMotion();
  useLayoutEffect(() => {
    const node = ref.current;
    running.current?.cancel(); running.current = null;
    if (!node || previous.current === undefined) return;
    const from = previous.current; previous.current = undefined;
    const to = node.getBoundingClientRect().height;
    if (reduced || hasReducedMotion() || typeof node.animate !== "function" || from === to) return;
    const animation = node.animate([{ height: `${from}px`, maxHeight: `${from}px` }, { height: `${to}px`, maxHeight: `${to}px` }], { duration: 200, easing: "cubic-bezier(.25,.46,.45,.94)" });
    running.current = animation;
    return () => { animation.cancel(); };
  }, [changeKey, reduced, ref]);
  return () => { previous.current = ref.current?.getBoundingClientRect().height; };
}
