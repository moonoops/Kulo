import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RawConnectorEvent } from "@kulo/protocol";
import {
  AssistantLedger,
  AssistantSorter,
  LarkConnectorService,
  buildImConnectorEvent,
  extractCalendarEventsFromData,
  extractImMessagesFromData,
  foldShadowedAssistantDigests,
  normalizeSorterDisposition,
  parseLarkAuthStatus,
  parseLarkCliEnvelope,
  type LarkExecResult,
  type LarkExecRunner,
  type LarkSyncCursorRecord,
} from "@kulo/hub";
import { createAssistantToolsExtension } from "../packages/hub/src/tools-assistant.js";
import { SettingsAssistantDoc } from "../packages/hub/src/settings-doc.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kulo-lark-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function makeFakeExecutable(dir: string): string {
  const exe = path.join(dir, "lark-cli");
  fs.writeFileSync(exe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return exe;
}

function okJson(data: unknown): LarkExecResult {
  return { ok: true, stdout: JSON.stringify({ ok: true, data }), stderr: "" };
}

function errJson(error: Record<string, unknown>, stdout = ""): LarkExecResult {
  return { ok: false, stdout, stderr: JSON.stringify({ ok: false, error }), code: "1" };
}

function userAuthPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    appId: "cli_test_app",
    brand: "feishu",
    identities: {
      user: {
        available: true,
        openId: "ou_self_001",
        userName: "测试本人",
        tokenStatus: "valid",
        scope: "im:message:readonly im:chat:read calendar:calendar.event:read search:message",
        grantedAt: "2026-11-24T08:00:00+08:00",
      },
    },
    dpopKeyStatus: "valid",
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("lark-cli v1.0.100 parsers & envelope diagnostics", () => {
  it("parses calendar +agenda { ok, data } with RFC 3339 datetime, all-day date, and skips unparseable timestamps without fabricating Date.now()", () => {
    const rawStdout = JSON.stringify({
      ok: true,
      data: [
        {
          event_id: "ev-timed",
          summary: "产品周会",
          description: "同步下周发版计划",
          start_time: { datetime: "2026-11-24T15:00:00+08:00" },
        },
        {
          event_id: "ev-allday",
          summary: "季度复盘日",
          start_time: { date: "2026-11-25" },
        },
        {
          event_id: "ev-bad-date",
          summary: "损坏时间戳日程",
          start_time: { datetime: "not-a-timestamp" },
        },
      ],
    });
    const env = parseLarkCliEnvelope({ ok: true, stdout: rawStdout, stderr: "" }, (s) => s);
    expect(env.ok).toBe(true);
    if (!env.ok) return;

    const extracted = extractCalendarEventsFromData("default", env.data, (s) => s);
    expect(extracted.fetchedCount).toBe(3);
    expect(extracted.skippedUnparseable).toBe(1);
    expect(extracted.events).toHaveLength(2);
    expect(extracted.events[0]!.nativeEventId).toBe("lark:cal:ev-timed");
    expect(extracted.events[0]!.occurredAt).toBe(Date.parse("2026-11-24T15:00:00+08:00"));
    expect(extracted.events[1]!.nativeEventId).toBe("lark:cal:ev-allday");
    expect(extracted.events[1]!.occurredAt).toBe(new Date(2026, 10, 25, 0, 0, 0).getTime());
  });

  it("classifies stderr missing_scope errors and 4 auth states without ever falling back to ready=true on non-JSON", () => {
    const scopeRes = errJson({
      type: "missing_scope",
      message: "缺少 search:message 权限",
      missing_scopes: ["search:message"],
    });
    const parsedErr = parseLarkCliEnvelope(scopeRes, (s) => s);
    expect(parsedErr.ok).toBe(false);
    if (!parsedErr.ok) {
      expect(parsedErr.error.kind).toBe("missing_scope");
      expect(parsedErr.error.missingScopes).toEqual(["search:message"]);
    }

    const readyAuth = parseLarkAuthStatus(okJson(userAuthPayload()), "default", (s) => s);
    expect(readyAuth.view.authState).toBe("user_ready");
    expect(readyAuth.view.ready).toBe(true);
    expect(readyAuth.openId).toBe("ou_self_001");

    const botOnly = parseLarkAuthStatus(
      okJson({ appId: "cli_bot", identities: { bot: { available: true, tokenStatus: "valid" } } }),
      "default",
      (s) => s,
    );
    expect(botOnly.view.authState).toBe("bot_only");
    expect(botOnly.view.ready).toBe(false);

    const keychainErr = parseLarkAuthStatus(
      errJson({ type: "keychain_unavailable", message: "macOS Keychain locked" }),
      "default",
      (s) => s,
    );
    expect(keychainErr.view.authState).toBe("keychain_or_token_error");
    expect(keychainErr.view.ready).toBe(false);

    const nonJson = parseLarkAuthStatus({ ok: true, stdout: "User logged in (legacy plain text)", stderr: "" }, "default", (s) => s);
    expect(nonJson.view.authState).toBe("cli_error");
    expect(nonJson.view.ready).toBe(false);
  });
});

describe("LarkConnectorService sync concurrency, pagination, degradation, muted groups & read-only queries", () => {
  it("enforces single-flight syncNow mutex, commit-before-advance on ingest failure, and multi-page cursor resume (>150 msgs)", async () => {
    const dir = makeTempDir("sync-paging");
    const exe = makeFakeExecutable(dir);
    const cursors = new Map<string, LarkSyncCursorRecord>();
    const ingestedIds: string[] = [];
    let failFirstIngest = true;
    let searchCalls = 0;

    // 4 pages x 50 msgs = 200 messages; page cap per sync is 3 -> sync #1 ingests 150 and saves pendingWindow, sync #2 resumes page 4 (50 msgs)
    const nowMs = new Date(2026, 10, 24, 17, 30, 0).getTime();
    const makePageMessages = (pageIdx: number) =>
      Array.from({ length: 50 }, (_, i) => {
        const n = pageIdx * 50 + i + 1;
        return {
          message_id: `om_msg_${n}`,
          chat_id: "oc_chat_main",
          chat_type: "group",
          chat_name: "核心项目群",
          sender: { id: "ou_peer_1", name: "张三", sender_type: "user" },
          msg_type: "text",
          content: `第 ${n} 条同步消息内容`,
          create_time: "2026-11-24 17:25",
        };
      });

    const runner: LarkExecRunner = async (_exe, args) => {
      if (args.includes("auth") && args.includes("status")) {
        await new Promise((r) => setTimeout(r, 15));
        return okJson(userAuthPayload());
      }
      if (args.includes("calendar")) return okJson([]);
      if (args.includes("+chat-list")) {
        return okJson({ chats: [{ chat_id: "oc_chat_main", name: "核心项目群", chat_mode: "group" }], has_more: false });
      }
      if (args.includes("+messages-search")) {
        searchCalls += 1;
        const ptIdx = args.indexOf("--page-token");
        const token = ptIdx >= 0 ? args[ptIdx + 1] : undefined;
        if (!token) return okJson({ messages: makePageMessages(0), has_more: true, page_token: "pt_2" });
        if (token === "pt_2") return okJson({ messages: makePageMessages(1), has_more: true, page_token: "pt_3" });
        if (token === "pt_3") return okJson({ messages: makePageMessages(2), has_more: true, page_token: "pt_4" });
        if (token === "pt_4") return okJson({ messages: makePageMessages(3), has_more: false });
      }
      return okJson([]);
    };

    const service = new LarkConnectorService({
      executablePath: exe,
      runner,
      now: () => nowMs,
      persistedConfig: async () => ({ enabled: true, selectedProfiles: ["default"] }),
      saveConfig: async () => {},
      redact: (s) => s,
      cursorStore: {
        get: async (accountKey, channel) => cursors.get(`${accountKey}:${channel}`),
        save: async (record) => {
          cursors.set(`${record.accountKey}:${record.channel}`, JSON.parse(JSON.stringify(record)) as LarkSyncCursorRecord);
        },
      },
      onEvents: async (_profile, events) => {
        if (failFirstIngest) {
          failFirstIngest = false;
          throw new Error("simulated_sqlite_busy");
        }
        let inserted = 0;
        let deduplicated = 0;
        for (const ev of events) {
          const key = `${ev.nativeEventId}:${ev.eventVersion}`;
          if (ingestedIds.includes(key)) deduplicated += 1;
          else {
            ingestedIds.push(key);
            inserted += 1;
          }
        }
        return { inserted, deduplicated };
      },
    });

    // 1. Concurrent syncNow calls share single-flight promise; first ingest throws -> cursor NOT advanced
    const [r1, r2] = await Promise.all([service.syncNow(), service.syncNow()]);
    expect(r1).toEqual(r2);
    expect(searchCalls).toBe(1);
    expect(r1.profiles[0]?.im?.status).toBe("error");
    expect(cursors.get("cli_test_app:ou_self_001:im")?.completedUntilMs).toBeUndefined();
    expect(ingestedIds).toHaveLength(0);

    // 2. Immediate retry succeeds: ingests 150 msgs across 3 pages and persists pendingWindow(pageToken="pt_4")
    const r3 = await service.syncNow();
    expect(r3.ingestedCount).toBe(150);
    expect(r3.profiles[0]?.im?.status).toBe("partial");
    const midCursor = cursors.get("cli_test_app:ou_self_001:im");
    expect(midCursor?.pendingWindow?.pageToken).toBe("pt_4");
    expect(midCursor?.completedUntilMs).toBeUndefined();

    // 3. Next sync resumes page 4 cleanly, ingests remaining 50 (including #151..#200), clears pendingWindow & advances completedUntilMs
    const r4 = await service.syncNow();
    expect(r4.ingestedCount).toBe(50);
    expect(ingestedIds).toHaveLength(200);
    expect(ingestedIds.some((k) => k.startsWith("lark:im:om_msg_151:"))).toBe(true);
    const doneCursor = cursors.get("cli_test_app:ou_self_001:im");
    expect(doneCursor?.pendingWindow).toBeUndefined();
    expect(doneCursor?.completedUntilMs).toBe(nowMs);
    await service.close();
  });

  it("handles mget partial backfill, degrades to +chat-list on search missing_scope with thread_replies + muted-chat detection, and re-probes when scopes change", async () => {
    const dir = makeTempDir("degrade-muted");
    const exe = makeFakeExecutable(dir);
    const cursors = new Map<string, LarkSyncCursorRecord>();
    const collected: RawConnectorEvent[] = [];
    let currentAuthScope = "im:message:readonly im:chat:read";
    let searchBehavior: "missing_scope" | "partial_mget" = "missing_scope";
    let searchProbeCount = 0;
    const nowMs = new Date(2026, 10, 24, 17, 30, 0).getTime();

    const runner: LarkExecRunner = async (_exe, args) => {
      if (args.includes("auth") && args.includes("status")) {
        return okJson(
          userAuthPayload({
            identities: {
              user: {
                available: true,
                openId: "ou_self_001",
                userName: "测试本人",
                tokenStatus: "valid",
                scope: currentAuthScope,
                grantedAt: currentAuthScope.includes("search:message") ? "2026-11-24T17:40:00+08:00" : "2026-11-24T08:00:00+08:00",
              },
            },
          }),
        );
      }
      if (args.includes("calendar")) {
        return errJson({ type: "missing_scope", message: "缺少日历权限", missing_scopes: ["calendar:calendar.event:read"] });
      }
      if (args.includes("+chat-list")) {
        if (args.includes("--exclude-muted")) {
          // Only oc_active is unmuted -> oc_muted is detected as muted!
          return okJson({ chats: [{ chat_id: "oc_active", name: "项目群", chat_mode: "group" }], has_more: false });
        }
        return okJson({
          chats: [
            { chat_id: "oc_active", name: "项目群", chat_mode: "group" },
            { chat_id: "oc_muted", name: "全员闲聊群", chat_mode: "group" },
          ],
          has_more: false,
        });
      }
      if (args.includes("+messages-search")) {
        searchProbeCount += 1;
        if (searchBehavior === "missing_scope") {
          return errJson({ type: "missing_scope", message: "缺少 search:message", missing_scopes: ["search:message"] });
        }
        return okJson({
          messages: [],
          message_ids: ["om_mget_1"],
          note: "message details require mget",
          has_more: false,
        });
      }
      if (args.includes("+messages-mget")) {
        return okJson({
          messages: [
            {
              message_id: "om_mget_1",
              chat_id: "oc_active",
              chat_type: "group",
              chat_name: "项目群",
              sender: { id: "ou_other", name: "李四", sender_type: "user" },
              msg_type: "text",
              content: "通过 mget 补回的消息",
              create_time: "2026-11-24 17:29",
            },
          ],
        });
      }
      if (args.includes("+chat-messages-list")) {
        const cid = args[args.indexOf("--chat-id") + 1];
        if (cid === "oc_active") {
          return okJson({
            messages: [
              {
                message_id: "om_root_1",
                chat_id: "oc_active",
                chat_type: "group",
                sender: { id: "ou_other", name: "李四", sender_type: "user" },
                msg_type: "text",
                content: "方案确认了吗？",
                create_time: "2026-11-24 17:20",
                thread_id: "omt_1",
                thread_has_more: true,
                thread_replies: [
                  {
                    message_id: "om_reply_self",
                    chat_id: "oc_active",
                    sender: { id: "ou_self_001", name: "测试本人", sender_type: "user" },
                    msg_type: "text",
                    content: "已确认，下午按这个发版",
                    create_time: "2026-11-24 17:22",
                    reply_to: "om_root_1",
                    thread_id: "omt_1",
                  },
                ],
              },
            ],
            has_more: false,
          });
        }
        if (cid === "oc_muted") {
          return okJson({
            messages: [
              {
                message_id: "om_muted_1",
                chat_id: "oc_muted",
                chat_type: "group",
                sender: { id: "ou_other", name: "王五", sender_type: "user" },
                msg_type: "text",
                content: "大家中午吃什么",
                create_time: "2026-11-24 17:21",
              },
            ],
            has_more: false,
          });
        }
      }
      return okJson([]);
    };

    const service = new LarkConnectorService({
      executablePath: exe,
      runner,
      now: () => nowMs,
      persistedConfig: async () => ({ enabled: true, selectedProfiles: ["default"] }),
      saveConfig: async () => {},
      redact: (s) => s,
      cursorStore: {
        get: async (k, c) => cursors.get(`${k}:${c}`),
        save: async (r) => {
          cursors.set(`${r.accountKey}:${r.channel}`, JSON.parse(JSON.stringify(r)) as LarkSyncCursorRecord);
        },
      },
      onEvents: async (_profile, events) => {
        collected.push(...events);
        return { inserted: events.length, deduplicated: 0 };
      },
    });

    // Sync #1: calendar missing_scope does NOT block IM; IM degrades to +chat-list, captures thread_replies & mutedChat!
    const s1 = await service.syncNow();
    expect(s1.profiles[0]?.calendar?.status).toBe("missing_scope");
    expect(s1.profiles[0]?.im?.status).toBe("partial"); // thread_has_more + degraded chat_list
    expect(cursors.get("cli_test_app:ou_self_001:im")?.routeState?.mode).toBe("chat_list");
    expect(searchProbeCount).toBe(1);

    const mutedEv = collected.find((e) => e.nativeEventId === "lark:im:om_muted_1");
    expect(mutedEv?.messageMeta?.mutedChat).toBe(true);
    const activeEv = collected.find((e) => e.nativeEventId === "lark:im:om_root_1");
    expect(activeEv?.messageMeta?.mutedChat).toBeUndefined();
    const replyEv = collected.find((e) => e.nativeEventId === "lark:im:om_reply_self");
    expect(replyEv?.direction).toBe("outgoing");
    expect(replyEv?.body).toBe("已确认，下午按这个发版"); // clean body without fake prefix!
    expect(replyEv?.messageMeta?.replyToMessageId).toBe("om_root_1");

    // Sync #2 with SAME scopesFingerprint: stays on chat_list without wasting a +messages-search call!
    await service.syncNow();
    expect(searchProbeCount).toBe(1);

    // Sync #3 after user grants search:message (scopesFingerprint changes): automatically re-probes +messages-search & runs mget backfill!
    currentAuthScope = "im:message:readonly im:chat:read search:message";
    searchBehavior = "partial_mget";
    const s3 = await service.syncNow();
    expect(searchProbeCount).toBe(2);
    expect(cursors.get("cli_test_app:ou_self_001:im")?.routeState?.mode).toBe("search");
    expect(s3.profiles[0]?.im?.status).toBe("partial");
    expect(collected.some((e) => e.nativeEventId === "lark:im:om_mget_1")).toBe(true);
    await service.close();
  });

  it("enforces consent & injection boundaries on read-only listChats/readChat/searchMessages and merges P2P+group + chat-search", async () => {
    const dir = makeTempDir("readonly-queries");
    const exe = makeFakeExecutable(dir);
    let enabled = false;
    let selectedProfiles = ["work"];
    let capturedChatSearchQuery = "";

    const runner: LarkExecRunner = async (_exe, args) => {
      if (args.includes("auth") && args.includes("status")) return okJson(userAuthPayload());
      if (args.includes("+chat-list")) {
        return okJson({
          chats: [
            { chat_id: "oc_p2p_alice", name: "Alice 私聊", chat_mode: "p2p" },
            { chat_id: "oc_grp_dev", name: "研发群", chat_mode: "group" },
          ],
          has_more: false,
        });
      }
      if (args.includes("+chat-search")) {
        capturedChatSearchQuery = args.find((a) => a.startsWith("--query=")) ?? "";
        return okJson({
          chats: [{ chat_id: "oc_grp_old", name: "Alice 历史项目群", chat_mode: "group" }],
          has_more: false,
        });
      }
      if (args.includes("+chat-messages-list")) {
        return okJson({
          messages: [
            {
              message_id: "om_1",
              chat_id: "oc_p2p_alice",
              chat_type: "p2p",
              sender: { id: "ou_alice", name: "Alice", sender_type: "user" },
              msg_type: "text",
              content: `常规内容 ${"A".repeat(700)}`,
              create_time: "2026-11-24 17:10",
            },
            {
              message_id: "om_otp",
              chat_id: "oc_p2p_alice",
              chat_type: "p2p",
              sender: { id: "ou_alice", name: "Alice", sender_type: "user" },
              msg_type: "text",
              content: "您的验证码为 482910，5分钟内有效",
              create_time: "2026-11-24 17:11",
            },
            {
              message_id: "om_2",
              chat_id: "oc_p2p_alice",
              chat_type: "p2p",
              sender: { id: "ou_self_001", name: "测试本人", sender_type: "user" },
              msg_type: "text",
              content: "收到，secret=sk-1234567890abcdefghij",
              create_time: "2026-11-24 17:12",
            },
          ],
        });
      }
      return okJson([]);
    };

    const service = new LarkConnectorService({
      executablePath: exe,
      runner,
      persistedConfig: async () => ({ enabled, selectedProfiles }),
      saveConfig: async () => {},
      redact: (s) => s.replace(/sk-[a-zA-Z0-9]{12,}/g, "[REDACTED]"),
      onEvents: async () => ({ inserted: 0, deduplicated: 0 }),
    });

    // Disabled -> blocked
    expect((await service.listChats()).ok).toBe(false);
    // Enabled -> reject unselected profile, flag injection, invalid chat_id
    enabled = true;
    expect((await service.listChats({ profile: "personal" })).ok).toBe(false);
    expect((await service.listChats({ profile: "--help" })).ok).toBe(false);
    expect((await service.readChat({ profile: "work", chatId: "../bad" })).ok).toBe(false);

    // listChats merges P2P match from +chat-list and group match from +chat-search (clamped <=64 chars)
    const longQuery = `Alice${"x".repeat(80)}`;
    const listRes = await service.listChats({ profile: "work", query: longQuery });
    expect(listRes.ok).toBe(true);
    expect(capturedChatSearchQuery.length).toBeLessThanOrEqual("--query=".length + 64);

    const aliceList = await service.listChats({ profile: "work", query: "Alice" });
    expect(aliceList.ok).toBe(true);
    const chats = aliceList.chats as Array<{ chatId: string; chatMode: string }>;
    expect(chats.map((c) => c.chatId)).toEqual(["oc_p2p_alice", "oc_grp_old"]);

    // readChat filters OTP sensitive payload, redacts secrets, caps body to 500 chars, marks reactionsOmitted
    const readRes = await service.readChat({ profile: "work", chatId: "oc_p2p_alice" });
    expect(readRes.ok).toBe(true);
    expect(readRes.reactionsOmitted).toBe(true);
    const msgs = readRes.messages as Array<{ messageId: string; direction: string; text: string }>;
    expect(msgs.map((m) => m.messageId)).toEqual(["om_1", "om_2"]);
    expect(msgs[0]!.text.length).toBeLessThanOrEqual(500);
    expect(msgs[1]!.direction).toBe("outgoing");
    expect(msgs[1]!.text).toContain("[REDACTED]");
    expect(msgs[1]!.text).not.toContain("sk-1234567890");
    await service.close();
  });
});

describe("Phase 4: Ledger v3, zero-LLM outgoing archive, token-control valves, recall scrubbing & recovery", () => {
  it("migrates v2 SQLite to v3 idempotently, scrubs recalled messages from events & digests_fts, and preserves cross-org short messages", async () => {
    const stateDir = makeTempDir("ledger-v3");
    const dbPath = path.join(stateDir, "assistant.sqlite");

    // Seed a real v2 SQLite DB first
    const v2 = new DatabaseSync(dbPath);
    v2.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, env_id TEXT NOT NULL, driver_id TEXT NOT NULL, stream_id TEXT NOT NULL,
        source_epoch TEXT NOT NULL, native_event_id TEXT NOT NULL, event_version TEXT NOT NULL,
        app_id TEXT NOT NULL, app_label TEXT NOT NULL, thread_hint TEXT, sender TEXT, title TEXT NOT NULL,
        subtitle TEXT, body TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL, body_pruned_at INTEGER, snapshot_ref TEXT,
        UNIQUE(stream_id, source_epoch, native_event_id, event_version)
      );
      CREATE TABLE digests (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, app_id TEXT NOT NULL, app_label TEXT NOT NULL,
        thread_hint TEXT, category TEXT NOT NULL, disposition TEXT NOT NULL, urgency TEXT NOT NULL,
        digest TEXT NOT NULL, event_ids_json TEXT NOT NULL, situation_key TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE digests_fts USING fts5(digest_id UNINDEXED, digest, app_label, thread_hint, category, tokenize = 'trigram');
      PRAGMA user_version = 2;
    `);
    v2.close();

    const ledger = new AssistantLedger({ stateDir });
    const now = Date.now();

    // Verify cursor round-trip in lark_sync_cursors
    await ledger.larkCursorStore().save({
      accountKey: "cli_app:ou_1",
      channel: "im",
      completedUntilMs: now - 60_000,
      updatedAt: now,
    });
    const loadedCursor = await ledger.larkCursorStore().get("cli_app:ou_1", "im");
    expect(loadedCursor?.completedUntilMs).toBe(now - 60_000);

    // Cross-org same contact saying "收到" is NOT erroneously dropped
    const orgA = await ledger.ingestBatch(
      "local",
      {
        batchId: "b-a",
        driverId: "lark-cli",
        streamId: "hub:local:lark:personal",
        sourceEpoch: "v1",
        cursorAfter: "1",
        events: [
          {
            nativeEventId: "lark:im:om_a1",
            eventVersion: "v:0:aaa",
            appId: "lark:personal",
            appLabel: "飞书 (personal)",
            threadHint: "oc_1",
            sender: "张三",
            title: "张三",
            body: "收到",
            occurredAt: now,
            fidelity: "structured",
            direction: "incoming",
          },
        ],
      },
      (s) => s,
      now,
    );
    const orgB = await ledger.ingestBatch(
      "local",
      {
        batchId: "b-b",
        driverId: "lark-cli",
        streamId: "hub:local:lark:enterprise",
        sourceEpoch: "v1",
        cursorAfter: "2",
        events: [
          {
            nativeEventId: "lark:im:om_b1",
            eventVersion: "v:0:aaa",
            appId: "lark:enterprise",
            appLabel: "飞书 (enterprise)",
            threadHint: "oc_1",
            sender: "张三",
            title: "张三",
            body: "收到",
            occurredAt: now + 1_000,
            fidelity: "structured",
            direction: "incoming",
          },
        ],
      },
      (s) => s,
      now + 1_000,
    );
    expect(orgA.inserted).toHaveLength(1);
    expect(orgB.inserted).toHaveLength(1);

    // Same-minute edit & recall scrubbing: ingest original -> record digest -> ingest recall -> verify prior event & digest scrubbed!
    const origEv = buildImConnectorEvent({
      profile: "default",
      message: {
        messageId: "om_secret_msg",
        chatId: "oc_grp",
        chatType: "group",
        chatName: "财务群",
        senderId: "ou_peer",
        senderName: "财务小王",
        msgType: "text",
        content: "发错群了，报价底线是八十五万",
        occurredAt: now,
        deleted: false,
        updated: false,
        mentions: [],
      },
      selfOpenId: "ou_self_001",
      redact: (s) => s,
    })!;
    const editedEv = buildImConnectorEvent({
      profile: "default",
      message: {
        messageId: "om_secret_msg",
        chatId: "oc_grp",
        chatType: "group",
        chatName: "财务群",
        senderId: "ou_peer",
        senderName: "财务小王",
        msgType: "text",
        content: "更正：报价单已发邮件",
        occurredAt: now,
        deleted: false,
        updated: true,
        mentions: [],
      },
      selfOpenId: "ou_self_001",
      redact: (s) => s,
    })!;
    expect(editedEv.eventVersion).not.toBe(origEv.eventVersion);

    const ins1 = await ledger.ingestBatch(
      "local",
      {
        batchId: "b-orig",
        driverId: "lark-cli",
        streamId: "hub:local:lark:default",
        sourceEpoch: "v1",
        cursorAfter: "3",
        events: [origEv],
      },
      (s) => s,
      now,
    );
    await ledger.recordDigest(
      {
        createdAt: now,
        appId: "lark:default",
        appLabel: "飞书",
        threadHint: "oc_grp",
        category: "message",
        disposition: "archive",
        urgency: "low",
        digest: "财务小王发送：报价底线是八十五万",
        eventIds: [ins1.inserted[0]!.id],
        situationKey: "lark:default:oc_grp",
        driverId: "lark-cli",
        direction: "incoming",
      },
      (s) => s,
    );
    expect(await ledger.searchDigests({ query: "八十五万" })).toHaveLength(1);

    const recalledEv = buildImConnectorEvent({
      profile: "default",
      message: {
        messageId: "om_secret_msg",
        chatId: "oc_grp",
        chatType: "group",
        chatName: "财务群",
        senderId: "ou_peer",
        senderName: "财务小王",
        msgType: "text",
        content: "",
        occurredAt: now,
        deleted: true,
        updated: false,
        mentions: [],
      },
      selfOpenId: "ou_self_001",
      redact: (s) => s,
    })!;
    await ledger.ingestBatch(
      "local",
      {
        batchId: "b-recall",
        driverId: "lark-cli",
        streamId: "hub:local:lark:default",
        sourceEpoch: "v1",
        cursorAfter: "4",
        events: [recalledEv],
      },
      (s) => s,
      now + 5_000,
    );

    const readBack = await ledger.readEventsByIds([ins1.inserted[0]!.id], (s) => s);
    expect(readBack[0]!.body).toBe("[消息已撤回]");
    expect(readBack[0]!.messageMeta?.deleted).toBe(true);
    expect(await ledger.searchDigests({ query: "八十五万" })).toHaveLength(0);
    await ledger.close();
  });

  it("applies family-aware searchDigests and non-destructive read-time folding (Token Valve #2)", async () => {
    const stateDir = makeTempDir("family-folding");
    const ledger = new AssistantLedger({ stateDir });
    const now = Date.now();

    // Shadowed macOS Feishu notification + structured lark-cli digest for the same chat within 1 minute
    await ledger.recordDigest(
      {
        createdAt: now - 30_000,
        appId: "com.electron.lark",
        appLabel: "飞书",
        threadHint: "张三",
        category: "message",
        disposition: "archive",
        urgency: "low",
        digest: "[飞书] 张三：下午三点评审方案请确认",
        eventIds: ["e-notif-1"],
        situationKey: "com.electron.lark:张三",
        driverId: "macos-notifications",
      },
      (s) => s,
    );
    await ledger.recordDigest(
      {
        createdAt: now - 10_000,
        appId: "lark:personal",
        appLabel: "飞书 (personal)",
        threadHint: "oc_p2p_zs",
        category: "message",
        disposition: "archive",
        urgency: "low",
        digest: "张三在私聊询问下午三点评审方案请确认",
        eventIds: ["e-cli-1"],
        situationKey: "lark:personal:oc_p2p_zs",
        driverId: "lark-cli",
        direction: "incoming",
      },
      (s) => s,
    );
    // Unrelated macOS notification from another contact -> must NOT be folded!
    await ledger.recordDigest(
      {
        createdAt: now - 20_000,
        appId: "com.bytedance.feishu",
        appLabel: "飞书",
        threadHint: "王总",
        category: "message",
        disposition: "archive",
        urgency: "low",
        digest: "[飞书] 王总：下周一差旅报销审批",
        eventIds: ["e-notif-2"],
        situationKey: "com.bytedance.feishu:王总",
        driverId: "macos-notifications",
      },
      (s) => s,
    );
    // Another org lark:enterprise digest
    await ledger.recordDigest(
      {
        createdAt: now - 5_000,
        appId: "lark:enterprise",
        appLabel: "飞书 (enterprise)",
        threadHint: "oc_ent_1",
        category: "work",
        disposition: "archive",
        urgency: "low",
        digest: "企业群同步季度 OKR 进度",
        eventIds: ["e-cli-2"],
        situationKey: "lark:enterprise:oc_ent_1",
        driverId: "lark-cli",
        direction: "incoming",
      },
      (s) => s,
    );

    // 1. Default searchDigests({ appId: "飞书" }) matches whole family AND folds only the shadowed duplicate (3 kept, not 4)
    const folded = await ledger.searchDigests({ appId: "飞书", limit: 20 });
    expect(folded.map((d) => d.appId)).toEqual(["lark:enterprise", "lark:personal", "com.bytedance.feishu"]);

    // 2. Non-destructive proof: disabling folding returns all 4 rows intact from SQLite!
    const rawAll = await ledger.searchDigests({ appId: "飞书", limit: 20, foldShadowedNotifications: false });
    expect(rawAll).toHaveLength(4);

    // 3. Explicit org filter `lark:enterprise` stays exact (only enterprise, never personal or macOS bundle)
    const entOnly = await ledger.searchDigests({ appId: "lark:enterprise", limit: 20 });
    expect(entOnly).toHaveLength(1);
    expect(entOnly[0]!.appId).toBe("lark:enterprise");

    // Direct unit check on pure foldShadowedAssistantDigests helper
    expect(foldShadowedAssistantDigests(rawAll, 20)).toHaveLength(3);
    await ledger.close();
  });

  it("archives outgoing self-replies with ZERO LLM calls, clamps muted-group / backfill / @all (Token Valve #1), and recovers undigested events on startup", async () => {
    const stateDir = makeTempDir("sorter-valves");
    const ledger = new AssistantLedger({ stateDir });
    const now = Date.now();

    // Policy unit assertions for normalizeSorterDisposition (top-of-function deterministic guards)
    const baseParsed = {
      digest: "测试摘要",
      category: "message",
      disposition: "notify_brain" as const,
      urgency: "high" as const,
      situationKey: "lark:default:oc_1",
      title: "飞书消息",
    };
    expect(
      normalizeSorterDisposition({ ...baseParsed, disposition: "noise" }, { appId: "lark:default", appLabel: "飞书", direction: "outgoing" }),
    ).toMatchObject({ disposition: "archive", urgency: "low" });
    expect(
      normalizeSorterDisposition(baseParsed, { appId: "lark:default", appLabel: "飞书", messageMeta: { backfill: true } }).disposition,
    ).toBe("archive");
    expect(
      normalizeSorterDisposition(baseParsed, { appId: "lark:default", appLabel: "飞书", messageMeta: { mutedChat: true } }).disposition,
    ).toBe("archive");
    expect(
      normalizeSorterDisposition(baseParsed, { appId: "lark:default", appLabel: "飞书", messageMeta: { mutedChat: true, mentionsMe: true } }).disposition,
    ).toBe("notify_brain");
    expect(
      normalizeSorterDisposition(baseParsed, { appId: "lark:default", appLabel: "飞书", messageMeta: { mentionsAll: true } }).disposition,
    ).toBe("archive");

    // End-to-end AssistantSorter: parallel questions A & B in same group + outgoing reply to B + muted group non-@me
    let llmCalls = 0;
    const escalated: string[] = [];
    const sorter = new AssistantSorter({
      ledger,
      ambientModel: {
        completeZeroToolJson: async () => {
          llmCalls += 1;
          return JSON.stringify({
            digest: "群内提问待跟进",
            category: "work",
            disposition: "notify_brain",
            urgency: "high",
            situationKey: "lark:default:oc_grp",
            title: "群消息",
          });
        },
      } as never,
      redact: (s) => s,
      coalesceWindowMs: 5,
      maxCoalesceMs: 10,
      onNotifyBrain: ({ digest }) => {
        escalated.push(digest.situationKey);
      },
    });

    const batch = await ledger.ingestBatch(
      "local",
      {
        batchId: "b-parallel",
        driverId: "lark-cli",
        streamId: "hub:local:lark:default",
        sourceEpoch: "v1",
        cursorAfter: "10",
        events: [
          {
            nativeEventId: "lark:im:om_q_a",
            eventVersion: "v:0:qa",
            appId: "lark:default",
            appLabel: "飞书",
            threadHint: "oc_grp",
            sender: "同事A",
            title: "项目群",
            body: "交付时间确认了吗？",
            occurredAt: now - 4_000,
            fidelity: "structured",
            direction: "incoming",
            messageMeta: { chatId: "oc_grp", chatType: "group", messageId: "om_q_a", threadId: "t_a" },
          },
          {
            nativeEventId: "lark:im:om_q_b",
            eventVersion: "v:0:qb",
            appId: "lark:default",
            appLabel: "飞书",
            threadHint: "oc_grp",
            sender: "同事B",
            title: "项目群",
            body: "收货地址发我一下",
            occurredAt: now - 3_000,
            fidelity: "structured",
            direction: "incoming",
            messageMeta: { chatId: "oc_grp", chatType: "group", messageId: "om_q_b", threadId: "t_b" },
          },
          {
            nativeEventId: "lark:im:om_reply_b",
            eventVersion: "v:0:rb",
            appId: "lark:default",
            appLabel: "飞书",
            threadHint: "oc_grp",
            sender: "我 (测试本人)",
            title: "项目群",
            body: "地址是上海市浦东新区XX路",
            occurredAt: now - 2_000,
            fidelity: "structured",
            direction: "outgoing",
            messageMeta: { chatId: "oc_grp", chatType: "group", messageId: "om_reply_b", replyToMessageId: "om_q_b", threadId: "t_b" },
          },
          {
            nativeEventId: "lark:im:om_muted_chat",
            eventVersion: "v:0:mc",
            appId: "lark:default",
            appLabel: "飞书",
            threadHint: "oc_muted",
            sender: "群友",
            title: "免打扰大群",
            body: "紧急大家快看链接",
            occurredAt: now - 1_000,
            fidelity: "structured",
            direction: "incoming",
            messageMeta: { chatId: "oc_muted", chatType: "group", messageId: "om_muted_chat", mutedChat: true },
          },
        ],
      },
      (s) => s,
      now,
    );

    // Enqueue only the first 3 + muted -> outgoing reply MUST NOT invoke LLM!
    sorter.enqueue(batch.inserted);
    await new Promise((r) => setTimeout(r, 60));
    await sorter.flushAll();

    // 3 incoming buckets (t_a, t_b, oc_muted) called LLM; outgoing reply used 0 LLM calls!
    expect(llmCalls).toBe(3);
    // Muted group was clamped to archive so only the 2 non-muted threads escalated!
    expect(escalated).toHaveLength(2);

    const allDigests = await ledger.searchDigests({ appId: "飞书", limit: 20, foldShadowedNotifications: false });
    const outgoingDigest = allDigests.find((d) => d.direction === "outgoing");
    expect(outgoingDigest?.disposition).toBe("archive");
    expect(outgoingDigest?.digest).toContain("我在「项目群」回复：地址是上海市浦东新区XX路");
    const mutedDigest = allDigests.find((d) => d.threadHint === "oc_muted");
    expect(mutedDigest?.disposition).toBe("archive");

    // Startup restart recovery: ingest an event directly without enqueuing -> recoverUndigested picks up ONLY the undigested event!
    await ledger.ingestBatch(
      "local",
      {
        batchId: "b-crash-gap",
        driverId: "lark-cli",
        streamId: "hub:local:lark:default",
        sourceEpoch: "v1",
        cursorAfter: "11",
        events: [
          {
            nativeEventId: "lark:im:om_recovered",
            eventVersion: "v:0:rec",
            appId: "lark:default",
            appLabel: "飞书",
            threadHint: "oc_p2p_rec",
            sender: "我 (测试本人)",
            title: "老王",
            body: "重启前刚发出的回复",
            occurredAt: now,
            fidelity: "structured",
            direction: "outgoing",
            messageMeta: { chatId: "oc_p2p_rec", chatType: "p2p", messageId: "om_recovered" },
          },
        ],
      },
      (s) => s,
      now + 1_000,
    );
    const recoveredCount = await sorter.recoverUndigested(now - 60_000);
    expect(recoveredCount).toBe(1);
    await sorter.flushAll();
    expect(llmCalls).toBe(3); // outgoing recovery still used 0 LLM calls!
    const recHits = await ledger.searchDigests({ query: "重启前刚发出的回复" });
    expect(recHits).toHaveLength(1);

    await sorter.close();
    await ledger.close();
  });

  it("blocks Settings Assistant and Workers from reading private Feishu chats/digests while allowing orchestrator topics", async () => {
    const stateDir = makeTempDir("tools-gate");
    const ledger = new AssistantLedger({ stateDir });
    const now = Date.now();
    const ing = await ledger.ingestBatch(
      "local",
      {
        batchId: "b-gate",
        driverId: "lark-cli",
        streamId: "hub:local:lark:default",
        sourceEpoch: "v1",
        cursorAfter: "1",
        events: [
          {
            nativeEventId: "lark:im:om_g1",
            eventVersion: "v:0:g1",
            appId: "lark:default",
            appLabel: "飞书",
            threadHint: "oc_p2p_1",
            sender: "张三",
            title: "张三",
            subtitle: "私聊",
            body: "合同已盖章",
            occurredAt: now,
            fidelity: "structured",
            direction: "incoming",
            messageMeta: { chatId: "oc_p2p_1", chatType: "p2p", messageId: "om_g1" },
          },
        ],
      },
      (s) => s,
      now,
    );
    await ledger.recordDigest(
      {
        createdAt: now,
        appId: "lark:default",
        appLabel: "飞书",
        threadHint: "oc_p2p_1",
        category: "work",
        disposition: "archive",
        urgency: "low",
        digest: "张三通知合同已盖章",
        eventIds: [ing.inserted[0]!.id],
        situationKey: "lark:default:oc_p2p_1",
        driverId: "lark-cli",
        direction: "incoming",
      },
      (s) => s,
    );

    let listChatsCalled = 0;
    const ext = createAssistantToolsExtension(() => ({
      ledger,
      sparkMail: {} as never,
      homeAssistant: {} as never,
      larkConnector: {
        status: async () => ({ installed: true, enabled: true, selectedProfiles: ["default"], profiles: [] }),
        syncNow: async () => ({ syncedProfiles: 1, ingestedCount: 0, deduplicatedCount: 0, profiles: [] }),
        listChats: async () => {
          listChatsCalled += 1;
          return { ok: true, untrustedData: true, chats: [{ chatId: "oc_p2p_1", name: "张三", chatMode: "p2p" }] };
        },
        readChat: async () => ({ ok: true, untrustedData: true, messages: [] }),
        searchMessages: async () => ({ ok: true, untrustedData: true, messages: [] }),
      } as never,
      redact: (s) => s,
      workspaceSnapshot: async () => ({}) as never,
      configureNotifications: async () => ({}) as never,
      configureSpark: async () => ({}) as never,
      configureHomeAssistant: async () => ({}) as never,
      configureLark: async () => ({}) as never,
      proposeDecisionCard: async () => ({}) as never,
      configureBackgroundModel: async () => ({}) as never,
    }));

    const findTool = (name: string) => {
      const tool = ext.tools?.find((t) => t.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      return tool as unknown as {
        execute: (args: Record<string, unknown>, api: Record<string, unknown>, ctx: unknown) => Promise<{ isError?: boolean; output: Array<{ text: string }> }>;
      };
    };

    const makeApi = (convId: number) => ({
      conversationId: convId,
      snapshot: async (doc: unknown) => {
        if (doc === KuloStateDoc) {
          return {
            mainConversationId: 1,
            topics: { "topic-3488": { id: "topic-3488", conversationId: 3488 } },
            conversationToTopic: { "1": "root", "3488": "topic-3488" },
            conversationToTicket: {},
            conversationToSubagent: {},
          };
        }
        if (doc === SettingsAssistantDoc) {
          return { conversationId: 77, archivedConversationIds: [] };
        }
        return undefined;
      },
    });

    const bridge = findTool("kulo_lark_bridge");
    const digests = findTool("kulo_assistant_digests");
    const eventRead = findTool("kulo_assistant_event_read");

    // 1. Settings Assistant (conv 77): status allowed, but private read actions & digests/event_read are BLOCKED!
    expect((await bridge.execute({ action: "status" }, makeApi(77), BACKGROUND_CONTEXT)).isError).toBeUndefined();
    expect((await bridge.execute({ action: "list_chats" }, makeApi(77), BACKGROUND_CONTEXT)).isError).toBe(true);
    expect((await bridge.execute({ action: "read_chat", chat_id: "oc_p2p_1" }, makeApi(77), BACKGROUND_CONTEXT)).isError).toBe(true);
    expect((await bridge.execute({ action: "search_messages", query: "合同" }, makeApi(77), BACKGROUND_CONTEXT)).isError).toBe(true);
    expect((await digests.execute({ app: "飞书" }, makeApi(77), BACKGROUND_CONTEXT)).isError).toBe(true);
    expect((await eventRead.execute({ event_ids: [ing.inserted[0]!.id] }, makeApi(77), BACKGROUND_CONTEXT)).isError).toBe(true);
    expect(listChatsCalled).toBe(0);

    // 2. Arbitrary Worker (conv 9999): BLOCKED on all tools!
    expect((await bridge.execute({ action: "list_chats" }, makeApi(9999), BACKGROUND_CONTEXT)).isError).toBe(true);
    expect((await digests.execute({ app: "飞书" }, makeApi(9999), BACKGROUND_CONTEXT)).isError).toBe(true);

    // 3. Orchestrator Topic (conv 3488, e.g. 飞书工作 topic): ALLOWED and exposes rich metadata!
    const okChats = await bridge.execute({ action: "list_chats" }, makeApi(3488), BACKGROUND_CONTEXT);
    expect(okChats.isError).toBeUndefined();
    expect(listChatsCalled).toBe(1);

    const okDigests = await digests.execute({ app: "飞书" }, makeApi(3488), BACKGROUND_CONTEXT);
    expect(okDigests.isError).toBeUndefined();
    const parsedDigests = JSON.parse(okDigests.output[0]!.text) as { digests: Array<{ threadHint?: string; driverId?: string; direction?: string }> };
    expect(parsedDigests.digests[0]).toMatchObject({ threadHint: "oc_p2p_1", driverId: "lark-cli", direction: "incoming" });

    const okEvent = await eventRead.execute({ event_ids: [ing.inserted[0]!.id] }, makeApi(3488), BACKGROUND_CONTEXT);
    expect(okEvent.isError).toBeUndefined();
    const parsedEvent = JSON.parse(okEvent.output[0]!.text) as { events: Array<{ title?: string; subtitle?: string; direction?: string; messageMeta?: { chatId?: string } }> };
    expect(parsedEvent.events[0]).toMatchObject({ title: "张三", subtitle: "私聊", direction: "incoming", messageMeta: { chatId: "oc_p2p_1" } });

    await ledger.close();
  });
});
