import { useI18n } from "../../moco-i18n";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Tabs,
  TextField,
} from "@heroui/react";
import type {
  CustomModelConfig,
  CustomProviderApi,
  DiscoverModelsRequest,
  ProviderModelItem,
} from "@moco/protocol";
import {
  inferModelPurpose,
  isConversationModel,
  isOfficialVertexBaseUrl,
  normalizeVertexConfig,
} from "@moco/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { mocoRest } from "../../moco-api";
import {
  CUSTOM_API_OPTIONS,
  MAINSTREAM_PRESETS,
  getModelThinkingLevels,
  isOfficialPresetOrigin,
  type MainstreamPresetMeta,
} from "./settings-helpers";
import {
  AddedModelsPane,
  AvailableModelsPane,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  buildManualModelConfig,
  modelConfigFromCatalog,
  type ModelPurposeFilter,
} from "./api-model-list";

export interface ApiProviderModalState {
  open: boolean;
  openSeq: number;
  mode: "create" | "edit" | "gateway" | "subscription";
  editingProviderId?: string;
  providerKind: "preset" | "third-party";
  presetId: string;
  name: string;
  api: CustomProviderApi;
  baseUrl: string;
  vertexProject?: string;
  vertexLocation?: string;
  hasSavedKey: boolean;
  initialModels: CustomModelConfig[];
}

const COMPACT_MODEL_EDITOR_QUERY = "(max-width: 767px)";

function subscribeModelEditorWidth(onChange: () => void) {
  const query = window.matchMedia(COMPACT_MODEL_EDITOR_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isCompactModelEditor() {
  return window.matchMedia(COMPACT_MODEL_EDITOR_QUERY).matches;
}

function canRetainSavedKey(state: Pick<ApiProviderModalState, "hasSavedKey" | "baseUrl"> | null, baseUrl: string): boolean {
  if (!state?.hasSavedKey) return false;
  try {
    return new URL(state.baseUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function shouldAutoDiscoverOnOpen(state: ApiProviderModalState): boolean {
  if (state.mode === "create" || state.mode === "subscription") return false;
  if (state.api === "google-vertex" && isOfficialVertexBaseUrl(state.baseUrl)) return true;
  const trimmedUrl = state.baseUrl.trim();
  if (!trimmedUrl) return false;
  if (state.mode === "gateway") {
    return (
      state.hasSavedKey ||
      trimmedUrl !== "https://api.openai.com/v1" ||
      state.initialModels.length > 0
    );
  }
  return state.hasSavedKey || state.providerKind === "third-party";
}

export function ApiProviderModal({
  state,
  saving,
  externalError,
  presets = MAINSTREAM_PRESETS,
  onClose,
  onSave,
  onDiscoverSubscription,
}: {
  state: ApiProviderModalState | null;
  saving: boolean;
  externalError?: string;
  presets?: readonly Pick<MainstreamPresetMeta, "id" | "name" | "api" | "baseUrl">[];
  onClose: () => void;
  onDiscoverSubscription: (providerId: string, signal: AbortSignal) => Promise<ProviderModelItem[]>;
  onSave: (payload: {
    providerKind: "preset" | "third-party";
    presetId: string;
    name: string;
    api: CustomProviderApi;
    baseUrl: string;
    vertexProject?: string;
    vertexLocation?: string;
    apiKey: string;
    models: CustomModelConfig[];
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const lastStateRef = useRef<ApiProviderModalState | null>(null);
  if (state) {
    lastStateRef.current = state;
  }
  const active = state ?? lastStateRef.current;
  const isOpen = Boolean(state?.open);

  const compactEditor = useSyncExternalStore(
    subscribeModelEditorWidth,
    isCompactModelEditor,
    () => false,
  );
  const [modelPane, setModelPane] = useState<"catalog" | "added">("catalog");
  const [providerKind, setProviderKind] = useState<"preset" | "third-party">(
    active?.providerKind ?? "preset",
  );
  const [presetId, setPresetId] = useState(
    active?.presetId ?? presets[0]?.id ?? MAINSTREAM_PRESETS[0]!.id,
  );
  const [availPurposeFilter, setAvailPurposeFilter] = useState<ModelPurposeFilter>("all");
  const [addedPurposeFilter, setAddedPurposeFilter] = useState<ModelPurposeFilter>("all");
  const [name, setName] = useState(active?.name ?? "");
  const [api, setApi] = useState<CustomProviderApi>(
    active?.api ?? "openai-completions",
  );
  const [baseUrl, setBaseUrl] = useState(active?.baseUrl ?? "");
  const [vertexProject, setVertexProject] = useState(active?.vertexProject ?? "");
  const [vertexLocation, setVertexLocation] = useState(active?.vertexLocation ?? "global");
  const vertexProjectRef = useRef<HTMLInputElement>(null);
  const vertexLocationRef = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState("");
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const [addedModels, setAddedModels] = useState<CustomModelConfig[]>(
    active?.initialModels ?? [],
  );
  const [expandedId, setExpandedId] = useState<string | null>(
    null,
  );
  const [availableModels, setAvailableModels] = useState<ProviderModelItem[]>([]);
  const [hasFetchedOnce, setHasFetchedOnce] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string>();
  const [searchAvail, setSearchAvail] = useState("");
  const [searchAdded, setSearchAdded] = useState("");
  const [manualModelId, setManualModelId] = useState("");
  const [localError, setLocalError] = useState<string>();
  const [pendingSaveError, setPendingSaveError] = useState<string>();
  const [initialDraftSnapshot, setInitialDraftSnapshot] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const discoverSeqRef = useRef(0);
  const discoverAbortRef = useRef<AbortController | null>(null);

  const cancelInFlightDiscover = () => {
    discoverSeqRef.current += 1;
    if (discoverAbortRef.current) {
      discoverAbortRef.current.abort();
      discoverAbortRef.current = null;
    }
    setDiscovering(false);
  };

  const invalidateDiscovery = () => {
    cancelInFlightDiscover();
    setAvailableModels([]);
    setHasFetchedOnce(false);
    setDiscoverError(undefined);
    setSearchAvail("");
    setAvailPurposeFilter("all");
  };

  const runDiscover = async (params: {
    mode: "create" | "edit" | "gateway" | "subscription";
    editingProviderId?: string;
    providerKind: "preset" | "third-party";
    presetId: string;
    api: CustomProviderApi;
    baseUrl: string;
    vertexProject?: string;
    vertexLocation?: string;
    apiKey: string;
    refreshMetadata?: boolean;
  }) => {
    const cleanUrl = params.baseUrl.trim();
    if (params.providerKind === "third-party" && !cleanUrl) {
      setDiscoverError(t("请先填写 BaseURL", "Enter a Base URL first"));
      return;
    }
    if (discoverAbortRef.current) {
      discoverAbortRef.current.abort();
    }
    const seq = ++discoverSeqRef.current;
    const controller = new AbortController();
    discoverAbortRef.current = controller;
    setDiscovering(true);
    setDiscoverError(undefined);
    const officialCatalog = params.api === "google-vertex" && isOfficialVertexBaseUrl(cleanUrl);
    if (officialCatalog) {
      setAvailableModels([]);
      setHasFetchedOnce(false);
    }
    try {
      const req: DiscoverModelsRequest = {
        api: params.api,
        ...(params.mode !== "create" && params.editingProviderId
          ? { providerId: params.editingProviderId }
          : {}),
        ...(params.providerKind === "preset" ? { preset: params.presetId } : {}),
        ...(cleanUrl ? { baseUrl: cleanUrl } : {}),
        ...(!officialCatalog && params.apiKey.trim() ? { apiKey: params.apiKey.trim() } : {}),
        ...(!officialCatalog && params.api === "google-vertex" && params.vertexProject?.trim()
          ? { vertexProject: params.vertexProject.trim(), vertexLocation: params.vertexLocation?.trim() }
          : {}),
        ...(params.refreshMetadata ? { refreshMetadata: true } : {}),
      };
      const res: { ok: boolean; models: ProviderModelItem[]; error?: string } = params.mode === "subscription" && params.editingProviderId
        ? { ok: true, models: await onDiscoverSubscription(params.editingProviderId, controller.signal) }
        : await mocoRest.discoverProviderModels(req, { signal: controller.signal });
      if (seq !== discoverSeqRef.current) return;
      setHasFetchedOnce(true);
      if (res.ok) {
        setAvailableModels(params.mode === "subscription" ? res.models.filter(isConversationModel) : res.models);
      } else {
        setDiscoverError(res.error || t("获取模型列表失败", "Failed to load models"));
      }
    } catch (err) {
      if (seq !== discoverSeqRef.current || controller.signal.aborted) return;
      setHasFetchedOnce(true);
      setDiscoverError(err instanceof Error ? err.message : t("获取模型列表失败", "Failed to load models"));
    } finally {
      if (seq === discoverSeqRef.current) {
        discoverAbortRef.current = null;
        setDiscovering(false);
      }
    }
  };

  useEffect(() => {
    if (!state?.open) {
      setExpandedId(null);
      setDiscardConfirmOpen(false);
      cancelInFlightDiscover();
      return;
    }
    setInitialDraftSnapshot(
      JSON.stringify([
        state.providerKind,
        state.presetId,
        state.name,
        state.api,
        state.baseUrl,
        state.vertexProject ?? "",
        state.vertexLocation ?? "global",
        "",
        state.initialModels,
        "",
      ]),
    );
    setDiscardConfirmOpen(false);
    const initialVisibleModels = state.mode === "subscription" ? state.initialModels.filter(isConversationModel) : state.initialModels;
    setModelPane(initialVisibleModels.length > 0 ? "added" : "catalog");
    setProviderKind(state.providerKind);
    setPresetId(state.presetId);
    setName(state.name);
    setApi(state.api);
    setBaseUrl(state.baseUrl);
    setVertexProject(state.vertexProject ?? "");
    setVertexLocation(state.vertexLocation ?? "global");
    setApiKey("");
    setAddedModels(state.initialModels);
    setExpandedId(null);
    setAvailableModels([]);
    setHasFetchedOnce(false);
    setDiscoverError(undefined);
    setSearchAvail("");
    setSearchAdded("");
    setAvailPurposeFilter("all");
    setAddedPurposeFilter("all");
    setManualModelId("");
    setLocalError(undefined);
    setPendingSaveError(undefined);

    if (shouldAutoDiscoverOnOpen(state)) {
      void runDiscover({
        mode: state.mode,
        editingProviderId: state.editingProviderId,
        providerKind: state.providerKind,
        presetId: state.presetId,
        api: state.api,
        baseUrl: state.baseUrl,
        vertexProject: state.vertexProject,
        vertexLocation: state.vertexLocation,
        apiKey: "",
      });
    } else {
      cancelInFlightDiscover();
    }

    return () => {
      discoverSeqRef.current += 1;
      if (discoverAbortRef.current) {
        discoverAbortRef.current.abort();
        discoverAbortRef.current = null;
      }
    };
  }, [state?.open, state?.openSeq]);

  const isGateway = active?.mode === "gateway";
  const isSubscription = active?.mode === "subscription";
  const isVertex = !isSubscription && api === "google-vertex";
  const retainsSavedKey = canRetainSavedKey(active, baseUrl);
  const officialCatalog = isVertex && isOfficialVertexBaseUrl(baseUrl);
  const officialSource = isSubscription || (providerKind === "preset" && !isGateway && isOfficialPresetOrigin(presetId, baseUrl, presets));
  const activePresetId = providerKind === "preset" && !isGateway ? presetId : undefined;
  const dialogTitle = isSubscription ? t(`${active?.name} 模型`, `${active?.name} models`) : t("API 设置", "API settings");

  const handleKindSwitch = (nextKind: "preset" | "third-party") => {
    invalidateDiscovery();
    setProviderKind(nextKind);
    setLocalError(undefined);
    if (nextKind === "preset") {
      const preset =
        presets.find((p) => p.id === presetId) ?? presets[0] ?? MAINSTREAM_PRESETS[0]!;
      setPresetId(preset.id);
      setName(preset.name);
      setApi(preset.api);
      setBaseUrl(preset.baseUrl);
    }
  };

  const handlePresetChange = (nextPresetId: string) => {
    const preset = presets.find((p) => p.id === nextPresetId);
    if (!preset) return;
    invalidateDiscovery();
    setPresetId(preset.id);
    setName(preset.name);
    setApi(preset.api);
    setBaseUrl(preset.baseUrl);
    setLocalError(undefined);
  };

  const handleApiChange = (nextApi: CustomProviderApi) => {
    invalidateDiscovery();
    setApi(nextApi);
  };

  const handleApiKeyChange = (nextKey: string) => {
    if (!officialCatalog) invalidateDiscovery();
    setApiKey(nextKey);
  };

  const handleBaseUrlChange = (nextUrl: string) => {
    invalidateDiscovery();
    setBaseUrl(nextUrl);
  };

  const handleDiscover = async () => {
    if (discovering || !active) return;
    await runDiscover({
      mode: active.mode,
      editingProviderId: active.editingProviderId,
      providerKind,
      presetId,
      api,
      baseUrl,
      vertexProject,
      vertexLocation,
      apiKey,
      refreshMetadata: true,
    });
  };

  const addManualModel = () => {
    const cleanId = manualModelId.trim();
    if (!cleanId) return;
    if (addedModels.some((m) => m.id === cleanId)) {
      setExpandedId(cleanId);
      setModelPane("added");
      setSearchAdded("");
      setAddedPurposeFilter("all");
      setManualModelId("");
      return;
    }
    const existingCatalogItem = availableModels.find((item) => item.id === cleanId);
    const targetPurpose = isSubscription
      ? "chat"
      : addedPurposeFilter !== "all"
        ? addedPurposeFilter
        : inferModelPurpose({ id: cleanId });
    const entry = existingCatalogItem && (!isSubscription || isConversationModel(existingCatalogItem))
      ? modelConfigFromCatalog(existingCatalogItem, api, { presetId: activePresetId, officialSource })
      : buildManualModelConfig(cleanId, targetPurpose, api, activePresetId);
    const initialSnapshot = JSON.stringify(entry);
    setAddedModels((prev) => [...prev, entry]);
    setSearchAdded("");
    if (addedPurposeFilter !== "all" && addedPurposeFilter !== targetPurpose) {
      setAddedPurposeFilter("all");
    }
    setExpandedId(cleanId);
    setModelPane("added");
    setManualModelId("");
    if (!existingCatalogItem && !isSubscription && active) {
      const targetApi = api;
      const targetPreset = activePresetId;
      const targetOfficial = officialSource;
      const targetProviderId = active.mode !== "create" ? active.editingProviderId : undefined;
      const targetBaseUrl = baseUrl.trim();
      void mocoRest.resolveModelMetadata({
        modelId: cleanId,
        api: targetApi,
        ...(targetProviderId ? { providerId: targetProviderId } : {}),
        ...(targetPreset ? { preset: targetPreset } : {}),
        ...(targetBaseUrl ? { baseUrl: targetBaseUrl } : {}),
      }).then((resolved) => {
        if (!resolved?.model || resolved.model.metadataSource === "default") return;
        const enriched = modelConfigFromCatalog(resolved.model, targetApi, {
          presetId: targetPreset,
          officialSource: targetOfficial,
        });
        setAddedModels((prev) =>
          prev.map((item) => (item.id === cleanId && JSON.stringify(item) === initialSnapshot ? enriched : item)),
        );
      }).catch(() => {
        // Metadata lookup is best-effort; keep manual defaults if offline or unavailable.
      });
    }
  };

  const updateAddedModel = (id: string, patch: Partial<CustomModelConfig>) => {
    setAddedModels((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );
  };

  const removeAddedModel = (id: string) => {
    setAddedModels((prev) => {
      const next = prev.filter((m) => m.id !== id);
      if (expandedId === id) {
        setExpandedId(null);
      }
      return next;
    });
  };

  const filteredAvailable = useMemo(() => {
    const q = searchAvail.trim().toLowerCase();
    return availableModels.filter((m) => {
      if (!isSubscription && availPurposeFilter !== "all" && inferModelPurpose(m) !== availPurposeFilter) {
        return false;
      }
      if (!q) return true;
      return m.id.toLowerCase().includes(q) || Boolean(m.name && m.name.toLowerCase().includes(q));
    });
  }, [availableModels, searchAvail, availPurposeFilter, isSubscription]);

  const baseAddedList = useMemo(
    () => (isSubscription ? addedModels.filter(isConversationModel) : addedModels),
    [addedModels, isSubscription],
  );

  const filteredAdded = useMemo(() => {
    const q = searchAdded.trim().toLowerCase();
    return baseAddedList.filter((m) => {
      if (!isSubscription && addedPurposeFilter !== "all" && inferModelPurpose(m) !== addedPurposeFilter) {
        return false;
      }
      if (!q) return true;
      return m.id.toLowerCase().includes(q) || Boolean(m.name && m.name.toLowerCase().includes(q));
    });
  }, [baseAddedList, searchAdded, addedPurposeFilter, isSubscription]);
  const addedCount = baseAddedList.length;

  const visibleSelectedKeys = useMemo(() => {
    const addedSet = new Set(addedModels.map((m) => m.id));
    return new Set(filteredAvailable.filter((m) => addedSet.has(m.id)).map((m) => m.id));
  }, [addedModels, filteredAvailable]);

  const handleAvailableSelectionChange = (selection: "all" | Set<React.Key>) => {
    const visibleIds = new Set(filteredAvailable.map((m) => m.id));
    const chosenVisible =
      selection === "all"
        ? visibleIds
        : new Set([...selection].map((k) => String(k)));
    const byId = new Map(filteredAvailable.map((m) => [m.id, m]));

    setAddedModels((prev) => {
      const kept = prev.filter((m) => !visibleIds.has(m.id) || chosenVisible.has(m.id));
      const keptSet = new Set(kept.map((m) => m.id));
      const newlyAdded: CustomModelConfig[] = [];
      for (const id of chosenVisible) {
        if (!keptSet.has(id)) {
          const item = byId.get(id);
          if (item) newlyAdded.push(modelConfigFromCatalog(item, api, { presetId: activePresetId, officialSource }));
        }
      }
      return [...kept, ...newlyAdded];
    });
  };

  const submitSave = async () => {
    if (saving) return;
    if ((providerKind === "third-party" || isGateway) && !baseUrl.trim()) {
      setLocalError(t("请填写 BaseURL", "Enter a Base URL"));
      return;
    }
    if (isVertex && !apiKey.trim() && !retainsSavedKey) {
      setLocalError(t("请填写 API Key", "Enter an API key"));
      apiKeyRef.current?.focus();
      return;
    }
    if (isVertex && !vertexProject.trim()) {
      setLocalError(t("请填写 Google Cloud 项目 ID 或项目编号", "Enter a Google Cloud project ID or number"));
      vertexProjectRef.current?.focus();
      return;
    }
    if (isVertex && !vertexLocation.trim()) {
      setLocalError(t("请填写 Vertex AI 区域", "Enter a Vertex AI region"));
      vertexLocationRef.current?.focus();
      return;
    }
    let vertexConfig: ReturnType<typeof normalizeVertexConfig>;
    try {
      vertexConfig = isVertex ? normalizeVertexConfig({ vertexProject, vertexLocation }) : undefined;
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t("Vertex AI 项目或区域格式不正确", "Invalid Vertex AI project or region"));
      return;
    }
    const models = addedModels.map((model): CustomModelConfig => {
      if (!isConversationModel(model)) {
        return { ...model };
      }
      return {
        ...model,
        contextWindow: model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
        maxTokens: model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
        thinkingLevels: getModelThinkingLevels(model, api).map((level) => ({
          ...level, label: level.label.trim(), value: level.value.trim(),
        })),
      };
    });
    for (const model of models) {
      if (!isConversationModel(model) || !model.thinkingLevels) continue;
      if (model.thinkingLevels.some((level) => !level.label || !level.value)) {
        setLocalError(t("请填写 ", "Complete the ") + model.id + t(" 的思考强度显示名称和映射值", " thinking level labels and mapped values"));
        return;
      }
      if (new Set(model.thinkingLevels.map((level) => level.label)).size !== model.thinkingLevels.length) {
        setLocalError(model.id + t(" 的思考强度显示名称不能重复", " thinking level labels must be unique"));
        return;
      }
    }
    const cleanName =
      name.trim() || (providerKind === "preset" ? presetId : t("自定义 API", "Custom API"));
    setPendingSaveError(localError || externalError);
    setLocalError(undefined);
    await onSave({
      providerKind,
      presetId,
      name: cleanName,
      api,
      baseUrl: baseUrl.trim(),
      ...vertexConfig,
      apiKey: apiKey.trim(),
      models,
    });
  };

  const dirty =
    initialDraftSnapshot !== null &&
    initialDraftSnapshot !==
      JSON.stringify([
        providerKind,
        presetId,
        name,
        api,
        baseUrl,
        vertexProject,
        vertexLocation,
        apiKey,
        addedModels,
        manualModelId.trim(),
      ]);

  useEffect(() => {
    if (!isOpen || !dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isOpen, dirty]);

  const requestClose = () => {
    if (saving) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
    } else {
      onClose();
    }
  };


  const availablePane = (
    <AvailableModelsPane
      officialCatalog={officialCatalog}
      compact={compactEditor}
      models={filteredAvailable}
      total={availableModels.length}
      selectedKeys={visibleSelectedKeys}
      loading={discovering}
      error={discoverError}
      hasFetched={hasFetchedOnce}
      search={searchAvail}
      onSearch={setSearchAvail}
      disabled={false}
      onDiscover={() => void handleDiscover()}
      onSelectionChange={handleAvailableSelectionChange}
      purposeFilter={isSubscription ? undefined : availPurposeFilter}
      onPurposeFilterChange={isSubscription ? undefined : setAvailPurposeFilter}
    />
  );

  const addedPane = (
    <AddedModelsPane
      compact={compactEditor}
      models={filteredAdded}
      allAddedModels={baseAddedList}
      total={addedCount}
      availableModels={availableModels}
      api={api}
      expandedId={expandedId}
      onExpandedChange={(id) => {
        setExpandedId(id);
        if (id) setModelPane("added");
      }}
      search={searchAdded}
      onSearch={setSearchAdded}
      disabled={false}
      manualModelId={manualModelId}
      onManualModelIdChange={setManualModelId}
      onAddManual={addManualModel}
      onUpdate={updateAddedModel}
      onRemove={removeAddedModel}
      purposeFilter={isSubscription ? undefined : addedPurposeFilter}
      onPurposeFilterChange={isSubscription ? undefined : setAddedPurposeFilter}
      allowPurposeChange={!isSubscription}
      allowProtocolSelect={providerKind === "third-party" || isGateway}
      officialSource={officialSource}
      presetId={activePresetId}
    />
  );

  const visibleError = localError || externalError || (saving ? pendingSaveError : undefined);

  return (
    <>
      <Modal
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <Modal.Backdrop
          isOpen={isOpen}
          isDismissable={!saving && !discardConfirmOpen}
          isKeyboardDismissDisabled={saving || discardConfirmOpen}
          onOpenChange={(open) => {
            if (!open) requestClose();
          }}
        >
          <Modal.Container placement="center" size="lg" scroll="inside" className="w-full">
            <Modal.Dialog aria-label={dialogTitle} className="w-full max-w-[1120px] rounded-3xl">
              <Modal.Header inert={saving} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <Modal.Heading className="font-semibold">
                  {dialogTitle}
                </Modal.Heading>
                <Modal.CloseTrigger aria-label={t("关闭", "Close")} className="static col-start-2 row-start-1 sm:col-start-3" />
                {!isGateway && !isSubscription && (
                  <Tabs
                    selectedKey={providerKind}
                    onSelectionChange={(k) =>
                      handleKindSwitch(k as "preset" | "third-party")
                    }
                    className="col-span-2 row-start-2 min-w-0 w-full sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:w-auto"
                  >
                    <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0">
                      <Tabs.List aria-label={t("接入方式", "Connection type")} className="w-max">
                        <Tabs.Tab id="preset" className="w-auto shrink-0 whitespace-nowrap px-3">
                          
                          {t("主流厂商", "Providers")}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="third-party" className="w-auto shrink-0 whitespace-nowrap px-3">
                          
                          {t("第三方 API", "Third-party API")}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      </Tabs.List>
                    </Tabs.ListContainer>
                  </Tabs>
                )}
              </Modal.Header>

              <Modal.Body className="moco-form-stack">
                <div inert={saving} className="contents">
                {!isSubscription && <div className="moco-form-grid">
                  {providerKind === "preset" && !isGateway ? (
                    <Select className="moco-form-field"
                      variant="secondary"
                      value={presetId}
                      onChange={(val) => val && handlePresetChange(String(val))}
                      fullWidth
                    >
                      <Label className="text-sm font-medium text-muted">{t("厂商", "Provider")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {presets.map((p) => (
                            <ListBox.Item key={p.id} id={p.id} textValue={p.name}>
                              {p.name}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  ) : (
                    <TextField className="moco-form-field" variant="secondary" value={name} onChange={setName} fullWidth>
                      <Label className="text-sm font-medium text-muted">{t("名称", "Name")}</Label>
                      <Input />
                    </TextField>
                  )}

                  <TextField className="moco-form-field"
                    variant="secondary"
                    isRequired={isVertex && !retainsSavedKey}
                    type="password"
                    value={apiKey}
                    onChange={handleApiKeyChange}
                    fullWidth
                  >
                    <Label className="text-sm font-medium text-muted">API Key</Label>
                    <Input ref={apiKeyRef} autoComplete="off" placeholder={retainsSavedKey ? "••••••••" : t("输入 API Key", "Enter an API key")} />
                  </TextField>
                </div>}

                {(providerKind === "third-party" || isGateway) && (
                  <div className="moco-form-grid">
                    <Select className="moco-form-field"
                      variant="secondary"
                      value={api}
                      onChange={(val) =>
                        val && handleApiChange(val as CustomProviderApi)
                      }
                      fullWidth
                    >
                      <Label className="text-sm font-medium text-muted">{t("API 格式", "API format")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {CUSTOM_API_OPTIONS.map((o) => (
                            <ListBox.Item
                              key={o.value}
                              id={o.value}
                              textValue={o.label}
                            >
                              {o.label}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>

                    <TextField className="moco-form-field"
                      variant="secondary"
                      type="url"
                      value={baseUrl}
                      onChange={handleBaseUrlChange}
                      fullWidth
                    >
                      <Label className="text-sm font-medium text-muted">BaseURL</Label>
                      <Input placeholder="https://api.example.com/v1" />
                    </TextField>
                  </div>
                )}

                {isVertex && (
                  <div className="moco-form-grid">
                    <TextField className="moco-form-field"
                      variant="secondary"
                      value={vertexProject}
                      onChange={(value) => {
                        if (!officialCatalog) invalidateDiscovery();
                        setVertexProject(value);
                        setLocalError(undefined);
                      }}
                      isRequired
                      fullWidth
                    >
                      <Label className="text-sm font-medium text-muted">{t("项目 ID / 项目编号", "Project ID / number")}</Label>
                      <Input ref={vertexProjectRef} autoComplete="off" spellCheck={false} placeholder="my-project-123456" />
                    </TextField>
                    <TextField className="moco-form-field"
                      variant="secondary"
                      value={vertexLocation}
                      onChange={(value) => {
                        if (!officialCatalog) invalidateDiscovery();
                        setVertexLocation(value);
                        setLocalError(undefined);
                      }}
                      isRequired
                      fullWidth
                    >
                      <Label className="text-sm font-medium text-muted">{t("区域", "Region")}</Label>
                      <Input ref={vertexLocationRef} autoComplete="off" spellCheck={false} placeholder="global" />
                    </TextField>
                  </div>
                )}

                {compactEditor ? (
                  <Tabs
                    selectedKey={modelPane}
                    onSelectionChange={(key) => setModelPane(key as "catalog" | "added")}
                    className="w-full"
                  >
                    <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0">
                      <Tabs.List aria-label={t("模型管理", "Manage models")} className="w-max">
                        <Tabs.Tab id="catalog" className="w-auto shrink-0 whitespace-nowrap">
                          
                          {t("模型目录", "Model catalog")}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="added" className="w-auto shrink-0 whitespace-nowrap">
                          
                          {t("已添加", "Added")} {addedCount}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      </Tabs.List>
                    </Tabs.ListContainer>
                    <Tabs.Panel id="catalog" className="pt-3">{availablePane}</Tabs.Panel>
                    <Tabs.Panel id="added" className="pt-3">{addedPane}</Tabs.Panel>
                  </Tabs>
                ) : (
                  <div className="moco-api-model-grid">{availablePane}{addedPane}</div>
                )}

                </div>
                {visibleError && (
                  <Alert role="alert" status="danger" className="rounded-xl p-3">
                    <Alert.Indicator />
                    <Alert.Content className="text-xs">
                      {visibleError}
                    </Alert.Content>
                  </Alert>
                )}
              </Modal.Body>

              <Modal.Footer className="flex items-center justify-end gap-2">
                <div inert={saving} className="contents"><Button variant="ghost" onPress={requestClose}>
                  
                  {t("取消", "Cancel")}
                </Button></div>
                <Button
                  variant="primary"
                  className="min-w-28"
                  isPending={saving}
                  isDisabled={saving}
                  onPress={() => void submitSave()}
                >
                  {saving ? t("保存中…", "Saving…") : t("保存", "Save")}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      <ConfirmDialog
        open={isOpen && discardConfirmOpen}
        title={t("放弃 API 修改？", "Discard API changes?")}
        confirmLabel={t("放弃修改", "Discard changes")}
        cancelLabel={t("继续编辑", "Keep editing")}
        status="warning"
        isPending={saving}
        onCancel={() => setDiscardConfirmOpen(false)}
        onConfirm={() => {
          if (saving) return;
          setDiscardConfirmOpen(false);
          onClose();
        }}
      />
    </>
  );
}
