/** Typed REST + Multi-Topic WebSocket client for KuloHub. */
import { useCallback, useEffect, useRef, useState } from "react";
import { applyTicketBoardDelta } from "@kulo/protocol";
import { translate as t } from "./kulo-i18n";
import { mergeChatHistory } from "./features/chat/chat-submissions";
import { deviceInvitationCopies } from "./features/chat/device-invitation-copies";
import { sendWithAcknowledgement, type PendingWsAcknowledgement } from "./features/chat/ws-acknowledgements";
import { createIndexedDbOutboxStorage, isReliableEnvelope, ReliableOutbox, withReliableId, type ReliableOutboxMetadata, type ReliableOutboxRecord } from "./features/chat/reliable-outbox";
import { deliveryIntentKey } from "./features/chat/reliable-intents";
import { updateAgentTerminal, type AgentTerminalState } from "./features/topics/agent-terminal-state";
import { evaluateTopicConversationFrame, findRootConversationId } from "./features/shell/root-rotation";
import {
  ensureMediaSession,
  getAuthTokenFromUrl,
  KuloApiError,
  kuloRest,
  providerCatalog,
  resetMediaSession,
  type ChatHistoryPage,
} from "./kulo-api-rest";
import type {
  AgentExpressionState,
  AssistantItemView,
  ChatDisplayItem,
  ClientToHubMessage,
  ClusterClientSummary,
  EnvNodeDescriptor,
  HubToClientMessage,
  KuloSettingsView,
  LiveStreamState,
  MainSessionNotificationEvent,
  ProjectView,
  SettingsAssistantSnapshot,
  SlotSummary,
  SubagentCardView,
  TicketCardView,
  TicketRecord,
  TopicActivity,
  TopicSummary,
  VoiceSnapshot,
} from "@kulo/protocol";

export {
  apiRequest,
  ensureMediaSession,
  getAuthTokenFromUrl,
  KuloApiError,
  kuloRest,
  providerCatalog,
  resolveAssetUrl,
  type AssistantWorkspaceView,
  type ChatHistoryPage,
  type MediaSession,
  type TicketDeliverable,
} from "./kulo-api-rest";

export const EMPTY_SETTINGS_ASSISTANT: SettingsAssistantSnapshot = {
  topicId: null,
  messages: [],
  live: { busy: false, activeTools: [], queuedCount: 0 },
  actions: [],
  conversations: [],
};

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export interface TicketDetailSnapshot {
  ticket: TicketRecord;
  transcript: ChatDisplayItem[];
  live: LiveStreamState;
  subagents?: SubagentCardView[];
}

export class KuloWsDisconnectedError extends Error {
  readonly isDisconnect = true;
  constructor(message = t("与中枢的实时连接已中断", "The real-time connection to the Hub was interrupted")) {
    super(message);
    this.name = "KuloWsDisconnectedError";
  }
}

export interface KuloWsAckResult {
  deduplicated?: boolean; topicId?: string; conversationId?: number; ticketId?: string; itemId?: string; submissionId?: number; delivery?: "queued" | "accepted";
}

const COMMAND_ID_MESSAGE_TYPES = new Set<ClientToHubMessage["type"]>([
  "ticket.steer",
  "ticket.retry",
  "ticket.stop",
  "ticket.close",
  "schedule.stop",
  "schedule.delete",
  "assistant.item_action",
]);

function attachTrackingId(msg: ClientToHubMessage): {
  envelope: ClientToHubMessage;
  trackingKey: string;
} {
  if (COMMAND_ID_MESSAGE_TYPES.has(msg.type)) {
    const existing =
      "commandId" in msg && typeof msg.commandId === "string" && msg.commandId.trim()
        ? msg.commandId.trim()
        : `cmd:${msg.type}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    return {
      envelope: { ...msg, commandId: existing } as ClientToHubMessage,
      trackingKey: existing,
    };
  }
  const existing =
    "requestId" in msg && typeof msg.requestId === "string" && msg.requestId.trim()
      ? msg.requestId.trim()
      : `req:${msg.type}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
  return {
    envelope: { ...msg, requestId: existing } as ClientToHubMessage,
    trackingKey: existing,
  };
}

export function useKuloHubConnection() {
  const [connected, setConnected] = useState(false);
  const [subscriptionsReady, setSubscriptionsReady] = useState(false);
  const [activeTopicId, setActiveTopicIdState] = useState<string>(() =>
    readStored<string>("kulo:active-topic", "root"),
  );
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [topicsLoaded, setTopicsLoaded] = useState(false);
  const [topicActivities, setTopicActivities] = useState<Record<string, TopicActivity>>({});
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [recentMessages, setMessages] = useState<ChatDisplayItem[]>([]);
  const [conversationLoaded, setConversationLoaded] = useState(false);
  const [newMessageIds, setNewMessageIds] = useState<Set<number>>(() => new Set());
  const seenMessageIdsRef = useRef(new Set<number>());
  const changingTopicRef = useRef(false);
  const [historyBefore, setHistoryBefore] = useState<number>();
  const [historyPage, setHistoryPage] = useState<ChatHistoryPage & { topicId: string }>({ topicId: activeTopicId, messages: [], hasMore: true });
  const [historyLoading, setHistoryLoading] = useState(false);
  const messages = historyPage.topicId === activeTopicId && historyPage.messages.length
    ? mergeChatHistory(historyPage.messages, recentMessages)
    : recentMessages;
  const canLoadHistory = historyPage.topicId === activeTopicId && historyPage.messages.length ? historyPage.hasMore : historyBefore !== undefined;
  const [live, setLive] = useState<LiveStreamState>({
    busy: false,
    activeTools: [],
    queuedCount: 0,
  });
  const [agentTerminal, setAgentTerminal] = useState<AgentTerminalState | null>(null);
  const [tickets, setTickets] = useState<TicketCardView[]>([]);
  const [assistantItems, setAssistantItems] = useState<AssistantItemView[]>([]);
  const assistantRevisionRef = useRef(-1);
  const [ticketsLoaded, setTicketsLoaded] = useState(false);
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [ticketSnapshotVersion, setTicketSnapshotVersion] = useState(0);
  const [slots, setSlots] = useState<SlotSummary>({
    used: 0,
    max: 3,
    queuedCount: 0,
  });
  const [envs, setEnvs] = useState<EnvNodeDescriptor[]>([]);
  const [cluster, setCluster] = useState<ClusterClientSummary | null>(null);
  const clusterPrimaryKeyRef = useRef<string | null>(null);
  const [expression, setExpression] = useState<AgentExpressionState | null>(null);
  const [settings, setSettings] = useState<KuloSettingsView | null>(null);
  useEffect(() => {
    if (settings) void providerCatalog.configure(settings);
  }, [settings]);
  const [settingsAssistant, setSettingsAssistant] = useState<SettingsAssistantSnapshot>(EMPTY_SETTINGS_ASSISTANT);
  const [settingsAssistantLoaded, setSettingsAssistantLoaded] = useState(false);
  const [settingsAssistantError, setSettingsAssistantError] = useState<string | null>(null);
  const [capabilitiesUpdateVersion, setCapabilitiesUpdateVersion] = useState(0);
  const [voiceSnapshot, setVoiceSnapshot] = useState<VoiceSnapshot | undefined>(undefined);
  const settingsSubscriptionErrorRef = useRef<string | null>(null);
  const [inspectedTicket, setInspectedTicket] =
    useState<TicketDetailSnapshot | null>(null);
  const [inspectError, setInspectError] = useState<{
    ticketId: string;
    message: string;
  } | null>(null);
  const [topicErrors, setTopicErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [showProcess, setShowProcessState] = useState<boolean>(() =>
    readStored<boolean>("kulo:show-process", false),
  );

  const wsRef = useRef<WebSocket | null>(null);
  const readySocketRef = useRef<WebSocket | null>(null);
  const activeTopicRef = useRef(activeTopicId);
  const activeConversationIdRef = useRef<number | undefined>(undefined);
  const rootConversationIdRef = useRef<number | undefined>(undefined);
  const selectionVersionRef = useRef(0);
  const topicsLoadedRef = useRef(topicsLoaded);
  topicsLoadedRef.current = topicsLoaded;
  const schedulesLoadedRef = useRef(schedulesLoaded);
  schedulesLoadedRef.current = schedulesLoaded;
  const notificationListenersRef = useRef(new Set<(event: MainSessionNotificationEvent) => void>());
  const subscribeNotification = useCallback((listener: (event: MainSessionNotificationEvent) => void) => {
    notificationListenersRef.current.add(listener);
    return () => { notificationListenersRef.current.delete(listener); };
  }, []);

  const pendingAcksRef = useRef(new Map<string, PendingWsAcknowledgement<KuloWsAckResult>>());
  const outboxRef = useRef<ReliableOutbox | null>(null);
  const outboxScopeRef = useRef<string | undefined>(undefined);
  const outboxUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const connectionRecoveryRef = useRef<(() => void) | undefined>(undefined);
  const [outboxRecords, setOutboxRecords] = useState<readonly ReliableOutboxRecord[]>([]);
  const [outboxReady, setOutboxReady] = useState(false);
  const [deliveryScope, setDeliveryScope] = useState<string>();
  const reliableFlightsRef = useRef(new Map<string, Promise<KuloWsAckResult>>());
  const recentReliableActionsRef = useRef(new Map<string, { until: number; ack: KuloWsAckResult }>());

  const setShowProcess = useCallback((next: boolean) => {
    setShowProcessState(next);
    writeStored("kulo:show-process", next);
  }, []);

  const sendWs = useCallback((msg: ClientToHubMessage): boolean => {
    const ws = wsRef.current;
    if (ws && ws === readySocketRef.current && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  const transmitWsWithAck = useCallback(
    (msg: ClientToHubMessage, timeoutMs = 15_000): Promise<KuloWsAckResult> => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new KuloWsDisconnectedError(t("当前与中枢连接未就绪", "The Hub connection is not ready")));
      }
      const { envelope, trackingKey } = attachTrackingId(msg);
      return sendWithAcknowledgement(pendingAcksRef.current, trackingKey, msg.type,
        () => {
          if (msg.type === "settings.assistant.subscribe") {
            setSettingsAssistantLoaded(false);
            setSettingsAssistantError(null);
            settingsSubscriptionErrorRef.current = null;
          }
          ws.send(JSON.stringify(envelope));
        },
        () => {
          if (msg.type !== "settings.assistant.subscribe") {
            if (isReliableEnvelope(msg)) connectionRecoveryRef.current?.();
            return new KuloWsDisconnectedError(t("等待服务端接收确认超时", "Timed out waiting for the server to confirm receipt"));
          }
          const message = t("中枢未返回设置对话，请重试；若刚更新 Kulo，请重新启动中枢。", "The Hub did not return the settings chat. Try again; restart the Hub if you just updated Kulo.");
          settingsSubscriptionErrorRef.current = message;
          setSettingsAssistantError(message);
          return new KuloApiError(408, message, "settings_assistant_unavailable");
        }, timeoutMs);
    },
    [],
  );

  const bindOutbox = useCallback((scope: string) => {
    const existing = outboxRef.current;
    if (existing && outboxScopeRef.current === scope) return existing;
    if (existing && outboxScopeRef.current !== scope) {
      setTopicsLoaded(false);
      setSchedulesLoaded(false);
    }
    existing?.setConnected(false);
    if (existing?.getSnapshot().some((record) => record.state !== "accepted")) {
      setGlobalError(t("待发内容属于另一个中枢或设备，已保留在原队列中", "Pending content belongs to another Hub or device and has been kept in its original queue"));
    }
    outboxUnsubscribeRef.current?.();
    existing?.dispose();
    setOutboxReady(false);
    setOutboxRecords([]);
    setDeliveryScope(scope);
    const next = new ReliableOutbox({
      storage: createIndexedDbOutboxStorage(), scope, ownsStorage: true,
      transmit: transmitWsWithAck,
      isTransient: (error) => error instanceof KuloWsDisconnectedError || error instanceof KuloApiError &&
        (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500),
      onError: (error) => {
        if (outboxRef.current !== next) return;
        setOutboxReady(false);
        setGlobalError(error instanceof Error ? error.message : t("无法保存待发内容", "Unable to save pending content"));
      },
    });
    outboxRef.current = next;
    outboxScopeRef.current = scope;
    const publish = () => {
      if (outboxRef.current !== next) return;
      setOutboxRecords(next.getSnapshot());
      setOutboxReady(next.getError() === undefined);
      const failedCommand = next.getSnapshot().find((record) => record.state === "failed" && record.errorCode !== "root_conversation_rotated" && record.envelope.type !== "chat.send" && (record.envelope.type !== "ticket.steer" || record.metadata?.draftKey?.startsWith("answer:")));
      if (failedCommand?.error) setGlobalError(failedCommand.error);
    };
    outboxUnsubscribeRef.current = next.subscribe(publish);
    void next.ready.then(() => {
      if (outboxRef.current !== next) return;
      setOutboxReady(true); publish();
    }).catch((error: unknown) => {
      if (outboxRef.current === next) setGlobalError(error instanceof Error ? error.message : t("无法恢复待发内容", "Unable to restore pending content"));
    });
    return next;
  }, [transmitWsWithAck]);

  const enqueueWs = useCallback(async (message: ClientToHubMessage, metadata?: ReliableOutboxMetadata, expectedScope?: string) => {
    if (!isReliableEnvelope(message)) throw new Error(t("此操作不支持离线排队", "This action cannot be queued offline"));
    const outbox = outboxRef.current;
    if (!outbox) throw new Error(t("请先连接中枢以建立待发队列", "Connect to the Hub first to create a pending queue"));
    await outbox.ready;
    if (outboxRef.current !== outbox || expectedScope !== undefined && outboxScopeRef.current !== expectedScope) throw new KuloWsDisconnectedError(t("中枢身份已改变，原草稿已保留", "The Hub identity changed. The original draft has been kept"));
    return outbox.enqueue(withReliableId(message), metadata);
  }, []);

  const waitForQueuedAck = useCallback(async (record: ReliableOutboxRecord): Promise<KuloWsAckResult> => {
    const outbox = outboxRef.current;
    if (!outbox || outboxScopeRef.current !== record.scope) throw new KuloWsDisconnectedError(t("待发内容已保留在原中枢队列中", "Pending content has been kept in the original Hub queue"));
    const ack = await outbox.waitForAck(record.id);
    if (record.envelope.type !== "chat.send") {
      try { await outbox.removeAccepted([record.id]); }
      catch (error) {
        if (outboxRef.current === outbox) setGlobalError(error instanceof Error ? error.message : t("无法清理已确认的发送记录", "Could not clear confirmed send records"));
      }
    }
    return ack;
  }, []);

  const sendWsWithAck = useCallback((message: ClientToHubMessage, timeoutMs = 15_000): Promise<KuloWsAckResult> => {
    if (!isReliableEnvelope(message)) return transmitWsWithAck(message, timeoutMs);
    const suppliedId = "commandId" in message ? message.commandId : "requestId" in message ? message.requestId : undefined;
    // Buttons in separate task views share one unconfirmed intent; chat sends keep their own explicit IDs.
    const semantic = !suppliedId && message.type !== "chat.send" ? `${outboxScopeRef.current}:${deliveryIntentKey(message)}` : undefined;
    if (semantic) {
      const flight = reliableFlightsRef.current.get(semantic);
      if (flight) return flight;
      const now = performance.now();
      for (const [key, recent] of recentReliableActionsRef.current) if (recent.until <= now) recentReliableActionsRef.current.delete(key);
      const recent = recentReliableActionsRef.current.get(semantic);
      if (recent) return Promise.resolve(recent.ack);
    }
    const operation = (async () => {
      const outbox = outboxRef.current;
      if (!outbox) throw new Error(t("请先连接中枢以建立待发队列", "Connect to the Hub first to create a pending queue"));
      await outbox.ready;
      if (outboxRef.current !== outbox) throw new KuloWsDisconnectedError(t("中枢身份已改变，待发内容保留在原队列中", "The Hub identity changed. Pending content has been kept in its original queue"));
      const matching = semantic ? outbox.getSnapshot().find((record) => {
        if (record.state === "accepted") return false;
        return deliveryIntentKey(record.envelope) === deliveryIntentKey(message);
      }) : undefined;
      const record = matching?.state === "failed" ? await outbox.retry(matching.id) : matching ?? await outbox.enqueue(withReliableId(message));
      return waitForQueuedAck(record);
    })();
    if (semantic) {
      reliableFlightsRef.current.set(semantic, operation);
      void operation.then((ack) => {
        reliableFlightsRef.current.delete(semantic);
        recentReliableActionsRef.current.set(semantic, { ack, until: performance.now() + 500 });
      }, () => reliableFlightsRef.current.delete(semantic));
    }
    return operation;
  }, [enqueueWs, transmitWsWithAck, waitForQueuedAck]);

  const retryQueuedWs = useCallback(async (id: string, scope?: string) => {
    const outbox = outboxRef.current;
    if (!outbox) throw new Error(t("待发队列尚未就绪", "The pending queue is not ready"));
    if (scope && scope !== outboxScopeRef.current) throw new KuloWsDisconnectedError(t("中枢身份已改变，待发内容保留在原队列中", "The Hub identity changed. Pending content has been kept in its original queue"));
    return outbox.retry(id);
  }, []);

  const removeAcceptedWs = useCallback(async (ids: string[], scope: string) => {
    if (scope !== outboxScopeRef.current) return;
    await outboxRef.current?.removeAccepted(ids);
  }, []);

  const discardFailedWs = useCallback(async (id: string, scope?: string) => {
    if (scope && scope !== outboxScopeRef.current) throw new KuloWsDisconnectedError(t("中枢身份已改变，待发内容保留在原队列中", "The Hub identity changed. Pending content has been kept in its original queue"));
    await outboxRef.current?.remove(id);
  }, []);

  const sendTopicSelection = useCallback(() => {
    const selectionVersion = selectionVersionRef.current;
    return sendWs({ type: "topic.select", topicId: activeTopicRef.current, selectionVersion, requestId: `select:${selectionVersion}` });
  }, [sendWs]);

  const selectTopic = useCallback(
    (topicId: string) => {
      if (topicId === activeTopicRef.current && !changingTopicRef.current) return;
      activeTopicRef.current = topicId;
      activeConversationIdRef.current = undefined;
      selectionVersionRef.current++;
      changingTopicRef.current = true;
      setConversationLoaded(false);
      setNewMessageIds(new Set());
      seenMessageIdsRef.current = new Set();
      setHistoryBefore(undefined);
      setHistoryLoading(false);
      setHistoryPage({ topicId, messages: [], hasMore: true });
      setMessages([]);
      setLive({ busy: false, activeTools: [], queuedCount: 0 });
      setActiveTopicIdState(topicId);
      writeStored("kulo:active-topic", topicId);
      sendTopicSelection();
    },
    [sendTopicSelection],
  );

  useEffect(() => {
    let closed = false;
    let hasConnected = false;
    void providerCatalog.ensure();
    const refreshCatalogWhenVisible = () => {
      if (document.visibilityState === "visible" && !providerCatalog.getSnapshot().refreshing) void providerCatalog.refresh();
    };
    window.addEventListener("focus", refreshCatalogWhenVisible);
    document.addEventListener("visibilitychange", refreshCatalogWhenVisible);
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let connecting = false;
    let lastReceivedAt = Date.now();
    let supportsPing = false;
    let openingTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const saved = localStorage.getItem("kulo:delivery-scope");
      if (saved) {
        const identity: unknown = JSON.parse(saved);
        if (Array.isArray(identity) && identity.length === 3 && identity.every((item) => typeof item === "string") && identity[0] === window.location.origin) {
          bindOutbox(saved);
        }
      }
    } catch (error) {
      setGlobalError(error instanceof Error ? t(`无法读取待发队列身份：${error.message}`, `Unable to read the pending queue identity: ${error.message}`) : t("无法读取待发队列身份", "Unable to read the pending queue identity"));
    }

    const rejectAllPending = (reason: string) => {
      const pending = Array.from(pendingAcksRef.current.values());
      pendingAcksRef.current.clear();
      for (const item of pending) {
        clearTimeout(item.timer);
        item.reject(new KuloWsDisconnectedError(reason));
      }
    };

    const scheduleReconnect = () => {
      if (closed || retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = undefined; void connect(); }, 1500);
    };

    const disconnect = (reason: string) => {
      const ws = wsRef.current;
      wsRef.current = null;
      readySocketRef.current = null;
      setSubscriptionsReady(false);
      clearTimeout(openingTimer);
      if (ws) {
        ws.onopen = null; ws.onmessage = null; ws.onclose = null;
        ws.close();
      }
      setConnected(false);
      setConversationLoaded(false);
      setTicketsLoaded(false);
      setSettingsAssistantLoaded(false);
      outboxRef.current?.setConnected(false);
      rejectAllPending(reason);
      scheduleReconnect();
    };
    connectionRecoveryRef.current = () => disconnect(t("等待中枢确认超时，正在重新连接", "Timed out waiting for Hub confirmation. Reconnecting"));

    const connect = async () => {
      if (closed || connecting || wsRef.current) return;
      if (!navigator.onLine) { scheduleReconnect(); return; }
      connecting = true;
      try {
        await ensureMediaSession(true);
      } catch (error) {
        connecting = false;
        if (closed) return;
        setGlobalError(error instanceof Error ? error.message : t("媒体连接未就绪", "The media connection is not ready"));
        scheduleReconnect();
        return;
      }
      connecting = false;
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const token = getAuthTokenFromUrl();
      const params = new URLSearchParams();
      params.set("ticketDeltas", "1");
      if (token) params.set("token", token);
      if (activeTopicRef.current) params.set("topic", activeTopicRef.current);
      const initialSelectionVersion = selectionVersionRef.current;
      params.set("selectionVersion", String(initialSelectionVersion));
      const qs = params.toString();
      const wsUrl = `${proto}://${window.location.host}/ws/client${qs ? `?${qs}` : ""}`;
      const ws = new WebSocket(wsUrl);
      let versionedSelections = false;
      const resetRootViewState = (nextRootConvId: number) => {
        activeConversationIdRef.current = nextRootConvId;
        rootConversationIdRef.current = nextRootConvId;
        changingTopicRef.current = false;
        seenMessageIdsRef.current = new Set();
        setNewMessageIds(new Set());
        setHistoryBefore(undefined);
        setHistoryLoading(false);
        setHistoryPage({ topicId: "root", messages: [], hasMore: true });
        setMessages([]);
        setLive({ busy: false, activeTools: [], queuedCount: 0 });
        setConversationLoaded(true);
        setAgentTerminal((previous) => (previous?.topicId === "root" ? null : previous));
      };
      const acceptsTopicFrame = (topicId?: string, version?: number, conversationId?: number) => {
        const res = evaluateTopicConversationFrame({
          frameTopicId: topicId, frameVersion: version, frameConversationId: conversationId,
          activeTopicId: activeTopicRef.current, activeConversationId: activeConversationIdRef.current,
          selectionVersion: selectionVersionRef.current, versionedSelections, changingTopic: changingTopicRef.current,
        });
        if (res.rotatedTo !== undefined) resetRootViewState(res.rotatedTo);
        else if (res.accept && conversationId !== undefined && activeConversationIdRef.current === undefined) activeConversationIdRef.current = conversationId;
        return res.accept;
      };
      let boardRevision: number | undefined;
      let boardTickets: TicketCardView[] = [];
      let resyncingBoard = false;
      wsRef.current = ws;
      supportsPing = false;
      openingTimer = setTimeout(() => { if (wsRef.current === ws) disconnect(t("连接中枢超时，正在重试", "The Hub connection timed out. Retrying")); }, 10_000);

      ws.onopen = () => {
        if (closed || wsRef.current !== ws) return;
        if (hasConnected) void providerCatalog.refresh();
        hasConnected = true;
        lastReceivedAt = Date.now();
        clearTimeout(openingTimer);
        setConnected(true);
        setGlobalError(null);
        setSnapshotError(null);
      };

      ws.onmessage = (ev) => {
        if (closed || wsRef.current !== ws) return;
        lastReceivedAt = Date.now();
        try {
          const msg = JSON.parse(String(ev.data)) as HubToClientMessage;
          switch (msg.type) {
            case "hub.voice":
              setVoiceSnapshot(msg.snapshot);
              break;
            case "hub.capabilities": setCapabilitiesUpdateVersion((version) => version + 1); break;
            case "hub.builtin_memory": window.dispatchEvent(new CustomEvent("kulo:builtin-memory-changed", { detail: msg.state })); break;
            case "hub.ui_card": {
              const update = (items: ChatDisplayItem[]) => items.map((item) => item.parts?.some((part) => part.type === "ui" && part.cardId === msg.card.cardId)
                ? { ...item, parts: item.parts.map((part) => part.type === "ui" && part.cardId === msg.card.cardId ? { ...part, card: msg.card } : part) } : item);
              setMessages(update);
              setHistoryPage((previous) => ({ ...previous, messages: update(previous.messages) }));
              break;
            }
            case "hub.settings_assistant":
              setSettingsAssistant(msg.snapshot);
              setSettingsAssistantLoaded(true);
              if (settingsSubscriptionErrorRef.current) {
                const previousError = settingsSubscriptionErrorRef.current;
                setSettingsAssistantError((current) => current === previousError ? null : current);
                settingsSubscriptionErrorRef.current = null;
              }
              if (msg.requestId) {
                const pending = pendingAcksRef.current.get(msg.requestId);
                if (!pending || pending.action !== "settings.assistant.subscribe") break;
                clearTimeout(pending.timer);
                pendingAcksRef.current.delete(msg.requestId);
                pending.resolve({});
              }
              break;
            case "hub.snapshot": {
              const first = readySocketRef.current !== ws;
              const selectionVersion = selectionVersionRef.current;
              const selectedTopic = activeTopicRef.current;
              // A legacy Hub can fall back to root on connect. Accept that fallback only while
              // it still describes the selection we requested when opening this socket.
              const useSnapshotTopic = msg.selectionVersion !== undefined
                ? msg.selectionVersion === selectionVersion
                : msg.activeTopicId === selectedTopic || (first ? initialSelectionVersion === selectionVersion :
                  !msg.topics.some((topic) => topic.id === selectedTopic && !topic.deletedAt));
              supportsPing = msg.supportsPing === true;
              versionedSelections = msg.selectionVersion !== undefined;
              readySocketRef.current = ws;
              setSubscriptionsReady(true);
              const nextCluster = msg.cluster ?? null;
              setCluster(nextCluster);
              const nextClusterKey = nextCluster ? `${nextCluster.hubId}:${nextCluster.primaryNodeId}:${nextCluster.epoch}` : null;
              if (nextClusterKey && clusterPrimaryKeyRef.current && clusterPrimaryKeyRef.current !== nextClusterKey) {
                resetMediaSession();
                void ensureMediaSession(true).catch(() => {});
              }
              clusterPrimaryKeyRef.current = nextClusterKey;
              if (msg.deliveryIdentity) {
                const identity = msg.deliveryIdentity;
                if (typeof identity.hubId !== "string" || !identity.hubId || typeof identity.principalId !== "string" || !identity.principalId) throw new Error(t("中枢返回了无效的交付身份", "The Hub returned an invalid delivery identity"));
                const scope = JSON.stringify([window.location.origin, identity.hubId, identity.principalId]);
                deviceInvitationCopies.setScope(scope);
                providerCatalog.setScope(scope);
                void providerCatalog.ensure();
                setDeliveryScope(scope);
                try {
                  localStorage.setItem("kulo:delivery-scope", scope);
                  const outbox = bindOutbox(scope);
                  void outbox.ready.then(() => {
                    if (!closed && wsRef.current === ws && outboxRef.current === outbox) outbox.setConnected(true);
                  }).catch((error: unknown) => setGlobalError(error instanceof Error ? error.message : t("无法恢复待发队列", "Unable to restore the pending queue")));
                } catch (error) {
                  outboxRef.current?.setConnected(false);
                  if (outboxScopeRef.current !== scope) {
                    outboxUnsubscribeRef.current?.(); outboxUnsubscribeRef.current = undefined;
                    outboxRef.current?.dispose(); outboxRef.current = null; outboxScopeRef.current = undefined;
                    setOutboxRecords([]);
                  }
                  setOutboxReady(false);
                  setGlobalError(error instanceof Error ? t(`无法保存待发队列身份：${error.message}`, `Unable to save the pending queue identity: ${error.message}`) : t("无法保存待发队列身份", "Unable to save the pending queue identity"));
                }
              } else {
                outboxRef.current?.setConnected(false);
                setGlobalError(t("请更新中枢以启用可靠消息交付", "Update the Hub to enable reliable message delivery"));
              }
              const nextRootConv = findRootConversationId(msg.topics);
              const rootRotated = nextRootConv !== undefined && rootConversationIdRef.current !== undefined && nextRootConv !== rootConversationIdRef.current;
              if (nextRootConv !== undefined) rootConversationIdRef.current = nextRootConv;
              if (useSnapshotTopic) {
                const nextActiveConv = msg.activeConversationId ?? msg.topics.find((topic) => topic.id === msg.activeTopicId)?.conversationId;
                const convChanged = nextActiveConv !== undefined && activeConversationIdRef.current !== undefined && nextActiveConv !== activeConversationIdRef.current;
                activeTopicRef.current = msg.activeTopicId;
                activeConversationIdRef.current = nextActiveConv;
                setActiveTopicIdState(msg.activeTopicId);
                writeStored("kulo:active-topic", msg.activeTopicId);
                if (convChanged || (rootRotated && msg.activeTopicId === "root")) {
                  setHistoryPage({ topicId: msg.activeTopicId, messages: [], hasMore: true });
                  setHistoryLoading(false);
                }
                setAgentTerminal((previous) => updateAgentTerminal(convChanged ? null : previous, {
                  topicId: msg.activeTopicId, messages: msg.messages, live: msg.live, tickets: msg.tickets,
                }));
                setMessages(msg.messages);
                seenMessageIdsRef.current = new Set(msg.messages.map((item) => item.id));
                setConversationLoaded(true);
                setNewMessageIds(new Set());
                changingTopicRef.current = false;
                setHistoryBefore(msg.historyBefore);
                setLive(msg.live);
              } else if (first || msg.selectionVersion === undefined) {
                sendTopicSelection();
              }
              setTopics((current) => {
                const selected = !useSnapshotTopic && current.find((topic) => topic.id === selectedTopic && !topic.deletedAt);
                return selected && !msg.topics.some((topic) => topic.id === selectedTopic) ? [...msg.topics, selected] : msg.topics;
              });
              setTopicsLoaded(true);
              setTopicActivities(msg.topicActivities ?? { [msg.activeTopicId]: {
                busy: msg.live.busy, queuedCount: msg.live.queuedCount,
                lastAssistantMessageId: msg.messages.filter((item) => item.role === "assistant").at(-1)?.id,
              } });
              setProjects(msg.projects ?? []);
              boardRevision = msg.ticketRevision;
              boardTickets = msg.tickets;
              resyncingBoard = false;
              setTickets(boardTickets);
              if (msg.assistantItems !== undefined) {
                assistantRevisionRef.current = msg.assistantRevision ?? 0;
                setAssistantItems(msg.assistantItems);
              }
              setTicketsLoaded(true);
              setSchedulesLoaded(true);
              setSnapshotError(null);
              setTicketSnapshotVersion((version) => version + 1);
              setSlots(msg.slots);
              setEnvs(msg.envs);
              if (msg.expression !== undefined) setExpression(msg.expression);
              if (msg.settings) setSettings(msg.settings);
              break;
            }
            case "hub.topics": {
              const nextRootConv = findRootConversationId(msg.topics);
              if (nextRootConv !== undefined && rootConversationIdRef.current !== undefined && nextRootConv !== rootConversationIdRef.current) {
                rootConversationIdRef.current = nextRootConv;
                if (activeTopicRef.current === "root") resetRootViewState(nextRootConv);
              } else if (nextRootConv !== undefined) {
                rootConversationIdRef.current = nextRootConv;
              }
              setTopics(msg.topics);
              setTopicsLoaded(true);
              setSnapshotError(null);
              setTopicActivities((current) => Object.fromEntries(Object.entries(current).filter(([topicId]) => msg.topics.some((topic) => topic.id === topicId && !topic.deletedAt))));
              if (!msg.topics.some((topic) => topic.id === activeTopicRef.current && !topic.deletedAt)) selectTopic("root");
              break;
            }
            case "hub.projects":
              setProjects(msg.projects);
              break;
            case "hub.topic_activity":
              setTopicActivities((current) => ({ ...current, [msg.topicId]: msg.activity }));
              break;
            case "hub.notification":
              for (const listener of notificationListenersRef.current) {
                listener(msg.event);
              }
              break;
            case "hub.messages":
              if (acceptsTopicFrame(msg.topicId, msg.selectionVersion, msg.conversationId)) {
                setAgentTerminal((previous) => updateAgentTerminal(previous, {
                  topicId: msg.topicId ?? activeTopicRef.current, messages: msg.messages,
                }));
                const fresh = changingTopicRef.current ? [] : msg.messages.filter((item) => !seenMessageIdsRef.current.has(item.id)).map((item) => item.id);
                for (const item of msg.messages) seenMessageIdsRef.current.add(item.id);
                setNewMessageIds((previous) => new Set(msg.messages.filter((item) => previous.has(item.id) || fresh.includes(item.id)).map((item) => item.id)));
                changingTopicRef.current = false;
                setHistoryBefore(msg.historyBefore);
                setMessages(msg.messages);
                setConversationLoaded(true);
              }
              break;
            case "hub.live":
              if (acceptsTopicFrame(msg.topicId, msg.selectionVersion, msg.conversationId)) {
                setAgentTerminal((previous) => updateAgentTerminal(previous, {
                  topicId: msg.topicId ?? activeTopicRef.current, live: msg.live,
                }));
                setLive(msg.live);
              }
              break;
            case "hub.tickets":
              boardTickets = msg.tickets;
              setAgentTerminal((previous) => updateAgentTerminal(previous, {
                topicId: activeTopicRef.current, tickets: msg.tickets,
              }));
              setTickets(msg.tickets);
              setSchedulesLoaded(true);
              setSlots(msg.slots);
              break;
            case "hub.assistant_items":
              if (msg.assistantRevision >= assistantRevisionRef.current) {
                assistantRevisionRef.current = msg.assistantRevision;
                setAssistantItems(msg.items);
              }
              break;
            case "hub.ticket_delta": {
              if (boardRevision !== undefined && msg.ticketRevision <= boardRevision) break;
              if (msg.previousRevision !== boardRevision) {
                if (!resyncingBoard) {
                  resyncingBoard = true;
                  void transmitWsWithAck({ type: "state.sync" }, 10_000).catch(() => {
                    if (resyncingBoard && !closed && wsRef.current === ws) disconnect(t("正在重新同步任务", "Reconnecting to sync tasks"));
                  });
                }
                break;
              }
              boardRevision = msg.ticketRevision;
              const next = applyTicketBoardDelta(boardTickets, msg);
              if (next !== boardTickets) {
                boardTickets = next;
                const selectedTopic = activeTopicRef.current;
                setAgentTerminal(previous => updateAgentTerminal(previous, { topicId: selectedTopic, tickets: next }));
                setTickets(next);
              }
              setSchedulesLoaded(true);
              setSlots(msg.slots);
              break;
            }
            case "hub.envs":
              setEnvs(msg.envs);
              break;
            case "hub.expression":
              setExpression(msg.expression);
              break;
            case "hub.settings":
              setSettings(msg.settings);
              break;
            case "hub.ticket_detail":
              setInspectError((cur) =>
                cur?.ticketId === msg.ticket.id ? null : cur,
              );
              setInspectedTicket({
                ticket: msg.ticket,
                transcript: msg.transcript,
                live: msg.live,
                ...(msg.subagents?.length ? { subagents: msg.subagents } : {}),
              });
              break;
            case "hub.ack": {
              if (!versionedSelections && msg.action === "topic.select" && msg.topicId && msg.topicId !== activeTopicRef.current) {
                // Legacy Hubs update their subscription in read-completion order.
                sendTopicSelection();
              }
              const key = msg.requestId || msg.commandId;
              if (key) {
                const pending = pendingAcksRef.current.get(key);
                // Subscription readiness comes from its snapshot, never from admission alone.
                if (pending && pending.action !== "settings.assistant.subscribe") {
                  clearTimeout(pending.timer);
                  pendingAcksRef.current.delete(key);
                  pending.resolve({
                    deduplicated: msg.deduplicated, topicId: msg.topicId, conversationId: msg.conversationId,
                    ticketId: msg.ticketId, itemId: msg.itemId, submissionId: msg.submissionId, delivery: msg.delivery,
                  });
                }
              }
              if (msg.action === "ticket.inspect" && msg.ticketId) {
                setInspectError((cur) =>
                  cur?.ticketId === msg.ticketId ? null : cur,
                );
              }
              break;
            }
            case "hub.error": {
              if (msg.action === "settings.assistant.subscribe") {
                settingsSubscriptionErrorRef.current = msg.message;
                setSettingsAssistantError(msg.message);
              }
              const key = msg.requestId || msg.commandId;
              let consumedByCaller = false;
              if (key) {
                const pending = pendingAcksRef.current.get(key);
                if (pending) {
                  clearTimeout(pending.timer);
                  pendingAcksRef.current.delete(key);
                  pending.reject(new KuloApiError(msg.retryable ? 503 : msg.status ?? 400, msg.message, msg.code));
                  consumedByCaller = true;
                }
              }
              if (msg.action === "ticket.inspect" && msg.ticketId) {
                setInspectError({
                  ticketId: msg.ticketId,
                  message: msg.message,
                });
                break;
              }
              if (!consumedByCaller) {
                if (msg.action?.startsWith("settings.assistant.")) {
                  setSettingsAssistantError(msg.message);
                  break;
                }
                if (msg.action === "topic.select" && msg.topicId === activeTopicRef.current && msg.topicId !== "root" &&
                  msg.requestId === `select:${selectionVersionRef.current}` &&
                  ["topic_not_found", "topic_deleted", "project_not_found", "project_binding_pending"].includes(msg.code ?? "")) {
                  selectTopic("root");
                  setGlobalError(msg.message);
                  break;
                }
                if (msg.action === "state.sync" || (!msg.topicId && (!topicsLoadedRef.current || !schedulesLoadedRef.current))) {
                  setSnapshotError(msg.message);
                }
                if (msg.topicId) {
                  setTopicErrors((prev) => ({
                    ...prev,
                    [msg.topicId!]: msg.message,
                  }));
                } else {
                  setGlobalError(msg.message);
                }
              }
              break;
            }
          }
        } catch (error) {
          setGlobalError(error instanceof Error ? error.message : t("中枢消息无效", "Invalid Hub message"));
        }
      };

      ws.onclose = () => {
        if (!closed && wsRef.current === ws) disconnect(t("发送过程中连接中断", "The connection was interrupted while sending"));
      };
    };

    void connect();
    const online = () => {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
      void connect();
    };
    const offline = () => disconnect(t("网络已断开，待发内容已保留", "The network disconnected. Pending content has been kept"));
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    const heartbeat = setInterval(() => {
      const ws = wsRef.current;
      const idle = Date.now() - lastReceivedAt;
      if (ws?.readyState !== WebSocket.OPEN || idle < 20_000) return;
      if (readySocketRef.current !== ws) {
        if (idle >= 30_000) disconnect(t("等待中枢会话超时，正在重新连接", "Timed out waiting for the Hub session. Reconnecting"));
        return;
      }
      void transmitWsWithAck({ type: supportsPing ? "client.ping" : "state.sync" }, 10_000).catch(() => {
        if (!closed && wsRef.current === ws) disconnect(t("中枢连接无响应，正在重新连接", "The Hub connection is unresponsive. Reconnecting"));
      });
    }, 20_000);
    const mediaRenewal = setInterval(() => {
      void ensureMediaSession().catch((error: unknown) => {
        if (!closed) setGlobalError(error instanceof Error ? error.message : t("媒体连接已过期", "The media connection has expired"));
      });
    }, 60_000);
    kuloRest
      .getSettings()
      .then((s) => setSettings((cur) => cur ?? s))
      .catch(() => {});

    return () => {
      closed = true;
      window.removeEventListener("focus", refreshCatalogWhenVisible);
      document.removeEventListener("visibilitychange", refreshCatalogWhenVisible);
      connectionRecoveryRef.current = undefined;
      clearInterval(mediaRenewal);
      clearInterval(heartbeat);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      if (retryTimer) clearTimeout(retryTimer);
      clearTimeout(openingTimer);
      outboxUnsubscribeRef.current?.();
      outboxUnsubscribeRef.current = undefined;
      outboxRef.current?.dispose();
      outboxRef.current = null;
      outboxScopeRef.current = undefined;
      rejectAllPending(t("组件已卸载", "The component was unmounted"));
      const ws = wsRef.current; wsRef.current = null; readySocketRef.current = null;
      if (ws) { ws.onclose = null; ws.close(); }
    };
  }, [bindOutbox, selectTopic, sendTopicSelection, transmitWsWithAck]);

  const loadEarlierMessages = async () => {
    const before = historyPage.topicId === activeTopicId && historyPage.messages.length ? historyPage.beforeEntryId : historyBefore;
    if (historyLoading || before === undefined) return;
    const topicId = activeTopicId;
    const convId = activeConversationIdRef.current;
    const selection = selectionVersionRef.current;
    const socket = wsRef.current;
    setHistoryLoading(true);
    try {
      const page = await kuloRest.getTopicHistory(topicId, before);
      if (activeTopicRef.current !== topicId || activeConversationIdRef.current !== convId || selectionVersionRef.current !== selection || wsRef.current !== socket) return;
      if (page.conversationId !== undefined && convId !== undefined && page.conversationId !== convId) return;
      setHistoryPage((previous) => ({ ...page, topicId, messages: mergeChatHistory(page.messages, previous.topicId === topicId ? previous.messages : []) }));
    } finally {
      if (selectionVersionRef.current === selection && activeConversationIdRef.current === convId) setHistoryLoading(false);
    }
  };

  const lastError = topicErrors[activeTopicId] ?? globalError;

  const clearError = useCallback(() => {
    setGlobalError(null);
    setTopicErrors((prev) => {
      if (!(activeTopicRef.current in prev)) return prev;
      const next = { ...prev };
      delete next[activeTopicRef.current];
      return next;
    });
  }, []);

  const clearInspectError = useCallback(() => {
    setInspectError(null);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    setSnapshotError(null);
    try {
      await transmitWsWithAck({ type: "state.sync" }, 10_000);
    } catch (syncError) {
      if (!topicsLoadedRef.current) {
        try {
          const [topicList, projectList] = await Promise.all([
            kuloRest.listTopics(),
            kuloRest.listProjects().catch(() => ({ projects: undefined })),
          ]);
          setTopics(topicList.items);
          if (projectList.projects) setProjects(projectList.projects);
          setTopicsLoaded(true);
          if (schedulesLoadedRef.current) return;
        } catch (restError) {
          const message = restError instanceof Error ? restError.message : t("加载失败，请重试。", "Failed to load. Try again.");
          setSnapshotError(message);
          return;
        }
      }
      const message = syncError instanceof Error ? syncError.message : t("加载失败，请重试。", "Failed to load. Try again.");
      setSnapshotError(message);
    }
  }, [transmitWsWithAck]);

  return {
    connected, subscriptionsReady, deliveryScope, outboxReady, outboxRecords,
    enqueueWs, waitForQueuedAck, retryQueuedWs, removeAcceptedWs, discardFailedWs,
    activeTopicId, selectTopic, topics, topicsLoaded, topicActivities, setTopics, projects, setProjects,
    messages, conversationLoaded, newMessageIds, canLoadHistory, historyLoading, loadEarlierMessages,
    live, terminalEntries: agentTerminal?.topicId === activeTopicId ? agentTerminal.entries : [],
    tickets, assistantItems, ticketsLoaded, schedulesLoaded, snapshotError, refreshSnapshot, ticketSnapshotVersion,
    slots, envs, cluster, expression, settings, setSettings,
    settingsAssistant, settingsAssistantLoaded, settingsAssistantError, setSettingsAssistantError,
    capabilitiesUpdateVersion, voiceSnapshot, inspectedTicket, setInspectedTicket, inspectError, clearInspectError,
    showProcess, setShowProcess, lastError, clearError, sendWs, sendWsWithAck, subscribeNotification,
  };
}
