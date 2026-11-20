import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { isTrustedFileActionSender } from "./file-actions.js";

export interface DesktopPreferences {
  backgroundRunning: boolean;
}

export const DEFAULT_DESKTOP_PREFERENCES: Readonly<DesktopPreferences> = Object.freeze({
  backgroundRunning: true,
});

export const DESKTOP_PREFERENCES_FILENAME = "desktop-preferences.json";

export const DESKTOP_PREFERENCES_CHANNELS = {
  get: "kulo:desktop-preferences-get",
  set: "kulo:desktop-preferences-set",
  changed: "kulo:desktop-preferences-changed",
} as const;

const MAX_PREFERENCES_BYTES = 16 * 1024;
const ALLOWED_STORED_KEYS = new Set(["formatVersion", "backgroundRunning"]);
const ALLOWED_PATCH_KEYS = new Set(["backgroundRunning"]);

export function parseDesktopPreferencesPatch(raw: unknown): Partial<DesktopPreferences> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("桌面偏好参数无效。");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) {
    throw new Error("桌面偏好参数无效。");
  }
  const patch: Partial<DesktopPreferences> = {};
  for (const [key, value] of entries) {
    if (!ALLOWED_PATCH_KEYS.has(key)) throw new Error("桌面偏好参数无效。");
    if (key === "backgroundRunning") {
      if (typeof value !== "boolean") throw new Error("后台运行配置必须是布尔值。");
      patch.backgroundRunning = value;
    }
  }
  return patch;
}

export function readDesktopPreferencesFile(file: string): DesktopPreferences {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_DESKTOP_PREFERENCES };
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_PREFERENCES_BYTES ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("桌面偏好文件无效。");
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("桌面偏好格式无效。");
    }
    const record = parsed as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ALLOWED_STORED_KEYS.has(key)) throw new Error("桌面偏好格式无效。");
    }
    if (record.formatVersion !== undefined && record.formatVersion !== 1) {
      throw new Error("桌面偏好版本无效。");
    }
    if (typeof record.backgroundRunning !== "boolean") {
      throw new Error("桌面偏好内容无效。");
    }
    return { backgroundRunning: record.backgroundRunning };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writeDesktopPreferencesFile(file: string, preferences: DesktopPreferences): void {
  const existing = (() => {
    try { return fs.lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  })();
  if (existing && (!existing.isFile() || existing.isSymbolicLink() ||
    (typeof process.getuid === "function" && existing.uid !== process.getuid()))) {
    throw new Error("桌面偏好保存位置不可用。");
  }
  const temporary = path.join(path.dirname(file), `.desktop-preferences-${randomBytes(12).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ formatVersion: 1, backgroundRunning: preferences.backgroundRunning }, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } catch {
    throw new Error("无法保存桌面偏好设置，请检查数据目录权限。");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export interface DesktopPreferencesStoreOptions {
  dataDir: string;
  onChange?(next: DesktopPreferences): void;
  onLog?(message: string): void;
}

export interface DesktopPreferencesStore {
  get(): DesktopPreferences;
  update(raw: unknown): DesktopPreferences;
}

export function createDesktopPreferencesStore(options: DesktopPreferencesStoreOptions): DesktopPreferencesStore {
  const file = path.join(options.dataDir, DESKTOP_PREFERENCES_FILENAME);
  let current: DesktopPreferences;
  try {
    current = readDesktopPreferencesFile(file);
  } catch (error) {
    options.onLog?.(`读取桌面偏好失败，已恢复默认值：${error instanceof Error ? error.message : "未知错误"}`);
    current = { ...DEFAULT_DESKTOP_PREFERENCES };
  }

  return {
    get(): DesktopPreferences {
      return { ...current };
    },
    update(raw: unknown): DesktopPreferences {
      const patch = parseDesktopPreferencesPatch(raw);
      const next: DesktopPreferences = { ...current, ...patch };
      writeDesktopPreferencesFile(file, next);
      current = next;
      options.onChange?.({ ...current });
      return { ...current };
    },
  };
}

export function configureDesktopPreferenceHandlers(options: {
  ipc: Pick<IpcMain, "handle">;
  preferences: DesktopPreferencesStore;
  owner(): Parameters<typeof isTrustedFileActionSender>[1];
  rendererOrigin(): string | undefined;
}): void {
  function authorize(event: IpcMainInvokeEvent): void {
    if (!isTrustedFileActionSender(event, options.owner(), options.rendererOrigin())) {
      throw new Error("无法从此页面修改桌面偏好。");
    }
  }
  options.ipc.handle(DESKTOP_PREFERENCES_CHANNELS.get, (event, ...args: unknown[]) => {
    authorize(event);
    if (args.length) throw new Error("桌面偏好参数无效。");
    return options.preferences.get();
  });
  options.ipc.handle(DESKTOP_PREFERENCES_CHANNELS.set, (event, ...args: unknown[]) => {
    authorize(event);
    if (args.length !== 1) throw new Error("桌面偏好参数无效。");
    return options.preferences.update(args[0]);
  });
}
