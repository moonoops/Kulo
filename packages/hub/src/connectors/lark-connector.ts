import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import type { LarkConnectorSnapshot, LarkProfileView, RawConnectorEvent } from "@kulo/protocol";
import { isSensitiveNotificationPayload } from "@kulo/protocol";
import { buildAugmentedHostPath, findHostExecutable } from "../host-path.js";

const MAX_OUTPUT_BYTES = 512 * 1024;
const SAFE_PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_CHAT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type LarkExecResult = { ok: boolean; stdout: string; stderr: string };
export type LarkExecRunner = (exe: string, args: string[], timeoutMs: number) => Promise<LarkExecResult>;

export interface LarkPersistedConfig {
  enabled: boolean;
  selectedProfiles: string[];
}

export interface LarkConnectorServiceHost {
  persistedConfig(): Promise<LarkPersistedConfig>;
  saveConfig(next: LarkPersistedConfig): Promise<void>;
  redact(text: string): string;
  onEvents: (profile: string, events: RawConnectorEvent[]) => Promise<void>;
  executablePath?: string;
  runner?: LarkExecRunner;
  pollIntervalMs?: number;
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
        env: {
          PATH: buildAugmentedHostPath(),
          HOME: os.homedir(),
          TMPDIR: os.tmpdir(),
          LANG: "en_US.UTF-8",
        },
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            stdout: String(stdout ?? "").slice(0, MAX_OUTPUT_BYTES),
            stderr: String(stderr ?? error.message ?? "").slice(0, 2_000),
          });
          return;
        }
        resolve({
          ok: true,
          stdout: String(stdout ?? "").slice(0, MAX_OUTPUT_BYTES),
          stderr: String(stderr ?? "").slice(0, 2_000),
        });
      },
    );
  });
}

export function parseLarkProfileList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return ["default"];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { profiles?: unknown[] }).profiles)
          ? (parsed as { profiles: unknown[] }).profiles
          : [];
      const names = list
        .map((item) => (typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name : ""))
        .map((name) => name.trim())
        .filter((name) => SAFE_PROFILE_RE.test(name));
      return names.length > 0 ? [...new Set(names)] : ["default"];
    } catch {
      // fall through to line parser
    }
  }
  const names = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[*•\-\s]+/, "").split(/\s+/)[0]?.trim() ?? "")
    .filter((name) => name && SAFE_PROFILE_RE.test(name) && !["name", "profile", "profiles"].includes(name.toLowerCase()));
  return names.length > 0 ? [...new Set(names)] : ["default"];
}

function classifyOrganizationKind(name: string, brand?: string): "personal" | "enterprise" | "unknown" {
  const lower = `${name} ${brand ?? ""}`.toLowerCase();
  if (/(?:personal|home|private|个人|私有)/i.test(lower)) return "personal";
  if (/(?:corp|work|ent|company|org|team|企业|公司|工作)/i.test(lower)) return "enterprise";
  return "unknown";
}

export class LarkConnectorService {
  readonly #host: LarkConnectorServiceHost;
  readonly #pollIntervalMs: number;
  #pollTimer: NodeJS.Timeout | null = null;
  #syncInFlight = false;
  #lastSyncAt: number | undefined;
  #lastError: string | undefined;
  #cachedProfiles: LarkProfileView[] | null = null;
  #cachedProfilesAt = 0;
  #seenKeys = new Set<string>();
  #closed = false;

  constructor(host: LarkConnectorServiceHost) {
    this.#host = host;
    this.#pollIntervalMs = host.pollIntervalMs ?? 90_000;
  }

  #resolveExe(): string | undefined {
    return this.#host.runner ? (this.#host.executablePath ?? "lark-cli") : findLarkCliExecutable(this.#host.executablePath);
  }

  async #exec(args: string[], timeoutMs = 12_000): Promise<LarkExecResult> {
    const exe = this.#resolveExe();
    if (!exe) return { ok: false, stdout: "", stderr: "未检测到 lark-cli，请先安装并登录飞书 CLI。" };
    return (this.#host.runner ?? defaultLarkRunner)(exe, args, timeoutMs);
  }

  async start(): Promise<void> {
    const cfg = await this.#host.persistedConfig();
    if (cfg.enabled) {
      this.#schedulePolling();
    }
  }

  async listProfiles(): Promise<LarkProfileView[]> {
    const exe = this.#resolveExe();
    if (!exe) return [];
    const listRes = await this.#exec(["profile", "list"], 6_000);
    const names = listRes.ok ? parseLarkProfileList(listRes.stdout) : ["default"];
    const views: LarkProfileView[] = [];

    for (const name of names.slice(0, 8)) {
      const args = name === "default" ? ["auth", "status"] : ["--profile", name, "auth", "status"];
      const authRes = await this.#exec(args, 8_000);
      if (!authRes.ok) {
        views.push({
          name,
          ready: false,
          organizationKind: classifyOrganizationKind(name),
          error: this.#host.redact(authRes.stderr || "未授权").slice(0, 200),
        });
        continue;
      }
      try {
        const parsed = JSON.parse(authRes.stdout) as {
          brand?: string;
          identities?: { user?: { available?: boolean; userName?: string }; bot?: { available?: boolean } };
        };
        const userAvail = Boolean(parsed.identities?.user?.available);
        const botAvail = Boolean(parsed.identities?.bot?.available);
        views.push({
          name,
          ...(typeof parsed.brand === "string" ? { brand: parsed.brand } : {}),
          ...(typeof parsed.identities?.user?.userName === "string" ? { userName: parsed.identities.user.userName } : {}),
          ready: userAvail || botAvail,
          organizationKind: classifyOrganizationKind(name, parsed.brand),
        });
      } catch {
        views.push({
          name,
          ready: true,
          organizationKind: classifyOrganizationKind(name),
        });
      }
    }
    return views;
  }

  async status(options: { force?: boolean } = {}): Promise<LarkConnectorSnapshot> {
    const cfg = await this.#host.persistedConfig();
    const cliAvailable = Boolean(this.#resolveExe());
    let profiles: LarkProfileView[] = [];
    if (cliAvailable) {
      if (!options.force && this.#cachedProfiles && Date.now() - this.#cachedProfilesAt < 20_000) {
        profiles = this.#cachedProfiles;
      } else {
        profiles = await this.listProfiles();
        this.#cachedProfiles = profiles;
        this.#cachedProfilesAt = Date.now();
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
      this.#schedulePolling();
      void this.syncNow().catch(() => {});
    } else {
      this.#stopPolling();
    }
    return this.status({ force: true });
  }

  async syncNow(): Promise<{ syncedProfiles: number; ingestedCount: number }> {
    if (this.#closed || this.#syncInFlight) return { syncedProfiles: 0, ingestedCount: 0 };
    const cfg = await this.#host.persistedConfig();
    if (!cfg.enabled || !this.#resolveExe()) return { syncedProfiles: 0, ingestedCount: 0 };
    this.#syncInFlight = true;
    let syncedProfiles = 0;
    let ingestedCount = 0;
    try {
      const profiles = cfg.selectedProfiles.length > 0
        ? cfg.selectedProfiles
        : (await this.listProfiles()).filter((p) => p.ready).map((p) => p.name);
      for (const profile of profiles) {
        const prefix = profile === "default" ? [] : ["--profile", profile];
        const events: RawConnectorEvent[] = [];

        // Fetch upcoming calendar agenda (read-only) for cross-app awareness.
        const agendaRes = await this.#exec([...prefix, "calendar", "+agenda"], 12_000);
        if (agendaRes.ok && agendaRes.stdout.trim()) {
          const parsed = this.#extractCalendarEvents(profile, agendaRes.stdout);
          events.push(...parsed);
        }

        const fresh = events.filter((ev) => {
          const key = `${profile}:${ev.nativeEventId}:${ev.eventVersion}`;
          if (this.#seenKeys.has(key)) return false;
          if (isSensitiveNotificationPayload(ev)) return false;
          this.#seenKeys.add(key);
          return true;
        });
        if (this.#seenKeys.size > 4_000) {
          this.#seenKeys = new Set([...this.#seenKeys].slice(-2_000));
        }
        if (fresh.length > 0) {
          await this.#host.onEvents(profile, fresh);
          ingestedCount += fresh.length;
        }
        syncedProfiles += 1;
      }
      this.#lastSyncAt = Date.now();
      this.#lastError = undefined;
    } catch (error) {
      this.#lastError = this.#host.redact(error instanceof Error ? error.message : "飞书同步失败");
    } finally {
      this.#syncInFlight = false;
    }
    return { syncedProfiles, ingestedCount };
  }

  #extractCalendarEvents(profile: string, raw: string): RawConnectorEvent[] {
    const out: RawConnectorEvent[] = [];
    try {
      const data = JSON.parse(raw) as unknown;
      const items = Array.isArray(data)
        ? data
        : data && typeof data === "object"
          ? ((data as { events?: unknown[]; items?: unknown[] }).events ?? (data as { items?: unknown[] }).items ?? [])
          : [];
      for (const entry of items.slice(0, 20)) {
        if (!entry || typeof entry !== "object") continue;
        const obj = entry as Record<string, unknown>;
        const id = String(obj.event_id ?? obj.id ?? "").trim();
        const title = String(obj.summary ?? obj.title ?? "").trim();
        if (!id || !title) continue;
        const startRaw = obj.start_time ?? obj.start ?? obj.startTime;
        const occurredAt = typeof startRaw === "number"
          ? (startRaw < 1e12 ? startRaw * 1000 : startRaw)
          : typeof startRaw === "string" && !Number.isNaN(Date.parse(startRaw))
            ? Date.parse(startRaw)
            : Date.now();
        out.push({
          nativeEventId: `lark:cal:${id}`,
          eventVersion: String(obj.updated_at ?? occurredAt),
          appId: `lark:${profile}`,
          appLabel: profile === "default" ? "飞书" : `飞书 (${profile})`,
          threadHint: id,
          sender: "飞书日历",
          title: this.#host.redact(title).slice(0, 200),
          body: this.#host.redact(String(obj.description ?? title)).slice(0, 800),
          occurredAt: Math.max(0, Math.floor(occurredAt)),
          fidelity: "structured",
        });
      }
    } catch {
      // Non-JSON agenda output ignored cleanly
    }
    return out;
  }

  /**
   * Strictly executed ONLY after explicit L2 user confirmation (`confirm_action`).
   */
  async executeConfirmedReply(params: {
    profile?: string;
    chatId: string;
    text: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const profile = params.profile?.trim() || "default";
    if (!SAFE_PROFILE_RE.test(profile)) {
      return { ok: false, error: "飞书 profile 名称无效" };
    }
    const chatId = params.chatId.trim();
    if (!SAFE_CHAT_ID_RE.test(chatId) || chatId.startsWith("-")) {
      return { ok: false, error: "飞书会话 ID 格式无效" };
    }
    const text = params.text.trim().slice(0, 4_000);
    if (!text) return { ok: false, error: "回复内容不能为空" };
    const prefix = profile === "default" ? [] : ["--profile", profile];
    const res = await this.#exec([...prefix, "im", "+messages-send", "--chat-id", chatId, "--text", text], 15_000);
    if (!res.ok) {
      return { ok: false, error: this.#host.redact(res.stderr || "发送飞书回复失败").slice(0, 400) };
    }
    return { ok: true };
  }

  #schedulePolling(): void {
    this.#stopPolling();
    if (this.#closed) return;
    this.#pollTimer = setInterval(() => {
      void this.syncNow().catch(() => {});
    }, this.#pollIntervalMs);
    this.#pollTimer.unref();
  }

  #stopPolling(): void {
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
