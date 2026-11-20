import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TopicSummary } from "@kulo/protocol";
import { setLanguage } from "../../kulo-i18n";
import { AppearanceModule } from "../settings/appearance-module";
import { createBrowserBadgeController } from "./browser-badge";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCES_STORAGE_KEY,
  parseNotificationPreferences,
  readBrowserNotificationPreferences,
  saveBrowserNotificationPreferences,
} from "./notification-preferences";
import { formatMainSessionNotification } from "./session-notification-format";

afterEach(() => {
  setLanguage("zh-CN");
  vi.unstubAllGlobals();
});

describe("notification preferences storage", () => {
  it("defaults to notifications and badge enabled with sound muted", () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual({
      enabled: true,
      sound: false,
      badge: true,
    });
    expect(parseNotificationPreferences(null)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(parseNotificationPreferences("{invalid")).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(parseNotificationPreferences(JSON.stringify({ enabled: false, sound: true }))).toEqual({
      enabled: false,
      sound: true,
      badge: true,
    });
  });

  it("persists browser notification preferences and surfaces storage errors", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });

    expect(saveBrowserNotificationPreferences({ sound: true, badge: false })).toEqual({
      preferences: { enabled: true, sound: true, badge: false },
      error: null,
    });
    expect(JSON.parse(store.get(NOTIFICATION_PREFERENCES_STORAGE_KEY)!)).toEqual({
      enabled: true,
      sound: true,
      badge: false,
    });
    expect(readBrowserNotificationPreferences()).toEqual({
      preferences: { enabled: true, sound: true, badge: false },
      error: null,
    });

    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(readBrowserNotificationPreferences().error).toContain("无法读取通知设置");
    expect(saveBrowserNotificationPreferences({ enabled: false }).error).toContain("无法保存通知设置");
  });
});

describe("main-session notification formatting", () => {
  const topics: TopicSummary[] = [
    { id: "root", conversationId: 1, title: "主会话", master: true, createdAt: 1, updatedAt: 1 },
    { id: "topic_1", conversationId: 2, title: "重构通知方案", createdAt: 1, updatedAt: 2 },
  ];

  it("formats reply_completed, attention_required, and run_failed in both Chinese and English", () => {
    expect(formatMainSessionNotification({
      id: "e1",
      kind: "reply_completed",
      topicId: "root",
      createdAt: 1,
    }, { topics, agentName: "Kulo" })).toEqual({
      title: "回复已完成",
      body: "Kulo · 主会话",
      topicId: "root",
      eventId: "e1",
      dedupeKey: "topic:root",
    });

    expect(formatMainSessionNotification({
      id: "e2",
      kind: "attention_required",
      topicId: "topic_1",
      summary: "确认执行命令",
      createdAt: 2,
    }, { topics, agentName: "Kulo" })).toEqual({
      title: "需要确认",
      body: "重构通知方案 · 确认执行命令",
      topicId: "topic_1",
      eventId: "e2",
      dedupeKey: "topic:topic_1",
    });

    setLanguage("en");
    expect(formatMainSessionNotification({
      id: "e3",
      kind: "run_failed",
      topicId: "topic_1",
      topicTitle: "Notification design",
      createdAt: 3,
    }, { topics, agentName: "Kulo" })).toEqual({
      title: "Run failed",
      body: "Notification design",
      topicId: "topic_1",
      eventId: "e3",
      dedupeKey: "topic:topic_1",
    });
  });
});

describe("browser red-dot badge controller", () => {
  it("adds and clears a pure red-dot prefix on document.title", () => {
    const fakeDocument = {
      title: "Kulo",
      querySelector: () => null,
    };
    vi.stubGlobal("document", fakeDocument);

    const badge = createBrowserBadgeController();
    expect(badge.isActive()).toBe(false);

    badge.set(true);
    expect(badge.isActive()).toBe(true);
    expect(fakeDocument.title).toBe("• Kulo");

    badge.set(false);
    expect(badge.isActive()).toBe(false);
    expect(fakeDocument.title).toBe("Kulo");

    badge.set(true);
    badge.dispose();
    expect(fakeDocument.title).toBe("Kulo");
  });
});

describe("General settings notifications section", () => {
  it("disables sound toggle when system notifications are turned off and surfaces denied browser permission", () => {
    const store = new Map([[NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify({ enabled: false, sound: false, badge: true })]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });
    const htmlOff = renderToStaticMarkup(<AppearanceModule />);
    expect(htmlOff).toContain('aria-label="系统通知"');
    expect(htmlOff).toContain('aria-label="提示音"');
    expect(htmlOff).toContain('aria-label="任务栏红点"');
    expect(htmlOff).not.toContain("系统通知设置");

    store.set(NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify({ enabled: true, sound: false, badge: true }));
    vi.stubGlobal("Notification", { permission: "denied" });
    const htmlDenied = renderToStaticMarkup(<AppearanceModule />);
    expect(htmlDenied).toContain("浏览器已阻止通知权限");
  });
});
