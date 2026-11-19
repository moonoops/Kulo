import { useEffect, useSyncExternalStore } from "react";
import type { KuloSettingsView } from "@kulo/protocol";
import { providerCatalog } from "../../kulo-api";

export function useProviderCatalog(settings: KuloSettingsView | null) {
  const snapshot = useSyncExternalStore(providerCatalog.subscribe, providerCatalog.getSnapshot, providerCatalog.getSnapshot);
  useEffect(() => {
    if (settings) void providerCatalog.configure(settings);
  }, [settings]);
  return { ...snapshot, loading: !snapshot.loaded && !snapshot.error, refresh: providerCatalog.refresh };
}
