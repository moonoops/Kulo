import { useI18n } from "../../kulo-i18n";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button, Dropdown, Input, Label, Separator, Tooltip } from "@heroui/react";
import type { TopicSummary } from "@kulo/protocol";
import { KuloIcon } from "../../kulo-icon";
import { KuloThinkingIndicator } from "../chat/thinking-indicator";

export interface TopicRowActivity {
  running: boolean;
  queued: boolean;
  unread: boolean;
}

export function TopicRow({
  topic,
  selected,
  attentionCount,
  failureCount = 0,
  onSelect,
  onPatch,
  onRequestDelete,
  layout = "topic",
  activity,
}: {
  topic: TopicSummary;
  selected: boolean;
  attentionCount: number;
  failureCount?: number;
  onSelect: () => void;
  onPatch: (patch: { title?: string; pinned?: boolean; archived?: boolean }) => void;
  onRequestDelete: () => void;
  layout?: "topic" | "project";
  activity?: TopicRowActivity;
}) {
  const { t } = useI18n();
  const statusId = useId();
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameText, setRenameText] = useState(topic.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<HTMLButtonElement>(null);
  const restoreSelectionFocus = useRef(false);

  const title = topic.title || t("新对话", "New conversation");
  const pinLabel = topic.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin");
  const archiveLabel = topic.archived ? t("恢复话题", "Restore topic") : t("归档", "Archive");

  useLayoutEffect(() => {
    if (renaming) {
      setRenameText(topic.title);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, topic.title]);

  useLayoutEffect(() => {
    if (renaming || !restoreSelectionFocus.current) return;
    restoreSelectionFocus.current = false;
    const frame = requestAnimationFrame(() => selectionRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [renaming]);

  const finishRename = (commit: boolean, returnFocus = false) => {
    const val = renameText.trim();
    if (returnFocus) restoreSelectionFocus.current = true;
    setRenaming(false);
    if (commit && val && val !== topic.title) {
      onPatch({ title: val });
    }
  };

  const renameField = <Input
          variant="primary"
          ref={inputRef}
          aria-label={layout === "project" ? t("重命名会话", "Rename conversation") : t("重命名话题", "Rename topic")}
          value={renameText}
          maxLength={120}
          className="kulo-topic-rename min-w-0 flex-1"
          onChange={(e) => setRenameText(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => finishRename(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              finishRename(true, true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              finishRename(false, true);
            }
          }}
        />;
  const actionBar = (
    <div className="kulo-topic-action-bar">
      <Tooltip delay={350} closeDelay={0} isDisabled={menuOpen}>
        <Button
          type="button"
          isIconOnly
          size="sm"
          variant="ghost"
          className="kulo-topic-action kulo-topic-quick-action"
          aria-label={topic.pinned ? t(`取消置顶：${title}`, `Unpin: ${title}`) : t(`置顶：${title}`, `Pin: ${title}`)}
          aria-pressed={Boolean(topic.pinned)}
          onPress={() => onPatch({ pinned: !topic.pinned })}
        >
          <KuloIcon name="pin" size={16} />
        </Button>
        <Tooltip.Content placement="top">{pinLabel}</Tooltip.Content>
      </Tooltip>
      {!topic.master && (
        <Tooltip delay={350} closeDelay={0} isDisabled={menuOpen}>
          <Button
            type="button"
            isIconOnly
            size="sm"
            variant="ghost"
            className="kulo-topic-action kulo-topic-quick-action"
            aria-label={topic.archived ? t(`恢复话题：${title}`, `Restore topic: ${title}`) : t(`归档：${title}`, `Archive: ${title}`)}
            onPress={() => onPatch({ archived: !topic.archived })}
          >
            <KuloIcon name={topic.archived ? "unarchive" : "archive"} size={16} />
          </Button>
          <Tooltip.Content placement="top">{archiveLabel}</Tooltip.Content>
        </Tooltip>
      )}
      <Dropdown isOpen={menuOpen} onOpenChange={setMenuOpen}>
        <Button
          type="button"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t(`${topic.title || "话题"}操作`, `${topic.title || "Topic"} actions`)}
          className="kulo-topic-action kulo-topic-actions"
        >
          <KuloIcon name="more" size={16} />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            className="kulo-navigation-menu"
            aria-label={t(`${topic.title || "话题"}操作`, `${topic.title || "Topic"} actions`)}
            onAction={(key) => {
              if (key === "rename") {
                setRenaming(true);
              } else if (key === "pin") {
                onPatch({ pinned: !topic.pinned });
              } else if (key === "archive") {
                onPatch({ archived: !topic.archived });
              } else if (key === "delete") {
                onRequestDelete();
              }
            }}
          >
            <Dropdown.Item id="rename" textValue={t("重命名", "Rename")} className="kulo-navigation-menu-item">
              <KuloIcon name="edit" size={16} />
              <Label className="kulo-navigation-menu-label">{t("重命名", "Rename")}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="pin" textValue={pinLabel} className="kulo-navigation-menu-item">
              <KuloIcon name="pin" size={16} />
              <Label className="kulo-navigation-menu-label">{pinLabel}</Label>
            </Dropdown.Item>
            {!topic.master && (
              <>
                <Dropdown.Item
                  className="kulo-navigation-menu-item"
                  id="archive"
                  textValue={archiveLabel}
                >
                  <KuloIcon name={topic.archived ? "unarchive" : "archive"} size={16} />
                  <Label className="kulo-navigation-menu-label">{archiveLabel}</Label>
                </Dropdown.Item>
                <Separator />
                <Dropdown.Item id="delete" textValue={t("删除", "Delete")} className="kulo-navigation-menu-item">
                  <KuloIcon name="delete" size={16} />
                  <Label className="kulo-navigation-menu-label">{t("删除", "Delete")}</Label>
                </Dropdown.Item>
              </>
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );

  const status = [
    activity?.running ? t("正在处理", "Processing") : activity?.queued ? t("排队中", "Queued") : undefined,
    failureCount > 0 ? t(`${failureCount} 项执行失败`, `${failureCount} failed`) : undefined,
    activity?.unread ? t("有新进度", "New progress") : undefined,
    attentionCount > 0 ? t(`${attentionCount} 项待处理`, `${attentionCount} need attention`) : undefined,
  ].filter(Boolean).join("，");
  const notice = failureCount > 0 ? "failed" : attentionCount > 0 ? "attention" : activity?.unread ? "unread" : undefined;

  return (
    <div data-topic-layout={layout} data-topic-id={topic.id}
      data-selected={selected || undefined}
      data-renaming={renaming || undefined}
      data-menu-open={menuOpen || undefined}
      data-pinned={topic.pinned || undefined}
      data-action-count={topic.master ? 2 : 3}
      className="kulo-navigation-row kulo-topic-row"
      onDoubleClick={(event) => {
        if (renaming) return;
        if (event.target instanceof Element && event.target.closest(".kulo-topic-action-bar")) return;
        setRenaming(true);
      }}
      onContextMenu={(event) => {
        if (renaming) return;
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {renaming ? <div className="flex min-w-0 flex-1 items-center px-1">{renameField}</div> : (
        <Button
          ref={selectionRef}
          variant="ghost"
          className="kulo-topic-select"
          aria-label={title}
          aria-describedby={status ? statusId : undefined}
          aria-current={selected ? "page" : undefined}
          onPress={onSelect}
        >
          <span className="kulo-topic-label">
            <span className="min-w-0 truncate" title={title}>
              {title}
            </span>
            {topic.pinned && <KuloIcon name="pin" size={12} className="kulo-topic-pinned shrink-0 text-muted" />}
          </span>
          <span id={status ? statusId : undefined} role={status ? "img" : undefined} aria-label={status || undefined} title={status || undefined}
            aria-hidden={status ? undefined : true} className="kulo-topic-state">
            <span className="kulo-topic-state-slot" data-state-slot="execution" aria-hidden="true">
              {activity?.running ? <KuloThinkingIndicator size="compact" decorative />
                : activity?.queued ? <KuloIcon name="schedule" size={12} /> : null}
            </span>
            <span className="kulo-topic-state-slot" data-state-slot="notice" data-notice={notice} aria-hidden="true">
              {notice === "failed" ? <KuloIcon name="error" size={12} className="kulo-topic-failure" />
                : notice === "attention" ? <span className="kulo-topic-attention">{attentionCount > 9 ? "9+" : attentionCount}</span>
                  : notice === "unread" ? <span className="kulo-topic-unread" /> : null}
            </span>
          </span>
        </Button>
      )}
      {!renaming && actionBar}
    </div>
  );
}

