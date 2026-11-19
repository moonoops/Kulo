import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerPreviewSessionView } from "@moco/protocol";
import { ComputerPreviewClient, type PreviewSocket } from "./preview-client";

export const previewSessions: ComputerPreviewSessionView[] = [
  { id: "browser-1", ticketId: "ticket-1", tool: "browser", envId: "local", deviceName: "Mac", title: "检查页面" },
  { id: "desktop-2", ticketId: "ticket-2", tool: "desktop", envId: "remote", deviceName: "Office PC", title: "编辑文档", app: "TextEdit" },
];

class Socket implements PreviewSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  close = vi.fn(() => { this.readyState = 3; });
  send(value: string) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

function setup() {
  const sockets: Socket[] = [];
  let nextImage = 0;
  const revoke = vi.fn();
  const client = new ComputerPreviewClient({
    connect: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    createImageUrl: () => `blob:image-${++nextImage}`,
    revokeImageUrl: revoke,
  });
  client.start();
  const socket = sockets[0]!;
  socket.open();
  socket.emit({ type: "preview.sessions", sessions: previewSessions });
  return { client, sockets, socket, revoke };
}

function frame(socket: Socket, id = "browser-1", capturedAt = 1) {
  socket.emit({ type: "preview.update", id, update: { state: "live", frame: { mimeType: "image/png", data: "aGVsbG8=", capturedAt } } });
}

afterEach(() => { vi.useRealTimers(); });

describe("computer preview lifecycle", () => {
  it("collapses only the image subscription, restores it, and enlarges without stopping the task", () => {
    const { client, socket } = setup();
    client.setCollapsed(true);
    expect(client.getSnapshot().collapsed).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: "preview.visibility", visible: false });
    expect(client.getSnapshot().sessions).toHaveLength(2);
    client.setExpanded(true);
    expect(client.getSnapshot()).toMatchObject({ collapsed: false, expanded: true });
    expect(socket.sent.at(-1)).toEqual({ type: "preview.visibility", visible: true });
    client.setPageVisible(false);
    expect(socket.sent.at(-1)).toEqual({ type: "preview.visibility", visible: false });
    client.close();
  });

  it("stops the selected ticket, accepts an acknowledgement across a preview reconnect, and prevents a duplicate", async () => {
    vi.useFakeTimers();
    const { client, socket, sockets } = setup();
    client.select("desktop-2");
    let resolve!: () => void;
    const stop = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const pending = client.stopTask(stop);
    expect(stop).toHaveBeenCalledWith("ticket-2");
    expect(client.getSnapshot().stops["ticket-2"]?.pending).toBe(true);
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1]!.open();
    sockets[1]!.emit({ type: "preview.sessions", sessions: previewSessions });
    client.select("browser-1");
    resolve();
    await pending;
    expect(client.getSnapshot().stops["ticket-2"]).toEqual({ pending: false, accepted: true });
    client.select("desktop-2");
    await client.stopTask(stop);
    expect(stop).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("surfaces a failed stop and allows retrying the same ticket", async () => {
    const { client } = setup();
    const stop = vi.fn().mockRejectedValueOnce(new Error("设备断开")).mockResolvedValueOnce(undefined);
    await client.stopTask(stop);
    expect(client.getSnapshot().stops["ticket-1"]).toEqual({ pending: false, error: "设备断开" });
    await client.stopTask(stop);
    expect(stop.mock.calls).toEqual([["ticket-1"], ["ticket-1"]]);
    expect(client.getSnapshot().stops["ticket-1"]?.accepted).toBe(true);
    client.close();
  });

  it("keeps one latest frame, isolates selected sessions, and releases removed, changed-app and disconnected frames", () => {
    const { client, socket, revoke } = setup();
    frame(socket);
    expect(client.getSnapshot().displays["browser-1"]?.imageUrl).toBe("blob:image-1");
    frame(socket, "browser-1", 2);
    expect(revoke).toHaveBeenCalledWith("blob:image-1");
    frame(socket, "browser-1", 1);
    expect(client.getSnapshot().displays["browser-1"]?.imageUrl).toBe("blob:image-2");
    frame(socket, "desktop-2", 3);
    client.select("desktop-2");
    expect(client.getSnapshot().displays[client.getSnapshot().selectedId!]?.imageUrl).toBe("blob:image-3");
    socket.emit({ type: "preview.sessions", sessions: [{ ...previewSessions[1], app: "Preview" }] });
    expect(revoke).toHaveBeenCalledWith("blob:image-2");
    expect(revoke).toHaveBeenCalledWith("blob:image-3");
    expect(client.getSnapshot().displays["desktop-2"]?.imageUrl).toBeUndefined();
    frame(socket, "desktop-2", 4);
    const obsoleteMessage = socket.onmessage!;
    client.close();
    expect(revoke).toHaveBeenCalledWith("blob:image-4");
    obsoleteMessage({ data: JSON.stringify({ type: "preview.sessions", sessions: previewSessions }) });
    expect(client.getSnapshot().sessions).toEqual([]);
  });

  it("rejects untrusted image data, ignores unknown sessions, and renders permission errors without stale images", () => {
    const { client, socket, revoke } = setup();
    frame(socket, "unknown", 1);
    expect(client.getSnapshot().displays.unknown).toBeUndefined();
    socket.emit({ type: "preview.update", id: "browser-1", update: { state: "live", frame: { mimeType: "image/svg+xml", data: "aGVsbG8=", capturedAt: 1 } } });
    expect(client.getSnapshot().error).toBe("invalid_preview");
    frame(socket);
    socket.emit({ type: "preview.update", id: "browser-1", update: { state: "unavailable", message: "需要录屏权限" } });
    expect(revoke).toHaveBeenCalledWith("blob:image-1");
    expect(client.getSnapshot().displays["browser-1"]).toEqual({ state: "unavailable", message: "需要录屏权限" });
    client.close();
  });

  it("drops corrupt decoded images and never lets an old load failure erase a newer frame", () => {
    const { client, socket, revoke } = setup();
    frame(socket);
    frame(socket, "browser-1", 2);
    client.frameFailed("browser-1", "blob:image-1");
    expect(client.getSnapshot().displays["browser-1"]?.imageUrl).toBe("blob:image-2");
    client.frameFailed("browser-1", "blob:image-2");
    expect(revoke).toHaveBeenCalledWith("blob:image-2");
    expect(client.getSnapshot().displays["browser-1"]).toEqual({ state: "unavailable", message: "invalid_frame" });
    client.close();
  });
});
