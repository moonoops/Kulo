import { createHash } from "node:crypto";
import { withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import type { TicketRecord } from "@kulo/protocol";
import { checkedExecutionPath, executionFileInfo, EXECUTION_FILE_CHUNK_BYTES, ExecutionFileError } from "./execution-files.js";
import { normalizeUploadMimeType } from "./uploads.js";

export const MAX_TASK_DELIVERABLE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 16;
const EXTENSIONS = "html?|pdf|txt|md|markdown|json|jsonl|csv|tsv|ya?ml|xml|css|m?js|ts|tsx|jsx|py|sh|log|zip|png|jpe?g|webp|gif|svg|mp3|wav|m4a|ogg|flac|mp4|webm|mov|docx?|xlsx?|pptx?";
const FILE_NAME = new RegExp(`\\.(?:${EXTENSIONS})$`, "i");
const SIMPLE_REFERENCE = new RegExp(`(?:[A-Za-z]:[\\\\/]|/)?(?:[\\w@+~%.-]+[\\\\/])*[\\w@+~%.-]+\\.(?:${EXTENSIONS})\\b`, "gi");
const SENSITIVE_NAME = /^(?:credentials?(?:\.[^.]+)?|auth\.json|secrets?(?:\.[^.]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:key|p12|pfx))$/i;
const normalized = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
const within = (value: string, root: string): boolean => normalized(value) === normalized(root) || normalized(value).startsWith(`${normalized(root)}/`);
const baseName = (value: string): string => normalized(value).split("/").at(-1) ?? "";

export class TaskDeliverableError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "TaskDeliverableError"; }
}

export interface TaskDeliverableFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  previewable: boolean;
}

export interface TaskDeliverablesSnapshot { files: TaskDeliverableFile[]; missing?: string[] }
export interface TaskDeliverableOptions {
  env: ExecutionEnv;
  ticket: Pick<TicketRecord, "id" | "workspaceDir" | "scratchDir" | "latestReport">;
  protectedPaths: readonly string[];
  assertAuthorized: () => Promise<void>;
  context: Context;
}
interface ResolvedFile { file: TaskDeliverableFile; target: string; canonical: string; root: string; info: FileInfo }

/** Reports identify candidates; a candidate becomes a deliverable only after an Env metadata check. */
export function reportFileReferences(report: TaskDeliverableOptions["ticket"]["latestReport"]): string[] {
  if (!report) return [];
  const text = `${report.deliverable ?? ""}\n${report.summary}`.slice(0, 64_000);
  const references = new Set<string>();
  const add = (value: string) => {
    const clean = value.trim().replace(/^<|>$/g, "");
    if (clean && clean.length <= 4096 && FILE_NAME.test(clean) && !/^[a-z][a-z\d+.-]*:\/\//i.test(clean)) references.add(clean);
  };
  // Keep explicit paths intact, including spaces and non-ASCII filenames.
  const remaining = text.replace(/`([^`\n]+)`|\[[^\]\n]*\]\(([^)\n]+)\)|https?:\/\/[^\s<>]+/g, (match, code: string | undefined, link: string | undefined) => {
    if (code || link) add(code ?? link!);
    return " ".repeat(match.length);
  });
  for (const match of remaining.matchAll(SIMPLE_REFERENCE)) add(match[0]);
  return [...references].slice(0, MAX_FILES);
}

function assertAllowedName(reference: string): void {
  const parts = normalized(reference).replace(/^[A-Za-z]:\//, "").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part.startsWith(".") || SENSITIVE_NAME.test(part)) || /[\x00-\x1f\x7f]/.test(reference)) {
    throw new TaskDeliverableError(403, "task_deliverable_forbidden", "不能读取隐藏文件、凭据文件或上级目录。");
  }
}

async function resolveFile(options: TaskDeliverableOptions, reference: string): Promise<ResolvedFile | undefined> {
  if (normalized(reference).split("/").includes("..") || /[\x00-\x1f\x7f]/.test(reference)) {
    throw new TaskDeliverableError(403, "task_deliverable_forbidden", "文件路径无效。");
  }
  const { env, ticket, context, assertAuthorized } = options;
  const roots = [...new Set([ticket.workspaceDir, ticket.scratchDir].filter((value): value is string => Boolean(value)))];
  const absoluteReference = /^(?:\/|[A-Za-z]:[\\/])/.test(reference);
  let matchedRoot = false;
  for (const root of roots) {
    const absoluteRoot = getOrThrow(await env.absolutePath(root, context));
    if (absoluteReference && within(reference, absoluteRoot)) matchedRoot = true;
    const canonicalRootResult = await env.canonicalPath(absoluteRoot, context);
    if (!canonicalRootResult.ok && canonicalRootResult.error.code === "not_found") continue;
    const canonicalRoot = getOrThrow(canonicalRootResult);
    const target = absoluteReference ? reference : getOrThrow(await env.joinPath([absoluteRoot, reference], context));
    if (!within(target, absoluteRoot) && !within(target, canonicalRoot)) continue;
    const lexicalRoot = within(target, absoluteRoot) ? absoluteRoot : canonicalRoot;
    assertAllowedName(normalized(target).slice(normalized(lexicalRoot).length + 1));
    matchedRoot = true;
    const checked = await checkedExecutionPath(env, absoluteRoot, target, context, { assertActive: assertAuthorized });
    const canonical = await env.canonicalPath(checked, context);
    const protectedRoots: string[] = [];
    for (const protectedPath of options.protectedPaths) {
      const protectedAbsolute = getOrThrow(await env.absolutePath(protectedPath, context));
      if (within(checked, protectedAbsolute)) throw new TaskDeliverableError(403, "task_deliverable_forbidden", "不能读取受保护的应用文件。");
      const protectedCanonical = await env.canonicalPath(protectedAbsolute, context);
      if (protectedCanonical.ok) protectedRoots.push(protectedCanonical.value);
      else if (!["not_found", "permission_denied"].includes(protectedCanonical.error.code)) throw protectedCanonical.error;
    }
    const info = await executionFileInfo(env, checked, context);
    if (!info) continue;
    if (info.kind !== "file") throw new TaskDeliverableError(403, "task_deliverable_forbidden", "只能读取交付的普通文件。");
    if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_TASK_DELIVERABLE_BYTES) {
      throw new TaskDeliverableError(413, "task_deliverable_too_large", "交付文件最大支持 25 MiB。");
    }
    const canonicalTarget = getOrThrow(canonical);
    if (!within(canonicalTarget, canonicalRoot) || protectedRoots.some((protectedRoot) => within(canonicalTarget, protectedRoot))) {
      throw new TaskDeliverableError(403, "task_deliverable_forbidden", "文件实际位置超出了任务授权目录。");
    }
    const name = baseName(checked);
    const id = createHash("sha256").update(checked).digest("hex").slice(0, 32);
    return { target: checked, canonical: canonicalTarget, root: absoluteRoot, info, file: {
      id, name, size: info.size, mimeType: normalizeUploadMimeType(undefined, name),
      url: `/api/tickets/${encodeURIComponent(ticket.id)}/deliverables/${id}`,
      previewable: /\.html?$/i.test(name),
    } };
  }
  if (absoluteReference && !matchedRoot) throw new TaskDeliverableError(403, "task_deliverable_forbidden", "文件不在任务授权目录内。");
  return undefined;
}

export async function listTaskDeliverables(options: TaskDeliverableOptions): Promise<TaskDeliverablesSnapshot> {
  await options.assertAuthorized();
  const files = new Map<string, TaskDeliverableFile>();
  const missing = new Set<string>();
  for (const reference of reportFileReferences(options.ticket.latestReport)) {
    const resolved = await resolveFile(options, reference);
    if (resolved) files.set(resolved.file.id, resolved.file);
    else missing.add(baseName(reference));
  }
  for (const file of files.values()) missing.delete(file.name);
  return { files: [...files.values()], ...(missing.size ? { missing: [...missing] } : {}) };
}

export async function readTaskDeliverable(options: TaskDeliverableOptions, id: string): Promise<{ file: TaskDeliverableFile; bytes: Uint8Array }> {
  if (!/^[a-f\d]{32}$/.test(id)) throw new TaskDeliverableError(404, "task_deliverable_not_found", "交付文件不存在。");
  await options.assertAuthorized();
  let resolved: ResolvedFile | undefined;
  for (const reference of reportFileReferences(options.ticket.latestReport)) {
    const candidate = await resolveFile(options, reference);
    if (candidate?.file.id === id) { resolved = candidate; break; }
  }
  if (!resolved) throw new TaskDeliverableError(404, "task_deliverable_not_found", "交付文件不存在或已移动。");
  const { env, context, assertAuthorized } = options;
  await assertAuthorized();
  const reader = getOrThrow(await env.openBinaryReader(resolved.target, { noFollow: true }, context));
  try {
    const before = getOrThrow(await reader.info(context));
    if (before.kind !== "file" || before.size !== resolved.info.size || before.mtimeMs !== resolved.info.mtimeMs) {
      throw new TaskDeliverableError(409, "task_deliverable_changed", "交付文件已变化，请重新加载。");
    }
    const rechecked = await checkedExecutionPath(env, resolved.root, resolved.target, context, { assertActive: assertAuthorized });
    if (getOrThrow(await env.canonicalPath(rechecked, context)) !== resolved.canonical) {
      throw new TaskDeliverableError(409, "task_deliverable_changed", "交付文件位置已变化，请重新加载。");
    }
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      await assertAuthorized();
      const length = Math.min(EXECUTION_FILE_CHUNK_BYTES, bytes.length - offset);
      const chunk = getOrThrow(await reader.read(offset, length, context));
      if (!chunk.length || chunk.length > length) throw new TaskDeliverableError(409, "task_deliverable_changed", "交付文件读取中断，请重新加载。");
      bytes.set(chunk, offset); offset += chunk.length;
    }
    const after = getOrThrow(await reader.info(context));
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new TaskDeliverableError(409, "task_deliverable_changed", "交付文件在读取期间发生变化，请重新加载。");
    await assertAuthorized();
    return { file: resolved.file, bytes };
  } finally { await reader.close(withoutAbortSignal(context)); }
}

export function taskDeliverableError(error: unknown): never {
  if (error instanceof ExecutionFileError) throw new TaskDeliverableError(error.status, error.code, error.message);
  throw error;
}
