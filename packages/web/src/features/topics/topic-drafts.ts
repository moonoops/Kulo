import type { TopicSummary } from "@kulo/protocol";

export interface TopicDraftSnapshot {
  topics: readonly TopicSummary[];
  selected?: TopicSummary;
}

export interface TopicDraftStoreOptions {
  create: (projectId?: string) => Promise<TopicSummary>;
  onSaved: (localId: string, topic: TopicSummary, wasSelected: boolean) => void;
  onError: (error: unknown) => void;
}

interface TopicDraft {
  topic: TopicSummary;
  touched: boolean;
  flight?: Promise<TopicSummary>;
}

export class TopicDraftStore {
  private readonly drafts = new Map<string, TopicDraft>();
  private readonly saved = new Map<string, TopicSummary>();
  private readonly aliases = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private selectedId?: string;
  private snapshot: TopicDraftSnapshot = { topics: [] };

  constructor(private readonly options: TopicDraftStoreOptions) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): TopicDraftSnapshot => this.snapshot;

  start(projectId?: string, title = "新对话"): TopicSummary {
    this.deselect();
    const now = Date.now();
    const topic: TopicSummary = {
      id: `local-topic:${crypto.randomUUID()}`,
      conversationId: 0,
      title,
      createdAt: now,
      updatedAt: now,
      ...(projectId ? { projectId } : {}),
    };
    this.drafts.set(topic.id, { topic, touched: false });
    this.selectedId = topic.id;
    this.publish();
    return topic;
  }

  select(localId: string): boolean {
    if (!this.drafts.has(localId)) return false;
    if (this.selectedId === localId) return true;
    this.deselect();
    this.selectedId = localId;
    this.publish();
    return true;
  }

  leave(): void {
    if (!this.selectedId) return;
    this.deselect();
    this.publish();
  }

  discard(localId: string): void {
    const draft = this.drafts.get(localId);
    if (!draft) return;
    if (draft.flight) throw new Error("Topic creation is still in progress");
    this.drafts.delete(localId);
    if (this.selectedId === localId) this.selectedId = undefined;
    this.publish();
  }

  isLocal(id: string): boolean {
    return this.drafts.has(id);
  }

  touch(localId: string): void {
    const draft = this.drafts.get(localId);
    if (!draft || draft.touched) return;
    // Further keystrokes must not retry a failed request or report it repeatedly.
    void this.ensure(localId).catch(this.options.onError);
  }

  ensure(id: string): Promise<TopicSummary> {
    const localId = this.draftTopicId(id);
    const saved = this.saved.get(localId);
    if (saved) return Promise.resolve(saved);
    const draft = this.drafts.get(localId);
    if (!draft) return Promise.reject(new Error("Topic draft is no longer available"));
    if (draft.flight) return draft.flight;
    const newlyTouched = !draft.touched;
    draft.touched = true;
    const flight = Promise.resolve().then(() => this.options.create(draft.topic.projectId ?? undefined)).then(
      (topic) => {
        const wasSelected = this.selectedId === localId;
        this.drafts.delete(localId);
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
    if (newlyTouched) this.publish();
    return flight;
  }

  draftTopicId(realOrLocalId: string): string {
    return this.aliases.get(realOrLocalId) ?? realOrLocalId;
  }

  private deselect(): void {
    if (this.selectedId && !this.drafts.get(this.selectedId)?.touched) this.drafts.delete(this.selectedId);
    this.selectedId = undefined;
  }

  private publish(): void {
    this.snapshot = {
      topics: [...this.drafts.values()].filter((draft) => draft.touched).map((draft) => draft.topic),
      ...(this.selectedId ? { selected: this.drafts.get(this.selectedId)?.topic } : {}),
    };
    for (const listener of this.listeners) listener();
  }
}
