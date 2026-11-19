import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskFailureActions } from "./task-failure-actions";

const ticket = { id: "failed-one", title: "验证消息交付" };

function buttons(connected: boolean, canQueueActions?: boolean, cleanupPending = false) {
  const html = renderToStaticMarkup(<TaskFailureActions ticket={{ ...ticket, cleanupPending }} connected={connected} canQueueActions={canQueueActions}
    onRetry={async () => {}} onIgnore={async () => {}} />);
  return html.match(/<button\b[^>]*>/g) ?? [];
}

describe("task action delivery readiness", () => {
  it("defaults action availability to the connection for existing callers", () => {
    expect(buttons(false).every(button => /\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
    expect(buttons(true).every(button => !/\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
  });

  it("accepts offline actions only after the durable queue becomes ready", () => {
    expect(buttons(false, true).every(button => !/\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
    expect(buttons(true, false).every(button => /\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
  });

  it("preserves the execution cleanup guard while allowing the independent ignore action", () => {
    const [retry, ignore] = buttons(false, true, true);
    expect(retry).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(ignore).not.toMatch(/\sdisabled(?:=|\s|>)/);
  });
});
