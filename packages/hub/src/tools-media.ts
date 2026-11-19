import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { CapabilitySnapshot, MediaJob, MediaJobRequest, MediaJobSource } from "@kulo/protocol";
import { MediaJobError, type KuloMediaJobs } from "./media-jobs.js";
import { resolveDeferredAddTools } from "./tool-surface.js";

export interface MediaToolsOptions {
  get: () => KuloMediaJobs;
  capabilities: () => Promise<CapabilitySnapshot>;
  scope: (api: ToolExecutionApi) => MediaJobSource | Promise<MediaJobSource>;
  authorize?: (request: MediaJobRequest, api: ToolExecutionApi) => void | Promise<void>;
}
const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], details: value as never });
function canAccess(job: MediaJob, source: MediaJobSource): boolean {
  return job.source.topicId === source.topicId && (!source.ticketId || job.source.ticketId === source.ticketId);
}

export function createMediaToolsExtension(options: MediaToolsOptions) {
  const catalog = async () => {
    const snapshot = await options.capabilities();
    return { revision: snapshot.revision, capabilities: snapshot.capabilities.filter((item) => item.enabled).map((item) => ({
      id: item.id, name: item.name, kind: item.kind, modelId: item.modelId, formats: item.formats,
      supportsEdit: item.supportsEdit, isDefault: item.isDefault, allowTaskGeneration: item.allowTaskGeneration,
      maxOutputs: item.maxOutputs, status: item.status, imageProfile: item.imageProfile, defaults: item.defaults, routing: item.routing,
      adapter: snapshot.connections.find((connection) => connection.id === item.connectionId)?.adapter,
    })), imageRouting: snapshot.imageRouting };
  };
  const parameters = {
    operation_id: str({ description: "Idempotency key for this specific asset/version intent; reuse across retries/resumes, create a new ID only for a new asset or version." }),
    capability_id: opt(str({ description: "Specific enabled capability ID when explicitly requested by the user; omit for automatic routing." })),
    prompt: str({ description: "Detailed generation or editing prompt." }),
    reference_asset_ids: opt(arr(str(), { description: "Authorized assetIds in the current conversation/ticket (never pass cross-device file paths)." })),
    format: opt(oneOf(["png", "jpeg", "webp", "gif", "svg", "mp4"])),
    aspect_ratio: opt(str()), quality: opt(str()), duration_seconds: opt(int({ minimum: 1, maximum: 60 })),
    count: opt(int({ minimum: 1, maximum: 10 })),
    parameters: opt(str({ description: "Optional JSON object matching capability imageProfile (size, quality, background, complexity, outputCompression, frameCount, frameDurationMs, thinkingLevel, grounding, svgModel, svgReasoning, custom)." })),
    intent: opt(oneOf(["generate", "edit", "animate", "vector"])),
    preference: opt(oneOf(["balanced", "speed", "quality", "cost"])),
  };
  type Args = {
    operation_id: string; capability_id?: string; prompt: string; reference_asset_ids?: string[];
    format?: MediaJobRequest["format"]; aspect_ratio?: string; quality?: string; duration_seconds?: number; count?: number;
    parameters?: string; intent?: MediaJobRequest["intent"]; preference?: MediaJobRequest["preference"];
  };
  const generate = async (kind: "image" | "video", args: Args, api: ToolExecutionApi) => {
    const source = await options.scope(api);
    let parameters: MediaJobRequest["parameters"];
    if (args.parameters !== undefined) {
      if (args.parameters.length > 16000) throw new MediaJobError(400, "invalid_media_parameters", "图像参数过长。");
      try { parameters = JSON.parse(args.parameters) as MediaJobRequest["parameters"]; }
      catch { throw new MediaJobError(400, "invalid_media_parameters", "图像参数需要有效JSON对象。"); }
    }
    const request: MediaJobRequest = {
      operationId: args.operation_id, kind, capabilityId: args.capability_id, prompt: args.prompt,
      inputAssetIds: args.reference_asset_ids, format: args.format, aspectRatio: args.aspect_ratio,
      quality: args.quality, durationSeconds: args.duration_seconds, count: args.count, source,
      ...(parameters !== undefined ? { parameters } : {}),
      intent: args.intent, preference: args.preference,
    };
    await options.authorize?.(request, api);
    const job = await options.get().create(request);
    return result({ job, ...(source.ticketId && !["completed", "failed", "stopped"].includes(job.status)
      ? { nextStep: "If waiting for completion, the parent Worker must suspend via kulo_wait(reason='external', job_id=...) rather than polling or resubmitting; subagents should return job_id to their parent Worker." } : {}) });
  };
  return defineExtension({
    name: "kulo-media",
    tools: [
      defineTool({ name: "kulo_media_capabilities", description: "Read enabled image/video capability IDs, models, formats, `imageProfile` parameter options, and routing rules (without credentials). Direct unconfigured capabilities to Capabilities & Skills. 关键词：生图能力 视频生成配置 查看画图模型参数", parameters: obj({}), deferred: true, replay: "safe", execute: async (_args, api, context) => {
        await options.scope(api);
        const addTools = await resolveDeferredAddTools(api, context, [
          "kulo_generate_image",
          "kulo_generate_video",
          "kulo_media_job",
        ]);
        return { ...result(await catalog()), ...(addTools.length ? { control: { addTools } } : {}) };
      } }),
      defineTool({ name: "kulo_generate_image", description: "Create or resume a durable image generation/edit job. Claim completion only after a job completes and returns real assets; check existing `job_id` via `kulo_media_job` before retrying. 关键词：生成图片 画图 生图 AI绘画 海报 插画 修图", parameters: obj(parameters), deferred: true, replay: "safe", execute: async (args, api, context) => {
        const res = await generate("image", args, api);
        const addTools = await resolveDeferredAddTools(api, context, ["kulo_media_job", "kulo_media_export"]);
        return { ...res, ...(addTools.length ? { control: { addTools } } : {}) };
      } }),
      defineTool({ name: "kulo_generate_video", description: "Create or resume a durable video job via the configured Flow Chrome subscription connection (never silently switches to paid APIs). Claim completion only after real assets are returned. 关键词：生成视频 AI视频 制作短片 动画视频", parameters: obj({
        operation_id: parameters.operation_id, capability_id: parameters.capability_id, prompt: parameters.prompt,
        reference_asset_ids: parameters.reference_asset_ids, format: opt(oneOf(["mp4"])),
        duration_seconds: parameters.duration_seconds, count: parameters.count,
      }), deferred: true, replay: "safe", execute: async (args, api, context) => {
        const res = await generate("video", args, api);
        const addTools = await resolveDeferredAddTools(api, context, ["kulo_media_job", "kulo_media_export"]);
        return { ...res, ...(addTools.length ? { control: { addTools } } : {}) };
      } }),
      defineTool({
        name: "kulo_media_job", description: "List, inspect, resume, or stop media jobs in the current conversation/ticket (`resume` retrieves/verifies the original job without re-billing). 关键词：查询生图进度 视频任务状态 恢复停止媒体作业",
        parameters: obj({ action: oneOf(["list", "get", "resume", "stop"]), job_id: opt(str()) }), deferred: true, replay: "safe",
        execute: async (args, api) => {
          const source = await options.scope(api);
          if (args.action === "list") return result((await options.get().list()).filter((job) => canAccess(job, source)));
          if (!args.job_id) throw new MediaJobError(400, "media_job_required", "请指定媒体作业ID。");
          const job = await options.get().get(args.job_id);
          if (!canAccess(job, source)) throw new MediaJobError(403, "media_job_forbidden", "不能操作其他会话或工单的媒体作业。");
          return result(args.action === "get" ? job : args.action === "resume" ? await options.get().resume(job.id, source) : await options.get().stop(job.id));
        },
      }),
    ],
  });
}
