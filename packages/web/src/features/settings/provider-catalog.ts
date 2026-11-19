import type { CustomProviderApi, MocoSettingsView, ProviderCatalogItem } from "@moco/protocol";

export interface ProviderPresetSnapshotItem {
  id: string;
  name: string;
  api: CustomProviderApi;
  baseUrl: string;
}

export interface ProviderCatalogSnapshot {
  providers: ProviderCatalogItem[];
  presets?: ProviderPresetSnapshotItem[];
  loaded: boolean;
  refreshing: boolean;
  error: Error | null;
}

export function providerCatalogSettingsKey(settings: MocoSettingsView): string {
  const { thinkingLevel: _thinking, compaction: _compaction, ...model } = settings.blocks.model.value;
  const roleModels = Object.values(settings.blocks.roles.value)
    .map(({ provider, modelId }) => [provider ?? "", modelId ?? ""])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([model, settings.blocks.model.hasApiKey, roleModels]);
}

/** Keeps the non-secret catalog alive across settings pages and conversation popovers. */
export class ProviderCatalogCache {
  #snapshot: ProviderCatalogSnapshot = { providers: [], loaded: false, refreshing: false, error: null };
  #listeners = new Set<() => void>();
  #request?: Promise<void>;
  #generation = 0;
  #stale = true;
  #settingsKey?: string;
  #scope?: string;

  constructor(private readonly load: () => Promise<{ providers: ProviderCatalogItem[]; presets?: ProviderPresetSnapshotItem[] }>) {}

  getSnapshot = (): ProviderCatalogSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #publish(change: Partial<ProviderCatalogSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }

  setScope(scope: string): void {
    if (this.#scope !== undefined && this.#scope !== scope) {
      this.invalidate();
      this.#settingsKey = undefined;
      this.#publish({ providers: [], loaded: false, error: null });
    }
    this.#scope = scope;
  }

  configure(settings: MocoSettingsView): Promise<void> {
    const key = providerCatalogSettingsKey(settings);
    if (this.#settingsKey !== undefined && key !== this.#settingsKey) this.invalidate();
    this.#settingsKey = key;
    return this.ensure();
  }

  invalidate(): void {
    this.#generation++;
    this.#stale = true;
  }

  refresh = (): Promise<void> => {
    this.invalidate();
    return this.ensure();
  };

  updateProvider(provider: ProviderCatalogItem | null, providerId = provider?.id): void {
    if (!providerId) return;
    this.#generation++;
    if (this.#request) this.#stale = true;
    if (!this.#snapshot.loaded) { void this.ensure(); return; }
    const providers = this.#snapshot.providers.filter((item) => item.id !== providerId);
    const index = this.#snapshot.providers.findIndex((item) => item.id === providerId);
    if (provider) providers.splice(index < 0 ? providers.length : index, 0, provider);
    this.#publish({ providers, error: null });
  }

  ensure = (): Promise<void> => {
    if (this.#request) return this.#request;
    if (!this.#stale) return Promise.resolve();
    this.#publish({ refreshing: true, error: null });
    // A mutation during a request makes that response obsolete. Coalesce a new read
    // after it finishes instead of running competing scans of the credential vault.
    this.#request = Promise.resolve().then(async () => {
      while (this.#stale) {
        const generation = this.#generation;
        try {
          const result = await this.load();
          if (generation !== this.#generation) continue;
          this.#stale = false;
          this.#publish({ providers: result.providers, ...(result.presets ? { presets: result.presets } : {}), loaded: true, error: null });
        } catch (error) {
          if (generation !== this.#generation) continue;
          this.#publish({ error: error instanceof Error ? error : new Error(String(error)) });
          break;
        }
      }
    }).finally(() => {
      this.#request = undefined;
      this.#publish({ refreshing: false });
    });
    return this.#request;
  };
}
