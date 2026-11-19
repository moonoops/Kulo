import { translate as tr, useI18n } from "../../kulo-i18n";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Button, Tooltip } from "@heroui/react";
import { useFocusVisible } from "react-aria";
import { activeConversationTurn, conversationTurnId, TURN_SCROLL_PADDING, type ConversationTurn } from "./conversation-outline-model";
import { useReducedContentMotion } from "./use-content-motion";
import { useOutlineScrollActivity } from "./use-outline-scroll-activity";
import "./conversation-outline.css";

export function ConversationOutline({ turns, topicId, scrollRef, onNavigate }: {
  turns: ConversationTurn[];
  topicId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  onNavigate: () => void;
}) {
  useI18n();
  const [activeId, setActiveId] = useState<number | undefined>(() => turns.at(-1)?.id);
  const [hoveredId, setHoveredId] = useState<number>();
  const [focusedId, setFocusedId] = useState<number>();
  const [previewId, setPreviewId] = useState<number>();
  const listRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const reducedMotion = useReducedContentMotion();
  const { isFocusVisible } = useFocusVisible();
  const { scrollable, scrolling } = useOutlineScrollActivity(scrollRef, turns.length > 1);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || turns.length < 2) return;
    let frame = 0;
    let measure = true;
    let anchors: Array<{ id: number; top: number }> = [];
    const update = () => {
      frame = 0;
      if (measure) {
        const top = scroll.getBoundingClientRect().top + scroll.clientTop;
        anchors = turns.flatMap((turn) => {
          const node = document.getElementById(conversationTurnId(topicId, turn.id));
          return node && scroll.contains(node) ? [{ id: turn.id, top: node.getBoundingClientRect().top - top + scroll.scrollTop }] : [];
        });
        measure = false;
      }
      setActiveId(activeConversationTurn(anchors, scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(() => { measure = true; schedule(); });
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    scroll.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroll.removeEventListener("scroll", schedule);
    };
  }, [scrollRef, topicId, turns]);

  const currentId = turns.some((turn) => turn.id === activeId) ? activeId : turns.at(-1)?.id;
  const hoveredTurnId = turns.some((turn) => turn.id === hoveredId) ? hoveredId : undefined;
  const focusedTurnId = turns.some((turn) => turn.id === focusedId) ? focusedId : undefined;
  const previewTurnId = turns.some((turn) => turn.id === previewId) ? previewId : undefined;
  const visible = scrollable && (scrolling || hoveredTurnId !== undefined || focusedTurnId !== undefined && isFocusVisible || previewTurnId !== undefined);
  const emphasizedId = hoveredTurnId ?? focusedTurnId ?? currentId;
  const emphasizedIndex = turns.findIndex((turn) => turn.id === emphasizedId);

  // Keep long outlines usable without scrolling the conversation or moving the hovered target.
  useLayoutEffect(() => {
    const list = listRef.current;
    const id = focusedTurnId ?? currentId;
    const button = id === undefined ? undefined : buttons.current.get(id);
    if (!visible || !list || !button || hoveredTurnId !== undefined) return;
    const row = button.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (row.top < viewport.top || row.bottom > viewport.bottom) {
      list.scrollTo({ top: list.scrollTop + row.top - viewport.top - (list.clientHeight - row.height) / 2, behavior: reducedMotion ? "instant" : "smooth" });
    }
  }, [currentId, focusedTurnId, hoveredTurnId, reducedMotion, turns.length, visible]);

  const navigate = (turn: ConversationTurn) => {
    const scroll = scrollRef.current;
    const node = document.getElementById(conversationTurnId(topicId, turn.id));
    if (!scroll || !node || !scroll.contains(node)) return;
    const top = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight,
      node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop + scroll.scrollTop - TURN_SCROLL_PADDING));
    if (Math.abs(top - scroll.scrollTop) < 1) return;
    onNavigate();
    const reduced = reducedMotion || document.documentElement.dataset.reduceMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroll.scrollTo({ top, behavior: reduced ? "instant" : "smooth" });
  };

  if (turns.length < 2) return null;

  return <nav className="kulo-chat-outline" aria-label={tr("对话分段", "Conversation sections")} data-visible={visible || undefined} aria-hidden={!visible} inert={!visible}>
    <div ref={listRef} className="kulo-chat-outline-list">
      {turns.map((turn, index) => {
        const distance = Math.min(Math.abs(index - emphasizedIndex), 4);
        return <Tooltip key={turn.id} delay={180} closeDelay={80} onOpenChange={(open) => setPreviewId((previous) => open ? turn.id : previous === turn.id ? undefined : previous)}>
          <Button
            ref={(node) => { if (node) buttons.current.set(turn.id, node); else buttons.current.delete(turn.id); }}
            type="button"
            isIconOnly
            variant="ghost"
            size="sm"
            className="kulo-chat-outline-step"
            aria-label={tr(`第 ${index + 1} 段：${turn.label}`, `Section ${index + 1}: ${turn.label}`)}
            aria-current={turn.id === currentId ? "location" : undefined}
            aria-controls={conversationTurnId(topicId, turn.id)}
            excludeFromTabOrder={!visible || turn.id !== (focusedTurnId ?? currentId)}
            style={{ "--outline-scale": 1 - distance * .19, "--outline-opacity": .6 - distance * .09 } as CSSProperties}
            onHoverStart={() => setHoveredId(turn.id)}
            onHoverEnd={() => setHoveredId(undefined)}
            onFocus={() => { setFocusedId(turn.id); setHoveredId(undefined); }}
            onBlur={() => setFocusedId(undefined)}
            onPress={() => navigate(turn)}
            onKeyDown={(event) => {
              const target = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? turns.length - 1 : undefined;
              if (target === undefined) return;
              event.preventDefault();
              setHoveredId(undefined);
              const turn = turns[Math.max(0, Math.min(turns.length - 1, target))];
              if (turn) buttons.current.get(turn.id)?.focus({ preventScroll: true });
            }}
          >
            <span className="kulo-chat-outline-tick" aria-hidden="true" />
          </Button>
          <Tooltip.Content placement="left" offset={10} className="kulo-chat-outline-preview">
            <p className="kulo-chat-outline-title">{turn.label}</p>
            {turn.preview && <p className="kulo-chat-outline-excerpt">{turn.preview}</p>}
          </Tooltip.Content>
        </Tooltip>;
      })}
    </div>
  </nav>;
}
