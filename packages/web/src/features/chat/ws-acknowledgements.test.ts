import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWithAcknowledgement, type PendingWsAcknowledgement } from "./ws-acknowledgements";

describe("WebSocket acknowledgement ownership", () => {
  afterEach(() => vi.useRealTimers());

  it("shares the original in-flight acknowledgement without overwriting or resending it", async () => {
    const pending = new Map<string, PendingWsAcknowledgement<{ submissionId: number }>>();
    const send = vi.fn();
    const wait = () => sendWithAcknowledgement(pending, "message-one", "chat.send", send, () => new Error("timeout"), 1000);
    const first = wait();
    const retry = wait();
    expect(retry).toBe(first);
    expect(send).toHaveBeenCalledTimes(1);
    pending.get("message-one")!.resolve({ submissionId: 42 });
    expect(await Promise.all([first, retry])).toEqual([{ submissionId: 42 }, { submissionId: 42 }]);
    expect(pending.size).toBe(0);
  });

  it("rejects a conflicting action without disturbing the original request", async () => {
    const pending = new Map<string, PendingWsAcknowledgement<boolean>>();
    const send = vi.fn();
    const first = sendWithAcknowledgement(pending, "same", "chat.send", send, () => new Error("timeout"), 1000);
    await expect(sendWithAcknowledgement(pending, "same", "chat.retry", send, () => new Error("timeout"), 1000)).rejects.toThrow("另一项请求");
    expect(send).toHaveBeenCalledTimes(1);
    pending.get("same")!.resolve(true);
    await expect(first).resolves.toBe(true);
  });

  it("releases only the timed-out request so it can be explicitly retried with its original ID", async () => {
    vi.useFakeTimers();
    const pending = new Map<string, PendingWsAcknowledgement<boolean>>();
    const send = vi.fn();
    const first = sendWithAcknowledgement(pending, "one", "chat.send", send, () => new Error("待确认"), 100);
    const second = sendWithAcknowledgement(pending, "two", "chat.send", send, () => new Error("timeout"), 1000);
    const rejected = expect(first).rejects.toThrow("待确认");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect([...pending.keys()]).toEqual(["two"]);
    const retry = sendWithAcknowledgement(pending, "one", "chat.send", send, () => new Error("timeout"), 1000);
    pending.get("one")!.resolve(true);
    pending.get("two")!.resolve(true);
    await expect(Promise.all([retry, second])).resolves.toEqual([true, true]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("clears a synchronous transport failure without leaving a hanging acknowledgement", async () => {
    const pending = new Map<string, PendingWsAcknowledgement<boolean>>();
    await expect(sendWithAcknowledgement(pending, "one", "chat.send", () => { throw new Error("closed"); }, () => new Error("timeout"), 1000)).rejects.toThrow("closed");
    expect(pending.size).toBe(0);
  });
});
