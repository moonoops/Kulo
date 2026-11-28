/** Orchestrates workbench overlays, previews, and overlay-aware keyboard shortcuts. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@heroui/react";
import type { ClientToHubMessage, LiveStreamState, TopicSummary } from "@kulo/protocol";
import type { PreviewableImage } from "../../kulo-composer";
import { translate as t } from "../../kulo-i18n";
import type { ChatViewItem } from "../chat/chat-submissions";
import { messageQuote } from "../chat/message-actions";
import {
  getFrozenTargetUnavailableReason,
  type ModalFooterComposerTarget,
  type PreviewCommandContextValue,
} from "../chat/modal-footer-composer";
import { useComputerPreview } from "../computer-preview/use-computer-preview";
import {
  hasBlockingOverlay,
  hasNonEmptyTextSelection,
  isEditableKeyboardTarget,
  resolveKeyboardShortcut,
  type AppShortcutCommand,
} from "../shortcuts/shortcuts";

export type ConversationSearchScope = "all" | "current";

export interface UseWorkbenchOverlaysParams {
  connected: boolean;
  deliveryScope?: string;
  settingsMode: boolean;
  rightExpanded: boolean;
  sendWsWithAck: (message: ClientToHubMessage, timeoutMs?: number) => Promise<unknown>;
}

/** Manages modal/preview overlay state (search dialog, lightbox, computer preview) for the workbench shell. */
export function useWorkbenchOverlays({
  connected,
  deliveryScope,
  settingsMode,
  rightExpanded,
  sendWsWithAck,
}: UseWorkbenchOverlaysParams) {
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchScope, setConversationSearchScope] = useState<ConversationSearchScope>("all");
  const [conversationSearchScopeVersion, setConversationSearchScopeVersion] = useState(0);
  const openConversationSearch = useCallback((scope: ConversationSearchScope) => {
    setConversationSearchScope(scope);
    setConversationSearchScopeVersion((version) => version + 1);
    setConversationSearchOpen(true);
  }, []);

  useEffect(() => {
    setConversationSearchOpen(false);
  }, [deliveryScope]);

  const [lightboxImage, setLightboxImage] = useState<PreviewableImage | null>(null);
  const closeLightbox = useCallback(() => setLightboxImage(null), []);

  const computerPreview = useComputerPreview("*", connected && !settingsMode, !settingsMode && rightExpanded);
  const stopComputerPreviewTask = useCallback(async (ticketId: string) => {
    await sendWsWithAck({ type: "ticket.stop", ticketId, reason: "手动停止" });
  }, [sendWsWithAck]);
  const computerPreviewBinding = useMemo(
    () => ({ state: computerPreview.state, client: computerPreview.client, onStop: stopComputerPreviewTask }),
    [computerPreview.state, computerPreview.client, stopComputerPreviewTask],
  );
  const openPreviewModal = useCallback((sessionId: string) => {
    computerPreview.client.openModal(sessionId);
  }, [computerPreview.client]);

  return {
    conversationSearchOpen,
    setConversationSearchOpen,
    conversationSearchScope,
    conversationSearchScopeVersion,
    openConversationSearch,
    lightboxImage,
    setLightboxImage,
    closeLightbox,
    computerPreview,
    stopComputerPreviewTask,
    computerPreviewBinding,
    openPreviewModal,
  };
}

/** Assembles a stable PreviewCommandContext value that evaluates live target availability for frozen snapshots. */
export function usePreviewCommandContextValue({
  topicId,
  conversationId,
  connected,
  topics,
  onSendToTopic,
}: {
  topicId: string;
  conversationId?: number;
  connected: boolean;
  topics: readonly TopicSummary[];
  onSendToTopic: (target: ModalFooterComposerTarget, text: string) => Promise<void>;
}): PreviewCommandContextValue {
  const sendRef = useRef(onSendToTopic);
  sendRef.current = onSendToTopic;
  const stableSend = useCallback(
    (target: ModalFooterComposerTarget, text: string) => sendRef.current(target, text),
    [],
  );
  const getUnavailableReason = useCallback(
    (target: ModalFooterComposerTarget) =>
      getFrozenTargetUnavailableReason(target, { connected, topics }),
    [connected, topics],
  );
  return useMemo(
    () => ({
      topicId,
      ...(conversationId !== undefined ? { conversationId } : {}),
      connected,
      getUnavailableReason,
      onSendToTopic: stableSend,
    }),
    [topicId, conversationId, connected, getUnavailableReason, stableSend],
  );
}

export interface UseWorkbenchShortcutsParams {
  conversationSearchOpen: boolean;
  conversationSearchScope: ConversationSearchScope;
  setConversationSearchOpen: (open: boolean) => void;
  openConversationSearch: (scope: ConversationSearchScope) => void;
  settingsMode: boolean;
  projectedTicketId?: string;
  topics: readonly TopicSummary[];
  live: LiveStreamState;
  responseMessages: readonly ChatViewItem[];
  runGuardedNavigation: (action: () => void, onCancelled?: () => void) => void;
  onCreateTopic: () => void | Promise<void>;
  onEnterSettings: () => void;
  onExitSettings: () => void;
  onTogglePanel: (side: "left" | "right") => void;
  onOpenChatTopic: (topicId: string) => void;
  onCloseProjection: () => void;
  onAbortGeneration: () => void;
  onSaveActive: () => void;
}

/** Wires global keyboard shortcuts, Electron native menu commands, and Escape overlay dismissal. */
export function useWorkbenchShortcuts(params: UseWorkbenchShortcutsParams): void {
  const shortcutActionsRef = useRef<{
    runCommand: (command: AppShortcutCommand) => boolean;
    handleEscape: (event: globalThis.KeyboardEvent) => boolean;
  }>({
    runCommand: () => false,
    handleEscape: () => false,
  });

  shortcutActionsRef.current = {
    runCommand(command) {
      switch (command) {
        case "search-conversations": {
          if (hasBlockingOverlay(document, { allowSelector: '[data-kulo-overlay="conversation-search"]' })) return false;
          if (params.conversationSearchOpen && params.conversationSearchScope === "all") {
            params.setConversationSearchOpen(false);
          } else {
            params.openConversationSearch("all");
          }
          return true;
        }
        case "find-in-conversation": {
          if (params.settingsMode || params.projectedTicketId) return false;
          if (hasBlockingOverlay(document, { allowSelector: '[data-kulo-overlay="conversation-search"]' })) return false;
          params.openConversationSearch("current");
          return true;
        }
        case "new-topic": {
          if (hasBlockingOverlay(document)) return false;
          params.runGuardedNavigation(() => { void params.onCreateTopic(); });
          return true;
        }
        case "open-settings": {
          if (hasBlockingOverlay(document)) return false;
          if (params.settingsMode) params.onExitSettings();
          else params.onEnterSettings();
          return true;
        }
        case "toggle-left-panel": {
          if (hasBlockingOverlay(document, { allowSelector: '[data-kulo-overlay="workbench-drawer"]' })) return false;
          params.onTogglePanel("left");
          return true;
        }
        case "toggle-right-panel": {
          if (hasBlockingOverlay(document, { allowSelector: '[data-kulo-overlay="workbench-drawer"]' })) return false;
          params.onTogglePanel("right");
          return true;
        }
        case "open-main-chat": {
          if (hasBlockingOverlay(document)) return false;
          params.onOpenChatTopic(params.topics.find((topic) => topic.master)?.id ?? "root");
          return true;
        }
        case "stop-generation": {
          if (params.settingsMode || params.projectedTicketId || !params.live.busy) return false;
          params.onAbortGeneration();
          return true;
        }
        case "copy-last-reply": {
          if (params.settingsMode || params.projectedTicketId || hasBlockingOverlay(document) || hasNonEmptyTextSelection(window, document)) {
            return false;
          }
          const streaming = params.live.busy ? (params.live.streamingText?.trim() ?? "") : "";
          let latest = streaming;
          if (!latest) {
            for (let index = params.responseMessages.length - 1; index >= 0; index--) {
              const candidate = params.responseMessages[index]!;
              if (candidate.role !== "assistant") continue;
              const text = messageQuote(candidate).text.trim();
              if (text) { latest = text; break; }
            }
          }
          if (!latest) return false;
          void navigator.clipboard.writeText(latest).then(
            () => { toast.success(t("已复制最新回复", "Copied latest reply")); },
            () => { toast.danger(t("复制失败，请选择文字复制", "Copy failed. Select the text to copy it.")); },
          );
          return true;
        }
        case "save-active": {
          if (!params.settingsMode || hasBlockingOverlay(document)) return false;
          params.onSaveActive();
          return true;
        }
      }
    },
    handleEscape(event) {
      if (hasBlockingOverlay(document)) return false;
      if (params.projectedTicketId) {
        params.onCloseProjection();
        return true;
      }
      if (params.settingsMode) {
        const editableTarget = isEditableKeyboardTarget(event.target)
          ? event.target
          : isEditableKeyboardTarget(document.activeElement)
            ? document.activeElement
            : null;
        if (editableTarget) {
          const container = document.querySelector<HTMLElement>("main.kulo-workbench-main");
          if (container && container !== editableTarget) {
            container.focus({ preventScroll: true });
          } else {
            editableTarget.blur();
          }
          return true;
        }
        params.onExitSettings();
        return true;
      }
      return false;
    },
  };

  useEffect(() => {
    const desktopOnCommand = typeof window === "undefined" ? undefined : window.kuloDesktop?.onCommand;
    const desktopManaged = typeof desktopOnCommand === "function";
    const unsubscribe = desktopOnCommand?.((command) => {
      shortcutActionsRef.current.runCommand(command);
    });
    const onKey = (event: globalThis.KeyboardEvent) => {
      const platform = typeof navigator === "undefined" ? "" : navigator.platform;
      const action = resolveKeyboardShortcut(event, { platform, desktopManaged });
      if (!action) return;
      if (action === "escape-layer") {
        if (shortcutActionsRef.current.handleEscape(event)) event.preventDefault();
        return;
      }
      if (shortcutActionsRef.current.runCommand(action)) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unsubscribe?.();
    };
  }, []);
}
