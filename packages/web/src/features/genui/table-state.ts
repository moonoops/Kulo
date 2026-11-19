import { getUiTableRowIds, type UiValue } from "@moco/protocol";
import type { DataColumn, DataRow } from "./table-csv";

export type TableSort = { column: string | number; direction: "ascending" | "descending" };
export interface KeyedTableRow { id: string; data: DataRow; sourceIndex: number }
export type TableSelectionMode = "single" | "multiple";

export function displayTableValue(value: DataRow[string] | undefined): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "boolean" ? value ? "是" : "否" : String(value);
}

export function keyedTableRows(rows: DataRow[], rowKey?: string): KeyedTableRow[] {
  const ids = getUiTableRowIds({ rows, rowKey });
  return rows.map((data, sourceIndex) => ({ id: ids[sourceIndex]!, data, sourceIndex }));
}

export function tableView(rows: KeyedTableRow[], columns: DataColumn[], query: string, sort: TableSort | undefined, page: number, pageSize: number) {
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = term ? rows.filter(({ data }) => columns.some((column) => displayTableValue(data[column.key]).toLocaleLowerCase("zh-CN").includes(term))) : rows;
  const ordered = sort ? [...filtered].sort((a, b) => {
    const left = a.data[sort.column];
    const right = b.data[sort.column];
    return (sort.direction === "ascending" ? 1 : -1) * (typeof left === "number" && typeof right === "number"
      ? left - right
      : displayTableValue(left).localeCompare(displayTableValue(right), "zh-CN", { numeric: true }));
  }) : filtered;
  const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  return { rows: ordered.slice((current - 1) * pageSize, current * pageSize), total: ordered.length, page: current, pageCount };
}

export function selectedTableIds(value: UiValue | undefined, mode: TableSelectionMode, sourceIds: readonly string[]): string[] {
  const selected = new Set(mode === "multiple" ? Array.isArray(value) ? value : [] : typeof value === "string" ? [value] : []);
  return sourceIds.filter((id) => selected.has(id));
}

export function tableSelectionValue(
  selection: "all" | ReadonlySet<string | number>, mode: TableSelectionMode,
  sourceIds: readonly string[], visibleIds: readonly string[], previous: UiValue | undefined,
): string | string[] | null {
  const ids = selection === "all" ? [...visibleIds] : [...selection].map(String);
  const known = new Set(sourceIds);
  if (ids.some((id) => !known.has(id))) throw new Error("Table selection contains an unknown row ID");
  if (mode === "single") {
    if (ids.length > 1) throw new Error("Single-selection tables accept one row ID");
    return ids[0] ?? null;
  }
  const visible = new Set(visibleIds);
  const next = new Set([...selectedTableIds(previous, mode, sourceIds).filter((id) => !visible.has(id)), ...ids]);
  return sourceIds.filter((id) => next.has(id));
}
