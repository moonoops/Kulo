import { translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useRef, useState } from "react";
import { Button, Card, Spinner } from "@heroui/react";
import { redactSensitiveText, type ConnectionRecordView } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";

export type ConnectionFollowupState = { phase: "checking" } | { phase: "trust"; fingerprint: string } | { phase: "ready" } | { phase: "error"; error: string };

export function connectionFollowupResult(result: Awaited<ReturnType<typeof kuloRest.testConnection>>): ConnectionFollowupState {
  if (result.requiresTrust) return result.fingerprint ? { phase: "trust", fingerprint: result.fingerprint } : { phase: "error", error: t("缺少服务器指纹，请重新连接。", "Server fingerprint missing. Reconnect.") };
  if (result.connection.status === "verified") return { phase: "ready" };
  return { phase: "error", error: redactSensitiveText(result.connection.error || t("连接尚不可用，请重试。", "The connection is not available yet. Try again.")) };
}

export async function checkConnectionFollowup(id: string, fingerprint?: string): Promise<ConnectionFollowupState> {
  if (fingerprint) await kuloRest.trustConnection(id, fingerprint);
  return connectionFollowupResult(await kuloRest.testConnection(id));
}

export function ConnectionFollowup({ connection, connected, available, onChanged, onClose }: {
  connection: ConnectionRecordView;
  connected: boolean;
  available: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  useI18n();
  const [state, setState] = useState<ConnectionFollowupState>({ phase: "checking" });
  const generation = useRef(0);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const statusRef = useRef<HTMLDivElement>(null);
  const check = async (fingerprint?: string) => {
    const current = ++generation.current;
    if (!connected || !available) { setState({ phase: "error", error: !connected ? t("与中枢连接已断开。", "Disconnected from the hub.") : t("本地凭据库暂不可用。", "The local credential vault is unavailable.") }); return; }
    setState({ phase: "checking" });
    try {
      const next = await checkConnectionFollowup(connection.id, fingerprint);
      if (generation.current === current) { setState(next); onChangedRef.current(); }
    } catch (cause) {
      if (generation.current === current) setState({ phase: "error", error: redactSensitiveText(cause instanceof Error ? cause.message : t("连接失败，请重试。", "Connection failed. Try again.")) });
    }
  };
  useEffect(() => {
    void check();
    return () => { generation.current++; };
  }, [connection.id, connection.revision, connected, available]);
  useEffect(() => { if (state.phase !== "checking") statusRef.current?.focus(); }, [state.phase]);

  return <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-3" aria-label={t("SSH 连接确认", "Confirm SSH connection")}>
    <Card.Header><Card.Title className="text-sm">{connection.name}</Card.Title></Card.Header>
    <Card.Content ref={statusRef} tabIndex={-1} className="min-w-0 rounded-lg text-xs outline-offset-4">
      {state.phase === "checking" ? <span className="flex items-center gap-2 text-muted" role="status"><Spinner size="sm" />{t("正在连接…", "Connecting…")}</span>
        : state.phase === "trust" ? <div className="space-y-2"><p>{t("核对服务器指纹", "Verify server fingerprint")}</p><p className="break-all font-mono">{state.fingerprint}</p></div>
        : state.phase === "error" ? <p className="break-words text-danger" role="alert">{state.error}</p>
        : <p role="status">{t("连接已就绪", "Connection ready")}</p>}
    </Card.Content>
    <Card.Footer className="justify-end gap-2">
      <Button size="sm" variant="tertiary" isDisabled={state.phase === "checking"} onPress={onClose}>{state.phase === "ready" ? t("完成", "Done") : t("关闭", "Close")}</Button>
      {state.phase === "trust" && <Button size="sm" variant="secondary" isDisabled={!connected || !available} onPress={() => void check(state.fingerprint)}>{t("信任并连接", "Trust and connect")}</Button>}
      {state.phase === "error" && <Button size="sm" variant="secondary" isDisabled={!connected || !available} onPress={() => void check()}>{t("重试连接", "Retry connection")}</Button>}
    </Card.Footer>
  </Card>;
}
