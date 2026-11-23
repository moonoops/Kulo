import { safeJsonForXmlTag } from "@kulo/protocol";
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

export { parseSorterOutput, type SorterParsedResult };

export interface AssistantSorterOptions {
  ledger: AssistantLedger;
  ambientModel: AmbientModelService;
  redact: (text: string) => string;
  onNotifyBrain: (input: { digest: StoredAssistantDigest; events: StoredAssistantEvent[] }) => void;
  echoSuppressor?: AssistantEchoSuppressor;
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

  enqueue(events: readonly StoredAssistantEvent[]): void {
    if (this.#closed || events.length === 0) return;
    for (const event of events) {
      if (
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
              },
              this.#options.redact,
            );
          })
          .catch(() => {});
        continue;
      }

      const bucketKey = `${event.appId}\0${event.threadHint || event.sender || event.title || "default"}`;
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

    // Sliding 1-minute rate limit to prevent notification storms from saturating model quotas.
    while (this.#callTimestamps.length > 0 && now - this.#callTimestamps[0]! >= 60_000) {
      this.#callTimestamps.shift();
    }
    const fallbackSummary = `[${sample.appLabel}] ${sample.title || sample.sender || ""}${sample.body ? `：${sample.body}` : ""}`.trim().slice(0, 200);
    const rateLimited = this.#callTimestamps.length >= this.#maxCallsPerMinute;
    const usageCapped = !rateLimited && Boolean(await this.#options.shouldSkipCloudModel?.());
    if (rateLimited || usageCapped) {
      const isHomeAssistant = sample.appId === "home-assistant";
      const digest = await this.#options.ledger.recordDigest(
        {
          createdAt: now,
          appId: sample.appId,
          appLabel: sample.appLabel,
          ...(sample.threadHint ? { threadHint: sample.threadHint } : {}),
          category: isHomeAssistant ? "security" : "general",
          disposition: isHomeAssistant ? "notify_brain" : "archive",
          urgency: isHomeAssistant ? "high" : "low",
          digest: fallbackSummary,
          eventIds: events.map((e) => e.id),
          situationKey: `${sample.appId}:${sample.threadHint || sample.sender || sample.title || "general"}`.slice(0, 120),
        },
        this.#options.redact,
      );
      if (isHomeAssistant) {
        this.#options.onNotifyBrain({ digest, events });
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
      const raw = await this.#options.ambientModel.completeZeroToolJson({
        systemPrompt: SORTER_SYSTEM_PROMPT,
        userContent: `<untrusted_events>\n${safeJsonForXmlTag(payload)}\n</untrusted_events>`,
        maxTokens: 400,
        signal: controller.signal,
        allowCloudFallback: !this.#options.isCloudCapped?.(),
      });
      parsed = parseSorterOutput(raw, {
        appId: sample.appId,
        appLabel: sample.appLabel,
        sender: sample.sender,
        title: sample.title,
        body: sample.body,
      });
    } catch {
      parsed = {
        digest: fallbackSummary,
        category: "general",
        disposition: "archive",
        urgency: "low",
        situationKey: `${sample.appId}:${sample.threadHint || sample.sender || sample.title || "general"}`.slice(0, 120),
        title: (sample.title || sample.appLabel).slice(0, 80),
      };
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }

    if (this.#closed) return;
    const normalized = normalizeSorterDisposition(parsed, sample);
    const saved = await this.#options.ledger.recordDigest(
      {
        createdAt: Date.now(),
        appId: sample.appId,
        appLabel: sample.appLabel,
        ...(sample.threadHint ? { threadHint: sample.threadHint } : {}),
        category: normalized.category,
        disposition: normalized.disposition,
        urgency: normalized.urgency,
        digest: normalized.digest,
        eventIds: events.map((e) => e.id),
        situationKey: normalized.situationKey,
      },
      this.#options.redact,
    );

    if (saved.disposition === "notify_brain" && !this.#closed) {
      this.#options.onNotifyBrain({ digest: saved, events });
    }
  }
}
