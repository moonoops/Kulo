import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { apply, applyImmutable, type Op } from "@earendil-works/chord/delta";
import {
  CompactionTask, defineExtension, GenerationTask, hook, ToolTask,
  AssistantEntry, UserEntry, type DocumentId, type JsonObject, type Storage, type StorageWrite,
} from "@earendil-works/pi-durable";
import {
  inspectSensitiveText, isVerifiedImageBinaryPayload, isVerifiedImageContainerValue, isVisionImageMime,
  mayContainDeviceInvitation, redactDeviceInvitationText, redactSensitiveText,
} from "@kulo/protocol";
import { invalidateDeviceInvitationSearchIndex } from "./conversation-history.js";
import { CoordinatorEventEntry } from "./state.js";
import { KuloUserEntry } from "./ui-cards.js";
import { nativeAssistantOpaqueFields, nativeWireOpaqueFields, type NativeOpaqueField } from "./model-native-replay.js";

const SECRET_FIELD = /^(?:password|passwd|passphrase|secret|token|api[_-]?key|(?:router|worker|sharedRead)ApiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|proxy-authorization|cookie|set-cookie|密码|口令|密钥|私钥)$/i;
const STRUCTURAL_FIELDS = new Set([
  "id", "type", "kind", "role", "status", "state", "api", "provider", "providerId", "modelId",
  "conversationId", "taskId", "entryId", "ticketId", "requestId", "commandId", "connectionId",
  "connectionIds", "secretFields", "toolCallId", "callId", "version", "scopeKind", "history", "fork",
]);
const REDACTED = "[已隐藏]";
const SETTINGS_SECRET_FIELD = /^(?:apiKey|routerApiKey|workerApiKey|sharedReadApiKey)$/;
const SEALED_PREFIX = "kulo-secret:";
const PAYLOAD_FIELDS = new Set(["payload", "data", "structuredOutput", "details", "kuloNativeContent"]);
const DYNAMIC_KEY_FIELDS = new Set(["payload", "structuredOutput", "details"]);
const CORRUPT_IMAGE_PLACEHOLDER_TEXT = "[图片数据不可用或已损坏，请重新读取]";

function isTopLevelReadImageBlock(value: unknown): value is { type: "image"; mimeType: string; data: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "image") return false;
  const keys = Object.keys(record);
  if (keys.length !== 3) return false;
  if (!keys.every((k) => k === "type" || k === "mimeType" || k === "data")) return false;
  return isVerifiedImageContainerValue(record, "data", record.data);
}

function isVerifiedImageMimeTag(parent: unknown, key: string | undefined, value: string): boolean {
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return false;
  const record = parent as Record<string, unknown>;
  if (key === "mimeType" || key === "mime_type" || key === "media_type") {
    return isVisionImageMime(value) && isVerifiedImageContainerValue(record, "data", record.data);
  }
  if (key === "format") {
    return record.type === "image" && isVerifiedImageContainerValue(record, "data_base64", record.data_base64);
  }
  return false;
}

function sanitizeCorruptImagesInMessages<T>(messages: T): T {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const record = message as Record<string, unknown>;
    if ((record.role !== "user" && record.role !== "toolResult") || !Array.isArray(record.content)) {
      return message;
    }
    let contentChanged = false;
    const nextContent = record.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const part = block as Record<string, unknown>;
      if (part.type !== "image") return block;
      const mime = part.mimeType ?? part.mime_type;
      if (typeof mime === "string" && isVerifiedImageBinaryPayload(part.data, mime)) {
        return block;
      }
      contentChanged = true;
      return { type: "text", text: CORRUPT_IMAGE_PLACEHOLDER_TEXT };
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...record, content: nextContent };
  });
  return (changed ? nextMessages : messages) as T;
}

export interface CredentialSealingOptions {
  /** Exact known credentials (including their stored encodings), without prose-pattern heuristics. */
  isKnownSecret?: (text: string) => boolean;
  vault?: {
    get(ref: string): Promise<Record<string, string> | undefined>;
    set(ref: string, fields: Record<string, string>): Promise<void>;
  };
  rememberSecrets?: (values: readonly string[]) => void;
  /** Must safely archive a requested credential before resolving; no SQLite transaction is held during this call. */
  processUserText?: (text: string, requestId: string) => Promise<unknown>;
  /** Invoked after each durable storage commit succeeds. */
  onCommit?: () => void;
}

class SettingsSecretSealer {
  readonly #refs = new Map<string, string>();
  constructor(readonly options: CredentialSealingOptions & { vault: NonNullable<CredentialSealingOptions["vault"]> },
    readonly withoutInvites?: (text: string) => string) {}
  async #visit(value: unknown, sealing: boolean, field?: string): Promise<unknown> {
    if (typeof value === "string" && field && SETTINGS_SECRET_FIELD.test(field) && value && value !== REDACTED) {
      if (value.startsWith(SEALED_PREFIX)) {
        const ref = value.slice(SEALED_PREFIX.length);
        if (!/^durable-secret:[a-f0-9-]{36}$/.test(ref)) throw new Error("Invalid settings credential reference");
        const stored = await this.options.vault.get(ref);
        if (!stored || typeof stored.value !== "string" || !stored.value) throw new Error("Settings credential is unavailable");
        if (this.withoutInvites && this.withoutInvites(stored.value) !== stored.value) return sealing ? "" : stored.value;
        this.#refs.set(stored.value, ref);
        this.options.rememberSecrets?.([stored.value]);
        return sealing ? value : stored.value;
      }
      if (this.withoutInvites && this.withoutInvites(value) !== value) return sealing ? "" : value;
      this.options.rememberSecrets?.([value]);
      if (!sealing) return value;
      let ref = this.#refs.get(value);
      if (!ref) {
        ref = `durable-secret:${randomUUID()}`;
        await this.options.vault.set(ref, { value });
        this.#refs.set(value, ref);
      }
      return `${SEALED_PREFIX}${ref}`;
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) result.push(await this.#visit(item, sealing, field));
      return result;
    }
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) Object.defineProperty(result, key, {
      value: await this.#visit(item, sealing, key), enumerable: true, configurable: true, writable: true,
    });
    return result;
  }
  async seal(value: unknown): Promise<JsonObject> { return await this.#visit(value, true) as JsonObject; }
  async unseal(value: unknown): Promise<JsonObject> { return await this.#visit(value, false) as JsonObject; }
}

/** Preserve protocol identities while filtering free text and explicitly named secret fields. */
export function redactCredentialData<T>(value: T, redact: (text: string) => string, options: {
  preserveSealedReferences?: boolean;
  nativeContent?: "records" | "messages" | "wire" | "live" | "toolResult";
  isKnownSecret?: (text: string) => boolean;
} = {}): T {
  const seen = new WeakMap<object, unknown>();
  const opaqueFields = new Map<string, string>();
  const protect = (fields: NativeOpaqueField[], prefix: Array<string | number> = [], redactKnown = false) => {
    for (const { owner, field, path } of fields) {
      const value = owner[field];
      if (typeof value !== "string") continue;
      if (options.isKnownSecret?.(value)) {
        if (redactKnown) continue;
        throw documentLeak();
      }
      opaqueFields.set(JSON.stringify([...prefix, ...path]), value);
    }
  };
  const protectLive = (live: unknown, prefix: Array<string | number> = []) => {
    if (!live || typeof live !== "object") return;
    const generation = (live as Record<string, unknown>).generation;
    if (!generation || typeof generation !== "object") return;
    protect(nativeAssistantOpaqueFields((generation as Record<string, unknown>).message), [...prefix, "generation", "message"], true);
  };
  // Call sites opt into actual transcript/entry domains. User data and tool result metadata never authorize exemptions.
  if (options.isKnownSecret && options.nativeContent === "messages" && Array.isArray(value)) {
    for (const [index, message] of value.entries()) protect(nativeAssistantOpaqueFields(message), [index]);
  } else if (options.isKnownSecret && options.nativeContent === "wire") protect(nativeWireOpaqueFields(value));
  else if (options.nativeContent === "live") protectLive(value);
  else if (options.isKnownSecret && options.nativeContent === "records") {
    const records = (input: unknown, prefix: Array<string | number> = []): void => {
      if (Array.isArray(input)) { for (const [index, item] of input.entries()) records(item, [...prefix, index]); return; }
      if (!input || typeof input !== "object") return;
      const record = input as Record<string, unknown>;
      if (record.kind === AssistantEntry.kind && Array.isArray(record.model)) for (const [index, message] of record.model.entries()) protect(nativeAssistantOpaqueFields(message), [...prefix, "model", index]);
      if (record.record && typeof record.record === "object" && (record.record as Record<string, unknown>).kind === "pi.live") protectLive(record.value, [...prefix, "value"]);
      if (record.type === "entry") records(record.value, [...prefix, "value"]);
      if (record.entry && typeof record.entry === "object") records(record.entry, [...prefix, "entry"]);
      if (Array.isArray(record.items)) records(record.items, [...prefix, "items"]);
    };
    records(value);
  }
  const mode = options.nativeContent;
  const visit = (
    input: unknown,
    field?: string,
    referenceMap = false,
    payload = false,
    dynamicKeys = false,
    currentPath: Array<string | number> = [],
    imageChannel = mode === "wire",
    blockedImageSubtree = false,
    parentObj?: unknown,
    inArray = false,
  ): unknown => {
    if (typeof input === "string") {
      if (opaqueFields.get(JSON.stringify(currentPath)) === input) return input;
      if (imageChannel && !dynamicKeys && !blockedImageSubtree) {
        if (isVerifiedImageContainerValue(parentObj, field, input)) return input;
        if (isVerifiedImageMimeTag(parentObj, field, input)) return input;
      }
      if (options.preserveSealedReferences && field && SETTINGS_SECRET_FIELD.test(field) && /^kulo-secret:durable-secret:[a-f0-9-]{36}$/.test(input)) return input;
      // Memory setup indexes secret fields by opaque store handles; those handles are not credential values.
      if (referenceMap && /^(?:memory-service|media|connection|durable-secret):[a-zA-Z0-9._:-]+$/.test(input)) return redact(input);
      if (field && SECRET_FIELD.test(field)) return input ? REDACTED : input;
      if (!payload && field && STRUCTURAL_FIELDS.has(field) && !(mode === "wire" && field === "state")) return input;
      return redact(input);
    }
    if (input === null || typeof input !== "object") return input;
    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return input;
    const previous = seen.get(input);
    if (previous) return previous;
    if (Array.isArray(input)) {
      const result: unknown[] = [];
      seen.set(input, result);
      const itemField = field === "images" && inArray ? undefined : field;
      for (const [index, item] of input.entries()) {
        result.push(visit(
          item,
          itemField,
          referenceMap,
          payload,
          dynamicKeys,
          [...currentPath, index],
          imageChannel,
          blockedImageSubtree,
          input,
          true,
        ));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return input;
    const result: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
    seen.set(input, result);
    const obj = input as Record<string, unknown>;
    const isNonTranscriptDocEnvelope =
      mode === "records" &&
      !payload &&
      !dynamicKeys &&
      Boolean(obj.record && typeof obj.record === "object" && !Array.isArray(obj.record)) &&
      !isTranscriptDocument((obj.record as Record<string, unknown>).kind as string | undefined);
    const isNestedCallResult =
      mode === "records" &&
      !payload &&
      !dynamicKeys &&
      !blockedImageSubtree &&
      typeof obj.taskId === "number" &&
      typeof obj.isError === "boolean";
    const isReadStructuredOutputHost =
      (mode === "toolResult" && currentPath.length === 0) || isNestedCallResult;

    for (const [key, item] of Object.entries(input)) {
      if (key === "structuredOutput" && isReadStructuredOutputHost && isTopLevelReadImageBlock(item)) {
        Object.defineProperty(result, key, {
          value: { type: "image", mimeType: item.mimeType, data: item.data },
          enumerable: true, writable: true, configurable: true,
        });
        continue;
      }
      let nextKey = dynamicKeys ? redact(key) : key;
      let suffix = 1;
      while (Object.hasOwn(result, nextKey)) nextKey = `${REDACTED}:${suffix++}`;

      const nextPayload = payload || PAYLOAD_FIELDS.has(key);
      const nextDynamicKeys = dynamicKeys || DYNAMIC_KEY_FIELDS.has(key);
      const blocksImagesHere =
        blockedImageSubtree ||
        nextDynamicKeys ||
        key === "arguments" ||
        (isNonTranscriptDocEnvelope && key === "value") ||
        (mode === "wire" && (
          key === "function" ||
          (key === "input" && obj.type === "tool_use") ||
          (key === "args" && typeof obj.name === "string") ||
          obj.role === "assistant" ||
          obj.role === "model"
        ));

      let nextImageChannel = false;
      if (!blocksImagesHere) {
        if (mode === "wire") {
          nextImageChannel = imageChannel;
        } else if (mode === "messages") {
          nextImageChannel =
            imageChannel ||
            (!payload && key === "content" && (obj.role === "user" || obj.role === "toolResult"));
        } else if (mode === "toolResult") {
          nextImageChannel =
            imageChannel ||
            (currentPath.length === 0 && key === "output" && Array.isArray(item));
        } else if (mode === "records") {
          nextImageChannel =
            imageChannel ||
            (!payload && key === "content" && (
              obj.role === "user" ||
              obj.role === "toolResult" ||
              obj.mode === "steer" ||
              obj.mode === "followUp"
            ));
        }
      }

      Object.defineProperty(result, nextKey, {
        value: visit(
          item,
          key,
          field === "credentialRefs",
          nextPayload,
          nextDynamicKeys,
          [...currentPath, key],
          nextImageChannel,
          blocksImagesHere,
          input,
          false,
        ),
        enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  };
  return visit(value) as T;
}

function documentLeak(): Error {
  return Object.assign(new Error("凭据不能写入普通状态记录，请通过连接授权保存。"), { code: "credential_document_leak" });
}

function redactWrite(write: StorageWrite, redact: (text: string) => string, options: CredentialSealingOptions): StorageWrite {
  if (write.type === "document.create" || write.type === "document.change") {
    // Session publishes its original immutable document, not a storage adapter's replacement.
    // Changing string lengths here would invalidate later append/truncate deltas from that cache.
    return write;
  }
  return redactCredentialData(write, redact, { nativeContent: "records", isKnownSecret: options.isKnownSecret });
}

const READS = new Set([
  "conversation", "scanConversations", "entry", "findLatestHeadMarker", "scanEntries", "task", "scanTasks",
  "submission", "scanSubmissions", "submissionByRequest", "findDocument", "document", "scanDocuments",
]);
const TRANSCRIPT_DOCUMENTS = new Set(["pi.live", "pi.inbox", "pi.tool.nested-call"]);
const isTranscriptDocument = (kind: string | undefined): boolean =>
  Boolean(kind && (TRANSCRIPT_DOCUMENTS.has(kind) || kind.startsWith("pi.")));

/** The last disk boundary; callers must also filter live views because Session adopts its original records. */
export function wrapRedactedStorage(storage: Storage, redact: (text: string) => string, options: CredentialSealingOptions = {}): Storage {
  const sealer = options.vault ? new SettingsSecretSealer({ ...options, vault: options.vault }) : undefined;
  const rawDocuments = new Map<DocumentId, { kind: string; value: JsonObject }>();
  let pending: Promise<unknown> = Promise.resolve();
  const commit: Storage["commit"] = (batches, receive, context) => {
    const run = pending.then(async () => {
      const values = new Map<DocumentId, JsonObject>();
      const kinds = new Map<DocumentId, string>();
      const stagedRaw = new Map<DocumentId, { kind: string; value: JsonObject } | null>();
      const getRaw = (id: DocumentId): { kind: string; value: JsonObject } | undefined =>
        stagedRaw.has(id) ? (stagedRaw.get(id) ?? undefined) : rawDocuments.get(id);
      const load = async (id: DocumentId) => {
        const cached = values.get(id);
        if (cached) return cached;
        const raw = getRaw(id);
        if (raw) {
          kinds.set(id, raw.kind);
          values.set(id, raw.value);
          return raw.value;
        }
        const stored = await storage.document(id, "current", context);
        if (!stored) throw new Error("Conversation document is unavailable");
        kinds.set(id, stored.record.kind);
        const value = sealer && stored.record.kind === "kulo.settings" ? await sealer.unseal(stored.value) : stored.value;
        values.set(id, value);
        return value;
      };
      const safeBatches: StorageWrite[][] = [];
      for (const batch of batches) {
        const safeBatch: StorageWrite[] = [];
        for (const write of batch) {
          if (write.type === "document.copy") {
            const rawSource = write.source.at === "current" ? getRaw(write.source.id) : undefined;
            const source = rawSource ? undefined : await storage.document(write.source.id, write.source.at, context);
            const value = values.get(write.source.id) ?? rawSource?.value ?? (source && (sealer && source.record.kind === "kulo.settings" ? await sealer.unseal(source.value) : source.value));
            if (!value) throw new Error("Conversation document copy is unavailable");
            values.set(write.record.id, value);
            kinds.set(write.record.id, write.record.kind);
            if (rawSource) stagedRaw.set(write.record.id, { kind: write.record.kind, value });
            else stagedRaw.set(write.record.id, null);
            safeBatch.push(write);
          } else if (write.type === "document.retire") {
            values.delete(write.id);
            stagedRaw.set(write.id, null);
            safeBatch.push(write);
          } else if (write.type === "document.create" || write.type === "document.change") {
            const id = write.type === "document.create" ? write.record.id : write.id;
            if (write.type === "document.create") kinds.set(id, write.record.kind);
            const value = write.content.kind === "base" ? write.content.value
              : applyImmutable(await load(id), write.content.ops);
            if (!kinds.has(id)) await load(id);
            const kind = kinds.get(id);
            if (isTranscriptDocument(kind)) {
              const sanitized = redactCredentialData(value, redact, {
                nativeContent: kind === "pi.live" ? "live" : "records",
                isKnownSecret: options.isKnownSecret,
              });
              const hadRaw = getRaw(id) !== undefined;
              const changed = JSON.stringify(sanitized) !== JSON.stringify(value);
              values.set(id, value);
              stagedRaw.set(id, changed ? { kind: kind!, value } : null);
              safeBatch.push(changed || (hadRaw && write.content.kind === "delta")
                ? { ...write, content: { kind: "base", version: write.content.version, value: sanitized } }
                : write);
            } else {
              const sealed = sealer && kind === "kulo.settings" ? await sealer.seal(value) : value;
              if (JSON.stringify(redactCredentialData(sealed, redact, { preserveSealedReferences: Boolean(sealer) })) !== JSON.stringify(sealed)) throw documentLeak();
              values.set(id, value);
              safeBatch.push(sealed === value ? write : { ...write, content: { kind: "base", version: write.content.version, value: sealed } });
            }
          } else {
            safeBatch.push(redactWrite(write, redact, options));
          }
        }
        safeBatches.push(safeBatch);
      }
      const result = await storage.commit(safeBatches, receive, context);
      for (const [id, raw] of stagedRaw) {
        if (raw === null) rawDocuments.delete(id);
        else rawDocuments.set(id, raw);
      }
      try {
        options.onCommit?.();
      } catch {
        // Ignore observer errors
      }
      return result;
    });
    pending = run.catch(() => undefined);
    return run;
  };
  return new Proxy(storage, {
    get(target, property) {
      if (property === "commit") return commit;
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      if (property === "document") return async (...args: Parameters<Storage["document"]>) => {
        if (args[1] === "current") rawDocuments.delete(args[0]);
        const stored = await storage.document(...args);
        if (sealer && stored?.record.kind === "kulo.settings") return { ...stored, value: await sealer.unseal(stored.value) };
        return redactCredentialData(stored, redact, { nativeContent: "records", isKnownSecret: options.isKnownSecret });
      };
      if (property === "close") return async (...args: Parameters<Storage["close"]>) => {
        rawDocuments.clear();
        return storage.close(...args);
      };
      if (typeof property === "string" && READS.has(property)) {
        return async (...args: unknown[]) => redactCredentialData(await Reflect.apply(member, target, args), redact, { nativeContent: "records", isKnownSecret: options.isKnownSecret });
      }
      return member.bind(target);
    },
  });
}

export function createCredentialRedactionExtension(
  redact: (text: string) => string,
  options: Pick<CredentialSealingOptions, "isKnownSecret"> & {
    onCompactionDeclined?: (conversationId: number, reasonCode: "unredacted_in_memory_secret") => void;
  } = {},
) {
  return defineExtension({
    name: "kulo-credential-redaction",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => ({
          messages: redactCredentialData(sanitizeCorruptImagesInMessages(request.messages), redact, {
            nativeContent: "messages",
            isKnownSecret: options.isKnownSecret,
          }),
        }),
        beforeProviderRequest: (request) => ({ payload: redactCredentialData(request.payload, redact, { nativeContent: "wire", isKnownSecret: options.isKnownSecret }) }),
      }),
      hook(ToolTask, {
        beforeTool: (call) => ({ arguments: redactCredentialData(call.arguments, redact) as unknown as JsonObject }),
        afterTool: (_call, result) => redactCredentialData(result, redact, { nativeContent: "toolResult", isKnownSecret: options.isKnownSecret }),
      }),
      hook(CompactionTask, {
        beforeCompact: (input, api) => {
          const safe = redactCredentialData(input.messages, redact, { nativeContent: "messages", isKnownSecret: options.isKnownSecret });
          // Compaction hooks cannot replace source messages; decline rather than send a stale raw cache to its model.
          if (JSON.stringify(safe) !== JSON.stringify(input.messages) || input.instructions && redact(input.instructions) !== input.instructions) {
            const convId = Number(api?.conversationId);
            if (Number.isSafeInteger(convId) && convId > 0) {
              options.onCompactionDeclined?.(convId, "unredacted_in_memory_secret");
            }
            return { decline: true };
          }
          return undefined;
        },
      }),
    ],
  });
}

const RECORD_TABLES = ["conversations", "entries", "tasks", "submissions", "documents"] as const;
interface RecordCleanup { table: typeof RECORD_TABLES[number]; id: number; record: string }
interface RevisionCleanup { documentId: number; seq: number; content: string }

function prepareRecordCleanup(database: DatabaseSync, redact: (text: string) => string, options: CredentialSealingOptions): RecordCleanup[] {
  const changes: RecordCleanup[] = [];
  for (const table of RECORD_TABLES) {
    if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)) continue;
    const rows = database.prepare(`SELECT id, record FROM ${table}`).all() as Array<{ id: number; record: string }>;
    for (const row of rows) {
      const parsed: unknown = JSON.parse(row.record);
      const next = redactCredentialData(parsed, redact, { nativeContent: "records", isKnownSecret: options.isKnownSecret });
      const encoded = JSON.stringify(next);
      if (encoded !== JSON.stringify(parsed)) changes.push({ table, id: row.id, record: encoded });
    }
  }
  return changes;
}

async function prepareRevisionCleanup(database: DatabaseSync, redact: (text: string) => string, sealer?: SettingsSecretSealer, options: CredentialSealingOptions = {}): Promise<RevisionCleanup[]> {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'document_revisions'").get()) return [];
  const ids = database.prepare("SELECT DISTINCT document_id FROM document_revisions").all() as Array<{ document_id: number }>;
  const read = database.prepare("SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq");
  const settingsIds = new Set<number>();
  const liveIds = new Set<number>();
  const transcriptIds = new Set<number>();
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'documents'").get()) {
    for (const row of database.prepare("SELECT id, record FROM documents").all() as Array<{ id: number; record: string }>) {
      const kind = (JSON.parse(row.record) as { kind?: string }).kind;
      if (sealer && kind === "kulo.settings") settingsIds.add(row.id);
      if (kind === "pi.live") liveIds.add(row.id);
      else if (isTranscriptDocument(kind)) transcriptIds.add(row.id);
    }
    if (sealer) {
      // Discover every historical settings credential first so earlier prose/entries can be filtered by exact value.
      for (const id of settingsIds) {
        let value: unknown;
        let version: number | undefined;
        for (const row of read.all(id) as Array<{ kind: string; version: number; content: string }>) {
          const parsed: unknown = JSON.parse(row.content);
          value = restoreRevision(value, version, row, parsed);
          value = await sealer.unseal(value);
          version = row.version;
        }
      }
    }
  }
  const changes: RevisionCleanup[] = [];
  for (const { document_id: id } of ids) {
    const revisions = read.all(id) as Array<{ seq: number; kind: string; version: number; content: string }>;
    let value: unknown;
    let version: number | undefined;
    let dirty = false;
    const sanitized: Array<{ seq: number; content: string }> = [];
    for (const revision of revisions) {
      const parsed: unknown = JSON.parse(revision.content);
      value = restoreRevision(value, version, revision, parsed);
      version = revision.version;
      if (sealer && settingsIds.has(id)) value = await sealer.unseal(value);
      const sealed = sealer && settingsIds.has(id) ? await sealer.seal(value) : value;
      const next = JSON.stringify(redactCredentialData(sealed, redact, {
        preserveSealedReferences: Boolean(sealer),
        ...(liveIds.has(id)
          ? { nativeContent: "live" as const, isKnownSecret: options.isKnownSecret }
          : transcriptIds.has(id)
            ? { nativeContent: "records" as const, isKnownSecret: options.isKnownSecret }
            : {}),
      }));
      if (next !== JSON.stringify(parsed) || revision.kind !== "base") {
        if (next !== JSON.stringify(value) || settingsIds.has(id)) dirty = true;
      }
      sanitized.push({ seq: revision.seq, content: next });
    }
    if (!dirty) continue;
    // A sanitized base per historical point preserves snapshots without replaying old secret fragments or offsets.
    for (const revision of sanitized) changes.push({ documentId: id, ...revision });
  }
  return changes;
}

function restoreRevision(value: unknown, previousVersion: number | undefined, revision: { kind: string; version: number }, content: unknown): unknown {
  if (revision.kind === "base") return content;
  if (revision.kind === "delta" && value !== undefined && previousVersion === revision.version && Array.isArray(content)) return apply(value, content as Op[]);
  throw new Error("Invalid conversation document revision");
}

function checkpoint(database: DatabaseSync): void {
  const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
  if (result.busy !== 0) throw new Error("Conversation storage is in use");
}

async function scrubDatabase(filename: string, redact: (text: string) => string, sealer?: SettingsSecretSealer, options: CredentialSealingOptions = {}): Promise<number> {
  if (!fs.lstatSync(filename).isFile()) throw new Error("Conversation storage must be a regular file");
  const pendingFile = `${filename}.redaction-pending`;
  if (fs.existsSync(pendingFile) && !fs.lstatSync(pendingFile).isFile()) throw new Error("Conversation cleanup marker is invalid");
  const database = new DatabaseSync(filename);
  let transaction = false;
  try {
    database.exec("PRAGMA busy_timeout = 0; PRAGMA secure_delete = ON");
    const integrity = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (integrity.quick_check !== "ok") throw new Error("Conversation storage integrity check failed");
    checkpoint(database);
    const version = (database.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    // Vault operations may await OS authorization; prepare their encrypted references outside the SQLite transaction.
    const revisions = await prepareRevisionCleanup(database, redact, sealer, options);
    const records = prepareRecordCleanup(database, redact, options);
    database.exec("BEGIN EXCLUSIVE");
    transaction = true;
    if ((database.prepare("PRAGMA data_version").get() as { data_version: number }).data_version !== version) throw new Error("Conversation storage changed during cleanup");
    const updateRevision = revisions.length ? database.prepare("UPDATE document_revisions SET kind = 'base', content = ? WHERE document_id = ? AND seq = ?") : undefined;
    for (const revision of revisions) updateRevision!.run(revision.content, revision.documentId, revision.seq);
    for (const table of RECORD_TABLES) {
      const changes = records.filter((record) => record.table === table);
      if (!changes.length) continue;
      const update = database.prepare(`UPDATE ${table} SET record = ? WHERE id = ?`);
      for (const record of changes) update.run(record.record, record.id);
    }
    const rows = revisions.length + records.length;
    if (rows > 0 && !fs.existsSync(pendingFile)) fs.writeFileSync(pendingFile, "1\n", { flag: "wx", mode: 0o600 });
    database.exec("COMMIT");
    transaction = false;
    // A crash after COMMIT but before VACUUM must not make the retry skip freed pages or the old WAL.
    if (rows > 0 || fs.existsSync(pendingFile)) {
      checkpoint(database);
      database.exec("VACUUM");
      checkpoint(database);
      fs.rmSync(pendingFile);
    }
    return rows;
  } finally {
    if (transaction) database.exec("ROLLBACK");
    database.close();
  }
}

function historicalUserText(value: unknown): { conversationId: number; text: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.kind !== UserEntry.kind && entry.kind !== KuloUserEntry.kind && entry.kind !== CoordinatorEventEntry.kind) return undefined;
  if (!Number.isSafeInteger(entry.conversationId) || Number(entry.conversationId) < 1) throw new Error("Invalid historical user conversation");
  if (entry.kind === CoordinatorEventEntry.kind) {
    const data = entry.data as { eventKind?: unknown; manualText?: unknown } | undefined;
    return data?.eventKind === "user_task_instruction" && typeof data.manualText === "string" && data.manualText
      ? { conversationId: Number(entry.conversationId), text: data.manualText }
      : undefined;
  }
  if (entry.kind === KuloUserEntry.kind) {
    const data = entry.data as { text?: unknown } | undefined;
    if (typeof data?.text === "string") return { conversationId: Number(entry.conversationId), text: data.text };
  }
  const messages = Array.isArray(entry.model) ? entry.model as Array<{ role?: unknown; content?: unknown }> : [];
  const text = messages.filter((message) => message.role === "user").flatMap((message) => {
    if (typeof message.content === "string") return [message.content];
    return Array.isArray(message.content) ? message.content.flatMap((block: unknown) => {
      if (!block || typeof block !== "object") return [];
      const part = block as { type?: unknown; text?: unknown };
      return part.type === "text" && typeof part.text === "string" ? [part.text] : [];
    }) : [];
  }).join("\n");
  return text ? { conversationId: Number(entry.conversationId), text } : undefined;
}

function collectHistoricalCredentials(files: readonly string[], archiveRequested: boolean) {
  const requests: Array<{ text: string; requestId: string }> = [];
  const inviteTokens = new Set<string>();
  const remember = (tokens: readonly string[]) => { for (const token of tokens) inviteTokens.add(token); };
  const discoverInvites = (value: unknown): void => {
    if (typeof value === "string") {
      redactDeviceInvitationText(value, remember);
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) discoverInvites(child);
    }
  };
  for (const filename of files) {
    if (!fs.existsSync(filename) || fs.statSync(filename).size === 0) continue;
    if (!fs.lstatSync(filename).isFile()) throw new Error("Conversation storage must be a regular file");
    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      const integrity = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (integrity.quick_check !== "ok") throw new Error("Conversation storage integrity check failed");
      for (const table of RECORD_TABLES) {
        if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)) continue;
        for (const row of database.prepare(`SELECT id, record FROM ${table} ORDER BY id`).iterate()) {
          const raw = String(row.record);
          const candidate = mayContainDeviceInvitation(raw);
          if (!candidate && (!archiveRequested || table !== "entries")) continue;
          const record: unknown = JSON.parse(raw);
          if (candidate) discoverInvites(record);
          if (!archiveRequested || table !== "entries") continue;
          const user = historicalUserText(record);
          if (!user) continue;
          const inspection = inspectSensitiveText(user.text);
          if (!inspection.saveRequested || !inspection.secrets.length) continue;
          if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id < 1) throw new Error("Invalid historical user entry");
          // Entry IDs are immutable and shared by migration backups; raw message hashes would enable password guessing.
          requests.push({ text: user.text, requestId: `history:${user.conversationId}:${row.id}` });
        }
      }
      if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'document_revisions'").get()) {
        // Streamed documents may assemble the invitation from several deltas before it is echoed elsewhere.
        const candidates = new Set<number>();
        for (const row of database.prepare("SELECT document_id, content FROM document_revisions").iterate()) {
          if (mayContainDeviceInvitation(String(row.content))) candidates.add(Number(row.document_id));
        }
        const read = database.prepare("SELECT kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq");
        for (const id of candidates) {
          let value: unknown;
          let version: number | undefined;
          for (const row of read.iterate(id) as Iterable<{ kind: string; version: number; content: string }>) {
            value = restoreRevision(value, version, row, JSON.parse(row.content));
            version = row.version;
            discoverInvites(value);
          }
        }
      }
    } finally { database.close(); }
  }
  return { requests, inviteTokens };
}

// Compile once per migration. Expired invitations need not remain in the Hub's live credential filter.
function historicalInvitePatterns(inviteTokens: Set<string>): RegExp[] {
  const values = new Set<string>();
  for (const token of inviteTokens) {
    const bytes = Buffer.from(token);
    const base64 = bytes.toString("base64");
    const encoded = encodeURIComponent(base64);
    for (const form of [token, base64, bytes.toString("base64url"), encoded, encoded.replace(/%[\dA-F]{2}/g, (part) => part.toLowerCase())]) values.add(form);
  }
  const literals = [...values].sort((a, b) => b.length - a.length).map((value) => value.replaceAll("+", "\\+"));
  const patterns: RegExp[] = [];
  for (let i = 0; i < literals.length; i += 256) patterns.push(new RegExp(literals.slice(i, i + 256).join("|"), "g"));
  return patterns;
}

/** Run before opening Durable; remove recognized secrets from stored records and Kulo-owned migration backups. */
export async function scrubStoredConversationSecrets(
  stateDir: string, redact: (text: string) => string, options: CredentialSealingOptions = {},
): Promise<{ databases: number; rows: number }> {
  const files = [path.join(stateDir, "kulo.sqlite")];
  const backups = path.join(stateDir, "backups");
  if (fs.existsSync(backups)) {
    if (!fs.lstatSync(backups).isDirectory()) throw new Error("Conversation backup directory is invalid");
    for (const entry of fs.readdirSync(backups)) {
      if (/^kulo-[a-zA-Z0-9_.-]+\.sqlite$/.test(entry) || /^kulo-before-state-v[23]\.sqlite\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(entry)) {
        files.push(path.join(backups, entry));
      }
    }
  }
  let databases = 0;
  let rows = 0;
  try {
    const { requests, inviteTokens } = collectHistoricalCredentials(files, Boolean(options.processUserText));
    // A different entry or document revision can echo a token without its invitation.
    const knownInvites = historicalInvitePatterns(inviteTokens);
    const withoutInvites = (text: string): string => {
      let safe = redactDeviceInvitationText(text);
      for (const pattern of knownInvites) safe = safe.replace(pattern, REDACTED);
      return safe;
    };
    const cleanupOptions = knownInvites.length ? { ...options, isKnownSecret: (text: string) =>
      knownInvites.some((pattern) => text.search(pattern) >= 0) || Boolean(options.isKnownSecret?.(text)) } : options;
    const sealer = options.vault ? new SettingsSecretSealer({ ...options, vault: options.vault }, withoutInvites) : undefined;
    if (options.processUserText) {
      const toArchive = new Map<string, string>();
      for (const request of requests) {
        const text = withoutInvites(request.text);
        if (text !== request.text) {
          const inspection = inspectSensitiveText(text);
          if (!inspection.saveRequested || !inspection.secrets.length) continue;
        }
        const previous = toArchive.get(request.requestId);
        if (previous !== undefined && previous !== text) throw new Error("Conflicting historical user entries");
        toArchive.set(request.requestId, text);
      }
      // Every archival succeeds before the first history rewrite; a locked vault leaves originals recoverable.
      for (const [requestId, text] of toArchive) await options.processUserText(text, requestId);
    }
    if (inviteTokens.size) invalidateDeviceInvitationSearchIndex(stateDir);
    for (const filename of files) {
      if (!fs.existsSync(filename) || fs.statSync(filename).size === 0) continue;
      rows += await scrubDatabase(filename, (text) => redact(withoutInvites(text)), sealer, cleanupOptions);
      databases++;
    }
    return { databases, rows };
  } catch {
    // SQLite/JSON diagnostics may embed stored text; the caller receives only a safe readiness failure.
    throw Object.assign(new Error("未能安全清理对话中的凭据，请确认没有其他 Kulo 进程占用本地记录。"), { code: "credential_history_unavailable" });
  }
}

export const BUILTIN_MEMORY_REDACTION_PENDING_FILE = "memory.sqlite.redaction-pending";

/**
 * Physically scrubs any row in `memory.sqlite` (including embedding blob and FTS5 index via
 * `PRAGMA secure_delete = ON` + FTS5 `'secure-delete'`) that contains recognized secrets or
 * device invitations, followed by outside-transaction `VACUUM` + `wal_checkpoint(TRUNCATE)`.
 */
export async function scrubBuiltinMemorySecrets(
  stateDir: string,
  redact: (text: string) => string,
  options: { isKnownSecret?: (text: string) => boolean } = {},
): Promise<{ deletedRows: number }> {
  const dbPath = path.join(stateDir, "memory.sqlite");
  const markerPath = path.join(stateDir, BUILTIN_MEMORY_REDACTION_PENDING_FILE);
  const hadPendingMarker = fs.existsSync(markerPath);
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {
    try { fs.rmSync(markerPath, { force: true }); } catch { /* ignore */ }
    return { deletedRows: 0 };
  }
  const database = new DatabaseSync(dbPath);
  let deletedRows = 0;
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA secure_delete = ON;");
    const integrity = database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok") throw new Error("Built-in memory storage integrity check failed");
    const hasMemories = Boolean(
      database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memories'").get(),
    );
    if (hasMemories) {
      const hasFts = Boolean(
        database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memories_fts'").get(),
      );
      if (hasFts) {
        try { database.exec("INSERT INTO memories_fts(memories_fts, rank) VALUES('secure-delete', 1);"); } catch { /* older sqlite */ }
      }
      const matchedIds: string[] = [];
      for (const row of database.prepare("SELECT id, content FROM memories").iterate() as Iterable<{ id: string; content: string }>) {
        const text = String(row.content ?? "");
        const hasSecret =
          redact(text) !== text ||
          redactSensitiveText(text) !== text ||
          redactDeviceInvitationText(text) !== text ||
          Boolean(options.isKnownSecret?.(text));
        if (hasSecret) matchedIds.push(String(row.id));
      }
      const needsCompact = matchedIds.length > 0 || hadPendingMarker;
      if (needsCompact && !hadPendingMarker) {
        fs.writeFileSync(markerPath, `${Date.now()}\n`, { mode: 0o600 });
      }
      if (matchedIds.length > 0 || (hasFts && hadPendingMarker)) {
        database.exec("BEGIN IMMEDIATE;");
        try {
          if (matchedIds.length > 0) {
            const del = database.prepare("DELETE FROM memories WHERE id = ?");
            const delFts = hasFts ? database.prepare("DELETE FROM memories_fts WHERE memory_id = ?") : null;
            for (const id of matchedIds) {
              del.run(id);
              delFts?.run(id);
            }
          }
          if (hasFts) {
            database.exec("DELETE FROM memories_fts WHERE memory_id NOT IN (SELECT id FROM memories)");
          }
          database.exec("COMMIT;");
          deletedRows = matchedIds.length;
        } catch (err) {
          try { database.exec("ROLLBACK;"); } catch { /* ignore */ }
          throw err;
        }
      }
      if (needsCompact) {
        database.exec("VACUUM;");
        database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      }
    }
  } finally {
    database.close();
  }
  try { fs.rmSync(markerPath, { force: true }); } catch { /* ignore */ }
  return { deletedRows };
}
