import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button, Skeleton } from "@heroui/react";
import { translate as t, useI18n } from "../../kulo-i18n";
import { useReducedContentMotion } from "./use-content-motion";
import "./chat-initial-state.css";

export interface RecommendedTask {
  id: string;
  title: string;
  prompt: string;
}

export const EMPTY_RECOMMENDED_TASKS: readonly RecommendedTask[] = [];

export function RecommendedTasks({ tasks = EMPTY_RECOMMENDED_TASKS, onChoose }: {
  tasks?: readonly RecommendedTask[];
  onChoose: (task: RecommendedTask) => void;
}) {
  useI18n();
  if (!tasks.length) return null;
  return <div className="kulo-recommended-tasks" aria-label={t("推荐任务", "Suggested tasks")}>
    {tasks.map((task) => <Button key={task.id} variant="secondary" size="sm" className="whitespace-normal" onPress={() => onChoose(task)}>{task.title}</Button>)}
  </div>;
}

export function shouldCenterConversation({ empty, ready, sameConversation, wasCentered }: {
  empty: boolean;
  ready: boolean;
  sameConversation: boolean;
  wasCentered: boolean;
}): boolean {
  // A local draft keeps its presentation while its server topic is being selected.
  return empty && (ready || sameConversation && wasCentered);
}

export function ConversationScene({ conversationKey, empty, ready, transcript, composer, recommendations = EMPTY_RECOMMENDED_TASKS, onChooseRecommendation }: {
  conversationKey: string;
  empty: boolean;
  ready: boolean;
  transcript: ReactNode;
  composer: ReactNode;
  recommendations?: readonly RecommendedTask[];
  onChooseRecommendation: (task: RecommendedTask) => void;
}) {
  useI18n();
  const reduced = useReducedContentMotion();
  const sceneRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const previous = useRef<{ key: string; centered: boolean; top: number } | undefined>(undefined);
  const [departure, setDeparture] = useState<string>();
  const [loadingKey, setLoadingKey] = useState<string>();
  useEffect(() => {
    setLoadingKey(undefined);
    if (ready) return;
    const timer = setTimeout(() => setLoadingKey(conversationKey), 180);
    return () => clearTimeout(timer);
  }, [conversationKey, ready]);
  const sameConversation = previous.current?.key === conversationKey;
  const centered = shouldCenterConversation({ empty, ready, sameConversation, wasCentered: Boolean(previous.current?.centered) });
  const startsDeparture = sameConversation && previous.current?.centered && !centered && !empty;
  const departing = departure === conversationKey || Boolean(startsDeparture);

  useLayoutEffect(() => {
    const scene = sceneRef.current;
    const capsule = composerRef.current;
    if (!scene || !capsule) return;
    const before = previous.current;
    const measure = () => {
      if (!centered) return;
      const sceneHeight = scene.clientHeight;
      const capsuleHeight = capsule.offsetHeight;
      const titleHeight = headingRef.current?.offsetHeight ?? 0;
      const minimumTop = titleHeight + 32;
      const targetTop = Math.min(Math.max(minimumTop, sceneHeight * .44 - capsuleHeight / 2), Math.max(0, sceneHeight - capsuleHeight));
      capsule.style.setProperty("--kulo-intro-offset", `${Math.min(0, targetTop - (sceneHeight - capsuleHeight))}px`);
      previous.current = { key: conversationKey, centered: true, top: capsule.getBoundingClientRect().top };
    };
    const reduceNow = reduced || document.documentElement.dataset.reduceMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animations: Animation[] = [];
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    if (centered) {
      setDeparture(undefined);
      measure();
    } else {
      previous.current = { key: conversationKey, centered: false, top: capsule.getBoundingClientRect().top };
      if (before?.key === conversationKey && before.centered && !empty && !reduceNow && typeof capsule.animate === "function") {
        setDeparture(conversationKey);
        const delta = before.top - capsule.getBoundingClientRect().top;
        animations = [capsule.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 360, easing: "cubic-bezier(.22,.61,.36,1)" })];
        if (transcriptRef.current) animations.push(transcriptRef.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 120, fill: "backwards", easing: "ease-out" }));
        finishTimer = setTimeout(() => setDeparture((current) => current === conversationKey ? undefined : current), 360);
      } else setDeparture(undefined);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(scene);
    observer.observe(capsule);
    if (headingRef.current) observer.observe(headingRef.current);
    return () => { observer.disconnect(); clearTimeout(finishTimer); for (const animation of animations) animation.cancel(); };
  }, [conversationKey, centered, empty, reduced]);

  return <div ref={sceneRef} className="kulo-conversation-scene" data-intro={centered || undefined}>
    <div ref={transcriptRef} className="kulo-conversation-transcript" data-kulo-navigation-key={conversationKey} data-kulo-navigation="content" data-kulo-navigation-ready={ready} aria-busy={!ready || undefined}>
      {!ready && loadingKey === conversationKey && <div className="kulo-conversation-loading" role="status" aria-label={t("加载对话", "Loading conversation")}>
        <Skeleton animationType="none" className="h-9 w-2/5 self-end rounded-2xl" />
        <Skeleton animationType="none" className="h-3 w-4/5 rounded" />
        <Skeleton animationType="none" className="h-3 w-3/5 rounded" />
      </div>}
      <div className="kulo-conversation-history" hidden={!ready}>{transcript}</div>
    </div>
    <div ref={composerRef} className="kulo-conversation-composer">
      {(centered || departing) && <div ref={headingRef} className="kulo-conversation-welcome" data-kulo-navigation-key={conversationKey} data-exiting={!centered || undefined} aria-hidden={!centered || undefined}>
        <h2 className="kulo-page-title">{t("今天想一起做点什么？", "What shall we work on today?")}</h2>
      </div>}
      {composer}
      {(centered || departing) && recommendations.length > 0 && <div className="kulo-conversation-recommendations" data-exiting={!centered || undefined} inert={!centered || undefined}>
        <RecommendedTasks tasks={recommendations} onChoose={onChooseRecommendation} />
      </div>}
    </div>
  </div>;
}
