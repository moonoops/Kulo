import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, Popover, Spinner } from "@heroui/react";
import {
  isConversationModel,
  isPrivateLocalModelEndpoint,
  type ExternalClientConnection,
  type ProviderCatalogItem,
  type TicketCardView,
  type TicketResumeOverrideRequest,
} from "@kulo/protocol";
import { useI18n, translate as t } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { providerCatalog } from "../../kulo-api-rest";
import { newDeliveryId } from "../chat/reliable-intents";
import type { TicketAction } from "./task-failure-actions";
import { isTicketQuotaPaused, isTicketRunHealthStuck } from "./task-model";

export interface ResumeModelOption {
  key: string;
  provider?: string;
  modelId: string;
  label: string;
  providerLabel?: string;
  exhausted: boolean;
  current: boolean;
  isLocal?: boolean;
  disabled: boolean;
  disabledReason?: string;
}

export type ResumeOverrideTicket = Pick<
  TicketCardView,
  | "id"
  | "title"
  | "status"
  | "waiting"
  | "quotaPause"
  | "runHealthStuck"
  | "externalAgentKind"
  | "externalClientId"
  | "externalModelId"
  | "providerOverride"
  | "modelOverride"
  | "cleanupPending"
  | "envId"
>;

export type TicketResumeOverrideAction = (
  ticketId: string,
  body: TicketResumeOverrideRequest,
) => Promise<void> | void;

export function buildSameEngineResumeOptions(input: {
  ticket: Pick<
    TicketCardView,
    | "externalAgentKind"
    | "externalClientId"
    | "externalModelId"
    | "providerOverride"
    | "modelOverride"
    | "quotaPause"
    | "envId"
  >;
  providers?: readonly ProviderCatalogItem[];
  externalClients?: Readonly<Record<string, ExternalClientConnection>>;
  defaultProvider?: string;
  defaultModel?: string;
}): ResumeModelOption[] {
  const { ticket, providers = [], externalClients, defaultProvider, defaultModel } = input;
  const isUsageCap = ticket.quotaPause?.kind === "usage_cap";

  if (ticket.externalAgentKind) {
    const targetClientId = ticket.externalClientId ?? ticket.quotaPause?.externalClientId;
    const clients = Object.values(externalClients ?? {});
    const matchedClient =
      (targetClientId ? externalClients?.[targetClientId] : undefined) ??
      clients.find(
        (client) =>
          client.kind === ticket.externalAgentKind &&
          (!ticket.envId || client.envId === ticket.envId),
      ) ??
      clients.find((client) => client.kind === ticket.externalAgentKind);
    if (!matchedClient) return [];

    const exhaustedModelId =
      ticket.quotaPause?.modelId ?? ticket.externalModelId ?? ticket.modelOverride;
    const currentModelId = ticket.externalModelId ?? ticket.modelOverride;
    const seen = new Set<string>();
    const options: ResumeModelOption[] = [];

    for (const model of matchedClient.models) {
      const id = model.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const exhausted = Boolean(ticket.quotaPause && exhaustedModelId && id === exhaustedModelId);
      const current = Boolean(currentModelId && id === currentModelId);
      const disabled = exhausted || isUsageCap;
      const disabledReason = isUsageCap
        ? t("用量上限保护中", "Usage cap active")
        : exhausted
          ? t("额度已耗尽", "Quota exhausted")
          : undefined;
      options.push({
        key: `${matchedClient.id}::${id}`,
        provider: matchedClient.id,
        modelId: id,
        label: model.name?.trim() || id,
        providerLabel: matchedClient.label?.trim() || matchedClient.kind,
        exhausted,
        current,
        disabled,
        ...(disabledReason ? { disabledReason } : {}),
      });
    }
    return options;
  }

  const exhaustedProvider =
    ticket.quotaPause?.provider ?? ticket.providerOverride ?? defaultProvider;
  const exhaustedModelId =
    ticket.quotaPause?.modelId ?? ticket.modelOverride ?? defaultModel;
  const currentProvider = ticket.providerOverride ?? defaultProvider;
  const currentModelId = ticket.modelOverride ?? defaultModel;
  const seen = new Set<string>();
  const options: ResumeModelOption[] = [];

  for (const provider of providers) {
    const isLocal = Boolean(provider.baseUrl && isPrivateLocalModelEndpoint(provider.baseUrl));
    const available = provider.authenticated || isLocal || Boolean(provider.configuredModels?.length);
    if (!available && provider.id !== currentProvider && provider.id !== exhaustedProvider) {
      continue;
    }
    const providerModels = provider.configuredModels?.length
      ? [...provider.configuredModels, ...provider.models]
      : provider.models;
    for (const model of providerModels) {
      const id = model.id.trim();
      if (!id || !isConversationModel(model)) continue;
      const key = `${provider.id}::${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const exhausted = Boolean(
        ticket.quotaPause &&
          exhaustedModelId === id &&
          (!exhaustedProvider || exhaustedProvider === provider.id),
      );
      const current = Boolean(
        currentModelId === id && (!currentProvider || currentProvider === provider.id),
      );
      const usageCapBlocked = isUsageCap && !isLocal;
      const disabled = exhausted || usageCapBlocked;
      const disabledReason = usageCapBlocked
        ? t("用量上限保护（可选本机模型）", "Usage cap active (local models allowed)")
        : exhausted
          ? t("额度已耗尽", "Quota exhausted")
          : undefined;
      options.push({
        key,
        provider: provider.id,
        modelId: id,
        label: model.name?.trim() || id,
        providerLabel: provider.name?.trim() || provider.id,
        exhausted,
        current,
        isLocal,
        disabled,
        ...(disabledReason ? { disabledReason } : {}),
      });
    }
  }
  return options;
}

export function QuotaResumePopover({
  ticket,
  mode,
  providers: suppliedProviders,
  externalClients,
  defaultProvider,
  defaultModel,
  canQueueActions = true,
  isDisabled = false,
  onResumeOverride,
}: {
  ticket: ResumeOverrideTicket;
  mode: "quota" | "stuck";
  providers?: readonly ProviderCatalogItem[];
  externalClients?: Readonly<Record<string, ExternalClientConnection>>;
  defaultProvider?: string;
  defaultModel?: string;
  canQueueActions?: boolean;
  isDisabled?: boolean;
  onResumeOverride: TicketResumeOverrideAction;
}) {
  const { t } = useI18n();
  const catalogSnapshot = useSyncExternalStore(
    providerCatalog.subscribe,
    providerCatalog.getSnapshot,
    providerCatalog.getSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (open && !suppliedProviders && !ticket.externalAgentKind) {
      void providerCatalog.ensure();
    }
  }, [open, suppliedProviders, ticket.externalAgentKind]);

  const effectiveProviders = suppliedProviders ?? catalogSnapshot.providers;
  const options = useMemo(
    () =>
      buildSameEngineResumeOptions({
        ticket,
        providers: effectiveProviders,
        externalClients,
        defaultProvider,
        defaultModel,
      }),
    [ticket, effectiveProviders, externalClients, defaultProvider, defaultModel],
  );

  const triggerLabel =
    mode === "stuck"
      ? t("换更强模型继续", "Switch to stronger model")
      : t("换模型继续", "Switch model");
  const triggerAriaLabel =
    mode === "stuck"
      ? t(`换更强模型继续：${ticket.title}`, `Switch to stronger model: ${ticket.title}`)
      : t(`换模型继续：${ticket.title}`, `Switch model and continue: ${ticket.title}`);
  const dialogHeading =
    mode === "stuck"
      ? t("选择更强模型继续", "Choose a stronger model")
      : t("选择同引擎模型继续", "Choose a same-engine model");
  const isUsageCap = ticket.quotaPause?.kind === "usage_cap";
  const triggerDisabled = isDisabled || !canQueueActions || Boolean(ticket.cleanupPending) || submittingKey !== null;

  const handleSelectOption = async (option: ResumeModelOption) => {
    if (option.disabled || inFlightRef.current || !canQueueActions) return;
    inFlightRef.current = true;
    setSubmittingKey(option.key);
    setError(null);
    try {
      const commandId = newDeliveryId(`resume:${ticket.id}:${option.modelId}`);
      await onResumeOverride(ticket.id, {
        commandId,
        ...(ticket.externalAgentKind ? {} : option.provider ? { provider: option.provider } : {}),
        modelId: option.modelId,
      });
      setOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("切换模型恢复失败，请重试。", "Failed to switch model and resume. Try again."),
      );
    } finally {
      inFlightRef.current = false;
      setSubmittingKey(null);
    }
  };

  return (
    <Popover isOpen={open} onOpenChange={(next) => { if (!inFlightRef.current) { setOpen(next); if (next) setError(null); } }}>
      <Button
        size="sm"
        variant="secondary"
        aria-label={triggerAriaLabel}
        isDisabled={triggerDisabled}
        isPending={submittingKey !== null}
      >
        {submittingKey !== null ? <Spinner size="sm" color="current" /> : <KuloIcon name="sliders" size={14} />}
        {triggerLabel}
      </Button>
      <Popover.Content placement="bottom start" className="w-72 max-w-[calc(100vw-24px)] p-0">
        <Popover.Dialog className="flex flex-col gap-2 p-3" aria-label={dialogHeading}>
          <Popover.Heading>{dialogHeading}</Popover.Heading>
          {isUsageCap && (
            <p className="text-xs text-muted">
              {t(
                "当前处于用量上限保护，仅可切换本机模型，或放宽预算后重试。",
                "Usage cap is active. Switch to a local model or raise your cap before retrying.",
              )}
            </p>
          )}
          {error && (
            <p className="break-words text-xs text-danger" role="alert">
              {error}
            </p>
          )}
          {options.length === 0 ? (
            <p className="py-2 text-xs text-muted">
              {ticket.externalAgentKind
                ? t("当前外部客户端暂无其他可选模型，可直接重试。", "No alternate models available for this client. Retry directly.")
                : catalogSnapshot.refreshing
                  ? t("正在加载可用模型…", "Loading available models…")
                  : t("暂无可切换的同引擎内置模型。", "No alternate built-in models available.")}
            </p>
          ) : (
            <div className="scrollbar flex max-h-60 flex-col gap-1 overflow-y-auto" role="group" aria-label={t("可选模型列表", "Available models")}>
              {options.map((option) => (
                <Button
                  key={option.key}
                  size="sm"
                  variant="ghost"
                  className="w-full min-w-0 justify-between text-left"
                  isDisabled={option.disabled || submittingKey !== null}
                  isPending={submittingKey === option.key}
                  onPress={() => void handleSelectOption(option)}
                >
                  <span className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="w-full truncate text-xs font-medium">{option.label}</span>
                    {(option.disabledReason || option.providerLabel) && (
                      <span className="w-full truncate text-xs text-muted">
                        {option.disabledReason ?? (option.current ? `${option.providerLabel} · ${t("当前", "Current")}` : option.providerLabel)}
                      </span>
                    )}
                  </span>
                </Button>
              ))}
            </div>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

export function TaskQuotaActions({
  ticket,
  providers,
  externalClients,
  defaultProvider,
  defaultModel,
  canQueueActions = true,
  onResumeOverride,
  onStop,
}: {
  ticket: ResumeOverrideTicket;
  providers?: readonly ProviderCatalogItem[];
  externalClients?: Readonly<Record<string, ExternalClientConnection>>;
  defaultProvider?: string;
  defaultModel?: string;
  canQueueActions?: boolean;
  onResumeOverride: TicketResumeOverrideAction;
  onStop?: TicketAction;
}) {
  const { t } = useI18n();
  const busyRef = useRef(false);
  const [pending, setPending] = useState<"retry" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isQuotaPaused = isTicketQuotaPaused(ticket);
  const isStuck = isTicketRunHealthStuck(ticket);

  if (!isQuotaPaused && !isStuck) return null;

  const runDirectAction = async (kind: "retry" | "stop") => {
    if (busyRef.current || !canQueueActions) return;
    if (kind === "retry" && ticket.cleanupPending) return;
    if (kind === "stop" && !onStop) return;
    busyRef.current = true;
    setPending(kind);
    setError(null);
    try {
      if (kind === "retry") {
        await onResumeOverride(ticket.id, {
          commandId: newDeliveryId(`quota-retry:${ticket.id}`),
        });
      } else {
        await onStop!(ticket.id);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : kind === "stop"
            ? t("停止任务失败，请重试。", "Failed to stop task. Try again.")
            : t("重试失败，请再试一次。", "Retry failed. Try again."),
      );
    } finally {
      busyRef.current = false;
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <QuotaResumePopover
          ticket={ticket}
          mode={isQuotaPaused ? "quota" : "stuck"}
          providers={providers}
          externalClients={externalClients}
          defaultProvider={defaultProvider}
          defaultModel={defaultModel}
          canQueueActions={canQueueActions}
          isDisabled={pending !== null}
          onResumeOverride={onResumeOverride}
        />
        {isQuotaPaused && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={t(`重试任务：${ticket.title}`, `Retry task: ${ticket.title}`)}
            isDisabled={!canQueueActions || pending !== null || Boolean(ticket.cleanupPending)}
            isPending={pending === "retry"}
            onPress={() => void runDirectAction("retry")}
          >
            {pending === "retry" ? <Spinner size="sm" color="current" /> : <KuloIcon name="refresh" size={14} />}
            {t("重试", "Retry")}
          </Button>
        )}
        {isQuotaPaused && onStop && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={t(`停止任务：${ticket.title}`, `Stop task: ${ticket.title}`)}
            isDisabled={!canQueueActions || pending !== null}
            isPending={pending === "stop"}
            onPress={() => void runDirectAction("stop")}
          >
            {pending === "stop" ? <Spinner size="sm" color="current" /> : <KuloIcon name="stop" size={14} />}
            {t("停止", "Stop")}
          </Button>
        )}
      </div>
      {error && (
        <p className="kulo-task-action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
