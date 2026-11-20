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

  useEffect(() => {
    const browserBadge = isDesktop ? null : createBrowserBadgeController();
    browserBadgeRef.current = browserBadge;

    const clearBadge = () => {
      if (isDesktop) {
        void window.kuloDesktop?.setBadge?.(false).catch(() => {});
      } else {
        browserBadge?.set(false);
      }
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
        if (isDesktop) {
          void window.kuloDesktop?.setBadge?.(true).catch((error: unknown) => {
            console.warn("[KuloNotify] Desktop badge update failed", error);
          });
        } else {
          browserBadge?.set(true);
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
    };
  }, [isDesktop, subscribeNotification]);

  useEffect(() => {
    if (!preferences.badge) {
      if (isDesktop) {
        void window.kuloDesktop?.setBadge?.(false).catch(() => {});
      } else {
        browserBadgeRef.current?.set(false);
      }
    }
  }, [isDesktop, preferences.badge]);
}
