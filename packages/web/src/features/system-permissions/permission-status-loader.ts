import type { DesktopSystemPermissions, SystemPermissionStatus } from "@kulo/protocol";
import { readDesktopPermissions, readMicrophonePermission } from "./system-permissions";

export interface PermissionStatusSnapshot {
  microphone: SystemPermissionStatus | null;
  desktop: DesktopSystemPermissions | null;
  microphoneError: string | null;
  desktopError: string | null;
  microphoneChecking: boolean;
  desktopChecking: boolean;
  checking: boolean;
}

export class PermissionStatusLoader {
  #state: PermissionStatusSnapshot = { microphone: null, desktop: null, microphoneError: null, desktopError: null, microphoneChecking: false, desktopChecking: false, checking: false };
  #listeners = new Set<() => void>();
  #generation = 0;
  #microphoneGeneration = 0;
  #controller?: AbortController;
  #target?: { envId: string; available: boolean; error: string | null };
  #disposed = false;

  constructor(private readonly readMicrophone = readMicrophonePermission, private readonly readDesktop = readDesktopPermissions) {}

  getSnapshot = (): PermissionStatusSnapshot => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };

  #publish(change: Partial<PermissionStatusSnapshot>): void {
    this.#state = { ...this.#state, ...change };
    this.#state.checking = this.#state.microphoneChecking || this.#state.desktopChecking;
    for (const listener of this.#listeners) listener();
  }

  configure(envId: string, available: boolean, error: string | null): void {
    const changed = this.#disposed || envId !== this.#target?.envId || available !== this.#target?.available || error !== this.#target?.error;
    if (!changed) return;
    this.#disposed = false;
    this.#target = { envId, available, error };
    this.#publish({ desktop: null, desktopError: error });
    void this.refresh();
  }

  async refresh(): Promise<PermissionStatusSnapshot> {
    if (this.#disposed) return this.#state;
    await Promise.all([this.refreshMicrophone(), this.refreshDesktop()]);
    return this.#state;
  }

  async refreshDesktop(): Promise<void> {
    if (this.#disposed) return;
    const generation = ++this.#generation;
    this.#controller?.abort();
    const controller = this.#controller = new AbortController();
    const target = this.#target;
    this.#publish({ desktopChecking: Boolean(target?.available), desktopError: target?.error ?? null });
    if (!target?.available) return;
    const active = () => !this.#disposed && generation === this.#generation;
    const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
    try {
      const desktop = await this.readDesktop(target.envId, controller.signal);
      if (active()) this.#publish({ desktop });
    } catch (cause) {
      if (active()) this.#publish({ desktop: null, desktopError: message(cause) });
    } finally {
      if (active()) this.#publish({ desktopChecking: false });
    }
  }

  async refreshMicrophone(): Promise<void> {
    if (this.#disposed) return;
    const generation = ++this.#microphoneGeneration;
    const active = () => !this.#disposed && generation === this.#microphoneGeneration;
    this.#publish({ microphoneChecking: true, microphoneError: null });
    try {
      const microphone = await this.readMicrophone();
      if (active()) this.#publish({ microphone });
    } catch (cause) {
      if (active()) this.#publish({ microphone: null, microphoneError: cause instanceof Error ? cause.message : String(cause) });
    } finally { if (active()) this.#publish({ microphoneChecking: false }); }
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation++;
    this.#microphoneGeneration++;
    this.#controller?.abort();
    this.#listeners.clear();
  }
}
