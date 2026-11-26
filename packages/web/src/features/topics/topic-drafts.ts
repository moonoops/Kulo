import type { TopicSummary } from "@kulo/protocol";

export interface TopicDraftCreateOptions {
  projectId?: string;
  title?: string;
  draft?: boolean;
}

export interface TopicDraftSnapshot {
  topics: readonly TopicSummary[];
  selected?: TopicSummary;
}

export interface TopicDraftStoreOptions {
  create: (options: TopicDraftCreateOptions) => Promise<TopicSummary>;
  onSaved: (localId: string, topic: TopicSummary, wasSelected: boolean) => void;
}

interface TopicDraft {
  topic: TopicSummary;
  flight?: Promise<TopicSummary>;
}

const EMPTY_TOPICS: readonly TopicSummary[] = [];

export function deriveDraftTopicTitle(rawText: string, attachmentNames: readonly string[] = []): string | undefined {
  const stripped = rawText
    .replace(/^@ticket:[A-Za-z0-9_-]+\s*/i, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const candidate = stripped || attachmentNames.find((name) => name.trim().length > 0)?.trim();
  if (!candidate) return undefined;
  const chars = Array.from(candidate);
  return chars.length > 18 ? `${chars.slice(0, 18).join("")}…` : candidate;
}

/**
 * Only the rotating `"root"` conversation can change `conversationId` in place.
 * Non-root topics (including local drafts transitioning to their server topic) keep
 * their stable base key so initial layout, motion, and composer state never flash.
 */
export function conversationViewKey(topicId: string, baseKey: string, conversationId?: number): string {
  return topicId === "root" ? `${baseKey}:${conversationId ?? ""}` : baseKey;
}

export class TopicDraftStore {
  private readonly drafts = new Map<string, TopicDraft>();
  private readonly slots = new Map<string, string>();
  private readonly saved = new Map<string, TopicSummary>();
  private readonly aliases = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private selectedId?: string;
  private snapshot: TopicDraftSnapshot = { topics: EMPTY_TOPICS };

  constructor(private readonly options: TopicDraftStoreOptions) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): TopicDraftSnapshot => this.snapshot;

  start(projectId?: string, title = "新对话"): TopicSummary {
    const scope = projectId ?? "";
    const existingId = this.slots.get(scope);
    const existing = existingId ? this.drafts.get(existingId) : undefined;
    if (existing && !existing.flight) {
      let changed = this.selectedId !== existing.topic.id;
      if (existing.topic.title !== title) {
        existing.topic = { ...existing.topic, title };
        changed = true;
      }
      this.selectedId = existing.topic.id;
      if (changed) this.publish();
      return existing.topic;
    }

    const now = Date.now();
    const topic: TopicSummary = {
      id: `local-topic:${crypto.randomUUID()}`,
      conversationId: 0,
      title,
      createdAt: now,
      updatedAt: now,
      ...(projectId ? { projectId } : {}),
    };
    this.drafts.set(topic.id, { topic });
    this.slots.set(scope, topic.id);
    this.selectedId = topic.id;
    this.publish();
    return topic;
  }

  select(localId: string): boolean {
    if (!this.drafts.has(localId)) return false;
    if (this.selectedId === localId) return true;
    this.selectedId = localId;
    this.publish();
    return true;
  }

  leave(): void {
    if (!this.selectedId) return;
    this.selectedId = undefined;
    this.publish();
  }

  discard(localId: string): void {
    const draft = this.drafts.get(localId);
    if (!draft) return;
    if (draft.flight) throw new Error("Topic creation is still in progress");
    const scope = draft.topic.projectId ?? "";
    this.drafts.delete(localId);
    if (this.slots.get(scope) === localId) this.slots.delete(scope);
    if (this.selectedId === localId) this.selectedId = undefined;
    this.publish();
  }

  pruneMissingProjects(validProjectIds: ReadonlySet<string>): boolean {
    let deselectedActive = false;
    let changed = false;
    for (const [localId, draft] of this.drafts) {
      const projectId = draft.topic.projectId;
      if (!projectId || validProjectIds.has(projectId) || draft.flight) continue;
      this.drafts.delete(localId);
      if (this.slots.get(projectId) === localId) this.slots.delete(projectId);
      if (this.selectedId === localId) {
        this.selectedId = undefined;
        deselectedActive = true;
      }
      changed = true;
    }
    if (changed) this.publish();
    return deselectedActive;
  }

  isLocal(id: string): boolean {
    return this.drafts.has(id);
  }

  ensure(id: string, createOptions?: { title?: string; draft?: boolean }): Promise<TopicSummary> {
    const localId = this.draftTopicId(id);
    const saved = this.saved.get(localId);
    if (saved) return Promise.resolve(saved);
    const draft = this.drafts.get(localId);
    if (!draft) return Promise.reject(new Error("Topic draft is no longer available"));
    if (draft.flight) return draft.flight;
    const scope = draft.topic.projectId ?? "";
    const flight = Promise.resolve()
      .then(() =>
        this.options.create({
          ...(draft.topic.projectId ? { projectId: draft.topic.projectId } : {}),
          ...(createOptions?.title ? { title: createOptions.title } : {}),
          ...(createOptions?.draft !== undefined ? { draft: createOptions.draft } : {}),
        }),
      )
      .then(
        (topic) => {
          const wasSelected = this.selectedId === localId;
          this.drafts.delete(localId);
          if (this.slots.get(scope) === localId) this.slots.delete(scope);
          this.saved.set(localId, topic);
          this.aliases.set(topic.id, localId);
          if (wasSelected) this.selectedId = undefined;
          try {
            this.options.onSaved(localId, topic, wasSelected);
          } finally {
            this.publish();
          }
          return topic;
        },
        (error: unknown) => {
          draft.flight = undefined;
          throw error;
        },
      );
    draft.flight = flight;
    return flight;
  }

  draftTopicId(realOrLocalId: string): string {
    return this.aliases.get(realOrLocalId) ?? realOrLocalId;
  }

  private publish(): void {
    const selected = this.selectedId ? this.drafts.get(this.selectedId)?.topic : undefined;
    if (this.snapshot.selected === selected && this.snapshot.topics === EMPTY_TOPICS) return;
    this.snapshot = selected ? { topics: EMPTY_TOPICS, selected } : { topics: EMPTY_TOPICS };
    for (const listener of this.listeners) listener();
  }
}
