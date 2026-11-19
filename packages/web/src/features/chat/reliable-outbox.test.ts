import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReliableOutbox, createMemoryOutboxStorage, isReliableEnvelope, reliableEnvelopeId, withReliableId,
  type ReliableEnvelope, type ReliableOutboxAck, type ReliableOutboxOptions, type ReliableOutboxStorage,
} from "./reliable-outbox";

const instances: ReliableOutbox[] = [];
const scope = "http://moco.test|hub-one|device-one";
const message = (id: string, content = id): ReliableEnvelope => ({ type: "chat.send", topicId: "topic-one", content, requestId: id, whenBusy: "steer" });
const disconnected = () => Object.assign(new Error("连接已中断"), { isDisconnect: true });
const ack = (submissionId: number): ReliableOutboxAck => ({ submissionId, topicId: "topic-one", delivery: "accepted" });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function controller(storage = createMemoryOutboxStorage(), changes: Partial<ReliableOutboxOptions> = {}) {
  const options: ReliableOutboxOptions = { storage, scope, transmit: vi.fn(async () => ack(1)),
    isTransient: (error) => Boolean(error && typeof error === "object" && "isDisconnect" in error && error.isDisconnect), ...changes };
  const outbox = new ReliableOutbox(options); instances.push(outbox);
  return { outbox, storage, transmit: options.transmit };
}
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
async function failedMessage(storage: ReliableOutboxStorage, id = "failed") {
  const record = await storage.enqueue(scope, message(id, "original draft"), { rawUserText: "original draft" }, Date.now());
  await storage.claim(scope, "failed-owner", Date.now(), 6000);
  await storage.fail(scope, id, "failed-owner", "附件已失效", "attachment_not_found", undefined, record.sequence);
  await storage.release(scope, "failed-owner");
  return (await storage.get(scope, id))!;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(async () => { for (const instance of instances.splice(0)) instance.dispose(); await flush(); vi.useRealTimers(); });

describe("reliable outbox identity", () => {
  it("does not reclassify committed storage writes when a notification listener throws", async () => {
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const storage = createMemoryOutboxStorage(); const original = await failedMessage(storage);
      storage.subscribe(() => { throw new DOMException("Observer closed", "InvalidStateError"); });
      const committed = await storage.enqueue(scope, message("committed"), undefined, Date.now());
      expect(committed.id).toBe("committed"); expect((await storage.get(scope, committed.id))?.id).toBe(committed.id);
      await expect(storage.retry(scope, original.id, Date.now())).resolves.toMatchObject({ state: "queued" });
      expect(diagnostics).toHaveBeenCalledTimes(2);
    } finally { diagnostics.mockRestore(); }
  });

  it.each(["enqueue", "retry"] as const)("returns the persisted %s result when disposal closes observers before its delayed commit", async (operation) => {
    const storage = createMemoryOutboxStorage();
    if (operation === "retry") await failedMessage(storage);
    const entered = deferred<void>(); const commit = deferred<void>(); let observersClosed = false;
    storage.close = vi.fn(() => { observersClosed = true; });
    storage.subscribe(() => { if (observersClosed) throw new DOMException("Observer closed", "InvalidStateError"); });
    if (operation === "enqueue") {
      const enqueue = storage.enqueue;
      storage.enqueue = async (...args) => { entered.resolve(); await commit.promise; return enqueue(...args); };
    } else {
      const retry = storage.retry;
      storage.retry = async (...args) => { entered.resolve(); await commit.promise; return retry(...args); };
    }
    const { outbox, transmit } = controller(storage, { ownsStorage: true }); await outbox.ready;
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = operation === "enqueue" ? outbox.enqueue(message("one")) : outbox.retry("failed");
      await entered.promise; outbox.dispose(); await flush(); expect(storage.close).toHaveBeenCalledTimes(1);
      commit.resolve();
      const saved = await pending;
      expect(saved.state).toBe("queued"); expect((await storage.get(scope, saved.id))?.state).toBe("queued");
      expect(transmit).not.toHaveBeenCalled(); expect(diagnostics).toHaveBeenCalledTimes(1);
    } finally { diagnostics.mockRestore(); }
  });

  it("assigns a stable operation ID and requires explicit destinations", () => {
    expect(isReliableEnvelope({ type: "ticket.stop", ticketId: "T-1" })).toBe(true);
    expect(isReliableEnvelope({ type: "ticket.inspect", ticketId: "T-1" })).toBe(false);
    expect(isReliableEnvelope({ type: "schedule.stop", ticketId: "T-1" })).toBe(true);
    expect(withReliableId({ type: "schedule.delete", ticketId: "T-1", commandId: " schedule-one " })).toMatchObject({ commandId: "schedule-one" });
    const first = withReliableId({ type: "chat.send", topicId: "topic-one", content: "同样内容" });
    expect(reliableEnvelopeId(first)).not.toBe(reliableEnvelopeId(withReliableId({ type: "chat.send", topicId: "topic-one", content: "同样内容" })));
    expect(withReliableId(first)).toEqual(first);
    expect(withReliableId({ type: "ticket.retry", ticketId: "T-1", commandId: " original " })).toMatchObject({ commandId: "original" });
    expect(() => withReliableId({ type: "chat.abort" })).toThrow("所属话题");
  });

  it("commits an offline queue before returning and stores ready attachment references without blob URLs", async () => {
    const { outbox, storage, transmit } = controller();
    const first = await outbox.enqueue(message("one"), { topicId: "topic-one", draftKey: "topic:topic-one", rawUserText: "one", draftAttachments: [
      { localId: "image-local", status: "ready", kind: "image", name: "image.png", mimeType: "image/png", size: 2, previewUrl: "blob:temporary", attachment: { id: "asset-one", name: "image.png", mimeType: "image/png", size: 2, kind: "image", url: "/api/uploads/asset-one" } },
      { localId: "unfinished", status: "uploading", kind: "file", name: "unfinished", mimeType: "application/octet-stream", size: 5 },
    ] });
    expect((await storage.get(scope, "one"))?.sequence).toBe(first.sequence);
    expect(first.metadata?.draftAttachments).toHaveLength(1);
    expect(first.metadata?.draftAttachments?.[0]).not.toHaveProperty("previewUrl");
    expect(first.state).toBe("queued"); expect(transmit).not.toHaveBeenCalled();
    const second = await outbox.enqueue(message("two"));
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });

  it("shares an existing identity but rejects changed text, attachments, destination or action", async () => {
    const { outbox } = controller();
    const first = await outbox.enqueue(message("one"));
    expect((await outbox.enqueue(message("one"))).sequence).toBe(first.sequence);
    for (const changed of [message("one", "changed"), { ...message("one"), topicId: "other" },
      { ...message("one"), attachments: [{ id: "asset", name: "image.png", kind: "image" as const, mimeType: "image/png", size: 5, url: "/api/uploads/asset" }] },
      { type: "chat.abort" as const, topicId: "topic-one", requestId: "one" }]) {
      await expect(outbox.enqueue(changed)).rejects.toMatchObject({ code: "request_intent_conflict" });
    }
    expect(outbox.getSnapshot()).toHaveLength(1); expect(outbox.getError()).toBeUndefined();
  });

  it("does not transmit when the local storage commit fails", async () => {
    const storage = createMemoryOutboxStorage();
    storage.enqueue = vi.fn(async () => { throw new Error("存储空间不足"); });
    const onError = vi.fn(); const { outbox, transmit } = controller(storage, { onError });
    outbox.setConnected(true);
    await expect(outbox.enqueue(message("one"))).rejects.toThrow("存储空间不足");
    expect(transmit).not.toHaveBeenCalled(); expect(outbox.getError()?.message).toBe("存储空间不足");
    expect(onError).toHaveBeenCalled();
  });
});

describe("reliable outbox delivery", () => {
  it("persists exponential retry deadlines in the actual disconnect-before-rejection calling order", async () => {
    const failures = [deferred<ReliableOutboxAck>(), deferred<ReliableOutboxAck>()];
    const transmit = vi.fn().mockImplementationOnce(() => failures[0]!.promise).mockImplementationOnce(() => failures[1]!.promise).mockResolvedValue(ack(1));
    const { outbox, storage } = controller(undefined, { transmit });
    await outbox.enqueue(message("one")); await outbox.enqueue(message("two")); outbox.setConnected(true); await flush();
    outbox.setConnected(false); failures[0]!.reject(disconnected()); await flush();
    expect(await storage.get(scope, "one")).toMatchObject({ state: "queued", attempt: 1, nextAttemptAt: Date.now() + 1000 });
    outbox.setConnected(true); await flush(); expect(transmit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); expect(transmit).toHaveBeenCalledTimes(2);
    outbox.setConnected(false); failures[1]!.reject(disconnected()); await flush();
    expect(await storage.get(scope, "one")).toMatchObject({ state: "queued", attempt: 2, nextAttemptAt: Date.now() + 2000 });
    outbox.setConnected(true); await vi.advanceTimersByTimeAsync(1999); expect(transmit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); await flush();
    expect(transmit.mock.calls.map((call) => reliableEnvelopeId(call[0]))).toEqual(["one", "one", "one", "two"]);
  });

  it("commits a transient failure deadline during disposal before a refreshed controller resumes", async () => {
    const storage = createMemoryOutboxStorage(); const interrupted = deferred<ReliableOutboxAck>();
    const old = controller(storage, { transmit: () => interrupted.promise });
    await old.outbox.enqueue(message("one")); old.outbox.setConnected(true); await flush(); old.outbox.dispose();
    interrupted.reject(disconnected()); await flush();
    expect(await storage.get(scope, "one")).toMatchObject({ state: "queued", nextAttemptAt: Date.now() + 1000 });
    const restored = controller(storage); await restored.outbox.ready; restored.outbox.setConnected(true); await flush();
    expect(restored.transmit).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1000);
    expect(restored.transmit).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite or release another tab's lease after the old disconnected transmitter rejects late", async () => {
    const storage = createMemoryOutboxStorage(); const oldRequest = deferred<ReliableOutboxAck>(); const newerRequest = deferred<ReliableOutboxAck>();
    const old = controller(storage, { ownerId: "old-owner", transmit: () => oldRequest.promise });
    const newer = controller(storage, { ownerId: "new-owner", transmit: async (envelope) => reliableEnvelopeId(envelope) === "one" ? ack(1) : newerRequest.promise });
    await old.outbox.enqueue(message("one")); await old.outbox.enqueue(message("two")); old.outbox.setConnected(true); await flush();
    old.outbox.setConnected(false); newer.outbox.setConnected(true); await vi.advanceTimersByTimeAsync(6000); await flush();
    oldRequest.reject(disconnected()); await flush();
    expect(await storage.get(scope, "one")).toMatchObject({ state: "accepted" });
    expect(await storage.renew(scope, "new-owner", Date.now(), 6000)).toBe(true);
    newerRequest.resolve(ack(2)); await flush(); expect(await newer.outbox.waitForAck("two")).toEqual(ack(2));
  });

  it("returns a committed enqueue even if its following projection read fails, then drains the original ID once", async () => {
    const storage = createMemoryOutboxStorage(); const enqueue = storage.enqueue; const list = storage.list; let failReads = false;
    storage.list = async (...args) => { if (failReads) throw new Error("读取中断"); return list(...args); };
    storage.enqueue = async (...args) => { const record = await enqueue(...args); failReads = true; return record; };
    const { outbox, transmit } = controller(storage); await outbox.ready;
    const committed = await outbox.enqueue(message("one"));
    expect(committed.id).toBe("one"); expect((await storage.get(scope, "one"))?.id).toBe("one");
    expect(outbox.getError()?.message).toBe("读取中断"); expect(transmit).not.toHaveBeenCalled();
    failReads = false; await outbox.refresh(); outbox.setConnected(true); await flush();
    expect(await outbox.waitForAck("one")).toEqual(ack(1)); expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("returns a committed retry even if its following projection read fails", async () => {
    const storage = createMemoryOutboxStorage(); await failedMessage(storage);
    const list = storage.list; const retry = storage.retry; let failReads = false;
    storage.list = async (...args) => { if (failReads) throw new Error("读取中断"); return list(...args); };
    storage.retry = async (...args) => { const record = await retry(...args); failReads = true; return record; };
    const { outbox, transmit } = controller(storage); await outbox.ready;
    await expect(outbox.retry("failed")).resolves.toMatchObject({ state: "queued" });
    expect(await storage.get(scope, "failed")).toMatchObject({ state: "queued" });
    failReads = false; await outbox.refresh(); outbox.setConnected(true); await flush();
    expect(await outbox.waitForAck("failed")).toEqual(ack(1)); expect(transmit).toHaveBeenCalledTimes(1);
  });
  it("waits for the committed ACK of each FIFO head before sending the next message", async () => {
    const firstAck = deferred<ReliableOutboxAck>();
    const transmit = vi.fn().mockImplementationOnce(() => firstAck.promise).mockResolvedValue(ack(2));
    const { outbox } = controller(undefined, { transmit });
    const first = await outbox.enqueue(message("one")); const second = await outbox.enqueue(message("two"));
    const firstWait = outbox.waitForAck("one"); const secondWait = outbox.waitForAck("two");
    outbox.setConnected(true); await flush();
    expect(transmit.mock.calls.map((call) => reliableEnvelopeId(call[0]))).toEqual(["one"]);
    firstAck.resolve(ack(1)); await flush();
    expect(await firstWait).toEqual(ack(1)); expect(await secondWait).toEqual(ack(2));
    expect(transmit.mock.calls.map((call) => reliableEnvelopeId(call[0]))).toEqual(["one", "two"]);
    expect(outbox.getSnapshot().map((record) => record.sequence)).toEqual([first.sequence, second.sequence]);
  });

  it("automatically retries an ACK lost after server admission using the original ID and preserves later order", async () => {
    const admitted = new Map<string, number>(); const wire: string[] = [];
    const transmit = vi.fn(async (envelope: ReliableEnvelope) => {
      const id = reliableEnvelopeId(envelope); wire.push(id);
      if (!admitted.has(id)) admitted.set(id, admitted.size + 1);
      if (wire.length === 1) throw disconnected();
      return ack(admitted.get(id)!);
    });
    const { outbox } = controller(undefined, { transmit });
    await outbox.enqueue(message("one")); await outbox.enqueue(message("two"));
    outbox.setConnected(true); await flush();
    expect(wire).toEqual(["one"]); expect(outbox.getSnapshot()[0]).toMatchObject({ state: "queued", attempt: 1 });
    await vi.advanceTimersByTimeAsync(999); expect(wire).toEqual(["one"]);
    await vi.advanceTimersByTimeAsync(1); await flush();
    expect(wire).toEqual(["one", "one", "two"]); expect(admitted.size).toBe(2);
    expect(await outbox.waitForAck("one")).toEqual(ack(1));
  });

  it("restores pending sends after refresh and does not resend a confirmed operation", async () => {
    const storage = createMemoryOutboxStorage(); const before = controller(storage);
    const first = await before.outbox.enqueue(message("one")); await before.outbox.enqueue(message("two")); before.outbox.dispose();
    const transmit = vi.fn(async (envelope: ReliableEnvelope) => ack(reliableEnvelopeId(envelope) === "one" ? 1 : 2));
    const restored = controller(storage, { transmit }); await restored.outbox.ready;
    expect(restored.outbox.getSnapshot().map((record) => record.id)).toEqual(["one", "two"]);
    expect(restored.outbox.getSnapshot()[0]?.sequence).toBe(first.sequence);
    restored.outbox.setConnected(true); await flush();
    expect(transmit).toHaveBeenCalledTimes(2);
    restored.outbox.dispose();
    const next = controller(storage, { transmit }); await next.outbox.ready; next.outbox.setConnected(true); await flush();
    expect(transmit).toHaveBeenCalledTimes(2); expect(await next.outbox.waitForAck("one")).toEqual(ack(1));
  });

  it("recovers an expired send lease after a crashed page before sending later requests", async () => {
    const storage = createMemoryOutboxStorage();
    await storage.enqueue(scope, message("one"), undefined, Date.now()); await storage.enqueue(scope, message("two"), undefined, Date.now());
    await storage.claim(scope, "dead-page", Date.now(), 6000);
    const transmit = vi.fn(async (_envelope: ReliableEnvelope) => ack(1)); const { outbox } = controller(storage, { transmit });
    await outbox.ready; outbox.setConnected(true); await flush(); expect(transmit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000); await flush();
    expect(transmit.mock.calls.map((call) => reliableEnvelopeId(call[0]))).toEqual(["one", "two"]);
    expect(outbox.getSnapshot()[0]).toMatchObject({ state: "accepted", attempt: 2 });
  });

  it("does not let two tabs send different FIFO entries while the first ACK is pending", async () => {
    const storage = createMemoryOutboxStorage(); const firstAck = deferred<ReliableOutboxAck>();
    const firstWire = vi.fn((_envelope: ReliableEnvelope) => firstAck.promise); const secondWire = vi.fn(async (_envelope: ReliableEnvelope) => ack(2));
    const one = controller(storage, { transmit: firstWire, ownerId: "tab-one" });
    const two = controller(storage, { transmit: secondWire, ownerId: "tab-two" });
    await one.outbox.enqueue(message("one")); await two.outbox.enqueue(message("two"));
    one.outbox.setConnected(true); await flush(); two.outbox.setConnected(true); await flush();
    expect(firstWire).toHaveBeenCalledTimes(1); expect(secondWire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000); expect(firstWire).toHaveBeenCalledTimes(1); expect(secondWire).not.toHaveBeenCalled();
    firstAck.resolve(ack(1)); await flush();
    expect(await one.outbox.waitForAck("one")).toEqual(ack(1));
    expect(await two.outbox.waitForAck("one")).toEqual(ack(1));
    const all = [...firstWire.mock.calls, ...secondWire.mock.calls].map((call) => reliableEnvelopeId(call[0]));
    expect(all.filter((id) => id === "one")).toHaveLength(1);
    expect(all.filter((id) => id === "two")).toHaveLength(1);
  });

  it("marks permanent rejection as failed, permits explicit retry with the original ID and never loops it automatically", async () => {
    const transmit = vi.fn().mockRejectedValueOnce(Object.assign(new Error("内容冲突"), { code: "request_intent_conflict" })).mockResolvedValue(ack(2));
    const { outbox } = controller(undefined, { transmit }); await outbox.enqueue(message("one")); await outbox.enqueue(message("two"));
    const wait = expect(outbox.waitForAck("one")).rejects.toMatchObject({ message: "内容冲突", code: "request_intent_conflict" });
    outbox.setConnected(true); await flush(); await wait;
    expect(outbox.getSnapshot()[0]).toMatchObject({ state: "failed", id: "one" });
    await vi.advanceTimersByTimeAsync(120_000); expect(transmit).toHaveBeenCalledTimes(2);
    await outbox.retry("one"); await flush();
    expect(transmit.mock.calls.map((call) => reliableEnvelopeId(call[0]))).toEqual(["one", "two", "one"]);
    expect(await outbox.waitForAck("one")).toEqual(ack(2));
  });

  it("keeps a server-accepted head durable if the local ACK commit fails so refresh can safely replay it", async () => {
    const storage = createMemoryOutboxStorage(); const accept = storage.accept;
    storage.accept = vi.fn().mockRejectedValueOnce(new Error("本地写入中断")).mockImplementation(accept);
    const wire: string[] = []; const admitted = new Set<string>();
    const transmit = vi.fn(async (envelope: ReliableEnvelope) => { const id = reliableEnvelopeId(envelope); wire.push(id); admitted.add(id); return ack(id === "one" ? 1 : 2); });
    const old = controller(storage, { transmit }); await old.outbox.enqueue(message("one")); await old.outbox.enqueue(message("two"));
    old.outbox.setConnected(true); await flush();
    expect(wire).toEqual(["one"]); expect(old.outbox.getError()?.message).toBe("本地写入中断");
    old.outbox.dispose(); const restored = controller(storage, { transmit }); await restored.outbox.ready; restored.outbox.setConnected(true); await flush();
    expect(wire).toEqual(["one", "one", "two"]); expect(admitted.size).toBe(2);
  });

  it("preserves scope isolation and rejects removal of a pending operation", async () => {
    const storage = createMemoryOutboxStorage(); const old = controller(storage);
    await old.outbox.enqueue(message("same"));
    const other = controller(storage, { scope: "http://moco.test|other-hub|device-one" });
    await other.outbox.enqueue(message("same", "different hub")); other.outbox.setConnected(true); await flush();
    expect(old.outbox.getSnapshot()[0]?.state).toBe("queued");
    expect(other.outbox.getSnapshot()[0]?.state).toBe("accepted");
    await expect(old.outbox.remove("same")).rejects.toThrow("只能移除");
    expect(old.outbox.getError()).toBeUndefined();
    await expect(old.outbox.retry("missing")).rejects.toMatchObject({ code: "outbox_request_missing" });
    expect(old.outbox.getError()).toBeUndefined();
    await old.outbox.removeAccepted(["same"]); expect(old.outbox.getSnapshot()).toHaveLength(1);
  });

  it("keeps the durable ACK authoritative when cleanup fails and never resends the accepted operation", async () => {
    const { outbox, storage, transmit } = controller(); await outbox.enqueue(message("one")); outbox.setConnected(true); await flush();
    expect(await outbox.waitForAck("one")).toEqual(ack(1));
    storage.removeAccepted = vi.fn(async () => { throw new Error("清理写入中断"); });
    await expect(outbox.removeAccepted(["one"])).rejects.toThrow("清理写入中断");
    expect(outbox.getError()?.message).toBe("清理写入中断");
    expect((await storage.lookup(scope, "one")).record?.state).toBe("accepted");
    expect(await outbox.waitForAck("one")).toEqual(ack(1));
    outbox.setConnected(true); await vi.advanceTimersByTimeAsync(60_000); await flush();
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("wakes a waiting tab even when the accepted record is consumed before its next refresh", async () => {
    const storage = createMemoryOutboxStorage(); const first = controller(storage); const second = controller(storage);
    await first.outbox.enqueue(message("one")); const wait = second.outbox.waitForAck("one"); await flush();
    await storage.accept(scope, "one", ack(1)); await storage.removeAccepted(scope, ["one"]); await flush();
    expect(await wait).toEqual(ack(1)); expect(await second.outbox.waitForAck("one")).toEqual(ack(1));
  });

  it("does not use a retired ACK cache for a newly enqueued operation that reuses the ID", async () => {
    const { outbox } = controller(); await outbox.enqueue(message("one"));
    outbox.setConnected(true); await flush(); expect(await outbox.waitForAck("one")).toEqual(ack(1));
    outbox.setConnected(false); await outbox.removeAccepted(["one"]); await outbox.enqueue(message("one", "changed"));
    let resolved = false; const waiting = outbox.waitForAck("one").then(() => { resolved = true; }).catch(() => {}); await flush();
    expect(resolved).toBe(false); outbox.dispose(); await waiting;
  });

  it("reads a durable ACK receipt after row consumption even when every broadcast is still delayed", async () => {
    const storage = createMemoryOutboxStorage(); const subscribe = storage.subscribe;
    const deliveries: Array<() => void> = [];
    storage.subscribe = (listener) => subscribe((event) => { deliveries.push(() => listener(event)); });
    const { outbox } = controller(storage); await outbox.enqueue(message("one"));
    await storage.accept(scope, "one", ack(1)); await storage.removeAccepted(scope, ["one"]);
    expect(outbox.getSnapshot()[0]?.state).toBe("queued");
    expect(deliveries.length).toBeGreaterThan(0);
    expect(await outbox.waitForAck("one")).toEqual(ack(1));
    const restored = controller(storage); await restored.outbox.ready;
    expect(restored.outbox.getSnapshot()).toEqual([]);
    expect(await restored.outbox.waitForAck("one")).toEqual(ack(1));
  });

  it("never confirms a new payload from a retired receipt, delayed broadcast or late old transmitter", async () => {
    const storage = createMemoryOutboxStorage(); const subscribe = storage.subscribe;
    const deliveries: Array<() => void> = [];
    storage.subscribe = (listener) => subscribe((event) => { deliveries.push(() => listener(event)); });
    const transmit = vi.fn(async (_envelope: ReliableEnvelope): Promise<ReliableOutboxAck> => { throw Object.assign(new Error("内容冲突"), { code: "request_intent_conflict" }); });
    const { outbox } = controller(storage, { transmit }); const first = await outbox.enqueue(message("one"));
    await storage.accept(scope, "one", ack(1)); await storage.removeAccepted(scope, ["one"]);
    const replacement = await outbox.enqueue(message("one", "different content"));
    expect(replacement.sequence).toBeGreaterThan(first.sequence);
    let resolved = false;
    const failed = expect(outbox.waitForAck("one").then((value) => { resolved = true; return value; })).rejects.toMatchObject({ code: "request_intent_conflict" });
    await flush();
    for (const deliver of deliveries.splice(0)) deliver(); await flush();
    await storage.accept(scope, "one", ack(1), first.sequence);
    for (const deliver of deliveries.splice(0)) deliver(); await flush();
    expect(resolved).toBe(false); expect((await storage.get(scope, "one"))?.state).toBe("queued");
    outbox.setConnected(true); await flush(); await failed;
    expect(resolved).toBe(false); expect(outbox.getSnapshot()[0]?.state).toBe("failed");
  });

  it("closes owned storage only after lease release and an in-flight ACK commit finish", async () => {
    const storage = createMemoryOutboxStorage(); const release = storage.release;
    const released = deferred<void>(); const transmitted = deferred<ReliableOutboxAck>();
    storage.close = vi.fn();
    storage.release = async (...args) => { await released.promise; await release(...args); };
    const { outbox } = controller(storage, { ownsStorage: true, transmit: () => transmitted.promise });
    await outbox.enqueue(message("one")); outbox.setConnected(true); await flush();
    outbox.dispose(); await flush(); expect(storage.close).not.toHaveBeenCalled();
    released.resolve(); await flush(); expect(storage.close).not.toHaveBeenCalled();
    transmitted.resolve(ack(1)); await flush(); expect(storage.close).toHaveBeenCalledTimes(1);
    expect((await storage.lookup(scope, "one")).receipt?.ack).toEqual(ack(1));
    const shared = createMemoryOutboxStorage(); shared.close = vi.fn(); controller(shared).outbox.dispose(); await flush();
    expect(shared.close).not.toHaveBeenCalled();
  });
});

describe("editing a failed durable message", () => {
  it("keeps the failed source recoverable if the page closes while its text is being edited", async () => {
    const storage = createMemoryOutboxStorage(); const original = await failedMessage(storage);
    const editor = controller(storage); await editor.outbox.ready;
    const recoveredText = editor.outbox.getSnapshot()[0]?.metadata?.rawUserText;
    expect(recoveredText).toBe("original draft"); editor.outbox.dispose();
    const restored = controller(storage); await restored.outbox.ready;
    expect(restored.outbox.getSnapshot()).toEqual([original]);
  });

  it("retains the failed source if the replacement cannot be committed", async () => {
    const storage = createMemoryOutboxStorage(); const original = await failedMessage(storage); const { outbox, transmit } = controller(storage);
    await expect(outbox.enqueue(message("replacement", "edited"), {
      replacesFailed: { id: original.id, sequence: original.sequence, scope }, rawUserText: (() => {}) as unknown as string,
    })).rejects.toMatchObject({ name: "DataCloneError" });
    expect(await storage.list(scope)).toEqual([original]); expect(transmit).not.toHaveBeenCalled();
  });

  it("atomically replaces only the referenced failed row and strips the edit association from the durable metadata", async () => {
    const storage = createMemoryOutboxStorage(); const original = await failedMessage(storage); const events: unknown[] = [];
    storage.subscribe((event) => events.push(event)); const { outbox } = controller(storage);
    const replacement = await outbox.enqueue(message("replacement", "edited"), {
      rawUserText: "edited", replacesFailed: { id: original.id, sequence: original.sequence, scope },
    });
    expect(await storage.list(scope)).toEqual([replacement]); expect(replacement.metadata).toEqual({ rawUserText: "edited" });
    expect(events).toContainEqual({ scope, removed: { id: original.id, sequence: original.sequence } });
    outbox.setConnected(true); await flush(); expect(await outbox.waitForAck(replacement.id)).toEqual(ack(1));
  });

  it("rejects replacement if another tab has already retried and started sending the old message", async () => {
    const storage = createMemoryOutboxStorage(); const original = await failedMessage(storage); const { outbox, transmit } = controller(storage);
    await storage.retry(scope, original.id, Date.now()); await storage.claim(scope, "other-page", Date.now(), 6000);
    await expect(outbox.enqueue(message("replacement", "edited"), { replacesFailed: { id: original.id, sequence: original.sequence, scope } })).rejects.toMatchObject({ code: "outbox_edit_conflict" });
    expect((await storage.list(scope)).map((record) => [record.id, record.state])).toEqual([[original.id, "sending"]]);
    expect(outbox.getError()).toBeUndefined(); expect(transmit).not.toHaveBeenCalled();
  });

  it("rejects missing, changed-sequence or cross-scope edit references without mutating either intent", async () => {
    const storage = createMemoryOutboxStorage(); const original = await failedMessage(storage); const { outbox } = controller(storage);
    for (const reference of [{ id: "missing", sequence: original.sequence, scope }, { id: original.id, sequence: original.sequence + 1, scope },
      { id: original.id, sequence: original.sequence, scope: "other-hub" }]) {
      await expect(outbox.enqueue(message("replacement", "edited"), { replacesFailed: reference })).rejects.toMatchObject({ code: "outbox_edit_conflict" });
    }
    expect(await storage.list(scope)).toEqual([original]); expect(outbox.getError()).toBeUndefined();
  });

  it("allows only one concurrent replacement of the same failed source", async () => {
    const storage = createMemoryOutboxStorage(); const original = await failedMessage(storage);
    const one = controller(storage); const two = controller(storage); const reference = { id: original.id, sequence: original.sequence, scope };
    const attempts = await Promise.allSettled([one.outbox.enqueue(message("replacement-one", "edited"), { replacesFailed: reference }), two.outbox.enqueue(message("replacement-two", "edited"), { replacesFailed: reference })]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect((await storage.list(scope)).map((record) => record.id)).toEqual(["replacement-one"]);
  });

  it("treats an atomic replacement as committed even if the following read fails", async () => {
    const storage = createMemoryOutboxStorage(); const original = await failedMessage(storage); const list = storage.list; const enqueue = storage.enqueue;
    let failReads = false; storage.list = async (...args) => { if (failReads) throw new Error("读取中断"); return list(...args); };
    storage.enqueue = async (...args) => { const record = await enqueue(...args); failReads = true; return record; };
    const { outbox, transmit } = controller(storage); await outbox.ready;
    const replacement = await outbox.enqueue(message("replacement", "edited"), { replacesFailed: { id: original.id, sequence: original.sequence, scope } });
    expect(replacement.id).toBe("replacement"); expect(await storage.get(scope, original.id)).toBeUndefined();
    expect((await storage.get(scope, replacement.id))?.id).toBe(replacement.id);
    failReads = false; await outbox.refresh(); outbox.setConnected(true); await flush();
    expect(transmit).toHaveBeenCalledTimes(1); expect(await outbox.waitForAck("replacement")).toEqual(ack(1));
  });
});
