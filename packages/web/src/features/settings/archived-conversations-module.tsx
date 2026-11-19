import { useEffect, useRef, useState } from "react";
import { Alert, Button, Spinner, Table, toast } from "@heroui/react";
import { redactSensitiveText, type ProjectView, type TopicSummary } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { useI18n } from "../../moco-i18n";

export function ArchivedConversationsModule({ topics, projects, loaded, connected, loadError, onRefresh, onRestored }: {
  topics: readonly TopicSummary[];
  projects: readonly Pick<ProjectView, "id" | "name">[];
  loaded: boolean;
  connected: boolean;
  loadError?: string | null;
  onRefresh?: () => Promise<void> | void;
  onRestored?: (topic: TopicSummary) => void;
}) {
  const { t } = useI18n();
  const archived = topics.filter((topic) => topic.archived && !topic.deletedAt && !topic.master && topic.id !== "root")
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const flight = useRef(false);
  const refreshFlight = useRef(false);
  const listRef = useRef<HTMLElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const retryLoad = async () => {
    if (!connected || !onRefresh || refreshFlight.current) return;
    refreshFlight.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      refreshFlight.current = false;
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!connected || loaded || loadError || !onRefresh) return;
    const timer = setTimeout(() => { void retryLoad(); }, 800);
    return () => clearTimeout(timer);
  }, [connected, loaded, loadError, onRefresh]);

  const restore = async (topic: TopicSummary) => {
    if (!connected || flight.current) return;
    flight.current = true;
    setPendingId(topic.id);
    setError(null);
    const nextId = archived.find((item) => item.id !== topic.id)?.id;
    let focusId: string | undefined = topic.id;
    try {
      const restored = await mocoRest.patchTopic(topic.id, { archived: false });
      onRestored?.(restored);
      focusId = nextId;
      toast.success(t("会话已还原", "Conversation restored"));
    } catch (cause) {
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("还原失败，请重试。", "Could not restore the conversation. Try again.")));
    } finally {
      flight.current = false;
      setPendingId(null);
      requestAnimationFrame(() => {
        if (!listRef.current || document.activeElement !== document.body && !listRef.current.contains(document.activeElement)) return;
        const button = focusId ? buttons.current.get(focusId) : undefined;
        if (button && !button.disabled) button.focus(); else listRef.current.focus();
      });
    }
  };

  return <section ref={listRef} tabIndex={-1} className="flex min-w-0 flex-col gap-4" aria-label={t("已归档会话", "Archived conversations")}>
    {!connected && <Alert status="warning"><Alert.Content>{t("与中枢连接已断开", "Disconnected from the hub")}</Alert.Content></Alert>}
    {!loaded && loadError && <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Description>{redactSensitiveText(loadError)}</Alert.Description></Alert.Content>{onRefresh && <Button type="button" size="sm" variant="secondary" isDisabled={!connected || refreshing} isPending={refreshing} onPress={() => void retryLoad()}>{t("重试", "Retry")}</Button>}</Alert>}
    {!loaded && connected && !loadError && <div role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner size="sm" />{t("加载中…", "Loading…")}</div>}
    {error && <Alert status="danger"><Alert.Indicator /><Alert.Content>{error}</Alert.Content></Alert>}
    {loaded && <Table variant="secondary" className="moco-settings-table">
      <Table.ScrollContainer className="moco-settings-table-scroll">
        <Table.Content aria-label={t("已归档会话列表", "Archived conversation list")} selectionMode="none" keyboardNavigationBehavior="tab" className="min-w-[480px]">
          <Table.Header>
            <Table.Column id="title" isRowHeader className="moco-settings-table-column">{t("标题", "Title")}</Table.Column>
            <Table.Column id="scope" className="moco-settings-table-column moco-settings-table-meta">{t("所属", "Location")}</Table.Column>
            <Table.Column id="actions" className="moco-settings-table-column moco-settings-table-actions">{t("操作", "Actions")}</Table.Column>
          </Table.Header>
          <Table.Body renderEmptyState={() => <div className="moco-table-empty-state">{t("暂无已归档会话", "No archived conversations")}</div>}>
            {archived.map((topic) => <Table.Row key={topic.id} id={topic.id}>
              <Table.Cell className="moco-settings-table-cell"><span className="moco-item-title break-words">{topic.title}</span></Table.Cell>
              <Table.Cell className="moco-settings-table-cell">{topic.projectId ? projectNames.get(topic.projectId) ?? t("项目话题", "Project topic") : t("话题", "Topic")}</Table.Cell>
              <Table.Cell className="moco-settings-table-cell moco-settings-table-actions">
                <Button type="button" size="sm" variant="secondary" isDisabled={!connected || pendingId !== null && pendingId !== topic.id} isPending={pendingId === topic.id}
                  ref={(button) => { if (button) buttons.current.set(topic.id, button); else buttons.current.delete(topic.id); }}
                  aria-label={t(`还原“${topic.title}”`, `Restore “${topic.title}”`)} onPress={() => void restore(topic)}>
                  {t("还原", "Restore")}
                </Button>
              </Table.Cell>
            </Table.Row>)}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>}
  </section>;
}
