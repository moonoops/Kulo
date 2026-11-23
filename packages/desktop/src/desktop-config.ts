import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BrowserWindowConstructorOptions } from "electron";
import { hasDesktopForbiddenPosixPermissions, safeDesktopChmodSync } from "./desktop-fs.js";

export const DESKTOP_APP_NAME = "Kulo Dev";
export const DESKTOP_BUNDLE_ID = "io.kulo.desktop.dev";
export const DESKTOP_RELEASE_APP_NAME = "Kulo";
export const DESKTOP_RELEASE_BUNDLE_ID = "io.kulo.desktop";

export type DesktopAppChannel = "dev" | "release";

export interface DesktopAppIdentity {
  channel: DesktopAppChannel;
  appName: string;
  bundleId: string;
  sessionPartition: string;
}

export function resolveDesktopAppIdentity(packageJsonPath?: string): DesktopAppIdentity {
  const manifestPath = packageJsonPath ?? fileURLToPath(new URL("../package.json", import.meta.url));
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { productName?: unknown; kuloChannel?: unknown };
    if (manifest.kuloChannel === "release" || manifest.productName === DESKTOP_RELEASE_APP_NAME) {
      return {
        channel: "release",
        appName: DESKTOP_RELEASE_APP_NAME,
        bundleId: DESKTOP_RELEASE_BUNDLE_ID,
        sessionPartition: "persist:kulo",
      };
    }
  } catch {
    // Fall back to the default dev identity if package metadata is unavailable.
  }
  return {
    channel: "dev",
    appName: DESKTOP_APP_NAME,
    bundleId: DESKTOP_BUNDLE_ID,
    sessionPartition: "persist:kulo-dev",
  };
}

export function resolveDesktopDataDirectory(args: readonly string[], defaultDirectory: string): string {
  const values = args.filter((arg) => arg.startsWith("--kulo-data-dir="));
  if (args.includes("--kulo-data-dir") || values.length > 1) throw new Error("数据目录参数无效。");
  const value = values[0]?.slice("--kulo-data-dir=".length) ?? defaultDirectory;
  if (!value.trim() || !path.isAbsolute(value) || path.parse(value).root === path.resolve(value) || path.resolve(value) === os.homedir()) {
    throw new Error("数据目录必须是有效的绝对目录。");
  }
  const directory = path.resolve(value);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("数据目录必须是当前用户的普通目录。");
  }
  safeDesktopChmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

export function resolvePackagedNodePath(resourcesPath: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(resourcesPath, "runtime", platform === "win32" ? "node.exe" : "node");
}

export function resolvePackagedRescuePath(resourcesPath: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(resourcesPath, "runtime", platform === "win32" ? "kulo-rescue.cmd" : "kulo-rescue");
}

export function resolveWindowIconPath(assetsDir: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "darwin") return undefined;
  if (platform === "win32") {
    const ico = path.join(assetsDir, "kulo.ico");
    if (fs.existsSync(ico)) return ico;
  }
  const png = path.join(assetsDir, "kulo-icon.png");
  return fs.existsSync(png) ? png : undefined;
}

export function resolveDesktopTrayIconChoice(
  assetsDir: string,
  platform: NodeJS.Platform,
  badgeActive: boolean,
  shouldUseDarkColors: boolean,
): { iconPath: string; template: boolean } {
  if (badgeActive) {
    return {
      iconPath: path.join(assetsDir, shouldUseDarkColors ? "kulo-tray-badge-dark.png" : "kulo-tray-badge-light.png"),
      template: false,
    };
  }
  if (platform === "darwin") {
    return { iconPath: path.join(assetsDir, "kulo-trayTemplate.png"), template: true };
  }
  const themed = path.join(assetsDir, shouldUseDarkColors ? "kulo-tray-dark.png" : "kulo-tray-light.png");
  if (fs.existsSync(themed)) {
    return { iconPath: themed, template: false };
  }
  return { iconPath: path.join(assetsDir, "kulo-trayTemplate.png"), template: false };
}

export function desktopWindowChrome(platform: NodeJS.Platform): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "trafficLightPosition"> {
  // Center native window controls in the renderer's shared 48px toolbar.
  return platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } } : {};
}

export function desktopContentSecurityPolicy(html: string, origin: string, development: boolean): string {
  const inlineHashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]!) && match[2]!.trim())
    .map((match) => `'sha256-${createHash("sha256").update(match[2]!).digest("base64")}'`);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${development ? "'unsafe-inline'" : inlineHashes.join(" ")}`,
    "script-src-attr 'none'", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:",
    "img-src 'self' data: blob: https: http:", "media-src 'self' data: blob: https: http:",
    `connect-src 'self' ws://${new URL(origin).host}`, "worker-src 'self' blob:",
    "frame-src 'self' about:", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
  ].join("; ");
}

export interface DevelopmentMode {
  root: string;
  controlDir: string;
}

export function parseDevelopmentMode(args: readonly string[]): DevelopmentMode | undefined {
  const root = args.find((arg) => arg.startsWith("--kulo-dev-root="))?.slice("--kulo-dev-root=".length);
  const controlDir = args.find((arg) => arg.startsWith("--kulo-dev-control="))?.slice("--kulo-dev-control=".length);
  if (!root && !controlDir) return undefined;
  if (!root || !controlDir || !path.isAbsolute(root) || !path.isAbsolute(controlDir)) {
    throw new Error("开发模式需要有效的源码目录和控制目录。");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown };
  if (manifest.name !== "kulo-monorepo" || !fs.existsSync(path.join(root, "packages/desktop/dist/runtime.js")) ||
      !fs.existsSync(path.join(root, "packages/desktop/scripts/dev-server.mjs"))) {
    throw new Error("开发模式源码目录不是已构建的 Kulo 项目。");
  }
  const stat = fs.lstatSync(controlDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) || hasDesktopForbiddenPosixPermissions(stat)) {
    throw new Error("开发模式控制目录必须是本用户的私有目录。");
  }
  return { root: fs.realpathSync(root), controlDir: fs.realpathSync(controlDir) };
}

export function localHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port &&
        url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password) return url.origin;
  } catch { /* Child process messages are validated before they become navigation targets. */ }
  return undefined;
}

export function externalHttpUrl(value: string, privateToken?: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    for (const [name, content] of [...url.searchParams]) {
      if (name.toLowerCase() === "token" || privateToken && content.includes(privateToken)) url.searchParams.delete(name);
    }
    if (privateToken && (url.pathname.includes(privateToken) || url.hash.includes(privateToken))) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export function shouldAuthorizeDesktopRequest(
  request: { url: string; webContentsId?: number; frame?: { origin: string } | null; initiatorOrigin?: string; resourceType?: string; method?: string },
  rendererOrigin: string | undefined,
  windowId: number | undefined,
  mainFrame: { origin: string } | undefined,
): boolean {
  if (!rendererOrigin || !mainFrame || mainFrame.origin !== rendererOrigin || windowId === undefined || request.webContentsId !== windowId) return false;
  try {
    const url = new URL(request.url);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.origin !== rendererOrigin || !(url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/"))) return false;
    if (request.frame === mainFrame && request.frame?.origin === rendererOrigin) return true;
    // Chromium can omit the frame for websockets; an opaque sandbox initiator never qualifies.
    if (!request.frame && request.resourceType === "webSocket" && request.initiatorOrigin === rendererOrigin) return true;
    return request.resourceType === "subFrame" && ["GET", "HEAD"].includes(request.method ?? "") &&
      /^\/api\/uploads\/att_[a-z0-9_]{6,48}\/preview$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}
