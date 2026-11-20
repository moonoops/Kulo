import type { KuloLanguage, KuloSettingsView } from "@kulo/protocol";
import { KuloApiError, kuloRest } from "../../kulo-api";

export interface PresentationLanguageSyncApi {
  getSettings: () => Promise<KuloSettingsView>;
  saveSettingsBlock: (
    block: "presentation",
    expectedRevision: number,
    value: KuloSettingsView["blocks"]["presentation"]["value"],
  ) => Promise<{ settings: KuloSettingsView }>;
}

/**
 * Syncs the chosen UI language into Hub `presentation.language` so backend prompts,
 * default identity templates, and unmodified role presets follow the active language.
 * Retries once on 409 conflict without clobbering concurrent agentName updates.
 */
export async function syncPresentationLanguage(
  settings: KuloSettingsView | null | undefined,
  language: KuloLanguage,
  onSettingsUpdated?: (next: KuloSettingsView) => void,
  api: PresentationLanguageSyncApi = kuloRest,
): Promise<KuloSettingsView | null> {
  if (!settings) return null;
  const block = settings.blocks.presentation;
  if (block.value.language === language) return null;
  const persist = async (target: KuloSettingsView["blocks"]["presentation"]) => {
    const res = await api.saveSettingsBlock("presentation", target.revision, {
      ...target.value,
      language,
    });
    onSettingsUpdated?.(res.settings);
    return res.settings;
  };
  try {
    return await persist(block);
  } catch (error) {
    if (error instanceof KuloApiError && error.status === 409) {
      try {
        const latest = await api.getSettings();
        if (latest.blocks.presentation.value.language === language) {
          onSettingsUpdated?.(latest);
          return latest;
        }
        return await persist(latest.blocks.presentation);
      } catch (retryError) {
        console.warn("[Kulo] Failed to sync interface language after revision conflict:", retryError);
        return null;
      }
    }
    console.warn("[Kulo] Failed to sync interface language to hub:", error);
    return null;
  }
}
