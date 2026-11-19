import { createContext, createElement, useContext, useEffect, useRef, type ReactNode, type RefObject } from "react";

export const APP_SHORTCUT_COMMANDS = [
  "new-topic",
  "open-settings",
  "search-conversations",
  "find-in-conversation",
  "toggle-left-panel",
  "toggle-right-panel",
  "open-main-chat",
  "stop-generation",
  "copy-last-reply",
  "save-active",
] as const;

export type AppShortcutCommand = (typeof APP_SHORTCUT_COMMANDS)[number];

export interface ShortcutKeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}

export function isMacShortcutPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function isComposingKeyboardEvent(event: Pick<ShortcutKeyLike, "isComposing" | "keyCode" | "nativeEvent">): boolean {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229);
}

/**
 * Resolves a DOM keydown event into a Moco shortcut action.
 * When `desktopManaged` is true (Electron desktop with native menu accelerators),
 * menu-owned shortcuts are skipped here so they never fire twice; Escape remains
 * renderer-owned for layered in-app dismissal.
 */
export function resolveKeyboardShortcut(
  event: ShortcutKeyLike,
  options: { platform: string; desktopManaged: boolean },
): AppShortcutCommand | "escape-layer" | undefined {
  if (event.defaultPrevented || isComposingKeyboardEvent(event)) return undefined;

  if (
    event.key === "Escape" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    return "escape-layer";
  }

  if (options.desktopManaged) return undefined;

  const isMac = isMacShortcutPlatform(options.platform);
  const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.altKey) return undefined;

  const key = event.key.toLowerCase();
  const isBackslash = event.code === "Backslash" || event.key === "\\" || event.key === "|";
  const isPeriod = event.code === "Period" || event.key === ".";

  if (!event.shiftKey) {
    if (key === "k") return "search-conversations";
    if (key === "f") return "find-in-conversation";
    if (isBackslash) return "toggle-left-panel";
    if (isPeriod) return "stop-generation";
    if (key === "s") return "save-active";
    return undefined;
  }

  if (isBackslash) return "toggle-right-panel";
  if (key === "c") return "copy-last-reply";
  return undefined;
}

const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="popover"], .react-aria-Popover';

export function isElementHiddenOrInert(element: Element): boolean {
  if (element.closest('[inert], [data-inert="true"], [hidden], [aria-hidden="true"]')) return true;
  if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return true;
  }
  return false;
}

export function hasBlockingOverlay(
  doc: Document | null | undefined = typeof document === "undefined" ? null : document,
  options?: { allowSelector?: string },
): boolean {
  if (!doc) return false;
  const nodes = doc.querySelectorAll(OVERLAY_SELECTOR);
  for (const node of nodes) {
    if (isElementHiddenOrInert(node)) continue;
    if (options?.allowSelector && (node.matches(options.allowSelector) || node.closest(options.allowSelector))) {
      continue;
    }
    return true;
  }
  return false;
}

export function isEditableKeyboardTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  if (target instanceof HTMLInputElement) {
    return !target.readOnly && !target.disabled && !["button", "checkbox", "radio", "submit", "reset"].includes(target.type);
  }
  return target.getAttribute("role") === "textbox" || target.getAttribute("role") === "combobox";
}

export function hasNonEmptyTextSelection(
  win: Window | null | undefined = typeof window === "undefined" ? null : window,
  doc: Document | null | undefined = typeof document === "undefined" ? null : document,
): boolean {
  const active = doc?.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (typeof active.selectionStart === "number" && typeof active.selectionEnd === "number" && active.selectionEnd > active.selectionStart) {
      return true;
    }
  }
  const selected = win?.getSelection?.()?.toString() ?? "";
  return selected.trim().length > 0;
}

interface ShortcutSaveEntry {
  id: number;
  isActive(): boolean;
  save(): void;
}

interface ShortcutSaveRegistry {
  register(entry: ShortcutSaveEntry): () => void;
  trigger(): boolean;
}

const noopRegistry: ShortcutSaveRegistry = {
  register: () => () => {},
  trigger: () => false,
};

const ShortcutSaveContext = createContext<ShortcutSaveRegistry>(noopRegistry);

export function ShortcutSaveProvider({ children }: { children: ReactNode }) {
  const entriesRef = useRef<ShortcutSaveEntry[]>([]);
  const registryRef = useRef<ShortcutSaveRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = {
      register(entry) {
        entriesRef.current = [...entriesRef.current.filter((item) => item.id !== entry.id), entry];
        return () => {
          entriesRef.current = entriesRef.current.filter((item) => item.id !== entry.id);
        };
      },
      trigger() {
        for (let index = entriesRef.current.length - 1; index >= 0; index--) {
          const entry = entriesRef.current[index]!;
          if (entry.isActive()) {
            entry.save();
            return true;
          }
        }
        return false;
      },
    };
  }
  return createElement(ShortcutSaveContext.Provider, { value: registryRef.current }, children);
}

let nextSaveEntryId = 1;

export function useRegisterShortcutSave(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onSave: () => void,
): void {
  const registry = useContext(ShortcutSaveContext);
  const idRef = useRef(0);
  if (!idRef.current) idRef.current = nextSaveEntryId++;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  useEffect(() => {
    const id = idRef.current;
    return registry.register({
      id,
      isActive: () => {
        if (!enabledRef.current) return false;
        const element = containerRef.current;
        if (!element) return false;
        return !isElementHiddenOrInert(element);
      },
      save: () => { saveRef.current(); },
    });
  }, [registry, containerRef]);
}

export function useShortcutSaveTrigger(): () => boolean {
  const registry = useContext(ShortcutSaveContext);
  return registry.trigger;
}
