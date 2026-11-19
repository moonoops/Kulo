import { translate as tr, useI18n } from "../../kulo-i18n";
import { createContext, useContext, type ReactNode } from "react";
import type { UiCardSnapshot, UiValue, UiValues } from "@kulo/protocol";

export interface CardMediaProps { assetId: string; alt?: string }
export interface CardCodeProps { code: string; language?: string; fileName?: string }

export interface CardRuntime {
  card: UiCardSnapshot;
  values: UiValues;
  errors: Record<string, string>;
  locked: boolean;
  actionDisabled: boolean;
  pendingActionId?: string;
  change: (field: string, value: UiValue) => void;
  act: (actionId: string) => void;
  renderMedia?: (props: CardMediaProps) => ReactNode;
  renderCode?: (props: CardCodeProps) => ReactNode;
}

export const CardRuntimeContext = createContext<CardRuntime | null>(null);

export function useCardRuntime(): CardRuntime {
  useI18n();
  const runtime = useContext(CardRuntimeContext);
  if (!runtime) throw new Error("Generated components require a card runtime");
  return runtime;
}

export function displayCardValue(value: UiValue | undefined): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? tr("是", "Yes") : tr("否", "No");
  return Array.isArray(value) ? value.join("、") : String(value);
}
