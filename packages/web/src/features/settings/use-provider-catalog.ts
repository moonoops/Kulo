import { useEffect, useSyncExternalStore } from "react";
import type { MocoSettingsView } from "@moco/protocol";
import { providerCatalog } from "../../moco-api";

export function useProviderCatalog(settings: MocoSettingsView | null) {
  const snapshot = useSyncExternalStore(providerCatalog.subscribe, providerCatalog.getSnapshot, providerCatalog.getSnapshot);
  useEffect(() => {
    if (settings) void providerCatalog.configure(settings);
  }, [settings]);
  return { ...snapshot, loading: !snapshot.loaded && !snapshot.error, refresh: providerCatalog.refresh };
}
