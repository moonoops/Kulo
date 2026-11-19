import { useI18n } from "../../moco-i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Label, Popover, Separator, Spinner, Switch } from "@heroui/react";
import type { MocoSettingsView } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { MocoIcon } from "../../moco-icon";
import { ModelSelectionFields } from "../settings/model-selection-fields";
import { useProviderCatalog } from "../settings/use-provider-catalog";
import { buildProviderModelGroups, clampModelEffort, selectedDefaultProvider } from "../settings/settings-helpers";

export function ConversationModelSettings({ settings, onSettingsUpdated, showProcess, onShowProcessChange }: {
  settings: MocoSettingsView | null;
  onSettingsUpdated: (settings: MocoSettingsView) => void;
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
  const groups = useMemo(() => block ? buildProviderModelGroups(block.value, providers) : [], [block, providers, language]);
  const provider = block ? selectedDefaultProvider(block.value) : "";

  const save = async (patch: Partial<MocoSettingsView["blocks"]["model"]["value"]>) => {
    if (!block || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await mocoRest.saveSettingsBlock("model", block.revision, { ...block.value, ...patch });
      onSettingsUpdated(result.settings);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("切换模型设置失败", "Failed to change model settings"));
    } finally { setSaving(false); }
  };

  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button isIconOnly variant="ghost" aria-label={t("模型选择", "Model selection")}>
      <MocoIcon name="token" size={18} />
    </Button>
    <Popover.Content placement="top start" className="w-[360px] max-w-[calc(100vw-24px)] motion-reduce:animate-none">
      <Popover.Dialog ref={dialogRef} className="moco-compact-fields outline-none">
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
        <Switch className="w-full" isSelected={showProcess} onChange={onShowProcessChange}>
          <Switch.Content className="moco-compact-row moco-compact-row--toggle">
            <Label className="text-sm text-foreground">{t("显示执行过程", "Show execution process")}</Label>
            <Switch.Control><Switch.Thumb /></Switch.Control>
          </Switch.Content>
        </Switch>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
