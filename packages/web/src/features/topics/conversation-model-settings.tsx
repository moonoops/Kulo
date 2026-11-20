import { useI18n } from "../../kulo-i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Label, ListBox, Popover, Select, Separator, Spinner, Switch } from "@heroui/react";
import type { HostActionPermission, KuloSettingsView } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { ModelSelectionFields } from "../settings/model-selection-fields";
import { useProviderCatalog } from "../settings/use-provider-catalog";
import { buildProviderModelGroups, clampModelEffort, selectedDefaultProvider } from "../settings/settings-helpers";

export function ConversationModelSettings({ settings, onSettingsUpdated, showProcess, onShowProcessChange }: {
  settings: KuloSettingsView | null;
  onSettingsUpdated: (settings: KuloSettingsView) => void;
  showProcess: boolean;
  onShowProcessChange: (show: boolean) => void;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const { providers, loading, error: catalogError, refresh } = useProviderCatalog(settings);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // Restore the scope after disabling a field without reopening the model's focus-triggered menu.
    if (!saving && open && document.activeElement === document.body) {
      dialogRef.current?.focus({ preventScroll: true });
    }
  }, [saving, open]);
  const loadError = catalogError ? catalogError instanceof Error ? catalogError.message : t("加载模型连接失败", "Failed to load model connections") : undefined;
  const block = settings?.blocks.model;
  const executorBlock = settings?.blocks.executor;
  const hostActionPermission: HostActionPermission = executorBlock?.value.hostActionPermission === "always" ? "always" : "ask";
  const groups = useMemo(() => block ? buildProviderModelGroups(block.value, providers) : [], [block, providers, language]);
  const provider = block ? selectedDefaultProvider(block.value) : "";

  const save = async (patch: Partial<KuloSettingsView["blocks"]["model"]["value"]>) => {
    if (!block || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await kuloRest.saveSettingsBlock("model", block.revision, { ...block.value, ...patch });
      onSettingsUpdated(result.settings);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("切换模型设置失败", "Failed to change model settings"));
    } finally { setSaving(false); }
  };

  const savePermission = async (next: HostActionPermission) => {
    if (!executorBlock || saving || next === hostActionPermission) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await kuloRest.saveSettingsBlock("executor", executorBlock.revision, {
        ...executorBlock.value,
        hostActionPermission: next,
      });
      onSettingsUpdated(result.settings);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("保存执行权限失败", "Failed to update execution permission"));
    } finally { setSaving(false); }
  };

  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button isIconOnly variant="ghost" aria-label={t("模型选择", "Model selection")}>
      <KuloIcon name="token" size={18} />
    </Button>
    <Popover.Content placement="top start" className="w-[360px] max-w-[calc(100vw-24px)] motion-reduce:animate-none">
      <Popover.Dialog ref={dialogRef} className="kulo-compact-fields outline-none">
        <div className="flex items-center justify-between gap-2">
          <Popover.Heading className="text-sm font-semibold text-foreground">{t("模型选择", "Model selection")}</Popover.Heading>
          {saving && <Spinner size="sm" aria-label={t("保存中", "Saving")} />}
        </div>
        <ModelSelectionFields
          layout="compact"
          groups={groups} providerId={provider} modelId={block?.value.defaultModel ?? ""}
          thinkingLevel={block?.value.thinkingLevel ?? "medium"}
          isDisabled={!block || saving} isLoading={loading}
          onProviderChange={(next) => {
            const firstModel = next ? groups.find((group) => group.providerId === next)?.models[0] : undefined;
            void save(
              firstModel && block
                ? { defaultProvider: next, defaultModel: firstModel.id, thinkingLevel: clampModelEffort(block.value.thinkingLevel, firstModel) }
                : { defaultProvider: next, defaultModel: "" },
            );
          }}
          onModelChange={(id) => {
            const model = groups.find((group) => group.providerId === provider)?.models.find((item) => item.id === id);
            if (model && block) void save({ defaultProvider: provider, defaultModel: id, thinkingLevel: clampModelEffort(block.value.thinkingLevel, model) });
          }}
          onThinkingChange={(thinkingLevel) => void save({ thinkingLevel })}
        />
        {(saveError || loadError) && <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Description>{saveError || loadError}</Alert.Description></Alert.Content>
          {!saveError && <Button size="sm" variant="ghost" onPress={() => void refresh()}>{t("重试", "Retry")}</Button>}
        </Alert>}
        <Separator />
        <Select
          aria-label={t("执行权限", "Permissions")}
          variant="secondary"
          value={hostActionPermission}
          className="kulo-compact-row kulo-compact-row--choice"
          isDisabled={!executorBlock || saving}
          onChange={(key) => {
            if (key === "ask" || key === "always") void savePermission(key);
          }}
        >
          <Label className="text-sm font-normal text-foreground">{t("执行权限", "Permissions")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover className="motion-reduce:animate-none">
            <ListBox>
              <ListBox.Item id="ask" textValue={t("需要授权", "Ask first")}>
                {t("需要授权", "Ask first")}<ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="always" textValue={t("总是允许", "Always allow")}>
                {t("总是允许", "Always allow")}<ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
        <Switch className="w-full" isSelected={showProcess} onChange={onShowProcessChange}>
          <Switch.Content className="kulo-compact-row kulo-compact-row--toggle">
            <Label className="text-sm text-foreground">{t("显示执行过程", "Show execution process")}</Label>
            <Switch.Control><Switch.Thumb /></Switch.Control>
          </Switch.Content>
        </Switch>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
