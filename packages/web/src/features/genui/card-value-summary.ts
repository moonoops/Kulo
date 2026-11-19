import { getUiSpecFields, getUiTableRowIds, UI_COMPONENT_SCHEMAS, type UiCardSnapshot, type UiValues } from "@kulo/protocol";
import { displayCardValue } from "./card-runtime";
import { translate as tr } from "../../kulo-i18n";

export function cardValueSummary(card: UiCardSnapshot, values: UiValues): Array<{ name: string; label: string; display: string }> {
  const fields = getUiSpecFields(card.spec);
  return Object.entries(values).map(([name, value]) => {
    const field = fields.find((item) => item.name === name);
    const element = Object.values(card.spec.elements).find((item) => item.props.field === name && (Array.isArray(item.props.options) || item.type === "Table"));
    let options = element?.props.options as { value: string; label: string }[] | undefined;
    if (element?.type === "Table") {
      const table = UI_COMPONENT_SCHEMAS.Table.parse(element.props);
      const ids = getUiTableRowIds(table);
      options = table.rows.map((row, index) => ({ value: ids[index]!, label: displayCardValue(row[table.columns[0]!.key]) }));
    }
    const display = Array.isArray(value) ? value.map((item) => options?.find((option) => option.value === item)?.label || item).join("、")
      : typeof value === "string" ? options?.find((option) => option.value === value)?.label || value : displayCardValue(value);
    return { name, label: field?.label || name, display };
  });
}

export function cardAdjustmentDraft(card: UiCardSnapshot, values: UiValues): string {
  return [tr(`调整「${card.title}」`, `Adjust “${card.title}”`), ...cardValueSummary(card, values).map((row) => `${row.label}：${row.display}`)].join("\n");
}
