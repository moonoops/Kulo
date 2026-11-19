import { useI18n, translate } from "../../moco-i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, CheckboxGroup, Chip, Label, Modal, Skeleton, Switch, Table } from "@heroui/react";
import { redactSecrets, type SkillAudience, type SkillRecord, type SkillSnapshot } from "@moco/protocol";
import { MocoApiError, mocoRest } from "../../moco-api";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { useSettingsPending } from "./settings-save-activity";
import { SettingsSection } from "./settings-layout";
import { IMPORT_SKILL_PROMPT } from "./capability-views";

type SkillSettings = Pick<SkillRecord, "enabled" | "audiences">;
type SkillDraft = SkillSettings & { record: SkillRecord; expectedRevision: number };
type SkillRemoval = { record: SkillRecord; expectedRevision: number };
const requiredSkill = (skill: SkillRecord) => skill.id === "capability-setup";
const commandId = () => `skill-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const report = (cause: unknown) => redactSecrets(cause instanceof Error ? cause.message : translate("技能操作失败，请重试。", "Skill action failed. Please retry."));

export function skillStatusLabel(skill: SkillRecord): string {
  return !skill.enabled ? translate("已停用", "Disabled") : skill.diagnostics.length ? translate("需处理", "Needs attention") : translate("已启用", "Enabled");
}

export function acceptSkillSnapshot(previous: SkillSnapshot | null, next: SkillSnapshot): SkillSnapshot {
  return !previous || next.revision > previous.revision ? next : previous;
}

export function skillDraftDirty(draft: (SkillSettings & { record: SkillRecord }) | undefined): boolean {
  return Boolean(draft && (draft.enabled !== draft.record.enabled || draft.audiences.length !== draft.record.audiences.length || draft.audiences.some((audience) => !draft.record.audiences.includes(audience))));
}

export function SkillSettingsFields({ value, onChange, disabled = false }: {
  value: SkillSettings;
  onChange: (value: SkillSettings) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const AUDIENCES: Array<{ id: SkillAudience; label: string }> = [
    { id: "chat", label: t("主聊天", "Chat") }, { id: "worker", label: t("后台任务", "Background tasks") }, { id: "settings", label: t("设置助手", "Settings assistant") },
  ];
  return <div className="moco-form-stack">
    <Switch className="w-full" isSelected={value.enabled} isDisabled={disabled} onChange={(enabled) => onChange({ ...value, enabled })}>
      <Switch.Content className="moco-form-toggle"><Label>{t("启用技能", "Enable skill")}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
    </Switch>
    <CheckboxGroup className="moco-form-field" value={value.audiences} onChange={(selected) => onChange({ ...value, audiences: selected as SkillAudience[] })} isDisabled={disabled} isRequired>
      <Label>{t("使用范围", "Available in")}</Label>
      <div className="flex flex-col gap-3">
        {AUDIENCES.map(({ id, label }) => <Checkbox key={id} value={id} variant="secondary"><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{label}</Checkbox.Content></Checkbox>)}
      </div>
    </CheckboxGroup>
  </div>;
}

interface SkillsModuleProps {
  snapshot: SkillSnapshot | null;
  connected: boolean;
  disabled?: boolean;
  onRequest?: (target?: { kind: "skill"; id: string }, prompt?: string) => void;
  onRefresh: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function SkillsModule(props: SkillsModuleProps) {
  // Clearing the owning workspace ends its local cache and pending UI operations together.
  return <SkillsWorkspace key={props.snapshot === null ? "unloaded" : "loaded"} {...props} />;
}

function SkillsWorkspace({ snapshot: incoming, connected, disabled = false, onRequest, onRefresh, onDirtyChange }: SkillsModuleProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState(incoming);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [draft, setDraft] = useState<SkillDraft>();
  const [discardEditor, setDiscardEditor] = useState(false);
  const draftDirty = skillDraftDirty(draft);
  useSettingsPending(busy === "save" || Boolean(busy?.startsWith("toggle:")));
  useEffect(() => { onDirtyChange?.(draftDirty); }, [draftDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const [editorError, setEditorError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [remove, setRemove] = useState<SkillRemoval>();
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const switches = useRef(new Map<string, HTMLElement>());
  const blocked = !connected || disabled || Boolean(busy);
  const accept = useCallback((next: SkillSnapshot) => setSnapshot((previous) => acceptSkillSnapshot(previous, next)), []);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (incoming) accept(incoming); }, [incoming, accept]);
  const begin = (operation: string) => {
    if (!connected || disabled || busyRef.current) return false;
    busyRef.current = true; setBusy(operation); return true;
  };
  const finish = () => { busyRef.current = false; if (mounted.current) setBusy(undefined); };
  const focusButton = (map: Map<string, HTMLButtonElement>, id: string) => requestAnimationFrame(() => (map.get(id) ?? importButton.current)?.focus());
  const discardDraft = () => {
    setDiscardEditor(false);
    const id = draft?.record.id;
    setDraft(undefined); setEditorError(undefined); setConflict(false);
    if (id) focusButton(editButtons.current, id);
  };
  const closeEditor = () => {
    if (busyRef.current) return;
    if (draftDirty) setDiscardEditor(true);
    else discardDraft();
  };
  const openEditor = (skill: SkillRecord) => {
    if (!snapshot || blocked || requiredSkill(skill)) return;
    setDraft({ record: skill, enabled: skill.enabled, audiences: [...skill.audiences], expectedRevision: snapshot.revision });
    setEditorError(undefined); setConflict(false);
  };
  const save = async () => {
    if (!draft || !draft.audiences.length) { setEditorError(t("请至少选择一个使用范围。", "Select at least one audience.")); return; }
    if (!begin("save")) return;
    try {
      const next = await mocoRest.updateSkill(draft.record.id, { enabled: draft.enabled, audiences: draft.audiences, expectedRevision: draft.expectedRevision, commandId: commandId() });
      if (mounted.current) {
        accept(next); setDraft(undefined); setEditorError(undefined); setConflict(false); setError(undefined);
        onRefresh(); focusButton(editButtons.current, draft.record.id);
      }
    } catch (cause) {
      if (mounted.current) { setEditorError(report(cause)); setConflict(cause instanceof MocoApiError && cause.status === 409); }
    } finally { finish(); }
  };
  const reloadDraft = async () => {
    if (!draft || !begin("reload")) return;
    try {
      const next = await mocoRest.getSkills();
      const record = next.skills.find((skill) => skill.id === draft.record.id);
      if (mounted.current) {
        accept(next);
        if (!record) { setEditorError(t("此技能已被删除。", "This skill has been deleted.")); return; }
        setDraft({ record, enabled: record.enabled, audiences: [...record.audiences], expectedRevision: next.revision });
        setEditorError(undefined); setConflict(false);
      }
    } catch (cause) { if (mounted.current) setEditorError(report(cause)); }
    finally { finish(); }
  };
  const toggle = async (skill: SkillRecord, enabled: boolean) => {
    if (!snapshot || requiredSkill(skill) || !begin(`toggle:${skill.id}`)) return;
    setError(undefined);
    try {
      const next = await mocoRest.updateSkill(skill.id, { enabled, expectedRevision: snapshot.revision, commandId: commandId() });
      if (mounted.current) { accept(next); onRefresh(); }
    } catch (cause) { if (mounted.current) { setError(report(cause)); onRefresh(); } }
    finally {
      finish();
      if (mounted.current) requestAnimationFrame(() => switches.current.get(skill.id)?.querySelector<HTMLInputElement>("input")?.focus());
    }
  };
  const cancelRemove = () => {
    if (busyRef.current) return;
    const id = remove?.record.id; setRemove(undefined);
    if (id) focusButton(deleteButtons.current, id);
  };
  const deleteSkill = async () => {
    if (!snapshot || !remove || remove.record.source === "builtin" || !begin(`delete:${remove.record.id}`)) return;
    const index = snapshot.skills.findIndex((skill) => skill.id === remove.record.id);
    setError(undefined);
    try {
      const next = await mocoRest.deleteSkill(remove.record.id, { expectedRevision: remove.expectedRevision, commandId: commandId() });
      if (mounted.current) {
        accept(next); setRemove(undefined); onRefresh();
        const nextId = next.skills[Math.min(index, next.skills.length - 1)]?.id;
        requestAnimationFrame(() => (nextId ? editButtons.current.get(nextId) : importButton.current)?.focus());
      }
    } catch (cause) {
      if (mounted.current) { setError(report(cause)); setRemove(undefined); onRefresh(); focusButton(deleteButtons.current, remove.record.id); }
    } finally { finish(); }
  };

  return <SettingsSection title={t("技能", "Skills")} action={<Button ref={importButton} variant="secondary" size="sm" isDisabled={blocked || !onRequest} onPress={() => onRequest?.(undefined, IMPORT_SKILL_PROMPT)}>{t("导入技能", "Import skill")}</Button>}>
    {error && <Alert status="danger" role="alert"><Alert.Content>{error}</Alert.Content><Button size="sm" variant="ghost" isDisabled={blocked} onPress={onRefresh}>{t("刷新", "Refresh")}</Button></Alert>}
    <Table variant="secondary" className="moco-settings-table moco-capabilities-table" aria-busy={Boolean(busy) || undefined}>
      <Table.ScrollContainer className="moco-settings-table-scroll">
        <Table.Content aria-label={t("技能列表", "Skills")} selectionMode="none" keyboardNavigationBehavior="tab" className="moco-settings-table-content moco-skills-table-content">
          <Table.Header>
            <Table.Column id="name" isRowHeader className="moco-settings-table-column">{t("技能", "Skills")}</Table.Column>
            <Table.Column id="source" className="moco-settings-table-column moco-settings-table-meta">{t("来源", "Source")}</Table.Column>
            <Table.Column id="status" className="moco-settings-table-column moco-settings-table-meta">{t("状态", "Status")}</Table.Column>
            <Table.Column id="enabled" className="moco-settings-table-column moco-settings-table-toggle">{t("启用", "Enable")}</Table.Column>
            <Table.Column id="actions" className="moco-settings-table-column moco-settings-table-actions">{t("操作", "Actions")}</Table.Column>
          </Table.Header>
          <Table.Body renderEmptyState={() => snapshot ? <div className="moco-table-empty-state">{t("尚无技能", "No skills")}</div> : !connected ? <div className="moco-table-empty-state">{t("等待连接", "Waiting for connection")}</div> : <div className="moco-table-empty-state w-full gap-4" role="status" aria-label={t("加载技能", "Loading skills")}><Skeleton animationType="none" className="h-3 w-32" /><Skeleton animationType="none" className="h-3 w-16" /></div>}>
            {(snapshot?.skills ?? []).map((skill) => {
              const required = requiredSkill(skill);
              const protectedReason = required ? t("能力配置指引是系统必需技能。", "The capability setup guide is required by the system.") : t("内置技能随应用维护，不能删除。", "Built-in skills are maintained with the app and cannot be deleted.");
              return <Table.Row key={skill.id} id={skill.id} textValue={skill.name}>
                <Table.Cell className="moco-settings-table-cell">
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <span className="moco-item-title break-words">{skill.name}</span>
                    <span className="moco-item-description break-words">{skill.description}</span>
                    {skill.diagnostics.length > 0 && <span className="break-words text-xs text-warning">{skill.diagnostics.map((message) => redactSecrets(message)).join(" · ")}</span>}
                  </div>
                </Table.Cell>
                <Table.Cell className="moco-settings-table-cell moco-settings-table-meta"><span title={skill.source === "builtin" ? protectedReason : undefined}>{required ? t("系统必需", "Required") : skill.source === "builtin" ? t("内置", "Built-in") : skill.source === "git" ? "Git" : t("本地导入", "Local import")}</span></Table.Cell>
                <Table.Cell className="moco-settings-table-cell moco-settings-table-meta"><Chip size="sm" variant="soft" color={!skill.enabled ? "default" : skill.diagnostics.length ? "warning" : "success"}>{skillStatusLabel(skill)}</Chip></Table.Cell>
                <Table.Cell className="moco-settings-table-cell moco-settings-table-toggle">
                  <div className="moco-settings-table-toggle-group"><Switch ref={(node) => { if (node) switches.current.set(skill.id, node); else switches.current.delete(skill.id); }} size="sm" isSelected={skill.enabled} isDisabled={blocked || required} aria-description={required ? protectedReason : undefined} onChange={(enabled) => void toggle(skill, enabled)}><Switch.Content><Label className="sr-only">{t("启用", "Enable")}{skill.name}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch></div>
                </Table.Cell>
                <Table.Cell className="moco-settings-table-cell moco-settings-table-actions">
                  <div className="moco-settings-table-action-group">
                    <Button ref={(node) => { if (node) editButtons.current.set(skill.id, node); else editButtons.current.delete(skill.id); }} size="sm" variant="ghost" aria-label={t(`编辑${skill.name}`, `Edit ${skill.name}`)} aria-description={required ? protectedReason : undefined} isDisabled={blocked || required} onPress={() => openEditor(skill)}>{t("编辑", "Edit")}</Button>
                    <Button ref={(node) => { if (node) deleteButtons.current.set(skill.id, node); else deleteButtons.current.delete(skill.id); }} size="sm" variant="ghost" aria-label={t(`删除${skill.name}`, `Delete ${skill.name}`)} aria-description={skill.source === "builtin" ? protectedReason : undefined} isDisabled={blocked || skill.source === "builtin"} onPress={() => { if (snapshot) setRemove({ record: skill, expectedRevision: snapshot.revision }); }}>{t("删除", "Delete")}</Button>
                  </div>
                </Table.Cell>
              </Table.Row>;
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
    <Modal isOpen={Boolean(draft)} onOpenChange={(open) => { if (!open) closeEditor(); }}>
      <Modal.Backdrop isOpen={Boolean(draft)} isDismissable={!busy} isKeyboardDismissDisabled={Boolean(busy)} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <Modal.Container size="sm" placement="center" scroll="inside"><Modal.Dialog aria-label={t(`编辑${draft?.record.name ?? t("技能", "Skills")}`, `Edit ${draft?.record.name ?? t("技能", "Skills")}`)}>
          <form className="contents" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <Modal.Header><Modal.Heading>{t("编辑", "Edit")}{draft?.record.name ?? t("技能", "Skills")}</Modal.Heading><Modal.CloseTrigger aria-label={t("关闭", "Close")} isDisabled={Boolean(busy)} /></Modal.Header>
            <Modal.Body className="flex min-w-0 flex-col gap-4">
              {draft && <SkillSettingsFields value={draft} disabled={!connected || disabled || Boolean(busy)} onChange={(value) => setDraft({ ...draft, ...value })} />}
              {editorError && <Alert status="danger" role="alert"><Alert.Content>{editorError}</Alert.Content>{conflict && <Button variant="ghost" size="sm" isDisabled={blocked} onPress={() => void reloadDraft()}>{t("载入最新设置", "Load latest settings")}</Button>}</Alert>}
            </Modal.Body>
            <Modal.Footer><Button variant="tertiary" isDisabled={Boolean(busy)} onPress={closeEditor}>{t("取消", "Cancel")}</Button><Button type="submit" isPending={busy === "save"} isDisabled={!connected || disabled || Boolean(busy) || !draft?.audiences.length || Boolean(snapshot && draft && !snapshot.skills.some((skill) => skill.id === draft.record.id))}>{t("保存", "Save")}</Button></Modal.Footer>
          </form>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop>
    </Modal>
    <ConfirmDialog open={discardEditor} title={t("放弃未保存的修改？", "Discard unsaved changes?")} confirmLabel={t("放弃", "Discard")} cancelLabel={t("继续编辑", "Keep editing")} onConfirm={() => { if (!busyRef.current) discardDraft(); }} onCancel={() => setDiscardEditor(false)} />
    <ConfirmDialog open={Boolean(remove)} title={t(`删除${remove?.record.name ?? t("技能", "Skills")}？`, `Delete ${remove?.record.name ?? t("技能", "Skills")}?`)} description={t("移出技能列表，不会删除原始来源文件。", "Remove from the skill list. Source files will be kept.")} confirmLabel={t("删除", "Delete")} isPending={Boolean(busy)} isConfirmDisabled={!connected || disabled} onCancel={cancelRemove} onConfirm={() => void deleteSkill()} />
  </SettingsSection>;
}
