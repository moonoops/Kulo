import { z } from "zod";

export const UI_LIMITS = { nodes: 80, depth: 8, rows: 100, text: 32_000, bytes: 128_000, fields: 40 } as const;
const safeKey = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).refine((key) => !["__proto__", "prototype", "constructor"].includes(key));
const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).refine((key) => !["__proto__", "prototype", "constructor"].includes(key));
const label = z.string().max(240);
const text = z.string().max(UI_LIMITS.text);
const finite = z.number().finite();
const scalar = z.union([text, finite, z.boolean(), z.null()]);
export const UiValueSchema = z.union([scalar, z.array(z.string().max(240)).max(UI_LIMITS.rows)]);
export const UiValuesSchema = z.record(safeKey, UiValueSchema)
  .refine((value) => Object.keys(value).length <= UI_LIMITS.fields, "Too many fields")
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= UI_LIMITS.bytes, "UI values are too large");
export type UiValue = z.infer<typeof UiValueSchema>;
export type UiValues = z.infer<typeof UiValuesSchema>;
const option = z.strictObject({ value: z.string().min(1).max(240), label, description: z.string().max(600).optional() });
const options = z.array(option).min(1).max(40).refine((items) => new Set(items.map((item) => item.value)).size === items.length, "Duplicate option value");
const range = { min: finite.optional(), max: finite.optional(), step: finite.positive().optional() };

export function getUiTableRowIds(table: { rows: readonly Record<string, string | number | boolean | null>[]; rowKey?: string }): string[] {
  if (!table.rowKey) return table.rows.map((_row, index) => String(index));
  const ids = table.rows.map((row) => {
    const value = row[table.rowKey!];
    if ((typeof value !== "string" && typeof value !== "number")
      || typeof value === "number" && !Number.isFinite(value)
      || !String(value).trim() || String(value).length > 240) {
      throw new Error("Table rowKey must contain a non-empty string or finite number in every row");
    }
    return String(value);
  });
  if (new Set(ids).size !== ids.length) throw new Error("Table rowKey values must be unique");
  return ids;
}

const tableProps = z.strictObject({
  columns: z.array(z.strictObject({ key: safeKey, label })).min(1).max(12),
  rows: z.array(z.record(safeKey, scalar)).max(UI_LIMITS.rows), caption: label.optional(),
  field: safeKey.optional(), selectionMode: z.enum(["single", "multiple"]).optional(), rowKey: safeKey.optional(),
}).superRefine((table, ctx) => {
  if (table.field && !table.rows.length) ctx.addIssue({ code: "custom", message: "Selectable tables need at least one row", path: ["rows"] });
  try { getUiTableRowIds(table); }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid table row IDs", path: ["rowKey"] }); }
});

/** The server and HeroUI registry share this exact, deliberately closed prop catalog. */
export const UI_COMPONENT_SCHEMAS = {
  Card: z.strictObject({ title: label.optional(), description: z.string().max(1200).optional() }),
  Stack: z.strictObject({ gap: z.enum(["sm", "md", "lg"]).optional() }),
  Grid: z.strictObject({ columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }),
  Text: z.strictObject({ text: text.optional(), field: safeKey.optional(), tone: z.enum(["default", "muted"]).optional(), size: z.enum(["sm", "md", "lg"]).optional() }),
  Metric: z.strictObject({ label, value: z.union([label, finite]).optional(), field: safeKey.optional(), unit: z.string().max(40).optional() }),
  Chip: z.strictObject({ text: label, variant: z.enum(["secondary", "soft", "primary"]).optional(), tone: z.enum(["default", "accent", "success", "warning", "danger"]).optional() }),
  Table: tableProps,
  Choice: z.strictObject({ field: safeKey, label: label.optional(), options, multiple: z.boolean().optional(), required: z.boolean().optional() }),
  TextField: z.strictObject({ field: safeKey, label, placeholder: label.optional(), multiline: z.boolean().optional(), required: z.boolean().optional(), maxLength: z.number().int().min(1).max(UI_LIMITS.text).optional() }),
  NumberField: z.strictObject({ field: safeKey, label, ...range, required: z.boolean().optional() }),
  Select: z.strictObject({ field: safeKey, label, options, required: z.boolean().optional() }),
  Slider: z.strictObject({ field: safeKey, label, ...range, unit: z.string().max(40).optional() }),
  Switch: z.strictObject({ field: safeKey, label }),
  Checkbox: z.strictObject({ field: safeKey, label }),
  Button: z.strictObject({ actionId: identifier, label: label.optional(), variant: z.enum(["primary", "secondary", "danger"]).optional() }),
  Tabs: z.strictObject({ tabs: z.array(z.strictObject({ id: safeKey, label })).min(1).max(8) }),
  Disclosure: z.strictObject({ title: label, defaultExpanded: z.boolean().optional() }),
  Chart: z.strictObject({ type: z.enum(["bar", "line"]), data: z.array(z.strictObject({ label, value: finite })).max(UI_LIMITS.rows), label: label.optional() }),
  Media: z.strictObject({ assetId: identifier, alt: label.optional() }),
  Code: z.strictObject({ code: text, language: z.string().max(40).regex(/^[\w+-]*$/).optional(), fileName: label.optional() }),
} as const;
export type UiComponentName = keyof typeof UI_COMPONENT_SCHEMAS;
export const UI_COMPONENT_NAMES = Object.keys(UI_COMPONENT_SCHEMAS) as UiComponentName[];
export const UiFieldDefinitionSchema = z.strictObject({
  name: safeKey, label: label.optional(), type: z.enum(["string", "number", "boolean", "enum", "string[]"]),
  required: z.boolean().optional(), min: finite.optional(), max: finite.optional(),
  maxLength: z.number().int().min(1).max(UI_LIMITS.text).optional(), options: z.array(z.string().min(1).max(240)).min(1).max(UI_LIMITS.rows).optional(),
}).superRefine((field, ctx) => {
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) ctx.addIssue({ code: "custom", message: "Invalid field range" });
  if ((field.type === "enum" || field.type === "string[]") && !field.options?.length) ctx.addIssue({ code: "custom", message: "Choice fields need options" });
  if (field.options && new Set(field.options).size !== field.options.length) ctx.addIssue({ code: "custom", message: "Duplicate field option" });
});
export type UiFieldDefinition = z.infer<typeof UiFieldDefinitionSchema>;
export const UiActionDefinitionSchema = z.strictObject({
  id: identifier, label: label.min(1), kind: z.enum(["submit", "cancel"]),
  fields: z.array(UiFieldDefinitionSchema).max(UI_LIMITS.fields).optional(), repeatable: z.literal(false).optional(),
});
export type UiActionDefinition = z.infer<typeof UiActionDefinitionSchema>;
export const UiElementSchema = z.strictObject({
  type: z.enum(UI_COMPONENT_NAMES as [UiComponentName, ...UiComponentName[]]),
  props: z.record(z.string(), z.unknown()), children: z.array(identifier).max(UI_LIMITS.nodes).optional(),
});
export type UiElement = z.infer<typeof UiElementSchema>;

/** Reject expressions, prototype keys and oversized structures before parsing the tree. */
function boundedJson(value: unknown): boolean {
  const seen = new Set<object>();
  let count = 0;
  let size = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (++count > 6000 || depth > 16) return false;
    if (node === null || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (typeof node === "string") { size += node.length; return node.length <= UI_LIMITS.text && size <= UI_LIMITS.bytes; }
    if (typeof node !== "object" || seen.has(node)) return false;
    const prototype = Object.getPrototypeOf(node);
    if (!Array.isArray(node) && prototype !== Object.prototype && prototype !== null) return false;
    seen.add(node);
    const entries = Object.entries(node);
    if (entries.length > 200) return false;
    const valid = entries.every(([key, child]) => !["__proto__", "prototype", "constructor"].includes(key) && visit(child, depth + 1));
    seen.delete(node);
    return valid;
  };
  return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= UI_LIMITS.bytes;
}

const specStructure = z.strictObject({
  root: identifier, elements: z.record(identifier, UiElementSchema),
  state: z.strictObject({ values: UiValuesSchema.optional() }).optional(),
});
export const UiSpecSchema = z.unknown().superRefine((value, ctx) => {
  if (!boundedJson(value)) ctx.addIssue({ code: "custom", message: "UI must contain bounded plain JSON" });
}).pipe(specStructure).superRefine((spec, ctx) => {
  const ids = Object.keys(spec.elements);
  if (!ids.length || ids.length > UI_LIMITS.nodes) { ctx.addIssue({ code: "custom", message: `UI supports 1–${UI_LIMITS.nodes} nodes` }); return; }
  const visited = new Set<string>();
  const path = new Set<string>();
  const walk = (id: string, depth: number): void => {
    const element = spec.elements[id];
    if (!element) { ctx.addIssue({ code: "custom", message: `Unknown UI node: ${id}` }); return; }
    if (depth > UI_LIMITS.depth || path.has(id) || visited.has(id)) { ctx.addIssue({ code: "custom", message: "UI must be an acyclic tree within the depth limit" }); return; }
    visited.add(id); path.add(id);
    const parsed = UI_COMPONENT_SCHEMAS[element.type].safeParse(element.props);
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: `${element.type}: ${issue.message}`, path: ["elements", id, "props", ...issue.path] });
    const props = element.props;
    if (typeof props.min === "number" && typeof props.max === "number" && props.min > props.max) ctx.addIssue({ code: "custom", message: "Invalid input range", path: ["elements", id] });
    if (element.type === "Tabs" && parsed.success && Array.isArray(props.tabs) && props.tabs.length !== (element.children?.length ?? 0)) ctx.addIssue({ code: "custom", message: "Tabs must have one child per tab", path: ["elements", id] });
    if (element.type === "Tabs" && parsed.success && Array.isArray(props.tabs) && new Set(props.tabs.map((tab) => (tab as { id: string }).id)).size !== props.tabs.length) ctx.addIssue({ code: "custom", message: "Tab IDs must be unique", path: ["elements", id] });
    if (element.type === "Table" && parsed.success) {
      const table = parsed.data as z.infer<typeof UI_COMPONENT_SCHEMAS.Table>;
      const columns = new Set(table.columns.map((column) => column.key));
      if (columns.size !== table.columns.length || table.rows.some((row) => Object.keys(row).some((key) => !columns.has(key) && key !== table.rowKey))) ctx.addIssue({ code: "custom", message: "Table rows must refer to unique declared columns or rowKey", path: ["elements", id] });
    }
    if (!["Card", "Stack", "Grid", "Tabs", "Disclosure"].includes(element.type) && element.children?.length) ctx.addIssue({ code: "custom", message: "Leaf UI components cannot contain children", path: ["elements", id] });
    for (const child of element.children ?? []) walk(child, depth + 1);
    path.delete(id);
  };
  walk(spec.root, 1);
  if (visited.size !== ids.length) ctx.addIssue({ code: "custom", message: "UI contains unreachable nodes" });
});
export type UiSpec = z.infer<typeof UiSpecSchema>;

export function getUiSpecFields(spec: UiSpec): UiFieldDefinition[] {
  const fields: UiFieldDefinition[] = [];
  for (const element of Object.values(spec.elements)) {
    if (!UI_COMPONENT_SCHEMAS[element.type].safeParse(element.props).success) continue;
    const p = element.props;
    if (typeof p.field !== "string" || ["Text", "Metric"].includes(element.type)) continue;
    if (element.type === "Table") {
      const table = UI_COMPONENT_SCHEMAS.Table.parse(p);
      fields.push({ name: p.field, ...(table.caption ? { label: table.caption } : {}),
        type: table.selectionMode === "multiple" ? "string[]" : "enum", options: getUiTableRowIds(table) });
      continue;
    }
    const type: UiFieldDefinition["type"] = element.type === "Switch" || element.type === "Checkbox" ? "boolean"
      : element.type === "NumberField" || element.type === "Slider" ? "number"
      : element.type === "Select" || element.type === "Choice" ? p.multiple ? "string[]" : "enum" : "string";
    fields.push({ name: p.field, type, ...(typeof p.label === "string" ? { label: p.label } : {}),
      ...(p.required === true ? { required: true } : {}), ...(typeof p.min === "number" ? { min: p.min } : element.type === "Slider" ? { min: 0 } : {}),
      ...(typeof p.max === "number" ? { max: p.max } : element.type === "Slider" ? { max: 100 } : {}), ...(typeof p.maxLength === "number" ? { maxLength: p.maxLength } : {}),
      ...(Array.isArray(p.options) ? { options: p.options.map((item) => (item as { value: string }).value) } : {}),
    });
  }
  return fields;
}

export const UiCardInputSchema = z.strictObject({
  title: label.min(1), spec: UiSpecSchema, actions: z.array(UiActionDefinitionSchema).max(12), fallbackText: text.optional(),
}).superRefine((input, ctx) => {
  const ids = new Set(input.actions.map((action) => action.id));
  if (ids.size !== input.actions.length) ctx.addIssue({ code: "custom", message: "Duplicate UI action" });
  const fields = getUiSpecFields(input.spec);
  const names = new Set(fields.map((field) => field.name));
  if (names.size !== fields.length || fields.length > UI_LIMITS.fields) ctx.addIssue({ code: "custom", message: "Input fields must have unique names" });
  for (const element of Object.values(input.spec.elements)) {
    if (element.type === "Button" && !ids.has(String(element.props.actionId))) ctx.addIssue({ code: "custom", message: "Button references an unknown action" });
    if (typeof element.props.field === "string" && !names.has(element.props.field)) ctx.addIssue({ code: "custom", message: "Unknown field reference" });
  }
  for (const key of Object.keys(input.spec.state?.values ?? {})) if (!names.has(key)) ctx.addIssue({ code: "custom", message: `Unknown initial field: ${key}` });
  try { validateUiValues(fields, input.spec.state?.values ?? {}, false); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid initial field values", path: ["spec", "state", "values"] }); }
  for (const action of input.actions) {
    const declarations = new Set<string>();
    for (const field of action.fields ?? []) {
      const original = fields.find((item) => item.name === field.name);
      if (declarations.has(field.name) || !original || original.type !== field.type) ctx.addIssue({ code: "custom", message: "Action fields must refer to unique compatible input fields" });
      declarations.add(field.name);
    }
  }
});
export type UiCardInput = z.infer<typeof UiCardInputSchema>;
export const UiCardStatusSchema = z.enum(["ready", "submitted", "cancelled", "failed", "expired"]);
export type UiCardStatus = z.infer<typeof UiCardStatusSchema>;
export const UiCardSnapshotSchema = z.strictObject({
  cardId: identifier, schemaVersion: z.literal(1), catalogVersion: z.literal(1), revision: z.number().int().positive(),
  title: label.min(1), spec: UiSpecSchema, actions: z.array(UiActionDefinitionSchema).max(12), committedState: UiValuesSchema,
  status: UiCardStatusSchema, originConversationId: z.number().int().nonnegative(), sourceEntryId: z.number().int().nonnegative().optional(),
  topicId: z.string().max(160).optional(), ticketId: z.string().max(160).optional(), resultSummary: text.optional(), error: z.string().max(2000).optional(),
}).superRefine((card, ctx) => {
  const input = UiCardInputSchema.safeParse({ title: card.title, spec: card.spec, actions: card.actions });
  if (!input.success) for (const issue of input.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  try { validateUiValues(getUiSpecFields(card.spec), card.committedState, false); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid committed UI state", path: ["committedState"] }); }
});
export type UiCardSnapshot = z.infer<typeof UiCardSnapshotSchema>;
export const UiActionInputSchema = z.strictObject({ cardId: identifier, revision: z.number().int().positive(), actionId: identifier, values: UiValuesSchema, commandId: identifier });
export type UiActionInput = z.infer<typeof UiActionInputSchema>;
export const UiActionReceiptSchema = z.strictObject({ commandId: identifier, cardId: identifier, revision: z.number().int().positive(), status: UiCardStatusSchema, deduplicated: z.boolean().optional(), card: UiCardSnapshotSchema.optional() });
export type UiActionReceipt = z.infer<typeof UiActionReceiptSchema>;

export function validateUiSpec(raw: unknown): UiSpec { return UiSpecSchema.parse(raw); }
export function validateUiCardInput(raw: unknown): UiCardInput { return UiCardInputSchema.parse(raw); }

export function validateUiValues(fields: readonly UiFieldDefinition[], raw: unknown, requireAll = true): UiValues {
  const values = UiValuesSchema.parse(raw);
  const allowed = new Map(fields.map((field) => [field.name, field]));
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`Unknown UI field: ${key}`);
  for (const field of fields) {
    const value = values[field.name];
    const empty = value === undefined || value === null || value === "" || Array.isArray(value) && value.length === 0;
    if (empty) { if (requireAll && field.required) throw new Error(`Required UI field: ${field.name}`); continue; }
    const valid = field.type === "number" ? typeof value === "number" && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max)
      : field.type === "boolean" ? typeof value === "boolean"
      : field.type === "string[]" ? Array.isArray(value) && new Set(value).size === value.length && value.every((item) => field.options?.includes(item))
      : typeof value === "string" && value.length <= (field.maxLength ?? UI_LIMITS.text) && (field.type !== "enum" || !!field.options?.includes(value));
    if (!valid) throw new Error(`Invalid UI field: ${field.name}`);
  }
  return values;
}

export function validateUiActionValues(action: UiActionDefinition, raw: unknown):
  | { success: true; data: UiValues }
  | { success: false; errors: Record<string, string> } {
  const parsed = UiValuesSchema.safeParse(raw);
  if (!parsed.success) return { success: false, errors: { _form: "输入格式无效" } };
  if (action.kind === "cancel") return { success: true, data: {} };
  const errors: Record<string, string> = {};
  const fields = action.fields ?? [];
  const allowed = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(parsed.data)) if (!allowed.has(key)) errors[key] = "此字段不属于当前表单";
  for (const field of fields) {
    const value = parsed.data[field.name];
    try { validateUiValues([field], field.name in parsed.data ? { [field.name]: value } : {}); }
    catch { errors[field.name] = field.required && (value == null || value === "" || Array.isArray(value) && value.length === 0) ? "请填写此项" : "请检查输入值"; }
  }
  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: parsed.data };
}
