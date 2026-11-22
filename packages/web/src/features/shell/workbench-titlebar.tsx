import { Button, Chip, Dropdown, Label, Spinner } from "@heroui/react";
import type {
  ComputerPreviewSessionView,
  EnvNodeDescriptor,
  KuloLanguage,
  LiveContextState,
  TicketCardView,
  TopicSummary,
} from "@kulo/protocol";
import { KuloIcon } from "../../kulo-icon";
import { translate as t } from "../../kulo-i18n";
import type { SettingsModuleId } from "../../kulo-settings";
import { TaskStatus } from "../../kulo-tasks";
import {
  ConversationFilesButton,
  type ConversationDestination,
} from "../chat/conversation-library";
import { ChatTargetDeviceMenu } from "../chat/target-device-menu";
import { settingsModuleTitle } from "../settings/settings-helpers";
import { TopicContextMenu } from "./topic-context-menu";

export interface WorkbenchTitlebarProps {
  settingsMode: boolean;
  settingsModule: SettingsModuleId;
  language: KuloLanguage;
  projectedTicketId?: string;
  projectedCard?: TicketCardView;
  projectedTitle: string;
  onCloseProjection: () => void;
  activeTopicId: string;
  activeTopicTitle: string;
  activeTopic?: TopicSummary;
  locatingMessage: boolean;
  envs: EnvNodeDescriptor[];
  selectedTargetDeviceId: string;
  connected: boolean;
  liveBusy: boolean;
  liveContext?: LiveContextState;
  onSelectTargetDevice: (deviceId: string) => void;
  onOpenConversationSearch: () => void;
  deliveryScope?: string;
  filesRevision: string;
  isLocalTopic: boolean;
  onNavigateConversation: (destination: ConversationDestination) => void;
  onPatchTopic: (
    topicId: string,
    patch: { pinned?: boolean; archived?: boolean },
  ) => Promise<void> | void;
  activeTopicTaskCount: number;
  rightExpanded: boolean;
  onToggleRightPanel: () => void;
  previewSessions: ComputerPreviewSessionView[];
  selectedPreviewId?: string;
  onOpenPreviewModal: (sessionId: string) => void;
}

export function WorkbenchTitlebar({
  settingsMode,
  settingsModule,
  language,
  projectedTicketId,
  projectedCard,
  projectedTitle,
  onCloseProjection,
  activeTopicId,
  activeTopicTitle,
  activeTopic,
  locatingMessage,
  envs,
  selectedTargetDeviceId,
  connected,
  liveBusy,
  liveContext,
  onSelectTargetDevice,
  onOpenConversationSearch,
  deliveryScope,
  filesRevision,
  isLocalTopic,
  onNavigateConversation,
  onPatchTopic,
  activeTopicTaskCount,
  rightExpanded,
  onToggleRightPanel,
  previewSessions,
  selectedPreviewId,
  onOpenPreviewModal,
}: WorkbenchTitlebarProps) {
  return (
    <div className="kulo-workbench-header">
      {projectedTicketId && !settingsMode && (
        <Button
          size="sm"
          isIconOnly
          variant="ghost"
          className="kulo-window-control"
          aria-label={t("返回对话", "Back to chat")}
          onPress={onCloseProjection}
        >
          <KuloIcon name="arrow-left" size={20} />
        </Button>
      )}

      <div
        className={
          "min-w-0 flex-1" +
          (projectedTicketId && !settingsMode ? " kulo-task-heading" : "")
        }
      >
        <h1 className="kulo-page-title">
          {settingsMode
            ? settingsModuleTitle(settingsModule, language)
            : projectedTicketId
              ? projectedCard?.title || projectedTitle || t("任务详情", "Task details")
              : activeTopicTitle}
        </h1>
        {projectedTicketId && projectedCard && !settingsMode && (
          <TaskStatus
            status={projectedCard.status}
            waiting={projectedCard.waiting}
            cleanupPending={projectedCard.cleanupPending}
            recovery={projectedCard.recovery}
            externalAgentKind={projectedCard.externalAgentKind}
            pendingWorkspaceApply={projectedCard.pendingWorkspaceApply}
          />
        )}
      </div>

      {!settingsMode && !projectedTicketId && (
        <>
          {locatingMessage && (
            <Spinner size="sm" aria-label={t("正在定位消息", "Locating message")} />
          )}
          {!activeTopic?.projectId && (
            <ChatTargetDeviceMenu
              envs={envs}
              selectedDeviceId={selectedTargetDeviceId}
              connected={connected}
              disabled={!connected || liveBusy}
              onSelect={onSelectTargetDevice}
            />
          )}
          <Button
            size="sm"
            isIconOnly
            variant="ghost"
            className="kulo-window-control"
            aria-label={t("搜索对话正文", "Search conversation messages")}
            onPress={onOpenConversationSearch}
          >
            <KuloIcon name="search" size={18} />
          </Button>
          <ConversationFilesButton
            topicId={activeTopicId}
            scopeKey={deliveryScope}
            revision={filesRevision}
            isLocal={isLocalTopic}
            onNavigate={onNavigateConversation}
          />
          <TopicContextMenu
            topicId={activeTopicId}
            isLocalTopic={isLocalTopic}
            connected={connected}
            liveBusy={liveBusy}
            context={liveContext}
          />
        </>
      )}

      {!settingsMode && !projectedTicketId && activeTopic && !activeTopic.master && (
        <Dropdown>
          <Button
            size="sm"
            isIconOnly
            variant="ghost"
            className="kulo-window-control"
            aria-label={t("话题操作", "Topic actions")}
          >
            <KuloIcon name="more-vert" size={20} />
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label={t("话题操作", "Topic actions")}
              onAction={(key) => {
                if (key === "pin") {
                  void onPatchTopic(activeTopic.id, {
                    pinned: !activeTopic.pinned,
                  });
                } else if (key === "archive") {
                  void onPatchTopic(activeTopic.id, {
                    archived: !activeTopic.archived,
                  });
                }
              }}
            >
              <Dropdown.Item
                id="pin"
                textValue={
                  activeTopic.pinned
                    ? t("取消置顶", "Unpin")
                    : t("置顶话题", "Pin topic")
                }
              >
                <KuloIcon name="pin" size={16} />
                <Label>
                  {activeTopic.pinned
                    ? t("取消置顶", "Unpin")
                    : t("置顶话题", "Pin topic")}
                </Label>
              </Dropdown.Item>
              {!activeTopic.master && (
                <Dropdown.Item
                  id="archive"
                  textValue={
                    activeTopic.archived
                      ? t("恢复话题", "Restore topic")
                      : t("归档话题", "Archive topic")
                  }
                >
                  <KuloIcon
                    name={activeTopic.archived ? "unarchive" : "archive"}
                    size={16}
                  />
                  <Label>
                    {activeTopic.archived
                      ? t("恢复话题", "Restore topic")
                      : t("归档话题", "Archive topic")}
                  </Label>
                </Dropdown.Item>
              )}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}

      {!settingsMode && !projectedTicketId && activeTopicTaskCount > 0 &&
        (rightExpanded ? (
          <Chip
            size="sm"
            variant="soft"
            color="accent"
            className="hidden sm:inline-flex"
          >
            {t(
              `${activeTopicTaskCount} 个任务`,
              `${activeTopicTaskCount} ${activeTopicTaskCount === 1 ? "task" : "tasks"}`,
            )}
          </Chip>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="kulo-window-control shrink-0"
            aria-label={t(
              `展开任务栏，当前话题有 ${activeTopicTaskCount} 个进行中任务`,
              `Open task panel, ${activeTopicTaskCount} active ${activeTopicTaskCount === 1 ? "task" : "tasks"} in this topic`,
            )}
            onPress={onToggleRightPanel}
          >
            {t(
              `${activeTopicTaskCount} 个任务`,
              `${activeTopicTaskCount} ${activeTopicTaskCount === 1 ? "task" : "tasks"}`,
            )}
          </Button>
        ))}

      {!settingsMode && !rightExpanded && previewSessions.length > 0 && (() => {
        const primary =
          previewSessions.find((item) => item.id === selectedPreviewId) ??
          previewSessions[0]!;
        const count = previewSessions.length;
        return (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="kulo-window-control kulo-preview-titlebar-trigger"
            aria-label={t(
              `查看实时画面：${primary.title}`,
              `View live preview: ${primary.title}`,
            )}
            onPress={() => onOpenPreviewModal(primary.id)}
          >
            <KuloIcon
              name={primary.tool === "browser" ? "video" : "image"}
              size={14}
            />
            <span className="hidden sm:inline">
              {count > 1
                ? t(`实时画面 (${count})`, `Live view (${count})`)
                : t("实时画面", "Live view")}
            </span>
          </Button>
        );
      })()}
    </div>
  );
}
