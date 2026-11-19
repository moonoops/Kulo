import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { UiCardInput, UiCardSnapshot } from "@moco/protocol";
import type { MocoUiCards } from "./ui-cards.js";

export type ActionConfirmationKind =
  | "customization_validate"
  | "external_permission"
  | "staged_apply";

export type ActionConfirmationPayload =
  | {
      kind: "customization_validate";
      sessionId: string;
      revision: number;
      summary: string;
      changedFiles: string[];
    }
  | {
      kind: "external_permission";
      ticketId: string;
      runEpoch: number;
      permissionId: string;
      title: string;
      choices: Array<{ id: string; label: string }>;
    }
  | {
      kind: "staged_apply";
      ticketId: string;
      runEpoch: number;
      commandId: string;
      paths?: string[];
      allowConflicts: boolean;
      sensitivePaths: string[];
      conflictFiles: string[];
    };

export interface PendingActionConfirmation {
  id: string;
  cardId: string;
  conversationId: number;
  kind: ActionConfirmationKind;
  fingerprint: string;
  status: "pending" | "approved" | "denied";
  actionMap: Record<string, string>;
  createdAt: number;
  resolvedAt?: number;
  selectedChoiceId?: string;
  executed?: boolean;
  payload: ActionConfirmationPayload;
}

export interface ActionConfirmationsState {
  byCardId: Record<string, PendingActionConfirmation>;
  byScopeFingerprint: Record<string, string>;
}

export const ActionConfirmationsDoc = defineDoc<ActionConfirmationsState & JsonObject>({
  kind: "moco.action-confirmations",
  version: 1,
  scope: "session",
  initial: () => ({ byCardId: {}, byScopeFingerprint: {} }) as ActionConfirmationsState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scopeKey(conversationId: number, kind: ActionConfirmationKind, fingerprint: string): string {
  return `${conversationId}:${kind}:${fingerprint}`;
}

function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1))}…`;
}

export function customizationValidateFingerprint(sessionId: string, revision: number, changedFiles: readonly string[]): string {
  return hashValue(["customization_validate", sessionId, revision, [...changedFiles].sort()]);
}

export function externalPermissionFingerprint(ticketId: string, runEpoch: number, permissionId: string): string {
  return hashValue(["external_permission", ticketId, runEpoch, permissionId]);
}

export function stagedApplyFingerprint(input: {
  ticketId: string;
  runEpoch: number;
  paths?: readonly string[];
  allowConflicts: boolean;
  sensitivePaths: readonly string[];
  conflictFiles: readonly string[];
}): string {
  return hashValue([
    "staged_apply",
    input.ticketId,
    input.runEpoch,
    input.paths ? [...input.paths].sort() : null,
    input.allowConflicts,
    [...input.sensitivePaths].sort(),
    [...input.conflictFiles].sort(),
  ]);
}

export function buildCustomizationConfirmCard(summary: string, changedFiles: readonly string[]): {
  input: UiCardInput;
  logicalIds: string[];
} {
  const preview = changedFiles.slice(0, 20).join("\n") + (changedFiles.length > 20 ? `\n… +${changedFiles.length - 20}` : "");
  const input: UiCardInput = {
    title: "确认界面源码定制",
    fallbackText: `确认构建并应用界面定制：${summary}`,
    spec: {
      root: "root",
      elements: {
        root: {
          type: "Card",
          props: {
            title: "确认界面源码定制",
            description: clip(summary || "构建并准备在下次启动时替换桌面 Web 界面。", 240),
          },
          children: ["body"],
        },
        body: {
          type: "Stack",
          props: { gap: "sm" },
          children: ["files", "actions"],
        },
        files: {
          type: "Code",
          props: {
            fileName: `变更文件（${changedFiles.length}）`,
            code: preview || "(无文件列表)",
          },
        },
        actions: {
          type: "Grid",
          props: { columns: 2 },
          children: ["btn_confirm", "btn_cancel"],
        },
        btn_confirm: {
          type: "Button",
          props: { actionId: "confirm", label: "确认构建并生效", variant: "primary" },
        },
        btn_cancel: {
          type: "Button",
          props: { actionId: "cancel", label: "取消", variant: "secondary" },
        },
      },
    },
    actions: [
      { id: "confirm", label: "确认构建并生效", kind: "submit" },
      { id: "cancel", label: "取消", kind: "cancel" },
    ],
  };
  return { input, logicalIds: ["confirm", "cancel"] };
}

export function buildExternalPermissionCard(
  permissionTitle: string,
  choices: ReadonlyArray<{ id: string; label: string }>,
): {
  input: UiCardInput;
  logicalIds: string[];
} {
  const boundedChoices = choices.slice(0, 12);
  const elements: UiCardInput["spec"]["elements"] = {
    root: {
      type: "Card",
      props: { title: "外部智能体权限请求" },
      children: ["body"],
    },
    body: {
      type: "Stack",
      props: { gap: "sm" },
      children: ["prompt", "actions"],
    },
    prompt: {
      type: "Text",
      props: { text: clip(permissionTitle, 4000) },
    },
    actions: {
      type: "Stack",
      props: { gap: "sm" },
      children: boundedChoices.map((_choice, index) => `choice_${index}`),
    },
  };
  const actions: UiCardInput["actions"] = [];
  const logicalIds: string[] = [];
  boundedChoices.forEach((choice, index) => {
    const actionId = `choice_${index}`;
    const labelText = clip(choice.label || choice.id, 200);
    elements[actionId] = {
      type: "Button",
      props: {
        actionId,
        label: labelText,
        variant: index === 0 ? "primary" : "secondary",
      },
    };
    actions.push({ id: actionId, label: labelText, kind: "submit" });
    logicalIds.push(choice.id);
  });
  return {
    input: {
      title: "外部智能体权限请求",
      fallbackText: clip(permissionTitle, 400),
      spec: { root: "root", elements },
      actions,
    },
    logicalIds,
  };
}

export function buildStagedApplyConfirmCard(input: {
  ticketId: string;
  sensitivePaths: readonly string[];
  conflictFiles: readonly string[];
  allowConflicts: boolean;
}): {
  input: UiCardInput;
  logicalIds: string[];
} {
  const lines: string[] = [];
  for (const file of input.sensitivePaths.slice(0, 15)) lines.push(`[敏感] ${file}`);
  for (const file of input.conflictFiles.slice(0, 15)) lines.push(`[冲突] ${file}`);
  if (!lines.length && input.allowConflicts) lines.push("[强制合并冲突]");
  const chips: string[] = [];
  const elements: UiCardInput["spec"]["elements"] = {
    root: {
      type: "Card",
      props: { title: "确认合并高风险改动" },
      children: ["body"],
    },
    body: {
      type: "Stack",
      props: { gap: "sm" },
      children: ["tags", "files", "actions"],
    },
    tags: {
      type: "Grid",
      props: { columns: 2 },
      children: chips,
    },
    files: {
      type: "Code",
      props: {
        fileName: `${input.ticketId} 需确认路径`,
        code: lines.join("\n"),
      },
    },
    actions: {
      type: "Grid",
      props: { columns: 2 },
      children: ["btn_confirm", "btn_cancel"],
    },
    btn_confirm: {
      type: "Button",
      props: { actionId: "confirm", label: "确认合并改动", variant: "primary" },
    },
    btn_cancel: {
      type: "Button",
      props: { actionId: "cancel", label: "取消", variant: "secondary" },
    },
  };
  if (input.sensitivePaths.length > 0) {
    chips.push("chip_sensitive");
    elements.chip_sensitive = { type: "Chip", props: { text: `敏感路径 (${input.sensitivePaths.length})`, tone: "warning" } };
  }
  if (input.conflictFiles.length > 0 || input.allowConflicts) {
    chips.push("chip_conflict");
    elements.chip_conflict = { type: "Chip", props: { text: `并发冲突 (${input.conflictFiles.length})`, tone: "danger" } };
  }
  return {
    input: {
      title: "确认合并高风险改动",
      fallbackText: `确认合并 ${input.ticketId} 的敏感路径或冲突变更`,
      spec: { root: "root", elements },
      actions: [
        { id: "confirm", label: "确认合并改动", kind: "submit" },
        { id: "cancel", label: "取消", kind: "cancel" },
      ],
    },
    logicalIds: ["confirm", "cancel"],
  };
}

export class MocoActionConfirmations {
  readonly #harness: Harness;
  readonly #uiCards: MocoUiCards;

  constructor(options: { harness: Harness; uiCards: MocoUiCards }) {
    this.#harness = options.harness;
    this.#uiCards = options.uiCards;
  }

  async lookup(
    conversationId: number,
    kind: ActionConfirmationKind,
    fingerprint: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation | undefined> {
    const doc = await this.#harness.snapshot(ActionConfirmationsDoc, context);
    const cardId = doc?.byScopeFingerprint?.[scopeKey(conversationId, kind, fingerprint)];
    const record = cardId ? doc?.byCardId?.[cardId] : undefined;
    return record ? JSON.parse(JSON.stringify(record)) as PendingActionConfirmation : undefined;
  }

  async getByCardId(cardId: string, context: Context = BACKGROUND_CONTEXT): Promise<PendingActionConfirmation | undefined> {
    const doc = await this.#harness.snapshot(ActionConfirmationsDoc, context);
    const record = doc?.byCardId?.[cardId];
    return record ? JSON.parse(JSON.stringify(record)) as PendingActionConfirmation : undefined;
  }

  async ensurePendingCard(params: {
    conversationId: number;
    topicId?: string;
    ticketId?: string;
    callId: string;
    kind: ActionConfirmationKind;
    fingerprint: string;
    cardInput: UiCardInput;
    logicalIds: readonly string[];
    payload: ActionConfirmationPayload;
  }, context: Context = BACKGROUND_CONTEXT): Promise<{ confirmation: PendingActionConfirmation; card: UiCardSnapshot | undefined }> {
    const existing = await this.lookup(params.conversationId, params.kind, params.fingerprint, context);
    if (existing && existing.status === "pending") {
      return { confirmation: existing, card: await this.#uiCards.get(existing.cardId) };
    }
    const confirmationId = `cfm_${hashValue([params.conversationId, params.kind, params.fingerprint, existing ? existing.resolvedAt ?? Date.now() : 0]).slice(0, 24)}`;
    const card = await this.#uiCards.show(params.cardInput, {
      conversationId: params.conversationId,
      callId: `confirm:${confirmationId}`,
      toolCallId: params.callId,
      ...(params.topicId ? { topicId: params.topicId } : {}),
      ...(params.ticketId ? { ticketId: params.ticketId } : {}),
    });
    const actionMap: Record<string, string> = {};
    card.actions.forEach((action, index) => {
      const logical = params.logicalIds[index];
      if (logical !== undefined) actionMap[action.id] = logical;
    });
    const record: PendingActionConfirmation = {
      id: confirmationId,
      cardId: card.cardId,
      conversationId: params.conversationId,
      kind: params.kind,
      fingerprint: params.fingerprint,
      status: "pending",
      actionMap,
      createdAt: Date.now(),
      payload: JSON.parse(JSON.stringify(params.payload)) as ActionConfirmationPayload,
    };
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      doc.byCardId[card.cardId] = record as PendingActionConfirmation & JsonObject;
      doc.byScopeFingerprint[scopeKey(params.conversationId, params.kind, params.fingerprint)] = card.cardId;
    }, context);
    return { confirmation: record, card };
  }

  async resolveFromUiSubmit(
    cardId: string,
    actionId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation | undefined> {
    return this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = doc.byCardId[cardId];
      if (!record || record.status !== "pending") return undefined;
      const logical = record.actionMap[actionId];
      if (!logical) return undefined;
      record.resolvedAt = Date.now();
      record.selectedChoiceId = logical;
      if (record.kind === "external_permission") {
        record.status = "approved";
      } else {
        record.status = logical === "confirm" ? "approved" : "denied";
      }
      return JSON.parse(JSON.stringify(record)) as PendingActionConfirmation;
    }, context);
  }

  async markExecuted(cardId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = doc.byCardId[cardId];
      if (record) record.executed = true;
    }, context);
  }
}
