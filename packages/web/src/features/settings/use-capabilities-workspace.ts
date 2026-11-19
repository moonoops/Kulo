import { translate as t, useI18n } from "../../moco-i18n";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CapabilitiesWorkspaceSnapshot } from "@moco/protocol";
import { redactSecrets } from "@moco/protocol";
import { mocoRest } from "../../moco-api";

interface CapabilitiesWorkspaceOptions {
  enabled: boolean;
  active?: boolean;
  connected: boolean;
  clientId: string;
  updateVersion: number;
  assistantBusy: boolean;
}

interface WorkspaceState {
  clientId: string;
  snapshot: CapabilitiesWorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
}

/** Keeps navigation independent from the lifetime of a client-bound preload. */
export class CapabilitiesWorkspaceLoader {
  #options: CapabilitiesWorkspaceOptions | null = null;
  #state: WorkspaceState = { clientId: "", snapshot: null, loading: false, error: null };
  #listeners = new Set<() => void>();
  #generation = 0;
  #request: AbortController | null = null;

  constructor(private readonly load = mocoRest.getCapabilitiesWorkspace) {}

  getState = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #setState(next: WorkspaceState) {
    this.#state = next;
    this.#listeners.forEach((listener) => listener());
  }

  #cancel() {
    ++this.#generation;
    this.#request?.abort();
    this.#request = null;
    if (this.#state.loading) this.#setState({ ...this.#state, loading: false });
  }

  update(options: CapabilitiesWorkspaceOptions) {
    const next = { ...options, active: options.active ?? options.enabled };
    const previous = this.#options;
    this.#options = next;
    if (this.#state.clientId !== next.clientId) {
      this.#cancel();
      this.#setState({ clientId: next.clientId, snapshot: null, loading: false, error: null });
    }
    if (!next.enabled || !next.connected) {
      this.#cancel();
      return;
    }
    const changed = !previous || previous.clientId !== next.clientId || !previous.enabled || !previous.connected ||
      previous.updateVersion !== next.updateVersion || (previous.assistantBusy && !next.assistantBusy);
    // Entering the page can reuse an in-flight preload; actual mutations supersede it.
    if (changed || (next.active && !previous?.active && !this.#request)) void this.refresh();
  }

  refresh = async () => {
    const options = this.#options;
    if (!options?.enabled || !options.connected) return;
    const current = ++this.#generation;
    this.#request?.abort();
    const controller = new AbortController();
    this.#request = controller;
    this.#setState({ ...this.#state, loading: true });
    try {
      const snapshot = await this.load(options.clientId, controller.signal);
      if (current !== this.#generation || controller.signal.aborted) return;
      this.#setState({ clientId: options.clientId, snapshot, loading: false, error: null });
    } catch (cause) {
      if (current === this.#generation && !controller.signal.aborted) {
        this.#setState({ ...this.#state, loading: false, error: redactSecrets(cause instanceof Error ? cause.message : t("加载能力失败", "Failed to load capabilities")) });
      }
    } finally {
      if (current === this.#generation) this.#request = null;
    }
  };

  dispose() {
    this.#options = null;
    this.#cancel();
  }
}

export function useCapabilitiesWorkspace(options: CapabilitiesWorkspaceOptions) {
  useI18n();
  const { enabled, active = enabled, connected, clientId, updateVersion, assistantBusy } = options;
  const [loader] = useState(() => new CapabilitiesWorkspaceLoader());
  const state = useSyncExternalStore(loader.subscribe, loader.getState, loader.getState);

  useEffect(() => {
    loader.update({ enabled, active, connected, clientId, updateVersion, assistantBusy });
  }, [loader, enabled, active, connected, clientId, updateVersion, assistantBusy]);
  useEffect(() => () => loader.dispose(), [loader]);
  useEffect(() => {
    if (!enabled || !active || !connected) return;
    const visible = () => { if (document.visibilityState === "visible") void loader.refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [loader, enabled, active, connected]);

  // A changed client must never briefly render another client's private input requests.
  const owned = state.clientId === clientId;
  return { snapshot: owned ? state.snapshot : null, loading: owned && state.loading, error: owned ? state.error : null, refresh: loader.refresh };
}
