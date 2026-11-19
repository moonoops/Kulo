import { useI18n } from "../../kulo-i18n";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Drawer } from "@heroui/react";
import {
  clampRailWidth,
  computeRightRailBounds,
  defaultSettingsRailWidth,
  stepRailWidth,
} from "./workbench-rail-resize";

export type WindowSizeClass = "expanded" | "medium" | "compact";

export interface WorkbenchRailResizeConfig {
  width: number | null;
  onWidthChange: (width: number | null) => void;
  minWidth?: number;
  maxWidth?: number;
  minMainWidth?: number;
  label?: string;
}

interface ActiveResizeDrag {
  pointerId: number;
  startX: number;
  startWidth: number;
  latestWidth: number;
  moved: boolean;
  rtl: boolean;
  target: HTMLDivElement;
  cleanup: () => void;
}

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
  rightResize,
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
  rightResize?: WorkbenchRailResizeConfig;
}) {
  const { t } = useI18n();
  const rightPaneId = useId();
  const workbenchRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const dragSessionRef = useRef<ActiveResizeDrag | null>(null);
  const showInlineLeft = sizeClass !== "compact";
  const showInlineRight = sizeClass === "expanded";
  const leftVisible = showInlineLeft && !leftCollapsed;
  const rightVisible = showInlineRight && !rightCollapsed;
  const rightResizable = Boolean(showInlineRight && rightResize);
  const leftDrawerOpen = !showInlineLeft && sheet === "left";
  const rightDrawerOpen = !showInlineRight && sheet === "right";
  const nativeTitlebar = typeof navigator !== "undefined"
    && /\bElectron\/\d/.test(navigator.userAgent)
    && /Macintosh|Mac OS X/.test(navigator.userAgent);

  const [workbenchWidth, setWorkbenchWidth] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );
  const [resizing, setResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  useEffect(() => {
    const syncWidth = () => {
      const measured = workbenchRef.current?.clientWidth;
      if (measured && measured > 0) setWorkbenchWidth(measured);
      else if (typeof window !== "undefined" && window.innerWidth > 0) setWorkbenchWidth(window.innerWidth);
    };
    syncWidth();
    const element = workbenchRef.current;
    const observer = typeof ResizeObserver !== "undefined" && element
      ? new ResizeObserver(syncWidth)
      : null;
    if (observer && element) observer.observe(element);
    window.addEventListener("resize", syncWidth);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncWidth);
    };
  }, []);

  const railBounds = computeRightRailBounds({
    workbenchWidth,
    leftVisible,
    minWidth: rightResize?.minWidth,
    maxWidth: rightResize?.maxWidth,
    minMainWidth: rightResize?.minMainWidth,
  });
  const railBoundsRef = useRef(railBounds);
  railBoundsRef.current = railBounds;

  const rightResizeRef = useRef(rightResize);
  rightResizeRef.current = rightResize;

  const cancelActiveDrag = useCallback(() => {
    const session = dragSessionRef.current;
    if (!session) return;
    dragSessionRef.current = null;
    session.cleanup();
    try {
      if (session.target.hasPointerCapture?.(session.pointerId)) {
        session.target.releasePointerCapture(session.pointerId);
      }
    } catch {
      // Synthetic pointer events may not hold native capture.
    }
    setResizing(false);
    setDragWidth(null);
  }, []);

  useEffect(() => {
    if (!rightResizable || rightCollapsed) cancelActiveDrag();
  }, [rightResizable, rightCollapsed, cancelActiveDrag]);

  useEffect(() => cancelActiveDrag, [cancelActiveDrag]);

  const displayedRightWidth = rightResizable
    ? resizing && dragWidth !== null
      ? clampRailWidth(dragWidth, railBounds)
      : rightResize?.width != null
        ? clampRailWidth(rightResize.width, railBounds)
        : null
    : null;

  const ariaRightWidth = displayedRightWidth ?? defaultSettingsRailWidth(workbenchWidth, railBounds);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rightResizable || rightCollapsed) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    cancelActiveDrag();

    const target = event.currentTarget;
    const measuredRailWidth = railRef.current?.getBoundingClientRect().width;
    const startWidth = measuredRailWidth && measuredRailWidth > 0
      ? clampRailWidth(measuredRailWidth, railBoundsRef.current)
      : ariaRightWidth;
    const rtl = typeof getComputedStyle === "function" && getComputedStyle(target).direction === "rtl";

    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners below remain active when capture is unavailable.
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || moveEvent.pointerId !== session.pointerId) return;
      const delta = session.rtl
        ? moveEvent.clientX - session.startX
        : session.startX - moveEvent.clientX;
      if (!session.moved && Math.abs(delta) < 1) return;
      const next = clampRailWidth(session.startWidth + delta, railBoundsRef.current);
      session.moved = true;
      session.latestWidth = next;
      setDragWidth(next);
    };

    const finishDrag = (commit: boolean) => {
      const session = dragSessionRef.current;
      if (!session) return;
      const shouldCommit = commit && session.moved;
      const finalWidth = session.latestWidth;
      cancelActiveDrag();
      if (shouldCommit) rightResizeRef.current?.onWidthChange(finalWidth);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || upEvent.pointerId !== session.pointerId) return;
      finishDrag(true);
    };

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || cancelEvent.pointerId !== session.pointerId) return;
      finishDrag(false);
    };

    const onWindowBlur = () => finishDrag(false);

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape" || !dragSessionRef.current) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finishDrag(false);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("keydown", onKeyDown, true);

    dragSessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      latestWidth: startWidth,
      moved: false,
      rtl,
      target,
      cleanup: () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        window.removeEventListener("blur", onWindowBlur);
        document.removeEventListener("keydown", onKeyDown, true);
      },
    };
    setResizing(true);
    setDragWidth(startWidth);
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!rightResizable || rightCollapsed || !rightResize) return;
    const rtl = typeof getComputedStyle === "function" && getComputedStyle(event.currentTarget).direction === "rtl";
    const measuredRailWidth = railRef.current?.getBoundingClientRect().width;
    const baseWidth = displayedRightWidth
      ?? (measuredRailWidth && measuredRailWidth > 0 ? Math.round(measuredRailWidth) : ariaRightWidth);
    const next = stepRailWidth(baseWidth, event.key, event.shiftKey, railBounds, rtl);
    if (next === null) return;
    event.preventDefault();
    rightResize.onWidthChange(next === "reset" ? null : next);
  };

  const handleResizeReset = () => {
    if (!rightResizable || rightCollapsed || !rightResize) return;
    cancelActiveDrag();
    rightResize.onWidthChange(null);
  };

  const workbenchStyle = displayedRightWidth !== null
    ? ({ "--kulo-rail-custom-width": `${displayedRightWidth}px` } as CSSProperties)
    : undefined;

  return (
    <div
      ref={workbenchRef}
      style={workbenchStyle}
      className="kulo-workbench"
      data-layout={settingsMode ? "settings" : "conversation"}
      data-native-titlebar={nativeTitlebar || undefined}
      data-left-visible={leftVisible}
      data-right-visible={rightVisible}
      data-resizing={resizing || undefined}
    >
      <header className="kulo-window-titlebar" aria-label={t("窗口工具栏", "Window toolbar")}>
        <div className="kulo-window-navigation-control">{leftControl}</div>
        {titlebarContent}
        <div className="kulo-window-rail-control">{rightControl}</div>
      </header>
      <div className="kulo-workbench-panes">
        {showInlineLeft && (
          <aside
            aria-label={leftLabel}
            aria-hidden={leftCollapsed || undefined}
            inert={leftCollapsed}
            data-collapsed={leftCollapsed}
            className="kulo-workbench-navigation"
          >
            <div className="kulo-workbench-panel-content">{leftContent}</div>
          </aside>
        )}

        <main className="kulo-workbench-main" tabIndex={-1}>
          <div className="kulo-workbench-main-content">
            {centerContent}
          </div>
        </main>

        {rightResizable && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={rightResize?.label ?? t("调整设置对话宽度", "Resize settings chat width")}
            aria-controls={rightPaneId}
            aria-valuemin={railBounds.min}
            aria-valuemax={railBounds.max}
            aria-valuenow={ariaRightWidth}
            aria-hidden={rightCollapsed || undefined}
            inert={rightCollapsed}
            tabIndex={rightCollapsed ? -1 : 0}
            data-collapsed={rightCollapsed}
            data-resizing={resizing || undefined}
            className="kulo-workbench-resizer"
            onPointerDown={handleResizePointerDown}
            onKeyDown={handleResizeKeyDown}
            onDoubleClick={handleResizeReset}
          />
        )}

        {showInlineRight && (
          <aside
            id={rightResizable ? rightPaneId : undefined}
            ref={railRef}
            aria-label={rightLabel}
            aria-hidden={rightCollapsed || undefined}
            inert={rightCollapsed}
            data-collapsed={rightCollapsed}
            className={settingsMode ? "kulo-workbench-rail kulo-workbench-settings-rail" : "kulo-workbench-rail"}
          >
            <div className={"kulo-workbench-panel-content" + (settingsMode ? " kulo-workbench-settings-content" : "")}>{rightContent}</div>
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
            <Drawer.Dialog data-kulo-overlay="workbench-drawer" aria-label={leftLabel} className="flex h-full flex-col">
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
            <Drawer.Dialog data-kulo-overlay="workbench-drawer" aria-label={rightLabel} className="flex h-full flex-col">
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
