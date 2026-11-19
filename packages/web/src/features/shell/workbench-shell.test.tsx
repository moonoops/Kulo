import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchShell, type WindowSizeClass, type WorkbenchRailResizeConfig } from "./workbench-shell";

afterEach(() => vi.unstubAllGlobals());

function renderShell(
  sizeClass: WindowSizeClass,
  collapsed = false,
  rightCollapsed = collapsed,
  extra?: { settingsMode?: boolean; rightResize?: WorkbenchRailResizeConfig },
) {
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
      settingsMode={extra?.settingsMode}
      rightResize={extra?.rightResize}
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
    expect(html).not.toContain('class="kulo-window-titlebar" aria-hidden');
  });

  it("renders an accessible vertical separator and applies clamped custom width when rightResize is active", () => {
    const html = renderShell("expanded", false, false, {
      settingsMode: true,
      rightResize: { width: 640, onWidthChange: () => {}, label: "调整设置对话宽度" },
    });
    const separator = html.match(/<div\b[^>]*role="separator"[^>]*>/)?.[0];
    expect(separator).toBeDefined();
    expect(separator).toContain('aria-orientation="vertical"');
    expect(separator).toContain('aria-label="调整设置对话宽度"');
    expect(separator).toContain('aria-valuemin="320"');
    expect(separator).toContain('aria-valuemax="792"');
    expect(separator).toContain('aria-valuenow="640"');
    expect(separator).toContain('tabindex="0"');
    expect(separator).toContain('data-collapsed="false"');
    const controlsId = separator?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlsId).toBeTruthy();
    expect(html).toContain(`<aside id="${controlsId}"`);
    expect(html).toContain("--kulo-rail-custom-width:640px");

    // Oversized saved width is clamped to viewport bounds without breaking layout
    const clampedHtml = renderShell("expanded", false, false, {
      settingsMode: true,
      rightResize: { width: 900, onWidthChange: () => {} },
    });
    expect(clampedHtml).toContain("--kulo-rail-custom-width:792px");
    expect(clampedHtml).toContain('aria-valuenow="792"');
  });

  it("hides and isolates the separator when collapsed, non-expanded, or non-resizable", () => {
    const collapsed = renderShell("expanded", false, true, {
      settingsMode: true,
      rightResize: { width: 520, onWidthChange: () => {} },
    });
    const separator = collapsed.match(/<div\b[^>]*role="separator"[^>]*>/)?.[0];
    expect(separator).toContain('aria-hidden="true"');
    expect(separator).toContain('inert=""');
    expect(separator).toContain('tabindex="-1"');
    expect(separator).toContain('data-collapsed="true"');

    const medium = renderShell("medium", false, false, {
      settingsMode: true,
      rightResize: { width: 520, onWidthChange: () => {} },
    });
    expect(medium).not.toContain('role="separator"');
    expect(medium).not.toContain("--kulo-rail-custom-width");

    const conversation = renderShell("expanded", false, false);
    expect(conversation).not.toContain('role="separator"');
    expect(conversation).not.toContain("--kulo-rail-custom-width");
  });
});
