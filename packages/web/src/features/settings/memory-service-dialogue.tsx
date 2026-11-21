import { translate as t, useI18n } from "../../kulo-i18n";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Card, Checkbox, Chip, Input, Label, Spinner, TextField } from "@heroui/react";
import {
  redactSecrets,
  type MemoryServiceJob,
  type MemoryServiceOperation,
  type MemoryServicePrepareRequest,
  type MemoryServiceSecretInput,
  type MemoryServiceSnapshot,
  type ProviderCatalogItem,
  type KuloSettingsView,
} from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { kuloRest } from "../../kulo-api";
import { safeSetupInputError } from "./capability-setup-inputs";
import { isMemoryDialogueOperation, MEMORY_SERVICE_INTENT_EVENT, publishMemoryService, requestMemoryConnectionFocus, takeMemoryServiceIntent, type MemoryDialogueOperation } from "./memory-service-events";
import { MemoryModelFields } from "./memory-model-fields";
import {
  buildMemoryModelsPayload,
  initialMemoryModelsDraft,
  kuloMemoryConnections,
  type MemoryModelsDraft,
} from "./memory-service-models";

const operationLabels = (): Record<MemoryServiceOperation, string> => ({
  deploy: t("在本机部署 Hindsight", "Deploy Hindsight locally"), configure: t("配置记忆服务", "Configure memory service"), connect: t("连接已有 Hindsight", "Connect existing Hindsight"), disconnect: t("断开记忆连接", "Disconnect memory"), uninstall: t("卸载本机记忆服务", "Uninstall local memory service"), check: t("检测记忆连接", "Check memory connection"),
});
const statusLabels = (): Record<MemoryServiceJob["status"], string> => ({
  "awaiting-input": t("待填写凭据", "Credentials required"), "awaiting-confirmation": t("待确认", "Awaiting confirmation"), running: t("处理中", "Processing"), succeeded: t("已完成", "Completed"), failed: t("未完成", "Incomplete"), rejected: t("已取消", "Cancelled"),
});
const MODEL_SECRET_FIELDS = new Set<MemoryServiceSecretInput["field"]>(["modelApiKey", "embeddingsApiKey", "rerankerApiKey"]);
const pending = (job: MemoryServiceJob) => job.status === "running" || job.status === "awaiting-input";
const id = () => `memory-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export interface MemoryServiceDraft extends MemoryModelsDraft {
  operation: MemoryDialogueOperation;
  deleteData: boolean;
}

export function initialMemoryServiceDraft(
  operation: MemoryDialogueOperation,
  snapshot: MemoryServiceSnapshot,
  settings?: KuloSettingsView,
  providers?: ProviderCatalogItem[],
): MemoryServiceDraft {
  return {
    operation,
    ...initialMemoryModelsDraft(snapshot, settings, providers),
    deleteData: false,
  };
}

export function createMemoryServiceRequest(draft: MemoryServiceDraft, clientId: string, expectedRevision: number, commandId = id()): MemoryServicePrepareRequest {
  const request: MemoryServicePrepareRequest = { commandId, clientId, expectedRevision, operation: draft.operation };
  if (draft.operation === "deploy" || draft.operation === "configure") {
    const models = buildMemoryModelsPayload(draft);
    request.model = models.model;
    request.embeddings = models.embeddings;
    request.reranker = models.reranker;
  }
  if (draft.operation === "uninstall") request.deleteData = draft.deleteData;
  return request;
}

export async function decideMemoryServiceJob(job: MemoryServiceJob, clientId: string, decision: "confirm" | "reject"): Promise<MemoryServiceSnapshot> {
  if (job.clientId !== clientId) throw new Error(t("请在发起操作的窗口继续。", "Continue in the window where you started this operation."));
  if (decision === "confirm" && job.status !== "awaiting-confirmation" && job.status !== "failed") throw new Error(t("该操作尚未就绪，或已经处理。", "This operation is not ready or has already been handled."));
  if (decision === "reject" && !["awaiting-input", "awaiting-confirmation", "failed"].includes(job.status)) throw new Error(t("该操作已经处理。", "This operation has already been handled."));
  return kuloRest.decideMemoryService(job.id, { clientId, decision });
}

export function visibleMemoryDialogueJobs(
  jobs: readonly MemoryServiceJob[],
  clientId: string,
  sessionJobIds?: ReadonlySet<string>,
): MemoryServiceJob[] {
  const ownJobs = jobs.filter((job) => job.clientId === clientId && job.status !== "rejected");
  const activeJobs = ownJobs.filter((job) => ["awaiting-input", "awaiting-confirmation", "running", "failed"].includes(job.status));
  if (activeJobs.length > 0) return activeJobs.slice(-2);
  if (!sessionJobIds || sessionJobIds.size === 0) return [];
  const completed = ownJobs.filter((job) => job.status === "succeeded" && isMemoryDialogueOperation(job.operation) && sessionJobIds.has(job.id));
  return completed.length > 0 ? [completed[completed.length - 1]!] : [];
}

export async function submitMemoryServiceSecret(input: MemoryServiceSecretInput, clientId: string, secret: string): Promise<MemoryServiceSnapshot> {
  if (input.clientId !== clientId) throw new Error(t("请在发起配置的窗口填写凭据。", "Enter credentials in the window where you started setup."));
  if (input.status !== "pending" || input.expiresAt <= Date.now()) throw new Error(t("凭据输入已失效，请重新发起配置。", "Credential input expired. Start setup again."));
  if (!secret.trim()) throw new Error(t("请输入密钥。", "Enter an API key."));
  return kuloRest.submitMemoryServiceInput(input.id, { clientId, secret });
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
  return <form className="kulo-form-stack" onSubmit={(event) => void submit(event)}>
    <TextField variant="primary" className="kulo-form-field" type="password" name={input.field} value={secret} onChange={setSecret} isRequired isDisabled={!connected || busy || expired} fullWidth>
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
  if (!isMemoryDialogueOperation(job.operation)) return <Card variant="secondary" className="min-w-0 shrink-0 gap-3 rounded-2xl p-3" aria-label={t("原连接操作", "Previous connection operation")}>
    <Card.Header><Card.Title className="text-sm">{t("连接配置", "Connection settings")}</Card.Title></Card.Header>
    <Card.Content className="text-xs">{t("请在左侧编辑并保存连接。", "Edit and save the connection on the left.")}</Card.Content>
    <Card.Footer className="flex-wrap justify-end gap-2">
      {own && ["awaiting-input", "awaiting-confirmation"].includes(job.status) && <Button size="sm" variant="tertiary" isDisabled={!connected || busy} onPress={() => void run("reject")}>{t("取消原操作", "Cancel previous operation")}</Button>}
      <Button size="sm" variant="secondary" onPress={requestMemoryConnectionFocus}>{t("编辑连接", "Edit connection")}</Button>
    </Card.Footer>
  </Card>;
  const changes = job.changes.filter((change) => change.trim() !== job.deviceName.trim());
  return <Card variant="secondary" className="min-w-0 shrink-0 gap-3 rounded-2xl p-3" aria-label={job.title}>
    <Card.Header className="gap-2">
      <div className="flex items-start justify-between gap-2"><Card.Title className="text-sm font-medium">{job.title}</Card.Title><Chip size="sm" variant="soft" className="shrink-0 text-xs">{statusLabels()[job.status]}</Chip></div>
      <Card.Description className="text-xs">{job.deviceName}</Card.Description>
    </Card.Header>
    <Card.Content className="flex min-w-0 flex-col gap-3 text-xs">
      {changes.length > 0 && <div className="space-y-1 break-words">{changes.map((change, index) => <p key={index}>{change}</p>)}</div>}
      {job.status === "running" && <div className="flex items-center gap-2" role="status"><Spinner size="sm" aria-label={t("记忆服务处理中", "Memory service is processing")} /><span>{job.stage}</span></div>}
      {job.status === "succeeded" && <p role="status">{job.stage}</p>}
      {(job.operation === "deploy" || job.operation === "configure") && job.model && <p className="text-muted">{t("记忆存于本机；所选模型服务将处理记忆内容。", "Memory is stored locally. The selected model service processes its content.")}</p>}
      {job.status === "awaiting-input" && own && inputs.filter((input) => input.jobId === job.id && MODEL_SECRET_FIELDS.has(input.field) && input.clientId === clientId && input.status === "pending").map((input) => <MemorySecretField key={input.id} input={input} clientId={clientId} connected={connected} onChanged={onChanged} />)}
      {job.probe && <p className={job.probe.healthy ? "text-success" : "text-danger"}>{job.probe.healthy ? job.probe.isolationVerified ? t("连接与隔离检查通过", "Connection and isolation verified") : t("主脑私库连接正常", "Private memory bank connected") : t("连接检查未通过", "Connection check failed")}</p>}
      {(error || job.error) && <p role="alert" className="break-words text-danger">{error ?? redactSecrets(job.error!)}</p>}
    </Card.Content>
    <Card.Footer className="flex-wrap justify-end gap-2">
      {!own && ["awaiting-input", "awaiting-confirmation"].includes(job.status) && <span className="text-xs text-muted">{t("等待原窗口确认", "Awaiting confirmation in the original window")}</span>}
      {own && ["awaiting-input", "awaiting-confirmation", "failed"].includes(job.status) && <Button size="sm" variant="tertiary" isDisabled={!connected || busy} onPress={() => void run("reject")}>{job.status === "failed" ? t("关闭", "Dismiss") : t("取消", "Cancel")}</Button>}
      {own && job.status === "awaiting-confirmation" && <Button size="sm" variant={job.operation === "uninstall" ? "danger" : "primary"} isPending={busy} isDisabled={!connected || busy} onPress={() => job.operation === "uninstall" ? setConfirmUninstall(true) : void run("confirm")}>{job.operation === "deploy" ? t("确认部署", "Confirm deployment") : job.operation === "uninstall" ? t("卸载…", "Uninstall…") : t("确认", "Confirm")}</Button>}
      {own && job.status === "failed" && <Button size="sm" variant="secondary" isPending={busy} isDisabled={!connected || busy} onPress={() => void run("confirm")}>{t("重试", "Retry")}</Button>}
    </Card.Footer>
    <ConfirmDialog open={confirmUninstall} title={t("卸载本机 Hindsight？", "Uninstall local Hindsight?")} description={<div className="space-y-2"><p>{job.deviceName}</p><p>{job.deleteData ? t("同时永久删除记忆数据", "Also permanently delete memory data") : t("保留记忆数据", "Keep memory data")}</p>{error && <p role="alert" className="text-danger">{error}</p>}</div>} confirmLabel={job.deleteData ? t("卸载并删除数据", "Uninstall and delete data") : t("卸载并保留数据", "Uninstall and keep data")} isPending={busy} onCancel={() => setConfirmUninstall(false)} onConfirm={() => void run("confirm")} />
  </Card>;
}

export function MemoryServiceForm({ draft, snapshot, settings, providers, busy, error, onChange, onCancel, onSubmit }: {
  draft: MemoryServiceDraft;
  snapshot: MemoryServiceSnapshot;
  settings: KuloSettingsView;
  providers?: ProviderCatalogItem[];
  busy: boolean;
  error?: string;
  onChange: (draft: MemoryServiceDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  useI18n();
  const connections = useMemo(() => kuloMemoryConnections(settings, providers), [settings, providers]);
  const modelForm = draft.operation === "deploy" || draft.operation === "configure";
  return <Card variant="secondary" className="min-w-0 shrink-0 gap-3 rounded-2xl p-3" aria-label={operationLabels()[draft.operation]}>
    <Card.Header><Card.Title className="text-sm">{operationLabels()[draft.operation]}</Card.Title><Card.Description className="text-xs">{t("部署设备：", "Deployment device: ")}{snapshot.deviceName}</Card.Description></Card.Header>
    <Card.Content>
      <form id="memory-service-form" className="kulo-form-stack" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        {modelForm && (
          <MemoryModelFields
            draft={draft}
            connections={connections}
            disabled={busy}
            layout="form"
            onChange={(next) => onChange({ ...draft, ...next })}
          />
        )}
        {draft.operation === "uninstall" && <Checkbox isSelected={draft.deleteData} onChange={(deleteData) => onChange({ ...draft, deleteData })} isDisabled={busy}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{t("同时删除记忆数据", "Also delete memory data")}</Checkbox.Content></Checkbox>}
        {error && <Alert status="danger" className="rounded-xl p-2"><Alert.Content className="break-words text-xs">{error}</Alert.Content></Alert>}
      </form>
    </Card.Content>
    <Card.Footer className="justify-end gap-2"><Button size="sm" variant="tertiary" isDisabled={busy} onPress={onCancel}>{t("取消", "Cancel")}</Button><Button type="submit" form="memory-service-form" size="sm" variant="secondary" isPending={busy} isDisabled={busy}>{t("继续", "Continue")}</Button></Card.Footer>
  </Card>;
}

export function MemoryServiceDialogue({ clientId, settings, connected, refreshKey, className, initialSnapshot = null }: {
  clientId: string;
  settings: KuloSettingsView;
  connected: boolean;
  refreshKey: string;
  className?: string;
  initialSnapshot?: MemoryServiceSnapshot | null;
}) {
  useI18n();
  const [snapshot, setSnapshot] = useState<MemoryServiceSnapshot | null>(initialSnapshot);
  const [providers, setProviders] = useState<ProviderCatalogItem[]>();
  const [draft, setDraft] = useState<MemoryServiceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const sessionJobIdsRef = useRef(new Set<string>());
  const changed = useCallback((next: MemoryServiceSnapshot) => {
    if (!alive.current) return;
    for (const item of next.jobs) {
      if (item.clientId === clientId && ["awaiting-input", "awaiting-confirmation", "running", "failed"].includes(item.status)) {
        sessionJobIdsRef.current.add(item.id);
      }
    }
    setSnapshot(next);
    setError(undefined);
    publishMemoryService(next);
  }, [clientId]);
  const load = useCallback(async () => { const next = await kuloRest.getMemoryService(clientId); changed(next); return next; }, [clientId, changed]);
  const loadProviders = useCallback(async () => {
    try {
      const res = await kuloRest.listProviders();
      if (alive.current) setProviders(res.providers);
      return res.providers;
    } catch {
      return undefined;
    }
  }, []);
  const begin = async (operation: MemoryServiceOperation) => {
    if (!isMemoryDialogueOperation(operation)) { requestMemoryConnectionFocus(); return; }
    if (busy || !connected) return;
    setBusy(true); setError(undefined);
    try {
      const [current, catalog] = await Promise.all([load(), loadProviders()]);
      setDraft(initialMemoryServiceDraft(operation, current, settings, catalog ?? providers));
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
    void loadProviders();
  }, [connected, refreshKey, settings.blocks.model.revision, load, loadProviders]);
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
    try { changed(await kuloRest.prepareMemoryService(createMemoryServiceRequest(draft, clientId, snapshot.revision))); setDraft(null); }
    catch (cause) { if (alive.current) setError(redactSecrets(cause instanceof Error ? cause.message : t("准备操作失败", "Failed to prepare operation"))); }
    finally { if (alive.current) setBusy(false); }
  };
  const jobs = visibleMemoryDialogueJobs(snapshot?.jobs ?? [], clientId, sessionJobIdsRef.current);
  if (!draft && !jobs.length && !error && !busy) return null;
  return <div className={className ?? "flex min-w-0 flex-col gap-3"} aria-label={t("记忆服务配置对话", "Memory service setup conversation")}>
    {jobs.map((job) => <MemoryServiceJobCard key={job.id} job={job} inputs={snapshot?.inputs ?? []} clientId={clientId} connected={connected} onChanged={changed} />)}
    {draft && snapshot && <MemoryServiceForm draft={draft} snapshot={snapshot} settings={settings} providers={providers} busy={busy} error={error} onChange={setDraft} onCancel={() => { setDraft(null); setError(undefined); }} onSubmit={() => void prepare()} />}
    {!draft && error && <Alert status="danger" className="shrink-0 rounded-2xl p-3"><Alert.Content className="break-words text-xs">{error}</Alert.Content><Button size="sm" variant="tertiary" onPress={() => void load().catch((cause) => setError(redactSecrets(cause instanceof Error ? cause.message : t("加载失败", "Failed to load"))))}>{t("重试", "Retry")}</Button></Alert>}
    {busy && !draft && <Spinner size="sm" aria-label={t("准备记忆服务操作", "Preparing memory service operation")} />}
  </div>;
}
