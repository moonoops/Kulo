import { useEffect, useRef, useState } from "react";
import { Button, Card, Checkbox, Chip, Input, Label, ListBox, NumberField, Select, Table, TextField } from "@heroui/react";
import { redactSensitiveText, type CustomModelConfig, type CustomProviderApi, type ModelConfigurationApi, type ModelConfigurationDraft, type ModelConfigurationSaveResult, type ModelConfigurationWorkspace, type ModelModality } from "@moco/protocol";
import { useI18n } from "../../moco-i18n";
import { CUSTOM_API_OPTIONS } from "./settings-helpers";
import { modelConfigurationApi } from "./model-configuration-api";
import { MocoApiError } from "../../moco-api";

export interface ModelConfigurationCardProps {
  api?: ModelConfigurationApi;
  clientId: string;
  connected: boolean;
  disabled?: boolean;
  onChanged?: () => void;
  onClose?: () => void;
  initialAction?: "connect" | "calibrate" | "diagnose";
  refreshKey?: string | number;
}
const commandId = (action: string) => `model-${action}-${crypto.randomUUID()}`;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const modalities: ModelModality[] = ["text", "image", "audio", "video", "pdf"];
export function modelCredentialScope(draft: Pick<ModelConfigurationDraft, "id" | "provider">): string | undefined {
  try { const url = new URL(draft.provider.baseUrl); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? `${draft.id}:${url.origin}` : undefined; }
  catch { return undefined; }
}
export function canUseModelCredential(scope: string | undefined, draft: Pick<ModelConfigurationDraft, "id" | "provider">): boolean { return Boolean(scope && scope === modelCredentialScope(draft)); }
type SaveEnvelope = Parameters<ModelConfigurationApi["save"]>[0];
const receiptKey = (clientId: string) => `moco:model-configuration-save:${clientId}`;
export function readModelSaveEnvelope(clientId: string): SaveEnvelope | undefined {
  if (typeof sessionStorage === "undefined") return undefined;
  let raw: string | null;
  try { raw = sessionStorage.getItem(receiptKey(clientId)); }
  catch (cause) { if (cause instanceof DOMException && cause.name === "SecurityError") return undefined; throw cause; }
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as SaveEnvelope;
    return value?.clientId === clientId && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision > 0 && typeof value.commandId === "string" && /^[A-Za-z0-9._:-]{1,180}$/.test(value.commandId) ? value : undefined;
  } catch (cause) { if (cause instanceof SyntaxError) return undefined; throw cause; }
}
function storeSaveEnvelope(clientId: string, value?: SaveEnvelope): void {
  if (typeof sessionStorage === "undefined") return;
  try { if (value) sessionStorage.setItem(receiptKey(clientId), JSON.stringify(value)); else sessionStorage.removeItem(receiptKey(clientId)); }
  catch (cause) { if (cause instanceof DOMException && ["SecurityError", "QuotaExceededError"].includes(cause.name)) return; throw cause; }
}

export function ModelConfigurationCard(props: ModelConfigurationCardProps) {
  return <OwnedModelConfigurationCard key={`${props.clientId}:${props.initialAction ?? "connect"}`} {...props} />;
}

function OwnedModelConfigurationCard({ api = modelConfigurationApi, clientId, connected, disabled = false, onChanged, onClose, initialAction = "connect", refreshKey }: ModelConfigurationCardProps) {
  const { t } = useI18n();
  const [workspace, setWorkspace] = useState<ModelConfigurationWorkspace>();
  const [draft, setDraft] = useState<ModelConfigurationDraft>();
  const [selectedProvider, setSelectedProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [manualId, setManualId] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [saved, setSaved] = useState<ModelConfigurationSaveResult>();
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [saveUnconfirmed, setSaveUnconfirmed] = useState(() => Boolean(readModelSaveEnvelope(clientId)));
  const mounted = useRef(true);
  const pending = useRef(false);
  const clean = useRef<ModelConfigurationDraft | undefined>(undefined);
  const latest = useRef(draft); latest.current = draft;
  const request = useRef<AbortController | undefined>(undefined);
  const loaded = useRef(false);
  const pendingSave = useRef<SaveEnvelope | undefined>(readModelSaveEnvelope(clientId));
  const credentialScope = useRef<string | undefined>(undefined);
  const credentialValue = useRef(apiKey); credentialValue.current = apiKey;
  const dirty = Boolean(draft && clean.current && !same({ provider: draft.provider, selectedModelIds: draft.selectedModelIds, defaultModelId: draft.defaultModelId }, { provider: clean.current.provider, selectedModelIds: clean.current.selectedModelIds, defaultModelId: clean.current.defaultModelId }));
  const actionBlocked = disabled || !connected || Boolean(busy);
  const blocked = actionBlocked || saveUnconfirmed;

  const clearCredential = () => { credentialScope.current = undefined; credentialValue.current = ""; setApiKey(""); };
  const install = (next: ModelConfigurationDraft | undefined) => {
    if (credentialValue.current && (!next || !canUseModelCredential(credentialScope.current, next))) { clearCredential(); setError(t("接口或草稿已变化，请为新连接重新提供 API Key。", "The endpoint or draft changed. Provide the API key again for this connection.")); }
    clean.current = next; setDraft(next); setRemoteChanged(false);
  };
  const message = (cause: unknown) => redactSensitiveText(cause instanceof Error ? cause.message : t("模型操作失败，请重试。", "Model action failed. Please retry."));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (!connected || !clientId) return;
    const controller = new AbortController();
    void api.workspace(clientId, controller.signal).then((next) => {
      if (!mounted.current || controller.signal.aborted) return;
      setWorkspace(next);
      if (pendingSave.current) { loaded.current = true; return; }
      if (pending.current) return;
      const local = latest.current;
      if (local && clean.current && !same(local, clean.current) && next.draft?.revision !== clean.current.revision) { setRemoteChanged(true); return; }
      if (!local || !next.draft || next.draft.revision !== local.revision) install(next.draft);
      loaded.current = true;
    }).catch((cause) => { if (!controller.signal.aborted && mounted.current) setError(message(cause)); });
    return () => controller.abort();
  }, [api, clientId, connected, refreshKey]);

  const run = async (action: string, work: () => Promise<void>) => {
    if (pending.current || !connected || disabled) return;
    pending.current = true; request.current = undefined; setBusy(action); setError(undefined);
    try { await work(); }
    catch (cause) { if (mounted.current && !(cause instanceof Error && cause.name === "AbortError")) setError(message(cause)); }
    finally { pending.current = false; if (mounted.current) { setBusy(undefined); onChanged?.(); } }
  };
  const synchronize = async (): Promise<ModelConfigurationDraft> => {
    if (!draft) throw new Error(t("模型草稿尚未载入。", "Model draft has not loaded."));
    let next = draft;
    if (dirty) next = await api.update({ clientId, expectedRevision: draft.revision, provider: draft.provider, selectedModelIds: draft.selectedModelIds, defaultModelId: draft.defaultModelId });
    if (apiKey.trim()) {
      if (!canUseModelCredential(credentialScope.current, next)) { clearCredential(); throw new Error(t("接口或草稿已变化，请重新提供 API Key。", "The endpoint or draft changed. Provide the API key again.")); }
      next = await api.credential({ clientId, expectedRevision: next.revision, apiKey: apiKey.trim() }); if (mounted.current) clearCredential();
    }
    if (mounted.current) install(next);
    return next;
  };
  const prepare = () => run("prepare", async () => {
    const next = await api.prepare({ clientId, ...(initialAction !== "connect" && selectedProvider ? { providerId: selectedProvider } : {}) });
    if (mounted.current) { install(next); setSaved(undefined); }
  });
  useEffect(() => {
    if (loaded.current && !draft && !saved && !saveUnconfirmed && initialAction === "connect" && connected && !disabled && !pending.current) void prepare();
  }, [workspace, draft, saved, saveUnconfirmed, initialAction, connected, disabled]);
  const updateModel = (id: string, patch: Partial<CustomModelConfig>) => setDraft((current) => current ? { ...current, provider: { ...current.provider, models: current.provider.models.map((model) => model.id === id ? { ...model, ...patch } : model) } } : current);
  const selectModel = (id: string, selected: boolean) => setDraft((current) => current ? { ...current, selectedModelIds: selected ? [...new Set([...current.selectedModelIds, id])] : current.selectedModelIds.filter((item) => item !== id), defaultModelId: !selected && current.defaultModelId === id ? undefined : current.defaultModelId } : current);
  const selectedIds = new Set(draft?.selectedModelIds ?? []);
  const filtered = (draft?.provider.models ?? []).filter((model) => `${model.name ?? ""} ${model.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const canRead = Boolean(draft?.provider.baseUrl.trim());
  const readModels = () => run("discover", async () => {
    const current = await synchronize();
    const next = await api.discover({ clientId, expectedRevision: current.revision });
    if (mounted.current) install(next);
  });
  const testModel = (modelId: string) => run(`test:${modelId}`, async () => {
    const current = await synchronize(); request.current = new AbortController();
    const result = await api.test({ clientId, expectedRevision: current.revision, modelId, commandId: commandId("test") }, request.current.signal);
    if (mounted.current) install(result.draft);
  });
  const save = () => run("save", async () => {
    let envelope = pendingSave.current;
    if (!envelope) { const current = await synchronize(); envelope = { clientId, expectedRevision: current.revision, commandId: commandId("save") }; pendingSave.current = envelope; storeSaveEnvelope(clientId, envelope); if (mounted.current) setSaveUnconfirmed(true); }
    let result: ModelConfigurationSaveResult;
    try { result = await api.save(envelope); }
    catch (cause) {
      if (cause instanceof MocoApiError && cause.status < 500 && cause.code !== "model_configuration_save_failed") { pendingSave.current = undefined; storeSaveEnvelope(clientId); if (mounted.current) setSaveUnconfirmed(false); }
      throw cause;
    }
    pendingSave.current = undefined; storeSaveEnvelope(clientId);
    if (mounted.current) { setSaveUnconfirmed(false); setSaved(result); clearCredential(); install(undefined); }
  });
  const cancel = () => run("discard", async () => {
    if (draft) await api.discard({ clientId, expectedRevision: draft.revision });
    if (mounted.current) { install(undefined); setApiKey(""); onClose?.(); }
  });
  return <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-4" aria-label={t("模型自动配置", "Automatic model configuration")}>
    <Card.Header><Card.Title className="text-sm">{saved ? t("模型配置已保存", "Model configuration saved") : initialAction === "calibrate" ? t("校准模型配置", "Calibrate model configuration") : initialAction === "diagnose" ? t("排查模型调用", "Diagnose model calls") : t("自动接入供应商", "Connect a provider")}</Card.Title></Card.Header>
    <Card.Content className="flex min-w-0 flex-col gap-3">
      {saved && <div role="status" className="flex flex-col gap-2 text-sm"><span>{saved.modelIds.join("、")}</span>{saved.defaultModelId && <span>{t("默认模型：", "Default model: ")}{saved.defaultModelId}</span>}</div>}
      {!draft && !saved && !saveUnconfirmed && initialAction !== "connect" && <div className="moco-form-stack">
        <Select className="moco-form-field" variant="primary" value={selectedProvider || null} onChange={(key) => setSelectedProvider(String(key ?? ""))} isDisabled={blocked}>
          <Label>{t("选择 API 连接", "Choose an API connection")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox>{workspace?.providers.filter((provider) => provider.authType !== "oauth").map((provider) => <ListBox.Item key={provider.id} id={provider.id} textValue={provider.name}>{provider.name}</ListBox.Item>)}</ListBox></Select.Popover>
        </Select>
        <Button variant="secondary" size="sm" isDisabled={blocked || !selectedProvider} isPending={busy === "prepare"} onPress={() => void prepare()}>{t("读取连接配置", "Read connection configuration")}</Button>
      </div>}
      {draft && <>
        <div className="moco-form-stack">
          {!draft.existingProvider && Boolean(workspace?.presets?.length) && <Select className="moco-form-field" variant="primary" value={draft.provider.preset ?? "custom"} onChange={(key) => {
            const preset = workspace?.presets?.find((item) => item.id === key); clearCredential();
            setDraft({ ...draft, hasCredential: false, selectedModelIds: [], defaultModelId: undefined, candidates: [], verifications: [], provider: { ...draft.provider, preset: preset?.id, ...(preset ? { name: preset.name, api: preset.api, baseUrl: preset.baseUrl } : {}), models: [] } });
          }} isDisabled={blocked}><Label>{t("供应商", "Provider")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox><ListBox.Item id="custom" textValue={t("自定义接口", "Custom endpoint")}>{t("自定义接口", "Custom endpoint")}</ListBox.Item>{workspace?.presets?.map((preset) => <ListBox.Item key={preset.id} id={preset.id} textValue={preset.name}>{preset.name}</ListBox.Item>)}</ListBox></Select.Popover></Select>}
          <TextField className="moco-form-field" variant="primary" value={draft.provider.name} onChange={(name) => setDraft({ ...draft, provider: { ...draft.provider, name } })} isDisabled={blocked}><Label>{t("供应商名称", "Provider name")}</Label><Input /></TextField>
          <TextField className="moco-form-field" variant="primary" value={draft.provider.baseUrl} onChange={(baseUrl) => { setDraft({ ...draft, provider: { ...draft.provider, baseUrl } }); clearCredential(); }} isDisabled={blocked}><Label>{t("接口地址", "API URL")}</Label><Input type="url" autoComplete="off" spellCheck={false} placeholder="https://" /></TextField>
          <Select className="moco-form-field" variant="primary" value={draft.provider.api} onChange={(key) => setDraft({ ...draft, provider: { ...draft.provider, api: String(key) as CustomProviderApi } })} isDisabled={blocked}>
            <Label>{t("接口协议", "API protocol")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox>{CUSTOM_API_OPTIONS.map((option) => <ListBox.Item key={option.value} id={option.value} textValue={option.label}>{option.label}</ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
          <TextField className="moco-form-field" variant="primary" type="password" value={apiKey} onChange={(value) => { credentialScope.current = modelCredentialScope(draft); credentialValue.current = value; setApiKey(value); }} isDisabled={blocked || !modelCredentialScope(draft)}><Label>API Key</Label><Input autoComplete="new-password" spellCheck={false} placeholder={draft.hasCredential ? t("已提供，留空保留", "Provided; leave blank to keep") : t("通过保密输入提供", "Enter securely")} /></TextField>
          {draft.provider.api === "google-vertex" && <>
            <TextField className="moco-form-field" variant="primary" value={draft.provider.vertexProject ?? ""} onChange={(vertexProject) => setDraft({ ...draft, provider: { ...draft.provider, vertexProject } })} isDisabled={blocked}><Label>Project ID</Label><Input spellCheck={false} /></TextField>
            <TextField className="moco-form-field" variant="primary" value={draft.provider.vertexLocation ?? "global"} onChange={(vertexLocation) => setDraft({ ...draft, provider: { ...draft.provider, vertexLocation } })} isDisabled={blocked}><Label>{t("区域", "Region")}</Label><Input spellCheck={false} /></TextField>
          </>}
          <Button size="sm" variant="secondary" isDisabled={blocked || !canRead || remoteChanged} isPending={busy === "discover"} onPress={() => void readModels()}>{t("读取模型并生成配置", "Read models and prepare configuration")}</Button>
        </div>
        {draft.provider.models.length > 0 && <>
          <TextField className="moco-context-field" variant="primary" value={query} onChange={setQuery} isDisabled={blocked}><Label className="sr-only">{t("搜索模型", "Search models")}</Label><Input type="search" placeholder={t("搜索模型", "Search models")} /></TextField>
          <Table variant="secondary"><Table.ScrollContainer className="scrollbar"><Table.Content aria-label={t("选择并校准模型", "Select and calibrate models")} className="min-w-[760px]">
            <Table.Header><Table.Column>{t("添加", "Add")}</Table.Column><Table.Column isRowHeader>{t("模型", "Model")}</Table.Column><Table.Column>{t("上下文", "Context")}</Table.Column><Table.Column>{t("最大输出", "Max output")}</Table.Column><Table.Column>{t("能力与验证", "Capabilities and verification")}</Table.Column><Table.Column>{t("操作", "Actions")}</Table.Column></Table.Header>
            <Table.Body>{filtered.map((model) => {
              const candidate = draft.candidates.find((item) => item.model.id === model.id);
              const verification = !dirty ? draft.verifications.find((item) => item.modelId === model.id) : undefined;
              return <Table.Row key={model.id} id={model.id}>
                <Table.Cell><Checkbox variant="primary" aria-label={t(`添加 ${model.id}`, `Add ${model.id}`)} isSelected={selectedIds.has(model.id)} isDisabled={blocked} onChange={(checked) => selectModel(model.id, checked)}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control></Checkbox.Content></Checkbox></Table.Cell>
                <Table.Cell><span className="moco-item-title">{model.name ?? model.id}</span><span className="moco-item-description block">{model.id}</span><span className="text-xs text-muted">{candidate?.evidence === "catalog" ? t("目录参考 · 未验证", "Catalog reference · unverified") : candidate?.evidence === "configured" ? t("当前配置 · 未验证", "Current configuration · unverified") : t("自定参数 · 未验证", "Custom parameters · unverified")}</span></Table.Cell>
                <Table.Cell><NumberField className="moco-context-field" variant="primary" aria-label={t(`${model.id} 上下文`, `${model.id} context`)} minValue={1} maxValue={10000000} value={model.contextWindow ?? NaN} isDisabled={blocked} onChange={(contextWindow) => updateModel(model.id, { contextWindow: Number.isFinite(contextWindow) ? contextWindow : undefined })}><NumberField.Group><NumberField.Input /></NumberField.Group></NumberField></Table.Cell>
                <Table.Cell><NumberField className="moco-context-field" variant="primary" aria-label={t(`${model.id} 最大输出`, `${model.id} max output`)} minValue={1} maxValue={10000000} value={model.maxTokens ?? NaN} isDisabled={blocked} onChange={(maxTokens) => updateModel(model.id, { maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined })}><NumberField.Group><NumberField.Input /></NumberField.Group></NumberField></Table.Cell>
                <Table.Cell><div className="flex flex-col gap-2"><div className="flex flex-wrap gap-1">{modalities.map((modality) => <Button key={modality} size="sm" variant={(model.modalities ?? ["text"]).includes(modality) ? "secondary" : "ghost"} aria-label={`${model.id} ${modality}`} aria-pressed={(model.modalities ?? ["text"]).includes(modality)} isDisabled={blocked} onPress={() => { const next = (model.modalities ?? ["text"]).includes(modality) ? (model.modalities ?? ["text"]).filter((item) => item !== modality) : [...(model.modalities ?? ["text"]), modality]; if (next.length) updateModel(model.id, { modalities: next, vision: next.includes("image") }); }}>{modality}</Button>)}</div><Chip size="sm" color={verification?.ok ? "success" : verification ? "danger" : "default"} variant="soft">{verification ? verification.ok ? t("文本调用通过", "Text call passed") : t("文本调用失败", "Text call failed") : t("文本尚未测试", "Text not tested")}</Chip>{verification?.error && <span className="text-xs text-danger" role="status">{verification.error}</span>}</div></Table.Cell>
                <Table.Cell><div className="flex flex-col items-start gap-2"><Button size="sm" variant="secondary" aria-label={t(`测试 ${model.id} 文本调用一次`, `Test ${model.id} with one text call`)} isDisabled={blocked || !selectedIds.has(model.id) || remoteChanged} isPending={busy === `test:${model.id}`} onPress={() => void testModel(model.id)}>{t("测试文本（1 次）", "Test text (1 call)")}</Button>{candidate?.catalogModel && !same(candidate.catalogModel, model) && <Button size="sm" variant="ghost" aria-label={t(`${model.id} 采用目录参考参数`, `Use catalog reference for ${model.id}`)} isDisabled={blocked} onPress={() => updateModel(model.id, candidate.catalogModel!)}>{t("采用目录参数", "Use catalog values")}</Button>}</div></Table.Cell>
              </Table.Row>;
            })}</Table.Body>
          </Table.Content></Table.ScrollContainer></Table>
          <Select className="moco-form-field" variant="primary" value={draft.defaultModelId ?? -1} onChange={(key) => setDraft({ ...draft, defaultModelId: key === -1 ? undefined : String(key) })} isDisabled={blocked}>
            <Label>{t("默认模型", "Default model")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox><ListBox.Item id={-1} textValue={t("保留当前默认模型", "Keep current default model")}>{t("保留当前默认模型", "Keep current default model")}</ListBox.Item>{draft.provider.models.filter((model) => selectedIds.has(model.id)).map((model) => <ListBox.Item key={model.id} id={model.id} textValue={model.name ?? model.id}>{model.name ?? model.id}</ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
        </>}
        <div className="moco-field-action-row"><TextField className="moco-form-field flex-1" variant="primary" value={manualId} onChange={setManualId} isDisabled={blocked}><Label>{t("补充模型 ID", "Add a model ID")}</Label><Input spellCheck={false} /></TextField><Button className="self-end" size="sm" variant="secondary" isDisabled={blocked || !manualId.trim() || draft.provider.models.some((model) => model.id === manualId.trim())} onPress={() => { const id = manualId.trim(); setDraft({ ...draft, provider: { ...draft.provider, models: [...draft.provider.models, { id, name: id, modalities: ["text"] }] }, selectedModelIds: [...draft.selectedModelIds, id] }); setManualId(""); }}>{t("添加", "Add")}</Button></div>
      </>}
      {remoteChanged && <div role="alert" className="flex flex-col gap-2 text-xs text-warning"><span>{t("配置草稿已在其他操作中更新。", "This draft was updated by another action.")}</span><Button size="sm" variant="secondary" isDisabled={blocked} onPress={() => void run("reload", async () => { const next = await api.workspace(clientId); if (mounted.current) { setWorkspace(next); install(next.draft); } })}>{t("载入最新草稿", "Load latest draft")}</Button></div>}
      {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
      {saveUnconfirmed && busy !== "save" && <p className="text-xs text-muted" role="status">{t("保存结果尚未确认，请重试确认同一次保存。", "The save result is unconfirmed. Retry the same save.")}</p>}
    </Card.Content>
    <Card.Footer className="flex-wrap justify-end gap-2">
      {busy?.startsWith("test:") && <Button size="sm" variant="secondary" onPress={() => { request.current?.abort(); }}>{t("取消测试", "Cancel test")}</Button>}
      {draft && <Button size="sm" variant="tertiary" isDisabled={blocked} onPress={() => void cancel()}>{t("取消配置", "Cancel configuration")}</Button>}
      {onClose && <Button size="sm" variant="ghost" isDisabled={Boolean(busy)} onPress={onClose}>{saved ? t("完成", "Done") : t("稍后继续", "Continue later")}</Button>}
      {(draft || saveUnconfirmed) && <Button size="sm" variant="primary" isPending={busy === "save"} isDisabled={actionBlocked || !saveUnconfirmed && (!draft?.selectedModelIds.length || !canRead || remoteChanged)} onPress={() => void save()}>{saveUnconfirmed ? t("重试确认保存", "Retry save confirmation") : t(`确认保存（${draft?.selectedModelIds.length ?? 0} 个模型）`, `Save configuration (${draft?.selectedModelIds.length ?? 0} models)`)}</Button>}
    </Card.Footer>
  </Card>;
}
