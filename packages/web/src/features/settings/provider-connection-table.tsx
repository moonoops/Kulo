import { useI18n } from "../../kulo-i18n";
import { Button, Chip, Spinner, Table } from "@heroui/react";

export interface ProviderConnectionItem {
  id: string;
  name: string;
  protocol: string;
  modelCount: number;
  authenticated: boolean | null;
  action: "编辑" | "刷新";
  disabled: boolean;
  pending?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export function ProviderConnectionTable({ label, emptyLabel, items, loading = false }: {
  label: string;
  emptyLabel: string;
  items: ProviderConnectionItem[];
  loading?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Table variant="secondary" className="kulo-settings-table" aria-busy={loading}>
      <Table.ScrollContainer className="kulo-settings-table-scroll">
        <Table.Content className="kulo-settings-table-content" aria-label={label}
          selectionMode="none" keyboardNavigationBehavior="tab">
          <Table.Header>
            <Table.Column id="name" isRowHeader className="kulo-settings-table-column">{t("连接", "Connection")}</Table.Column>
            <Table.Column id="models" className="kulo-settings-table-column kulo-settings-table-meta">{t("模型数量", "Models")}</Table.Column>
            <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-meta">{t("状态", "Status")}</Table.Column>
            <Table.Column id="actions" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column>
          </Table.Header>
          <Table.Body items={items} renderEmptyState={() => (
            <div className="kulo-table-empty-state" role="status">
              {loading ? <Spinner size="sm" aria-label={t("加载模型连接", "Loading model connections")} /> : emptyLabel}
            </div>
          )}>
            {(item) => (
              <Table.Row id={item.id} textValue={item.name}>
                <Table.Cell className="kulo-settings-table-cell">
                  <strong className="kulo-item-title block">{item.name}</strong>
                  <span className="kulo-item-description mt-0.5 block">{item.protocol}</span>
                </Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta tabular-nums">{t(`${item.modelCount} 个模型`, `${item.modelCount} ${item.modelCount === 1 ? "model" : "models"}`)}</Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">
                  {item.authenticated === null ? <span aria-label={t("认证状态尚未读取", "Authentication status unavailable")}>—</span> :
                    <Chip size="sm" variant="soft" color={item.authenticated ? "success" : "default"}>{item.authenticated ? t("已认证", "Authenticated") : t("未认证", "Not authenticated")}</Chip>}
                </Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-actions">
                  <div className="kulo-settings-table-action-group">
                    <Button size="sm" variant="ghost" aria-label={t(`${item.action}${item.name}`, `${item.action === "编辑" ? "Edit" : "Refresh"} ${item.name}`)}
                      isDisabled={loading || item.disabled} isPending={item.pending} onPress={item.onEdit}>
                      {item.action === "编辑" ? t("编辑", "Edit") : t("刷新", "Refresh")}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={t(`删除${item.name}`, `Delete ${item.name}`)} isDisabled={loading || item.disabled} onPress={item.onDelete}>{t("删除", "Delete")}</Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
