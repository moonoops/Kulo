import type { TopicSummary } from "@moco/protocol";
import { describe, expect, it, vi } from "vitest";
import { TopicDraftStore } from "./topic-drafts";

function topic(id = "saved-topic", projectId?: string): TopicSummary {
  return { id, conversationId: 1, title: "新对话", createdAt: 1, updatedAt: 1, ...(projectId ? { projectId } : {}) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function setup(create: (projectId?: string) => Promise<TopicSummary> = async () => topic()) {
  const onSaved = vi.fn();
  const onError = vi.fn();
  const createTopic = vi.fn(create);
  const store = new TopicDraftStore({ create: createTopic, onSaved, onError });
  return { store, createTopic, onSaved, onError };
}

describe("local topic drafts", () => {
  it("opens an unlisted blank topic and leaves without creating any server record", () => {
    const { store, createTopic, onSaved } = setup();
    const blank = store.start();
    expect(blank.id).toMatch(/^local-topic:/);
    expect(store.getSnapshot()).toEqual({ topics: [], selected: blank });
    expect(store.isLocal(blank.id)).toBe(true);
    store.leave();
    expect(store.getSnapshot()).toEqual({ topics: [] });
    expect(store.isLocal(blank.id)).toBe(false);
    expect(createTopic).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("replaces repeated untouched blanks without accumulating navigation records", () => {
    const { store, createTopic } = setup();
    const first = store.start("project-one", "项目草稿");
    const second = store.start("project-two");
    expect(second.id).not.toBe(first.id);
    expect(store.isLocal(first.id)).toBe(false);
    expect(store.select(first.id)).toBe(false);
    expect(store.getSnapshot()).toEqual({ topics: [], selected: second });
    expect(createTopic).not.toHaveBeenCalled();
  });

  it("shares one creation between rapid input and send, preserving project ownership", async () => {
    const request = deferred<TopicSummary>();
    const { store, createTopic, onSaved } = setup(() => request.promise);
    const local = store.start("project-one", "项目草稿");
    store.touch(local.id);
    store.touch(local.id);
    const sending = store.ensure(local.id);
    expect(store.ensure(local.id)).toBe(sending);
    expect(store.getSnapshot()).toEqual({ topics: [local], selected: local });
    await Promise.resolve();
    expect(createTopic).toHaveBeenCalledExactlyOnceWith("project-one");
    const saved = topic("real-project-topic", "project-one");
    request.resolve(saved);
    await expect(sending).resolves.toBe(saved);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(local.id, saved, true);
    expect(store.getSnapshot()).toEqual({ topics: [] });
    expect(store.isLocal(local.id)).toBe(false);
    expect(store.draftTopicId(saved.id)).toBe(local.id);
    expect(store.draftTopicId(local.id)).toBe(local.id);
    await expect(store.ensure(local.id)).resolves.toBe(saved);
    await expect(store.ensure(saved.id)).resolves.toBe(saved);
    expect(createTopic).toHaveBeenCalledTimes(1);
  });

  it("retains input while switched away and never steals the newer selection on save", async () => {
    const request = deferred<TopicSummary>();
    const { store, onSaved } = setup(() => request.promise);
    const first = store.start();
    store.touch(first.id);
    const flight = store.ensure(first.id);
    store.leave();
    expect(store.getSnapshot()).toEqual({ topics: [first] });
    const second = store.start("project-two");
    request.resolve(topic());
    await flight;
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(first.id, topic(), false);
    expect(store.getSnapshot()).toEqual({ topics: [], selected: second });
  });

  it("exposes the same creation flight to synchronous subscribers", async () => {
    const request = deferred<TopicSummary>();
    const { store, createTopic } = setup(() => request.promise);
    const local = store.start();
    let observed: Promise<TopicSummary> | undefined;
    store.subscribe(() => {
      if (store.isLocal(local.id)) observed = store.ensure(local.id);
    });
    const saving = store.ensure(local.id);
    expect(observed).toBe(saving);
    request.resolve(topic());
    await saving;
    expect(createTopic).toHaveBeenCalledTimes(1);
  });

  it("reports first input failure once, preserves the draft and retries only explicitly", async () => {
    const failure = new Error("offline");
    const firstRequest = deferred<TopicSummary>();
    const retryRequest = deferred<TopicSummary>();
    let calls = 0;
    const { store, createTopic, onSaved, onError } = setup(() => ++calls === 1 ? firstRequest.promise : retryRequest.promise);
    const local = store.start("project-one");
    store.touch(local.id);
    const first = store.ensure(local.id);
    firstRequest.reject(failure);
    await expect(first).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    store.touch(local.id);
    store.touch(local.id);
    expect(createTopic).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ topics: [local], selected: local });
    store.leave();
    expect(store.select(local.id)).toBe(true);
    const retry = store.ensure(local.id);
    expect(store.ensure(local.id)).toBe(retry);
    retryRequest.resolve(topic());
    await retry;
    expect(createTopic).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(local.id, topic(), true);
  });

  it("allows a failed local draft to be discarded but never orphans a saving topic", async () => {
    const request = deferred<TopicSummary>();
    const { store } = setup(() => request.promise);
    const local = store.start();
    const flight = store.ensure(local.id);
    expect(() => store.discard(local.id)).toThrow("still in progress");
    expect(store.isLocal(local.id)).toBe(true);
    request.reject(new Error("offline"));
    await expect(flight).rejects.toThrow("offline");
    store.discard(local.id);
    expect(store.getSnapshot()).toEqual({ topics: [] });
    expect(store.isLocal(local.id)).toBe(false);
    await expect(store.ensure(local.id)).rejects.toThrow("no longer available");
  });

  it("preserves stable snapshots between changes and unsubscribes listeners", () => {
    const { store } = setup();
    const listener = vi.fn();
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    const unsubscribe = store.subscribe(listener);
    const local = store.start();
    expect(listener).toHaveBeenCalledTimes(1);
    const selected = store.getSnapshot();
    expect(selected).not.toBe(initial);
    expect(store.select(local.id)).toBe(true);
    expect(store.getSnapshot()).toBe(selected);
    expect(store.draftTopicId("existing-topic")).toBe("existing-topic");
    unsubscribe();
    store.leave();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
