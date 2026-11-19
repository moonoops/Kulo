import { useEffect, useRef, type Ref } from "react";
import { Alert, Button } from "@heroui/react";
import { translate as tr, useI18n } from "../../moco-i18n";
import { requestSystemPermissionHelp } from "../system-permissions/system-permissions";
import type { ActiveVoiceCall } from "./use-voice-call";
import { useVoiceWorkspace } from "./voice-context";

export function isFailedVoiceCall(call: ActiveVoiceCall | null | undefined): call is ActiveVoiceCall & { error: string } {
  return Boolean(call && call.state === "ended" && call.error);
}

export function VoiceCallErrorAlert({ call, retryDisabled = false, onRetry, onDismiss, closeButtonRef }: {
  call: ActiveVoiceCall | null;
  retryDisabled?: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  closeButtonRef?: Ref<HTMLButtonElement>;
}) {
  useI18n();
  if (!isFailedVoiceCall(call)) return null;
  const title = call.startedAt !== undefined
    ? tr("语音通话已中断", "Voice call interrupted")
    : tr("无法开始语音通话", "Could not start voice call");

  return (
    <div className="shrink-0 px-4 pt-3">
      <Alert status="danger" role="alert" className="flex flex-wrap items-start gap-3 rounded-2xl p-3">
        <div className="flex min-w-0 flex-1 basis-48 items-start gap-3">
          <Alert.Indicator className="mt-0.5 shrink-0" />
          <Alert.Content className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Alert.Title className="font-semibold">{title}</Alert.Title>
            <Alert.Description className="scrollbar block max-h-24 w-full overflow-y-auto break-words text-xs">
              {call.error}
            </Alert.Description>
          </Alert.Content>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {call.permissionRequired && (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => requestSystemPermissionHelp({ kind: "microphone" })}
            >
              {tr("检查权限", "Check permissions")}
            </Button>
          )}
          <Button size="sm" variant="primary" isDisabled={retryDisabled} onPress={onRetry}>
            {tr("重新通话", "Call again")}
          </Button>
          <Button ref={closeButtonRef} size="sm" variant="ghost" onPress={onDismiss}>
            {tr("关闭", "Close")}
          </Button>
        </div>
      </Alert>
    </div>
  );
}

export function VoiceCallErrorBanner({ connected, onOpenCall, onErrorShown, onAfterDismiss }: {
  connected: boolean;
  onOpenCall?: () => void;
  onErrorShown?: () => void;
  onAfterDismiss?: () => void;
}) {
  useI18n();
  const voice = useVoiceWorkspace();
  const call = voice?.call.call ?? null;
  const failedCall = isFailedVoiceCall(call) ? call : null;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onErrorShownRef = useRef(onErrorShown);
  onErrorShownRef.current = onErrorShown;
  const errorKey = failedCall ? `${failedCall.target.topicId}:${failedCall.startedAt ?? "init"}:${failedCall.error}` : null;

  useEffect(() => {
    if (!errorKey) return;
    onErrorShownRef.current?.();
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      const typing = active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || (active instanceof HTMLElement && active.isContentEditable);
      if (!typing) closeButtonRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [errorKey]);

  if (!failedCall || !voice) return null;
  const retryDisabled = !connected || Boolean(voice.loading) || Boolean(voice.recordingActive);
  return (
    <VoiceCallErrorAlert
      call={failedCall}
      retryDisabled={retryDisabled}
      closeButtonRef={closeButtonRef}
      onRetry={() => {
        if (retryDisabled) return;
        onOpenCall?.();
        void voice.call.start(failedCall.target);
      }}
      onDismiss={() => {
        voice.call.hangup();
        onAfterDismiss?.();
      }}
    />
  );
}
