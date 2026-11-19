import { useEffect, useMemo, useRef, useState } from "react";
import { parseStandaloneDeviceInvitation, redactDeviceInvitationText, SENSITIVE_TEXT_REDACTION, type DeviceInterconnectionView } from "@kulo/protocol";
import { KuloApiError } from "../../kulo-api";
import { translate as t } from "../../kulo-i18n";
import { deviceApi, newDeviceTransitionId } from "../settings/device-api";

type Invitation = NonNullable<ReturnType<typeof parseStandaloneDeviceInvitation>>;
type JoinPhase = "preview" | "joining" | "conflict" | "retry" | "blocked";

export interface ComposerDeviceJoin {
  preview: string;
  sameHost?: boolean;
  phase: JoinPhase;
  message?: string;
  submit: () => void;
  confirmStop: () => void;
  cancel: () => void;
}

type JoinAttempt = {
  key: string;
  input: string;
  id: string;
  source?: string;
  forced?: boolean;
  phase: JoinPhase;
  message?: string;
  unconfirmed?: boolean;
};

function targetLabel(invitation: Invitation): string {
  const address = new URL(invitation.hubUrl).host;
  return invitation.hubName && invitation.hubName !== address
    ? t(`${invitation.hubName}（${address}）`, `${invitation.hubName} (${address})`) : address;
}

export function previewChatDeviceJoin(invitation: Invitation, view?: DeviceInterconnectionView) {
  const label = targetLabel(invitation);
  // Use addresses reported by the current authenticated local view. The invitation's hubId is sender-supplied.
  if (view?.currentDeviceKnown && view.hubUrls.some((url) => url.replace(/\/$/u, "") === invitation.hubUrl)) {
    if (view.role === "hub") return { kind: "self", text: t("这是本机的邀请，请在另一台 Kulo 发送。", "This invitation is from this device. Send it in the other Kulo.") } as const;
    const name = targetLabel({ ...invitation, hubName: view.hubName });
    if (view.hubError) return { kind: "reconnect", text: t(`重新连接 ${name}`, `Reconnect to ${name}`) } as const;
    return { kind: "same", text: t(`已连接到 ${name}`, `Already connected to ${name}`) } as const;
  }
  if (view?.role === "joined") {
    const from = view.hubName || view.hubUrls[0] || t("当前主机", "current host");
    return { kind: "switch", text: t(`将本机从 ${from} 切换到 ${label}`, `Switch this device from ${from} to ${label}`) } as const;
  }
  return { kind: "join", text: t(`将本机接入 ${label}`, `Join this device to ${label}`) } as const;
}

const localClientRequired = () => t("请在要接入的电脑上打开本机 Kulo 并发送这条邀请。", "Open the local Kulo on the computer you want to join and send this invitation there.");

export function deviceJoinFeedback(error: unknown, inviteToken?: string): Pick<JoinAttempt, "phase" | "message" | "unconfirmed"> {
  const hide = (message: string) => {
    const redacted = redactDeviceInvitationText(message);
    return inviteToken ? redacted.replaceAll(inviteToken, SENSITIVE_TEXT_REDACTION) : redacted;
  };
  if (error instanceof KuloApiError) {
    switch (error.code) {
      case "local_tasks_running":
        return { phase: "conflict", message: hide(error.message) };
      case "device_invitation_invalid":
        return { phase: "blocked", message: t("邀请已失效，请在主 Kulo 重新复制。", "This invitation is invalid or expired. Copy a new one from the host Kulo.") };
      case "device_host_unreachable":
        return { phase: "retry", message: t("连不上目标主机，请确认主 Kulo 在线后重试。", "The host is unreachable. Check that the host Kulo is online and retry.") };
      case "role_transition_unconfirmed":
        return { phase: "retry", message: hide(error.message), unconfirmed: true };
    }
  }
  return { phase: "retry", message: error instanceof TypeError
    ? t("暂时无法连接本机 Kulo，请重试。", "The local Kulo is unreachable. Try again.")
    : error instanceof Error ? hide(error.message) : t("接入失败，请重试。", "Could not join the host. Try again.") };
}

function localDeviceIdentity(view: DeviceInterconnectionView): string {
  return JSON.stringify([view.role, view.hubId, view.currentDeviceId]);
}

export function requiresNewSwitchPreview(invitation: Invitation, actual: DeviceInterconnectionView, shown?: DeviceInterconnectionView): boolean {
  if (previewChatDeviceJoin(invitation, actual).kind !== "switch") return false;
  return !shown || localDeviceIdentity(shown) !== localDeviceIdentity(actual) || previewChatDeviceJoin(invitation, shown).kind !== "switch";
}

export function useChatDeviceJoin(options: {
  enabled: boolean;
  draftKey: string;
  draft: string;
  onSource: (view: DeviceInterconnectionView) => void;
  onConsume: (draftKey: string, input: string) => void;
  onJoined: (target: string) => void;
}): ComposerDeviceJoin | undefined {
  const { enabled, draftKey, draft } = options;
  const invitation = useMemo(() => enabled ? parseStandaloneDeviceInvitation(draft) : undefined, [enabled, draft]);
  const [attempt, setAttempt] = useState<JoinAttempt>();
  const [lookup, setLookup] = useState<{ key: string; input: string; view?: DeviceInterconnectionView; error?: string }>();
  const flight = useRef<AbortController | undefined>(undefined);
  const previewRequest = useRef<AbortController | undefined>(undefined);
  const callbacks = useRef(options);
  callbacks.current = options;
  useEffect(() => () => { flight.current?.abort(); }, []);
  const current = attempt?.key === draftKey && attempt.input === draft ? attempt : undefined;
  const local = lookup?.key === draftKey && lookup.input === draft ? lookup : undefined;
  useEffect(() => {
    if (!invitation) { setLookup(undefined); return; }
    const controller = new AbortController();
    previewRequest.current = controller;
    void deviceApi.get(controller.signal).then((view) => {
      if (!controller.signal.aborted) setLookup({ key: draftKey, input: draft, view });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setLookup({ key: draftKey, input: draft, error: deviceJoinFeedback(error, invitation.inviteToken).message });
    });
    return () => controller.abort();
  }, [draftKey, draft, invitation]);
  useEffect(() => {
    if (attempt && !current && !flight.current) setAttempt(undefined);
  }, [attempt, current]);
  if (!invitation) return undefined;

  const label = targetLabel(invitation);
  const preview = previewChatDeviceJoin(invitation, local?.view);
  const forbidden = local?.view && (!local.view.currentDeviceKnown || !local.view.canSwitchRole);
  const submit = async (force: boolean) => {
    if (flight.current || forbidden || preview.kind === "self" || current?.phase === "blocked" || force !== (current?.phase === "conflict")) return;
    const controller = new AbortController();
    flight.current = controller;
    previewRequest.current?.abort();
    // A lost acknowledgement can be replayed with its original id. A terminal failure needs a fresh attempt.
    const id = current?.unconfirmed ? current.id : newDeviceTransitionId();
    const next: JoinAttempt = { key: draftKey, input: draft, id, phase: "joining" };
    setAttempt(next);
    let source: string | undefined;
    let forced = force;
    let posted = false;
    try {
      const view = await deviceApi.get(controller.signal);
      if (controller.signal.aborted) return;
      setLookup({ key: draftKey, input: draft, view });
      if (!view.currentDeviceKnown || !view.canSwitchRole) {
        setAttempt({ ...next, phase: "blocked", message: localClientRequired() });
        return;
      }
      source = localDeviceIdentity(view);
      const latest = previewChatDeviceJoin(invitation, view);
      if (latest.kind === "self" || force && current?.source !== source || requiresNewSwitchPreview(invitation, view, local?.view)) {
        // A click before the preview loaded (or after a local role change) cannot authorize replacing an unseen host.
        setAttempt(undefined);
        return;
      }
      callbacks.current.onSource(view);
      forced ||= Boolean(current?.unconfirmed && current.forced && current.source === source);
      posted = true;
      await deviceApi.join(draft, forced, undefined, controller.signal, id);
      if (controller.signal.aborted) return;
      callbacks.current.onConsume(draftKey, draft);
      callbacks.current.onJoined(label);
      setAttempt(undefined);
    } catch (error) {
      if (!controller.signal.aborted) setAttempt({
        ...next, source: source ?? current?.source, forced: posted ? forced : current?.forced,
        ...(!posted && current?.unconfirmed ? { unconfirmed: true } : {}), ...deviceJoinFeedback(error, invitation.inviteToken),
      });
    } finally {
      if (flight.current === controller) flight.current = undefined;
    }
  };
  return {
    preview: preview.text,
    sameHost: preview.kind === "same",
    phase: current?.phase ?? (forbidden || preview.kind === "self" ? "blocked" : local?.error ? "retry" : "preview"),
    message: current?.message ?? (forbidden ? localClientRequired() : local?.error),
    submit: () => { void submit(false); },
    confirmStop: () => { void submit(true); },
    cancel: () => {
      if (flight.current) return;
      setAttempt(undefined);
      callbacks.current.onConsume(draftKey, draft);
    },
  };
}
