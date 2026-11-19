import { describe, expect, it } from "vitest";
import type { UiCardSnapshot } from "@kulo/protocol";
import { cardAdjustmentDraft, cardValueSummary } from "./card-value-summary";

const card: UiCardSnapshot = {
  cardId: "lighting", schemaVersion: 1, catalogVersion: 1, revision: 1, title: "照明偏好", status: "submitted", originConversationId: 1,
  committedState: {}, actions: [], spec: { root: "root", elements: {
    root: { type: "Stack", props: {}, children: ["plan", "maintenance", "count"] },
    plan: { type: "Choice", props: { field: "plan", label: "方案", options: [{ value: "warm", label: "温暖" }, { value: "focus", label: "专注" }] } },
    maintenance: { type: "Switch", props: { field: "maintenance", label: "便于维护" } },
    count: { type: "NumberField", props: { field: "count", label: "数量" } },
  } },
};

describe("card adjustment context", () => {
  it("uses visible labels for choices, booleans and zero without dumping internal JSON", () => {
    const draft = cardAdjustmentDraft(card, { plan: "warm", maintenance: false, count: 0 });
    expect(draft).toBe("调整「照明偏好」\n方案：温暖\n便于维护：否\n数量：0");
    expect(draft).not.toContain("warm");
    expect(draft).not.toContain("{");
  });
  it("keeps table selections intelligible using stable row IDs and visible row names", () => {
    const table: UiCardSnapshot = { ...card, spec: { root: "table", elements: { table: { type: "Table", props: {
      caption: "灯具", field: "selected", selectionMode: "multiple", rowKey: "id", columns: [{ key: "name", label: "名称" }],
      rows: [{ id: "a", name: "筒灯" }, { id: "b", name: "射灯" }],
    } } } } };
    expect(cardValueSummary(table, { selected: ["b", "a"] })).toEqual([{ name: "selected", label: "灯具", display: "射灯、筒灯" }]);
  });
});
