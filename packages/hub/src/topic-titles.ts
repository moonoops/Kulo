import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { AssistantEntry, type ConversationId, type Extension, type Harness } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { BuiltinThinkingEffort, ChatDisplayItem, TopicSummary } from "@kulo/protocol";
import { TITLE_INSTRUCTIONS } from "./prompts.js";
import { KuloStateDoc, listSortedTopics, type KuloDurableState, type TopicTitleJob } from "./state.js";

export { TITLE_INSTRUCTIONS };

export function createTopicTitleJob(userText: string, attachmentNames: string[], fallbackTitle: string): TopicTitleJob | undefined {
  const text = userText.trim();
  const hasSubject = /\p{L}/u.test(text) && Array.from(text).length >= 3 &&
    !/^(?:你好|您好|嗨|哈{1,4}|在吗|测试|hello|hi|hey)[\s\p{P}\p{S}]*$/iu.test(text);
  if (!hasSubject && !attachmentNames.length) return undefined;
  return { status: "pending", fallbackTitle, userText: text.slice(0, 4000), attachmentNames: attachmentNames.slice(0, 20).map((name) => name.slice(0, 240)) };
}

export function parseTopicTitle(raw: string): string | null {
  const result: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  if (!result || typeof result !== "object" || !("title" in result)) throw new Error("Invalid title response");
  if (result.title === null) return null;
  if (typeof result.title !== "string") throw new Error("Invalid title response");
  const title = result.title.trim();
  if (!title || Array.from(title).length > 48 || /[\r\n\u0000-\u001f\u007f]/.test(title)) throw new Error("Invalid title response");
  return title;
}

type TitleFailure = NonNullable<TopicTitleJob["failure"]>;

class TitleGenerationError extends Error {
  constructor(readonly failure: TitleFailure) { super(failure.message); }
}

/** Provider responses can contain credentials or request bodies; persist only known diagnostic categories. */
export function titleGenerationFailure(error: unknown): TitleFailure {
  if (error instanceof TitleGenerationError) return error.failure;
  if (error instanceof SyntaxError || error instanceof Error && error.message === "Invalid title response") {
    return { code: "invalid_response", message: "Title response was not valid bounded JSON." };
  }
  return { code: "generation_error", message: "Title generation did not complete." };
}

export function completedTopicTitle(status: string, message: AssistantMessage | undefined): string | null {
  if (message?.stopReason === "error") {
    const thinking = /thinking (?:budget|level)|thinkingBudget|thinkingLevel/i.test(message.errorMessage ?? "");
    throw new TitleGenerationError(thinking
      ? { code: "thinking_configuration", message: "Provider rejected the model thinking configuration." }
      : { code: "provider_error", message: "Provider rejected the title request." });
  }
  if (status !== "done" || message?.stopReason !== "stop") throw new Error("Title generation did not complete");
  return parseTopicTitle(message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
}

/** A restart gets one fresh attempt, including for jobs saved before failure diagnostics existed. */
export function retryFailedTopicTitle(job: Pick<TopicTitleJob, "retryCount" | "failure" | "conversationId"> & { status: string }): void {
  if (job.status !== "failed" || (job.retryCount ?? 0) >= 1 || job.failure?.code === "invalid_response") return;
  job.status = "pending";
  job.retryCount = (job.retryCount ?? 0) + 1;
  delete job.conversationId;
  delete job.failure;
}

function eligible(state: Readonly<KuloDurableState> | undefined, topicId: string): boolean {
  const topic = state?.topics?.[topicId];
  const job = state?.topicTitles?.[topicId];
  return Boolean(topic && !topic.deletedAt && !topic.master && job?.status === "pending" && topic.title === job.fallbackTitle);
}

interface TopicTitleHost {
  harness: Harness;
  agent: () => { model: { provider: string; modelId: string }; thinkingLevel: BuiltinThinkingEffort };
  publish: (topics: TopicSummary[]) => void;
  extensions?: () => Extension[];
  redact?: (text: string) => string;
}

export class KuloTopicTitles {
  readonly #host: TopicTitleHost;
  readonly #pending = new Set<string>();
  readonly #active = new Map<string, Promise<void>>();
  readonly #lifetime = withCancel(BACKGROUND_CONTEXT);
  #closed = false;

  constructor(host: TopicTitleHost) { this.#host = host; }

  async start(): Promise<string[]> {
    await this.#host.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      for (const [id, job] of Object.entries(state.topicTitles ?? {})) {
        const topic = state.topics?.[id];
        if (topic && !topic.deletedAt && !topic.master && topic.title === job.fallbackTitle) retryFailedTopicTitle(job);
      }
    }, this.#lifetime.context);
    const state = await this.#host.harness.snapshot(KuloStateDoc, this.#lifetime.context);
    const pending = Object.keys(state?.topicTitles ?? {}).filter((id) => eligible(state, id));
    for (const id of pending) {
      this.track(id);
      if (state?.topicTitles?.[id]?.assistantText !== undefined) this.#queue(id);
    }
    return pending.filter((id) => state?.topicTitles?.[id]?.assistantText === undefined);
  }

  track(topicId: string): void { this.#pending.add(topicId); }

  observe(topicId: string, messages: readonly ChatDisplayItem[], busy: boolean): void {
    if (this.#closed || busy || !this.#pending.has(topicId)) return;
    const reply = messages.find((message) => message.role === "assistant" && message.text.trim());
    if (reply) this.#queue(topicId, reply.text);
  }

  #queue(topicId: string, reply?: string): void {
    if (this.#closed || this.#active.has(topicId)) return;
    const run = this.#generate(topicId, reply).catch(async (error: unknown) => {
      if (this.#closed) return;
      const failure = titleGenerationFailure(error);
      await this.#finish(topicId, "failed", undefined, failure);
      console.warn("[KuloTopicTitle]", topicId, failure.code, failure.message);
    }).catch((error: unknown) => {
      if (!this.#closed) console.error("[KuloTopicTitle] Could not persist generation outcome", topicId, error instanceof Error ? error.name : "error");
    }).finally(() => this.#active.delete(topicId));
    this.#active.set(topicId, run);
  }

  async #generate(topicId: string, reply?: string): Promise<void> {
    const { harness, agent } = this.#host;
    const context = this.#lifetime.context;
    const job = await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      if (!eligible(state, topicId)) return undefined;
      const current = state.topicTitles![topicId]!;
      if (current.assistantText === undefined) {
        if (reply === undefined) return undefined;
        current.assistantText = reply.slice(0, 4000);
      }
      return JSON.parse(JSON.stringify(current)) as TopicTitleJob;
    }, context);
    if (!job) { this.#pending.delete(topicId); return; }

    let conversation = job.conversationId === undefined ? undefined : await harness.conversation(job.conversationId as ConversationId, context);
    if (!conversation) {
      const selection = agent();
      conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
        model: selection.model, thinkingLevel: selection.thinkingLevel, extensions: this.#host.extensions?.() ?? [], tools: [], modelTools: [], maxTurns: 1,
        instructions: TITLE_INSTRUCTIONS,
      } }, context);
      const id = Number(conversation.id);
      const claimed = await harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        if (!eligible(state, topicId)) return false;
        state.topicTitles![topicId]!.conversationId = id;
        return true;
      }, context);
      if (!claimed) { this.#pending.delete(topicId); return; }
    }

    // Recovery reuses the admitted submission instead of appending another title request.
    const submission = await conversation.submit({ type: "input", whenBusy: "reject", requestId: `kulo:topic-title:${topicId}`,
      content: JSON.stringify({ user: job.userText, attachments: job.attachmentNames, assistant: job.assistantText }) }, context);
    const settled = await submission.wait(context);
    const page = await conversation.entries({}, 8, undefined, context);
    const entry = page.items.find(AssistantEntry.is);
    if (!entry || !AssistantEntry.is(entry)) throw new Error("Title generation returned no response");
    const message = entry.model?.[0];
    await this.#finish(topicId, "done", completedTopicTitle(settled.status, message?.role === "assistant" ? message : undefined));
  }

  async #finish(topicId: string, status: "done" | "failed", title?: string | null, failure?: TitleFailure): Promise<void> {
    const topics = await this.#host.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const job = state.topicTitles?.[topicId];
      if (!job || job.status !== "pending") return undefined;
      if (!eligible(state, topicId)) { job.status = "cancelled"; return undefined; }
      job.status = status;
      if (failure) job.failure = failure;
      const safeTitle = title ? (this.#host.redact ? this.#host.redact(title).trim() : title) : undefined;
      if (!safeTitle) return undefined;
      state.topics![topicId]!.title = safeTitle;
      // A metadata update must not move an old conversation above newer user activity.
      return listSortedTopics(state);
    }, this.#lifetime.context);
    this.#pending.delete(topicId);
    if (topics) this.#host.publish(topics);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#lifetime.cancel();
    await Promise.allSettled(this.#active.values());
    this.#pending.clear();
  }
}
