import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness } from "@earendil-works/pi-durable";
import type {
  AssistantItemView,
  AssistantPendingAction,
  MainSessionNotificationEvent,
  TopicSummary,
} from "@kulo/protocol";
import type { EnvManager } from "@kulo/env";
import type { AmbientModelService } from "./ambient-model-service.js";
import { AssistantCoordinator } from "./assistant-coordinator.js";
import type { AssistantEchoSuppressor } from "./assistant-echo.js";
import type { AssistantLedger } from "./assistant-ledger.js";
import { isCriticalSafetyAlert } from "./assistant-proactive-guard.js";
import { AssistantProactiveWakeService } from "./assistant-proactive-wake.js";
import { AssistantSorter } from "./assistant-sorter.js";
import {
  AssistantDoc,
  createWatchRuleInDoc,
  deleteWatchRuleInDoc,
  ensureAssistantState,
  listEffectiveWatchRules,
  setQuietHoursInDoc,
  updateWatchRuleInDoc,
} from "./assistant-state.js";
import type { AssistantWatchRuleHost } from "./tools-assistant.js";
import {
  isHomeAssistantPreDispatchError,
  sanitizeServiceData,
  type HomeAssistantService,
} from "./connectors/home-assistant.js";
import type { LarkConnectorService } from "./connectors/lark-connector.js";
import type { SparkMailService } from "./connectors/spark-mail-service.js";
import type { KuloUploadStore } from "./uploads.js";

export interface HubAssistantWiringDeps {
  harness: Harness;
  ledger: AssistantLedger;
  ambientModel: AmbientModelService;
  echoSuppressor: AssistantEchoSuppressor;
  envManager: Pick<EnvManager, "getEnvDescriptor" | "setConnectorConfig">;
  uploads: Pick<KuloUploadStore, "saveUpload" | "bindAttachments">;
  sparkMail: SparkMailService;
  homeAssistant: HomeAssistantService;
  larkConnector: LarkConnectorService;
  redact(text: string): string;
  agentName(): string;
  isForegroundBusy(): boolean;
  isVoiceCallActive(): boolean;
  canMutateState(): boolean;
  isAssistantCloudCapped(): boolean;
  isMainModelLocal(): boolean;
  createDetachedOrchestratorConversation(context: Context): Promise<{ id: ConversationId }>;
  queueChat<T>(topicId: string, fn: () => Promise<T>): Promise<T>;
  resolveWatchedTopic(topicId: string, context: Context): Promise<{ topicId: string; conversation: Conversation }>;
  resumeIfNotRecovering(): void;
  onItemsChanged(revision: number, items: AssistantItemView[]): void;
  onTopicsChanged(topics: TopicSummary[]): void;
  onTopicContentChanged(topicId: string): void;
  emitNotification(event: MainSessionNotificationEvent): void;
}

export interface HubAssistantRuntime {
  proactiveWake: AssistantProactiveWakeService;
  coordinator: AssistantCoordinator;
  sorter: AssistantSorter;
  watchRules: AssistantWatchRuleHost;
}

export function createHubAssistantRuntime(deps: HubAssistantWiringDeps): HubAssistantRuntime {
  const proactiveWake = new AssistantProactiveWakeService({
    harness: deps.harness,
    redact: deps.redact,
    agentName: deps.agentName,
    canMutateState: deps.canMutateState,
    isVoiceCallActive: deps.isVoiceCallActive,
    shouldSkipCloudWake: async () => deps.isAssistantCloudCapped() && !deps.isMainModelLocal(),
    queueChat: deps.queueChat,
    resolveWatchedTopic: deps.resolveWatchedTopic,
    resumeIfNotRecovering: deps.resumeIfNotRecovering,
    onItemsChanged: deps.onItemsChanged,
    onTopicsChanged: deps.onTopicsChanged,
    emitNotification: deps.emitNotification,
    recordSelfNotification: (body) => deps.echoSuppressor.recordSelfNotification(body),
  });

  const executePendingAction = async (
    action: AssistantPendingAction,
  ): Promise<{ ok: boolean; preDispatch?: boolean; error?: string }> => {
    if (action.kind === "spark_create_draft") {
      const body = typeof action.params.body === "string" ? action.params.body : "";
      const res = await deps.sparkMail.executeConfirmedDraft(
        {
          ...(typeof action.params.replyToThreadId === "string" ? { replyToThreadId: action.params.replyToThreadId } : {}),
          ...(typeof action.params.to === "string" ? { to: action.params.to } : {}),
          ...(typeof action.params.subject === "string" ? { subject: action.params.subject } : {}),
          body,
        },
        action.envId,
      );
      return {
        ok: res.ok,
        ...(res.preDispatch !== undefined ? { preDispatch: res.preDispatch } : {}),
        ...(res.error ? { error: res.error } : {}),
      };
    }
    if (action.kind === "ha_call_service") {
      const domain = typeof action.params.domain === "string" ? action.params.domain : "";
      const service = typeof action.params.service === "string" ? action.params.service : "";
      const entityId = typeof action.params.entityId === "string" ? action.params.entityId : undefined;
      const serviceData = action.params.serviceData !== undefined ? sanitizeServiceData(action.params.serviceData) : undefined;
      try {
        await deps.homeAssistant.callService({
          domain,
          service,
          ...(entityId ? { entityId } : {}),
          ...(serviceData ? { serviceData } : {}),
          triggerSource: "user_confirmed_l2",
        });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          preDispatch: isHomeAssistantPreDispatchError(error),
          error: error instanceof Error ? error.message : "Home Assistant 服务调用失败。",
        };
      }
    }
    if (action.kind === "ha_upsert_automation") {
      const configId = typeof action.params.configId === "string" ? action.params.configId : "";
      const config = action.params.config && typeof action.params.config === "object" && !Array.isArray(action.params.config)
        ? (action.params.config as Record<string, unknown>)
        : null;
      if (!configId || !config) return { ok: false, preDispatch: true, error: "自动化配置参数缺失。" };
      try {
        await deps.homeAssistant.upsertAutomation({ configId, config });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          preDispatch: isHomeAssistantPreDispatchError(error),
          error: error instanceof Error ? error.message : "写入 Home Assistant 自动化失败。",
        };
      }
    }
    if (action.kind === "ha_delete_automation") {
      const configId = typeof action.params.configId === "string" ? action.params.configId : "";
      if (!configId) return { ok: false, preDispatch: true, error: "缺少待删除的自动化 ID。" };
      try {
        await deps.homeAssistant.deleteAutomation(configId);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          preDispatch: isHomeAssistantPreDispatchError(error),
          error: error instanceof Error ? error.message : "删除 Home Assistant 自动化失败。",
        };
      }
    }
    if (action.kind === "lark_send_reply") {
      const profile = typeof action.params.profile === "string" && action.params.profile.trim()
        ? action.params.profile.trim()
        : "default";
      const text = typeof action.params.text === "string" ? action.params.text : "";
      const res = await deps.larkConnector.executeConfirmedReply({
        ...(typeof action.params.profile === "string" ? { profile: action.params.profile } : {}),
        chatId: typeof action.params.chatId === "string" ? action.params.chatId : "",
        text,
      });
      if (res.ok) {
        const selfSenders = deps.larkConnector.getSelfSenderAliases(profile);
        deps.echoSuppressor.recordOutgoing({ appId: `lark:${profile}`, body: text, selfSenders, requireSenderMatch: true });
        for (const macBundle of ["com.electron.lark", "com.bytedance.feishu", "com.bytedance.lark"]) {
          deps.echoSuppressor.recordOutgoing({ appId: macBundle, body: text });
        }
      }
      return res;
    }
    return { ok: false, preDispatch: true, error: "不支持的待确认动作类型。" };
  };

  const coordinator = new AssistantCoordinator({
    harness: deps.harness,
    ledger: deps.ledger,
    ambientModel: deps.ambientModel,
    agentName: deps.agentName,
    envDisplayName: (envId) => deps.envManager.getEnvDescriptor(envId)?.name,
    isForegroundBusy: deps.isForegroundBusy,
    canMutateState: deps.canMutateState,
    shouldSkipCloudModel: async () => deps.isAssistantCloudCapped() && (await deps.ambientModel.willUseCloudModel(true)),
    redact: deps.redact,
    createDetachedOrchestratorConversation: deps.createDetachedOrchestratorConversation,
    onItemsChanged: deps.onItemsChanged,
    onTopicsChanged: deps.onTopicsChanged,
    onTopicContentChanged: deps.onTopicContentChanged,
    materializeSnapshot: async (snapshotRef, conversationId) => {
      const snap = deps.homeAssistant.sentinel?.readTemporarySnapshot(snapshotRef);
      if (!snap) return undefined;
      const asset = deps.uploads.saveUpload({
        name: snap.fileName,
        mimeType: snap.mimeType,
        bytes: snap.bytes,
        ownerId: "assistant:home-assistant",
        idempotencyKey: `ha-snapshot:${snapshotRef}`,
      });
      deps.uploads.bindAttachments([asset], `conversation:${conversationId}`, "assistant:home-assistant");
      return asset;
    },
    executeProactiveWake: (input) => proactiveWake.executeWake(input),
    onCardAlertNotification: (input) => proactiveWake.emitCardAlertNotification(input),
    onAlertSurfaced: (ev) => {
      const critical = isCriticalSafetyAlert(ev);
      const spokenText = ev.summary.includes(ev.title) ? ev.summary : `${ev.title}：${ev.summary}`;
      void deps.homeAssistant.announce({
        text: spokenText,
        urgency: ev.urgency,
        critical,
        situationId: ev.situationId,
      }).catch(() => {});
    },
    onMutedAppsChanged: (mutedApps) => {
      void deps.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT).then((snap) => {
        deps.envManager.setConnectorConfig({
          driverId: "macos-notifications",
          enabled: Boolean(snap?.enabled),
          mutedApps,
        });
      }).catch(() => {});
    },
    executePendingAction,
  });

  const sorter = new AssistantSorter({
    ledger: deps.ledger,
    ambientModel: deps.ambientModel,
    redact: deps.redact,
    echoSuppressor: deps.echoSuppressor,
    getWatchConfig: async () => {
      const snap = await deps.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT);
      return {
        rules: listEffectiveWatchRules(snap?.watchRules),
        ...(snap?.quietHours ? { quietHours: snap.quietHours } : {}),
      };
    },
    shouldSkipCloudModel: async () => deps.isAssistantCloudCapped() && (await deps.ambientModel.willUseCloudModel(false)),
    isCloudCapped: deps.isAssistantCloudCapped,
    onNotifyBrain: (payload) => coordinator.enqueueEscalation(payload),
  });

  const watchRules: AssistantWatchRuleHost = {
    list: async () => {
      const snap = await deps.harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT);
      return {
        rules: listEffectiveWatchRules(snap?.watchRules),
        ...(snap?.quietHours ? { quietHours: snap.quietHours } : {}),
        mutedApps: snap?.mutedApps ? [...snap.mutedApps] : [],
      };
    },
    create: async (draft) =>
      deps.harness.commit(async (tx) => {
        const doc = await tx.doc(AssistantDoc);
        ensureAssistantState(doc);
        return createWatchRuleInDoc(doc, draft, Date.now());
      }, BACKGROUND_CONTEXT),
    update: async (ruleId, patch) =>
      deps.harness.commit(async (tx) => {
        const doc = await tx.doc(AssistantDoc);
        ensureAssistantState(doc);
        return updateWatchRuleInDoc(doc, ruleId, patch, Date.now());
      }, BACKGROUND_CONTEXT),
    remove: async (ruleId) =>
      deps.harness.commit(async (tx) => {
        const doc = await tx.doc(AssistantDoc);
        ensureAssistantState(doc);
        return deleteWatchRuleInDoc(doc, ruleId);
      }, BACKGROUND_CONTEXT),
    setQuietHours: async (quietHours) =>
      deps.harness.commit(async (tx) => {
        const doc = await tx.doc(AssistantDoc);
        ensureAssistantState(doc);
        return setQuietHoursInDoc(doc, quietHours);
      }, BACKGROUND_CONTEXT),
  };

  return { proactiveWake, coordinator, sorter, watchRules };
}
