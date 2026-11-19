import { useI18n } from "../../moco-i18n";
import { ComboBox, Description, Fieldset, Header, Input, Label, ListBox, Select, Switch, TextArea, TextField } from "@heroui/react";
import type { ExternalClientConnection, MocoSettingsView, RolePreset } from "@moco/protocol";
import { ROLE_EFFORT_OPTIONS, clampModelEffort, effortLabel, modelEffortOptions, type ProviderModelGroup } from "./settings-helpers";

const DEFAULT_MODEL_KEY = "__default__";
const EXTERNAL_DEFAULT_MODEL_KEY = "__client_default__";

const FALLBACK_EXTERNAL_EFFORTS: Record<string, string[]> = {
  "claude-code": ["adaptive", "low", "medium", "high", "max", "none"],
  codex: ["low", "medium", "high", "xhigh"],
  antigravity: ["low", "medium", "high"],
  dsh: ["low", "medium", "high"],
};

export function externalEffortLabel(effort: string, t: (zh: string, en: string) => string): string {
  if (effort === "auto" || !effort) return t("自动", "Auto");
  if (effort === "adaptive") return t("自适应", "Adaptive");
  if (effort === "none" || effort === "disabled") return t("关闭", "Off");
  return effortLabel(effort);
}

export function AgentPresetFields({ value, onChange, groups = [], defaultModel, externalClient, isDisabled = false, isCreating = false }: {
  value: RolePreset;
  onChange: (value: RolePreset) => void;
  groups?: ProviderModelGroup[];
  defaultModel?: MocoSettingsView["blocks"]["model"]["value"];
  externalClient?: ExternalClientConnection;
  isDisabled?: boolean;
  isCreating?: boolean;
}) {
  const { t } = useI18n();
  const isExternal = Boolean(externalClient || value.external || value.externalClientId);
  const providerId = value.provider?.trim() || defaultModel?.defaultProvider || "moco-gateway";
  const modelId = value.modelId?.trim() || "";
  const selectedModelKey = modelId ? `${providerId}::${modelId}` : DEFAULT_MODEL_KEY;
  const inGroups = groups.some((group) => group.providerId === providerId && group.models.some((model) => model.id === modelId));
  const model = groups.find((group) => group.providerId === providerId)?.models.find((item) => item.id === (modelId || defaultModel?.defaultModel));

  const externalModels = externalClient?.models ?? [];
  const matchedExternalModel = externalModels.find((item) => item.id === modelId) ?? (!modelId ? externalModels.find((item) => item.isDefault) : undefined);
  const unionExternalEfforts = [...new Set(externalModels.flatMap((item) => item.efforts ?? []))];
  const rawExternalEfforts = matchedExternalModel?.efforts?.length
    ? matchedExternalModel.efforts
    : unionExternalEfforts.length
      ? unionExternalEfforts
      : FALLBACK_EXTERNAL_EFFORTS[externalClient?.kind ?? value.external?.kind ?? "codex"] ?? ["low", "medium", "high"];

  const efforts = isExternal
    ? [
        { value: "auto", label: t("自动", "Auto") },
        ...rawExternalEfforts.filter((item) => item !== "auto").map((item) => ({ value: item, label: externalEffortLabel(item, t) })),
      ]
    : model
      ? [{ value: "auto", label: t("自动", "Auto") }, ...modelEffortOptions(model)]
      : ROLE_EFFORT_OPTIONS.map((option) => ({ ...option, label: effortLabel(option.value) }));

  if (value.thinkingLevel && !efforts.some((option) => option.value === value.thinkingLevel)) {
    efforts.push({
      value: value.thinkingLevel,
      label: isExternal ? externalEffortLabel(value.thinkingLevel, t) : effortLabel(value.thinkingLevel, model),
    });
  }

  const selectModel = (key: string) => {
    if (key === DEFAULT_MODEL_KEY) {
      onChange({ ...value, provider: undefined, modelId: undefined });
      return;
    }
    const separator = key.indexOf("::");
    if (separator <= 0) return;
    const provider = key.slice(0, separator);
    const nextModelId = key.slice(separator + 2);
    const nextModel = groups.find((group) => group.providerId === provider)?.models.find((item) => item.id === nextModelId);
    const effort = value.thinkingLevel ?? "auto";
    onChange({ ...value, provider, modelId: nextModelId, thinkingLevel: nextModel && effort !== "auto" ? clampModelEffort(effort, nextModel) : effort });
  };

  const updateExternalModel = (nextRaw: string) => {
    const trimmed = nextRaw.trim();
    const nextModel = externalModels.find((item) => item.id === trimmed);
    const currentEffort = value.thinkingLevel ?? "auto";
    const nextEffort = currentEffort !== "auto" && nextModel?.efforts?.length && !nextModel.efforts.includes(currentEffort)
      ? "auto"
      : currentEffort;
    onChange({
      ...value,
      provider: undefined,
      modelId: nextRaw ? nextRaw : undefined,
      thinkingLevel: nextEffort,
    });
  };

  return <div className="moco-form-stack">
    <Fieldset className="gap-4" disabled={isDisabled}>
      <Fieldset.Legend className="moco-group-title">{t("基本设置", "General")}</Fieldset.Legend>
      <Fieldset.Group className="moco-form-stack space-y-0">
        <TextField variant="primary" isRequired value={value.label} onChange={(label) => onChange({ ...value, label })} fullWidth className="moco-form-field">
          <Label className="text-sm text-foreground">{t("智能体名称", "Agent name")}</Label>
          <Input placeholder={isCreating ? (isExternal ? t("架构师", "Architect") : t("数据分析师", "Data analyst")) : undefined} />
        </TextField>
        {isCreating && <TextField variant="primary" isRequired value={value.id} onChange={(id) => onChange({ ...value, id })} fullWidth className="moco-form-field">
          <Label className="text-sm text-foreground">{t("智能体标识", "Agent ID")}</Label>
          <Input placeholder={isExternal ? `${externalClient?.kind ?? "codex"}-architect` : "analyst"} maxLength={40} pattern={"[a-z][a-z0-9_\\-]{0,39}"} />
        </TextField>}
        {!isExternal && <div className="flex flex-col gap-1">
          <Switch isSelected={Boolean(value.readOnly)} onChange={(readOnly) => onChange({ ...value, readOnly })} className="w-full">
            <Switch.Content className="moco-form-toggle">
              <Label className="text-sm font-normal text-foreground">{t("只读模式", "Read-only mode")}</Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
          <Switch isSelected={Boolean(value.allowSubagents)} onChange={(allowSubagents) => onChange({ ...value, allowSubagents })} className="w-full">
            <Switch.Content className="moco-form-toggle">
              <Label className="text-sm font-normal text-foreground">{t("允许子智能体", "Allow subagents")}</Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        </div>}
      </Fieldset.Group>
    </Fieldset>

    <Fieldset className="gap-4 border-t border-separator pt-4" disabled={isDisabled}>
      <Fieldset.Legend className="moco-group-title">{t("模型与思考", "Model and thinking")}</Fieldset.Legend>
      <Fieldset.Group className="moco-form-stack space-y-0">
        {isExternal ? (
          <ComboBox
            variant="primary"
            className="moco-form-field"
            fullWidth
            inputValue={value.modelId ?? ""}
            selectedKey={modelId ? (externalModels.some((item) => item.id === modelId) ? modelId : null) : EXTERNAL_DEFAULT_MODEL_KEY}
            allowsCustomValue
            menuTrigger="focus"
            defaultFilter={() => true}
            isDisabled={isDisabled}
            onInputChange={updateExternalModel}
            onSelectionChange={(key) => {
              if (key === EXTERNAL_DEFAULT_MODEL_KEY) updateExternalModel("");
              else if (key !== null) updateExternalModel(String(key));
            }}
          >
            <Label className="text-sm text-foreground">{t("智能体模型", "Agent model")}</Label>
            <ComboBox.InputGroup>
              <Input placeholder={t("客户端默认", "Client default")} spellCheck={false} />
              <ComboBox.Trigger aria-label={t("展开客户端模型列表", "Open client model list")} />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox renderEmptyState={() => <span className="p-3 text-sm text-muted">{t("直接使用输入的模型 ID", "Use the entered model ID")}</span>}>
                <ListBox.Item id={EXTERNAL_DEFAULT_MODEL_KEY} textValue="" aria-label={t("客户端默认", "Client default")}>
                  {t("客户端默认", "Client default")}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                {externalModels.map((item) => (
                  <ListBox.Item key={item.id} id={item.id} textValue={item.id}>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="min-w-0 whitespace-normal break-all">{item.name || item.id}{item.isDefault ? ` (${t("默认", "Default")})` : ""}</span>
                      {item.name && item.name !== item.id && <span className="min-w-0 whitespace-normal break-all text-xs text-muted">{item.id}</span>}
                    </span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
          </ComboBox>
        ) : (
          <Select variant="primary" value={selectedModelKey} onChange={(key) => selectModel(String(key ?? DEFAULT_MODEL_KEY))} fullWidth className="moco-form-field">
            <Label className="text-sm text-foreground">{t("智能体模型", "Agent model")}</Label>
            <Select.Trigger><Select.Value className="truncate" /><Select.Indicator /></Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id={DEFAULT_MODEL_KEY} textValue={t("默认模型", "Default model")}>{t("默认模型", "Default model")}<ListBox.ItemIndicator /></ListBox.Item>
                {!inGroups && modelId && <ListBox.Item id={selectedModelKey} textValue={modelId}><span className="min-w-0 whitespace-normal break-all">{modelId}</span><ListBox.ItemIndicator /></ListBox.Item>}
                {groups.map((group) => <ListBox.Section key={group.providerId}>
                  <Header>{group.label}</Header>
                  {group.models.map((item) => <ListBox.Item key={item.id} id={`${group.providerId}::${item.id}`} textValue={item.id}>
                    <span className="min-w-0 whitespace-normal break-all">{item.id}</span><ListBox.ItemIndicator />
                  </ListBox.Item>)}
                </ListBox.Section>)}
              </ListBox>
            </Select.Popover>
          </Select>
        )}
        <Select variant="primary" value={value.thinkingLevel ?? "auto"} onChange={(key) => { if (key !== null) onChange({ ...value, thinkingLevel: String(key) }); }} fullWidth className="moco-form-field">
          <Label className="text-sm text-foreground">{t("默认思考强度", "Default thinking effort")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>{efforts.map((option) => <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              {option.label}<ListBox.ItemIndicator />
            </ListBox.Item>)}</ListBox>
          </Select.Popover>
        </Select>
      </Fieldset.Group>
    </Fieldset>

    <Fieldset className="gap-4 border-t border-separator pt-4" disabled={isDisabled}>
      <Fieldset.Legend className="moco-group-title">{t("任务与提示词", "Tasks and prompts")}</Fieldset.Legend>
      <Fieldset.Group className="moco-form-stack space-y-0">
        <TextField variant="primary" className="moco-form-field" isRequired value={value.whenToUse} onChange={(whenToUse) => onChange({ ...value, whenToUse })} fullWidth>
          <Label className="text-sm text-foreground">{isExternal ? t("委派时机", "When to delegate") : t("负责任务", "Responsibilities")}</Label>
          <TextArea rows={4} className="scrollbar h-28 min-h-28 resize-y text-sm" />
          <Description className="text-right text-xs tabular-nums">{Array.from(value.whenToUse).length}  {t("字", "characters")}</Description>
        </TextField>
        <TextField variant="primary" className="moco-form-field" isRequired value={value.prompt} onChange={(prompt) => onChange({ ...value, prompt })} fullWidth>
          <Label className="text-sm text-foreground">{isExternal ? t("交给该智能体的任务要求", "Task instructions for this agent") : t("智能体系统提示词", "Agent system prompt")}</Label>
          <TextArea rows={4} className="scrollbar h-28 min-h-28 resize-y text-sm" />
          <Description className="text-right text-xs tabular-nums">{Array.from(value.prompt).length}  {t("字", "characters")}</Description>
        </TextField>
      </Fieldset.Group>
    </Fieldset>
  </div>;
}
