import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopNotifications, normalizeDesktopNotificationPayload } from "../packages/desktop/src/notifications.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop native notifications", () => {
  it("sanitizes payloads and rejects empty or malformed input", () => {
    expect(normalizeDesktopNotificationPayload(null)).toBeNull();
    expect(normalizeDesktopNotificationPayload({ title: "   " })).toBeNull();
    expect(normalizeDesktopNotificationPayload({
      title: "回复\n完成\t!",
      body: "整理\r\n文件",
      topicId: "topic_1",
      eventId: "evt-1",
      dedupeKey: "topic:topic_1",
      force: true,
    })).toEqual({
      title: "回复 完成 !",
      body: "整理 文件",
      topicId: "topic_1",
      eventId: "evt-1",
      dedupeKey: "topic:topic_1",
      force: true,
    });
    expect(normalizeDesktopNotificationPayload({ title: "Done", topicId: "../bad", eventId: "bad id" })).toEqual({
      title: "Done",
    });
  });

  it("suppresses when focused or disabled, honors default silent mode, and allows forced test notifications", () => {
    let focused = true;
    let enabled = true;
    let sound = false;
    const shown: Array<{ title: string; body?: string; silent: boolean; click: () => void }> = [];
    const onFocusWindow = vi.fn();
    const controller = createDesktopNotifications({
      isSupported: () => true,
      isWindowFocused: () => focused,
      getPreferences: () => ({ enabled, sound }),
      coalesceMs: 0,
      showNotification: (payload, onClick) => {
        shown.push({ title: payload.title, body: payload.body, silent: payload.silent, click: onClick });
      },
      onFocusWindow,
    });

    // Suppressed while focused
    expect(controller.notify({ title: "回复已完成", body: "主会话", topicId: "t1" })).toBe(false);
    expect(shown).toHaveLength(0);

    // Forced test notification bypasses focus and disabled preference
    enabled = false;
    expect(controller.notify({ title: "测试通知", body: "Kulo 通知已就绪", force: true })).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: "测试通知", body: "Kulo 通知已就绪", silent: true });

    // Non-forced suppressed while disabled even if unfocused
    focused = false;
    expect(controller.notify({ title: "回复已完成", body: "主会话", topicId: "t1" })).toBe(false);
    expect(shown).toHaveLength(1);

    // Enabled + unfocused delivers silently by default and opens target topic on click
    enabled = true;
    expect(controller.notify({ title: "回复已完成", body: "主会话", topicId: "t1", eventId: "e-1" })).toBe(true);
    expect(shown).toHaveLength(2);
    expect(shown[1]).toMatchObject({ title: "回复已完成", body: "主会话", silent: true });

    // Duplicate eventId is dropped
    expect(controller.notify({ title: "回复已完成", body: "主会话", topicId: "t1", eventId: "e-1" })).toBe(false);
    expect(shown).toHaveLength(2);

    shown[1]!.click();
    expect(onFocusWindow).toHaveBeenCalledWith("t1");
    controller.dispose();
  });

  it("coalesces rapid notifications for the same topic and enforces sound cooldown when sound is enabled", () => {
    vi.useFakeTimers();
    let clock = 10_000;
    const shown: Array<{ title: string; body?: string; silent: boolean }> = [];
    const controller = createDesktopNotifications({
      isSupported: () => true,
      isWindowFocused: () => false,
      getPreferences: () => ({ enabled: true, sound: true }),
      coalesceMs: 1_000,
      soundCooldownMs: 3_000,
      now: () => clock,
      showNotification: (payload) => {
        shown.push({ title: payload.title, body: payload.body, silent: payload.silent });
      },
      onFocusWindow: vi.fn(),
    });

    expect(controller.notify({ title: "回复已完成", body: "话题 A", topicId: "t1", eventId: "e1", dedupeKey: "topic:t1" })).toBe(true);
    vi.advanceTimersByTime(400);
    expect(controller.notify({ title: "需要确认", body: "话题 A · 执行命令", topicId: "t1", eventId: "e2", dedupeKey: "topic:t1" })).toBe(true);
    expect(shown).toHaveLength(0);

    clock += 1_400;
    vi.advanceTimersByTime(1_000);
    expect(shown).toEqual([{ title: "需要确认", body: "话题 A · 执行命令", silent: false }]);

    // Another topic within 3s sound cooldown delivers silently
    expect(controller.notify({ title: "回复已完成", body: "话题 B", topicId: "t2", eventId: "e3", dedupeKey: "topic:t2" })).toBe(true);
    clock += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(shown).toHaveLength(2);
    expect(shown[1]).toEqual({ title: "回复已完成", body: "话题 B", silent: true });

    // After cooldown expires, sound plays again
    clock += 3_500;
    expect(controller.notify({ title: "回复已完成", body: "话题 C", topicId: "t3", eventId: "e4", dedupeKey: "topic:t3" })).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(shown[2]).toEqual({ title: "回复已完成", body: "话题 C", silent: false });

    controller.dispose();
  });
});
