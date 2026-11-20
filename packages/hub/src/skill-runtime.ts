import { withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import type { MediaKind } from "@kulo/protocol";
import { parseDocument } from "yaml";

export interface SkillRuntimeContext {
  platform?: string;
  capabilities: readonly string[];
  reactWorkspace?: boolean;
  executionDomain?: "computer" | "android";
  mediaKinds?: readonly MediaKind[];
  androidAvailable?: boolean;
  customizationEnabled?: boolean;
  memoryKnowledgeEnabled?: boolean;
  diagnostics?: readonly string[];
}

export class SkillRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SkillRuntimeError"; }
}

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_DIRECTORIES = 64;
const MAX_ENTRIES = 512;
const MAX_DEPTH = 4;
const MAX_PATTERNS = 64;
const CHUNK_BYTES = 32 * 1024;
type Pattern = string[];
type Content = { state: "read"; value: string } | { state: "missing" | "unusable" };

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const missing = (error: unknown): boolean => !!error && typeof error === "object" && (error as { code?: unknown }).code === "not_found";
const safeName = (value: string): boolean => !!value && value.length <= 255 && !value.startsWith(".") && value !== "node_modules" && !/[\x00-\x1f\x7f/\\:]/.test(value);
const sameFile = (first: FileInfo, next: FileInfo): boolean => first.kind === next.kind && first.size === next.size && first.mtimeMs === next.mtimeMs;

function parsePattern(value: unknown): { negative: boolean; parts: Pattern } | undefined {
  if (typeof value !== "string" || !value || value.length > 512 || /[\\\x00-\x1f\x7f:?#[\]{}]/.test(value)) return;
  const negative = value.startsWith("!");
  const raw = (negative ? value.slice(1) : value).replace(/\/+$/, "");
  const parts = raw.split("/");
  if (!parts.length || parts.length > MAX_DEPTH || parts.some((part) => !safeName(part) || part.includes("**") && part !== "**" || part.includes("!"))) return;
  return { negative, parts };
}

function segmentMatches(pattern: string, name: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

function matches(pattern: Pattern, parts: string[], index = 0, position = 0): boolean {
  if (index === pattern.length) return position === parts.length;
  if (pattern[index] === "**") return matches(pattern, parts, index + 1, position)
    || position < parts.length && matches(pattern, parts, index, position + 1);
  return position < parts.length && segmentMatches(pattern[index]!, parts[position]!) && matches(pattern, parts, index + 1, position + 1);
}

function reactDependency(value: Record<string, unknown>): boolean {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((field) => {
    const dependencies = object(value[field]);
    return dependencies && typeof dependencies.react === "string" && dependencies.react.trim().length > 0;
  });
}

/** Reads only manifests declared by the executing workspace. Invalid manifests do
 * not establish React; cancellation and unexpected filesystem failures propagate. */
export async function detectReactWorkspace(env: ExecutionEnv | undefined, context: Context): Promise<boolean> {
  if (!env) return false;
  context.abortSignal?.throwIfAborted();
  const root = getOrThrow(await env.absolutePath(".", context));
  const rootInfo = await info(root);
  if (rootInfo?.kind !== "directory") return false;
  const canonicalRoot = getOrThrow(await env.canonicalPath(root, context));
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(root);
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  if (!normalize(canonicalRoot) || /^[a-z]:$/i.test(normalize(canonicalRoot))) return false;
  let totalBytes = 0;
  let directoryCount = 0;
  let entryCount = 0;
  const directories = new Map<string, boolean>([["", true]]);
  const listings = new Map<string, string[]>();

  async function info(target: string): Promise<FileInfo | undefined> {
    context.abortSignal?.throwIfAborted();
    const result = await env!.fileInfo(target, context);
    if (result.ok) return result.value;
    if (missing(result.error)) return;
    throw result.error;
  }
  const join = (parts: string[]) => env!.joinPath(parts, context).then(getOrThrow);
  const equal = (first: string, next: string) => normalize(first) === normalize(next);
  async function directory(parts: string[]): Promise<boolean> {
    const key = parts.join("/");
    const cached = directories.get(key);
    if (cached !== undefined) return cached;
    if (parts.length > MAX_DEPTH || directoryCount >= MAX_DIRECTORIES) return false;
    if (parts.length && !await directory(parts.slice(0, -1))) return false;
    directoryCount++;
    const target = await join([root, ...parts]);
    const current = await info(target);
    const valid = current?.kind === "directory" && equal(getOrThrow(await env!.canonicalPath(target, context)), await join([canonicalRoot, ...parts]));
    directories.set(key, valid);
    return valid;
  }

  async function read(parts: string[]): Promise<Content> {
    if (!await directory(parts.slice(0, -1))) return { state: "unusable" };
    const target = await join([root, ...parts]);
    const before = await info(target);
    if (!before) return { state: "missing" };
    if (before.kind !== "file" || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_MANIFEST_BYTES
      || totalBytes + before.size > MAX_TOTAL_BYTES || !Number.isFinite(before.mtimeMs)) return { state: "unusable" };
    const expected = await join([canonicalRoot, ...parts]);
    if (!equal(getOrThrow(await env!.canonicalPath(target, context)), expected)) return { state: "unusable" };
    totalBytes += before.size;
    const reader = getOrThrow(await env!.openBinaryReader(target, { noFollow: true }, context));
    let bytes: Uint8Array;
    try {
      if (!sameFile(before, getOrThrow(await reader.info(context)))) throw new SkillRuntimeError("skill_workspace_changed", "项目清单在读取前发生变化。");
      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (offset < before.size) {
        context.abortSignal?.throwIfAborted();
        const size = Math.min(CHUNK_BYTES, before.size - offset);
        const chunk = getOrThrow(await reader.read(offset, size, context));
        if (!chunk.length || chunk.length > size) throw new SkillRuntimeError("skill_workspace_read_failed", "执行设备未返回完整的项目清单。");
        chunks.push(Buffer.from(chunk)); offset += chunk.length;
      }
      const after = await info(target);
      if (!after || !sameFile(before, after) || !sameFile(before, getOrThrow(await reader.info(context)))
        || !equal(getOrThrow(await env!.canonicalPath(target, context)), expected)) throw new SkillRuntimeError("skill_workspace_changed", "项目清单在读取期间发生变化。");
      bytes = Buffer.concat(chunks);
    } finally { await reader.close(withoutAbortSignal(context)); }
    try { return { state: "read", value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
    catch { return { state: "unusable" }; }
  }

  const manifest = await read(["package.json"]);
  let packageJson: Record<string, unknown> | undefined;
  if (manifest.state === "unusable") return false;
  if (manifest.state === "read") {
    try { packageJson = object(JSON.parse(manifest.value)); } catch { return false; }
    if (!packageJson) return false;
    if (reactDependency(packageJson)) return true;
  }
  const workspaceValue = packageJson?.workspaces;
  const patterns: unknown[] = Array.isArray(workspaceValue) ? [...workspaceValue] : Array.isArray(object(workspaceValue)?.packages) ? [...object(workspaceValue)!.packages as unknown[]] : [];
  const pnpm = await read(["pnpm-workspace.yaml"]);
  if (pnpm.state === "read") {
    const document = parseDocument(pnpm.value, { uniqueKeys: true });
    if (!document.errors.length) {
      let value: unknown;
      try { value = document.toJS({ maxAliasCount: 20 }); } catch { value = undefined; }
      const packages = object(value)?.packages;
      if (Array.isArray(packages)) patterns.push(...packages);
    }
  }
  if (patterns.length > MAX_PATTERNS) return false;
  const parsed = patterns.map(parsePattern).filter((value) => value !== undefined);
  const negative = parsed.filter((value) => value.negative).map((value) => value.parts);
  const excluded = (parts: string[]) => negative.some((pattern) => parts.some((_, index) => matches(pattern, parts.slice(0, index + 1))) || matches(pattern, []));
  const candidates = new Map<string, string[]>();

  async function children(parts: string[]): Promise<string[]> {
    const key = parts.join("/");
    const previous = listings.get(key);
    if (previous) return previous;
    if (entryCount >= MAX_ENTRIES || !await directory(parts)) return [];
    const target = await join([root, ...parts]);
    const reader = getOrThrow(await env!.openDirReader(target, context));
    const names = new Set<string>();
    const result: string[] = [];
    try {
      while (entryCount < MAX_ENTRIES) {
        context.abortSignal?.throwIfAborted();
        const page = getOrThrow(await reader.next(Math.min(64, MAX_ENTRIES - entryCount), context));
        if (page.entries.length > Math.min(64, MAX_ENTRIES - entryCount) || !page.done && !page.entries.length) throw new SkillRuntimeError("skill_workspace_listing_invalid", "执行设备返回的项目目录列表无效。");
        for (const entry of page.entries) {
          entryCount++;
          if (names.has(entry.name)) throw new SkillRuntimeError("skill_workspace_listing_invalid", "执行设备返回了重复的项目目录。");
          names.add(entry.name);
          if (!safeName(entry.name) || entry.kind !== "directory") continue;
          const childParts = [...parts, entry.name];
          if (!equal(entry.path, await join([target, entry.name]))) throw new SkillRuntimeError("skill_workspace_listing_invalid", "执行设备返回了越界的项目目录。");
          if (!excluded(childParts) && await directory(childParts)) result.push(entry.name);
        }
        if (page.done) break;
      }
    } finally { await reader.close(withoutAbortSignal(context)); }
    listings.set(key, result);
    return result;
  }

  async function expand(pattern: Pattern, parts: string[], index: number): Promise<void> {
    if (parts.length > MAX_DEPTH || candidates.size >= MAX_DIRECTORIES || excluded(parts)) return;
    if (index === pattern.length) {
      if (parts.length && await directory(parts)) candidates.set(parts.join("/"), parts);
      return;
    }
    const segment = pattern[index]!;
    if (segment === "**") {
      await expand(pattern, parts, index + 1);
      if (parts.length < MAX_DEPTH) for (const child of await children(parts)) await expand(pattern, [...parts, child], index);
    } else if (segment.includes("*")) {
      if (parts.length < MAX_DEPTH) for (const child of await children(parts)) if (segmentMatches(segment, child)) await expand(pattern, [...parts, child], index + 1);
    } else if (await directory([...parts, segment])) await expand(pattern, [...parts, segment], index + 1);
  }
  for (const pattern of parsed) if (!pattern.negative) await expand(pattern.parts, [], 0);
  for (const parts of candidates.values()) {
    const child = await read([...parts, "package.json"]);
    if (child.state !== "read") continue;
    let value: unknown;
    try { value = JSON.parse(child.value); } catch { continue; }
    const candidate = object(value);
    if (candidate && reactDependency(candidate)) return true;
  }
  return false;
}
