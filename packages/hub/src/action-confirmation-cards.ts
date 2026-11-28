import { createHash } from "node:crypto";
import type { TicketWaitOption, UiCardInput } from "@kulo/protocol";

export function hashConfirmationValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  return hashConfirmationValue(["customization_validate", sessionId, revision, [...changedFiles].sort()]);
}

export function externalPermissionFingerprint(ticketId: string, runEpoch: number, permissionId: string): string {
  return hashConfirmationValue(["external_permission", ticketId, runEpoch, permissionId]);
}

export function stagedApplyFingerprint(input: {
  ticketId: string;
  runEpoch: number;
  paths?: readonly string[];
  allowConflicts: boolean;
  sensitivePaths: readonly string[];
  conflictFiles: readonly string[];
}): string {
  return hashConfirmationValue([
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
  return hashConfirmationValue([
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
  return hashConfirmationValue([
    "ticket_decision",
    input.ticketId,
    input.runEpoch,
    input.question,
    input.options.map((opt) => [opt.id, opt.label, opt.value ?? null, opt.action ?? "reply"]),
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
  return hashConfirmationValue(["memory_service_operation", input.jobId, input.clientId, input.operation]);
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
      actions.push({ id: actionId, label: labelText, kind: option.action === "stop" ? "cancel" : "submit" });
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

export function batchDispatchFingerprint(input: {
  batchId: string;
  commandId: string;
  itemCount: number;
  claimId: string;
}): string {
  return hashConfirmationValue(["batch_dispatch", input.batchId, input.commandId, input.itemCount, input.claimId]);
}

export function buildBatchDispatchConfirmCard(input: {
  batchId: string;
  title: string;
  itemCount: number;
  itemLabels: readonly string[];
  waveSize: number;
  concurrency: number;
}): {
  input: UiCardInput;
  logicalIds: string[];
} {
  const cardTitle = clip(`确认批量只读派发（${input.itemCount} 项）`, 120);
  const description = clip(
    `${input.title} · 纯只读并行 · 单波 ≤ ${input.waveSize} · 并发 ≤ ${input.concurrency}`,
    240,
  );
  const previewLines = input.itemLabels
    .slice(0, 16)
    .map((label, index) => `${index + 1}. ${clip(label, 120)}`);
  if (input.itemLabels.length > 16) {
    previewLines.push(`… +${input.itemLabels.length - 16}`);
  }
  const cardInput: UiCardInput = {
    title: cardTitle,
    fallbackText: clip(`${cardTitle}：${description}`, 400),
    spec: {
      root: "root",
      elements: {
        root: {
          type: "Card",
          props: {
            title: cardTitle,
            description,
          },
          children: ["body"],
        },
        body: {
          type: "Stack",
          props: { gap: "sm" },
          children: ["tags", "items_preview", "actions"],
        },
        tags: {
          type: "Grid",
          props: { columns: 2 },
          children: ["chip_readonly", "chip_human"],
        },
        chip_readonly: {
          type: "Chip",
          props: { text: "纯只读并行", tone: "success" },
        },
        chip_human: {
          type: "Chip",
          props: { text: `需人工批准 (${input.itemCount} 项)`, tone: "warning" },
        },
        items_preview: {
          type: "Code",
          props: {
            fileName: `${input.batchId} 子项清单（${input.itemCount}）`,
            code: previewLines.join("\n") || "(空清单)",
          },
        },
        actions: {
          type: "Grid",
          props: { columns: 2 },
          children: ["btn_confirm", "btn_cancel"],
        },
        btn_confirm: {
          type: "Button",
          props: { actionId: "confirm", label: "允许批量执行", variant: "primary" },
        },
        btn_cancel: {
          type: "Button",
          props: { actionId: "cancel", label: "拒绝", variant: "secondary" },
        },
      },
    },
    actions: [
      { id: "confirm", label: "允许批量执行", kind: "submit" },
      { id: "cancel", label: "拒绝", kind: "cancel" },
    ],
  };
  return { input: cardInput, logicalIds: ["confirm", "cancel"] };
}
