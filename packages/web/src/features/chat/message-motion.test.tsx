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
    const live = responseMotionScopes([user], [], { responseId: 9 });
    const completed = responseMotionScopes([user, { id: 3, role: "assistant", responseId: 9, text: "你好" }], [], {});
    expect(live.live).toBe(completed.messages.get(3));
    const queued = responseMotionScopes([], [{ ...user, id: -1 }], { responseId: 9 });
    expect(queued.live).toBe(live.live);
  });
  it("keeps reused response metadata unique when a user or system boundary separates messages", () => {
    const scopes = responseMotionScopes([
      { id: 2, role: "assistant", responseId: 9, text: "第一段" },
      { id: 3, role: "system_note", text: "边界" },
      { id: 4, role: "assistant", responseId: 9, text: "第二段" },
    ], [], {});
    expect(scopes.messages.get(2)).not.toBe(scopes.messages.get(4));
  });
  it("does not shift response motion scope across omitted dispatch entries", () => {
    const user = { id: 1, role: "user" as const, text: "派发任务", requestId: "send-dispatch" };
    const dispatch = { id: 2, role: "dispatch" as const, responseId: 10, text: "后台任务", dispatch: { actionLabel: "派发任务", ticketId: "T-1", title: "后台任务" } };
    const reply = { id: 3, role: "assistant" as const, responseId: 10, text: "已经派发了。" };
    const beforeReply = responseMotionScopes([user], [], { responseId: 10 });
    const afterReply = responseMotionScopes([user, dispatch, reply], [], {});
    expect(afterReply.messages.get(3)).toBe(beforeReply.live);
  });
  it("preserves message semantics and Markdown without introducing a delayed typing buffer", () => {
    const html = renderToStaticMarkup(<MessageMotion as="article" animateEntry={false}><StreamingMessage text={"第一段\n\n**完整内容**已经到达"} /></MessageMotion>);
    expect(html).toContain("<article");
    expect(html).toContain("第一段");
    expect(html).toContain("<strong>完整内容</strong>已经到达");
    expect(html).not.toContain('aria-hidden="true"');
  });
});
