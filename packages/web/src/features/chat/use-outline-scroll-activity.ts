import { useEffect, useState, type RefObject } from "react";

export function useOutlineScrollActivity(scrollRef: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [scrollable, setScrollable] = useState(false);
  const [scrolling, setScrolling] = useState(false);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !enabled) {
      setScrollable(false);
      setScrolling(false);
      return;
    }
    let overflow = false;
    let reading = false;
    let lastInput = -Infinity;
    let previousTop = scroll.scrollTop;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      overflow = scroll.scrollHeight - scroll.clientHeight > 2;
      setScrollable(overflow);
      if (!overflow) {
        reading = false;
        clearTimeout(idleTimer);
        setScrolling(false);
      }
    };
    const markInput = () => { lastInput = performance.now(); };
    const onWheel = (event: WheelEvent) => { if (event.deltaY) markInput(); };
    const onPointerDown = (event: PointerEvent) => { if (event.button === 0) markInput(); };
    const onPointerMove = (event: PointerEvent) => { if (event.buttons === 1) markInput(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) markInput();
    };
    const onScroll = () => {
      const moved = previousTop !== scroll.scrollTop;
      previousTop = scroll.scrollTop;
      // Initial positioning and streamed replies must not reveal the navigation on their own.
      const recentInput = performance.now() - lastInput < 700;
      const continuingRead = reading && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 2;
      if (!moved || !overflow || !recentInput && !continuingRead) return;
      reading = true;
      setScrolling(true);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { reading = false; setScrolling(false); }, 1000);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    measure();
    scroll.addEventListener("wheel", onWheel, { passive: true });
    scroll.addEventListener("touchmove", markInput, { passive: true });
    scroll.addEventListener("pointerdown", onPointerDown, { passive: true });
    scroll.addEventListener("pointermove", onPointerMove, { passive: true });
    scroll.addEventListener("keydown", onKeyDown);
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(idleTimer);
      observer.disconnect();
      scroll.removeEventListener("wheel", onWheel);
      scroll.removeEventListener("touchmove", markInput);
      scroll.removeEventListener("pointerdown", onPointerDown);
      scroll.removeEventListener("pointermove", onPointerMove);
      scroll.removeEventListener("keydown", onKeyDown);
      scroll.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, enabled]);

  return { scrollable, scrolling };
}
