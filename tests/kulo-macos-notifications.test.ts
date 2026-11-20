import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractNotificationPlist,
  MacOsNotificationSensor,
  parseBinaryPlist,
} from "../packages/env/src/index.js";
import type { ConnectorEventBatch, ConnectorSourceStatus } from "@kulo/protocol";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-macos-notif-"));
  tmpRoots.push(dir);
  return dir;
}

function makeBplist(obj: Record<string, unknown>): Buffer {
  // Use macOS native plutil when available so tests verify real Apple bplist00 encoding.
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/plutil")) {
    const res = spawnSync("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", "--", "-"], {
      input: JSON.stringify(obj),
      maxBuffer: 1024 * 1024,
    });
    if (res.status === 0 && Buffer.isBuffer(res.stdout) && res.stdout.length >= 40) {
      return res.stdout;
    }
  }
  throw new Error("plutil unavailable on this platform");
}

function createSyntheticUsernotedDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE app (app_id INTEGER PRIMARY KEY, identifier TEXT NOT NULL);
    CREATE TABLE record (
      rec_id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL,
      delivered_date REAL,
      data BLOB NOT NULL
    );
  `);
  return db;
}

function insertNotification(
  db: DatabaseSync,
  appIdentifier: string,
  payload: { title?: string; subtitle?: string; body?: string; thread?: string; app?: string },
  deliveredDateSec = 785_000_000,
): number {
  let appRow = db.prepare("SELECT app_id FROM app WHERE identifier = ?").get(appIdentifier) as { app_id?: number } | undefined;
  if (!appRow?.app_id) {
    const inserted = db.prepare("INSERT INTO app (identifier) VALUES (?)").run(appIdentifier);
    appRow = { app_id: Number(inserted.lastInsertRowid) };
  }
  const plistObj: Record<string, unknown> = {
    app: payload.app ?? appIdentifier,
    req: {
      ...(payload.title !== undefined ? { titl: payload.title } : {}),
      ...(payload.subtitle !== undefined ? { subt: payload.subtitle } : {}),
      ...(payload.body !== undefined ? { body: payload.body } : {}),
      ...(payload.thread !== undefined ? { thrd: payload.thread } : {}),
    },
  };
  const blob = makeBplist(plistObj);
  const res = db.prepare("INSERT INTO record (app_id, delivered_date, data) VALUES (?, ?, ?)").run(
    appRow.app_id,
    deliveredDateSec,
    blob,
  );
  return Number(res.lastInsertRowid);
}

describe.skipIf(process.platform !== "darwin")("macOS notification center sensor & bplist00 parser", () => {
  it("parses Apple bplist00 with UTF-16 Chinese text and rejects malformed/oversized blobs safely", () => {
    const blob = makeBplist({
      app: "com.tencent.xinWeChat",
      req: {
        titl: "产品研发群",
        subt: "张三",
        body: "明天上午十点开评审会，请准备原型链接",
        thrd: "chat_12345",
      },
    });
    const parsed = extractNotificationPlist(new Uint8Array(blob));
    expect(parsed).toMatchObject({
      appId: "com.tencent.xinWeChat",
      title: "产品研发群",
      subtitle: "张三",
      body: "明天上午十点开评审会，请准备原型链接",
      threadId: "chat_12345",
    });
    expect(() => parseBinaryPlist(new Uint8Array(10))).toThrow("bplist_invalid_size");
    expect(() => parseBinaryPlist(new Uint8Array(300 * 1024))).toThrow("bplist_invalid_size");
    expect(extractNotificationPlist(new Uint8Array(Buffer.from("not-a-plist-at-all-padding-padding-padding-padding")))).toBeNull();
  });

  it("sets initial baseline at MAX(rec_id), reads WAL inserts consistently, drops OTP & password managers at edge, and advances cursor only after ACK", async () => {
    const root = makeRoot();
    const dbPath = path.join(root, "db2", "db");
    const privateDir = path.join(root, ".kulo-env");
    const db = createSyntheticUsernotedDb(dbPath);
    try {
      // Pre-existing historical notification must NOT flood on initial enable.
      insertNotification(db, "com.tencent.xinWeChat", { title: "老消息", body: "三天前的旧通知" });

      const statuses: ConnectorSourceStatus[] = [];
      const batches: ConnectorEventBatch[] = [];
      const sensor = new MacOsNotificationSensor({
        envId: "local",
        envName: "Test Mac",
        privateDir,
        databasePath: dbPath,
        pollIntervalMs: 60_000,
        onStatus: (s) => statuses.push(s),
        onBatch: (b) => batches.push(b),
      });
      sensor.setHubIdentity("hub-A");
      sensor.configure({ driverId: "macos-notifications", enabled: true, mutedApps: ["com.example.muted"] });
      await new Promise((r) => setTimeout(r, 80));

      expect(sensor.status.permission).toBe("granted");
      expect(batches).toHaveLength(0);

      // Insert live WAL notifications (not checkpointed!):
      // 1) OTP -> must be dropped at edge
      insertNotification(db, "com.apple.MobileSMS", { title: "10690000", body: "您的验证码是 482910，5分钟内有效" });
      // 2) Password manager -> must be dropped at edge
      insertNotification(db, "com.1password.1password", { title: "1Password", body: "Secret vault unlocked" });
      // 3) Muted app -> must be dropped at edge
      insertNotification(db, "com.example.muted", { title: "Promo", body: "Buy now" });
      // 4) Real WeChat message -> must be emitted
      const validId = insertNotification(db, "com.tencent.xinWeChat", {
        title: "李总",
        body: "合同终稿我刚发你邮箱了，今天下班前确认一下",
        thread: "wx-lizong",
      });

      await sensor.scanNow();
      expect(batches).toHaveLength(1);
      expect(batches[0]!.events).toHaveLength(1);
      expect(batches[0]!.events[0]).toMatchObject({
        nativeEventId: String(validId),
        appId: "com.tencent.xinWeChat",
        appLabel: "微信",
        title: "李总",
        body: "合同终稿我刚发你邮箱了，今天下班前确认一下",
        threadHint: "wx-lizong",
      });

      // Stop-and-wait: inserting another message before ACK must NOT emit a second concurrent batch.
      const secondId = insertNotification(db, "com.tencent.qq", { title: "技术群", body: "测试环境打包好了" });
      await sensor.scanNow();
      expect(batches).toHaveLength(1);

      // ACK batch 1 -> persists cursor and immediately delivers batch 2.
      sensor.handleAck({
        batchId: batches[0]!.batchId,
        driverId: "macos-notifications",
        streamId: batches[0]!.streamId,
        sourceEpoch: batches[0]!.sourceEpoch,
        cursorAfter: batches[0]!.cursorAfter,
        status: "accepted",
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(batches).toHaveLength(2);
      expect(batches[1]!.events[0]).toMatchObject({
        nativeEventId: String(secondId),
        appId: "com.tencent.qq",
        appLabel: "QQ",
      });

      // Verify hubId isolation: switching hubId uses an independent cursor namespace.
      sensor.handleAck({
        batchId: batches[1]!.batchId,
        driverId: "macos-notifications",
        streamId: batches[1]!.streamId,
        sourceEpoch: batches[1]!.sourceEpoch,
        cursorAfter: batches[1]!.cursorAfter,
        status: "accepted",
      });
      sensor.setHubIdentity("hub-B");
      await sensor.scanNow();
      expect(batches).toHaveLength(2); // Baseline set cleanly for hub-B without replaying old records

      sensor.close();
    } finally {
      db.close();
    }
  });

  it("resets cursor cleanly with gapDetected when the notification DB is recreated and rec_id wraps", async () => {
    const root = makeRoot();
    const dbPath = path.join(root, "db2", "db");
    const privateDir = path.join(root, ".kulo-env");
    let db = createSyntheticUsernotedDb(dbPath);
    const batches: ConnectorEventBatch[] = [];
    const sensor = new MacOsNotificationSensor({
      envId: "local",
      envName: "Test Mac",
      privateDir,
      databasePath: dbPath,
      pollIntervalMs: 60_000,
      onStatus: () => {},
      onBatch: (b) => batches.push(b),
    });
    try {
      sensor.setHubIdentity("hub-A");
      for (let i = 0; i < 5; i += 1) insertNotification(db, "com.tencent.xinWeChat", { title: "A", body: `old-${i}` });
      sensor.configure({ driverId: "macos-notifications", enabled: true, mutedApps: [] });
      await new Promise((r) => setTimeout(r, 60));
      expect(batches).toHaveLength(0);

      // Recreate database from scratch so inode & rec_id reset to 1.
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
      db = createSyntheticUsernotedDb(dbPath);
      insertNotification(db, "com.tencent.xinWeChat", { title: "新库消息", body: "重建后的第一条消息" });

      await sensor.scanNow();
      expect(batches).toHaveLength(1);
      expect(batches[0]!.gapDetected).toBe(true);
      expect(batches[0]!.events[0]?.body).toBe("重建后的第一条消息");
    } finally {
      sensor.close();
      db.close();
    }
  });

  it("fails closed with unsupported_schema on incompatible SQLite tables", async () => {
    const root = makeRoot();
    const dbPath = path.join(root, "db2", "db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE weird (id INTEGER PRIMARY KEY);");
    db.close();

    const sensor = new MacOsNotificationSensor({
      envId: "local",
      envName: "Test Mac",
      privateDir: path.join(root, ".kulo-env"),
      databasePath: dbPath,
      onStatus: () => {},
      onBatch: () => {},
    });
    expect(sensor.status.permission).toBe("unsupported_schema");
    sensor.close();
  });
});
