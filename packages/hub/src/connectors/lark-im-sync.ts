import type { LarkChannelDiagnostics, RawConnectorEvent } from "@kulo/protocol";
import {
  buildImConnectorEvent,
  extractChatDirectoryFromData,
  extractImMessagesFromData,
  formatLarkLocalIso,
  parseLarkCliEnvelope,
  type LarkChatSummary,
  type LarkCliParsedError,
  type LarkExecResult,
  type ParsedLarkAuthStatus,
} from "./lark-cli-parsers.js";

const INITIAL_LOOKBACK_MS = 2 * 60 * 60 * 1_000;
const OVERLAP_MS = 5 * 60 * 1_000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const BACKFILL_AGE_THRESHOLD_MS = 20 * 60 * 1_000;
const SEARCH_MAX_PAGES_PER_SYNC = 3;
const SEARCH_PAGE_SIZE = 50;
const FALLBACK_MAX_CHATS = 15;
const FALLBACK_CHAT_PAGE_SIZE = 20;
const FALLBACK_CONCURRENCY = 3;
const DIRECTORY_TTL_MS = 5 * 60 * 1_000;

export interface LarkPendingWindow {
  startMs: number;
  endMs: number;
  pageToken?: string;
  pendingMessageIds?: string[];
  pendingThreadIds?: string[];
  backfill?: boolean;
}

export interface LarkRouteState {
  mode?: "search" | "chat_list";
  scopesFingerprint?: string;
  searchMissingScopes?: string[];
  chatListMissingScopes?: string[];
  calendarMissingScopes?: string[];
}

export interface LarkSyncCursorRecord {
  accountKey: string;
  channel: "im" | "calendar";
  completedUntilMs?: number;
  pendingWindow?: LarkPendingWindow;
  chatCursors?: Record<string, number>;
  routeState?: LarkRouteState;
  updatedAt: number;
}

export interface LarkSyncCursorStore {
  get(accountKey: string, channel: "im" | "calendar"): Promise<LarkSyncCursorRecord | undefined>;
  save(record: LarkSyncCursorRecord): Promise<void>;
}

export interface LarkDirectoryCacheEntry {
  chats: Map<string, LarkChatSummary>;
  mutedChatIds: Set<string>;
  hasMore: boolean;
  refreshedAt: number;
}

export interface LarkImSyncDeps {
  exec: (args: string[], timeoutMs: number) => Promise<LarkExecResult>;
  redact: (text: string) => string;
  ingest: (profile: string, events: RawConnectorEvent[]) => Promise<{ inserted: number; deduplicated: number }>;
  cursorStore: LarkSyncCursorStore;
  directoryCache: Map<string, LarkDirectoryCacheEntry>;
  now?: () => number;
}

export function buildLarkAccountKey(profile: string, auth?: ParsedLarkAuthStatus): string {
  const appId = auth?.appId?.trim() || profile;
  const openId = auth?.openId?.trim();
  return openId ? `${appId}:${openId}` : appId;
}

export function buildScopesFingerprint(auth?: ParsedLarkAuthStatus): string {
  if (!auth) return "";
  const sorted = [...new Set(auth.scopes)].sort().join(",");
  return `${auth.grantedAt ?? ""}|${sorted}`;
}

export async function refreshLarkChatDirectory(
  deps: Pick<LarkImSyncDeps, "exec" | "redact" | "directoryCache" | "now">,
  profile: string,
  options: { force?: boolean; includeMutedDiff?: boolean } = {},
): Promise<{ entry?: LarkDirectoryCacheEntry; error?: LarkCliParsedError }> {
  const now = (deps.now ?? Date.now)();
  const cached = deps.directoryCache.get(profile);
  if (!options.force && cached && now - cached.refreshedAt < DIRECTORY_TTL_MS) {
    return { entry: cached };
  }
  const prefix = profile === "default" ? [] : ["--profile", profile];
  const listRes = await deps.exec(
    [...prefix, "im", "+chat-list", "--as", "user", "--types", "p2p,group", "--sort", "active_time", "--page-size", "50", "--format", "json"],
    12_000,
  );
  const env = parseLarkCliEnvelope(listRes, deps.redact);
  if (!env.ok) {
    return { ...(cached ? { entry: cached } : {}), error: env.error };
  }
  const parsed = extractChatDirectoryFromData(env.data);
  const chats = new Map<string, LarkChatSummary>();
  for (const chat of parsed.chats) chats.set(chat.chatId, chat);

  const mutedChatIds = new Set<string>();
  const hasGroupChats = parsed.chats.some((c) => c.chatMode !== "p2p");
  if (options.includeMutedDiff !== false && hasGroupChats) {
    const unmutedRes = await deps.exec(
      [...prefix, "im", "+chat-list", "--as", "user", "--types", "p2p,group", "--sort", "active_time", "--page-size", "50", "--exclude-muted", "--format", "json"],
      10_000,
    );
    const unmutedEnv = parseLarkCliEnvelope(unmutedRes, deps.redact);
    if (unmutedEnv.ok) {
      const unmutedIds = new Set(extractChatDirectoryFromData(unmutedEnv.data).chats.map((c) => c.chatId));
      for (const chat of parsed.chats) {
        if (chat.chatMode !== "p2p" && !unmutedIds.has(chat.chatId)) {
          mutedChatIds.add(chat.chatId);
          chat.muted = true;
        }
      }
    }
  }

  const entry: LarkDirectoryCacheEntry = {
    chats,
    mutedChatIds,
    hasMore: parsed.hasMore,
    refreshedAt: now,
  };
  deps.directoryCache.set(profile, entry);
  return { entry };
}

function summarizeMissingScopeError(error: LarkCliParsedError): string {
  if (error.missingScopes.length > 0) {
    return `缺少飞书权限：${error.missingScopes.join(", ")}`;
  }
  return error.message;
}

async function backfillMessageIdsAndThreads(
  deps: LarkImSyncDeps,
  profile: string,
  auth: ParsedLarkAuthStatus,
  prefix: string[],
  pendingMessageIds: string[],
  pendingThreadIds: string[],
  dirEntry: LarkDirectoryCacheEntry | undefined,
  backfill: boolean,
  now: number,
): Promise<{
  fetched: number;
  inserted: number;
  deduplicated: number;
  remainingMessageIds: string[];
  remainingThreadIds: string[];
  error?: LarkCliParsedError;
}> {
  let fetched = 0;
  let inserted = 0;
  let deduplicated = 0;
  const remainingMessageIds = [...pendingMessageIds];
  const remainingThreadIds = [...pendingThreadIds];

  if (remainingMessageIds.length > 0) {
    const batch = remainingMessageIds.slice(0, 50);
    const mgetRes = await deps.exec(
      [...prefix, "im", "+messages-mget", "--as", "user", "--message-ids", batch.join(","), "--no-reactions", "--format", "json"],
      15_000,
    );
    const env = parseLarkCliEnvelope(mgetRes, deps.redact);
    if (!env.ok) {
      return { fetched, inserted, deduplicated, remainingMessageIds, remainingThreadIds, error: env.error };
    }
    const page = extractImMessagesFromData(env.data);
    fetched += page.messages.length;
    const events = convertAndSortMessages(profile, auth, page.messages, dirEntry, backfill, now, deps.redact);
    if (events.length > 0) {
      const res = await deps.ingest(profile, events);
      inserted += res.inserted;
      deduplicated += res.deduplicated;
    }
    remainingMessageIds.splice(0, batch.length);
  }

  while (remainingThreadIds.length > 0) {
    const threadId = remainingThreadIds[0]!;
    const tRes = await deps.exec(
      [...prefix, "im", "+threads-messages-list", "--as", "user", "--thread", threadId, "--order", "asc", "--page-size", "50", "--no-reactions", "--format", "json"],
      15_000,
    );
    const env = parseLarkCliEnvelope(tRes, deps.redact);
    if (!env.ok) {
      return { fetched, inserted, deduplicated, remainingMessageIds, remainingThreadIds, error: env.error };
    }
    const page = extractImMessagesFromData(env.data);
    fetched += page.messages.length;
    const events = convertAndSortMessages(profile, auth, page.messages, dirEntry, backfill, now, deps.redact);
    if (events.length > 0) {
      const res = await deps.ingest(profile, events);
      inserted += res.inserted;
      deduplicated += res.deduplicated;
    }
    remainingThreadIds.shift();
  }

  return { fetched, inserted, deduplicated, remainingMessageIds, remainingThreadIds };
}

function convertAndSortMessages(
  profile: string,
  auth: ParsedLarkAuthStatus,
  messages: ReturnType<typeof extractImMessagesFromData>["messages"],
  dirEntry: LarkDirectoryCacheEntry | undefined,
  forceBackfill: boolean,
  now: number,
  redact: (s: string) => string,
): RawConnectorEvent[] {
  const events: RawConnectorEvent[] = [];
  for (const msg of messages) {
    const isHistorical = msg.occurredAt !== undefined && now - msg.occurredAt > BACKFILL_AGE_THRESHOLD_MS;
    const ev = buildImConnectorEvent({
      profile,
      message: msg,
      selfOpenId: auth.openId,
      selfUserName: auth.userName,
      chatDirectory: dirEntry?.chats,
      mutedChatIds: dirEntry?.mutedChatIds,
      backfill: forceBackfill || isHistorical,
      redact,
    });
    if (ev) events.push(ev);
  }
  events.sort((a, b) => a.occurredAt - b.occurredAt);
  return events;
}

async function runFallbackChatListSync(
  deps: LarkImSyncDeps,
  profile: string,
  auth: ParsedLarkAuthStatus,
  cursor: LarkSyncCursorRecord,
  routeState: LarkRouteState,
  now: number,
): Promise<LarkChannelDiagnostics> {
  const prefix = profile === "default" ? [] : ["--profile", profile];
  const dirOut = await refreshLarkChatDirectory(deps, profile, { force: false, includeMutedDiff: true });
  if (!dirOut.entry) {
    const err = dirOut.error ?? { kind: "cli_error" as const, missingScopes: [], message: "无法获取飞书会话目录" };
    return {
      status: err.kind === "missing_scope" ? "missing_scope" : "error",
      ...(err.missingScopes.length ? { missingScopes: err.missingScopes } : {}),
      error: summarizeMissingScopeError(err),
    };
  }

  const allChats = [...dirOut.entry.chats.values()];
  const targetChats = allChats.slice(0, FALLBACK_MAX_CHATS);
  const partialByCap = dirOut.entry.hasMore || allChats.length > FALLBACK_MAX_CHATS;
  const chatCursors = { ...(cursor.chatCursors ?? {}) };
  const isColdStart = cursor.completedUntilMs === undefined && Object.keys(chatCursors).length === 0;
  const defaultStart = Math.max(
    (cursor.completedUntilMs ?? now - INITIAL_LOOKBACK_MS) - OVERLAP_MS,
    now - MAX_LOOKBACK_MS,
  );

  let fetchedCount = 0;
  let ingestedCount = 0;
  let deduplicatedCount = 0;
  let pendingCount = 0;
  let partial = partialByCap;
  let firstError: LarkCliParsedError | undefined;
  let succeededChats = 0;
  const pendingThreads: string[] = [];

  for (let i = 0; i < targetChats.length; i += FALLBACK_CONCURRENCY) {
    const slice = targetChats.slice(i, i + FALLBACK_CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (chat) => {
        const prevMs = chatCursors[chat.chatId];
        const startMs = prevMs !== undefined
          ? Math.max(prevMs - OVERLAP_MS, now - MAX_LOOKBACK_MS)
          : defaultStart;
        const res = await deps.exec(
          [
            ...prefix,
            "im",
            "+chat-messages-list",
            "--as",
            "user",
            "--chat-id",
            chat.chatId,
            "--start",
            formatLarkLocalIso(startMs),
            "--end",
            formatLarkLocalIso(now),
            "--order",
            "desc",
            "--page-size",
            String(FALLBACK_CHAT_PAGE_SIZE),
            "--no-reactions",
            "--format",
            "json",
          ],
          15_000,
        );
        return { chat, env: parseLarkCliEnvelope(res, deps.redact) };
      }),
    );

    for (const { chat, env } of results) {
      if (!env.ok) {
        if (!firstError) firstError = env.error;
        if (env.error.kind === "missing_scope") {
          routeState.chatListMissingScopes = env.error.missingScopes;
        }
        continue;
      }
      succeededChats += 1;
      const page = extractImMessagesFromData(env.data, {
        chatId: chat.chatId,
        chatName: chat.name,
        chatType: chat.chatMode,
      });
      fetchedCount += page.messages.length;
      if (page.hasMore || page.partial) {
        partial = true;
        pendingCount += page.pendingThreadIds.length + (page.hasMore ? 1 : 0);
      }
      for (const tid of page.pendingThreadIds) {
        if (!pendingThreads.includes(tid)) pendingThreads.push(tid);
      }
      const events = convertAndSortMessages(profile, auth, page.messages, dirOut.entry, isColdStart, now, deps.redact);
      if (events.length > 0) {
        const res = await deps.ingest(profile, events);
        ingestedCount += res.inserted;
        deduplicatedCount += res.deduplicated;
      }
      chatCursors[chat.chatId] = now;
    }
  }

  if (pendingThreads.length > 0) {
    const bf = await backfillMessageIdsAndThreads(
      deps,
      profile,
      auth,
      prefix,
      [],
      pendingThreads.slice(0, 5),
      dirOut.entry,
      isColdStart,
      now,
    );
    fetchedCount += bf.fetched;
    ingestedCount += bf.inserted;
    deduplicatedCount += bf.deduplicated;
    if (bf.remainingThreadIds.length > 0 || pendingThreads.length > 5) {
      partial = true;
      pendingCount += bf.remainingThreadIds.length + Math.max(0, pendingThreads.length - 5);
    }
  }

  if (succeededChats === 0 && targetChats.length > 0 && firstError) {
    await deps.cursorStore.save({
      ...cursor,
      routeState,
      updatedAt: now,
    });
    return {
      status: firstError.kind === "missing_scope" ? "missing_scope" : "error",
      ...(firstError.missingScopes.length ? { missingScopes: firstError.missingScopes } : {}),
      error: summarizeMissingScopeError(firstError),
    };
  }

  await deps.cursorStore.save({
    accountKey: cursor.accountKey,
    channel: "im",
    completedUntilMs: now,
    chatCursors,
    routeState: { ...routeState, mode: "chat_list" },
    updatedAt: now,
  });

  return {
    status: partial ? "partial" : "ok",
    fetchedCount,
    ingestedCount,
    deduplicatedCount,
    ...(pendingCount > 0 ? { pendingCount } : {}),
    coverage: partial ? "partial" : "complete",
    ...(partial
      ? {
          note: partialByCap
            ? `降级逐会话同步，当前覆盖最近活跃的 ${targetChats.length} 个会话`
            : "部分会话达到单轮页数或线程展开上限，将在后续轮次继续补齐",
        }
      : {}),
  };
}

export async function syncLarkImChannel(
  deps: LarkImSyncDeps,
  profile: string,
  auth: ParsedLarkAuthStatus,
): Promise<LarkChannelDiagnostics> {
  const now = (deps.now ?? Date.now)();
  const accountKey = buildLarkAccountKey(profile, auth);
  const scopesFingerprint = buildScopesFingerprint(auth);
  const existing = await deps.cursorStore.get(accountKey, "im");
  const cursor: LarkSyncCursorRecord = existing ?? {
    accountKey,
    channel: "im",
    updatedAt: now,
  };

  // Reset cached route degradation whenever user scopes / grantedAt change so recovery is automatic.
  const routeState: LarkRouteState =
    cursor.routeState?.scopesFingerprint === scopesFingerprint
      ? { ...cursor.routeState }
      : { scopesFingerprint };

  const prefix = profile === "default" ? [] : ["--profile", profile];
  const dirOut = await refreshLarkChatDirectory(deps, profile, { force: false, includeMutedDiff: true });

  // If search was already proven missing_scope for the current scopesFingerprint, go straight to fallback.
  if (routeState.mode === "chat_list" && routeState.searchMissingScopes?.length) {
    return runFallbackChatListSync(deps, profile, auth, cursor, routeState, now);
  }

  const isColdStart = cursor.completedUntilMs === undefined && !cursor.pendingWindow;
  const activeWindow: LarkPendingWindow = cursor.pendingWindow
    ? { ...cursor.pendingWindow }
    : {
        startMs: cursor.completedUntilMs !== undefined
          ? Math.max(cursor.completedUntilMs - OVERLAP_MS, now - MAX_LOOKBACK_MS)
          : now - INITIAL_LOOKBACK_MS,
        endMs: now,
        backfill: isColdStart,
      };

  let fetchedCount = 0;
  let ingestedCount = 0;
  let deduplicatedCount = 0;
  let pageToken = activeWindow.pageToken;
  let pendingMessageIds = [...(activeWindow.pendingMessageIds ?? [])];
  let pendingThreadIds = [...(activeWindow.pendingThreadIds ?? [])];
  let partialNote: string | undefined;
  let hasMoreAfterBudget = false;

  // 1. Drain any pending message IDs / threads left from a previous partial search page.
  if (pendingMessageIds.length > 0 || pendingThreadIds.length > 0) {
    const bf = await backfillMessageIdsAndThreads(
      deps,
      profile,
      auth,
      prefix,
      pendingMessageIds,
      pendingThreadIds,
      dirOut.entry,
      Boolean(activeWindow.backfill),
      now,
    );
    fetchedCount += bf.fetched;
    ingestedCount += bf.inserted;
    deduplicatedCount += bf.deduplicated;
    pendingMessageIds = bf.remainingMessageIds;
    pendingThreadIds = bf.remainingThreadIds;
    if (bf.error) {
      await deps.cursorStore.save({
        ...cursor,
        pendingWindow: {
          ...activeWindow,
          ...(pageToken ? { pageToken } : {}),
          ...(pendingMessageIds.length ? { pendingMessageIds } : {}),
          ...(pendingThreadIds.length ? { pendingThreadIds } : {}),
        },
        routeState,
        updatedAt: now,
      });
      return {
        status: "partial",
        fetchedCount,
        ingestedCount,
        deduplicatedCount,
        pendingCount: pendingMessageIds.length + pendingThreadIds.length,
        coverage: "partial",
        error: summarizeMissingScopeError(bf.error),
      };
    }
  }

  // 2. Fetch search pages one-by-one (<=50 msgs per spawn to stay well under 512 KiB stdout cap).
  let pagesFetched = 0;
  let finishedWindow = false;
  while (pagesFetched < SEARCH_MAX_PAGES_PER_SYNC) {
    const args = [
      ...prefix,
      "im",
      "+messages-search",
      "--as",
      "user",
      "--query=",
      "--start",
      formatLarkLocalIso(activeWindow.startMs),
      "--end",
      formatLarkLocalIso(activeWindow.endMs),
      "--page-size",
      String(SEARCH_PAGE_SIZE),
      "--no-reactions",
      "--format",
      "json",
      ...(pageToken ? ["--page-token", pageToken] : []),
    ];
    const searchRes = await deps.exec(args, 18_000);
    const env = parseLarkCliEnvelope(searchRes, deps.redact);
    if (!env.ok) {
      if (env.error.kind === "missing_scope" && pagesFetched === 0 && !cursor.pendingWindow) {
        routeState.mode = "chat_list";
        routeState.searchMissingScopes = env.error.missingScopes;
        return runFallbackChatListSync(deps, profile, auth, cursor, routeState, now);
      }
      // Preserve pendingWindow so transient failures / rate limits resume cleanly next round.
      await deps.cursorStore.save({
        ...cursor,
        pendingWindow: {
          ...activeWindow,
          ...(pageToken ? { pageToken } : {}),
          ...(pendingMessageIds.length ? { pendingMessageIds } : {}),
          ...(pendingThreadIds.length ? { pendingThreadIds } : {}),
        },
        routeState,
        updatedAt: now,
      });
      return {
        status: pagesFetched > 0 ? "partial" : env.error.kind === "missing_scope" ? "missing_scope" : "error",
        fetchedCount,
        ingestedCount,
        deduplicatedCount,
        ...(env.error.missingScopes.length ? { missingScopes: env.error.missingScopes } : {}),
        coverage: "partial",
        error: summarizeMissingScopeError(env.error),
      };
    }

    pagesFetched += 1;
    const page = extractImMessagesFromData(env.data);
    fetchedCount += page.messages.length;
    if (page.note) partialNote = page.note;
    else if (page.notice) partialNote = page.notice;

    if (page.pendingMessageIds.length > 0) {
      for (const id of page.pendingMessageIds) {
        if (!pendingMessageIds.includes(id)) pendingMessageIds.push(id);
      }
    }
    if (page.pendingThreadIds.length > 0) {
      for (const id of page.pendingThreadIds) {
        if (!pendingThreadIds.includes(id)) pendingThreadIds.push(id);
      }
    }

    // Refresh chat directory if we see a p2p chat missing from cache.
    const needsDirRefresh = page.messages.some(
      (m) => !m.chatName && !dirOut.entry?.chats.has(m.chatId),
    );
    const effectiveDir = needsDirRefresh
      ? (await refreshLarkChatDirectory(deps, profile, { force: true, includeMutedDiff: true })).entry ?? dirOut.entry
      : dirOut.entry;

    const events = convertAndSortMessages(
      profile,
      auth,
      page.messages,
      effectiveDir,
      Boolean(activeWindow.backfill),
      now,
      deps.redact,
    );
    if (events.length > 0) {
      // Commit THIS page to SQLite before advancing pageToken or cursor.
      const res = await deps.ingest(profile, events);
      ingestedCount += res.inserted;
      deduplicatedCount += res.deduplicated;
    }

    pageToken = page.hasMore ? page.pageToken : undefined;
    if (!page.hasMore || !pageToken) {
      finishedWindow = true;
      break;
    }
    if (pagesFetched >= SEARCH_MAX_PAGES_PER_SYNC) {
      hasMoreAfterBudget = true;
    }
  }

  // If this round produced pending message IDs (mget partial fallback), attempt immediate 1-batch recovery.
  if (pendingMessageIds.length > 0) {
    const bf = await backfillMessageIdsAndThreads(
      deps,
      profile,
      auth,
      prefix,
      pendingMessageIds,
      pendingThreadIds,
      dirOut.entry,
      Boolean(activeWindow.backfill),
      now,
    );
    fetchedCount += bf.fetched;
    ingestedCount += bf.inserted;
    deduplicatedCount += bf.deduplicated;
    pendingMessageIds = bf.remainingMessageIds;
    pendingThreadIds = bf.remainingThreadIds;
  }

  const stillPending = !finishedWindow || hasMoreAfterBudget || pendingMessageIds.length > 0 || pendingThreadIds.length > 0;
  if (stillPending) {
    await deps.cursorStore.save({
      accountKey,
      channel: "im",
      ...(cursor.completedUntilMs !== undefined ? { completedUntilMs: cursor.completedUntilMs } : {}),
      pendingWindow: {
        startMs: activeWindow.startMs,
        endMs: activeWindow.endMs,
        ...(pageToken ? { pageToken } : {}),
        ...(pendingMessageIds.length ? { pendingMessageIds } : {}),
        ...(pendingThreadIds.length ? { pendingThreadIds } : {}),
        ...(activeWindow.backfill ? { backfill: true } : {}),
      },
      routeState: { ...routeState, mode: "search" },
      updatedAt: now,
    });
    return {
      status: "partial",
      fetchedCount,
      ingestedCount,
      deduplicatedCount,
      pendingCount: pendingMessageIds.length + pendingThreadIds.length + (hasMoreAfterBudget ? 1 : 0),
      coverage: "partial",
      note: partialNote || "单轮消息数超过分页上限，剩余区间已保留断点将在下一轮自动补齐",
    };
  }

  await deps.cursorStore.save({
    accountKey,
    channel: "im",
    completedUntilMs: activeWindow.endMs,
    routeState: { ...routeState, mode: "search" },
    updatedAt: now,
  });

  return {
    status: partialNote ? "partial" : "ok",
    fetchedCount,
    ingestedCount,
    deduplicatedCount,
    coverage: partialNote ? "partial" : "complete",
    ...(partialNote ? { note: partialNote } : {}),
  };
}
