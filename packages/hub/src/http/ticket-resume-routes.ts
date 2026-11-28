import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RoleThinkingEffort, TicketResumeOverrideRequest } from "@kulo/protocol";
import { ProjectError } from "../projects.js";
import { assertHttpSameOrigin, type HubHttpRouteContext } from "./context.js";

function parseOptionalBoundedString(
  raw: unknown,
  field: string,
  maxLength: number,
  allowNewlines = false,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new ProjectError(400, "invalid_resume_request", `参数 ${field} 必须为字符串。`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const controlPattern = allowNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (trimmed.length > maxLength || controlPattern.test(trimmed)) {
    throw new ProjectError(400, "invalid_resume_request", `参数 ${field} 格式无效或超出长度限制。`);
  }
  return trimmed;
}

/**
 * Handles `POST /api/tickets/:id/resume-override` for P0-3 quota pause recovery
 * and P1-3 stuck-task model escalation.
 */
export async function handleTicketResumeRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, pathname, readJsonObject, sendJson } = ctx;
  const match = /^\/api\/tickets\/([^/]+)\/resume-override$/.exec(pathname);
  if (!match || req.method !== "POST") return false;

  res.setHeader("cache-control", "no-store");
  assertHttpSameOrigin(ctx, {
    code: "ticket_resume_origin_required",
    message: "请在 Kulo 中恢复任务。",
  });

  const ticketId = decodeURIComponent(match[1]!);
  const body = await readJsonObject(req, 32 * 1024);
  const request: TicketResumeOverrideRequest = {
    ...(parseOptionalBoundedString(body.commandId, "commandId", 256)
      ? { commandId: parseOptionalBoundedString(body.commandId, "commandId", 256) }
      : {}),
    ...(parseOptionalBoundedString(body.provider, "provider", 200)
      ? { provider: parseOptionalBoundedString(body.provider, "provider", 200) }
      : {}),
    ...(parseOptionalBoundedString(body.modelId, "modelId", 300)
      ? { modelId: parseOptionalBoundedString(body.modelId, "modelId", 300) }
      : {}),
    ...(parseOptionalBoundedString(body.thinkingLevel, "thinkingLevel", 64)
      ? { thinkingLevel: parseOptionalBoundedString(body.thinkingLevel, "thinkingLevel", 64) as RoleThinkingEffort }
      : {}),
    ...(parseOptionalBoundedString(body.note, "note", 2000, true)
      ? { note: parseOptionalBoundedString(body.note, "note", 2000, true) }
      : {}),
  };

  const result = await hub.resumeTicketWithOverride(
    ticketId,
    request,
    BACKGROUND_CONTEXT,
    ctx.authority.principalId,
  );
  sendJson(res, 200, result);
  return true;
}
