import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { ActionEffectState, TicketWaitOption, UiCardInput, UiCardSnapshot, UiValues } from "@kulo/protocol";
import type { KuloUiCards } from "./ui-cards.js";

export type ActionConfirmationKind =
  | "customization_validate"
  | "external_permission"
  | "staged_apply"
  | "memory_service_operation"
  | "host_action"
  | "ticket_decision"
  | "computer_handoff";

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
    }
  | {
      kind: "memory_service_operation";
      jobId: string;
      clientId: string;
      operation: "deploy" | "configure" | "uninstall";
      deviceName: string;
      title: string;
      changes: string[];
    }
  | {
      kind: "host_action";
      envId: string;
      envName: string;
      summary: string;
      commands: string[];
      cwd?: string;
      timeoutMs?: number;
      ticketId?: string;
      runEpoch?: number;
      requestId?: string;
    }
  | {
      kind: "ticket_decision";
      ticketId: string;
      runEpoch: number;
      question: string;
      options: TicketWaitOption[];
    }
  | {
      kind: "computer_handoff";
      ticketId: string;
      runEpoch: number;
      envId: string;
      target: "browser" | "desktop";
      sessionId: string;
      reason: string;
      url?: string;
      app?: string;
      expiresAt: number;
    };

export interface PendingActionConfirmation {
  id: string;
  cardId?: string;
  conversationId: number;
  kind: ActionConfirmationKind;
  fingerprint: string;
  status: "pending_orchestrator" | "pending" | "approved" | "denied";
  actionMap: Record<string, string>;
  createdAt: number;
  resolvedAt?: number;
  selectedChoiceId?: string;
  manualInstruction?: string;
  executed?: boolean;
  effect?: ActionEffectState;
  dispatchedAt?: number;
  lastError?: string;
  payload: ActionConfirmationPayload;
}

export function effectiveConfirmationEffect(record: Readonly<PendingActionConfirmation>): ActionEffectState {
  if (record.effect) return record.effect;
  return record.executed ? "confirmed" : "none";
}

export interface ActionConfirmationsState {
  byCardId: Record<string, PendingActionConfirmation>;
  byScopeFingerprint: Record<string, string>;
  byId?: Record<string, PendingActionConfirmation>;
}

export const ActionConfirmationsDoc = defineDoc<ActionConfirmationsState & JsonObject>({
  kind: "kulo.action-confirmations",
  version: 1,
  scope: "session",
  initial: () => ({ byCardId: {}, byScopeFingerprint: {}, byId: {} }) as ActionConfirmationsState & JsonObject,
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

function manualInstructionField() {
  return {
    type: "TextField" as const,
    props: {
      field: "instruction",
      label: "手动输入",
      placeholder: "输入补充说明或替代要求…",
      multiline: false,
      maxLength: 2000,
    },
  };
}

function manualSubmitButton(label = "按说明处理") {
  return {
    type: "Button" as const,
    props: { actionId: "manual", label, variant: "secondary" as const },
  };
}

function manualAction(label = "按说明处理"): UiCardInput["actions"][number] {
  return {
    id: "manual",
    label,
    kind: "submit",
    fields: [{ name: "instruction", type: "string", label: "手动输入", required: true, maxLength: 2000 }],
  };
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

export function hostActionFingerprint(input: {
  envId: string;
  commands: readonly string[];
  cwd?: string;
  ticketId?: string;
  runEpoch?: number;
  requestId?: string;
}): string {
  return hashValue([
    "host_action",
    input.envId,
    [...input.commands],
    input.cwd ?? null,
    input.ticketId ?? null,
    input.runEpoch ?? null,
    input.requestId ?? null,
  ]);
}

export function ticketDecisionFingerprint(input: {
  ticketId: string;
  runEpoch: number;
  question: string;
  options: readonly TicketWaitOption[];
}): string {
  return hashValue([
    "ticket_decision",
    input.ticketId,
    input.runEpoch,
    input.question,
    input.options.map((opt) => [opt.id, opt.label, opt.value ?? null]),
  ]);
}

export function buildHostActionConfirmCard(input: {
  envName: string;
  summary: string;
  commands: readonly string[];
  cwd?: string;
  reason?: string;
}): {
  input: UiCardInput;
  logicalIds: string[];
} {
  const title = clip(`在 ${input.envName} 执行本机操作`, 120);
  const code = input.commands.join("\n");
  const fileName = clip(input.cwd ? `${input.envName} · ${input.cwd}` : input.envName, 120);
  const description = clip(input.reason?.trim() ? `${input.summary}（${input.reason.trim()}）` : input.summary, 240);
  const cardInput: UiCardInput = {
    title,
    fallbackText: clip(`${title}：${description}`, 400),
    spec: {
      root: "root",
      elements: {
        root: {
          type: "Card",
          props: {
            title,
            description,
          },
          children: ["body"],
        },
        body: {
          type: "Stack",
          props: { gap: "sm" },
          children: ["commands", "actions", "manual_input", "btn_manual"],
        },
        commands: {
          type: "Code",
          props: {
            fileName,
            code,
          },
        },
        actions: {
          type: "Grid",
          props: { columns: 2 },
          children: ["btn_confirm", "btn_cancel"],
        },
        btn_confirm: {
          type: "Button",
          props: { actionId: "confirm", label: "允许", variant: "primary" },
        },
        btn_cancel: {
          type: "Button",
          props: { actionId: "cancel", label: "拒绝", variant: "secondary" },
        },
        manual_input: manualInstructionField(),
        btn_manual: manualSubmitButton(),
      },
    },
    actions: [
      { id: "confirm", label: "允许", kind: "submit" },
      { id: "cancel", label: "拒绝", kind: "cancel" },
      manualAction(),
    ],
  };
  return { input: cardInput, logicalIds: ["confirm", "cancel", "manual"] };
}

export function memoryServiceOperationFingerprint(input: {
  jobId: string;
  clientId: string;
  operation: "deploy" | "configure" | "uninstall";
}): string {
  return hashValue(["memory_service_operation", input.jobId, input.clientId, input.operation]);
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
          children: ["files", "actions", "manual_input", "btn_manual"],
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
          props: { actionId: "confirm", label: "允许", variant: "primary" },
        },
        btn_cancel: {
          type: "Button",
          props: { actionId: "cancel", label: "拒绝", variant: "secondary" },
        },
        manual_input: manualInstructionField(),
        btn_manual: manualSubmitButton(),
      },
    },
    actions: [
      { id: "confirm", label: "允许", kind: "submit" },
      { id: "cancel", label: "拒绝", kind: "cancel" },
      manualAction(),
    ],
  };
  return { input, logicalIds: ["confirm", "cancel", "manual"] };
}

export function buildExternalPermissionCard(
  permissionTitle: string,
  choices: ReadonlyArray<{ id: string; label: string }>,
  reason?: string,
): {
  input: UiCardInput;
  logicalIds: string[];
} {
  const boundedChoices = choices.slice(0, 11);
  const elements: UiCardInput["spec"]["elements"] = {
    root: {
      type: "Card",
      props: {
        title: "外部智能体权限请求",
        ...(reason?.trim() ? { description: clip(reason, 240) } : {}),
      },
      children: ["body"],
    },
    body: {
      type: "Stack",
      props: { gap: "sm" },
      children: ["prompt", "actions", "manual_input", "btn_manual"],
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
    manual_input: manualInstructionField(),
    btn_manual: manualSubmitButton(),
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
  actions.push(manualAction());
  logicalIds.push("manual");
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

export function buildTicketDecisionCard(input: {
  title: string;
  question: string;
  options: readonly TicketWaitOption[];
}): {
  input: UiCardInput;
  logicalIds: string[];
} {
  const boundedOptions = input.options.slice(0, 11);
  const cardTitle = clip(input.title || "任务需要你的决定", 120);
  const bodyChildren: string[] = ["prompt"];
  const elements: UiCardInput["spec"]["elements"] = {
    root: {
      type: "Card",
      props: { title: cardTitle },
      children: ["body"],
    },
    body: {
      type: "Stack",
      props: { gap: "sm" },
      children: bodyChildren,
    },
    prompt: {
      type: "Text",
      props: { text: clip(input.question, 4000) },
    },
  };
  const actions: UiCardInput["actions"] = [];
  const logicalIds: string[] = [];
  if (boundedOptions.length > 0) {
    bodyChildren.push("actions");
    elements.actions = {
      type: boundedOptions.length <= 2 ? "Grid" : "Stack",
      props: boundedOptions.length <= 2 ? { columns: boundedOptions.length === 1 ? 1 : 2 } : { gap: "sm" },
      children: boundedOptions.map((_option, index) => `choice_${index}`),
    };
    boundedOptions.forEach((option, index) => {
      const actionId = `choice_${index}`;
      const labelText = clip(option.label || option.id, 200);
      elements[actionId] = {
        type: "Button",
        props: {
          actionId,
          label: labelText,
          variant: option.tone ?? (index === 0 ? "primary" : "secondary"),
        },
      };
      actions.push({ id: actionId, label: labelText, kind: "submit" });
      logicalIds.push(option.id);
    });
  }
  bodyChildren.push("manual_input", "btn_manual");
  elements.manual_input = manualInstructionField();
  elements.btn_manual = manualSubmitButton(boundedOptions.length > 0 ? "按说明处理" : "提交回复");
  actions.push(manualAction(boundedOptions.length > 0 ? "按说明处理" : "提交回复"));
  logicalIds.push("manual");
  return {
    input: {
      title: cardTitle,
      fallbackText: clip(input.question, 400),
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
      children: ["tags", "files", "actions", "manual_input", "btn_manual"],
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
      props: { actionId: "confirm", label: "允许", variant: "primary" },
    },
    btn_cancel: {
      type: "Button",
      props: { actionId: "cancel", label: "拒绝", variant: "secondary" },
    },
    manual_input: manualInstructionField(),
    btn_manual: manualSubmitButton(),
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
        { id: "confirm", label: "允许", kind: "submit" },
        { id: "cancel", label: "拒绝", kind: "cancel" },
        manualAction(),
      ],
    },
    logicalIds: ["confirm", "cancel", "manual"],
  };
}

export function buildMemoryServiceConfirmCard(input: {
  operation: "deploy" | "configure" | "uninstall";
  title: string;
  deviceName: string;
  changes: readonly string[];
}): {
  input: UiCardInput;
  logicalIds: string[];
} {
  const confirmLabel =
    input.operation === "uninstall"
      ? "允许卸载"
      : input.operation === "deploy"
        ? "允许部署"
        : "允许保存";
  const summaryLines = input.changes.length
    ? input.changes.map((line) => `- ${line}`).join("\n")
    : `- ${input.deviceName}`;
  const cardInput: UiCardInput = {
    title: clip(input.title, 120),
    fallbackText: `${input.title}（${input.deviceName}）`,
    spec: {
      root: "root",
      elements: {
        root: {
          type: "Card",
          props: {
            title: clip(input.title, 120),
            description: clip(`目标主机：${input.deviceName}`, 240),
          },
          children: ["body"],
        },
        body: {
          type: "Stack",
          props: { gap: "sm" },
          children: ["details", "actions", "manual_input", "btn_manual"],
        },
        details: {
          type: "Text",
          props: {
            text: clip(summaryLines, 2000),
          },
        },
        actions: {
          type: "Grid",
          props: { columns: 2 },
          children: ["btn_confirm", "btn_cancel"],
        },
        btn_confirm: {
          type: "Button",
          props: { actionId: "confirm", label: confirmLabel, variant: "primary" },
        },
        btn_cancel: {
          type: "Button",
          props: { actionId: "cancel", label: "拒绝", variant: "secondary" },
        },
        manual_input: manualInstructionField(),
        btn_manual: manualSubmitButton(),
      },
    },
    actions: [
      { id: "confirm", label: confirmLabel, kind: "submit" },
      { id: "cancel", label: "拒绝", kind: "cancel" },
      manualAction(),
    ],
  };
  return { input: cardInput, logicalIds: ["confirm", "cancel", "manual"] };
}

function findRecord(doc: ActionConfirmationsState | undefined, idOrCardId: string): PendingActionConfirmation | undefined {
  if (!doc) return undefined;
  return (
    doc.byId?.[idOrCardId] ??
    doc.byCardId?.[idOrCardId] ??
    Object.values(doc.byCardId ?? {}).find((item) => item.id === idOrCardId)
  );
}

function writeRecord(doc: ActionConfirmationsState, record: PendingActionConfirmation): void {
  doc.byId ??= {};
  doc.byId[record.id] = record;
  if (record.cardId) {
    doc.byCardId[record.cardId] = record;
  }
}

export class KuloActionConfirmations {
  readonly #harness: Harness;
  readonly #uiCards: KuloUiCards;

  constructor(options: { harness: Harness; uiCards: KuloUiCards }) {
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
    const ref = doc?.byScopeFingerprint?.[scopeKey(conversationId, kind, fingerprint)];
    const record = ref ? findRecord(doc, ref) : undefined;
    return record ? JSON.parse(JSON.stringify(record)) as PendingActionConfirmation : undefined;
  }

  async getById(idOrCardId: string, context: Context = BACKGROUND_CONTEXT): Promise<PendingActionConfirmation | undefined> {
    const doc = await this.#harness.snapshot(ActionConfirmationsDoc, context);
    const record = findRecord(doc, idOrCardId);
    return record ? JSON.parse(JSON.stringify(record)) as PendingActionConfirmation : undefined;
  }

  async getByCardId(cardId: string, context: Context = BACKGROUND_CONTEXT): Promise<PendingActionConfirmation | undefined> {
    const doc = await this.#harness.snapshot(ActionConfirmationsDoc, context);
    const record = doc?.byCardId?.[cardId];
    return record ? JSON.parse(JSON.stringify(record)) as PendingActionConfirmation : undefined;
  }

  async listPendingForConversation(
    conversationId: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation[]> {
    const doc = await this.#harness.snapshot(ActionConfirmationsDoc, context);
    if (!doc) return [];
    const byId = new Map<string, PendingActionConfirmation>();
    for (const record of Object.values(doc.byCardId ?? {})) {
      if (record.conversationId === conversationId && (record.status === "pending_orchestrator" || record.status === "pending")) {
        byId.set(record.id, record);
      }
    }
    for (const record of Object.values(doc.byId ?? {})) {
      if (record.conversationId === conversationId && (record.status === "pending_orchestrator" || record.status === "pending")) {
        byId.set(record.id, record);
      }
    }
    return [...byId.values()].map((record) => JSON.parse(JSON.stringify(record)) as PendingActionConfirmation);
  }

  async createPendingOrchestratorRequest(params: {
    conversationId: number;
    kind: ActionConfirmationKind;
    fingerprint: string;
    payload: ActionConfirmationPayload;
  }, context: Context = BACKGROUND_CONTEXT): Promise<PendingActionConfirmation> {
    const existing = await this.lookup(params.conversationId, params.kind, params.fingerprint, context);
    if (existing && (existing.status === "pending_orchestrator" || existing.status === "pending")) {
      return existing;
    }
    const confirmationId = `cfm_${hashValue([params.conversationId, params.kind, params.fingerprint, existing ? existing.resolvedAt ?? Date.now() : 0]).slice(0, 24)}`;
    const record: PendingActionConfirmation = {
      id: confirmationId,
      conversationId: params.conversationId,
      kind: params.kind,
      fingerprint: params.fingerprint,
      status: "pending_orchestrator",
      actionMap: {},
      createdAt: Date.now(),
      payload: JSON.parse(JSON.stringify(params.payload)) as ActionConfirmationPayload,
    };
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      doc.byScopeFingerprint[scopeKey(params.conversationId, params.kind, params.fingerprint)] = record.id;
    }, context);
    return JSON.parse(JSON.stringify(record)) as PendingActionConfirmation;
  }

  async attachCardToRequest(
    idOrCardId: string,
    params: {
      topicId?: string;
      ticketId?: string;
      callId: string;
      cardInput: UiCardInput;
      logicalIds: readonly string[];
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ confirmation: PendingActionConfirmation; card: UiCardSnapshot | undefined }> {
    const existing = await this.getById(idOrCardId, context);
    if (!existing) {
      throw new Error("未找到对应的待处理请求。");
    }
    if (existing.status === "pending" && existing.cardId) {
      return { confirmation: existing, card: await this.#uiCards.get(existing.cardId) };
    }
    if (existing.status !== "pending_orchestrator") {
      throw new Error("该权限请求已经处理完成。");
    }
    const card = await this.#uiCards.show(params.cardInput, {
      conversationId: existing.conversationId,
      callId: `confirm:${existing.id}:${params.callId}`,
      toolCallId: params.callId,
      ...(params.topicId ? { topicId: params.topicId } : {}),
      ...(params.ticketId ? { ticketId: params.ticketId } : {}),
    });
    const actionMap: Record<string, string> = {};
    card.actions.forEach((action, index) => {
      const logical = params.logicalIds[index];
      if (logical !== undefined) actionMap[action.id] = logical;
    });
    const updated = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const live = findRecord(doc, existing.id);
      if (!live || live.status !== "pending_orchestrator") return undefined;
      live.cardId = card.cardId;
      live.actionMap = actionMap;
      live.status = "pending";
      live.manualInstruction = undefined;
      writeRecord(doc, live as PendingActionConfirmation & JsonObject);
      doc.byScopeFingerprint[scopeKey(live.conversationId, live.kind, live.fingerprint)] = live.id;
      return JSON.parse(JSON.stringify(live)) as PendingActionConfirmation;
    }, context);
    if (!updated) {
      await this.#uiCards.settle(card.cardId, { status: "cancelled", resultSummary: "请求已被其他操作处理" });
      const latest = await this.getById(existing.id, context);
      return { confirmation: latest ?? existing, card: await this.#uiCards.get(card.cardId) };
    }
    return { confirmation: updated, card };
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
    if (existing && existing.status === "pending" && existing.cardId) {
      return { confirmation: existing, card: await this.#uiCards.get(existing.cardId) };
    }
    if (existing && existing.status === "pending_orchestrator") {
      return this.attachCardToRequest(
        existing.id,
        {
          topicId: params.topicId,
          ticketId: params.ticketId,
          callId: params.callId,
          cardInput: params.cardInput,
          logicalIds: params.logicalIds,
        },
        context,
      );
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
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      doc.byScopeFingerprint[scopeKey(params.conversationId, params.kind, params.fingerprint)] = record.id;
    }, context);
    return { confirmation: record, card };
  }

  async resolveFromUiSubmit(
    cardId: string,
    actionId: string,
    values?: UiValues,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation | undefined> {
    return this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = doc.byCardId[cardId];
      if (!record || record.status !== "pending") return undefined;
      const logical = record.actionMap[actionId];
      if (!logical) return undefined;
      const now = Date.now();
      if (logical === "manual") {
        const instruction = typeof values?.instruction === "string" ? values.instruction.trim() : "";
        const historicalCardRecord: PendingActionConfirmation = {
          ...(JSON.parse(JSON.stringify(record)) as PendingActionConfirmation),
          status: "approved",
          resolvedAt: now,
          selectedChoiceId: "manual",
          manualInstruction: instruction,
          executed: true,
        };
        const liveOrchestratorRecord: PendingActionConfirmation = {
          ...(JSON.parse(JSON.stringify(record)) as PendingActionConfirmation),
          cardId: undefined,
          actionMap: {},
          status: "pending_orchestrator",
          resolvedAt: undefined,
          selectedChoiceId: "manual",
          manualInstruction: instruction,
          executed: false,
        };
        doc.byCardId[cardId] = historicalCardRecord as PendingActionConfirmation & JsonObject;
        doc.byId ??= {};
        doc.byId[record.id] = liveOrchestratorRecord as PendingActionConfirmation & JsonObject;
        return JSON.parse(JSON.stringify(liveOrchestratorRecord)) as PendingActionConfirmation;
      }
      record.resolvedAt = now;
      record.selectedChoiceId = logical;
      if (record.kind === "external_permission" || record.kind === "ticket_decision") {
        record.status = "approved";
      } else {
        record.status = logical === "confirm" ? "approved" : "denied";
      }
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      return JSON.parse(JSON.stringify(record)) as PendingActionConfirmation;
    }, context);
  }

  async resolveProgrammatically(
    idOrCardId: string,
    resolution: {
      status: "approved" | "denied";
      selectedChoiceId?: string;
      resultSummary: string;
      markExecuted?: boolean;
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation | undefined> {
    let openCardId: string | undefined;
    const resolved = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = findRecord(doc, idOrCardId);
      if (!record || record.executed || (record.status !== "pending_orchestrator" && record.status !== "pending")) {
        return undefined;
      }
      openCardId = record.cardId;
      record.status = resolution.status;
      record.resolvedAt = Date.now();
      if (resolution.selectedChoiceId !== undefined) {
        record.selectedChoiceId = resolution.selectedChoiceId;
      }
      record.executed = resolution.markExecuted ?? true;
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      return JSON.parse(JSON.stringify(record)) as PendingActionConfirmation;
    }, context);
    if (resolved && openCardId) {
      await this.#uiCards.settle(openCardId, {
        status: resolution.status === "approved" ? "submitted" : "cancelled",
        resultSummary: resolution.resultSummary,
      });
    }
    return resolved;
  }

  async markDispatched(idOrCardId: string, context: Context = BACKGROUND_CONTEXT): Promise<boolean> {
    return this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = findRecord(doc, idOrCardId);
      if (!record) return false;
      const current = effectiveConfirmationEffect(record);
      if (current === "dispatched" || current === "confirmed" || current === "unknown") {
        return false;
      }
      record.effect = "dispatched";
      record.dispatchedAt = Date.now();
      delete record.lastError;
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      return true;
    }, context);
  }

  async markOutcome(
    idOrCardId: string,
    effect: Exclude<ActionEffectState, "none" | "dispatched">,
    lastError?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = findRecord(doc, idOrCardId);
      if (!record) return;
      record.effect = effect;
      if (effect === "confirmed" || effect === "unknown") {
        record.executed = true;
      }
      if (lastError) {
        record.lastError = lastError.slice(0, 400);
      } else {
        delete record.lastError;
      }
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
    }, context);
  }

  /**
   * Startup / failover recovery: transitions any confirmation left in `dispatched` from a crashed
   * process into `unknown` (never auto-replaying side effects) and returns those records so the Hub
   * can wake any waiting Worker tickets or notify conversations to verify actual state.
   */
  async reconcileDispatchedOnStartup(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation[]> {
    return this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const seen = new Set<string>();
      const recovered: PendingActionConfirmation[] = [];
      const visit = (record: PendingActionConfirmation | undefined) => {
        if (!record || seen.has(record.id)) return;
        seen.add(record.id);
        if (record.effect !== "dispatched") return;
        record.effect = "unknown";
        record.executed = true;
        record.lastError = "服务重启或切换期间操作状态未决，未自动重放，请先只读核验实际结果。";
        writeRecord(doc, record as PendingActionConfirmation & JsonObject);
        recovered.push(JSON.parse(JSON.stringify(record)) as PendingActionConfirmation);
      };
      for (const record of Object.values(doc.byId ?? {})) visit(record);
      for (const record of Object.values(doc.byCardId ?? {})) visit(record);
      return recovered;
    }, context);
  }

  async markExecuted(idOrCardId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.markOutcome(idOrCardId, "confirmed", undefined, context);
  }
}
