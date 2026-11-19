import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchShell, type WindowSizeClass } from "./workbench-shell";

afterEach(() => vi.unstubAllGlobals());

function renderShell(sizeClass: WindowSizeClass, collapsed = false, rightCollapsed = collapsed) {
  return renderToStaticMarkup(
    <WorkbenchShell
      sizeClass={sizeClass}
      leftCollapsed={collapsed}
      rightCollapsed={rightCollapsed}
      sheet={undefined}
      onCloseSheet={() => {}}
      leftLabel="导航"
      rightLabel="任务"
      leftControl={<button aria-label="切换导航" />}
      titlebarContent={<h1>当前话题</h1>}
      rightControl={<button aria-label="切换任务栏" />}
      leftContent={<p>话题列表</p>}
      centerContent={<p>对话内容</p>}
      rightContent={<p>任务列表</p>}
    />,
  );
}

describe("shared window toolbar", () => {
  it.each(["expanded", "medium", "compact"] as const)("retains both controls with %s panes collapsed", (sizeClass) => {
    const html = renderShell(sizeClass, true);
    expect(html).toContain('aria-label="切换导航"');
    expect(html).toContain('aria-label="切换任务栏"');
    expect(html).toContain("当前话题");
    expect(html).toContain("对话内容");
    const panels = html.match(/<aside\b[^>]*>/g) ?? [];
    expect(panels).toHaveLength(sizeClass === "expanded" ? 2 : sizeClass === "medium" ? 1 : 0);
    for (const panel of panels) {
      expect(panel).toContain('data-collapsed="true"');
      expect(panel).toContain('aria-hidden="true"');
      expect(panel).toContain('inert=""');
    }
    expect(html.includes("话题列表")).toBe(sizeClass !== "compact");
    expect(html.includes("任务列表")).toBe(sizeClass === "expanded");
  });

  it.each([[true, false], [false, true]])("isolates collapsed pane accessibility when left=%s and right=%s", (left, right) => {
    const html = renderShell("expanded", left, right);
    const panels = html.match(/<aside\b[^>]*>/g) ?? [];
    expect(panels).toHaveLength(2);
    for (const [index, collapsed] of [left, right].entries()) {
      expect(panels[index].includes('aria-hidden="true"')).toBe(collapsed);
      expect(panels[index].includes('inert=""')).toBe(collapsed);
    }
    expect(html).toContain("话题列表");
    expect(html).toContain("任务列表");
  });

  it.each([
    ["expanded", true, true],
    ["medium", true, false],
    ["compact", false, false],
  ] as const)("aligns toolbar tracks with visible %s panes", (sizeClass, left, right) => {
    const html = renderShell(sizeClass);
    expect(html).toContain(`data-left-visible="${left}"`);
    expect(html).toContain(`data-right-visible="${right}"`);
    expect(html.includes("话题列表")).toBe(left);
    expect(html.includes("任务列表")).toBe(right);
  });

  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Electron/45.3.3", true],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/142.0", false],
    ["Mozilla/5.0 (Windows NT 10.0) Electron/45.3.3", false],
  ])("reserves native macOS controls only for the matching desktop shell", (userAgent, native) => {
    vi.stubGlobal("navigator", { userAgent });
    const html = renderShell("expanded");
    expect(html.includes('data-native-titlebar="true"')).toBe(native);
    expect(html.match(/<header\b/g)).toHaveLength(1);
    expect(html).not.toContain('class="moco-window-titlebar" aria-hidden');
  });
});
