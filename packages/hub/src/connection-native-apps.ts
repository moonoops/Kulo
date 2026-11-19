import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ConnectionApplicationDefinition, ConnectionSecrets, ConnectionUseOperation, ConnectionUseResult } from "@kulo/protocol";

type NativeApplicationId = "messages" | "mail";
type AppOperation = Extract<ConnectionUseOperation, { kind: "app" }>;

export const NATIVE_CONNECTION_APPLICATIONS: ConnectionApplicationDefinition[] = [
  { id: "messages", name: "信息", description: "读取本机对话并发送 iMessage 或短信。", authentication: "macos",
    instructions: ["先在本机信息 App 登录账号。", "在系统设置的隐私与安全性中，为运行 Kulo 的应用授予完全磁盘访问权限。", "点击连接时允许 Kulo 自动化控制信息；完成后重新测试。"],
    helpUrl: "https://support.apple.com/guide/mac-help/mh32356/mac",
    actions: [
      { id: "messages.list", label: "列出对话", readOnly: true, parameters: "limit?: integer，1–50，默认 20。" },
      { id: "messages.read", label: "读取消息", readOnly: true, parameters: "chatId: string，必填，使用 messages.list 返回的 GUID；limit?: integer，1–50，默认 20；before?: string，正整数 messageId，读取其之前的消息。" },
      { id: "messages.send", label: "发送消息", readOnly: false, parameters: 'text: string，必填；chatId?: string（对话 GUID）与 to?: string（手机号或邮箱）必须且只能提供一个；service?: "iMessage" | "SMS"，to 默认 iMessage，chatId 默认所属服务。' },
    ] },
  { id: "mail", name: "邮件", description: "读取本机邮件、保存草稿并发送邮件。", authentication: "macos",
    instructions: ["先在本机邮件 App 添加并启用邮箱。", "点击连接时允许 Kulo 自动化控制邮件。", "完成后重新测试，确认邮箱可读取。"],
    helpUrl: "https://support.apple.com/guide/mac-help/mchla1b1e1fe/mac",
    actions: [
      { id: "mail.list", label: "列出邮件", readOnly: true, parameters: 'account?: string（Mail 账号 ID）；mailbox?: string，默认 "inbox"，未指定 account 时支持 inbox/drafts/sent/trash/junk，指定 account 时使用该账号的邮箱名称路径；limit?: integer，1–50，默认 20；unreadOnly?: boolean，默认 false。' },
      { id: "mail.read", label: "读取邮件", readOnly: true, parameters: 'messageId: string，必填，使用 mail.list 返回的正整数标识；account?: string（Mail 账号 ID）；mailbox?: string，默认 "inbox"，应与列出邮件时的邮箱一致。' },
      { id: "mail.draft", label: "保存草稿", readOnly: false, parameters: "to: string[]，必填且非空，元素为邮箱地址；subject: string、body: string，均必填；cc?: string[]；bcc?: string[]；sender?: string，须为已配置的发件邮箱；收件人总数最多 20。" },
      { id: "mail.send", label: "发送邮件", readOnly: false, parameters: "to: string[]，必填且非空，元素为邮箱地址；subject: string、body: string，均必填；cc?: string[]；bcc?: string[]；sender?: string，须为已配置的发件邮箱；收件人总数最多 20。" },
    ] },
];

export interface NativeApplicationRequest {
  appId: NativeApplicationId;
  action: string;
  params?: Record<string, unknown>;
  requestPermission?: boolean;
  databasePath?: string;
}
/** Injectable only by the trusted host or a synthetic fixture, never by a model tool. */
export type NativeApplicationRunner = (request: NativeApplicationRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>;
export interface NativeConnectionApplicationsOptions {
  stateDir?: string;
  platform?: NodeJS.Platform;
  messagesDatabasePath?: string;
  runner?: NativeApplicationRunner;
  binaryPath?: string;
}

const ERRORS: Record<string, string> = {
  connection_app_platform_unavailable: "本机应用连接仅支持 macOS。",
  connection_app_unavailable: "本机应用连接组件不可用，请重新安装或更新 Kulo。",
  connection_app_not_running: "请先打开本机信息或邮件 App，再测试连接。",
  connection_app_automation_required: "请在系统设置的隐私与安全性中允许 Kulo 自动化控制此应用，然后重新测试。",
  connection_messages_full_disk_access_required: "无法读取信息数据库。请为运行 Kulo 的应用授予完全磁盘访问权限，重启 Kulo 后重新测试。",
  connection_messages_database_missing: "本机信息数据库尚不存在，请先登录并使用信息 App。",
  connection_messages_schema_unsupported: "当前信息数据库格式不受支持，请更新 Kulo。",
  connection_app_account_unavailable: "本机应用没有已启用的登录账号，请先完成账号设置。",
  connection_app_mailbox_unavailable: "未找到对应邮箱或邮件，请检查账号、邮箱名称和邮件标识。",
  connection_app_target_unavailable: "未找到对应的信息对话或发送账号。",
  connection_app_invalid_parameters: "应用操作参数无效。",
  connection_app_send_rejected: "应用未接受发送请求，请检查账号与收件人。",
  connection_app_delivery_unknown: "发送结果尚未确认，请先在本机应用中检查，避免重复发送。",
  connection_app_cancelled: "本机应用操作已取消。",
  connection_app_timeout: "本机应用操作超时，请检查应用状态后重试。",
  connection_app_failed: "本机应用操作未完成，请检查应用与授权状态。",
};

function fail(code: keyof typeof ERRORS): never { throw Object.assign(new Error(ERRORS[code]), { code, status: code === "connection_app_invalid_parameters" ? 400 : 409 }); }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function text(value: unknown, max: number, required = false, multiline = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || required && !value.trim() || Buffer.byteLength(value, "utf8") > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail("connection_app_invalid_parameters");
  return value;
}
function limit(value: unknown): number { if (value === undefined) return 20; if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 50) fail("connection_app_invalid_parameters"); return Number(value); }
function positiveId(value: unknown): string { if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) fail("connection_app_invalid_parameters"); return value; }
function recipient(value: unknown): string {
  const address = text(value, 320, true)!;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address)) fail("connection_app_invalid_parameters");
  return address;
}
function recipients(value: unknown, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 20 || required && value.length === 0) fail("connection_app_invalid_parameters");
  return value.map(recipient);
}

function parameters(appId: NativeApplicationId, action: string, input: unknown): Record<string, unknown> {
  if (input === undefined) input = {};
  if (!plain(input)) fail("connection_app_invalid_parameters");
  const allowed: Record<string, string[]> = {
    "messages.list": ["limit"], "messages.read": ["chatId", "limit", "before"], "messages.send": ["chatId", "to", "text", "service"],
    "mail.list": ["account", "mailbox", "limit", "unreadOnly"], "mail.read": ["messageId", "account", "mailbox"],
    "mail.draft": ["to", "cc", "bcc", "subject", "body", "sender"], "mail.send": ["to", "cc", "bcc", "subject", "body", "sender"],
  };
  if (!action.startsWith(`${appId}.`) || !allowed[action] || Object.keys(input).some((key) => !allowed[action]!.includes(key))) fail("connection_app_invalid_parameters");
  if (action === "messages.list") return { limit: limit(input.limit) };
  if (action === "messages.read") return { chatId: text(input.chatId, 1_024, true), limit: limit(input.limit), ...(input.before !== undefined ? { before: positiveId(input.before) } : {}) };
  if (action === "messages.send") {
    const chatId = text(input.chatId, 1_024), to = text(input.to, 320);
    if (Boolean(chatId) === Boolean(to) || input.service !== undefined && !["iMessage", "SMS"].includes(String(input.service))) fail("connection_app_invalid_parameters");
    if (to && !/^\+?[0-9][0-9 ()-]{4,30}$/.test(to) && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(to)) fail("connection_app_invalid_parameters");
    return { ...(chatId ? { chatId } : { to }), text: text(input.text, 64_000, true, true), ...(input.service !== undefined ? { service: input.service } : {}) };
  }
  if (action === "mail.list" || action === "mail.read") {
    const account = text(input.account, 512), mailbox = text(input.mailbox, 512);
    if (input.unreadOnly !== undefined && typeof input.unreadOnly !== "boolean") fail("connection_app_invalid_parameters");
    const messageId = action === "mail.read" ? positiveId(input.messageId) : undefined;
    if (messageId && BigInt(messageId) > BigInt(Number.MAX_SAFE_INTEGER)) fail("connection_app_invalid_parameters");
    return { ...(account ? { account } : {}), ...(mailbox ? { mailbox } : {}), ...(action === "mail.list" ? { limit: limit(input.limit), unreadOnly: input.unreadOnly ?? false } : { messageId }) };
  }
  const to = recipients(input.to, true), cc = recipients(input.cc), bcc = recipients(input.bcc);
  if (to.length + cc.length + bcc.length > 20) fail("connection_app_invalid_parameters");
  return { to, cc, bcc, subject: text(input.subject, 2_000, true), body: text(input.body, 64_000, true, true), ...(input.sender !== undefined ? { sender: recipient(input.sender) } : {}) };
}

function isWrite(action: string): boolean { return action === "messages.send" || action === "mail.send" || action === "mail.draft"; }

export class NativeConnectionApplications {
  readonly #options: NativeConnectionApplicationsOptions;
  readonly #stateDir: string;
  #helperPromise?: Promise<string>;
  constructor(options: NativeConnectionApplicationsOptions = {}) {
    this.#options = options;
    this.#stateDir = path.resolve(options.stateDir ?? process.env.KULO_STATE_DIR ?? path.join(process.cwd(), ".kulo-state"));
  }
  #assertPlatform(appId: string): asserts appId is NativeApplicationId {
    if (!["messages", "mail"].includes(appId)) fail("connection_app_invalid_parameters");
    if ((this.#options.platform ?? process.platform) !== "darwin") fail("connection_app_platform_unavailable");
  }
  async #helper(): Promise<string> {
    if (this.#options.binaryPath) return this.#options.binaryPath;
    const bundled = fileURLToPath(new URL("./kulo-native-applications", import.meta.url));
    if (fs.existsSync(bundled) && fs.lstatSync(bundled).isFile() && !fs.lstatSync(bundled).isSymbolicLink()) return bundled;
    return this.#helperPromise ??= (async () => {
      const native = fileURLToPath(new URL("../native/", import.meta.url));
      const digest = createHash("sha256").update(fs.readFileSync(path.join(native, "kulo-native-applications.m"))).update(fs.readFileSync(path.join(native, "kulo-native-applications.js"))).digest("hex").slice(0, 20);
      const directory = path.join(this.#stateDir, ".secure", "native-applications");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink()) fail("connection_app_unavailable");
      fs.chmodSync(directory, 0o700);
      const binary = path.join(directory, `kulo-native-applications-${digest}`);
      if (!fs.existsSync(binary)) {
        const moduleUrl = new URL("../scripts/build-native-applications.mjs", import.meta.url).href;
        const builder = await import(moduleUrl) as { buildNativeApplications(options: { outputPath: string }): Promise<void> };
        await builder.buildNativeApplications({ outputPath: binary });
      }
      if (!fs.lstatSync(binary).isFile() || fs.lstatSync(binary).isSymbolicLink()) fail("connection_app_unavailable");
      return binary;
    })().catch(() => { this.#helperPromise = undefined; fail("connection_app_unavailable"); });
  }
  async #run(request: NativeApplicationRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    if (this.#options.runner) return this.#options.runner(structuredClone(request), signal);
    const binary = await this.#helper();
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), LANG: "en_US.UTF-8" }, windowsHide: true });
      const chunks: Buffer[] = [];
      let size = 0, stopped = false, timedOut = false;
      const abort = () => { stopped = true; child.kill("SIGKILL"); };
      const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, request.requestPermission ? 90_000 : 30_000);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => { stopped = true; });
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 256 * 1024) { stopped = true; child.kill("SIGKILL"); } else chunks.push(chunk); });
      child.once("error", () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(Object.assign(new Error(ERRORS.connection_app_unavailable), { code: "connection_app_unavailable", status: 409 })); });
      child.once("close", (status) => {
        clearTimeout(timeout); signal?.removeEventListener("abort", abort);
        try {
          if (stopped || timedOut || status !== 0) fail(isWrite(request.action) ? "connection_app_delivery_unknown" : timedOut ? "connection_app_timeout" : stopped ? "connection_app_cancelled" : "connection_app_failed");
          const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!plain(decoded)) fail("connection_app_failed");
          if (decoded.ok !== true) {
            const code = plain(decoded.error) && typeof decoded.error.code === "string" && Object.hasOwn(ERRORS, decoded.error.code) ? decoded.error.code : "connection_app_failed";
            fail(code);
          }
          if (!plain(decoded.result)) fail("connection_app_failed");
          resolve(decoded.result);
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
          const beforeDispatch = ["connection_app_invalid_parameters", "connection_app_platform_unavailable", "connection_app_not_running", "connection_app_automation_required", "connection_app_account_unavailable", "connection_app_mailbox_unavailable", "connection_app_target_unavailable", "connection_app_send_rejected", "connection_app_delivery_unknown"];
          if (isWrite(request.action) && !beforeDispatch.includes(code)) reject(Object.assign(new Error(ERRORS.connection_app_delivery_unknown), { code: "connection_app_delivery_unknown", status: 409 }));
          else reject(error);
        }
      });
      child.stdin.end(JSON.stringify(request));
      if (signal?.aborted) abort();
    });
  }
  async probe(appId: string, _secrets: ConnectionSecrets, signal?: AbortSignal, options?: { requestPermission?: boolean }): Promise<{ username?: string }> {
    this.#assertPlatform(appId);
    if (appId === "messages") {
      const read = await this.#run({ appId, action: "messages.probe_read", databasePath: this.#options.messagesDatabasePath ?? path.join(os.homedir(), "Library", "Messages", "chat.db") }, signal);
      if (read.readable !== true) fail("connection_messages_full_disk_access_required");
    }
    const result = await this.#run({ appId, action: "probe", requestPermission: options?.requestPermission === true }, signal);
    if (result.authorized !== true || result.accountReady !== true || appId === "mail" && result.readable !== true) fail("connection_app_account_unavailable");
    return { ...(typeof result.username === "string" && result.username.length <= 256 ? { username: result.username } : {}) };
  }
  async execute(appId: string, _secrets: ConnectionSecrets, operation: AppOperation, signal?: AbortSignal): Promise<ConnectionUseResult> {
    this.#assertPlatform(appId);
    if (!operation || operation.kind !== "app" || typeof operation.action !== "string") fail("connection_app_invalid_parameters");
    const params = parameters(appId, operation.action, operation.params);
    const result = await this.#run({ appId, action: operation.action, params, requestPermission: false,
      ...(appId === "messages" && operation.action !== "messages.send" ? { databasePath: this.#options.messagesDatabasePath ?? path.join(os.homedir(), "Library", "Messages", "chat.db") } : {}) }, signal);
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output, "utf8") > 128 * 1024) fail("connection_app_failed");
    return { kind: "app", output };
  }
}
