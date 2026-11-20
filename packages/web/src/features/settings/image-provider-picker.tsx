import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Checkbox, Input, Label, TextField } from "@heroui/react";
import { redactSecrets, type CapabilitiesWorkspaceSnapshot, type ImageModelCandidate, type ImageModelDiscovery } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { translate, useI18n } from "../../kulo-i18n";

export interface ImageConfigurationCardProps {
  workspace: CapabilitiesWorkspaceSnapshot;
  clientId: string;
  connected: boolean;
  disabled?: boolean;
  onChanged: () => void;
  onClose?: () => void;
}

export const imageCommandId = (operation: string) => `image-${operation}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const imageActionError = (cause: unknown) => redactSecrets(cause instanceof Error ? cause.message : translate("操作失败，请重试。", "Action failed. Please retry."));

export function selectableImageCandidateIds(discovery: ImageModelDiscovery, selected: Iterable<string>): string[] {
  const allowed = new Set(discovery.candidates.filter((candidate) => !candidate.alreadyAdded && !candidate.needsConfiguration).map((candidate) => candidate.id));
  return [...new Set(selected)].filter((id) => allowed.has(id));
}

export async function prepareImageCandidateDraft(workspace: CapabilitiesWorkspaceSnapshot, clientId: string, candidate: ImageModelCandidate) {
  if (workspace.imageSetup?.draft?.clientId === clientId) throw new Error(translate("请先保存或取消当前图像草稿。", "Save or cancel the current image draft first."));
  return kuloRest.updateImageDraft({ clientId, config: {
    adapter: candidate.adapter, modelId: candidate.modelId, name: candidate.name, baseUrl: candidate.baseUrl,
    credentialProviderId: candidate.providerId, imageProfile: candidate.imageProfile, defaults: candidate.defaults,
    customAdapter: candidate.customAdapter, enabled: true, maxOutputs: 1, allowTaskGeneration: true,
  } });
}

export function ImageProviderPicker({ workspace, clientId, connected, disabled = false, onChanged, onClose }: ImageConfigurationCardProps) {
  return <OwnedImageProviderPicker key={clientId} {...{ workspace, clientId, connected, disabled, onChanged, onClose }} />;
}

function OwnedImageProviderPicker({ workspace, clientId, connected, disabled = false, onChanged, onClose }: ImageConfigurationCardProps) {
  const { t } = useI18n();
  const incoming = workspace.imageSetup?.discovery;
  const [discovery, setDiscovery] = useState(incoming?.clientId === clientId ? incoming : undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [allowTaskGeneration, setAllowTaskGeneration] = useState(true);
  const [busy, setBusy] = useState<"discover" | "import" | "configure">();
  const [error, setError] = useState<string>();
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [added, setAdded] = useState<number>();
  const mounted = useRef(true);
  const pending = useRef(false);
  const initialSearch = useRef(false);
  const blocked = !connected || disabled || Boolean(busy) || !clientId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (incoming?.clientId !== clientId) return;
    setDiscovery((previous) => !previous || incoming.createdAt >= previous.createdAt ? incoming : previous);
  }, [incoming, clientId]);
  const search = async () => {
    if (!connected || disabled || !clientId || pending.current) return;
    pending.current = true; setBusy("discover"); setError(undefined); setImportErrors([]); setAdded(undefined);
    try {
      const next = await kuloRest.discoverImageModels(clientId);
      if (mounted.current) { setDiscovery(next); setSelected(new Set()); onChanged(); }
    } catch (cause) { if (mounted.current) setError(imageActionError(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(undefined); }
  };
  useEffect(() => {
    if (!discovery && connected && clientId && !disabled && !initialSearch.current) { initialSearch.current = true; void search(); }
  }, [connected, clientId, disabled, discovery]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (discovery?.candidates ?? []).filter((candidate) => !term || `${candidate.name} ${candidate.modelId} ${candidate.providerName}`.toLocaleLowerCase().includes(term));
  }, [discovery, query]);
  const selectedIds = discovery ? selectableImageCandidateIds(discovery, selected) : [];
  const configure = async (candidate: ImageModelCandidate) => {
    if (blocked || pending.current) return;
    pending.current = true; setBusy("configure"); setError(undefined);
    try { await prepareImageCandidateDraft(workspace, clientId, candidate); if (mounted.current) onChanged(); }
    catch (cause) { if (mounted.current) setError(imageActionError(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(undefined); }
  };
  const importSelected = async () => {
    if (blocked || pending.current || !discovery || !selectedIds.length) return;
    pending.current = true; setBusy("import"); setError(undefined); setImportErrors([]);
    try {
      const result = await kuloRest.importImageModels({ clientId, discoveryId: discovery.id, candidateIds: selectedIds, commandId: imageCommandId("import"), allowTaskGeneration });
      if (mounted.current) {
        const imported = new Set(result.added.map((capability) => `${capability.connectionId}:${capability.modelId}`));
        const failed = new Set(result.errors.map((item) => item.candidateId));
        setDiscovery({ ...discovery, candidates: discovery.candidates.map((candidate) => selectedIds.includes(candidate.id) && !failed.has(candidate.id) ? { ...candidate, alreadyAdded: true } : candidate) });
        setSelected(new Set(selectedIds.filter((id) => failed.has(id))));
        setImportErrors(result.errors.map((item) => `${discovery.candidates.find((candidate) => candidate.id === item.candidateId)?.name ?? t("图像模型", "Image model")}：${redactSecrets(item.error)}`));
        setAdded(imported.size); onChanged();
      }
    } catch (cause) { if (mounted.current) setError(imageActionError(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(undefined); }
  };
  return <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-4" aria-label={t("从已有供应商添加图像模型", "Add image models from existing providers")}>
    <Card.Header><Card.Title className="text-sm">{t("选择图像模型", "Choose image models")}</Card.Title></Card.Header>
    <Card.Content className="flex min-w-0 flex-col gap-3">
      <TextField className="kulo-context-field" variant="primary" value={query} onChange={setQuery} isDisabled={busy === "import"}>
        <Label className="sr-only">{t("搜索图像模型", "Search image models")}</Label><Input type="search" placeholder={t("搜索模型或供应商", "Search models or providers")} />
      </TextField>
      {busy === "discover" && <p className="text-xs text-muted" role="status">{t("正在读取供应商模型…", "Reading provider models…")}</p>}
      {discovery && !discovery.candidates.length && busy !== "discover" && <p className="text-sm">{t("未发现可添加的图像模型", "No image models found")}</p>}
      {discovery && discovery.candidates.length > 0 && !filtered.length && <p className="text-sm">{t("没有匹配的模型", "No matching models")}</p>}
      <div className="scrollbar flex max-h-96 min-w-0 flex-col gap-2 overflow-y-auto" role="group" aria-label={t("可添加的图像模型", "Available image models")}>
        {filtered.map((candidate) => <div key={candidate.id} className="flex min-w-0 items-start gap-2"><Checkbox className="min-w-0 flex-1" variant="primary" isSelected={selected.has(candidate.id) && !candidate.needsConfiguration} isDisabled={blocked || candidate.alreadyAdded || candidate.needsConfiguration} onChange={(checked) => setSelected((previous) => {
            const next = new Set(previous); if (checked) next.add(candidate.id); else next.delete(candidate.id); return next;
          })}>
            <Checkbox.Content className="items-start"><Checkbox.Control className="mt-1"><Checkbox.Indicator /></Checkbox.Control>
              <span className="flex min-w-0 flex-col gap-1"><span className="kulo-item-title break-words">{candidate.name}</span><span className="kulo-item-description break-words">{[candidate.providerName, candidate.modelId, candidate.alreadyAdded ? t("已添加", "Added") : candidate.needsConfiguration ? t("需配置接口", "Configure API") : ""].filter(Boolean).join(" · ")}</span>{candidate.needsConfiguration && candidate.configurationReason && <span className="text-xs text-muted">{redactSecrets(candidate.configurationReason)}</span>}</span>
            </Checkbox.Content>
          </Checkbox>
          {candidate.needsConfiguration && !candidate.alreadyAdded && <Button variant="secondary" size="sm" aria-label={t(`配置${candidate.name}`, `Configure ${candidate.name}`)} isDisabled={blocked} onPress={() => void configure(candidate)}>{t("配置", "Configure")}</Button>}
        </div>)}
      </div>
      <Checkbox variant="primary" isSelected={allowTaskGeneration} onChange={setAllowTaskGeneration} isDisabled={blocked}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{t("允许 Kulo 按需调用所选模型", "Allow Kulo to use selected models as needed")}</Checkbox.Content></Checkbox>
      {discovery?.errors.map((failure) => <p key={failure.providerId} role="status" className="break-words text-xs text-warning">{failure.providerName}：{redactSecrets(failure.error)}</p>)}
      {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
      {importErrors.map((message) => <p key={message} role="alert" className="break-words text-xs text-danger">{message}</p>)}
      {added !== undefined && added > 0 && <p role="status" className="text-xs text-muted">{t(`已添加 ${added} 个图像模型`, `Added ${added} image models`)}</p>}
    </Card.Content>
    <Card.Footer className="flex-wrap justify-end gap-2">
      {onClose && <Button variant="tertiary" size="sm" isDisabled={Boolean(busy)} onPress={onClose}>{t("关闭", "Close")}</Button>}
      <Button variant="ghost" size="sm" isPending={busy === "discover"} isDisabled={blocked} onPress={() => void search()}>{t("重新搜索", "Search again")}</Button>
      <Button variant="primary" size="sm" isPending={busy === "import"} isDisabled={blocked || !selectedIds.length} onPress={() => void importSelected()}>{t(`添加所选（${selectedIds.length}）`, `Add selected (${selectedIds.length})`)}</Button>
    </Card.Footer>
  </Card>;
}
