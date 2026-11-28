import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import {
  getMessageParts,
  type ChatDisplayItem,
  type LiveStreamState,
  type SettingsAssistantContext,
  type UiCardSnapshot,
} from "@kulo/protocol";
import type { KuloActionConfirmations } from "./action-confirmations.js";
import { repairHistoricalChatAttachments } from "./chat-attachment-deliveries.js";
import { queuedChatEntries } from "./chat-submissions.js";
import type { KuloConnections } from "./connections.js";
import type { HubContextGuard } from "./context-guard.js";
import { redactCredentialData } from "./credential-redaction.js";
import {
  extractDisplayMessages,
  extractLiveState,
  type DisplayMessageOptions,
} from "./hub-display-projection.js";
import { containsToolOverflowMarker } from "./orchestrator-tool-overflow.js";
import { loadSearchEvidencePrefix, SearchEvidenceHistory } from "./search-history.js";
import { SettingsAssistantDoc, isActiveSettingsConversation } from "./settings-doc.js";
import { KuloStateDoc, isOrchestratorConversation, isTicketUnfinished } from "./state.js";
import {
  pruneIdleDeferredToolsInTx,
  resolveSettingsPreloadedTools,
  type ToolSurfaceRuntimeState,
} from "./tool-surface.js";
import type { KuloUiCards } from "./ui-cards.js";
import type { KuloUploadStore } from "./uploads.js";

export interface HubMessageProjectionDeps {
  harness: Harness;
  uploads: KuloUploadStore;
  uiCards: Pick<KuloUiCards, "snapshot">;
  connectionManager: Pick<KuloConnections, "redact" | "snapshot"> &
    Partial<Pick<KuloConnections, "getConnectionRecord">>;
  actionConfirmations: Pick<KuloActionConfirmations, "listPendingForConversation">;
  getContextGuard: () => Pick<HubContextGuard, "projectLiveContext">;
  hasPendingMediaRelay: (conversationId: number) => boolean;
  getSettingsSurfaceState: (turnContext?: SettingsAssistantContext | null) => ToolSurfaceRuntimeState;
}

export class HubMessageProjection {
  readonly #deps: HubMessageProjectionDeps;
  readonly #cardSnapshots = new Map<string, UiCardSnapshot>();
  readonly #searchHistories = new Map<number, SearchEvidenceHistory>();

  constructor(deps: HubMessageProjectionDeps) {
    this.#deps = deps;
  }

  rememberCard(card: UiCardSnapshot): void {
    this.#cardSnapshots.set(card.cardId, card);
  }

  async hydrateCards(conversationId: number): Promise<void> {
    for (const card of await this.#deps.uiCards.snapshot(conversationId)) {
      if ((this.#cardSnapshots.get(card.cardId)?.revision ?? 0) <= card.revision) {
        this.#cardSnapshots.set(card.cardId, card);
      }
    }
  }

  async hydrateMessages(
    entries: readonly EntryRecord[],
    conversationId: number,
    options?: DisplayMessageOptions,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ChatDisplayItem[]> {
    await repairHistoricalChatAttachments(
      this.#deps.harness,
      this.#deps.uploads,
      entries,
      conversationId,
      context,
    );
    if (entries[0]) {
      const conversation = await this.#deps.harness.conversation(conversationId as ConversationId, context);
      if (conversation) {
        this.#searchHistory(conversationId).remember(
          await loadSearchEvidencePrefix(conversation, entries[0], context),
        );
      }
    }
    await this.hydrateCards(conversationId);
    return this.projectMessages(entries, conversationId, options);
  }

  projectMessages(
    entries: readonly EntryRecord[],
    conversationId: number,
    options?: DisplayMessageOptions,
  ): ChatDisplayItem[] {
    const resolvedOptions = this.#displayOptions(options);
    return this.decorateChatMessages(
      this.#searchHistory(conversationId).project(entries, (projection) =>
        extractDisplayMessages(projection, resolvedOptions),
      ),
      conversationId,
    );
  }

  decorateChatMessages(messages: ChatDisplayItem[], conversationId: number): ChatDisplayItem[] {
    const projected = messages.map((item) => {
      const parts = getMessageParts(item).map((part) => {
        if (part.type === "ui") return { ...part, card: this.#cardSnapshots.get(part.cardId) };
        if ("assetId" in part) {
          const loaded = this.#deps.uploads.getUpload(part.assetId);
          if (loaded) {
            if (
              loaded.record.ownerId !== undefined &&
              !loaded.record.referenceScopes?.includes(`conversation:${conversationId}`)
            ) {
              return { partId: part.partId, type: "markdown" as const, text: "附件不可用" };
            }
            return {
              ...part,
              asset: {
                ...this.#deps.uploads.toChatAttachment(loaded.record),
                ...(part.asset?.transcript ? { transcript: part.asset.transcript } : {}),
                ...(part.asset?.captions ? { captions: part.asset.captions } : {}),
              },
            };
          }
        }
        return part;
      });
      const attachments = item.attachments
        ? parts.flatMap((part) => ("asset" in part && part.asset ? [part.asset] : []))
        : undefined;
      return { ...item, parts, ...(attachments ? { attachments } : {}) };
    });
    return redactCredentialData(projected, (text) => this.#deps.connectionManager.redact(text));
  }

  projectSettingsDisplay(
    view: ConversationView,
    conversationId?: number,
  ): { messages: ChatDisplayItem[]; live: LiveStreamState } {
    return redactCredentialData(
      {
        messages:
          conversationId !== undefined
            ? this.projectMessages(view.entries, conversationId)
            : extractDisplayMessages(view.entries, this.#displayOptions()),
        live: extractLiveState(view),
      },
      (text) => this.#deps.connectionManager.redact(text),
    );
  }

  projectTopicMessages(value: ConversationView, conversationId: number): ChatDisplayItem[] {
    const queued = queuedChatEntries(value);
    // Inbox receipts are not transcript boundaries and must never enter evidence history.
    const pending = this.decorateChatMessages(
      extractDisplayMessages(queued.entries, this.#displayOptions()),
      conversationId,
    ).map((item) => {
      const delivery = queued.deliveries.get(item.id);
      return delivery ? { ...item, ...delivery } : item;
    });
    return [...this.projectMessages(value.entries, conversationId), ...pending];
  }

  projectTopicLiveState(
    value: ConversationView,
    conversationId: number,
    conversation?: Conversation,
  ): LiveStreamState {
    const live = extractLiveState(
      value,
      this.#searchHistory(conversationId).projectionEntries(value.entries),
    );
    return {
      ...live,
      context: this.#deps.getContextGuard().projectLiveContext(value, conversationId, conversation),
    };
  }

  async pruneCompactedConversationTools(
    conversationId: ConversationId,
    firstKept: number,
    context: Context,
  ): Promise<void> {
    const conv = await this.#deps.harness.conversation(conversationId, context);
    if (!conv) return;
    const [view, state, settingsDoc, connSnap] = await Promise.all([
      conv.context(context),
      this.#deps.harness.snapshot(KuloStateDoc, context),
      this.#deps.harness.snapshot(SettingsAssistantDoc, context),
      this.#deps.connectionManager.snapshot(),
    ]);
    const retained = new Set<string>();
    // 1. Retain tools invoked in the kept recent window (`entry.id >= firstKept`)
    for (const [idx, entry] of view.entries.entries()) {
      if (Number(entry.id) < firstKept) continue;
      for (const msg of view.contributions[idx] ?? []) {
        if (msg.role === "assistant") {
          for (const part of msg.content) {
            if (part.type === "toolCall") retained.add(part.name);
          }
        } else if (msg.role === "toolResult") {
          retained.add(msg.toolName);
          if (msg.content.some((part) => part.type === "text" && containsToolOverflowMarker(part.text))) {
            retained.add("kulo_inspect_asset");
          }
        }
      }
    }
    const convNum = Number(conversationId);
    // 2. Retain Settings active-module preloaded tools
    if (isActiveSettingsConversation(convNum, settingsDoc)) {
      const turnCtx =
        settingsDoc?.conversationId === convNum
          ? settingsDoc.turnContext
          : settingsDoc?.conversations?.[String(convNum)]?.turnContext;
      for (const name of resolveSettingsPreloadedTools(this.#deps.getSettingsSurfaceState(turnCtx))) {
        retained.add(name);
      }
    }
    // 3. Retain tools backed by unresolved server events on this orchestrator conversation
    if (isOrchestratorConversation(conversationId, state) || isActiveSettingsConversation(convNum, settingsDoc)) {
      for (const ticket of Object.values(state?.tickets ?? {})) {
        if ((ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== convNum) continue;
        if (ticket.boardId && (isTicketUnfinished(ticket) || ticket.status === "ready")) {
          retained.add("kulo_task_board");
        }
        if ((state?.workerArtifacts?.[ticket.id]?.length ?? 0) > 0) {
          retained.add("kulo_inspect_asset");
          retained.add("kulo_publish_asset");
        }
        if (
          ticket.externalExecution?.stagedDiff ||
          ticket.externalExecution?.stagedCwd ||
          ticket.workspaceStaging?.stagedDiff ||
          ticket.workspaceStaging?.stagedCwd
        ) {
          retained.add("kulo_inspect_staged_diff");
          retained.add("kulo_apply_staged_changes");
        }
        if ((ticket.externalExecution?.pendingPermissions?.length ?? 0) > 0) {
          retained.add("kulo_inspect");
          retained.add("kulo_external_permission");
        }
        if (
          ticket.status === "waiting" &&
          (ticket.waiting?.reason === "coordinator" || ticket.waiting?.reason === "user")
        ) {
          if (ticket.waiting.waitToken?.startsWith("host-action")) {
            retained.add("kulo_host_action_decide");
          } else if (ticket.latestReport?.state === "blocked" || ticket.waiting.reason === "coordinator") {
            retained.add("kulo_ticket_ask_user");
          }
        }
      }
      const pendingConfirmations = await this.#deps.actionConfirmations.listPendingForConversation(
        convNum,
        context,
      );
      for (const pending of pendingConfirmations) {
        if (pending.kind === "host_action") retained.add("kulo_host_action_decide");
        if (pending.kind === "external_permission") retained.add("kulo_external_permission");
        if (pending.kind === "ticket_decision") retained.add("kulo_ticket_ask_user");
      }
      if (this.#deps.hasPendingMediaRelay(convNum)) {
        retained.add("kulo_media_job");
        retained.add("kulo_inspect_asset");
      }
      if (
        connSnap.requests.some(
          (req) =>
            req.status === "pending" &&
            (state?.tickets[req.ticketId]?.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === convNum,
        )
      ) {
        retained.add("kulo_connection_decide");
      }
    }
    await this.#deps.harness.commit((tx) => pruneIdleDeferredToolsInTx(tx, conversationId, retained), context);
  }

  #displayOptions(options?: DisplayMessageOptions): DisplayMessageOptions {
    return {
      ...options,
      redactToolText: options?.redactToolText ?? ((text) => this.#deps.connectionManager.redact(text)),
      resolveConnectionLabel:
        options?.resolveConnectionLabel ??
        ((id) => this.#deps.connectionManager.getConnectionRecord?.(id)?.name),
    };
  }

  #searchHistory(conversationId: number): SearchEvidenceHistory {
    let history = this.#searchHistories.get(conversationId);
    if (!history) {
      history = new SearchEvidenceHistory();
      this.#searchHistories.set(conversationId, history);
    }
    return history;
  }
}
