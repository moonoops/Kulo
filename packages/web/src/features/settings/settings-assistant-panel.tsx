import { translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Chip } from "@heroui/react";
import { inspectSensitiveText, redactSecrets, redactSensitiveText, type CapabilitiesWorkspaceSnapshot, type ConnectionRecordView, type ConnectionWorkspaceSnapshot, type EnvNodeDescriptor, type KuloSettingsView, type MemoryServiceSnapshot, type SettingsAssistantAction, type SettingsAssistantSnapshot, type SetupInputRequest, type TicketCardView } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { describeLocalizedKuloError } from "../../kulo-error";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { AttachmentLightbox, composerPlaceholder, KuloComposer, UserAttachmentList, type PreviewableImage } from "../../kulo-composer";
import { KuloMarkdown } from "../../kulo-markdown";
import { KuloIcon } from "../../kulo-icon";
import { TaskDispatchCard } from "../../kulo-tasks";
import { ConnectedMessageContent } from "../chat/connected-message-content";
import { useChatAutoScroll } from "../chat/use-chat-autoscroll";
import { cardAdjustmentDraft } from "../genui/card-value-summary";
import type { SettingsModuleId } from "./settings-helpers";
import { getSettingsAssistantShortcuts, settingsAssistantGreeting, type SettingsAssistantShortcut } from "./settings-assistant-actions";
import { AppearanceCustomizationCard } from "./appearance-customization-card";
import { ModelConfigurationCard, readModelSaveEnvelope } from "./model-configuration-card";
import { modelConfigurationApi } from "./model-configuration-api";
import { MessageMotion, StreamingMessage } from "../chat/message-motion";
import "./settings-assistant-initial-state.css";
import type { SettingsAssistantControls } from "./use-settings-assistant";
import type { CapabilityView, ImageAssistantRequest } from "./capability-views";
import { CapabilitySetupInputs, visibleSetupInputs } from "./capability-setup-inputs";
import { MemoryServiceDialogue } from "./memory-service-dialogue";
import { MEMORY_ASSISTANT_PREFILL_EVENT, takeMemoryAssistantPrefill } from "./memory-service-events";
import { ConnectionSetupInputs } from "./connection-setup-inputs";
import type { ConnectionPrepare } from "./connections-module";
import { ConnectionFollowup } from "./connection-followup";
import { ConnectionIcon } from "./connection-icon";
import { KuloThinkingIndicator } from "../chat/thinking-indicator";
import { SettingsAssistantHistory } from "./settings-assistant-history";
import { createImageDraftConfig, imageConfigFromCapability, ImageCapabilityEditor } from "./image-capability-editor";
import { ImageProviderPicker } from "./image-provider-picker";
import { ImageRoutingEditor } from "./image-routing-editor";
import { ExternalAgentConnectCard } from "./external-agent-connect-card";

type LocalInfo = { title: string; text: string; error?: boolean; scope?: SettingsModuleId };
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const UPLOAD_MENU_KINDS = ["image", "file"] as const;
const noop = () => {};
const appearanceName = (mode: string) => mode === "system" ? t("跟随系统", "System") : mode === "light" ? t("浅色", "Light") : t("深色", "Dark");
type ImageShortcutAction = Extract<SettingsAssistantShortcut, { kind: "image" }>["action"];
type ImagePanel = "draft" | "discovery" | "routing";

export function SettingsAssistantPanel({
  module, agentName, settings, envs, tickets = [], onProjectTicket, onSettingsUpdated, snapshot, loaded, connected, error, controls, capabilityInputs = [], capabilityView, capabilitiesWorkspace, imageRequest, onImageRequestHandled, onCapabilityInputsChanged,
  connections, connectionPreparing = false, onConnectionPrepare, onConnectionsRefresh, memoryServiceSnapshot,
}: {
  module: SettingsModuleId;
  agentName: string;
  settings: KuloSettingsView | null;
  envs: EnvNodeDescriptor[];
  tickets?: TicketCardView[];
  onProjectTicket?: (ticketId: string, title?: string) => void;
  onSettingsUpdated?: (next: KuloSettingsView) => void;
  snapshot: SettingsAssistantSnapshot;
  loaded: boolean;
  connected: boolean;
  error: string | null;
  controls: SettingsAssistantControls;
  capabilityInputs?: SetupInputRequest[];
  capabilityView?: CapabilityView;
  capabilitiesWorkspace?: CapabilitiesWorkspaceSnapshot | null;
  imageRequest?: ImageAssistantRequest;
  onImageRequestHandled?: (id: ImageAssistantRequest["id"]) => void;
  onCapabilityInputsChanged?: () => void;
  connections?: ConnectionWorkspaceSnapshot | null;
  connectionPreparing?: boolean;
  onConnectionPrepare?: ConnectionPrepare;
  onConnectionsRefresh?: () => void;
  memoryServiceSnapshot?: MemoryServiceSnapshot | null;
}) {
  useI18n();
  const [localInfo, setLocalInfo] = useState<LocalInfo | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewableImage | null>(null);
  const [selectedConfirmation, setConfirmation] = useState<SettingsAssistantAction | null>(null);
  const confirmation = snapshot.actions.find((action) => action.id === selectedConfirmation?.id) ?? selectedConfirmation;
  const [applicationPicker, setApplicationPicker] = useState(false);
  const [connectionFollowup, setConnectionFollowup] = useState<ConnectionRecordView | null>(null);
  const [modelAction, setModelAction] = useState<"connect" | "calibrate" | "diagnose" | null>(null);
  const [agentPanel, setAgentPanel] = useState<"client" | "personal" | null>(null);
  const [modelRefresh, setModelRefresh] = useState(0);
  const [modelHasDraft, setModelHasDraft] = useState(false);
  const [modelDraftKey, setModelDraftKey] = useState("");
  const [modelPendingSaveKey, setModelPendingSaveKey] = useState(() => readModelSaveEnvelope(controls.clientId)?.commandId ?? "");
  const [dismissedModelDraft, setDismissedModelDraft] = useState<string | null>(null);
  const [imageSelection, setImageSelection] = useState<{ key: string; panel: ImagePanel | null } | null>(null);
  const [imagePreparing, setImagePreparing] = useState<ImageShortcutAction | null>(null);
  const [imageError, setImageError] = useState<{ action: ImageShortcutAction; capabilityId?: string; message: string } | null>(null);
  const consumedImageRequest = useRef<string | undefined>(undefined);
  const setupCompletion = controls.setupCompletion;
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageCardRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);
  const imageAnchorActiveRef = useRef(false);
  const messageEntries = useRef({ topicId: snapshot.topicId, ready: loaded, ids: new Set(snapshot.messages.map((message) => message.id)) });
  const previousInfoTopic = useRef(snapshot.topicId);
  const previousStreaming = useRef(false);
  const animateMessages = new Set<number>();
  if (loaded && messageEntries.current.ready && messageEntries.current.topicId === snapshot.topicId) {
    for (const message of snapshot.messages) if (!messageEntries.current.ids.has(message.id) && !(message.role === "assistant" && previousStreaming.current)) animateMessages.add(message.id);
  }
  useIsomorphicLayoutEffect(() => {
    messageEntries.current = { topicId: snapshot.topicId, ready: loaded, ids: new Set(snapshot.messages.map((message) => message.id)) };
    previousStreaming.current = Boolean(snapshot.live.busy && snapshot.live.streamingText);
  }, [snapshot.topicId, loaded, snapshot.messages, snapshot.live.busy, snapshot.live.streamingText]);
  const hasModel = Boolean(settings?.blocks.model.value.defaultModel.trim());
  const hasConversation = snapshot.messages.length > 0 || snapshot.actions.length > 0 || snapshot.live.busy;
  const modelRecoveryKey = modelPendingSaveKey ? `save:${modelPendingSaveKey}` : modelDraftKey;
  const showModelCard = module === "models" && (modelAction !== null || (modelHasDraft || Boolean(modelPendingSaveKey)) && dismissedModelDraft !== modelRecoveryKey);
  const conversationChangeDisabled = !connected || !loaded || controls.sending || controls.switchingConversation || snapshot.live.busy || controls.unconfirmedSend || controls.pendingActionId !== null;
  const shortcuts = getSettingsAssistantShortcuts(module, hasModel, controls.appearance, capabilityView);
  const imageView = module === "capabilities" && (capabilityView ?? "image") === "image";
  const imageDraft = capabilitiesWorkspace?.imageSetup?.draft?.clientId === controls.clientId ? capabilitiesWorkspace.imageSetup.draft : undefined;
  const imageDiscovery = capabilitiesWorkspace?.imageSetup?.discovery?.clientId === controls.clientId ? capabilitiesWorkspace.imageSetup.discovery : undefined;
  const imageKey = `${imageDraft?.id ?? ""}:${imageDiscovery?.id ?? ""}`;
  const automaticImagePanel: ImagePanel | null = imageDraft && (!imageDiscovery || imageDraft.updatedAt >= imageDiscovery.createdAt) ? "draft" : imageDiscovery ? "discovery" : null;
  const imagePanel = imageSelection?.key === imageKey ? imageSelection.panel : automaticImagePanel;
  const imageDisabled = !connected || controls.switchingConversation || imagePreparing !== null || snapshot.live.busy || controls.sending || controls.unconfirmedSend;
  const lastUser = [...snapshot.messages].reverse().find((item) => item.role === "user");
  const activeConnectionInput = connections?.inputs.find((input) => input.clientId === controls.clientId && input.status === "pending");
  const pendingConnectionInput = activeConnectionInput?.id;
  const nativeConnectionInput = connections?.applications?.some((application) => application.id === activeConnectionInput?.appId && application.authentication === "macos") ? pendingConnectionInput : undefined;
  const hasVisibleSetupInputs = module === "capabilities" && visibleSetupInputs(capabilityInputs, controls.clientId, controls.target).length > 0;
  const hasScrollContent = hasConversation
    || showModelCard
    || (imageView && (imagePanel !== null || imagePreparing !== null || imageError !== null))
    || (module === "workers" && agentPanel !== null)
    || Boolean(controls.localAppearance)
    || Boolean(localInfo && (!localInfo.scope || localInfo.scope === module))
    || (module === "connections" && (Boolean(activeConnectionInput) || applicationPicker || connectionFollowup !== null))
    || (module === "capabilities" && (hasVisibleSetupInputs || setupCompletion !== null));
  const runFailure = !snapshot.live.busy && snapshot.live.runFailure
    ? describeLocalizedKuloError({
      reason: snapshot.live.runFailure.reason,
      detail: snapshot.live.runFailure.detail,
      modelId: settings?.blocks.model.value.defaultModel,
    })
    : null;
  const failure = runFailure?.isUserAbort ? null : runFailure;
  const safeError = error ? redactSecrets(error) : null;
  const remainingActions = new Map(snapshot.actions.map((action) => [action.id, action]));
  const timeline = snapshot.messages.map((message) => {
    const actions: SettingsAssistantAction[] = [];
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        const action = remainingActions.get(call.id);
        if (action) {
          actions.push(action);
          remainingActions.delete(call.id);
        }
      }
    }
    return { message, actions };
  });

  useChatAutoScroll(
    { scrollRef, nearBottomRef },
    [snapshot.messages, snapshot.actions, snapshot.live.streamingText, snapshot.live.busy, Boolean(snapshot.live.streamingThinking), snapshot.live.activeTools.length, localInfo, controls.localAppearance, capabilityInputs, controls.target, setupCompletion, connections?.inputs, applicationPicker, connectionFollowup, imageKey, imagePanel, imagePreparing, imageError, agentPanel],
  );

  useIsomorphicLayoutEffect(() => {
    const scroll = scrollRef.current; const card = imageCardRef.current;
    if (!imageView || !imagePanel || imagePreparing || !scroll || !card) return;
    scroll.scrollTop += card.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    nearBottomRef.current = false;
    imageAnchorActiveRef.current = true;
  }, [imageView, imageKey, imagePanel, imagePreparing]);

  useEffect(() => {
    if (!controls.focusRequest || nativeConnectionInput) return;
    const timer = setTimeout(() => {
      const input = composerRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
    return () => clearTimeout(timer);
  }, [controls.focusRequest, nativeConnectionInput]);

  const setDraftRef = useRef(controls.setDraft);
  setDraftRef.current = controls.setDraft;
  useEffect(() => {
    if (module !== "identity") return;
    const receive = () => {
      const draft = takeMemoryAssistantPrefill();
      if (draft === null) return;
      setDraftRef.current(draft);
      requestAnimationFrame(() => {
        const input = composerRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(draft.length, draft.length);
      });
    };
    window.addEventListener(MEMORY_ASSISTANT_PREFILL_EVENT, receive);
    receive();
    return () => window.removeEventListener(MEMORY_ASSISTANT_PREFILL_EVENT, receive);
  }, [module]);

  useEffect(() => {
    if (pendingConnectionInput) { setApplicationPicker(false); setConnectionFollowup(null); setLocalInfo(null); }
  }, [pendingConnectionInput]);

  useEffect(() => { setImageError((current) => current?.capabilityId ? current : null); }, [imageKey]);

  useEffect(() => {
    setModelPendingSaveKey(readModelSaveEnvelope(controls.clientId)?.commandId ?? "");
    if (module !== "models" || !connected) { setModelHasDraft(false); return; }
    const controller = new AbortController();
    void modelConfigurationApi.workspace(controls.clientId, controller.signal).then((workspace) => {
      if (!controller.signal.aborted) {
        const list = workspace.drafts ?? (workspace.draft ? [workspace.draft] : []);
        setModelHasDraft(list.length > 0);
        setModelDraftKey(list.map((item) => `${item.id}:${item.revision}`).join(","));
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLocalInfo({ title: t("模型草稿未加载", "Model draft did not load"), text: redactSensitiveText(cause instanceof Error ? cause.message : String(cause)), error: true });
    });
    return () => controller.abort();
  }, [module, connected, controls.clientId, snapshot.messages.length, snapshot.live.busy, modelRefresh]);

  useEffect(() => {
    const previousTopic = previousInfoTopic.current;
    previousInfoTopic.current = snapshot.topicId;
    setLocalInfo((current) => previousTopic === null && current?.scope === "workers" ? current : null);
    setPreviewImage(null);
    setConfirmation(null);
    setApplicationPicker(false);
    setConnectionFollowup(null);
    setModelAction(null);
    setAgentPanel(null);
    setDismissedModelDraft(null);
    setImageSelection(null);
    setImageError(null);
    nearBottomRef.current = true;
  }, [snapshot.topicId]);

  useEffect(() => {
    if (module !== "workers") setAgentPanel(null);
  }, [module]);

  const closeImagePanel = () => {
    setImageSelection({ key: imageKey, panel: null });
    composerRef.current?.focus();
  };

  const prepareImage = async (action: ImageShortcutAction, capabilityId?: string) => {
    if (imageDisabled || !capabilitiesWorkspace) return;
    if (!capabilityId) controls.clearTarget?.();
    setImageError(null);
    if (action === "routing") {
      setImageSelection({ key: imageKey, panel: "routing" });
      return;
    }
    setImagePreparing(action);
    try {
      if (action === "discover") {
        const discovery = await kuloRest.discoverImageModels(controls.clientId);
        setImageSelection({ key: `${imageDraft?.id ?? ""}:${discovery.id}`, panel: "discovery" });
      } else {
        const capability = capabilityId ? capabilitiesWorkspace.capabilities.find((item) => item.id === capabilityId && item.kind === "image") : undefined;
        if (capabilityId && !capability) throw new Error(t("未找到图像模型，请刷新后重试。", "Image model not found. Refresh and try again."));
        if (capability && imageDraft && imageDraft.config.id !== capability.id) {
          setImageSelection({ key: imageKey, panel: "draft" });
          throw new Error(t("先保存或取消当前图像配置，再编辑其他模型。", "Save or cancel the current image configuration before editing another model."));
        }
        const draft = imageDraft ?? await kuloRest.updateImageDraft({ clientId: controls.clientId, config: capability ? imageConfigFromCapability(capabilitiesWorkspace, capability) : createImageDraftConfig(capabilitiesWorkspace) });
        setImageSelection({ key: `${draft.id}:${imageDiscovery?.id ?? ""}`, panel: "draft" });
      }
      onCapabilityInputsChanged?.();
    } catch (cause) {
      setImageError({ action, capabilityId, message: redactSensitiveText(cause instanceof Error ? cause.message : t("未能打开图像配置", "Unable to open image setup")) });
    } finally { setImagePreparing(null); }
  };

  useEffect(function consumeImageRequest() {
    if (!imageRequest || !imageView || imageDisabled || !capabilitiesWorkspace) return;
    const key = `${controls.clientId}:${imageRequest.id}`;
    if (consumedImageRequest.current === key) return;
    consumedImageRequest.current = key;
    onImageRequestHandled?.(imageRequest.id);
    nearBottomRef.current = true;
    void prepareImage(imageRequest.action, imageRequest.capabilityId);
  }, [imageRequest?.id, imageRequest?.action, imageRequest?.capabilityId, imageView, imageDisabled, capabilitiesWorkspace, controls.clientId, onImageRequestHandled]);

  const handleShortcut = async (shortcut: SettingsAssistantShortcut) => {
    nearBottomRef.current = true;
    switch (shortcut.kind) {
      case "agent":
        setLocalInfo(null);
        setAgentPanel(shortcut.action);
        break;
      case "model":
        setDismissedModelDraft(null);
        if (shortcut.action === "connect" || shortcut.action === "diagnose" || !hasModel) {
          setModelAction(shortcut.action);
        } else if (shortcut.prompt) {
          await controls.send(shortcut.prompt);
        }
        break;
      case "image":
        await prepareImage(shortcut.action);
        break;
      case "connection":
        if (shortcut.category === "app") { setApplicationPicker(true); setLocalInfo(null); break; }
        setApplicationPicker(false); setConnectionFollowup(null);
        try { await onConnectionPrepare?.({ category: shortcut.category, kind: shortcut.category === "information" ? "custom" : "account" }); }
        catch (cause) { setLocalInfo({ title: t("未打开连接表单", "Connection form did not open"), text: redactSensitiveText(cause instanceof Error ? cause.message : t("打开连接表单失败", "Failed to open connection form")), error: true }); }
        break;
      case "prefill":
        controls.setDraft(shortcut.draft);
        requestAnimationFrame(() => {
          const input = composerRef.current;
          if (!input) return;
          input.focus();
          input.setSelectionRange(shortcut.draft.length, shortcut.draft.length);
        });
        break;
      case "ask":
        if (module === "capabilities") controls.clearTarget?.();
        await controls.send(shortcut.prompt, module === "capabilities" ? null : undefined);
        break;
      case "navigate":
        try {
          await controls.navigate({ id: `shortcut-${Date.now()}`, module: shortcut.module, intent: shortcut.intent });
        } catch (err) { setLocalInfo({ title: t("未打开设置", "Settings did not open"), text: err instanceof Error ? err.message : t("打开设置失败", "Failed to open settings"), error: true }); }
        break;
      case "appearance": controls.changeAppearance(shortcut.appearance); break;
      case "info":
        if (shortcut.info === "connections") {
          setLocalInfo({ title: t("接入方式", "Connection methods"), text: t("API 连接：使用供应商或兼容服务的 API Key。\n\n订阅登录：使用列表中支持的订阅账号授权。", "API connection: use an API key from a provider or compatible service.\n\nSubscription sign-in: authorize a supported subscription account from the list.") });
        } else if (shortcut.info === "workers") {
          const roles = settings ? Object.values(settings.blocks.roles.value).filter((role) => role.enabled !== false) : [];
          setLocalInfo({ title: t("当前智能体", "Current agents"), text: settings ? t(`并发上限：${settings.blocks.executor.value.maxConcurrentWorkers}\n\n${roles.map((role) => `- ${role.label}：${role.modelId || "跟随默认模型"}`).join("\n") || "暂无启用的智能体。"}`, `Concurrency limit: ${settings.blocks.executor.value.maxConcurrentWorkers}\n\n${roles.map((role) => `- ${role.label}: ${role.modelId || "Use default model"}`).join("\n") || "No agents enabled."}`) : t("当前与中枢连接已断开。", "Disconnected from the hub.") });
        } else {
          setLocalInfo({ title: t("设备状态", "Device status"), text: envs.map((env) => t(`- ${env.name}：${env.online ? "在线" : "离线"}`, `- ${env.name}: ${env.online ? "Online" : "Offline"}`)).join("\n") || t("暂无已连接的设备。", "No devices connected.") });
        }
        break;
    }
  };

  const shortcutButtons = () => (
    <div className="kulo-settings-assistant-suggestions" aria-label={imageView ? t("图像配置", "Image configuration") : t("可以交给 Kulo 的任务", "Tasks for Kulo")}>
      {shortcuts.map((shortcut) => {
        const directModel = shortcut.kind === "model" && (shortcut.action === "connect" || shortcut.action === "diagnose" || !hasModel);
        const disabled = controls.switchingConversation || (
          shortcut.kind === "image" ? imageDisabled || !capabilitiesWorkspace
            : shortcut.kind === "connection" ? !connected || connectionPreparing
              : shortcut.kind === "agent" ? !connected
                : shortcut.kind === "prefill" ? !connected || !hasModel || !loaded
                  : directModel ? !connected
                    : (shortcut.kind === "ask" || shortcut.kind === "model") && (!connected || controls.sending || snapshot.live.busy || controls.unconfirmedSend || !hasModel || !loaded)
        );
        return (
          <Button
            key={shortcut.id}
            variant="secondary"
            size="sm"
            className="kulo-settings-assistant-suggestion"
            isPending={shortcut.kind === "image" && imagePreparing === shortcut.action}
            isDisabled={disabled}
            onPress={() => void handleShortcut(shortcut)}
          >
            {shortcut.label}
          </Button>
        );
      })}
    </div>
  );

  const decide = async (action: SettingsAssistantAction, decision: "confirm" | "reject" | "undo") => {
    if (await controls.decide(action, decision)) setConfirmation(null);
  };

  const continueSetup = async (request: SetupInputRequest) => {
    await controls.sendSetupCompletion?.(request);
  };

  const renderAction = (action: SettingsAssistantAction) => action.kind === "appearance-customization" && action.customization ? (
    <AppearanceCustomizationCard key={action.id} proposal={action.customization} expectedCurrent={action.previousCustomization ?? null}
      historical={Boolean(action.historical || ["rejected", "undone", "failed"].includes(action.status))}
      applied={action.status === "applied"} disabled={!connected || controls.pendingActionId !== null || action.clientId !== controls.clientId}
      onApply={() => controls.decide(action, "client-applied")}
      onCancel={() => controls.decide(action, "reject")}
      onUndo={action.canUndo ? () => controls.decide(action, "undo") : undefined} />
  ) : (
    <Card key={action.id} variant="secondary" className="gap-2 rounded-2xl p-3" aria-label={action.title}>
      <Card.Header className="gap-1">
        <div className="flex items-start justify-between gap-2">
          <Card.Title className="text-sm font-medium">{action.title}</Card.Title>
          <Chip size="sm" variant="soft" className="shrink-0 text-xs">
            {action.historical ? t("历史记录", "Historical record") : action.status === "pending" ? action.requiresConfirmation ? t("待确认", "Awaiting confirmation") : t("待应用", "Awaiting application") : action.status === "submitted" ? t("已提交", "Submitted") : action.status === "applied" ? t("已完成", "Completed") : action.status === "undone" ? t("已撤销", "Undone") : action.status === "rejected" ? t("已取消", "Cancelled") : t("未完成", "Incomplete")}
          </Chip>
        </div>
        {action.description && <Card.Description className="text-xs">{action.description}</Card.Description>}
      </Card.Header>
      {action.changes.length > 0 && <Card.Content className="space-y-1 text-xs text-muted">{action.changes.map((change, index) => <p key={index}>{change}</p>)}</Card.Content>}
      {action.error && <Card.Content role="alert" className="break-words text-xs text-danger">{redactSecrets(action.error)}</Card.Content>}
      {!action.historical && <Card.Footer className="justify-end gap-2">
        {action.status === "pending" && action.requiresConfirmation && <>
          <Button size="sm" variant="tertiary" isDisabled={!connected || controls.pendingActionId !== null} onPress={() => void decide(action, "reject")}>{t("取消", "Cancel")}</Button>
          <Button size="sm" variant="secondary" isDisabled={!connected || controls.pendingActionId !== null} onPress={() => setConfirmation(action)}>{t("查看并确认", "Review and confirm")}</Button>
        </>}
        {action.status === "pending" && !action.requiresConfirmation && action.clientId !== controls.clientId && <span className="text-xs text-muted">{t("等待原窗口应用", "Awaiting application in the original window")}</span>}
        {action.status === "submitted" && action.clientOperation === "leave-device" && action.clientId === controls.clientId && !controls.pendingActionId && <Button size="sm" variant="secondary" isDisabled={!connected} onPress={() => setConfirmation(action)}>{t("继续断开连接", "Continue disconnecting")}</Button>}
        {action.status === "applied" && action.canUndo && <Button size="sm" variant="ghost" isPending={controls.pendingActionId === action.id} isDisabled={!connected || controls.pendingActionId !== null || (action.kind === "appearance" && action.clientId !== controls.clientId)} onPress={() => void decide(action, "undo")}>{t("撤销", "Undo")}</Button>}
      </Card.Footer>}
    </Card>
  );

  return (
    <section className="kulo-settings-assistant" aria-label={t("设置对话", "Settings conversation")} data-conversation-ready={loaded || undefined}>
      {module === "identity" && settings && (
        <MemoryServiceDialogue
          className="kulo-settings-assistant-pinned"
          clientId={controls.clientId}
          settings={settings}
          connected={connected}
          initialSnapshot={memoryServiceSnapshot}
          refreshKey={`${settings.blocks.memory.revision}:${snapshot.live.busy}:${snapshot.actions.length}:${snapshot.messages.length}`}
        />
      )}
      <div ref={scrollRef} className="kulo-settings-assistant-scroll" onScroll={() => {
        if (imageAnchorActiveRef.current) { imageAnchorActiveRef.current = false; return; }
        const el = scrollRef.current;
        if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      }}>
        {!hasConversation && !showModelCard && !(imageView && imagePanel) && !(module === "workers" && agentPanel !== null) && (
          <div className="kulo-settings-assistant-intro">
            <p className="kulo-section-title">{settingsAssistantGreeting()}</p>
            {!hasModel && <p className="text-sm">{t("先连接一个模型，即可开始对话。", "Connect a model to start a conversation.")}</p>}
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-3" role="log" aria-label={t("设置对话消息", "Settings conversation messages")} aria-relevant="additions text">
          {[...remainingActions.values()].map(renderAction)}
          {showModelCard && <ModelConfigurationCard clientId={controls.clientId} connected={connected} hasDefaultModel={hasModel}
            disabled={controls.switchingConversation || snapshot.live.busy || controls.sending || controls.unconfirmedSend}
            initialAction={modelAction ?? "calibrate"} refreshKey={`${snapshot.messages.length}:${snapshot.live.busy}:${modelRefresh}`}
            onChanged={() => { setModelRefresh((value) => value + 1); }} onClose={() => { setModelAction(null); setDismissedModelDraft(modelRecoveryKey); }} />}
          {timeline.map(({ message, actions }) => {
            const hasBody = message.role === "user"
              || (message.role === "dispatch" && Boolean(message.dispatch))
              || (message.role !== "relay" && (Boolean(message.parts?.length || message.attachments?.length) || Boolean(message.text.trim())));
            if (!hasBody && actions.length === 0) return null;
            return (
              <MessageMotion key={message.id} scopeKey={snapshot.topicId ?? "settings"} animateEntry={animateMessages.has(message.id)}>
                {message.role === "user" ? (
                  <div className="flex justify-end">
                    <div className={`mc-user-message min-w-0 max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-default px-3.5 py-2 text-default-foreground${message.attachments?.length ? " w-full" : ""}`}>
                      <UserAttachmentList attachments={message.attachments} onPreviewImage={setPreviewImage} />
                      {redactSensitiveText(message.text, [], { definiteOnly: !inspectSensitiveText(message.text).saveRequested })}
                    </div>
                  </div>
                ) : message.role === "relay" ? null : message.role === "dispatch" && message.dispatch ? (
                  <TaskDispatchCard
                    dispatch={message.dispatch}
                    liveTicket={tickets.find((item) => item.id === message.dispatch!.ticketId)}
                    onProject={onProjectTicket ?? noop}
                  />
                ) : message.parts?.length || message.attachments?.length ? (
                  <article className="min-w-0">
                    <ConnectedMessageContent
                      item={message}
                      connected={connected}
                      conversationKey={snapshot.topicId ?? "settings"}
                      onPreviewImage={setPreviewImage}
                      contentOnly
                      onAdjust={(card, values) => {
                        controls.setDraft(cardAdjustmentDraft(card, values));
                        requestAnimationFrame(() => composerRef.current?.focus());
                      }}
                    />
                  </article>
                ) : message.text.trim() ? (
                  <article className={message.role === "system_note" ? "text-xs text-muted" : "min-w-0"}>
                    <KuloMarkdown text={message.text} />
                  </article>
                ) : null}
                {actions.map(renderAction)}
              </MessageMotion>
            );
          })}
          {snapshot.live.busy && (snapshot.live.streamingText ? <StreamingMessage text={snapshot.live.streamingText} /> : (
            <div className="flex items-center gap-2 py-1 text-xs text-muted"><KuloThinkingIndicator aria-label={t("设置助手思考中", "Settings assistant is thinking")} />{snapshot.live.retrying ? t("正在重试…", "Retrying…") : t("思考中…", "Thinking…")}</div>
          ))}
          {controls.localAppearance && <Card variant="secondary" className="flex-row items-center justify-between gap-2 rounded-2xl p-3"><Card.Content className="text-sm">{t("已切换为", "Switched to ")}{appearanceName(controls.localAppearance.appearance)}</Card.Content><Card.Footer><Button size="sm" variant="ghost" onPress={controls.undoLocalAppearance}>{t("撤销", "Undo")}</Button></Card.Footer></Card>}
          {localInfo && (!localInfo.scope || localInfo.scope === module) && <Card variant="secondary" className="gap-2 rounded-2xl p-3" aria-label={localInfo.title}><Card.Content className={localInfo.error ? "text-sm text-danger" : "text-sm"}><KuloMarkdown text={localInfo.text} /></Card.Content></Card>}
          {module === "workers" && agentPanel !== null && (
            <ExternalAgentConnectCard
              key={`${controls.clientId}:${agentPanel}`}
              mode={agentPanel}
              clientId={controls.clientId}
              connected={connected}
              disabled={controls.switchingConversation}
              envs={envs}
              onConnected={(result) => onSettingsUpdated?.(result.settings)}
              onClose={() => { setAgentPanel(null); composerRef.current?.focus(); }}
            />
          )}
          {module === "connections" && connections && <ConnectionSetupInputs inputs={connections.inputs} connections={connections.connections} clientId={controls.clientId} connected={connected} available={connections.vault.available} localHost={connections.localHost} canManageHub={connections.canManageHub} onChanged={() => {
            onConnectionsRefresh?.();
          }} applications={connections.applications} onCancelled={() => requestAnimationFrame(() => composerRef.current?.focus())} onCompleted={(connection) => {
            setApplicationPicker(false);
            if (connection.kind === "ssh") { setLocalInfo(null); setConnectionFollowup(connection); }
            else if (connection.kind === "mcp" && connection.mcpTransport === "http" && connection.mcpAuthMode === "oauth" && !connection.mcpOAuthAuthorized) {
              setConnectionFollowup(null);
              setLocalInfo({ title: t("连接已保存", "Connection saved"), text: t(`「${connection.name}」已保存，请在左侧点击「授权登录」完成授权。`, `“${connection.name}” saved. Click Sign in on the left to authorize.`) });
              requestAnimationFrame(() => composerRef.current?.focus());
            } else { setConnectionFollowup(null); setLocalInfo({ title: t("连接已保存", "Connection saved"), text: t(`「${connection.name}」${(connection.kind === "app" || connection.kind === "mcp") && connection.status === "verified" ? "已连接" : "已保存"}。`, `“${connection.name}” ${(connection.kind === "app" || connection.kind === "mcp") && connection.status === "verified" ? "connected" : "saved"}.`) }); requestAnimationFrame(() => composerRef.current?.focus()); }
          }} />}
          {module === "connections" && applicationPicker && <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-3" aria-label={t("选择预置应用", "Choose a built-in app")}><Card.Header><Card.Title className="text-sm">{t("连接预置应用", "Connect built-in app")}</Card.Title></Card.Header><Card.Content className="flex flex-col gap-2">{connections?.applications?.map((application) => <Button key={application.id} variant="ghost" className="h-auto justify-start gap-3 p-2" isDisabled={!connected || connectionPreparing || application.status === "unavailable" || !connections.vault.available && application.authentication !== "macos"} onPress={() => {
            void onConnectionPrepare?.({ category: "app", appId: application.id, ...(application.connectionId ? { connectionId: application.connectionId } : {}) }).then(() => { setApplicationPicker(false); setConnectionFollowup(null); }).catch((cause) => setLocalInfo({ title: t("未打开连接表单", "Connection form did not open"), text: redactSensitiveText(cause instanceof Error ? cause.message : t("打开连接表单失败", "Failed to open connection form")), error: true }));
          }}><ConnectionIcon appId={application.id} /><span className="text-sm">{application.name}</span></Button>)}</Card.Content><Card.Footer className="justify-end"><Button size="sm" variant="tertiary" onPress={() => { setApplicationPicker(false); composerRef.current?.focus(); }}>{t("取消", "Cancel")}</Button></Card.Footer></Card>}
          {module === "connections" && connectionFollowup && <ConnectionFollowup key={`${connectionFollowup.id}:${connectionFollowup.revision}`} connection={connectionFollowup} connected={connected} available={connections?.vault.available ?? false} localHost={connections?.localHost} onChanged={() => onConnectionsRefresh?.()} onClose={() => { setConnectionFollowup(null); composerRef.current?.focus(); }} />}
          {imageView && imagePreparing && <Card variant="secondary" className="gap-2 rounded-2xl p-3">
            <Card.Content role="status" className="text-sm">{imagePreparing === "discover" ? t("正在读取供应商图像模型…", "Loading provider image models…") : t("正在打开图像配置…", "Opening image setup…")}</Card.Content>
          </Card>}
          {imageView && imageError && <Alert status="danger">
            <Alert.Content><Alert.Title>{t("图像配置未完成", "Image setup incomplete")}</Alert.Title><Alert.Description>{imageError.message}</Alert.Description></Alert.Content>
            <Button size="sm" variant="secondary" isDisabled={imageDisabled || !capabilitiesWorkspace} onPress={() => void prepareImage(imageError.action, imageError.capabilityId)}>{t("重试", "Retry")}</Button>
          </Alert>}
          {imageView && capabilitiesWorkspace && !imagePreparing && imagePanel !== null && <div ref={imageCardRef} role="group" aria-label={t("图像配置交互", "Image setup controls")} className="flex min-w-0 flex-col gap-3">
            {imagePanel === "discovery" && imageDiscovery && <ImageProviderPicker key={controls.clientId} workspace={capabilitiesWorkspace} clientId={controls.clientId} connected={connected} disabled={imageDisabled} onChanged={onCapabilityInputsChanged ?? noop} onClose={closeImagePanel} />}
            {imagePanel === "draft" && imageDraft && <ImageCapabilityEditor key={controls.clientId} workspace={capabilitiesWorkspace} clientId={controls.clientId} connected={connected} disabled={imageDisabled} onChanged={onCapabilityInputsChanged ?? noop} onClose={closeImagePanel} />}
            {imagePanel === "routing" && <ImageRoutingEditor key={controls.clientId} workspace={capabilitiesWorkspace} clientId={controls.clientId} connected={connected} disabled={imageDisabled} onChanged={onCapabilityInputsChanged ?? noop} onClose={closeImagePanel} />}
          </div>}
          {module === "capabilities" && <CapabilitySetupInputs inputs={capabilityInputs} clientId={controls.clientId} target={controls.target} envs={envs} connected={connected} onChanged={onCapabilityInputsChanged ?? noop} onCompleted={(request) => {
            const capability = capabilitiesWorkspace?.capabilities.find((item) => item.id === request.capabilityId);
            if (request.kind === "browser" && capability?.allowTaskGeneration) {
              setLocalInfo({ title: t("Google Flow 已连接", "Google Flow connected"), text: t("Google Flow 已就绪。", "Google Flow is ready."), scope: "capabilities" });
              return;
            }
            void continueSetup(request);
          }} />}
          {module === "capabilities" && setupCompletion && <Card variant="secondary" className="gap-2 rounded-2xl p-3" aria-label={t("继续能力配置", "Continue capability setup")}>
            <Card.Content className="text-sm">{setupCompletion.request.kind === "secret" ? t("密钥已保存", "API key saved") : t("Flow 标签页已连接", "Flow tab connected")}</Card.Content>
            {setupCompletion.error && <Card.Content role="alert" className="text-xs text-danger">{setupCompletion.error}</Card.Content>}
            <Card.Footer className="justify-end"><Button size="sm" variant="secondary" isPending={setupCompletion.sending} isDisabled={!connected || setupCompletion.sending || snapshot.live.busy || controls.sending || controls.unconfirmedSend} onPress={() => void continueSetup(setupCompletion.request)}>{t("继续配置", "Continue setup")}</Button></Card.Footer>
          </Card>}
        </div>
      </div>

      <div className="kulo-settings-assistant-footer flex shrink-0 flex-col gap-3" data-separated={hasScrollContent || undefined}>
        {(safeError || failure || !connected) && <Alert status={connected ? "danger" : "warning"} className="flex flex-col gap-2 rounded-2xl p-3">
          <Alert.Content className="flex flex-col gap-1 break-words text-xs">
            {safeError || !connected ? safeError || t("与中枢连接已断开，草稿已保留。", "Disconnected from the hub. Your draft is preserved.") : failure && <>
              <Alert.Title className="font-semibold">{failure.title}</Alert.Title>
              <Alert.Description className="text-xs">{failure.hint}</Alert.Description>
            </>}
          </Alert.Content>
          <div className="flex flex-wrap gap-1.5">
            {controls.unconfirmedSend && <Button size="sm" variant="secondary" isDisabled={!connected || controls.sending} onPress={() => void controls.retrySend()}>{t("重试确认", "Retry confirmation")}</Button>}
            {!loaded && connected && <Button size="sm" variant="secondary" onPress={() => void controls.subscribe()}>{t("重新加载", "Reload")}</Button>}
            {failure && lastUser && <Button size="sm" variant="secondary" onPress={() => { controls.restoreInput(lastUser); composerRef.current?.focus(); }}>{t("恢复上次输入", "Restore previous input")}</Button>}
            {failure?.suggestModelSettings && <Button size="sm" variant="ghost" onPress={() => { void controls.navigate({ id: `repair-${Date.now()}`, module: "models" }).catch((err) => setLocalInfo({ title: t("未打开设置", "Settings did not open"), text: err instanceof Error ? err.message : t("打开设置失败", "Failed to open settings"), error: true })); }}>{t("模型", "Models")}</Button>}
          </div>
        </Alert>}
        {shortcuts.length > 0 && shortcutButtons()}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" isIconOnly aria-label={t("新建设置对话", "New settings conversation")}
              isDisabled={conversationChangeDisabled} isPending={controls.switchingConversation}
              onPress={() => void controls.createConversation().then((created) => { if (created) composerRef.current?.focus(); })}>
              <span title={t("新建对话", "New conversation")}><KuloIcon name="chat-add" size={18} /></span>
            </Button>
            <SettingsAssistantHistory snapshot={snapshot} loaded={loaded} disabled={conversationChangeDisabled} error={safeError} onSelect={controls.selectConversation} onDelete={controls.deleteConversation} />
          </div>
        </div>
        <KuloComposer
          textareaRef={composerRef} draftText={controls.draft} onDraftTextChange={controls.setDraft}
          attachments={controls.attachments} onEnqueueFiles={controls.enqueueFiles} onRemoveAttachment={controls.removeAttachment}
          onRetryAttachment={controls.retryAttachment} onCancelAttachment={controls.cancelAttachment} onPreviewImage={setPreviewImage}
          uploadMenuKinds={UPLOAD_MENU_KINDS} allowVoice={false}
          onSubmit={() => { nearBottomRef.current = true; void controls.send(); }}
          onAbort={() => void controls.abort()} busy={snapshot.live.busy}
          connected={connected} isSendDisabled={!loaded || controls.sending || controls.switchingConversation || snapshot.live.busy || controls.unconfirmedSend}
          onConfigure={hasModel ? undefined : () => {
            if (module === "models") { setDismissedModelDraft(null); setModelAction("connect"); return; }
            void controls.navigate({ id: `connect-${Date.now()}`, module: "models" }).catch((err) => setLocalInfo({ title: t("未打开设置", "Settings did not open"), text: err instanceof Error ? err.message : t("打开设置失败", "Failed to open settings"), error: true }));
          }}
          placeholder={composerPlaceholder()}
        />
      </div>
      <AttachmentLightbox image={previewImage} onClose={() => setPreviewImage(null)} />
      <ConfirmDialog open={confirmation !== null} title={confirmation?.title ?? t("确认修改设置？", "Confirm settings changes?")} description={<div className="space-y-2"><p className="whitespace-pre-line">{[confirmation?.description, ...(confirmation?.changes ?? [])].filter(Boolean).join("\n")}</p>{safeError && <p role="alert" className="text-danger">{safeError}</p>}</div>} confirmLabel={t("确认修改", "Confirm changes")} status="warning" isPending={controls.pendingActionId === confirmation?.id} onCancel={() => setConfirmation(null)} onConfirm={() => confirmation && void decide(confirmation, "confirm")} />
    </section>
  );
}
