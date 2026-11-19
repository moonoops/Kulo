import { translate as t, useI18n } from "../../moco-i18n";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Card, Checkbox, Chip, Input, Label, ListBox, Select, Spinner, TextField } from "@heroui/react";
import {
  isConversationModel,
  redactSecrets,
  type HindsightModelProvider,
  type HindsightServiceModel,
  type MemoryServiceJob,
  type MemoryServiceOperation,
  type MemoryServicePrepareRequest,
  type MemoryServiceSecretInput,
  type MemoryServiceSnapshot,
  type MocoSettingsView,
} from "@moco/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { mocoRest } from "../../moco-api";
import { safeSetupInputError } from "./capability-setup-inputs";
import { isMemoryDialogueOperation, MEMORY_SERVICE_INTENT_EVENT, publishMemoryService, requestMemoryConnectionFocus, takeMemoryServiceIntent, type MemoryDialogueOperation } from "./memory-service-events";

const operationLabels = (): Record<MemoryServiceOperation, string> => ({
  deploy: t("在本机部署 Hindsight", "Deploy Hindsight locally"), configure: t("配置记忆服务", "Configure memory service"), connect: t("连接已有 Hindsight", "Connect existing Hindsight"), disconnect: t("断开记忆连接", "Disconnect memory"), uninstall: t("卸载本机记忆服务", "Uninstall local memory service"), check: t("检测记忆连接", "Check memory connection"),
});
const modelProviders = (): Array<{ id: HindsightModelProvider; label: string }> => ([
  { id: "openai", label: t("OpenAI 兼容 API", "OpenAI-compatible API") }, { id: "anthropic", label: "Anthropic" }, { id: "gemini", label: "Gemini" }, { id: "groq", label: "Groq" }, { id: "ollama", label: "Ollama" },
]);
const statusLabels = (): Record<MemoryServiceJob["status"], string> => ({
  "awaiting-input": t("待填写凭据", "Credentials required"), "awaiting-confirmation": t("待确认", "Awaiting confirmation"), running: t("处理中", "Processing"), succeeded: t("已完成", "Completed"), failed: t("未完成", "Incomplete"), rejected: t("已取消", "Cancelled"),
});
const pending = (job: MemoryServiceJob) => job.status === "running" || job.status === "awaiting-input";
const id = () => `memory-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export interface MemoryServiceDraft {
  operation: MemoryDialogueOperation;
  provider: HindsightModelProvider;
  model: string;
  baseUrl: string;
  connectionId: string;
  deleteData: boolean;
}

function initialDraft(operation: MemoryDialogueOperation, snapshot: MemoryServiceSnapshot): MemoryServiceDraft {
  const saved = snapshot.model;
  return {
    operation, provider: saved?.provider ?? "openai", model: saved?.model ?? "", baseUrl: saved?.baseUrl ?? "", connectionId: saved?.connectionId ?? "",
    deleteData: false,
  };
}

function safeUrl(raw: string, label: string): string {
  const value = raw.trim();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(t(`请输入有效的${label}。`, `Enter a valid ${label}.`)); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(t(`${label}不能包含凭据、查询参数或锚点。`, `${label} cannot include credentials, query parameters, or fragments.`));
  return value.replace(/\/+$/, "");
}

export function createMemoryServiceRequest(draft: MemoryServiceDraft, clientId: string, expectedRevision: number, commandId = id()): MemoryServicePrepareRequest {
  const request: MemoryServicePrepareRequest = { commandId, clientId, expectedRevision, operation: draft.operation };
  if (draft.operation === "deploy" || draft.operation === "configure") {
    if (!draft.model.trim()) throw new Error(t("请选择或填写记忆模型。", "Select or enter a memory model."));
    request.model = {
      provider: draft.provider, model: draft.model.trim(),
      ...(draft.baseUrl.trim() ? { baseUrl: safeUrl(draft.baseUrl, t("模型地址", "Model URL")) } : {}),
      ...(draft.connectionId ? { connectionId: draft.connectionId } : {}),
    };
  }
  if (draft.operation === "uninstall") request.deleteData = draft.deleteData;
  return request;
}

export async function decideMemoryServiceJob(job: MemoryServiceJob, clientId: string, decision: "confirm" | "reject"): Promise<MemoryServiceSnapshot> {
  if (job.clientId !== clientId) throw new Error(t("请在发起操作的窗口继续。", "Continue in the window where you started this operation."));
  if (decision === "confirm" && job.status !== "awaiting-confirmation" && job.status !== "failed") throw new Error(t("该操作尚未就绪，或已经处理。", "This operation is not ready or has already been handled."));
  if (decision === "reject" && !["awaiting-input", "awaiting-confirmation"].includes(job.status)) throw new Error(t("该操作已经处理。", "This operation has already been handled."));
  return mocoRest.decideMemoryService(job.id, { clientId, decision });
}

export async function submitMemoryServiceSecret(input: MemoryServiceSecretInput, clientId: string, secret: string): Promise<MemoryServiceSnapshot> {
  if (input.clientId !== clientId) throw new Error(t("请在发起配置的窗口填写凭据。", "Enter credentials in the window where you started setup."));
  if (input.status !== "pending" || input.expiresAt <= Date.now()) throw new Error(t("凭据输入已失效，请重新发起配置。", "Credential input expired. Start setup again."));
  if (!secret.trim()) throw new Error(t("请输入密钥。", "Enter an API key."));
  return mocoRest.submitMemoryServiceInput(input.id, { clientId, secret });
}

function MemorySecretField({ input, clientId, connected, onChanged }: { input: MemoryServiceSecretInput; clientId: string; connected: boolean; onChanged: (snapshot: MemoryServiceSnapshot) => void }) {
  useI18n();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [expired, setExpired] = useState(input.expiresAt <= Date.now());
  useEffect(() => {
    const expire = () => { setExpired(true); setSecret(""); };
    if (input.expiresAt <= Date.now()) { expire(); return; }
    const timer = setTimeout(expire, Math.min(input.expiresAt - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [input.expiresAt]);
  useEffect(() => { if (!connected) setSecret(""); }, [connected]);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !connected || expired) return;
    setBusy(true); setError(undefined);
    try { onChanged(await submitMemoryServiceSecret(input, clientId, secret)); }
    catch (cause) { setError(safeSetupInputError(cause, secret)); }
    finally { setSecret(""); setBusy(false); }
  };
  return <form className="moco-form-stack" onSubmit={(event) => void submit(event)}>
    <TextField variant="primary" className="moco-form-field" type="password" name={input.field} value={secret} onChange={setSecret} isRequired isDisabled={!connected || busy || expired} fullWidth>
      <Label>{input.label}</Label>
      <Input autoComplete="new-password" spellCheck={false} placeholder={t("输入密钥", "Enter API key")} onKeyDown={(event) => {
        if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
      }} />
    </TextField>
    {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    {expired && <p role="status" className="text-xs text-warning">{t("输入已过期，请重新配置", "Input expired. Start setup again.")}</p>}
    <Button type="submit" size="sm" variant="secondary" className="self-end" isPending={busy} isDisabled={!connected || busy || expired || !secret.trim()}>{t("保存密钥", "Save API key")}</Button>
  </form>;
}

export function MemoryServiceJobCard({ job, inputs, clientId, connected, onChanged }: {
  job: MemoryServiceJob;
  inputs: MemoryServiceSecretInput[];
  clientId: string;
  connected: boolean;
  onChanged: (snapshot: MemoryServiceSnapshot) => void;
}) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const own = job.clientId === clientId;
  const run = async (decision: "confirm" | "reject") => {
    if (busy || !connected || !own) return;
    setBusy(true); setError(undefined);
    try { onChanged(await decideMemoryServiceJob(job, clientId, decision)); setConfirmUninstall(false); }
    catch (cause) { setError(redactSecrets(cause instanceof Error ? cause.message : t("操作未完成，请重试。", "The operation did not finish. Try again."))); }
    finally { setBusy(false); }
  };
  if (!isMemoryDialogueOperation(job.operation)) return <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-3" aria-label={t("原连接操作", "Previous connection operation")}>
    <Card.Header><Card.Title className="text-sm">{t("连接配置", "Connection settings")}</Card.Title></Card.Header>
    <Card.Content className="text-xs">{t("请在左侧编辑并保存连接。", "Edit and save the connection on the left.")}</Card.Content>
    <Card.Footer className="flex-wrap justify-end gap-2">
      {own && ["awaiting-input", "awaiting-confirmation"].includes(job.status) && <Button size="sm" variant="tertiary" isDisabled={!connected || busy} onPress={() => void run("reject")}>{t("取消原操作", "Cancel previous operation")}</Button>}
      <Button size="sm" variant="secondary" onPress={requestMemoryConnectionFocus}>{t("编辑连接", "Edit connection")}</Button>
    </Card.Footer>
  </Card>;
  return <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-3" aria-label={job.title}>
    <Card.Header className="gap-2">
      <div className="flex items-start justify-between gap-2"><Card.Title className="text-sm font-medium">{job.title}</Card.Title><Chip size="sm" variant="soft" className="shrink-0 text-xs">{statusLabels()[job.status]}</Chip></div>
      <Card.Description className="text-xs">{job.deviceName}</Card.Description>
    </Card.Header>
    <Card.Content className="flex min-w-0 flex-col gap-3 text-xs">
      {job.changes.length > 0 && <div className="space-y-1 break-words">{job.changes.map((change, index) => <p key={index}>{change}</p>)}</div>}
      {job.status === "running" && <div className="flex items-center gap-2" role="status"><Spinner size="sm" aria-label={t("记忆服务处理中", "Memory service is processing")} /><span>{job.stage}</span></div>}
      {job.status === "succeeded" && <p role="status">{job.stage}</p>}
      {(job.operation === "deploy" || job.operation === "configure") && job.model && <p className="text-muted">{t("记忆存于本机；所选模型服务将处理记忆内容。", "Memory is stored locally. The selected model service processes its content.")}</p>}
      {job.status === "awaiting-input" && own && inputs.filter((input) => input.jobId === job.id && input.field === "modelApiKey" && input.clientId === clientId && input.status === "pending").map((input) => <MemorySecretField key={input.id} input={input} clientId={clientId} connected={connected} onChanged={onChanged} />)}
      {job.probe && <p className={job.probe.healthy ? "text-success" : "text-danger"}>{job.probe.healthy ? job.probe.isolationVerified ? t("连接与隔离检查通过", "Connection and isolation verified") : t("主脑私库连接正常", "Private memory bank connected") : t("连接检查未通过", "Connection check failed")}</p>}
      {(error || job.error) && <p role="alert" className="break-words text-danger">{error ?? redactSecrets(job.error!)}</p>}
    </Card.Content>
    <Card.Footer className="flex-wrap justify-end gap-2">
      {!own && ["awaiting-input", "awaiting-confirmation"].includes(job.status) && <span className="text-xs text-muted">{t("等待原窗口确认", "Awaiting confirmation in the original window")}</span>}
      {own && ["awaiting-input", "awaiting-confirmation"].includes(job.status) && <Button size="sm" variant="tertiary" isDisabled={!connected || busy} onPress={() => void run("reject")}>{t("取消", "Cancel")}</Button>}
      {own && job.status === "awaiting-confirmation" && <Button size="sm" variant={job.operation === "uninstall" ? "danger" : "primary"} isPending={busy} isDisabled={!connected || busy} onPress={() => job.operation === "uninstall" ? setConfirmUninstall(true) : void run("confirm")}>{job.operation === "deploy" ? t("确认部署", "Confirm deployment") : job.operation === "uninstall" ? t("卸载…", "Uninstall…") : t("确认", "Confirm")}</Button>}
      {own && job.status === "failed" && <Button size="sm" variant="secondary" isPending={busy} isDisabled={!connected || busy} onPress={() => void run("confirm")}>{t("重试", "Retry")}</Button>}
    </Card.Footer>
    <ConfirmDialog open={confirmUninstall} title={t("卸载本机 Hindsight？", "Uninstall local Hindsight?")} description={<div className="space-y-2"><p>{job.deviceName}</p><p>{job.deleteData ? t("同时永久删除记忆数据", "Also permanently delete memory data") : t("保留记忆数据", "Keep memory data")}</p>{error && <p role="alert" className="text-danger">{error}</p>}</div>} confirmLabel={job.deleteData ? t("卸载并删除数据", "Uninstall and delete data") : t("卸载并保留数据", "Uninstall and keep data")} isPending={busy} onCancel={() => setConfirmUninstall(false)} onConfirm={() => void run("confirm")} />
  </Card>;
}

function modelConnections(settings: MocoSettingsView) {
  const model = settings.blocks.model;
  const connections: Array<{ id: string; label: string; provider: HindsightModelProvider; baseUrl: string; model: string; models: string[] }> = [];
  if (!model.value.gatewayDisabled && (model.hasApiKey || (model.value.gatewayModels?.length ?? 0) > 0)) {
    const chatIds = [...new Set((model.value.gatewayModels ?? []).filter(isConversationModel).map((m) => m.id.trim()).filter(Boolean))];
    if (model.value.defaultProvider === "moco-gateway" && model.value.defaultModel.trim() && !chatIds.includes(model.value.defaultModel.trim())) {
      chatIds.unshift(model.value.defaultModel.trim());
    }
    connections.push({
      id: "moco-gateway",
      label: model.value.gatewayName?.trim() || t("默认 API 连接", "Default API connection"),
      provider: "openai",
      baseUrl: model.value.baseUrl,
      model: chatIds[0] ?? model.value.defaultModel,
      models: chatIds,
    });
  }
  for (const item of model.value.customProviders ?? []) {
    const provider: HindsightModelProvider | undefined = item.preset === "groq"
      ? "groq"
      : item.api === "anthropic-messages"
        ? "anthropic"
        : item.api === "google-generative-ai"
          ? "gemini"
          : item.api.startsWith("openai-")
            ? "openai"
            : undefined;
    if (!provider) continue;
    const chatIds = [...new Set(item.models.filter(isConversationModel).map((m) => m.id.trim()).filter(Boolean))];
    const defaultForConn = model.value.defaultProvider === item.id ? model.value.defaultModel.trim() : "";
    if (defaultForConn && !chatIds.includes(defaultForConn)) chatIds.unshift(defaultForConn);
    connections.push({
      id: item.id,
      label: item.name || item.id,
      provider,
      baseUrl: item.baseUrl,
      model: defaultForConn || chatIds[0] || "",
      models: chatIds,
    });
  }
  return connections;
}

export function MemoryServiceForm({ draft, snapshot, settings, busy, error, onChange, onCancel, onSubmit }: {
  draft: MemoryServiceDraft;
  snapshot: MemoryServiceSnapshot;
  settings: MocoSettingsView;
  busy: boolean;
  error?: string;
  onChange: (draft: MemoryServiceDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  useI18n();
  const connections = modelConnections(settings);
  const selectedConnection = connections.find((item) => item.id === draft.connectionId);
  const selectableModels = selectedConnection?.models.length
    ? [...new Set([...selectedConnection.models, ...(draft.model.trim() ? [draft.model.trim()] : [])])]
    : [];
  const modelForm = draft.operation === "deploy" || draft.operation === "configure";
  return <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-3" aria-label={operationLabels()[draft.operation]}>
    <Card.Header><Card.Title className="text-sm">{operationLabels()[draft.operation]}</Card.Title><Card.Description className="text-xs">{t("部署设备：", "Deployment device: ")}{snapshot.deviceName}</Card.Description></Card.Header>
    <Card.Content>
      <form id="memory-service-form" className="moco-form-stack" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        {modelForm && <>
          {connections.length > 0 && <Select variant="primary" className="moco-form-field" value={draft.connectionId || "__separate__"} onChange={(value) => {
            const connection = connections.find((item) => item.id === value);
            onChange(connection ? { ...draft, connectionId: connection.id, provider: connection.provider, baseUrl: connection.baseUrl, model: connection.model || draft.model } : { ...draft, connectionId: "" });
          }} isDisabled={busy} fullWidth><Label>{t("模型凭据来源", "Model credentials")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox><ListBox.Item id="__separate__" textValue={t("单独配置", "Configure separately")}>{t("单独配置", "Configure separately")}<ListBox.ItemIndicator /></ListBox.Item>{connections.map((connection) => <ListBox.Item key={connection.id} id={connection.id} textValue={connection.label}>{connection.label}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover></Select>}
          {!selectedConnection && <Select variant="primary" className="moco-form-field" value={draft.provider} onChange={(value) => { if (value) onChange({ ...draft, provider: String(value) as HindsightModelProvider, connectionId: "", baseUrl: "", model: "" }); }} isDisabled={busy} fullWidth>
            <Label>{t("模型供应商", "Model provider")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox>{modelProviders().map((provider) => <ListBox.Item key={provider.id} id={provider.id} textValue={provider.label}>{provider.label}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
          </Select>}
          {selectableModels.length > 0
            ? <Select variant="primary" className="moco-form-field" value={draft.model || selectableModels[0]} onChange={(value) => { if (value) onChange({ ...draft, model: String(value) }); }} isDisabled={busy} fullWidth>
                <Label>{t("记忆模型", "Memory model")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover><ListBox>{selectableModels.map((modelId) => <ListBox.Item key={modelId} id={modelId} textValue={modelId}>{modelId}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
              </Select>
            : <TextField variant="primary" className="moco-form-field" value={draft.model} onChange={(model) => onChange({ ...draft, model })} isRequired isDisabled={busy} fullWidth><Label>{t("记忆模型", "Memory model")}</Label><Input spellCheck={false} /></TextField>}
          {!selectedConnection && <TextField variant="primary" className="moco-form-field" value={draft.baseUrl} onChange={(baseUrl) => onChange({ ...draft, baseUrl, connectionId: "" })} isDisabled={busy} fullWidth><Label>{t("模型地址（可选）", "Model URL (optional)")}</Label><Input type="url" spellCheck={false} placeholder={draft.provider === "ollama" ? "http://127.0.0.1:11434" : t("使用供应商默认地址", "Use the provider's default URL")} /></TextField>}
        </>}
        {draft.operation === "uninstall" && <Checkbox isSelected={draft.deleteData} onChange={(deleteData) => onChange({ ...draft, deleteData })} isDisabled={busy}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{t("同时删除记忆数据", "Also delete memory data")}</Checkbox.Content></Checkbox>}
        {error && <Alert status="danger" className="rounded-xl p-2"><Alert.Content className="break-words text-xs">{error}</Alert.Content></Alert>}
      </form>
    </Card.Content>
    <Card.Footer className="justify-end gap-2"><Button size="sm" variant="tertiary" isDisabled={busy} onPress={onCancel}>{t("取消", "Cancel")}</Button><Button type="submit" form="memory-service-form" size="sm" variant="secondary" isPending={busy} isDisabled={busy}>{t("继续", "Continue")}</Button></Card.Footer>
  </Card>;
}

export function MemoryServiceDialogue({ clientId, settings, connected, refreshKey }: { clientId: string; settings: MocoSettingsView; connected: boolean; refreshKey: string }) {
  useI18n();
  const [snapshot, setSnapshot] = useState<MemoryServiceSnapshot | null>(null);
  const [draft, setDraft] = useState<MemoryServiceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const changed = useCallback((next: MemoryServiceSnapshot) => { if (alive.current) { setSnapshot(next); setError(undefined); publishMemoryService(next); } }, []);
  const load = useCallback(async () => { const next = await mocoRest.getMemoryService(clientId); changed(next); return next; }, [clientId, changed]);
  const begin = async (operation: MemoryServiceOperation) => {
    if (!isMemoryDialogueOperation(operation)) { requestMemoryConnectionFocus(); return; }
    if (busy || !connected) return;
    setBusy(true); setError(undefined);
    try {
      const current = await load();
      setDraft(initialDraft(operation, current));
    } catch (cause) { if (alive.current) setError(redactSecrets(cause instanceof Error ? cause.message : t("无法读取记忆服务", "Unable to load memory service"))); }
    finally { if (alive.current) setBusy(false); }
  };
  const beginRef = useRef(begin);
  beginRef.current = begin;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!connected) return;
    void load().catch((cause) => { if (alive.current) setError(redactSecrets(cause instanceof Error ? cause.message : t("读取服务失败", "Failed to load service"))); });
  }, [connected, refreshKey, load]);
  useEffect(() => {
    const receive = () => { const operation = takeMemoryServiceIntent(); if (operation) void beginRef.current(operation); };
    window.addEventListener(MEMORY_SERVICE_INTENT_EVENT, receive);
    receive();
    return () => window.removeEventListener(MEMORY_SERVICE_INTENT_EVENT, receive);
  }, []);
  const hasPendingWork = snapshot?.jobs.some((job) => job.clientId === clientId && pending(job)) ?? false;
  useEffect(() => {
    if (!connected || !hasPendingWork) return;
    const timer = setInterval(() => { void load().catch((cause) => { if (alive.current) setError(redactSecrets(cause instanceof Error ? cause.message : t("读取处理进度失败", "Failed to load progress"))); }); }, 1500);
    return () => clearInterval(timer);
  }, [connected, hasPendingWork, load]);
  const prepare = async () => {
    if (!draft || !snapshot || busy || !connected) return;
    setBusy(true); setError(undefined);
    try { changed(await mocoRest.prepareMemoryService(createMemoryServiceRequest(draft, clientId, snapshot.revision))); setDraft(null); }
    catch (cause) { if (alive.current) setError(redactSecrets(cause instanceof Error ? cause.message : t("准备操作失败", "Failed to prepare operation"))); }
    finally { if (alive.current) setBusy(false); }
  };
  const jobs = (snapshot?.jobs ?? []).filter((job) => job.clientId === clientId && (isMemoryDialogueOperation(job.operation) || ["awaiting-input", "awaiting-confirmation", "running"].includes(job.status))).slice(-8);
  if (!draft && !jobs.length && !error && !busy) return null;
  return <div className="flex min-w-0 flex-col gap-3" aria-label={t("记忆服务配置对话", "Memory service setup conversation")}>
    {jobs.map((job) => <MemoryServiceJobCard key={job.id} job={job} inputs={snapshot?.inputs ?? []} clientId={clientId} connected={connected} onChanged={changed} />)}
    {draft && snapshot && <MemoryServiceForm draft={draft} snapshot={snapshot} settings={settings} busy={busy} error={error} onChange={setDraft} onCancel={() => { setDraft(null); setError(undefined); }} onSubmit={() => void prepare()} />}
    {!draft && error && <Alert status="danger" className="rounded-2xl p-3"><Alert.Content className="break-words text-xs">{error}</Alert.Content><Button size="sm" variant="tertiary" onPress={() => void load().catch((cause) => setError(redactSecrets(cause instanceof Error ? cause.message : t("加载失败", "Failed to load"))))}>{t("重试", "Retry")}</Button></Alert>}
    {busy && !draft && <Spinner size="sm" aria-label={t("准备记忆服务操作", "Preparing memory service operation")} />}
  </div>;
}
