import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatDisplayItem, UiCardSnapshot } from "@kulo/protocol";
import { setLanguage } from "../../kulo-i18n";
import { KuloMarkdown } from "../../kulo-markdown";
import { GeneratedCard } from "../genui/generated-card";
import { MessageActions, messageQuote } from "./message-actions";
import { KuloThinkingIndicator } from "./thinking-indicator";

afterEach(() => setLanguage("zh-CN"));

describe("chat interface language", () => {
  it("switches action labels while preserving message text and quoted content", () => {
    const item: ChatDisplayItem = { id: 1, role: "user", text: "请保留这段原文" };
    const render = () => renderToStaticMarkup(<MessageActions item={item} onReply={() => {}}><KuloMarkdown text={item.text} /></MessageActions>);
    expect(render()).toContain('aria-label="复制消息"');

    setLanguage("en");
    const english = render();
    expect(english).toContain('aria-label="Copy message"');
    expect(english).toContain('aria-label="Reply to message"');
    expect(english).toContain(item.text);
    expect(messageQuote(item).text).toBe(item.text);

    setLanguage("zh-CN");
    expect(render()).toContain('aria-label="复制消息"');
  });

  it("localizes card controls and keeps generated titles, options and actions intact", () => {
    const card: UiCardSnapshot = {
      cardId: "language-test", schemaVersion: 1, catalogVersion: 1, revision: 1,
      title: "用户的照明方案", status: "ready", originConversationId: 1, committedState: {},
      actions: [{ id: "submit", kind: "submit", label: "采用方案", fields: [] }],
      spec: { root: "choice", elements: {
        choice: { type: "Choice", props: { field: "plan", options: [{ value: "warm", label: "温暖照明" }] } },
      } },
    };
    setLanguage("en");
    const html = renderToStaticMarkup(<GeneratedCard card={card} isConnected={false} onAction={async () => { throw new Error("must not submit while rendering"); }} />);
    expect(html).toContain("Offline · Input kept");
    expect(html).toContain('aria-label="Choose an option"');
    expect(html).toContain(card.title);
    expect(html).toContain("温暖照明");
    expect(html).toContain("采用方案");
  });

  it("localizes default accessible state names", () => {
    setLanguage("en");
    expect(renderToStaticMarkup(<KuloThinkingIndicator />)).toContain('aria-label="Thinking"');
    setLanguage("zh-CN");
    expect(renderToStaticMarkup(<KuloThinkingIndicator />)).toContain('aria-label="思考中"');
  });
});
