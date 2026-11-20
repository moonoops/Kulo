import { useId } from "react";
import { Button, Card, Modal, Spinner, Tooltip } from "@heroui/react";
import type { ComputerPreviewSessionView } from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import type { ComputerPreviewClient, ComputerPreviewState, PreviewDisplay } from "./preview-client";
import { requestSystemPermissionHelp } from "../system-permissions/system-permissions";
import "./computer-preview.css";

export type ComputerPreviewActions = Pick<
  ComputerPreviewClient,
  "setCollapsed" | "setExpanded" | "expandTicket" | "collapseTicket" | "openModal" | "closeModal" | "select" | "stopTask" | "retry" | "frameFailed"
>;

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

function resolveCardSession(
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
  className,
}: {
  selected: ComputerPreviewSessionView;
  display: PreviewDisplay | undefined;
  reconnecting: boolean;
  client: Pick<ComputerPreviewActions, "frameFailed" | "openModal">;
  zoomable?: boolean;
  className: string;
}) {
  const { t } = useI18n();
  const frameError = display?.message === "invalid_frame" ? t("画面无法显示", "The frame could not be displayed") : display?.message;
  const liveImage = Boolean(display?.imageUrl && !reconnecting);
  const canZoom = Boolean(zoomable && liveImage);

  return (
    <div
      className={className}
      data-zoomable={canZoom || undefined}
      onClick={canZoom ? () => client.openModal(selected.id) : undefined}
    >
      {liveImage ? (
        <img
          className="kulo-computer-preview-image"
          src={display!.imageUrl}
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

/** Embedded live computer/browser preview rendered inside its owning Worker task card. */
export function TaskCardComputerPreview({
  ticketId,
  ticketTitle,
  sessions,
  state,
  client,
  connected,
  onStop,
}: {
  ticketId: string;
  ticketTitle: string;
  sessions: readonly ComputerPreviewSessionView[];
  state: ComputerPreviewState;
  client: ComputerPreviewActions;
  connected: boolean;
  onStop: (ticketId: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const bodyId = useId();
  const selected = resolveCardSession(state, ticketId, sessions);
  if (!selected) return null;

  const isExpanded = isTicketPreviewExpanded(state, ticketId);
  const display = state.displays[selected.id];
  const stop = state.stops[ticketId];
  const reconnecting = state.connection !== "connected";
  const stopped = Boolean(stop?.pending || stop?.accepted);
  const previewError = state.error === "invalid_preview" ? t("预览数据无效", "Invalid preview data") : state.error;
  const status = previewStatusLabel(t, selected, display, reconnecting);
  const degraded = reconnecting || display?.state === "unavailable" || display?.state === "closed";
  const metaText = degraded
    ? `${selected.deviceName} · ${status}`
    : selected.app
      ? `${selected.app} · ${selected.deviceName}`
      : `${selected.deviceName} · ${status}`;
  const fullMeta = [selected.deviceName, selected.app, status].filter(Boolean).join(" · ");
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
      <div className="kulo-task-preview-bar">
        <div className="kulo-task-preview-meta" title={fullMeta}>
          <KuloIcon name={selected.tool === "browser" ? "video" : "image"} size={14} className="text-muted" />
          <span className="kulo-task-preview-label text-xs text-muted">{metaText}</span>
        </div>
        <div className="kulo-task-preview-controls">
          {isExpanded && (
            <Tooltip delay={350}>
              <Button
                type="button"
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={t(`放大操作预览：${ticketTitle}`, `Enlarge operation preview: ${ticketTitle}`)}
                onPress={() => client.openModal(selected.id)}
              >
                <KuloIcon name="maximize" size={14} />
              </Button>
              <Tooltip.Content placement="top">{t("放大", "Enlarge")}</Tooltip.Content>
            </Tooltip>
          )}
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
        </div>
      </div>

      <div id={bodyId} hidden={!isExpanded} className="kulo-task-preview-body">
        {sessions.length > 1 && (
          <div className="kulo-computer-preview-sessions scrollbar" aria-label={t("操作会话", "Operation sessions")}>
            {sessions.map((item) => (
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
                {item.app ?? (item.tool === "browser" ? t("浏览器", "Browser") : t("桌面", "Desktop"))}
              </Button>
            ))}
          </div>
        )}
        <PreviewViewport
          selected={selected}
          display={display}
          reconnecting={reconnecting}
          client={client}
          zoomable
          className="kulo-task-preview-viewport"
        />
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
  const title = sessions[0]?.title ?? "";
  if (!title) return null;
  return (
    <div className="kulo-task-space">
      <Card variant="secondary" className="kulo-task-card" data-state="running">
        <Card.Content className="kulo-task-card-content">
          <div className="kulo-task-preview-orphan-head">
            <strong className="kulo-task-title" title={title}>{title}</strong>
          </div>
          <TaskCardComputerPreview
            ticketId={ticketId}
            ticketTitle={title}
            sessions={sessions}
            state={state}
            client={client}
            connected={connected}
            onStop={onStop}
          />
        </Card.Content>
      </Card>
    </div>
  );
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
  const selected = state.sessions.find((item) => item.id === state.selectedId) ?? state.sessions[0];
  const open = Boolean(state.expanded && selected);
  const display = selected ? state.displays[selected.id] : undefined;
  const stop = selected ? state.stops[selected.ticketId] : undefined;
  const reconnecting = state.connection !== "connected";
  const stopped = Boolean(stop?.pending || stop?.accepted);
  const previewError = state.error === "invalid_preview" ? t("预览数据无效", "Invalid preview data") : state.error;
  const status = selected ? previewStatusLabel(t, selected, display, reconnecting) : "";
  const subtitle = selected ? [selected.deviceName, selected.app, status].filter(Boolean).join(" · ") : "";
  const showReconnect = Boolean(selected && (previewError || reconnecting || display?.state === "unavailable"));
  const showPermission = Boolean(
    selected && selected.tool === "desktop" && display?.state !== "closed" && (display?.state === "unavailable" || !display?.imageUrl),
  );

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
                {state.sessions.length > 1 && (
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
                        {item.app ?? item.title}
                      </Button>
                    ))}
                  </div>
                )}

                <PreviewViewport
                  selected={selected}
                  display={display}
                  reconnecting={reconnecting}
                  client={client}
                  className="kulo-computer-preview-modal-stage"
                />

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
                  <Button
                    type="button"
                    size="sm"
                    variant="danger-soft"
                    isDisabled={!connected || stopped}
                    isPending={Boolean(stop?.pending)}
                    aria-label={t(`停止任务：${selected.title}`, `Stop task: ${selected.title}`)}
                    onPress={() => { void client.stopTask(onStop, selected.ticketId); }}
                  >
                    {stop?.pending ? <Spinner size="sm" color="current" /> : <KuloIcon name="stop" size={14} />}
                    {stopped ? t("停止中", "Stopping") : t("停止任务", "Stop task")}
                  </Button>
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
