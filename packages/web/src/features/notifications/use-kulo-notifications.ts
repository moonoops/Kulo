import { useEffect, useRef } from "react";
import type { MainSessionNotificationEvent, TopicSummary } from "@kulo/protocol";
import { createBrowserBadgeController, deliverBrowserNotification } from "./browser-badge";
import { useNotificationPreferences } from "./notification-preferences";
import { formatMainSessionNotification } from "./session-notification-format";

function isWindowBackgrounded(): boolean {
  if (typeof document === "undefined") return false;
  return document.hidden || !document.hasFocus();
}

export function useKuloNotifications({
  subscribeNotification,
  topics,
  agentName,
  onOpenTopic,
}: {
  subscribeNotification: (listener: (event: MainSessionNotificationEvent) => void) => () => void;
  topics: readonly TopicSummary[];
  agentName: string;
  onOpenTopic: (topicId: string) => void;
}): void {
  const { preferences, isDesktop } = useNotificationPreferences();
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;
  const topicsRef = useRef(topics);
  topicsRef.current = topics;
  const agentNameRef = useRef(agentName);
  agentNameRef.current = agentName;
  const onOpenTopicRef = useRef(onOpenTopic);
  onOpenTopicRef.current = onOpenTopic;
  const browserBadgeRef = useRef<ReturnType<typeof createBrowserBadgeController> | null>(null);
  const unreadCountRef = useRef(0);
  const countedEventIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const browserBadge = isDesktop ? null : createBrowserBadgeController();
    browserBadgeRef.current = browserBadge;

    const pushBadgeCount = (nextCount: number) => {
      if (isDesktop) {
        void window.kuloDesktop?.setBadge?.(nextCount).catch((error: unknown) => {
          if (nextCount > 0) console.warn("[KuloNotify] Desktop badge update failed", error);
        });
      } else {
        browserBadge?.set(nextCount);
      }
    };

    const clearBadge = () => {
      unreadCountRef.current = 0;
      pushBadgeCount(0);
    };

    const onWindowActive = () => {
      if (!isWindowBackgrounded()) clearBadge();
    };

    window.addEventListener("focus", onWindowActive);
    document.addEventListener("visibilitychange", onWindowActive);
    const unsubscribeDesktopOpen = window.kuloDesktop?.onNotificationOpen?.(({ topicId }) => {
      clearBadge();
      onOpenTopicRef.current(topicId);
    });

    const unsubscribeHub = subscribeNotification((event) => {
      if (!isWindowBackgrounded()) return;
      const currentPrefs = prefsRef.current;
      const formatted = formatMainSessionNotification(event, {
        topics: topicsRef.current,
        agentName: agentNameRef.current,
      });

      if (currentPrefs.badge) {
        const seen = countedEventIdsRef.current;
        if (!seen.has(event.id)) {
          seen.add(event.id);
          if (seen.size > 200) {
            const oldest = seen.values().next().value;
            if (oldest !== undefined) seen.delete(oldest);
          }
          unreadCountRef.current += 1;
          pushBadgeCount(unreadCountRef.current);
        }
      }

      if (currentPrefs.enabled) {
        if (isDesktop) {
          void window.kuloDesktop?.notify?.(formatted).catch((error: unknown) => {
            console.warn("[KuloNotify] Desktop notification failed", error);
          });
        } else {
          deliverBrowserNotification(formatted, {
            sound: currentPrefs.sound,
            onOpen: (topicId) => {
              clearBadge();
              onOpenTopicRef.current(topicId);
            },
          });
        }
      }
    });

    return () => {
      unsubscribeHub();
      unsubscribeDesktopOpen?.();
      window.removeEventListener("focus", onWindowActive);
      document.removeEventListener("visibilitychange", onWindowActive);
      browserBadge?.dispose();
      browserBadgeRef.current = null;
      unreadCountRef.current = 0;
    };
  }, [isDesktop, subscribeNotification]);

  useEffect(() => {
    if (!preferences.badge) {
      unreadCountRef.current = 0;
      if (isDesktop) {
        void window.kuloDesktop?.setBadge?.(0).catch(() => {});
      } else {
        browserBadgeRef.current?.set(0);
      }
    }
  }, [isDesktop, preferences.badge]);
}
