import { useI18n } from "../../moco-i18n";
import type { ReactNode } from "react";
import { Drawer } from "@heroui/react";

export type WindowSizeClass = "expanded" | "medium" | "compact";

export function WorkbenchShell({
  sizeClass,
  leftCollapsed,
  rightCollapsed,
  sheet,
  onCloseSheet,
  leftLabel,
  rightLabel,
  leftControl,
  titlebarContent,
  rightControl,
  leftContent,
  centerContent,
  rightContent,
  settingsMode = false,
}: {
  sizeClass: WindowSizeClass;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  sheet: "left" | "right" | undefined;
  onCloseSheet: () => void;
  leftLabel: string;
  rightLabel: string;
  leftControl: ReactNode;
  titlebarContent: ReactNode;
  rightControl: ReactNode;
  leftContent: ReactNode;
  centerContent: ReactNode;
  rightContent: ReactNode;
  settingsMode?: boolean;
}) {
  const { t } = useI18n();
  const showInlineLeft = sizeClass !== "compact";
  const showInlineRight = sizeClass === "expanded";
  const leftDrawerOpen = !showInlineLeft && sheet === "left";
  const rightDrawerOpen = !showInlineRight && sheet === "right";
  const nativeTitlebar = typeof navigator !== "undefined"
    && /\bElectron\/\d/.test(navigator.userAgent)
    && /Macintosh|Mac OS X/.test(navigator.userAgent);

  return (
    <div className="moco-workbench" data-layout={settingsMode ? "settings" : "conversation"} data-native-titlebar={nativeTitlebar || undefined} data-left-visible={showInlineLeft && !leftCollapsed} data-right-visible={showInlineRight && !rightCollapsed}>
      <header className="moco-window-titlebar" aria-label={t("窗口工具栏", "Window toolbar")}>
        <div className="moco-window-navigation-control">{leftControl}</div>
        {titlebarContent}
        <div className="moco-window-rail-control">{rightControl}</div>
      </header>
      <div className="moco-workbench-panes">
        {showInlineLeft && (
          <aside
            aria-label={leftLabel}
            aria-hidden={leftCollapsed || undefined}
            inert={leftCollapsed}
            data-collapsed={leftCollapsed}
            className="moco-workbench-navigation"
          >
            <div className="moco-workbench-panel-content">{leftContent}</div>
          </aside>
        )}

        <main className="moco-workbench-main" tabIndex={-1}>
          <div className="moco-workbench-main-content">
            {centerContent}
          </div>
        </main>

        {showInlineRight && (
          <aside
            aria-label={rightLabel}
            aria-hidden={rightCollapsed || undefined}
            inert={rightCollapsed}
            data-collapsed={rightCollapsed}
            className={settingsMode ? "moco-workbench-rail moco-workbench-settings-rail" : "moco-workbench-rail"}
          >
            <div className={"moco-workbench-panel-content" + (settingsMode ? " moco-workbench-settings-content" : "")}>{rightContent}</div>
          </aside>
        )}
      </div>

      {/* Left Navigation Drawer for Compact Screens (< 840px) */}
      <Drawer
        isOpen={leftDrawerOpen}
        onOpenChange={(open) => {
          if (!open) onCloseSheet();
        }}
      >
        <Drawer.Backdrop
          isOpen={leftDrawerOpen}
          onOpenChange={(open) => {
            if (!open) onCloseSheet();
          }}
        >
          <Drawer.Content placement="left" className="max-w-[300px]">
            <Drawer.Dialog data-moco-overlay="workbench-drawer" aria-label={leftLabel} className="flex h-full flex-col">
              <div className="mb-2 flex items-center justify-between">
                <Drawer.Heading className="font-semibold text-muted">
                  {leftLabel}
                </Drawer.Heading>
                <Drawer.CloseTrigger aria-label={t("关闭导航", "Close navigation")} />
              </div>
              <Drawer.Body className="min-h-0 flex-1 overflow-hidden p-0">
                {leftContent}
              </Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>

      {/* Right Workbench / Assistant Drawer for Compact & Medium Screens (< 1060px) */}
      <Drawer
        isOpen={rightDrawerOpen}
        onOpenChange={(open) => {
          if (!open) onCloseSheet();
        }}
      >
        <Drawer.Backdrop
          isOpen={rightDrawerOpen}
          onOpenChange={(open) => {
            if (!open) onCloseSheet();
          }}
        >
          <Drawer.Content placement="right" className={settingsMode ? "w-full max-w-[420px]" : "max-w-[332px]"}>
            <Drawer.Dialog data-moco-overlay="workbench-drawer" aria-label={rightLabel} className="flex h-full flex-col">
              <div className="mb-2 flex shrink-0 items-center justify-end">
                <Drawer.Heading className="sr-only">{rightLabel}</Drawer.Heading>
                <Drawer.CloseTrigger className="static" aria-label={settingsMode ? t("关闭设置对话", "Close settings chat") : t("关闭任务栏", "Close task panel")} />
              </div>
              <Drawer.Body className="min-h-0 flex-1 overflow-hidden p-0">
                {rightContent}
              </Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
    </div>
  );
}
