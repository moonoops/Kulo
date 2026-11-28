import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Button, Spinner, TextArea, TextField } from "@heroui/react";
import type { TicketCardView, TopicSummary } from "@kulo/protocol";
import { translate as tr, useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { composerEnterAction, insertComposerNewline } from "./composer-keyboard";
import { isComposingKeyboardEvent } from "../shortcuts/shortcuts";
import "./modal-footer-composer.css";

export interface ModalFooterComposerTarget {
  targetKind: "file" | "chat_preview" | "ticket_preview";
  topicId: string;
  conversationId?: number;
  ticketId?: string;
  previewSessionId?: string;
  fileLabel?: string;
}

export type ModalComposerRoute = "send_to_topic" | "steer_ticket" | "resolve_handoff";

/** Explicitly separates file/chat previews from worker ticket steering and handoff resolution. */
export function resolveModalComposerRoute(
  target: ModalFooterComposerTarget,
  intent: "message" | "resolve_handoff",
): ModalComposerRoute {
  if (intent === "resolve_handoff") return "resolve_handoff";
  if (
    target.targetKind === "file" ||
    target.targetKind === "chat_preview" ||
    target.ticketId?.startsWith("chat:")
  ) {
    return "send_to_topic";
  }
  return "steer_ticket";
}

export function getFrozenTargetUnavailableReason(
  target: ModalFooterComposerTarget,
  options: {
    connected?: boolean;
    topics?: readonly TopicSummary[];
    tickets?: readonly TicketCardView[];
    previewClosed?: boolean;
  },
): string | undefined {
  if (options.connected === false) {
    return tr(
      "当前与中枢连接已断开，输入草稿已保留",
      "Disconnected from the hub. Your draft is saved.",
    );
  }
  const route = resolveModalComposerRoute(target, "message");
  if (route === "send_to_topic") {
    if (options.topics && options.topics.length > 0) {
      const topic = options.topics.find((item) => item.id === target.topicId);
      if (!topic || topic.deletedAt !== undefined) {
        return tr(
          "原话题已删除，输入草稿已保留",
          "The original topic was deleted. Your draft is saved.",
        );
      }
      if (topic.archived && !topic.master) {
        return tr(
          "原话题已归档，请还原后再发送，输入草稿已保留",
          "The original topic is archived. Restore it before sending. Your draft is saved.",
        );
      }
      if (
        target.conversationId !== undefined &&
        topic.conversationId !== undefined &&
        topic.conversationId !== target.conversationId
      ) {
        return tr(
          "原会话已归档，输入草稿已保留",
          "The original conversation has been archived. Your draft is saved.",
        );
      }
    }
    return undefined;
  }

  if (options.previewClosed) {
    return tr(
      "原任务预览已结束，输入草稿已保留",
      "The preview session has ended. Your draft is saved.",
    );
  }
  if (options.tickets && options.tickets.length > 0 && target.ticketId) {
    const ticket = options.tickets.find((item) => item.id === target.ticketId);
    if (!ticket) {
      return tr(
        "原任务已不存在，输入草稿已保留",
        "The original task is no longer available. Your draft is saved.",
      );
    }
    if (ticket.status === "stopped" || ticket.status === "closed") {
      return tr(
        "原任务已结束，输入草稿已保留",
        "The original task has ended. Your draft is saved.",
      );
    }
  }
  return undefined;
}

export interface PreviewCommandContextValue {
  topicId: string;
  conversationId?: number;
  connected: boolean;
  getUnavailableReason?: (target: ModalFooterComposerTarget) => string | undefined;
  onSendToTopic: (target: ModalFooterComposerTarget, text: string) => Promise<void> | void;
}

const PreviewCommandContext = createContext<PreviewCommandContextValue | null>(null);

export function PreviewCommandProvider({
  value,
  children,
}: {
  value: PreviewCommandContextValue | null;
  children: ReactNode;
}) {
  return (
    <PreviewCommandContext.Provider value={value}>
      {children}
    </PreviewCommandContext.Provider>
  );
}

export function usePreviewCommandContext(): PreviewCommandContextValue | null {
  return useContext(PreviewCommandContext);
}

export interface ModalFooterComposerProps {
  /** Immutable target snapshot frozen when the preview modal opened. */
  target: ModalFooterComposerTarget;
  /** True when Computer Handoff interactive takeover is active. */
  interactiveHandoff?: boolean;
  /** Hub connection status for offline guardrails. */
  connected?: boolean;
  /** Optional proactive reason why the frozen target is currently unavailable. */
  unavailableReason?: string;
  /** Optional placeholder override. */
  placeholder?: string;
  /** Invoked synchronously before expanding/focusing (e.g. to flush held remote keys/pointers). */
  onBeforeExpand?: () => void;
  /** Notifies the host modal so Modal.Backdrop and PreviewViewport can coordinate Esc & input isolation. */
  onExpandChange?: (expanded: boolean) => void;
  /** Invoked when collapsing so the host can return focus to a specific element (e.g. stageRef). */
  onCollapseFocusReturn?: () => void;
  onSendToTopic?: (target: ModalFooterComposerTarget, text: string) => Promise<void> | void;
  onSteerTicket?: (target: ModalFooterComposerTarget, text: string) => Promise<void> | void;
  onResolveHandoff?: (target: ModalFooterComposerTarget, text: string) => Promise<void> | void;
}

/** Inline expandable instruction composer mounted inside Modal.Footer as a sibling of preview viewports. */
export function ModalFooterComposer({
  target,
  interactiveHandoff = false,
  connected = true,
  unavailableReason,
  placeholder,
  onBeforeExpand,
  onExpandChange,
  onCollapseFocusReturn,
  onSendToTopic,
  onSteerTicket,
  onResolveHandoff,
}: ModalFooterComposerProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [pendingAction, setPendingAction] = useState<"message" | "resolve_handoff">();
  const [statusMessage, setStatusMessage] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const expandChangeRef = useRef(onExpandChange);
  expandChangeRef.current = onExpandChange;
  const collapseFocusReturnRef = useRef(onCollapseFocusReturn);
  collapseFocusReturnRef.current = onCollapseFocusReturn;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const collapse = useCallback((returnFocus: boolean) => {
    setExpanded(false);
    expandChangeRef.current?.(false);
    if (!returnFocus) return;
    const customReturn = collapseFocusReturnRef.current;
    if (customReturn) {
      customReturn();
    } else if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    } else {
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const expand = useCallback(() => {
    onBeforeExpand?.();
    setError(undefined);
    setExpanded(true);
    expandChangeRef.current?.(true);
  }, [onBeforeExpand]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const focusInput = () => textareaRef.current?.focus({ preventScroll: true });
    focusInput();
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(focusInput);
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [expanded]);

  const handleEscapeEvent = useCallback((event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    defaultPrevented?: boolean;
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean };
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (event.defaultPrevented) return;
    if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isComposingKeyboardEvent(event) || composingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    collapse(true);
  }, [collapse]);

  useEffect(() => {
    if (!expanded || typeof document === "undefined") return;
    const onDocumentKeyDownCapture = (event: KeyboardEvent) => {
      handleEscapeEvent(event);
    };
    document.addEventListener("keydown", onDocumentKeyDownCapture, true);
    return () => {
      document.removeEventListener("keydown", onDocumentKeyDownCapture, true);
    };
  }, [expanded, handleEscapeEvent]);

  const busy = pendingAction !== undefined;
  const trimmed = draft.trim();
  const offlineFallback = connected
    ? undefined
    : t("当前与中枢连接已断开，输入草稿已保留", "Disconnected from the hub. Your draft is saved.");
  const activeUnavailable = unavailableReason ?? offlineFallback;
  const displayedError = error ?? (expanded ? activeUnavailable : undefined);

  const submit = async (intent: "message" | "resolve_handoff") => {
    if (submittingRef.current || busy) return;
    if (intent === "message" && !trimmed) return;
    if (activeUnavailable) {
      setError(activeUnavailable);
      return;
    }

    const route = resolveModalComposerRoute(target, intent);
    const dispatch = route === "resolve_handoff"
      ? onResolveHandoff
      : route === "send_to_topic"
        ? onSendToTopic
        : onSteerTicket;

    if (!dispatch) {
      setError(t("当前预览目标暂不可用，输入草稿已保留", "This preview target is unavailable. Your draft is saved."));
      return;
    }

    submittingRef.current = true;
    setPendingAction(intent);
    setError(undefined);
    try {
      await dispatch(target, trimmed);
      if (!mountedRef.current) return;
      setDraft("");
      setError(undefined);
      setStatusMessage(
        intent === "resolve_handoff"
          ? t("已完成接管", "Handoff completed")
          : t("指令已发送", "Instruction sent"),
      );
      collapse(true);
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error && err.message.trim()
        ? err.message
        : t("发送失败，输入草稿已保留", "Failed to send. Your draft is saved.");
      setError(message);
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setPendingAction(undefined);
    }
  };

  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const handleTextareaKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      handleEscapeEvent(event);
      return;
    }
    if (isComposingKeyboardEvent(event) || composingRef.current) return;
    const action = composerEnterAction(event, platform);
    if (!action) return;
    event.preventDefault();
    if (action === "send") {
      if (trimmed && !busy) {
        void submit("message");
      }
      return;
    }
    const element = event.currentTarget;
    const currentValue = typeof element.value === "string" ? element.value : draft;
    const start = element.selectionStart ?? currentValue.length;
    const end = element.selectionEnd ?? currentValue.length;
    const next = insertComposerNewline(currentValue, start, end);
    setDraft(next.text);
    setError(undefined);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (textareaRef.current === element && element.value === next.text) {
          element.setSelectionRange(next.caret, next.caret);
        }
      });
    }
  };

  const resolvedPlaceholder = placeholder ?? (
    interactiveHandoff
      ? t("补充说明或操作结果…", "Add a note or follow-up…")
      : t("输入快捷指令…", "Send a quick instruction…")
  );
  const inputLabel = interactiveHandoff
    ? t("向当前接管任务发送说明", "Send a note for the current handoff")
    : t("向当前预览目标发送指令", "Send an instruction for the current preview");

  return (
    <div
      className="kulo-modal-footer-composer"
      data-expanded={expanded ? "true" : "false"}
      data-target-kind={target.targetKind}
      onKeyDownCapture={expanded ? handleEscapeEvent : undefined}
    >
      {!expanded ? (
        <Button
          ref={triggerRef}
          type="button"
          size="sm"
          variant="secondary"
          aria-expanded={false}
          onPress={expand}
        >
          <KuloIcon name="message" size={14} />
          {t("发指令…", "Send instruction…")}
        </Button>
      ) : (
        <>
          <div className="kulo-modal-footer-composer-row">
            <TextField
              className="kulo-context-field flex-1 min-w-0"
              variant="secondary"
              aria-label={inputLabel}
              value={draft}
              isDisabled={busy}
              onChange={(next) => {
                setDraft(next);
                if (error) setError(undefined);
              }}
            >
              <TextArea
                ref={textareaRef}
                variant="secondary"
                rows={1}
                className="scrollbar resize-none"
                placeholder={resolvedPlaceholder}
                onKeyDown={handleTextareaKeyDown}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; }}
              />
            </TextField>
            <div className="kulo-modal-footer-composer-actions">
              {interactiveHandoff ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-modal-composer-action="message"
                    isDisabled={!trimmed || busy}
                    isPending={pendingAction === "message"}
                    onPress={() => { void submit("message"); }}
                  >
                    {pendingAction === "message" && <Spinner size="sm" color="current" />}
                    {t("发消息", "Send message")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    data-modal-composer-action="resolve"
                    isDisabled={busy}
                    isPending={pendingAction === "resolve_handoff"}
                    onPress={() => { void submit("resolve_handoff"); }}
                  >
                    {pendingAction === "resolve_handoff" && <Spinner size="sm" color="current" />}
                    {t("完成接管", "Finish handoff")}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  data-modal-composer-action="send"
                  isDisabled={!trimmed || busy}
                  isPending={pendingAction === "message"}
                  onPress={() => { void submit("message"); }}
                >
                  {pendingAction === "message" && <Spinner size="sm" color="current" />}
                  {t("发送", "Send")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                isIconOnly
                isDisabled={busy}
                aria-label={t("收起指令输入", "Collapse instruction input")}
                onPress={() => collapse(true)}
              >
                <KuloIcon name="close" size={16} />
              </Button>
            </div>
          </div>
          {displayedError && (
            <p className="kulo-modal-footer-composer-feedback text-xs text-danger" role="alert">
              {displayedError}
            </p>
          )}
        </>
      )}
      {statusMessage && <span className="sr-only" role="status">{statusMessage}</span>}
    </div>
  );
}
