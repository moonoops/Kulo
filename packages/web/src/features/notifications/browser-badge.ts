const TITLE_BADGE_PREFIX = /^(?:\((?:\d+|99\+)\)|•)\s+/;
const NOTIFICATION_CHANNEL_NAME = "kulo:notifications";
const MAX_CLAIMED_EVENTS = 200;

export interface BrowserBadgeController {
  set(count: number | boolean): void;
  getCount(): number;
  isActive(): boolean;
  dispose(): void;
}

function stripTitlePrefix(title: string): string {
  return title.replace(TITLE_BADGE_PREFIX, "");
}

function normalizeBadgeCount(value: number | boolean): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  return Number.isFinite(value) && value > 0 ? Math.min(9999, Math.floor(value)) : 0;
}

function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function createBrowserBadgeController(): BrowserBadgeController {
  let count = 0;
  let originalFaviconHref: string | null = null;
  let badgedFaviconHref: string | null = null;
  let faviconRenderInFlight = false;

  const findIconLink = (): HTMLLinkElement | null => {
    if (typeof document === "undefined") return null;
    return document.querySelector<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"]');
  };

  const applyFavicon = (showBadge: boolean) => {
    const link = findIconLink();
    if (!link) return;
    if (originalFaviconHref === null) {
      originalFaviconHref = link.getAttribute("href") ?? "/favicon-32.png";
    }
    if (!showBadge) {
      if (link.getAttribute("href") !== originalFaviconHref) {
        link.setAttribute("href", originalFaviconHref);
      }
      return;
    }
    if (badgedFaviconHref) {
      link.setAttribute("href", badgedFaviconHref);
      return;
    }
    if (faviconRenderInFlight || typeof Image === "undefined" || typeof document === "undefined") return;
    faviconRenderInFlight = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      faviconRenderInFlight = false;
      try {
        const size = 32;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, size, size);
        // Subtle cutout ring + crisp red notification dot at top-right.
        const cx = 25;
        const cy = 7;
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(cx, cy, 7.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.fillStyle = "#FF3B30";
        ctx.beginPath();
        ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
        ctx.fill();
        badgedFaviconHref = canvas.toDataURL("image/png");
        if (count > 0) {
          const currentLink = findIconLink();
          if (currentLink) currentLink.setAttribute("href", badgedFaviconHref);
        }
      } catch {
        // Ignore canvas export failures in restricted environments.
      }
    };
    img.onerror = () => {
      faviconRenderInFlight = false;
    };
    img.src = originalFaviconHref;
  };

  const applyTitle = (badgeCount: number) => {
    if (typeof document === "undefined") return;
    const base = stripTitlePrefix(document.title || "Kulo");
    const next = badgeCount > 0 ? `(${formatBadgeCount(badgeCount)}) ${base}` : base;
    if (document.title !== next) document.title = next;
  };

  return {
    set(next: number | boolean): void {
      const normalized = normalizeBadgeCount(next);
      if (normalized === count) return;
      count = normalized;
      applyTitle(count);
      applyFavicon(count > 0);
    },
    getCount(): number {
      return count;
    },
    isActive(): boolean {
      return count > 0;
    },
    dispose(): void {
      count = 0;
      applyTitle(0);
      applyFavicon(false);
    },
  };
}

let sharedChannel: BroadcastChannel | null | undefined;
const claimedEvents = new Set<string>();
let lastBrowserSoundAt = -Infinity;

function rememberClaimedEvent(eventId: string): void {
  claimedEvents.add(eventId);
  if (claimedEvents.size > MAX_CLAIMED_EVENTS) {
    const oldest = claimedEvents.values().next().value;
    if (oldest !== undefined) claimedEvents.delete(oldest);
  }
}

function getNotificationChannel(): BroadcastChannel | null {
  if (sharedChannel !== undefined) return sharedChannel;
  if (typeof BroadcastChannel === "undefined") {
    sharedChannel = null;
    return null;
  }
  try {
    const channel = new BroadcastChannel(NOTIFICATION_CHANNEL_NAME);
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as { eventId?: unknown }).eventId === "string") {
        rememberClaimedEvent((data as { eventId: string }).eventId);
      }
    });
    sharedChannel = channel;
    return channel;
  } catch {
    sharedChannel = null;
    return null;
  }
}

function playBrowserNotificationChime(): void {
  const now = Date.now();
  if (now - lastBrowserSoundAt < 3_000) return;
  if (typeof AudioContext === "undefined") return;
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.09);
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => { void ctx.close().catch(() => {}); };
    lastBrowserSoundAt = now;
  } catch {
    // Ignore autoplay-blocked audio context failures.
  }
}

export function deliverBrowserNotification(
  payload: { title: string; body?: string; topicId?: string; eventId?: string; dedupeKey?: string },
  options: { sound: boolean; force?: boolean; onOpen?: (topicId: string) => void },
): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  if (!options.force && payload.eventId) {
    if (claimedEvents.has(payload.eventId)) return false;
    rememberClaimedEvent(payload.eventId);
    getNotificationChannel()?.postMessage({ eventId: payload.eventId });
  }
  try {
    const notification = new Notification(payload.title, {
      ...(payload.body ? { body: payload.body } : {}),
      ...(payload.dedupeKey ? { tag: payload.dedupeKey } : {}),
      silent: !options.sound,
    });
    notification.onclick = () => {
      window.focus();
      if (payload.topicId) options.onOpen?.(payload.topicId);
      notification.close();
    };
    if (options.sound) playBrowserNotificationChime();
    return true;
  } catch {
    return false;
  }
}
