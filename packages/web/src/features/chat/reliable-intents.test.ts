import { afterEach, describe, expect, it, vi } from "vitest";
import { deliveryIntentKey, newDeliveryId } from "./reliable-intents";

afterEach(() => vi.unstubAllGlobals());
describe("reliable button intents", () => {
  it("recognizes the same pending action across views without depending on object property order", () => {
    expect(deliveryIntentKey({ type: "ticket.stop", ticketId: "T1", reason: "手动停止", commandId: "one" }))
      .toBe(deliveryIntentKey({ reason: "手动停止", ticketId: "T1", type: "ticket.stop", commandId: "two" }));
  });
  it("distinguishes changed targets, payloads and operation types", () => {
    const original = deliveryIntentKey({ type: "ticket.steer", ticketId: "T1", text: "条件一", commandId: "one" });
    expect(original).not.toBe(deliveryIntentKey({ type: "ticket.steer", ticketId: "T1", text: "条件二", commandId: "one" }));
    expect(original).not.toBe(deliveryIntentKey({ type: "ticket.steer", ticketId: "T2", text: "条件一", commandId: "one" }));
    expect(deliveryIntentKey({ type: "schedule.stop", ticketId: "T1" })).not.toBe(deliveryIntentKey({ type: "schedule.delete", ticketId: "T1" }));
  });
  it("keeps secure unique IDs available on an HTTP LAN page without randomUUID", () => {
    let value = 0;
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => { bytes.fill(++value); return bytes; } });
    const first = newDeliveryId("web");
    expect(first).toMatch(/^web:[a-f0-9]{32}$/);
    expect(newDeliveryId("web")).not.toBe(first);
  });
});
