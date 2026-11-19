/** Moco SuperAgent shell with a single-column conversation (HeroUI v3). */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Alert,
  Button,
  Chip,
  Disclosure,
  Dropdown,
  Label,
  Spinner,
  toast,
} from "@heroui/react";
import {
  parseStandaloneDeviceInvitation,
  redactDeviceInvitationText,
  type ChatReplyReference,
  type ConversationMessageWindow,
  type SettingsAssistantContext,
} from "@moco/protocol";
import { ConfirmDialog } from "./components/confirm-dialog";
import { MocoTurnErrorCard } from "./features/chat/turn-error-card";
import { ComputerPreview } from "./features/computer-preview/computer-preview";
import { describeLocalizedMocoError } from "./moco-error";
import {
  WorkbenchShell,
  type WindowSizeClass,
} from "./features/shell/workbench-shell";
import { transitionSettingsLayout } from "./features/shell/settings-transition";
import { composerDraftKey, resolveTaskChatReturn, restoreComposerDraft, restoredChatScroll, type TaskChatReturn } from "./features/tasks/task-navigation";
import { TopicsSidebar } from "./features/topics/topics-sidebar";
import { TopicDraftStore } from "./features/topics/topic-drafts";
import { useTopicActivity } from "./features/topics/use-topic-activity";
import { unfinishedTicket, type ProjectNavigationRequest } from "./features/projects/project-model";
import { useSettingsAssistant } from "./features/settings/use-settings-assistant";
import { useSettingsNavigation } from "./features/settings/use-settings-navigation";
import { settingsSaveActivity } from "./features/settings/settings-save-activity";
import { useCapabilitiesWorkspace } from "./features/settings/use-capabilities-workspace";
import { ADD_IMAGE_PROMPT, IMAGE_ROUTING_PROMPT, type CapabilityView, type ImageAssistantRequest } from "./features/settings/capability-views";
import { useConnectionsWorkspace } from "./features/settings/use-connections-workspace";
import type { ConnectionPrepare } from "./features/settings/connections-module";
import type { SettingsAssistantEntryIntent } from "./features/settings/settings-assistant-actions";
import type { SystemPermissionEntry } from "./features/system-permissions/system-permissions";
import {
  MocoWsDisconnectedError,
  mocoRest,
  useMocoHubConnection,
  type TicketDetailSnapshot,
} from "./moco-api";
import { useMocoAppearance } from "./moco-appearance";
import { useI18n, translate as t } from "./moco-i18n";
import { acceptSettingsSnapshot, settingsModuleTitle } from "./features/settings/settings-helpers";
import {
  AttachmentLightbox,
  composerPlaceholder,
  MocoComposer,
  useTopicAttachments,
  type PreviewableImage,
} from "./moco-composer";
import { MocoIcon } from "./moco-icon";
import { ConnectedMessageContent } from "./features/chat/connected-message-content";
import { DispatchMessageGroup } from "./features/chat/dispatch-message-group";
import { groupDispatchReplies, matchingLiveDispatchGroupKey, type ConversationEntry } from "./features/chat/dispatch-groups";
import { liveResponseMessageId, mergeResponseMessages } from "./features/chat/response-messages";
import { MocoThinkingIndicator } from "./features/chat/thinking-indicator";
import { chatDeliveryLabel, mergeChatSubmissions, splitChatTimeline, submissionKey, type ChatViewItem, type PendingSubmissionBackup, type SubmissionBackupInput } from "./features/chat/chat-submissions";
import { blockerDraftKey, consumedOutboxReceipts, consumePersistedDraft, outboxSubmissions } from "./features/chat/outbox-submissions";
import { newDeliveryId } from "./features/chat/reliable-intents";
import { useChatDeviceJoin } from "./features/chat/use-chat-device-join";
import { legacyInvitationCode, redactChatInvitation } from "./features/chat/device-invitation-outbox";
import { consumeReplyDraft, restoreReplyDraft, type ReplyDrafts } from "./features/chat/reply-reference";
import { ConversationOutline } from "./features/chat/conversation-outline";
import { ConversationScene } from "./features/chat/conversation-scene";
import { ConversationFilesButton, ConversationSearchDialog, type ConversationDestination } from "./features/chat/conversation-library";
import { messageQuote } from "./features/chat/message-actions";
import {
  hasBlockingOverlay,
  hasNonEmptyTextSelection,
  isEditableKeyboardTarget,
  resolveKeyboardShortcut,
  ShortcutSaveProvider,
  useShortcutSaveTrigger,
  type AppShortcutCommand,
} from "./features/shortcuts/shortcuts";
import { mergeLocatedMessages, visibleMessageId } from "./features/chat/conversation-navigation";
import { cardAdjustmentDraft } from "./features/genui/card-value-summary";
import { MessageMotion, messageMotionKey, responseMotionScopes, StreamingMessage, useLiveResponseEntryMotion, useMessageEntryMotion } from "./features/chat/message-motion";
import { buildConversationTurns, conversationTurnId, isConversationTurn } from "./features/chat/conversation-outline-model";
import { transcribeVoiceRecording } from "./features/chat/voice-transcription";
import type { TranscribeVoice } from "./features/chat/voice-recorder";
import { VoiceProvider, useVoiceWorkspace } from "./features/voice/voice-context";
import { VoiceIcon } from "./features/voice/voice-icons";
import {
  MocoSettingsBoard,
  MocoSettingsRail,
  SETTINGS_MODULES,
  type SettingsModuleId,
} from "./moco-settings";
import {
  MocoTaskProjection,
  MocoTaskRail,
  TaskDispatchCard,
  TaskStatus,
} from "./moco-tasks";

function subscribeWindowSize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

const getWindowSizeClass = (): WindowSizeClass =>
  window.innerWidth >= 1060
    ? "expanded"
    : window.innerWidth >= 840
      ? "medium"
      : "compact";

function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function AgentNavigationToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  useI18n();
  const voice = useVoiceWorkspace();
  const returnToCall = Boolean(voice?.call.call) && !expanded;
  return <Button size="sm" isIconOnly variant="ghost" className="moco-window-control"
    aria-label={returnToCall ? t("展开通话卡片", "Expand call") : expanded ? t("收起导航", "Collapse navigation") : t("展开导航", "Expand navigation")} aria-expanded={expanded}
    onPress={() => { if (returnToCall) voice?.call.expand(); onToggle(); }}>
    {returnToCall ? <VoiceIcon name="phone" size={20} /> : <MocoIcon name="panel-left" size={20} />}
  </Button>;
}

export function App() {
  return (
    <ShortcutSaveProvider>
      <AppShell />
    </ShortcutSaveProvider>
  );
}

function AppShell() {
  useMocoAppearance();
  const { language } = useI18n();
  const triggerShortcutSave = useShortcutSaveTrigger();
  const {
    connected,
    subscriptionsReady,
    deliveryScope,
    outboxReady,
    outboxRecords,
    enqueueWs,
    waitForQueuedAck,
    retryQueuedWs,
    removeAcceptedWs,
    activeTopicId: persistedActiveTopicId,
    selectTopic: selectPersistedTopic,
    topics: persistedTopics,
    topicsLoaded,
    setTopics,
    projects,
    setProjects,
    messages: persistedMessages,
    newMessageIds,
    conversationLoaded,
    canLoadHistory: canLoadPersistedHistory,
    historyLoading,
    loadEarlierMessages,
    live: persistedLive,
    tickets,
    topicActivities,
    ticketsLoaded,
    schedulesLoaded,
    snapshotError,
    refreshSnapshot,
    ticketSnapshotVersion,
    slots,
    envs,
    terminalEntries,
    settings,
    setSettings,
    settingsAssistant,
    settingsAssistantLoaded,
    settingsAssistantError,
    capabilitiesUpdateVersion,
    voiceSnapshot,
    setSettingsAssistantError,
    inspectedTicket,
    setInspectedTicket,
    inspectError,
    clearInspectError,
    showProcess,
    setShowProcess,
    lastError,
    clearError,
    sendWs,
    sendWsWithAck,
  } = useMocoHubConnection();
  const [messageWindow, setMessageWindow] = useState<ConversationMessageWindow>();
  const [messageWindowLoading, setMessageWindowLoading] = useState(false);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchScope, setConversationSearchScope] = useState<"all" | "current">("all");
  const [conversationSearchScopeVersion, setConversationSearchScopeVersion] = useState(0);
  const openConversationSearch = useCallback((scope: "all" | "current") => {
    setConversationSearchScope(scope);
    setConversationSearchScopeVersion((version) => version + 1);
    setConversationSearchOpen(true);
  }, []);
  const [locatingMessage, setLocatingMessage] = useState(false);
  const [pendingMessageJump, setPendingMessageJump] = useState<ConversationDestination>();
  const messageNavigationRequest = useRef<AbortController | null>(null);
  const navigationHighlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftScopeRef = useRef(deliveryScope);
  draftScopeRef.current = deliveryScope;
  const topicDrafts = useMemo(() => new TopicDraftStore({
    create: (projectId) => mocoRest.createTopic(undefined, projectId),
    onSaved: (_localId, topic, wasSelected) => {
      if (draftScopeRef.current !== deliveryScope) return;
      setTopics((current) => [topic, ...current.filter((item) => item.id !== topic.id)]);
      if (wasSelected) selectPersistedTopic(topic.id);
    },
    onError: (error) => {
      if (draftScopeRef.current === deliveryScope) toast.danger(error instanceof Error ? error.message : t("新建话题失败，草稿已保留", "Could not create the topic. Your draft is saved."));
    },
  }), [deliveryScope, selectPersistedTopic, setTopics]);
  const localTopics = useSyncExternalStore(topicDrafts.subscribe, topicDrafts.getSnapshot, topicDrafts.getSnapshot);
  const activeTopicId = localTopics.selected?.id ?? persistedActiveTopicId;
  const topics = useMemo(() => [...localTopics.topics, ...persistedTopics], [localTopics.topics, persistedTopics]);
  const viewingHistory = !localTopics.selected && messageWindow?.topicId === activeTopicId;
  const serverMessages = localTopics.selected ? [] : viewingHistory ? messageWindow.messages : persistedMessages;
  const live = localTopics.selected ? { busy: false, activeTools: [], queuedCount: 0 } : persistedLive;
  const canLoadHistory = !localTopics.selected && (viewingHistory ? messageWindow.hasMore : canLoadPersistedHistory);
  const selectTopic = useCallback((topicId: string) => {
    messageNavigationRequest.current?.abort();
    setMessageWindow(undefined);
    setPendingMessageJump(undefined);
    setLocatingMessage(false);
    if (topicDrafts.isLocal(topicId)) topicDrafts.select(topicId);
    else { topicDrafts.leave(); selectPersistedTopic(topicId); }
  }, [topicDrafts, selectPersistedTopic]);
  const pendingSubmissions = useMemo(() => outboxSubmissions(outboxRecords), [outboxRecords]);
  const submitFlightRef = useRef(false);
  const submittedIntentRef = useRef<string | undefined>(undefined);
  const draftEditRevisionRef = useRef(0);
  const editingSubmissionRef = useRef(new Map<string, { id: string; sequence: number; scope: string }>());
  const firstDraftScopeRef = useRef<string | undefined>(undefined);
  if (!firstDraftScopeRef.current && deliveryScope) firstDraftScopeRef.current = deliveryScope;
  const scopedDraftKey = (key: string, scope = deliveryScope) => {
    const resolved = key.startsWith("topic:") && scope === deliveryScope ? composerDraftKey(topicDrafts.draftTopicId(key.slice(6))) : key;
    return scope && scope !== firstDraftScopeRef.current ? `scope:${scope}:${resolved}` : resolved;
  };
  const [resumingQueuedTopic, setResumingQueuedTopic] = useState<string>();
  const resumeFlightsRef = useRef(new Set<string>());
  const messages = useMemo(() => mergeChatSubmissions(serverMessages, viewingHistory ? [] : pendingSubmissions, activeTopicId), [serverMessages, pendingSubmissions, activeTopicId, viewingHistory]);
  const chatTimeline = useMemo(() => splitChatTimeline(messages), [messages]);
  const responseMessages = useMemo(() => mergeResponseMessages(chatTimeline.transcript), [chatTimeline.transcript]);
  const conversationTranscript = useMemo(() => groupDispatchReplies(responseMessages), [responseMessages]);
  const lastPausedMessageId = chatTimeline.pending.findLast((item) => item.delivery === "paused")?.id;
  useEffect(() => {
    const ids = consumedOutboxReceipts(outboxRecords, serverMessages, activeTopicId);
    if (ids.length) void removeAcceptedWs(ids, outboxRecords[0]!.scope).catch((error: unknown) => toast.danger(error instanceof Error ? error.message : t("无法保存消息确认", "Could not save the message receipt")));
  }, [outboxRecords, serverMessages, activeTopicId, removeAcceptedWs]);

  const sizeClass = useSyncExternalStore<WindowSizeClass>(
    subscribeWindowSize,
    getWindowSizeClass,
    () => "expanded",
  );

  const [collapsed, setCollapsed] = useState(() => ({
    left: readPref("moco:left-collapsed", false),
    right: readPref("moco:right-collapsed", false),
  }));
  const [sheet, setSheet] = useState<"left" | "right" | undefined>();
  const [searchFocusRequest] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  const [settingsMode, setSettingsMode] = useState(false);
  const [settingsRightCollapsed, setSettingsRightCollapsed] = useState(() => readPref("moco:settings-right-collapsed", false));
  const [settingsModule, setSettingsModule] = useState<SettingsModuleId>("appearance");
  const [capabilityView, setCapabilityView] = useState<CapabilityView>("image");
  const [imageAssistantRequest, setImageAssistantRequest] = useState<ImageAssistantRequest>();
  const imageAssistantRequestSequence = useRef(0);
  const [voiceSettingsRequested, setVoiceSettingsRequested] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<SettingsAssistantContext["target"]>();
  const [settingsFocusRequest, setSettingsFocusRequest] = useState(0);
  useEffect(() => {
    if (!settingsMode || settingsModule !== "capabilities" || capabilityView !== "image") setImageAssistantRequest(undefined);
  }, [settingsMode, settingsModule, capabilityView]);
  useEffect(() => {
    const openMemoryDialogue = (event: Event) => {
      if (!["deploy", "configure", "uninstall"].includes((event as CustomEvent<string>).detail)) return;
      setSettingsFocusRequest((value) => value + 1);
      setSettingsRightCollapsed(false);
      if (sizeClass !== "expanded") setSheet("right");
    };
    const showMemoryForm = () => { if (sizeClass !== "expanded") setSheet(undefined); };
    window.addEventListener("moco:memory-service-intent", openMemoryDialogue);
    window.addEventListener("moco:memory-connection-focus", showMemoryForm);
    return () => { window.removeEventListener("moco:memory-service-intent", openMemoryDialogue); window.removeEventListener("moco:memory-connection-focus", showMemoryForm); };
  }, [sizeClass]);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const acceptSavedSettings = useCallback((next: NonNullable<typeof settings>) => {
    setSettings((current) => acceptSettingsSnapshot(current, next));
  }, [setSettings]);
  const [settingsEditorEpoch, setSettingsEditorEpoch] = useState(0);
  const [settingsEntryIntent, setSettingsEntryIntent] = useState<SettingsAssistantEntryIntent | null>(null);
  const [permissionEntry, setPermissionEntry] = useState<SystemPermissionEntry | null>(null);
  useEffect(() => {
    if (!settingsMode || settingsModule !== "permissions") setPermissionEntry(null);
  }, [settingsMode, settingsModule]);
  const settingsNavigation = useSettingsNavigation(settingsDirty, settingsMode);
  const settingsDirtyRef = useRef(settingsDirty);
  settingsDirtyRef.current = settingsDirty;

  const [projectedTicketId, setProjectedTicketId] = useState<string | undefined>();
  const projectedTicketRef = useRef(projectedTicketId);
  projectedTicketRef.current = projectedTicketId;
  const [projectedTitle, setProjectedTitle] = useState<string>("");
  const [projectNavigation, setProjectNavigation] = useState<ProjectNavigationRequest>();
  useEffect(() => {
    if (settingsMode || projectedTicketId) topicDrafts.leave();
  }, [settingsMode, projectedTicketId, topicDrafts]);
  const topicActivity = useTopicActivity({
    topics, tickets, topicActivities, activeTopicId,
    viewingConversation: !settingsMode && !projectedTicketId,
  });

  const [dismissedFailures, setDismissedFailures] = useState<string[]>(() =>
    readPref("moco:dismissed-failures", []),
  );
  const [retryingTurn, setRetryingTurn] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [replyDrafts, setReplyDrafts] = useState<ReplyDrafts>({});
  const currentConversationDraftKey = composerDraftKey(activeTopicId, projectedTicketId);
  const currentDraftKey = scopedDraftKey(currentConversationDraftKey);
  const currentDraft = composerDrafts[currentDraftKey] ?? "";
  const currentReply = replyDrafts[currentDraftKey];
  const setCurrentReply = (reply: ChatReplyReference | undefined) => {
    draftEditRevisionRef.current++;
    setReplyDrafts((current) => ({ ...current, [currentDraftKey]: reply }));
  };
  const setCurrentDraft = (val: string) => {
    draftEditRevisionRef.current++;
    if (!val) editingSubmissionRef.current.delete(currentDraftKey);
    setComposerDrafts((cur) => ({ ...cur, [currentDraftKey]: val }));
    if (!projectedTicketId && val.trim() && !(canReceiveDeviceInvitation && parseStandaloneDeviceInvitation(val))) topicDrafts.touch(activeTopicId);
  };
  const {
    getAttachments,
    enqueueFiles,
    removeAttachment,
    retryAttachment,
    cancelAttachment,
    restoreAttachments,
  } = useTopicAttachments();
  const currentAttachments = getAttachments(currentDraftKey);
  const canReceiveDeviceInvitation = !settingsMode && !projectedTicketId && !currentReply && !currentAttachments.length && !editingSubmissionRef.current.has(currentDraftKey);
  const deviceJoin = useChatDeviceJoin({
    enabled: canReceiveDeviceInvitation, draftKey: currentDraftKey, draft: currentDraft,
    onSource: (view) => {
      // A device may join before its first WebSocket snapshot. Keep earlier drafts with their originating hub.
      firstDraftScopeRef.current ??= JSON.stringify([window.location.origin, view.hubId, view.currentDeviceId]);
    },
    onConsume: (key, input) => setComposerDrafts((drafts) => drafts[key] === input ? { ...drafts, [key]: "" } : drafts),
    onJoined: (target) => {
      setProjectedTicketId(undefined);
      setSettingsMode(false);
      setSheet(undefined);
      selectTopic("root");
      toast.success(t(`已连接到 ${target}`, `Connected to ${target}`));
    },
  });
  const animateMessageEntry = useMessageEntryMotion(currentDraftKey, messages, newMessageIds, Boolean(localTopics.selected) || conversationLoaded);
  const animateLiveEntry = useLiveResponseEntryMotion(currentDraftKey, live, Boolean(localTopics.selected) || conversationLoaded);
  const replyToMessage = (reply: ChatReplyReference) => {
    setCurrentReply(reply);
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  const [lightboxImage, setLightboxImage] = useState<PreviewableImage | null>(null);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatNavigatingRef = useRef(false);
  const conversationTurns = useMemo(() => buildConversationTurns(messages), [messages, language]);
  const returnChatScrollRef = useRef<TaskChatReturn | null>(null);
  const skipChatAnchorRef = useRef(false);
  const nearBottomRef = useRef(true);
  const [showToBottom, setShowToBottom] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const navigationViewRef = useRef("");
  navigationViewRef.current = `${deliveryScope ?? ""}:${activeTopicId}:${settingsMode}:${settingsModule}:${projectedTicketId ?? ""}`;

  useEffect(() => {
    setMessageWindow(undefined);
    setPendingMessageJump(undefined);
    setLocatingMessage(false);
    setConversationSearchOpen(false);
    return () => {
      messageNavigationRequest.current?.abort();
      if (navigationHighlightTimer.current) clearTimeout(navigationHighlightTimer.current);
    };
  }, [deliveryScope]);

  useLayoutEffect(() => {
    if (!pendingMessageJump || pendingMessageJump.topicId !== activeTopicId || settingsMode || projectedTicketId) return;
    const id = pendingMessageJump.messageId === undefined ? undefined : visibleMessageId(chatTimeline.transcript, responseMessages, pendingMessageJump.messageId);
    const scroll = chatScrollRef.current;
    const node = id === undefined ? undefined : scroll?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!node) return;
    nearBottomRef.current = false;
    chatNavigatingRef.current = true;
    skipChatAnchorRef.current = true;
    if (pendingMessageJump.assetId) window.dispatchEvent(new CustomEvent("moco:reveal-file", { detail: { assetId: pendingMessageJump.assetId } }));
    const frame = requestAnimationFrame(() => {
      scroll?.querySelectorAll("[data-message-located]").forEach((element) => element.removeAttribute("data-message-located"));
      if (navigationHighlightTimer.current) clearTimeout(navigationHighlightTimer.current);
      const asset = pendingMessageJump.assetId ? Array.from(node.querySelectorAll<HTMLElement>("[data-asset-id]")).find((element) => element.dataset.assetId === pendingMessageJump.assetId) : undefined;
      (asset ?? node).scrollIntoView({ block: "start", behavior: "auto" });
      node.focus({ preventScroll: true });
      node.dataset.messageLocated = "true";
      navigationHighlightTimer.current = setTimeout(() => node.removeAttribute("data-message-located"), 2600);
      setShowToBottom(true);
      setPendingMessageJump(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingMessageJump, activeTopicId, settingsMode, projectedTicketId, chatTimeline.transcript, responseMessages]);

  const loadConversationHistory = async () => {
    if (!viewingHistory) { await loadEarlierMessages(); return; }
    if (messageWindowLoading || messageWindow.beforeEntryId === undefined) return;
    const current = messageWindow;
    setMessageWindowLoading(true);
    try {
      const page = await mocoRest.getTopicHistory(current.topicId, current.beforeEntryId!);
      setMessageWindow((previous) => previous === current ? { ...current, ...page, messages: mergeLocatedMessages(page.messages, current.messages) } : previous);
    } finally { setMessageWindowLoading(false); }
  };

  const leftExpanded =
    sizeClass === "compact" ? sheet === "left" : !collapsed.left;
  const rightExpanded =
    sizeClass === "expanded" ? !(settingsMode ? settingsRightCollapsed : collapsed.right) : sheet === "right";

  // Auto-close narrow drawer when viewport widens past its breakpoint
  useEffect(() => {
    if (sheet === "left" && sizeClass !== "compact") {
      setSheet(undefined);
    } else if (sheet === "right" && sizeClass === "expanded") {
      setSheet(undefined);
    }
  }, [sheet, sizeClass, settingsMode]);

  useEffect(() => {
    try {
      localStorage.setItem("moco:left-collapsed", JSON.stringify(collapsed.left));
      localStorage.setItem("moco:right-collapsed", JSON.stringify(collapsed.right));
    } catch {
      // ignore
    }
  }, [collapsed]);

  useEffect(() => {
    try {
      localStorage.setItem("moco:settings-right-collapsed", JSON.stringify(settingsRightCollapsed));
    } catch {
      // The preference still applies in this window if storage is unavailable.
    }
  }, [settingsRightCollapsed]);

  // Browser beforeunload guard when settings or identity documents have unsaved edits
  useEffect(() => {
    if (!settingsMode) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!settingsDirtyRef.current && !settingsSaveActivity.getSnapshot()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [settingsMode]);

  const shortcutActionsRef = useRef<{
    runCommand: (command: AppShortcutCommand) => boolean;
    handleEscape: (event: globalThis.KeyboardEvent) => boolean;
  }>({
    runCommand: () => false,
    handleEscape: () => false,
  });

  // Keyboard shortcuts and Electron native menu commands share one guarded dispatcher.
  useEffect(() => {
    const desktopOnCommand = typeof window === "undefined" ? undefined : window.mocoDesktop?.onCommand;
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

  const failedTaskSubmission = useMemo(() => pendingSubmissions.find((submission) =>
    submission.envelope.type === "ticket.steer" && submission.draftKey === currentConversationDraftKey && submission.state === "failed",
  ), [pendingSubmissions, currentConversationDraftKey]);
  const pendingTaskSubmission = useMemo(() => pendingSubmissions.findLast((submission) =>
    submission.envelope.type === "ticket.steer" && submission.draftKey === currentConversationDraftKey && submission.state !== "failed" && submission.state !== "accepted",
  ), [pendingSubmissions, currentConversationDraftKey]);
  const orphanedSubmission = useMemo(() => topics.length ? pendingSubmissions.find((submission) =>
    submission.envelope.type === "chat.send" && submission.state === "failed" && !topics.some((topic) => topic.id === submission.topicId && !topic.deletedAt),
  ) : undefined, [pendingSubmissions, topics]);

  const recoverPendingSubmission = (submission: PendingSubmissionBackup, targetKey = scopedDraftKey(submission.draftKey, submission.outboxScope)) => {
    // An unconfirmed request may already be queued; editing it under a new ID could send it twice.
    if (submission.state !== "failed") return;
    if (!submission.outboxScope || !submission.localSequence || submission.outboxScope !== deliveryScope) return;
    const id = submissionKey(submission);
    if (editingSubmissionRef.current.get(targetKey)?.id === id) { composerRef.current?.focus(); return; }
    editingSubmissionRef.current.set(targetKey, { id, sequence: submission.localSequence, scope: submission.outboxScope });
    draftEditRevisionRef.current++;
    setComposerDrafts((cur) => restoreComposerDraft(cur, targetKey, submission.rawUserText));
    setReplyDrafts((current) => restoreReplyDraft(current, targetKey, submission.envelope.replyTo));
    restoreAttachments(targetKey, submission.draftAttachments);
    clearError();
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  // Refresh projected ticket live when tickets broadcast updates
  useEffect(() => {
    if (!projectedTicketId || !subscriptionsReady) return;
    sendWs({
      type: "ticket.inspect",
      ticketId: projectedTicketId,
      requestId: `inspect:${projectedTicketId}:${Date.now()}`,
    });
  }, [projectedTicketId, tickets, subscriptionsReady, sendWs]);

  const runGuardedNavigation = settingsNavigation.navigate;

  const navigateFromSettingsAssistant = useCallback((entry: SettingsAssistantEntryIntent) => new Promise<void>((resolve, reject) => {
    const destination = SETTINGS_MODULES.find((module) => module.id === entry.module);
    if (!destination) {
      reject(new Error(t("当前界面不支持此设置页面，请更新客户端。", "Update the client to open this settings page.")));
      return;
    }
    runGuardedNavigation(() => {
      if (settingsDirty) setSettingsEditorEpoch((epoch) => epoch + 1);
      setSettingsMode(true);
      setSettingsDirty(false);
      setSettingsModule(destination.id);
      setSettingsTarget(undefined);
      setSettingsEntryIntent(entry.intent ? entry : null);
      setProjectedTicketId(undefined);
      setSheet(undefined);
      resolve();
    }, () => reject(new Error(t("已取消打开设置。", "Opening settings was cancelled."))));
  }), [runGuardedNavigation, settingsDirty]);

  useEffect(() => {
    const openPermissions = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (!detail || typeof detail !== "object") return;
      const { kind, envId } = detail as Partial<SystemPermissionEntry>;
      if (kind !== "microphone" && kind !== "accessibility" && kind !== "screen") return;
      if (envId !== undefined && (typeof envId !== "string" || !envId || envId.length > 256)) return;
      runGuardedNavigation(() => {
        if (settingsDirty) setSettingsEditorEpoch((epoch) => epoch + 1);
        setSettingsMode(true);
        setSettingsDirty(false);
        setSettingsModule("permissions");
        setSettingsTarget(undefined);
        setSettingsEntryIntent(null);
        setPermissionEntry({ id: crypto.randomUUID(), kind, ...(envId ? { envId } : {}) });
        setProjectedTicketId(undefined);
        setSheet(undefined);
      });
    };
    window.addEventListener("moco:system-permission-help", openPermissions);
    return () => window.removeEventListener("moco:system-permission-help", openPermissions);
  }, [runGuardedNavigation, settingsDirty]);

  const settingsAssistantControls = useSettingsAssistant({
    enabled: settingsMode,
    module: settingsModule,
    target: settingsModule === "capabilities" || settingsModule === "connections" ? settingsTarget : undefined,
    focusRequest: settingsFocusRequest,
    onClearTarget: () => setSettingsTarget(undefined),
    hasUnsavedChanges: settingsDirty,
    connected: subscriptionsReady,
    snapshot: settingsAssistant,
    sendWs,
    sendWsWithAck,
    setError: setSettingsAssistantError,
    onNavigate: navigateFromSettingsAssistant,
  });

  const capabilitiesWorkspace = useCapabilitiesWorkspace({
    enabled: true,
    active: settingsMode && settingsModule === "capabilities",
    connected,
    clientId: settingsAssistantControls.clientId,
    updateVersion: capabilitiesUpdateVersion ?? 0,
    assistantBusy: settingsAssistant.live.busy,
  });
  const [connectionPreparing, setConnectionPreparing] = useState(false);
  const connectionsWorkspace = useConnectionsWorkspace({
    enabled: settingsMode,
    connected,
    clientId: settingsAssistantControls.clientId,
    assistantBusy: settingsAssistant.live.busy,
  });
  const requestConnectionPrepare: ConnectionPrepare = useCallback(async (fields) => {
    if (!connected) throw new Error(t("与中枢连接已断开。", "Disconnected from the hub."));
    setConnectionPreparing(true);
    try {
      const input = await mocoRest.prepareConnection({ clientId: settingsAssistantControls.clientId, ...fields });
      setSettingsModule("connections");
      setSettingsTarget(input.connectionId ? { kind: "connection", id: input.connectionId } : undefined);
      setSettingsFocusRequest((value) => value + 1);
      setSettingsRightCollapsed(false);
      if (sizeClass !== "expanded") setSheet("right");
      await connectionsWorkspace.refresh();
    } finally { setConnectionPreparing(false); }
  }, [connected, settingsAssistantControls.clientId, sizeClass, connectionsWorkspace.refresh]);
  const requestCapabilityAssistant = useCallback((target?: NonNullable<SettingsAssistantContext["target"]>, prompt?: string) => {
    setSettingsTarget(target);
    setSettingsFocusRequest((value) => value + 1);
    setSettingsRightCollapsed(false);
    if (sizeClass !== "expanded") setSheet("right");
    const imageCapability = target?.kind === "capability" && capabilitiesWorkspace.snapshot?.capabilities.find((item) => item.id === target.id && item.kind === "image");
    if (imageCapability || capabilityView === "image" && (prompt === ADD_IMAGE_PROMPT || prompt === IMAGE_ROUTING_PROMPT)) {
      setCapabilityView("image");
      setImageAssistantRequest({ id: ++imageAssistantRequestSequence.current, action: prompt === IMAGE_ROUTING_PROMPT ? "routing" : "configure", capabilityId: imageCapability ? imageCapability.id : undefined });
      return;
    }
    if (prompt) void settingsAssistantControls.send(prompt, target ?? null);
  }, [settingsAssistantControls.send, sizeClass, capabilityView, capabilitiesWorkspace.snapshot]);

  const handleSettingsIntentHandled = useCallback((id: string) => {
    setSettingsEntryIntent((current) => current?.id === id ? null : current);
  }, []);

  const agentName = settings?.blocks.presentation.value.agentName ?? "Moco";
  const workbenchName = t("后台任务", "Background tasks");
  const activeTopic =
    localTopics.selected ??
    topics.find((t) => t.id === activeTopicId) ??
    topics.find((t) => t.master) ??
    topics[0];
  const mainChatTitle = t(`${agentName} · 主会话`, `${agentName} · Main chat`);
  const activeTopicTitle = activeTopic?.master
    ? mainChatTitle
    : activeTopic?.title || t(`与 ${agentName} 对话`, `Chat with ${agentName}`);
  const activeProject = projects.find((project) => project.id === activeTopic?.projectId);
  useEffect(() => {
    if (topicDrafts.isLocal(activeTopicId)) return;
    if (topics.length && !topics.some((topic) => topic.id === activeTopicId && !topic.deletedAt)) selectTopic("root");
  }, [activeTopicId, topics, selectTopic, topicDrafts]);
  const currentModelId = settings?.blocks.model.value.defaultModel;
  const lastMessageId = messages[messages.length - 1]?.id ?? 0;

  const activeRunFailure = useMemo(() => {
    if (live.busy || !live.runFailure) return null;
    const desc = describeLocalizedMocoError({
      reason: live.runFailure.reason,
      detail: live.runFailure.detail,
      modelId: currentModelId,
    });
    if (desc.isUserAbort) return null;
    const key = `${activeTopicId}:${
      live.runFailure.taskId ??
      `${lastMessageId}:${live.runFailure.reason}:${(live.runFailure.detail ?? "").slice(0, 120)}`
    }`;
    if (dismissedFailures.includes(key)) return null;
    return { key, desc };
  }, [live.busy, live.runFailure, currentModelId, activeTopicId, lastMessageId, dismissedFailures, language]);

  const dismissRunFailure = useCallback(
    (key?: string) => {
      const targetKey = key ?? activeRunFailure?.key;
      if (targetKey) {
        setDismissedFailures((cur) => {
          if (cur.includes(targetKey)) return cur;
          const next = [...cur, targetKey].slice(-80);
          try {
            localStorage.setItem("moco:dismissed-failures", JSON.stringify(next));
          } catch {
            // ignore
          }
          return next;
        });
      }
      setActionError(null);
      clearError();
    },
    [activeRunFailure?.key, clearError],
  );

  const openModelSettings = useCallback(() => {
    setProjectedTicketId(undefined);
    setSettingsModule("models");
    setSettingsMode(true);
    setActionError(null);
  }, []);

  const topBannerError = useMemo(() => {
    const rawMsg = actionError || lastError;
    if (rawMsg) {
      return {
        source: "action" as const,
        desc: describeLocalizedMocoError({
          rawMessage: rawMsg,
          modelId: currentModelId,
        }),
      };
    }
    return null;
  }, [actionError, lastError, currentModelId, language]);

  useLayoutEffect(() => {
    chatNavigatingRef.current = false;
    const resolved = resolveTaskChatReturn(returnChatScrollRef.current, activeTopicId, Boolean(projectedTicketId), settingsMode);
    returnChatScrollRef.current = resolved.captured;
    const previous = resolved.restore;
    const el = chatScrollRef.current;
    if (!previous || !el) return;
    const restored = restoredChatScroll(previous.top, el.scrollHeight, el.clientHeight);
    el.scrollTop = restored.scrollTop;
    nearBottomRef.current = restored.nearBottom;
    setShowToBottom(restored.showToBottom);
    skipChatAnchorRef.current = true;
  }, [activeTopicId, settingsMode, projectedTicketId]);

  // Returning from a task restores the reading position before live anchoring resumes.
  useEffect(() => {
    if (settingsMode || projectedTicketId) return;
    if (skipChatAnchorRef.current) {
      skipChatAnchorRef.current = false;
      return;
    }
    const el = chatScrollRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [
    messages.length,
    live.streamingText,
    activeRunFailure?.key,
    activeTopicId,
    viewingHistory,
    settingsMode,
    projectedTicketId,
  ]);

  const handleChatScroll = () => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNear = distance < 120;
    nearBottomRef.current = isNear && !chatNavigatingRef.current;
    setShowToBottom(distance > 180);
  };

  const scrollToLatest = () => {
    const el = chatScrollRef.current;
    if (!el) return;
    chatNavigatingRef.current = false;
    setMessageWindow(undefined);
    setPendingMessageJump(undefined);
    messageNavigationRequest.current?.abort();
    nearBottomRef.current = true;
    setShowToBottom(false);
    el.scrollTo({
      top: el.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  const togglePanel = (side: "left" | "right") => {
    if (side === "right" && settingsMode && sizeClass === "expanded") {
      setSettingsRightCollapsed((current) => !current);
    } else if (side === "left" ? sizeClass !== "compact" : sizeClass === "expanded") {
      setCollapsed((cur) => ({ ...cur, [side]: !cur[side] }));
    } else {
      setSheet((cur) => (cur === side ? undefined : side));
    }
  };

  const projectTask = useCallback(
    (ticketId: string, title?: string) => {
      runGuardedNavigation(() => {
        if (!projectedTicketId && chatScrollRef.current) {
          returnChatScrollRef.current = { topicId: activeTopicId, top: chatScrollRef.current.scrollTop, requested: false };
        }
        setSheet(undefined);
        setSettingsMode(false);
        setSettingsDirty(false);
        clearInspectError();
        setProjectedTicketId(ticketId);
        if (title) setProjectedTitle(title);
        sendWs({
          type: "ticket.inspect",
          ticketId,
          requestId: `inspect:${ticketId}:${Date.now()}`,
        });
      });
    },
    [runGuardedNavigation, clearInspectError, sendWs, activeTopicId, projectedTicketId],
  );

  const closeProjection = useCallback(() => {
    if (returnChatScrollRef.current) returnChatScrollRef.current.requested = true;
    setProjectedTicketId(undefined);
    setInspectedTicket(null);
    clearInspectError();
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  }, [setInspectedTicket, clearInspectError]);

  const retryTicket = useCallback(async (ticketId: string) => {
    await sendWsWithAck({ type: "ticket.retry", ticketId });
  }, [sendWsWithAck]);

  const ignoreTicket = useCallback(async (ticketId: string) => {
    await sendWsWithAck({ type: "ticket.close", ticketId, kind: "obsolete", reason: "用户忽略" });
    if (projectedTicketRef.current === ticketId) closeProjection();
  }, [sendWsWithAck, projectedTicketId, closeProjection]);

  const handleCreateTopic = async (projectId?: string) => {
    topicDrafts.start(projectId, t("新对话", "New conversation"));
    setSettingsMode(false);
    setSettingsDirty(false);
    setProjectedTicketId(undefined);
    setSheet(undefined);
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  };

  const handlePatchTopic = async (
    topicId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => {
    try {
      const targetId = topicDrafts.isLocal(topicId) ? (await topicDrafts.ensure(topicId)).id : topicId;
      const updated = await mocoRest.patchTopic(targetId, patch);
      setTopics((cur) => cur.map((t) => (t.id === targetId ? updated : t)));
      if (patch.archived && topicId === activeTopicId) {
        selectTopic("root");
      }
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : t("更新话题失败", "Could not update the topic"));
    }
  };

  const handleDeleteTopic = async (topicId: string, stopTasks = false) => {
    try {
      if (topicDrafts.isLocal(topicId)) {
        topicDrafts.discard(topicId);
        return;
      }
      await mocoRest.deleteTopic(topicId, stopTasks);
      setTopics((current) => current.filter((topic) => topic.id !== topicId));
      if (topicId === activeTopicId) {
        selectTopic("root");
      }
      toast.success(t("话题已删除", "Topic deleted"));
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : t("删除话题失败", "Could not delete the topic"));
      throw err;
    }
  };

  const handleRetryTurn = async () => {
    if (retryingTurn || live.busy) return;
    setRetryingTurn(true);
    setActionError(null);
    clearError();
    try {
      await sendWsWithAck({ type: "chat.retry", topicId: activeTopicId });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("重试请求失败", "Could not retry the request"));
    } finally {
      setRetryingTurn(false);
    }
  };

  const ticketById = useMemo(
    () => new Map(tickets.map((t) => [t.id, t])),
    [tickets],
  );

  const dispatchSubmissionWithAck = async (input: SubmissionBackupInput | PendingSubmissionBackup) => {
    const key = submissionKey(input);
    const replacesFailed = "localMessageId" in input ? undefined : editingSubmissionRef.current.get(currentDraftKey);
    const record = "localMessageId" in input ? await retryQueuedWs(key, input.outboxScope) : await enqueueWs(input.envelope, {
      topicId: input.topicId, draftKey: input.draftKey, rawUserText: input.rawUserText, draftAttachments: input.draftAttachments,
      ...(replacesFailed ? { replacesFailed } : {}),
    }, deliveryScope);
    if (replacesFailed) editingSubmissionRef.current.delete(currentDraftKey);
    void waitForQueuedAck(record).catch((error: unknown) => {
      if (error && typeof error === "object" && "isDisconnect" in error) return;
      if (input.envelope.type === "ticket.steer") setActionError(error instanceof Error ? error.message : t("任务指令被中枢拒绝", "The hub rejected the task instruction"));
    });
    return record;
  };

  const resumeQueuedMessages = (topicId: string) => {
    if (!outboxReady || resumeFlightsRef.current.has(topicId)) return;
    resumeFlightsRef.current.add(topicId);
    setResumingQueuedTopic(topicId);
    void sendWsWithAck({ type: "chat.retry", topicId })
      .catch((error) => setActionError(error instanceof Error ? error.message : t("继续处理失败", "Could not resume processing")))
      .finally(() => {
        resumeFlightsRef.current.delete(topicId);
        setResumingQueuedTopic((current) => current === topicId ? undefined : current);
      });
  };

  const submitMessage = async (overrideText?: string) => {
    if (overrideText === undefined && deviceJoin) {
      deviceJoin.submit();
      return;
    }
    if (submitFlightRef.current) return;
    setActionError(null);
    clearError();
    const sourceReply = overrideText === undefined ? currentReply : undefined;
    const { content, replyTo } = redactChatInvitation(overrideText ?? currentDraft, sourceReply);
    const raw = content.trim();
    const isUploading =
      overrideText === undefined &&
      currentAttachments.some((a) => a.status === "uploading");
    const readyDraftAttachments =
      overrideText === undefined
        ? currentAttachments.filter((a) => a.status === "ready" && Boolean(a.attachment))
        : [];
    const attachmentsToSend = readyDraftAttachments.map((a) => a.attachment!);

    if (isUploading || (!raw && attachmentsToSend.length === 0)) return;
    const intent = JSON.stringify([currentDraftKey, draftEditRevisionRef.current, overrideText === undefined ? null : raw, readyDraftAttachments.map((item) => item.localId), replyTo ?? null]);
    if (submittedIntentRef.current === intent) return;
    if (!outboxReady) {
      setActionError(t("待发队列尚未就绪，输入草稿已保留", "The send queue is not ready. Your draft is saved."));
      return;
    }
    if (!projectedTicketId && viewingHistory) {
      setMessageWindow(undefined);
      nearBottomRef.current = true;
    }
    submitFlightRef.current = true;
    const sourceDraftKey = currentDraftKey;
    const sourceDraft = currentDraft;
    const consumeDraft = () => {
      submittedIntentRef.current = intent;
      if (overrideText !== undefined) return;
      setComposerDrafts((current) => consumePersistedDraft(current, sourceDraftKey, sourceDraft));
      setReplyDrafts((current) => consumeReplyDraft(current, sourceDraftKey, sourceReply));
      for (const item of readyDraftAttachments) removeAttachment(sourceDraftKey, item.localId);
    };

    try {

    const targetTicket = projectedTicketId
      ? ticketById.get(projectedTicketId) ?? (inspectedTicket?.ticket.id === projectedTicketId ? inspectedTicket.ticket : undefined)
      : undefined;
    const targetTopic = projectedTicketId && overrideText === undefined
      ? targetTicket?.originTopicId ?? "root"
      : topicDrafts.isLocal(activeTopicId) ? (await topicDrafts.ensure(activeTopicId)).id : activeTopicId;

    if (projectedTicketId && overrideText === undefined) {
      const card = targetTicket;
      if (card?.status === "stopped" || card?.status === "closed") {
        const composed = `[关于任务「${card.title}」]${raw ? `\n${raw}` : ""}`;
        const reqId = newDeliveryId("web");
        await dispatchSubmissionWithAck({
          topicId: targetTopic,
          draftKey: composerDraftKey(targetTopic),
          envelope: {
            type: "chat.send",
            topicId: targetTopic,
            content: composed,
            ...(replyTo ? { replyTo } : {}),
            ...(attachmentsToSend.length > 0 ? { attachments: attachmentsToSend } : {}),
            requestId: reqId,
            whenBusy: "steer",
          },
          rawUserText: composed,
          draftAttachments: readyDraftAttachments,
          state: "sending",
        });
        consumeDraft();
        if (projectedTicketRef.current === projectedTicketId) {
          closeProjection();
          if (targetTopic !== activeTopicId) selectTopic(targetTopic);
        }
        return;
      }

      const cmdId = newDeliveryId("steer");
      await dispatchSubmissionWithAck({
        topicId: targetTopic,
        draftKey: currentConversationDraftKey,
        envelope: {
          type: "ticket.steer",
          ticketId: projectedTicketId,
          text: raw,
          ...(replyTo ? { replyTo } : {}),
          ...(attachmentsToSend.length > 0 ? { attachments: attachmentsToSend } : {}),
          commandId: cmdId,
        },
        rawUserText: raw,
        draftAttachments: readyDraftAttachments,
        state: "sending",
      });
      consumeDraft();
      return;
    }

    const reqId = newDeliveryId("web");
    await dispatchSubmissionWithAck({
      topicId: targetTopic,
      draftKey: composerDraftKey(targetTopic),
      envelope: {
        type: "chat.send",
        topicId: targetTopic,
        content: raw,
        ...(replyTo ? { replyTo } : {}),
        ...(attachmentsToSend.length > 0 ? { attachments: attachmentsToSend } : {}),
        requestId: reqId,
        whenBusy: "steer",
      },
      rawUserText: raw,
      draftAttachments: readyDraftAttachments,
      state: "sending",
    });
    consumeDraft();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("无法保存待发消息，草稿已保留", "Could not save the pending message. Your draft is saved."));
    } finally {
      requestAnimationFrame(() => { submitFlightRef.current = false; });
    }
  };

  const transcribeVoice: TranscribeVoice = async (recording, options) => {
    if (!connected) throw new MocoWsDisconnectedError(t("当前与中枢连接已断开，录音已保留", "Disconnected from the hub. Your recording is saved."));
    const ticket = projectedTicketId
      ? ticketById.get(projectedTicketId) ?? (inspectedTicket?.ticket.id === projectedTicketId ? inspectedTicket.ticket : undefined)
      : undefined;
    return transcribeVoiceRecording(recording, {
      topicId: projectedTicketId ? ticket?.originTopicId ?? "root" : topicDrafts.isLocal(activeTopicId) ? undefined : activeTopicId,
      clientId: settingsAssistantControls.clientId,
    }, options);
  };

  const projectedCard = projectedTicketId
    ? ticketById.get(projectedTicketId)
    : undefined;
  const isProjectedDetailLoading = Boolean(
    projectedTicketId && inspectedTicket?.ticket.id !== projectedTicketId,
  );

  const projectedDetail = useMemo<TicketDetailSnapshot | null>(() => {
    if (!projectedTicketId) return null;
    if (inspectedTicket?.ticket.id === projectedTicketId) return inspectedTicket;
    if (!projectedCard) return null;
    return {
      ticket: {
        id: projectedCard.id,
        commandId: projectedCard.id,
        title: projectedCard.title,
        userSummary: projectedCard.userSummary,
        goal: projectedCard.userSummary ?? projectedCard.title,
        scope: projectedCard.workspaceDir,
        role: projectedCard.role,
        status: projectedCard.status,
        projectId: projectedCard.projectId,
        waiting: projectedCard.waiting,
        cleanupPending: projectedCard.cleanupPending,
        envId: projectedCard.envId,
        workspaceDir: projectedCard.workspaceDir,
        workerConversationId: 0,
        runEpoch: 1,
        createdAt: projectedCard.createdAt,
        updatedAt: projectedCard.updatedAt,
        startedRunningAt: projectedCard.startedRunningAt,
        accumulatedRunningMs: projectedCard.accumulatedRunningMs,
        completedAt: projectedCard.completedAt,
        queuedAt: projectedCard.queuedAt,
        latestReport: projectedCard.latestReport,
        stoppedReason: projectedCard.stoppedReason,
        closure: projectedCard.closure,
        recovery: projectedCard.recovery,
        originTopicId: projectedCard.originTopicId,
      },
      transcript: [],
      live: {
        busy: projectedCard.status === "running" || projectedCard.status === "pausing",
        activeTools: [],
        queuedCount: 0,
      },
    };
  }, [projectedTicketId, inspectedTicket, projectedCard]);
  const pendingAnswer = useMemo(() => {
    if (!projectedDetail) return undefined;
    const draftKey = blockerDraftKey(projectedDetail.ticket);
    const record = outboxRecords.find((item) => item.metadata?.draftKey === draftKey && item.envelope.type === "ticket.steer" && (item.state === "queued" || item.state === "sending"));
    return record?.envelope.type === "ticket.steer" ? { text: record.envelope.text, commandId: record.envelope.commandId } : undefined;
  }, [outboxRecords, projectedDetail]);
  const projectedProject = projects.find((project) => project.id === projectedDetail?.ticket.projectId);

  const activeTopicTaskCount = useMemo(
    () =>
      tickets.filter(
        (t) =>
          (t.originTopicId ?? "root") === activeTopicId &&
          unfinishedTicket(t),
      ).length,
    [tickets, activeTopicId],
  );

  const openChatTopic = (topicId: string) => {
    runGuardedNavigation(() => {
      setSettingsMode(false);
      setSettingsDirty(false);
      setProjectedTicketId(undefined);
      selectTopic(topicId);
      setSheet(undefined);
      requestAnimationFrame(() => composerRef.current?.focus());
    });
  };
  const navigateConversation = (destination: ConversationDestination) => {
    if (destination.messageId === undefined) { openChatTopic(destination.topicId); return; }
    runGuardedNavigation(() => {
      messageNavigationRequest.current?.abort();
      const controller = new AbortController();
      const sourceView = navigationViewRef.current;
      messageNavigationRequest.current = controller;
      setLocatingMessage(true);
      const loaded = destination.topicId === activeTopicId && chatTimeline.transcript.some((item) => item.id === destination.messageId);
      void (loaded ? Promise.resolve(undefined) : mocoRest.getTopicMessageWindow(destination.topicId, destination.messageId!, controller.signal)).then((result) => {
        if (controller.signal.aborted || navigationViewRef.current !== sourceView) return;
        setSettingsMode(false);
        setSettingsDirty(false);
        setProjectedTicketId(undefined);
        setSheet(undefined);
        nearBottomRef.current = false;
        skipChatAnchorRef.current = true;
        if (destination.topicId !== activeTopicId) selectTopic(destination.topicId);
        if (result) setMessageWindow(result);
        setPendingMessageJump(destination);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && navigationViewRef.current === sourceView) toast.danger(error instanceof Error ? error.message : t("无法定位原消息", "Could not locate the original message"));
      }).finally(() => { if (messageNavigationRequest.current === controller) setLocatingMessage(false); });
    });
  };
  const navigateReply = (messageId: number) => navigateConversation({ topicId: activeTopicId, messageId });
  const openVoiceSettings = () => {
    runGuardedNavigation(() => {
      setSettingsMode(true);
      setSettingsDirty(false);
      setSettingsModule("capabilities");
      setVoiceSettingsRequested(true);
      setCapabilityView("voice");
      setSettingsTarget(undefined);
      setProjectedTicketId(undefined);
      setSheet(undefined);
    });
  };
  const openCallPanel = () => {
    if (sizeClass === "compact") setSheet("left");
    else setCollapsed((current) => ({ ...current, left: false }));
  };
  const voiceCallTarget = { topicId: activeTopicId, title: activeTopicTitle, ...(activeTopic?.projectId ? { projectId: activeTopic.projectId } : {}) };
  const resolveVoiceCallTarget = async () => {
    const topic = topicDrafts.isLocal(activeTopicId) ? await topicDrafts.ensure(activeTopicId) : activeTopic;
    return {
      topicId: topic?.id ?? activeTopicId,
      title: topic?.title ?? activeTopicTitle,
      ...(topic?.projectId ? { projectId: topic.projectId } : {}),
    };
  };
  const projectedCallTopicId = projectedDetail?.ticket.originTopicId ?? "root";
  const projectedCallTopic = topics.find((topic) => topic.id === projectedCallTopicId);
  const projectedCallProjectId = projectedDetail?.ticket.projectId ?? projectedCallTopic?.projectId;
  const projectedVoiceCallTarget = {
    topicId: projectedCallTopicId,
    title: projectedCallTopic?.master ? mainChatTitle : projectedCallTopic?.title || t("原始话题", "Original topic"),
    ...(projectedCallProjectId ? { projectId: projectedCallProjectId } : {}),
  };

  const enterSettings = () => {
    transitionSettingsLayout("enter", () => {
      setSettingsMode(true);
      setProjectedTicketId(undefined);
      setSheet(undefined);
    });
  };
  const exitSettings = () => {
    runGuardedNavigation(() => {
      transitionSettingsLayout("exit", () => {
        setSheet(undefined);
        setSettingsDirty(false);
        setSettingsMode(false);
      });
    });
  };

  shortcutActionsRef.current = {
    runCommand(command) {
      switch (command) {
        case "search-conversations": {
          if (hasBlockingOverlay(document, { allowSelector: '[data-moco-overlay="conversation-search"]' })) return false;
          if (conversationSearchOpen && conversationSearchScope === "all") {
            setConversationSearchOpen(false);
          } else {
            openConversationSearch("all");
          }
          return true;
        }
        case "find-in-conversation": {
          if (settingsMode || projectedTicketId) return false;
          if (hasBlockingOverlay(document, { allowSelector: '[data-moco-overlay="conversation-search"]' })) return false;
          openConversationSearch("current");
          return true;
        }
        case "new-topic": {
          if (hasBlockingOverlay(document)) return false;
          runGuardedNavigation(() => { void handleCreateTopic(); });
          return true;
        }
        case "open-settings": {
          if (hasBlockingOverlay(document)) return false;
          if (settingsMode) exitSettings();
          else enterSettings();
          return true;
        }
        case "toggle-left-panel": {
          if (hasBlockingOverlay(document, { allowSelector: '[data-moco-overlay="workbench-drawer"]' })) return false;
          togglePanel("left");
          return true;
        }
        case "toggle-right-panel": {
          if (hasBlockingOverlay(document, { allowSelector: '[data-moco-overlay="workbench-drawer"]' })) return false;
          togglePanel("right");
          return true;
        }
        case "open-main-chat": {
          if (hasBlockingOverlay(document)) return false;
          openChatTopic(topics.find((topic) => topic.master)?.id ?? "root");
          return true;
        }
        case "stop-generation": {
          if (settingsMode || projectedTicketId || !live.busy) return false;
          void sendWsWithAck({ type: "chat.abort", topicId: activeTopicId }).catch((error: unknown) => {
            setActionError(error instanceof Error ? error.message : t("停止生成失败", "Could not stop the response"));
          });
          return true;
        }
        case "copy-last-reply": {
          if (settingsMode || projectedTicketId || hasBlockingOverlay(document) || hasNonEmptyTextSelection(window, document)) {
            return false;
          }
          const streaming = live.busy ? (live.streamingText?.trim() ?? "") : "";
          let latest = streaming;
          if (!latest) {
            for (let index = responseMessages.length - 1; index >= 0; index--) {
              const candidate = responseMessages[index]!;
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
          if (!settingsMode || hasBlockingOverlay(document)) return false;
          triggerShortcutSave();
          return true;
        }
      }
    },
    handleEscape(event) {
      if (hasBlockingOverlay(document)) return false;
      if (projectedTicketId) {
        closeProjection();
        return true;
      }
      if (settingsMode) {
        const editableTarget = isEditableKeyboardTarget(event.target)
          ? event.target
          : isEditableKeyboardTarget(document.activeElement)
            ? document.activeElement
            : null;
        if (editableTarget) {
          const container = document.querySelector<HTMLElement>("main.moco-workbench-main");
          if (container && container !== editableTarget) {
            container.focus({ preventScroll: true });
          } else {
            editableTarget.blur();
          }
          return true;
        }
        exitSettings();
        return true;
      }
      return false;
    },
  };

  const sidebarNode = (
    <TopicsSidebar
      agentName={agentName}
      connected={connected}
      terminalEntries={terminalEntries}
      agentLive={persistedLive}
      onAgentClick={() => openChatTopic(topics.find((topic) => topic.master)?.id ?? "root")}
      settingsMode={settingsMode}
      settingsModule={settingsModule}
      onSelectSettingsModule={(id) => {
        if (id === settingsModule) {
          setSheet(undefined);
          return;
        }
        runGuardedNavigation(() => {
          setSettingsDirty(false);
          setSettingsModule(id);
          setVoiceSettingsRequested(false);
          setSettingsTarget(undefined);
          setSheet(undefined);
        });
      }}
      onEnterSettings={enterSettings}
      onExitSettings={exitSettings}
      topics={topics}
      projects={projects}
      onProjectsChange={setProjects}
      onTopicsChange={setTopics}
      activeTopicId={activeTopicId}
      activeProjectId={activeTopic?.projectId ?? undefined}
      projectedTicketId={projectedTicketId}
      projectNavigation={projectNavigation}
      onProjectNavigationHandled={() => setProjectNavigation(undefined)}
      tickets={tickets}
      topicActivity={topicActivity}
      envs={envs}
      settings={settings}
      showProcess={showProcess}
      onShowProcessChange={setShowProcess}
      onSettingsUpdated={acceptSavedSettings}
      onCreateTopic={handleCreateTopic}
      onSelectTopic={openChatTopic}
      onPatchTopic={handlePatchTopic}
      onDeleteTopic={handleDeleteTopic}
      searchFocusRequest={searchFocusRequest}
      onSearchConversations={() => openConversationSearch("all")}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      messagesCount={messages.length}
    />
  );

  const lastConversationEntry = conversationTranscript.at(-1);
  const liveMessageId = !viewingHistory && lastConversationEntry?.type === "message" ? liveResponseMessageId(responseMessages, live) : undefined;
  const liveDispatchGroupKey = viewingHistory ? undefined : matchingLiveDispatchGroupKey(lastConversationEntry, live);
  const responseScopes = responseMotionScopes(conversationTranscript, chatTimeline.pending, live);

  const renderConversationMessage = (item: ChatViewItem, contentOnly = false) => {
    if (item.role === "user") {
      if (!isConversationTurn(item)) return null;
      const backup = item.clientSubmission ? pendingSubmissions.find((submission) => submissionKey(submission) === item.clientSubmission!.key) : undefined;
      const state = item.clientSubmission?.state;
      const status = chatDeliveryLabel(item);
      const name = item.text.trim().slice(0, 24) || item.attachments?.[0]?.name || t("附件消息", "Attachment message");
      return (
        <div key={messageMotionKey(item)} id={conversationTurnId(activeTopicId, item.id)} data-message-id={item.id} tabIndex={-1} data-request-id={item.requestId} data-delivery={state ?? item.delivery} className="moco-message-target flex flex-col items-end gap-1.5">
          <MessageMotion className="w-full" scopeKey={messageMotionKey(item)} animateEntry={animateMessageEntry(item)}>
            <ConnectedMessageContent item={item} connected={connected} conversationKey={activeTopicId} deliveryScope={deliveryScope} onPreviewImage={setLightboxImage} onReply={replyToMessage} onNavigateReply={navigateReply} />
          </MessageMotion>
          {status && <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5 text-xs text-muted">
            <span className={state === "failed" ? "min-w-0 max-w-full break-words text-danger" : undefined} role={state === "failed" ? "alert" : "status"}>{status}</span>
            {backup && state === "failed" && item.clientSubmission?.errorCode !== "request_intent_conflict" && item.clientSubmission?.errorCode !== legacyInvitationCode && <Button size="sm" variant="ghost" isDisabled={!outboxReady || editingSubmissionRef.current.has(scopedDraftKey(backup.draftKey, backup.outboxScope))} aria-label={t(`重试发送：${name}`, `Retry sending: ${name}`)} onPress={() => { void dispatchSubmissionWithAck(backup).catch((error: unknown) => setActionError(error instanceof Error ? error.message : t("无法恢复待发消息", "Could not restore the pending message"))); }}>{t("重试发送", "Retry sending")}</Button>}
            {backup && state === "failed" && <Button size="sm" variant="ghost" aria-label={t(`编辑未发送的消息：${name}`, `Edit unsent message: ${name}`)} onPress={() => { void recoverPendingSubmission(backup); }}>{t("编辑", "Edit")}</Button>}
            {item.delivery === "paused" && item.id === lastPausedMessageId && <Button size="sm" variant="secondary" isPending={resumingQueuedTopic === activeTopicId} isDisabled={!outboxReady || live.busy || resumingQueuedTopic === activeTopicId} onPress={() => resumeQueuedMessages(activeTopicId)}>{t("继续处理", "Resume")}</Button>}
          </div>}
        </div>
      );
    }

    if (item.role === "dispatch" && item.dispatch) {
      return (
        <div key={item.id} data-message-id={item.id} tabIndex={-1} className="moco-message-target"><MessageMotion animateEntry={animateMessageEntry(item)} scopeKey={item.id}><TaskDispatchCard
          dispatch={item.dispatch}
          liveTicket={ticketById.get(item.dispatch.ticketId)}
          onProject={projectTask}
        /></MessageMotion></div>
      );
    }

    if (item.role === "relay") {
      return null;
    }

    if (item.role === "system_note") {
      return (
        <div
          key={item.id}
          className="self-center rounded-full bg-surface-secondary px-3 py-1 text-xs text-muted"
        >
          {item.text}
        </div>
      );
    }

    const hasVisibleContent =
      Boolean(item.text || item.parts?.length || item.attachments?.length) ||
      (showProcess && Boolean(item.thinking || item.toolCalls?.length));
    if (!hasVisibleContent) return null;

    return (
      <div key={responseScopes.messages.get(item.id) ?? messageMotionKey(item)} data-message-id={item.id} tabIndex={-1} className="moco-message-target"><MessageMotion as="article" scopeKey={responseScopes.messages.get(item.id) ?? messageMotionKey(item)} animateEntry={animateMessageEntry(item)} className="flex flex-col gap-2.5">
        {showProcess && item.thinking && (
          <Disclosure className="rounded-xl border border-border bg-surface-secondary px-3 py-2">
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground">
                <Disclosure.Indicator />
                {t("思考过程", "Thinking")}
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="mt-1.5">
                <pre className="scrollbar max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted">
                  {item.thinking}
                </pre>
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        )}
        {showProcess &&
          item.toolCalls &&
          item.toolCalls.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.toolCalls.map((tc) => (
                <Chip
                  key={tc.id}
                  size="sm"
                  variant="soft"
                  className="font-mono"
                >
                  {tc.name}
                </Chip>
              ))}
            </div>
          )}
        <ConnectedMessageContent item={item} connected={connected} conversationKey={activeTopicId} deliveryScope={deliveryScope} onPreviewImage={setLightboxImage} onReply={replyToMessage} onNavigateReply={navigateReply} contentOnly={contentOnly}
          trailingContent={!contentOnly && item.id === liveMessageId ? liveResponseNode : undefined}
          onAdjust={(card, values) => {
            setCurrentDraft(cardAdjustmentDraft(card, values));
            requestAnimationFrame(() => composerRef.current?.focus());
          }} />
      </MessageMotion></div>
    );
  };

  const liveResponseNode = !viewingHistory && live.busy ? (
    <MessageMotion key={responseScopes.live} as={liveMessageId === undefined && !liveDispatchGroupKey ? "article" : "div"} className="flex flex-col gap-2" scopeKey={responseScopes.live} animateEntry={animateLiveEntry && liveMessageId === undefined && !liveDispatchGroupKey}>
      {live.streamingText ? (
        <StreamingMessage text={live.streamingText} onPreviewImage={setLightboxImage} />
      ) : (
        <div className="flex items-center gap-2.5 py-2 text-xs text-muted">
          <MocoThinkingIndicator />
          {live.retrying && <span>{t(`模型响应异常，正在重试（第 ${live.retrying.attempt} 次）…`, `Model response failed. Retrying (attempt ${live.retrying.attempt})…`)}</span>}
        </div>
      )}
    </MessageMotion>
  ) : null;
  const renderConversationEntry = (entry: ConversationEntry<ChatViewItem>) => entry.type === "message"
    ? renderConversationMessage(entry.item)
    : <MessageMotion key={entry.key} scopeKey={entry.key} animateEntry={entry.dispatches.some(animateMessageEntry)}><DispatchMessageGroup group={entry} onReply={replyToMessage} onNavigateReply={navigateReply} renderMessage={(item) => renderConversationMessage(item, true)}
        trailingContent={entry.key === liveDispatchGroupKey ? liveResponseNode : undefined} /></MessageMotion>;

  const titlebarNode = (
      <div className="moco-workbench-header">
        {projectedTicketId && !settingsMode && (
          <Button size="sm"
            isIconOnly
            variant="ghost"
            className="moco-window-control"
            aria-label={t("返回对话", "Back to chat")}
            onPress={closeProjection}
          >
            <MocoIcon name="arrow-left" size={20} />
          </Button>
        )}

        <div className={"min-w-0 flex-1" + (projectedTicketId && !settingsMode ? " moco-task-heading" : "")}>
        <h1 className="moco-page-title">
          {settingsMode
            ? settingsModuleTitle(settingsModule, language)
            : projectedTicketId
              ? projectedCard?.title || projectedTitle || t("任务详情", "Task details")
              : activeTopicTitle}
        </h1>
        {projectedTicketId && projectedCard && !settingsMode && (
          <TaskStatus status={projectedCard.status} waiting={projectedCard.waiting} cleanupPending={projectedCard.cleanupPending} recovery={projectedCard.recovery} externalAgentKind={projectedCard.externalAgentKind} pendingWorkspaceApply={projectedCard.pendingWorkspaceApply} />
        )}
        </div>

        {!settingsMode && !projectedTicketId && <>
          {locatingMessage && <Spinner size="sm" aria-label={t("正在定位消息", "Locating message")} />}
          <Button size="sm" isIconOnly variant="ghost" className="moco-window-control" aria-label={t("搜索对话正文", "Search conversation messages")} onPress={() => openConversationSearch("all")}><MocoIcon name="search" size={18} /></Button>
          <ConversationFilesButton topicId={activeTopicId} scopeKey={deliveryScope} revision={`${persistedMessages.at(-1)?.id ?? 0}:${persistedMessages.length}`} isLocal={Boolean(localTopics.selected)} onNavigate={navigateConversation} />
        </>}

        {!settingsMode && !projectedTicketId && activeTopic && !activeTopic.master && (
          <Dropdown>
            <Button size="sm" isIconOnly variant="ghost" className="moco-window-control" aria-label={t("话题操作", "Topic actions")}>
              <MocoIcon name="more-vert" size={20} />
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label={t("话题操作", "Topic actions")}
                onAction={(key) => {
                  if (key === "pin") {
                    void handlePatchTopic(activeTopic.id, {
                      pinned: !activeTopic.pinned,
                    });
                  } else if (key === "archive") {
                    void handlePatchTopic(activeTopic.id, {
                      archived: !activeTopic.archived,
                    });
                  }
                }}
              >
                <Dropdown.Item
                  id="pin"
                  textValue={activeTopic.pinned ? t("取消置顶", "Unpin") : t("置顶话题", "Pin topic")}
                >
                  <MocoIcon name="pin" size={16} />
                  <Label>{activeTopic.pinned ? t("取消置顶", "Unpin") : t("置顶话题", "Pin topic")}</Label>
                </Dropdown.Item>
                {!activeTopic.master && (
                  <Dropdown.Item
                    id="archive"
                    textValue={activeTopic.archived ? t("恢复话题", "Restore topic") : t("归档话题", "Archive topic")}
                  >
                    <MocoIcon
                      name={activeTopic.archived ? "unarchive" : "archive"}
                      size={16}
                    />
                    <Label>{activeTopic.archived ? t("恢复话题", "Restore topic") : t("归档话题", "Archive topic")}</Label>
                  </Dropdown.Item>
                )}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}

        {!settingsMode && !projectedTicketId && activeTopicTaskCount > 0 && (
          <Chip size="sm" variant="soft" color="accent">
            {t(`${activeTopicTaskCount} 个任务`, `${activeTopicTaskCount} ${activeTopicTaskCount === 1 ? "task" : "tasks"}`)}
          </Chip>
        )}

      </div>
  );

  const centerNode = (
    <>
      {topBannerError && !settingsMode && (
        <div className="shrink-0 px-4 pt-3">
          <Alert status="danger" className="flex items-start gap-3 rounded-2xl p-3">
            <Alert.Indicator className="mt-0.5 shrink-0" />
            <Alert.Content className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Alert.Title className="font-semibold">
                {topBannerError.desc.title}
              </Alert.Title>
              <Alert.Description className="text-xs">
                {topBannerError.desc.hint}
              </Alert.Description>
            </Alert.Content>
            <div className="flex shrink-0 items-center gap-1.5">
              {topBannerError.desc.suggestModelSettings && (
                <Button size="sm" variant="tertiary" onPress={openModelSettings}>
                  {t("模型设置", "Models")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onPress={() => { setActionError(null); clearError(); }}
              >
                {t("关闭", "Close")}
              </Button>
            </div>
          </Alert>
        </div>
      )}

      {orphanedSubmission && !settingsMode && !projectedTicketId && <div className="shrink-0 px-4 pt-3">
        <Alert status="danger" className="flex items-center gap-3 rounded-2xl p-3">
          <Alert.Indicator />
          <Alert.Content className="min-w-0 flex-1"><Alert.Description className="text-xs">{orphanedSubmission.error || t("原话题已不可用", "The original topic is unavailable")}</Alert.Description><p className="truncate text-sm">{orphanedSubmission.rawUserText || orphanedSubmission.draftAttachments[0]?.name}</p></Alert.Content>
          <Button size="sm" variant="secondary" onPress={() => recoverPendingSubmission(orphanedSubmission, currentDraftKey)}>{t("恢复到当前对话", "Restore to this chat")}</Button>
        </Alert>
      </div>}

      {!topBannerError && failedTaskSubmission && !settingsMode && (
        <div className="shrink-0 px-4 pt-3">
          <Alert status="danger" className="flex items-center gap-3 rounded-2xl p-3">
            <Alert.Indicator className="shrink-0" />
            <Alert.Content className="min-w-0 flex-1">
              <Alert.Description className="text-xs">
                {failedTaskSubmission.error || t("任务消息发送失败", "Could not send the task message")}
              </Alert.Description>
            </Alert.Content>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button size="sm" variant="ghost" onPress={() => { void recoverPendingSubmission(failedTaskSubmission); }}>编辑</Button>
              {outboxReady && (
                <Button
                  size="sm"
                  variant="primary"
                  onPress={() => { void dispatchSubmissionWithAck(failedTaskSubmission).catch((error: unknown) => setActionError(error instanceof Error ? error.message : t("无法恢复待发指令", "Could not restore the pending instruction"))); }}
                >
                  {t("重试发送", "Retry sending")}
                </Button>
              )}
            </div>
          </Alert>
        </div>
      )}

      {!settingsMode && !topicDrafts.isLocal(activeTopicId) && <ComputerPreview key={activeTopicId} topicId={activeTopicId} connected={connected}
        onStop={async (ticketId) => { await sendWsWithAck({ type: "ticket.stop", ticketId, reason: "手动停止" }); }} />}

      {!settingsMode && !projectedTicketId && viewingHistory && <div className="moco-history-location">
        <span className="moco-history-location-label moco-item-description"><MocoIcon name="search" size={16} />{t("正在查看历史消息", "Viewing historical messages")}</span>
        <Button size="sm" variant="secondary" onPress={scrollToLatest}>{t("回到最新消息", "Jump to latest")}</Button>
      </div>}

      {settingsMode ? (
        <MocoSettingsBoard
          scheduledTaskActions={{
            canQueue: outboxReady,
            stop: async (ticketId) => { await sendWsWithAck({ type: "schedule.stop", ticketId }); },
            delete: async (ticketId) => { await sendWsWithAck({ type: "schedule.delete", ticketId }); },
          }}
          voiceSettingsRequested={voiceSettingsRequested}
          key={settingsEditorEpoch}
          topicId={activeTopicId}
          module={settingsModule}
          recentWorkSource={{ tickets, topics, projects }}
          tickets={tickets}
          ticketsLoaded={schedulesLoaded}
          topics={topics}
          projects={projects}
          topicsLoaded={topicsLoaded}
          snapshotError={snapshotError}
          onSnapshotRefresh={refreshSnapshot}
          onTopicRestored={(restored) => setTopics((current) => current.map((topic) => topic.id === restored.id ? restored : topic))}
          settings={settings}
          envs={envs}
          slots={slots}
          onSettingsUpdated={acceptSavedSettings}
          onDirtyChange={setSettingsDirty}
          entryIntent={settingsEntryIntent}
          onIntentHandled={handleSettingsIntentHandled}
          permissionEntry={permissionEntry}
          onPermissionEntryHandled={(id) => setPermissionEntry((current) => current?.id === id ? null : current)}
          clientId={settingsAssistantControls.clientId}
          capabilities={capabilitiesWorkspace.snapshot}
          capabilitiesLoading={capabilitiesWorkspace.loading}
          capabilitiesError={capabilitiesWorkspace.error}
          connected={connected}
          capabilityRequestsDisabled={settingsAssistant.live.busy || settingsAssistantControls.sending || settingsAssistantControls.unconfirmedSend || !settingsAssistantLoaded}
          capabilityTarget={settingsTarget}
          capabilityView={capabilityView}
          onCapabilityViewChange={setCapabilityView}
          onCapabilityRequest={requestCapabilityAssistant}
          onCapabilitiesRefresh={() => void capabilitiesWorkspace.refresh()}
          connections={connectionsWorkspace.snapshot}
          connectionsLoading={connectionsWorkspace.loading}
          connectionsError={connectionsWorkspace.error}
          connectionPreparing={connectionPreparing}
          onConnectionPrepare={requestConnectionPrepare}
          onConnectionsRefresh={() => void connectionsWorkspace.refresh()}
          onOpenModels={() => {
            runGuardedNavigation(() => {
              if (settingsDirty) setSettingsEditorEpoch((epoch) => epoch + 1);
              setSettingsMode(true);
              setSettingsDirty(false);
              setSettingsModule("models");
              setVoiceSettingsRequested(false);
              setSettingsTarget(undefined);
              setProjectedTicketId(undefined);
              setSheet(undefined);
            });
          }}
        />
      ) : projectedTicketId ? (
        projectedDetail ? (
          <>
            <MocoTaskProjection
              key={projectedTicketId}
              detail={projectedDetail}
              detailLoading={isProjectedDetailLoading && inspectError?.ticketId !== projectedTicketId}
              detailError={
                inspectError?.ticketId === projectedTicketId
                  ? inspectError.message
                  : null
              }
              onRetryInspect={() => {
                clearInspectError();
                sendWs({
                  type: "ticket.inspect",
                  ticketId: projectedTicketId,
                  requestId: `inspect:${projectedTicketId}:${Date.now()}`,
                });
              }}
              connected={connected}
              canQueueActions={outboxReady}
              pendingAnswer={pendingAnswer}
              roleLabel={projectedCard?.roleLabel ?? projectedDetail.ticket.role}
              onAnswerBlocker={async (id, answer, commandId) => {
                const ans = redactDeviceInvitationText(answer);
                const draftKey = blockerDraftKey(projectedDetail.ticket);
                const existing = outboxRecords.find((record) => record.envelope.type === "ticket.steer" && record.metadata?.draftKey === draftKey && record.envelope.text === ans && (record.state === "queued" || record.state === "sending"));
                const record = existing ?? await enqueueWs({
                  type: "ticket.steer",
                  ticketId: id,
                  text: ans,
                  commandId,
                }, { draftKey, topicId: projectedDetail.ticket.originTopicId ?? "root", rawUserText: ans }, deliveryScope);
                await waitForQueuedAck(record);
              }}
              onStop={async (id) => {
                await sendWsWithAck({
                  type: "ticket.stop",
                  ticketId: id,
                  reason: "手动停止",
                });
              }}
              onRetry={retryTicket}
              onArchiveClose={ignoreTicket}
              onDefer={closeProjection}
              projectName={projectedProject?.name}
              onOpenProject={projectedProject ? () => {
                setProjectNavigation((current) => ({ projectId: projectedProject.id, sequence: (current?.sequence ?? 0) + 1 }));
                if (sizeClass === "compact") setSheet("left");
                else setCollapsed((current) => ({ ...current, left: false }));
              } : undefined}
              onOpenOrigin={topics.some((topic) => topic.id === (projectedDetail.ticket.originTopicId ?? "root") && !topic.deletedAt) ? () => {
                closeProjection();
                selectTopic(projectedDetail.ticket.originTopicId ?? "root");
              } : undefined}
              onPreviewImage={setLightboxImage}
              onReply={replyToMessage}
            />

            <div className="mx-auto flex w-full max-w-[880px] shrink-0 flex-col gap-2 px-4 pb-4 pt-2">
              <div className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-secondary px-3 py-1 text-xs text-muted">
                <span className="truncate">{t("关于：", "About: ")}{projectedDetail.ticket.title}</span>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="moco-projection-close"
                  aria-label={t("返回对话", "Back to chat")}
                  onPress={closeProjection}
                >
                  <MocoIcon name="close" size={12} />
                </Button>
              </div>
              {pendingTaskSubmission && <div className="flex min-w-0 items-center gap-2 text-xs text-muted" role="status"><span>{pendingTaskSubmission.state === "sending" ? t("发送中", "Sending") : pendingTaskSubmission.state === "queued" ? t("待发送", "Queued") : t("待确认", "Awaiting confirmation")}</span><span className="truncate">{pendingTaskSubmission.rawUserText}</span></div>}
              <MocoComposer
                textareaRef={composerRef}
                draftText={currentDraft}
                replyTo={currentReply}
                onCancelReply={() => setCurrentReply(undefined)}
                onDraftTextChange={setCurrentDraft}
                attachments={currentAttachments}
                onEnqueueFiles={(files) => enqueueFiles(currentDraftKey, files)}
                onRemoveAttachment={(localId) => removeAttachment(currentDraftKey, localId)}
                onRetryAttachment={(localId) => retryAttachment(currentDraftKey, localId)}
                onCancelAttachment={(localId) => cancelAttachment(currentDraftKey, localId)}
                conversationKey={`${activeTopicId}:ticket:${projectedTicketId}`}
                onTranscribeVoice={transcribeVoice}
                voiceCallTarget={projectedVoiceCallTarget}
                onOpenCall={openCallPanel}
                onConfigureVoice={openVoiceSettings}
                onPreviewImage={setLightboxImage}
                onSubmit={() => submitMessage()}
                connected={connected}
                canQueueMessages={outboxReady}
                placeholder={composerPlaceholder()}
              />
            </div>
          </>
        ) : inspectError?.ticketId === projectedTicketId ? (
          <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col items-center justify-center gap-3 px-4">
            <Alert status="danger" className="rounded-2xl p-4">
              <Alert.Indicator />
              <Alert.Content className="flex flex-col gap-1">
                <Alert.Title className="text-sm font-semibold">
                  {t("无法加载任务详情", "Could not load task details")}
                </Alert.Title>
                <Alert.Description className="text-xs">
                  {inspectError.message}
                </Alert.Description>
              </Alert.Content>
            </Alert>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onPress={closeProjection}>
                {t("返回对话", "Back to chat")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onPress={() => {
                  clearInspectError();
                  sendWs({
                    type: "ticket.inspect",
                    ticketId: projectedTicketId,
                    requestId: `inspect:${projectedTicketId}:${Date.now()}`,
                  });
                }}
              >
                {t("重试加载", "Retry")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size="lg" aria-label={t("加载任务详情", "Loading task details")} />
          </div>
        )
      ) : (
        <ConversationScene
          conversationKey={currentDraftKey}
          empty={messages.length === 0 && !live.busy && !activeRunFailure && !canLoadHistory && !historyLoading}
          ready={Boolean(localTopics.selected) || Boolean(viewingHistory) || conversationLoaded}
          onChooseRecommendation={(task) => {
            setCurrentDraft(task.prompt);
            requestAnimationFrame(() => composerRef.current?.focus());
          }}
          transcript={
          <div className="moco-chat-stage" data-has-outline={conversationTurns.length > 1 || undefined}>
            <div
              ref={chatScrollRef}
              className="mc-chat-scroll flex-1 overflow-y-auto px-4 py-4"
              onScroll={handleChatScroll}
              onScrollEnd={() => { chatNavigatingRef.current = false; handleChatScroll(); }}
              onWheel={() => { chatNavigatingRef.current = false; }}
              onTouchStart={() => { chatNavigatingRef.current = false; }}
            >
              <div key={activeTopicId} className="moco-conversation-stream">
                {canLoadHistory && <Button variant="ghost" size="sm" className="self-center" isDisabled={historyLoading || messageWindowLoading} onPress={() => {
                  const node = chatScrollRef.current;
                  const previousHeight = node?.scrollHeight ?? 0;
                  const previousTop = node?.scrollTop ?? 0;
                  nearBottomRef.current = false;
                  void loadConversationHistory().then(() => requestAnimationFrame(() => {
                    if (node) node.scrollTop = previousTop + node.scrollHeight - previousHeight;
                  })).catch((error: unknown) => toast.danger(error instanceof Error ? error.message : t("加载历史失败", "Could not load history")));
                }}>{historyLoading || messageWindowLoading ? t("加载中…", "Loading…") : t("更早的消息", "Earlier messages")}</Button>}
                {[
                  ...conversationTranscript.map(renderConversationEntry),
                  liveDispatchGroupKey || liveMessageId !== undefined ? null : liveResponseNode,
                  ...chatTimeline.pending.map((item) => renderConversationMessage(item)),
                ]}

                {activeRunFailure && (
                  <MocoTurnErrorCard
                    descriptor={activeRunFailure.desc}
                    modelId={currentModelId}
                    retrying={retryingTurn}
                    onRetry={() => void handleRetryTurn()}
                    onOpenModelSettings={openModelSettings}
                    onDismiss={() => dismissRunFailure(activeRunFailure.key)}
                  />
                )}
              </div>
            </div>
            <ConversationOutline key={activeTopicId} turns={conversationTurns} topicId={activeTopicId} scrollRef={chatScrollRef} onNavigate={() => {
              chatNavigatingRef.current = true;
              nearBottomRef.current = false;
            }} />
          </div>
          }
          composer={<>
            {showToBottom && !viewingHistory && (
              <Button
                isIconOnly
                variant="secondary"
                size="sm"
                className="moco-jump-to-latest absolute -top-9 right-6"
                aria-label={t("回到最新消息", "Jump to latest")}
                onPress={scrollToLatest}
              >
                <MocoIcon name="chevron-down" size={18} />
              </Button>
            )}
            <MocoComposer
              textareaRef={composerRef}
              draftText={currentDraft}
              deviceJoin={deviceJoin}
              allowAttachments={!deviceJoin}
              replyTo={currentReply}
              onCancelReply={() => setCurrentReply(undefined)}
              onDraftTextChange={setCurrentDraft}
              attachments={currentAttachments}
              onEnqueueFiles={(files) => { enqueueFiles(currentDraftKey, files); if (files.length) topicDrafts.touch(activeTopicId); }}
              onRemoveAttachment={(localId) => removeAttachment(currentDraftKey, localId)}
              onRetryAttachment={(localId) => retryAttachment(currentDraftKey, localId)}
              onCancelAttachment={(localId) => cancelAttachment(currentDraftKey, localId)}
              conversationKey={currentDraftKey}
              onTranscribeVoice={transcribeVoice}
              voiceCallTarget={voiceCallTarget}
              onResolveVoiceCallTarget={resolveVoiceCallTarget}
              onOpenCall={openCallPanel}
              onConfigureVoice={openVoiceSettings}
              onPreviewImage={setLightboxImage}
              onSubmit={() => submitMessage()}
              onAbort={() => { void sendWsWithAck({ type: "chat.abort", topicId: activeTopicId }).catch((error: unknown) => setActionError(error instanceof Error ? error.message : t("停止生成失败", "Could not stop the response"))); }}
              busy={live.busy}
              connected={connected}
              canQueueMessages={outboxReady}
              placeholder={composerPlaceholder()}
            />
          </>}
        />
      )}
    </>
  );

  const rightNode =
    settingsMode ? (
      <MocoSettingsRail
        module={settingsModule}
        agentName={agentName}
        settings={settings}
        envs={envs}
        tickets={tickets}
        onProjectTicket={projectTask}
        assistant={settingsAssistant}
        assistantLoaded={settingsAssistantLoaded}
        assistantError={settingsAssistantError}
        connected={connected}
        assistantControls={settingsAssistantControls}
        capabilitiesWorkspace={capabilitiesWorkspace.snapshot}
        capabilityInputs={capabilitiesWorkspace.snapshot?.inputs}
        capabilityView={capabilityView}
        onCapabilityInputsChanged={() => void capabilitiesWorkspace.refresh()}
        imageRequest={imageAssistantRequest}
        onImageRequestHandled={(id) => setImageAssistantRequest((current) => current?.id === id ? undefined : current)}
        connections={connectionsWorkspace.snapshot}
        connectionPreparing={connectionPreparing}
        onConnectionPrepare={requestConnectionPrepare}
        onConnectionsRefresh={() => void connectionsWorkspace.refresh()}
      />
    ) : (
      <MocoTaskRail
        tickets={tickets}
        projectedTicketId={projectedTicketId}
        completedTaskDisplayHours={settings?.blocks.executor.value.completedTaskDisplayHours}
        connected={connected}
        canQueueActions={outboxReady}
        loaded={ticketsLoaded}
        snapshotVersion={ticketSnapshotVersion}
        onProject={projectTask}
        onRetry={retryTicket}
        onIgnore={ignoreTicket}
      />
    );

  return (
    <VoiceProvider connected={connected} clientId={settingsAssistantControls.clientId} incoming={voiceSnapshot} agentName={agentName}>
    <div className="mc-app" data-theme={settings ? undefined : undefined}>
      <WorkbenchShell
        settingsMode={settingsMode}
        sizeClass={sizeClass}
        leftCollapsed={collapsed.left}
        rightCollapsed={settingsMode ? settingsRightCollapsed : collapsed.right}
        sheet={sheet}
        onCloseSheet={() => setSheet(undefined)}
        leftLabel={settingsMode ? t("设置导航", "Settings navigation") : t("工作台导航", "Workspace navigation")}
        rightLabel={settingsMode ? t("设置对话", "Settings chat") : workbenchName}
        leftControl={
          <AgentNavigationToggle expanded={leftExpanded} onToggle={() => togglePanel("left")} />
        }
        titlebarContent={titlebarNode}
        rightControl={
          <Button size="sm" isIconOnly variant="ghost" className="moco-window-control"
            aria-label={settingsMode
              ? rightExpanded ? t("收起设置对话", "Collapse settings chat") : t("展开设置对话", "Expand settings chat")
              : rightExpanded ? t("收起任务栏", "Collapse task panel") : t("展开任务栏", "Expand task panel")}
            aria-expanded={rightExpanded}
            onPress={() => togglePanel("right")}
          >
            <MocoIcon name="panel-right" size={20} />
          </Button>
        }
        leftContent={sidebarNode}
        centerContent={centerNode}
        rightContent={rightNode}
      />

      <ConversationSearchDialog isOpen={conversationSearchOpen} onOpenChange={setConversationSearchOpen} topicId={activeTopicId} scopeKey={deliveryScope} initialScope={conversationSearchScope} scopeVersion={conversationSearchScopeVersion} onNavigate={navigateConversation} />

      <AttachmentLightbox
        image={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />

      <ConfirmDialog
        open={settingsNavigation.needsConfirmation}
        title={t("放弃未保存的修改？", "Discard unsaved changes?")}
        description={t("当前设置页面存在尚未保存的草稿，离开后未保存的修改将会丢失。", "Leaving this page will discard your unsaved changes.")}
        confirmLabel={t("放弃修改并离开", "Discard and leave")}
        cancelLabel={t("继续编辑", "Keep editing")}
        status="warning"
        onCancel={settingsNavigation.cancel}
        onConfirm={() => {
          setSettingsDirty(false);
          settingsNavigation.discard();
        }}
      />
    </div>
    </VoiceProvider>
  );
}
