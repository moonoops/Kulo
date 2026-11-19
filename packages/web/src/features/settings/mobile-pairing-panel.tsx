import { getLanguage, translate as t, useI18n } from "../../moco-i18n";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Spinner, toast } from "@heroui/react";
import { QRCodeSVG } from "qrcode.react";
import type { DeviceInterconnectionView, MobileInvitation } from "@moco/protocol";
import { MocoApiError } from "../../moco-api";
import { MocoIcon } from "../../moco-icon";
import { copyDeviceText } from "./device-clipboard";
import { mobileDeviceApi, type MobileHostConnection } from "./device-api";
import "./mobile-pairing-panel.css";

type InvitationApi = { create(): Promise<MobileInvitation>; cancel(id: string): Promise<void> };

export class MobileInvitationCleanupError extends Error {
  constructor() { super(t("取消手机配对失败，请稍后重试。", "Failed to cancel phone pairing. Try again later.")); }
}

/** A create response can arrive after its tab closes, so it still needs revocation. */
export class MobileInvitationSession {
  #current?: MobileInvitation;
  #disposed = false;
  #pending?: Promise<MobileInvitation | undefined>;
  constructor(private readonly api: InvitationApi) {}

  async #cancel(id: string): Promise<void> {
    try { await this.api.cancel(id); }
    catch (error) {
      if (!(error instanceof MocoApiError && (error.status === 404 || error.status === 410))) {
        throw new MobileInvitationCleanupError();
      }
    }
  }

  async #revokeCurrent(): Promise<void> {
    if (!this.#current) return;
    const current = this.#current;
    await this.#cancel(current.id);
    if (this.#current?.id === current.id) this.#current = undefined;
  }

  generate(): Promise<MobileInvitation | undefined> {
    if (this.#pending) return this.#pending;
    const pending = this.#generate();
    this.#pending = pending;
    const clear = () => { if (this.#pending === pending) this.#pending = undefined; };
    void pending.then(clear, clear);
    return pending;
  }

  async #generate(): Promise<MobileInvitation | undefined> {
    await this.#revokeCurrent();
    if (this.#disposed) return;
    // Do not abort this POST: its response identifies the invitation to revoke.
    const next = await this.api.create();
    if (this.#disposed) {
      await this.#cancel(next.id);
      return;
    }
    this.#current = next;
    return next;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#revokeCurrent();
  }
}

export function validatedTailscaleLoginURL(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(t("主机尚未准备好 Tailscale 登录，请重试。", "The host is not ready for Tailscale sign-in. Try again.")); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(url.hostname === "tailscale.com" || url.hostname.endsWith(".tailscale.com"))) {
    throw new Error(t("Tailscale 登录地址无效。", "Invalid Tailscale sign-in URL."));
  }
  return url.href;
}

function tailscaleLabel(connection: MobileHostConnection): string {
  const { state, mode } = connection.tailscale;
  if (state === "Running") return mode === "system" ? t("已复用主机 Tailscale", "Using the host's existing Tailscale connection") : t("主机 Tailscale 在线", "Host Tailscale is online");
  if (state === "NeedsLogin") return t("主机需要登录 Tailscale", "Host Tailscale sign-in required");
  if (state === "NeedsMachineAuth") return t("等待批准主机 Tailscale 节点", "Waiting for host Tailscale node approval");
  if (state === "Starting" || state === "NoState") return t("正在准备主机 Tailscale", "Preparing host Tailscale");
  return t("主机远程连接尚未就绪", "Host remote connection is not ready");
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function MobilePairingPanel({ view, onInvitation, onRefresh }: {
  view: DeviceInterconnectionView;
  onInvitation: (deviceId: string) => void;
  onRefresh: () => Promise<void>;
}) {
  useI18n();
  const [connection, setConnection] = useState<MobileHostConnection>();
  const [invitation, setInvitation] = useState<MobileInvitation>();
  const [busy, setBusy] = useState(true);
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pollError, setPollError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const active = useRef(false);
  const session = useRef<MobileInvitationSession | null>(null);
  const statusAbort = useRef<AbortController | null>(null);
  const loginAbort = useRef<AbortController | null>(null);
  const callbacks = useRef({ onInvitation, onRefresh });
  callbacks.current = { onInvitation, onRefresh };
  const target = view.devices.find((device) => device.id === invitation?.deviceId);
  const paired = !!target && target.status !== "pending";
  const expired = !!invitation && now >= invitation.expiresAt && !paired;
  const owner = view.role === "hub";

  const generate = async () => {
    const current = session.current;
    if (!current || !active.current) return;
    const isCurrent = () => active.current && session.current === current;
    setBusy(true);
    setError(undefined);
    try {
      statusAbort.current?.abort();
      const controller = new AbortController();
      statusAbort.current = controller;
      const status = await mobileDeviceApi.connection(controller.signal);
      if (!isCurrent() || controller.signal.aborted) return;
      setConnection(status);
      setPollError(undefined);
      const next = await current.generate();
      if (!next || !isCurrent()) return;
      setInvitation(next);
      setNow(Date.now());
      callbacks.current.onInvitation(next.deviceId);
      await callbacks.current.onRefresh();
    } catch (cause) {
      if (isCurrent()) setError(readableError(cause, t("准备手机配对失败。", "Failed to prepare phone pairing.")));
      else if (cause instanceof MobileInvitationCleanupError) toast.danger(cause.message);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  useEffect(() => {
    if (!owner) { setBusy(false); return; }
    active.current = true;
    const current = new MobileInvitationSession({ create: mobileDeviceApi.invite, cancel: mobileDeviceApi.cancelInvite });
    session.current = current;
    void generate();
    return () => {
      active.current = false;
      statusAbort.current?.abort();
      loginAbort.current?.abort();
      void current.dispose().catch((cause: unknown) => toast.danger(readableError(cause, t("取消手机配对失败。", "Failed to cancel phone pairing."))));
    };
  }, [owner]);

  useEffect(() => {
    if (!owner || busy) return;
    let running = false;
    let pollController: AbortController | undefined;
    const current = session.current;
    const timer = window.setInterval(() => {
      if (running || !active.current) return;
      running = true;
      const controller = new AbortController();
      pollController = controller;
      void mobileDeviceApi.connection(controller.signal).then((status) => {
        if (active.current && session.current === current && !controller.signal.aborted) {
          setConnection(status);
          setPollError(undefined);
        }
      }).catch((cause: unknown) => {
        if (active.current && session.current === current && !controller.signal.aborted) setPollError(readableError(cause, t("读取主机连接状态失败。", "Failed to load host connection status.")));
      }).finally(() => { running = false; });
    }, 3_000);
    return () => { window.clearInterval(timer); pollController?.abort(); };
  }, [owner, busy]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const login = async () => {
    if (loginBusy) return;
    const popup = window.open("about:blank", "_blank");
    if (!popup) { setError(t("请允许浏览器弹出登录窗口后重试。", "Allow the sign-in popup in your browser, then try again.")); return; }
    popup.opener = null;
    setLoginBusy(true);
    setError(undefined);
    const controller = new AbortController();
    loginAbort.current = controller;
    try {
      const result = await mobileDeviceApi.login(controller.signal);
      if (!active.current || controller.signal.aborted) { popup.close(); return; }
      popup.location.replace(validatedTailscaleLoginURL(result.authURL));
    } catch (cause) {
      popup.close();
      if (active.current && !controller.signal.aborted) setError(readableError(cause, t("打开 Tailscale 登录失败。", "Failed to open Tailscale sign-in.")));
    } finally {
      if (active.current) setLoginBusy(false);
    }
  };

  const copy = async () => {
    if (!invitation || expired || paired) return;
    try { await copyDeviceText(invitation.qrValue); toast.success(t("配对链接已复制", "Pairing link copied")); }
    catch (cause) { setError(readableError(cause, t("复制配对链接失败。", "Failed to copy pairing link."))); }
  };

  if (!owner) return <Alert status="warning"><Alert.Indicator /><Alert.Content><Alert.Title>{t("请在主机上添加手机", "Add a phone from the host device")}</Alert.Title></Alert.Content></Alert>;

  return <div className="moco-mobile-pairing">
    {(error || pollError) && <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>{error ?? pollError}</Alert.Title></Alert.Content>
      <Button variant="tertiary" size="sm" isDisabled={busy} onPress={() => void generate()}>{t("重试", "Retry")}</Button>
    </Alert>}
    {busy && <div className="moco-mobile-pairing-status" role="status"><Spinner size="sm" />{t("正在准备手机配对", "Preparing phone pairing")}</div>}
    {!busy && invitation && !expired && !paired && <>
      <div className="moco-mobile-pairing-qr" role="img" aria-label={t("用 Moco 安卓 App 扫描配对二维码", "Scan the pairing code with the Moco Android app")}>
        <QRCodeSVG value={invitation.qrValue} size={280} level="M" marginSize={4} title={t("Moco 手机配对二维码", "Moco phone pairing QR code")} />
      </div>
      <div className="moco-mobile-pairing-status" role="status"><Spinner size="sm" />{t("等待手机扫码", "Waiting for phone to scan")}<span>{t(`${new Date(invitation.expiresAt).toLocaleTimeString(getLanguage(), { hour: "2-digit", minute: "2-digit" })} 前有效`, `Valid until ${new Date(invitation.expiresAt).toLocaleTimeString(getLanguage(), { hour: "2-digit", minute: "2-digit" })}`)}</span></div>
    </>}
    {paired && <div className="moco-mobile-pairing-status" role="status"><Spinner size="sm" />{t("已配对，等待手机连接", "Paired; waiting for phone connection")}</div>}
    {expired && <Alert status="warning"><Alert.Indicator /><Alert.Content><Alert.Title>{t("二维码已过期", "QR code expired")}</Alert.Title></Alert.Content></Alert>}
    {connection && <div className="moco-mobile-pairing-network">
      <span role="status">{tailscaleLabel(connection)}</span>
      {(connection.tailscale.loginAvailable || connection.tailscale.state === "NeedsLogin") &&
        <Button size="sm" variant="secondary" isPending={loginBusy} isDisabled={busy || loginBusy} onPress={() => void login()}>{t("登录 Tailscale", "Sign in to Tailscale")}</Button>}
      {!connection.candidates.length && <span className="text-sm text-muted">{t("尚无连接入口，请先完成主机远程配置。", "No connection endpoint is available. Complete remote setup on the host first.")}</span>}
    </div>}
    {!busy && !paired && <div className="moco-mobile-pairing-actions">
      <Button size="sm" variant={expired || !invitation ? "primary" : "tertiary"} onPress={() => void generate()}><MocoIcon name="refresh" size={14} />{expired || !invitation ? t("生成二维码", "Generate QR code") : t("刷新二维码", "Refresh QR code")}</Button>
      {invitation && !expired && <Button size="sm" variant="secondary" onPress={() => void copy()}><MocoIcon name="copy" size={14} />{t("复制配对链接", "Copy pairing link")}</Button>}
    </div>}
  </div>;
}
