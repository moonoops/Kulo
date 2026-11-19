import { describe, expect, it } from "vitest";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { extractDisplayMessages } from "../packages/hub/src/hub.js";

describe("durable chat timestamps", () => {
  it("preserves model timestamps for user and assistant messages, including old persisted entries", () => {
    const entries = [
      { id: 11, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "请求", timestamp: 1794815816477 }] },
      { id: 12, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "回复" }], timestamp: 1794815816482 }] },
    ] as unknown as EntryRecord[];
    expect(extractDisplayMessages(entries).map((item) => item.createdAt)).toEqual([1794815816477, 1794815816482]);
  });

  it("uses persisted publication times for rich content and leaves truly unknown times empty", () => {
    const entries = [
      { id: 21, conversationId: 1, kind: "kulo.content_publication", data: { parts: [], fallbackText: "已发布附件", createdAt: 1794815816490 } },
      { id: 22, conversationId: 1, kind: "kulo.content_publication", data: { parts: [], fallbackText: "早期卡片" } },
    ] as unknown as EntryRecord[];
    const messages = extractDisplayMessages(entries);
    expect(messages[0]?.createdAt).toBe(1794815816490);
    expect(messages[1]?.createdAt).toBeUndefined();
  });
});
