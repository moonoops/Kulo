import { describe, expect, it } from "vitest";
import { UI_COMPONENT_SCHEMAS, UiActionDefinitionSchema, getUiSpecFields, getUiTableRowIds, validateUiActionValues, validateUiCardInput, validateUiValues, type UiCardInput } from "@kulo/protocol";
import { keyedTableRows, selectedTableIds, tableSelectionValue, tableView } from "./table-state";

function tableCard(mode: "single" | "multiple" = "single", rowKey?: string): UiCardInput {
  return {
    title: "方案对比", actions: [{ id: "confirm", label: "采用", kind: "submit" }],
    spec: { root: "table", elements: { table: { type: "Table", props: {
      columns: [{ key: "name", label: "方案" }, { key: "price", label: "价格" }],
      rows: rowKey ? [{ id: "a", name: "方案甲", price: 20 }, { id: "b", name: "方案乙", price: 10 }]
        : [{ name: "方案甲", price: 20 }, { name: "方案乙", price: 10 }],
      field: "selected", selectionMode: mode, ...(rowKey ? { rowKey } : {}), caption: "方案",
    } } } },
  };
}

describe("shared table selection validation", () => {
  it("derives index IDs and optional single-selection constraints without choosing a default", () => {
    const input = validateUiCardInput(tableCard());
    const fields = getUiSpecFields(input.spec);
    expect(fields).toEqual([{ name: "selected", label: "方案", type: "enum", options: ["0", "1"] }]);
    const action = { ...input.actions[0]!, fields };
    expect(validateUiActionValues(action, {})).toEqual({ success: true, data: {} });
    expect(validateUiActionValues(action, { selected: "1" })).toMatchObject({ success: true });
    expect(validateUiActionValues(action, { selected: "99" })).toMatchObject({ success: false, errors: { selected: expect.any(String) } });
    expect(() => validateUiValues(fields, { selected: ["1"] })).toThrow();
  });

  it("uses hidden stable rowKey IDs and rejects unknown or duplicate selections", () => {
    const input = validateUiCardInput(tableCard("multiple", "id"));
    const fields = getUiSpecFields(input.spec);
    expect(fields[0]).toMatchObject({ type: "string[]", options: ["a", "b"] });
    expect(validateUiValues(fields, { selected: ["b", "a"] })).toEqual({ selected: ["b", "a"] });
    expect(() => validateUiValues(fields, { selected: ["a", "unknown"] })).toThrow();
    expect(() => validateUiValues(fields, { selected: ["a", "a"] })).toThrow();
    expect(() => validateUiValues(fields, { selected: "a" })).toThrow();
  });

  it("supports selecting all 100 rows while Choice remains capped at 40 options", () => {
    const input = tableCard("multiple");
    input.spec.elements.table!.props.rows = Array.from({ length: 100 }, (_, index) => ({ name: `方案${index}`, price: index }));
    const fields = getUiSpecFields(validateUiCardInput(input).spec);
    const action = UiActionDefinitionSchema.parse({ ...input.actions[0], fields });
    expect(validateUiActionValues(action, { selected: Array.from({ length: 100 }, (_, index) => String(index)) })).toMatchObject({ success: true });
    expect(UI_COMPONENT_SCHEMAS.Choice.safeParse({ field: "choice", options: Array.from({ length: 41 }, (_, index) => ({ value: String(index), label: String(index) })) }).success).toBe(false);
  });

  it("rejects empty selectable tables and missing, duplicate, blank or ambiguous row keys", () => {
    const invalidRows = [[], [{ name: "没有ID", price: 1 }], [{ id: "a" }, { id: "a" }], [{ id: 1 }, { id: "1" }], [{ id: null }], [{ id: true }], [{ id: " " }]];
    for (const rows of invalidRows) {
      const input = tableCard("single", "id");
      input.spec.elements.table!.props.rows = rows;
      expect(() => validateUiCardInput(input)).toThrow();
    }
    expect(getUiTableRowIds({ rows: [{ id: 0 }, { id: "a" }], rowKey: "id" })).toEqual(["0", "a"]);
    expect(() => getUiTableRowIds({ rows: [{ id: "same" }, { id: "same" }], rowKey: "id" })).toThrow();
  });

  it("keeps tables without field read-only and allows empty read-only data", () => {
    const input = tableCard();
    delete input.spec.elements.table!.props.field;
    input.spec.elements.table!.props.rows = [];
    expect(getUiSpecFields(validateUiCardInput(input).spec)).toEqual([]);
  });

  it("rejects initial unknown IDs and undeclared metadata other than the rowKey", () => {
    const input = tableCard("single", "id");
    input.spec.state = { values: { selected: "unknown" } };
    expect(() => validateUiCardInput(input)).toThrow();
    delete input.spec.state;
    (input.spec.elements.table!.props.rows as Record<string, unknown>[])[0]!.hidden = "not a declared column";
    expect(() => validateUiCardInput(input)).toThrow();
  });
});

describe("table selection across local views", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ name: `方案${index}`, price: 12 - index }));
  const columns = [{ key: "name", label: "方案" }, { key: "price", label: "价格" }];

  it("assigns source index IDs before sorting and filtering", () => {
    const keyed = keyedTableRows(rows);
    const view = tableView(keyed, columns, "", { column: "price", direction: "ascending" }, 1, 4);
    expect(view.rows.map((row) => row.id)).toEqual(["11", "10", "9", "8"]);
    expect(tableSelectionValue(new Set(["10"]), "single", keyed.map((row) => row.id), view.rows.map((row) => row.id), undefined)).toBe("10");
    expect(tableSelectionValue(new Set(), "single", keyed.map((row) => row.id), [], "10")).toBeNull();
    expect(selectedTableIds(undefined, "single", ["0", "1"])).toEqual([]);
    expect(rows[0]).toEqual({ name: "方案0", price: 12 });
  });

  it("preserves hidden selections through pages and filters shared by inline and Modal views", () => {
    const keyed = keyedTableRows(rows);
    const ids = keyed.map((row) => row.id);
    const sort = { column: "price", direction: "ascending" } as const;
    const first = tableView(keyed, columns, "", sort, 1, 4);
    const selectedFirst = tableSelectionValue(new Set(["10"]), "multiple", ids, first.rows.map((row) => row.id), undefined);
    const second = tableView(keyed, columns, "", sort, 2, 4);
    const selectedSecond = tableSelectionValue(new Set(["6"]), "multiple", ids, second.rows.map((row) => row.id), selectedFirst);
    expect(selectedSecond).toEqual(["6", "10"]);
    const filtered = tableView(keyed, columns, "方案1", sort, 1, 4);
    const allVisible = tableSelectionValue("all", "multiple", ids, filtered.rows.map((row) => row.id), selectedSecond);
    expect(allVisible).toEqual(["1", "6", "10", "11"]);
    const clearVisible = tableSelectionValue(new Set(), "multiple", ids, filtered.rows.map((row) => row.id), allVisible);
    expect(clearVisible).toEqual(["6"]);
    expect(selectedTableIds(clearVisible, "multiple", ids)).toEqual(["6"]);
  });

  it("does not fall back to other IDs for malformed selection or row keys", () => {
    expect(() => tableSelectionValue(new Set(["unknown"]), "multiple", ["0"], ["0"], [])).toThrow();
    expect(() => tableSelectionValue(new Set(["0", "1"]), "single", ["0", "1"], ["0", "1"], null)).toThrow();
    expect(() => keyedTableRows([{ name: "row" }], "id")).toThrow();
    const empty = tableView([], columns, "", undefined, 5, 8);
    expect(empty).toMatchObject({ rows: [], total: 0, page: 1, pageCount: 1 });
  });
});
