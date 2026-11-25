export interface DesktopNotificationPayload {
  title: string;
  body?: string;
  topicId?: string;
  eventId?: string;
  dedupeKey?: string;
  force?: boolean;
  soundOverride?: boolean;
}

export interface RenderedDesktopNotificationPayload extends DesktopNotificationPayload {
  silent: boolean;
}

export function normalizeDesktopBadgeCount(raw: unknown): number | null {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.min(9999, Math.floor(raw));
  }
  return null;
}

export function formatDockBadgeText(count: number): string {
  const normalized = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (normalized <= 0) return "";
  return normalized > 99 ? "99+" : String(normalized);
}

function sanitizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
}

function sanitizeSafeToken(value: unknown, maxLength = 120): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) && value.length <= maxLength
    ? value
    : undefined;
}

export function normalizeDesktopNotificationPayload(raw: unknown): DesktopNotificationPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const title = sanitizeText(input.title, 120);
  if (!title) return null;
  const body = sanitizeText(input.body, 300);
  const topicId = typeof input.topicId === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(input.topicId)
    ? input.topicId
    : undefined;
  const eventId = sanitizeSafeToken(input.eventId, 160);
  const dedupeKey = sanitizeSafeToken(input.dedupeKey, 160);
  const force = input.force === true ? true : undefined;
  const soundOverride = input.soundOverride === true ? true : undefined;
  return {
    title,
    ...(body ? { body } : {}),
    ...(topicId ? { topicId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(force ? { force } : {}),
    ...(soundOverride ? { soundOverride } : {}),
  };
}

export interface DesktopNotificationControllerOptions {
  isSupported: () => boolean;
  isWindowFocused: () => boolean;
  getPreferences?: () => { enabled: boolean; sound: boolean };
  coalesceMs?: number;
  soundCooldownMs?: number;
  now?: () => number;
  showNotification: (payload: RenderedDesktopNotificationPayload, onClick: () => void) => void;
  onFocusWindow: (topicId?: string) => void;
}

const MAX_RECENT_EVENT_IDS = 200;

export function createDesktopNotifications(options: DesktopNotificationControllerOptions) {
  const seenEventIds = new Set<string>();
  const pendingByKey = new Map<string, { payload: DesktopNotificationPayload; timer: ReturnType<typeof setTimeout> }>();
  const coalesceMs = options.coalesceMs ?? 1_200;
  const soundCooldownMs = options.soundCooldownMs ?? 3_000;
  const now = options.now ?? (() => Date.now());
  let lastSoundAt = -Infinity;
  let disposed = false;

  const rememberEventId = (eventId: string) => {
    seenEventIds.add(eventId);
    if (seenEventIds.size > MAX_RECENT_EVENT_IDS) {
      const oldest = seenEventIds.values().next().value;
      if (oldest !== undefined) seenEventIds.delete(oldest);
    }
  };

  const deliver = (payload: DesktopNotificationPayload): boolean => {
    if (disposed || !options.isSupported()) return false;
    const prefs = options.getPreferences?.() ?? { enabled: true, sound: false };
    if (!payload.force && (!prefs.enabled || options.isWindowFocused())) return false;
    const timestamp = now();
    const wantsSound = prefs.sound || (payload.soundOverride === true && (prefs.enabled || payload.force === true));
    let silent = !wantsSound;
    if (!silent && !payload.force && timestamp - lastSoundAt < soundCooldownMs) {
      silent = true;
    }
    if (!silent) lastSoundAt = timestamp;
    options.showNotification({ ...payload, silent }, () => {
      options.onFocusWindow(payload.topicId);
    });
    return true;
  };

  return {
    notify(raw: unknown): boolean {
      if (disposed) return false;
      const payload = normalizeDesktopNotificationPayload(raw);
      if (!payload) return false;
      if (!options.isSupported()) return false;
      const prefs = options.getPreferences?.() ?? { enabled: true, sound: false };
      if (!payload.force && (!prefs.enabled || options.isWindowFocused())) return false;
      if (payload.eventId) {
        if (seenEventIds.has(payload.eventId)) return false;
        rememberEventId(payload.eventId);
      }

      if (!payload.force && payload.dedupeKey && coalesceMs > 0) {
        const existing = pendingByKey.get(payload.dedupeKey);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(() => {
          pendingByKey.delete(payload.dedupeKey!);
          deliver(payload);
        }, coalesceMs);
        timer.unref?.();
        pendingByKey.set(payload.dedupeKey, { payload, timer });
        return true;
      }

      return deliver(payload);
    },
    dispose(): void {
      disposed = true;
      for (const entry of pendingByKey.values()) clearTimeout(entry.timer);
      pendingByKey.clear();
    },
  };
}
