import type {
  ReliableEnvelope, ReliableOutboxAck, ReliableOutboxMetadata, ReliableOutboxRecord,
  ReliableOutboxStorage, ReliableOutboxStorageEvent,
} from "./reliable-outbox";
import { legacyInvitationCode, migrateOutboxInvitation } from "./device-invitation-outbox";

type Lease = { scope: string; owner: string; expiresAt: number };
type Receipt = { scope: string; id: string; sequence: number; ack: ReliableOutboxAck };
type Claim = { record?: ReliableOutboxRecord; waitUntil?: number };
const copy = <T>(value: T): T => structuredClone(value);
const idOf = (envelope: ReliableEnvelope): string => "commandId" in envelope ? envelope.commandId : envelope.requestId;

function notify(listeners: Set<(event: ReliableOutboxStorageEvent) => void>, event: ReliableOutboxStorageEvent): void {
  for (const listener of listeners) {
    try { listener(copy(event)); }
    catch (error) { console.error("待发消息已保存，但状态通知失败", error); }
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function existingRecord(current: ReliableOutboxRecord, envelope: ReliableEnvelope): ReliableOutboxRecord {
  if (canonical(current.envelope) !== canonical(envelope)) {
    throw Object.assign(new Error("同一消息标识不能用于不同内容"), { code: "request_intent_conflict" });
  }
  return copy(current);
}

function newRecord(scope: string, envelope: ReliableEnvelope, metadata: ReliableOutboxMetadata | undefined, now: number): Omit<ReliableOutboxRecord, "sequence"> {
  const { replacesFailed: _replacesFailed, ...durableMetadata } = metadata ?? {};
  return { id: idOf(envelope), scope, envelope: copy(envelope), ...(metadata ? { metadata: copy(durableMetadata) } : {}),
    createdAt: now, state: "queued", attempt: 0, nextAttemptAt: now };
}

function editConflict(): Error {
  return Object.assign(new Error("原消息已变更，请重新选择需要编辑的失败消息"), { code: "outbox_edit_conflict" });
}

function validateReplacement(scope: string, envelope: ReliableEnvelope, replacement: NonNullable<ReliableOutboxMetadata["replacesFailed"]>, current: ReliableOutboxRecord | undefined): ReliableOutboxRecord {
  if (replacement.scope !== scope || replacement.id === idOf(envelope) || !Number.isSafeInteger(replacement.sequence) || replacement.sequence <= 0 ||
      !current || current.scope !== scope || current.id !== replacement.id || current.sequence !== replacement.sequence || current.state !== "failed") throw editConflict();
  return current;
}

function selectClaim(rows: ReliableOutboxRecord[], lease: Lease | undefined, scope: string, owner: string, now: number, leaseMs: number): { claim: Claim; lease?: Lease } {
  const head = rows.sort((a, b) => a.sequence - b.sequence).find((record) => record.state === "queued" || record.state === "sending");
  if (!head) return { claim: {} };
  const occupiedUntil = lease && lease.owner !== owner ? lease.expiresAt : 0;
  const eligibleAt = Math.max(head.nextAttemptAt, occupiedUntil);
  if (eligibleAt > now) return { claim: { waitUntil: eligibleAt } };
  return { claim: { record: { ...head, state: "sending", attempt: head.attempt + 1, nextAttemptAt: now, error: undefined, errorCode: undefined } },
    lease: { scope, owner, expiresAt: now + leaseMs } };
}

/** Shared across controllers so tests exercise the same lease and FIFO contract as IndexedDB. */
export function createMemoryOutboxStorage(): ReliableOutboxStorage {
  let sequence = 0;
  const records = new Map<number, ReliableOutboxRecord>();
  const receipts = new Map<string, Receipt>();
  const receiptKey = (scope: string, id: string) => JSON.stringify([scope, id]);
  const leases = new Map<string, Lease>();
  const listeners = new Set<(event: ReliableOutboxStorageEvent) => void>();
  const find = (scope: string, id: string) => [...records.values()].find((record) => record.scope === scope && record.id === id);
  const emit = (event: ReliableOutboxStorageEvent) => notify(listeners, event);
  return {
    async list(scope) { return copy([...records.values()].filter((record) => record.scope === scope).sort((a, b) => a.sequence - b.sequence)); },
    async get(scope, id) { const record = find(scope, id); return record ? copy(record) : undefined; },
    async lookup(scope, id) {
      const record = find(scope, id); const receipt = receipts.get(receiptKey(scope, id));
      return copy({ ...(record ? { record } : {}), ...(receipt ? { receipt } : {}) });
    },
    async enqueue(scope, envelope, metadata, now) {
      const existing = find(scope, idOf(envelope));
      const replacement = metadata?.replacesFailed;
      const replaced = replacement ? validateReplacement(scope, envelope, replacement, find(scope, replacement.id)) : undefined;
      if (existing) {
        if (replacement) throw editConflict();
        return existingRecord(existing, envelope);
      }
      const record = { ...newRecord(scope, envelope, metadata, now), sequence: ++sequence };
      records.set(record.sequence, record);
      if (replaced) records.delete(replaced.sequence);
      emit({ scope, ...(replaced ? { removed: { id: replaced.id, sequence: replaced.sequence } } : {}) }); return copy(record);
    },
    async claim(scope, owner, now, leaseMs) {
      const selected = selectClaim([...records.values()].filter((record) => record.scope === scope), leases.get(scope), scope, owner, now, leaseMs);
      if (selected.claim.record && selected.lease) {
        records.set(selected.claim.record.sequence, selected.claim.record); leases.set(scope, selected.lease); emit({ scope });
      }
      return copy(selected.claim);
    },
    async renew(scope, owner, now, leaseMs) {
      const lease = leases.get(scope);
      if (!lease || lease.owner !== owner) return false;
      leases.set(scope, { scope, owner, expiresAt: now + leaseMs }); return true;
    },
    async accept(scope, id, ack, sequence) {
      const record = find(scope, id);
      const sourceSequence = sequence ?? record?.sequence;
      if (sourceSequence === undefined) return undefined;
      const savedAck = record?.sequence === sourceSequence && record.state === "accepted" && record.ack ? record.ack : ack;
      if ((receipts.get(receiptKey(scope, id))?.sequence ?? 0) <= sourceSequence) receipts.set(receiptKey(scope, id), { scope, id, sequence: sourceSequence, ack: copy(savedAck) });
      if (!record || record.sequence !== sourceSequence || record.state === "accepted") {
        emit({ scope, accepted: { id, sequence: sourceSequence, ack: savedAck } });
        return record ? copy(record) : undefined;
      }
      const accepted: ReliableOutboxRecord = { ...record, state: "accepted", ack: copy(ack), error: undefined, errorCode: undefined };
      records.set(record.sequence, accepted); emit({ scope, accepted: { id, sequence: sourceSequence, ack } }); return copy(accepted);
    },
    async fail(scope, id, owner, error, code, retryAt, sequence) {
      const record = find(scope, id);
      if (!record || record.state === "accepted" || sequence !== undefined && record.sequence !== sequence || leases.get(scope)?.owner !== owner) return;
      records.set(record.sequence, { ...record, state: retryAt === undefined ? "failed" : "queued", error, errorCode: code, nextAttemptAt: retryAt ?? 0 });
      emit({ scope });
    },
    async retry(scope, id, now) {
      const record = find(scope, id);
      if (!record) throw Object.assign(new Error("待发请求不存在"), { code: "outbox_request_missing" });
      if (record.errorCode === legacyInvitationCode) throw Object.assign(new Error(record.error), { code: legacyInvitationCode });
      if (record.state === "accepted" || record.state === "sending") return copy(record);
      const next: ReliableOutboxRecord = { ...record, state: "queued", nextAttemptAt: now, error: undefined, errorCode: undefined };
      records.set(record.sequence, next); emit({ scope }); return copy(next);
    },
    async release(scope, owner) {
      if (leases.get(scope)?.owner !== owner) return;
      leases.delete(scope); emit({ scope });
    },
    async removeAccepted(scope, ids) {
      const wanted = new Set(ids);
      for (const [key, record] of records) if (record.scope === scope && record.state === "accepted" && wanted.has(record.id)) records.delete(key);
      emit({ scope });
    },
    async remove(scope, id) {
      const record = find(scope, id);
      if (!record) return;
      if (record.state !== "failed") throw Object.assign(new Error("只能移除发送失败的请求"), { code: "outbox_remove_conflict" });
      records.delete(record.sequence); emit({ scope, removed: { id, sequence: record.sequence } });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export interface IndexedDbOutboxStorageOptions { databaseName?: string; indexedDB?: IDBFactory }

export function createIndexedDbOutboxStorage(options: IndexedDbOutboxStorageOptions = {}): ReliableOutboxStorage {
  const name = options.databaseName ?? "kulo-reliable-outbox-v1";
  const listeners = new Set<(event: ReliableOutboxStorageEvent) => void>();
  const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(name) : undefined;
  let databaseFlight: Promise<IDBDatabase> | undefined;
  let closed = false;
  const emit = (event: ReliableOutboxStorageEvent) => {
    if (closed) return;
    notify(listeners, event);
    if (closed) return;
    try { channel?.postMessage(event); }
    catch (error) { console.error("待发消息已保存，但跨页面通知失败", error); }
  };
  if (channel) channel.onmessage = (message: MessageEvent<ReliableOutboxStorageEvent>) => {
    if (closed || !message.data || typeof message.data.scope !== "string") return;
    notify(listeners, message.data);
  };
  const database = (): Promise<IDBDatabase> => {
    if (closed) return Promise.reject(new Error("待发消息存储已关闭"));
    if (databaseFlight) return databaseFlight;
    databaseFlight = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(new Error("当前浏览器无法保存待发消息，请检查存储设置")); return; }
      const request = factory.open(name, 3);
      let rejected = false;
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains("messages")) {
          const records = db.createObjectStore("messages", { keyPath: "sequence", autoIncrement: true });
          records.createIndex("scope", "scope");
          records.createIndex("scope-id", ["scope", "id"], { unique: true });
        }
        if (!db.objectStoreNames.contains("leases")) db.createObjectStore("leases", { keyPath: "scope" });
        const receipts = event.oldVersion < 2 ? db.createObjectStore("receipts", { keyPath: ["scope", "id"] }) : undefined;
        const cursor = request.transaction!.objectStore("messages").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const record = row.value as ReliableOutboxRecord;
          if (record.state === "accepted" && record.ack) receipts?.put({ scope: record.scope, id: record.id, sequence: record.sequence, ack: record.ack });
          const safe = migrateOutboxInvitation(record);
          if (safe !== record) row.update(safe);
          row.continue();
        };
      };
      request.onerror = () => { rejected = true; reject(request.error ?? new Error("无法打开待发消息存储")); };
      request.onblocked = () => { rejected = true; reject(new Error("待发消息存储正在升级，请关闭其他 Kulo 页面后重试")); };
      request.onsuccess = () => {
        const db = request.result;
        if (rejected) { db.close(); return; }
        db.onversionchange = () => { db.close(); databaseFlight = undefined; };
        resolve(db);
      };
    }).catch((error: unknown) => { databaseFlight = undefined; throw error; });
    return databaseFlight;
  };
  const transaction = async <T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, done: (result: T) => void, fail: (error: unknown) => void) => void): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      let error: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(error ?? tx.error ?? new Error("待发消息保存失败"));
      const fail = (cause: unknown) => { error = cause; tx.abort(); };
      try { run(tx, (value) => { result = value; }, fail); }
      catch (cause) { fail(cause); }
    });
  };
  const get = (scope: string, id: string): Promise<ReliableOutboxRecord | undefined> => transaction(["messages"], "readonly", (tx, done) => {
    const request = tx.objectStore("messages").index("scope-id").get([scope, id]);
    request.onsuccess = () => done(request.result as ReliableOutboxRecord | undefined);
  });
  const storage: ReliableOutboxStorage = {
    list: (scope) => transaction(["messages"], "readonly", (tx, done) => {
      const request = tx.objectStore("messages").index("scope").getAll(scope);
      request.onsuccess = () => done((request.result as ReliableOutboxRecord[]).sort((a, b) => a.sequence - b.sequence));
    }),
    get,
    lookup: (scope, id) => transaction(["messages", "receipts"], "readonly", (tx, done) => {
      const message = tx.objectStore("messages").index("scope-id").get([scope, id]);
      message.onsuccess = () => {
        const receipt = tx.objectStore("receipts").get([scope, id]);
        receipt.onsuccess = () => done({ record: message.result as ReliableOutboxRecord | undefined, receipt: receipt.result as Receipt | undefined });
      };
    }),
    async enqueue(scope, envelope, metadata, now) {
      let removed: { id: string; sequence: number } | undefined;
      const record = await transaction<ReliableOutboxRecord>(["messages"], "readwrite", (tx, done, fail) => {
        const store = tx.objectStore("messages");
        const request = store.index("scope-id").get([scope, idOf(envelope)]);
        request.onsuccess = () => {
          const replacement = metadata?.replacesFailed;
          const insert = (replaced?: ReliableOutboxRecord) => {
            try {
              if (request.result) {
                if (replacement) throw editConflict();
                done(existingRecord(request.result as ReliableOutboxRecord, envelope)); return;
              }
              const value = newRecord(scope, envelope, metadata, now);
              const add = store.add(value);
              add.onsuccess = () => {
                if (replaced) { store.delete(replaced.sequence); removed = { id: replaced.id, sequence: replaced.sequence }; }
                done({ ...value, sequence: Number(add.result) });
              };
            } catch (error) { fail(error); }
          };
          if (!replacement) { insert(); return; }
          const source = store.index("scope-id").get([scope, replacement.id]);
          source.onsuccess = () => {
            try { insert(validateReplacement(scope, envelope, replacement, source.result as ReliableOutboxRecord | undefined)); }
            catch (error) { fail(error); }
          };
        };
      });
      emit({ scope, ...(removed ? { removed } : {}) }); return record;
    },
    async claim(scope, owner, now, leaseMs) {
      const claim = await transaction<Claim>(["messages", "leases"], "readwrite", (tx, done) => {
        const store = tx.objectStore("messages");
        const leaseStore = tx.objectStore("leases");
        const rows = store.index("scope").getAll(scope);
        rows.onsuccess = () => {
          const lease = leaseStore.get(scope);
          lease.onsuccess = () => {
            const selected = selectClaim(rows.result as ReliableOutboxRecord[], lease.result as Lease | undefined, scope, owner, now, leaseMs);
            if (selected.claim.record && selected.lease) { store.put(selected.claim.record); leaseStore.put(selected.lease); }
            done(selected.claim);
          };
        };
      });
      if (claim.record) emit({ scope });
      return claim;
    },
    renew: (scope, owner, now, leaseMs) => transaction(["leases"], "readwrite", (tx, done) => {
      const store = tx.objectStore("leases");
      const request = store.get(scope);
      request.onsuccess = () => {
        if (!request.result || (request.result as Lease).owner !== owner) { done(false); return; }
        store.put({ scope, owner, expiresAt: now + leaseMs }); done(true);
      };
    }),
    async accept(scope, id, ack, sequence) {
      let savedAck = ack;
      let sourceSequence = sequence;
      const record = await transaction<ReliableOutboxRecord | undefined>(["messages", "receipts"], "readwrite", (tx, done) => {
        const store = tx.objectStore("messages");
        const request = store.index("scope-id").get([scope, id]);
        request.onsuccess = () => {
          const current = request.result as ReliableOutboxRecord | undefined;
          sourceSequence ??= current?.sequence;
          if (sourceSequence === undefined) { done(current); return; }
          savedAck = current?.sequence === sourceSequence && current.state === "accepted" && current.ack ? current.ack : ack;
          const receiptStore = tx.objectStore("receipts");
          const receipt = receiptStore.get([scope, id]);
          receipt.onsuccess = () => {
            if (((receipt.result as Receipt | undefined)?.sequence ?? 0) <= sourceSequence!) receiptStore.put({ scope, id, sequence: sourceSequence, ack: copy(savedAck) });
            if (!current || current.sequence !== sourceSequence || current.state === "accepted") { done(current); return; }
            const accepted: ReliableOutboxRecord = { ...current, state: "accepted", ack: copy(ack), error: undefined, errorCode: undefined };
            store.put(accepted); done(accepted);
          };
        };
      });
      if (sourceSequence !== undefined) emit({ scope, accepted: { id, sequence: sourceSequence, ack: savedAck } });
      return record;
    },
    async fail(scope, id, owner, error, code, retryAt, sequence) {
      let changed = false;
      await transaction<void>(["messages", "leases"], "readwrite", (tx, done) => {
        const store = tx.objectStore("messages");
        const request = store.index("scope-id").get([scope, id]);
        request.onsuccess = () => {
          const current = request.result as ReliableOutboxRecord | undefined;
          if (!current || current.state === "accepted" || sequence !== undefined && current.sequence !== sequence) { done(); return; }
          const lease = tx.objectStore("leases").get(scope);
          lease.onsuccess = () => {
            if ((lease.result as Lease | undefined)?.owner === owner) {
              store.put({ ...current, state: retryAt === undefined ? "failed" : "queued", error, errorCode: code, nextAttemptAt: retryAt ?? 0 }); changed = true;
            }
            done();
          };
        };
      });
      if (changed) emit({ scope });
    },
    async retry(scope, id, now) {
      const record = await transaction<ReliableOutboxRecord>(["messages"], "readwrite", (tx, done, fail) => {
        const store = tx.objectStore("messages");
        const request = store.index("scope-id").get([scope, id]);
        request.onsuccess = () => {
          const current = request.result as ReliableOutboxRecord | undefined;
          if (!current) { fail(Object.assign(new Error("待发请求不存在"), { code: "outbox_request_missing" })); return; }
          if (current.errorCode === legacyInvitationCode) { fail(Object.assign(new Error(current.error), { code: legacyInvitationCode })); return; }
          if (current.state === "accepted" || current.state === "sending") { done(current); return; }
          const next: ReliableOutboxRecord = { ...current, state: "queued", nextAttemptAt: now, error: undefined, errorCode: undefined };
          store.put(next); done(next);
        };
      });
      emit({ scope }); return record;
    },
    async release(scope, owner) {
      let changed = false;
      await transaction<void>(["leases"], "readwrite", (tx, done) => {
        const store = tx.objectStore("leases");
        const request = store.get(scope);
        request.onsuccess = () => {
          if ((request.result as Lease | undefined)?.owner === owner) { store.delete(scope); changed = true; }
          done();
        };
      });
      if (changed) emit({ scope });
    },
    async removeAccepted(scope, ids) {
      await transaction<void>(["messages"], "readwrite", (tx, done) => {
        const store = tx.objectStore("messages");
        for (const id of ids) {
          const request = store.index("scope-id").get([scope, id]);
          request.onsuccess = () => { const record = request.result as ReliableOutboxRecord | undefined; if (record?.state === "accepted") store.delete(record.sequence); };
        }
        done();
      });
      emit({ scope });
    },
    async remove(scope, id) {
      let removedSequence: number | undefined;
      await transaction<void>(["messages"], "readwrite", (tx, done, fail) => {
        const store = tx.objectStore("messages");
        const request = store.index("scope-id").get([scope, id]);
        request.onsuccess = () => {
          const record = request.result as ReliableOutboxRecord | undefined;
          if (!record) { done(); return; }
          if (record.state !== "failed") { fail(Object.assign(new Error("只能移除发送失败的请求"), { code: "outbox_remove_conflict" })); return; }
          removedSequence = record.sequence;
          store.delete(record.sequence); done();
        };
      });
      if (removedSequence !== undefined) emit({ scope, removed: { id, sequence: removedSequence } });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() {
      if (closed) return;
      closed = true; channel?.close(); listeners.clear();
      if (databaseFlight) void databaseFlight.then((db) => db.close(), () => {});
      databaseFlight = undefined;
    },
  };
  return storage;
}
