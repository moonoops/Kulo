import { useI18n } from "../../kulo-i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Dropdown,
  Label,
  Spinner,
} from "@heroui/react";
import {
  isConversationModel,
  type CustomModelConfig,
  type CustomProviderApi,
  type CustomProviderConfig,
  type KuloSettingsView,
  type OAuthSessionView,
  type ProviderModelItem,
  type ThinkingEffort,
} from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { kuloRest, providerCatalog } from "../../kulo-api";
import { useProviderCatalog } from "./use-provider-catalog";
import { KuloIcon } from "../../kulo-icon";
import {
  ApiProviderModal,
  type ApiProviderModalState,
} from "./api-provider-modal";
import { OAuthSubscriptionModal } from "./oauth-modal";
import { UsageCapsSection } from "./usage-caps-section";
import { ModelSelectionFields } from "./model-selection-fields";
import { SettingsList } from "./settings-layout";
import { ProviderConnectionTable, type ProviderConnectionItem } from "./provider-connection-table";
import type { SettingsAssistantEntryIntent } from "./settings-assistant-actions";
import {
  MAINSTREAM_PRESETS,
  SUBSCRIPTION_PROVIDERS,
  allocateCustomProviderId,
  buildProviderModelGroups,
  clampModelEffort,
  countConfiguredModelsForProvider,
  selectedDefaultProvider,
  shortApiLabel,
} from "./settings-helpers";

type DeleteConfirmState =
  | { kind: "gateway"; label: string }
  | { kind: "custom"; id: string; label: string }
  | { kind: "oauth"; id: string; label: string };

export function ModelsModule({
  settings,
  onSettingsUpdated,
  onDirtyChange,
  entryIntent,
  onIntentHandled,
}: {
  settings: KuloSettingsView;
  onSettingsUpdated: (next: KuloSettingsView) => void;
  onDirtyChange?: (dirty: boolean) => void;
  entryIntent?: SettingsAssistantEntryIntent | null;
  onIntentHandled?: (id: string) => void;
}) {
  const { t } = useI18n();
  const modelBlock = settings.blocks.model;

  const { providers, presets: livePresets, loading: loadingProviders, error: catalogError, refresh: loadProviders } = useProviderCatalog(settings);
  const activePresets = livePresets?.length ? livePresets : MAINSTREAM_PRESETS;
  const [authBusyId, setAuthBusyId] = useState<string | null>(null);
  const [savingModelBlock, setSavingModelBlock] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [error, setError] = useState<string>();
  const [providerModalError, setProviderModalError] = useState<string>();
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);

  const [oauthModal, setOauthModal] = useState<{
    open: boolean;
    initialProviderId: string;
    starting: boolean;
    session: OAuthSessionView | null;
    error?: string;
  } | null>(null);
  const [providerModal, setProviderModal] = useState<ApiProviderModalState | null>(null);
  const providerModalSeqRef = useRef(0);
  const providerSaveInFlightRef = useRef(false);

  useEffect(() => {
    onDirtyChange?.(Boolean(providerModal?.open || oauthModal?.open));
    return () => onDirtyChange?.(false);
  }, [providerModal?.open, oauthModal?.open, onDirtyChange]);

  const defaultProvider = selectedDefaultProvider(modelBlock.value);
  const defaultModel = modelBlock.value.defaultModel;
  const thinkingLevel = modelBlock.value.thinkingLevel;

  const customProviders = modelBlock.value.customProviders ?? [];

  const providerCatalogById = useMemo(
    () => new Map(providers.map((p) => [p.id, p])),
    [providers],
  );

  const builtinIdsSet = useMemo(
    () => new Set(providers.filter((p) => p.builtin && !p.isGateway).map((p) => p.id)),
    [providers],
  );

  const providerModelGroups = useMemo(
    () => buildProviderModelGroups(modelBlock.value, providers),
    [modelBlock.value, providers, t],
  );
  const getModelsForProvider = (providerId: string): ProviderModelItem[] =>
    providerModelGroups.find((group) => group.providerId === providerId)?.models ?? [];

  const persistModelBlock = async (
    patch: Record<string, unknown>,
    options?: { onError?: (message: string) => void },
  ) => {
    setSavingModelBlock(true);
    if (options?.onError) {
      options.onError("");
    } else {
      setError(undefined);
    }
    try {
      const payload = {
        baseUrl: modelBlock.value.baseUrl,
        apiMode: modelBlock.value.apiMode,
        ...(modelBlock.value.vertexProject ? { vertexProject: modelBlock.value.vertexProject } : {}),
        ...(modelBlock.value.vertexLocation ? { vertexLocation: modelBlock.value.vertexLocation } : {}),
        defaultProvider: selectedDefaultProvider(modelBlock.value),
        defaultModel: modelBlock.value.defaultModel,
        thinkingLevel: modelBlock.value.thinkingLevel,
        contextWindow: modelBlock.value.contextWindow ?? 256_000,
        compaction: modelBlock.value.compaction,
        customProviders: modelBlock.value.customProviders ?? [],
        ...(modelBlock.value.subscriptionModels ? { subscriptionModels: modelBlock.value.subscriptionModels } : {}),
        ...(modelBlock.value.gatewayName
          ? { gatewayName: modelBlock.value.gatewayName }
          : {}),
        ...(modelBlock.value.gatewayModels
          ? { gatewayModels: modelBlock.value.gatewayModels }
          : {}),
        ...(modelBlock.value.gatewayDisabled ? { gatewayDisabled: true } : {}),
        ...patch,
      };
      const res = await kuloRest.saveSettingsBlock("model", modelBlock.revision, payload);
      onSettingsUpdated(res.settings);
      return res.settings;
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("保存失败", "Save failed");
      if (options?.onError) {
        options.onError(msg);
      } else {
        setError(msg);
      }
      return null;
    } finally {
      setSavingModelBlock(false);
    }
  };

  const handleDefaultModelChange = (nextModel: string) => {
    const meta = getModelsForProvider(defaultProvider).find((model) => model.id === nextModel);
    if (!meta) return;
    void persistModelBlock({
      defaultProvider,
      defaultModel: nextModel,
      thinkingLevel: clampModelEffort(thinkingLevel, meta),
    });
  };

  const handleThinkingChange = (nextEffort: ThinkingEffort) => {
    void persistModelBlock({ thinkingLevel: nextEffort });
  };

  const openCreateProviderModal = () => {
    const preset = activePresets[0] ?? MAINSTREAM_PRESETS[0]!;
    setProviderModalError(undefined);
    setProviderModal({
      open: true,
      openSeq: ++providerModalSeqRef.current,
      mode: "create",
      providerKind: "preset",
      presetId: preset.id,
      name: preset.name,
      api: preset.api,
      baseUrl: preset.baseUrl,
      hasSavedKey: false,
      initialModels: [],
    });
  };

  const openEditCustomProviderModal = (cp: CustomProviderConfig) => {
    const cat = providerCatalogById.get(cp.id);
    setProviderModalError(undefined);
    setProviderModal({
      open: true,
      openSeq: ++providerModalSeqRef.current,
      mode: "edit",
      editingProviderId: cp.id,
      providerKind: cp.preset ? "preset" : "third-party",
      presetId: cp.preset || (activePresets[0]?.id ?? MAINSTREAM_PRESETS[0]!.id),
      name: cp.name,
      api: cp.api,
      baseUrl: cp.baseUrl,
      vertexProject: cp.vertexProject,
      vertexLocation: cp.vertexLocation,
      hasSavedKey: Boolean(cat?.authenticated),
      initialModels: cp.models,
    });
  };

  const openEditGatewayModal = () => {
    const cat = providerCatalogById.get("kulo-gateway");
    setProviderModalError(undefined);
    setProviderModal({
      open: true,
      openSeq: ++providerModalSeqRef.current,
      mode: "gateway",
      editingProviderId: "kulo-gateway",
      providerKind: "third-party",
      presetId: MAINSTREAM_PRESETS[0]!.id,
      name: modelBlock.value.gatewayName?.trim() || t("默认兼容网关", "Default compatible gateway"),
      api: modelBlock.value.apiMode,
      baseUrl: modelBlock.value.baseUrl,
      vertexProject: modelBlock.value.vertexProject,
      vertexLocation: modelBlock.value.vertexLocation,
      hasSavedKey: Boolean(modelBlock.hasApiKey || cat?.authenticated),
      initialModels: modelBlock.value.gatewayModels ?? [],
    });
  };

  const openEditSubscriptionModal = (providerId: string) => {
    const provider = providerCatalogById.get(providerId);
    if (!provider) return;
    const initialModels: CustomModelConfig[] = [...(modelBlock.value.subscriptionModels?.[providerId] ??
      (provider.modelCatalogSource === "configured" ? provider.models.map((model) => ({ ...model })) : []))];
    if (defaultProvider === providerId && defaultModel && !initialModels.some((model) => model.id === defaultModel)) {
      initialModels.push({ ...provider.models.find((model) => model.id === defaultModel), id: defaultModel });
    }
    setProviderModalError(undefined);
    setProviderModal({
      open: true, openSeq: ++providerModalSeqRef.current, mode: "subscription", editingProviderId: providerId,
      providerKind: "preset", presetId: providerId,
      name: SUBSCRIPTION_PROVIDERS.find((subscription) => subscription.id === providerId)?.label ?? provider.name,
      api: (provider.models[0]?.api as CustomProviderApi | undefined) ?? "openai-responses",
      baseUrl: "", hasSavedKey: false, initialModels,
    });
  };

  const defaultEffortForConfiguredModel = (
    current: ThinkingEffort,
    model: CustomModelConfig,
  ): ThinkingEffort => {
    if (model.reasoning === false || model.thinkingEnabled === false) return "off";
    if (model.thinkingLevels?.length) {
      if (model.thinkingLevels.some((level) => level.id === current)) return current;
      return model.thinkingLevels.find((level) => level.value === "medium")?.id ?? model.thinkingLevels[0]!.id;
    }
    return current;
  };

  const handleSaveProviderModal = async (draft: {
    providerKind: "preset" | "third-party";
    presetId: string;
    name: string;
    api: CustomProviderApi;
    baseUrl: string;
    vertexProject?: string;
    vertexLocation?: string;
    apiKey: string;
    models: CustomModelConfig[];
  }) => {
    if (
      !providerModal?.open ||
      providerSaveInFlightRef.current ||
      savingModelBlock
    ) return;
    providerSaveInFlightRef.current = true;
    setSavingProvider(true);
    setProviderModalError(undefined);
    const onModalError = (msg: string) => setProviderModalError(msg || undefined);
    try {
      if (providerModal.mode === "subscription" && providerModal.editingProviderId) {
        const id = providerModal.editingProviderId;
        let nextDefaultProvider = defaultProvider;
        let nextDefaultModel = defaultModel;
        let nextThinking: ThinkingEffort | undefined;
        if (
          defaultProvider === id &&
          nextDefaultModel &&
          !draft.models.some((model) => model.id === nextDefaultModel && isConversationModel(model))
        ) {
          nextDefaultModel = "";
        }
        if (!nextDefaultModel.trim()) {
          const firstChat = draft.models.find((m) => isConversationModel(m));
          if (firstChat) {
            nextDefaultProvider = id;
            nextDefaultModel = firstChat.id;
            nextThinking = defaultEffortForConfiguredModel(thinkingLevel, firstChat);
          }
        }
        const saved = await persistModelBlock({
          subscriptionModels: { ...modelBlock.value.subscriptionModels, [id]: draft.models },
          ...(nextDefaultProvider !== defaultProvider ? { defaultProvider: nextDefaultProvider } : {}),
          ...(nextDefaultModel !== defaultModel ? { defaultModel: nextDefaultModel } : {}),
          ...(nextThinking !== undefined ? { thinkingLevel: nextThinking } : {}),
        }, { onError: onModalError });
        if (saved) setProviderModal((prev) => (prev ? { ...prev, open: false } : null));
        return;
      }
      if (providerModal.mode === "gateway") {
        const apiMode = draft.api;
        const nextModels = draft.models;
        let nextDefaultProvider = defaultProvider;
        let nextDefaultModel = modelBlock.value.defaultModel;
        let nextThinking: ThinkingEffort | undefined;
        if (
          defaultProvider === "kulo-gateway" &&
          nextDefaultModel &&
          !nextModels.some((m) => m.id === nextDefaultModel && isConversationModel(m))
        ) {
          nextDefaultModel = "";
        }
        if (!nextDefaultModel.trim()) {
          const firstChat = nextModels.find((m) => isConversationModel(m));
          if (firstChat) {
            nextDefaultProvider = "kulo-gateway";
            nextDefaultModel = firstChat.id;
            nextThinking = defaultEffortForConfiguredModel(thinkingLevel, firstChat);
          }
        }
        const saved = await persistModelBlock(
          {
            baseUrl: draft.baseUrl,
            apiMode,
            vertexProject: draft.vertexProject ?? "",
            vertexLocation: draft.vertexLocation ?? "",
            gatewayName: draft.name,
            gatewayModels: nextModels,
            gatewayDisabled: false,
            defaultProvider: nextDefaultProvider,
            defaultModel: nextDefaultModel,
            ...(nextThinking !== undefined ? { thinkingLevel: nextThinking } : {}),
            ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
          },
          { onError: onModalError },
        );
        if (saved) {
          setProviderModal((prev) => (prev ? { ...prev, open: false } : null));
        }
        return;
      }

      const existingIds = new Set(customProviders.map((cp) => cp.id));
      let targetId = providerModal.editingProviderId;
      if (!targetId || providerModal.mode === "create") {
        const slugBase =
          draft.providerKind === "preset" ? `api-${draft.presetId}` : draft.name;
        targetId = allocateCustomProviderId(slugBase, existingIds, builtinIdsSet);
      }

      const nextEntry: CustomProviderConfig = {
        id: targetId,
        name: draft.name,
        ...(draft.providerKind === "preset" ? { preset: draft.presetId } : {}),
        api: draft.api,
        baseUrl: draft.baseUrl,
        ...(draft.api === "google-vertex" ? {
          vertexProject: draft.vertexProject,
          vertexLocation: draft.vertexLocation,
        } : {}),
        models: draft.models,
      };

      const nextCustomList = customProviders.some((cp) => cp.id === targetId)
        ? customProviders.map((cp) => (cp.id === targetId ? nextEntry : cp))
        : [...customProviders, nextEntry];

      let nextDefaultProvider = selectedDefaultProvider(modelBlock.value);
      let nextDefaultModel = modelBlock.value.defaultModel;
      let nextThinking: ThinkingEffort | undefined;
      if (nextDefaultProvider === targetId && nextDefaultModel) {
        if (!draft.models.some((m) => m.id === nextDefaultModel && isConversationModel(m))) {
          nextDefaultModel = "";
        }
      }
      if (!nextDefaultModel.trim()) {
        const firstChat = draft.models.find((m) => isConversationModel(m));
        if (firstChat) {
          nextDefaultProvider = targetId;
          nextDefaultModel = firstChat.id;
          nextThinking = defaultEffortForConfiguredModel(thinkingLevel, firstChat);
        }
      }

      const saved = await persistModelBlock(
        {
          customProviders: nextCustomList,
          defaultProvider: nextDefaultProvider,
          defaultModel: nextDefaultModel,
          ...(nextThinking !== undefined ? { thinkingLevel: nextThinking } : {}),
        },
        { onError: onModalError },
      );
      if (!saved) return;

      // Reuse the committed ID if credential saving fails and the user retries.
      setProviderModal((prev) =>
        prev?.openSeq === providerModal.openSeq
          ? { ...prev, mode: "edit", editingProviderId: targetId }
          : prev,
      );

      if (draft.apiKey) {
        try {
          await kuloRest.setProviderApiKey(targetId, draft.apiKey);
        } catch (err) {
          setProviderModalError(
            err instanceof Error
              ? t(`配置已保存，密钥保存失败：${err.message}`, `Settings saved, but the key could not be saved: ${err.message}`)
              : t("配置已保存，密钥保存失败，请重试", "Settings saved, but the key could not be saved. Please retry."),
          );
          return;
        }
      }
      setProviderModal((prev) => (prev ? { ...prev, open: false } : null));
    } finally {
      providerSaveInFlightRef.current = false;
      setSavingProvider(false);
    }
  };

  const authenticatedSubscriptions = useMemo(
    () =>
      SUBSCRIPTION_PROVIDERS.filter((sub) => {
        const cat = providerCatalogById.get(sub.id);
        return Boolean(cat?.authenticated && cat?.authType === "oauth");
      }),
    [providerCatalogById],
  );

  const handleDeleteCustomProvider = async (cpId: string) => {
    const remaining = customProviders.filter((cp) => cp.id !== cpId);
    const patch: Record<string, unknown> = { customProviders: remaining };
    if (defaultProvider === cpId) {
      patch.defaultProvider = "";
      patch.defaultModel = "";
    }
    const saved = await persistModelBlock(patch);
    if (saved) {
      void kuloRest.logoutProvider(cpId).catch(() => {});
    }
  };

  const handleDeleteGateway = async () => {
    const patch: Record<string, unknown> = {
      gatewayDisabled: true,
      clearApiKey: true,
    };
    if (defaultProvider === "kulo-gateway") {
      patch.defaultProvider = "";
      patch.defaultModel = "";
    }
    const saved = await persistModelBlock(patch);
    if (saved) {
      void kuloRest.logoutProvider("kulo-gateway").catch(() => {});
    }
  };

  const openAddSubscriptionModal = () => {
    const firstAvailable =
      SUBSCRIPTION_PROVIDERS.find((sub) => {
        const cat = providerCatalogById.get(sub.id);
        return !(cat?.authenticated && cat?.authType === "oauth");
      }) ?? SUBSCRIPTION_PROVIDERS[0]!;
    setOauthModal({
      open: true,
      initialProviderId: firstAvailable.id,
      starting: false,
      session: null,
      error: undefined,
    });
  };

  useEffect(() => {
    if (!entryIntent || entryIntent.module !== "models") return;
    if (entryIntent.intent === "add-api") openCreateProviderModal();
    else if (entryIntent.intent === "add-oauth") openAddSubscriptionModal();
    else return;
    onIntentHandled?.(entryIntent.id);
  }, [entryIntent?.id, onIntentHandled]);

  const handleStartOAuthFromModal = async (providerId: string) => {
    if (authBusyId) return;
    setAuthBusyId(providerId);
    setOauthModal((prev) =>
      prev ? { ...prev, starting: true, error: undefined } : prev,
    );
    try {
      const res = await kuloRest.startProviderOAuth(providerId);
      setOauthModal((prev) =>
        prev
          ? { ...prev, starting: false, session: res.session, error: undefined }
          : {
              open: true,
              initialProviderId: providerId,
              starting: false,
              session: res.session,
            },
      );
    } catch (err) {
      const label =
        SUBSCRIPTION_PROVIDERS.find((s) => s.id === providerId)?.label ?? providerId;
      const msg =
        err instanceof Error ? err.message : t(`无法启动 ${label} OAuth 登录`, `Unable to start ${label} OAuth sign-in`);
      setOauthModal((prev) =>
        prev ? { ...prev, starting: false, error: msg } : prev,
      );
    } finally {
      setAuthBusyId(null);
    }
  };

  const handleRefreshProvider = async (providerId: string, signal: AbortSignal): Promise<ProviderModelItem[]> => {
    const configured = new Set((modelBlock.value.subscriptionModels?.[providerId] ?? []).map((model) => model.id));
    if (defaultProvider === providerId && defaultModel) configured.add(defaultModel);
    const provider = providers.find((item) => item.id === providerId);
    if (provider) providerCatalog.updateProvider({
      ...provider, modelCatalogSource: "configured", models: provider.models.filter((model) => configured.has(model.id)),
    });
    try {
      const res = await kuloRest.refreshProviderModels(providerId, { signal });
      return res.provider.models;
    } catch (err) {
      void loadProviders();
      throw err;
    }
  };

  const handleOAuthCompleted = async () => {
    const providerId = oauthModal?.session?.providerId ?? oauthModal?.initialProviderId;
    await loadProviders();
    if (!providerId || modelBlock.value.defaultModel.trim()) return;
    try {
      const { providers: freshProviders } = await kuloRest.listProviders();
      const freshGroups = buildProviderModelGroups(modelBlock.value, freshProviders);
      const firstModel = freshGroups.find((group) => group.providerId === providerId)?.models[0];
      if (firstModel) {
        await persistModelBlock({
          defaultProvider: providerId,
          defaultModel: firstModel.id,
          thinkingLevel: clampModelEffort(thinkingLevel, firstModel),
        });
      }
    } catch {
      // Best-effort auto-selection; providers catalog is already refreshed.
    }
  };

  const handleLogoutProvider = async (providerId: string) => {
    if (authBusyId) return;
    setAuthBusyId(providerId);
    setError(undefined);
    try {
      await kuloRest.logoutProvider(providerId);
      if (defaultProvider === providerId) {
        await persistModelBlock({ defaultProvider: "", defaultModel: "" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("删除订阅接入失败", "Failed to remove subscription"));
    } finally {
      setAuthBusyId(null);
    }
  };

  const confirmDeleteAction = async () => {
    if (!deleteConfirm) return;
    const current = deleteConfirm;
    setDeleteConfirm(null);
    if (current.kind === "gateway") {
      await handleDeleteGateway();
    } else if (current.kind === "custom") {
      await handleDeleteCustomProvider(current.id);
    } else {
      await handleLogoutProvider(current.id);
    }
  };

  const gatewayDisplayName =
    modelBlock.value.gatewayName?.trim() || t("默认兼容网关", "Default compatible gateway");

  const apiConnections: ProviderConnectionItem[] = [
    ...(!modelBlock.value.gatewayDisabled ? [{
      id: "kulo-gateway", name: gatewayDisplayName, protocol: shortApiLabel(modelBlock.value.apiMode),
      modelCount: countConfiguredModelsForProvider(modelBlock.value, "kulo-gateway", providers),
      authenticated: modelBlock.hasApiKey ? true : providerCatalogById.get("kulo-gateway")?.authenticated ?? null,
      action: "编辑" as const, disabled: savingModelBlock || savingProvider,
      onEdit: openEditGatewayModal, onDelete: () => setDeleteConfirm({ kind: "gateway", label: gatewayDisplayName }),
    }] : []),
    ...customProviders.map((provider) => ({
      id: provider.id, name: provider.name || provider.id, protocol: shortApiLabel(provider.api),
      modelCount: countConfiguredModelsForProvider(modelBlock.value, provider.id, providers),
      authenticated: providerCatalogById.get(provider.id)?.authenticated ?? null,
      action: "编辑" as const, disabled: savingModelBlock || savingProvider,
      onEdit: () => openEditCustomProviderModal(provider),
      onDelete: () => setDeleteConfirm({ kind: "custom", id: provider.id, label: provider.name || provider.id }),
    })),
  ];
  const subscriptionConnections: ProviderConnectionItem[] = authenticatedSubscriptions.map((subscription) => ({
    id: subscription.id, name: subscription.label, protocol: t("订阅账号", "Subscription account"),
    modelCount: getModelsForProvider(subscription.id).length,
    authenticated: Boolean(providerCatalogById.get(subscription.id)?.authenticated),
    action: "编辑", disabled: Boolean(authBusyId) || savingModelBlock || savingProvider,
    onEdit: () => openEditSubscriptionModal(subscription.id),
    onDelete: () => setDeleteConfirm({ kind: "oauth", id: subscription.id, label: subscription.label }),
  }));

  return (
    <div className="kulo-settings-stack">
      <section className="kulo-settings-section" aria-labelledby="default-model-heading">
        <div className="kulo-settings-section-head">
          <h2 id="default-model-heading" className="kulo-section-title">{t("默认模型", "Default model")}</h2>
          {savingModelBlock && <Spinner size="sm" aria-label={t("保存中", "Saving")} />}
        </div>

        <SettingsList label={t("默认模型", "Default model")}>
          <ModelSelectionFields
            groups={providerModelGroups}
            providerId={defaultProvider}
            modelId={defaultModel}
            thinkingLevel={thinkingLevel}
            defaults
            layout="settings"
            isDisabled={savingModelBlock || savingProvider}
            isLoading={loadingProviders}
            onProviderChange={(provider) => {
              const firstModel = provider ? getModelsForProvider(provider)[0] : undefined;
              void persistModelBlock(
                firstModel
                  ? { defaultProvider: provider, defaultModel: firstModel.id, thinkingLevel: clampModelEffort(thinkingLevel, firstModel) }
                  : { defaultProvider: provider, defaultModel: "" },
              );
            }}
            onModelChange={handleDefaultModelChange}
            onThinkingChange={handleThinkingChange}
          />
        </SettingsList>
      </section>

      <section className="kulo-settings-section" aria-labelledby="model-connections-heading">
        <div className="kulo-settings-section-head">
          <div className="flex items-center gap-3">
            <h2 id="model-connections-heading" className="kulo-section-title">{t("模型连接", "Model connections")}</h2>
            {loadingProviders && <Spinner size="sm" aria-label={t("加载模型连接", "Loading model connections")} />}
          </div>
          <Dropdown>
            <Button size="sm" variant="secondary" isDisabled={loadingProviders || savingModelBlock || savingProvider || Boolean(authBusyId)}>
              <KuloIcon name="add" size={16} />
              
              {t("添加连接", "Add connection")}
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label={t("添加模型连接", "Add model connection")}
                onAction={(key) => {
                  if (key === "api") openCreateProviderModal();
                  else if (key === "subscription") openAddSubscriptionModal();
                }}
              >
                <Dropdown.Item id="api" textValue={t("API 接入", "API connections")}><Label>{t("API 接入", "API connections")}</Label></Dropdown.Item>
                <Dropdown.Item id="subscription" textValue={t("订阅接入", "Subscriptions")}><Label>{t("订阅接入", "Subscriptions")}</Label></Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>

        <div className="kulo-settings-stack">
          <section className="kulo-settings-group" aria-labelledby="api-connections-heading">
            <h3 id="api-connections-heading" className="kulo-group-title">API</h3>
            <ProviderConnectionTable label={t("API 接入", "API connections")} emptyLabel={t("暂无 API 接入", "No API connections")} items={apiConnections} loading={loadingProviders} />
          </section>

          <section className="kulo-settings-group" aria-labelledby="subscription-connections-heading">
            <h3 id="subscription-connections-heading" className="kulo-group-title">{t("订阅", "Subscription")}</h3>
            {subscriptionConnections.length === 0 ? (
              <p className="kulo-settings-empty" role={loadingProviders ? "status" : undefined}>{loadingProviders ? t("加载订阅连接…", "Loading subscriptions…") : t("暂无订阅接入", "No subscriptions")}</p>
            ) : (
              <ProviderConnectionTable label={t("订阅接入", "Subscriptions")} emptyLabel={t("暂无订阅接入", "No subscriptions")} items={subscriptionConnections} loading={loadingProviders} />
            )}
          </section>
        </div>
      </section>

      <UsageCapsSection />

      {(error || catalogError) && !providerModal?.open && !oauthModal?.open && (
        <Alert status="danger" className="rounded-2xl p-3">
          <Alert.Indicator />
          <Alert.Content className="text-sm">{error || (catalogError instanceof Error ? catalogError.message : t("加载模型连接失败", "Failed to load model connections"))}</Alert.Content>
          {!error && <Button size="sm" variant="ghost" onPress={() => void loadProviders()}>{t("重试", "Retry")}</Button>}
        </Alert>
      )}

      <ApiProviderModal
        state={providerModal}
        saving={savingModelBlock || savingProvider}
        externalError={providerModalError}
        presets={activePresets}
        onClose={() => {
          setProviderModalError(undefined);
          setProviderModal((prev) => (prev ? { ...prev, open: false } : null));
        }}
        onSave={handleSaveProviderModal}
        onDiscoverSubscription={handleRefreshProvider}
      />

      <OAuthSubscriptionModal
        open={Boolean(oauthModal?.open)}
        initialProviderId={oauthModal?.initialProviderId ?? SUBSCRIPTION_PROVIDERS[0]!.id}
        session={oauthModal?.session ?? null}
        starting={Boolean(oauthModal?.starting)}
        externalError={oauthModal?.error}
        onClearError={() =>
          setOauthModal((prev) => (prev ? { ...prev, error: undefined } : null))
        }
        onStart={handleStartOAuthFromModal}
        onUpdate={(session) =>
          setOauthModal((prev) => (prev ? { ...prev, session } : null))
        }
        onResetSession={() => {
          setOauthModal((prev) =>
            prev ? { ...prev, session: null, error: undefined } : null,
          );
        }}
        onCompleted={() => void handleOAuthCompleted()}
        onClose={() => {
          setOauthModal(null);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteConfirm)}
        title={
          deleteConfirm?.kind === "oauth"
            ? t(`移除订阅接入「${deleteConfirm.label}」？`, `Remove subscription “${deleteConfirm.label}”?`)
            : t(`删除 API 接入「${deleteConfirm?.label ?? ""}」？`, `Delete API connection “${deleteConfirm?.label ?? ""}”?`)
        }
        description={
          deleteConfirm?.kind === "oauth"
            ? t(`将清除本地保存的「${deleteConfirm.label}」OAuth 登录凭据；若当前默认模型来自该订阅，将清空默认模型选择。`, `This will clear the locally saved OAuth credentials for “${deleteConfirm.label}”. If the default model uses this subscription, the default model selection will be cleared.`)
            : t(`将移除「${deleteConfirm?.label ?? ""}」及其已保存的 API 密钥配置；此操作不可恢复。`, `This will remove “${deleteConfirm?.label ?? ""}” and its saved API key. This cannot be undone.`)
        }
        confirmLabel={t("确认删除", "Confirm removal")}
        status="danger"
        isPending={savingModelBlock || Boolean(authBusyId)}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => void confirmDeleteAction()}
      />
    </div>
  );
}
