import fs from "node:fs";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  AndroidResult,
  ChatAttachment,
  StagedWorkspaceDiffSummary,
  TicketRecord,
  WebSource,
  WorkerReportRecord,
} from "@kulo/protocol";
import type { KuloDurableState } from "./state.js";
import type { KuloUploadStore } from "./uploads.js";
import type { AndroidResolvedAssets, AndroidToolScope, StagedAndroidAssetSummary } from "./tools-android.js";

const MAX_INLINE_ANDROID_IMAGE_ASSETS = 2;

export interface ResolveAndroidToolAssetsDeps {
  uploads: KuloUploadStore;
  snapshotState: () => Promise<Readonly<KuloDurableState> | undefined>;
  stageWorkerArtifact: (
    asset: ChatAttachment,
    source: { conversationId: number; topicId: string; ticketId: string; runEpoch: number; envId: string },
    callId: string,
  ) => Promise<void>;
}

export async function resolveAndroidToolAssets(
  deps: ResolveAndroidToolAssetsDeps,
  scope: AndroidToolScope & { deviceId: string; supportsImages: boolean; stageForUser?: boolean },
  result: AndroidResult,
): Promise<AndroidResolvedAssets> {
  const images: ImageContent[] = [];
  const stagedAssets: StagedAndroidAssetSummary[] = [];
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return { images, stagedAssets };
  }
  const data = result.data as Record<string, unknown>;
  const assets = [
    ...(data.attachment ? [data.attachment] : []),
    ...(Array.isArray(data.attachments) ? data.attachments : []),
  ];
  if (assets.length > 8) throw new Error("手机返回的资源数量过多。");
  await scope.assertActive();
  const state = await deps.snapshotState();
  const ticket = state?.tickets[scope.ticketId];
  if (!ticket || ticket.runEpoch !== scope.runEpoch) throw new Error("手机资源所属任务已失效。");

  for (const asset of assets) {
    if (!asset || typeof asset !== "object" || !("id" in asset) || typeof asset.id !== "string") {
      throw new Error("手机资源引用无效。");
    }
    const loaded = deps.uploads.getUpload(asset.id);
    if (!loaded || loaded.record.ownerId !== scope.deviceId) {
      throw new Error("手机资源不属于本次操作的目标设备。");
    }
    for (const id of new Set([scope.conversationId, ticket.workerConversationId])) {
      deps.uploads.bindAttachments([asset.id], `conversation:${id}`, loaded.record.ownerId);
    }
    deps.uploads.bindAttachments([asset.id], `ticket:${ticket.id}`, loaded.record.ownerId);
    const shouldStage = scope.stageForUser === true || data.ephemeralObservation !== true;
    if (shouldStage) {
      const chatAttachment = deps.uploads.toChatAttachment(loaded.record);
      await deps.stageWorkerArtifact(
        chatAttachment,
        {
          conversationId: scope.conversationId,
          topicId: ticket.originTopicId ?? "root",
          ticketId: ticket.id,
          runEpoch: ticket.runEpoch,
          envId: scope.deviceId,
        },
        `android-result:${asset.id}`,
      );
      if (scope.stageForUser === true) {
        stagedAssets.push({
          id: chatAttachment.id,
          name: chatAttachment.name,
          mimeType: chatAttachment.mimeType,
        });
      }
    }
    if (loaded.record.kind === "image" && scope.supportsImages) {
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(loaded.record.mimeType)) {
        throw new Error("手机图片格式不受支持。");
      }
      images.push({
        type: "image",
        mimeType: loaded.record.mimeType,
        data: fs.readFileSync(loaded.filePath).toString("base64"),
      });
    }
  }
  await scope.assertActive();
  return { images, stagedAssets };
}

export interface InlineClaimEvaluation {
  canClaimInline: boolean;
  inlineTools: string[];
  inlineResult?: TicketRecord["inlineResult"];
}

export function evaluateInlineClaim(input: {
  ticket: Readonly<TicketRecord>;
  report: Readonly<WorkerReportRecord>;
  stagedDiff?: StagedWorkspaceDiffSummary;
  workerArtifacts?: readonly ChatAttachment[];
  sources: WebSource[];
}): InlineClaimEvaluation {
  const { ticket, report, stagedDiff, workerArtifacts, sources } = input;
  const cleanSmallStagedDiff =
    !stagedDiff ||
    (stagedDiff.conflictFiles.length === 0 &&
      !(stagedDiff.sensitivePaths?.length) &&
      stagedDiff.unifiedPreview.length <= 6_000);

  const combinedAssets: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const list of [report.attachments ?? [], workerArtifacts ?? []]) {
    for (const item of list) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        combinedAssets.push(item);
      }
    }
  }

  const inlineAndroidScreenshotsOnly =
    combinedAssets.length > 0 &&
    ticket.executionDomain === "android" &&
    !stagedDiff &&
    combinedAssets.length <= MAX_INLINE_ANDROID_IMAGE_ASSETS &&
    combinedAssets.every((asset) => asset.kind === "image");

  const canClaimInline =
    report.state === "ready" &&
    cleanSmallStagedDiff &&
    !report.overflowAsset &&
    !report.readOnlyViolation &&
    (combinedAssets.length === 0 || inlineAndroidScreenshotsOnly);

  if (!canClaimInline) {
    return { canClaimInline: false, inlineTools: [] };
  }

  const inlineTools = [
    ...(stagedDiff ? ["kulo_inspect_staged_diff", "kulo_apply_staged_changes"] : []),
    ...(ticket.boardId ? ["kulo_task_board"] : []),
    ...(inlineAndroidScreenshotsOnly ? ["kulo_publish_asset", "kulo_inspect_asset"] : []),
  ];

  const inlineResult: NonNullable<TicketRecord["inlineResult"]> = {
    state: report.state,
    summary: report.summary,
    deliverable: report.deliverable ?? null,
    ...(sources.length ? { sources } : {}),
    ...(stagedDiff
      ? { stagedDiff: JSON.parse(JSON.stringify(stagedDiff)) as StagedWorkspaceDiffSummary }
      : {}),
    ...(inlineAndroidScreenshotsOnly
      ? {
          stagedAssets: combinedAssets.map((asset) => ({
            id: asset.id,
            name: asset.name,
            mimeType: asset.mimeType,
          })),
        }
      : {}),
  };

  return { canClaimInline: true, inlineTools, inlineResult };
}
