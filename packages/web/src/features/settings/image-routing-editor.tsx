import { useEffect, useState } from "react";
import { Button, Card, Checkbox, CheckboxGroup, Label, Table } from "@heroui/react";
import { type ImageIntent, type ImagePreference, type ImageRoutingRule, type ImageRoutingSettings, type MediaOutputFormat } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { useI18n } from "../../kulo-i18n";
import { ImageSelect, ImageText, ImageToggle } from "./image-fields";
import { imageActionError, imageCommandId, type ImageConfigurationCardProps } from "./image-provider-picker";

export const DEFAULT_IMAGE_ROUTING: ImageRoutingSettings = { mode: "auto", preference: "balanced", instructions: "", rules: [] };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function moveImageRoutingRule(rules: ImageRoutingRule[], id: string, direction: -1 | 1): ImageRoutingRule[] {
  const index = rules.findIndex((rule) => rule.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= rules.length) return rules;
  const next = [...rules]; [next[index], next[target]] = [next[target]!, next[index]!]; return next;
}

export function ImageRoutingEditor({ workspace, connected, disabled = false, onChanged, onClose }: ImageConfigurationCardProps) {
  const { t } = useI18n();
  const [settings, setSettings] = useState(() => clone(workspace.imageRouting ?? DEFAULT_IMAGE_ROUTING));
  const [revision, setRevision] = useState(workspace.revision);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const blocked = !connected || disabled || busy;
  const capabilities = workspace.capabilities.filter((capability) => capability.kind === "image");
  const modelOptions = capabilities.map((capability) => ({ id: capability.id, label: capability.name }));
  const preferences = [{ id: "balanced", label: t("均衡", "Balanced") }, { id: "speed", label: t("速度优先", "Prefer speed") }, { id: "quality", label: t("质量优先", "Prefer quality") }, { id: "cost", label: t("成本优先", "Prefer lower cost") }];
  const intents: Array<{ id: ImageIntent; label: string }> = [{ id: "generate", label: t("生图", "Generate") }, { id: "edit", label: t("图片编辑", "Edit") }, { id: "animate", label: t("动图", "Animation") }, { id: "vector", label: t("矢量图", "Vector") }];
  const update = (next: ImageRoutingSettings) => { setSettings(next); setDirty(true); setError(undefined); };
  useEffect(() => {
    if (!dirty && workspace.revision !== revision) { setSettings(clone(workspace.imageRouting ?? DEFAULT_IMAGE_ROUTING)); setRevision(workspace.revision); }
  }, [workspace.imageRouting, workspace.revision, dirty, revision]);
  const save = async () => {
    if (blocked || !dirty) return;
    setBusy(true); setError(undefined);
    try { await kuloRest.saveImageRouting(settings, revision, imageCommandId("routing")); setDirty(false); onChanged(); onClose?.(); }
    catch (cause) { setError(imageActionError(cause)); }
    finally { setBusy(false); }
  };
  const selectedRule = settings.rules.find((rule) => rule.id === editing);
  const updateRule = (rule: ImageRoutingRule) => update({ ...settings, rules: settings.rules.map((item) => item.id === rule.id ? rule : item) });
  const condition = (rule: ImageRoutingRule) => [...(rule.intents ?? []).map((intent) => intents.find((item) => item.id === intent)?.label ?? intent), ...(rule.formats ?? []).map((format) => format.toUpperCase()), ...(rule.keywords ?? [])].join(" · ") || t("所有任务", "All tasks");
  return <Card variant="secondary" className="min-w-0 gap-4 rounded-2xl p-4" aria-label={t("图像模型调用规则", "Image model selection rules")}>
    <Card.Header><Card.Title className="text-lg">{t("调用规则", "Selection rules")}</Card.Title></Card.Header>
    <Card.Content className="kulo-form-stack">
      <ImageSelect label={t("模型选择", "Model selection")} value={settings.mode} disabled={blocked} options={[{ id: "auto", label: t("由 Kulo 自动判断", "Let Kulo choose") }, { id: "default", label: t("始终使用默认模型", "Always use the default model") }]} onChange={(mode) => update({ ...settings, mode: mode as ImageRoutingSettings["mode"] })} />
      <ImageSelect label={t("默认偏好", "Default preference")} value={settings.preference} disabled={blocked || settings.mode !== "auto"} options={preferences} onChange={(preference) => update({ ...settings, preference: preference as ImagePreference })} />
      <ImageText label={t("选择偏好", "Selection guidance")} value={settings.instructions} disabled={blocked} multiline onChange={(instructions) => update({ ...settings, instructions })} placeholder={t("例如：文字较多的海报优先用 Sunburst", "For example: prefer Sunburst for posters with lots of text")} />
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="kulo-group-title">{t("指定规则", "Specific rules")}</h3><Button variant="ghost" size="sm" isDisabled={blocked || !capabilities.length || settings.mode !== "auto"} onPress={() => {
        const id = imageCommandId("rule"); update({ ...settings, rules: [...settings.rules, { id, name: t("新规则", "New rule"), capabilityId: capabilities.find((item) => item.enabled)?.id ?? capabilities[0]!.id, enabled: true }] }); setEditing(id);
      }}>{t("添加规则", "Add rule")}</Button></div>
      {settings.rules.length > 0 && <Table variant="secondary" className="kulo-settings-table"><Table.ScrollContainer className="kulo-settings-table-scroll"><Table.Content aria-label={t("图像调用规则列表", "Image selection rule list")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content kulo-settings-table-content--wide">
        <Table.Header><Table.Column id="rule" isRowHeader className="kulo-settings-table-column kulo-settings-table-primary">{t("规则", "Rule")}</Table.Column><Table.Column id="model" className="kulo-settings-table-column kulo-settings-table-primary">{t("模型", "Model")}</Table.Column><Table.Column id="matches" className="kulo-settings-table-column kulo-settings-table-detail">{t("匹配", "Matches")}</Table.Column><Table.Column id="actions" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column></Table.Header>
        <Table.Body>{settings.rules.map((rule, index) => <Table.Row key={rule.id} id={rule.id} textValue={rule.name}><Table.Cell className="kulo-settings-table-cell kulo-settings-table-primary"><div className="kulo-settings-table-stack"><span className="kulo-item-title">{rule.name}</span>{!rule.enabled && <span className="kulo-item-description">{t("已停用", "Disabled")}</span>}</div></Table.Cell><Table.Cell className="kulo-settings-table-cell kulo-settings-table-primary"><div className="kulo-settings-table-stack"><span className="break-words text-sm">{capabilities.find((capability) => capability.id === rule.capabilityId)?.name ?? t("模型已移除", "Model removed")}</span></div></Table.Cell><Table.Cell className="kulo-settings-table-cell kulo-settings-table-detail"><span className="break-words text-sm text-muted">{condition(rule)}</span></Table.Cell><Table.Cell className="kulo-settings-table-cell kulo-settings-table-actions"><div className="kulo-settings-table-action-group"><Button size="sm" variant="ghost" aria-label={t(`编辑规则${rule.name}`, `Edit rule ${rule.name}`)} isDisabled={blocked} onPress={() => setEditing(editing === rule.id ? undefined : rule.id)}>{t("编辑", "Edit")}</Button><Button size="sm" variant="ghost" aria-label={t(`上移规则${rule.name}`, `Move rule ${rule.name} up`)} isDisabled={blocked || index === 0} onPress={() => update({ ...settings, rules: moveImageRoutingRule(settings.rules, rule.id, -1) })}>{t("上移", "Up")}</Button><Button size="sm" variant="ghost" aria-label={t(`下移规则${rule.name}`, `Move rule ${rule.name} down`)} isDisabled={blocked || index === settings.rules.length - 1} onPress={() => update({ ...settings, rules: moveImageRoutingRule(settings.rules, rule.id, 1) })}>{t("下移", "Down")}</Button><Button size="sm" variant="ghost" aria-label={t(`移除规则${rule.name}`, `Remove rule ${rule.name}`)} isDisabled={blocked} onPress={() => { update({ ...settings, rules: settings.rules.filter((item) => item.id !== rule.id) }); if (editing === rule.id) setEditing(undefined); }}>{t("移除", "Remove")}</Button></div></Table.Cell></Table.Row>)}</Table.Body>
      </Table.Content></Table.ScrollContainer></Table>}
      {selectedRule && <div className="kulo-form-stack rounded-xl bg-surface-secondary p-4" aria-label={t("编辑调用规则", "Edit selection rule")}>
        <ImageText label={t("规则名称", "Rule name")} value={selectedRule.name} disabled={blocked} onChange={(name) => updateRule({ ...selectedRule, name })} />
        <ImageSelect label={t("使用模型", "Use model")} value={selectedRule.capabilityId} disabled={blocked} options={modelOptions} onChange={(capabilityId) => updateRule({ ...selectedRule, capabilityId })} />
        <CheckboxGroup className="kulo-form-field" value={selectedRule.intents ?? []} isDisabled={blocked} onChange={(values) => updateRule({ ...selectedRule, intents: values as ImageIntent[] })}><Label>{t("任务类型", "Task type")}</Label><div className="flex flex-wrap gap-3">{intents.map((intent) => <Checkbox key={intent.id} value={intent.id} variant="secondary"><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{intent.label}</Checkbox.Content></Checkbox>)}</div></CheckboxGroup>
        <ImageText label={t("关键词", "Keywords")} value={selectedRule.keywords?.join("、") ?? ""} disabled={blocked} onChange={(value) => updateRule({ ...selectedRule, keywords: value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean) })} />
        <CheckboxGroup className="kulo-form-field" value={selectedRule.formats ?? []} isDisabled={blocked} onChange={(values) => updateRule({ ...selectedRule, formats: values as MediaOutputFormat[] })}><Label>{t("输出格式", "Output formats")}</Label><div className="flex flex-wrap gap-3">{["png", "jpeg", "webp", "gif", "svg"].map((format) => <Checkbox key={format} value={format} variant="secondary"><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{format.toUpperCase()}</Checkbox.Content></Checkbox>)}</div></CheckboxGroup>
        <ImageSelect label={t("任务偏好", "Task preference")} value={selectedRule.preference ?? "__any"} disabled={blocked} options={[{ id: "__any", label: t("不限", "Any") }, ...preferences]} onChange={(preference) => updateRule({ ...selectedRule, preference: preference === "__any" ? undefined : preference as ImagePreference })} />
        <ImageToggle label={t("启用规则", "Enable rule")} value={selectedRule.enabled} disabled={blocked} onChange={(enabled) => updateRule({ ...selectedRule, enabled })} />
      </div>}
      {error && <p className="break-words text-xs text-danger" role="alert">{error}</p>}
      {dirty && workspace.revision !== revision && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-warning" role="status">{t("图像配置已有更新，当前修改已保留。", "Image settings changed elsewhere. Your edits are preserved.")}</p><Button size="sm" variant="secondary" onPress={() => { setSettings(clone(workspace.imageRouting ?? DEFAULT_IMAGE_ROUTING)); setRevision(workspace.revision); setDirty(false); setError(undefined); setEditing(undefined); }}>{t("载入最新规则", "Load latest rules")}</Button></div>}
    </Card.Content>
    <Card.Footer className="justify-end gap-2">{onClose && <Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t("关闭", "Close")}</Button>}<Button variant="primary" isDisabled={blocked || !dirty || workspace.revision !== revision} isPending={busy} onPress={() => void save()}>{t("保存规则", "Save rules")}</Button></Card.Footer>
  </Card>;
}
