import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TopicRow, type TopicRowActivity } from "./topic-row";

function render(layout: "topic" | "project", activity?: TopicRowActivity, attentionCount = 0, selected = false, failureCount = 0) {
  return renderToStaticMarkup(<TopicRow topic={{ id: "topic-1", conversationId: 1, title: "检查设备连接", createdAt: 1, updatedAt: 1 }}
    layout={layout} selected={selected} activity={activity} attentionCount={attentionCount} failureCount={failureCount}
    onSelect={() => {}} onPatch={() => {}} onRequestDelete={() => {}} />);
}

describe.each(["topic", "project"] as const)("%s conversation status", (layout) => {
  it("keeps selection and operations available while running with unread progress", () => {
    const html = render(layout, { running: true, queued: false, unread: true });
    expect(html).toContain('aria-label="检查设备连接"');
    expect(html).toContain('aria-label="检查设备连接操作"');
    expect(html).toContain('aria-label="正在处理，有新进度"');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain("moco-thinking-indicator--compact");
    expect(html).toContain("moco-topic-unread");
    expect(html).not.toContain('aria-disabled="true"');
  });

  it("includes activity in the conversation target while leaving its menu independently focusable", () => {
    const html = render(layout, { running: true, queued: false, unread: true }, 2, true);
    const select = html.match(/<button\b[^>]*aria-label="检查设备连接"[^>]*>[\s\S]*?<\/button>/)?.[0];
    const menu = html.match(/<button\b[^>]*aria-label="检查设备连接操作"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(select).toBeDefined();
    expect(select).toContain('aria-current="page"');
    expect(select).toContain('aria-label="正在处理，有新进度，2 项待处理"');
    expect(select).toContain("moco-thinking-indicator--compact");
    expect(select).toContain('data-notice="attention"');
    expect(select).not.toContain("moco-topic-unread");
    expect(select).not.toContain('aria-label="检查设备连接操作"');
    expect(menu).toBeDefined();
    expect(menu).not.toContain('tabindex="-1"');
    expect(menu).not.toContain('aria-disabled="true"');
    expect(html).not.toContain("<input");
  });

  it("distinguishes a queued reply from running and keeps required decisions visible", () => {
    const html = render(layout, { running: false, queued: true, unread: false }, 2);
    expect(html).toContain('aria-label="排队中，2 项待处理"');
    expect(html).not.toContain("moco-thinking-indicator");
    expect(html).not.toContain("moco-topic-unread");
  });

  it("does not show progress indicators for an idle conversation", () => {
    const html = render(layout, { running: false, queued: false, unread: false });
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain("moco-thinking-indicator");
    expect(html).not.toContain("moco-topic-unread");
    expect(html).not.toContain("<time");
    expect(html.match(/class="moco-topic-state-slot"/g)).toHaveLength(2);
    expect(html).toContain('data-state-slot="execution"');
    expect(html).toContain('data-state-slot="notice"');
  });

  it("prioritizes failure over attention and unread without losing their accessible descriptions", () => {
    const html = render(layout, { running: true, queued: true, unread: true }, 2, false, 1);
    expect(html).toContain('aria-label="正在处理，1 项执行失败，有新进度，2 项待处理"');
    expect(html).toContain('data-notice="failed"');
    expect(html).toContain("moco-topic-failure");
    expect(html).toContain("moco-thinking-indicator--compact");
    expect(html).not.toContain("moco-topic-unread");
    expect(html).not.toContain("moco-topic-attention");
    expect(html.match(/class="moco-topic-state-slot"/g)).toHaveLength(2);
  });

  it("caps only the visible attention count while preserving the exact number in the description", () => {
    const html = render(layout, { running: false, queued: false, unread: true }, 14);
    expect(html).toContain('aria-label="有新进度，14 项待处理"');
    expect(html).toContain('class="moco-topic-attention">9+</span>');
    expect(html).not.toContain("moco-topic-unread");
    expect(html).not.toContain("chip--");
  });

  it("marks the whole selected row while keeping selection and menu actions separate", () => {
    const html = render(layout, undefined, 0, true);
    const row = html.match(/^<div\b[^>]*>/)?.[0];
    expect(row).toContain('data-selected="true"');
    expect(row).toContain('class="moco-navigation-row moco-topic-row"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="检查设备连接"');
    expect(html).toContain('aria-label="检查设备连接操作"');
    expect(html).not.toContain("<time");
  });

  it("does not mark an idle unselected row as current", () => {
    const html = render(layout);
    const row = html.match(/^<div\b[^>]*>/)?.[0];
    expect(row).not.toContain("data-selected");
    expect(html).not.toContain("aria-current");
  });
});
