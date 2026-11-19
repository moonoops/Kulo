import { describe, expect, it, vi } from "vitest";
import { createDesktopNotifications, normalizeDesktopNotificationPayload } from "../packages/desktop/src/notifications.js";

describe("desktop native notifications", () => {
  it("sanitizes payloads and rejects empty or malformed input", () => {
    expect(normalizeDesktopNotificationPayload(null)).toBeNull();
    expect(normalizeDesktopNotificationPayload({ title: "   " })).toBeNull();
    expect(normalizeDesktopNotificationPayload({ title: "任务\n完成\t!", body: "整理\r\n文件", topicId: "topic_1" })).toEqual({
      title: "任务 完成 !",
      body: "整理 文件",
      topicId: "topic_1",
    });
    expect(normalizeDesktopNotificationPayload({ title: "Done", topicId: "../bad" })).toEqual({
      title: "Done",
    });
  });

  it("suppresses notifications while the window is focused and focuses the window on click when unfocused", () => {
    let focused = true;
    const shown: Array<{ title: string; body?: string; click: () => void }> = [];
    const onFocusWindow = vi.fn();
    const controller = createDesktopNotifications({
      isSupported: () => true,
      isWindowFocused: () => focused,
      showNotification: (payload, onClick) => {
        shown.push({ title: payload.title, body: payload.body, click: onClick });
      },
      onFocusWindow,
    });

    expect(controller.notify({ title: "任务已完成", body: "构建前端", topicId: "t1" })).toBe(false);
    expect(shown).toHaveLength(0);

    focused = false;
    expect(controller.notify({ title: "任务已完成", body: "构建前端", topicId: "t1" })).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: "任务已完成", body: "构建前端" });

    shown[0]!.click();
    expect(onFocusWindow).toHaveBeenCalledWith("t1");
  });
});
