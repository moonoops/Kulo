import fs from "node:fs";
import { createHash } from "node:crypto";
import { defineDoc, defineExtension, defineTool, type Harness, type JsonObject, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { MediaJobSource } from "@kulo/protocol";
import { MAX_VIDEO_UPLOAD_BYTES, type KuloUploadStore } from "./uploads.js";
import { checkedExecutionPath, executionFileHash, executionFileInfo, EXECUTION_FILE_CHUNK_BYTES, ExecutionFileError, writeExecutionFile } from "./execution-files.js";

interface ExportReceipt { fingerprint: string; target: string; assetId: string; hash: string; size: number; completed: boolean }
interface ExportState { operations: Record<string, ExportReceipt> }
export const KuloMediaExportsDoc = defineDoc<ExportState & JsonObject>({
  kind: "kulo.media-exports", version: 1, scope: "session",
  initial: () => ({ operations: {} }) as ExportState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export interface MediaExportOptions {
  scope: (api: ToolExecutionApi) => Promise<MediaJobSource>;
  validateInput: (assetId: string, source: MediaJobSource) => Promise<void>;
  assertActive: (source: MediaJobSource) => Promise<void>;
  uploads: () => KuloUploadStore;
  harness: () => Harness;
}
export interface MediaExportInput { asset_id: string; path: string; overwrite?: boolean }
export interface MediaExportResult { path: string; assetId: string; reused: boolean }
const digest = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");

export function createMediaExporter(options: MediaExportOptions) {
  const inFlight = new Map<string, { fingerprint: string; promise: Promise<MediaExportResult> }>();
  return async (input: MediaExportInput, api: ToolExecutionApi, context: Context): Promise<MediaExportResult> => {
    const source = await options.scope(api);
    if (!source.ticketId || source.readOnly || !api.env) throw new ExecutionFileError(403, "media_export_scope_denied", "只能由有写资格的运行中 Worker 转存项目素材。");
    const env = api.env;
    const assertActive = () => options.assertActive(source);
    await assertActive();
    await options.validateInput(input.asset_id, source);
    const loaded = options.uploads().getUpload(input.asset_id);
    if (!loaded) throw new ExecutionFileError(404, "media_export_asset_missing", "受管资源不存在。");
    if (loaded.record.size > MAX_VIDEO_UPLOAD_BYTES) throw new ExecutionFileError(413, "media_export_asset_too_large", "资源超过转存大小上限。");
    const target = await checkedExecutionPath(env, env.cwd, input.path, context, { assertActive });
    const handle = await fs.promises.open(loaded.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const initial = await handle.stat();
      if (!initial.isFile() || initial.size !== loaded.record.size) throw new ExecutionFileError(409, "media_export_asset_changed", "受管资源已经变化。");
      async function* chunks(): AsyncGenerator<Uint8Array> {
        let offset = 0;
        while (offset < initial.size) {
          await assertActive();
          if (context.abortSignal?.aborted) throw new ExecutionFileError(499, "media_export_aborted", "素材转存已停止。");
          const buffer = Buffer.alloc(Math.min(EXECUTION_FILE_CHUNK_BYTES, initial.size - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (bytesRead !== buffer.length) throw new ExecutionFileError(409, "media_export_asset_changed", "受管资源读取中断。");
          offset += bytesRead; yield buffer;
        }
        const final = await handle.stat();
        if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) throw new ExecutionFileError(409, "media_export_asset_changed", "受管资源在转存期间发生变化。");
      }
      let hash = loaded.record.sha256;
      if (!hash) {
        const legacy = createHash("sha256");
        for await (const bytes of chunks()) legacy.update(bytes);
        hash = legacy.digest("hex");
      }
      const expectedHash = hash;
      const key = digest(`${Number(api.conversationId)}:${api.callId}`);
      const fingerprint = digest(JSON.stringify({ assetId: input.asset_id, target, hash: expectedHash, size: initial.size, overwrite: Boolean(input.overwrite), envId: env.id, ticketId: source.ticketId, projectId: source.projectId }));
      const running = inFlight.get(key);
      if (running) {
        if (running.fingerprint !== fingerprint) throw new ExecutionFileError(409, "media_export_command_conflict", "同一工具调用不能转存不同的素材或路径。");
        return await running.promise;
      }
      const transfer = (async (): Promise<MediaExportResult> => {
        const receipt = await options.harness().commit(async (tx) => {
          const state = await tx.doc(KuloMediaExportsDoc);
          const existing = Object.hasOwn(state.operations, key) ? state.operations[key] : undefined;
          if (existing) {
            if (existing.fingerprint !== fingerprint) throw new ExecutionFileError(409, "media_export_command_conflict", "同一工具调用不能转存不同的素材或路径。");
            return JSON.parse(JSON.stringify(existing)) as ExportReceipt;
          }
          const created: ExportReceipt = { fingerprint, target, assetId: input.asset_id, hash: expectedHash, size: initial.size, completed: false };
          state.operations[key] = created;
          return created;
        }, BACKGROUND_CONTEXT);
        await assertActive();
        if (receipt.completed) {
          const info = await executionFileInfo(env, target, context);
          if (!info || info.kind !== "file" || info.size !== receipt.size || await executionFileHash(env, target, receipt.size, context, assertActive) !== receipt.hash) throw new ExecutionFileError(409, "media_export_target_changed", "已转存文件已被修改或移除，未重复写入。");
          return { path: target, assetId: input.asset_id, reused: true };
        }
        const written = await writeExecutionFile({ env, root: env.cwd, target, size: initial.size, hash: expectedHash, chunks: chunks(), overwrite: input.overwrite, assertActive, context });
        await assertActive();
        await options.harness().commit(async (tx) => {
          const state = await tx.doc(KuloMediaExportsDoc);
          const current = state.operations[key];
          if (!current || current.fingerprint !== fingerprint) throw new ExecutionFileError(409, "media_export_command_conflict", "转存记录已变化。");
          current.completed = true;
        }, BACKGROUND_CONTEXT);
        return { path: written.path, assetId: input.asset_id, reused: written.reused };
      })();
      inFlight.set(key, { fingerprint, promise: transfer });
      try { return await transfer; }
      finally { inFlight.delete(key); }
    } finally { await handle.close(); }
  };
}

export function createMediaExportExtension(options: MediaExportOptions) {
  const execute = createMediaExporter(options);
  return defineExtension({
    name: "kulo-media-export",
    tools: [defineTool({
      name: "kulo_media_export", description: "Export a managed asset authorized for this task into the bound project workspace on its execution node and return the node file path (does not overwrite existing files unless overwrite=true). 关键词：导出素材 转存附件 保存生成图片到工作目录",
      parameters: obj({ asset_id: str(), path: str(), overwrite: opt(bool()) }), deferred: true, replay: "safe",
      execute: async (args, api, context) => {
        const value = await execute(args, api, context);
        return { output: [{ type: "text" as const, text: JSON.stringify(value) }], details: { path: value.path, assetId: value.assetId, reused: value.reused } };
      },
    })],
  });
}
