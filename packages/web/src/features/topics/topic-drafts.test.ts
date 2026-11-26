import type { TopicSummary } from "@kulo/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  TopicDraftStore,
  conversationViewKey,
  deriveDraftTopicTitle,
  type TopicDraftCreateOptions,
} from "./topic-drafts";

function topic(id = "saved-topic", projectId?: string, title = "新对话"): TopicSummary {
  return { id, conversationId: 1, title, createdAt: 1, updatedAt: 1, ...(projectId ? { projectId } : {}) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function setup(create: (options: TopicDraftCreateOptions) => Promise<TopicSummary> = async (options) => topic("saved-topic", options.projectId, options.title ?? "新对话")) {
  const onSaved = vi.fn();
  const createTopic = vi.fn(create);
  const store = new TopicDraftStore({ create: createTopic, onSaved });
  return { store, createTopic, onSaved };
}

describe("local topic drafts", () => {
  it("opens an unlisted draft, leaves without creating any server record, and restores the same draft on next start", () => {
    const { store, createTopic, onSaved } = setup();
    const first = store.start();
    expect(first.id).toMatch(/^local-topic:/);
    expect(store.getSnapshot()).toEqual({ topics: [], selected: first });
    expect(store.isLocal(first.id)).toBe(true);

    store.leave();
    expect(store.getSnapshot()).toEqual({ topics: [] });
    expect(store.isLocal(first.id)).toBe(true);
    expect(createTopic).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    const reopened = store.start(undefined, "New conversation");
    expect(reopened.id).toBe(first.id);
    expect(reopened.title).toBe("New conversation");
    expect(store.getSnapshot()).toEqual({ topics: [], selected: reopened });
    expect(createTopic).not.toHaveBeenCalled();
  });

  it("isolates unsent draft slots across ordinary topics and individual projects", () => {
    const { store, createTopic } = setup();
    const general = store.start();
    const projectOne = store.start("project-one", "项目草稿");
    const projectTwo = store.start("project-two");
    expect(projectOne.id).not.toBe(general.id);
    expect(projectTwo.id).not.toBe(projectOne.id);
    expect(store.getSnapshot()).toEqual({ topics: [], selected: projectTwo });

    expect(store.start().id).toBe(general.id);
    expect(store.start("project-one").id).toBe(projectOne.id);
    expect(store.start("project-two").id).toBe(projectTwo.id);
    expect(store.getSnapshot().topics).toEqual([]);
    expect(createTopic).not.toHaveBeenCalled();
  });

  it("creates only on explicit send, deduplicates calls, forwards title/draft/project, and starts fresh afterward", async () => {
    const request = deferred<TopicSummary>();
    const { store, createTopic, onSaved } = setup(() => request.promise);
    const local = store.start("project-one", "新对话");
    const sending = store.ensure(local.id, { title: "排查连接问题", draft: true });
    expect(store.ensure(local.id)).toBe(sending);
    // Still unlisted until the server confirms creation.
    expect(store.getSnapshot()).toEqual({ topics: [], selected: local });
    await Promise.resolve();
    expect(createTopic).toHaveBeenCalledExactlyOnceWith({ projectId: "project-one", title: "排查连接问题", draft: true });

    const saved = topic("real-project-topic", "project-one", "排查连接问题");
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

    // After sending, opening a new topic in the same scope starts a fresh draft ID.
    const next = store.start("project-one");
    expect(next.id).not.toBe(local.id);
    expect(store.getSnapshot()).toEqual({ topics: [], selected: next });
  });

  it("opens a fresh draft if the user leaves an in-flight send and never steals focus when the earlier save finishes", async () => {
    const request = deferred<TopicSummary>();
    const { store, onSaved } = setup(() => request.promise);
    const first = store.start();
    const flight = store.ensure(first.id, { title: "第一条消息", draft: true });
    store.leave();
    const second = store.start();
    expect(second.id).not.toBe(first.id);
    const saved = topic("saved-first", undefined, "第一条消息");
    request.resolve(saved);
    await flight;
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(first.id, saved, false);
    expect(store.getSnapshot()).toEqual({ topics: [], selected: second });
    // Earlier slot cleanup must not clear the newer draft's slot.
    store.leave();
    expect(store.start().id).toBe(second.id);
  });

  it("preserves the unsent draft in its slot when creation fails so retry and reopen keep the content", async () => {
    const failure = new Error("offline");
    const firstRequest = deferred<TopicSummary>();
    const retryRequest = deferred<TopicSummary>();
    let calls = 0;
    const { store, createTopic, onSaved } = setup(() => (++calls === 1 ? firstRequest.promise : retryRequest.promise));
    const local = store.start("project-one");
    const first = store.ensure(local.id, { title: "重试测试", draft: true });
    firstRequest.reject(failure);
    await expect(first).rejects.toBe(failure);
    expect(store.getSnapshot()).toEqual({ topics: [], selected: local });

    store.leave();
    expect(store.start("project-one").id).toBe(local.id);
    const retry = store.ensure(local.id, { title: "重试测试", draft: true });
    expect(store.ensure(local.id)).toBe(retry);
    const saved = topic("saved-retry", "project-one", "重试测试");
    retryRequest.resolve(saved);
    await retry;
    expect(createTopic).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(local.id, saved, true);
  });

  it("allows an idle draft to be discarded and prunes drafts for deleted projects without touching in-flight creations", async () => {
    const request = deferred<TopicSummary>();
    const { store } = setup(() => request.promise);
    const idle = store.start("project-deleted");
    const general = store.start();
    expect(store.pruneMissingProjects(new Set(["project-alive"]))).toBe(false);
    expect(store.isLocal(idle.id)).toBe(false);
    expect(store.isLocal(general.id)).toBe(true);

    const activeDeleted = store.start("project-gone");
    expect(store.pruneMissingProjects(new Set(["project-alive"]))).toBe(true);
    expect(store.isLocal(activeDeleted.id)).toBe(false);
    expect(store.getSnapshot()).toEqual({ topics: [] });

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

  it("preserves stable snapshots between no-op changes and unsubscribes listeners", () => {
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
    expect(store.start().id).toBe(local.id);
    expect(store.getSnapshot()).toBe(selected);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.draftTopicId("existing-topic")).toBe("existing-topic");
    unsubscribe();
    store.leave();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("draft title and conversation view keys", () => {
  it("derives concise immediate titles from first user message or attachment names", () => {
    expect(deriveDraftTopicTitle("   \n  ")).toBeUndefined();
    expect(deriveDraftTopicTitle("@ticket:t-1  帮我排查一下登录报错\n第二行")).toBe("帮我排查一下登录报错");
    expect(deriveDraftTopicTitle("12345678901234567890")).toBe("123456789012345678…");
    expect(deriveDraftTopicTitle("", ["architecture-diagram.png"])).toBe("architecture-diagr…");
  });

  it("includes conversationId only for rotating root conversations so local drafts never flash on creation", () => {
    expect(conversationViewKey("root", "topic:root", 1)).toBe("topic:root:1");
    expect(conversationViewKey("root", "topic:root", 5)).toBe("topic:root:5");
    expect(conversationViewKey("local-topic:abc", "topic:local-topic:abc", undefined)).toBe("topic:local-topic:abc");
    expect(conversationViewKey("local-topic:abc", "topic:local-topic:abc", 0)).toBe("topic:local-topic:abc");
    expect(conversationViewKey("topic-42", "topic:local-topic:abc", 42)).toBe("topic:local-topic:abc");
  });
});
