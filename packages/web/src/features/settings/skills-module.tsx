import { useI18n, translate, type KuloLanguage } from "../../kulo-i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, CheckboxGroup, Chip, Label, Modal, Skeleton, Switch, Table } from "@heroui/react";
import { redactSecrets, type SkillAudience, type SkillRecord, type SkillSnapshot } from "@kulo/protocol";
import { KuloApiError, kuloRest } from "../../kulo-api";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { useSettingsPending } from "./settings-save-activity";
import { SettingsSection } from "./settings-layout";
import { getImportSkillPrompt } from "./capability-views";

const BUILTIN_SKILL_DESCRIPTIONS: Readonly<Record<string, Readonly<Record<KuloLanguage, string>>>> = {
  "genui-cards": {
    "zh-CN": "使用 HeroUI v3 规范构建交互式结构化卡片，支持多元素表单、表格选择、图表与标签页布局。",
    en: "Component specification and layout rules for interactive structured HeroUI v3 cards, including forms, table selection, charts, and tabbed views.",
  },
  "interactive-html": {
    "zh-CN": "设计与交付离线自包含的交互式 HTML 作品（可视化、图表、仪表盘、原型），可在 Kulo 沙盒预览中清晰呈现。",
    en: "Design and deliver self-contained offline interactive HTML deliverables (visualizations, diagrams, dashboards, prototypes) for Kulo's sandboxed preview.",
  },
  "image-generation": {
    "zh-CN": "使用已配置的图像能力生成或编辑图片、项目素材与支持的 GIF，覆盖参考图、迭代修图与工作区导出。",
    en: "Generate or edit images, project assets, and supported GIFs with configured image capabilities, handling reference images, iterative edits, and workspace export.",
  },
  "video-generation": {
    "zh-CN": "使用已配置的视频能力规划分镜提示词、参考素材、Flow 会员生成、长耗时任务跟踪与结果交付。",
    en: "Plan prompts/storyboards, reference assets, Flow membership generation, long-running job tracking, and delivery with configured video capabilities.",
  },
  "browser-automation": {
    "zh-CN": "在绑定执行设备上安全执行网页导航、页面读取、表单填写与快照核验。",
    en: "Automate web navigation, page reading, form filling, and snapshot verification on the bound execution device.",
  },
  "desktop-automation": {
    "zh-CN": "检查绑定设备原生应用的辅助功能树并执行点击、输入与逐步核验，涵盖 macOS、Linux 与 Windows。",
    en: "Inspect native app accessibility trees, click, enter values, and verify every step on the bound execution device across macOS, Linux, and Windows.",
  },
  "android-automation": {
    "zh-CN": "通过类型化 Android 工具可靠操作已绑定手机，涵盖界面观察、无障碍交互、核验与权限交接。",
    en: "Operate bound Android phones reliably via typed Android tools, covering observation, accessibility-first interaction, verification, and permission handoffs.",
  },
  "kulo-ui-customization": {
    "zh-CN": "按用户明确要求安全修改 Kulo Web 界面源码的工作流与 HeroUI v3 设计约束。",
    en: "Safe workflow and HeroUI v3 design invariants for modifying Kulo's own Web UI source when explicitly requested by the user.",
  },
  "hindsight-knowledge": {
    "zh-CN": "使用 Pages、Mental Models、Reflect 与日期化纠偏系统性整理 Hindsight 长期记忆。",
    en: "Structured workflow for organizing Hindsight long-term memory with Pages, Mental Models, Reflect, async operation checks, and dated corrections.",
  },
  "capability-setup": {
    "zh-CN": "在「工具技能」设置页通过受控工具检查并配置多模态能力、电脑操控、技能与扩展。",
    en: "Configure, inspect, and manage multimodal capabilities, Computer Use, Skills, and extensions on the Tools & Skills settings page.",
  },
  "agent-configuration": {
    "zh-CN": "在「智能体」设置页通过分步引导连接本地外部 Agent 客户端并保存委派配置。",
    en: "Connect local external Agent clients on the Agents settings page through guided setup and save dispatch configuration.",
  },
};

export function localizedSkillDescription(
  skill: Pick<SkillRecord, "id" | "source" | "description">,
  language?: KuloLanguage,
): string {
  if (skill.source !== "builtin") return skill.description;
  const localized = BUILTIN_SKILL_DESCRIPTIONS[skill.id];
  if (!localized) return skill.description;
  return language ? localized[language] : translate(localized["zh-CN"], localized.en);
}

type SkillSettings = Pick<SkillRecord, "enabled" | "audiences">;
type SkillDraft = SkillSettings & { record: SkillRecord; expectedRevision: number };
type SkillRemoval = { record: SkillRecord; expectedRevision: number };
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
  return <div className="kulo-form-stack">
    <Switch className="w-full" isSelected={value.enabled} isDisabled={disabled} onChange={(enabled) => onChange({ ...value, enabled })}>
      <Switch.Content className="kulo-form-toggle"><Label>{t("启用技能", "Enable skill")}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
    </Switch>
    <CheckboxGroup className="kulo-form-field" value={value.audiences} onChange={(selected) => onChange({ ...value, audiences: selected as SkillAudience[] })} isDisabled={disabled} isRequired>
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
  const { t, language } = useI18n();
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
    if (!snapshot || blocked) return;
    setDraft({ record: skill, enabled: skill.enabled, audiences: [...skill.audiences], expectedRevision: snapshot.revision });
    setEditorError(undefined); setConflict(false);
  };
  const save = async () => {
    if (!draft || !draft.audiences.length) { setEditorError(t("请至少选择一个使用范围。", "Select at least one audience.")); return; }
    if (!begin("save")) return;
    try {
      const next = await kuloRest.updateSkill(draft.record.id, { enabled: draft.enabled, audiences: draft.audiences, expectedRevision: draft.expectedRevision, commandId: commandId() });
      if (mounted.current) {
        accept(next); setDraft(undefined); setEditorError(undefined); setConflict(false); setError(undefined);
        onRefresh(); focusButton(editButtons.current, draft.record.id);
      }
    } catch (cause) {
      if (mounted.current) { setEditorError(report(cause)); setConflict(cause instanceof KuloApiError && cause.status === 409); }
    } finally { finish(); }
  };
  const reloadDraft = async () => {
    if (!draft || !begin("reload")) return;
    try {
      const next = await kuloRest.getSkills();
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
    if (!snapshot || !begin(`toggle:${skill.id}`)) return;
    setError(undefined);
    try {
      const next = await kuloRest.updateSkill(skill.id, { enabled, expectedRevision: snapshot.revision, commandId: commandId() });
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
      const next = await kuloRest.deleteSkill(remove.record.id, { expectedRevision: remove.expectedRevision, commandId: commandId() });
      if (mounted.current) {
        accept(next); setRemove(undefined); onRefresh();
        const nextId = next.skills[Math.min(index, next.skills.length - 1)]?.id;
        requestAnimationFrame(() => (nextId ? editButtons.current.get(nextId) : importButton.current)?.focus());
      }
    } catch (cause) {
      if (mounted.current) { setError(report(cause)); setRemove(undefined); onRefresh(); focusButton(deleteButtons.current, remove.record.id); }
    } finally { finish(); }
  };

  return <SettingsSection title={t("技能", "Skills")} action={<Button ref={importButton} variant="secondary" size="sm" isDisabled={blocked || !onRequest} onPress={() => onRequest?.(undefined, getImportSkillPrompt(language))}>{t("导入技能", "Import skill")}</Button>}>
    {error && <Alert status="danger" role="alert"><Alert.Content>{error}</Alert.Content><Button size="sm" variant="ghost" isDisabled={blocked} onPress={onRefresh}>{t("刷新", "Refresh")}</Button></Alert>}
    <Table variant="secondary" className="kulo-settings-table kulo-capabilities-table" aria-busy={Boolean(busy) || undefined}>
      <Table.ScrollContainer className="kulo-settings-table-scroll">
        <Table.Content aria-label={t("技能列表", "Skills")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content kulo-skills-table-content">
          <Table.Header>
            <Table.Column id="name" isRowHeader className="kulo-settings-table-column kulo-settings-table-primary">{t("技能", "Skills")}</Table.Column>
            <Table.Column id="source" className="kulo-settings-table-column kulo-settings-table-meta">{t("来源", "Source")}</Table.Column>
            <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-meta">{t("状态", "Status")}</Table.Column>
            <Table.Column id="enabled" className="kulo-settings-table-column kulo-settings-table-toggle">{t("启用", "Enable")}</Table.Column>
            <Table.Column id="actions" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column>
          </Table.Header>
          <Table.Body renderEmptyState={() => snapshot ? <div className="kulo-table-empty-state">{t("尚无技能", "No skills")}</div> : !connected ? <div className="kulo-table-empty-state">{t("等待连接", "Waiting for connection")}</div> : <div className="kulo-table-empty-state w-full gap-4" role="status" aria-label={t("加载技能", "Loading skills")}><Skeleton animationType="none" className="h-3 w-32" /><Skeleton animationType="none" className="h-3 w-16" /></div>}>
            {(snapshot?.skills ?? []).map((skill) => {
              const protectedReason = t("内置技能随应用维护，不能删除。", "Built-in skills are maintained with the app and cannot be deleted.");
              return <Table.Row key={skill.id} id={skill.id} textValue={skill.name}>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-primary">
                  <div className="kulo-settings-table-stack">
                    <span className="kulo-item-title">{skill.name}</span>
                    <span className="kulo-item-description">{localizedSkillDescription(skill, language)}</span>
                    {skill.diagnostics.length > 0 && <span className="break-words text-xs text-warning">{skill.diagnostics.map((message) => redactSecrets(message)).join(" · ")}</span>}
                  </div>
                </Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta"><span title={skill.source === "builtin" ? protectedReason : undefined}>{skill.source === "builtin" ? t("内置", "Built-in") : skill.source === "git" ? "Git" : t("本地导入", "Local import")}</span></Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta"><Chip size="sm" variant="soft" color={!skill.enabled ? "default" : skill.diagnostics.length ? "warning" : "success"}>{skillStatusLabel(skill)}</Chip></Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-toggle">
                  <div className="kulo-settings-table-toggle-group"><Switch ref={(node) => { if (node) switches.current.set(skill.id, node); else switches.current.delete(skill.id); }} size="sm" isSelected={skill.enabled} isDisabled={blocked} onChange={(enabled) => void toggle(skill, enabled)}><Switch.Content><Label className="sr-only">{t("启用", "Enable")}{skill.name}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch></div>
                </Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-actions">
                  <div className="kulo-settings-table-action-group">
                    <Button ref={(node) => { if (node) editButtons.current.set(skill.id, node); else editButtons.current.delete(skill.id); }} size="sm" variant="ghost" aria-label={t(`编辑${skill.name}`, `Edit ${skill.name}`)} isDisabled={blocked} onPress={() => openEditor(skill)}>{t("编辑", "Edit")}</Button>
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
            <Modal.Header><Modal.Heading>{t(`编辑${draft?.record.name ?? "技能"}`, `Edit ${draft?.record.name ?? "skill"}`)}</Modal.Heading><Modal.CloseTrigger aria-label={t("关闭", "Close")} isDisabled={Boolean(busy)} /></Modal.Header>
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
