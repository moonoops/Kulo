import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { BatchWorkflowRetryRequest, BatchWorkflowStopRequest } from "@kulo/protocol";
import { BatchWorkflowError } from "../batch-workflow-service.js";
import { assertHttpSameOrigin, type HubHttpRouteContext } from "./context.js";

function parseId(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new BatchWorkflowError(400, "batch_invalid_id", "批处理编号无效。");
  }
  if (!decoded || decoded.length > 128 || /[\u0000-\u001f\u007f]/.test(decoded)) {
    throw new BatchWorkflowError(400, "batch_invalid_id", "批处理编号无效。");
  }
  return decoded;
}

/**
 * Handles `/api/batch-workflows` REST endpoints:
 * - `GET /api/batch-workflows`
 * - `GET /api/batch-workflows/:id`
 * - `POST /api/batch-workflows/:id/retry`
 * - `POST /api/batch-workflows/:id/stop`
 */
export async function handleBatchWorkflowRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, pathname, parsedUrl, readJsonObject, sendJson } = ctx;

  if (pathname === "/api/batch-workflows") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "仅支持 GET 请求。", code: "batch_method_not_allowed" });
      return true;
    }
    res.setHeader("cache-control", "no-store");
    const topicId = parsedUrl.searchParams.get("topicId")?.trim() || undefined;
    const ticketId = parsedUrl.searchParams.get("ticketId")?.trim() || undefined;
    const batches = await hub.batchWorkflows.listCardViews(BACKGROUND_CONTEXT, {
      ...(topicId ? { topicId } : {}),
      ...(ticketId ? { ticketId } : {}),
    });
    sendJson(res, 200, { batches });
    return true;
  }

  const itemMatch = /^\/api\/batch-workflows\/([^/]+)(?:\/(retry|stop))?$/.exec(pathname);
  if (!itemMatch) return false;

  res.setHeader("cache-control", "no-store");
  const batchId = parseId(itemMatch[1]!);
  const action = itemMatch[2];

  if (!action) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "仅支持 GET 请求。", code: "batch_method_not_allowed" });
      return true;
    }
    const batch = await hub.batchWorkflows.getCardView(batchId, BACKGROUND_CONTEXT);
    if (!batch) {
      throw new BatchWorkflowError(404, "batch_not_found", `批处理 '${batchId}' 不存在。`);
    }
    sendJson(res, 200, { batch });
    return true;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "仅支持 POST 请求。", code: "batch_method_not_allowed" });
    return true;
  }

  assertHttpSameOrigin(ctx, {
    code: "batch_origin_required",
    message: "请在 Kulo 中操作批处理任务。",
  });

  if (action === "retry") {
    const body = await readJsonObject(req, 32 * 1024);
    const request: BatchWorkflowRetryRequest = {};
    if (body.itemIds !== undefined) {
      if (!Array.isArray(body.itemIds) || body.itemIds.length > 16 || body.itemIds.some((v) => typeof v !== "string" || !v.trim())) {
        throw new BatchWorkflowError(400, "batch_invalid_request", "itemIds 必须是最多 16 项的非空字符串数组。");
      }
      request.itemIds = body.itemIds.map((v) => v.trim());
    }
    if (typeof body.commandId === "string" && body.commandId.trim()) {
      request.commandId = body.commandId.trim().slice(0, 200);
    }
    const batch = await hub.batchWorkflows.retryFailedItems(batchId, request, BACKGROUND_CONTEXT);
    sendJson(res, 200, { batch });
    return true;
  }

  const body = (await readJsonObject(req, 16 * 1024)) as BatchWorkflowStopRequest;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 240) : undefined;
  const batch = await hub.batchWorkflows.stopBatch(batchId, reason, BACKGROUND_CONTEXT);
  sendJson(res, 200, { batch });
  return true;
}
