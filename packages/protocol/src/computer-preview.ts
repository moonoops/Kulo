import type { ComputerUseTool } from "./computer-use.js";

export interface ComputerPreviewTarget {
  tool: ComputerUseTool;
  sessionId: string;
}

export interface ComputerPreviewFrame {
  mimeType: "image/jpeg" | "image/png";
  data: string;
  capturedAt: number;
}

export interface ComputerPreviewUpdate {
  state: "connecting" | "live" | "unavailable" | "closed";
  frame?: ComputerPreviewFrame;
  message?: string;
  permissionRequired?: "accessibility" | "screen";
}

export interface ComputerPreviewSessionView {
  id: string;
  ticketId: string;
  tool: ComputerUseTool;
  envId: string;
  deviceName: string;
  title: string;
  app?: string;
}

export type ComputerPreviewServerMessage =
  | { type: "preview.sessions"; sessions: ComputerPreviewSessionView[] }
  | { type: "preview.update"; id: string; update: ComputerPreviewUpdate }
  | { type: "preview.error"; message: string };

// Preview frames are ephemeral UI data, separate from tool results and chat history.
export const COMPUTER_PREVIEW_MAX_DATA = 4 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function isComputerPreviewTarget(value: unknown): value is ComputerPreviewTarget {
  const v = record(value);
  return Boolean(v && Object.keys(v).every((key) => key === "tool" || key === "sessionId")
    && (v.tool === "browser" || v.tool === "desktop")
    && typeof v.sessionId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.sessionId));
}

export function isComputerPreviewUpdate(value: unknown): value is ComputerPreviewUpdate {
  const v = record(value);
  if (!v || Object.keys(v).some((key) => !["state", "frame", "message", "permissionRequired"].includes(key))
    || typeof v.state !== "string" || !["connecting", "live", "unavailable", "closed"].includes(v.state)
    || v.message !== undefined && (typeof v.message !== "string" || v.message.length > 2000)
    || v.permissionRequired !== undefined && (v.state !== "unavailable" || v.permissionRequired !== "accessibility" && v.permissionRequired !== "screen")) return false;
  if (v.frame === undefined) return true;
  const frame = record(v.frame);
  return Boolean(v.state === "live" && frame && Object.keys(frame).every((key) => ["mimeType", "data", "capturedAt"].includes(key))
    && (frame.mimeType === "image/jpeg" || frame.mimeType === "image/png")
    && typeof frame.data === "string" && frame.data.length > 0 && frame.data.length <= COMPUTER_PREVIEW_MAX_DATA
    && frame.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)
    && typeof frame.capturedAt === "number" && Number.isSafeInteger(frame.capturedAt) && frame.capturedAt > 0);
}
