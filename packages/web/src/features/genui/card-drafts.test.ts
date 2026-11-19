import { describe, expect, it } from "vitest";
import type { UiActionInput, UiCardSnapshot } from "@moco/protocol";
import {
  cardInitialValues, createCardDraft, hasDraftConflict, isDefiniteActionRejection,
  readCardDraft, reconcileCardDraft, writeCardDraft, type DraftStorage,
} from "./card-drafts";

function card(cardId = "draft-test"): UiCardSnapshot {
  return {
    cardId, schemaVersion: 1, catalogVersion: 1, revision: 1, title: "灯光参数", status: "ready",
    originConversationId: 1, committedState: {}, actions: [],
    spec: { root: "root", elements: {
      root: { type: "Stack", props: {}, children: ["level", "enabled"] },
      level: { type: "Slider", props: { field: "brightness", label: "亮度", min: 10, max: 100 } },
      enabled: { type: "Switch", props: { field: "enabled", label: "启用" } },
    }, state: { values: { brightness: 50 } } },
  };
}

function storage(value: string | null): DraftStorage {
  return { getItem: () => value, setItem: (_key, next) => { value = next; } };
}

describe("card drafts", () => {
  it("uses visible control defaults and committed values consistently", () => {
    const snapshot = card();
    expect(cardInitialValues(snapshot)).toEqual({ brightness: 50, enabled: false });
    expect(cardInitialValues({ ...snapshot, committedState: { brightness: 80, enabled: true } }))
      .toEqual({ brightness: 80, enabled: true });
  });

  it("keeps a dirty draft through another device's revision update", () => {
    const snapshot = card();
    const draft = { ...createCardDraft(snapshot), values: { brightness: 35 }, dirty: true };
    const updated = { ...snapshot, revision: 2, committedState: { brightness: 90 } };
    expect(reconcileCardDraft(draft, updated)).toEqual(draft);
    expect(hasDraftConflict(draft, updated)).toBe(true);
    expect(reconcileCardDraft(createCardDraft(snapshot), updated).values.brightness).toBe(90);
  });

  it("preserves an uncertain command and its identifier after reloading", () => {
    const snapshot = card("restore-pending");
    const pending: UiActionInput = { cardId: snapshot.cardId, actionId: "server-action", commandId: "stable-command", revision: 1, values: { brightness: 35 } };
    const persisted = { ...createCardDraft(snapshot), values: pending.values, dirty: true, pending };
    const restored = readCardDraft(snapshot, storage(JSON.stringify(persisted))).draft;
    expect(restored.pending).toEqual(pending);
    expect(restored.values).toEqual(pending.values);
  });

  it("restores completed cards collapsed while retaining a local draft for adjustment", () => {
    const snapshot = card("restore-completed");
    const draft = { ...createCardDraft(snapshot), values: { brightness: 35 }, dirty: true };
    const completed = { ...snapshot, revision: 2, status: "submitted" as const, committedState: { brightness: 80 } };
    const restored = readCardDraft(completed, storage(JSON.stringify(draft))).draft;
    expect(restored.expanded).toBe(false);
    expect(restored.values).toEqual({ brightness: 35 });
    expect(restored.dirty).toBe(true);
  });

  it("reports corrupt persistence and rejects state outside the shared values contract", () => {
    const snapshot = card("corrupt-draft");
    const malformed = { ...createCardDraft(snapshot), values: { "../escape": "value" } };
    const result = readCardDraft(snapshot, storage(JSON.stringify(malformed)));
    expect(result.storageError).toBeTruthy();
    expect(result.draft).toEqual(createCardDraft(snapshot));
    expect(readCardDraft(card("broken-json"), storage("{")).storageError).toBeTruthy();
  });

  it("keeps an in-session draft when persistent storage is unavailable", () => {
    const snapshot = card("blocked-storage");
    const draft = { ...createCardDraft(snapshot), values: { brightness: 32 }, dirty: true };
    const blocked = { getItem: () => null, setItem: () => { throw new Error("blocked"); } };
    expect(writeCardDraft(snapshot.cardId, draft, blocked)).toBe("草稿暂存于当前窗口");
    expect(readCardDraft(snapshot).draft.values).toEqual({ brightness: 32 });
  });

  it("keeps secret-bearing form drafts only in memory and never persists an altered retry", () => {
    const snapshot = card("private-form-draft");
    const pending: UiActionInput = { cardId: snapshot.cardId, actionId: "save", commandId: "private-command", revision: 1, values: { note: "密码：fixture-password-123，请保存", apiKey: "fixture-plain-key" } };
    const draft = { ...createCardDraft(snapshot), values: pending.values, dirty: true, pending };
    let persisted = "";
    const target = { getItem: () => persisted, setItem: (_key: string, value: string) => { persisted = value; } };
    expect(writeCardDraft(snapshot.cardId, draft, target)).toBe("敏感输入仅保留在当前窗口");
    expect(persisted).not.toContain("fixture-password-123");
    expect(persisted).not.toContain("fixture-plain-key");
    expect(JSON.parse(persisted).pending).toBeUndefined();
    expect(readCardDraft(snapshot).draft.pending).toEqual(pending);
  });

  it("cleans secrets from an existing generic form draft on read", () => {
    const snapshot = card("legacy-private-form");
    let persisted = JSON.stringify({ ...createCardDraft(snapshot), dirty: true, values: { note: "API_KEY=fixture-api-key-123" } });
    const target = { getItem: () => persisted, setItem: (_key: string, value: string) => { persisted = value; } };
    const restored = readCardDraft(snapshot, target);
    expect(restored.storageError).toContain("敏感输入");
    expect(persisted).not.toContain("fixture-api-key-123");
    expect(restored.draft.values.note).not.toContain("fixture-api-key-123");
  });

  it("distinguishes an explicit rejection from a transport or server uncertainty", () => {
    expect(isDefiniteActionRejection({ status: 409 })).toBe(true);
    expect(isDefiniteActionRejection({ code: "validation_error" })).toBe(true);
    expect(isDefiniteActionRejection({ status: 503 })).toBe(false);
    expect(isDefiniteActionRejection({ status: 408 })).toBe(false);
    expect(isDefiniteActionRejection(new Error("Connection lost"))).toBe(false);
  });
});
