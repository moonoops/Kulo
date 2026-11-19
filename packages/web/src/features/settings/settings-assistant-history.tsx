import { useRef, useState } from "react";
import { Button, Popover, Table } from "@heroui/react";
import type { SettingsAssistantConversation, SettingsAssistantSnapshot } from "@moco/protocol";
import { translate as t, useI18n } from "../../moco-i18n";
import { MocoIcon } from "../../moco-icon";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { settingsModuleTitle } from "./settings-helpers";

export function SettingsAssistantHistory({ snapshot, loaded, disabled, error, onSelect, onDelete }: {
  snapshot: SettingsAssistantSnapshot;
  loaded: boolean;
  disabled: boolean;
  error: string | null;
  onSelect: (topicId: string) => Promise<boolean>;
  onDelete: (topicId: string) => Promise<boolean>;
}) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [remove, setRemove] = useState<SettingsAssistantConversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreDeleteFocus = useRef<string | null | undefined>(undefined);
  const formatDate = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const select = async (topicId: string) => {
    if (topicId === snapshot.topicId || await onSelect(topicId)) setOpen(false);
  };
  const deleteSelected = async () => {
    if (!remove || deleting || disabled) return;
    const index = snapshot.conversations.findIndex((conversation) => conversation.topicId === remove.topicId);
    const next = snapshot.conversations[index + 1] ?? snapshot.conversations[index - 1];
    setDeleting(true);
    try {
      if (await onDelete(remove.topicId)) {
        restoreDeleteFocus.current = next?.topicId ?? null;
        setRemove(null);
      }
    } finally { setDeleting(false); }
  };
  return <><Popover isOpen={open} onOpenChange={(next) => { if (!remove) setOpen(next); }}>
    <Button size="sm" variant="ghost" isIconOnly aria-label={t("设置对话历史", "Settings conversation history")} isDisabled={!loaded}>
      <span title={t("历史会话", "Conversation history")}><MocoIcon name="history" size={18} /></span>
    </Button>
    <Popover.Content placement="top end" className="w-96 max-w-[calc(100vw-2rem)]">
      <Popover.Dialog ref={dialogRef} aria-label={t("设置对话历史", "Settings conversation history")}>
        <Popover.Heading className="mb-2">{t("历史会话", "Conversation history")}</Popover.Heading>
        {error && !remove && <p role="alert" className="mb-2 break-words text-xs text-danger">{error}</p>}
        <Table onKeyDownCapture={(event) => { if (event.key === "Escape" && !remove) { event.stopPropagation(); setOpen(false); } }}>
          <Table.ScrollContainer className="scrollbar max-h-80 overflow-y-auto">
            <Table.Content aria-label={t("设置历史会话", "Past settings conversations")} selectionMode="none" keyboardNavigationBehavior="arrow" escapeKeyBehavior="none" className="w-full table-fixed">
              <Table.Header>
                <Table.Column id="conversation" isRowHeader>{t("会话", "Conversation")}</Table.Column>
                <Table.Column id="actions" className="w-16">{t("操作", "Actions")}</Table.Column>
              </Table.Header>
              <Table.Body renderEmptyState={() => <p className="px-3 py-4 text-sm text-muted">{t("暂无历史会话", "No conversations yet")}</p>}>
                {snapshot.conversations.map((conversation) => {
                  const title = conversation.title || t("新对话", "New conversation");
                  const current = conversation.topicId === snapshot.topicId;
                  return <Table.Row key={conversation.topicId} id={conversation.topicId} isDisabled={disabled}
                    textValue={title} aria-label={t(`加载设置对话：${title}`, `Load settings conversation: ${title}`)} aria-current={current ? "true" : undefined}
                    onAction={() => void select(conversation.topicId)}>
                    <Table.Cell className="min-w-0">
                      <span className="block truncate text-sm" title={title}>{title}</span>
                      <p className="truncate text-xs text-muted">{[current ? t("当前", "Current") : "", conversation.updatedAt > 0 ? formatDate.format(conversation.updatedAt) : "", conversation.module ? settingsModuleTitle(conversation.module) : ""].filter(Boolean).join(" · ")}</p>
                    </Table.Cell>
                    <Table.Cell>
                      <Button size="sm" variant="ghost" isIconOnly isDisabled={disabled} aria-label={t(`删除设置对话：${title}`, `Delete settings conversation: ${title}`)}
                        ref={(button) => { if (button) deleteButtons.current.set(conversation.topicId, button); else deleteButtons.current.delete(conversation.topicId); }}
                        onPress={() => setRemove(conversation)}>
                        <span title={t("删除会话", "Delete conversation")}><MocoIcon name="delete" size={16} /></span>
                      </Button>
                    </Table.Cell>
                  </Table.Row>;
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>
    <ConfirmDialog open={remove !== null} title={t(`删除「${remove?.title || t("新对话", "New conversation")}」？`, `Delete “${remove?.title || "New conversation"}”?`)}
      description={<div className="space-y-2"><p>{t("这段会话将从历史列表移除。已应用的设置和后台任务会保留。", "This conversation will be removed from history. Applied settings and background tasks are kept.")}</p>{error && <p role="alert" className="break-words text-danger">{error}</p>}</div>}
      confirmLabel={t("删除", "Delete")} isPending={deleting} isConfirmDisabled={disabled}
      onCancel={() => { restoreDeleteFocus.current = remove?.topicId; setRemove(null); }} onConfirm={() => void deleteSelected()}
      onCloseComplete={() => {
        const topicId = restoreDeleteFocus.current;
        restoreDeleteFocus.current = undefined;
        if (topicId === undefined) return;
        // Let the overlay finish restoring focus before choosing a surviving row.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const target = topicId ? deleteButtons.current.get(topicId) : undefined;
          if (target && !target.disabled) target.focus(); else dialogRef.current?.focus();
        }));
      }} />
  </>;
}
