import fs from "node:fs/promises";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { isTrustedFileActionSender } from "./file-actions.js";

export const DESKTOP_PICK_DIRECTORY_CHANNEL = "kulo:pick-directory";

export interface DesktopPickDirectoryOptions {
  defaultPath?: string;
}

export interface DesktopDirectoryPickerOptions {
  chooseDirectory(defaultPath?: string): Promise<string | undefined>;
  homeDirectory(): string;
  platform?: NodeJS.Platform;
  stat?: (target: string) => Promise<{ isDirectory(): boolean }>;
  resolveTimeoutMs?: number;
}

const MAX_PATH_LENGTH = 8192;
const MAX_PARENT_WALK_DEPTH = 64;
const DEFAULT_RESOLVE_TIMEOUT_MS = 1500;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

function isValidPathString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PATH_LENGTH && !CONTROL_CHAR_PATTERN.test(value);
}

function normalizePickDirectoryInput(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("目录选择参数无效。");
  }
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("目录选择参数无效。");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "defaultPath") throw new Error("目录选择参数无效。");
  }
  if (record.defaultPath === undefined) return undefined;
  if (!isValidPathString(record.defaultPath)) {
    throw new Error("默认目录路径无效。");
  }
  return record.defaultPath;
}

function expandDefaultPath(
  candidate: string,
  homeDirectory: () => string,
  platform: NodeJS.Platform,
  pathImpl: typeof path.posix | typeof path.win32,
): string | undefined {
  if (!candidate.trim()) return undefined;
  if (candidate === "~") {
    try {
      const home = homeDirectory();
      return home && pathImpl.isAbsolute(home) ? home : undefined;
    } catch {
      return undefined;
    }
  }
  if (candidate.startsWith("~/") || (platform === "win32" && candidate.startsWith("~\\"))) {
    try {
      const home = homeDirectory();
      if (!home || !pathImpl.isAbsolute(home)) return undefined;
      return pathImpl.join(home, candidate.slice(2));
    } catch {
      return undefined;
    }
  }
  return pathImpl.isAbsolute(candidate) ? candidate : undefined;
}

async function findExistingDirectory(
  initial: string,
  statFn: (target: string) => Promise<{ isDirectory(): boolean }>,
  pathImpl: typeof path.posix | typeof path.win32,
): Promise<string | undefined> {
  let current = pathImpl.resolve(initial);
  for (let depth = 0; depth < MAX_PARENT_WALK_DEPTH; depth += 1) {
    try {
      const info = await statFn(current);
      if (info.isDirectory()) return current;
    } catch {
      // Walk up on ENOENT, ENOTDIR, EACCES, EPERM, ELOOP, or transient FS errors.
    }
    const parent = pathImpl.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

async function resolveDefaultPath(
  candidate: string | undefined,
  options: {
    homeDirectory(): string;
    platform: NodeJS.Platform;
    statFn: (target: string) => Promise<{ isDirectory(): boolean }>;
    timeoutMs: number;
    pathImpl: typeof path.posix | typeof path.win32;
  },
): Promise<string | undefined> {
  if (candidate === undefined) return undefined;
  const expanded = expandDefaultPath(candidate, options.homeDirectory, options.platform, options.pathImpl);
  if (!expanded) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lookup = findExistingDirectory(expanded, options.statFn, options.pathImpl);
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), options.timeoutMs);
  });
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createDesktopDirectoryPicker(options: DesktopDirectoryPickerOptions) {
  const platform = options.platform ?? process.platform;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const statFn = options.stat ?? ((target: string) => fs.stat(target));
  const timeoutMs = options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  let pending: Promise<string | null> | undefined;

  async function runPick(defaultPathInput: string | undefined): Promise<string | null> {
    const resolvedDefaultPath = await resolveDefaultPath(defaultPathInput, {
      homeDirectory: options.homeDirectory,
      platform,
      statFn,
      timeoutMs,
      pathImpl,
    });
    const chosen = await options.chooseDirectory(resolvedDefaultPath);
    if (chosen === undefined || chosen === "") return null;
    if (!isValidPathString(chosen) || !pathImpl.isAbsolute(chosen)) {
      throw new Error("选择的目录路径无效。");
    }
    return chosen;
  }

  function pickDirectory(raw?: unknown): Promise<string | null> {
    let defaultPathInput: string | undefined;
    try {
      defaultPathInput = normalizePickDirectoryInput(raw);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!pending) {
      const active = runPick(defaultPathInput);
      pending = active;
      const clear = () => { if (pending === active) pending = undefined; };
      void active.then(clear, clear);
    }
    return pending;
  }

  return { pickDirectory };
}

export function configureDesktopDirectoryPickerHandlers(options: {
  ipc: Pick<IpcMain, "handle">;
  picker: ReturnType<typeof createDesktopDirectoryPicker>;
  owner(): Parameters<typeof isTrustedFileActionSender>[1];
  rendererOrigin(): string | undefined;
}): void {
  options.ipc.handle(DESKTOP_PICK_DIRECTORY_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTrustedFileActionSender(event, options.owner(), options.rendererOrigin())) {
      throw new Error("无法从此页面选择本机目录。");
    }
    if (args.length > 1) throw new Error("目录选择参数无效。");
    return options.picker.pickDirectory(args[0]);
  });
}
