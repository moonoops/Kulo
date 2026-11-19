import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { UiCardSnapshotSchema, type UiCardInput } from "@moco/protocol";
import { MocoUiCards } from "../../../../hub/src/ui-cards";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe("durable table selection actions", () => {
  it.each(["single", "multiple"] as const)("admits %s row IDs and rejects forged IDs through the real card service", async (mode) => {
    const provider = fauxProvider({ provider: "openai", models: [{ id: "table-test" }] });
    provider.setResponses([() => fauxAssistantMessage([fauxText("已收到所选行。")])]);
    const models = createModels();
    models.setProvider(provider.provider);
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), identity: { attribution: null } }, BACKGROUND_CONTEXT);
    cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "openai", modelId: "table-test" }, extensions: [], thinkingLevel: "off" } });
    const service = new MocoUiCards({ harness });
    const source = { conversationId: Number(conversation.id), callId: "table-publication" };
    const input: UiCardInput = {
      title: "选择对比结果", actions: [{ id: "confirm", label: "采用", kind: "submit" }],
      spec: { root: "table", elements: { table: { type: "Table", props: {
        field: "selected", selectionMode: mode, rowKey: "id", caption: "方案",
        columns: [{ key: "name", label: "方案" }],
        rows: Array.from({ length: 100 }, (_, index) => ({ id: `scheme-${index}`, name: `方案${index}` })),
      } } } },
    };
    const card = await service.show(input, source);
    expect(card.committedState).toEqual({});
    const action = card.actions[0]!;
    expect(action.fields?.[0]).toMatchObject({ name: "selected", type: mode === "multiple" ? "string[]" : "enum", options: expect.arrayContaining(["scheme-0", "scheme-99"]) });
    const command = { cardId: card.cardId, revision: card.revision, actionId: action.id, commandId: "bad-table-command", values: { selected: mode === "multiple" ? ["forged-row"] : "forged-row" } };
    await expect(service.submit(command, source)).rejects.toMatchObject({ code: "invalid_ui_values" });
    expect((await service.get(card.cardId))?.status).toBe("ready");
    const values = { selected: mode === "multiple" ? Array.from({ length: 100 }, (_, index) => `scheme-${index}`) : "scheme-99" };
    const receipt = await service.submit({ ...command, commandId: "valid-table-command", values }, source);
    expect(receipt).toMatchObject({ status: "submitted", card: { committedState: values } });
    expect(UiCardSnapshotSchema.safeParse(receipt.card).success).toBe(true);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    const messages = JSON.stringify((await conversation.context(BACKGROUND_CONTEXT)).messages);
    expect(messages).toContain("moco.ui.action");
    expect(messages).toContain("scheme-99");
    expect(messages).not.toContain("forged-row");
  });
});
