import { redactSensitiveText, UiActionInputSchema, UiValuesSchema, type UiActionInput, type UiCardSnapshot } from "@moco/protocol";

export type CardValues = UiActionInput["values"];

export interface CardDraft {
  baseRevision: number;
  values: CardValues;
  dirty: boolean;
  expanded: boolean;
  pending?: UiActionInput;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DraftReadResult {
  draft: CardDraft;
  storageError?: string;
}

const sessionDrafts = new Map<string, CardDraft>();

function storageKey(cardId: string): string {
  return `moco:ui-card-draft:v1:${cardId}`;
}

export function cardInitialValues(card: UiCardSnapshot): CardValues {
  const state = card.spec.state;
  const initial = state && typeof state.values === "object" && state.values !== null && !Array.isArray(state.values)
    ? state.values as CardValues
    : {};
  const defaults: CardValues = {};
  for (const element of Object.values(card.spec.elements)) {
    const field = element.props.field;
    if (typeof field !== "string") continue;
    if (element.type === "Switch" || element.type === "Checkbox") defaults[field] = false;
    if (element.type === "Slider") defaults[field] = typeof element.props.min === "number" ? element.props.min : 0;
    if (element.type === "Choice" && element.props.multiple) defaults[field] = [];
  }
  return structuredClone({ ...defaults, ...initial, ...card.committedState });
}

export function createCardDraft(card: UiCardSnapshot): CardDraft {
  return {
    baseRevision: card.revision,
    values: cardInitialValues(card),
    dirty: false,
    expanded: card.status === "ready" || card.status === "failed",
  };
}

function parseStoredDraft(raw: string, cardId: string): CardDraft | undefined {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") return undefined;
  const draft = value as Partial<CardDraft>;
  if (!Number.isSafeInteger(draft.baseRevision) || (draft.baseRevision ?? -1) < 0
    || typeof draft.dirty !== "boolean" || typeof draft.expanded !== "boolean"
    || !UiValuesSchema.safeParse(draft.values).success) return undefined;
  if (draft.pending) {
    const pending = UiActionInputSchema.safeParse(draft.pending);
    if (!pending.success || pending.data.cardId !== cardId) return undefined;
  }
  return draft as CardDraft;
}

function privateValues(values: CardValues): CardValues {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => {
    const sensitiveField = /^(?:password|passwd|pwd|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|private[_-]?key|密码|口令|私钥|密钥)$/i.test(field);
    const safe = (text: string) => sensitiveField && text ? "[已隐藏]" : redactSensitiveText(text);
    return [field, typeof value === "string" ? safe(value) : Array.isArray(value) ? value.map(safe) : value];
  }));
}

function persistentDraft(draft: CardDraft): { draft: CardDraft; sensitive: boolean } {
  const values = privateValues(draft.values);
  const pendingValues = draft.pending ? privateValues(draft.pending.values) : undefined;
  const sensitive = JSON.stringify(values) !== JSON.stringify(draft.values)
    || Boolean(draft.pending && JSON.stringify(pendingValues) !== JSON.stringify(draft.pending.values));
  // An uncertain submission cannot be retried with altered values and the same command ID.
  const { pending, ...base } = draft;
  return { draft: { ...base, values, ...(!sensitive && pending ? { pending } : {}) }, sensitive };
}

export function readCardDraft(card: UiCardSnapshot, storage?: DraftStorage): DraftReadResult {
  const cached = sessionDrafts.get(card.cardId);
  if (cached) return { draft: reconcileCardDraft(structuredClone(cached), card) };
  const fresh = createCardDraft(card);
  if (!storage) return { draft: fresh };
  try {
    const raw = storage.getItem(storageKey(card.cardId));
    if (!raw) return { draft: fresh };
    const stored = parseStoredDraft(raw, card.cardId);
    if (!stored) return { draft: fresh, storageError: "本地草稿无法读取" };
    const safe = persistentDraft(stored);
    if (safe.sensitive) storage.setItem(storageKey(card.cardId), JSON.stringify(safe.draft));
    return { draft: reconcileCardDraft(safe.draft, card), ...(safe.sensitive ? { storageError: "敏感输入已从本地草稿隐藏，请重新填写" } : {}) };
  } catch {
    return { draft: fresh, storageError: "本地草稿无法读取" };
  }
}

export function writeCardDraft(cardId: string, draft: CardDraft, storage?: DraftStorage): string | undefined {
  sessionDrafts.set(cardId, structuredClone(draft));
  if (!storage) return undefined;
  try {
    const safe = persistentDraft(draft);
    storage.setItem(storageKey(cardId), JSON.stringify(safe.draft));
    return safe.sensitive ? "敏感输入仅保留在当前窗口" : undefined;
  } catch {
    return "草稿暂存于当前窗口";
  }
}

export function reconcileCardDraft(draft: CardDraft, card: UiCardSnapshot): CardDraft {
  if (!draft.dirty && !draft.pending) {
    return { ...createCardDraft(card), expanded: card.status === "ready" ? draft.expanded : false };
  }
  // A terminal snapshot ends transport uncertainty without discarding local edits.
  if (card.status !== "ready" && card.status !== "failed") {
    const committed = cardInitialValues(card);
    const sameValues = Object.keys(draft.values).length === Object.keys(committed).length
      && Object.entries(draft.values).every(([key, value]) => Array.isArray(value)
        ? Array.isArray(committed[key]) && value.length === committed[key].length && value.every((part, index) => part === (committed[key] as string[])[index])
        : value === committed[key]);
    return { ...draft, pending: undefined, expanded: false, dirty: draft.dirty || !sameValues };
  }
  return draft;
}

export function hasDraftConflict(draft: CardDraft, card: UiCardSnapshot): boolean {
  return draft.dirty && draft.baseRevision !== card.revision;
}

export function isDefiniteActionRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429)
    || code === "revision_conflict" || code === "invalid_action" || code === "validation_error";
}
