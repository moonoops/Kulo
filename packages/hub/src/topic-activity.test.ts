import { describe, expect, it } from "vitest";
import { topicActivity } from "./topic-activity.js";

describe("content-free topic activity", () => {
  it("tracks assistant replies and queue state without leaking message or tool content", () => {
    const activity = topicActivity([
      { id: 3, role: "assistant", text: "private reply" },
      { id: 5, role: "user", text: "private question" },
      { id: 4, role: "assistant", text: "another private reply" },
    ], { busy: true, queuedCount: 2, streamingText: "private stream", activeTools: [{ callId: "tool", name: "private-tool" }] });
    expect(activity).toEqual({ busy: true, queuedCount: 2, lastAssistantMessageId: 4 });
    expect(JSON.stringify(activity)).not.toContain("private");
  });
  it("does not count user messages as new replies", () => {
    expect(topicActivity([{ id: 1, role: "user", text: "hello" }], { busy: false, queuedCount: 0, activeTools: [] })).toEqual({ busy: false, queuedCount: 0 });
  });
});
