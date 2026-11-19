import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { useReducedContentMotion } from "../features/chat/use-content-motion";
import { CAT_NATIVE_FRAME_SIZE, CAT_SHEET_GRID, CAT_SHEET_URLS, getCatAppearance, getCatAppearanceCrop, type CatAppearance } from "./cat-catalog";
import {
  CAT_REACTION_COOLDOWN_MS, catAppearanceForState, catCanReact, catIsSleeping, catMotion,
  createCatAnimationLoop, type CatFrame, type CatState,
} from "./cat-motion";
import "./cat-avatar.css";

export type { CatState } from "./cat-motion";

interface CatAvatarProps {
  state?: CatState;
  appearance?: CatAppearance;
  animated?: boolean;
  attentionTarget?: HTMLElement | null;
  reactionKey?: number;
  className?: string;
}
interface Timeline { state: CatState; since: number; reactionKey: number; reactionSince: number }
type ResolvedProps = Required<Omit<CatAvatarProps, "attentionTarget">> & { attentionTarget: HTMLElement | null };

function position(column: CatFrame, row: number): string {
  return `${column * 100 / (CAT_SHEET_GRID - 1)}% ${row * 100 / (CAT_SHEET_GRID - 1)}%`;
}

export function catFrameStyle(appearance: ReturnType<typeof getCatAppearance>, frame: CatFrame): CSSProperties {
  const [x, y, size] = getCatAppearanceCrop(appearance.id);
  return {
    backgroundImage: `url("${CAT_SHEET_URLS[appearance.sheet]}")`,
    backgroundPosition: position(frame, appearance.row),
    width: `${CAT_NATIVE_FRAME_SIZE / size * 100}%`,
    height: `${CAT_NATIVE_FRAME_SIZE / size * 100}%`,
    left: `${-x / size * 100}%`,
    top: `${-y / size * 100}%`,
  };
}

export function CatAvatar({ state = "idle", appearance = "auto", animated = true, attentionTarget = null, reactionKey = 0, className = "" }: CatAvatarProps) {
  const timeline = useRef<Timeline>({ state, since: -1, reactionKey: 0, reactionSince: -Infinity });
  const props = { state, appearance, animated, attentionTarget, reactionKey, className };
  // Picker thumbnails take this path without subscribing to motion, visibility or pointer events.
  if (!animated) {
    const selected = getCatAppearance(catAppearanceForState(appearance, state, Boolean(attentionTarget)));
    const pose = catMotion(state, 0, { reduced: true });
    return <span className={`kulo-cat-avatar ${className}`.trim()} data-state={state} data-appearance={selected.id}
      data-frame={pose.frame} data-animated="false" aria-hidden="true">
      <span className="kulo-cat-avatar-sprite" style={catFrameStyle(selected, pose.frame)} />
    </span>;
  }
  return <AnimatedCatAvatar {...props} timeline={timeline} />;
}

function AnimatedCatAvatar({ state, appearance, attentionTarget, reactionKey, className, timeline }: ResolvedProps & { timeline: RefObject<Timeline> }) {
  const reduced = useReducedContentMotion();
  const elementRef = useRef<HTMLSpanElement>(null), spriteRef = useRef<HTMLSpanElement>(null);
  const selected = getCatAppearance(catAppearanceForState(appearance, state, Boolean(attentionTarget)));
  const initialFrame = catMotion(state, 0, { reduced }).frame;

  useEffect(() => {
    const element = elementRef.current!, sprite = spriteRef.current!;
    const clock = timeline.current;
    const now = performance.now();
    if (clock.since < 0 || clock.state !== state) {
      clock.state = state; clock.since = now; clock.reactionSince = -Infinity;
    }
    if (clock.reactionKey !== reactionKey) {
      clock.reactionKey = reactionKey;
      if (catCanReact(state) && now - clock.reactionSince >= CAT_REACTION_COOLDOWN_MS) clock.reactionSince = now;
    }
    const write = (frame: CatFrame) => {
      element.dataset.frame = String(frame);
      sprite.style.backgroundPosition = position(frame, selected.row);
    };
    // The shared hook initializes after mount; consult the live preference before any timer is installed.
    const still = reduced || document.documentElement.dataset.reduceMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.dataset.reducedMotion = String(still);
    element.dataset.animated = "false";
    if (still) {
      write(catMotion(state, now - clock.since, { reduced: true }).frame);
      return;
    }

    let loaded = false, visible = typeof IntersectionObserver === "undefined", disposed = false;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    const loop = createCatAnimationLoop(() => {
      const at = performance.now();
      const step = catMotion(state, at - clock.since, {
        sleeping: catIsSleeping(selected.id), reactionElapsed: at - clock.reactionSince,
      });
      write(step.frame);
      element.dataset.animated = String(step.nextIn !== null);
      return step;
    });
    const clearHover = () => {
      if (hoverTimer !== undefined) clearTimeout(hoverTimer);
      hoverTimer = undefined;
    };
    const update = () => {
      const active = loaded && visible && !document.hidden;
      if (!active) { clearHover(); element.dataset.animated = "false"; }
      loop.setActive(active);
    };
    const react = () => {
      const at = performance.now();
      if (!loaded || !visible || document.hidden || !catCanReact(state) || at - clock.reactionSince < CAT_REACTION_COOLDOWN_MS) return;
      clock.reactionSince = at; loop.wake();
    };
    const hover = (event: PointerEvent) => {
      clearHover();
      if (event.pointerType !== "touch" && catCanReact(state)) hoverTimer = setTimeout(react, 650);
    };
    const interaction = element.closest("button") ?? element;
    interaction.addEventListener("pointerenter", hover as EventListener);
    interaction.addEventListener("pointerleave", clearHover);
    interaction.addEventListener("focus", react);
    document.addEventListener("visibilitychange", update);
    const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting === true; update();
    }) : undefined;
    observer?.observe(element);
    const image = new Image();
    const loadedImage = () => {
      if (disposed) return;
      loaded = true; element.dataset.assetState = "ready"; update();
    };
    const failedImage = () => {
      if (disposed) return;
      element.dataset.assetState = "error";
      console.error(`Kulo cat animation could not be loaded: ${CAT_SHEET_URLS[selected.sheet]}`);
      loop.setActive(false);
    };
    image.addEventListener("load", loadedImage); image.addEventListener("error", failedImage);
    image.src = CAT_SHEET_URLS[selected.sheet]!;
    if (image.complete && image.naturalWidth > 0) loadedImage();
    return () => {
      disposed = true; clearHover(); loop.dispose(); observer?.disconnect();
      image.removeEventListener("load", loadedImage); image.removeEventListener("error", failedImage);
      interaction.removeEventListener("pointerenter", hover as EventListener);
      interaction.removeEventListener("pointerleave", clearHover);
      interaction.removeEventListener("focus", react);
      document.removeEventListener("visibilitychange", update);
    };
  }, [state, selected.id, selected.row, selected.sheet, reactionKey, reduced, timeline]);

  return <span ref={elementRef} className={`kulo-cat-avatar ${className}`.trim()} data-state={state}
    data-appearance={selected.id} data-frame={initialFrame} data-animated="false" aria-hidden="true">
    <span ref={spriteRef} className="kulo-cat-avatar-sprite" style={catFrameStyle(selected, initialFrame)} />
  </span>;
}
