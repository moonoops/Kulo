import { useId, useRef, useState } from "react";
import { Button, Card, Modal, Spinner, Tooltip } from "@heroui/react";
import type { ComputerPreviewInputEvent, ComputerPreviewSessionView } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import type { ComputerPreviewClient, ComputerPreviewState, PreviewDisplay } from "./preview-client";
import { requestSystemPermissionHelp } from "../system-permissions/system-permissions";
import { ComputerHandoffBar, keyEventModifiers, mapImagePointerToDeviceCoords, mouseButtonName } from "./handoff-controls";
import "./computer-preview.css";

export type ComputerPreviewActions = Pick<
  ComputerPreviewClient,
  "setCollapsed" | "setExpanded" | "expandTicket" | "collapseTicket" | "openModal" | "closeModal" | "select" | "stopTask" | "retry" | "frameFailed"
> & {
  sendInput?: ComputerPreviewClient["sendInput"];
};

export interface ComputerPreviewBinding {
  state: ComputerPreviewState;
  client: ComputerPreviewActions;
  onStop: (ticketId: string) => Promise<unknown>;
}

function previewStatusLabel(
  t: (zh: string, en: string) => string,
  selected: ComputerPreviewSessionView,
  display: PreviewDisplay | undefined,
  reconnecting: boolean,
): string {
  if (reconnecting) return t("重连中", "Reconnecting");
  if (display?.state === "closed") return t("操作已结束", "Operation ended");
  if (display?.state === "unavailable") return t("预览不可用", "Preview unavailable");
  return selected.tool === "browser" ? t("实时画面", "Live view") : t("操作截图", "Action snapshot");
}

export function resolveCardPreviewSession(
  state: ComputerPreviewState,
  ticketId: string,
  ticketSessions: readonly ComputerPreviewSessionView[],
): ComputerPreviewSessionView | undefined {
  const chosenId = state.selectedByTicket[ticketId];
  return ticketSessions.find((item) => item.id === chosenId)
    ?? ticketSessions.find((item) => item.id === state.selectedId)
    ?? ticketSessions[0];
}

export function isTicketPreviewExpanded(state: ComputerPreviewState, ticketId: string): boolean {
  if (state.collapsed) return false;
  const activeTicketId = state.activeTicketId
    ?? state.sessions.find((item) => item.id === state.selectedId)?.ticketId
    ?? state.sessions[0]?.ticketId;
  return activeTicketId === ticketId;
}

function PreviewViewport({
  selected,
  display,
  reconnecting,
  client,
  zoomable,
  interactive,
  onSendInput,
  className,
}: {
  selected: ComputerPreviewSessionView;
  display: PreviewDisplay | undefined;
  reconnecting: boolean;
  client: Pick<ComputerPreviewActions, "frameFailed" | "openModal">;
  zoomable?: boolean;
  interactive?: boolean;
  onSendInput?: (event: ComputerPreviewInputEvent) => boolean;
  className: string;
}) {
  const { t } = useI18n();
  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastMoveAtRef = useRef(0);
  const frameError = display?.message === "invalid_frame" ? t("画面无法显示", "The frame could not be displayed") : display?.message;
  const liveImage = Boolean(display?.imageUrl && !reconnecting);
  const canZoom = Boolean(zoomable && liveImage);
  const canInteract = Boolean(interactive && liveImage && onSendInput);

  const mapCoords = (clientX: number, clientY: number) =>
    imgRef.current ? mapImagePointerToDeviceCoords(imgRef.current, clientX, clientY, display?.deviceWidth, display?.deviceHeight) : null;

  return (
    <div
      ref={stageRef}
      className={className}
      tabIndex={canInteract ? 0 : undefined}
      role={canInteract ? "application" : undefined}
      aria-label={canInteract ? t("可交互浏览器画面，点击后可直接输入", "Interactive browser viewport") : undefined}
      data-zoomable={canZoom || undefined}
      data-interactive={canInteract || undefined}
      onClick={canZoom ? () => client.openModal(selected.id) : undefined}
      onContextMenu={canInteract ? (event) => event.preventDefault() : undefined}
      onPointerDown={canInteract ? (event) => {
        const coords = mapCoords(event.clientX, event.clientY);
        if (!coords) return;
        stageRef.current?.focus({ preventScroll: true });
        if (event.pointerType === "touch") {
          onSendInput!({ type: "input_touch", eventType: "touchStart", touchPoints: [{ x: coords.x, y: coords.y, id: event.pointerId }] });
        } else {
          onSendInput!({ type: "input_mouse", eventType: "mousePressed", x: coords.x, y: coords.y, button: mouseButtonName(event.button), clickCount: Math.max(1, Math.min(3, event.detail || 1)), modifiers: keyEventModifiers(event) });
        }
      } : undefined}
      onPointerUp={canInteract ? (event) => {
        const coords = mapCoords(event.clientX, event.clientY);
        if (!coords) return;
        if (event.pointerType === "touch") {
          onSendInput!({ type: "input_touch", eventType: "touchEnd", touchPoints: [{ x: coords.x, y: coords.y, id: event.pointerId }] });
        } else {
          onSendInput!({ type: "input_mouse", eventType: "mouseReleased", x: coords.x, y: coords.y, button: mouseButtonName(event.button), clickCount: 1, modifiers: keyEventModifiers(event) });
        }
      } : undefined}
      onPointerMove={canInteract ? (event) => {
        const now = performance.now();
        if (now - lastMoveAtRef.current < 32) return;
        const coords = mapCoords(event.clientX, event.clientY);
        if (!coords) return;
        lastMoveAtRef.current = now;
        if (event.pointerType === "touch") {
          onSendInput!({ type: "input_touch", eventType: "touchMove", touchPoints: [{ x: coords.x, y: coords.y, id: event.pointerId }] });
        } else {
          onSendInput!({ type: "input_mouse", eventType: "mouseMoved", x: coords.x, y: coords.y, button: "none", modifiers: keyEventModifiers(event) });
        }
      } : undefined}
      onWheel={canInteract ? (event) => {
        const coords = mapCoords(event.clientX, event.clientY);
        if (!coords) return;
        onSendInput!({ type: "input_mouse", eventType: "mouseWheel", x: coords.x, y: coords.y, deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY), modifiers: keyEventModifiers(event) });
      } : undefined}
      onKeyDown={canInteract ? (event) => {
        if (event.key === "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        const text = event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : undefined;
        onSendInput!({ type: "input_keyboard", eventType: "keyDown", key: event.key, code: event.code, ...(text ? { text } : {}), windowsVirtualKeyCode: event.keyCode, modifiers: keyEventModifiers(event) });
      } : undefined}
      onKeyUp={canInteract ? (event) => {
        if (event.key === "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        onSendInput!({ type: "input_keyboard", eventType: "keyUp", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: keyEventModifiers(event) });
      } : undefined}
    >
      {liveImage ? (
        <img
          ref={imgRef}
          className="kulo-computer-preview-image"
          src={display!.imageUrl}
          draggable={false}
          onError={() => client.frameFailed(selected.id, display!.imageUrl!)}
          alt={selected.tool === "browser" ? t("浏览器操作画面", "Browser operation view") : t("应用窗口截图", "Application window snapshot")}
        />
      ) : (
        <div className="kulo-computer-preview-placeholder text-xs text-muted">
          {(display?.state === "unavailable" || display?.state === "closed") && !reconnecting ? (
            <>
              <KuloIcon name="image" size={18} />
              <span>{display.state === "closed" ? t("操作已结束", "Operation ended") : frameError || t("无法获取窗口画面", "The window view is unavailable")}</span>
            </>
          ) : (
            <>
              <Spinner size="sm" className="motion-reduce:animate-none" />
              <span>{reconnecting ? t("正在连接预览", "Connecting preview") : t("等待画面", "Waiting for a frame")}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact expand/collapse and stop controls aligned in the task card's title row. */
export function TaskCardPreviewControls({
  ticketId,
  ticketTitle,
  bodyId,
  state,
  client,
  connected,
  onStop,
}: {
  ticketId: string;
  ticketTitle: string;
  bodyId: string;
  state: ComputerPreviewState;
  client: ComputerPreviewActions;
  connected: boolean;
  onStop: (ticketId: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const isExpanded = isTicketPreviewExpanded(state, ticketId);
  const stop = state.stops[ticketId];
  const stopped = Boolean(stop?.pending || stop?.accepted);

  return (
    <div className="kulo-task-preview-controls">
      <Tooltip delay={350}>
        <Button
          type="button"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-controls={bodyId}
          aria-expanded={isExpanded}
          aria-label={isExpanded
            ? t(`收起操作预览：${ticketTitle}`, `Collapse operation preview: ${ticketTitle}`)
            : t(`展开操作预览：${ticketTitle}`, `Expand operation preview: ${ticketTitle}`)}
          onPress={() => (isExpanded ? client.collapseTicket(ticketId) : client.expandTicket(ticketId))}
        >
          <KuloIcon name={isExpanded ? "chevron-up" : "chevron-down"} size={16} />
        </Button>
        <Tooltip.Content placement="top">{isExpanded ? t("收起画面", "Collapse view") : t("展开画面", "Expand view")}</Tooltip.Content>
      </Tooltip>
      {!ticketId.startsWith("chat:") && (
        <Tooltip delay={350}>
          <Button
            type="button"
            isIconOnly
            size="sm"
            variant="danger-soft"
            isDisabled={!connected || stopped}
            isPending={Boolean(stop?.pending)}
            aria-label={t(`停止任务：${ticketTitle}`, `Stop task: ${ticketTitle}`)}
            onPress={() => { void client.stopTask(onStop, ticketId); }}
          >
            {stop?.pending ? <Spinner size="sm" color="current" /> : <KuloIcon name="stop" size={14} />}
          </Button>
          <Tooltip.Content placement="top">{stopped ? t("停止中", "Stopping") : t("停止任务", "Stop task")}</Tooltip.Content>
        </Tooltip>
      )}
    </div>
  );
}

/** Embedded live computer/browser preview viewport rendered inside its owning Worker task card. */
export function TaskCardComputerPreview({
  ticketId,
  ticketTitle,
  bodyId: externalBodyId,
  showInlineControls = false,
  sessions,
  state,
  client,
  connected,
  onStop,
}: {
  ticketId: string;
  ticketTitle: string;
  bodyId?: string;
  showInlineControls?: boolean;
  sessions: readonly ComputerPreviewSessionView[];
  state: ComputerPreviewState;
  client: ComputerPreviewActions;
  connected: boolean;
  onStop: (ticketId: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const generatedBodyId = useId();
  const bodyId = externalBodyId ?? generatedBodyId;
  const selected = resolveCardPreviewSession(state, ticketId, sessions);
  if (!selected) return null;

  const isExpanded = isTicketPreviewExpanded(state, ticketId);
  const display = state.displays[selected.id];
  const stop = state.stops[ticketId];
  const reconnecting = state.connection !== "connected";
  const previewError = state.error === "invalid_preview" ? t("预览数据无效", "Invalid preview data") : state.error;
  const showFeedback = Boolean(
    previewError
      || reconnecting
      || display?.state === "unavailable"
      || (selected.tool === "desktop" && !display?.imageUrl && display?.state !== "closed"),
  );

  return (
    <section
      className="kulo-task-preview"
      aria-label={t(`设备操作预览：${ticketTitle}`, `Device operation preview: ${ticketTitle}`)}
      data-expanded={isExpanded || undefined}
    >
      {showInlineControls && (
        <div className="kulo-task-preview-orphan-head">
          <strong className="kulo-task-title" title={ticketTitle}>{ticketTitle}</strong>
          <TaskCardPreviewControls
            ticketId={ticketId}
            ticketTitle={ticketTitle}
            bodyId={bodyId}
            state={state}
            client={client}
            connected={connected}
            onStop={onStop}
          />
        </div>
      )}

      <div id={bodyId} hidden={!isExpanded} className="kulo-task-preview-body">
        <div className="kulo-task-preview-viewport-frame">
          <PreviewViewport
            selected={selected}
            display={display}
            reconnecting={reconnecting}
            client={client}
            zoomable
            className="kulo-task-preview-viewport"
          />
          {isExpanded && (
            <Tooltip delay={350}>
              <Button
                type="button"
                isIconOnly
                size="sm"
                variant="ghost"
                className="kulo-task-preview-zoom-button"
                aria-label={t(`放大操作预览：${ticketTitle}`, `Enlarge operation preview: ${ticketTitle}`)}
                onPress={() => client.openModal(selected.id)}
              >
                <KuloIcon name="maximize" size={14} />
              </Button>
              <Tooltip.Content placement="top">{t("放大", "Enlarge")}</Tooltip.Content>
            </Tooltip>
          )}
        </div>
        {selected.handoff && (
          <div className="kulo-computer-preview-feedback">
            <span className="text-xs text-foreground">{selected.handoff.reason}</span>
            <Button type="button" size="sm" variant="primary" onPress={() => client.openModal(selected.id)}>
              {t("接管操作", "Take over")}
            </Button>
          </div>
        )}
        {showFeedback && (
          <div className="kulo-computer-preview-feedback">
            {previewError && <span className="text-xs text-danger" role="alert">{previewError}</span>}
            {selected.tool === "desktop" && display?.state !== "closed" && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-label={t(`检查${selected.deviceName}的系统权限`, `Check system permissions on ${selected.deviceName}`)}
                onPress={() => requestSystemPermissionHelp({ kind: display?.permissionRequired ?? "accessibility", envId: selected.envId })}
              >
                {t("检查权限", "Check permissions")}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onPress={() => client.retry()}>
              {t("重新连接", "Reconnect")}
            </Button>
          </div>
        )}
      </div>

      {stop?.error && (
        <div className="kulo-computer-preview-feedback" role="alert">
          <span className="text-xs text-danger">{stop.error === "stop_failed" ? t("停止失败，请重试", "Could not stop the task. Try again") : stop.error}</span>
          <Button type="button" size="sm" variant="secondary" isDisabled={!connected} onPress={() => { void client.stopTask(onStop, ticketId); }}>
            {t("重试停止", "Retry stop")}
          </Button>
        </div>
      )}
    </section>
  );
}

/** Fallback card for an active preview session whose ticket row has not synced into the rail yet. */
export function OrphanComputerPreviewCard({
  ticketId,
  sessions,
  state,
  client,
  connected,
  onStop,
}: {
  ticketId: string;
  sessions: readonly ComputerPreviewSessionView[];
  state: ComputerPreviewState;
  client: ComputerPreviewActions;
  connected: boolean;
  onStop: (ticketId: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const selected = resolveCardPreviewSession(state, ticketId, sessions);
  const title = selected?.title ?? sessions[0]?.title ?? "";
  if (!title || !selected) return null;
  return (
    <div className="kulo-task-space">
      <Card variant="secondary" className="kulo-task-card" data-state="running" data-has-preview="true">
        <Card.Content className="kulo-task-card-content">
          <TaskCardComputerPreview
            ticketId={ticketId}
            ticketTitle={title}
            showInlineControls
            sessions={sessions}
            state={state}
            client={client}
            connected={connected}
            onStop={onStop}
          />
          <div className="kulo-task-card-foot kulo-task-card-preview-foot">
            <span className="kulo-task-card-status-group">
              <span className="kulo-task-status" data-tone="run" title={t("运行中", "Running")}>
                <span className="kulo-task-run-dot" aria-hidden="true" />
                <span className="kulo-task-status-label">{t("运行中", "Running")}</span>
              </span>
              {selected.deviceName && (
                <>
                  <span className="kulo-task-device-sep" aria-hidden="true">·</span>
                  <span className="kulo-task-device-name" title={selected.deviceName}>{selected.deviceName}</span>
                </>
              )}
            </span>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}

export function formatModalSessionLabels(
  sessions: readonly ComputerPreviewSessionView[],
  t: (zh: string, en: string) => string,
): Map<string, string> {
  const baseLabel = (item: ComputerPreviewSessionView) =>
    item.app ?? (item.tool === "browser" ? t("浏览器", "Browser") : item.title);
  const counts = new Map<string, number>();
  for (const item of sessions) {
    const label = baseLabel(item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const item of sessions) {
    const base = baseLabel(item);
    labels.set(item.id, (counts.get(base) ?? 0) > 1 ? `${base} · ${item.deviceName}` : base);
  }
  return labels;
}

/** Centered enlarged live preview modal opened from a Worker card or the collapsed-rail titlebar button. */
export function ComputerPreviewModal({
  state,
  client,
  connected,
  onStop,
}: {
  state: ComputerPreviewState;
  client: ComputerPreviewActions;
  connected: boolean;
  onStop: (ticketId: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string>();
  const selected = state.sessions.find((item) => item.id === state.selectedId) ?? state.sessions[0];
  const open = Boolean(state.expanded && selected);
  const display = selected ? state.displays[selected.id] : undefined;
  const stop = selected ? state.stops[selected.ticketId] : undefined;
  const reconnecting = state.connection !== "connected";
  const stopped = Boolean(stop?.pending || stop?.accepted);
  const previewError = state.error === "invalid_preview" ? t("预览数据无效", "Invalid preview data") : state.error;
  const status = selected ? (selected.handoff ? t("等待接管", "Awaiting handoff") : previewStatusLabel(t, selected, display, reconnecting)) : "";
  const subtitle = selected ? [selected.deviceName, selected.app, status].filter(Boolean).join(" · ") : "";
  const showReconnect = Boolean(selected && (previewError || reconnecting || display?.state === "unavailable"));
  const showPermission = Boolean(
    selected && selected.tool === "desktop" && display?.state !== "closed" && (display?.state === "unavailable" || !display?.imageUrl),
  );
  const handoff = selected?.handoff;
  const sendPreviewInput = selected && handoff?.interactive && client.sendInput
    ? (event: ComputerPreviewInputEvent) => client.sendInput!(selected.id, event)
    : undefined;
  const settleHandoff = async (action: "done" | "cancel") => {
    if (!selected || handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(undefined);
    try {
      await kuloRest.resolveComputerHandoff(selected.ticketId, action);
      if (action === "cancel") client.closeModal();
    } catch (err) {
      setHandoffError(err instanceof Error ? err.message : t("操作失败，请重试", "Action failed, try again"));
    } finally {
      setHandoffBusy(false);
    }
  };

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(next) => { if (!next) client.closeModal(); }}>
      <Modal.Container size="cover" placement="center" className="kulo-computer-preview-modal-container">
        <Modal.Dialog
          className="kulo-computer-preview-modal-dialog"
          aria-label={selected ? t(`设备操作预览：${selected.title}`, `Device operation preview: ${selected.title}`) : t("设备操作预览", "Device operation preview")}
        >
          <Modal.CloseTrigger aria-label={t("关闭放大预览", "Close enlarged preview")} />
          {selected && (
            <>
              <Modal.Header className="kulo-computer-preview-modal-header">
                <Modal.Heading className="kulo-computer-preview-modal-title">{selected.title}</Modal.Heading>
                <span className="text-xs text-muted">{subtitle}</span>
              </Modal.Header>

              <Modal.Body className="kulo-computer-preview-modal-body">
                {state.sessions.length > 1 && (() => {
                  const labels = formatModalSessionLabels(state.sessions, t);
                  return (
                    <div className="kulo-computer-preview-sessions scrollbar" aria-label={t("操作会话", "Operation sessions")}>
                      {state.sessions.map((item) => (
                        <Button
                          key={item.id}
                          type="button"
                          size="sm"
                          variant={item.id === selected.id ? "secondary" : "ghost"}
                          className="shrink-0"
                          aria-pressed={item.id === selected.id}
                          aria-label={t(`查看操作：${item.app ?? item.title} · ${item.deviceName}`, `View operation: ${item.app ?? item.title} · ${item.deviceName}`)}
                          onPress={() => client.select(item.id)}
                        >
                          {labels.get(item.id)}
                        </Button>
                      ))}
                    </div>
                  );
                })()}

                {handoff && (
                  <ComputerHandoffBar
                    handoff={handoff}
                    deviceName={selected.deviceName}
                    onSendInput={sendPreviewInput}
                  />
                )}

                <PreviewViewport
                  selected={selected}
                  display={display}
                  reconnecting={reconnecting}
                  client={client}
                  interactive={Boolean(sendPreviewInput)}
                  onSendInput={sendPreviewInput}
                  className="kulo-computer-preview-modal-stage"
                />

                {handoffError && (
                  <div className="kulo-computer-preview-feedback" role="alert">
                    <span className="text-xs text-danger">{handoffError}</span>
                  </div>
                )}

                {previewError && (
                  <div className="kulo-computer-preview-feedback" role="alert">
                    <span className="text-xs text-danger">{previewError}</span>
                  </div>
                )}

                {stop?.error && (
                  <div className="kulo-computer-preview-feedback" role="alert">
                    <span className="text-xs text-danger">{stop.error === "stop_failed" ? t("停止失败，请重试", "Could not stop the task. Try again") : stop.error}</span>
                    <Button type="button" size="sm" variant="secondary" isDisabled={!connected} onPress={() => { void client.stopTask(onStop, selected.ticketId); }}>
                      {t("重试停止", "Retry stop")}
                    </Button>
                  </div>
                )}
              </Modal.Body>

              <Modal.Footer className="kulo-computer-preview-modal-footer">
                <div className="kulo-computer-preview-modal-actions">
                  {handoff && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        isDisabled={!connected || handoffBusy || stopped}
                        isPending={handoffBusy}
                        onPress={() => { void settleHandoff("done"); }}
                      >
                        {t("已完成，请继续", "Done, continue")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        isDisabled={!connected || handoffBusy || stopped}
                        onPress={() => { void settleHandoff("cancel"); }}
                      >
                        {t("跳过并停止", "Skip & stop")}
                      </Button>
                    </>
                  )}
                  {showPermission && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={t(`检查${selected.deviceName}的系统权限`, `Check system permissions on ${selected.deviceName}`)}
                      onPress={() => requestSystemPermissionHelp({ kind: display?.permissionRequired ?? "accessibility", envId: selected.envId })}
                    >
                      {t("检查权限", "Check permissions")}
                    </Button>
                  )}
                  {showReconnect && (
                    <Button type="button" size="sm" variant="ghost" onPress={() => client.retry()}>
                      {t("重新连接", "Reconnect")}
                    </Button>
                  )}
                  {selected.ticketId.startsWith("chat:") ? (
                    !handoff && (
                      <Button
                        type="button"
                        size="sm"
                        variant="danger-soft"
                        isDisabled={!connected || handoffBusy}
                        isPending={handoffBusy}
                        aria-label={t(`结束会话：${selected.title}`, `End session: ${selected.title}`)}
                        onPress={() => { void settleHandoff("cancel"); }}
                      >
                        {handoffBusy ? <Spinner size="sm" color="current" /> : <KuloIcon name="stop" size={14} />}
                        {t("结束会话", "End session")}
                      </Button>
                    )
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger-soft"
                      isDisabled={!connected || stopped || handoffBusy}
                      isPending={Boolean(stop?.pending)}
                      aria-label={t(`停止任务：${selected.title}`, `Stop task: ${selected.title}`)}
                      onPress={() => { void client.stopTask(onStop, selected.ticketId); }}
                    >
                      {stop?.pending ? <Spinner size="sm" color="current" /> : <KuloIcon name="stop" size={14} />}
                      {stopped ? t("停止中", "Stopping") : t("停止任务", "Stop task")}
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="secondary" onPress={() => client.closeModal()}>
                    {t("关闭", "Close")}
                  </Button>
                </div>
              </Modal.Footer>
            </>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
