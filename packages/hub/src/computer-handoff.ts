import { createHash } from "node:crypto";
import type { ComputerUseTool, UiCardInput } from "@kulo/protocol";

export const COMPUTER_HANDOFF_TTL_MS = 10 * 60_000;

export interface ActiveComputerHandoff {
  requestId: string;
  cardId?: string;
  ticketId: string;
  runEpoch: number;
  envId: string;
  tool: ComputerUseTool;
  sessionId: string;
  conversationId: number;
  originConversationId: number;
  reason: string;
  url?: string;
  app?: string;
  expiresAt: number;
}

interface TrackedHandoffEntry extends ActiveComputerHandoff {
  timer: ReturnType<typeof setTimeout>;
}

export function computerHandoffFingerprint(input: {
  ticketId: string;
  runEpoch: number;
  target: ComputerUseTool;
  sessionId: string;
  reason: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(["computer_handoff", input.ticketId, input.runEpoch, input.target, input.sessionId, input.reason.trim()]))
    .digest("hex");
}

export function buildComputerHandoffCard(input: {
  target: ComputerUseTool;
  deviceName: string;
  reason: string;
  url?: string;
  app?: string;
}): { input: UiCardInput; logicalIds: string[] } {
  const isBrowser = input.target === "browser";
  const title = isBrowser ? "需要你接管浏览器操作" : "需要你协助操作桌面应用";
  const detailLines = [
    `设备：${input.deviceName}`,
    ...(input.url ? [`页面：${input.url}`] : []),
    ...(input.app ? [`应用：${input.app}`] : []),
    `原因：${input.reason}`,
    isBrowser
      ? "请点击任务卡中的「接管操作」或放大预览窗口直接完成登录/验证，再点击「已完成，请继续」。"
      : `请在「${input.deviceName}」桌面完成操作后，点击「已完成，请继续」。`,
  ];

  const cardInput: UiCardInput = {
    title,
    fallbackText: `${title}：${input.reason}`,
    spec: {
      root: "root",
      elements: {
        root: {
          type: "Card",
          props: { title },
          children: ["body"],
        },
        body: {
          type: "Stack",
          props: { gap: "sm" },
          children: ["summary", "actions"],
        },
        summary: {
          type: "Text",
          props: { text: detailLines.join("\n") },
        },
        actions: {
          type: "Grid",
          props: { columns: 2 },
          children: ["btn_confirm", "btn_cancel"],
        },
        btn_confirm: {
          type: "Button",
          props: { actionId: "confirm", label: "已完成，请继续", variant: "primary" },
        },
        btn_cancel: {
          type: "Button",
          props: { actionId: "cancel", label: "跳过并停止", variant: "secondary" },
        },
      },
    },
    actions: [
      { id: "confirm", label: "已完成，请继续", kind: "submit" },
      { id: "cancel", label: "跳过并停止", kind: "cancel" },
    ],
  };

  return {
    input: cardInput,
    logicalIds: ["confirm", "cancel"],
  };
}

export function formatComputerHandoffResumePrompt(params: {
  action: "done" | "cancel" | "expired";
  target: ComputerUseTool;
  reason: string;
  manualInstruction?: string;
}): string {
  if (params.action === "done") {
    const verifySteps = params.target === "browser"
      ? "你必须先调用 `kulo_browser(action='get-url')` 与 `kulo_browser(action='snapshot')` 重新读取当前真实页面和登录状态，再基于最新快照元素引用继续执行；严禁沿用接管前的旧 `@eN` 引用或未经核实直接宣称成功。"
      : "你必须先调用 `kulo_desktop(action='snapshot')` 重新读取当前真实窗口状态，再基于最新快照继续执行；严禁沿用接管前的旧元素引用或未经核实直接宣称成功。";
    const note = params.manualInstruction?.trim() ? `\n用户补充说明：${params.manualInstruction.trim()}` : "";
    return `用户已完成人工接管操作（「${params.reason}」）。${note}\n${verifySteps}`;
  }
  if (params.action === "expired") {
    return `人工接管等待已超过 10 分钟并自动结束（原原因：「${params.reason}」），浏览器/设备会话已释放。请不要继续等待，直接向主智能体汇报当前受阻情况。`;
  }
  return `用户选择了跳过人工接管操作（「${params.reason}」），相关浏览器会话已关闭。请勿重复请求接管，直接按现状向主智能体汇报。`;
}

export class ActiveComputerHandoffTracker {
  readonly #byTicket = new Map<string, TrackedHandoffEntry>();

  register(entry: ActiveComputerHandoff, onExpire: (expired: ActiveComputerHandoff) => void | Promise<void>): void {
    this.clear(entry.ticketId);
    const delayMs = Math.max(1_000, entry.expiresAt - Date.now());
    const timer = setTimeout(() => {
      const current = this.#byTicket.get(entry.ticketId);
      if (!current || current.requestId !== entry.requestId) return;
      this.#byTicket.delete(entry.ticketId);
      void Promise.resolve(onExpire(entry)).catch(() => {});
    }, delayMs);
    timer.unref();
    this.#byTicket.set(entry.ticketId, { ...entry, timer });
  }

  get(ticketId: string): ActiveComputerHandoff | undefined {
    const entry = this.#byTicket.get(ticketId);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) return undefined;
    return entry;
  }

  hasActiveHandoff(ticketId: string, sessionId?: string): boolean {
    const entry = this.get(ticketId);
    if (!entry) return false;
    return sessionId === undefined || entry.sessionId === sessionId;
  }

  clear(ticketId: string): ActiveComputerHandoff | undefined {
    const entry = this.#byTicket.get(ticketId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.#byTicket.delete(ticketId);
    return entry;
  }

  closeAll(): void {
    for (const entry of this.#byTicket.values()) clearTimeout(entry.timer);
    this.#byTicket.clear();
  }
}
