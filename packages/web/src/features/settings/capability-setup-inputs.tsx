import { useI18n, translate } from "../../kulo-i18n";
import { useEffect, useState } from "react";
import { Button, Card, Input, Label, TextField } from "@heroui/react";
import { redactSecrets, type EnvNodeDescriptor, type SettingsAssistantContext, type SetupInputRequest } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";

export function safeSetupInputError(error: unknown, secret = ""): string {
  let message = error instanceof Error ? error.message : translate("提交失败，请重试。", "Submission failed. Please retry.");
  for (const value of [secret, secret.trim()]) {
    if (value) message = message.split(value).join(translate("[已隐藏]", "[Hidden]"));
  }
  return redactSecrets(message);
}

export function visibleSetupInputs(inputs: SetupInputRequest[], clientId: string, target?: SettingsAssistantContext["target"]): SetupInputRequest[] {
  return inputs.filter((input) => input.status === "pending" && input.clientId === clientId &&
    (!target || target.kind === "capability" && input.capabilityId === target.id));
}

export async function submitSetupInput(request: SetupInputRequest, clientId: string, value: string, cancel = false): Promise<void> {
  if (request.clientId !== clientId) throw new Error(translate("请在发起配置的窗口继续。", "Continue in the window where setup was started."));
  if (request.status !== "pending" || request.expiresAt <= Date.now()) throw new Error(translate("请求已过期，请重新发起。", "This request has expired. Please start again."));
  if (cancel) { await kuloRest.submitCapabilityInput(request.id, { clientId, cancel: true }); return; }
  if (request.kind === "browser") { await kuloRest.completeCapabilityBrowserInput(request.id, clientId); return; }
  if (!value.trim()) throw new Error(translate("请输入密钥。", "Enter a key."));
  await kuloRest.submitCapabilityInput(request.id, { clientId, secret: value });
}

function SetupInput({ request, clientId, connected, envs, onChanged, onCompleted }: {
  request: SetupInputRequest;
  clientId: string;
  connected: boolean;
  envs: EnvNodeDescriptor[];
  onChanged: () => void;
  onCompleted?: (request: SetupInputRequest) => void;
}) {
  const { t } = useI18n();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(request.expiresAt <= Date.now());
  useEffect(() => {
    const expire = () => { setExpired(true); setSecret(""); };
    if (request.expiresAt <= Date.now()) { expire(); return; }
    const timer = setTimeout(expire, Math.min(request.expiresAt - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [request.expiresAt]);
  useEffect(() => { if (!connected) setSecret(""); }, [connected]);
  const submit = async (cancel = false) => {
    if (busy || !connected || expired) return;
    setBusy(true); setError(null);
    try {
      await submitSetupInput(request, clientId, secret, cancel);
      onChanged();
      if (!cancel) onCompleted?.(request);
    } catch (cause) { setError(safeSetupInputError(cause, secret)); }
    finally { setSecret(""); setBusy(false); }
  };
  const deviceName = envs.find((env) => env.id === request.envId)?.name ?? request.envId;
  return <Card variant="secondary" className="gap-3 rounded-2xl p-3" aria-label={request.label}>
    <Card.Header><Card.Title className="text-sm">{request.label}</Card.Title></Card.Header>
    <Card.Content className="kulo-form-stack">
      {request.kind === "secret" ? <TextField variant="primary" type="password" value={secret} onChange={setSecret} isDisabled={!connected || busy || expired} className="kulo-context-field min-w-0">
        <Label className="sr-only">{request.label}</Label>
        <Input autoComplete="new-password" spellCheck={false} placeholder={t("输入 API Key", "Enter an API key")} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
        }} />
      </TextField> : <p className="text-xs text-muted">{deviceName ? t(`在 ${deviceName} 的主 Chrome 中授权 Flow 标签页`, `Authorize the Flow tab in primary Chrome on ${deviceName}`) : t("在主 Chrome 中授权 Flow 标签页", "Authorize the Flow tab in primary Chrome")}</p>}
      {expired && <p className="text-xs text-warning" role="status">{t("请求已过期，请重新发起", "This request has expired. Please start again.")}</p>}
      {error && <p className="break-words text-xs text-danger" role="alert">{error}</p>}
    </Card.Content>
    <Card.Footer className="justify-end gap-2">
      <Button size="sm" variant="tertiary" isDisabled={!connected || busy || expired} onPress={() => void submit(true)}>{t("取消", "Cancel")}</Button>
      <Button size="sm" variant="secondary" isPending={busy} isDisabled={!connected || busy || expired || request.kind === "secret" && !secret.trim()} onPress={() => void submit()}>{request.kind === "secret" ? t("保存密钥", "Save key") : t("已连接", "Connected")}</Button>
    </Card.Footer>
  </Card>;
}

export function CapabilitySetupInputs({ inputs, clientId, target, ...props }: {
  inputs: SetupInputRequest[];
  clientId: string;
  target?: SettingsAssistantContext["target"];
  connected: boolean;
  envs: EnvNodeDescriptor[];
  onChanged: () => void;
  onCompleted?: (request: SetupInputRequest) => void;
}) {
  return <>{visibleSetupInputs(inputs, clientId, target).map((request) => <SetupInput key={`${request.id}:${request.expectedRevision}`} request={request} clientId={clientId} {...props} />)}</>;
}
