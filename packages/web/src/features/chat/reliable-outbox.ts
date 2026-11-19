import type { ClientToHubMessage } from "@kulo/protocol";
import type { DraftAttachment } from "../../kulo-composer";
import { legacyInvitationCode, redactOutboxInvitation } from "./device-invitation-outbox";

export type ReliableEnvelopeInput = Extract<ClientToHubMessage, { type:
  "chat.send" | "chat.abort" | "chat.retry" | "ticket.steer" | "ticket.retry" | "ticket.stop" | "ticket.close" | "schedule.stop" | "schedule.delete"
}>;
export type ReliableEnvelope =
  | (Extract<ReliableEnvelopeInput, { type: "chat.send" | "chat.abort" | "chat.retry" }> & { requestId: string; topicId: string })
  | (Extract<ReliableEnvelopeInput, { type: "ticket.steer" | "ticket.retry" | "ticket.stop" | "ticket.close" | "schedule.stop" | "schedule.delete" }> & { commandId: string });

export interface ReliableOutboxAck {
  deduplicated?: boolean;
  topicId?: string;
  ticketId?: string;
  submissionId?: number;
  delivery?: "queued" | "accepted";
}

export interface ReliableOutboxMetadata {
  topicId?: string;
  draftKey?: string;
  rawUserText?: string;
  draftAttachments?: DraftAttachment[];
  replacesFailed?: { id: string; sequence: number; scope: string };
}

export interface ReliableOutboxRecord {
  id: string;
  scope: string;
  sequence: number;
  createdAt: number;
  envelope: ReliableEnvelope;
  metadata?: ReliableOutboxMetadata;
  state: "queued" | "sending" | "accepted" | "failed";
  attempt: number;
  nextAttemptAt: number;
  error?: string;
  errorCode?: string;
  ack?: ReliableOutboxAck;
}

export interface ReliableOutboxStorageEvent {
  scope: string;
  accepted?: { id: string; sequence: number; ack: ReliableOutboxAck };
  removed?: { id: string; sequence: number };
}

export interface ReliableOutboxStorage {
  list(scope: string): Promise<ReliableOutboxRecord[]>;
  get(scope: string, id: string): Promise<ReliableOutboxRecord | undefined>;
  lookup(scope: string, id: string): Promise<{ record?: ReliableOutboxRecord; receipt?: { sequence: number; ack: ReliableOutboxAck } }>;
  enqueue(scope: string, envelope: ReliableEnvelope, metadata: ReliableOutboxMetadata | undefined, now: number): Promise<ReliableOutboxRecord>;
  claim(scope: string, owner: string, now: number, leaseMs: number): Promise<{ record?: ReliableOutboxRecord; waitUntil?: number }>;
  renew(scope: string, owner: string, now: number, leaseMs: number): Promise<boolean>;
  accept(scope: string, id: string, ack: ReliableOutboxAck, sequence?: number): Promise<ReliableOutboxRecord | undefined>;
  fail(scope: string, id: string, owner: string, error: string, code: string | undefined, retryAt?: number, sequence?: number): Promise<void>;
  retry(scope: string, id: string, now: number): Promise<ReliableOutboxRecord>;
  release(scope: string, owner: string): Promise<void>;
  removeAccepted(scope: string, ids: readonly string[]): Promise<void>;
  remove(scope: string, id: string): Promise<void>;
  subscribe(listener: (event: ReliableOutboxStorageEvent) => void): () => void;
  close?(): void;
}

const RELIABLE_ACTIONS = new Set<ClientToHubMessage["type"]>([
  "chat.send", "chat.abort", "chat.retry", "ticket.steer", "ticket.retry", "ticket.stop", "ticket.close", "schedule.stop", "schedule.delete",
]);

export function isReliableEnvelope(message: ClientToHubMessage): message is ReliableEnvelopeInput {
  return RELIABLE_ACTIONS.has(message.type);
}

function uniqueId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function reliableEnvelopeId(message: ReliableEnvelopeInput): string {
  return (("commandId" in message ? message.commandId : undefined) ?? ("requestId" in message ? message.requestId : undefined))?.trim() ?? "";
}

export function withReliableId(message: ReliableEnvelopeInput): ReliableEnvelope {
  if (message.type.startsWith("chat.")) {
    const input = message as Extract<ReliableEnvelopeInput, { type: "chat.send" | "chat.abort" | "chat.retry" }>;
    const topicId = input.topicId?.trim();
    if (!topicId) throw new Error("待发消息必须指定所属话题");
    return { ...input, topicId, requestId: input.requestId?.trim() || `web:${uniqueId()}` };
  }
  const input = message as Extract<ReliableEnvelopeInput, { type: "ticket.steer" | "ticket.retry" | "ticket.stop" | "ticket.close" | "schedule.stop" | "schedule.delete" }>;
  if (!input.ticketId.trim()) throw new Error("待发指令必须指定所属任务");
  return { ...input, commandId: input.commandId?.trim() || `cmd:${uniqueId()}` };
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function requestFailure(record: ReliableOutboxRecord): Error {
  return Object.assign(new Error(record.error || "请求被中枢拒绝"), { code: record.errorCode });
}

function semanticFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    ["request_intent_conflict", "outbox_edit_conflict", "outbox_remove_conflict", "outbox_request_missing", legacyInvitationCode].includes(String(error.code)));
}

export interface ReliableOutboxOptions {
  storage: ReliableOutboxStorage;
  scope: string;
  transmit: (envelope: ReliableEnvelope) => Promise<ReliableOutboxAck>;
  isTransient: (error: unknown) => boolean;
  onError?: (error: Error) => void;
  now?: () => number;
  retryBaseMs?: number;
  maxRetryMs?: number;
  leaseMs?: number;
  ownerId?: string;
  ownsStorage?: boolean;
}

/** The FIFO head stays durable until its ACK is also committed. */
export class ReliableOutbox {
  readonly ready: Promise<void>;
  private readonly owner: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Map<string, Set<{ sequence: number; resolve: (ack: ReliableOutboxAck) => void; reject: (error: Error) => void }>>();
  private readonly acknowledgements = new Map<string, { sequence: number; ack: ReliableOutboxAck }>();
  private snapshot: readonly ReliableOutboxRecord[] = [];
  private storageError: Error | undefined;
  private connected = false;
  private disposed = false;
  private draining = false;
  private drainFlight: Promise<void> | undefined;
  private drainAgain = false;
  private refreshAgain = false;
  private refreshFlight: Promise<void> | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private leaseTimer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribeStorage: () => void;

  constructor(private readonly options: ReliableOutboxOptions) {
    if (!options.scope.trim()) throw new Error("待发队列缺少中枢身份");
    this.owner = options.ownerId ?? uniqueId();
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 6000;
    this.unsubscribeStorage = options.storage.subscribe((event) => {
      if (this.disposed || event.scope !== options.scope) return;
      if (event.accepted) this.resolveAcknowledgement(event.accepted.id, event.accepted.sequence, event.accepted.ack);
      if (event.removed) this.rejectWaiters(event.removed.id, new Error("待发请求已移除"), event.removed.sequence);
      void this.refresh().then(() => this.kick()).catch((error: unknown) => this.reportError(error));
    });
    this.ready = this.refresh();
    void this.ready.catch((error: unknown) => this.reportError(error));
  }

  getSnapshot = (): readonly ReliableOutboxRecord[] => this.snapshot;
  getError = (): Error | undefined => this.storageError;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  refresh = (): Promise<void> => {
    this.refreshAgain = true;
    if (this.refreshFlight) return this.refreshFlight;
    this.refreshFlight = (async () => {
      while (this.refreshAgain && !this.disposed) {
        this.refreshAgain = false;
        const rows = await this.options.storage.list(this.options.scope);
        for (const row of rows) {
          if (row.state === "accepted" && row.ack) this.resolveAcknowledgement(row.id, row.sequence, row.ack);
          else if (row.state === "failed") this.rejectWaiters(row.id, requestFailure(row), row.sequence);
        }
        if (JSON.stringify(rows) !== JSON.stringify(this.snapshot)) {
          this.snapshot = rows;
          for (const listener of this.listeners) listener();
        }
      }
    })().finally(() => { this.refreshFlight = undefined; });
    return this.refreshFlight;
  };

  async enqueue(envelope: ReliableEnvelopeInput, metadata?: ReliableOutboxMetadata): Promise<ReliableOutboxRecord> {
    this.assertActive();
    await this.ready;
    const safe = redactOutboxInvitation(withReliableId(envelope), metadata);
    const normalized = safe.envelope;
    const durableMetadata = metadata ? {
      ...safe.metadata,
      ...(metadata.draftAttachments ? { draftAttachments: metadata.draftAttachments.filter((item) => item.status === "ready" && item.attachment).map(({ previewUrl: _previewUrl, ...item }) => item) } : {}),
    } : undefined;
    let record: ReliableOutboxRecord;
    try {
      record = await this.options.storage.enqueue(this.options.scope, normalized, durableMetadata, this.now());
    } catch (error) {
      if (!semanticFailure(error)) this.reportError(error);
      throw error;
    }
    // Once committed, a failed projection must not make the caller submit a new ID.
    try {
      this.markStorageAvailable();
      if (record.state !== "accepted") this.acknowledgements.delete(record.id);
      await this.refresh();
      this.kick();
    } catch (error) {
      this.reportError(error);
    }
    return record;
  }

  async waitForAck(id: string): Promise<ReliableOutboxAck> {
    this.assertActive();
    await this.ready;
    const { record, receipt } = await this.options.storage.lookup(this.options.scope, id);
    if (!record) {
      if (receipt) { this.resolveAcknowledgement(id, receipt.sequence, receipt.ack); return receipt.ack; }
      throw new Error("待发请求不存在");
    }
    if (record.state === "accepted" && record.ack) return record.ack;
    if (record.state === "failed") throw requestFailure(record);
    const acknowledged = this.acknowledgements.get(id);
    if (acknowledged?.sequence === record.sequence) return acknowledged.ack;
    this.assertActive();
    return new Promise<ReliableOutboxAck>((resolve, reject) => {
      const listeners = this.waiters.get(id) ?? new Set();
      listeners.add({ sequence: record.sequence, resolve, reject });
      this.waiters.set(id, listeners);
    });
  }

  setConnected(connected: boolean): void {
    if (this.disposed) return;
    this.connected = connected;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (connected) { this.markStorageAvailable(); this.kick(); }
    else {
      clearInterval(this.leaseTimer);
      if (!this.draining) void this.options.storage.release(this.options.scope, this.owner).catch((error: unknown) => this.reportError(error));
    }
  }

  async retry(id: string): Promise<ReliableOutboxRecord> {
    this.assertActive();
    await this.ready;
    let record: ReliableOutboxRecord;
    try { record = await this.options.storage.retry(this.options.scope, id, this.now()); }
    catch (error) { if (!semanticFailure(error)) this.reportError(error); throw error; }
    try {
      this.markStorageAvailable();
      await this.refresh();
      this.kick();
    } catch (error) { this.reportError(error); }
    return record;
  }

  async removeAccepted(ids: readonly string[]): Promise<void> {
    this.assertActive();
    await this.ready;
    try { await this.options.storage.removeAccepted(this.options.scope, ids); }
    catch (error) { this.reportError(error); throw error; }
    try { await this.refresh(); }
    catch (error) { this.reportError(error); }
  }

  async remove(id: string): Promise<void> {
    this.assertActive();
    await this.ready;
    try { await this.options.storage.remove(this.options.scope, id); }
    catch (error) { if (!semanticFailure(error)) this.reportError(error); throw error; }
    try { await this.refresh(); }
    catch (error) { this.reportError(error); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connected = false;
    clearTimeout(this.wakeTimer);
    clearInterval(this.leaseTimer);
    this.unsubscribeStorage();
    for (const id of this.waiters.keys()) this.rejectWaiters(id, Object.assign(new Error("页面已关闭，待发消息会在重新连接后恢复"), { isDisconnect: true }));
    this.listeners.clear();
    const released = this.draining ? Promise.resolve() : this.options.storage.release(this.options.scope, this.owner)
      .catch((error: unknown) => this.options.onError?.(asError(error, "无法释放待发队列")));
    if (this.options.ownsStorage) {
      void Promise.all([released, this.drainFlight]).then(() => this.options.storage.close?.())
        .catch((error: unknown) => this.options.onError?.(asError(error, "无法关闭待发消息存储")));
    }
  }

  private assertActive(): void {
    if (this.disposed) throw Object.assign(new Error("待发队列已关闭"), { isDisconnect: true });
  }

  private resolveAcknowledgement(id: string, sequence: number, ack: ReliableOutboxAck): void {
    if ((this.acknowledgements.get(id)?.sequence ?? 0) <= sequence) this.acknowledgements.set(id, { sequence, ack });
    const listeners = this.waiters.get(id);
    if (!listeners) return;
    for (const listener of listeners) if (listener.sequence === sequence) { listeners.delete(listener); listener.resolve(ack); }
    if (!listeners.size) this.waiters.delete(id);
  }

  private rejectWaiters(id: string, error: Error, sequence?: number): void {
    const listeners = this.waiters.get(id);
    if (!listeners) return;
    for (const listener of listeners) if (sequence === undefined || listener.sequence === sequence) { listeners.delete(listener); listener.reject(error); }
    if (!listeners.size) this.waiters.delete(id);
  }

  private reportError(cause: unknown): void {
    if (this.disposed) return;
    this.storageError = asError(cause, "无法保存待发消息");
    try { this.options.onError?.(this.storageError); }
    catch (error) { console.error("无法报告待发消息存储错误", error); }
    for (const listener of this.listeners) {
      try { listener(); }
      catch (error) { console.error("无法同步待发消息状态", error); }
    }
  }

  private markStorageAvailable(): void {
    if (!this.storageError) return;
    this.storageError = undefined;
    for (const listener of this.listeners) listener();
  }

  private schedule(at: number): void {
    if (!this.connected || this.disposed) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; this.kick(); }, Math.max(1, at - this.now()));
  }

  private kick(): void {
    if (this.disposed || !this.connected || this.storageError) return;
    if (this.draining) { this.drainAgain = true; return; }
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.draining = true;
    this.drainFlight = this.drain().catch((error: unknown) => this.reportError(error)).finally(() => {
      this.draining = false;
      this.drainFlight = undefined;
      if (this.drainAgain) { this.drainAgain = false; this.kick(); }
    });
  }

  private async drain(): Promise<void> {
    await this.ready;
    while (this.connected && !this.disposed) {
      const claim = await this.options.storage.claim(this.options.scope, this.owner, this.now(), this.leaseMs);
      await this.refresh();
      if (!this.connected || this.disposed) {
        await this.options.storage.release(this.options.scope, this.owner);
        return;
      }
      if (!claim.record) {
        if (claim.waitUntil !== undefined) this.schedule(claim.waitUntil);
        return;
      }
      const record = claim.record;
      const renewTimer = setInterval(() => {
        void this.options.storage.renew(this.options.scope, this.owner, this.now(), this.leaseMs).catch((error: unknown) => this.reportError(error));
      }, Math.max(100, Math.floor(this.leaseMs / 3)));
      this.leaseTimer = renewTimer;
      try {
        let ack: ReliableOutboxAck;
        try {
          ack = await this.options.transmit(record.envelope);
        } catch (error) {
          const failure = asError(error, "发送失败");
          const code = "code" in failure && typeof failure.code === "string" ? failure.code : undefined;
          const transient = this.options.isTransient(error);
          const delay = Math.min(this.options.maxRetryMs ?? 30_000, (this.options.retryBaseMs ?? 1000) * 2 ** Math.min(record.attempt - 1, 16));
          await this.options.storage.fail(this.options.scope, record.id, this.owner, failure.message, code, transient ? this.now() + delay : undefined, record.sequence);
          this.markStorageAvailable();
          await this.refresh();
          continue;
        }
        await this.options.storage.accept(this.options.scope, record.id, ack, record.sequence);
        this.markStorageAvailable();
        await this.refresh();
      } finally {
        clearInterval(renewTimer);
        this.leaseTimer = undefined;
        await this.options.storage.release(this.options.scope, this.owner);
      }
    }
  }
}

export { createIndexedDbOutboxStorage, createMemoryOutboxStorage } from "./reliable-outbox-storage";
