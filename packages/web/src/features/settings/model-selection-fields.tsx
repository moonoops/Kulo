import { useI18n } from "../../moco-i18n";
import { ComboBox, Input, Label, ListBox, Select } from "@heroui/react";
import type { ThinkingEffort } from "@moco/protocol";
import { modelEffortOptions, type ProviderModelGroup } from "./settings-helpers";

const UNSELECTED = "__unselected__";

export function ModelSelectionFields({
  groups, providerId, modelId, thinkingLevel, onProviderChange, onModelChange,
  onThinkingChange, isDisabled = false, isLoading = false,
  defaults = false, layout = "form",
}: {
  groups: ProviderModelGroup[];
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingEffort;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  onThinkingChange: (effort: ThinkingEffort) => void;
  isDisabled?: boolean;
  isLoading?: boolean;
  defaults?: boolean;
  layout?: "settings" | "form" | "compact";
}) {
  const { t } = useI18n();
  const group = groups.find((item) => item.providerId === providerId);
  const models = group?.models ?? [];
  const model = models.find((item) => item.id === modelId);
  const efforts = modelEffortOptions(model);
  const prefix = defaults ? t("默认", "Default ") : "";
  const unavailableProvider = providerId === "moco-gateway" ? t("兼容网关", "Compatible gateway") : providerId;
  const fieldClass = layout === "settings" ? "moco-settings-row" : layout === "compact" ? "moco-compact-row" : "moco-form-field";
  const effortFieldClass = layout === "settings" ? "moco-settings-row moco-settings-row--choice"
    : layout === "compact" ? "moco-compact-row moco-compact-row--choice" : "moco-form-field";

  return <>
    <Select
      aria-label={t(`${prefix}供应商`, `${prefix}provider`)} placeholder={isLoading ? t("加载中…", "Loading…") : t("未选择", "Not selected")}
      value={group ? providerId : null} variant="secondary" fullWidth
      className={fieldClass} isDisabled={isDisabled || isLoading}
      onChange={(key) => {
        const next = key === UNSELECTED || key === null ? "" : String(key);
        if (next !== providerId) onProviderChange(next);
      }}
    >
      <Label className="text-sm font-normal text-foreground">{t("供应商", "Provider")}</Label>
      <Select.Trigger>
        <Select.Value className="truncate">{!group && providerId ? unavailableProvider : undefined}</Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="motion-reduce:animate-none">
        <ListBox>
          <ListBox.Item id={UNSELECTED} textValue={t("未选择", "Not selected")}>{t("未选择", "Not selected")}<ListBox.ItemIndicator /></ListBox.Item>
          {groups.map((item) => <ListBox.Item key={item.providerId} id={item.providerId} textValue={item.label}>
            {item.label}<ListBox.ItemIndicator />
          </ListBox.Item>)}
        </ListBox>
      </Select.Popover>
    </Select>
    <ComboBox
      key={providerId} aria-label={t(`${prefix}模型`, `${prefix}model`)} selectedKey={model?.id ?? null}
      variant="secondary" fullWidth menuTrigger="focus" className={fieldClass}
      isDisabled={isDisabled || !group || models.length === 0}
      onSelectionChange={(key) => {
        if (key !== null && String(key) !== modelId && models.some((item) => item.id === key)) onModelChange(String(key));
      }}
    >
      <Label className="text-sm font-normal text-foreground">{t("模型", "Model")}</Label>
      <ComboBox.InputGroup>
        <Input title={modelId || undefined} placeholder={modelId && !model ? t(`${modelId}（未添加）`, `${modelId} (not added)`) : group && models.length === 0 ? t("暂无已添加模型", "No models added") : t("未选择", "Not selected")} />
        <ComboBox.Trigger aria-label={t(`展开${prefix}模型列表`, `Open ${prefix}model list`)} />
      </ComboBox.InputGroup>
      <ComboBox.Popover className="motion-reduce:animate-none">
        <ListBox renderEmptyState={() => <span className="p-3 text-sm text-muted">{t("无匹配模型", "No matching models")}</span>}>
          {models.map((item) => <ListBox.Item key={item.id} id={item.id} textValue={item.id}>
            <span className="min-w-0 whitespace-normal break-all">{item.id}</span><ListBox.ItemIndicator />
          </ListBox.Item>)}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
    <Select
      aria-label={t(`${prefix}思考强度`, `${prefix}thinking effort`)} placeholder={t("未选择", "Not selected")} variant="secondary" fullWidth
      value={group && model && efforts.some((item) => item.value === thinkingLevel) ? thinkingLevel : null}
      className={effortFieldClass} isDisabled={isDisabled || !group || !model || efforts.length <= 1}
      onChange={(key) => {
        if (key !== null && key !== thinkingLevel) onThinkingChange(String(key));
      }}
    >
      <Label className="text-sm font-normal text-foreground">{t("思考强度", "Thinking effort")}</Label>
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover className="motion-reduce:animate-none">
        <ListBox>{efforts.map((item) => <ListBox.Item key={item.value} id={item.value} textValue={item.label}>
          {item.label}<ListBox.ItemIndicator />
        </ListBox.Item>)}</ListBox>
      </Select.Popover>
    </Select>
  </>;
}
