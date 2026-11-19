import { withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import { isHtmlArtifact, type ChatAttachment } from "@moco/protocol";
import { UiCardError, type UiAssetPublicationInput } from "./ui-cards.js";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES, normalizeUploadMimeType, type MocoUploadStore } from "./uploads.js";
import { bundleHtmlArtifact } from "./html-bundle.js";

export interface ExecutionAssetOptions {
  allowedRoot: string;
  protectedPaths: readonly string[];
  /** Established by the Hub's environment factory, never supplied by the model. */
  trustedSandbox: boolean;
  ownerId?: string;
  scopeId?: string;
}

const READ_BYTES = 256 * 1024;
const SENSITIVE_NAME = /^(?:credentials?(?:\.[^.]+)?|auth\.json|secrets?(?:\.[^.]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:key|p12|pfx))$/i;

function normalized(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function within(file: string, root: string): boolean {
  const filePath = normalized(file);
  const rootPath = normalized(root);
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

function refuse(message: string): never {
  throw new UiCardError("asset_publication_denied", message, 403);
}

function checkAborted(context: Context): void {
  if (context.abortSignal?.aborted) throw new UiCardError("asset_publication_aborted", "资源发布已取消。", 499);
}

function checkInfo(info: FileInfo): void {
  if (info.kind !== "file") refuse("只能发布工作区内的普通文件。");
  if (!Number.isSafeInteger(info.size) || info.size < 1) throw new UiCardError("invalid_published_asset", "资源文件为空或大小无效。");
  if (info.size > MAX_VIDEO_UPLOAD_BYTES) throw new UiCardError("asset_too_large", "资源文件最大支持 250 MiB。", 413);
}

async function protectedPath(env: ExecutionEnv, value: string, context: Context): Promise<string> {
  const canonical = await env.canonicalPath(value, context);
  if (canonical.ok) return canonical.value;
  // A sandbox may deny even realpath on protected directories. Keep their lexical guard;
  // the candidate itself still has to pass realpath and the sandbox's actual open permission.
  if (canonical.error.code === "not_found" || canonical.error.code === "permission_denied") return value;
  throw canonical.error;
}

async function openExecutionAsset(
  inputPath: string,
  env: ExecutionEnv | undefined,
  context: Context,
  options: ExecutionAssetOptions,
) {
  checkAborted(context);
  if (!env) refuse("当前执行环境不可用，无法发布资源。");
  // noFollow only protects the final path component; the environment must enforce the directory boundary too.
  if (!options.trustedSandbox) refuse("当前执行环境尚未提供受保护的资源访问。");
  if (!inputPath || inputPath.length > 4096 || /[\x00-\x1f\x7f]/.test(inputPath)) refuse("资源路径无效。");
  if (inputPath.replace(/\\/g, "/").split("/").includes("..")) refuse("资源路径不能包含上级目录。");

  const absoluteRoot = getOrThrow(await env.absolutePath(options.allowedRoot, context));
  const root = getOrThrow(await env.canonicalPath(absoluteRoot, context));
  if (!normalized(root) || /^[A-Za-z]:$/.test(normalized(root))) refuse("资源工作区范围无效。");
  const absolute = getOrThrow(await env.absolutePath(inputPath, context));
  const lexicalRoot = within(absolute, absoluteRoot) ? absoluteRoot : root;
  if (!within(absolute, lexicalRoot) || normalized(absolute) === normalized(lexicalRoot)) refuse("资源必须位于当前工作区内。");
  const relative = normalized(absolute).slice(normalized(lexicalRoot).length + 1).split("/");
  if (relative.some((part) => !part || part.startsWith(".") || SENSITIVE_NAME.test(part))) refuse("不能发布隐藏文件或凭据文件。");
  const protectedRoots: string[] = [];
  for (const value of options.protectedPaths) {
    const protectedAbsolute = getOrThrow(await env.absolutePath(value, context));
    if (within(absolute, protectedAbsolute)) refuse("不能发布受保护的 Hub 或身份目录文件。");
    protectedRoots.push(await protectedPath(env, protectedAbsolute, context));
  }

  // Check the lexical route as well as realpath, so an in-workspace symlink is not silently published.
  for (let index = 0; index < relative.length; index++) {
    const item = getOrThrow(await env.joinPath([lexicalRoot, ...relative.slice(0, index + 1)], context));
    const info = getOrThrow(await env.fileInfo(item, context));
    if (info.kind === "symlink") refuse("不能发布符号链接资源。");
    if (index < relative.length - 1 && info.kind !== "directory") refuse("资源路径无效。");
    if (index === relative.length - 1) checkInfo(info);
  }
  const canonical = getOrThrow(await env.canonicalPath(absolute, context));
  if (!within(canonical, root)) refuse("资源实际位置超出了当前工作区。");
  for (const protectedRoot of protectedRoots) {
    if (within(canonical, protectedRoot)) refuse("不能发布受保护的 Hub 或身份目录文件。");
  }
  checkAborted(context);
  const reader = getOrThrow(await env.openBinaryReader(canonical, { noFollow: true }, context));
  try {
    const info = getOrThrow(await reader.info(context));
    checkInfo(info);
    const resolvedAgain = getOrThrow(await env.canonicalPath(absolute, context));
    if (normalized(resolvedAgain) !== normalized(canonical)) refuse("资源位置已变化，请重新发布。");
    async function* chunks(): AsyncGenerator<Uint8Array> {
      let offset = 0;
      while (offset < info.size) {
        checkAborted(context);
        const length = Math.min(READ_BYTES, info.size - offset);
        const bytes = getOrThrow(await reader.read(offset, length, context));
        if (bytes.length < 1 || bytes.length > length) throw new UiCardError("asset_read_failed", "资源读取中断，请重新发布。", 500);
        offset += bytes.length;
        yield bytes;
      }
      checkAborted(context);
      const finalInfo = getOrThrow(await reader.info(context));
      if (finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs) throw new UiCardError("asset_changed", "资源在读取期间发生变化，请重新发布。", 409);
    }
    return { reader, info, absolute, name: relative.at(-1)!, chunks };
  } catch (error) {
    await reader.close(withoutAbortSignal(context));
    throw error;
  }
}

/** Import bytes through the actual execution node, with the same cancellation as its tool call. */
export async function publishExecutionAsset(
  input: UiAssetPublicationInput,
  api: Pick<ToolExecutionApi, "env" | "conversationId" | "callId">,
  context: Context,
  uploads: MocoUploadStore,
  options: ExecutionAssetOptions,
): Promise<ChatAttachment> {
  const opened = await openExecutionAsset(input.path, api.env, context, options);
  try {
    const name = input.name || opened.name;
    const mimeType = normalizeUploadMimeType(input.mimeType, name);
    const html = isHtmlArtifact({ name, mimeType });
    const readDependency = async (absolutePath: string, maximumBytes: number): Promise<Buffer> => {
      const dependency = await openExecutionAsset(absolutePath, api.env, context, options);
      try {
        if (dependency.info.size > maximumBytes) throw new UiCardError("asset_too_large", "HTML 及其依赖总量不能超过 25 MiB。", 413);
        const result: Buffer[] = [];
        for await (const bytes of dependency.chunks()) result.push(Buffer.from(bytes));
        return Buffer.concat(result);
      } finally { await dependency.reader.close(withoutAbortSignal(context)); }
    };
    async function* publishedChunks(): AsyncGenerator<Uint8Array> {
      if (!html) { yield* opened.chunks(); return; }
      if (opened.info.size > MAX_UPLOAD_BYTES) throw new UiCardError("asset_too_large", "HTML 文件最大支持 25 MiB。", 413);
      const chunks: Buffer[] = [];
      for await (const bytes of opened.chunks()) chunks.push(Buffer.from(bytes));
      yield await bundleHtmlArtifact(Buffer.concat(chunks), opened.absolute, readDependency);
    }
    const attachment = await uploads.saveUploadStream({
      name, mimeType,
      stream: publishedChunks(), ownerId: options.ownerId, signal: context.abortSignal,
      idempotencyKey: `publication:${api.conversationId}:${api.callId}`,
    });
    if (options.scopeId) uploads.bindAttachments([attachment], options.scopeId, options.ownerId);
    return attachment;
  } finally { await opened.reader.close(withoutAbortSignal(context)); }
}
