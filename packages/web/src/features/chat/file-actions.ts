import type { ChatAttachment } from "@kulo/protocol";
import { ensureMediaSession, getAuthTokenFromUrl } from "../../kulo-api";
import { translate as tr } from "../../kulo-i18n";
import type { DesktopPreferencesBridge } from "../settings/desktop-preferences";
import type { DesktopSystemPermissionBridge } from "../system-permissions/system-permissions";
import type { AppShortcutCommand } from "../shortcuts/shortcuts";

export interface DesktopNotificationBridgePayload {
  title: string;
  body?: string;
  topicId?: string;
  eventId?: string;
  dedupeKey?: string;
  force?: boolean;
  soundOverride?: boolean;
}

export interface DesktopPickDirectoryOptions {
  defaultPath?: string;
}

export interface DesktopFileBridge {
  ready?(): Promise<void>;
  onCommand?(listener: (command: AppShortcutCommand) => void): () => void;
  notify?(payload: DesktopNotificationBridgePayload): Promise<boolean | void>;
  setBadge?(count: number | boolean): Promise<void>;
  onNotificationOpen?(listener: (target: { topicId: string }) => void): () => void;
  preferences?: DesktopPreferencesBridge;
  systemPermissions?: DesktopSystemPermissionBridge;
  pickDirectory?(options?: DesktopPickDirectoryOptions): Promise<string | null>;
  openFile(assetId: string, target: "default" | "browser"): Promise<void>;
  saveFile(assetId: string): Promise<"saved" | "canceled">;
}

declare global {
  interface Window { kuloDesktop?: DesktopFileBridge }
}

export function desktopFileBridge(): DesktopFileBridge | undefined {
  return typeof window === "undefined" ? undefined : window.kuloDesktop;
}

export function fileAssetUrl(assetId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(assetId)) throw new Error(tr("文件编号无效", "Invalid file identifier"));
  return `/api/uploads/${encodeURIComponent(assetId)}`;
}

export function htmlPreviewUrl(assetId: string): string {
  return `${fileAssetUrl(assetId)}/preview`;
}

export async function readFileAsset(assetId: string, signal?: AbortSignal, preview = false): Promise<Response> {
  const token = getAuthTokenFromUrl();
  const response = await fetch(preview ? htmlPreviewUrl(assetId) : fileAssetUrl(assetId), {
    ...(preview ? { method: "HEAD" } : {}),
    credentials: "same-origin",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    let message = tr(`文件读取失败（${response.status}）`, `Unable to read file (${response.status})`);
    if (!preview) {
      const body = await response.text();
      try { message = (JSON.parse(body) as { error?: string }).error || message; }
      catch { /* Gateways may return a non-JSON error; retain the HTTP status. */ }
    }
    throw new Error(message);
  }
  return response;
}

export async function prepareHtmlPreview(assetId: string, signal?: AbortSignal): Promise<string> {
  await ensureMediaSession();
  signal?.throwIfAborted();
  await readFileAsset(assetId, signal, true);
  return htmlPreviewUrl(assetId);
}

export async function downloadFileAsset(asset: ChatAttachment, signal?: AbortSignal): Promise<void> {
  const desktop = desktopFileBridge();
  if (desktop) { await desktop.saveFile(asset.id); return; }
  const blob = await (await readFileAsset(asset.id, signal)).blob();
  signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = asset.name;
  anchor.click();
  // Keep the URL alive until the browser has consumed the download navigation.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function openFileInDefaultApp(assetId: string, signal?: AbortSignal): Promise<void> {
  fileAssetUrl(assetId);
  signal?.throwIfAborted();
  const desktop = desktopFileBridge();
  if (!desktop) throw new Error(tr("请下载文件后用默认应用打开", "Download the file to open it in your default app"));
  await desktop.openFile(assetId, "default");
}

export async function openHtmlInBrowser(assetId: string, signal?: AbortSignal): Promise<void> {
  const desktop = desktopFileBridge();
  if (desktop) { await desktop.openFile(assetId, "browser"); return; }
  // Reserve the tab during the user gesture, before the authenticated preparation awaits.
  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error(tr("浏览器阻止了新窗口，请允许弹出窗口后重试", "Allow pop-ups in your browser and retry"));
  tab.opener = null;
  try {
    const url = await prepareHtmlPreview(assetId, signal);
    if (!tab.closed) tab.location.replace(url.replace(/\/preview$/, "/view"));
  } catch (error) {
    tab.close();
    throw error;
  }
}
