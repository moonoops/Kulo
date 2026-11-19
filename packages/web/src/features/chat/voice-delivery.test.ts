import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment, ClientToHubMessage } from "@kulo/protocol";
import { createVoiceDelivery, type VoiceUploadOptions } from "./voice-delivery";
import type { VoiceRecording } from "./voice-recorder";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function recording(id = "recording-one"): VoiceRecording {
  return { id, file: new File(["encoded audio"], "voice.webm", { type: "audio/webm;codecs=opus", lastModified: 1000 }), duration: 2.75 };
}

function asset(changes: Partial<ChatAttachment> = {}): ChatAttachment {
  return { id: "voice-asset", name: "voice.webm", kind: "audio", mimeType: "audio/webm", size: 13, url: "/api/uploads/voice-asset", presentation: "voice", recordedDuration: 2.75, ...changes };
}

function setup() {
  const upload = vi.fn(async (_file: File, _name: string | undefined, _options: VoiceUploadOptions): Promise<ChatAttachment> => asset());
  const transmit = vi.fn(async (_message: ClientToHubMessage): Promise<unknown> => ({ accepted: true }));
  return { upload, transmit, delivery: createVoiceDelivery({ upload, send: transmit }) };
}

const firstTopic = { topicId: "topic-a" };

describe("voice delivery", () => {
  it("publishes a voice asset and immediately sends an independent attachment-only message", async () => {
    const { delivery, upload, transmit } = setup();
    const voice = recording();
    const onProgress = vi.fn();
    const result = await delivery.send(voice, firstTopic, { onProgress });
    expect(upload).toHaveBeenCalledWith(voice.file, voice.file.name, expect.objectContaining({ presentation: "voice", recordedDuration: 2.75, onProgress, idempotencyKey: expect.any(String), signal: expect.any(AbortSignal) }));
    expect(transmit).toHaveBeenCalledWith({ type: "chat.send", topicId: "topic-a", content: "", attachments: [result], requestId: expect.any(String) });
    expect(result.presentation).toBe("voice");
  });

  it("relays actual upload progress to the caller", async () => {
    const { delivery, upload } = setup();
    const onProgress = vi.fn();
    upload.mockImplementationOnce(async (_file, _name, options) => { options.onProgress?.(4, 13); return asset(); });
    await delivery.send(recording(), firstTopic, { onProgress });
    expect(onProgress).toHaveBeenCalledWith(4, 13);
  });

  it("retries an uncertain upload with the same upload id before sending", async () => {
    const { delivery, upload, transmit } = setup();
    upload.mockRejectedValueOnce(new Error("upload acknowledgment lost"));
    const voice = recording();
    await expect(delivery.send(voice, firstTopic)).rejects.toThrow("upload acknowledgment lost");
    expect(transmit).not.toHaveBeenCalled();
    await delivery.send(voice, firstTopic);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]![2].idempotencyKey).toBe(upload.mock.calls[0]![2].idempotencyKey);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("reuses the uploaded asset and chat request id after an uncertain WebSocket acknowledgment", async () => {
    const { delivery, upload, transmit } = setup();
    transmit.mockRejectedValueOnce(new Error("connection lost before acknowledgment"));
    const voice = recording();
    await expect(delivery.send(voice, firstTopic)).rejects.toThrow("connection lost");
    await delivery.send(voice, { topicId: "another-topic" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(transmit).toHaveBeenCalledTimes(2);
    expect(transmit.mock.calls[1]![0]).toBe(transmit.mock.calls[0]![0]);
    expect(transmit.mock.calls[1]![0]).toMatchObject({ type: "chat.send", topicId: "topic-a", requestId: expect.any(String) });
  });

  it("steers the original active ticket with a stable command id and no competing request id", async () => {
    const { delivery, upload, transmit } = setup();
    const voice = recording();
    transmit.mockRejectedValueOnce(new Error("ack timeout"));
    await expect(delivery.send(voice, { topicId: "topic-a", ticketId: "ticket-a", ticketTitle: "灯光方案" })).rejects.toThrow("ack timeout");
    await delivery.send(voice, { topicId: "topic-b", ticketId: "ticket-b" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(transmit.mock.calls[0]![0]).toMatchObject({ type: "ticket.steer", ticketId: "ticket-a", text: "", commandId: expect.any(String) });
    expect(transmit.mock.calls[0]![0]).not.toHaveProperty("requestId");
    expect(transmit.mock.calls[1]![0]).toBe(transmit.mock.calls[0]![0]);
  });

  it("sends closed or stopped ticket recordings to their original topic with task context", async () => {
    const { delivery, transmit } = setup();
    await delivery.send(recording(), { topicId: "topic-a", ticketId: "ticket-a", ticketTitle: "客厅灯光", ticketClosed: true });
    expect(transmit).toHaveBeenCalledWith(expect.objectContaining({ type: "chat.send", topicId: "topic-a", content: "关于任务「客厅灯光」：", requestId: expect.any(String) }));
    expect(transmit.mock.calls[0]![0]).not.toHaveProperty("commandId");
  });

  it("keeps the first destination snapshot even when the caller changes its object during upload", async () => {
    const { delivery, upload, transmit } = setup();
    const pending = deferred<ChatAttachment>();
    upload.mockReturnValueOnce(pending.promise);
    const target = { topicId: "topic-a", ticketId: "ticket-a", ticketTitle: "原任务", ticketClosed: true };
    const sending = delivery.send(recording(), target);
    target.topicId = "topic-b"; target.ticketId = "ticket-b"; target.ticketTitle = "其他任务"; target.ticketClosed = false;
    pending.resolve(asset());
    await sending;
    expect(transmit).toHaveBeenCalledWith(expect.objectContaining({ type: "chat.send", topicId: "topic-a", content: "关于任务「原任务」：" }));
  });

  it("joins concurrent calls for the same recording into one upload and submission", async () => {
    const { delivery, upload, transmit } = setup();
    const pending = deferred<ChatAttachment>();
    upload.mockReturnValueOnce(pending.promise);
    const voice = recording();
    const first = delivery.send(voice, firstTopic);
    const second = delivery.send(voice, { topicId: "topic-b" });
    expect(second).toBe(first);
    expect(upload).toHaveBeenCalledTimes(1);
    pending.resolve(asset());
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("checks the original ticket's latest closure state after upload and before the first envelope", async () => {
    const { upload, transmit } = setup();
    const pending = deferred<ChatAttachment>();
    upload.mockReturnValueOnce(pending.promise);
    let closed = false;
    const isTicketClosed = vi.fn((_id: string) => closed);
    const delivery = createVoiceDelivery({ upload, send: transmit, isTicketClosed });
    const sending = delivery.send(recording(), { topicId: "original-topic", ticketId: "original-ticket", ticketTitle: "灯光方案" });
    expect(isTicketClosed).not.toHaveBeenCalled();
    closed = true; pending.resolve(asset());
    await sending;
    expect(isTicketClosed).toHaveBeenCalledExactlyOnceWith("original-ticket");
    expect(transmit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "chat.send", topicId: "original-topic", content: "关于任务「灯光方案」：" }));
  });

  it("uses the frozen initial closure state when the latest ticket is unavailable", async () => {
    const { upload, transmit } = setup();
    const delivery = createVoiceDelivery({ upload, send: transmit, isTicketClosed: () => undefined });
    await delivery.send(recording(), { topicId: "original-topic", ticketId: "original-ticket", ticketClosed: true });
    expect(transmit.mock.calls[0]![0]).toMatchObject({ type: "chat.send", topicId: "original-topic" });
  });

  it("falls back once to the frozen original topic after an explicit stopped-ticket rejection", async () => {
    const { upload, transmit } = setup();
    transmit.mockRejectedValueOnce(Object.assign(new Error("任务已停止，不能恢复。"), { code: "ticket_stopped" }));
    const delivery = createVoiceDelivery({ upload, send: transmit, isTicketClosed: () => false });
    const voice = recording();
    const result = await delivery.send(voice, { topicId: "original-topic", ticketId: "original-ticket", ticketTitle: "灯光方案" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(transmit.mock.calls.map(([message]) => message.type)).toEqual(["ticket.steer", "chat.send"]);
    expect(transmit.mock.calls[1]![0]).toMatchObject({ topicId: "original-topic", content: "关于任务「灯光方案」：", requestId: expect.any(String), attachments: [result] });
    await delivery.send(voice, { topicId: "unrelated-topic" });
    expect(transmit).toHaveBeenCalledTimes(2);
  });

  it("retains the fallback chat request id and asset when its acknowledgment is uncertain", async () => {
    const { upload, transmit } = setup();
    transmit.mockRejectedValueOnce(Object.assign(new Error("stopped"), { code: "ticket_stopped" }));
    transmit.mockRejectedValueOnce(Object.assign(new Error("ack unknown"), { isDisconnect: true }));
    const delivery = createVoiceDelivery({ upload, send: transmit });
    const voice = recording();
    await expect(delivery.send(voice, { topicId: "original-topic", ticketId: "original-ticket" })).rejects.toThrow("ack unknown");
    await delivery.send(voice, { topicId: "unrelated-topic", ticketId: "another-ticket" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(transmit.mock.calls.map(([message]) => message.type)).toEqual(["ticket.steer", "chat.send", "chat.send"]);
    expect(transmit.mock.calls[2]![0]).toBe(transmit.mock.calls[1]![0]);
    expect(transmit.mock.calls[2]![0]).toMatchObject({ topicId: "original-topic", requestId: expect.any(String) });
  });

  it("retains an uncertain steer even if the ticket later closes, allowing accepted-steer dedupe", async () => {
    const { upload, transmit } = setup();
    let closed = false;
    const isTicketClosed = vi.fn((_id: string) => closed);
    const delivery = createVoiceDelivery({ upload, send: transmit, isTicketClosed });
    transmit.mockRejectedValueOnce(Object.assign(new Error("ack unknown"), { isDisconnect: true }));
    const voice = recording();
    await expect(delivery.send(voice, { topicId: "original-topic", ticketId: "original-ticket" })).rejects.toThrow("ack unknown");
    closed = true;
    await delivery.send(voice, { topicId: "unrelated-topic", ticketId: "unrelated-ticket", ticketClosed: true });
    expect(isTicketClosed).toHaveBeenCalledTimes(1);
    expect(transmit.mock.calls.map(([message]) => message.type)).toEqual(["ticket.steer", "ticket.steer"]);
    expect(transmit.mock.calls[1]![0]).toBe(transmit.mock.calls[0]![0]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("does not submit the stopped-ticket fallback after cancellation between rejection and fallback", async () => {
    const { upload, transmit } = setup();
    const controller = new AbortController();
    transmit.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error("stopped"), { code: "ticket_stopped" });
    });
    const delivery = createVoiceDelivery({ upload, send: transmit });
    const voice = recording();
    await expect(delivery.send(voice, { topicId: "original-topic", ticketId: "original-ticket" }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(transmit).toHaveBeenCalledTimes(1);
    await delivery.send(voice, { topicId: "unrelated-topic" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(transmit.mock.calls.map(([message]) => message.type)).toEqual(["ticket.steer", "chat.send"]);
    expect(transmit.mock.calls[1]![0]).toMatchObject({ topicId: "original-topic", requestId: expect.any(String) });
  });

  it("reports the acknowledged chat destination only after WebSocket acceptance", async () => {
    const { upload, transmit } = setup();
    const acknowledgment = deferred<unknown>();
    transmit.mockReturnValueOnce(acknowledgment.promise);
    const delivery = createVoiceDelivery({ upload, send: transmit });
    const onAccepted = vi.fn();
    const sending = delivery.send(recording(), { topicId: "original-topic" }, { onAccepted });
    await vi.waitFor(() => expect(transmit).toHaveBeenCalledTimes(1));
    expect(onAccepted).not.toHaveBeenCalled();
    acknowledgment.resolve({ accepted: true });
    await sending;
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ topicId: "original-topic" });
  });

  it("reports an acknowledged stopped-ticket fallback as chat rather than a ticket steer", async () => {
    const { upload, transmit } = setup();
    transmit.mockRejectedValueOnce(Object.assign(new Error("stopped"), { code: "ticket_stopped" }));
    const delivery = createVoiceDelivery({ upload, send: transmit });
    const onAccepted = vi.fn();
    await delivery.send(recording(), { topicId: "original-topic", ticketId: "original-ticket" }, { onAccepted });
    expect(transmit.mock.calls.map(([message]) => message.type)).toEqual(["ticket.steer", "chat.send"]);
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ topicId: "original-topic" });
  });

  it("reports the retained steer after an unknown acknowledgment, even if the ticket is now closed", async () => {
    const { upload, transmit } = setup();
    let closed = false;
    const delivery = createVoiceDelivery({ upload, send: transmit, isTicketClosed: () => closed });
    transmit.mockRejectedValueOnce(Object.assign(new Error("ack unknown"), { isDisconnect: true }));
    const voice = recording(); const onAccepted = vi.fn();
    await expect(delivery.send(voice, { topicId: "original-topic", ticketId: "original-ticket" }, { onAccepted })).rejects.toThrow("ack unknown");
    expect(onAccepted).not.toHaveBeenCalled();
    closed = true;
    await delivery.send(voice, { topicId: "unrelated-topic", ticketId: "unrelated-ticket", ticketClosed: true }, { onAccepted });
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ topicId: "original-topic", ticketId: "original-ticket" });
    await delivery.send(voice, firstTopic, { onAccepted });
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it("does not report acceptance when cancellation blocks the stopped-ticket fallback", async () => {
    const { upload, transmit } = setup();
    const controller = new AbortController();
    transmit.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error("stopped"), { code: "ticket_stopped" });
    });
    const delivery = createVoiceDelivery({ upload, send: transmit });
    const onAccepted = vi.fn();
    await expect(delivery.send(recording(), { topicId: "original-topic", ticketId: "original-ticket" }, { signal: controller.signal, onAccepted })).rejects.toMatchObject({ name: "AbortError" });
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("returns an acknowledged result without uploading or submitting it again", async () => {
    const { delivery, upload, transmit } = setup();
    const voice = recording();
    const result = await delivery.send(voice, firstTopic);
    const controller = new AbortController(); controller.abort();
    expect(await delivery.send(voice, { topicId: "topic-b" }, { signal: controller.signal })).toBe(result);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("rejects a reused recording id whose source metadata changed", async () => {
    const { delivery, upload, transmit } = setup();
    const voice = recording();
    await delivery.send(voice, firstTopic);
    await expect(delivery.send({ ...voice, duration: voice.duration + 1 }, firstTopic)).rejects.toThrow("录音标识已用于其他内容");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("does no work when already cancelled", async () => {
    const { delivery, upload, transmit } = setup();
    const controller = new AbortController(); controller.abort();
    await expect(delivery.send(recording(), firstTopic, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(upload).not.toHaveBeenCalled(); expect(transmit).not.toHaveBeenCalled();
  });

  it("never submits an upload that completes after cancellation, even if transport ignores abort", async () => {
    const { delivery, upload, transmit } = setup();
    const pending = deferred<ChatAttachment>();
    upload.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const sending = delivery.send(recording(), firstTopic, { signal: controller.signal });
    controller.abort();
    expect(upload.mock.calls[0]![2].signal!.aborted).toBe(true);
    pending.resolve(asset());
    await expect(sending).rejects.toMatchObject({ name: "AbortError" });
    expect(transmit).not.toHaveBeenCalled();
  });

  it("does not turn an acknowledged message into a retry after cancellation during WebSocket delivery", async () => {
    const { delivery, upload, transmit } = setup();
    const acknowledgment = deferred<unknown>();
    transmit.mockReturnValueOnce(acknowledgment.promise);
    const controller = new AbortController(); const voice = recording();
    const sending = delivery.send(voice, firstTopic, { signal: controller.signal });
    await vi.waitFor(() => expect(transmit).toHaveBeenCalledTimes(1));
    controller.abort(); acknowledgment.resolve({ accepted: true });
    const result = await sending;
    expect(await delivery.send(voice, firstTopic)).toBe(result);
    expect(upload).toHaveBeenCalledTimes(1); expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("forgets discarded work without letting its late upload deliver to a new target", async () => {
    const { delivery, upload, transmit } = setup();
    const oldUpload = deferred<ChatAttachment>();
    upload.mockReturnValueOnce(oldUpload.promise);
    const voice = recording();
    const oldSend = delivery.send(voice, firstTopic);
    delivery.forget(voice.id);
    expect(upload.mock.calls[0]![2].signal!.aborted).toBe(true);
    await delivery.send(voice, { topicId: "topic-b" });
    oldUpload.resolve(asset({ id: "discarded" }));
    await expect(oldSend).rejects.toMatchObject({ name: "AbortError" });
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(transmit.mock.calls[0]![0]).toMatchObject({ type: "chat.send", topicId: "topic-b" });
    expect(upload.mock.calls[1]![2].idempotencyKey).not.toBe(upload.mock.calls[0]![2].idempotencyKey);
  });

  it("clears all pending recordings on owner teardown", async () => {
    const { delivery, upload, transmit } = setup();
    const a = deferred<ChatAttachment>(); const b = deferred<ChatAttachment>();
    upload.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const left = delivery.send(recording("one"), firstTopic);
    const right = delivery.send(recording("two"), firstTopic);
    delivery.clear(); a.resolve(asset()); b.resolve(asset());
    await expect(left).rejects.toMatchObject({ name: "AbortError" });
    await expect(right).rejects.toMatchObject({ name: "AbortError" });
    expect(transmit).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "file" as const },
    { presentation: undefined },
    { mimeType: "video/webm" },
  ])("rejects an incompatible Hub voice response and gives a restart recovery ($kind $presentation $mimeType)", async (changes) => {
    const { delivery, upload, transmit } = setup();
    upload.mockResolvedValueOnce(asset(changes));
    await expect(delivery.send(recording(), firstTopic)).rejects.toThrow("请重启中枢");
    expect(transmit).not.toHaveBeenCalled();
  });

  it.each([
    { id: "" },
    { duration: Number.NaN },
    { file: new File([], "voice.webm", { type: "audio/webm" }) },
    { file: new File(["wrong"], "clip.webm", { type: "video/webm" }) },
  ])("rejects an invalid recording before upload", async (changes) => {
    const { delivery, upload, transmit } = setup();
    await expect(delivery.send({ ...recording(), ...changes }, firstTopic)).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled(); expect(transmit).not.toHaveBeenCalled();
  });
});
