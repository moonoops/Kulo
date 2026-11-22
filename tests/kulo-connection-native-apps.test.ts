import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NativeConnectionApplications, NATIVE_CONNECTION_APPLICATIONS, openNativePermissionSettings, type NativeApplicationRequest } from "../packages/hub/src/connection-native-apps.js";

const directories: string[] = [];
let buildDirectory: string | undefined;
let binaryPath: string;
function directory(): string { const result = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-native-app-fixture-")); directories.push(result); return result; }

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-native-app-build-test-"));
  binaryPath = path.join(buildDirectory, "kulo-native-applications");
  const moduleUrl = new URL("../packages/hub/scripts/build-native-applications.mjs", import.meta.url).href;
  const builder = await import(moduleUrl);
  await builder.buildNativeApplications({ outputPath: binaryPath });
  for (const operation of ["--probe", "--validate-script"]) {
    const result = spawnSync(binaryPath, [operation], { stdio: "ignore", timeout: 10_000 });
    expect(result.status).toBe(0);
  }
}, 60_000);
afterEach(() => { for (const entry of directories.splice(0)) fs.rmSync(entry, { recursive: true, force: true }); });
afterAll(() => { if (buildDirectory) fs.rmSync(buildDirectory, { recursive: true, force: true }); });

function typedstream(value: string, tag: "short" | "wide" | "long" = "short", little = true): Buffer {
  const body = Buffer.from(value, "utf8");
  const length = tag === "short" ? Buffer.from([body.length]) : Buffer.alloc(tag === "wide" ? 3 : 5);
  if (tag !== "short") {
    length[0] = tag === "wide" ? 0x81 : 0x82;
    if (tag === "wide") little ? length.writeUInt16LE(body.length, 1) : length.writeUInt16BE(body.length, 1);
    else little ? length.writeUInt32LE(body.length, 1) : length.writeUInt32BE(body.length, 1);
  }
  return Buffer.concat([Buffer.from([4, 11]), Buffer.from(little ? "streamtyped" : "typedstream"), Buffer.from("NSString"), Buffer.from([1, 0x2b]), length, body, Buffer.from([1, 0x2b, 4]), Buffer.from("junk")]);
}

function database() {
  const stateDir = directory();
  const databasePath = path.join(stateDir, "synthetic-chat.db");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE chat (guid TEXT,display_name TEXT,chat_identifier TEXT,service_name TEXT);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE message (guid TEXT,text TEXT,date INTEGER,is_from_me INTEGER,handle_id INTEGER,attributedBody BLOB,service TEXT,cache_has_attachments INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER,message_id INTEGER);
    INSERT INTO chat VALUES ('iMessage;-;fixture-chat','Fixture chat','fixture@example.test','iMessage');
    INSERT INTO handle VALUES ('fixture@example.test');
  `);
  let next = 1;
  function add(options: { text?: string | null; body?: Buffer | null; chatId?: number; attachments?: boolean; fromMe?: boolean } = {}): string {
    const id = next++;
    db.prepare("INSERT INTO message (ROWID,guid,text,date,is_from_me,handle_id,attributedBody,service,cache_has_attachments) VALUES (?,?,?,?,?,?,?,?,?)").run(id, `fixture-message-${id}`, options.text ?? null, 800_000_000_000_000_000n + BigInt(id) * 1_000_000_000n, options.fromMe ? 1 : 0, 1, options.body ?? null, "iMessage", options.attachments ? 1 : 0);
    db.prepare("INSERT INTO chat_message_join VALUES (?,?)").run(options.chatId ?? 1, id);
    return String(id);
  }
  const applications = new NativeConnectionApplications({ stateDir, platform: "darwin", messagesDatabasePath: databasePath, binaryPath });
  return { stateDir, databasePath, db, add, applications };
}

function helper(request: NativeApplicationRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (status) => {
      try {
        const decoded = JSON.parse(output);
        if (status !== 0 || decoded.ok !== true) throw Object.assign(new Error("Synthetic native helper rejected request"), { code: decoded.error?.code });
        resolve(decoded.result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

describe("native connection application contract", () => {
  it("marks read and write operations explicitly in the catalog", () => {
    const actions = NATIVE_CONNECTION_APPLICATIONS.flatMap((app) => app.actions);
    expect(actions.filter((action) => action.readOnly).map((action) => action.id)).toEqual(["messages.list", "messages.read", "mail.list", "mail.read"]);
    expect(actions.filter((action) => !action.readOnly).map((action) => action.id)).toEqual(["messages.send", "mail.draft", "mail.send"]);
  });

  it("publishes each native action's exact parameter names and required routing rules", () => {
    const documented = new Map(NATIVE_CONNECTION_APPLICATIONS.flatMap((application) => application.actions).map((action) => [action.id, action.parameters]));
    const fields: Record<string, string[]> = {
      "messages.list": ["limit"], "messages.read": ["chatId", "limit", "before"], "messages.send": ["chatId", "to", "text", "service"],
      "mail.list": ["account", "mailbox", "limit", "unreadOnly"], "mail.read": ["messageId", "account", "mailbox"],
      "mail.draft": ["to", "cc", "bcc", "subject", "body", "sender"], "mail.send": ["to", "cc", "bcc", "subject", "body", "sender"],
    };
    for (const [action, names] of Object.entries(fields)) {
      expect(documented.get(action)).toBeTruthy();
      for (const name of names) expect(documented.get(action)).toMatch(new RegExp(`\\b${name}\\??:`));
    }
    expect(documented.get("messages.send")).toContain("必须且只能提供一个");
    expect(documented.get("messages.read")).toContain("GUID");
    expect(documented.get("mail.send")).toContain("必填且非空");
  });

  it("fails closed outside macOS without invoking any process", async () => {
    const runner = vi.fn();
    const applications = new NativeConnectionApplications({ platform: "linux", runner });
    await expect(applications.probe("messages", {})).rejects.toMatchObject({ code: "connection_app_platform_unavailable" });
    await expect(applications.execute("mail", {}, { kind: "app", action: "mail.list" })).rejects.toMatchObject({ code: "connection_app_platform_unavailable" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("requires real read access as well as Messages Automation before reporting a connection", async () => {
    const runner = vi.fn(async (request: NativeApplicationRequest) => request.action === "messages.probe_read" ? { readable: true } : { authorized: true, accountReady: true, username: "fixture-messages-account" });
    const applications = new NativeConnectionApplications({ platform: "darwin", runner, messagesDatabasePath: "/synthetic/chat.db" });
    expect(await applications.probe("messages", {})).toEqual({ username: "fixture-messages-account" });
    expect(runner.mock.calls.map(([request]) => ({ action: request.action, requestPermission: request.requestPermission }))).toEqual([
      { action: "messages.probe_read", requestPermission: undefined }, { action: "probe", requestPermission: false },
    ]);
    runner.mockImplementation(async () => ({ readable: false }));
    await expect(applications.probe("messages", {})).rejects.toMatchObject({ code: "connection_messages_full_disk_access_required" });
  });

  it("prompts for Messages Automation before checking Full Disk Access during interactive authorization", async () => {
    const calls: Array<{ action: string; requestPermission?: boolean }> = [];
    const applications = new NativeConnectionApplications({
      platform: "darwin",
      messagesDatabasePath: "/synthetic/chat.db",
      runner: async (request) => {
        calls.push({ action: request.action, requestPermission: request.requestPermission });
        return request.action === "probe"
          ? { authorized: true, accountReady: true, username: "fixture-messages-account" }
          : { readable: false };
      },
    });
    await expect(applications.probe("messages", {}, undefined, { requestPermission: true })).rejects.toMatchObject({
      code: "connection_messages_full_disk_access_required",
    });
    expect(calls).toEqual([
      { action: "probe", requestPermission: true },
      { action: "messages.probe_read", requestPermission: undefined },
    ]);
  });

  it("opens only fixed macOS privacy URLs for native connector permissions", async () => {
    const opened: string[] = [];
    const launcher = async (url: string) => { opened.push(url); };
    await openNativePermissionSettings("full-disk-access", { platform: "darwin", launcher });
    await openNativePermissionSettings("automation", { platform: "darwin", launcher });
    await openNativePermissionSettings("local-network", { platform: "darwin", launcher });
    expect(opened).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
    ]);
    await expect(openNativePermissionSettings("full-disk-access", { platform: "linux", launcher })).rejects.toMatchObject({ code: "connection_app_platform_unavailable" });
    for (const invalid of ["microphone", "__proto__", "https://example.com", "", null]) {
      await expect(openNativePermissionSettings(invalid, { platform: "darwin", launcher })).rejects.toMatchObject({ code: "connection_app_invalid_parameters" });
    }
    expect(opened).toHaveLength(3);
  });

  it("requests Automation only during an explicit setup probe", async () => {
    const requests: NativeApplicationRequest[] = [];
    const applications = new NativeConnectionApplications({ platform: "darwin", runner: async (request) => { requests.push(request); return request.action === "probe" ? { authorized: true, accountReady: true, readable: true } : { accepted: true }; } });
    await applications.probe("mail", {}, undefined, { requestPermission: true });
    await applications.execute("mail", {}, { kind: "app", action: "mail.list" });
    expect(requests.map((request) => request.requestPermission)).toEqual([true, false]);
  });

  it.each([{ authorized: true }, { authorized: true, accountReady: true }, { authorized: false, accountReady: true, readable: true }])("never treats permission-only Mail status as connected: %j", async (result) => {
    const applications = new NativeConnectionApplications({ platform: "darwin", runner: async () => result });
    await expect(applications.probe("mail", {})).rejects.toMatchObject({ code: "connection_app_account_unavailable" });
  });

  it("passes mail content as literal data, and never forwards stored password fields", async () => {
    const requests: NativeApplicationRequest[] = [];
    const applications = new NativeConnectionApplications({ platform: "darwin", runner: async (request) => { requests.push(request); return { draftId: "5", saved: true }; } });
    const body = 'literal "quotes"; Application("System Events")\n$(not-a-shell-command)';
    await applications.execute("mail", { password: "synthetic-never-forwarded", apiKey: "synthetic-never-forwarded-key" }, { kind: "app", action: "mail.draft", params: { to: ["fixture@example.test"], subject: "Fixture draft", body } });
    expect(requests[0]?.params?.body).toBe(body);
    expect(requests[0]?.requestPermission).toBe(false);
    expect(JSON.stringify(requests)).not.toContain("synthetic-never-forwarded");
  });

  it.each([
    ["messages", "messages.send", { to: "+12025550123", chatId: "iMessage;-;fixture", text: "fixture" }],
    ["messages", "messages.send", { to: "+12025550123", text: "fixture", service: "automatic" }],
    ["messages", "messages.read", { chatId: "fixture", databasePath: "/unapproved/path" }],
    ["messages", "messages.read", { chatId: "fixture", before: "1 OR 1=1" }],
    ["messages", "mail.send", { to: ["fixture@example.test"], subject: "Fixture", body: "fixture" }],
    ["mail", "mail.read", { messageId: "9007199254740993" }],
    ["mail", "mail.send", { to: ["fixture@example.test\nBcc:other@example.test"], subject: "Fixture", body: "fixture" }],
    ["mail", "mail.send", { to: ["fixture@example.test"], subject: "Fixture", body: "fixture", script: "doSomething()" }],
  ])("rejects unsupported/injectable operation %s/%s", async (appId, action, params) => {
    const runner = vi.fn();
    const applications = new NativeConnectionApplications({ platform: "darwin", runner });
    await expect(applications.execute(String(appId), {}, { kind: "app", action: String(action), params: params as Record<string, unknown> })).rejects.toMatchObject({ code: "connection_app_invalid_parameters" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not dispatch an operation when its task is already cancelled", async () => {
    const runner = vi.fn(), controller = new AbortController(); controller.abort();
    const applications = new NativeConnectionApplications({ platform: "darwin", runner });
    await expect(applications.execute("messages", {}, { kind: "app", action: "messages.list" }, controller.signal)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "darwin")("native Messages helper with synthetic databases only", () => {
  it("reads a real synthetic SQLite file without changing it and returns paginated chat GUIDs", async () => {
    const f = database(); f.add({ text: "Fixture first" }); f.add({ text: "Fixture second", fromMe: true }); f.db.close();
    const before = fs.readFileSync(f.databasePath);
    const list = JSON.parse((await f.applications.execute("messages", {}, { kind: "app", action: "messages.list" })).output);
    expect(list.chats[0]).toMatchObject({ chatId: "iMessage;-;fixture-chat", name: "Fixture chat", service: "iMessage" });
    const first = JSON.parse((await f.applications.execute("messages", {}, { kind: "app", action: "messages.read", params: { chatId: "iMessage;-;fixture-chat", limit: 1 } })).output);
    expect(first.messages[0]).toMatchObject({ messageId: "2", text: "Fixture second", fromMe: true, textStatus: "plain" });
    expect(first.hasMore).toBe(true);
    const second = JSON.parse((await f.applications.execute("messages", {}, { kind: "app", action: "messages.read", params: { chatId: "iMessage;-;fixture-chat", before: first.nextBefore } })).output);
    expect(second.messages.map((message: { text: string }) => message.text)).toEqual(["Fixture first"]);
    expect(fs.readFileSync(f.databasePath)).toEqual(before);
  });

  it.each([
    ["short", true, "synthetic Unicode 中文\0\u0001+ body"],
    ["wide", true, "long-synthetic-".repeat(30)],
    ["wide", false, "big-endian-".repeat(30)],
    ["long", true, "x".repeat(70_000)],
  ] as const)("decodes length-framed attributedBody %s, littleEndian=%s", async (tag, little, body) => {
    const f = database(); f.add({ text: "", body: typedstream(body, tag, little) }); f.db.close();
    const result = JSON.parse((await f.applications.execute("messages", {}, { kind: "app", action: "messages.read", params: { chatId: "iMessage;-;fixture-chat" } })).output);
    expect(result.messages[0].text).toBe(body.slice(0, 16000));
    expect(result.messages[0].text).not.toContain("junk");
    expect(result.messages[0].textStatus).toBe("attributed");
    expect(result.messages[0].truncated).toBe(body.length > 16000);
  });

  it("decodes a synthetic NSAttributedString generated by the actual Foundation archiver", async () => {
    // Foundation only; this fixture never creates an Application or requests an OS permission.
    const executable = path.join(buildDirectory!, "synthetic-archiver");
    const generator = '#import <Foundation/Foundation.h>\n#include <stdio.h>\nint main(void){@autoreleasepool{NSAttributedString *text=[[NSAttributedString alloc] initWithString:@"Foundation synthetic 中文 fixture"];NSData *data=[NSArchiver archivedDataWithRootObject:text];fwrite(data.bytes,1,data.length,stdout);return 0;}}';
    const compiled = spawnSync("/usr/bin/clang", ["-x", "objective-c", "-fobjc-arc", "-Wno-deprecated-declarations", "-framework", "Foundation", "-o", executable, "-"], { input: generator, encoding: "utf8", timeout: 30_000 });
    expect(compiled.status).toBe(0);
    const archived = spawnSync(executable, [], { timeout: 10_000 });
    expect(archived.status).toBe(0);
    const f = database(); f.add({ body: archived.stdout }); f.db.close();
    const result = JSON.parse((await f.applications.execute("messages", {}, { kind: "app", action: "messages.read", params: { chatId: "iMessage;-;fixture-chat" } })).output);
    expect(result.messages[0]).toMatchObject({ text: "Foundation synthetic 中文 fixture", textStatus: "attributed" });
  });

  it("handles UTF-16 bodies and reports unknown binary formats instead of pretending they are empty", async () => {
    const f = database();
    f.add({ body: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("UTF16 synthetic 中文", "utf16le")]) });
    f.add({ body: Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0xff, 0x01]) });
    f.db.close();
    const result = JSON.parse((await f.applications.execute("messages", {}, { kind: "app", action: "messages.read", params: { chatId: "iMessage;-;fixture-chat" } })).output);
    expect(result.complete).toBe(false);
    expect(result.messages[0]).toMatchObject({ text: null, textStatus: "unsupported" });
    expect(result.messages[1]).toMatchObject({ text: "UTF16 synthetic 中文", textStatus: "attributed" });
  });

  it("binds chat identifiers so SQL-looking input cannot read another chat", async () => {
    const f = database(); f.add({ text: "Synthetic scoped message" }); f.db.close();
    const result = JSON.parse((await f.applications.execute("messages", {}, { kind: "app", action: "messages.read", params: { chatId: "' OR 1=1 --" } })).output);
    expect(result.messages).toEqual([]);
  });

  it("proves database readability through a synthetic file before a mocked Automation probe", async () => {
    const f = database(); f.db.close();
    const requests: string[] = [];
    const applications = new NativeConnectionApplications({ platform: "darwin", messagesDatabasePath: f.databasePath, runner: async (request) => {
      requests.push(request.action);
      return request.action === "probe" ? { authorized: true, accountReady: true } : helper(request);
    } });
    await applications.probe("messages", {});
    expect(requests).toEqual(["messages.probe_read", "probe"]);
  });

  it("fails closed for missing or incompatible synthetic databases without an Automation call", async () => {
    const f = database(); f.db.exec("DROP TABLE chat_message_join"); f.db.close();
    await expect(f.applications.execute("messages", {}, { kind: "app", action: "messages.list" })).rejects.toMatchObject({ code: "connection_messages_schema_unsupported" });
    const absent = new NativeConnectionApplications({ platform: "darwin", binaryPath, messagesDatabasePath: path.join(f.stateDir, "absent.db") });
    await expect(absent.execute("messages", {}, { kind: "app", action: "messages.list" })).rejects.toMatchObject({ code: "connection_messages_database_missing" });
  });

  it.each(["not-json", '{"ok":true,"result":null}', '{"ok":false,"error":{"code":"unexpected-code"}}'])("treats damaged synthetic write receipts as uncertain without retry: %s", async (receipt) => {
    const stateDir = directory(), fake = path.join(stateDir, "synthetic-helper"), script = path.join(stateDir, "synthetic-helper.cjs"), started = path.join(stateDir, "started");
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(started)},'fixture-started');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(receipt)}));\n`);
    fs.writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
    const applications = new NativeConnectionApplications({ stateDir, platform: "darwin", binaryPath: fake });
    await expect(applications.execute("mail", {}, { kind: "app", action: "mail.send", params: { to: ["fixture@example.test"], subject: "Fixture", body: "Synthetic only" } })).rejects.toMatchObject({ code: "connection_app_delivery_unknown" });
    expect(fs.readFileSync(started, "utf8")).toBe("fixture-started");
  });
});

function fixedScript(request: Record<string, unknown>, application: unknown): Record<string, unknown> {
  const source = fs.readFileSync(fileURLToPath(new URL("../packages/hub/native/kulo-native-applications.js", import.meta.url)), "utf8");
  const output = vm.runInNewContext(`${source}\nkulo(input);`, { input: JSON.stringify(request), Application: () => application });
  return JSON.parse(output);
}

function mailApplication(sendResult: unknown = true) {
  const account = { enabled: () => true, id: () => "fixture-account", name: () => "Fixture", emailAddresses: () => ["sender@example.test"] };
  const draft = { id: () => 17, toRecipients: [] as unknown[], ccRecipients: [] as unknown[], bccRecipients: [] as unknown[], save: vi.fn(), sender: "" };
  const app = { accounts: [account], inbox: () => ({ messages: [] }), primaryEmail: () => "sender@example.test", OutgoingMessage: vi.fn(() => draft), outgoingMessages: [] as unknown[],
    ToRecipient: (value: unknown) => value, CcRecipient: (value: unknown) => value, BccRecipient: (value: unknown) => value, send: vi.fn(() => sendResult) };
  return { app, draft };
}

describe("fixed native automation script with synthetic application objects", () => {
  it("checks an enabled account and a readable mailbox during Mail authorization", () => {
    const { app } = mailApplication();
    expect(fixedScript({ appId: "mail", action: "probe", bundleId: "synthetic.mail" }, app)).toMatchObject({ authorized: true, accountReady: true, readable: true, username: "sender@example.test" });
    expect(app.OutgoingMessage).not.toHaveBeenCalled();
    expect(app.send).not.toHaveBeenCalled();
  });

  it("creates a draft with literal recipient/content values and saves it without sending", () => {
    const { app, draft } = mailApplication();
    const params = { to: ["fixture@example.test"], cc: ["cc@example.test"], bcc: [], subject: 'Fixture "quoted" subject', body: 'Body; Application("not executable")', sender: "sender@example.test" };
    expect(fixedScript({ appId: "mail", action: "mail.draft", bundleId: "synthetic.mail", params }, app)).toEqual({ draftId: "17", saved: true });
    expect(app.OutgoingMessage).toHaveBeenCalledWith(expect.objectContaining({ subject: params.subject, content: params.body, visible: false }));
    expect(draft.toRecipients).toEqual([{ address: "fixture@example.test" }]);
    expect(draft.ccRecipients).toEqual([{ address: "cc@example.test" }]);
    expect(draft.save).toHaveBeenCalledTimes(1);
    expect(app.send).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])("submits Mail once and distinguishes the application's receipt %s", (receipt) => {
    const { app } = mailApplication();
    app.send.mockReturnValue(receipt);
    const result = fixedScript({ appId: "mail", action: "mail.send", bundleId: "synthetic.mail", params: { to: ["fixture@example.test"], cc: [], bcc: [], subject: "Fixture", body: "Synthetic" } }, app);
    expect(app.send).toHaveBeenCalledTimes(1);
    if (receipt === true) expect(result).toMatchObject({ accepted: true, delivery: "submitted" });
    else expect(result.kuloError).toBe(receipt === false ? "connection_app_send_rejected" : "connection_app_delivery_unknown");
  });

  it("does not send or create a draft for an unconfigured sender", () => {
    const { app } = mailApplication();
    expect(fixedScript({ appId: "mail", action: "mail.send", bundleId: "synthetic.mail", params: { to: ["fixture@example.test"], cc: [], bcc: [], subject: "Fixture", body: "Synthetic", sender: "unknown@example.test" } }, app)).toEqual({ kuloError: "connection_app_account_unavailable" });
    expect(app.OutgoingMessage).not.toHaveBeenCalled();
    expect(app.send).not.toHaveBeenCalled();
  });
});
