import { useI18n, translate } from "../../kulo-i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Chip, Input, Label, ListBox, Modal, Select, Spinner, Switch, TextField } from "@heroui/react";
import { DropIndicator, GridList, GridListItem, useDragAndDrop } from "react-aria-components";
import { redactSecrets, type SearchAdapterId, type SearchFailure, type SearchPlanInput, type SearchPlanView, type SearchSnapshot } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { useSettingsPending } from "./settings-save-activity";
import { KuloApiError, kuloRest } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";

const ADAPTER_LABELS: Record<SearchAdapterId, string> = { exa: "Exa", tavily: "Tavily", brave: "Brave", duckduckgo: "DuckDuckGo" };
const DEFAULT_URLS: Record<SearchAdapterId, string> = { exa: "https://mcp.exa.ai/mcp", tavily: "https://mcp.tavily.com/mcp", brave: "https://api.search.brave.com", duckduckgo: "https://duckduckgo.com" };
const fixedEndpoint = (adapter: SearchAdapterId) => adapter === "brave" || adapter === "duckduckgo";
const requiresKey = (adapter: SearchAdapterId) => adapter === "tavily" || adapter === "brave";

export function acceptSearchSnapshot(previous: SearchSnapshot | undefined, next: SearchSnapshot): SearchSnapshot {
  if (!previous || next.revision > previous.revision) return next;
  if (next.revision < previous.revision) return previous;
  return (next.healthRevision ?? 0) >= (previous.healthRevision ?? 0) ? next : previous;
}

export function reorderedSearchIds(ids: string[], moving: Set<string>, target: string, position: "before" | "after"): string[] {
  if (!ids.includes(target) || moving.has(target)) return ids;
  const moved = ids.filter((id) => moving.has(id));
  if (!moved.length) return ids;
  const remaining = ids.filter((id) => !moving.has(id));
  const index = remaining.indexOf(target) + (position === "after" ? 1 : 0);
  return [...remaining.slice(0, index), ...moved, ...remaining.slice(index)];
}

export interface SearchPlanDraft {
  original?: SearchPlanView;
  name: string;
  adapter: SearchAdapterId;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export function searchPlanDraft(plan?: SearchPlanView): SearchPlanDraft {
  const adapter = plan?.adapter ?? "tavily";
  return { original: plan, name: plan?.name ?? ADAPTER_LABELS[adapter], adapter, baseUrl: fixedEndpoint(adapter) ? DEFAULT_URLS[adapter] : plan?.baseUrl ?? DEFAULT_URLS[adapter], apiKey: "", enabled: plan?.enabled ?? true };
}

export function searchPlanDraftDirty(draft: SearchPlanDraft | undefined): boolean {
  if (!draft) return false;
  const initial = searchPlanDraft(draft.original);
  return draft.name !== initial.name || draft.adapter !== initial.adapter || draft.baseUrl !== initial.baseUrl || draft.apiKey !== initial.apiKey || draft.enabled !== initial.enabled;
}

function sameOrigin(left: string | undefined, right: string): boolean {
  try { return new URL(left ?? "").origin === new URL(right).origin; }
  catch { return false; }
}

export function searchPlanInput(draft: SearchPlanDraft): SearchPlanInput {
  return {
    ...(draft.original ? { id: draft.original.id, expectedRevision: draft.original.revision } : {}),
    name: draft.name.trim(), adapter: draft.adapter, enabled: draft.enabled,
    baseUrl: fixedEndpoint(draft.adapter) ? DEFAULT_URLS[draft.adapter] : draft.baseUrl.trim(),
    ...(draft.adapter !== "duckduckgo" && draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
  };
}

export function SearchPlanFields({ draft, onChange, disabled = false }: {
  draft: SearchPlanDraft;
  onChange: (draft: SearchPlanDraft) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const keepsKey = draft.original?.adapter === draft.adapter && draft.original.hasCredential && sameOrigin(draft.original.baseUrl, draft.baseUrl);
  return <div className="kulo-form-stack">
    <TextField className="kulo-form-field" variant="secondary" value={draft.name} onChange={(name) => onChange({ ...draft, name })} isDisabled={disabled} isRequired fullWidth>
      <Label>{t("方案名称", "Plan name")}</Label><Input autoFocus maxLength={100} />
    </TextField>
    <Select className="kulo-form-field" variant="secondary" value={draft.adapter} isDisabled={disabled} fullWidth onChange={(value) => {
      if (!value || !Object.hasOwn(ADAPTER_LABELS, String(value))) return;
      const adapter = String(value) as SearchAdapterId;
      onChange({ ...draft, adapter, name: !draft.name || draft.name === ADAPTER_LABELS[draft.adapter] ? ADAPTER_LABELS[adapter] : draft.name, baseUrl: DEFAULT_URLS[adapter], apiKey: "" });
    }}>
      <Label>{t("搜索服务", "Search service")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover><ListBox>{Object.entries(ADAPTER_LABELS).map(([id, label]) => <ListBox.Item key={id} id={id} textValue={label}>{label}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
    </Select>
    {!fixedEndpoint(draft.adapter) && <TextField className="kulo-form-field" variant="secondary" value={draft.baseUrl} onChange={(baseUrl) => onChange({ ...draft, baseUrl })} isDisabled={disabled} isRequired fullWidth>
      <Label>{t("MCP 地址", "MCP URL")}</Label><Input type="url" autoComplete="off" spellCheck={false} />
    </TextField>}
    {draft.adapter !== "duckduckgo" && <TextField className="kulo-form-field" variant="secondary" value={draft.apiKey} onChange={(apiKey) => onChange({ ...draft, apiKey })} isDisabled={disabled} isRequired={requiresKey(draft.adapter) && !keepsKey} fullWidth>
      <Label>{draft.adapter === "exa" ? t("API Key（可选）", "API key (optional)") : "API Key"}</Label><Input type="password" autoComplete="new-password" placeholder={keepsKey ? t("已保存，留空保留", "Saved; leave blank to keep") : draft.adapter === "exa" ? t("免费搜索可留空", "Leave blank for free search") : t("输入 API Key", "Enter an API key")} spellCheck={false} />
    </TextField>}
    <Switch className="w-full" isSelected={draft.enabled} onChange={(enabled) => onChange({ ...draft, enabled })} isDisabled={disabled}>
      <Switch.Content className="kulo-form-toggle"><Label>{t("启用", "Enable")}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
    </Switch>
  </div>;
}

function DragHandleIcon() {
  return <KuloIcon name="grip" size={16} />;
}

type PlanTestError = { planId: string; revision?: number; message: string };

export function SearchModule({ snapshot: incoming, connected, disabled = false, onRefresh, onDirtyChange }: { snapshot?: SearchSnapshot; connected: boolean; disabled?: boolean; onRefresh: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const FAILURE_LABELS: Record<SearchFailure["kind"], string> = { auth: t("待连接", "Not connected"), quota: t("额度不足", "Quota exceeded"), rate_limit: t("已限流", "Rate limited"), unsupported_tool: t("工具不支持", "Unsupported tool"), invalid_request: t("请求错误", "Invalid request"), network: t("连接失败", "Connection failed"), timeout: t("请求超时", "Request timed out"), no_results: t("未找到结果", "No results"), ungrounded: t("缺少来源", "Missing sources"), upstream: t("服务异常", "Service error"), unknown: t("测试失败", "Test failed") };
  const STATUS_LABELS = { unverified: t("未测试", "Not tested"), ready: t("可用", "Ready"), needs_auth: t("待连接", "Not connected"), error: t("测试失败", "Test failed"), disabled: t("已停用", "Disabled") };
  const [snapshot, setSnapshot] = useState<SearchSnapshot | undefined>(incoming);
  const [loading, setLoading] = useState(!incoming);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [testError, setTestError] = useState<PlanTestError>();
  const [busy, setBusy] = useState<string>();
  const [draft, setDraft] = useState<SearchPlanDraft>();
  const [discardEditor, setDiscardEditor] = useState(false);
  const editorSaving = useRef(false);
  const draftDirty = searchPlanDraftDirty(draft);
  useSettingsPending(busy === "save" || Boolean(busy?.startsWith("toggle:")));
  useEffect(() => { onDirtyChange?.(draftDirty); }, [draftDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const [editorError, setEditorError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [remove, setRemove] = useState<SearchPlanView>();
  const mounted = useRef(true);
  const requestSeq = useRef(0);
  const acceptSnapshot = useCallback((next: SearchSnapshot) => setSnapshot((previous) => acceptSearchSnapshot(previous, next)), []);
  const blocked = !connected || disabled || Boolean(busy);
  const report = (failure: unknown) => redactSecrets(failure instanceof Error ? failure.message : t("操作失败，请重试。", "Action failed. Please retry."));

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (incoming) { ++requestSeq.current; acceptSnapshot(incoming); setLoading(false); setLoadError(undefined); }
  }, [incoming, acceptSnapshot]);
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const next = await kuloRest.getSearch();
      if (mounted.current && seq === requestSeq.current) { acceptSnapshot(next); setLoadError(undefined); }
    } catch (failure) {
      if (mounted.current && seq === requestSeq.current) setLoadError(redactSecrets(failure instanceof Error ? failure.message : translate("搜索配置加载失败。", "Failed to load search settings.")));
    } finally { if (mounted.current && seq === requestSeq.current) setLoading(false); }
  }, [acceptSnapshot]);
  useEffect(() => { if (!incoming && connected) void refresh(); }, [incoming, connected, refresh]);

  const openEditor = (plan?: SearchPlanView) => { setDraft(searchPlanDraft(plan)); setEditorError(undefined); setConflict(false); };
  const discardDraft = () => { setDiscardEditor(false); setDraft(undefined); setEditorError(undefined); setConflict(false); };
  const closeEditor = () => {
    if (editorSaving.current || busy) return;
    if (draftDirty) setDiscardEditor(true);
    else discardDraft();
  };
  const changed = (next: SearchSnapshot) => { acceptSnapshot(next); setTestError(undefined); setActionError(undefined); onRefresh(); };
  const save = async () => {
    if (!draft || blocked || editorSaving.current) return;
    if (!draft.name.trim()) { setEditorError(t("请输入方案名称。", "Enter a plan name.")); return; }
    editorSaving.current = true;
    setBusy("save");
    try {
      const next = await kuloRest.saveSearchPlan(searchPlanInput(draft));
      if (mounted.current) { changed(next); setDraft(undefined); }
    } catch (failure) {
      if (mounted.current) { setEditorError(report(failure)); setConflict(failure instanceof KuloApiError && failure.status === 409); }
    } finally { editorSaving.current = false; if (mounted.current) setBusy(undefined); }
  };
  const reloadDraft = async () => {
    if (!draft?.original) return;
    setBusy("reload");
    try {
      const next = await kuloRest.getSearch();
      const latest = next.plans.find((plan) => plan.id === draft.original!.id);
      if (mounted.current) {
        acceptSnapshot(next);
        if (!latest) { setEditorError(t("此搜索方案已被移除。", "This search plan has been removed.")); return; }
        setDraft(searchPlanDraft(latest)); setEditorError(undefined); setConflict(false);
      }
    } catch (failure) { if (mounted.current) setEditorError(report(failure)); }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const toggle = async (plan: SearchPlanView, enabled: boolean) => {
    if (blocked) return;
    setBusy(`toggle:${plan.id}`);
    try {
      const next = await kuloRest.saveSearchPlan({ id: plan.id, expectedRevision: plan.revision, name: plan.name, adapter: plan.adapter, baseUrl: plan.baseUrl, enabled });
      if (mounted.current) changed(next);
    } catch (failure) { if (mounted.current) { setActionError(report(failure)); void refresh(); } }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const test = async (plan: SearchPlanView) => {
    if (blocked) return;
    const latest = snapshot?.plans.find((item) => item.id === plan.id);
    if (!latest) return;
    setBusy(`test:${latest.id}`);
    try {
      const next = await kuloRest.testSearchPlan(latest.id, latest.revision);
      if (mounted.current) { acceptSnapshot(next.snapshot); setTestError(undefined); onRefresh(); }
    } catch (failure) {
      if (mounted.current) {
        setTestError({ planId: latest.id, ...(failure instanceof KuloApiError && failure.status === 409 ? {} : { revision: latest.revision }), message: report(failure) });
        void refresh(); onRefresh();
      }
    } finally { if (mounted.current) setBusy(undefined); }
  };
  const deletePlan = async () => {
    if (!remove || blocked) return;
    setBusy("delete");
    try { const next = await kuloRest.deleteSearchPlan(remove.id, remove.revision); if (mounted.current) { changed(next); setRemove(undefined); } }
    catch (failure) { if (mounted.current) { setActionError(report(failure)); setRemove(undefined); void refresh(); } }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const reorder = async (ids: string[]) => {
    if (!snapshot || blocked || ids.join("\0") === snapshot.plans.map((plan) => plan.id).join("\0")) return;
    setBusy("order");
    try { const next = await kuloRest.reorderSearchPlans(ids, snapshot.revision); if (mounted.current) changed(next); }
    catch (failure) { if (mounted.current) { setActionError(report(failure)); void refresh(); } }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const plans = snapshot?.plans ?? [];
  const { dragAndDropHooks } = useDragAndDrop<SearchPlanView>({
    isDisabled: blocked,
    getItems: (keys) => [...keys].map((key) => ({ "application/x-kulo-search-plan": String(key), "text/plain": plans.find((plan) => plan.id === key)?.name ?? String(key) })),
    acceptedDragTypes: ["application/x-kulo-search-plan"],
    getAllowedDropOperations: () => ["move"],
    onReorder: (event) => {
      if (event.target.dropPosition !== "before" && event.target.dropPosition !== "after") return;
      void reorder(reorderedSearchIds(plans.map((plan) => plan.id), new Set([...event.keys].map(String)), String(event.target.key), event.target.dropPosition));
    },
    renderDropIndicator: (target) => <DropIndicator target={target} className={({ isDropTarget }) => `h-0.5 rounded-full ${isDropTarget ? "bg-accent" : "bg-transparent"}`} />,
  });
  const rowItems = useMemo(() => plans.map((plan, index) => ({ ...plan, priority: index + 1 })), [plans]);

  return <section className="kulo-search-plans flex min-w-0 flex-col gap-4" aria-labelledby="search-plans-heading" aria-busy={Boolean(busy) || loading || undefined}>
    <div className="kulo-settings-section-head">
      <h2 id="search-plans-heading" className="kulo-section-title">{t("搜索方案", "Search plans")}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" className="relative" aria-label={t("刷新搜索配置", "Refresh search settings")} isDisabled={!connected || Boolean(busy)} isPending={loading} onPress={() => void refresh()}><span className={loading ? "invisible" : undefined}>{t("刷新", "Refresh")}</span>{loading && <Spinner size="sm" color="current" className="absolute" aria-label={t("正在刷新搜索配置", "Refreshing search settings")} />}</Button>
        <Button size="sm" variant="secondary" isDisabled={blocked || !snapshot} onPress={() => openEditor()}>{t("添加搜索方案", "Add search plan")}</Button>
      </div>
    </div>
    {loadError && <Alert status="danger"><Alert.Content><Alert.Title>{t("搜索配置加载失败", "Failed to load search settings")}</Alert.Title><Alert.Description>{loadError}</Alert.Description></Alert.Content><Button size="sm" variant="secondary" isDisabled={blocked || loading} onPress={() => void refresh()}>{t("重新加载", "Reload")}</Button></Alert>}
    {actionError && <Alert status="danger"><Alert.Content><Alert.Title>{t("操作未完成", "Action failed")}</Alert.Title><Alert.Description>{actionError}</Alert.Description></Alert.Content></Alert>}
    {loading && !snapshot && <div className="flex items-center gap-2 text-sm text-muted" role="status"><Spinner size="sm" />{t("加载搜索配置…", "Loading search settings…")}</div>}
    {snapshot && <div className="kulo-search-plan-scroll"><div className="kulo-search-plan-list">
      <div className="kulo-search-plan-head kulo-table-header" aria-hidden="true"><span /><span className="text-center">{t("优先级", "Priority")}</span><span>{t("方案名称", "Plan name")}</span><span>{t("搜索服务", "Search service")}</span><span>{t("状态", "Status")}</span><span className="text-center">{t("启用", "Enable")}</span><span className="text-center">{t("操作", "Actions")}</span></div>
      <GridList aria-label={t("搜索调用优先级", "Search priority")} items={rowItems} selectionMode="none" dragAndDropHooks={dragAndDropHooks} dependencies={[busy, connected, disabled, testError]} className="flex min-w-0 flex-col outline-none" renderEmptyState={() => <div className="kulo-table-empty-state">{t("尚未添加搜索方案", "No search plans added")}</div>}>
      {(plan) => {
        const localError = testError?.planId === plan.id && (testError.revision === undefined || testError.revision === plan.revision) ? testError.message : undefined;
        const failure = plan.failure?.message ?? plan.error;
        const message = localError ?? failure;
        const failed = Boolean(message) && plan.enabled;
        const testing = busy === `test:${plan.id}`;
        const ready = plan.status === "ready" && plan.enabled && !failed;
        const status = !plan.enabled ? t("已停用", "Disabled") : localError ? t("测试失败", "Test failed") : plan.failure ? FAILURE_LABELS[plan.failure.kind] : STATUS_LABELS[plan.status];
        return <GridListItem id={plan.id} textValue={plan.name} className="kulo-search-plan-item min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <div className="kulo-search-plan-row">
            <Button slot="drag" variant="ghost" size="sm" isIconOnly isDisabled={blocked} aria-label={t(`调整${plan.name}的优先级`, `Reorder ${plan.name}`)} className="shrink-0 justify-self-center cursor-grab touch-none active:cursor-grabbing"><DragHandleIcon /></Button>
            <span className="text-center text-sm tabular-nums text-muted" aria-label={t(`优先级 ${plan.priority}`, `Priority ${plan.priority}`)}>{plan.priority}</span>
            <div className="kulo-search-plan-name min-w-0">
              <span className="kulo-item-title">{plan.name}</span>
            </div>
            <div className="kulo-search-plan-service text-sm">{ADAPTER_LABELS[plan.adapter]}{(plan.adapter === "exa" && !plan.hasCredential || plan.adapter === "duckduckgo") && <span className="text-muted">  {t("· 免费", "· Free")}</span>}</div>
            <div className="kulo-search-plan-status">
              <Chip size="sm" variant="soft" color={failed ? "danger" : ready ? "success" : "default"}>{testing ? t("测试中", "Testing") : status}</Chip>
            </div>
            <Switch className="kulo-search-plan-switch justify-self-center" isSelected={plan.enabled} isDisabled={blocked} onChange={(enabled) => void toggle(plan, enabled)}><Switch.Content><Label className="sr-only">{t("启用", "Enable")}{plan.name}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch>
            <div className="kulo-search-plan-actions flex w-full items-center justify-center gap-1">
              <Button size="sm" variant="ghost" className="relative" aria-label={`${testing ? t("正在测试", "Testing ") : failed || plan.status === "ready" ? t("重新测试", "Retest ") : t("测试", "Test ")}${plan.name}`} isDisabled={!connected || disabled || Boolean(busy && !testing)} isPending={testing} onPress={() => void test(plan)}>
                <span className={testing ? "invisible" : undefined}>{t("测试", "Test ")}</span>{testing && <Spinner size="sm" color="current" className="absolute" aria-hidden="true" />}
              </Button>
              <Button size="sm" variant="ghost" aria-label={t(`编辑${plan.name}`, `Edit ${plan.name}`)} isDisabled={blocked} onPress={() => openEditor(plan)}>{t("编辑", "Edit")}</Button>
              <Button size="sm" variant="ghost" isDisabled={blocked} aria-label={t(`删除${plan.name}`, `Delete ${plan.name}`)} onPress={() => setRemove(plan)}>{t("删除", "Delete")}</Button>
            </div>
          </div>
          {message && <div className="kulo-search-plan-error mt-2 break-words text-xs text-danger" role={localError ? "alert" : undefined}>{redactSecrets(message)}</div>}
        </GridListItem>;
      }}
      </GridList>
    </div></div>}
    {busy === "order" && <span className="text-xs text-muted" role="status">{t("正在保存优先级…", "Saving priority…")}</span>}
    <Modal isOpen={Boolean(draft)} onOpenChange={(open) => { if (!open) closeEditor(); }}>
      <Modal.Backdrop isOpen={Boolean(draft)} isDismissable={!busy} isKeyboardDismissDisabled={Boolean(busy)} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <Modal.Container placement="center" size="sm" scroll="inside"><Modal.Dialog aria-label={draft?.original ? t("编辑搜索方案", "Edit search plan") : t("添加搜索方案", "Add search plan")}>
          <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="contents">
            <Modal.Header><Modal.Heading>{draft?.original ? t("编辑搜索方案", "Edit search plan") : t("添加搜索方案", "Add search plan")}</Modal.Heading><Modal.CloseTrigger aria-label={t("关闭", "Close")} isDisabled={Boolean(busy)} /></Modal.Header>
            <Modal.Body className="kulo-form-stack">
              {draft && <div className="flex min-w-0 flex-col gap-4" inert={Boolean(busy) || undefined}><SearchPlanFields draft={draft} onChange={setDraft} disabled={!connected || disabled} /></div>}
              {editorError && <Alert status="danger" role="alert"><Alert.Content>{editorError}</Alert.Content>{conflict && <Button size="sm" variant="secondary" isDisabled={Boolean(busy)} onPress={() => void reloadDraft()}>{t("载入最新配置", "Load latest settings")}</Button>}</Alert>}
            </Modal.Body>
            <Modal.Footer><Button variant="tertiary" isDisabled={Boolean(busy)} onPress={closeEditor}>{t("取消", "Cancel")}</Button><Button type="submit" className="relative" aria-label={t("保存", "Save")} isPending={busy === "save"} isDisabled={!connected || disabled || Boolean(busy && busy !== "save")}><span className={busy === "save" ? "invisible" : undefined}>{t("保存", "Save")}</span>{busy === "save" && <Spinner size="sm" color="current" className="absolute" aria-label={t("正在保存搜索方案", "Saving search plan")} />}</Button></Modal.Footer>
          </form>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop>
    </Modal>
    <ConfirmDialog open={discardEditor} title={t("放弃未保存的修改？", "Discard unsaved changes?")} confirmLabel={t("放弃", "Discard")} cancelLabel={t("继续编辑", "Keep editing")} onConfirm={() => { if (!editorSaving.current && !busy) discardDraft(); }} onCancel={() => setDiscardEditor(false)} />
    <ConfirmDialog open={Boolean(remove)} title={t(`删除“${remove?.name ?? ""}”？`, `Delete “${remove?.name ?? ""}”?`)} confirmLabel={t("删除", "Delete")} isPending={busy === "delete"} onConfirm={() => void deletePlan()} onCancel={() => setRemove(undefined)} />
  </section>;
}
