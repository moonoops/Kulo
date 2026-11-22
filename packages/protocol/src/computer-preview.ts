import type { ComputerUseTool } from "./computer-use.js";

export interface ComputerPreviewTarget {
  tool: ComputerUseTool;
  sessionId: string;
}

export interface ComputerPreviewFrame {
  mimeType: "image/jpeg" | "image/png";
  data: string;
  capturedAt: number;
  deviceWidth?: number;
  deviceHeight?: number;
}

export interface ComputerPreviewUpdate {
  state: "connecting" | "live" | "unavailable" | "closed";
  frame?: ComputerPreviewFrame;
  message?: string;
  permissionRequired?: "accessibility" | "screen";
}

export interface ComputerPreviewHandoffView {
  requestId: string;
  cardId?: string;
  reason: string;
  target: ComputerUseTool;
  expiresAt: number;
  url?: string;
  app?: string;
  interactive: boolean;
}

export interface ComputerPreviewSessionView {
  id: string;
  ticketId: string;
  tool: ComputerUseTool;
  envId: string;
  deviceName: string;
  title: string;
  app?: string;
  handoff?: ComputerPreviewHandoffView;
}

export type ComputerPreviewInputEvent =
  | {
      type: "input_mouse";
      eventType: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "left" | "right" | "middle" | "none";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      type: "input_keyboard";
      eventType: "keyDown" | "keyUp" | "char";
      key?: string;
      code?: string;
      text?: string;
      windowsVirtualKeyCode?: number;
      modifiers?: number;
    }
  | {
      type: "input_touch";
      eventType: "touchStart" | "touchMove" | "touchEnd";
      touchPoints: Array<{ x: number; y: number; id?: number }>;
    }
  | {
      type: "input_text";
      text: string;
    };

export type ComputerPreviewServerMessage =
  | { type: "preview.sessions"; sessions: ComputerPreviewSessionView[] }
  | { type: "preview.update"; id: string; update: ComputerPreviewUpdate }
  | { type: "preview.error"; message: string };

// Preview frames are ephemeral UI data, separate from tool results and chat history.
export const COMPUTER_PREVIEW_MAX_DATA = 4 * 1024 * 1024;
export const COMPUTER_PREVIEW_MAX_INPUT_TEXT = 512;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function isComputerPreviewTarget(value: unknown): value is ComputerPreviewTarget {
  const v = record(value);
  return Boolean(v && Object.keys(v).every((key) => key === "tool" || key === "sessionId")
    && (v.tool === "browser" || v.tool === "desktop")
    && typeof v.sessionId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.sessionId));
}

export function isComputerPreviewInputEvent(value: unknown): value is ComputerPreviewInputEvent {
  const v = record(value);
  if (!v || typeof v.type !== "string") return false;
  const finite = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  if (v.type === "input_mouse") {
    const allowed = new Set(["type", "eventType", "x", "y", "button", "clickCount", "deltaX", "deltaY", "modifiers"]);
    if (Object.keys(v).some((k) => !allowed.has(k))) return false;
    if (!["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(String(v.eventType))) return false;
    if (!finite(v.x, -4096, 16384) || !finite(v.y, -4096, 16384)) return false;
    if (v.button !== undefined && !["left", "right", "middle", "none"].includes(String(v.button))) return false;
    if (v.clickCount !== undefined && (!Number.isInteger(v.clickCount) || (v.clickCount as number) < 0 || (v.clickCount as number) > 4)) return false;
    if (v.deltaX !== undefined && !finite(v.deltaX, -10000, 10000)) return false;
    if (v.deltaY !== undefined && !finite(v.deltaY, -10000, 10000)) return false;
    if (v.modifiers !== undefined && (!Number.isInteger(v.modifiers) || (v.modifiers as number) < 0 || (v.modifiers as number) > 15)) return false;
    return true;
  }
  if (v.type === "input_keyboard") {
    const allowed = new Set(["type", "eventType", "key", "code", "text", "windowsVirtualKeyCode", "modifiers"]);
    if (Object.keys(v).some((k) => !allowed.has(k))) return false;
    if (!["keyDown", "keyUp", "char"].includes(String(v.eventType))) return false;
    if (v.key !== undefined && (typeof v.key !== "string" || v.key.length > 64)) return false;
    if (v.code !== undefined && (typeof v.code !== "string" || v.code.length > 64)) return false;
    if (v.text !== undefined && (typeof v.text !== "string" || v.text.length > 64)) return false;
    if (v.windowsVirtualKeyCode !== undefined && (!Number.isInteger(v.windowsVirtualKeyCode) || (v.windowsVirtualKeyCode as number) < 0 || (v.windowsVirtualKeyCode as number) > 255)) return false;
    if (v.modifiers !== undefined && (!Number.isInteger(v.modifiers) || (v.modifiers as number) < 0 || (v.modifiers as number) > 15)) return false;
    return true;
  }
  if (v.type === "input_touch") {
    const allowed = new Set(["type", "eventType", "touchPoints"]);
    if (Object.keys(v).some((k) => !allowed.has(k))) return false;
    if (!["touchStart", "touchMove", "touchEnd"].includes(String(v.eventType))) return false;
    if (!Array.isArray(v.touchPoints) || v.touchPoints.length > 10) return false;
    return v.touchPoints.every((pt) => {
      const p = record(pt);
      return Boolean(p && finite(p.x, -4096, 16384) && finite(p.y, -4096, 16384) && (p.id === undefined || Number.isInteger(p.id)));
    });
  }
  if (v.type === "input_text") {
    if (Object.keys(v).some((k) => k !== "type" && k !== "text")) return false;
    return typeof v.text === "string" && v.text.length > 0 && v.text.length <= COMPUTER_PREVIEW_MAX_INPUT_TEXT && !/\x00/.test(v.text);
  }
  return false;
}

export function isComputerPreviewUpdate(value: unknown): value is ComputerPreviewUpdate {
  const v = record(value);
  if (!v || Object.keys(v).some((key) => !["state", "frame", "message", "permissionRequired"].includes(key))
    || typeof v.state !== "string" || !["connecting", "live", "unavailable", "closed"].includes(v.state)
    || v.message !== undefined && (typeof v.message !== "string" || v.message.length > 2000)
    || v.permissionRequired !== undefined && (v.state !== "unavailable" || v.permissionRequired !== "accessibility" && v.permissionRequired !== "screen")) return false;
  if (v.frame === undefined) return true;
  const frame = record(v.frame);
  return Boolean(v.state === "live" && frame && Object.keys(frame).every((key) => ["mimeType", "data", "capturedAt", "deviceWidth", "deviceHeight"].includes(key))
    && (frame.mimeType === "image/jpeg" || frame.mimeType === "image/png")
    && typeof frame.data === "string" && frame.data.length > 0 && frame.data.length <= COMPUTER_PREVIEW_MAX_DATA
    && frame.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)
    && typeof frame.capturedAt === "number" && Number.isSafeInteger(frame.capturedAt) && frame.capturedAt > 0
    && (frame.deviceWidth === undefined || typeof frame.deviceWidth === "number" && Number.isSafeInteger(frame.deviceWidth) && frame.deviceWidth > 0 && frame.deviceWidth <= 16384)
    && (frame.deviceHeight === undefined || typeof frame.deviceHeight === "number" && Number.isSafeInteger(frame.deviceHeight) && frame.deviceHeight > 0 && frame.deviceHeight <= 16384));
}
