import { useEffect, useLayoutEffect, useRef, type DependencyList, type MutableRefObject, type RefObject } from "react";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface ChatScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ChatScrollStateInput {
  metrics: ChatScrollMetrics;
  nearThreshold: number;
  showButtonThreshold?: number;
  navigating?: boolean;
  scrollingToLatest?: boolean;
}

export interface ChatScrollStateResult {
  distance: number;
  nearBottom: boolean;
  showToBottom: boolean;
  scrollingToLatest: boolean;
}

export function computeChatScrollState({
  metrics,
  nearThreshold,
  showButtonThreshold = nearThreshold,
  navigating = false,
  scrollingToLatest = false,
}: ChatScrollStateInput): ChatScrollStateResult {
  const distance = Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
  const isNear = distance < nearThreshold;
  if (scrollingToLatest) {
    if (isNear) {
      return { distance, nearBottom: !navigating, showToBottom: false, scrollingToLatest: false };
    }
    return { distance, nearBottom: true, showToBottom: false, scrollingToLatest: true };
  }
  return {
    distance,
    nearBottom: isNear && !navigating,
    showToBottom: distance > showButtonThreshold,
    scrollingToLatest: false,
  };
}

export interface UseChatAutoScrollOptions {
  scrollRef: RefObject<HTMLElement | null>;
  nearBottomRef: MutableRefObject<boolean>;
  enabled?: boolean;
  skipRef?: MutableRefObject<boolean>;
  scrollingToLatestRef?: MutableRefObject<boolean>;
  onDetach?: () => void;
}

/**
 * Keeps a chat viewport anchored to its latest content before paint without hijacking user scrolls.
 * Observes only the scroll container's own `clientHeight` (e.g. composer/footer/pinned bar resizes),
 * never inner content growth from disclosures or embedded settings forms.
 */
export function useChatAutoScroll(
  {
    scrollRef,
    nearBottomRef,
    enabled = true,
    skipRef,
    scrollingToLatestRef,
    onDetach,
  }: UseChatAutoScrollOptions,
  deps: DependencyList,
): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onDetachRef = useRef(onDetach);
  onDetachRef.current = onDetach;

  useIsomorphicLayoutEffect(() => {
    if (!enabled) return;
    if (skipRef?.current) {
      skipRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [enabled, ...deps]);

  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;

    const detach = () => {
      nearBottomRef.current = false;
      if (scrollingToLatestRef) scrollingToLatestRef.current = false;
      onDetachRef.current?.();
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) detach();
    };

    let touchStartY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
      if (scrollingToLatestRef) scrollingToLatestRef.current = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchStartY === null) return;
      const currentY = event.touches[0]?.clientY;
      if (currentY !== undefined && currentY - touchStartY > 4) {
        detach();
      }
    };
    const onTouchEnd = () => {
      touchStartY = null;
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      let previousClientHeight = el.clientHeight;
      observer = new ResizeObserver(() => {
        const nextClientHeight = el.clientHeight;
        if (nextClientHeight === previousClientHeight) return;
        previousClientHeight = nextClientHeight;
        if (!enabledRef.current || !nearBottomRef.current || skipRef?.current) return;
        el.scrollTop = el.scrollHeight;
      });
      observer.observe(el);
    }

    return () => {
      observer?.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, scrollRef, nearBottomRef, skipRef, scrollingToLatestRef]);
}
