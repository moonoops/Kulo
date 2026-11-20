import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import type {
  AmbientLocalEngine,
  AssistantItemKind,
  AssistantItemView,
  AssistantPendingAction,
} from "@kulo/protocol";

export type AssistantSituationRecord = {
  id: string;
  key: string;
  title: string;
  sourceApp: string;
  sourceLabel: string;
  status: "open" | "resolved" | "dismissed";
  linkedTopicId?: string;
  lastEscalatedAt?: number;
  updatedAt: number;
};

export type AssistantBackgroundModelPersisted = {
  mode: "auto" | "local-managed" | "kulo-provider";
  engine?: AmbientLocalEngine;
  modelId?: string;
  providerId?: string;
  port?: number;
  revision: number;
};

export type AssistantDurableState = {
  revision: number;
  enabled: boolean;
  mutedApps: string[];
  backgroundModel: AssistantBackgroundModelPersisted;
  spark?: { enabled: boolean };
  homeAssistant?: { enabled: boolean; baseUrl?: string };
  lark?: { enabled: boolean; selectedProfiles: string[] };
  assistantRevision: number;
  situations: Record<string, AssistantSituationRecord>;
  items: AssistantItemView[];
};

const MAX_ACTIVE_ITEMS = 40;
const MAX_SITUATIONS = 200;

export const AssistantDoc = defineDoc<AssistantDurableState & JsonObject>({
  kind: "kulo.assistant",
  version: 1,
  scope: "session",
  initial: (): AssistantDurableState & JsonObject =>
    ({
      revision: 1,
      enabled: false,
      mutedApps: [],
      backgroundModel: {
        mode: "auto",
        revision: 1,
      },
      assistantRevision: 1,
      situations: {},
      items: [],
    }) as unknown as AssistantDurableState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

export function ensureAssistantState(doc: AssistantDurableState): void {
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) doc.revision = 1;
  if (typeof doc.enabled !== "boolean") doc.enabled = false;
  if (!Array.isArray(doc.mutedApps)) doc.mutedApps = [];
  if (!doc.backgroundModel || typeof doc.backgroundModel !== "object") {
    doc.backgroundModel = { mode: "auto", revision: 1 };
  }
  if (!Number.isSafeInteger(doc.backgroundModel.revision) || doc.backgroundModel.revision < 1) {
    doc.backgroundModel.revision = 1;
  }
  if (!Number.isSafeInteger(doc.assistantRevision) || doc.assistantRevision < 1) doc.assistantRevision = 1;
  if (!doc.situations || typeof doc.situations !== "object") doc.situations = {};
  if (!Array.isArray(doc.items)) doc.items = [];
}

export function findSituationByKey(
  doc: Readonly<AssistantDurableState>,
  key: string,
): AssistantSituationRecord | undefined {
  for (const situation of Object.values(doc.situations)) {
    if (situation.key === key) return situation;
  }
  return undefined;
}

export function pruneAssistantSituations(doc: AssistantDurableState): void {
  const entries = Object.values(doc.situations);
  if (entries.length <= MAX_SITUATIONS) return;
  const activeSituationIds = new Set(doc.items.map((item) => item.situationId));
  entries
    .filter((entry) => !activeSituationIds.has(entry.id))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, entries.length - MAX_SITUATIONS)
    .forEach((entry) => {
      delete doc.situations[entry.id];
    });
}

export function upsertAssistantCardInDoc(
  doc: AssistantDurableState,
  input: {
    situationId: string;
    situationKey: string;
    kind: AssistantItemKind;
    sourceApp: string;
    sourceLabel: string;
    envName?: string;
    title: string;
    summary: string;
    primaryActionLabel?: string;
    pendingAction?: AssistantPendingAction;
    linkedTopicId?: string;
    expiresAt?: number;
    now: number;
  },
): AssistantItemView {
  ensureAssistantState(doc);
  const existingSituation = doc.situations[input.situationId];
  const resolvedLinkedTopicId = input.linkedTopicId ?? existingSituation?.linkedTopicId;
  doc.situations[input.situationId] = {
    id: input.situationId,
    key: input.situationKey,
    title: input.title.slice(0, 120),
    sourceApp: input.sourceApp,
    sourceLabel: input.sourceLabel,
    status: "open",
    ...(resolvedLinkedTopicId ? { linkedTopicId: resolvedLinkedTopicId } : {}),
    lastEscalatedAt: input.now,
    updatedAt: input.now,
  };

  const cleanPending = input.pendingAction
    ? (JSON.parse(JSON.stringify(input.pendingAction)) as AssistantPendingAction)
    : undefined;
  const existingIdx = doc.items.findIndex((item) => item.situationId === input.situationId);
  let card: AssistantItemView;
  if (existingIdx >= 0) {
    const prev = doc.items[existingIdx]!;
    const nextPending = cleanPending ?? prev.pendingAction;
    card = {
      ...prev,
      revision: prev.revision + 1,
      kind: input.kind,
      sourceApp: input.sourceApp,
      sourceLabel: input.sourceLabel,
      ...(input.envName ? { envName: input.envName } : {}),
      title: input.title.slice(0, 120),
      summary: input.summary.slice(0, 400),
      ...(input.primaryActionLabel ? { primaryActionLabel: input.primaryActionLabel.slice(0, 40) } : {}),
      ...(nextPending ? { pendingAction: nextPending } : {}),
      ...(input.linkedTopicId ?? prev.linkedTopicId ? { linkedTopicId: input.linkedTopicId ?? prev.linkedTopicId } : {}),
      updatedAt: input.now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    doc.items.splice(existingIdx, 1);
    doc.items.unshift(card);
  } else {
    card = {
      id: `asst-${input.situationId}`,
      revision: 1,
      situationId: input.situationId,
      kind: input.kind,
      sourceApp: input.sourceApp,
      sourceLabel: input.sourceLabel,
      ...(input.envName ? { envName: input.envName } : {}),
      title: input.title.slice(0, 120),
      summary: input.summary.slice(0, 400),
      ...(input.primaryActionLabel ? { primaryActionLabel: input.primaryActionLabel.slice(0, 40) } : {}),
      ...(cleanPending ? { pendingAction: cleanPending } : {}),
      ...(input.linkedTopicId ? { linkedTopicId: input.linkedTopicId } : {}),
      createdAt: input.now,
      updatedAt: input.now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    doc.items.unshift(card);
  }
  if (doc.items.length > MAX_ACTIVE_ITEMS) {
    doc.items.length = MAX_ACTIVE_ITEMS;
  }
  doc.assistantRevision += 1;
  pruneAssistantSituations(doc);
  return card;
}

export function dismissAssistantItemInDoc(
  doc: AssistantDurableState,
  itemId: string,
  expectedRevision: number,
  options: { muteApp?: boolean; now: number },
): { removed: AssistantItemView; mutedApp?: string } | { conflict: true } | { missing: true } {
  ensureAssistantState(doc);
  const idx = doc.items.findIndex((item) => item.id === itemId);
  if (idx < 0) return { missing: true };
  const target = doc.items[idx]!;
  if (target.revision !== expectedRevision) return { conflict: true };
  doc.items.splice(idx, 1);
  const sit = doc.situations[target.situationId];
  if (sit) {
    sit.status = "dismissed";
    sit.updatedAt = options.now;
  }
  let mutedApp: string | undefined;
  if (options.muteApp && target.sourceApp) {
    mutedApp = target.sourceApp;
    if (!doc.mutedApps.includes(mutedApp)) {
      doc.mutedApps = [...doc.mutedApps, mutedApp].slice(0, 256);
      doc.revision += 1;
    }
    doc.items = doc.items.filter((item) => item.sourceApp !== mutedApp);
  }
  doc.assistantRevision += 1;
  return { removed: target, ...(mutedApp ? { mutedApp } : {}) };
}
