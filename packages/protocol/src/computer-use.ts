export type ComputerUseTool = "browser" | "desktop";

export type ComputerScrollDirection = "up" | "down" | "left" | "right";

export type ComputerUseRequest =
  | { tool: "browser"; action: "status" }
  | { tool: "browser"; action: "open"; sessionId: string; url: string }
  | { tool: "browser"; action: "snapshot" | "get-url" | "get-text" | "back" | "forward" | "close"; sessionId: string }
  | { tool: "browser"; action: "click"; sessionId: string; ref: string }
  | { tool: "browser"; action: "fill" | "type"; sessionId: string; ref: string; text: string }
  | { tool: "browser"; action: "scroll"; sessionId: string; direction: ComputerScrollDirection; amount?: number }
  | { tool: "browser"; action: "wait"; sessionId: string; ref?: string; text?: string; timeoutMs?: number }
  | { tool: "desktop"; action: "status" }
  | { tool: "desktop"; action: "permissions" }
  | { tool: "desktop"; action: "permission-guide"; kind?: "accessibility" | "screen" }
  | { tool: "desktop"; action: "snapshot"; sessionId: string; app: string }
  | { tool: "desktop"; action: "click"; sessionId: string; app: string; ref: string }
  | { tool: "desktop"; action: "type" | "set-value"; sessionId: string; app: string; ref: string; text: string }
  | { tool: "desktop"; action: "scroll"; sessionId: string; app: string; ref: string; direction: ComputerScrollDirection; amount?: number }
  | { tool: "desktop"; action: "wait"; sessionId: string; app: string; text: string; timeoutMs?: number }
  | { tool: "desktop"; action: "close"; sessionId: string };

export interface ComputerUseResult {
  tool: ComputerUseTool;
  action: ComputerUseRequest["action"];
  sessionId?: string;
  platform: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export const COMPUTER_USE_MAX_RESULT = 1024 * 1024;
const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const browserRefPattern = /^@?e[0-9]+$/;
const desktopRefPattern = /^@s[a-zA-Z0-9_-]+:e[0-9]+$/;

export function isComputerUseRequest(value: unknown): value is ComputerUseRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.tool !== "browser" && v.tool !== "desktop" || typeof v.action !== "string") return false;
  const allowed = new Set(["tool", "action"]);
  if (v.action === "status") return Object.keys(v).every((key) => allowed.has(key));
  if (v.tool === "desktop" && v.action === "permissions") return Object.keys(v).every((key) => allowed.has(key));
  if (v.tool === "desktop" && v.action === "permission-guide") {
    allowed.add("kind");
    return (v.kind === undefined || v.kind === "accessibility" || v.kind === "screen")
      && Object.keys(v).every((key) => allowed.has(key));
  }
  allowed.add("sessionId");
  if (typeof v.sessionId !== "string" || !sessionPattern.test(v.sessionId)) return false;
  let valid = false;
  if (v.tool === "browser") {
    if (v.action === "open") {
      allowed.add("url");
      if (typeof v.url !== "string" || v.url.length > 4096) return false;
      try {
        const url = new URL(v.url);
        valid = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      } catch { return false; }
    } else if (["snapshot", "get-url", "get-text", "back", "forward", "close"].includes(v.action)) valid = true;
    else if (["click", "fill", "type"].includes(v.action)) {
      allowed.add("ref");
      valid = typeof v.ref === "string" && browserRefPattern.test(v.ref);
    } else if (v.action === "scroll") {
      allowed.add("direction");
      allowed.add("amount");
      valid =
        typeof v.direction === "string" &&
        ["up", "down", "left", "right"].includes(v.direction) &&
        (v.amount === undefined || (typeof v.amount === "number" && Number.isInteger(v.amount) && v.amount >= 1 && v.amount <= 4000));
    } else if (v.action === "wait") {
      allowed.add("ref");
      allowed.add("text");
      allowed.add("timeoutMs");
      const hasRef = v.ref !== undefined;
      const hasText = v.text !== undefined;
      valid =
        (hasRef || hasText) &&
        !(hasRef && hasText) &&
        (!hasRef || (typeof v.ref === "string" && browserRefPattern.test(v.ref))) &&
        (!hasText || (typeof v.text === "string" && v.text.length >= 1 && v.text.length <= 500 && !v.text.includes("\0"))) &&
        (v.timeoutMs === undefined || (typeof v.timeoutMs === "number" && Number.isInteger(v.timeoutMs) && v.timeoutMs >= 100 && v.timeoutMs <= 15_000));
    }
  } else if (v.action === "close") valid = true;
  else if (["snapshot", "click", "type", "set-value", "scroll", "wait"].includes(v.action)) {
    allowed.add("app");
    valid = typeof v.app === "string" && v.app.length > 0 && v.app.length <= 256 && !/[\x00-\x1f]/.test(v.app);
    if (v.action === "scroll") {
      allowed.add("ref");
      allowed.add("direction");
      allowed.add("amount");
      valid &&=
        typeof v.ref === "string" &&
        desktopRefPattern.test(v.ref) &&
        typeof v.direction === "string" &&
        ["up", "down", "left", "right"].includes(v.direction) &&
        (v.amount === undefined || (typeof v.amount === "number" && Number.isInteger(v.amount) && v.amount >= 1 && v.amount <= 20));
    } else if (v.action === "wait") {
      allowed.add("text");
      allowed.add("timeoutMs");
      valid &&=
        typeof v.text === "string" &&
        v.text.length >= 1 &&
        v.text.length <= 500 &&
        !v.text.includes("\0") &&
        (v.timeoutMs === undefined || (typeof v.timeoutMs === "number" && Number.isInteger(v.timeoutMs) && v.timeoutMs >= 200 && v.timeoutMs <= 15_000));
    } else if (v.action !== "snapshot") {
      allowed.add("ref");
      valid &&= typeof v.ref === "string" && desktopRefPattern.test(v.ref);
    }
  }
  if (["fill", "type", "set-value"].includes(v.action)) {
    allowed.add("text");
    valid &&= typeof v.text === "string" && v.text.length <= 20_000 && !v.text.includes("\0");
  }
  return valid && Object.keys(v).every((key) => allowed.has(key));
}

export function isComputerUseResult(value: unknown, request: ComputerUseRequest): value is ComputerUseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as ComputerUseResult;
  const fields = new Set(["tool", "action", "sessionId", "platform", "ok", "data", "error"]);
  if (Object.keys(v).some((key) => !fields.has(key))) return false;
  if (v.tool !== request.tool || v.action !== request.action || v.sessionId !== ("sessionId" in request ? request.sessionId : undefined)
    || typeof v.platform !== "string" || v.platform.length > 32 || typeof v.ok !== "boolean") return false;
  if (v.ok ? v.error !== undefined : !v.error || typeof v.error.code !== "string" || v.error.code.length > 128
    || typeof v.error.message !== "string" || v.error.message.length > 2000
    || Object.keys(v.error).some((key) => key !== "code" && key !== "message")) return false;
  try { return JSON.stringify(value).length <= COMPUTER_USE_MAX_RESULT; } catch { return false; }
}
