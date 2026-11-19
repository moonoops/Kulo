export interface DesktopNotificationPayload {
  title: string;
  body?: string;
  topicId?: string;
}

function sanitizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
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
  return {
    title,
    ...(body ? { body } : {}),
    ...(topicId ? { topicId } : {}),
  };
}

export interface DesktopNotificationControllerOptions {
  isSupported: () => boolean;
  isWindowFocused: () => boolean;
  showNotification: (payload: DesktopNotificationPayload, onClick: () => void) => void;
  onFocusWindow: (topicId?: string) => void;
}

export function createDesktopNotifications(options: DesktopNotificationControllerOptions) {
  return {
    notify(raw: unknown): boolean {
      const payload = normalizeDesktopNotificationPayload(raw);
      if (!payload) return false;
      if (!options.isSupported() || options.isWindowFocused()) return false;
      options.showNotification(payload, () => {
        options.onFocusWindow(payload.topicId);
      });
      return true;
    },
  };
}
