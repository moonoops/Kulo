import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageMotion, StreamingMessage, messageMotionKey, responseMotionScopes } from "./message-motion";

describe("message motion identities", () => {
  it("keeps a queued user bubble mounted when its server message replaces the local ID", () => {
    const local = { id: -1, role: "user" as const, requestId: "same-send" };
    expect(messageMotionKey(local)).toBe(messageMotionKey({ ...local, id: 101 }));
  });
  it("keeps different durable segments unique across response boundaries", () => {
    expect(messageMotionKey({ id: 1, role: "assistant", responseId: 4 })).not.toBe(messageMotionKey({ id: 3, role: "assistant", responseId: 4 }));
  });
  it("keeps the live reply's outer identity when its durable content and footer arrive", () => {
    const user = { id: 1, role: "user" as const, text: "你好", requestId: "send-one" };
    const live = responseMotionScopes([{ type: "message", item: user }], [], { responseId: 9 });
    const completed = responseMotionScopes([{ type: "message", item: user }, { type: "message", item: { id: 3, role: "assistant", responseId: 9, text: "你好" } }], [], {});
    expect(live.live).toBe(completed.messages.get(3));
    const queued = responseMotionScopes([], [{ ...user, id: -1 }], { responseId: 9 });
    expect(queued.live).toBe(live.live);
  });
  it("keeps reused response metadata unique when a user or system boundary separates messages", () => {
    const scopes = responseMotionScopes([
      { type: "message", item: { id: 2, role: "assistant", responseId: 9, text: "第一段" } },
      { type: "message", item: { id: 3, role: "system_note", text: "边界" } },
      { type: "message", item: { id: 4, role: "assistant", responseId: 9, text: "第二段" } },
    ], [], {});
    expect(scopes.messages.get(2)).not.toBe(scopes.messages.get(4));
  });
  it("preserves message semantics and Markdown without introducing a delayed typing buffer", () => {
    const html = renderToStaticMarkup(<MessageMotion as="article" animateEntry={false}><StreamingMessage text={"第一段\n\n**完整内容**已经到达"} /></MessageMotion>);
    expect(html).toContain("<article");
    expect(html).toContain("第一段");
    expect(html).toContain("<strong>完整内容</strong>已经到达");
    expect(html).not.toContain('aria-hidden="true"');
  });
});
