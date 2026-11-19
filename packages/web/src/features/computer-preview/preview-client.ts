import { COMPUTER_PREVIEW_MAX_DATA, isComputerPreviewUpdate, type ComputerPreviewFrame, type ComputerPreviewSessionView, type ComputerPreviewUpdate } from "@moco/protocol";

export interface PreviewSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(message: string): void;
  close(): void;
}

export interface PreviewDisplay {
  state: ComputerPreviewUpdate["state"];
  imageUrl?: string;
  capturedAt?: number;
  message?: string;
  permissionRequired?: ComputerPreviewUpdate["permissionRequired"];
}

export interface PreviewStopState { pending: boolean; accepted?: boolean; error?: string }
export interface ComputerPreviewState {
  sessions: ComputerPreviewSessionView[];
  selectedId?: string;
  displays: Record<string, PreviewDisplay>;
  stops: Record<string, PreviewStopState>;
  collapsed: boolean;
  expanded: boolean;
  connection: "connecting" | "connected" | "reconnecting";
  error?: string;
}

export const EMPTY_PREVIEW_STATE: ComputerPreviewState = {
  sessions: [], displays: {}, stops: {}, collapsed: false, expanded: false, connection: "connecting",
};

function session(value: unknown): value is ComputerPreviewSessionView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const identifier = (input: unknown) => typeof input === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,255}$/.test(input) && !["__proto__", "constructor", "prototype"].includes(input);
  return identifier(v.id) && identifier(v.ticketId)
    && ["envId", "deviceName", "title"].every((key) => typeof v[key] === "string" && (v[key] as string).length > 0 && (v[key] as string).length <= 2000)
    && (v.tool === "browser" || v.tool === "desktop") && (v.app === undefined || typeof v.app === "string" && v.app.length <= 256);
}

export function previewFrameUrl(frame: ComputerPreviewFrame): string {
  const raw = atob(frame.data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: frame.mimeType }));
}

/** Owns one latest frame per active session; no image enters the chat history. */
export class ComputerPreviewClient {
  #state: ComputerPreviewState = EMPTY_PREVIEW_STATE;
  #socket?: PreviewSocket;
  #listeners = new Set<() => void>();
  #timer?: ReturnType<typeof setTimeout>;
  #closed = true;
  #retry = 0;
  #generation = 0;
  #pageVisible = true;

  constructor(readonly options: {
    connect(): PreviewSocket;
    createImageUrl?: (frame: ComputerPreviewFrame) => string;
    revokeImageUrl?: (url: string) => void;
  }) {}

  getSnapshot = (): ComputerPreviewState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(next: ComputerPreviewState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #revoke(url?: string): void {
    if (url) (this.options.revokeImageUrl ?? URL.revokeObjectURL)(url);
  }

  #releaseFrames(): Record<string, PreviewDisplay> {
    const displays: Record<string, PreviewDisplay> = {};
    for (const [id, display] of Object.entries(this.#state.displays)) {
      this.#revoke(display.imageUrl);
      displays[id] = { state: "connecting" };
    }
    return displays;
  }

  start(): void {
    this.#closed = false;
    this.#connect();
  }

  #detachSocket(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
  }

  #connect(): void {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    this.#detachSocket();
    const generation = ++this.#generation;
    const active = () => !this.#closed && generation === this.#generation;
    let socket: PreviewSocket;
    try { socket = this.options.connect(); }
    catch { this.#disconnected(generation); return; }
    this.#socket = socket;
    socket.onopen = () => {
      if (!active()) return;
      this.#retry = 0;
      this.#set({ ...this.#state, connection: "connected", error: undefined });
      this.#sendVisibility();
    };
    socket.onmessage = (event) => {
      if (!active() || typeof event.data !== "string") return;
      if (event.data.length > COMPUTER_PREVIEW_MAX_DATA + 64 * 1024) { this.#invalid(); return; }
      let value: unknown;
      try { value = JSON.parse(event.data); }
      catch { this.#invalid(); return; }
      this.receive(value);
    };
    socket.onerror = () => { if (active()) this.#disconnected(generation); };
    socket.onclose = () => { if (active()) this.#disconnected(generation); };
  }

  #disconnected(generation: number): void {
    if (this.#closed || generation !== this.#generation) return;
    ++this.#generation;
    this.#detachSocket();
    this.#set({ ...this.#state, displays: this.#releaseFrames(), connection: "reconnecting" });
    this.#timer = setTimeout(() => this.#connect(), Math.min(1000 * 2 ** this.#retry++, 10_000));
  }

  #invalid(): void {
    this.#set({ ...this.#state, error: "invalid_preview" });
  }

  receive(value: unknown): void {
    if (this.#closed || !value || typeof value !== "object" || Array.isArray(value)) return;
    const v = value as Record<string, unknown>;
    if (v.type === "preview.sessions") {
      if (!Array.isArray(v.sessions) || v.sessions.length > 16 || !v.sessions.every(session) || new Set(v.sessions.map((item) => item.id)).size !== v.sessions.length) { this.#invalid(); return; }
      const sessions = v.sessions;
      const displays: Record<string, PreviewDisplay> = {};
      const stops: Record<string, PreviewStopState> = {};
      for (const item of sessions) {
        const previous = this.#state.sessions.find((entry) => entry.id === item.id);
        if (previous?.ticketId === item.ticketId && previous.tool === item.tool && previous.envId === item.envId && previous.app === item.app) displays[item.id] = this.#state.displays[item.id] ?? { state: "connecting" };
        else { this.#revoke(this.#state.displays[item.id]?.imageUrl); displays[item.id] = { state: "connecting" }; }
        if (this.#state.stops[item.ticketId]) stops[item.ticketId] = this.#state.stops[item.ticketId]!;
      }
      for (const [id, display] of Object.entries(this.#state.displays)) if (!displays[id]) this.#revoke(display.imageUrl);
      this.#set({ ...this.#state, sessions, displays, stops,
        selectedId: sessions.some((item) => item.id === this.#state.selectedId) ? this.#state.selectedId : sessions[0]?.id,
        error: undefined });
    } else if (v.type === "preview.update") {
      if (typeof v.id !== "string" || !isComputerPreviewUpdate(v.update)) { this.#invalid(); return; }
      if (!this.#state.sessions.some((item) => item.id === v.id)) return;
      const update = v.update;
      const previous = this.#state.displays[v.id];
      let display: PreviewDisplay = { state: update.state, message: update.message, permissionRequired: update.permissionRequired };
      if (update.state === "live" && update.frame) {
        if (previous?.capturedAt && update.frame.capturedAt < previous.capturedAt) return;
        try { display = { ...display, imageUrl: (this.options.createImageUrl ?? previewFrameUrl)(update.frame), capturedAt: update.frame.capturedAt }; }
        catch { display = { state: "unavailable", message: "invalid_frame" }; }
      } else if (update.state === "live" && previous?.imageUrl) display = { ...previous, state: "live", message: update.message };
      if (display.imageUrl !== previous?.imageUrl) this.#revoke(previous?.imageUrl);
      this.#set({ ...this.#state, displays: { ...this.#state.displays, [v.id]: display } });
    } else if (v.type === "preview.error") {
      if (typeof v.message !== "string" || v.message.length > 2000) { this.#invalid(); return; }
      this.#set({ ...this.#state, error: v.message });
    } else this.#invalid();
  }

  #sendVisibility(): void {
    if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify({ type: "preview.visibility", visible: !this.#state.collapsed && this.#pageVisible }));
  }

  setPageVisible(visible: boolean): void { this.#pageVisible = visible; this.#sendVisibility(); }
  setCollapsed(collapsed: boolean): void { this.#set({ ...this.#state, collapsed }); this.#sendVisibility(); }
  setExpanded(expanded: boolean): void { this.#set({ ...this.#state, expanded, collapsed: false }); this.#sendVisibility(); }
  select(id: string): void {
    if (this.#state.sessions.some((item) => item.id === id)) this.#set({ ...this.#state, selectedId: id });
  }

  frameFailed(id: string, imageUrl: string): void {
    if (this.#state.displays[id]?.imageUrl !== imageUrl) return;
    this.#revoke(imageUrl);
    this.#set({ ...this.#state, displays: { ...this.#state.displays, [id]: { state: "unavailable", message: "invalid_frame" } } });
  }

  async stopTask(stop: (ticketId: string) => Promise<unknown>): Promise<void> {
    const selected = this.#state.sessions.find((item) => item.id === this.#state.selectedId);
    if (!selected || this.#state.stops[selected.ticketId]?.pending || this.#state.stops[selected.ticketId]?.accepted) return;
    const ticketId = selected.ticketId;
    const pending: PreviewStopState = { pending: true };
    this.#set({ ...this.#state, stops: { ...this.#state.stops, [ticketId]: pending } });
    const change = (status: PreviewStopState) => {
      if (!this.#closed && this.#state.stops[ticketId] === pending && this.#state.sessions.some((item) => item.ticketId === ticketId))
        this.#set({ ...this.#state, stops: { ...this.#state.stops, [ticketId]: status } });
    };
    try { await stop(ticketId); change({ pending: false, accepted: true }); }
    catch (error) { change({ pending: false, error: error instanceof Error ? error.message : "stop_failed" }); }
  }

  retry(): void {
    this.#set({ ...this.#state, displays: this.#releaseFrames(), connection: "connecting", error: undefined });
    this.#retry = 0;
    this.#connect();
  }

  close(): void {
    this.#closed = true;
    ++this.#generation;
    clearTimeout(this.#timer);
    this.#detachSocket();
    this.#releaseFrames();
    this.#set(EMPTY_PREVIEW_STATE);
  }
}
