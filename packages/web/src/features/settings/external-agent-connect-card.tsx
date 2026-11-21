import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Chip, Disclosure, Input, Label, ListBox, Modal, Select, Spinner, TextField } from "@heroui/react";
import {
  redactSensitiveText,
  type AcpRegistryTemplate,
  type DeviceInterconnectionView,
  type EnvNodeDescriptor,
  type ExternalAgentKind,
  type ExternalAgentQuickConnectRequest,
  type ExternalAgentQuickConnectResult,
  type ExternalAgentScanCandidate,
  type ExternalAgentScanResult,
} from "@kulo/protocol";
import { orderDevices } from "../../components/device-identity";
import { kuloRest } from "../../kulo-api";
import { translate, useI18n } from "../../kulo-i18n";
import { deviceApi } from "./device-api";

export interface ExternalAgentConnectApi {
  scanExternalAgents: (body?: { envId?: string; kinds?: ExternalAgentKind[] }, options?: { signal?: AbortSignal }) => Promise<ExternalAgentScanResult>;
  connectExternalAgent: (body: ExternalAgentQuickConnectRequest & { clientId: string }) => Promise<ExternalAgentQuickConnectResult>;
  getAcpRegistryTemplates?: (options?: { refresh?: boolean; signal?: AbortSignal }) => Promise<{ templates: AcpRegistryTemplate[]; fetchedAt: number }>;
}

export interface ExternalAgentConnectCardProps {
  mode: "client" | "personal";
  clientId: string;
  connected: boolean;
  disabled?: boolean;
  envs: EnvNodeDescriptor[];
  currentDeviceId?: string;
  api?: ExternalAgentConnectApi;
  initialScan?: ExternalAgentScanResult;
  onClose?: () => void;
  onConnected?: (result: ExternalAgentQuickConnectResult) => void;
}

export interface ExternalAgentConnectModalProps {
  open: boolean;
  clientId: string;
  connected: boolean;
  disabled?: boolean;
  envs: EnvNodeDescriptor[];
  currentDeviceId?: string;
  api?: ExternalAgentConnectApi;
  initialScan?: ExternalAgentScanResult;
  onClose: () => void;
  onConnected?: (result: ExternalAgentQuickConnectResult) => void;
}

export function externalAgentCandidateKey(candidate: Pick<ExternalAgentScanCandidate, "kind" | "envId">): string {
  return `${candidate.kind}:${candidate.envId}`;
}

export function partitionExternalAgentScan(
  scan: ExternalAgentScanResult | undefined,
  currentDeviceId?: string,
) {
  const candidates = scan?.candidates ?? [];
  const onlineDevices = orderDevices(
    (scan?.devices ?? []).filter((device) => device.online),
    { currentDeviceId, preferHub: true },
  );
  const rawInstalled = candidates.filter((candidate) => candidate.installed);
  const installed = currentDeviceId
    ? rawInstalled
        .map((candidate, index) => ({ candidate, index }))
        .sort((left, right) => {
          const leftCurrent = left.candidate.envId === currentDeviceId;
          const rightCurrent = right.candidate.envId === currentDeviceId;
          if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
          return left.index - right.index;
        })
        .map((entry) => entry.candidate)
    : rawInstalled;
  const connectable = installed.filter(
    (candidate) =>
      candidate.authenticated !== false &&
      (!candidate.alreadyConnected || !candidate.connectedVerified),
  );
  const installedKinds = new Set(installed.map((candidate) => candidate.kind));
  const missingLabels = [...new Set(candidates.filter((candidate) => !installedKinds.has(candidate.kind)).map((candidate) => candidate.label))];
  return {
    onlineDevices,
    multiDevice: onlineDevices.length > 1,
    installed,
    connectable,
    missingLabels,
  };
}

export function formatMissingExternalAgentLabels(
  missingLabels: readonly string[],
  t: (zh: string, en: string) => string,
): string {
  if (missingLabels.length <= 3) return missingLabels.join(" · ");
  const head = missingLabels.slice(0, 3).join(" · ");
  return `${head} ${t(`等 ${missingLabels.length} 项`, `+${missingLabels.length - 3} more`)}`;
}

export function parseAcpArgsInput(raw: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < raw.length; index++) {
    const ch = raw[index]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) result.push(current);
  return result;
}

function useResolvedCurrentDeviceId(
  connected: boolean,
  explicitCurrentDeviceId: string | undefined,
  envs: readonly EnvNodeDescriptor[],
): string | undefined {
  const [deviceView, setDeviceView] = useState<DeviceInterconnectionView>();
  const envKey = envs.map((env) => `${env.id}:${env.online}`).join("|");
  const shouldResolve = connected && explicitCurrentDeviceId === undefined && envs.length > 0;

  useEffect(() => {
    if (!shouldResolve) return;
    const controller = new AbortController();
    void deviceApi.get(controller.signal).then((view) => {
      if (!controller.signal.aborted) setDeviceView(view);
    }).catch(() => {
      /* Fallback to hub/default device order when device-network endpoint is unavailable. */
    });
    return () => controller.abort();
  }, [shouldResolve, envKey]);

  return explicitCurrentDeviceId ?? (deviceView?.currentDeviceKnown === true ? deviceView.currentDeviceId : undefined);
}

const commandId = (prefix: string) =>
  `agent-${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

const formatError = (cause: unknown) =>
  redactSensitiveText(cause instanceof Error ? cause.message : translate("连接失败，请重试。", "Connection failed. Please retry."));

const MANUAL_CLIENT_KINDS: ReadonlyArray<{ kind: ExternalAgentKind; zh: string; en: string }> = [
  { kind: "codex", zh: "Codex", en: "Codex" },
  { kind: "claude-code", zh: "Claude Code", en: "Claude Code" },
  { kind: "antigravity", zh: "Antigravity", en: "Antigravity" },
  { kind: "grok", zh: "Grok Build", en: "Grok Build" },
  { kind: "cursor", zh: "Cursor Agent", en: "Cursor Agent" },
  { kind: "opencode", zh: "OpenCode", en: "OpenCode" },
  { kind: "gemini-cli", zh: "Gemini CLI", en: "Gemini CLI" },
  { kind: "kiro", zh: "Kiro CLI", en: "Kiro CLI" },
  { kind: "copilot", zh: "GitHub Copilot", en: "GitHub Copilot" },
  { kind: "dsh", zh: "DeepSeek Harness", en: "DeepSeek Harness" },
  { kind: "acp", zh: "自定义 ACP", en: "Custom ACP" },
];

const NATIVE_LOGIN_HINTS: Partial<Record<ExternalAgentKind, string>> = {
  codex: "codex login",
  "claude-code": "claude auth login",
  antigravity: "agy acp --login",
  grok: "grok login",
  cursor: "cursor-agent login",
  opencode: "opencode auth login",
  "gemini-cli": "gemini",
  kiro: "kiro-cli login",
  copilot: "copilot login",
  dsh: "dsh",
};

const EXECUTABLE_PLACEHOLDERS: Partial<Record<ExternalAgentKind, string>> = {
  codex: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "claude-code": "/Users/you/.local/bin/claude",
  antigravity: "/Applications/Gemini.app/Contents/Helpers/agy",
  grok: "/Users/you/.grok/bin/grok",
  cursor: "/Users/you/.local/bin/cursor-agent",
  opencode: "/Users/you/.opencode/bin/opencode",
  "gemini-cli": "/opt/homebrew/bin/gemini",
  kiro: "/Users/you/.kiro/bin/kiro-cli",
  copilot: "/opt/homebrew/bin/copilot",
  dsh: "/usr/local/bin/dsh",
  acp: "/opt/homebrew/bin/my-acp-agent",
};

const RESERVED_PERSONAL_AGENTS = [
  { kind: "dots", label: "ChatGPT Dots" },
  { kind: "muse", label: "Meta Muse" },
] as const;

export function ExternalAgentConnectCard(props: ExternalAgentConnectCardProps) {
  if (props.mode === "personal") return <PersonalAgentConnectCard {...props} />;
  return <LocalClientConnectView {...props} surface="card" />;
}

export function ExternalAgentConnectModal({
  open,
  clientId,
  connected,
  disabled = false,
  envs,
  currentDeviceId,
  api = kuloRest,
  initialScan,
  onClose,
  onConnected,
}: ExternalAgentConnectModalProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
    >
      <Modal.Container placement="center" size="md" scroll="inside">
        <Modal.Dialog
          aria-label={t("连接外部客户端", "Connect external client")}
          className="w-full max-w-[560px] rounded-3xl"
        >
          {open && (
            <LocalClientConnectView
              mode="client"
              surface="overlay"
              clientId={clientId}
              connected={connected}
              disabled={disabled}
              envs={envs}
              currentDeviceId={currentDeviceId}
              api={api}
              initialScan={initialScan}
              onClose={onClose}
              onConnected={onConnected}
              onBusyChange={setBusy}
            />
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function LocalClientConnectView({
  surface,
  clientId,
  connected,
  disabled = false,
  envs,
  currentDeviceId,
  api = kuloRest,
  initialScan,
  onClose,
  onConnected,
  onBusyChange,
}: ExternalAgentConnectCardProps & {
  surface: "card" | "overlay";
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const resolvedCurrentDeviceId = useResolvedCurrentDeviceId(connected, currentDeviceId, envs);
  const fieldVariant = surface === "overlay" ? "secondary" : "primary";
  const [scan, setScan] = useState<ExternalAgentScanResult | undefined>(initialScan);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string>();
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [connectingAll, setConnectingAll] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [connectedCount, setConnectedCount] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualKind, setManualKind] = useState<ExternalAgentKind>("codex");
  const [manualEnvId, setManualEnvId] = useState("");
  const [manualEnvUserPicked, setManualEnvUserPicked] = useState(false);
  const [manualExecutable, setManualExecutable] = useState("");
  const [manualAgentRef, setManualAgentRef] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [manualAcpArgs, setManualAcpArgs] = useState("");
  const [registryTemplates, setRegistryTemplates] = useState<AcpRegistryTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [manualConnecting, setManualConnecting] = useState(false);
  const [manualError, setManualError] = useState<string>();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const scanAbort = useRef<AbortController | null>(null);
  const initialTriggered = useRef(Boolean(initialScan));
  const registryLoadedRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scanAbort.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (manualKind !== "acp" || !connected || disabled || registryLoadedRef.current || !api.getAcpRegistryTemplates) return;
    registryLoadedRef.current = true;
    const controller = new AbortController();
    void api.getAcpRegistryTemplates({ signal: controller.signal }).then((res) => {
      if (!controller.signal.aborted && mounted.current) setRegistryTemplates(res.templates);
    }).catch(() => {
      /* Silent fallback when offline; users can still enter custom ACP fields manually. */
    });
    return () => controller.abort();
  }, [manualKind, connected, disabled, api]);

  useEffect(() => {
    if (surface !== "overlay") return;
    if (connectingKey === null && !connectingAll && !manualConnecting && document.activeElement === document.body) {
      closeButtonRef.current?.focus({ preventScroll: true });
    }
  }, [surface, connectingKey, connectingAll, manualConnecting]);

  const runScan = useCallback(async () => {
    if (!connected || disabled) return;
    scanAbort.current?.abort();
    const controller = new AbortController();
    scanAbort.current = controller;
    setScanning(true);
    setScanError(undefined);
    try {
      const next = await api.scanExternalAgents({}, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setScan(next);
      setRowErrors({});
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return;
      setScanError(formatError(cause));
    } finally {
      if (mounted.current && scanAbort.current === controller) {
        setScanning(false);
      }
    }
  }, [api, connected, disabled]);

  useEffect(() => {
    if (!initialTriggered.current && connected && !disabled) {
      initialTriggered.current = true;
      void runScan();
    }
  }, [connected, disabled, runScan]);

  const { onlineDevices, multiDevice, installed, connectable, missingLabels } = useMemo(
    () => partitionExternalAgentScan(scan, resolvedCurrentDeviceId),
    [scan, resolvedCurrentDeviceId],
  );
  const availableDevices = useMemo(() => {
    if (onlineDevices.length > 0) return onlineDevices;
    return orderDevices(
      envs
        .filter((env) => env.online && env.executionKind !== "native-device")
        .map(({ id, name, online }) => ({ id, name, online })),
      { currentDeviceId: resolvedCurrentDeviceId, preferHub: true },
    );
  }, [onlineDevices, envs, resolvedCurrentDeviceId]);

  useEffect(() => {
    if (availableDevices.length === 0) {
      if (manualEnvId) setManualEnvId("");
      return;
    }
    const stillValid = availableDevices.some((device) => device.id === manualEnvId);
    if (!stillValid || (!manualEnvUserPicked && resolvedCurrentDeviceId && availableDevices[0]!.id !== manualEnvId)) {
      setManualEnvId(availableDevices[0]!.id);
    }
  }, [availableDevices, manualEnvId, manualEnvUserPicked, resolvedCurrentDeviceId]);

  const effectiveManualEnvId = manualEnvId || availableDevices[0]?.id || "";
  const busy = scanning || connectingAll || connectingKey !== null || manualConnecting;
  const blocked = !connected || disabled || busy;

  useEffect(() => {
    onBusyChange?.(connectingAll || connectingKey !== null || manualConnecting);
    return () => onBusyChange?.(false);
  }, [connectingAll, connectingKey, manualConnecting, onBusyChange]);

  const connectCandidate = async (candidate: ExternalAgentScanCandidate): Promise<boolean> => {
    const key = externalAgentCandidateKey(candidate);
    setConnectingKey(key);
    setRowErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const result = await api.connectExternalAgent({
        clientId,
        kind: candidate.kind,
        envId: candidate.envId,
        commandId: commandId("connect"),
        runTest: true,
      });
      if (!mounted.current) return false;
      setScan((prev) => prev ? {
        ...prev,
        candidates: prev.candidates.map((item) =>
          externalAgentCandidateKey(item) === key
            ? {
                ...item,
                authenticated: item.authenticated === false ? true : item.authenticated,
                alreadyConnected: true,
                connectedClientId: result.clientId,
                connectedVerified: result.verificationLevel === "roundtrip",
                ...(result.version ? { version: result.version } : {}),
              }
            : item,
        ),
      } : prev);
      setConnectedCount((count) => count + 1);
      onConnected?.(result);
      return true;
    } catch (cause) {
      if (mounted.current) {
        setRowErrors((prev) => ({ ...prev, [key]: formatError(cause) }));
      }
      return false;
    } finally {
      if (mounted.current) setConnectingKey(null);
    }
  };

  const connectOne = async (candidate: ExternalAgentScanCandidate) => {
    if (blocked || !clientId) return;
    await connectCandidate(candidate);
  };

  const connectAll = async () => {
    if (blocked || !clientId || connectable.length === 0) return;
    setConnectingAll(true);
    try {
      for (const candidate of connectable) {
        if (!mounted.current) break;
        await connectCandidate(candidate);
      }
    } finally {
      if (mounted.current) setConnectingAll(false);
    }
  };

  const isCustomAcp = manualKind === "acp";
  const canSubmitManual = Boolean(
    !blocked &&
    clientId &&
    effectiveManualEnvId &&
    manualExecutable.trim() &&
    (!isCustomAcp || manualAgentRef.trim()),
  );

  const connectManual = async () => {
    if (!canSubmitManual) return;
    setManualConnecting(true);
    setManualError(undefined);
    try {
      const parsedArgs = isCustomAcp ? parseAcpArgsInput(manualAcpArgs) : [];
      const result = await api.connectExternalAgent({
        clientId,
        kind: manualKind,
        envId: effectiveManualEnvId,
        executable: manualExecutable.trim(),
        ...(isCustomAcp ? { agentRef: manualAgentRef.trim() } : {}),
        ...(isCustomAcp && parsedArgs.length > 0 ? { acpArgs: parsedArgs } : {}),
        ...(isCustomAcp && manualLabel.trim() ? { label: manualLabel.trim() } : {}),
        commandId: commandId("manual"),
        runTest: true,
      });
      if (!mounted.current) return;
      setManualExecutable("");
      setManualAgentRef("");
      setManualLabel("");
      setManualAcpArgs("");
      setSelectedTemplateId("");
      setManualOpen(false);
      setConnectedCount((count) => count + 1);
      onConnected?.(result);
      void runScan();
    } catch (cause) {
      if (mounted.current) setManualError(formatError(cause));
    } finally {
      if (mounted.current) setManualConnecting(false);
    }
  };

  const applyRegistryTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    setManualError(undefined);
    const tpl = registryTemplates.find((item) => item.id === templateId);
    if (!tpl) return;
    setManualLabel(tpl.name);
    setManualAgentRef(tpl.id);
    setManualAcpArgs(tpl.suggestedArgs.join(" "));
  };

  const body = (
    <>
      {scanning && !scan && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner size="sm" />
          <span>{t("正在检测可连接的本地客户端…", "Scanning local agent clients…")}</span>
        </div>
      )}
      {scanError && (
        <Alert status="danger" role="alert">
          <Alert.Content className="break-words text-xs">{scanError}</Alert.Content>
        </Alert>
      )}
      {scan && onlineDevices.length === 0 && (
        <p className="text-sm text-muted">{t("暂无在线电脑设备。", "No online computer devices.")}</p>
      )}
      {scan && onlineDevices.length > 0 && installed.length === 0 && !scanning && (
        <p className="text-sm text-muted">{t("未检测到已安装的本地客户端。", "No installed local clients found.")}</p>
      )}
      {installed.length > 0 && (
        <div className="kulo-list-surface scrollbar max-h-96 overflow-y-auto" role="group" aria-label={t("已检测到的本地客户端", "Detected local clients")}>
          {installed.map((candidate) => {
            const key = externalAgentCandidateKey(candidate);
            const isConnected = candidate.alreadyConnected && candidate.connectedVerified;
            const isPendingVerify = candidate.alreadyConnected && !candidate.connectedVerified;
            const isUnauthenticated = candidate.authenticated === false;
            const isConnecting = connectingKey === key;
            const rowError = rowErrors[key];
            const loginHint = isUnauthenticated ? NATIVE_LOGIN_HINTS[candidate.kind] : undefined;
            const meta = [
              multiDevice ? candidate.envName : "",
              candidate.version,
              isUnauthenticated ? [t("未登录", "Not signed in"), loginHint].filter(Boolean).join(" · ") : "",
            ].filter(Boolean).join(" · ");
            return (
              <div key={key} className="kulo-settings-list-row">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="kulo-item-title break-words">{candidate.label}</span>
                    {isUnauthenticated && (
                      <Chip size="sm" variant="soft" color="warning" className="shrink-0 whitespace-nowrap">
                        {t("未登录", "Not signed in")}
                      </Chip>
                    )}
                    {isPendingVerify && !isUnauthenticated && (
                      <Chip size="sm" variant="soft" className="shrink-0 whitespace-nowrap">
                        {t("待验证", "Unverified")}
                      </Chip>
                    )}
                  </span>
                  {meta && <span className="kulo-item-description break-words">{meta}</span>}
                  {rowError && <span role="alert" className="break-words text-xs text-danger">{rowError}</span>}
                </div>
                {isConnected ? (
                  <Chip size="sm" variant="soft" color="success" className="shrink-0 whitespace-nowrap">
                    {t("已连接", "Connected")}
                  </Chip>
                ) : isUnauthenticated ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    aria-label={t(`重新检测 ${candidate.label}（${candidate.envName}）`, `Re-check ${candidate.label} on ${candidate.envName}`)}
                    isPending={scanning}
                    isDisabled={blocked}
                    onPress={() => void runScan()}
                  >
                    {t("重试", "Retry")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={connectable.length === 1 ? "primary" : "secondary"}
                    className="shrink-0"
                    aria-label={t(`连接 ${candidate.label}（${candidate.envName}）`, `Connect ${candidate.label} on ${candidate.envName}`)}
                    isPending={isConnecting}
                    isDisabled={blocked || !clientId}
                    onPress={() => void connectOne(candidate)}
                  >
                    {rowError
                      ? t("重试", "Retry")
                      : isPendingVerify
                        ? t("验证并启用", "Verify & enable")
                        : t("连接", "Connect")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {scan && onlineDevices.length > 0 && missingLabels.length > 0 && (
        <p className="text-xs text-muted">
          {t("未检测到：", "Not detected: ")}
          {formatMissingExternalAgentLabels(missingLabels, t)}
        </p>
      )}
      {connectedCount > 0 && (
        <p role="status" className="text-xs text-muted">
          {t(`已连接 ${connectedCount} 个客户端`, `Connected ${connectedCount} client(s)`)}
        </p>
      )}
      {availableDevices.length > 0 && (
        <Disclosure isExpanded={manualOpen} onExpandedChange={setManualOpen} className="min-w-0">
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl py-1 text-left text-xs text-muted">
              <span>{t("手动指定客户端路径", "Custom client path")}</span>
              <Disclosure.Indicator className="shrink-0 text-muted" />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="kulo-form-stack pt-2">
              <Select
                className="kulo-form-field"
                variant={fieldVariant}
                value={manualKind}
                onChange={(key) => {
                  if (key) {
                    setManualKind(String(key) as ExternalAgentKind);
                    setManualError(undefined);
                  }
                }}
                isDisabled={blocked}
              >
                <Label>{t("客户端类型", "Client")}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {MANUAL_CLIENT_KINDS.map((entry) => (
                      <ListBox.Item key={entry.kind} id={entry.kind} textValue={t(entry.zh, entry.en)}>
                        {t(entry.zh, entry.en)}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              {availableDevices.length > 1 && (
                <Select
                  className="kulo-form-field"
                  variant={fieldVariant}
                  value={effectiveManualEnvId || null}
                  onChange={(key) => {
                    setManualEnvUserPicked(true);
                    setManualEnvId(String(key ?? ""));
                    setManualError(undefined);
                  }}
                  isDisabled={blocked}
                >
                  <Label>{t("所在设备", "Device")}</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {availableDevices.map((device) => (
                        <ListBox.Item key={device.id} id={device.id} textValue={device.name}>
                          {device.name}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              )}
              {isCustomAcp && registryTemplates.length > 0 && (
                <Select
                  className="kulo-form-field"
                  variant={fieldVariant}
                  value={selectedTemplateId || null}
                  placeholder={t("选择 ACP Registry 模板（可选）", "Select ACP Registry template (optional)")}
                  onChange={(key) => applyRegistryTemplate(String(key ?? ""))}
                  isDisabled={blocked}
                >
                  <Label>{t("预设模板", "Template")}</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {registryTemplates.map((tpl) => (
                        <ListBox.Item key={tpl.id} id={tpl.id} textValue={tpl.name}>
                          {tpl.name}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              )}
              {isCustomAcp && (
                <>
                  <TextField
                    className="kulo-form-field"
                    variant={fieldVariant}
                    value={manualLabel}
                    onChange={(value) => {
                      setManualLabel(value);
                      setManualError(undefined);
                    }}
                    isDisabled={blocked}
                  >
                    <Label>{t("客户端名称", "Client name")}</Label>
                    <Input placeholder="Kimi Code" />
                  </TextField>
                  <TextField
                    className="kulo-form-field"
                    variant={fieldVariant}
                    isRequired
                    value={manualAgentRef}
                    onChange={(value) => {
                      setManualAgentRef(value);
                      setManualError(undefined);
                    }}
                    isDisabled={blocked}
                  >
                    <Label>{t("客户端标识", "Client ID")}</Label>
                    <Input spellCheck={false} autoComplete="off" placeholder="kimi-code" />
                  </TextField>
                </>
              )}
              <TextField
                className="kulo-form-field"
                variant={fieldVariant}
                value={manualExecutable}
                onChange={(value) => {
                  setManualExecutable(value);
                  setManualError(undefined);
                }}
                isDisabled={blocked}
              >
                <Label>{t("可执行文件绝对路径", "Executable path")}</Label>
                <Input
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={EXECUTABLE_PLACEHOLDERS[manualKind] ?? "/usr/local/bin/agent"}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void connectManual();
                    }
                  }}
                />
              </TextField>
              {isCustomAcp && (
                <TextField
                  className="kulo-form-field"
                  variant={fieldVariant}
                  value={manualAcpArgs}
                  onChange={(value) => {
                    setManualAcpArgs(value);
                    setManualError(undefined);
                  }}
                  isDisabled={blocked}
                >
                  <Label>{t("启动参数", "Arguments")}</Label>
                  <Input
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="acp"
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void connectManual();
                      }
                    }}
                  />
                </TextField>
              )}
              {manualError && <p role="alert" className="break-words text-xs text-danger">{manualError}</p>}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  isPending={manualConnecting}
                  isDisabled={!canSubmitManual}
                  onPress={() => void connectManual()}
                >
                  {t("检测并连接", "Detect & connect")}
                </Button>
              </div>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      )}
    </>
  );

  const footerActions = (
    <>
      {onClose && (
        <Button ref={closeButtonRef} size="sm" variant="tertiary" isDisabled={connectingAll || connectingKey !== null || manualConnecting} onPress={onClose}>
          {t("关闭", "Close")}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        isPending={scanning}
        isDisabled={!connected || disabled || connectingAll || connectingKey !== null || manualConnecting}
        onPress={() => void runScan()}
      >
        {t("重新扫描", "Scan again")}
      </Button>
      {connectable.length > 1 && (
        <Button
          size="sm"
          variant="primary"
          isPending={connectingAll}
          isDisabled={blocked || !clientId}
          onPress={() => void connectAll()}
        >
          {t(`全部连接（${connectable.length}）`, `Connect all (${connectable.length})`)}
        </Button>
      )}
    </>
  );

  if (surface === "overlay") {
    return (
      <>
        <Modal.Header className="flex flex-row items-center justify-between gap-2">
          <Modal.Heading>{t("连接外部客户端", "Connect external client")}</Modal.Heading>
          <Modal.CloseTrigger
            aria-label={t("关闭", "Close")}
            className="static"
            isDisabled={connectingAll || connectingKey !== null || manualConnecting}
          />
        </Modal.Header>
        <Modal.Body className="scrollbar flex min-w-0 flex-col gap-3">
          {body}
        </Modal.Body>
        <Modal.Footer className="flex-wrap justify-end gap-2">
          {footerActions}
        </Modal.Footer>
      </>
    );
  }

  return (
    <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-4" aria-label={t("连接 Agent 客户端", "Connect agent clients")}>
      <Card.Header>
        <Card.Title className="text-sm">{t("连接 Agent 客户端", "Connect agent clients")}</Card.Title>
      </Card.Header>
      <Card.Content className="flex min-w-0 flex-col gap-3">
        {body}
      </Card.Content>
      <Card.Footer className="flex-wrap justify-end gap-2">
        {footerActions}
      </Card.Footer>
    </Card>
  );
}

function PersonalAgentConnectCard({
  clientId,
  connected,
  disabled = false,
  envs,
  currentDeviceId,
  api = kuloRest,
  initialScan,
  onClose,
  onConnected,
}: ExternalAgentConnectCardProps) {
  const { t } = useI18n();
  const resolvedCurrentDeviceId = useResolvedCurrentDeviceId(connected, currentDeviceId, envs);
  const onlineDevices = useMemo(
    () => orderDevices(
      envs.filter((env) => env.online && env.executionKind !== "native-device"),
      { currentDeviceId: resolvedCurrentDeviceId, preferHub: true },
    ),
    [envs, resolvedCurrentDeviceId],
  );
  const [selectedEnvId, setSelectedEnvId] = useState(() => onlineDevices[0]?.id ?? "");
  const [envUserPicked, setEnvUserPicked] = useState(false);
  const [cdpUrl, setCdpUrl] = useState("");
  const [agentRef, setAgentRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [savedLabel, setSavedLabel] = useState<string>();
  const [grokAppStatus, setGrokAppStatus] = useState<{ installed: boolean; version?: string }>(() => {
    const initial = initialScan?.candidates.find((item) => item.kind === "grok-bot" && item.desktopAppInstalled);
    return initial ? { installed: true, version: initial.version } : { installed: false };
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (onlineDevices.length === 0) {
      if (selectedEnvId) setSelectedEnvId("");
      return;
    }
    const stillValid = onlineDevices.some((device) => device.id === selectedEnvId);
    if (!stillValid || (!envUserPicked && resolvedCurrentDeviceId && onlineDevices[0]!.id !== selectedEnvId)) {
      setSelectedEnvId(onlineDevices[0]!.id);
    }
  }, [onlineDevices, selectedEnvId, envUserPicked, resolvedCurrentDeviceId]);

  const effectiveEnvId = selectedEnvId || onlineDevices[0]?.id || "";
  const blocked = !connected || disabled || busy;

  useEffect(() => {
    if (!connected || disabled || !effectiveEnvId) return;
    const initialMatch = initialScan?.candidates.find(
      (item) => item.kind === "grok-bot" && item.envId === effectiveEnvId,
    );
    if (initialMatch) {
      setGrokAppStatus(initialMatch.desktopAppInstalled ? { installed: true, version: initialMatch.version } : { installed: false });
      return;
    }
    const controller = new AbortController();
    void api.scanExternalAgents({ envId: effectiveEnvId, kinds: ["grok-bot"] }, { signal: controller.signal }).then((res) => {
      if (!mounted.current || controller.signal.aborted) return;
      const candidate = res.candidates.find((item) => item.kind === "grok-bot" && item.envId === effectiveEnvId);
      setGrokAppStatus(candidate?.desktopAppInstalled ? { installed: true, version: candidate.version } : { installed: false });
    }).catch(() => {
      if (mounted.current && !controller.signal.aborted) setGrokAppStatus({ installed: false });
    });
    return () => controller.abort();
  }, [connected, disabled, effectiveEnvId, api, initialScan]);

  const connectGrok = async () => {
    if (blocked || !clientId || !effectiveEnvId || !cdpUrl.trim() || !agentRef.trim()) return;
    setBusy(true);
    setError(undefined);
    setSavedLabel(undefined);
    try {
      const result = await api.connectExternalAgent({
        clientId,
        kind: "grok-bot",
        envId: effectiveEnvId,
        commandId: commandId("personal"),
        runTest: false,
        experimental: true,
        cdpUrl: cdpUrl.trim(),
        agentRef: agentRef.trim(),
      });
      if (!mounted.current) return;
      setSavedLabel(result.label);
      onConnected?.(result);
    } catch (cause) {
      if (mounted.current) setError(formatError(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-4" aria-label={t("连接 Personal Agent", "Connect personal agent")}>
      <Card.Header>
        <Card.Title className="text-sm">{t("连接 Personal Agent", "Connect personal agent")}</Card.Title>
      </Card.Header>
      <Card.Content className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="kulo-item-title">Grok Bot</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {grokAppStatus.installed && (
              <Chip size="sm" variant="soft" color="success">
                {grokAppStatus.version
                  ? t(`已安装 ${grokAppStatus.version}`, `Installed ${grokAppStatus.version}`)
                  : t("已安装", "Installed")}
              </Chip>
            )}
            <Chip size="sm" variant="soft" color="warning">{t("实验", "Experimental")}</Chip>
          </div>
        </div>
        <div className="kulo-form-stack">
          {onlineDevices.length > 1 && (
            <Select
              className="kulo-form-field"
              variant="primary"
              value={effectiveEnvId || null}
              onChange={(key) => {
                setEnvUserPicked(true);
                setSelectedEnvId(String(key ?? ""));
              }}
              isDisabled={blocked}
            >
              <Label>{t("所在设备", "Device")}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {onlineDevices.map((device) => (
                    <ListBox.Item key={device.id} id={device.id} textValue={device.name}>
                      {device.name}
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          )}
          <TextField className="kulo-form-field" variant="primary" value={cdpUrl} onChange={setCdpUrl} isDisabled={blocked || onlineDevices.length === 0}>
            <Label>{t("本机调试地址", "Local debug URL")}</Label>
            <Input type="url" autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:9333/" />
          </TextField>
          <TextField className="kulo-form-field" variant="primary" value={agentRef} onChange={setAgentRef} isDisabled={blocked || onlineDevices.length === 0}>
            <Label>{t("Bot 名称", "Bot name")}</Label>
            <Input spellCheck={false} />
          </TextField>
          {onlineDevices.length === 0 && (
            <p className="text-xs text-muted">{t("暂无在线电脑设备。", "No online computer devices.")}</p>
          )}
          {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
          {savedLabel && (
            <p role="status" className="text-xs text-muted">
              {t(`已保存「${savedLabel}」（停用状态）`, `Saved “${savedLabel}” (disabled)`)}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              isPending={busy}
              isDisabled={blocked || !clientId || !effectiveEnvId || !cdpUrl.trim() || !agentRef.trim()}
              onPress={() => void connectGrok()}
            >
              {t("检查并保存", "Check and save")}
            </Button>
          </div>
        </div>
        <div className="kulo-list-surface" role="group" aria-label={t("预留接入", "Reserved integrations")}>
          {RESERVED_PERSONAL_AGENTS.map((entry) => (
            <div key={entry.kind} className="kulo-settings-list-row justify-between">
              <span className="kulo-item-title">{entry.label}</span>
              <Chip size="sm" variant="soft">{t("暂未开放", "Reserved")}</Chip>
            </div>
          ))}
        </div>
      </Card.Content>
      <Card.Footer className="flex-wrap justify-end gap-2">
        {onClose && (
          <Button size="sm" variant="tertiary" isDisabled={busy} onPress={onClose}>
            {t("关闭", "Close")}
          </Button>
        )}
      </Card.Footer>
    </Card>
  );
}
