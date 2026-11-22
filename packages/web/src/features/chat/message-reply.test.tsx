import { renderToStaticMarkup } from "react-dom/server";
import type { ButtonProps } from "@heroui/react";
import type { ChatDisplayItem, ChatReplyReference } from "@kulo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageReply } from "./message-reply";
import { MessageContent } from "./message-content";
import { ConnectedMessageContent } from "./connected-message-content";

const presses = vi.hoisted(() => [] as Array<NonNullable<ButtonProps["onPress"]>>);
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  return { ...actual, Button: (props: ButtonProps) => {
    if (props.onPress && String(props.className).includes("kulo-message-reply-trigger")) presses.push(props.onPress);
    return <actual.Button {...props} />;
  } };
});

const reply: ChatReplyReference = { messageId: 12, role: "assistant", text: "维护方式需要再确认。" };
const item: ChatDisplayItem = { id: 22, role: "user", text: "继续核对这一点", replyTo: reply };
afterEach(() => { presses.length = 0; });

describe("reply navigation", () => {
  it("keeps a reference read-only when its conversation cannot navigate", () => {
    const html = renderToStaticMarkup(<MessageReply reply={reply} />);
    expect(html).toContain('aria-label="回复引用"');
    expect(html).toContain('data-source-message-id="12"');
    expect(html).toContain("维护方式需要再确认。");
    expect(html).not.toContain("<button");
    expect(presses).toHaveLength(0);
  });

  it("renders a labelled keyboard button and navigates to the source rather than the replying message", () => {
    const navigate = vi.fn();
    const html = renderToStaticMarkup(<MessageContent item={item} onNavigateReply={navigate} />);
    expect(html).toMatch(/<button\b[^>]*type="button"[^>]*tabindex="0"/);
    expect(html).toContain('aria-label="查看原消息：Kulo，维护方式需要再确认。"');
    expect(html).not.toContain('tabindex="-1"');
    expect(presses).toHaveLength(1);
    presses[0]!({ pointerType: "keyboard" } as Parameters<typeof presses[number]>[0]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(12);
    expect(item.replyTo).toEqual(reply);
  });

  it("preserves navigation when connected messages are rendered without a footer", () => {
    const navigate = vi.fn();
    const html = renderToStaticMarkup(<ConnectedMessageContent item={item} onNavigateReply={navigate} contentOnly />);
    expect(html).toContain('aria-label="查看原消息：Kulo，维护方式需要再确认。"');
    expect(html).not.toContain("kulo-message-footer");
    presses[0]!({ pointerType: "keyboard" } as Parameters<typeof presses[number]>[0]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(12);
  });
});
