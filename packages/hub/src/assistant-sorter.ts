import { safeJsonForXmlTag, type AssistantQuietHours, type AssistantWatchRule } from "@kulo/protocol";
import type { StoredAssistantDigest, StoredAssistantEvent } from "./assistant-ledger.js";
import type { AssistantLedger } from "./assistant-ledger.js";
import type { AmbientModelService } from "./ambient-model-service.js";
import type { AssistantEchoSuppressor } from "./assistant-echo.js";
import {
  normalizeSorterDisposition,
  parseSorterOutput,
  SORTER_SYSTEM_PROMPT,
  type SorterParsedResult,
} from "./assistant-card-policy.js";
import { evaluateWatchRulesForEvents, formatWatchRulesForPrompt } from "./assistant-watch-rules.js";

export { parseSorterOutput, type SorterParsedResult };

export interface AssistantEscalationPayload {
  digest: StoredAssistantDigest;
  events: StoredAssistantEvent[];
  matchedRuleIds?: string[];
  deterministicRuleIds?: string[];
}

export interface AssistantSorterOptions {
  ledger: AssistantLedger;
  ambientModel: AmbientModelService;
  redact: (text: string) => string;
  onNotifyBrain: (input: AssistantEscalationPayload) => void;
  echoSuppressor?: AssistantEchoSuppressor;
  getWatchConfig?: () => Promise<{ rules: AssistantWatchRule[]; quietHours?: AssistantQuietHours }>;
  shouldSkipCloudModel?: () => Promise<boolean>;
  isCloudCapped?: () => boolean;
  coalesceWindowMs?: number;
  maxCoalesceMs?: number;
  maxCallsPerMinute?: number;
}

const DEFAULT_COALESCE_MS = 8_000;
const DEFAULT_MAX_COALESCE_MS = 25_000;
const DEFAULT_MAX_CALLS_PER_MINUTE = 20;
export const MAX_SORTER_PROMPT_EVENTS = 12;
const PROMPT_HEAD_EVENTS = 2;
const PROMPT_TAIL_EVENTS = MAX_SORTER_PROMPT_EVENTS - PROMPT_HEAD_EVENTS;

interface CoalesceBucket {
  key: string;
  events: StoredAssistantEvent[];
  firstAt: number;
  slideTimer: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout | null;
}

function resolveDigestTimestamp(sample: StoredAssistantEvent, now: number): number {
  if (sample.driverId === "lark-cli" && sample.occurredAt > 0 && sample.occurredAt <= now + 60_000) {
    return sample.occurredAt;
  }
  return now;
}

function buildEffectiveSample(events: readonly StoredAssistantEvent[]): StoredAssistantEvent {
  const sample = events[events.length - 1]!;
  if (events.length === 1) return sample;
  const anyMentionsMe = events.some((ev) => ev.messageMeta?.mentionsMe === true);
  const allBackfill = events.every((ev) => ev.messageMeta?.backfill === true);
  const allDeleted = events.every((ev) => ev.messageMeta?.deleted === true);
  if (!sample.messageMeta && !anyMentionsMe) return sample;
  return {
    ...sample,
    messageMeta: {
      ...(sample.messageMeta ?? {}),
      ...(anyMentionsMe ? { mentionsMe: true } : {}),
      backfill: allBackfill || undefined,
      deleted: allDeleted || undefined,
    },
  };
}

export class AssistantSorter {
  readonly #options: AssistantSorterOptions;
  readonly #coalesceMs: number;
  readonly #maxCoalesceMs: number;
  readonly #maxCallsPerMinute: number;
  readonly #buckets = new Map<string, CoalesceBucket>();
  readonly #controllers = new Set<AbortController>();
  readonly #callTimestamps: number[] = [];
  #serial: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: AssistantSorterOptions) {
    this.#options = options;
    this.#coalesceMs = Math.max(0, options.coalesceWindowMs ?? DEFAULT_COALESCE_MS);
    this.#maxCoalesceMs = Math.max(this.#coalesceMs, options.maxCoalesceMs ?? DEFAULT_MAX_COALESCE_MS);
    this.#maxCallsPerMinute = Math.max(1, options.maxCallsPerMinute ?? DEFAULT_MAX_CALLS_PER_MINUTE);
  }

  async recoverUndigested(sinceMs?: number): Promise<number> {
    if (this.#closed) return 0;
    const undigested = await this.#options.ledger.listUndigestedEvents({
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      limit: 100,
    });
    if (undigested.length > 0 && !this.#closed) {
      this.enqueue(undigested);
    }
    return undigested.length;
  }

  enqueue(events: readonly StoredAssistantEvent[]): void {
    if (this.#closed || events.length === 0) return;
    for (const event of events) {
      if (event.direction === "outgoing") {
        const targetTitle = event.title || event.threadHint || event.appLabel;
        const outgoingSummary = event.messageMeta?.deleted
          ? `我在「${targetTitle}」撤回了一条消息`.slice(0, 200)
          : `我在「${targetTitle}」回复：${event.body.slice(0, 120)}`.slice(0, 200);
        this.#serial = this.#serial
          .then(async () => {
            if (this.#closed) return;
            await this.#options.ledger.recordDigest(
              {
                createdAt: resolveDigestTimestamp(event, Date.now()),
                appId: event.appId,
                appLabel: event.appLabel,
                ...(event.threadHint ? { threadHint: event.threadHint } : {}),
                category: "message",
                disposition: "archive",
                urgency: "low",
                digest: outgoingSummary,
                eventIds: [event.id],
                situationKey: `${event.appId}:${event.threadHint || event.title || "self"}`.slice(0, 120),
                driverId: event.driverId,
                direction: "outgoing",
              },
              this.#options.redact,
            );
          })
          .catch(() => {});
        continue;
      }

      if (
        this.#options.echoSuppressor?.isSelfNotificationEcho({
          appId: event.appId,
          driverId: event.driverId,
          sender: event.sender,
          title: event.title,
          body: event.body,
        }) ||
        this.#options.echoSuppressor?.consumeIfEcho({
          appId: event.appId,
          driverId: event.driverId,
          sender: event.sender,
          title: event.title,
          body: event.body,
        })
      ) {
        const echoSummary = `[${event.appLabel}] ${event.title || event.sender || "回执"}（已抑制本机外发回声）`.slice(0, 200);
        this.#serial = this.#serial
          .then(async () => {
            if (this.#closed) return;
            await this.#options.ledger.recordDigest(
              {
                createdAt: Date.now(),
                appId: event.appId,
                appLabel: event.appLabel,
                ...(event.threadHint ? { threadHint: event.threadHint } : {}),
                category: "noise",
                disposition: "noise",
                urgency: "low",
                digest: echoSummary,
                eventIds: [event.id],
                situationKey: `${event.appId}:${event.threadHint || event.sender || event.title || "echo"}`.slice(0, 120),
                driverId: event.driverId,
                ...(event.direction ? { direction: event.direction } : {}),
              },
              this.#options.redact,
            );
          })
          .catch(() => {});
        continue;
      }

      const threadPart = event.messageMeta?.threadId ? `\0${event.messageMeta.threadId}` : "";
      const bucketKey = `${event.appId}\0${event.threadHint || event.sender || event.title || "default"}${threadPart}`;
      let bucket = this.#buckets.get(bucketKey);
      if (!bucket) {
        bucket = {
          key: bucketKey,
          events: [],
          firstAt: Date.now(),
          slideTimer: null,
          maxTimer: null,
        };
        this.#buckets.set(bucketKey, bucket);
        if (this.#maxCoalesceMs > 0) {
          bucket.maxTimer = setTimeout(() => this.#flushBucket(bucketKey), this.#maxCoalesceMs);
          bucket.maxTimer.unref();
        }
      }
      bucket.events.push(event);
      if (bucket.slideTimer) clearTimeout(bucket.slideTimer);
      if (this.#coalesceMs === 0) {
        this.#flushBucket(bucketKey);
      } else {
        bucket.slideTimer = setTimeout(() => this.#flushBucket(bucketKey), this.#coalesceMs);
        bucket.slideTimer.unref();
      }
    }
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.#buckets.keys()]) {
      this.#flushBucket(key);
    }
    await this.#serial.catch(() => {});
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const bucket of this.#buckets.values()) {
      if (bucket.slideTimer) clearTimeout(bucket.slideTimer);
      if (bucket.maxTimer) clearTimeout(bucket.maxTimer);
    }
    this.#buckets.clear();
    for (const controller of this.#controllers) {
      controller.abort();
    }
    this.#controllers.clear();
    await this.#serial.catch(() => {});
  }

  #flushBucket(key: string): void {
    const bucket = this.#buckets.get(key);
    if (!bucket) return;
    this.#buckets.delete(key);
    if (bucket.slideTimer) clearTimeout(bucket.slideTimer);
    if (bucket.maxTimer) clearTimeout(bucket.maxTimer);
    if (this.#closed || bucket.events.length === 0) return;

    const batch = bucket.events;
    this.#serial = this.#serial
      .then(() => this.#processBatch(batch))
      .catch(() => {
        // Errors are already bounded inside #processBatch.
      });
  }

  async #processBatch(events: StoredAssistantEvent[]): Promise<void> {
    if (this.#closed || events.length === 0) return;
    const sample = events[events.length - 1]!;
    const now = Date.now();

    let watchConfig: { rules: readonly AssistantWatchRule[]; quietHours?: AssistantQuietHours } | undefined;
    try {
      watchConfig = await this.#options.getWatchConfig?.();
    } catch {
      watchConfig = undefined;
    }
    const watchEval = evaluateWatchRulesForEvents(watchConfig?.rules, events, now);
    const deterministicRuleIds = watchEval.deterministicMatches.map((r) => r.id);
    const semanticRuleIdSet = new Set(watchEval.semanticCandidates.map((r) => r.id));

    // Sliding 1-minute rate limit to prevent notification storms from saturating model quotas.
    while (this.#callTimestamps.length > 0 && now - this.#callTimestamps[0]! >= 60_000) {
      this.#callTimestamps.shift();
    }
    const fallbackSummary = `[${sample.appLabel}] ${sample.title || sample.sender || ""}${sample.body ? `：${sample.body}` : ""}`.trim().slice(0, 200);
    const rateLimited = this.#callTimestamps.length >= this.#maxCallsPerMinute;
    const usageCapped = !rateLimited && Boolean(await this.#options.shouldSkipCloudModel?.());
    if (rateLimited || usageCapped) {
      const isHomeAssistant = sample.appId === "home-assistant";
      const forceNotify = isHomeAssistant || deterministicRuleIds.length > 0;
      const digest = await this.#options.ledger.recordDigest(
        {
          createdAt: resolveDigestTimestamp(sample, now),
          appId: sample.appId,
          appLabel: sample.appLabel,
          ...(sample.threadHint ? { threadHint: sample.threadHint } : {}),
          category: isHomeAssistant ? "security" : "general",
          disposition: forceNotify ? "notify_brain" : "archive",
          urgency: forceNotify ? "high" : "low",
          digest: fallbackSummary,
          eventIds: events.map((e) => e.id),
          situationKey: `${sample.appId}:${sample.threadHint || sample.sender || sample.title || "general"}`.slice(0, 120),
          driverId: sample.driverId,
          ...(sample.direction ? { direction: sample.direction } : {}),
        },
        this.#options.redact,
      );
      if (forceNotify) {
        this.#options.onNotifyBrain({
          digest,
          events,
          ...(deterministicRuleIds.length ? { matchedRuleIds: deterministicRuleIds, deterministicRuleIds } : {}),
        });
      }
      return;
    }
    this.#callTimestamps.push(now);

    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 18_000);
    timer.unref();

    let parsed: SorterParsedResult;
    try {
      const formatEvent = (ev: StoredAssistantEvent) => ({
        app: ev.appLabel,
        appId: ev.appId,
        sender: ev.sender ?? ev.title,
        subtitle: ev.subtitle,
        ...(ev.direction ? { direction: ev.direction } : {}),
        ...(ev.messageMeta?.mentionsMe ? { mentionsMe: true } : {}),
        ...(ev.messageMeta?.mentionsAll ? { mentionsAll: true } : {}),
        ...(ev.messageMeta?.mutedChat ? { mutedChat: true } : {}),
        body: ev.body.slice(0, 600),
        at: new Date(ev.occurredAt).toISOString(),
      });
      const payload = events.length > MAX_SORTER_PROMPT_EVENTS
        ? [
            ...events.slice(0, PROMPT_HEAD_EVENTS).map(formatEvent),
            { omittedEvents: events.length - MAX_SORTER_PROMPT_EVENTS, note: "middle burst events omitted from prompt; raw events retained in ledger" },
            ...events.slice(-PROMPT_TAIL_EVENTS).map(formatEvent),
          ]
        : events.map(formatEvent);
      const watchRulesPrompt = formatWatchRulesForPrompt(watchEval.semanticCandidates);
      const userContent = [
        ...(watchRulesPrompt ? [watchRulesPrompt] : []),
        `<untrusted_events>\n${safeJsonForXmlTag(payload)}\n</untrusted_events>`,
      ].join("\n");
      const raw = await this.#options.ambientModel.completeZeroToolJson({
        systemPrompt: SORTER_SYSTEM_PROMPT,
        userContent,
        maxTokens: 400,
        signal: controller.signal,
        allowCloudFallback: !this.#options.isCloudCapped?.(),
      });
      parsed = parseSorterOutput(
        raw,
        {
          appId: sample.appId,
          appLabel: sample.appLabel,
          sender: sample.sender,
          title: sample.title,
          body: sample.body,
        },
        semanticRuleIdSet,
      );
    } catch {
      parsed = {
        digest: fallbackSummary,
        category: "general",
        disposition: deterministicRuleIds.length > 0 ? "notify_brain" : "archive",
        urgency: deterministicRuleIds.length > 0 ? "high" : "low",
        situationKey: `${sample.appId}:${sample.threadHint || sample.sender || sample.title || "general"}`.slice(0, 120),
        title: (sample.title || sample.appLabel).slice(0, 80),
      };
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }

    if (this.#closed) return;
    const matchedRuleIds = [...new Set([...deterministicRuleIds, ...(parsed.matchedRuleIds ?? [])])];
    const effectiveSample = buildEffectiveSample(events);
    const normalized = normalizeSorterDisposition(parsed, effectiveSample, {
      hasMatchedRule: matchedRuleIds.length > 0,
    });
    const saved = await this.#options.ledger.recordDigest(
      {
        createdAt: resolveDigestTimestamp(sample, Date.now()),
        appId: sample.appId,
        appLabel: sample.appLabel,
        ...(sample.threadHint ? { threadHint: sample.threadHint } : {}),
        category: normalized.category,
        disposition: normalized.disposition,
        urgency: normalized.urgency,
        digest: normalized.digest,
        eventIds: events.map((e) => e.id),
        situationKey: normalized.situationKey,
        driverId: sample.driverId,
        ...(sample.direction ? { direction: sample.direction } : {}),
      },
      this.#options.redact,
    );

    if (saved.disposition === "notify_brain" && !this.#closed) {
      this.#options.onNotifyBrain({
        digest: saved,
        events,
        ...(matchedRuleIds.length ? { matchedRuleIds } : {}),
        ...(deterministicRuleIds.length ? { deterministicRuleIds } : {}),
      });
    }
  }
}
