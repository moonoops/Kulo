import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Chip, Input, Label, ListBox, Select, Spinner, TextField } from "@heroui/react";
import {
  redactSensitiveText,
  type EnvNodeDescriptor,
  type ExternalAgentQuickConnectRequest,
  type ExternalAgentQuickConnectResult,
  type ExternalAgentScanCandidate,
  type ExternalAgentScanResult,
} from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { translate, useI18n } from "../../kulo-i18n";

export interface ExternalAgentConnectApi {
  scanExternalAgents: (body?: { envId?: string }, options?: { signal?: AbortSignal }) => Promise<ExternalAgentScanResult>;
  connectExternalAgent: (body: ExternalAgentQuickConnectRequest & { clientId: string }) => Promise<ExternalAgentQuickConnectResult>;
}

export interface ExternalAgentConnectCardProps {
  mode: "client" | "personal";
  clientId: string;
  connected: boolean;
  disabled?: boolean;
  envs: EnvNodeDescriptor[];
  api?: ExternalAgentConnectApi;
  initialScan?: ExternalAgentScanResult;
  onClose?: () => void;
  onConnected?: (result: ExternalAgentQuickConnectResult) => void;
}

export function externalAgentCandidateKey(candidate: Pick<ExternalAgentScanCandidate, "kind" | "envId">): string {
  return `${candidate.kind}:${candidate.envId}`;
}

export function partitionExternalAgentScan(scan: ExternalAgentScanResult | undefined) {
  const candidates = scan?.candidates ?? [];
  const onlineDevices = (scan?.devices ?? []).filter((device) => device.online);
  const installed = candidates.filter((candidate) => candidate.installed);
  const connectable = installed.filter((candidate) => !candidate.alreadyConnected || !candidate.connectedVerified);
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

const commandId = (prefix: string) =>
  `agent-${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

const formatError = (cause: unknown) =>
  redactSensitiveText(cause instanceof Error ? cause.message : translate("连接失败，请重试。", "Connection failed. Please retry."));

const RESERVED_PERSONAL_AGENTS = [
  { kind: "dots", label: "ChatGPT Dots" },
  { kind: "muse", label: "Meta Muse" },
] as const;

export function ExternalAgentConnectCard(props: ExternalAgentConnectCardProps) {
  if (props.mode === "personal") return <PersonalAgentConnectCard {...props} />;
  return <LocalClientConnectCard {...props} />;
}

function LocalClientConnectCard({
  clientId,
  connected,
  disabled = false,
  api = kuloRest,
  initialScan,
  onClose,
  onConnected,
}: ExternalAgentConnectCardProps) {
  const { t } = useI18n();
  const [scan, setScan] = useState<ExternalAgentScanResult | undefined>(initialScan);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string>();
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [connectingAll, setConnectingAll] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [connectedCount, setConnectedCount] = useState(0);
  const mounted = useRef(true);
  const scanAbort = useRef<AbortController | null>(null);
  const initialTriggered = useRef(Boolean(initialScan));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scanAbort.current?.abort();
    };
  }, []);

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
    () => partitionExternalAgentScan(scan),
    [scan],
  );
  const busy = scanning || connectingAll || connectingKey !== null;
  const blocked = !connected || disabled || busy;

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

  return (
    <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-4" aria-label={t("连接 Agent 客户端", "Connect agent clients")}>
      <Card.Header>
        <Card.Title className="text-sm">{t("连接 Agent 客户端", "Connect agent clients")}</Card.Title>
      </Card.Header>
      <Card.Content className="flex min-w-0 flex-col gap-3">
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
              const isConnecting = connectingKey === key;
              const rowError = rowErrors[key];
              const meta = [multiDevice ? candidate.envName : "", candidate.version].filter(Boolean).join(" · ");
              return (
                <div key={key} className="kulo-settings-list-row">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="kulo-item-title break-words">{candidate.label}</span>
                    {meta && <span className="kulo-item-description break-words">{meta}</span>}
                    {rowError && <span role="alert" className="break-words text-xs text-danger">{rowError}</span>}
                  </div>
                  {isConnected ? (
                    <Chip size="sm" variant="soft" color="success" className="shrink-0 whitespace-nowrap">
                      {t("已连接", "Connected")}
                    </Chip>
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
                      {rowError ? t("重试", "Retry") : t("连接", "Connect")}
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
            {missingLabels.join(" · ")}
          </p>
        )}
        {connectedCount > 0 && (
          <p role="status" className="text-xs text-muted">
            {t(`已连接 ${connectedCount} 个客户端`, `Connected ${connectedCount} client(s)`)}
          </p>
        )}
      </Card.Content>
      <Card.Footer className="flex-wrap justify-end gap-2">
        {onClose && (
          <Button size="sm" variant="tertiary" isDisabled={connectingAll || connectingKey !== null} onPress={onClose}>
            {t("关闭", "Close")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          isPending={scanning}
          isDisabled={!connected || disabled || connectingAll || connectingKey !== null}
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
      </Card.Footer>
    </Card>
  );
}

function PersonalAgentConnectCard({
  clientId,
  connected,
  disabled = false,
  envs,
  api = kuloRest,
  onClose,
  onConnected,
}: ExternalAgentConnectCardProps) {
  const { t } = useI18n();
  const onlineDevices = useMemo(
    () => envs.filter((env) => env.online && env.executionKind !== "native-device"),
    [envs],
  );
  const [selectedEnvId, setSelectedEnvId] = useState(() => onlineDevices[0]?.id ?? "");
  const [cdpUrl, setCdpUrl] = useState("");
  const [agentRef, setAgentRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [savedLabel, setSavedLabel] = useState<string>();
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
    if (!onlineDevices.some((device) => device.id === selectedEnvId)) {
      setSelectedEnvId(onlineDevices[0]!.id);
    }
  }, [onlineDevices, selectedEnvId]);

  const effectiveEnvId = selectedEnvId || onlineDevices[0]?.id || "";
  const blocked = !connected || disabled || busy;

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
        <div className="flex items-center justify-between gap-2">
          <span className="kulo-item-title">Grok Bot</span>
          <Chip size="sm" variant="soft" color="warning">{t("实验", "Experimental")}</Chip>
        </div>
        <div className="kulo-form-stack">
          {onlineDevices.length > 1 && (
            <Select
              className="kulo-form-field"
              variant="primary"
              value={effectiveEnvId || null}
              onChange={(key) => setSelectedEnvId(String(key ?? ""))}
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
