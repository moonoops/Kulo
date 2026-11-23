import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createRegistry, defineDoc, defineEntry, Harness, LiveDoc, MemoryStorage, ROOT_CONVERSATION_ID,
  type JsonObject, type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { formatDeviceChatInvitation, formatDeviceInstallerInstructions } from "@kulo/protocol";
import { KuloConnections } from "../packages/hub/src/connections.js";
import { ConnectionVaultError, LocalConnectionVault } from "../packages/hub/src/connection-vault.js";
import { KuloConversationHistory } from "../packages/hub/src/conversation-history.js";
import { KuloStateDoc, ensureDefaultRootTopic } from "../packages/hub/src/state.js";
import { KuloUserEntry } from "../packages/hub/src/ui-cards.js";
import {
  createCredentialRedactionExtension, redactCredentialData, scrubStoredConversationSecrets, wrapRedactedStorage,
} from "../packages/hub/src/credential-redaction.js";

const context = BACKGROUND_CONTEXT;
const secret = "sensitive-history-value-98451";
const redact = (text: string) => text.replaceAll(secret, "[已隐藏]");
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-history-redaction-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const NotesDoc = defineDoc<{ notes: string; password?: string } & JsonObject>({
  kind: "redaction-test-notes", version: 1, scope: "session", initial: () => ({ notes: "initial notes" }),
  checkpointWhen: () => false,
});
const UserEntry = defineEntry<{ text: string }>("redaction-test-user");
const SecretSettingsDoc = defineDoc<{
  model: { apiKey: string; defaultProvider: string };
  memory: { routerApiKey: string; workerApiKey: string; sharedReadApiKey: string };
  snapshots: Array<{ model: { apiKey: string } }>;
} & JsonObject>({
  kind: "kulo.settings", version: 1, scope: "session",
  initial: () => ({ model: { apiKey: "", defaultProvider: "openai" }, memory: { routerApiKey: "", workerApiKey: "", sharedReadApiKey: "" }, snapshots: [] }),
  checkpointWhen: () => false,
});

function sealing() {
  const values = new Map<string, Record<string, string>>();
  const known = new Set<string>();
  return {
    values,
    redact: (text: string) => [...known].reduce((value, item) => value.replaceAll(item, "[已隐藏]"), text),
    options: { vault: {
      get: async (ref: string) => values.get(ref),
      set: async (ref: string, fields: Record<string, string>) => { values.set(ref, structuredClone(fields)); },
    }, rememberSecrets: (secrets: readonly string[]) => { for (const value of secrets) known.add(value); } },
  };
}

async function open(storage: Storage) {
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
  cleanups.push(() => harness.close(context));
  await harness.root(context);
  return harness;
}

describe("credential-safe durable history", () => {
  it("redacts free text and named secrets while preserving identities, enum tags, and binary output", () => {
    const data = {
      type: "api_key", provider: "openai", role: "user", status: "running", connectionId: secret,
      text: `saved ${secret}`, details: { password: "opaque-unlabelled-value", refresh_token: secret, username: "admin" },
      credentialRefs: { routerApiKey: "memory-service:connect-standard:routerApiKey", workerApiKey: secret },
      bytes: new Uint8Array([1, 2]), secretFields: ["password", "apiKey"],
    };
    const next = redactCredentialData(data, redact);
    expect(next.text).toBe("saved [已隐藏]");
    expect(next.details).toEqual({ password: "[已隐藏]", refresh_token: "[已隐藏]", username: "admin" });
    expect(next.credentialRefs).toEqual({ routerApiKey: "memory-service:connect-standard:routerApiKey", workerApiKey: "[已隐藏]" });
    expect(next.type).toBe("api_key");
    expect(next.connectionId).toBe(secret);
    expect(next.bytes).toBe(data.bytes);
    expect(next.secretFields).toEqual(data.secretFields);
    expect(data.details.password).toBe("opaque-unlabelled-value");
  });

  it("filters committed entries on the actual backend and keeps storage methods bound to their owner", async () => {
    const backend = new MemoryStorage();
    const harness = await open(wrapRedactedStorage(backend, redact));
    await harness.commit(async (tx) => {
      await tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, {
        data: { text: `please remember ${secret}` },
        model: [{ role: "user", content: `please remember ${secret}`, timestamp: 1 }],
      });
    }, context);
    const entries = await backend.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, context);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(entries)).toContain("[已隐藏]");
  });

  it("does not let arbitrary custom credentials bypass filtering under protocol-like payload field names", () => {
    const arbitrary = Object.fromEntries(["id", "type", "kind", "role", "status", "state", "api", "provider", "modelId", "connectionId"].map((field) => [field, secret]));
    const value = {
      id: "entry-identity", type: "text", kind: "message", role: "user", status: "running",
      payload: { ...arbitrary, nested: [{ ...arbitrary }] }, data: arbitrary,
      structuredOutput: arbitrary, details: arbitrary,
      credentialRefs: { routerApiKey: "memory-service:existing-job:routerApiKey" },
    };
    const next = redactCredentialData(value, redact);
    for (const channel of ["payload", "data", "structuredOutput", "details"] as const) expect(JSON.stringify(next[channel])).not.toContain(secret);
    expect(next).toMatchObject({ id: "entry-identity", type: "text", kind: "message", role: "user", status: "running" });
    expect(next.credentialRefs).toEqual(value.credentialRefs);
  });

  it("filters custom field echoes in durable entry data and tool result channels", async () => {
    const backend = new MemoryStorage();
    const harness = await open(wrapRedactedStorage(backend, redact));
    const entry = defineEntry<{ id: string; status: string; details: Record<string, string> }>("custom-credential-echo");
    await harness.commit(async (tx) => { await tx.appendEntry(entry, ROOT_CONVERSATION_ID, { data: { id: secret, status: secret, details: { [secret]: "dynamic-key-echo" } } }); }, context);
    const stored = await backend.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, context);
    expect(JSON.stringify(stored)).not.toContain(secret);
    const extension = createCredentialRedactionExtension(redact);
    const generation = extension.hooks![0]!.handlers as { beforeProviderRequest: (input: unknown) => unknown };
    const tool = extension.hooks![1]!.handlers as { afterTool: (call: unknown, result: unknown) => unknown };
    expect(JSON.stringify(generation.beforeProviderRequest({ payload: { data: { id: secret, type: secret } } }))).not.toContain(secret);
    expect(JSON.stringify(tool.afterTool({}, { structuredOutput: { id: secret }, details: { status: secret } }))).not.toContain(secret);
  });

  it("redacts known secrets used as dynamic payload keys without renaming application data.text", () => {
    const value = {
      data: { text: "ordinary history text" },
      payload: { [secret]: { nested: true } },
      structuredOutput: { [secret]: "one", "[已隐藏]": "two" },
      details: { nested: [{ [secret]: "three" }] },
    };
    const next = redactCredentialData(value, redact);
    expect(next.data).toEqual(value.data);
    expect(JSON.stringify(next)).not.toContain(secret);
    expect(Object.values(next.structuredOutput)).toEqual(["one", "two"]);
  });

  it("refuses secret-bearing documents instead of changing immutable string deltas under Session caches", async () => {
    const harness = await open(wrapRedactedStorage(new MemoryStorage(), redact));
    await harness.commit(async (tx) => { await tx.doc(NotesDoc); }, context);
    await expect(harness.commit(async (tx) => {
      (await tx.doc(NotesDoc)).notes = secret;
    }, context)).rejects.toThrow("凭据不能写入普通状态记录");
  });

  it("detects a secret assembled across a delta and its existing document value", async () => {
    const backend = new MemoryStorage();
    const harness = await open(wrapRedactedStorage(backend, redact));
    await harness.commit(async (tx) => { (await tx.doc(NotesDoc)).notes = secret.slice(0, 10); }, context);
    await expect(harness.commit(async (tx) => {
      (await tx.doc(NotesDoc)).notes += secret.slice(10);
    }, context)).rejects.toThrow("凭据不能写入普通状态记录");
  });

  it("filters model requests, provider payloads, tool arguments and every returned result channel", async () => {
    const extension = createCredentialRedactionExtension(redact);
    const generation = extension.hooks![0]!.handlers as {
      beforeRequest: (request: unknown) => { messages: unknown };
      beforeProviderRequest: (request: unknown) => { payload: unknown };
    };
    const tools = extension.hooks![1]!.handlers as {
      beforeTool: (call: unknown) => { arguments: unknown };
      afterTool: (call: unknown, result: unknown) => unknown;
    };
    expect(JSON.stringify(generation.beforeRequest({ messages: [{ role: "user", content: secret }] }))).not.toContain(secret);
    expect(JSON.stringify(generation.beforeProviderRequest({ payload: { messages: [{ content: secret }] } }))).not.toContain(secret);
    expect(tools.beforeTool({ arguments: { command: `echo ${secret}`, id: "stable-id" } })).toEqual({ arguments: { command: "echo [已隐藏]", id: "stable-id" } });
    const result = tools.afterTool({}, {
      output: [{ type: "text", text: secret }], structuredOutput: { token: "opaque-token-value" },
      details: { error: secret }, diagnostics: [{ code: "known", message: secret }], isError: true,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("opaque-token-value");
    const compaction = extension.hooks![2]!.handlers as { beforeCompact: (input: unknown) => unknown };
    expect(compaction.beforeCompact({ messages: [{ role: "user", content: secret }] })).toEqual({ decline: true });
    expect(compaction.beforeCompact({ messages: [{ role: "user", content: "safe history" }] })).toBeUndefined();
  });

  it("scrubs legacy SQLite, WAL, migration backups and split document revisions without changing snapshots", async () => {
    const root = directory();
    const databasePath = path.join(root, "kulo.sqlite");
    const harness = await open(await openNodeSqliteStorage(databasePath));
    await harness.commit(async (tx) => {
      (await tx.doc(NotesDoc)).notes = `before ${secret.slice(0, 10)}`;
      await tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, { data: { text: `remember ${secret}` } });
    }, context);
    await harness.commit(async (tx) => { (await tx.doc(NotesDoc)).notes += secret.slice(10); }, context);
    await harness.commit(async (tx) => { (await tx.doc(NotesDoc)).notes += " preserved suffix"; }, context);
    await harness.close(context);

    fs.mkdirSync(path.join(root, "backups"));
    const backupPath = path.join(root, "backups/kulo-before-state-v2.sqlite");
    const writer = new DatabaseSync(databasePath);
    cleanups.push(() => writer.close());
    writer.exec("PRAGMA journal_mode=WAL");
    writer.prepare("UPDATE entries SET record = ? WHERE id = (SELECT MIN(id) FROM entries)").run(JSON.stringify({ id: 2, conversationId: 1, kind: "redaction-test-user", data: { text: `WAL ${secret}` } }));
    await backup(writer, backupPath);
    const beforeCount = (writer.prepare("SELECT COUNT(*) AS count FROM document_revisions").get() as { count: number }).count;
    const result = await scrubStoredConversationSecrets(root, redact);
    expect(result.databases).toBe(2);
    expect(result.rows).toBeGreaterThan(2);
    for (const filename of [databasePath, `${databasePath}-wal`, backupPath, `${backupPath}-wal`]) {
      if (fs.existsSync(filename)) expect(fs.readFileSync(filename).includes(Buffer.from(secret))).toBe(false);
    }
    expect((writer.prepare("SELECT COUNT(*) AS count FROM document_revisions").get() as { count: number }).count).toBe(beforeCount);
    const reopened = await open(await openNodeSqliteStorage(databasePath));
    expect((await reopened.snapshot(NotesDoc, context))?.notes).toBe("before [已隐藏] preserved suffix");
    expect((writer.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check).toBe("ok");
    expect(await scrubStoredConversationSecrets(root, redact)).toEqual({ databases: 2, rows: 0 });
  });

  it("fails closed for corrupt history without exposing its diagnostic content", async () => {
    const root = directory();
    fs.writeFileSync(path.join(root, "kulo.sqlite"), secret);
    const failure = await scrubStoredConversationSecrets(root, redact).catch((error: unknown) => error) as Error & { code: string };
    expect(failure.code).toBe("credential_history_unavailable");
    expect(failure.message).not.toContain(secret);
  });

  it("removes legacy and quoted invites from an existing chat, backups and search, then handles the next model turn", async () => {
    const stateDir = directory();
    const filename = path.join(stateDir, "kulo.sqlite");
    const hubUrl = "https://brain.example.test";
    const legacy = "Old-Device-Invitation-Fixture-00000000001";
    const quoted = "New-Device-Invitation-Fixture-00000000002";
    const streamed = "Streamed-Invitation-Fixture-00000000003";
    const encodedEcho = Buffer.from(legacy).toString("base64");
    const command = formatDeviceInstallerInstructions({ hubUrl, inviteToken: legacy }).agentInstructions;
    const invitation = formatDeviceChatInvitation({ hubUrl, inviteToken: quoted, hubId: "unit-hub", hubName: "测试主机" });
    const provider = fauxProvider({ provider: "history-fixture", models: [{ id: "test" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const vault = new LocalConnectionVault({ stateDir, keyStore: { getOrCreateKey: async () => Buffer.alloc(32, 7) } });
    const manager = new KuloConnections({ stateDir, vault });
    await manager.initialize();
    const redactText = (text: string) => manager.redact(text);
    const options = {
      vault,
      rememberSecrets: (values: readonly string[]) => manager.rememberSecrets(values),
      isKnownSecret: (text: string) => manager.containsKnownSecret(text),
      processUserText: vi.fn((text: string, requestId: string) => manager.processText(text, { requestId })),
    };
    const openChat = async (clean: boolean) => {
      const backend = await openNodeSqliteStorage(filename);
      const harness = await Harness.open(clean ? wrapRedactedStorage(backend, redactText, options) : backend,
        { models, registry: createRegistry(), settings: { compaction: { enabled: false } } }, context);
      cleanups.push(() => harness.close(context));
      const chat = await harness.root(context, { agent: { model: { provider: "history-fixture", modelId: "test" } } });
      return { harness, chat };
    };
    const original = await openChat(false);
    for (const text of [command, `分析这条邀请：\n${invitation}`, `请保存 token=${quoted}`, `请保存 token=${streamed}`]) {
      await (await original.chat.submit({ type: "write", entry: { kind: KuloUserEntry.kind,
        data: { kuloContentVersion: 1, text, attachments: [] }, model: [{ role: "user", content: text, timestamp: 1 }],
      } }, context)).wait(context);
    }
    await original.harness.commit(async (tx) => {
      ensureDefaultRootTopic(await tx.doc(KuloStateDoc));
      (await tx.doc(NotesDoc)).notes = `KULO-JOIN/9 ${hubUrl} ${streamed.slice(0, 12)}`;
      (await tx.doc(SecretSettingsDoc)).model.apiKey = legacy;
      (await tx.doc(LiveDoc, ROOT_CONVERSATION_ID)).tools = [{ callId: "unit-call", name: "fixture", status: "done", output: `echo ${encodedEcho}` }];
    }, context);
    await original.harness.commit(async (tx) => {
      (await tx.doc(NotesDoc)).notes += streamed.slice(12);
      (await tx.doc(LiveDoc, ROOT_CONVERSATION_ID)).tools![0]!.output! += ` / ${quoted}`;
    }, context);
    const oldIndex = new KuloConversationHistory({ harness: original.harness, stateDir });
    expect((await oldIndex.search(Number(original.chat.id), { query: legacy })).matches).toHaveLength(1);
    await oldIndex.close();
    const indexFile = path.join(stateDir, "conversation-history.sqlite");
    const db = new DatabaseSync(indexFile);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    db.exec("DROP TABLE history_maintenance");
    db.close();
    await original.harness.close(context);
    fs.mkdirSync(path.join(stateDir, "backups"));
    const backupFile = path.join(stateDir, "backups/kulo-before-state-v2.sqlite");
    fs.copyFileSync(filename, backupFile);

    expect((await scrubStoredConversationSecrets(stateDir, redactText, options)).rows).toBeGreaterThan(0);
    expect(options.processUserText).not.toHaveBeenCalled();
    expect((await manager.snapshot()).connections).toEqual([]);
    expect(await vault.refs()).toEqual([]);
    for (const file of [filename, backupFile]) {
      const bytes = fs.readFileSync(file);
      for (const token of [legacy, quoted, streamed, encodedEcho]) expect(bytes.includes(Buffer.from(token))).toBe(false);
    }
    expect((await scrubStoredConversationSecrets(stateDir, redactText, options)).rows).toBe(0);
    const { harness, chat } = await openChat(true);
    expect((await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.tools?.[0]?.output).toBe("echo [已隐藏] / [已隐藏]");
    expect((await harness.snapshot(NotesDoc, context))?.notes).toBe(`KULO-JOIN/9 ${hubUrl} [已隐藏]`);
    expect((await harness.snapshot(SecretSettingsDoc, context))?.model.apiKey).toBe("");
    const history = new KuloConversationHistory({ harness, stateDir });
    cleanups.push(() => history.close());
    expect((await history.search(Number(chat.id), { query: quoted })).matches).toHaveLength(0);
    expect((await history.search(Number(chat.id), { query: "分析这条邀请" })).matches).toHaveLength(1);
    for (const file of [indexFile, indexFile + "-wal"]) {
      if (!fs.existsSync(file)) continue;
      for (const token of [legacy, quoted]) expect(fs.readFileSync(file).includes(Buffer.from(token.toLowerCase()))).toBe(false);
    }
    const response = vi.fn((input: TranscriptContext) => {
      const modelInput = JSON.stringify(input.messages);
      expect(modelInput).toContain("分析这条邀请");
      expect(modelInput).toContain("[已隐藏]");
      for (const token of [legacy, quoted, streamed]) expect(modelInput).not.toContain(token);
      return fauxAssistantMessage([fauxText("可以继续对话。")]);
    });
    provider.setResponses([response]);
    await (await chat.submit({ type: "input", content: "继续聊天。" }, context)).wait(context);
    await chat.waitForIdle(context);
    expect(response).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((await chat.entries({}, 10, undefined, context)).items)).toContain("可以继续对话。");
  });

  it("invalidates a previously cleaned v1 search index after an older client adds an invite and retries interrupted cleanup", async () => {
    const stateDir = directory();
    const harness = await open(new MemoryStorage());
    await new KuloConversationHistory({ stateDir, harness }).close();
    const indexFile = path.join(stateDir, "conversation-history.sqlite");
    const token = "Rollback-Invitation-Fixture-00000000007";
    const invite = formatDeviceChatInvitation({ hubUrl: "https://rollback.example.test", inviteToken: token, hubId: "unit", hubName: "测试主机" });
    const oldWriter = new DatabaseSync(indexFile);
    expect(oldWriter.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(oldWriter.prepare("SELECT name FROM history_maintenance").get()).toBeTruthy();
    oldWriter.prepare("INSERT INTO history_entries(conversation_id, entry_id, created_at, normalized) VALUES (1, 2, 0, ?)").run(invite.toLowerCase());
    oldWriter.exec("INSERT INTO history_cursors(conversation_id,entry_id) VALUES (1,2)");
    oldWriter.close();
    const oldDurable = new DatabaseSync(path.join(stateDir, "kulo.sqlite"));
    oldDurable.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
    oldDurable.prepare("INSERT INTO entries VALUES (2,?)").run(JSON.stringify({ conversationId: 1, kind: "pi.user", model: [{ role: "user", content: invite }] }));
    oldDurable.close();

    expect((await scrubStoredConversationSecrets(stateDir, (text) => text)).rows).toBe(1);
    expect((await scrubStoredConversationSecrets(stateDir, (text) => text)).rows).toBe(0);
    const prepare = DatabaseSync.prototype.prepare;
    const interrupted = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA wal_checkpoint(TRUNCATE)") throw new Error("interrupted WAL cleanup");
      return prepare.call(this, sql);
    });
    try { expect(() => new KuloConversationHistory({ stateDir, harness })).toThrow("interrupted WAL cleanup"); }
    finally { interrupted.mockRestore(); }
    const pending = new DatabaseSync(indexFile);
    expect(pending.prepare("SELECT name FROM history_maintenance").get()).toBeUndefined();
    pending.close();
    await new KuloConversationHistory({ stateDir, harness }).close();
    const cleaned = new DatabaseSync(indexFile);
    expect(cleaned.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(cleaned.prepare("SELECT name FROM history_maintenance").get()).toBeTruthy();
    expect(cleaned.prepare("SELECT 1 FROM history_entries").get()).toBeUndefined();
    expect(cleaned.prepare("SELECT 1 FROM history_cursors").get()).toBeUndefined();
    cleaned.close();
    expect(fs.readFileSync(indexFile).includes(Buffer.from(token.toLowerCase()))).toBe(false);
  });

  it("retries physical cleanup after a crash between logical redaction and VACUUM", async () => {
    const root = directory();
    const filename = path.join(root, "kulo.sqlite");
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
    db.prepare("INSERT INTO entries VALUES (1, ?)").run(JSON.stringify({ text: secret }));
    db.close();
    const execute = DatabaseSync.prototype.exec;
    const first = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "VACUUM") throw new Error("interrupted compaction");
      return execute.call(this, sql);
    });
    try {
      await expect(scrubStoredConversationSecrets(root, redact)).rejects.toMatchObject({ code: "credential_history_unavailable" });
    } finally { first.mockRestore(); }
    expect(fs.existsSync(`${filename}.redaction-pending`)).toBe(true);
    const retry = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      expect(await scrubStoredConversationSecrets(root, redact)).toEqual({ databases: 1, rows: 0 });
      expect(retry.mock.calls.some(([sql]) => sql === "VACUUM")).toBe(true);
    } finally { retry.mockRestore(); }
    expect(fs.existsSync(`${filename}.redaction-pending`)).toBe(false);
  });

  it("scrubs SQLite backup files left under the exact migration temporary name after a crash", async () => {
    const root = directory();
    const filename = path.join(root, "kulo.sqlite");
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
    db.prepare("INSERT INTO entries VALUES (1, ?)").run(JSON.stringify({ text: secret }));
    db.close();
    fs.mkdirSync(path.join(root, "backups"));
    const leftover = path.join(root, "backups/kulo-before-state-v2.sqlite.91fdc9cd-501b-4c63-9d26-5c128c99ea40.tmp");
    const leftoverV3 = path.join(root, "backups/kulo-before-state-v3.sqlite.91fdc9cd-501b-4c63-9d26-5c128c99ea41.tmp");
    fs.copyFileSync(filename, leftover);
    fs.copyFileSync(filename, leftoverV3);
    expect(await scrubStoredConversationSecrets(root, redact)).toEqual({ databases: 3, rows: 3 });
    expect(fs.readFileSync(leftover).includes(Buffer.from(secret))).toBe(false);
    expect(fs.readFileSync(leftoverV3).includes(Buffer.from(secret))).toBe(false);
    const verified = new DatabaseSync(leftover, { readOnly: true });
    expect((verified.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check).toBe("ok");
    verified.close();
  });

  it("rejects migration backup symlinks without touching files outside the state directory", async () => {
    const root = directory();
    const external = directory();
    const filename = path.join(external, "external.sqlite");
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
    db.prepare("INSERT INTO entries VALUES (1, ?)").run(JSON.stringify({ text: secret }));
    db.close();
    fs.mkdirSync(path.join(root, "backups"));
    fs.symlinkSync(filename, path.join(root, "backups/kulo-before-state-v2.sqlite.91fdc9cd-501b-4c63-9d26-5c128c99ea40.tmp"));
    await expect(scrubStoredConversationSecrets(root, redact)).rejects.toMatchObject({ code: "credential_history_unavailable" });
    expect(fs.readFileSync(filename).includes(Buffer.from(secret))).toBe(true);
  });

  it("fails before modifying history while another writer owns the database", async () => {
    const root = directory();
    const db = new DatabaseSync(path.join(root, "kulo.sqlite"));
    cleanups.push(() => db.close());
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
    db.prepare("INSERT INTO entries VALUES (1, ?)").run(JSON.stringify({ text: secret }));
    db.exec("BEGIN EXCLUSIVE");
    await expect(scrubStoredConversationSecrets(root, redact)).rejects.toMatchObject({ code: "credential_history_unavailable" });
    db.exec("ROLLBACK");
    expect(JSON.stringify(db.prepare("SELECT record FROM entries").get())).toContain(secret);
  });

  it("does not forward a raw redaction error into a partially written batch", async () => {
    const backend = { commit: vi.fn(), document: vi.fn() } as unknown as Storage;
    const wrapped = wrapRedactedStorage(backend, () => { throw new Error("redactor unavailable"); });
    await expect(wrapped.commit([[{ type: "entry", value: { id: 2, conversationId: 1, kind: "test", data: { text: secret } } }]] as never, () => {}, context)).rejects.toThrow("redactor unavailable");
    expect(backend.commit).not.toHaveBeenCalled();
  });

  it("seals runtime model and memory credentials while keeping original settings values and deltas usable", async () => {
    const root = directory();
    const filename = path.join(root, "kulo.sqlite");
    const sealed = sealing();
    const backend = await openNodeSqliteStorage(filename);
    const harness = await open(wrapRedactedStorage(backend, sealed.redact, sealed.options));
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SecretSettingsDoc);
      doc.model.apiKey = "model-credential-value-92531";
      doc.memory.routerApiKey = "router-credential-value-92531";
      doc.memory.workerApiKey = "worker-credential-value-92531";
      doc.memory.sharedReadApiKey = "shared-credential-value-92531";
      doc.snapshots.push({ model: { apiKey: doc.model.apiKey } });
    }, context);
    await harness.commit(async (tx) => { (await tx.doc(SecretSettingsDoc)).model.apiKey += "-rotated"; }, context);
    expect(new Set([...sealed.values.values()].map((fields) => fields.value)).size).toBe(sealed.values.size);
    const credentialCount = sealed.values.size;
    await harness.commit(async (tx) => { (await tx.doc(SecretSettingsDoc)).model.defaultProvider = "openrouter"; }, context);
    expect(sealed.values.size).toBe(credentialCount);
    const runtime = (await harness.snapshot(SecretSettingsDoc, context))!;
    expect(runtime.model.apiKey).toBe("model-credential-value-92531-rotated");
    expect(runtime.snapshots[0]?.model.apiKey).toBe("model-credential-value-92531");
    await harness.close(context);
    const bytes = fs.readFileSync(filename);
    for (const value of ["model-credential-value-92531", ...Object.values(runtime.memory)]) expect(bytes.includes(Buffer.from(value))).toBe(false);
    expect(bytes.includes(Buffer.from("kulo-secret:durable-secret:"))).toBe(true);
    const reopened = await open(wrapRedactedStorage(await openNodeSqliteStorage(filename), sealed.redact, sealed.options));
    expect(await reopened.snapshot(SecretSettingsDoc, context)).toEqual(runtime);
    await reopened.commit(async (tx) => { (await tx.doc(SecretSettingsDoc)).memory.workerApiKey += "-after-restart"; }, context);
    expect((await reopened.snapshot(SecretSettingsDoc, context))?.memory.workerApiKey).toBe("worker-credential-value-92531-after-restart");
  });

  it("migrates legacy settings credentials and snapshots into the vault before scrubbing unlabelled historical copies", async () => {
    const root = directory();
    const filename = path.join(root, "kulo.sqlite");
    const harness = await open(await openNodeSqliteStorage(filename));
    const value = "legacy-config-value-unique-46982";
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SecretSettingsDoc);
      doc.model.apiKey = value;
      doc.memory.routerApiKey = `${value}-router`;
      doc.snapshots.push({ model: { apiKey: value } });
      await tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, { data: { text: `An unlabelled previous echo: ${value}` } });
    }, context);
    await harness.commit(async (tx) => { (await tx.doc(SecretSettingsDoc)).model.apiKey += "-rotated"; }, context);
    const expected = await harness.snapshot(SecretSettingsDoc, context);
    await harness.close(context);
    fs.mkdirSync(path.join(root, "backups"));
    const backupPath = path.join(root, "backups/kulo-before-state-v2.sqlite");
    fs.copyFileSync(filename, backupPath);
    const sealed = sealing();
    await scrubStoredConversationSecrets(root, sealed.redact, sealed.options);
    expect(sealed.values.size).toBeGreaterThan(1);
    for (const file of [filename, backupPath]) expect(fs.readFileSync(file).includes(Buffer.from(value))).toBe(false);
    const reopened = await open(wrapRedactedStorage(await openNodeSqliteStorage(filename), sealed.redact, sealed.options));
    expect(await reopened.snapshot(SecretSettingsDoc, context)).toEqual(expected);
    const entries = await reopened.root(context);
    expect(JSON.stringify((await entries.watch(context, { min: 1, max: 20 })).value)).not.toContain(value);
  });

  it("fails closed when a sealed runtime credential is missing from its vault", async () => {
    const root = directory();
    const filename = path.join(root, "kulo.sqlite");
    const sealed = sealing();
    const harness = await open(wrapRedactedStorage(await openNodeSqliteStorage(filename), sealed.redact, sealed.options));
    await harness.commit(async (tx) => { (await tx.doc(SecretSettingsDoc)).model.apiKey = secret; }, context);
    await harness.close(context);
    sealed.values.clear();
    await expect(scrubStoredConversationSecrets(root, sealed.redact, sealed.options)).rejects.toMatchObject({ code: "credential_history_unavailable" });
    expect(fs.readFileSync(filename).includes(Buffer.from(secret))).toBe(false);
  });

  it("archives previously unknown requested credentials before scrubbing user history and migration backups", async () => {
    const root = directory();
    const filename = path.join(root, "kulo.sqlite");
    const values = ["legacy-tenant-72594", "legacy-sign-seed-72915", "legacy-exchange-ticket-20185"];
    const oneTime = "unit-ephemeral-device-invitation-0007";
    const invite = formatDeviceChatInvitation({ hubUrl: "https://node.example.test", inviteToken: oneTime, hubId: "unit", hubName: "测试主机" });
    const content = `请保存这组「星云网关」凭据：\n凭据类型：自定义签名\n租户代号=${values[0]}\n签名种子=${values[1]}\n交换票据=${values[2]}\n\n另有一条设备邀请：\n${invite}`;
    const archived = content.replace(oneTime, "[已隐藏]");
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO entries VALUES (?, ?)");
    insert.run(2, JSON.stringify({ id: 2, conversationId: 1, kind: "kulo.user", data: { text: content, kuloContentVersion: 1, attachments: [] }, model: [{ role: "user", content }] }));
    insert.run(3, JSON.stringify({ id: 3, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: `不要保存，凭据：${values[0]}` }] }));
    insert.run(4, JSON.stringify({ id: 4, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content }] }));
    db.close();
    fs.mkdirSync(path.join(root, "backups"));
    const backupPath = path.join(root, "backups/kulo-before-state-v2.sqlite");
    fs.copyFileSync(filename, backupPath);
    const originalBackup = fs.readFileSync(backupPath);
    const vault = new LocalConnectionVault({ stateDir: root, keyStore: { getOrCreateKey: async () => Buffer.alloc(32, 7) } });
    const manager = new KuloConnections({ stateDir: root, vault });
    await manager.initialize();
    const processUserText = vi.fn(async (text: string, requestId: string) => {
      // No history has been rewritten, and no SQLite transaction spans the vault operation.
      for (const file of [filename, backupPath]) expect(fs.readFileSync(file).includes(Buffer.from(values[0]!))).toBe(true);
      const independent = new DatabaseSync(filename);
      independent.exec("BEGIN EXCLUSIVE; COMMIT"); independent.close();
      return manager.processText(text, { requestId });
    });
    const options = { processUserText };
    await scrubStoredConversationSecrets(root, (text) => manager.redact(text), options);
    expect(processUserText).toHaveBeenCalledTimes(1);
    expect(processUserText).toHaveBeenCalledWith(archived, "history:1:2");
    const cards = (await manager.snapshot()).connections;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "custom", status: "saved", hasCredential: true });
    const stored = await vault.get(`connection:${cards[0]!.id}`);
    expect(JSON.stringify(stored)).not.toContain(oneTime);
    for (const value of values) {
      expect(Object.values(stored!)).toContain(value);
      for (const file of [filename, backupPath]) expect(fs.readFileSync(file).includes(Buffer.from(value))).toBe(false);
    }
    processUserText.mockClear();
    await scrubStoredConversationSecrets(root, (text) => manager.redact(text), options);
    expect(processUserText).not.toHaveBeenCalled();
    expect((await manager.snapshot()).connections).toHaveLength(1);
    // A crash can leave a raw backup after its main database has already been cleaned.
    fs.writeFileSync(backupPath, originalBackup);
    const restored = new KuloConnections({ stateDir: root, vault: new LocalConnectionVault({ stateDir: root, keyStore: { getOrCreateKey: async () => Buffer.alloc(32, 7) } }) });
    await restored.initialize();
    const retry = vi.fn((text: string, requestId: string) => restored.processText(text, { requestId }));
    await scrubStoredConversationSecrets(root, (text) => restored.redact(text), { processUserText: retry });
    expect(retry).toHaveBeenCalledWith(archived, "history:1:2");
    expect((await restored.snapshot()).connections).toHaveLength(1);
    for (const value of values) expect(fs.readFileSync(backupPath).includes(Buffer.from(value))).toBe(false);
  });

  it("keeps all original history recoverable when archival of requested credentials fails", async () => {
    const root = directory();
    const filename = path.join(root, "kulo.sqlite");
    const content = `请保存星云会话凭据：\n会话票据=${secret}\n校验材料=legacy-validation-value-93518`;
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
    db.prepare("INSERT INTO entries VALUES (2, ?)").run(JSON.stringify({ id: 2, conversationId: 1, kind: "pi.user", model: [{ role: "user", content }] }));
    db.close();
    fs.mkdirSync(path.join(root, "backups"));
    const backupPath = path.join(root, "backups/kulo-before-state-v2.sqlite");
    fs.copyFileSync(filename, backupPath);
    const originals = [filename, backupPath].map((file) => fs.readFileSync(file));
    const vault = new LocalConnectionVault({ stateDir: root, keyStore: { getOrCreateKey: async () => { throw new ConnectionVaultError("connection_vault_locked"); } } });
    const manager = new KuloConnections({ stateDir: root, vault });
    await manager.initialize();
    await expect(scrubStoredConversationSecrets(root, (text) => manager.redact(text), {
      processUserText: (text, requestId) => manager.processText(text, { requestId }),
    })).rejects.toMatchObject({ code: "credential_history_unavailable" });
    for (const [index, file] of [filename, backupPath].entries()) expect(fs.readFileSync(file)).toEqual(originals[index]);
    expect((await manager.snapshot()).connections).toEqual([]);
    expect(fs.existsSync(`${filename}.redaction-pending`)).toBe(false);
  });

  it("redacts multi-delta streaming updates on pi.live without failing the Session or corrupting deltas", async () => {
    const root = directory();
    const filename = path.join(root, "kulo.sqlite");
    const backend = await openNodeSqliteStorage(filename);
    const harness = await open(wrapRedactedStorage(backend, redact));
    await harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      live.tools = [{ callId: "call-1", name: "bash", status: "running", output: `first chunk ${secret}` }];
    }, context);
    await harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      live.tools![0]!.output! += " and second chunk";
    }, context);
    await harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      live.tools = [{ callId: "call-1", name: "bash", status: "done", output: "cleared clean state" }];
    }, context);
    await harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      live.tools![0]!.output! += " after clear";
    }, context);
    expect((await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.tools).toEqual([
      { callId: "call-1", name: "bash", status: "done", output: "cleared clean state after clear" },
    ]);
    await harness.close(context);
    expect(fs.readFileSync(filename).includes(Buffer.from(secret))).toBe(false);
  });

  it("preserves valid Google base64 thought signatures while still rejecting known credentials", () => {
    const known = "known-vertex-credential-value-88712";
    const thoughtSig = Buffer.from("prefix+hf_ABCDEFGHIJKLMNOPQRST/sk-12345678901234567890==").toString("base64");
    const sigWithPattern = `AA+hf_ABCDEFGHIJKLMNOPQRST/sk_live_1234567890ABCDEF==`.padEnd(64, "A");
    const validBase64 = sigWithPattern.replace(/_/g, "a");
    // Construct a valid base64 string (% 4 === 0) that literally contains `/hf_ABCDEFGHIJKLMNOP` or `+sk-`:
    // Note base64 alphabet is A-Z, a-z, 0-9, +, /, =. Pattern /\bBSA[A-Za-z0-9_-]{16,}/ matches `+BSAA...`!
    const bsaCollision = `+BSA${"A".repeat(20)}`.padEnd(28, "B");
    const googleMessage = {
      role: "assistant",
      api: "google-vertex",
      provider: "api-google-vertex",
      model: "gemini-4-hydrogen",
      content: [
        { type: "thinking", thinking: `plan mentioning ${known}`, thinkingSignature: bsaCollision },
        { type: "text", text: "safe answer", textSignature: bsaCollision },
        { type: "toolCall", id: "c1", name: "bash", arguments: { cmd: `echo ${known}` }, thoughtSignature: bsaCollision },
      ],
    };
    const isKnownSecret = (value: string) => value.includes(known);
    const redactFn = (value: string) => value.replaceAll(known, "[已隐藏]").replace(/\bBSA[A-Za-z0-9_-]{16,}/g, "[已隐藏]");
    expect(redactFn(bsaCollision)).not.toBe(bsaCollision);
    expect(thoughtSig.length).toBeGreaterThan(0);
    expect(validBase64.length).toBe(64);

    const filtered = redactCredentialData([googleMessage], redactFn, { nativeContent: "messages", isKnownSecret });
    expect(filtered[0]!.content[0]).toEqual({ type: "thinking", thinking: "plan mentioning [已隐藏]", thinkingSignature: bsaCollision });
    expect(filtered[0]!.content[1]).toEqual({ type: "text", text: "safe answer", textSignature: bsaCollision });
    expect(filtered[0]!.content[2]).toEqual({ type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "echo [已隐藏]" }, thoughtSignature: bsaCollision });

    const wire = redactCredentialData({
      contents: [{ role: "model", parts: [{ text: `reply ${known}`, thoughtSignature: bsaCollision }] }],
    }, redactFn, { nativeContent: "wire", isKnownSecret });
    expect(wire.contents[0]!.parts[0]).toEqual({ text: "reply [已隐藏]", thoughtSignature: bsaCollision });

    const leaked = Buffer.from(known).toString("base64");
    expect(() => redactCredentialData([{
      ...googleMessage,
      content: [{ type: "text", text: "ok", textSignature: leaked }],
    }], redactFn, { nativeContent: "messages", isKnownSecret: (v) => v.includes(leaked) })).toThrow("凭据不能写入普通状态");
  });
});
