import { translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Alert, Button, Card, Spinner } from "@heroui/react";
import {
  redactSensitiveText,
  type ConnectionRecordView,
  type ConnectionTestErrorCode,
  type ConnectionTestResult,
} from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { openNativeAppPermissionSettings } from "../system-permissions/system-permissions";
import { nativePermissionPromptMessage } from "./connection-setup-inputs";

export type ConnectionFollowupState =
  | { phase: "checking" }
  | { phase: "trust"; fingerprint: string; hostMismatch?: boolean; previousFingerprint?: string }
  | { phase: "ready" }
  | { phase: "error"; error: string; errorCode?: ConnectionTestErrorCode; hostMismatch?: boolean; previousFingerprint?: string };

export interface ConnectionFollowupCheckOptions {
  fingerprint?: string;
  rescan?: boolean;
}

export function connectionFollowupResult(result: ConnectionTestResult): ConnectionFollowupState {
  if (result.requiresTrust) {
    return result.fingerprint
      ? {
          phase: "trust",
          fingerprint: result.fingerprint,
          ...(result.hostMismatch ? { hostMismatch: true, previousFingerprint: result.previousFingerprint } : {}),
        }
      : { phase: "error", error: t("缺少服务器指纹，请重新连接。", "Server fingerprint missing. Reconnect.") };
  }
  if (result.connection.status === "verified") return { phase: "ready" };
  return {
    phase: "error",
    error: redactSensitiveText(result.connection.error || t("连接尚不可用，请重试。", "The connection is not available yet. Try again.")),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.hostMismatch ? { hostMismatch: true, previousFingerprint: result.previousFingerprint } : {}),
  };
}

export async function checkConnectionFollowup(
  id: string,
  options?: string | ConnectionFollowupCheckOptions,
): Promise<ConnectionFollowupState> {
  const normalized = typeof options === "string" ? { fingerprint: options } : (options ?? {});
  if (normalized.fingerprint) await kuloRest.trustConnection(id, normalized.fingerprint);
  return connectionFollowupResult(await kuloRest.testConnection(id, normalized.rescan ? { rescan: true } : undefined));
}

function extractErrorCode(cause: unknown): ConnectionTestErrorCode | undefined {
  if (!cause || typeof cause !== "object" || !("code" in cause) || typeof cause.code !== "string") return undefined;
  const known: readonly ConnectionTestErrorCode[] = [
    "connection_local_network_blocked",
    "connection_host_scan_failed",
    "connection_host_mismatch",
    "connection_auth_failed",
    "connection_key_invalid",
    "connection_program_unavailable",
    "connection_cancelled",
    "connection_execution_failed",
  ];
  return known.includes(cause.code as ConnectionTestErrorCode) ? (cause.code as ConnectionTestErrorCode) : undefined;
}

export function useConnectionFollowup({
  connection,
  connected,
  available,
  localHost,
  onChanged,
  openSettings = openNativeAppPermissionSettings,
}: {
  connection: ConnectionRecordView;
  connected: boolean;
  available: boolean;
  localHost?: boolean;
  onChanged: () => void;
  openSettings?: typeof openNativeAppPermissionSettings;
}) {
  const [state, setState] = useState<ConnectionFollowupState>({ phase: "checking" });
  const [openingSettings, setOpeningSettings] = useState(false);
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const statusRef = useRef<HTMLDivElement>(null);

  const check = async (options?: string | ConnectionFollowupCheckOptions) => {
    const current = ++generation.current;
    setPermissionNotice(null);
    if (!connected || !available) {
      setState({
        phase: "error",
        error: !connected ? t("与中枢连接已断开。", "Disconnected from the hub.") : t("本地凭据库暂不可用。", "The local credential vault is unavailable."),
      });
      return;
    }
    setState({ phase: "checking" });
    try {
      const next = await checkConnectionFollowup(connection.id, options);
      if (generation.current === current) {
        setState(next);
        onChangedRef.current();
      }
    } catch (cause) {
      if (generation.current === current) {
        const errorCode = extractErrorCode(cause);
        setState({
          phase: "error",
          error: redactSensitiveText(cause instanceof Error ? cause.message : t("连接失败，请重试。", "Connection failed. Try again.")),
          ...(errorCode ? { errorCode } : {}),
        });
        onChangedRef.current();
      }
    }
  };

  const openLocalNetworkSettings = async () => {
    if (!connected || openingSettings) return;
    setOpeningSettings(true);
    try {
      const outcome = await openSettings("local-network", { localHost });
      setPermissionNotice(nativePermissionPromptMessage("local-network", outcome, connection.name));
    } catch (cause) {
      const fallback = cause instanceof Error ? redactSensitiveText(cause.message) : undefined;
      setPermissionNotice(nativePermissionPromptMessage("local-network", "manual", connection.name, fallback));
    } finally {
      setOpeningSettings(false);
    }
  };

  useEffect(() => {
    void check();
    return () => { generation.current++; };
  }, [connection.id, connection.revision, connected, available]);

  useEffect(() => {
    if (state.phase !== "checking") statusRef.current?.focus();
  }, [state.phase]);

  useEffect(() => {
    if (permissionNotice) statusRef.current?.focus();
  }, [permissionNotice]);

  return { state, openingSettings, permissionNotice, statusRef, check, openLocalNetworkSettings };
}

export function ConnectionFollowupBody({
  state,
  permissionNotice,
  statusRef,
}: {
  state: ConnectionFollowupState;
  permissionNotice?: string | null;
  statusRef: RefObject<HTMLDivElement | null>;
}) {
  useI18n();
  return (
    <div ref={statusRef} tabIndex={-1} className="min-w-0 space-y-3 rounded-lg text-xs outline-offset-4">
      {state.phase === "checking" ? (
        <span className="flex items-center gap-2 text-muted" role="status">
          <Spinner size="sm" />
          {t("正在连接…", "Connecting…")}
        </span>
      ) : state.phase === "trust" ? (
        <div className="space-y-2">
          {state.hostMismatch ? (
            <Alert status="danger" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t("服务器指纹已变更", "Server fingerprint changed")}</Alert.Title>
                <Alert.Description>{t("核对新指纹无误后再信任。", "Verify the new fingerprint before trusting.")}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : (
            <p className="text-sm text-foreground">{t("核对服务器指纹", "Verify server fingerprint")}</p>
          )}
          {state.hostMismatch && state.previousFingerprint && (
            <div className="space-y-1">
              <p className="text-xs text-muted">{t("原指纹", "Previous fingerprint")}</p>
              <div className="break-all rounded-2xl bg-surface-secondary p-3 font-mono text-xs text-muted">{state.previousFingerprint}</div>
            </div>
          )}
          <div className="space-y-1">
            {state.hostMismatch && <p className="text-xs text-foreground">{t("新指纹", "New fingerprint")}</p>}
            <div className="break-all rounded-2xl bg-surface-secondary p-3 font-mono text-xs text-foreground">{state.fingerprint}</div>
          </div>
        </div>
      ) : state.phase === "error" ? (
        <div className="space-y-2">
          {state.hostMismatch ? (
            <Alert status="danger" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t("服务器指纹校验未通过", "Host key verification failed")}</Alert.Title>
                <Alert.Description className="break-words">{state.error}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : (
            <p className="break-words text-danger" role="alert">{state.error}</p>
          )}
          {permissionNotice && <p className="break-words text-xs text-muted" role="status">{permissionNotice}</p>}
        </div>
      ) : (
        <p className="text-sm text-foreground" role="status">{t("连接已就绪", "Connection ready")}</p>
      )}
    </div>
  );
}

export function ConnectionFollowupActions({
  state,
  connected,
  available,
  localHost,
  openingSettings,
  onClose,
  onCheck,
  onOpenLocalNetwork,
}: {
  state: ConnectionFollowupState;
  connected: boolean;
  available: boolean;
  localHost?: boolean;
  openingSettings: boolean;
  onClose: () => void;
  onCheck: (options?: ConnectionFollowupCheckOptions) => void;
  onOpenLocalNetwork: () => void;
}) {
  useI18n();
  const canAct = connected && available;
  return (
    <>
      <Button size="sm" variant="tertiary" isDisabled={state.phase === "checking" || openingSettings} onPress={onClose}>
        {state.phase === "ready" ? t("完成", "Done") : t("关闭", "Close")}
      </Button>
      {state.phase === "trust" && (
        <Button size="sm" variant={state.hostMismatch ? "danger" : "secondary"} isDisabled={!canAct} onPress={() => onCheck({ fingerprint: state.fingerprint })}>
          {state.hostMismatch ? t("信任新指纹并连接", "Trust new fingerprint and connect") : t("信任并连接", "Trust and connect")}
        </Button>
      )}
      {state.phase === "error" && state.errorCode === "connection_local_network_blocked" && localHost && (
        <Button size="sm" variant="secondary" isPending={openingSettings} isDisabled={!connected} onPress={onOpenLocalNetwork}>
          {t("打开系统设置", "Open System Settings")}
        </Button>
      )}
      {state.phase === "error" && state.hostMismatch && (
        <Button size="sm" variant="secondary" isDisabled={!canAct || openingSettings} onPress={() => onCheck({ rescan: true })}>
          {t("重新扫描指纹", "Rescan fingerprint")}
        </Button>
      )}
      {state.phase === "error" && !state.hostMismatch && (
        <Button size="sm" variant="secondary" isDisabled={!canAct || openingSettings} onPress={() => onCheck()}>
          {t("重试连接", "Retry connection")}
        </Button>
      )}
    </>
  );
}

export function ConnectionFollowup({
  connection,
  connected,
  available,
  localHost,
  onChanged,
  onClose,
}: {
  connection: ConnectionRecordView;
  connected: boolean;
  available: boolean;
  localHost?: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  useI18n();
  const { state, openingSettings, permissionNotice, statusRef, check, openLocalNetworkSettings } = useConnectionFollowup({
    connection,
    connected,
    available,
    localHost,
    onChanged,
  });

  return (
    <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-3" aria-label={t("SSH 连接确认", "Confirm SSH connection")}>
      <Card.Header><Card.Title className="text-sm">{connection.name}</Card.Title></Card.Header>
      <Card.Content className="min-w-0">
        <ConnectionFollowupBody state={state} permissionNotice={permissionNotice} statusRef={statusRef} />
      </Card.Content>
      <Card.Footer className="flex-wrap justify-end gap-2">
        <ConnectionFollowupActions
          state={state}
          connected={connected}
          available={available}
          localHost={localHost}
          openingSettings={openingSettings}
          onClose={onClose}
          onCheck={(options) => void check(options)}
          onOpenLocalNetwork={() => void openLocalNetworkSettings()}
        />
      </Card.Footer>
    </Card>
  );
}
