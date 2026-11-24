import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import type {
  AssistantMessageDirection,
  LarkChannelDiagnostics,
  LarkConnectorSnapshot,
  LarkProfileView,
  RawConnectorEvent,
} from "@kulo/protocol";
import { isSensitiveNotificationPayload } from "@kulo/protocol";
import { buildAugmentedHostPath, findHostExecutable } from "../host-path.js";
import {
  classifyOrganizationKind,
  extractCalendarEventsFromData,
  extractChatDirectoryFromData,
  extractImMessagesFromData,
  extractSentMessageId,
  formatLarkLocalIso,
  parseLarkAuthStatus,
  parseLarkCliEnvelope,
  parseLarkProfileList,
  SAFE_CHAT_ID_RE,
  SAFE_PROFILE_RE,
  type LarkChatSummary,
  type LarkExecResult,
  type ParsedLarkAuthStatus,
} from "./lark-cli-parsers.js";
import {
  refreshLarkChatDirectory,
  syncLarkImChannel,
  type LarkDirectoryCacheEntry,
  type LarkSyncCursorRecord,
  type LarkSyncCursorStore,
} from "./lark-im-sync.js";

export { parseLarkProfileList, type LarkExecResult };
export type { LarkSyncCursorRecord, LarkSyncCursorStore };

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_QUERY_OUTPUT_BYTES = 18_000;
const MAX_QUERY_BODY_CHARS = 500;

export type LarkExecRunner = (exe: string, args: string[], timeoutMs: number) => Promise<LarkExecResult>;

export interface LarkPersistedConfig {
  enabled: boolean;
  selectedProfiles: string[];
}

export interface LarkIngestResult {
  inserted: number;
  deduplicated: number;
}

export interface LarkProfileSyncReport {
  profile: string;
  ok: boolean;
  calendar?: LarkChannelDiagnostics;
  im?: LarkChannelDiagnostics;
  error?: string;
}

export interface LarkSyncSummary {
  syncedProfiles: number;
  ingestedCount: number;
  deduplicatedCount: number;
  profiles: LarkProfileSyncReport[];
  error?: string;
}

export interface LarkReadMessageView {
  messageId: string;
  chatId: string;
  chatName?: string;
  chatType?: "p2p" | "group" | "topic";
  at?: string;
  sender: string;
  direction: AssistantMessageDirection;
  msgType: string;
  text: string;
  deleted?: boolean;
  replyTo?: string;
  threadId?: string;
}

export interface LarkConnectorServiceHost {
  persistedConfig(): Promise<LarkPersistedConfig>;
  saveConfig(next: LarkPersistedConfig): Promise<void>;
  redact(text: string): string;
  onEvents: (profile: string, events: RawConnectorEvent[]) => Promise<void | LarkIngestResult>;
  cursorStore?: LarkSyncCursorStore;
  executablePath?: string;
  runner?: LarkExecRunner;
  pollIntervalMs?: number;
  now?: () => number;
}

export function findLarkCliExecutable(explicit?: string): string | undefined {
  if (explicit) {
    try {
      if (!fs.statSync(explicit).isFile()) return undefined;
      fs.accessSync(explicit, fs.constants.X_OK);
      return explicit;
    } catch {
      return undefined;
    }
  }
  return findHostExecutable("lark-cli");
}

function defaultLarkRunner(exe: string, args: string[], timeoutMs: number): Promise<LarkExecResult> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      {
        cwd: os.tmpdir(),
        env: {
          PATH: buildAugmentedHostPath(),
          HOME: os.homedir(),
          TMPDIR: os.tmpdir(),
          LANG: "en_US.UTF-8",
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const errno = error as NodeJS.ErrnoException & { code?: string | number };
          const errCode = typeof errno.code === "string" ? errno.code : undefined;
          const exitCode = typeof errno.code === "number" ? errno.code : undefined;
          resolve({
            ok: false,
            ...(errCode ? { code: errCode } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            stdout: String(stdout ?? "").slice(0, MAX_OUTPUT_BYTES),
            stderr: String(stderr ?? error.message ?? "").slice(0, MAX_STDERR_BYTES),
          });
          return;
        }
        resolve({
          ok: true,
          stdout: String(stdout ?? "").slice(0, MAX_OUTPUT_BYTES),
          stderr: String(stderr ?? "").slice(0, MAX_STDERR_BYTES),
        });
      },
    );
  });
}

function createMemoryCursorStore(): LarkSyncCursorStore {
  const map = new Map<string, LarkSyncCursorRecord>();
  return {
    async get(accountKey, channel) {
      return map.get(`${accountKey}\0${channel}`);
    },
    async save(record) {
      map.set(`${record.accountKey}\0${record.channel}`, record);
    },
  };
}

function boundSerializedList<T>(items: T[], maxBytes: number): { items: T[]; truncated: boolean } {
  const kept: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (kept.length > 0 && bytes + size > maxBytes) {
      return { items: kept, truncated: true };
    }
    kept.push(item);
    bytes += size;
  }
  return { items: kept, truncated: false };
}

export class LarkConnectorService {
  readonly #host: LarkConnectorServiceHost;
  readonly #pollIntervalMs: number;
  readonly #cursorStore: LarkSyncCursorStore;
  readonly #now: () => number;
  #pollTimer: NodeJS.Timeout | null = null;
  #initialTimer: NodeJS.Timeout | null = null;
  #syncPromise: Promise<LarkSyncSummary> | null = null;
  #lastSyncAt: number | undefined;
  #lastError: string | undefined;
  #cachedProfiles: LarkProfileView[] | null = null;
  #cachedProfilesAt = 0;
  #authCache = new Map<string, ParsedLarkAuthStatus>();
  #profileChannels = new Map<string, { calendar?: LarkChannelDiagnostics; im?: LarkChannelDiagnostics }>();
  #directoryCache = new Map<string, LarkDirectoryCacheEntry>();
  #seenCalendarKeys = new Set<string>();
  #sentMessageIds = new Set<string>();
  #closed = false;

  constructor(host: LarkConnectorServiceHost) {
    this.#host = host;
    this.#pollIntervalMs = host.pollIntervalMs ?? 90_000;
    this.#cursorStore = host.cursorStore ?? createMemoryCursorStore();
    this.#now = host.now ?? Date.now;
  }

  #resolveExe(): string | undefined {
    return this.#host.runner
      ? (this.#host.executablePath ?? "lark-cli")
      : findLarkCliExecutable(this.#host.executablePath);
  }

  async #exec(args: string[], timeoutMs = 12_000): Promise<LarkExecResult> {
    const exe = this.#resolveExe();
    if (!exe) return { ok: false, code: "ENOENT", stdout: "", stderr: "未检测到 lark-cli，请先安装并登录飞书 CLI。" };
    return (this.#host.runner ?? defaultLarkRunner)(exe, args, timeoutMs);
  }

  async #ingest(profile: string, events: RawConnectorEvent[]): Promise<LarkIngestResult> {
    if (events.length === 0) return { inserted: 0, deduplicated: 0 };
    const res = await this.#host.onEvents(profile, events);
    if (res && typeof res === "object" && typeof res.inserted === "number") {
      return {
        inserted: Math.max(0, res.inserted),
        deduplicated: Math.max(0, res.deduplicated ?? 0),
      };
    }
    return { inserted: events.length, deduplicated: 0 };
  }

  async #inspectProfileAuth(name: string): Promise<ParsedLarkAuthStatus> {
    const args = name === "default" ? ["auth", "status", "--json"] : ["--profile", name, "auth", "status", "--json"];
    const authRes = await this.#exec(args, 8_000);
    const parsed = parseLarkAuthStatus(authRes, name, this.#host.redact);
    this.#authCache.set(name, parsed);
    return parsed;
  }

  #decorateProfileView(view: LarkProfileView): LarkProfileView {
    const channels = this.#profileChannels.get(view.name);
    if (!channels) return view;
    return {
      ...view,
      ...(channels.calendar ? { calendar: channels.calendar } : {}),
      ...(channels.im ? { im: channels.im } : {}),
    };
  }

  getSelfSenderAliases(profile: string): string[] {
    const name = this.#authCache.get(profile)?.userName?.trim();
    if (!name) return [];
    return [...new Set([name, `我 (${name})`])];
  }

  wasSentByKulo(messageId: string | undefined): boolean {
    return Boolean(messageId && this.#sentMessageIds.has(messageId));
  }

  async start(): Promise<void> {
    const cfg = await this.#host.persistedConfig();
    if (cfg.enabled) {
      this.#schedulePolling(true);
    }
  }

  async listProfiles(): Promise<LarkProfileView[]> {
    const exe = this.#resolveExe();
    if (!exe) return [];
    const listRes = await this.#exec(["profile", "list"], 6_000);
    const names = listRes.ok ? parseLarkProfileList(listRes.stdout) : ["default"];
    const views: LarkProfileView[] = [];
    for (const name of names.slice(0, 8)) {
      const parsed = await this.#inspectProfileAuth(name);
      views.push(this.#decorateProfileView(parsed.view));
    }
    return views;
  }

  async status(options: { force?: boolean } = {}): Promise<LarkConnectorSnapshot> {
    const cfg = await this.#host.persistedConfig();
    const cliAvailable = Boolean(this.#resolveExe());
    let profiles: LarkProfileView[] = [];
    if (cliAvailable) {
      if (!options.force && this.#cachedProfiles && this.#now() - this.#cachedProfilesAt < 20_000) {
        profiles = this.#cachedProfiles.map((p) => this.#decorateProfileView(p));
      } else {
        profiles = await this.listProfiles();
        this.#cachedProfiles = profiles;
        this.#cachedProfilesAt = this.#now();
      }
    }
    const selected = cfg.selectedProfiles.length > 0
      ? cfg.selectedProfiles
      : profiles.filter((p) => p.ready).map((p) => p.name);
    return {
      enabled: cfg.enabled,
      cliAvailable,
      profiles,
      selectedProfiles: selected,
      ...(this.#lastSyncAt !== undefined ? { lastSyncAt: this.#lastSyncAt } : {}),
      ...(this.#lastError ? { error: this.#lastError } : {}),
    };
  }

  async configure(input: { enabled?: boolean; selectedProfiles?: string[] }): Promise<LarkConnectorSnapshot> {
    const prev = await this.#host.persistedConfig();
    const nextProfiles = input.selectedProfiles
      ? [...new Set(input.selectedProfiles.map((p) => p.trim()).filter((p) => SAFE_PROFILE_RE.test(p)))].slice(0, 8)
      : prev.selectedProfiles;
    const nextEnabled = typeof input.enabled === "boolean" ? input.enabled : prev.enabled;
    await this.#host.saveConfig({ enabled: nextEnabled, selectedProfiles: nextProfiles });
    this.#lastError = undefined;
    if (nextEnabled) {
      this.#schedulePolling(false);
      void this.syncNow().catch(() => {});
    } else {
      this.#stopPolling();
    }
    return this.status({ force: true });
  }

  syncNow(): Promise<LarkSyncSummary> {
    if (this.#closed) {
      return Promise.resolve({ syncedProfiles: 0, ingestedCount: 0, deduplicatedCount: 0, profiles: [] });
    }
    // Single-flight mutex established synchronously before any await so concurrent calls share one run.
    if (this.#syncPromise) return this.#syncPromise;
    this.#syncPromise = this.#runSyncNow().finally(() => {
      this.#syncPromise = null;
    });
    return this.#syncPromise;
  }

  async #runSyncNow(): Promise<LarkSyncSummary> {
    const cfg = await this.#host.persistedConfig();
    if (!cfg.enabled) {
      return { syncedProfiles: 0, ingestedCount: 0, deduplicatedCount: 0, profiles: [] };
    }
    if (!this.#resolveExe()) {
      const error = "未检测到 lark-cli，请先安装并登录飞书 CLI。";
      this.#lastError = error;
      return { syncedProfiles: 0, ingestedCount: 0, deduplicatedCount: 0, profiles: [], error };
    }

    let syncedProfiles = 0;
    let ingestedCount = 0;
    let deduplicatedCount = 0;
    const reports: LarkProfileSyncReport[] = [];
    const fatalErrors: string[] = [];

    try {
      const targetProfiles = cfg.selectedProfiles.length > 0
        ? cfg.selectedProfiles.filter((p) => SAFE_PROFILE_RE.test(p))
        : (await this.listProfiles()).filter((p) => p.ready).map((p) => p.name);

      if (targetProfiles.length === 0) {
        const error = "没有就绪的飞书个人账号可供同步，请先在主机终端执行 lark-cli auth login。";
        this.#lastError = error;
        return { syncedProfiles: 0, ingestedCount: 0, deduplicatedCount: 0, profiles: [], error };
      }

      for (const profile of targetProfiles) {
        const auth = await this.#inspectProfileAuth(profile);
        if (!auth.view.ready) {
          const errMsg = auth.view.error || `账号 ${profile} 尚未完成个人用户授权`;
          fatalErrors.push(`${profile}: ${errMsg}`);
          reports.push({ profile, ok: false, error: errMsg });
          continue;
        }

        const calDiag: LarkChannelDiagnostics = await this.#syncCalendarChannel(profile).catch((error: unknown) => ({
          status: "error" as const,
          error: this.#host.redact(error instanceof Error ? error.message : "飞书日历同步失败").slice(0, 240),
        }));
        const imDiag: LarkChannelDiagnostics = await syncLarkImChannel(
          {
            exec: (args, timeoutMs) => this.#exec(args, timeoutMs),
            redact: this.#host.redact,
            ingest: (p, evs) => this.#ingest(p, evs),
            cursorStore: this.#cursorStore,
            directoryCache: this.#directoryCache,
            now: this.#now,
          },
          profile,
          auth,
        ).catch((error: unknown) => ({
          status: "error" as const,
          error: this.#host.redact(error instanceof Error ? error.message : "飞书消息同步失败").slice(0, 240),
        }));

        this.#profileChannels.set(profile, { calendar: calDiag, im: imDiag });
        const calOk = calDiag.status === "ok" || calDiag.status === "partial";
        const imOk = imDiag.status === "ok" || imDiag.status === "partial";
        ingestedCount += (calDiag.ingestedCount ?? 0) + (imDiag.ingestedCount ?? 0);
        deduplicatedCount += (calDiag.deduplicatedCount ?? 0) + (imDiag.deduplicatedCount ?? 0);

        if (calOk || imOk) {
          syncedProfiles += 1;
          // Surface IM transport/auth failure even if calendar worked, without hiding partial success.
          const profileErr =
            imDiag.status === "error" || imDiag.status === "missing_scope"
              ? `IM: ${imDiag.error ?? "同步异常"}`
              : undefined;
          if (profileErr) fatalErrors.push(`${profile}: ${profileErr}`);
          reports.push({
            profile,
            ok: true,
            calendar: calDiag,
            im: imDiag,
            ...(profileErr ? { error: profileErr } : {}),
          });
        } else {
          const combined = [
            imDiag.error ? `IM: ${imDiag.error}` : undefined,
            calDiag.error ? `日历: ${calDiag.error}` : undefined,
          ].filter(Boolean).join("；") || "飞书同步失败";
          fatalErrors.push(`${profile}: ${combined}`);
          reports.push({ profile, ok: false, calendar: calDiag, im: imDiag, error: combined });
        }
      }

      if (syncedProfiles > 0) {
        this.#lastSyncAt = this.#now();
      }
      this.#lastError = fatalErrors.length > 0 ? this.#host.redact(fatalErrors.join(" | ")).slice(0, 320) : undefined;
    } catch (error) {
      const message = this.#host.redact(error instanceof Error ? error.message : "飞书同步失败").slice(0, 320);
      this.#lastError = message;
      return { syncedProfiles, ingestedCount, deduplicatedCount, profiles: reports, error: message };
    }

    return {
      syncedProfiles,
      ingestedCount,
      deduplicatedCount,
      profiles: reports,
      ...(this.#lastError ? { error: this.#lastError } : {}),
    };
  }

  async #syncCalendarChannel(profile: string): Promise<LarkChannelDiagnostics> {
    const prefix = profile === "default" ? [] : ["--profile", profile];
    const agendaRes = await this.#exec([...prefix, "calendar", "+agenda", "--as", "user", "--format", "json"], 12_000);
    const env = parseLarkCliEnvelope(agendaRes, this.#host.redact);
    if (!env.ok) {
      return {
        status: env.error.kind === "missing_scope" ? "missing_scope" : "error",
        ...(env.error.missingScopes.length ? { missingScopes: env.error.missingScopes } : {}),
        error: env.error.missingScopes.length
          ? `缺少日历权限：${env.error.missingScopes.join(", ")}`
          : env.error.message,
      };
    }

    const extracted = extractCalendarEventsFromData(profile, env.data, this.#host.redact);
    const fresh: RawConnectorEvent[] = [];
    const candidateKeys: string[] = [];
    let skippedDup = 0;

    for (const ev of extracted.events) {
      const key = `${profile}:${ev.nativeEventId}:${ev.eventVersion}`;
      if (this.#seenCalendarKeys.has(key)) {
        skippedDup += 1;
        continue;
      }
      if (isSensitiveNotificationPayload(ev)) continue;
      fresh.push(ev);
      candidateKeys.push(key);
    }

    let ingestedCount = 0;
    let deduplicatedCount = skippedDup;
    if (fresh.length > 0) {
      // Commit BEFORE updating #seenCalendarKeys so transient DB errors can safely retry.
      const res = await this.#ingest(profile, fresh);
      ingestedCount = res.inserted;
      deduplicatedCount += res.deduplicated;
      for (const key of candidateKeys) this.#seenCalendarKeys.add(key);
      if (this.#seenCalendarKeys.size > 4_000) {
        this.#seenCalendarKeys = new Set([...this.#seenCalendarKeys].slice(-2_000));
      }
    }

    return {
      status: extracted.skippedUnparseable > 0 && extracted.events.length === 0 ? "partial" : "ok",
      fetchedCount: extracted.fetchedCount,
      ingestedCount,
      deduplicatedCount,
      coverage: extracted.skippedUnparseable > 0 ? "partial" : "complete",
      ...(extracted.skippedUnparseable > 0 ? { note: `跳过 ${extracted.skippedUnparseable} 条时间格式无法解析的日程` } : {}),
    };
  }

  async #resolveAuthorizedProfile(requested?: string): Promise<
    | { ok: true; profile: string; auth: ParsedLarkAuthStatus }
    | { ok: false; error: string }
  > {
    const cfg = await this.#host.persistedConfig();
    if (!cfg.enabled) {
      return { ok: false, error: "飞书连接未启用，请先在设置 → 连接中开启飞书感知桥接。" };
    }
    if (!this.#resolveExe()) {
      return { ok: false, error: "未检测到 lark-cli，请先安装并登录飞书 CLI。" };
    }
    const allowed = cfg.selectedProfiles.length > 0
      ? cfg.selectedProfiles.filter((p) => SAFE_PROFILE_RE.test(p))
      : (await this.listProfiles()).filter((p) => p.ready).map((p) => p.name);
    if (allowed.length === 0) {
      return { ok: false, error: "没有已启用的就绪飞书个人账号。" };
    }
    const target = requested?.trim() || allowed[0]!;
    if (!SAFE_PROFILE_RE.test(target) || !allowed.includes(target)) {
      return { ok: false, error: `飞书账号 '${target}' 未启用或不在已授权同步范围内。` };
    }
    const auth = this.#authCache.get(target) ?? (await this.#inspectProfileAuth(target));
    if (!auth.view.ready) {
      return { ok: false, error: auth.view.error || `飞书账号 '${target}' 未完成个人用户授权。` };
    }
    return { ok: true, profile: target, auth };
  }

  async listChats(params: { profile?: string; query?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const resolved = await this.#resolveAuthorizedProfile(params.profile);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { profile } = resolved;
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 25)));
    const query = params.query?.trim().replace(/[\x00-\x1f\x7f]/g, "") ?? "";

    const dirOut = await refreshLarkChatDirectory(
      { exec: (args, ms) => this.#exec(args, ms), redact: this.#host.redact, directoryCache: this.#directoryCache, now: this.#now },
      profile,
      { force: false, includeMutedDiff: false },
    );
    if (!dirOut.entry && dirOut.error) {
      return {
        ok: false,
        profile,
        error: dirOut.error.message,
        ...(dirOut.error.missingScopes.length ? { missingScopes: dirOut.error.missingScopes } : {}),
      };
    }

    const merged = new Map<string, LarkChatSummary>();
    const dirChats = dirOut.entry ? [...dirOut.entry.chats.values()] : [];
    const lowerQ = query.toLowerCase();
    for (const chat of dirChats) {
      if (!lowerQ || chat.name.toLowerCase().includes(lowerQ) || chat.chatId.toLowerCase().includes(lowerQ)) {
        merged.set(chat.chatId, chat);
      }
    }

    // im +chat-search only searches group chats (not P2P) and caps query at 64 chars.
    if (query) {
      const prefix = profile === "default" ? [] : ["--profile", profile];
      const searchRes = await this.#exec(
        [...prefix, "im", "+chat-search", "--as", "user", `--query=${query.slice(0, 64)}`, "--page-size", "20", "--format", "json"],
        12_000,
      );
      const env = parseLarkCliEnvelope(searchRes, this.#host.redact);
      if (env.ok) {
        for (const chat of extractChatDirectoryFromData(env.data).chats) {
          if (!merged.has(chat.chatId)) merged.set(chat.chatId, chat);
        }
      }
    }

    const sanitized = [...merged.values()].slice(0, limit).map((c) => ({
      chatId: c.chatId,
      name: this.#host.redact(c.name).slice(0, 120),
      chatMode: c.chatMode,
      ...(c.muted ? { muted: true } : {}),
      ...(c.external ? { external: true } : {}),
    }));
    const bounded = boundSerializedList(sanitized, MAX_QUERY_OUTPUT_BYTES);
    return {
      ok: true,
      untrustedData: true,
      profile,
      count: bounded.items.length,
      truncated: bounded.truncated || merged.size > bounded.items.length,
      chats: bounded.items,
    };
  }

  async readChat(params: { profile?: string; chatId: string; hours?: number; limit?: number }): Promise<Record<string, unknown>> {
    const chatId = params.chatId.trim();
    if (!SAFE_CHAT_ID_RE.test(chatId)) {
      return { ok: false, error: "飞书会话 ID 格式无效（需为 oc_ 开头）。" };
    }
    const resolved = await this.#resolveAuthorizedProfile(params.profile);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { profile, auth } = resolved;
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 25)));
    const prefix = profile === "default" ? [] : ["--profile", profile];
    const args = [
      ...prefix,
      "im",
      "+chat-messages-list",
      "--as",
      "user",
      "--chat-id",
      chatId,
      "--order",
      "desc",
      "--page-size",
      String(limit),
      "--no-reactions",
      "--format",
      "json",
    ];
    if (typeof params.hours === "number" && Number.isFinite(params.hours) && params.hours > 0) {
      const clampedHours = Math.min(168, params.hours);
      const now = this.#now();
      args.push("--start", formatLarkLocalIso(now - clampedHours * 3_600_000), "--end", formatLarkLocalIso(now));
    }
    const res = await this.#exec(args, 15_000);
    const env = parseLarkCliEnvelope(res, this.#host.redact);
    if (!env.ok) {
      return {
        ok: false,
        profile,
        chatId,
        error: env.error.message,
        ...(env.error.missingScopes.length ? { missingScopes: env.error.missingScopes } : {}),
      };
    }

    const dir = this.#directoryCache.get(profile)?.chats;
    const dirChat = dir?.get(chatId);
    const page = extractImMessagesFromData(env.data, {
      chatId,
      ...(dirChat ? { chatName: dirChat.name, chatType: dirChat.chatMode } : {}),
    });
    return this.#formatReadMessagesResult(profile, auth, page, dir, { chatId });
  }

  async searchMessages(params: {
    profile?: string;
    query?: string;
    chatId?: string;
    hours?: number;
    limit?: number;
  } = {}): Promise<Record<string, unknown>> {
    const chatId = params.chatId?.trim();
    if (chatId && !SAFE_CHAT_ID_RE.test(chatId)) {
      return { ok: false, error: "飞书会话 ID 格式无效（需为 oc_ 开头）。" };
    }
    const resolved = await this.#resolveAuthorizedProfile(params.profile);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { profile, auth } = resolved;
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 25)));
    const query = (params.query ?? "").trim().replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120);
    const hours = typeof params.hours === "number" && Number.isFinite(params.hours)
      ? Math.max(0.25, Math.min(168, params.hours))
      : 24;
    const now = this.#now();
    const prefix = profile === "default" ? [] : ["--profile", profile];
    const args = [
      ...prefix,
      "im",
      "+messages-search",
      "--as",
      "user",
      `--query=${query}`,
      "--start",
      formatLarkLocalIso(now - hours * 3_600_000),
      "--end",
      formatLarkLocalIso(now),
      "--page-size",
      String(limit),
      "--no-reactions",
      "--format",
      "json",
      ...(chatId ? ["--chat-id", chatId] : []),
    ];
    const res = await this.#exec(args, 18_000);
    const env = parseLarkCliEnvelope(res, this.#host.redact);
    if (!env.ok) {
      return {
        ok: false,
        profile,
        error: env.error.message,
        ...(env.error.missingScopes.length ? { missingScopes: env.error.missingScopes } : {}),
      };
    }

    const dirOut = await refreshLarkChatDirectory(
      { exec: (a, ms) => this.#exec(a, ms), redact: this.#host.redact, directoryCache: this.#directoryCache, now: this.#now },
      profile,
      { force: false, includeMutedDiff: false },
    );
    const page = extractImMessagesFromData(env.data);
    return this.#formatReadMessagesResult(profile, auth, page, dirOut.entry?.chats, {
      ...(chatId ? { chatId } : {}),
      hours,
    });
  }

  #formatReadMessagesResult(
    profile: string,
    auth: ParsedLarkAuthStatus,
    page: ReturnType<typeof extractImMessagesFromData>,
    dir: ReadonlyMap<string, LarkChatSummary> | undefined,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    const views: LarkReadMessageView[] = [];
    const sorted = [...page.messages].sort((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0));
    for (const msg of sorted) {
      if (msg.msgType === "system") continue;
      const dirEntry = dir?.get(msg.chatId);
      const direction: AssistantMessageDirection =
        auth.openId && msg.senderId
          ? msg.senderId === auth.openId
            ? "outgoing"
            : "incoming"
          : "unknown";
      const chatName = msg.chatName || dirEntry?.name || msg.chatPartnerName;
      const sender = direction === "outgoing"
        ? `我 (${auth.userName || msg.senderName || "本人"})`
        : msg.senderName || msg.senderId || "未知发送者";
      const text = msg.deleted ? "[消息已撤回]" : this.#host.redact(msg.content).trim().slice(0, MAX_QUERY_BODY_CHARS);
      if (
        !msg.deleted &&
        isSensitiveNotificationPayload({
          appId: `lark:${profile}`,
          title: chatName ?? "",
          subtitle: sender,
          body: text,
        })
      ) {
        continue;
      }
      views.push({
        messageId: msg.messageId,
        chatId: msg.chatId,
        ...(chatName ? { chatName: this.#host.redact(chatName).slice(0, 120) } : {}),
        ...(msg.chatType ?? dirEntry?.chatMode ? { chatType: msg.chatType ?? dirEntry?.chatMode } : {}),
        ...(msg.occurredAt !== undefined ? { at: new Date(msg.occurredAt).toISOString() } : {}),
        sender: this.#host.redact(sender).slice(0, 100),
        direction,
        msgType: msg.msgType,
        text: text || `[${msg.msgType}]`,
        ...(msg.deleted ? { deleted: true } : {}),
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
      });
    }
    const bounded = boundSerializedList(views, MAX_QUERY_OUTPUT_BYTES);
    return {
      ok: true,
      untrustedData: true,
      profile,
      ...extra,
      count: bounded.items.length,
      hasMore: page.hasMore,
      partial: page.partial || bounded.truncated,
      ...(page.pendingMessageIds.length ? { pendingMessageIds: page.pendingMessageIds.slice(0, 50) } : {}),
      ...(page.pendingThreadIds.length ? { pendingThreadIds: page.pendingThreadIds.slice(0, 20) } : {}),
      ...(page.note ? { note: this.#host.redact(page.note).slice(0, 200) } : {}),
      ...(page.notice ? { notice: this.#host.redact(page.notice).slice(0, 200) } : {}),
      reactionsOmitted: true,
      messages: bounded.items,
    };
  }

  /**
   * Strictly executed ONLY after explicit L2 user confirmation (`confirm_action`).
   */
  async executeConfirmedReply(params: {
    profile?: string;
    chatId: string;
    text: string;
  }): Promise<{ ok: boolean; preDispatch?: boolean; messageId?: string; error?: string }> {
    const profile = params.profile?.trim() || "default";
    if (!SAFE_PROFILE_RE.test(profile)) {
      return { ok: false, preDispatch: true, error: "飞书 profile 名称无效" };
    }
    const chatId = params.chatId.trim();
    if (!SAFE_CHAT_ID_RE.test(chatId)) {
      return { ok: false, preDispatch: true, error: "飞书会话 ID 格式无效" };
    }
    const text = params.text.trim().slice(0, 4_000);
    if (!text) return { ok: false, preDispatch: true, error: "回复内容不能为空" };
    const prefix = profile === "default" ? [] : ["--profile", profile];
    const res = await this.#exec(
      [...prefix, "im", "+messages-send", "--as", "user", "--chat-id", chatId, "--text", text, "--format", "json"],
      15_000,
    );
    if (!res.ok) {
      const preDispatch = res.code === "ENOENT" || res.code === "EACCES";
      const env = parseLarkCliEnvelope(res, this.#host.redact);
      return {
        ok: false,
        preDispatch,
        error: (!env.ok ? env.error.message : this.#host.redact(res.stderr || "发送飞书回复失败")).slice(0, 400),
      };
    }
    let messageId: string | undefined;
    if (res.stdout.trim()) {
      const env = parseLarkCliEnvelope(res, this.#host.redact);
      if (!env.ok) {
        return { ok: false, preDispatch: false, error: env.error.message.slice(0, 400) };
      }
      messageId = extractSentMessageId(env.data);
      if (messageId) {
        this.#sentMessageIds.add(messageId);
        if (this.#sentMessageIds.size > 512) {
          this.#sentMessageIds.delete(this.#sentMessageIds.values().next().value!);
        }
      }
    }
    return { ok: true, ...(messageId ? { messageId } : {}) };
  }

  #schedulePolling(runInitialSoon: boolean): void {
    this.#stopPolling();
    if (this.#closed) return;
    if (runInitialSoon) {
      const delayMs = Math.min(3_000, Math.max(50, this.#pollIntervalMs));
      this.#initialTimer = setTimeout(() => {
        this.#initialTimer = null;
        if (!this.#closed) void this.syncNow().catch(() => {});
      }, delayMs);
      this.#initialTimer.unref();
    }
    this.#pollTimer = setInterval(() => {
      void this.syncNow().catch(() => {});
    }, this.#pollIntervalMs);
    this.#pollTimer.unref();
  }

  #stopPolling(): void {
    if (this.#initialTimer) {
      clearTimeout(this.#initialTimer);
      this.#initialTimer = null;
    }
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stopPolling();
  }
}

export { classifyOrganizationKind };
