import type { ConversationView, EntryRecord, InboxState } from "@earendil-works/pi-durable";

export interface ChatMessageSource {
  deviceId: string;
  name: string;
  kind: "computer" | "android";
}

export function chatRoutingData(entry: EntryRecord | undefined) {
  const raw = entry?.kind === "kulo.user" || entry?.kind === "kulo.voice.delegation" ? entry.data : undefined;
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
  const source = data?.source as unknown as Partial<ChatMessageSource> | undefined;
  return {
    source: source && typeof source.deviceId === "string" && typeof source.name === "string" &&
      (source.kind === "computer" || source.kind === "android") ? source as ChatMessageSource : undefined,
    targetDeviceId: typeof data?.targetDeviceId === "string" ? data.targetDeviceId : undefined,
    requestId: typeof data?.requestId === "string" ? data.requestId : undefined,
    text: typeof data?.text === "string" ? data.text : undefined,
  };
}

export interface ChatReceiptData {
  requestId?: string;
  createdAt?: number;
}

export function chatReceiptData(value: unknown): ChatReceiptData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const data = value as Record<string, unknown>;
  return {
    ...(typeof data.requestId === "string" && data.requestId ? { requestId: data.requestId } : {}),
    ...(typeof data.createdAt === "number" && Number.isFinite(data.createdAt) ? { createdAt: data.createdAt } : {}),
  };
}

/** These records exist only in the display projection; Pi alone places inputs in model history. */
export function queuedChatEntries(view: ConversationView): {
  entries: EntryRecord[];
  deliveries: Map<number, { submissionId: number; delivery: "queued" | "paused" }>;
} {
  const inbox = view.docs["pi.inbox"] as unknown as InboxState | undefined;
  const live = view.docs["pi.live"] as { run?: unknown } | undefined;
  const deliveries = new Map<number, { submissionId: number; delivery: "queued" | "paused" }>();
  const entries = (inbox?.items ?? []).flatMap((item) => {
    if (item.mode === "write") return [];
    const kind = item.entry?.kind;
    if (kind !== "kulo.user") return [];
    const raw = item.entry?.data;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const data = raw as Record<string, unknown>;
    if (data.kuloContentVersion !== 1 || typeof data.text !== "string" || !Array.isArray(data.attachments)) return [];
    const receipt = chatReceiptData(data);
    const id = -Number(item.id);
    deliveries.set(id, { submissionId: Number(item.id), delivery: live?.run ? "queued" : "paused" });
    return [{
      id, conversationId: view.conversation.id, kind, data,
      model: [{ role: "user", content: data.text, timestamp: receipt.createdAt ?? 0 }],
    } as unknown as EntryRecord];
  });
  return { entries, deliveries };
}

