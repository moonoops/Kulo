import { useEffect, useMemo, useState } from "react";
import type { TicketCardView, TopicActivity, TopicSummary } from "@kulo/protocol";
import { parseSeenTopicActivities, reconcileTopicActivity } from "./topic-activity";

const seenKey = "kulo:topics:seen-activity";

function conversationVisible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

export function useTopicActivity({ topics, tickets, topicActivities, activeTopicId, viewingConversation }: {
  topics: readonly TopicSummary[];
  tickets: readonly TicketCardView[];
  topicActivities: Readonly<Record<string, TopicActivity>>;
  activeTopicId: string;
  viewingConversation: boolean;
}) {
  const [seen, setSeen] = useState(() => {
    try { return parseSeenTopicActivities(localStorage.getItem(seenKey)); }
    catch { return {}; }
  });
  const [visible, setVisible] = useState(conversationVisible);
  useEffect(() => {
    const update = () => setVisible(conversationVisible());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  const result = useMemo(() => reconcileTopicActivity({ topics, tickets, topicActivities, seen,
    readableTopicId: visible && viewingConversation ? activeTopicId : undefined,
  }), [topics, tickets, topicActivities, seen, visible, viewingConversation, activeTopicId]);
  useEffect(() => {
    const serialized = JSON.stringify(result.seen);
    if (serialized === JSON.stringify(seen)) return;
    setSeen(result.seen);
    try { localStorage.setItem(seenKey, serialized); }
    catch { /* Indicators remain available for this session when browser storage is unavailable. */ }
  }, [result.seen, seen]);
  return result.states;
}
