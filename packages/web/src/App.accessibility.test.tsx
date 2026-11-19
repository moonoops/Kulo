import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("workbench trigger accessibility", () => {
  it("keeps both panel controls and the page title in one toolbar outside the panes", () => {
    const html = renderToStaticMarkup(<App />);
    const toolbar = html.match(/<header\b[^>]*aria-label="窗口工具栏"[\s\S]*?<\/header>/)?.[0];
    expect(toolbar).toBeDefined();
    expect(toolbar).toContain('aria-label="收起导航"');
    expect(toolbar).toContain('aria-label="收起任务栏"');
    expect(toolbar).toMatch(/<h1\b/);
    expect(html.indexOf(toolbar!)).toBeLessThan(html.indexOf('<main'));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it("renders menu controls without nested buttons or duplicate element IDs", () => {
    const html = renderToStaticMarkup(<App />);
    const buttons = html.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(5);
    for (const button of buttons) {
      expect(button.match(/<button\b/g)).toHaveLength(1);
    }
    expect(html).not.toMatch(/<div\b[^>]*role="button"[^>]*>\s*<button\b/);

    const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of ["添加附件", "模型选择", "使用统计"]) {
      const triggers = buttons.filter((button) =>
        button.includes(`aria-label="${label}"`),
      );
      expect(triggers).toHaveLength(1);
      expect(triggers[0]).toContain('aria-expanded="false"');
    }
  });

  it("hides the kept-mounted project panel in React Aria's inactive state", () => {
    const html = renderToStaticMarkup(<App />);
    const inactivePanels = html.match(/<div\b[^>]*data-inert="true"[^>]*>/g) ?? [];
    expect(inactivePanels.some((panel) => panel.includes("tabs__panel") && panel.includes("data-[inert=true]:hidden"))).toBe(true);
  });
});
