import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SubagentRecord, TicketRecord } from "@moco/protocol";
import { MocoStateDoc, type MocoDurableState } from "../packages/hub/src/state.js";
import { prepareStateStorage } from "../packages/hub/src/state-storage.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | unknown> = [];
const backupName = "backups/moco-before-state-v2.sqlite";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moco-state-migration-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function ticket(id: string, extra: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id, commandId: `command:${id}`, title: id, goal: "legacy goal", scope: "legacy scope", role: "coder",
    status: "blocked", envId: "legacy-device", workspaceDir: `/legacy/${id}`, scratchDir: `/scratch/${id}`,
    workerConversationId: 7, runEpoch: 5, createdAt: 10, updatedAt: 20,
    latestReport: { state: "blocked", summary: "需要确认", question: "可以继续吗？", at: 20 }, ...extra,
  };
}

function child(ticketId: string, extra: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: `${ticketId}:S1`, ticketId, name: "legacy-child", role: "scout", roleLabel: "临时工", readOnly: true,
    conversationId: 8, parentConversationId: 7, runs: 1, createdAt: 10, updatedAt: 20, ...extra,
  };
}

function state(...tickets: TicketRecord[]): MocoDurableState & JsonObject {
  return {
    nextTicketNumber: 17, tickets: Object.fromEntries(tickets.map((item) => [item.id, item])),
    commandIndex: { "command:T1": "T1" }, conversationToTicket: { "7": "T1" }, subagents: {},
    topics: { ordinary: { id: "ordinary", conversationId: 3, title: "原有话题", createdAt: 1, updatedAt: 2 } },
    slots: { holders: tickets.map((item) => item.id) },
  } as MocoDurableState & JsonObject;
}

function migrate(value: MocoDurableState & JsonObject) {
  return MocoStateDoc.definition.migrate!(value, 1) as MocoDurableState;
}

async function open(root: string) {
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(root, "moco.sqlite")), {
    models: createModels(), registry: createRegistry(),
  }, context);
  cleanups.push(() => harness.close(context));
  return harness;
}

async function seed(root: string, value = state(ticket("T1"))) {
  const legacy = defineDoc<MocoDurableState & JsonObject>({
    kind: "moco.state", version: 1, scope: "session", initial: () => structuredClone(value),
    checkpointWhen: () => true,
  });
  const harness = await open(root);
  await harness.commit(async (tx) => { await tx.doc(legacy); }, context);
  await harness.close(context);
  return legacy;
}

function marker(root: string): { version: number; backupFile?: string; preparedAt: number } {
  return JSON.parse(fs.readFileSync(path.join(root, "state-version.json"), "utf8"));
}

function storedVersion(filename: string): number {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return (db.prepare("SELECT MAX(version) AS version FROM document_revisions").get() as { version: number }).version;
  } finally { db.close(); }
}

function hash(filename: string) { return createHash("sha256").update(fs.readFileSync(filename)).digest("hex"); }

describe("Moco state version 2 migration", () => {
  it("migrates stopped blocked trees to durable user waits while preserving their execution snapshots", () => {
    const old = state(ticket("T1"), ticket("T2", { cleanupPending: true }));
    const finished = child("T1", { state: "ready", lastSummary: "已结束" });
    old.subagents![finished.id] = finished;
    const before = structuredClone(old);
    const migrated = migrate(old);
    expect(old).toEqual(before);
    expect(migrated.tickets.T1).toEqual({ ...before.tickets.T1, status: "waiting", waiting: { reason: "user", since: 20, detail: "可以继续吗？" } });
    expect(migrated.tickets.T2?.status).toBe("waiting");
    expect(migrated.slots.holders).toEqual([]);
    expect(migrated.slots.writeHolders).toEqual(["T2"]);
    expect(migrated.topics).toEqual(before.topics);
    expect(migrated.commandIndex).toEqual(before.commandIndex);
    expect(migrated.nextTicketNumber).toBe(17);
  });

  it.each([["running", undefined], [undefined, undefined], [undefined, "上一轮结果"]] as const)("retains or restores one parent slot for an active or unconfirmed legacy child (state=%s, summary=%s)", (childState, lastSummary) => {
    const old = state(ticket("T1"), ticket("T2"));
    const active = child("T2", { state: childState, lastSummary });
    old.subagents![active.id] = active;
    old.slots = { normalHolders: ["T1"], urgentHolders: [] } as unknown as MocoDurableState["slots"];
    const migrated = migrate(old);
    expect(migrated.tickets.T1?.status).toBe("waiting");
    expect(migrated.tickets.T2).toMatchObject({ status: "pausing", waiting: { reason: "user" }, envId: "legacy-device", workspaceDir: "/legacy/T2", runEpoch: 5 });
    expect(migrated.slots.holders).toEqual(["T2"]);
    expect(migrated.slots.writeHolders).toEqual(["T2"]);
    expect(migrated.subagents?.[active.id]).toEqual(active);
  });

  it("persists a v2 migration through Durable and rejects typed v1 reads and writes afterward", async () => {
    const root = directory();
    const legacy = await seed(root);
    await prepareStateStorage(root);
    const current = await open(root);
    await current.commit(async (tx) => { expect((await tx.doc(MocoStateDoc)).tickets.T1?.status).toBe("waiting"); }, context);
    await current.close(context);
    expect(storedVersion(path.join(root, "moco.sqlite"))).toBe(2);
    expect(storedVersion(path.join(root, backupName))).toBe(1);
    const oldProgram = await open(root);
    await expect(oldProgram.snapshot(legacy, context)).rejects.toThrow(/newer version 2 than 1/);
    await expect(oldProgram.commit(async (tx) => { (await tx.doc(legacy)).nextTicketNumber = 0; }, context)).rejects.toThrow(/newer version 2 than 1/);
    expect((await oldProgram.snapshot(MocoStateDoc, context))?.nextTicketNumber).toBe(17);
  });

  it("backs up committed WAL data consistently once before allowing the upgrade", async () => {
    const root = directory();
    await seed(root);
    const writer = new DatabaseSync(path.join(root, "moco.sqlite"));
    cleanups.push(() => writer.close());
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE wal_probe (value TEXT); INSERT INTO wal_probe VALUES ('before migration');");
    expect(fs.statSync(path.join(root, "moco.sqlite-wal")).size).toBeGreaterThan(32);
    await prepareStateStorage(root);
    expect(marker(root)).toMatchObject({ version: 2, backupFile: backupName });
    const firstMarker = fs.readFileSync(path.join(root, "state-version.json"), "utf8");
    const backupPath = path.join(root, backupName);
    const initialHash = hash(backupPath);
    const db = new DatabaseSync(backupPath, { readOnly: true });
    expect(db.prepare("SELECT value FROM wal_probe").get()).toMatchObject({ value: "before migration" });
    db.close();
    expect(storedVersion(backupPath)).toBe(1);
    expect(storedVersion(path.join(root, "moco.sqlite"))).toBe(1);
    writer.exec("INSERT INTO wal_probe VALUES ('after preparation');");
    await prepareStateStorage(root);
    expect(hash(backupPath)).toBe(initialHash);
    expect(fs.readFileSync(path.join(root, "state-version.json"), "utf8")).toBe(firstMarker);
    if (process.platform !== "win32") {
      expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(root, "state-version.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("reuses a completed pre-upgrade backup if the marker write was interrupted", async () => {
    const root = directory();
    await seed(root);
    fs.mkdirSync(path.join(root, "backups"));
    const source = new DatabaseSync(path.join(root, "moco.sqlite"));
    const backupPath = path.join(root, backupName);
    await backup(source, backupPath);
    const initialHash = hash(backupPath);
    source.exec("CREATE TABLE after_backup (value TEXT);");
    source.close();
    await prepareStateStorage(root);
    expect(hash(backupPath)).toBe(initialHash);
    expect(marker(root).backupFile).toBe(backupName);
  });

  it("refuses future versions from either marker or SQLite before writing anything", async () => {
    const futureMarker = directory();
    fs.writeFileSync(path.join(futureMarker, "state-version.json"), '{"version":3}');
    await expect(prepareStateStorage(futureMarker)).rejects.toThrow(/newer version 3 than 2/);
    expect(fs.readdirSync(futureMarker)).toEqual(["state-version.json"]);
    const futureDatabase = directory();
    await seed(futureDatabase);
    const db = new DatabaseSync(path.join(futureDatabase, "moco.sqlite"));
    db.exec("UPDATE document_revisions SET version = 3;");
    db.close();
    fs.writeFileSync(path.join(futureDatabase, "state-version.json"), '{"version":2,"preparedAt":0}');
    await expect(prepareStateStorage(futureDatabase)).rejects.toThrow(/newer version 3 than 2/);
    expect(fs.readFileSync(path.join(futureDatabase, "state-version.json"), "utf8")).toBe('{"version":2,"preparedAt":0}');
    expect(fs.existsSync(path.join(futureDatabase, "backups"))).toBe(false);
    expect(storedVersion(path.join(futureDatabase, "moco.sqlite"))).toBe(3);
  });

  it("does not mark the upgrade prepared if a completed backup is corrupt", async () => {
    const root = directory();
    await seed(root);
    fs.mkdirSync(path.join(root, "backups"));
    fs.writeFileSync(path.join(root, backupName), "incomplete backup");
    await expect(prepareStateStorage(root)).rejects.toThrow();
    expect(fs.existsSync(path.join(root, "state-version.json"))).toBe(false);
    expect(storedVersion(path.join(root, "moco.sqlite"))).toBe(1);
  });

  it("rejects a malformed version marker instead of silently bypassing the backup", async () => {
    const root = directory();
    await seed(root);
    fs.writeFileSync(path.join(root, "state-version.json"), '{"version":2,"preparedAt":0,"backupFile":true}');
    await expect(prepareStateStorage(root)).rejects.toThrow(/Invalid Moco state storage version marker/);
    expect(fs.existsSync(path.join(root, "backups"))).toBe(false);
    expect(storedVersion(path.join(root, "moco.sqlite"))).toBe(1);
  });

  it("initializes fresh storage without creating a database or a spurious backup", async () => {
    const root = path.join(directory(), "new-state");
    await prepareStateStorage(root);
    expect(marker(root)).toMatchObject({ version: 2 });
    expect(fs.readdirSync(root)).toEqual(["state-version.json"]);
    await prepareStateStorage(root);
    expect(fs.readdirSync(root)).toEqual(["state-version.json"]);
  });
});
