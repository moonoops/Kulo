import { createHash, randomUUID } from "node:crypto";
import { withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";

export const EXECUTION_FILE_CHUNK_BYTES = 256 * 1024;
export class ExecutionFileError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ExecutionFileError"; }
}
const normalized = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
const within = (value: string, root: string): boolean => normalized(value) === normalized(root) || normalized(value).startsWith(`${normalized(root)}/`);
const invalid = (message: string): never => { throw new ExecutionFileError(400, "invalid_execution_path", message); };

export async function executionFileInfo(env: ExecutionEnv, target: string, context: Context): Promise<FileInfo | undefined> {
  const result = await env.fileInfo(target, context);
  if (result.ok) return result.value;
  if (result.error.code === "not_found") return undefined;
  throw result.error;
}

export async function checkedExecutionPath(env: ExecutionEnv, rootPath: string, targetPath: string, context: Context, options: {
  createParents?: boolean; assertActive: () => Promise<void>;
}): Promise<string> {
  if (!targetPath || targetPath.length > 4096 || /[\x00-\x1f\x7f]/.test(targetPath) || targetPath.replace(/\\/g, "/").split("/").includes("..")) invalid("目标路径无效。");
  await options.assertActive();
  const root = getOrThrow(await env.absolutePath(rootPath, context));
  const rootInfo = await executionFileInfo(env, root, context);
  if (!rootInfo || rootInfo.kind !== "directory") invalid("执行根目录不可用或为符号链接。");
  const canonicalRoot = getOrThrow(await env.canonicalPath(root, context));
  const absolute = getOrThrow(await env.absolutePath(targetPath, context));
  const lexicalRoot = within(absolute, root) ? root : canonicalRoot;
  if (!within(absolute, lexicalRoot) || normalized(absolute) === normalized(lexicalRoot)) invalid("目标必须位于当前授权目录内。");
  const parts = normalized(absolute).slice(normalized(lexicalRoot).length + 1).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) invalid("目标路径无效。");
  for (let index = 0; index < parts.length; index++) {
    const target = getOrThrow(await env.joinPath([lexicalRoot, ...parts.slice(0, index + 1)], context));
    let info = await executionFileInfo(env, target, context);
    if (!info && index < parts.length - 1 && options.createParents) {
      await options.assertActive();
      getOrThrow(await env.createDir(target, { recursive: false }, context));
      info = await executionFileInfo(env, target, context);
    }
    if (info?.kind === "symlink") throw new ExecutionFileError(403, "execution_symlink_denied", "目标路径不能包含符号链接。");
    if (index < parts.length - 1) {
      if (info && info.kind !== "directory") invalid("目标父目录不可用。");
      if (info) {
        const canonical = getOrThrow(await env.canonicalPath(target, context));
        if (!within(canonical, canonicalRoot)) throw new ExecutionFileError(403, "execution_path_outside", "目标实际位置超出授权目录。");
      }
    } else if (info && info.kind !== "file") invalid("目标不是普通文件。");
  }
  const parent = getOrThrow(await env.joinPath([absolute, ".."], context));
  if (await executionFileInfo(env, parent, context) && !within(getOrThrow(await env.canonicalPath(parent, context)), canonicalRoot)) throw new ExecutionFileError(403, "execution_path_outside", "目标父目录超出授权目录。");
  return absolute;
}

export async function executionFileHash(env: ExecutionEnv, target: string, size: number, context: Context, assertActive: () => Promise<void>): Promise<string> {
  await assertActive();
  const reader = getOrThrow(await env.openBinaryReader(target, { noFollow: true }, context));
  try {
    const before = getOrThrow(await reader.info(context));
    if (before.kind !== "file" || before.size !== size) throw new ExecutionFileError(409, "execution_file_changed", "目标文件已经变化。");
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < size) {
      await assertActive();
      const length = Math.min(EXECUTION_FILE_CHUNK_BYTES, size - offset);
      const bytes = getOrThrow(await reader.read(offset, length, context));
      if (!bytes.length || bytes.length > length) throw new ExecutionFileError(409, "execution_file_changed", "目标文件读取中断。");
      offset += bytes.length; hash.update(bytes);
    }
    const after = getOrThrow(await reader.info(context));
    if (after.size !== size || after.mtimeMs !== before.mtimeMs) throw new ExecutionFileError(409, "execution_file_changed", "目标文件在读取期间发生变化。");
    return hash.digest("hex");
  } finally { await reader.close(withoutAbortSignal(context)); }
}

// link publishes only when the destination does not exist; rename alone could overwrite a concurrent file.
const COMMIT_WITHOUT_REPLACEMENT = String.raw`const fs = require('node:fs');
try { fs.linkSync(process.argv[1], process.argv[2]); fs.unlinkSync(process.argv[1]); }
catch (error) { process.exit(error.code === 'EEXIST' ? 17 : 18); }`;

export async function writeExecutionFile(input: {
  env: ExecutionEnv; root: string; target: string; size: number; hash: string; chunks: AsyncIterable<Uint8Array>;
  overwrite?: boolean; assertActive: () => Promise<void>; context: Context;
}): Promise<{ path: string; reused: boolean }> {
  const { env, context, assertActive } = input;
  const target = await checkedExecutionPath(env, input.root, input.target, context, { createParents: true, assertActive });
  const existing = await executionFileInfo(env, target, context);
  if (existing) {
    if (existing.size === input.size && await executionFileHash(env, target, input.size, context, assertActive) === input.hash) return { path: target, reused: true };
    if (!input.overwrite) throw new ExecutionFileError(409, "execution_file_exists", "目标文件已存在；请使用新文件名或明确允许覆盖。");
  }
  const parent = getOrThrow(await env.joinPath([target, ".."], context));
  const temporary = getOrThrow(await env.joinPath([parent, `.kulo-transfer-${randomUUID()}.partial`], context));
  await checkedExecutionPath(env, input.root, temporary, context, { assertActive });
  const preexistingTemporary = await executionFileInfo(env, temporary, context);
  if (preexistingTemporary) throw new ExecutionFileError(409, "execution_transfer_conflict", "暂存文件冲突，请重试。");
  let committed = false;
  let temporaryCreated = false;
  try {
    await assertActive();
    getOrThrow(await env.writeFile(temporary, new Uint8Array(), context));
    temporaryCreated = true;
    let count = 0;
    const hash = createHash("sha256");
    for await (const chunk of input.chunks) {
      for (let start = 0; start < chunk.length; start += EXECUTION_FILE_CHUNK_BYTES) {
        const part = chunk.subarray(start, Math.min(start + EXECUTION_FILE_CHUNK_BYTES, chunk.length));
        if (count + part.length > input.size) throw new ExecutionFileError(409, "execution_source_changed", "资源大小发生变化。");
        await assertActive();
        await checkedExecutionPath(env, input.root, temporary, context, { assertActive });
        getOrThrow(await env.appendFile(temporary, part, context));
        hash.update(part); count += part.length;
      }
    }
    if (count !== input.size || hash.digest("hex") !== input.hash) throw new ExecutionFileError(409, "execution_source_changed", "资源内容发生变化，未提交目标文件。");
    await assertActive();
    getOrThrow(await env.flushFile(temporary, context));
    await checkedExecutionPath(env, input.root, target, context, { assertActive });
    await checkedExecutionPath(env, input.root, temporary, context, { assertActive });
    await assertActive();
    if (input.overwrite) getOrThrow(await env.renameFile(temporary, target, context));
    else {
      const result = getOrThrow(await env.exec(["node", "-e", COMMIT_WITHOUT_REPLACEMENT, temporary, target], { timeout: 10_000 }, context));
      if (result.exitCode === 17) throw new ExecutionFileError(409, "execution_file_exists", "目标文件在转存期间已被创建，未覆盖。");
      if (result.exitCode !== 0) throw new ExecutionFileError(500, "execution_atomic_commit_failed", "目标节点无法原子提交文件，请检查 Node 和文件系统支持。");
    }
    committed = true;
    await assertActive();
    await checkedExecutionPath(env, input.root, target, context, { assertActive });
    if (await executionFileHash(env, target, input.size, context, assertActive) !== input.hash) throw new ExecutionFileError(409, "execution_file_changed", "目标文件在提交后发生变化。");
    return { path: target, reused: false };
  } finally {
    if (temporaryCreated && !committed) {
      // Revoked execution cannot remove project files; its owner performs any later cleanup.
      await assertActive();
      await checkedExecutionPath(env, input.root, temporary, withoutAbortSignal(context), { assertActive });
      getOrThrow(await env.remove(temporary, { force: true }, withoutAbortSignal(context)));
    }
  }
}
