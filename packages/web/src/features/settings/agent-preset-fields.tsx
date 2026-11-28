import { useI18n } from "../../kulo-i18n";
import { ComboBox, Description, Fieldset, Header, Input, Label, ListBox, Select, Switch, TextArea, TextField } from "@heroui/react";
import {
  isSupportedExternalAgentKind,
  resolveExternalModelEffortPolicy,
  type EnvNodeDescriptor,
  type ExternalAgentKind,
  type ExternalAgentModelInfo,
  type ExternalAgentServiceTierInfo,
  type ExternalClientConnection,
  type KuloSettingsView,
  type RolePreset,
} from "@kulo/protocol";
import { formatExternalClientTarget, roleExternalClientId, switchRoleEngine } from "./external-agents-view";
import { ROLE_EFFORT_OPTIONS, clampModelEffort, effortLabel, modelEffortOptions, selectedDefaultProvider, type ProviderModelGroup } from "./settings-helpers";

const DEFAULT_MODEL_KEY = "__default__";
const BUILTIN_ENGINE_KEY = "__builtin__";
const EXTERNAL_DEFAULT_MODEL_KEY = "__client_default__";
const EXTERNAL_DEFAULT_TIER_KEY = "__client_default__";

export function applyExternalModelChange(
  value: RolePreset,
  nextRaw: string,
  externalModels: readonly ExternalAgentModelInfo[],
  externalKind?: ExternalAgentKind | string,
): RolePreset {
  const trimmed = nextRaw.trim();
  const nextModel = trimmed
    ? externalModels.find((item) => item.id === trimmed)
    : externalModels.find((item) => item.isDefault);
  const nextPolicy = resolveExternalModelEffortPolicy(nextModel, externalKind, externalModels);
  const currentEffort = value.thinkingLevel ?? "auto";
  const nextEffort =
    nextPolicy.capability === "unsupported"
      ? "auto"
      : currentEffort !== "auto" && nextPolicy.capability === "supported" && !nextPolicy.efforts.includes(currentEffort)
        ? "auto"
        : currentEffort;
  const currentServiceTier = value.serviceTier?.trim() || "";
  const nextTier =
    currentServiceTier && nextModel && !(nextModel.serviceTiers ?? []).some((tier) => tier.id === currentServiceTier)
      ? undefined
      : value.serviceTier;
  return {
    ...value,
    provider: undefined,
    modelId: nextRaw ? nextRaw : undefined,
    thinkingLevel: nextEffort,
    serviceTier: nextTier,
  };
}

export function externalEffortLabel(effort: string, t: (zh: string, en: string) => string): string {
  if (effort === "auto" || !effort) return t("自动", "Auto");
  if (effort === "adaptive") return t("自适应", "Adaptive");
  if (effort === "none" || effort === "disabled") return t("关闭", "Off");
  return effortLabel(effort);
}

export function externalServiceTierLabel(
  tier: string | ExternalAgentServiceTierInfo | undefined,
  t: (zh: string, en: string) => string,
): string {
  const id = typeof tier === "string" ? tier : tier?.id;
  const name = typeof tier === "string" ? undefined : tier?.name?.trim();
  if (!id || id === "auto" || id === EXTERNAL_DEFAULT_TIER_KEY) return t("客户端默认", "Client default");
  if (name) return name;
  const normalized = id.toLowerCase();
  if (normalized === "default" || normalized === "standard") return t("标准", "Standard");
  if (normalized === "fast") return "Fast";
  if (normalized === "ultrafast" || normalized === "ultra_fast" || normalized === "ultra-fast") return "Ultra Fast";
  if (normalized === "flex") return "Flex";
  if (normalized === "priority") return "Priority";
  return id;
}

export function AgentPresetFields({
  value,
  onChange,
  groups = [],
  defaultModel,
  externalClient,
  externalClients = [],
  envs = [],
  isDisabled = false,
  isCreating = false,
}: {
  value: RolePreset;
  onChange: (value: RolePreset) => void;
  groups?: ProviderModelGroup[];
  defaultModel?: KuloSettingsView["blocks"]["model"]["value"];
  externalClient?: ExternalClientConnection;
  externalClients?: ExternalClientConnection[];
  envs?: EnvNodeDescriptor[];
  isDisabled?: boolean;
  isCreating?: boolean;
}) {
  const { t } = useI18n();
  const valueClientId = roleExternalClientId(value);
  const resolvedExternalClient = externalClient ?? (valueClientId ? externalClients.find((item) => item.id === valueClientId) : undefined);
  const isExternal = Boolean(resolvedExternalClient || value.external || value.externalClientId);
  const selectedEngineKey = isExternal ? (resolvedExternalClient?.id ?? valueClientId ?? BUILTIN_ENGINE_KEY) : BUILTIN_ENGINE_KEY;
  const showEngineSelector = !externalClient && (externalClients.length > 0 || isExternal);
  const engineOptions: ExternalClientConnection[] = [
    ...externalClients,
    ...(isExternal && valueClientId && !externalClients.some((item) => item.id === valueClientId) && value.external
      ? [{
          id: valueClientId,
          kind: value.external.kind,
          envId: value.external.envId,
          ...(value.external.agentRef ? { agentRef: value.external.agentRef } : {}),
          ...(value.external.version ? { version: value.external.version } : {}),
          ...(value.external.verifiedAt !== undefined ? { verifiedAt: value.external.verifiedAt } : {}),
          models: [],
          updatedAt: 0,
        }]
      : []),
  ];

  const providerId = value.provider?.trim() || (defaultModel ? selectedDefaultProvider(defaultModel) : "");
  const modelId = value.modelId?.trim() || "";
  const selectedModelKey = modelId ? `${providerId}::${modelId}` : DEFAULT_MODEL_KEY;
  const inGroups = groups.some((group) => group.providerId === providerId && group.models.some((model) => model.id === modelId));
  const model = groups.find((group) => group.providerId === providerId)?.models.find((item) => item.id === (modelId || defaultModel?.defaultModel));

  const externalModels = resolvedExternalClient?.models ?? [];
  const externalKind = resolvedExternalClient?.kind ?? value.external?.kind;
  const matchedExternalModel = externalModels.find((item) => item.id === modelId) ?? (!modelId ? externalModels.find((item) => item.isDefault) : undefined);
  const externalEffortPolicy = isExternal
    ? resolveExternalModelEffortPolicy(matchedExternalModel, externalKind, externalModels)
    : undefined;
  const showEffortSelector = !isExternal || Boolean(externalEffortPolicy?.showSelector);

  const efforts = isExternal
    ? [
        { value: "auto", label: t("自动", "Auto") },
        ...(externalEffortPolicy?.efforts ?? []).filter((item) => item !== "auto").map((item) => ({ value: item, label: externalEffortLabel(item, t) })),
      ]
    : model
      ? [{ value: "auto", label: t("自动", "Auto") }, ...modelEffortOptions(model)]
      : ROLE_EFFORT_OPTIONS.map((option) => ({ ...option, label: effortLabel(option.value) }));

  if (showEffortSelector && value.thinkingLevel && !efforts.some((option) => option.value === value.thinkingLevel)) {
    efforts.push({
      value: value.thinkingLevel,
      label: isExternal ? externalEffortLabel(value.thinkingLevel, t) : effortLabel(value.thinkingLevel, model),
    });
  }

  const unionServiceTiers: ExternalAgentServiceTierInfo[] = [];
  for (const item of externalModels) {
    for (const tier of item.serviceTiers ?? []) {
      if (!unionServiceTiers.some((existing) => existing.id === tier.id)) unionServiceTiers.push(tier);
    }
  }
  const availableServiceTiers: ExternalAgentServiceTierInfo[] = matchedExternalModel
    ? (matchedExternalModel.serviceTiers ?? [])
    : unionServiceTiers;
  const currentServiceTier = value.serviceTier?.trim() || "";
  const showServiceTier = isExternal && (availableServiceTiers.length > 0 || Boolean(currentServiceTier));
  const serviceTierOptions: Array<{ value: string; label: string }> = [
    { value: EXTERNAL_DEFAULT_TIER_KEY, label: t("客户端默认", "Client default") },
    ...availableServiceTiers.map((tier) => ({
      value: tier.id,
      label: externalServiceTierLabel(tier, t),
    })),
  ];
  if (currentServiceTier && !serviceTierOptions.some((option) => option.value === currentServiceTier)) {
    serviceTierOptions.push({
      value: currentServiceTier,
      label: externalServiceTierLabel(currentServiceTier, t),
    });
  }

  const selectEngine = (key: string) => {
    if (key === BUILTIN_ENGINE_KEY) {
      onChange(switchRoleEngine(value, undefined));
      return;
    }
    const targetClient = engineOptions.find((item) => item.id === key);
    if (!targetClient) return;
    onChange(switchRoleEngine(value, targetClient));
  };

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
    onChange(applyExternalModelChange(value, nextRaw, externalModels, externalKind));
  };

  return <div className="kulo-form-stack">
    <Fieldset className="gap-4" disabled={isDisabled}>
      <Fieldset.Legend className="kulo-group-title">{t("基本设置", "General")}</Fieldset.Legend>
      <Fieldset.Group className="kulo-form-stack space-y-0">
        <TextField variant="primary" isRequired value={value.label} onChange={(label) => onChange({ ...value, label })} fullWidth className="kulo-form-field">
          <Label className="text-sm text-foreground">{t("智能体名称", "Agent name")}</Label>
          <Input placeholder={isCreating ? t("例如：数据分析师", "e.g. Data analyst") : undefined} />
        </TextField>
        {isCreating && <TextField variant="primary" isRequired value={value.id} onChange={(id) => onChange({ ...value, id })} fullWidth className="kulo-form-field">
          <Label className="text-sm text-foreground">{t("智能体标识", "Agent ID")}</Label>
          <Input placeholder={t("例如：analyst", "e.g. analyst")} maxLength={40} pattern={"[a-z][a-z0-9_\\-]{0,39}"} />
        </TextField>}
        {showEngineSelector && (
          <Select
            variant="primary"
            value={selectedEngineKey}
            onChange={(key) => {
              if (key !== null) selectEngine(String(key));
            }}
            fullWidth
            className="kulo-form-field"
          >
            <Label className="text-sm text-foreground">{t("运行引擎", "Execution engine")}</Label>
            <Select.Trigger><Select.Value className="truncate" /><Select.Indicator /></Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id={BUILTIN_ENGINE_KEY} textValue={t("内置引擎", "Built-in engine")}>
                  {t("内置引擎", "Built-in engine")}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                {engineOptions.map((client) => {
                  const baseLabel = formatExternalClientTarget(client, envs);
                  const device = envs.find((env) => env.id === client.envId);
                  const reserved = client.kind === "dots" || client.kind === "muse";
                  const experimental = Boolean(client.experimental || client.kind === "grok-bot");
                  const ready = Boolean(client.verifiedAt && isSupportedExternalAgentKind(client.kind) && !reserved && !experimental);
                  const suffix = reserved
                    ? t("（待支持）", " (Reserved)")
                    : experimental
                      ? t("（实验）", " (Experimental)")
                      : !client.verifiedAt
                        ? t("（待验证）", " (Unverified)")
                        : device?.online === false
                          ? t("（离线）", " (Offline)")
                          : "";
                  const optionLabel = `${baseLabel}${suffix}`;
                  return (
                    <ListBox.Item
                      key={client.id}
                      id={client.id}
                      textValue={optionLabel}
                      isDisabled={!ready && client.id !== selectedEngineKey}
                    >
                      <span className="min-w-0 whitespace-normal break-words">{optionLabel}</span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  );
                })}
              </ListBox>
            </Select.Popover>
          </Select>
        )}
        <div className="flex flex-col gap-1">
          <Switch isSelected={Boolean(value.readOnly)} onChange={(readOnly) => onChange({ ...value, readOnly })} className="w-full">
            <Switch.Content className="kulo-form-toggle">
              <Label className="text-sm font-normal text-foreground">{t("只读模式", "Read-only mode")}</Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
          <Switch isSelected={Boolean(value.allowSubagents)} onChange={(allowSubagents) => onChange({ ...value, allowSubagents })} className="w-full">
            <Switch.Content className="kulo-form-toggle">
              <Label className="text-sm font-normal text-foreground">{t("允许子智能体", "Allow subagents")}</Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        </div>
      </Fieldset.Group>
    </Fieldset>

    <Fieldset className="gap-4 border-t border-separator pt-4" disabled={isDisabled}>
      <Fieldset.Legend className="kulo-group-title">{t("模型与思考", "Model and thinking")}</Fieldset.Legend>
      <Fieldset.Group className="kulo-form-stack space-y-0">
        {isExternal ? (
          <ComboBox
            variant="primary"
            className="kulo-form-field"
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
          <Select variant="primary" value={selectedModelKey} onChange={(key) => selectModel(String(key ?? DEFAULT_MODEL_KEY))} fullWidth className="kulo-form-field">
            <Label className="text-sm text-foreground">{t("智能体模型", "Agent model")}</Label>
            <Select.Trigger><Select.Value className="truncate" /><Select.Indicator /></Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id={DEFAULT_MODEL_KEY} textValue={t("默认模型", "Default model")}>{t("默认模型", "Default model")}<ListBox.ItemIndicator /></ListBox.Item>
                {!inGroups && modelId && <ListBox.Item id={selectedModelKey} textValue={modelId}><span className="min-w-0 whitespace-normal break-all">{groups.length > 0 ? t(`${modelId}（未添加）`, `${modelId} (not added)`) : modelId}</span><ListBox.ItemIndicator /></ListBox.Item>}
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
        {showEffortSelector && (
          <Select variant="primary" value={value.thinkingLevel ?? "auto"} onChange={(key) => { if (key !== null) onChange({ ...value, thinkingLevel: String(key) }); }} fullWidth className="kulo-form-field">
            <Label className="text-sm text-foreground">{t("默认思考强度", "Default thinking effort")}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover>
              <ListBox>{efforts.map((option) => <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                {option.label}<ListBox.ItemIndicator />
              </ListBox.Item>)}</ListBox>
            </Select.Popover>
          </Select>
        )}
        {showServiceTier && (
          <Select
            variant="primary"
            value={currentServiceTier || EXTERNAL_DEFAULT_TIER_KEY}
            onChange={(key) => {
              if (key === null) return;
              const next = String(key);
              onChange({
                ...value,
                serviceTier: next === EXTERNAL_DEFAULT_TIER_KEY ? undefined : next,
              });
            }}
            fullWidth
            className="kulo-form-field"
          >
            <Label className="text-sm text-foreground">{t("服务档位", "Service tier")}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover>
              <ListBox>
                {serviceTierOptions.map((option) => (
                  <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                    {option.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        )}
      </Fieldset.Group>
    </Fieldset>

    <Fieldset className="gap-4 border-t border-separator pt-4" disabled={isDisabled}>
      <Fieldset.Legend className="kulo-group-title">{t("任务与提示词", "Tasks and prompts")}</Fieldset.Legend>
      <Fieldset.Group className="kulo-form-stack space-y-0">
        <TextField variant="primary" className="kulo-form-field" isRequired value={value.whenToUse} onChange={(whenToUse) => onChange({ ...value, whenToUse })} fullWidth>
          <Label className="text-sm text-foreground">{t("负责任务", "Responsibilities")}</Label>
          <TextArea rows={4} className="scrollbar h-28 min-h-28 resize-y text-sm" />
          <Description className="text-right text-xs tabular-nums">{Array.from(value.whenToUse).length}  {t("字", "characters")}</Description>
        </TextField>
        <TextField variant="primary" className="kulo-form-field" isRequired value={value.prompt} onChange={(prompt) => onChange({ ...value, prompt })} fullWidth>
          <Label className="text-sm text-foreground">{t("智能体系统提示词", "Agent system prompt")}</Label>
          <TextArea rows={4} className="scrollbar h-28 min-h-28 resize-y text-sm" />
          <Description className="text-right text-xs tabular-nums">{Array.from(value.prompt).length}  {t("字", "characters")}</Description>
        </TextField>
      </Fieldset.Group>
    </Fieldset>
  </div>;
}
