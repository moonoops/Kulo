import { translate as t, useI18n } from "../../kulo-i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatDisplayItem,
  ClientToHubMessage,
  SettingsAssistantAction,
  SettingsAssistantAppearance,
  SettingsAssistantContext,
  SettingsAssistantDecision,
  SettingsAssistantModule,
  SettingsAssistantSnapshot,
  SetupInputRequest,
} from "@kulo/protocol";
import { redactSensitiveText } from "@kulo/protocol";
import { KuloWsDisconnectedError, type KuloWsAckResult } from "../../kulo-api";
import { getAppearanceCustomization, setAppearanceCustomization, useKuloAppearance } from "../../kulo-appearance";
import { useTopicAttachments, type DraftAttachment } from "../../kulo-composer";
import { canExecuteSettingsClientAction, resolveSettingsAppearanceUndo, type SettingsAssistantEntryIntent } from "./settings-assistant-actions";
import { advanceSettingsAssistantPageScope } from "./settings-assistant-page-scope";
import { deviceApi, waitForDeviceRole } from "./device-api";

type SendMessage = Extract<ClientToHubMessage, { type: "settings.assistant.send" }>;
type Navigate = (entry: SettingsAssistantEntryIntent) => Promise<void>;
type ConversationChange = { type: "settings.assistant.new" } | { type: "settings.assistant.select" | "settings.assistant.delete"; topicId: string };
const ATTACHMENT_DRAFT_KEY = "settings-assistant";

export function readSettingsAssistantDraft(): string {
  try {
    const raw = localStorage.getItem("kulo:settings-assistant-draft") ?? "";
    const safe = redactSensitiveText(raw);
    localStorage.removeItem("kulo:settings-assistant-draft");
    return safe;
  }
  catch { return ""; }
}

export function clearSettingsAssistantDraftStorage(): void {
  localStorage.removeItem("kulo:settings-assistant-draft");
}

function readClientId(): string {
  const fresh = `settings-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  try {
    const stored = sessionStorage.getItem("kulo:settings-assistant-client");
    if (stored) return stored;
    sessionStorage.setItem("kulo:settings-assistant-client", fresh);
  } catch { /* The in-memory ID still isolates this tab when storage is unavailable. */ }
  return fresh;
}

export interface SettingsAssistantControls {
  draft: string;
  setDraft: (value: string) => void;
  attachments: readonly DraftAttachment[];
  enqueueFiles: (files: FileList | File[]) => void;
  removeAttachment: (localId: string) => void;
  retryAttachment: (localId: string) => void;
  cancelAttachment: (localId: string) => void;
  restoreInput: (message: ChatDisplayItem) => void;
  clientId: string;
  appearance: SettingsAssistantAppearance;
  sending: boolean;
  switchingConversation: boolean;
  pendingActionId: string | null;
  unconfirmedSend: boolean;
  localAppearance: { appearance: SettingsAssistantAppearance; previous: SettingsAssistantAppearance } | null;
  send: (content?: string, target?: SettingsAssistantContext["target"] | null) => Promise<void>;
  target?: SettingsAssistantContext["target"];
  focusRequest?: number;
  clearTarget?: () => void;
  sendSetupCompletion?: (request: SetupInputRequest) => Promise<"sent" | "busy" | "failed">;
  setupCompletion?: { request: SetupInputRequest; sending: boolean; error?: string } | null;
  retrySend: () => Promise<void>;
  subscribe: () => Promise<void>;
  abort: () => Promise<void>;
  createConversation: () => Promise<boolean>;
  selectConversation: (topicId: string) => Promise<boolean>;
  deleteConversation: (topicId: string) => Promise<boolean>;
  decide: (action: SettingsAssistantAction, decision: SettingsAssistantDecision) => Promise<boolean>;
  navigate: Navigate;
  changeAppearance: (mode: SettingsAssistantAppearance) => void;
  undoLocalAppearance: () => void;
}

export function useSettingsAssistant({
  enabled, module, target, focusRequest, onClearTarget, hasUnsavedChanges, connected, snapshot, sendWs, sendWsWithAck, setError, onNavigate,
}: {
  enabled: boolean;
  module: SettingsAssistantModule;
  target?: SettingsAssistantContext["target"];
  focusRequest?: number;
  onClearTarget?: () => void;
  hasUnsavedChanges: boolean;
  connected: boolean;
  snapshot: SettingsAssistantSnapshot;
  sendWs: (message: ClientToHubMessage) => boolean;
  sendWsWithAck: (message: ClientToHubMessage, timeoutMs?: number) => Promise<KuloWsAckResult>;
  setError: (error: string | null) => void;
  onNavigate: Navigate;
}): SettingsAssistantControls {
  useI18n();
  const [draft, setDraft] = useState(readSettingsAssistantDraft);
  const attachmentDraft = useTopicAttachments();
  const attachments = attachmentDraft.getAttachments(ATTACHMENT_DRAFT_KEY);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const { enqueueFiles, removeAttachment, retryAttachment, cancelAttachment, restoreAttachments } = attachmentDraft;
  const [clientId] = useState(readClientId);
  const { mode: appearance, setMode, customization: appearanceCustomization } = useKuloAppearance();
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const [sending, setSending] = useState(false);
  const [switchingConversation, setSwitchingConversation] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [unconfirmedSend, setUnconfirmedSend] = useState(false);
  const [localAppearance, setLocalAppearance] = useState<SettingsAssistantControls["localAppearance"]>(null);
  const [setupCompletion, setSetupCompletion] = useState<SettingsAssistantControls["setupCompletion"]>(null);
  const pendingSendRef = useRef<SendMessage | null>(null);
  const clientActionsRef = useRef(new Set<string>());
  const subscribedRef = useRef(false);
  const pageScopeRef = useRef({ active: enabled, module, generation: Date.now() });
  const pageRegistrationRef = useRef(0);
  pageScopeRef.current = advanceSettingsAssistantPageScope(pageScopeRef.current, enabled, module);
  const pageGeneration = pageScopeRef.current.generation;
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const context = useMemo<SettingsAssistantContext>(() => ({
    module, active: enabled, pageGeneration, hasUnsavedChanges, appearance, appearanceCustomization, clientId, ...(target ? { target } : {}),
  }), [module, enabled, pageGeneration, target, hasUnsavedChanges, appearance, appearanceCustomization, clientId]);
  const contextRef = useRef(context);
  contextRef.current = context;
  const availabilityRef = useRef({ connected, sending: sending || switchingConversation, busy: snapshot.live.busy });
  availabilityRef.current = { connected, sending: sending || switchingConversation, busy: snapshot.live.busy };

  useEffect(() => {
    try { clearSettingsAssistantDraftStorage(); }
    catch { /* Drafts remain available in this app session. */ }
  }, [draft]);

  useEffect(() => {
    setLocalAppearance(null);
    setSetupCompletion(null);
    clientActionsRef.current.clear();
  }, [snapshot.topicId]);

  const subscribe = useCallback(async () => {
    if (!connected) return;
    subscribedRef.current = true;
    try {
      await sendWsWithAck({ type: "settings.assistant.subscribe", context: contextRef.current }, 8000);
      if (!pendingSendRef.current) setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("加载设置对话失败", "Failed to load settings conversation"));
    }
  }, [connected, sendWsWithAck, setError]);

  useEffect(() => {
    if (enabled || subscribedRef.current) void subscribe();
  }, [enabled, subscribe]);

  useEffect(() => {
    if (connected && (subscribedRef.current || !enabled)) sendWs({ type: "settings.assistant.context", context });
  }, [context, connected, enabled, sendWs]);

  useEffect(() => {
    const registration = ++pageRegistrationRef.current;
    return () => queueMicrotask(() => {
      if (registration === pageRegistrationRef.current && subscribedRef.current) {
        sendWs({ type: "settings.assistant.context", context: { ...contextRef.current, active: false, pageGeneration: pageScopeRef.current.generation + 1 } });
      }
    });
  }, [sendWs]);

  const dispatch = useCallback(async (message: SendMessage) => {
    setSending(true);
    setError(null);
    try {
      await sendWsWithAck(message);
      setDraft((current) => current.trim() === message.content ? "" : current);
      const sentIds = new Set(message.attachments?.map((item) => item.id));
      for (const item of attachmentsRef.current) {
        if (item.attachment && sentIds.has(item.attachment.id)) removeAttachment(ATTACHMENT_DRAFT_KEY, item.localId);
      }
      pendingSendRef.current = null;
      setUnconfirmedSend(false);
      setSetupCompletion((current) => message.requestId === `settings-input-completed-${current?.request.id}` ? null : current);
      return true;
    } catch (error) {
      const unknown = error instanceof KuloWsDisconnectedError;
      setUnconfirmedSend(unknown);
      if (!unknown) pendingSendRef.current = null;
      setError(unknown ? t("消息接收状态待确认，草稿已保留。", "Message receipt is unconfirmed. Your draft is preserved.") : error instanceof Error ? error.message : t("发送失败", "Failed to send"));
      return false;
    } finally {
      setSending(false);
    }
  }, [sendWsWithAck, setError, removeAttachment]);

  const send = useCallback(async (content?: string, selectedTarget?: SettingsAssistantContext["target"] | null) => {
    const text = (content ?? draft).trim();
    // Shortcuts and setup follow-ups must not consume attachments in the user's draft.
    const files = content === undefined ? attachmentsRef.current : [];
    if (files.some((item) => item.status !== "ready" || !item.attachment)) return;
    const uploaded = files.flatMap((item) => item.attachment ? [item.attachment] : []);
    if ((!text && !uploaded.length) || sending || switchingConversation || snapshot.live.busy || pendingSendRef.current) return;
    if (!connected) { setError(t("与中枢连接已断开，草稿已保留。", "Disconnected from the hub. Your draft is preserved.")); return; }
    const message: SendMessage = {
      type: "settings.assistant.send", content: text,
      expectedTopicId: snapshot.topicId,
      ...(uploaded.length ? { attachments: uploaded } : {}),
      context: selectedTarget === undefined ? contextRef.current : { ...contextRef.current, target: selectedTarget ?? undefined },
      requestId: `settings-send-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
    };
    // A shortcut is an explicit message too; preserve it if acceptance fails.
    if (content !== undefined && content !== draft) setDraft((current) => current.trim() ? current : text);
    pendingSendRef.current = message;
    await dispatch(message);
  }, [draft, sending, switchingConversation, snapshot.topicId, snapshot.live.busy, connected, dispatch, setError]);

  const restoreInput = useCallback((message: ChatDisplayItem) => {
    setDraft(message.text);
    const existingIds = new Set(attachmentsRef.current.flatMap((item) => item.attachment ? [item.attachment.id] : []));
    restoreAttachments(ATTACHMENT_DRAFT_KEY, (message.attachments ?? []).filter((item) => !existingIds.has(item.id)).map((attachment) => ({
      localId: `settings-restore-${attachment.id}`, status: "ready", name: attachment.name,
      mimeType: attachment.mimeType, size: attachment.size, kind: attachment.kind, attachment,
    })));
  }, [restoreAttachments]);

  const sendSetupCompletion = useCallback(async (request: SetupInputRequest): Promise<"sent" | "busy" | "failed"> => {
    setSetupCompletion({ request, sending: false });
    // Credential submission can finish after the assistant or connection changes.
    const available = availabilityRef.current;
    if (available.sending || available.busy || pendingSendRef.current) return "busy";
    if (!available.connected) return "failed";
    setSetupCompletion({ request, sending: true });
    const message: SendMessage = {
      type: "settings.assistant.send",
      expectedTopicId: snapshot.topicId,
      content: request.kind === "secret" ? "密钥已保存，请继续配置这项能力。" : "主 Chrome 的 Flow 标签页已连接，请继续配置这项能力。",
      context: { ...contextRef.current, module: "capabilities", target: { kind: "capability", id: request.capabilityId } },
      requestId: `settings-input-completed-${request.id}`,
    };
    pendingSendRef.current = message;
    const sent = await dispatch(message);
    if (!sent) setSetupCompletion((current) => current?.request.id === request.id ? { request, sending: false, error: t("继续配置未完成，请重试。", "Setup did not finish. Try again.") } : current);
    return sent ? "sent" : "failed";
  }, [dispatch, snapshot.topicId]);

  const retrySend = useCallback(async () => {
    if (!connected || sending || !pendingSendRef.current) return;
    await dispatch({
      ...pendingSendRef.current,
      context: {
        ...pendingSendRef.current.context,
        hasUnsavedChanges: contextRef.current.hasUnsavedChanges,
        appearance: contextRef.current.appearance,
        appearanceCustomization: contextRef.current.appearanceCustomization,
        active: contextRef.current.active,
        pageGeneration: contextRef.current.pageGeneration,
      },
    });
  }, [connected, sending, dispatch]);

  const abort = useCallback(async () => {
    setError(null);
    try {
      await sendWsWithAck({ type: "settings.assistant.abort", expectedTopicId: snapshot.topicId });
    } catch (error) {
      setError(error instanceof Error ? error.message : t("操作失败", "Operation failed"));
    }
  }, [sendWsWithAck, setError, snapshot.topicId]);

  const changeConversation = useCallback(async (change: ConversationChange) => {
    if (!connected || switchingConversation || sending || snapshot.live.busy || pendingActionId || pendingSendRef.current) return false;
    setSwitchingConversation(true);
    setError(null);
    try {
      await sendWsWithAck({ ...change, expectedTopicId: snapshot.topicId });
      if (change.type !== "settings.assistant.delete" || change.topicId === snapshot.topicId) onClearTarget?.();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : change.type === "settings.assistant.delete" ? t("删除设置对话失败", "Failed to delete settings conversation") : t("切换设置对话失败", "Failed to switch settings conversation"));
      return false;
    } finally {
      setSwitchingConversation(false);
    }
  }, [connected, switchingConversation, sending, snapshot.topicId, snapshot.live.busy, pendingActionId, sendWsWithAck, setError, onClearTarget]);

  const decide = useCallback(async (action: SettingsAssistantAction, decision: SettingsAssistantDecision): Promise<boolean> => {
    if (pendingActionId) return false;
    setPendingActionId(action.id); setError(null);
    let appearanceUndo: { before: SettingsAssistantAppearance; after: SettingsAssistantAppearance } | undefined;
    let customizationUndo: { before: SettingsAssistantContext["appearanceCustomization"]; after: SettingsAssistantContext["appearanceCustomization"] } | undefined;
    try {
      if (action.kind === "appearance-customization") {
        if (action.clientId !== clientId) throw new Error(t("请在发起定制的窗口操作。", "Use the window where this customization was requested."));
        const current = getAppearanceCustomization();
        if (decision === "undo") {
          if (JSON.stringify(current) !== JSON.stringify(action.customization) && JSON.stringify(current) !== JSON.stringify(action.previousCustomization ?? null)) throw new Error(t("外观已再次修改，请重新生成方案。", "Appearance changed again. Generate a new proposal."));
          customizationUndo = { before: current, after: action.previousCustomization ?? null };
          setAppearanceCustomization(action.previousCustomization ?? null);
        } else if (decision === "client-applied" && JSON.stringify(current) !== JSON.stringify(action.customization)) {
          throw new Error(t("当前外观与待确认方案不同，请重新生成方案。", "The current appearance differs from this proposal. Generate a new proposal."));
        }
      }
      if (action.kind === "appearance" && decision === "undo") {
        const previous = resolveSettingsAppearanceUndo(action, appearance, clientId);
        if (appearance !== previous) {
          appearanceUndo = { before: appearance, after: previous };
          appearanceRef.current = previous;
          setMode(previous);
        }
      }
      if (action.clientOperation && decision === "confirm") {
        if (action.clientId && action.clientId !== clientId) {
          throw new Error(t("请在发起请求的客户端窗口操作。", "Confirm this action in the client window where it was requested."));
        }
        try {
          await sendWsWithAck({ type: "settings.assistant.action", actionId: action.id, decision, clientId, expectedTopicId: snapshot.topicId });
        } catch (ackError) {
          if (action.clientOperation !== "join-device" || !(ackError instanceof KuloWsDisconnectedError)) throw ackError;
        }
        if (action.clientOperation === "join-device") await waitForDeviceRole(action.id, "joined");
        else await deviceApi.leave();
        return true;
      }
      await sendWsWithAck({ type: "settings.assistant.action", actionId: action.id, decision, clientId, expectedTopicId: snapshot.topicId });
      return true;
    } catch (error) {
      if (customizationUndo && !(error instanceof KuloWsDisconnectedError) && JSON.stringify(getAppearanceCustomization()) === JSON.stringify(customizationUndo.after)) setAppearanceCustomization(customizationUndo.before ?? null);
      if (appearanceUndo && !(error instanceof KuloWsDisconnectedError) && appearanceRef.current === appearanceUndo.after) {
        appearanceRef.current = appearanceUndo.before;
        setMode(appearanceUndo.before);
      }
      setError(action.kind === "appearance" && decision === "undo" && error instanceof KuloWsDisconnectedError
        ? t("当前窗口已撤销外观修改，结果同步待确认，请重连后再次点击撤销。", "Appearance changes were undone in this window. Reconnect and click Undo again to confirm synchronization.")
        : error instanceof Error ? error.message : t("执行设置操作失败", "Failed to apply settings action"));
      return false;
    } finally { setPendingActionId(null); }
  }, [pendingActionId, clientId, appearance, setMode, sendWsWithAck, setError, snapshot.topicId]);

  useEffect(() => {
    if (!connected) return;
    for (const action of snapshot.actions) {
      if (!canExecuteSettingsClientAction(action, clientId) || clientActionsRef.current.has(action.id)) continue;
      if (action.kind === "navigate" && !enabled && !action.fromMainChat) continue;
      clientActionsRef.current.add(action.id);
      void (async () => {
        let failure: string | undefined;
        try {
          if (action.kind === "appearance") {
            if (!action.appearance) throw new Error(t("缺少外观模式。", "Appearance mode missing."));
            // Reloaded actions must not undo a more recent manual preference.
            if (appearance !== action.appearance && appearance !== action.previousAppearance) throw new Error(t("外观已再次修改，请重新提出设置要求。", "Appearance changed again. Submit a new settings request."));
            setMode(action.appearance);
          } else {
            if (!action.module) throw new Error(t("缺少目标设置页。", "Target settings page missing."));
            await navigateRef.current({ id: action.id, module: action.module, intent: action.intent });
          }
        } catch (error) { failure = error instanceof Error ? error.message : t("执行浏览器操作失败", "Browser action failed"); }
        try {
          await sendWsWithAck({
            type: "settings.assistant.action", actionId: action.id, clientId,
            expectedTopicId: snapshot.topicId,
            decision: failure ? "client-failed" : "client-applied", ...(failure ? { error: failure } : {}),
          });
          if (failure) setError(failure);
        } catch (error) {
          clientActionsRef.current.delete(action.id);
          setError(error instanceof Error ? error.message : t("操作结果同步失败，请重连后重试。", "Failed to synchronize the result. Reconnect and try again."));
        }
      })();
    }
  }, [snapshot.actions, snapshot.topicId, connected, enabled, clientId, appearance, setMode, sendWsWithAck, setError]);

  const changeAppearance = useCallback((next: SettingsAssistantAppearance) => {
    setLocalAppearance({ appearance: next, previous: appearance }); setMode(next);
  }, [appearance, setMode]);
  const undoLocalAppearance = useCallback(() => {
    if (!localAppearance) return;
    if (appearance !== localAppearance.appearance) { setError(t("外观已再次修改，请直接选择需要的模式。", "Appearance changed again. Select the mode you want.")); return; }
    setMode(localAppearance.previous); setLocalAppearance(null);
  }, [localAppearance, appearance, setMode, setError]);

  return {
    draft, setDraft, attachments,
    enqueueFiles: (files) => enqueueFiles(ATTACHMENT_DRAFT_KEY, files),
    removeAttachment: (id) => removeAttachment(ATTACHMENT_DRAFT_KEY, id),
    retryAttachment: (id) => retryAttachment(ATTACHMENT_DRAFT_KEY, id),
    cancelAttachment: (id) => cancelAttachment(ATTACHMENT_DRAFT_KEY, id),
    restoreInput,
    clientId, appearance, sending, switchingConversation, pendingActionId, unconfirmedSend, localAppearance, target, focusRequest, clearTarget: onClearTarget,
    send, retrySend, subscribe, abort,
    createConversation: () => changeConversation({ type: "settings.assistant.new" }),
    selectConversation: (topicId) => changeConversation({ type: "settings.assistant.select", topicId }),
    deleteConversation: (topicId) => changeConversation({ type: "settings.assistant.delete", topicId }),
    sendSetupCompletion,
    setupCompletion,
    decide, navigate: onNavigate, changeAppearance, undoLocalAppearance,
  };
}
