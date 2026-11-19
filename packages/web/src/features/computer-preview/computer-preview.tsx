import { useId } from "react";
import { Button, Spinner } from "@heroui/react";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import type { ComputerPreviewClient, ComputerPreviewState } from "./preview-client";
import { useComputerPreview } from "./use-computer-preview";
import { requestSystemPermissionHelp } from "../system-permissions/system-permissions";
import "./computer-preview.css";

export function ComputerPreview({ topicId, connected, onStop }: {
  topicId: string;
  connected: boolean;
  onStop: (ticketId: string) => Promise<unknown>;
}) {
  const preview = useComputerPreview(topicId, connected);
  return <ComputerPreviewPanel {...preview} connected={connected} onStop={onStop} />;
}

export function ComputerPreviewPanel({ state, client, connected, onStop }: {
  state: ComputerPreviewState;
  client: Pick<ComputerPreviewClient, "setCollapsed" | "setExpanded" | "select" | "stopTask" | "retry" | "frameFailed">;
  connected: boolean;
  onStop: (ticketId: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const bodyId = useId();
  const selected = state.sessions.find((item) => item.id === state.selectedId);
  if (!selected) return null;
  const display = state.displays[selected.id];
  const stop = state.stops[selected.ticketId];
  const reconnecting = state.connection !== "connected";
  const stopped = Boolean(stop?.pending || stop?.accepted);
  const previewError = state.error === "invalid_preview" ? t("预览数据无效", "Invalid preview data") : state.error;
  const frameError = display?.message === "invalid_frame" ? t("画面无法显示", "The frame could not be displayed") : display?.message;
  const status = reconnecting ? t("重连中", "Reconnecting") : display?.state === "closed" ? t("操作已结束", "Operation ended") : display?.state === "unavailable" ? t("预览不可用", "Preview unavailable")
    : selected.tool === "browser" ? t("实时画面", "Live view") : t("操作截图", "Action snapshot");

  return <div className="kulo-computer-preview-dock" data-expanded={state.expanded} data-collapsed={state.collapsed}>
    <section className="kulo-computer-preview" aria-label={t("设备操作预览", "Device operation preview")}>
      <div className="kulo-computer-preview-header">
        <KuloIcon name={selected.tool === "browser" ? "video" : "image"} size={16} />
        <div className="kulo-computer-preview-identity">
          <strong className="kulo-item-title" title={selected.app ?? selected.title}>{selected.app ?? selected.title}</strong>
          <span className="text-xs text-muted" title={selected.deviceName}>{selected.deviceName} · {status}</span>
        </div>
        {!state.collapsed && <Button size="sm" variant="ghost" className="kulo-computer-preview-resize" aria-pressed={state.expanded}
          aria-label={state.expanded ? t("还原预览大小", "Restore preview size") : t("放大操作预览", "Enlarge operation preview")}
          onPress={() => client.setExpanded(!state.expanded)}>{state.expanded ? t("还原", "Restore") : t("放大", "Enlarge")}</Button>}
        <Button isIconOnly size="sm" variant="ghost" aria-controls={bodyId} aria-expanded={!state.collapsed}
          aria-label={state.collapsed ? t("展开操作预览", "Expand operation preview") : t("收起操作预览", "Collapse operation preview")}
          onPress={() => client.setCollapsed(!state.collapsed)}><KuloIcon name={state.collapsed ? "chevron-down" : "minimize"} size={16} /></Button>
        <Button size="sm" variant="danger-soft" isDisabled={!connected || stopped} isPending={Boolean(stop?.pending)}
          aria-label={t(`停止任务：${selected.title}`, `Stop task: ${selected.title}`)}
          onPress={() => { void client.stopTask(onStop); }}>
          <KuloIcon name="stop" size={14} />{stopped ? t("停止中", "Stopping") : t("停止", "Stop")}
        </Button>
      </div>
      <div id={bodyId} hidden={state.collapsed}>
        {state.sessions.length > 1 && <div className="kulo-computer-preview-sessions scrollbar" aria-label={t("操作会话", "Operation sessions")}>
          {state.sessions.map((item) => <Button key={item.id} size="sm" variant={item.id === selected.id ? "secondary" : "ghost"}
            className="shrink-0" aria-pressed={item.id === selected.id} aria-label={t(`查看操作：${item.app ?? item.title} · ${item.deviceName}`, `View operation: ${item.app ?? item.title} · ${item.deviceName}`)}
            onPress={() => client.select(item.id)}>{item.app ?? item.title}</Button>)}
        </div>}
        <div className="kulo-computer-preview-viewport">
          {display?.imageUrl && !reconnecting ? <img className="kulo-computer-preview-image" src={display.imageUrl} onError={() => client.frameFailed(selected.id, display.imageUrl!)}
            alt={selected.tool === "browser" ? t("浏览器操作画面", "Browser operation view") : t("应用窗口截图", "Application window snapshot")} />
            : <div className="kulo-computer-preview-placeholder text-xs text-muted">
              {(display?.state === "unavailable" || display?.state === "closed") && !reconnecting ? <><KuloIcon name="image" size={20} /><span>{display.state === "closed" ? t("操作已结束", "Operation ended") : frameError || t("无法获取窗口画面", "The window view is unavailable")}</span></>
                : <><Spinner size="sm" className="motion-reduce:animate-none" /><span>{reconnecting ? t("正在连接预览", "Connecting preview") : t("等待画面", "Waiting for a frame")}</span></>}
            </div>}
        </div>
        {(previewError || reconnecting || display?.state === "unavailable" || selected.tool === "desktop" && !display?.imageUrl && display?.state !== "closed") && <div className="kulo-computer-preview-feedback">
          {previewError && <span className="text-xs text-danger" role="alert">{previewError}</span>}
          {selected.tool === "desktop" && display?.state !== "closed" && <Button size="sm" variant="secondary" aria-label={t(`检查${selected.deviceName}的系统权限`, `Check system permissions on ${selected.deviceName}`)} onPress={() => requestSystemPermissionHelp({ kind: display?.permissionRequired ?? "accessibility", envId: selected.envId })}>{t("检查权限", "Check permissions")}</Button>}
          <Button size="sm" variant="ghost" onPress={() => client.retry()}>{t("重新连接", "Reconnect")}</Button>
        </div>}
      </div>
      {stop?.error && <div className="kulo-computer-preview-feedback" role="alert">
        <span className="text-xs text-danger">{stop.error === "stop_failed" ? t("停止失败，请重试", "Could not stop the task. Try again") : stop.error}</span>
        <Button size="sm" variant="secondary" isDisabled={!connected} onPress={() => { void client.stopTask(onStop); }}>{t("重试停止", "Retry stop")}</Button>
      </div>}
    </section>
  </div>;
}
